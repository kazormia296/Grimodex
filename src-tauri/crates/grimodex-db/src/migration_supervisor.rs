//! Transactional Migration Supervisor (Release Gate A).
//!
//! Workspace open never runs schema DDL on the live `grimodex.db` for upgrades.
//! Instead it:
//! 1. acquires a shared lease and inspects the live DB
//! 2. on upgrade: drops shared, takes exclusive, re-inspects, seals WAL
//! 3. creates a checksummed migration snapshot under `backups/migrations/`
//! 4. migrates a staged copy, seals it, and records an installed-image digest
//!    from that sealed staged file
//! 5. atomically replaces the live DB; post-replace failures **while exclusive
//!    is still held** roll back from the verified snapshot and return
//!    restore-only Safe Mode (no Database authority)
//! 6. after a verified install, exclusive is dropped and shared is waited with
//!    timeout; handoff failure does **not** blind-rollback (another authority
//!    may have already published a newer live image)
//!
//! Same-schema opens keep the shared lease for the returned
//! [`OpenedWorkspaceDb`] lifetime. Newer-than-supported schemas return Safe Mode
//! without mutating the live DB.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

use crate::backup_restore::{list_backups_in, BackupInfo};
use crate::error::{AppError, AppResult};
use crate::workspace_lease::{self, WorkspaceLease};
use crate::Database;
use grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants;
use grimodex_core::SCHEMA_VERSION;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failpoint {
    AfterSnapshot,
    AfterStagedCopy,
    AfterMigrate,
    AfterReplace,
    BeforeReopen,
    ReopenFailure,
    /// After verified install + exclusive drop: fail shared handoff without
    /// rolling the live DB back to the pre-migration snapshot.
    SharedHandoffBusy,
    ChecksumMismatch,
    DiskFull,
}

impl Failpoint {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AfterSnapshot => "migration.after_snapshot",
            Self::AfterStagedCopy => "migration.after_staged_copy",
            Self::AfterMigrate => "migration.after_migrate",
            Self::AfterReplace => "migration.after_replace",
            Self::BeforeReopen => "migration.before_reopen",
            Self::ReopenFailure => "migration.reopen_failure",
            Self::SharedHandoffBusy => "migration.shared_handoff_busy",
            Self::ChecksumMismatch => "migration.checksum_mismatch",
            Self::DiskFull => "migration.disk_full",
        }
    }
}

/// CAS token for a live SQLite image installed under exclusive lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledImageToken {
    pub digest: String,
    pub schema_version: i32,
    pub migration_id: Option<String>,
}

