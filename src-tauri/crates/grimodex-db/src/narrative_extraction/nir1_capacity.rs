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
    "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76";
use super::nir1_entity_relation_index::{GraphProgressCallback, GraphWorkControl, GraphWorkStage};
use super::source_revision::{validation_terminated, ValidationTerminationReason};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Instant;

#[derive(Debug)]
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

    pub(crate) fn sql_steps_used(&self) -> u64 {
        self.steps.load(Ordering::Relaxed)
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

    fn step(&self, grant: Option<&Arc<AtomicBool>>, reserved_commit_tail: bool) -> bool {
        // This one count was already charged before SQLite could commit.
        // It cannot become a late SQL/deadline refusal after durability.
        if reserved_commit_tail {
            return false;
        }
        let steps = self.steps.fetch_add(1, Ordering::Relaxed).saturating_add(1);
        steps > self.step_limit
            || (steps.is_multiple_of(1_000)
                && !grant.is_some_and(|grant| grant.load(Ordering::Acquire))
                && Instant::now() >= self.deadline)
    }

    fn try_reserve_commit_step(&self) -> bool {
        let mut used = self.steps.load(Ordering::Relaxed);
        loop {
            let Some(total) = used
                .checked_add(1)
                .filter(|total| *total <= self.step_limit)
            else {
                return false;
            };
            match self.steps.compare_exchange_weak(
                used,
                total,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(current) => used = current,
            }
        }
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

/// A temporary owner installed by a nested reader. The previous owner is
/// restored after the reader has rolled back its private transaction. Keeping
/// this state in the progress registry prevents a nested reader from silently
/// dropping the connection owner's cancellation hook.
pub(crate) struct ProgressOwnerRestore {
    state: SharedProgress,
    previous: Option<Arc<Mutex<ProgressOwner>>>,
}

#[derive(Default)]
struct ProgressState {
    owner: Option<Arc<Mutex<ProgressOwner>>>,
    budgets: Vec<ActiveBudget>,
    reserved_commit_tail: Arc<AtomicBool>,
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

/// Observe the already-installed owner and budgets during Rust work. This
/// never installs a hook or executes SQL. Owners have the same no-reentrant-SQL
/// requirement as when SQLite invokes their progress callback.
pub(crate) fn check_active_work(conn: &Connection) -> anyhow::Result<()> {
    #[cfg(test)]
    active_work_probe::record();
    check_progress_state(&state_for(conn))
}

/// Prove that this exact budget is installed on this connection right now.
/// Holding the `Arc` alone does not show that `with_capacity_scope` is still
/// active, so a reader checks the registry before Rust-side work and SQL.
pub(crate) fn check_active_capacity(
    conn: &Connection,
    budget: &Arc<CapacityBudget>,
) -> anyhow::Result<()> {
    let active = state_for(conn)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .budgets
        .iter()
        .find(|active| Arc::ptr_eq(&active.budget, budget))
        .cloned();
    let active =
        active.ok_or_else(|| anyhow::anyhow!("NIR1 Graph SQL capacity scope is not active"))?;
    active.check()
}

fn check_progress_state(state: &SharedProgress) -> anyhow::Result<()> {
    let (owner, budgets) = {
        let state = state.lock().unwrap_or_else(|error| error.into_inner());
        (state.owner.clone(), state.budgets.clone())
    };
    if owner.is_some_and(|owner| {
        (owner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .callback)()
    }) {
        return Err(validation_terminated(
            ValidationTerminationReason::Cancelled,
            "NIR1 Graph active owner stopped Rust work",
        ));
    }
    for budget in budgets {
        budget.check()?;
    }
    Ok(())
}

/// JSON input is observed at most every 4096 bytes, including inside one long
/// JSON string. Preserve the owner's typed stop instead of a serde I/O wrapper.
pub(crate) fn parse_json_with_active_work<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    text: &str,
) -> anyhow::Result<T> {
    struct CheckedReader<'a> {
        input: &'a [u8],
        state: SharedProgress,
        until_check: usize,
        stopped: Option<anyhow::Error>,
    }
    impl std::io::Read for CheckedReader<'_> {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            if output.is_empty() {
                return Ok(0);
            }
            if self.until_check == 0 {
                if let Err(error) = check_progress_state(&self.state) {
                    self.stopped = Some(error);
                    return Err(std::io::Error::other("NIR1 Graph JSON work stopped"));
                }
                self.until_check = 4096;
            }
            let count = output.len().min(self.input.len()).min(self.until_check);
            output[..count].copy_from_slice(&self.input[..count]);
            self.input = &self.input[count..];
            self.until_check -= count;
            Ok(count)
        }
    }
    let state = state_for(conn);
    check_progress_state(&state)?;
    let mut reader = CheckedReader {
        input: text.as_bytes(),
        state,
        until_check: 4096,
        stopped: None,
    };
    let result = serde_json::from_reader(&mut reader);
    if let Some(error) = reader.stopped {
        return Err(error);
    }
    check_progress_state(&reader.state)?;
    result.map_err(Into::into)
}

