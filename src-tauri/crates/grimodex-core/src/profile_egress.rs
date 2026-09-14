//! Cross-process publication coordination for the Native-owned profile egress
//! state store.
//!
//! This module contains only the advisory lease used to linearize publication
//! with MCP output.  The persisted profile state remains owned by Native; the
//! lock is not an additional authority.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

pub const PROFILE_EGRESS_FILE: &str = "profile-egress.json";
pub const PROFILE_PUBLICATION_LOCK_FILE: &str = ".profile-egress.lock";

/// Derive the lock that lives beside the one canonical persisted state file.
pub fn publication_lock_path(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .map(|parent| parent.join(PROFILE_PUBLICATION_LOCK_FILE))
        .unwrap_or_else(|| PathBuf::from(PROFILE_PUBLICATION_LOCK_FILE))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicationLockMode {
    Shared,
    Exclusive,
}

/// An OS advisory lease.  Holding this value holds the underlying lock; drop
/// releases it.  Both Native and MCP use this exact path and implementation.
pub struct PublicationLease {
    _file: File,
}

impl std::fmt::Debug for PublicationLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PublicationLease")
            .finish_non_exhaustive()
    }
}

impl PublicationLease {
    pub fn acquire(state_path: &Path, mode: PublicationLockMode) -> io::Result<Self> {
        let path = publication_lock_path(state_path);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)?;
        loop {
            match try_lock(&file, mode) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(error) if is_would_block(&error) => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(unix)]
fn try_lock(file: &File, mode: PublicationLockMode) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let operation = match mode {
        PublicationLockMode::Shared => libc::LOCK_SH | libc::LOCK_NB,
        PublicationLockMode::Exclusive => libc::LOCK_EX | libc::LOCK_NB,
    };
    // SAFETY: the file descriptor belongs to the live File held by the lease.
    let result = unsafe { libc::flock(file.as_raw_fd(), operation) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn try_lock(file: &File, mode: PublicationLockMode) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let flags = LOCKFILE_FAIL_IMMEDIATELY
        | match mode {
            PublicationLockMode::Shared => 0,
            PublicationLockMode::Exclusive => LOCKFILE_EXCLUSIVE_LOCK,
        };
    let mut overlapped = OVERLAPPED::default();
    // SAFETY: the handle belongs to the live File held by the lease and the
    // OVERLAPPED value remains live for the duration of this call.
    let result = unsafe { LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut overlapped) };
    if result != 0 {
        Ok(())
    } else {
        use windows_sys::Win32::Foundation::GetLastError;

        // ERROR_LOCK_VIOLATION (33) is the non-blocking lock-conflict code.
        Err(io::Error::from_raw_os_error(
            unsafe { GetLastError() } as i32
        ))
    }
}

#[cfg(not(any(unix, windows)))]
fn try_lock(_file: &File, _mode: PublicationLockMode) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "profile egress publication leases require a supported OS advisory lock",
    ))
}

fn is_would_block(error: &io::Error) -> bool {
    #[cfg(windows)]
    if error.raw_os_error() == Some(33) {
        return true;
    }
    error.kind() == io::ErrorKind::WouldBlock
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn exclusive_lease_waits_for_shared_publication_to_finish() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-profile-publication-lock-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("fixture directory");
        let state_path = root.join(PROFILE_EGRESS_FILE);
        let shared = PublicationLease::acquire(&state_path, PublicationLockMode::Shared)
            .expect("shared lease");
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_path = state_path.clone();
        let waiter = std::thread::spawn(move || {
            ready_tx.send(()).expect("waiter started");
            PublicationLease::acquire(&thread_path, PublicationLockMode::Exclusive)
                .expect("exclusive lease after shared release")
        });
        ready_rx.recv().expect("waiter started");
        std::thread::sleep(Duration::from_millis(30));
        assert!(
            !waiter.is_finished(),
            "exclusive lease must wait for shared output"
        );
        drop(shared);
        drop(waiter.join().expect("waiter completes"));
        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}
