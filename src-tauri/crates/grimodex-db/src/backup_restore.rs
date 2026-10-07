//! Workspace backup listing and restore shared by the Tauri and Electron shells.
//!
//! This module owns the filesystem/SQLite state transition. Shells only inject
//! post-reopen cache invalidation through `restore_backup_core`'s callback.

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::narrative_extraction::ensure_restore_epochs_for_workspace;
use crate::open::{claim_workspace_maintenance_exclusive, SwitchingGuard};
use crate::state::{ActiveWorkspace, PinnedWorkspaceDb, WorkspaceAuthority, WorkspaceState};
use crate::workspace_lease;
use crate::Database;

const C2ZC_CONTENT_ADDRESSED_BACKUP_PREFIX: &str = "grimodex-c2zc-restore-fixture--sha256-";
const C2ZC_CONTENT_ADDRESSED_BACKUP_SUFFIX: &str = ".backup.db";

/// One restore candidate under `<workspace>/backups`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Basename passed back to `restore_backup_core`.
    pub file_name: String,
    pub size_bytes: u64,
    /// Modification time as milliseconds since Unix epoch.
    pub modified_ms: u64,
    /// `db` or `db.gz`.
    pub format: String,
}

pub struct InstallStagedOptions<'a> {
    pub detach_active_workspace: bool,
    pub publish_workspace_authority: bool,
    pub on_reopened: Option<Box<dyn FnOnce() + 'a>>,
    pub exclusive_lease: Option<workspace_lease::WorkspaceLease>,
    /// Stable digest of the materialized backup bytes, captured before
    /// preflight may rewrite SQLite page layout. Normal backup restores use
    /// this as the exactly-once Epoch identity seed.
    pub restore_source_digest: Option<String>,
    #[cfg(feature = "test-failpoints")]
    pub failpoint: Option<RestoreFailpoint>,
}

#[cfg(feature = "test-failpoints")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreFailpoint {
    AfterRollbackSnapshot,
    /// After live seal (checkpoint + sidecar removal) and before atomic replace.
    AfterLiveSeal,
    /// Simulate `atomic_replace` failure while holding exclusive + marker.
    FailAtomicReplace,
    AfterReplace,
    BeforeLiveVerify,
    LiveVerifyFailure,
    BeforeRestoreEpochMint,
    AfterRestoreEpochMint,
    /// Simulate restore-session marker finalization failure after publication.
    FailFinalizeMarker,
}

#[cfg(feature = "test-failpoints")]
impl RestoreFailpoint {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AfterRollbackSnapshot => "restore.after_rollback_snapshot",
            Self::AfterLiveSeal => "restore.after_live_seal",
            Self::FailAtomicReplace => "restore.fail_atomic_replace",
            Self::AfterReplace => "restore.after_replace",
            Self::BeforeLiveVerify => "restore.before_live_verify",
            Self::LiveVerifyFailure => "restore.live_verify_failure",
            Self::BeforeRestoreEpochMint => "restore.before_epoch_mint",
            Self::AfterRestoreEpochMint => "restore.after_epoch_mint",
            Self::FailFinalizeMarker => "restore.fail_finalize_marker",
        }
    }
}

impl<'a> InstallStagedOptions<'a> {
    pub fn normal_restore(on_reopened: impl FnOnce() + 'a) -> Self {
        Self {
            detach_active_workspace: true,
            publish_workspace_authority: true,
            on_reopened: Some(Box::new(on_reopened)),
            exclusive_lease: None,
            restore_source_digest: None,
            #[cfg(feature = "test-failpoints")]
            failpoint: None,
        }
    }

    #[cfg(feature = "test-failpoints")]
    pub fn normal_restore_with_failpoint(
        on_reopened: impl FnOnce() + 'a,
        failpoint: RestoreFailpoint,
    ) -> Self {
        Self {
            detach_active_workspace: true,
            publish_workspace_authority: true,
            on_reopened: Some(Box::new(on_reopened)),
            exclusive_lease: None,
            restore_source_digest: None,
            failpoint: Some(failpoint),
        }
    }

    pub fn safe_mode(exclusive_lease: workspace_lease::WorkspaceLease) -> Self {
        Self {
            detach_active_workspace: false,
            publish_workspace_authority: false,
            on_reopened: None,
            exclusive_lease: Some(exclusive_lease),
            restore_source_digest: None,
            #[cfg(feature = "test-failpoints")]
            failpoint: None,
        }
    }

    #[cfg(feature = "test-failpoints")]
    pub fn safe_mode_with_failpoint(
        exclusive_lease: workspace_lease::WorkspaceLease,
        failpoint: RestoreFailpoint,
    ) -> Self {
        Self {
            detach_active_workspace: false,
            publish_workspace_authority: false,
            on_reopened: None,
            exclusive_lease: Some(exclusive_lease),
            restore_source_digest: None,
            failpoint: Some(failpoint),
        }
    }
}

/// List backups for the active workspace. A missing backups directory is an
/// empty list; an unopened workspace is the shared `No workspace is open`
/// error contract.
pub fn list_backups(ws_state: &WorkspaceState) -> AppResult<Vec<BackupInfo>> {
    let dir = {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        inner
            .as_ref()
            .ok_or(AppError::NoWorkspace)?
            .path()
            .join("backups")
    };
    Ok(list_backups_in(&dir))
}

/// Collect `grimodex-*.db` and `grimodex-*.db.gz` regular files, newest first.
/// Staging files, directories, and symlinks are excluded.
pub fn list_backups_in(dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((is_gz, _expected_digest)) = parse_backup_file_name(&name) else {
            continue;
        };
        let format = if is_gz { "db.gz" } else { "db" };
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        out.push(BackupInfo {
            file_name: name,
            size_bytes: meta.len(),
            modified_ms,
            format: format.to_string(),
        });
    }
    out.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    out
}

/// Replace the active workspace DB with a selected backup.
///
/// `on_reopened` runs after the restored database has opened successfully and
/// its authority has become active. Each shell injects invalidation for its
/// DB-derived in-memory caches here.
pub fn restore_backup_core(
    ws_state: &WorkspaceState,
    file_name: &str,
    on_reopened: impl FnOnce(),
) -> AppResult<()> {
    // Serialize against open_workspace and concurrent restores.
    let open_guard = ws_state
        .open_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    restore_backup_core_with_open_lock(ws_state, &open_guard, file_name, on_reopened)
}

/// Restore while the caller already owns `WorkspaceState::open_lock`.
///
/// The Electron maintenance owner must close admission before it begins the
/// restore, but it must also acquire the shared open lock before doing so. A
/// separate entry point lets that owner keep the same guard through the
/// replacement without recursively locking `restore_backup_core`.
pub fn restore_backup_core_with_open_lock(
    ws_state: &WorkspaceState,
    _open_guard: &std::sync::MutexGuard<'_, ()>,
    file_name: &str,
    on_reopened: impl FnOnce(),
) -> AppResult<()> {
    let ws_path = {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        inner
            .as_ref()
            .ok_or(AppError::NoWorkspace)?
            .path()
            .to_path_buf()
    };
    let (source, is_gz, expected_source_digest) = open_backup_source(&ws_path, file_name)?;

    let db_path = ws_path.join("grimodex.db");
    // Remove the legacy fixed-name staging file without following symlinks.
    // New restores use an unpredictable create_new path below.
    cleanup_path_best_effort(&sidecar(&db_path, ".restore-tmp"));

    let (staged_plain, mut staged_output) = create_unique_sidecar(&db_path, "restore")?;
    let mut staged_cleanup = CleanupPath::new(staged_plain.clone());
    if let Err(error) = materialize_backup(source, is_gz, &mut staged_output) {
        drop(staged_output);
        return Err(error);
    }
    if let Err(error) = staged_output.sync_all() {
        drop(staged_output);
        return Err(anyhow::anyhow!("復元DBの同期に失敗しました: {error}").into());
    }
    drop(staged_output);
    let restore_source_digest = crate::migration_supervisor::digest_sha256_file(&staged_plain)
        .map_err(|error| anyhow::anyhow!("RESTORE_CANDIDATE_DIGEST_FAILED: {error}"))?;
    if let Some(expected) = expected_source_digest.as_deref() {
        if restore_source_digest != expected {
            return Err(anyhow::anyhow!(
                "C2ZC_RESTORE_SOURCE_DIGEST_MISMATCH: expected={expected} actual={restore_source_digest}"
            )
            .into());
        }
    }
    verify_sqlite_ok(&staged_plain)?;

    // `quick_check` alone accepts valid SQLite files from a schema version this
    // app cannot migrate. Migrate the disposable staged copy before touching
    // the live DB so an incompatible backup leaves the current session intact.
    preflight_candidate(&staged_plain)?;

    let mut install_options = InstallStagedOptions::normal_restore(on_reopened);
    install_options.restore_source_digest = Some(restore_source_digest);
    let result = install_staged_workspace_db(ws_state, &ws_path, &staged_plain, install_options);
    if result.is_ok() {
        staged_cleanup.disarm();
    }
    result
}

pub enum LiveSafetyArtifact {
    /// Consistent SQLite image that includes committed WAL frames (VACUUM INTO).
    LogicalDb { path: PathBuf },
    /// Raw main+wal+shm copies when the live DB cannot be opened as SQLite.
    ForensicBundle { dir: PathBuf },
}

#[derive(Debug, Clone)]
enum RestoreRollbackSource {
    LogicalImage(PathBuf),
    /// Forensic bundles are retained for Recovery Shell; never auto-applied.
    ForensicImage {
        dir: PathBuf,
    },
}

impl LiveSafetyArtifact {
    pub fn retained_path(&self) -> &Path {
        match self {
            Self::LogicalDb { path } => path,
            Self::ForensicBundle { dir } => dir,
        }
    }

