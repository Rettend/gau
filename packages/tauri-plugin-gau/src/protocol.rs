use std::{
    collections::HashSet,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use reqwest::{Client, Response, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use url::Url;

use crate::{
    error::{Error, Result},
    models::{
        Attempt, Credentials, Grant, Identity, RefreshCandidate, RefreshExchange, StoredAccount,
    },
    store::{valid_refresh_candidate, valid_revocation_token},
};

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPES: [&str; 2] = ["resource.invoke", "chatgpt.tokens.use.direct"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const DISCOVERY_TTL: Duration = Duration::from_secs(3600);
const JWKS_TTL: Duration = Duration::from_secs(600);
const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[async_trait::async_trait]
pub(crate) trait Provider: Send + Sync {
    fn authorization_url(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        prompt: bool,
    ) -> Result<Url>;
    async fn exchange(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        callback: &Url,
    ) -> Result<Grant>;
    /// Exchange only. The caller must durably stage the returned candidate
    /// while holding the account lock before invoking validate_refresh.
    async fn exchange_refresh(&self, account: &StoredAccount) -> Result<RefreshExchange>;
    /// Does not redeem a refresh token. This can be retried on a staged candidate
    /// after discovery/JWKS failures, including after reopening the native store.
    async fn validate_refresh(
        &self,
        account: &StoredAccount,
        candidate: &RefreshCandidate,
    ) -> Result<Grant>;
    async fn revoke(&self, account: &StoredAccount) -> Result<()>;
}

/// Production requests use only the official issuer and token endpoint.
/// Transport fields are private; unit tests can substitute a local HTTP server.
pub(crate) struct OpenAI {
    app_name: String,
    client: Client,
    endpoints: Endpoints,
    discovery: Mutex<Option<CachedDiscovery>>,
    jwks: Mutex<Option<CachedJwks>>,
}

struct Endpoints {
    discovery: Url,
    token: Url,
}

#[derive(Clone)]
struct Discovery {
    jwks_uri: Url,
    revocation_endpoint: Url,
}

struct CachedDiscovery {
    metadata: Discovery,
    fetched_at: Instant,
}

struct CachedJwks {
    uri: Url,
    keys: Vec<RsaKey>,
    fetched_at: Instant,
    last_refresh_attempt: Instant,
}

struct RsaKey {
    kid: String,
    key: DecodingKey,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: Audience,
    exp: u64,
    iat: u64,
    #[serde(default, deserialize_with = "present_string")]
    azp: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    nonce: Option<String>,
    #[serde(default)]
    email: Value,
    #[serde(default)]
    email_verified: Value,
    #[serde(default)]
    name: Value,
    #[serde(default)]
    picture: Value,
}

impl OpenAI {
    pub fn new(app_name: String) -> Result<Self> {
        if app_name.trim().is_empty()
            || app_name.len() > 512
            || app_name.chars().any(char::is_control)
        {
            return Err(Error::new(
                "invalid_configuration",
                "Provide your actual app name for ChatGPT registration.",
            ));
        }
        let client = Client::builder()
            .https_only(true)
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                Error::new(
                    "invalid_configuration",
                    "The OpenAI HTTP client could not be initialized.",
                )
            })?;
        Ok(Self {
            app_name,
            client,
            endpoints: Endpoints {
                discovery: Url::parse("https://auth.openai.com/.well-known/openid-configuration")
                    .expect("fixed URL"),
                token: Url::parse(TOKEN).expect("fixed URL"),
            },
            discovery: Mutex::new(None),
            jwks: Mutex::new(None),
        })
    }

    async fn get_discovery(&self) -> Result<Discovery> {
        self.get_discovery_with_clock(Instant::now).await
    }

    async fn get_discovery_with_clock(&self, now: impl Fn() -> Instant) -> Result<Discovery> {
        // Serialize cache misses as well as key refreshes. A failed request does
        // not become a cached failure, and every network operation is bounded.
        let mut cache = self.discovery.lock().await;
        if let Some(cached) = cache
            .as_ref()
            .filter(|cached| now().saturating_duration_since(cached.fetched_at) < DISCOVERY_TTL)
        {
            return Ok(cached.metadata.clone());
        }
        let response = self
            .client
            .get(self.endpoints.discovery.clone())
            .send()
            .await
            .map_err(request_error)?;
        if response.status() != StatusCode::OK {
            return Err(Error::new("discovery_failed", "OpenAI discovery failed."));
        }
        let data = read_json(
            response,
            "invalid_discovery",
            "OpenAI discovery returned an invalid response.",
        )
        .await?;
        if data.get("issuer").and_then(Value::as_str) != Some(ISSUER) {
            return Err(Error::new(
                "invalid_discovery",
                "OpenAI discovery returned an unexpected issuer.",
            ));
        }
        let metadata = Discovery {
            jwks_uri: self.discovery_endpoint(data.get("jwks_uri"))?,
            revocation_endpoint: self.discovery_endpoint(data.get("revocation_endpoint"))?,
        };
        *cache = Some(CachedDiscovery {
            metadata: metadata.clone(),
            fetched_at: now(),
        });
        Ok(metadata)
    }

    fn discovery_endpoint(&self, value: Option<&Value>) -> Result<Url> {
        let invalid = || {
            Error::new(
                "invalid_discovery",
                "OpenAI discovery returned an unexpected endpoint.",
            )
        };
        let endpoint = Url::parse(value.and_then(Value::as_str).ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        let https = endpoint.scheme() == "https";
        // This exception is compiled only for private unit-test HTTP endpoints.
        #[cfg(test)]
        let https =
            https || (self.endpoints.discovery.scheme() == "http" && endpoint.scheme() == "http");
        if !https
            || endpoint.origin() != self.endpoints.discovery.origin()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(invalid());
        }
        Ok(endpoint)
    }

    async fn fetch_jwks(&self, uri: &Url) -> Result<CachedJwks> {
        let invalid = || Error::new("invalid_jwks", "OpenAI signing keys could not be loaded.");
        let response = self
            .client
            .get(uri.clone())
            .send()
            .await
            .map_err(request_error)?;
        if response.status() != StatusCode::OK {
            return Err(invalid());
        }
        let data = read_json(
            response,
            "invalid_jwks",
            "OpenAI signing keys could not be loaded.",
        )
        .await?;
        let values = data
            .get("keys")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if values.is_empty() || values.len() > 128 {
            return Err(invalid());
        }
        let mut keys = Vec::new();
        for value in values {
            if value.get("kty").and_then(Value::as_str) != Some("RSA")
                || value
                    .get("alg")
                    .is_some_and(|alg| alg.as_str() != Some("RS256"))
                || value
                    .get("use")
                    .is_some_and(|usage| usage.as_str() != Some("sig"))
                || value.get("key_ops").is_some_and(|ops| {
                    !ops.as_array()
                        .is_some_and(|ops| ops.iter().any(|op| op.as_str() == Some("verify")))
                })
            {
                continue;
            }
            let Some(kid) = value
                .get("kid")
                .and_then(Value::as_str)
                .filter(|kid| !kid.is_empty() && kid.len() <= 256)
            else {
                continue;
            };
            let Some(n) = value
                .get("n")
                .and_then(Value::as_str)
                .filter(|n| n.len() <= 1400)
            else {
                continue;
            };
            let Some(e) = value
                .get("e")
                .and_then(Value::as_str)
                .filter(|e| e.len() <= 16)
            else {
                continue;
            };
            if !URL_SAFE_NO_PAD
                .decode(n)
                .is_ok_and(|n| (256..=1024).contains(&n.len()))
                || !URL_SAFE_NO_PAD
                    .decode(e)
                    .is_ok_and(|e| !e.is_empty() && e.len() <= 8)
            {
                continue;
            }
            let key = DecodingKey::from_rsa_components(n, e).map_err(|_| invalid())?;
            keys.push(RsaKey {
                kid: kid.to_owned(),
                key,
            });
        }
        if keys.is_empty() {
            return Err(invalid());
        }
        let fetched_at = Instant::now();
        Ok(CachedJwks {
            uri: uri.clone(),
            keys,
            fetched_at,
            last_refresh_attempt: fetched_at,
        })
    }

    async fn signing_key(&self, uri: &Url, kid: &str) -> Result<DecodingKey> {
        let mut cache = self.jwks.lock().await;
        let needs_fetch = cache
            .as_ref()
            .is_none_or(|cached| cached.uri != *uri || cached.fetched_at.elapsed() >= JWKS_TTL);
        if needs_fetch {
            // Clear expired data first so a failed fetch cannot extend its life.
            *cache = None;
            *cache = Some(self.fetch_jwks(uri).await?);
        }
        let cached = cache.as_ref().expect("loaded cache");
        let matches = cached.keys.iter().filter(|key| key.kid == kid).count();
        if matches == 0
            && !needs_fetch
            && cached.last_refresh_attempt.elapsed() >= JWKS_REFRESH_COOLDOWN
        {
            // An unknown kid can trigger at most one refresh per cooldown, never
            // a URL from the JWT header. Record failed refreshes too.
            cache.as_mut().expect("loaded cache").last_refresh_attempt = Instant::now();
            let refreshed = self.fetch_jwks(uri).await?;
            *cache = Some(refreshed);
        }
        let keys = &cache.as_ref().expect("loaded cache").keys;
        let mut matching = keys.iter().filter(|key| key.kid == kid);
        let key = matching.next().ok_or_else(|| {
            Error::new(
                "signing_key_unavailable",
                "The OpenAI signing key is not available yet. Try again.",
            )
        })?;
        if matching.next().is_some() {
            return Err(Error::new(
                "invalid_jwks",
                "OpenAI signing keys could not be loaded.",
            ));
        }
        Ok(key.key.clone())
    }

    async fn verify_identity(
        &self,
        token: &str,
        client_id: &str,
        nonce: Option<&str>,
    ) -> Result<Identity> {
        if token.len() > 256 * 1024 {
            return Err(invalid_id_token());
        }
        let header = decode_header(token).map_err(|_| invalid_id_token())?;
        if header.alg != Algorithm::RS256 {
            return Err(invalid_id_token());
        }
        let kid = header
            .kid
            .as_deref()
            .filter(|kid| !kid.is_empty() && kid.len() <= 256)
            .ok_or_else(invalid_id_token)?;
        let discovery = self.get_discovery().await?;
        let key = self.signing_key(&discovery.jwks_uri, kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[client_id]);
        validation.set_required_spec_claims(&["iss", "aud", "sub", "exp", "iat"]);
        validation.leeway = 0;
        validation.validate_nbf = true;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| invalid_id_token())?
            .claims;
        let now = now_ms()? / 1000;
        let valid_audience = match &claims.aud {
            Audience::Single(audience) => audience == client_id,
            Audience::Multiple(audiences) => {
                !audiences.is_empty()
                    && audiences.iter().any(|aud| aud == client_id)
                    && (audiences.len() == 1 || claims.azp.as_deref() == Some(client_id))
            }
        };
        if claims.iss != ISSUER
            || claims.sub.trim().is_empty()
            || !valid_audience
            || claims.iat > now
            || claims.exp <= now
            || claims.exp <= claims.iat
            || claims.azp.as_deref().is_some_and(|azp| azp != client_id)
            || nonce.is_some_and(|nonce| claims.nonce.as_deref() != Some(nonce))
        {
            return Err(invalid_id_token());
        }
        Ok(Identity {
            issuer: ISSUER.to_owned(),
            subject: claims.sub,
            email: claims.email.as_str().map(str::to_owned),
            email_verified: claims.email_verified.as_bool(),
            name: claims.name.as_str().map(str::to_owned),
            picture: claims.picture.as_str().map(str::to_owned),
        })
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<Value> {
        let response = self
            .client
            .post(self.endpoints.token.clone())
            .form(form)
            .send()
            .await
            .map_err(request_error)?;
        let status = response.status();
        let parsed = read_json(
            response,
            "invalid_token_response",
            "OpenAI returned an invalid token response.",
        )
        .await;
        if status != StatusCode::OK {
            let code = parsed
                .as_ref()
                .ok()
                .and_then(|data| data.get("error"))
                .and_then(Value::as_str);
            // Only known machine-readable codes cross IPC. Error descriptions,
            // bodies, reqwest errors (which contain URLs), and unknown codes do not.
            let code = match code {
                Some("temporarily_unavailable") => "temporarily_unavailable",
                Some("server_error") => "server_error",
                _ if status.is_server_error() => "token_request_failed",
                Some("invalid_grant") => "invalid_grant",
                Some("invalid_refresh_token") => "invalid_refresh_token",
                Some("token_expired") => "token_expired",
                Some("refresh_token_expired") => "refresh_token_expired",
                Some("refresh_token_invalidated") => "refresh_token_invalidated",
                Some("refresh_token_reused") => "refresh_token_reused",
                Some("invalid_client") => "invalid_client",
                Some("invalid_request") => "invalid_request",
                Some("invalid_scope") => "invalid_scope",
                Some("unauthorized_client") => "unauthorized_client",
                Some("unsupported_grant_type") => "unsupported_grant_type",
                Some("access_denied") => "access_denied",
                _ => "token_request_failed",
            };
            return Err(Error::new(code, "The OpenAI token request failed."));
        }
        if form.contains(&("grant_type", "refresh_token")) {
            // A confirmed HTTP 200 can have rotated the token even if its body
            // is unreadable, oversized, or interrupted. Never retry the old one.
            // Non-200 failures above retain their pre-exchange classification.
            parsed.map_err(|_| invalid_refresh_response())
        } else {
            parsed
        }
    }

    fn parse_credentials(
        data: &Value,
        previous: Option<&Credentials>,
        received_at: u64,
    ) -> Result<Credentials> {
        let invalid = || {
            Error::new(
                "invalid_token_response",
                "OpenAI returned an incomplete token response.",
            )
        };
        let scope = data
            .get("scope")
            .and_then(Value::as_str)
            .filter(|scope| !scope.trim().is_empty())
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        let scopes: Vec<String> = scope
            .split_whitespace()
            .filter(|scope| seen.insert(*scope))
            .map(str::to_owned)
            .collect();
        let id_token = optional_token(data, "id_token")?;
        let refresh_token = optional_token(data, "refresh_token")?;
        let has_access_fields = ["access_token", "token_type", "expires_in"]
            .iter()
            .any(|name| data.get(name).is_some());
        let needs_access = previous.is_some()
            || has_access_fields
            || PLAN_SCOPES
                .iter()
                .all(|required| scopes.iter().any(|scope| scope == required));
        let (access_token, expires_at) = if needs_access {
            let access = optional_token(data, "access_token")?.ok_or_else(invalid)?;
            if !data
                .get("token_type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
            {
                return Err(invalid());
            }
            let duration = seconds_to_ms(data.get("expires_in").ok_or_else(invalid)?)
                .filter(|duration| *duration > 0)
                .ok_or_else(invalid)?;
            let expiry = received_at.checked_add(duration).ok_or_else(invalid)?;
            (Some(access), Some(expiry))
        } else {
            (None, None)
        };
        if (previous.is_some()
            || (access_token.is_some() && scopes.iter().any(|scope| scope == "offline_access")))
            && refresh_token.is_none()
        {
            return Err(invalid());
        }
        if previous
            .is_some_and(|previous| refresh_token.as_ref() == previous.refresh_token.as_ref())
        {
            return Err(invalid());
        }
        if previous.is_none() && id_token.is_none() {
            return Err(invalid_id_token());
        }
        let refresh_after = data
            .get("earliest_refresh_at")
            .map(|value| seconds_to_ms(value).ok_or_else(invalid))
            .transpose()?;
        Ok(Credentials {
            access_token,
            refresh_token,
            id_token: id_token
                .or_else(|| previous.and_then(|credentials| credentials.id_token.clone())),
            expires_at,
            refresh_after,
            scopes,
        })
    }
}

#[async_trait::async_trait]
impl Provider for OpenAI {
    fn authorization_url(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        prompt: bool,
    ) -> Result<Url> {
        validate_attempt(attempt, previous)?;
        let client_id = previous
            .map(|account| issued_client_id(Some(&account.account.client_id)))
            .transpose()?
            .unwrap_or(DYNAMIC_CLIENT);
        let mut url = Url::parse(AUTHORIZE).expect("fixed URL");
        let mut params = url.query_pairs_mut();
        params.extend_pairs([
            ("client_id", client_id),
            ("ext_agent_host_id", &attempt.host_id),
            ("response_type", "code"),
            ("redirect_uri", &attempt.redirect_uri),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", &attempt.state),
            ("nonce", &attempt.nonce),
            ("code_challenge", &attempt.challenge),
            ("code_challenge_method", "S256"),
        ]);
        match previous {
            None => {
                params.append_pair("agent_name_hint", &self.app_name);
            }
            Some(account) => {
                if let Some(credentials) = &account.credentials {
                    if let Some(token) = &credentials.id_token {
                        params.append_pair("id_token_hint", token);
                    }
                    if let Some(email) = &account.account.identity.email {
                        params.append_pair("login_hint", email);
                    }
                }
            }
        }
        if prompt {
            params.append_pair("prompt", "consent");
        }
        drop(params);
        Ok(url)
    }

    async fn exchange(
        &self,
        attempt: &Attempt,
        previous: Option<&StoredAccount>,
        callback: &Url,
    ) -> Result<Grant> {
        validate_attempt(attempt, previous)?;
        let (code, returned_client) = validate_callback(attempt, callback)?;
        let client_id = match previous {
            None => issued_client_id(returned_client.as_deref())?,
            Some(account) => {
                let selected = issued_client_id(Some(&account.account.client_id))?;
                if returned_client
                    .as_deref()
                    .is_some_and(|returned| returned != selected)
                {
                    return Err(Error::new(
                        "client_id_mismatch",
                        "The callback changed the selected ChatGPT registration.",
                    ));
                }
                selected
            }
        };
        let data = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", &code),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", &attempt.redirect_uri),
                ("resource", RESOURCE),
            ])
            .await?;
        let credentials = Self::parse_credentials(&data, None, now_ms()?)?;
        let identity = self
            .verify_identity(
                credentials
                    .id_token
                    .as_deref()
                    .ok_or_else(invalid_id_token)?,
                client_id,
                Some(&attempt.nonce),
            )
            .await?;
        if let Some(previous) = previous {
            validate_identity(&identity, &previous.account.identity)?;
        }
        Ok(Grant {
            client_id: client_id.to_owned(),
            identity,
            credentials,
        })
    }

    async fn exchange_refresh(&self, account: &StoredAccount) -> Result<RefreshExchange> {
        if account.pending_refresh.is_some() || account.revocation_refresh_token.is_some() {
            return Err(Error::new(
                "refresh_pending",
                "The pending refresh must be validated before renewing the session.",
            ));
        }
        let client_id = issued_client_id(Some(&account.account.client_id))?;
        let previous = account.credentials.as_ref().ok_or_else(reauth_required)?;
        let refresh = previous
            .refresh_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .ok_or_else(reauth_required)?;
        let data = self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", refresh),
                ("resource", RESOURCE),
            ])
            .await?;
        let candidate = now_ms().and_then(|received_at| {
            Self::parse_credentials(&data, Some(previous), received_at).map(|credentials| {
                RefreshCandidate {
                    client_id: client_id.to_owned(),
                    credentials,
                    received_at,
                    id_token_replaced: data.get("id_token").is_some(),
                }
            })
        });
        if let Ok(candidate) = candidate {
            if valid_refresh_candidate(account, &candidate) {
                return Ok(RefreshExchange::Candidate(candidate));
            }
        }
        // Do not normalize or persist any malformed access/identity fields.
        // Preserve only a literal, bounded new token from this HTTPS 200 body.
        let refresh_token = data
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|token| *token != refresh && valid_revocation_token(token))
            .map(str::to_owned);
        Ok(RefreshExchange::Rejected { refresh_token })
    }

    async fn validate_refresh(
        &self,
        account: &StoredAccount,
        candidate: &RefreshCandidate,
    ) -> Result<Grant> {
        if account
            .pending_refresh
            .as_ref()
            .is_some_and(|pending| pending.rejected)
        {
            return Err(reauth_required());
        }
        if !valid_refresh_candidate(account, candidate) {
            return Err(Error::new(
                "invalid_grant_response",
                "The provider returned an invalid credential set.",
            ));
        }
        let client_id = issued_client_id(Some(&candidate.client_id))?;
        let previous = account.credentials.as_ref().ok_or_else(reauth_required)?;
        let identity = if candidate.id_token_replaced {
            let token = candidate
                .credentials
                .id_token
                .as_deref()
                .ok_or_else(invalid_id_token)?;
            // Refresh is not a fresh browser attempt, so there is no new nonce
            // to require. Any replacement ID token still needs full verification.
            let identity = self.verify_identity(token, client_id, None).await?;
            // OIDC refresh may omit nonce. Compare it with the retained verified
            // token when both carry one; never require a new browser-attempt nonce.
            if let Some(nonce) = verified_token_nonce(token)? {
                let original = previous
                    .id_token
                    .as_deref()
                    .map(verified_token_nonce)
                    .transpose()?
                    .flatten();
                if original
                    .as_deref()
                    .is_some_and(|original| original != nonce)
                {
                    return Err(invalid_id_token());
                }
            }
            validate_identity(&identity, &account.account.identity)?;
            identity
        } else {
            account.account.identity.clone()
        };
        Ok(Grant {
            client_id: client_id.to_owned(),
            identity,
            credentials: candidate.credentials.clone(),
        })
    }

    async fn revoke(&self, account: &StoredAccount) -> Result<()> {
        let Some(refresh) = account.latest_refresh_token() else {
            return Ok(());
        };
        let failure = || {
            Error::new(
                "revocation_failed",
                "OpenAI session revocation was not confirmed.",
            )
        };
        let client_id =
            issued_client_id(Some(&account.account.client_id)).map_err(|_| failure())?;
        for attempt in 0..=2 {
            // Include transient discovery failures in the bounded retry budget.
            let result = match self.get_discovery().await {
                Ok(metadata) => self
                    .client
                    .post(metadata.revocation_endpoint)
                    .form(&[
                        ("token", refresh),
                        ("token_type_hint", "refresh_token"),
                        ("client_id", client_id),
                    ])
                    .send()
                    .await
                    .map_err(request_error)
                    .map(|response| response.status()),
                Err(error) => Err(error),
            };
            match result {
                Ok(StatusCode::OK) => return Ok(()),
                Ok(status) if status.is_server_error() && attempt < 2 => {}
                Err(error)
                    if ["network_error", "request_timeout", "discovery_failed"]
                        .contains(&error.code.as_str())
                        && attempt < 2 => {}
                _ => return Err(failure()),
            }
            tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))).await;
        }
        Err(failure())
    }
}