const HANDOFF_SHARED_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum MigrationSupervisorError {
    #[error("{0}")]
    Message(String),
    #[error("{}", .0.as_str())]
    Failpoint(Failpoint),
    #[error("{0}")]
    Lease(#[from] workspace_lease::LeaseError),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl From<MigrationSupervisorError> for AppError {
    fn from(value: MigrationSupervisorError) -> Self {
        AppError::Anyhow(anyhow::anyhow!("{value}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSnapshotManifest {
    pub version: u32,
    pub source_schema_version: i32,
    pub target_schema_version: i32,
    pub app_version: String,
    pub database_file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub created_at: String,
    pub source_workspace_identity: String,
    pub migration_id: String,
}

/// Opened workspace DB plus the shared lease that must outlive the authority.
pub struct OpenedWorkspaceDb {
    pub database: Database,
    pub lease: WorkspaceLease,
}

impl std::fmt::Debug for OpenedWorkspaceDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenedWorkspaceDb")
            .field("lease_mode", &self.lease.mode())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceSchemaInspection {
    pub current_schema_version: i32,
    pub target_schema_version: i32,
    pub database_size_bytes: u64,
    pub wal_size_bytes: u64,
    pub quick_check_ok: bool,
}

pub enum WorkspaceOpenDbOutcome {
    Ready {
        opened: OpenedWorkspaceDb,
        from_schema: i32,
        to_schema: i32,
    },
    Migrated {
        opened: OpenedWorkspaceDb,
        from_schema: i32,
        to_schema: i32,
        receipt_path: PathBuf,
    },
    /// Live DB was restored to the pre-migration image (or never replaced).
    /// Callers must enter restore-only Safe Mode — do **not** publish Database
    /// authority or continue normal open (Optimize / FTS / Project hydration).
    RecoveryRequired {
        reason: String,
        error_code: String,
        snapshot_path: PathBuf,
        available_backups: Vec<BackupInfo>,
    },
    SafeMode {
        reason: String,
        available_backups: Vec<BackupInfo>,
    },
}

impl std::fmt::Debug for WorkspaceOpenDbOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ready {
                from_schema,
                to_schema,
                ..
            } => f
                .debug_struct("Ready")
                .field("from_schema", from_schema)
                .field("to_schema", to_schema)
                .finish_non_exhaustive(),
            Self::Migrated {
                from_schema,
                to_schema,
                receipt_path,
                ..
            } => f
                .debug_struct("Migrated")
                .field("from_schema", from_schema)
                .field("to_schema", to_schema)
                .field("receipt_path", receipt_path)
                .finish_non_exhaustive(),
            Self::RecoveryRequired {
                reason,
                error_code,
                snapshot_path,
                available_backups,
            } => f
                .debug_struct("RecoveryRequired")
                .field("reason", reason)
                .field("error_code", error_code)
                .field("snapshot_path", snapshot_path)
                .field("available_backups", available_backups)
                .finish(),
            Self::SafeMode {
                reason,
                available_backups,
            } => f
                .debug_struct("SafeMode")
                .field("reason", reason)
                .field("available_backups", available_backups)
                .finish(),
        }
    }
}

pub fn open_or_migrate_workspace_db(
    workspace: &Path,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    open_or_migrate_workspace_db_with_failpoint(workspace, None)
}

pub fn open_or_migrate_workspace_db_with_failpoint(
    workspace: &Path,
    failpoint: Option<Failpoint>,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    fs::create_dir_all(workspace)?;
    let db_path = workspace.join("grimodex.db");

    if !db_path.exists() {
        return create_fresh_workspace_db(workspace, &db_path, failpoint);
    }

    // Shared lease covers inspect + same-schema authority. Upgrade drops it
    // before exclusive acquisition (caller must already have quiesced any
    // in-process ActiveWorkspace for this path).
    let shared = workspace_lease::try_acquire_shared(workspace)?;
    let inspection = match inspect_workspace_schema(workspace, &db_path) {
        Ok(inspection) => inspection,
        Err(error) => {
            drop(shared);
            return disposition_pre_replace_failure(workspace, error);
        }
    };
    if inspection.current_schema_version > inspection.target_schema_version {
        drop(shared);
        return Ok(WorkspaceOpenDbOutcome::SafeMode {
            reason: format!(
                "WORKSPACE_SAFE_MODE: workspace schema version {} is newer than supported version {}",
                inspection.current_schema_version, inspection.target_schema_version
            ),
            available_backups: list_recovery_candidates(workspace),
        });
    }

    let invariants = match live_invariants_ok(&db_path) {
        Ok(ok) => ok,
        Err(error) => {
            drop(shared);
            return disposition_pre_replace_failure(workspace, error);
        }
    };

    if inspection.current_schema_version == inspection.target_schema_version
        && inspection.quick_check_ok
        && invariants
    {
        return open_same_schema_fast_path(shared, &db_path, &inspection);
    }

    drop(shared);
    shadow_migrate(workspace, &db_path, failpoint)
}

fn open_same_schema_fast_path(
    shared: WorkspaceLease,
    db_path: &Path,
    inspection: &WorkspaceSchemaInspection,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    let database = Database::new(db_path)?;
    // Gate A: never run full schema DDL on the live fast path.
    database.recover_open_time_state_without_schema_ddl()?;
    Ok(WorkspaceOpenDbOutcome::Ready {
        opened: OpenedWorkspaceDb {
            database,
            lease: shared,
        },
        from_schema: inspection.current_schema_version,
        to_schema: inspection.target_schema_version,
    })
}

fn create_fresh_workspace_db(
    workspace: &Path,
    db_path: &Path,
    failpoint: Option<Failpoint>,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    let exclusive = workspace_lease::acquire_exclusive_for_migration(workspace)?;
    let staged = sibling(db_path, &format!(".migration-{}", Uuid::new_v4()));
    let mut staged_cleanup = Cleanup::new(staged.clone());
    {
        let db = Database::new(&staged)?;
        db.migrate()?;
        verify_migrated_db(&staged)?;
        drop(db);
        seal_sqlite_image(&staged)?;
    }
    hit_failpoint(failpoint, Failpoint::AfterMigrate)?;
    atomic_replace(&staged, db_path)?;
    staged_cleanup.disarm();
    let opened = reopen_under_shared_lease(workspace, exclusive)?;
    Ok(WorkspaceOpenDbOutcome::Ready {
        opened,
        from_schema: 0,
        to_schema: SCHEMA_VERSION,
    })
}

fn shadow_migrate(
    workspace: &Path,
    db_path: &Path,
    failpoint: Option<Failpoint>,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    let exclusive = workspace_lease::acquire_exclusive_for_migration(workspace)?;

    // Exclusive 取得後に再検査 — inspect→exclusive の間に状態が変わり得る。
    let inspection = match inspect_workspace_schema(workspace, db_path) {
        Ok(inspection) => inspection,
        Err(error) => {
            drop(exclusive);
            return disposition_pre_replace_failure(workspace, error);
        }
    };
    if inspection.current_schema_version > inspection.target_schema_version {
        drop(exclusive);
        return Ok(WorkspaceOpenDbOutcome::SafeMode {
            reason: format!(
                "WORKSPACE_SAFE_MODE: workspace schema version {} is newer than supported version {}",
                inspection.current_schema_version, inspection.target_schema_version
            ),
            available_backups: list_recovery_candidates(workspace),
        });
    }
    let invariants_ok = match live_invariants_ok(db_path) {
        Ok(ok) => ok,
        Err(error) => {
            drop(exclusive);
            return disposition_pre_replace_failure(workspace, error);
        }
    };
    if inspection.current_schema_version == inspection.target_schema_version
        && inspection.quick_check_ok
        && invariants_ok
    {
        drop(exclusive);
        let shared = workspace_lease::try_acquire_shared(workspace)?;
        return open_same_schema_fast_path(shared, db_path, &inspection);
    }

    if let Err(error) = ensure_disk_budget(workspace, &inspection, failpoint) {
        drop(exclusive);
        return Err(error);
    }

    let snapshot = match create_migration_snapshot(workspace, db_path, &inspection) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            drop(exclusive);
            return disposition_pre_replace_failure(workspace, error);
        }
    };
    if let Err(error) = hit_failpoint(failpoint, Failpoint::AfterSnapshot) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }

    if failpoint == Some(Failpoint::ChecksumMismatch) {
        drop(exclusive);
        return Ok(WorkspaceOpenDbOutcome::SafeMode {
            reason: format!(
                "WORKSPACE_SAFE_MODE: MIGRATION_SNAPSHOT_CHECKSUM_FAILED; snapshot={}",
                snapshot.db_path.display()
            ),
            available_backups: list_recovery_candidates(workspace),
        });
    }
    if let Err(error) = verify_snapshot_checksum(&snapshot) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }

    let staged = sibling(db_path, &format!(".migration-{}", Uuid::new_v4()));
    let mut staged_cleanup = Cleanup::new(staged.clone());
    if let Err(error) = fs::copy(&snapshot.db_path, &staged) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }
    if let Err(error) = remove_db_sidecars(&staged) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }
    if let Err(error) = hit_failpoint(failpoint, Failpoint::AfterStagedCopy) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }

    let migrate_result = (|| -> Result<InstalledImageToken, MigrationSupervisorError> {
        let db = Database::new(&staged)?;
        db.migrate_for_restore_preflight()?;
        verify_migrated_db(&staged)?;
        // Seal staged before publish so live replace never carries WAL/SHM.
        drop(db);
        seal_sqlite_image(&staged)?;
        // Capture CAS token from the sealed staged image *before* live replace so
        // post-replace seal/sync is not required to know what we installed.
        installed_image_token_from_sealed(
            &staged,
            SCHEMA_VERSION,
            Some(snapshot.migration_id.clone()),
        )
    })();
    let installed = match migrate_result {
        Ok(token) => token,
        Err(error) => {
            drop(exclusive);
            return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
        }
    };
    if let Err(error) = hit_failpoint(failpoint, Failpoint::AfterMigrate) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }

    // Seal live image before any replacement. Rollback source is the verified
    // migration snapshot (not a raw main-file copy that can omit WAL frames).
    if let Err(error) = seal_sqlite_image(db_path) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }

    if let Err(error) = atomic_replace(&staged, db_path) {
        drop(exclusive);
        return safe_mode_after_snapshot(workspace, &snapshot, error.to_string());
    }
    staged_cleanup.disarm();

    // --- LiveReplaced: failures while exclusive is still held roll back from
    // the verified snapshot. After exclusive→shared handoff, never blind-rollback.
    finish_after_live_replaced(
        workspace,
        db_path,
        &snapshot,
        &inspection,
        installed,
        exclusive,
        failpoint,
    )
}

