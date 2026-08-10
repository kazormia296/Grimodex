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
use crate::open::{claim_workspace_maintenance_exclusive, SwitchingGuard};
use crate::state::{ActiveWorkspace, PinnedWorkspaceDb, WorkspaceAuthority, WorkspaceState};
use crate::workspace_lease;
use crate::Database;

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
    #[cfg(feature = "test-failpoints")]
    pub failpoint: Option<RestoreFailpoint>,
}

#[cfg(feature = "test-failpoints")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreFailpoint {
    AfterRollbackSnapshot,
    /// After live seal (checkpoint + sidecar removal) and before atomic replace.
    AfterLiveSeal,
    AfterReplace,
    BeforeLiveVerify,
    LiveVerifyFailure,
}

#[cfg(feature = "test-failpoints")]
impl RestoreFailpoint {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AfterRollbackSnapshot => "restore.after_rollback_snapshot",
            Self::AfterLiveSeal => "restore.after_live_seal",
            Self::AfterReplace => "restore.after_replace",
            Self::BeforeLiveVerify => "restore.before_live_verify",
            Self::LiveVerifyFailure => "restore.live_verify_failure",
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
            #[cfg(feature = "test-failpoints")]
            failpoint: None,
        }
    }

    pub fn safe_mode(exclusive_lease: workspace_lease::WorkspaceLease) -> Self {
        Self {
            detach_active_workspace: false,
            publish_workspace_authority: false,
            on_reopened: None,
            exclusive_lease: Some(exclusive_lease),
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
        if !name.starts_with("grimodex-") {
            continue;
        }
        let format = if name.ends_with(".db.gz") {
            "db.gz"
        } else if name.ends_with(".db") {
            "db"
        } else {
            continue;
        };
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
/// before it becomes active. Each shell injects invalidation for its DB-derived
/// in-memory caches here.
pub fn restore_backup_core(
    ws_state: &WorkspaceState,
    file_name: &str,
    on_reopened: impl FnOnce(),
) -> AppResult<()> {
    // Serialize against open_workspace and concurrent restores.
    let _open_guard = ws_state
        .open_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let ws_path = {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        inner
            .as_ref()
            .ok_or(AppError::NoWorkspace)?
            .path()
            .to_path_buf()
    };
    let (source, is_gz) = open_backup_source(&ws_path, file_name)?;

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
    verify_sqlite_ok(&staged_plain)?;

    // `quick_check` alone accepts valid SQLite files from a schema version this
    // app cannot migrate. Migrate the disposable staged copy before touching
    // the live DB so an incompatible backup leaves the current session intact.
    preflight_candidate(&staged_plain)?;

    let result = install_staged_workspace_db(
        ws_state,
        &ws_path,
        &staged_plain,
        InstallStagedOptions::normal_restore(on_reopened),
    );
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
    ForensicImage {
        dir: PathBuf,
        main: PathBuf,
        wal: Option<PathBuf>,
        shm: Option<PathBuf>,
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
                let main = dir.join("grimodex.db");
                let wal = optional_regular_file(&dir.join("grimodex.db-wal"));
                let shm = optional_regular_file(&dir.join("grimodex.db-shm"));
                RestoreRollbackSource::ForensicImage {
                    dir: dir.clone(),
                    main,
                    wal,
                    shm,
                }
            }
        }
    }
}

