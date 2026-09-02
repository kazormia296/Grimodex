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
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

use crate::backup_restore::{
    create_persistent_live_safety_artifact, install_staged_workspace_db, list_backups_in,
    materialize_candidate_to_plain, preflight_candidate, verify_materialized_backup_digest,
    verify_sqlite_ok, BackupInfo, InstallStagedOptions,
};
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
        self.records.get(candidate_id).ok_or_else(|| {
            AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_CANDIDATE_UNKNOWN: {candidate_id}"
            ))
        })
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
    // Fail the whole registry only when the workspace root itself is unusable.
    let _ws_canon = workspace.canonicalize().map_err(|e| {
        AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_WORKSPACE_UNREADABLE: cannot canonicalize {}: {e}",
            workspace.display()
        ))
    })?;

    let mut records = HashMap::new();
    let backups_dir = workspace.join("backups");
    for backup in list_backups_in(&backups_dir) {
        let absolute = backups_dir.join(&backup.file_name);
        let kind = if backup.file_name.contains("manual") {
            RecoveryCandidateKind::ManualBackup
        } else {
            RecoveryCandidateKind::AutomaticBackup
        };
        if let Err(error) = push_record(
            &mut records,
            workspace,
            RecoveryCandidateSeed {
                absolute_path: absolute,
                relative_key: backup.file_name.clone(),
                kind,
                size_bytes: backup.size_bytes,
                modified_ms: backup.modified_ms,
                schema_version: None,
                app_version: None,
                checksum_status: ChecksumStatus::Unverified,
            },
        ) {
            tracing::warn!(
                "recovery: skipping backup candidate {}: {error}",
                backup.file_name
            );
        }
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
            if let Err(error) = push_record(
                &mut records,
                workspace,
                RecoveryCandidateSeed {
                    absolute_path: absolute,
                    relative_key: format!("migrations/{name}"),
                    kind: RecoveryCandidateKind::MigrationSnapshot,
                    size_bytes: meta.len(),
                    modified_ms,
                    schema_version,
                    app_version,
                    checksum_status,
                },
            ) {
                tracing::warn!("recovery: skipping migration candidate {name}: {error}");
            }
        }
    }
    Ok(records)
}

struct RecoveryCandidateSeed {
    absolute_path: PathBuf,
    relative_key: String,
    kind: RecoveryCandidateKind,
    size_bytes: u64,
    modified_ms: u64,
    schema_version: Option<i32>,
    app_version: Option<String>,
    checksum_status: ChecksumStatus,
}

fn push_record(
    records: &mut HashMap<String, RecoveryCandidateRecord>,
    workspace: &Path,
    seed: RecoveryCandidateSeed,
) -> AppResult<()> {
    ensure_path_inside_workspace(workspace, &seed.absolute_path)?;
    let id = opaque_id_for(&seed.relative_key);
    let created_at = Utc
        .timestamp_millis_opt(seed.modified_ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let candidate = RecoveryCandidate {
        id: id.clone(),
        kind: seed.kind,
        created_at,
        schema_version: seed.schema_version,
        app_version: seed.app_version,
        size_bytes: seed.size_bytes,
        checksum_status: seed.checksum_status,
    };
    records.insert(
        id,
        RecoveryCandidateRecord {
            candidate,
            absolute_path: seed.absolute_path,
            relative_key: seed.relative_key,
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

fn inspect_migration_snapshot(db_path: &Path) -> (Option<i32>, Option<String>, ChecksumStatus) {
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
    if !candidate.exists() {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CANDIDATE_MISSING: {}",
            candidate.display()
        )));
    }
    // Inspect the path itself before following links.
    let link_meta = fs::symlink_metadata(candidate).map_err(anyhow::Error::from)?;
    if link_meta.file_type().is_symlink() {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CANDIDATE_SYMLINK: refusing symlink restore source"
        )));
    }
    if !link_meta.file_type().is_file() {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CANDIDATE_NOT_FILE: {}",
            candidate.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if link_meta.nlink() > 1 {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_CANDIDATE_HARDLINK: refusing multi-link restore source"
            )));
        }
    }
    let path = candidate
        .canonicalize()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("candidate canonicalize: {e}")))?;
    if !path.starts_with(&ws) {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_PATH_ESCAPE: candidate is outside workspace"
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
    let session =
        SafeModeSession::from_workspace(workspace.to_path_buf(), "listing".into(), None, None)?;
    Ok(session.candidates())
}

