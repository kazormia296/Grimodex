use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{ensure, Context, Result};
use grimodex_db::narrative_extraction::{
    nir1_capacity_fixtures::{
        build_fixture_from_manifest, NIR1_CAPACITY_FIXTURE_PROJECT_ID,
        NIR1_CAPACITY_FIXTURE_SCENE_ID,
    },
    nir1_graph_memory_diagnostics::{
        run_c_query_memory_diagnostic, run_managed_c_query_memory_diagnostic,
        CQueryMemoryObservation,
    },
};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const CASE_ID: &str = "Q513/R3/D0";
pub const SEED_ENTITY_ID: &str = "nir1-capacity-q-r0-e0";
const EMBEDDED_MANIFEST: &[u8] =
    include_bytes!("../../../../../../evals/nir1-capacity/manifest.v1.json");
const EMBEDDED_MANIFEST_SHA256: &str =
    "34c463e580cf86a6d5dc91fb32addfd6091541092fb5174b4846ed0c725c3ce5";
const PRIVATE_MANIFEST: &[u8] = br#"{"schemaVersion":"nir1-capacity/1","diagnosticOnly":true,"fixtures":[{"id":"Q513/R3/D0","qualifiedMaterials":513,"qualifiedRevisions":3,"ineligibleCandidates":0}]}"#;
pub const LOCAL_CASE_ID: &str = "Q2/R1/D0-local";
const LOCAL_MANIFEST: &[u8] = br#"{"schemaVersion":"nir1-capacity/1","diagnosticOnly":true,"fixtures":[{"id":"Q2/R1/D0-local","qualifiedMaterials":2,"qualifiedRevisions":1,"ineligibleCandidates":0}]}"#;
const TEMP_DIRECTORY_PREFIX: &str = "grimodex-nir1-c-query-";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateFixtureReport {
    pub status: &'static str,
    pub claims_hard_two_mib_bound: bool,
    pub fixture: FixtureLabel,
    pub manifest: ManifestLabel,
    pub provenance: ProvenanceLabel,
    pub model_id: &'static str,
    pub fixture_setup: FixtureSetup,
    pub backup: BackupObservation,
    pub diagnostic_status: &'static str,
    pub diagnostic: Option<CQueryMemoryObservation>,
    pub coverage: Vec<&'static str>,
    pub unknowns: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureLabel {
    pub case_id: &'static str,
    pub project_id: &'static str,
    pub scene_id: &'static str,
    pub seed_entity_id: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLabel {
    pub bundled_source_sha256: String,
    pub materialized_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceLabel {
    pub candidate_commit: Option<String>,
    pub candidate_tree: Option<String>,
    pub rust_compiler_build: Option<String>,
    pub sqlite_implementation: &'static str,
    pub sqlite_version: &'static str,
    pub sqlite_version_number: i32,
    pub labels_complete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureSetup {
    pub manifest_file_private_and_verified: bool,
    pub builder_writer_closed: bool,
    pub seed_and_scene_verified: bool,
    pub private_temporary_directory_removed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupObservation {
    pub source_opened_read_only: bool,
    pub consistent_backup_completed: bool,
    pub backup_file_verified: bool,
}

pub fn parse_case_args(args: &[std::ffi::OsString]) -> Result<&'static str> {
    ensure!(args.len() == 1, "usage: nir1-c-query-memory <Q513/R3/D0>");
    let case_id = args[0]
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("fixture case id must be UTF-8"))?;
    ensure!(case_id == CASE_ID, "unknown private fixture case id");
    Ok(CASE_ID)
}

pub fn run_private_fixture(
    case_id: &str,
    begin_rust_window: impl FnOnce() -> u64,
    finish_rust_window: impl FnOnce() -> (u64, u64),
) -> Result<PrivateFixtureReport> {
    ensure!(case_id == CASE_ID, "unknown private fixture case id");
    let bundled_manifest_sha256 = validate_embedded_manifest()?;
    let temp_dir = PrivateDirectory::create()?;
    let manifest_path = temp_dir.path.join("manifest.json");
    let materialized_manifest_sha256 = materialize_manifest(&manifest_path)?;
    let preseed_path = temp_dir.path.join("preseed.db");
    let fixture = build_fixture_from_manifest(&manifest_path, CASE_ID, &preseed_path)?;
    restrict_private_file(&preseed_path)?;
    ensure!(
        fixture.case_id == CASE_ID
            && fixture.diagnostic_only
            && fixture.checkpoint.database_path == preseed_path.display().to_string()
            && fixture.checkpoint.reopened_read_only
            && fixture.checkpoint.wal_bytes == 0
            && fixture.checkpoint.shm_bytes == 0,
        "private fixture builder did not return a closed checkpointed fixture"
    );
    verify_seed_and_scene(&preseed_path)?;

    let backup_path = temp_dir.path.join("query-backup.db");
    backup_read_only(&preseed_path, &backup_path)?;
    verify_seed_and_scene(&backup_path)?;

    let diagnostic = run_c_query_memory_diagnostic(
        &backup_path,
        NIR1_CAPACITY_FIXTURE_PROJECT_ID,
        NIR1_CAPACITY_FIXTURE_SCENE_ID,
        SEED_ENTITY_ID,
        begin_rust_window,
        finish_rust_window,
    );
    let diagnostic = diagnostic.ok();
    let diagnostic_status = if diagnostic.is_some() {
        "complete"
    } else {
        "failed"
    };
    temp_dir.remove()?;

    let candidate_commit = git_label(option_env!("NIR1_C_QUERY_GIT_COMMIT"));
    let candidate_tree = git_label(option_env!("NIR1_C_QUERY_GIT_TREE"));
    let rust_compiler_build = build_label(option_env!("NIR1_C_QUERY_RUSTC_VERSION"));
    let labels_complete =
        candidate_commit.is_some() && candidate_tree.is_some() && rust_compiler_build.is_some();
    let successful_graph_observation = diagnostic.as_ref().is_some_and(|observation| {
        observation.registration.registered
            && observation.query.status == "available"
            && observation.cleanup.reader_closed
            && observation.cleanup.workspace_participant_released
            && observation.cleanup.disposable_database_removed
    });
    let status = if labels_complete && successful_graph_observation {
        "observation-only"
    } else {
        "incomplete"
    };
    let mut unknowns = Vec::new();
    if candidate_commit.is_none() {
        unknowns.push("candidate commit label was not compiled into this binary");
    }
    if candidate_tree.is_none() {
        unknowns.push("candidate tree label was not compiled into this binary");
    }
    if rust_compiler_build.is_none() {
        unknowns.push("Rust compiler build label was not compiled into this binary");
    }
    if diagnostic.is_none() {
        unknowns.push("private Graph registration/query diagnostic failed");
    } else if !successful_graph_observation {
        unknowns.push("registered Graph query was not available with complete cleanup checks");
    }

    Ok(PrivateFixtureReport {
        status,
        claims_hard_two_mib_bound: false,
        fixture: FixtureLabel {
            case_id: CASE_ID,
            project_id: NIR1_CAPACITY_FIXTURE_PROJECT_ID,
            scene_id: NIR1_CAPACITY_FIXTURE_SCENE_ID,
            seed_entity_id: SEED_ENTITY_ID,
        },
        manifest: ManifestLabel {
            bundled_source_sha256: bundled_manifest_sha256,
            materialized_sha256: materialized_manifest_sha256,
        },
        provenance: ProvenanceLabel {
            candidate_commit,
            candidate_tree,
            rust_compiler_build,
            sqlite_implementation: "bundled",
            sqlite_version: rusqlite::version(),
            sqlite_version_number: rusqlite::version_number(),
            labels_complete,
        },
        model_id: "not-applicable",
        fixture_setup: FixtureSetup {
            manifest_file_private_and_verified: true,
            builder_writer_closed: true,
            seed_and_scene_verified: true,
            private_temporary_directory_removed: true,
        },
        backup: BackupObservation {
            source_opened_read_only: true,
            consistent_backup_completed: true,
            backup_file_verified: true,
        },
        diagnostic_status,
        diagnostic,
        coverage: vec![
            "Only the fixed Q513/R3/D0 case is accepted; caller database, manifest, workspace, project, scene, and seed values are not inputs.",
            "The builder receives only the exact sanitized one-case manifest materialized inside the CLI-owned private directory.",
            "Graph preparation, registration, query deadline, and cleanup checks use the existing observation-only diagnostic on a private consistent backup.",
            "No Source body or caller database contents are included in this report.",
        ],
        unknowns,
    })
}

/// The caller must first verify the manager-owned, empty private runtime root.
/// This path neither constructs nor removes any child-owned temp directory.
pub fn run_managed_fixture(
    case_id: &str,
    runtime_root: &Path,
    on_stage: impl Fn(u8),
    begin_window: impl FnOnce() -> Result<u64>,
    finish_window: impl FnOnce() -> Result<(u64, u64)>,
    ready_continue: impl FnOnce() -> Result<()>,
) -> Result<CQueryMemoryObservation> {
    on_stage(71); // Fixed manifest selection and empty private root.
    let (manifest, materials, revisions) = match case_id {
        CASE_ID => {
            validate_embedded_manifest()?;
            (PRIVATE_MANIFEST, 513, 3)
        }
        LOCAL_CASE_ID => (LOCAL_MANIFEST, 2, 1),
        _ => anyhow::bail!("unknown managed fixture"),
    };
    verify_private_directory(runtime_root)?;
    ensure!(
        fs::read_dir(runtime_root)?.next().is_none(),
        "managed root is not empty"
    );
    on_stage(72); // Materialize exact bytes.
    let manifest_path = runtime_root.join("manifest.json");
    materialize_manifest_bytes(&manifest_path, manifest)?;
    let preseed_path = runtime_root.join("preseed.db");
    on_stage(73); // Existing builder and internal shape measurement.
    let fixture = build_fixture_from_manifest(&manifest_path, case_id, &preseed_path)?;
    on_stage(74); // Private file, expected shape and checkpoint checks.
    restrict_private_file(&preseed_path)?;
    ensure!(
        fixture.case_id == case_id
            && fixture.diagnostic_only
            && fixture.expected.qualified_materials == Some(materials)
            && fixture.expected.qualified_revisions == Some(revisions)
            && fixture.expected.ineligible_candidates == Some(0)
            && fixture.checkpoint.database_path == preseed_path.display().to_string()
            && fixture.checkpoint.reopened_read_only
            && fixture.checkpoint.wal_bytes == 0
            && fixture.checkpoint.shm_bytes == 0,
        "managed fixture shape or checkpoint mismatch"
    );
    on_stage(75); // Preseed identities.
    verify_seed_and_scene_with_retention(&preseed_path, true)?;
    let backup_path = runtime_root.join("query-backup.db");
    on_stage(76); // Consistent read-only backup.
    backup_read_only(&preseed_path, &backup_path)?;
    on_stage(77); // Backup identities.
    verify_seed_and_scene_with_retention(&backup_path, true)?;
    on_stage(78); // Managed copy, Graph preparation and registration.
    run_managed_c_query_memory_diagnostic(
        &backup_path,
        runtime_root,
        NIR1_CAPACITY_FIXTURE_PROJECT_ID,
        NIR1_CAPACITY_FIXTURE_SCENE_ID,
        SEED_ENTITY_ID,
        begin_window,
        finish_window,
        ready_continue,
    )
}

fn validate_embedded_manifest() -> Result<String> {
    let source_sha256 = sha256(EMBEDDED_MANIFEST);
    ensure!(
        source_sha256 == EMBEDDED_MANIFEST_SHA256,
        "embedded capacity manifest digest does not match the approved input"
    );
    let source: Value = serde_json::from_slice(EMBEDDED_MANIFEST)?;
    let sanitized: Value = serde_json::from_slice(PRIVATE_MANIFEST)?;
    let expected = json!({
        "schemaVersion": "nir1-capacity/1",
        "diagnosticOnly": true,
        "fixtures": [{
            "id": CASE_ID,
            "qualifiedMaterials": 513,
            "qualifiedRevisions": 3,
            "ineligibleCandidates": 0
        }]
    });
    ensure!(
        sanitized == expected,
        "sanitized private manifest shape changed"
    );
    let source_fixture = source
        .get("fixtures")
        .and_then(Value::as_array)
        .and_then(|fixtures| fixtures.iter().find(|fixture| fixture["id"] == CASE_ID))
        .ok_or_else(|| anyhow::anyhow!("approved manifest is missing the fixed fixture"))?;
    ensure!(
        source["schemaVersion"] == "nir1-capacity/1"
            && source["diagnosticOnly"] == true
            && source_fixture["qualifiedMaterials"] == 513
            && source_fixture["qualifiedRevisions"] == 3
            && source_fixture["ineligibleCandidates"] == 0,
        "sanitized fixture fields differ from the approved embedded manifest"
    );
    Ok(source_sha256)
}

fn materialize_manifest(path: &Path) -> Result<String> {
    materialize_manifest_bytes(path, PRIVATE_MANIFEST)
}

fn materialize_manifest_bytes(path: &Path, manifest: &[u8]) -> Result<String> {
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_os = "linux")]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .context("create private embedded manifest")?;
    file.write_all(manifest)?;
    file.flush()?;
    drop(file);
    verify_private_file(path)?;
    let materialized = fs::read(path).context("re-read private embedded manifest")?;
    ensure!(
        materialized == manifest,
        "private manifest bytes changed before fixture construction"
    );
    Ok(sha256(&materialized))
}

fn verify_seed_and_scene(path: &Path) -> Result<()> {
    verify_seed_and_scene_with_retention(path, false)
}

fn verify_seed_and_scene_with_retention(path: &Path, retain_sidecars: bool) -> Result<()> {
    verify_private_file(path)?;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("open private fixture read-only for ID verification")?;
    ensure!(
        connection.is_readonly("main")?,
        "fixture verification is not read-only"
    );
    let seed_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM codex_entries WHERE project_id=?1 AND id=?2)",
        rusqlite::params![NIR1_CAPACITY_FIXTURE_PROJECT_ID, SEED_ENTITY_ID],
        |row| row.get(0),
    )?;
    let scene_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM tree_nodes WHERE project_id=?1 AND id=?2 AND node_type='scene')",
        rusqlite::params![NIR1_CAPACITY_FIXTURE_PROJECT_ID, NIR1_CAPACITY_FIXTURE_SCENE_ID],
        |row| row.get(0),
    )?;
    ensure!(
        seed_exists && scene_exists,
        "fixed fixture seed or scene is absent"
    );
    close_checked(connection, "close private fixture verification connection")?;
    if !retain_sidecars {
        remove_clean_sidecars(path)?;
    }
    Ok(())
}

