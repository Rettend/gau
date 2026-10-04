use std::{
    future::Future,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    error::{Error, Result},
    loopback::{timeout_error, Loopback},
    models::{
        Account, AccountStatus, Attempt, ConnectionState, Grant, PendingRefresh, RefreshCandidate,
        RefreshExchange, Revocation, SignInOptions, SignOutResult, StoredAccount,
    },
    protocol::{invalid_refresh_response, OpenAI, Provider},
    store::{
        resource_ready, valid_credentials, valid_refresh_candidate, valid_revocation_token,
        LockedStore, Store,
    },
};

const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const REFRESH_LEEWAY_MS: u64 = 60_000;

/// A native ChatGPT connection, separate from application-login sessions.
/// Only safe account metadata is exposed through the plugin's IPC commands.
pub struct ChatGPTConnection {
    store: Store,
    provider: Arc<dyn Provider>,
}

impl ChatGPTConnection {
    /// Initialization does not read or prompt the operating system credential store.
    pub fn new(data_dir: PathBuf, app_id: String, app_name: String) -> Result<Self> {
        Ok(Self {
            store: Store::new(data_dir, app_id)?,
            provider: Arc::new(OpenAI::new(app_name)?),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_provider(store: Store, provider: Arc<dyn Provider>) -> Self {
        Self { store, provider }
    }

    // Keep the native browser callback contract explicit for callers.
    #[allow(clippy::type_complexity)]
    pub async fn sign_in(
        &self,
        options: SignInOptions,
        cancel: CancellationToken,
        open: Arc<dyn Fn(&str) -> Result<()> + Send + Sync>,
    ) -> Result<Account> {
        let deadline = Instant::now() + AUTHORIZATION_TIMEOUT;
        check_attempt(&cancel, deadline)?;
        // Keep the long browser flow outside the lock. A snapshot revision is
        // checked again after exchange, so sign-out and another login cannot be
        // overwritten by an older authorization attempt.
        let (host_id, previous) = {
            let locked = self.store.lock(Some(cancel.clone())).await?;
            check_attempt(&cancel, deadline)?;
            let state = locked.read().await?;
            check_attempt(&cancel, deadline)?;
            let state = match state {
                Some(state) => state,
                None => {
                    let state = ConnectionState {
                        version: 1,
                        host_id: format!("urn:uuid:{}", Uuid::new_v4()),
                        accounts: Vec::new(),
                    };
                    locked.write(&state).await?;
                    // A started host write is awaited even if cancellation arrives.
                    check_attempt(&cancel, deadline)?;
                    state
                }
            };
            let previous = options
                .account_id
                .as_deref()
                .map(|id| find_account(&state, id).cloned())
                .transpose()?;
            (state.host_id, previous)
        };
        check_attempt(&cancel, deadline)?;
        let state = random_value();
        let nonce = random_value();
        let verifier = random_value();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut listener = Loopback::bind(state.clone(), cancel.clone(), deadline).await?;
        let attempt = Attempt {
            host_id,
            state,
            nonce,
            verifier,
            challenge,
            redirect_uri: listener.redirect_uri().into(),
        };

        let result = async {
            check_attempt(&cancel, deadline)?;
            let url = self.provider.authorization_url(
                &attempt,
                previous.as_ref(),
                options.prompt.is_some(),
            )?;
            check_attempt(&cancel, deadline)?;
            // The listener has bound its exact address before the browser opens.
            // Await this synchronous native operation too: no detached browser task.
            let url = url.to_string();
            tokio::task::spawn_blocking(move || open(&url))
                .await
                .map_err(|_| {
                    Error::new(
                        "browser_unavailable",
                        "The system browser could not be opened.",
                    )
                })??;
            check_attempt(&cancel, deadline)?;
            let callback = listener.callback().await?;
            listener.close().await;
            let grant = cancellable(
                &cancel,
                deadline,
                self.provider
                    .exchange(&attempt, previous.as_ref(), &callback),
            )
            .await?;
            validate_grant(&grant)?;
            if let Some(previous) = &previous {
                check_identity(&grant, previous)?;
            }
            check_attempt(&cancel, deadline)?;

            let locked = self.store.lock(Some(cancel.clone())).await?;
            check_attempt(&cancel, deadline)?;
            let mut saved = locked.read().await?.ok_or_else(connection_changed)?;
            check_attempt(&cancel, deadline)?;
            if saved.host_id != attempt.host_id {
                return Err(connection_changed());
            }
            let index = match &previous {
                Some(previous) => {
                    let index = saved
                        .accounts
                        .iter()
                        .position(|account| account.account.id == previous.account.id)
                        .ok_or_else(connection_changed)?;
                    let account = &saved.accounts[index];
                    if account.revision != previous.revision {
                        return Err(connection_changed());
                    }
                    check_identity(&grant, account)?;
                    index
                }
                None => {
                    if saved
                        .accounts
                        .iter()
                        .any(|account| same_registration(&grant, account))
                    {
                        return Err(Error::new(
                            "registration_exists",
                            "Select the existing registration to sign in again.",
                        ));
                    }
                    let now = now_ms()?;
                    saved.accounts.push(StoredAccount {
                        account: Account {
                            id: Uuid::new_v4().to_string(),
                            client_id: grant.client_id.clone(),
                            identity: grant.identity.clone(),
                            scopes: Vec::new(),
                            status: AccountStatus::SignedOut,
                            created_at: now,
                            updated_at: now,
                        },
                        redirect_uri: attempt.redirect_uri.clone(),
                        revision: 0,
                        credentials: None,
                        pending_refresh: None,
                        revocation_refresh_token: None,
                    });
                    saved.accounts.len() - 1
                }
            };
            apply_grant(&mut saved.accounts[index], grant)?;
            // Retain the fixed callback path while recording the latest ephemeral port.
            saved.accounts[index].redirect_uri = attempt.redirect_uri.clone();
            check_attempt(&cancel, deadline)?;
            locked.write(&saved).await?;
            // Once the atomic commit starts, let it complete before returning;
            // cancellation cannot leave a background critical-section write.
            Ok(saved.accounts[index].account.clone())
        }
        .await;
        listener.close().await;
        result
    }

    pub async fn list_accounts(&self) -> Result<Vec<Account>> {
        let locked = self.store.lock(None).await?;
        Ok(locked
            .read()
            .await?
            .map(|state| {
                state
                    .accounts
                    .into_iter()
                    .map(|stored| stored.account)
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Native-only: this is intentionally not registered as an IPC command.
    /// Cross-process locking serializes refresh and sign-out, and refreshed
    /// credentials are durably stored before returning the access token.
    pub async fn get_access_token(&self, account_id: &str) -> Result<String> {
        require_account_id(account_id)?;
        let locked = self.store.lock(None).await?;
        let mut state = locked.read().await?.ok_or_else(account_not_found)?;
        let index = account_index(&state, account_id)?;
        if state.accounts[index].pending_refresh.is_some() {
            // Recovery must finish or fail this exact candidate before looking
            // at the previous access token or attempting another refresh.
            self.promote_pending(&locked, &mut state, index).await?;
        }
        let account = &state.accounts[index];
        let credentials = account.credentials.as_ref().ok_or_else(reauth_required)?;
        if !resource_ready(credentials) {
            return Err(insufficient_scope());
        }

        let now = now_ms()?;
        let refresh_allowed = credentials
            .refresh_after
            .is_none_or(|earliest| earliest <= now);
        if credentials
            .expires_at
            .is_some_and(|expiry| expiry <= now.saturating_add(REFRESH_LEEWAY_MS))
            && credentials.refresh_token.is_some()
            && refresh_allowed
        {
            match self.provider.exchange_refresh(account).await {
                Ok(RefreshExchange::Candidate(candidate)) => {
                    // A strict staging failure after HTTP 200 is unsafe too;
                    // commit a revocation-only record, never keep the spent token.
                    if !valid_refresh_candidate(account, &candidate) {
                        reject_refresh(
                            &mut state.accounts[index],
                            candidate.credentials.refresh_token,
                        )?;
                        locked.write(&state).await?;
                        return Err(invalid_refresh_response());
                    }
                    stage_refresh(&mut state.accounts[index], candidate)?;
                    // The replacement refresh token is already the only one
                    // usable remotely. Commit it before any discovery/JWKS I/O.
                    // Managed native calls own a shutdown-drained critical task;
                    // never race this write or validation against cancellation.
                    locked.write(&state).await?;
                    self.promote_pending(&locked, &mut state, index).await?;
                }
                Ok(RefreshExchange::Rejected { refresh_token }) => {
                    reject_refresh(&mut state.accounts[index], refresh_token)?;
                    locked.write(&state).await?;
                    return Err(invalid_refresh_response());
                }
                Err(error) => {
                    if terminal_refresh(&error.code) {
                        clear_credentials(
                            &mut state.accounts[index],
                            AccountStatus::ReauthRequired,
                        )?;
                        locked.write(&state).await?;
                    }
                    // Only pre-exchange transient failures may keep the old
                    // token. Unreadable HTTP 200 bodies are terminal above.
                    return Err(error);
                }
            }
        }
        let credentials = state.accounts[index]
            .credentials
            .as_ref()
            .ok_or_else(reauth_required)?;
        if !resource_ready(credentials) {
            return Err(insufficient_scope());
        }
        let now = now_ms()?;
        if credentials.expires_at.is_none_or(|expiry| expiry <= now) {
            if credentials
                .refresh_after
                .is_some_and(|earliest| earliest > now)
            {
                return Err(Error::new(
                    "refresh_not_available",
                    "The issuer does not permit refreshing this token yet.",
                ));
            }
            clear_credentials(&mut state.accounts[index], AccountStatus::ReauthRequired)?;
            locked.write(&state).await?;
            return Err(reauth_required());
        }
        credentials
            .access_token
            .clone()
            .ok_or_else(insufficient_scope)
    }

    async fn promote_pending(
        &self,
        locked: &LockedStore,
        state: &mut ConnectionState,
        index: usize,
    ) -> Result<()> {
        let account = &state.accounts[index];
        let pending = account
            .pending_refresh
            .as_ref()
            .ok_or_else(connection_changed)?;
        if pending.rejected {
            return Err(reauth_required());
        }
        let verified = self
            .provider
            .validate_refresh(account, &pending.candidate)
            .await
            .and_then(|grant| {
                validate_refresh_grant(&grant, account, &pending.candidate)?;
                Ok(grant)
            });
        match verified {
            Ok(grant) => {
                apply_grant(&mut state.accounts[index], grant)?;
                // Promotion replaces credentials and removes the candidate in
                // one durable write, still under the same cross-process lock.
                locked.write(state).await
            }
            Err(error) => {
                if permanent_refresh_validation(&error.code) {
                    let account = &mut state.accounts[index];
                    account.revision = account
                        .revision
                        .checked_add(1)
                        .ok_or_else(connection_changed)?;
                    account
                        .pending_refresh
                        .as_mut()
                        .ok_or_else(connection_changed)?
                        .rejected = true;
                    account.account.status = AccountStatus::ReauthRequired;
                    locked.write(state).await?;
                }
                // The already persisted candidate survives transient failures.
                // A later call validates it again, never redeems the old token.
                Err(error)
            }
        }
    }

    pub async fn sign_out(&self, account_id: &str) -> Result<SignOutResult> {
        require_account_id(account_id)?;
        let locked = self.store.lock(None).await?;
        let mut state = locked.read().await?.ok_or_else(account_not_found)?;
        let index = account_index(&state, account_id)?;
        let account = &state.accounts[index];
        // Hold the same lock as refresh while revoking the current (possibly
        // rotated) refresh token. Local credentials are removed even on failure.
        let revocation = if account.latest_refresh_token().is_some() {
            match self.provider.revoke(account).await {
                Ok(()) => Revocation::Revoked,
                Err(_) => Revocation::Failed,
            }
        } else {
            Revocation::NotAttempted
        };
        clear_credentials(&mut state.accounts[index], AccountStatus::SignedOut)?;
        locked.write(&state).await?;
        Ok(SignOutResult {
            account: state.accounts[index].account.clone(),
            revocation,
        })
    }
}

fn random_value() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn validate_grant(grant: &Grant) -> Result<()> {
    let now = now_ms()?;
    if grant.client_id.is_empty()
        || grant.identity.issuer.is_empty()
        || grant.identity.subject.is_empty()
        || !valid_credentials(&grant.credentials)
        || grant
            .credentials
            .expires_at
            .is_some_and(|expiry| expiry <= now)
        || (["resource.invoke", "chatgpt.tokens.use.direct"]
            .iter()
            .all(|scope| grant.credentials.scopes.iter().any(|value| value == scope))
            && grant.credentials.access_token.is_none())
    {
        return Err(Error::new(
            "invalid_grant_response",
            "The provider returned an invalid credential set.",
        ));
    }
    Ok(())
}

fn stage_refresh(account: &mut StoredAccount, candidate: RefreshCandidate) -> Result<()> {
    if account.pending_refresh.is_some() || !valid_refresh_candidate(account, &candidate) {
        return Err(Error::new(
            "invalid_grant_response",
            "The provider returned an invalid credential set.",
        ));
    }
    account.revision = account
        .revision
        .checked_add(1)
        .ok_or_else(connection_changed)?;
    // Keep only the old verified identity/profile/hints active until validation.
    account.pending_refresh = Some(PendingRefresh {
        candidate,
        rejected: false,
    });
    Ok(())
}

fn validate_refresh_grant(
    grant: &Grant,
    account: &StoredAccount,
    candidate: &RefreshCandidate,
) -> Result<()> {
    check_identity(grant, account)?;
    if !valid_refresh_candidate(account, candidate) || grant.credentials != candidate.credentials {
        return Err(Error::new(
            "invalid_grant_response",
            "The provider returned an invalid credential set.",
        ));
    }
    // Access may have expired while waiting for verification to recover. Its
    // latest renewable token must still be promoted, never replaced by the old
    // spent token. get_access_token checks expiry before exposing any access.
    Ok(())
}

fn reject_refresh(account: &mut StoredAccount, refresh_token: Option<String>) -> Result<()> {
    let replacement = refresh_token.filter(|token| {
        valid_revocation_token(token)
            && account
                .credentials
                .as_ref()
                .and_then(|previous| previous.refresh_token.as_ref())
                != Some(token)
    });
    clear_credentials(account, AccountStatus::ReauthRequired)?;
    account.revocation_refresh_token = replacement;
    Ok(())
}

fn same_registration(grant: &Grant, account: &StoredAccount) -> bool {
    grant.client_id == account.account.client_id
        && grant.identity.issuer == account.account.identity.issuer
        && grant.identity.subject == account.account.identity.subject
}

fn check_identity(grant: &Grant, account: &StoredAccount) -> Result<()> {
    if !same_registration(grant, account) {
        return Err(Error::new(
            "identity_mismatch",
            "The result does not match the selected registration.",
        ));
    }
    Ok(())
}

fn apply_grant(account: &mut StoredAccount, grant: Grant) -> Result<()> {
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(connection_changed)?;
    let now = now_ms()?;
    account.account.identity = grant.identity;
    account.account.scopes = grant.credentials.scopes.clone();
    account.account.status = if resource_ready(&grant.credentials) {
        AccountStatus::Ready
    } else {
        AccountStatus::IdentityOnly
    };
    account.account.updated_at = now.max(account.account.updated_at);
    account.credentials = Some(grant.credentials);
    account.pending_refresh = None;
    account.revocation_refresh_token = None;
    account.revision = revision;
    Ok(())
}

fn clear_credentials(account: &mut StoredAccount, status: AccountStatus) -> Result<()> {
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(connection_changed)?;
    let now = now_ms()?;
    account.credentials = None; // includes ID-token and refresh-token login hints
    account.pending_refresh = None;
    account.revocation_refresh_token = None;
    account.account.scopes.clear();
    account.account.status = status;
    account.account.updated_at = now.max(account.account.updated_at);
    account.revision = revision;
    Ok(())
}

fn terminal_refresh(code: &str) -> bool {
    matches!(
        code,
        "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused"
            | "reauth_required"
            | "invalid_refresh_response"
    )
}

fn permanent_refresh_validation(code: &str) -> bool {
    matches!(
        code,
        "invalid_id_token"
            | "identity_mismatch"
            | "invalid_grant_response"
            | "registration_incomplete"
            | "client_id_mismatch"
    )
}

fn require_account_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(Error::new(
            "account_required",
            "Select a connection account explicitly.",
        ));
    }
    Ok(())
}

fn account_index(state: &ConnectionState, id: &str) -> Result<usize> {
    require_account_id(id)?;
    state
        .accounts
        .iter()
        .position(|account| account.account.id == id)
        .ok_or_else(account_not_found)
}

fn find_account<'a>(state: &'a ConnectionState, id: &str) -> Result<&'a StoredAccount> {
    Ok(&state.accounts[account_index(state, id)?])
}

fn check_attempt(cancel: &CancellationToken, deadline: Instant) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    if Instant::now() >= deadline {
        return Err(timeout_error());
    }
    Ok(())
}

async fn cancellable<T>(
    cancel: &CancellationToken,
    deadline: Instant,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::cancelled()),
        result = timeout_at(deadline, future) => result.unwrap_or_else(|_| Err(timeout_error())),
    }
}

fn now_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| Error::new("invalid_clock", "The system clock is invalid."))
}

fn reauth_required() -> Error {
    Error::new(
        "reauth_required",
        "Sign in to the selected connection again.",
    )
}
fn insufficient_scope() -> Error {
    Error::new(
        "insufficient_scope",
        "The selected connection has not granted resource access.",
    )
}
fn account_not_found() -> Error {
    Error::new(
        "account_not_found",
        "The selected connection account was not found.",
    )
}
fn connection_changed() -> Error {
    Error::new(
        "connection_changed",
        "The connection changed during sign-in. Try again.",
    )
}

#[cfg(test)]
#[path = "connection/tests.rs"]
mod tests;