fn validate_attempt(attempt: &Attempt, previous: Option<&StoredAccount>) -> Result<()> {
    let redirect = validate_redirect(&attempt.redirect_uri)?;
    if let Some(previous) = previous {
        let saved = validate_redirect(&previous.redirect_uri)?;
        if redirect.scheme() != saved.scheme()
            || redirect.host_str() != saved.host_str()
            || redirect.path() != saved.path()
        {
            return Err(Error::new(
                "redirect_uri_changed",
                "A saved ChatGPT registration must reuse its callback path.",
            ));
        }
    }
    let host = attempt
        .host_id
        .strip_prefix("urn:uuid:")
        .filter(|host| host.len() == 36);
    if !host.is_some_and(|host| {
        uuid::Uuid::parse_str(host)
            .is_ok_and(|uuid| uuid.hyphenated().to_string().eq_ignore_ascii_case(host))
    }) {
        return Err(Error::new(
            "invalid_host_id",
            "ChatGPT connections require a persistent host identifier.",
        ));
    }
    if attempt.state.is_empty()
        || attempt.state.len() > 1024
        || attempt.nonce.is_empty()
        || attempt.nonce.len() > 1024
        || !(43..=128).contains(&attempt.verifier.len())
        || !attempt
            .verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
        || URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes())) != attempt.challenge
    {
        return Err(Error::new(
            "invalid_attempt",
            "The OAuth attempt is invalid.",
        ));
    }
    Ok(())
}

