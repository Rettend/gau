use std::{future::Future, time::Duration};

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION},
    redirect::Policy,
    Client, Method,
};
use serde::{Deserialize, Serialize};
use url::Url;
use zeroize::Zeroizing;

use crate::{commands::Operation, Error, Result};

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 128;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FetchRequest {
    pub(crate) url: String,
    pub(crate) method: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum FetchEvent {
    Response {
        status: u16,
        #[serde(rename = "statusText")]
        status_text: String,
        headers: Vec<(String, String)>,
        url: String,
    },
    Chunk {
        sequence: u64,
        data: Vec<u8>,
    },
    End,
}

struct ValidatedRequest {
    url: Url,
    method: Method,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
}

pub(crate) struct Transport {
    client: Client,
    header_timeout: Duration,
    idle_timeout: Duration,
}

impl Transport {
    pub(crate) fn new() -> Result<Self> {
        Ok(Self {
            client: build_client(true)?,
            header_timeout: HEADER_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
        })
    }

    pub(crate) async fn fetch<C, F, S>(
        &self,
        request: FetchRequest,
        operation: &Operation,
        credentials: C,
        send: S,
    ) -> Result<()>
    where
        C: FnOnce() -> F,
        F: Future<Output = Result<String>>,
        S: FnMut(FetchEvent) -> Result<()>,
    {
        // Neither the credential callback nor the network is touched until the
        // complete destination, method, headers and body have been validated.
        let request = validate(request)?;
        self.fetch_validated(request, operation, credentials, send)
            .await
    }

    async fn fetch_validated<C, F, S>(
        &self,
        mut request: ValidatedRequest,
        operation: &Operation,
        credentials: C,
        mut send: S,
    ) -> Result<()>
    where
        C: FnOnce() -> F,
        F: Future<Output = Result<String>>,
        S: FnMut(FetchEvent) -> Result<()>,
    {
        check_cancelled(operation)?;
        // Refresh-token rotation is a critical section: do not select against
        // cancellation here. The engine must finish persisting a rotated token
        // even when the webview cancels or closes while it is refreshing.
        let access_token = credentials().await.map(Zeroizing::new);
        check_cancelled(operation)?;
        let access_token = access_token?;
        let bearer = Zeroizing::new(format!("Bearer {}", access_token.as_str()));
        let mut authorization = HeaderValue::from_str(&bearer)
            .map_err(|_| Error::new("invalidCredential", "The native access token is invalid."))?;
        authorization.set_sensitive(true);
        request.headers.insert(AUTHORIZATION, authorization);
        drop(bearer);
        drop(access_token);

        let mut outgoing = self
            .client
            .request(request.method, request.url)
            .headers(request.headers);
        if let Some(body) = request.body {
            outgoing = outgoing.body(body);
        }
        let response = tokio::select! {
            biased;
            _ = operation.cancel.cancelled() => return Err(Error::cancelled()),
            result = tokio::time::timeout(self.header_timeout, outgoing.send()) => {
                result.map_err(|_| timed_out())?.map_err(|_| network_error())?
            }
        };
        check_cancelled(operation)?;
        let status = response.status();
        let event = FetchEvent::Response {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").into(),
            headers: response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    // Match browser fetch's cookie boundary; never expose native
                    // cookies or authentication headers through the response.
                    if matches!(
                        name.as_str(),
                        "set-cookie" | "authorization" | "proxy-authorization"
                    ) {
                        None
                    } else {
                        value
                            .to_str()
                            .ok()
                            .map(|value| (name.as_str().into(), value.into()))
                    }
                })
                .collect(),
            url: response.url().to_string(),
        };
        send_event(operation, &mut send, event)?;

        // HTTP failures are ordinary responses, including their streamed body.
        // The SDK, not this transport, decides how to handle a 4xx or 5xx.
        let mut stream = response.bytes_stream();
        let mut sequence = 1_u64;
        loop {
            let next = tokio::select! {
                biased;
                _ = operation.cancel.cancelled() => return Err(Error::cancelled()),
                result = tokio::time::timeout(self.idle_timeout, stream.next()) => {
                    result.map_err(|_| timed_out())?
                }
            };
            let Some(bytes) = next else { break };
            let bytes = bytes.map_err(|_| network_error())?;
            // Hold at most one upstream frame and one bounded IPC chunk. Never
            // collect the response or read another frame before its final ACK.
            for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
                check_cancelled(operation)?;
                let acknowledgement = operation.arm_ack(sequence)?;
                send_event(
                    operation,
                    &mut send,
                    FetchEvent::Chunk {
                        sequence,
                        data: chunk.to_vec(),
                    },
                )?;
                tokio::select! {
                    biased;
                    _ = operation.cancel.cancelled() => return Err(Error::cancelled()),
                    result = tokio::time::timeout(self.idle_timeout, acknowledgement) => {
                        result.map_err(|_| timed_out())?.map_err(|_| Error::new("channelClosed", "The response stream was closed."))?;
                    }
                }
                sequence = sequence.checked_add(1).ok_or_else(network_error)?;
            }
        }
        check_cancelled(operation)?;
        send_event(operation, &mut send, FetchEvent::End)
    }
}