    fn kind_str(&self) -> &'static str {
        match self {
            Self::LogicalDb { .. } => "logical",
            Self::ForensicBundle { .. } => "forensic",
        }
    }

    fn rollback_source(&self) -> RestoreRollbackSource {
        match self {
            Self::LogicalDb { path } => RestoreRollbackSource::LogicalImage(path.clone()),
            Self::ForensicBundle { dir } => {
                RestoreRollbackSource::ForensicImage { dir: dir.clone() }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionMarker {
    pub version: u32,
    pub phase: String,
    pub safety_artifact: String,
    pub safety_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_artifact: Option<String>,
    pub installed_digest: String,
    pub workspace_identity: String,
}

pub fn restore_session_marker_path(workspace: &Path) -> PathBuf {
    workspace.join("backups").join(".restore-session.json")
}

/// Incomplete restore session left on disk — open must not publish authority.
pub fn read_incomplete_restore_session(
    workspace: &Path,
) -> AppResult<Option<RestoreSessionMarker>> {
    let path = restore_session_marker_path(workspace);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let marker: RestoreSessionMarker = serde_json::from_slice(&bytes)
                .map_err(|error| anyhow::anyhow!("RESTORE_SESSION_MARKER_INVALID: {error}"))?;
            Ok(Some(marker))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(anyhow::anyhow!("RESTORE_SESSION_MARKER_READ_FAILED: {error}").into()),
    }
}

pub fn clear_restore_session_marker(workspace: &Path) -> AppResult<()> {
    let path = restore_session_marker_path(workspace);
    match remove_path_no_follow(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!("RESTORE_SESSION_MARKER_CLEAR_FAILED: {error}").into()),
    }
}

/// Terminal restore-session marker phase: the session finished (install
/// committed and authority handled, or the original image was verifiably
/// restored) and only the marker unlink is still outstanding. The next open
/// verifies the workspace identity and converges to deletion instead of
/// reporting a false `RESTORE_SESSION_INCOMPLETE` Safe Mode.
pub const RESTORE_SESSION_PHASE_COMMITTED: &str = "committed";

/// Finish a restore session's marker as a commit protocol rather than a
/// fire-and-forget unlink. `.restore-session.json` gates the next workspace
/// open into Safe Mode, so silently ignoring a failed unlink after reporting
/// success to the user creates a durable self-contradiction. When the unlink
/// fails, escalate the marker to the durable `committed` phase (an atomic
/// rename that does not require unlink) so the next open can verify and
/// safely converge to deletion.
///
/// When neither step can complete — the unlink failed *and* the marker can
/// be neither read nor rewritten to `committed` — this returns an error:
/// the restored data is intact, but the caller must not report a clean
/// success while the next open is guaranteed to enter Safe Mode over a
/// stale incomplete marker.
fn finalize_restore_session_marker(ws_path: &Path) -> AppResult<()> {
    let Err(clear_error) = clear_restore_session_marker(ws_path) else {
        return Ok(());
    };
    let rewritten = match read_incomplete_restore_session(ws_path) {
        Ok(Some(mut marker)) => {
            marker.phase = RESTORE_SESSION_PHASE_COMMITTED.to_string();
            write_restore_session_marker(ws_path, &marker)
        }
        Ok(None) => Ok(()),
        Err(read_error) => Err(read_error),
    };
    match rewritten {
        Ok(()) => {
            tracing::warn!(
                "restore-session marker could not be removed ({clear_error}); escalated to a durable committed marker so the next open converges to deletion"
            );
            Ok(())
        }
        Err(write_error) => Err(anyhow::anyhow!(
            "RESTORE_SESSION_MARKER_FINALIZE_FAILED: restore-session marker could not be \
             removed ({clear_error}) nor committed ({write_error}); the restored image is \
             installed, but the next open would enter Safe Mode until \
             backups/.restore-session.json is deleted"
        )
        .into()),
    }
}

fn write_restore_session_marker(workspace: &Path, marker: &RestoreSessionMarker) -> AppResult<()> {
    let backups = workspace.join("backups");
    std::fs::create_dir_all(&backups).map_err(anyhow::Error::from)?;
    let path = restore_session_marker_path(workspace);
    let tmp = backups.join(format!(".restore-session-{}.tmp", uuid::Uuid::new_v4()));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(anyhow::Error::from)?;
        serde_json::to_writer_pretty(&mut file, marker).map_err(anyhow::Error::from)?;
        file.sync_all().map_err(anyhow::Error::from)?;
    }
    std::fs::rename(&tmp, &path).map_err(anyhow::Error::from)?;
    // Best-effort directory fsync so the rename is durable across crash.
    if let Ok(dir) = File::open(&backups) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Capture a persistent pre-restore safety artifact **before** mutating live
/// sidecars. Prefer a logical VACUUM INTO snapshot (WAL frames included); fall
/// back to a raw db+wal+shm forensic bundle when SQLite cannot open the live image.
pub fn create_persistent_live_safety_artifact(
    workspace: &Path,
    db_path: &Path,
) -> AppResult<LiveSafetyArtifact> {
    let backups_dir = workspace.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(anyhow::Error::from)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");

    let logical = backups_dir.join(format!("grimodex-pre-restore-{stamp}.db"));
    match vacuum_live_into(db_path, &logical) {
        Ok(_) => {
            sync_path(&logical)?;
            verify_sqlite_ok(&logical)?;
            Ok(LiveSafetyArtifact::LogicalDb { path: logical })
        }
        Err(logical_error) => {
            cleanup_path_best_effort(&logical);
            tracing::warn!(
                "restore: logical live safety snapshot failed ({logical_error}); writing forensic bundle"
            );
            let dir = backups_dir.join(format!("grimodex-pre-restore-{stamp}.forensic"));
            std::fs::create_dir_all(&dir).map_err(anyhow::Error::from)?;
            copy_raw_sqlite_forensic_bundle(db_path, &dir)?;
            Ok(LiveSafetyArtifact::ForensicBundle { dir })
        }
    }
}

fn vacuum_live_into(db_path: &Path, dest: &Path) -> AppResult<()> {
    // Do **not** TRUNCATE-checkpoint the live DB first — callers must keep
    // WAL-only commits recoverable on live until after this snapshot succeeds.
    let conn = rusqlite::Connection::open(db_path).map_err(anyhow::Error::from)?;
    if dest.exists() {
        std::fs::remove_file(dest).map_err(anyhow::Error::from)?;
    }
    let dest_str = dest
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("safety artifact path is not valid UTF-8"))?;
    conn.execute("VACUUM INTO ?1", rusqlite::params![dest_str])
        .map_err(anyhow::Error::from)?;
    Ok(())
}

fn copy_raw_sqlite_forensic_bundle(db_path: &Path, dir: &Path) -> AppResult<()> {
    let dest_db = dir.join("grimodex.db");
    std::fs::copy(db_path, &dest_db).map_err(anyhow::Error::from)?;
    sync_path(&dest_db)?;
    for suffix in ["-wal", "-shm"] {
        let src = sidecar(db_path, suffix);
        match std::fs::symlink_metadata(&src) {
            Ok(meta) if meta.file_type().is_file() => {
                let dest = dir.join(format!("grimodex.db{suffix}"));
                std::fs::copy(&src, &dest).map_err(anyhow::Error::from)?;
                sync_path(&dest)?;
            }
            Ok(_) => {
                return Err(anyhow::anyhow!(
                    "RESTORE_FORENSIC_SIDECAR_NOT_FILE: {}",
                    src.display()
                )
                .into());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(anyhow::anyhow!(
                    "RESTORE_FORENSIC_SIDECAR_STAT_FAILED: {}: {error}",
                    src.display()
                )
                .into());
            }
        }
    }
    let meta_path = dir.join("forensic-meta.json");
    let meta = serde_json::json!({
        "version": 1,
        "sourceMain": db_path.display().to_string(),
        "capturedAt": chrono::Utc::now().to_rfc3339(),
    });
    std::fs::write(
        &meta_path,
        serde_json::to_vec_pretty(&meta).map_err(anyhow::Error::from)?,
    )
    .map_err(anyhow::Error::from)?;
    sync_path(&meta_path)?;
    Ok(())
}

fn sync_path(path: &Path) -> AppResult<()> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(anyhow::Error::from)?;
    file.sync_all().map_err(anyhow::Error::from)?;
    Ok(())
}

