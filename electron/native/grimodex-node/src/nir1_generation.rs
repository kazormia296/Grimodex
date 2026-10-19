//! Internal NIR-1 generation helpers and the post-Ready recovery sweep.
//!
//! The bounded attempt owner lives in `nir1_generation_owner`. No N-API entry
//! or production transport exists. The final request below is not a
//! material, Scope, history or product-send authorization grant; those
//! canonical readers must be integrated before any production transport is
//! exposed.

#![cfg_attr(not(test), allow(dead_code))]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{ensure, Context, Result};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::narrative_extraction::NativeNir1HistoryDraft;
use grimodex_db::nir1_generation::{
    self as storage, AttemptSceneBinding, GenerationPurpose, InputReference, Nir1ExpectedScope,
    QualificationReference, ReadBudget,
};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use grimodex_db::workspace_lifecycle::{LifecycleState, LiveBinding};
use grimodex_db::ParticipantSqlOperationBudget;
use serde_json::{json, Value};

use crate::nir1_startup_barrier::{
    Nir1StartupRecovery, Nir1SweepProof, NIR1_STARTUP_LEASE_DRAIN_LIMIT,
};
#[cfg(test)]
use crate::state::GenerationRecoveryLaunchObservation;
use crate::state::{
    AppState, GenerationRecoveryHookEntry, GenerationRecoveryHookLedger, GenerationRecoveryHookState,
    WorkspaceOperationGuard,
};

/// The final request is assembled by an unpublished Native coordinator after
/// Packing and all material readers have finished.  It is deliberately not a
/// wire type: renderer/IPC input cannot construct or select this path.  The
/// payload is retained only in the returned in-process handle; storage keeps
/// its digest and the exact immutable input/qualification references.  The
/// coarse digest/route fields remain coordinator-supplied proof inputs until
/// the typed Scope, input-use/send class, envelope and D1 readers are wired;
/// this helper must not be connected to renderer-provided values.
#[derive(Clone, Debug)]
pub(crate) struct FinalDispatchRequest {
    pub project_id: String,
    /// The DB chat session the request answers (`chat_sessions.id`). The
    /// owner binds the Main-issued caller session separately.
    pub chat_session_id: String,
    /// The query Scene incarnation, read with
    /// `storage::read_attempt_scene_binding_in_tx` in the snapshot that
    /// Packing and the material readers used.
    pub scene: AttemptSceneBinding,
    pub route_revision: String,
    pub purpose: GenerationPurpose,
    pub scope_digest: String,
    pub material_digest: String,
    pub d1_digest: String,
    pub provider: String,
    pub model: String,
    pub api: String,
    pub endpoint_identity: String,
    pub payload: Value,
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    /// The history slot (without `eligibleUntilMs`) and the durable workspace
    /// identity the D-final builder observed, taken from the prepared
    /// request's handoff. A value: the storage writer sets the eligibility
    /// time and applies the 64 KiB downgrade; the owner stores its own
    /// `LiveBinding`'s identity and refuses a request whose identity differs.
    pub history: NativeNir1HistoryDraft,
    /// How long the attempt may be claimed after its creation, in
    /// milliseconds (`1..=NIR1_ATTEMPT_MAX_LIFETIME_MS`). Never an absolute
    /// time: the create transaction reads Native's clock and decides
    /// `created_at_ms`, `expires_at_ms` and the history `eligibleUntilMs`.
    pub lifetime_ms: i64,
    /// The target Scene's Scope binding and the project's restore epoch that
    /// the D-final snapshot read (`storage::read_expected_scope_in_tx`). The
    /// create and the claim re-read them in their own transactions.
    pub expected_scope: Nir1ExpectedScope,
    pub budget: ReadBudget,
}

/// Native-only cold-reopen owner for unfinished generation attempts. The
/// pinned workspace snapshot retains the lifecycle participant and authority
/// together; no renderer handle or old dispatch owner is accepted here.
pub(crate) struct GenerationRecoveryCoordinator {
    state: Arc<AppState>,
    workspace: ActiveWorkspaceSnapshot,
    live_binding: LiveBinding,
    ready_revision: u64,
    _single_flight: GenerationRecoverySingleFlight,
    _workspace_operation: WorkspaceOperationGuard,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct GenerationRecoverySummary {
    pub project_pages: usize,
    pub projects: usize,
    pub attempt_pages: usize,
    pub recovered: usize,
}

const MAX_RECOVERY_PAGE_SIZE: usize = 64;
const MAX_RECOVERY_SWEEP_PAGES: usize = 4_096;
const MAX_RECOVERY_SWEEP_ITEMS: usize = 2_048;
const MAX_RECOVERY_SWEEP_TIME: Duration = Duration::from_secs(5);
// A recovery write that only timed out on the connection mutex ran no SQL.
// One pending attempt is tried at most this many times, back to back after a
// sweep checkpoint: it waits for the mutex at most this many mutex limits and
// never past the sweep deadline.
const MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS: usize = 3;
// One sweep operation uses the same per-op and busy limits as the bounded
// attempt writers; the values live once, in grimodex-db.
const MAX_RECOVERY_OPERATION_TIME: Duration = storage::NIR1_GENERATION_OPERATION_LIMIT;
const RECOVERY_SQL_BUSY_TIMEOUT: Duration = storage::NIR1_GENERATION_SQLITE_BUSY_LIMIT;
// Test builds only (see `GenerationRecoveryLimits::SAFETY_LIMITS`): the sweep
// time cutoff that tests which do not examine time run under. A release build
// never sees it. Only the sweep has this value; the per-operation test cutoff
// is grimodex-db's `NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT`, which the
// bounded writers' test budgets use too, so it is not repeated here.
#[cfg(test)]
const TEST_RECOVERY_SWEEP_TIME: Duration = Duration::from_secs(120);

#[cfg(test)]
fn recovery_error_chain_categories(error: &anyhow::Error) -> String {
    let mut causes = error.chain();
    let mut categories = causes
        .by_ref()
        .take(8)
        .map(|cause| {
            let message = cause.to_string();
            if message.contains("SQLITE_BUSY")
                || message.contains("database is locked")
                || message.contains("database is busy")
            {
                "sqlite-busy"
            } else if message.contains("SQLITE_LOCKED") {
                "sqlite-locked"
            } else if message.contains("SQLITE_CONSTRAINT")
                || message.contains("constraint failed")
                || message.contains("constraint violation")
                || message.contains("injected recovery failure")
            {
                "sqlite-constraint"
            } else if message.contains("SQLITE_INTERRUPT") || message.contains("interrupted") {
                "sqlite-interrupted"
            } else if message.contains("NIR1_GENERATION_RECOVERY_") {
                "recovery-marker"
            } else {
                "other"
            }
        })
        .collect::<Vec<_>>();
    if causes.next().is_some() {
        categories.push("more");
    }
    categories.join(">")
}

#[derive(Clone, Copy)]
struct GenerationRecoveryLimits {
    pages: usize,
    items: usize,
    time: Duration,
    operation_time: Duration,
    busy_timeout: Duration,
}

impl GenerationRecoveryLimits {
    /// The production safety limits: what every release build sweeps under,
    /// and what a test pins when it examines a time cutoff itself.
    const PRODUCTION_LIMITS: Self = Self {
        pages: MAX_RECOVERY_SWEEP_PAGES,
        items: MAX_RECOVERY_SWEEP_ITEMS,
        time: MAX_RECOVERY_SWEEP_TIME,
        operation_time: MAX_RECOVERY_OPERATION_TIME,
        busy_timeout: RECOVERY_SQL_BUSY_TIMEOUT,
    };

    /// The limits `recover_all_pending_attempts`, and so the post-Ready hook,
    /// sweeps under. A release build uses exactly `PRODUCTION_LIMITS`.
    #[cfg(not(test))]
    const SAFETY_LIMITS: Self = Self::PRODUCTION_LIMITS;

    /// Test builds widen only the two time cutoffs. A loaded CI runner running
    /// an unoptimized build can overrun the 250 ms per-operation limit (or the
    /// 5 s sweep limit) without anything being wrong; the sweep, and so the
    /// hook, then ends `Incomplete`, and a test that sweeps without examining
    /// time must not depend on that. The page and item cutoffs, the SQLite
    /// busy wait and the mutex wait of a recovery write stay production
    /// values. The page reads have no mutex limit of their own: only the
    /// operation cutoff bounds their mutex wait, so a test build widens that
    /// wait too. A test of a time cutoff, or of a wait that the production
    /// operation cutoff must end, names that cutoff in the limits it passes to
    /// `recover_all_pending_attempts_with_limits`, starting from
    /// `PRODUCTION_LIMITS` when it needs the production value of the other.
    #[cfg(test)]
    const SAFETY_LIMITS: Self = Self {
        time: TEST_RECOVERY_SWEEP_TIME,
        operation_time: storage::NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT,
        ..Self::PRODUCTION_LIMITS
    };
}

struct GenerationRecoveryBudget {
    limits: GenerationRecoveryLimits,
    deadline: Instant,
    pages: usize,
    items: usize,
}

impl GenerationRecoveryBudget {
    fn new(limits: GenerationRecoveryLimits) -> Self {
        Self {
            limits,
            deadline: Instant::now() + limits.time,
            pages: 0,
            items: 0,
        }
    }

    fn checkpoint(&self, owner: &GenerationRecoveryCoordinator) -> Result<()> {
        owner.ensure_current_binding()?;
        ensure!(
            Instant::now() < self.deadline,
            "NIR1_GENERATION_RECOVERY_SWEEP_TIME_LIMIT"
        );
        Ok(())
    }

    fn begin_page(&mut self, owner: &GenerationRecoveryCoordinator) -> Result<()> {
        self.checkpoint(owner)?;
        ensure!(
            self.pages < self.limits.pages,
            "NIR1_GENERATION_RECOVERY_SWEEP_PAGE_LIMIT"
        );
        self.pages += 1;
        Ok(())
    }

    fn begin_item(&mut self, owner: &GenerationRecoveryCoordinator) -> Result<()> {
        self.checkpoint(owner)?;
        ensure!(
            self.items < self.limits.items,
            "NIR1_GENERATION_RECOVERY_SWEEP_ITEM_LIMIT"
        );
        self.items += 1;
        Ok(())
    }

    fn operation(&self) -> ParticipantSqlOperationBudget {
        let operation_deadline = (Instant::now() + self.limits.operation_time).min(self.deadline);
        ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(false)),
            operation_deadline,
            self.limits.busy_timeout,
        )
    }
}

struct GenerationRecoverySingleFlight {
    state: Arc<AppState>,
    live_binding: LiveBinding,
}

impl GenerationRecoverySingleFlight {
    fn acquire(state: &Arc<AppState>, live_binding: &LiveBinding) -> Option<Self> {
        let mut active = state
            .nir1_generation_recovery_bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.iter().any(|binding| binding == live_binding) {
            return None;
        }
        active.push(live_binding.clone());
        Some(Self {
            state: Arc::clone(state),
            live_binding: live_binding.clone(),
        })
    }
}

impl Drop for GenerationRecoverySingleFlight {
    fn drop(&mut self) {
        let mut active = self
            .state
            .nir1_generation_recovery_bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(index) = active
            .iter()
            .position(|binding| binding == &self.live_binding)
        {
            active.remove(index);
        }
    }
}

impl GenerationRecoveryCoordinator {
    /// Capture only one exact Ready binding. A same-binding concurrent owner
    /// coalesces by returning `None`; the unused capture guards drop here.
    pub(crate) fn capture(state: Arc<AppState>) -> Result<Option<Self>> {
        Self::capture_for_binding(state, None, None)
    }

    fn capture_for_binding(
        state: Arc<AppState>,
        expected_binding: Option<&LiveBinding>,
        expected_revision: Option<u64>,
    ) -> Result<Option<Self>> {
        if state
            .workspace_shutdown_requested
            .load(std::sync::atomic::Ordering::Acquire)
            || state.ws.lifecycle_core().shutdown_requested()?
        {
            return Ok(None);
        }
        let lifecycle = match state.ws.lifecycle_core().snapshot() {
            Ok(lifecycle) => lifecycle,
            Err(_) => return Ok(None),
        };
        let live_binding = match lifecycle.state {
            LifecycleState::Ready(binding) => binding,
            _ => return Ok(None),
        };
        if expected_binding.is_some_and(|expected| expected != &live_binding) {
            return Ok(None);
        }
        // The sweep is pinned to one Ready entry, identified by its exact
        // binding and the entry revision (not by later revision-only changes).
        let ready_revision = match expected_revision {
            Some(revision) => revision,
            None => match current_entry_revision(&state, &live_binding, lifecycle.revision) {
                Some(revision) => revision,
                None => return Ok(None),
            },
        };
        if !same_ready_entry(&state, &live_binding, ready_revision) {
            return Ok(None);
        }
        let workspace_operation = match state.begin_workspace_operation() {
            Ok(operation) => operation,
            Err(_) => return Ok(None),
        };
        let workspace = match active_workspace_snapshot(&state.ws) {
            Ok(workspace) => workspace,
            Err(_) => return Ok(None),
        };
        if !same_ready_entry(&state, &live_binding, ready_revision) {
            return Ok(None);
        }
        ensure!(
            live_binding.authority_instance == workspace.authority.identity()
                && live_binding.locator.as_ref()
                    == workspace.authority.path().to_string_lossy().as_ref(),
            "NIR1_GENERATION_RECOVERY_BINDING_MISMATCH"
        );
        let Some(single_flight) = GenerationRecoverySingleFlight::acquire(&state, &live_binding)
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            state,
            workspace,
            live_binding,
            ready_revision,
            _single_flight: single_flight,
            _workspace_operation: workspace_operation,
        }))
    }

    /// Exhaust pending attempts across the workspace under finite safety cutoffs.
    /// Every DB operation owns its own bounded participant scope; partial
    /// terminal commits survive an incomplete pass, whose fresh owner retries.
    /// Test builds widen the two time cutoffs; see
    /// `GenerationRecoveryLimits::SAFETY_LIMITS`.
    pub(crate) fn recover_all_pending_attempts(self) -> Result<GenerationRecoverySummary> {
        self.recover_all_pending_attempts_with_limits(GenerationRecoveryLimits::SAFETY_LIMITS)
    }

    fn recover_all_pending_attempts_with_limits(
        self,
        limits: GenerationRecoveryLimits,
    ) -> Result<GenerationRecoverySummary> {
        let mut budget = GenerationRecoveryBudget::new(limits);
        let mut summary = GenerationRecoverySummary::default();
        let mut after_project_id: Option<String> = None;
        loop {
            budget.begin_page(&self)?;
            let projects = storage::pending_project_id_page_bounded(
                &self.workspace,
                after_project_id.as_deref(),
                MAX_RECOVERY_PAGE_SIZE,
                budget.operation(),
            )
            .inspect_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "NIR1_RECOVERY_BOUNDED_OP=project-page error-chain={}",
                    recovery_error_chain_categories(_error)
                );
            })?;
            summary.project_pages += 1;
            if projects.is_empty() {
                break;
            }
            for project_id in projects {
                budget.checkpoint(&self)?;
                summary.projects += 1;
                let mut after_attempt_id: Option<String> = None;
                loop {
                    budget.begin_page(&self)?;
                    let attempts = storage::pending_attempt_id_page_bounded(
                        &self.workspace,
                        &project_id,
                        after_attempt_id.as_deref(),
                        MAX_RECOVERY_PAGE_SIZE,
                        budget.operation(),
                    )
                    .inspect_err(|_error| {
                        #[cfg(test)]
                        eprintln!(
                            "NIR1_RECOVERY_BOUNDED_OP=attempt-page error-chain={}",
                            recovery_error_chain_categories(_error)
                        );
                    })?;
                    summary.attempt_pages += 1;
                    if attempts.is_empty() {
                        break;
                    }
                    for attempt_id in attempts {
                        budget.begin_item(&self)?;
                        self.recover_pending_attempt(&budget, &attempt_id)?;
                        summary.recovered += 1;
                        after_attempt_id = Some(attempt_id);
                    }
                }
                after_project_id = Some(project_id);
            }
        }
        budget.checkpoint(&self)?;
        Ok(summary)
    }

    /// Recover one pending attempt. A try that only timed out on the
    /// connection mutex ran no SQL: it is tried again right after a sweep
    /// checkpoint (shutdown, the same Ready entry, the sweep deadline), with a
    /// fresh operation deadline clipped to the sweep deadline, at most
    /// `MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS` times. Any other error, and the
    /// last timeout, leave the sweep incomplete.
    fn recover_pending_attempt(
        &self,
        budget: &GenerationRecoveryBudget,
        attempt_id: &str,
    ) -> Result<()> {
        let mut tries = 0;
        loop {
            tries += 1;
            #[cfg(test)]
            observe_generation_recovery_try(&self.state, tries);
            let result = storage::recover_attempt_bounded(
                &self.workspace,
                attempt_id,
                now_ms()?,
                budget.operation(),
            )
            .inspect_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "NIR1_RECOVERY_BOUNDED_OP=recover-attempt error-chain={}",
                    recovery_error_chain_categories(_error)
                );
            });
            let error = match result {
                Ok(_) => return Ok(()),
                Err(error) => error,
            };
            if !storage::is_recovery_connection_busy(&error) {
                return Err(error);
            }
            if tries >= MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS {
                return Err(error.context("NIR1_GENERATION_RECOVERY_CONNECTION_BUSY_LIMIT"));
            }
            budget.checkpoint(self)?;
        }
    }

    fn ensure_current_binding(&self) -> Result<()> {
        ensure!(
            !self
                .state
                .workspace_shutdown_requested
                .load(std::sync::atomic::Ordering::Acquire)
                && !self.state.ws.lifecycle_core().shutdown_requested()?,
            "NIR1_GENERATION_RECOVERY_SHUTDOWN"
        );
        ensure!(
            same_ready_entry(&self.state, &self.live_binding, self.ready_revision),
            "NIR1_GENERATION_RECOVERY_BINDING_CHANGED"
        );
        Ok(())
    }
}

