//! Candidate-bound, offline C2-ZC restore fixture support.
//!
//! This module is deliberately a fixture builder, not another product write
//! route.  Project and tree state is created through the same typed writers a
//! Native caller uses.  The two rebuildable derived tables are intentionally
//! left absent by declaring the owner Edge only after the Feed/Cursor has
//! settled; the product lifecycle must repair that restore gap.  The
//! resulting database is copied with [`Database::backup_to`], and an
//! immutable manifest binds the bytes and semantic contents to a clean
//! candidate checkout.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::domain_writes::{
    project_create, project_delete, tree_node_create, ProjectCreatePayload, ProjectDeletePayload,
    TreeNodeCreatePayload,
};
use crate::Database;

use super::change_feed::NarrativeChangeOrigin;
use super::dependency_edges::{
    canonical_source_object_identity, record_dependency_edge_in_tx, RUN_CONSUMER_KIND,
};
use super::legacy_backfill::bootstrap_legacy_dependency_backfill_for_project;
use super::models::{CreateRunPayload, RunRefPayload};
use super::task_leases::with_immediate_transaction;
use super::{
    digest_plan, narrative_extraction_cancel_run, narrative_extraction_create_run,
    run_incremental_freshness_cycle, C2_ZC_CUTOVER_MIGRATION_ID,
};

/// Version of the support code that produced a fixture.  This is part of the
/// manifest contract: a later builder must not silently reinterpret old
/// fixture semantics.
pub const C2ZC_RESTORE_FIXTURE_BUILDER_VERSION: &str = "c2zc-restore-fixture-builder/v1";
pub const C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION: u32 = 1;
pub const C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION: u32 = 1;
pub const C2ZC_RESTORE_FIXTURE_CURSOR_CONSUMER_ID: &str = "narrative-incremental-freshness/v1";
pub const C2ZC_RESTORE_FIXTURE_PROJECT_ID: &str = "c2zc-restore-fixture-project";
pub const C2ZC_RESTORE_FIXTURE_SCENE_ID: &str = "c2zc-restore-fixture-scene";
pub const C2ZC_RESTORE_FIXTURE_OWNER_RUN_ID: &str = "c2zc-restore-fixture-owner-run";

const PROJECT_ID: &str = C2ZC_RESTORE_FIXTURE_PROJECT_ID;
const SCENE_ID: &str = C2ZC_RESTORE_FIXTURE_SCENE_ID;
const OWNER_RUN_ID: &str = C2ZC_RESTORE_FIXTURE_OWNER_RUN_ID;
const DEFAULT_PROJECT_ID: &str = "default-project";
const DATABASE_FILE_NAME: &str = "c2zc-restore-fixture.db";
const BACKUP_FILE_NAME: &str = "c2zc-restore-fixture.backup.db";
const MANIFEST_FILE_NAME: &str = "c2zc-restore-fixture.manifest.json";

