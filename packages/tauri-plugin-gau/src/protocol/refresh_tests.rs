use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

use super::*;
use crate::{
    connection::ChatGPTConnection,
    models::ConnectionState,
    store::{
        test_keys::{directory, read_encrypted, TestKeys},
        Store,
    },
};

const APP_ID: &str = "dev.protocol.rotation.test";

struct ObservedProvider {
    inner: Arc<OpenAI>,
    directory: PathBuf,
    keys: Arc<TestKeys>,
    validations: AtomicUsize,
}

#[async_trait::async_trait]
impl Provider for ObservedProvider {
    fn authorization_url(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        prompt: bool,
    ) -> Result<Url> {
        self.inner.authorization_url(attempt, previous, prompt)
    }

    async fn exchange(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        callback: &Url,
    ) -> Result<Grant> {
        self.inner.exchange(attempt, previous, callback).await
    }

    async fn exchange_refresh(&self, account: &StoredAccount) -> Result<RefreshExchange> {
        self.inner.exchange_refresh(account).await
    }

    async fn validate_refresh(
        &self,
        account: &StoredAccount,
        candidate: &RefreshCandidate,
    ) -> Result<Grant> {
        self.validations.fetch_add(1, Ordering::SeqCst);
        // Check the actual ciphertext commit before the real provider can do
        // discovery/JWKS I/O, not just the engine's in-memory candidate.
        let saved = read_encrypted(&self.directory, APP_ID, &self.keys);
        let stored = &saved.accounts[0];
        let pending = stored
            .pending_refresh
            .as_ref()
            .expect("candidate was not committed before validation");
        assert!(!pending.rejected);
        assert!(pending.candidate.credentials == candidate.credentials);
        assert_eq!(pending.candidate.client_id, account.account.client_id);
        assert_eq!(
            stored.account.identity.name.as_deref(),
            Some("Test account")
        );
        assert_eq!(
            stored.credentials.as_ref().unwrap().access_token.as_deref(),
            Some("access-secret")
        );
        assert_eq!(
            stored
                .credentials
                .as_ref()
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("refresh-secret")
        );
        let bytes = std::fs::read(self.directory.join("chatgpt-connections.json.enc")).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        for token in [
            &candidate.credentials.access_token,
            &candidate.credentials.refresh_token,
            &candidate.credentials.id_token,
        ]
        .into_iter()
        .flatten()
        {
            assert!(!text.contains(token));
        }
        self.inner.validate_refresh(account, candidate).await
    }

    async fn revoke(&self, account: &StoredAccount) -> Result<()> {
        self.inner.revoke(account).await
    }
}

struct Context {
    server: Server,
    directory: tempfile::TempDir,
    store: Store,
    keys: Arc<TestKeys>,
    provider: Arc<ObservedProvider>,
    connection: ChatGPTConnection,
    account_id: String,
}

impl Context {
    async fn new() -> Self {
        let server = Server::start().await;
        let directory = directory();
        let keys = Arc::new(TestKeys::default());
        let store =
            Store::with_keys(directory.path().to_path_buf(), APP_ID.into(), keys.clone()).unwrap();
        let mut account = signed_in(&server.provider()).await;
        // The old token is still unexpired: failed verification must not fall
        // back to it even when refresh was started within the early leeway.
        account.credentials.as_mut().unwrap().expires_at = Some(now_ms().unwrap() + 30_000);
        let account_id = account.account.id.clone();
        store
            .lock(None)
            .await
            .unwrap()
            .write(&ConnectionState {
                version: 1,
                host_id: attempt().host_id,
                accounts: vec![account],
            })
            .await
            .unwrap();
        server.fixture.lock().await.refresh_claims = Some(json!({"name": "Updated account"}));
        let provider = Arc::new(ObservedProvider {
            inner: Arc::new(server.provider()),
            directory: directory.path().to_path_buf(),
            keys: keys.clone(),
            validations: AtomicUsize::new(0),
        });
        let connection = ChatGPTConnection::with_provider(store.clone(), provider.clone());
        Self {
            server,
            directory,
            store,
            keys,
            provider,
            connection,
            account_id,
        }
    }

    async fn state(&self) -> ConnectionState {
        self.store
            .lock(None)
            .await
            .unwrap()
            .read()
            .await
            .unwrap()
            .unwrap()
    }

    async fn refresh_count(&self) -> usize {
        self.server
            .fixture
            .lock()
            .await
            .requests
            .iter()
            .filter(|request| {
                request
                    .form
                    .get("grant_type")
                    .is_some_and(|grant| grant == "refresh_token")
            })
            .count()
    }

