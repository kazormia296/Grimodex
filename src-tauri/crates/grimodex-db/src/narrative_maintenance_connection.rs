//! Process-local connection ownership for Native narrative maintenance.
//!
//! This module intentionally owns only the connection boundary.  It does not
//! persist an attempt, a generation, or a recovery decision.  A maintenance
//! caller gets one no-wait acquisition, runs its scoped work, and either
//! releases a verified clean connection or quarantines that connection for
//! the lifetime of the `Database` value.

use super::Database;
use crate::narrative_extraction::nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage};
use crate::narrative_extraction::{
    is_validation_terminated, validation_terminated, ValidationTerminationReason,
};
use anyhow::{anyhow, Result};
use rusqlite::{Connection, Error as SqliteError, ErrorCode};
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::{Duration, Instant};

const UNUSABLE_CODE: &str = "NIR1_MAINTENANCE_CONNECTION_UNUSABLE";

const TERMINATION_NONE: u8 = 0;
const TERMINATION_CANCELLED: u8 = 1;
const TERMINATION_TIMEOUT: u8 = 2;
const TERMINATION_CLOSED: u8 = 3;
const TERMINATION_WORKSPACE_GENERATION: u8 = 4;
const TERMINATION_FOREGROUND: u8 = 5;
const TERMINATION_CONTEXT_UNAVAILABLE: u8 = 6;

#[derive(Clone, Debug)]
struct TerminationLatch(Arc<AtomicU8>);

impl Default for TerminationLatch {
    fn default() -> Self {
        Self(Arc::new(AtomicU8::new(TERMINATION_NONE)))
    }
}

