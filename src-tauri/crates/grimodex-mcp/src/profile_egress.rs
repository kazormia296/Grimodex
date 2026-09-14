//! Read-only consumer for the Native-owned profile egress authority.
//!
//! Electron Native owns and persists `profile-egress.json`.  Standalone MCP
//! must observe that same file, but it must not create a second authority or
//! write an exception into it.  The path is fixed to the packaged
//! OS/profile app-data root; the `--license-file` option remains a licensing
//! input only and cannot select a second egress authority.

use std::collections::HashMap;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use grimodex_core::profile_egress::{PublicationLease, PublicationLockMode, PROFILE_EGRESS_FILE};
use rmcp::model::{JsonRpcMessage, RequestId};
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use rmcp::{ErrorData, RoleServer};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

pub const D2A_EGRESS_DENIED_MARKER: &str = "D2A_EGRESS_DENIED:";

const STATE_VERSION: u32 = 2;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_PENDING_PUBLICATIONS: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProfileEgress {
    schema_version: u32,
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
    #[serde(default)]
    handles_invalidated: Option<bool>,
    #[serde(default)]
    in_flight_stopped: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProfileEgressSnapshot {
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
    handles_invalidated: bool,
    in_flight_stopped: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Observation {
    Valid(ProfileEgressSnapshot),
    Unavailable,
}

/// Consumer-side view of the profile authority.
///
/// This type never writes the authority.  A missing, malformed, inconsistent,
/// or unresolvable authority is represented as `Unavailable` and denied before
/// any workspace plaintext is returned.
pub struct ProfileEgressGuard {
    path: Option<PathBuf>,
    observation: Mutex<Observation>,
    session_invalidated: AtomicBool,
    pending_publications: Mutex<HashMap<RequestId, usize>>,
}

impl std::fmt::Debug for ProfileEgressGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProfileEgressGuard")
            .field("path", &self.path)
            .field("session_invalidated", &self.session_invalidated)
            .finish_non_exhaustive()
    }
}

/// Resolve the one canonical OS/profile authority.  Electron's packaged
/// userData path uses the same identifier.  Dev/custom userData has no
/// authenticated mapping here, so MCP remains closed there.
pub(crate) fn canonical_profile_path() -> Option<PathBuf> {
    dirs::data_dir().map(|data_dir| {
        data_dir
            .join(grimodex_core::license::APP_IDENTIFIER)
            .join(PROFILE_EGRESS_FILE)
    })
}

impl ProfileEgressGuard {
    pub(crate) fn canonical() -> Self {
        Self::from_path(canonical_profile_path())
    }

    /// Keep the licensing CLI argument at the server boundary, but never let
    /// it select the D2a profile authority.  This adapter is intentionally
    /// explicit so a launcher/config value cannot become a second authority.
    pub(crate) fn from_license_file(license_file: Option<&Path>) -> Self {
        let _ = license_file;
        Self::canonical()
    }

    fn from_path(path: Option<PathBuf>) -> Self {
        let observation = load_observation(path.as_deref());
        Self {
            path,
            observation: Mutex::new(observation),
            session_invalidated: AtomicBool::new(false),
            pending_publications: Mutex::new(HashMap::new()),
        }
    }

    /// Re-read the persistent authority.  `true` means the running session
    /// observed a changed or newly unavailable authority and must be stopped.
    pub(crate) fn refresh(&self) -> bool {
        let next = load_observation(self.path.as_deref());
        let mut current = match self.observation.lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        if *current == next {
            return false;
        }
        *current = next;
        self.session_invalidated.store(true, Ordering::Release);
        true
    }

    pub(crate) fn session_invalidated(&self) -> bool {
        self.session_invalidated.load(Ordering::Acquire)
    }