pub fn verify_candidate_record(record: &RecoveryCandidateRecord) -> AppResult<RecoveryCandidate> {
    let mut candidate = record.candidate.clone();
    match candidate.kind {
        RecoveryCandidateKind::MigrationSnapshot => {
            let (_, _, status) = inspect_migration_snapshot(&record.absolute_path);
            candidate.checksum_status = status;
            if status != ChecksumStatus::Verified {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "RECOVERY_CHECKSUM_INVALID: migration snapshot must have a verified manifest ({})",
                    record.relative_key
                )));
            }
        }
        RecoveryCandidateKind::AutomaticBackup | RecoveryCandidateKind::ManualBackup => {
            // Open as SQLite and run a quick integrity probe on a disposable copy.
            let tmp = record
                .absolute_path
                .with_extension(format!("verify-{}.db", Uuid::new_v4()));
            materialize_candidate_to_plain(&record.absolute_path, &record.relative_key, &tmp)?;
            let result = (|| -> AppResult<()> {
                verify_sqlite_ok(&tmp)?;
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
    materialize_candidate_to_plain(&record.absolute_path, &record.relative_key, &tmp)?;
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

/// Materialize a restore candidate under exclusive lease after re-validating
/// migration snapshot identity (manifest SHA / size / workspace).
fn materialize_candidate_for_restore(
    workspace: &Path,
    absolute_path: &Path,
    relative_key: &str,
    kind: RecoveryCandidateKind,
    dest: &Path,
) -> AppResult<()> {
    let mut file = File::open(absolute_path).map_err(anyhow::Error::from)?;
    let meta = file.metadata().map_err(anyhow::Error::from)?;
    if kind == RecoveryCandidateKind::MigrationSnapshot {
        reverify_migration_snapshot_locked(
            workspace,
            absolute_path,
            relative_key,
            &mut file,
            &meta,
        )?;
        file.seek(SeekFrom::Start(0)).map_err(anyhow::Error::from)?;
        materialize_open_file_to_plain(&mut file, false, dest)?;
    } else {
        let is_gz = relative_key.ends_with(".db.gz");
        file.seek(SeekFrom::Start(0)).map_err(anyhow::Error::from)?;
        materialize_open_file_to_plain(&mut file, is_gz, dest)?;
    }
    verify_materialized_backup_digest(relative_key, dest)?;
    Ok(())
}

fn reverify_migration_snapshot_locked(
    workspace: &Path,
    absolute_path: &Path,
    relative_key: &str,
    file: &mut File,
    meta: &fs::Metadata,
) -> AppResult<MigrationSnapshotManifest> {
    let manifest_path = sidecar_manifest(absolute_path);
    let raw = fs::read_to_string(&manifest_path).map_err(|_| {
        AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_MANIFEST_MISSING: refusing restore of {relative_key} without manifest"
        ))
    })?;
    let manifest: MigrationSnapshotManifest = serde_json::from_str(&raw).map_err(|error| {
        AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_MANIFEST_INVALID: {relative_key}: {error}"
        ))
    })?;
    let file_name = absolute_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if manifest.database_file_name != file_name {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_MANIFEST_NAME_MISMATCH: manifest databaseFileName={} path={file_name}",
            manifest.database_file_name
        )));
    }
    if meta.len() != manifest.size_bytes {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_MANIFEST_SIZE_MISMATCH: manifest size={} file size={}",
            manifest.size_bytes,
            meta.len()
        )));
    }
    let expected_identity = migration_supervisor::workspace_identity(workspace);
    if manifest.source_workspace_identity != expected_identity {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_WORKSPACE_IDENTITY_MISMATCH: manifest identity={} workspace identity={expected_identity}",
            manifest.source_workspace_identity
        )));
    }
    file.seek(SeekFrom::Start(0)).map_err(anyhow::Error::from)?;
    let actual = sha256_reader(file)?;
    if !actual.eq_ignore_ascii_case(&manifest.sha256) {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "RECOVERY_CHECKSUM_INVALID: snapshot content diverged from manifest for {relative_key}"
        )));
    }
    Ok(manifest)
}

fn materialize_open_file_to_plain(input: &mut File, is_gz: bool, dest: &Path) -> AppResult<()> {
    use flate2::read::GzDecoder;
    use std::fs::OpenOptions;
    use std::io::BufReader;

    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(anyhow::Error::from)?;
    let copy_result = if is_gz {
        let mut decoder = GzDecoder::new(BufReader::new(input));
        io::copy(&mut decoder, &mut output).map_err(anyhow::Error::from)
    } else {
        io::copy(input, &mut output).map_err(anyhow::Error::from)
    };
    if let Err(error) = copy_result {
        drop(output);
        let _ = fs::remove_file(dest);
        return Err(error.into());
    }
    if let Err(error) = output.sync_all() {
        drop(output);
        let _ = fs::remove_file(dest);
        return Err(anyhow::Error::from(error).into());
    }
    drop(output);
    Ok(())
}

