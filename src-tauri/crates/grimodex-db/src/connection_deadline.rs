//! DR-CHATIR-S1-11 (chat IR S1-A0): a waiter-free connection acquisition with a
//! deadline.
//!
//! The ordinary acquisition (`Database::with_conn` → `lock_conn`) has no
//! deadline and announces a foreground waiter, which makes a running maintenance
//! cycle hand the connection over (`NEX_MAINTENANCE_CONNECTION_PREEMPTED`).
//! A chat-time read that may be abandoned must do neither (T12): this
//! repeats `try_lock_conn_with_check` (DR-MPS-15, never announces a waiter and
//! never overtakes a queued foreground caller or a reserved finalization) until
//! the instant, and answers `Ok(None)` (connection busy) when it could not take
//! the connection in time. Existing acquisitions are untouched.

use std::sync::MutexGuard;
use std::time::{Duration, Instant};

use anyhow::Result;
use rusqlite::Connection;

use crate::{ConnectionCore, Database};

/// Pause between two attempts.
const RETRY_INTERVAL: Duration = Duration::from_millis(1);

/// Internal marker: the instant passed while a worker in no-wait or
/// background-priority mode was inside the blocking acquisition loop that
/// `try_lock_conn_with_check` falls back to for such workers. Mapped to
/// `Ok(None)`; never leaves this module.
#[derive(Debug)]
struct AcquisitionDeadline;

impl std::fmt::Display for AcquisitionDeadline {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("connection acquisition deadline elapsed")
    }
}

impl std::error::Error for AcquisitionDeadline {}

