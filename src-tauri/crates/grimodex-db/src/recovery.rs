//! Restore-only Safe Mode recovery candidates and session state (Release Gate A2).
//!
//! Safe Mode never publishes [`crate::state::WorkspaceAuthority`]. Recovery
//! candidates are addressed by opaque IDs issued by Native; renderer never
//! round-trips filesystem paths such as `migrations/foo.db`.

use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

use crate::backup_restore::{list_backups_in, BackupInfo};
use crate::error::{AppError, AppResult};
use crate::migration_supervisor::{
    self, MigrationSnapshotManifest, OpenMigrationInfo, WorkspaceOpenDbOutcome,
};
use crate::state::WorkspaceState;
use crate::workspace_lease;
use crate::Database;

/// Wire / IPC recovery candidate (opaque id; no filesystem path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub id: String,
    pub kind: RecoveryCandidateKind,
    pub created_at: String,
    pub schema_version: Option<i32>,
    pub app_version: Option<String>,
    pub size_bytes: u64,
    pub checksum_status: ChecksumStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryCandidateKind {
    AutomaticBackup,
    ManualBackup,
    MigrationSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChecksumStatus {
    Verified,
    Unverified,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReceipt {
    pub from_schema: i32,
    pub to_schema: i32,
    pub receipt_path: String,
    pub recovered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl From<OpenMigrationInfo> for MigrationReceipt {
    fn from(value: OpenMigrationInfo) -> Self {
        Self {
            from_schema: value.from_schema,
            to_schema: value.to_schema,
            receipt_path: value.receipt_path,
            recovered: value.recovered,
            error_code: value.error_code,
        }
    }
}

/// Successful workspace open payload (Ready / Migrated).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspacePayload {
    pub name: String,
    pub is_existing: bool,
    pub workspace_id: String,
}

/// Discriminated open outcome kept through N-API / IPC / renderer (Gate A2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum WorkspaceOpenOutcome {
    Ready {
        workspace: OpenWorkspacePayload,
    },
    Migrated {
        workspace: OpenWorkspacePayload,
        migration: MigrationReceipt,
    },
    #[serde(rename_all = "camelCase")]
    RecoveryRequired {
        reason: String,
        error_code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot_id: Option<String>,
        candidates: Vec<RecoveryCandidate>,
    },
    #[serde(rename_all = "camelCase")]
    SafeMode {
        reason: String,
        candidates: Vec<RecoveryCandidate>,
    },
}

impl WorkspaceOpenOutcome {
    pub fn is_authority_published(&self) -> bool {
        matches!(self, Self::Ready { .. } | Self::Migrated { .. })
    }

    pub fn is_restore_only(&self) -> bool {
        matches!(self, Self::RecoveryRequired { .. } | Self::SafeMode { .. })
    }
}

/// Internal mapping from opaque id → absolute path under the workspace.
#[derive(Debug, Clone)]
pub struct RecoveryCandidateRecord {
    pub candidate: RecoveryCandidate,
    pub absolute_path: PathBuf,
    pub relative_key: String,
}

/// Restore-only session: workspace path + candidate registry, no DB authority.
#[derive(Debug)]
pub struct SafeModeSession {
    pub workspace_path: PathBuf,
    pub reason: String,
    pub error_code: Option<String>,
    pub snapshot_id: Option<String>,
    records: HashMap<String, RecoveryCandidateRecord>,
}

impl SafeModeSession {
    pub fn from_workspace(
        workspace_path: PathBuf,
        reason: String,
        error_code: Option<String>,
        preferred_snapshot: Option<&Path>,
    ) -> AppResult<Self> {
        let records = build_candidate_registry(&workspace_path)?;
        let snapshot_id = preferred_snapshot.and_then(|snap| {
            records
                .values()
                .find(|record| paths_equal(&record.absolute_path, snap))
                .map(|record| record.candidate.id.clone())
        });
        Ok(Self {
            workspace_path,
            reason,
            error_code,
            snapshot_id,
            records,
        })
    }

    pub fn candidates(&self) -> Vec<RecoveryCandidate> {
        let mut out: Vec<_> = self
            .records
            .values()
            .map(|record| record.candidate.clone())
            .collect();
        out.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        out
    }

    pub fn resolve(&self, candidate_id: &str) -> AppResult<&RecoveryCandidateRecord> {
        self.records
            .get(candidate_id)
            .ok_or_else(|| AppError::Anyhow(anyhow::anyhow!("RECOVERY_CANDIDATE_UNKNOWN: {candidate_id}")))
    }

    pub fn refresh_candidates(&mut self) -> AppResult<()> {
        self.records = build_candidate_registry(&self.workspace_path)?;
        if let Some(snapshot_id) = self.snapshot_id.clone() {
            if !self.records.contains_key(&snapshot_id) {
                self.snapshot_id = None;
            }
        }
        Ok(())
    }
}

/// Process-wide Safe Mode holder (mutually exclusive with ActiveWorkspace authority).
#[derive(Debug, Default)]
pub struct SafeModeState {
    inner: Mutex<Option<SafeModeSession>>,
}

impl SafeModeState {
    pub fn clear(&self) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
        *guard = None;
        Ok(())
    }

    pub fn enter(&self, session: SafeModeSession) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
        *guard = Some(session);
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.inner
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn with_session<T>(
        &self,
        f: impl FnOnce(&SafeModeSession) -> AppResult<T>,
    ) -> AppResult<T> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
        let session = guard.as_ref().ok_or(AppError::NoSafeMode)?;
        f(session)
    }

    pub fn with_session_mut<T>(
        &self,
        f: impl FnOnce(&mut SafeModeSession) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
        let session = guard.as_mut().ok_or(AppError::NoSafeMode)?;
        f(session)
    }
}

