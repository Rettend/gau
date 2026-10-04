use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

use super::*;
use crate::models::{Account, AccountStatus};

const CLIENT_ID: &str = "oaiapp_registration-1";
// Inert RSA keys generated only for local protocol tests, never real credentials.
const KEY: &[u8] = include_bytes!("fixtures/key.pem");
const OTHER_KEY: &[u8] = include_bytes!("fixtures/other-key.pem");

struct Request {
    method: String,
    path: String,
    form: BTreeMap<String, String>,
    form_encoded: bool,
}

struct Fixture {
    requests: Vec<Request>,
    claims: Value,
    omit_claims: Vec<&'static str>,
    wrong_signature: bool,
    kid: String,
    token_fields: Value,
    omit_token_fields: Vec<&'static str>,
    token_status: u16,
    refresh_fields: Value,
    omit_refresh_fields: Vec<&'static str>,
    refresh_claims: Option<Value>,
    refresh_status: u16,
    refresh_body: Option<String>,
    discovery_fields: Value,
    discovery_status: u16,
    jwks: Value,
    jwks_status: u16,
    revocation_statuses: VecDeque<u16>,
    response_delay: Duration,
}

impl Default for Fixture {
    fn default() -> Self {
        let keys: Value = serde_json::from_str(include_str!("fixtures/keys.json")).unwrap();
        Self {
            requests: Vec::new(),
            claims: json!({}),
            omit_claims: Vec::new(),
            wrong_signature: false,
            kid: "test-key".into(),
            token_fields: json!({}),
            omit_token_fields: Vec::new(),
            token_status: 200,
            refresh_fields: json!({}),
            omit_refresh_fields: Vec::new(),
            refresh_claims: None,
            refresh_status: 200,
            refresh_body: None,
            discovery_fields: json!({}),
            discovery_status: 200,
            jwks: json!({ "keys": [keys[0].clone()] }),
            jwks_status: 200,
            revocation_statuses: VecDeque::from([200]),
            response_delay: Duration::ZERO,
        }
    }
}

struct Server {
    base: Url,
    fixture: Arc<Mutex<Fixture>>,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let fixture = Arc::new(Mutex::new(Fixture::default()));
        let state = fixture.clone();
        let origin = base.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let state = state.clone();
                let origin = origin.clone();
                tokio::spawn(async move {
                    serve(stream, &origin, state).await;
                });
            }
        });
        Self {
            base,
            fixture,
            task,
        }
    }

    fn provider(&self) -> OpenAI {
        let mut provider = OpenAI::new("Actual Tool".into()).unwrap();
        // Never exposed outside cfg(test); ID-token issuer remains the official one.
        provider.client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        provider.endpoints = Endpoints {
            discovery: self.base.join("/.well-known/openid-configuration").unwrap(),
            token: self.base.join("/api/accounts/oauth/token").unwrap(),
        };
        provider
    }

    async fn request_count(&self, path: &str) -> usize {
        self.fixture
            .lock()
            .await
            .requests
            .iter()
            .filter(|request| request.path == path)
            .count()
    }
}

