use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use tokio::sync::{oneshot, Notify, Semaphore};
use url::Url;

use super::*;
use crate::{
    models::{Credentials, Identity},
    store::test_keys::{directory, read_encrypted, Gate, TestKeys},
};

type BrowserOpener = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;

struct AsyncGate {
    entered: Notify,
    released: Semaphore,
}

impl AsyncGate {
    fn new() -> Self {
        Self {
            entered: Notify::new(),
            released: Semaphore::new(0),
        }
    }
    async fn block(&self) {
        self.entered.notify_one();
        self.released.acquire().await.unwrap().forget();
    }
    fn release(&self) {
        self.released.add_permits(1);
    }
}

struct Snapshot {
    host: String,
    state: String,
    nonce: String,
    verifier: String,
    challenge: String,
    prompt: bool,
    has_hints: bool,
}

#[derive(Default)]
struct FakeProvider {
    attempts: Mutex<Vec<Snapshot>>,
    next_grant: Mutex<Option<Grant>>,
    refresh_error: Mutex<Option<String>>,
    validation_error: Mutex<Option<String>>,
    revoke_error: Mutex<Option<String>>,
    exchange_gate: Mutex<Option<Arc<AsyncGate>>>,
    refresh_gate: Mutex<Option<Arc<AsyncGate>>>,
    validation_gate: Mutex<Option<Arc<AsyncGate>>>,
    exchanges: AtomicUsize,
    refreshes: AtomicUsize,
    validations: AtomicUsize,
    redeemed: Mutex<Vec<String>>,
    revoked: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Provider for FakeProvider {
    fn authorization_url(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        prompt: bool,
    ) -> Result<Url> {
        self.attempts.lock().unwrap().push(Snapshot {
            host: attempt.host_id.clone(),
            state: attempt.state.clone(),
            nonce: attempt.nonce.clone(),
            verifier: attempt.verifier.clone(),
            challenge: attempt.challenge.clone(),
            prompt,
            has_hints: previous.is_some_and(|account| account.credentials.is_some()),
        });
        let mut url = Url::parse("https://auth.example/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("state", &attempt.state)
            .append_pair("redirect_uri", &attempt.redirect_uri);
        Ok(url)
    }

    async fn exchange(&self, _: &Attempt, _: Option<&StoredAccount>, _: &Url) -> Result<Grant> {
        self.exchanges.fetch_add(1, Ordering::SeqCst);
        let gate = self.exchange_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.block().await;
        }
        Ok(self.next_grant.lock().unwrap().take().unwrap_or_else(grant))
    }

    async fn exchange_refresh(&self, account: &StoredAccount) -> Result<RefreshExchange> {
        assert!(account.pending_refresh.is_none());
        self.refreshes.fetch_add(1, Ordering::SeqCst);
        self.redeemed.lock().unwrap().push(
            account
                .credentials
                .as_ref()
                .unwrap()
                .refresh_token
                .clone()
                .unwrap(),
        );
        let gate = self.refresh_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.block().await;
        }
        if let Some(code) = self.refresh_error.lock().unwrap().take() {
            return Err(Error::new(&code, "The request failed."));
        }
        let mut value = self.next_grant.lock().unwrap().take().unwrap_or_else(grant);
        value.credentials.access_token = Some("rotated-access-secret".into());
        value.credentials.refresh_token = Some("rotated-refresh-secret".into());
        value.credentials.id_token = account.credentials.as_ref().unwrap().id_token.clone();
        Ok(RefreshExchange::Candidate(RefreshCandidate {
            client_id: account.account.client_id.clone(),
            credentials: value.credentials,
            received_at: now_ms()?,
            id_token_replaced: false,
        }))
    }

    async fn validate_refresh(
        &self,
        account: &StoredAccount,
        candidate: &RefreshCandidate,
    ) -> Result<Grant> {
        self.validations.fetch_add(1, Ordering::SeqCst);
        let gate = self.validation_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.block().await;
        }
        if let Some(code) = self.validation_error.lock().unwrap().take() {
            return Err(Error::new(&code, "The identity could not be verified."));
        }
        Ok(Grant {
            client_id: candidate.client_id.clone(),
            identity: account.account.identity.clone(),
            credentials: candidate.credentials.clone(),
        })
    }

    async fn revoke(&self, account: &StoredAccount) -> Result<()> {
        self.revoked
            .lock()
            .unwrap()
            .push(account.latest_refresh_token().unwrap().to_owned());
        if let Some(code) = self.revoke_error.lock().unwrap().take() {
            return Err(Error::new(&code, "private remote diagnostic secret"));
        }
        Ok(())
    }
}