/// Pre-replace failures that indicate the live DB / migration pipeline cannot
/// proceed safely → structured Safe Mode (Recovery Shell). Retryable I/O /
/// lease / path errors stay as `Err`.
fn disposition_pre_replace_failure(
    workspace: &Path,
    error: MigrationSupervisorError,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    if is_retryable_non_safe_mode_error(&error) {
        return Err(error);
    }
    Ok(WorkspaceOpenDbOutcome::SafeMode {
        reason: format!("WORKSPACE_SAFE_MODE: {error}"),
        available_backups: list_recovery_candidates(workspace),
    })
}

fn safe_mode_after_snapshot(
    workspace: &Path,
    snapshot: &SnapshotArtifacts,
    detail: String,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    Ok(WorkspaceOpenDbOutcome::SafeMode {
        reason: format!(
            "WORKSPACE_SAFE_MODE: {detail}; snapshot={}",
            snapshot.db_path.display()
        ),
        available_backups: list_recovery_candidates(workspace),
    })
}

fn is_retryable_non_safe_mode_error(error: &MigrationSupervisorError) -> bool {
    match error {
        MigrationSupervisorError::Lease(lease) => matches!(
            lease,
            crate::workspace_lease::LeaseError::Busy { .. }
                | crate::workspace_lease::LeaseError::Io(_)
        ),
        MigrationSupervisorError::Io(io_error) => matches!(
            io_error.kind(),
            io::ErrorKind::PermissionDenied
                | io::ErrorKind::NotFound
                | io::ErrorKind::WouldBlock
                | io::ErrorKind::TimedOut
                | io::ErrorKind::Interrupted
        ),
        MigrationSupervisorError::Message(message) => {
            let upper = message.to_uppercase();
            upper.contains("PERMISSION")
                || upper.contains("ACCESS DENIED")
                || upper.contains("WORKSPACE_PATH")
                || upper.contains("INVALID WORKSPACE")
                || upper.contains("INSUFFICIENT DISK")
                || upper.contains("DISK_FULL")
                || upper.contains("DISK SPACE")
                || (upper.contains("LEASE")
                    && (upper.contains("BUSY") || upper.contains("TIMEOUT")))
        }
        MigrationSupervisorError::Failpoint(Failpoint::DiskFull) => true,
        MigrationSupervisorError::Failpoint(_) => false,
        // Integrity / schema / sqlite open failures → Safe Mode.
        MigrationSupervisorError::Anyhow(_) | MigrationSupervisorError::Sqlite(_) => false,
    }
}

