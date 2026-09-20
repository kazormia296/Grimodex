//! Main-only, renderer-safe projection of the native workspace lifecycle.
//!
//! The shared workspace opener predates the lifecycle core and currently
//! exposes only `WorkspaceState::switching`, the published authority, and the
//! Safe Mode holder.  This adapter deliberately keeps that compatibility
//! surface narrow: it projects those facts into an opaque, revisioned view and
//! never serializes a workspace path, authority id, recovery candidate id, or
//! durable Run identity.

use std::sync::Mutex;

use grimodex_db::state::{PinnedWorkspaceDb, WorkspaceState};
use grimodex_db::AppResult;
use grimodex_db::{
    AdmissionKind, AdmissionOutcome, AdmissionTicket, ContentEffect, ControlGeneration,
    ControlRequest, ControlSlotOutcome, DeliveryAdmissionOutcome, DeliverySequence, FenceOutcome,
    LifecycleResult, LifecycleState, LiveBinding, MaintenancePermit, OperationId, PermitAdmission,
    RecoveryDescriptor, RecoveryDescriptorId, RunOwnership, StateRevision, TransitionStage,
    WorkspaceExclusive, WorkspaceLifecycleCore, WorkspaceParticipant,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const WORKSPACE_LIFECYCLE_EVENT: &str = "workspace:lifecycle-state";
pub(crate) const WORKSPACE_LIFECYCLE_SCHEMA_VERSION: u8 = 1;

/// The only status strings permitted on the main-only lifecycle wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WorkspaceLifecycleStatus {
    Ready,
    Transition,
    RecoveryRequired,
    Closed,
}

/// `activation` is separate from `status` so a restore-only state cannot be
/// mistaken for an active workspace merely because its content was retained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WorkspaceLifecycleActivation {
    Ready,
    RequiresOpen,
    None,
}

/// Strict, renderer-safe snapshot.  The binding token is process-local and
/// opaque; it is a UI correlation value, never an authority or filesystem
/// identity.  `revision` is monotonic for this Backend instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceLifecycleView {
    pub schema_version: u8,
    pub revision: u64,
    pub status: WorkspaceLifecycleStatus,
    pub binding_token: Option<String>,
    pub activation: WorkspaceLifecycleActivation,
}

/// Renderer-safe projection over the shared lifecycle core.
///
/// The core is the only owner of lifecycle state, admission and revisions.
/// This adapter stores only the opaque UI token and the currently admitted
/// transition ticket needed to complete that core operation; it does not keep
/// a second active-membership or switching state machine.
pub(crate) struct WorkspaceLifecycleViewAdapter {
    core: WorkspaceLifecycleCore,
    projection: Mutex<ProjectionState>,
}

/// Operation-scoped terminal classification retained until the Native
/// command converts it into its strict renderer-safe result.  The lifecycle
/// view intentionally does not expose this as a second state machine; it is
/// just a one-shot observation of the core result produced at Join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleTerminalKind {
    Unchanged,
    Activated,
    RecoveryRequired,
}

#[derive(Debug, Default)]
struct ProjectionState {
    token_revision: Option<StateRevision>,
    binding_token: Option<String>,
    /// The last Ready token is retained while an admitted Open/Restore is in
    /// flight. If the exact authority survives and the core completes the
    /// operation as Unchanged, the renderer must receive that same token so
    /// it can resume the proven scope instead of treating a failed pre-swap
    /// operation as a new activation.
    previous_ready_token: Option<String>,
    transition_ticket: Option<AdmissionTicket>,
    /// A descriptor-bound recovery may run for W1 while W2 remains the live
    /// renderer scope. Keep the existing opaque token across that internal
    /// transition so snapshot refresh cannot invalidate W2 merely because
    /// the shared core revision advanced for W1.
    background_recovery_projection: bool,
    last_terminal_kind: Option<LifecycleTerminalKind>,
}

impl Default for WorkspaceLifecycleViewAdapter {
    fn default() -> Self {
        Self::new(WorkspaceLifecycleCore::new())
    }
}

impl WorkspaceLifecycleViewAdapter {
    pub(crate) fn new(core: WorkspaceLifecycleCore) -> Self {
        Self {
            core,
            projection: Mutex::new(ProjectionState::default()),
        }
    }

    /// Return the current core snapshot for Native-only recovery decisions.
    /// The snapshot is not serialized to the renderer; callers still go
    /// through the adapter when publishing the opaque lifecycle view.
    pub(crate) fn lifecycle_snapshot(&self) -> AppResult<grimodex_db::LifecycleSnapshot> {
        Ok(self.core.snapshot()?)
    }

    pub(crate) fn current_transition_ticket(&self) -> AppResult<Option<AdmissionTicket>> {
        Ok(self.lock_projection()?.transition_ticket.clone())
    }

    pub(crate) fn shutdown_requested(&self) -> AppResult<bool> {
        Ok(self.core.shutdown_requested()?)
    }

    pub(crate) fn workspace_participant_count(&self) -> AppResult<usize> {
        Ok(self.core.workspace_participant_count()?)
    }

    pub(crate) fn begin_workspace_participant(&self) -> AppResult<WorkspaceParticipant> {
        Ok(self.core.begin_workspace_participant()?)
    }

    /// Native-only accessors for the exact descriptor control protocol. The
    /// renderer never receives these values; they remain behind the shared
    /// lifecycle owner so recovery cannot be reimplemented in main/JS.
    pub(crate) fn recovery_descriptor(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> AppResult<RecoveryDescriptor> {
        Ok(self.core.descriptor(descriptor_id)?)
    }

    pub(crate) fn recovery_descriptor_ids(&self) -> AppResult<Vec<RecoveryDescriptorId>> {
        Ok(self.core.unresolved_descriptor_ids()?)
    }

    pub(crate) fn attach_reuse_selection_to_descriptor(
        &self,
        descriptor_id: RecoveryDescriptorId,
        run: RunOwnership,
    ) -> AppResult<()> {
        Ok(self
            .core
            .attach_reuse_selection_to_descriptor(descriptor_id, run)?)
    }

    pub(crate) fn mark_descriptor_connection_retired(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> AppResult<()> {
        Ok(self
            .core
            .mark_descriptor_connection_retired(descriptor_id)?)
    }

    pub(crate) fn recovery_authority(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<Option<PinnedWorkspaceDb>> {
        let snapshot = self.core.snapshot()?;
        if !matches!(
            snapshot.state,
            LifecycleState::RecoveryRequired { .. } | LifecycleState::Ready(_)
        ) {
            return Ok(None);
        }
        Ok(workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .as_ref()
            .map(|active| std::sync::Arc::clone(&active.authority)))
    }

    pub(crate) fn request_recovery_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        request: &ControlRequest,
    ) -> AppResult<ControlSlotOutcome> {
        Ok(self.core.control_request(descriptor_id, request)?)
    }

    pub(crate) fn complete_recovery_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        generation: ControlGeneration,
        result: &str,
    ) -> AppResult<()> {
        Ok(self
            .core
            .complete_control(descriptor_id, generation, result.to_owned())?)
    }

    pub(crate) fn resolve_recovery_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        generation: ControlGeneration,
    ) -> AppResult<()> {
        Ok(self.core.resolve_control(descriptor_id, generation)?)
    }

