//! Native ChatGPT connections and authenticated streaming for Tauri.
//!
//! Register [`init`] with the Tauri builder and grant `gau:default` to the
//! webviews that use Gau. Browser sign-in uses the system browser directly;
//! registering the opener plugin separately is not necessary.

mod commands;
mod connection;
mod error;
mod loopback;
mod models;
mod protocol;
mod store;
mod transport;

use connection::ChatGPTConnection;
pub use error::{Error, Result};
pub use models::{
    Account, AccountStatus, ConsentPrompt, Identity, Revocation, SignInOptions, SignOutResult,
};

use std::sync::Arc;

use tauri::{plugin::TauriPlugin, Manager, RunEvent, Runtime, WindowEvent};
use tokio_util::sync::CancellationToken;

struct PluginState {
    connection: ChatGPT,
    requests: Arc<commands::RequestRegistry>,
    work: Arc<commands::CriticalWorkTracker>,
    transport: transport::Transport,
}

enum PluginEvent<'a> {
    WindowDestroyed(&'a str),
    ExitRequested,
    Exit,
    Other,
}

fn handle_plugin_event(
    requests: &commands::RequestRegistry,
    work: &commands::CriticalWorkTracker,
    event: PluginEvent<'_>,
) {
    match event {
        PluginEvent::WindowDestroyed(label) => requests.cancel_window(label),
        PluginEvent::Exit => {
            // This is the committed exit, not the host-vetoable exit request.
            // Tauri calls plugin hooks before its app callback, resource cleanup
            // and process exit. Its async workers remain alive during this wait.
            work.stop();
            requests.shutdown();
            work.drain_blocking();
        }
        PluginEvent::ExitRequested | PluginEvent::Other => {}
    }
}

/// App-managed native connection access. In-flight calls are drained before the
/// app exits, including refresh-token rotation and sign-out writes.
pub struct ChatGPT {
    engine: Arc<ChatGPTConnection>,
    work: Arc<commands::CriticalWorkTracker>,
}

/// Native callback for opening the sign-in URL in a browser.
pub type BrowserOpener = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;

impl ChatGPT {
    /// The browser callback must not wait for the app's UI thread: committed
    /// shutdown waits on that thread until native operations finish.
    pub async fn sign_in(
        &self,
        options: SignInOptions,
        cancel: CancellationToken,
        open: BrowserOpener,
    ) -> Result<Account> {
        let engine = self.engine.clone();
        let shutdown = self.work.shutdown_token();
        let cancel = cancel.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        self.work
            .spawn(async move {
                let stop_relay = CancellationToken::new();
                let _stop_on_drop = stop_relay.clone().drop_guard();
                let operation_cancel = cancel.clone();
                let relay_stop = stop_relay.clone();
                let relay = tauri::async_runtime::spawn(async move {
                    tokio::select! {
                        biased;
                        _ = relay_stop.cancelled() => {}
                        _ = shutdown.cancelled() => operation_cancel.cancel(),
                    }
                });
                let result = engine.sign_in(options, cancel, open).await;
                stop_relay.cancel();
                let _ = relay.await;
                result
            })?
            .await
            .map_err(|_| native_task_failed())?
    }

    pub async fn list_accounts(&self) -> Result<Vec<Account>> {
        let engine = self.engine.clone();
        self.work
            .spawn(async move { engine.list_accounts().await })?
            .await
            .map_err(|_| native_task_failed())?
    }

    /// Retrieve a token in Rust only; there is no corresponding IPC command.
    pub async fn get_access_token(&self, account_id: &str) -> Result<String> {
        let engine = self.engine.clone();
        let account_id = account_id.to_owned();
        // Dropping the caller's future must not drop a rotating refresh. The
        // independent task owns the shutdown guard until the durable commit.
        self.work
            .spawn(async move { engine.get_access_token(&account_id).await })?
            .await
            .map_err(|_| native_task_failed())?
    }

    pub async fn sign_out(&self, account_id: &str) -> Result<SignOutResult> {
        let engine = self.engine.clone();
        let account_id = account_id.to_owned();
        self.work
            .spawn(async move { engine.sign_out(&account_id).await })?
            .await
            .map_err(|_| native_task_failed())?
    }
}

fn native_task_failed() -> Error {
    Error::new("nativeTaskFailed", "The native ChatGPT operation failed.")
}

/// Native access to the connection engine. Access tokens are never exposed by IPC.
///
/// The Gau plugin must be registered before calling this method.
pub trait GauExt<R: Runtime> {
    fn chatgpt(&self) -> &ChatGPT;
}

impl<R: Runtime, T: Manager<R>> GauExt<R> for T {
    fn chatgpt(&self) -> &ChatGPT {
        &self.state::<PluginState>().inner().connection
    }
}

/// Initialize the `gau` plugin.
///
/// The app identifier and product name come from Tauri's configuration. Account
/// storage lives under the app's local data directory at `gau/chatgpt`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("gau")
        .invoke_handler(tauri::generate_handler![
            commands::chatgpt_prepare,
            commands::chatgpt_sign_in,
            commands::chatgpt_list_accounts,
            commands::chatgpt_sign_out,
            commands::chatgpt_cancel,
            commands::chatgpt_fetch,
            commands::chatgpt_ack,
        ])
        .setup(|app, _| {
            let data_dir = app.path().app_local_data_dir()?.join("gau").join("chatgpt");
            let app_id = app.config().identifier.clone();
            let app_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| app.package_info().name.clone());
            let requests = Arc::new(commands::RequestRegistry::default());
            let work = Arc::new(commands::CriticalWorkTracker::default());
            let state = PluginState {
                connection: ChatGPT {
                    engine: Arc::new(ChatGPTConnection::new(data_dir, app_id, app_name)?),
                    work: work.clone(),
                },
                requests: requests.clone(),
                work,
                transport: transport::Transport::new()?,
            };
            if !app.manage(state) {
                return Err(
                    Error::new("initializationFailed", "Gau is already initialized.").into(),
                );
            }
            commands::RequestRegistry::start_maintenance(&requests);
            Ok(())
        })
        .on_webview_ready(|webview| {
            if let Some(state) = webview.try_state::<PluginState>() {
                // A replacement webview must never inherit an old request ID.
                state.requests.cancel_label(webview.label());
            }
        })
        .on_navigation(|webview, _| {
            if let Some(state) = webview.try_state::<PluginState>() {
                state.requests.cancel_label(webview.label());
            }
            true
        })
        .on_event(|app, event| {
            if let Some(state) = app.try_state::<PluginState>() {
                let event = match event {
                    RunEvent::WindowEvent {
                        label,
                        event: WindowEvent::Destroyed,
                        ..
                    } => PluginEvent::WindowDestroyed(label),
                    RunEvent::ExitRequested { .. } => PluginEvent::ExitRequested,
                    RunEvent::Exit => PluginEvent::Exit,
                    _ => PluginEvent::Other,
                };
                handle_plugin_event(&state.requests, &state.work, event);
            }
        })
        .on_drop(|app| {
            if let Some(state) = app.try_state::<PluginState>() {
                state.requests.shutdown();
            }
        })
        .build()
}
