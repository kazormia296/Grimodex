//! Transactional Migration Supervisor (Release Gate A).
//!
//! Workspace open never runs schema DDL on the live `grimodex.db` for upgrades.
//! Instead it:
//! 1. inspects the live DB read-only
//! 2. creates a checksummed migration snapshot under `backups/migrations/`
//! 3. migrates a staged copy
//! 4. atomically replaces the live DB (with rollback sidecar)
//!
//! Same-schema opens take a shared lease and the existing read-only fast path.
//! Newer-than-supported schemas return Safe Mode without mutating the live DB.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::backup_restore::{list_backups_in, BackupInfo};
use crate::error::{AppError, AppResult};
use crate::workspace_lease::{self, WorkspaceLease};
use crate::Database;
use grimodex_core::SCHEMA_VERSION;
use grimodex_core::workspace_schema::has_v3_checkpoint_invariants;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failpoint {
    AfterSnapshot,
    AfterStagedCopy,
    AfterMigrate,
    AfterReplace,
    BeforeReopen,
    ReopenFailure,
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
            Self::ChecksumMismatch => "migration.checksum_mismatch",
            Self::DiskFull => "migration.disk_full",
        }
    }
}

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
        database: Database,
        from_schema: i32,
        to_schema: i32,
    },
    Migrated {
        database: Database,
        from_schema: i32,
        to_schema: i32,
        receipt_path: PathBuf,
    },
    MigrationRecovered {
        database: Database,
        error_code: String,
        snapshot_path: PathBuf,
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
            Self::MigrationRecovered {
                error_code,
                snapshot_path,
                ..
            } => f
                .debug_struct("MigrationRecovered")
                .field("error_code", error_code)
                .field("snapshot_path", snapshot_path)
                .finish_non_exhaustive(),
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

    let inspection = inspect_workspace_schema(workspace, &db_path)?;
    if inspection.current_schema_version > inspection.target_schema_version {
        let backups = list_backups_in(&workspace.join("backups"));
        return Ok(WorkspaceOpenDbOutcome::SafeMode {
            reason: format!(
                "WORKSPACE_SAFE_MODE: workspace schema version {} is newer than supported version {}",
                inspection.current_schema_version, inspection.target_schema_version
            ),
            available_backups: backups,
        });
    }

    if inspection.current_schema_version == inspection.target_schema_version
        && inspection.quick_check_ok
        && live_invariants_ok(&db_path)?
    {
        let _shared = workspace_lease::try_acquire_shared(workspace)?;
        let database = Database::new(&db_path)?;
        // Fast path: may perform additive crash-recovery / stickies repair only.
        database.migrate()?;
        return Ok(WorkspaceOpenDbOutcome::Ready {
            database,
            from_schema: inspection.current_schema_version,
            to_schema: inspection.target_schema_version,
        });
    }

    shadow_migrate(workspace, &db_path, &inspection, failpoint)
}

fn create_fresh_workspace_db(
    workspace: &Path,
    db_path: &Path,
    failpoint: Option<Failpoint>,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    let _exclusive = workspace_lease::acquire_exclusive_for_migration(workspace)?;
    let staged = sibling(db_path, &format!(".migration-{}", Uuid::new_v4()));
    let mut staged_cleanup = Cleanup::new(staged.clone());
    {
        let db = Database::new(&staged)?;
        db.migrate()?;
        verify_migrated_db(&staged)?;
    }
    hit_failpoint(failpoint, Failpoint::AfterMigrate)?;
    atomic_replace(&staged, db_path)?;
    staged_cleanup.disarm();
    remove_db_sidecars(db_path)?;
    let database = Database::new(db_path)?;
    Ok(WorkspaceOpenDbOutcome::Ready {
        database,
        from_schema: 0,
        to_schema: SCHEMA_VERSION,
    })
}