    fn reopen(&self) -> ChatGPTConnection {
        let store = Store::with_keys(
            self.directory.path().to_path_buf(),
            APP_ID.into(),
            self.keys.clone(),
        )
        .unwrap();
        let provider = Arc::new(ObservedProvider {
            inner: Arc::new(self.server.provider()),
            directory: self.directory.path().to_path_buf(),
            keys: self.keys.clone(),
            validations: AtomicUsize::new(0),
        });
        ChatGPTConnection::with_provider(store, provider)
    }
}

#[tokio::test]
async fn signed_refresh_survives_jwks_or_discovery_outage_and_reopen_without_second_redemption() {
    for discovery_outage in [false, true] {
        let context = Context::new().await;
        let before = context.state().await;
        let now = now_ms().unwrap();
        {
            let mut fixture = context.server.fixture.lock().await;
            if discovery_outage {
                fixture.discovery_status = 503;
            } else {
                fixture.jwks_status = 503;
            }
        }
        let error = context
            .connection
            .get_access_token(&context.account_id)
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            if discovery_outage {
                "discovery_failed"
            } else {
                "invalid_jwks"
            }
        );
        assert_eq!(context.refresh_count().await, 1);
        let staged = context.state().await;
        let pending = staged.accounts[0].pending_refresh.as_ref().unwrap();
        assert!(!pending.rejected);
        assert!(pending.candidate.received_at >= now);
        assert_eq!(
            pending.candidate.credentials.expires_at,
            Some(pending.candidate.received_at + 3_600_000)
        );
        assert!(staged.accounts[0].credentials == before.accounts[0].credentials);
        assert_eq!(
            serde_json::to_value(&staged.accounts[0].account).unwrap(),
            serde_json::to_value(&before.accounts[0].account).unwrap()
        );
        let reopened = context.reopen();
        let accounts = reopened.list_accounts().await.unwrap();
        let public = serde_json::to_string(&accounts).unwrap();
        assert!(!public.contains("pendingRefresh"));
        assert!(!public.contains("secret"));
        {
            let mut fixture = context.server.fixture.lock().await;
            fixture.discovery_status = 200;
            fixture.jwks_status = 200;
        }
        // Independent stores/HTTP providers contend on the real OS file lock.
        let (first, second) = tokio::join!(
            reopened.get_access_token(&context.account_id),
            context.connection.get_access_token(&context.account_id),
        );
        assert_eq!(first.unwrap(), "rotated-access-secret");
        assert_eq!(second.unwrap(), "rotated-access-secret");
        assert_eq!(context.refresh_count().await, 1);
        let promoted = context.state().await;
        let account = &promoted.accounts[0];
        assert!(account.pending_refresh.is_none());
        assert_eq!(
            account.account.identity.name.as_deref(),
            Some("Updated account")
        );
        assert_eq!(
            account
                .credentials
                .as_ref()
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("rotated-refresh-secret")
        );
        assert_eq!(account.revision, before.accounts[0].revision + 2);
    }
}

#[tokio::test]
async fn unknown_rotated_signing_key_keeps_candidate_through_cooldown_then_validates_it() {
    let context = Context::new().await;
    {
        let mut fixture = context.server.fixture.lock().await;
        fixture.kid = "rotated-key".into();
        fixture.wrong_signature = true; // Signed with the second fixture RSA key.
    }
    assert_error(
        context
            .connection
            .get_access_token(&context.account_id)
            .await,
        "signing_key_unavailable",
    );
    assert!(
        !context.state().await.accounts[0]
            .pending_refresh
            .as_ref()
            .unwrap()
            .rejected
    );
    let count = context.server.request_count("/keys").await;
    let keys: Value = serde_json::from_str(include_str!("fixtures/keys.json")).unwrap();
    context.server.fixture.lock().await.jwks = json!({"keys": [keys[1].clone()]});
    assert_error(
        context
            .connection
            .get_access_token(&context.account_id)
            .await,
        "signing_key_unavailable",
    );
    assert_eq!(context.server.request_count("/keys").await, count);
    context
        .provider
        .inner
        .jwks
        .lock()
        .await
        .as_mut()
        .unwrap()
        .last_refresh_attempt = Instant::now() - JWKS_REFRESH_COOLDOWN;
    assert_eq!(
        context
            .connection
            .get_access_token(&context.account_id)
            .await
            .unwrap(),
        "rotated-access-secret"
    );
    assert_eq!(context.refresh_count().await, 1);
    assert_eq!(context.server.request_count("/keys").await, count + 1);
    assert!(context.state().await.accounts[0].pending_refresh.is_none());
}

