//! A one-shot, IPv4 loopback-only OAuth callback listener.
use std::{net::Ipv4Addr, time::Duration};

use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::{timeout, timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::{Error, Result};

const PATH: &str = "/auth/callback";
const MAX_HEADERS: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ACCEPTED: &str = "<!doctype html><meta charset=\"utf-8\"><title>Return to the app</title><p>You can return to the app and close this window.</p>";
const REJECTED: &str = "<!doctype html><meta charset=\"utf-8\"><title>Invalid request</title><p>This sign-in request could not be accepted.</p>";

pub(crate) struct Loopback {
    redirect_uri: Url,
    stop: CancellationToken,
    task: Option<JoinHandle<Result<Url>>>,
}

impl Loopback {
    pub(crate) async fn bind(
        state: String,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<Self> {
        if state.is_empty() || state.len() > 8192 {
            return Err(Error::new(
                "invalid_configuration",
                "The callback state is invalid.",
            ));
        }
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| listener_error())?;
        let address = listener.local_addr().map_err(|_| listener_error())?;
        let redirect_uri = Url::parse(&format!("http://127.0.0.1:{}{PATH}", address.port()))
            .map_err(|_| listener_error())?;
        let stop = cancel.child_token();
        let task_stop = stop.clone();
        let redirect = redirect_uri.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = task_stop.cancelled() => Err(Error::cancelled()),
                result = timeout_at(deadline, serve(listener, redirect, state)) => {
                    result.unwrap_or_else(|_| Err(timeout_error()))
                }
            }
        });
        Ok(Self {
            redirect_uri,
            stop,
            task: Some(task),
        })
    }

    pub(crate) fn redirect_uri(&self) -> &str {
        self.redirect_uri.as_str()
    }

    pub(crate) async fn callback(&mut self) -> Result<Url> {
        let task = self.task.as_mut().ok_or_else(listener_error)?;
        let result = task.await.map_err(|_| listener_error())?;
        self.task.take();
        result
    }

    pub(crate) async fn close(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            // Abort also interrupts a pending accept, read, or response write.
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn serve(listener: TcpListener, redirect: Url, state: String) -> Result<Url> {
    loop {
        let (mut stream, remote) = listener.accept().await.map_err(|_| listener_error())?;
        if !remote.ip().is_loopback() {
            continue;
        }
        let outcome = timeout(REQUEST_TIMEOUT, request(&mut stream, &redirect, &state)).await;
        if let Ok(Ok(Some(result))) = outcome {
            return result;
        }
        // Malformed and wrong-state probes must not consume the attempt.
    }
}

async fn request(
    stream: &mut TcpStream,
    redirect: &Url,
    state: &str,
) -> Result<Option<Result<Url>>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0; 1024];
    let end = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end;
        }
        if bytes.len() >= MAX_HEADERS {
            respond(stream, 431, REJECTED).await;
            return Ok(None);
        }
        let available = chunk.len().min(MAX_HEADERS - bytes.len());
        let count = stream
            .read(&mut chunk[..available])
            .await
            .map_err(|_| listener_error())?;
        if count == 0 {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let text = match std::str::from_utf8(&bytes[..end]) {
        Ok(text) if text.is_ascii() => text,
        _ => {
            respond(stream, 400, REJECTED).await;
            return Ok(None);
        }
    };
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let parts: Vec<_> = first.split(' ').collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        respond(stream, 400, REJECTED).await;
        return Ok(None);
    }
    let mut hosts = Vec::new();
    let mut malformed = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            malformed = true;
            break;
        };
        if name.is_empty() || !name.bytes().all(header_name_byte) || line.starts_with([' ', '\t']) {
            malformed = true;
            break;
        }
        let value = value.trim_matches([' ', '\t']);
        if value
            .bytes()
            .any(|byte| byte < 32 && byte != b'\t' || byte == 127)
        {
            malformed = true;
            break;
        }
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value);
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-length") && value != "0"
        {
            malformed = true;
            break;
        }
    }
    let expected_host = format!("127.0.0.1:{}", redirect.port().ok_or_else(listener_error)?);
    let target = parts[1];
    if malformed
        || hosts.len() != 1
        || hosts[0] != expected_host
        || !target.starts_with('/')
        || target.starts_with("//")
        || target.contains(['\\', '#'])
        || target.bytes().any(|byte| byte <= 32 || byte == 127)
        || target.split('?').next() != Some(PATH)
    {
        respond(stream, 404, REJECTED).await;
        return Ok(None);
    }
    if parts[0] != "GET" {
        respond(stream, 405, REJECTED).await;
        return Ok(None);
    }
    let callback = match redirect.join(target) {
        Ok(url) if url.origin() == redirect.origin() && url.path() == PATH => url,
        _ => {
            respond(stream, 400, REJECTED).await;
            return Ok(None);
        }
    };
    let pairs: Vec<_> = callback.query_pairs().into_owned().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    if states.len() != 1 || !bool::from(states[0].1.as_bytes().ct_eq(state.as_bytes())) {
        respond(stream, 400, REJECTED).await;
        return Ok(None);
    }
    // Once an authentic state is supplied, the attempt is consumed, including
    // OAuth errors. No attacker-controlled text is used in HTML or error output.
    for name in ["code", "state", "error", "client_id"] {
        if pairs.iter().filter(|(key, _)| key == name).count() > 1 {
            respond(stream, 400, REJECTED).await;
            return Ok(Some(Err(callback_error())));
        }
    }
    let code = pairs
        .iter()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.as_str());
    let error = pairs
        .iter()
        .find(|(key, _)| key == "error")
        .map(|(_, value)| value.as_str());
    let authentic_error = code.is_none() && error.is_some_and(|value| !value.is_empty());
    let result = match (code, error) {
        (None, Some("access_denied")) => {
            Err(Error::new("access_denied", "Authorization was declined."))
        }
        (None, Some(value)) if !value.is_empty() => {
            Err(Error::new("authorization_failed", "Authorization failed."))
        }
        (Some(value), None) if !value.is_empty() => Ok(callback),
        _ => Err(callback_error()),
    };
    respond(
        stream,
        if result.is_ok() || authentic_error {
            200
        } else {
            400
        },
        if result.is_ok() || authentic_error {
            ACCEPTED
        } else {
            REJECTED
        },
    )
    .await;
    Ok(Some(result))
}

fn header_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let allow = if status == 405 { "Allow: GET\r\n" } else { "" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n{allow}\r\n{body}", body.len());
    // A client that will not read cannot keep an authentic callback alive.
    let _ = timeout(
        Duration::from_secs(1),
        stream.write_all(response.as_bytes()),
    )
    .await;
    let _ = stream.shutdown().await;
}

fn listener_error() -> Error {
    Error::new(
        "listener_unavailable",
        "The sign-in callback listener is unavailable.",
    )
}
fn callback_error() -> Error {
    Error::new("invalid_callback", "The sign-in callback is invalid.")
}
pub(crate) fn timeout_error() -> Error {
    Error::new(
        "authorization_timeout",
        "Sign-in timed out. Start a new attempt.",
    )
}

#[cfg(test)]
#[path = "loopback/tests.rs"]
mod tests;