fn shadow_migrate(
    workspace: &Path,
    db_path: &Path,
    inspection: &WorkspaceSchemaInspection,
    failpoint: Option<Failpoint>,
) -> Result<WorkspaceOpenDbOutcome, MigrationSupervisorError> {
    let _exclusive = workspace_lease::acquire_exclusive_for_migration(workspace)?;

    ensure_disk_budget(workspace, inspection, failpoint)?;

    let snapshot = create_migration_snapshot(workspace, db_path, inspection)?;
    hit_failpoint(failpoint, Failpoint::AfterSnapshot)?;

    if failpoint == Some(Failpoint::ChecksumMismatch) {
        return Err(MigrationSupervisorError::Failpoint(Failpoint::ChecksumMismatch));
    }
    verify_snapshot_checksum(&snapshot)?;

    let staged = sibling(db_path, &format!(".migration-{}", Uuid::new_v4()));
    let mut staged_cleanup = Cleanup::new(staged.clone());
    fs::copy(&snapshot.db_path, &staged)?;
    remove_db_sidecars(&staged).ok();
    hit_failpoint(failpoint, Failpoint::AfterStagedCopy)?;

    {
        let db = Database::new(&staged)?;
        // Force full migration on the disposable copy.
        db.migrate_for_restore_preflight()?;
        verify_migrated_db(&staged)?;
    }
    hit_failpoint(failpoint, Failpoint::AfterMigrate)?;

    // Checkpoint live WAL before replacement.
    checkpoint_live_wal(db_path);

    let rollback = sibling(db_path, &format!(".migration-rollback-{}", Uuid::new_v4()));
    let mut rollback_cleanup = Cleanup::new(rollback.clone());
    fs::copy(db_path, &rollback)?;
    remove_db_sidecars(db_path)?;

    atomic_replace(&staged, db_path)?;
    staged_cleanup.disarm();
    hit_failpoint(failpoint, Failpoint::AfterReplace)?;
    hit_failpoint(failpoint, Failpoint::BeforeReopen)?;

    if failpoint == Some(Failpoint::ReopenFailure) {
        // Simulate reopen failure: roll live DB back from sidecar.
        remove_db_sidecars(db_path).ok();
        atomic_replace(&rollback, db_path)?;
        rollback_cleanup.disarm();
        let database = Database::new(db_path)?;
        return Ok(WorkspaceOpenDbOutcome::MigrationRecovered {
            database,
            error_code: "MIGRATION_REOPEN_FAILED".to_string(),
            snapshot_path: snapshot.db_path,
        });
    }

    match Database::new(db_path).and_then(|db| {
        verify_migrated_db(db_path)?;
        Ok(db)
    }) {
        Ok(database) => {
            rollback_cleanup.disarm();
            let _ = fs::remove_file(&rollback);
            remove_db_sidecars(db_path).ok();
            write_receipt(workspace, &snapshot, inspection)?;
            Ok(WorkspaceOpenDbOutcome::Migrated {
                database,
                from_schema: inspection.current_schema_version,
                to_schema: SCHEMA_VERSION,
                receipt_path: snapshot.manifest_path,
            })
        }
        Err(error) => {
            remove_db_sidecars(db_path).ok();
            atomic_replace(&rollback, db_path)?;
            rollback_cleanup.disarm();
            let database = Database::new(db_path)?;
            Ok(WorkspaceOpenDbOutcome::MigrationRecovered {
                database,
                error_code: format!("MIGRATION_REOPEN_FAILED:{error}"),
                snapshot_path: snapshot.db_path,
            })
        }
    }
}

struct SnapshotArtifacts {
    db_path: PathBuf,
    manifest_path: PathBuf,
    sha256: String,
}

fn create_migration_snapshot(
    workspace: &Path,
    db_path: &Path,
    inspection: &WorkspaceSchemaInspection,
) -> Result<SnapshotArtifacts, MigrationSupervisorError> {
    let migrations_dir = workspace.join("backups/migrations");
    fs::create_dir_all(&migrations_dir)?;
    // Ensure destination is writable.
    let probe = migrations_dir.join(format!(".write-probe-{}", Uuid::new_v4()));
    File::create(&probe)
        .map_err(|e| {
            MigrationSupervisorError::Message(format!(
                "MIGRATION_BACKUP_DIRECTORY_UNWRITABLE: {e}"
            ))
        })?;
    let _ = fs::remove_file(&probe);

    let stamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
    let base = format!(
        "migration-{stamp}-schema-{}-to-{}",
        inspection.current_schema_version, SCHEMA_VERSION
    );
    let snap_path = migrations_dir.join(format!("{base}.db"));
    let manifest_path = migrations_dir.join(format!("{base}.json"));

    // Prefer VACUUM INTO for a consistent snapshot. Do not run slim_backup_copy:
    // legacy schemas may lack derived tables that slim expects.
    {
        let conn = rusqlite::Connection::open(db_path)?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
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
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        database_file_name: snap_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("grimodex.db")
            .to_string(),
        size_bytes,
        sha256: sha256.clone(),
        created_at: Utc::now().to_rfc3339(),
        source_workspace_identity: identity,
    };
    write_json_atomic(&manifest_path, &manifest)?;
    sync_file(&snap_path)?;

    Ok(SnapshotArtifacts {
        db_path: snap_path,
        manifest_path,
        sha256,
    })
}