fn grant() -> Grant {
    Grant {
        client_id: "registered-client".into(),
        identity: Identity {
            issuer: "https://auth.openai.com".into(),
            subject: "verified-subject".into(),
            email: Some("same@example.com".into()),
            email_verified: Some(true),
            name: Some("Person".into()),
            picture: None,
        },
        credentials: Credentials {
            access_token: Some("access-secret".into()),
            refresh_token: Some("refresh-secret".into()),
            id_token: Some("id-secret".into()),
            expires_at: Some(now_ms().unwrap() + 3_600_000),
            refresh_after: None,
            scopes: vec![
                "openid".into(),
                "resource.invoke".into(),
                "chatgpt.tokens.use.direct".into(),
            ],
        },
    }
}

struct Context {
    directory: tempfile::TempDir,
    connection: Arc<ChatGPTConnection>,
    provider: Arc<FakeProvider>,
    keys: Arc<TestKeys>,
}

fn setup() -> Context {
    let directory = directory();
    let keys = Arc::new(TestKeys::default());
    let provider = Arc::new(FakeProvider::default());
    let store = Store::with_keys(
        directory.path().to_path_buf(),
        "dev.connection.test".into(),
        keys.clone(),
    )
    .unwrap();
    let connection = Arc::new(ChatGPTConnection {
        store,
        provider: provider.clone(),
    });
    Context {
        directory,
        connection,
        provider,
        keys,
    }
}

fn callback(authorization: &str) -> Url {
    let authorization = Url::parse(authorization).unwrap();
    let query: std::collections::HashMap<_, _> = authorization.query_pairs().into_owned().collect();
    let mut callback = Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &query["state"])
        .append_pair("code", "one-use-code")
        .append_pair("client_id", "registered-client");
    callback
}

