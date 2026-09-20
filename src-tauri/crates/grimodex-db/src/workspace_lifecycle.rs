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
            Self::Recover => Some(ResponsibilityKind::RecoveryTransition),
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
    released: bool,
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
    operation_id: OperationId,
}

/// Work-scoped publication marker. It prevents a broad transition permit from
/// being mistaken for a final per-work commit grant.
#[must_use]
pub struct PublicationPermit {
    operation_id: OperationId,
    work_execution_id: WorkExecutionId,
}

impl MaintenancePermit {
    pub fn operation_id(&self) -> OperationId {
        self.ticket.operation_id
    }

    pub fn ticket(&self) -> &AdmissionTicket {
        &self.ticket
    }

    pub fn release(mut self) -> Result<bool, LifecycleError> {
        let result = self.core.release_admission(&self.ticket);
        self.released = true;
        result
    }
}

impl Drop for MaintenancePermit {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.core.release_admission(&self.ticket);
            self.released = true;
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

    pub fn physical_exclusive(&self) -> WorkspaceExclusive {
        WorkspaceExclusive {
            operation_id: self.ticket.operation_id,
        }
    }

    pub fn publication_permit(
        &self,
        work_execution_id: WorkExecutionId,
    ) -> Result<PublicationPermit, LifecycleError> {
        let state = self.core.snapshot()?;
        if !matches!(
            state.state,
            LifecycleState::Transition { operation_id, .. }
                if operation_id == self.ticket.operation_id
        ) {
            return Err(LifecycleError::BindingChanged {
                operation_id: self.ticket.operation_id,
            });
        }
        Ok(PublicationPermit {
            operation_id: self.ticket.operation_id,
            work_execution_id,
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
        self.core.require_recovery(&self.ticket, expected_binding, run)
    }
}

impl WorkspaceExclusive {
    pub fn operation_id(&self) -> OperationId {
        self.operation_id
    }
}

impl PublicationPermit {
    pub fn operation_id(&self) -> OperationId {
        self.operation_id
    }

    pub fn work_execution_id(&self) -> WorkExecutionId {
        self.work_execution_id
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
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub kind: String,
    pub epoch: u64,
    pub sealed_spec: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RunCreationState {
    Reserved,
    CreationNotCommitted,
    CreationUnknown,
    Created,
    Reused,
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
    /// Responsibility transferred from the admitted operation. It remains
    /// live independently of delivery-record ACK until the descriptor root is
    /// explicitly resolved.
    pub responsibility: Option<ResponsibilityReservation>,
    pub control_generation: ControlGeneration,
    pub resolved: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRequest {
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
    #[error("workspace transition {0} has not confirmed worker Join")]
    NotJoined(OperationId),
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
        if !state.admissions.is_empty() || !state.joined_operations.is_empty() {
            return Err(LifecycleError::ActiveOperations);
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
        if !matches!(
            state.state,
            LifecycleState::RecoveryRequired { descriptor_id: current }
                if current == descriptor_id
        ) || (!has_descriptor_root && !is_safe_mode_root)
        {
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
            AdmissionOutcome::Admitted(ticket) => PermitAdmission::Admitted(WorkspaceTransitionPermit {
                core: self.clone(),
                ticket,
            }),
            AdmissionOutcome::NotAdmitted { reason, snapshot } => {
                PermitAdmission::NotAdmitted { reason, snapshot }
            }
        })
    }

    pub fn admit_maintenance_permit(
        &self,
    ) -> Result<PermitAdmission<MaintenancePermit>, LifecycleError> {
        Ok(match self.admit(AdmissionKind::Maintenance)? {
            AdmissionOutcome::Admitted(ticket) => PermitAdmission::Admitted(MaintenancePermit {
                core: self.clone(),
                ticket,
                released: false,
            }),
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
    pub fn release_admission(
        &self,
        ticket: &AdmissionTicket,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        if ticket.kind.is_transition() {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
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
            // The transition permit is the exclusive logical owner. A live
            // maintenance admission must finish or transfer its exact
            // responsibility before Open/Restore can close normal admission.
            (_, kind) if kind.is_transition() && state.admissions.values().any(|ticket| {
                !ticket.kind.is_transition() && !ticket.kind.is_capacity_independent()
            }) => Some(AdmissionRejection::ActiveOperation),
            (LifecycleState::Transition { .. }, kind) if !kind.is_capacity_independent() => {
                Some(AdmissionRejection::Transition)
            }
            // Recovery is descriptor-bound. A bare Recover request has no
            // root to prove, so it cannot be admitted from a transition or
            // an empty/ready workspace through the generic API.
            (LifecycleState::Transition { .. }, AdmissionKind::Recover)
            | (LifecycleState::NoWorkspace, AdmissionKind::Recover)
            | (LifecycleState::Ready(_), AdmissionKind::Recover) => {
                Some(AdmissionRejection::RecoveryPrerequisite)
            }
            (LifecycleState::RecoveryRequired { .. }, kind)
                if !matches!(
                    kind,
                    AdmissionKind::Open
                        | AdmissionKind::Snapshot
                        | AdmissionKind::Shutdown
                        | AdmissionKind::Recover
                )
                    =>
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
            Some(responsibility_kind) => match self.reserve_responsibility_locked(
                state,
                responsibility_kind,
                operation_id,
            ) {
                Ok(reservation) => Some(reservation),
                Err(LifecycleError::Responsibility(_)) => {
                    return Ok(AdmissionOutcome::NotAdmitted {
                        reason: AdmissionRejection::Capacity,
                        snapshot: LifecycleSnapshot::new(current, state.revision),
                    });
                }
                Err(error) => return Err(error),
            },
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
    pub fn mark_transition_joined(
        &self,
        ticket: &AdmissionTicket,
    ) -> Result<(), LifecycleError> {
        let mut state = self.lock_state()?;
        self.require_ticket_locked(&state, ticket)?;
        match state.state {
            LifecycleState::Transition { operation_id, .. }
                if operation_id == ticket.operation_id => {
                    state.joined_operations.insert(ticket.operation_id);
                    Ok(())
                }
            _ => Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            }),
        }
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
        if !exact {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
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
        let descriptor_id = state.next_descriptor;
        state.next_descriptor = RecoveryDescriptorId::new(descriptor_id.get().saturating_add(1));
        let generation = state.next_generation;
        state.next_generation = ControlGeneration::new(generation.get().saturating_add(1));
        let descriptor = RecoveryDescriptor {
            descriptor_id,
            root_operation_id: ticket.operation_id,
            expected_binding,
            run,
            responsibility: ticket.responsibility.clone(),
            control_generation: generation,
            resolved: false,
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
        if let Some(descriptor) = state.descriptors.get_mut(&descriptor_id) {
            descriptor.resolved = true;
        }
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
        if slot.result.is_none()
            || !state
                .descriptors
                .get(&descriptor_id)
                .is_some_and(|descriptor| descriptor.resolved)
        {
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
        let reservation = state
            .descriptors
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?
            .responsibility
            .take();
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
            return Ok(false);
        };
        if !record.terminal {
            return Ok(false);
        }
        record.acked = true;
        state.delivery.records.remove(&sequence);
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
            core.set_ready(binding(1)).expect_err("raw Ready must be rejected"),
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
            core.close().expect_err("active transition must block close"),
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
        assert_eq!(
            transition.physical_exclusive().operation_id(),
            transition.operation_id()
        );
        let publication = transition
            .publication_permit(WorkExecutionId::new(9))
            .expect("publication permit");
        assert_eq!(publication.work_execution_id(), WorkExecutionId::new(9));
        transition
            .activate(binding(2), ContentEffect::Retained)
            .expect("activation after Join");

        match core.admit_maintenance_permit().expect("maintenance permit") {
            PermitAdmission::Admitted(permit) => {
                assert!(permit.release().expect("release"));
            }
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        }
    }

    #[test]
    fn transition_cannot_overtake_maintenance_and_drop_releases_its_owner() {
        let core = WorkspaceLifecycleCore::new();
        core.set_ready(binding(1)).expect("ready");
        let maintenance = match core.admit_maintenance_permit().expect("maintenance") {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { .. } => panic!("maintenance must be admitted"),
        };
        assert!(matches!(
            core.begin_transition(AdmissionKind::Open)
                .expect("transition admission"),
            AdmissionOutcome::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ));
        drop(maintenance);
        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("transition after maintenance release")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("transition must be admitted"),
        };
        core.mark_transition_joined(&ticket).expect("Join");
        core.complete_unchanged(&ticket, binding(1))
            .expect("restore original binding");
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
        assert_eq!(
            recovery_ticket.recovery_descriptor_id,
            Some(descriptor_id)
        );
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
        assert_eq!(core.responsibility_counts().expect("transferred count").0, 1);
        let request = ControlRequest {
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
        core.release_responsibility(&emergency).expect("release emergency");
        for reservation in general {
            core.release_responsibility(&reservation).expect("release general");
        }
        assert_eq!(core.responsibility_counts().expect("empty counts"), (0, false));
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
            core.close().expect_err("unacked descriptor must block close"),
            LifecycleError::ActiveOperations
        );
        core.ack_control(descriptor_id, generation).expect("ack");
        core.release_descriptor_responsibility(descriptor_id)
            .expect("release responsibility");
        core.close().expect("closed after descriptor ACK");
    }
}