fn finish_after_live_replaced(
    workspace: &Path,
    db_path: &Path,
    snapshot: &SnapshotArtifacts,
    inspection: &WorkspaceSchemaInspection,
    installed: InstalledImageToken,
    exclusive: WorkspaceLease,
    failpoint: Option<Failpoint>,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    if let Err(error) = hit_failpoint(failpoint, Failpoint::AfterReplace) {
        return rollback_after_live_replaced(
            workspace,
            db_path,
            snapshot,
            "MIGRATION_AFTER_REPLACE_FAILED",
            error.to_string(),
            exclusive,
        );
    }
    if let Err(error) = hit_failpoint(failpoint, Failpoint::BeforeReopen) {
        return rollback_after_live_replaced(
            workspace,
            db_path,
            snapshot,
            "MIGRATION_BEFORE_REOPEN_FAILED",
            error.to_string(),
            exclusive,
        );
    }

    // Verify under exclusive with a temporary connection, then close all handles
    // before the exclusive→shared handoff (no DB may remain open unlocked).
    if let Err(error) = verify_migrated_db(db_path) {
        return rollback_after_live_replaced(
            workspace,
            db_path,
            snapshot,
            "MIGRATION_REOPEN_FAILED",
            error.to_string(),
            exclusive,
        );
    }
    if failpoint == Some(Failpoint::ReopenFailure) {
        return rollback_after_live_replaced(
            workspace,
            db_path,
            snapshot,
            "MIGRATION_REOPEN_FAILED",
            "injected reopen failure".to_string(),
            exclusive,
        );
    }

    let receipt_path = match write_receipt(workspace, snapshot, inspection) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("migration receipt write failed after successful verify: {error}");
            snapshot.manifest_path.clone()
        }
    };

    // Shared-lease failure after verified install must NOT blind-rollback:
    // another process may have completed restore/migration in the gap.
    match handoff_verified_live_to_shared(workspace, exclusive, "MIGRATION_HANDOFF_BUSY", failpoint)
    {
        Ok(opened) => Ok(WorkspaceOpenDbOutcome::Migrated {
            opened,
            from_schema: inspection.current_schema_version,
            to_schema: SCHEMA_VERSION,
            receipt_path,
        }),
        Err(error) => {
            let detail = error.to_string();
            if detail.contains("WORKSPACE_SAFE_MODE") {
                Ok(WorkspaceOpenDbOutcome::SafeMode {
                    reason: detail,
                    available_backups: list_recovery_candidates(workspace),
                })
            } else {
                // Live remains the verified migrated image. Snapshot stays on disk.
                Err(MigrationSupervisorError::Message(format!(
                    "{detail}; installedDigest={} migrationId={}",
                    installed.digest,
                    installed.migration_id.as_deref().unwrap_or("-")
                )))
            }
        }
    }
}

/// Build a CAS token from an already-sealed SQLite image (hash only, no re-seal).
pub fn installed_image_token_from_sealed(
    sealed_path: &Path,
    schema_version: i32,
    migration_id: Option<String>,
) -> Result<InstalledImageToken, MigrationSupervisorError> {
    let digest = sha256_file(sealed_path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "hash sealed SQLite image {}: {error}",
                sealed_path.display()
            ),
        )
    })?;
    Ok(InstalledImageToken {
        digest,
        schema_version,
        migration_id,
    })
}

/// Seal a path then capture its installed-image token.
pub fn capture_installed_image(
    db_path: &Path,
    schema_version: i32,
    migration_id: Option<String>,
) -> Result<InstalledImageToken, MigrationSupervisorError> {
    seal_sqlite_image(db_path)?;
    installed_image_token_from_sealed(db_path, schema_version, migration_id)
}

/// True when the sealed live DB still matches `installed.digest`.
pub fn installed_image_unchanged(
    db_path: &Path,
    installed: &InstalledImageToken,
) -> Result<bool, MigrationSupervisorError> {
    if !db_path.exists() {
        return Ok(false);
    }
    seal_sqlite_image(db_path)?;
    let digest = sha256_file(db_path)?;
    Ok(digest == installed.digest)
}

/// Under a fresh exclusive lease: if live still equals `installed`, apply
/// `rollback_path` onto the live DB. Otherwise leave live untouched.
///
/// Returns the exclusive lease after a successful rollback so the caller can
/// hand off to shared. On digest mismatch returns `*_HANDOFF_CONFLICT`.
pub fn rollback_if_installed_image_unchanged(
    workspace: &Path,
    db_path: &Path,
    rollback_path: &Path,
    installed: &InstalledImageToken,
    conflict_code: &str,
) -> Result<WorkspaceLease, MigrationSupervisorError> {
    let exclusive = workspace_lease::acquire_exclusive_for_migration(workspace)?;
    if !installed_image_unchanged(db_path, installed)? {
        drop(exclusive);
        return Err(MigrationSupervisorError::Message(format!(
            "{conflict_code}: live DB no longer matches the installed image digest {}; leaving live untouched; rollback artifact at {}",
            installed.digest,
            rollback_path.display()
        )));
    }
    remove_db_sidecars(db_path)?;
    let staged_rollback = sibling(db_path, &format!(".handoff-rollback-{}", Uuid::new_v4()));
    let mut staged_cleanup = Cleanup::new(staged_rollback.clone());
    fs::copy(rollback_path, &staged_rollback)?;
    remove_db_sidecars(&staged_rollback)?;
    seal_sqlite_image(&staged_rollback)?;
    atomic_replace(&staged_rollback, db_path)?;
    staged_cleanup.disarm();
    Ok(exclusive)
}