fn install(conn: &mut Connection, state: SharedProgress) -> rusqlite::Result<()> {
    let (owner, budgets, reserved_commit_tail) = {
        let state = state.lock().unwrap_or_else(|e| e.into_inner());
        (
            state.owner.clone(),
            state.budgets.clone(),
            Arc::clone(&state.reserved_commit_tail),
        )
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
            let reserved_commit_tail = reserved_commit_tail.load(Ordering::Relaxed)
                && reserved_commit_tail.swap(false, Ordering::Relaxed);
            let mut stop = false;
            for active in &budgets {
                stop |= active
                    .budget
                    .step(active.grant.as_ref(), reserved_commit_tail);
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
    conn: &mut Connection,
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

/// Compose a nested owner with the callback already installed on this
/// connection. SQLite exposes one progress callback, so the two callbacks are
/// multiplexed at the smaller cadence and the prior callback is retained for
/// restoration after the nested scope completes.
pub(crate) fn push_progress_owner<F>(
    conn: &mut Connection,
    interval: i32,
    callback: F,
) -> rusqlite::Result<ProgressOwnerRestore>
where
    F: FnMut() -> bool + Send + 'static,
{
    if interval <= 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "progress owner interval must be positive".to_string(),
        ));
    }
    let state = state_for(conn);
    let mut callback = Box::new(callback) as Box<dyn FnMut() -> bool + Send>;
    let previous = {
        let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
        let previous = state.owner.take();
        let owner = if let Some(previous_owner) = previous.as_ref() {
            let previous_interval = previous_owner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .interval
                .max(1);
            let cadence = previous_interval.min(interval).max(1);
            let previous_for_callback = Arc::clone(previous_owner);
            let mut previous_pending: i32 = 0;
            let mut current_pending: i32 = 0;
            ProgressOwner {
                interval: cadence,
                callback: Box::new(move || {
                    previous_pending = previous_pending.saturating_add(cadence);
                    current_pending = current_pending.saturating_add(cadence);
                    let previous_stop = if previous_pending >= previous_interval {
                        previous_pending %= previous_interval;
                        (previous_for_callback
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .callback)()
                    } else {
                        false
                    };
                    let current_stop = if current_pending >= interval {
                        current_pending %= interval;
                        callback()
                    } else {
                        false
                    };
                    previous_stop || current_stop
                }),
            }
        } else {
            ProgressOwner { callback, interval }
        };
        state.owner = Some(Arc::new(Mutex::new(owner)));
        previous
    };
    if let Err(error) = install(conn, Arc::clone(&state)) {
        state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .owner = previous.clone();
        let _ = install(conn, Arc::clone(&state));
        return Err(error);
    }
    Ok(ProgressOwnerRestore { state, previous })
}

impl ProgressOwnerRestore {
    /// Disable SQLite's callback for rollback without removing the registered
    /// outer owner; `restore` reinstalls that owner before any later SQL runs.
    pub(crate) fn clear_for_cleanup(&self, conn: &mut Connection) -> rusqlite::Result<()> {
        crate::install_sqlite_progress_handler(conn, 0, None::<fn() -> bool>)
    }

    pub(crate) fn restore(mut self, conn: &mut Connection) -> rusqlite::Result<()> {
        let previous = self.previous.take();
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .owner = previous;
        install(conn, Arc::clone(&self.state))
    }
}