impl TerminationLatch {
    fn set(&self, reason: ValidationTerminationReason) {
        let code = match reason {
            ValidationTerminationReason::ContextUnavailable => TERMINATION_CONTEXT_UNAVAILABLE,
            ValidationTerminationReason::Cancelled => TERMINATION_CANCELLED,
            ValidationTerminationReason::TimedOut => TERMINATION_TIMEOUT,
            ValidationTerminationReason::Closed => TERMINATION_CLOSED,
            ValidationTerminationReason::WorkspaceGenerationChanged => {
                TERMINATION_WORKSPACE_GENERATION
            }
            ValidationTerminationReason::ForegroundPreempted => TERMINATION_FOREGROUND,
            ValidationTerminationReason::CleanupFailed => TERMINATION_NONE,
        };
        if code != TERMINATION_NONE {
            let _ = self.0.compare_exchange(
                TERMINATION_NONE,
                code,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    fn get(&self) -> Option<ValidationTerminationReason> {
        Some(match self.0.load(Ordering::Acquire) {
            TERMINATION_CONTEXT_UNAVAILABLE => ValidationTerminationReason::ContextUnavailable,
            TERMINATION_CANCELLED => ValidationTerminationReason::Cancelled,
            TERMINATION_TIMEOUT => ValidationTerminationReason::TimedOut,
            TERMINATION_CLOSED => ValidationTerminationReason::Closed,
            TERMINATION_WORKSPACE_GENERATION => {
                ValidationTerminationReason::WorkspaceGenerationChanged
            }
            TERMINATION_FOREGROUND => ValidationTerminationReason::ForegroundPreempted,
            _ => return None,
        })
    }
}

thread_local! {
    /// A top-level owner installs connection-local hooks and settings. Nested
    /// readers on that same owner must inherit them instead of replacing the
    /// hook and later clearing the owner's cancellation handler.
    static SCOPE_CONNECTIONS: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };

    #[cfg(test)]
    static FAILPOINTS: std::cell::RefCell<MaintenanceCleanupFailpoints> =
        const { std::cell::RefCell::new(MaintenanceCleanupFailpoints::NONE) };
}

struct ScopeConnectionGuard {
    connection_id: usize,
}

impl Drop for ScopeConnectionGuard {
    fn drop(&mut self) {
        SCOPE_CONNECTIONS.with(|connections| {
            let mut connections = connections.borrow_mut();
            // A panic must still unwind the scope marker. Do not leave a
            // later, unrelated connection on this worker classified as a
            // nested scope.
            if connections.last().copied() == Some(self.connection_id) {
                connections.pop();
            } else if let Some(index) = connections
                .iter()
                .rposition(|connection_id| *connection_id == self.connection_id)
            {
                connections.remove(index);
            }
        });
    }
}

fn enter_scope(conn: &Connection) -> (bool, ScopeConnectionGuard) {
    let connection_id = conn as *const Connection as usize;
    let nested = SCOPE_CONNECTIONS.with(|connections| {
        let mut connections = connections.borrow_mut();
        let nested = connections.last().copied() == Some(connection_id);
        connections.push(connection_id);
        nested
    });
    (nested, ScopeConnectionGuard { connection_id })
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

/// Process-local controls supplied by the one maintenance owner to a Graph
/// whole-project operation. The Graph producer deliberately depends on this
/// narrow shape instead of learning about scheduler or workspace state.
#[derive(Clone, Default)]
pub(crate) struct NarrativeMaintenanceGraphControlConfig {
    pub(crate) deadline: Option<Instant>,
    /// `(current_generation, expected_generation)` is supplied by the active
    /// workspace owner. A mismatch is a typed terminal condition and never a
    /// stale Source/missing Edge result.
    pub(crate) workspace_generation: Option<(Arc<AtomicU64>, u64)>,
    /// A close is distinct from an ordinary user cancellation so terminal
    /// receipts can preserve the owner supplied reason.
    pub(crate) closed: Option<Arc<AtomicBool>>,
    /// Optional owner-owned counter for the progress hook installed by this
    /// outer scope. This is diagnostic telemetry only; callback count is not
    /// an SQL work total.
    pub(crate) progress_callbacks: Option<Arc<AtomicU64>>,
    /// Masks the complete process-local stop set only while the owning attempt
    /// has acquired its per-work finalization grant. The grant is the one
    /// linearization point at which cancellation, deadline, close,
    /// foreground preemption, and workspace-generation changes must all wait
    /// for the already-authorized durable success transaction to finish.
    pub(crate) finalization_granted: Option<Arc<AtomicBool>>,
    /// Latched by the outer SQLite progress hook without re-entering the
    /// Database. A long-running SQL statement is converted to the same typed
    /// terminal reason at the operation boundary.
    termination_latch: TerminationLatch,
}

impl NarrativeMaintenanceGraphControlConfig {
    #[cfg(feature = "nir1-material-diagnostics")]
    pub(crate) fn with_progress_callbacks(progress_callbacks: Arc<AtomicU64>) -> Self {
        Self {
            progress_callbacks: Some(progress_callbacks),
            ..Self::default()
        }
    }

    pub(crate) fn with_finalization_granted(finalization_granted: Arc<AtomicBool>) -> Self {
        Self {
            finalization_granted: Some(finalization_granted),
            ..Self::default()
        }
    }
}

/// Concrete GraphWorkControl owned by the outer no-wait maintenance scope.
/// Every Rust boundary uses the same stop/deadline/generation/foreground
/// ordering, while the outer SQLite progress hook handles the stop flag while
/// SQLite is executing.
pub(crate) struct NarrativeMaintenanceGraphControl<'a> {
    db: &'a Database,
    stop: Arc<AtomicBool>,
    config: NarrativeMaintenanceGraphControlConfig,
}

impl<'a> NarrativeMaintenanceGraphControl<'a> {
    pub(crate) fn new(
        db: &'a Database,
        stop: Arc<AtomicBool>,
        config: NarrativeMaintenanceGraphControlConfig,
    ) -> Self {
        Self { db, stop, config }
    }

    fn terminal(reason: ValidationTerminationReason, stage: GraphWorkStage) -> anyhow::Error {
        validation_terminated(
            reason,
            format!("NIR1 maintenance stopped at Graph {stage:?} boundary"),
        )
    }
}

impl GraphWorkControl for NarrativeMaintenanceGraphControl<'_> {
    fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
        let finalization_granted = self
            .config
            .finalization_granted
            .as_ref()
            .is_some_and(|signal| signal.load(Ordering::Acquire));
        if finalization_granted {
            // The final grant is scoped to the exact transaction currently
            // executing. Do not latch a late stop source here: after the
            // transaction returns, the signal/current generation/deadline/
            // waiter state is observed by the next phase and later work.
            return Ok(());
        }
        if let Some(reason) = self.config.termination_latch.get() {
            return Err(Self::terminal(reason, stage));
        }
        if self
            .config
            .closed
            .as_ref()
            .is_some_and(|closed| closed.load(Ordering::Acquire))
        {
            self.config
                .termination_latch
                .set(ValidationTerminationReason::Closed);
            return Err(Self::terminal(ValidationTerminationReason::Closed, stage));
        }
        if self.stop.load(Ordering::Acquire) {
            self.config
                .termination_latch
                .set(ValidationTerminationReason::Cancelled);
            return Err(Self::terminal(
                ValidationTerminationReason::Cancelled,
                stage,
            ));
        }
        if self
            .config
            .workspace_generation
            .as_ref()
            .is_some_and(|(current, expected)| current.load(Ordering::Acquire) != *expected)
        {
            self.config
                .termination_latch
                .set(ValidationTerminationReason::WorkspaceGenerationChanged);
            return Err(Self::terminal(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                stage,
            ));
        }
        if self
            .config
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.config
                .termination_latch
                .set(ValidationTerminationReason::TimedOut);
            return Err(Self::terminal(ValidationTerminationReason::TimedOut, stage));
        }
        if self.db.foreground_connection_waiting() {
            self.config
                .termination_latch
                .set(ValidationTerminationReason::ForegroundPreempted);
            return Err(Self::terminal(
                ValidationTerminationReason::ForegroundPreempted,
                stage,
            ));
        }
        Ok(())
    }
}

