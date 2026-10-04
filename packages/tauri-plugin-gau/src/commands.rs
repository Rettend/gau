use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Condvar, Mutex, MutexGuard, Weak},
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{ipc::Channel, Manager, Resource, Runtime, State, Webview};
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    transport::{FetchEvent, FetchRequest},
    Account, Error, PluginState, Result, SignInOptions, SignOutResult,
};

const MAX_REQUESTS: usize = 128;
const MAX_REQUESTS_PER_WEBVIEW: usize = 32;
const PREPARED_LIFETIME: Duration = Duration::from_secs(60);
const WEBVIEW_LIFETIME_RESOURCE: &str = "gau:webview-lifetime";

#[derive(Default)]
struct CriticalWorkState {
    pending: usize,
    closing: bool,
}

#[derive(Default)]
pub(crate) struct CriticalWorkTracker {
    state: Mutex<CriticalWorkState>,
    drained: Notify,
    drained_sync: Condvar,
    shutdown: CancellationToken,
}

impl CriticalWorkTracker {
    fn begin(self: &Arc<Self>) -> Result<CriticalWork> {
        let mut state = lock(&self.state);
        if state.closing {
            return Err(Error::new("unavailable", "Gau is shutting down."));
        }
        if state.pending >= MAX_REQUESTS {
            return Err(Error::new(
                "tooManyRequests",
                "Too many Gau operations are pending.",
            ));
        }
        state.pending += 1;
        Ok(CriticalWork(self.clone()))
    }