fn deliver(authorization: &str) -> Result<()> {
    let callback = callback(authorization);
    let mut stream = TcpStream::connect(("127.0.0.1", callback.port().unwrap())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        stream,
        "GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        callback.path(),
        callback.query().unwrap(),
        callback.port().unwrap()
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    Ok(())
}

fn automatic() -> BrowserOpener {
    Arc::new(deliver)
}

fn pause_browser() -> (BrowserOpener, oneshot::Receiver<String>) {
    let (send, receive) = oneshot::channel();
    let send = Mutex::new(Some(send));
    (
        Arc::new(move |url| {
            send.lock()
                .unwrap()
                .take()
                .unwrap()
                .send(url.into())
                .unwrap();
            Ok(())
        }),
        receive,
    )
}

async fn sign_in(context: &Context) -> Account {
    context
        .connection
        .sign_in(
            SignInOptions::default(),
            CancellationToken::new(),
            automatic(),
        )
        .await
        .unwrap()
}

async fn saved(context: &Context) -> ConnectionState {
    context
        .connection
        .store
        .lock(None)
        .await
        .unwrap()
        .read()
        .await
        .unwrap()
        .unwrap()
}

async fn expire(context: &Context, account_id: &str) {
    let locked = context.connection.store.lock(None).await.unwrap();
    let mut state = locked.read().await.unwrap().unwrap();
    let index = account_index(&state, account_id).unwrap();
    state.accounts[index]
        .credentials
        .as_mut()
        .unwrap()
        .expires_at = Some(now_ms().unwrap() - 1);
    locked.write(&state).await.unwrap();
}

#[tokio::test]
async fn host_is_persisted_before_browser_and_accounts_never_expose_credentials() {
    let context = setup();
    let directory = context.directory.path().to_path_buf();
    let open = Arc::new(move |url: &str| {
        assert!(directory.join("chatgpt-connections.json.enc").is_file());
        deliver(url)
    });
    let first = context
        .connection
        .sign_in(SignInOptions::default(), CancellationToken::new(), open)
        .await
        .unwrap();
    assert_eq!(first.status, AccountStatus::Ready);
    let text = serde_json::to_string(&first).unwrap();
    assert!(text.contains("\"subject\":\"verified-subject\""));
    for secret in [
        "access-secret",
        "refresh-secret",
        "id-secret",
        "credentials",
        "accessToken",
        "refreshToken",
        "idToken",
    ] {
        assert!(!text.contains(secret));
    }
    let host = saved(&context).await.host_id;
    context
        .connection
        .sign_in(
            SignInOptions {
                account_id: Some(first.id.clone()),
                prompt: Some(crate::models::ConsentPrompt::Consent),
            },
            CancellationToken::new(),
            automatic(),
        )
        .await
        .unwrap();
    assert_eq!(saved(&context).await.host_id, host);
    assert_eq!(context.connection.list_accounts().await.unwrap().len(), 1);
    let attempts = context.provider.attempts.lock().unwrap();
    assert_eq!(attempts[0].host, host);
    assert_eq!(attempts[1].host, host);
    assert_ne!(attempts[0].state, attempts[1].state);
    assert_ne!(attempts[0].nonce, attempts[1].nonce);
    assert_ne!(attempts[0].verifier, attempts[1].verifier);
    assert_eq!(attempts[0].verifier.len(), 43);
    assert_eq!(
        attempts[0].challenge,
        URL_SAFE_NO_PAD.encode(Sha256::digest(attempts[0].verifier.as_bytes()))
    );
    assert!(!attempts[0].prompt);
    assert!(attempts[1].prompt);
    assert!(attempts[1].has_hints);
}

#[tokio::test]
async fn registration_tuple_is_unique_but_email_is_not_an_account_identifier() {
    let context = setup();
    let first = sign_in(&context).await;
    let mut different = grant();
    different.identity.subject = "different-subject".into();
    *context.provider.next_grant.lock().unwrap() = Some(different);
    let second = sign_in(&context).await;
    assert_ne!(first.id, second.id);
    assert_eq!(first.identity.email, second.identity.email);
    assert_eq!(first.client_id, second.client_id);
    let mut workspace = grant();
    workspace.client_id = "workspace-client".into();
    *context.provider.next_grant.lock().unwrap() = Some(workspace);
    let third = sign_in(&context).await;
    assert_ne!(first.id, third.id);
    assert_eq!(first.identity.subject, third.identity.subject);
    assert_eq!(first.identity.email, third.identity.email);
    assert_eq!(context.connection.list_accounts().await.unwrap().len(), 3);
    let before = serde_json::to_value(saved(&context).await).unwrap();
    assert_eq!(
        context
            .connection
            .sign_in(
                SignInOptions::default(),
                CancellationToken::new(),
                automatic()
            )
            .await
            .unwrap_err()
            .code,
        "registration_exists"
    );
    assert_eq!(before, serde_json::to_value(saved(&context).await).unwrap());
    assert_eq!(
        context
            .connection
            .get_access_token("")
            .await
            .unwrap_err()
            .code,
        "account_required"
    );
    assert_eq!(
        context
            .connection
            .get_access_token("unknown")
            .await
            .unwrap_err()
            .code,
        "account_not_found"
    );
}

#[tokio::test]
async fn returning_subject_client_and_issuer_changes_are_rejected_without_mutation() {
    let context = setup();
    let account = sign_in(&context).await;
    let before = serde_json::to_value(saved(&context).await).unwrap();
    for field in ["subject", "client", "issuer"] {
        let mut changed = grant();
        match field {
            "subject" => changed.identity.subject = "changed".into(),
            "client" => changed.client_id = "changed".into(),
            _ => changed.identity.issuer = "changed".into(),
        }
        *context.provider.next_grant.lock().unwrap() = Some(changed);
        assert_eq!(
            context
                .connection
                .sign_in(
                    SignInOptions {
                        account_id: Some(account.id.clone()),
                        prompt: None
                    },
                    CancellationToken::new(),
                    automatic()
                )
                .await
                .unwrap_err()
                .code,
            "identity_mismatch"
        );
        assert_eq!(before, serde_json::to_value(saved(&context).await).unwrap());
    }
}

#[tokio::test]
async fn id_token_only_and_partial_scope_grants_do_not_invent_resource_access() {
    for identity_only in [true, false] {
        let context = setup();
        let mut limited = grant();
        limited.credentials.scopes = vec!["openid".into(), "resource.invoke".into()];
        if identity_only {
            limited.credentials.access_token = None;
            limited.credentials.refresh_token = None;
            limited.credentials.expires_at = None;
        }
        *context.provider.next_grant.lock().unwrap() = Some(limited);
        let account = sign_in(&context).await;
        assert_eq!(account.status, AccountStatus::IdentityOnly);
        assert_eq!(
            context
                .connection
                .get_access_token(&account.id)
                .await
                .unwrap_err()
                .code,
            "insufficient_scope"
        );
        assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 0);
        let result = context.connection.sign_out(&account.id).await.unwrap();
        if identity_only {
            assert!(matches!(result.revocation, Revocation::NotAttempted));
        }
        assert!(saved(&context).await.accounts[0].credentials.is_none());
    }
    let context = setup();
    let mut malformed = grant();
    malformed.credentials.access_token = None;
    malformed.credentials.expires_at = None;
    *context.provider.next_grant.lock().unwrap() = Some(malformed);
    assert_eq!(
        context
            .connection
            .sign_in(
                SignInOptions::default(),
                CancellationToken::new(),
                automatic()
            )
            .await
            .unwrap_err()
            .code,
        "invalid_grant_response"
    );
    assert!(saved(&context).await.accounts.is_empty());
}