fn verify_snapshot_checksum(
    snapshot: &SnapshotArtifacts,
) -> Result<(), MigrationSupervisorError> {
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
) -> Result<(), MigrationSupervisorError> {
    let receipt_dir = workspace.join("backups/migrations");
    let receipt_path = receipt_dir.join(format!(
        "receipt-{}-to-{}.json",
        inspection.current_schema_version, SCHEMA_VERSION
    ));
    let body = serde_json::json!({
        "version": 1,
        "fromSchema": inspection.current_schema_version,
        "toSchema": SCHEMA_VERSION,
        "snapshot": snapshot.db_path.file_name().and_then(|s| s.to_str()),
        "manifest": snapshot.manifest_path.file_name().and_then(|s| s.to_str()),
        "completedAt": Utc::now().to_rfc3339(),
    });
    write_json_atomic(&receipt_path, &body)?;
    Ok(())
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
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
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
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok(has_v3_checkpoint_invariants(&conn)?)
}

fn verify_migrated_db(path: &Path) -> anyhow::Result<()> {
    let db = Database::new(path)?;
    let version: i32 = db.with_conn(|conn| {
        Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
    })?;
    anyhow::ensure!(
        version == SCHEMA_VERSION,
        "migrated db user_version {version} != {SCHEMA_VERSION}"
    );
    let ok = db.with_conn(|conn| Ok(has_v3_checkpoint_invariants(conn)?))?;
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
    // Reopen probe.
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
    let required = inspection.database_size_bytes
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
    // Best-effort: use statvfs on unix; otherwise skip.
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
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn checkpoint_live_wal(db_path: &Path) {
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
}

fn hit_failpoint(
    configured: Option<Failpoint>,
    point: Failpoint,
) -> Result<(), MigrationSupervisorError> {
    #[cfg(feature = "test-failpoints")]
    {
        if configured == Some(point) {
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
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        serde_json::to_writer_pretty(&mut file, value)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn sync_file(path: &Path) -> io::Result<()> {
    let file = File::open(path)?;
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
    let _ = fs::remove_file(sidecar(db_path, "-wal"));
    let _ = fs::remove_file(sidecar(db_path, "-shm"));
    Ok(())
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
pub fn prepare_database_for_open(workspace: &Path) -> AppResult<(Database, Option<OpenMigrationInfo>)> {
    match open_or_migrate_workspace_db(workspace)? {
        WorkspaceOpenDbOutcome::Ready { database, .. } => Ok((database, None)),
        WorkspaceOpenDbOutcome::Migrated {
            database,
            from_schema,
            to_schema,
            receipt_path,
        } => Ok((
            database,
            Some(OpenMigrationInfo {
                from_schema,
                to_schema,
                receipt_path: receipt_path.display().to_string(),
                recovered: false,
                error_code: None,
            }),
        )),
        WorkspaceOpenDbOutcome::MigrationRecovered {
            database,
            error_code,
            snapshot_path,
        } => Ok((
            database,
            Some(OpenMigrationInfo {
                from_schema: -1,
                to_schema: -1,
                receipt_path: snapshot_path.display().to_string(),
                recovered: true,
                error_code: Some(error_code),
            }),
        )),
        WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
            Err(AppError::Anyhow(anyhow::anyhow!("{reason}")))
        }
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

// Keep lease type referenced for docs / future exclusive hold across open.
#[allow(dead_code)]
fn _lease_type_anchor(_: &WorkspaceLease) {}