async fn serve(mut stream: TcpStream, base: &Url, fixture: Arc<Mutex<Fixture>>) {
    let mut input = Vec::new();
    let header_end = loop {
        let mut buffer = [0_u8; 4096];
        let count = stream.read(&mut buffer).await.unwrap();
        if count == 0 {
            return;
        }
        input.extend_from_slice(&buffer[..count]);
        if let Some(position) = input.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        assert!(input.len() < MAX_RESPONSE_BYTES);
    };
    let headers = String::from_utf8(input[..header_end].to_vec()).unwrap();
    let mut first_line = headers.lines().next().unwrap().split_whitespace();
    let method = first_line.next().unwrap().to_owned();
    let path = first_line.next().unwrap().to_owned();
    let length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| {
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while input.len() < header_end + length {
        let mut buffer = [0_u8; 4096];
        let count = stream.read(&mut buffer).await.unwrap();
        if count == 0 {
            return;
        }
        input.extend_from_slice(&buffer[..count]);
    }
    let form: BTreeMap<String, String> =
        url::form_urlencoded::parse(&input[header_end..header_end + length])
            .into_owned()
            .collect();
    let form_encoded = headers.lines().any(|line| {
        line.to_ascii_lowercase()
            .starts_with("content-type: application/x-www-form-urlencoded")
    });
    let mut state = fixture.lock().await;
    let (status, body) = match path.as_str() {
        "/.well-known/openid-configuration" => {
            let mut data = json!({
                "issuer": ISSUER,
                "jwks_uri": base.join("/keys").unwrap().as_str(),
                "revocation_endpoint": base.join("/discovered-revoke").unwrap().as_str(),
            });
            merge(&mut data, &state.discovery_fields);
            (state.discovery_status, data.to_string())
        }
        "/keys" => (state.jwks_status, state.jwks.to_string()),
        "/discovered-revoke" => {
            let status = if state.revocation_statuses.len() > 1 {
                state.revocation_statuses.pop_front().unwrap()
            } else {
                *state.revocation_statuses.front().unwrap_or(&200)
            };
            (status, String::new())
        }
        "/api/accounts/oauth/token" => {
            let is_refresh = form
                .get("grant_type")
                .is_some_and(|grant| grant == "refresh_token");
            let status = if is_refresh {
                state.refresh_status
            } else {
                state.token_status
            };
            let fields = if is_refresh {
                &state.refresh_fields
            } else {
                &state.token_fields
            };
            if let Some(body) = state.refresh_body.as_ref().filter(|_| is_refresh) {
                (status, body.clone())
            } else if status != 200 {
                (status, fields.to_string())
            } else {
                let mut data = json!({
                    "access_token": if is_refresh { "rotated-access-secret" } else { "access-secret" },
                    "refresh_token": if is_refresh { "rotated-refresh-secret" } else { "refresh-secret" },
                    "token_type": "Bearer", "expires_in": 3600, "scope": SCOPES,
                });
                if !is_refresh || state.refresh_claims.is_some() {
                    let claims = token_claims(
                        form.get("client_id").unwrap(),
                        if is_refresh {
                            state.refresh_claims.as_ref().unwrap()
                        } else {
                            &state.claims
                        },
                        &state.omit_claims,
                    );
                    data["id_token"] =
                        Value::String(sign(&claims, &state.kid, state.wrong_signature));
                }
                merge(&mut data, fields);
                for name in if is_refresh {
                    &state.omit_refresh_fields
                } else {
                    &state.omit_token_fields
                } {
                    data.as_object_mut().unwrap().remove(*name);
                }
                (status, data.to_string())
            }
        }
        _ => (404, "{}".into()),
    };
    state.requests.push(Request {
        method,
        path,
        form,
        form_encoded,
    });
    let delay = state.response_delay;
    drop(state);
    let location = if status == 302 {
        format!("Location: {}unexpected\r\n", base)
    } else {
        String::new()
    };
    let output = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n{body}", body.len());
    tokio::time::sleep(delay).await;
    let _ = stream.write_all(output.as_bytes()).await;
}

fn merge(target: &mut Value, fields: &Value) {
    for (key, value) in fields.as_object().unwrap() {
        target[key] = value.clone();
    }
}

fn token_claims(client: &str, overrides: &Value, omit: &[&str]) -> Value {
    let now = now_ms().unwrap() / 1000;
    let mut claims = json!({
        "iss": ISSUER, "aud": client, "sub": "verified-subject", "iat": now, "exp": now + 3600,
        "nonce": "pending-nonce", "email": "same@example.com", "email_verified": true, "name": "Test account",
    });
    merge(&mut claims, overrides);
    for name in omit {
        claims.as_object_mut().unwrap().remove(*name);
    }
    claims
}

fn sign(claims: &Value, kid: &str, wrong_signature: bool) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.to_owned());
    encode(
        &header,
        claims,
        &EncodingKey::from_rsa_pem(if wrong_signature { OTHER_KEY } else { KEY }).unwrap(),
    )
    .unwrap()
}

fn attempt() -> Attempt {
    let verifier = "abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDEFG".to_owned();
    Attempt {
        host_id: "urn:uuid:4c4f8dc2-2450-4d74-9bf6-510f0367c0a8".into(),
        state: "pending-state".into(),
        nonce: "pending-nonce".into(),
        challenge: URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        verifier,
        redirect_uri: "http://127.0.0.1:43210/auth/callback".into(),
    }
}

fn callback(attempt: &Attempt) -> Url {
    let mut callback = Url::parse(&attempt.redirect_uri).unwrap();
    callback.query_pairs_mut().extend_pairs([
        ("state", attempt.state.as_str()),
        ("code", "code-secret"),
        ("client_id", CLIENT_ID),
    ]);
    callback
}

fn saved(grant: Grant) -> StoredAccount {
    let now = now_ms().unwrap();
    StoredAccount {
        account: Account {
            id: "account-id".into(),
            client_id: grant.client_id,
            identity: grant.identity,
            scopes: grant.credentials.scopes.clone(),
            status: AccountStatus::Ready,
            created_at: now,
            updated_at: now,
        },
        redirect_uri: attempt().redirect_uri,
        revision: 1,
        credentials: Some(grant.credentials),
        pending_refresh: None,
        revocation_refresh_token: None,
    }
}

async fn signed_in(provider: &OpenAI) -> StoredAccount {
    let attempt = attempt();
    saved(
        provider
            .exchange(&attempt, None, &callback(&attempt))
            .await
            .unwrap(),
    )
}

// Provider-only tests inspect parsing and verification separately from the
// engine's durable transaction, exercised by the signed-JWT recovery tests below.
async fn refresh_grant(provider: &OpenAI, account: &StoredAccount) -> Result<Grant> {
    let candidate = match provider.exchange_refresh(account).await? {
        RefreshExchange::Candidate(candidate) => candidate,
        RefreshExchange::Rejected { .. } => return Err(invalid_refresh_response()),
    };
    provider.validate_refresh(account, &candidate).await
}