#[tokio::test]
async fn concurrent_managers_rotate_once_and_return_only_durably_persisted_tokens() {
    let context = setup();
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let second = ChatGPTConnection {
        store: Store::with_keys(
            context.directory.path().to_path_buf(),
            "dev.connection.test".into(),
            context.keys.clone(),
        )
        .unwrap(),
        provider: context.provider.clone(),
    };
    let (first, second) = tokio::join!(
        context.connection.get_access_token(&account.id),
        second.get_access_token(&account.id)
    );
    assert_eq!(first.unwrap(), "rotated-access-secret");
    assert_eq!(second.unwrap(), "rotated-access-secret");
    assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
    let saved = saved(&context).await;
    assert_eq!(
        saved.accounts[0]
            .credentials
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("rotated-refresh-secret")
    );
}

#[tokio::test]
async fn refresh_cannot_expose_a_token_when_atomic_persistence_fails() {
    let context = setup();
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let gate = Arc::new(AsyncGate::new());
    *context.provider.refresh_gate.lock().unwrap() = Some(gate.clone());
    let connection = context.connection.clone();
    let id = account.id.clone();
    let token = tokio::spawn(async move { connection.get_access_token(&id).await });
    gate.entered.notified().await;
    context.keys.fail.store(true, Ordering::SeqCst);
    gate.release();
    assert_eq!(
        token.await.unwrap().unwrap_err().code,
        "keystore_unavailable"
    );
    context.keys.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        saved(&context).await.accounts[0]
            .credentials
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("refresh-secret")
    );
}

#[tokio::test]
async fn successful_refresh_waits_for_the_write_before_exposing_rotated_credentials() {
    let directory = directory();
    let keys = Arc::new(TestKeys {
        get_gate: Some(Gate::default()),
        ..TestKeys::default()
    });
    let provider = Arc::new(FakeProvider::default());
    let context = Context {
        connection: Arc::new(ChatGPTConnection {
            store: Store::with_keys(
                directory.path().to_path_buf(),
                "dev.connection.test".into(),
                keys.clone(),
            )
            .unwrap(),
            provider: provider.clone(),
        }),
        directory,
        keys: keys.clone(),
        provider: provider.clone(),
    };
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let before = std::fs::read(
        context
            .directory
            .path()
            .join("chatgpt-connections.json.enc"),
    )
    .unwrap();
    let gate = Arc::new(AsyncGate::new());
    *provider.refresh_gate.lock().unwrap() = Some(gate.clone());
    let connection = context.connection.clone();
    let id = account.id.clone();
    let first = tokio::spawn(async move { connection.get_access_token(&id).await });
    gate.entered.notified().await;
    keys.gate_on_read
        .store(keys.reads.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    gate.release();
    keys.get_gate.as_ref().unwrap().entered.notified().await;
    let second = Arc::new(ChatGPTConnection {
        store: Store::with_keys(
            context.directory.path().to_path_buf(),
            "dev.connection.test".into(),
            keys.clone(),
        )
        .unwrap(),
        provider: provider.clone(),
    });
    let id = account.id;
    let second = tokio::spawn(async move { second.get_access_token(&id).await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!first.is_finished());
    assert!(!second.is_finished());
    assert_eq!(
        before,
        std::fs::read(
            context
                .directory
                .path()
                .join("chatgpt-connections.json.enc")
        )
        .unwrap()
    );
    keys.get_gate.as_ref().unwrap().release();
    assert_eq!(first.await.unwrap().unwrap(), "rotated-access-secret");
    assert_eq!(second.await.unwrap().unwrap(), "rotated-access-secret");
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(
        saved(&context).await.accounts[0]
            .credentials
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("rotated-refresh-secret")
    );
}

#[tokio::test]
async fn terminal_refresh_codes_clear_credentials_but_transient_errors_preserve_them() {
    for code in [
        "invalid_grant",
        "invalid_refresh_token",
        "token_expired",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_reused",
        "network_error",
        "request_timeout",
        "server_error",
    ] {
        let context = setup();
        let account = sign_in(&context).await;
        expire(&context, &account.id).await;
        let before = saved(&context).await;
        *context.provider.refresh_error.lock().unwrap() = Some(code.into());
        assert_eq!(
            context
                .connection
                .get_access_token(&account.id)
                .await
                .unwrap_err()
                .code,
            code
        );
        let after = saved(&context).await;
        assert_eq!(after.host_id, before.host_id);
        assert_eq!(after.accounts[0].account.client_id, account.client_id);
        if terminal_refresh(code) {
            assert!(after.accounts[0].credentials.is_none());
            assert_eq!(
                after.accounts[0].account.status,
                AccountStatus::ReauthRequired
            );
            assert_eq!(
                context
                    .connection
                    .get_access_token(&account.id)
                    .await
                    .unwrap_err()
                    .code,
                "reauth_required"
            );
            assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
        } else {
            assert_eq!(
                serde_json::to_value(before).unwrap(),
                serde_json::to_value(after).unwrap()
            );
        }
    }
}

#[tokio::test]
async fn earliest_refresh_is_respected_and_expired_access_is_never_returned() {
    let context = setup();
    let account = sign_in(&context).await;
    {
        let locked = context.connection.store.lock(None).await.unwrap();
        let mut state = locked.read().await.unwrap().unwrap();
        let credentials = state.accounts[0].credentials.as_mut().unwrap();
        credentials.expires_at = Some(now_ms().unwrap() + 10_000);
        credentials.refresh_after = Some(now_ms().unwrap() + 60_000);
        locked.write(&state).await.unwrap();
    }
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap(),
        "access-secret"
    );
    expire(&context, &account.id).await;
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap_err()
            .code,
        "refresh_not_available"
    );
    assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 0);
    assert!(saved(&context).await.accounts[0].credentials.is_some());
}