type FixtureCursorRow = (
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// Inputs for a fixture build.  `repo_root` and `output_dir` are intentionally
/// separate so a generated artifact can never dirty the candidate checkout.
#[derive(Clone, Debug)]
pub struct FixtureBuildOptions {
    pub repo_root: PathBuf,
    pub output_dir: PathBuf,
    pub candidate: String,
    pub expected_head_sha: Option<String>,
    pub expected_tree_sha: Option<String>,
    /// The exact argv supplied to the builder.  The CLI passes its real argv;
    /// library callers may provide a stable invocation string for a manifest.
    pub builder_command: Vec<String>,
}

impl FixtureBuildOptions {
    pub fn new(repo_root: impl Into<PathBuf>, output_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            output_dir: output_dir.into(),
            candidate: "HEAD".to_string(),
            expected_head_sha: None,
            expected_tree_sha: None,
            builder_command: std::env::args().collect(),
        }
    }

    pub fn with_candidate(mut self, candidate: impl Into<String>) -> Self {
        self.candidate = candidate.into();
        self
    }

    pub fn with_expected_head(mut self, sha: impl Into<String>) -> Self {
        self.expected_head_sha = Some(sha.into());
        self
    }

    pub fn with_expected_tree(mut self, sha: impl Into<String>) -> Self {
        self.expected_tree_sha = Some(sha.into());
        self
    }

    pub fn with_builder_command(mut self, command: Vec<String>) -> Self {
        self.builder_command = command;
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateBinding {
    pub requested: String,
    pub resolved_head_sha: String,
    pub resolved_tree_sha: String,
    pub head_sha: String,
    pub tree_sha: String,
    pub clean: bool,
    pub status_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDigest {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureArtifacts {
    pub fixture: ArtifactDigest,
    pub database: ArtifactDigest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSnapshot {
    pub project_id: String,
    pub scene_id: String,
    pub owner_run_id: String,
    pub project_count: i64,
    pub scene_count: i64,
    pub e0_count: i64,
    pub completed_backfill_count: i64,
    pub dependency_edge_count: i64,
    pub edge_state_count: i64,
    pub owner_freshness_count: i64,
    pub cursor_settled: bool,
    pub semantic_index_rows: i64,
    pub scene_source_revision: String,
    pub edge_source_object_identity: String,
    pub edge_read_set_json: String,
    pub project: Value,
    pub project_digest: String,
    pub scene: Value,
    pub scene_digest: String,
    pub epoch: Value,
    pub epoch_digest: String,
    pub backfill: Value,
    pub backfill_digest: String,
    pub edge: Value,
    pub edge_digest: String,
    pub feed_cursor: Value,
    pub feed_cursor_digest: String,
    pub derived_state_gap: Value,
    pub semantic_index: Value,
    pub expected_restore_lifecycle: Value,
    pub contents_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureManifest {
    pub manifest_version: u32,
    pub contract_version: u32,
    pub schema_version: i32,
    pub database_schema_version: i32,
    pub c2zc_marker_present: bool,
    pub candidate: CandidateBinding,
    pub builder_version: String,
    pub builder_command: Vec<String>,
    pub exact_builder_command: Vec<String>,
    pub artifacts: FixtureArtifacts,
    pub fixture_sha256: String,
    pub fixture_size_bytes: u64,
    pub semantic: SemanticSnapshot,
}

#[derive(Clone, Debug)]
pub struct FixtureBuildResult {
    pub database_path: PathBuf,
    pub backup_path: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: FixtureManifest,
}

#[derive(Clone, Debug)]
struct CandidateResolution {
    root: PathBuf,
    binding: CandidateBinding,
}

/// Build one C2-ZC restore fixture and its immutable manifest.
pub fn build_offline_restore_fixture(options: FixtureBuildOptions) -> Result<FixtureBuildResult> {
    let candidate = resolve_candidate(&options)?;
    let output_dir = prepare_output_dir(&candidate.root, &options.output_dir)?;
    let database_path = output_dir.join(DATABASE_FILE_NAME);
    let backup_path = output_dir.join(BACKUP_FILE_NAME);
    let manifest_path = output_dir.join(MANIFEST_FILE_NAME);
    for path in [&database_path, &backup_path, &manifest_path] {
        ensure_absent_artifact(path)?;
    }

    let db = Database::new(&database_path).context("opening fixture database")?;
    db.migrate().context("migrating fixture database")?;
    create_fixture_domain(&db)?;
    settle_change_feed(&db)?;
    let edge_id = create_fixture_owner_and_edge(&db)?;
    assert_derived_state_gap(&db, &edge_id)?;
    let semantic = collect_semantic_snapshot(&db, &edge_id)?;
    validate_fixture_semantics(&semantic)?;
    db.backup_to(&backup_path)
        .context("creating WAL-safe fixture backup")?;
    validate_backup(&backup_path, &semantic)?;
    drop(db);
    materialize_standalone_database(&database_path, &backup_path)?;

    let database_digest = digest_file(&database_path)?;
    let fixture_digest = digest_file(&backup_path)?;
    let relative_database = relative_artifact_name(DATABASE_FILE_NAME);
    let relative_fixture = relative_artifact_name(BACKUP_FILE_NAME);
    let database_artifact = ArtifactDigest {
        path: relative_database,
        sha256: database_digest.0,
        size_bytes: database_digest.1,
    };
    let fixture_artifact = ArtifactDigest {
        path: relative_fixture,
        sha256: fixture_digest.0.clone(),
        size_bytes: fixture_digest.1,
    };
    let command = if options.builder_command.is_empty() {
        vec!["c2zc-restore-fixture".to_string()]
    } else {
        options.builder_command
    };
    let manifest = FixtureManifest {
        manifest_version: C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION,
        contract_version: C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION,
        schema_version: grimodex_core::SCHEMA_VERSION,
        database_schema_version: grimodex_core::SCHEMA_VERSION,
        c2zc_marker_present: false,
        candidate: candidate.binding,
        builder_version: C2ZC_RESTORE_FIXTURE_BUILDER_VERSION.to_string(),
        builder_command: command.clone(),
        exact_builder_command: command,
        artifacts: FixtureArtifacts {
            fixture: fixture_artifact,
            database: database_artifact,
        },
        fixture_sha256: fixture_digest.0,
        fixture_size_bytes: fixture_digest.1,
        semantic,
    };
    write_immutable_manifest(&manifest_path, &manifest)?;
    verify_manifest(&manifest_path)?;
    Ok(FixtureBuildResult {
        database_path,
        backup_path,
        manifest_path,
        manifest,
    })
}

/// Verify the manifest, artifact bytes, and restore-bound semantic contract.
/// This is intentionally independent of the builder's in-memory snapshot so
/// lifecycle code can call it after copying or transporting the fixture.
pub fn verify_manifest(manifest_path: &Path) -> Result<FixtureManifest> {
    reject_symlink_components(manifest_path)?;
    let manifest_path = existing_regular_file(manifest_path, "manifest")?;
    let bytes = fs::read(&manifest_path).context("reading fixture manifest")?;
    let manifest: FixtureManifest = serde_json::from_slice(&bytes)
        .context("parsing C2-ZC restore fixture manifest")?;
    anyhow::ensure!(
        manifest.manifest_version == C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION,
        "C2ZC_FIXTURE_MANIFEST_VERSION_UNSUPPORTED: {}",
        manifest.manifest_version
    );
    anyhow::ensure!(
        manifest.contract_version == C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION,
        "C2ZC_FIXTURE_CONTRACT_VERSION_UNSUPPORTED: {}",
        manifest.contract_version
    );
    anyhow::ensure!(
        manifest.schema_version == grimodex_core::SCHEMA_VERSION
            && manifest.database_schema_version == manifest.schema_version,
        "C2ZC_FIXTURE_SCHEMA_VERSION_UNSUPPORTED: schema={} database={}",
        manifest.schema_version,
        manifest.database_schema_version
    );
    anyhow::ensure!(
        manifest.builder_version == C2ZC_RESTORE_FIXTURE_BUILDER_VERSION,
        "C2ZC_FIXTURE_BUILDER_VERSION_UNSUPPORTED: {}",
        manifest.builder_version
    );
    anyhow::ensure!(
        !manifest.c2zc_marker_present,
        "C2ZC_FIXTURE_MARKER_PRESENT: fixture is already activated"
    );
    anyhow::ensure!(
        manifest.candidate.clean,
        "C2ZC_FIXTURE_CANDIDATE_DIRTY: manifest candidate is not clean"
    );
    anyhow::ensure!(
        !manifest.candidate.requested.trim().is_empty()
            && manifest.candidate.requested.trim() == manifest.candidate.requested
            && !manifest.candidate.requested.contains('\0'),
        "C2ZC_FIXTURE_CANDIDATE_REF_INVALID"
    );
    validate_sha256ish_git_oid(&manifest.candidate.resolved_head_sha, "candidate head")?;
    validate_sha256ish_git_oid(&manifest.candidate.resolved_tree_sha, "candidate tree")?;
    validate_sha256ish_git_oid(&manifest.candidate.head_sha, "candidate head alias")?;
    validate_sha256ish_git_oid(&manifest.candidate.tree_sha, "candidate tree alias")?;
    anyhow::ensure!(
        manifest.candidate.resolved_head_sha == manifest.candidate.head_sha
            && manifest.candidate.resolved_tree_sha == manifest.candidate.tree_sha,
        "C2ZC_FIXTURE_CANDIDATE_BINDING_MISMATCH"
    );
    validate_sha256(&manifest.candidate.status_sha256, "candidate status")?;
    validate_sha256(&manifest.fixture_sha256, "fixture")?;
    let base = manifest_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_MANIFEST_PARENT_MISSING"))?;
    let fixture_path = resolve_relative_artifact(base, &manifest.artifacts.fixture.path)?;
    let database_path = resolve_relative_artifact(base, &manifest.artifacts.database.path)?;
    verify_artifact(
        &fixture_path,
        &manifest.artifacts.fixture,
        "fixture",
    )?;
    verify_artifact(
        &database_path,
        &manifest.artifacts.database,
        "database",
    )?;
    anyhow::ensure!(
        manifest.artifacts.fixture.sha256 == manifest.fixture_sha256
            && manifest.artifacts.fixture.size_bytes == manifest.fixture_size_bytes,
        "C2ZC_FIXTURE_MANIFEST_ARTIFACT_MISMATCH: top-level fixture digest disagrees with artifact"
    );
    let connection = Connection::open(&fixture_path).context("opening fixture backup")?;
    quick_check_connection(&connection)?;
    let schema_version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    anyhow::ensure!(
        schema_version == manifest.schema_version,
        "C2ZC_FIXTURE_SCHEMA_VERSION_MISMATCH: manifest={} actual={}",
        manifest.schema_version,
        schema_version
    );
    let edge_id = validate_backup_semantics(&connection, &manifest.semantic)?;
    let _ = edge_id;
    Ok(manifest)
}

/// Verify a manifest and re-resolve its recorded candidate against a clean
/// checkout.  Lifecycle callers should use this when the fixture and source
/// checkout are available together; [`verify_manifest`] remains useful after
/// an artifact-only transport.
pub fn verify_manifest_against_candidate(
    manifest_path: &Path,
    repo_root: &Path,
    candidate: Option<&str>,
) -> Result<FixtureManifest> {
    let manifest = verify_manifest(manifest_path)?;
    let requested = candidate.unwrap_or(&manifest.candidate.requested);
    let options = FixtureBuildOptions::new(repo_root, manifest_path.parent().unwrap_or(repo_root))
        .with_candidate(requested.to_string());
    let resolved = resolve_candidate(&options)?;
    anyhow::ensure!(
        resolved.binding.resolved_head_sha == manifest.candidate.resolved_head_sha
            && resolved.binding.resolved_tree_sha == manifest.candidate.resolved_tree_sha
            && resolved.binding.status_sha256 == manifest.candidate.status_sha256,
        "C2ZC_FIXTURE_CANDIDATE_BINDING_MISMATCH: manifest and checkout differ"
    );
    Ok(manifest)
}

fn create_fixture_domain(db: &Database) -> Result<()> {
    project_delete(
        db,
        ProjectDeletePayload {
            project_id: DEFAULT_PROJECT_ID.to_string(),
        },
    )
    .context("removing migration bootstrap project through typed writer")?;
    let timestamp = grimodex_core::now_rfc3339_millis();
    project_create(
        db,
        ProjectCreatePayload {
            project_id: PROJECT_ID.to_string(),
            request_id: "c2zc-restore-fixture-project-create".to_string(),
            session_id: "c2zc-restore-fixture-session".to_string(),
            event_uid: "c2zc-restore-fixture-project-event".to_string(),
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            undo_journal_id: None,
            title: "C2-ZC offline restore fixture".to_string(),
            genre: Some("fixture".to_string()),
            pov: None,
            tense: None,
            language: Some("en".to_string()),
            style_guide: None,
            ai_instructions: None,
            outline: None,
            target_readers: None,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        },
    )
    .context("creating fixture project through typed writer")?;
    tree_node_create(
        db,
        TreeNodeCreatePayload {
            id: SCENE_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            request_id: "c2zc-restore-fixture-scene-create".to_string(),
            session_id: "c2zc-restore-fixture-session".to_string(),
            event_uid: "c2zc-restore-fixture-scene-event".to_string(),
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".to_string(),
            title: "Offline restore scene".to_string(),
            sort_order: "a0".to_string(),
            synopsis: Some("A canonical source used by the restore gap fixture.".to_string()),
            status: Some("draft".to_string()),
            source_uri: None,
            source_mtime: None,
            content: Some("{}".to_string()),
            canonical_payload: None,
        },
    )
    .context("creating fixture scene through typed writer")?;
    bootstrap_legacy_dependency_backfill_for_project(db, PROJECT_ID)
        .context("creating completed historical Backfill boundary")?;
    Ok(())
}

fn settle_change_feed(db: &Database) -> Result<()> {
    for _ in 0..64 {
        match run_incremental_freshness_cycle(db)? {
            super::IncrementalFreshnessCycleOutcome::Idle => return Ok(()),
            super::IncrementalFreshnessCycleOutcome::Processed(_) => continue,
            super::IncrementalFreshnessCycleOutcome::Held(summary) => anyhow::bail!(
                "C2ZC_FIXTURE_CURSOR_HELD: freshness cycle held project '{}'",
                summary.project_id
            ),
        }
    }
    anyhow::bail!("C2ZC_FIXTURE_CURSOR_DID_NOT_SETTLE: bounded cycle limit exceeded")
}

fn create_fixture_owner_and_edge(db: &Database) -> Result<String> {
    let spec = json!({
        "fixture": "c2zc-restore-verify-rebuild-verify",
        "contractVersion": C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION,
    });
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(OWNER_RUN_ID.to_string()),
            project_id: PROJECT_ID.to_string(),
            surface_path_id: "c2zc.restore.fixture".to_string(),
            scope_json: json!({ "projectId": PROJECT_ID }),
            spec_digest: format!("sha256:{}", digest_plan(&spec)),
            spec_json: spec,
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: Vec::new(),
        },
    )
    .context("creating fixture owner run through typed writer")?;
    narrative_extraction_cancel_run(
        db,
        RunRefPayload {
            run_id: OWNER_RUN_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .context("terminalizing fixture owner run through typed writer")?;

    let (source_revision, edge_identity) = db.with_conn(|conn| {
        let updated: (i64, String) = conn.query_row(
            "SELECT version, updated_at FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
            params![SCENE_ID, PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let source_identity = canonical_source_object_identity(
            "scene-body",
            &format!("project:scene:{SCENE_ID}"),
        )?;
        Ok((format!("v{}@{}", updated.0, updated.1), source_identity))
    })?;
    let read_set_json = serde_json::to_string(&vec![source_revision])?;
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            record_dependency_edge_in_tx(
                conn,
                PROJECT_ID,
                RUN_CONSUMER_KIND,
                OWNER_RUN_ID,
                &edge_identity,
                &read_set_json,
                None,
                Some(OWNER_RUN_ID),
                &grimodex_core::now_rfc3339_millis(),
            )
        })
    })
    .context("recording fixture dependency Edge through production writer")
}

/// Assert the rebuildable derived-state gap created by the canonical writer
/// ordering.  The Feed/Cursor is settled before the owner Edge is declared,
/// so the production Edge writer leaves both derived tables absent.  Keeping
/// this helper read-only is important: fixture construction must not bypass a
/// product writer with ad-hoc domain DML, even for derived rows.
fn assert_derived_state_gap(db: &Database, edge_id: &str) -> Result<()> {
    db.with_conn(|conn| {
        let edge_state_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edge_states
              WHERE project_id = ?1 AND edge_id = ?2",
            params![PROJECT_ID, edge_id],
            |row| row.get(0),
        )?;
        let owner_freshness_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = ?1
                AND consumer_kind = ?2
                AND consumer_key = ?3",
            params![PROJECT_ID, RUN_CONSUMER_KIND, OWNER_RUN_ID],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            edge_state_count == 0 && owner_freshness_count == 0,
            "C2ZC_FIXTURE_DERIVED_STATE_ALREADY_PRESENT: edgeState={} ownerFreshness={}",
            edge_state_count,
            owner_freshness_count
        );
        Ok(())
    })
}

fn collect_semantic_snapshot(db: &Database, edge_id: &str) -> Result<SemanticSnapshot> {
    db.with_conn(|conn| collect_semantic_snapshot_from_connection(conn, edge_id))
}

fn collect_semantic_snapshot_from_connection(
    conn: &Connection,
    edge_id: &str,
) -> Result<SemanticSnapshot> {
    let c2zc_marker_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
        params![C2_ZC_CUTOVER_MIGRATION_ID],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        c2zc_marker_count == 0,
        "C2ZC_FIXTURE_MARKER_PRESENT: current C2-ZC marker count={c2zc_marker_count}"
    );
    let project_count: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    let scene_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes WHERE project_id = ?1",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let project = conn.query_row(
        "SELECT id, title, genre, pov, tense, language, created_at, updated_at
           FROM projects WHERE id = ?1",
        params![PROJECT_ID],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "genre": row.get::<_, Option<String>>(2)?,
                "pov": row.get::<_, Option<String>>(3)?,
                "tense": row.get::<_, Option<String>>(4)?,
                "language": row.get::<_, String>(5)?,
                "createdAt": row.get::<_, String>(6)?,
                "updatedAt": row.get::<_, String>(7)?,
            }))
        },
    )?;
    let scene = conn.query_row(
        "SELECT id, project_id, node_type, title, synopsis, status,
                content, version, updated_at
           FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        params![SCENE_ID, PROJECT_ID],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "projectId": row.get::<_, String>(1)?,
                "nodeType": row.get::<_, String>(2)?,
                "title": row.get::<_, String>(3)?,
                "synopsis": row.get::<_, Option<String>>(4)?,
                "status": row.get::<_, Option<String>>(5)?,
                "content": row.get::<_, String>(6)?,
                "version": row.get::<_, i64>(7)?,
                "updatedAt": row.get::<_, String>(8)?,
            }))
        },
    )?;
    let e0_rows = query_json_rows(
        conn,
        "SELECT id, project_id, epoch_number, reason,
                triggered_by_change_event_uid, created_at
           FROM narrative_semantic_epochs
          WHERE project_id = ?1 AND epoch_number = 0
          ORDER BY id",
        params![PROJECT_ID],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "projectId": row.get::<_, String>(1)?,
                "epochNumber": row.get::<_, i64>(2)?,
                "reason": row.get::<_, String>(3)?,
                "triggeredByChangeEventUid": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
            }))
        },
    )?;
    let epoch = json!({ "rows": e0_rows });
    let e0_count = epoch["rows"].as_array().map_or(0, Vec::len) as i64;

    let backfill = load_backfill_snapshot(conn)?;
    let completed_backfill_count = backfill["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["status"] == Value::String("completed".to_string()))
                .count()
        })
        .unwrap_or(0) as i64;
    let edge = conn.query_row(
        "SELECT id, project_id, consumer_kind, consumer_key,
                source_object_identity, read_set_json,
                generated_by_transaction_id, created_at, owning_run_id
           FROM narrative_dependency_edges
          WHERE id = ?1 AND project_id = ?2",
        params![edge_id, PROJECT_ID],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "projectId": row.get::<_, String>(1)?,
                "consumerKind": row.get::<_, String>(2)?,
                "consumerKey": row.get::<_, String>(3)?,
                "sourceObjectIdentity": row.get::<_, String>(4)?,
                "readSetJson": row.get::<_, String>(5)?,
                "generatedByTransactionId": row.get::<_, Option<String>>(6)?,
                "createdAt": row.get::<_, String>(7)?,
                "owningRunId": row.get::<_, Option<String>>(8)?,
            }))
        },
    )?;
    let (scene_version, scene_updated_at): (i64, String) = conn.query_row(
        "SELECT version, updated_at FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        params![SCENE_ID, PROJECT_ID],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let scene_source_revision = format!("v{scene_version}@{scene_updated_at}");
    let edge_source_object_identity = edge["sourceObjectIdentity"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let edge_read_set_json = edge["readSetJson"].as_str().unwrap_or_default().to_string();
    let edge_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id = ?1",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let edge_state_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edge_states
          WHERE project_id = ?1 AND edge_id = ?2",
        params![PROJECT_ID, edge_id],
        |row| row.get(0),
    )?;
    let owner_freshness_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        params![PROJECT_ID, RUN_CONSUMER_KIND, OWNER_RUN_ID],
        |row| row.get(0),
    )?;

    let (feed_cursor, cursor_settled) = load_feed_cursor_snapshot(conn)?;
    let (semantic_index, semantic_index_rows) = load_semantic_index_snapshot(conn)?;
    let derived_state_gap = json!({
        "edgeStateRows": edge_state_count,
        "ownerFreshnessRows": owner_freshness_count,
        "rebuildScope": "narrative_dependency_edge_states+narrative_consumer_freshness",
    });
    let expected_restore_lifecycle = json!({
        "firstVerify": "rebuild-required",
        "conditionalRebuild": "required",
        "confirmationVerify": "clean",
    });
    let epoch_digest = digest_json(&epoch);
    let backfill_digest = digest_json(&backfill);
    let edge_digest = digest_json(&edge);
    let feed_cursor_digest = digest_json(&feed_cursor);
    let contents = json!({
        "projectId": PROJECT_ID,
        "sceneId": SCENE_ID,
        "ownerRunId": OWNER_RUN_ID,
        "projectCount": project_count,
        "sceneCount": scene_count,
        "e0Count": e0_count,
        "completedBackfillCount": completed_backfill_count,
        "dependencyEdgeCount": edge_count,
        "edgeStateCount": edge_state_count,
        "ownerFreshnessCount": owner_freshness_count,
        "cursorSettled": cursor_settled,
        "semanticIndexRows": semantic_index_rows,
        "sceneSourceRevision": scene_source_revision,
        "edgeSourceObjectIdentity": edge_source_object_identity,
        "edgeReadSetJson": edge_read_set_json,
        "project": project,
        "scene": scene,
        "epoch": epoch,
        "backfill": backfill,
        "edge": edge,
        "feedCursor": feed_cursor,
        "derivedStateGap": derived_state_gap,
        "semanticIndex": semantic_index,
        "expectedRestoreLifecycle": expected_restore_lifecycle,
    });
    Ok(SemanticSnapshot {
        project_id: PROJECT_ID.to_string(),
        scene_id: SCENE_ID.to_string(),
        owner_run_id: OWNER_RUN_ID.to_string(),
        project_count,
        scene_count,
        e0_count,
        completed_backfill_count,
        dependency_edge_count: edge_count,
        edge_state_count,
        owner_freshness_count,
        cursor_settled,
        semantic_index_rows,
        scene_source_revision,
        edge_source_object_identity,
        edge_read_set_json,
        project_digest: digest_json(&project),
        project,
        scene_digest: digest_json(&scene),
        scene,
        epoch,
        epoch_digest,
        backfill,
        backfill_digest,
        edge,
        edge_digest,
        feed_cursor,
        feed_cursor_digest,
        derived_state_gap,
        semantic_index,
        expected_restore_lifecycle,
        contents_digest: digest_json(&contents),
    })
}