fn validate_redirect(value: &str) -> Result<Url> {
    let invalid = || {
        Error::new(
            "invalid_redirect_uri",
            "ChatGPT connections require an HTTP 127.0.0.1 loopback callback.",
        )
    };
    // URL parsers normalize alternative IPv4 spellings; reject them before parsing.
    let suffix = value.strip_prefix("http://127.0.0.1").ok_or_else(invalid)?;
    if value.len() > 4096
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        || (!suffix.is_empty() && !suffix.starts_with('/') && !suffix.starts_with(':'))
    {
        return Err(invalid());
    }
    if let Some(port) = suffix.strip_prefix(':') {
        let port = port.split('/').next().unwrap_or_default();
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err(invalid());
    }
    Ok(url)
}

fn validate_callback(attempt: &Attempt, callback: &Url) -> Result<(String, Option<String>)> {
    let invalid = || Error::new("invalid_callback", "The OAuth callback is invalid.");
    let expected = validate_redirect(&attempt.redirect_uri)?;
    let mut location = callback.clone();
    location.set_query(None);
    if location != expected || callback.as_str().len() > 16 * 1024 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let (mut state, mut code, mut client_id, mut oauth_error) = (None, None, None, None);
    for (key, value) in callback.query_pairs() {
        if !seen.insert(key.to_string()) || seen.len() > 32 {
            return Err(invalid());
        }
        match key.as_ref() {
            "state" => state = Some(value.into_owned()),
            "code" => code = Some(value.into_owned()),
            "client_id" => client_id = Some(value.into_owned()),
            "error" => oauth_error = Some(value.into_owned()),
            _ => {}
        }
    }
    if !state
        .as_deref()
        .is_some_and(|state| bool::from(state.as_bytes().ct_eq(attempt.state.as_bytes())))
    {
        return Err(Error::new(
            "state_mismatch",
            "The OAuth callback did not match the pending attempt.",
        ));
    }
    if let Some(error) = oauth_error {
        if code.is_some() {
            return Err(invalid());
        }
        return Err(match error.as_str() {
            "access_denied" => Error::new("access_denied", "ChatGPT authorization was declined."),
            _ => Error::new(
                "authorization_failed",
                "ChatGPT authorization could not be completed.",
            ),
        });
    }
    let code = code
        .filter(|code| !code.trim().is_empty() && code.len() <= 4096)
        .ok_or_else(invalid)?;
    Ok((code, client_id))
}