    pub(crate) fn spawn<F, T>(
        self: &Arc<Self>,
        future: F,
    ) -> Result<tauri::async_runtime::JoinHandle<T>>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let work = self.begin()?;
        Ok(tauri::async_runtime::spawn(async move {
            // The task, not its awaiting caller, owns the drain guard. Dropping
            // a join handle never aborts refresh rotation or a sign-out commit.
            let _work = work;
            future.await
        }))
    }

    pub(crate) fn stop(&self) {
        let mut state = lock(&self.state);
        state.closing = true;
        drop(state);
        self.shutdown.cancel();
    }

    pub(crate) fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    #[cfg(test)]
    pub(crate) async fn drain(&self) {
        loop {
            let notified = self.drained.notified();
            if lock(&self.state).pending == 0 {
                return;
            }
            // notify_one stores a permit if the final worker finishes before
            // this future is polled, so the drain cannot lose its wakeup.
            notified.await;
        }
    }

    pub(crate) fn drain_blocking(&self) {
        let mut state = lock(&self.state);
        while state.pending != 0 {
            // The workers run on Tauri's independent async runtime. A plain
            // condition-variable wait never enters or blocks on a Tokio runtime,
            // even when the host's event callback already runs inside one.
            state = self
                .drained_sync
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

struct CriticalWork(Arc<CriticalWorkTracker>);

impl Drop for CriticalWork {
    fn drop(&mut self) {
        let mut state = lock(&self.0.state);
        state.pending -= 1;
        if state.pending == 0 {
            self.0.drained.notify_one();
            self.0.drained_sync.notify_all();
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RequestKind {
    SignIn,
    Fetch,
}

#[derive(Clone, PartialEq, Eq)]
struct Owner {
    label: String,
    window: String,
    instance: Uuid,
}

impl Owner {
    fn same_webview(&self, other: &Self) -> bool {
        // Instances distinguish request ownership, not quota. A navigation or
        // same-label replacement cannot reset a still-running page's allowance.
        self.label == other.label && self.window == other.window
    }
}

type IsAlive = Arc<dyn Fn() -> bool + Send + Sync>;

struct Slot {
    owner: Owner,
    kind: RequestKind,
    prepared_at: Instant,
    started: bool,
    operation: Arc<Operation>,
    is_alive: IsAlive,
}

struct PendingAck {
    sequence: u64,
    sender: oneshot::Sender<()>,
}

pub(crate) struct Operation {
    pub(crate) cancel: CancellationToken,
    ack: Mutex<Option<PendingAck>>,
}

impl Default for Operation {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            ack: Mutex::new(None),
        }
    }
}

impl Operation {
    pub(crate) fn arm_ack(&self, sequence: u64) -> Result<oneshot::Receiver<()>> {
        let mut pending = lock(&self.ack);
        if self.cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        if pending.is_some() {
            return Err(invalid_ack());
        }
        let (sender, receiver) = oneshot::channel();
        *pending = Some(PendingAck { sequence, sender });
        Ok(receiver)
    }

    pub(crate) fn acknowledge(&self, sequence: u64) -> Result<()> {
        let mut pending = lock(&self.ack);
        if pending.as_ref().is_none_or(|ack| ack.sequence != sequence) {
            return Err(invalid_ack());
        }
        pending
            .take()
            .ok_or_else(invalid_ack)?
            .sender
            .send(())
            .map_err(|_| invalid_ack())
    }

    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
        lock(&self.ack).take();
    }
}

#[derive(Default)]
struct RegistryState {
    slots: HashMap<String, Slot>,
    closed: bool,
}

#[derive(Default)]
pub(crate) struct RequestRegistry {
    state: Mutex<RegistryState>,
    shutdown: CancellationToken,
}

impl RequestRegistry {
    fn prepare(&self, owner: Owner, kind: RequestKind, is_alive: IsAlive) -> Result<String> {
        self.expire_prepared();
        if !is_alive() {
            return Err(Error::cancelled());
        }
        let mut state = lock(&self.state);
        if state.closed {
            return Err(Error::new("unavailable", "Gau is shutting down."));
        }
        if state.slots.len() >= MAX_REQUESTS
            || state
                .slots
                .values()
                .filter(|slot| slot.owner.same_webview(&owner))
                .count()
                >= MAX_REQUESTS_PER_WEBVIEW
        {
            return Err(Error::new(
                "tooManyRequests",
                "Too many Gau operations are pending.",
            ));
        }
        let request_id = loop {
            let candidate = Uuid::new_v4().to_string();
            if !state.slots.contains_key(&candidate) {
                break candidate;
            }
        };
        state.slots.insert(
            request_id.clone(),
            Slot {
                owner,
                kind,
                prepared_at: Instant::now(),
                started: false,
                operation: Arc::new(Operation::default()),
                is_alive,
            },
        );
        Ok(request_id)
    }

    fn begin(
        self: &Arc<Self>,
        owner: &Owner,
        request_id: &str,
        kind: RequestKind,
    ) -> Result<RequestLease> {
        self.expire_prepared();
        let mut state = lock(&self.state);
        if state.closed {
            return Err(Error::new("unavailable", "Gau is shutting down."));
        }
        let slot = state
            .slots
            .get_mut(request_id)
            .ok_or_else(invalid_request)?;
        if &slot.owner != owner || slot.kind != kind || slot.started {
            return Err(invalid_request());
        }
        slot.started = true;
        let is_alive = slot.is_alive.clone();
        let lease = RequestLease {
            registry: self.clone(),
            request_id: request_id.into(),
            operation: slot.operation.clone(),
        };
        drop(state);
        if lease.operation.cancel.is_cancelled() || !is_alive() {
            return Err(Error::cancelled());
        }
        Ok(lease)
    }

    fn cancel_request(&self, owner: &Owner, request_id: &str) -> Result<()> {
        let mut state = lock(&self.state);
        let Some(slot) = state.slots.get(request_id) else {
            return Ok(());
        };
        if &slot.owner != owner {
            return Err(invalid_request());
        }
        slot.operation.cancel();
        let removed = if slot.started {
            None
        } else {
            state.slots.remove(request_id)
        };
        drop(state);
        drop(removed);
        // Prepared slots have no work to drain. Removing them rejects a later
        // start. Started slots still count until their lease finishes: cancel
        // cannot interrupt a critical refresh or release its quota early.
        Ok(())
    }

    fn acknowledge(&self, owner: &Owner, request_id: &str, sequence: u64) -> Result<()> {
        let state = lock(&self.state);
        let slot = state.slots.get(request_id).ok_or_else(invalid_request)?;
        if &slot.owner != owner || slot.kind != RequestKind::Fetch || !slot.started {
            return Err(invalid_request());
        }
        slot.operation.acknowledge(sequence)
    }

    fn cancel_if_current(&self, request_id: &str, operation: &Arc<Operation>) {
        let mut state = lock(&self.state);
        let removed = if let Some(slot) = state
            .slots
            .get(request_id)
            .filter(|slot| Arc::ptr_eq(&slot.operation, operation))
        {
            slot.operation.cancel();
            if slot.started {
                None
            } else {
                state.slots.remove(request_id)
            }
        } else {
            None
        };
        drop(state);
        drop(removed);
    }

    fn remove(&self, request_id: &str, operation: &Arc<Operation>) {
        let mut state = lock(&self.state);
        let removed = if state
            .slots
            .get(request_id)
            .is_some_and(|slot| Arc::ptr_eq(&slot.operation, operation))
        {
            state.slots.remove(request_id)
        } else {
            None
        };
        drop(state);
        operation.cancel();
        drop(removed);
    }

    fn expire_prepared(&self) {
        let expired = {
            let mut state = lock(&self.state);
            let ids = state
                .slots
                .iter()
                .filter(|(_, slot)| {
                    !slot.started && slot.prepared_at.elapsed() >= PREPARED_LIFETIME
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| state.slots.remove(&id))
                .collect::<Vec<_>>()
        };
        for slot in expired {
            slot.operation.cancel();
        }
    }

    fn maintain(&self) {
        // Do not call Tauri while holding the registry lock. Closing a webview
        // may itself drop resources that cancel this webview's operations.
        self.expire_prepared();
        let candidates = {
            let state = lock(&self.state);
            state
                .slots
                .iter()
                .map(|(id, slot)| (id.clone(), slot.operation.clone(), slot.is_alive.clone()))
                .collect::<Vec<_>>()
        };
        for (id, operation, is_alive) in candidates {
            if !is_alive() {
                self.cancel_if_current(&id, &operation);
            }
        }
    }

    pub(crate) fn start_maintenance(registry: &Arc<Self>) {
        let weak = Arc::downgrade(registry);
        let shutdown = registry.shutdown.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
                let Some(registry) = weak.upgrade() else {
                    break;
                };
                registry.maintain();
            }
        });
    }

    fn cancel_matching(&self, predicate: impl Fn(&Owner) -> bool) {
        let removed = {
            let mut state = lock(&self.state);
            let ids = state
                .slots
                .iter()
                .filter(|(_, slot)| predicate(&slot.owner))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let mut removed = Vec::new();
            for id in ids {
                let slot = &state.slots[&id];
                slot.operation.cancel();
                if !slot.started {
                    if let Some(slot) = state.slots.remove(&id) {
                        removed.push(slot);
                    }
                }
            }
            removed
        };
        for slot in removed {
            slot.operation.cancel();
        }
    }

    pub(crate) fn cancel_label(&self, label: &str) {
        self.cancel_matching(|owner| owner.label == label);
    }

    pub(crate) fn cancel_window(&self, window: &str) {
        self.cancel_matching(|owner| owner.window == window);
    }

    pub(crate) fn shutdown(&self) {
        self.shutdown.cancel();
        let mut state = lock(&self.state);
        state.closed = true;
        drop(state);
        self.cancel_matching(|_| true);
    }
}

