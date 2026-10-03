//! Internal D2b control-plane claim owner. No N-API entry or production transport exists.
//!
//! This composes real profile/workspace/route revocation with a durable claim.
//! It is not a material, Scope, history or product-send authorization grant.
//! Those canonical readers must be integrated before any production transport is exposed.

#![cfg_attr(not(test), allow(dead_code))]

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{ensure, Context, Result};
use grimodex_core::narrative_nir1_receipt::TerminalObservation;
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::nir1_generation::{
    self as storage, AttemptBinding, GenerationPurpose, InputReference, NewAttempt, NewMessageBody,
    QualificationReference, ReadBudget, StoredAttempt, StoredTerminal,
};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use grimodex_db::workspace_lifecycle::{LifecycleState, LiveBinding, WorkspaceParticipant};
use grimodex_db::{ParticipantSqlOperationBudget, PinnedWorkspaceDb};
use serde_json::{json, Value};

use crate::profile_egress::{CallerIdentity, ProfileDispatchPermit};
#[cfg(test)]
use crate::state::GenerationRecoveryLaunchObservation;
use crate::state::{
    AppState, GenerationRecoveryHookEntry, GenerationRecoveryHookState, WorkspaceOperationGuard,
};

// No production entry constructs an owner until all D2b publication gates
// pass. Tests exercise these same primitives with a private recorder only.
pub(crate) struct GenerationClaimOwner {
    state: Arc<AppState>,
    db: PinnedWorkspaceDb,
    participant: WorkspaceParticipant,
    permit: ProfileDispatchPermit,
    caller: CallerIdentity,
    live_binding: LiveBinding,
    workspace_digest: String,
    route_revision: String,
    cancellation: Mutex<GenerationOwnerCancellation>,
}

#[derive(Default)]
struct GenerationOwnerCancellation {
    cancelled: bool,
    #[cfg(test)]
    test_transport_started: bool,
    #[cfg(test)]
    test_stream: Option<std::net::TcpStream>,
}

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
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub budget: ReadBudget,
}

/// Private immutable pairing metadata.  The DB remains the owner of the
/// durable reference list and terminal matrix; Native retains a copy of every
/// immutable field solely so a later operation cannot substitute a different
/// same-binding attempt behind the payload handle.
#[derive(Clone, Debug)]
struct FinalizedAttemptSnapshot {
    id: String,
    binding: AttemptBinding,
    payload_digest: String,
    input_digest: String,
    inputs: Vec<InputReference>,
    qualifications: Vec<QualificationReference>,
    budget: ReadBudget,
}

