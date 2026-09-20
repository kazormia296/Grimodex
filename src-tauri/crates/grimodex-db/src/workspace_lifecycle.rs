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
use std::sync::{Arc, Mutex};
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveBinding {
    /// The canonical workspace locator captured at admission time.
    pub locator: String,
    /// Durable workspace identity. A path or display name is not sufficient.
    pub workspace_id: String,
    /// Process-local authority instance. Reopening the same file creates a new
    /// value, so a reopened authority is never an `Unchanged` binding.
    pub authority_instance: u64,
    /// Monotonic generation for restore/recovery handoff.
    pub recovery_generation: u64,
}

impl LiveBinding {
    pub fn new(
        locator: impl Into<String>,
        workspace_id: impl Into<String>,
        authority_instance: u64,
        recovery_generation: u64,
    ) -> Self {
        Self {
            locator: locator.into(),
            workspace_id: workspace_id.into(),
            authority_instance,
            recovery_generation,
        }
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

    fn responsibility_kind(self) -> Option<ResponsibilityKind> {
        match self {
            Self::Open | Self::Restore => Some(ResponsibilityKind::WorkspaceOperation),
            Self::Maintenance => Some(ResponsibilityKind::ExactRun),
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

    pub fn stop_requested(&self) -> Result<bool, LifecycleError> {
        self.core.execution_stop_requested(self.execution_id)
    }

    /// Attach the exact durable Run/Task/Attempt tuple after the writer has
    /// selected fresh versus reuse. The slot is immutable for this execution,
    /// so a late or conflicting tuple cannot replace ownership.
    pub fn attach_run_ownership(&self, run: RunOwnership) -> Result<(), LifecycleError> {
        self.core.attach_run_ownership(self.execution_id, run)
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
        if let Err(error) = self.core.complete_execution(self.execution_id) {
            return Err(error);
        }
        let result = self.core.release_admission(&self.ticket);
        self.released = true;
        result
    }

    /// Consume the Native permit by moving its exact execution/run
    /// responsibility to a shared recovery descriptor. This is used only
    /// after the worker has joined and cleanup cannot prove a normal release.
    pub fn transfer_to_recovery(mut self) -> Result<RecoveryDescriptorId, LifecycleError> {
        // A recovery handoff is only legal after the supervisor has observed
        // the worker Join. The permit API deliberately does not fabricate
        // that boundary for a dropped/panicking worker.
        if !self.joined {
            return Err(LifecycleError::NotJoined(self.ticket.operation_id));
        }
        let descriptor = match self
            .core
            .transfer_execution_to_recovery(&self.ticket, self.execution_id)
        {
            Ok(descriptor) => descriptor,
            Err(error) => return Err(error),
        };
        self.released = true;
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
    Created,
    Reused,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecoveryDescriptor {
    pub descriptor_id: RecoveryDescriptorId,
    pub root_operation_id: OperationId,
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
    /// ACK retirement is idempotent across a lost Native reply.  Keep the
    /// monotonic receipt identity after the record leaves `records` so a
    /// replayed ACK can converge instead of becoming a permanent `pending`.
    retired: BTreeSet<DeliverySequence>,
}

#[derive(Clone, Debug)]
struct ControlSlot {
    generation: ControlGeneration,
    fingerprint: String,
    payload: String,
    result: Option<String>,
    acked: bool,
    retired: bool,
    /// Results from prior failed/retried generations remain immutable even
    /// after the active slot advances.  This prevents an unACKed result from
    /// being overwritten in place.
    completed_history: BTreeMap<ControlGeneration, String>,
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
            shutdown_requested: false,
            descriptors: BTreeMap::new(),
            control_slots: BTreeMap::new(),
            delivery: DeliveryLedger::default(),
            responsibilities: ResponsibilityLedger::default(),
        }
    }
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

    pub fn state_revision(&self) -> Result<StateRevision, LifecycleError> {
        Ok(self.lock_state()?.revision)
    }

    pub fn set_ready(&self, binding: LiveBinding) -> Result<LifecycleSnapshot, LifecycleError> {
        let mut state = self.lock_state()?;
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
            || state
                .descriptors
                .values()
                .any(|descriptor| !descriptor.resolved || descriptor.responsibility.is_some())
            || state
                .control_slots
                .values()
                .any(|slot| !slot.retired || !slot.acked)
            || !state.delivery.records.is_empty()
            || !state.responsibilities.general.is_empty()
            || state.responsibilities.emergency.is_some()
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
        let mut state = self.lock_state()?;
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
        self.admit_locked(&mut state, kind, None)
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
        let is_safe_mode_root = descriptor_id == SAFE_MODE_RECOVERY_DESCRIPTOR_ID;
        let has_descriptor_root = state.descriptors.contains_key(&descriptor_id);
        let descriptor_is_unresolved = state
            .descriptors
            .get(&descriptor_id)
            .is_some_and(|descriptor| !descriptor.resolved);
        let state_allows_descriptor = matches!(
            state.state,
            LifecycleState::RecoveryRequired { descriptor_id: current }
                if current == descriptor_id
        ) || (matches!(state.state, LifecycleState::Ready(_))
            && descriptor_is_unresolved);
        if !state_allows_descriptor || (!has_descriptor_root && !is_safe_mode_root) {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::RecoveryPrerequisite,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(&state),
                    state.revision,
                ),
            });
        }
        if (!is_safe_mode_root
            && state
                .descriptors
                .get(&descriptor_id)
                .is_some_and(|descriptor| descriptor.resolved))
            || (!is_safe_mode_root
                && state
                    .control_slots
                    .get(&descriptor_id)
                    .is_some_and(|slot| slot.retired))
        {
            return Ok(AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::Retired,
                snapshot: LifecycleSnapshot::new(
                    self.projected_state_locked(&state),
                    state.revision,
                ),
            });
        }
        let outcome = self.admit_locked(&mut state, AdmissionKind::Recover, Some(descriptor_id))?;
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
        Ok(match self.admit(AdmissionKind::Maintenance)? {
            AdmissionOutcome::Admitted(ticket) => {
                // Operation ids are monotonic within this core and therefore
                // provide a collision-free process-local execution slot for
                // the synchronous Native maintenance supervisor.  The slot
                // is reserved before the caller can start any DB work.
                let execution_id = ExecutionId::new(ticket.operation_id.get());
                self.reserve_execution(ticket.operation_id, execution_id)?;
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
        Ok(true)
    }

    fn admit_locked(
        &self,
        state: &mut CoreState,
        kind: AdmissionKind,
        recovery_descriptor_id: Option<RecoveryDescriptorId>,
    ) -> Result<AdmissionOutcome, LifecycleError> {
        let current = self.projected_state_locked(&state);
        let rejection = match (&current, kind) {
            (LifecycleState::Closed, _) => Some(AdmissionRejection::Closed),
            (_, kind)
                if state.shutdown_requested
                    && !matches!(kind, AdmissionKind::Snapshot | AdmissionKind::Shutdown) =>
            {
                Some(AdmissionRejection::Closed)
            }
            // Maintenance is a single execution lane.  The second caller is
            // a typed non-admission; it does not create a second owner or a
            // second retry record.
            (_, AdmissionKind::Maintenance)
                if state
                    .admissions
                    .values()
                    .any(|ticket| matches!(ticket.kind, AdmissionKind::Maintenance)) =>
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
                            .is_some_and(|descriptor| !descriptor.resolved)
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

        let operation_id = state.next_operation;
        state.next_operation = OperationId::new(operation_id.get().saturating_add(1));
        let responsibility = match kind.responsibility_kind() {
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
        if !kind.is_transition() {
            return self.admit(kind);
        }
        // Admission and the transition state write are one critical section.
        // Calling `admit` and setting Transition in separate locks would let
        // two concurrent Open/Restore requests both observe Ready and both
        // become exclusive owners.
        let mut state = self.lock_state()?;
        let outcome = self.admit_locked(&mut state, kind, None)?;
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
            if existing.state == RunCreationState::Reserved {
                *existing = run;
                return Ok(());
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
        if execution.phase != ExecutionPhase::Reserved {
            return Err(LifecycleError::InvalidExecutionTransition);
        }
        if shutdown_requested {
            // A pending-start owner remains visible to the supervisor, but
            // its body must not begin after shutdown has closed admission.
            // Marking the stop request before returning lets the common
            // finalizer observe Join and retire the reservation explicitly.
            execution.phase = ExecutionPhase::StopRequested;
            execution.stop_requested = true;
            return Err(LifecycleError::Closed);
        }
        execution.phase = ExecutionPhase::Started;
        Ok(())
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
                .map(|ownership| ownership.handle.project_id.clone())
                .collect::<Vec<_>>();
        let operation_id = execution.operation_id;
        execution.phase = ExecutionPhase::Completed;
            (operation_id, project_reservations)
        };
        for project_id in project_reservations {
            crate::narrative_extraction::release_project_creation(&project_id);
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
                completed_history: BTreeMap::new(),
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
        Ok(descriptor_id)
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
        if !state
            .physical_exclusive_operations
            .insert(ticket.operation_id)
        {
            return Err(LifecycleError::ActiveOperations);
        }
        Ok(())
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
        let exact_original_binding = ticket.original_binding.as_ref() == Some(&binding);
        let joined = state.joined_operations.contains(&ticket.operation_id);
        let exact = exact_original_binding
            && matches!(
                state.state,
                LifecycleState::Transition { operation_id, .. }
                    if operation_id == ticket.operation_id && joined
            );
        if state.shutdown_requested || !exact {
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
        state.state = LifecycleState::Ready(binding.clone());
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
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
        if matches!(state.state, LifecycleState::Closed) {
            return Err(LifecycleError::Closed);
        }
        if state.shutdown_requested {
            return Err(LifecycleError::Closed);
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
        state.state = LifecycleState::Ready(binding.clone());
        state.admissions.remove(&ticket.operation_id);
        state.joined_operations.remove(&ticket.operation_id);
        if let Some(reservation) = &ticket.responsibility {
            Self::release_responsibility_locked(&mut state, reservation);
        }
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
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if !ticket.kind.is_transition() {
            return Err(LifecycleError::InvalidState);
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
            let descriptor = state
                .descriptors
                .get_mut(&existing_id)
                .ok_or(LifecycleError::UnknownDescriptor(existing_id))?;
            if descriptor.resolved {
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
            state.state = LifecycleState::RecoveryRequired {
                descriptor_id: existing_id,
            };
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
                completed_history: BTreeMap::new(),
            },
        );
        state.state = LifecycleState::RecoveryRequired { descriptor_id };
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
        let slot = state
            .control_slots
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
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
    /// or responsibility cell.  The previous result is retained by generation
    /// and cannot be overwritten or replayed as a new execution.
    pub fn retry_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<ControlGeneration, LifecycleError> {
        let mut state = self.lock_state()?;
        let descriptor_unresolved = state
            .descriptors
            .get(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?
            .resolved
            == false;
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
        slot.completed_history
            .insert(slot.generation, previous_result);
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
        self.lock_state()?
            .descriptors
            .get(&descriptor_id)
            .cloned()
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))
    }

    /// Return unresolved descriptor roots for the Native recovery supervisor.
    /// The values are copied under the core lock; no authority or transport
    /// state is exposed through this helper.
    pub fn unresolved_descriptor_ids(&self) -> Result<Vec<RecoveryDescriptorId>, LifecycleError> {
        Ok(self
            .lock_state()?
            .descriptors
            .values()
            .filter(|descriptor| !descriptor.resolved)
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
    /// been acknowledged. The descriptor itself remains queryable until the
    /// caller retires it through the existing control protocol.
    pub fn release_descriptor_responsibility(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
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
            .map(|ownership| ownership.handle.project_id.clone())
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
        for project_id in project_reservations {
            crate::narrative_extraction::release_project_creation(&project_id);
        }
        Ok(reservation
            .as_ref()
            .map(|value| Self::release_responsibility_locked(&mut state, value))
            .unwrap_or(false))
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
            // A capacity rejection is still a decision about H+1.  Seal the
            // sequence atomically with the rejection so a delayed retry after
            // an unrelated ACK cannot execute the same request.
            state.delivery.high_water = sequence;
            state.delivery.fenced.insert(sequence);
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
            return Ok(state.delivery.retired.contains(&sequence));
        };
        if !record.terminal {
            return Ok(false);
        }
        record.acked = true;
        state.delivery.records.remove(&sequence);
        state.delivery.retired.insert(sequence);
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
        if !value {
            if let Ok(state) = self.inner.state.lock() {
                if matches!(state.state, LifecycleState::Transition { .. })
                    || !state.joined_operations.is_empty()
                    || state
                        .admissions
                        .values()
                        .any(|ticket| ticket.kind.is_transition())
                {
                    return;
                }
            } else {
                // Fail closed on a poisoned state lock.  The next normal
                // lifecycle operation will surface the poison explicitly.
                return;
            }
        }
        self.inner.compatibility_switching.store(value, order);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(instance: u64) -> LiveBinding {
        LiveBinding::new("/tmp/workspace", "workspace-1", instance, 1)
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
        permit.mark_joined().expect("scope Join");
        permit.release().expect("release stopped reservation");
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
        assert!(matches!(
            core.resolve_or_fence(DeliverySequence::new(DELIVERY_CAPACITY as u64 + 1))
                .expect("fence"),
            FenceOutcome::AlreadyFenced { .. }
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
        core.close().expect("closed after descriptor ACK");
    }
}