struct RequestLease {
    registry: Arc<RequestRegistry>,
    request_id: String,
    operation: Arc<Operation>,
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        self.registry.remove(&self.request_id, &self.operation);
    }
}

struct WebviewLifetime {
    owner: Owner,
    registry: Weak<RequestRegistry>,
}

impl Resource for WebviewLifetime {
    fn name(&self) -> std::borrow::Cow<'_, str> {
        WEBVIEW_LIFETIME_RESOURCE.into()
    }
}

impl Drop for WebviewLifetime {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            registry.cancel_matching(|owner| owner == &self.owner);
        }
    }
}

fn webview_owner<R: Runtime>(
    webview: &Webview<R>,
    registry: &Arc<RequestRegistry>,
) -> (Owner, IsAlive) {
    let mut resources = webview.resources_table();
    let existing = resources
        .names()
        .find_map(|(id, name)| (name == WEBVIEW_LIFETIME_RESOURCE).then_some(id));
    let (resource_id, owner) = if let Some((id, lifetime)) = existing.and_then(|id| {
        resources
            .get::<WebviewLifetime>(id)
            .ok()
            .map(|lifetime| (id, lifetime))
    }) {
        (id, lifetime.owner.clone())
    } else {
        let owner = Owner {
            label: webview.label().into(),
            window: webview.window().label().into(),
            instance: Uuid::new_v4(),
        };
        let id = resources.add(WebviewLifetime {
            owner: owner.clone(),
            registry: Arc::downgrade(registry),
        });
        (id, owner)
    };
    drop(resources);
    let window = webview.window();
    let label = owner.label.clone();
    let instance = owner.instance;
    let is_alive: IsAlive = Arc::new(move || {
        window.webviews().iter().any(|candidate| {
            candidate.label() == label
                && candidate
                    .resources_table()
                    .get::<WebviewLifetime>(resource_id)
                    .is_ok_and(|lifetime| lifetime.owner.instance == instance)
        })
    });
    (owner, is_alive)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn invalid_request() -> Error {
    Error::new(
        "invalidRequestId",
        "The Gau request is unknown, expired, or already used.",
    )
}

fn invalid_ack() -> Error {
    Error::new(
        "invalidAcknowledgement",
        "The stream acknowledgement does not match the pending chunk.",
    )
}

#[tauri::command]
pub(crate) fn chatgpt_prepare<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, PluginState>,
    kind: RequestKind,
) -> Result<String> {
    let (owner, is_alive) = webview_owner(&webview, &state.requests);
    state.requests.prepare(owner, kind, is_alive)
}

#[tauri::command]
pub(crate) async fn chatgpt_sign_in<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, PluginState>,
    request_id: String,
    options: SignInOptions,
) -> Result<Account> {
    let (owner, _) = webview_owner(&webview, &state.requests);
    let lease = state
        .requests
        .begin(&owner, &request_id, RequestKind::SignIn)?;
    let open = Arc::new(|url: &str| {
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|_| Error::new("browserOpenFailed", "Could not open the system browser."))
    });
    state
        .connection
        .sign_in(options, lease.operation.cancel.clone(), open)
        .await
}

