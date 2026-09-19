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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AdmissionRejection {
    NoWorkspace,
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
    acked: bool,
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
        if matches!(state.state, LifecycleState::Closed) {
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
        state.state = LifecycleState::Closed;
        state.revision = state.revision.saturating_add(1);
        self.inner
            .compatibility_switching
            .store(false, Ordering::SeqCst);
        Ok(LifecycleSnapshot::new(state.state.clone(), state.revision))
    }

    pub fn admit(&self, kind: AdmissionKind) -> Result<AdmissionOutcome, LifecycleError> {
        let mut state = self.lock_state()?;
        let current = self.projected_state_locked(&state);
        let rejection = match (&current, kind) {
            (LifecycleState::Closed, _) => Some(AdmissionRejection::Closed),
            (LifecycleState::Transition { .. }, kind) if !kind.is_capacity_independent() => {
                Some(AdmissionRejection::Transition)
            }
            (LifecycleState::RecoveryRequired { .. }, kind)
                if !matches!(
                    kind,
                    AdmissionKind::Recover | AdmissionKind::Snapshot | AdmissionKind::Shutdown
                ) =>
            {
                Some(AdmissionRejection::RecoveryRequired)
            }
            (LifecycleState::NoWorkspace, AdmissionKind::Maintenance) => {
                Some(AdmissionRejection::NoWorkspace)
            }
            (LifecycleState::Ready(_), AdmissionKind::Recover) => {
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

        let operation_id = state.next_operation;
        state.next_operation = OperationId::new(operation_id.get().saturating_add(1));
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
        let outcome = self.admit(kind)?;
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            let mut state = self.lock_state()?;
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
        let exact = ticket.original_binding.as_ref() == Some(&binding)
            && matches!(
                &state.state,
                LifecycleState::Ready(current) if current == &binding
            )
            || ticket.original_binding.as_ref() == Some(&binding)
                && matches!(state.state, LifecycleState::Transition { operation_id, .. } if operation_id == ticket.operation_id);
        if !exact {
            return Err(LifecycleError::BindingChanged {
                operation_id: ticket.operation_id,
            });
        }
        state.state = LifecycleState::Ready(binding.clone());
        state.admissions.remove(&ticket.operation_id);
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
        if matches!(state.state, LifecycleState::Closed) {
            return Err(LifecycleError::Closed);
        }
        state.state = LifecycleState::Ready(binding.clone());
        state.admissions.remove(&ticket.operation_id);
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
        let descriptor_id = state.next_descriptor;
        state.next_descriptor = RecoveryDescriptorId::new(descriptor_id.get().saturating_add(1));
        let generation = state.next_generation;
        state.next_generation = ControlGeneration::new(generation.get().saturating_add(1));
        let descriptor = RecoveryDescriptor {
            descriptor_id,
            root_operation_id: ticket.operation_id,
            expected_binding,
            run,
            control_generation: generation,
            resolved: false,
        };
        state.descriptors.insert(descriptor_id, descriptor);
        state.control_slots.insert(
            descriptor_id,
            ControlSlot {
                generation,
                fingerprint: String::new(),
                result: None,
                acked: false,
                retired: false,
            },
        );
        state.state = LifecycleState::RecoveryRequired { descriptor_id };
        state.admissions.remove(&ticket.operation_id);
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
            return Ok(ControlSlotOutcome::Accepted {
                generation: slot.generation,
            });
        }
        if slot.fingerprint != request.fingerprint {
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
        slot.result = Some(result.into());
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
            .get_mut(&descriptor_id)
            .ok_or(LifecycleError::UnknownDescriptor(descriptor_id))?;
        if slot.generation != generation || slot.retired {
            return Err(LifecycleError::ControlGenerationMismatch {
                descriptor: descriptor_id,
                generation,
            });
        }
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
                    DeliveryAdmissionOutcome::Replay { sequence }
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
                acked: false,
            },
        );
        Ok(DeliveryAdmissionOutcome::Accepted { sequence })
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

    pub fn release_responsibility(
        &self,
        reservation: &ResponsibilityReservation,
    ) -> Result<bool, LifecycleError> {
        let mut state = self.lock_state()?;
        if reservation.kind.uses_emergency_cell() {
            if state
                .responsibilities
                .emergency
                .as_ref()
                .map(|value| value.id == reservation.id)
                .unwrap_or(false)
            {
                state.responsibilities.emergency = None;
                return Ok(true);
            }
            return Ok(false);
        }
        Ok(state
            .responsibilities
            .general
            .remove(&reservation.id)
            .is_some())
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
        assert!(core.ack_delivery(DeliverySequence::new(1)).expect("ack"));
        assert_eq!(core.responsibility_counts().expect("counts").0, 1);
        assert!(core
            .release_responsibility(&reservation)
            .expect("release responsibility"));
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
}