#[cfg(test)]
impl Transport {
    pub(crate) fn for_test() -> Self {
        Self {
            client: build_client(false).unwrap(),
            header_timeout: Duration::from_secs(2),
            idle_timeout: Duration::from_secs(2),
        }
    }

    // A crate-private, test-only seam: validate the public URL first, then use
    // a local mock. No custom authenticated origin is available in production.
    pub(crate) async fn fetch_from_test_endpoint<C, F, S>(
        &self,
        request: FetchRequest,
        endpoint: Url,
        operation: &Operation,
        credentials: C,
        send: S,
    ) -> Result<()>
    where
        C: FnOnce() -> F,
        F: Future<Output = Result<String>>,
        S: FnMut(FetchEvent) -> Result<()>,
    {
        let mut request = validate(request)?;
        request.url = endpoint;
        self.fetch_validated(request, operation, credentials, send)
            .await
    }
}

fn build_client(https_only: bool) -> Result<Client> {
    Client::builder()
        .https_only(https_only)
        .no_proxy()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(HEADER_TIMEOUT)
        // No total request timeout: a successful SSE stream can run for hours.
        .build()
        .map_err(|_| {
            Error::new(
                "transportUnavailable",
                "Could not initialize the native HTTP transport.",
            )
        })
}

fn validate(request: FetchRequest) -> Result<ValidatedRequest> {
    if request.url.len() > 8192
        || request
            .url
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\\')
    {
        return Err(invalid_request());
    }
    let authority = request
        .url
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""));
    let url = Url::parse(&request.url).map_err(|_| invalid_request())?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.openai.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || authority.is_none_or(|authority| authority.contains('@'))
    {
        return Err(invalid_request());
    }
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| invalid_request())?;
    let path_allowed = match method {
        Method::POST => url.path() == "/v1/responses",
        Method::GET => {
            url.path() == "/v1/models"
                || url.path().strip_prefix("/v1/models/").is_some_and(|id| {
                    !id.is_empty()
                        && id.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric()
                                || matches!(byte, b'-' | b'_' | b'.' | b':')
                        })
                })
        }
        _ => false,
    };
    if !path_allowed
        || request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_BODY_BYTES || method == Method::GET)
    {
        return Err(invalid_request());
    }
    if request.headers.len() > MAX_HEADERS
        || request
            .headers
            .iter()
            .try_fold(0_usize, |bytes, (name, value)| {
                bytes.checked_add(name.len())?.checked_add(value.len())
            })
            .is_none_or(|bytes| bytes > MAX_HEADER_BYTES)
    {
        return Err(invalid_request());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid_request())?;
        if matches!(
            name.as_str(),
            "content-type" | "accept" | "openai-beta" | "user-agent"
        ) || name.as_str().starts_with("x-stainless-")
        {
            let value = HeaderValue::from_str(&value).map_err(|_| invalid_request())?;
            headers.append(name, value);
        }
        // Everything else is stripped, including dummy SDK Authorization,
        // Cookie, Host, proxy headers, OpenAI-Organization and OpenAI-Project.
    }
    Ok(ValidatedRequest {
        url,
        method,
        headers,
        body: request.body,
    })
}

fn send_event(
    operation: &Operation,
    send: &mut impl FnMut(FetchEvent) -> Result<()>,
    event: FetchEvent,
) -> Result<()> {
    if let Err(error) = send(event) {
        operation.cancel();
        return Err(error);
    }
    Ok(())
}

