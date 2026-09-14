//! Native-owned profile-wide local-only egress gate (NIR-1 D2a).
//!
//! The Electron main process supplies the caller identity.  This module owns
//! the durable profile state and validates the identity/epoch before a native
//! AI transport is reached.  The state is deliberately a small file beside
//! the existing settings files; it is not part of a workspace database or its
//! migration lifecycle.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context};
use grimodex_core::profile_egress::{PublicationLease, PublicationLockMode};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use uuid::Uuid;

pub const D2A_EGRESS_DENIED_MARKER: &str = "D2A_EGRESS_DENIED:";
const STATE_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
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
    /// Optional keeps schema v1 files readable; v1 had no stop-barrier bits.
    #[serde(default)]
    handles_invalidated: Option<bool>,
    #[serde(default)]
    in_flight_stopped: Option<bool>,
}

#[derive(Debug)]
struct State {
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
    handles_invalidated: bool,
    in_flight_stopped: bool,
    /// The trusted workspace binding for this process generation. It is
    /// intentionally process-local; workspace open/restore rebinds it before
    /// the corresponding event can issue another caller identity.
    workspace_id: Option<String>,
    /// Exact identities are process-local. A fresh Backend is a fresh process
    /// generation, so stale tuples from a previous process cannot authorize.
    registered_callers: HashMap<u64, CallerIdentity>,
}

/// One authority for the profile restriction.  The mutex covers both the
/// state transition and the atomic file replacement so a caller cannot see a
/// persisted epoch that is not the in-memory epoch.
pub struct ProfileEgressState {
    path: PathBuf,
    state: Mutex<State>,
    active_dispatches: Arc<AtomicUsize>,
    dispatch_quiesced: Arc<Notify>,
    admissions_open: Arc<AtomicBool>,
}

/// A Native dispatch lease. The startup transition closes new leases and
/// invalidates process-local registrations, then waits for every lease to
/// drop before it publishes the final `inFlightStopped` state.
#[derive(Clone, Debug)]
pub struct ProfileDispatchPermit {
    lease: Arc<DispatchLease>,
}

#[derive(Debug)]
struct DispatchLease {
    active_dispatches: Arc<AtomicUsize>,
    dispatch_quiesced: Arc<Notify>,
    admissions_open: Arc<AtomicBool>,
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        if self.active_dispatches.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.dispatch_quiesced.notify_waiters();
        }
    }
}