fn validate_fixture_semantics(semantic: &SemanticSnapshot) -> Result<()> {
    anyhow::ensure!(
        semantic.project_count == 1,
        "C2ZC_FIXTURE_PROJECT_COUNT_INVALID: {}",
        semantic.project_count
    );
    anyhow::ensure!(
        semantic.scene_count == 1,
        "C2ZC_FIXTURE_SCENE_COUNT_INVALID: {}",
        semantic.scene_count
    );
    anyhow::ensure!(
        semantic.e0_count == 1,
        "C2ZC_FIXTURE_E0_INVALID: {}",
        semantic.e0_count
    );
    anyhow::ensure!(
        semantic.completed_backfill_count == 1,
        "C2ZC_FIXTURE_BACKFILL_INVALID: {}",
        semantic.completed_backfill_count
    );
    anyhow::ensure!(
        semantic.backfill["rows"].as_array().is_some_and(|rows| rows.len() == 1),
        "C2ZC_FIXTURE_BACKFILL_BOUNDARY_INVALID"
    );
    anyhow::ensure!(
        semantic.dependency_edge_count == 1,
        "C2ZC_FIXTURE_EDGE_INVALID: {}",
        semantic.dependency_edge_count
    );
    anyhow::ensure!(
        semantic.edge_state_count == 0 && semantic.owner_freshness_count == 0,
        "C2ZC_FIXTURE_DERIVED_GAP_INVALID: edgeState={} ownerFreshness={}",
        semantic.edge_state_count,
        semantic.owner_freshness_count
    );
    anyhow::ensure!(
        semantic.cursor_settled,
        "C2ZC_FIXTURE_CURSOR_UNSETTLED"
    );
    anyhow::ensure!(
        semantic.semantic_index_rows == 0,
        "C2ZC_FIXTURE_SEMANTIC_INDEX_PRESENT: {}",
        semantic.semantic_index_rows
    );
    anyhow::ensure!(
        semantic.edge["consumerKind"] == Value::String(RUN_CONSUMER_KIND.to_string())
            && semantic.edge["consumerKey"] == Value::String(OWNER_RUN_ID.to_string())
            && semantic.edge["owningRunId"] == Value::String(OWNER_RUN_ID.to_string()),
        "C2ZC_FIXTURE_EDGE_OWNER_INVALID"
    );
    anyhow::ensure!(
        semantic.edge_source_object_identity == format!("project:scene:{SCENE_ID}"),
        "C2ZC_FIXTURE_EDGE_SOURCE_INVALID: {}",
        semantic.edge_source_object_identity
    );
    let read_set: Value = serde_json::from_str(&semantic.edge_read_set_json)
        .context("C2ZC_FIXTURE_EDGE_READ_SET_INVALID")?;
    anyhow::ensure!(
        read_set == json!([semantic.scene_source_revision]),
        "C2ZC_FIXTURE_EDGE_READ_SET_MISMATCH: expected=[{}] actual={}",
        semantic.scene_source_revision,
        semantic.edge_read_set_json
    );
    Ok(())
}