/// The exact Ready entry `(binding, entry_revision)` is still current: the
/// Core publishes `binding` at or after the entry revision, and no lifecycle
/// edge has replaced the entry. Revision-only Core changes (C-query
/// quarantine set/release, background descriptor completion) keep the entry;
/// they change neither the binding nor the authority, and every edge closes
/// the startup gate. When the gate cannot identify entries (poisoned, or it
/// never observed an edge) this falls back to the exact Core revision, and the
/// gate stays Closed regardless.
pub(crate) fn same_ready_entry(
    state: &AppState,
    binding: &LiveBinding,
    entry_revision: u64,
) -> bool {
    let Ok(lifecycle) = state.ws.lifecycle_core().snapshot() else {
        return false;
    };
    if !matches!(&lifecycle.state, LifecycleState::Ready(current) if current == binding) {
        return false;
    }
    let gate = state.workspace_lifecycle.nir1_startup_gate();
    if gate.observes_lifecycle() {
        lifecycle.revision >= entry_revision && gate.is_current_ready_entry(binding, entry_revision)
    } else {
        lifecycle.revision == entry_revision
    }
}

/// Entry revision of the latest Ready entry for `binding`, or the Core
/// revision when the gate cannot identify entries.
fn current_entry_revision(
    state: &AppState,
    binding: &LiveBinding,
    core_revision: u64,
) -> Option<u64> {
    let gate = state.workspace_lifecycle.nir1_startup_gate();
    if !gate.observes_lifecycle() {
        return Some(core_revision);
    }
    match gate.current_ready_entry() {
        Some((entry_binding, entry_revision))
            if &entry_binding == binding && entry_revision <= core_revision =>
        {
            Some(entry_revision)
        }
        _ => None,
    }
}

fn spawn_generation_recovery<T: Send + 'static>(
    worker: impl FnOnce() -> T + Send + 'static,
) -> napi::tokio::task::JoinHandle<T> {
    napi::tokio::task::spawn_blocking(worker)
}

fn schedule_generation_recovery<'a>(
    state: &'a AppState,
    binding: &LiveBinding,
    ready_revision: u64,
) -> Option<std::sync::MutexGuard<'a, GenerationRecoveryHookLedger>> {
    let mut ledger = state
        .nir1_generation_recovery_statuses
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Status/revision rotation cannot retire a queued or still-running task.
    // Holding this guard through reservation closes the pre-spawn/reentry gap.
    if state
        .workspace_shutdown_requested
        .load(std::sync::atomic::Ordering::Acquire)
        || state.ws.lifecycle_core().shutdown_requested().unwrap_or(true)
        || ready_revision < ledger.latest_ready_revision
    {
        return None;
    }
    if ledger.worker_active {
        if ready_revision > ledger.latest_ready_revision {
            ledger.pending_ready_revision = Some(
                ledger
                    .pending_ready_revision
                    .map_or(ready_revision, |pending| pending.max(ready_revision)),
            );
        }
        return None;
    }
    if ready_revision > ledger.latest_ready_revision {
        ledger.latest_ready_revision = ready_revision;
        if let Some(entry) = ledger.entry.as_mut() {
            if &entry.binding != binding {
                ledger.entry = None;
            } else if matches!(
                entry.state,
                GenerationRecoveryHookState::Scheduled | GenerationRecoveryHookState::Running
            ) {
                // A newer publication invalidates any queued/running-before-capture
                // worker. Its revision-tagged cleanup can no longer mutate this row.
                entry.state = GenerationRecoveryHookState::Incomplete;
            }
        }
    }

    let scheduled = match ledger.entry.as_mut() {
        Some(entry) if &entry.binding == binding => match entry.state {
            GenerationRecoveryHookState::Scheduled | GenerationRecoveryHookState::Running => false,
            // The startup gate opens only for the exact Ready entry whose own
            // sweep completed, so a newer same-binding entry (an Unchanged
            // re-Open) sweeps again even after an older Complete.
            GenerationRecoveryHookState::Complete | GenerationRecoveryHookState::Incomplete
                if entry.ready_revision < ready_revision =>
            {
                entry.state = GenerationRecoveryHookState::Scheduled;
                entry.ready_revision = ready_revision;
                true
            }
            GenerationRecoveryHookState::Complete | GenerationRecoveryHookState::Incomplete => {
                false
            }
        },
        Some(_) => false,
        None => {
            ledger.entry = Some(GenerationRecoveryHookEntry {
                binding: binding.clone(),
                state: GenerationRecoveryHookState::Scheduled,
                ready_revision,
            });
            true
        }
    };
    scheduled.then_some(ledger)
}

fn set_generation_recovery_status(
    state: &AppState,
    binding: &LiveBinding,
    ready_revision: u64,
    status: GenerationRecoveryHookState,
) {
    let mut ledger = state
        .nir1_generation_recovery_statuses
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if ledger.latest_ready_revision != ready_revision {
        return;
    }
    if let Some(entry) = ledger
        .entry
        .as_mut()
        .filter(|entry| &entry.binding == binding && entry.ready_revision == ready_revision)
    {
        if entry.state == GenerationRecoveryHookState::Running {
            entry.state = status;
        }
    }
}

fn retire_scheduled_generation_recovery(
    state: &AppState,
    binding: &LiveBinding,
    ready_revision: u64,
) {
    let mut ledger = state
        .nir1_generation_recovery_statuses
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if ledger.latest_ready_revision == ready_revision {
        if let Some(entry) = ledger.entry.as_mut().filter(|entry| {
            &entry.binding == binding
                && entry.ready_revision == ready_revision
                && entry.state == GenerationRecoveryHookState::Scheduled
        }) {
            entry.state = GenerationRecoveryHookState::Incomplete;
        }
    }
}

struct GenerationRecoveryHookWorker {
    state: Arc<AppState>,
    binding: LiveBinding,
    ready_revision: u64,
    active: bool,
}

impl GenerationRecoveryHookWorker {
    fn start(state: Arc<AppState>, binding: LiveBinding, ready_revision: u64) -> Option<Self> {
        if state
            .workspace_shutdown_requested
            .load(std::sync::atomic::Ordering::Acquire)
            || state
                .ws
                .lifecycle_core()
                .shutdown_requested()
                .unwrap_or(true)
            || !same_ready_entry(&state, &binding, ready_revision)
        {
            retire_scheduled_generation_recovery(&state, &binding, ready_revision);
            return None;
        }
        let mut ledger = state
            .nir1_generation_recovery_statuses
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if ledger.latest_ready_revision != ready_revision {
            return None;
        }
        let entry = ledger.entry.as_mut().filter(|entry| {
            entry.binding == binding
                && entry.ready_revision == ready_revision
                && entry.state == GenerationRecoveryHookState::Scheduled
        })?;
        entry.state = GenerationRecoveryHookState::Running;
        drop(ledger);
        Some(Self {
            state,
            binding,
            ready_revision,
            active: true,
        })
    }

    fn complete(mut self) {
        set_generation_recovery_status(
            &self.state,
            &self.binding,
            self.ready_revision,
            GenerationRecoveryHookState::Complete,
        );
        self.active = false;
    }
}

impl Drop for GenerationRecoveryHookWorker {
    fn drop(&mut self) {
        if self.active {
            set_generation_recovery_status(
                &self.state,
                &self.binding,
                self.ready_revision,
                GenerationRecoveryHookState::Incomplete,
            );
        }
    }
}

#[cfg(test)]
fn observe_generation_recovery_worker_probe(state: &AppState) {
    let probe = state
        .nir1_generation_recovery_worker_probe
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some((reached, release)) = probe {
        reached
            .send(())
            .expect("recovery worker observer is waiting");
        release
            .recv_timeout(Duration::from_secs(5))
            .expect("release delayed recovery worker");
    }
}

#[cfg(test)]
fn observe_generation_recovery_try(state: &AppState, tries: usize) {
    if let Some(probe) = state
        .nir1_generation_recovery_try_probe
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_mut()
    {
        probe(tries);
    }
}

#[cfg(test)]
fn observe_generation_recovery_completion_probe(state: &AppState) {
    let probe = state
        .nir1_generation_recovery_completion_probe
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some((reached, release)) = probe {
        reached.send(()).expect("recovery completion observer");
        release
            .recv_timeout(Duration::from_secs(5))
            .expect("release recovery before actual task completion");
    }
}

/// Sweep the exact Ready entry. The returned one-shot proof travels through
/// the blocking task's JoinHandle to the supervisor, which alone may open the
/// startup gate with it after a successful Join.
fn run_generation_recovery_after_ready(
    state: Arc<AppState>,
    binding: LiveBinding,
    ready_revision: u64,
) -> Option<Nir1SweepProof> {
    let worker =
        GenerationRecoveryHookWorker::start(Arc::clone(&state), binding.clone(), ready_revision)?;
    #[cfg(test)]
    observe_generation_recovery_worker_probe(&state);
    let owner = match GenerationRecoveryCoordinator::capture_for_binding(
        Arc::clone(&state),
        Some(&binding),
        Some(ready_revision),
    ) {
        Ok(Some(owner)) => owner,
        Ok(None) => return None,
        Err(error) => {
            tracing::debug!(error = %error, "NIR-1 generation recovery incomplete");
            return None;
        }
    };
    // Recovering is entered only for this exact Ready entry, after leases
    // from earlier entries have actually dropped (bounded). Dropping the
    // owner without a sweep proof keeps the gate Closed for this entry.
    let gate_recovery = state.workspace_lifecycle.nir1_startup_gate().begin_recovery(
        &binding,
        ready_revision,
        NIR1_STARTUP_LEASE_DRAIN_LIMIT,
    );
    match owner.recover_all_pending_attempts() {
        Ok(_) => {
            worker.complete();
            gate_recovery.and_then(Nir1StartupRecovery::record_complete_sweep)
        }
        Err(error) => {
            tracing::debug!(error = %error, "NIR-1 generation recovery incomplete");
            None
        }
    }
}

/// Open the NIR-1 startup gate with the one-shot proof that the joined sweep
/// task returned, while the Core still publishes that same Ready entry. An
/// unused proof closes and consumes only its own entry when it drops.
/// Lock order: recovery ledger -> Core -> gate (never the reverse).
fn open_startup_gate_after_join(
    state: &AppState,
    binding: &LiveBinding,
    ready_revision: u64,
    proof: Nir1SweepProof,
) -> bool {
    if state
        .workspace_shutdown_requested
        .load(std::sync::atomic::Ordering::Acquire)
        || state
            .ws
            .lifecycle_core()
            .shutdown_requested()
            .unwrap_or(true)
    {
        return false;
    }
    same_ready_entry(state, binding, ready_revision)
        && state
            .workspace_lifecycle
            .nir1_startup_gate()
            .open_after_joined_sweep(proof)
}

#[cfg(test)]
fn observe_generation_recovery_launch(
    state: &AppState,
    binding: &LiveBinding,
    ready_revision: u64,
) {
    let probe = state
        .nir1_generation_recovery_launch_probe
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(sender) = probe {
        sender
            .send(GenerationRecoveryLaunchObservation {
                ready_revision,
                binding: binding.clone(),
                open_lock_available: state.ws.open_lock.try_lock().is_ok(),
                active_operation_count: state
                    .workspace_operation_active
                    .load(std::sync::atomic::Ordering::Acquire),
                participant_count: state
                    .ws
                    .lifecycle_core()
                    .workspace_participant_count()
                    .expect("launch probe participant count"),
            })
            .expect("recovery launch observer is waiting");
    }
}

/// Start best-effort recovery only from the exact Ready publication named by
/// `ready_revision`. One supervisor retains its blocking JoinHandle through
/// completion; no workspace participant is captured before the worker starts.
pub(crate) fn start_generation_recovery_after_ready(
    state: Arc<AppState>,
    view_revision: u64,
) -> bool {
    if state
        .workspace_shutdown_requested
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return false;
    }
    let lifecycle = match state.ws.lifecycle_core().snapshot() {
        Ok(lifecycle) => lifecycle,
        _ => return false,
    };
    if state
        .ws
        .lifecycle_core()
        .shutdown_requested()
        .unwrap_or(true)
    {
        return false;
    }
    let core_revision = lifecycle.revision;
    let binding = match lifecycle.state {
        LifecycleState::Ready(binding) => binding,
        _ => return false,
    };
    // The publisher's view may trail revision-only Core changes. Schedule the
    // gate's Ready entry Re when Re <= view <= Core; an older view is stale.
    let Some(ready_revision) = ready_entry_for_view(&state, &binding, view_revision, core_revision)
    else {
        return false;
    };
    let Some(mut ledger) = schedule_generation_recovery(&state, &binding, ready_revision) else {
        return false;
    };
    ledger.worker_active = true;
    drop(ledger);
    #[cfg(test)]
    observe_generation_recovery_launch(&state, &binding, ready_revision);
    let worker_state = Arc::clone(&state);
    let worker_binding = binding.clone();
    let worker = spawn_generation_recovery(move || {
        let proof = run_generation_recovery_after_ready(
            Arc::clone(&worker_state),
            worker_binding,
            ready_revision,
        );
        #[cfg(test)]
        observe_generation_recovery_completion_probe(&worker_state);
        proof
    });
    // Dropping this supervisor's handle cannot abort the blocking task. Its
    // exclusive JoinHandle stays here; a lost supervisor leaves the slot pinned.
    drop(napi::tokio::spawn(supervise_generation_recovery(
        state,
        binding,
        ready_revision,
        worker,
    )));
    true
}

/// The Ready entry revision to schedule for a publisher view, or None for a
/// stale view. Falls back to the exact view == Core rule when the gate cannot
/// identify entries.
fn ready_entry_for_view(
    state: &AppState,
    binding: &LiveBinding,
    view_revision: u64,
    core_revision: u64,
) -> Option<u64> {
    let gate = state.workspace_lifecycle.nir1_startup_gate();
    if !gate.observes_lifecycle() {
        return (view_revision == core_revision).then_some(view_revision);
    }
    let (entry_binding, entry_revision) = gate.current_ready_entry()?;
    (&entry_binding == binding && entry_revision <= view_revision && view_revision <= core_revision)
        .then_some(entry_revision)
}

async fn supervise_generation_recovery(
    state: Arc<AppState>,
    binding: LiveBinding,
    ready_revision: u64,
    worker: napi::tokio::task::JoinHandle<Option<Nir1SweepProof>>,
) {
    let joined = worker.await;
    let pending_revision = {
        let mut ledger = state
            .nir1_generation_recovery_statuses
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let proof = match joined {
            Ok(proof) => proof,
            Err(error) => {
                tracing::debug!(
                    cancelled = error.is_cancelled(),
                    panicked = error.is_panic(),
                    "NIR-1 generation recovery join failed"
                );
                if let Some(entry) = ledger.entry.as_mut().filter(|entry| {
                    entry.binding == binding && entry.ready_revision == ready_revision
                }) {
                    entry.state = GenerationRecoveryHookState::Incomplete;
                }
                // Failed Join is sticky: status/zero counters cannot release
                // the recovery slot, admit its pending replacement or unblock
                // Closed.
                return;
            }
        };
        let swept = ledger.latest_ready_revision == ready_revision
            && ledger.entry.as_ref().is_some_and(|entry| {
                entry.binding == binding
                    && entry.ready_revision == ready_revision
                    && entry.state == GenerationRecoveryHookState::Complete
            });
        // Decide before releasing the slot: an observer of `worker_active ==
        // false` sees this Join's gate decision. Without a swept status the
        // proof (if any) drops here and consumes only its own entry.
        if let (true, Some(proof)) = (swept, proof) {
            open_startup_gate_after_join(&state, &binding, ready_revision, proof);
        }
        ledger.worker_active = false;
        ledger.pending_ready_revision.take()
    };
    state.workspace_operation_notify.notify_waiters();
    // Coalesce only an actual Ready hook callback, not a revision published
    // by failed Restore. The same entry revalidates currentness/shutdown.
    if let Some(revision) = pending_revision {
        start_generation_recovery_after_ready(Arc::clone(&state), revision);
    }
}

