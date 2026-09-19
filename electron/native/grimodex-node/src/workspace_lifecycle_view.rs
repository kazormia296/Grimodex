//! Main-only, renderer-safe projection of the native workspace lifecycle.
//!
//! The shared workspace opener predates the lifecycle core and currently
//! exposes only `WorkspaceState::switching`, the published authority, and the
//! Safe Mode holder.  This adapter deliberately keeps that compatibility
//! surface narrow: it projects those facts into an opaque, revisioned view and
//! never serializes a workspace path, authority id, recovery candidate id, or
//! durable Run identity.

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use grimodex_db::state::WorkspaceState;
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

#[derive(Debug)]
struct WorkspaceLifecycleViewState {
    revision: u64,
    status: WorkspaceLifecycleStatus,
    binding_token: Option<String>,
    activation: WorkspaceLifecycleActivation,
}

/// Compatibility adapter until the shared lifecycle core owns this state.
///
/// All mutation is local to this adapter and all observations of the old
/// `WorkspaceState` are fail-closed.  The adapter never treats an old
/// authority as reusable merely because a request was rejected; a caller must
/// observe `Ready` with a current revision and binding token.
#[derive(Debug)]
pub(crate) struct WorkspaceLifecycleViewAdapter {
    state: Mutex<WorkspaceLifecycleViewState>,
}

impl Default for WorkspaceLifecycleViewAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceLifecycleViewAdapter {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(WorkspaceLifecycleViewState {
                revision: 0,
                status: WorkspaceLifecycleStatus::Closed,
                binding_token: None,
                activation: WorkspaceLifecycleActivation::None,
            }),
        }
    }

    /// Mark the beginning of an admitted Open/Restore/Shutdown transition.
    /// A repeated call while already transitioning is idempotent and does not
    /// manufacture a new revision.
    pub(crate) fn begin_transition(&self) -> AppResult<(WorkspaceLifecycleView, bool)> {
        self.update(|state| {
            if state.status == WorkspaceLifecycleStatus::Transition {
                return false;
            }
            state.revision = next_revision(state.revision);
            state.status = WorkspaceLifecycleStatus::Transition;
            state.binding_token = Some(new_binding_token());
            state.activation = WorkspaceLifecycleActivation::None;
            true
        })
    }

    /// Publish a ready authority after the shared opener has completed and
    /// the authority is actually visible in `WorkspaceState`.
    pub(crate) fn publish_ready(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        self.publish_from_workspace(workspace, WorkspaceLifecycleStatus::Ready)
    }

    /// Publish a restore-only state.  The active authority must still be
    /// absent; callers do not get a `Ready` projection by merely installing a
    /// restore candidate.
    pub(crate) fn publish_recovery_required(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        self.publish_from_workspace(workspace, WorkspaceLifecycleStatus::RecoveryRequired)
    }

    /// Publish a closed state after the native shutdown owner has proved that
    /// the authority and lifecycle workers are no longer active.  This helper
    /// is intentionally not an N-API command; the eventual shutdown owner must
    /// call it only after its terminal proof.
    pub(crate) fn publish_closed(&self) -> AppResult<WorkspaceLifecycleView> {
        self.update(|state| {
            if state.status == WorkspaceLifecycleStatus::Closed
                && state.binding_token.is_none()
                && state.activation == WorkspaceLifecycleActivation::None
            {
                return false;
            }
            state.revision = next_revision(state.revision);
            state.status = WorkspaceLifecycleStatus::Closed;
            state.binding_token = None;
            state.activation = WorkspaceLifecycleActivation::None;
            true
        })
        .map(|(view, _changed)| view)
    }

    /// Read the old WorkspaceState only at a short boundary.  This keeps the
    /// getter useful during the compatibility period without calling
    /// `active_database`, which would reject the recovery-only state.
    pub(crate) fn snapshot_for_workspace(
        &self,
        workspace: &WorkspaceState,
    ) -> AppResult<WorkspaceLifecycleView> {
        if workspace.switching.load(Ordering::SeqCst) {
            return self.begin_transition().map(|(view, _changed)| view);
        }

        if workspace.safe_mode.is_active() {
            return self.publish_recovery_required(workspace);
        }

        let has_authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .is_some();
        if has_authority {
            self.publish_ready(workspace)
        } else {
            self.publish_closed()
        }
    }

    pub(crate) fn serialize(view: &WorkspaceLifecycleView) -> AppResult<String> {
        Ok(serde_json::to_string(view).map_err(anyhow::Error::from)?)
    }

    fn publish_from_workspace(
        &self,
        workspace: &WorkspaceState,
        status: WorkspaceLifecycleStatus,
    ) -> AppResult<WorkspaceLifecycleView> {
        let has_authority = workspace
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state lock poisoned: {error}"))?
            .is_some();

        let effective_status = match (status, has_authority, workspace.safe_mode.is_active()) {
            (WorkspaceLifecycleStatus::Ready, true, false) => WorkspaceLifecycleStatus::Ready,
            (WorkspaceLifecycleStatus::RecoveryRequired, false, true) => {
                WorkspaceLifecycleStatus::RecoveryRequired
            }
            (_, true, false) => WorkspaceLifecycleStatus::Ready,
            (_, false, true) => WorkspaceLifecycleStatus::RecoveryRequired,
            _ => WorkspaceLifecycleStatus::Closed,
        };

        self.update(|state| {
            let activation = match effective_status {
                WorkspaceLifecycleStatus::Ready => WorkspaceLifecycleActivation::Ready,
                WorkspaceLifecycleStatus::RecoveryRequired => {
                    WorkspaceLifecycleActivation::RequiresOpen
                }
                WorkspaceLifecycleStatus::Transition | WorkspaceLifecycleStatus::Closed => {
                    WorkspaceLifecycleActivation::None
                }
            };
            if state.status == effective_status && state.activation == activation {
                return false;
            }
            state.revision = next_revision(state.revision);
            state.status = effective_status;
            state.binding_token = match effective_status {
                WorkspaceLifecycleStatus::Closed => None,
                WorkspaceLifecycleStatus::Ready
                | WorkspaceLifecycleStatus::Transition
                | WorkspaceLifecycleStatus::RecoveryRequired => Some(new_binding_token()),
            };
            state.activation = activation;
            true
        })
        .map(|(view, _changed)| view)
    }

    fn update(
        &self,
        update: impl FnOnce(&mut WorkspaceLifecycleViewState) -> bool,
    ) -> AppResult<(WorkspaceLifecycleView, bool)> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle view lock poisoned: {error}"))?;
        let changed = update(&mut state);
        let view = self.view_from_state(&state)?;
        Ok((view, changed))
    }

    fn view_from_state(
        &self,
        state: &WorkspaceLifecycleViewState,
    ) -> AppResult<WorkspaceLifecycleView> {
        Ok(WorkspaceLifecycleView {
            schema_version: WORKSPACE_LIFECYCLE_SCHEMA_VERSION,
            revision: state.revision,
            status: state.status,
            binding_token: state.binding_token.clone(),
            activation: state.activation,
        })
    }
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
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    fn empty_workspace() -> WorkspaceState {
        WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: grimodex_db::recovery::SafeModeState::default(),
            switching: AtomicBool::new(false),
            open_lock: Mutex::new(()),
        }
    }

    #[test]
    fn initial_snapshot_is_closed_and_contains_no_sensitive_identity() {
        let adapter = WorkspaceLifecycleViewAdapter::new();
        let workspace = empty_workspace();
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
        let adapter = WorkspaceLifecycleViewAdapter::new();
        let (transition, changed) = adapter.begin_transition().expect("transition");
        assert!(changed);
        assert_eq!(transition.status, WorkspaceLifecycleStatus::Transition);
        assert_eq!(transition.activation, WorkspaceLifecycleActivation::None);
        let transition_token = transition.binding_token.clone().expect("token");

        let workspace = empty_workspace();
        let path =
            std::env::temp_dir().join(format!("grimodex-lifecycle-ready-{}", Uuid::new_v4()));
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
        let adapter = WorkspaceLifecycleViewAdapter::new();
        let workspace = empty_workspace();
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
        let adapter = WorkspaceLifecycleViewAdapter::new();
        let (transition, _) = adapter.begin_transition().expect("transition");
        let closed = adapter.publish_closed().expect("closed");
        assert!(closed.revision > transition.revision);
        assert_eq!(closed.status, WorkspaceLifecycleStatus::Closed);
        assert_eq!(closed.binding_token, None);
        assert_eq!(closed.activation, WorkspaceLifecycleActivation::None);
    }
}