fn validate_backup(path: &Path, semantic: &SemanticSnapshot) -> Result<()> {
    let connection = Connection::open(path).context("opening generated fixture backup")?;
    quick_check_connection(&connection)?;
    let schema_version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    anyhow::ensure!(
        schema_version == grimodex_core::SCHEMA_VERSION,
        "C2ZC_FIXTURE_SCHEMA_VERSION_MISMATCH: expected={} actual={}",
        grimodex_core::SCHEMA_VERSION,
        schema_version
    );
    let edge_id = connection.query_row(
        "SELECT id FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        params![PROJECT_ID, RUN_CONSUMER_KIND, OWNER_RUN_ID],
        |row| row.get::<_, String>(0),
    )?;
    let copied = collect_semantic_snapshot_from_connection(&connection, &edge_id)?;
    anyhow::ensure!(
        copied.contents_digest == semantic.contents_digest,
        "C2ZC_FIXTURE_BACKUP_SEMANTIC_MISMATCH: generated backup differs from live snapshot"
    );
    Ok(())
}

fn materialize_standalone_database(database_path: &Path, backup_path: &Path) -> Result<()> {
    // `Database::backup_to` is the authoritative snapshot.  Once the live
    // connection is closed, replace the live file with that compact snapshot
    // so the manifest's database artifact is independently WAL-safe as well;
    // no `-wal`/`-shm` sidecar is needed to open it.
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = path_with_suffix(database_path, suffix);
        if fs::symlink_metadata(&sidecar).is_ok() {
            reject_symlink_components(&sidecar)?;
            fs::remove_file(&sidecar)
                .with_context(|| format!("removing generated SQLite sidecar '{}'", sidecar.display()))?;
        }
    }
    fs::copy(backup_path, database_path).context("materializing standalone fixture database")?;
    Ok(())
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn validate_backup_semantics(conn: &Connection, expected: &SemanticSnapshot) -> Result<String> {
    let edge_id: String = conn.query_row(
        "SELECT id FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
        params![
            expected.project_id,
            RUN_CONSUMER_KIND,
            expected.owner_run_id
        ],
        |row| row.get(0),
    )?;
    let actual = collect_semantic_snapshot_from_connection(conn, &edge_id)?;
    validate_fixture_semantics(&actual)?;
    anyhow::ensure!(
        actual.contents_digest == expected.contents_digest
            && actual.epoch_digest == expected.epoch_digest
            && actual.backfill_digest == expected.backfill_digest
            && actual.edge_digest == expected.edge_digest
            && actual.feed_cursor_digest == expected.feed_cursor_digest,
        "C2ZC_FIXTURE_SEMANTIC_DIGEST_MISMATCH"
    );
    Ok(edge_id)
}

