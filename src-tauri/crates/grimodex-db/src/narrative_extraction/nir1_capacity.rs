//! Ratified B full-set resource budget. The existing owner still controls
//! cancellation, transactions and cleanup; this module adds no authority.
//! See docs/plans/nir1-b-close-completion-2026-09-22.md.

pub(crate) const MATERIAL_LIMIT: usize = 8_192;
pub(crate) const REVISION_LIMIT: usize = 1_024;
pub(crate) const CANDIDATE_LIMIT: usize = 2_064;
pub(crate) const INPUT_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const ROSTER_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const STORED_COLLECTION_LIMIT: usize = MATERIAL_LIMIT + 1;
pub(crate) const SQL_PROGRESS_LIMIT: u64 = 600_000_000;
pub(crate) const DEADLINE: std::time::Duration = std::time::Duration::from_secs(180);

pub(crate) const AUDITED_SQLITE_SOURCE_ID: &str =
    "2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24";
use super::nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage};
use super::source_revision::{validation_terminated, ValidationTerminationReason};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Instant;

pub(crate) struct CapacityBudget {
    steps: AtomicU64,
    step_limit: u64,
    deadline: Instant,
}

impl CapacityBudget {
    pub(crate) fn supported() -> Arc<Self> {
        Self::new(SQL_PROGRESS_LIMIT, Instant::now() + DEADLINE)
    }

    pub(crate) fn new(step_limit: u64, deadline: Instant) -> Arc<Self> {
        Arc::new(Self {
            steps: AtomicU64::new(0),
            step_limit,
            deadline,
        })
    }

    fn check(&self, grant: Option<&Arc<AtomicBool>>) -> anyhow::Result<()> {
        if self.steps.load(Ordering::Relaxed) > self.step_limit {
            return Err(validation_terminated(
                ValidationTerminationReason::CapacityExceeded,
                "NIR1 Graph SQL capacity exceeded",
            ));
        }
        if !grant.is_some_and(|grant| grant.load(Ordering::Acquire))
            && Instant::now() >= self.deadline
        {
            return Err(validation_terminated(
                ValidationTerminationReason::CapacityExceeded,
                "NIR1 Graph capacity deadline exceeded",
            ));
        }
        Ok(())
    }

    fn step(&self, grant: Option<&Arc<AtomicBool>>) -> bool {
        let steps = self.steps.fetch_add(1, Ordering::Relaxed).saturating_add(1);
        steps > self.step_limit
            || (steps.is_multiple_of(1_000)
                && !grant.is_some_and(|grant| grant.load(Ordering::Acquire))
                && Instant::now() >= self.deadline)
    }
}

#[derive(Clone)]
struct ActiveBudget {
    budget: Arc<CapacityBudget>,
    grant: Option<Arc<AtomicBool>>,
}

impl ActiveBudget {
    fn check(&self) -> anyhow::Result<()> {
        self.budget.check(self.grant.as_ref())
    }
}

struct ProgressOwner {
    callback: Box<dyn FnMut() -> bool + Send>,
    interval: i32,
}

#[derive(Default)]
struct ProgressState {
    owner: Option<Arc<Mutex<ProgressOwner>>>,
    budgets: Vec<ActiveBudget>,
}

type SharedProgress = Arc<Mutex<ProgressState>>;
static OWNERS: LazyLock<Mutex<HashMap<usize, Weak<Mutex<ProgressState>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn state_for(conn: &Connection) -> SharedProgress {
    // SAFETY: the live borrowed Connection owns the handle. It is used only
    // as a stable key; the registry stores Weak Rust owners, never raw access.
    let key = unsafe { conn.handle() } as usize;
    let mut owners = OWNERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(state) = owners.get(&key).and_then(Weak::upgrade) {
        return state;
    }
    owners.retain(|_, owner| owner.strong_count() != 0);
    let state = Arc::new(Mutex::new(ProgressState::default()));
    owners.insert(key, Arc::downgrade(&state));
    state
}

