//! Shared, synchronous lifecycle state for workspace operations.
//!
//! The core deliberately has no Tokio, N-API, SQLite, or renderer dependency.
//! Native owners may use the identifiers and permits here to supervise their
//! workers, while the existing `WorkspaceState::switching` flag is exposed as
//! a compatibility view over the same core storage.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use thiserror::Error;

pub const DELIVERY_CAPACITY: usize = 256;
pub const GENERAL_RESPONSIBILITY_CAPACITY: usize = 255;
pub const EMERGENCY_RESPONSIBILITY_CAPACITY: usize = 1;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(
            Clone,
            Copy,
            Debug,
            Default,
            Deserialize,
            Eq,
            Hash,
            Ord,
            PartialEq,
            Serialize,
            PartialOrd,
        )]
        #[serde(transparent)]
        pub struct $name(u64);

        impl $name {
            pub const fn new(value: u64) -> Self {
                Self(value)
            }

            pub const fn get(self) -> u64 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}", self.0)
            }
        }
    };
}

id_type!(OperationId);
id_type!(ExecutionId);
id_type!(WorkExecutionId);
id_type!(DeliverySequence);
id_type!(RecoveryDescriptorId);
id_type!(ControlGeneration);
id_type!(ResponsibilityId);

/// Reserved descriptor identity for durable Safe Mode state that predates a
/// process-local workspace operation. It never owns a Run or delivery slot.
pub const SAFE_MODE_RECOVERY_DESCRIPTOR_ID: RecoveryDescriptorId = RecoveryDescriptorId::new(0);

pub type StateRevision = u64;

/// Values-only failure evidence. Deliberately excludes bindings, locators,
/// user identities, Run payloads and error text.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticLifecycleState {
    NoWorkspace,
    Ready,
    Transition,
    RecoveryRequired,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleDiagnostic {
    pub revision: StateRevision,
    pub state: DiagnosticLifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_state: Option<DiagnosticLifecycleState>,
    /// The authority lookup's actual compatibility predicate, read after
    /// its locked snapshot; this is not an atomic core-state observation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_switching: Option<bool>,
    pub shutdown_requested: bool,
    pub descriptor_id: Option<RecoveryDescriptorId>,
    pub owner: Option<RecoveryDescriptorOwner>,
    pub root_operation_id: Option<OperationId>,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveBinding {
    /// The canonical workspace locator captured at admission time.
    pub locator: Arc<str>,
    /// Durable workspace identity. A path or display name is not sufficient.
    pub workspace_id: Arc<str>,
    /// Process-local authority instance. Reopening the same file creates a new
    /// value, so a reopened authority is never an `Unchanged` binding.
    pub authority_instance: u64,
    /// Monotonic generation for restore/recovery handoff.
    pub recovery_generation: u64,
    /// Native-only identity of the opened main DB; never part of the wire shape.
    #[serde(skip)]
    database_file_identity: Option<Arc<str>>,
}

impl fmt::Debug for LiveBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LiveBinding")
            .field("locator", &self.locator)
            .field("workspace_id", &self.workspace_id)
            .field("authority_instance", &self.authority_instance)
            .field("recovery_generation", &self.recovery_generation)
            .finish()
    }
}

fn same_binding_identity(left: &LiveBinding, right: &LiveBinding) -> bool {
    left.locator == right.locator
        && left.workspace_id == right.workspace_id
        && left.authority_instance == right.authority_instance
        && left.database_file_identity == right.database_file_identity
}

impl LiveBinding {
    pub fn new(
        locator: impl Into<String>,
        workspace_id: impl Into<String>,
        authority_instance: u64,
        recovery_generation: u64,
    ) -> Self {
        Self {
            locator: Arc::<str>::from(locator.into()),
            workspace_id: Arc::<str>::from(workspace_id.into()),
            authority_instance,
            recovery_generation,
            database_file_identity: None,
        }
    }

    /// Attach Native-only main-DB identity without changing serialized bindings.
    #[doc(hidden)]
    pub fn with_main_database_file_identity(mut self, identity: String) -> Self {
        self.database_file_identity = Some(Arc::from(identity));
        self
    }

    /// Test whether this internal binding came from the supplied opened DB file.
    #[doc(hidden)]
    pub fn matches_main_database_file_identity(&self, identity: &str) -> bool {
        self.database_file_identity.as_deref() == Some(identity)
    }