#[tokio::test]
async fn reduced_scope_refresh_is_persisted_without_returning_resource_access() {
    let context = setup();
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let mut limited = grant();
    limited.credentials.scopes = vec!["openid".into()];
    *context.provider.next_grant.lock().unwrap() = Some(limited);
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap_err()
            .code,
        "insufficient_scope"
    );
    assert_eq!(
        saved(&context).await.accounts[0].account.status,
        AccountStatus::IdentityOnly
    );
}

#[tokio::test]
async fn sign_out_waits_for_refresh_and_revokes_the_rotated_token() {
    let context = setup();
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let gate = Arc::new(AsyncGate::new());
    *context.provider.refresh_gate.lock().unwrap() = Some(gate.clone());
    let connection = context.connection.clone();
    let id = account.id.clone();
    let refresh = tokio::spawn(async move { connection.get_access_token(&id).await });
    gate.entered.notified().await;
    let connection = context.connection.clone();
    let id = account.id.clone();
    let sign_out = tokio::spawn(async move { connection.sign_out(&id).await });
    tokio::task::yield_now().await;
    assert!(!sign_out.is_finished());
    gate.release();
    assert_eq!(refresh.await.unwrap().unwrap(), "rotated-access-secret");
    let result = sign_out.await.unwrap().unwrap();
    assert!(matches!(result.revocation, Revocation::Revoked));
    assert_eq!(
        *context.provider.revoked.lock().unwrap(),
        vec!["rotated-refresh-secret"]
    );
    assert_eq!(result.account.status, AccountStatus::SignedOut);
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap_err()
            .code,
        "reauth_required"
    );
}

#[tokio::test]
async fn sign_out_failure_clears_all_hints_retains_host_and_does_not_leak_diagnostics() {
    let context = setup();
    let account = sign_in(&context).await;
    let host = saved(&context).await.host_id;
    *context.provider.revoke_error.lock().unwrap() = Some("revocation_failed".into());
    let result = context.connection.sign_out(&account.id).await.unwrap();
    assert!(matches!(result.revocation, Revocation::Failed));
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("private remote"));
    let state = saved(&context).await;
    assert_eq!(state.host_id, host);
    assert_eq!(state.accounts[0].account.client_id, account.client_id);
    assert!(state.accounts[0].credentials.is_none());
    assert!(state.accounts[0].account.scopes.is_empty());
    assert!(matches!(
        context
            .connection
            .sign_out(&account.id)
            .await
            .unwrap()
            .revocation,
        Revocation::NotAttempted
    ));
    context
        .connection
        .sign_in(
            SignInOptions {
                account_id: Some(account.id),
                prompt: None,
            },
            CancellationToken::new(),
            automatic(),
        )
        .await
        .unwrap();
    assert!(
        !context
            .provider
            .attempts
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .has_hints
    );
}