    /// Deny every profile plaintext read unless the persisted authority is a
    /// valid, complete restricted snapshot.  The refresh immediately before
    /// dispatch closes the file-replacement race between polling ticks.
    pub(crate) fn ensure_plaintext_allowed(&self) -> Result<(), ErrorData> {
        self.refresh();
        let current = match self.observation.lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        let allowed = !self.session_invalidated()
            && matches!(
                &*current,
                Observation::Valid(ProfileEgressSnapshot {
                    restricted: true,
                    handles_invalidated: true,
                    in_flight_stopped: true,
                    ..
                })
            );
        if allowed {
            Ok(())
        } else {
            Err(ErrorData::invalid_params(
                format!(
                    "{D2A_EGRESS_DENIED_MARKER} MCP plaintext is unavailable in profile local-only mode"
                ),
                None,
            ))
        }
    }

    /// Mark one workspace-plaintext response until the output transport is
    /// about to emit its complete JSON-RPC frame.
    pub(crate) fn register_publication(&self, id: RequestId) -> Result<(), ErrorData> {
        let mut pending = match self.pending_publications.lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        let pending_count = pending.values().copied().sum::<usize>();
        if pending_count >= MAX_PENDING_PUBLICATIONS {
            return Err(ErrorData::internal_error(
                "MCP plaintext publication queue is full".to_string(),
                None,
            ));
        }
        *pending.entry(id).or_insert(0) += 1;
        Ok(())
    }

    fn take_publication(&self, id: &RequestId) -> bool {
        let mut pending = match self.pending_publications.lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        let Some(count) = pending.get_mut(id) else {
            return false;
        };
        if *count == 1 {
            pending.remove(id);
        } else {
            *count -= 1;
        }
        true
    }

    pub(crate) fn discard_publication(&self, id: &RequestId) {
        let _ = self.take_publication(id);
    }

    async fn acquire_publication_shared(&self) -> io::Result<PublicationLease> {
        let Some(path) = self.path.clone() else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "canonical profile publication path is unavailable",
            ));
        };
        tokio::task::spawn_blocking(move || {
            PublicationLease::acquire(&path, PublicationLockMode::Shared)
        })
        .await
        .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?
    }

    /// Watch the same persistent state for the lifetime of one stdio session.
    /// A profile transition or authority loss cancels the rmcp service token,
    /// which closes the transport and invalidates all in-flight MCP calls.
    pub(crate) async fn watch(self: Arc<Self>, cancellation: CancellationToken) {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = interval.tick() => {
                    if self.refresh() {
                        tracing::warn!(
                            path = ?self.path,
                            "profile egress authority changed; stopping MCP session"
                        );
                        cancellation.cancel();
                        break;
                    }
                }
            }
        }
    }
}

/// Output-side linearization point for workspace plaintext.  Native's
/// exclusive lease cannot be acquired while this wrapper holds the shared
/// lease, so the recheck and complete framed write are one publication unit.
pub(crate) struct ProfileOutputTransport<T> {
    inner: T,
    guard: Arc<ProfileEgressGuard>,
}

impl<T> ProfileOutputTransport<T> {
    pub(crate) fn new(inner: T, guard: Arc<ProfileEgressGuard>) -> Self {
        Self { inner, guard }
    }
}

impl<T> Transport<RoleServer> for ProfileOutputTransport<T>
where
    T: Transport<RoleServer, Error = io::Error> + 'static,
{
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        let publication_id = match &item {
            JsonRpcMessage::Response(response) => Some(response.id.clone()),
            JsonRpcMessage::Error(error) => error.id.clone(),
            JsonRpcMessage::Request(_) | JsonRpcMessage::Notification(_) => None,
        };
        let gated = publication_id
            .as_ref()
            .is_some_and(|id| self.guard.take_publication(id));
        let guard = Arc::clone(&self.guard);
        // AsyncRwTransport's send future owns the framed writer lock.  It is
        // created before the async block but does no I/O until awaited.
        let send = self.inner.send(item);
        async move {
            let _publication_lease = if gated {
                let lease = guard.acquire_publication_shared().await?;
                guard.ensure_plaintext_allowed().map_err(|error| {
                    io::Error::new(io::ErrorKind::PermissionDenied, error.to_string())
                })?;
                Some(lease)
            } else {
                None
            };
            send.await
        }
    }

    fn receive(
        &mut self,
    ) -> impl std::future::Future<Output = Option<RxJsonRpcMessage<RoleServer>>> + Send {
        self.inner.receive()
    }

    fn close(&mut self) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        self.inner.close()
    }
}

