//! Process-local connection ownership for Native narrative maintenance.
//!
//! This module intentionally owns only the connection boundary.  It does not
//! persist an attempt, a generation, or a recovery decision.  A maintenance
//! caller gets one no-wait acquisition, runs its scoped work, and either
//! releases a verified clean connection or quarantines that connection for
//! the lifetime of the `Database` value.

use super::Database;
use anyhow::{anyhow, Result};
use rusqlite::Connection;
use std::cell::Cell;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::Duration;

const UNUSABLE_CODE: &str = "NIR1_MAINTENANCE_CONNECTION_UNUSABLE";

thread_local! {
    /// A top-level owner installs connection-local hooks and settings. Nested
    /// readers on that same owner must inherit them instead of replacing the
    /// hook and later clearing the owner's cancellation handler.
    static SCOPE_DEPTH: Cell<usize> = const { Cell::new(0) };

    #[cfg(test)]
    static FAILPOINTS: std::cell::RefCell<MaintenanceCleanupFailpoints> =
        const { std::cell::RefCell::new(MaintenanceCleanupFailpoints::NONE) };
}

#[derive(Debug)]
pub(crate) struct ConnectionHealth {
    unusable: AtomicBool,
    reason: Mutex<Option<String>>,
}

impl ConnectionHealth {
    pub(crate) fn new() -> Self {
        Self {
            unusable: AtomicBool::new(false),
            reason: Mutex::new(None),
        }
    }

    fn ensure_reusable(&self) -> Result<()> {
        if !self.unusable.load(Ordering::Acquire) {
            return Ok(());
        }
        let reason = self
            .reason
            .lock()
            .map_err(|error| anyhow!("{UNUSABLE_CODE}: health lock poisoned: {error}"))?
            .clone()
            .unwrap_or_else(|| "connection cleanup failed".to_string());
        Err(anyhow!("{UNUSABLE_CODE}: {reason}"))
    }

    pub(crate) fn mark_unusable(&self, reason: impl Into<String>) {
        let reason = reason.into();
        self.unusable.store(true, Ordering::Release);
        if let Ok(mut current) = self.reason.lock() {
            if current.is_none() {
                *current = Some(reason);
            }
        }
    }

    pub(crate) fn is_reusable(&self) -> bool {
        !self.unusable.load(Ordering::Acquire)
    }

    pub(crate) fn unusable_reason(&self) -> Option<String> {
        self.reason.lock().ok().and_then(|reason| reason.clone())
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct NarrativeMaintenanceConnectionReceipt {
    pub(crate) connection_reusable: bool,
    pub(crate) transaction_clean: bool,
    pub(crate) progress_handler_cleared: bool,
    pub(crate) busy_timeout_restored: bool,
}

impl NarrativeMaintenanceConnectionReceipt {
    fn clean() -> Self {
        Self {
            connection_reusable: true,
            transaction_clean: true,
            progress_handler_cleared: true,
            busy_timeout_restored: true,
        }
    }
}

#[derive(Debug)]
pub(crate) struct NarrativeMaintenanceConnectionResult<T> {
    pub(crate) value: Option<T>,
    pub(crate) operation_error: Option<anyhow::Error>,
    pub(crate) cleanup_error: Option<anyhow::Error>,
    pub(crate) receipt: NarrativeMaintenanceConnectionReceipt,
}

impl<T> NarrativeMaintenanceConnectionResult<T> {
    pub(crate) fn into_result(self) -> Result<T> {
        match (self.value, self.operation_error, self.cleanup_error) {
            (Some(value), None, None) => Ok(value),
            (None, Some(operation), None) => Err(operation),
            (None, None, Some(cleanup)) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
            )),
            (None, Some(operation), Some(cleanup)) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_OPERATION_FAILED: {operation}; NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
            )),
            (Some(_), Some(operation), Some(cleanup)) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_OPERATION_FAILED: {operation}; NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
            )),
            (Some(_), Some(operation), None) => Err(operation),
            (Some(_), None, Some(cleanup)) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
            )),
            (None, None, None) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_NO_RESULT"
            )),
        }
    }
}

/// The outer owner uses this to acquire the shared connection. `None` means
/// the caller must defer; this method never sleeps and never uses SQLite's
/// busy handler. A foreground waiter is checked both before and after the
/// mutex acquisition so a maintenance caller cannot win a hand-off race.
pub(crate) fn try_lock_narrative_maintenance<'a>(
    db: &'a Database,
) -> Result<Option<MutexGuard<'a, Connection>>> {
    db.ensure_connection_reusable()?;
    if db.foreground_connection_waiter_count() > 0 {
        return Ok(None);
    }

    let guard = match db.conn.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
        Err(std::sync::TryLockError::Poisoned(error)) => {
            return Err(anyhow!("database connection mutex poisoned: {error}"));
        }
    };

    db.ensure_connection_reusable()?;
    if db.foreground_connection_waiter_count() > 0 {
        drop(guard);
        return Ok(None);
    }
    Ok(Some(guard))
}

