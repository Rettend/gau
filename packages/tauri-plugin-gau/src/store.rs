//! Native encrypted persistence. The lock file is deliberately never removed.
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{
    error::{Error, Result},
    models::{AccountStatus, ConnectionState, Credentials, RefreshCandidate, StoredAccount},
};

const SCHEMA: &str = "gau-chatgpt-connections";
const VERSION: u32 = 1;
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_RETRY: Duration = Duration::from_millis(25);
const STATE_FILE: &str = "chatgpt-connections.json.enc";
const LOCK_FILE: &str = "chatgpt-connections.lock";

/// Not exported by the crate: tests can supply a key without touching a user's vault.
pub(crate) trait KeyProvider: Send + Sync {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>>;
    fn set(&self, key: &[u8; 32]) -> Result<()>;
}

struct OsKeyProvider {
    service: String,
    account: String,
}

impl OsKeyProvider {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, &self.account).map_err(|_| key_error())
    }
}

impl KeyProvider for OsKeyProvider {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>> {
        match self.entry()?.get_secret() {
            Ok(secret) => {
                let secret = Zeroizing::new(secret);
                if secret.len() != 32 {
                    return Err(key_error());
                }
                let mut key = Zeroizing::new([0; 32]);
                key.copy_from_slice(&secret);
                Ok(Some(key))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(key_error()),
        }
    }

    fn set(&self, key: &[u8; 32]) -> Result<()> {
        self.entry()?.set_secret(key).map_err(|_| key_error())
    }
}

#[derive(Clone)]
pub(crate) struct Store {
    directory: PathBuf,
    app_id: String,
    keys: Arc<dyn KeyProvider>,
}

pub(crate) struct LockedStore {
    store: Store,
    // Cloned into blocking jobs, so even dropping an async caller cannot release
    // the OS lock while its read or atomic replacement is still running.
    lock: Arc<File>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema: String,
    version: u32,
    nonce: String,
    ciphertext: String,
}

impl Store {
    pub(crate) fn new(directory: PathBuf, app_id: String) -> Result<Self> {
        // Entry creation and all credential-store calls are deferred until use.
        let keys = Arc::new(OsKeyProvider {
            service: format!("{app_id}/gau"),
            account: "chatgpt-store-v1".into(),
        });
        Self::with_keys(directory, app_id, keys)
    }

    pub(crate) fn with_keys(
        directory: PathBuf,
        app_id: String,
        keys: Arc<dyn KeyProvider>,
    ) -> Result<Self> {
        if directory.as_os_str().is_empty()
            || app_id.is_empty()
            || app_id.len() > 512
            || app_id.chars().any(char::is_control)
            || directory
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(Error::new(
                "invalid_configuration",
                "The connection configuration is invalid.",
            ));
        }
        let directory = if directory.is_absolute() {
            directory
        } else {
            std::env::current_dir()
                .map_err(|_| io_error())?
                .join(directory)
        };
        Ok(Self {
            directory,
            app_id,
            keys,
        })
    }

    pub(crate) async fn lock(&self, cancel: Option<CancellationToken>) -> Result<LockedStore> {
        let store = self.clone();
        blocking(move || {
            if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
                return Err(Error::cancelled());
            }
            ensure_directory(&store.directory)?;
            let path = store.directory.join(LOCK_FILE);
            let lock = open_lock(&path)?;
            let deadline = Instant::now() + LOCK_TIMEOUT;
            loop {
                if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
                    return Err(Error::cancelled());
                }
                match FileExt::try_lock_exclusive(&lock) {
                    Ok(()) => break,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            || error.raw_os_error()
                                == fs2::lock_contended_error().raw_os_error() => {}
                    Err(_) => return Err(io_error()),
                }
                if Instant::now() >= deadline {
                    return Err(Error::new(
                        "store_busy",
                        "The connection store is busy. Try again.",
                    ));
                }
                std::thread::sleep(LOCK_RETRY);
            }
            // Prevent the inode-alias race if something outside Gau removed it.
            verify_open_file(&path, &lock)?;
            Ok(LockedStore {
                store,
                lock: Arc::new(lock),
            })
        })
        .await
    }
}