pub fn build_candidate_registry(
    workspace: &Path,
) -> AppResult<HashMap<String, RecoveryCandidateRecord>> {
    let mut records = HashMap::new();
    let backups_dir = workspace.join("backups");
    for backup in list_backups_in(&backups_dir) {
        let absolute = backups_dir.join(&backup.file_name);
        let kind = if backup.file_name.contains("manual") {
            RecoveryCandidateKind::ManualBackup
        } else {
            RecoveryCandidateKind::AutomaticBackup
        };
        push_record(
            &mut records,
            workspace,
            absolute,
            backup.file_name.clone(),
            kind,
            backup.size_bytes,
            backup.modified_ms,
            None,
            None,
            ChecksumStatus::Unverified,
        )?;
    }

    let migrations = workspace.join("backups/migrations");
    if let Ok(entries) = fs::read_dir(&migrations) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".db") {
                continue;
            }
            let absolute = entry.path();
            let Ok(meta) = fs::symlink_metadata(&absolute) else {
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
            let (schema_version, app_version, checksum_status) =
                inspect_migration_snapshot(&absolute);
            push_record(
                &mut records,
                workspace,
                absolute,
                format!("migrations/{name}"),
                RecoveryCandidateKind::MigrationSnapshot,
                meta.len(),
                modified_ms,
                schema_version,
                app_version,
                checksum_status,
            )?;
        }
    }
    Ok(records)
}

fn push_record(
    records: &mut HashMap<String, RecoveryCandidateRecord>,
    workspace: &Path,
    absolute_path: PathBuf,
    relative_key: String,
    kind: RecoveryCandidateKind,
    size_bytes: u64,
    modified_ms: u64,
    schema_version: Option<i32>,
    app_version: Option<String>,
    checksum_status: ChecksumStatus,
) -> AppResult<()> {
    ensure_path_inside_workspace(workspace, &absolute_path)?;
    let id = opaque_id_for(&relative_key);
    let created_at = Utc
        .timestamp_millis_opt(modified_ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let candidate = RecoveryCandidate {
        id: id.clone(),
        kind,
        created_at,
        schema_version,
        app_version,
        size_bytes,
        checksum_status,
    };
    records.insert(
        id,
        RecoveryCandidateRecord {
            candidate,
            absolute_path,
            relative_key,
        },
    );
    Ok(())
}

fn opaque_id_for(relative_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_key.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("rc_{}", &digest[..24])
}

fn inspect_migration_snapshot(
    db_path: &Path,
) -> (Option<i32>, Option<String>, ChecksumStatus) {
    let manifest_path = sidecar_manifest(db_path);
    let Ok(raw) = fs::read_to_string(&manifest_path) else {
        return (None, None, ChecksumStatus::Unverified);
    };
    let Ok(manifest) = serde_json::from_str::<MigrationSnapshotManifest>(&raw) else {
        return (None, None, ChecksumStatus::Invalid);
    };
    let Ok(actual) = sha256_file(db_path) else {
        return (
            Some(manifest.source_schema_version),
            Some(manifest.app_version),
            ChecksumStatus::Invalid,
        );
    };
    let status = if actual.eq_ignore_ascii_case(&manifest.sha256) {
        ChecksumStatus::Verified
    } else {
        ChecksumStatus::Invalid
    };
    (
        Some(manifest.source_schema_version),
        Some(manifest.app_version),
        status,
    )
}

fn sidecar_manifest(db_path: &Path) -> PathBuf {
    // Supervisor writes `migration-….db` + sibling `migration-….json`.
    db_path.with_extension("json")
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn ensure_path_inside_workspace(workspace: &Path, candidate: &Path) -> AppResult<()> {
    let ws = workspace
        .canonicalize()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("workspace canonicalize: {e}")))?;
    let path = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("candidate canonicalize: {e}")))?
    } else {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CANDIDATE_MISSING: {}",
            candidate.display()
        )));
    };
    if !path.starts_with(&ws) {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_PATH_ESCAPE: candidate is outside workspace"
        )));
    }
    let meta = fs::symlink_metadata(&path).map_err(anyhow::Error::from)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CANDIDATE_SYMLINK: refusing symlink restore source"
        )));
    }
    if !meta.file_type().is_file() {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CANDIDATE_NOT_FILE: {}",
            path.display()
        )));
    }
    Ok(())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Convert supervisor DB outcome into a Safe Mode session + wire candidates.