    pub(crate) fn ack_recovery_control(
        &self,
        descriptor_id: RecoveryDescriptorId,
        generation: ControlGeneration,
    ) -> AppResult<()> {
        Ok(self.core.ack_control(descriptor_id, generation)?)
    }

    pub(crate) fn release_recovery_responsibility(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> AppResult<bool> {
        Ok(self.core.release_descriptor_responsibility(descriptor_id)?)
    }

    /// Mark the beginning of an admitted Open/Restore/Shutdown transition.
    /// A second operation is rejected by the core; it never receives an
    /// `Unchanged` result that could revive the previous renderer binding.
    pub(crate) fn begin_transition(&self) -> AppResult<(WorkspaceLifecycleView, bool)> {
        self.begin_transition_kind(AdmissionKind::Open)
    }

    pub(crate) fn begin_transition_kind(
        &self,
        kind: AdmissionKind,
    ) -> AppResult<(WorkspaceLifecycleView, bool)> {
        let outcome = self.try_begin_transition_kind(kind)?;
        let ticket = match outcome {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => {
                return Err(anyhow::anyhow!(
                    // Keep the stable native admission marker used by the
                    // existing maintenance/open callers while retaining the
                    // lifecycle core as the single decision maker.  The
                    // result is still a rejection: no worker or authority
                    // side effect has started.
                    "NEX_MAINTENANCE_ADMISSION_CLOSED: workspace transition is already owned (lifecycle NotAdmitted)"
                )
                .into());
            }
        };
        let mut projection = self.lock_projection()?;
        projection.transition_ticket = Some(ticket);
        let view = self.projected_view_with_projection(&mut projection)?;
        Ok((view, true))
    }

    pub(crate) fn try_begin_transition_kind(
        &self,
        kind: AdmissionKind,
    ) -> AppResult<AdmissionOutcome> {
        let outcome = self.core.begin_transition(kind)?;
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            let mut projection = self.lock_projection()?;
            projection.last_terminal_kind = None;
            if matches!(kind, AdmissionKind::Open | AdmissionKind::Restore) {
                projection.previous_ready_token = projection.binding_token.clone();
            }
            projection.transition_ticket = Some(ticket.clone());
        }
        Ok(outcome)
    }