impl LockedStore {
    pub(crate) async fn read(&self) -> Result<Option<ConnectionState>> {
        let store = self.store.clone();
        let lock = self.lock.clone();
        blocking(move || {
            let _lock = lock;
            ensure_directory(&store.directory)?;
            let Some(mut file) = open_existing(&store.directory.join(STATE_FILE))? else {
                return Ok(None);
            };
            if file.metadata().map_err(|_| io_error())?.len() > MAX_BYTES {
                return Err(size_error());
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| io_error())?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err(size_error());
            }
            let key = store.keys.get()?.ok_or_else(|| {
                Error::new(
                    "store_key_missing",
                    "The encryption key for the existing connection store is missing.",
                )
            })?;
            let state = decrypt(&store.app_id, &key, &bytes)?;
            validate_state(&state)?;
            Ok(Some(state))
        })
        .await
    }

    pub(crate) async fn write(&self, state: &ConnectionState) -> Result<()> {
        validate_state(state)?;
        let state = state.clone();
        let store = self.store.clone();
        let lock = self.lock.clone();
        // Never race this job against cancellation: it must finish before the
        // caller reports cancellation or returns a rotated credential.
        blocking(move || {
            let _lock = lock;
            ensure_directory(&store.directory)?;
            let target = store.directory.join(STATE_FILE);
            let exists = check_leaf(&target)?.is_some();
            let key = match store.keys.get()? {
                Some(key) => key,
                None if exists => {
                    return Err(Error::new(
                        "store_key_missing",
                        "The encryption key for the existing connection store is missing.",
                    ));
                }
                None => {
                    let mut key = Zeroizing::new([0; 32]);
                    OsRng.fill_bytes(key.as_mut());
                    store.keys.set(&key)?;
                    key
                }
            };
            // An internal write must never turn corrupt ciphertext into a reset.
            if exists {
                let mut file = open_existing(&target)?.ok_or_else(io_error)?;
                if file.metadata().map_err(|_| io_error())?.len() > MAX_BYTES {
                    return Err(size_error());
                }
                let mut bytes = Vec::new();
                (&mut file)
                    .take(MAX_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| io_error())?;
                if bytes.len() as u64 > MAX_BYTES {
                    return Err(size_error());
                }
                validate_state(&decrypt(&store.app_id, &key, &bytes)?)?;
            }
            let bytes = encrypt(&store.app_id, &key, &state)?;
            atomic_write(&store.directory, &target, &bytes)
        })
        .await
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|_| io_error())?
}

fn associated_data(app_id: &str) -> Vec<u8> {
    // The length prefix makes the application namespace unambiguous.
    format!("{SCHEMA}\0{VERSION}\0{}\0{app_id}", app_id.len()).into_bytes()
}

fn encrypt(app_id: &str, key: &[u8; 32], state: &ConnectionState) -> Result<Vec<u8>> {
    let plaintext = Zeroizing::new(serde_json::to_vec(state).map_err(|_| corrupt_error())?);
    if plaintext.len() as u64 > MAX_BYTES {
        return Err(size_error());
    }
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = ChaCha20Poly1305::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &associated_data(app_id),
            },
        )
        .map_err(|_| corrupt_error())?;
    let bytes = serde_json::to_vec(&Envelope {
        schema: SCHEMA.into(),
        version: VERSION,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| corrupt_error())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(size_error());
    }
    Ok(bytes)
}

fn decrypt(app_id: &str, key: &[u8; 32], bytes: &[u8]) -> Result<ConnectionState> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| corrupt_error())?;
    if envelope.schema != SCHEMA || envelope.version != VERSION {
        return Err(corrupt_error());
    }
    let nonce = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| corrupt_error())?;
    let ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| corrupt_error())?;
    if nonce.len() != 12 {
        return Err(corrupt_error());
    }
    let plaintext = Zeroizing::new(
        ChaCha20Poly1305::new(key.into())
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &associated_data(app_id),
                },
            )
            .map_err(|_| corrupt_error())?,
    );
    serde_json::from_slice(&plaintext).map_err(|_| corrupt_error())
}

pub(crate) fn resource_ready(credentials: &Credentials) -> bool {
    credentials
        .access_token
        .as_ref()
        .is_some_and(|token| !token.is_empty())
        && ["resource.invoke", "chatgpt.tokens.use.direct"]
            .iter()
            .all(|scope| credentials.scopes.iter().any(|value| value == scope))
}

pub(crate) fn valid_credentials(credentials: &Credentials) -> bool {
    let nonempty = |value: &Option<String>| value.as_ref().is_none_or(|value| !value.is_empty());
    let access = match (&credentials.access_token, credentials.expires_at) {
        (Some(token), Some(expiry)) => !token.is_empty() && expiry > 0,
        (None, None) => credentials
            .id_token
            .as_ref()
            .is_some_and(|value| !value.is_empty()),
        _ => false,
    };
    access
        && nonempty(&credentials.refresh_token)
        && nonempty(&credentials.id_token)
        && credentials.scopes.iter().all(|scope| !scope.is_empty())
}

