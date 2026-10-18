//! Socket-lifecycle primitives of the NIR-1 local transport (K5/3, DT-5b).
//!
//! The wire layer ([`crate::nir1_local_wire`]) is pure. The few operations of
//! the transport whose behaviour depends on the operating system live here
//! instead, with no owner, no database and no attempt: a socket shutdown that
//! wakes a blocked read or write where the OS allows it (Linux does; Winsock
//! does not promise it for a `recv` already blocked, DR-DT5-29), and a join
//! that must be bounded although `std` has no timed join. The node crate calls them, and the tests below run
//! in the `src-tauri` workspace so that Linux, macOS and Windows CI can run
//! them without building the Electron binding.
//!
//! Safety does not rest on the shutdown waking the other thread: every blocking
//! call of the I/O thread uses a timeout of at most [`IO_SLICE`] and looks at an
//! abort flag between slices, so a thread whose socket did not wake ends by
//! itself (DR-DT5-20, DR-DT5-23).

use std::net::{Shutdown, TcpStream};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// A blocked read or write wakes at least this often to look at the abort
/// flag, so a detached I/O thread ends even where `shutdown` does not wake it.
pub const IO_SLICE: Duration = Duration::from_millis(100);

/// How [`join_bounded`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinOutcome {
    /// The thread ended and was joined.
    Joined,
    /// The thread ended by panicking.
    Panicked,
    /// The thread did not end within the limit; the handle was dropped, which
    /// detaches it.
    Overrun,
}

/// `std` has no timed join: poll `is_finished`. An overrun drops the handle,
/// which detaches the thread.
pub fn join_bounded(handle: JoinHandle<()>, limit: Duration) -> JoinOutcome {
    let deadline = Instant::now() + limit;
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            drop(handle);
            return JoinOutcome::Overrun;
        }
        thread::sleep(Duration::from_millis(1));
    }
    if handle.join().is_ok() {
        JoinOutcome::Joined
    } else {
        JoinOutcome::Panicked
    }
}

/// Close both directions of the socket. Errors (already closed, reset by the
/// peer) are not failures: the caller wants the socket closed either way.
pub fn shutdown_both(stream: &TcpStream) {
    let _ = stream.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests;