/// Close exclusive, wait for shared (timeout), then open+reinspect the live DB.
///
/// Callers must drop every Database handle on `workspace` before invoking this.
/// After exclusive is dropped this never rolls live back.
pub fn reopen_under_shared_lease(
    workspace: &Path,
    exclusive: WorkspaceLease,
) -> Result<OpenedWorkspaceDb, MigrationSupervisorError> {
    handoff_verified_live_to_shared(workspace, exclusive, "MIGRATION_HANDOFF_BUSY", None)
}

/// Like [`reopen_under_shared_lease`] but uses a restore-specific busy code.
pub fn reopen_under_shared_lease_for_restore(
    workspace: &Path,
    exclusive: WorkspaceLease,
) -> Result<OpenedWorkspaceDb, MigrationSupervisorError> {
    handoff_verified_live_to_shared(workspace, exclusive, "RESTORE_HANDOFF_BUSY", None)
}

fn handoff_verified_live_to_shared(
    workspace: &Path,
    exclusive: WorkspaceLease,
    busy_code: &str,
    failpoint: Option<Failpoint>,
) -> Result<OpenedWorkspaceDb, MigrationSupervisorError> {
    drop(exclusive);
    if let Err(error) = hit_failpoint(failpoint, Failpoint::SharedHandoffBusy) {
        return Err(MigrationSupervisorError::Message(format!(
            "{busy_code}: {error}"
        )));
    }
    let lease = match workspace_lease::acquire_shared(workspace, HANDOFF_SHARED_TIMEOUT) {
        Ok(lease) => lease,
        Err(workspace_lease::LeaseError::Busy { .. }) => {
            return Err(MigrationSupervisorError::Message(format!(
                "{busy_code}: timed out waiting for shared lease after verified live install"
            )));
        }
        Err(error) => return Err(error.into()),
    };
    let db_path = workspace.join("grimodex.db");
    let database = Database::new(&db_path)?;
    reinspect_current_authority(&database)?;
    database.recover_open_time_state_without_schema_ddl()?;
    Ok(OpenedWorkspaceDb { database, lease })
}

/// DDL-free reopen of an already-current live DB under a shared lease.
///
/// Used for same-path pre-replace failure recovery and restore reactivation.
/// Never runs schema migration DDL; mismatches return
/// `WORKSPACE_REACTIVATION_FAILED` / Safe Mode style errors.
pub fn reopen_existing_current_authority(
    workspace: &Path,
) -> Result<OpenedWorkspaceDb, MigrationSupervisorError> {
    let lease = workspace_lease::try_acquire_shared(workspace).map_err(|error| {
        MigrationSupervisorError::Message(format!(
            "WORKSPACE_REACTIVATION_FAILED: shared lease: {error}"
        ))
    })?;
    let db_path = workspace.join("grimodex.db");
    if !db_path.exists() {
        drop(lease);
        return Err(MigrationSupervisorError::Message(
            "WORKSPACE_REACTIVATION_FAILED: grimodex.db is missing".to_string(),
        ));
    }
    let database = Database::new(&db_path).map_err(|error| {
        MigrationSupervisorError::Message(format!(
            "WORKSPACE_REACTIVATION_FAILED: open failed: {error}"
        ))
    })?;
    reinspect_current_authority(&database).map_err(|error| {
        MigrationSupervisorError::Message(format!("WORKSPACE_REACTIVATION_FAILED: {error}"))
    })?;
    database
        .recover_open_time_state_without_schema_ddl()
        .map_err(|error| {
            MigrationSupervisorError::Message(format!(
                "WORKSPACE_REACTIVATION_FAILED: open-time recovery: {error}"
            ))
        })?;
    Ok(OpenedWorkspaceDb { database, lease })
}

fn reinspect_current_authority(database: &Database) -> Result<(), MigrationSupervisorError> {
    let version: i32 = database
        .with_conn(|conn| Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?))?;
    if version != SCHEMA_VERSION {
        return Err(MigrationSupervisorError::Message(format!(
            "WORKSPACE_SAFE_MODE: reopened db user_version {version} != {SCHEMA_VERSION}"
        )));
    }
    let ok = database.with_conn(has_current_schema_checkpoint_invariants)?;
    if !ok {
        return Err(MigrationSupervisorError::Message(
            "WORKSPACE_SAFE_MODE: reopened db failed current schema invariants".to_string(),
        ));
    }
    if let Some(error) = database.quick_check()? {
        return Err(MigrationSupervisorError::Message(format!(
            "MIGRATION_SOURCE_INTEGRITY_FAILED: reopened quick_check={error}"
        )));
    }
    Ok(())
}

