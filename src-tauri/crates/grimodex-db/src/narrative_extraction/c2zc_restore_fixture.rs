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

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::domain_writes::{
    project_create, project_delete, tree_node_create, ProjectCreatePayload, ProjectDeletePayload,
    TreeNodeCreatePayload,
};
use crate::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};

use super::change_feed::NarrativeChangeOrigin;
use super::dependency_edges::canonical_source_object_identity;
use super::legacy_backfill::{
    bootstrap_legacy_dependency_backfill_for_project, LegacyBackfillBootstrapOutcome,
    LEGACY_BACKFILL_ALGORITHM_VERSION, LEGACY_BACKFILL_WORK_KEY,
};
use super::models::{
    AppendDecisionPayload, ApplyCommitPayload, ClaimTaskPayload, CommitApplicationRef,
    CommitOperation, CreateRunPayload, CreateTaskSeed, FinishTaskPayload, PrepareCommitPayload,
    ProposalSeed, SaveProposalSetPayload,
};
use super::semantic_epoch::create_epoch_in_tx;
use super::{
    digest_plan, narrative_extraction_append_human_decision, narrative_extraction_apply_commit,
    narrative_extraction_claim_task, narrative_extraction_create_run,
    narrative_extraction_finish_task, narrative_extraction_prepare_commit,
    narrative_extraction_save_proposal_set, run_incremental_freshness_cycle,
    C2_ZC_CUTOVER_MIGRATION_ID,
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
type ApplicationSnapshotRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);
type BeforeManifestPublishHook = Arc<dyn Fn(&Path) -> Result<()> + Send + Sync>;

/// Inputs for a fixture build.  `repo_root` and `output_dir` are intentionally
/// separate so a generated artifact can never dirty the candidate checkout.
#[derive(Clone)]
pub struct FixtureBuildOptions {
    pub repo_root: PathBuf,
    pub output_dir: PathBuf,
    pub candidate: String,
    pub expected_head_sha: Option<String>,
    pub expected_tree_sha: Option<String>,
    /// The exact argv supplied to the builder.  The CLI passes its real argv;
    /// library callers may provide a stable invocation string for a manifest.
    pub builder_command: Vec<String>,
    before_manifest_publish_hook: Option<BeforeManifestPublishHook>,
}