/// The audited COMMIT program is Init -> Goto -> AutoCommit. Goto drains
/// the first two progress calls; AutoCommit calls sqlite3VdbeHalt BEFORE
/// vdbe_return delivers the final one. Reserve that last count at SQLite's
/// commit hook, after any FTS xSync SQL and before any durable commit. FTS
/// xCommit is a no-op. This applies ONLY to this literal COMMIT statement.
/// All terminal DML, preparation, xSync and the final count remain charged.
pub(crate) fn commit_transaction(conn: &mut Connection) -> anyhow::Result<()> {
    let state = state_for(conn);
    let (budgets, tail) = {
        let state = state.lock().unwrap_or_else(|e| e.into_inner());
        (
            state.budgets.clone(),
            Arc::clone(&state.reserved_commit_tail),
        )
    };
    if budgets.is_empty() {
        return conn.execute_batch("COMMIT").map_err(Into::into);
    }
    let refused = Arc::new(AtomicBool::new(false));
    let gate_refused = Arc::clone(&refused);
    let gate_tail = Arc::clone(&tail);
    // Charge the one remaining callback before allowing durability. The
    // synchronous connection owner consumes this credit only in COMMIT's tail.
    // This is the only commit-hook owner in the crate.
    let commit_gate = move || {
        if budgets
            .iter()
            .any(|active| active.check().is_err() || !active.budget.try_reserve_commit_step())
        {
            gate_refused.store(true, Ordering::Relaxed);
            return true;
        }
        gate_tail.store(true, Ordering::Relaxed);
        false
    };
    crate::hook_registration::set_commit_hook(conn, Some(commit_gate))?;
    let mut scope = CommitScope {
        conn,
        tail,
        installed: true,
    };
    let result = scope.conn.execute_batch("COMMIT");
    let cleanup = crate::hook_registration::set_commit_hook(scope.conn, None::<fn() -> bool>);
    scope.tail.store(false, Ordering::Relaxed);
    scope.installed = false;
    if let Err(error) = cleanup {
        anyhow::bail!("NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: capacity commit hook restore: {error}; COMMIT: {result:?}");
    }
    if refused.load(Ordering::Relaxed) {
        return Err(validation_terminated(
            ValidationTerminationReason::CapacityExceeded,
            "NIR1 Graph COMMIT capacity reservation refused before durable publication",
        ));
    }
    result.map_err(Into::into)
}

struct CommitScope<'conn> {
    conn: &'conn mut Connection,
    tail: Arc<AtomicBool>,
    installed: bool,
}

impl Drop for CommitScope<'_> {
    fn drop(&mut self) {
        self.tail.store(false, Ordering::Relaxed);
        if self.installed {
            let _ = crate::hook_registration::set_commit_hook(self.conn, None::<fn() -> bool>);
        }
    }
}

struct BudgetScope<'conn> {
    conn: &'conn mut Connection,
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
            let _ = install(&mut *self.conn, Arc::clone(&self.state));
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

    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        self.owner.progress_callback()
    }

    fn stop_signal(&self) -> Option<Arc<AtomicBool>> {
        self.owner.stop_signal()
    }

    fn progress_deadline(&self) -> Option<Instant> {
        self.owner.progress_deadline()
    }

    fn finalization_signal(&self) -> Option<Arc<AtomicBool>> {
        self.owner.finalization_signal()
    }
}

pub(crate) fn with_capacity_scope<T>(
    conn: &mut Connection,
    requested: Option<Arc<CapacityBudget>>,
    owner: &mut dyn GraphWorkControl,
    operation: impl FnOnce(
        &mut Connection,
        &Arc<CapacityBudget>,
        &mut dyn GraphWorkControl,
    ) -> anyhow::Result<T>,
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
    install(&mut *scope.conn, Arc::clone(&scope.state))?;
    let budgets = scope
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .budgets
        .clone();
    let mut control = CapacityControl { owner, budgets };
    let mut result = control
        .check(GraphWorkStage::Page)
        .and_then(|_| operation(&mut *scope.conn, &scope.budget, &mut control));
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
    let cleanup = install(&mut *scope.conn, Arc::clone(&scope.state));
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

#[cfg(test)]
pub(crate) mod project_read_probe {
    //! Counts of the project-level reads one Graph query makes, to check that
    //! a read the query shares is made once however many Revisions it
    //! evaluates (CQ-AVAIL). Test-only; recording is off until
    //! [`recording`] turns it on for a closure.
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
    pub(crate) enum Read {
        /// The project's live tree and the Scope authority built from it.
        AuthorityTree,
        /// The Scene-scope extension of the Scope authority: the registry, every
        /// Scene binding and the principals they name.
        ScopeExtension,
        /// The Scope registry, whole (two statements make up one extension read).
        RegistryFull,
        RegistryRow,
        /// The latest Semantic Epoch.
        CurrentEpoch,
        /// The C2-ZC cutover marker (`schema_data_migrations`, one row).
        C2zcMarker,
        /// The query Scene's saved source and the project's phase mode.
        QueryScene,
        /// The query Scene's POV character.
        QueryViewpoint,
        /// A single Scene's scope read by its own statements.
        SceneScope,
        /// A Run's sealed Snapshot document bindings (its corpus artifact,
        /// parsed and verified).
        SealedDocuments,
    }

    thread_local! {
        static COUNTS: RefCell<Option<BTreeMap<Read, usize>>> = const { RefCell::new(None) };
    }

    pub(crate) fn record(read: Read) {
        COUNTS.with(|counts| {
            if let Some(counts) = counts.borrow_mut().as_mut() {
                *counts.entry(read).or_insert(0) += 1;
            }
        });
    }

    /// Run `operation`, counting the reads it makes on this thread.
    pub(crate) fn recording<T>(operation: impl FnOnce() -> T) -> (T, BTreeMap<Read, usize>) {
        let previous = COUNTS.with(|counts| counts.replace(Some(BTreeMap::new())));
        let result = operation();
        let counts = COUNTS
            .with(|counts| counts.replace(previous))
            .unwrap_or_default();
        (result, counts)
    }
}

#[cfg(test)]
pub(crate) mod active_work_probe {
    //! Counts the Rust-side `check_active_work` calls one operation makes on this
    //! thread, apart from the SQLite progress callbacks the owner also sees
    //! (DR-GRW-4: the memo moves no Rust-side check). Test-only; recording is off
    //! until [`recording`] turns it on for a closure.
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<Option<usize>> = const { Cell::new(None) };
    }

    pub(crate) fn record() {
        COUNT.with(|count| {
            if let Some(n) = count.get() {
                count.set(Some(n + 1));
            }
        });
    }

    /// Run `operation`, counting the `check_active_work` calls it makes.
    pub(crate) fn recording<T>(operation: impl FnOnce() -> T) -> (T, usize) {
        let previous = COUNT.with(|count| count.replace(Some(0)));
        let result = operation();
        let counted = COUNT.with(|count| count.replace(previous)).unwrap_or(0);
        (result, counted)
    }
}