fn install(conn: &Connection, state: SharedProgress) -> rusqlite::Result<()> {
    let (owner, budgets) = {
        let state = state.lock().unwrap_or_else(|e| e.into_inner());
        (state.owner.clone(), state.budgets.clone())
    };
    let owner_interval = owner
        .as_ref()
        .map(|owner| owner.lock().unwrap_or_else(|e| e.into_inner()).interval);
    let interval = if !budgets.is_empty() {
        1
    } else {
        owner_interval.unwrap_or(0)
    };
    if interval == 0 {
        return crate::install_sqlite_progress_handler(conn, 0, None::<fn() -> bool>);
    }
    let mut pending = 0;
    // Copy the finite observer list when installing; no registry/state mutex
    // is acquired per opcode. The existing owner is called at its own cadence.
    crate::install_sqlite_progress_handler(
        conn,
        interval,
        Some(move || {
            let _keep_registered_state_alive = &state;
            let mut stop = false;
            for active in &budgets {
                stop |= active.budget.step(active.grant.as_ref());
            }
            if let (Some(owner), Some(owner_interval)) = (&owner, owner_interval) {
                pending += interval;
                if pending >= owner_interval {
                    pending %= owner_interval;
                    stop |= (owner.lock().unwrap_or_else(|e| e.into_inner()).callback)();
                }
            }
            stop
        }),
    )
}

pub(crate) fn set_progress_owner<F>(
    conn: &Connection,
    interval: i32,
    callback: Option<F>,
) -> rusqlite::Result<()>
where
    F: FnMut() -> bool + Send + 'static,
{
    let state = state_for(conn);
    state.lock().unwrap_or_else(|e| e.into_inner()).owner =
        callback.filter(|_| interval > 0).map(|callback| {
            Arc::new(Mutex::new(ProgressOwner {
                callback: Box::new(callback),
                interval,
            }))
        });
    install(conn, state)
}

struct BudgetScope<'conn> {
    conn: &'conn Connection,
    state: SharedProgress,
    budget: Arc<CapacityBudget>,
    inserted: bool,
}

impl Drop for BudgetScope<'_> {
    fn drop(&mut self) {
        if self.inserted {
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .budgets
                .retain(|budget| !Arc::ptr_eq(&budget.budget, &self.budget));
            // The enclosing owner still owns transaction cleanup and any
            // quarantine. Explicit finish below reports reinstallation errors.
            let _ = install(self.conn, Arc::clone(&self.state));
        }
    }
}

struct CapacityControl<'owner> {
    owner: &'owner mut dyn GraphWorkControl,
    budgets: Vec<ActiveBudget>,
}

impl GraphWorkControl for CapacityControl<'_> {
    fn check(&mut self, stage: GraphWorkStage) -> anyhow::Result<()> {
        self.owner.check(stage)?;
        for budget in &self.budgets {
            budget.check()?;
        }
        Ok(())
    }
    fn allows_full_eligibility(&self) -> bool {
        self.owner.allows_full_eligibility()
    }
    fn finalization_signal(&self) -> Option<Arc<AtomicBool>> {
        self.owner.finalization_signal()
    }
}

pub(crate) fn with_capacity_scope<T>(
    conn: &Connection,
    requested: Option<Arc<CapacityBudget>>,
    owner: &mut dyn GraphWorkControl,
    operation: impl FnOnce(&Arc<CapacityBudget>, &mut dyn GraphWorkControl) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    // A different interpreter must be audited before treating cadence-one
    // progress observations as a conservative successful-work SQL budget.
    // SAFETY: SQLite returns an immutable, NUL-terminated static source ID.
    let source = unsafe { std::ffi::CStr::from_ptr(rusqlite::ffi::sqlite3_sourceid()) };
    anyhow::ensure!(
        source.to_bytes() == AUDITED_SQLITE_SOURCE_ID.as_bytes(),
        "NIR1_GRAPH_CAPACITY_SQLITE_SOURCE_UNAUDITED"
    );
    let state = state_for(conn);
    let (budget, inserted) = {
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        // A publish carries the exact prepare budget. A nested read without
        // its own snapshot inherits the current attempt instead of resetting.
        let budget = requested
            .or_else(current_attempt)
            .or_else(|| {
                state
                    .budgets
                    .last()
                    .map(|active| Arc::clone(&active.budget))
            })
            .unwrap_or_else(CapacityBudget::supported);
        let inserted = !state
            .budgets
            .iter()
            .any(|active| Arc::ptr_eq(&active.budget, &budget));
        if inserted {
            state.budgets.push(ActiveBudget {
                budget: Arc::clone(&budget),
                grant: owner.finalization_signal(),
            });
        }
        (budget, inserted)
    };
    let mut scope = BudgetScope {
        conn,
        state,
        budget,
        inserted,
    };
    install(conn, Arc::clone(&scope.state))?;
    let budgets = scope
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .budgets
        .clone();
    let mut control = CapacityControl { owner, budgets };
    let mut result = control
        .check(GraphWorkStage::Page)
        .and_then(|_| operation(&scope.budget, &mut control));
    if result.is_err() {
        if let Err(owner) = control.owner.check(GraphWorkStage::ResultAssembly) {
            result = Err(owner);
        }
    }
    if scope.inserted {
        scope
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .budgets
            .retain(|budget| !Arc::ptr_eq(&budget.budget, &scope.budget));
        scope.inserted = false;
    }
    let cleanup = install(conn, Arc::clone(&scope.state));
    // Preserve an owner-selected stop reason. Convert SQLITE_INTERRUPT to
    // the resource failure that triggered it, but never turn an already
    // committed success into a late deadline failure.
    let result = match result {
        Err(primary) if !super::source_revision::is_validation_terminated(&primary) => {
            match control.budgets.iter().try_for_each(|budget| budget.check()) {
                Ok(()) => Err(primary),
                Err(capacity) => {
                    // Existing Run owners classify the display message as
                    // well as the typed error. Keep the capacity code first:
                    // a bare SQLite "interrupted" must not become retryable.
                    let message = format!("{capacity}; SQL operation failed: {primary}");
                    Err(capacity.context(message))
                }
            }
        }
        result => result,
    };
    match (result, cleanup) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(anyhow::anyhow!(
            "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: capacity hook restore: {error}"
        )),
        (Err(primary), Err(error)) => Err(primary.context(format!(
            "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: capacity hook restore: {error}"
        ))),
    }
}