fn backup_read_only(source_path: &Path, destination_path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::OpenOptionsExt;
    verify_private_file(source_path)?;
    let mut create = OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(target_os = "linux")]
    create.mode(0o600);
    drop(
        create
            .open(destination_path)
            .context("create private backup destination without replacement")?,
    );
    verify_private_file(destination_path)?;

    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("open private fixture backup source read-only")?;
    ensure!(
        source.is_readonly("main")?,
        "backup source is not read-only"
    );
    let mut destination =
        Connection::open_with_flags(destination_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .context("open new private backup destination")?;
    let step = {
        let backup = Backup::new(&source, &mut destination)?;
        backup.step(-1)?
    };
    ensure!(
        matches!(step, StepResult::Done),
        "SQLite consistent backup did not complete"
    );
    close_checked(destination, "close private backup destination")?;
    close_checked(source, "close private backup source")?;
    verify_private_file(destination_path)?;
    ensure!(
        fs::metadata(destination_path)?.len() > 0,
        "private SQLite backup is empty"
    );
    Ok(())
}

fn close_checked(connection: Connection, context: &'static str) -> Result<()> {
    connection
        .close()
        .map_err(|(_, error)| error)
        .with_context(|| context.to_owned())
}

fn remove_clean_sidecars(database_path: &Path) -> Result<()> {
    let wal_path = sidecar_path(database_path, "-wal");
    match fs::symlink_metadata(&wal_path) {
        Ok(metadata) => {
            ensure!(
                metadata.file_type().is_file(),
                "private WAL sidecar is not a regular file"
            );
            ensure!(
                metadata.len() == 0,
                "read-only fixture verification wrote a WAL"
            );
            fs::remove_file(&wal_path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let shm_path = sidecar_path(database_path, "-shm");
    match fs::symlink_metadata(&shm_path) {
        Ok(metadata) => {
            ensure!(
                metadata.file_type().is_file(),
                "private SHM sidecar is not a regular file"
            );
            fs::remove_file(&shm_path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    ensure!(
        !wal_path.exists() && !shm_path.exists(),
        "private sidecar cleanup failed"
    );
    Ok(())
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut name = database_path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn git_label(label: Option<&'static str>) -> Option<String> {
    label
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
}

fn build_label(label: Option<&'static str>) -> Option<String> {
    label
        .filter(|value| {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
}

struct PrivateDirectory {
    path: PathBuf,
    removed: bool,
}

impl PrivateDirectory {
    fn create() -> Result<Self> {
        #[cfg(not(target_os = "linux"))]
        anyhow::bail!("private fixture ACL/identity verification is unsupported on this OS");
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::DirBuilderExt;
            let path = verified_temp_parent()?
                .join(format!("{TEMP_DIRECTORY_PREFIX}{}", uuid::Uuid::new_v4()));
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
                .create(&path)
                .context("create exclusive private fixture directory")?;
            verify_private_directory(&path)?;
            Ok(Self {
                path,
                removed: false,
            })
        }
    }

    fn remove(mut self) -> Result<()> {
        fs::remove_dir_all(&self.path).context("remove private fixture directory")?;
        ensure!(
            matches!(
                fs::symlink_metadata(&self.path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            ),
            "private fixture directory remains after cleanup"
        );
        self.removed = true;
        Ok(())
    }
}

impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        if !self.removed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(target_os = "linux")]
fn verified_temp_parent() -> Result<&'static Path> {
    // Ignore caller-controlled TMPDIR. A root-owned sticky /tmp prevents a
    // different UID from replacing an entry created by this process.
    let parent = Path::new("/tmp");
    validate_temp_parent(parent)?;
    Ok(parent)
}

#[cfg(target_os = "linux")]
fn validate_temp_parent(parent: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(parent)?;
    ensure!(
        metadata.file_type().is_dir() && metadata.uid() == 0 && metadata.mode() & 0o1777 == 0o1777,
        "no trusted private fixture temp parent is available"
    );
    Ok(())
}

fn verify_private_directory(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            metadata.file_type().is_dir(),
            "private fixture path is not a directory"
        );
        // SAFETY: geteuid reads the effective uid of the current process.
        let effective_uid = unsafe { libc::geteuid() };
        ensure!(
            metadata.uid() == effective_uid && metadata.mode() & 0o077 == 0,
            "private fixture directory ownership or permissions are unsafe"
        );
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("private fixture ACL/identity verification is unsupported on this OS")
}

fn restrict_private_file(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)?;
        verify_private_file(path)
    }
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("private fixture ACL/identity verification is unsupported on this OS")
}

fn verify_private_file(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            metadata.file_type().is_file(),
            "private fixture file is not regular"
        );
        // SAFETY: geteuid reads the effective uid of the current process.
        let effective_uid = unsafe { libc::geteuid() };
        ensure!(
            metadata.uid() == effective_uid && metadata.mode() & 0o077 == 0,
            "private fixture file ownership or permissions are unsafe"
        );
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("private fixture ACL/identity verification is unsupported on this OS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitized_manifest_is_bound_to_the_exact_approved_eval_fixture() -> Result<()> {
        assert_eq!(validate_embedded_manifest()?, EMBEDDED_MANIFEST_SHA256);
        let value: Value = serde_json::from_slice(PRIVATE_MANIFEST)?;
        assert_eq!(
            value,
            json!({
                "schemaVersion": "nir1-capacity/1",
                "diagnosticOnly": true,
                "fixtures": [{
                    "id": "Q513/R3/D0",
                    "qualifiedMaterials": 513,
                    "qualifiedRevisions": 3,
                    "ineligibleCandidates": 0
                }]
            })
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn read_only_backup_includes_a_committed_wal_only_row() -> Result<()> {
        let temp = PrivateDirectory::create()?;
        let source_path = temp.path.join("wal-only-source.db");
        let main_only_path = temp.path.join("main-only.db");
        let backup_path = temp.path.join("wal-only-backup.db");
        let mut writer = Connection::open(&source_path)?;
        writer.pragma_update(None, "journal_mode", "WAL")?;
        writer.pragma_update(None, "wal_autocheckpoint", 0)?;
        writer.execute_batch(
            "CREATE TABLE committed_rows (id TEXT PRIMARY KEY);\n\
             PRAGMA wal_checkpoint(TRUNCATE);",
        )?;
        restrict_private_file(&source_path)?;
        let transaction = writer.transaction()?;
        transaction.execute(
            "INSERT INTO committed_rows(id) VALUES ('committed-only-in-wal')",
            [],
        )?;
        transaction.commit()?;
        let wal_path = sidecar_path(&source_path, "-wal");
        ensure!(
            fs::metadata(&wal_path)?.len() > 32,
            "WAL commit was not preserved"
        );
        fs::copy(&source_path, &main_only_path)?;
        let main_only =
            Connection::open_with_flags(&main_only_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let main_has_row: bool = main_only.query_row(
            "SELECT EXISTS(SELECT 1 FROM committed_rows WHERE id='committed-only-in-wal')",
            [],
            |row| row.get(0),
        )?;
        close_checked(main_only, "close main-only WAL test connection")?;
        ensure!(
            !main_has_row,
            "test row was already checkpointed into the main file"
        );

        backup_read_only(&source_path, &backup_path)?;
        let backed_up =
            Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let backup_has_row: bool = backed_up.query_row(
            "SELECT EXISTS(SELECT 1 FROM committed_rows WHERE id='committed-only-in-wal')",
            [],
            |row| row.get(0),
        )?;
        close_checked(backed_up, "close WAL backup verification connection")?;
        ensure!(
            backup_has_row,
            "consistent backup omitted the committed WAL-only row"
        );
        close_checked(writer, "close WAL-only fixture writer")?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn private_fixture_attempts_real_registered_graph_query() -> Result<()> {
        let report = run_private_fixture(
            CASE_ID,
            super::super::capacity_allocator::begin_window,
            super::super::capacity_allocator::snapshot,
        )?;
        let observation = report
            .diagnostic
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("registered Graph diagnostic did not complete"))?;
        assert!(observation.registration.registered);
        assert!(!observation.claims_hard_two_mib_bound);
        eprintln!(
            "private fixture registration=true, query status={}",
            observation.query.status
        );
        assert_eq!(
            observation.status,
            if observation.query.status == "available" {
                "observation-only"
            } else {
                "query-unavailable"
            }
        );
        if observation.query.status != "available" {
            assert_eq!(report.status, "incomplete");
        }
        assert!(report.fixture_setup.private_temporary_directory_removed);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_untrusted_temp_parent() -> Result<()> {
        assert_eq!(verified_temp_parent()?, Path::new("/tmp"));
        let private = PrivateDirectory::create()?;
        assert!(validate_temp_parent(&private.path).is_err());
        private.remove()?;
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn unsupported_os_rejects_private_fixture() {
        assert!(PrivateDirectory::create().is_err());
    }

    // A debug test may legitimately miss the fixed 8 ms deadline. Keep the
    // positive available-response gate explicit for isolated release runs.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires isolated release build and 8 ms Graph response"]
    fn private_fixture_registered_graph_positive() -> Result<()> {
        let report = run_private_fixture(
            CASE_ID,
            super::super::capacity_allocator::begin_window,
            super::super::capacity_allocator::snapshot,
        )?;
        let observation = report.diagnostic.context("missing registered query")?;
        ensure!(
            observation.registration.registered
                && observation.query.status == "available"
                && observation.cleanup.reader_closed
                && observation.cleanup.workspace_participant_released
                && observation.cleanup.disposable_database_removed,
            "registered Graph positive response was unavailable or not fully cleaned up"
        );
        Ok(())
    }
}