pub fn install_staged_workspace_db(
    ws_state: &WorkspaceState,
    ws_path: &Path,
    staged_plain: &Path,
    mut options: InstallStagedOptions<'_>,
) -> AppResult<()> {
    if !options.publish_workspace_authority && options.on_reopened.is_some() {
        return Err(anyhow::anyhow!("restore install callback requires publish").into());
    }

    let db_path = ws_path.join("grimodex.db");
    let backups_dir = ws_path.join("backups");
    // A C2-ZC marker is an authority boundary, not ordinary backup payload.
    // Never replace a live Generic-authority workspace with an older
    // pre-cutover image and silently make legacy projection Freshness current
    // again.  Capture the published authority before candidate preparation;
    // normal restore can read its pinned connection, while Safe Mode has no
    // published handle and is checked from the quiescent live image below.
    let live_c2zc_marker = read_live_c2zc_marker_for_restore(ws_state, &db_path)?;

    // 1) Seal and prepare the candidate before detaching the live authority.
    // Every restore — normal and Safe Mode recovery alike — mints the
    // deterministic restore Epoch on this staged image, before the live image
    // is replaced. Restore is a Semantic Epoch generation boundary regardless
    // of how the workspace gets there: without the staged mint, a Safe Mode
    // recovery would re-publish the backup's stale Epochs, Edge State, and
    // Consumer Freshness as current on the next normal open. The pre-Epoch
    // digest is the stable input to a domain-separated identity; retrying the
    // same backup then observes the same identity and does not rotate twice.
    // Safe Mode passes the digest captured from the materialized image before
    // its mutating preflight. Direct callers retain the historical fallback
    // of hashing the staged image at this boundary.
    let restore_seed = match options.restore_source_digest.as_deref() {
        Some(digest) => digest.to_string(),
        None => crate::migration_supervisor::digest_sha256_file(staged_plain)
            .map_err(|error| anyhow::anyhow!("RESTORE_CANDIDATE_DIGEST_FAILED: {error}"))?,
    };
    if let Err(error) = crate::migration_supervisor::seal_sqlite_image(staged_plain) {
        return Err(anyhow::anyhow!(
            "復元候補の seal に失敗したため中止しました（live未置換）: {error}"
        )
        .into());
    }
    let restore_identity = format!(
        "restore-image-sha256:{}",
        restore_seed
            .strip_prefix("sha256:")
            .unwrap_or(restore_seed.as_str())
    );
    #[cfg(feature = "test-failpoints")]
    hit_restore_failpoint(options.failpoint, RestoreFailpoint::BeforeRestoreEpochMint)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let installed = {
        let staged_database = Database::new(staged_plain)
            .map_err(|error| anyhow::anyhow!("RESTORE_STAGED_DB_OPEN_FAILED: {error}"))?;
        let staged_c2zc_marker = staged_database
            .with_conn(Database::read_c2zc_cutover_marker)
            .map_err(|error| {
                anyhow::anyhow!("NEX_C2ZC_RESTORE_CANDIDATE_MARKER_READ_FAILED: {error}")
            })?;
        ensure_restore_c2zc_authority_not_downgraded(live_c2zc_marker, staged_c2zc_marker)?;
        ensure_restore_epochs_for_workspace(&staged_database, &restore_identity)
            .map_err(|error| anyhow::anyhow!("RESTORE_EPOCH_MINT_FAILED: {error}"))?;
        if let Err(error) = staged_database.rebuild_fts_if_stale() {
            tracing::warn!("restore: staged FTS rebuild after Epoch mint failed: {error}");
        }
        drop(staged_database);
        crate::migration_supervisor::seal_sqlite_image(staged_plain)
            .map_err(|error| anyhow::anyhow!("RESTORE_STAGED_EPOCH_SEAL_FAILED: {error}"))?;
        crate::migration_supervisor::installed_image_token_from_sealed(
            staged_plain,
            grimodex_core::SCHEMA_VERSION,
            None,
        )
        .map_err(|error| anyhow::anyhow!("RESTORE_STAGED_EPOCH_DIGEST_FAILED: {error}"))?
    };
    #[cfg(feature = "test-failpoints")]
    hit_restore_failpoint(options.failpoint, RestoreFailpoint::AfterRestoreEpochMint)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;

    // Detached backup maintenance owns an independent SQLite connection, so
    // `wait_for_sole_owner(old.db)` cannot observe it. Wait for the path-scoped
    // worker lease before detaching the active handle, and keep the exclusive
    // claim through sidecar removal, replacement, rollback, and reopen. The
    // candidate preflight above remains parallel with maintenance.
    let _maintenance_claim = if options.detach_active_workspace {
        Some(claim_workspace_maintenance_exclusive(ws_path)?)
    } else {
        None
    };

    // Quiesce new DB access before detaching the active handle. This closes the
    // write-loss window between the safety snapshot and replacement.
    ws_state
        .switching
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _switching_guard = SwitchingGuard(&ws_state.switching);
    let detached_active = if options.detach_active_workspace {
        let old = {
            let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
            inner.take()
        };
        let old = old.ok_or(AppError::NoWorkspace)?;

        if let Err(error) = wait_for_sole_owner(&old.authority) {
            let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
            *inner = Some(old);
            return Err(error);
        }

        // Best-effort user-visible gzip remains optional; mandatory WAL-preserving
        // safety is created below under exclusive lease before sidecar removal.
        if let Err(error) = std::fs::create_dir_all(&backups_dir) {
            tracing::warn!("restore: cannot create backups dir for safety copy: {error}");
        } else {
            let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");
            let safety = backups_dir.join(format!("grimodex-{timestamp}.db.gz"));
            if let Err(error) = old.authority.db().backup_to(&safety) {
                tracing::warn!("restore: pre-restore safety backup failed (continuing): {error}");
            }
        }

        // Drop the last authority owner so Windows releases the live file
        // handle, and release the shared workspace lease before exclusive work.
        drop(old);
        true
    } else {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        if inner.is_some() {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_AUTHORITY_STILL_PUBLISHED: refuse Safe Mode restore while Database authority exists"
            )));
        }
        false
    };

    let exclusive_lease = match options.exclusive_lease.take() {
        Some(exclusive) => exclusive,
        None => match workspace_lease::acquire_exclusive_for_migration(ws_path) {
            Ok(exclusive) => exclusive,
            Err(error) => {
                return Err(abort_install(
                    ws_state,
                    &db_path,
                    ws_path,
                    detached_active,
                    anyhow::anyhow!("復元用 exclusive lease を取得できませんでした: {error}"),
                ));
            }
        },
    };

    let live_exists = match std::fs::symlink_metadata(&db_path) {
        Ok(meta) if meta.file_type().is_file() => true,
        Ok(_) => {
            drop(exclusive_lease);
            return Err(abort_install(
                ws_state,
                &db_path,
                ws_path,
                detached_active,
                anyhow::anyhow!(
                    "復元対象のlive DBが通常ファイルではありません: {}",
                    db_path.display()
                ),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            drop(exclusive_lease);
            return Err(abort_install(
                ws_state,
                &db_path,
                ws_path,
                detached_active,
                anyhow::anyhow!("復元対象のlive DBを確認できませんでした: {error}"),
            ));
        }
    };

    // 2) Persistent WAL-preserving safety artifact (retained after success).
    let safety_artifact = if live_exists {
        match create_persistent_live_safety_artifact(ws_path, &db_path) {
            Ok(artifact) => Some(artifact),
            Err(error) => {
                drop(exclusive_lease);
                return Err(abort_install(
                    ws_state,
                    &db_path,
                    ws_path,
                    detached_active,
                    anyhow::anyhow!(
                        "RESTORE_LIVE_SAFETY_FAILED: live変更前の安全コピー作成に失敗しました: {error}"
                    ),
                ));
            }
        }
    } else {
        None
    };

    #[cfg(feature = "test-failpoints")]
    if options.failpoint == Some(RestoreFailpoint::AfterRollbackSnapshot) {
        drop(exclusive_lease);
        return Err(abort_install(
            ws_state,
            &db_path,
            ws_path,
            detached_active,
            anyhow::anyhow!(
                "RESTORE_FAILPOINT: {}",
                RestoreFailpoint::AfterRollbackSnapshot.as_str()
            ),
        ));
    }

    // 3) Prepare rollback source from the retained safety artifact.
    let rollback_source = safety_artifact
        .as_ref()
        .map(|artifact| artifact.rollback_source());
    let (rollback_path, mut rollback_cleanup) =
        if let Some(RestoreRollbackSource::LogicalImage(source)) = rollback_source.as_ref() {
            let (rollback_path, mut rollback_output) =
                match create_unique_sidecar(&db_path, "rollback") {
                    Ok(created) => created,
                    Err(error) => {
                        drop(exclusive_lease);
                        return Err(abort_install(
                            ws_state,
                            &db_path,
                            ws_path,
                            detached_active,
                            anyhow::anyhow!("{error}"),
                        ));
                    }
                };
            let rollback_cleanup = CleanupPath::new(rollback_path.clone());
            if let Err(error) = copy_path_into(source, &mut rollback_output) {
                drop(rollback_output);
                drop(exclusive_lease);
                return Err(abort_install(
                    ws_state,
                    &db_path,
                    ws_path,
                    detached_active,
                    anyhow::anyhow!("復元ロールバック用DBの作成に失敗しました: {error}"),
                ));
            }
            if let Err(error) = rollback_output.sync_all() {
                drop(rollback_output);
                drop(exclusive_lease);
                return Err(abort_install(
                    ws_state,
                    &db_path,
                    ws_path,
                    detached_active,
                    anyhow::anyhow!("復元ロールバック用DBの同期に失敗しました: {error}"),
                ));
            }
            drop(rollback_output);
            (Some(rollback_path), Some(rollback_cleanup))
        } else {
            (None, None)
        };

    // 4) Durable restore session marker *before* live seal / sidecar mutation.
    if let Some(artifact) = safety_artifact.as_ref() {
        let marker = RestoreSessionMarker {
            version: 1,
            phase: "epoch-minted".to_string(),
            safety_artifact: artifact.retained_path().display().to_string(),
            safety_kind: artifact.kind_str().to_string(),
            rollback_artifact: rollback_path
                .as_ref()
                .map(|path| path.display().to_string()),
            installed_digest: installed.digest.clone(),
            workspace_identity: crate::migration_supervisor::workspace_identity(ws_path),
        };
        if let Err(error) = write_restore_session_marker(ws_path, &marker) {
            drop(exclusive_lease);
            return Err(abort_install(
                ws_state,
                &db_path,
                ws_path,
                detached_active,
                anyhow::anyhow!("RESTORE_SESSION_MARKER_WRITE_FAILED: {error}"),
            ));
        }
    }

    // 5) Seal readable live (checkpoint WAL into main) or fail-closed sidecar
    // removal for forensic-only images.
    if live_exists {
        match safety_artifact.as_ref() {
            Some(LiveSafetyArtifact::LogicalDb { .. }) => {
                if let Err(error) = crate::migration_supervisor::seal_sqlite_image(&db_path)
                    .map_err(|e| anyhow::anyhow!("RESTORE_LIVE_SEAL_FAILED: {e}"))
                {
                    drop(exclusive_lease);
                    return Err(abort_install(
                        ws_state,
                        &db_path,
                        ws_path,
                        detached_active,
                        error,
                    ));
                }
            }
            Some(LiveSafetyArtifact::ForensicBundle { .. }) | None => {
                if let Err(error) = remove_db_sidecars(&db_path) {
                    drop(exclusive_lease);
                    return Err(abort_install(
                        ws_state,
                        &db_path,
                        ws_path,
                        detached_active,
                        anyhow::anyhow!(
                            "復元前のSQLite sidecar削除に失敗したため中止しました: {error}"
                        ),
                    ));
                }
            }
        }
    }

    #[cfg(feature = "test-failpoints")]
    if let Err(error) = hit_restore_failpoint(options.failpoint, RestoreFailpoint::AfterLiveSeal) {
        drop(exclusive_lease);
        return Err(abort_install(
            ws_state,
            &db_path,
            ws_path,
            detached_active,
            anyhow::anyhow!("{error}"),
        ));
    }

    // Digest of sealed live *before* replace — used when replace fails so CAS
    // compares against the pre-restore image, not the candidate digest.
    let pre_replace_live_digest = if live_exists {
        match crate::migration_supervisor::digest_sha256_file(&db_path) {
            Ok(digest) => Some(digest),
            Err(error) => {
                drop(exclusive_lease);
                return Err(abort_install(
                    ws_state,
                    &db_path,
                    ws_path,
                    detached_active,
                    anyhow::anyhow!("RESTORE_PRE_REPLACE_DIGEST_FAILED: {error}"),
                ));
            }
        }
    } else {
        None
    };

    let replace_error = {
        #[cfg(feature = "test-failpoints")]
        if options.failpoint == Some(RestoreFailpoint::FailAtomicReplace) {
            Some(io::Error::other(format!(
                "RESTORE_FAILPOINT: {}",
                RestoreFailpoint::FailAtomicReplace.as_str()
            )))
        } else {
            atomic_replace(staged_plain, &db_path).err()
        }
        #[cfg(not(feature = "test-failpoints"))]
        {
            atomic_replace(staged_plain, &db_path).err()
        }
    };

    if let Some(error) = replace_error {
        let primary_msg = format!("復元DBの適用に失敗しました: {error}");
        // Hold exclusive through digest check: live is usually still the sealed
        // pre-restore image. Compare against that digest — not the candidate.
        let (rollback_result, republish_unchanged_live): (AppResult<()>, bool) =
            match rollback_source.as_ref() {
                Some(RestoreRollbackSource::LogicalImage(_)) => {
                    match pre_replace_live_digest.as_deref() {
                        Some(expected) => {
                            match crate::migration_supervisor::live_digest_equals(
                                &db_path, expected,
                            ) {
                                Ok(true) => {
                                    if let Some(cleanup) = rollback_cleanup.as_mut() {
                                        cleanup.disarm();
                                    }
                                    let _ = finalize_restore_session_marker(ws_path);
                                    (
                                        Err(anyhow::anyhow!(
                                            "{primary_msg}; 元のDBは未置換のまま保持しています"
                                        )
                                        .into()),
                                        true,
                                    )
                                }
                                Ok(false) => {
                                    if let Some(cleanup) = rollback_cleanup.as_mut() {
                                        cleanup.disarm();
                                    }
                                    // Marker retained — Recovery Shell only.
                                    (
                                        Err(anyhow::anyhow!(
                                            "RESTORE_SESSION_LOST: {primary_msg}; live digest no longer matches pre-restore image"
                                        )
                                        .into()),
                                        false,
                                    )
                                }
                                Err(digest_error) => {
                                    if let Some(cleanup) = rollback_cleanup.as_mut() {
                                        cleanup.disarm();
                                    }
                                    (
                                        Err(anyhow::anyhow!(
                                            "RESTORE_SESSION_LOST: {primary_msg}; pre-restore digest check failed: {digest_error}"
                                        )
                                        .into()),
                                        false,
                                    )
                                }
                            }
                        }
                        None => (Err(anyhow::anyhow!("{primary_msg}").into()), false),
                    }
                }
                Some(RestoreRollbackSource::ForensicImage { .. }) => {
                    if let Some(cleanup) = rollback_cleanup.as_mut() {
                        cleanup.disarm();
                    }
                    (
                        Err(anyhow::anyhow!(
                            "RESTORE_FORENSIC_RECOVERY_REQUIRED: {primary_msg}; forensic artifact retained at {:?}; live left untouched",
                            safety_artifact.as_ref().map(|a| a.retained_path())
                        )
                        .into()),
                        false,
                    )
                }
                None => (Err(anyhow::anyhow!("{primary_msg}").into()), false),
            };
        drop(exclusive_lease);
        // Normal restore: re-publish sealed old DB only when replace never
        // landed and digest still matches the pre-restore image.
        if detached_active && republish_unchanged_live {
            if let Err(reactivate_error) = reactivate_workspace(ws_state, &db_path, ws_path) {
                return Err(anyhow::anyhow!(
                    "RESTORE_SESSION_LOST: {primary_msg}; 元DBの再オープンにも失敗しました: {reactivate_error}"
                )
                .into());
            }
        }
        return rollback_result;
    }

    let retained_safety = safety_artifact;

    #[cfg(feature = "test-failpoints")]
    if options.failpoint == Some(RestoreFailpoint::AfterReplace)
        || options.failpoint == Some(RestoreFailpoint::BeforeLiveVerify)
        || options.failpoint == Some(RestoreFailpoint::LiveVerifyFailure)
    {
        let point = options.failpoint.expect("failpoint set");
        park_restore_failpoint_if_requested(point)?;
        let code = point.as_str();
        let primary = format!("RESTORE_FAILPOINT: {code}");
        drop(exclusive_lease);
        return restore_rollback_error(RestoreRollbackArgs {
            ws_path,
            db_path: &db_path,
            rollback_path: rollback_path.as_deref(),
            rollback_cleanup: rollback_cleanup.as_mut(),
            rollback_source: rollback_source.as_ref(),
            safety_artifact: retained_safety.as_ref(),
            installed: &installed,
            conflict_code: "RESTORE_FAILPOINT",
            primary: &primary,
        });
    }

    match crate::migration_supervisor::installed_image_unchanged(&db_path, &installed) {
        Ok(true) => {}
        Ok(false) => {
            drop(exclusive_lease);
            return restore_rollback_error(RestoreRollbackArgs {
                ws_path,
                db_path: &db_path,
                rollback_path: rollback_path.as_deref(),
                rollback_cleanup: rollback_cleanup.as_mut(),
                rollback_source: rollback_source.as_ref(),
                safety_artifact: retained_safety.as_ref(),
                installed: &installed,
                conflict_code: "RESTORE_DIGEST_CONFLICT",
                primary: "復元DBのdigest検証に失敗しました",
            });
        }
        Err(error) => {
            let primary = format!("復元DBのdigest検証に失敗しました: {error}");
            drop(exclusive_lease);
            return restore_rollback_error(RestoreRollbackArgs {
                ws_path,
                db_path: &db_path,
                rollback_path: rollback_path.as_deref(),
                rollback_cleanup: rollback_cleanup.as_mut(),
                rollback_source: rollback_source.as_ref(),
                safety_artifact: retained_safety.as_ref(),
                installed: &installed,
                conflict_code: "RESTORE_DIGEST_CONFLICT",
                primary: &primary,
            });
        }
    }

    let _ = retained_safety;

    if !options.publish_workspace_authority {
        finalize_restore_session_marker(ws_path)?;
        drop(exclusive_lease);
        return Ok(());
    }

    match publish_active_workspace(ws_state, ws_path.to_path_buf(), exclusive_lease) {
        Ok(_) => {
            // Publication makes the restored authority live before marker
            // finalization. Invalidate shell caches immediately so a marker
            // cleanup failure cannot leave the live authority with stale
            // in-memory state.
            if let Some(on_reopened) = options.on_reopened.take() {
                on_reopened();
            }
            #[cfg(feature = "test-failpoints")]
            hit_restore_failpoint(options.failpoint, RestoreFailpoint::FailFinalizeMarker)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            finalize_restore_session_marker(ws_path)?;
            Ok(())
        }
        Err(restore_error) => {
            let restore_error_msg = restore_error.to_string();
            let rollback_installed =
                crate::migration_supervisor::installed_image_token_from_sealed(
                    &db_path,
                    grimodex_core::SCHEMA_VERSION,
                    None,
                )
                .unwrap_or_else(|_| installed.clone());
            match rollback_source.as_ref() {
                Some(RestoreRollbackSource::LogicalImage(_)) => {
                    let Some(rollback_path) = rollback_path.as_deref() else {
                        return Err(anyhow::anyhow!(
                            "RESTORE_SESSION_LOST: 復元DBを再オープンできず、live DB不在のためロールバック用DBもありません: restore={restore_error_msg}"
                        )
                        .into());
                    };
                    match crate::migration_supervisor::rollback_if_installed_image_unchanged(
                        ws_path,
                        &db_path,
                        rollback_path,
                        &rollback_installed,
                        "RESTORE_HANDOFF_CONFLICT",
                    ) {
                        Ok(exclusive) => {
                            if let Some(cleanup) = rollback_cleanup.as_mut() {
                                cleanup.disarm();
                            }
                            let _ = finalize_restore_session_marker(ws_path);
                            match publish_active_workspace(
                                ws_state,
                                ws_path.to_path_buf(),
                                exclusive,
                            ) {
                                Ok(_) => Err(anyhow::anyhow!(
                                    "復元DBを再オープンできなかったため元のDBへ戻しました: {restore_error_msg}"
                                )
                                .into()),
                                Err(reactivate_error) => Err(anyhow::anyhow!(
                                    "RESTORE_SESSION_LOST: 復元DBの適用失敗後、元のDBも再オープンできませんでした: restore={restore_error_msg}; rollback={reactivate_error}"
                                )
                                .into()),
                            }
                        }
                        Err(conflict) => {
                            if let Some(cleanup) = rollback_cleanup.as_mut() {
                                cleanup.disarm();
                            }
                            Err(anyhow::anyhow!(
                                "RESTORE_SESSION_LOST: 復元DBを再オープンできず、CASロールバックにも失敗しました。ロールバック用DBは {rollback_path:?} に保持しています: restore={restore_error_msg}; rollback={conflict}"
                            )
                            .into())
                        }
                    }
                }
                Some(RestoreRollbackSource::ForensicImage { .. }) => {
                    if let Some(cleanup) = rollback_cleanup.as_mut() {
                        cleanup.disarm();
                    }
                    Err(anyhow::anyhow!(
                        "RESTORE_FORENSIC_RECOVERY_REQUIRED: publish failed ({restore_error_msg}); forensic artifact retained"
                    )
                    .into())
                }
                None => Err(anyhow::anyhow!(
                    "RESTORE_SESSION_LOST: 復元DBを再オープンできず、ロールバック用DBもありません: restore={restore_error_msg}"
                )
                .into()),
            }
        }
    }
}

/// Read the current C2-ZC authority marker without detaching it.  A normal
/// restore uses the exact active SQLite handle so WAL state cannot make a
/// filesystem reread stale; Safe Mode has deliberately unpublished the handle
/// and therefore reads the quiescent on-disk database instead.
fn read_live_c2zc_marker_for_restore(
    ws_state: &WorkspaceState,
    db_path: &Path,
) -> AppResult<Option<i64>> {
    let active_authority = {
        let inner = ws_state
            .inner
            .lock()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        inner.as_ref().map(|active| Arc::clone(&active.authority))
    };
    if let Some(authority) = active_authority {
        return authority
            .db()
            .with_conn(Database::read_c2zc_cutover_marker)
            .map_err(|error| {
                anyhow::anyhow!("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: {error}").into()
            });
    }
    // Safe Mode must not follow a symlink while sampling the previous
    // authority marker.  The later install path independently enforces the
    // same regular-file invariant, but the preflight read occurs before that
    // guard and must not make the restore decision from an arbitrary target.
    match std::fs::symlink_metadata(db_path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Err(anyhow::anyhow!(
                "NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: live DB is not a regular file: {}",
                db_path.display()
            )
            .into())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow::anyhow!(
                "NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: cannot inspect live DB: {error}"
            )
            .into())
        }
    }
    let conn = match rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(conn) => conn,
        Err(error) if is_corrupt_sqlite_error(&error) => {
            tracing::warn!(
                "restore: Safe Mode live DB is corrupt while reading C2-ZC marker; treating it as having no prior authority: {error}"
            );
            return Ok(None);
        }
        Err(error) => {
            return Err(anyhow::anyhow!("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: {error}").into())
        }
    };
    let marker_table_exists: bool = match conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
              WHERE type = 'table' AND name = 'schema_data_migrations'
         )",
        [],
        |row| row.get(0),
    ) {
        Ok(exists) => exists,
        Err(error) if is_corrupt_sqlite_error(&error) => {
            tracing::warn!(
                "restore: Safe Mode live DB is corrupt while reading sqlite_master; treating it as having no prior C2-ZC authority: {error}"
            );
            return Ok(None);
        }
        Err(error) => {
            return Err(anyhow::anyhow!("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: {error}").into())
        }
    };
    if !marker_table_exists {
        let schema_version: i32 = match conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
        {
            Ok(version) => version,
            Err(error) if is_corrupt_sqlite_error(&error) => {
                tracing::warn!(
                    "restore: Safe Mode live DB is corrupt while reading user_version; treating it as having no prior C2-ZC authority: {error}"
                );
                return Ok(None);
            }
            Err(error) => {
                return Err(
                    anyhow::anyhow!("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: {error}").into(),
                )
            }
        };
        if (0..Database::SCHEMA_DATA_MIGRATIONS_INTRODUCED_SCHEMA_VERSION).contains(&schema_version)
        {
            // SCHEMA 0-22 predate both the marker table and the C2-ZC
            // activation authority, so absence is proof of pre-cutover rather
            // than an indeterminate read. At SCHEMA 23+ the table is a schema
            // invariant; a missing table remains fail-closed, including for a
            // future/foreign schema.
            return Ok(None);
        }
        return Err(anyhow::anyhow!(
            "NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: schema_data_migrations is unavailable for live schema version {schema_version}"
        )
        .into());
    }
    match Database::read_c2zc_cutover_marker(&conn) {
        Ok(marker) => Ok(marker),
        Err(error) if is_corrupt_sqlite_anyhow_error(&error) => {
            tracing::warn!(
                "restore: Safe Mode live DB is corrupt while reading C2-ZC marker row; treating it as having no prior authority: {error}"
            );
            Ok(None)
        }
        Err(error) => {
            Err(anyhow::anyhow!("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED: {error}").into())
        }
    }
}