/// Test-only synchronous form of the hook and its supervisor: sweep the
/// current Ready entry with the real worker, then open the gate with the
/// returned proof under the same ledger. Returns whether the gate opened.
#[cfg(test)]
pub(crate) fn sweep_and_open_ready_entry_for_test(state: &Arc<AppState>) -> bool {
    let Ok(lifecycle) = state.ws.lifecycle_core().snapshot() else {
        return false;
    };
    let core_revision = lifecycle.revision;
    let LifecycleState::Ready(binding) = lifecycle.state else {
        return false;
    };
    let Some(ready_revision) = ready_entry_for_view(state, &binding, core_revision, core_revision)
    else {
        return false;
    };
    let Some(mut ledger) = schedule_generation_recovery(state, &binding, ready_revision) else {
        return false;
    };
    ledger.worker_active = true;
    drop(ledger);
    let proof =
        run_generation_recovery_after_ready(Arc::clone(state), binding.clone(), ready_revision);
    let mut ledger = state
        .nir1_generation_recovery_statuses
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let opened = proof
        .is_some_and(|proof| open_startup_gate_after_join(state, &binding, ready_revision, proof));
    ledger.worker_active = false;
    opened
}

pub(crate) fn final_payload_digest(payload: &Value) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": "nir1-generation-payload@1",
        "payload": payload,
    }))?)
}

pub(crate) fn canonical_final_payload(payload: &Value) -> Result<(String, String)> {
    ensure!(
        payload.is_object(),
        "NIR1_GENERATION_FINAL_PAYLOAD_OBJECT_REQUIRED"
    );
    let canonical = canonical_json_string(payload)?;
    let digest = final_payload_digest(payload)?;
    Ok((canonical, digest))
}

pub(crate) fn final_input_digest(
    inputs: &[InputReference],
    qualifications: &[QualificationReference],
) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": grimodex_db::nir1_generation::INPUT_DIGEST_DOMAIN,
        "inputs": inputs,
        "qualifications": qualifications,
    }))?)
}

pub(crate) fn now_ms() -> Result<i64> {
    let now = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
    #[cfg(test)]
    let now = now + test_clock::offset_ms();
    Ok(now)
}

/// A test-only skew of Native's clock, per thread: how a test lets 30 days
/// pass between two turns without waiting (the validity window of a past
/// turn is decided against `now_ms()`). No product code reads it.
#[cfg(test)]
pub(crate) mod test_clock {
    use std::cell::Cell;

    thread_local! {
        static OFFSET_MS: Cell<i64> = const { Cell::new(0) };
    }

    pub(super) fn offset_ms() -> i64 {
        OFFSET_MS.with(Cell::get)
    }

    /// Restores the clock when dropped.
    pub(crate) struct ClockSkew(i64);

    impl Drop for ClockSkew {
        fn drop(&mut self) {
            OFFSET_MS.with(|offset| offset.set(self.0));
        }
    }

    /// Moves Native's clock forward by `ms` for this thread until the guard
    /// is dropped.
    pub(crate) fn advance(ms: i64) -> ClockSkew {
        let before = OFFSET_MS.with(Cell::get);
        OFFSET_MS.with(|offset| offset.set(before + ms));
        ClockSkew(before)
    }
}