fn load_backfill_snapshot(conn: &Connection) -> Result<Value> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, run_kind, work_key, spec_json, spec_digest,
                status, semantic_epoch_id, created_at, started_at, completed_at,
                outcome_summary_json
           FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = 'backfill'
          ORDER BY id",
    )?;
    let rows = statement
        .query_map(params![PROJECT_ID], |row| {
            let run_id: String = row.get(0)?;
            let task_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1",
                params![run_id],
                |task_row| task_row.get(0),
            )?;
            let attempt_count: i64 = conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_extraction_attempts a
                  WHERE EXISTS (
                    SELECT 1 FROM narrative_extraction_tasks t
                     WHERE t.id = a.task_id AND t.run_id = ?1
                  )",
                params![run_id],
                |attempt_row| attempt_row.get(0),
            )?;
            Ok(json!({
                "id": run_id,
                "projectId": row.get::<_, String>(1)?,
                "runKind": row.get::<_, String>(2)?,
                "workKey": row.get::<_, Option<String>>(3)?,
                "specJson": row.get::<_, String>(4)?,
                "specDigest": row.get::<_, String>(5)?,
                "status": row.get::<_, String>(6)?,
                "semanticEpochId": row.get::<_, Option<String>>(7)?,
                "createdAt": row.get::<_, String>(8)?,
                "startedAt": row.get::<_, Option<String>>(9)?,
                "completedAt": row.get::<_, Option<String>>(10)?,
                "outcomeSummaryJson": row.get::<_, Option<String>>(11)?,
                "taskCount": task_count,
                "attemptCount": attempt_count,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "rows": rows }))
}