#[tokio::test]
async fn sign_out_and_concurrent_reauthorization_cannot_be_overwritten_by_old_login() {
    for sign_out in [true, false] {
        let context = setup();
        let account = sign_in(&context).await;
        let (open, opened) = pause_browser();
        let connection = context.connection.clone();
        let id = account.id.clone();
        let pending = tokio::spawn(async move {
            connection
                .sign_in(
                    SignInOptions {
                        account_id: Some(id),
                        prompt: None,
                    },
                    CancellationToken::new(),
                    open,
                )
                .await
        });
        let url = opened.await.unwrap();
        if sign_out {
            context.connection.sign_out(&account.id).await.unwrap();
        } else {
            context
                .connection
                .sign_in(
                    SignInOptions {
                        account_id: Some(account.id.clone()),
                        prompt: None,
                    },
                    CancellationToken::new(),
                    automatic(),
                )
                .await
                .unwrap();
        }
        let before = serde_json::to_value(saved(&context).await).unwrap();
        tokio::task::spawn_blocking(move || deliver(&url))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            pending.await.unwrap().unwrap_err().code,
            "connection_changed"
        );
        assert_eq!(before, serde_json::to_value(saved(&context).await).unwrap());
    }
}

#[tokio::test]
async fn cancellation_during_browser_or_exchange_never_saves_a_late_grant() {
    for during_exchange in [true, false] {
        let context = setup();
        let cancel = CancellationToken::new();
        let gate = Arc::new(AsyncGate::new());
        let (open, opened) = pause_browser();
        if during_exchange {
            *context.provider.exchange_gate.lock().unwrap() = Some(gate.clone());
        }
        let connection = context.connection.clone();
        let caller_cancel = cancel.clone();
        let login = tokio::spawn(async move {
            connection
                .sign_in(SignInOptions::default(), caller_cancel, open)
                .await
        });
        let url = opened.await.unwrap();
        let redirect = callback(&url);
        if during_exchange {
            tokio::task::spawn_blocking(move || deliver(&url))
                .await
                .unwrap()
                .unwrap();
            gate.entered.notified().await;
        }
        cancel.cancel();
        assert_eq!(login.await.unwrap().unwrap_err().code, "cancelled");
        gate.release();
        assert!(saved(&context).await.accounts.is_empty());
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", redirect.port().unwrap()))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn cancellation_waits_for_an_outstanding_host_write_and_lock_release() {
    let directory = directory();
    let keys = Arc::new(TestKeys {
        set_gate: Some(Gate::default()),
        ..TestKeys::default()
    });
    let provider = Arc::new(FakeProvider::default());
    let connection = Arc::new(ChatGPTConnection {
        store: Store::with_keys(
            directory.path().to_path_buf(),
            "dev.cancellation.test".into(),
            keys.clone(),
        )
        .unwrap(),
        provider: provider.clone(),
    });
    let cancel = CancellationToken::new();
    let task_connection = connection.clone();
    let task_cancel = cancel.clone();
    let login = tokio::spawn(async move {
        task_connection
            .sign_in(SignInOptions::default(), task_cancel, automatic())
            .await
    });
    keys.set_gate.as_ref().unwrap().entered.notified().await;
    cancel.cancel();
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !login.is_finished(),
        "cancellation settled during an outstanding critical-section write"
    );
    keys.set_gate.as_ref().unwrap().release();
    assert_eq!(login.await.unwrap().unwrap_err().code, "cancelled");
    let locked = connection.store.lock(None).await.unwrap();
    let state = locked.read().await.unwrap().unwrap();
    assert!(state.accounts.is_empty());
    assert!(state.host_id.starts_with("urn:uuid:"));
    assert!(provider.attempts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pre_canceled_attempt_does_not_touch_storage_or_start_browser() {
    let context = setup();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        context
            .connection
            .sign_in(
                SignInOptions::default(),
                cancel,
                Arc::new(|_| panic!("browser opened"))
            )
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(context.keys.reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::read_dir(context.directory.path()).unwrap().count(),
        0
    );
}

#[tokio::test]
async fn browser_open_failure_closes_the_listener_without_exchange_or_account_save() {
    let context = setup();
    let (send, receive) = oneshot::channel();
    let send = Mutex::new(Some(send));
    let open = Arc::new(move |url: &str| {
        send.lock()
            .unwrap()
            .take()
            .unwrap()
            .send(url.to_string())
            .unwrap();
        Err(Error::new(
            "browser_unavailable",
            "The system browser could not be opened.",
        ))
    });
    let error = context
        .connection
        .sign_in(SignInOptions::default(), CancellationToken::new(), open)
        .await
        .unwrap_err();
    assert_eq!(error.code, "browser_unavailable");
    let redirect = callback(&receive.await.unwrap());
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", redirect.port().unwrap()))
            .await
            .is_err()
    );
    assert_eq!(context.provider.exchanges.load(Ordering::SeqCst), 0);
    assert!(saved(&context).await.accounts.is_empty());
}

#[tokio::test]
async fn sixty_second_leeway_refreshes_early_and_expired_unrenewable_tokens_require_reauth() {
    let context = setup();
    let account = sign_in(&context).await;
    {
        let locked = context.connection.store.lock(None).await.unwrap();
        let mut state = locked.read().await.unwrap().unwrap();
        state.accounts[0].credentials.as_mut().unwrap().expires_at =
            Some(now_ms().unwrap() + 30_000);
        locked.write(&state).await.unwrap();
    }
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap(),
        "rotated-access-secret"
    );
    assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
    let host = saved(&context).await.host_id;
    {
        let locked = context.connection.store.lock(None).await.unwrap();
        let mut state = locked.read().await.unwrap().unwrap();
        let credentials = state.accounts[0].credentials.as_mut().unwrap();
        credentials.expires_at = Some(now_ms().unwrap() - 1);
        credentials.refresh_token = None;
        locked.write(&state).await.unwrap();
    }
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap_err()
            .code,
        "reauth_required"
    );
    let state = saved(&context).await;
    assert_eq!(state.host_id, host);
    assert_eq!(
        state.accounts[0].account.status,
        AccountStatus::ReauthRequired
    );
    assert!(state.accounts[0].credentials.is_none());
    assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn pending_refresh_retries_only_validation_across_independent_managers() {
    for code in [
        "network_error",
        "request_timeout",
        "discovery_failed",
        "invalid_jwks",
        "invalid_discovery",
        "signing_key_unavailable",
    ] {
        let context = setup();
        let account = sign_in(&context).await;
        expire(&context, &account.id).await;
        let before = saved(&context).await;
        *context.provider.validation_error.lock().unwrap() = Some(code.into());
        assert_eq!(
            context
                .connection
                .get_access_token(&account.id)
                .await
                .unwrap_err()
                .code,
            code
        );
        let staged = saved(&context).await;
        assert!(staged.accounts[0].credentials == before.accounts[0].credentials);
        assert!(
            !staged.accounts[0]
                .pending_refresh
                .as_ref()
                .unwrap()
                .rejected
        );
        assert_eq!(
            staged.accounts[0]
                .pending_refresh
                .as_ref()
                .unwrap()
                .candidate
                .credentials
                .refresh_token
                .as_deref(),
            Some("rotated-refresh-secret")
        );
        let second = ChatGPTConnection::with_provider(
            Store::with_keys(
                context.directory.path().to_path_buf(),
                "dev.connection.test".into(),
                context.keys.clone(),
            )
            .unwrap(),
            context.provider.clone(),
        );
        let (first, second) = tokio::join!(
            context.connection.get_access_token(&account.id),
            second.get_access_token(&account.id)
        );
        assert_eq!(first.unwrap(), "rotated-access-secret");
        assert_eq!(second.unwrap(), "rotated-access-secret");
        assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(context.provider.validations.load(Ordering::SeqCst), 2);
        assert_eq!(
            *context.provider.redeemed.lock().unwrap(),
            vec!["refresh-secret"]
        );
        assert!(saved(&context).await.accounts[0].pending_refresh.is_none());
    }
}