/// Digest of the current normalized AI route settings. A change between two
/// reads means the route this request was prepared for is no longer current.
pub(crate) fn route_revision(state: &AppState) -> Result<String> {
    let mut settings: grimodex_ai::AiSettings =
        match std::fs::read_to_string(&state.ai_settings_path) {
            Ok(contents) => {
                serde_json::from_str(&contents).context("NIR1_GENERATION_ROUTE_UNAVAILABLE")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => return Err(error).context("NIR1_GENERATION_ROUTE_UNAVAILABLE"),
        };
    settings.normalize_openai_compatible();
    Ok(canonical_json_digest(&serde_json::to_value(settings)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::domain_writes::{tree_node_create, TreeNodeCreatePayload};
    use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
    use grimodex_db::nir1_generation::{
        AttemptBinding, AttemptBindingVersion, AttemptCallerBinding, FailureClassification,
        GenerationPurpose, NewAttempt, StoredAttempt,
    };
    use grimodex_db::state::{ActiveWorkspace, WorkspaceAuthority};
    use grimodex_db::workspace_lifecycle::AdmissionKind;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    use std::thread;

    const BUDGET: ReadBudget = ReadBudget {
        max_references: 8,
        max_reference_bytes: 4096,
    };

    /// Create a live Scene through the Native tree writer, which mints its A1
    /// scope incarnation, and attach the chat session to it.
    fn attach_scene(
        db: &grimodex_db::Database,
        project_id: &str,
        scene_id: &str,
        session_id: &str,
    ) {
        tree_node_create(
            db,
            TreeNodeCreatePayload {
                id: scene_id.into(),
                project_id: project_id.into(),
                request_id: format!("{scene_id}-create"),
                session_id: session_id.into(),
                event_uid: format!("{scene_id}-create-event"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                parent_id: None,
                node_type: "scene".into(),
                title: "Fixture".into(),
                sort_order: "a0".into(),
                synopsis: None,
                status: None,
                source_uri: None,
                source_mtime: None,
                content: Some(r#"{"type":"doc","content":[]}"#.into()),
                canonical_payload: None,
            },
        )
        .expect("Scene through the Native tree writer");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE chat_sessions SET node_id=?1 WHERE id=?2 AND project_id=?3",
                [scene_id, session_id, project_id],
            )?;
            Ok(())
        })
        .expect("attach the chat session to the Scene");
    }

    fn recovery_attempt(db: &grimodex_db::Database, ordinal: usize) -> NewAttempt {
        recovery_attempt_for(db, "recovery-project", "recovery-session", ordinal)
    }

    fn recovery_scene_id(project_id: &str) -> String {
        format!("{project_id}-scene")
    }

    fn recovery_attempt_for(
        db: &grimodex_db::Database,
        project_id: &str,
        session_id: &str,
        ordinal: usize,
    ) -> NewAttempt {
        let digest =
            canonical_json_digest(&json!(["recovery", project_id, ordinal])).expect("digest");
        let scene = db
            .with_read_transaction(|conn| {
                storage::read_attempt_scene_binding_in_tx(
                    conn,
                    project_id,
                    &recovery_scene_id(project_id),
                )
            })
            .expect("recovery Scene binding");
        NewAttempt {
            binding: AttemptBinding {
                binding_version: AttemptBindingVersion::V2,
                project_id: project_id.into(),
                chat_session_id: session_id.into(),
                scene,
                caller: AttemptCallerBinding {
                    profile_id: "recovery-profile".into(),
                    caller_id: "recovery-owner".into(),
                    caller_epoch: 1,
                    caller_session_id: "recovery-caller-session".into(),
                },
                workspace_binding_digest: digest.clone(),
                route_revision: digest.clone(),
                purpose: GenerationPurpose::Writing,
                scope_digest: digest.clone(),
                material_digest: digest.clone(),
                d1_digest: digest.clone(),
                provider: "recovery-recorder".into(),
                model: "recovery".into(),
                api: "internal".into(),
                endpoint_identity: digest.clone(),
                history_turn_context: None,
                durable_workspace_identity: None,
            },
            payload_digest: digest,
            inputs: vec![],
            qualifications: vec![],
            created_at_ms: i64::try_from(ordinal + 1).expect("created time"),
            expires_at_ms: i64::try_from(ordinal + 60).expect("expiry"),
            budget: BUDGET,
        }
    }

    fn recovery_workspace(attempt_count: usize) -> (PathBuf, Vec<StoredAttempt>) {
        let root =
            std::env::temp_dir().join(format!("nir1-generation-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
        std::fs::write(
            root.join(".grimodex/workspace.json"),
            serde_json::json!({
                "id": "recovery-workspace",
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
        db.migrate().expect("schema");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects(id,title) VALUES ('recovery-project','Recovery');
                 INSERT INTO chat_sessions(id,project_id,title)
                 VALUES ('recovery-session','recovery-project','Recovery');",
            )?;
            Ok(())
        })
        .expect("workspace rows");
        attach_scene(
            &db,
            "recovery-project",
            &recovery_scene_id("recovery-project"),
            "recovery-session",
        );
        let attempts = (0..attempt_count)
            .map(|ordinal| storage::create_attempt(&db, recovery_attempt(&db, ordinal)))
            .collect::<Result<Vec<_>>>()
            .expect("pending attempts");
        (root, attempts)
    }

    fn recovery_workspace_many(
        project_count: usize,
        attempts_on_first_project: usize,
    ) -> (PathBuf, Vec<StoredAttempt>, Vec<String>) {
        assert!(project_count > 0);
        let root = std::env::temp_dir().join(format!(
            "nir1-generation-recovery-many-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
        std::fs::write(
            root.join(".grimodex/workspace.json"),
            r#"{"id":"recovery-workspace"}"#,
        )
        .expect("workspace metadata");
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
        db.migrate().expect("schema");
        let project_ids = (0..project_count)
            .map(|index| format!("recovery-project-{index:04}"))
            .collect::<Vec<_>>();
        db.with_conn(|conn| {
            for (index, project_id) in project_ids.iter().enumerate() {
                let session_id = format!("recovery-session-{index:04}");
                conn.execute(
                    "INSERT INTO projects(id,title) VALUES (?1,'Recovery')",
                    [project_id],
                )?;
                conn.execute(
                    "INSERT INTO chat_sessions(id,project_id,title) VALUES (?1,?2,'Recovery')",
                    [session_id.as_str(), project_id.as_str()],
                )?;
            }
            Ok(())
        })
        .expect("workspace rows");
        for (index, project_id) in project_ids.iter().enumerate() {
            attach_scene(
                &db,
                project_id,
                &recovery_scene_id(project_id),
                &format!("recovery-session-{index:04}"),
            );
        }
        let attempts = (0..attempts_on_first_project)
            .map(|ordinal| {
                storage::create_attempt(
                    &db,
                    recovery_attempt_for(&db, &project_ids[0], "recovery-session-0000", ordinal),
                )
            })
            .collect::<Result<Vec<_>>>()
            .expect("pending attempts");
        (root, attempts, project_ids)
    }

    fn reopened_recovery_state(root: &Path) -> Arc<AppState> {
        let app_dir = root.join("native-app");
        let resources = root.join("resources");
        let state = Arc::new(
            AppState::new(
                app_dir.to_str().expect("app path"),
                resources.to_str().expect("resource path"),
            )
            .expect("native state"),
        );
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("reopen database");
        db.migrate().expect("reopen schema");
        let authority =
            WorkspaceAuthority::from_database_for_test(db, root.to_path_buf()).expect("authority");
        let binding = LiveBinding::new(
            root.to_string_lossy(),
            "recovery-workspace",
            authority.identity(),
            2,
        );
        *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace::new(authority));
        state
            .ws
            .lifecycle_core()
            .set_ready(binding)
            .expect("reopened workspace ready");
        state
    }

    fn recovery_hook_state(
        state: &AppState,
        binding: &LiveBinding,
    ) -> Option<GenerationRecoveryHookState> {
        state
            .nir1_generation_recovery_statuses
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry
            .as_ref()
            .filter(|entry| &entry.binding == binding)
            .map(|entry| entry.state)
    }

    /// The production limits keep the plan values; test builds widen only the
    /// two time cutoffs, so a test that sweeps through the hook does not hit
    /// them on a slow runner.
    #[test]
    fn test_builds_widen_only_the_recovery_time_cutoffs() {
        let production = GenerationRecoveryLimits::PRODUCTION_LIMITS;
        assert_eq!(production.pages, 4_096);
        assert_eq!(production.items, 2_048);
        assert_eq!(production.time, Duration::from_secs(5));
        assert_eq!(production.operation_time, Duration::from_millis(250));
        assert_eq!(production.busy_timeout, Duration::from_millis(100));

        let tests = GenerationRecoveryLimits::SAFETY_LIMITS;
        assert_eq!(tests.pages, production.pages);
        assert_eq!(tests.items, production.items);
        assert_eq!(tests.busy_timeout, production.busy_timeout);
        assert!(tests.time > production.time);
        assert!(tests.operation_time > production.operation_time);
        assert_eq!(
            tests.operation_time,
            storage::NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT,
            "the sweep shares the per-operation test limit of the bounded writers"
        );
        assert!(
            tests.operation_time < tests.time,
            "one operation stays inside the sweep, as in production"
        );
    }

    #[test]
    fn recovery_error_chain_diagnostic_is_redacted_and_bounded() {
        let error = anyhow::anyhow!("SQLITE_BUSY: database is locked; opaque detail")
            .context("recovery wrapper");
        let diagnostic = recovery_error_chain_categories(&error);
        assert_eq!(diagnostic, "other>sqlite-busy");
        assert!(!diagnostic.contains("opaque detail"));

        let mut deep_error = anyhow::anyhow!("unclassified terminal detail");
        for _ in 0..8 {
            deep_error = deep_error.context("wrapper");
        }
        assert_eq!(
            recovery_error_chain_categories(&deep_error),
            "other>other>other>other>other>other>other>other>more"
        );
    }

    #[test]
    fn cold_reopen_recovery_exhausts_pending_pages_without_resend() {
        let (root, attempts) = recovery_workspace(3);
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("trusted reopened coordinator");
        let db = Arc::clone(&coordinator.workspace.authority);
        let summary = coordinator
            .recover_all_pending_attempts()
            .expect("recover all pages");
        assert_eq!(
            summary,
            GenerationRecoverySummary {
                project_pages: 2,
                projects: 1,
                attempt_pages: 2,
                recovered: 3
            }
        );
        assert!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
                .expect("pending page")
                .is_empty()
        );
        for attempt in attempts {
            let terminal = storage::read_terminal(db.db(), &attempt.id)
                .expect("terminal read")
                .expect("recovery terminal");
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::InterruptedUnknown)
            );
            assert_eq!(terminal.attempt_id, attempt.id);
            assert!(terminal.message_version.is_none());
            assert_eq!(terminal.observation["terminalStatus"], "failed");
            assert_eq!(terminal.observation["parseStatus"], "not-attempted");
            assert!(terminal.observation["responseDigest"].is_null());
        }
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn bounded_recovery_survives_wall_clock_regression_after_cold_reopen() {
        let (root, _) = recovery_workspace(0);
        let future_time = now_ms().expect("wall clock") + 60_000;
        let attempt = {
            let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
            let mut request = recovery_attempt(&db, 0);
            request.created_at_ms = future_time;
            request.expires_at_ms = future_time + 60_000;
            let attempt = storage::create_attempt(&db, request).expect("future-clock attempt");
            assert!(storage::claim_attempt(
                &db,
                &attempt.id,
                &attempt.binding,
                future_time + 1,
                BUDGET,
            )
            .expect("claim before clock regression"));
            attempt
        };
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture")
            .expect("ready");
        let db = Arc::clone(&coordinator.workspace.authority);
        assert_eq!(
            coordinator
                .recover_all_pending_attempts()
                .expect("recover")
                .recovered,
            1
        );
        let terminal = storage::read_terminal(db.db(), &attempt.id)
            .expect("terminal read")
            .expect("terminal");
        assert_eq!(terminal.completed_at_ms, future_time + 1);
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        assert!(terminal.message_version.is_none());
        assert!(terminal.observation["providerTerminal"].is_null());
        assert!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 1)
                .expect("pending page")
                .is_empty()
        );
        assert!(!storage::claim_attempt(
            db.db(),
            &attempt.id,
            &attempt.binding,
            future_time + 2,
            BUDGET
        )
        .expect("no resend"));
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recovery_stops_when_workspace_admission_closes() {
        let (root, attempts) = recovery_workspace(2);
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("trusted reopened coordinator");
        let db = Arc::clone(&coordinator.workspace.authority);
        state
            .ws
            .lifecycle_core()
            .request_shutdown()
            .expect("close workspace admission");
        assert!(coordinator.recover_all_pending_attempts().is_err());
        assert_eq!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
                .expect("pending after shutdown")
                .len(),
            attempts.len()
        );
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recovery_retries_remaining_pages_after_partial_failure() {
        let (root, attempts) = recovery_workspace(3);
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("trusted reopened coordinator");
        let db = Arc::clone(&coordinator.workspace.authority);
        let first_page = storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
            .expect("first page");
        assert_eq!(first_page.len(), 3);
        let failed_id = first_page[1].clone();
        let escaped_id = failed_id.replace('\'', "''");
        db.db()
            .with_conn(|conn| {
                conn.execute_batch(&format!(
                    "CREATE TEMP TRIGGER fail_generation_recovery
                     BEFORE UPDATE OF terminal_json ON nir1_generation_attempts
                     WHEN OLD.id = '{escaped_id}'
                     BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;"
                ))?;
                Ok(())
            })
            .expect("failpoint");
        assert!(coordinator.recover_all_pending_attempts().is_err());
        assert!(storage::read_terminal(db.db(), &first_page[0])
            .expect("first terminal read")
            .is_some());
        assert!(storage::read_terminal(db.db(), &failed_id)
            .expect("failed terminal read")
            .is_none());
        db.db()
            .with_conn(|conn| {
                conn.execute_batch("DROP TRIGGER fail_generation_recovery")?;
                Ok(())
            })
            .expect("remove failpoint");

        let retry = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture retry coordinator")
            .expect("retry coordinator");
        let retry_db = Arc::clone(&retry.workspace.authority);
        let summary = retry
            .recover_all_pending_attempts()
            .expect("retry remaining attempts");
        assert_eq!(summary.recovered, 2);
        assert!(
            storage::pending_attempt_ids(retry_db.db(), "recovery-project", None, 64)
                .expect("pending after retry")
                .is_empty()
        );
        for attempt in attempts {
            assert!(storage::read_terminal(retry_db.db(), &attempt.id)
                .expect("terminal after retry")
                .is_some());
        }
        drop(retry_db);
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recovery_is_pinned_to_the_reopened_workspace_database() {
        let (first_root, first_attempts) = recovery_workspace(1);
        let (second_root, second_attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&second_root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("second workspace coordinator");
        let db = Arc::clone(&coordinator.workspace.authority);
        let summary = coordinator
            .recover_all_pending_attempts()
            .expect("second workspace recovery");
        assert_eq!(summary.recovered, 1);
        assert!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
                .expect("second pending")
                .is_empty()
        );
        let first_db = grimodex_db::Database::new(&first_root.join("grimodex.db"))
            .expect("first workspace database");
        assert_eq!(
            storage::pending_attempt_ids(&first_db, "recovery-project", None, 1)
                .expect("first pending")
                .len(),
            first_attempts.len()
        );
        assert!(storage::read_terminal(db.db(), &second_attempts[0].id)
            .expect("second terminal")
            .is_some());
        drop(db);
        drop(state);
        drop(first_db);
        std::fs::remove_dir_all(first_root).expect("first cleanup");
        std::fs::remove_dir_all(second_root).expect("second cleanup");
    }

    #[test]
    fn recovery_keyset_pages_more_than_64_projects_and_attempts() {
        let (root, mut attempts, project_ids) = recovery_workspace_many(65, 65);
        {
            let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
            for (index, project_id) in project_ids.iter().enumerate().skip(1) {
                attempts.push(
                    storage::create_attempt(
                        &db,
                        recovery_attempt_for(
                            &db,
                            project_id,
                            &format!("recovery-session-{index:04}"),
                            0,
                        ),
                    )
                    .expect("pending attempt on every project"),
                );
            }
        }
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("trusted reopened coordinator");
        let db = Arc::clone(&coordinator.workspace.authority);
        // This test pins keyset paging, not timing. It sweeps under the
        // default limits of a test build: the production page and item
        // cutoffs, and room for the ~260 bounded operations of an unoptimized
        // build on a loaded CI runner under the time cutoffs (the 250 ms
        // per-operation limit elapsed there once).
        let summary = coordinator
            .recover_all_pending_attempts()
            .expect("recover complete all-project sweep");

        assert_eq!(summary.project_pages, 3);
        assert_eq!(summary.projects, 65);
        assert_eq!(summary.attempt_pages, 131);
        assert_eq!(summary.recovered, attempts.len());
        assert!(
            storage::pending_attempt_ids(db.db(), &project_ids[0], None, 64)
                .expect("pending attempts exhausted")
                .is_empty()
        );
        for attempt in attempts {
            let terminal = storage::read_terminal(db.db(), &attempt.id)
                .expect("terminal read")
                .expect("terminalized attempt");
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::InterruptedUnknown)
            );
            assert!(terminal.message_version.is_none());
        }
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recovery_page_limit_retry_progresses_past_empty_and_terminal_projects() {
        let (root, mut attempts, project_ids) = recovery_workspace_many(6, 0);
        {
            let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
            for (index, project_id) in project_ids.iter().enumerate().skip(4) {
                attempts.push(
                    storage::create_attempt(
                        &db,
                        recovery_attempt_for(
                            &db,
                            project_id,
                            &format!("recovery-session-{index:04}"),
                            0,
                        ),
                    )
                    .expect("pending attempt after empty projects"),
                );
            }
        }
        let state = reopened_recovery_state(&root);
        let limits = GenerationRecoveryLimits {
            pages: 3,
            ..GenerationRecoveryLimits::SAFETY_LIMITS
        };
        for recovered_index in 0..attempts.len() {
            let owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
                .expect("capture fresh owner")
                .expect("previous page-limited owner released");
            let db = Arc::clone(&owner.workspace.authority);
            let error = owner
                .recover_all_pending_attempts_with_limits(limits)
                .expect_err("three pages allow one project but not a complete sweep");
            assert!(error.to_string().contains("SWEEP_PAGE_LIMIT"));
            for (index, attempt) in attempts.iter().enumerate() {
                assert_eq!(
                    storage::read_terminal(db.db(), &attempt.id)
                        .expect("terminal read")
                        .is_some(),
                    index <= recovered_index,
                    "each fresh owner must retire the next pending project with the same page limit"
                );
            }
        }
        let summary = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture final owner")
            .expect("ready owner")
            .recover_all_pending_attempts_with_limits(limits)
            .expect("same limit proves exhaustion after pending rows are retired");
        assert_eq!(
            summary,
            GenerationRecoverySummary {
                project_pages: 1,
                ..GenerationRecoverySummary::default()
            }
        );
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recovery_sweep_page_item_and_time_limits_are_incomplete_and_retryable() {
        let (root, attempts) = recovery_workspace(3);
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("ready owner");
        let db = Arc::clone(&coordinator.workspace.authority);
        let first_id = storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
            .expect("pending before limited sweep")[0]
            .clone();
        let mut page_limits = GenerationRecoveryLimits::SAFETY_LIMITS;
        page_limits.pages = 1;
        let error = coordinator
            .recover_all_pending_attempts_with_limits(page_limits)
            .expect_err("page limit cannot admit a pending-attempt query");
        assert!(error.to_string().contains("SWEEP_PAGE_LIMIT"));

        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture item-limited owner")
            .expect("page-limited owner released");
        let mut item_limits = GenerationRecoveryLimits::SAFETY_LIMITS;
        item_limits.items = 1;
        // Isolate the item cutoff from independent sweep/operation deadlines;
        // keep both finite in case this test stalls.
        item_limits.time = Duration::from_secs(30);
        item_limits.operation_time = Duration::from_secs(5);
        let error = coordinator
            .recover_all_pending_attempts_with_limits(item_limits)
            .expect_err("item limit is incomplete");
        assert!(
            error.to_string().contains("SWEEP_ITEM_LIMIT"),
            "unexpected error: {error:#}"
        );
        assert!(storage::read_terminal(db.db(), &first_id)
            .expect("first committed terminal")
            .is_some());
        assert_eq!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
                .expect("pending after item cutoff")
                .len(),
            attempts.len() - 1
        );
        assert!(state
            .nir1_generation_recovery_bindings
            .lock()
            .expect("single-flight lock")
            .is_empty());

        let retry = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture fresh owner")
            .expect("fresh owner after incomplete pass");
        let retry_summary = retry
            .recover_all_pending_attempts()
            .expect("fresh owner retries pending rows");
        assert_eq!(retry_summary.recovered, attempts.len() - 1);
        assert!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
                .expect("pending after retry")
                .is_empty()
        );

        let time_owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture time-limited owner")
            .expect("ready owner");
        let mut time_limits = GenerationRecoveryLimits::SAFETY_LIMITS;
        time_limits.time = Duration::ZERO;
        let error = time_owner
            .recover_all_pending_attempts_with_limits(time_limits)
            .expect_err("elapsed sweep deadline is incomplete");
        assert!(error.to_string().contains("SWEEP_TIME_LIMIT"));
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    /// The test-build widening is only the default: a test that names the
    /// per-operation cutoff, starting from the production limits, still ends
    /// the sweep Incomplete before any attempt is terminalized, and a fresh
    /// owner retries.
    #[test]
    fn recovery_operation_time_limit_is_incomplete_and_retryable() {
        let (root, attempts) = recovery_workspace(2);
        let state = reopened_recovery_state(&root);
        let coordinator = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture recovery coordinator")
            .expect("ready owner");
        let db = Arc::clone(&coordinator.workspace.authority);
        let lapsed = GenerationRecoveryLimits {
            operation_time: Duration::ZERO,
            ..GenerationRecoveryLimits::PRODUCTION_LIMITS
        };
        let error = coordinator
            .recover_all_pending_attempts_with_limits(lapsed)
            .expect_err("a lapsed operation deadline leaves the sweep incomplete");
        assert!(
            format!("{error:#}").contains("deadline elapsed"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            storage::pending_attempt_ids(db.db(), "recovery-project", None, 64)
                .expect("pending after the lapsed operation")
                .len(),
            attempts.len()
        );
        assert!(state
            .nir1_generation_recovery_bindings
            .lock()
            .expect("single-flight lock")
            .is_empty());

        let retry = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture fresh owner")
            .expect("fresh owner after the incomplete pass");
        assert_eq!(
            retry
                .recover_all_pending_attempts()
                .expect("fresh owner retries pending rows")
                .recovered,
            attempts.len()
        );
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn same_binding_recovery_reentry_coalesces_and_releases_its_owner() {
        let (root, _) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture owner")
            .expect("first owner admitted");
        assert!(GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("reentrant capture")
            .is_none());
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 1);
        drop(owner);
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert!(state
            .nir1_generation_recovery_bindings
            .lock()
            .expect("single-flight lock")
            .is_empty());
        let retry = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("fresh capture")
            .expect("single-flight released");
        drop(retry);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn held_database_mutex_does_not_pin_recovery_owner_through_transition_or_shutdown() {
        for shutdown in [false, true] {
            let (root, _) = recovery_workspace(1);
            let state = reopened_recovery_state(&root);
            let owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
                .expect("capture owner")
                .expect("ready owner");
            let db = Arc::clone(&owner.workspace.authority);
            let (locked_tx, locked_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let lock_db = Arc::clone(&db);
            let lock_worker = thread::spawn(move || {
                lock_db.db().with_conn(|_| {
                    locked_tx.send(()).expect("signal held DB mutex");
                    release_rx
                        .recv_timeout(Duration::from_secs(2))
                        .expect("release held DB mutex");
                    Ok(())
                })
            });
            locked_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("DB mutex held");

            let (result_tx, result_rx) = mpsc::channel();
            let worker = thread::spawn(move || {
                let result = owner.recover_all_pending_attempts();
                result_tx.send(result).expect("return incomplete result");
            });
            thread::sleep(Duration::from_millis(25));
            let core = state.ws.lifecycle_core();
            let transition = if shutdown {
                core.request_shutdown().expect("request core shutdown");
                state.request_workspace_shutdown();
                None
            } else {
                Some(
                    core.begin_transition(AdmissionKind::Open)
                        .expect("begin workspace transition"),
                )
            };
            let started = Instant::now();
            let result = result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("bounded operation exits before releasing DB mutex");
            assert!(result.is_err());
            assert!(started.elapsed() < Duration::from_millis(750));
            assert_eq!(core.workspace_participant_count().expect("participants"), 0);
            assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
            assert!(state
                .nir1_generation_recovery_bindings
                .lock()
                .expect("single-flight lock")
                .is_empty());

            release_tx.send(()).expect("release DB holder");
            lock_worker
                .join()
                .expect("DB holder joined")
                .expect("DB holder");
            worker.join().expect("recovery worker joined");
            drop(transition);
            drop(core);
            drop(db);
            drop(state);
            std::fs::remove_dir_all(root).expect("cleanup");
        }
    }

    #[tokio::test]
    async fn recovery_launcher_accepts_ready_only_and_does_not_await_blocked_db_work() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let authority = Arc::clone(
            &state
                .ws
                .inner
                .lock()
                .expect("workspace lock")
                .as_ref()
                .expect("ready workspace")
                .authority,
        );
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let lock_authority = Arc::clone(&authority);
        let lock_worker = thread::spawn(move || {
            lock_authority.db().with_conn(|_| {
                locked_tx.send(()).expect("signal held DB mutex");
                release_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("release held DB mutex");
                Ok(())
            })
        });
        locked_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("DB mutex held");
        let ready_revision = state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Ready snapshot")
            .revision;

        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            ready_revision,
        ));
        assert!(state
            .nir1_generation_recovery_statuses
            .lock()
            .expect("recovery hook state")
            .entry
            .as_ref()
            .is_some_and(|entry| matches!(
                entry.state,
                GenerationRecoveryHookState::Scheduled | GenerationRecoveryHookState::Running
            )));
        release_tx.send(()).expect("release DB holder");
        lock_worker
            .join()
            .expect("DB holder joined")
            .expect("DB holder");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if storage::read_terminal(authority.db(), &attempts[0].id)
                .expect("terminal lookup")
                .is_some()
            {
                break;
            }
            assert!(Instant::now() < deadline, "detached recovery timed out");
            thread::sleep(Duration::from_millis(5));
        }
        while state.workspace_operation_active.load(Ordering::Acquire) != 0
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert!(state
            .nir1_generation_recovery_bindings
            .lock()
            .expect("single-flight lock")
            .is_empty());

        let core = state.ws.lifecycle_core();
        let transition = core
            .begin_transition(AdmissionKind::Open)
            .expect("begin transition");
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            ready_revision,
        ));
        drop(transition);
        drop(core);
        drop(authority);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn post_ready_hook_rejects_stale_requires_open_recovery_required_and_closed_states() {
        let (root, _) = recovery_workspace(0);
        let state = reopened_recovery_state(&root);
        let ready_revision = state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Ready snapshot")
            .revision;
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            ready_revision.saturating_add(1),
        ));

        state
            .workspace_lifecycle
            .begin_transition()
            .expect("begin failed-operation transition");
        let recovery_required = state
            .workspace_lifecycle
            .publish_recovery_required(&state.ws)
            .expect("publish recovery-required");
        assert_eq!(
            recovery_required.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::RecoveryRequired
        );
        assert_eq!(
            recovery_required.activation,
            crate::workspace_lifecycle_view::WorkspaceLifecycleActivation::RequiresOpen
        );
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            recovery_required.revision,
        ));

        assert!(state
            .nir1_generation_recovery_statuses
            .lock()
            .expect("recovery hook state")
            .entry
            .is_none());
        drop(state);

        let closed_state = Arc::new(
            AppState::new(
                root.join("closed-app").to_str().expect("closed app path"),
                root.join("closed-resources")
                    .to_str()
                    .expect("closed resources path"),
            )
            .expect("closed Native state"),
        );
        let closed = closed_state
            .workspace_lifecycle
            .publish_closed()
            .expect("publish closed");
        assert_eq!(
            closed.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Closed
        );
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&closed_state),
            closed.revision,
        ));
        assert!(closed_state
            .nir1_generation_recovery_statuses
            .lock()
            .expect("recovery hook state")
            .entry
            .is_none());
        drop(closed_state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn incomplete_open_recovery_is_retryable_at_a_later_ready_entry() {
        let (root, attempts) = recovery_workspace(1);
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("fixture DB");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_generation_recovery
                 BEFORE UPDATE OF terminal_json ON nir1_generation_attempts
                 BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;",
            )?;
            Ok(())
        })
        .expect("install recovery failpoint");
        drop(db);
        let state = Arc::new(
            AppState::new(
                root.join("native-app").to_str().expect("app path"),
                root.join("resources").to_str().expect("resources path"),
            )
            .expect("native state"),
        );
        let backend = crate::Backend {
            state: Arc::clone(&state),
        };
        let first_open = backend
            .open_workspace(root.to_string_lossy().into_owned())
            .await
            .expect("Open succeeds despite best-effort recovery failure");
        let first_open: Value = serde_json::from_str(&first_open).expect("Open outcome");
        assert!(matches!(
            first_open["status"].as_str(),
            Some("ready" | "migrated")
        ));
        let first_binding = match state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("first Ready binding")
            .state
        {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected first Ready binding, got {state:?}"),
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        while recovery_hook_state(&state, &first_binding)
            != Some(GenerationRecoveryHookState::Incomplete)
        {
            assert!(
                Instant::now() < deadline,
                "failed recovery did not retire boundedly"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let db = active_workspace_snapshot(&state.ws).expect("Ready workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("pending after failed recovery")
            .is_none());
        db.db()
            .with_conn(|conn| {
                conn.execute_batch("DROP TRIGGER fail_generation_recovery")?;
                Ok(())
            })
            .expect("remove recovery failpoint");
        drop(db);
        assert!(
            state.ws.open_lock.try_lock().is_ok(),
            "failed Open released its lock"
        );

        let second_open = backend
            .open_workspace(root.to_string_lossy().into_owned())
            .await
            .expect("later Open is not blocked by incomplete recovery");
        let second_open: Value = serde_json::from_str(&second_open).expect("second Open outcome");
        assert!(matches!(
            second_open["status"].as_str(),
            Some("ready" | "migrated")
        ));
        let second_binding = match state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("second Ready binding")
            .state
        {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected second Ready binding, got {state:?}"),
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        while recovery_hook_state(&state, &second_binding)
            != Some(GenerationRecoveryHookState::Complete)
        {
            assert!(
                Instant::now() < deadline,
                "later Ready entry did not retry recovery"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let db = active_workspace_snapshot(&state.ws).expect("retried Ready workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal after fresh owner retry")
            .is_some());
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        drop(db);
        // Close the workspace before deleting it: background lifecycle work
        // may still write into the root after the retried recovery completes.
        let closed: Value = serde_json::from_str(
            &backend
                .shutdown_workspace_lifecycle()
                .await
                .expect("shutdown workspace lifecycle"),
        )
        .expect("shutdown view JSON");
        assert_eq!(closed["status"], "closed");
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn delayed_binding_a_worker_and_launcher_cannot_mutate_ready_binding_b() {
        let (root_a, attempts_a) = recovery_workspace(1);
        let (root_b, attempts_b) = recovery_workspace(1);
        let state = reopened_recovery_state(&root_a);
        let ready_a = state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("A Ready snapshot");
        let ready_revision_a = ready_a.revision;
        let binding_a = match ready_a.state {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected A Ready binding, got {state:?}"),
        };
        let db_b = grimodex_db::Database::new(&root_b.join("grimodex.db")).expect("B DB");
        let authority_b =
            WorkspaceAuthority::from_database_for_test(db_b, root_b.clone()).expect("B authority");
        let core = state.ws.lifecycle_core();
        assert!(schedule_generation_recovery(
            &state,
            &binding_a,
            ready_revision_a,
        )
        .is_some());
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert_eq!(core.workspace_participant_count().expect("participants"), 0);
        let worker_a = GenerationRecoveryHookWorker::start(
            Arc::clone(&state),
            binding_a.clone(),
            ready_revision_a,
        )
        .expect("A queued worker begins");
        state
            .workspace_lifecycle
            .begin_transition()
            .expect("transition A to B");
        *state.ws.inner.lock().expect("workspace swap") = Some(ActiveWorkspace::new(authority_b));
        state
            .workspace_lifecycle
            .complete_transition_from_workspace(&state.ws)
            .expect("publish B Ready");
        let ready_b = core.snapshot().expect("B Ready snapshot");
        let ready_revision_b = ready_b.revision;
        let binding_b = match ready_b.state {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected B Ready binding, got {state:?}"),
        };
        assert!(ready_revision_b > ready_revision_a);
        assert!(schedule_generation_recovery(
            &state,
            &binding_b,
            ready_revision_b,
        )
        .is_some());
        // Model an A launcher paused after observing Ready A but before status
        // scheduling. It may not prune the already-scheduled Ready B entry.
        assert!(schedule_generation_recovery(
            &state,
            &binding_a,
            ready_revision_a,
        )
        .is_none());
        assert!(GenerationRecoveryCoordinator::capture_for_binding(
            Arc::clone(&state),
            Some(&binding_a),
            Some(ready_revision_a),
        )
        .expect("delayed A capture")
        .is_none());
        drop(worker_a);
        assert_eq!(recovery_hook_state(&state, &binding_a), None);
        assert_eq!(
            recovery_hook_state(&state, &binding_b),
            Some(GenerationRecoveryHookState::Scheduled)
        );
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert!(state
            .nir1_generation_recovery_bindings
            .lock()
            .expect("single-flight owners")
            .is_empty());
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            ready_revision_b,
        ));
        drop(run_generation_recovery_after_ready(
            Arc::clone(&state),
            binding_b.clone(),
            ready_revision_b,
        ));
        assert_eq!(
            recovery_hook_state(&state, &binding_b),
            Some(GenerationRecoveryHookState::Complete)
        );
        let db_b = active_workspace_snapshot(&state.ws).expect("B workspace");
        assert!(storage::read_terminal(db_b.db(), &attempts_b[0].id)
            .expect("B recovery terminal")
            .is_some());
        let db_a = grimodex_db::Database::new(&root_a.join("grimodex.db")).expect("A DB");
        assert!(storage::read_terminal(&db_a, &attempts_a[0].id)
            .expect("A attempt remains pending")
            .is_none());
        assert!(state
            .nir1_generation_recovery_statuses
            .lock()
            .expect("bounded recovery status")
            .entry
            .as_ref()
            .is_some_and(|entry| entry.binding == binding_b));
        drop(db_b);
        drop(db_a);
        drop(core);
        drop(state);
        std::fs::remove_dir_all(root_a).expect("A cleanup");
        std::fs::remove_dir_all(root_b).expect("B cleanup");
    }

    #[tokio::test]
    async fn recovery_hook_shutdown_during_database_wait_releases_all_owners() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let authority = Arc::clone(
            &state
                .ws
                .inner
                .lock()
                .expect("workspace lock")
                .as_ref()
                .expect("Ready workspace")
                .authority,
        );
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let lock_authority = Arc::clone(&authority);
        let lock_worker = thread::spawn(move || {
            lock_authority.db().with_conn(|_| {
                locked_tx.send(()).expect("signal held DB mutex");
                release_rx
                    .recv_timeout(Duration::from_secs(3))
                    .expect("release held DB mutex");
                Ok(())
            })
        });
        locked_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("DB mutex held");
        let ready_snapshot = state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Ready snapshot");
        let revision = ready_snapshot.revision;
        let binding = match ready_snapshot.state {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected Ready binding, got {state:?}"),
        };
        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            revision
        ));
        let core = state.ws.lifecycle_core();
        let deadline = Instant::now() + Duration::from_secs(2);
        while core.workspace_participant_count().expect("participants") == 0 {
            assert!(
                Instant::now() < deadline,
                "recovery did not start before shutdown"
            );
            thread::sleep(Duration::from_millis(5));
        }
        core.request_shutdown().expect("request lifecycle shutdown");
        state.request_workspace_shutdown();
        while state.workspace_operation_active.load(Ordering::Acquire) != 0
            || core.workspace_participant_count().expect("participants") != 0
        {
            assert!(
                Instant::now() < deadline,
                "shutdown did not drain recovery owner"
            );
            thread::sleep(Duration::from_millis(5));
        }
        release_tx.send(()).expect("release DB holder");
        lock_worker
            .join()
            .expect("DB holder joined")
            .expect("DB holder");
        let status_deadline = Instant::now() + Duration::from_secs(2);
        while recovery_hook_state(&state, &binding) != Some(GenerationRecoveryHookState::Incomplete)
        {
            assert!(
                Instant::now() < status_deadline,
                "shutdown worker did not retire hook status"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(core.workspace_participant_count().expect("participants"), 0);
        assert!(state
            .nir1_generation_recovery_bindings
            .lock()
            .expect("single-flight owners")
            .is_empty());
        assert!(storage::read_terminal(authority.db(), &attempts[0].id)
            .expect("attempt remains pending")
            .is_none());
        drop(core);
        drop(authority);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn delayed_open_worker_rejects_failed_restore_revision_and_recovery_required() {
        let (root, attempts) = recovery_workspace(1);
        let state = Arc::new(
            AppState::new(
                root.join("native-app").to_str().expect("app path"),
                root.join("resources").to_str().expect("resources path"),
            )
            .expect("native state"),
        );
        let backend = crate::Backend {
            state: Arc::clone(&state),
        };
        let (reached_tx, reached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_worker_probe
            .lock()
            .expect("recovery worker probe") = Some((reached_tx, release_rx));

        let opened = backend
            .open_workspace(root.to_string_lossy().into_owned())
            .await
            .expect("Open succeeds");
        let opened: Value = serde_json::from_str(&opened).expect("Open outcome");
        assert!(matches!(
            opened["status"].as_str(),
            Some("ready" | "migrated")
        ));
        reached_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("delayed Open worker reached pre-capture gate");
        let ready_open = state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Open Ready snapshot");
        let ready_revision = ready_open.revision;
        let binding = match ready_open.state {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected Open Ready binding, got {state:?}"),
        };
        let open_lock_released = state.ws.open_lock.try_lock().is_ok();
        let open_operations = state.workspace_operation_active.load(Ordering::Acquire);
        let open_participants = state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .expect("Open launch participants");

        let failed_restore = backend
            .restore_backup("grimodex-missing-backup.db".into())
            .await
            .expect("failed Restore remains an unchanged caller outcome");
        let failed_restore: Value =
            serde_json::from_str(&failed_restore).expect("failed Restore outcome");
        let after_failed_restore = state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Ready after failed Restore");
        let ready_binding_after_restore = match after_failed_restore.state {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected unchanged Ready binding, got {state:?}"),
        };
        assert_eq!(ready_binding_after_restore, binding);
        assert!(after_failed_restore.revision > ready_revision);
        let failed_restore_lock_released = state.ws.open_lock.try_lock().is_ok();
        let failed_restore_operations = state.workspace_operation_active.load(Ordering::Acquire);
        release_tx.send(()).expect("release delayed Open worker");

        assert!(
            open_lock_released,
            "Open lock released before worker capture"
        );
        assert_eq!(
            open_operations, 0,
            "Open guard released before worker capture"
        );
        assert_eq!(
            open_participants, 0,
            "Open worker held no participant before capture"
        );
        assert_eq!(failed_restore["status"], "unchanged");
        assert_eq!(failed_restore["operationOutcome"], "failed");
        assert!(
            failed_restore_lock_released,
            "failed Restore released its lock"
        );
        assert_eq!(
            failed_restore_operations, 0,
            "failed Restore guard released"
        );

        let deadline = Instant::now() + Duration::from_secs(2);
        while recovery_hook_state(&state, &binding) != Some(GenerationRecoveryHookState::Incomplete)
        {
            assert!(Instant::now() < deadline, "stale worker did not retire");
            thread::sleep(Duration::from_millis(5));
        }
        let active =
            active_workspace_snapshot(&state.ws).expect("unchanged workspace remains active");
        assert!(storage::read_terminal(active.db(), &attempts[0].id)
            .expect("attempt remains pending")
            .is_none());
        drop(active);
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert_eq!(
            state
                .ws
                .lifecycle_core()
                .workspace_participant_count()
                .expect("participants"),
            0
        );

        let backup_dir = root.join("backups");
        std::fs::create_dir_all(&backup_dir).expect("backup directory");
        active_workspace_snapshot(&state.ws)
            .expect("workspace before RecoveryRequired Restore")
            .db()
            .backup_to(&backup_dir.join("grimodex-recovery-required.db"))
            .expect("create Restore candidate");
        state
            .narrative_maintenance_recovery_gate
            .arm_panic_after_admission_close_for_test();
        let recovery_required = backend
            .restore_backup("grimodex-recovery-required.db".into())
            .await
            .expect("Restore returns strict RecoveryRequired outcome");
        let recovery_required: Value =
            serde_json::from_str(&recovery_required).expect("RecoveryRequired outcome");
        assert_eq!(recovery_required["status"], "recovery-required");
        let lifecycle: Value = serde_json::from_str(
            &backend
                .get_workspace_lifecycle_view()
                .await
                .expect("read RecoveryRequired lifecycle"),
        )
        .expect("lifecycle view");
        assert_eq!(lifecycle["status"], "recovery-required");
        assert_eq!(lifecycle["activation"], "requires-open");
        assert_eq!(
            recovery_hook_state(&state, &binding),
            Some(GenerationRecoveryHookState::Incomplete)
        );
        assert_eq!(
            state
                .nir1_generation_recovery_statuses
                .lock()
                .expect("recovery hook ledger")
                .latest_ready_revision,
            ready_revision,
            "RecoveryRequired Restore did not schedule a Ready hook"
        );
        assert!(state.ws.open_lock.try_lock().is_ok());
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        tokio::time::timeout(Duration::from_secs(2), state.wait_workspace_operations())
            .await
            .expect("recovery worker joined before fixture cleanup");
        let maintenance_drain =
            grimodex_db::open::drain_workspace_maintenance_for_test(&root, || {})
                .expect("DB workspace maintenance drained before fixture cleanup");
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
        drop(maintenance_drain);
    }

    #[tokio::test]
    async fn real_open_and_restore_recover_pending_attempts_after_ready() {
        let (root, attempts) = recovery_workspace(1);
        let state = Arc::new(
            AppState::new(
                root.join("native-app").to_str().expect("app path"),
                root.join("resources").to_str().expect("resources path"),
            )
            .expect("native state"),
        );
        let backend = crate::Backend {
            state: Arc::clone(&state),
        };
        let (open_reached_tx, open_reached_rx) = mpsc::channel();
        let (open_release_tx, open_release_rx) = mpsc::channel();
        let (open_launch_tx, open_launch_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_launch_probe
            .lock()
            .expect("Open launch probe") = Some(open_launch_tx);
        *state
            .nir1_generation_recovery_worker_probe
            .lock()
            .expect("Open recovery probe") = Some((open_reached_tx, open_release_rx));
        let opened = backend
            .open_workspace(root.to_string_lossy().into_owned())
            .await
            .expect("real Open returns while recovery is owned");
        let opened: Value = serde_json::from_str(&opened).expect("open outcome");
        open_reached_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Open recovery worker paused before owner capture");
        let open_lock_released_after_return = state.ws.open_lock.try_lock().is_ok();
        let open_operation_count_after_return =
            state.workspace_operation_active.load(Ordering::Acquire);
        let open_participant_count_after_return = state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .expect("Open launch participants");
        open_release_tx
            .send(())
            .expect("release Open recovery worker");
        assert!(
            open_lock_released_after_return,
            "Open lock released after response, before worker capture"
        );
        assert_eq!(
            open_operation_count_after_return, 0,
            "Open operation guard released after response"
        );
        assert_eq!(
            open_participant_count_after_return, 0,
            "worker captured no participant after response yet"
        );
        assert!(matches!(
            opened["status"].as_str(),
            Some("ready" | "migrated")
        ));
        let open_revision = opened["lifecycle"]["revision"]
            .as_u64()
            .expect("Open lifecycle revision");
        let ready_binding = match state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Open Ready binding")
            .state
        {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected Open Ready binding, got {state:?}"),
        };
        let open_launch = open_launch_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Open launch observation before detached spawn");
        assert_eq!(open_launch.ready_revision, open_revision);
        assert_eq!(open_launch.binding, ready_binding);
        assert!(
            open_launch.open_lock_available,
            "Open hook launched under open_lock"
        );
        assert_eq!(
            open_launch.active_operation_count, 0,
            "Open hook launched before guard release"
        );
        assert_eq!(
            open_launch.participant_count, 0,
            "Open hook captured a participant before worker start"
        );
        let db = active_workspace_snapshot(&state.ws).expect("Ready workspace");
        let deadline = Instant::now() + Duration::from_secs(3);
        while storage::read_terminal(db.db(), &attempts[0].id)
            .expect("Open recovery terminal")
            .is_none()
            || recovery_hook_state(&state, &ready_binding)
                != Some(GenerationRecoveryHookState::Complete)
        {
            assert!(Instant::now() < deadline, "Open recovery did not complete");
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            state.ws.open_lock.try_lock().is_ok(),
            "Open released its lock"
        );
        drop(db);

        let db = active_workspace_snapshot(&state.ws).expect("Ready workspace");
        let pending = storage::create_attempt(db.db(), recovery_attempt(db.db(), 1))
            .expect("new pending attempt before duplicate hook");
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            open_revision,
        ));
        assert!(storage::read_terminal(db.db(), &pending.id)
            .expect("duplicate-hook pending read")
            .is_none());
        drop(db);
        let failed_restore = backend
            .restore_backup("grimodex-missing-backup.db".into())
            .await
            .expect("failed Restore remains a strict caller outcome");
        let failed_restore: Value =
            serde_json::from_str(&failed_restore).expect("failed Restore outcome");
        assert_eq!(failed_restore["status"], "unchanged");
        assert_eq!(failed_restore["operationOutcome"], "failed");
        assert!(
            state.ws.open_lock.try_lock().is_ok(),
            "failed Restore released its lock"
        );
        let failed_open_path = root.join("not-a-workspace-directory");
        std::fs::write(&failed_open_path, "not a directory").expect("failed Open fixture");
        let failed_open = backend
            .open_workspace(failed_open_path.to_string_lossy().into_owned())
            .await;
        assert!(failed_open.is_err(), "failed Open remains a caller error");
        assert_eq!(
            usize::from(
                state
                    .nir1_generation_recovery_statuses
                    .lock()
                    .expect("recovery hook state")
                    .entry
                    .is_some(),
            ),
            1,
            "failed Open and Restore must not enqueue another hook"
        );
        let db = active_workspace_snapshot(&state.ws).expect("Ready workspace after failures");
        db.db()
            .with_conn(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER fail_generation_recovery
                     BEFORE UPDATE OF terminal_json ON nir1_generation_attempts
                     BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;",
                )?;
                Ok(())
            })
            .expect("install Restore recovery failpoint");
        let backups = root.join("backups");
        std::fs::create_dir_all(&backups).expect("backups");
        db.db()
            .backup_to(&backups.join("grimodex-recovery.db"))
            .expect("backup");
        db.db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects(id,title) VALUES ('active-only-project','Active only')",
                    [],
                )?;
                Ok(())
            })
            .expect("change active database after backup");
        drop(db);
        let (restore_reached_tx, restore_reached_rx) = mpsc::channel();
        let (restore_release_tx, restore_release_rx) = mpsc::channel();
        let (restore_launch_tx, restore_launch_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_launch_probe
            .lock()
            .expect("Restore launch probe") = Some(restore_launch_tx);
        *state
            .nir1_generation_recovery_worker_probe
            .lock()
            .expect("Restore recovery probe") = Some((restore_reached_tx, restore_release_rx));
        let restored = backend
            .restore_backup("grimodex-recovery.db".into())
            .await
            .expect("real Restore returns while recovery is owned");
        let restored: Value = serde_json::from_str(&restored).expect("restore outcome");
        restore_reached_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Restore recovery worker paused before owner capture");
        let restore_lock_released_after_return = state.ws.open_lock.try_lock().is_ok();
        let restore_operation_count_after_return =
            state.workspace_operation_active.load(Ordering::Acquire);
        let restore_participant_count_after_return = state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .expect("Restore launch participants");
        restore_release_tx
            .send(())
            .expect("release Restore recovery worker");
        assert!(
            restore_lock_released_after_return,
            "Restore lock released after response, before worker capture"
        );
        assert_eq!(
            restore_operation_count_after_return, 0,
            "Restore operation guard released after response"
        );
        assert_eq!(
            restore_participant_count_after_return, 0,
            "worker captured no participant after response yet"
        );
        assert_eq!(restored["status"], "restored");
        assert_eq!(restored["activation"], "ready");
        let restored_revision = restored["lifecycle"]["revision"]
            .as_u64()
            .expect("Restore lifecycle revision");
        let restored_binding = match state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Restore Ready binding")
            .state
        {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected Restore Ready binding, got {state:?}"),
        };
        let restore_launch = restore_launch_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Restore launch observation before detached spawn");
        assert_eq!(restore_launch.ready_revision, restored_revision);
        assert_eq!(restore_launch.binding, restored_binding);
        assert!(
            restore_launch.open_lock_available,
            "Restore hook launched under open_lock"
        );
        assert_eq!(
            restore_launch.active_operation_count, 0,
            "Restore hook launched before guard release"
        );
        assert_eq!(
            restore_launch.participant_count, 0,
            "Restore hook captured a participant before worker start"
        );
        let db = active_workspace_snapshot(&state.ws).expect("restored Ready workspace");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if recovery_hook_state(&state, &restored_binding)
                == Some(GenerationRecoveryHookState::Incomplete)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Restore recovery did not fail boundedly"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert!(storage::read_terminal(db.db(), &pending.id)
            .expect("Restore pending attempt")
            .is_none());
        assert!(
            state.ws.open_lock.try_lock().is_ok(),
            "Restore released its lock"
        );
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert_eq!(
            state
                .ws
                .lifecycle_core()
                .snapshot()
                .expect("Restore Ready revision")
                .revision,
            restored_revision
        );
        drop(db);
        // Close the workspace before deleting it: the real Open scheduled DB
        // workspace maintenance (log pruning, auto-backup) that may still write
        // into the root. Shutdown joins those workers first.
        let closed: Value = serde_json::from_str(
            &backend
                .shutdown_workspace_lifecycle()
                .await
                .expect("shutdown workspace lifecycle"),
        )
        .expect("shutdown view JSON");
        assert_eq!(closed["status"], "closed");
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovery_join_slot_survives_restore_reentry_and_shutdown_with_zero_counters() {
        let (root, attempts) = recovery_workspace(1);
        let state = Arc::new(
            AppState::new(
                root.join("native-app").to_str().expect("app path"),
                root.join("resources").to_str().expect("resources path"),
            )
            .expect("native state"),
        );
        let backend = crate::Backend {
            state: Arc::clone(&state),
        };
        let (capture_tx, capture_rx) = mpsc::channel();
        let (capture_release_tx, capture_release_rx) = mpsc::channel();
        let (tail_tx, tail_rx) = mpsc::channel();
        let (tail_release_tx, tail_release_rx) = mpsc::channel();
        *state.nir1_generation_recovery_worker_probe.lock().expect("capture probe") =
            Some((capture_tx, capture_release_rx));
        *state.nir1_generation_recovery_completion_probe.lock().expect("tail probe") =
            Some((tail_tx, tail_release_rx));
        // Real Open supplies the main-DB identity required for unchanged Restore.
        let opened = backend.open_workspace(root.to_string_lossy().into_owned())
            .await.expect("real Open succeeds");
        let opened: Value = serde_json::from_str(&opened).expect("Open JSON");
        assert!(matches!(opened["status"].as_str(), Some("ready" | "migrated")));
        capture_rx.recv_timeout(Duration::from_secs(2)).expect("pre-capture worker");
        assert!(state.nir1_generation_recovery_statuses.lock().expect("ledger").worker_active);
        let ready = state.ws.lifecycle_core().snapshot().expect("Ready");
        let binding = match ready.state {
            LifecycleState::Ready(binding) => binding,
            state => panic!("expected Ready, got {state:?}"),
        };

        let restored = backend.restore_backup("grimodex-missing-backup.db".into())
            .await.expect("strict failed Restore outcome");
        let restored: Value = serde_json::from_str(&restored).expect("Restore JSON");
        assert_eq!(restored["status"], "unchanged");
        let later = state.ws.lifecycle_core().snapshot().expect("later Ready");
        assert!(later.revision > ready.revision);
        assert!(!start_generation_recovery_after_ready(Arc::clone(&state), later.revision));
        capture_release_tx.send(()).expect("release stale capture");
        tail_rx.recv_timeout(Duration::from_secs(2)).expect("status retired before task return");
        assert_eq!(recovery_hook_state(&state, &binding), Some(GenerationRecoveryHookState::Incomplete));
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert_eq!(state.ws.lifecycle_core().workspace_participant_count().expect("participants"), 0);
        assert!(!start_generation_recovery_after_ready(Arc::clone(&state), later.revision));
        assert!(state.nir1_generation_recovery_statuses.lock().expect("ledger").worker_active);

        let shutdown_state = Arc::clone(&state);
        let shutdown = tokio::spawn(async move {
            crate::Backend { state: shutdown_state }.shutdown_workspace_lifecycle().await
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !state.workspace_shutdown_requested.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "shutdown admission closed");
            tokio::task::yield_now().await;
        }
        // Poll the actual drain while the blocking worker is still at its tail.
        assert!(tokio::time::timeout(Duration::from_millis(20), state.wait_workspace_operations())
            .await.is_err(), "zero counters/status must not prove the worker joined");
        assert!(!shutdown.is_finished());
        tail_release_tx.send(()).expect("allow actual blocking task return");
        let closed = tokio::time::timeout(Duration::from_secs(2), shutdown)
            .await.expect("bounded shutdown observation").expect("shutdown task")
            .expect("shutdown outcome");
        let closed: Value = serde_json::from_str(&closed).expect("Closed JSON");
        assert_eq!(closed["status"], "closed");
        assert!(!state.nir1_generation_recovery_statuses.lock().expect("ledger").worker_active);
        assert!(!start_generation_recovery_after_ready(Arc::clone(&state), later.revision));
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("fixture DB");
        assert!(storage::read_terminal(&db, &attempts[0].id).expect("no stale recovery").is_none());
        drop(db);
        std::fs::remove_dir_all(root).expect("cleanup while shutdown path fence is retained");
        drop(backend);
        drop(state);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovery_join_coalesces_latest_real_open_only_after_old_worker_completion() {
        let (root_a, attempts_a) = recovery_workspace(1);
        let (root_b, attempts_b) = recovery_workspace(1);
        let state = reopened_recovery_state(&root_a);
        let backend = crate::Backend { state: Arc::clone(&state) };
        let ready_a = state.ws.lifecycle_core().snapshot().expect("A Ready");
        let (capture_tx, capture_rx) = mpsc::channel();
        let (capture_release_tx, capture_release_rx) = mpsc::channel();
        let (tail_tx, tail_rx) = mpsc::channel();
        let (tail_release_tx, tail_release_rx) = mpsc::channel();
        *state.nir1_generation_recovery_worker_probe.lock().expect("A capture probe") =
            Some((capture_tx, capture_release_rx));
        *state.nir1_generation_recovery_completion_probe.lock().expect("A tail probe") =
            Some((tail_tx, tail_release_rx));
        assert!(start_generation_recovery_after_ready(Arc::clone(&state), ready_a.revision));
        capture_rx.recv_timeout(Duration::from_secs(2)).expect("A worker before capture");
        let (launch_tx, launch_rx) = mpsc::channel();
        *state.nir1_generation_recovery_launch_probe.lock().expect("B launch probe") = Some(launch_tx);
        let opened = backend.open_workspace(root_b.to_string_lossy().into_owned())
            .await.expect("real B Open does not await A task");
        let opened: Value = serde_json::from_str(&opened).expect("B Open JSON");
        assert!(matches!(opened["status"].as_str(), Some("ready" | "migrated")));
        let ready_b = state.ws.lifecycle_core().snapshot().expect("B Ready");
        assert!(ready_b.revision > ready_a.revision);
        assert!(launch_rx.try_recv().is_err(), "B cannot replace the live A worker");
        capture_release_tx.send(()).expect("release stale A capture");
        tail_rx.recv_timeout(Duration::from_secs(2)).expect("A before actual task completion");
        assert!(!start_generation_recovery_after_ready(Arc::clone(&state), ready_b.revision));
        let (b_capture_tx, b_capture_rx) = mpsc::channel();
        let (b_release_tx, b_release_rx) = mpsc::channel();
        *state.nir1_generation_recovery_worker_probe.lock().expect("B capture probe") =
            Some((b_capture_tx, b_release_rx));
        tail_release_tx.send(()).expect("allow A actual join");
        let launch = launch_rx.recv_timeout(Duration::from_secs(2)).expect("coalesced B launch");
        assert_eq!(launch.ready_revision, ready_b.revision);
        assert!(matches!(ready_b.state, LifecycleState::Ready(ref binding) if binding == &launch.binding));
        b_capture_rx.recv_timeout(Duration::from_secs(2)).expect("B actual worker");
        assert!(!start_generation_recovery_after_ready(Arc::clone(&state), ready_b.revision));
        b_release_tx.send(()).expect("release B capture");
        tokio::time::timeout(Duration::from_secs(2), state.wait_workspace_operations())
            .await.expect("B blocking task joined, not just status/zero counters");
        let db_b = active_workspace_snapshot(&state.ws).expect("B workspace");
        assert!(storage::read_terminal(db_b.db(), &attempts_b[0].id).expect("B recovered").is_some());
        assert_eq!(recovery_hook_state(&state, &launch.binding), Some(GenerationRecoveryHookState::Complete));
        let db_a = grimodex_db::Database::new(&root_a.join("grimodex.db")).expect("A DB");
        assert!(storage::read_terminal(&db_a, &attempts_a[0].id).expect("no stale A recovery").is_none());
        drop(db_b);
        drop(db_a);
        // Close the workspace before deleting it: the real Open scheduled DB
        // workspace maintenance (log pruning, auto-backup) that may still write
        // into the root. Shutdown joins those workers first.
        let closed: Value = serde_json::from_str(
            &backend
                .shutdown_workspace_lifecycle()
                .await
                .expect("shutdown workspace lifecycle"),
        )
        .expect("shutdown view JSON");
        assert_eq!(closed["status"], "closed");
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root_a).expect("A cleanup");
        std::fs::remove_dir_all(root_b).expect("B cleanup");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovery_join_failure_keeps_pending_ready_and_shutdown_fenced() {
        let (root_a, attempts_a) = recovery_workspace(1);
        let (root_b, attempts_b) = recovery_workspace(1);
        let state = reopened_recovery_state(&root_a);
        let backend = crate::Backend {
            state: Arc::clone(&state),
        };
        let ready_a = state.ws.lifecycle_core().snapshot().expect("A Ready");
        let binding_a = ready_a.binding().expect("A binding").clone();
        let revision_a = ready_a.revision;
        {
            // Scope the std guard so no await point can observe it held.
            let mut ledger = schedule_generation_recovery(&state, &binding_a, revision_a)
                .expect("reserve the same production slot");
            ledger.worker_active = true;
        }
        let (tail_tx, tail_rx) = mpsc::channel();
        let (tail_release_tx, tail_release_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_completion_probe
            .lock()
            .expect("tail probe") = Some((tail_tx, tail_release_rx));
        let worker_state = Arc::clone(&state);
        let worker_binding = binding_a.clone();
        let worker = spawn_generation_recovery(move || {
            let proof = run_generation_recovery_after_ready(
                Arc::clone(&worker_state),
                worker_binding,
                revision_a,
            );
            observe_generation_recovery_completion_probe(&worker_state);
            proof
        });
        tail_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("recovery completed before task return");
        assert_eq!(
            recovery_hook_state(&state, &binding_a),
            Some(GenerationRecoveryHookState::Complete)
        );
        let db_a = active_workspace_snapshot(&state.ws).expect("A workspace");
        assert!(storage::read_terminal(db_a.db(), &attempts_a[0].id)
            .expect("A recovered")
            .is_some());
        drop(db_a);

        let (launch_tx, launch_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_launch_probe
            .lock()
            .expect("B launch probe") = Some(launch_tx);
        let opened = backend
            .open_workspace(root_b.to_string_lossy().into_owned())
            .await
            .expect("real B Open");
        let opened: Value = serde_json::from_str(&opened).expect("B Open JSON");
        assert!(matches!(opened["status"].as_str(), Some("ready" | "migrated")));
        let ready_b = state.ws.lifecycle_core().snapshot().expect("B Ready");
        assert!(ready_b.revision > revision_a);
        assert!(launch_rx.try_recv().is_err(), "B is deferred while A is held");

        // Disconnect the existing tail rendezvous: the actual blocking worker
        // panics AFTER recovery status/operation/participant cleanup.
        drop(tail_release_tx);
        tokio::time::timeout(
            Duration::from_secs(2),
            supervise_generation_recovery(Arc::clone(&state), binding_a.clone(), revision_a, worker),
        )
        .await
        .expect("actual failed Join supervisor completed");
        {
            let ledger = state
                .nir1_generation_recovery_statuses
                .lock()
                .expect("sticky ledger");
            assert!(ledger.worker_active, "failed Join must retain the slot");
            assert_eq!(ledger.pending_ready_revision, Some(ready_b.revision));
        }
        assert_eq!(
            recovery_hook_state(&state, &binding_a),
            Some(GenerationRecoveryHookState::Incomplete)
        );
        assert_eq!(state.workspace_operation_active.load(Ordering::Acquire), 0);
        assert_eq!(
            state.ws.lifecycle_core().workspace_participant_count().expect("participants"),
            0
        );
        assert!(!start_generation_recovery_after_ready(Arc::clone(&state), ready_b.revision));
        assert!(launch_rx.try_recv().is_err(), "failed Join cannot launch pending B");
        let db_b = active_workspace_snapshot(&state.ws).expect("B workspace");
        assert!(storage::read_terminal(db_b.db(), &attempts_b[0].id)
            .expect("B stays pending")
            .is_none());
        drop(db_b);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), state.wait_workspace_operations())
                .await
                .is_err(),
            "zero counters cannot retire failed Join"
        );
        for _ in 0..2 {
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(20),
                    backend.shutdown_workspace_lifecycle(),
                )
                .await
                .is_err(),
                "shutdown response/reentry must not publish Closed"
            );
        }
        let view: Value = serde_json::from_str(
            &backend.get_workspace_lifecycle_view().await.expect("lifecycle view"),
        )
        .expect("view JSON");
        assert_ne!(view["status"], "closed");
        assert!(state.nir1_generation_recovery_statuses.lock().expect("retained slot").worker_active);

        // Test teardown only: cancel and join the retained idle shutdown drain,
        // never clear the failed recovery slot or claim successful shutdown.
        let owner = state.workspace_shutdown.get().expect("same shutdown owner");
        let mut shutdown = owner.lock().await;
        let crate::state::WorkspaceShutdownTask::Pending(worker) = &mut *shutdown else {
            panic!("failed recovery Join must leave shutdown pending");
        };
        worker.abort();
        assert!(tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .expect("test drain task terminated")
            .expect_err("test-only cancellation")
            .is_cancelled());
        drop(shutdown);
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root_a).expect("A strict cleanup");
        std::fs::remove_dir_all(root_b).expect("B strict cleanup");
    }

    #[tokio::test]
    async fn detached_recovery_call_returns_before_worker_finishes() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = spawn_generation_recovery(move || {
            started_tx.send(()).expect("worker started");
            release_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("worker release");
            finished_tx.send(()).expect("worker finished");
        });
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("detached worker entered");
        assert!(finished_rx.try_recv().is_err());
        release_tx.send(()).expect("release detached worker");
        finished_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("detached worker completed");
        worker.await.expect("actual blocking worker join");
    }

    fn startup_gate(state: &AppState) -> &crate::nir1_startup_barrier::Nir1StartupAdmissionGate {
        state.workspace_lifecycle.nir1_startup_gate()
    }

    fn current_ready(state: &AppState) -> (LiveBinding, u64) {
        let snapshot = state.ws.lifecycle_core().snapshot().expect("lifecycle");
        let binding = snapshot.binding().expect("Ready binding").clone();
        (binding, snapshot.revision)
    }

    /// Open the gate for the current Ready entry without a sweep, so the
    /// publisher tests start from an Open gate with a live lease.
    fn open_startup_gate_for_current_ready(state: &AppState) -> (LiveBinding, u64) {
        let (binding, revision) = current_ready(state);
        let recovery = startup_gate(state)
            .begin_recovery(&binding, revision, Duration::ZERO)
            .expect("exact Ready entry recovery");
        let proof = recovery.record_complete_sweep().expect("sweep proof");
        assert!(startup_gate(state).open_after_joined_sweep(proof));
        (binding, revision)
    }

    fn admitted_ticket(outcome: grimodex_db::AdmissionOutcome) -> grimodex_db::AdmissionTicket {
        match outcome {
            grimodex_db::AdmissionOutcome::Admitted(ticket) => ticket,
            grimodex_db::AdmissionOutcome::NotAdmitted { reason, .. } => {
                panic!("transition not admitted: {reason:?}")
            }
        }
    }

    /// Publish a new Ready entry through the real Native adapter publisher.
    fn publish_new_ready_entry(state: &AppState, kind: AdmissionKind) -> (LiveBinding, u64) {
        admitted_ticket(
            state
                .workspace_lifecycle
                .try_begin_transition_kind(kind)
                .expect("transition admission"),
        );
        let view = state
            .workspace_lifecycle
            .complete_transition_from_workspace(&state.ws)
            .expect("Ready publication");
        assert_eq!(
            view.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
        );
        current_ready(state)
    }

    async fn wait_startup_gate_open(state: &AppState, binding: &LiveBinding, revision: u64) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !startup_gate(state).is_open_for(binding, revision) {
            assert!(
                Instant::now() < deadline,
                "startup gate did not open for the exact Ready entry"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn wait_recovery_joined(state: &AppState) {
        tokio::time::timeout(Duration::from_secs(10), state.wait_workspace_operations())
            .await
            .expect("recovery task joined");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn startup_gate_opens_after_exact_ready_sweep_for_empty_and_multi_page_workspaces() {
        let (empty_root, _) = recovery_workspace(0);
        let (many_root, many_attempts, project_ids) =
            recovery_workspace_many(MAX_RECOVERY_PAGE_SIZE + 6, MAX_RECOVERY_PAGE_SIZE + 6);
        assert!(project_ids.len() > MAX_RECOVERY_PAGE_SIZE);
        assert!(many_attempts.len() > MAX_RECOVERY_PAGE_SIZE);
        for (root, attempts) in [(empty_root, Vec::new()), (many_root, many_attempts)] {
            let state = reopened_recovery_state(&root);
            let (binding, revision) = current_ready(&state);
            assert!(startup_gate(&state).try_lease(&binding, revision).is_none());
            assert!(start_generation_recovery_after_ready(
                Arc::clone(&state),
                revision
            ));
            wait_recovery_joined(&state).await;
            assert_eq!(
                recovery_hook_state(&state, &binding),
                Some(GenerationRecoveryHookState::Complete)
            );
            assert!(startup_gate(&state).is_open_for(&binding, revision));
            let lease = startup_gate(&state)
                .try_lease(&binding, revision)
                .expect("exact Open entry lease");
            assert!(lease.is_current());
            let db = active_workspace_snapshot(&state.ws).expect("Ready workspace");
            for attempt in &attempts {
                assert!(storage::read_terminal(db.db(), &attempt.id)
                    .expect("terminal read")
                    .is_some());
            }
            drop(db);
            drop(lease);
            drop(state);
            std::fs::remove_dir_all(root).expect("cleanup");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn incomplete_sweep_keeps_startup_gate_closed_until_a_new_ready_entry_sweeps() {
        let (root, attempts) = recovery_workspace(1);
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("fixture DB");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_generation_recovery
                 BEFORE UPDATE OF terminal_json ON nir1_generation_attempts
                 BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;",
            )?;
            Ok(())
        })
        .expect("install recovery failpoint");
        drop(db);
        let state = reopened_recovery_state(&root);
        let (binding, revision) = current_ready(&state);
        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            revision
        ));
        wait_recovery_joined(&state).await;
        assert_eq!(
            recovery_hook_state(&state, &binding),
            Some(GenerationRecoveryHookState::Incomplete)
        );
        assert!(startup_gate(&state).is_closed());
        assert!(startup_gate(&state).try_lease(&binding, revision).is_none());
        assert!(
            startup_gate(&state)
                .begin_recovery(&binding, revision, Duration::ZERO)
                .is_none(),
            "the incomplete Ready entry is consumed"
        );
        assert!(startup_gate(&state).try_lease_for_binding(&binding).is_none());

        active_workspace_snapshot(&state.ws)
            .expect("Ready workspace")
            .db()
            .with_conn(|conn| {
                conn.execute_batch("DROP TRIGGER fail_generation_recovery")?;
                Ok(())
            })
            .expect("remove recovery failpoint");
        let (retry_binding, retry_revision) = publish_new_ready_entry(&state, AdmissionKind::Open);
        assert!(retry_revision > revision);
        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            retry_revision
        ));
        wait_recovery_joined(&state).await;
        assert!(startup_gate(&state).is_open_for(&retry_binding, retry_revision));
        assert!(startup_gate(&state).try_lease(&binding, revision).is_none());
        let db = active_workspace_snapshot(&state.ws).expect("retried workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal read")
            .is_some());
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_recovery_owner_cannot_open_and_pending_ready_entry_opens_after_join() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let (binding_a, revision_a) = current_ready(&state);
        let (reached_tx, reached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_worker_probe
            .lock()
            .expect("worker probe") = Some((reached_tx, release_rx));
        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            revision_a
        ));
        reached_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("A worker paused before capture");

        let (binding_b, revision_b) = publish_new_ready_entry(&state, AdmissionKind::Restore);
        assert!(revision_b > revision_a);
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            revision_b
        ));
        assert_eq!(
            state
                .nir1_generation_recovery_statuses
                .lock()
                .expect("ledger")
                .pending_ready_revision,
            Some(revision_b)
        );
        assert!(startup_gate(&state).is_closed());
        release_tx.send(()).expect("release stale A worker");

        wait_startup_gate_open(&state, &binding_b, revision_b).await;
        wait_recovery_joined(&state).await;
        assert!(!startup_gate(&state).is_open_for(&binding_a, revision_a));
        assert!(startup_gate(&state)
            .try_lease(&binding_a, revision_a)
            .is_none());
        assert!(
            startup_gate(&state)
                .begin_recovery(&binding_a, revision_a, Duration::ZERO)
                .is_none(),
            "a stale entry can no longer be swept or opened"
        );
        assert!(startup_gate(&state).is_open_for(&binding_b, revision_b));
        let db = active_workspace_snapshot(&state.ws).expect("B workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal read")
            .is_some());
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn every_native_ready_publisher_closes_the_startup_gate() {
        let (root, _) = recovery_workspace(0);
        let state = reopened_recovery_state(&root);
        let gate = startup_gate(&state);
        let adapter = &state.workspace_lifecycle;
        let core = state.ws.lifecycle_core();

        // Open and Restore: admission closes, and the Ready publication is a
        // new exact entry that is still Closed until its own sweep.
        for kind in [AdmissionKind::Open, AdmissionKind::Restore] {
            let (binding, revision) = open_startup_gate_for_current_ready(&state);
            let lease = gate.try_lease(&binding, revision).expect("Open lease");
            admitted_ticket(adapter.try_begin_transition_kind(kind).expect("admission"));
            assert!(gate.is_closed(), "{kind:?} admission closes the gate");
            assert!(!lease.is_current());
            drop(lease);
            adapter
                .complete_transition_from_workspace(&state.ws)
                .expect("Ready publication");
            let (next_binding, next_revision) = current_ready(&state);
            assert!(next_revision > revision);
            assert!(gate.is_closed(), "{kind:?} Ready publication keeps it Closed");
            assert!(
                gate.awaits_recovery_for(&next_binding, next_revision),
                "{kind:?} Ready publication is a new exact entry"
            );
            assert!(gate.try_lease(&next_binding, next_revision).is_none());
            assert!(gate.try_lease(&binding, revision).is_none());
        }

        // Native Open target admission (begin_open_transition_for_target).
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        admitted_ticket(
            adapter
                .try_begin_open_transition_for_target(
                    binding.locator.as_ref(),
                    Some(binding.workspace_id.as_ref()),
                    None,
                    None,
                )
                .expect("Open target admission"),
        );
        assert!(gate.is_closed());
        adapter
            .complete_transition_from_workspace(&state.ws)
            .expect("Open target Ready");
        assert!(gate.try_lease(&binding, revision).is_none());
        let (target_binding, target_revision) = current_ready(&state);
        assert!(gate.awaits_recovery_for(&target_binding, target_revision));

        // Safe Mode: withdrawing Ready closes, and the Safe Mode Recover
        // admission and Ready publication close again.
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        core.mark_safe_mode_recovery_required()
            .expect("Safe Mode RecoveryRequired");
        assert!(gate.is_closed());
        assert!(gate.try_lease(&binding, revision).is_none());
        admitted_ticket(
            adapter
                .try_begin_recovery_transition(grimodex_db::RecoveryDescriptorId::new(0))
                .expect("Safe Mode Recover admission"),
        );
        adapter
            .complete_transition_from_workspace(&state.ws)
            .expect("Safe Mode Ready");
        let (safe_binding, safe_revision) = current_ready(&state);
        assert!(gate.is_closed());
        assert!(gate.try_lease(&safe_binding, safe_revision).is_none());
        assert!(gate.awaits_recovery_for(&safe_binding, safe_revision));

        // Maintenance Recover: the recovery transfer withdraws Ready, the
        // descriptor-bound Recover admission closes, and its Ready is a new
        // entry.
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
            grimodex_db::PermitAdmission::Admitted(permit) => permit,
            grimodex_db::PermitAdmission::NotAdmitted { reason, .. } => {
                panic!("maintenance not admitted: {reason:?}")
            }
        };
        permit.start().expect("start maintenance");
        permit.mark_joined().expect("join maintenance");
        let descriptor = permit.transfer_to_recovery().expect("recovery transfer");
        assert!(gate.is_closed(), "recovery transfer closes the gate");
        assert!(gate.try_lease(&binding, revision).is_none());
        admitted_ticket(
            adapter
                .try_begin_recovery_transition_for_workspace(descriptor, &state.ws)
                .expect("maintenance Recover admission"),
        );
        assert!(gate.is_closed());
        let recovered = adapter
            .complete_transition_from_workspace(&state.ws)
            .expect("maintenance Recover Ready");
        assert_eq!(
            recovered.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
        );
        let (recovered_binding, recovered_revision) = current_ready(&state);
        assert!(gate.is_closed());
        assert!(gate
            .try_lease(&recovered_binding, recovered_revision)
            .is_none());
        assert!(gate.awaits_recovery_for(&recovered_binding, recovered_revision));

        // resolve_joined_transition with shutdown: no Ready, permanently Closed.
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        admitted_ticket(
            adapter
                .try_begin_transition_kind(AdmissionKind::Open)
                .expect("Open admission"),
        );
        adapter.request_shutdown().expect("shutdown request");
        let view = adapter
            .complete_transition_from_workspace(&state.ws)
            .expect("joined shutdown");
        assert_eq!(
            view.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Transition
        );
        assert!(gate.is_closed());
        assert!(gate.try_lease(&binding, revision).is_none());
        assert!(gate
            .begin_recovery(&binding, revision, Duration::ZERO)
            .is_none());
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn startup_lease_drain_timeout_publishes_recovery_required_and_keeps_gate_closed() {
        let (root, _) = recovery_workspace(0);
        let state = reopened_recovery_state(&root);
        let gate = startup_gate(&state);
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        let lease = gate.try_lease(&binding, revision).expect("prior lease");
        admitted_ticket(
            state
                .workspace_lifecycle
                .try_begin_transition_kind(AdmissionKind::Open)
                .expect("Open admission"),
        );
        let started = Instant::now();
        let view = state
            .workspace_lifecycle
            .complete_transition_from_workspace(&state.ws)
            .expect("drain-timeout publication");
        let elapsed = started.elapsed();
        assert!(elapsed >= crate::nir1_startup_barrier::NIR1_STARTUP_LEASE_DRAIN_LIMIT);
        assert!(elapsed < Duration::from_secs(2), "drain is bounded");
        assert_eq!(
            view.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::RecoveryRequired
        );
        assert!(matches!(
            state.ws.lifecycle_core().snapshot().expect("lifecycle").state,
            LifecycleState::RecoveryRequired { .. }
        ));
        assert_eq!(
            state.workspace_lifecycle.take_last_terminal_kind().expect("terminal"),
            Some(crate::workspace_lifecycle_view::LifecycleTerminalKind::RecoveryRequired)
        );
        assert!(gate.is_closed());
        assert_eq!(gate.active_lease_count(), 1, "timeout is not retirement");
        assert!(!lease.is_current());
        drop(lease);
        assert_eq!(gate.active_lease_count(), 0);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn startup_lease_drain_publishes_ready_only_after_the_actual_lease_drop() {
        let (root, _) = recovery_workspace(0);
        let state = reopened_recovery_state(&root);
        let gate = startup_gate(&state);
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        let lease = gate.try_lease(&binding, revision).expect("prior lease");
        admitted_ticket(
            state
                .workspace_lifecycle
                .try_begin_transition_kind(AdmissionKind::Restore)
                .expect("Restore admission"),
        );
        let (dropped_tx, dropped_rx) = mpsc::channel();
        let owner = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            drop(lease);
            dropped_tx.send(Instant::now()).expect("lease dropped");
        });
        let view = state
            .workspace_lifecycle
            .complete_transition_from_workspace(&state.ws)
            .expect("Ready after drain");
        let published_at = Instant::now();
        let dropped_at = dropped_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("lease owner dropped");
        owner.join().expect("lease owner joined");
        assert!(dropped_at <= published_at);
        assert_eq!(
            view.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
        );
        assert_eq!(gate.active_lease_count(), 0);
        let (ready_binding, ready_revision) = current_ready(&state);
        assert!(ready_revision > revision);
        assert!(gate.is_closed());
        assert!(gate
            .begin_recovery(&ready_binding, ready_revision, Duration::ZERO)
            .is_some());
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn transient_maintenance_release_keeps_the_startup_gate_open() {
        let (root, _) = recovery_workspace(0);
        let state = reopened_recovery_state(&root);
        let gate = startup_gate(&state);
        let (binding, revision) = open_startup_gate_for_current_ready(&state);
        let lease = gate.try_lease(&binding, revision).expect("Open lease");
        // #628: a transient automatic maintenance failure releases normally;
        // it is not a lifecycle edge and does not close the gate.
        let mut permit = match state
            .ws
            .lifecycle_core()
            .admit_maintenance_permit()
            .expect("maintenance")
        {
            grimodex_db::PermitAdmission::Admitted(permit) => permit,
            grimodex_db::PermitAdmission::NotAdmitted { reason, .. } => {
                panic!("maintenance not admitted: {reason:?}")
            }
        };
        permit.start().expect("start");
        permit.mark_joined().expect("join");
        permit.release().expect("transient release");
        assert!(lease.is_current());
        assert!(gate.is_open_for(&binding, revision));
        drop(lease);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_open_restore_and_shutdown_drive_the_startup_gate() {
        let (root, attempts) = recovery_workspace(1);
        let state = Arc::new(
            AppState::new(
                root.join("native-app").to_str().expect("app path"),
                root.join("resources").to_str().expect("resources path"),
            )
            .expect("native state"),
        );
        let backend = crate::Backend {
            state: Arc::clone(&state),
        };
        assert!(startup_gate(&state).is_closed(), "restart starts Closed");
        backend
            .open_workspace(root.to_string_lossy().into_owned())
            .await
            .expect("real Open");
        let (open_binding, open_revision) = current_ready(&state);
        wait_startup_gate_open(&state, &open_binding, open_revision).await;
        wait_recovery_joined(&state).await;
        let lease = startup_gate(&state)
            .try_lease(&open_binding, open_revision)
            .expect("Open lease");
        let db = active_workspace_snapshot(&state.ws).expect("Ready workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal read")
            .is_some());
        let backups = root.join("backups");
        std::fs::create_dir_all(&backups).expect("backups");
        db.db()
            .backup_to(&backups.join("grimodex-gate.db"))
            .expect("backup");
        drop(db);
        drop(lease);

        let restored = backend
            .restore_backup("grimodex-gate.db".into())
            .await
            .expect("real Restore");
        let restored: Value = serde_json::from_str(&restored).expect("Restore outcome");
        assert_eq!(restored["status"], "restored");
        assert!(startup_gate(&state)
            .try_lease(&open_binding, open_revision)
            .is_none());
        let (restored_binding, restored_revision) = current_ready(&state);
        assert!(restored_revision > open_revision);
        wait_startup_gate_open(&state, &restored_binding, restored_revision).await;
        wait_recovery_joined(&state).await;

        let closed = backend
            .shutdown_workspace_lifecycle()
            .await
            .expect("real shutdown");
        let closed: Value = serde_json::from_str(&closed).expect("Closed view");
        assert_eq!(closed["status"], "closed");
        assert!(startup_gate(&state).is_closed());
        assert!(startup_gate(&state)
            .try_lease(&restored_binding, restored_revision)
            .is_none());
        assert!(startup_gate(&state)
            .begin_recovery(&restored_binding, restored_revision, Duration::ZERO)
            .is_none());
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    /// Hold a C-query style quarantine of the exact Ready workspace (a
    /// revision-only Core change) until the returned value drops.
    fn quarantine_ready_workspace(state: &AppState) -> storage::Nir1WorkspaceQuarantineForTest {
        storage::quarantine_workspace_for_test(
            active_workspace_snapshot(&state.ws).expect("Ready workspace"),
        )
        .expect("quarantine of the identity-bearing Ready binding")
    }

    /// R1 + R3 (P3(b)): revision-only Core changes (quarantine set/release and
    /// a background descriptor completion) while the sweep is paused neither
    /// make the sweep Incomplete nor keep the gate Closed; the hook given a
    /// later view revision schedules the gate's exact entry.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn r1_revision_only_changes_before_join_still_open_the_exact_entry() {
        let (root_w1, _) = recovery_workspace(0);
        let (root, attempts) = recovery_workspace(1);
        let state = Arc::new(
            AppState::new(
                root.join("native-app").to_str().expect("app path"),
                root.join("resources").to_str().expect("resources path"),
            )
            .expect("native state"),
        );
        let adapter = &state.workspace_lifecycle;
        let authority = |path: &Path| {
            let db = grimodex_db::Database::new(&path.join("grimodex.db")).expect("database");
            db.migrate().expect("schema");
            WorkspaceAuthority::from_database_for_test(db, path.to_path_buf()).expect("authority")
        };
        // W1 becomes a background recovery descriptor; W2 (with the pending
        // attempt) is the active Ready entry.
        *state.ws.inner.lock().expect("workspace") =
            Some(ActiveWorkspace::new(authority(&root_w1)));
        adapter.ensure_authority_ready(&state.ws).expect("W1 Ready");
        adapter.begin_transition().expect("W1 transition");
        adapter
            .publish_recovery_required(&state.ws)
            .expect("W1 descriptor");
        let descriptor_id = match adapter.lifecycle_snapshot().expect("snapshot").state {
            LifecycleState::RecoveryRequired { descriptor_id } => descriptor_id,
            state => panic!("expected the W1 descriptor, got {state:?}"),
        };
        *state.ws.inner.lock().expect("workspace") = Some(ActiveWorkspace::new(authority(&root)));
        adapter.begin_transition().expect("W2 transition");
        adapter
            .complete_transition_from_workspace(&state.ws)
            .expect("W2 Ready");
        let (binding, entry_revision) = current_ready(&state);
        assert!(startup_gate(&state).awaits_recovery_for(&binding, entry_revision));

        // A quarantine set and release before the hook: the view the hook
        // receives is newer than the entry.
        drop(quarantine_ready_workspace(&state));
        let view_revision = current_ready(&state).1;
        assert!(view_revision > entry_revision);
        assert_eq!(
            ready_entry_for_view(&state, &binding, entry_revision - 1, view_revision),
            None,
            "a view older than the entry is stale"
        );
        let (reached_tx, reached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_worker_probe
            .lock()
            .expect("worker probe") = Some((reached_tx, release_rx));
        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            view_revision
        ));
        assert_eq!(
            state
                .nir1_generation_recovery_statuses
                .lock()
                .expect("ledger")
                .entry
                .as_ref()
                .map(|entry| entry.ready_revision),
            Some(entry_revision),
            "the hook schedules the gate's exact entry"
        );
        reached_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker paused before capture");

        // Between Ready and Join: quarantine set/release and a background
        // descriptor completion for W1. None of them is a lifecycle edge.
        drop(quarantine_ready_workspace(&state));
        let background = adapter
            .begin_recovery_transition(descriptor_id, &state.ws)
            .expect("background recovery admission")
            .0;
        assert_eq!(
            background.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
        );
        adapter
            .mark_current_transition_joined()
            .expect("background Join");
        adapter
            .complete_transition_from_workspace(&state.ws)
            .expect("complete background recovery");
        let (after_binding, after_revision) = current_ready(&state);
        assert_eq!(after_binding, binding);
        assert!(after_revision > view_revision);
        assert!(same_ready_entry(&state, &binding, entry_revision));
        release_tx.send(()).expect("release the worker");

        wait_startup_gate_open(&state, &binding, entry_revision).await;
        wait_recovery_joined(&state).await;
        assert_eq!(
            recovery_hook_state(&state, &binding),
            Some(GenerationRecoveryHookState::Complete)
        );
        let lease = startup_gate(&state)
            .try_lease_for_binding(&binding)
            .expect("a binding lease after revision-only changes");
        assert_eq!(lease.entry_revision(), entry_revision);
        drop(lease);
        let db = active_workspace_snapshot(&state.ws).expect("W2 workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal read")
            .is_some());
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
        std::fs::remove_dir_all(root_w1).expect("W1 cleanup");
    }

    /// R2 (P3(b)): a quarantine after Open refuses new participants; after its
    /// release the same entry still issues leases (no sweep is needed).
    #[test]
    fn r2_quarantine_after_open_refuses_participants_until_release() {
        let (root, _) = recovery_workspace(0);
        let state = reopened_recovery_state(&root);
        let (binding, entry_revision) = publish_new_ready_entry(&state, AdmissionKind::Open);
        assert!(sweep_and_open_ready_entry_for_test(&state));
        assert!(startup_gate(&state).is_open_for(&binding, entry_revision));
        let quarantine = quarantine_ready_workspace(&state);
        assert!(state
            .ws
            .lifecycle_core()
            .begin_workspace_participant()
            .is_err());
        assert!(
            startup_gate(&state).is_open_for(&binding, entry_revision),
            "a revision-only change is not an edge"
        );
        drop(quarantine);
        let core_revision = current_ready(&state).1;
        assert!(core_revision > entry_revision);
        drop(
            state
                .ws
                .lifecycle_core()
                .begin_workspace_participant()
                .expect("participants after the release"),
        );
        let lease = startup_gate(&state)
            .try_lease_for_binding(&binding)
            .expect("the same entry issues a lease");
        assert!(lease.is_current());
        assert!(same_ready_entry(&state, &binding, entry_revision));
        assert!(!same_ready_entry(&state, &binding, core_revision));
        drop(lease);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    /// R4 (P3(a)): the Ready publisher runs off the runtime thread, so a
    /// lease held by a task on a current-thread runtime drops before the
    /// drain limit. Called on the runtime thread itself, the same drain times
    /// out and publishes RecoveryRequired.
    #[test]
    fn r4_off_runtime_publisher_lets_a_runtime_lease_holder_drop() {
        for off_runtime in [true, false] {
            let (root, _) = recovery_workspace(0);
            let state = reopened_recovery_state(&root);
            let (binding, revision) = open_startup_gate_for_current_ready(&state);
            let runtime = napi::tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("current-thread runtime");
            let status = runtime.block_on(async {
                let lease = startup_gate(&state)
                    .try_lease(&binding, revision)
                    .expect("lease held by a runtime task");
                admitted_ticket(
                    state
                        .workspace_lifecycle
                        .try_begin_transition_kind(AdmissionKind::Restore)
                        .expect("admission"),
                );
                let holder = napi::tokio::spawn(async move {
                    napi::tokio::time::sleep(Duration::from_millis(20)).await;
                    drop(lease);
                });
                let started = Instant::now();
                let view = if off_runtime {
                    crate::publish_workspace_lifecycle_from_workspace_off_runtime(&state)
                        .await
                        .expect("publication")
                } else {
                    crate::publish_workspace_lifecycle_from_workspace(&state).expect("publication")
                };
                let elapsed = started.elapsed();
                holder.await.expect("holder");
                if off_runtime {
                    assert!(elapsed < NIR1_STARTUP_LEASE_DRAIN_LIMIT, "{elapsed:?}");
                }
                view.status
            });
            assert_eq!(
                status,
                if off_runtime {
                    crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
                } else {
                    crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::RecoveryRequired
                },
                "off_runtime={off_runtime}"
            );
            drop(state);
            std::fs::remove_dir_all(root).expect("cleanup");
        }
    }

    /// R5 (P3(c)): a worker that recorded its sweep proof and is paused before
    /// returning cannot open a newer entry; the pending entry opens after the
    /// Join with its own proof.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn r5_a_recorded_proof_cannot_open_a_newer_entry() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let (binding_a, revision_a) = current_ready(&state);
        let (tail_tx, tail_rx) = mpsc::channel();
        let (tail_release_tx, tail_release_rx) = mpsc::channel();
        *state
            .nir1_generation_recovery_completion_probe
            .lock()
            .expect("tail probe") = Some((tail_tx, tail_release_rx));
        assert!(start_generation_recovery_after_ready(
            Arc::clone(&state),
            revision_a
        ));
        tail_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("A recorded its sweep and paused before returning the proof");
        assert_eq!(
            recovery_hook_state(&state, &binding_a),
            Some(GenerationRecoveryHookState::Complete)
        );
        let (binding_b, revision_b) = publish_new_ready_entry(&state, AdmissionKind::Restore);
        assert!(!start_generation_recovery_after_ready(
            Arc::clone(&state),
            revision_b
        ));
        tail_release_tx.send(()).expect("release A");
        wait_startup_gate_open(&state, &binding_b, revision_b).await;
        wait_recovery_joined(&state).await;
        assert!(!startup_gate(&state).is_open_for(&binding_a, revision_a));
        assert!(startup_gate(&state).is_open_for(&binding_b, revision_b));
        let db = active_workspace_snapshot(&state.ws).expect("B workspace");
        assert!(storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal read")
            .is_some());
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    type HeldConnection = Arc<std::sync::Mutex<Option<(mpsc::Sender<()>, thread::JoinHandle<()>)>>>;

    /// Hold the workspace connection mutex on another thread until the
    /// returned sender fires (at most 10 s).
    fn hold_connection_mutex(
        authority: &grimodex_db::PinnedWorkspaceDb,
    ) -> (mpsc::Sender<()>, thread::JoinHandle<()>) {
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = Arc::clone(authority);
        let worker = thread::spawn(move || {
            holder
                .db()
                .with_conn(|_| {
                    held_tx.send(()).expect("announce the held mutex");
                    let _ = release_rx.recv_timeout(Duration::from_secs(10));
                    Ok(())
                })
                .expect("mutex holder");
        });
        held_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("connection mutex held");
        (release_tx, worker)
    }

    fn release_held_connection(held: &HeldConnection) {
        if let Some((release, holder)) = held.lock().expect("holder").take() {
            release.send(()).expect("release the mutex");
            holder.join().expect("mutex holder joined");
        }
    }

    /// Before the first recovery try, hold the connection mutex; before the
    /// try numbered `release_before` (if any), release it again. `on_try`
    /// runs after that. Returns the last try number seen and the holder.
    fn install_busy_recovery_probe(
        state: &AppState,
        release_before: Option<usize>,
        on_try: impl Fn(usize) + Send + 'static,
    ) -> (Arc<std::sync::atomic::AtomicUsize>, HeldConnection) {
        let authority = Arc::clone(
            active_workspace_snapshot(&state.ws)
                .expect("Ready workspace")
                .db(),
        );
        let tries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let held: HeldConnection = Arc::new(std::sync::Mutex::new(None));
        let probe_tries = Arc::clone(&tries);
        let probe_held = Arc::clone(&held);
        *state
            .nir1_generation_recovery_try_probe
            .lock()
            .expect("try probe") = Some(Box::new(move |try_number| {
            probe_tries.store(try_number, Ordering::SeqCst);
            if try_number == 1 {
                *probe_held.lock().expect("holder") = Some(hold_connection_mutex(&authority));
            } else if Some(try_number) == release_before {
                release_held_connection(&probe_held);
            }
            on_try(try_number);
        }));
        (tries, held)
    }

    /// R6 (DT-2 P3): a recovery write that only timed out on the connection
    /// mutex is tried again inside the sweep budget. A hold that outlasts the
    /// mutex limit but ends before the next try no longer leaves the entry's
    /// startup gate Closed: the sweep completes and the gate opens.
    #[test]
    fn r6_sweep_retries_a_connection_busy_recovery_and_opens_the_gate() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let (binding, revision) = publish_new_ready_entry(&state, AdmissionKind::Open);
        let (tries, held) = install_busy_recovery_probe(&state, Some(2), |_| {});
        let started = Instant::now();
        assert!(
            sweep_and_open_ready_entry_for_test(&state),
            "the retried sweep completes and opens the gate"
        );
        let elapsed = started.elapsed();
        release_held_connection(&held);
        assert_eq!(
            tries.load(Ordering::SeqCst),
            2,
            "one ConnectionBusy try, then the recovery"
        );
        assert!(
            elapsed >= storage::NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT,
            "{elapsed:?}"
        );
        assert!(startup_gate(&state).is_open_for(&binding, revision));
        let db = active_workspace_snapshot(&state.ws).expect("workspace");
        let terminal = storage::read_terminal(db.db(), &attempts[0].id)
            .expect("terminal read")
            .expect("recovered attempt");
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    /// R6 (DT-2 P3): the tries are finite and stay inside the sweep. After
    /// `MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS` mutex timeouts the sweep is
    /// incomplete with a typed reason and nothing is terminalized; a sweep
    /// deadline too short for the last try stops them earlier. A fresh owner
    /// recovers the attempt once the mutex is free.
    ///
    /// The first sweep runs under the production per-operation limit, which is
    /// shorter than the tries' mutex waits together. It therefore ends in the
    /// busy limit only because each try takes a fresh operation deadline: the
    /// default limits of a test build would fit every try into one deadline
    /// and let a deadline shared across the tries pass unnoticed.
    #[test]
    fn r6_connection_busy_tries_are_bounded_by_count_and_sweep_deadline() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let pending = |state: &AppState| {
            let db = active_workspace_snapshot(&state.ws).expect("workspace");
            storage::read_terminal(db.db(), &attempts[0].id)
                .expect("terminal read")
                .is_none()
        };

        // One try fits in the production per-operation limit (250 ms) with
        // room to spare, the tries together (3 x the 100 ms mutex limit) do
        // not. Only the sweep time is widened, for a slow runner. The two page
        // reads before the first try are the only SQL under the narrow
        // operation deadline: the mutex is held from the first try on.
        let tries_u32 = u32::try_from(MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS).expect("tries");
        let limits = GenerationRecoveryLimits {
            time: TEST_RECOVERY_SWEEP_TIME,
            ..GenerationRecoveryLimits::PRODUCTION_LIMITS
        };
        let mutex_limit = storage::NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT;
        assert!(
            limits.operation_time > mutex_limit,
            "one try fits in an operation deadline"
        );
        assert!(
            limits.operation_time < mutex_limit * tries_u32,
            "the tries together must outlast one operation deadline"
        );
        let (tries, held) = install_busy_recovery_probe(&state, None, |_| {});
        let owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture")
            .expect("ready owner");
        let started = Instant::now();
        let error = owner
            .recover_all_pending_attempts_with_limits(limits)
            .expect_err("exhausted tries leave the sweep incomplete");
        let elapsed = started.elapsed();
        release_held_connection(&held);
        assert_eq!(
            tries.load(Ordering::SeqCst),
            MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS
        );
        assert!(
            error
                .to_string()
                .contains("NIR1_GENERATION_RECOVERY_CONNECTION_BUSY_LIMIT"),
            "{error:#}"
        );
        assert!(storage::is_recovery_connection_busy(&error), "{error:#}");
        assert!(elapsed >= mutex_limit * tries_u32, "{elapsed:?}");
        assert!(elapsed < MAX_RECOVERY_SWEEP_TIME, "{elapsed:?}");
        assert!(pending(&state));

        // 1.5 mutex limits of sweep time leave no room for a third try.
        let (tries, held) = install_busy_recovery_probe(&state, None, |_| {});
        let owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture")
            .expect("ready owner");
        let limits = GenerationRecoveryLimits {
            time: storage::NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT * 3 / 2,
            ..GenerationRecoveryLimits::SAFETY_LIMITS
        };
        let started = Instant::now();
        let error = owner
            .recover_all_pending_attempts_with_limits(limits)
            .expect_err("the sweep deadline leaves the sweep incomplete");
        let elapsed = started.elapsed();
        release_held_connection(&held);
        assert!(
            tries.load(Ordering::SeqCst) < MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS,
            "the sweep deadline stopped the tries"
        );
        assert!(
            !error
                .to_string()
                .contains("NIR1_GENERATION_RECOVERY_CONNECTION_BUSY_LIMIT"),
            "{error:#}"
        );
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert!(pending(&state));

        *state
            .nir1_generation_recovery_try_probe
            .lock()
            .expect("try probe") = None;
        let summary = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture")
            .expect("fresh owner")
            .recover_all_pending_attempts()
            .expect("a fresh owner recovers once the mutex is free");
        assert_eq!(summary.recovered, 1);
        assert!(!pending(&state));
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    /// R6 (DT-2 P3): a shutdown requested before a retried try is observed by
    /// that try's mutex wait; the tries stop and the sweep is incomplete
    /// without a busy reason.
    #[test]
    fn r6_shutdown_stops_connection_busy_tries() {
        let (root, attempts) = recovery_workspace(1);
        let state = reopened_recovery_state(&root);
        let core = state.ws.lifecycle_core();
        let (tries, held) = install_busy_recovery_probe(&state, None, move |try_number| {
            if try_number == 2 {
                core.request_shutdown().expect("shutdown");
            }
        });
        let owner = GenerationRecoveryCoordinator::capture(Arc::clone(&state))
            .expect("capture")
            .expect("ready owner");
        let started = Instant::now();
        let error = owner
            .recover_all_pending_attempts()
            .expect_err("shutdown leaves the sweep incomplete");
        let elapsed = started.elapsed();
        release_held_connection(&held);
        assert_eq!(tries.load(Ordering::SeqCst), 2);
        assert!(!storage::is_recovery_connection_busy(&error), "{error:#}");
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
        assert!(storage::read_terminal(&db, &attempts[0].id)
            .expect("terminal read")
            .is_none());
        drop(db);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