fn assert_error<T>(result: Result<T>, code: &str) {
    let error = match result {
        Ok(_) => panic!("expected a fixed protocol error"),
        Err(error) => error,
    };
    assert_eq!(error.code, code);
    let serialized = serde_json::to_string(&error).unwrap();
    assert!(!serialized.contains("secret"));
    assert!(!serialized.contains("attacker"));
}

#[tokio::test]
async fn authorization_and_code_exchange_use_official_public_client_parameters() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    let authorization = provider.authorization_url(&attempt, None, false).unwrap();
    let mut endpoint = authorization.clone();
    endpoint.set_query(None);
    assert_eq!(endpoint.as_str(), AUTHORIZE);
    let params: BTreeMap<_, _> = authorization.query_pairs().into_owned().collect();
    for (name, value) in [
        ("client_id", DYNAMIC_CLIENT),
        ("agent_name_hint", "Actual Tool"),
        ("ext_agent_host_id", &attempt.host_id),
        ("response_type", "code"),
        ("redirect_uri", &attempt.redirect_uri),
        ("scope", SCOPES),
        ("resource", RESOURCE),
        ("state", &attempt.state),
        ("nonce", &attempt.nonce),
        ("code_challenge", &attempt.challenge),
        ("code_challenge_method", "S256"),
    ] {
        assert_eq!(params.get(name).map(String::as_str), Some(value));
    }
    assert!(!params.contains_key("client_secret"));
    assert!(!params.contains_key("prompt"));
    let mut returned = callback(&attempt);
    returned.query_pairs_mut().append_pair("scope", "openid");
    let before = now_ms().unwrap();
    let grant = provider.exchange(&attempt, None, &returned).await.unwrap();
    assert_eq!(grant.client_id, CLIENT_ID);
    assert_eq!(grant.identity.issuer, ISSUER);
    assert_eq!(grant.identity.subject, "verified-subject");
    assert_eq!(grant.identity.email.as_deref(), Some("same@example.com"));
    assert_eq!(
        grant.credentials.scopes,
        SCOPES.split_whitespace().collect::<Vec<_>>()
    );
    assert_eq!(
        grant.credentials.access_token.as_deref(),
        Some("access-secret")
    );
    assert!(grant.credentials.expires_at.unwrap() >= before + 3_600_000);
    let fixture = server.fixture.lock().await;
    let request = fixture
        .requests
        .iter()
        .find(|request| request.path.ends_with("/token"))
        .unwrap();
    assert_eq!(request.method, "POST");
    assert!(request.form_encoded);
    for (name, value) in [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", "code-secret"),
        ("code_verifier", &attempt.verifier),
        ("redirect_uri", &attempt.redirect_uri),
        ("resource", RESOURCE),
    ] {
        assert_eq!(request.form.get(name).map(String::as_str), Some(value));
    }
    assert_eq!(request.form.len(), 6);
}

#[tokio::test]
async fn retained_client_reuses_registration_and_only_retained_credentials_supply_hints() {
    let server = Server::start().await;
    let provider = server.provider();
    let mut account = signed_in(&provider).await;
    let mut attempt = attempt();
    attempt.redirect_uri = "http://127.0.0.1:54321/auth/callback".into();
    let url = provider
        .authorization_url(&attempt, Some(&account), true)
        .unwrap();
    let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params.get("client_id").map(String::as_str), Some(CLIENT_ID));
    assert_eq!(params.get("prompt").map(String::as_str), Some("consent"));
    assert_eq!(
        params.get("id_token_hint"),
        account.credentials.as_ref().unwrap().id_token.as_ref()
    );
    assert_eq!(
        params.get("login_hint").map(String::as_str),
        Some("same@example.com")
    );
    assert!(!params.contains_key("agent_name_hint"));
    assert!(!params.contains_key("force_reconsent"));
    let mut callback = callback(&attempt);
    callback.set_query(Some("state=pending-state&code=code-secret"));
    assert_eq!(
        provider
            .exchange(&attempt, Some(&account), &callback)
            .await
            .unwrap()
            .client_id,
        CLIENT_ID
    );
    account.credentials = None;
    let params: BTreeMap<_, _> = provider
        .authorization_url(&attempt, Some(&account), false)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert!(!params.contains_key("id_token_hint"));
    assert!(!params.contains_key("login_hint"));
    assert!(!params.contains_key("agent_name_hint"));
}