fn load_feed_cursor_snapshot(conn: &Connection) -> Result<(Value, bool)> {
    let feed_head: i64 = conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0)
           FROM narrative_change_events WHERE project_id = ?1",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let row: Option<FixtureCursorRow> = conn
        .query_row(
            "SELECT consumer_id, acknowledged_through_sequence, lease_owner,
                    lease_expires_at, last_error, updated_at, project_id
               FROM narrative_change_cursors
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![PROJECT_ID, C2ZC_RESTORE_FIXTURE_CURSOR_CONSUMER_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((consumer_id, acknowledged, lease_owner, lease_expires_at, last_error, updated_at, project_id)) = row else {
        return Ok((json!({ "feedHead": feed_head, "cursor": Value::Null }), false));
    };
    let settled = project_id == PROJECT_ID
        && consumer_id == C2ZC_RESTORE_FIXTURE_CURSOR_CONSUMER_ID
        && acknowledged == feed_head
        && lease_owner.is_none()
        && lease_expires_at.is_none()
        && last_error.is_none();
    Ok((
        json!({
            "feedHead": feed_head,
            "cursor": {
                "projectId": project_id,
                "consumerId": consumer_id,
                "acknowledgedThroughSequence": acknowledged,
                "leaseOwner": lease_owner,
                "leaseExpiresAt": lease_expires_at,
                "lastError": last_error,
                "updatedAt": updated_at,
            },
        }),
        settled,
    ))
}

fn load_semantic_index_snapshot(conn: &Connection) -> Result<(Value, i64)> {
    let metadata: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_semantic_index_metadata WHERE project_id = ?1",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let declarations: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_declaration_heads
          WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let edges: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let freshness: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let total = metadata + declarations + edges + freshness;
    Ok((
        json!({
            "metadataRows": metadata,
            "activeD1HeadRows": declarations,
            "v1EdgeRows": edges,
            "consumerFreshnessRows": freshness,
            "totalRows": total,
        }),
        total,
    ))
}

fn query_json_rows<F>(
    conn: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
    mapper: F,
) -> Result<Vec<Value>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
{
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map(parameters, mapper)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn digest_json(value: &Value) -> String {
    format!("sha256:{}", digest_plan(value))
}

fn quick_check_connection(conn: &Connection) -> Result<()> {
    let result: String = conn.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    anyhow::ensure!(result == "ok", "C2ZC_FIXTURE_QUICK_CHECK_FAILED: {result}");
    Ok(())
}

fn digest_file(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path).with_context(|| format!("opening artifact '{}'`", path.display()))?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_FILE_SIZE_OVERFLOW"))?;
    }
    Ok((format!("sha256:{}", hex::encode(hasher.finalize())), size))
}

