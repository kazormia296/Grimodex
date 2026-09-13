//! Native-owned profile-wide local-only egress gate (NIR-1 D2a).
//!
//! The Electron main process supplies the caller identity.  This module owns
//! the durable profile state and validates the identity/epoch before a native
//! AI transport is reached.  The state is deliberately a small file beside
//! the existing settings files; it is not part of a workspace database or its
//! migration lifecycle.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const D2A_EGRESS_DENIED_MARKER: &str = "D2A_EGRESS_DENIED:";
const STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub profile_id: String,
    pub caller_id: String,
    pub caller_epoch: u64,
    pub sender_id: u64,
    pub workspace_id: Option<String>,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEgressStatus {
    pub profile_id: String,
    pub caller_epoch: u64,
    pub restricted: bool,
    pub handles_invalidated: bool,
    pub in_flight_stopped: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProfileEgress {
    schema_version: u32,
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
}

#[derive(Debug)]
struct State {
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
    handles_invalidated: bool,
    in_flight_stopped: bool,
}

/// One authority for the profile restriction.  The mutex covers both the
/// state transition and the atomic file replacement so a caller cannot see a
/// persisted epoch that is not the in-memory epoch.
pub struct ProfileEgressState {
    path: PathBuf,
    state: Mutex<State>,
}

impl ProfileEgressState {
    pub fn new(path: PathBuf) -> anyhow::Result<Self> {
        let state = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<PersistedProfileEgress>(&raw) {
                Ok(saved)
                    if saved.schema_version == STATE_VERSION
                        && !saved.profile_id.trim().is_empty()
                        && saved.profile_id == saved.profile_id.trim() =>
                {
                    State {
                        profile_id: saved.profile_id,
                        caller_epoch: saved.caller_epoch,
                        restricted: saved.restricted,
                        handles_invalidated: saved.restricted,
                        in_flight_stopped: saved.restricted,
                    }
                }
                Ok(_) | Err(_) => State {
                    profile_id: Uuid::new_v4().to_string(),
                    caller_epoch: 1,
                    restricted: true,
                    handles_invalidated: true,
                    in_flight_stopped: false,
                },
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State {
                profile_id: Uuid::new_v4().to_string(),
                caller_epoch: 0,
                restricted: false,
                handles_invalidated: false,
                in_flight_stopped: true,
            },
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    /// Activate local-only mode, rotate the caller epoch, and atomically
    /// persist it.  Rotation invalidates every handle issued under the old
    /// epoch, including handles surviving a renderer reload.
    pub fn activate(&self, in_flight_stopped: bool) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        state.caller_epoch = state
            .caller_epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("caller epoch exhausted"))?;
        state.restricted = true;
        state.handles_invalidated = true;
        state.in_flight_stopped = in_flight_stopped;
        self.persist_locked(&state)?;
        Ok(status_locked(&state))
    }

    /// Record the completion of the stop barrier after restriction and epoch
    /// invalidation have already become durable.
    pub fn confirm_in_flight_stopped(&self) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        state.in_flight_stopped = true;
        self.persist_locked(&state)?;
        Ok(status_locked(&state))
    }

    #[cfg(test)]
    pub fn status(&self) -> ProfileEgressStatus {
        status_locked(&self.lock())
    }

    /// Validate an identity bound by Electron main. Renderer IPC always
    /// supplies it because `registerIpcRouter` injects it at the sender
    /// boundary. Before D2a startup (standalone compatibility tests) the
    /// profile remains unrestricted and legacy direct calls continue to work.
    pub fn authorize_optional(&self, identity: Option<&CallerIdentity>) -> anyhow::Result<()> {
        let state = self.lock();
        if !state.restricted {
            return Ok(());
        }
        let Some(identity) = identity else {
            return Err(anyhow!(
                "{D2A_EGRESS_DENIED_MARKER} caller identity is missing"
            ));
        };
        if identity.profile_id != state.profile_id
            || identity.caller_epoch != state.caller_epoch
            || identity.sender_id == 0
            || identity.caller_id.trim().is_empty()
            || identity.caller_id != identity.caller_id.trim()
            || identity.session_id.trim().is_empty()
            || identity.session_id != identity.session_id.trim()
            || identity.workspace_id.as_deref().is_some_and(|workspace| {
                workspace.trim().is_empty() || workspace != workspace.trim()
            })
        {
            return Err(anyhow!(
                "{D2A_EGRESS_DENIED_MARKER} caller identity is stale or not bound to this profile"
            ));
        }
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist_locked(&self, state: &State) -> anyhow::Result<()> {
        let saved = PersistedProfileEgress {
            schema_version: STATE_VERSION,
            profile_id: state.profile_id.clone(),
            caller_epoch: state.caller_epoch,
            restricted: state.restricted,
        };
        let raw = serde_json::to_vec_pretty(&saved)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, raw).with_context(|| format!("write {}", temporary.display()))?;
        fs::rename(&temporary, &self.path)
            .with_context(|| format!("replace {}", self.path.display()))?;
        Ok(())
    }
}

fn status_locked(state: &State) -> ProfileEgressStatus {
    ProfileEgressStatus {
        profile_id: state.profile_id.clone(),
        caller_epoch: state.caller_epoch,
        restricted: state.restricted,
        handles_invalidated: state.handles_invalidated,
        in_flight_stopped: state.in_flight_stopped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex-d2a-{label}-{}.json", Uuid::new_v4()))
    }

    #[test]
    fn activation_persists_profile_and_rotates_epoch() {
        let path = temp_path("persist");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let before = state.status();
        let activated = state.activate(true).expect("activate");
        assert!(activated.restricted);
        assert!(activated.handles_invalidated);
        assert!(activated.in_flight_stopped);
        assert!(activated.caller_epoch > before.caller_epoch);

        let reloaded = ProfileEgressState::new(path.clone()).expect("reload");
        let restored = reloaded.status();
        assert_eq!(restored.profile_id, activated.profile_id);
        assert_eq!(restored.caller_epoch, activated.caller_epoch);
        assert!(restored.restricted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_or_forged_identity_is_denied_after_activation() {
        let path = temp_path("identity");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state.activate(true).expect("activate");
        let valid = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 7,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        state
            .authorize_optional(Some(&valid))
            .expect("valid identity");
        let mut stale = valid.clone();
        stale.caller_epoch -= 1;
        let error = state
            .authorize_optional(Some(&stale))
            .expect_err("stale identity");
        assert!(error.to_string().starts_with(D2A_EGRESS_DENIED_MARKER));
        let _ = fs::remove_file(path);
    }
}