pub fn session_from_db_outcome(
    workspace: &Path,
    outcome: &WorkspaceOpenDbOutcome,
) -> AppResult<Option<SafeModeSession>> {
    match outcome {
        WorkspaceOpenDbOutcome::Ready { .. } | WorkspaceOpenDbOutcome::Migrated { .. } => Ok(None),
        WorkspaceOpenDbOutcome::RecoveryRequired {
            reason,
            error_code,
            snapshot_path,
            ..
        } => Ok(Some(SafeModeSession::from_workspace(
            workspace.to_path_buf(),
            reason.clone(),
            Some(error_code.clone()),
            Some(snapshot_path.as_path()),
        )?)),
        WorkspaceOpenDbOutcome::SafeMode { reason, .. } => Ok(Some(
            SafeModeSession::from_workspace(workspace.to_path_buf(), reason.clone(), None, None)?,
        )),
    }
}

pub fn list_candidates_for_workspace(workspace: &Path) -> AppResult<Vec<RecoveryCandidate>> {
    let session = SafeModeSession::from_workspace(
        workspace.to_path_buf(),
        "listing".into(),
        None,
        None,
    )?;
    Ok(session.candidates())
}

pub fn verify_candidate_record(record: &RecoveryCandidateRecord) -> AppResult<RecoveryCandidate> {
    let mut candidate = record.candidate.clone();
    match candidate.kind {
        RecoveryCandidateKind::MigrationSnapshot => {
            let (_, _, status) = inspect_migration_snapshot(&record.absolute_path);
            candidate.checksum_status = status;
            if status == ChecksumStatus::Invalid {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "RECOVERY_CHECKSUM_INVALID: {}",
                    record.relative_key
                )));
            }
        }
        RecoveryCandidateKind::AutomaticBackup | RecoveryCandidateKind::ManualBackup => {
            // Open as SQLite and run a quick integrity probe on a disposable copy.
            let tmp = record
                .absolute_path
                .with_extension(format!("verify-{}.db", Uuid::new_v4()));
            fs::copy(&record.absolute_path, &tmp).map_err(anyhow::Error::from)?;
            let result = (|| -> AppResult<()> {
                let db = Database::new(&tmp)?;
                db.with_conn(|conn| {
                    let ok: String =
                        conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
                    if ok != "ok" {
                        anyhow::bail!("RECOVERY_QUICK_CHECK_FAILED: {ok}");
                    }
                    Ok(())
                })?;
                Ok(())
            })();
            let _ = fs::remove_file(&tmp);
            result?;
            candidate.checksum_status = ChecksumStatus::Unverified;
        }
    }
    Ok(candidate)
}

/// Disposable-copy migration preflight before exclusive restore.
pub fn preflight_restore_candidate(record: &RecoveryCandidateRecord) -> AppResult<()> {
    verify_candidate_record(record)?;
    let tmp = record
        .absolute_path
        .with_extension(format!("preflight-{}.db", Uuid::new_v4()));
    copy_sqlite_image(&record.absolute_path, &tmp)?;
    let result = (|| -> AppResult<()> {
        let db = Database::new(&tmp)?;
        db.migrate_for_restore_preflight()?;
        Ok(())
    })();
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(format!("{}-wal", tmp.display()));
    let _ = fs::remove_file(format!("{}-shm", tmp.display()));
    result
}

