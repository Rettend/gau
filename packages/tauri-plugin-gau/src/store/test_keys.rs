use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Condvar, Mutex,
};

use tokio::sync::Notify;
use zeroize::Zeroizing;

use super::{key_error, KeyProvider};
use crate::{error::Result, models::ConnectionState};

/// Observe a completed encrypted commit without acquiring a second OS lock.
/// Only used by tests while the production operation still owns that lock.
pub(crate) fn read_encrypted(directory: &Path, app_id: &str, keys: &TestKeys) -> ConnectionState {
    let bytes = std::fs::read(directory.join(super::STATE_FILE)).unwrap();
    let key = keys.key.lock().unwrap();
    let state = super::decrypt(app_id, key.as_ref().unwrap(), &bytes).unwrap();
    super::validate_state(&state).unwrap();
    state
}

pub(crate) fn directory() -> tempfile::TempDir {
    // macOS's default /var/folders path passes through the /var symlink. Use
    // the canonical test root so the production no-symlink checks stay strict.
    let root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

#[derive(Default)]
pub(crate) struct TestKeys {
    pub(crate) key: Mutex<Option<[u8; 32]>>,
    pub(crate) reads: AtomicUsize,
    pub(crate) writes: AtomicUsize,
    pub(crate) fail: AtomicBool,
    pub(crate) set_gate: Option<Gate>,
    pub(crate) get_gate: Option<Gate>,
    pub(crate) gate_on_read: AtomicUsize,
}

impl KeyProvider for TestKeys {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if self.gate_on_read.load(Ordering::SeqCst) == read {
            if let Some(gate) = &self.get_gate {
                gate.block();
            }
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(key_error());
        }
        Ok(self.key.lock().unwrap().map(Zeroizing::new))
    }

    fn set(&self, key: &[u8; 32]) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.set_gate {
            gate.block();
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(key_error());
        }
        *self.key.lock().unwrap() = Some(*key);
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Gate {
    pub(crate) entered: Notify,
    released: Mutex<bool>,
    condition: Condvar,
}

impl Gate {
    pub(crate) fn block(&self) {
        self.entered.notify_one();
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.condition.wait(released).unwrap();
        }
    }

    pub(crate) fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.condition.notify_all();
    }
}