#[tokio::test]
async fn promotion_write_failure_keeps_the_already_encrypted_candidate_for_recovery() {
    let context = setup();
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let gate = Arc::new(AsyncGate::new());
    *context.provider.validation_gate.lock().unwrap() = Some(gate.clone());
    let connection = context.connection.clone();
    let id = account.id.clone();
    let task = tokio::spawn(async move { connection.get_access_token(&id).await });
    gate.entered.notified().await;
    let staged = read_encrypted(
        context.directory.path(),
        "dev.connection.test",
        &context.keys,
    );
    assert!(staged.accounts[0].pending_refresh.is_some());
    context.keys.fail.store(true, Ordering::SeqCst);
    gate.release();
    assert_eq!(
        task.await.unwrap().unwrap_err().code,
        "keystore_unavailable"
    );
    context.keys.fail.store(false, Ordering::SeqCst);
    assert!(saved(&context).await.accounts[0].pending_refresh.is_some());
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap(),
        "rotated-access-secret"
    );
    assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(context.provider.validations.load(Ordering::SeqCst), 2);
    assert!(saved(&context).await.accounts[0].pending_refresh.is_none());
}

#[tokio::test]
async fn permanent_candidate_validation_failure_forbids_both_old_access_and_redemption() {
    for code in [
        "invalid_id_token",
        "identity_mismatch",
        "invalid_grant_response",
    ] {
        let context = setup();
        let account = sign_in(&context).await;
        expire(&context, &account.id).await;
        *context.provider.validation_error.lock().unwrap() = Some(code.into());
        assert_eq!(
            context
                .connection
                .get_access_token(&account.id)
                .await
                .unwrap_err()
                .code,
            code
        );
        let state = saved(&context).await;
        assert_eq!(
            state.accounts[0].account.status,
            AccountStatus::ReauthRequired
        );
        assert!(state.accounts[0].pending_refresh.as_ref().unwrap().rejected);
        assert_eq!(
            context
                .connection
                .get_access_token(&account.id)
                .await
                .unwrap_err()
                .code,
            "reauth_required"
        );
        assert_eq!(context.provider.validations.load(Ordering::SeqCst), 1);
        assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
        let result = context.connection.sign_out(&account.id).await.unwrap();
        assert!(matches!(result.revocation, Revocation::Revoked));
        assert_eq!(
            *context.provider.revoked.lock().unwrap(),
            vec!["rotated-refresh-secret"]
        );
        let cleared = saved(&context).await;
        assert!(cleared.accounts[0].credentials.is_none());
        assert!(cleared.accounts[0].pending_refresh.is_none());
    }
}