impl ProfileEgressState {
    pub fn new(path: PathBuf) -> anyhow::Result<Self> {
        let state = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<PersistedProfileEgress>(&raw) {
                Ok(saved)
                    if matches!(saved.schema_version, 1 | STATE_VERSION)
                        && !saved.profile_id.trim().is_empty()
                        && saved.profile_id == saved.profile_id.trim() =>
                {
                    State {
                        profile_id: saved.profile_id,
                        caller_epoch: saved.caller_epoch,
                        restricted: saved.restricted,
                        // Schema v1 could only have been persisted after the
                        // original startup activation, so its missing bits
                        // conservatively inherit the restricted state. The
                        // next startup still runs the barrier before publish.
                        handles_invalidated: saved.handles_invalidated.unwrap_or(saved.restricted),
                        in_flight_stopped: saved.in_flight_stopped.unwrap_or(saved.restricted),
                        workspace_id: None,
                        registered_callers: HashMap::new(),
                    }
                }
                Ok(_) | Err(_) => State {
                    profile_id: Uuid::new_v4().to_string(),
                    caller_epoch: 1,
                    restricted: true,
                    handles_invalidated: true,
                    in_flight_stopped: false,
                    workspace_id: None,
                    registered_callers: HashMap::new(),
                },
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State {
                profile_id: Uuid::new_v4().to_string(),
                caller_epoch: 0,
                restricted: false,
                handles_invalidated: false,
                in_flight_stopped: true,
                workspace_id: None,
                registered_callers: HashMap::new(),
            },
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let admissions_open = !state.restricted || state.in_flight_stopped;
        Ok(Self {
            path,
            state: Mutex::new(state),
            active_dispatches: Arc::new(AtomicUsize::new(0)),
            dispatch_quiesced: Arc::new(Notify::new()),
            admissions_open: Arc::new(AtomicBool::new(admissions_open)),
        })
    }

    /// Perform the one explicit first-restricted-publication transition.
    /// Restarting an already restricted profile is idempotent: it must not
    /// rotate the epoch merely because the process started again.
    pub fn activate_first_restricted_publication(
        &self,
        in_flight_stopped: bool,
    ) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        if state.restricted {
            return Ok(status_locked(&state));
        }
        state.caller_epoch = state
            .caller_epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("caller epoch exhausted"))?;
        state.restricted = true;
        state.handles_invalidated = true;
        state.in_flight_stopped = in_flight_stopped;
        state.registered_callers.clear();
        self.persist_locked(&state)?;
        self.admissions_open
            .store(in_flight_stopped, Ordering::Release);
        Ok(status_locked(&state))
    }

    /// Close admissions for one process startup after loading the persisted
    /// profile state. Only an unrestricted profile takes the explicit first
    /// restricted-publication transition; an already restricted profile keeps
    /// its epoch and merely re-runs the stop barrier for this process.
    pub fn begin_startup_barrier(&self) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        anyhow::ensure!(
            state.restricted,
            "{D2A_EGRESS_DENIED_MARKER} profile restriction is not activated"
        );
        state.handles_invalidated = true;
        state.in_flight_stopped = false;
        state.registered_callers.clear();
        // Close admissions while holding the same mutex used by begin_dispatch;
        // no caller can pass authorization after this transition starts.
        self.admissions_open.store(false, Ordering::Release);
        self.persist_locked(&state)?;
        Ok(status_locked(&state))
    }

    /// Register the exact main-issued identity for this process generation.
    /// The registration is deliberately not durable; only the main process
    /// can create it after the startup stop barrier has completed.
    pub fn register_caller(&self, identity: &CallerIdentity) -> anyhow::Result<()> {
        let mut state = self.lock();
        anyhow::ensure!(
            state.restricted && state.in_flight_stopped,
            "{D2A_EGRESS_DENIED_MARKER} caller registration is closed until startup quiesces"
        );
        authorize_locked(&state, Some(identity))?;
        state
            .registered_callers
            .insert(identity.sender_id, identity.clone());
        Ok(())
    }

    /// Record the completion of the stop barrier after restriction and epoch
    /// invalidation have already become durable.
    pub fn confirm_in_flight_stopped(&self) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        anyhow::ensure!(
            self.active_dispatches.load(Ordering::Acquire) == 0,
            "cannot publish profile egress state while dispatches are active"
        );
        state.in_flight_stopped = true;
        self.persist_locked(&state)?;
        self.admissions_open.store(true, Ordering::Release);
        Ok(status_locked(&state))
    }

    pub fn status(&self) -> ProfileEgressStatus {
        status_locked(&self.lock())
    }

    /// Acquire the cross-process publication lease before changing or
    /// publishing the restriction. MCP holds the shared side until its
    /// complete framed response is emitted, so the native transition cannot
    /// publish `inFlightStopped` while a plaintext response is still writing.
    pub fn acquire_publication_exclusive(&self) -> anyhow::Result<PublicationLease> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        PublicationLease::acquire(&self.path, PublicationLockMode::Exclusive).with_context(|| {
            format!(
                "acquire profile publication lease beside {}",
                self.path.display()
            )
        })
    }

    /// Reserve one legacy Native dispatch while it performs its local work.
    /// The state mutex closes the check/increment race with the startup
    /// transition: after restriction, only the current main-issued epoch can
    /// obtain a lease.
    pub fn begin_dispatch(
        &self,
        identity: Option<&CallerIdentity>,
    ) -> anyhow::Result<ProfileDispatchPermit> {
        let state = self.lock();
        if state.restricted {
            authorize_locked(&state, identity)?;
            anyhow::ensure!(
                state.in_flight_stopped,
                "{D2A_EGRESS_DENIED_MARKER} dispatch admissions are closed during startup quiescence"
            );
            let identity = identity
                .ok_or_else(|| anyhow!("{D2A_EGRESS_DENIED_MARKER} caller identity is missing"))?;
            anyhow::ensure!(
                state
                    .registered_callers
                    .get(&identity.sender_id)
                    .is_some_and(|registered| registered == identity),
                "{D2A_EGRESS_DENIED_MARKER} caller identity is not registered in this process"
            );
        }
        self.active_dispatches.fetch_add(1, Ordering::AcqRel);
        Ok(ProfileDispatchPermit {
            lease: Arc::new(DispatchLease {
                active_dispatches: Arc::clone(&self.active_dispatches),
                dispatch_quiesced: Arc::clone(&self.dispatch_quiesced),
                admissions_open: Arc::clone(&self.admissions_open),
            }),
        })
    }

    /// Invalidate every process-local registration when the trusted workspace
    /// binding changes. Old tuples must not remain usable until each sender
    /// happens to make a new invoke.
    pub fn invalidate_callers(&self) {
        self.lock().registered_callers.clear();
    }

    /// Rebind the trusted active workspace and invalidate all caller tuples.
    /// Main supplies the same path that Native publishes in its
    /// `workspace:opened` event, so an event-order race cannot re-register a
    /// tuple from the previous workspace.
    pub fn bind_workspace(&self, workspace_id: Option<String>) {
        let mut state = self.lock();
        state.workspace_id = workspace_id;
        state.registered_callers.clear();
    }

    /// Wait until all leases acquired before the transition have dropped.
    pub async fn wait_for_dispatches(&self) {
        loop {
            if self.active_dispatches.load(Ordering::Acquire) == 0 {
                return;
            }
            let notified = self.dispatch_quiesced.notified();
            if self.active_dispatches.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    /// Validate an identity bound by Electron main. Renderer IPC always
    /// supplies it because `registerIpcRouter` injects it at the sender
    /// boundary. Before D2a startup (standalone compatibility tests) the
    /// profile remains unrestricted and legacy direct calls continue to work.
    #[cfg(test)]
    pub fn authorize_optional(&self, identity: Option<&CallerIdentity>) -> anyhow::Result<()> {
        let state = self.lock();
        authorize_locked(&state, identity)
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
            handles_invalidated: Some(state.handles_invalidated),
            in_flight_stopped: Some(state.in_flight_stopped),
        };
        let raw = serde_json::to_vec_pretty(&saved)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let mut temporary_os = self.path.as_os_str().to_owned();
        temporary_os.push(format!(".tmp-{}", Uuid::new_v4()));
        let temporary = PathBuf::from(temporary_os);
        let result = (|| -> anyhow::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .with_context(|| format!("create {}", temporary.display()))?;
            file.write_all(&raw)
                .with_context(|| format!("write {}", temporary.display()))?;
            file.sync_all()
                .with_context(|| format!("sync {}", temporary.display()))?;
            drop(file);
            grimodex_db::backup_restore::atomic_replace(&temporary, &self.path)
                .with_context(|| format!("replace {}", self.path.display()))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

impl ProfileDispatchPermit {
    /// Recheck the startup admission immediately before a real transport call.
    /// A permit keeps the dispatch counted until its owner returns, allowing
    /// the startup barrier to drain a call that was already in flight.
    pub fn ensure_open(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.lease.admissions_open.load(Ordering::Acquire),
            "{D2A_EGRESS_DENIED_MARKER} dispatch admissions are closed"
        );
        Ok(())
    }
}

fn authorize_locked(state: &State, identity: Option<&CallerIdentity>) -> anyhow::Result<()> {
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
        || identity.workspace_id != state.workspace_id
        || identity.sender_id == 0
        || identity.caller_id.trim().is_empty()
        || identity.caller_id != identity.caller_id.trim()
        || identity.session_id.trim().is_empty()
        || identity.session_id != identity.session_id.trim()
        || identity
            .workspace_id
            .as_deref()
            .is_some_and(|workspace| workspace.trim().is_empty() || workspace != workspace.trim())
    {
        return Err(anyhow!(
            "{D2A_EGRESS_DENIED_MARKER} caller identity is stale or not bound to this profile"
        ));
    }
    Ok(())
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
        let activated = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        assert!(activated.restricted);
        assert!(activated.handles_invalidated);
        assert!(activated.in_flight_stopped);
        assert!(activated.caller_epoch > before.caller_epoch);

        let reloaded = ProfileEgressState::new(path.clone()).expect("reload");
        let restored = reloaded.status();
        assert_eq!(restored.profile_id, activated.profile_id);
        assert_eq!(restored.caller_epoch, activated.caller_epoch);
        assert!(restored.restricted);
        assert!(restored.handles_invalidated);
        assert!(restored.in_flight_stopped);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn repeated_startup_does_not_rotate_restricted_profile_epoch() {
        let path = temp_path("idempotent");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let first = state
            .activate_first_restricted_publication(false)
            .expect("first transition");
        let second = state.begin_startup_barrier().expect("restart transition");
        assert_eq!(second.profile_id, first.profile_id);
        assert_eq!(second.caller_epoch, first.caller_epoch);
        assert!(!second.in_flight_stopped);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_barrier_requires_the_explicit_first_publication() {
        let path = temp_path("explicit-activation");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        assert!(state.begin_startup_barrier().is_err());
        assert!(!state.status().restricted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn partial_stop_reloads_restricted_until_a_new_barrier_confirms() {
        let path = temp_path("partial-stop");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let first = state
            .activate_first_restricted_publication(false)
            .expect("first transition");
        drop(state);

        let recovered = ProfileEgressState::new(path.clone()).expect("reload");
        let pending = recovered.status();
        assert_eq!(pending.profile_id, first.profile_id);
        assert_eq!(pending.caller_epoch, first.caller_epoch);
        assert!(pending.restricted);
        assert!(pending.handles_invalidated);
        assert!(!pending.in_flight_stopped);
        assert!(recovered.begin_dispatch(None).is_err());
        recovered
            .confirm_in_flight_stopped()
            .expect("recovery barrier");
        assert!(recovered.status().in_flight_stopped);
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn dispatch_barrier_waits_for_active_permit_and_rejects_new_epoch() {
        let path = temp_path("barrier");
        let state = std::sync::Arc::new(ProfileEgressState::new(path.clone()).expect("state"));
        let active = state.begin_dispatch(None).expect("unrestricted permit");
        state
            .activate_first_restricted_publication(false)
            .expect("activate");
        assert!(state.confirm_in_flight_stopped().is_err());

        let profile = state.status();
        let identity = CallerIdentity {
            profile_id: profile.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: profile.caller_epoch,
            sender_id: 7,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        let next = state.begin_dispatch(Some(&identity));
        assert!(
            next.is_err(),
            "admissions must stay closed until the active permit drains"
        );
        assert!(
            state.register_caller(&identity).is_err(),
            "caller registration must remain closed during the barrier"
        );

        let wait_state = std::sync::Arc::clone(&state);
        let wait = tokio::spawn(async move { wait_state.wait_for_dispatches().await });
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "barrier must wait while leases are held"
        );
        drop(active);
        wait.await.expect("barrier wait");
        let confirmed = state
            .confirm_in_flight_stopped()
            .expect("barrier confirmation");
        assert!(confirmed.in_flight_stopped);
        state
            .register_caller(&identity)
            .expect("registration opens after the barrier");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("registered caller after the barrier");
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_or_forged_identity_is_denied_after_activation() {
        let path = temp_path("identity");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
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

    #[test]
    fn registration_requires_exact_current_process_identity() {
        let path = temp_path("registration");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(false)
            .expect("activate");
        state.confirm_in_flight_stopped().expect("startup barrier");
        state.bind_workspace(Some("workspace-1".to_string()));
        let valid = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 7,
            workspace_id: Some("workspace-1".to_string()),
            session_id: "session-1".to_string(),
        };
        state
            .register_caller(&valid)
            .expect("register valid caller");
        let permit = state
            .begin_dispatch(Some(&valid))
            .expect("registered caller");
        drop(permit);

        let mut forged = valid.clone();
        forged.session_id = "session-forged".to_string();
        assert!(
            state.begin_dispatch(Some(&forged)).is_err(),
            "same structural profile/epoch must not authorize a forged tuple"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn replacing_sender_registration_invalidates_previous_tuple() {
        let path = temp_path("registration-replace");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-1".to_string()));
        let first = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-first".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 9,
            workspace_id: Some("workspace-1".to_string()),
            session_id: "session-first".to_string(),
        };
        state
            .register_caller(&first)
            .expect("register first caller");
        let mut replacement = first.clone();
        replacement.caller_id = "main-second".to_string();
        replacement.workspace_id = Some("workspace-1".to_string());
        replacement.session_id = "session-second".to_string();
        state
            .register_caller(&replacement)
            .expect("register replacement caller");
        assert!(state.begin_dispatch(Some(&first)).is_err());
        let permit = state
            .begin_dispatch(Some(&replacement))
            .expect("replacement caller");
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn workspace_change_invalidates_old_process_local_registration() {
        let path = temp_path("registration-workspace");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-1".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 21,
            workspace_id: Some("workspace-1".to_string()),
            session_id: "session-1".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        state.invalidate_callers();
        assert!(state.begin_dispatch(Some(&identity)).is_err());
        state.bind_workspace(Some("workspace-2".to_string()));
        assert!(
            state.register_caller(&identity).is_err(),
            "an old workspace tuple must not be re-registered after a swap"
        );
        let rebound = CallerIdentity {
            workspace_id: Some("workspace-2".to_string()),
            ..identity
        };
        state
            .register_caller(&rebound)
            .expect("register rebound caller");
        assert!(state.begin_dispatch(Some(&rebound)).is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_barrier_closes_an_existing_dispatch_permit() {
        let path = temp_path("permit-close");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let permit = state.begin_dispatch(None).expect("unrestricted permit");
        state
            .activate_first_restricted_publication(false)
            .expect("activate");
        state.begin_startup_barrier().expect("startup barrier");
        assert!(permit.ensure_open().is_err());
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn restart_does_not_restore_process_local_registration() {
        let path = temp_path("registration-restart");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        let identity = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 12,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        drop(state);

        let restarted = ProfileEgressState::new(path.clone()).expect("restart");
        assert!(restarted.begin_dispatch(Some(&identity)).is_err());
        let _ = fs::remove_file(path);
    }
}