fn issued_client_id(value: Option<&str>) -> Result<&str> {
    value
        .filter(|value| {
            !value.is_empty()
                && *value != DYNAMIC_CLIENT
                && value.len() <= 1024
                && value.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or_else(|| {
            Error::new(
                "registration_incomplete",
                "The callback is missing its issued client ID.",
            )
        })
}

fn validate_identity(identity: &Identity, previous: &Identity) -> Result<()> {
    if identity.issuer != previous.issuer || identity.subject != previous.subject {
        return Err(Error::new(
            "identity_mismatch",
            "The returned identity does not match the selected ChatGPT account.",
        ));
    }
    Ok(())
}

fn optional_token(data: &Value, name: &str) -> Result<Option<String>> {
    data.get(name)
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    Error::new(
                        "invalid_token_response",
                        "OpenAI returned an incomplete token response.",
                    )
                })
        })
        .transpose()
}

fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    // Absent optional claims are allowed, but explicit null/non-string claims
    // must not bypass authorized-party or nonce validation.
    String::deserialize(deserializer).map(Some)
}

fn verified_token_nonce(token: &str) -> Result<Option<String>> {
    // Called only after signature verification or on the retained ID token from
    // a previously verified grant. Never use this to derive account identity.
    if token.len() > 256 * 1024 {
        return Err(invalid_id_token());
    }
    let encoded = token.split('.').nth(1).ok_or_else(invalid_id_token)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid_id_token())?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| invalid_id_token())?;
    claims
        .get("nonce")
        .map(|nonce| {
            nonce
                .as_str()
                .map(str::to_owned)
                .ok_or_else(invalid_id_token)
        })
        .transpose()
}