fn write_immutable_manifest(path: &Path, manifest: &FixtureManifest) -> Result<()> {
    ensure_absent_artifact(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_MANIFEST_PARENT_MISSING"))?;
    let temp = parent.join(format!(".{MANIFEST_FILE_NAME}.tmp"));
    ensure_absent_artifact(&temp)?;
    let encoded = serde_json::to_vec_pretty(manifest)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .context("creating manifest staging file")?;
    file.write_all(&encoded)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path).context("publishing immutable fixture manifest")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o444))?;
    }
    Ok(())
}

fn resolve_candidate(options: &FixtureBuildOptions) -> Result<CandidateResolution> {
    reject_symlink_components(&options.repo_root)?;
    let root = fs::canonicalize(&options.repo_root)
        .with_context(|| format!("resolving candidate root '{}'", options.repo_root.display()))?;
    anyhow::ensure!(root.is_dir(), "C2ZC_FIXTURE_CANDIDATE_ROOT_INVALID");
    anyhow::ensure!(
        !options.candidate.trim().is_empty()
            && options.candidate.trim() == options.candidate
            && !options.candidate.contains('\0'),
        "C2ZC_FIXTURE_CANDIDATE_REF_INVALID"
    );
    let candidate_commit = git_rev_parse(&root, &format!("{}^{{commit}}", options.candidate))?;
    let candidate_tree = git_rev_parse(&root, &format!("{}^{{tree}}", options.candidate))?;
    let head = git_rev_parse(&root, "HEAD^{commit}")?;
    let tree = git_rev_parse(&root, "HEAD^{tree}")?;
    anyhow::ensure!(
        candidate_commit == head,
        "C2ZC_FIXTURE_CANDIDATE_NOT_CURRENT_HEAD: requested={} resolved={} current={}",
        options.candidate,
        candidate_commit,
        head
    );
    anyhow::ensure!(
        candidate_tree == tree,
        "C2ZC_FIXTURE_CANDIDATE_TREE_MISMATCH: resolved={} current={}",
        candidate_tree,
        tree
    );
    if let Some(expected) = options.expected_head_sha.as_deref() {
        validate_sha256ish_git_oid(expected, "expected head")?;
        let expected = expected.to_ascii_lowercase();
        anyhow::ensure!(
            expected == head,
            "C2ZC_FIXTURE_CANDIDATE_HEAD_MISMATCH: expected={} actual={}",
            expected,
            head
        );
    }
    if let Some(expected) = options.expected_tree_sha.as_deref() {
        validate_sha256ish_git_oid(expected, "expected tree")?;
        let expected = expected.to_ascii_lowercase();
        anyhow::ensure!(
            expected == tree,
            "C2ZC_FIXTURE_CANDIDATE_TREE_MISMATCH: expected={} actual={}",
            expected,
            tree
        );
    }
    let status = git_command(&root, &["status", "--porcelain=v1", "--untracked-files=all"])?;
    anyhow::ensure!(
        status.is_empty(),
        "C2ZC_FIXTURE_CANDIDATE_DIRTY: git status is not empty: {}",
        status.trim_end()
    );
    let status_sha256 = digest_bytes(status.as_bytes());
    Ok(CandidateResolution {
        root,
        binding: CandidateBinding {
            requested: options.candidate.clone(),
            resolved_head_sha: head.clone(),
            resolved_tree_sha: tree.clone(),
            head_sha: head,
            tree_sha: tree,
            clean: true,
            status_sha256,
        },
    })
}