#[tokio::test]
async fn rejects_bad_loopback_paths_hosts_and_pkce_before_network() {
    let server = Server::start().await;
    let provider = server.provider();
    for redirect in [
        "http://localhost:43210/auth/callback",
        "http://127.1:43210/auth/callback",
        "http://2130706433:43210/auth/callback",
        "http://[::1]:43210/auth/callback",
        "https://127.0.0.1:43210/auth/callback",
        "http://127.0.0.1:43210/auth/callback?x=1",
        "http://127.0.0.1:43210/auth/callback#hash",
        "http://127.0.0.1:0/auth/callback",
        "http://127.0.0.1:/auth/callback",
        "http://127.0.0.1:\t43210/auth/callback",
    ] {
        let mut attempt = attempt();
        attempt.redirect_uri = redirect.into();
        assert_error(
            provider.authorization_url(&attempt, None, false),
            "invalid_redirect_uri",
        );
    }
    let account = signed_in(&provider).await;
    let mut attempt = attempt();
    attempt.redirect_uri = "http://127.0.0.1:54321/callback".into();
    assert_error(
        provider.authorization_url(&attempt, Some(&account), false),
        "redirect_uri_changed",
    );
    attempt.redirect_uri = account.redirect_uri.clone();
    attempt.host_id = "unstable-host".into();
    assert_error(
        provider.authorization_url(&attempt, None, false),
        "invalid_host_id",
    );
    attempt.host_id = super::tests::attempt().host_id;
    attempt.challenge = "incorrect-challenge".into();
    assert_error(
        provider.authorization_url(&attempt, None, false),
        "invalid_attempt",
    );
    assert_eq!(server.request_count("/api/accounts/oauth/token").await, 1);
}

#[tokio::test]
async fn independently_validates_callback_location_state_errors_and_duplicate_parameters() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    for (query, code) in [
        (
            "code=code-secret&client_id=oaiapp_registration-1",
            "state_mismatch",
        ),
        (
            "state=wrong&code=code-secret&client_id=oaiapp_registration-1",
            "state_mismatch",
        ),
        (
            "state=pending-state&state=pending-state&code=code-secret",
            "invalid_callback",
        ),
        ("state=pending-state&code=one&code=two", "invalid_callback"),
        (
            "state=pending-state&code=code-secret&client_id=one&client_id=two",
            "invalid_callback",
        ),
        ("state=pending-state&error=access_denied", "access_denied"),
        ("state=wrong&error=access_denied", "state_mismatch"),
        (
            "state=pending-state&error=private_secret",
            "authorization_failed",
        ),
        (
            "state=pending-state&error=access_denied&code=code-secret",
            "invalid_callback",
        ),
        ("state=pending-state&code=", "invalid_callback"),
    ] {
        let mut callback = Url::parse(&attempt.redirect_uri).unwrap();
        callback.set_query(Some(query));
        assert_error(provider.exchange(&attempt, None, &callback).await, code);
    }
    for location in [
        "http://127.0.0.1:54321/auth/callback",
        "http://127.0.0.1:43210/callback",
        "http://localhost:43210/auth/callback",
        "https://127.0.0.1:43210/auth/callback",
        "http://127.0.0.1:43210/auth/callback#fragment",
    ] {
        let mut callback = Url::parse(location).unwrap();
        callback.set_query(Some(
            "state=pending-state&code=code-secret&client_id=oaiapp_registration-1",
        ));
        assert_error(
            provider.exchange(&attempt, None, &callback).await,
            "invalid_callback",
        );
    }
    assert!(server.fixture.lock().await.requests.is_empty());
}

#[tokio::test]
async fn requires_new_issued_client_and_rejects_replacement_client_or_subject() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    for client in [None, Some(DYNAMIC_CLIENT), Some(""), Some(" leading-space")] {
        let mut returned = Url::parse(&attempt.redirect_uri).unwrap();
        returned
            .query_pairs_mut()
            .extend_pairs([("state", "pending-state"), ("code", "code-secret")]);
        if let Some(client) = client {
            returned.query_pairs_mut().append_pair("client_id", client);
        }
        assert_error(
            provider.exchange(&attempt, None, &returned).await,
            "registration_incomplete",
        );
    }
    assert!(server.fixture.lock().await.requests.is_empty());
    let account = signed_in(&provider).await;
    let mut returned = callback(&attempt);
    returned.set_query(Some(
        "state=pending-state&code=code-secret&client_id=oaiapp_changed",
    ));
    assert_error(
        provider.exchange(&attempt, Some(&account), &returned).await,
        "client_id_mismatch",
    );
    assert_eq!(server.request_count("/api/accounts/oauth/token").await, 1);
    server.fixture.lock().await.claims = json!({"sub": "another-verified-subject"});
    assert_error(
        provider
            .exchange(&attempt, Some(&account), &callback(&attempt))
            .await,
        "identity_mismatch",
    );
}