fn is_corrupt_sqlite_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
}

fn is_corrupt_sqlite_anyhow_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .is_some_and(is_corrupt_sqlite_error)
    })
}

/// Compatibility policy for irreversible C2-ZC authority activation.
///
/// A staged marker may be absent only when the currently live workspace has
/// not cut over.  A future/foreign marker is not a safe substitute for the
/// current contract version, so it is rejected before any live seal or
/// authority publication.
fn ensure_restore_c2zc_authority_not_downgraded(
    live_marker: Option<i64>,
    staged_marker: Option<i64>,
) -> AppResult<()> {
    let current = Database::C2_ZC_CUTOVER_CONTRACT_VERSION;
    if let Some(version) = live_marker {
        if version != current {
            return Err(anyhow::anyhow!(
                "NEX_C2ZC_RESTORE_LIVE_MARKER_UNSUPPORTED: live marker contract version {version} is not current"
            )
            .into());
        }
    }
    if let Some(version) = staged_marker {
        if version != current {
            return Err(anyhow::anyhow!(
                "NEX_C2ZC_RESTORE_CANDIDATE_MARKER_UNSUPPORTED: staged marker contract version {version} is not current"
            )
            .into());
        }
    }
    if live_marker == Some(current) && staged_marker != Some(current) {
        return Err(anyhow::anyhow!(
            "NEX_C2ZC_RESTORE_AUTHORITY_DOWNGRADE_REJECTED: refusing to restore a pre-cutover backup over a live Generic Consumer Freshness authority"
        )
        .into());
    }
    Ok(())
}

fn abort_install(
    ws_state: &WorkspaceState,
    db_path: &Path,
    ws_path: &Path,
    detached_active: bool,
    primary: anyhow::Error,
) -> AppError {
    if detached_active {
        abort_after_detach(ws_state, db_path, ws_path, primary)
    } else {
        primary.into()
    }
}

struct RestoreRollbackArgs<'a> {
    ws_path: &'a Path,
    db_path: &'a Path,
    rollback_path: Option<&'a Path>,
    rollback_cleanup: Option<&'a mut CleanupPath>,
    rollback_source: Option<&'a RestoreRollbackSource>,
    safety_artifact: Option<&'a LiveSafetyArtifact>,
    installed: &'a crate::migration_supervisor::InstalledImageToken,
    conflict_code: &'a str,
    primary: &'a str,
}

fn restore_rollback_error(args: RestoreRollbackArgs<'_>) -> AppResult<()> {
    let RestoreRollbackArgs {
        ws_path,
        db_path,
        rollback_path,
        rollback_cleanup,
        rollback_source,
        safety_artifact,
        installed,
        conflict_code,
        primary,
    } = args;
    match rollback_source {
        Some(RestoreRollbackSource::ForensicImage { dir, .. }) => {
            // Prefer fail-closed: never auto-write forensic main/WAL/SHM onto
            // live without exclusive lease + digest CAS (cross-process Authority
            // race). Keep forensic + restore marker; Recovery Shell only.
            let _ = (db_path, installed, conflict_code, safety_artifact);
            if let Some(cleanup) = rollback_cleanup {
                cleanup.disarm();
            }
            Err(anyhow::anyhow!(
                "RESTORE_FORENSIC_RECOVERY_REQUIRED: {primary}; forensic artifact retained at {dir:?}; live left untouched — remain in Safe Mode"
            )
            .into())
        }
        Some(RestoreRollbackSource::LogicalImage(_)) | None => {
            let _ = safety_artifact;
            let Some(rollback_path) = rollback_path else {
                return Err(anyhow::anyhow!(
                    "RESTORE_SESSION_LOST: {primary}; live DB不在のためロールバック用DBもありません"
                )
                .into());
            };
            match crate::migration_supervisor::rollback_if_installed_image_unchanged(
                ws_path,
                db_path,
                rollback_path,
                installed,
                conflict_code,
            ) {
                Ok(exclusive) => {
                    drop(exclusive);
                    if let Some(cleanup) = rollback_cleanup {
                        cleanup.disarm();
                    }
                    let _ = finalize_restore_session_marker(ws_path);
                    Err(anyhow::anyhow!("{primary}; 元のDBへ戻しました").into())
                }
                Err(error) => {
                    if let Some(cleanup) = rollback_cleanup {
                        cleanup.disarm();
                    }
                    Err(anyhow::anyhow!(
                        "RESTORE_SESSION_LOST: {primary}; CASロールバックにも失敗しました。ロールバック用DBは {rollback_path:?} に保持しています: {error}"
                    )
                    .into())
                }
            }
        }
    }
}

#[cfg(feature = "test-failpoints")]
fn hit_restore_failpoint(
    configured: Option<RestoreFailpoint>,
    point: RestoreFailpoint,
) -> AppResult<()> {
    if configured == Some(point) {
        park_restore_failpoint_if_requested(point)?;
        return Err(anyhow::anyhow!("RESTORE_FAILPOINT: {}", point.as_str()).into());
    }
    Ok(())
}

#[cfg(feature = "test-failpoints")]
fn park_restore_failpoint_if_requested(point: RestoreFailpoint) -> AppResult<()> {
    use std::time::Duration;
    let Some(ready_path) = std::env::var_os("GRIMODEX_RESTORE_FAILPOINT_READY_PATH") else {
        return Ok(());
    };
    let ready_path = PathBuf::from(ready_path);
    std::fs::write(&ready_path, format!("{}\n", point.as_str())).map_err(anyhow::Error::from)?;
    sync_path(&ready_path)?;
    loop {
        std::thread::park_timeout(Duration::from_secs(3600));
    }
}

#[cfg(feature = "test-failpoints")]
thread_local! {
    static RESTORE_HANDOFF_PATHS: std::cell::RefCell<Option<(PathBuf, PathBuf)>> = const {
        std::cell::RefCell::new(None)
    };
}

/// Bind the test rendezvous only to this synchronous restore thread. Other
/// tests and child processes must not inherit its paths through global env.
#[cfg(feature = "test-failpoints")]
#[doc(hidden)]
pub fn with_restore_handoff_for_test<T>(
    ready_path: &Path,
    continue_path: &Path,
    operation: impl FnOnce() -> T,
) -> T {
    struct ClearHandoff;
    impl Drop for ClearHandoff {
        fn drop(&mut self) {
            RESTORE_HANDOFF_PATHS.with(|paths| *paths.borrow_mut() = None);
        }
    }
    RESTORE_HANDOFF_PATHS.with(|paths| {
        assert!(paths.borrow().is_none(), "restore handoff already bound");
        *paths.borrow_mut() = Some((ready_path.to_path_buf(), continue_path.to_path_buf()));
    });
    let _clear = ClearHandoff;
    operation()
}