    /// Whether both internal bindings identify the same opened main DB file.
    #[doc(hidden)]
    pub fn same_main_database_file(&self, other: &Self) -> bool {
        matches!(
            (
                self.database_file_identity.as_deref(),
                other.database_file_identity.as_deref()
            ),
            (Some(left), Some(right)) if left == right
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum TransitionStage {
    Draining,
    Replacing,
    Recovering,
    Finishing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum LifecycleState {
    NoWorkspace,
    Ready(LiveBinding),
    Transition {
        operation_id: OperationId,
        stage: TransitionStage,
    },
    RecoveryRequired {
        descriptor_id: RecoveryDescriptorId,
    },
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LifecycleSnapshot {
    pub state: LifecycleState,
    pub revision: StateRevision,
}

impl LifecycleSnapshot {
    fn new(state: LifecycleState, revision: StateRevision) -> Self {
        Self { state, revision }
    }

    pub fn binding(&self) -> Option<&LiveBinding> {
        match &self.state {
            LifecycleState::Ready(binding) => Some(binding),
            LifecycleState::NoWorkspace
            | LifecycleState::Transition { .. }
            | LifecycleState::RecoveryRequired { .. }
            | LifecycleState::Closed => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AdmissionKind {
    Open,
    Restore,
    /// A foreground write/eligibility transaction. It participates in the
    /// shared lifecycle drain membership, while retaining its own foreground
    /// execution slot so maintenance cannot reject user work before the
    /// existing foreground-priority/SQLite wait policy runs.
    Foreground,
    Maintenance,
    Recover,
    Snapshot,
    Shutdown,
}

impl AdmissionKind {
    fn is_transition(self) -> bool {
        matches!(self, Self::Open | Self::Restore | Self::Recover)
    }

    fn is_capacity_independent(self) -> bool {
        matches!(self, Self::Snapshot | Self::Shutdown | Self::Recover)
    }

    #[allow(dead_code)]
    fn is_foreground_execution(self) -> bool {
        matches!(self, Self::Foreground)
    }

    fn is_maintenance_execution(self) -> bool {
        matches!(self, Self::Maintenance)
    }

    fn responsibility_kind(self) -> Option<ResponsibilityKind> {
        match self {
            Self::Open | Self::Restore => Some(ResponsibilityKind::WorkspaceOperation),
            Self::Maintenance => Some(ResponsibilityKind::ExactRun),
            Self::Foreground => None,
            // A descriptor-bound recovery reuses the responsibility cell that
            // is already owned by its root.  Reserving a fresh emergency cell
            // for every retry makes a failed recovery permanently block its
            // own retry path.  A recovery may request an emergency cell only
            // when it creates an independent continuation, through the
            // explicit reservation API below.
            Self::Recover => None,
            Self::Snapshot | Self::Shutdown => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AdmissionRejection {
    NoWorkspace,
    /// A transition cannot overtake a live non-transition execution owner.
    ActiveOperation,
    Transition,
    RecoveryRequired,
    Closed,
    Capacity,
    RecoveryPrerequisite,
    OutOfOrder,
    Conflict,
    Retired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdmissionTicket {
    pub operation_id: OperationId,
    pub kind: AdmissionKind,
    pub admitted_revision: StateRevision,
    pub original_binding: Option<LiveBinding>,
    /// A Recover ticket is valid only when it names the descriptor root that
    /// supplied its control slot.  Ordinary admissions leave this unset.
    pub recovery_descriptor_id: Option<RecoveryDescriptorId>,
    /// Reserved before the worker or protected I/O starts. The reservation
    /// is released only by the matching terminal/descriptor handoff path.
    pub responsibility: Option<ResponsibilityReservation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AdmissionOutcome {
    Admitted(AdmissionTicket),
    /// This proves only that this request did not start. It never grants a
    /// renderer permission to resume an old binding.
    NotAdmitted {
        reason: AdmissionRejection,
        snapshot: LifecycleSnapshot,
    },
}

/// Typed result used by the permit helpers below.  The rejection snapshot is
/// retained so callers cannot turn a failed admission into an old-binding
/// resume instruction.
pub enum PermitAdmission<P> {
    Admitted(P),
    NotAdmitted {
        reason: AdmissionRejection,
        snapshot: LifecycleSnapshot,
    },
}

/// A non-transition maintenance admission. It owns only the logical ticket;
/// worker handles and DB/file I/O remain Native-owned.
#[must_use]
pub struct MaintenancePermit {
    core: WorkspaceLifecycleCore,
    ticket: AdmissionTicket,
    execution_id: ExecutionId,
    released: bool,
    joined: bool,
    scope_finalizer: bool,
}

/// Logical workspace transition permit. Physical exclusion is represented by
/// a separate `WorkspaceExclusive` marker and is acquired by the Native
/// owner around the protected blocking worker.
#[must_use]
pub struct WorkspaceTransitionPermit {
    core: WorkspaceLifecycleCore,
    ticket: AdmissionTicket,
}

/// Marker for the physical I/O exclusion interval. The actual mutex/file
/// lease is deliberately outside the shared synchronous core; this token
/// carries the operation identity into code that performs that work.
#[must_use]
pub struct WorkspaceExclusive {
    core: WorkspaceLifecycleCore,
    operation_id: OperationId,
}

/// A short-lived participant for any DB operation that has already pinned an
/// authority. It is intentionally independent from the foreground and
/// maintenance execution slots: it only prevents transition activation and
/// shutdown from claiming terminal proof while the operation is still using
/// its connection.
#[derive(Clone)]
pub struct WorkspaceParticipant {
    #[allow(dead_code)]
    lease: Arc<WorkspaceParticipantLease>,
}

struct WorkspaceParticipantLease {
    core: WorkspaceLifecycleCore,
    released: AtomicBool,
}

/// Process-local fence for one cleanup-unproved C-query. Dropping it reopens
/// admission, so production detachment deliberately keeps it process-lifetime;
/// only a future owner with exit+EOF+reader-join proof may release it.
#[must_use]
pub(crate) struct WorkspaceQuarantineFence {
    core: WorkspaceLifecycleCore,
    binding: Arc<LiveBinding>,
}

impl Drop for WorkspaceQuarantineFence {
    fn drop(&mut self) {
        self.core.release_c_query_quarantine(&self.binding);
    }
}

impl WorkspaceParticipant {
    /// Atomically replace this unique participant with a process-local C-query
    /// quarantine fence. The caller transfers child/storage ownership together.
    pub(crate) fn detach_c_query_quarantine(
        &self,
        binding: &LiveBinding,
    ) -> Option<WorkspaceQuarantineFence> {
        self.lease.core.detach_c_query_quarantine(self, binding)
    }

    /// Transfer this exact participant as the fail-closed drain barrier after
    /// its owner drops the authority pin. The check and every
    /// physical-exclusive admission use the same lifecycle mutex; refusal
    /// returns the unchanged participant to its caller.
    pub(crate) fn try_retain_for_c_query_fallback(self) -> Result<Self, Self> {
        let safe_to_retain = {
            let Ok(state) = self.lease.core.lock_state() else {
                return Err(self);
            };
            !self.lease.released.load(Ordering::Acquire)
                && state.workspace_participants > 0
                && state.physical_exclusive_operations.is_empty()
                && state.c_query_quarantine.is_none()
        };
        if safe_to_retain {
            Ok(self)
        } else {
            Err(self)
        }
    }

    /// Keep the exact current authority stable through a short final claim.
    ///
    /// The caller must acquire its DB connection before entering this guard.
    /// Its closure must not reacquire lifecycle state, admit nested work, or
    /// run SQL with a participant progress hook (that hook calls this core).
    /// Include the durable COMMIT in the closure and release before transport.
    /// This does not admit work or confer any model/publication permission.
    pub fn with_current_binding<T>(
        &self,
        expected: &LiveBinding,
        operation: impl FnOnce() -> T,
    ) -> Result<T, LifecycleError> {
        let state = self.lease.core.lock_state()?;
        if state.shutdown_requested || matches!(state.state, LifecycleState::Closed) {
            return Err(LifecycleError::Closed);
        }
        if self
            .lease
            .core
            .inner
            .compatibility_switching
            .load(Ordering::SeqCst)
            || !matches!(&state.state, LifecycleState::Ready(current) if current == expected)
        {
            return Err(LifecycleError::InvalidState);
        }
        if quarantines_workspace(&state, expected) {
            return Err(LifecycleError::ActiveOperations);
        }
        Ok(operation())
    }

    /// Observe the existing owner's stop state without admitting nested work
    /// or acquiring the workspace/DB locks held by its caller.
    pub fn stop_requested(&self) -> Result<bool, LifecycleError> {
        let state = self.lease.core.lock_state()?;
        Ok(state.shutdown_requested
            || self
                .lease
                .core
                .inner
                .compatibility_switching
                .load(Ordering::SeqCst)
            || matches!(
                state.state,
                LifecycleState::Transition { .. }
                    | LifecycleState::RecoveryRequired { .. }
                    | LifecycleState::Closed
            ))
    }
}

/// Work-scoped publication marker. It prevents a broad transition permit from
/// being mistaken for a final per-work commit grant.
#[must_use]
pub struct PublicationPermit {
    core: WorkspaceLifecycleCore,
    operation_id: OperationId,
    work_execution_id: WorkExecutionId,
    completed: bool,
}

impl MaintenancePermit {
    pub fn operation_id(&self) -> OperationId {
        self.ticket.operation_id
    }

    pub fn ticket(&self) -> &AdmissionTicket {
        &self.ticket
    }

    pub fn execution_id(&self) -> ExecutionId {
        self.execution_id
    }

    pub fn start(&mut self) -> Result<(), LifecycleError> {
        self.core.start_execution(self.execution_id)
    }

    /// Retire a permit whose worker never entered its body.  `start` can
    /// reject after shutdown/stop has marked the pending execution; dropping
    /// that permit would leave a Reserved/StopRequested owner indefinitely.
    /// This path is valid only before Join and never fabricates a body result.
    pub fn cancel_before_start(mut self) -> Result<bool, LifecycleError> {
        let result = self.core.cancel_unstarted_execution(self.execution_id);
        if result.is_ok() {
            self.released = true;
        }
        result
    }

    /// In-place counterpart for a supervisor lease that must retain the
    /// permit until it can publish the rejected pending-start result.  This
    /// avoids consuming the only handle before the async supervisor has
    /// observed the worker boundary.
    pub fn cancel_before_start_in_place(&mut self) -> Result<bool, LifecycleError> {
        let result = self.core.cancel_unstarted_execution(self.execution_id);
        if result.is_ok() {
            self.released = true;
        }
        result
    }

    pub fn stop_requested(&self) -> Result<bool, LifecycleError> {
        self.core.execution_stop_requested(self.execution_id)
    }

    /// Attach the exact durable Run/Task/Attempt tuple after the writer has
    /// selected fresh versus reuse. The slot is immutable for this execution,
    /// so a late or conflicting tuple cannot replace ownership.
    pub fn attach_run_ownership(&self, run: RunOwnership) -> Result<(), LifecycleError> {
        self.core.attach_run_ownership(self.execution_id, run)
    }

    /// Mark the exact reserved tuple as having entered its creation DML. The
    /// outer transaction has already begun, so a later rollback cannot be
    /// treated as a pre-transaction reservation.
    pub fn mark_run_creation_started(&self, run_id: &str) -> Result<(), LifecycleError> {
        self.core
            .mark_run_creation_started(self.execution_id, run_id)
    }

    /// Keep a reuse selection as an explicit unresolved obligation until the
    /// existing durable tuple has been attached. A missing reservation ID is
    /// never evidence that the selected reusable Run did not exist.
    pub fn mark_run_reuse_selection_unknown(
        &self,
        reservation_run_id: &str,
        selected_run_id: &str,
    ) -> Result<(), LifecycleError> {
        self.core.mark_run_reuse_selection_unknown(
            self.execution_id,
            reservation_run_id,
            selected_run_id,
        )
    }

    /// Record the outer transaction's rollback/commit boundary for one exact
    /// reserved tuple.
    pub fn mark_run_creation_outcome(
        &self,
        run_id: &str,
        outcome: RunCreationTransactionOutcome,
    ) -> Result<(), LifecycleError> {
        self.core
            .mark_run_creation_outcome(self.execution_id, run_id, outcome)
    }

    /// Remove one exact Run ownership slot after its durable terminal
    /// transaction has committed.  This is the lifecycle proof that permits
    /// a failed maintenance operation to release normally; a healthy SQLite
    /// connection alone does not prove that a running Run was finalized.
    pub fn mark_run_terminalized(&self, run_id: &str) -> Result<(), LifecycleError> {
        self.core
            .mark_run_terminalized(self.execution_id, run_id)
    }

    /// Whether this execution still owns an unresolved exact Run tuple.
    /// Connection health cannot replace this durable-terminalization proof.
    pub fn has_run_ownership(&self) -> Result<bool, LifecycleError> {
        self.core.has_run_ownership(self.execution_id)
    }

    /// Record the supervisor-owned retirement receipt for every exact Run
    /// tuple attached to this execution. Join proves execution termination;
    /// this separate receipt proves the old connection cannot later commit.
    pub fn mark_connection_retired(&self) -> Result<(), LifecycleError> {
        self.core
            .mark_execution_connection_retired(self.execution_id)
    }

    pub fn release(mut self) -> Result<bool, LifecycleError> {
        if !self.joined {
            return Err(LifecycleError::NotJoined(self.ticket.operation_id));
        }
        self.core.complete_execution(self.execution_id)?;
        let result = self.core.release_admission(&self.ticket);
        self.released = true;
        result
    }

    /// Consume the Native permit by moving its exact execution/run
    /// responsibility to a shared recovery descriptor. This is used only
    /// after the worker has joined and cleanup cannot prove a normal release.
    pub fn transfer_to_recovery(self) -> Result<RecoveryDescriptorId, LifecycleError> {
        self.transfer_to_recovery_diagnosed(|_| {})
    }

    /// Evidence is captured at the transfer boundary, before another owner
    /// can advance the revision; the callback runs after the core unlocks.
    pub fn transfer_to_recovery_diagnosed(
        mut self,
        on_handoff: impl FnOnce(LifecycleDiagnostic),
    ) -> Result<RecoveryDescriptorId, LifecycleError> {
        // A recovery handoff is only legal after the supervisor has observed
        // the worker Join. The permit API deliberately does not fabricate
        // that boundary for a dropped/panicking worker.
        if !self.joined {
            return Err(LifecycleError::NotJoined(self.ticket.operation_id));
        }
        let (descriptor, evidence) = self
            .core
            .transfer_execution_to_recovery_evidence(&self.ticket, self.execution_id)?;
        self.released = true;
        on_handoff(evidence);
        Ok(descriptor)
    }

    /// Record the supervisor's Join observation.  Dropping a permit before
    /// this call is deliberately fail-closed: the admission remains visible
    /// to the core and can be recovered by the pre-registered owner.
    pub fn mark_joined(&mut self) -> Result<(), LifecycleError> {
        self.core.mark_execution_joined(&self.ticket)?;
        self.joined = true;
        Ok(())
    }

    /// Arm the Native common-finalizer guard for a synchronous execution
    /// scope.  The guard is used only after the worker has been admitted into
    /// that scope; a raw dropped permit remains fail-closed.
    pub fn arm_scope_finalizer(&mut self) {
        // Arming only opts this permit into the Native common-finalizer
        // protocol.  It is not a terminal proof and Drop must never invent a
        // Join on behalf of a worker that may still be running.
        self.scope_finalizer = true;
    }
}

impl Drop for MaintenancePermit {
    fn drop(&mut self) {
        if !self.released {
            // A dropped handle is not an execution terminal proof.  Keep the
            // ticket and responsibility reservation in the shared core so a
            // supervisor or recovery descriptor can still account for it.
            // This intentionally leaks ownership until an explicit finalizer
            // proves Join and cleanup; it never fabricates a successful end.
            // `scope_finalizer` does not change this rule.  A synchronous
            // owner must call `mark_joined` and `release` explicitly after it
            // has observed the worker boundary; an error return or panic
            // therefore leaves the reservation visible for recovery.
        }
    }
}

impl WorkspaceTransitionPermit {
    pub fn operation_id(&self) -> OperationId {
        self.ticket.operation_id
    }

    pub fn ticket(&self) -> &AdmissionTicket {
        &self.ticket
    }

    pub fn mark_joined(&self) -> Result<(), LifecycleError> {
        self.core.mark_transition_joined(&self.ticket)
    }

    pub fn physical_exclusive(&self) -> Result<WorkspaceExclusive, LifecycleError> {
        self.try_physical_exclusive()
    }

    /// Acquire the core-side physical-exclusion capability.  Native must hold
    /// the real `open_lock`/file lease guard for the same interval; this token
    /// makes that ownership explicit and prevents a second lifecycle worker
    /// from claiming the operation in the shared core.
    pub fn try_physical_exclusive(&self) -> Result<WorkspaceExclusive, LifecycleError> {
        self.core.acquire_physical_exclusive(&self.ticket)?;
        Ok(WorkspaceExclusive {
            core: self.core.clone(),
            operation_id: self.ticket.operation_id,
        })
    }

    pub fn publication_permit(
        &self,
        work_execution_id: WorkExecutionId,
    ) -> Result<PublicationPermit, LifecycleError> {
        self.core
            .reserve_work_for_operation(self.ticket.operation_id, work_execution_id)?;
        Ok(PublicationPermit {
            core: self.core.clone(),
            operation_id: self.ticket.operation_id,
            work_execution_id,
            completed: false,
        })
    }

    pub fn complete_unchanged(
        self,
        binding: LiveBinding,
    ) -> Result<LifecycleResult, LifecycleError> {
        self.core.complete_unchanged(&self.ticket, binding)
    }

    pub fn activate(
        self,
        binding: LiveBinding,
        content_effect: ContentEffect,
    ) -> Result<LifecycleResult, LifecycleError> {
        self.core.activate(&self.ticket, binding, content_effect)
    }

    pub fn require_recovery(
        self,
        expected_binding: Option<LiveBinding>,
        run: Option<RunOwnership>,
    ) -> Result<(RecoveryDescriptorId, LifecycleResult), LifecycleError> {
        self.core
            .require_recovery(&self.ticket, expected_binding, run)
    }
}

impl WorkspaceExclusive {
    pub fn operation_id(&self) -> OperationId {
        self.operation_id
    }
}

impl Drop for WorkspaceExclusive {
    fn drop(&mut self) {
        let _ = self.core.release_physical_exclusive(self.operation_id);
    }
}

impl Drop for WorkspaceParticipantLease {
    fn drop(&mut self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            let _ = self.core.release_workspace_participant();
        }
    }
}

impl PublicationPermit {
    pub fn operation_id(&self) -> OperationId {
        self.operation_id
    }

    pub fn work_execution_id(&self) -> WorkExecutionId {
        self.work_execution_id
    }

    pub fn complete(mut self) -> Result<(), LifecycleError> {
        self.core.complete_work_execution(self.work_execution_id)?;
        self.completed = true;
        Ok(())
    }
}

impl Drop for PublicationPermit {
    fn drop(&mut self) {
        // A publication marker is intentionally not a commit grant.  Only the
        // explicit finalizer can release the work membership.
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ActivationState {
    Ready,
    RequiresOpen,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ContentEffect {
    Retained,
    Replaced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum LifecycleResult {
    Unchanged {
        operation_id: OperationId,
        binding: LiveBinding,
        state_revision: StateRevision,
    },
    Activated {
        operation_id: OperationId,
        binding: LiveBinding,
        activation: ActivationState,
        content_effect: ContentEffect,
        state_revision: StateRevision,
    },
    Restored {
        operation_id: OperationId,
        binding: Option<LiveBinding>,
        activation: ActivationState,
        state_revision: StateRevision,
    },
    RecoveryRequired {
        operation_id: OperationId,
        descriptor_id: RecoveryDescriptorId,
        state_revision: StateRevision,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinedTransitionOutcome {
    Continue,
    RecoveryRequired,
    Shutdown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableRunHandle {
    pub project_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub kind: String,
    pub semantic_epoch_id: String,
    pub work_key: String,
    pub epoch: u64,
    pub sealed_spec: String,
    pub spec_digest: String,
    /// Process-local creation lineage captured before the writer starts.  It
    /// is optional for legacy/imported handles, which must fail closed when a
    /// lost creation result needs to be resolved.
    #[serde(default)]
    pub project_created_at: Option<String>,
    /// Canonical SQLite main-database path captured with the reservation.
    /// Reopening the exact locator is allowed; resolving against another DB
    /// with the same project id is not.
    #[serde(default)]
    pub database_path: Option<String>,
    /// Process-local file identity captured with the reservation. This is
    /// separate from the path so same-path replacement cannot be mistaken for
    /// continuity.
    #[serde(default)]
    pub database_file_identity: Option<String>,
    /// Set only by the shared core after the execution supervisor has
    /// observed the worker Join.  A descriptor created before that boundary
    /// must never be used as absence evidence.
    #[serde(default)]
    pub worker_joined: bool,
    /// Set only after the supervisor has quarantined the worker's connection
    /// and recorded that retirement receipt. A new resolver connection is not
    /// evidence that the old worker can no longer commit.
    #[serde(default)]
    pub connection_retired: bool,
    /// When reuse was selected but the exact existing tuple could not yet be
    /// attached, retain the selected durable Run ID. It is diagnostic and
    /// recovery input only; WorkKey lookup must never replace this identity.
    #[serde(default)]
    pub selected_reuse_run_id: Option<String>,
}

impl DurableRunHandle {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        project_id: impl Into<String>,
        run_id: impl Into<String>,
        task_id: impl Into<String>,
        attempt_id: impl Into<String>,
        kind: impl Into<String>,
        semantic_epoch_id: impl Into<String>,
        work_key: impl Into<String>,
        epoch: u64,
        sealed_spec: impl Into<String>,
        spec_digest: impl Into<String>,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            kind: kind.into(),
            semantic_epoch_id: semantic_epoch_id.into(),
            work_key: work_key.into(),
            epoch,
            sealed_spec: sealed_spec.into(),
            spec_digest: spec_digest.into(),
            project_created_at: None,
            database_path: None,
            database_file_identity: None,
            worker_joined: false,
            connection_retired: false,
            selected_reuse_run_id: None,
        }
    }

    fn is_exact(&self) -> bool {
        [
            &self.project_id,
            &self.run_id,
            &self.task_id,
            &self.attempt_id,
            &self.kind,
            &self.semantic_epoch_id,
            &self.work_key,
            &self.sealed_spec,
            &self.spec_digest,
        ]
        .iter()
        .all(|value| !value.trim().is_empty())
    }

    pub fn with_project_creation_lineage(mut self, created_at: impl Into<String>) -> Self {
        self.project_created_at = Some(created_at.into());
        self
    }

    pub fn with_database_path(mut self, path: impl Into<String>) -> Self {
        self.database_path = Some(path.into());
        self
    }

    pub fn with_database_file_identity(mut self, identity: impl Into<String>) -> Self {
        self.database_file_identity = Some(identity.into());
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RunCreationState {
    Reserved,
    CreationNotCommitted,
    CreationUnknown,
    /// The writer selected a reusable durable tuple, but the exact existing
    /// tuple could not yet be attached to this execution. This state must not
    /// be resolved as absence of the reservation IDs.
    ReuseSelectionUnknown,
    Created,
    Reused,
}

/// Outcome observed by the outer transaction supervisor for a reserved Run
/// tuple. A confirmed rollback proves that no durable creation survived;
/// every other failure path remains an exact `CreationUnknown` obligation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RunCreationTransactionOutcome {
    ConfirmedRollback,
    Unknown,
}

/// Shared-core membership is the lifecycle source of truth for Native
/// execution supervision.  A Join or stop request is a state transition, not
/// an inference from a dropped handle or a Promise rejection.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ExecutionPhase {
    Reserved,
    Started,
    StopRequested,
    Joined,
    CleanupPending,
    Completed,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionMembership {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub phase: ExecutionPhase,
    pub binding_revision: StateRevision,
    pub run: Option<RunOwnership>,
    /// One Native execution may process several canonical work items. Keep
    /// every additional exact tuple so a recovery handoff cannot drop a
    /// later work item.
    pub additional_runs: Vec<RunOwnership>,
    pub stop_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkExecutionMembership {
    pub work_execution_id: WorkExecutionId,
    pub execution_id: ExecutionId,
    pub phase: ExecutionPhase,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RunOwnership {
    pub state: RunCreationState,
    pub handle: DurableRunHandle,
}

/// Identifies which supervisor owns a recovery descriptor. Workspace
/// transition descriptors belong to the explicit Open/Restore owner; only
/// maintenance descriptors may be consumed by the automatic maintenance
/// recovery pump.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RecoveryDescriptorOwner {
    WorkspaceTransition,
    Maintenance,
}

fn same_run_work_identity(left: &DurableRunHandle, right: &DurableRunHandle) -> bool {
    left.project_id == right.project_id
        && left.kind == right.kind
        && left.semantic_epoch_id == right.semantic_epoch_id
        && left.work_key == right.work_key
        && left.epoch == right.epoch
        && left.sealed_spec == right.sealed_spec
        && left.spec_digest == right.spec_digest
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecoveryDescriptor {
    pub descriptor_id: RecoveryDescriptorId,
    pub root_operation_id: OperationId,
    pub owner: RecoveryDescriptorOwner,
    pub expected_binding: Option<LiveBinding>,
    pub run: Option<RunOwnership>,
    pub additional_runs: Vec<RunOwnership>,
    /// Responsibility transferred from the admitted operation. It remains
    /// live independently of delivery-record ACK until the descriptor root is
    /// explicitly resolved.
    pub responsibility: Option<ResponsibilityReservation>,
    pub control_generation: ControlGeneration,
    pub resolved: bool,
    /// Delivery records that carried this root's handoff result.  The record
    /// may retire after ACK while this values-only descriptor remains live.
    pub delivery_sequences: BTreeSet<DeliverySequence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRequest {
    /// The caller's view of the descriptor control generation.  A request
    /// from an older generation must never be accepted as a new request after
    /// a retry advances the slot.
    pub generation: ControlGeneration,
    pub fingerprint: String,
    pub payload: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ControlSlotOutcome {
    Accepted {
        generation: ControlGeneration,
    },
    Replay {
        generation: ControlGeneration,
        result: Option<String>,
    },
    Conflict {
        generation: ControlGeneration,
    },
    Retired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum DeliveryAdmissionOutcome {
    Accepted {
        sequence: DeliverySequence,
    },
    Replay {
        sequence: DeliverySequence,
        result: Option<String>,
    },
    Full {
        next_sequence: DeliverySequence,
    },
    SealedAbsent {
        sequence: DeliverySequence,
    },
    OutOfOrder {
        expected: DeliverySequence,
        received: DeliverySequence,
    },
    Conflict {
        sequence: DeliverySequence,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum FenceOutcome {
    Fenced {
        sequence: DeliverySequence,
    },
    AlreadyFenced {
        sequence: DeliverySequence,
    },
    OutOfOrder {
        expected: DeliverySequence,
        received: DeliverySequence,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ResponsibilityKind {
    ExactRun,
    WorkspaceOperation,
    RecoveryTransition,
}

impl ResponsibilityKind {
    fn uses_emergency_cell(self) -> bool {
        matches!(self, Self::RecoveryTransition)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResponsibilityReservation {
    pub id: ResponsibilityId,
    pub kind: ResponsibilityKind,
    pub root_operation_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ResponsibilityError {
    GeneralCapacity,
    EmergencyCapacity,
    Unknown(ResponsibilityId),
}

#[derive(Debug, Error, Clone, Eq, PartialEq)]
pub enum LifecycleError {
    #[error("workspace lifecycle state mutex is poisoned")]
    Poisoned,
    #[error("admission ticket {0} is unknown or already terminal")]
    UnknownOperation(OperationId),
    #[error("admission ticket {operation_id} cannot complete unchanged: binding or state changed")]
    BindingChanged { operation_id: OperationId },
    #[error("admission ticket {0} belongs to another operation")]
    WrongOperation(OperationId),
    #[error("workspace lifecycle is closed")]
    Closed,
    #[error("workspace lifecycle cannot publish Ready from its current state")]
    InvalidState,
    #[error("workspace lifecycle has active owners or unacknowledged work")]
    ActiveOperations,
    #[error("workspace transition {operation_id} was vetoed by a C-query quarantine")]
    TransitionVetoed { operation_id: OperationId },
    #[error("workspace operation {0} has not confirmed worker Join")]
    NotJoined(OperationId),
    #[error("execution {0} is unknown or already terminal")]
    UnknownExecution(ExecutionId),
    #[error("work execution {0} is unknown or already terminal")]
    UnknownWorkExecution(WorkExecutionId),
    #[error("execution membership transition is invalid")]
    InvalidExecutionTransition,
    #[error("recovery descriptor {0} has no completed control result")]
    ControlResultPending(RecoveryDescriptorId),
    #[error("recovery descriptor {0} received a conflicting control result")]
    ControlResultConflict(RecoveryDescriptorId),
    #[error("recovery descriptor {0} is unknown")]
    UnknownDescriptor(RecoveryDescriptorId),
    #[error("recovery descriptor {0} is already retired")]
    RetiredDescriptor(RecoveryDescriptorId),
    #[error("control generation {generation} does not match descriptor {descriptor}")]
    ControlGenerationMismatch {
        descriptor: RecoveryDescriptorId,
        generation: ControlGeneration,
    },
    #[error("delivery {0} already has a different terminal result")]
    DeliveryResultConflict(DeliverySequence),
    #[error("responsibility reservation failed: {0:?}")]
    Responsibility(ResponsibilityError),
}

#[derive(Clone, Debug)]
struct DeliveryRecord {
    fingerprint: String,
    terminal: bool,
    acked: bool,
    /// Retain the exact terminal wire result until transport ACK. A lost
    /// response must be replayable without executing the work again.
    result: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct DeliveryLedger {
    high_water: DeliverySequence,
    records: BTreeMap<DeliverySequence, DeliveryRecord>,
    fenced: BTreeSet<DeliverySequence>,
    /// ACK retirement is idempotent across a lost Native reply. Retired
    /// sequences may be sparse when an early record is still unACKed, so keep
    /// coalesced inclusive ranges rather than a watermark plus an unbounded
    /// sparse set.
    retired_ranges: BTreeMap<u64, u64>,
}

impl DeliveryLedger {
    fn is_retired(&self, sequence: DeliverySequence) -> bool {
        self.retired_ranges
            .range(..=sequence.get())
            .next_back()
            .is_some_and(|(_, end)| *end >= sequence.get())
    }

    fn mark_retired(&mut self, sequence: DeliverySequence) {
        let mut start = sequence.get();
        let mut end = sequence.get();
        if let Some((&range_start, &range_end)) = self.retired_ranges.range(..=start).next_back()
        {
            if range_end.saturating_add(1) >= start {
                start = range_start;
                end = end.max(range_end);
                self.retired_ranges.remove(&range_start);
            }
        }
        while let Some((range_start, range_end)) = self
            .retired_ranges
            .range(start..)
            .next()
            .map(|(range_start, range_end)| (*range_start, *range_end))
        {
            if range_start > end.saturating_add(1) {
                break;
            }
            end = end.max(range_end);
            self.retired_ranges.remove(&range_start);
        }
        self.retired_ranges.insert(start, end);
    }

}

#[derive(Clone, Debug)]
struct ControlSlot {
    generation: ControlGeneration,
    fingerprint: String,
    payload: String,
    result: Option<String>,
    acked: bool,
    retired: bool,
}

#[derive(Clone, Debug)]
struct ResponsibilityLedger {
    next_id: ResponsibilityId,
    general: BTreeMap<ResponsibilityId, ResponsibilityReservation>,
    emergency: Option<ResponsibilityReservation>,
}

impl Default for ResponsibilityLedger {
    fn default() -> Self {
        Self {
            next_id: ResponsibilityId::new(1),
            general: BTreeMap::new(),
            emergency: None,
        }
    }
}

#[derive(Debug)]
struct CoreState {
    state: LifecycleState,
    revision: StateRevision,
    next_operation: OperationId,
    next_descriptor: RecoveryDescriptorId,
    next_generation: ControlGeneration,
    admissions: BTreeMap<OperationId, AdmissionTicket>,
    joined_operations: BTreeSet<OperationId>,
    executions: BTreeMap<ExecutionId, ExecutionMembership>,
    work_executions: BTreeMap<WorkExecutionId, WorkExecutionMembership>,
    physical_exclusive_operations: BTreeSet<OperationId>,
    workspace_participants: usize,
    /// Single process-local fence: matching locator or workspace ID cannot be
    /// admitted or activated while a detached C-query remains unproved.
    c_query_quarantine: Option<Arc<LiveBinding>>,
    /// Whether the active transition conflicts with quarantine; false means a
    /// known-distinct Open target.
    open_transition_conflict: Option<(OperationId, bool)>,
    /// Exact transition cancelled by a cleanup-unproved quarantine handoff.
    vetoed_transition: Option<OperationId>,
    shutdown_requested: bool,
    descriptors: BTreeMap<RecoveryDescriptorId, RecoveryDescriptor>,
    control_slots: BTreeMap<RecoveryDescriptorId, ControlSlot>,
    delivery: DeliveryLedger,
    responsibilities: ResponsibilityLedger,
}

impl Default for CoreState {
    fn default() -> Self {
        Self {
            state: LifecycleState::NoWorkspace,
            revision: 0,
            next_operation: OperationId::new(1),
            next_descriptor: RecoveryDescriptorId::new(1),
            next_generation: ControlGeneration::new(1),
            admissions: BTreeMap::new(),
            joined_operations: BTreeSet::new(),
            executions: BTreeMap::new(),
            work_executions: BTreeMap::new(),
            physical_exclusive_operations: BTreeSet::new(),
            workspace_participants: 0,
            c_query_quarantine: None,
            open_transition_conflict: None,
            vetoed_transition: None,
            shutdown_requested: false,
            descriptors: BTreeMap::new(),
            control_slots: BTreeMap::new(),
            delivery: DeliveryLedger::default(),
            responsibilities: ResponsibilityLedger::default(),
        }
    }
}

fn clear_transition_metadata_locked(state: &mut CoreState, operation_id: OperationId) {
    if state
        .open_transition_conflict
        .as_ref()
        .is_some_and(|(owner, _)| *owner == operation_id)
    {
        state.open_transition_conflict = None;
    }
    if state.vetoed_transition == Some(operation_id) {
        state.vetoed_transition = None;
    }
}

fn quarantines_workspace(state: &CoreState, binding: &LiveBinding) -> bool {
    let Some(quarantined) = state.c_query_quarantine.as_ref() else {
        return false;
    };
    if quarantined.locator == binding.locator || quarantined.workspace_id == binding.workspace_id {
        return true;
    }
    match (
        quarantined.database_file_identity.as_deref(),
        binding.database_file_identity.as_deref(),
    ) {
        (Some(quarantined), Some(candidate)) => quarantined == candidate,
        // With an active quarantine, unknown physical identity cannot prove
        // that a differently named binding refers to a different workspace.
        _ => true,
    }
}

fn open_target_conflicts_with_binding(
    binding: &LiveBinding,
    locator: &str,
    workspace_id: Option<&str>,
    database_file_identity: Option<&str>,
) -> bool {
    if binding.locator.as_ref() == locator
        || workspace_id == Some(binding.workspace_id.as_ref())
    {
        return true;
    }
    match (
        binding.database_file_identity.as_deref(),
        database_file_identity,
    ) {
        (Some(binding), Some(candidate)) => binding == candidate,
        // A quarantine requires positive identity evidence that an Open
        // target is different before admission or handoff may proceed.
        _ => true,
    }
}

/// Missing target or identity evidence stays conflicting. The caller computes
/// this while holding the admission mutex, against the ticket's captured binding.
fn open_transition_conflicts_with_original(
    ticket: &AdmissionTicket,
    open_target: Option<(&str, Option<&str>, Option<&str>)>,
) -> bool {
    let (AdmissionKind::Open, Some(binding), Some((locator, workspace_id, identity))) =
        (ticket.kind, ticket.original_binding.as_ref(), open_target)
    else {
        return true;
    };
    open_target_conflicts_with_binding(binding, locator, workspace_id, identity)
}

fn quarantines_open_target(
    state: &CoreState,
    locator: &str,
    workspace_id: Option<&str>,
    database_file_identity: Option<&str>,
) -> bool {
    state
        .c_query_quarantine
        .as_ref()
        .is_some_and(|quarantined| {
            open_target_conflicts_with_binding(
                quarantined,
                locator,
                workspace_id,
                database_file_identity,
            )
        })
}

struct CoreInner {
    state: Mutex<CoreState>,
    /// This atomic is the legacy `switching` projection only. Native lifecycle
    /// code should use `snapshot()` and transition methods; the flag exists so
    /// old DB entry points fail closed while C2/C4 migrate them.
    compatibility_switching: AtomicBool,
}

/// The shared lifecycle owner. It is deliberately cloneable: every clone
/// points at one state machine and one compatibility projection.
#[derive(Clone)]
pub struct WorkspaceLifecycleCore {
    inner: Arc<CoreInner>,
}

/// Compatibility projection used by the pre-C4 `WorkspaceState::switching`
/// call sites. Its `load`/`store` shape intentionally mirrors `AtomicBool`,
/// but it is backed by the lifecycle core rather than a second flag.
#[derive(Clone)]
pub struct WorkspaceLifecycleCompatibilityView {
    inner: Arc<CoreInner>,
}

impl Default for WorkspaceLifecycleCore {
    fn default() -> Self {
        Self::new()
    }
}

/// Descriptor IDs are allocated monotonically without gaps. Once an ID below
/// `next_descriptor` is no longer present in the live descriptor map, it has
/// been resolved and retired. Deriving the tombstone from that monotonic
/// allocator keeps stale retries permanently `Retired` without retaining an
/// unbounded set of old IDs.
fn is_retired_descriptor_locked(state: &CoreState, descriptor_id: RecoveryDescriptorId) -> bool {
    descriptor_id != SAFE_MODE_RECOVERY_DESCRIPTOR_ID
        && descriptor_id < state.next_descriptor
        && !state.descriptors.contains_key(&descriptor_id)
}

fn lifecycle_diagnostic_locked(state: &CoreState) -> LifecycleDiagnostic {
    let (status, descriptor_id, operation_id) = match state.state {
        LifecycleState::NoWorkspace => (DiagnosticLifecycleState::NoWorkspace, None, None),
        LifecycleState::Ready(_) => (DiagnosticLifecycleState::Ready, None, None),
        LifecycleState::Transition { operation_id, .. } => (
            DiagnosticLifecycleState::Transition,
            None,
            Some(operation_id),
        ),
        LifecycleState::RecoveryRequired { descriptor_id } => (
            DiagnosticLifecycleState::RecoveryRequired,
            Some(descriptor_id),
            None,
        ),
        LifecycleState::Closed => (DiagnosticLifecycleState::Closed, None, None),
    };
    let descriptor = descriptor_id.and_then(|id| state.descriptors.get(&id));
    LifecycleDiagnostic {
        revision: state.revision,
        state: status,
        projected_state: None,
        compatibility_switching: None,
        shutdown_requested: state.shutdown_requested,
        descriptor_id,
        owner: descriptor.map(|value| value.owner),
        root_operation_id: descriptor
            .map(|value| value.root_operation_id)
            .or(operation_id),
    }
}

impl WorkspaceLifecycleCore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CoreInner {
                state: Mutex::new(CoreState::default()),
                compatibility_switching: AtomicBool::new(false),
            }),
        }
    }

    pub fn compatibility_view(&self) -> WorkspaceLifecycleCompatibilityView {
        WorkspaceLifecycleCompatibilityView {
            inner: Arc::clone(&self.inner),
        }
    }

    pub fn snapshot(&self) -> Result<LifecycleSnapshot, LifecycleError> {
        let state = self.lock_state()?;
        let projected_state = if self.inner.compatibility_switching.load(Ordering::SeqCst) {
            match state.state {
                LifecycleState::Closed => LifecycleState::Closed,
                LifecycleState::Transition {
                    operation_id,
                    stage,
                } => LifecycleState::Transition {
                    operation_id,
                    stage,
                },
                _ => LifecycleState::Transition {
                    operation_id: OperationId::new(0),
                    stage: TransitionStage::Draining,
                },
            }
        } else {
            state.state.clone()
        };
        Ok(LifecycleSnapshot::new(projected_state, state.revision))
    }

    /// The DB rejection decision and safe evidence use the same snapshot.
    pub(crate) fn snapshot_with_diagnostic(
        &self,
    ) -> Result<(LifecycleSnapshot, LifecycleDiagnostic), LifecycleError> {
        let state = self.lock_state()?;
        let projected = self.projected_state_locked(&state);
        let mut evidence = lifecycle_diagnostic_locked(&state);
        evidence.projected_state = Some(match projected {
            LifecycleState::NoWorkspace => DiagnosticLifecycleState::NoWorkspace,
            LifecycleState::Ready(_) => DiagnosticLifecycleState::Ready,
            LifecycleState::Transition { .. } => DiagnosticLifecycleState::Transition,
            LifecycleState::RecoveryRequired { .. } => DiagnosticLifecycleState::RecoveryRequired,
            LifecycleState::Closed => DiagnosticLifecycleState::Closed,
        });
        Ok((LifecycleSnapshot::new(projected, state.revision), evidence))
    }

    pub fn state_revision(&self) -> Result<StateRevision, LifecycleError> {
        Ok(self.lock_state()?.revision)
    }

    /// Register a DB operation that has pinned the current authority. This is
    /// a participant boundary rather than an execution admission: it does not
    /// change foreground/maintenance scheduling, but transitions and shutdown
    /// must wait for it to release before publishing replacement or Closed.
    pub fn begin_workspace_participant(&self) -> Result<WorkspaceParticipant, LifecycleError> {
        self.begin_workspace_participant_diagnosed(|_| {})
    }

    pub(crate) fn begin_workspace_participant_diagnosed(
        &self,
        on_rejection: impl FnOnce(LifecycleDiagnostic),
    ) -> Result<WorkspaceParticipant, LifecycleError> {
        let mut state = self.lock_state()?;
        if state.shutdown_requested || matches!(state.state, LifecycleState::Closed) {
            let evidence = lifecycle_diagnostic_locked(&state);
            drop(state);
            on_rejection(evidence);
            return Err(LifecycleError::Closed);
        }
        // A participant is proof that a caller has pinned the current
        // authority. Once a transition or recovery has begun, admitting a new
        // participant would let the drain target keep increasing and could
        // prevent physical replacement from ever reaching its Join boundary.
        // Recovery/control operations use their descriptor-bound paths and do
        // not enter through this ordinary participant API.
        if matches!(
            state.state,
            LifecycleState::Transition { .. } | LifecycleState::RecoveryRequired { .. }
        ) || matches!(
            &state.state,
            LifecycleState::Ready(binding) if quarantines_workspace(&state, binding)
        ) {
            let evidence = lifecycle_diagnostic_locked(&state);
            drop(state);
            on_rejection(evidence);
            return Err(LifecycleError::ActiveOperations);
        }
        state.workspace_participants = state.workspace_participants.saturating_add(1);
        Ok(WorkspaceParticipant {
            lease: Arc::new(WorkspaceParticipantLease {
                core: self.clone(),
                released: AtomicBool::new(false),
            }),
        })
    }

    /// Return the number of pinned authorities still participating in a
    /// transition or shutdown. This is an observation only; callers must keep
    /// the lifecycle lock out of their blocking wait and re-check before
    /// publishing a terminal state.
    pub fn workspace_participant_count(&self) -> Result<usize, LifecycleError> {
        Ok(self.lock_state()?.workspace_participants)
    }

    fn release_workspace_participant(&self) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        state.workspace_participants = state.workspace_participants.saturating_sub(1);
        Ok(())
    }

    fn detach_c_query_quarantine(
        &self,
        participant: &WorkspaceParticipant,
        binding: &LiveBinding,
    ) -> Option<WorkspaceQuarantineFence> {
        if binding.database_file_identity.is_none()
            || Arc::strong_count(&participant.lease) != 1
            || participant.lease.released.load(Ordering::Acquire)
        {
            return None;
        }
        let mut state = self.lock_state().ok()?;
        if state.c_query_quarantine.is_some() || state.workspace_participants == 0 {
            return None;
        }
        let transition_handoff = match &state.state {
            LifecycleState::Transition { operation_id, .. } => state
                .admissions
                .get(operation_id)
                .filter(|ticket| {
                    matches!(ticket.kind, AdmissionKind::Open | AdmissionKind::Restore)
                        && ticket.original_binding.as_ref() == Some(binding)
                })
                .map(|ticket| {
                    let conflicts = match ticket.kind {
                        AdmissionKind::Restore => true,
                        AdmissionKind::Open => state
                            .open_transition_conflict
                            .as_ref()
                            .filter(|(owner, _)| owner == operation_id)
                            .map_or(true, |(_, conflicts)| *conflicts),
                        _ => true,
                    };
                    (*operation_id, conflicts)
                }),
            _ => None,
        };
        let exact_live_binding = match &state.state {
            LifecycleState::Ready(current) => current == binding,
            LifecycleState::Transition { .. } => transition_handoff.is_some(),
            _ => false,
        };
        if !exact_live_binding
            || !state.physical_exclusive_operations.is_empty()
            || (self.inner.compatibility_switching.load(Ordering::SeqCst)
                && transition_handoff.is_none())
        {
            return None;
        }

        let binding = Arc::new(binding.clone());
        state.c_query_quarantine = Some(Arc::clone(&binding));
        if let Some((operation_id, true)) = transition_handoff {
            state.vetoed_transition = Some(operation_id);
        }
        state.workspace_participants -= 1;
        state.revision = state.revision.saturating_add(1);
        participant.lease.released.store(true, Ordering::Release);
        Some(WorkspaceQuarantineFence {
            core: self.clone(),
            binding,
        })
    }

    fn release_c_query_quarantine(&self, binding: &Arc<LiveBinding>) {
        if let Ok(mut state) = self.inner.state.lock() {
            if state
                .c_query_quarantine
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, binding))
            {
                state.c_query_quarantine = None;
                state.revision = state.revision.saturating_add(1);
            }
        }
    }

    pub fn set_ready(&self, binding: LiveBinding) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        if quarantines_workspace(&state, &binding) {
            return Err(LifecycleError::ActiveOperations);
        }
        match &state.state {
            LifecycleState::Closed => return Err(LifecycleError::Closed),
            LifecycleState::NoWorkspace | LifecycleState::Ready(_) => {}
            LifecycleState::Transition { .. } | LifecycleState::RecoveryRequired { .. } => {
                // A caller that is completing an admitted transition must use
                // `activate`/`complete_unchanged`; a raw Ready setter would
                // otherwise bypass the logical permit and could revive a
                // stale authority after a failed swap.
                return Err(LifecycleError::InvalidState);
            }
        }
        if !state.admissions.is_empty()
            || !state.joined_operations.is_empty()
            || state.executions.values().any(|execution| {
                execution.phase != ExecutionPhase::Completed
                    && execution.phase != ExecutionPhase::RecoveryRequired
            })
            || state.work_executions.values().any(|work| {
                work.phase != ExecutionPhase::Completed
                    && state
                        .executions
                        .get(&work.execution_id)
                        .is_some_and(|execution| {
                            execution.phase != ExecutionPhase::RecoveryRequired
                        })
            })
            || !state.physical_exclusive_operations.is_empty()
            || state.workspace_participants != 0
        {
            return Err(LifecycleError::ActiveOperations);
        }
        if state.shutdown_requested {
            return Err(LifecycleError::Closed);
        }
        state.state = LifecycleState::Ready(binding);
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    pub fn close(&self) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        if matches!(state.state, LifecycleState::Closed) {
            return Ok(LifecycleSnapshot::new(state.state.clone(), state.revision));
        }
        // A timeout, stop request, or dropped waiter is not terminal proof.
        // Keep the current state and every owner visible until the supervisor
        // has joined workers, transferred descriptors, and ACKed receipts.
        if !state.admissions.is_empty()
            || !state.joined_operations.is_empty()
            || state
                .executions
                .values()
                .any(|execution| execution.phase != ExecutionPhase::Completed)
            || state
                .work_executions
                .values()
                .any(|work| work.phase != ExecutionPhase::Completed)
            || !state.physical_exclusive_operations.is_empty()
            || state.workspace_participants != 0
            || state
                .descriptors
                .values()
                .any(|descriptor| !descriptor.resolved || descriptor.responsibility.is_some())
            || state
                .control_slots
                .values()
                .any(|slot| !slot.retired || !slot.acked)
            || !state.delivery.records.is_empty()
            || !state.delivery.fenced.is_empty()
            || !state.responsibilities.general.is_empty()
            || state.responsibilities.emergency.is_some()
            || state.c_query_quarantine.is_some()
        {
            return Err(LifecycleError::ActiveOperations);
        }
        state.state = LifecycleState::Closed;
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    /// Close normal admission before Native begins its shutdown observation.
    /// This is an idempotent core transition; it never turns a timeout into a
    /// terminal `Closed` state and it does not clear active owners.
    pub fn request_shutdown(&self) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        if matches!(state.state, LifecycleState::Closed) {
            return Ok(LifecycleSnapshot::new(state.state.clone(), state.revision));
        }
        if !state.shutdown_requested {
            state.shutdown_requested = true;
            // Shutdown owns the stop request for every admitted execution,
            // including manual foreground/maintenance owners that are not
            // present in the Electron scheduler. Join and cleanup remain
            // separate terminal proofs; this only makes their cooperative
            // stop checks observe the same shutdown boundary.
            for execution in state.executions.values_mut() {
                if matches!(execution.phase, ExecutionPhase::Reserved | ExecutionPhase::Started) {
                    execution.phase = ExecutionPhase::StopRequested;
                    execution.stop_requested = true;
                }
            }
            for work in state.work_executions.values_mut() {
                if matches!(work.phase, ExecutionPhase::Reserved | ExecutionPhase::Started) {
                    work.phase = ExecutionPhase::StopRequested;
                }
            }
            if !matches!(state.state, LifecycleState::Transition { .. }) {
                state.state = LifecycleState::Transition {
                    operation_id: OperationId::new(0),
                    stage: TransitionStage::Finishing,
                };
            }
            state.revision = state.revision.saturating_add(1);
            self.inner
                .compatibility_switching
                .store(true, Ordering::SeqCst);
        }
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    /// Resolve shutdown and a joined quarantine veto in one core-lock order.
    /// The Native publisher must not read these conditions separately before
    /// choosing RecoveryRequired versus Finishing.
    pub fn resolve_joined_transition(
        &self,
        ticket: &AdmissionTicket,
    ) -> Result<JoinedTransitionOutcome, LifecycleError> {
        let state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition() {
            return Err(LifecycleError::InvalidState);
        }
        if !state.joined_operations.contains(&ticket.operation_id)
            || !matches!(
                state.state,
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id
            )
        {
            return Err(LifecycleError::NotJoined(ticket.operation_id));
        }
        if state.shutdown_requested {
            self.abandon_transition_for_shutdown_locked(state, ticket)?;
            return Ok(JoinedTransitionOutcome::Shutdown);
        }
        if state.vetoed_transition == Some(ticket.operation_id) {
            self.require_recovery_locked(state, ticket, ticket.original_binding.clone(), None)?;
            return Ok(JoinedTransitionOutcome::RecoveryRequired);
        }
        Ok(JoinedTransitionOutcome::Continue)
    }

    pub fn shutdown_requested(&self) -> Result<bool, LifecycleError> {
        Ok(self.lock_state()?.shutdown_requested)
    }

    /// End an admitted transition after its worker has joined when shutdown
    /// won the lifecycle race.  The transition is retired into the shared
    /// Finishing state so a late Open/Restore completion cannot publish Ready
    /// between the shutdown request and the final Closed proof.
    pub fn abandon_transition_for_shutdown(
        &self,
        ticket: &AdmissionTicket,
    ) -> Result<(), LifecycleError> {
        self.abandon_transition_for_shutdown_locked(self.lock_state()?, ticket)
    }

    fn abandon_transition_for_shutdown_locked(
        &self,
        mut state: MutexGuard<'_, CoreState>,
        ticket: &AdmissionTicket,
    ) -> Result<(), LifecycleError> {
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition()
            || !state.joined_operations.contains(&ticket.operation_id)
            || !matches!(
                state.state,
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id
            )
        {
            return Err(LifecycleError::NotJoined(ticket.operation_id));
        }
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        clear_transition_metadata_locked(&mut state, ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
        state.state = LifecycleState::Transition {
            operation_id: OperationId::new(0),
            stage: TransitionStage::Finishing,
        };
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Retire an initial Open/Restore transition that never had an old
    /// authority and never published a candidate.  In this case there is no
    /// binding or durable recovery root to preserve: the failed transition
    /// returns to `NoWorkspace` instead of manufacturing a descriptor whose
    /// expected binding is `None`.
    pub fn abandon_initial_transition(
        &self,
        ticket: &AdmissionTicket,
    ) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition()
            || ticket.original_binding.is_some()
            || !state.joined_operations.contains(&ticket.operation_id)
            || !matches!(
                state.state,
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id
            )
            || state.physical_exclusive_operations.contains(&ticket.operation_id)
            || state.admissions.values().any(|admission| {
                admission.operation_id != ticket.operation_id
                    && !admission.kind.is_capacity_independent()
            })
            || state.executions.values().any(|execution| {
                execution.operation_id != ticket.operation_id
                    && execution.phase != ExecutionPhase::Completed
                    && execution.phase != ExecutionPhase::RecoveryRequired
            })
        {
            return Err(LifecycleError::ActiveOperations);
        }
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        clear_transition_metadata_locked(&mut state, ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
        state.state = LifecycleState::NoWorkspace;
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    /// Fail a descriptor-bound recovery that was running in the background
    /// while an unrelated workspace remained Ready.  The descriptor and its
    /// responsibility stay live for a later retry, but the temporary
    /// recovery admission is retired and the active binding is restored as
    /// the authoritative Ready state.  This is deliberately separate from
    /// `require_recovery`, which would make the whole process enter the
    /// global RecoveryRequired state and stop the unrelated renderer scope.
    pub fn abandon_background_recovery(
        &self,
        ticket: &AdmissionTicket,
        binding: LiveBinding,
    ) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        let shutdown_finishing = state.shutdown_requested
            && matches!(
                state.state,
                LifecycleState::Transition {
                    operation_id,
                    stage: TransitionStage::Finishing,
                } if operation_id == OperationId::new(0)
            );
        if ticket.kind != AdmissionKind::Recover
            || !state.joined_operations.contains(&ticket.operation_id)
            || !(matches!(
                state.state,
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id
            ) || matches!(state.state, LifecycleState::Ready(_))
                || shutdown_finishing)
            || state.physical_exclusive_operations.contains(&ticket.operation_id)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        let current_binding = match &state.state {
            LifecycleState::Ready(current) => current.clone(),
            LifecycleState::Transition { .. } => binding.clone(),
            _ => return Err(LifecycleError::ActiveOperations),
        };
        if !same_binding_identity(&current_binding, &binding)
            || quarantines_workspace(&state, &binding)
        {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        // Do not release the descriptor's responsibility here.  The exact
        // root remains pending and is the only owner allowed to retry it.
        Self::release_temporary_responsibility_locked(
            &mut state,
            ticket,
            ticket.recovery_descriptor_id,
        );
        if !shutdown_finishing {
            state.state = LifecycleState::Ready(current_binding);
        }
        state.revision = state.revision.saturating_add(1);
        if !shutdown_finishing {
            self.inner
                .compatibility_switching
                .store(false, Ordering::SeqCst);
        }
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    /// Complete a descriptor-bound background recovery while preserving the
    /// unrelated active Ready binding. The temporary admission is retired,
    /// but the descriptor responsibility remains owned by its completion
    /// receipt until the transport ACK releases it.
    pub fn complete_background_recovery(
        &self,
        ticket: &AdmissionTicket,
        binding: LiveBinding,
    ) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        let shutdown_finishing = state.shutdown_requested
            && matches!(
                state.state,
                LifecycleState::Transition {
                    operation_id,
                    stage: TransitionStage::Finishing,
                } if operation_id == OperationId::new(0)
            );
        if ticket.kind != AdmissionKind::Recover
            || !state.joined_operations.contains(&ticket.operation_id)
            || !(matches!(
                state.state,
                LifecycleState::Ready(ref current) if same_binding_identity(current, &binding)
            ) || shutdown_finishing)
            || quarantines_workspace(&state, &binding)
            || state.physical_exclusive_operations.contains(&ticket.operation_id)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        Self::release_temporary_responsibility_locked(
            &mut state,
            ticket,
            ticket.recovery_descriptor_id,
        );
        state.revision = state.revision.saturating_add(1);
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    /// Project an already durable Safe Mode session into the shared lifecycle
    /// state before an explicit recovery/open operation is admitted. Descriptor
    /// zero is reserved for this process-independent Safe Mode holder; it is
    /// never treated as an ordinary recovery descriptor or Run owner.
    pub fn mark_safe_mode_recovery_required(&self) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        if matches!(state.state, LifecycleState::Closed) {
            return Err(LifecycleError::Closed);
        }
        if !state.admissions.is_empty() || !state.joined_operations.is_empty() {
            return Err(LifecycleError::ActiveOperations);
        }
        // Preserve an exact descriptor owned by a previous transition. Safe
        // Mode is a durable projection of the same blocked workspace; it must
        // not replace that root with descriptor zero and lose its Run/lineage
        // responsibility.
        if let LifecycleState::RecoveryRequired { descriptor_id } = state.state.clone() {
            if descriptor_id != SAFE_MODE_RECOVERY_DESCRIPTOR_ID {
                return Ok(LifecycleSnapshot::new(state.state.clone(), state.revision));
            }
        }
        if state.descriptors.values().any(|descriptor| {
            !descriptor.resolved && descriptor.descriptor_id != SAFE_MODE_RECOVERY_DESCRIPTOR_ID
        }) {
            return Err(LifecycleError::ActiveOperations);
        }
        if matches!(
            state.state,
            LifecycleState::RecoveryRequired {
                descriptor_id: SAFE_MODE_RECOVERY_DESCRIPTOR_ID
            }
        ) {
            return Ok(LifecycleSnapshot::new(state.state.clone(), state.revision));
        }
        state.state = LifecycleState::RecoveryRequired {
            descriptor_id: SAFE_MODE_RECOVERY_DESCRIPTOR_ID,
        };
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    pub fn admit(&self, kind: AdmissionKind) -> Result<AdmissionOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        self.admit_locked(&mut state, kind, None, false)
    }

    /// Admit recovery only for the exact descriptor root that owns the
    /// recovery responsibility.  A bare `AdmissionKind::Recover` intentionally
    /// remains rejected because it carries no proof of which root it may
    /// advance.
    pub fn admit_recovery(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        self.admit_recovery_locked(&mut state, descriptor_id, false)
    }

    /// Admit a descriptor-bound recovery while an unrelated Ready workspace
    /// remains active. The admission and descriptor responsibility are still
    /// tracked by the core, but the public lifecycle state stays Ready so
    /// ordinary DB participants for that exact active authority can proceed.
    /// The caller must use the descriptor's isolated authority and must not
    /// install it into the active slot while this admission is backgrounded.
    pub fn admit_background_recovery(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        self.admit_recovery_locked(&mut state, descriptor_id, true)
    }

    fn admit_recovery_locked(
        &self,
        state: &mut CoreState,
        descriptor_id: RecoveryDescriptorId,
        background: bool,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        let is_safe_mode_root = descriptor_id == SAFE_MODE_RECOVERY_DESCRIPTOR_ID;
        // Each descriptor has one live recovery control owner.  A retry is
        // admitted only after the prior owner has explicitly completed or
        // abandoned its generation; otherwise a single projection ticket
        // could be overwritten and a late completion could retire the wrong
        // operation.
        if state.admissions.values().any(|admission| {
            admission.kind == AdmissionKind::Recover
                && admission.recovery_descriptor_id == Some(descriptor_id)
        }) {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(state),
                    state.revision,
                ),
            });
        }
        if !is_safe_mode_root && is_retired_descriptor_locked(state, descriptor_id) {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::Retired,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(state),
                    state.revision,
                ),
            });
        }
        let has_descriptor_root = state.descriptors.contains_key(&descriptor_id);
        let descriptor_is_unresolved = state
            .descriptors
            .get(&descriptor_id)
            .is_some_and(|descriptor| !descriptor.resolved);
        let descriptor_activation_pending = state
            .descriptors
            .get(&descriptor_id)
            .is_some_and(|descriptor| descriptor.resolved && descriptor.responsibility.is_some());
        let state_allows_descriptor = matches!(
            state.state,
            LifecycleState::RecoveryRequired { descriptor_id: current }
                if current == descriptor_id
        ) || (matches!(state.state, LifecycleState::Ready(_))
            && (descriptor_is_unresolved || descriptor_activation_pending));
        if !state_allows_descriptor || (!has_descriptor_root && !is_safe_mode_root) {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::RecoveryPrerequisite,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(state),
                    state.revision,
                ),
            });
        }
        if (!is_safe_mode_root
            && state
                .descriptors
                .get(&descriptor_id)
                .is_some_and(|descriptor| {
                    descriptor.resolved && descriptor.responsibility.is_none()
                }))
            || (!is_safe_mode_root
                && state
                    .control_slots
                    .get(&descriptor_id)
                    .is_some_and(|slot| slot.retired)
                && !descriptor_activation_pending)
        {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::Retired,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(state),
                    state.revision,
                ),
            });
        }
        let outcome = self.admit_locked(
            state,
            AdmissionKind::Recover,
            Some(descriptor_id),
            background,
        )?;
        if !background {
            if let AdmissionOutcome::Admitted(ticket) = &outcome {
            state.state = LifecycleState::Transition {
                operation_id: ticket.operation_id,
                stage: TransitionStage::Recovering,
            };
            state.revision = state.revision.saturating_add(1);
            self.inner
                .compatibility_switching
                .store(true, Ordering::SeqCst);
            }
        }
        Ok(outcome)
    }

    /// Begin a descriptor-bound recovery with the same logical permit used by
    /// Open/Restore. A generic Recover admission is intentionally unavailable
    /// because it cannot prove which descriptor root it owns.
    pub fn begin_recovery_permit(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<PermitAdmission<WorkspaceTransitionPermit>, LifecycleError> {
        Ok(match self.admit_recovery(descriptor_id)? {
            AdmissionOutcome::Admitted(ticket) => {
                PermitAdmission::Admitted(WorkspaceTransitionPermit {
                core: self.clone(),
                ticket,
                })
            }
            AdmissionOutcome::NotAdmitted { reason, snapshot } => {
                PermitAdmission::NotAdmitted { reason, snapshot }
            }
        })
    }

    pub fn admit_maintenance_permit(
        &self,
    ) -> Result<PermitAdmission<MaintenancePermit>, LifecycleError> {
        self.admit_execution_permit(AdmissionKind::Maintenance)
    }

    /// Admit a foreground transaction through the shared lifecycle membership.
    /// Foreground owns no durable Run responsibility, but its execution slot
    /// remains visible until the enclosing connection and transaction have
    /// returned, so workspace transitions cannot race the validation/DML
    /// cleanup boundary. Maintenance has a separate single-owner slot and
    /// therefore cannot reject this request before the existing DB priority
    /// policy is consulted.
    pub fn admit_foreground_permit(
        &self,
    ) -> Result<PermitAdmission<MaintenancePermit>, LifecycleError> {
        self.admit_execution_permit(AdmissionKind::Foreground)
    }

    fn admit_execution_permit(
        &self,
        kind: AdmissionKind,
    ) -> Result<PermitAdmission<MaintenancePermit>, LifecycleError> {
        // Admission and execution reservation share one core lock.  Keeping
        // them as two public calls lets an Open/Restore enter the gap after
        // the ticket is admitted but before its Reserved execution exists;
        // the transition would then be unable to request a pending-start
        // stop and the body could begin after replacement admission.
        let mut state = self.lock_state()?;
        Ok(match self.admit_locked(&mut state, kind, None, false)? {
            AdmissionOutcome::Admitted(ticket) => {
                // Operation ids are monotonic within this core and therefore
                // provide a collision-free process-local execution slot for
                // the synchronous Native supervisor.  The slot is reserved
                // before the caller can start any DB work.
                let execution_id = ExecutionId::new(ticket.operation_id.get());
                let membership = ExecutionMembership {
                    execution_id,
                    operation_id: ticket.operation_id,
                    phase: ExecutionPhase::Reserved,
                    binding_revision: ticket.admitted_revision,
                    run: None,
                    additional_runs: Vec::new(),
                    stop_requested: false,
                };
                state.executions.insert(execution_id, membership);
                PermitAdmission::Admitted(MaintenancePermit {
                    core: self.clone(),
                    ticket,
                    execution_id,
                    released: false,
                    joined: false,
                    scope_finalizer: false,
                })
            }
            AdmissionOutcome::NotAdmitted { reason, snapshot } => {
                PermitAdmission::NotAdmitted { reason, snapshot }
            }
        })
    }

    pub fn begin_transition_permit(
        &self,
        kind: AdmissionKind,
    ) -> Result<PermitAdmission<WorkspaceTransitionPermit>, LifecycleError> {
        if !kind.is_transition() {
            return Err(LifecycleError::InvalidState);
        }
        Ok(match self.begin_transition(kind)? {
            AdmissionOutcome::Admitted(ticket) => {
                PermitAdmission::Admitted(WorkspaceTransitionPermit {
                    core: self.clone(),
                    ticket,
                })
            }
            AdmissionOutcome::NotAdmitted { reason, snapshot } => {
                PermitAdmission::NotAdmitted { reason, snapshot }
            }
        })
    }

    /// Release a non-transition admission after its worker has reached the
    /// common finalizer. Transition tickets must instead complete through
    /// Join/activation or recovery handoff.
    pub fn release_admission(&self, ticket: &AdmissionTicket) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if ticket.kind.is_transition() {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        let execution_members = state
            .executions
            .values()
            .filter(|execution| execution.operation_id == ticket.operation_id)
            .collect::<Vec<_>>();
        let execution_completed = !execution_members.is_empty()
            && execution_members
                .iter()
                .all(|execution| execution.phase == ExecutionPhase::Completed);
        if !state.joined_operations.contains(&ticket.operation_id) && !execution_completed {
            return Err(LifecycleError::NotJoined(ticket.operation_id));
        }
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
        // The admission is now terminal and no descriptor/delivery can still
        // reference this execution.  Retire the heavyweight membership and
        // its child rows; old IDs intentionally become Unknown rather than
        // retaining every Run/Attempt spec for the lifetime of the process.
        let retired_execution_ids = state
            .executions
            .values()
            .filter(|execution| execution.operation_id == ticket.operation_id)
            .map(|execution| execution.execution_id)
            .collect::<Vec<_>>();
        for execution_id in retired_execution_ids {
            state
                .work_executions
                .retain(|_, work| work.execution_id != execution_id);
            state.executions.remove(&execution_id);
        }
        Ok(true)
    }

    fn admit_locked(
        &self,
        state: &mut CoreState,
        kind: AdmissionKind,
        recovery_descriptor_id: Option<RecoveryDescriptorId>,
        background_recovery: bool,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        let current = self.projected_state_locked(state);
        let has_live_transition = state
            .admissions
            .values()
            .any(|admission| admission.kind.is_transition());
        let has_live_recovery = state
            .admissions
            .values()
            .any(|admission| admission.kind == AdmissionKind::Recover);
        let rejection = match (&current, kind) {
            (LifecycleState::Closed, _) => Some(AdmissionRejection::Closed),
            (_, kind)
                if state.shutdown_requested
                    && !matches!(kind, AdmissionKind::Snapshot | AdmissionKind::Shutdown) =>
            {
                Some(AdmissionRejection::Closed)
            }
            // Maintenance owns one scheduler execution slot. Foreground
            // commands are lifecycle participants rather than a second
            // single-owner lane: multiple foreground waiters must reach the
            // existing priority/SQLite busy-timeout rules while maintenance
            // drains, instead of being rejected by the lifecycle core.
            (_, kind)
                if kind.is_maintenance_execution()
                    && state
                        .admissions
                        .values()
                        .any(|ticket| ticket.kind.is_maintenance_execution()) =>
            {
                Some(AdmissionRejection::ActiveOperation)
            }
            // A background descriptor recovery may coexist with ordinary
            // foreground/maintenance participants on an unrelated Ready
            // binding, but it owns the one Native transition projection slot.
            // Do not allow Open/Restore or another Recover to replace it.
            (_, kind)
                if (kind.is_transition() && has_live_recovery)
                    || (kind == AdmissionKind::Recover
                        && (has_live_transition || has_live_recovery)) =>
            {
                Some(AdmissionRejection::ActiveOperation)
            }
            // Descriptor recovery is capacity-independent with respect to
            // transport and responsibility cells, but it cannot overtake a
            // live foreground/maintenance execution.  A W1 descriptor may
            // remain while W2 is Ready; leave the descriptor pending until
            // W2 has joined so activation cannot fail against an unrelated
            // owner and wedge the lifecycle transition.
            (_, AdmissionKind::Recover)
                if !background_recovery
                    && (state.admissions.values().any(|ticket| {
                        !ticket.kind.is_capacity_independent()
                    })
                        || state.executions.values().any(|execution| {
                            execution.phase != ExecutionPhase::Completed
                                && execution.phase != ExecutionPhase::RecoveryRequired
                        })) =>
            {
                Some(AdmissionRejection::ActiveOperation)
            }
            (LifecycleState::Transition { .. }, kind) if !kind.is_capacity_independent() => {
                Some(AdmissionRejection::Transition)
            }
            // Recovery is descriptor-bound. A bare Recover request has no
            // root to prove, so it cannot be admitted from a transition or
            // an empty/ready workspace through the generic API.
            (LifecycleState::Transition { .. }, AdmissionKind::Recover)
            | (LifecycleState::NoWorkspace, AdmissionKind::Recover) => {
                Some(AdmissionRejection::RecoveryPrerequisite)
            }
            (LifecycleState::Ready(_), AdmissionKind::Recover)
                if !matches!(
                    recovery_descriptor_id,
                    Some(descriptor_id)
                        if state
                            .descriptors
                            .get(&descriptor_id)
                            .is_some_and(|descriptor| {
                                !descriptor.resolved || descriptor.responsibility.is_some()
                            })
                ) =>
            {
                Some(AdmissionRejection::RecoveryPrerequisite)
            }
            (LifecycleState::RecoveryRequired { .. }, kind)
                if !matches!(
                    kind,
                    AdmissionKind::Open
                        | AdmissionKind::Snapshot
                        | AdmissionKind::Shutdown
                        | AdmissionKind::Recover
                ) =>
            {
                Some(AdmissionRejection::RecoveryRequired)
            }
            (LifecycleState::NoWorkspace, AdmissionKind::Maintenance) => {
                Some(AdmissionRejection::NoWorkspace)
            }
            (LifecycleState::NoWorkspace, AdmissionKind::Foreground) => {
                Some(AdmissionRejection::NoWorkspace)
            }
            // Restore needs an existing authority to own the transition and
            // a worker boundary to produce the Safe Mode/recovery proof. A
            // restore request with no current workspace cannot create that
            // owner; callers must use Open/Shutdown from this state.
            (LifecycleState::NoWorkspace, AdmissionKind::Restore) => {
                Some(AdmissionRejection::NoWorkspace)
            }
            (LifecycleState::RecoveryRequired { .. }, AdmissionKind::Recover)
                if recovery_descriptor_id.is_none() =>
            {
                Some(AdmissionRejection::RecoveryPrerequisite)
            }
            _ => None,
        };
        if let Some(reason) = rejection {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason,
                snapshot: LifecycleSnapshot::new(current, state.revision),
            });
        }
        if kind == AdmissionKind::Recover && recovery_descriptor_id.is_none() {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::RecoveryPrerequisite,
                snapshot: LifecycleSnapshot::new(current, state.revision),
            });
        }

        if matches!(kind, AdmissionKind::Open | AdmissionKind::Restore) {
            if let Some(descriptor_id) = recovery_descriptor_id {
                let valid_retry = state.descriptors.get(&descriptor_id).is_some_and(|descriptor| {
                    descriptor.owner == RecoveryDescriptorOwner::WorkspaceTransition
                        && !descriptor.resolved
                        && descriptor.responsibility.is_some()
                        && match &state.state {
                            LifecycleState::RecoveryRequired { descriptor_id: current } => {
                                *current == descriptor_id
                            }
                            LifecycleState::Ready(_) => true,
                            _ => false,
                        }
                });
                if !valid_retry {
                    return Ok(AdmissionOutcome::NotAdmitted {
                        reason: AdmissionRejection::RecoveryPrerequisite,
                        snapshot: LifecycleSnapshot::new(current, state.revision),
                    });
                }
            }
        }

        let operation_id = state.next_operation;
        state.next_operation = OperationId::new(operation_id.get().saturating_add(1));
        // An explicit Open/Restore retry that names an existing workspace
        // transition descriptor reuses that descriptor's already-held
        // responsibility cell.  Reserving a new general cell here makes a
        // full 255-cell ledger unable to admit the very retry that would
        // release the old root.  The ticket therefore carries no second
        // reservation; completion retires the descriptor atomically.
        let reuses_transition_descriptor = matches!(
            (kind, recovery_descriptor_id),
            (AdmissionKind::Open | AdmissionKind::Restore, Some(descriptor_id))
                if state.descriptors.get(&descriptor_id).is_some_and(|descriptor| {
                    descriptor.owner == RecoveryDescriptorOwner::WorkspaceTransition
                        && !descriptor.resolved
                        && descriptor.responsibility.is_some()
                })
        );
        let responsibility = if reuses_transition_descriptor {
            None
        } else {
            match kind.responsibility_kind() {
            Some(responsibility_kind) => {
                match self.reserve_responsibility_locked(state, responsibility_kind, operation_id) {
                Ok(reservation) => Some(reservation),
                Err(LifecycleError::Responsibility(_)) => {
                    return Ok(AdmissionOutcome::NotAdmitted {
                        reason: AdmissionRejection::Capacity,
                        snapshot: LifecycleSnapshot::new(current, state.revision),
                    });
                }
                Err(error) => return Err(error),
                }
            }
            None => None,
            }
        };
        let original_binding = match &current {
            LifecycleState::Ready(binding) => Some(binding.clone()),
            LifecycleState::NoWorkspace
            | LifecycleState::Transition { .. }
            | LifecycleState::RecoveryRequired { .. }
            | LifecycleState::Closed => None,
        };
        let ticket = AdmissionTicket {
            operation_id,
            kind,
            admitted_revision: state.revision,
            original_binding,
            recovery_descriptor_id,
            responsibility,
        };
        state.admissions.insert(operation_id, ticket.clone());
        Ok(AdmissionOutcome::Admitted(ticket))
    }

    /// Admit and immediately close normal workspace admissions while a
    /// transition worker drains. This is the core-side counterpart to the old
    /// `switching.store(true)` guard.
    pub fn begin_transition(
        &self,
        kind: AdmissionKind,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        self.begin_transition_with_recovery_descriptor(kind, None, None)
    }

    /// Begin an Open/Restore transition that is an exact retry of an existing
    /// workspace-transition recovery root. The descriptor ID is carried on the
    /// ticket so the joined activation can retire that root atomically.
    pub fn begin_transition_for_recovery(
        &self,
        kind: AdmissionKind,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        self.begin_transition_with_recovery_descriptor(kind, Some(descriptor_id), None)
    }

    /// Admit Native Open only after proving that its target is not the database
    /// held by a detached C-query quarantine. The check and transition write
    /// share one lock so quarantine cannot appear between them.
    pub fn begin_open_transition_for_target(
        &self,
        locator: &str,
        workspace_id: Option<&str>,
        database_file_identity: Option<&str>,
        recovery_descriptor_id: Option<RecoveryDescriptorId>,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        self.begin_transition_with_recovery_descriptor(
            AdmissionKind::Open,
            recovery_descriptor_id,
            Some((locator, workspace_id, database_file_identity)),
        )
    }

    fn begin_transition_with_recovery_descriptor(
        &self,
        kind: AdmissionKind,
        recovery_descriptor_id: Option<RecoveryDescriptorId>,
        open_target: Option<(&str, Option<&str>, Option<&str>)>,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        if !kind.is_transition() {
            return self.admit(kind);
        }
        // Admission and the transition state write are one critical section.
        // Calling `admit` and setting Transition in separate locks would let
        // two concurrent Open/Restore requests both observe Ready and both
        // become exclusive owners.
        let mut state = self.lock_state()?;
        let outcome = if open_target.is_some_and(|(locator, workspace_id, identity)| {
            quarantines_open_target(&state, locator, workspace_id, identity)
        }) {
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(&state),
                    state.revision,
                ),
            }
        } else {
            self.admit_locked(&mut state, kind, recovery_descriptor_id, false)?
        };
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            state.open_transition_conflict = Some((
                ticket.operation_id,
                open_transition_conflicts_with_original(ticket, open_target),
            ));
            state.vetoed_transition = None;
        }
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            let draining_operations = state
                .admissions
                .values()
                .filter(|admission| {
                    admission.operation_id != ticket.operation_id
                        && !admission.kind.is_transition()
                        && !admission.kind.is_capacity_independent()
                })
                .map(|admission| admission.operation_id)
                .collect::<BTreeSet<_>>();
            for execution in state.executions.values_mut() {
                if draining_operations.contains(&execution.operation_id)
                    && matches!(
                        execution.phase,
                        ExecutionPhase::Reserved | ExecutionPhase::Started
                    )
                {
                    execution.phase = ExecutionPhase::StopRequested;
                    execution.stop_requested = true;
                }
            }
            state.state = LifecycleState::Transition {
                operation_id: ticket.operation_id,
                stage: TransitionStage::Draining,
            };
            state.revision = state.revision.saturating_add(1);
            self.inner
                .compatibility_switching
                .store(true, Ordering::SeqCst);
        }
        Ok(outcome)
    }

    pub fn set_transition_stage(
        &self,
        ticket: &AdmissionTicket,
        stage: TransitionStage,
    ) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        match state.state {
            LifecycleState::Transition { operation_id, .. }
                if operation_id == ticket.operation_id =>
            {
                state.state = LifecycleState::Transition {
                    operation_id,
                    stage,
                };
                state.revision = state.revision.saturating_add(1);
                Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
            }
            _ => Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            }),
        }
    }

    /// Record the supervisor's Join observation.  Completion/activation and
    /// recovery handoff cannot publish a binding before this point; a stop
    /// request or timeout alone is not terminal proof.
    pub fn mark_transition_joined(&self, ticket: &AdmissionTicket) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        match state.state {
            LifecycleState::Transition { operation_id, .. }
                if operation_id == ticket.operation_id =>
            {
                    state.joined_operations.insert(ticket.operation_id);
                    Ok(())
                }
            LifecycleState::Ready(_) if ticket.kind == AdmissionKind::Recover => {
                // Background descriptor recovery keeps the unrelated Ready
                // binding visible; its worker still needs an explicit Join
                // proof before the temporary admission can retire.
                state.joined_operations.insert(ticket.operation_id);
                Ok(())
            }
            LifecycleState::Transition {
                operation_id: shutdown_operation,
                stage: TransitionStage::Finishing,
            } if ticket.kind == AdmissionKind::Recover
                && shutdown_operation == OperationId::new(0)
                && state.shutdown_requested =>
            {
                // Shutdown may win after a background recovery was admitted
                // but before its worker joined.  The synthetic shutdown
                // transition is not the recovery operation id, yet the
                // exact ticket still owns the worker and must record Join so
                // completion/abandon can retire it before Closed.
                state.joined_operations.insert(ticket.operation_id);
                Ok(())
            }
            _ => Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            }),
        }
    }

    /// Mark a non-transition execution as joined after its supervisor has
    /// observed the worker exit.  This is deliberately separate from a stop
    /// request and from a dropped Future.
    pub fn mark_execution_joined(&self, ticket: &AdmissionTicket) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if ticket.kind.is_transition() {
            match state.state {
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id =>
                {
                        state.joined_operations.insert(ticket.operation_id);
                    }
                _ => {
                    return Err(LifecycleError::BindingChanged {
                        operation_id: ticket.operation_id,
                    })
                }
            }
        }
        state.joined_operations.insert(ticket.operation_id);
        if let Some(execution) = state
            .executions
            .values_mut()
            .find(|execution| execution.operation_id == ticket.operation_id)
        {
            match execution.phase {
                ExecutionPhase::Reserved
                | ExecutionPhase::Started
                | ExecutionPhase::StopRequested
                | ExecutionPhase::CleanupPending => {
                    execution.phase = ExecutionPhase::Joined;
                }
                ExecutionPhase::Joined
                | ExecutionPhase::Completed
                | ExecutionPhase::RecoveryRequired => {}
            }
        }
        Ok(())
    }

    /// Reserve the Native execution membership before spawning a worker.
    pub fn reserve_execution(
        &self,
        operation_id: OperationId,
        execution_id: ExecutionId,
    ) -> Result<ExecutionMembership, LifecycleError> {
        let mut state = self.lock_state()?;
        let ticket = state
            .admissions
            .get(&operation_id)
            .ok_or(LifecycleError::UnknownOperation(operation_id))?;
        if state.executions.contains_key(&execution_id) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let membership = ExecutionMembership {
            execution_id,
            operation_id,
            phase: ExecutionPhase::Reserved,
            binding_revision: ticket.admitted_revision,
            run: None,
            additional_runs: Vec::new(),
            stop_requested: false,
        };
        state.executions.insert(execution_id, membership.clone());
        Ok(membership)
    }

    pub fn attach_run_ownership(
        &self,
        execution_id: ExecutionId,
        run: RunOwnership,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        if !run.handle.is_exact() {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if execution.phase == ExecutionPhase::Completed {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        if let Some(existing) = &mut execution.run {
            // The durable tuple is the ownership identity. A later reader
            // may classify the same live tuple as Reused after the writer
            // first observed it as Created; that evidence transition is
            // idempotent. A cycle can also process several distinct work
            // items under this one Native execution, so retain additional
            // exact handles instead of overwriting the first one.
            if existing.handle == run.handle {
                existing.state = run.state;
                return Ok(());
            }
            if existing.state == RunCreationState::Reserved
                || (matches!(
                    existing.state,
                    RunCreationState::CreationUnknown
                        | RunCreationState::ReuseSelectionUnknown
                )
                    && run.state == RunCreationState::Reused
                    && same_run_work_identity(&existing.handle, &run.handle))
            {
                *existing = run;
                return Ok(());
            }
            if existing.state == RunCreationState::ReuseSelectionUnknown
                && run.state == RunCreationState::Reused
            {
                // A reuse result for another epoch/spec is a protocol
                // violation, never an additional occurrence to append.
                return Err(LifecycleError::InvalidExecutionTransition);
            }
            if let Some(selected) = execution
                .additional_runs
                .iter_mut()
                .find(|owned| owned.state == RunCreationState::ReuseSelectionUnknown)
            {
                if run.state == RunCreationState::Reused
                    && same_run_work_identity(&selected.handle, &run.handle)
                {
                    *selected = run;
                    return Ok(());
                }
                if run.state == RunCreationState::Reused {
                    return Err(LifecycleError::InvalidExecutionTransition);
                }
            }
            if let Some(reserved) = execution
                .additional_runs
                .iter_mut()
                .find(|owned| owned.state == RunCreationState::Reserved)
            {
                *reserved = run;
                return Ok(());
            }
            if execution
                .additional_runs
                .iter()
                .any(|owned| owned.handle == run.handle)
            {
                return Ok(());
            }
            execution.additional_runs.push(run);
        } else {
            execution.run = Some(run);
        }
        Ok(())
    }

    pub fn mark_run_creation_started(
        &self,
        execution_id: ExecutionId,
        run_id: &str,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        let Some(ownership) = execution
            .run
            .iter_mut()
            .chain(execution.additional_runs.iter_mut())
            .find(|ownership| ownership.handle.run_id == run_id)
        else {
            return Err(LifecycleError::InvalidExecutionTransition);
        };
        if ownership.state == RunCreationState::Reserved {
            ownership.state = RunCreationState::CreationUnknown;
        }
        Ok(())
    }

    pub fn mark_run_reuse_selection_unknown(
        &self,
        execution_id: ExecutionId,
        reservation_run_id: &str,
        selected_run_id: &str,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        let Some(ownership) = execution
            .run
            .iter_mut()
            .chain(execution.additional_runs.iter_mut())
            .find(|ownership| ownership.handle.run_id == reservation_run_id)
        else {
            return Err(LifecycleError::InvalidExecutionTransition);
        };
        if matches!(
            ownership.state,
            RunCreationState::Reserved | RunCreationState::CreationUnknown
        ) {
            ownership.state = RunCreationState::ReuseSelectionUnknown;
            ownership.handle.selected_reuse_run_id = Some(selected_run_id.to_owned());
        }
        Ok(())
    }

    pub fn mark_run_creation_outcome(
        &self,
        execution_id: ExecutionId,
        run_id: &str,
        outcome: RunCreationTransactionOutcome,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        let Some(ownership) = execution
            .run
            .iter_mut()
            .chain(execution.additional_runs.iter_mut())
            .find(|ownership| ownership.handle.run_id == run_id)
        else {
            return Err(LifecycleError::InvalidExecutionTransition);
        };
        match outcome {
            RunCreationTransactionOutcome::ConfirmedRollback => {
                if matches!(
                    ownership.state,
                    RunCreationState::Reserved | RunCreationState::CreationUnknown
                ) {
                    ownership.state = RunCreationState::CreationNotCommitted;
                }
            }
            RunCreationTransactionOutcome::Unknown => {
                if matches!(
                    ownership.state,
                    RunCreationState::Reserved
                        | RunCreationState::CreationNotCommitted
                        | RunCreationState::CreationUnknown
                ) {
                    ownership.state = RunCreationState::CreationUnknown;
                }
            }
        }
        Ok(())
    }

    pub fn mark_run_terminalized(
        &self,
        execution_id: ExecutionId,
        run_id: &str,
    ) -> Result<(), LifecycleError> {
        let ownership = {
            let mut state = self.lock_state()?;
            let execution = state
                .executions
                .get_mut(&execution_id)
                .ok_or(LifecycleError::UnknownExecution(execution_id))?;
            if execution
                .run
                .as_ref()
                .is_some_and(|owned| owned.handle.run_id == run_id)
            {
                execution.run.take()
            } else if let Some(index) = execution
                .additional_runs
                .iter()
                .position(|owned| owned.handle.run_id == run_id)
            {
                Some(execution.additional_runs.remove(index))
            } else {
                None
            }
        };
        let Some(ownership) = ownership else {
            return Err(LifecycleError::InvalidExecutionTransition);
        };
        crate::narrative_extraction::release_project_creation_for_handle(
            &ownership.handle.project_id,
            ownership.handle.database_path.as_deref(),
            ownership.handle.database_file_identity.as_deref(),
        );
        Ok(())
    }

    pub fn has_run_ownership(&self, execution_id: ExecutionId) -> Result<bool, LifecycleError> {
        let state = self.lock_state()?;
        let execution = state
            .executions
            .get(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        Ok(execution.run.is_some() || !execution.additional_runs.is_empty())
    }

    /// Record that the supervisor quarantined the worker-owned connection
    /// after Join. This receipt belongs to the exact execution and is copied
    /// into every recovery descriptor Run handle during transfer.
    pub fn mark_execution_connection_retired(
        &self,
        execution_id: ExecutionId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if !matches!(
            execution.phase,
            ExecutionPhase::Joined | ExecutionPhase::CleanupPending
        ) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        if let Some(run) = execution.run.as_mut() {
            run.handle.connection_retired = true;
        }
        for run in &mut execution.additional_runs {
            run.handle.connection_retired = true;
        }
        Ok(())
    }

    pub fn start_execution(&self, execution_id: ExecutionId) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let shutdown_requested = state.shutdown_requested;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if shutdown_requested
            && matches!(execution.phase, ExecutionPhase::Reserved | ExecutionPhase::StopRequested)
        {
            // A pending-start owner remains visible to the supervisor, but
            // its body must not begin after shutdown has closed admission.
            // Marking the stop request before returning lets the common
            // finalizer observe Join and retire the reservation explicitly.
            execution.phase = ExecutionPhase::StopRequested;
            execution.stop_requested = true;
            return Err(LifecycleError::Closed);
        }
        if execution.phase != ExecutionPhase::Reserved {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        execution.phase = ExecutionPhase::Started;
        Ok(())
    }

    pub fn cancel_unstarted_execution(
        &self,
        execution_id: ExecutionId,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        if state.work_executions.values().any(|work| {
            work.execution_id == execution_id && work.phase != ExecutionPhase::Completed
        }) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let shutdown_requested = state.shutdown_requested;
        let (operation_id, project_reservations) = {
            let execution = state
                .executions
                .get_mut(&execution_id)
                .ok_or(LifecycleError::UnknownExecution(execution_id))?;
            if !matches!(
                execution.phase,
                ExecutionPhase::Reserved | ExecutionPhase::StopRequested
            ) {
                return Err(LifecycleError::InvalidExecutionTransition);
            }
            if execution.phase == ExecutionPhase::Reserved && !shutdown_requested {
                return Err(LifecycleError::InvalidExecutionTransition);
            }
            execution.phase = ExecutionPhase::Completed;
            (
                execution.operation_id,
                execution
                    .run
                    .iter()
                    .chain(execution.additional_runs.iter())
                    .map(|ownership| {
                        (
                            ownership.handle.project_id.clone(),
                            ownership.handle.database_path.clone(),
                            ownership.handle.database_file_identity.clone(),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let responsibility = state
            .admissions
            .get(&operation_id)
            .and_then(|ticket| ticket.responsibility.clone());
        state.admissions.remove(&operation_id);
        state.joined_operations.remove(&operation_id);
        if let Some(reservation) = responsibility {
            Self::release_responsibility_locked(&mut state, &reservation);
        }
        for (project_id, database_path, database_file_identity) in project_reservations {
            crate::narrative_extraction::release_project_creation_for_handle(
                &project_id,
                database_path.as_deref(),
                database_file_identity.as_deref(),
            );
        }
        // A pending-start cancellation has no worker Join boundary to retain:
        // the body was never allowed to begin, and the admission, ownership
        // reservation, and any child slots have all been retired above.
        // Remove the terminal rows now so repeated shutdown/admission churn
        // cannot grow the process-local execution maps.
        state
            .work_executions
            .retain(|_, work| work.execution_id != execution_id);
        state.executions.remove(&execution_id);
        Ok(true)
    }

    pub fn request_execution_stop(&self, execution_id: ExecutionId) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        match execution.phase {
            ExecutionPhase::Reserved | ExecutionPhase::Started => {
                execution.phase = ExecutionPhase::StopRequested;
                execution.stop_requested = true;
                Ok(())
            }
            ExecutionPhase::StopRequested
            | ExecutionPhase::Joined
            | ExecutionPhase::CleanupPending
            | ExecutionPhase::Completed
            | ExecutionPhase::RecoveryRequired => Ok(()),
        }
    }

    pub fn execution_stop_requested(
        &self,
        execution_id: ExecutionId,
    ) -> Result<bool, LifecycleError> {
        let state = self.lock_state()?;
        let execution = state
            .executions
            .get(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        Ok(execution.stop_requested
            || matches!(
                execution.phase,
                ExecutionPhase::StopRequested
                    | ExecutionPhase::Joined
                    | ExecutionPhase::CleanupPending
            ))
    }

    pub fn mark_execution_cleanup_pending(
        &self,
        execution_id: ExecutionId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        // A stop request is only a request.  Cleanup may begin after the
        // supervisor has observed the worker Join; otherwise a timeout or a
        // cancellation could fabricate an execution terminal proof.
        if execution.phase != ExecutionPhase::Joined {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        execution.phase = ExecutionPhase::CleanupPending;
        Ok(())
    }

    pub fn complete_execution(&self, execution_id: ExecutionId) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        if state.work_executions.values().any(|work| {
            work.execution_id == execution_id && work.phase != ExecutionPhase::Completed
        }) {
            // A parent cannot be released while a child membership is still
            // reserved or running.  Releasing it first would let that child
            // start after the parent admission had already been retired.
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let (operation_id, project_reservations) = {
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if !matches!(
            execution.phase,
            ExecutionPhase::Joined
                | ExecutionPhase::CleanupPending
                | ExecutionPhase::RecoveryRequired
        ) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
            let project_reservations = execution
                .run
                .iter()
                .chain(execution.additional_runs.iter())
                .map(|ownership| {
                    (
                        ownership.handle.project_id.clone(),
                        ownership.handle.database_path.clone(),
                        ownership.handle.database_file_identity.clone(),
                    )
                })
                .collect::<Vec<_>>();
        let operation_id = execution.operation_id;
        execution.phase = ExecutionPhase::Completed;
            (operation_id, project_reservations)
        };
        for (project_id, database_path, database_file_identity) in project_reservations {
            crate::narrative_extraction::release_project_creation_for_handle(
                &project_id,
                database_path.as_deref(),
                database_file_identity.as_deref(),
            );
        }
        state.joined_operations.remove(&operation_id);
        Ok(())
    }

    pub fn mark_execution_recovery_required(
        &self,
        execution_id: ExecutionId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get_mut(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if !matches!(
            execution.phase,
            ExecutionPhase::Joined | ExecutionPhase::CleanupPending
        ) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        execution.phase = ExecutionPhase::RecoveryRequired;
        Ok(())
    }

    /// Transfer a joined maintenance execution into an exact recovery root.
    /// A worker that returned after creating a durable Run, or after losing
    /// connection-cleanup proof, must retain a descriptor instead of releasing
    /// its admission merely because the Rust closure returned `Err`.
    pub fn transfer_execution_to_recovery(
        &self,
        ticket: &AdmissionTicket,
        execution_id: ExecutionId,
    ) -> Result<RecoveryDescriptorId, LifecycleError> {
        self.transfer_execution_to_recovery_evidence(ticket, execution_id)
            .map(|(descriptor, _)| descriptor)
    }

    fn transfer_execution_to_recovery_evidence(
        &self,
        ticket: &AdmissionTicket,
        execution_id: ExecutionId,
    ) -> Result<(RecoveryDescriptorId, LifecycleDiagnostic), LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        let (mut run, mut additional_runs) = {
            let execution = state
                .executions
                .get(&execution_id)
                .ok_or(LifecycleError::UnknownExecution(execution_id))?;
            if execution.operation_id != ticket.operation_id
                || !matches!(
                    execution.phase,
                    ExecutionPhase::Joined | ExecutionPhase::CleanupPending
                )
            {
                return Err(LifecycleError::InvalidExecutionTransition);
            }
            (execution.run.clone(), execution.additional_runs.clone())
        };
        // A reservation is created before the DB transaction. Once the
        // worker has joined, an unpromoted slot is a CreationUnknown proof
        // obligation, never something that may be silently dropped.
        if let Some(ownership) = run.as_mut() {
            ownership.handle.worker_joined = true;
            if ownership.state == RunCreationState::Reserved {
                ownership.state = RunCreationState::CreationUnknown;
            }
        }
        for ownership in &mut additional_runs {
            ownership.handle.worker_joined = true;
            if ownership.state == RunCreationState::Reserved {
                ownership.state = RunCreationState::CreationUnknown;
            }
        }
        let descriptor_id = state.next_descriptor;
        state.next_descriptor = RecoveryDescriptorId::new(descriptor_id.get().saturating_add(1));
        let generation = state.next_generation;
        state.next_generation = ControlGeneration::new(generation.get().saturating_add(1));
        state.descriptors.insert(
            descriptor_id,
            RecoveryDescriptor {
                descriptor_id,
                root_operation_id: ticket.operation_id,
                owner: RecoveryDescriptorOwner::Maintenance,
                expected_binding: ticket.original_binding.clone(),
                run,
                additional_runs,
                responsibility: ticket.responsibility.clone(),
                control_generation: generation,
                resolved: false,
                delivery_sequences: BTreeSet::new(),
            },
        );
        state.control_slots.insert(
            descriptor_id,
            ControlSlot {
                generation,
                fingerprint: String::new(),
                payload: String::new(),
                result: None,
                acked: false,
                retired: false,
            },
        );
        if let Some(execution) = state.executions.get_mut(&execution_id) {
            execution.phase = ExecutionPhase::RecoveryRequired;
        }
        state.state = LifecycleState::RecoveryRequired { descriptor_id };
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok((descriptor_id, lifecycle_diagnostic_locked(&state)))
    }

    pub fn reserve_work_execution(
        &self,
        execution_id: ExecutionId,
        work_execution_id: WorkExecutionId,
    ) -> Result<WorkExecutionMembership, LifecycleError> {
        let mut state = self.lock_state()?;
        let execution = state
            .executions
            .get(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if !matches!(
            execution.phase,
            ExecutionPhase::Reserved | ExecutionPhase::Started
        ) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        if state.work_executions.contains_key(&work_execution_id) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let membership = WorkExecutionMembership {
            work_execution_id,
            execution_id,
            phase: ExecutionPhase::Reserved,
        };
        state
            .work_executions
            .insert(work_execution_id, membership.clone());
        Ok(membership)
    }

    fn reserve_work_for_operation(
        &self,
        operation_id: OperationId,
        work_execution_id: WorkExecutionId,
    ) -> Result<WorkExecutionMembership, LifecycleError> {
        let execution_id = {
            let state = self.lock_state()?;
            state
                .executions
                .values()
                .find(|execution| execution.operation_id == operation_id)
                .map(|execution| execution.execution_id)
                .ok_or(LifecycleError::UnknownOperation(operation_id))?
        };
        self.reserve_work_execution(execution_id, work_execution_id)
    }

    pub fn start_work_execution(
        &self,
        work_execution_id: WorkExecutionId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution_id = state
            .work_executions
            .get(&work_execution_id)
            .ok_or(LifecycleError::UnknownWorkExecution(work_execution_id))?
            .execution_id;
        let parent = state
            .executions
            .get(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if !matches!(parent.phase, ExecutionPhase::Started) || state.shutdown_requested {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let work = state
            .work_executions
            .get_mut(&work_execution_id)
            .ok_or(LifecycleError::UnknownWorkExecution(work_execution_id))?;
        if work.phase != ExecutionPhase::Reserved {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        work.phase = ExecutionPhase::Started;
        Ok(())
    }

    pub fn complete_work_execution(
        &self,
        work_execution_id: WorkExecutionId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution_id = state
            .work_executions
            .get(&work_execution_id)
            .ok_or(LifecycleError::UnknownWorkExecution(work_execution_id))?
            .execution_id;
        let execution = state
            .executions
            .get(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if execution.stop_requested || state.shutdown_requested {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let work = state
            .work_executions
            .get_mut(&work_execution_id)
            .ok_or(LifecycleError::UnknownWorkExecution(work_execution_id))?;
        if !matches!(
            work.phase,
            ExecutionPhase::Started | ExecutionPhase::Joined | ExecutionPhase::CleanupPending
        ) {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        work.phase = ExecutionPhase::Completed;
        Ok(())
    }

    /// Retire a child that never entered its body.  This is a separate
    /// operation from normal completion so a pending-start cancellation cannot
    /// be mistaken for a joined worker or a committed work result.
    pub fn cancel_reserved_work_execution(
        &self,
        work_execution_id: WorkExecutionId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let execution_id = state
            .work_executions
            .get(&work_execution_id)
            .ok_or(LifecycleError::UnknownWorkExecution(work_execution_id))?
            .execution_id;
        let execution = state
            .executions
            .get(&execution_id)
            .ok_or(LifecycleError::UnknownExecution(execution_id))?;
        if !execution.stop_requested && !state.shutdown_requested {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let work = state
            .work_executions
            .get_mut(&work_execution_id)
            .ok_or(LifecycleError::UnknownWorkExecution(work_execution_id))?;
        if work.phase != ExecutionPhase::Reserved {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        work.phase = ExecutionPhase::Completed;
        Ok(())
    }

    pub fn execution_membership(
        &self,
        execution_id: ExecutionId,
    ) -> Result<ExecutionMembership, LifecycleError> {
        self.lock_state()?
            .executions
            .get(&execution_id)
            .cloned()
            .ok_or(LifecycleError::UnknownExecution(execution_id))
    }

    /// Test/diagnostic view of the live membership ledgers.  Completed
    /// executions are removed at admission release; this keeps the bounded
    /// lifecycle core from growing with every successful maintenance cycle.
    pub fn execution_membership_counts(&self) -> Result<(usize, usize), LifecycleError> {
        let state = self.lock_state()?;
        Ok((state.executions.len(), state.work_executions.len()))
    }

    /// Acquire the core-side marker that must be paired with Native's real
    /// open_lock/file-lease guard.  It is never inferred from a snapshot.
    fn acquire_physical_exclusive(&self, ticket: &AdmissionTicket) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if !matches!(
            state.state,
            LifecycleState::Transition { operation_id, .. }
                if operation_id == ticket.operation_id
        ) {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        if state.vetoed_transition == Some(ticket.operation_id) {
            return Err(LifecycleError::TransitionVetoed {
                operation_id: ticket.operation_id,
            });
        }
        // Restore targets its admitted W1 binding even if the caller supplies
        // an exclusive file lease that bypasses the retained shared lease.
        if ticket.kind == AdmissionKind::Restore
            && ticket
                .original_binding
                .as_ref()
                .is_some_and(|binding| quarantines_workspace(&state, binding))
        {
            return Err(LifecycleError::ActiveOperations);
        }
        if state.admissions.values().any(|admission| {
            admission.operation_id != ticket.operation_id
                && !admission.kind.is_capacity_independent()
        }) || state.executions.values().any(|execution| {
            execution.operation_id != ticket.operation_id
                && execution.phase != ExecutionPhase::Completed
                && execution.phase != ExecutionPhase::RecoveryRequired
        }) || state.workspace_participants != 0 {
            // Stop requests are not terminal proof.  The Native supervisor
            // retries this boundary after every participant has joined and
            // cleaned up, so replacement cannot begin against a live DB
            // transaction or statement.
            return Err(LifecycleError::ActiveOperations);
        }
        if !state
            .physical_exclusive_operations
            .insert(ticket.operation_id)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        Ok(())
    }

    pub fn transition_vetoed(&self, ticket: &AdmissionTicket) -> Result<bool, LifecycleError> {
        let state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        Ok(state.vetoed_transition == Some(ticket.operation_id))
    }

    /// Acquire the core-side physical exclusion for a Native supervisor that
    /// already owns the exact transition ticket.  The Native owner pairs this
    /// marker with its real `open_lock`/file-lease guard for the protected
    /// worker interval.
    pub fn physical_exclusive_for_ticket(
        &self,
        ticket: &AdmissionTicket,
    ) -> Result<WorkspaceExclusive, LifecycleError> {
        self.acquire_physical_exclusive(ticket)?;
        Ok(WorkspaceExclusive {
            core: self.clone(),
            operation_id: ticket.operation_id,
        })
    }

    fn release_physical_exclusive(
        &self,
        operation_id: OperationId,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        Ok(state.physical_exclusive_operations.remove(&operation_id))
    }

    /// Finish an admitted operation as `Unchanged`. The old binding must still
    /// be the exact live authority. A reopened authority, even on the same
    /// path and with the same bytes, must use `Activated` instead.
    pub fn complete_unchanged(
        &self,
        ticket: &AdmissionTicket,
        binding: LiveBinding,
    ) -> Result<LifecycleResult, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition() {
            return Err(LifecycleError::InvalidState);
        }
        if state.vetoed_transition == Some(ticket.operation_id) {
            return Err(LifecycleError::TransitionVetoed {
                operation_id: ticket.operation_id,
            });
        }
        let exact_original_binding = ticket.original_binding.as_ref() == Some(&binding);
        let joined = state.joined_operations.contains(&ticket.operation_id);
        let exact = exact_original_binding
            && matches!(
                state.state,
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id && joined
            );
        if state.shutdown_requested || !exact || quarantines_workspace(&state, &binding) {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        if state.admissions.values().any(|admission| {
            admission.operation_id != ticket.operation_id
                && !admission.kind.is_capacity_independent()
        }) || state.executions.values().any(|execution| {
            execution.operation_id != ticket.operation_id
                && execution.phase != ExecutionPhase::Completed
                && execution.phase != ExecutionPhase::RecoveryRequired
        }) || state
            .physical_exclusive_operations
            .contains(&ticket.operation_id)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        if matches!(ticket.kind, AdmissionKind::Open | AdmissionKind::Restore) {
            if let Some(descriptor_id) = ticket.recovery_descriptor_id {
                Self::complete_workspace_transition_recovery_locked(
                    &mut state,
                    descriptor_id,
                    &binding,
                )?;
            }
        }
        state.state = LifecycleState::Ready(binding.clone());
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
        clear_transition_metadata_locked(&mut state, ticket.operation_id);
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleResult::Unchanged {
            operation_id: ticket.operation_id,
            binding,
            state_revision: state.revision,
        })
    }

    pub fn activate(
        &self,
        ticket: &AdmissionTicket,
        binding: LiveBinding,
        content_effect: ContentEffect,
    ) -> Result<LifecycleResult, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition() {
            return Err(LifecycleError::InvalidState);
        }
        if state.vetoed_transition == Some(ticket.operation_id) {
            return Err(LifecycleError::TransitionVetoed {
                operation_id: ticket.operation_id,
            });
        }
        if matches!(state.state, LifecycleState::Closed) {
            return Err(LifecycleError::Closed);
        }
        if state.shutdown_requested {
            return Err(LifecycleError::Closed);
        }
        if quarantines_workspace(&state, &binding) {
            return Err(LifecycleError::ActiveOperations);
        }
        if !matches!(
            state.state,
            LifecycleState::Transition { operation_id, .. }
                if operation_id == ticket.operation_id
        ) {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        if !state.joined_operations.contains(&ticket.operation_id) {
            return Err(LifecycleError::NotJoined(ticket.operation_id));
        }
        if state.admissions.values().any(|admission| {
            admission.operation_id != ticket.operation_id
                && !admission.kind.is_capacity_independent()
        }) || state.executions.values().any(|execution| {
            execution.operation_id != ticket.operation_id
                && execution.phase != ExecutionPhase::Completed
                && execution.phase != ExecutionPhase::RecoveryRequired
        }) || state
            .physical_exclusive_operations
            .contains(&ticket.operation_id)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        if matches!(ticket.kind, AdmissionKind::Open | AdmissionKind::Restore) {
            if let Some(descriptor_id) = ticket.recovery_descriptor_id {
                Self::complete_workspace_transition_recovery_locked(
                    &mut state,
                    descriptor_id,
                    &binding,
                )?;
            }
        }
        state.state = LifecycleState::Ready(binding.clone());
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
        clear_transition_metadata_locked(&mut state, ticket.operation_id);
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleResult::Activated {
            operation_id: ticket.operation_id,
            binding,
            activation: ActivationState::Ready,
            content_effect,
            state_revision: state.revision,
        })
    }

    pub fn require_recovery(
        &self,
        ticket: &AdmissionTicket,
        expected_binding: Option<LiveBinding>,
        run: Option<RunOwnership>,
    ) -> Result<(RecoveryDescriptorId, LifecycleResult), LifecycleError> {
        self.require_recovery_locked(self.lock_state()?, ticket, expected_binding, run)
    }

    fn require_recovery_locked(
        &self,
        mut state: MutexGuard<'_, CoreState>,
        ticket: &AdmissionTicket,
        expected_binding: Option<LiveBinding>,
        run: Option<RunOwnership>,
    ) -> Result<(RecoveryDescriptorId, LifecycleResult), LifecycleError> {
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition() {
            return Err(LifecycleError::InvalidState);
        }
        let vetoed = state.vetoed_transition == Some(ticket.operation_id);
        let expected_binding = if vetoed {
            ticket.original_binding.clone()
        } else {
            expected_binding
        };
        if !matches!(
            state.state,
            LifecycleState::Transition { operation_id, .. }
                if operation_id == ticket.operation_id
        ) {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        if !state.joined_operations.contains(&ticket.operation_id) {
            return Err(LifecycleError::NotJoined(ticket.operation_id));
        }
        // A failed descriptor-bound recovery returns to the same root.  Keep
        // its identity, responsibility cell, and control slot; allocating a
        // second descriptor here would strand the first cell and make the
        // next retry look like an unrelated recovery.
        if let Some(existing_id) = ticket.recovery_descriptor_id {
            if existing_id == SAFE_MODE_RECOVERY_DESCRIPTOR_ID
                && !state.descriptors.contains_key(&existing_id)
            {
                // Safe Mode's root is durable outside this process and has no
                // ordinary descriptor/control slot. Completing the admitted
                // recovery publishes that root directly instead of failing
                // with UnknownDescriptor after the worker has joined.
                state.state = LifecycleState::RecoveryRequired {
                    descriptor_id: existing_id,
                };
                clear_transition_metadata_locked(&mut state, ticket.operation_id);
                state.admissions.remove(&ticket.operation_id);
                state.joined_operations.remove(&ticket.operation_id);
                if let Some(reservation) = &ticket.responsibility {
                    Self::release_responsibility_locked(&mut state, reservation);
                }
                state.revision = state.revision.saturating_add(1);
                self.inner
                    .compatibility_switching
                    .store(false, Ordering::SeqCst);
                return Ok((
                    existing_id,
                    LifecycleResult::RecoveryRequired {
                        operation_id: ticket.operation_id,
                        descriptor_id: existing_id,
                        state_revision: state.revision,
                    },
                ));
            }
            {
                let descriptor = state
                    .descriptors
                    .get_mut(&existing_id)
                    .ok_or(LifecycleError::UnknownDescriptor(existing_id))?;
                if descriptor.resolved && descriptor.responsibility.is_none() {
                    return Err(LifecycleError::RetiredDescriptor(existing_id));
                }
                // The descriptor root is immutable. A recovery ticket admitted
                // while another workspace (for example W2) is Ready carries the
                // current UI binding in `original_binding`; that binding is not
                // evidence that this W1 descriptor changed owners. Only a legacy
                // descriptor with no captured binding may be completed with the
                // ticket's binding.
                if descriptor.expected_binding.is_none() {
                    descriptor.expected_binding = expected_binding;
                }
                if run.is_some() {
                    descriptor.run = run;
                }
            }
            Self::release_temporary_responsibility_locked(
                &mut state,
                ticket,
                Some(existing_id),
            );
            state.state = LifecycleState::RecoveryRequired {
                descriptor_id: existing_id,
            };
            clear_transition_metadata_locked(&mut state, ticket.operation_id);
            state.admissions.remove(&ticket.operation_id);
            state.joined_operations.remove(&ticket.operation_id);
            state.revision = state.revision.saturating_add(1);
            self.inner
                .compatibility_switching
                .store(false, Ordering::SeqCst);
            return Ok((
                existing_id,
                LifecycleResult::RecoveryRequired {
                    operation_id: ticket.operation_id,
                    descriptor_id: existing_id,
                    state_revision: state.revision,
                },
            ));
        }
        let descriptor_id = state.next_descriptor;
        state.next_descriptor = RecoveryDescriptorId::new(descriptor_id.get().saturating_add(1));
        let generation = state.next_generation;
        state.next_generation = ControlGeneration::new(generation.get().saturating_add(1));
        let descriptor = RecoveryDescriptor {
            descriptor_id,
            root_operation_id: ticket.operation_id,
            owner: RecoveryDescriptorOwner::WorkspaceTransition,
            expected_binding,
            run,
            additional_runs: Vec::new(),
            responsibility: ticket.responsibility.clone(),
            control_generation: generation,
            resolved: false,
            delivery_sequences: BTreeSet::new(),
        };
        state.descriptors.insert(descriptor_id, descriptor);
        state.control_slots.insert(
            descriptor_id,
            ControlSlot {
                generation,
                fingerprint: String::new(),
                payload: String::new(),
                result: None,
                acked: false,
                retired: false,
            },
        );
        state.state = LifecycleState::RecoveryRequired { descriptor_id };
        clear_transition_metadata_locked(&mut state, ticket.operation_id);
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        // The descriptor now carries the recovery responsibility. Its cell is
        // deliberately retained until the descriptor root is resolved.
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        let result = LifecycleResult::RecoveryRequired {
            operation_id: ticket.operation_id,
            descriptor_id,
            state_revision: state.revision,
        };
        Ok((descriptor_id, result))
    }

    pub fn control_request(
        &self,
        descriptor_id: RecoveryDescriptorId,
        request: &ControlRequest,
    ) -> Result<ControlSlotOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        let Some(slot) = state.control_slots.get_mut(&descriptor_id) else {
            return if is_retired_descriptor_locked(&state, descriptor_id) {
                Ok(ControlSlotOutcome::Retired)
            } else {
                Err(LifecycleError::UnknownDescriptor(descriptor_id))
            };
        };
        if slot.retired {
            return Ok(ControlSlotOutcome::Retired);
        }
        if request.generation != slot.generation {
            return Err(LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation: request.generation,
            });
        }
        if slot.fingerprint.is_empty() {
            slot.fingerprint = request.fingerprint.clone();
            slot.payload = request.payload.clone();
            return Ok(ControlSlotOutcome::Accepted {
                generation: slot.generation,
            });
        }
        if slot.fingerprint != request.fingerprint || slot.payload != request.payload {
            return Ok(ControlSlotOutcome::Conflict {
                generation: slot.generation,
            });
        }
        Ok(ControlSlotOutcome::Replay {
            generation: slot.generation,
            result: slot.result.clone(),
        })
    }

    pub fn complete_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        generation: ControlGeneration,
        result: impl Into<String>,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let slot = state
            .control_slots
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if slot.generation != generation || slot.retired {
            return Err(LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation,
            });
        }
        let result = result.into();
        if let Some(existing) = &slot.result {
            if existing != &result {
                return Err(LifecycleError::ControlResultConflict(descriptor_id));
            }
        } else {
            slot.result = Some(result);
        }
        Ok(())
    }

    /// Advance a failed control attempt without allocating a new descriptor
    /// or responsibility cell.  The prior result has already been transport
    /// ACKed, so retaining its full body would make retry memory grow with the
    /// number and size of generations without providing a replay path.
    pub fn retry_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<ControlGeneration, LifecycleError> {
        let mut state = self.lock_state()?;
        let descriptor_unresolved = !state
            .descriptors
            .get(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?
            .resolved;
        if !descriptor_unresolved {
            return Err(LifecycleError::RetiredDescriptor(descriptor_id));
        }
        let slot = state
            .control_slots
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        // A result is part of the observable control generation until its
        // transport ACK is received.  Advancing the generation while it is
        // unACKed would overwrite the only replayable result and could let an
        // old callback be mistaken for a fresh recovery request.
        if !slot.acked || !slot.retired {
            return Err(LifecycleError::ControlResultPending(descriptor_id));
        }
        let previous_result = slot
            .result
            .take()
            .ok_or(LifecycleError::ControlResultPending(descriptor_id))?;
        drop(previous_result);
        slot.generation = ControlGeneration::new(slot.generation.get().saturating_add(1));
        slot.fingerprint.clear();
        slot.payload.clear();
        slot.acked = false;
        slot.retired = false;
        Ok(slot.generation)
    }

    /// Resolve the descriptor root only after the control result proves that
    /// the exact Run/workspace responsibility was durably handled.  Recording
    /// a failed or retryable control result alone never releases the root.
    pub fn resolve_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        generation: ControlGeneration,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let slot = state
            .control_slots
            .get(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if slot.generation != generation || slot.retired {
            return Err(LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation,
            });
        }
        if slot.result.is_none() {
            return Err(LifecycleError::ControlResultPending(descriptor_id));
        }
        let descriptor = state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        descriptor.resolved = true;
        Ok(())
    }

    pub fn ack_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        generation: ControlGeneration,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let slot = state
            .control_slots
            .get(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if slot.generation != generation || slot.retired {
            return Err(LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation,
            });
        }
        if slot.result.is_none() {
            return Err(LifecycleError::ControlResultPending(descriptor_id));
        }
        let slot = state
            .control_slots
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        slot.acked = true;
        slot.retired = true;
        Ok(())
    }

    pub fn descriptor(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<RecoveryDescriptor, LifecycleError> {
        let state = self.lock_state()?;
        state
            .descriptors
            .get(&descriptor_id)
            .cloned()
            .ok_or_else(|| {
                if is_retired_descriptor_locked(&state, descriptor_id) {
                    LifecycleError::RetiredDescriptor(descriptor_id)
                } else {
                    LifecycleError::UnknownDescriptor(descriptor_id)
                }
            })
    }

    /// Replace a reuse-selection placeholder with the exact durable tuple
    /// recovered by its selected Run ID. WorkKey matching is deliberately not
    /// accepted here because another occurrence may share that key.
    pub fn attach_reuse_selection_to_descriptor(
        &self,
        descriptor_id: RecoveryDescriptorId,
        run: RunOwnership,
    ) -> Result<(), LifecycleError> {
        if run.state != RunCreationState::Reused {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        let mut state = self.lock_state()?;
        let descriptor = state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        let mut matched = false;
        if let Some(existing) = descriptor
            .run
            .as_mut()
            .filter(|existing| existing.state == RunCreationState::ReuseSelectionUnknown)
        {
            if existing.handle.selected_reuse_run_id.as_deref()
                == Some(run.handle.run_id.as_str())
                && same_run_work_identity(&existing.handle, &run.handle)
            {
                *existing = run.clone();
                matched = true;
            }
        }
        if !matched {
            for existing in &mut descriptor.additional_runs {
                if existing.state == RunCreationState::ReuseSelectionUnknown
                    && existing.handle.selected_reuse_run_id.as_deref()
                        == Some(run.handle.run_id.as_str())
                    && same_run_work_identity(&existing.handle, &run.handle)
                {
                    *existing = run.clone();
                    if matched {
                        return Err(LifecycleError::InvalidExecutionTransition);
                    }
                    matched = true;
                }
            }
        }
        if !matched {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        Ok(())
    }

    /// Publish a connection-retirement receipt after a quarantined close
    /// retry succeeds. The descriptor root remains live until this proof is
    /// present, so absence resolution cannot race an old worker connection.
    pub fn mark_descriptor_connection_retired(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        let descriptor = state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if let Some(run) = descriptor.run.as_mut() {
            run.handle.connection_retired = true;
        }
        for run in &mut descriptor.additional_runs {
            run.handle.connection_retired = true;
        }
        Ok(())
    }

    /// Return unresolved descriptor roots for the Native recovery supervisor.
    /// The values are copied under the core lock; no authority or transport
    /// state is exposed through this helper.
    pub fn unresolved_descriptor_ids(&self) -> Result<Vec<RecoveryDescriptorId>, LifecycleError> {
        Ok(self
            .lock_state()?
            .descriptors
            .values()
            .filter(|descriptor| !descriptor.resolved || descriptor.responsibility.is_some())
            .map(|descriptor| descriptor.descriptor_id)
            .collect())
    }

    /// Bind a transport record to the exact descriptor root before the result
    /// is published.  ACK retirement removes only the record; the descriptor
    /// retains its independent responsibility until its own resolution.
    pub fn attach_descriptor_delivery(
        &self,
        descriptor_id: RecoveryDescriptorId,
        sequence: DeliverySequence,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        if !state.control_slots.contains_key(&descriptor_id) {
            return Err(LifecycleError::UnknownDescriptor(descriptor_id));
        }
        if !state.delivery.records.contains_key(&sequence)
            && !state.delivery.fenced.contains(&sequence)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?
            .delivery_sequences
            .insert(sequence);
        Ok(())
    }

    /// Release the responsibility cell after the descriptor's exact root has
    /// been durably resolved and its control result/delivery references have
    /// been acknowledged. Heavy descriptor/control state is reclaimed here;
    /// a bounded tombstone preserves stale-retry semantics.
    pub fn release_descriptor_responsibility(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        Self::release_descriptor_responsibility_locked(&mut state, descriptor_id)
    }

    fn release_descriptor_responsibility_locked(
        state: &mut CoreState,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<bool, LifecycleError> {
        let slot = state
            .control_slots
            .get(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        let descriptor = state
            .descriptors
            .get(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if !descriptor.resolved || !slot.acked || !slot.retired {
            return Err(LifecycleError::ActiveOperations);
        }
        if descriptor
            .delivery_sequences
            .iter()
            .any(|sequence| state.delivery.records.contains_key(sequence))
        {
            return Err(LifecycleError::ActiveOperations);
        }
        let root_operation_id = descriptor.root_operation_id;
        let project_reservations = descriptor
            .run
            .iter()
            .chain(descriptor.additional_runs.iter())
            .map(|ownership| {
                (
                    ownership.handle.project_id.clone(),
                    ownership.handle.database_path.clone(),
                    ownership.handle.database_file_identity.clone(),
                )
            })
            .collect::<Vec<_>>();
        let reservation = state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?
            .responsibility
            .take();
        // A maintenance execution transferred to this descriptor remains in
        // the execution ledger as RecoveryRequired until the exact root is
        // resolved. Retiring the descriptor is the corresponding terminal
        // proof for that execution; otherwise shutdown would retain a phantom
        // owner forever.
        for execution in state.executions.values_mut() {
            if execution.operation_id == root_operation_id
                && execution.phase == ExecutionPhase::RecoveryRequired
            {
                execution.phase = ExecutionPhase::Completed;
            }
        }
        let retired_execution_ids = state
            .executions
            .values()
            .filter(|execution| {
                execution.operation_id == root_operation_id
                    && execution.phase == ExecutionPhase::Completed
            })
            .map(|execution| execution.execution_id)
            .collect::<Vec<_>>();
        for execution_id in retired_execution_ids {
            state
                .work_executions
                .retain(|_, work| work.execution_id != execution_id);
            state.executions.remove(&execution_id);
        }
        for (project_id, database_path, database_file_identity) in project_reservations {
            crate::narrative_extraction::release_project_creation_for_handle(
                &project_id,
                database_path.as_deref(),
                database_file_identity.as_deref(),
            );
        }
        let released = reservation
            .as_ref()
            .map(|value| Self::release_responsibility_locked(state, value))
            .unwrap_or(false);
        // The transport/control receipt has already been ACKed and retired at
        // this point, so retaining the full descriptor (Run handles, sealed
        // specs, and completed generation history) only grows the process
        // ledger. The monotonic descriptor allocator supplies the permanent
        // retired tombstone after both heavy maps are reclaimed.
        state.descriptors.remove(&descriptor_id);
        state.control_slots.remove(&descriptor_id);
        Ok(released)
    }

    /// Complete the exact workspace-transition descriptor that caused an
    /// Open retry to enter RecoveryRequired. The replacement authority is
    /// already published by the same joined transition, so this path can
    /// atomically acknowledge and retire the descriptor without routing it
    /// through the maintenance recovery lane. Run-bearing descriptors are
    /// never silently discarded; they remain an explicit recovery error.
    pub fn complete_workspace_transition_recovery(
        &self,
        descriptor_id: RecoveryDescriptorId,
        binding: LiveBinding,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        Self::complete_workspace_transition_recovery_locked(&mut state, descriptor_id, &binding)
    }

    fn complete_workspace_transition_recovery_locked(
        state: &mut CoreState,
        descriptor_id: RecoveryDescriptorId,
        binding: &LiveBinding,
    ) -> Result<bool, LifecycleError> {
        let descriptor = state
            .descriptors
            .get(&descriptor_id)
            .ok_or_else(|| {
                if is_retired_descriptor_locked(state, descriptor_id) {
                    LifecycleError::RetiredDescriptor(descriptor_id)
                } else {
                    LifecycleError::UnknownDescriptor(descriptor_id)
                }
            })?;
        if descriptor.owner != RecoveryDescriptorOwner::WorkspaceTransition {
            return Err(LifecycleError::InvalidState);
        }
        let Some(expected_binding) = descriptor.expected_binding.as_ref() else {
            return Err(LifecycleError::BindingChanged {
                operation_id: descriptor.root_operation_id,
            });
        };
        // A descriptor-bound retry may rotate the process-local authority
        // instance, but it must still prove the same canonical locator and
        // durable workspace identity captured when the candidate failed.
        // This check is deliberately performed while the completion lock is
        // held, after the replacement lease/authority has been installed, so
        // a preflight path check cannot retire an old root for a newly
        // replaced workspace at the same path.
        if expected_binding.locator != binding.locator
            || expected_binding.workspace_id != binding.workspace_id
        {
            return Err(LifecycleError::BindingChanged {
                operation_id: descriptor.root_operation_id,
            });
        }
        if descriptor.run.is_some() || !descriptor.additional_runs.is_empty() {
            return Err(LifecycleError::ActiveOperations);
        }
        let generation = descriptor.control_generation;
        let descriptor = state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        descriptor.resolved = true;
        let slot = state
            .control_slots
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if slot.generation != generation {
            return Err(LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation,
            });
        }
        slot.fingerprint = format!("workspace-transition-open:{descriptor_id}");
        slot.payload = "activated".to_owned();
        slot.result = Some("activated".to_owned());
        slot.acked = true;
        slot.retired = true;
        Self::release_descriptor_responsibility_locked(state, descriptor_id)
    }

    pub fn admit_delivery(
        &self,
        fingerprint: impl Into<String>,
    ) -> Result<DeliveryAdmissionOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        let sequence = DeliverySequence::new(state.delivery.high_water.get().saturating_add(1));
        self.admit_delivery_locked(&mut state, sequence, fingerprint.into())
    }

    pub fn admit_delivery_at(
        &self,
        sequence: DeliverySequence,
        fingerprint: impl Into<String>,
    ) -> Result<DeliveryAdmissionOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        self.admit_delivery_locked(&mut state, sequence, fingerprint.into())
    }

    fn admit_delivery_locked(
        &self,
        state: &mut CoreState,
        sequence: DeliverySequence,
        fingerprint: String,
    ) -> Result<DeliveryAdmissionOutcome, LifecycleError> {
        let expected = DeliverySequence::new(state.delivery.high_water.get().saturating_add(1));
        if sequence.get() <= state.delivery.high_water.get() {
            if let Some(record) = state.delivery.records.get(&sequence) {
                return Ok(if record.fingerprint == fingerprint {
                    DeliveryAdmissionOutcome::Replay {
                        sequence,
                        result: record.result.clone(),
                    }
                } else {
                    DeliveryAdmissionOutcome::Conflict { sequence }
                });
            }
            return Ok(DeliveryAdmissionOutcome::SealedAbsent { sequence });
        }
        if sequence != expected {
            return Ok(DeliveryAdmissionOutcome::OutOfOrder {
                expected,
                received: sequence,
            });
        }
        if state.delivery.records.len() >= DELIVERY_CAPACITY {
            // Capacity is a temporary admission condition.  This call does
            // not send a Native fence, so consuming H+1 here would leave the
            // shared core permanently ahead of main after an ACK frees a
            // record.  Leave the sequence untouched and let the exact retry
            // be admitted once capacity is available.
            return Ok(DeliveryAdmissionOutcome::Full {
                next_sequence: sequence,
            });
        }
        state.delivery.high_water = sequence;
        state.delivery.records.insert(
            sequence,
            DeliveryRecord {
                fingerprint,
                terminal: false,
                acked: false,
                result: None,
            },
        );
        Ok(DeliveryAdmissionOutcome::Accepted { sequence })
    }

    /// Mark the result terminal before main is allowed to ACK and retire the
    /// delivery record.  ACK is a transport acknowledgement; it must never
    /// be able to retire an admitted-but-unsettled execution.
    pub fn mark_delivery_terminal(
        &self,
        sequence: DeliverySequence,
    ) -> Result<bool, LifecycleError> {
        self.mark_delivery_terminal_with_result(sequence, None)
    }

    /// Publish the exact terminal result before main may ACK the delivery.
    /// Keeping this in the shared core makes a lost N-API response replayable
    /// while the record remains unacknowledged, without re-running the work.
    pub fn mark_delivery_terminal_with_result(
        &self,
        sequence: DeliverySequence,
        result: Option<String>,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        let Some(record) = state.delivery.records.get_mut(&sequence) else {
            return Ok(false);
        };
        if record.terminal {
            let compatible = result.is_none() || record.result.as_ref() == result.as_ref();
            if compatible {
                return Ok(true);
            }
            return Err(LifecycleError::DeliveryResultConflict(sequence));
        }
        record.terminal = true;
        record.result = result;
        Ok(true)
    }

    /// Seal the next sequence without allocating a delivery record. This is
    /// the capacity-independent path used to resolve a lost admission reply.
    pub fn resolve_or_fence(
        &self,
        sequence: DeliverySequence,
    ) -> Result<FenceOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        let expected = DeliverySequence::new(state.delivery.high_water.get().saturating_add(1));
        if sequence != expected {
            return Ok(
                if sequence.get() <= state.delivery.high_water.get()
                    && state.delivery.fenced.contains(&sequence)
                {
                    FenceOutcome::AlreadyFenced { sequence }
                } else {
                    FenceOutcome::OutOfOrder {
                        expected,
                        received: sequence,
                    }
                },
            );
        }
        state.delivery.high_water = sequence;
        state.delivery.fenced.insert(sequence);
        Ok(FenceOutcome::Fenced { sequence })
    }

    pub fn ack_delivery(&self, sequence: DeliverySequence) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        let Some(record) = state.delivery.records.get_mut(&sequence) else {
            // A fenced sequence deliberately has no DeliveryRecord.  ACKing
            // that record-less terminal is still a valid transport retirement
            // and must not leave main waiting forever for a record that was
            // never admitted.
            if state.delivery.fenced.remove(&sequence) {
                state.delivery.mark_retired(sequence);
                return Ok(true);
            }
            return Ok(state.delivery.is_retired(sequence));
        };
        if !record.terminal {
            return Ok(false);
        }
        record.acked = true;
        state.delivery.records.remove(&sequence);
        state.delivery.mark_retired(sequence);
        Ok(true)
    }

    pub fn delivery_high_water(&self) -> Result<DeliverySequence, LifecycleError> {
        Ok(self.lock_state()?.delivery.high_water)
    }

    pub fn reserve_responsibility(
        &self,
        kind: ResponsibilityKind,
        root_operation_id: OperationId,
    ) -> Result<ResponsibilityReservation, LifecycleError> {
        let mut state = self.lock_state()?;
        self.reserve_responsibility_locked(&mut state, kind, root_operation_id)
    }

    fn reserve_responsibility_locked(
        &self,
        state: &mut CoreState,
        kind: ResponsibilityKind,
        root_operation_id: OperationId,
    ) -> Result<ResponsibilityReservation, LifecycleError> {
        let ledger = &mut state.responsibilities;
        let id = ledger.next_id;
        ledger.next_id = ResponsibilityId::new(id.get().saturating_add(1));
        let reservation = ResponsibilityReservation {
            id,
            kind,
            root_operation_id,
        };
        if kind.uses_emergency_cell() {
            if ledger.emergency.is_some() {
                return Err(LifecycleError::Responsibility(
                    ResponsibilityError::EmergencyCapacity,
                ));
            }
            ledger.emergency = Some(reservation.clone());
        } else {
            if ledger.general.len() >= GENERAL_RESPONSIBILITY_CAPACITY {
                return Err(LifecycleError::Responsibility(
                    ResponsibilityError::GeneralCapacity,
                ));
            }
            ledger.general.insert(id, reservation.clone());
        }
        Ok(reservation)
    }

    fn release_responsibility_locked(
        state: &mut CoreState,
        reservation: &ResponsibilityReservation,
    ) -> bool {
        if reservation.kind.uses_emergency_cell() {
            if state
                .responsibilities
                .emergency
                .as_ref()
                .map(|value| value.id == reservation.id)
                .unwrap_or(false)
            {
                state.responsibilities.emergency = None;
                return true;
            }
            return false;
        }
        state
            .responsibilities
            .general
            .remove(&reservation.id)
            .is_some()
    }

    /// A descriptor-bound retry normally carries no fresh reservation. Keep
    /// this guard for legacy/test tickets and future emergency continuations:
    /// when the descriptor already owns the exact cell, preserve it; any
    /// temporary reservation attached only to the retry must be released on a
    /// failed handoff so each retry can make progress under the 256-cell cap.
    fn release_temporary_responsibility_locked(
        state: &mut CoreState,
        ticket: &AdmissionTicket,
        descriptor_id: Option<RecoveryDescriptorId>,
    ) {
        let Some(reservation) = ticket.responsibility.as_ref() else {
            return;
        };
        let descriptor_owns_reservation = descriptor_id
            .and_then(|id| state.descriptors.get(&id))
            .and_then(|descriptor| descriptor.responsibility.as_ref())
            .is_some_and(|owned| owned.id == reservation.id);
        if !descriptor_owns_reservation {
            Self::release_responsibility_locked(state, reservation);
        }
    }

    pub fn release_responsibility(
        &self,
        reservation: &ResponsibilityReservation,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        Ok(Self::release_responsibility_locked(&mut state, reservation))
    }

    pub fn responsibility_counts(&self) -> Result<(usize, bool), LifecycleError> {
        let state = self.lock_state()?;
        Ok((
            state.responsibilities.general.len(),
            state.responsibilities.emergency.is_some(),
        ))
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, CoreState>, LifecycleError> {
        self.inner
            .state
            .lock()
            .map_err(|_| LifecycleError::Poisoned)
    }

    fn projected_state_locked(&self, state: &CoreState) -> LifecycleState {
        if self.inner.compatibility_switching.load(Ordering::SeqCst) {
            match state.state {
                LifecycleState::Closed => LifecycleState::Closed,
                LifecycleState::Transition {
                    operation_id,
                    stage,
                } => LifecycleState::Transition {
                    operation_id,
                    stage,
                },
                _ => LifecycleState::Transition {
                    operation_id: OperationId::new(0),
                    stage: TransitionStage::Draining,
                },
            }
        } else {
            state.state.clone()
        }
    }

    fn require_ticket_locked(
        &self,
        state: &CoreState,
        ticket: &AdmissionTicket,
    ) -> Result<(), LifecycleError> {
        match state.admissions.get(&ticket.operation_id) {
            Some(current) if current == ticket => Ok(()),
            Some(_) => Err(LifecycleError::WrongOperation(ticket.operation_id)),
            None => Err(LifecycleError::UnknownOperation(ticket.operation_id)),
        }
    }
}

impl Default for WorkspaceLifecycleCompatibilityView {
    fn default() -> Self {
        Self::new(false)
    }
}

impl WorkspaceLifecycleCompatibilityView {
    pub fn new(initial_switching: bool) -> Self {
        let core = WorkspaceLifecycleCore::new();
        let view = core.compatibility_view();
        view.store(initial_switching, Ordering::SeqCst);
        view
    }

    pub fn core(&self) -> WorkspaceLifecycleCore {
        WorkspaceLifecycleCore {
            inner: Arc::clone(&self.inner),
        }
    }

    pub fn load(&self, order: Ordering) -> bool {
        self.inner.compatibility_switching.load(order)
    }

    pub fn store(&self, value: bool, order: Ordering) {
        // The legacy opener still drops a `SwitchingGuard` independently of
        // the shared lifecycle supervisor.  It may clear the compatibility
        // projection while a real transition ticket is still waiting for Join;
        // never let that legacy write reopen the normal DB boundary.  The
        // authoritative state remains in `CoreState` until activate/recovery
        // completion.
        // Both directions share the final-dispatch guard. Checking state
        // under the mutex and writing the atomic after dropping it would
        // still permit a switching/claim race.
        let Ok(state) = self.inner.state.lock() else {
            // Fail closed on poison, including a request to close admission.
            self.inner.compatibility_switching.store(true, order);
            return;
        };
        if !value
            && (matches!(state.state, LifecycleState::Transition { .. })
                || !state.joined_operations.is_empty()
                || state
                    .admissions
                    .values()
                    .any(|ticket| ticket.kind.is_transition()))
        {
            return;
        }
        self.inner.compatibility_switching.store(value, order);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(instance: u64) -> LiveBinding {
        LiveBinding::new("/tmp/workspace", "workspace-1", instance, 1)
            .with_main_database_file_identity(format!("test-db-{instance}"))
    }

    fn run_handle(run_id: &str, work_key: &str) -> DurableRunHandle {
        DurableRunHandle::new(
            "project-1",
            run_id,
            format!("{run_id}-task"),
            format!("{run_id}-attempt"),
            "backfill",
            "epoch-1",
            work_key,
            1,
            "{}",
            "sha256:test",
        )
    }

    #[test]
    fn diagnosed_snapshot_keeps_the_existing_compatibility_projection() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("Ready");
        core.compatibility_view().store(true, Ordering::SeqCst);
        let expected = core.snapshot().expect("existing snapshot");
        let (actual, evidence) = core.snapshot_with_diagnostic().expect("diagnosed snapshot");
        assert_eq!(actual, expected);
        assert_eq!(evidence.state, DiagnosticLifecycleState::Ready);
        assert_eq!(evidence.projected_state, Some(DiagnosticLifecycleState::Transition));
        assert_eq!(evidence.revision, expected.revision);
    }

    #[test]
    fn diagnosed_ready_participant_is_silent_and_releases_its_membership() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("Ready");
        let participant = core
            .begin_workspace_participant_diagnosed(|_| panic!("Ready must be silent"))
            .expect("participant");
        assert_eq!(core.workspace_participant_count().expect("count"), 1);
        drop(participant);
        assert_eq!(core.workspace_participant_count().expect("count"), 0);
    }

    #[test]
    fn diagnosed_handoff_captures_exact_revision_before_callback_can_change_state() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(LiveBinding::new(
            "/private/user/path",
            "secret-workspace-token",
            1,
            0,
        ))
        .expect("Ready");
        let mut permit = match core.admit_maintenance_permit().expect("admission") {
            PermitAdmission::Admitted(permit) => permit,
            _ => panic!("admission"),
        };
        permit.start().expect("Start");
        permit.mark_joined().expect("Join");
        let mut recorded = None;
        let descriptor = permit
            .transfer_to_recovery_diagnosed(|evidence| {
                assert_eq!(
                    core.snapshot().expect("callback has no core lock").revision,
                    evidence.revision
                );
                core.request_shutdown()
                    .expect("advance after captured handoff");
                recorded = Some(evidence);
            })
            .expect("handoff");
        let evidence = recorded.expect("recorded");
        assert_eq!(evidence.descriptor_id, Some(descriptor));
        assert_eq!(evidence.owner, Some(RecoveryDescriptorOwner::Maintenance));
        assert_eq!(evidence.state, DiagnosticLifecycleState::RecoveryRequired);
        assert!(!evidence.shutdown_requested);
        assert!(core.snapshot().expect("later revision").revision > evidence.revision);
        let json = serde_json::to_string(&evidence).expect("safe evidence");
        assert!(!json.contains("private") && !json.contains("secret"));
    }

    #[test]
    fn diagnosed_refusal_keeps_original_errors_and_locked_owner_evidence() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("Ready");
        core.begin_transition(AdmissionKind::Open)
            .expect("Transition");
        let mut observed = None;
        let error = core
            .begin_workspace_participant_diagnosed(|evidence| {
                assert_eq!(
                    core.workspace_participant_count()
                        .expect("unlocked callback"),
                    0
                );
                observed = Some(evidence);
            })
            .err()
            .expect("refusal");
        assert_eq!(error, LifecycleError::ActiveOperations);
        assert_eq!(
            observed.expect("evidence").state,
            DiagnosticLifecycleState::Transition
        );

        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("Ready");
        let mut permit = match core.admit_maintenance_permit().expect("admission") {
            PermitAdmission::Admitted(permit) => permit,
            _ => panic!("admission"),
        };
        permit.start().expect("Start");
        permit.mark_joined().expect("Join");
        let descriptor = permit.transfer_to_recovery().expect("transfer");
        let root = core
            .descriptor(descriptor)
            .expect("descriptor")
            .root_operation_id;
        let error = core
            .begin_workspace_participant_diagnosed(|evidence| {
                assert_eq!(evidence.descriptor_id, Some(descriptor));
                assert_eq!(evidence.root_operation_id, Some(root));
                assert_eq!(evidence.owner, Some(RecoveryDescriptorOwner::Maintenance));
                assert_eq!(evidence.state, DiagnosticLifecycleState::RecoveryRequired);
                assert!(!evidence.shutdown_requested);
                core.request_shutdown()
                    .expect("capture precedes callback mutation");
            })
            .err()
            .expect("refusal");
        assert_eq!(error, LifecycleError::ActiveOperations);
        assert_eq!(
            core.begin_workspace_participant_diagnosed(|evidence| {
                assert!(evidence.shutdown_requested);
            })
            .err()
            .expect("shutdown refusal"),
            LifecycleError::Closed
        );
        assert_eq!(
            core.workspace_participant_count()
                .expect("no acquired memberships"),
            0
        );
    }

    #[test]
    fn c_query_quarantine_rejects_alias_before_open_transition_admission() {
        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        core.lock_state().expect("state").c_query_quarantine = Some(Arc::new(original.clone()));
        let before = core.snapshot().expect("pre-open snapshot");

        for (locator, workspace_id, identity) in [
            (
                "/tmp/workspace-alias",
                Some("edited-workspace-id"),
                Some("test-db-1"),
            ),
            ("/tmp/workspace-alias", None, None),
            (
                "/tmp/workspace",
                Some("edited-workspace-id"),
                Some("different-db"),
            ),
            (
                "/tmp/workspace-alias",
                Some("workspace-1"),
                Some("different-db"),
            ),
        ] {
            let outcome = core
                .begin_open_transition_for_target(locator, workspace_id, identity, None)
                .expect("checked Open admission");
            assert!(matches!(
                outcome,
                AdmissionOutcome::NotAdmitted {
                    reason: AdmissionRejection::ActiveOperation,
                    ..
                }
            ));
            assert_eq!(core.snapshot().expect("unchanged snapshot"), before);
        }

        let other = match core
            .begin_open_transition_for_target(
                "/tmp/other",
                Some("workspace-2"),
                Some("test-db-2"),
                None,
            )
            .expect("unrelated Open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("identified other DB is admissible"),
        };
        core.mark_transition_joined(&other)
            .expect("unrelated Open joined");
        core.activate(
            &other,
            LiveBinding::new("/tmp/other", "workspace-2", 2, 1)
                .with_main_database_file_identity("test-db-2".to_owned()),
            ContentEffect::Retained,
        )
        .expect("unrelated Open activation");
    }

    #[test]
    fn c_query_quarantine_fences_same_file_alias_until_token_drop() {
        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        let alias = LiveBinding::new("/tmp/workspace-alias", "edited-workspace-id", 2, 2)
            .with_main_database_file_identity("test-db-1".to_owned());
        assert_ne!(original.locator, alias.locator);
        assert_ne!(original.workspace_id, alias.workspace_id);
        assert!(original.same_main_database_file(&alias));
        assert!(!format!("{original:?}").contains("test-db-1"));
        let serialized = serde_json::to_value(&original).expect("serialize binding");
        assert_eq!(
            serialized,
            serde_json::json!({
                "locator": "/tmp/workspace",
                "workspace_id": "workspace-1",
                "authority_instance": 1,
                "recovery_generation": 1
            })
        );
        let deserialized: LiveBinding =
            serde_json::from_value(serialized).expect("deserialize binding");
        assert!(deserialized.database_file_identity.is_none());
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("participant");
        let participant_clone = participant.clone();
        assert!(participant.detach_c_query_quarantine(&original).is_none());
        drop(participant_clone);
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("unique exact participant transfers to quarantine");
        assert_eq!(core.workspace_participant_count().expect("count"), 0);

        assert!(core.set_ready(alias.clone()).is_err());
        {
            // Exercise participant admission independently of Ready publication:
            // this is the stale Ready state the publication guard must prevent.
            core.lock_state().expect("state").state = LifecycleState::Ready(alias.clone());
        }
        assert!(core.begin_workspace_participant().is_err());
        {
            core.lock_state().expect("state").state = LifecycleState::Ready(original);
        }
        assert!(core.close().is_err(), "close cannot claim terminal proof");

        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("switch away admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("switch away admitted"),
        };
        core.mark_transition_joined(&ticket)
            .expect("transition joined");
        assert!(core
            .activate(&ticket, alias.clone(), ContentEffect::Retained)
            .is_err());
        let other = LiveBinding::new("/tmp/other-workspace", "workspace-2", 3, 1)
            .with_main_database_file_identity("test-db-2".to_owned());
        core.activate(&ticket, other, ContentEffect::Retained)
            .expect("unrelated identified workspace remains usable");

        drop(quarantine);
        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("same file can be reopened after proof")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("reopen admitted"),
        };
        core.mark_transition_joined(&ticket)
            .expect("transition joined");
        core.activate(&ticket, alias, ContentEffect::Retained)
            .expect("released quarantine permits aliased authority");
    }

    #[test]
    fn c_query_quarantine_retains_16k_w1_id_until_fence_drop() {
        let core = WorkspaceLifecycleCore::new();
        let original = LiveBinding::new("/tmp/workspace-w1", "w".repeat(16_384), 1, 1)
            .with_main_database_file_identity("test-db-w1".to_owned());
        assert_eq!(original.workspace_id.len(), 16_384);
        let original_id = Arc::downgrade(&original.workspace_id);
        drop(core.set_ready(original.clone()).expect("W1 ready snapshot"));

        let participant = core.begin_workspace_participant().expect("W1 participant");
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("W1 participant transfers to quarantine");
        let ticket = match core
            .begin_open_transition_for_target(
                "/tmp/workspace-w2",
                Some("workspace-w2"),
                Some("test-db-w2"),
                None,
            )
            .expect("positively distinct W2 Open")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("identified W2 must be admitted"),
        };
        core.mark_transition_joined(&ticket)
            .expect("W2 Open joined");
        let w2 = LiveBinding::new("/tmp/workspace-w2", "workspace-w2", 2, 1)
            .with_main_database_file_identity("test-db-w2".to_owned());
        assert_ne!(original.locator, w2.locator);
        assert_ne!(original.workspace_id, w2.workspace_id);
        assert!(!original.same_main_database_file(&w2));
        let activation = core
            .activate(&ticket, w2.clone(), ContentEffect::Retained)
            .expect("W2 activation");
        assert!(matches!(
            &activation,
            LifecycleResult::Activated { binding, .. } if binding == &w2
        ));

        drop(activation);
        drop(ticket);
        drop(w2);
        drop(participant);
        drop(original);
        assert!(
            original_id.upgrade().is_some(),
            "the live quarantine fence must retain W1's workspace ID"
        );

        drop(quarantine);
        assert!(
            original_id.upgrade().is_none(),
            "dropping the fence must release the final W1 workspace-ID owner"
        );
    }

    #[test]
    fn c_query_handoff_vetoes_only_conflicting_transition_before_physical_io() {
        for kind in [AdmissionKind::Open, AdmissionKind::Restore] {
            let core = WorkspaceLifecycleCore::new();
            let original = binding(1);
            core.set_ready(original.clone()).expect("ready");
            let participant = core.begin_workspace_participant().expect("W1 participant");
            let ticket = match kind {
                AdmissionKind::Open => core
                    .begin_open_transition_for_target(
                        "/tmp/workspace-alias",
                        Some("edited-workspace-id"),
                        Some("test-db-1"),
                        None,
                    )
                    .expect("Open admission"),
                AdmissionKind::Restore => core
                    .begin_transition(AdmissionKind::Restore)
                    .expect("Restore admission"),
                _ => unreachable!(),
            };
            let ticket = match ticket {
                AdmissionOutcome::Admitted(ticket) => ticket,
                AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
            };
            if kind == AdmissionKind::Open {
                let debug = format!("{:?}", core.lock_state().expect("state"));
                assert!(!debug.contains("workspace-alias"));
                assert!(!debug.contains("test-db-1"));
            }

            let quarantine = participant
                .detach_c_query_quarantine(&original)
                .expect("conflicting W1 operation is atomically quarantined");
            assert_eq!(core.workspace_participant_count().expect("participant"), 0);
            assert!(core.transition_vetoed(&ticket).expect("veto state"));
            assert!(matches!(
                core.physical_exclusive_for_ticket(&ticket),
                Err(LifecycleError::TransitionVetoed { operation_id })
                    if operation_id == ticket.operation_id
            ));

            core.mark_transition_joined(&ticket)
                .expect("Native owner observed Join");
            assert!(matches!(
                core.complete_unchanged(&ticket, original.clone()),
                Err(LifecycleError::TransitionVetoed { .. })
            ));
            assert!(matches!(
                core.activate(&ticket, binding(2), ContentEffect::Retained),
                Err(LifecycleError::TransitionVetoed { .. })
            ));
            assert_eq!(
                core.resolve_joined_transition(&ticket)
                    .expect("joined transition resolution"),
                JoinedTransitionOutcome::RecoveryRequired
            );
            let descriptor_id = match core.snapshot().expect("recovery snapshot").state {
                LifecycleState::RecoveryRequired { descriptor_id } => descriptor_id,
                state => panic!("expected RecoveryRequired, got {state:?}"),
            };
            assert_eq!(
                core.descriptor(descriptor_id)
                    .expect("recovery descriptor")
                    .expected_binding,
                Some(original)
            );
            assert!(matches!(
                core.snapshot().expect("lifecycle snapshot").state,
                LifecycleState::RecoveryRequired { .. }
            ));
            drop(quarantine);
        }

        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("W1 participant");
        let ticket = match core
            .begin_open_transition_for_target(
                "/tmp/workspace-2",
                Some("workspace-2"),
                Some("test-db-2"),
                None,
            )
            .expect("known-distinct W2 Open")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("W2 Open must be admitted"),
        };
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("W1 may be fenced while known-distinct W2 proceeds");
        assert!(!core.transition_vetoed(&ticket).expect("no veto"));
        let exclusive = core
            .physical_exclusive_for_ticket(&ticket)
            .expect("known-distinct W2 may cross the protected boundary");
        drop(exclusive);
        core.mark_transition_joined(&ticket)
            .expect("W2 Open joined");
        core.activate(
            &ticket,
            LiveBinding::new("/tmp/workspace-2", "workspace-2", 2, 1)
                .with_main_database_file_identity("test-db-2".to_owned()),
            ContentEffect::Retained,
        )
        .expect("known-distinct W2 activation");
        drop(quarantine);
    }

    #[test]
    fn c_query_quarantine_blocks_w1_restore_exclusion_but_allows_distinct_w2() {
        let w1_core = WorkspaceLifecycleCore::new();
        let w1 = binding(1);
        w1_core.set_ready(w1.clone()).expect("W1 ready");
        let w1_participant = w1_core
            .begin_workspace_participant()
            .expect("W1 participant");
        let _w1_quarantine = w1_participant
            .detach_c_query_quarantine(&w1)
            .expect("fence W1");
        let restore = match w1_core
            .begin_transition(AdmissionKind::Restore)
            .expect("Restore admission remains logical")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("Restore ticket admitted"),
        };
        assert!(matches!(
            w1_core.physical_exclusive_for_ticket(&restore),
            Err(LifecycleError::ActiveOperations)
        ));

        let w2_core = WorkspaceLifecycleCore::new();
        let w1 = binding(1);
        w2_core.set_ready(w1.clone()).expect("W1 ready");
        let participant = w2_core
            .begin_workspace_participant()
            .expect("W1 participant");
        let _quarantine = participant
            .detach_c_query_quarantine(&w1)
            .expect("fence W1");
        let w2 = match w2_core
            .begin_open_transition_for_target(
                "/tmp/workspace-w2",
                Some("workspace-w2"),
                Some("test-db-w2"),
                None,
            )
            .expect("distinct W2 Open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("distinct W2 admitted"),
        };
        let exclusive = w2_core
            .physical_exclusive_for_ticket(&w2)
            .expect("distinct W2 may acquire physical exclusion");
        drop(exclusive);
    }

    #[test]
    fn c_query_fallback_retains_participant_through_open_restore_and_shutdown_drain() {
        for kind in [AdmissionKind::Open, AdmissionKind::Restore] {
            let core = WorkspaceLifecycleCore::new();
            core.set_ready(binding(1)).expect("ready");
            let participant = core
                .begin_workspace_participant()
                .expect("participant admission")
                .try_retain_for_c_query_fallback()
                .unwrap_or_else(|_| panic!("counted participant must be retainable"));
            let ticket = match core.begin_transition(kind).expect("transition admission") {
                AdmissionOutcome::Admitted(ticket) => ticket,
                AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
            };
            assert!(matches!(
                core.physical_exclusive_for_ticket(&ticket),
                Err(LifecycleError::ActiveOperations)
            ));
            assert_eq!(core.workspace_participant_count().expect("count"), 1);
            drop(participant);
            let exclusive = core
                .physical_exclusive_for_ticket(&ticket)
                .expect("retired participant permits protected transition");
            drop(exclusive);
        }

        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let participant = core
            .begin_workspace_participant()
            .expect("participant admission");
        let participant_clone = participant.clone();
        let participant = participant
            .try_retain_for_c_query_fallback()
            .unwrap_or_else(|_| panic!("shared counted participant must be retainable"));
        assert_eq!(core.workspace_participant_count().expect("count"), 1);
        drop(participant);
        assert_eq!(core.workspace_participant_count().expect("count"), 1);
        drop(participant_clone);
        assert_eq!(core.workspace_participant_count().expect("count"), 0);

        let participant = core
            .begin_workspace_participant()
            .expect("participant admission")
            .try_retain_for_c_query_fallback()
            .unwrap_or_else(|_| panic!("counted participant must be retainable"));
        core.request_shutdown().expect("shutdown request");
        assert!(matches!(
            core.close(),
            Err(LifecycleError::ActiveOperations)
        ));
        drop(participant);
        assert!(matches!(
            core.close().expect("close after participant drain").state,
            LifecycleState::Closed
        ));
    }

    #[test]
    fn c_query_fallback_refuses_zero_count_marker_fence_and_poisoned_state() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let participant = core
            .begin_workspace_participant()
            .expect("participant admission");
        core.lock_state().expect("state").workspace_participants = 0;
        let participant = match participant.try_retain_for_c_query_fallback() {
            Err(participant) => participant,
            Ok(_) => panic!("uncounted participant must not be retained"),
        };
        drop(participant);

        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core
            .begin_workspace_participant()
            .expect("participant admission");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("Restore admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("Restore must be admitted"),
        };
        core.lock_state()
            .expect("state")
            .physical_exclusive_operations
            .insert(ticket.operation_id);
        let participant = match participant.try_retain_for_c_query_fallback() {
            Err(participant) => participant,
            Ok(_) => panic!("marker-won participant must not be retained"),
        };
        drop(participant);

        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core
            .begin_workspace_participant()
            .expect("participant admission");
        let fence = participant
            .detach_c_query_quarantine(&original)
            .expect("install existing fence");
        let participant = match participant.try_retain_for_c_query_fallback() {
            Err(participant) => participant,
            Ok(_) => panic!("released participant must not be retained"),
        };
        drop(participant);
        let other = LiveBinding::new("/tmp/other", "workspace-other", 2, 1)
            .with_main_database_file_identity("other-db".to_owned());
        core.set_ready(other).expect("distinct workspace ready");
        let participant = core
            .begin_workspace_participant()
            .expect("distinct workspace participant");
        let participant = match participant.try_retain_for_c_query_fallback() {
            Err(participant) => participant,
            Ok(_) => panic!("unrelated existing fence must not be credited"),
        };
        drop(participant);
        drop(fence);

        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let participant = core
            .begin_workspace_participant()
            .expect("participant admission");
        let poisoned_core = core.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _state = poisoned_core.inner.state.lock().expect("state lock");
            panic!("poison lifecycle mutex for test");
        }));
        let participant = match participant.try_retain_for_c_query_fallback() {
            Err(participant) => participant,
            Ok(_) => panic!("poisoned lifecycle mutex must fail closed"),
        };
        drop(participant);
    }

    #[test]
    fn shutdown_wins_joined_c_query_veto_completion_for_open_and_restore() {
        for kind in [AdmissionKind::Open, AdmissionKind::Restore] {
            let core = WorkspaceLifecycleCore::new();
            let original = binding(1);
            core.set_ready(original.clone()).expect("ready");
            let participant = core.begin_workspace_participant().expect("W1 participant");
            let ticket = match kind {
                AdmissionKind::Open => core
                    .begin_open_transition_for_target(
                        "/tmp/workspace-alias",
                        Some("edited-workspace-id"),
                        Some("test-db-1"),
                        None,
                    )
                    .expect("Open admission"),
                AdmissionKind::Restore => core
                    .begin_transition(AdmissionKind::Restore)
                    .expect("Restore admission"),
                _ => unreachable!(),
            };
            let ticket = match ticket {
                AdmissionOutcome::Admitted(ticket) => ticket,
                AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
            };
            let quarantine = participant
                .detach_c_query_quarantine(&original)
                .expect("conflicting W1 operation is atomically quarantined");
            core.mark_transition_joined(&ticket)
                .expect("Native owner observed Join");

            // Reproduce the former gap: shutdown=false and veto=true were
            // independently observed, then shutdown acquired the core lock.
            assert!(!core.shutdown_requested().expect("shutdown status"));
            assert!(core.transition_vetoed(&ticket).expect("veto status"));
            core.request_shutdown()
                .expect("shutdown wins before publish");
            assert_eq!(
                core.resolve_joined_transition(&ticket)
                    .expect("atomic terminal choice"),
                JoinedTransitionOutcome::Shutdown
            );
            assert!(matches!(
                core.snapshot().expect("shutdown snapshot").state,
                LifecycleState::Transition {
                    operation_id: OperationId(0),
                    stage: TransitionStage::Finishing,
                }
            ));
            assert!(
                core.compatibility_view().load(Ordering::SeqCst),
                "shutdown must keep switching closed"
            );
            assert!(
                matches!(core.close(), Err(LifecycleError::ActiveOperations)),
                "the quarantine fence remains owned until released"
            );
            drop(quarantine);
            assert!(matches!(
                core.close().expect("close after quarantine release").state,
                LifecycleState::Closed
            ));
        }
    }

    #[test]
    fn c_query_handoff_vetoes_targetless_open() {
        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("W1 participant");
        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("targetless Open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => {
                panic!("Open must be admitted before quarantine")
            }
        };
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("targetless Open conservatively conflicts");
        assert!(core.transition_vetoed(&ticket).expect("veto state"));
        assert!(matches!(
            core.physical_exclusive_for_ticket(&ticket),
            Err(LifecycleError::TransitionVetoed { .. })
        ));
        drop(quarantine);
    }

    #[test]
    fn c_query_handoff_vetoes_open_when_target_identity_is_unknown() {
        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("W1 participant");
        let ticket = match core
            .begin_open_transition_for_target("/tmp/unknown-target", None, None, None)
            .expect("Open admission with unknown target identity")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => {
                panic!("Open must be admitted before quarantine")
            }
        };
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("unknown target fails closed as conflict");
        assert!(core.transition_vetoed(&ticket).expect("veto state"));
        assert!(matches!(
            core.physical_exclusive_for_ticket(&ticket),
            Err(LifecycleError::TransitionVetoed { .. })
        ));
        drop(quarantine);
    }

    #[test]
    fn c_query_handoff_refuses_when_physical_exclusive_marker_won_first() {
        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("W1 participant");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("Restore admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("Restore must be admitted"),
        };

        // A real physical owner cannot acquire while the participant is live;
        // seed the marker under the same mutex to isolate the inverse lock order.
        core.lock_state()
            .expect("state")
            .physical_exclusive_operations
            .insert(ticket.operation_id);
        assert!(participant.detach_c_query_quarantine(&original).is_none());
        assert_eq!(core.workspace_participant_count().expect("participant"), 1);
        assert!(!core.transition_vetoed(&ticket).expect("no veto"));
    }

    #[test]
    fn quarantine_fails_closed_when_file_identity_is_missing() {
        let unidentified_core = WorkspaceLifecycleCore::new();
        let unidentified = LiveBinding::new("/tmp/unidentified", "workspace-unknown", 1, 1);
        unidentified_core
            .set_ready(unidentified.clone())
            .expect("legacy binding ready without quarantine");
        let unidentified_participant = unidentified_core
            .begin_workspace_participant()
            .expect("unidentified participant");
        assert!(unidentified_participant
            .detach_c_query_quarantine(&unidentified)
            .is_none());
        assert_eq!(
            unidentified_core
                .workspace_participant_count()
                .expect("participant count"),
            1
        );
        drop(unidentified_participant);

        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("participant");
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("identified participant transfers to quarantine");
        let unknown = LiveBinding::new("/tmp/other", "other-id", 2, 1);
        assert!(core.set_ready(unknown).is_err());
        drop(quarantine);
    }

    #[test]
    fn c_query_quarantine_blocks_terminal_shutdown_until_fence_drop() {
        let core = WorkspaceLifecycleCore::new();
        let original = binding(1);
        core.set_ready(original.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("participant");
        let quarantine = participant
            .detach_c_query_quarantine(&original)
            .expect("exact participant transfers to quarantine");

        core.request_shutdown()
            .expect("shutdown request is recorded");
        assert!(core.close().is_err(), "unproved child cannot be closed");
        drop(quarantine);
        core.close()
            .expect("terminal close is allowed after quarantine proof");
    }

    #[test]
    fn not_admitted_does_not_become_unchanged_during_transition() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let first = core
            .begin_transition(AdmissionKind::Open)
            .expect("transition admission");
        let first_ticket = match first {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("first operation must be admitted"),
        };

        let second = core
            .begin_transition(AdmissionKind::Restore)
            .expect("second admission result");
        assert!(matches!(
            second,
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::Transition,
                ..
            }
        ));

        core.mark_transition_joined(&first_ticket)
            .expect("supervisor Join");
        let unchanged = core
            .complete_unchanged(&first_ticket, binding(1))
            .expect("original binding can complete unchanged");
        assert!(matches!(unchanged, LifecycleResult::Unchanged { .. }));
        assert_eq!(
            core.snapshot().expect("snapshot").binding(),
            Some(&binding(1))
        );
    }

    #[test]
    fn reopening_same_locator_is_activated_not_unchanged() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket)
            .expect("supervisor Join");
        let result = core
            .activate(&ticket, binding(2), ContentEffect::Retained)
            .expect("activate reopened authority");
        assert!(matches!(result, LifecycleResult::Activated { .. }));
        assert_eq!(
            core.snapshot().expect("snapshot").binding(),
            Some(&binding(2))
        );
    }

    #[test]
    fn raw_ready_publication_cannot_bypass_an_admitted_transition() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let _ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        assert_eq!(
            core.set_ready(binding(1))
                .expect_err("raw Ready must be rejected"),
            LifecycleError::InvalidState
        );
    }

    #[test]
    fn close_does_not_fabricate_closed_while_transition_is_unjoined() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let _ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        assert_eq!(
            core.close()
                .expect_err("active transition must block close"),
            LifecycleError::ActiveOperations
        );
        assert!(matches!(
            core.snapshot().expect("snapshot").state,
            LifecycleState::Transition { .. }
        ));
    }

    #[test]
    fn transition_completion_requires_join_and_exposes_split_permits() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let transition = match core
            .begin_transition_permit(AdmissionKind::Restore)
            .expect("transition permit")
        {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("transition must be admitted"),
        };
        assert!(matches!(
            transition
                .core
                .activate(transition.ticket(), binding(2), ContentEffect::Retained),
            Err(LifecycleError::NotJoined(_))
        ));
        transition.mark_joined().expect("Join");
        core.reserve_execution(transition.operation_id(), ExecutionId::new(1))
            .expect("reserve execution");
        core.start_execution(ExecutionId::new(1))
            .expect("start execution");
        let publication = transition
            .publication_permit(WorkExecutionId::new(9))
            .expect("publication permit");
        assert_eq!(publication.work_execution_id(), WorkExecutionId::new(9));
        core.start_work_execution(WorkExecutionId::new(9))
            .expect("publication worker start");
        publication.complete().expect("publication complete");
        core.mark_execution_joined(transition.ticket())
            .expect("execution Join");
        core.mark_execution_cleanup_pending(ExecutionId::new(1))
            .expect("cleanup pending");
        assert_eq!(
            transition
                .physical_exclusive()
                .expect("physical exclusion")
                .operation_id(),
            transition.operation_id()
        );
        transition
            .activate(binding(2), ContentEffect::Retained)
            .expect("activation after Join");
        core.complete_execution(ExecutionId::new(1))
            .expect("execution complete");

        match core.admit_maintenance_permit().expect("maintenance permit") {
            PermitAdmission::Admitted(permit) => {
                let mut permit = permit;
                permit.mark_joined().expect("maintenance Join");
                assert!(permit.release().expect("release"));
            }
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        }
    }

    #[test]
    fn transition_cannot_overtake_maintenance_and_drop_retains_its_owner() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let maintenance = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        let transition = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("transition must drain maintenance"),
        };
        let ticket = maintenance.ticket().clone();
        // Dropping an unjoined permit retains the owner and responsibility;
        // an explicit supervisor Join/finalizer is required to release it.
        drop(maintenance);
        assert!(matches!(
            core.begin_transition(AdmissionKind::Restore)
                .expect("second transition must wait"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::Transition,
                ..
            }
        ));
        core.mark_execution_joined(&ticket).expect("Join");
        let maintenance_execution = ExecutionId::new(ticket.operation_id.get());
        core.mark_execution_cleanup_pending(maintenance_execution)
            .expect("cleanup pending after Join");
        core.complete_execution(maintenance_execution)
            .expect("maintenance execution complete");
        core.release_admission(&ticket).expect("release");
        core.mark_transition_joined(&transition).expect("Join");
        core.complete_unchanged(&transition, binding(1))
            .expect("restore original binding");
    }

    #[test]
    fn physical_exclusive_waits_for_foreground_cleanup_and_join() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut foreground = match core.admit_foreground_permit().expect("foreground") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("foreground must be admitted"),
        };
        foreground.start().expect("foreground start");
        let transition = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
        };

        assert!(matches!(
            core.physical_exclusive_for_ticket(&transition),
            Err(LifecycleError::ActiveOperations)
        ));

        foreground.mark_joined().expect("foreground Join");
        foreground.release().expect("foreground release");
        let exclusive = core
            .physical_exclusive_for_ticket(&transition)
            .expect("protected I/O after foreground cleanup");
        drop(exclusive);
        core.mark_transition_joined(&transition)
            .expect("transition Join");
        core.complete_unchanged(&transition, binding(1))
            .expect("transition completion");
    }

    #[test]
    fn ordinary_participants_are_drained_and_closed_after_transition_admission() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let participant = core
            .begin_workspace_participant()
            .expect("ready workspace accepts a participant");
        let transition = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
        };

        assert!(matches!(
            core.begin_workspace_participant(),
            Err(LifecycleError::ActiveOperations)
        ));
        assert!(matches!(
            core.physical_exclusive_for_ticket(&transition),
            Err(LifecycleError::ActiveOperations)
        ));

        drop(participant);
        let exclusive = core
            .physical_exclusive_for_ticket(&transition)
            .expect("physical exclusion after participant drain");
        drop(exclusive);
        core.mark_transition_joined(&transition)
            .expect("transition Join");
        core.complete_unchanged(&transition, binding(1))
            .expect("transition completion");
    }

    #[test]
    fn maintenance_admission_and_execution_membership_are_single_owner() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let permit = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        assert!(matches!(
            core.admit_maintenance_permit()
                .expect("duplicate maintenance"),
            PermitAdmission::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ));
        let operation_id = permit.operation_id();
        let ticket = permit.ticket().clone();
        let execution_id = permit.execution_id();
        assert_eq!(execution_id, ExecutionId::new(operation_id.get()));
        core.start_execution(execution_id).expect("execution start");
        permit
            .attach_run_ownership(RunOwnership {
                state: RunCreationState::Reserved,
                handle: DurableRunHandle::new(
                    "project-1",
                    "run-1",
                    "task-1",
                    "attempt-1",
                    "backfill",
                    "epoch-1",
                    "work-1",
                    1,
                    "{}",
                    "sha256:spec",
                ),
            })
            .expect("attach exact run ownership");
        assert!(core
            .execution_membership(execution_id)
            .expect("execution membership")
            .run
            .is_some());
        core.reserve_work_execution(execution_id, WorkExecutionId::new(45))
            .expect("work reservation");
        core.start_work_execution(WorkExecutionId::new(45))
            .expect("work start");
        core.mark_execution_joined(&ticket).expect("Join");
        permit
            .mark_connection_retired()
            .expect("connection retirement receipt");
        assert!(
            core.execution_membership(execution_id)
                .expect("execution membership")
                .run
                .expect("run ownership")
                .handle
                .connection_retired
        );
        core.mark_execution_cleanup_pending(execution_id)
            .expect("cleanup pending");
        core.complete_work_execution(WorkExecutionId::new(45))
            .expect("work complete");
        core.complete_execution(execution_id)
            .expect("execution complete");
        core.release_admission(&ticket).expect("release");
        assert!(matches!(
            core.admit_maintenance_permit().expect("next maintenance"),
            PermitAdmission::Admitted(_)
        ));
    }

    #[test]
    fn durable_run_terminalization_removes_only_the_exact_owned_tuple() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        let execution_id = permit.execution_id();
        permit.start().expect("start");
        permit
            .attach_run_ownership(RunOwnership {
                state: RunCreationState::Created,
                handle: run_handle("run-terminalized", "work-terminalized"),
            })
            .expect("attach run");
        assert!(permit.has_run_ownership().expect("ownership present"));
        permit
            .mark_run_terminalized("run-terminalized")
            .expect("mark exact run terminalized");
        assert!(!permit.has_run_ownership().expect("ownership removed"));
        assert!(core
            .execution_membership(execution_id)
            .expect("membership")
            .run
            .is_none());
    }

    #[test]
    fn completed_execution_memberships_are_pruned_after_release() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        for _ in 0..512 {
            let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
                PermitAdmission::Admitted(permit) => permit,
                PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
            };
            permit.start().expect("start");
            permit.mark_joined().expect("join");
            permit.release().expect("release");
        }
        assert_eq!(
            core.execution_membership_counts().expect("membership counts"),
            (0, 0)
        );
    }

    #[test]
    fn foreground_and_maintenance_have_independent_execution_slots() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut maintenance = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        maintenance.start().expect("maintenance start");
        let mut foreground = match core.admit_foreground_permit().expect("foreground") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("foreground must be admitted"),
        };
        foreground.start().expect("foreground start");
        let mut second_foreground = match core.admit_foreground_permit().expect("foreground waiter") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => {
                panic!("foreground waiters must reach the existing priority path")
            }
        };
        second_foreground.start().expect("second foreground start");
        second_foreground.mark_joined().expect("second foreground Join");
        second_foreground
            .release()
            .expect("second foreground release");
        foreground.mark_joined().expect("foreground Join");
        foreground.release().expect("foreground release");
        maintenance.mark_joined().expect("maintenance Join");
        maintenance.release().expect("maintenance release");
        assert!(matches!(
            core.admit_foreground_permit().expect("next foreground"),
            PermitAdmission::Admitted(_)
        ));
    }

    #[test]
    fn shutdown_wins_transition_without_publishing_ready() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
        };
        core.request_shutdown().expect("shutdown request");
        core.mark_transition_joined(&ticket).expect("join");
        core.abandon_transition_for_shutdown(&ticket)
            .expect("shutdown transition handoff");
        assert!(matches!(
            core.snapshot().expect("snapshot").state,
            LifecycleState::Transition {
                operation_id: OperationId(0),
                stage: TransitionStage::Finishing,
            }
        ));
        assert!(matches!(
            core.close().expect("close"),
            LifecycleSnapshot {
                state: LifecycleState::Closed,
                ..
            }
        ));
    }

    #[test]
    fn shutdown_stops_reserved_execution_before_body_start() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        let execution_id = permit.execution_id();
        core.request_shutdown().expect("shutdown request");
        assert_eq!(
            permit.start().expect_err("shutdown blocks pending start"),
            LifecycleError::Closed
        );
        assert_eq!(
            core.execution_membership(permit.execution_id())
                .expect("membership")
                .phase,
            ExecutionPhase::StopRequested
        );
        permit
            .cancel_before_start()
            .expect("retire rejected pending start");
        assert!(matches!(
            core.execution_membership(execution_id),
            Err(LifecycleError::UnknownExecution(id)) if id == execution_id
        ));
        assert_eq!(
            core.execution_membership_counts().expect("pruned membership"),
            (0, 0)
        );
        assert!(matches!(
            core.close().expect("close"),
            LifecycleSnapshot {
                state: LifecycleState::Closed,
                ..
            }
        ));
    }

    #[test]
    fn execution_cleanup_and_parent_release_require_join_and_child_completion() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        permit.start().expect("start");
        let execution_id = permit.execution_id();
        core.reserve_work_execution(execution_id, WorkExecutionId::new(77))
            .expect("reserve child");
        core.reserve_work_execution(execution_id, WorkExecutionId::new(78))
            .expect("reserve started child");
        core.start_work_execution(WorkExecutionId::new(78))
            .expect("started child");
        core.complete_work_execution(WorkExecutionId::new(78))
            .expect("completed child before stop");
        core.request_execution_stop(execution_id)
            .expect("stop request");
        assert_eq!(
            core.mark_execution_cleanup_pending(execution_id)
                .expect_err("stop is not Join"),
            LifecycleError::InvalidExecutionTransition
        );
        permit.mark_joined().expect("parent Join");
        assert_eq!(
            core.complete_execution(execution_id)
                .expect_err("child keeps parent owned"),
            LifecycleError::InvalidExecutionTransition
        );
        assert_eq!(
            core.complete_work_execution(WorkExecutionId::new(77))
                .expect_err("reserved child cannot fabricate completion"),
            LifecycleError::InvalidExecutionTransition
        );
        core.cancel_reserved_work_execution(WorkExecutionId::new(77))
            .expect("stopped pending child can be retired explicitly");
        core.start_work_execution(WorkExecutionId::new(77))
            .expect_err("retired pending child cannot start");
        core.mark_execution_cleanup_pending(execution_id)
            .expect("cleanup after Join");
        permit.release().expect("parent release");
    }

    #[test]
    fn dropping_armed_permit_does_not_fabricate_join_or_release_cell() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        permit.start().expect("start");
        let ticket = permit.ticket().clone();
        permit.arm_scope_finalizer();
        drop(permit);
        assert!(matches!(
            core.admit_maintenance_permit().expect("second admission"),
            PermitAdmission::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ));
        core.mark_execution_joined(&ticket)
            .expect("supervisor Join");
        core.mark_execution_cleanup_pending(ExecutionId::new(ticket.operation_id.get()))
            .expect("cleanup pending");
        core.complete_execution(ExecutionId::new(ticket.operation_id.get()))
            .expect("execution complete");
        core.release_admission(&ticket).expect("explicit release");
    }

    #[test]
    fn descriptor_recovery_reuses_root_and_cell_after_failure() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket).expect("join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("descriptor");
        assert_eq!(core.responsibility_counts().expect("count"), (1, false));
        let recovery = match core.admit_recovery(descriptor_id).expect("recover") {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("recovery admitted"),
        };
        core.mark_transition_joined(&recovery)
            .expect("recovery join");
        let (same_descriptor, _) = core
            .require_recovery(&recovery, Some(binding(1)), None)
            .expect("same descriptor retry");
        assert_eq!(same_descriptor, descriptor_id);
        assert_eq!(
            core.responsibility_counts().expect("count after retry"),
            (1, false)
        );
        assert!(matches!(
            core.admit_recovery(descriptor_id).expect("retry admission"),
            AdmissionOutcome::Admitted(_)
        ));
    }

    #[test]
    fn terminal_delivery_result_is_immutable() {
        let core = WorkspaceLifecycleCore::new();
        let sequence = DeliverySequence::new(1);
        core.admit_delivery_at(sequence, "fingerprint")
            .expect("admit");
        core.mark_delivery_terminal_with_result(sequence, Some("A".into()))
            .expect("terminal");
        core.mark_delivery_terminal_with_result(sequence, Some("A".into()))
            .expect("same replay");
        assert!(matches!(
            core.mark_delivery_terminal_with_result(sequence, Some("B".into())),
            Err(LifecycleError::DeliveryResultConflict(_))
        ));
    }

    #[test]
    fn bare_recover_is_rejected_without_a_descriptor_root() {
        let core = WorkspaceLifecycleCore::new();
        assert!(matches!(
            core.admit(AdmissionKind::Recover).expect("admission"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::RecoveryPrerequisite,
                ..
            }
        ));
        core.set_ready(binding(1)).expect("ready");
        assert!(matches!(
            core.admit(AdmissionKind::Recover).expect("admission"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::RecoveryPrerequisite,
                ..
            }
        ));
    }

    #[test]
    fn recovery_admission_is_bound_to_the_exact_descriptor_root() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket).expect("join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("descriptor");

        assert!(matches!(
            core.admit(AdmissionKind::Recover).expect("bare recovery"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::RecoveryPrerequisite,
                ..
            }
        ));
        let admitted = core
            .admit_recovery(descriptor_id)
            .expect("descriptor recovery");
        let recovery_ticket = match admitted {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("descriptor recovery must admit"),
        };
        assert_eq!(recovery_ticket.recovery_descriptor_id, Some(descriptor_id));
        assert!(matches!(
            core.snapshot().expect("recovery transition").state,
            LifecycleState::Transition {
                stage: TransitionStage::Recovering,
                ..
            }
        ));
        core.mark_transition_joined(&recovery_ticket)
            .expect("recovery Join");
        core.activate(&recovery_ticket, binding(2), ContentEffect::Retained)
            .expect("descriptor-bound recovery activation");
    }

    #[test]
    fn unresolved_descriptor_does_not_block_independent_workspace_open() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready W1");
        let restore = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("restore admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("restore must admit"),
        };
        core.mark_transition_joined(&restore).expect("restore Join");
        let (descriptor_id, _) = core
            .require_recovery(&restore, Some(binding(1)), None)
            .expect("transfer W1 responsibility");

        let open = match core
            .begin_transition(AdmissionKind::Open)
            .expect("W2 open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("W1 descriptor must not block W2"),
        };
        core.mark_transition_joined(&open).expect("W2 Join");
        core.activate(&open, binding(2), ContentEffect::Retained)
            .expect("W2 activation");
        assert!(matches!(
            core.snapshot().expect("W2 snapshot").state,
            LifecycleState::Ready(_)
        ));

        let recovery = match core
            .admit_recovery(descriptor_id)
            .expect("exact W1 descriptor recovery")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("exact recovery must admit from Ready"),
        };
        core.mark_transition_joined(&recovery)
            .expect("recovery Join");
        core.activate(&recovery, binding(2), ContentEffect::Retained)
            .expect("descriptor recovery keeps W2 active");
    }

    #[test]
    fn participant_stop_observes_transition_and_shutdown_without_readmission() {
        for shutdown in [false, true] {
            let core = WorkspaceLifecycleCore::new();
            core.set_ready(binding(1)).expect("ready");
            let participant = core.begin_workspace_participant().expect("participant");
            assert!(!participant.stop_requested().expect("active owner"));
            if shutdown {
                core.request_shutdown().expect("shutdown");
            } else {
                core.begin_transition(AdmissionKind::Open)
                    .expect("transition");
            }
            assert!(participant.stop_requested().expect("stop existing owner"));
            assert_eq!(core.workspace_participant_count().expect("same owner"), 1);
            drop(participant);
            assert_eq!(
                core.workspace_participant_count().expect("actual release"),
                0
            );
        }
    }

    #[test]
    fn participant_final_claim_requires_exact_ready_binding_and_holds_core() {
        let core = WorkspaceLifecycleCore::new();
        let expected = binding(1);
        core.set_ready(expected.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("participant");
        participant
            .with_current_binding(&expected, || {
                assert!(matches!(
                    core.inner.state.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
            })
            .expect("exact binding");
        assert!(
            core.inner.state.try_lock().is_ok(),
            "release before transport"
        );
        for mismatch in [
            binding(2),
            LiveBinding {
                recovery_generation: 2,
                ..expected.clone()
            },
        ] {
            assert_eq!(
                participant.with_current_binding(&mismatch, || panic!("stale claim")),
                Err(LifecycleError::InvalidState)
            );
        }
        core.compatibility_view().store(true, Ordering::SeqCst);
        assert_eq!(
            participant.with_current_binding(&expected, || panic!("switching claim")),
            Err(LifecycleError::InvalidState)
        );
        core.compatibility_view().store(false, Ordering::SeqCst);
        core.request_shutdown().expect("shutdown");
        assert_eq!(
            participant.with_current_binding(&expected, || panic!("closed claim")),
            Err(LifecycleError::Closed)
        );
    }

    #[test]
    fn compatibility_switching_waits_for_final_claim_guard() {
        let core = WorkspaceLifecycleCore::new();
        let expected = binding(1);
        core.set_ready(expected.clone()).expect("ready");
        let participant = core.begin_workspace_participant().expect("participant");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let worker = participant
            .with_current_binding(&expected, || {
                let view = core.compatibility_view();
                let worker = std::thread::spawn(move || {
                    started_tx.send(()).expect("announce switching request");
                    view.store(true, Ordering::SeqCst);
                });
                started_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("switching requested");
                assert!(!core.inner.compatibility_switching.load(Ordering::SeqCst));
                worker
            })
            .expect("claim before switching");
        worker.join().expect("switching completes after claim");
        assert!(core.inner.compatibility_switching.load(Ordering::SeqCst));
        assert_eq!(
            participant.with_current_binding(&expected, || panic!("late claim")),
            Err(LifecycleError::InvalidState)
        );
    }

    #[test]
    fn background_recovery_keeps_unrelated_ready_binding_and_accepts_participants() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready W1");
        let restore = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("restore admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("restore must admit"),
        };
        core.mark_transition_joined(&restore).expect("restore Join");
        let (descriptor_id, _) = core
            .require_recovery(&restore, Some(binding(1)), None)
            .expect("transfer W1 responsibility");

        let open = match core
            .begin_transition(AdmissionKind::Open)
            .expect("W2 open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("W2 open must admit"),
        };
        core.mark_transition_joined(&open).expect("W2 Join");
        core.activate(&open, binding(2), ContentEffect::Retained)
            .expect("W2 activation");

        let recovery = match core
            .admit_background_recovery(descriptor_id)
            .expect("background recovery admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("background recovery must admit"),
        };
        assert_eq!(
            core.snapshot().expect("background snapshot").binding(),
            Some(&binding(2))
        );
        let mut foreground = match core
            .admit_foreground_permit()
            .expect("W2 foreground admission")
        {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { reason, .. } => {
                panic!("W2 foreground must remain admitted: {reason:?}")
            }
        };
        foreground.start().expect("foreground start");
        assert!(matches!(
            core.begin_transition(AdmissionKind::Open)
                .expect("Open admission while background recovery is live"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ));
        assert!(matches!(
            core.begin_transition(AdmissionKind::Restore)
                .expect("Restore admission while background recovery is live"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ));
        assert!(matches!(
            core.admit_background_recovery(descriptor_id)
                .expect("duplicate background recovery admission"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ));
        core.mark_transition_joined(&recovery)
            .expect("background recovery Join");
        core.abandon_background_recovery(&recovery, binding(2))
            .expect("background recovery failure handoff");
        let retry = match core
            .admit_background_recovery(descriptor_id)
            .expect("background recovery retry admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("retry must admit"),
        };
        core.mark_transition_joined(&retry)
            .expect("background retry Join");
        core.complete_background_recovery(&retry, binding(2))
            .expect("background recovery completion");
        foreground.mark_joined().expect("foreground Join");
        foreground.release().expect("foreground release");
        assert_eq!(
            core.snapshot().expect("final snapshot").binding(),
            Some(&binding(2))
        );
    }

    #[test]
    fn shutdown_can_retire_background_recovery_without_restoring_ready() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready W1");
        let restore = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("restore admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("restore must admit"),
        };
        core.mark_transition_joined(&restore).expect("restore Join");
        let (descriptor_id, _) = core
            .require_recovery(&restore, Some(binding(1)), None)
            .expect("transfer W1 responsibility");
        let open = match core
            .begin_transition(AdmissionKind::Open)
            .expect("W2 open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("W2 open must admit"),
        };
        core.mark_transition_joined(&open).expect("W2 Join");
        core.activate(&open, binding(2), ContentEffect::Retained)
            .expect("W2 activation");
        let recovery = match core
            .admit_background_recovery(descriptor_id)
            .expect("background recovery admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("background recovery must admit"),
        };
        core.request_shutdown().expect("shutdown request");
        core.mark_transition_joined(&recovery)
            .expect("background recovery Join after shutdown");
        core.complete_background_recovery(&recovery, binding(2))
            .expect("shutdown background completion");
        assert!(matches!(
            core.snapshot().expect("shutdown snapshot").state,
            LifecycleState::Transition {
                operation_id: OperationId(0),
                stage: TransitionStage::Finishing,
            }
        ));

        let generation = core
            .control_request(
                descriptor_id,
                &ControlRequest {
                    generation: core
                        .descriptor(descriptor_id)
                        .expect("descriptor")
                        .control_generation,
                    fingerprint: format!("shutdown-recovery:{descriptor_id}"),
                    payload: "resolved".to_owned(),
                },
            )
            .expect("control request");
        let generation = match generation {
            ControlSlotOutcome::Accepted { generation }
            | ControlSlotOutcome::Replay {
                generation,
                result: None,
            } => generation,
            other => panic!("unexpected control slot outcome: {other:?}"),
        };
        core.complete_control(descriptor_id, generation, "resolved")
            .expect("control complete");
        core.resolve_control(descriptor_id, generation)
            .expect("control resolve");
        core.ack_control(descriptor_id, generation)
            .expect("control ack");
        assert!(core
            .release_descriptor_responsibility(descriptor_id)
            .expect("descriptor release"));
        assert!(matches!(
            core.close().expect("close after shutdown handoff").state,
            LifecycleState::Closed
        ));
    }

    #[test]
    fn shutdown_can_abandon_background_recovery_after_late_join() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready W1");
        let restore = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("restore admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("restore must admit"),
        };
        core.mark_transition_joined(&restore).expect("restore Join");
        let (descriptor_id, _) = core
            .require_recovery(&restore, Some(binding(1)), None)
            .expect("transfer W1 responsibility");
        let open = match core
            .begin_transition(AdmissionKind::Open)
            .expect("W2 open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("W2 open must admit"),
        };
        core.mark_transition_joined(&open).expect("W2 Join");
        core.activate(&open, binding(2), ContentEffect::Retained)
            .expect("W2 activation");
        let recovery = match core
            .admit_background_recovery(descriptor_id)
            .expect("background recovery admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("background recovery must admit"),
        };
        core.request_shutdown().expect("shutdown request");
        core.mark_transition_joined(&recovery)
            .expect("late background recovery Join");
        core.abandon_background_recovery(&recovery, binding(2))
            .expect("background recovery failure handoff during shutdown");
        assert!(matches!(
            core.snapshot().expect("shutdown snapshot").state,
            LifecycleState::Transition {
                operation_id: OperationId(0),
                stage: TransitionStage::Finishing,
            }
        ));
        assert!(matches!(
            core.close().expect_err("unresolved descriptor must block close"),
            LifecycleError::ActiveOperations
        ));
    }

    #[test]
    fn transition_reserves_and_transfers_responsibility_to_descriptor() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
        };
        assert_eq!(core.responsibility_counts().expect("count").0, 1);
        core.mark_transition_joined(&ticket).expect("join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("recovery descriptor");
        assert_eq!(
            core.responsibility_counts().expect("transferred count").0,
            1
        );
        let request = ControlRequest {
            generation: ControlGeneration::new(1),
            fingerprint: "root-1".into(),
            payload: "recover".into(),
        };
        let generation = match core
            .control_request(descriptor_id, &request)
            .expect("control request")
        {
            ControlSlotOutcome::Accepted { generation } => generation,
            other => panic!("expected control slot, got {other:?}"),
        };
        core.complete_control(descriptor_id, generation, "resolved")
            .expect("control completion");
        core.resolve_control(descriptor_id, generation)
            .expect("control resolution");
        core.ack_control(descriptor_id, generation)
            .expect("control ACK");
        assert!(core
            .release_descriptor_responsibility(descriptor_id)
            .expect("release descriptor responsibility"));
        assert_eq!(core.responsibility_counts().expect("released count").0, 0);
    }

    #[test]
    fn fence_resolves_full_delivery_without_allocating_a_record() {
        let core = WorkspaceLifecycleCore::new();
        for index in 1..=DELIVERY_CAPACITY as u64 {
            assert!(matches!(
                core.admit_delivery(format!("fingerprint-{index}"))
                    .expect("delivery admission"),
                DeliveryAdmissionOutcome::Accepted { .. }
            ));
        }
        assert!(matches!(
            core.admit_delivery("overflow")
                .expect("full delivery admission"),
            DeliveryAdmissionOutcome::Full { .. }
        ));
        assert_eq!(
            core.delivery_high_water().expect("high water").get(),
            DELIVERY_CAPACITY as u64
        );
        assert!(matches!(
            core.resolve_or_fence(DeliverySequence::new(DELIVERY_CAPACITY as u64 + 1))
                .expect("fence"),
            FenceOutcome::Fenced { .. }
        ));
        assert!(matches!(
            core.admit_delivery_at(
                DeliverySequence::new(DELIVERY_CAPACITY as u64 + 1),
                "overflow"
            )
            .expect("sealed admission"),
            DeliveryAdmissionOutcome::SealedAbsent { .. }
        ));
        core.mark_delivery_terminal(DeliverySequence::new(1))
            .expect("terminalize first record");
        assert!(core
            .ack_delivery(DeliverySequence::new(1))
            .expect("ack first record"));
        assert!(matches!(
            core.admit_delivery_at(
                DeliverySequence::new(DELIVERY_CAPACITY as u64 + 1),
                "overflow"
            )
            .expect("delayed overflow admission"),
            DeliveryAdmissionOutcome::SealedAbsent { .. }
        ));
        assert_eq!(
            core.delivery_high_water().expect("high water").get(),
            DELIVERY_CAPACITY as u64 + 1
        );
    }

    #[test]
    fn fenced_delivery_ack_retires_recordless_sequence() {
        let core = WorkspaceLifecycleCore::new();
        assert!(matches!(
            core.resolve_or_fence(DeliverySequence::new(1))
                .expect("fence"),
            FenceOutcome::Fenced { sequence } if sequence == DeliverySequence::new(1)
        ));
        assert!(core
            .ack_delivery(DeliverySequence::new(1))
            .expect("recordless fence ACK"));
        assert!(core
            .ack_delivery(DeliverySequence::new(1))
            .expect("idempotent fence ACK"));
    }

    #[test]
    fn close_waits_for_unacked_recordless_fence() {
        let core = WorkspaceLifecycleCore::new();
        core.resolve_or_fence(DeliverySequence::new(1))
            .expect("recordless fence");
        assert_eq!(
            core.close().expect_err("unacked fence must block close"),
            LifecycleError::ActiveOperations
        );
        assert!(core
            .ack_delivery(DeliverySequence::new(1))
            .expect("fence ACK"));
        assert!(matches!(
            core.close().expect("close after fence ACK").state,
            LifecycleState::Closed
        ));
    }

    #[test]
    fn ack_retires_delivery_without_releasing_responsibility() {
        let core = WorkspaceLifecycleCore::new();
        let reservation = core
            .reserve_responsibility(ResponsibilityKind::WorkspaceOperation, OperationId::new(7))
            .expect("responsibility");
        core.admit_delivery("root-result")
            .expect("delivery admission");
        assert!(core
            .mark_delivery_terminal(DeliverySequence::new(1))
            .expect("terminalize"));
        assert!(core.ack_delivery(DeliverySequence::new(1)).expect("ack"));
        assert_eq!(core.responsibility_counts().expect("counts").0, 1);
        assert!(core
            .release_responsibility(&reservation)
            .expect("release responsibility"));
    }

    #[test]
    fn duplicate_delivery_replays_terminal_result_until_ack() {
        let core = WorkspaceLifecycleCore::new();
        let sequence = DeliverySequence::new(1);
        assert!(matches!(
            core.admit_delivery_at(sequence, "same-fingerprint")
                .expect("initial admission"),
            DeliveryAdmissionOutcome::Accepted { .. }
        ));
        core.mark_delivery_terminal_with_result(
            sequence,
            Some(r#"{"status":"accepted","hasMore":false}"#.to_owned()),
        )
        .expect("terminal result");
        assert!(matches!(
            core.admit_delivery_at(sequence, "same-fingerprint")
                .expect("replay admission"),
            DeliveryAdmissionOutcome::Replay {
                result: Some(result),
                ..
            } if result == r#"{"status":"accepted","hasMore":false}"#
        ));
        assert!(core.ack_delivery(sequence).expect("ack"));
        assert!(matches!(
            core.admit_delivery_at(sequence, "same-fingerprint")
                .expect("retired lookup"),
            DeliveryAdmissionOutcome::SealedAbsent { .. }
        ));
    }

    #[test]
    fn responsibility_capacity_keeps_one_recovery_cell_available() {
        let core = WorkspaceLifecycleCore::new();
        let mut general = Vec::new();
        for index in 0..GENERAL_RESPONSIBILITY_CAPACITY {
            general.push(
                core.reserve_responsibility(
                    ResponsibilityKind::ExactRun,
                    OperationId::new(index as u64 + 1),
                )
                .expect("general cell"),
            );
        }
        assert!(matches!(
            core.reserve_responsibility(
                ResponsibilityKind::WorkspaceOperation,
                OperationId::new(999)
            ),
            Err(LifecycleError::Responsibility(
                ResponsibilityError::GeneralCapacity
            ))
        ));
        let emergency = core
            .reserve_responsibility(
                ResponsibilityKind::RecoveryTransition,
                OperationId::new(1000),
            )
            .expect("dedicated recovery cell");
        assert!(matches!(
            core.reserve_responsibility(
                ResponsibilityKind::RecoveryTransition,
                OperationId::new(1001),
            ),
            Err(LifecycleError::Responsibility(
                ResponsibilityError::EmergencyCapacity
            ))
        ));
        assert_eq!(core.responsibility_counts().expect("counts"), (255, true));
        core.release_responsibility(&emergency)
            .expect("release emergency");
        for reservation in general {
            core.release_responsibility(&reservation)
                .expect("release general");
        }
        assert_eq!(
            core.responsibility_counts().expect("empty counts"),
            (0, false)
        );
    }

    #[test]
    fn descriptor_control_is_idempotent_and_generation_bound() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket)
            .expect("supervisor Join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("descriptor");
        let request = ControlRequest {
            generation: ControlGeneration::new(1),
            fingerprint: "recover-1".into(),
            payload: "open".into(),
        };
        let accepted = core
            .control_request(descriptor_id, &request)
            .expect("control request");
        let generation = match accepted {
            ControlSlotOutcome::Accepted { generation } => generation,
            other => panic!("expected accepted control slot, got {other:?}"),
        };
        assert!(matches!(
            core.control_request(descriptor_id, &request)
                .expect("replay"),
            ControlSlotOutcome::Replay { .. }
        ));
        let conflicting_payload = ControlRequest {
            generation: request.generation,
            fingerprint: request.fingerprint.clone(),
            payload: "different".into(),
        };
        assert!(matches!(
            core.control_request(descriptor_id, &conflicting_payload)
                .expect("payload conflict"),
            ControlSlotOutcome::Conflict { .. }
        ));
        assert!(matches!(
            core.ack_control(descriptor_id, generation)
                .expect_err("cannot ACK before a result"),
            LifecycleError::ControlResultPending(_)
        ));
        core.complete_control(descriptor_id, generation, "ok")
            .expect("complete");
        core.resolve_control(descriptor_id, generation)
            .expect("resolve");
        assert!(matches!(
            core.control_request(descriptor_id, &request)
                .expect("replay result"),
            ControlSlotOutcome::Replay {
                result: Some(_),
                ..
            }
        ));
        core.ack_control(descriptor_id, generation)
            .expect("ack control");
        assert!(matches!(
            core.control_request(descriptor_id, &request)
                .expect("retired"),
            ControlSlotOutcome::Retired
        ));
    }

    #[test]
    fn control_retry_requires_ack_and_rejects_old_generation_requests() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket).expect("join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("descriptor");
        let first = ControlRequest {
            generation: ControlGeneration::new(1),
            fingerprint: "retry-root".into(),
            payload: "recover".into(),
        };
        let generation = match core.control_request(descriptor_id, &first).expect("accept") {
            ControlSlotOutcome::Accepted { generation } => generation,
            other => panic!("expected accepted, got {other:?}"),
        };
        core.complete_control(descriptor_id, generation, "retryable-error")
            .expect("failed result");
        assert_eq!(
            core.retry_control(descriptor_id)
                .expect_err("unACKed result cannot be overwritten"),
            LifecycleError::ControlResultPending(descriptor_id)
        );
        // A failed result may be transport-ACKed while its descriptor remains
        // unresolved; the responsibility cell is released only by a later
        // successful generation.
        core.ack_control(descriptor_id, generation)
            .expect("ACK failed result");
        let next_generation = core.retry_control(descriptor_id).expect("next generation");
        assert_ne!(next_generation, generation);
        assert_eq!(
            core.control_request(descriptor_id, &first)
                .expect_err("old generation must not be accepted"),
            LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation,
            }
        );
        let retry = ControlRequest {
            generation: next_generation,
            fingerprint: first.fingerprint,
            payload: first.payload,
        };
        assert!(matches!(
            core.control_request(descriptor_id, &retry).expect("retry accept"),
            ControlSlotOutcome::Accepted { generation } if generation == next_generation
        ));
    }

    #[test]
    fn control_retry_does_not_retain_acknowledged_result_history() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket).expect("join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("descriptor");

        let mut generation = ControlGeneration::new(1);
        for index in 0..2048_u32 {
            let request = ControlRequest {
                generation,
                fingerprint: format!("bounded-{index}"),
                payload: "x".repeat(16 * 1024),
            };
            assert!(matches!(
                core.control_request(descriptor_id, &request).expect("accept"),
                ControlSlotOutcome::Accepted { .. }
            ));
            core.complete_control(descriptor_id, generation, "retryable-result")
                .expect("complete");
            core.ack_control(descriptor_id, generation).expect("ack");
            generation = core.retry_control(descriptor_id).expect("retry");
        }
        // The final acknowledged result is retired in-place. There is no
        // generation history to replay or retain after the next retry.
        let next = core
            .control_request(
                descriptor_id,
                &ControlRequest {
                    generation,
                    fingerprint: "bounded-final".into(),
                    payload: "next".into(),
                },
            )
            .expect("current generation remains addressable");
        assert!(matches!(next, ControlSlotOutcome::Accepted { .. }));
    }

    #[test]
    fn close_waits_for_control_ack_and_descriptor_responsibility_release() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let ticket = match core
            .begin_transition(AdmissionKind::Restore)
            .expect("transition")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("admitted"),
        };
        core.mark_transition_joined(&ticket).expect("join");
        let (descriptor_id, _) = core
            .require_recovery(&ticket, Some(binding(1)), None)
            .expect("descriptor");
        let request = ControlRequest {
            generation: ControlGeneration::new(1),
            fingerprint: "close-1".into(),
            payload: "recover".into(),
        };
        let generation = match core.control_request(descriptor_id, &request).unwrap() {
            ControlSlotOutcome::Accepted { generation } => generation,
            other => panic!("expected accepted, got {other:?}"),
        };
        core.complete_control(descriptor_id, generation, "done")
            .expect("complete");
        assert_eq!(
            core.close()
                .expect_err("unacked descriptor must block close"),
            LifecycleError::ActiveOperations
        );
        core.resolve_control(descriptor_id, generation)
            .expect("resolve");
        core.ack_control(descriptor_id, generation).expect("ack");
        core.release_descriptor_responsibility(descriptor_id)
            .expect("release responsibility");
        assert!(matches!(
            core.descriptor(descriptor_id),
            Err(LifecycleError::RetiredDescriptor(id)) if id == descriptor_id
        ));
        assert!(matches!(
            core.admit_recovery(descriptor_id).expect("retired recovery"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::Retired,
                ..
            }
        ));
        core.close().expect("closed after descriptor ACK");
    }

    #[test]
    fn creation_outcomes_distinguish_confirmed_rollback_from_unknown() {
        for (outcome, expected) in [
            (
                RunCreationTransactionOutcome::ConfirmedRollback,
                RunCreationState::CreationNotCommitted,
            ),
            (
                RunCreationTransactionOutcome::Unknown,
                RunCreationState::CreationUnknown,
            ),
        ] {
            let core = WorkspaceLifecycleCore::new();
            core.set_ready(binding(1)).expect("ready");
            let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
                PermitAdmission::Admitted(permit) => permit,
                PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
            };
            permit
                .attach_run_ownership(RunOwnership {
                    state: RunCreationState::Reserved,
                    handle: run_handle("reserved-run", "work-a"),
                })
                .expect("reserve exact run tuple");
            permit
                .mark_run_creation_started("reserved-run")
                .expect("creation started");
            permit
                .mark_run_creation_outcome("reserved-run", outcome)
                .expect("record creation outcome");
            permit.mark_joined().expect("worker joined");
            let descriptor_id = permit.transfer_to_recovery().expect("recovery descriptor");
            let descriptor = core.descriptor(descriptor_id).expect("descriptor snapshot");
            assert_eq!(descriptor.run.expect("run ownership").state, expected);
        }
    }

    #[test]
    fn reuse_selection_recovery_replaces_primary_and_additional_by_exact_run_id() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        permit
            .attach_run_ownership(RunOwnership {
                state: RunCreationState::Reserved,
                handle: run_handle("reserved-primary", "work-primary"),
            })
            .expect("reserve primary");
        permit
            .mark_run_creation_started("reserved-primary")
            .expect("primary creation started");
        permit
            .mark_run_reuse_selection_unknown("reserved-primary", "selected-primary")
            .expect("primary reuse selection is unresolved");

        permit
            .attach_run_ownership(RunOwnership {
                state: RunCreationState::Reserved,
                handle: run_handle("reserved-additional", "work-additional"),
            })
            .expect("reserve additional");
        permit
            .mark_run_creation_started("reserved-additional")
            .expect("additional creation started");
        permit
            .mark_run_reuse_selection_unknown("reserved-additional", "selected-additional")
            .expect("additional reuse selection is unresolved");

        permit.mark_joined().expect("worker joined");
        let descriptor_id = permit.transfer_to_recovery().expect("recovery descriptor");
        core.attach_reuse_selection_to_descriptor(
            descriptor_id,
            RunOwnership {
                state: RunCreationState::Reused,
                handle: run_handle("selected-primary", "work-primary"),
            },
        )
        .expect("attach selected primary tuple");
        core.attach_reuse_selection_to_descriptor(
            descriptor_id,
            RunOwnership {
                state: RunCreationState::Reused,
                handle: run_handle("selected-additional", "work-additional"),
            },
        )
        .expect("attach selected additional tuple");

        let descriptor = core.descriptor(descriptor_id).expect("descriptor snapshot");
        assert_eq!(
            descriptor.run.expect("primary tuple").handle.run_id,
            "selected-primary"
        );
        assert_eq!(
            descriptor
                .additional_runs
                .first()
                .expect("additional tuple")
                .handle
                .run_id,
            "selected-additional"
        );
    }
}