#[tokio::test]
async fn invalid_signed_refresh_never_exposes_either_token_and_permanently_stops_validation() {
    for (claims, wrong_signature, code) in [
        (json!({"name": "Unverified name"}), true, "invalid_id_token"),
        (
            json!({"aud": "different-registration"}),
            false,
            "invalid_id_token",
        ),
        (
            json!({"sub": "different-subject"}),
            false,
            "identity_mismatch",
        ),
    ] {
        let context = Context::new().await;
        {
            let mut fixture = context.server.fixture.lock().await;
            fixture.refresh_claims = Some(claims);
            fixture.wrong_signature = wrong_signature;
        }
        assert_error(
            context
                .connection
                .get_access_token(&context.account_id)
                .await,
            code,
        );
        let rejected = context.state().await;
        let account = &rejected.accounts[0];
        assert_eq!(account.account.status, AccountStatus::ReauthRequired);
        assert_eq!(
            account.account.identity.name.as_deref(),
            Some("Test account")
        );
        assert!(account.pending_refresh.as_ref().unwrap().rejected);
        assert_eq!(
            account.latest_refresh_token(),
            Some("rotated-refresh-secret")
        );
        assert_error(
            context.reopen().get_access_token(&context.account_id).await,
            "reauth_required",
        );
        assert_error(
            context
                .connection
                .get_access_token(&context.account_id)
                .await,
            "reauth_required",
        );
        assert_eq!(context.refresh_count().await, 1);
        assert_eq!(context.provider.validations.load(Ordering::SeqCst), 1);
        let result = context
            .connection
            .sign_out(&context.account_id)
            .await
            .unwrap();
        assert!(matches!(
            result.revocation,
            crate::models::Revocation::Revoked
        ));
        let cleared = context.state().await;
        assert!(cleared.accounts[0].credentials.is_none());
        assert!(cleared.accounts[0].pending_refresh.is_none());
        let fixture = context.server.fixture.lock().await;
        let request = fixture
            .requests
            .iter()
            .find(|request| request.path == "/discovered-revoke")
            .unwrap();
        assert_eq!(
            request.form.get("token").map(String::as_str),
            Some("rotated-refresh-secret")
        );
    }
}

#[tokio::test]
async fn sign_out_revokes_pending_rotation_and_clears_both_credential_sets_even_on_failure() {
    for revoke_fails in [false, true] {
        let context = Context::new().await;
        context.server.fixture.lock().await.jwks_status = 503;
        assert_error(
            context
                .connection
                .get_access_token(&context.account_id)
                .await,
            "invalid_jwks",
        );
        if revoke_fails {
            context.server.fixture.lock().await.revocation_statuses = VecDeque::from([503]);
        }
        let result = context
            .reopen()
            .sign_out(&context.account_id)
            .await
            .unwrap();
        assert!(matches!(
            (&result.revocation, revoke_fails),
            (crate::models::Revocation::Revoked, false) | (crate::models::Revocation::Failed, true)
        ));
        let cleared = context.state().await;
        assert_eq!(cleared.accounts[0].account.status, AccountStatus::SignedOut);
        assert_eq!(cleared.accounts[0].account.client_id, CLIENT_ID);
        assert!(cleared.accounts[0].pending_refresh.is_none());
        assert!(cleared.accounts[0].credentials.is_none());
        assert_eq!(context.refresh_count().await, 1);
        let fixture = context.server.fixture.lock().await;
        for request in fixture
            .requests
            .iter()
            .filter(|request| request.path == "/discovered-revoke")
        {
            assert_eq!(
                request.form.get("token").map(String::as_str),
                Some("rotated-refresh-secret")
            );
        }
    }
}

#[tokio::test]
async fn refresh_without_replaced_id_token_is_still_staged_before_fast_validation() {
    let context = Context::new().await;
    context.server.fixture.lock().await.refresh_claims = None;
    let keys_before = context.server.request_count("/keys").await;
    let discovery_before = context
        .server
        .request_count("/.well-known/openid-configuration")
        .await;
    assert_eq!(
        context
            .connection
            .get_access_token(&context.account_id)
            .await
            .unwrap(),
        "rotated-access-secret"
    );
    assert_eq!(context.provider.validations.load(Ordering::SeqCst), 1);
    assert_eq!(context.refresh_count().await, 1);
    assert_eq!(context.server.request_count("/keys").await, keys_before);
    assert_eq!(
        context
            .server
            .request_count("/.well-known/openid-configuration")
            .await,
        discovery_before
    );
    let promoted = context.state().await;
    assert!(promoted.accounts[0].pending_refresh.is_none());
    assert_eq!(
        promoted.accounts[0].account.identity.name.as_deref(),
        Some("Test account")
    );
}