impl fmt::Debug for FixtureBuildOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FixtureBuildOptions")
            .field("repo_root", &self.repo_root)
            .field("output_dir", &self.output_dir)
            .field("candidate", &self.candidate)
            .field("expected_head_sha", &self.expected_head_sha)
            .field("expected_tree_sha", &self.expected_tree_sha)
            .field("builder_command", &self.builder_command)
            .field(
                "before_manifest_publish_hook",
                &self.before_manifest_publish_hook.is_some(),
            )
            .finish()
    }
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
            before_manifest_publish_hook: None,
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

    /// Install a deterministic support hook invoked immediately before the
    /// final candidate recheck.  This is intentionally a library-only test
    /// seam; the CLI never installs one.
    pub fn with_before_manifest_publish_hook<F>(mut self, hook: F) -> Self
    where
        F: Fn(&Path) -> Result<()> + Send + Sync + 'static,
    {
        self.before_manifest_publish_hook = Some(Arc::new(hook));
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSnapshot {
    pub project_id: String,
    pub scene_id: String,
    pub application_id: String,
    pub apply_run_id: String,
    pub backfill_run_id: String,
    pub project_count: i64,
    pub scene_count: i64,
    pub e0_count: i64,
    pub completed_backfill_count: i64,
    pub dependency_edge_count: i64,
    pub application_count: i64,
    pub legacy_projection_freshness_count: i64,
    pub legacy_projection_dependency_count: i64,
    pub application_edge_count: i64,
    pub application_edge_state_count: i64,
    pub application_freshness_count: i64,
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
    pub application: Value,
    pub application_digest: String,
    pub legacy_projection: Value,
    pub legacy_projection_digest: String,
    pub edge: Value,
    pub edge_digest: String,
    pub feed_cursor: Value,
    pub feed_cursor_digest: String,
    pub derived_state_gap: Value,
    pub derived_state_gap_digest: String,
    pub semantic_index: Value,
    pub semantic_index_digest: String,
    pub expected_restore_lifecycle: Value,
    pub expected_restore_lifecycle_digest: String,
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
    let application = create_fixture_domain(&db)?;
    settle_change_feed(&db)?;
    let backfill_run_id = create_fixture_backfill(&db)?;
    let edge_id = find_application_edge(&db, &application.application_id)?;
    assert_derived_state_gap(&db, &application.application_id, &edge_id)?;
    let semantic = collect_semantic_snapshot(&db, &edge_id)?;
    anyhow::ensure!(
        semantic.backfill_run_id == backfill_run_id,
        "C2ZC_FIXTURE_BACKFILL_RUN_MISMATCH: writer={} snapshot={}",
        backfill_run_id,
        semantic.backfill_run_id
    );
    anyhow::ensure!(
        semantic.application_id == application.application_id
            && semantic.apply_run_id == application.apply_run_id
            && semantic.application["proposalId"] == Value::String(application.proposal_id.clone())
            && semantic.application["revisionId"] == Value::String(application.revision_id.clone())
            && semantic.application["eventId"] == Value::String(application.event_id.clone()),
        "C2ZC_FIXTURE_APPLICATION_SNAPSHOT_MISMATCH"
    );
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
        options.builder_command.clone()
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
    let recheck_result = (|| -> Result<()> {
        if let Some(hook) = options.before_manifest_publish_hook.as_ref() {
            hook(&candidate.root).context("running pre-publication fixture hook")?;
        }
        let final_candidate = resolve_candidate(&options)
            .map_err(|error| anyhow::anyhow!("C2ZC_FIXTURE_CANDIDATE_RECHECK_FAILED: {error:#}"))?;
        anyhow::ensure!(
            final_candidate.binding == manifest.candidate,
            "C2ZC_FIXTURE_CANDIDATE_CHANGED_BEFORE_MANIFEST: initial={:?} final={:?}",
            manifest.candidate,
            final_candidate.binding
        );
        Ok(())
    })();
    if let Err(error) = recheck_result {
        cleanup_unpublished_artifacts(&[&database_path, &backup_path, &manifest_path])
            .context("cleaning unpublished fixture artifacts after candidate recheck failure")?;
        return Err(error);
    }
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
    let manifest: FixtureManifest =
        serde_json::from_slice(&bytes).context("parsing C2-ZC restore fixture manifest")?;
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
    validate_semantic_payload_digests(&manifest.semantic)?;
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
    verify_artifact(&fixture_path, &manifest.artifacts.fixture, "fixture")?;
    verify_artifact(&database_path, &manifest.artifacts.database, "database")?;
    anyhow::ensure!(
        manifest.artifacts.fixture.sha256 == manifest.fixture_sha256
            && manifest.artifacts.fixture.size_bytes == manifest.fixture_size_bytes,
        "C2ZC_FIXTURE_MANIFEST_ARTIFACT_MISMATCH: top-level fixture digest disagrees with artifact"
    );
    let connection = Connection::open(&fixture_path).context("opening fixture backup")?;
    quick_check_connection(&connection)?;
    let schema_version: i32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
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

#[derive(Debug)]
struct FixtureApplication {
    application_id: String,
    apply_run_id: String,
    proposal_id: String,
    revision_id: String,
    event_id: String,
}

fn create_fixture_domain(db: &Database) -> Result<FixtureApplication> {
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
    db.with_conn(|conn| create_epoch_in_tx(conn, PROJECT_ID, "initial", None))
        .context("creating fixture E0 through the semantic epoch writer")?;
    enable_fixture_manual_apply(db)?;
    create_fixture_application(db)
}

fn enable_fixture_manual_apply(db: &Database) -> Result<()> {
    let before = load_narrative_runtime_policy_from_db(db)
        .context("loading fixture narrative runtime policy")?;
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".to_string(),
            maintenance_enabled: before.maintenance_enabled,
            generic_import_enabled: before.generic_import_enabled,
            background_ai_enabled: before.background_ai_enabled,
        },
    )
    .context("enabling manual Apply through typed runtime policy writer")?;
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

fn create_fixture_application(db: &Database) -> Result<FixtureApplication> {
    let task_id = format!("{OWNER_RUN_ID}-task");
    let task_kind = "c2zc.restore.fixture.application".to_string();
    let set_id = format!("{OWNER_RUN_ID}-proposal-set");
    let proposal_id = format!("{OWNER_RUN_ID}-proposal");
    let event_id = format!("{OWNER_RUN_ID}-event");
    let source_identity =
        canonical_source_object_identity("scene-body", &format!("project:scene:{SCENE_ID}"))?;
    let source_revision = fixture_scene_source_revision(db)?;
    let spec = json!({
        "fixture": "c2zc-restore-verify-rebuild-verify-application",
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
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.clone()),
                task_kind: task_kind.clone(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .context("creating fixture Application source Run through typed writer")?;
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: OWNER_RUN_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_set_id: Some(set_id.clone()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.clone()),
                proposal_key: "c2zc-restore-fixture-application".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: fixture_event_payload(&event_id),
                reconciliation_envelope: Some(fixture_reconciliation_envelope(
                    &source_identity,
                    &source_revision,
                    OWNER_RUN_ID,
                    &task_id,
                )),
            }],
        },
    )
    .context("saving fixture Application ProposalSet through typed writer")?;
    let saved_proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("fixture proposal response omitted proposalId"))?
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("fixture proposal response omitted revisionId"))?
        .to_string();
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: OWNER_RUN_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_id: saved_proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("c2zc-restore-fixture".to_string()),
        },
    )
    .context("approving fixture Application Proposal through typed writer")?;
    let expected_tail_ordinal = current_event_tail_ordinal(db)?;
    let request_id = format!("{OWNER_RUN_ID}-prepare");
    let session_id = format!("{OWNER_RUN_ID}-session");
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: PROJECT_ID.to_string(),
            run_id: OWNER_RUN_ID.to_string(),
            proposal_set_id: set_id,
            request_id: request_id.clone(),
            plan_digest: "c2zc-restore-fixture-plan".to_string(),
            session_id: session_id.clone(),
            surface: Some("narrative-extraction".to_string()),
            operations: vec![CommitOperation {
                kind: "chronicle.event.create".to_string(),
                payload: fixture_event_payload(&event_id),
                proposal_id: saved_proposal_id.clone(),
                revision_id: revision_id.clone(),
            }],
            applications: vec![CommitApplicationRef {
                proposal_id: saved_proposal_id.clone(),
                revision_id: revision_id.clone(),
            }],
            expected_tail_ordinal,
            entity_bindings: Vec::new(),
            expected_calendar_version: None,
        },
    )
    .context("preparing fixture Application commit through typed writer")?;
    let prepared_commit_id = prepared["preparedCommitId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("fixture prepared commit omitted preparedCommitId"))?
        .to_string();
    let applied = narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: PROJECT_ID.to_string(),
            prepared_commit_id,
            request_id,
            session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
    .context("applying fixture Application commit through typed writer")?;
    anyhow::ensure!(
        applied["status"] == Value::String("applied".to_string()),
        "C2ZC_FIXTURE_APPLICATION_APPLY_NOT_APPLIED: {applied}"
    );
    let commit_id = applied["commitId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("fixture Apply response omitted commitId"))?;
    let application_id = db.with_conn(|conn| {
        conn.query_row(
            "SELECT id FROM narrative_proposal_applications WHERE commit_id = ?1",
            [commit_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(Into::into)
    })?;
    let claimed = narrative_extraction_claim_task(
        db,
        ClaimTaskPayload {
            run_id: OWNER_RUN_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            lease_owner: "c2zc-restore-fixture-builder".to_string(),
            lease_duration_secs: Some(300),
            task_kinds: Some(vec![task_kind]),
        },
    )
    .context("claiming fixture Application Task through typed writer")?;
    anyhow::ensure!(
        claimed["claimed"] == Value::Bool(true),
        "C2ZC_FIXTURE_APPLICATION_TASK_NOT_CLAIMED: {claimed}"
    );
    let attempt_id = claimed["task"]["attemptId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("fixture Task claim response omitted attemptId"))?
        .to_string();
    let finished = narrative_extraction_finish_task(
        db,
        FinishTaskPayload {
            run_id: OWNER_RUN_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            task_id,
            attempt_id,
            lease_owner: "c2zc-restore-fixture-builder".to_string(),
            output_json: Some(json!({ "fixture": "application-applied" })),
            artifacts: Vec::new(),
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: Vec::new(),
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .context("finishing fixture Application Task through typed writer")?;
    anyhow::ensure!(
        finished["status"] == Value::String("completed".to_string()),
        "C2ZC_FIXTURE_APPLICATION_TASK_NOT_FINISHED: {finished}"
    );
    assert_fixture_application_run_terminal(db)?;
    Ok(FixtureApplication {
        application_id,
        apply_run_id: OWNER_RUN_ID.to_string(),
        proposal_id: saved_proposal_id,
        revision_id,
        event_id,
    })
}

fn assert_fixture_application_run_terminal(db: &Database) -> Result<()> {
    let (run_status, task_status, attempt_status): (String, String, String) =
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT r.status, t.status, a.status
               FROM narrative_extraction_runs r
               JOIN narrative_extraction_tasks t ON t.run_id = r.id
               JOIN narrative_extraction_attempts a ON a.task_id = t.id
              WHERE r.id = ?1 AND r.project_id = ?2
              ORDER BY a.attempt_number DESC
              LIMIT 1",
                params![OWNER_RUN_ID, PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })?;
    anyhow::ensure!(
        run_status == "completed" && task_status == "completed" && attempt_status == "completed",
        "C2ZC_FIXTURE_APPLICATION_RUN_NOT_TERMINAL: run={run_status}, task={task_status}, attempt={attempt_status}"
    );
    Ok(())
}

fn fixture_event_payload(event_id: &str) -> Value {
    json!({
        "eventId": event_id,
        "title": "C2-ZC offline restore application event",
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": SCENE_ID,
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none"
    })
}

fn fixture_reconciliation_envelope(
    source_identity: &str,
    revision_token: &str,
    run_id: &str,
    task_id: &str,
) -> Value {
    let read_set = json!([{
        "inputRef": source_identity,
        "kind": "snapshot-document",
        "sourceKind": "scene-body",
        "revisionToken": revision_token,
    }]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "c2zc.restore.fixture",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "chronicle.event",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "scene-body",
            "sourceKey": source_identity,
            "revisionToken": revision_token,
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn fixture_scene_source_revision(db: &Database) -> Result<String> {
    db.with_conn(|conn| {
        let (version, updated_at): (i64, String) = conn.query_row(
            "SELECT version, updated_at FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
            params![SCENE_ID, PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(format!("v{version}@{updated_at}"))
    })
}

fn current_event_tail_ordinal(db: &Database) -> Result<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT ordinal
                   FROM events
                  WHERE project_id = ?1
                  ORDER BY ordinal DESC, id DESC
                  LIMIT 1",
                [PROJECT_ID],
                |row| row.get(0),
            )
            .optional()?)
    })
}

fn create_fixture_backfill(db: &Database) -> Result<String> {
    let outcome = bootstrap_legacy_dependency_backfill_for_project(db, PROJECT_ID)
        .context("creating completed historical Backfill boundary")?;
    match outcome {
        LegacyBackfillBootstrapOutcome::Ran { run_id, summary } => {
            anyhow::ensure!(
                summary.edges_created == 1 && summary.applications_without_run_id == 0,
                "C2ZC_FIXTURE_BACKFILL_APPLICATION_EDGE_INVALID: {:?}",
                summary
            );
            Ok(run_id)
        }
        LegacyBackfillBootstrapOutcome::AlreadyRun { run_id } => {
            anyhow::bail!("C2ZC_FIXTURE_BACKFILL_ALREADY_EXISTS: {run_id}")
        }
    }
}

/// Assert the rebuildable derived-state gap created by the canonical writer
/// ordering. The Feed/Cursor is settled before the Backfill declares the
/// Application Edge, so the production Edge writer leaves both Generic
/// derived tables absent. Keeping this helper read-only is important: fixture
/// construction must not bypass a product writer with ad-hoc domain DML.
fn find_application_edge(db: &Database, application_id: &str) -> Result<String> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT id FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = 'application' AND consumer_key = ?2
              ORDER BY id",
            params![PROJECT_ID, application_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
}

fn assert_derived_state_gap(db: &Database, application_id: &str, edge_id: &str) -> Result<()> {
    db.with_conn(|conn| {
        let edge_state_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edge_states
              WHERE project_id = ?1 AND edge_id = ?2",
            params![PROJECT_ID, edge_id],
            |row| row.get(0),
        )?;
        let application_freshness_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = ?1
                AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, application_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            edge_state_count == 0 && application_freshness_count == 0,
            "C2ZC_FIXTURE_DERIVED_STATE_ALREADY_PRESENT: edgeState={} applicationFreshness={}",
            edge_state_count,
            application_freshness_count
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
    let project_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
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
    let application_id = edge["consumerKey"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_APPLICATION_EDGE_KEY_MISSING"))?
        .to_string();
    let application = load_application_snapshot(conn, &application_id)?;
    let apply_run_id = application["runId"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_APPLICATION_RUN_ID_MISSING"))?
        .to_string();
    let backfill_run_id = backfill["rows"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["id"].as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_BACKFILL_RUN_ID_MISSING"))?
        .to_string();
    let legacy_projection = load_legacy_projection_snapshot(conn, &application_id)?;
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
    let application_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_applications a
          JOIN narrative_apply_commits c ON c.id = a.commit_id
         WHERE c.project_id = ?1",
        params![PROJECT_ID],
        |row| row.get(0),
    )?;
    let legacy_projection_freshness_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_projection_freshness f
          JOIN narrative_proposal_applications a ON a.id = f.application_id
          JOIN narrative_apply_commits c ON c.id = a.commit_id
         WHERE c.project_id = ?1 AND f.application_id = ?2",
        params![PROJECT_ID, application_id],
        |row| row.get(0),
    )?;
    let legacy_projection_dependency_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_projection_dependencies d
          JOIN narrative_proposal_applications a ON a.id = d.application_id
          JOIN narrative_apply_commits c ON c.id = a.commit_id
         WHERE c.project_id = ?1 AND d.application_id = ?2",
        params![PROJECT_ID, application_id],
        |row| row.get(0),
    )?;
    let application_edge_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = 'application'
            AND consumer_key = ?2",
        params![PROJECT_ID, application_id],
        |row| row.get(0),
    )?;
    let application_edge_state_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edge_states
          WHERE project_id = ?1 AND edge_id = ?2",
        params![PROJECT_ID, edge_id],
        |row| row.get(0),
    )?;
    let application_freshness_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = 'application' AND consumer_key = ?2",
        params![PROJECT_ID, application_id],
        |row| row.get(0),
    )?;

    let (feed_cursor, cursor_settled) = load_feed_cursor_snapshot(conn)?;
    let (semantic_index, semantic_index_rows) = load_semantic_index_snapshot(conn)?;
    let derived_state_gap = json!({
        "applicationEdgeStateRows": application_edge_state_count,
        "applicationFreshnessRows": application_freshness_count,
        "genericApplicationRows": application_freshness_count,
        "rebuildScope": "narrative_dependency_edge_states+narrative_consumer_freshness",
    });
    let expected_restore_lifecycle = json!({
        "firstVerify": "rebuild-required",
        "conditionalRebuild": "required",
        "confirmationVerify": "clean",
        "marker": "after-confirmation-verify",
    });
    let epoch_digest = digest_json(&epoch);
    let backfill_digest = digest_json(&backfill);
    let application_digest = digest_json(&application);
    let legacy_projection_digest = digest_json(&legacy_projection);
    let edge_digest = digest_json(&edge);
    let feed_cursor_digest = digest_json(&feed_cursor);
    let derived_state_gap_digest = digest_json(&derived_state_gap);
    let semantic_index_digest = digest_json(&semantic_index);
    let expected_restore_lifecycle_digest = digest_json(&expected_restore_lifecycle);
    let mut semantic = SemanticSnapshot {
        project_id: PROJECT_ID.to_string(),
        scene_id: SCENE_ID.to_string(),
        application_id,
        apply_run_id,
        backfill_run_id,
        project_count,
        scene_count,
        e0_count,
        completed_backfill_count,
        dependency_edge_count: edge_count,
        application_count,
        legacy_projection_freshness_count,
        legacy_projection_dependency_count,
        application_edge_count,
        application_edge_state_count,
        application_freshness_count,
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
        application,
        application_digest,
        legacy_projection,
        legacy_projection_digest,
        edge,
        edge_digest,
        feed_cursor,
        feed_cursor_digest,
        derived_state_gap,
        derived_state_gap_digest,
        semantic_index,
        semantic_index_digest,
        expected_restore_lifecycle,
        expected_restore_lifecycle_digest,
        contents_digest: String::new(),
    };
    semantic.contents_digest = digest_json(&semantic_contents_payload(&semantic));
    Ok(semantic)
}

fn load_application_snapshot(conn: &Connection, application_id: &str) -> Result<Value> {
    let (
        id,
        commit_id,
        project_id,
        run_id,
        run_status,
        proposal_set_id,
        request_id,
        plan_digest,
        commit_status,
        session_id,
        commit_created_at,
        completed_at,
        commit_version,
        proposal_id,
        revision_id,
        applied_entity_kind,
        applied_entity_id,
        created_at,
        application_kind,
        compensates_application_id,
    ): ApplicationSnapshotRow = conn.query_row(
        "SELECT a.id, a.commit_id, c.project_id, c.run_id, r.status, c.proposal_set_id,
                c.request_id, c.plan_digest, c.status, c.session_id, c.created_at,
                c.completed_at, c.version, a.proposal_id, a.revision_id,
                a.applied_entity_kind, a.applied_entity_id, a.created_at,
                a.application_kind, a.compensates_application_id
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id = a.commit_id
           LEFT JOIN narrative_extraction_runs r
             ON r.id = c.run_id AND r.project_id = c.project_id
          WHERE a.id = ?1 AND c.project_id = ?2",
        params![application_id, PROJECT_ID],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                row.get(16)?,
                row.get(17)?,
                row.get(18)?,
                row.get(19)?,
            ))
        },
    )?;
    let event_id = if applied_entity_kind == "event" {
        Value::String(applied_entity_id.clone())
    } else {
        Value::Null
    };
    Ok(json!({
        "id": id,
        "commitId": commit_id,
        "projectId": project_id,
        "runId": run_id,
        "runStatus": run_status,
        "proposalSetId": proposal_set_id,
        "requestId": request_id,
        "planDigest": plan_digest,
        "commitStatus": commit_status,
        "sessionId": session_id,
        "commitCreatedAt": commit_created_at,
        "completedAt": completed_at,
        "commitVersion": commit_version,
        "proposalId": proposal_id,
        "revisionId": revision_id,
        "appliedEntityKind": applied_entity_kind,
        "appliedEntityId": applied_entity_id,
        "eventId": event_id,
        "createdAt": created_at,
        "applicationKind": application_kind,
        "compensatesApplicationId": compensates_application_id,
    }))
}

