use super::*;

async fn listener() -> Loopback {
    Loopback::bind(
        "expected-state".into(),
        CancellationToken::new(),
        Instant::now() + Duration::from_secs(5),
    )
    .await
    .unwrap()
}

async fn http(redirect: &str, method: &str, path: &str, host: &str, extra_headers: &str) -> String {
    let url = Url::parse(redirect).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", url.port().unwrap()))
        .await
        .unwrap();
    stream
        .write_all(
            format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{extra_headers}\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8(bytes).unwrap()
}

fn host(redirect: &str) -> String {
    Url::parse(redirect).unwrap().authority().into()
}

#[tokio::test]
async fn wrong_state_error_probes_do_not_consume_a_valid_one_shot_attempt() {
    let mut listener = listener().await;
    let redirect = listener.redirect_uri().to_string();
    assert!(redirect.starts_with("http://127.0.0.1:"));
    let expected_host = host(&redirect);
    for path in [
        "/auth/callback?state=wrong&code=secret",
        "/auth/callback?state=wrong&error=access_denied",
        "/auth/callback?state=expected-state&state=expected-state&code=secret",
    ] {
        let response = http(&redirect, "GET", path, &expected_host, "").await;
        assert!(response.starts_with("HTTP/1.1 400"));
        assert!(!response.contains("secret"));
    }
    let response = http(
        &redirect,
        "GET",
        "/auth/callback?state=expected-state&code=one-use&client_id=registered",
        &expected_host,
        "",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("Cache-Control: no-store"));
    assert!(response.contains("Referrer-Policy: no-referrer"));
    assert!(!response.contains("one-use"));
    assert_eq!(
        listener
            .callback()
            .await
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "code")
            .unwrap()
            .1,
        "one-use"
    );
    assert!(
        TcpStream::connect(("127.0.0.1", Url::parse(&redirect).unwrap().port().unwrap()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn method_raw_path_and_exact_host_are_enforced_without_consuming() {
    let mut listener = listener().await;
    let redirect = listener.redirect_uri().to_string();
    let expected_host = host(&redirect);
    let cases = [
        (
            "POST",
            "/auth/callback?state=expected-state&code=x",
            expected_host.as_str(),
            "",
            405,
        ),
        (
            "GET",
            "/other?state=expected-state&code=x",
            expected_host.as_str(),
            "",
            404,
        ),
        (
            "GET",
            "/auth/../auth/callback?state=expected-state&code=x",
            expected_host.as_str(),
            "",
            404,
        ),
        (
            "GET",
            "/auth/%63allback?state=expected-state&code=x",
            expected_host.as_str(),
            "",
            404,
        ),
        (
            "GET",
            "/auth/callback?state=expected-state&code=x",
            "localhost",
            "",
            404,
        ),
        (
            "GET",
            "/auth/callback?state=expected-state&code=x",
            expected_host.as_str(),
            "Host: evil.example\r\n",
            404,
        ),
        (
            "GET",
            "/auth/callback?state=expected-state&code=x",
            expected_host.as_str(),
            "Transfer-Encoding: chunked\r\n",
            404,
        ),
    ];
    for (method, path, host, headers, status) in cases {
        assert!(http(&redirect, method, path, host, headers)
            .await
            .starts_with(&format!("HTTP/1.1 {status}")));
    }
    http(
        &redirect,
        "GET",
        "/auth/callback?state=expected-state&code=x",
        &expected_host,
        "",
    )
    .await;
    assert!(listener.callback().await.is_ok());
}

#[tokio::test]
async fn authenticated_errors_and_duplicate_parameters_are_consumed_without_reflection() {
    for (query, expected) in [
        ("error=access_denied", "access_denied"),
        ("error=secret-remote-body", "authorization_failed"),
        ("code=a&code=b", "invalid_callback"),
        ("code=a&error=access_denied", "invalid_callback"),
        ("error=one&error=two", "invalid_callback"),
        ("code=a&client_id=x&client_id=y", "invalid_callback"),
        ("", "invalid_callback"),
    ] {
        let mut listener = listener().await;
        let redirect = listener.redirect_uri().to_string();
        let response = http(
            &redirect,
            "GET",
            &format!("/auth/callback?state=expected-state&{query}"),
            &host(&redirect),
            "",
        )
        .await;
        assert!(!response.contains("secret-remote-body"));
        let error = listener.callback().await.unwrap_err();
        assert_eq!(error.code, expected);
        assert!(!error.message.contains("secret-remote-body"));
    }
}

#[tokio::test]
async fn cancellation_drops_listener_and_an_unfinished_http_socket() {
    let cancel = CancellationToken::new();
    let mut listener = Loopback::bind(
        "expected-state".into(),
        cancel.clone(),
        Instant::now() + Duration::from_secs(5),
    )
    .await
    .unwrap();
    let redirect = Url::parse(listener.redirect_uri()).unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap()))
        .await
        .unwrap();
    socket
        .write_all(b"GET /auth/callback HTTP/1.1\r\nHost:")
        .await
        .unwrap();
    cancel.cancel();
    assert_eq!(listener.callback().await.unwrap_err().code, "cancelled");
    let mut bytes = [0; 1];
    let result = timeout(Duration::from_secs(1), socket.read(&mut bytes))
        .await
        .unwrap();
    assert!(matches!(result, Ok(0) | Err(_)));
    assert!(TcpStream::connect(("127.0.0.1", redirect.port().unwrap()))
        .await
        .is_err());
}

#[tokio::test]
async fn timeout_and_explicit_close_join_the_task_and_release_the_port() {
    let mut listener = Loopback::bind(
        "state".into(),
        CancellationToken::new(),
        Instant::now() + Duration::from_millis(25),
    )
    .await
    .unwrap();
    let address = Url::parse(listener.redirect_uri()).unwrap();
    assert_eq!(
        listener.callback().await.unwrap_err().code,
        "authorization_timeout"
    );
    assert!(TcpStream::connect(("127.0.0.1", address.port().unwrap()))
        .await
        .is_err());
    let mut listener = self::listener().await;
    let address = Url::parse(listener.redirect_uri()).unwrap();
    listener.close().await;
    assert!(listener.task.is_none());
    assert!(TcpStream::connect(("127.0.0.1", address.port().unwrap()))
        .await
        .is_err());
}

#[tokio::test]
async fn dropping_listener_aborts_the_owned_task() {
    let listener = listener().await;
    let address = Url::parse(listener.redirect_uri()).unwrap();
    drop(listener);
    tokio::task::yield_now().await;
    assert!(TcpStream::connect(("127.0.0.1", address.port().unwrap()))
        .await
        .is_err());
}