#[tokio::test]
async fn verifies_signed_rsa_identity_claims_strictly() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    let now = now_ms().unwrap() / 1000;
    for claims in [
        json!({"iss": "https://attacker.example"}),
        json!({"aud": "another-client"}),
        json!({"nonce": "wrong-nonce"}),
        json!({"exp": now - 1}),
        json!({"exp": now, "iat": now}),
        json!({"iat": now + 1000}),
        json!({"iat": -1}),
        json!({"iat": 1.5}),
        json!({"sub": ""}),
        json!({"azp": "another-client"}),
        json!({"azp": null}),
        json!({"aud": [CLIENT_ID, "another-client"]}),
        json!({"aud": []}),
    ] {
        server.fixture.lock().await.claims = claims;
        assert_error(
            provider.exchange(&attempt, None, &callback(&attempt)).await,
            "invalid_id_token",
        );
    }
    server.fixture.lock().await.claims = json!({});
    for missing in ["iss", "aud", "sub", "exp", "iat", "nonce"] {
        server.fixture.lock().await.omit_claims = vec![missing];
        assert_error(
            provider.exchange(&attempt, None, &callback(&attempt)).await,
            "invalid_id_token",
        );
    }
    let mut fixture = server.fixture.lock().await;
    fixture.omit_claims.clear();
    fixture.wrong_signature = true;
    drop(fixture);
    assert_error(
        provider.exchange(&attempt, None, &callback(&attempt)).await,
        "invalid_id_token",
    );
    let mut fixture = server.fixture.lock().await;
    fixture.wrong_signature = false;
    fixture.claims = json!({"aud": [CLIENT_ID, "another-client"], "azp": CLIENT_ID});
    drop(fixture);
    assert_eq!(
        provider
            .exchange(&attempt, None, &callback(&attempt))
            .await
            .unwrap()
            .identity
            .subject,
        "verified-subject"
    );
}

#[tokio::test]
async fn rejects_unsigned_non_rs256_and_unknown_key_tokens_without_following_header_urls() {
    let server = Server::start().await;
    let provider = server.provider();
    let claims = token_claims(CLIENT_ID, &json!({}), &[]);
    let unsigned = format!(
        "{}.{}.",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none","kid":"test-key"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    assert_error(
        provider
            .verify_identity(&unsigned, CLIENT_ID, Some("pending-nonce"))
            .await,
        "invalid_id_token",
    );
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some("test-key".into());
    let hmac = encode(&header, &claims, &EncodingKey::from_secret(b"test-secret")).unwrap();
    assert_error(
        provider
            .verify_identity(&hmac, CLIENT_ID, Some("pending-nonce"))
            .await,
        "invalid_id_token",
    );
    assert!(server.fixture.lock().await.requests.is_empty());
    for index in 0..5 {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(format!("unknown-key-{index}"));
        header.jku = Some("https://attacker.example/keys".into());
        header.x5u = Some("https://attacker.example/certificate".into());
        let token = encode(&header, &claims, &EncodingKey::from_rsa_pem(KEY).unwrap()).unwrap();
        assert_error(
            provider
                .verify_identity(&token, CLIENT_ID, Some("pending-nonce"))
                .await,
            "signing_key_unavailable",
        );
    }
    assert_eq!(server.request_count("/keys").await, 1);
    assert_eq!(
        server
            .request_count("/.well-known/openid-configuration")
            .await,
        1
    );
}

#[tokio::test]
async fn caches_jwks_and_refreshes_unknown_kid_once_after_cooldown() {
    let server = Server::start().await;
    let provider = server.provider();
    signed_in(&provider).await;
    let keys: Value = serde_json::from_str(include_str!("fixtures/keys.json")).unwrap();
    server.fixture.lock().await.jwks = json!({"keys": [keys[1].clone()]});
    let token = sign(
        &token_claims(CLIENT_ID, &json!({}), &[]),
        "rotated-key",
        true,
    );
    assert_error(
        provider
            .verify_identity(&token, CLIENT_ID, Some("pending-nonce"))
            .await,
        "signing_key_unavailable",
    );
    assert_eq!(server.request_count("/keys").await, 1);
    provider
        .jwks
        .lock()
        .await
        .as_mut()
        .unwrap()
        .last_refresh_attempt = Instant::now() - JWKS_REFRESH_COOLDOWN;
    provider
        .verify_identity(&token, CLIENT_ID, Some("pending-nonce"))
        .await
        .unwrap();
    provider
        .verify_identity(&token, CLIENT_ID, Some("pending-nonce"))
        .await
        .unwrap();
    assert_eq!(server.request_count("/keys").await, 2);
    assert_eq!(
        server
            .request_count("/.well-known/openid-configuration")
            .await,
        1
    );
}

#[tokio::test]
async fn failed_unknown_kid_refresh_is_cooled_down_without_extending_cache_ttl() {
    let server = Server::start().await;
    let provider = server.provider();
    signed_in(&provider).await;
    let initial_fetch = provider.jwks.lock().await.as_ref().unwrap().fetched_at;
    provider
        .jwks
        .lock()
        .await
        .as_mut()
        .unwrap()
        .last_refresh_attempt = Instant::now() - JWKS_REFRESH_COOLDOWN;
    server.fixture.lock().await.jwks_status = 503;
    let token = sign(
        &token_claims(CLIENT_ID, &json!({}), &[]),
        "unknown-key",
        false,
    );
    assert_error(
        provider.verify_identity(&token, CLIENT_ID, None).await,
        "invalid_jwks",
    );
    assert_error(
        provider.verify_identity(&token, CLIENT_ID, None).await,
        "signing_key_unavailable",
    );
    assert_eq!(server.request_count("/keys").await, 2);
    assert_eq!(
        provider.jwks.lock().await.as_ref().unwrap().fetched_at,
        initial_fetch
    );
}