impl ConnectionCore {
    /// Repeat the waiter-free attempt until `deadline`. `Ok(None)`: the
    /// connection was busy (held, a finalization reserved, or a foreground
    /// caller queued) for the whole time. A quarantined or poisoned connection
    /// is an error, never a quiet `None`. An instant that has already passed
    /// is `None` without any attempt.
    pub(crate) fn try_lock_conn_until(
        &self,
        deadline: Instant,
    ) -> Result<Option<MutexGuard<'_, Connection>>> {
        self.try_lock_conn_until_with_check(deadline, None)
    }

    /// [`Self::try_lock_conn_until`] with the caller's own check (a stopped
    /// participant, ...), run before each attempt and after the mutex is
    /// taken, as `try_lock_conn_with_check` runs it. Its error is returned.
    pub(crate) fn try_lock_conn_until_with_check(
        &self,
        deadline: Instant,
        mut extra: Option<&mut dyn FnMut() -> Result<()>>,
    ) -> Result<Option<MutexGuard<'_, Connection>>> {
        let mut check = || {
            if let Some(extra) = extra.as_deref_mut() {
                extra()?;
            }
            if Instant::now() >= deadline {
                return Err(anyhow::Error::new(AcquisitionDeadline));
            }
            Ok(())
        };
        loop {
            if Instant::now() >= deadline {
                return Ok(None);
            }
            match self.try_lock_conn_with_check(Some(&mut check)) {
                Ok(Some(conn)) => return Ok(Some(conn)),
                Ok(None) => std::thread::sleep(
                    RETRY_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                ),
                Err(error) if error.downcast_ref::<AcquisitionDeadline>().is_some() => {
                    return Ok(None);
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Database {
    /// `with_conn` that never announces a foreground waiter and gives up at
    /// `deadline`: `Ok(None)` means the connection could not be taken in time
    /// and `f` did not run. The deadline bounds the acquisition only; `f` is
    /// responsible for its own work (a write needs a bounded busy wait, see
    /// `try_append_ai_audit_events_for_scope_until`). Usable for reads and
    /// writes.
    pub fn try_with_conn_until<T, F>(&self, deadline: Instant, f: F) -> Result<Option<T>>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        self.try_with_conn_mut_until(deadline, |conn| f(conn))
    }

    /// `with_conn_mut` with the same acquisition as [`Self::try_with_conn_until`]
    /// (capacity-attempt scope included, as `with_conn_mut`).
    pub fn try_with_conn_mut_until<T, F>(&self, deadline: Instant, f: F) -> Result<Option<T>>
    where
        F: FnOnce(&mut Connection) -> Result<T>,
    {
        let Some(mut conn) = self.try_lock_conn_until(deadline)? else {
            return Ok(None);
        };
        let value = if crate::narrative_extraction::nir1_capacity::attempt_active() {
            crate::narrative_maintenance_connection::with_capacity_connection(self, &mut conn, f)?
        } else {
            f(&mut conn)?
        };
        Ok(Some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;

    pub(super) fn test_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db
    }

    /// Holds `db`'s connection mutex on a thread until released.
    pub(super) struct Holder {
        release: mpsc::Sender<()>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl Holder {
        pub(super) fn new(db: &Arc<Database>) -> Self {
            let (held_tx, held_rx) = mpsc::channel();
            let (release, release_rx) = mpsc::channel::<()>();
            let holder_db = Arc::clone(db);
            let thread = thread::spawn(move || {
                let _conn = holder_db.conn.lock().expect("hold connection");
                held_tx.send(()).expect("announce held");
                let _ = release_rx.recv();
            });
            held_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("holder owns the connection");
            Self {
                release,
                thread: Some(thread),
            }
        }

        pub(super) fn release(&mut self) {
            let _ = self.release.send(());
            if let Some(thread) = self.thread.take() {
                thread.join().expect("holder joined");
            }
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.release.send(());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// The acquisition ends at the instant (a held connection is `None`, never
    /// a wait without bound), without announcing a waiter at any moment (an
    /// observer samples the count continuously), and runs once the holder lets
    /// go. Removing the `deadline` check of the loop turns this test into a
    /// hang (a bounded wait on the holder).
    #[test]
    fn try_with_conn_until_stops_at_the_deadline_and_never_announces_a_waiter() {
        let db = Arc::new(test_db());
        let mut holder = Holder::new(&db);
        let stop = Arc::new(AtomicBool::new(false));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let observer = {
            let (db, stop, max_seen) = (Arc::clone(&db), Arc::clone(&stop), Arc::clone(&max_seen));
            thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    max_seen.fetch_max(db.foreground_connection_waiter_count(), Ordering::SeqCst);
                    thread::yield_now();
                }
            })
        };
        let body_ran = AtomicBool::new(false);
        let started = Instant::now();
        let budget = Duration::from_millis(120);
        let skipped = db
            .try_with_conn_until(started + budget, |_| {
                body_ran.store(true, Ordering::Release);
                Ok(1)
            })
            .expect("a busy connection is not an error");
        let elapsed = started.elapsed();
        assert_eq!(skipped, None);
        assert!(!body_ran.load(Ordering::Acquire));
        assert!(elapsed >= budget, "gave up before the deadline: {elapsed:?}");
        assert!(
            elapsed < budget + Duration::from_millis(1500),
            "did not stop at the deadline: {elapsed:?}"
        );
        holder.release();
        let value = db
            .try_with_conn_until(Instant::now() + Duration::from_secs(2), |conn| {
                Ok(conn.query_row("SELECT 7", [], |row| row.get::<_, i64>(0))?)
            })
            .expect("a free connection runs");
        assert_eq!(value, Some(7));
        stop.store(true, Ordering::Release);
        observer.join().expect("observer joined");
        assert_eq!(max_seen.load(Ordering::SeqCst), 0);
        assert_eq!(db.foreground_connection_waiter_count(), 0);
    }

    /// An instant that already passed is `None` before any attempt, even when
    /// the connection is free (no work after the deadline).
    #[test]
    fn try_with_conn_until_with_a_passed_deadline_does_not_run() {
        let db = test_db();
        let ran = AtomicBool::new(false);
        let result = db
            .try_with_conn_until(Instant::now(), |_| {
                ran.store(true, Ordering::Release);
                Ok(())
            })
            .expect("not an error");
        assert_eq!(result, None);
        assert!(!ran.load(Ordering::Acquire));
    }

    /// A busy connection is retried: when the holder lets go inside the
    /// budget, the call runs (it does not give up at the first `None`).
    #[test]
    fn try_with_conn_until_takes_the_connection_when_it_is_released_in_time() {
        let db = Arc::new(test_db());
        let mut holder = Holder::new(&db);
        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            holder.release();
        });
        let value = db
            .try_with_conn_until(Instant::now() + Duration::from_secs(5), |_| Ok(9))
            .expect("not an error");
        releaser.join().expect("releaser joined");
        assert_eq!(value, Some(9));
    }

    /// A foreground caller already queued, and a reserved finalization, are not
    /// overtaken: each is "busy" until the deadline, neither adds a waiter.
    #[test]
    fn try_with_conn_until_does_not_overtake_a_queued_foreground_or_a_finalization() {
        let db = test_db();
        {
            let _queued = crate::ForegroundConnectionWaiter::new(&db.foreground_connection_waiters);
            assert_eq!(
                db.try_with_conn_until(Instant::now() + Duration::from_millis(40), |_| Ok(()))
                    .expect("not an error"),
                None
            );
            assert_eq!(db.foreground_connection_waiter_count(), 1);
        }
        db.maintenance_finalization_reserved
            .store(true, Ordering::SeqCst);
        assert_eq!(
            db.try_with_conn_until(Instant::now() + Duration::from_millis(40), |_| Ok(()))
                .expect("not an error"),
            None
        );
        assert_eq!(db.foreground_connection_waiter_count(), 0);
        db.maintenance_finalization_reserved
            .store(false, Ordering::SeqCst);
        assert_eq!(
            db.try_with_conn_until(Instant::now() + Duration::from_secs(1), |_| Ok(3))
                .expect("free again"),
            Some(3)
        );
    }

    /// A maintenance worker in no-wait mode that holds the connection while the
    /// calls run is not preempted at its next acquisition: preemption is what a
    /// published waiter would cause (`NEX_MAINTENANCE_CONNECTION_PREEMPTED`).
    /// The blocking `with_conn` from another thread would announce a waiter
    /// and fail this test.
    #[test]
    fn try_with_conn_until_does_not_preempt_a_maintenance_run() {
        let db = Arc::new(test_db());
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let maintenance_db = Arc::clone(&db);
        let maintenance = thread::spawn(move || {
            let _no_wait = maintenance_db.enter_maintenance_connection_no_wait();
            maintenance_db
                .with_conn(|_| {
                    held_tx.send(()).expect("announce held");
                    let _ = release_rx.recv();
                    Ok(())
                })
                .expect("first acquisition");
            // The reacquisition is the preemption point.
            maintenance_db.with_conn(|_| Ok(()))
        });
        held_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("maintenance holds the connection");
        for _ in 0..5 {
            assert_eq!(
                db.try_with_conn_until(Instant::now() + Duration::from_millis(20), |_| Ok(()))
                    .expect("not an error"),
                None
            );
        }
        release_tx.send(()).expect("release");
        maintenance
            .join()
            .expect("maintenance thread joined")
            .expect("the maintenance run was not preempted");
    }

    /// A worker in background-priority mode falls back to the blocking
    /// acquisition loop inside `try_lock_conn_with_check`; the deadline must
    /// still end it (as `None`), not leave it waiting on the holder.
    #[test]
    fn try_with_conn_until_ends_at_the_deadline_in_background_priority_mode() {
        let db = Arc::new(test_db());
        let _holder = Holder::new(&db);
        let started = Instant::now();
        let result = db.with_background_connection_priority(|| {
            db.try_with_conn_until(started + Duration::from_millis(100), |_| Ok(()))
        });
        assert_eq!(result.expect("not an error"), None);
        assert!(started.elapsed() < Duration::from_millis(1500));
    }

    /// A poisoned mutex is an error, never a quiet `None` (the caller would
    /// otherwise skip forever).
    #[test]
    fn try_with_conn_until_reports_a_poisoned_connection_as_an_error() {
        let db = Arc::new(test_db());
        let poisoner = Arc::clone(&db);
        let panicked = thread::spawn(move || {
            let _conn = poisoner.conn.lock().expect("lock before panic");
            panic!("poison the connection mutex");
        })
        .join();
        assert!(panicked.is_err());
        let error = db
            .try_with_conn_until(Instant::now() + Duration::from_millis(200), |_| Ok(()))
            .expect_err("poison is an error");
        assert!(error.to_string().contains("poison"), "{error}");
    }

    /// The mutable form runs a hook-registering closure like `with_conn_mut`
    /// and writes (the audit appender uses it).
    #[test]
    fn try_with_conn_mut_until_runs_a_write() {
        let db = test_db();
        let written = db
            .try_with_conn_mut_until(Instant::now() + Duration::from_secs(1), |conn| {
                conn.execute_batch("CREATE TABLE chat_ir_probe (id INTEGER)")?;
                Ok(conn.execute("INSERT INTO chat_ir_probe VALUES (1)", [])?)
            })
            .expect("not an error");
        assert_eq!(written, Some(1));
    }
}

#[cfg(test)]
#[path = "connection_deadline_tests.rs"]
mod participant_and_audit_tests;