#[tauri::command]
pub(crate) async fn chatgpt_list_accounts(state: State<'_, PluginState>) -> Result<Vec<Account>> {
    state.connection.list_accounts().await
}

#[tauri::command]
pub(crate) async fn chatgpt_sign_out(
    state: State<'_, PluginState>,
    account_id: String,
) -> Result<SignOutResult> {
    state.connection.sign_out(&account_id).await
}

#[tauri::command]
pub(crate) fn chatgpt_cancel<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, PluginState>,
    request_id: String,
) -> Result<()> {
    let (owner, _) = webview_owner(&webview, &state.requests);
    state.requests.cancel_request(&owner, &request_id)
}

#[tauri::command]
pub(crate) async fn chatgpt_fetch<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, PluginState>,
    request_id: String,
    account_id: String,
    request: FetchRequest,
    on_event: Channel<FetchEvent>,
) -> Result<()> {
    let (owner, _) = webview_owner(&webview, &state.requests);
    let lease = state
        .requests
        .begin(&owner, &request_id, RequestKind::Fetch)?;
    state
        .transport
        .fetch(
            request,
            &lease.operation,
            || state.connection.get_access_token(&account_id),
            |event| {
                on_event
                    .send(event)
                    .map_err(|_| Error::new("channelClosed", "The response stream was closed."))
            },
        )
        .await
}

