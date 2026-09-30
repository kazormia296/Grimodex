//! Native-owned profile-wide local-only egress gate (NIR-1 D2a).
//!
//! The Electron main process supplies the caller identity.  This module owns
//! the durable profile state and validates the identity/epoch before a native
//! AI transport is reached.  The state is deliberately a small file beside
//! the existing settings files; it is not part of a workspace database or its
//! migration lifecycle.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context};
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
    pub sql_policy: grimodex_db::profile_egress_policy::ProfileEgressSqlPolicy,
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
    /// Serializes route-setting writes with the short-lived current-capture
    /// commit boundary; capture admission is non-queuing.
    route_commit_gate: Mutex<()>,
    #[cfg(test)]
    capture_test_events: Mutex<Option<std::sync::mpsc::Sender<CaptureTestEvent>>>,
    #[cfg(test)]
    capture_test_continue: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    active_dispatches: Arc<AtomicUsize>,
    dispatch_quiesced: Arc<Notify>,
    admissions_open: Arc<AtomicBool>,
    /// Monotonic process-local binding generation. Every workspace bind,
    /// caller invalidation, startup barrier, and registration replacement
    /// revokes permits captured before the transition.
    revocation_generation: Arc<AtomicU64>,
}

/// A Native dispatch lease. The startup transition closes new leases and
/// invalidates process-local registrations, then waits for every lease to
/// drop before it publishes the final `inFlightStopped` state.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CaptureTestEvent {
    RouteValidated,
    WriterStarting,
    CaptureCommitted,
    RouteUpdateWaiting,
    RouteUpdateAcquired,
}

#[derive(Clone, Debug)]
pub struct ProfileDispatchPermit {
    lease: Arc<DispatchLease>,
}

