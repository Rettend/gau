use std::{
    process::{Command, Stdio},
    sync::atomic::Ordering,
};

use super::test_keys::{directory, TestKeys};
use super::*;
use crate::models::{Account, Identity, PendingRefresh, StoredAccount};

fn state() -> ConnectionState {
    ConnectionState {
        version: 1,
        host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
        accounts: vec![StoredAccount {
            account: Account {
                id: uuid::Uuid::new_v4().to_string(),
                client_id: "registration-secret".into(),
                identity: Identity {
                    issuer: "https://auth.openai.com".into(),
                    subject: "subject-secret".into(),
                    email: Some("private@example.com".into()),
                    email_verified: Some(true),
                    name: None,
                    picture: None,
                },
                scopes: vec!["resource.invoke".into(), "chatgpt.tokens.use.direct".into()],
                status: AccountStatus::Ready,
                created_at: 1000,
                updated_at: 1000,
            },
            redirect_uri: "http://127.0.0.1:12345/auth/callback".into(),
            revision: 1,
            credentials: Some(Credentials {
                access_token: Some("access-secret".into()),
                refresh_token: Some("refresh-secret".into()),
                id_token: Some("id-secret".into()),
                expires_at: Some(5000),
                refresh_after: None,
                scopes: vec!["resource.invoke".into(), "chatgpt.tokens.use.direct".into()],
            }),
            pending_refresh: None,
            revocation_refresh_token: None,
        }],
    }
}

fn setup() -> (tempfile::TempDir, Store, Arc<TestKeys>) {
    let directory = directory();
    let keys = Arc::new(TestKeys::default());
    let store = Store::with_keys(
        directory.path().to_path_buf(),
        "dev.test.app".into(),
        keys.clone(),
    )
    .unwrap();
    (directory, store, keys)
}

fn pending_state() -> ConnectionState {
    let mut state = state();
    let mut credentials = state.accounts[0].credentials.clone().unwrap();
    credentials.access_token = Some("pending-access-secret".into());
    credentials.refresh_token = Some("pending-refresh-secret".into());
    credentials.id_token = Some("pending-id-secret".into());
    credentials.expires_at = Some(6000);
    state.accounts[0].revision += 1;
    state.accounts[0].pending_refresh = Some(PendingRefresh {
        candidate: RefreshCandidate {
            client_id: state.accounts[0].account.client_id.clone(),
            credentials,
            received_at: 2000,
            id_token_replaced: true,
        },
        rejected: false,
    });
    state
}

#[tokio::test]
async fn initialization_is_lazy_and_empty_reads_do_not_prompt() {
    let (directory, store, keys) = setup();
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(store
        .lock(None)
        .await
        .unwrap()
        .read()
        .await
        .unwrap()
        .is_none());
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 0);
    assert!(directory.path().join(LOCK_FILE).is_file());
}

