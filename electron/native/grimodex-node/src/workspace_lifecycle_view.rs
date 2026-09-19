//! Main-only, renderer-safe projection of the native workspace lifecycle.
//!
//! The shared workspace opener predates the lifecycle core and currently
//! exposes only `WorkspaceState::switching`, the published authority, and the
//! Safe Mode holder.  This adapter deliberately keeps that compatibility
//! surface narrow: it projects those facts into an opaque, revisioned view and
//! never serializes a workspace path, authority id, recovery candidate id, or
//! durable Run identity.

use std::sync::Mutex;

use grimodex_db::state::WorkspaceState;
use grimodex_db::{
    AdmissionKind, AdmissionOutcome, AdmissionTicket, ContentEffect,
    LifecycleResult, LifecycleState, LiveBinding, MaintenancePermit, PermitAdmission,
    StateRevision, WorkspaceLifecycleCore,
};
use grimodex_db::AppResult;
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

#[derive(Debug, Default)]
struct ProjectionState {
    token_revision: Option<StateRevision>,
    binding_token: Option<String>,
    transition_ticket: Option<AdmissionTicket>,
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
        let outcome = self.core.begin_transition(kind)?;
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
                .into())
            }
        };
        let mut projection = self.lock_projection()?;
        projection.transition_ticket = Some(ticket);
        let view = self.projected_view_with_projection(&mut projection)?;
        Ok((view, true))
    }

    /// Reserve a maintenance execution in the same shared core as Open and
    /// Restore. The permit owns the exact responsibility cell and releases it
    /// on every return path (including panic unwinding) through its Drop
    /// finalizer; no second Native admission registry is created here.
    pub(crate) fn begin_maintenance(
        &self,
    ) -> AppResult<PermitAdmission<MaintenancePermit>> {
        Ok(self.core.admit_maintenance_permit()?)
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
        self.publish_from_workspace(
            workspace,
            Some(WorkspaceLifecycleStatus::RecoveryRequired),
        )
    }

    /// Publish a closed state after the native shutdown owner has proved that
    /// the authority and lifecycle workers are no longer active.  This helper
    /// is intentionally not an N-API command; the eventual shutdown owner must
    /// call it only after its terminal proof.
    pub(crate) fn publish_closed(&self) -> AppResult<WorkspaceLifecycleView> {
        self.core.close()?;
        let mut projection = self.lock_projection()?;
        projection.transition_ticket = None;
        projection.binding_token = None;
        projection.token_revision = None;
        self.projected_view_with_projection(&mut projection)
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
        if workspace.safe_mode.is_active() && !has_authority {
            let snapshot = self.core.snapshot()?;
            let transition_ticket = {
                let projection = self.lock_projection()?;
                projection.transition_ticket.clone()
            };
            if let Some(ticket) = transition_ticket {
                // Safe Mode is the terminal outcome of the admitted Open or
                // Restore transition.  Complete that transition through the
                // same Join/recovery path as every other worker outcome;
                // marking RecoveryRequired directly would leave the
                // transition owner live and make the result look like an
                // active-operation failure.
                self.core.mark_transition_joined(&ticket)?;
                self.core
                    .require_recovery(&ticket, ticket.original_binding.clone(), None)?;
                self.lock_projection()?.transition_ticket = None;
            } else if !matches!(snapshot.state, LifecycleState::RecoveryRequired { .. }) {
                self.core.mark_safe_mode_recovery_required()?;
            }
            return self.projected_view();
        }
        if has_authority {
            return self.publish_from_workspace(workspace, None);
        }
        let snapshot = self.core.snapshot()?;
        if matches!(snapshot.state, LifecycleState::Transition { .. }) {
            return self.projected_view();
        }
        let mut projection = self.lock_projection()?;
        projection.transition_ticket = None;
        self.projected_view_with_projection(&mut projection)
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
        let ticket = self
            .lock_projection()?
            .transition_ticket
            .clone();

        if let Some(ticket) = ticket {
            // The opener/restore supervisor has returned from its blocking
            // worker at this boundary. Mark that Join observation before the
            // core can publish Ready, Unchanged, or a recovery descriptor.
            self.core.mark_transition_joined(&ticket)?;
            if workspace.safe_mode.is_active()
                || (!has_authority
                    && requested_status == Some(WorkspaceLifecycleStatus::RecoveryRequired))
            {
                self.core
                    .require_recovery(&ticket, ticket.original_binding.clone(), None)?;
            } else if has_authority {
                let binding = live_binding(workspace, snapshot.revision.saturating_add(1))?;
                let result = if ticket.original_binding.as_ref() == Some(&binding) {
                    self.core.complete_unchanged(&ticket, binding)?
                } else {
                    self.core.activate(&ticket, binding, ContentEffect::Retained)?
                };
                debug_assert!(matches!(
                    result,
                    LifecycleResult::Unchanged { .. } | LifecycleResult::Activated { .. }
                ));
            } else {
                self.core
                    .require_recovery(&ticket, ticket.original_binding.clone(), None)?;
            }
            self.lock_projection()?.transition_ticket = None;
        } else if !has_authority
            && (workspace.safe_mode.is_active()
                || requested_status == Some(WorkspaceLifecycleStatus::RecoveryRequired))
        {
            self.core.mark_safe_mode_recovery_required()?;
        } else if has_authority && !matches!(snapshot.state, LifecycleState::Ready(_)) {
            self.core.set_ready(live_binding(workspace, snapshot.revision.saturating_add(1))?)?;
        }

        self.projected_view()
    }

    fn lock_projection(&self) -> AppResult<std::sync::MutexGuard<'_, ProjectionState>> {
        Ok(self
            .projection
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle projection lock poisoned: {error}"))?)
    }

    fn projected_view(&self) -> AppResult<WorkspaceLifecycleView> {
        let mut projection = self.lock_projection()?;
        self.projected_view_with_projection(&mut projection)
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
        } else if projection.token_revision != Some(snapshot.revision) {
            projection.token_revision = Some(snapshot.revision);
            projection.binding_token = Some(new_binding_token());
        }
        Ok(WorkspaceLifecycleView {
            schema_version: WORKSPACE_LIFECYCLE_SCHEMA_VERSION,
            revision: snapshot.revision,
            status,
            binding_token: projection.binding_token.clone(),
            activation,
        })
    }
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
}