/// Run a controlled Graph operation while the caller owns the exact
/// maintenance connection scope. The connection scope installs the only
/// SQLite hook/settings and quarantines the connection when cleanup fails.
pub(crate) fn with_narrative_maintenance_graph_control<T, F>(
    db: &Database,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    config: NarrativeMaintenanceGraphControlConfig,
    operation: F,
) -> Result<Option<NarrativeMaintenanceConnectionResult<T>>>
where
    F: FnOnce(&Connection, &mut dyn GraphWorkControl) -> Result<T>,
{
    let db_ref = db;
    let hook_config = config.clone();
    let config_ref = config;
    with_narrative_maintenance_connection_with_latch(
        db,
        timeout,
        progress_interval,
        stop.clone(),
        hook_config,
        move |conn| {
            let mut control = NarrativeMaintenanceGraphControl::new(db_ref, stop, config_ref);
            operation(conn, &mut control)
        },
    )
}

impl<T> NarrativeMaintenanceConnectionResult<T> {
    pub(crate) fn into_result(self) -> Result<T> {
        match (self.value, self.operation_error, self.cleanup_error) {
            (Some(value), None, None) => Ok(value),
            (None, Some(operation), None) => Err(operation),
            (None, None, Some(cleanup)) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
            )),
            (None, Some(operation), Some(cleanup)) => {
                Err(combine_operation_and_cleanup_errors(operation, cleanup))
            }
            (Some(_), Some(operation), Some(cleanup)) => {
                Err(combine_operation_and_cleanup_errors(operation, cleanup))
            }
            (Some(_), Some(operation), None) => Err(operation),
            (Some(_), None, Some(cleanup)) => Err(anyhow!(
                "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
            )),
            (None, None, None) => Err(anyhow!("NIR1_MAINTENANCE_CONNECTION_NO_RESULT")),
        }
    }
}