    pub(crate) fn try_begin_transition_kind_for_recovery(
        &self,
        kind: AdmissionKind,
        descriptor_id: RecoveryDescriptorId,
    ) -> AppResult<AdmissionOutcome> {
        let outcome = self
            .core
            .begin_transition_for_recovery(kind, descriptor_id)?;
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            let mut projection = self.lock_projection()?;
            projection.last_terminal_kind = None;
            projection.transition_ticket = Some(ticket.clone());
        }
        Ok(outcome)
    }

    /// Reserve a maintenance execution in the same shared core as Open and
    /// Restore. The Native cycle arms the explicit synchronous-scope
    /// finalizer after admission; a raw dropped permit remains fail-closed and
    /// is retained for supervisor recovery.
    pub(crate) fn begin_maintenance(&self) -> AppResult<PermitAdmission<MaintenancePermit>> {
        Ok(self.core.admit_maintenance_permit()?)
    }

    /// Reserve a foreground writer in the same shared lifecycle core as
    /// maintenance.  The permit remains live through the borrowed SQLite
    /// transaction and its cleanup, so a transition cannot race a long
    /// eligibility read or commit finalizer.
    pub(crate) fn begin_foreground(&self) -> AppResult<PermitAdmission<MaintenancePermit>> {
        Ok(self.core.admit_foreground_permit()?)
    }

    /// Pair the shared core's physical exclusion marker with the real Native
    /// `open_lock`/file-lease interval held by the blocking supervisor.  The
    /// marker is released when the worker leaves the protected I/O boundary,
    /// before the supervisor publishes Join/activation.
    pub(crate) fn acquire_transition_physical_exclusive(&self) -> AppResult<WorkspaceExclusive> {
        let ticket = self
            .lock_projection()?
            .transition_ticket
            .clone()
            .ok_or_else(|| anyhow::anyhow!("NEX_LIFECYCLE_TRANSITION_TICKET_MISSING"))?;
        // `begin_transition` only requests participant stop.  Keep the
        // transition owner alive and wait at this boundary until every
        // foreground/maintenance participant has joined and released its
        // connection.  Starting protected replacement I/O before that proof
        // would let a live transaction race the old authority close.
        loop {
            match self.core.physical_exclusive_for_ticket(&ticket) {
                Ok(exclusive) => return Ok(exclusive),
                Err(grimodex_db::LifecycleError::ActiveOperations) => {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// Retire a failed initial Open/Restore without creating a descriptor that
    /// has no expected binding or durable recovery target.
    pub(crate) fn abandon_initial_transition(&self) -> AppResult<()> {
        let ticket = self
            .lock_projection()?
            .transition_ticket
            .clone()
            .ok_or_else(|| anyhow::anyhow!("NEX_LIFECYCLE_TRANSITION_TICKET_MISSING"))?;
        self.core.abandon_initial_transition(&ticket)?;
        self.lock_projection()?.transition_ticket = None;
        Ok(())
    }

    pub(crate) fn mark_current_transition_joined(&self) -> AppResult<()> {
        let ticket = self
            .lock_projection()?
            .transition_ticket
            .clone()
            .ok_or_else(|| anyhow::anyhow!("NEX_LIFECYCLE_TRANSITION_TICKET_MISSING"))?;
        self.core.mark_transition_joined(&ticket)?;
        Ok(())
    }

    /// Keep an unrelated active workspace Ready after a background descriptor
    /// recovery failed.  The descriptor responsibility remains pending and
    /// can be retried by the next recovery pump.
    pub(crate) fn abandon_background_recovery(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<bool> {
        let ticket = self.lock_projection()?.transition_ticket.clone();
        let Some(ticket) = ticket else {
            return Ok(false);
        };
        if ticket.kind != AdmissionKind::Recover {
            return Ok(false);
        }
        let authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .as_ref()
            .map(|active| std::sync::Arc::clone(&active.authority))
            .ok_or_else(|| anyhow::anyhow!("NEX_LIFECYCLE_BACKGROUND_RECOVERY_NO_AUTHORITY"))?;
        let binding = live_binding(workspace, self.core.state_revision()?.saturating_add(1))?;
        if !authority_matches_live_binding(
            ticket.original_binding.as_ref().ok_or_else(|| {
                anyhow::anyhow!("NEX_LIFECYCLE_BACKGROUND_RECOVERY_BINDING_MISSING")
            })?,
            &authority,
        ) {
            return Ok(false);
        }
        self.core.abandon_background_recovery(&ticket, binding)?;
        self.lock_projection()?.transition_ticket = None;
        Ok(true)
    }

    /// Begin recovery for an already-owned descriptor root.  Safe Mode uses
    /// the reserved durable root (descriptor zero); ordinary recovery must
    /// name the exact descriptor created by the previous transition.
    pub(crate) fn begin_recovery_transition(
        &self,
        descriptor_id: RecoveryDescriptorId,
        workspace: &WorkspaceState,
    ) -> AppResult<(WorkspaceLifecycleView, bool)> {
        let outcome = self.try_begin_recovery_transition_for_workspace(descriptor_id, workspace)?;
        let ticket = match outcome {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => {
                return Err(anyhow::anyhow!(
                    "NEX_LIFECYCLE_NOT_ADMITTED: descriptor-bound recovery is not available"
                )
                .into())
            }
        };
        {
            let mut projection = self.lock_projection()?;
            projection.transition_ticket = Some(ticket.clone());
        }
        let background = self.is_background_recovery_for_workspace(workspace, Some(&ticket))?;
        let mut projection = self.lock_projection()?;
        if background {
            projection.background_recovery_projection = true;
            let snapshot = self.core.snapshot()?;
            return self
                .projected_background_ready_view(&snapshot, &mut projection)
                .map(|view| (view, true));
        }
        let view = self.projected_view_with_projection(&mut projection)?;
        Ok((view, true))
    }

    /// Attempt descriptor recovery without converting a normal active-owner
    /// rejection into an exception.  Recovery may coexist with an unresolved
    /// W1 descriptor while W2 is Ready, but it must wait until every active
    /// maintenance participant has joined; callers use `NotAdmitted` to keep
    /// the descriptor pending and retry without wedging the transition state.
    pub(crate) fn try_begin_recovery_transition(
        &self,
        descriptor_id: RecoveryDescriptorId,
    ) -> AppResult<AdmissionOutcome> {
        let outcome = self.core.admit_recovery(descriptor_id)?;
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            let mut projection = self.lock_projection()?;
            projection.last_terminal_kind = None;
            projection.transition_ticket = Some(ticket.clone());
        }
        Ok(outcome)
    }

    pub(crate) fn try_begin_recovery_transition_for_workspace(
        &self,
        descriptor_id: RecoveryDescriptorId,
        workspace: &WorkspaceState,
    ) -> AppResult<AdmissionOutcome> {
        let background =
            self.is_background_recovery_descriptor_for_workspace(workspace, descriptor_id)?;
        let outcome = if background {
            self.core.admit_background_recovery(descriptor_id)?
        } else {
            self.core.admit_recovery(descriptor_id)?
        };
        if let AdmissionOutcome::Admitted(ticket) = &outcome {
            let mut projection = self.lock_projection()?;
            projection.last_terminal_kind = None;
            projection.transition_ticket = Some(ticket.clone());
            projection.background_recovery_projection = background;
        }
        Ok(outcome)
    }

    pub(crate) fn projected_recovery_transition_view(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        let ticket = self.lock_projection()?.transition_ticket.clone();
        let background = self.is_background_recovery_for_workspace(workspace, ticket.as_ref())?;
        let mut projection = self.lock_projection()?;
        if background {
            projection.background_recovery_projection = true;
            let snapshot = self.core.snapshot()?;
            return self.projected_background_ready_view(&snapshot, &mut projection);
        }
        self.projected_view_with_projection(&mut projection)
    }

    pub(crate) fn mark_safe_mode_recovery_required(&self) -> AppResult<WorkspaceLifecycleView> {
        self.core.mark_safe_mode_recovery_required()?;
        self.projected_view()
    }

    pub(crate) fn admit_delivery_at(
        &self,
        sequence: DeliverySequence,
        fingerprint: String,
    ) -> AppResult<DeliveryAdmissionOutcome> {
        Ok(self.core.admit_delivery_at(sequence, fingerprint)?)
    }

    pub(crate) fn mark_delivery_terminal(&self, sequence: DeliverySequence) -> AppResult<bool> {
        Ok(self.core.mark_delivery_terminal(sequence)?)
    }

    pub(crate) fn mark_delivery_terminal_with_result(
        &self,
        sequence: DeliverySequence,
        result: String,
    ) -> AppResult<bool> {
        Ok(self
            .core
            .mark_delivery_terminal_with_result(sequence, Some(result))?)
    }

    pub(crate) fn ack_delivery(&self, sequence: DeliverySequence) -> AppResult<bool> {
        Ok(self.core.ack_delivery(sequence)?)
    }

    pub(crate) fn resolve_or_fence(&self, sequence: DeliverySequence) -> AppResult<FenceOutcome> {
        Ok(self.core.resolve_or_fence(sequence)?)
    }

    /// Publish a ready authority after the shared opener has completed and
    /// the authority is actually visible in `WorkspaceState`.
    pub(crate) fn publish_ready(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        self.publish_from_workspace(workspace, Some(WorkspaceLifecycleStatus::Ready))
    }

    /// Publish a restore-only state.  The active authority must still be
    /// absent; callers do not get a `Ready` projection by merely installing a
    /// restore candidate.
    pub(crate) fn publish_recovery_required(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        self.publish_from_workspace(workspace, Some(WorkspaceLifecycleStatus::RecoveryRequired))
    }

    /// Publish a closed state after the native shutdown owner has proved that
    /// the authority and lifecycle workers are no longer active.  This helper
    /// is intentionally not an N-API command; the eventual shutdown owner must
    /// call it only after its terminal proof.
    pub(crate) fn publish_closed(&self) -> AppResult<WorkspaceLifecycleView> {
        // Close admission in the shared core before observing Native worker
        // termination.  `close` below remains the proof boundary and will
        // refuse to fabricate Closed while an owner is still live.
        self.core.request_shutdown()?;
        self.core.close()?;
        let mut projection = self.lock_projection()?;
        projection.transition_ticket = None;
        projection.binding_token = None;
        projection.token_revision = None;
        self.projected_view_with_projection(&mut projection)
    }

    pub(crate) fn request_shutdown(&self) -> AppResult<WorkspaceLifecycleView> {
        self.core.request_shutdown()?;
        self.projected_view()
    }

    /// Read the old WorkspaceState only at a short boundary.  This keeps the
    /// getter useful during the compatibility period without calling
    /// `active_database`, which would reject the recovery-only state.
    pub(crate) fn snapshot_for_workspace(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        let has_authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .is_some();
        // This method is deliberately a pure observation boundary.  In
        // particular, it must never infer Join from the presence of an old
        // authority or from a Safe Mode flag: only the blocking supervisor
        // that owns the worker JoinHandle may complete a transition.  A
        // snapshot can therefore report the verified Safe Mode projection
        // while leaving the core ticket live until that supervisor publishes
        // the terminal outcome.
        let snapshot = self.core.snapshot()?;
        let ticket = self.lock_projection()?.transition_ticket.clone();
        let background = self.is_background_recovery_for_workspace(workspace, ticket.as_ref())?;
        let mut projection = self.lock_projection()?;
        if background {
            projection.background_recovery_projection = true;
            return self.projected_background_ready_view(&snapshot, &mut projection);
        }
        if workspace.safe_mode.is_active() && !has_authority {
            if matches!(snapshot.state, LifecycleState::RecoveryRequired { .. }) {
                return self.projected_view_with_projection(&mut projection);
            }
            return self.projected_view_with_override_locked(
                &snapshot,
                WorkspaceLifecycleStatus::RecoveryRequired,
                WorkspaceLifecycleActivation::RequiresOpen,
                &mut projection,
            );
        }
        self.projected_view_with_projection(&mut projection)
    }

    /// Publish an authority that was installed by a compatibility/test owner
    /// without an admitted transition.  This is intentionally separate from
    /// `snapshot_for_workspace`: callers must opt into the state mutation at
    /// a controlled lifecycle boundary.
    pub(crate) fn ensure_authority_ready(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        let snapshot = self.core.snapshot()?;
        if matches!(snapshot.state, LifecycleState::NoWorkspace)
            && self.lock_projection()?.transition_ticket.is_none()
        {
            return self.publish_from_workspace(workspace, None);
        }
        self.projected_view()
    }

    /// Complete an admitted transition after the native supervisor has joined
    /// its blocking worker.  This is the only production path that may turn a
    /// transition ticket into Ready, Unchanged, Activated, or a recovery
    /// descriptor.
    pub(crate) fn complete_transition_from_workspace(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        self.publish_from_workspace(workspace, None)
    }

    /// Consume the terminal classification produced by the most recent
    /// admitted transition.  This is intentionally one-shot so a later
    /// lifecycle snapshot cannot be mistaken for proof belonging to an older
    /// Restore operation.
    pub(crate) fn take_last_terminal_kind(&self) -> AppResult<Option<LifecycleTerminalKind>> {
        Ok(self.lock_projection()?.last_terminal_kind.take())
    }

    pub(crate) fn serialize(view: &WorkspaceLifecycleView) -> AppResult<String> {
        Ok(serde_json::to_string(view).map_err(anyhow::Error::from)?)
    }

    fn publish_from_workspace(
        &self,
        workspace: &WorkspaceState,
        requested_status: Option<WorkspaceLifecycleStatus>,
    ) -> AppResult<WorkspaceLifecycleView> {
        let has_authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .is_some();

        let snapshot = self.core.snapshot()?;
        let ticket = self.lock_projection()?.transition_ticket.clone();

        if let Some(ticket) = ticket {
            if self.is_background_recovery_for_workspace(workspace, Some(&ticket))? {
                // Background descriptor recovery intentionally leaves the
                // unrelated active workspace Ready. Retire only the
                // descriptor's temporary admission after the worker Join;
                // the normal Transition completion path would otherwise
                // reject a Ready core or overwrite the W2 binding.
                let binding = live_binding(workspace, snapshot.revision.saturating_add(1))?;
                self.core.mark_transition_joined(&ticket)?;
                self.core.complete_background_recovery(&ticket, binding)?;
                let mut projection = self.lock_projection()?;
                projection.transition_ticket = None;
                // Keep the marker through this revision's projection.  The
                // projector clears it after observing Ready, which preserves
                // W2's opaque binding token instead of rotating the renderer
                // scope at the moment W1 recovery completes.
                return self.projected_view_with_projection(&mut projection);
            }
            // The opener/restore supervisor has returned from its blocking
            // worker at this boundary. Mark that Join observation before the
            // core can publish Ready, Unchanged, or a recovery descriptor.
            self.core.mark_transition_joined(&ticket)?;
            if self.core.shutdown_requested()? {
                self.core.abandon_transition_for_shutdown(&ticket)?;
                let mut projection = self.lock_projection()?;
                projection.last_terminal_kind = None;
                projection.transition_ticket = None;
                return self.projected_view();
            }
            if !workspace.safe_mode.is_active()
                && ticket.original_binding.is_none()
                && requested_status == Some(WorkspaceLifecycleStatus::RecoveryRequired)
            {
                self.lock_projection()?.previous_ready_token = None;
                if has_authority {
                    // The opener may have published a replacement candidate
                    // before a later post-install step failed.  That
                    // candidate is the only exact recovery target left; a
                    // descriptor with `expected_binding: None` would be
                    // permanently invisible to the recovery pump.  Capture
                    // the candidate binding while the transition owner still
                    // controls publication, and keep it hidden until a
                    // descriptor-bound retry proves the authority healthy.
                    let candidate_binding =
                        live_binding(workspace, snapshot.revision.saturating_add(1))?;
                    self.core
                        .require_recovery(&ticket, Some(candidate_binding), None)?;
                    self.lock_projection()?.last_terminal_kind =
                        Some(LifecycleTerminalKind::RecoveryRequired);
                } else {
                    // An initial open that failed before publishing any
                    // authority has no old binding or durable recovery root.
                    // Retire the transition directly rather than fabricating
                    // a bindingless descriptor.
                    self.abandon_initial_transition()?;
                    return self.projected_view();
                }
            } else if workspace.safe_mode.is_active()
                || requested_status == Some(WorkspaceLifecycleStatus::RecoveryRequired)
            {
                self.lock_projection()?.previous_ready_token = None;
                self.core
                    .require_recovery(&ticket, ticket.original_binding.clone(), None)?;
                self.lock_projection()?.last_terminal_kind =
                    Some(LifecycleTerminalKind::RecoveryRequired);
            } else if has_authority {
                let binding = live_binding(workspace, snapshot.revision.saturating_add(1))?;
                // `recovery_generation` is a lifecycle revision, not an
                // authority identity.  A same-instance explicit Open may
                // advance the generation while the exact authority remains
                // live; preserve the original binding in that case so the
                // result is Unchanged rather than a spurious activation.
                let result = if ticket.original_binding.as_ref().is_some_and(|original| {
                    original.locator == binding.locator
                        && original.workspace_id == binding.workspace_id
                        && original.authority_instance == binding.authority_instance
                }) {
                    self.core.complete_unchanged(
                        &ticket,
                        ticket
                            .original_binding
                            .clone()
                            .expect("binding identity predicate guarantees original binding"),
                    )?
                } else {
                    self.core
                        .activate(&ticket, binding, ContentEffect::Retained)?
                };
                debug_assert!(matches!(
                    result,
                    LifecycleResult::Unchanged { .. } | LifecycleResult::Activated { .. }
                ));
                let mut projection = self.lock_projection()?;
                if matches!(result, LifecycleResult::Unchanged { .. }) {
                    projection.last_terminal_kind = Some(LifecycleTerminalKind::Unchanged);
                    if let Some(token) = projection.previous_ready_token.take() {
                        projection.binding_token = Some(token);
                        projection.token_revision = Some(self.core.state_revision()?);
                    }
                } else {
                    projection.last_terminal_kind = Some(LifecycleTerminalKind::Activated);
                    projection.previous_ready_token = None;
                }
            } else {
                self.lock_projection()?.previous_ready_token = None;
                self.core
                    .require_recovery(&ticket, ticket.original_binding.clone(), None)?;
                self.lock_projection()?.last_terminal_kind =
                    Some(LifecycleTerminalKind::RecoveryRequired);
            }
            self.lock_projection()?.transition_ticket = None;
        } else if !has_authority
            && (workspace.safe_mode.is_active()
                || requested_status == Some(WorkspaceLifecycleStatus::RecoveryRequired))
        {
            self.core.mark_safe_mode_recovery_required()?;
            self.lock_projection()?.last_terminal_kind =
                Some(LifecycleTerminalKind::RecoveryRequired);
        } else if has_authority && !matches!(snapshot.state, LifecycleState::Ready(_)) {
            self.core.set_ready(live_binding(
                workspace,
                snapshot.revision.saturating_add(1),
            )?)?;
        }

        self.projected_view()
    }

    fn lock_projection(&self) -> AppResult<std::sync::MutexGuard<'_, ProjectionState>> {
        Ok(self.projection.lock().map_err(|error| {
            anyhow::anyhow!("workspace lifecycle projection lock poisoned: {error}")
        })?)
    }

    fn projected_view(&self) -> AppResult<WorkspaceLifecycleView> {
        let mut projection = self.lock_projection()?;
        self.projected_view_with_projection(&mut projection)
    }

    fn projected_view_with_override_locked(
        &self,
        snapshot: &grimodex_db::LifecycleSnapshot,
        status: WorkspaceLifecycleStatus,
        activation: WorkspaceLifecycleActivation,
        projection: &mut ProjectionState,
    ) -> AppResult<WorkspaceLifecycleView> {
        if status == WorkspaceLifecycleStatus::Closed {
            projection.binding_token = None;
            projection.token_revision = Some(snapshot.revision);
            projection.background_recovery_projection = false;
        } else if projection.token_revision != Some(snapshot.revision)
            && !projection.background_recovery_projection
        {
            projection.token_revision = Some(snapshot.revision);
            projection.binding_token = Some(new_binding_token());
        } else {
            projection.token_revision = Some(snapshot.revision);
        }
        Ok(WorkspaceLifecycleView {
            schema_version: WORKSPACE_LIFECYCLE_SCHEMA_VERSION,
            revision: snapshot.revision,
            status,
            binding_token: projection.binding_token.clone(),
            activation,
        })
    }

    fn projected_background_ready_view(
        &self,
        snapshot: &grimodex_db::LifecycleSnapshot,
        projection: &mut ProjectionState,
    ) -> AppResult<WorkspaceLifecycleView> {
        self.projected_view_with_override_locked(
            snapshot,
            WorkspaceLifecycleStatus::Ready,
            WorkspaceLifecycleActivation::Ready,
            projection,
        )
    }

    fn projected_view_with_projection(
        &self,
        projection: &mut ProjectionState,
    ) -> AppResult<WorkspaceLifecycleView> {
        let snapshot = self.core.snapshot()?;
        let (status, activation) = match &snapshot.state {
            LifecycleState::Ready(_) => (
                WorkspaceLifecycleStatus::Ready,
                WorkspaceLifecycleActivation::Ready,
            ),
            LifecycleState::Transition { .. } => (
                WorkspaceLifecycleStatus::Transition,
                WorkspaceLifecycleActivation::None,
            ),
            LifecycleState::RecoveryRequired { .. } => (
                WorkspaceLifecycleStatus::RecoveryRequired,
                WorkspaceLifecycleActivation::RequiresOpen,
            ),
            LifecycleState::NoWorkspace => (
                WorkspaceLifecycleStatus::Closed,
                WorkspaceLifecycleActivation::None,
            ),
            LifecycleState::Closed => (
                WorkspaceLifecycleStatus::Closed,
                WorkspaceLifecycleActivation::None,
            ),
        };
        if status == WorkspaceLifecycleStatus::Closed {
            projection.binding_token = None;
            projection.token_revision = Some(snapshot.revision);
            projection.background_recovery_projection = false;
        } else if projection.token_revision != Some(snapshot.revision) {
            if !projection.background_recovery_projection {
                projection.token_revision = Some(snapshot.revision);
                projection.binding_token = Some(new_binding_token());
            } else {
                // The live renderer scope is unchanged while an unrelated
                // descriptor is being recovered. Advance the lifecycle
                // revision without rotating its binding token.
                projection.token_revision = Some(snapshot.revision);
            }
        }
        if projection.background_recovery_projection
            && matches!(snapshot.state, LifecycleState::Ready(_))
        {
            projection.background_recovery_projection = false;
        }
        Ok(WorkspaceLifecycleView {
            schema_version: WORKSPACE_LIFECYCLE_SCHEMA_VERSION,
            revision: snapshot.revision,
            status,
            binding_token: projection.binding_token.clone(),
            activation,
        })
    }

    fn is_background_recovery_for_workspace(
        &self,
        workspace: &WorkspaceState,
        ticket: Option<&AdmissionTicket>,
    ) -> AppResult<bool> {
        let Some(ticket) = ticket else {
            return Ok(false);
        };
        if ticket.kind != AdmissionKind::Recover {
            return Ok(false);
        }
        let Some(descriptor_id) = ticket.recovery_descriptor_id else {
            return Ok(false);
        };
        let Some(descriptor) = self.core.descriptor(descriptor_id).ok() else {
            return Ok(false);
        };
        let Some(expected) = descriptor.expected_binding.as_ref() else {
            return Ok(false);
        };
        let Some(original) = ticket.original_binding.as_ref() else {
            return Ok(false);
        };
        let authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .as_ref()
            .map(|active| std::sync::Arc::clone(&active.authority));
        let Some(authority) = authority else {
            return Ok(false);
        };
        // The ticket's original binding is the currently published W2 scope;
        // the descriptor's expected binding is the W1 root being recovered.
        // Exact instance/path/metadata matching is required for the current
        // scope, while a mismatch against the descriptor keeps W1 internal.
        Ok(authority_matches_live_binding(original, &authority)
            && !authority_matches_live_binding(expected, &authority))
    }

    fn is_background_recovery_descriptor_for_workspace(
        &self,
        workspace: &WorkspaceState,
        descriptor_id: RecoveryDescriptorId,
    ) -> AppResult<bool> {
        if !matches!(self.core.snapshot()?.state, LifecycleState::Ready(_)) {
            return Ok(false);
        }
        let descriptor = self.core.descriptor(descriptor_id)?;
        let Some(expected) = descriptor.expected_binding.as_ref() else {
            return Ok(false);
        };
        let authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .as_ref()
            .map(|active| std::sync::Arc::clone(&active.authority));
        let Some(authority) = authority else {
            return Ok(false);
        };
        Ok(!authority_matches_live_binding(expected, &authority))
    }
}

fn authority_matches_live_binding(binding: &LiveBinding, authority: &PinnedWorkspaceDb) -> bool {
    if binding.authority_instance != authority.identity()
        || binding.locator != authority.path().to_string_lossy()
    {
        return false;
    }
    let metadata_path = authority.path().join(".grimodex/workspace.json");
    let workspace_id = std::fs::read_to_string(metadata_path)
        .ok()
        .and_then(|metadata| serde_json::from_str::<serde_json::Value>(&metadata).ok())
        .and_then(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });
    workspace_id.as_deref() == Some(binding.workspace_id.as_str())
}

fn live_binding(workspace: &WorkspaceState, recovery_generation: u64) -> AppResult<LiveBinding> {
    let authority = workspace
        .inner
        .lock()
        .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
        .as_ref()
        .map(|active| std::sync::Arc::clone(&active.authority))
        .ok_or_else(|| anyhow::anyhow!("workspace authority is unavailable"))?;
    let locator = authority.path().to_string_lossy().into_owned();
    let metadata_path = authority.path().join(".grimodex/workspace.json");
    let metadata = std::fs::read_to_string(&metadata_path).map_err(anyhow::Error::from)?;
    let workspace_id = serde_json::from_str::<serde_json::Value>(&metadata)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_WORKSPACE_IDENTITY_INVALID: verified workspace metadata has no id ({})",
                metadata_path.display()
            )
        })?;
    // The durable workspace identity is intentionally not exposed on the main
    // wire.  The canonical locator and metadata id are read from the already
    // verified authority; authority_instance still distinguishes a same-path
    // reopen.
    Ok(LiveBinding::new(
        locator.clone(),
        workspace_id,
        authority.identity(),
        recovery_generation.max(1),
    ))
}