fn rollback_after_live_replaced(
    workspace: &Path,
    db_path: &Path,
    snapshot: &SnapshotArtifacts,
    error_code: &str,
    detail: String,
    exclusive: WorkspaceLease,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    // Keep exclusive while restoring. Never Cleanup-delete the snapshot.
    let restore_result = (|| -> Result<(), MigrationSupervisorError> {
        // Drop any WAL/SHM created by a failed reopen before restoring.
        remove_db_sidecars(db_path)?;
        let staged_rollback = sibling(db_path, &format!(".migration-rollback-{}", Uuid::new_v4()));
        let mut staged_cleanup = Cleanup::new(staged_rollback.clone());
        fs::copy(&snapshot.db_path, &staged_rollback)?;
        remove_db_sidecars(&staged_rollback)?;
        seal_sqlite_image(&staged_rollback)?;
        atomic_replace(&staged_rollback, db_path)?;
        staged_cleanup.disarm();
        Ok(())
    })();

    match restore_result {
        Ok(()) => {
            drop(exclusive);
            Ok(WorkspaceOpenDbOutcome::RecoveryRequired {
                reason: format!(
                    "WORKSPACE_SAFE_MODE: migration failed after live replace; restored pre-migration snapshot. {detail}"
                ),
                error_code: error_code.to_string(),
                snapshot_path: snapshot.db_path.clone(),
                available_backups: list_recovery_candidates(workspace),
            })
        }
        Err(rollback_error) => {
            // Preserve exclusive holder until caller observes the error, then
            // drop so operators can still inspect. Snapshot must remain on disk.
            drop(exclusive);
            Err(MigrationSupervisorError::Message(format!(
                "MIGRATION_SESSION_LOST: rollbackPath={} detail={detail}; rollback={rollback_error}",
                snapshot.db_path.display()
            )))
        }
    }
}

struct SnapshotArtifacts {
    db_path: PathBuf,
    manifest_path: PathBuf,
    sha256: String,
    migration_id: String,
}

fn create_migration_snapshot(
    workspace: &Path,
    db_path: &Path,
    inspection: &WorkspaceSchemaInspection,
) -> Result<SnapshotArtifacts, MigrationSupervisorError> {
    let migrations_dir = workspace.join("backups/migrations");
    fs::create_dir_all(&migrations_dir)?;
    let probe = migrations_dir.join(format!(".write-probe-{}", Uuid::new_v4()));
    File::create(&probe).map_err(|e| {
        MigrationSupervisorError::Message(format!("MIGRATION_BACKUP_DIRECTORY_UNWRITABLE: {e}"))
    })?;
    let _ = fs::remove_file(&probe);

    let migration_id = Uuid::new_v4().to_string();
    let stamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
    let base = format!(
        "migration-{stamp}-schema-{}-to-{}-{migration_id}",
        inspection.current_schema_version, SCHEMA_VERSION
    );
    let snap_path = migrations_dir.join(format!("{base}.db"));
    let manifest_path = migrations_dir.join(format!("{base}.json"));

    // Prefer VACUUM INTO for a consistent snapshot. Do not run slim_backup_copy:
    // legacy schemas may lack derived tables that slim expects.
    {
        let conn = rusqlite::Connection::open(db_path)?;
        let (busy, _, _): (i64, i64, i64) =
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
        if busy != 0 {
            return Err(MigrationSupervisorError::Message(format!(
                "MIGRATION_WAL_SEAL_FAILED: snapshot checkpoint busy={busy}"
            )));
        }
        if snap_path.exists() {
            fs::remove_file(&snap_path)?;
        }
        let snap_str = snap_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("snapshot path is not valid UTF-8"))?;
        conn.execute("VACUUM INTO ?1", rusqlite::params![snap_str])?;
    }
    if let Some(error) = Database::new(&snap_path)?.quick_check()? {
        return Err(MigrationSupervisorError::Message(format!(
            "MIGRATION_SOURCE_INTEGRITY_FAILED: snapshot quick_check failed: {error}"
        )));
    }

    let sha256 = sha256_file(&snap_path)?;
    let size_bytes = fs::metadata(&snap_path)?.len();
    let identity = workspace_identity(workspace);
    let manifest = MigrationSnapshotManifest {
        version: 1,
        source_schema_version: inspection.current_schema_version,
        target_schema_version: SCHEMA_VERSION,
        app_version: resolved_app_version(),
        database_file_name: snap_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("grimodex.db")
            .to_string(),
        size_bytes,
        sha256: sha256.clone(),
        created_at: Utc::now().to_rfc3339(),
        source_workspace_identity: identity,
        migration_id: migration_id.clone(),
    };
    write_json_atomic(&manifest_path, &manifest)?;
    sync_file(&snap_path)?;

    Ok(SnapshotArtifacts {
        db_path: snap_path,
        manifest_path,
        sha256,
        migration_id,
    })
}

fn verify_snapshot_checksum(snapshot: &SnapshotArtifacts) -> Result<(), MigrationSupervisorError> {
    let actual = sha256_file(&snapshot.db_path)?;
    if actual != snapshot.sha256 {
        return Err(MigrationSupervisorError::Message(
            "MIGRATION_SOURCE_INTEGRITY_FAILED: snapshot checksum mismatch".to_string(),
        ));
    }
    Ok(())
}