pub(crate) fn valid_revocation_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 1024 * 1024
        && token.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(crate) fn valid_refresh_candidate(
    account: &StoredAccount,
    candidate: &RefreshCandidate,
) -> bool {
    let Some(previous) = &account.credentials else {
        return false;
    };
    let credentials = &candidate.credentials;
    let token = |value: &Option<String>| {
        value
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty() && value.len() <= 1024 * 1024)
    };
    let mut scopes = HashSet::new();
    account.revocation_refresh_token.is_none()
        && candidate.client_id == account.account.client_id
        && !candidate.client_id.is_empty()
        && candidate.client_id != "dynamic_agent_client"
        && candidate.client_id.len() <= 1024
        && candidate
            .client_id
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
        && candidate.received_at > 0
        && valid_credentials(previous)
        && token(&previous.refresh_token)
        && valid_credentials(credentials)
        && token(&credentials.access_token)
        && token(&credentials.refresh_token)
        && credentials.refresh_token != previous.refresh_token
        && credentials
            .expires_at
            .is_some_and(|expiry| expiry > candidate.received_at)
        && !credentials.scopes.is_empty()
        && credentials.scopes.len() <= 1024
        && credentials.scopes.iter().all(|scope| {
            scope.len() <= 1024
                && !scope.is_empty()
                && scopes.insert(scope)
                && scope.bytes().all(|byte| {
                    byte == 0x21 || (0x23..=0x5b).contains(&byte) || (0x5d..=0x7e).contains(&byte)
                })
        })
        && credentials
            .id_token
            .as_ref()
            .is_none_or(|token| !token.trim().is_empty() && token.len() <= 256 * 1024)
        && if candidate.id_token_replaced {
            credentials.id_token.is_some()
        } else {
            credentials.id_token == previous.id_token
        }
}

fn validate_state(state: &ConnectionState) -> Result<()> {
    if state.version != VERSION
        || !state.host_id.strip_prefix("urn:uuid:").is_some_and(|id| {
            id.len() == 36
                && uuid::Uuid::parse_str(id)
                    .is_ok_and(|uuid| uuid.hyphenated().to_string().eq_ignore_ascii_case(id))
        })
    {
        return Err(corrupt_error());
    }
    let mut ids = HashSet::new();
    let mut registrations = HashSet::new();
    for stored in &state.accounts {
        let account = &stored.account;
        if account.id.is_empty()
            || account.client_id.is_empty()
            || account.identity.issuer.is_empty()
            || account.identity.subject.is_empty()
            || !ids.insert(&account.id)
            || !registrations.insert((
                &account.identity.issuer,
                &account.client_id,
                &account.identity.subject,
            ))
            || account.scopes.iter().any(|scope| scope.is_empty())
        {
            return Err(corrupt_error());
        }
        let redirect = url::Url::parse(&stored.redirect_uri).map_err(|_| corrupt_error())?;
        if !stored.redirect_uri.starts_with("http://127.0.0.1:")
            || redirect.scheme() != "http"
            || redirect.host_str() != Some("127.0.0.1")
            || redirect.port().is_none_or(|port| port == 0)
            || redirect.path() != "/auth/callback"
            || !redirect.username().is_empty()
            || redirect.password().is_some()
            || redirect.query().is_some()
            || redirect.fragment().is_some()
        {
            return Err(corrupt_error());
        }
        match &stored.credentials {
            Some(credentials) => {
                let expected = if stored
                    .pending_refresh
                    .as_ref()
                    .is_some_and(|pending| pending.rejected)
                {
                    AccountStatus::ReauthRequired
                } else if resource_ready(credentials) {
                    AccountStatus::Ready
                } else {
                    AccountStatus::IdentityOnly
                };
                if !valid_credentials(credentials)
                    || account.scopes != credentials.scopes
                    || account.status != expected
                {
                    return Err(corrupt_error());
                }
            }
            None if !account.scopes.is_empty()
                || !matches!(
                    account.status,
                    AccountStatus::SignedOut | AccountStatus::ReauthRequired
                ) =>
            {
                return Err(corrupt_error());
            }
            None => {}
        }
        if stored
            .revocation_refresh_token
            .as_ref()
            .is_some_and(|token| {
                !valid_revocation_token(token)
                    || account.status != AccountStatus::ReauthRequired
                    || stored.credentials.is_some()
                    || stored.pending_refresh.is_some()
                    || !account.scopes.is_empty()
            })
        {
            return Err(corrupt_error());
        }
        if stored
            .pending_refresh
            .as_ref()
            .is_some_and(|pending| !valid_refresh_candidate(stored, &pending.candidate))
        {
            return Err(corrupt_error());
        }
    }
    Ok(())
}

fn ensure_directory(directory: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in directory.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let builder = fs::DirBuilder::new();
                #[cfg(unix)]
                let builder = {
                    use std::os::unix::fs::DirBuilderExt;
                    let mut builder = builder;
                    builder.mode(0o700);
                    builder
                };
                match builder.create(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(io_error()),
                }
                fs::symlink_metadata(&current).map_err(|_| io_error())?
            }
            Err(_) => return Err(io_error()),
        };
        if !metadata.is_dir() || is_link(&metadata) {
            return Err(path_error());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o022 != 0
                && (current == directory || metadata.mode() & 0o1000 == 0)
            {
                return Err(path_error());
            }
        }
    }
    Ok(())
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn validate_file(metadata: &Metadata) -> Result<()> {
    if !metadata.is_file() || is_link(metadata) {
        return Err(path_error());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(path_error());
        }
    }
    Ok(())
}