fn seconds_to_ms(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    let millis = seconds * 1000.0;
    if !seconds.is_finite() || seconds < 0.0 || !millis.is_finite() || millis >= u64::MAX as f64 {
        return None;
    }
    Some(millis as u64)
}

fn now_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| Error::new("invalid_clock", "The system clock is invalid."))
}

fn request_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::new("request_timeout", "The OpenAI request timed out.")
    } else {
        Error::new(
            "network_error",
            "The OpenAI request could not be completed.",
        )
    }
}

fn invalid_id_token() -> Error {
    Error::new(
        "invalid_id_token",
        "The OpenAI ID token could not be verified.",
    )
}
pub(crate) fn invalid_refresh_response() -> Error {
    Error::new(
        "invalid_refresh_response",
        "OpenAI returned an invalid refresh response. Sign in again.",
    )
}
fn reauth_required() -> Error {
    Error::new(
        "reauth_required",
        "Sign in to the ChatGPT connection again.",
    )
}

async fn read_json(mut response: Response, code: &str, message: &str) -> Result<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(Error::new(code, message));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(Error::new(code, message));
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| Error::new(code, message))?;
    if !data.is_object() {
        return Err(Error::new(code, message));
    }
    Ok(data)
}

#[cfg(test)]
#[path = "protocol/tests.rs"]
mod tests;