fn combine_operation_and_cleanup_errors(
    operation: anyhow::Error,
    cleanup: anyhow::Error,
) -> anyhow::Error {
    let operation_message = operation.to_string();
    let cleanup_message = cleanup.to_string();
    let context = format!(
        "NIR1_MAINTENANCE_CONNECTION_OPERATION_FAILED: {operation_message}; NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup_message}"
    );
    if is_validation_terminated(&operation) {
        operation.context(context)
    } else if is_validation_terminated(&cleanup) {
        cleanup.context(context)
    } else {
        operation.context(context)
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
///
/// Test-only entry point: production paths enter through
/// `with_narrative_maintenance_graph_control`.
#[cfg(test)]
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
    with_narrative_maintenance_connection_with_latch(
        db,
        timeout,
        progress_interval,
        stop,
        NarrativeMaintenanceGraphControlConfig::default(),
        operation,
    )
}

fn with_narrative_maintenance_connection_with_latch<T, F>(
    db: &Database,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    hook_config: NarrativeMaintenanceGraphControlConfig,
    operation: F,
) -> Result<Option<NarrativeMaintenanceConnectionResult<T>>>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let Some(conn) = try_lock_narrative_maintenance(db)? else {
        return Ok(None);
    };
    let result = match catch_unwind(AssertUnwindSafe(|| {
        with_narrative_maintenance_connection_scope_with_latch(
            &conn,
            timeout,
            progress_interval,
            stop,
            hook_config,
            Some(Arc::clone(&db.foreground_connection_waiters)),
            operation,
        )
    })) {
        Ok(result) => result,
        Err(payload) => {
            // run_outer_scope cleans the SQLite state before rethrowing. A
            // panic is nevertheless terminal for this shared connection;
            // fail closed before the mutex guard is returned to callers.
            db.quarantine_connection("maintenance operation panicked");
            std::panic::resume_unwind(payload);
        }
    };
    if !result.receipt.connection_reusable {
        let reason = result
            .cleanup_error
            .as_ref()
            .or(result.operation_error.as_ref())
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
///
/// Test-only entry point: production paths enter through
/// `with_narrative_maintenance_graph_control`.
#[cfg(test)]
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
    with_narrative_maintenance_connection_scope_with_latch(
        conn,
        timeout,
        progress_interval,
        stop,
        NarrativeMaintenanceGraphControlConfig::default(),
        None,
        operation,
    )
}

fn with_narrative_maintenance_connection_scope_with_latch<T, F>(
    conn: &Connection,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    hook_config: NarrativeMaintenanceGraphControlConfig,
    foreground_waiters: Option<Arc<AtomicUsize>>,
    operation: F,
) -> NarrativeMaintenanceConnectionResult<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let (nested, _scope_guard) = enter_scope(conn);

    if nested {
        let operation_result = operation(conn);
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

    run_outer_scope(
        conn,
        timeout,
        progress_interval,
        stop,
        hook_config,
        foreground_waiters,
        operation,
    )
}

fn run_outer_scope<T, F>(
    conn: &Connection,
    timeout: Duration,
    progress_interval: i32,
    stop: Arc<AtomicBool>,
    hook_config: NarrativeMaintenanceGraphControlConfig,
    foreground_waiters: Option<Arc<AtomicUsize>>,
    operation: F,
) -> NarrativeMaintenanceConnectionResult<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let mut receipt = NarrativeMaintenanceConnectionReceipt::clean();
    let mut setup_error = None;

    let original_timeout_ms: i64 =
        match conn.pragma_query_value(None, "busy_timeout", |row| row.get(0)) {
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
        let latch_for_hook = hook_config.termination_latch.clone();
        let closed_for_hook = hook_config.closed.clone();
        let generation_for_hook = hook_config.workspace_generation.clone();
        let deadline_for_hook = hook_config.deadline;
        let progress_callbacks_for_hook = hook_config.progress_callbacks.clone();
        let finalization_granted_for_hook = hook_config.finalization_granted.clone();
        let foreground_waiters_for_hook = foreground_waiters.clone();
        let hook_result = if progress_interval > 0 {
            conn.progress_handler(
                progress_interval,
                Some(move || {
                    if let Some(counter) = progress_callbacks_for_hook.as_ref() {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    let finalization_granted = finalization_granted_for_hook
                        .as_ref()
                        .is_some_and(|signal| signal.load(Ordering::Acquire));
                    if finalization_granted {
                        // The grant masks the entire stop set for this exact
                        // terminal transaction. Once it returns, the live
                        // values are checked by the next phase.
                        return false;
                    }
                    if closed_for_hook
                        .as_ref()
                        .is_some_and(|closed| closed.load(Ordering::Acquire))
                    {
                        latch_for_hook.set(ValidationTerminationReason::Closed);
                        return true;
                    }
                    if stop_for_hook.load(Ordering::Acquire) {
                        latch_for_hook.set(ValidationTerminationReason::Cancelled);
                        return true;
                    }
                    if generation_for_hook
                        .as_ref()
                        .is_some_and(|(current, expected)| {
                            current.load(Ordering::Acquire) != *expected
                        })
                    {
                        latch_for_hook.set(ValidationTerminationReason::WorkspaceGenerationChanged);
                        return true;
                    }
                    if deadline_for_hook.is_some_and(|deadline| Instant::now() >= deadline) {
                        latch_for_hook.set(ValidationTerminationReason::TimedOut);
                        return true;
                    }
                    if foreground_waiters_for_hook
                        .as_ref()
                        .is_some_and(|waiters| waiters.load(Ordering::SeqCst) > 0)
                    {
                        latch_for_hook.set(ValidationTerminationReason::ForegroundPreempted);
                        return true;
                    }
                    false
                }),
            )
        } else {
            conn.progress_handler(0, None::<fn() -> bool>)
        };
        if let Err(error) = hook_result {
            setup_error = Some(error.into());
        }
    }
    let setup_failed = setup_error.is_some();

    let (value, mut operation_error, panic_payload) = match setup_error {
        Some(error) => (None, Some(error), None),
        None => match catch_unwind(AssertUnwindSafe(|| operation(conn))) {
            Ok(Ok(value)) => (Some(value), None, None),
            Ok(Err(error)) => (None, Some(error), None),
            Err(payload) => (
                None,
                Some(anyhow!("maintenance operation panicked")),
                Some(payload),
            ),
        },
    };

    // SQLite reports a progress-hook stop as SQLITE_INTERRUPT. Preserve the
    // owner-selected terminal reason instead of exposing a generic SQL error
    // or allowing Source/Verify callers to classify the interruption as
    // missing/stale.
    if let Some(error) = operation_error.take() {
        operation_error = Some(map_interrupted_error(error, &hook_config.termination_latch));
    }

    let mut cleanup_error = None;

    // The operation owns statement/reader lifetimes. Once it returns, stop
    // SQLite from invoking the cancelling progress callback while cleanup is
    // running. This must precede rollback: with cadence=1, ROLLBACK itself
    // can otherwise be interrupted and leave the shared connection in a
    // transaction.
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

    // No transaction survives the scope. A rollback after an operation error
    // is successful cleanup; a rollback failure is retained independently.
    if !conn.is_autocommit() {
        #[cfg(test)]
        let rollback_failpoint = take_failpoint(MaintenanceCleanupFailpoint::Rollback);
        #[cfg(not(test))]
        let rollback_failpoint = false;
        if rollback_failpoint {
            append_cleanup_error(&mut cleanup_error, anyhow!("rollback failpoint"));
        } else {
            let rollback_result = conn.execute_batch("ROLLBACK");
            if let Err(error) = rollback_result {
                append_cleanup_error(&mut cleanup_error, anyhow!("rollback failed: {error}"));
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
        && !setup_failed
        && cleanup_error.is_none();

    let result = NarrativeMaintenanceConnectionResult {
        value,
        operation_error,
        cleanup_error,
        receipt,
    };
    if let Some(payload) = panic_payload {
        // All cleanup checks above have run. The outer owner catches this
        // unwind, quarantines the connection, and resumes the original panic
        // after the connection state is no longer shared with later work.
        std::panic::resume_unwind(payload);
    }
    result
}

fn append_cleanup_error(slot: &mut Option<anyhow::Error>, error: anyhow::Error) {
    if let Some(existing) = slot.take() {
        *slot = Some(anyhow!("{existing}; {error}"));
    } else {
        *slot = Some(error);
    }
}

fn map_interrupted_error(error: anyhow::Error, latch: &TerminationLatch) -> anyhow::Error {
    let interrupted = error.chain().any(|cause| {
        cause
            .downcast_ref::<SqliteError>()
            .is_some_and(|sqlite| matches!(sqlite, SqliteError::SqliteFailure(code, _) if code.code == ErrorCode::OperationInterrupted))
    });
    if let (true, Some(reason)) = (interrupted, latch.get()) {
        validation_terminated(reason, "SQLite progress hook interrupted maintenance work")
    } else {
        error
    }
}

impl Database {
    pub(crate) fn ensure_connection_reusable(&self) -> Result<()> {
        self.connection_health.ensure_reusable()
    }

    pub(crate) fn quarantine_connection(&self, reason: impl Into<String>) {
        self.connection_health.mark_unusable(reason);
    }

    /// Read the process-local cleanup/quarantine state without acquiring the
    /// SQLite mutex. Native terminal settlement uses this after a scoped
    /// maintenance operation so a foreground owner arriving afterward cannot
    /// turn cleanup bookkeeping into a blocking probe.
    pub fn connection_reusable(&self) -> bool {
        self.connection_health.is_reusable()
    }

    pub fn connection_unusable_reason(&self) -> Option<String> {
        self.connection_health.unusable_reason()
    }

    /// Retire the connection from the normal owner before a recovery
    /// descriptor is handed to a replacement authority. The SQLite handle is
    /// kept only as quarantined storage until its owning authority is dropped;
    /// no later recovery path may reuse it. A transaction still open at this
    /// boundary is not a retirement proof.
    pub fn retire_connection_for_recovery(&self) -> anyhow::Result<()> {
        // This primitive is intentionally allowed to inspect a connection
        // that was already quarantined by cleanup. `with_conn` first checks
        // the reusable flag and would make the cleanup-failure -> recovery
        // path permanently unable to emit its retirement receipt.
        self.prove_connection_retired_for_recovery()?;
        self.connection_health
            .mark_unusable("retired for exact lifecycle recovery");
        Ok(())
    }

    /// Prove that the worker-owned connection has no open transaction without
    /// changing its reusable state. A clean connection may need a recovery
    /// descriptor for an operation-level error while remaining readable by
    /// existing diagnostic callers; cleanup-quarantined connections use the
    /// stronger `retire_connection_for_recovery` wrapper above.
    pub fn prove_connection_retired_for_recovery(&self) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| anyhow!("NEX_MAINTENANCE_CONNECTION_RETIREMENT_LOCKED: {error}"))?;
        anyhow::ensure!(
            conn.is_autocommit(),
            "NEX_MAINTENANCE_CONNECTION_RETIREMENT_UNPROVEN: transaction is still active"
        );
        Ok(())
    }

    pub(crate) fn foreground_connection_waiter_count(&self) -> usize {
        self.foreground_connection_waiters.load(Ordering::SeqCst)
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
    use crate::narrative_extraction::nir1_entity_relation_index::GraphWorkStage;
    use crate::narrative_extraction::{is_validation_terminated, ValidationTerminated};
    use crate::ForegroundConnectionWaiter;
    use std::sync::mpsc;
    use std::sync::Barrier;
    use std::thread;

    fn test_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db
    }

    fn stop_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    fn termination_reason(error: anyhow::Error) -> ValidationTerminationReason {
        assert!(is_validation_terminated(&error), "{error}");
        error
            .downcast_ref::<ValidationTerminated>()
            .expect("typed validation termination")
            .reason
    }

    #[test]
    fn graph_control_maps_stop_deadline_close_and_generation_to_typed_terms() {
        let db = test_db();

        let stopped = Arc::new(AtomicBool::new(true));
        let mut control = NarrativeMaintenanceGraphControl::new(
            &db,
            stopped,
            NarrativeMaintenanceGraphControlConfig::default(),
        );
        assert_eq!(
            termination_reason(control.check(GraphWorkStage::Page).expect_err("cancel")),
            ValidationTerminationReason::Cancelled
        );

        let mut control = NarrativeMaintenanceGraphControl::new(
            &db,
            stop_flag(),
            NarrativeMaintenanceGraphControlConfig {
                deadline: Some(Instant::now() - Duration::from_millis(1)),
                ..Default::default()
            },
        );
        assert_eq!(
            termination_reason(control.check(GraphWorkStage::Digest).expect_err("deadline")),
            ValidationTerminationReason::TimedOut
        );

        let closed = Arc::new(AtomicBool::new(true));
        let mut control = NarrativeMaintenanceGraphControl::new(
            &db,
            stop_flag(),
            NarrativeMaintenanceGraphControlConfig {
                closed: Some(closed),
                ..Default::default()
            },
        );
        assert_eq!(
            termination_reason(control.check(GraphWorkStage::Restore).expect_err("closed")),
            ValidationTerminationReason::Closed
        );

        let generation = Arc::new(AtomicU64::new(2));
        let mut control = NarrativeMaintenanceGraphControl::new(
            &db,
            stop_flag(),
            NarrativeMaintenanceGraphControlConfig {
                workspace_generation: Some((generation, 1)),
                ..Default::default()
            },
        );
        assert_eq!(
            termination_reason(
                control
                    .check(GraphWorkStage::ColdReopen)
                    .expect_err("workspace generation")
            ),
            ValidationTerminationReason::WorkspaceGenerationChanged
        );
    }

    #[test]
    fn graph_control_preempts_after_connection_acquisition_when_foreground_arrives() {
        let db = Arc::new(test_db());
        let owner = try_lock_narrative_maintenance(&db)
            .expect("try lock")
            .expect("maintenance owner");
        let (foreground_waiting_tx, foreground_waiting_rx) = mpsc::channel();
        let foreground_db = Arc::clone(&db);
        let foreground = thread::spawn(move || {
            // Publish the foreground arrival before entering the real
            // blocking acquisition path. The owner is still held, so this
            // waiter remains observable until maintenance releases it.
            // A channel handshake (not a bounded yield spin) synchronizes
            // the arrival so the test stays deterministic under Full-CI
            // parallel load.
            let _waiter =
                ForegroundConnectionWaiter::new(&foreground_db.foreground_connection_waiters);
            foreground_waiting_tx
                .send(())
                .expect("foreground waiter signal");
            foreground_db.with_conn(|_| Ok(()))
        });
        foreground_waiting_rx
            .recv()
            .expect("foreground waiter arrived");
        assert!(db.foreground_connection_waiting());
        let mut control = NarrativeMaintenanceGraphControl::new(
            &db,
            stop_flag(),
            NarrativeMaintenanceGraphControlConfig::default(),
        );
        assert_eq!(
            termination_reason(control.check(GraphWorkStage::Edge).expect_err("preempt")),
            ValidationTerminationReason::ForegroundPreempted
        );
        drop(owner);
        foreground
            .join()
            .expect("foreground join")
            .expect("foreground");
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
        let (foreground_waiting_tx, foreground_waiting_rx) = mpsc::channel();
        let foreground_db = Arc::clone(&db);
        let foreground = thread::spawn(move || {
            // Publish the foreground arrival before entering the real
            // blocking acquisition path. The owner is still held, so this
            // waiter remains observable until maintenance releases it.
            let _waiter =
                ForegroundConnectionWaiter::new(&foreground_db.foreground_connection_waiters);
            foreground_waiting_tx
                .send(())
                .expect("foreground waiter signal");
            foreground_db.with_conn(|_| Ok(()))
        });
        foreground_waiting_rx
            .recv()
            .expect("foreground waiter published");
        assert!(db.foreground_connection_waiting());
        drop(owner);
        foreground
            .join()
            .expect("foreground join")
            .expect("foreground");
    }

    #[test]
    fn foreground_waiter_admission_precedes_finalization_reservation() {
        let db = Arc::new(test_db());
        let waiter_published = Arc::new(Barrier::new(2));
        let release_waiter = Arc::new(Barrier::new(2));
        let waiter_db = Arc::clone(&db);
        let waiter_published_for_thread = Arc::clone(&waiter_published);
        let release_waiter_for_thread = Arc::clone(&release_waiter);
        let foreground = thread::spawn(move || {
            let waiter = ForegroundConnectionWaiter::new(&waiter_db.foreground_connection_waiters);
            waiter_published_for_thread.wait();
            release_waiter_for_thread.wait();
            drop(waiter);
        });

        // The barrier is released only after the waiter increment is complete,
        // so this is the exact interleaving in which a foreground owner arrives
        // immediately before a maintenance finalization attempt.
        waiter_published.wait();
        assert_eq!(db.foreground_connection_waiter_count(), 1);
        assert!(db.try_reserve_maintenance_finalization().is_none());

        release_waiter.wait();
        foreground.join().expect("foreground waiter thread");
        assert_eq!(db.foreground_connection_waiter_count(), 0);
        assert!(db.try_reserve_maintenance_finalization().is_some());
    }

    #[test]
    fn finalization_reservation_precedes_late_foreground_waiter_admission() {
        let db = Arc::new(test_db());
        let reservation_cas_reached = Arc::new(Barrier::new(2));
        let allow_reservation_post_check = Arc::new(Barrier::new(2));
        let reservation_db = Arc::clone(&db);
        let reservation_cas_reached_for_thread = Arc::clone(&reservation_cas_reached);
        let allow_reservation_post_check_for_thread = Arc::clone(&allow_reservation_post_check);
        let finalizer = thread::spawn(move || {
            let reservation = reservation_db.try_reserve_maintenance_finalization_with_hook(|| {
                reservation_cas_reached_for_thread.wait();
                allow_reservation_post_check_for_thread.wait();
            });
            assert!(
                reservation.is_none(),
                "late waiter must cancel the reservation"
            );
        });

        // Pause after the reservation CAS and publish the foreground waiter
        // before allowing the maintenance thread's post-CAS check to run.
        reservation_cas_reached.wait();
        let waiter = ForegroundConnectionWaiter::new(&db.foreground_connection_waiters);
        assert_eq!(db.foreground_connection_waiter_count(), 1);
        allow_reservation_post_check.wait();
        finalizer.join().expect("finalization reservation thread");
        drop(waiter);
        assert_eq!(db.foreground_connection_waiter_count(), 0);
        assert!(db.try_reserve_maintenance_finalization().is_some());
    }

    #[test]
    fn public_no_wait_entry_is_scoped_and_fails_fast() {
        let db = test_db();
        let held = db.lock().expect("hold connection");
        let no_wait = db.enter_maintenance_connection_no_wait();
        let result = db.with_conn(|_| Ok::<_, anyhow::Error>(()));
        let error = result.expect_err("no-wait entry must not block on owner");
        assert!(error
            .to_string()
            .starts_with("NEX_MAINTENANCE_CONNECTION_PREEMPTED"));
        drop(no_wait);
        drop(held);
        db.with_conn(|_| Ok::<_, anyhow::Error>(()))
            .expect("dropping the guard restores normal acquisition");
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
        assert!(result.receipt.connection_reusable);
        let timeout: i64 = db
            .with_conn(|conn| Ok(conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?))
            .expect("read timeout");
        assert_eq!(timeout, 5_000);
    }

    #[test]
    fn sqlite_progress_interrupt_is_returned_as_typed_termination() {
        let db = test_db();
        let stop = Arc::new(AtomicBool::new(true));
        let result = with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop, |conn| {
            conn.execute_batch(
                "WITH RECURSIVE walk(value) AS (
                         SELECT 1
                         UNION ALL SELECT value + 1 FROM walk WHERE value < 1000000
                     ) SELECT sum(value) FROM walk;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("acquisition")
        .expect("scope");
        let error = result.into_result().expect_err("interrupt must stop work");
        assert_eq!(
            termination_reason(error),
            ValidationTerminationReason::Cancelled
        );
        assert!(db.connection_reusable());
    }

    #[test]
    fn latched_cancellation_clears_progress_before_rollback() {
        let db = test_db();
        let stop = Arc::new(AtomicBool::new(true));
        let result = with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop, |conn| {
                conn.execute_batch("BEGIN")?;
                assert!(!conn.is_autocommit());
                Err::<(), _>(validation_terminated(
                    ValidationTerminationReason::Cancelled,
                    "ordinary cancellation",
                ))
        })
        .expect("acquisition")
        .expect("scope");
        let error = result
            .into_result()
            .expect_err("ordinary cancellation must remain an error");
        assert_eq!(
            termination_reason(error),
            ValidationTerminationReason::Cancelled
        );
        assert!(db.connection_reusable());
        db.with_conn(|conn| {
            assert!(conn.is_autocommit());
            Ok::<_, anyhow::Error>(())
        })
        .expect("connection must be reusable after cancellation cleanup");
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
    fn retirement_receipt_can_be_emitted_after_cleanup_quarantine() {
        let db = test_db();
        db.quarantine_connection("cleanup proof unavailable");
        assert!(!db.connection_reusable());

        // Retirement must inspect the already-quarantined handle directly;
        // routing through the normal reusable-only accessor would deadlock
        // exact CreationUnknown recovery forever.
        db.retire_connection_for_recovery()
            .expect("quarantined autocommit connection is retired");
        assert!(!db.connection_reusable());
        assert!(db.connection_unusable_reason().is_some());
    }

    #[test]
    fn typed_cancellation_and_cleanup_failure_preserve_both_and_quarantine() {
        let db = test_db();
        set_maintenance_cleanup_failpoints_for_test(MaintenanceCleanupFailpoints {
            rollback: false,
            autocommit_check: false,
            progress_reset: true,
            busy_timeout_restore: false,
        });
        let result =
            with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop_flag(), |conn| {
                conn.execute_batch("BEGIN")?;
                Err::<(), _>(validation_terminated(
                    ValidationTerminationReason::Cancelled,
                    "typed cancellation",
                ))
            })
        .expect("acquisition")
        .expect("scope");
        assert!(!result.receipt.connection_reusable);
        let error = result
            .into_result()
            .expect_err("operation and cleanup errors must remain errors");
        assert!(is_validation_terminated(&error));
        let message = error.to_string();
        assert!(message.contains("typed cancellation"));
        assert!(message.contains("progress handler reset failpoint"));
        assert!(!db.connection_reusable());
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

    #[test]
    fn all_cleanup_failures_are_aggregated_and_quarantine_connection() {
        let db = test_db();
        set_maintenance_cleanup_failpoints_for_test(MaintenanceCleanupFailpoints {
            rollback: true,
            autocommit_check: true,
            progress_reset: true,
            busy_timeout_restore: true,
        });
        let result =
            with_narrative_maintenance_connection(&db, Duration::ZERO, 1, stop_flag(), |conn| {
                conn.execute_batch("BEGIN")?;
                Err::<(), _>(anyhow!("operation failpoint"))
            })
            .expect("acquisition")
            .expect("scope");
        assert!(!result.receipt.connection_reusable);
        let error = result.into_result().expect_err("cleanup must fail");
        let message = error.to_string();
        for fragment in [
            "operation failpoint",
            "rollback failpoint",
            "progress handler reset failpoint",
            "busy timeout restore failpoint",
            "autocommit verification failpoint",
        ] {
            assert!(
                message.contains(fragment),
                "missing '{fragment}' in {message}"
            );
        }
        assert!(!db.connection_reusable());
        let reason = db.connection_unusable_reason().expect("quarantine reason");
        for fragment in [
            "rollback failpoint",
            "progress handler reset failpoint",
            "busy timeout restore failpoint",
            "autocommit verification failpoint",
        ] {
            assert!(
                reason.contains(fragment),
                "missing '{fragment}' in {reason}"
            );
        }
    }

    #[test]
    fn panic_unwinds_scope_cleanup_and_quarantines_connection() {
        let db = test_db();
        let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: Result<Option<NarrativeMaintenanceConnectionResult<()>>> =
                with_narrative_maintenance_connection(
                    &db,
                    Duration::ZERO,
                    1,
                    stop_flag(),
                    |conn| {
                        conn.execute_batch("BEGIN")?;
                        panic!("maintenance panic test")
                    },
                );
        }));
        assert!(panic_result.is_err());
        assert!(!db.connection_reusable());
        assert!(db
            .connection_unusable_reason()
            .expect("quarantine reason")
            .contains("panicked"));
        assert!(db.with_conn(|_| Ok(())).is_err());
    }
}