#[tokio::test]
async fn retains_verified_identity_only_grants_without_synthetic_access_credentials() {
    let server = Server::start().await;
    let provider = server.provider();
    {
        let mut fixture = server.fixture.lock().await;
        fixture.omit_token_fields =
            vec!["access_token", "token_type", "expires_in", "refresh_token"];
        fixture.token_fields = json!({"scope": "openid profile email openid"});
    }
    let account = signed_in(&provider).await;
    let credentials = account.credentials.as_ref().unwrap();
    assert_eq!(account.account.identity.subject, "verified-subject");
    assert!(credentials.access_token.is_none());
    assert!(credentials.refresh_token.is_none());
    assert!(credentials.expires_at.is_none());
    assert!(credentials.id_token.is_some());
    assert_eq!(credentials.scopes, ["openid", "profile", "email"]);
    let url = provider
        .authorization_url(&attempt(), Some(&account), true)
        .unwrap();
    assert!(url.query_pairs().any(|(key, value)| key == "id_token_hint"
        && Some(value.as_ref()) == credentials.id_token.as_deref()));
    server.fixture.lock().await.wrong_signature = true;
    let attempt = attempt();
    assert_error(
        provider.exchange(&attempt, None, &callback(&attempt)).await,
        "invalid_id_token",
    );
}

#[tokio::test]
async fn rejects_incomplete_full_grants_and_preserves_granted_scopes_without_plan_permissions() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    for missing in [
        "access_token",
        "token_type",
        "expires_in",
        "refresh_token",
        "scope",
    ] {
        server.fixture.lock().await.omit_token_fields = vec![missing];
        assert_error(
            provider.exchange(&attempt, None, &callback(&attempt)).await,
            "invalid_token_response",
        );
    }
    server.fixture.lock().await.omit_token_fields.clear();
    for fields in [
        json!({"access_token": ""}),
        json!({"refresh_token": null}),
        json!({"token_type": "MAC"}),
        json!({"expires_in": -1}),
        json!({"expires_in": 0}),
        json!({"expires_in": "3600"}),
        json!({"earliest_refresh_at": -1}),
        json!({"earliest_refresh_at": "soon"}),
        json!({"expires_in": 1e30}),
    ] {
        server.fixture.lock().await.token_fields = fields;
        assert_error(
            provider.exchange(&attempt, None, &callback(&attempt)).await,
            "invalid_token_response",
        );
    }
    for permission in PLAN_SCOPES {
        let scope = SCOPES
            .split_whitespace()
            .filter(|value| *value != permission)
            .collect::<Vec<_>>()
            .join(" ");
        server.fixture.lock().await.token_fields = json!({"scope": scope});
        let grant = provider
            .exchange(&attempt, None, &callback(&attempt))
            .await
            .unwrap();
        assert!(!grant
            .credentials
            .scopes
            .iter()
            .any(|scope| scope == permission));
        assert!(grant.credentials.access_token.is_some());
    }
}

#[tokio::test]
async fn refresh_rotates_credentials_uses_exact_resource_and_converts_timestamps_to_milliseconds() {
    let server = Server::start().await;
    let provider = server.provider();
    let account = signed_in(&provider).await;
    let old_id = account.credentials.as_ref().unwrap().id_token.clone();
    let earliest = now_ms().unwrap() / 1000 + 1800;
    server.fixture.lock().await.refresh_fields =
        json!({"earliest_refresh_at": earliest, "scope": "openid profile email offline_access"});
    let grant = refresh_grant(&provider, &account).await.unwrap();
    assert_eq!(
        grant.credentials.access_token.as_deref(),
        Some("rotated-access-secret")
    );
    assert_eq!(
        grant.credentials.refresh_token.as_deref(),
        Some("rotated-refresh-secret")
    );
    assert_eq!(grant.credentials.id_token, old_id);
    assert_eq!(grant.credentials.refresh_after, Some(earliest * 1000));
    assert_eq!(
        grant.credentials.scopes,
        ["openid", "profile", "email", "offline_access"]
    );
    let fixture = server.fixture.lock().await;
    let request = fixture
        .requests
        .iter()
        .find(|request| {
            request
                .form
                .get("grant_type")
                .is_some_and(|kind| kind == "refresh_token")
        })
        .unwrap();
    assert_eq!(request.method, "POST");
    assert!(request.form_encoded);
    for (name, value) in [
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", "refresh-secret"),
        ("resource", RESOURCE),
    ] {
        assert_eq!(request.form.get(name).map(String::as_str), Some(value));
    }
    assert_eq!(request.form.len(), 4);
}

