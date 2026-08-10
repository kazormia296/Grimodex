//! Cross-process workspace file lease for open / migration / restore.
//!
//! Lock file: `<workspace>/.grimodex-workspace.lock`
//! - shared: normal DB open
//! - exclusive: migration / restore / atomic replacement

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LOCK_FILE_NAME: &str = ".grimodex-workspace.lock";

#[derive(Debug)]
pub struct WorkspaceLease {
    _file: File,
    path: PathBuf,
    mode: LeaseMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseMode {
    Shared,
    Exclusive,
}

impl WorkspaceLease {
    pub fn mode(&self) -> LeaseMode {
        self.mode
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn lock_path(workspace: &Path) -> PathBuf {
    workspace.join(LOCK_FILE_NAME)
}

fn open_lock_file(workspace: &Path) -> io::Result<File> {
    std::fs::create_dir_all(workspace)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path(workspace))
}

fn map_try_lock_error(error: TryLockError) -> LeaseError {
    match error {
        TryLockError::WouldBlock => LeaseError::Busy {
            code: "WORKSPACE_MIGRATION_BUSY",
        },
        TryLockError::Error(io_error) => LeaseError::Io(io_error),
    }
}

/// Acquire a shared lease (non-blocking). Used for normal workspace open.
pub fn try_acquire_shared(workspace: &Path) -> Result<WorkspaceLease, LeaseError> {
    let file = open_lock_file(workspace).map_err(LeaseError::Io)?;
    match file.try_lock_shared() {
        Ok(()) => Ok(WorkspaceLease {
            _file: file,
            path: lock_path(workspace),
            mode: LeaseMode::Shared,
        }),
        Err(error) => Err(map_try_lock_error(error)),
    }
}

/// Acquire an exclusive lease, waiting up to `timeout`.
pub fn acquire_exclusive(
    workspace: &Path,
    timeout: Duration,
) -> Result<WorkspaceLease, LeaseError> {
    let file = open_lock_file(workspace).map_err(LeaseError::Io)?;
    let deadline = Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => {
                return Ok(WorkspaceLease {
                    _file: file,
                    path: lock_path(workspace),
                    mode: LeaseMode::Exclusive,
                })
            }
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(LeaseError::Busy {
                        code: "WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT",
                    });
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(TryLockError::Error(error)) => return Err(LeaseError::Io(error)),
        }
    }
}

/// Upgrade path helper: drop shared and take exclusive with timeout.
pub fn acquire_exclusive_for_migration(
    workspace: &Path,
) -> Result<WorkspaceLease, LeaseError> {
    acquire_exclusive(workspace, Duration::from_secs(10))
}

#[derive(Debug, thiserror::Error)]
pub enum LeaseError {
    #[error("{code}: workspace lease is held by another process")]
    Busy { code: &'static str },
    #[error("workspace lease io error: {0}")]
    Io(#[from] io::Error),
}

impl LeaseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Busy { code } => code,
            Self::Io(_) => "WORKSPACE_LEASE_IO",
        }
    }
}