fn write_receipt(
    workspace: &Path,
    snapshot: &SnapshotArtifacts,
    inspection: &WorkspaceSchemaInspection,
) -> Result<PathBuf, MigrationSupervisorError> {
    let receipt_dir = workspace.join("backups/migrations");
    let stamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
    let receipt_path = receipt_dir.join(format!(
        "receipt-{}-to-{}-{}-{}.json",
        inspection.current_schema_version, SCHEMA_VERSION, stamp, snapshot.migration_id
    ));
    let body = serde_json::json!({
        "version": 1,
        "migrationId": snapshot.migration_id,
        "fromSchema": inspection.current_schema_version,
        "toSchema": SCHEMA_VERSION,
        "appVersion": resolved_app_version(),
        "snapshot": snapshot.db_path.file_name().and_then(|s| s.to_str()),
        "snapshotSha256": snapshot.sha256,
        "manifest": snapshot.manifest_path.file_name().and_then(|s| s.to_str()),
        "manifestSha256": sha256_file(&snapshot.manifest_path).ok(),
        "completedAt": Utc::now().to_rfc3339(),
    });
    write_json_atomic(&receipt_path, &body)?;
    Ok(receipt_path)
}

/// App version for migration metadata. Prefer runtime/shell injection over the
/// grimodex-db crate version (which is always 0.1.0).
pub fn resolved_app_version() -> String {
    std::env::var("GRIMODEX_APP_VERSION")
        .or_else(|_| std::env::var("npm_package_version"))
        .unwrap_or_else(|_| {
            option_env!("GRIMODEX_APP_VERSION")
                .unwrap_or("unknown")
                .to_string()
        })
}

pub fn inspect_workspace_schema(
    workspace: &Path,
    db_path: &Path,
) -> Result<WorkspaceSchemaInspection, MigrationSupervisorError> {
    let _ = workspace;
    let meta = fs::metadata(db_path)?;
    let wal_size = fs::metadata(sidecar(db_path, "-wal"))
        .map(|m| m.len())
        .unwrap_or(0);
    let conn =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let current: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let quick: String = conn
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .unwrap_or_else(|_| "error".to_string());
    if quick != "ok" {
        return Err(MigrationSupervisorError::Message(format!(
            "MIGRATION_SOURCE_INTEGRITY_FAILED: live quick_check={quick}"
        )));
    }
    Ok(WorkspaceSchemaInspection {
        current_schema_version: current,
        target_schema_version: SCHEMA_VERSION,
        database_size_bytes: meta.len(),
        wal_size_bytes: wal_size,
        quick_check_ok: true,
    })
}

fn live_invariants_ok(db_path: &Path) -> Result<bool, MigrationSupervisorError> {
    let conn =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(has_current_schema_checkpoint_invariants(&conn)?)
}

fn verify_migrated_db(path: &Path) -> anyhow::Result<()> {
    let db = Database::new(path)?;
    let version: i32 =
        db.with_conn(|conn| Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?))?;
    anyhow::ensure!(
        version == SCHEMA_VERSION,
        "migrated db user_version {version} != {SCHEMA_VERSION}"
    );
    let ok = db.with_conn(has_current_schema_checkpoint_invariants)?;
    anyhow::ensure!(ok, "migrated db failed schema checkpoint invariants");
    if let Some(error) = db.quick_check()? {
        anyhow::bail!("migrated db quick_check failed: {error}");
    }
    let fk_violations: i64 = db.with_conn(|conn| {
        let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
        let count = stmt.query_map([], |_| Ok(()))?.count();
        Ok(count as i64)
    })?;
    anyhow::ensure!(fk_violations == 0, "foreign_key_check reported violations");
    drop(db);
    let _reopen = Database::new(path)?;
    Ok(())
}

fn ensure_disk_budget(
    workspace: &Path,
    inspection: &WorkspaceSchemaInspection,
    failpoint: Option<Failpoint>,
) -> Result<(), MigrationSupervisorError> {
    if failpoint == Some(Failpoint::DiskFull) {
        return Err(MigrationSupervisorError::Failpoint(Failpoint::DiskFull));
    }
    let required = inspection
        .database_size_bytes
        .saturating_mul(3)
        .saturating_add(inspection.wal_size_bytes)
        .saturating_add(64 * 1024 * 1024);
    if let Some(available) = available_bytes(workspace) {
        if available < required {
            return Err(MigrationSupervisorError::Message(format!(
                "MIGRATION_INSUFFICIENT_DISK_SPACE: need {required} bytes, have {available}"
            )));
        }
    }
    Ok(())
}

fn available_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let path_str = path.to_str()?;
        let c_path = CString::new(path_str).ok()?;
        // SAFETY: c_path is a valid NUL-terminated path; stat is stack-local.
        unsafe {
            let mut stat: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c_path.as_ptr(), &mut stat) == 0 {
                return Some(stat.f_bavail as u64 * stat.f_frsize as u64);
            }
        }
        None
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_bytes: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        // SAFETY: wide is NUL-terminated; out pointers are stack locals.
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_bytes, &mut total, &mut total_free)
        };
        if ok != 0 {
            Some(free_bytes)
        } else {
            None
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

/// Fail-closed seal: checkpoint WAL (busy must be 0), close, remove sidecars,
/// sync the main DB file.
pub fn seal_sqlite_image(db_path: &Path) -> Result<(), MigrationSupervisorError> {
    {
        let conn = rusqlite::Connection::open(db_path)?;
        let (busy, _log, _checkpointed): (i64, i64, i64) =
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
        if busy != 0 {
            return Err(MigrationSupervisorError::Message(format!(
                "MIGRATION_WAL_SEAL_FAILED: wal_checkpoint busy={busy}"
            )));
        }
    }
    remove_db_sidecars(db_path)?;
    sync_file(db_path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("sync sealed SQLite image {}: {error}", db_path.display()),
        )
    })?;
    Ok(())
}