#[tokio::test]
async fn refresh_requires_rotation_and_checks_any_replaced_identity_without_requiring_a_new_nonce()
{
    let server = Server::start().await;
    let provider = server.provider();
    let account = signed_in(&provider).await;
    for missing in [
        "access_token",
        "refresh_token",
        "token_type",
        "expires_in",
        "scope",
    ] {
        server.fixture.lock().await.omit_refresh_fields = vec![missing];
        assert_error(
            refresh_grant(&provider, &account).await,
            "invalid_refresh_response",
        );
    }
    server.fixture.lock().await.omit_refresh_fields.clear();
    server.fixture.lock().await.refresh_fields = json!({"refresh_token": "refresh-secret"});
    assert_error(
        refresh_grant(&provider, &account).await,
        "invalid_refresh_response",
    );
    server.fixture.lock().await.refresh_fields = json!({});
    for (claims, code) in [
        (json!({"sub": "different-subject"}), "identity_mismatch"),
        (json!({"aud": "different-client"}), "invalid_id_token"),
        (
            json!({"nonce": "different-original-nonce"}),
            "invalid_id_token",
        ),
        (
            json!({"iss": "https://attacker.example"}),
            "invalid_id_token",
        ),
    ] {
        server.fixture.lock().await.refresh_claims = Some(claims);
        assert_error(refresh_grant(&provider, &account).await, code);
    }
    let mut fixture = server.fixture.lock().await;
    fixture.refresh_claims = Some(json!({"name": "Updated account"}));
    drop(fixture);
    refresh_grant(&provider, &account).await.unwrap();
    let mut fixture = server.fixture.lock().await;
    fixture.omit_claims = vec!["nonce"];
    drop(fixture);
    let grant = refresh_grant(&provider, &account).await.unwrap();
    assert_eq!(grant.identity.name.as_deref(), Some("Updated account"));
    assert_ne!(
        grant.credentials.id_token,
        account.credentials.as_ref().unwrap().id_token
    );
    // A later refresh may include nonce again after the retained refreshed ID
    // token omitted it. This is still a refresh, not a fresh browser attempt.
    let mut continued = account.clone();
    continued.credentials = Some(grant.credentials);
    let mut fixture = server.fixture.lock().await;
    fixture.omit_claims.clear();
    fixture.refresh_fields = json!({"refresh_token": "next-rotated-refresh-secret"});
    drop(fixture);
    refresh_grant(&provider, &continued).await.unwrap();
    let mut no_session = account.clone();
    no_session.credentials = None;
    assert_error(
        refresh_grant(&provider, &no_session).await,
        "reauth_required",
    );
}

#[tokio::test]
async fn terminal_and_transient_token_errors_are_fixed_and_requests_are_not_retried() {
    let server = Server::start().await;
    let provider = server.provider();
    let account = signed_in(&provider).await;
    let before = serde_json::to_string(&account).unwrap();
    for (status, upstream, code) in [
        (400, "invalid_grant", "invalid_grant"),
        (400, "invalid_refresh_token", "invalid_refresh_token"),
        (400, "token_expired", "token_expired"),
        (400, "refresh_token_expired", "refresh_token_expired"),
        (
            400,
            "refresh_token_invalidated",
            "refresh_token_invalidated",
        ),
        (400, "refresh_token_reused", "refresh_token_reused"),
        (400, "invalid_client", "invalid_client"),
        (503, "temporarily_unavailable", "temporarily_unavailable"),
        (503, "invalid_grant", "token_request_failed"),
        (400, "private_secret", "token_request_failed"),
    ] {
        let count = server.request_count("/api/accounts/oauth/token").await;
        let mut fixture = server.fixture.lock().await;
        fixture.refresh_status = status;
        fixture.refresh_fields =
            json!({"error": upstream, "error_description": "Do not leak refresh-secret"});
        drop(fixture);
        assert_error(refresh_grant(&provider, &account).await, code);
        assert_eq!(
            server.request_count("/api/accounts/oauth/token").await,
            count + 1
        );
        assert_eq!(serde_json::to_string(&account).unwrap(), before);
    }
    let mut fixture = server.fixture.lock().await;
    fixture.token_status = 400;
    fixture.token_fields =
        json!({"error": "invalid_grant", "error_description": "Do not leak code-secret"});
    drop(fixture);
    let count = server.request_count("/api/accounts/oauth/token").await;
    let attempt = attempt();
    assert_error(
        provider
            .exchange(&attempt, Some(&account), &callback(&attempt))
            .await,
        "invalid_grant",
    );
    assert_eq!(
        server.request_count("/api/accounts/oauth/token").await,
        count + 1
    );
}