fn sha256_reader(file: &mut File) -> AppResult<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(anyhow::Error::from)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
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
/// Does **not** publish [`crate::state::WorkspaceAuthority`]. The Safe Mode
/// session remains active until the next Ready/Migrated `open_workspace` so
/// Recovery Shell can still list / verify / retry.
pub fn restore_safe_mode_candidate(ws_state: &WorkspaceState, candidate_id: &str) -> AppResult<()> {
    let _open_guard = ws_state
        .open_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;

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

    let (workspace_path, absolute_path, relative_key, kind) =
        ws_state.safe_mode.with_session(|session| {
            let record = session.resolve(candidate_id)?;
            Ok((
                session.workspace_path.clone(),
                record.absolute_path.clone(),
                record.relative_key.clone(),
                record.candidate.kind,
            ))
        })?;

    let db_path = workspace_path.join("grimodex.db");
    let staged = db_path.with_extension(format!("safe-restore-{}.db", Uuid::new_v4()));
    let mut staged_cleanup = StagingCleanup::new(staged.clone());

    // Exclusive first, then re-validate the candidate path immediately before
    // materialize so symlink/hardlink TOCTOU cannot race the copy.
    let exclusive = workspace_lease::acquire_exclusive_for_migration(&workspace_path)?;
    ensure_path_inside_workspace(&workspace_path, &absolute_path)?;
    materialize_candidate_for_restore(
        &workspace_path,
        &absolute_path,
        &relative_key,
        kind,
        &staged,
    )?;
    preflight_candidate(&staged)?;

    let result = install_staged_workspace_db(
        ws_state,
        &workspace_path,
        &staged,
        InstallStagedOptions::safe_mode(exclusive),
    );
    if result.is_ok() {
        staged_cleanup.disarm();
    }
    result
}