/// Execute one top-level Native maintenance scope. The lock acquisition is
/// deliberately no-wait. Callers can distinguish a temporary `Deferred`
/// result from an operation/cleanup failure without changing durable state.
pub(crate) fn with_narrative_maintenance_connection<T, F>(
    db: &Database,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    operation: F,
) -> Result<Option<NarrativeMaintenanceConnectionResult<T>>>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let Some(conn) = try_lock_narrative_maintenance(db)? else {
        return Ok(None);
    };
    let result = with_narrative_maintenance_connection_scope(
        &conn,
        timeout,
        progress_interval,
        stop,
        operation,
    );
    if !result.receipt.connection_reusable {
        let reason = result
            .cleanup_error
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| "maintenance connection cleanup failed".to_string());
        db.quarantine_connection(reason);
    }
    Ok(Some(result))
}

/// Execute work against an already acquired connection. Only the outermost
/// scope changes SQLite settings or installs a progress hook. Nested Native
/// readers therefore inherit the cancellation hook and busy timeout owned by
/// the maintenance attempt.
pub(crate) fn with_narrative_maintenance_connection_scope<T, F>(
    conn: &Connection,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    operation: F,
) -> NarrativeMaintenanceConnectionResult<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let nested = SCOPE_DEPTH.with(|depth| {
        let current = depth.get();
        depth.set(current.saturating_add(1));
        current > 0
    });

    if nested {
        let operation_result = operation(conn);
        SCOPE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
        return match operation_result {
            Ok(value) => NarrativeMaintenanceConnectionResult {
                value: Some(value),
                operation_error: None,
                cleanup_error: None,
                receipt: NarrativeMaintenanceConnectionReceipt::clean(),
            },
            Err(error) => NarrativeMaintenanceConnectionResult {
                value: None,
                operation_error: Some(error),
                cleanup_error: None,
                receipt: NarrativeMaintenanceConnectionReceipt::clean(),
            },
        };
    }

    let result = run_outer_scope(conn, timeout, progress_interval, stop, operation);
    SCOPE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    result
}

fn run_outer_scope<T, F>(
    conn: &Connection,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    operation: F,
) -> NarrativeMaintenanceConnectionResult<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let mut receipt = NarrativeMaintenanceConnectionReceipt::clean();
    let mut setup_error = None;

    let original_timeout_ms = match conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))
    {
        Ok(value) if value >= 0 => value,
        Ok(value) => {
            setup_error = Some(anyhow!("SQLite returned a negative busy_timeout: {value}"));
            0
        }
        Err(error) => {
            setup_error = Some(error.into());
            0
        }
    };

    if setup_error.is_none() {
        if let Err(error) = conn.busy_timeout(timeout) {
            setup_error = Some(error.into());
        }
    }

    if setup_error.is_none() {
        let stop_for_hook = Arc::clone(&stop);
        let hook_result = if progress_interval > 0 {
            conn.progress_handler(
                progress_interval,
                Some(move || stop_for_hook.load(Ordering::Acquire)),
            )
        } else {
            conn.progress_handler(0, None::<fn() -> bool>)
        };
        if let Err(error) = hook_result {
            setup_error = Some(error.into());
        }
    }

    let (value, operation_error) = match setup_error {
        Some(error) => (None, Some(error)),
        None => match operation(conn) {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        },
    };

    let mut cleanup_error = None;

    // The operation owns statement/reader lifetimes. Once it returns, ensure
    // no transaction survives the scope. A rollback after an operation error
    // is successful cleanup; a rollback failure is retained independently.
    if !conn.is_autocommit() {
        #[cfg(test)]
        let rollback_failpoint = take_failpoint(MaintenanceCleanupFailpoint::Rollback);
        #[cfg(not(test))]
        let rollback_failpoint = false;
        if rollback_failpoint {
            cleanup_error = Some(anyhow!("rollback failpoint"));
        } else {
            let rollback_result = conn.execute_batch("ROLLBACK");
            if let Err(error) = rollback_result {
                cleanup_error = Some(anyhow!("rollback failed: {error}"));
            }
        }
        if !conn.is_autocommit() {
            append_cleanup_error(
                &mut cleanup_error,
                anyhow!("SQLite transaction remained open after cleanup"),
            );
        }
    }
    receipt.transaction_clean = conn.is_autocommit();

    // Always attempt to clear the hook, even when the operation failed. The
    // failpoint is applied after the real reset so tests model a reported
    // cleanup failure without leaking a callback into the next operation.
    let progress_reset_result = conn.progress_handler(0, None::<fn() -> bool>);
    if let Err(error) = progress_reset_result {
        append_cleanup_error(&mut cleanup_error, error.into());
        receipt.progress_handler_cleared = false;
    }
    #[cfg(test)]
    if take_failpoint(MaintenanceCleanupFailpoint::ProgressReset) {
        append_cleanup_error(
            &mut cleanup_error,
            anyhow!("progress handler reset failpoint"),
        );
        receipt.progress_handler_cleared = false;
    }

    let restored_timeout = conn.busy_timeout(Duration::from_millis(original_timeout_ms as u64));
    if let Err(error) = restored_timeout {
        append_cleanup_error(&mut cleanup_error, error.into());
        receipt.busy_timeout_restored = false;
    }
    #[cfg(test)]
    if take_failpoint(MaintenanceCleanupFailpoint::BusyTimeoutRestore) {
        append_cleanup_error(
            &mut cleanup_error,
            anyhow!("busy timeout restore failpoint"),
        );
        receipt.busy_timeout_restored = false;
    }

    #[cfg(test)]
    if take_failpoint(MaintenanceCleanupFailpoint::AutocommitCheck) {
        append_cleanup_error(
            &mut cleanup_error,
            anyhow!("autocommit verification failpoint"),
        );
        receipt.transaction_clean = false;
    }

    receipt.connection_reusable = receipt.transaction_clean
        && receipt.progress_handler_cleared
        && receipt.busy_timeout_restored
        && cleanup_error.is_none();

    NarrativeMaintenanceConnectionResult {
        value,
        operation_error,
        cleanup_error,
        receipt,
    }
}