#[tokio::test]
async fn revocation_uses_discovered_endpoint_refresh_token_and_bounded_retries() {
    let server = Server::start().await;
    let provider = server.provider();
    let account = signed_in(&provider).await;
    server.fixture.lock().await.revocation_statuses = VecDeque::from([503, 200]);
    provider.revoke(&account).await.unwrap();
    assert_eq!(server.request_count("/discovered-revoke").await, 2);
    {
        let fixture = server.fixture.lock().await;
        let request = fixture
            .requests
            .iter()
            .find(|request| request.path == "/discovered-revoke")
            .unwrap();
        assert_eq!(request.method, "POST");
        assert!(request.form_encoded);
        for (name, value) in [
            ("token", "refresh-secret"),
            ("token_type_hint", "refresh_token"),
            ("client_id", CLIENT_ID),
        ] {
            assert_eq!(request.form.get(name).map(String::as_str), Some(value));
        }
        assert_eq!(request.form.len(), 3);
    }
    server.fixture.lock().await.revocation_statuses = VecDeque::from([503]);
    assert_error(provider.revoke(&account).await, "revocation_failed");
    assert_eq!(server.request_count("/discovered-revoke").await, 5);
    server.fixture.lock().await.revocation_statuses = VecDeque::from([400]);
    assert_error(provider.revoke(&account).await, "revocation_failed");
    assert_eq!(server.request_count("/discovered-revoke").await, 6);
    let mut identity_only = account;
    identity_only.credentials.as_mut().unwrap().refresh_token = None;
    provider.revoke(&identity_only).await.unwrap();
    assert_eq!(server.request_count("/discovered-revoke").await, 6);
}

#[tokio::test]
async fn rejects_untrusted_discovery_and_does_not_poison_the_cache_after_failure() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    for fields in [
        json!({"issuer": "https://attacker.example"}),
        json!({"jwks_uri": "https://attacker.example/keys"}),
        json!({"revocation_endpoint": "https://attacker.example/revoke"}),
        json!({"jwks_uri": "file:///keys"}),
        json!({"jwks_uri": format!("{}keys#fragment", server.base)}),
        json!({"jwks_uri": format!("http://user@127.0.0.1:{}/keys", server.base.port().unwrap())}),
    ] {
        server.fixture.lock().await.discovery_fields = fields;
        assert_error(
            provider.exchange(&attempt, None, &callback(&attempt)).await,
            "invalid_discovery",
        );
        assert!(provider.discovery.lock().await.is_none());
    }
    assert_eq!(server.request_count("/keys").await, 0);
    server.fixture.lock().await.discovery_fields = json!({});
    signed_in(&provider).await;
    signed_in(&provider).await;
    assert_eq!(server.request_count("/keys").await, 1);
    let fetched_at = provider.discovery.lock().await.as_ref().unwrap().fetched_at;
    // Move the comparison clock forward, not the timestamp before Windows boot.
    let expires_at = fetched_at + DISCOVERY_TTL;
    let requests = server
        .request_count("/.well-known/openid-configuration")
        .await;
    provider
        .get_discovery_with_clock(|| expires_at - Duration::from_nanos(1))
        .await
        .unwrap();
    assert_eq!(
        server
            .request_count("/.well-known/openid-configuration")
            .await,
        requests
    );
    server.fixture.lock().await.discovery_status = 503;
    assert_error(
        provider.get_discovery_with_clock(|| expires_at).await,
        "discovery_failed",
    );
    assert_eq!(
        provider.discovery.lock().await.as_ref().unwrap().fetched_at,
        fetched_at
    );
    server.fixture.lock().await.discovery_status = 200;
    provider
        .get_discovery_with_clock(|| expires_at)
        .await
        .unwrap();
    assert_eq!(
        provider.discovery.lock().await.as_ref().unwrap().fetched_at,
        expires_at
    );
    provider
        .get_discovery_with_clock(|| expires_at)
        .await
        .unwrap();
    assert_eq!(
        server
            .request_count("/.well-known/openid-configuration")
            .await,
        requests + 2
    );
}

#[tokio::test]
async fn network_errors_are_sanitized_and_http_redirects_are_not_followed() {
    let server = Server::start().await;
    let provider = server.provider();
    let attempt = attempt();
    server.fixture.lock().await.token_status = 302;
    assert_error(
        provider.exchange(&attempt, None, &callback(&attempt)).await,
        "token_request_failed",
    );
    assert_eq!(server.fixture.lock().await.requests.len(), 1);
    server.task.abort();
    assert_error(
        provider.exchange(&attempt, None, &callback(&attempt)).await,
        "network_error",
    );
    let error = OpenAI::new(" ".into());
    assert_error(error, "invalid_configuration");
}

#[tokio::test]
async fn bounds_request_duration_and_response_size_without_provider_diagnostics() {
    let server = Server::start().await;
    let mut provider = server.provider();
    provider.client = Client::builder()
        .timeout(Duration::from_millis(50))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    server.fixture.lock().await.response_delay = Duration::from_millis(200);
    let attempt = attempt();
    assert_error(
        provider.exchange(&attempt, None, &callback(&attempt)).await,
        "request_timeout",
    );
    let provider = server.provider();
    let mut fixture = server.fixture.lock().await;
    fixture.response_delay = Duration::ZERO;
    fixture.token_fields = json!({"scope": "x".repeat(MAX_RESPONSE_BYTES)});
    drop(fixture);
    assert_error(
        provider.exchange(&attempt, None, &callback(&attempt)).await,
        "invalid_token_response",
    );
}

#[path = "refresh_tests.rs"]
mod refresh_tests;