#[derive(Debug)]
struct DispatchLease {
    active_dispatches: Arc<AtomicUsize>,
    dispatch_quiesced: Arc<Notify>,
    admissions_open: Arc<AtomicBool>,
    revocation_generation: Arc<AtomicU64>,
    generation: u64,
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
            route_commit_gate: Mutex::new(()),
            #[cfg(test)]
            capture_test_events: Mutex::new(None),
            #[cfg(test)]
            capture_test_continue: Mutex::new(None),
            active_dispatches: Arc::new(AtomicUsize::new(0)),
            dispatch_quiesced: Arc::new(Notify::new()),
            admissions_open: Arc::new(AtomicBool::new(admissions_open)),
            revocation_generation: Arc::new(AtomicU64::new(0)),
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
        self.revoke_permits();
        if let Err(error) = self.persist_locked(&state) {
            // A failed durability barrier must never leave the in-memory gate
            // admitting calls merely because the requested stop bit was true.
            // Keep the profile restricted, but fail closed until a later
            // process can establish a fresh startup barrier.
            state.in_flight_stopped = false;
            self.admissions_open.store(false, Ordering::Release);
            return Err(error);
        }
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
        self.revoke_permits();
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
        let replaced = state
            .registered_callers
            .get(&identity.sender_id)
            .is_some_and(|registered| registered != identity);
        state
            .registered_callers
            .insert(identity.sender_id, identity.clone());
        if replaced {
            self.revoke_permits();
        }
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
        if let Err(error) = self.persist_locked(&state) {
            // Do not expose the completed barrier if its durable marker was not
            // persisted. The next startup must repeat the stop barrier.
            state.in_flight_stopped = false;
            self.admissions_open.store(false, Ordering::Release);
            return Err(error);
        }
        self.admissions_open.store(true, Ordering::Release);
        Ok(status_locked(&state))
    }

    pub fn status(&self) -> ProfileEgressStatus {
        status_locked(&self.lock())
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
        let generation = self.revocation_generation.load(Ordering::Acquire);
        Ok(ProfileDispatchPermit {
            lease: Arc::new(DispatchLease {
                active_dispatches: Arc::clone(&self.active_dispatches),
                dispatch_quiesced: Arc::clone(&self.dispatch_quiesced),
                admissions_open: Arc::clone(&self.admissions_open),
                revocation_generation: Arc::clone(&self.revocation_generation),
                generation,
            }),
        })
    }

    /// Invalidate every process-local registration when the trusted workspace
    /// binding changes. Old tuples must not remain usable until each sender
    /// happens to make a new invoke.
    pub fn invalidate_callers(&self) {
        let mut state = self.lock();
        state.registered_callers.clear();
        self.revoke_permits();
    }

    /// Rebind the trusted active workspace and invalidate all caller tuples.
    /// Main supplies the same path that Native publishes in its
    /// `workspace:opened` event, so an event-order race cannot re-register a
    /// tuple from the previous workspace.
    pub fn bind_workspace(&self, workspace_id: Option<String>) {
        let mut state = self.lock();
        state.workspace_id = workspace_id;
        state.registered_callers.clear();
        self.revoke_permits();
    }

    /// Bind a restore-only workspace before the corresponding `workspace:opened`
    /// event is emitted. Safe Mode has no active Database authority, but its
    /// recovery commands still need the same trusted workspace tuple as main;
    /// keeping this transition explicit prevents the restore-only early return
    /// from silently skipping the Native binding update.
    pub fn bind_recovery_workspace(&self, workspace_id: Option<String>) {
        self.bind_workspace(workspace_id);
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

    /// Revalidate a DB dispatch against the one pinned workspace authority.
    /// The check is intentionally performed under the same state mutex as
    /// bind/invalidate/registration transitions, so a swap cannot publish a
    /// result after the caller tuple has been revoked.
    pub fn reauthorize_dispatch(
        &self,
        permit: &ProfileDispatchPermit,
        identity: Option<&CallerIdentity>,
        pinned_workspace_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.with_authorized_dispatch(permit, identity, pinned_workspace_id, || Ok(()))
    }

    /// Serialize a short final dispatch claim with profile/caller revocation.
    /// The caller already owns its DB transaction; its closure must include
    /// COMMIT, must not reacquire this state, and must never await transport.
    /// This is not a product transport grant: the route, workspace, current
    /// material and durable one-shot claim remain the caller's responsibility.
    pub fn with_authorized_dispatch<T>(
        &self,
        permit: &ProfileDispatchPermit,
        identity: Option<&CallerIdentity>,
        pinned_workspace_id: Option<&str>,
        operation: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let state = self.lock();
        permit.ensure_open()?;
        anyhow::ensure!(
            Arc::ptr_eq(
                &permit.lease.revocation_generation,
                &self.revocation_generation
            ) && permit.lease.generation == self.revocation_generation.load(Ordering::Acquire),
            "{D2A_EGRESS_DENIED_MARKER} dispatch binding was revoked"
        );
        if state.restricted {
            authorize_locked(&state, identity)?;
            let identity = identity
                .ok_or_else(|| anyhow!("{D2A_EGRESS_DENIED_MARKER} caller identity is missing"))?;
            anyhow::ensure!(
                identity.workspace_id.as_deref() == pinned_workspace_id,
                "{D2A_EGRESS_DENIED_MARKER} pinned workspace does not match caller identity"
            );
            anyhow::ensure!(
                state
                    .registered_callers
                    .get(&identity.sender_id)
                    .is_some_and(|registered| registered == identity),
                "{D2A_EGRESS_DENIED_MARKER} caller identity is no longer registered"
            );
        }
        operation()
    }

    /// Check current Native caller/profile authority without granting a
    /// dispatch lease. Preparation may read profile-owned route state here,
    /// but must release this lock before SQLite or payload rendering.
    pub(crate) fn with_authorized_preparation<T>(
        &self,
        identity: &CallerIdentity,
        pinned_workspace_id: &str,
        operation: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let state = self.lock();
        anyhow::ensure!(
            state.restricted && state.in_flight_stopped,
            "{D2A_EGRESS_DENIED_MARKER} profile preparation is not admitted"
        );
        authorize_locked(&state, Some(identity))?;
        anyhow::ensure!(
            identity.workspace_id.as_deref() == Some(pinned_workspace_id)
                && state.workspace_id.as_deref() == Some(pinned_workspace_id),
            "{D2A_EGRESS_DENIED_MARKER} preparation workspace does not match the active caller"
        );
        anyhow::ensure!(
            state
                .registered_callers
                .get(&identity.sender_id)
                .is_some_and(|registered| registered == identity),
            "{D2A_EGRESS_DENIED_MARKER} preparation caller is not registered in this process"
        );
        operation()
    }

    /// Admit one current capture without queueing behind another capture or
    /// settings write. Its closure may use SQLite but must not retain `state`.
    pub(crate) fn with_route_capture_commit<T>(
        &self,
        operation: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let _route = match self.route_commit_gate.try_lock() {
            Ok(route) => route,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                anyhow::bail!("NIR1_CHAT_CAPTURE_ROUTE_BUSY")
            }
        };
        operation()
    }

    pub(crate) fn revocation_generation(&self) -> u64 {
        self.revocation_generation.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn set_capture_test_hooks(
        &self,
        events: std::sync::mpsc::Sender<CaptureTestEvent>,
        continuation: std::sync::mpsc::Receiver<()>,
    ) {
        *self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(events);
        *self
            .capture_test_continue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(continuation);
    }

    #[cfg(test)]
    pub(crate) fn capture_route_validated_for_test(&self) -> anyhow::Result<()> {
        if let Some(sender) = self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(CaptureTestEvent::RouteValidated);
        }
        if let Some(receiver) = self
            .capture_test_continue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            receiver
                .recv()
                .map_err(|_| anyhow!("capture test continuation closed"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn capture_writer_starting_for_test(&self) {
        if let Some(sender) = self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(CaptureTestEvent::WriterStarting);
        }
    }

    #[cfg(test)]
    pub(crate) fn capture_committed_for_test(&self) {
        self.send_capture_test_event(CaptureTestEvent::CaptureCommitted);
    }

    #[cfg(test)]
    fn route_update_waiting_for_test(&self) {
        self.send_capture_test_event(CaptureTestEvent::RouteUpdateWaiting);
    }

    #[cfg(test)]
    fn route_update_acquired_for_test(&self) {
        self.send_capture_test_event(CaptureTestEvent::RouteUpdateAcquired);
    }

    #[cfg(test)]
    fn send_capture_test_event(&self, event: CaptureTestEvent) {
        if let Some(sender) = self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(event);
        }
    }

    /// Route-setting writes serialize behind a currently admitted capture.
    /// Revoke before writing, including failed/partial file writes. The
    /// closure performs filesystem work only and never enters DB/core.
    pub fn with_route_update<T>(
        &self,
        update: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        #[cfg(test)]
        self.route_update_waiting_for_test();
        let _route = self
            .route_commit_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(test)]
        self.route_update_acquired_for_test();
        let _state = self.lock();
        self.revoke_permits();
        update()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn revoke_permits(&self) {
        self.revocation_generation.fetch_add(1, Ordering::AcqRel);
    }

    fn persist_locked(&self, state: &State) -> anyhow::Result<()> {
        self.persist_locked_with(
            state,
            |staged, destination| {
                grimodex_db::backup_restore::atomic_replace(staged, destination)
                    .map_err(anyhow::Error::from)
            },
            sync_parent_directory,
        )
    }

    fn persist_locked_with<Replace, SyncDirectory>(
        &self,
        state: &State,
        replace: Replace,
        sync_directory: SyncDirectory,
    ) -> anyhow::Result<()>
    where
        Replace: FnOnce(&Path, &Path) -> anyhow::Result<()>,
        SyncDirectory: FnOnce(&Path) -> anyhow::Result<()>,
    {
        let saved = PersistedProfileEgress {
            schema_version: STATE_VERSION,
            profile_id: state.profile_id.clone(),
            caller_epoch: state.caller_epoch,
            restricted: state.restricted,
            handles_invalidated: Some(state.handles_invalidated),
            in_flight_stopped: Some(state.in_flight_stopped),
        };
        let raw = serde_json::to_vec_pretty(&saved)?;
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
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
            replace(&temporary, &self.path)
                .with_context(|| format!("replace {}", self.path.display()))?;
            sync_directory(parent)
                .with_context(|| format!("sync directory {}", parent.display()))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> anyhow::Result<()> {
    // `Path::parent()` for a relative filename is an empty path.  The
    // profile path is normally absolute, but syncing `.` keeps the durability
    // contract intact for tests and direct embedders as well.
    let directory = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    File::open(directory)
        .with_context(|| format!("open directory {}", directory.display()))?
        .sync_all()
        .with_context(|| format!("sync directory {}", directory.display()))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> anyhow::Result<()> {
    Ok(())
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
        anyhow::ensure!(
            self.lease.revocation_generation.load(Ordering::Acquire) == self.lease.generation,
            "{D2A_EGRESS_DENIED_MARKER} dispatch binding was revoked"
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
        sql_policy: grimodex_db::profile_egress_policy::sql_policy_for_status(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex-d2a-{label}-{}.json", Uuid::new_v4()))
    }

    #[test]
    fn final_dispatch_guard_holds_profile_authority_through_claim() {
        let path = temp_path("final-dispatch-guard");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-a".into()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".into(),
            caller_epoch: status.caller_epoch,
            sender_id: 51,
            workspace_id: Some("workspace-a".into()),
            session_id: "session-a".into(),
        };
        state.register_caller(&identity).expect("register");
        let permit = state.begin_dispatch(Some(&identity)).expect("permit");
        let result = state
            .with_authorized_dispatch(&permit, Some(&identity), Some("workspace-a"), || {
                assert!(matches!(
                    state.state.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                Ok("durable-claim")
            })
            .expect("claim under guard");
        assert_eq!(result, "durable-claim");
        assert!(
            state.state.try_lock().is_ok(),
            "transport must run after guard release"
        );
        state.invalidate_callers();
        let entered = AtomicBool::new(false);
        assert!(state
            .with_authorized_dispatch(&permit, Some(&identity), Some("workspace-a"), || {
                entered.store(true, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert!(!entered.load(Ordering::SeqCst));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn route_update_serializes_with_final_claim_and_revokes_on_failure() {
        let path = temp_path("route-update-guard");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let permit = state.begin_dispatch(None).expect("legacy fixture permit");
        let result: anyhow::Result<()> = state.with_route_update(|| {
            assert!(matches!(
                state.state.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            assert!(
                permit.ensure_open().is_err(),
                "revoke before file writer enters"
            );
            Err(anyhow!("partial route write"))
        });
        assert!(result.is_err());
        assert!(state
            .with_authorized_dispatch(&permit, None, None, || Ok(()))
            .is_err());
        assert!(state.state.try_lock().is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn final_dispatch_guard_rejects_permit_from_another_profile_owner() {
        let first = ProfileEgressState::new(temp_path("permit-owner-a")).expect("first");
        let second = ProfileEgressState::new(temp_path("permit-owner-b")).expect("second");
        let permit = first.begin_dispatch(None).expect("first owner permit");
        assert!(second
            .with_authorized_dispatch(&permit, None, None, || Ok(()))
            .is_err());
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
    fn directory_sync_failure_after_replace_is_not_reported_as_persist_success() {
        let path = temp_path("directory-sync-failure");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let locked = state.lock();
        let result = state.persist_locked_with(
            &locked,
            |staged, destination| fs::rename(staged, destination).map_err(anyhow::Error::from),
            |_parent| Err(anyhow!("injected directory sync failure")),
        );
        drop(locked);

        let error = result.expect_err("directory sync failure must fail persistence");
        assert!(
            format!("{error:#}").contains("injected directory sync failure"),
            "unexpected persistence error: {error:#}"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn activation_stays_closed_when_profile_persistence_fails() {
        let parent = temp_path("persistence-failure-parent");
        let path = parent.join("profile-egress.json");
        let state = ProfileEgressState::new(path).expect("state before parent exists");
        fs::write(&parent, b"blocking file").expect("create blocking parent file");

        let error = state
            .activate_first_restricted_publication(true)
            .expect_err("activation must fail when its profile path cannot be persisted");
        assert!(format!("{error:#}").contains("create"));
        let status = state.status();
        assert!(status.restricted);
        assert!(!status.in_flight_stopped);
        assert!(
            state.begin_dispatch(None).is_err(),
            "failed persistence must not leave admissions open"
        );
        let _ = fs::remove_file(parent);
    }

    #[test]
    fn status_publishes_the_native_sql_policy_without_a_second_inventory() {
        let path = temp_path("policy-status");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state.status();
        let policy = grimodex_db::profile_egress_policy::sql_policy_for_status();
        assert_eq!(status.sql_policy.version, policy.version);
        assert_eq!(status.sql_policy.protected_tables, policy.protected_tables);
        assert_eq!(
            status.sql_policy.protected_columns,
            policy.protected_columns
        );
        let json = serde_json::to_value(status).expect("status JSON");
        assert_eq!(json["sqlPolicy"]["version"], policy.version);
        assert!(json["sqlPolicy"]["protectedTables"].is_array());
        assert!(json["sqlPolicy"]["protectedColumns"].is_array());
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
    fn restore_only_workspace_binding_reauthorizes_recovery_then_requires_rebind() {
        let path = temp_path("recovery-binding");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity_a = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued-a".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 33,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state
            .register_caller(&identity_a)
            .expect("register workspace A caller");
        let permit = state.begin_dispatch(Some(&identity_a)).expect("dispatch A");

        // Safe Mode has no published DB authority, but Native must still
        // rotate the trusted recovery target before main can issue identity B.
        state.bind_recovery_workspace(Some("workspace-b".to_string()));
        assert!(permit.ensure_open().is_err());
        assert!(state.begin_dispatch(Some(&identity_a)).is_err());

        let identity_b = CallerIdentity {
            workspace_id: Some("workspace-b".to_string()),
            caller_id: "main-issued-b".to_string(),
            session_id: "session-b".to_string(),
            ..identity_a
        };
        state
            .register_caller(&identity_b)
            .expect("register restore-only target caller");
        state
            .begin_dispatch(Some(&identity_b))
            .map(drop)
            .expect("recovery-bound caller can dispatch");

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
    fn workspace_bind_revokes_a_permit_issued_before_the_swap() {
        let path = temp_path("permit-workspace-rebind");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 44,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before swap");
        state.bind_workspace(Some("workspace-b".to_string()));
        assert!(
            permit.ensure_open().is_err(),
            "workspace bind must revoke an already-issued permit"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn invalidate_callers_revokes_a_permit_during_a_pinned_operation() {
        let path = temp_path("permit-invalidate");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 45,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before invalidation");
        state.invalidate_callers();
        assert!(
            permit.ensure_open().is_err(),
            "caller invalidation must revoke an already-issued permit"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reauthorization_after_params_conversion_rejects_a_workspace_swap() {
        let path = temp_path("reauthorize-params-race");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 46,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before conversion");
        state
            .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
            .expect("pin reauthorization");
        let _converted_params = serde_json::json!(["converted"]);
        state.bind_workspace(Some("workspace-b".to_string()));
        assert!(
            state
                .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
                .is_err(),
            "a swap during parameter conversion must deny before SQL"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reauthorization_before_return_rejects_restore_on_the_same_path() {
        let path = temp_path("reauthorize-restore-race");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 47,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before serialization");
        state
            .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
            .expect("pin reauthorization");
        let _serialized_result = serde_json::json!({ "rows": [{ "id": "a" }] });
        // Restore may keep the same path. bind_workspace must still rotate
        // the process-local binding generation and invalidate the permit.
        state.bind_workspace(Some("workspace-a".to_string()));
        assert!(
            state
                .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
                .is_err(),
            "same-path restore must deny before returning the old result"
        );
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
