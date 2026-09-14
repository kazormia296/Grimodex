//! Read-only consumer for the Native-owned profile egress authority.
//!
//! Electron Native owns and persists `profile-egress.json`.  Standalone MCP
//! must observe that same file, but it must not create a second authority or
//! write an exception into it.  The path is derived from the established
//! `license.json` path so existing Electron-generated MCP configurations and
//! the legacy default executable path keep their current launch contract.

use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::ErrorData;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

pub const D2A_EGRESS_DENIED_MARKER: &str = "D2A_EGRESS_DENIED:";

const PROFILE_EGRESS_FILE: &str = "profile-egress.json";
const STATE_VERSION: u32 = 2;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

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
    /// No authority has ever been published at the established legacy path.
    /// This is the one compatibility case for a pre-D2a direct invocation.
    LegacyUnrestricted,
    Unavailable,
}

/// Consumer-side view of the profile authority.
///
/// This type never writes the authority.  A missing file at a known legacy
/// path is the only compatibility case that remains unrestricted: it proves
/// that this profile has not published the D2a authority yet.  A malformed,
/// inconsistent, or unresolvable authority is represented as `Unavailable`
/// and denied before any workspace plaintext is returned.
pub struct ProfileEgressGuard {
    path: Option<PathBuf>,
    observation: Mutex<Observation>,
    session_invalidated: AtomicBool,
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

/// Resolve the profile authority beside an already-resolved license file.
///
/// `license_file` is supplied by Electron main for its configured user-data
/// directory.  When the legacy executable resolves the default license path,
/// the same sibling convention points at the same profile state.  No new
/// command-line argument or alternate storage location is introduced.
pub(crate) fn profile_path_for_license(license_file: Option<&Path>) -> Option<PathBuf> {
    license_file
        .and_then(Path::parent)
        .map(|parent| parent.join(PROFILE_EGRESS_FILE))
}

impl ProfileEgressGuard {
    pub(crate) fn from_license_file(license_file: Option<&Path>) -> Self {
        let path = profile_path_for_license(license_file);
        let observation = load_observation(path.as_deref());
        Self {
            path,
            observation: Mutex::new(observation),
            session_invalidated: AtomicBool::new(false),
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
    /// valid, currently unrestricted snapshot.  The refresh immediately before
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
                Observation::LegacyUnrestricted
                    | Observation::Valid(ProfileEgressSnapshot {
                        restricted: false,
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
            return Observation::LegacyUnrestricted;
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

    // Match Native's v1 compatibility defaults.  For an unrestricted
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

    fn write_state(path: &Path, profile_id: &str, epoch: u64, restricted: bool) {
        let handles_invalidated = restricted;
        let in_flight_stopped = true;
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
    fn existing_mcp_config_resolves_the_authority_sibling() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        assert_eq!(
            profile_path_for_license(Some(&license)),
            Some(directory.join(PROFILE_EGRESS_FILE))
        );
    }

    #[test]
    fn missing_authority_preserves_legacy_unrestricted_start() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        let missing = ProfileEgressGuard::from_license_file(Some(&license));
        assert!(missing.ensure_plaintext_allowed().is_ok());

        fs::write(&profile, "{\"schemaVersion\":2,\"restricted\":false}")
            .expect("write inconsistent fixture");
        let inconsistent = ProfileEgressGuard::from_license_file(Some(&license));
        assert!(inconsistent.ensure_plaintext_allowed().is_err());
    }

    #[test]
    fn missing_authority_location_fails_closed() {
        let guard = ProfileEgressGuard::from_license_file(None);
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_authority_fails_closed_even_when_target_is_valid() {
        use std::os::unix::fs::symlink;

        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let target = directory.join("authority-target.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&target, "profile-1", 1, false);
        symlink(&target, &profile).expect("symlink fixture");

        let guard = ProfileEgressGuard::from_license_file(Some(&license));
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[test]
    fn restart_reads_the_same_restricted_epoch_without_widening_access() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 7, true);

        let first = ProfileEgressGuard::from_license_file(Some(&license));
        let second = ProfileEgressGuard::from_license_file(Some(&license));
        assert!(first.ensure_plaintext_allowed().is_err());
        assert!(second.ensure_plaintext_allowed().is_err());
        assert!(!first.session_invalidated());
        assert!(!second.session_invalidated());
    }

    #[test]
    fn pending_restriction_is_denied_before_stop_barrier_completes() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        fs::write(
            &profile,
            serde_json::json!({
                "schemaVersion": STATE_VERSION,
                "profileId": "profile-1",
                "callerEpoch": 2,
                "restricted": true,
                "handlesInvalidated": true,
                "inFlightStopped": false,
            })
            .to_string(),
        )
        .expect("write pending profile egress fixture");

        let guard = ProfileEgressGuard::from_license_file(Some(&license));
        assert!(guard.ensure_plaintext_allowed().is_err());
        assert!(!guard.session_invalidated());
    }

    #[tokio::test]
    async fn already_running_session_is_invalidated_when_restriction_changes() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        write_state(&profile, "profile-1", 1, false);
        let guard = Arc::new(ProfileEgressGuard::from_license_file(Some(&license)));
        guard
            .ensure_plaintext_allowed()
            .expect("unrestricted fixture allows plaintext");

        let cancellation = CancellationToken::new();
        let watcher = tokio::spawn(Arc::clone(&guard).watch(cancellation.clone()));
        write_state(&profile, "profile-1", 2, true);
        tokio::time::timeout(Duration::from_secs(2), cancellation.cancelled())
            .await
            .expect("authority transition cancels the running session");
        watcher.await.expect("watcher task completes");
        assert!(guard.session_invalidated());
        assert!(guard.ensure_plaintext_allowed().is_err());
    }

    #[tokio::test]
    async fn legacy_unrestricted_session_stops_when_authority_is_published() {
        let (directory, _cleanup) = fixture_dir();
        let license = directory.join("license.json");
        let profile = directory.join(PROFILE_EGRESS_FILE);
        let guard = Arc::new(ProfileEgressGuard::from_license_file(Some(&license)));
        guard
            .ensure_plaintext_allowed()
            .expect("missing authority keeps pre-D2a direct invocation usable");

        let cancellation = CancellationToken::new();
        let watcher = tokio::spawn(Arc::clone(&guard).watch(cancellation.clone()));
        write_state(&profile, "profile-1", 1, true);
        tokio::time::timeout(Duration::from_secs(2), cancellation.cancelled())
            .await
            .expect("publishing the authority cancels the legacy session");
        watcher.await.expect("watcher task completes");
        assert!(guard.session_invalidated());
        assert!(guard.ensure_plaintext_allowed().is_err());
    }
}