fn load_legacy_projection_snapshot(conn: &Connection, application_id: &str) -> Result<Value> {
    let (freshness_status, freshness_reason, freshness_version, freshness_updated_at): (
        String,
        Option<String>,
        i64,
        String,
    ) = conn.query_row(
        "SELECT status, reason_json, version, updated_at
           FROM narrative_projection_freshness
          WHERE application_id = ?1",
        [application_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let freshness_reason = freshness_reason
        .map(|raw| serde_json::from_str::<Value>(&raw))
        .transpose()
        .context("decoding legacy projection freshness reason")?
        .unwrap_or(Value::Null);
    let dependencies = query_json_rows(
        conn,
        "SELECT source_kind, source_key, observed_revision_token, propagation
           FROM narrative_projection_dependencies
          WHERE application_id = ?1
          ORDER BY source_kind, source_key",
        [application_id],
        |row| {
            Ok(json!({
                "sourceKind": row.get::<_, String>(0)?,
                "sourceKey": row.get::<_, String>(1)?,
                "observedRevisionToken": row.get::<_, String>(2)?,
                "propagation": row.get::<_, String>(3)?,
            }))
        },
    )?;
    Ok(json!({
        "freshness": {
            "applicationId": application_id,
            "status": freshness_status,
            "reasonJson": freshness_reason,
            "version": freshness_version,
            "updatedAt": freshness_updated_at,
        },
        "dependencies": dependencies,
    }))
}

fn semantic_contents_payload(semantic: &SemanticSnapshot) -> Value {
    json!({
        "projectId": &semantic.project_id,
        "sceneId": &semantic.scene_id,
        "applicationId": &semantic.application_id,
        "applyRunId": &semantic.apply_run_id,
        "backfillRunId": &semantic.backfill_run_id,
        "projectCount": semantic.project_count,
        "sceneCount": semantic.scene_count,
        "e0Count": semantic.e0_count,
        "completedBackfillCount": semantic.completed_backfill_count,
        "dependencyEdgeCount": semantic.dependency_edge_count,
        "applicationCount": semantic.application_count,
        "legacyProjectionFreshnessCount": semantic.legacy_projection_freshness_count,
        "legacyProjectionDependencyCount": semantic.legacy_projection_dependency_count,
        "applicationEdgeCount": semantic.application_edge_count,
        "applicationEdgeStateCount": semantic.application_edge_state_count,
        "applicationFreshnessCount": semantic.application_freshness_count,
        "cursorSettled": semantic.cursor_settled,
        "semanticIndexRows": semantic.semantic_index_rows,
        "sceneSourceRevision": &semantic.scene_source_revision,
        "edgeSourceObjectIdentity": &semantic.edge_source_object_identity,
        "edgeReadSetJson": &semantic.edge_read_set_json,
        "project": &semantic.project,
        "scene": &semantic.scene,
        "epoch": &semantic.epoch,
        "backfill": &semantic.backfill,
        "application": &semantic.application,
        "legacyProjection": &semantic.legacy_projection,
        "edge": &semantic.edge,
        "feedCursor": &semantic.feed_cursor,
        "derivedStateGap": &semantic.derived_state_gap,
        "semanticIndex": &semantic.semantic_index,
        "expectedRestoreLifecycle": &semantic.expected_restore_lifecycle,
    })
}

fn validate_semantic_payload_digests(semantic: &SemanticSnapshot) -> Result<()> {
    let checks = [
        (
            "project",
            semantic.project_digest.as_str(),
            digest_json(&semantic.project),
        ),
        (
            "scene",
            semantic.scene_digest.as_str(),
            digest_json(&semantic.scene),
        ),
        (
            "epoch",
            semantic.epoch_digest.as_str(),
            digest_json(&semantic.epoch),
        ),
        (
            "backfill",
            semantic.backfill_digest.as_str(),
            digest_json(&semantic.backfill),
        ),
        (
            "application",
            semantic.application_digest.as_str(),
            digest_json(&semantic.application),
        ),
        (
            "legacyProjection",
            semantic.legacy_projection_digest.as_str(),
            digest_json(&semantic.legacy_projection),
        ),
        (
            "edge",
            semantic.edge_digest.as_str(),
            digest_json(&semantic.edge),
        ),
        (
            "feedCursor",
            semantic.feed_cursor_digest.as_str(),
            digest_json(&semantic.feed_cursor),
        ),
        (
            "derivedStateGap",
            semantic.derived_state_gap_digest.as_str(),
            digest_json(&semantic.derived_state_gap),
        ),
        (
            "semanticIndex",
            semantic.semantic_index_digest.as_str(),
            digest_json(&semantic.semantic_index),
        ),
        (
            "expectedRestoreLifecycle",
            semantic.expected_restore_lifecycle_digest.as_str(),
            digest_json(&semantic.expected_restore_lifecycle),
        ),
        (
            "contents",
            semantic.contents_digest.as_str(),
            digest_json(&semantic_contents_payload(semantic)),
        ),
    ];
    for (label, actual, expected) in checks {
        anyhow::ensure!(
            actual == expected,
            "C2ZC_FIXTURE_SEMANTIC_DIGEST_{label}: manifest payload digest mismatch: expected={} actual={}",
            expected,
            actual
        );
    }
    Ok(())
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
        semantic.backfill["rows"]
            .as_array()
            .is_some_and(|rows| rows.len() == 1),
        "C2ZC_FIXTURE_BACKFILL_BOUNDARY_INVALID"
    );
    let backfill_row = semantic.backfill["rows"]
        .as_array()
        .and_then(|rows| rows.first())
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_BACKFILL_BOUNDARY_MISSING"))?;
    let e0_id = semantic.epoch["rows"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["id"].as_str())
        .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_E0_ID_MISSING"))?;
    anyhow::ensure!(
        backfill_row["projectId"] == Value::String(PROJECT_ID.to_string())
            && backfill_row["runKind"] == Value::String("backfill".to_string())
            && backfill_row["workKey"] == Value::String(LEGACY_BACKFILL_WORK_KEY.to_string())
            && backfill_row["status"] == Value::String("completed".to_string())
            && backfill_row["semanticEpochId"] == Value::String(e0_id.to_string()),
        "C2ZC_FIXTURE_BACKFILL_PROVENANCE_INVALID"
    );
    let backfill_spec: Value = serde_json::from_str(
        backfill_row["specJson"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_BACKFILL_SPEC_MISSING"))?,
    )
    .context("C2ZC_FIXTURE_BACKFILL_SPEC_INVALID")?;
    anyhow::ensure!(
        backfill_spec["backfillAlgorithmVersion"]
            == Value::String(LEGACY_BACKFILL_ALGORITHM_VERSION.to_string())
            && backfill_row["specDigest"]
                == Value::String(format!("sha256:{}", digest_plan(&backfill_spec))),
        "C2ZC_FIXTURE_BACKFILL_SPEC_BINDING_INVALID"
    );
    let backfill_outcome: Value = serde_json::from_str(
        backfill_row["outcomeSummaryJson"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("C2ZC_FIXTURE_BACKFILL_OUTCOME_MISSING"))?,
    )
    .context("C2ZC_FIXTURE_BACKFILL_OUTCOME_INVALID")?;
    anyhow::ensure!(
        backfill_outcome["maintenancePhase"] == Value::String("backfill-complete".to_string())
            && backfill_outcome["backfillAlgorithmVersion"]
                == Value::String(LEGACY_BACKFILL_ALGORITHM_VERSION.to_string())
            && backfill_outcome["semanticEpochId"] == Value::String(e0_id.to_string())
            && backfill_outcome["summary"]["epoch_created"] == Value::Bool(false)
            && backfill_outcome["summary"]["contributions_created"] == Value::Number(1.into())
            && backfill_outcome["summary"]["edges_created"] == Value::Number(1.into())
            && backfill_outcome["summary"]["applications_without_run_id"]
                == Value::Number(0.into()),
        "C2ZC_FIXTURE_BACKFILL_OUTCOME_INVALID"
    );
    anyhow::ensure!(
        semantic.application_count == 1,
        "C2ZC_FIXTURE_APPLICATION_COUNT_INVALID: {}",
        semantic.application_count
    );
    anyhow::ensure!(
        semantic.legacy_projection_freshness_count == 1
            && semantic.legacy_projection_dependency_count == 1,
        "C2ZC_FIXTURE_LEGACY_PROJECTION_INVALID: freshness={} dependencies={}",
        semantic.legacy_projection_freshness_count,
        semantic.legacy_projection_dependency_count
    );
    anyhow::ensure!(
        semantic.application_edge_count == 1,
        "C2ZC_FIXTURE_APPLICATION_EDGE_INVALID: {}",
        semantic.application_edge_count
    );
    anyhow::ensure!(
        semantic.application_edge_state_count == 0 && semantic.application_freshness_count == 0,
        "C2ZC_FIXTURE_DERIVED_GAP_INVALID: edgeState={} applicationFreshness={}",
        semantic.application_edge_state_count,
        semantic.application_freshness_count
    );
    anyhow::ensure!(semantic.cursor_settled, "C2ZC_FIXTURE_CURSOR_UNSETTLED");
    anyhow::ensure!(
        semantic.semantic_index_rows == 0,
        "C2ZC_FIXTURE_SEMANTIC_INDEX_PRESENT: {}",
        semantic.semantic_index_rows
    );
    anyhow::ensure!(
        !semantic.application_id.is_empty()
            && semantic.application["id"] == Value::String(semantic.application_id.clone())
            && semantic.application["projectId"] == Value::String(PROJECT_ID.to_string())
            && semantic.application["runId"] == Value::String(semantic.apply_run_id.clone())
            && semantic.application["runStatus"] == Value::String("completed".to_string())
            && semantic.application["commitStatus"] == Value::String("applied".to_string())
            && semantic.application["applicationKind"] == Value::String("normal".to_string())
            && semantic.application["compensatesApplicationId"] == Value::Null
            && semantic.application["proposalId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            && semantic.application["revisionId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            && semantic.application["appliedEntityId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            && semantic.application["completedAt"]
                .as_str()
                .is_some_and(|at| !at.is_empty())
            && semantic.application["eventId"] == semantic.application["appliedEntityId"],
        "C2ZC_FIXTURE_APPLICATION_PROVENANCE_INVALID"
    );
    anyhow::ensure!(
        semantic.edge["consumerKind"] == Value::String("application".to_string())
            && semantic.edge["consumerKey"] == Value::String(semantic.application_id.clone())
            && semantic.edge["owningRunId"] == Value::String(semantic.backfill_run_id.clone())
            && semantic.edge["generatedByTransactionId"] == Value::Null,
        "C2ZC_FIXTURE_EDGE_OWNER_INVALID"
    );
    anyhow::ensure!(
        semantic.legacy_projection["freshness"]["applicationId"]
            == Value::String(semantic.application_id.clone())
            && semantic.legacy_projection["freshness"]["status"]
                == Value::String("fresh".to_string())
            && semantic.legacy_projection["freshness"]["reasonJson"] == Value::Null
            && semantic.legacy_projection["freshness"]["version"] == Value::Number(0.into()),
        "C2ZC_FIXTURE_LEGACY_FRESHNESS_INVALID"
    );
    anyhow::ensure!(
        semantic.legacy_projection["dependencies"]
            .as_array()
            .is_some_and(|rows| {
                rows.len() == 1
                    && rows[0]["sourceKind"] == Value::String("scene-body".to_string())
                    && rows[0]["sourceKey"] == Value::String(format!("project:scene:{SCENE_ID}"))
                    && rows[0]["observedRevisionToken"]
                        == Value::String(semantic.scene_source_revision.clone())
                    && rows[0]["propagation"] == Value::String("freshness-only".to_string())
            }),
        "C2ZC_FIXTURE_LEGACY_DEPENDENCY_INVALID"
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
    validate_semantic_payload_digests(semantic)?;
    let connection = Connection::open(path).context("opening generated fixture backup")?;
    quick_check_connection(&connection)?;
    let schema_version: i32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    anyhow::ensure!(
        schema_version == grimodex_core::SCHEMA_VERSION,
        "C2ZC_FIXTURE_SCHEMA_VERSION_MISMATCH: expected={} actual={}",
        grimodex_core::SCHEMA_VERSION,
        schema_version
    );
    let edge_id = connection.query_row(
        "SELECT id FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = 'application' AND consumer_key = ?2",
        params![PROJECT_ID, semantic.application_id],
        |row| row.get::<_, String>(0),
    )?;
    let copied = collect_semantic_snapshot_from_connection(&connection, &edge_id)?;
    anyhow::ensure!(
        copied == *semantic,
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
            fs::remove_file(&sidecar).with_context(|| {
                format!("removing generated SQLite sidecar '{}'", sidecar.display())
            })?;
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
    validate_semantic_payload_digests(expected)?;
    let edge_id: String = conn.query_row(
        "SELECT id FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = 'application' AND consumer_key = ?2",
        params![expected.project_id, expected.application_id],
        |row| row.get(0),
    )?;
    let actual = collect_semantic_snapshot_from_connection(conn, &edge_id)?;
    validate_fixture_semantics(&actual)?;
    anyhow::ensure!(
        actual == *expected,
        "C2ZC_FIXTURE_SEMANTIC_DIGEST_MISMATCH: manifest semantics differ from restored database"
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
    let Some((
        consumer_id,
        acknowledged,
        lease_owner,
        lease_expires_at,
        last_error,
        updated_at,
        project_id,
    )) = row
    else {
        return Ok((
            json!({ "feedHead": feed_head, "cursor": Value::Null }),
            false,
        ));
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
    let mut file =
        File::open(path).with_context(|| format!("opening artifact '{}'`", path.display()))?;
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
    let status = git_command(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
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
    let output = git_command(
        root,
        &["rev-parse", "--verify", "--end-of-options", revision],
    )?;
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
        fs::create_dir_all(output)
            .with_context(|| format!("creating fixture output directory '{}'", output.display()))?;
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

fn cleanup_unpublished_artifacts(paths: &[&Path]) -> Result<()> {
    for path in paths {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            metadata.file_type().is_file(),
            "C2ZC_FIXTURE_CLEANUP_TARGET_NOT_REGULAR: {}",
            path.display()
        );
        reject_symlink_components(path)?;
        fs::remove_file(path).with_context(|| {
            format!("removing unpublished fixture artifact '{}'", path.display())
        })?;
    }
    Ok(())
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
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
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