fn next_revision(current: u64) -> u64 {
    current.checked_add(1).unwrap_or(1)
}

fn new_binding_token() -> String {
    // UUID bytes are intentionally exposed only as an opaque UI token.  No
    // workspace metadata, authority identity, path, or durable Run id is
    // encoded into this value.
    format!("bnd-{}", Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::state::{ActiveWorkspace, WorkspaceAuthority};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;

    fn empty_workspace() -> WorkspaceState {
        WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: grimodex_db::recovery::SafeModeState::default(),
            switching: grimodex_db::WorkspaceLifecycleCompatibilityView::default(),
            open_lock: Mutex::new(()),
        }
    }

    #[test]
    fn initial_snapshot_is_closed_and_contains_no_sensitive_identity() {
        let workspace = empty_workspace();
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        let view = adapter
            .snapshot_for_workspace(&workspace)
            .expect("snapshot");
        assert_eq!(view.status, WorkspaceLifecycleStatus::Closed);
        assert_eq!(view.revision, 0);
        assert_eq!(view.binding_token, None);
        assert_eq!(view.activation, WorkspaceLifecycleActivation::None);

        let json = WorkspaceLifecycleViewAdapter::serialize(&view).expect("serialize");
        assert!(!json.contains("path"));
        assert!(!json.contains("authority"));
        assert!(!json.contains("workspaceId"));
        assert_eq!(
            serde_json::from_str::<WorkspaceLifecycleView>(&json).unwrap(),
            view
        );
        let mut unknown = serde_json::from_str::<serde_json::Value>(&json).unwrap();
        unknown["workspacePath"] = serde_json::json!("/must-not-cross-the-boundary");
        assert!(serde_json::from_value::<WorkspaceLifecycleView>(unknown).is_err());
    }

    #[test]
    fn transition_and_ready_rotate_opaque_token_and_revision() {
        let mut workspace = empty_workspace();
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        let (transition, changed) = adapter.begin_transition().expect("transition");
        assert!(changed);
        assert_eq!(transition.status, WorkspaceLifecycleStatus::Transition);
        assert_eq!(transition.activation, WorkspaceLifecycleActivation::None);
        let transition_token = transition.binding_token.clone().expect("token");

        let path =
            std::env::temp_dir().join(format!("grimodex-lifecycle-ready-{}", Uuid::new_v4()));
        std::fs::create_dir_all(path.join(".grimodex")).expect("metadata directory");
        std::fs::write(
            path.join(".grimodex/workspace.json"),
            serde_json::json!({"id": "lifecycle-ready-workspace"}).to_string(),
        )
        .expect("workspace metadata");
        let authority = grimodex_db::state::WorkspaceAuthority::from_database_for_test(
            grimodex_db::Database::new(std::path::Path::new(":memory:")).expect("database"),
            path,
        )
        .expect("authority");
        workspace.inner = Mutex::new(Some(grimodex_db::state::ActiveWorkspace::new(authority)));
        let ready = adapter.publish_ready(&workspace).expect("ready");
        assert_eq!(ready.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(ready.activation, WorkspaceLifecycleActivation::Ready);
        assert_ne!(
            ready.binding_token.as_deref(),
            Some(transition_token.as_str())
        );
        assert!(ready.revision > transition.revision);
    }

    #[test]
    fn switching_and_safe_mode_project_fail_closed_states() {
        let workspace = empty_workspace();
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        workspace.switching.store(true, Ordering::SeqCst);
        let transition = adapter
            .snapshot_for_workspace(&workspace)
            .expect("transition snapshot");
        assert_eq!(transition.status, WorkspaceLifecycleStatus::Transition);
        assert_eq!(transition.activation, WorkspaceLifecycleActivation::None);

        workspace.switching.store(false, Ordering::SeqCst);
        let safe_path =
            std::env::temp_dir().join(format!("grimodex-lifecycle-safe-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&safe_path).expect("safe mode directory");
        let safe = grimodex_db::recovery::SafeModeSession::from_workspace(
            safe_path,
            "test".to_string(),
            None,
            None,
        )
        .expect("safe mode session");
        workspace.safe_mode.enter(safe).expect("enter safe mode");
        let recovery = adapter
            .snapshot_for_workspace(&workspace)
            .expect("recovery snapshot");
        assert_eq!(recovery.status, WorkspaceLifecycleStatus::RecoveryRequired);
        assert_eq!(
            recovery.activation,
            WorkspaceLifecycleActivation::RequiresOpen
        );
        assert!(recovery.binding_token.is_some());
    }

    #[test]
    fn closed_projection_clears_old_token_and_is_monotonic() {
        let workspace = empty_workspace();
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        let transition = adapter
            .snapshot_for_workspace(&workspace)
            .expect("initial snapshot");
        let closed = adapter.publish_closed().expect("closed");
        assert!(closed.revision > transition.revision);
        assert_eq!(closed.status, WorkspaceLifecycleStatus::Closed);
        assert_eq!(closed.binding_token, None);
        assert_eq!(closed.activation, WorkspaceLifecycleActivation::None);
    }

    #[test]
    fn initial_open_failure_does_not_create_a_bindingless_recovery_descriptor() {
        let workspace = empty_workspace();
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        adapter.begin_transition().expect("initial transition");

        let failed = adapter
            .publish_recovery_required(&workspace)
            .expect("initial failure must be retired");
        assert_eq!(failed.status, WorkspaceLifecycleStatus::Closed);
        assert_eq!(failed.binding_token, None);
        assert!(matches!(
            adapter.lifecycle_snapshot().expect("snapshot").state,
            LifecycleState::NoWorkspace
        ));
        assert!(adapter
            .recovery_descriptor_ids()
            .expect("descriptor ids")
            .is_empty());
    }

    #[test]
    fn initial_open_failure_after_candidate_publication_keeps_a_bound_recovery_descriptor() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-lifecycle-initial-candidate-{}",
            Uuid::new_v4()
        ));
        let workspace_path = root.join("workspace");
        std::fs::create_dir_all(workspace_path.join(".grimodex")).expect("metadata directory");
        std::fs::write(
            workspace_path.join(".grimodex/workspace.json"),
            serde_json::json!({"id": "workspace-initial-candidate"}).to_string(),
        )
        .expect("workspace metadata");
        let database = grimodex_db::Database::new(&workspace_path.join("grimodex.db"))
            .expect("candidate database");
        database.migrate().expect("candidate migration");
        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("candidate authority");
        let mut workspace = empty_workspace();
        workspace.inner = Mutex::new(Some(ActiveWorkspace::new(authority)));
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());

        adapter.begin_transition().expect("initial transition");
        let failed = adapter
            .publish_recovery_required(&workspace)
            .expect("candidate failure becomes descriptor-bound recovery");
        assert_eq!(failed.status, WorkspaceLifecycleStatus::RecoveryRequired);
        let descriptor_id = match adapter.lifecycle_snapshot().expect("snapshot").state {
            LifecycleState::RecoveryRequired { descriptor_id } => descriptor_id,
            state => panic!("expected bound recovery descriptor, got {state:?}"),
        };
        let descriptor = adapter.core.descriptor(descriptor_id).expect("descriptor");
        assert!(descriptor.expected_binding.is_some());
        assert_eq!(
            adapter.recovery_descriptor_ids().expect("descriptor ids"),
            vec![descriptor_id]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn background_descriptor_recovery_keeps_the_active_workspace_ready_in_snapshots() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-lifecycle-background-recovery-{}",
            Uuid::new_v4()
        ));
        let w1_path = root.join("w1");
        let w2_path = root.join("w2");
        for (path, id) in [(&w1_path, "workspace-w1"), (&w2_path, "workspace-w2")] {
            std::fs::create_dir_all(path.join(".grimodex")).expect("metadata directory");
            std::fs::write(
                path.join(".grimodex/workspace.json"),
                serde_json::json!({"id": id}).to_string(),
            )
            .expect("workspace metadata");
        }
        let w1 = WorkspaceAuthority::from_database_for_test(
            grimodex_db::Database::new(&w1_path.join("grimodex.db")).expect("w1 database"),
            w1_path.clone(),
        )
        .expect("w1 authority");
        let w2 = WorkspaceAuthority::from_database_for_test(
            grimodex_db::Database::new(&w2_path.join("grimodex.db")).expect("w2 database"),
            w2_path.clone(),
        )
        .expect("w2 authority");
        let mut workspace = empty_workspace();
        workspace.inner = Mutex::new(Some(ActiveWorkspace::new(w1)));
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        let ready_w1 = adapter
            .ensure_authority_ready(&workspace)
            .expect("ready W1");
        let w1_token = ready_w1.binding_token.clone().expect("W1 token");

        adapter.begin_transition().expect("W1 transition");
        adapter
            .publish_recovery_required(&workspace)
            .expect("W1 descriptor");
        let descriptor_id = match adapter
            .lifecycle_snapshot()
            .expect("descriptor snapshot")
            .state
        {
            LifecycleState::RecoveryRequired { descriptor_id } => descriptor_id,
            state => panic!("expected W1 recovery descriptor, got {state:?}"),
        };

        workspace.inner = Mutex::new(Some(ActiveWorkspace::new(w2)));
        adapter
            .begin_transition()
            .expect("W2 activation transition");
        let ready_w2 = adapter
            .complete_transition_from_workspace(&workspace)
            .expect("activate W2");
        let w2_token = ready_w2.binding_token.clone().expect("W2 token");
        assert_ne!(w1_token, w2_token);

        let transition = adapter
            .begin_recovery_transition(descriptor_id, &workspace)
            .expect("background recovery admission")
            .0;
        assert_eq!(transition.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(transition.activation, WorkspaceLifecycleActivation::Ready);
        assert_eq!(transition.binding_token, Some(w2_token.clone()));
        let projected = adapter
            .projected_recovery_transition_view(&workspace)
            .expect("background recovery projection");
        assert_eq!(projected.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(projected.activation, WorkspaceLifecycleActivation::Ready);
        assert_eq!(projected.binding_token, Some(w2_token.clone()));

        let refreshed = adapter
            .snapshot_for_workspace(&workspace)
            .expect("snapshot during background recovery");
        assert_eq!(refreshed.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(refreshed.binding_token, Some(w2_token.clone()));

        // A failed W1 recovery must retire only its temporary ticket. The
        // descriptor remains available for retry while W2 keeps its Ready
        // renderer scope and opaque binding token.
        adapter
            .mark_current_transition_joined()
            .expect("failed recovery Join");
        assert!(adapter
            .abandon_background_recovery(&workspace)
            .expect("abandon background recovery"));
        let after_failure = adapter
            .snapshot_for_workspace(&workspace)
            .expect("W2 snapshot after failed W1 recovery");
        assert_eq!(after_failure.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(after_failure.binding_token, Some(w2_token.clone()));
        assert!(adapter
            .recovery_descriptor_ids()
            .expect("descriptor remains for retry")
            .contains(&descriptor_id));

        let retry = adapter
            .begin_recovery_transition(descriptor_id, &workspace)
            .expect("retry background recovery admission")
            .0;
        assert_eq!(retry.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(retry.binding_token, Some(w2_token.clone()));

        let completed = adapter
            .complete_transition_from_workspace(&workspace)
            .expect("complete background recovery");
        assert_eq!(completed.status, WorkspaceLifecycleStatus::Ready);
        assert_eq!(completed.activation, WorkspaceLifecycleActivation::Ready);
        assert_eq!(completed.binding_token, Some(w2_token));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn background_recovery_join_after_shutdown_can_complete_or_abandon() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-lifecycle-background-shutdown-{}",
            Uuid::new_v4()
        ));
        let w1_path = root.join("w1");
        let w2_path = root.join("w2");
        for (path, id) in [(&w1_path, "workspace-w1"), (&w2_path, "workspace-w2")] {
            std::fs::create_dir_all(path.join(".grimodex")).expect("metadata directory");
            std::fs::write(
                path.join(".grimodex/workspace.json"),
                serde_json::json!({"id": id}).to_string(),
            )
            .expect("workspace metadata");
        }
        let w1 = WorkspaceAuthority::from_database_for_test(
            grimodex_db::Database::new(&w1_path.join("grimodex.db")).expect("w1 database"),
            w1_path,
        )
        .expect("w1 authority");
        let w2 = WorkspaceAuthority::from_database_for_test(
            grimodex_db::Database::new(&w2_path.join("grimodex.db")).expect("w2 database"),
            w2_path,
        )
        .expect("w2 authority");
        let mut workspace = empty_workspace();
        workspace.inner = Mutex::new(Some(ActiveWorkspace::new(w1)));
        let adapter = WorkspaceLifecycleViewAdapter::new(workspace.lifecycle_core());
        adapter
            .ensure_authority_ready(&workspace)
            .expect("ready W1");
        adapter.begin_transition().expect("W1 transition");
        adapter
            .publish_recovery_required(&workspace)
            .expect("W1 descriptor");
        let descriptor_id = match adapter
            .lifecycle_snapshot()
            .expect("descriptor snapshot")
            .state
        {
            LifecycleState::RecoveryRequired { descriptor_id } => descriptor_id,
            state => panic!("expected W1 recovery descriptor, got {state:?}"),
        };
        workspace.inner = Mutex::new(Some(ActiveWorkspace::new(w2)));
        adapter
            .begin_transition()
            .expect("W2 activation transition");
        adapter
            .complete_transition_from_workspace(&workspace)
            .expect("activate W2");
        adapter
            .begin_recovery_transition(descriptor_id, &workspace)
            .expect("background recovery admission");
        adapter.request_shutdown().expect("shutdown request");
        adapter
            .mark_current_transition_joined()
            .expect("late background recovery Join");
        adapter
            .complete_transition_from_workspace(&workspace)
            .expect("complete late background recovery");
        let shutdown_state = adapter
            .lifecycle_snapshot()
            .expect("shutdown snapshot")
            .state;
        assert!(matches!(
            shutdown_state,
            LifecycleState::Transition {
                operation_id,
                stage: TransitionStage::Finishing,
            } if operation_id == OperationId::default()
        ));
        assert!(adapter
            .recovery_descriptor_ids()
            .expect("descriptor remains until control ACK")
            .contains(&descriptor_id));

        let _ = std::fs::remove_dir_all(root);
    }
}