#[tauri::command]
pub(crate) fn chatgpt_ack<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, PluginState>,
    request_id: String,
    sequence: u64,
) -> Result<()> {
    let (owner, _) = webview_owner(&webview, &state.requests);
    state.requests.acknowledge(&owner, &request_id, sequence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{handle_plugin_event, PluginEvent};
    use std::sync::atomic::{AtomicBool, Ordering};

    fn owner(label: &str) -> Owner {
        Owner {
            label: label.into(),
            window: format!("window-{label}"),
            instance: Uuid::new_v4(),
        }
    }

    fn prepare(registry: &RequestRegistry, owner: &Owner, kind: RequestKind) -> String {
        registry
            .prepare(owner.clone(), kind, Arc::new(|| true))
            .unwrap()
    }

    #[test]
    fn prepared_ids_are_random_owned_typed_and_single_use() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let second = owner("second");
        let id = prepare(&registry, &first, RequestKind::Fetch);
        let other = prepare(&registry, &first, RequestKind::Fetch);
        assert_ne!(id, other);
        assert_eq!(Uuid::parse_str(&id).unwrap().get_version_num(), 4);
        assert!(registry.begin(&second, &id, RequestKind::Fetch).is_err());
        assert!(registry.begin(&first, &id, RequestKind::SignIn).is_err());
        assert!(registry
            .begin(&first, "unknown", RequestKind::Fetch)
            .is_err());
        let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
        assert!(registry.begin(&first, &id, RequestKind::Fetch).is_err());
        drop(lease);
        assert!(registry.begin(&first, &id, RequestKind::Fetch).is_err());
    }

    #[test]
    fn cancel_before_start_cannot_start_work() {
        let registry = Arc::new(RequestRegistry::default());
        let owner = owner("first");
        let id = prepare(&registry, &owner, RequestKind::SignIn);
        registry.cancel_request(&owner, &id).unwrap();
        registry.cancel_request(&owner, &id).unwrap();
        let result = registry.begin(&owner, &id, RequestKind::SignIn);
        assert!(matches!(result, Err(error) if error.code == "invalidRequestId"));
        assert!(lock(&registry.state).slots.is_empty());
        registry.cancel_request(&owner, &id).unwrap();
    }

    #[test]
    fn cancel_and_ack_cannot_target_another_webview_or_replacement() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let second = owner("second");
        let replacement = owner("first");
        let id = prepare(&registry, &first, RequestKind::Fetch);
        let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
        let mut ack = lease.operation.arm_ack(1).unwrap();
        for other in [&second, &replacement] {
            assert!(registry.cancel_request(other, &id).is_err());
            assert!(registry.acknowledge(other, &id, 1).is_err());
        }
        assert!(!lease.operation.cancel.is_cancelled());
        assert!(registry.acknowledge(&first, &id, 2).is_err());
        assert!(matches!(
            ack.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        registry.acknowledge(&first, &id, 1).unwrap();
        ack.try_recv().unwrap();
        assert!(registry.acknowledge(&first, &id, 1).is_err());
        registry.cancel_request(&first, &id).unwrap();
        assert!(lease.operation.cancel.is_cancelled());
        assert_eq!(lock(&registry.state).slots.len(), 1);
        registry.cancel_request(&first, &id).unwrap();
        drop(lease);
        assert!(lock(&registry.state).slots.is_empty());
    }

    #[test]
    fn prepared_slots_expire_but_active_requests_do_not() {
        let registry = Arc::new(RequestRegistry::default());
        let owner = owner("first");
        let unused = prepare(&registry, &owner, RequestKind::Fetch);
        let running = prepare(&registry, &owner, RequestKind::Fetch);
        let lease = registry
            .begin(&owner, &running, RequestKind::Fetch)
            .unwrap();
        let old = Instant::now() - PREPARED_LIFETIME - Duration::from_secs(1);
        for slot in lock(&registry.state).slots.values_mut() {
            slot.prepared_at = old;
        }
        registry.maintain();
        assert!(registry.begin(&owner, &unused, RequestKind::Fetch).is_err());
        assert!(!lease.operation.cancel.is_cancelled());
        assert_eq!(lock(&registry.state).slots.len(), 1);
    }

    #[test]
    fn prepared_and_active_slots_are_bounded() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        for _ in 0..MAX_REQUESTS_PER_WEBVIEW {
            prepare(&registry, &first, RequestKind::Fetch);
        }
        assert!(registry
            .prepare(first, RequestKind::Fetch, Arc::new(|| true))
            .is_err());
        for index in 1..MAX_REQUESTS / MAX_REQUESTS_PER_WEBVIEW {
            let other = owner(&index.to_string());
            for _ in 0..MAX_REQUESTS_PER_WEBVIEW {
                prepare(&registry, &other, RequestKind::Fetch);
            }
        }
        assert!(registry
            .prepare(owner("overflow"), RequestKind::Fetch, Arc::new(|| true))
            .is_err());
    }

    #[test]
    fn closed_webviews_and_shutdown_cancel_requests_until_their_leases_finish() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let alive = Arc::new(AtomicBool::new(true));
        let probe = alive.clone();
        let id = registry
            .prepare(
                first.clone(),
                RequestKind::Fetch,
                Arc::new(move || probe.load(Ordering::SeqCst)),
            )
            .unwrap();
        let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
        alive.store(false, Ordering::SeqCst);
        registry.maintain();
        assert!(lease.operation.cancel.is_cancelled());
        assert_eq!(lock(&registry.state).slots.len(), 1);
        drop(lease);
        assert!(lock(&registry.state).slots.is_empty());
        let id = prepare(&registry, &first, RequestKind::Fetch);
        let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
        registry.shutdown();
        assert!(lease.operation.cancel.is_cancelled());
        assert!(registry
            .prepare(first, RequestKind::Fetch, Arc::new(|| true))
            .is_err());
        assert_eq!(lock(&registry.state).slots.len(), 1);
        drop(lease);
        assert!(lock(&registry.state).slots.is_empty());
    }

    #[test]
    fn window_cleanup_only_cancels_its_own_requests() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let second = owner("second");
        let first_id = prepare(&registry, &first, RequestKind::Fetch);
        let second_id = prepare(&registry, &second, RequestKind::Fetch);
        let first_lease = registry
            .begin(&first, &first_id, RequestKind::Fetch)
            .unwrap();
        let second_lease = registry
            .begin(&second, &second_id, RequestKind::Fetch)
            .unwrap();
        registry.cancel_window(&first.window);
        assert!(first_lease.operation.cancel.is_cancelled());
        assert!(!second_lease.operation.cancel.is_cancelled());
        registry.cancel_label(&second.label);
        assert!(second_lease.operation.cancel.is_cancelled());
    }

    #[tokio::test]
    async fn shutdown_drains_critical_work_and_rejects_new_work() {
        let work = Arc::new(CriticalWorkTracker::default());
        let first = work.begin().unwrap();
        let second = work.begin().unwrap();
        work.stop();
        work.stop();
        assert!(work.shutdown_token().is_cancelled());
        assert!(work.begin().is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), work.drain())
                .await
                .is_err()
        );
        drop(first);
        assert_eq!(lock(&work.state).pending, 1);
        drop(second);
        tokio::time::timeout(Duration::from_secs(1), work.drain())
            .await
            .unwrap();
        work.stop();
        assert_eq!(lock(&work.state).pending, 0);
    }

    #[tokio::test]
    async fn abandoning_a_native_caller_does_not_release_the_critical_job_guard() {
        let work = Arc::new(CriticalWorkTracker::default());
        let persisted = Arc::new(AtomicBool::new(false));
        let worker_persisted = persisted.clone();
        let (started, started_receiver) = oneshot::channel();
        let (finish, finish_receiver) = oneshot::channel();
        let task = work
            .spawn(async move {
                started.send(()).unwrap();
                finish_receiver.await.unwrap();
                // Stand in for the durable rotated-token/sign-out commit.
                worker_persisted.store(true, Ordering::SeqCst);
            })
            .unwrap();
        let caller = Box::pin(task);
        started_receiver.await.unwrap();
        drop(caller);
        work.stop();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), work.drain())
                .await
                .is_err()
        );
        assert!(!persisted.load(Ordering::SeqCst));
        finish.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), work.drain())
            .await
            .unwrap();
        assert!(persisted.load(Ordering::SeqCst));
        assert_eq!(lock(&work.state).pending, 0);
    }

    #[tokio::test]
    async fn vetoed_exit_requests_leave_prepare_and_native_list_work_usable() {
        let registry = Arc::new(RequestRegistry::default());
        let work = Arc::new(CriticalWorkTracker::default());
        let directory = crate::store::test_keys::directory();
        let native = crate::ChatGPT {
            engine: Arc::new(
                crate::ChatGPTConnection::new(
                    directory.path().to_path_buf(),
                    "gau.lifecycle.test".into(),
                    "Gau lifecycle test".into(),
                )
                .unwrap(),
            ),
            work: work.clone(),
        };
        let owner = owner("first");
        let id = prepare(&registry, &owner, RequestKind::Fetch);
        let lease = registry.begin(&owner, &id, RequestKind::Fetch).unwrap();
        let (finish, finish_receiver) = oneshot::channel();
        let pending = work
            .spawn(async move { finish_receiver.await.unwrap() })
            .unwrap();

        // Plugins see the request first; the host's event callback can veto it
        // afterward. Without a committed Exit, no stop/drain/forced-exit action
        // is allowed, even with a critical job already in flight.
        let mut committed_exits = 0;
        for _ in 0..2 {
            handle_plugin_event(&registry, &work, PluginEvent::ExitRequested);
            let host_prevents_exit = true;
            if !host_prevents_exit {
                handle_plugin_event(&registry, &work, PluginEvent::Exit);
                committed_exits += 1;
            }
            let next = prepare(&registry, &owner, RequestKind::Fetch);
            registry.cancel_request(&owner, &next).unwrap();
            // An empty temporary store needs no keyring access or live account.
            let accounts = native.list_accounts().await.unwrap();
            assert!(accounts.is_empty());
            assert!(!work.shutdown_token().is_cancelled());
            assert!(!lease.operation.cancel.is_cancelled());
            assert!(!lock(&registry.state).closed);
        }
        assert_eq!(committed_exits, 0);
        finish.send(()).unwrap();
        pending.await.unwrap();
        assert!(!lock(&work.state).closing);
    }

    #[tokio::test]
    async fn committed_exit_blocks_until_an_abandoned_critical_write_finishes() {
        let registry = Arc::new(RequestRegistry::default());
        let work = Arc::new(CriticalWorkTracker::default());
        let owner = owner("first");
        let prepared = prepare(&registry, &owner, RequestKind::Fetch);
        let active = prepare(&registry, &owner, RequestKind::Fetch);
        let lease = registry.begin(&owner, &active, RequestKind::Fetch).unwrap();
        let persisted = Arc::new(AtomicBool::new(false));
        let worker_persisted = persisted.clone();
        let (started, started_receiver) = oneshot::channel();
        let (finish, finish_receiver) = oneshot::channel();
        let caller = work
            .spawn(async move {
                started.send(()).unwrap();
                finish_receiver.await.unwrap();
                worker_persisted.store(true, Ordering::SeqCst);
            })
            .unwrap();
        started_receiver.await.unwrap();
        drop(caller);

        let exit_registry = registry.clone();
        let exit_work = work.clone();
        let (exited, mut exited_receiver) = oneshot::channel();
        let exit_thread = std::thread::spawn(move || {
            // Simulate an event callback inside a host Tokio runtime as well as
            // a GUI thread. The synchronous wait must not nest block_on or
            // require this event thread to drive the critical job's executor.
            let host_runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            host_runtime.block_on(async {
                handle_plugin_event(&exit_registry, &exit_work, PluginEvent::Exit);
                // A repeated committed event is idempotent, not a quit retry.
                handle_plugin_event(&exit_registry, &exit_work, PluginEvent::Exit);
                exited.send(()).unwrap();
            });
        });
        work.shutdown_token().cancelled().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut exited_receiver)
                .await
                .is_err()
        );
        assert!(!persisted.load(Ordering::SeqCst));
        assert!(lease.operation.cancel.is_cancelled());
        assert!(!lock(&registry.state).slots.contains_key(&prepared));
        assert!(registry
            .prepare(owner, RequestKind::Fetch, Arc::new(|| true))
            .is_err());
        assert!(work.spawn(async {}).is_err());

        finish.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), exited_receiver)
            .await
            .unwrap()
            .unwrap();
        exit_thread.join().unwrap();
        assert!(persisted.load(Ordering::SeqCst));
        assert_eq!(lock(&work.state).pending, 0);
        drop(lease);
        assert!(lock(&registry.state).slots.is_empty());
    }

    #[test]
    fn cancelled_started_work_keeps_the_stable_webview_quota_until_lease_drop() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let replacement = owner("first");
        let mut leases = Vec::new();
        for _ in 0..MAX_REQUESTS_PER_WEBVIEW {
            let id = prepare(&registry, &first, RequestKind::Fetch);
            let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
            registry.cancel_request(&first, &id).unwrap();
            registry.cancel_request(&first, &id).unwrap();
            assert!(lease.operation.cancel.is_cancelled());
            assert!(registry.begin(&first, &id, RequestKind::Fetch).is_err());
            assert!(registry.cancel_request(&replacement, &id).is_err());
            leases.push(lease);
        }
        assert_eq!(lock(&registry.state).slots.len(), MAX_REQUESTS_PER_WEBVIEW);
        for caller in [&first, &replacement] {
            assert!(registry
                .prepare(caller.clone(), RequestKind::Fetch, Arc::new(|| true))
                .is_err());
        }
        let other_window = Owner {
            window: "different-window".into(),
            ..replacement.clone()
        };
        let other_id = prepare(&registry, &other_window, RequestKind::Fetch);
        registry.cancel_request(&other_window, &other_id).unwrap();
        drop(leases.pop().unwrap());
        assert_eq!(
            lock(&registry.state).slots.len(),
            MAX_REQUESTS_PER_WEBVIEW - 1
        );
        let new_id = prepare(&registry, &replacement, RequestKind::Fetch);
        registry.cancel_request(&replacement, &new_id).unwrap();
        drop(leases);
        assert!(lock(&registry.state).slots.is_empty());
    }

    #[test]
    fn prepared_cancel_frees_capacity_immediately_without_allowing_a_late_start() {
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let ids = (0..MAX_REQUESTS_PER_WEBVIEW)
            .map(|_| prepare(&registry, &first, RequestKind::Fetch))
            .collect::<Vec<_>>();
        registry.cancel_request(&first, &ids[0]).unwrap();
        registry.cancel_request(&first, &ids[0]).unwrap();
        assert!(registry.begin(&first, &ids[0], RequestKind::Fetch).is_err());
        assert_eq!(
            lock(&registry.state).slots.len(),
            MAX_REQUESTS_PER_WEBVIEW - 1
        );
        prepare(&registry, &first, RequestKind::Fetch);
        assert_eq!(lock(&registry.state).slots.len(), MAX_REQUESTS_PER_WEBVIEW);
    }

    #[test]
    fn navigation_destruction_and_maintenance_retain_started_but_not_prepared_slots() {
        for cleanup in ["navigation", "destruction", "maintenance"] {
            let registry = Arc::new(RequestRegistry::default());
            let first = owner("first");
            let replacement = owner("first");
            let alive = Arc::new(AtomicBool::new(true));
            let probe = alive.clone();
            let mut leases = Vec::new();
            for _ in 0..MAX_REQUESTS_PER_WEBVIEW - 1 {
                let probe = probe.clone();
                let id = registry
                    .prepare(
                        first.clone(),
                        RequestKind::Fetch,
                        Arc::new(move || probe.load(Ordering::SeqCst)),
                    )
                    .unwrap();
                leases.push(registry.begin(&first, &id, RequestKind::Fetch).unwrap());
            }
            let probe = probe.clone();
            let prepared = registry
                .prepare(
                    first.clone(),
                    RequestKind::Fetch,
                    Arc::new(move || probe.load(Ordering::SeqCst)),
                )
                .unwrap();
            match cleanup {
                "navigation" => registry.cancel_label(&first.label),
                "destruction" => registry.cancel_window(&first.window),
                "maintenance" => {
                    alive.store(false, Ordering::SeqCst);
                    registry.maintain();
                }
                _ => unreachable!(),
            }
            assert!(leases
                .iter()
                .all(|lease| lease.operation.cancel.is_cancelled()));
            assert!(!lock(&registry.state).slots.contains_key(&prepared));
            assert_eq!(
                lock(&registry.state).slots.len(),
                MAX_REQUESTS_PER_WEBVIEW - 1
            );
            // Expiry and repeated maintenance cannot release active quota.
            for slot in lock(&registry.state).slots.values_mut() {
                slot.prepared_at = Instant::now() - PREPARED_LIFETIME - Duration::from_secs(1);
            }
            registry.maintain();
            assert_eq!(
                lock(&registry.state).slots.len(),
                MAX_REQUESTS_PER_WEBVIEW - 1
            );
            let id = prepare(&registry, &replacement, RequestKind::Fetch);
            assert!(registry
                .prepare(replacement.clone(), RequestKind::Fetch, Arc::new(|| true))
                .is_err());
            registry.cancel_request(&replacement, &id).unwrap();
            drop(leases.pop().unwrap());
            let next = prepare(&registry, &replacement, RequestKind::Fetch);
            registry.cancel_request(&replacement, &next).unwrap();
            drop(leases);
            assert!(lock(&registry.state).slots.is_empty());
        }
    }

    #[test]
    fn cancelled_active_work_only_blocks_other_windows_at_the_global_limit() {
        let registry = Arc::new(RequestRegistry::default());
        let mut leases = Vec::new();
        for window in 0..MAX_REQUESTS / MAX_REQUESTS_PER_WEBVIEW {
            let first = Owner {
                label: "same-label".into(),
                window: format!("window-{window}"),
                instance: Uuid::new_v4(),
            };
            for _ in 0..MAX_REQUESTS_PER_WEBVIEW {
                let id = prepare(&registry, &first, RequestKind::Fetch);
                leases.push(registry.begin(&first, &id, RequestKind::Fetch).unwrap());
                registry.cancel_request(&first, &id).unwrap();
            }
        }
        assert_eq!(lock(&registry.state).slots.len(), MAX_REQUESTS);
        let next_window = owner("another-window");
        assert!(registry
            .prepare(next_window.clone(), RequestKind::Fetch, Arc::new(|| true))
            .is_err());
        drop(leases.pop().unwrap());
        prepare(&registry, &next_window, RequestKind::Fetch);
    }

    #[tokio::test]
    async fn cancelling_a_fetch_during_critical_refresh_keeps_quota_until_persistence() {
        let registry = Arc::new(RequestRegistry::default());
        let work = Arc::new(CriticalWorkTracker::default());
        let first = owner("first");
        let mut leases = Vec::new();
        for _ in 0..MAX_REQUESTS_PER_WEBVIEW - 1 {
            let id = prepare(&registry, &first, RequestKind::Fetch);
            leases.push(registry.begin(&first, &id, RequestKind::Fetch).unwrap());
        }
        let id = prepare(&registry, &first, RequestKind::Fetch);
        let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
        let (started, started_receiver) = oneshot::channel();
        let (finish, finish_receiver) = oneshot::channel();
        let persisted = Arc::new(AtomicBool::new(false));
        let worker_persisted = persisted.clone();
        let refresh = work
            .spawn(async move {
                started.send(()).unwrap();
                finish_receiver.await.unwrap();
                worker_persisted.store(true, Ordering::SeqCst);
                Ok("rotated-native-secret".to_string())
            })
            .unwrap();
        let transport = crate::transport::Transport::new().unwrap();
        let worker = tokio::spawn(async move {
            transport
                .fetch(
                    FetchRequest {
                        url: "https://api.openai.com/v1/responses".into(),
                        method: "POST".into(),
                        headers: Vec::new(),
                        body: None,
                    },
                    &lease.operation,
                    || async { refresh.await.unwrap() },
                    |_| panic!("a cancelled refresh must never contact the API or emit events"),
                )
                .await
        });
        started_receiver.await.unwrap();
        registry.cancel_label(&first.label);
        assert_eq!(lock(&registry.state).slots.len(), MAX_REQUESTS_PER_WEBVIEW);
        assert!(registry
            .prepare(first.clone(), RequestKind::Fetch, Arc::new(|| true))
            .is_err());
        assert!(!persisted.load(Ordering::SeqCst));
        finish.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        assert!(persisted.load(Ordering::SeqCst));
        assert_eq!(
            lock(&registry.state).slots.len(),
            MAX_REQUESTS_PER_WEBVIEW - 1
        );
        prepare(&registry, &first, RequestKind::Fetch);
    }

    #[tokio::test]
    async fn cancelling_a_fetch_waiting_for_ack_finishes_and_releases_its_slot() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
            sync::mpsc,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = url::Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            let mut buffer = [0; 4096];
            while !headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).await.unwrap();
                assert_ne!(read, 0);
                headers.extend_from_slice(&buffer[..read]);
            }
            let mut response = b"HTTP/1.1 200 OK\r\nContent-Length: 131072\r\nContent-Type: text/event-stream\r\n\r\n".to_vec();
            response.resize(response.len() + 131072, b'x');
            let _ = stream.write_all(&response).await;
        });
        let registry = Arc::new(RequestRegistry::default());
        let first = owner("first");
        let id = prepare(&registry, &first, RequestKind::Fetch);
        let lease = registry.begin(&first, &id, RequestKind::Fetch).unwrap();
        let transport = crate::transport::Transport::for_test();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            transport
                .fetch_from_test_endpoint(
                    FetchRequest {
                        url: "https://api.openai.com/v1/responses".into(),
                        method: "POST".into(),
                        headers: Vec::new(),
                        body: None,
                    },
                    endpoint,
                    &lease.operation,
                    || async { Ok("native-test-secret".into()) },
                    |event| {
                        sender.send(event).map_err(|_| {
                            Error::new("channelClosed", "The response stream was closed.")
                        })
                    },
                )
                .await
        });
        assert!(matches!(
            receiver.recv().await,
            Some(FetchEvent::Response { status: 200, .. })
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(FetchEvent::Chunk { sequence: 1, .. })
        ));
        registry.cancel_request(&first, &id).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        assert!(lock(&registry.state).slots.is_empty());
        assert!(receiver.recv().await.is_none());
        prepare(&registry, &first, RequestKind::Fetch);
        server.await.unwrap();
    }
}