fn hit_failpoint(
    configured: Option<Failpoint>,
    point: Failpoint,
) -> Result<(), MigrationSupervisorError> {
    #[cfg(feature = "test-failpoints")]
    {
        if configured == Some(point) {
            park_subprocess_failpoint_if_requested(point)?;
            return Err(MigrationSupervisorError::Failpoint(point));
        }
        Ok(())
    }
    #[cfg(not(feature = "test-failpoints"))]
    {
        let _ = (configured, point);
        Ok(())
    }
}

#[cfg(feature = "test-failpoints")]
fn park_subprocess_failpoint_if_requested(
    point: Failpoint,
) -> Result<(), MigrationSupervisorError> {
    let Some(ready_path) = std::env::var_os("GRIMODEX_MIGRATION_FAILPOINT_READY_PATH") else {
        return Ok(());
    };
    let ready_path = PathBuf::from(ready_path);
    fs::write(&ready_path, format!("{}\n", point.as_str()))?;
    sync_file(&ready_path)?;
    loop {
        std::thread::park_timeout(Duration::from_secs(3600));
    }
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let tmp = sibling(path, &format!(".tmp-{}", Uuid::new_v4()));
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        serde_json::to_writer_pretty(&mut file, value).map_err(io::Error::other)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn sync_file(path: &Path) -> io::Result<()> {
    // Windows denies FlushFileBuffers on a read-only handle (os error 5).
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()
}

fn workspace_identity(workspace: &Path) -> String {
    let meta = workspace.join(".grimodex/workspace.json");
    if let Ok(bytes) = fs::read(&meta) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                return id.to_string();
            }
        }
    }
    workspace.display().to_string()
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    sibling(path, suffix)
}

fn remove_db_sidecars(db_path: &Path) -> io::Result<()> {
    remove_path_not_found_ok(&sidecar(db_path, "-wal"))?;
    remove_path_not_found_ok(&sidecar(db_path, "-shm"))?;
    Ok(())
}

fn remove_path_not_found_ok(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(not(windows))]
    {
        fs::rename(staged, destination)
    }
    #[cfg(windows)]
    {
        if !destination.exists() {
            return fs::rename(staged, destination);
        }
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};
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
}

/// List user backups and migration snapshots as restore candidates.
pub fn list_recovery_candidates(workspace: &Path) -> Vec<BackupInfo> {
    let mut out = list_backups_in(&workspace.join("backups"));
    let migrations = workspace.join("backups/migrations");
    if let Ok(entries) = fs::read_dir(&migrations) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".db") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            out.push(BackupInfo {
                file_name: format!("migrations/{name}"),
                size_bytes: meta.len(),
                modified_ms,
                format: "migration-db".to_string(),
            });
        }
    }
    out.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    out
}

struct Cleanup {
    path: PathBuf,
    armed: bool,
}

impl Cleanup {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
            let _ = remove_db_sidecars(&self.path);
        }
    }
}

/// Convenience wrapper used by workspace open.
///
/// [`WorkspaceOpenDbOutcome::RecoveryRequired`] and [`SafeMode`] become errors
/// carrying `WORKSPACE_SAFE_MODE` — callers must not publish DB authority.
pub fn prepare_database_for_open(
    workspace: &Path,
) -> AppResult<(OpenedWorkspaceDb, Option<OpenMigrationInfo>)> {
    match open_or_migrate_workspace_db(workspace)? {
        WorkspaceOpenDbOutcome::Ready { opened, .. } => Ok((opened, None)),
        WorkspaceOpenDbOutcome::Migrated {
            opened,
            from_schema,
            to_schema,
            receipt_path,
        } => Ok((
            opened,
            Some(OpenMigrationInfo {
                from_schema,
                to_schema,
                receipt_path: receipt_path.display().to_string(),
                recovered: false,
                error_code: None,
            }),
        )),
        WorkspaceOpenDbOutcome::RecoveryRequired {
            reason,
            error_code,
            snapshot_path,
            available_backups,
        } => Err(AppError::Anyhow(anyhow::anyhow!(
            "{reason} [{error_code}] snapshot={} backups={}",
            snapshot_path.display(),
            available_backups.len()
        ))),
        WorkspaceOpenDbOutcome::SafeMode {
            reason,
            available_backups,
        } => Err(AppError::Anyhow(anyhow::anyhow!(
            "{reason} backups={}",
            available_backups.len()
        ))),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMigrationInfo {
    pub from_schema: i32,
    pub to_schema: i32,
    pub receipt_path: String,
    pub recovered: bool,
    pub error_code: Option<String>,
}