pub fn quarantine_live_database(ws_state: &WorkspaceState) -> AppResult<String> {
    ws_state.safe_mode.with_session(|session| {
        let _lease = workspace_lease::try_acquire_shared(&session.workspace_path)?;
        let db_path = session.workspace_path.join("grimodex.db");
        if !db_path.exists() {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "RECOVERY_LIVE_MISSING: grimodex.db is not present"
            )));
        }
        let artifact = create_persistent_live_safety_artifact(&session.workspace_path, &db_path)?;
        let name = artifact
            .retained_path()
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("grimodex-pre-restore")
            .to_string();
        Ok(name)
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
            let _ = crate::backup_restore::remove_db_sidecars(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::{open_workspace_sync_traced, NativeWorkspaceOpenTrace};
    use crate::state::GlobalSettingsPath;
    use crate::state::WorkspaceState;
    use crate::workspace_lease;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use std::sync::Mutex;
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

    fn safe_mode_state(ws: &Path) -> WorkspaceState {
        let state = WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: SafeModeState::default(),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let session = SafeModeSession::from_workspace(
            ws.to_path_buf(),
            "test safe mode".to_string(),
            Some("TEST_SAFE_MODE".to_string()),
            None,
        )
        .expect("safe mode session");
        state.safe_mode.enter(session).expect("enter safe mode");
        state
    }

    fn create_migrated_db(path: &Path, marker: &str) {
        let db = Database::new(path).expect("db");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('recovery-test', ?)",
            &[serde_json::Value::String(marker.to_string())],
            "run",
        )
        .expect("set marker");
    }

    fn marker_at(path: &Path) -> String {
        let db = Database::new(path).expect("db");
        let rows = db
            .execute(
                "SELECT value FROM app_settings WHERE key = 'recovery-test'",
                &[],
                "get",
            )
            .expect("read marker");
        rows[0]["value"].as_str().unwrap_or_default().to_string()
    }

    fn gzip_file(source: &Path, dest: &Path) {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        let bytes = fs::read(source).expect("read source db");
        encoder.write_all(&bytes).expect("gzip write");
        fs::write(dest, encoder.finish().expect("gzip finish")).expect("write gzip");
    }

    fn candidate_id_for(state: &WorkspaceState, suffix: &str) -> String {
        state
            .safe_mode
            .with_session(|session| {
                session
                    .candidates()
                    .into_iter()
                    .find(|candidate| {
                        session
                            .resolve(&candidate.id)
                            .map(|record| record.relative_key.ends_with(suffix))
                            .unwrap_or(false)
                    })
                    .map(|candidate| candidate.id)
                    .ok_or_else(|| {
                        AppError::Anyhow(anyhow::anyhow!("candidate not found: {suffix}"))
                    })
            })
            .expect("candidate id")
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
        let outside = std::env::temp_dir().join(format!("grimodex-outside-{}.db", Uuid::new_v4()));
        File::create(&outside).expect("create");
        let err = ensure_path_inside_workspace(&ws, &outside).expect_err("escape");
        assert!(
            err.to_string().contains("RECOVERY_PATH_ESCAPE"),
            "err={err}"
        );
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_candidate_is_rejected() {
        let ws = temp_ws("symlink");
        let target = ws.join("backups/grimodex-real.db");
        {
            let db = Database::new(&target).expect("db");
            db.migrate().expect("migrate");
        }
        let link = ws.join("backups/grimodex-link.db");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let err = ensure_path_inside_workspace(&ws, &link).expect_err("symlink");
        assert!(
            err.to_string().contains("RECOVERY_CANDIDATE_SYMLINK"),
            "err={err}"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn verifies_plain_backup_candidate_via_materialized_sqlite() {
        let ws = temp_ws("verify-plain");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "plain");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db");

        let verified =
            verify_safe_mode_candidate(&state, &candidate_id).expect("plain candidate verifies");

        assert_eq!(verified.checksum_status, ChecksumStatus::Unverified);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn content_addressed_recovery_candidate_rejects_target_swap_without_live_mutation() {
        let ws = temp_ws("content-addressed-swap");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        let source = ws.join("backups/source.db");
        create_migrated_db(&source, "backup");
        let digest = crate::migration_supervisor::digest_sha256_file(&source)
            .expect("digest content-addressed recovery source");
        let name = format!("grimodex-c2zc-restore-fixture--sha256-{digest}.backup.db");
        let target = ws.join("backups").join(&name);
        fs::rename(&source, &target).expect("publish digest-bound recovery candidate");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".backup.db");

        // The registry has already captured the valid target name. Replacing
        // its bytes afterward must fail at the held-file materialization
        // boundary before preflight or install can touch the live DB.
        fs::write(&target, b"target-swapped-after-publication")
            .expect("replace recovery candidate bytes");
        let error = restore_safe_mode_candidate(&state, &candidate_id)
            .expect_err("content-addressed recovery target swap must reject");
        assert!(
            error
                .to_string()
                .contains("C2ZC_RESTORE_SOURCE_DIGEST_MISMATCH"),
            "unexpected mismatch error: {error}"
        );
        assert_eq!(marker_at(&ws.join("grimodex.db")), "live");
        assert!(state.safe_mode.is_active());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn verifies_gzip_backup_candidate_via_materialized_sqlite() {
        let ws = temp_ws("verify-gzip");
        let plain = ws.join("source.db");
        create_migrated_db(&plain, "gzip");
        gzip_file(&plain, &ws.join("backups/grimodex-auto.db.gz"));
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db.gz");

        let verified =
            verify_safe_mode_candidate(&state, &candidate_id).expect("gzip candidate verifies");

        assert_eq!(verified.checksum_status, ChecksumStatus::Unverified);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn corrupt_gzip_backup_candidate_is_rejected() {
        let ws = temp_ws("verify-corrupt-gzip");
        fs::write(ws.join("backups/grimodex-auto.db.gz"), b"not-gzip-payload")
            .expect("write corrupt gzip");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db.gz");

        let err = verify_safe_mode_candidate(&state, &candidate_id)
            .expect_err("corrupt gzip must fail verify");
        assert!(
            err.to_string().contains("gzip")
                || err.to_string().contains("materialize")
                || err.to_string().contains("SQLite")
                || err.to_string().contains("corrupt")
                || err.to_string().contains("failed"),
            "err={err}"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn safe_mode_restore_after_live_seal_failpoint_keeps_wal_commits_and_marker() {
        use crate::backup_restore::{
            install_staged_workspace_db, read_incomplete_restore_session, InstallStagedOptions,
            RestoreFailpoint,
        };
        use crate::migration_supervisor;
        use crate::workspace_lease;

        let ws = temp_ws("restore-fp-live-seal");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        commit_wal_only_marker(&ws.join("grimodex.db"));
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let staged = ws.join("staged-restore.db");
        fs::copy(ws.join("backups/grimodex-auto.db"), &staged).expect("stage");
        let exclusive = workspace_lease::acquire_exclusive_for_migration(&ws).expect("lease");

        let err = install_staged_workspace_db(
            &state,
            &ws,
            &staged,
            InstallStagedOptions::safe_mode_with_failpoint(
                exclusive,
                RestoreFailpoint::AfterLiveSeal,
            ),
        )
        .expect_err("after_live_seal must abort");
        assert!(
            err.to_string().contains("restore.after_live_seal"),
            "err={err}"
        );
        assert_eq!(
            wal_only_marker_at(&ws.join("grimodex.db")),
            "committed only in wal"
        );
        let marker = read_incomplete_restore_session(&ws)
            .expect("marker read")
            .expect("marker present");
        assert_eq!(marker.phase, "epoch-minted");

        let reopen = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("reopen");
        assert!(
            matches!(
                reopen,
                crate::migration_supervisor::WorkspaceOpenDbOutcome::SafeMode { .. }
            ),
            "got {reopen:?}"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn forensic_post_replace_failure_requires_recovery_not_main_only_success() {
        use crate::backup_restore::{
            install_staged_workspace_db, read_incomplete_restore_session, InstallStagedOptions,
            RestoreFailpoint,
        };
        use crate::workspace_lease;

        let ws = temp_ws("forensic-rollback");
        // Garbage live forces forensic safety artifact (VACUUM INTO fails).
        fs::write(ws.join("grimodex.db"), b"not-a-sqlite-database").expect("main");
        fs::write(ws.join("grimodex.db-wal"), b"wal-only-bytes").expect("wal");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let staged = ws.join("staged-restore.db");
        fs::copy(ws.join("backups/grimodex-auto.db"), &staged).expect("stage");
        let exclusive = workspace_lease::acquire_exclusive_for_migration(&ws).expect("lease");

        let err = install_staged_workspace_db(
            &state,
            &ws,
            &staged,
            InstallStagedOptions::safe_mode_with_failpoint(
                exclusive,
                RestoreFailpoint::AfterReplace,
            ),
        )
        .expect_err("forensic post-replace must fail closed");
        assert!(
            err.to_string()
                .contains("RESTORE_FORENSIC_RECOVERY_REQUIRED"),
            "err={err}"
        );
        assert!(
            err.to_string().contains("live left untouched"),
            "must not auto-rollback forensic onto live: {err}"
        );
        assert!(
            !err.to_string().contains("元のDBへ戻しました"),
            "must not claim logical rollback success: {err}"
        );
        assert!(
            !err.to_string().contains("forensic bundle restored"),
            "must not auto-restore forensic bundle: {err}"
        );
        // Candidate already landed via replace; do not put garbage back.
        assert_eq!(marker_at(&ws.join("grimodex.db")), "backup");
        let marker = read_incomplete_restore_session(&ws)
            .expect("marker read")
            .expect("marker retained for Recovery Shell");
        assert_eq!(marker.safety_kind, "forensic");
        let forensic_dir = PathBuf::from(&marker.safety_artifact);
        assert!(
            forensic_dir.is_dir(),
            "forensic bundle must remain at {}",
            forensic_dir.display()
        );
        assert!(
            forensic_dir.join("grimodex.db").is_file(),
            "forensic main must remain"
        );
        let forensic_names: Vec<_> = fs::read_dir(&forensic_dir)
            .expect("forensic dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .collect();
        assert!(
            forensic_dir.join("grimodex.db-wal").is_file()
                || forensic_dir.join("forensic-meta.json").is_file(),
            "forensic WAL or meta must remain; entries={forensic_names:?}"
        );
        assert!(state.inner.lock().expect("lock").is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn atomic_replace_failure_republish_path_uses_pre_restore_digest() {
        use crate::backup_restore::{
            install_staged_workspace_db, read_incomplete_restore_session, InstallStagedOptions,
            RestoreFailpoint,
        };
        use crate::workspace_lease;

        let ws = temp_ws("replace-fail-cas");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let staged = ws.join("staged-restore.db");
        fs::copy(ws.join("backups/grimodex-auto.db"), &staged).expect("stage");
        let exclusive = workspace_lease::acquire_exclusive_for_migration(&ws).expect("lease");

        let err = install_staged_workspace_db(
            &state,
            &ws,
            &staged,
            InstallStagedOptions::safe_mode_with_failpoint(
                exclusive,
                RestoreFailpoint::FailAtomicReplace,
            ),
        )
        .expect_err("simulated replace failure");
        assert!(
            err.to_string().contains("未置換のまま")
                || err.to_string().contains("restore.fail_atomic_replace"),
            "err={err}"
        );
        assert!(
            !err.to_string().contains("RESTORE_SESSION_LOST"),
            "unchanged live must not look like session lost: {err}"
        );
        assert_eq!(marker_at(&ws.join("grimodex.db")), "live");
        assert!(
            read_incomplete_restore_session(&ws)
                .expect("marker read")
                .is_none(),
            "marker cleared when live still matches pre-restore digest"
        );
        assert!(state.inner.lock().expect("lock").is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn malformed_restore_marker_with_healthy_db_enters_safe_mode() {
        use crate::backup_restore::restore_session_marker_path;
        use crate::migration_supervisor::{self, WorkspaceOpenDbOutcome};

        let ws = temp_ws("marker-malformed");
        create_migrated_db(&ws.join("grimodex.db"), "healthy");
        fs::create_dir_all(ws.join("backups")).expect("backups");
        fs::write(restore_session_marker_path(&ws), b"{not-valid-json").expect("malformed");

        let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("open");
        match outcome {
            WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
                assert!(
                    reason.contains("RESTORE_SESSION_MARKER_UNREADABLE")
                        || reason.contains("RESTORE_SESSION_MARKER_INVALID"),
                    "reason={reason}"
                );
            }
            other => panic!("expected SafeMode, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_restore_marker_with_healthy_db_enters_safe_mode() {
        use crate::backup_restore::restore_session_marker_path;
        use crate::migration_supervisor::{self, WorkspaceOpenDbOutcome};
        use std::os::unix::fs::PermissionsExt;

        let ws = temp_ws("marker-unreadable");
        create_migrated_db(&ws.join("grimodex.db"), "healthy");
        fs::create_dir_all(ws.join("backups")).expect("backups");
        let marker_path = restore_session_marker_path(&ws);
        fs::write(
            &marker_path,
            br#"{"version":1,"phase":"live-sealed","safetyArtifact":"x","safetyKind":"logical","installedDigest":"abc","workspaceIdentity":"ws"}"#,
        )
        .expect("marker");
        let mut perms = fs::metadata(&marker_path).expect("meta").permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&marker_path, perms).expect("chmod");

        let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("open");
        let mut perms = fs::metadata(&marker_path).expect("meta").permissions();
        perms.set_mode(0o644);
        let _ = fs::set_permissions(&marker_path, perms);

        match outcome {
            WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
                assert!(
                    reason.contains("RESTORE_SESSION_MARKER_UNREADABLE")
                        || reason.contains("RESTORE_SESSION_MARKER_READ_FAILED")
                        || reason.contains("RESTORE_SESSION_MARKER_INVALID"),
                    "reason={reason}"
                );
            }
            other => panic!("expected SafeMode, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn restore_marker_with_missing_live_db_does_not_create_fresh() {
        use crate::backup_restore::{restore_session_marker_path, RestoreSessionMarker};
        use crate::migration_supervisor::{self, WorkspaceOpenDbOutcome};

        let ws = temp_ws("marker-missing-db");
        fs::create_dir_all(ws.join("backups")).expect("backups");
        let marker = RestoreSessionMarker {
            version: 1,
            phase: "live-sealed".into(),
            safety_artifact: ws
                .join("backups/grimodex-pre-restore.db")
                .display()
                .to_string(),
            safety_kind: "logical".into(),
            rollback_artifact: None,
            installed_digest: "deadbeef".into(),
            workspace_identity: "test".into(),
        };
        fs::write(
            restore_session_marker_path(&ws),
            serde_json::to_vec_pretty(&marker).expect("json"),
        )
        .expect("write marker");
        assert!(!ws.join("grimodex.db").exists());

        let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("open");
        match outcome {
            WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
                assert!(
                    reason.contains("RESTORE_SESSION_INCOMPLETE"),
                    "reason={reason}"
                );
            }
            other => panic!("expected SafeMode, got {other:?}"),
        }
        assert!(
            !ws.join("grimodex.db").exists(),
            "must not create a fresh DB over an incomplete restore session"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn safe_mode_restore_after_replace_failpoint_rolls_back_live() {
        use crate::backup_restore::{
            install_staged_workspace_db, InstallStagedOptions, RestoreFailpoint,
        };
        use crate::workspace_lease;

        let ws = temp_ws("restore-fp-replace");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);

        let staged = ws.join("staged-restore.db");
        fs::copy(ws.join("backups/grimodex-auto.db"), &staged).expect("stage");
        let exclusive = workspace_lease::acquire_exclusive_for_migration(&ws).expect("lease");

        let err = install_staged_workspace_db(
            &state,
            &ws,
            &staged,
            InstallStagedOptions::safe_mode_with_failpoint(
                exclusive,
                RestoreFailpoint::AfterReplace,
            ),
        )
        .expect_err("after_replace must fail closed");
        assert!(
            err.to_string().contains("RESTORE_FAILPOINT")
                || err.to_string().contains("restore.after_replace"),
            "err={err}"
        );
        assert_eq!(marker_at(&ws.join("grimodex.db")), "live");
        assert!(state.safe_mode.is_active());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(feature = "test-failpoints")]
    #[test]
    fn safe_mode_restore_after_rollback_snapshot_failpoint_leaves_live() {
        use crate::backup_restore::{
            install_staged_workspace_db, InstallStagedOptions, RestoreFailpoint,
        };
        use crate::workspace_lease;

        let ws = temp_ws("restore-fp-snap");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        commit_wal_only_marker(&ws.join("grimodex.db"));
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let staged = ws.join("staged-restore.db");
        fs::copy(ws.join("backups/grimodex-auto.db"), &staged).expect("stage");
        let exclusive = workspace_lease::acquire_exclusive_for_migration(&ws).expect("lease");

        let err = install_staged_workspace_db(
            &state,
            &ws,
            &staged,
            InstallStagedOptions::safe_mode_with_failpoint(
                exclusive,
                RestoreFailpoint::AfterRollbackSnapshot,
            ),
        )
        .expect_err("pre-replace failpoint must abort");
        assert!(
            err.to_string().contains("restore.after_rollback_snapshot"),
            "err={err}"
        );
        assert_eq!(marker_at(&ws.join("grimodex.db")), "live");
        assert_eq!(
            wal_only_marker_at(&ws.join("grimodex.db")),
            "committed only in wal"
        );
        assert!(
            ws.join("grimodex.db-wal").exists(),
            "live WAL must survive AfterRollbackSnapshot"
        );
        // Persistent safety artifact must already contain the WAL-only row.
        let safety = latest_pre_restore_logical(&ws);
        assert_eq!(wal_only_marker_at(&safety), "committed only in wal");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn safe_mode_restore_aborts_on_live_sidecar_remove_failure_before_replace() {
        let ws = temp_ws("sidecar-abort");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db");
        fs::create_dir(ws.join("grimodex.db-wal")).expect("make undeletable sidecar");

        let error = restore_safe_mode_candidate(&state, &candidate_id)
            .expect_err("sidecar / safety failure must abort restore");

        // C2-ZC authority compatibility is checked before candidate install.
        // A WAL path that is not a file makes that authoritative marker read
        // indeterminate, so restore must stop before sidecar removal/replace.
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_RESTORE_LIVE_MARKER_READ_FAILED"),
            "unexpected error: {error}"
        );
        fs::remove_dir(ws.join("grimodex.db-wal")).expect("remove sidecar dir");
        assert_eq!(marker_at(&ws.join("grimodex.db")), "live");
        assert!(state.safe_mode.is_active());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn safe_mode_restore_of_automatic_backup_reopens_ready() {
        let ws = temp_ws("restore-ready");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db");

        restore_safe_mode_candidate(&state, &candidate_id).expect("restore safe mode candidate");

        assert!(state.safe_mode.is_active());
        let gs_path = GlobalSettingsPath {
            path: ws.join("global-settings.json"),
            write_lock: Mutex::new(()),
        };
        let mut trace = NativeWorkspaceOpenTrace::new(false);
        let mut on_swapped = |_trace: &mut NativeWorkspaceOpenTrace| {};
        let outcome = open_workspace_sync_traced(
            &state,
            &gs_path,
            ws.to_str().expect("utf8 workspace"),
            &mut trace,
            &mut on_swapped,
        )
        .expect("reopen workspace");

        assert!(outcome.is_authority_published());
        assert!(!state.safe_mode.is_active());
        assert_eq!(marker_at(&ws.join("grimodex.db")), "backup");
        let shared = workspace_lease::try_acquire_shared(&ws).expect("shared lease available");
        drop(shared);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn safe_mode_restore_mints_restore_epoch_for_normal_reopen() {
        use crate::migration_supervisor::{self, WorkspaceOpenDbOutcome};

        let ws = temp_ws("restore-epoch-journey");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        {
            let db = Database::new(&ws.join("backups/grimodex-auto.db")).expect("backup db");
            db.execute(
                "INSERT INTO projects (id, title) VALUES ('restore-project', 'restore fixture')",
                &[],
                "seed project",
            )
            .expect("seed project");
            db.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('restore-project-initial', 'restore-project', 0, 'initial',
                         '2026-08-23T00:00:00.000Z')",
                &[],
                "seed epoch",
            )
            .expect("seed epoch");
        }
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db");

        restore_safe_mode_candidate(&state, &candidate_id).expect("safe mode restore");

        // Same shape as a process restart: no marker remains and the next
        // normal open publishes authority. The restored image must already
        // carry the deterministic Restore Epoch generation boundary — a Safe
        // Mode recovery is the same "DB image restore" as a normal restore
        // and must not re-publish the backup's stale Epoch as current.
        let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("reopen");
        let opened = match outcome {
            WorkspaceOpenDbOutcome::Ready { opened, .. }
            | WorkspaceOpenDbOutcome::Migrated { opened, .. } => opened,
            other => panic!("expected published authority, got {other:?}"),
        };
        let rows = opened
            .database
            .execute(
                "SELECT COUNT(*) AS restores,
                        MAX(triggered_by_change_event_uid) AS identity
                   FROM narrative_semantic_epochs
                  WHERE project_id = 'restore-project' AND reason = 'restore'",
                &[],
                "read restore epochs",
            )
            .expect("read restore epochs");
        assert_eq!(rows[0]["restores"].as_i64().unwrap_or_default(), 1);
        assert!(rows[0]["identity"]
            .as_str()
            .unwrap_or_default()
            .starts_with("restore-image-sha256:"));
        drop(opened);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn committed_restore_marker_converges_on_normal_open() {
        use crate::backup_restore::{
            restore_session_marker_path, RestoreSessionMarker, RESTORE_SESSION_PHASE_COMMITTED,
        };
        use crate::migration_supervisor::{self, WorkspaceOpenDbOutcome};

        let ws = temp_ws("marker-committed");
        create_migrated_db(&ws.join("grimodex.db"), "healthy");
        fs::create_dir_all(ws.join("backups")).expect("backups");
        let marker = RestoreSessionMarker {
            version: 1,
            phase: RESTORE_SESSION_PHASE_COMMITTED.into(),
            safety_artifact: "x".into(),
            safety_kind: "logical".into(),
            rollback_artifact: None,
            installed_digest: "deadbeef".into(),
            workspace_identity: migration_supervisor::workspace_identity(&ws),
        };
        fs::write(
            restore_session_marker_path(&ws),
            serde_json::to_vec_pretty(&marker).expect("json"),
        )
        .expect("write committed marker");

        // A committed marker means the restore finished and only its unlink
        // failed: the next open verifies the identity, converges to deletion,
        // and publishes normally instead of a false RESTORE_SESSION_INCOMPLETE.
        let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("open");
        assert!(
            matches!(
                outcome,
                WorkspaceOpenDbOutcome::Ready { .. } | WorkspaceOpenDbOutcome::Migrated { .. }
            ),
            "committed marker must not force Safe Mode"
        );
        drop(outcome);
        assert!(
            !restore_session_marker_path(&ws).exists(),
            "committed marker must be consumed by the open"
        );

        // A committed marker for a different workspace identity is not ours
        // to consume: fail closed into Safe Mode.
        let foreign = RestoreSessionMarker {
            workspace_identity: "some-other-workspace".into(),
            ..marker
        };
        fs::write(
            restore_session_marker_path(&ws),
            serde_json::to_vec_pretty(&foreign).expect("json"),
        )
        .expect("write foreign committed marker");
        let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("open");
        match outcome {
            WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
                assert!(
                    reason.contains("RESTORE_SESSION_INCOMPLETE"),
                    "reason={reason}"
                );
            }
            other => panic!("expected SafeMode for foreign committed marker, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&ws);
    }

    fn commit_wal_only_marker(db_path: &Path) {
        use rusqlite::config::DbConfig;
        use rusqlite::params;
        let conn = rusqlite::Connection::open(db_path).expect("open for dirty WAL");
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .expect("no ckpt");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.pragma_update(None, "wal_autocheckpoint", 0)
            .expect("autocheckpoint");
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            params!["gate-a2.wal-only", "committed only in wal"],
        )
        .expect("wal-only commit");
    }

    fn wal_only_marker_at(db_path: &Path) -> String {
        use rusqlite::config::DbConfig;
        let conn = rusqlite::Connection::open(db_path).expect("open");
        let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = 'gate-a2.wal-only'",
            [],
            |row| row.get(0),
        )
        .expect("wal-only row")
    }

    fn latest_pre_restore_logical(ws: &Path) -> PathBuf {
        let mut paths = fs::read_dir(ws.join("backups"))
            .expect("backups")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("grimodex-pre-restore-") && name.ends_with(".db")
                    })
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths.pop().expect("pre-restore logical artifact")
    }

    fn sha256_of(path: &Path) -> String {
        use sha2::{Digest, Sha256};
        let bytes = fs::read(path).expect("read");
        hex::encode(Sha256::digest(bytes))
    }

    fn write_migration_manifest(db_path: &Path, workspace: &Path) {
        let sha = sha256_of(db_path);
        let size = fs::metadata(db_path).expect("meta").len();
        let manifest = MigrationSnapshotManifest {
            version: 1,
            source_schema_version: grimodex_core::SCHEMA_VERSION,
            target_schema_version: grimodex_core::SCHEMA_VERSION,
            app_version: "test".into(),
            database_file_name: db_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("x.db")
                .to_string(),
            size_bytes: size,
            sha256: sha,
            created_at: Utc::now().to_rfc3339(),
            source_workspace_identity: migration_supervisor::workspace_identity(workspace),
            migration_id: Uuid::new_v4().to_string(),
        };
        fs::write(
            db_path.with_extension("json"),
            serde_json::to_vec_pretty(&manifest).expect("json"),
        )
        .expect("write manifest");
    }

    #[test]
    fn safe_mode_restore_success_retains_pre_restore_artifact_with_wal_row() {
        let ws = temp_ws("retain-safety");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        commit_wal_only_marker(&ws.join("grimodex.db"));
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "backup");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, ".db");

        restore_safe_mode_candidate(&state, &candidate_id).expect("restore");
        let safety = latest_pre_restore_logical(&ws);
        assert_eq!(wal_only_marker_at(&safety), "committed only in wal");
        assert_eq!(marker_at(&ws.join("grimodex.db")), "backup");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn migration_snapshot_content_swap_after_list_is_rejected() {
        let ws = temp_ws("swap-snap");
        fs::create_dir_all(ws.join("backups/migrations")).expect("dirs");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        let before = sha256_of(&ws.join("grimodex.db"));
        let snap = ws.join("backups/migrations/migration-demo.db");
        create_migrated_db(&snap, "snap-a");
        write_migration_manifest(&snap, &ws);
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, "migration-demo.db");

        // Replace snapshot bytes while keeping the same relative key / opaque id.
        create_migrated_db(&snap, "snap-b");

        let err = restore_safe_mode_candidate(&state, &candidate_id)
            .expect_err("swapped snapshot must be rejected");
        assert!(
            err.to_string().contains("RECOVERY_CHECKSUM_INVALID")
                || err.to_string().contains("SIZE_MISMATCH")
                || err.to_string().contains("CHECKSUM"),
            "err={err}"
        );
        assert_eq!(sha256_of(&ws.join("grimodex.db")), before);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn migration_snapshot_without_manifest_is_rejected_on_restore() {
        let ws = temp_ws("no-manifest");
        fs::create_dir_all(ws.join("backups/migrations")).expect("dirs");
        create_migrated_db(&ws.join("grimodex.db"), "live");
        let before = sha256_of(&ws.join("grimodex.db"));
        let snap = ws.join("backups/migrations/migration-demo.db");
        create_migrated_db(&snap, "snap");
        let state = safe_mode_state(&ws);
        let candidate_id = candidate_id_for(&state, "migration-demo.db");

        let err = restore_safe_mode_candidate(&state, &candidate_id)
            .expect_err("missing manifest must refuse restore");
        assert!(
            err.to_string().contains("RECOVERY_MANIFEST_MISSING"),
            "err={err}"
        );
        assert_eq!(sha256_of(&ws.join("grimodex.db")), before);
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn hardlink_candidate_is_skipped_without_blocking_registry() {
        let ws = temp_ws("hardlink-skip");
        create_migrated_db(&ws.join("backups/grimodex-auto.db"), "good");
        let target = ws.join("backups/grimodex-real.db");
        create_migrated_db(&target, "linked");
        let link = ws.join("backups/grimodex-hardlink.db");
        fs::hard_link(&target, &link).expect("hardlink");

        let registry = build_candidate_registry(&ws).expect("registry must succeed");
        assert!(
            registry
                .values()
                .any(|record| { record.relative_key == "grimodex-auto.db" }),
            "valid backup must remain listed: {registry:?}"
        );
        assert!(
            registry
                .values()
                .all(|record| record.relative_key != "grimodex-hardlink.db"),
            "hardlink candidate must be skipped"
        );
        let _ = fs::remove_dir_all(&ws);
    }
}