fn check_leaf(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_file(&metadata)?;
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(io_error()),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(unix)]
fn metadata_same_file(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| io_error())?;
    validate_file(&metadata)?;
    Ok(FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
    })
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    // std's corresponding MetadataExt fields are still unstable. Use the
    // documented handle API so stable Rust can check inode identity and links.
    #[repr(C)]
    #[derive(Default)]
    struct FileInformation {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut FileInformation,
        ) -> i32;
    }
    let mut information = FileInformation::default();
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if result == 0 || information.links != 1 || information.attributes & 0x400 != 0 {
        return Err(path_error());
    }
    Ok(FileIdentity {
        volume: u64::from(information.volume),
        index: (u64::from(information.index_high) << 32) | u64::from(information.index_low),
    })
}

fn identity_at_path(path: &Path) -> Result<FileIdentity> {
    check_leaf(path)?.ok_or_else(path_error)?;
    let file = private_options()
        .read(true)
        .open(path)
        .map_err(|_| io_error())?;
    validate_file(&file.metadata().map_err(|_| io_error())?)?;
    file_identity(&file)
}

fn verify_open_file(path: &Path, file: &File) -> Result<()> {
    let opened = file.metadata().map_err(|_| io_error())?;
    validate_file(&opened)?;
    if file_identity(file)? != identity_at_path(path)? {
        return Err(path_error());
    }
    Ok(())
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options
}

fn open_existing(path: &Path) -> Result<Option<File>> {
    let Some(_before) = check_leaf(path)? else {
        return Ok(None);
    };
    let file = private_options()
        .read(true)
        .open(path)
        .map_err(|_| io_error())?;
    #[cfg(unix)]
    if !metadata_same_file(&_before, &file.metadata().map_err(|_| io_error())?) {
        return Err(path_error());
    }
    verify_open_file(path, &file)?;
    Ok(Some(file))
}

fn open_lock(path: &Path) -> Result<File> {
    let _before = check_leaf(path)?;
    let mut options = private_options();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Prevent deletion/replacement while any process has this inode open.
        options.share_mode(0x1 | 0x2);
    }
    let file = options.open(path).map_err(|_| io_error())?;
    #[cfg(unix)]
    if let Some(before) = _before {
        if !metadata_same_file(&before, &file.metadata().map_err(|_| io_error())?) {
            return Err(path_error());
        }
    }
    verify_open_file(path, &file)?;
    Ok(file)
}

fn atomic_write(directory: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    let mut temporary = tempfile::Builder::new()
        .prefix(".gau-chatgpt-")
        .tempfile_in(directory)
        .map_err(|_| io_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| io_error())?;
    }
    temporary.write_all(bytes).map_err(|_| io_error())?;
    temporary.as_file().sync_all().map_err(|_| io_error())?;
    ensure_directory(directory)?;
    check_leaf(target)?;
    let temporary = temporary.into_temp_path(); // close before replacement on Windows
    replace(&temporary, target)?;
    #[cfg(unix)]
    {
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| io_error())?;
    }
    // TempPath cleanup only concerns its now-missing old path, never the target.
    Ok(())
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target).map_err(|_| io_error())
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // REPLACE_EXISTING | WRITE_THROUGH: both file and rename are durable.
        let moved = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x1 | 0x8) };
        if moved != 0 {
            return Ok(());
        }
        let code = std::io::Error::last_os_error().raw_os_error();
        // A reader or antivirus can briefly deny replacement on Windows, even
        // with delete sharing. Retry only these failures; never delete the old
        // file or fall back to a non-atomic copy/truncate operation.
        if !matches!(code, Some(5 | 32 | 33)) || Instant::now() >= deadline {
            return Err(io_error());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn io_error() -> Error {
    Error::new(
        "store_unavailable",
        "The connection store could not be accessed.",
    )
}
fn path_error() -> Error {
    Error::new(
        "unsafe_store_path",
        "The connection store path is not a private regular file or directory.",
    )
}
fn key_error() -> Error {
    Error::new(
        "keystore_unavailable",
        "The operating system credential store is unavailable.",
    )
}
fn size_error() -> Error {
    Error::new(
        "store_too_large",
        "The connection store exceeds its size limit.",
    )
}
fn corrupt_error() -> Error {
    Error::new(
        "invalid_store",
        "The connection store is corrupt or unsupported. Restore it instead of resetting it.",
    )
}

#[cfg(test)]
#[path = "store/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "store/test_keys.rs"]
pub(crate) mod test_keys;