#[tokio::test]
async fn malformed_http_200_refresh_blocks_old_reuse_and_retains_only_a_safe_token_for_revocation()
{
    for malformed in [
        "empty-id",
        "invalid-access",
        "invalid-scopes",
        "unreadable-json",
        "unsafe-refresh",
    ] {
        let context = Context::new().await;
        let before = context.state().await;
        let can_revoke = !matches!(malformed, "unreadable-json" | "unsafe-refresh");
        {
            let mut fixture = context.server.fixture.lock().await;
            fixture.refresh_fields = match malformed {
                "empty-id" => json!({"id_token": ""}),
                "invalid-access" => json!({"access_token": 123}),
                // Parses as credentials but fails strict candidate staging.
                "invalid-scopes" => json!({"scope": "invalid\"scope"}),
                "unsafe-refresh" => {
                    json!({"refresh_token": " rotated-refresh-secret ", "id_token": ""})
                }
                _ => json!({}),
            };
            if malformed == "unreadable-json" {
                fixture.refresh_body = Some("<html>private refresh-secret</html>".into());
            }
        }
        assert_error(
            context
                .connection
                .get_access_token(&context.account_id)
                .await,
            "invalid_refresh_response",
        );
        let rejected = context.state().await;
        let account = &rejected.accounts[0];
        assert_eq!(account.account.status, AccountStatus::ReauthRequired);
        assert_eq!(
            serde_json::to_value(&account.account.identity).unwrap(),
            serde_json::to_value(&before.accounts[0].account.identity).unwrap()
        );
        assert!(account.credentials.is_none());
        assert!(account.pending_refresh.is_none());
        assert_eq!(
            account.latest_refresh_token(),
            can_revoke.then_some("rotated-refresh-secret")
        );
        assert_eq!(
            account.revocation_refresh_token.as_deref(),
            account.latest_refresh_token()
        );
        assert_eq!(account.revision, before.accounts[0].revision + 1);
        assert_error(
            context
                .connection
                .get_access_token(&context.account_id)
                .await,
            "reauth_required",
        );
        assert_error(
            context.reopen().get_access_token(&context.account_id).await,
            "reauth_required",
        );
        assert_eq!(context.refresh_count().await, 1);
        assert_eq!(context.provider.validations.load(Ordering::SeqCst), 0);
        let ciphertext = std::fs::read(
            context
                .directory
                .path()
                .join("chatgpt-connections.json.enc"),
        )
        .unwrap();
        let text = std::str::from_utf8(&ciphertext).unwrap();
        assert!(!text.contains("secret"));
        let public =
            serde_json::to_string(&context.connection.list_accounts().await.unwrap()).unwrap();
        assert!(!public.contains("secret"));
        assert!(!public.contains("revocationRefreshToken"));
        let result = context
            .reopen()
            .sign_out(&context.account_id)
            .await
            .unwrap();
        assert!(matches!(
            (result.revocation, can_revoke),
            (crate::models::Revocation::Revoked, true)
                | (crate::models::Revocation::NotAttempted, false)
        ));
        let cleared = context.state().await;
        assert!(cleared.accounts[0].credentials.is_none());
        assert!(cleared.accounts[0].pending_refresh.is_none());
        assert!(cleared.accounts[0].revocation_refresh_token.is_none());
        assert_eq!(cleared.accounts[0].account.client_id, CLIENT_ID);
        let fixture = context.server.fixture.lock().await;
        let revocations: Vec<_> = fixture
            .requests
            .iter()
            .filter(|request| request.path == "/discovered-revoke")
            .collect();
        assert_eq!(revocations.len(), usize::from(can_revoke));
        for request in revocations {
            assert_eq!(
                request.form.get("token").map(String::as_str),
                Some("rotated-refresh-secret")
            );
        }
    }
}

#[tokio::test]
async fn malformed_http_500_refresh_is_transient_and_preserves_the_previous_credentials() {
    let context = Context::new().await;
    let before = serde_json::to_value(context.state().await).unwrap();
    {
        let mut fixture = context.server.fixture.lock().await;
        fixture.refresh_status = 500;
        fixture.refresh_body = Some("<html>private refresh-secret</html>".into());
    }
    assert_error(
        context
            .connection
            .get_access_token(&context.account_id)
            .await,
        "token_request_failed",
    );
    assert_eq!(serde_json::to_value(context.state().await).unwrap(), before);
    {
        let mut fixture = context.server.fixture.lock().await;
        fixture.refresh_status = 200;
        fixture.refresh_body = None;
    }
    assert_eq!(
        context
            .connection
            .get_access_token(&context.account_id)
            .await
            .unwrap(),
        "rotated-access-secret"
    );
    assert_eq!(context.refresh_count().await, 2);
    let fixture = context.server.fixture.lock().await;
    for request in fixture.requests.iter().filter(|request| {
        request
            .form
            .get("grant_type")
            .is_some_and(|grant| grant == "refresh_token")
    }) {
        assert_eq!(
            request.form.get("refresh_token").map(String::as_str),
            Some("refresh-secret")
        );
    }
}