#[tokio::test]
async fn staging_refresh_increments_revision_and_blocks_an_older_browser_attempt() {
    let context = setup();
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let (open, opened) = pause_browser();
    let connection = context.connection.clone();
    let id = account.id.clone();
    let login = tokio::spawn(async move {
        connection
            .sign_in(
                SignInOptions {
                    account_id: Some(id),
                    prompt: None,
                },
                CancellationToken::new(),
                open,
            )
            .await
    });
    let url = opened.await.unwrap();
    *context.provider.validation_error.lock().unwrap() = Some("network_error".into());
    assert_eq!(
        context
            .connection
            .get_access_token(&account.id)
            .await
            .unwrap_err()
            .code,
        "network_error"
    );
    let staged = serde_json::to_value(saved(&context).await).unwrap();
    tokio::task::spawn_blocking(move || deliver(&url))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(login.await.unwrap().unwrap_err().code, "connection_changed");
    assert_eq!(serde_json::to_value(saved(&context).await).unwrap(), staged);
    assert_eq!(context.provider.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn managed_caller_drop_and_shutdown_drain_cannot_interrupt_pending_write_or_promotion() {
    let directory = directory();
    let keys = Arc::new(TestKeys {
        get_gate: Some(Gate::default()),
        ..TestKeys::default()
    });
    let provider = Arc::new(FakeProvider::default());
    let connection = Arc::new(ChatGPTConnection::with_provider(
        Store::with_keys(
            directory.path().to_path_buf(),
            "dev.connection.test".into(),
            keys.clone(),
        )
        .unwrap(),
        provider.clone(),
    ));
    let context = Context {
        directory,
        keys: keys.clone(),
        provider: provider.clone(),
        connection: connection.clone(),
    };
    let account = sign_in(&context).await;
    expire(&context, &account.id).await;
    let work = Arc::new(crate::commands::CriticalWorkTracker::default());
    let managed = Arc::new(crate::ChatGPT {
        engine: connection.clone(),
        work: work.clone(),
    });
    let exchange = Arc::new(AsyncGate::new());
    let validation = Arc::new(AsyncGate::new());
    *provider.refresh_gate.lock().unwrap() = Some(exchange.clone());
    *provider.validation_gate.lock().unwrap() = Some(validation.clone());
    let id = account.id.clone();
    let caller = tokio::spawn(async move { managed.get_access_token(&id).await });
    exchange.entered.notified().await;
    keys.gate_on_read
        .store(keys.reads.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    exchange.release();
    keys.get_gate.as_ref().unwrap().entered.notified().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let drain_work = work.clone();
    let drain = tokio::task::spawn_blocking(move || {
        crate::handle_plugin_event(
            &crate::commands::RequestRegistry::default(),
            &drain_work,
            crate::PluginEvent::Exit,
        );
    });
    work.shutdown_token().cancelled().await;
    assert!(!drain.is_finished());
    keys.get_gate.as_ref().unwrap().release();
    validation.entered.notified().await;
    let staged = read_encrypted(context.directory.path(), "dev.connection.test", &keys);
    assert!(staged.accounts[0].pending_refresh.is_some());
    assert_eq!(
        staged.accounts[0]
            .credentials
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("refresh-secret")
    );
    assert!(!drain.is_finished());
    validation.release();
    drain.await.unwrap();
    let committed = saved(&context).await;
    assert!(committed.accounts[0].pending_refresh.is_none());
    assert_eq!(
        committed.accounts[0]
            .credentials
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("rotated-refresh-secret")
    );
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(provider.validations.load(Ordering::SeqCst), 1);
}