#[tokio::test]
async fn encrypted_atomic_roundtrip_uses_fresh_nonces_and_no_plaintext_secrets() {
    let (directory, store, keys) = setup();
    let locked = store.lock(None).await.unwrap();
    let initial = state();
    locked.write(&initial).await.unwrap();
    let first = fs::read(directory.path().join(STATE_FILE)).unwrap();
    let text = std::str::from_utf8(&first).unwrap();
    for secret in [
        "access-secret",
        "refresh-secret",
        "id-secret",
        "subject-secret",
        "private@example.com",
        &initial.host_id,
    ] {
        assert!(!text.contains(secret));
    }
    let restored = locked.read().await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&restored).unwrap(),
        serde_json::to_value(&initial).unwrap()
    );
    locked.write(&initial).await.unwrap();
    let second = fs::read(directory.path().join(STATE_FILE)).unwrap();
    assert_ne!(first, second);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 1);
    assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".gau-")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(directory.path().join(STATE_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.path().join(LOCK_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn pending_rotation_roundtrips_encrypted_and_retains_the_old_verified_record() {
    let (directory, store, keys) = setup();
    let locked = store.lock(None).await.unwrap();
    let initial = pending_state();
    locked.write(&initial).await.unwrap();
    let bytes = fs::read(directory.path().join(STATE_FILE)).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    for secret in [
        "access-secret",
        "refresh-secret",
        "id-secret",
        "pending-access-secret",
        "pending-refresh-secret",
        "pending-id-secret",
        "pendingRefresh",
    ] {
        assert!(!text.contains(secret));
    }
    drop(locked);
    let reopened =
        Store::with_keys(directory.path().to_path_buf(), "dev.test.app".into(), keys).unwrap();
    let restored = reopened
        .lock(None)
        .await
        .unwrap()
        .read()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(initial).unwrap()
    );
}

#[tokio::test]
async fn version_one_records_without_pending_refresh_remain_readable() {
    let (_directory, store, _) = setup();
    let original = state();
    let value = serde_json::to_value(&original).unwrap();
    assert!(value["accounts"][0].get("pendingRefresh").is_none());
    assert!(value["accounts"][0].get("revocationRefreshToken").is_none());
    let restored: ConnectionState = serde_json::from_value(value).unwrap();
    assert!(restored.accounts[0].pending_refresh.is_none());
    let locked = store.lock(None).await.unwrap();
    locked.write(&restored).await.unwrap();
    assert!(locked.read().await.unwrap().unwrap().accounts[0]
        .pending_refresh
        .is_none());
}

#[tokio::test]
async fn revocation_only_token_cannot_coexist_with_active_or_pending_credentials() {
    let (_directory, store, _) = setup();
    let locked = store.lock(None).await.unwrap();
    let mut initial = state();
    initial.accounts[0].credentials = None;
    initial.accounts[0].account.scopes.clear();
    initial.accounts[0].account.status = AccountStatus::ReauthRequired;
    initial.accounts[0].revocation_refresh_token = Some("replacement-refresh-secret".into());
    locked.write(&initial).await.unwrap();
    let restored = locked.read().await.unwrap().unwrap();
    assert_eq!(
        restored.accounts[0].latest_refresh_token(),
        Some("replacement-refresh-secret")
    );
    for inconsistent in [
        "active",
        "pending",
        "signed-out",
        "scopes",
        "empty-token",
        "whitespace-token",
    ] {
        let mut invalid = initial.clone();
        let account = &mut invalid.accounts[0];
        match inconsistent {
            "active" => account.credentials = state().accounts[0].credentials.clone(),
            "pending" => {
                account.pending_refresh = pending_state().accounts[0].pending_refresh.clone()
            }
            "signed-out" => account.account.status = AccountStatus::SignedOut,
            "scopes" => account.account.scopes.push("resource.invoke".into()),
            "empty-token" => account.revocation_refresh_token = Some(String::new()),
            _ => account.revocation_refresh_token = Some(" token ".into()),
        }
        assert_eq!(
            locked.write(&invalid).await.err().unwrap().code,
            "invalid_store"
        );
    }
}

#[tokio::test]
async fn pending_candidate_binding_credentials_timestamps_and_rejection_state_are_strict() {
    let (directory, store, keys) = setup();
    let locked = store.lock(None).await.unwrap();
    let initial = pending_state();
    locked.write(&initial).await.unwrap();
    let original = fs::read(directory.path().join(STATE_FILE)).unwrap();
    for field in [
        "client",
        "received",
        "expiry",
        "access",
        "refresh",
        "spent-refresh",
        "scope",
        "duplicate-scope",
        "id",
        "unchanged-id",
        "previous",
        "rejected",
    ] {
        let mut invalid = pending_state();
        let pending = invalid.accounts[0].pending_refresh.as_mut().unwrap();
        match field {
            "client" => pending.candidate.client_id = "different-registration".into(),
            "received" => pending.candidate.received_at = 0,
            "expiry" => {
                pending.candidate.credentials.expires_at = Some(pending.candidate.received_at)
            }
            "access" => {
                pending.candidate.credentials.access_token = None;
                pending.candidate.credentials.expires_at = None;
            }
            "refresh" => pending.candidate.credentials.refresh_token = None,
            "spent-refresh" => {
                pending.candidate.credentials.refresh_token = Some("refresh-secret".into())
            }
            "scope" => pending.candidate.credentials.scopes = vec!["invalid scope".into()],
            "duplicate-scope" => pending
                .candidate
                .credentials
                .scopes
                .push("resource.invoke".into()),
            "id" => pending.candidate.credentials.id_token = None,
            "unchanged-id" => pending.candidate.id_token_replaced = false,
            "previous" => invalid.accounts[0].credentials = None,
            _ => pending.rejected = true,
        }
        assert_eq!(
            locked.write(&invalid).await.err().unwrap().code,
            "invalid_store"
        );
        assert_eq!(
            fs::read(directory.path().join(STATE_FILE)).unwrap(),
            original
        );
    }
    let mut rejected = pending_state();
    rejected.accounts[0]
        .pending_refresh
        .as_mut()
        .unwrap()
        .rejected = true;
    rejected.accounts[0].account.status = AccountStatus::ReauthRequired;
    locked.write(&rejected).await.unwrap();
    assert!(
        locked.read().await.unwrap().unwrap().accounts[0]
            .pending_refresh
            .as_ref()
            .unwrap()
            .rejected
    );
    let mut malformed = pending_state();
    malformed.accounts[0]
        .pending_refresh
        .as_mut()
        .unwrap()
        .candidate
        .client_id = "different-registration".into();
    let key = keys.key.lock().unwrap().unwrap();
    // An authenticated but invalid internal payload is also rejected on read.
    fs::write(
        directory.path().join(STATE_FILE),
        encrypt("dev.test.app", &key, &malformed).unwrap(),
    )
    .unwrap();
    assert_eq!(locked.read().await.err().unwrap().code, "invalid_store");
}

#[test]
fn pending_payload_rejects_unknown_fields_and_wrong_types_instead_of_ignoring_them() {
    let initial = serde_json::to_value(pending_state()).unwrap();
    for (field, value) in [
        ("receivedAt", serde_json::json!(1.5)),
        ("idTokenReplaced", serde_json::json!("false")),
        (
            "identity",
            serde_json::json!({"subject": "unverified-subject"}),
        ),
    ] {
        let mut malformed = initial.clone();
        malformed["accounts"][0]["pendingRefresh"]["candidate"][field] = value;
        assert!(serde_json::from_value::<ConnectionState>(malformed).is_err());
    }
    let mut malformed = initial.clone();
    malformed["accounts"][0]["pendingRefresh"]["credentials"] = serde_json::json!({});
    assert!(serde_json::from_value::<ConnectionState>(malformed).is_err());
    let mut malformed = initial;
    malformed["accounts"][0]["pendingRefresh"]["candidate"]["credentials"]["verified"] =
        serde_json::json!(true);
    assert!(serde_json::from_value::<ConnectionState>(malformed).is_err());
}

#[tokio::test]
async fn key_creation_is_serialized_across_independent_instances() {
    let (directory, first, keys) = setup();
    let second = Store::with_keys(
        directory.path().to_path_buf(),
        "dev.test.app".into(),
        keys.clone(),
    )
    .unwrap();
    let initialize = |store: Store| async move {
        let locked = store.lock(None).await.unwrap();
        match locked.read().await.unwrap() {
            Some(state) => state.host_id,
            None => {
                let state = state();
                locked.write(&state).await.unwrap();
                state.host_id
            }
        }
    };
    let (first, second) = tokio::join!(initialize(first), initialize(second));
    assert_eq!(first, second);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn missing_key_never_replaces_existing_ciphertext_or_generates_a_new_key() {
    let (directory, store, keys) = setup();
    let locked = store.lock(None).await.unwrap();
    let state = state();
    locked.write(&state).await.unwrap();
    let before = fs::read(directory.path().join(STATE_FILE)).unwrap();
    *keys.key.lock().unwrap() = None;
    assert_eq!(locked.read().await.err().unwrap().code, "store_key_missing");
    assert_eq!(
        locked.write(&state).await.err().unwrap().code,
        "store_key_missing"
    );
    assert_eq!(keys.writes.load(Ordering::SeqCst), 1);
    assert_eq!(before, fs::read(directory.path().join(STATE_FILE)).unwrap());
}

#[tokio::test]
async fn unavailable_keystore_fails_closed_without_a_plaintext_file() {
    let (directory, store, keys) = setup();
    keys.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        store
            .lock(None)
            .await
            .unwrap()
            .write(&state())
            .await
            .err()
            .unwrap()
            .code,
        "keystore_unavailable"
    );
    assert!(!directory.path().join(STATE_FILE).exists());
}

#[tokio::test]
async fn tampering_and_app_namespace_mismatch_fail_without_reset() {
    let (directory, store, keys) = setup();
    let state = state();
    let locked = store.lock(None).await.unwrap();
    locked.write(&state).await.unwrap();
    drop(locked);
    let different =
        Store::with_keys(directory.path().to_path_buf(), "another.app".into(), keys).unwrap();
    assert_eq!(
        different
            .lock(None)
            .await
            .unwrap()
            .read()
            .await
            .err()
            .unwrap()
            .code,
        "invalid_store"
    );
    let path = directory.path().join(STATE_FILE);
    let mut envelope: Envelope = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut ciphertext = STANDARD.decode(&envelope.ciphertext).unwrap();
    ciphertext[0] ^= 1;
    envelope.ciphertext = STANDARD.encode(ciphertext);
    let corrupted = serde_json::to_vec(&envelope).unwrap();
    fs::write(&path, &corrupted).unwrap();
    let locked = store.lock(None).await.unwrap();
    assert_eq!(locked.read().await.err().unwrap().code, "invalid_store");
    assert_eq!(
        locked.write(&state).await.err().unwrap().code,
        "invalid_store"
    );
    assert_eq!(fs::read(&path).unwrap(), corrupted);
}

#[tokio::test]
async fn oversized_files_and_invalid_state_are_rejected() {
    let (directory, store, _) = setup();
    let locked = store.lock(None).await.unwrap();
    let mut corrupt = state();
    corrupt.accounts.push(corrupt.accounts[0].clone());
    corrupt.accounts[1].account.id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        locked.write(&corrupt).await.err().unwrap().code,
        "invalid_store"
    );
    locked.write(&state()).await.unwrap();
    let file = OpenOptions::new()
        .write(true)
        .open(directory.path().join(STATE_FILE))
        .unwrap();
    file.set_len(MAX_BYTES + 1).unwrap();
    assert_eq!(locked.read().await.err().unwrap().code, "store_too_large");
}

#[tokio::test]
async fn replacement_never_exposes_a_partial_file_to_readers() {
    let (directory, store, _) = setup();
    let locked = store.lock(None).await.unwrap();
    let mut state = state();
    locked.write(&state).await.unwrap();
    let path = directory.path().join(STATE_FILE);
    let reader = tokio::task::spawn_blocking(move || {
        for _ in 0..300 {
            let bytes = fs::read(&path).unwrap();
            let envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(envelope.schema, SCHEMA);
            assert!(!envelope.ciphertext.is_empty());
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    let mut outcome = Ok(());
    for _ in 0..25 {
        state.accounts[0].revision += 1;
        outcome = locked.write(&state).await;
        if outcome.is_err() {
            break;
        }
    }
    reader.await.unwrap();
    outcome.unwrap();
}

#[tokio::test]
async fn canceled_lock_wait_does_not_remove_or_replace_the_lock_file() {
    let (directory, store, _) = setup();
    let locked = store.lock(None).await.unwrap();
    let identity = identity_at_path(&directory.path().join(LOCK_FILE)).unwrap();
    let cancel = CancellationToken::new();
    let pending = store.lock(Some(cancel.clone()));
    tokio::pin!(pending);
    tokio::select! {
        _ = &mut pending => panic!("a second holder acquired the lock"),
        _ = tokio::time::sleep(Duration::from_millis(50)) => cancel.cancel(),
    }
    assert_eq!(pending.await.err().unwrap().code, "cancelled");
    drop(locked);
    let _next = store.lock(None).await.unwrap();
    assert_eq!(
        identity,
        identity_at_path(&directory.path().join(LOCK_FILE)).unwrap()
    );
}

// A subprocess fixture exercises real OS lock cleanup after process death, not
// an age/PID-based stale-lock heuristic. No credentials or real keyring are used.
#[test]
fn lock_child() {
    let Some(directory) = std::env::var_os("GAU_TEST_LOCK_CHILD") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let lock = open_lock(&directory.join(LOCK_FILE)).unwrap();
    FileExt::lock_exclusive(&lock).unwrap();
    fs::write(directory.join("child-ready"), b"ready").unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

#[tokio::test]
async fn process_death_releases_an_os_lock_without_unlinking_it() {
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (directory, store, _) = setup();
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "store::tests::lock_child", "--nocapture"])
            .env("GAU_TEST_LOCK_CHILD", directory.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    for _ in 0..500 {
        if directory.path().join("child-ready").exists() {
            break;
        }
        if child.0.try_wait().unwrap().is_some() {
            panic!("lock child exited before acquiring the lock");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(directory.path().join("child-ready").exists());
    let before = identity_at_path(&directory.path().join(LOCK_FILE)).unwrap();
    let cancel = CancellationToken::new();
    let waiter = store.lock(Some(cancel.clone()));
    tokio::pin!(waiter);
    tokio::select! {
        _ = &mut waiter => panic!("cross-process exclusion failed"),
        _ = tokio::time::sleep(Duration::from_millis(50)) => cancel.cancel(),
    }
    assert_eq!(waiter.await.err().unwrap().code, "cancelled");
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let _locked = store.lock(None).await.unwrap();
    assert_eq!(
        before,
        identity_at_path(&directory.path().join(LOCK_FILE)).unwrap()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symbolic_links_hard_links_and_public_files_fail_closed() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (directory, store, _) = setup();
    let locked = store.lock(None).await.unwrap();
    locked.write(&state()).await.unwrap();
    let state_path = directory.path().join(STATE_FILE);
    fs::set_permissions(&state_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(locked.read().await.err().unwrap().code, "unsafe_store_path");
    fs::set_permissions(&state_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&state_path, directory.path().join("hard-link")).unwrap();
    assert_eq!(locked.read().await.err().unwrap().code, "unsafe_store_path");
    fs::remove_file(directory.path().join("hard-link")).unwrap();
    let original = directory.path().join("original");
    fs::rename(&state_path, &original).unwrap();
    symlink(&original, &state_path).unwrap();
    assert_eq!(locked.read().await.err().unwrap().code, "unsafe_store_path");
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[tokio::test]
#[ignore = "requires an unlocked desktop OS credential store; creates only a unique test credential"]
async fn native_keyring_and_encrypted_store_roundtrip() {
    struct Cleanup(keyring::Entry);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let unique = uuid::Uuid::new_v4();
    let app_id = format!("dev.gau.test.{unique}");
    let provider = Arc::new(OsKeyProvider {
        service: format!("{app_id}/gau"),
        account: format!("test-{unique}"),
    });
    let cleanup = Cleanup(provider.entry().unwrap());
    let mut expected = Zeroizing::new([0; 32]);
    OsRng.fill_bytes(expected.as_mut());
    provider.set(&expected).unwrap();
    assert_eq!(provider.get().unwrap().unwrap().as_ref(), expected.as_ref());
    let directory = directory();
    let store = Store::with_keys(directory.path().to_path_buf(), app_id, provider).unwrap();
    let locked = store.lock(None).await.unwrap();
    let initial = state();
    locked.write(&initial).await.unwrap();
    let restored = locked.read().await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(initial).unwrap(),
        serde_json::to_value(restored).unwrap()
    );
    let bytes = fs::read(directory.path().join(STATE_FILE)).unwrap();
    assert!(!std::str::from_utf8(&bytes)
        .unwrap()
        .contains("access-secret"));
    // Assert cleanup explicitly; Drop also attempts it if an assertion panics.
    cleanup.0.delete_credential().unwrap();
}