// A synchronous Verify/Rebuild owner may release and reacquire SQLite for
// several phases. Carry its same budget through those phases, including
// nested Source reads. The guard cannot escape this synchronous call.
thread_local! {
    static ATTEMPT: std::cell::RefCell<Option<Arc<CapacityBudget>>> = const { std::cell::RefCell::new(None) };
}

fn current_attempt() -> Option<Arc<CapacityBudget>> {
    ATTEMPT.with(|slot| slot.borrow().clone())
}

struct AttemptScope(Option<Arc<CapacityBudget>>);
impl Drop for AttemptScope {
    fn drop(&mut self) {
        ATTEMPT.with(|slot| slot.replace(self.0.take()));
    }
}

pub(crate) fn with_attempt<T>(operation: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    let budget = current_attempt().unwrap_or_else(CapacityBudget::supported);
    let _scope = AttemptScope(ATTEMPT.with(|slot| slot.replace(Some(budget))));
    operation()
}

/// Once validation returns, its owner must be able to record failure and
/// release the exact Run/connection even when the validation budget is spent.
pub(crate) fn without_attempt<T>(operation: impl FnOnce() -> T) -> T {
    let _scope = AttemptScope(ATTEMPT.with(|slot| slot.take()));
    operation()
}

pub(crate) fn with_current_attempt<T>(
    conn: &Connection,
    owner: &mut dyn GraphWorkControl,
    operation: impl FnOnce(&mut dyn GraphWorkControl) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    match current_attempt() {
        Some(budget) => {
            with_capacity_scope(conn, Some(budget), owner, |_, control| operation(control))
        }
        None => operation(owner),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::source_revision::ForegroundValidationControl;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    const INSERT: &str = "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<200) INSERT INTO bounded SELECT n FROM x";

    fn run_sql(limit: u64) -> (u64, bool) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE bounded(n INTEGER)")
            .unwrap();
        let owner_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&owner_calls);
        crate::set_sqlite_progress_handler(
            &conn,
            11,
            Some(move || {
                calls.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let budget = CapacityBudget::new(limit, Instant::now() + Duration::from_secs(30));
        let tx = conn.unchecked_transaction().unwrap();
        let result = with_capacity_scope(
            &tx,
            Some(Arc::clone(&budget)),
            &mut ForegroundValidationControl,
            |_, _| {
                tx.execute(INSERT, [])?;
                Ok(())
            },
        );
        let succeeded = result.is_ok();
        if let Err(error) = result {
            assert!(
                super::super::source_revision::is_validation_capacity_exceeded(&error),
                "{error:#}"
            );
            assert!(
                !super::super::maintenance_runtime::classify_failure(&error.to_string()).retryable
            );
            tx.rollback().unwrap();
        } else {
            tx.commit().unwrap();
        }
        assert!(conn.is_autocommit());
        let count: i64 = conn
            .query_row("SELECT count(*) FROM bounded", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, if succeeded { 200 } else { 0 });
        let used = budget.steps.load(Ordering::Relaxed);
        let before = owner_calls.load(Ordering::Relaxed);
        conn.query_row("WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<20) SELECT sum(n) FROM x", [], |row| row.get::<_, i64>(0)).unwrap();
        assert!(
            owner_calls.load(Ordering::Relaxed) > before,
            "the outer hook survives the capacity scope"
        );
        assert_eq!(
            budget.steps.load(Ordering::Relaxed),
            used,
            "finished budget no longer owns SQL"
        );
        crate::set_sqlite_progress_handler(&conn, 0, None::<fn() -> bool>).unwrap();
        (used, succeeded)
    }

    #[test]
    fn sql_n_succeeds_n_plus_one_refuses_and_preserves_outer_owner() {
        let (n, succeeded) = run_sql(u64::MAX);
        assert!(succeeded && n > 1);
        assert_eq!(run_sql(n), (n, true));
        assert_eq!(run_sql(n - 1), (n, false));
    }

    #[test]
    fn nested_scope_carries_usage_and_deadline_without_replacing_owner() {
        let conn = Connection::open_in_memory().unwrap();
        let budget = CapacityBudget::new(u64::MAX, Instant::now() + Duration::from_secs(30));
        with_capacity_scope(
            &conn,
            Some(Arc::clone(&budget)),
            &mut ForegroundValidationControl,
            |outer, control| {
                conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
                let before = outer.steps.load(Ordering::Relaxed);
                with_capacity_scope(&conn, None, control, |inner, _| {
                    assert!(Arc::ptr_eq(outer, inner));
                    conn.query_row("SELECT 2", [], |row| row.get::<_, i64>(0))?;
                    Ok(())
                })?;
                assert!(outer.steps.load(Ordering::Relaxed) > before);
                Ok(())
            },
        )
        .unwrap();
        let expired = CapacityBudget::new(u64::MAX, Instant::now());
        let mut ran = false;
        let result = with_capacity_scope(
            &conn,
            Some(expired),
            &mut ForegroundValidationControl,
            |_, _| {
                ran = true;
                Ok(())
            },
        );
        assert!(result.is_err() && !ran);
        assert_eq!(
            conn.query_row("SELECT 3", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn exact_finalization_grant_masks_deadline_but_not_resource_failure() {
        let budget = CapacityBudget::new(1, Instant::now());
        let granted = Arc::new(AtomicBool::new(true));
        assert!(budget.check(Some(&granted)).is_ok());
        assert!(!budget.step(Some(&granted)));
        assert!(budget.step(Some(&granted)));
        assert!(budget.check(Some(&granted)).is_err());
        let budget = CapacityBudget::new(u64::MAX, Instant::now());
        granted.store(false, Ordering::Release);
        assert!(budget.check(Some(&granted)).is_err());
    }

    #[test]
    fn publish_keeps_prepare_budget_and_preserves_prior_generation() -> anyhow::Result<()> {
        use super::super::nir1_entity_relation_index::{
            prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx,
        };
        let db = crate::test_support::current_schema_memory()?;
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects(id,title) VALUES('capacity','Capacity');
                INSERT INTO narrative_semantic_epochs(id,project_id,epoch_number,reason,created_at)
                VALUES('capacity-epoch','capacity',0,'initial','2026-09-22T00:00:00.000Z');",
            )?;
            Ok(())
        })?;
        let runtime = super::super::nir1_chronicle_index::NirChronicleIndexRuntime::new(&db, 1);
        let snapshot =
            db.with_read_transaction(|conn| prepare_graph_index_build(conn, &runtime, "capacity"))?;
        let prior = db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let binding = publish_nir1_entity_relation_index_in_tx(&tx, &runtime, snapshot)?;
            tx.commit()?;
            Ok(binding)
        })?;
        let budget = CapacityBudget::new(SQL_PROGRESS_LIMIT, Instant::now() + DEADLINE);
        let snapshot = {
            let _scope = AttemptScope(ATTEMPT.with(|slot| slot.replace(Some(Arc::clone(&budget)))));
            db.with_read_transaction(|conn| prepare_graph_index_build(conn, &runtime, "capacity"))?
        };
        assert!(budget.steps.load(Ordering::Relaxed) > 0);
        budget
            .steps
            .store(SQL_PROGRESS_LIMIT + 1, Ordering::Relaxed);
        let error = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                publish_nir1_entity_relation_index_in_tx(&tx, &runtime, snapshot)?;
                tx.commit()?;
                Ok(())
            })
            .expect_err("publish cannot reset its prepare budget");
        assert!(
            super::super::source_revision::is_validation_capacity_exceeded(&error),
            "{error:#}"
        );
        db.with_conn(|conn| {
            assert!(conn.is_autocommit());
            let generation: i64 = conn.query_row("SELECT generation FROM narrative_semantic_index_metadata WHERE project_id='capacity'", [], |row| row.get(0))?;
            assert_eq!(generation, prior.generation);
            Ok(())
        })?;
        Ok(())
    }

    #[test]
    fn exhausted_attempt_closes_verify_and_rebuild_runs_with_manual_failure() -> anyhow::Result<()>
    {
        use super::super::maintenance_runtime::{DesiredWork, MaintenanceCycleControl};
        use super::super::restore_rebuild::{
            rebuild_narrative_derived_state_for_project_with_control,
            run_dependency_verify_for_project_with_coordinates_and_control,
        };
        use crate::workspace_lifecycle::RunOwnership;

        for rebuild in [false, true] {
            let db = crate::test_support::current_schema_memory()?;
            db.with_conn(|conn| {
                conn.execute_batch("INSERT INTO projects(id,title) VALUES('capacity','Capacity');
                    INSERT INTO narrative_semantic_epochs(id,project_id,epoch_number,reason,created_at)
                    VALUES('capacity-epoch','capacity',0,'initial','2026-09-22T00:00:00.000Z');")?;
                Ok(())
            })?;
            let budget = CapacityBudget::new(SQL_PROGRESS_LIMIT, Instant::now() + DEADLINE);
            let captured = std::cell::RefCell::new(None);
            let attach = |owner: RunOwnership| {
                if owner.state != crate::workspace_lifecycle::RunCreationState::Created {
                    return Ok(());
                }
                // The real creation transaction is already committed. The
                // next phase must inherit this same exhausted attempt.
                captured.replace(Some(owner.handle));
                budget
                    .steps
                    .store(SQL_PROGRESS_LIMIT - 1, Ordering::Relaxed);
                Ok(())
            };
            let no_stop = || Ok(());
            let no_key = |_: &str| Ok(());
            let no_work = |_: &DesiredWork| Ok(());
            let control = MaintenanceCycleControl {
                should_stop: &no_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &no_key,
                grant_finalize: &no_key,
                register_work: &no_work,
                work_started: &no_work,
                work_completed: &no_work,
                work_noop_completed: &no_work,
                work_deferred: &no_work,
                attach_run: Some(&attach),
                reserve_run: None,
                mark_run_creation_started: None,
                mark_run_reuse_selection_unknown: None,
                mark_run_creation_outcome: None,
                reset_run_creation_tracking: None,
                mark_run_terminalized: None,
            };
            let error = {
                let _scope =
                    AttemptScope(ATTEMPT.with(|slot| slot.replace(Some(Arc::clone(&budget)))));
                if rebuild {
                    rebuild_narrative_derived_state_for_project_with_control(
                        &db,
                        "capacity",
                        Some(&control),
                        "capacity-work",
                    )
                    .map(|_| ())
                } else {
                    run_dependency_verify_for_project_with_coordinates_and_control(
                        &db,
                        "capacity",
                        None,
                        Some(&control),
                        "capacity-work",
                    )
                    .map(|_| ())
                }
                .expect_err("exhausted validation must refuse")
            };
            assert!(
                super::super::source_revision::is_validation_capacity_exceeded(&error),
                "{error:#}"
            );
            let handle = captured.into_inner().expect("committed Run owner");
            db.with_conn(|conn| {
                let state: (String, String, String, Option<String>) = conn.query_row(
                    "SELECT r.status,a.status,a.retry_disposition,a.next_attempt_at
                     FROM narrative_extraction_runs r CROSS JOIN narrative_extraction_attempts a
                     WHERE r.id=?1 AND a.id=?2",
                    rusqlite::params![handle.run_id, handle.attempt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(
                    state,
                    ("failed".into(), "failed".into(), "manual".into(), None)
                );
                assert!(conn.is_autocommit());
                assert_eq!(
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_semantic_index_metadata",
                        [],
                        |row| row.get::<_, i64>(0)
                    )?,
                    0
                );
                Ok(())
            })?;
        }
        Ok(())
    }
}

pub(crate) fn with_database_attempt<T>(
    conn: &Connection,
    operation: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    with_current_attempt(
        conn,
        &mut super::source_revision::ForegroundValidationControl,
        |_| operation(),
    )
}

pub(crate) fn attempt_active() -> bool {
    current_attempt().is_some()
}

pub(crate) fn with_attempt_control<T>(
    owner: &mut dyn GraphWorkControl,
    operation: impl FnOnce(&mut dyn GraphWorkControl) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    with_attempt(|| {
        let budget = current_attempt().expect("synchronous attempt owns its budget");
        let grant = owner.finalization_signal();
        let mut control = CapacityControl {
            owner,
            budgets: vec![ActiveBudget { budget, grant }],
        };
        control.check(GraphWorkStage::Page)?;
        operation(&mut control)
    })
}