fn load_observation(path: Option<&Path>) -> Observation {
    let Some(path) = path else {
        return Observation::Unavailable;
    };
    // Native publishes this file with an atomic replacement.  Refuse a
    // symlink (or any non-regular file) before reading and verify that the
    // pathname still names the same file afterwards.  Without this check a
    // client-controlled replacement could redirect the consumer to a second
    // authority between the path check and the JSON parse.
    let before = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Observation::Unavailable
        }
        Err(_) => return Observation::Unavailable,
    };
    if before.file_type().is_symlink() || !before.is_file() {
        return Observation::Unavailable;
    }
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Observation::Unavailable,
    };
    let after = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Observation::Unavailable,
    };
    if after.file_type().is_symlink() || !after.is_file() || !same_file_identity(&before, &after) {
        return Observation::Unavailable;
    }
    let Ok(saved) = serde_json::from_str::<PersistedProfileEgress>(&raw) else {
        return Observation::Unavailable;
    };
    if !matches!(saved.schema_version, 1 | STATE_VERSION)
        || saved.profile_id.trim().is_empty()
        || saved.profile_id != saved.profile_id.trim()
    {
        return Observation::Unavailable;
    }

    // Match Native's v1 compatibility defaults. For a non-restricted
    // snapshot, any invalidation bit or an unfinished stop barrier is
    // inconsistent and therefore fails closed rather than widening access.
    let handles_invalidated = saved.handles_invalidated.unwrap_or(saved.restricted);
    let in_flight_stopped = saved.in_flight_stopped.unwrap_or(saved.restricted);
    if !saved.restricted && (handles_invalidated || !in_flight_stopped) {
        return Observation::Unavailable;
    }

    Observation::Valid(ProfileEgressSnapshot {
        profile_id: saved.profile_id,
        caller_epoch: saved.caller_epoch,
        restricted: saved.restricted,
        handles_invalidated,
        in_flight_stopped,
    })
}

#[cfg(unix)]
fn same_file_identity(before: &Metadata, after: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    before.dev() == after.dev() && before.ino() == after.ino()
}