fn copy_sqlite_image(source: &Path, dest: &Path) -> AppResult<()> {
    // Prefer VACUUM INTO when source is a live SQLite image so WAL frames are included.
    match Database::new(source) {
        Ok(db) => {
            let dest_str = dest.to_string_lossy().replace('\'', "''");
            db.with_conn(|conn| {
                conn.execute(&format!("VACUUM INTO '{dest_str}'"), [])?;
                Ok(())
            })?;
            Ok(())
        }
        Err(_) => {
            fs::copy(source, dest).map_err(anyhow::Error::from)?;
            Ok(())
        }
    }
}

/// Legacy BackupInfo list used by Gate A supervisor messages; map into candidates.
pub fn backup_infos_as_legacy(workspace: &Path) -> Vec<BackupInfo> {
    migration_supervisor::list_recovery_candidates(workspace)
}

pub fn list_safe_mode_candidates(ws_state: &WorkspaceState) -> AppResult<Vec<RecoveryCandidate>> {
    ws_state.safe_mode.with_session_mut(|session| {
        session.refresh_candidates()?;
        Ok(session.candidates())
    })
}

pub fn verify_safe_mode_candidate(
    ws_state: &WorkspaceState,
    candidate_id: &str,
) -> AppResult<RecoveryCandidate> {
    ws_state.safe_mode.with_session(|session| {
        let record = session.resolve(candidate_id)?;
        ensure_path_inside_workspace(&session.workspace_path, &record.absolute_path)?;
        verify_candidate_record(record)
    })
}

/// Restore-only atomic restore by opaque candidate id.
///
/// Does **not** publish [`crate::state::WorkspaceAuthority`]. After success the
/// Safe Mode session is cleared and the caller must `open_workspace` again.
pub fn restore_safe_mode_candidate(
    ws_state: &WorkspaceState,
    candidate_id: &str,
) -> AppResult<()> {
    let _open_guard = ws_state
        .open_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;

    let (workspace_path, absolute_path, relative_key) =
        ws_state.safe_mode.with_session(|session| {
            let record = session.resolve(candidate_id)?;
            ensure_path_inside_workspace(&session.workspace_path, &record.absolute_path)?;
            preflight_restore_candidate(record)?;
            Ok((
                session.workspace_path.clone(),
                record.absolute_path.clone(),
                record.relative_key.clone(),
            ))
        })?;

    // Refuse restore while a normal authority is somehow still published.
    {
        let inner = ws_state
            .inner
            .lock()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
        if inner.is_some() {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_AUTHORITY_STILL_PUBLISHED: refuse Safe Mode restore while Database authority exists"
            )));
        }
    }

    let db_path = workspace_path.join("grimodex.db");
    let staged = db_path.with_extension(format!("safe-restore-{}.db", Uuid::new_v4()));
    let mut staged_cleanup = StagingCleanup::new(staged.clone());
    materialize_candidate_to_plain(&absolute_path, &relative_key, &staged)?;
    {
        let db = Database::new(&staged)?;
        db.migrate_for_restore_preflight()?;
    }

    ws_state
        .switching
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _switching = SwitchingFlag(&ws_state.switching);

    let exclusive = workspace_lease::acquire_exclusive_for_migration(&workspace_path)?;
    migration_supervisor::seal_sqlite_image(&staged)
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;

    // Keep a quarantine copy of the current live image when present.
    if db_path.exists() {
        let quarantine_dir = workspace_path.join("backups");
        let _ = fs::create_dir_all(&quarantine_dir);
        let stamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
        let quarantine = quarantine_dir.join(format!("grimodex-quarantine-{stamp}.db"));
        let _ = copy_sqlite_image(&db_path, &quarantine);
    }

    remove_sqlite_sidecars(&db_path);
    if let Err(rename_error) = fs::rename(&staged, &db_path) {
        fs::copy(&staged, &db_path).map_err(|e| {
            AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_RESTORE_REPLACE_FAILED: rename={rename_error}; copy={e}"
            ))
        })?;
        let _ = fs::remove_file(&staged);
    }
    staged_cleanup.disarm();
    migration_supervisor::seal_sqlite_image(&db_path)
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    drop(exclusive);

    ws_state.safe_mode.clear()?;
    Ok(())
}