#[cfg(test)]
pub(crate) mod materialization_probe {
    thread_local! {
        pub(crate) static READS: std::cell::RefCell<Option<Vec<(bool, bool)>>> = const { std::cell::RefCell::new(None) };
    }

    pub(crate) fn record(conn: &rusqlite::Connection, d1: bool, kind: &str, key: &str) {
        use super::super::nir1_entity_relation_index::INDEX_KEY;
        if kind == "semantic-index" && key == INDEX_KEY {
            READS.with(|reads| {
                if let Some(reads) = reads.borrow_mut().as_mut() {
                    reads.push((d1, conn.is_autocommit()));
                }
            });
        }
    }
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

/// Test-only: run `operation` under an exact pre-shaped attempt budget, so a
/// route test can present an exhausted SQL budget or an elapsed deadline to
/// the owner's `with_attempt` without changing any ratified number.
#[cfg(test)]
pub(crate) fn with_attempt_budget_for_test<T>(
    budget: Arc<CapacityBudget>,
    operation: impl FnOnce() -> T,
) -> T {
    let _scope = AttemptScope(ATTEMPT.with(|slot| slot.replace(Some(budget))));
    operation()
}

/// Test-only: mark `used` SQL progress counts as already charged to an
/// attempt budget. `used == SQL_PROGRESS_LIMIT` makes the next count N+1.
#[cfg(test)]
pub(crate) fn set_used_steps_for_test(budget: &CapacityBudget, used: u64) {
    budget.steps.store(used, Ordering::Relaxed);
}

/// Once validation returns, its owner must be able to record failure and
/// release the exact Run/connection even when the validation budget is spent.
pub(crate) fn without_attempt<T>(operation: impl FnOnce() -> T) -> T {
    let _scope = AttemptScope(ATTEMPT.with(|slot| slot.take()));
    operation()
}

pub(crate) fn with_current_attempt<T>(
    conn: &mut Connection,
    owner: &mut dyn GraphWorkControl,
    operation: impl FnOnce(&mut Connection, &mut dyn GraphWorkControl) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    match current_attempt() {
        Some(budget) => with_capacity_scope(conn, Some(budget), owner, |conn, _, control| {
            operation(conn, control)
        }),
        None => operation(conn, owner),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::source_revision::ForegroundValidationControl;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// The audited interpreter's COMMIT program and callback order (DR-DBC-4).
    /// `commit_transaction` reserves the last progress count at the commit hook
    /// because, in the audited source, `Goto` drains two cadence-one callbacks
    /// and `AutoCommit` runs the commit hook (inside `sqlite3VdbeHalt`) before
    /// `vdbe_return` delivers the third. A different SQLite source ID passes
    /// this test only if the order is unchanged; this pins it empirically on
    /// top of the source-ID check.
    #[test]
    fn audited_sqlite_commit_program_and_callback_order() {
        use std::sync::atomic::AtomicU64;

        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(x)").unwrap();

        let opcodes: Vec<String> = conn
            .prepare("EXPLAIN COMMIT")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        // Address order: Init (0) jumps to Goto (3), which jumps to AutoCommit (1),
        // which falls through to Halt (2): the audited Init -> Goto -> AutoCommit.
        assert_eq!(opcodes, ["Init", "AutoCommit", "Halt", "Goto"]);

        let callbacks = Arc::new(AtomicU64::new(0));
        let at_commit_hook = Arc::new(AtomicU64::new(u64::MAX));
        let counted = Arc::clone(&callbacks);
        conn.progress_handler(
            1,
            Some(move || {
                counted.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let seen = Arc::clone(&callbacks);
        let recorded = Arc::clone(&at_commit_hook);
        conn.commit_hook(Some(move || {
            recorded.store(seen.load(Ordering::Relaxed), Ordering::Relaxed);
            false
        }))
        .unwrap();
        conn.execute_batch("BEGIN").unwrap();
        conn.execute_batch("INSERT INTO t VALUES (1)").unwrap();
        callbacks.store(0, Ordering::Relaxed);
        conn.execute_batch("COMMIT").unwrap();
        conn.commit_hook(None::<fn() -> bool>).unwrap();
        conn.progress_handler(0, None::<fn() -> bool>).unwrap();
        assert_eq!(at_commit_hook.load(Ordering::Relaxed), 2);
        assert_eq!(callbacks.load(Ordering::Relaxed), 3);
    }

    /// The same order with what `commit_transaction` is documented to rely on
    /// and the plain in-memory test above does not exercise: an FTS5 table
    /// (`xSync`/`xCommit` run inside COMMIT and may run SQL of their own) and a
    /// WAL database. The audit of the interpreter (`AUDITED_SQLITE_SOURCE_ID`) is
    /// a reading of the source; this pins the one property the reservation needs
    /// on a real FTS5 write: the commit hook runs after every callback of the
    /// FTS sync, and exactly one more callback is delivered after it.
    #[test]
    fn audited_commit_callback_order_holds_with_fts5_and_wal() {
        use std::sync::atomic::AtomicU64;

        /// Removes the database and its WAL/SHM files even when an assertion
        /// below panics (declared before `conn`, so it drops after it).
        struct RemoveOnDrop(std::path::PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                for suffix in ["", "-wal", "-shm"] {
                    let mut file = self.0.as_os_str().to_os_string();
                    file.push(suffix);
                    let _ = std::fs::remove_file(file);
                }
            }
        }

        let path =
            std::env::temp_dir().join(format!("grimodex-commit-order-{}.db", uuid::Uuid::new_v4()));
        let _cleanup = RemoveOnDrop(path.clone());
        let mut conn = Connection::open(&path).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        conn.execute_batch(
            "CREATE TABLE t(x);
             CREATE VIRTUAL TABLE docs USING fts5(body);",
        )
        .unwrap();

        let callbacks = Arc::new(AtomicU64::new(0));
        let at_commit_hook = Arc::new(AtomicU64::new(u64::MAX));
        let counted = Arc::clone(&callbacks);
        conn.progress_handler(
            1,
            Some(move || {
                counted.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let seen = Arc::clone(&callbacks);
        let recorded = Arc::clone(&at_commit_hook);
        conn.commit_hook(Some(move || {
            recorded.store(seen.load(Ordering::Relaxed), Ordering::Relaxed);
            false
        }))
        .unwrap();
        conn.execute_batch("BEGIN").unwrap();
        conn.execute_batch(
            "INSERT INTO t VALUES (1);
             INSERT INTO docs(body) VALUES ('the quick brown fox');",
        )
        .unwrap();
        callbacks.store(0, Ordering::Relaxed);
        conn.execute_batch("COMMIT").unwrap();
        conn.commit_hook(None::<fn() -> bool>).unwrap();
        conn.progress_handler(0, None::<fn() -> bool>).unwrap();
        let at_hook = at_commit_hook.load(Ordering::Relaxed);
        let total = callbacks.load(Ordering::Relaxed);
        eprintln!("FTS5+WAL COMMIT: callbacks before the commit hook {at_hook}, in total {total}");
        // Init -> Goto drain two callbacks; the FTS5 sync may add more before the
        // hook; the final one comes after it.
        assert!(
            at_hook >= 2,
            "hook after the Init/Goto callbacks: {at_hook}"
        );
        assert_eq!(
            total,
            at_hook + 1,
            "exactly one callback after the commit hook"
        );
    }

    #[test]
    fn commit_tail_step_reservation_is_bounded_and_does_not_wrap() {
        let budget = CapacityBudget::new(1, Instant::now() + DEADLINE);
        assert!(budget.try_reserve_commit_step());
        assert!(!budget.try_reserve_commit_step());
        assert_eq!(budget.sql_steps_used(), 1);

        let exhausted = CapacityBudget::new(u64::MAX, Instant::now() + DEADLINE);
        exhausted.steps.store(u64::MAX, Ordering::Relaxed);
        assert!(!exhausted.try_reserve_commit_step());
        assert_eq!(exhausted.sql_steps_used(), u64::MAX);
    }

    #[test]
    fn json_checks_existing_owner_inside_long_strings_without_replacing_hook() {
        let mut conn = Connection::open_in_memory().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(true));
        let observed = Arc::clone(&calls);
        let signal = Arc::clone(&stopped);
        set_progress_owner(
            &mut conn,
            1,
            Some(move || {
                let count = observed.fetch_add(1, Ordering::Relaxed) + 1;
                signal.load(Ordering::Relaxed) && count >= 3
            }),
        )
        .unwrap();
        let text = format!("\"{}\"", "a".repeat(32 * 1024));
        let error = parse_json_with_active_work::<String>(&conn, &text).unwrap_err();
        assert!(super::super::source_revision::is_validation_terminated(
            &error
        ));
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        stopped.store(false, Ordering::Relaxed);
        let before = calls.load(Ordering::Relaxed);
        conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert!(
            calls.load(Ordering::Relaxed) > before,
            "original hook still installed"
        );
        assert_eq!(
            parse_json_with_active_work::<String>(&conn, &text)
                .unwrap()
                .len(),
            32 * 1024
        );
        set_progress_owner(&mut conn, 0, None::<fn() -> bool>).unwrap();
    }

    #[test]
    fn json_preserves_active_capacity_failure_and_normal_parse_errors() {
        let conn = Connection::open_in_memory().unwrap();
        let state = state_for(&conn);
        state.lock().unwrap().budgets.push(ActiveBudget {
            budget: CapacityBudget::new(u64::MAX, Instant::now()),
            grant: None,
        });
        let error = parse_json_with_active_work::<serde_json::Value>(&conn, "{}").unwrap_err();
        assert!(super::super::source_revision::is_validation_capacity_exceeded(&error));
        state.lock().unwrap().budgets.clear();
        let error = parse_json_with_active_work::<serde_json::Value>(&conn, "{").unwrap_err();
        assert!(error.downcast_ref::<serde_json::Error>().is_some());
        assert_eq!(
            conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn nested_progress_owner_composes_and_restores_the_prior_owner() {
        let mut conn = Connection::open_in_memory().unwrap();
        let prior_calls = Arc::new(AtomicUsize::new(0));
        let nested_calls = Arc::new(AtomicUsize::new(0));
        let prior_observed = Arc::clone(&prior_calls);
        set_progress_owner(
            &mut conn,
            1,
            Some(move || {
                prior_observed.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let nested_observed = Arc::clone(&nested_calls);
        let scope = push_progress_owner(&mut conn, 1, move || {
            nested_observed.fetch_add(1, Ordering::Relaxed);
            false
        })
        .unwrap();
        let probe = "WITH RECURSIVE series(n) AS (
                 VALUES(1) UNION ALL SELECT n+1 FROM series WHERE n < 200
             ) SELECT sum(n) FROM series";
        conn.execute_batch(probe).unwrap();
        assert!(prior_calls.load(Ordering::Relaxed) > 0);
        assert!(nested_calls.load(Ordering::Relaxed) > 0);
        scope.restore(&mut conn).unwrap();
        let prior_before_restore_probe = prior_calls.load(Ordering::Relaxed);
        let nested_before_restore_probe = nested_calls.load(Ordering::Relaxed);
        conn.execute_batch(probe).unwrap();
        assert!(prior_calls.load(Ordering::Relaxed) > prior_before_restore_probe);
        assert_eq!(
            nested_calls.load(Ordering::Relaxed),
            nested_before_restore_probe
        );
        set_progress_owner(&mut conn, 0, None::<fn() -> bool>).unwrap();
    }

    const INSERT: &str = "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<?1) INSERT INTO bounded SELECT n FROM x";

    fn run_sql(limit: u64, rows: usize, padding_selects: usize) -> (u64, bool) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE bounded(n INTEGER)")
            .unwrap();
        let owner_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&owner_calls);
        crate::set_sqlite_progress_handler(
            &mut conn,
            11,
            Some(move || {
                calls.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let budget = CapacityBudget::new(limit, deadline);
        let mut tx = crate::scoped_tx::ScopedTransaction::begin(&mut conn).unwrap();
        let result = with_capacity_scope(
            &mut tx,
            Some(Arc::clone(&budget)),
            &mut ForegroundValidationControl,
            |tx, _, _| {
                tx.execute(INSERT, [rows as i64])?;
                for _ in 0..padding_selects {
                    let _: i64 = tx.query_row("SELECT 1", [], |row| row.get(0))?;
                }
                if padding_selects > 0 {
                    let _: i64 = tx.query_row("SELECT 1 + 1", [], |row| row.get(0))?;
                }
                Ok(())
            },
        );
        assert!(
            Instant::now() < deadline,
            "SQL probe must not hit its deadline"
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
            if !tx.is_autocommit() {
                tx.rollback().unwrap();
            } else {
                drop(tx);
            }
        } else {
            tx.commit().unwrap();
        }
        assert!(conn.is_autocommit());
        let count: i64 = conn
            .query_row("SELECT count(*) FROM bounded", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, if succeeded { rows as i64 } else { 0 });
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
        crate::set_sqlite_progress_handler(&mut conn, 0, None::<fn() -> bool>).unwrap();
        (used, succeeded)
    }

    #[test]
    fn sql_n_succeeds_n_plus_one_refuses_and_preserves_outer_owner() {
        let (n, succeeded) = run_sql(u64::MAX, 200, 0);
        assert!(succeeded && n > 1);
        assert_eq!(run_sql(n, 200, 0), (n, true));
        assert_eq!(run_sql(n - 1, 200, 0), (n, false));
    }

    #[test]
    fn fixed_graph_sql_budget_admits_600000_steps_and_refuses_600001() {
        let limit = super::super::nir1_graph::QUERY_SQL_STEPS;
        assert_eq!(limit, 600_000);
        // The recursive insert costs 23 steps a row, and each padding statement 4
        // (the first 9). On SQLite 3.53.2 the fixed part was 17 and 26,082 rows
        // with 23 statements were exactly 600,000 steps; SQLite 3.54.1 spends one
        // step less (that workload now measures 599,999, DR-DBC-4), so the
        // exact-cap workload is 26,081 rows and 29 statements:
        // 23 * 26,081 + 4 * 29 + 21 = 600,000. The limit itself is unchanged.
        let (used, succeeded) = run_sql(limit, 26_081, 29);
        assert!(succeeded, "the exact-cap workload must commit");
        assert_eq!(
            used, limit,
            "successful work must use exactly 600,000 steps"
        );

        let (used, succeeded) = run_sql(limit, 60_000, 0);
        assert!(
            !succeeded,
            "the recursive statement must exceed the fixed budget"
        );
        assert_eq!(
            used,
            limit + 1,
            "only the 600,001st progress callback refuses"
        );
    }

    fn finalize_run_at_limit(
        run_kind: &str,
        limit: u64,
        granted_fts: bool,
    ) -> anyhow::Result<(u64, bool)> {
        use super::super::maintenance_lifecycle::{
            complete_maintenance_run_in_tx, create_maintenance_run_in_tx,
        };
        use super::super::repository::SystemRunWorkKeyReuse;
        use super::super::task_leases::with_immediate_transaction;

        let directory =
            std::env::temp_dir().join(format!("grimodex-capacity-commit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory)?;
        let path = directory.join("capacity.sqlite");
        crate::test_support::current_schema_memory()?.with_conn(|conn| {
            conn.backup("main", &path, None::<fn(rusqlite::backup::Progress)>)?;
            Ok(())
        })?;
        let db = crate::Database::new(&path)?;
        let (spec, key) = if run_kind == "dependency-verify" {
            (
                serde_json::json!({"verifyContractVersion":super::super::restore_rebuild::VERIFY_CONTRACT_VERSION}),
                "dependency-verify:capacity-epoch",
            )
        } else {
            (serde_json::json!({}), "dependency-rebuild-derived")
        };
        let handle = db.with_conn_mut(|conn| {
            conn.execute_batch(
                "INSERT INTO projects(id,title) VALUES('capacity','Capacity');
                INSERT INTO narrative_semantic_epochs(id,project_id,epoch_number,reason,created_at)
                VALUES('capacity-epoch','capacity',0,'initial','2026-09-22T00:00:00.000Z');",
            )?;
            if granted_fts {
                conn.execute_batch("CREATE VIRTUAL TABLE capacity_fts USING fts5(body)")?;
            }
            with_immediate_transaction(conn, |conn| {
                create_maintenance_run_in_tx(
                    conn,
                    "capacity",
                    run_kind,
                    "capacity-epoch",
                    key,
                    &spec,
                    &format!("sha256:{}", super::super::commit::digest_plan(&spec)),
                    SystemRunWorkKeyReuse::RunningOnly,
                )
            })
        })?;
        let budget = CapacityBudget::new(limit, Instant::now() + DEADLINE);
        struct Granted(Arc<AtomicBool>);
        impl GraphWorkControl for Granted {
            fn check(&mut self, _: GraphWorkStage) -> anyhow::Result<()> {
                Ok(())
            }
            fn finalization_signal(&self) -> Option<Arc<AtomicBool>> {
                Some(Arc::clone(&self.0))
            }
        }
        let mut granted = Granted(Arc::new(AtomicBool::new(true)));
        let mut foreground = ForegroundValidationControl;
        let result = db.with_conn_mut(|conn| {
            with_capacity_scope(
                conn,
                Some(Arc::clone(&budget)),
                if granted_fts {
                    &mut granted
                } else {
                    &mut foreground
                },
                |conn, _, _| {
                    with_immediate_transaction(conn, |conn| {
                        if granted_fts {
                            conn.execute(
                                "INSERT INTO capacity_fts(body) VALUES(?1)",
                                ["pending FTS sync terms ".repeat(200)],
                            )?;
                        }
                        complete_maintenance_run_in_tx(conn, &handle)?;
                        Ok(())
                    })
                },
            )
        });
        let succeeded = result.is_ok();
        if let Err(error) = result {
            assert!(
                super::super::source_revision::is_validation_capacity_exceeded(&error),
                "{error:#}"
            );
        }
        // Autocommit alone cannot distinguish a rollback from a commit whose
        // final progress callback returned SQLITE_INTERRUPT. Read durability
        // through another WAL connection, before any failure re-finalization.
        let observer = Connection::open(&path)?;
        let state: (String, String) = observer.query_row(
            "SELECT r.status,a.status FROM narrative_extraction_runs r
             CROSS JOIN narrative_extraction_attempts a WHERE r.id=?1 AND a.id=?2",
            rusqlite::params![handle.run_id, handle.attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let expected = if succeeded { "completed" } else { "running" };
        assert_eq!(
            state,
            (expected.into(), expected.into()),
            "failed finalization must not be durable"
        );
        if granted_fts {
            assert_eq!(
                observer.query_row("SELECT count(*) FROM capacity_fts", [], |row| row
                    .get::<_, i64>(0))?,
                i64::from(succeeded)
            );
        }
        drop(observer);
        drop(db);
        std::fs::remove_dir_all(directory)?;
        Ok((budget.steps.load(Ordering::Relaxed), succeeded))
    }

    #[test]
    fn commit_inside_capacity_scope_never_returns_failure_after_durable_run_success(
    ) -> anyhow::Result<()> {
        for run_kind in ["dependency-verify", "semantic-index-rebuild"] {
            for granted_fts in [false, true] {
                let (n, succeeded) = finalize_run_at_limit(run_kind, u64::MAX, granted_fts)?;
                assert!(succeeded && n > 1);
                assert_eq!(finalize_run_at_limit(run_kind, n, granted_fts)?, (n, true));
                assert!(!finalize_run_at_limit(run_kind, n - 1, granted_fts)?.1);
            }
        }
        Ok(())
    }

    #[test]
    fn nested_scope_carries_usage_and_deadline_without_replacing_owner() {
        let mut conn = Connection::open_in_memory().unwrap();
        let budget = CapacityBudget::new(u64::MAX, Instant::now() + Duration::from_secs(30));
        with_capacity_scope(
            &mut conn,
            Some(Arc::clone(&budget)),
            &mut ForegroundValidationControl,
            |conn, outer, control| {
                conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
                let before = outer.steps.load(Ordering::Relaxed);
                with_capacity_scope(conn, None, control, |conn, inner, _| {
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
            &mut conn,
            Some(expired),
            &mut ForegroundValidationControl,
            |_, _, _| {
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
        assert!(!budget.step(Some(&granted), false));
        assert!(budget.step(Some(&granted), false));
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
        let prior = db.with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            let binding = publish_nir1_entity_relation_index_in_tx(&mut tx, &runtime, snapshot)?;
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
            .with_conn_mut(|conn| {
                let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
                publish_nir1_entity_relation_index_in_tx(&mut tx, &runtime, snapshot)?;
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
    conn: &mut Connection,
    operation: impl FnOnce(&mut Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    with_current_attempt(
        conn,
        &mut super::source_revision::ForegroundValidationControl,
        |conn, _| operation(conn),
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
