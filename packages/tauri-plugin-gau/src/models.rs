use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AccountStatus {
    Ready,
    IdentityOnly,
    SignedOut,
    ReauthRequired,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: Option<bool>,
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// Account-picker data. Credentials are held separately in the native store.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub client_id: String,
    #[serde(flatten)]
    pub identity: Identity,
    pub scopes: Vec<String>,
    pub status: AccountStatus,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Credentials {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_at: Option<u64>,
    pub refresh_after: Option<u64>,
    pub scopes: Vec<String>,
}

/// Parsed refresh response, not yet trusted for access or identity. Stored only
/// inside the encrypted account record before asynchronous JWT verification.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RefreshCandidate {
    pub client_id: String,
    pub credentials: Credentials,
    pub received_at: u64,
    pub id_token_replaced: bool,
}

/// A malformed HTTP 200 may have spent the old refresh token. Only a safely
/// extracted replacement can be retained, and then solely for revocation.
pub(crate) enum RefreshExchange {
    Candidate(RefreshCandidate),
    Rejected { refresh_token: Option<String> },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingRefresh {
    pub candidate: RefreshCandidate,
    /// A permanent verification failure forbids both validation retries and
    /// token use, but keeps the latest refresh token available for revocation.
    pub rejected: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAccount {
    pub account: Account,
    pub redirect_uri: String,
    pub revision: u64,
    pub credentials: Option<Credentials>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_refresh: Option<PendingRefresh>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revocation_refresh_token: Option<String>,
}

impl StoredAccount {
    pub(crate) fn latest_refresh_token(&self) -> Option<&str> {
        if let Some(token) = &self.revocation_refresh_token {
            return Some(token);
        }
        // A pending rotation has spent the previous token. Never fall back to
        // that token, even when the candidate is rejected or has no valid token.
        self.pending_refresh
            .as_ref()
            .map(|pending| &pending.candidate.credentials)
            .or(self.credentials.as_ref())
            .and_then(|credentials| credentials.refresh_token.as_deref())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionState {
    pub version: u32,
    pub host_id: String,
    pub accounts: Vec<StoredAccount>,
}

pub(crate) struct Grant {
    pub client_id: String,
    pub identity: Identity,
    pub credentials: Credentials,
}

pub(crate) struct Attempt {
    pub host_id: String,
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub challenge: String,
    pub redirect_uri: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentPrompt {
    Consent,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignInOptions {
    pub account_id: Option<String>,
    pub prompt: Option<ConsentPrompt>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Revocation {
    Revoked,
    NotAttempted,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    pub account: Account,
    pub revocation: Revocation,
}