fn optional_regular_file(path: &Path) -> Option<PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Some(path.to_path_buf()),
        _ => None,
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
        Ok(()) => {
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

    // 1) Seal staged + digest before any live mutation.
    let installed =
        match (|| -> Result<_, crate::migration_supervisor::MigrationSupervisorError> {
            crate::migration_supervisor::seal_sqlite_image(staged_plain)?;
            crate::migration_supervisor::installed_image_token_from_sealed(
                staged_plain,
                grimodex_core::SCHEMA_VERSION,
                None,
            )
        })() {
            Ok(token) => token,
            Err(error) => {
                drop(exclusive_lease);
                return Err(abort_install(
                    ws_state,
                    &db_path,
                    ws_path,
                    detached_active,
                    anyhow::anyhow!(
                    "復元候補の seal／digest 取得に失敗したため中止しました（live未置換）: {error}"
                ),
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
            phase: "live-sealed".to_string(),
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

    if let Err(error) = atomic_replace(staged_plain, &db_path) {
        let primary_msg = format!("復元DBの適用に失敗しました: {error}");
        let rollback_result: AppResult<()> = match rollback_source.as_ref() {
            Some(RestoreRollbackSource::LogicalImage(_)) => {
                if let Some(path) = rollback_path.as_deref() {
                    match crate::migration_supervisor::rollback_if_installed_image_unchanged(
                        ws_path,
                        &db_path,
                        path,
                        &installed,
                        "RESTORE_REPLACE_FAILED",
                    ) {
                        Ok(exclusive) => {
                            drop(exclusive);
                            if let Some(cleanup) = rollback_cleanup.as_mut() {
                                cleanup.disarm();
                            }
                            let _ = clear_restore_session_marker(ws_path);
                            Err(anyhow::anyhow!("{primary_msg}; 元のDBへ戻しました").into())
                        }
                        Err(conflict) => {
                            if let Some(cleanup) = rollback_cleanup.as_mut() {
                                cleanup.disarm();
                            }
                            Err(anyhow::anyhow!(
                                "RESTORE_SESSION_LOST: {primary_msg}; rollback={conflict}"
                            )
                            .into())
                        }
                    }
                } else {
                    Err(anyhow::anyhow!("{primary_msg}").into())
                }
            }
            Some(RestoreRollbackSource::ForensicImage { .. }) => {
                if let Some(cleanup) = rollback_cleanup.as_mut() {
                    cleanup.disarm();
                }
                Err(anyhow::anyhow!(
                    "RESTORE_FORENSIC_RECOVERY_REQUIRED: {primary_msg}; forensic artifact retained at {:?}",
                    safety_artifact.as_ref().map(|a| a.retained_path())
                )
                .into())
            }
            None => Err(anyhow::anyhow!("{primary_msg}").into()),
        };
        drop(exclusive_lease);
        // Safe Mode: never re-publish. Normal restore: only re-publish after
        // logical rollback restored a sealed complete image.
        if detached_active
            && matches!(
                rollback_source.as_ref(),
                Some(RestoreRollbackSource::LogicalImage(_))
            )
            && rollback_result
                .as_ref()
                .err()
                .is_some_and(|e| e.to_string().contains("元のDBへ戻しました"))
        {
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
        let code = options.failpoint.expect("failpoint set").as_str();
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

    let _ = clear_restore_session_marker(ws_path);
    let _ = retained_safety;

    if !options.publish_workspace_authority {
        drop(exclusive_lease);
        return Ok(());
    }

    match publish_active_workspace(ws_state, ws_path.to_path_buf(), exclusive_lease) {
        Ok(()) => {
            if let Some(on_reopened) = options.on_reopened.take() {
                on_reopened();
            }
            Ok(())
        }
        Err(restore_error) => {
            let restore_error_msg = restore_error.to_string();
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
                        &installed,
                        "RESTORE_HANDOFF_CONFLICT",
                    ) {
                        Ok(exclusive) => {
                            if let Some(cleanup) = rollback_cleanup.as_mut() {
                                cleanup.disarm();
                            }
                            let _ = clear_restore_session_marker(ws_path);
                            match publish_active_workspace(
                                ws_state,
                                ws_path.to_path_buf(),
                                exclusive,
                            ) {
                                Ok(()) => Err(anyhow::anyhow!(
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
        Some(RestoreRollbackSource::ForensicImage {
            dir,
            main,
            wal,
            shm,
        }) => {
            match restore_forensic_bundle_to_live(db_path, main, wal.as_deref(), shm.as_deref()) {
                Ok(()) => {
                    if let Some(cleanup) = rollback_cleanup {
                        cleanup.disarm();
                    }
                    Err(anyhow::anyhow!(
                        "RESTORE_FORENSIC_RECOVERY_REQUIRED: {primary}; forensic bundle restored to live from {dir:?} — remain in Safe Mode"
                    )
                    .into())
                }
                Err(error) => {
                    if let Some(cleanup) = rollback_cleanup {
                        cleanup.disarm();
                    }
                    Err(anyhow::anyhow!(
                        "RESTORE_FORENSIC_RECOVERY_REQUIRED: {primary}; forensic auto-rollback failed ({error}); artifact retained at {dir:?}"
                    )
                    .into())
                }
            }
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
                    let _ = clear_restore_session_marker(ws_path);
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

fn restore_forensic_bundle_to_live(
    db_path: &Path,
    main: &Path,
    wal: Option<&Path>,
    shm: Option<&Path>,
) -> AppResult<()> {
    remove_db_sidecars(db_path)
        .map_err(|e| anyhow::anyhow!("forensic rollback sidecar cleanup failed: {e}"))?;
    let (staged, mut staged_out) = create_unique_sidecar(db_path, "forensic-rollback")?;
    let mut staged_cleanup = CleanupPath::new(staged.clone());
    copy_path_into(main, &mut staged_out).map_err(anyhow::Error::from)?;
    staged_out.sync_all().map_err(anyhow::Error::from)?;
    drop(staged_out);
    atomic_replace(&staged, db_path).map_err(anyhow::Error::from)?;
    staged_cleanup.disarm();
    if let Some(wal) = wal {
        std::fs::copy(wal, sidecar(db_path, "-wal")).map_err(anyhow::Error::from)?;
        sync_path(&sidecar(db_path, "-wal"))?;
    }
    if let Some(shm) = shm {
        std::fs::copy(shm, sidecar(db_path, "-shm")).map_err(anyhow::Error::from)?;
        sync_path(&sidecar(db_path, "-shm"))?;
    }
    Ok(())
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

fn publish_active_workspace(
    ws_state: &WorkspaceState,
    ws_path: PathBuf,
    exclusive: workspace_lease::WorkspaceLease,
) -> AppResult<()> {
    let opened =
        crate::migration_supervisor::reopen_under_shared_lease_for_restore(&ws_path, exclusive)
            .map_err(|error| anyhow::anyhow!("workspace shared handoff after restore: {error}"))?;
    if let Err(error) = opened.database.rebuild_fts_if_stale() {
        tracing::warn!("restore: fts rebuild after restore failed: {error}");
    }
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
    Ok(())
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

#[cfg(not(windows))]
pub(crate) fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(staged, destination)
}

#[cfg(windows)]
pub(crate) fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
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

fn open_backup_source(ws_path: &Path, file_name: &str) -> AppResult<(File, bool)> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || !file_name.starts_with("grimodex-")
    {
        return Err(anyhow::anyhow!("不正なバックアップ名です: {file_name}").into());
    }
    let is_gz = file_name.ends_with(".db.gz");
    if !(is_gz || file_name.ends_with(".db")) {
        return Err(
            anyhow::anyhow!("この形式のバックアップは復元に対応していません: {file_name}").into(),
        );
    }
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

    Ok((file, is_gz))
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
    use crate::open::{
        spawn_workspace_maintenance_worker, try_claim_workspace_maintenance,
        workspace_maintenance_exclusive_waiters,
    };
    use crate::with_db_state;
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
            switching: AtomicBool::new(false),
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

    #[test]
    fn list_backups_filters_and_serializes_supported_regular_files() {
        let dir =
            std::env::temp_dir().join(format!("grimodex-backup-list-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("grimodex-a.db"), b"db").expect("write db");
        std::fs::write(dir.join("grimodex-b.db.gz"), b"gzip").expect("write gz");
        std::fs::write(dir.join("grimodex-c.db.tmp"), b"tmp").expect("write tmp");
        std::fs::write(dir.join("other.db"), b"other").expect("write other");
        std::fs::create_dir(dir.join("grimodex-directory.db")).expect("mkdir candidate");

        let listed = list_backups_in(&dir);
        assert_eq!(listed.len(), 2);
        assert!(listed
            .iter()
            .any(|item| item.file_name == "grimodex-a.db" && item.format == "db"));
        assert!(listed
            .iter()
            .any(|item| item.file_name == "grimodex-b.db.gz" && item.format == "db.gz"));
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
            switching: AtomicBool::new(false),
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
        ] {
            assert!(open_backup_source(ws, bad).is_err(), "accepts {bad:?}");
        }
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
}