#[cfg(not(unix))]
fn same_file_identity(before: &Metadata, after: &Metadata) -> bool {
    // Windows and other platforms do not expose a portable inode pair in the
    // standard library.  The atomic Native writer changes both metadata and
    // the file length when replacing the authority, so retain the conservative
    // metadata check there as well; a mismatch is fail-closed.
    before.len() == after.len() && before.modified().ok() == after.modified().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_dir() -> (PathBuf, impl Drop) {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let path = std::env::temp_dir().join(format!(
            "grimodex-mcp-profile-egress-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("fixture directory");
        (path.clone(), Cleanup(path))
    }

    fn write_state(
        path: &Path,
        profile_id: &str,
        epoch: u64,
        restricted: bool,
        handles_invalidated: bool,
        in_flight_stopped: bool,
    ) {
        fs::write(
            path,
            serde_json::json!({
                "schemaVersion": STATE_VERSION,
                "profileId": profile_id,
                "callerEpoch": epoch,
                "restricted": restricted,
                "handlesInvalidated": handles_invalidated,
                "inFlightStopped": in_flight_stopped,
            })
            .to_string(),
        )
        .expect("write profile egress fixture");
    }

    #[test]
    fn canonical_authority_ignores_alternate_license_argument() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let guard = ProfileEgressGuard::from_license_file(Some(&license));
        assert_eq!(guard.path, canonical_profile_path());
        assert!(guard
            .path
            .as_deref()
            .is_some_and(|path| path.ends_with(Path::new(PROFILE_EGRESS_FILE))));
        assert!(
            guard
                .path
                .as_deref()
                .is_none_or(|path| !path.starts_with(&directory)),
            "an untrusted --license-file path must not select the authority"
        );
    }

    #[test]
    fn missing_authority_denies_plaintext() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        let missing = ProfileEgressGuard::from_path(Some(profile));
        assert!(missing.ensure_plaintext_allowed().is_err());
    }

    #[test]
    fn malformed_authority_denies_plaintext() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        fs::write(&profile, "not-json").expect("write malformed fixture");
        let guard = ProfileEgressGuard::from_path(Some(profile));
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[test]
    fn forged_unrestricted_authority_denies_plaintext() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 1, false, false, true);
        let guard = ProfileEgressGuard::from_path(Some(profile));
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[test]
    fn complete_restricted_authority_allows_plaintext() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 1, true, true, true);
        let guard = ProfileEgressGuard::from_path(Some(profile));
        assert!(guard.ensure_plaintext_allowed().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_authority_fails_closed_even_when_target_is_valid() {
        use std::os::unix::fs::symlink;

        let (directory, _cleanup) = fixture_dir();
        let target = directory.join("authority-target.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&target, "profile-1", 1, true, true, true);
        symlink(&target, &profile).expect("symlink fixture");

        let guard = ProfileEgressGuard::from_path(Some(profile));
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[test]
    fn restart_reads_the_same_restricted_epoch_without_widening_access() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 7, true, true, true);

        let first = ProfileEgressGuard::from_path(Some(profile.clone()));
        let second = ProfileEgressGuard::from_path(Some(profile));
        assert!(first.ensure_plaintext_allowed().is_ok());
        assert!(second.ensure_plaintext_allowed().is_ok());
        assert!(!first.session_invalidated());
        assert!(!second.session_invalidated());
    }

    #[test]
    fn pending_restriction_is_denied_before_stop_barrier_completes() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 2, true, true, false);

        let guard = ProfileEgressGuard::from_path(Some(profile));
        assert!(guard.ensure_plaintext_allowed().is_err());
        assert!(!guard.session_invalidated());
    }

    #[tokio::test]
    async fn already_running_session_is_invalidated_when_restriction_changes() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 1, true, true, true);
        let guard = Arc::new(ProfileEgressGuard::from_path(Some(profile.clone())));
        guard
            .ensure_plaintext_allowed()
            .expect("complete authority allows plaintext");

        let cancellation = CancellationToken::new();
        let watcher = tokio::spawn(Arc::clone(&guard).watch(cancellation.clone()));
        write_state(&profile, "profile-1", 2, false, false, true);
        tokio::time::timeout(Duration::from_secs(2), cancellation.cancelled())
            .await
            .expect("authority transition cancels the running session");
        watcher.await.expect("watcher task completes");
        assert!(guard.session_invalidated());
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[tokio::test]
    async fn running_session_stops_when_authority_is_deleted() {
        let (directory, _cleanup) = fixture_dir();
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 1, true, true, true);
        let guard = Arc::new(ProfileEgressGuard::from_path(Some(profile.clone())));
        guard
            .ensure_plaintext_allowed()
            .expect("complete authority allows plaintext");

        let cancellation = CancellationToken::new();
        let watcher = tokio::spawn(Arc::clone(&guard).watch(cancellation.clone()));
        fs::remove_file(&profile).expect("delete authority fixture");
        tokio::time::timeout(Duration::from_secs(2), cancellation.cancelled())
            .await
            .expect("publishing the authority cancels the legacy session");
        watcher.await.expect("watcher task completes");
        assert!(guard.session_invalidated());
        assert!(guard.ensure_plaintext_allowed().is_err());
    }
}