/// Test-only rendezvous directly after the exclusive→shared handoff, before
/// authority publication: writes the ready file, then blocks until the
/// continue file appears. The subprocess handoff journey uses this window to
/// prove a concurrent shared writer's WAL survives the rest of the publish.
#[cfg(feature = "test-failpoints")]
fn wait_after_shared_handoff_if_requested() -> AppResult<()> {
    use std::time::{Duration, Instant};
    let Some((ready_path, continue_path)) =
        RESTORE_HANDOFF_PATHS.with(|paths| paths.borrow().clone())
    else {
        return Ok(());
    };
    std::fs::write(&ready_path, "after-shared-handoff\n").map_err(anyhow::Error::from)?;
    sync_path(&ready_path)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !continue_path.exists() {
        if Instant::now() >= deadline {
            return Err(anyhow::anyhow!("handoff continue file never appeared").into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn publish_active_workspace(
    ws_state: &WorkspaceState,
    ws_path: PathBuf,
    exclusive: workspace_lease::WorkspaceLease,
) -> AppResult<()> {
    // Every candidate-image write (Restore Epoch mint, FTS rebuild, seal,
    // installed-token capture, CAS verification) completed while the
    // exclusive restore boundary was held. After the shared handoff another
    // authority may legitimately write a new WAL at any time, so this
    // function must never seal, checkpoint, delete sidecars, or digest the
    // live image again — doing so raced newly written WAL frames away.
    let opened =
        crate::migration_supervisor::reopen_under_shared_lease_for_restore(&ws_path, exclusive)
            .map_err(|error| anyhow::anyhow!("workspace shared handoff after restore: {error}"))?;
    #[cfg(feature = "test-failpoints")]
    wait_after_shared_handoff_if_requested()?;
    let authority = std::sync::Arc::new(WorkspaceAuthority::new(
        opened.database,
        ws_path,
        opened.lease,
    ));
    let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    *inner = Some(ActiveWorkspace::new(authority));
    Ok(())
}

fn reactivate_workspace(
    ws_state: &WorkspaceState,
    db_path: &Path,
    ws_path: &Path,
) -> anyhow::Result<()> {
    let _ = db_path;
    // Shared lease + current-schema inspection only — never full migrate() DDL.
    let opened = crate::migration_supervisor::reopen_existing_current_authority(ws_path)
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    if let Err(error) = opened.database.rebuild_fts_if_stale() {
        tracing::warn!("restore: fts rebuild after reactivate failed: {error}");
    }
    let authority = std::sync::Arc::new(WorkspaceAuthority::new(
        opened.database,
        ws_path.to_path_buf(),
        opened.lease,
    ));
    let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    *inner = Some(ActiveWorkspace::new(authority));
    Ok(())
}

fn abort_after_detach(
    ws_state: &WorkspaceState,
    db_path: &Path,
    ws_path: &Path,
    primary: anyhow::Error,
) -> AppError {
    match reactivate_workspace(ws_state, db_path, ws_path) {
        Ok(()) => primary.into(),
        Err(reactivate_error) => anyhow::anyhow!(
            "RESTORE_SESSION_LOST: {primary}; 元DBの再オープンにも失敗しました: {reactivate_error}"
        )
        .into(),
    }
}

fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    let mut os = db_path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

struct CleanupPath {
    path: PathBuf,
    armed: bool,
}

impl CleanupPath {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupPath {
    fn drop(&mut self) {
        if self.armed {
            cleanup_path_best_effort(&self.path);
        }
    }
}

/// Remove a file or symlink itself, including a dangling symlink. Never follow
/// the link target (`Path::exists` would do so and miss dangling links).
fn remove_path_no_follow(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn cleanup_path_best_effort(path: &Path) {
    if let Err(error) = remove_path_no_follow(path) {
        tracing::warn!("restore: could not remove {path:?}: {error}");
    }
}

/// Reserve an unpredictable sibling path with create_new, closing the fixed
/// name/dangling-symlink escape that existed in the legacy implementation.
pub(crate) fn create_unique_sidecar(db_path: &Path, purpose: &str) -> AppResult<(PathBuf, File)> {
    for _ in 0..16 {
        let path = sidecar(db_path, &format!(".{purpose}-{}.tmp", uuid::Uuid::new_v4()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(
                    anyhow::anyhow!("復元用一時ファイルを作成できませんでした: {error}").into(),
                )
            }
        }
    }
    Err(anyhow::anyhow!("復元用一時ファイル名を確保できませんでした").into())
}

fn materialize_backup(input: File, is_gz: bool, output: &mut File) -> AppResult<()> {
    if is_gz {
        let mut decoder = GzDecoder::new(BufReader::new(input));
        io::copy(&mut decoder, output)
            .map_err(|e| anyhow::anyhow!("バックアップの解凍に失敗しました: {e}"))?;
    } else {
        let mut reader = BufReader::new(input);
        io::copy(&mut reader, output)
            .map_err(|e| anyhow::anyhow!("復元DBのステージングに失敗しました: {e}"))?;
    }
    Ok(())
}

pub(crate) fn materialize_candidate_to_plain(
    absolute_path: &Path,
    relative_key: &str,
    dest: &Path,
) -> AppResult<()> {
    let input = File::open(absolute_path).map_err(anyhow::Error::from)?;
    let is_gz = relative_key.ends_with(".db.gz");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(anyhow::Error::from)?;
    if let Err(error) = materialize_backup(input, is_gz, &mut output) {
        drop(output);
        cleanup_path_best_effort(dest);
        return Err(error);
    }
    if let Err(error) = output.sync_all() {
        drop(output);
        cleanup_path_best_effort(dest);
        return Err(anyhow::anyhow!("復元DBの同期に失敗しました: {error}").into());
    }
    drop(output);
    verify_materialized_backup_digest(relative_key, dest)?;
    Ok(())
}

/// Validate the optional content-addressed token after a candidate has been
/// copied from its already-open source handle.  Legacy backup names have no
/// token and retain their historical behavior.
pub(crate) fn verify_materialized_backup_digest(
    relative_key: &str,
    materialized_path: &Path,
) -> AppResult<String> {
    let parsed = parse_backup_file_name(relative_key);
    if parsed.is_none()
        && Path::new(relative_key)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(C2ZC_CONTENT_ADDRESSED_BACKUP_PREFIX))
    {
        cleanup_path_best_effort(materialized_path);
        return Err(anyhow::anyhow!(
            "C2ZC_RESTORE_SOURCE_DIGEST_INVALID: malformed content-addressed backup name: {relative_key}"
        )
        .into());
    }
    let actual = match crate::migration_supervisor::digest_sha256_file(materialized_path) {
        Ok(actual) => actual,
        Err(error) => {
            cleanup_path_best_effort(materialized_path);
            return Err(anyhow::anyhow!("RESTORE_CANDIDATE_DIGEST_FAILED: {error}").into());
        }
    };
    let Some((_is_gz, expected)) = parsed else {
        return Ok(actual);
    };
    let Some(expected) = expected else {
        return Ok(actual);
    };
    if actual != expected {
        cleanup_path_best_effort(materialized_path);
        return Err(anyhow::anyhow!(
            "C2ZC_RESTORE_SOURCE_DIGEST_MISMATCH: expected={expected} actual={actual}"
        )
        .into());
    }
    Ok(actual)
}

fn copy_path_into(src: &Path, output: &mut File) -> io::Result<()> {
    let mut reader = BufReader::new(File::open(src)?);
    io::copy(&mut reader, output)?;
    Ok(())
}

pub(crate) fn preflight_candidate(path: &Path) -> AppResult<()> {
    let result = (|| -> anyhow::Result<()> {
        let database = Database::new(path)?;
        database.migrate_for_restore_preflight()?;
        if let Err(error) = database.optimize() {
            tracing::warn!("PRAGMA optimize during restore preflight failed: {error}");
        }
        drop(database);
        crate::migration_supervisor::verify_migrated_db(path)?;
        Ok(())
    })();
    if let Err(error) = result {
        cleanup_path_best_effort(&sidecar(path, "-wal"));
        cleanup_path_best_effort(&sidecar(path, "-shm"));
        return Err(anyhow::anyhow!("このバックアップは現在のアプリで開けません: {error}").into());
    }
    remove_db_sidecars(path)
        .map_err(|e| anyhow::anyhow!("復元候補のSQLite sidecarを整理できませんでした: {e}"))?;
    Ok(())
}

pub(crate) fn remove_db_sidecars(db_path: &Path) -> io::Result<()> {
    remove_path_no_follow(&sidecar(db_path, "-wal"))?;
    remove_path_no_follow(&sidecar(db_path, "-shm"))?;
    Ok(())
}

/// Replace `destination` with a same-directory staged file using the
/// platform's atomic replacement primitive.
#[cfg(not(windows))]
pub fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(staged, destination)
}

#[cfg(windows)]
pub fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    if !destination.exists() {
        return std::fs::rename(staged, destination);
    }

    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let staged_wide: Vec<u16> = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call;
    // optional backup/exclude/reserved pointers are null as required.
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            staged_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn open_backup_source(ws_path: &Path, file_name: &str) -> AppResult<(File, bool, Option<String>)> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || !file_name.starts_with("grimodex-")
    {
        return Err(anyhow::anyhow!("不正なバックアップ名です: {file_name}").into());
    }
    let Some((is_gz, expected_source_digest)) = parse_backup_file_name(file_name) else {
        return Err(
            anyhow::anyhow!("この形式のバックアップは復元に対応していません: {file_name}").into(),
        );
    };
    let path = ws_path.join("backups").join(file_name);
    let initial_metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| anyhow::anyhow!("バックアップが見つかりません: {file_name}"))?;
    if !initial_metadata.file_type().is_file() {
        return Err(anyhow::anyhow!("バックアップが見つかりません: {file_name}").into());
    }
    let file = File::open(&path)
        .map_err(|_| anyhow::anyhow!("バックアップが見つかりません: {file_name}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| anyhow::anyhow!("バックアップを検証できません: {file_name}"))?;
    let current_metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| anyhow::anyhow!("バックアップが検証中に変更されました: {file_name}"))?;
    if !opened_metadata.file_type().is_file() || !current_metadata.file_type().is_file() {
        return Err(anyhow::anyhow!("バックアップが検証中に変更されました: {file_name}").into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if initial_metadata.dev() != opened_metadata.dev()
            || initial_metadata.ino() != opened_metadata.ino()
            || current_metadata.dev() != opened_metadata.dev()
            || current_metadata.ino() != opened_metadata.ino()
        {
            return Err(
                anyhow::anyhow!("バックアップが検証中に変更されました: {file_name}").into(),
            );
        }
    }

    Ok((file, is_gz, expected_source_digest))
}

/// Parse a user-visible backup basename once for listing, normal restore, and
/// Safe Mode recovery.  The optional C2-ZC token is deliberately narrow:
/// `grimodex-c2zc-restore-fixture--sha256-<64 lowercase hex>.backup.db`.
/// A token on `.db.gz` is rejected instead of being ambiguously interpreted
/// as the digest of compressed or materialized bytes.  Legacy names remain
/// accepted unchanged.
pub(crate) fn parse_backup_file_name(name: &str) -> Option<(bool, Option<String>)> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.starts_with("grimodex-")
    {
        return None;
    }
    let is_gz = name.ends_with(".db.gz");
    if !is_gz && !name.ends_with(".db") {
        return None;
    }
    if !name.starts_with(C2ZC_CONTENT_ADDRESSED_BACKUP_PREFIX) {
        return Some((is_gz, None));
    }
    if is_gz {
        return None;
    }
    let token = name
        .strip_prefix(C2ZC_CONTENT_ADDRESSED_BACKUP_PREFIX)?
        .strip_suffix(C2ZC_CONTENT_ADDRESSED_BACKUP_SUFFIX)?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    if token.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return None;
    }
    Some((false, Some(token.to_string())))
}

pub(crate) fn verify_sqlite_ok(path: &Path) -> AppResult<()> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| anyhow::anyhow!("バックアップを開けません: {e}"))?;
    let first: String = conn
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|e| anyhow::anyhow!("バックアップの整合性チェックに失敗しました: {e}"))?;
    if first != "ok" {
        return Err(anyhow::anyhow!("バックアップが破損しています: {first}").into());
    }
    Ok(())
}