fn check_cancelled(operation: &Operation) -> Result<()> {
    if operation.cancel.is_cancelled() {
        Err(Error::cancelled())
    } else {
        Ok(())
    }
}

fn invalid_request() -> Error {
    Error::new(
        "invalidRequest",
        "Only supported HTTPS OpenAI API requests are allowed.",
    )
}

fn network_error() -> Error {
    Error::new("networkError", "The native OpenAI request failed.")
}

fn timed_out() -> Error {
    Error::new("timeout", "The native OpenAI request or stream timed out.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{mpsc, oneshot},
        task::JoinHandle,
    };

    fn request(url: &str, method: &str) -> FetchRequest {
        FetchRequest {
            url: url.into(),
            method: method.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    fn responses_request() -> FetchRequest {
        let mut request = request("https://api.openai.com/v1/responses", "POST");
        request.body = Some(br#"{"model":"gpt-test","input":"hello"}"#.to_vec());
        request
    }

    fn test_transport() -> Transport {
        Transport::for_test()
    }

    // This seam exists only in unit tests. It still validates the public URL
    // first, and cannot add a custom authenticated host to the plugin API.
    async fn local_fetch<C, F, S>(
        transport: &Transport,
        request: FetchRequest,
        endpoint: Url,
        operation: &Operation,
        credentials: C,
        send: S,
    ) -> Result<()>
    where
        C: FnOnce() -> F,
        F: Future<Output = Result<String>>,
        S: FnMut(FetchEvent) -> Result<()>,
    {
        transport
            .fetch_from_test_endpoint(request, endpoint, operation, credentials, send)
            .await
    }

    async fn read_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let count = stream.read(&mut chunk).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let content_length = String::from_utf8_lossy(&bytes[..header_end])
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        while bytes.len() - header_end < content_length {
            let count = stream.read(&mut chunk).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(bytes).unwrap()
    }

    async fn server(status: &str, headers: &str, body: Vec<u8>) -> (Url, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(&body);
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            // Cancellation can close the peer while this write is pending.
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
            request
        });
        (endpoint, task)
    }

    #[test]
    fn destination_boundary_accepts_only_supported_openai_routes() {
        for (url, method) in [
            ("https://api.openai.com/v1/models", "GET"),
            ("https://api.openai.com:443/v1/models", "GET"),
            ("https://api.openai.com/v1/models/gpt-4.1", "GET"),
            ("https://api.openai.com/v1/responses", "POST"),
        ] {
            assert!(validate(request(url, method)).is_ok(), "{url} {method}");
        }
        for (url, method) in [
            ("http://api.openai.com/v1/models", "GET"),
            ("https://example.com/v1/responses", "POST"),
            ("https://api.openai.com.example.com/v1/models", "GET"),
            ("https://api.openai.com./v1/models", "GET"),
            ("https://api.openai.com:444/v1/models", "GET"),
            ("https://user:pass@api.openai.com/v1/models", "GET"),
            ("https://@api.openai.com/v1/models", "GET"),
            ("https://api.openai.com/v1/models#fragment", "GET"),
            ("file:///v1/models", "GET"),
            ("https://api.openai.com/v1/chat/completions", "POST"),
            ("https://api.openai.com/v1/responses", "GET"),
            ("https://api.openai.com/v1/models", "POST"),
            ("https://api.openai.com/v1/models/one/more", "GET"),
            ("https://api.openai.com/v1/models/id%2fmore", "GET"),
            ("https://api.openai.com/v1/responses/", "POST"),
            ("https://api.openai.com/v1/models", "DELETE"),
            ("https://api.openai.com\\v1\\models", "GET"),
            ("https://api.openai.com/v1/\nmodels", "GET"),
        ] {
            assert!(validate(request(url, method)).is_err(), "{url} {method}");
        }
    }

    #[test]
    fn only_sdk_headers_survive_and_body_and_headers_are_bounded() {
        let mut input = responses_request();
        input.headers = [
            ("Authorization", "Bearer dummy"),
            ("Cookie", "session=secret"),
            ("Host", "evil.example"),
            ("Proxy-Authorization", "Basic secret"),
            ("Proxy-Connection", "keep-alive"),
            ("OpenAI-Organization", "org-evil"),
            ("OpenAI-Project", "proj-evil"),
            ("Content-Length", "999"),
            ("Content-Type", "application/json"),
            ("Accept", "text/event-stream"),
            ("OpenAI-Beta", "responses=v1"),
            ("User-Agent", "OpenAI/JS"),
            ("X-Stainless-Lang", "js"),
            ("x-stainless-retry-count", "0"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        let validated = validate(input).unwrap();
        assert_eq!(validated.headers.len(), 6);
        assert_eq!(validated.headers["content-type"], "application/json");
        assert_eq!(validated.headers["x-stainless-lang"], "js");
        assert!(!validated.headers.contains_key(AUTHORIZATION));
        let mut input = responses_request();
        input
            .headers
            .push(("accept".into(), "ok\r\nx-header: injected".into()));
        assert!(validate(input).is_err());
        let mut input = responses_request();
        input
            .headers
            .push(("accept".into(), "a".repeat(MAX_HEADER_BYTES)));
        assert!(validate(input).is_err());
        let mut input = responses_request();
        input.headers = vec![("accept".into(), "ok".into()); MAX_HEADERS + 1];
        assert!(validate(input).is_err());
        let mut input = responses_request();
        input.body = Some(vec![0; MAX_BODY_BYTES + 1]);
        assert!(validate(input).is_err());
        let mut input = request("https://api.openai.com/v1/models", "GET");
        input.body = Some(Vec::new());
        assert!(validate(input).is_err());
    }

    #[tokio::test]
    async fn invalid_destinations_never_retrieve_credentials() {
        let calls = AtomicUsize::new(0);
        let operation = Operation::default();
        let result = test_transport()
            .fetch(
                request("https://evil.example/v1/responses", "POST"),
                &operation,
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok("native-secret".into())
                },
                |_| panic!("an invalid request must not emit events"),
            )
            .await;
        assert!(matches!(result, Err(error) if error.code == "invalidRequest"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn http_errors_are_streamed_and_native_authorization_replaces_dummy_headers() {
        let body = br#"{"error":{"message":"ordinary API error"}}"#.to_vec();
        let (endpoint, server) = server("401 Unauthorized", "Content-Type: application/json\r\nX-Request-Id: req-test\r\nSet-Cookie: hidden=native\r\n", body.clone()).await;
        let transport = test_transport();
        let operation = Operation::default();
        let mut input = responses_request();
        input.headers = vec![
            ("Authorization".into(), "Bearer dummy".into()),
            ("Cookie".into(), "secret=hidden".into()),
            ("OpenAI-Project".into(), "wrong-project".into()),
        ];
        let mut events = Vec::new();
        local_fetch(
            &transport,
            input,
            endpoint,
            &operation,
            || async { Ok("native-secret".into()) },
            |event| {
                if let FetchEvent::Chunk { sequence, .. } = &event {
                    operation.acknowledge(*sequence)?;
                }
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(&events[0], FetchEvent::Response { status: 401, status_text, headers, .. }
            if status_text == "Unauthorized" && headers.iter().any(|(name, value)| name == "x-request-id" && value == "req-test") && !headers.iter().any(|(name, _)| name == "set-cookie"))
        );
        let chunks = events
            .iter()
            .filter_map(|event| match event {
                FetchEvent::Chunk { data, .. } => Some(data.as_slice()),
                _ => None,
            })
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(chunks, body);
        assert!(matches!(events.last(), Some(FetchEvent::End)));
        let sent = server.await.unwrap().to_ascii_lowercase();
        assert!(sent.contains("authorization: bearer native-secret\r\n"));
        assert!(!sent.contains("dummy"));
        assert!(!sent.contains("cookie:"));
        assert!(!sent.contains("openai-project:"));
    }

    #[tokio::test]
    async fn chunks_are_bounded_and_wait_for_matching_ack_before_advancing() {
        let body = vec![b'x'; MAX_CHUNK_BYTES * 3 + 7];
        let (endpoint, server) = server(
            "200 OK",
            "Content-Type: text/event-stream\r\n",
            body.clone(),
        )
        .await;
        let transport = test_transport();
        let operation = Arc::new(Operation::default());
        let worker_operation = operation.clone();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            local_fetch(
                &transport,
                responses_request(),
                endpoint,
                &worker_operation,
                || async { Ok("native-secret".into()) },
                |event| {
                    sender.send(event).unwrap();
                    Ok(())
                },
            )
            .await
        });
        assert!(matches!(
            receiver.recv().await,
            Some(FetchEvent::Response { status: 200, .. })
        ));
        let first = receiver.recv().await.unwrap();
        let mut received = Vec::new();
        match first {
            FetchEvent::Chunk { sequence, data } => {
                assert_eq!(sequence, 1);
                assert!(data.len() <= MAX_CHUNK_BYTES);
                received.extend(data);
            }
            _ => panic!("expected first chunk"),
        }
        assert!(operation.acknowledge(2).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(40), receiver.recv())
                .await
                .is_err()
        );
        operation.acknowledge(1).unwrap();
        let mut expected_sequence = 2;
        loop {
            match receiver.recv().await.unwrap() {
                FetchEvent::Chunk { sequence, data } => {
                    assert_eq!(sequence, expected_sequence);
                    assert!(!data.is_empty() && data.len() <= MAX_CHUNK_BYTES);
                    received.extend(data);
                    operation.acknowledge(sequence).unwrap();
                    expected_sequence += 1;
                }
                FetchEvent::End => break,
                _ => panic!("unexpected response event"),
            }
        }
        worker.await.unwrap().unwrap();
        server.await.unwrap();
        assert_eq!(received, body);
    }

    #[tokio::test]
    async fn cancellation_during_refresh_waits_for_credential_persistence() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let transport = test_transport();
        let operation = Arc::new(Operation::default());
        let worker_operation = operation.clone();
        let persisted = Arc::new(AtomicBool::new(false));
        let worker_persisted = persisted.clone();
        let (started, started_receiver) = oneshot::channel();
        let (finish, finish_receiver) = oneshot::channel();
        let worker = tokio::spawn(async move {
            local_fetch(
                &transport,
                responses_request(),
                endpoint,
                &worker_operation,
                || async move {
                    started.send(()).unwrap();
                    finish_receiver.await.unwrap();
                    worker_persisted.store(true, Ordering::SeqCst);
                    Ok("rotated-native-secret".into())
                },
                |_| panic!("a cancelled refresh must not send a request"),
            )
            .await
        });
        started_receiver.await.unwrap();
        operation.cancel();
        assert!(!worker.is_finished());
        assert!(!persisted.load(Ordering::SeqCst));
        finish.send(()).unwrap();
        let result = worker.await.unwrap();
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        assert!(persisted.load(Ordering::SeqCst));
        assert!(
            tokio::time::timeout(Duration::from_millis(40), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancelling_an_unacknowledged_chunk_is_immediate() {
        let (endpoint, server) = server("200 OK", "", vec![b'x'; MAX_CHUNK_BYTES * 2]).await;
        let transport = test_transport();
        let operation = Arc::new(Operation::default());
        let worker_operation = operation.clone();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            local_fetch(
                &transport,
                responses_request(),
                endpoint,
                &worker_operation,
                || async { Ok("native-secret".into()) },
                |event| {
                    sender.send(event).unwrap();
                    Ok(())
                },
            )
            .await
        });
        receiver.recv().await.unwrap();
        assert!(matches!(
            receiver.recv().await,
            Some(FetchEvent::Chunk { sequence: 1, .. })
        ));
        operation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        assert!(receiver.recv().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn missing_ack_times_out_instead_of_buffering_more_data() {
        let (endpoint, server) = server("200 OK", "", vec![b'x'; MAX_CHUNK_BYTES * 2]).await;
        let mut transport = test_transport();
        transport.idle_timeout = Duration::from_millis(100);
        let operation = Operation::default();
        let mut chunks = 0;
        let result = local_fetch(
            &transport,
            responses_request(),
            endpoint,
            &operation,
            || async { Ok("native-secret".into()) },
            |event| {
                if matches!(event, FetchEvent::Chunk { .. }) {
                    chunks += 1;
                }
                Ok(())
            },
        )
        .await;
        assert!(matches!(result, Err(error) if error.code == "timeout"));
        assert_eq!(chunks, 1);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn channel_failure_cancels_the_operation() {
        let (endpoint, server) = server("200 OK", "", vec![b'x'; 10]).await;
        let operation = Operation::default();
        let result = local_fetch(
            &test_transport(),
            responses_request(),
            endpoint,
            &operation,
            || async { Ok("native-secret".into()) },
            |_| {
                Err(Error::new(
                    "channelClosed",
                    "The response stream was closed.",
                ))
            },
        )
        .await;
        assert!(matches!(result, Err(error) if error.code == "channelClosed"));
        assert!(operation.cancel.is_cancelled());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn redirects_are_returned_without_following_them() {
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!(
            "Location: http://{}/redirected\r\n",
            destination.local_addr().unwrap()
        );
        let (endpoint, server) = server("307 Temporary Redirect", &location, Vec::new()).await;
        let mut statuses = Vec::new();
        local_fetch(
            &test_transport(),
            responses_request(),
            endpoint,
            &Operation::default(),
            || async { Ok("native-secret".into()) },
            |event| {
                if let FetchEvent::Response { status, .. } = event {
                    statuses.push(status);
                }
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(statuses, [307]);
        assert!(
            tokio::time::timeout(Duration::from_millis(40), destination.accept())
                .await
                .is_err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn header_and_body_idle_timeouts_do_not_become_a_total_stream_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            stream.write_all(b"a").await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            stream.write_all(b"b").await.unwrap();
        });
        let mut transport = test_transport();
        transport.header_timeout = Duration::from_millis(300);
        transport.idle_timeout = Duration::from_secs(1);
        let operation = Operation::default();
        let mut received = Vec::new();
        local_fetch(
            &transport,
            responses_request(),
            endpoint,
            &operation,
            || async { Ok("native-secret".into()) },
            |event| {
                if let FetchEvent::Chunk { sequence, data } = event {
                    received.extend(data);
                    operation.acknowledge(sequence)?;
                }
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(received, b"ab");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_headers_and_body_reads_have_idle_deadlines() {
        for send_headers in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = Url::parse(&format!(
                "http://{}/v1/responses",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let (stop, stopped) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_request(&mut stream).await;
                if send_headers {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                        .await
                        .unwrap();
                }
                stopped.await.unwrap();
            });
            let mut transport = test_transport();
            transport.header_timeout = Duration::from_millis(200);
            transport.idle_timeout = Duration::from_millis(100);
            let mut response_seen = false;
            let result = local_fetch(
                &transport,
                responses_request(),
                endpoint,
                &Operation::default(),
                || async { Ok("native-secret".into()) },
                |event| {
                    response_seen |= matches!(event, FetchEvent::Response { .. });
                    Ok(())
                },
            )
            .await;
            assert!(matches!(result, Err(error) if error.code == "timeout"));
            assert_eq!(response_seen, send_headers);
            stop.send(()).unwrap();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_the_network_header_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (started, started_receiver) = oneshot::channel();
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            started.send(()).unwrap();
            stopped.await.unwrap();
        });
        let transport = test_transport();
        let operation = Arc::new(Operation::default());
        let worker_operation = operation.clone();
        let worker = tokio::spawn(async move {
            local_fetch(
                &transport,
                responses_request(),
                endpoint,
                &worker_operation,
                || async { Ok("native-secret".into()) },
                |_| panic!("a stalled response must not emit events"),
            )
            .await
        });
        started_receiver.await.unwrap();
        operation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        stop.send(()).unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn post_connection_failure_is_not_retried_or_exposed_verbatim() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            drop(stream);
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_ok()
        });
        let result = local_fetch(
            &test_transport(),
            responses_request(),
            endpoint,
            &Operation::default(),
            || async { Ok("native-secret".into()) },
            |_| panic!("a broken connection must not emit events"),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "networkError");
        assert_eq!(error.message, "The native OpenAI request failed.");
        assert!(!server.await.unwrap());
    }

    #[test]
    fn event_json_matches_the_ipc_contract() {
        let response = serde_json::to_value(FetchEvent::Response {
            status: 200,
            status_text: "OK".into(),
            headers: vec![("content-type".into(), "application/json".into())],
            url: "https://api.openai.com/v1/responses".into(),
        })
        .unwrap();
        assert_eq!(response["type"], "response");
        assert_eq!(response["statusText"], "OK");
        assert!(response.get("status_text").is_none());
        assert_eq!(
            serde_json::to_value(FetchEvent::Chunk {
                sequence: 1,
                data: vec![0, 255]
            })
            .unwrap(),
            serde_json::json!({ "type": "chunk", "sequence": 1, "data": [0, 255] })
        );
        assert_eq!(
            serde_json::to_value(FetchEvent::End).unwrap(),
            serde_json::json!({ "type": "end" })
        );
    }
}