fn append_cleanup_error(slot: &mut Option<anyhow::Error>, error: anyhow::Error) {
    if let Some(existing) = slot.take() {
        *slot = Some(anyhow!("{existing}; {error}"));
    } else {
        *slot = Some(error);
    }
}

impl Database {
    pub(crate) fn try_lock_narrative_maintenance(
        &self,
    ) -> Result<Option<MutexGuard<'_, Connection>>> {
        try_lock_narrative_maintenance(self)
    }

    pub(crate) fn ensure_connection_reusable(&self) -> Result<()> {
        self.connection_health.ensure_reusable()
    }

    pub(crate) fn quarantine_connection(&self, reason: impl Into<String>) {
        self.connection_health.mark_unusable(reason);
    }

    pub(crate) fn connection_reusable(&self) -> bool {
        self.connection_health.is_reusable()
    }

    pub(crate) fn connection_unusable_reason(&self) -> Option<String> {
        self.connection_health.unusable_reason()
    }

    pub(crate) fn foreground_connection_waiter_count(&self) -> usize {
        self.foreground_connection_waiters.load(Ordering::Acquire)
    }

    pub(crate) fn foreground_connection_waiting(&self) -> bool {
        self.foreground_connection_waiter_count() > 0
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MaintenanceCleanupFailpoint {
    Rollback,
    AutocommitCheck,
    ProgressReset,
    BusyTimeoutRestore,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MaintenanceCleanupFailpoints {
    rollback: bool,
    autocommit_check: bool,
    progress_reset: bool,
    busy_timeout_restore: bool,
}

#[cfg(test)]
impl MaintenanceCleanupFailpoints {
    const NONE: Self = Self {
        rollback: false,
        autocommit_check: false,
        progress_reset: false,
        busy_timeout_restore: false,
    };
}

#[cfg(test)]
fn take_failpoint(point: MaintenanceCleanupFailpoint) -> bool {
    FAILPOINTS.with(|failpoints| {
        let mut failpoints = failpoints.borrow_mut();
        let active = match point {
            MaintenanceCleanupFailpoint::Rollback => failpoints.rollback,
            MaintenanceCleanupFailpoint::AutocommitCheck => failpoints.autocommit_check,
            MaintenanceCleanupFailpoint::ProgressReset => failpoints.progress_reset,
            MaintenanceCleanupFailpoint::BusyTimeoutRestore => failpoints.busy_timeout_restore,
        };
        match point {
            MaintenanceCleanupFailpoint::Rollback => failpoints.rollback = false,
            MaintenanceCleanupFailpoint::AutocommitCheck => failpoints.autocommit_check = false,
            MaintenanceCleanupFailpoint::ProgressReset => failpoints.progress_reset = false,
            MaintenanceCleanupFailpoint::BusyTimeoutRestore => {
                failpoints.busy_timeout_restore = false
            }
        }
        active
    })
}

#[cfg(test)]
fn set_maintenance_cleanup_failpoints_for_test(failpoints: MaintenanceCleanupFailpoints) {
    FAILPOINTS.with(|current| *current.borrow_mut() = failpoints);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    fn test_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db
    }

    fn stop_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn maintenance_acquisition_is_true_no_wait_and_observes_foreground_arrival() {
        let db = Arc::new(test_db());
        let held = db.lock().expect("hold database connection");
        let (done_tx, done_rx) = mpsc::channel();
        let db_for_thread = Arc::clone(&db);
        let thread = thread::spawn(move || {
            let result = try_lock_narrative_maintenance(&db_for_thread).expect("try lock");
            assert!(result.is_none());
            done_tx.send(()).expect("done signal");
        });
        done_rx.recv().expect("try lock returned");
        drop(held);
        thread.join().expect("join");

        let owner = try_lock_narrative_maintenance(&db)
            .expect("try lock")
            .expect("available after release");
        let foreground_db = Arc::clone(&db);
        let foreground = thread::spawn(move || foreground_db.with_conn(|_| Ok(())));
        for _ in 0..1000 {
            if db.foreground_connection_waiting() {
                break;
            }
            thread::yield_now();
        }
        assert!(db.foreground_connection_waiting());
        drop(owner);
        foreground
            .join()
            .expect("foreground join")
            .expect("foreground");
    }

    #[test]
    fn scope_restores_timeout_progress_and_autocommit() {
        let db = test_db();
        let result =
            with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop_flag(), |conn| {
                conn.execute_batch("BEGIN; SELECT 1; COMMIT;")?;
                Ok(7usize)
            })
            .expect("acquisition")
            .expect("scope");
        assert_eq!(result.value, Some(7));
        assert!(result.operation_error.is_none());
        assert!(result.cleanup_error.is_none());
        assert_eq!(result.receipt.connection_reusable, true);
        let timeout: i64 = db
            .with_conn(|conn| Ok(conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?))
            .expect("read timeout");
        assert_eq!(timeout, 5_000);
    }

    #[test]
    fn operation_and_cleanup_errors_are_both_preserved_and_quarantine_connection() {
        let db = test_db();
        set_maintenance_cleanup_failpoints_for_test(MaintenanceCleanupFailpoints {
            rollback: true,
            autocommit_check: false,
            progress_reset: false,
            busy_timeout_restore: true,
        });
        let result =
            with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop_flag(), |conn| {
                conn.execute_batch("BEGIN")?;
                Err::<(), _>(anyhow!("operation failpoint"))
            })
            .expect("acquisition")
            .expect("scope");
        let error = result.into_result().expect_err("scope must fail");
        let message = error.to_string();
        assert!(message.contains("operation failpoint"));
        assert!(message.contains("busy timeout restore failpoint"));
        assert!(!db.connection_reusable());
        assert!(db
            .connection_unusable_reason()
            .expect("reason")
            .contains("busy timeout restore failpoint"));
        assert!(try_lock_narrative_maintenance(&db).is_err());
    }

    #[test]
    fn nested_scope_does_not_replace_or_clear_outer_progress_handler() {
        let db = test_db();
        let result =
            with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop_flag(), |conn| {
                let nested = with_narrative_maintenance_connection_scope(
                    conn,
                    Duration::from_millis(123),
                    1,
                    stop_flag(),
                    |_| Ok("nested"),
                );
                assert_eq!(nested.value, Some("nested"));
                assert!(nested.receipt.connection_reusable);
                Ok("outer")
            })
            .expect("acquisition")
            .expect("scope");
        assert_eq!(result.value, Some("outer"));
        assert!(result.receipt.connection_reusable);
    }

    #[test]
    fn cleanup_failpoints_report_hook_and_autocommit_failures() {
        let db = test_db();
        set_maintenance_cleanup_failpoints_for_test(MaintenanceCleanupFailpoints {
            rollback: false,
            autocommit_check: true,
            progress_reset: true,
            busy_timeout_restore: false,
        });
        let result =
            with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop_flag(), |conn| {
                conn.execute_batch("BEGIN; COMMIT")?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("acquisition")
            .expect("scope");
        assert!(result.operation_error.is_none());
        let error = result.into_result().expect_err("cleanup must fail");
        let message = error.to_string();
        assert!(message.contains("progress handler reset failpoint"));
        assert!(message.contains("autocommit verification failpoint"));
        assert!(!db.connection_reusable());
    }
}