pub(crate) fn wait_for_sole_owner(authority: &PinnedWorkspaceDb) -> AppResult<()> {
    for _ in 0..1000 {
        if Arc::strong_count(authority) == 1 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(anyhow::anyhow!(
        "実行中のDB操作が完了せず復元を中止しました。少し待って再試行してください。"
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::{
        canonical_work_key_for_epoch, AutomaticRunKind, REBUILD_DERIVED_WORK_KEY,
        VERIFY_WORK_KEY_PREFIX,
    };
    use crate::open::{
        spawn_workspace_maintenance_worker, try_claim_workspace_maintenance,
        workspace_maintenance_exclusive_waiters,
    };
    use crate::with_db_state;
    #[cfg(feature = "test-failpoints")]
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    fn fixture(label: &str) -> (PathBuf, WorkspaceState) {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-backup-restore-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(dir.join("backups")).expect("create fixture");
        let db = Database::new(&dir.join("grimodex.db")).expect("open fixture db");
        db.migrate().expect("migrate fixture db");
        let authority =
            WorkspaceAuthority::from_database_for_test(db, dir.clone()).expect("fixture authority");
        let state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace::new(authority))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: crate::WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: std::sync::Mutex::new(()),
        };
        (dir, state)
    }

    fn backup_active(state: &WorkspaceState, path: &Path) {
        with_db_state(state, |db| db.backup_to(path)).expect("write backup");
    }

    fn set_marker(state: &WorkspaceState, value: &str) {
        with_db_state(state, |db| {
            db.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('restore-test', ?)",
                &[serde_json::Value::String(value.to_string())],
                "run",
            )?;
            Ok(())
        })
        .expect("set marker");
    }

    fn marker(state: &WorkspaceState) -> String {
        with_db_state(state, |db| {
            let rows = db.execute(
                "SELECT value FROM app_settings WHERE key = 'restore-test'",
                &[],
                "get",
            )?;
            Ok(rows[0]["value"].as_str().unwrap_or_default().to_string())
        })
        .expect("read marker")
    }

    fn assert_no_internal_restore_files(dir: &Path) {
        let leftovers: Vec<String> = std::fs::read_dir(dir)
            .expect("read workspace")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".restore-") || name.contains(".rollback-"))
            .collect();
        assert!(leftovers.is_empty(), "restore leftovers: {leftovers:?}");
    }

    fn unpublished_workspace_state() -> WorkspaceState {
        WorkspaceState {
            inner: std::sync::Mutex::new(None),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: crate::WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: std::sync::Mutex::new(()),
        }
    }

    fn seed_markerless_live_schema(path: &Path, schema_version: i32) {
        let conn = rusqlite::Connection::open(path).expect("open markerless live database");
        conn.pragma_update(None, "user_version", schema_version)
            .expect("stamp markerless live schema version");
    }

    #[test]
    fn safe_mode_marker_read_accepts_known_pre_table_schema_versions() {
        for schema_version in [
            0,
            Database::SCHEMA_DATA_MIGRATIONS_INTRODUCED_SCHEMA_VERSION - 1,
        ] {
            let dir = std::env::temp_dir().join(format!(
                "grimodex-c2zc-pre-table-live-{schema_version}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create pre-table workspace");
            let db_path = dir.join("grimodex.db");
            seed_markerless_live_schema(&db_path, schema_version);

            let marker =
                read_live_c2zc_marker_for_restore(&unpublished_workspace_state(), &db_path)
                    .expect("known pre-table schema must be provably pre-cutover");
            assert_eq!(marker, None);

            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn safe_mode_marker_read_rejects_missing_table_outside_known_pre_table_range() {
        for schema_version in [
            -1,
            Database::SCHEMA_DATA_MIGRATIONS_INTRODUCED_SCHEMA_VERSION,
            grimodex_core::SCHEMA_VERSION,
            grimodex_core::SCHEMA_VERSION + 1,
        ] {
            let dir = std::env::temp_dir().join(format!(
                "grimodex-c2zc-missing-table-live-{schema_version}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create missing-table workspace");
            let db_path = dir.join("grimodex.db");
            seed_markerless_live_schema(&db_path, schema_version);

            let error = read_live_c2zc_marker_for_restore(&unpublished_workspace_state(), &db_path)
                .expect_err("missing marker table outside SCHEMA 0-22 must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED"),
                "unexpected error for schema {schema_version}: {error}"
            );

            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn list_backups_filters_and_serializes_supported_regular_files() {
        let dir =
            std::env::temp_dir().join(format!("grimodex-backup-list-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("grimodex-a.db"), b"db").expect("write db");
        std::fs::write(dir.join("grimodex-b.db.gz"), b"gzip").expect("write gz");
        std::fs::write(
            dir.join(format!(
                "grimodex-c2zc-restore-fixture--sha256-{}.backup.db",
                "a".repeat(64)
            )),
            b"content-addressed",
        )
        .expect("write content-addressed db");
        std::fs::write(
            dir.join("grimodex-c2zc-restore-fixture--sha256-ABC.backup.db"),
            b"malformed",
        )
        .expect("write malformed content-addressed db");
        std::fs::write(dir.join("grimodex-c.db.tmp"), b"tmp").expect("write tmp");
        std::fs::write(dir.join("other.db"), b"other").expect("write other");
        std::fs::create_dir(dir.join("grimodex-directory.db")).expect("mkdir candidate");

        let listed = list_backups_in(&dir);
        assert_eq!(listed.len(), 3);
        assert!(listed
            .iter()
            .any(|item| item.file_name == "grimodex-a.db" && item.format == "db"));
        assert!(listed
            .iter()
            .any(|item| item.file_name == "grimodex-b.db.gz" && item.format == "db.gz"));
        assert!(listed.iter().any(|item| {
            item.file_name
                == format!(
                    "grimodex-c2zc-restore-fixture--sha256-{}.backup.db",
                    "a".repeat(64)
                )
                && item.format == "db"
        }));
        for item in &listed {
            let json = serde_json::to_value(item).expect("serialize BackupInfo");
            assert!(json.get("fileName").is_some());
            assert!(json.get("sizeBytes").is_some());
            assert!(json.get("modifiedMs").is_some());
        }

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_and_restore_reject_when_workspace_is_not_open() {
        let state = WorkspaceState {
            inner: std::sync::Mutex::new(None),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: crate::WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: std::sync::Mutex::new(()),
        };
        assert!(list_backups(&state)
            .expect_err("list without workspace")
            .to_string()
            .contains("No workspace is open"));
        assert!(restore_backup_core(&state, "grimodex-a.db", || {})
            .expect_err("restore without workspace")
            .to_string()
            .contains("No workspace is open"));
    }

    #[test]
    fn open_backup_source_rejects_traversal_and_unsupported_names() {
        let ws = Path::new("/tmp/ws-does-not-matter");
        for bad in [
            "",
            "../grimodex.db",
            "grimodex-../x.db",
            "sub/grimodex-x.db",
            "grimodex\\x.db",
            "evil.db",
            "grimodex-x.db.tmp",
            "grimodex-c2zc-restore-fixture--sha256-ABC.db",
            "grimodex-c2zc-restore-fixture--sha256-{}.backup.db.gz",
            "grimodex-c2zc-restore-fixture--sha256-{}.backup.db",
        ] {
            assert!(open_backup_source(ws, bad).is_err(), "accepts {bad:?}");
        }
    }

    #[test]
    fn malformed_content_addressed_materialization_is_rejected_and_cleaned() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-backup-restore-content-addressed-malformed-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create malformed digest fixture");
        let materialized = dir.join("materialized.db");
        std::fs::write(&materialized, b"malformed candidate").expect("write materialized db");
        let error = verify_materialized_backup_digest(
            "grimodex-c2zc-restore-fixture--sha256-ABC.backup.db",
            &materialized,
        )
        .expect_err("malformed content-addressed name must reject");
        assert!(
            error
                .to_string()
                .contains("C2ZC_RESTORE_SOURCE_DIGEST_INVALID"),
            "unexpected malformed name error: {error}"
        );
        assert!(
            !materialized.exists(),
            "rejected materialization must be cleaned"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn content_addressed_restore_accepts_matching_bytes_and_rejects_materialized_digest_corruption()
    {
        let (dir, state) = fixture("content-addressed");
        set_marker(&state, "before-restore");
        let legacy_path = dir.join("backups/grimodex-c2zc-source.db");
        backup_active(&state, &legacy_path);
        let digest = crate::migration_supervisor::digest_sha256_file(&legacy_path)
            .expect("digest fixture backup");
        let matching_name = format!("grimodex-c2zc-restore-fixture--sha256-{digest}.backup.db");
        let matching_path = dir.join("backups").join(&matching_name);
        std::fs::rename(&legacy_path, &matching_path).expect("publish digest-bound backup");
        set_marker(&state, "after-backup");

        restore_backup_core(&state, &matching_name, || {}).expect("matching digest restores");
        assert_eq!(marker(&state), "before-restore");
        assert_no_internal_restore_files(&dir);

        let mismatch_dir = std::env::temp_dir().join(format!(
            "grimodex-backup-restore-content-addressed-mismatch-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(mismatch_dir.join("backups")).expect("create mismatch fixture");
        let mismatch_db =
            Database::new(&mismatch_dir.join("grimodex.db")).expect("open mismatch fixture db");
        mismatch_db.migrate().expect("migrate mismatch fixture db");
        let mismatch_authority =
            WorkspaceAuthority::from_database_for_test(mismatch_db, mismatch_dir.clone())
                .expect("mismatch fixture authority");
        let mismatch_state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace::new(mismatch_authority))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: crate::WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: std::sync::Mutex::new(()),
        };
        set_marker(&mismatch_state, "mismatch-live");
        let mismatch_source = mismatch_dir.join("backups/mismatch-source.db");
        backup_active(&mismatch_state, &mismatch_source);
        let mismatch_digest = crate::migration_supervisor::digest_sha256_file(&mismatch_source)
            .expect("digest mismatch fixture backup");
        let mismatch_name =
            format!("grimodex-c2zc-restore-fixture--sha256-{mismatch_digest}.backup.db");
        let mismatch_path = mismatch_dir.join("backups").join(&mismatch_name);
        std::fs::rename(&mismatch_source, &mismatch_path)
            .expect("publish digest-bound backup before materialized corruption");
        // A candidate with valid content-addressed naming but corrupted bytes
        // must fail before the native restore can replace the live DB.
        std::fs::write(&mismatch_path, b"corrupted-materialized-candidate")
            .expect("corrupt published digest-bound candidate bytes");
        let error = restore_backup_core(&mismatch_state, &mismatch_name, || {})
            .expect_err("mismatched digest must reject before live replacement");
        assert!(
            error
                .to_string()
                .contains("C2ZC_RESTORE_SOURCE_DIGEST_MISMATCH"),
            "unexpected mismatch error: {error}"
        );
        assert_eq!(marker(&mismatch_state), "mismatch-live");
        assert_no_internal_restore_files(&mismatch_dir);

        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(mismatch_dir);
    }

    #[test]
    fn plain_restore_reverts_live_state_runs_hook_and_keeps_safety_copy() {
        let (dir, state) = fixture("plain");
        set_marker(&state, "v1");
        let backup_name = "grimodex-20200101-000000.db";
        backup_active(&state, &dir.join("backups").join(backup_name));
        set_marker(&state, "v2");

        let hook_called = AtomicBool::new(false);
        restore_backup_core(&state, backup_name, || {
            hook_called.store(true, Ordering::SeqCst);
        })
        .expect("restore plain backup");

        assert_eq!(marker(&state), "v1");
        assert!(hook_called.load(Ordering::SeqCst));
        assert!(!state.switching.load(Ordering::SeqCst));
        assert!(list_backups(&state).expect("list safety copies").len() >= 2);
        assert!(!dir.join("grimodex.db.restore-tmp").exists());
        assert_no_internal_restore_files(&dir);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn finalize_marker_failpoint_keeps_restored_authority_and_runs_hook_once() {
        let (dir, state) = fixture("finalize-marker-failpoint");
        set_marker(&state, "before-restore");
        let staged = dir.join("staged-fail-finalize.db");
        backup_active(&state, &staged);
        set_marker(&state, "live-after-backup");

        let hook_calls = AtomicUsize::new(0);
        let error = install_staged_workspace_db(
            &state,
            &dir,
            &staged,
            InstallStagedOptions::normal_restore_with_failpoint(
                || {
                    hook_calls.fetch_add(1, Ordering::SeqCst);
                },
                RestoreFailpoint::FailFinalizeMarker,
            ),
        )
        .expect_err("finalize marker failpoint must report an error");
        assert!(
            error.to_string().contains("restore.fail_finalize_marker"),
            "unexpected error: {error}"
        );
        assert_eq!(hook_calls.load(Ordering::SeqCst), 1);
        assert_eq!(marker(&state), "before-restore");
        assert!(
            state.inner.lock().expect("workspace state lock").is_some(),
            "published restored authority must remain live"
        );
        assert!(
            !state.switching.load(Ordering::SeqCst),
            "switching guard must be released after failpoint"
        );
        let session = read_incomplete_restore_session(&dir)
            .expect("read restore session marker")
            .expect("restore session marker remains for recovery");
        assert_eq!(session.phase, "epoch-minted");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_waits_for_detached_workspace_maintenance_before_detaching_live_db() {
        let (dir, state) = fixture("maintenance-barrier");
        set_marker(&state, "before-backup");
        let backup_name = "grimodex-20200101-000000.db";
        backup_active(&state, &dir.join("backups").join(backup_name));
        set_marker(&state, "live-after-backup");

        // Hold the private production worker at a deterministic start gate with
        // its real path claim and detached SQLite connection alive.
        with_db_state(&state, |db| {
            db.execute(
                "INSERT OR REPLACE INTO app_settings (key, value)
                 VALUES ('data.autoBackup', 'false')",
                &[],
                "run",
            )?;
            Ok(())
        })
        .expect("disable fixture auto backup");
        let (maintenance_started_tx, maintenance_started_rx) = std::sync::mpsc::channel();
        let (release_maintenance_tx, release_maintenance_rx) = std::sync::mpsc::channel();
        let maintenance = spawn_workspace_maintenance_worker(
            &dir,
            &dir.join("global-settings.json"),
            move || {
                let _ = maintenance_started_tx.send(());
                let _ = release_maintenance_rx.recv();
            },
        )
        .expect("spawn production maintenance worker")
        .expect("maintenance claim");
        maintenance_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("maintenance owns detached connection");

        let state = Arc::new(state);
        let restore_state = Arc::clone(&state);
        let restore_dir = dir.clone();
        let hook_ran_under_claim = Arc::new(AtomicBool::new(false));
        let hook_flag = Arc::clone(&hook_ran_under_claim);
        let restore = std::thread::spawn(move || {
            restore_backup_core(&restore_state, backup_name, || {
                assert!(
                    try_claim_workspace_maintenance(&restore_dir).is_none(),
                    "restore must retain its exclusive claim through reopen"
                );
                hook_flag.store(true, Ordering::SeqCst);
            })
        });

        // Full-crate tests run many migration-heavy fixtures in parallel, so
        // allow preflight to reach the deterministic registry wait without a
        // one-second scheduling assumption.
        let wait_deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < wait_deadline {
            if workspace_maintenance_exclusive_waiters(&dir) == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(workspace_maintenance_exclusive_waiters(&dir), 1);
        assert!(!restore.is_finished(), "restore must wait for maintenance");
        assert!(
            !state.switching.load(Ordering::SeqCst),
            "restore must not detach the live DB while maintenance owns it"
        );
        assert_eq!(marker(&state), "live-after-backup");

        release_maintenance_tx
            .send(())
            .expect("release production maintenance worker");
        maintenance.join().expect("maintenance worker");
        restore
            .join()
            .expect("restore thread")
            .expect("restore after maintenance");

        assert!(hook_ran_under_claim.load(Ordering::SeqCst));
        assert_eq!(marker(&state), "before-backup");
        let post_restore_claim =
            try_claim_workspace_maintenance(&dir).expect("claim released after restore");
        drop(post_restore_claim);
        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn gzip_restore_reverts_live_state() {
        let (dir, state) = fixture("gzip");
        set_marker(&state, "v1");
        let backup_name = "grimodex-20200101-000000.db.gz";
        backup_active(&state, &dir.join("backups").join(backup_name));
        set_marker(&state, "v2");

        restore_backup_core(&state, backup_name, || {}).expect("restore gzip backup");

        assert_eq!(marker(&state), "v1");
        assert!(!dir.join("grimodex.db.restore-tmp").exists());
        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn normal_restore_rejects_pre_cutover_backup_over_live_generic_authority() {
        let (dir, state) = fixture("c2zc-authority-downgrade");
        let backup_name = "grimodex-20200101-000000.db";
        set_marker(&state, "before-cutover-backup");
        backup_active(&state, &dir.join("backups").join(backup_name));

        with_db_state(&state, |db| {
            db.with_conn(|conn| {
                Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z")
            })
        })
        .expect("activate live Generic authority");
        set_marker(&state, "live-generic-authority");

        let error = restore_backup_core(&state, backup_name, || {})
            .expect_err("pre-cutover backup must not downgrade live authority");
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_RESTORE_AUTHORITY_DOWNGRADE_REJECTED"),
            "unexpected restore error: {error}"
        );
        assert_eq!(marker(&state), "live-generic-authority");
        with_db_state(&state, |db| {
            db.with_conn(|conn| {
                assert_eq!(
                    Database::read_c2zc_cutover_marker(conn)?,
                    Some(Database::C2_ZC_CUTOVER_CONTRACT_VERSION)
                );
                Ok::<_, anyhow::Error>(())
            })
        })
        .expect("live marker remains published");
        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn safe_mode_restore_rejects_pre_cutover_backup_over_live_generic_authority() {
        let (dir, state) = fixture("c2zc-authority-downgrade-safe-mode");
        let staged_before_cutover = dir.join("backups/grimodex-before-cutover.db");
        backup_active(&state, &staged_before_cutover);

        with_db_state(&state, |db| {
            db.with_conn(|conn| {
                Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z")
            })
        })
        .expect("activate live Generic authority");

        // Safe Mode deliberately has no published database authority.  Drop
        // the old handle first so the restore check must inspect the
        // quiescent live image rather than relying on the normal-mode path.
        state.inner.lock().expect("workspace state lock").take();
        let lease = workspace_lease::acquire_exclusive_for_migration(&dir)
            .expect("Safe Mode exclusive lease");

        let error = install_staged_workspace_db(
            &state,
            &dir,
            &staged_before_cutover,
            InstallStagedOptions::safe_mode(lease),
        )
        .expect_err("Safe Mode must not downgrade live Generic authority");
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_RESTORE_AUTHORITY_DOWNGRADE_REJECTED"),
            "unexpected restore error: {error}"
        );

        let live = Database::new(&dir.join("grimodex.db")).expect("reopen live database");
        live.with_conn(|conn| {
            assert_eq!(
                Database::read_c2zc_cutover_marker(conn)?,
                Some(Database::C2_ZC_CUTOVER_CONTRACT_VERSION)
            );
            Ok::<_, anyhow::Error>(())
        })
        .expect("live Generic marker remains on disk");
        drop(live);
        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn normal_restore_mints_staged_epoch_and_same_image_retry_is_exactly_once() {
        let (dir, state) = fixture("restore-epoch-staged");
        with_db_state(&state, |db| {
            db.execute(
                "INSERT INTO projects (id, title) VALUES ('restore-project', 'Restore project')",
                &[],
                "seed restore project",
            )?;
            db.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('restore-project-initial', 'restore-project', 0, 'initial',
                         '2026-08-23T00:00:00.000Z')",
                &[],
                "seed restore epoch",
            )?;
            Ok(())
        })
        .expect("seed project and initial epoch");
        let backup_name = "grimodex-20200101-000000.db";
        backup_active(&state, &dir.join("backups").join(backup_name));
        set_marker(&state, "live-after-backup");

        restore_backup_core(&state, backup_name, || {}).expect("first normal restore");
        let first = with_db_state(&state, |db| {
            let rows = db.execute(
                "SELECT COUNT(*) AS total,
                        SUM(CASE WHEN reason = 'restore' THEN 1 ELSE 0 END) AS restores,
                        MAX(triggered_by_change_event_uid) AS identity,
                        MAX(CASE WHEN reason = 'restore' THEN id END) AS epoch_id
                   FROM narrative_semantic_epochs
                  WHERE project_id = 'restore-project'",
                &[],
                "read restore epochs",
            )?;
            Ok((
                rows[0]["total"].as_i64().unwrap_or_default(),
                rows[0]["restores"].as_i64().unwrap_or_default(),
                rows[0]["identity"].as_str().unwrap_or_default().to_string(),
                rows[0]["epoch_id"].as_str().unwrap_or_default().to_string(),
            ))
        })
        .expect("read first staged restore epoch");
        assert_eq!(first.0, 2);
        assert_eq!(first.1, 1);
        assert!(first.2.starts_with("restore-image-sha256:"));
        let first_epoch_id = uuid::Uuid::parse_str(&first.3).expect("restore epoch id is UUID");
        assert_eq!(first_epoch_id.as_bytes()[6] >> 4, 5);
        assert_eq!(first_epoch_id.as_bytes()[8] & 0xc0, 0x80);
        let first_rebuild_work = canonical_work_key_for_epoch(
            "restore-project",
            AutomaticRunKind::RebuildDerived,
            REBUILD_DERIVED_WORK_KEY,
            Some(&first.3),
        )
        .expect("canonical rebuild work coordinate");
        let first_verify_work = canonical_work_key_for_epoch(
            "restore-project",
            AutomaticRunKind::Verify,
            &format!("{VERIFY_WORK_KEY_PREFIX}{}", first.3),
            Some(&first.3),
        )
        .expect("canonical verify work coordinate");

        restore_backup_core(&state, backup_name, || {}).expect("retry same normal restore");
        let second = with_db_state(&state, |db| {
            let rows = db.execute(
                "SELECT COUNT(*) AS total,
                        SUM(CASE WHEN reason = 'restore' THEN 1 ELSE 0 END) AS restores,
                        MAX(triggered_by_change_event_uid) AS identity,
                        MAX(CASE WHEN reason = 'restore' THEN id END) AS epoch_id
                   FROM narrative_semantic_epochs
                  WHERE project_id = 'restore-project'",
                &[],
                "read retried restore epochs",
            )?;
            Ok((
                rows[0]["total"].as_i64().unwrap_or_default(),
                rows[0]["restores"].as_i64().unwrap_or_default(),
                rows[0]["identity"].as_str().unwrap_or_default().to_string(),
                rows[0]["epoch_id"].as_str().unwrap_or_default().to_string(),
            ))
        })
        .expect("read retried staged restore epoch");
        assert_eq!(second, first);
        let second_rebuild_work = canonical_work_key_for_epoch(
            "restore-project",
            AutomaticRunKind::RebuildDerived,
            REBUILD_DERIVED_WORK_KEY,
            Some(&second.3),
        )
        .expect("retried canonical rebuild work coordinate");
        let second_verify_work = canonical_work_key_for_epoch(
            "restore-project",
            AutomaticRunKind::Verify,
            &format!("{VERIFY_WORK_KEY_PREFIX}{}", second.3),
            Some(&second.3),
        )
        .expect("retried canonical verify work coordinate");
        assert_eq!(second_rebuild_work, first_rebuild_work);
        assert_eq!(second_verify_work, first_verify_work);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn normal_restore_epoch_failpoints_never_leave_live_image_epochless() {
        let (dir, state) = fixture("restore-epoch-failpoints");
        with_db_state(&state, |db| {
            db.execute(
                "INSERT INTO projects (id, title) VALUES ('restore-failpoint-project', 'Restore')",
                &[],
                "seed restore project",
            )?;
            db.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('restore-failpoint-initial', 'restore-failpoint-project', 0,
                         'initial', '2026-08-23T00:00:00.000Z')",
                &[],
                "seed restore epoch",
            )?;
            Ok(())
        })
        .expect("seed project and initial epoch");

        let staged_before = dir.join("candidate-before.db");
        backup_active(&state, &staged_before);
        let before = install_staged_workspace_db(
            &state,
            &dir,
            &staged_before,
            InstallStagedOptions::normal_restore_with_failpoint(
                || {},
                RestoreFailpoint::BeforeRestoreEpochMint,
            ),
        )
        .expect_err("before-mint failpoint must abort before detaching live");
        assert!(before.to_string().contains("restore.before_epoch_mint"));
        let live_epoch_count = with_db_state(&state, |db| {
            let rows = db.execute(
                "SELECT COUNT(*) AS n FROM narrative_semantic_epochs
                  WHERE project_id = 'restore-failpoint-project'",
                &[],
                "count live epochs",
            )?;
            Ok(rows[0]["n"].as_i64().unwrap_or_default())
        })
        .expect("live authority remains available");
        assert_eq!(live_epoch_count, 1);
        let _ = std::fs::remove_file(staged_before);

        let staged_after = dir.join("candidate-after.db");
        backup_active(&state, &staged_after);
        let after = install_staged_workspace_db(
            &state,
            &dir,
            &staged_after,
            InstallStagedOptions::normal_restore_with_failpoint(
                || {},
                RestoreFailpoint::AfterRestoreEpochMint,
            ),
        )
        .expect_err("after-mint failpoint must abort before live replacement");
        assert!(
            after.to_string().contains("restore.after_epoch_mint"),
            "unexpected after-mint error: {after}"
        );
        let (live_count, staged_count) = with_db_state(&state, |db| {
            let live = db.execute(
                "SELECT COUNT(*) AS n FROM narrative_semantic_epochs
                  WHERE project_id = 'restore-failpoint-project'",
                &[],
                "count live epochs",
            )?;
            let staged = Database::new(&staged_after)?;
            let staged = staged.execute(
                "SELECT COUNT(*) AS n FROM narrative_semantic_epochs
                  WHERE project_id = 'restore-failpoint-project'",
                &[],
                "count staged epochs",
            )?;
            Ok((
                live[0]["n"].as_i64().unwrap_or_default(),
                staged[0]["n"].as_i64().unwrap_or_default(),
            ))
        })
        .expect("compare live and staged images");
        assert_eq!(live_count, 1, "live image was not replaced");
        assert_eq!(staged_count, 2, "staged image contains the restore Epoch");
        let _ = std::fs::remove_file(staged_after);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_dangling_staging_symlink_is_unlinked_without_escape() {
        use std::os::unix::fs::symlink;

        let (dir, state) = fixture("dangling-stage");
        set_marker(&state, "v1");
        let backup_name = "grimodex-20200101-000000.db";
        backup_active(&state, &dir.join("backups").join(backup_name));
        set_marker(&state, "v2");

        let escaped_target = dir.join("must-not-be-created.db");
        let legacy_stage = dir.join("grimodex.db.restore-tmp");
        symlink(&escaped_target, &legacy_stage).expect("create dangling legacy symlink");
        assert!(
            !legacy_stage.exists(),
            "Path::exists follows dangling links"
        );
        assert!(std::fs::symlink_metadata(&legacy_stage).is_ok());

        restore_backup_core(&state, backup_name, || {}).expect("safe restore");

        assert_eq!(marker(&state), "v1");
        assert!(!escaped_target.exists(), "must not follow staging symlink");
        assert!(std::fs::symlink_metadata(&legacy_stage).is_err());
        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sidecar_cleanup_failure_is_reported() {
        let dir = std::env::temp_dir().join(format!("grimodex-sidecar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let db_path = dir.join("grimodex.db");
        std::fs::write(&db_path, b"db").expect("write db placeholder");
        std::fs::create_dir(sidecar(&db_path, "-wal")).expect("make undeletable-as-file WAL");

        assert!(remove_db_sidecars(&db_path).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_replace_failure_leaves_staged_file_without_copy_fallback() {
        let dir = std::env::temp_dir().join(format!("grimodex-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let staged = dir.join("staged.db");
        let destination = dir.join("grimodex.db");
        std::fs::write(&staged, b"new image").expect("write staged");
        std::fs::create_dir(&destination).expect("make destination non-file");

        let error = atomic_replace(&staged, &destination).expect_err("replace must fail");

        assert!(
            error.kind() == io::ErrorKind::IsADirectory
                || error.kind() == io::ErrorKind::PermissionDenied
                || error.kind() == io::ErrorKind::Other,
            "unexpected error kind: {error:?}"
        );
        assert_eq!(
            std::fs::read(&staged).expect("staged remains"),
            b"new image"
        );
        assert!(destination.is_dir());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn abort_after_detach_reopens_original_before_returning_ordinary_error() {
        let (dir, state) = fixture("abort-reactivate");
        set_marker(&state, "live");
        let old = state.inner.lock().expect("lock").take().expect("active");
        drop(old);

        let error = abort_after_detach(
            &state,
            &dir.join("grimodex.db"),
            &dir,
            anyhow::anyhow!("primary failure"),
        );

        assert!(!error.to_string().contains("RESTORE_SESSION_LOST:"));
        assert_eq!(marker(&state), "live");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn abort_after_detach_marks_session_lost_when_reopen_fails() {
        let (dir, state) = fixture("abort-lost");
        let old = state.inner.lock().expect("lock").take().expect("active");
        drop(old);
        std::fs::write(dir.join("grimodex.db"), b"not sqlite").expect("corrupt detached DB");

        let error = abort_after_detach(
            &state,
            &dir.join("grimodex.db"),
            &dir,
            anyhow::anyhow!("primary failure"),
        );

        assert!(error.to_string().contains("RESTORE_SESSION_LOST:"));
        assert!(error.to_string().contains("primary failure"));
        assert!(state.inner.lock().expect("lock").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_backup_is_rejected_without_touching_live_database() {
        let (dir, state) = fixture("corrupt");
        set_marker(&state, "live");
        let backup_name = "grimodex-20200101-000000.db";
        std::fs::write(
            dir.join("backups").join(backup_name),
            b"not a sqlite database at all",
        )
        .expect("write corrupt candidate");

        let error =
            restore_backup_core(&state, backup_name, || {}).expect_err("corrupt backup must fail");
        assert!(
            error.to_string().contains("整合性")
                || error.to_string().contains("バックアップ")
                || error.to_string().contains("database")
        );
        assert_eq!(marker(&state), "live");
        assert!(!state.switching.load(Ordering::SeqCst));
        assert!(dir.join("grimodex.db").is_file());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_rebuilds_fts_from_slim_backup() {
        let (dir, state) = fixture("fts");
        with_db_state(&state, |db| {
            db.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) \
                 VALUES ('c1','default-project','character','セラフ','古代の守護者スロウン','[]', datetime('now'), datetime('now'))",
                &[],
                "run",
            )?;
            Ok(())
        })
        .expect("seed codex");
        let backup_name = "grimodex-20200101-000000.db.gz";
        backup_active(&state, &dir.join("backups").join(backup_name));
        with_db_state(&state, |db| {
            db.execute("DELETE FROM codex_entries WHERE id = 'c1'", &[], "run")?;
            Ok(())
        })
        .expect("remove source row");

        restore_backup_core(&state, backup_name, || {}).expect("restore slim backup");

        let (content_count, fts_count) = with_db_state(&state, |db| {
            let content = db.execute(
                "SELECT count(*) AS n FROM codex_entries WHERE id = 'c1'",
                &[],
                "get",
            )?;
            let fts = db.execute(
                "SELECT count(*) AS n FROM codex_fts WHERE codex_fts MATCH 'スロウン'",
                &[],
                "get",
            )?;
            Ok((
                content[0]["n"].as_i64().unwrap_or(-1),
                fts[0]["n"].as_i64().unwrap_or(-1),
            ))
        })
        .expect("query restored FTS");
        assert_eq!((content_count, fts_count), (1, 1));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_incompatible_backup_is_rejected_before_live_replacement() {
        let (dir, state) = fixture("incompatible");
        set_marker(&state, "live");
        let source_path = dir.join("future.db");
        let source = Database::new(&source_path).expect("open source");
        source.migrate().expect("migrate source");
        source
            .with_conn(|conn| {
                conn.execute_batch(
                    "PRAGMA foreign_keys=OFF;
                     DROP TABLE projects;
                     CREATE TABLE projects (x INTEGER);",
                )?;
                Ok(())
            })
            .expect("make valid SQLite with incompatible schema");
        let backup_name = "grimodex-20200101-000000.db";
        source
            .backup_to(&dir.join("backups").join(backup_name))
            .expect("snapshot incompatible db");

        let hook_called = AtomicBool::new(false);
        let error = restore_backup_core(&state, backup_name, || {
            hook_called.store(true, Ordering::SeqCst);
        })
        .expect_err("preflight migration must reject candidate");

        assert!(
            error.to_string().contains("現在のアプリで開けません"),
            "unexpected error: {error}"
        );
        assert!(!hook_called.load(Ordering::SeqCst));
        assert!(state.inner.lock().expect("lock state").is_some());
        assert_eq!(marker(&state), "live");
        assert!(!state.switching.load(Ordering::SeqCst));
        assert_no_internal_restore_files(&dir);

        drop(source);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_of_schema_35_pre_a1_backup_backfills_existing_scenes_as_legacy_absent() {
        let (dir, state) = fixture("schema-35-pre-a1");
        let backup_name = "grimodex-20200101-000000.db";
        let backup_path = dir.join("backups").join(backup_name);

        with_db_state(&state, |db| {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('restore-legacy', 'Legacy scope')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, node_type, title, sort_order)
                     VALUES ('restore-legacy-scene', 'restore-legacy', 'scene', 'Scene', 'a0')",
                    [],
                )?;
                Ok(())
            })
        })
        .expect("seed a pre-A1 scene without a scope binding");
        backup_active(&state, &backup_path);

        // Model a historical schema-35 backup: the scene exists,
        // but A1's scope tables have not been introduced yet.
        let candidate = Database::new(&backup_path).expect("open backup candidate");
        candidate
            .with_conn(|conn| {
                conn.execute_batch(
                    "DROP TABLE narrative_scene_scope_bindings;
                     DROP TABLE narrative_scope_registries;",
                )?;
                // This is specifically pre-A1, not the moving previous schema.
                conn.pragma_update(None, "user_version", 35)?;
                let version: i32 =
                    conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
                assert_eq!(version, 35, "restore fixture must remain pre-A1");
                Ok(())
            })
            .expect("stamp schema-35 pre-A1 candidate");
        drop(candidate);

        restore_backup_core(&state, backup_name, || {})
            .expect("schema-35 restore must run the A1 compatibility backfill");

        with_db_state(&state, |db| {
            db.with_read_transaction(|conn| {
                let marker: String = conn.query_row(
                    "SELECT compatibility_marker
                       FROM narrative_scene_scope_bindings
                      WHERE project_id = 'restore-legacy'
                        AND scene_id = 'restore-legacy-scene'",
                    [],
                    |row| row.get(0),
                )?;
                let version: i32 =
                    conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
                assert_eq!(marker, "legacy-absent");
                assert_eq!(version, grimodex_core::SCHEMA_VERSION);
                Ok(())
            })
        })
        .expect("inspect restored legacy scope");

        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_of_current_a1_backup_with_missing_binding_remains_fail_closed() {
        let (dir, state) = fixture("missing-a1-binding");
        let backup_name = "grimodex-20200101-000000.db";
        let backup_path = dir.join("backups").join(backup_name);

        with_db_state(&state, |db| {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('restore-scope', 'Restore scope')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, node_type, title, sort_order)
                     VALUES ('restore-scope-scene', 'restore-scope', 'scene', 'Scene', 'a0')",
                    [],
                )?;
                crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                    conn,
                    "restore-scope",
                    "restore-scope-scene",
                    "2026-09-14T00:00:00.000Z",
                )?;
                Ok(())
            })
        })
        .expect("seed current A1 scope binding");
        backup_active(&state, &backup_path);

        // Make the candidate look like a current A1 backup with a damaged
        // binding row. The restore preflight must not reinterpret that damage
        // as the pre-A1 legacy state.
        let candidate = Database::new(&backup_path).expect("open backup candidate");
        candidate
            .with_conn(|conn| {
                conn.execute(
                    "DELETE FROM narrative_scene_scope_bindings
                      WHERE project_id = 'restore-scope' AND scene_id = 'restore-scope-scene'",
                    [],
                )?;
                Ok(())
            })
            .expect("remove candidate binding");
        drop(candidate);

        restore_backup_core(&state, backup_name, || {})
            .expect("current A1 restore must preserve the missing binding");

        with_db_state(&state, |db| {
            db.with_read_transaction(|conn| {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_scene_scope_bindings
                      WHERE project_id = 'restore-scope' AND scene_id = 'restore-scope-scene'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0, "restore must not synthesize a legacy binding");
                let error = crate::narrative_extraction::read_narrative_scene_scope(
                    conn,
                    "restore-scope",
                    "restore-scope-scene",
                )
                .expect_err("restored missing binding must remain unavailable");
                assert!(error
                    .to_string()
                    .contains("NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE"));
                Ok(())
            })
        })
        .expect("inspect restored fail-closed scope");

        assert_no_internal_restore_files(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}