/// In-process pairing of canonical payload bytes and the exact durable
/// attempt.  All fields stay private; callers use the guarded methods below.
#[derive(Clone, Debug)]
pub(crate) struct FinalizedAttempt {
    snapshot: FinalizedAttemptSnapshot,
    canonical_payload: String,
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
const MAX_RECOVERY_OPERATION_TIME: Duration = Duration::from_millis(250);
const RECOVERY_SQL_BUSY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct GenerationRecoveryLimits {
    pages: usize,
    items: usize,
    time: Duration,
    operation_time: Duration,
    busy_timeout: Duration,
}

impl GenerationRecoveryLimits {
    const SAFETY_LIMITS: Self = Self {
        pages: MAX_RECOVERY_SWEEP_PAGES,
        items: MAX_RECOVERY_SWEEP_ITEMS,
        time: MAX_RECOVERY_SWEEP_TIME,
        operation_time: MAX_RECOVERY_OPERATION_TIME,
        busy_timeout: RECOVERY_SQL_BUSY_TIMEOUT,
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
        let ready_revision = lifecycle.revision;
        let live_binding = match lifecycle.state {
            LifecycleState::Ready(binding) => binding,
            _ => return Ok(None),
        };
        if expected_revision.is_some_and(|expected| expected != ready_revision)
            || expected_binding.is_some_and(|expected| expected != &live_binding)
        {
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
        let lifecycle = match state.ws.lifecycle_core().snapshot() {
            Ok(lifecycle) => lifecycle,
            Err(_) => return Ok(None),
        };
        let live_binding = match lifecycle.state {
            LifecycleState::Ready(binding) => binding,
            _ => return Ok(None),
        };
        if lifecycle.revision != ready_revision
            || expected_revision.is_some_and(|expected| expected != lifecycle.revision)
            || expected_binding.is_some_and(|expected| expected != &live_binding)
        {
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
            .inspect_err(|_| {
                #[cfg(test)]
                eprintln!("NIR1_RECOVERY_BOUNDED_OP=project-page");
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
                    .inspect_err(|_| {
                        #[cfg(test)]
                        eprintln!("NIR1_RECOVERY_BOUNDED_OP=attempt-page");
                    })?;
                    summary.attempt_pages += 1;
                    if attempts.is_empty() {
                        break;
                    }
                    for attempt_id in attempts {
                        budget.begin_item(&self)?;
                        storage::recover_attempt_bounded(
                            &self.workspace,
                            &attempt_id,
                            now_ms()?,
                            budget.operation(),
                        )
                        .inspect_err(|_| {
                            #[cfg(test)]
                            eprintln!("NIR1_RECOVERY_BOUNDED_OP=recover-attempt");
                        })?;
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

    fn ensure_current_binding(&self) -> Result<()> {
        ensure!(
            !self
                .state
                .workspace_shutdown_requested
                .load(std::sync::atomic::Ordering::Acquire)
                && !self.state.ws.lifecycle_core().shutdown_requested()?,
            "NIR1_GENERATION_RECOVERY_SHUTDOWN"
        );
        let lifecycle = self.state.ws.lifecycle_core().snapshot()?;
        ensure!(
            lifecycle.revision == self.ready_revision
                && matches!(
                    &lifecycle.state,
                    LifecycleState::Ready(binding) if binding == &self.live_binding
                ),
            "NIR1_GENERATION_RECOVERY_BINDING_CHANGED"
        );
        Ok(())
    }
}

fn detach_generation_recovery(worker: impl FnOnce() + Send + 'static) {
    drop(napi::tokio::task::spawn_blocking(worker));
}

fn schedule_generation_recovery(
    state: &AppState,
    binding: &LiveBinding,
    ready_revision: u64,
) -> bool {
    let mut ledger = state
        .nir1_generation_recovery_statuses
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if ready_revision < ledger.latest_ready_revision {
        return false;
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

    match ledger.entry.as_mut() {
        Some(entry) if &entry.binding == binding => match entry.state {
            GenerationRecoveryHookState::Complete
            | GenerationRecoveryHookState::Scheduled
            | GenerationRecoveryHookState::Running => false,
            GenerationRecoveryHookState::Incomplete if entry.ready_revision < ready_revision => {
                entry.state = GenerationRecoveryHookState::Scheduled;
                entry.ready_revision = ready_revision;
                true
            }
            GenerationRecoveryHookState::Incomplete => false,
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
    }
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
        let lifecycle = state.ws.lifecycle_core().snapshot().ok();
        if state
            .workspace_shutdown_requested
            .load(std::sync::atomic::Ordering::Acquire)
            || state
                .ws
                .lifecycle_core()
                .shutdown_requested()
                .unwrap_or(true)
            || !lifecycle.as_ref().is_some_and(|lifecycle| {
                lifecycle.revision == ready_revision
                    && matches!(
                        &lifecycle.state,
                        LifecycleState::Ready(current) if current == &binding
                    )
            })
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

fn run_generation_recovery_after_ready(
    state: Arc<AppState>,
    binding: LiveBinding,
    ready_revision: u64,
) {
    let Some(worker) =
        GenerationRecoveryHookWorker::start(Arc::clone(&state), binding.clone(), ready_revision)
    else {
        return;
    };
    #[cfg(test)]
    observe_generation_recovery_worker_probe(&state);
    let owner = match GenerationRecoveryCoordinator::capture_for_binding(
        Arc::clone(&state),
        Some(&binding),
        Some(ready_revision),
    ) {
        Ok(Some(owner)) => owner,
        Ok(None) => return,
        Err(error) => {
            tracing::debug!(error = %error, "NIR-1 generation recovery incomplete");
            return;
        }
    };
    match owner.recover_all_pending_attempts() {
        Ok(_) => worker.complete(),
        Err(error) => tracing::debug!(error = %error, "NIR-1 generation recovery incomplete"),
    }
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

/// Start a best-effort detached recovery only from the exact Ready publication
/// named by `ready_revision`. No workspace participant or operation owner is
/// captured until the blocking worker actually starts.
pub(crate) fn start_generation_recovery_after_ready(
    state: Arc<AppState>,
    ready_revision: u64,
) -> bool {
    if state
        .workspace_shutdown_requested
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return false;
    }
    let lifecycle = match state.ws.lifecycle_core().snapshot() {
        Ok(lifecycle) if lifecycle.revision == ready_revision => lifecycle,
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
    let binding = match lifecycle.state {
        LifecycleState::Ready(binding) => binding,
        _ => return false,
    };
    if !schedule_generation_recovery(&state, &binding, ready_revision) {
        return false;
    }
    #[cfg(test)]
    observe_generation_recovery_launch(&state, &binding, ready_revision);
    detach_generation_recovery(move || {
        run_generation_recovery_after_ready(state, binding, ready_revision)
    });
    true
}

pub(crate) fn final_payload_digest(payload: &Value) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": "nir1-generation-payload@1",
        "payload": payload,
    }))?)
}

fn canonical_final_payload(payload: &Value) -> Result<(String, String)> {
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
        "domain": "nir1-generation-inputs@1",
        "inputs": inputs,
        "qualifications": qualifications,
    }))?)
}

fn finalized_snapshot(attempt: &StoredAttempt, budget: ReadBudget) -> FinalizedAttemptSnapshot {
    FinalizedAttemptSnapshot {
        id: attempt.id.clone(),
        binding: attempt.binding.clone(),
        payload_digest: attempt.payload_digest.clone(),
        input_digest: attempt.input_digest.clone(),
        inputs: attempt.inputs.clone(),
        qualifications: attempt.qualifications.clone(),
        budget,
    }
}

fn verify_finalized_attempt(finalized: &FinalizedAttempt) -> Result<()> {
    let payload: Value = serde_json::from_str(&finalized.canonical_payload)
        .context("NIR1_GENERATION_FINAL_PAYLOAD_INVALID")?;
    ensure!(
        canonical_json_string(&payload)? == finalized.canonical_payload,
        "NIR1_GENERATION_FINAL_PAYLOAD_NOT_CANONICAL"
    );
    ensure!(
        final_payload_digest(&payload)? == finalized.snapshot.payload_digest,
        "NIR1_GENERATION_FINAL_PAYLOAD_DIGEST_MISMATCH"
    );
    ensure!(
        final_input_digest(
            &finalized.snapshot.inputs,
            &finalized.snapshot.qualifications,
        )? == finalized.snapshot.input_digest,
        "NIR1_GENERATION_FINAL_INPUT_DIGEST_MISMATCH"
    );
    Ok(())
}

fn now_ms() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

fn route_revision(state: &AppState) -> Result<String> {
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

impl GenerationClaimOwner {
    pub(crate) fn capture(state: Arc<AppState>, caller: CallerIdentity) -> Result<Self> {
        let permit = state.profile_egress.begin_dispatch(Some(&caller))?;
        let participant = state.ws.lifecycle_core().begin_workspace_participant()?;
        let workspace = active_workspace_snapshot(&state.ws)?;
        let snapshot = state.ws.lifecycle_core().snapshot()?;
        let live_binding = snapshot
            .binding()
            .context("NIR1_GENERATION_WORKSPACE_NOT_READY")?
            .clone();
        ensure!(
            live_binding.authority_instance == workspace.db().identity(),
            "NIR1_GENERATION_WORKSPACE_CHANGED"
        );
        let workspace_digest = canonical_json_digest(&serde_json::to_value(&live_binding)?)?;
        let route_revision = state.profile_egress.with_authorized_dispatch(
            &permit,
            Some(&caller),
            Some(&live_binding.locator),
            || route_revision(&state),
        )?;
        Ok(Self {
            state,
            db: Arc::clone(workspace.db()),
            participant,
            permit,
            caller,
            live_binding,
            workspace_digest,
            route_revision,
            cancellation: Mutex::new(GenerationOwnerCancellation::default()),
        })
    }

    /// Cancel may win while the claim worker is waiting for its DB connection.
    /// Never acquire a DB connection while retaining this cancellation lock.
    pub(crate) fn cancel(&self) -> Result<()> {
        #[cfg(test)]
        let active_test_stream = {
            let mut cancellation = self
                .cancellation
                .lock()
                .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OWNER_POISONED"))?;
            cancellation.cancelled = true;
            cancellation
                .test_stream
                .as_ref()
                .map(std::net::TcpStream::try_clone)
                .transpose()?
        };
        #[cfg(not(test))]
        {
            self.cancellation
                .lock()
                .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OWNER_POISONED"))?
                .cancelled = true;
        }
        #[cfg(test)]
        if let Some(stream) = active_test_stream {
            stream.shutdown(std::net::Shutdown::Both)?;
        }
        Ok(())
    }

    /// Test-only start gate. Cancellation and transport start linearize on the
    /// same short lock; the returned stream clone lets `cancel` close an active
    /// local fixture after releasing that lock. No socket I/O happens in this method.
    #[cfg(test)]
    fn begin_test_transport(&self, stream: &std::net::TcpStream) -> Result<bool> {
        let mut cancellation = self
            .cancellation
            .lock()
            .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OWNER_POISONED"))?;
        if cancellation.cancelled {
            return Ok(false);
        }
        ensure!(
            !cancellation.test_transport_started,
            "NIR1_GENERATION_TEST_TRANSPORT_ALREADY_STARTED"
        );
        cancellation.test_stream = Some(stream.try_clone()?);
        cancellation.test_transport_started = true;
        Ok(true)
    }

    #[cfg(test)]
    fn finish_test_transport(&self) -> Result<()> {
        self.cancellation
            .lock()
            .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OWNER_POISONED"))?
            .test_stream = None;
        Ok(())
    }

    /// Persist the final request before dispatch.  This is the only Native
    /// helper that derives the payload digest: a caller cannot provide a
    /// digest that disagrees with the canonical request bytes.  Storage then
    /// validates the session, message/artifact references and qualification
    /// rows in its own short transaction.  This does not certify the missing
    /// typed Scope/material/D1 authority; that remains a fail-closed caller
    /// responsibility until the current readers are integrated.
    pub(crate) fn persist_final_request(
        &self,
        request: FinalDispatchRequest,
    ) -> Result<FinalizedAttempt> {
        self.permit.ensure_open()?;
        {
            let cancellation = self
                .cancellation
                .lock()
                .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OWNER_POISONED"))?;
            ensure!(!cancellation.cancelled, "NIR1_GENERATION_CANCELLED");
        }
        ensure!(
            request.route_revision == self.route_revision,
            "NIR1_GENERATION_ROUTE_CHANGED"
        );
        let (canonical_payload, payload_digest) = canonical_final_payload(&request.payload)?;
        let binding = AttemptBinding {
            project_id: request.project_id,
            session_id: self.caller.session_id.clone(),
            profile_id: self.caller.profile_id.clone(),
            caller_id: self.caller.caller_id.clone(),
            caller_epoch: self.caller.caller_epoch,
            workspace_binding_digest: self.workspace_digest.clone(),
            purpose: request.purpose,
            scope_digest: request.scope_digest,
            material_digest: request.material_digest,
            d1_digest: request.d1_digest,
            route_revision: self.route_revision.clone(),
            provider: request.provider,
            model: request.model,
            api: request.api,
            endpoint_identity: request.endpoint_identity,
        };
        let attempt = storage::create_attempt(
            self.db.db(),
            NewAttempt {
                binding,
                payload_digest,
                inputs: request.inputs,
                qualifications: request.qualifications,
                created_at_ms: request.created_at_ms,
                expires_at_ms: request.expires_at_ms,
                budget: request.budget,
            },
        )?;
        Ok(FinalizedAttempt {
            snapshot: finalized_snapshot(&attempt, request.budget),
            canonical_payload,
        })
    }

    /// Re-read the immutable attempt fields before every claim/terminal
    /// operation.  The storage CAS intentionally checks only its binding; the
    /// Native pairing therefore checks id, payload/input digests and ordered
    /// references as well.  Claimed/terminal timestamps may change, but no
    /// other field may be rebound to this handle.
    fn read_exact_finalized_attempt(
        &self,
        finalized: &FinalizedAttempt,
        budget: ReadBudget,
    ) -> Result<StoredAttempt> {
        let current = storage::read_attempt(self.db.db(), &finalized.snapshot.id, budget)?;
        ensure!(
            current.id == finalized.snapshot.id
                && current.binding == finalized.snapshot.binding
                && current.payload_digest == finalized.snapshot.payload_digest
                && current.input_digest == finalized.snapshot.input_digest
                && current.inputs == finalized.snapshot.inputs
                && current.qualifications == finalized.snapshot.qualifications,
            "NIR1_GENERATION_FINAL_ATTEMPT_PAIRING_MISMATCH"
        );
        Ok(current)
    }

    /// Claim only the request whose canonical payload was durably prepared.
    /// This keeps the payload/reference pairing intact while reusing the
    /// existing profile/workspace/route guarded one-shot CAS.
    pub(crate) fn consume_finalized_claim(
        &self,
        finalized: &FinalizedAttempt,
        budget: ReadBudget,
    ) -> Result<bool> {
        verify_finalized_attempt(finalized)?;
        let attempt = self.read_exact_finalized_attempt(finalized, budget)?;
        self.consume_claim(&attempt, budget)
    }

    /// Finish the exact pinned attempt after transport observation.  This
    /// method intentionally does not reacquire lifecycle admission: an owner
    /// that already passed the claim may complete durable terminal cleanup
    /// after new admissions close.  `finish_attempt` remains the DB writer for
    /// body/version/receipt atomicity and terminal conflict handling.
    pub(crate) fn persist_terminal(
        &self,
        finalized: &FinalizedAttempt,
        observation: &TerminalObservation,
        body: Option<NewMessageBody>,
        now_ms: i64,
    ) -> Result<StoredTerminal> {
        verify_finalized_attempt(finalized)?;
        self.read_exact_finalized_attempt(finalized, finalized.snapshot.budget)?;
        storage::finish_attempt(
            self.db.db(),
            &finalized.snapshot.id,
            observation,
            body,
            now_ms,
        )
    }

    /// Recover the exact unfinished attempt without reconstructing a request
    /// or invoking transport.  The DB recovery writer records the conservative
    /// interrupted/unknown terminal and never makes the old handle reusable.
    pub(crate) fn recover_terminal(
        &self,
        finalized: &FinalizedAttempt,
        now_ms: i64,
    ) -> Result<StoredTerminal> {
        verify_finalized_attempt(finalized)?;
        self.read_exact_finalized_attempt(finalized, finalized.snapshot.budget)?;
        storage::recover_attempt(self.db.db(), &finalized.snapshot.id, now_ms)
    }

    /// Consume the durable right under the existing control-plane authorities.
    /// A true return is not permission to use any product transport.
    fn consume_claim(&self, attempt: &StoredAttempt, budget: ReadBudget) -> Result<bool> {
        let binding = &attempt.binding;
        ensure!(
            binding.profile_id == self.caller.profile_id
                && binding.caller_id == self.caller.caller_id
                && binding.caller_epoch == self.caller.caller_epoch
                && binding.session_id == self.caller.session_id
                && binding.workspace_binding_digest == self.workspace_digest
                && binding.route_revision == self.route_revision,
            "NIR1_GENERATION_OWNER_BINDING_MISMATCH"
        );
        // Deliberate D2b-1 boundary: this owner does not derive provider,
        // model, API, endpoint, payload, material, Scope, or history
        // currentness from a trusted final request. The attempt's immutable
        // fields are storage-validated only; no transport permission follows.
        // Validation and body hashing happen before the profile/core guards
        // in one fresh IMMEDIATE transaction. PreparedClaim rejects nested
        // SQL progress scopes; COMMIT remains inside both guards.
        storage::with_prepared_claim(self.db.db(), &attempt.id, binding, budget, |prepared| {
            let cancellation = self
                .cancellation
                .lock()
                .map_err(|_| anyhow::anyhow!("NIR1_GENERATION_OWNER_POISONED"))?;
            ensure!(!cancellation.cancelled, "NIR1_GENERATION_CANCELLED");
            self.state.profile_egress.with_authorized_dispatch(
                &self.permit,
                Some(&self.caller),
                Some(&self.live_binding.locator),
                || {
                    ensure!(
                        route_revision(&self.state)? == self.route_revision,
                        "NIR1_GENERATION_ROUTE_CHANGED"
                    );
                    self.participant
                        .with_current_binding(&self.live_binding, || prepared.commit(now_ms()?))?
                },
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_core::narrative_nir1_receipt::{
        Completion, OutputObserver, ParseStatus, ProviderTerminal, TerminalStatus,
    };
    use grimodex_db::nir1_generation::{
        AttemptBinding, FailureClassification, GenerationPurpose, NewAttempt,
    };
    use grimodex_db::state::{ActiveWorkspace, WorkspaceAuthority};
    use grimodex_db::workspace_lifecycle::AdmissionKind;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    /// A fixed, test-only framed protocol over 127.0.0.1. It sends no HTTP,
    /// accepts no configurable destination/provider, and owns no retry,
    /// redirect, proxy, background task, or recovery callback. Its evidence is
    /// limited to exact local request bytes, separated raw output observations,
    /// explicit fixture terminal frames, and peer close behavior. It does not
    /// prove any provider protocol, remote receipt, product route, real
    /// provider termination bound, or D2b publication readiness.
    mod loopback {
        use grimodex_core::narrative_nir1_receipt::{
            Completion, OutputChannel, OutputObserver, ProviderTerminal, TerminalObservation,
        };
        use std::io::{self, Read, Write};
        use std::net::{SocketAddr, TcpListener, TcpStream};
        use std::thread;
        use std::time::{Duration, Instant};

        use anyhow::{ensure, Result};

        pub(super) const IO_TIMEOUT: Duration = Duration::from_secs(5);
        const MAX_FRAME_BYTES: usize = 64 * 1024;
        const TEXT: u8 = 1;
        const THINKING: u8 = 2;
        const TERMINAL: u8 = 3;
        const COMPLETE: u8 = 1;
        const LENGTH_LIMIT: u8 = 2;
        const INELIGIBLE: u8 = 3;

        pub(super) struct Response {
            pub(super) observation: TerminalObservation,
            pub(super) text: Vec<u8>,
            pub(super) thinking: Vec<u8>,
            pub(super) saw_terminal: bool,
            pub(super) peer_closed: bool,
        }

        pub(super) fn listener() -> Result<TcpListener> {
            let listener = TcpListener::bind(("127.0.0.1", 0))?;
            listener.set_nonblocking(true)?;
            Ok(listener)
        }

        pub(super) fn connect(listener: &TcpListener) -> Result<TcpStream> {
            let address: SocketAddr = listener.local_addr()?;
            let stream = TcpStream::connect_timeout(&address, IO_TIMEOUT)?;
            configure(&stream)?;
            Ok(stream)
        }

        pub(super) fn accept(listener: &TcpListener) -> io::Result<TcpStream> {
            let deadline = Instant::now() + IO_TIMEOUT;
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_read_timeout(Some(IO_TIMEOUT))?;
                        stream.set_write_timeout(Some(IO_TIMEOUT))?;
                        return Ok(stream);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "loopback fixture accept timed out",
                            ));
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
        }

        pub(super) fn assert_no_pending_connection(listener: &TcpListener) -> Result<()> {
            match listener.accept() {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
                Ok((stream, _)) => {
                    drop(stream);
                    anyhow::bail!("fixture observed a second connection")
                }
                Err(error) => Err(error.into()),
            }
        }

        fn configure(stream: &TcpStream) -> io::Result<()> {
            stream.set_read_timeout(Some(IO_TIMEOUT))?;
            stream.set_write_timeout(Some(IO_TIMEOUT))
        }

        pub(super) fn send_request(stream: &mut TcpStream, body: &[u8]) -> Result<()> {
            ensure!(
                body.len() <= MAX_FRAME_BYTES,
                "test request exceeds fixture bound"
            );
            let length = u32::try_from(body.len())?.to_be_bytes();
            stream.write_all(&length)?;
            stream.write_all(body)?;
            Ok(())
        }

        pub(super) fn read_request(stream: &mut TcpStream) -> Result<Vec<u8>> {
            let mut header = [0; 4];
            stream.read_exact(&mut header)?;
            let length = usize::try_from(u32::from_be_bytes(header))?;
            ensure!(
                length <= MAX_FRAME_BYTES,
                "test request exceeds fixture bound"
            );
            let mut body = vec![0; length];
            stream.read_exact(&mut body)?;
            Ok(body)
        }

        pub(super) fn write_response(
            stream: &mut TcpStream,
            text: &[u8],
            thinking: &[u8],
            terminal: u8,
        ) -> Result<()> {
            write_output(stream, text, thinking)?;
            stream.write_all(&[TERMINAL, terminal])?;
            Ok(())
        }

        pub(super) fn write_output(
            stream: &mut TcpStream,
            text: &[u8],
            thinking: &[u8],
        ) -> Result<()> {
            ensure!(
                text.len() <= MAX_FRAME_BYTES && thinking.len() <= MAX_FRAME_BYTES - text.len(),
                "test response exceeds fixture bound"
            );
            for index in 0..text.len().max(thinking.len()) {
                if let Some(byte) = text.get(index) {
                    write_data_frame(stream, TEXT, std::slice::from_ref(byte))?;
                }
                if let Some(byte) = thinking.get(index) {
                    write_data_frame(stream, THINKING, std::slice::from_ref(byte))?;
                }
            }
            Ok(())
        }

        fn write_data_frame(stream: &mut TcpStream, channel: u8, bytes: &[u8]) -> Result<()> {
            ensure!(
                bytes.len() <= MAX_FRAME_BYTES,
                "test response exceeds fixture bound"
            );
            stream.write_all(&[channel])?;
            stream.write_all(&u32::try_from(bytes.len())?.to_be_bytes())?;
            stream.write_all(bytes)?;
            Ok(())
        }

        pub(super) fn read_response(stream: &mut TcpStream) -> Result<Response> {
            let mut observer = OutputObserver::new();
            let mut text = Vec::new();
            let mut thinking = Vec::new();
            let mut total_bytes = 0;
            let mut saw_terminal = false;
            let mut completion = Completion::UnexpectedEof;
            while let Some(tag) = read_tag(stream)? {
                match tag {
                    TEXT | THINKING => {
                        ensure!(!saw_terminal, "fixture data after terminal");
                        let bytes = read_data_frame(stream)?;
                        ensure!(
                            bytes.len() <= MAX_FRAME_BYTES - total_bytes,
                            "test response exceeds fixture bound"
                        );
                        total_bytes += bytes.len();
                        let (channel, destination) = if tag == TEXT {
                            (OutputChannel::Text, &mut text)
                        } else {
                            (OutputChannel::Thinking, &mut thinking)
                        };
                        destination.extend_from_slice(&bytes);
                        // Frames deliberately split every UTF-8 scalar into
                        // one-byte events; the observer receives the exact raw
                        // bytes without decoding or normalization.
                        let _ = observer.observe(channel, &bytes);
                    }
                    TERMINAL => {
                        ensure!(!saw_terminal, "fixture duplicate terminal");
                        let mut status = [0; 1];
                        stream.read_exact(&mut status)?;
                        let (provider_terminal, parsed_completion) = match status[0] {
                            COMPLETE => (ProviderTerminal::Complete, Completion::Parsed),
                            LENGTH_LIMIT => (ProviderTerminal::LengthLimit, Completion::Truncated),
                            INELIGIBLE => (ProviderTerminal::Ineligible, Completion::ParseFailure),
                            _ => anyhow::bail!("fixture sent unknown terminal"),
                        };
                        let _ = observer.observe_terminal(provider_terminal);
                        completion = parsed_completion;
                        saw_terminal = true;
                    }
                    _ => anyhow::bail!("fixture sent unknown frame"),
                }
            }
            Ok(Response {
                observation: observer.finish(completion),
                text,
                thinking,
                saw_terminal,
                // Successful return is only possible after `read_tag` saw
                // EOF, so record the observed close explicitly.
                peer_closed: true,
            })
        }

        fn read_tag(stream: &mut TcpStream) -> io::Result<Option<u8>> {
            let mut tag = [0; 1];
            loop {
                match stream.read(&mut tag) {
                    Ok(0) => return Ok(None),
                    Ok(_) => return Ok(Some(tag[0])),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
        }

        fn read_data_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
            let mut header = [0; 4];
            stream.read_exact(&mut header)?;
            let length = usize::try_from(u32::from_be_bytes(header))?;
            ensure!(
                length <= MAX_FRAME_BYTES,
                "test response exceeds fixture bound"
            );
            let mut bytes = vec![0; length];
            stream.read_exact(&mut bytes)?;
            Ok(bytes)
        }

        pub(super) fn wait_for_peer_close(stream: &mut TcpStream) -> io::Result<()> {
            let mut byte = [0; 1];
            loop {
                match stream.read(&mut byte) {
                    Ok(0) => return Ok(()),
                    Ok(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "unexpected bytes after fixed request",
                        ));
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
        }
    }

    const BUDGET: ReadBudget = ReadBudget {
        max_references: 8,
        max_reference_bytes: 4096,
    };

    struct Fixture {
        root: std::path::PathBuf,
        owner: Arc<GenerationClaimOwner>,
        finalized: FinalizedAttempt,
        attempt: StoredAttempt,
    }

    fn final_request(owner: &GenerationClaimOwner, payload: Value) -> FinalDispatchRequest {
        let now = now_ms().expect("clock");
        let digest = canonical_json_digest(&serde_json::json!("fixture")).expect("digest");
        FinalDispatchRequest {
            project_id: "project-1".into(),
            route_revision: owner.route_revision.clone(),
            purpose: GenerationPurpose::Writing,
            scope_digest: digest.clone(),
            material_digest: digest.clone(),
            d1_digest: digest.clone(),
            provider: "test-recorder".into(),
            model: "test".into(),
            api: "internal-test".into(),
            endpoint_identity: digest,
            payload,
            inputs: vec![],
            qualifications: vec![],
            created_at_ms: now,
            expires_at_ms: now + 60_000,
            budget: BUDGET,
        }
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("nir1-dispatch-owner-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
            std::fs::write(
                root.join(".grimodex/workspace.json"),
                r#"{"id":"workspace-1"}"#,
            )
            .expect("workspace metadata");
            let backend =
                crate::Backend::new(root.join("app").to_string_lossy().into_owned(), None, None)
                    .expect("actual Native backend");
            let state = Arc::clone(&backend.state);
            let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
            db.migrate().expect("database schema");
            db.with_conn(|conn| {
                conn.execute_batch("INSERT INTO projects(id,title) VALUES ('project-1','Fixture');
                    INSERT INTO chat_sessions(id,project_id,title) VALUES ('session-1','project-1','Fixture');")?;
                Ok(())
            }).expect("existing stores");
            let authority =
                WorkspaceAuthority::from_database_for_test(db, root.clone()).expect("authority");
            let live = LiveBinding::new(
                root.to_string_lossy(),
                "workspace-1",
                authority.identity(),
                1,
            );
            *state.ws.inner.lock().expect("workspace") = Some(ActiveWorkspace::new(authority));
            state.ws.lifecycle_core().set_ready(live).expect("ready");
            let status = state
                .profile_egress
                .activate_first_restricted_publication(true)
                .expect("restriction");
            state
                .profile_egress
                .bind_workspace(Some(root.to_string_lossy().into_owned()));
            let caller = CallerIdentity {
                profile_id: status.profile_id,
                caller_id: "main-issued".into(),
                caller_epoch: status.caller_epoch,
                sender_id: 1,
                workspace_id: Some(root.to_string_lossy().into_owned()),
                session_id: "session-1".into(),
            };
            state
                .profile_egress
                .register_caller(&caller)
                .expect("registered main caller");
            let owner =
                Arc::new(GenerationClaimOwner::capture(state, caller).expect("capture owner"));
            let finalized = owner
                .persist_final_request(final_request(
                    &owner,
                    serde_json::json!({"messages":[],"fixture":true}),
                ))
                .expect("durable attempt before claim");
            let attempt = storage::read_attempt(owner.db.db(), &finalized.snapshot.id, BUDGET)
                .expect("reread durable attempt");
            Self {
                root,
                owner,
                finalized,
                attempt,
            }
        }

        fn record(&self, recorder: &AtomicUsize) -> Result<bool> {
            record(&self.owner, &self.finalized, recorder)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn record(
        owner: &GenerationClaimOwner,
        finalized: &FinalizedAttempt,
        recorder: &AtomicUsize,
    ) -> Result<bool> {
        let claimed = owner.consume_finalized_claim(finalized, BUDGET)?;
        if claimed {
            // Recorder is synchronous and has no worker to cancel/join. These
            // acquisitions prove no DB/core/profile guard spans transport.
            assert!(owner.cancellation.try_lock().is_ok());
            owner.db.db().with_conn(|_| Ok(()))?;
            owner.state.profile_egress.status();
            owner.state.ws.lifecycle_core().snapshot()?;
            recorder.fetch_add(1, Ordering::SeqCst);
        }
        Ok(claimed)
    }

    fn assert_transport_guards_released(owner: &GenerationClaimOwner) -> Result<()> {
        assert!(owner.cancellation.try_lock().is_ok());
        owner.db.db().with_conn(|_| Ok(()))?;
        owner.state.profile_egress.status();
        owner.state.ws.lifecycle_core().snapshot()?;
        Ok(())
    }

    #[test]
    fn cancel_after_claim_before_test_start_sends_no_request_body() {
        let fixture = Fixture::new();
        let listener = loopback::listener().expect("loopback listener");
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();

        std::thread::scope(|scope| -> Result<()> {
            let peer = scope.spawn(|| -> Result<()> {
                let mut stream = loopback::accept(&listener)?;
                let mut first_byte = [0; 1];
                let read = stream.read(&mut first_byte)?;
                closed_tx.send(read).expect("peer close observation");
                Ok(())
            });

            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            fixture.owner.cancel()?;
            assert_transport_guards_released(&fixture.owner)?;
            let client = loopback::connect(&listener)?;
            assert!(!fixture.owner.begin_test_transport(&client)?);
            drop(client);
            assert_eq!(
                closed_rx.recv_timeout(loopback::IO_TIMEOUT)?,
                0,
                "peer observed close before receiving a request byte"
            );
            peer.join().expect("peer thread")?;
            let cancelled = OutputObserver::new().finish(Completion::Cancelled);
            let terminal =
                fixture
                    .owner
                    .persist_terminal(&fixture.finalized, &cancelled, None, now_ms()?)?;
            assert!(terminal.message_version.is_none());
            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)
                .is_err());
            Ok(())
        })
        .expect("bounded pre-start fixture");

        let attempt = storage::read_attempt(
            fixture.owner.db.db(),
            &fixture.finalized.snapshot.id,
            BUDGET,
        )
        .expect("terminalized attempt");
        assert!(attempt.claimed_at_ms.is_some());
        assert!(attempt.terminal.is_some());
        assert!(
            storage::pending_attempt_ids(fixture.owner.db.db(), "project-1", None, 8)
                .expect("cancelled attempt is not pending")
                .is_empty()
        );
    }

    #[test]
    fn loopback_observation_commits_exact_body_version_and_receipt_once() {
        let fixture = Fixture::new();
        let listener = loopback::listener().expect("loopback listener");
        let expected_payload = fixture.finalized.canonical_payload.clone();
        let text = "  本文 e\u{301}🙂\n";
        let thinking = " 推敲中🙂 \n";
        let expected_text = text.as_bytes().to_vec();
        let expected_thinking = thinking.as_bytes().to_vec();

        std::thread::scope(|scope| -> Result<()> {
            let peer = scope.spawn(|| -> Result<()> {
                let mut stream = loopback::accept(&listener)?;
                assert_eq!(
                    loopback::read_request(&mut stream)?,
                    expected_payload.as_bytes(),
                    "loopback body is the exact canonical payload"
                );
                loopback::write_response(&mut stream, &expected_text, &expected_thinking, 1)?;
                Ok(())
            });

            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            assert!(!fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            assert_transport_guards_released(&fixture.owner)?;

            let mut client = loopback::connect(&listener)?;
            assert!(fixture.owner.begin_test_transport(&client)?);
            loopback::send_request(&mut client, expected_payload.as_bytes())?;
            let response = loopback::read_response(&mut client)?;
            fixture.owner.finish_test_transport()?;
            peer.join().expect("peer thread")?;
            loopback::assert_no_pending_connection(&listener)?;

            assert!(response.saw_terminal);
            assert!(response.peer_closed);
            assert_eq!(response.text, expected_text);
            assert_eq!(response.thinking, expected_thinking);
            assert_eq!(
                response.observation.provider_terminal,
                Some(ProviderTerminal::Complete)
            );
            assert_eq!(
                response.observation.terminal_status,
                TerminalStatus::Succeeded
            );
            assert_eq!(response.observation.parse_status, ParseStatus::Parsed);
            assert!(response.observation.response_digest.is_some());

            let body = NewMessageBody {
                message_id: "loopback-generated-output".into(),
                content: String::from_utf8(response.text).expect("strict text UTF-8"),
                thinking: String::from_utf8(response.thinking).expect("strict thinking UTF-8"),
            };
            let message_id = body.message_id.clone();
            fixture.owner.db.db().with_conn(|conn| {
                conn.execute_batch(
                    "CREATE TEMP TRIGGER fail_native_generation_terminal
                     BEFORE UPDATE OF terminal_json ON nir1_generation_attempts
                     WHEN NEW.terminal_json IS NOT NULL
                     BEGIN SELECT RAISE(ABORT, 'injected native terminal failure'); END;",
                )?;
                Ok(())
            })?;
            assert!(fixture
                .owner
                .persist_terminal(
                    &fixture.finalized,
                    &response.observation,
                    Some(body.clone()),
                    now_ms()?,
                )
                .is_err());
            fixture.owner.db.db().with_conn(|conn| {
                let body_count: i64 = conn.query_row(
                    "SELECT count(*) FROM chat_messages WHERE id=?1",
                    [&message_id],
                    |row| row.get(0),
                )?;
                let version_count: i64 = conn.query_row(
                    "SELECT count(*) FROM nir1_generation_message_versions WHERE message_id=?1",
                    [&message_id],
                    |row| row.get(0),
                )?;
                assert_eq!(body_count, 0);
                assert_eq!(version_count, 0);
                conn.execute_batch("DROP TRIGGER fail_native_generation_terminal")?;
                Ok(())
            })?;
            assert!(
                storage::read_terminal(fixture.owner.db.db(), &fixture.finalized.snapshot.id)?
                    .is_none()
            );

            let terminal = fixture.owner.persist_terminal(
                &fixture.finalized,
                &response.observation,
                Some(body),
                now_ms()?,
            )?;
            let version = terminal
                .message_version
                .as_ref()
                .expect("success binds immutable body version");
            assert_eq!(version.message_id, message_id);
            assert_eq!(
                version.parent_attempt_id.as_deref(),
                Some(fixture.finalized.snapshot.id.as_str())
            );
            assert_eq!(
                &storage::read_message_version(fixture.owner.db.db(), &version.id)?,
                version
            );
            assert_eq!(
                storage::read_terminal(fixture.owner.db.db(), &fixture.finalized.snapshot.id)?,
                Some(terminal.clone())
            );
            fixture.owner.db.db().with_conn(|conn| {
                let (saved_text, metadata): (String, Option<String>) = conn.query_row(
                    "SELECT content,metadata FROM chat_messages WHERE id=?1",
                    [&message_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(saved_text, text);
                let saved_thinking: Value =
                    serde_json::from_str(metadata.as_deref().expect("thinking metadata"))?;
                assert_eq!(saved_thinking["thinking_blocks"][0]["thinking"], thinking);
                Ok(())
            })?;
            Ok(())
        })
        .expect("bounded success fixture");

        assert!(
            storage::pending_attempt_ids(fixture.owner.db.db(), "project-1", None, 8)
                .expect("success terminal removes pending attempt")
                .is_empty()
        );
    }

    #[test]
    fn loopback_invalid_utf8_never_publishes_a_body_even_with_terminal() {
        let fixture = Fixture::new();
        let listener = loopback::listener().expect("loopback listener");
        let expected_payload = fixture.finalized.canonical_payload.clone();
        let text = vec![0xf0, 0x28, 0x8c, 0x28];
        let thinking = vec![0xf0, 0x28, 0x8c, 0x28];

        std::thread::scope(|scope| -> Result<()> {
            let peer = scope.spawn(|| -> Result<()> {
                let mut stream = loopback::accept(&listener)?;
                assert_eq!(
                    loopback::read_request(&mut stream)?,
                    expected_payload.as_bytes()
                );
                loopback::write_response(&mut stream, &text, &thinking, 1)?;
                Ok(())
            });

            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            assert_transport_guards_released(&fixture.owner)?;
            let mut client = loopback::connect(&listener)?;
            assert!(fixture.owner.begin_test_transport(&client)?);
            loopback::send_request(&mut client, expected_payload.as_bytes())?;
            let response = loopback::read_response(&mut client)?;
            fixture.owner.finish_test_transport()?;
            peer.join().expect("peer thread")?;
            loopback::assert_no_pending_connection(&listener)?;

            assert!(response.saw_terminal);
            assert!(response.peer_closed);
            assert_eq!(
                response.observation.provider_terminal,
                Some(ProviderTerminal::Complete)
            );
            assert_eq!(response.observation.terminal_status, TerminalStatus::Failed);
            assert_eq!(response.observation.parse_status, ParseStatus::Invalid);
            assert!(response.observation.response_digest.is_some());
            assert!(String::from_utf8(response.text).is_err());
            assert!(String::from_utf8(response.thinking).is_err());

            let terminal = fixture.owner.persist_terminal(
                &fixture.finalized,
                &response.observation,
                None,
                now_ms()?,
            )?;
            assert!(terminal.message_version.is_none());
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::InvalidOutput)
            );
            assert!(!fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            Ok(())
        })
        .expect("bounded invalid-output fixture");
        assert!(
            storage::pending_attempt_ids(fixture.owner.db.db(), "project-1", None, 8)
                .expect("invalid terminal removes pending attempt")
                .is_empty()
        );
    }

    #[test]
    fn loopback_eof_without_provider_terminal_never_publishes_a_body() {
        let fixture = Fixture::new();
        let listener = loopback::listener().expect("loopback listener");
        let expected_payload = fixture.finalized.canonical_payload.clone();
        let text = b"valid text".to_vec();
        let thinking = b"valid thinking".to_vec();

        std::thread::scope(|scope| -> Result<()> {
            let peer = scope.spawn(|| -> Result<()> {
                let mut stream = loopback::accept(&listener)?;
                assert_eq!(
                    loopback::read_request(&mut stream)?,
                    expected_payload.as_bytes()
                );
                loopback::write_output(&mut stream, &text, &thinking)?;
                Ok(())
            });

            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            assert_transport_guards_released(&fixture.owner)?;
            let mut client = loopback::connect(&listener)?;
            assert!(fixture.owner.begin_test_transport(&client)?);
            loopback::send_request(&mut client, expected_payload.as_bytes())?;
            let response = loopback::read_response(&mut client)?;
            fixture.owner.finish_test_transport()?;
            peer.join().expect("peer thread")?;
            loopback::assert_no_pending_connection(&listener)?;

            assert!(!response.saw_terminal);
            assert!(response.peer_closed);
            assert_eq!(response.observation.provider_terminal, None);
            assert_eq!(response.observation.terminal_status, TerminalStatus::Failed);
            assert_eq!(response.observation.parse_status, ParseStatus::Invalid);
            assert!(response.observation.response_digest.is_some());
            assert_eq!(response.text, text);
            assert_eq!(response.thinking, thinking);

            let terminal = fixture.owner.persist_terminal(
                &fixture.finalized,
                &response.observation,
                None,
                now_ms()?,
            )?;
            assert!(terminal.message_version.is_none());
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::InvalidOutput)
            );
            assert!(!fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            Ok(())
        })
        .expect("bounded missing-terminal fixture");
        assert!(
            storage::pending_attempt_ids(fixture.owner.db.db(), "project-1", None, 8)
                .expect("missing-terminal failure removes pending attempt")
                .is_empty()
        );
    }

    #[test]
    fn cancellation_after_claim_closes_peer_and_never_reuses_old_attempt() {
        let fixture = Fixture::new();
        let listener = loopback::listener().expect("loopback listener");
        let expected_payload = fixture.finalized.canonical_payload.clone();
        let (request_tx, request_rx) = std::sync::mpsc::channel();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        let accepted = AtomicUsize::new(0);

        std::thread::scope(|scope| -> Result<()> {
            let peer = scope.spawn(|| -> Result<()> {
                let mut stream = loopback::accept(&listener)?;
                accepted.fetch_add(1, Ordering::SeqCst);
                request_tx
                    .send(loopback::read_request(&mut stream)?)
                    .expect("send peer-observed request");
                loopback::wait_for_peer_close(&mut stream)?;
                closed_tx.send(()).expect("send peer-close observation");
                Ok(())
            });

            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            assert!(!fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)?);
            assert_transport_guards_released(&fixture.owner)?;
            let mut client = loopback::connect(&listener)?;
            assert!(fixture.owner.begin_test_transport(&client)?);
            loopback::send_request(&mut client, expected_payload.as_bytes())?;
            assert_eq!(
                request_rx.recv_timeout(loopback::IO_TIMEOUT)?,
                expected_payload.as_bytes(),
                "peer saw the exact body before cancellation"
            );

            fixture.owner.cancel()?;
            closed_rx.recv_timeout(loopback::IO_TIMEOUT)?;
            fixture.owner.finish_test_transport()?;
            peer.join().expect("peer thread")?;
            loopback::assert_no_pending_connection(&listener)?;

            let cancelled = OutputObserver::new().finish(Completion::Cancelled);
            let terminal =
                fixture
                    .owner
                    .persist_terminal(&fixture.finalized, &cancelled, None, now_ms()?)?;
            assert!(terminal.message_version.is_none());
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::Cancelled)
            );
            assert!(fixture
                .owner
                .consume_finalized_claim(&fixture.finalized, BUDGET)
                .is_err());
            Ok(())
        })
        .expect("bounded cancellation fixture");

        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        assert!(
            storage::pending_attempt_ids(fixture.owner.db.db(), "project-1", None, 8)
                .expect("cancelled terminal removes pending attempt")
                .is_empty()
        );
    }

    #[test]
    fn same_handle_concurrent_native_claim_calls_recorder_once() {
        let fixture = Fixture::new();
        let recorder = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let first = scope.spawn(|| fixture.record(&recorder));
            let second = scope.spawn(|| fixture.record(&recorder));
            let claimed = [
                first.join().expect("first").expect("first claim"),
                second.join().expect("second").expect("second claim"),
            ];
            assert_eq!(claimed.into_iter().filter(|value| *value).count(), 1);
        });
        assert_eq!(recorder.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn invalidation_before_claim_never_enters_recorder() {
        for invalidation in 0..4 {
            let fixture = Fixture::new();
            match invalidation {
                0 => fixture.owner.cancel().expect("cancel"),
                1 => fixture.owner.state.profile_egress.invalidate_callers(),
                2 => {
                    fixture
                        .owner
                        .state
                        .ws
                        .lifecycle_core()
                        .begin_transition(AdmissionKind::Open)
                        .expect("transition");
                }
                _ => fixture
                    .owner
                    .state
                    .profile_egress
                    .with_route_update(|| Ok(()))
                    .expect("route update"),
            }
            let recorder = AtomicUsize::new(0);
            assert!(fixture.record(&recorder).is_err());
            assert_eq!(recorder.load(Ordering::SeqCst), 0);
            assert!(
                storage::read_attempt(fixture.owner.db.db(), &fixture.attempt.id, BUDGET)
                    .expect("still pending")
                    .claimed_at_ms
                    .is_none()
            );
        }
    }

    #[test]
    fn pending_db_wait_can_be_cancelled_before_claim() {
        let fixture = Fixture::new();
        let recorder = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            fixture
                .owner
                .db
                .db()
                .with_conn(|_| {
                    let (tx, rx) = std::sync::mpsc::channel();
                    let fixture = &fixture;
                    let recorder = &recorder;
                    let worker = scope.spawn(move || {
                        tx.send(()).expect("announce pending worker");
                        fixture.record(recorder)
                    });
                    rx.recv_timeout(std::time::Duration::from_secs(5))
                        .expect("worker queued");
                    fixture.owner.cancel().expect("cancel does not wait on DB");
                    Ok(worker)
                })
                .expect("release DB before joining")
                .join()
                .expect("worker")
                .expect_err("cancel wins");
        });
        assert_eq!(recorder.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn committed_claim_is_never_reused_and_terminal_save_survives_closed_admissions() {
        let fixture = Fixture::new();
        let payload: Value =
            serde_json::from_str(&fixture.finalized.canonical_payload).expect("canonical payload");
        assert_eq!(
            canonical_json_string(&payload).expect("canonical payload bytes"),
            fixture.finalized.canonical_payload
        );
        assert_eq!(
            final_payload_digest(&payload).expect("payload digest"),
            fixture.finalized.snapshot.payload_digest
        );
        assert!(fixture
            .owner
            .consume_finalized_claim(&fixture.finalized, BUDGET)
            .expect("durable claim"));
        // Crash between claim and actual send is conservatively consumed.
        assert!(!fixture
            .owner
            .consume_finalized_claim(&fixture.finalized, BUDGET)
            .expect("no resend"));
        fixture
            .owner
            .state
            .profile_egress
            .begin_startup_barrier()
            .expect("profile stop");
        fixture
            .owner
            .state
            .ws
            .lifecycle_core()
            .request_shutdown()
            .expect("workspace stop");
        fixture
            .owner
            .persist_terminal(
                &fixture.finalized,
                &OutputObserver::new().finish(Completion::Cancelled),
                None,
                now_ms().expect("clock"),
            )
            .expect("existing owner terminal save");
        assert!(
            storage::read_terminal(fixture.owner.db.db(), &fixture.finalized.snapshot.id)
                .expect("terminal")
                .is_some()
        );
    }

    #[test]
    fn recovery_terminalizes_fixed_attempt_without_resend() {
        let fixture = Fixture::new();
        assert!(fixture
            .owner
            .consume_finalized_claim(&fixture.finalized, BUDGET)
            .expect("durable claim"));
        let terminal = fixture
            .owner
            .recover_terminal(&fixture.finalized, now_ms().expect("clock"))
            .expect("recover exact attempt");
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        assert_eq!(
            terminal.payload_digest,
            fixture.finalized.snapshot.payload_digest
        );
        assert!(!fixture
            .owner
            .consume_finalized_claim(&fixture.finalized, BUDGET)
            .expect("terminal blocks old handle"));
    }

    #[test]
    fn mutated_private_pairing_is_rejected_before_claim() {
        let fixture = Fixture::new();

        let mut tampered_payload = fixture.finalized.clone();
        tampered_payload.canonical_payload = r#"{"fixture":false,"messages":[]}"#.into();
        assert!(fixture
            .owner
            .consume_finalized_claim(&tampered_payload, BUDGET)
            .is_err());

        let mut tampered_inputs = fixture.finalized.clone();
        tampered_inputs.snapshot.input_digest =
            canonical_json_digest(&serde_json::json!("different-inputs")).expect("digest");
        assert!(fixture
            .owner
            .consume_finalized_claim(&tampered_inputs, BUDGET)
            .is_err());
        assert!(storage::read_attempt(
            fixture.owner.db.db(),
            &fixture.finalized.snapshot.id,
            BUDGET
        )
        .expect("unchanged attempt")
        .claimed_at_ms
        .is_none());
    }

    #[test]
    fn same_binding_attempt_swap_is_rejected_for_claim_and_terminal_paths() {
        let fixture = Fixture::new();
        let other = fixture
            .owner
            .persist_final_request(final_request(
                &fixture.owner,
                serde_json::json!({"messages":[],"fixture":false}),
            ))
            .expect("second same-binding attempt");

        let mut swapped = fixture.finalized.clone();
        swapped.snapshot.id = other.snapshot.id.clone();
        let observation = OutputObserver::new().finish(Completion::Cancelled);

        assert!(fixture
            .owner
            .consume_finalized_claim(&swapped, BUDGET)
            .is_err());
        assert!(fixture
            .owner
            .persist_terminal(&swapped, &observation, None, now_ms().expect("clock"))
            .is_err());
        assert!(fixture
            .owner
            .recover_terminal(&swapped, now_ms().expect("clock"))
            .is_err());
        let current = storage::read_attempt(fixture.owner.db.db(), &other.snapshot.id, BUDGET)
            .expect("other attempt");
        assert!(current.claimed_at_ms.is_none());
        assert!(current.terminal.is_none());
    }

    fn recovery_attempt(ordinal: usize) -> NewAttempt {
        recovery_attempt_for("recovery-project", "recovery-session", ordinal)
    }

    fn recovery_attempt_for(project_id: &str, session_id: &str, ordinal: usize) -> NewAttempt {
        let digest =
            canonical_json_digest(&json!(["recovery", project_id, ordinal])).expect("digest");
        NewAttempt {
            binding: AttemptBinding {
                project_id: project_id.into(),
                session_id: session_id.into(),
                profile_id: "recovery-profile".into(),
                caller_id: "recovery-owner".into(),
                caller_epoch: 1,
                workspace_binding_digest: digest.clone(),
                purpose: GenerationPurpose::Writing,
                scope_digest: digest.clone(),
                material_digest: digest.clone(),
                d1_digest: digest.clone(),
                route_revision: digest.clone(),
                provider: "recovery-recorder".into(),
                model: "recovery".into(),
                api: "internal".into(),
                endpoint_identity: digest.clone(),
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
        let attempts = (0..attempt_count)
            .map(|ordinal| storage::create_attempt(&db, recovery_attempt(ordinal)))
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
        let attempts = (0..attempts_on_first_project)
            .map(|ordinal| {
                storage::create_attempt(
                    &db,
                    recovery_attempt_for(&project_ids[0], "recovery-session-0000", ordinal),
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
            let mut request = recovery_attempt(0);
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
        ));
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
        ));
        // Model an A launcher paused after observing Ready A but before status
        // scheduling. It may not prune the already-scheduled Ready B entry.
        assert!(!schedule_generation_recovery(
            &state,
            &binding_a,
            ready_revision_a,
        ));
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
        run_generation_recovery_after_ready(
            Arc::clone(&state),
            binding_b.clone(),
            ready_revision_b,
        );
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
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
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
        let pending = storage::create_attempt(db.db(), recovery_attempt(1))
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
        drop(backend);
        drop(state);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn detached_recovery_call_returns_before_worker_finishes() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        detach_generation_recovery(move || {
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
    }
}