pub fn quarantine_live_database(ws_state: &WorkspaceState) -> AppResult<String> {
    ws_state.safe_mode.with_session(|session| {
        let db_path = session.workspace_path.join("grimodex.db");
        if !db_path.exists() {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_LIVE_MISSING: grimodex.db is not present"
            )));
        }
        let quarantine_dir = session.workspace_path.join("backups");
        fs::create_dir_all(&quarantine_dir).map_err(anyhow::Error::from)?;
        let stamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
        let dest = quarantine_dir.join(format!("grimodex-quarantine-{stamp}.db"));
        copy_sqlite_image(&db_path, &dest)?;
        Ok(dest
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("grimodex-quarantine.db")
            .to_string())
    })
}

pub fn export_safe_mode_diagnostics(ws_state: &WorkspaceState) -> AppResult<String> {
    ws_state.safe_mode.with_session(|session| {
        let diagnostics = serde_json::json!({
            "version": 1,
            "reason": session.reason,
            "errorCode": session.error_code,
            "snapshotId": session.snapshot_id,
            "workspacePath": session.workspace_path.display().to_string(),
            "candidates": session.candidates(),
            "appVersion": migration_supervisor::resolved_app_version(),
            "supportedSchemaVersion": grimodex_core::SCHEMA_VERSION,
            "exportedAt": Utc::now().to_rfc3339(),
        });
        let dir = session.workspace_path.join("backups");
        fs::create_dir_all(&dir).map_err(anyhow::Error::from)?;
        let stamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
        let path = dir.join(format!("safe-mode-diagnostics-{stamp}.json"));
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&diagnostics)
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("diagnostics serialize: {e}")))?;
        fs::write(&tmp, bytes).map_err(anyhow::Error::from)?;
        fs::rename(&tmp, &path).map_err(anyhow::Error::from)?;
        Ok(path.display().to_string())
    })
}

fn materialize_candidate_to_plain(
    absolute_path: &Path,
    relative_key: &str,
    dest: &Path,
) -> AppResult<()> {
    if relative_key.ends_with(".db.gz") {
        use flate2::read::GzDecoder;
        use std::io::copy;
        let file = File::open(absolute_path).map_err(anyhow::Error::from)?;
        let mut decoder = GzDecoder::new(file);
        let mut out = File::create(dest).map_err(anyhow::Error::from)?;
        copy(&mut decoder, &mut out).map_err(anyhow::Error::from)?;
        out.sync_all().map_err(anyhow::Error::from)?;
        Ok(())
    } else {
        copy_sqlite_image(absolute_path, dest)
    }
}

fn remove_sqlite_sidecars(db_path: &Path) {
    let _ = fs::remove_file(format!("{}-wal", db_path.display()));
    let _ = fs::remove_file(format!("{}-shm", db_path.display()));
    let wal = PathBuf::from(format!("{}-wal", db_path.display()));
    let shm = PathBuf::from(format!("{}-shm", db_path.display()));
    let _ = fs::remove_file(wal);
    let _ = fs::remove_file(shm);
}

struct StagingCleanup {
    path: PathBuf,
    armed: bool,
}

impl StagingCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
            remove_sqlite_sidecars(&self.path);
        }
    }
}

struct SwitchingFlag<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for SwitchingFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_ws(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("grimodex-recovery-{label}-{nanos}"));
        fs::create_dir_all(path.join("backups/migrations")).expect("mkdir");
        path
    }

    #[test]
    fn opaque_ids_are_stable_and_hide_paths() {
        let ws = temp_ws("opaque");
        let backup = ws.join("backups/grimodex-auto.db");
        {
            let db = Database::new(&backup).expect("db");
            db.migrate().expect("migrate");
        }
        let registry = build_candidate_registry(&ws).expect("registry");
        assert_eq!(registry.len(), 1);
        let record = registry.values().next().expect("one");
        assert!(record.candidate.id.starts_with("rc_"));
        assert!(!record.candidate.id.contains("grimodex"));
        assert!(!record.candidate.id.contains('/'));
        let again = build_candidate_registry(&ws).expect("again");
        assert_eq!(
            again.values().next().expect("one").candidate.id,
            record.candidate.id
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn path_escape_is_rejected() {
        let ws = temp_ws("escape");
        let outside = std::env::temp_dir().join(format!(
            "grimodex-outside-{}.db",
            Uuid::new_v4()
        ));
        File::create(&outside).expect("create");
        let err = ensure_path_inside_workspace(&ws, &outside).expect_err("escape");
        assert!(
            err.to_string().contains("RECOVERY_PATH_ESCAPE"),
            "err={err}"
        );
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&ws);
    }
}