fn git_rev_parse(root: &Path, revision: &str) -> Result<String> {
    let output = git_command(root, &["rev-parse", "--verify", "--end-of-options", revision])?;
    let value = output.trim();
    anyhow::ensure!(
        (value.len() == 40 || value.len() == 64)
            && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "C2ZC_FIXTURE_GIT_OID_INVALID: {value}"
    );
    Ok(value.to_ascii_lowercase())
}

fn git_command(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if !output.status.success() {
        anyhow::bail!(
            "C2ZC_FIXTURE_GIT_FAILED: git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    String::from_utf8(output.stdout).context("git output is not UTF-8")
}

fn prepare_output_dir(candidate_root: &Path, output: &Path) -> Result<PathBuf> {
    reject_symlink_components(output)?;
    let lexical_output = lexical_absolute_path(output)?;
    anyhow::ensure!(
        lexical_output != candidate_root && !lexical_output.starts_with(candidate_root),
        "C2ZC_FIXTURE_OUTPUT_INSIDE_CANDIDATE: {}",
        lexical_output.display()
    );
    if !output.exists() {
        fs::create_dir_all(output).with_context(|| {
            format!("creating fixture output directory '{}'", output.display())
        })?;
    }
    reject_symlink_components(output)?;
    let output = fs::canonicalize(output)?;
    anyhow::ensure!(
        output != candidate_root && !output.starts_with(candidate_root),
        "C2ZC_FIXTURE_OUTPUT_INSIDE_CANDIDATE: {}",
        output.display()
    );
    anyhow::ensure!(output.is_dir(), "C2ZC_FIXTURE_OUTPUT_NOT_DIRECTORY");
    Ok(output)
}

fn ensure_absent_artifact(path: &Path) -> Result<()> {
    reject_symlink_components(path)?;
    if fs::symlink_metadata(path).is_ok() {
        anyhow::bail!(
            "C2ZC_FIXTURE_ARTIFACT_EXISTS: refusing to overwrite '{}'",
            path.display()
        );
    }
    Ok(())
}

fn existing_regular_file(path: &Path, label: &str) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("opening {label} '{}'`", path.display()))?;
    let label_upper = label.to_ascii_uppercase();
    anyhow::ensure!(
        metadata.file_type().is_file(),
        "C2ZC_FIXTURE_{label_upper}_NOT_REGULAR"
    );
    Ok(path.to_path_buf())
}

fn relative_artifact_name(name: &str) -> String {
    name.to_string()
}

fn resolve_relative_artifact(base: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    anyhow::ensure!(
        !path.is_absolute()
            && !path.components().any(|component| {
                matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
            }),
        "C2ZC_FIXTURE_ARTIFACT_PATH_ESCAPE: {relative}"
    );
    let result = base.join(path);
    reject_symlink_components(&result)?;
    Ok(result)
}

fn verify_artifact(path: &Path, expected: &ArtifactDigest, label: &str) -> Result<()> {
    let _ = existing_regular_file(path, label)?;
    let actual = digest_file(path)?;
    anyhow::ensure!(
        actual.0 == expected.sha256 && actual.1 == expected.size_bytes,
        "C2ZC_FIXTURE_HASH_MISMATCH: {label} expected={} bytes={} actual={} bytes={}",
        expected.sha256,
        expected.size_bytes,
        actual.0,
        actual.1
    );
    Ok(())
}

fn reject_symlink_components(path: &Path) -> Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
            }
            Component::Normal(value) => {
                current.push(value);
                if let Ok(metadata) = fs::symlink_metadata(&current) {
                    anyhow::ensure!(
                        !metadata.file_type().is_symlink(),
                        "C2ZC_FIXTURE_SYMLINK_PATH_REJECTED: {}",
                        current.display()
                    );
                }
            }
        }
    }
    Ok(())
}

fn lexical_absolute_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    Ok(normalized)
}

fn validate_sha256(value: &str, label: &str) -> Result<()> {
    anyhow::ensure!(
        value.strip_prefix("sha256:").is_some_and(|hex| {
            hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        }),
        "C2ZC_FIXTURE_SHA256_INVALID: {label}"
    );
    Ok(())
}

fn validate_sha256ish_git_oid(value: &str, label: &str) -> Result<()> {
    anyhow::ensure!(
        (value.len() == 40 || value.len() == 64)
            && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "C2ZC_FIXTURE_GIT_OID_INVALID: {label}"
    );
    Ok(())
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
