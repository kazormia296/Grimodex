//! SQL persistence for narrative extraction runs, tasks, and proposals.

use anyhow::Context;
use chrono::{DateTime, Utc};
use grimodex_core::{
    canonical_json_digest,
    narrative_ir::{
        validate_chronicle_scene_event_proposal_payload, CHRONICLE_EVENT_PROPOSAL_KIND,
    },
    narrative_scope_authority_basis::{
        build_narrative_scope_authority_basis_v2, NarrativeScopeAuthorityDocumentInputV2,
    },
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

use super::c2zc_canonical_cutover::current_c2zc_run_epoch_in_tx;
use super::declaration_storage::{
    write_dependency_declaration_set_in_tx, DependencyDeclarationSetRequest,
};
use super::dependency_edges::{
    canonical_source_object_identity, find_edges_by_consumer, record_dependency_edge_in_tx,
    validate_run_id, PROPOSAL_REVISION_CONSUMER_KIND,
};
use super::execution_state::{next_run_lifecycle_timestamp_in_tx, parse_run_lifecycle_instant};
use super::human_material_basis::{project_d1_declaration_set, D1ParentAuthority, MaterialBasis};
use super::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_DECISION_LOCKED, NIR1_ENTITY_RELATION_PROPOSAL_KIND,
    NIR1_ENTITY_RELATION_REVISION_ORIGIN, NIR1_ENTITY_RELATION_SET_KIND,
};
use super::nir1_entity_relation_index::GraphWorkControl;
use super::publish_runtime::publish_complete_runless_freshness_in_tx;
use super::restore_rebuild::evaluate_edge_from_db;
use super::semantic_epoch::get_current_epoch;
use super::source_revision::validation_context;

/// Generation of the current Proposal Revision dependency declaration writer.
/// This is paired with the bundled producer registry; bump both when the
/// writer's declaration semantics change.
pub(crate) const PROPOSAL_REVISION_DEPENDENCY_GENERATION: &str = "proposal-revision-dependency/v1";

/// Numeric producer generation reserved for a Proposal Revision's D1 sealed
/// Declaration Set. This is intentionally separate from the V1 string
/// generation above; C2B must not derive it by parsing or copying that value.
pub const PROPOSAL_REVISION_D1_PRODUCER_GENERATION: i64 = 1;
use super::field_authority::{derive_decision_authority, TrustedDecisionActor};
use super::models::{
    default_object_json, AppendDecisionPayload, AppendRevisionPayload, ArtifactInput,
    ChronicleBlockedDiscardExpectation, ChroniclePlanProposalSetFinish, ChronicleStageId,
    CreateRunPayload, CreateTaskSeed, FailTaskPayload, FinishTaskPayload,
    IsRunResumableForReviewPayload, IsRunResumableForReviewResult,
    ListChronicleTaskResumeCandidatesPayload, ListResumableRunsPayload, ProposalSeed,
    ReviseAndDecidePayload, SaveProposalSetPayload,
};
use super::reconciliation_envelope::{
    ensure_v2_proposal_payload_digest, envelope_schema_version,
    validate_envelope_source_tokens_with_validation_context, validate_reconciliation_envelope,
    SourceBasisRow, ORIGIN_ENVELOPED, ORIGIN_LEGACY_UNBOUND,
};
use super::task_leases::{
    claim_next_task, claimed_task_to_value, load_task_row, persist_task_artifacts,
    verify_task_lease, with_immediate_transaction,
};
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

const CHRONICLE_EXTRACT_SURFACE_PATH: &str = "chronicle.extract";
const RUN_CANCELLED_ATTEMPT_ERROR_MESSAGE: &str = "NEX_RUN_CANCELLED: Run cancelled";
const RUN_CANCELLED_ATTEMPT_FAILURE_CODE: &str = "NEX_RUN_CANCELLED";
const RUN_CANCELLED_ATTEMPT_POLICY_VERSION: &str = "v1";
const CHRONICLE_RUN_SPEC_KIND: &str = "chronicle.extract.run-spec@2";
const CHRONICLE_EXISTING_EVENTS_CATALOG_KIND: &str = "chronicle.existing-events-catalog@1";

#[derive(Default)]
struct ProjectLifecycleAdmission {
    destructive: bool,
    creation_reservations: usize,
}

/// One process-local admission table for both sides of the project lifecycle
/// race.  A single mutex makes "reserve a Run" and "reserve destructive
/// delete" mutually visible; two independent maps could otherwise both
/// observe the project as idle and cross the same boundary.
static PROJECT_LIFECYCLE_ADMISSIONS: OnceLock<
    Mutex<HashMap<String, ProjectLifecycleAdmission>>,
> = OnceLock::new();

fn project_lifecycle_key(namespace: &str, project_id: &str) -> String {
    format!("{namespace}\u{0}{project_id}")
}

/// Stable namespace for a verified Database authority. The canonical path is
/// retained for diagnostics, while the file identity distinguishes a
/// same-path replacement. Reopening the same DB keeps both values stable;
/// copying/replacing it produces a different key.
pub fn project_lifecycle_namespace_for_database(
    db: &Database,
) -> anyhow::Result<String> {
    db.with_conn(|conn| {
        let path: String = conn.query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get(0),
        )?;
        if path.trim().is_empty() {
            return Ok("memory".to_owned());
        }
        let canonical = std::fs::canonicalize(&path)
            .unwrap_or_else(|_| Path::new(&path).to_path_buf())
            .to_string_lossy()
            .into_owned();
        let identity = super::maintenance_lifecycle::sqlite_database_file_identity(
            Path::new(&canonical),
        )?;
        Ok(format!("{canonical}#{identity}"))
    })
}

fn project_lifecycle_admissions(
) -> &'static Mutex<HashMap<String, ProjectLifecycleAdmission>> {
    PROJECT_LIFECYCLE_ADMISSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Process-local guard for destructive project writers.  It coordinates the
/// lifecycle owner and the project delete path in this process only; it is
/// deliberately not advertised as cross-process SQLite authority.
#[allow(dead_code)]
pub(crate) fn try_reserve_project_destructive_permit(project_id: &str) -> anyhow::Result<()> {
    try_reserve_project_destructive_permit_in_namespace("legacy", project_id)
}

pub(crate) fn try_reserve_project_destructive_permit_in_namespace(
    namespace: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let admissions = project_lifecycle_admissions();
    let mut admissions = admissions
        .lock()
        .map_err(|error| anyhow::anyhow!("project lifecycle admissions poisoned: {error}"))?;
    let key = project_lifecycle_key(namespace, project_id);
    let admission = admissions.entry(key).or_default();
    anyhow::ensure!(
        !admission.destructive && admission.creation_reservations == 0,
        "NEX_PROJECT_DESTRUCTIVE_BUSY: project '{project_id}' has lifecycle ownership"
    );
    admission.destructive = true;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn release_project_destructive_permit(project_id: &str) {
    release_project_destructive_permit_in_namespace("legacy", project_id);
}

pub(crate) fn release_project_destructive_permit_in_namespace(
    namespace: &str,
    project_id: &str,
) {
    if let Ok(mut admissions) = project_lifecycle_admissions().lock() {
        let key = project_lifecycle_key(namespace, project_id);
        if let Some(admission) = admissions.get_mut(&key) {
            admission.destructive = false;
            if admission.creation_reservations == 0 {
                admissions.remove(&key);
            }
        }
    }
}

pub(crate) fn project_destructive_permit_active(project_id: &str) -> bool {
    project_destructive_permit_active_in_namespace("legacy", project_id)
}

#[allow(dead_code)]
pub(crate) fn project_destructive_permit_active_for_database(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<bool> {
    let namespace = project_lifecycle_namespace_for_database(db)?;
    Ok(project_destructive_permit_active_in_namespace(
        &namespace,
        project_id,
    ))
}

fn project_destructive_permit_active_in_namespace(namespace: &str, project_id: &str) -> bool {
    project_lifecycle_admissions()
        .lock()
        .ok()
        .and_then(|admissions| {
            admissions
                .get(&project_lifecycle_key(namespace, project_id))
                .map(|entry| entry.destructive)
        })
        .unwrap_or(false)
}

/// Process-local reservation count for maintenance Run creation. Destructive
/// project writers consult this alongside the destructive permit so a project
/// cannot be deleted between the lifecycle reservation and its first Run
/// INSERT. This is coordination only; durable Run/lineage evidence remains
/// mandatory for recovery and the registry is not a cross-process authority.
pub fn try_reserve_project_creation(project_id: &str) -> anyhow::Result<()> {
    try_reserve_project_creation_in_namespace_impl("legacy", project_id)
}

pub fn try_reserve_project_creation_for_database(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<()> {
    let namespace = project_lifecycle_namespace_for_database(db)?;
    try_reserve_project_creation_in_namespace_impl(&namespace, project_id)
}

/// Reserve a Run creation slot when the caller already owns the database
/// connection (for example from inside its creation transaction). Resolving
/// the namespace through `db.with_conn` at that point would try to lock the
/// same SQLite mutex recursively and turn a valid foreground-priority path
/// into a synthetic maintenance preemption. The namespace must have been
/// captured from the verified authority before the transaction began.
pub fn try_reserve_project_creation_in_namespace(
    namespace: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    try_reserve_project_creation_in_namespace_impl(namespace, project_id)
}

fn try_reserve_project_creation_in_namespace_impl(
    namespace: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !project_id.trim().is_empty(),
        "NEX_PROJECT_CREATION_RESERVATION_INVALID: project id is empty"
    );
    let admissions = project_lifecycle_admissions();
    let mut admissions = admissions
        .lock()
        .map_err(|error| anyhow::anyhow!("project lifecycle admissions poisoned: {error}"))?;
    let key = project_lifecycle_key(namespace, project_id);
    let admission = admissions.entry(key).or_default();
    anyhow::ensure!(
        !admission.destructive,
        "NEX_PROJECT_DESTRUCTIVE_BUSY: project '{project_id}' is under a destructive permit"
    );
    admission.creation_reservations += 1;
    Ok(())
}

pub fn release_project_creation(project_id: &str) {
    release_project_creation_in_namespace("legacy", project_id);
}

pub fn release_project_creation_for_handle(
    project_id: &str,
    database_path: Option<&str>,
    database_file_identity: Option<&str>,
) {
    let namespace = match (database_path, database_file_identity) {
        (Some(":memory:"), Some(":memory:")) => "memory".to_owned(),
        (Some(path), Some(identity)) if !path.trim().is_empty() && !identity.trim().is_empty() => {
            let canonical = std::fs::canonicalize(path)
                .unwrap_or_else(|_| Path::new(path).to_path_buf())
                .to_string_lossy()
                .into_owned();
            format!("{}#{}", canonical, identity)
        }
        _ => "legacy".to_owned(),
    };
    release_project_creation_in_namespace(&namespace, project_id);
}

fn release_project_creation_in_namespace(namespace: &str, project_id: &str) {
    if let Ok(mut admissions) = project_lifecycle_admissions().lock() {
        let key = project_lifecycle_key(namespace, project_id);
        let Some(admission) = admissions.get_mut(&key) else {
            return;
        };
        if admission.creation_reservations == 0 {
            return;
        }
        admission.creation_reservations -= 1;
        if admission.creation_reservations == 0 && !admission.destructive {
            admissions.remove(&key);
        }
    }
}

#[allow(dead_code)]
pub(crate) fn project_creation_reservation_active(project_id: &str) -> bool {
    project_creation_reservation_active_in_namespace("legacy", project_id)
}

pub(crate) fn project_creation_reservation_active_for_database(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<bool> {
    let namespace = project_lifecycle_namespace_for_database(db)?;
    Ok(project_creation_reservation_active_in_namespace(
        &namespace,
        project_id,
    ))
}

fn project_creation_reservation_active_in_namespace(namespace: &str, project_id: &str) -> bool {
    project_lifecycle_admissions()
        .lock()
        .ok()
        .and_then(|admissions| {
            admissions
                .get(&project_lifecycle_key(namespace, project_id))
                .map(|entry| entry.creation_reservations > 0)
        })
        .unwrap_or(false)
}
/// Canonical Review-resumability predicate shared by bounded discovery and
/// the exact, limit-free authority query. Keep the Run alias fixed as `r` so
/// both call sites consume the same SQL rather than parallel vocabularies.
pub(crate) const REVIEW_RESUMABLE_RUN_PREDICATE_SQL: &str = r#"
    r.status IN ('pending', 'running', 'completed')
    AND EXISTS (
        SELECT 1
          FROM narrative_proposal_sets ps
          JOIN narrative_proposals p ON p.proposal_set_id = ps.id
         WHERE ps.run_id = r.id
           AND ps.project_id = r.project_id
           AND (
                p.status IN ('unreviewed', 'approved', 'held')
                OR (
                    p.status = 'deferred'
                    AND NOT EXISTS (
                      SELECT 1
                        FROM narrative_proposal_decisions d
                       WHERE d.proposal_id = p.id
                         AND d.revision_id = p.current_revision_id
                         AND json_extract(d.decision_json, '$.reason')
                             = 'already-satisfied'
                    )
                )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM narrative_proposal_applications a
              WHERE a.proposal_id = p.id
           )
    )
"#;
const CHRONICLE_EXTRACT_TASK_CHAIN: [&str; 9] = [
    "source.snapshot@1",
    "source.window-plan@1",
    "chronicle.observe-events@1",
    "evidence.resolve@1",
    "chronicle.merge-local-observations@1",
    "chronicle.cluster-event-observations@1",
    "chronicle.synthesize-event@1",
    "chronicle.match-existing-events@1",
    "chronicle.plan-proposals@1",
];
const CHRONICLE_PLAN_PREDECESSOR_TASK_KINDS: [&str; 8] = [
    "source.snapshot@1",
    "source.window-plan@1",
    "chronicle.observe-events@1",
    "evidence.resolve@1",
    "chronicle.merge-local-observations@1",
    "chronicle.cluster-event-observations@1",
    "chronicle.synthesize-event@1",
    "chronicle.match-existing-events@1",
];
const CHRONICLE_PLAN_TASK_KIND: &str = "chronicle.plan-proposals@1";
const CHRONICLE_PLAN_ARTIFACT_KIND: &str = "chronicle.proposal-plan@1";
const CHRONICLE_RAW_OBSERVATIONS_ARTIFACT_KIND: &str = "chronicle.raw-observations@1";
const CHRONICLE_WINDOW_PLAN_ARTIFACT_KIND: &str = "source.window-plan@1";
const CHRONICLE_EVENT_CLUSTERS_ARTIFACT_KIND: &str = "chronicle.event-clusters@1";
const CHRONICLE_EVENT_HYPOTHESES_ARTIFACT_KIND: &str = "chronicle.event-hypotheses@1";
const CHRONICLE_PROPOSAL_SET_KIND: &str = "chronicle.extract.review@1";
const CHRONICLE_PLAN_BINDING_FIELD: &str = "chroniclePlanTaskBinding";
const CHRONICLE_PLAN_BINDING_KIND: &str = "chronicle.plan-proposal-set-binding@1";
const CHRONICLE_PLAN_MANIFEST_KIND: &str = "chronicle.plan-proposal-set-manifest@1";

pub(crate) fn ensure_proposal_not_applied(
    conn: &Connection,
    proposal_id: &str,
) -> anyhow::Result<()> {
    let applied: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_applications WHERE proposal_id = ?1",
        params![proposal_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        applied == 0,
        "NEX_PROPOSAL_ALREADY_APPLIED: proposal '{proposal_id}'"
    );
    Ok(())
}

/// Reject mutations that could reopen a current Chronicle v2 ProposalSet
/// after its atomic Apply. A rejected Decision is the sole exception and is
/// handled by `append_decision_on_conn`: it lets workspaces produced by older
/// partial-Apply builds terminalize their unapplied remainder instead of
/// leaving a permanently resumable review.
pub(crate) fn ensure_current_chronicle_proposal_set_unconsumed(
    conn: &Connection,
    proposal_id: &str,
) -> anyhow::Result<()> {
    let set_context: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT proposal_set.run_id, proposal_set.project_id,
                    (SELECT COUNT(*)
                       FROM narrative_proposal_applications application
                       JOIN narrative_proposals sibling
                         ON sibling.id = application.proposal_id
                      WHERE sibling.proposal_set_id = proposal.proposal_set_id)
               FROM narrative_proposals proposal
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
              WHERE proposal.id = ?1",
            params![proposal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((run_id, project_id, set_application_count)) = set_context {
        if set_application_count > 0
            && current_chronicle_run_spec_for_run(conn, &project_id, &run_id)?
        {
            anyhow::bail!(
                "NEX_CHRONICLE_APPLY_SET_CONSUMED: current Chronicle ProposalSet already owns {set_application_count} Application row(s)"
            );
        }
    }
    Ok(())
}

pub(crate) fn ensure_run_project(
    conn: &Connection,
    run_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!("narrative extraction run project mismatch"),
        None => anyhow::bail!("narrative extraction run not found"),
    }
}

fn ensure_generic_task_api_allowed(conn: &Connection, run_id: &str) -> anyhow::Result<()> {
    let (has_run_kind, has_consumer_id): (bool, bool) = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM pragma_table_info('narrative_extraction_runs')
              WHERE name = 'run_kind'
           ),
           EXISTS(
             SELECT 1 FROM pragma_table_info('narrative_extraction_runs')
              WHERE name = 'consumer_id'
           )",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    match (has_run_kind, has_consumer_id) {
        // Pre-C2 compatibility schemas cannot represent a system-owned
        // incremental Freshness Run, so their generic task APIs retain the
        // legacy behavior. A half-upgraded schema is ambiguous and must not
        // silently bypass the ownership guard.
        (false, false) => return Ok(()),
        (true, true) => {}
        _ => anyhow::bail!(
            "NEX_SYSTEM_RUN_SCHEMA_INVALID: run_kind and consumer_id must be upgraded together"
        ),
    }

    let system_owned: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM narrative_extraction_runs
            WHERE id = ?1
              AND (
                (run_kind = 'freshness-evaluation' AND consumer_id = ?2)
                OR run_kind IN (
                  'backfill',
                  'dependency-verify',
                  'dependency-repair',
                  'semantic-index-rebuild'
                )
              )
         )",
        params![run_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        !system_owned,
        "NEX_SYSTEM_RUN_API_FORBIDDEN: automatic maintenance Run lifecycle is owned by its runtime"
    );
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The current coordinator seals its runtime inputs inside a versioned Run
/// spec.  Older Chronicle rows remain readable for recovery UI, but cannot be
/// mistaken for this resume-capable production contract.
fn is_current_chronicle_run_spec(surface_path_id: &str, spec_json: &Value) -> bool {
    surface_path_id == CHRONICLE_EXTRACT_SURFACE_PATH
        && spec_json.get("kind").and_then(Value::as_str) == Some(CHRONICLE_RUN_SPEC_KIND)
}

/// A legacy Chronicle Run has no current sealing fields and remains readable
/// (and creatable) for recovery compatibility.  Once a caller supplies any
/// v2 coordinate, however, it must satisfy the complete v2 contract; a
/// partial/downgraded marker must never silently become "legacy".
fn has_current_chronicle_run_spec_markers(
    surface_path_id: &str,
    spec_json: &Value,
    catalog_digest: Option<&str>,
) -> bool {
    if surface_path_id != CHRONICLE_EXTRACT_SURFACE_PATH {
        return false;
    }
    // A v2 Run always seals the catalog. This catches a stored kind/version
    // downgrade even if an attacker also strips the visible JSON markers.
    if catalog_digest.is_some() {
        return true;
    }
    let Some(object) = spec_json.as_object() else {
        return false;
    };
    object.get("kind").and_then(Value::as_str) == Some(CHRONICLE_RUN_SPEC_KIND)
        || object.get("version").and_then(Value::as_u64) == Some(2)
        || object.contains_key("executionMode")
        || object.contains_key("existingEventsCatalogDigest")
        || object.contains_key("coordinatorContractDigest")
}

fn validate_current_chronicle_run_spec(
    surface_path_id: &str,
    spec_json: &Value,
    spec_digest: &str,
    catalog_digest: Option<&str>,
) -> anyhow::Result<bool> {
    if !has_current_chronicle_run_spec_markers(surface_path_id, spec_json, catalog_digest) {
        return Ok(false);
    }
    anyhow::ensure!(
        is_current_chronicle_run_spec(surface_path_id, spec_json),
        "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run v2 markers require kind '{CHRONICLE_RUN_SPEC_KIND}'"
    );
    let object = spec_json.as_object().ok_or_else(|| {
        anyhow::anyhow!("NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run specJson must be an object")
    })?;
    const FIELDS: [&str; 7] = [
        "kind",
        "domain",
        "version",
        "taskChain",
        "executionMode",
        "existingEventsCatalogDigest",
        "coordinatorContractDigest",
    ];
    anyhow::ensure!(
        object.len() == FIELDS.len() && FIELDS.iter().all(|field| object.contains_key(*field)),
        "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run specJson has an unsupported shape"
    );
    anyhow::ensure!(
        object.get("domain").and_then(Value::as_str) == Some("chronicle")
            && object.get("version").and_then(Value::as_u64) == Some(2),
        "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run spec domain/version is unsupported"
    );
    let expected_task_chain = json!(CHRONICLE_EXTRACT_TASK_CHAIN);
    anyhow::ensure!(
        object.get("taskChain") == Some(&expected_task_chain),
        "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run taskChain is not the exact production DAG"
    );
    anyhow::ensure!(
        matches!(
            object.get("executionMode").and_then(Value::as_str),
            Some("ai" | "deterministic-fallback")
        ),
        "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run executionMode is unsupported"
    );
    let sealed_catalog_digest = object
        .get("existingEventsCatalogDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run existingEventsCatalogDigest is missing"
            )
        })?;
    let coordinator_contract_digest = object
        .get("coordinatorContractDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run coordinatorContractDigest is missing"
            )
        })?;
    anyhow::ensure!(
        is_sha256_digest(sealed_catalog_digest) && is_sha256_digest(coordinator_contract_digest),
        "NEX_CHRONICLE_RUN_SPEC_INVALID: Chronicle Run sealed digests must be lowercase sha256"
    );
    anyhow::ensure!(
        catalog_digest == Some(sealed_catalog_digest),
        "NEX_CHRONICLE_RUN_SPEC_CATALOG_MISMATCH: catalogDigest does not match specJson.existingEventsCatalogDigest"
    );
    let expected_spec_digest = canonical_json_digest(spec_json)?;
    anyhow::ensure!(
        spec_digest == expected_spec_digest,
        "NEX_CHRONICLE_RUN_SPEC_DIGEST_MISMATCH: stored specDigest does not match Native canonical specJson"
    );
    Ok(true)
}

fn validate_chronicle_run_value(run: &Value) -> anyhow::Result<bool> {
    let object = run.as_object().ok_or_else(|| {
        anyhow::anyhow!("NEX_CHRONICLE_RUN_SPEC_INVALID: stored Run projection is not an object")
    })?;
    let surface_path_id = object
        .get("surfacePathId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_CHRONICLE_RUN_SPEC_INVALID: stored Run surfacePathId is missing")
        })?;
    let spec_json = object.get("specJson").ok_or_else(|| {
        anyhow::anyhow!("NEX_CHRONICLE_RUN_SPEC_INVALID: stored Run specJson is missing")
    })?;
    let spec_digest = object
        .get("specDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_CHRONICLE_RUN_SPEC_INVALID: stored Run specDigest is missing")
        })?;
    let catalog_digest = object.get("catalogDigest").and_then(Value::as_str);
    validate_current_chronicle_run_spec(surface_path_id, spec_json, spec_digest, catalog_digest)
}

pub(crate) fn current_chronicle_run_spec_for_run(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<bool> {
    let (surface_path_id, spec_json_text, spec_digest, catalog_digest): (
        String,
        String,
        String,
        Option<String>,
    ) = conn.query_row(
        "SELECT surface_path_id, spec_json, spec_digest, catalog_digest
           FROM narrative_extraction_runs
          WHERE id = ?1 AND project_id = ?2",
        params![run_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let spec_json: Value = serde_json::from_str(&spec_json_text).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RUN_SPEC_INVALID: stored Chronicle Run specJson is malformed: {error}"
        )
    })?;
    validate_current_chronicle_run_spec(
        &surface_path_id,
        &spec_json,
        &spec_digest,
        catalog_digest.as_deref(),
    )
}

/// Return the sealed execution mode for a current Chronicle Run. Legacy rows
/// deliberately remain generic-compatible; a marker-bearing row has already
/// been fully canonical-validated before this returns a mode.
fn current_chronicle_execution_mode_for_run(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Option<String>> {
    let (surface_path_id, spec_json_text, spec_digest, catalog_digest): (
        String,
        String,
        String,
        Option<String>,
    ) = conn.query_row(
        "SELECT surface_path_id, spec_json, spec_digest, catalog_digest
           FROM narrative_extraction_runs
          WHERE id = ?1 AND project_id = ?2",
        params![run_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let spec_json: Value = serde_json::from_str(&spec_json_text).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RUN_SPEC_INVALID: stored Chronicle Run specJson is malformed: {error}"
        )
    })?;
    if !validate_current_chronicle_run_spec(
        &surface_path_id,
        &spec_json,
        &spec_digest,
        catalog_digest.as_deref(),
    )? {
        return Ok(None);
    }
    let execution_mode = spec_json
        .get("executionMode")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RUN_SPEC_INVALID: validated current Chronicle Run has no executionMode"
            )
        })?;
    Ok(Some(execution_mode.to_string()))
}

/// Load the only artifact from a completed predecessor's current Attempt and
/// re-CAS its inline JSON.  The zero-work mode exception below relies on this
/// durable predecessor, never on a caller-supplied output count.
fn load_current_completed_chronicle_artifact_payload(
    conn: &Connection,
    run_id: &str,
    task_kind: &str,
    artifact_kind: &str,
) -> anyhow::Result<Value> {
    let (task_id, attempt_id): (String, String) = conn
        .query_row(
            "SELECT t.id, a.id
               FROM narrative_extraction_tasks t
               JOIN narrative_extraction_attempts a
                 ON a.task_id = t.id
                AND a.attempt_number = t.attempt_count
                AND a.status = 'completed'
              WHERE t.run_id = ?1 AND t.task_kind = ?2 AND t.status = 'completed'",
            params![run_id, task_kind],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_AI_ZERO_WORK_PROOF_MISSING: completed predecessor '{task_kind}' has no completed current Attempt: {error}"
            )
        })?;
    let mut statement = conn.prepare(
        "SELECT payload_storage, payload_json, payload_digest
           FROM narrative_extraction_artifacts
          WHERE run_id = ?1 AND task_id = ?2 AND attempt_id = ?3
            AND artifact_kind = ?4
          ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement
        .query_map(params![run_id, task_id, attempt_id, artifact_kind], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        rows.len() == 1,
        "NEX_CHRONICLE_AI_ZERO_WORK_PROOF_MISSING: predecessor '{task_kind}' requires exactly one current '{artifact_kind}' artifact"
    );
    let (storage, payload_json, payload_digest) = rows
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("unreachable checked predecessor artifact row"))?;
    anyhow::ensure!(
        storage == "inline-json",
        "NEX_CHRONICLE_AI_ZERO_WORK_PROOF_MISSING: predecessor '{task_kind}' artifact '{artifact_kind}' is not inline-json"
    );
    let payload: Value = payload_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_AI_ZERO_WORK_PROOF_MISSING: predecessor '{task_kind}' artifact '{artifact_kind}' has no payload"
            )
        })?;
    let expected_digest = canonical_json_digest(&payload)?;
    anyhow::ensure!(
        payload_digest.as_deref() == Some(expected_digest.as_str()),
        "NEX_CHRONICLE_AI_ZERO_WORK_PROOF_MISSING: predecessor '{task_kind}' artifact '{artifact_kind}' digest is not Native canonical JSON"
    );
    Ok(payload)
}

fn current_completed_chronicle_artifact_array_is_empty(
    conn: &Connection,
    run_id: &str,
    task_kind: &str,
    artifact_kind: &str,
    array_field: &str,
) -> anyhow::Result<bool> {
    let payload =
        load_current_completed_chronicle_artifact_payload(conn, run_id, task_kind, artifact_kind)?;
    let values = payload.get(array_field).and_then(Value::as_array).ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_AI_ZERO_WORK_PROOF_MISSING: predecessor '{task_kind}' artifact '{artifact_kind}' has no '{array_field}' array"
        )
    })?;
    Ok(values.is_empty())
}

/// A current Chronicle Run must not cross its sealed AI/fallback boundary at
/// generic FinishTask. AI observation/synthesis output later becomes durable
/// causal input, so bind it to exact artifacts and task-local C1 provenance.
/// The only no-receipt exception is Native-proved zero work: a canonical
/// completed predecessor roster is exactly empty. Receipt authenticity/audit
/// lifecycle checks remain inside `persist_task_artifacts` in this same
/// immediate transaction.
fn validate_current_chronicle_ai_task_finish_input(
    conn: &Connection,
    payload: &FinishTaskPayload,
    output_json: &Value,
) -> anyhow::Result<()> {
    let Some(execution_mode) =
        current_chronicle_execution_mode_for_run(conn, &payload.project_id, &payload.run_id)?
    else {
        return Ok(());
    };
    if execution_mode == "deterministic-fallback" {
        anyhow::ensure!(
            payload.chronicle_stage_bundle.is_none() && payload.chronicle_stage_receipts.is_empty(),
            "NEX_CHRONICLE_EXECUTION_MODE_MISMATCH: deterministic-fallback Chronicle Run cannot persist AI stage provenance"
        );
        return Ok(());
    }
    let task_kind: String = conn.query_row(
        "SELECT task_kind FROM narrative_extraction_tasks WHERE id = ?1 AND run_id = ?2",
        params![payload.task_id, payload.run_id],
        |row| row.get(0),
    )?;
    let has_receipt_for = |stage_id: ChronicleStageId| {
        payload.chronicle_stage_receipts.iter().any(|receipt| {
            receipt.stage_execution.task_id == payload.task_id
                && receipt.stage_execution.attempt_id == payload.attempt_id
                && receipt.stage_execution.stage_id == stage_id
        })
    };
    match task_kind.as_str() {
        "chronicle.observe-events@1" => {
            let observation_count = output_json
                .get("observationCount")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_AI_OBSERVATION_OUTPUT_INVALID: AI Observation output requires observationCount"
                    )
                })?;
            let observation_artifacts = payload
                .artifacts
                .iter()
                .filter(|artifact| {
                    artifact.artifact_kind == CHRONICLE_RAW_OBSERVATIONS_ARTIFACT_KIND
                })
                .collect::<Vec<_>>();
            anyhow::ensure!(
                observation_artifacts.len() == 1,
                "NEX_CHRONICLE_AI_OBSERVATION_OUTPUT_INVALID: AI Observation requires exactly one chronicle.raw-observations@1 artifact"
            );
            let observations = observation_artifacts[0]
                .payload_json
                .as_ref()
                .and_then(|value| value.get("observations"))
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_AI_OBSERVATION_OUTPUT_INVALID: raw-observations artifact has no observations array"
                    )
                })?;
            anyhow::ensure!(
                observations.len() as u64 == observation_count,
                "NEX_CHRONICLE_AI_OBSERVATION_OUTPUT_INVALID: observationCount does not match current raw-observations artifact"
            );
            let native_proved_zero_windows = observation_count == 0
                && current_completed_chronicle_artifact_array_is_empty(
                    conn,
                    &payload.run_id,
                    "source.window-plan@1",
                    CHRONICLE_WINDOW_PLAN_ARTIFACT_KIND,
                    "windows",
                )?;
            anyhow::ensure!(
                native_proved_zero_windows
                    || has_receipt_for(ChronicleStageId::NarrativeObservationExtract),
                "NEX_CHRONICLE_AI_STAGE_PROVENANCE_REQUIRED: AI Observation finish requires a task-local terminal receipt unless its canonical completed window plan proves zero windows"
            );
        }
        "chronicle.synthesize-event@1" => {
            let hypothesis_count = output_json
                .get("hypothesisCount")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_AI_SYNTHESIS_OUTPUT_INVALID: AI Synthesis output requires hypothesisCount"
                    )
                })?;
            let hypothesis_artifacts = payload
                .artifacts
                .iter()
                .filter(|artifact| {
                    artifact.artifact_kind == CHRONICLE_EVENT_HYPOTHESES_ARTIFACT_KIND
                })
                .collect::<Vec<_>>();
            anyhow::ensure!(
                hypothesis_artifacts.len() == 1,
                "NEX_CHRONICLE_AI_SYNTHESIS_OUTPUT_INVALID: AI Synthesis requires exactly one chronicle.event-hypotheses@1 artifact"
            );
            let hypotheses = hypothesis_artifacts[0]
                .payload_json
                .as_ref()
                .and_then(|value| value.get("hypotheses"))
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_AI_SYNTHESIS_OUTPUT_INVALID: hypotheses artifact has no hypotheses array"
                    )
                })?;
            anyhow::ensure!(
                hypotheses.len() as u64 == hypothesis_count,
                "NEX_CHRONICLE_AI_SYNTHESIS_OUTPUT_INVALID: hypothesisCount does not match current hypotheses artifact"
            );
            let native_proved_zero_clusters = hypothesis_count == 0
                && current_completed_chronicle_artifact_array_is_empty(
                    conn,
                    &payload.run_id,
                    "chronicle.cluster-event-observations@1",
                    CHRONICLE_EVENT_CLUSTERS_ARTIFACT_KIND,
                    "clusters",
                )?;
            anyhow::ensure!(
                native_proved_zero_clusters
                    || (payload.chronicle_stage_bundle.is_some()
                        && has_receipt_for(ChronicleStageId::NarrativeEventSynthesize)),
                "NEX_CHRONICLE_AI_STAGE_PROVENANCE_REQUIRED: AI Synthesis finish requires its typed C1 bundle and task-local terminal receipt unless its canonical completed cluster roster proves zero clusters"
            );
        }
        _ => {}
    }
    Ok(())
}

fn chronicle_plan_proposal_set_id(run_id: &str, task_id: &str) -> String {
    format!("chronicle-plan-proposals:{run_id}:{task_id}")
}

pub(crate) fn insert_attempt(
    conn: &Connection,
    attempt_id: &str,
    task_id: &str,
    attempt_number: i64,
    status: &str,
    started_at: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_extraction_attempts
            (id, task_id, attempt_number, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![attempt_id, task_id, attempt_number, status, started_at],
    )?;
    Ok(())
}

pub(crate) fn insert_artifacts_for_attempt(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    artifacts: &[ArtifactInput],
) -> anyhow::Result<()> {
    for artifact in artifacts {
        let artifact_id = artifact
            .artifact_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let payload_storage = artifact
            .payload_storage
            .clone()
            .unwrap_or_else(|| "inline-json".to_string());
        let payload_json = artifact
            .payload_json
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .unwrap_or_else(|| "{}".to_string());
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind,
                 payload_storage, payload_json, payload_ref, payload_digest, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))",
            params![
                artifact_id,
                run_id,
                task_id,
                attempt_id,
                artifact.artifact_kind,
                payload_storage,
                payload_json,
                artifact.payload_ref,
                artifact.payload_digest,
            ],
        )?;
    }
    Ok(())
}

pub fn create_run(db: &Database, payload: CreateRunPayload) -> anyhow::Result<Value> {
    let run_id = payload
        .run_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    validate_run_id(&run_id)?;
    let current_chronicle_spec = validate_current_chronicle_run_spec(
        &payload.surface_path_id,
        &payload.spec_json,
        &payload.spec_digest,
        payload.catalog_digest.as_deref(),
    )?;
    if current_chronicle_spec {
        let mut seen = HashSet::with_capacity(payload.tasks.len());
        for task in &payload.tasks {
            anyhow::ensure!(
                CHRONICLE_EXTRACT_TASK_CHAIN.contains(&task.task_kind.as_str())
                    && seen.insert(task.task_kind.as_str()),
                "NEX_CHRONICLE_RUN_TASK_TOPOLOGY_INVALID: current Chronicle Run tasks must be the exact production DAG"
            );
        }
        anyhow::ensure!(
            seen.len() == CHRONICLE_EXTRACT_TASK_CHAIN.len()
                && CHRONICLE_EXTRACT_TASK_CHAIN
                    .iter()
                    .all(|task_kind| seen.contains(task_kind)),
            "NEX_CHRONICLE_RUN_TASK_TOPOLOGY_INVALID: current Chronicle Run tasks must include each production DAG kind exactly once"
        );
    }
    let coverage_json = serde_json::to_string(
        payload
            .coverage_json
            .as_ref()
            .unwrap_or(&default_object_json()),
    )?;
    let scope_json = serde_json::to_string(&payload.scope_json)?;
    let spec_json = serde_json::to_string(&payload.spec_json)?;
    let status = if payload.tasks.is_empty() {
        "pending"
    } else {
        "running"
    };

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            let semantic_epoch_id = current_c2zc_run_epoch_in_tx(conn, &payload.project_id)?;
            let run_timestamp = next_run_lifecycle_timestamp_in_tx(conn, &payload.project_id)?;
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     snapshot_digest, catalog_digest, registry_digest, semantic_epoch_id,
                     status, coverage_json,
                     created_at, started_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                         ?12, ?13, CASE WHEN ?11 = 'running' THEN ?13 ELSE NULL END, 0)",
                params![
                    run_id,
                    payload.project_id,
                    payload.surface_path_id,
                    scope_json,
                    spec_json,
                    payload.spec_digest,
                    payload.snapshot_digest,
                    payload.catalog_digest,
                    payload.registry_digest,
                    semantic_epoch_id,
                    status,
                    coverage_json,
                    run_timestamp,
                ],
            )?;

            let mut task_ids = Vec::new();
            for seed in &payload.tasks {
                let task_id = insert_task_seed(conn, &run_id, seed)?;
                task_ids.push(task_id);
            }

            Ok(json!({
                "runId": run_id,
                "status": status,
                "taskIds": task_ids,
            }))
        })
    })
}

/// Work-key reuse policy for [`create_system_run`], per each Run Kind's
/// `sameWorkKeyReuse` in `policies/narrative/narrative-run-kind-policy.json`.
pub(crate) enum SystemRunWorkKeyReuse {
    /// `dependency-backfill`: an automatic-once trigger firing again while a
    /// prior attempt is still running, or after one already completed, must
    /// not create a second Run.
    #[allow(dead_code)]
    RunningAndCompleted,
    /// `dependency-verify` / `dependency-rebuild-derived`: a second trigger
    /// while one is already running reuses it; a completed Run does not
    /// short-circuit a fresh request on its own — Verify's `skipReRunWhen`
    /// and Rebuild's `completedRunReuseNote` are the caller's decision to
    /// make before calling this, not this dedup's.
    RunningOnly,
    /// `dependency-repair`: `sameWorkKeyReuse: "no-automatic-reuse-decision"`
    /// — exclusivity is the Repair lease's job, not work-key dedup here.
    /// The automatic phase owner cannot request this variant; the manual
    /// Repair planner claims its lease directly.
    #[allow(dead_code)]
    None,
}

/// Create a system-triggered (Backfill/Verify/Rebuild-Derived/Repair) Run.
///
/// Distinct from [`create_run`]: system Run Kinds are infrastructure the
/// system runs on itself, not AI extraction, so this does not gate on
/// [`require_narrative_extraction_allowed`] — the "narrative extraction
/// disabled" runtime policy toggle is about AI reading text, and per the
/// Run Kind Policy's `duringBackfillProductBehavior`, editing (and by the
/// same principle, the system's own maintenance of the Dependency Graph)
/// is never blocked by it.
///
/// `work_key` scopes reuse: passing the same `work_key` for the same
/// `run_kind`/`project_id` while a prior Run is still eligible per `reuse`
/// returns that Run instead of creating a duplicate, so an idempotent
/// trigger (e.g. the post-open Backfill bootstrap) can fire repeatedly
/// without racing itself.
///
/// The standalone wrapper is retained for callers that start outside an
/// ambient transaction. The Rust phase owner uses the `_in_tx` helper so Run
/// creation can share the same live Database transaction as the phase writes.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_system_run(
    db: &Database,
    project_id: &str,
    run_kind: &str,
    semantic_epoch_id: &str,
    work_key: &str,
    spec_json: &Value,
    spec_digest: &str,
    reuse: SystemRunWorkKeyReuse,
    request: Option<&RunRequestIdentity<'_>>,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            create_system_run_in_tx(
                conn,
                project_id,
                run_kind,
                semantic_epoch_id,
                work_key,
                spec_json,
                spec_digest,
                reuse,
                request,
            )
        })
    })
}

/// Core of [`create_system_run`], as an ambient-transaction helper: callers
/// that need to compose Run creation atomically with other writes in the
/// same transaction (e.g. the Backfill bootstrap trigger creating the Run
/// and then immediately running the transform under it) call this directly
/// instead of going through the `Database`-level wrapper, which would
/// nest a second `BEGIN IMMEDIATE` on the same connection.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_system_run_in_tx(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
    semantic_epoch_id: &str,
    work_key: &str,
    spec_json: &Value,
    spec_digest: &str,
    reuse: SystemRunWorkKeyReuse,
    request: Option<&RunRequestIdentity<'_>>,
) -> anyhow::Result<Value> {
    create_system_run_in_tx_with_reserved_id(
        conn,
        project_id,
        run_kind,
        semantic_epoch_id,
        work_key,
        spec_json,
        spec_digest,
        reuse,
        request,
        None,
    )
}

/// Variant used by the common lifecycle owner when it has already reserved
/// an exact Run identity before the creation transaction starts.  Reuse is
/// still decided first; the reservation is only consumed for a fresh tuple.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_system_run_in_tx_with_reserved_id(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
    semantic_epoch_id: &str,
    work_key: &str,
    spec_json: &Value,
    spec_digest: &str,
    reuse: SystemRunWorkKeyReuse,
    request: Option<&RunRequestIdentity<'_>>,
    reserved_run_id: Option<&str>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !project_destructive_permit_active(project_id),
        "NEX_PROJECT_DESTRUCTIVE_BUSY: project '{project_id}' is under a destructive permit"
    );
    // Request replay is resolved before work-key equivalence, because they
    // answer different questions: "did this exact request already run?"
    // versus "is some other Run already doing this work?". A retry of an
    // approved `dependency-repair` must replay its own Run rather than be
    // judged by a work-key policy that deliberately says
    // `no-automatic-reuse-decision`.
    if let Some(request) = request {
        anyhow::ensure!(
            !request.request_id.trim().is_empty(),
            "NEX_RUN_REQUEST_INVALID: requestId must not be empty"
        );
        anyhow::ensure!(
            !request.idempotency_domain.trim().is_empty(),
            "NEX_RUN_REQUEST_INVALID: idempotencyDomain must not be empty"
        );
        anyhow::ensure!(
            !request.actor_id.trim().is_empty(),
            "NEX_RUN_REQUEST_INVALID: actorId must not be empty"
        );
        if let Some(replayed) = find_run_by_request_identity(conn, project_id, request)? {
            return Ok(replayed);
        }
    }

    if let Some(reused) = find_reusable_system_run(conn, project_id, run_kind, work_key, &reuse)? {
        return Ok(reused);
    }
    // The foreground product-journey marker is supplied by the native
    // maintenance owner through a process-local guard. It is merged before
    // insertion so the persisted JSON is immutable for the lifetime of the
    // Run; arbitrary callers cannot smuggle a conflicting marker.
    let persisted_spec_json =
        super::maintenance_runtime::spec_with_active_system_work_marker(spec_json)?;
    let spec_json_text = serde_json::to_string(&persisted_spec_json)?;
    let scope_json_text = serde_json::to_string(&default_object_json())?;
    let coverage_json_text = serde_json::to_string(&default_object_json())?;
    let run_id = reserved_run_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    // Run authority is a lifecycle instant, not UUID insertion order. Keep
    // automatic/system rows strictly monotonic at the persisted millisecond
    // precision so a Verify -> Rebuild -> confirmation Verify chain created
    // in one transaction window remains unambiguous after restart/import.
    let run_timestamp = next_system_run_timestamp(conn, project_id)?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, started_at, version,
             run_kind, semantic_epoch_id, work_key,
             request_id, idempotency_domain, request_payload_digest, actor_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                 'running', ?7, ?8, ?8, 0,
                 ?3, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            run_id,
            project_id,
            run_kind,
            scope_json_text,
            spec_json_text,
            spec_digest,
            coverage_json_text,
            run_timestamp,
            semantic_epoch_id,
            work_key,
            request.map(|request| request.request_id),
            request.map(|request| request.idempotency_domain),
            request.map(|request| request.payload_digest),
            request.map(|request| request.actor_id),
        ],
    )?;
    Ok(json!({
        "runId": run_id,
        "status": "running",
        "reused": false,
        "replayed": false,
    }))
}

fn next_system_run_timestamp(conn: &Connection, project_id: &str) -> anyhow::Result<String> {
    next_run_lifecycle_timestamp_in_tx(conn, project_id)
}

/// Who asked for a system Run, and which request it was.
///
/// Deliberately separate from `work_key`: `work_key` is work equivalence
/// (`sameWorkKeyReuse`), this is request identity
/// (`sameRequestIdReuse: idempotent-replay`). `payload_digest` is what makes
/// a replay distinguishable from a different request that happens to reuse
/// an id.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunRequestIdentity<'a> {
    pub request_id: &'a str,
    /// Scopes `request_id` so two unrelated surfaces cannot collide on one.
    pub idempotency_domain: &'a str,
    pub payload_digest: &'a str,
    pub actor_id: &'a str,
}

/// An existing Run for exactly this request, if any.
///
/// Fails closed on two different kinds of reuse: the same
/// `(domain, requestId)` carrying a different payload, and the same
/// `(domain, requestId)` presented by a different actor. Both are a caller
/// reusing an id rather than retrying, and replaying someone else's
/// approved operation is exactly the confusion request identity exists to
/// prevent.
///
/// Reports the Run's `status` and stored `outcome` verbatim. Callers must
/// branch on that status — a replayed Run that is `failed`, `running`, or
/// `cancelled` is emphatically not a success, and treating "this request
/// was seen before" as "this request succeeded" would report a repair that
/// never ran as done.
pub(crate) fn find_run_by_request_identity(
    conn: &Connection,
    project_id: &str,
    request: &RunRequestIdentity<'_>,
) -> anyhow::Result<Option<Value>> {
    let existing: Option<(String, String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, status, COALESCE(request_payload_digest, ''), COALESCE(actor_id, ''),
                    outcome_summary_json
               FROM narrative_extraction_runs
              WHERE project_id = ?1
                AND idempotency_domain = ?2
                AND request_id = ?3",
            params![project_id, request.idempotency_domain, request.request_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((run_id, status, payload_digest, actor_id, outcome_json)) = existing else {
        return Ok(None);
    };
    anyhow::ensure!(
        payload_digest == request.payload_digest,
        "NEX_RUN_REQUEST_CONFLICT: requestId '{}' in domain '{}' already ran for project \
         '{project_id}' with a different payload; reusing a requestId for different work is not \
         an idempotent replay",
        request.request_id,
        request.idempotency_domain
    );
    anyhow::ensure!(
        actor_id == request.actor_id,
        "NEX_RUN_REQUEST_CONFLICT: requestId '{}' in domain '{}' was issued by actor \
         '{actor_id}' for project '{project_id}'; actor '{}' may not replay it",
        request.request_id,
        request.idempotency_domain,
        request.actor_id
    );
    // A stored outcome that will not parse is corruption, and this is a
    // replay path: the caller is about to hand this value back as the
    // authoritative answer for a request it believes already ran. Coercing
    // unreadable JSON to `null` would turn that corruption into a
    // confident-looking empty result, so it fails closed instead. A Run
    // with *no* outcome recorded at all is different and stays `null` —
    // that is the normal shape of a Run still in flight.
    let outcome = match outcome_json.as_deref().map(str::trim) {
        None | Some("") => Value::Null,
        Some(text) => serde_json::from_str::<Value>(text).map_err(|error| {
            anyhow::anyhow!(
                "NEX_RUN_OUTCOME_MALFORMED: Run '{run_id}' (requestId '{}' in domain '{}') has \
                 an unreadable outcome_summary_json: {error}",
                request.request_id,
                request.idempotency_domain
            )
        })?,
    };
    Ok(Some(json!({
        "runId": run_id,
        "status": status,
        "reused": true,
        "replayed": true,
        "outcome": outcome,
    })))
}

/// Record a Run's terminal outcome so a later replay of the same request
/// can reproduce the original response instead of inventing a new one.
pub(crate) fn record_run_outcome_in_tx(
    conn: &Connection,
    run_id: &str,
    outcome: &Value,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE narrative_extraction_runs SET outcome_summary_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(outcome)?, run_id],
    )?;
    Ok(())
}

fn find_reusable_system_run(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
    work_key: &str,
    reuse: &SystemRunWorkKeyReuse,
) -> anyhow::Result<Option<Value>> {
    let status_clause = match reuse {
        SystemRunWorkKeyReuse::RunningAndCompleted => "status IN ('pending','running','completed')",
        SystemRunWorkKeyReuse::RunningOnly => "status IN ('pending','running')",
        SystemRunWorkKeyReuse::None => return Ok(None),
    };
    let sql = format!(
        "SELECT id, status FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3 AND {status_clause}
          ORDER BY created_at DESC LIMIT 1"
    );
    conn.query_row(&sql, params![project_id, run_kind, work_key], |row| {
        Ok(json!({
            "runId": row.get::<_, String>(0)?,
            "status": row.get::<_, String>(1)?,
            "reused": true,
        }))
    })
    .optional()
    .map_err(Into::into)
}

fn insert_task_seed(
    conn: &Connection,
    run_id: &str,
    seed: &CreateTaskSeed,
) -> anyhow::Result<String> {
    let task_id = seed
        .task_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let input_json =
        serde_json::to_string(seed.input_json.as_ref().unwrap_or(&default_object_json()))?;
    let priority = seed.priority.unwrap_or(0);
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority, attempt_count, created_at, version)
         VALUES (?1, ?2, ?3, 'queued', ?4, ?5, 0, datetime('now'), 0)",
        params![task_id, run_id, seed.task_kind, input_json, priority],
    )?;
    Ok(task_id)
}

pub fn get_run(db: &Database, run_id: String, project_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        ensure_run_project(conn, &run_id, &project_id)?;
        let run = conn.query_row(
            "SELECT id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                    snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                    outcome_summary_json, created_at, started_at, completed_at, version
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![run_id],
            row_to_run_value,
        )?;
        validate_chronicle_run_value(&run)?;

        let mut stmt = conn.prepare(
            "SELECT id, run_id, task_kind, status, input_json, output_json, priority,
                    attempt_count, lease_owner, lease_expires_at, heartbeat_at,
                    error_message, created_at, started_at, completed_at, version
               FROM narrative_extraction_tasks
              WHERE run_id = ?1
              ORDER BY priority DESC, created_at ASC",
        )?;
        let tasks: Vec<Value> = stmt
            .query_map(params![run_id], row_to_task_value)?
            .collect::<Result<_, _>>()?;

        let mut counts = json!({
            "queued": 0,
            "running": 0,
            "completed": 0,
            "failed": 0,
            "cancelled": 0,
        });
        for task in &tasks {
            if let Some(status) = task.get("status").and_then(Value::as_str) {
                if let Some(count) = counts.get_mut(status) {
                    *count = json!(count.as_i64().unwrap_or(0) + 1);
                }
            }
        }

        Ok(json!({
            "run": run,
            "tasks": tasks,
            "taskCounts": counts,
        }))
    })
}

/// List runs that still have a durable, unapplied ProposalSet for review restore.
/// In-progress runs without a ProposalSet are intentionally excluded — those are
/// task-resume candidates, not Review-resume candidates.
pub fn list_resumable_runs(
    db: &Database,
    payload: ListResumableRunsPayload,
) -> anyhow::Result<Value> {
    let limit = payload.limit.unwrap_or(20).clamp(1, 100);
    db.with_conn(|conn| {
        let sql = format!(
            "SELECT r.id, r.project_id, r.surface_path_id, r.status, r.snapshot_digest,
                    r.created_at, r.started_at, r.completed_at
               FROM narrative_extraction_runs r
              WHERE r.project_id = ?1
                AND (?2 IS NULL OR r.surface_path_id = ?2)
                AND {REVIEW_RESUMABLE_RUN_PREDICATE_SQL}
              ORDER BY julianday(COALESCE(r.completed_at, r.started_at, r.created_at)) DESC,
                       COALESCE(r.completed_at, r.started_at, r.created_at) DESC,
                       r.id DESC
              LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let surface = payload.surface_path_id.as_deref();
        let rows = stmt.query_map(params![payload.project_id, surface, limit], |row| {
            Ok(json!({
                "runId": row.get::<_, String>(0)?,
                "projectId": row.get::<_, String>(1)?,
                "surfacePathId": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "snapshotDigest": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
                "startedAt": row.get::<_, Option<String>>(6)?,
                "completedAt": row.get::<_, Option<String>>(7)?,
            }))
        })?;
        let summaries: Vec<Value> = rows.collect::<Result<_, _>>()?;
        Ok(json!(summaries))
    })
}

/// Proves exact Review resumability for one already-discovered Run without a
/// bounded-list lookup. Unknown or cross-scope Run coordinates are contract
/// errors; `resumable: false` only describes the matching durable Run.
pub fn is_run_resumable_for_review(
    db: &Database,
    payload: IsRunResumableForReviewPayload,
) -> anyhow::Result<IsRunResumableForReviewResult> {
    for (field, value) in [
        ("runId", payload.run_id.as_str()),
        ("projectId", payload.project_id.as_str()),
        ("surfacePathId", payload.surface_path_id.as_str()),
    ] {
        anyhow::ensure!(
            !value.trim().is_empty() && value.trim() == value,
            "NEX_REVIEW_RESUME_QUERY_INVALID: {field} must be non-empty and unpadded"
        );
    }

    db.with_conn(|conn| {
        let owner = conn
            .query_row(
                "SELECT project_id, surface_path_id
                   FROM narrative_extraction_runs
                  WHERE id = ?1",
                [&payload.run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((owner_project_id, owner_surface_path_id)) = owner else {
            anyhow::bail!(
                "NEX_REVIEW_RESUME_RUN_NOT_FOUND: exact narrative extraction Run does not exist"
            );
        };
        anyhow::ensure!(
            owner_project_id == payload.project_id
                && owner_surface_path_id == payload.surface_path_id,
            "NEX_REVIEW_RESUME_RUN_SCOPE_MISMATCH: exact Run scope mismatch"
        );

        let sql = format!(
            "SELECT CASE WHEN {REVIEW_RESUMABLE_RUN_PREDICATE_SQL}
                         THEN 1 ELSE 0 END
               FROM narrative_extraction_runs r
              WHERE r.id = ?1"
        );
        let resumable = conn.query_row(&sql, [&payload.run_id], |row| {
            row.get::<_, i64>(0).map(|value| value == 1)
        })?;
        Ok(IsRunResumableForReviewResult {
            run_id: payload.run_id,
            project_id: payload.project_id,
            surface_path_id: payload.surface_path_id,
            resumable,
        })
    })
}

#[derive(Debug)]
struct ChronicleTaskResumeRunRow {
    run_id: String,
    project_id: String,
    run_kind: String,
    status: String,
    scope_json_text: String,
    spec_json_text: String,
    spec_digest: String,
    snapshot_digest: Option<String>,
    catalog_digest: Option<String>,
    created_at: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}

fn decode_chronicle_task_resume_run_row(
    row: &Row<'_>,
) -> rusqlite::Result<ChronicleTaskResumeRunRow> {
    Ok(ChronicleTaskResumeRunRow {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        run_kind: row.get(2)?,
        status: row.get(3)?,
        scope_json_text: row.get(4)?,
        spec_json_text: row.get(5)?,
        spec_digest: row.get(6)?,
        snapshot_digest: row.get(7)?,
        catalog_digest: row.get(8)?,
        created_at: row.get(9)?,
        started_at: row.get(10)?,
        completed_at: row.get(11)?,
    })
}

#[derive(Debug)]
struct ChronicleTaskResumeTaskRow {
    task_id: String,
    task_kind: String,
    status: String,
    attempt_count: i64,
    lease_owner: Option<String>,
    lease_expires_at: Option<String>,
    heartbeat_at: Option<String>,
    created_at: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Debug)]
struct ChronicleTaskResumeCandidateRow {
    run_id: String,
    lifecycle_at: DateTime<Utc>,
    value: Value,
}

#[derive(Debug)]
struct ChronicleResumeSnapshotInputs {
    language: String,
    existing_events_catalog: Option<Value>,
    document_count: usize,
    corpus_payload_digest: String,
    scope_authority_composite_digest: Option<String>,
}

fn chronicle_resume_lifecycle_instant(
    run_id: &str,
    field: &str,
    value: &str,
) -> anyhow::Result<DateTime<Utc>> {
    parse_run_lifecycle_instant(value).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: Run '{run_id}' {field} is invalid: {error}"
        )
    })
}

fn chronicle_resume_task_lifecycle_instant(
    run_id: &str,
    task_id: &str,
    field: &str,
    value: &str,
) -> anyhow::Result<DateTime<Utc>> {
    parse_run_lifecycle_instant(value).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: Run '{run_id}' Task '{task_id}' {field} is invalid: {error}"
        )
    })
}

fn validate_chronicle_resume_scope(scope_json: &Value, run_id: &str) -> anyhow::Result<()> {
    let scope = scope_json.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' scopeJson must be an object"
        )
    })?;
    anyhow::ensure!(
        scope.len() == 2 && scope.contains_key("folderId") && scope.contains_key("sceneIds"),
        "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' scopeJson must contain only folderId and sceneIds"
    );
    let folder_id = scope
        .get("folderId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' folderId is missing"
            )
        })?;
    anyhow::ensure!(
        !folder_id.is_empty() && folder_id.trim() == folder_id,
        "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' folderId must be non-empty and unpadded"
    );
    let scene_ids = scope
        .get("sceneIds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' sceneIds must be an array"
            )
        })?;
    let mut unique = HashSet::with_capacity(scene_ids.len());
    for scene_id in scene_ids {
        let scene_id = scene_id.as_str().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' sceneIds must contain strings"
            )
        })?;
        anyhow::ensure!(
            !scene_id.is_empty() && scene_id.trim() == scene_id && unique.insert(scene_id),
            "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{run_id}' sceneIds must be non-empty, unpadded, and unique"
        );
    }
    Ok(())
}

fn load_chronicle_resume_tasks(
    conn: &Connection,
    run_id: &str,
) -> anyhow::Result<Vec<ChronicleTaskResumeTaskRow>> {
    let mut statement = conn.prepare(
        "SELECT id, task_kind, status, attempt_count, lease_owner,
                lease_expires_at, heartbeat_at, created_at, started_at, completed_at
           FROM narrative_extraction_tasks
          WHERE run_id = ?1",
    )?;
    let tasks = statement
        .query_map(params![run_id], |row| {
            Ok(ChronicleTaskResumeTaskRow {
                task_id: row.get(0)?,
                task_kind: row.get(1)?,
                status: row.get(2)?,
                attempt_count: row.get(3)?,
                lease_owner: row.get(4)?,
                lease_expires_at: row.get(5)?,
                heartbeat_at: row.get(6)?,
                created_at: row.get(7)?,
                started_at: row.get(8)?,
                completed_at: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(tasks)
}

fn validate_chronicle_resume_task_lifecycle(
    conn: &Connection,
    run_id: &str,
    task: &ChronicleTaskResumeTaskRow,
) -> anyhow::Result<()> {
    let _ = chronicle_resume_task_lifecycle_instant(
        run_id,
        &task.task_id,
        "createdAt",
        &task.created_at,
    )?;
    if let Some(started_at) = task.started_at.as_deref() {
        let _ = chronicle_resume_task_lifecycle_instant(
            run_id,
            &task.task_id,
            "startedAt",
            started_at,
        )?;
    }
    if let Some(completed_at) = task.completed_at.as_deref() {
        let _ = chronicle_resume_task_lifecycle_instant(
            run_id,
            &task.task_id,
            "completedAt",
            completed_at,
        )?;
    }

    match task.status.as_str() {
        "completed" => {
            anyhow::ensure!(
                task.attempt_count > 0
                    && task.completed_at.is_some()
                    && task.lease_owner.is_none()
                    && task.lease_expires_at.is_none()
                    && task.heartbeat_at.is_none(),
                "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: completed Task '{}' has invalid lifecycle or lease coordinates",
                task.task_kind
            );
            let mut attempts = conn.prepare(
                "SELECT status, started_at, completed_at
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1 AND attempt_number = ?2",
            )?;
            let attempts = attempts
                .query_map(params![task.task_id, task.attempt_count], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            anyhow::ensure!(
                attempts.len() == 1,
                "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: completed Task '{}' must have exactly one current Attempt",
                task.task_kind
            );
            let (attempt_status, attempt_started_at, attempt_completed_at) =
                attempts.into_iter().next().ok_or_else(|| {
                    anyhow::anyhow!("unreachable checked completed Chronicle Attempt")
                })?;
            anyhow::ensure!(
                attempt_status == "completed" && attempt_completed_at.is_some(),
                "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: completed Task '{}' current Attempt is not completed",
                task.task_kind
            );
            parse_run_lifecycle_instant(&attempt_started_at).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: completed Task '{}' current Attempt has invalid startedAt: {error}",
                    task.task_kind
                )
            })?;
            parse_run_lifecycle_instant(
                attempt_completed_at
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("unreachable completed Attempt instant"))?,
            )
            .map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: completed Task '{}' current Attempt has invalid completedAt: {error}",
                    task.task_kind
                )
            })?;
        }
        "queued" => {
            anyhow::ensure!(
                task.completed_at.is_none()
                    && task.lease_owner.is_none()
                    && task.lease_expires_at.is_none()
                    && task.heartbeat_at.is_none(),
                "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: queued Task '{}' retains terminal or lease coordinates",
                task.task_kind
            );
        }
        "running" => {
            let owner = task.lease_owner.as_deref().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' has no lease owner",
                    task.task_kind
                )
            })?;
            anyhow::ensure!(
                !owner.trim().is_empty() && task.completed_at.is_none() && task.attempt_count > 0,
                "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' has invalid lease lifecycle",
                task.task_kind
            );
            let lease_expires_at = task.lease_expires_at.as_deref().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' has no lease expiry",
                    task.task_kind
                )
            })?;
            parse_run_lifecycle_instant(lease_expires_at).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' has invalid lease expiry: {error}",
                    task.task_kind
                )
            })?;
            let heartbeat_at = task.heartbeat_at.as_deref().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' has no heartbeat",
                    task.task_kind
                )
            })?;
            parse_run_lifecycle_instant(heartbeat_at).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' has invalid heartbeat: {error}",
                    task.task_kind
                )
            })?;

            let mut attempts = conn.prepare(
                "SELECT status, started_at, completed_at
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1 AND attempt_number = ?2",
            )?;
            let attempts = attempts
                .query_map(params![task.task_id, task.attempt_count], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            anyhow::ensure!(
                attempts.len() == 1,
                "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' must have exactly one current Attempt",
                task.task_kind
            );
            let (attempt_status, attempt_started_at, attempt_completed_at) = attempts
                .into_iter()
                .next()
                .ok_or_else(|| anyhow::anyhow!("unreachable checked current Chronicle Attempt"))?;
            anyhow::ensure!(
                attempt_status == "running" && attempt_completed_at.is_none(),
                "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' current Attempt is not running",
                task.task_kind
            );
            parse_run_lifecycle_instant(&attempt_started_at).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LEASE_INVALID: running Task '{}' current Attempt has invalid startedAt: {error}",
                    task.task_kind
                )
            })?;
        }
        _ => anyhow::bail!(
            "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Task '{}' has unsupported status '{}'",
            task.task_kind,
            task.status
        ),
    }
    Ok(())
}

pub(crate) fn load_verified_chronicle_snapshot_payload(
    conn: &Connection,
    run_id: &str,
) -> anyhow::Result<Value> {
    let mut statement = conn.prepare(
        "SELECT artifact.payload_storage, artifact.payload_json,
                artifact.payload_ref, artifact.payload_digest
           FROM narrative_extraction_tasks task
           JOIN narrative_extraction_attempts attempt
             ON attempt.task_id = task.id
            AND attempt.attempt_number = task.attempt_count
            AND attempt.status = 'completed'
           JOIN narrative_extraction_artifacts artifact
             ON artifact.run_id = task.run_id
            AND artifact.task_id = task.id
            AND artifact.attempt_id = attempt.id
            AND artifact.artifact_kind = 'source.snapshot@1'
          WHERE task.run_id = ?1
            AND task.task_kind = 'source.snapshot@1'
            AND task.status = 'completed'",
    )?;
    let payloads = statement
        .query_map(params![run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        payloads.len() == 1,
        "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: completed source.snapshot@1 requires exactly one current payload"
    );
    let (storage, payload, payload_ref, payload_digest) = payloads
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("unreachable checked Snapshot payload row"))?;
    anyhow::ensure!(
        storage == "inline-json" && payload_ref.is_none(),
        "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: source.snapshot@1 is not an inline-json artifact"
    );
    let payload = payload.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: source.snapshot@1 has no inline payload"
        )
    })?;
    let payload: Value = serde_json::from_str(&payload).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: source.snapshot@1 payload is malformed: {error}"
        )
    })?;
    anyhow::ensure!(
        payload_digest.as_deref() == Some(canonical_json_digest(&payload)?.as_str()),
        "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: source.snapshot@1 payloadDigest is not Native canonical JSON"
    );
    Ok(payload)
}

/// Load the exact Snapshot authority used by current Chronicle Apply. This is
/// stricter than merely parsing the artifact: it rechecks the Run seal, the
/// Task/Attempt output CAS, the canonical artifact digest, and every internal
/// document/snapshot digest before commit compilation may consume it.
pub(crate) fn load_verified_chronicle_snapshot_for_apply(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Value> {
    let (snapshot_digest, catalog_digest, scope_json): (Option<String>, Option<String>, String) =
        conn.query_row(
            "SELECT snapshot_digest, catalog_digest, scope_json
               FROM narrative_extraction_runs
              WHERE id = ?1 AND project_id = ?2",
            params![run_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    let snapshot_digest = snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: current Chronicle Run has no snapshotDigest"
        )
    })?;
    let catalog_digest = catalog_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_CATALOG_MISSING: current Chronicle Run has no catalogDigest"
        )
    })?;
    let scope_json: Value = serde_json::from_str(&scope_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: current Chronicle Run scope is malformed: {error}"
        )
    })?;
    let mut owner_statement = conn.prepare(
        "SELECT task.id, attempt.id, task.output_json, attempt.output_json,
                (SELECT COUNT(*)
                   FROM narrative_extraction_attempts current_attempt
                  WHERE current_attempt.task_id = task.id
                    AND current_attempt.attempt_number = task.attempt_count)
           FROM narrative_extraction_tasks task
           JOIN narrative_extraction_attempts attempt
             ON attempt.task_id = task.id
            AND attempt.attempt_number = task.attempt_count
            AND attempt.status = 'completed'
          WHERE task.run_id = ?1
            AND task.task_kind = 'source.snapshot@1'
            AND task.status = 'completed'",
    )?;
    let owners = owner_statement
        .query_map(params![run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        owners.len() == 1,
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: current Chronicle Apply requires exactly one completed Snapshot Task/current Attempt"
    );
    let (task_id, attempt_id, task_output_json, attempt_output_json, current_attempt_rows) = owners
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("unreachable checked Snapshot owner"))?;
    anyhow::ensure!(
        current_attempt_rows == 1,
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Snapshot Task current Attempt number is ambiguous"
    );
    let owned_artifact_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_artifacts
          WHERE run_id = ?1 AND task_id = ?2 AND attempt_id = ?3
            AND artifact_kind = 'source.snapshot@1'",
        params![run_id, task_id, attempt_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        owned_artifact_count == 1,
        "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: current Snapshot Task/Attempt does not own exactly one source.snapshot@1 artifact"
    );
    let task_output: Value = serde_json::from_str(&task_output_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: snapshot Task output is malformed: {error}"
        )
    })?;
    let attempt_output: Value = serde_json::from_str(&attempt_output_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: snapshot Attempt output is malformed: {error}"
        )
    })?;
    anyhow::ensure!(
        task_output == attempt_output,
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: snapshot Task and current Attempt outputs differ"
    );
    let payload = load_verified_chronicle_snapshot_payload(conn, run_id)?;
    let snapshot_inputs = validate_chronicle_resume_snapshot_inputs(
        &payload,
        project_id,
        run_id,
        &snapshot_digest,
        &catalog_digest,
        &scope_json,
    )?;
    validate_chronicle_resume_snapshot_output(
        &task_output,
        run_id,
        &snapshot_digest,
        &snapshot_inputs,
    )?;
    Ok(payload)
}

/// Proof that this transaction verified the one current Snapshot authority and
/// its sealed Existing Event Catalog for a current Chronicle Run. Fields stay
/// private so per-Proposal comparison cannot be called with an unbound marker.
pub(crate) struct VerifiedChronicleRevisionReviewAuthority {
    project_id: String,
    run_id: String,
}

/// Verify the Snapshot/catalog authority once per Decision or Commit coverage
/// transaction. Commit coverage may inspect many approved/rejected Proposals;
/// parsing and hashing the complete Snapshot for every row would hold the
/// `BEGIN IMMEDIATE` lock for O(P * snapshotBytes).
pub(crate) fn load_verified_chronicle_revision_review_authority(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<VerifiedChronicleRevisionReviewAuthority> {
    let snapshot = load_verified_chronicle_snapshot_for_apply(conn, project_id, run_id)?;
    let catalog = snapshot
        .get("existingEventsCatalog")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_CATALOG_MISSING: current Chronicle Run '{run_id}' Snapshot has no sealed existing Event catalog"
            )
        })?;
    let events = catalog
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_CATALOG_INVALID: current Chronicle Run '{run_id}' sealed Event catalog has no event roster"
            )
        })?;
    let mut event_refs = HashSet::with_capacity(events.len());
    for (index, event) in events.iter().enumerate() {
        let event = event.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_CATALOG_INVALID: current Chronicle Run '{run_id}' sealed Event catalog entry {index} is not an object"
            )
        })?;
        let event_ref = event.get("ref").and_then(Value::as_str).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_CATALOG_INVALID: current Chronicle Run '{run_id}' sealed Event catalog entry {index} has no ref"
            )
        })?;
        let event_title = event.get("title").and_then(Value::as_str).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_CATALOG_INVALID: current Chronicle Run '{run_id}' sealed Event catalog entry {index} has no title"
            )
        })?;
        anyhow::ensure!(
            !event_ref.trim().is_empty() && !event_title.trim().is_empty(),
            "NEX_CHRONICLE_RESUME_CATALOG_INVALID: current Chronicle Run '{run_id}' sealed Event catalog entry {index} has an empty ref/title"
        );
        anyhow::ensure!(
            event_refs.insert(event_ref),
            "NEX_CHRONICLE_RESUME_CATALOG_INVALID: current Chronicle Run '{run_id}' sealed Event catalog has duplicate ref '{event_ref}'"
        );
    }
    Ok(VerifiedChronicleRevisionReviewAuthority {
        project_id: project_id.to_string(),
        run_id: run_id.to_string(),
    })
}

/// Re-evaluate one current reviewed Chronicle title against the immutable plan
/// after the transaction has verified its Snapshot/catalog authority. The
/// plan match describes revision 1; Human review may append a later revision,
/// so Decision/Prepare/Apply must not continue treating a changed title as
/// `none`.
///
/// Any raw title change from the sealed plan is classified conservatively as
/// probable-duplicate. Native deliberately does not reinterpret unchanged
/// titles with a second Unicode normalizer: renderer/Native lowercasing cannot
/// be assumed byte-for-byte equivalent, while the sealed plan already owns the
/// unchanged title's match result.
pub(crate) fn current_chronicle_revision_requires_probable_duplicate_review(
    conn: &Connection,
    authority: &VerifiedChronicleRevisionReviewAuthority,
    proposal_set_id: &str,
    proposal_id: &str,
    revision_id: &str,
    sealed_planned_title: &str,
) -> anyhow::Result<bool> {
    let revision_payload: Option<String> = conn
        .query_row(
            "SELECT revision.payload_json
               FROM narrative_proposals proposal
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_proposal_revisions revision
                 ON revision.id = ?1
                AND revision.proposal_id = proposal.id
              WHERE proposal.id = ?2
                AND proposal.current_revision_id = revision.id
                AND proposal.proposal_set_id = ?3
                AND proposal.kind = ?4
                AND proposal_set.run_id = ?5
                AND proposal_set.project_id = ?6",
            params![
                revision_id,
                proposal_id,
                proposal_set_id,
                CHRONICLE_EVENT_PROPOSAL_KIND,
                authority.run_id,
                authority.project_id,
            ],
            |row| row.get(0),
        )
        .optional()?;
    let revision_payload = revision_payload.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_PROPOSAL_REVISION_MISMATCH: current Chronicle proposal '{proposal_id}' does not own revision '{revision_id}'"
        )
    })?;
    let revision_payload: Value = serde_json::from_str(&revision_payload).map_err(|error| {
        anyhow::anyhow!(
            "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal '{proposal_id}' revision payload is malformed: {error}"
        )
    })?;
    validate_chronicle_scene_event_proposal_payload(&revision_payload).map_err(|error| {
        anyhow::anyhow!(
            "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal '{proposal_id}' revision payload is invalid: {error}"
        )
    })?;
    let title = revision_payload
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal '{proposal_id}' revision title is missing"
            )
        })?;
    Ok(title != sealed_planned_title)
}

fn validate_chronicle_resume_snapshot_inputs(
    payload: &Value,
    project_id: &str,
    run_id: &str,
    snapshot_digest: &str,
    catalog_digest: &str,
    scope_json: &Value,
) -> anyhow::Result<ChronicleResumeSnapshotInputs> {
    let snapshot_validation = super::scope_authority_runtime::validate_snapshot_authority_finish(
        payload,
        project_id,
        run_id,
        snapshot_digest,
        None,
    )?;
    let payload = payload.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' source.snapshot@1 payload must be an object"
        )
    })?;
    let snapshot = payload
        .get("snapshot")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot is missing"
            )
        })?;
    anyhow::ensure!(
        snapshot.get("digest").and_then(Value::as_str) == Some(snapshot_digest),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot digest differs from the Run"
    );
    let language = snapshot
        .get("language")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot language is missing"
            )
        })?;
    anyhow::ensure!(
        !language.is_empty() && language.trim() == language,
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot language is empty or padded"
    );
    let origin = snapshot
        .get("origin")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot origin is missing"
            )
        })?;
    anyhow::ensure!(
        origin.get("kind").and_then(Value::as_str) == Some("grimodex-project")
            && origin.get("projectId").and_then(Value::as_str) == Some(project_id),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot origin belongs to another project"
    );
    let documents = snapshot
        .get("documents")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot documents are missing"
            )
        })?;
    let source_views = payload
        .get("sourceViews")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' sourceViews are missing"
            )
        })?;
    let _ = source_views;
    let authority_documents = payload
        .get("scopeAuthorityDocuments")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' scopeAuthorityDocuments are missing"
            )
        })?;
    anyhow::ensure!(
        documents.len() == authority_documents.len(),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' scope authority roster does not cover every document"
    );
    let scope_scene_ids = scope_json
        .get("sceneIds")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("unreachable validated Chronicle scope"))?
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    anyhow::ensure!(
        documents.len() == scope_scene_ids.len(),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot document roster differs from ordered scopeJson.sceneIds"
    );
    let mut document_refs = HashSet::with_capacity(documents.len());
    let mut scope_authority_inputs = Vec::with_capacity(documents.len());
    for (index, ((document, authority), scope_scene_id)) in documents
        .iter()
        .zip(authority_documents.iter())
        .zip(scope_scene_ids.iter())
        .enumerate()
    {
        let document = document.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' document {index} is invalid"
            )
        })?;
        let authority = authority.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' authority document {index} is invalid"
            )
        })?;
        let document_ref = document.get("ref").and_then(Value::as_str).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' document {index} has no ref"
            )
        })?;
        let source_key = document
            .get("sourceKey")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' document {index} has no sourceKey"
                )
            })?;
        let document_origin = document
            .get("origin")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' document {index} has no origin"
                )
            })?;
        let node_id = document_origin
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' document {index} has no nodeId"
                )
            })?;
        let raw_story_key = match authority.get("rawStoryKey") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.clone()),
            _ => {
                anyhow::bail!(
                    "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' authority document {index} has an invalid rawStoryKey"
                );
            }
        };
        anyhow::ensure!(
            document_refs.insert(document_ref)
                && source_key == format!("project:scene:{node_id}")
                && document_origin.get("kind").and_then(Value::as_str) == Some("project-node")
                && document_origin.get("projectId").and_then(Value::as_str) == Some(project_id)
                && node_id == *scope_scene_id
                && authority.get("documentRef").and_then(Value::as_str) == Some(document_ref)
                && authority.get("sourceKey").and_then(Value::as_str) == Some(source_key),
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' document {index} authority differs from its sealed project Scene"
        );
        scope_authority_inputs.push(NarrativeScopeAuthorityDocumentInputV2 {
            document_ref: document_ref.to_string(),
            source_key: source_key.to_string(),
            raw_story_key,
        });
    }
    let scope_authority_composite_digest = if scope_authority_inputs.is_empty() {
        None
    } else {
        Some(
            build_narrative_scope_authority_basis_v2(
                project_id,
                run_id,
                snapshot_digest,
                &scope_authority_inputs,
            )?
            .digests
            .composite_digest,
        )
    };

    let Some(catalog) = payload.get("existingEventsCatalog") else {
        return Ok(ChronicleResumeSnapshotInputs {
            language: language.to_string(),
            existing_events_catalog: None,
            document_count: snapshot_validation.document_count,
            corpus_payload_digest: snapshot_validation.corpus_payload_digest,
            scope_authority_composite_digest,
        });
    };
    if catalog.is_null() {
        return Ok(ChronicleResumeSnapshotInputs {
            language: language.to_string(),
            existing_events_catalog: None,
            document_count: snapshot_validation.document_count,
            corpus_payload_digest: snapshot_validation.corpus_payload_digest,
            scope_authority_composite_digest,
        });
    }
    let catalog_object = catalog.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_CATALOG_INVALID: Run '{run_id}' existingEventsCatalog must be an object"
        )
    })?;
    anyhow::ensure!(
        catalog_object.len() == 2
            && catalog_object.get("kind").and_then(Value::as_str)
                == Some(CHRONICLE_EXISTING_EVENTS_CATALOG_KIND)
            && catalog_object.get("events").is_some_and(Value::is_array),
        "NEX_CHRONICLE_RESUME_CATALOG_INVALID: Run '{run_id}' existingEventsCatalog has an unsupported shape"
    );
    anyhow::ensure!(
        canonical_json_digest(catalog)? == catalog_digest,
        "NEX_CHRONICLE_RESUME_CATALOG_MISMATCH: Run '{run_id}' existingEventsCatalog differs from its sealed digest"
    );
    Ok(ChronicleResumeSnapshotInputs {
        language: language.to_string(),
        existing_events_catalog: Some(catalog.clone()),
        document_count: snapshot_validation.document_count,
        corpus_payload_digest: snapshot_validation.corpus_payload_digest,
        scope_authority_composite_digest,
    })
}

fn validate_chronicle_resume_snapshot_output(
    output_json: &Value,
    run_id: &str,
    snapshot_digest: &str,
    snapshot_inputs: &ChronicleResumeSnapshotInputs,
) -> anyhow::Result<()> {
    let output = output_json.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot Task output must be an object"
        )
    })?;
    anyhow::ensure!(
        output.get("snapshotDigest").and_then(Value::as_str) == Some(snapshot_digest),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot Task output differs from the Run digest"
    );
    anyhow::ensure!(
        output.get("documentCount").and_then(Value::as_u64)
            == u64::try_from(snapshot_inputs.document_count).ok(),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot Task documentCount differs from the sealed corpus"
    );
    anyhow::ensure!(
        output.get("corpusPayloadDigest").and_then(Value::as_str)
            == Some(snapshot_inputs.corpus_payload_digest.as_str()),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot Task corpusPayloadDigest differs from Native canonical JSON"
    );
    let output_composite_digest = output.get("scopeAuthorityCompositeDigest");
    match snapshot_inputs.scope_authority_composite_digest.as_deref() {
        Some(expected) => anyhow::ensure!(
            output_composite_digest.and_then(Value::as_str) == Some(expected),
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' snapshot Task scopeAuthorityCompositeDigest differs from its reconstructed basis"
        ),
        None => anyhow::ensure!(
            output_composite_digest.is_some_and(Value::is_null),
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{run_id}' empty snapshot Task must seal a null scopeAuthorityCompositeDigest"
        ),
    }
    Ok(())
}

/// Rebuild the exact catalog shape produced by the Chronicle product's fresh
/// start path.  The events table is the live authority: the durable Snapshot
/// catalog only proves what matching saw before the process stopped.
///
/// Keep the ORDER BY and every JSON field byte-compatible with the renderer
/// mapping in `ChronicleExtractDialog`.  In particular, the current product
/// matcher does not yet hydrate Scene/participant/provenance joins, so those
/// arrays are deliberately empty here as well.  Adding those authorities is a
/// future catalog-version change, not an implicit resume-time reinterpretation.
fn load_live_chronicle_existing_events_catalog(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Value> {
    let mut statement = conn.prepare(
        "SELECT id, title, note, version, start_time, end_time
           FROM events
          WHERE project_id = ?1
          ORDER BY ordinal ASC, id ASC",
    )?;
    let events = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .map(|row| {
            let (id, title, note, version, start_time, end_time) = row?;
            Ok(json!({
                "ref": id,
                "sourceKey": id,
                "title": title,
                "note": note,
                "version": version,
                "linkedDocumentSourceKeys": [],
                "participantEntityRefs": [],
                "startTime": start_time,
                "endTime": end_time,
                "digest": format!("sha256:{id}"),
                "applicationProvenanceKeys": [],
            }))
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({
        "kind": CHRONICLE_EXISTING_EVENTS_CATALOG_KIND,
        "events": events,
    }))
}

fn chronicle_live_catalog_matches_sealed(
    conn: &Connection,
    project_id: &str,
    sealed_catalog_digest: &str,
) -> anyhow::Result<bool> {
    let live_catalog = load_live_chronicle_existing_events_catalog(conn, project_id)?;
    Ok(canonical_json_digest(&live_catalog)? == sealed_catalog_digest)
}

/// Final in-transaction guard for every current Chronicle Task claim/finish.
/// Candidate discovery is advisory and can race a writer in another process;
/// this check runs under the same BEGIN IMMEDIATE that owns the Task mutation.
pub(crate) fn validate_current_chronicle_live_catalog(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<()> {
    if !current_chronicle_run_spec_for_run(conn, project_id, run_id)? {
        return Ok(());
    }
    let sealed_catalog_digest: Option<String> = conn.query_row(
        "SELECT catalog_digest
           FROM narrative_extraction_runs
          WHERE id = ?1 AND project_id = ?2",
        params![run_id, project_id],
        |row| row.get(0),
    )?;
    let sealed_catalog_digest = sealed_catalog_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RUN_SPEC_CATALOG_MISMATCH: current Chronicle Run '{run_id}' has no catalogDigest"
        )
    })?;
    anyhow::ensure!(
        chronicle_live_catalog_matches_sealed(conn, project_id, &sealed_catalog_digest)?,
        "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT: current Chronicle Event catalog differs from Run '{run_id}'"
    );
    Ok(())
}

fn build_chronicle_task_resume_candidate(
    conn: &Connection,
    row: ChronicleTaskResumeRunRow,
    now: DateTime<Utc>,
) -> anyhow::Result<Option<ChronicleTaskResumeCandidateRow>> {
    let spec_json: Value = serde_json::from_str(&row.spec_json_text).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RUN_SPEC_INVALID: Run '{}' specJson is malformed: {error}",
            row.run_id
        )
    })?;
    if !validate_current_chronicle_run_spec(
        CHRONICLE_EXTRACT_SURFACE_PATH,
        &spec_json,
        &row.spec_digest,
        row.catalog_digest.as_deref(),
    )? {
        return Ok(None);
    }
    anyhow::ensure!(
        row.run_kind == "interpretation",
        "NEX_CHRONICLE_RESUME_RUN_INVALID: current Chronicle Run '{}' is not interpretation-owned",
        row.run_id
    );
    let snapshot_digest = row.snapshot_digest.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING: current Chronicle Run '{}' has no snapshotDigest",
            row.run_id
        )
    })?;
    anyhow::ensure!(
        is_sha256_digest(snapshot_digest),
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING: current Chronicle Run '{}' snapshotDigest is invalid",
        row.run_id
    );
    let catalog_digest = row.catalog_digest.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RUN_SPEC_CATALOG_MISMATCH: current Chronicle Run '{}' has no catalogDigest",
            row.run_id
        )
    })?;
    let scope_json: Value = serde_json::from_str(&row.scope_json_text).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_SCOPE_INVALID: Run '{}' scopeJson is malformed: {error}",
            row.run_id
        )
    })?;
    validate_chronicle_resume_scope(&scope_json, &row.run_id)?;

    let created_at = chronicle_resume_lifecycle_instant(&row.run_id, "createdAt", &row.created_at)?;
    let started_at = row
        .started_at
        .as_deref()
        .map(|value| chronicle_resume_lifecycle_instant(&row.run_id, "startedAt", value))
        .transpose()?;
    anyhow::ensure!(
        row.completed_at.is_none(),
        "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: non-terminal Run '{}' has completedAt",
        row.run_id
    );
    match row.status.as_str() {
        "pending" => anyhow::ensure!(
            started_at.is_none(),
            "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: pending Run '{}' has startedAt",
            row.run_id
        ),
        "running" => {
            let started_at = started_at.ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: running Run '{}' has no startedAt",
                    row.run_id
                )
            })?;
            anyhow::ensure!(
                started_at >= created_at,
                "NEX_CHRONICLE_RESUME_LIFECYCLE_INVALID: running Run '{}' startedAt precedes createdAt",
                row.run_id
            );
        }
        _ => anyhow::bail!(
            "NEX_CHRONICLE_RESUME_RUN_INVALID: Run '{}' has unsupported candidate status '{}'",
            row.run_id,
            row.status
        ),
    }

    let proposal_set_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1",
        params![row.run_id],
        |result| result.get(0),
    )?;
    anyhow::ensure!(
        proposal_set_count == 0,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: incomplete current Chronicle Run '{}' already owns a ProposalSet",
        row.run_id
    );

    let tasks = load_chronicle_resume_tasks(conn, &row.run_id)?;
    let mut tasks_by_kind = HashMap::with_capacity(tasks.len());
    for task in tasks {
        validate_chronicle_resume_task_lifecycle(conn, &row.run_id, &task)?;
        let task_kind = task.task_kind.clone();
        anyhow::ensure!(
            CHRONICLE_EXTRACT_TASK_CHAIN.contains(&task_kind.as_str())
                && tasks_by_kind.insert(task_kind.clone(), task).is_none(),
            "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Run '{}' has an unknown or duplicate Task kind '{}'",
            row.run_id,
            task_kind
        );
    }
    anyhow::ensure!(
        tasks_by_kind.len() == CHRONICLE_EXTRACT_TASK_CHAIN.len()
            && CHRONICLE_EXTRACT_TASK_CHAIN
                .iter()
                .all(|task_kind| tasks_by_kind.contains_key(*task_kind)),
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Run '{}' does not contain the exact Chronicle DAG",
        row.run_id
    );

    let mut completed_task_kinds = Vec::new();
    let mut next_task_kind: Option<&str> = None;
    for task_kind in CHRONICLE_EXTRACT_TASK_CHAIN {
        let task = tasks_by_kind
            .get(task_kind)
            .ok_or_else(|| anyhow::anyhow!("unreachable checked Chronicle Task topology"))?;
        match task.status.as_str() {
            "completed" if next_task_kind.is_none() => {
                completed_task_kinds.push(task_kind.to_string());
            }
            "completed" => anyhow::bail!(
                "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Run '{}' has completed Task '{}' after an incomplete predecessor",
                row.run_id,
                task_kind
            ),
            "queued" if next_task_kind.is_none() => next_task_kind = Some(task_kind),
            "queued" => {}
            "running" if next_task_kind.is_none() => next_task_kind = Some(task_kind),
            "running" => anyhow::bail!(
                "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Run '{}' has a running Task after an incomplete predecessor",
                row.run_id
            ),
            _ => anyhow::bail!(
                "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: Run '{}' Task '{}' has unsupported status '{}'",
                row.run_id,
                task_kind,
                task.status
            ),
        }
    }
    let next_task_kind = next_task_kind.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: non-terminal Run '{}' has no incomplete Task",
            row.run_id
        )
    })?;
    let next_task = tasks_by_kind
        .get(next_task_kind)
        .ok_or_else(|| anyhow::anyhow!("unreachable checked next Chronicle Task"))?;
    if row.status == "pending" {
        anyhow::ensure!(
            completed_task_kinds.is_empty() && next_task.status == "queued",
            "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID: pending Run '{}' already started its DAG",
            row.run_id
        );
    }

    let _ = validate_chronicle_resume_artifacts(conn, &row.project_id, &row.run_id)?;

    let snapshot_complete = completed_task_kinds
        .first()
        .is_some_and(|task_kind| task_kind == "source.snapshot@1");
    let (language, existing_events_catalog, durable_blocked_code) = if snapshot_complete {
        let snapshot_task = tasks_by_kind
            .get("source.snapshot@1")
            .ok_or_else(|| anyhow::anyhow!("unreachable checked snapshot Task"))?;
        let (task_output_json, attempt_output_json): (String, String) = conn.query_row(
            "SELECT task.output_json, attempt.output_json
               FROM narrative_extraction_tasks task
               JOIN narrative_extraction_attempts attempt
                 ON attempt.task_id = task.id
                AND attempt.attempt_number = task.attempt_count
              WHERE task.id = ?1",
            params![snapshot_task.task_id],
            |result| Ok((result.get(0)?, result.get(1)?)),
        )?;
        let task_output_json: Value = serde_json::from_str(&task_output_json).map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{}' snapshot Task output is malformed: {error}",
                row.run_id
            )
        })?;
        let attempt_output_json: Value =
            serde_json::from_str(&attempt_output_json).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{}' snapshot Attempt output is malformed: {error}",
                    row.run_id
                )
            })?;
        anyhow::ensure!(
            task_output_json == attempt_output_json,
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Run '{}' snapshot Task and current Attempt outputs differ",
            row.run_id
        );
        let snapshot_payload = load_verified_chronicle_snapshot_payload(conn, &row.run_id)?;
        let snapshot_inputs = validate_chronicle_resume_snapshot_inputs(
            &snapshot_payload,
            &row.project_id,
            &row.run_id,
            snapshot_digest,
            catalog_digest,
            &scope_json,
        )?;
        validate_chronicle_resume_snapshot_output(
            &task_output_json,
            &row.run_id,
            snapshot_digest,
            &snapshot_inputs,
        )?;
        let blocked_code = if snapshot_inputs.existing_events_catalog.is_none() {
            Some("NEX_CHRONICLE_RESUME_CATALOG_MISSING")
        } else {
            (!chronicle_live_catalog_matches_sealed(conn, &row.project_id, catalog_digest)?)
                .then_some("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT")
        };
        (
            Some(snapshot_inputs.language),
            snapshot_inputs.existing_events_catalog,
            blocked_code,
        )
    } else {
        (None, None, Some("NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE"))
    };

    let lease_held = if next_task.status == "running" {
        let lease_expires_at = next_task
            .lease_expires_at
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("unreachable validated Chronicle lease"))?;
        let lease_expires_at = parse_run_lifecycle_instant(lease_expires_at).map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_LEASE_INVALID: Run '{}' next Task lease is invalid: {error}",
                row.run_id
            )
        })?;
        lease_expires_at >= now
    } else {
        false
    };
    // A live worker always wins over a durable recovery diagnosis. In
    // particular, Snapshot is necessarily incomplete while its first Attempt
    // is running; exposing that Run as discardable would cancel active work.
    let (availability, blocked_code) = if lease_held {
        ("lease-held", None)
    } else if let Some(blocked_code) = durable_blocked_code {
        ("blocked", Some(blocked_code))
    } else {
        ("ready", None)
    };
    let execution_mode = spec_json
        .get("executionMode")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("unreachable validated Chronicle executionMode"))?;
    let coordinator_contract_digest = spec_json
        .get("coordinatorContractDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("unreachable validated Chronicle contract digest"))?;
    let lifecycle_at = started_at.unwrap_or(created_at);
    let value = json!({
        "runId": row.run_id,
        "projectId": row.project_id,
        "status": row.status,
        "scopeJson": scope_json,
        "specJson": spec_json,
        "runSpecDigest": row.spec_digest,
        "snapshotDigest": snapshot_digest,
        "catalogDigest": catalog_digest,
        "executionMode": execution_mode,
        "coordinatorContractDigest": coordinator_contract_digest,
        "completedTaskKinds": completed_task_kinds,
        "nextTask": {
            "taskId": next_task.task_id,
            "taskKind": next_task.task_kind,
            "status": next_task.status,
            "leaseExpiresAt": next_task.lease_expires_at,
        },
        "availability": availability,
        "blockedCode": blocked_code,
        "language": language,
        "existingEventsCatalog": existing_events_catalog,
        "createdAt": row.created_at,
        "startedAt": row.started_at,
    });
    Ok(Some(ChronicleTaskResumeCandidateRow {
        run_id: value["runId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("unreachable candidate Run id"))?
            .to_string(),
        lifecycle_at,
        value,
    }))
}

/// List interrupted current Chronicle DAGs independently of Review restore.
/// Every current-contract row in the requested project is validated before
/// ordering or limiting, so a newer corrupt ledger cannot disappear behind a
/// SQL LIMIT and cause the product to create duplicate work.
pub fn list_chronicle_task_resume_candidates(
    db: &Database,
    payload: ListChronicleTaskResumeCandidatesPayload,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.project_id.is_empty() && payload.project_id.trim() == payload.project_id,
        "NEX_CHRONICLE_RESUME_CANDIDATE_REQUEST_INVALID: projectId must be non-empty and unpadded"
    );
    if let Some(limit) = payload.limit {
        anyhow::ensure!(
            (1..=100).contains(&limit),
            "NEX_CHRONICLE_RESUME_CANDIDATE_REQUEST_INVALID: limit must be between 1 and 100"
        );
    }
    let limit = payload.limit.unwrap_or(20) as usize;
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, project_id, run_kind, status, scope_json, spec_json, spec_digest,
                    snapshot_digest, catalog_digest, created_at, started_at, completed_at
               FROM narrative_extraction_runs
              WHERE project_id = ?1
                AND surface_path_id = ?2
                AND status IN ('pending', 'running')",
        )?;
        let rows = statement
            .query_map(
                params![payload.project_id, CHRONICLE_EXTRACT_SURFACE_PATH],
                decode_chronicle_task_resume_run_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let now = Utc::now();
        let mut candidates = Vec::new();
        for row in rows {
            if let Some(candidate) = build_chronicle_task_resume_candidate(conn, row, now)? {
                candidates.push(candidate);
            }
        }
        candidates.sort_by(|left, right| {
            right
                .lifecycle_at
                .cmp(&left.lifecycle_at)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });
        candidates.truncate(limit);
        Ok(json!(candidates
            .into_iter()
            .map(|candidate| candidate.value)
            .collect::<Vec<_>>()))
    })
}

fn validate_chronicle_blocked_discard_expectation(
    conn: &Connection,
    run_id: &str,
    project_id: &str,
    expectation: &ChronicleBlockedDiscardExpectation,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !expectation.next_task_id.is_empty()
            && expectation.next_task_id.trim() == expectation.next_task_id
            && expectation.blocked_code.starts_with("NEX_")
            && is_sha256_digest(&expectation.run_spec_digest)
            && is_sha256_digest(&expectation.snapshot_digest)
            && is_sha256_digest(&expectation.catalog_digest),
        "NEX_CHRONICLE_RESUME_DISCARD_EXPECTATION_INVALID: blocked discard expectation is malformed"
    );
    let row = conn
        .query_row(
            "SELECT id, project_id, run_kind, status, scope_json, spec_json, spec_digest,
                    snapshot_digest, catalog_digest, created_at, started_at, completed_at
               FROM narrative_extraction_runs
              WHERE id = ?1 AND project_id = ?2",
            params![run_id, project_id],
            decode_chronicle_task_resume_run_row,
        )
        .optional()?;
    let row = row.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_RESUME_DISCARD_STALE: exact Chronicle Run is no longer present"
        )
    })?;
    let candidate = build_chronicle_task_resume_candidate(conn, row, Utc::now())?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_DISCARD_STALE: Run is not a current Chronicle recovery candidate"
            )
        })?;
    let value = candidate.value;
    let current_availability = value["availability"].as_str();
    let current_blocked_code = value["blockedCode"].as_str();
    let current_next_task_id = value["nextTask"]["taskId"].as_str();
    let current_run_spec_digest = value["runSpecDigest"].as_str();
    let current_snapshot_digest = value["snapshotDigest"].as_str();
    let current_catalog_digest = value["catalogDigest"].as_str();
    anyhow::ensure!(
        current_availability == Some("blocked")
            && current_blocked_code == Some(expectation.blocked_code.as_str())
            && current_next_task_id == Some(expectation.next_task_id.as_str())
            && current_run_spec_digest == Some(expectation.run_spec_digest.as_str())
            && current_snapshot_digest == Some(expectation.snapshot_digest.as_str())
            && current_catalog_digest == Some(expectation.catalog_digest.as_str()),
        "NEX_CHRONICLE_RESUME_DISCARD_STALE: Chronicle Run is no longer the exact blocked candidate selected by the product"
    );
    Ok(())
}

pub fn cancel_run_with_expectation(
    db: &Database,
    run_id: String,
    project_id: String,
    chronicle_blocked_discard: Option<ChronicleBlockedDiscardExpectation>,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &run_id, &project_id)?;
            ensure_generic_task_api_allowed(conn, &run_id)?;
            if let Some(expectation) = chronicle_blocked_discard.as_ref() {
                validate_chronicle_blocked_discard_expectation(
                    conn,
                    &run_id,
                    &project_id,
                    expectation,
                )?;
            }
            let lifecycle_at = next_run_lifecycle_timestamp_in_tx(conn, &project_id)?;
            let updated = conn.execute(
                "UPDATE narrative_extraction_runs
                    SET status = 'cancelled',
                        completed_at = ?2,
                        version = version + 1
                  WHERE id = ?1
                    AND status IN ('pending', 'running')",
                params![run_id, lifecycle_at],
            )?;
            anyhow::ensure!(updated == 1, "run is not cancellable");

            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'cancelled',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = ?2,
                        version = version + 1
                  WHERE run_id = ?1
                    AND status IN ('queued', 'running')",
                params![run_id, lifecycle_at],
            )?;

            // Attempts do not own a `cancelled` status. Preserve every
            // already-terminal Attempt, but close all running executions for
            // this Run with the canonical non-retryable cancellation policy.
            // This includes older Attempts left running by lease reclaim.
            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed',
                        completed_at = ?2,
                        error_message = ?3,
                        failure_code = ?4,
                        retry_disposition = 'terminal',
                        policy_version = ?5,
                        next_attempt_at = NULL
                  WHERE status = 'running'
                    AND task_id IN (
                      SELECT id
                        FROM narrative_extraction_tasks
                       WHERE run_id = ?1
                    )",
                params![
                    run_id,
                    lifecycle_at,
                    RUN_CANCELLED_ATTEMPT_ERROR_MESSAGE,
                    RUN_CANCELLED_ATTEMPT_FAILURE_CODE,
                    RUN_CANCELLED_ATTEMPT_POLICY_VERSION,
                ],
            )?;

            Ok(json!({ "runId": run_id, "status": "cancelled" }))
        })
    })
}

#[cfg(test)]
pub fn cancel_run(db: &Database, run_id: String, project_id: String) -> anyhow::Result<Value> {
    cancel_run_with_expectation(db, run_id, project_id, None)
}

pub fn claim_task(
    db: &Database,
    payload: super::models::ClaimTaskPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            ensure_generic_task_api_allowed(conn, &payload.run_id)?;
            validate_current_chronicle_claim_prefix(
                conn,
                &payload.project_id,
                &payload.run_id,
                payload.task_kinds.as_deref(),
            )?;
            validate_current_chronicle_live_catalog(conn, &payload.project_id, &payload.run_id)?;
            let claimed = claim_next_task(conn, &payload)?;
            Ok(match claimed {
                Some(task) => json!({
                    "claimed": true,
                    "task": claimed_task_to_value(&task),
                }),
                None => json!({ "claimed": false }),
            })
        })
    })
}

/// Current Chronicle Runs are sequential even though the generic task API can
/// select an arbitrary kind.  Require the coordinator to claim the sole next
/// durable prefix task; this closes the public-IPC path that could otherwise
/// lease plan-proposals before its inputs existed.
fn validate_current_chronicle_claim_prefix(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    requested_task_kinds: Option<&[String]>,
) -> anyhow::Result<()> {
    if !current_chronicle_run_spec_for_run(conn, project_id, run_id)? {
        return Ok(());
    }
    let mut statement = conn.prepare(
        "SELECT task_kind, status
           FROM narrative_extraction_tasks
          WHERE run_id = ?1",
    )?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut statuses = HashMap::with_capacity(rows.len());
    for (task_kind, status) in rows {
        anyhow::ensure!(
            statuses.insert(task_kind.clone(), status).is_none(),
            "NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID: current Chronicle Run duplicates task kind '{task_kind}'"
        );
    }
    anyhow::ensure!(
        statuses.len() == CHRONICLE_EXTRACT_TASK_CHAIN.len()
            && CHRONICLE_EXTRACT_TASK_CHAIN
                .iter()
                .all(|kind| statuses.contains_key(*kind)),
        "NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID: current Chronicle Run does not contain the exact production task DAG"
    );
    let mut encountered_incomplete = false;
    for task_kind in CHRONICLE_EXTRACT_TASK_CHAIN {
        let status = statuses
            .get(task_kind)
            .map(String::as_str)
            .ok_or_else(|| anyhow::anyhow!("unreachable checked Chronicle task topology"))?;
        match status {
            "completed" => {
                anyhow::ensure!(
                    !encountered_incomplete,
                    "NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID: current Chronicle Run has a completed Task after an incomplete predecessor"
                );
            }
            "queued" => {
                encountered_incomplete = true;
            }
            "running" => {
                anyhow::ensure!(
                    !encountered_incomplete,
                    "NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID: current Chronicle Run has a running Task after an incomplete predecessor"
                );
                encountered_incomplete = true;
            }
            _ => anyhow::bail!(
                "NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID: current Chronicle Run task '{task_kind}' has unsupported status '{status}'"
            ),
        }
    }
    let next_kind = CHRONICLE_EXTRACT_TASK_CHAIN.iter().find(|task_kind| {
        statuses
            .get(**task_kind)
            .map(String::as_str)
            .is_some_and(|status| status != "completed")
    });
    let Some(next_kind) = next_kind else {
        return Ok(());
    };
    let requested_task_kinds = requested_task_kinds.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_CLAIM_KIND_REQUIRED: current Chronicle Run claims must name the next sealed DAG task"
        )
    })?;
    anyhow::ensure!(
        requested_task_kinds.len() == 1 && requested_task_kinds[0] == *next_kind,
        "NEX_CHRONICLE_CLAIM_PREDECESSOR_INCOMPLETE: current Chronicle Run may only claim next task '{next_kind}'"
    );
    Ok(())
}

/// A public claim API can select an arbitrary task kind.  Chronicle's plan
/// task is terminal, so accepting it before the preceding DAG prefix is
/// durable would let a stale/empty review ledger survive a later resume.
/// Check this before FinishTask changes the Task, Attempt, artifacts, or
/// ProposalSet; the immediate transaction then rolls back entirely on error.
fn validate_chronicle_plan_predecessors_completed(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<()> {
    let mut statement = conn.prepare(
        "SELECT task_kind, status
           FROM narrative_extraction_tasks
          WHERE run_id = ?1",
    )?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut statuses = HashMap::with_capacity(rows.len());
    for (task_kind, status) in rows {
        anyhow::ensure!(
            statuses.insert(task_kind.clone(), status).is_none(),
            "NEX_CHRONICLE_PLAN_TOPOLOGY_INVALID: current Chronicle Run duplicates task kind '{task_kind}'"
        );
    }
    anyhow::ensure!(
        statuses.len() == CHRONICLE_EXTRACT_TASK_CHAIN.len()
            && CHRONICLE_EXTRACT_TASK_CHAIN
                .iter()
                .all(|kind| statuses.contains_key(*kind)),
        "NEX_CHRONICLE_PLAN_TOPOLOGY_INVALID: current Chronicle Run does not contain the exact production task DAG"
    );
    for task_kind in CHRONICLE_PLAN_PREDECESSOR_TASK_KINDS {
        anyhow::ensure!(
            statuses.get(task_kind).map(String::as_str) == Some("completed"),
            "NEX_CHRONICLE_PLAN_PREDECESSOR_INCOMPLETE: terminal Chronicle plan requires completed predecessor '{task_kind}'"
        );
    }
    // The `project_id` is intentionally part of the helper boundary even
    // though ensure_run_project already ran: this makes a future direct call
    // fail closed rather than treating an unowned Run as a valid prefix.
    ensure_run_project(conn, run_id, project_id)?;
    Ok(())
}

fn validate_chronicle_plan_proposal_set_finish_input(
    conn: &Connection,
    payload: &FinishTaskPayload,
    output_json: &Value,
) -> anyhow::Result<()> {
    let task_kind: String = conn.query_row(
        "SELECT task_kind FROM narrative_extraction_tasks WHERE id = ?1 AND run_id = ?2",
        params![payload.task_id, payload.run_id],
        |row| row.get(0),
    )?;
    let current_chronicle_spec =
        current_chronicle_run_spec_for_run(conn, &payload.project_id, &payload.run_id)?;
    if !current_chronicle_spec || task_kind != CHRONICLE_PLAN_TASK_KIND {
        anyhow::ensure!(
            payload.chronicle_plan_proposal_set.is_none(),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_FORBIDDEN: typed Chronicle ProposalSet finish is only valid for the current Chronicle plan Task"
        );
        return Ok(());
    }

    let finish = payload.chronicle_plan_proposal_set.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_REQUIRED: current Chronicle plan Task must terminalize its ProposalSet in the same transaction"
        )
    })?;
    validate_chronicle_plan_predecessors_completed(conn, &payload.project_id, &payload.run_id)?;
    let proposal_set = &finish.proposal_set;
    anyhow::ensure!(
        proposal_set.run_id == payload.run_id && proposal_set.project_id == payload.project_id,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_IDENTITY_MISMATCH: typed ProposalSet Run/Project differs from finishing Task"
    );
    anyhow::ensure!(
        proposal_set.set_kind == CHRONICLE_PROPOSAL_SET_KIND,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_KIND_INVALID: Chronicle plan must persist chronicle.extract.review@1"
    );
    let expected_set_id = chronicle_plan_proposal_set_id(&payload.run_id, &payload.task_id);
    anyhow::ensure!(
        proposal_set.proposal_set_id.as_deref() == Some(expected_set_id.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ID_INVALID: typed ProposalSet id is not the deterministic Run/Task owner id"
    );
    if let Some(summary) = proposal_set.summary_json.as_ref() {
        let object = summary.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_SUMMARY_INVALID: summaryJson must be an object"
            )
        })?;
        anyhow::ensure!(
            !object.contains_key(CHRONICLE_PLAN_BINDING_FIELD),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_SUMMARY_INVALID: Native owns chroniclePlanTaskBinding"
        );
    }

    let output = output_json.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_OUTPUT_INVALID: plan Task output must be an object"
        )
    })?;
    anyhow::ensure!(
        output.get("proposalSetId").and_then(Value::as_str) == Some(expected_set_id.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_OUTPUT_INVALID: output proposalSetId does not bind the deterministic ProposalSet"
    );
    anyhow::ensure!(
        output.get("proposalCount").and_then(Value::as_u64)
            == Some(proposal_set.proposals.len() as u64),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_OUTPUT_INVALID: output proposalCount does not match typed ProposalSet"
    );

    let plan_artifacts = payload
        .artifacts
        .iter()
        .filter(|artifact| artifact.artifact_kind == CHRONICLE_PLAN_ARTIFACT_KIND)
        .collect::<Vec<_>>();
    anyhow::ensure!(
        plan_artifacts.len() == 1,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: plan Task requires exactly one chronicle.proposal-plan@1 artifact"
    );
    let artifact = plan_artifacts[0];
    anyhow::ensure!(
        artifact.payload_storage.as_deref().unwrap_or("inline-json") == "inline-json"
            && artifact.payload_ref.is_none(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan must be an inline-json artifact"
    );
    let artifact_payload = artifact.payload_json.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan has no payloadJson"
        )
    })?;
    let artifact_object = artifact_payload.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan payload must be an object"
        )
    })?;
    anyhow::ensure!(
        artifact_object.get("proposalSetId").and_then(Value::as_str) == Some(expected_set_id.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan does not bind the deterministic ProposalSet"
    );
    let artifact_proposals = artifact_object
        .get("proposals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan proposals must be an array"
            )
        })?;
    anyhow::ensure!(
        artifact_proposals.len() == proposal_set.proposals.len(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan and typed ProposalSet have different counts"
    );
    let mut proposal_keys = HashSet::new();
    for (index, (artifact_proposal, saved_proposal)) in artifact_proposals
        .iter()
        .zip(proposal_set.proposals.iter())
        .enumerate()
    {
        let event_id = artifact_proposal
            .get("eventId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan entry {index} has no eventId"
                )
            })?;
        let expected_key = format!("{event_id}:{index}");
        anyhow::ensure!(
            saved_proposal.proposal_key == expected_key
                && saved_proposal.kind == CHRONICLE_EVENT_PROPOSAL_KIND,
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: typed ProposalSet proposal {index} is not the exact plan payload row"
        );
        anyhow::ensure!(
            proposal_keys.insert(saved_proposal.proposal_key.as_str()),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: duplicate proposalKey in typed ProposalSet"
        );
        validate_chronicle_scene_event_proposal_payload(artifact_proposal).map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan entry {index} is invalid: {error}"
            )
        })?;
        anyhow::ensure!(
            canonical_json_digest(artifact_proposal)?
                == canonical_json_digest(&saved_proposal.payload_json)?,
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: typed ProposalSet payload differs from proposal plan entry {index}"
        );
    }
    // Fresh review projection prefers `planned[].proposal` when the planner
    // supplied presentation/match metadata.  It must therefore be another
    // exact view of the terminal `proposals[]` roster, never an independently
    // mutable payload paired with a saved Proposal revision id.
    if let Some(planned_value) = artifact_object.get("planned") {
        let planned = planned_value.as_array().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan planned must be an array"
            )
        })?;
        anyhow::ensure!(
            planned.len() == artifact_proposals.len(),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan planned roster differs from proposals"
        );
        for (index, (planned_row, artifact_proposal)) in
            planned.iter().zip(artifact_proposals.iter()).enumerate()
        {
            let planned_object = planned_row.as_object().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan planned entry {index} is not an object"
                )
            })?;
            let planned_proposal = planned_object.get("proposal").ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan planned entry {index} has no proposal"
                )
            })?;
            let event_id = planned_proposal
                .get("eventId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan planned entry {index} has no proposal eventId"
                    )
                })?;
            let expected_key = format!("{event_id}:{index}");
            anyhow::ensure!(
                proposal_set.proposals[index].proposal_key == expected_key
                    && canonical_json_digest(planned_proposal)?
                        == canonical_json_digest(artifact_proposal)?,
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID: proposal plan planned entry {index} differs from the typed ProposalSet proposal"
            );
        }
    }
    Ok(())
}

/// Load the exact proposal-plan artifact emitted by the current terminal
/// Task/Attempt and prove its stored digest still describes its full canonical
/// payload.  The immutable terminal manifest carries this digest so both the
/// proposal roster and planner-facing `planned` metadata are sealed against
/// post-commit rewrites.
fn load_chronicle_plan_artifact_payload(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
) -> anyhow::Result<(Value, String)> {
    let mut statement = conn.prepare(
        "SELECT payload_storage, payload_json, payload_digest
           FROM narrative_extraction_artifacts
          WHERE run_id = ?1 AND task_id = ?2 AND attempt_id = ?3
            AND artifact_kind = ?4
          ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement
        .query_map(
            params![run_id, task_id, attempt_id, CHRONICLE_PLAN_ARTIFACT_KIND],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        rows.len() == 1,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: owner Task requires exactly one current proposal-plan artifact"
    );
    let (storage, artifact_json, artifact_digest) = rows
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("unreachable checked proposal-plan artifact row"))?;
    anyhow::ensure!(
        storage == "inline-json",
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact is not inline-json"
    );
    let artifact_value: Value = artifact_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact has no payload"
            )
        })?;
    let expected_digest = canonical_json_digest(&artifact_value)?;
    anyhow::ensure!(
        artifact_digest.as_deref() == Some(expected_digest.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact payloadDigest is not Native canonical JSON"
    );
    Ok((artifact_value, expected_digest))
}

/// Reconstruct the immutable ProposalKey -> match metadata roster sealed by
/// the current Chronicle plan Task. Commit validation uses this instead of a
/// renderer-supplied duplicate choice, so a probable duplicate cannot be
/// promoted by appending a bare `approved` Decision through a lower-level API.
#[derive(Debug, Clone)]
pub(crate) struct CurrentChronicleProposalPlanAuthority {
    pub(crate) match_value: Value,
    pub(crate) planned_title: String,
}

pub(crate) fn load_current_chronicle_proposal_matches(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    proposal_set_id: &str,
) -> anyhow::Result<HashMap<String, CurrentChronicleProposalPlanAuthority>> {
    let mut coordinate_statement = conn.prepare(
        "SELECT task_id, attempt_id
           FROM narrative_extraction_artifacts
          WHERE run_id = ?1 AND artifact_kind = ?2
          ORDER BY created_at ASC, id ASC",
    )?;
    let coordinates = coordinate_statement
        .query_map(params![run_id, CHRONICLE_PLAN_ARTIFACT_KIND], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        coordinates.len() == 1,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: current Chronicle Apply requires exactly one durable proposal-plan artifact"
    );
    let (task_id, attempt_id) = coordinates
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("unreachable checked proposal-plan coordinate"))?;
    let task_id = task_id.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact has no Task owner"
        )
    })?;
    let attempt_id = attempt_id.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact has no Attempt owner"
        )
    })?;
    let validated_set_id = validate_chronicle_plan_proposal_set_binding_for_resume(
        conn,
        project_id,
        run_id,
        &task_id,
        &attempt_id,
    )?;
    anyhow::ensure!(
        validated_set_id == proposal_set_id,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native terminal plan binding does not own the Commit ProposalSet"
    );
    let (artifact, _) = load_chronicle_plan_artifact_payload(conn, run_id, &task_id, &attempt_id)?;
    anyhow::ensure!(
        artifact.get("proposalSetId").and_then(Value::as_str) == Some(proposal_set_id),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact does not bind the Commit ProposalSet"
    );
    let proposals = artifact
        .get("proposals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact has no proposal roster"
            )
        })?;
    let planned = artifact
        .get("planned")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: current Chronicle proposal-plan artifact has no planned match roster"
            )
        })?;
    anyhow::ensure!(
        planned.len() == proposals.len(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: planned match roster differs from proposal roster"
    );

    let mut matches = HashMap::with_capacity(planned.len());
    for (index, (planned_row, proposal)) in planned.iter().zip(proposals.iter()).enumerate() {
        let planned_proposal = planned_row.get("proposal").ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: planned entry {index} has no proposal"
            )
        })?;
        anyhow::ensure!(
            canonical_json_digest(planned_proposal)? == canonical_json_digest(proposal)?,
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: planned entry {index} proposal differs from the sealed proposal roster"
        );
        let event_id = proposal.get("eventId").and_then(Value::as_str).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan entry {index} has no eventId"
            )
        })?;
        let planned_title = planned_proposal
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: planned entry {index} has no title authority"
                )
            })?;
        let proposal_key = format!("{event_id}:{index}");
        let match_value = planned_row.get("match").cloned().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: planned entry {index} has no match metadata"
            )
        })?;
        anyhow::ensure!(
            matches
                .insert(
                    proposal_key,
                    CurrentChronicleProposalPlanAuthority {
                        match_value,
                        planned_title: planned_title.to_string(),
                    },
                )
                .is_none(),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: planned match roster has a duplicate proposalKey"
        );
    }
    Ok(matches)
}

fn load_chronicle_plan_proposal_manifest(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    proposal_set_id: &str,
    reject_existing_binding: bool,
) -> anyhow::Result<Value> {
    let (set_kind, summary_json): (String, String) = conn.query_row(
        "SELECT set_kind, summary_json
           FROM narrative_proposal_sets
          WHERE id = ?1 AND run_id = ?2 AND project_id = ?3",
        params![proposal_set_id, run_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    anyhow::ensure!(
        set_kind == CHRONICLE_PROPOSAL_SET_KIND,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted ProposalSet kind is not Chronicle review"
    );
    let mut summary: Value = serde_json::from_str(&summary_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted ProposalSet summaryJson is malformed: {error}"
        )
    })?;
    let summary_object = summary.as_object_mut().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted ProposalSet summaryJson is not an object"
        )
    })?;
    let existing_binding = summary_object.remove(CHRONICLE_PLAN_BINDING_FIELD);
    anyhow::ensure!(
        !reject_existing_binding || existing_binding.is_none(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native plan binding already existed before terminal persistence"
    );

    let mut statement = conn.prepare(
        "SELECT p.proposal_key, p.kind, r.payload_json,
                r.reconciliation_envelope_json, r.reconciliation_envelope_digest
           FROM narrative_proposals p
           JOIN narrative_proposal_revisions r
             ON r.proposal_id = p.id AND r.revision_number = 1
          WHERE p.proposal_set_id = ?1
          ORDER BY p.proposal_key ASC",
    )?;
    let rows = statement
        .query_map(params![proposal_set_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut proposals = Vec::with_capacity(rows.len());
    let mut validation_seeds = Vec::with_capacity(rows.len());
    for (proposal_key, kind, payload_json, envelope_json, envelope_digest) in rows {
        anyhow::ensure!(
            kind == CHRONICLE_EVENT_PROPOSAL_KIND,
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted ProposalSet has a non-Chronicle proposal kind"
        );
        let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted Proposal payload is malformed: {error}"
            )
        })?;
        validate_chronicle_scene_event_proposal_payload(&payload).map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted Proposal payload is invalid: {error}"
            )
        })?;
        let envelope = envelope_json
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted reconciliation Envelope is malformed: {error}"
                )
            })?;
        match (&envelope, envelope_digest.as_deref()) {
            (Some(envelope), Some(digest)) => anyhow::ensure!(
                canonical_json_digest(envelope)? == digest,
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted reconciliation Envelope digest is invalid"
            ),
            (None, None) => {}
            _ => anyhow::bail!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted reconciliation Envelope/digest presence differs"
            ),
        }
        validation_seeds.push(ProposalSeed {
            proposal_id: None,
            proposal_key: proposal_key.clone(),
            kind: kind.clone(),
            payload_json: payload.clone(),
            reconciliation_envelope: envelope.clone(),
        });
        proposals.push(json!({
            "proposalKey": proposal_key,
            "kind": kind,
            "payloadJson": payload,
            "reconciliationEnvelope": envelope,
            "reconciliationEnvelopeDigest": envelope_digest,
        }));
    }
    // Re-run the durable receipt roster validation on read.  The manifest
    // binds its exact summary bytes, while this rejects a roster that still
    // hashes consistently but no longer refers to verified C1 receipts.
    let prepared_summary = super::stage_provenance::prepare_chronicle_v2_proposal_set_summary(
        conn,
        project_id,
        run_id,
        Some(&summary),
        &validation_seeds,
    )?;
    anyhow::ensure!(
        canonical_json_digest(&prepared_summary)? == canonical_json_digest(&summary)?,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted ProposalSet summary is not the Native canonical receipt summary"
    );
    let (_, proposal_plan_artifact_digest) =
        load_chronicle_plan_artifact_payload(conn, run_id, task_id, attempt_id)?;
    Ok(json!({
        "kind": CHRONICLE_PLAN_MANIFEST_KIND,
        "version": 1,
        "projectId": project_id,
        "runId": run_id,
        "taskId": task_id,
        "attemptId": attempt_id,
        "proposalSetId": proposal_set_id,
        "setKind": set_kind,
        "summaryJson": summary,
        "proposalPlanArtifactDigest": proposal_plan_artifact_digest,
        "proposals": proposals,
    }))
}

fn save_chronicle_plan_proposal_set_in_tx(
    conn: &Connection,
    payload: &FinishTaskPayload,
    finish: &ChroniclePlanProposalSetFinish,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    // Match the generic ProposalSet writer's policy boundary.  A Run may have
    // begun while extraction was allowed, but its terminal review ledger must
    // not bypass a later Native runtime disable merely because it is composed
    // into FinishTask's transaction.
    require_narrative_extraction_allowed(conn)?;
    let proposal_set_id = finish
        .proposal_set
        .proposal_set_id
        .as_deref()
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_CHRONICLE_PLAN_PROPOSAL_SET_ID_INVALID: proposalSetId is required")
        })?;
    let saved = save_proposal_set_in_tx(conn, &finish.proposal_set, validation_owner)?;
    let proposal_set_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1 AND project_id = ?2",
        params![payload.run_id, payload.project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        proposal_set_count == 1,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_AMBIGUOUS: Chronicle Run must have exactly one ProposalSet"
    );
    let manifest = load_chronicle_plan_proposal_manifest(
        conn,
        &payload.project_id,
        &payload.run_id,
        &payload.task_id,
        &payload.attempt_id,
        proposal_set_id,
        true,
    )?;
    let manifest_digest = canonical_json_digest(&manifest)?;
    let summary_json: String = conn.query_row(
        "SELECT summary_json FROM narrative_proposal_sets WHERE id = ?1",
        params![proposal_set_id],
        |row| row.get(0),
    )?;
    let mut summary: Value = serde_json::from_str(&summary_json)?;
    let summary_object = summary.as_object_mut().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: persisted ProposalSet summaryJson is not an object"
        )
    })?;
    summary_object.insert(
        CHRONICLE_PLAN_BINDING_FIELD.to_string(),
        json!({
            "kind": CHRONICLE_PLAN_BINDING_KIND,
            "version": 1,
            "taskId": payload.task_id,
            "attemptId": payload.attempt_id,
            "proposalSetId": proposal_set_id,
            "proposalManifestDigest": manifest_digest,
        }),
    );
    conn.execute(
        "UPDATE narrative_proposal_sets
            SET summary_json = ?1, updated_at = datetime('now'), version = version + 1
          WHERE id = ?2 AND run_id = ?3 AND project_id = ?4",
        params![
            serde_json::to_string(&summary)?,
            proposal_set_id,
            payload.run_id,
            payload.project_id,
        ],
    )?;
    validate_chronicle_plan_proposal_set_binding_for_resume(
        conn,
        &payload.project_id,
        &payload.run_id,
        &payload.task_id,
        &payload.attempt_id,
    )?;
    Ok(saved)
}

fn validate_chronicle_plan_proposal_set_binding_for_resume(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
) -> anyhow::Result<String> {
    struct PlanOwnerState {
        summary_json: String,
        output_json: Option<String>,
        status: String,
        task_kind: String,
        attempt_count: i64,
        attempt_output_json: Option<String>,
        attempt_status: Option<String>,
        attempt_number: Option<i64>,
        current_attempt_rows: i64,
    }

    let proposal_set_id = chronicle_plan_proposal_set_id(run_id, task_id);
    let proposal_set_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1 AND project_id = ?2",
        params![run_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        proposal_set_count == 1,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_AMBIGUOUS: Chronicle Run must have exactly one ProposalSet"
    );
    let owner = conn.query_row(
        "SELECT s.summary_json, t.output_json, t.status, t.task_kind,
                t.attempt_count, a.output_json, a.status, a.attempt_number,
                (SELECT COUNT(*)
                   FROM narrative_extraction_attempts current_attempt
                  WHERE current_attempt.task_id = t.id
                    AND current_attempt.attempt_number = t.attempt_count)
           FROM narrative_proposal_sets s
           JOIN narrative_extraction_tasks t ON t.id = ?1 AND t.run_id = ?2
           LEFT JOIN narrative_extraction_attempts a
             ON a.id = ?5 AND a.task_id = t.id
          WHERE s.id = ?3 AND s.run_id = ?2 AND s.project_id = ?4",
        params![task_id, run_id, proposal_set_id, project_id, attempt_id],
        |row| {
            Ok(PlanOwnerState {
                summary_json: row.get(0)?,
                output_json: row.get(1)?,
                status: row.get(2)?,
                task_kind: row.get(3)?,
                attempt_count: row.get(4)?,
                attempt_output_json: row.get(5)?,
                attempt_status: row.get(6)?,
                attempt_number: row.get(7)?,
                current_attempt_rows: row.get(8)?,
            })
        },
    )?;
    anyhow::ensure!(
        owner.task_kind == CHRONICLE_PLAN_TASK_KIND
            && owner.status == "completed"
            && owner.attempt_count > 0
            && owner.current_attempt_rows == 1
            && owner.attempt_status.as_deref() == Some("completed")
            && owner.attempt_number == Some(owner.attempt_count),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: ProposalSet owner is not the exact completed current plan Task/Attempt"
    );
    anyhow::ensure!(
        owner.attempt_output_json.as_deref() == owner.output_json.as_deref(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: owner Task/current Attempt outputs differ"
    );
    let output: Value = owner
        .output_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: completed owner Task has no outputJson"
            )
        })?;
    anyhow::ensure!(
        output.get("proposalSetId").and_then(Value::as_str) == Some(proposal_set_id.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: owner Task output does not bind ProposalSet"
    );
    let mut summary: Value = serde_json::from_str(&owner.summary_json)?;
    let binding = summary
        .as_object_mut()
        .and_then(|object| object.remove(CHRONICLE_PLAN_BINDING_FIELD))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: ProposalSet is missing Native task binding"
            )
        })?;
    let binding_object = binding.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native task binding is not an object"
        )
    })?;
    anyhow::ensure!(
        binding_object.len() == 6
            && binding_object.get("kind").and_then(Value::as_str)
                == Some(CHRONICLE_PLAN_BINDING_KIND)
            && binding_object.get("version").and_then(Value::as_u64) == Some(1)
            && binding_object.get("taskId").and_then(Value::as_str) == Some(task_id)
            && binding_object.get("attemptId").and_then(Value::as_str) == Some(attempt_id)
            && binding_object.get("proposalSetId").and_then(Value::as_str)
                == Some(proposal_set_id.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native task binding identity is invalid"
    );
    let manifest_digest = binding_object
        .get("proposalManifestDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native task binding has no proposalManifestDigest"
            )
        })?;
    anyhow::ensure!(
        is_sha256_digest(manifest_digest),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native task binding manifest digest is invalid"
    );
    let manifest = load_chronicle_plan_proposal_manifest(
        conn,
        project_id,
        run_id,
        task_id,
        attempt_id,
        &proposal_set_id,
        false,
    )?;
    anyhow::ensure!(
        canonical_json_digest(&manifest)? == manifest_digest,
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: ProposalSet summary/proposals/envelopes/receipt refs differ from Native task binding"
    );
    let manifest_proposals = manifest
        .get("proposals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native proposal manifest has no proposal roster"
            )
        })?;
    anyhow::ensure!(
        output.get("proposalCount").and_then(Value::as_u64)
            == Some(manifest_proposals.len() as u64),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: owner Task output proposalCount differs from Native proposal manifest"
    );
    // The durable artifact is a second public projection of the same terminal
    // result. Its full canonical payload digest is also in the manifest that
    // the binding above verified, so a later rewrite of `planned` metadata
    // cannot evade terminal-proof validation.
    let (artifact_value, _) =
        load_chronicle_plan_artifact_payload(conn, run_id, task_id, attempt_id)?;
    anyhow::ensure!(
        artifact_value.get("proposalSetId").and_then(Value::as_str)
            == Some(proposal_set_id.as_str()),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact does not bind the Native ProposalSet"
    );
    let artifact_proposals = artifact_value
        .get("proposals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact has no proposal roster"
            )
        })?;
    anyhow::ensure!(
        artifact_proposals.len() == manifest_proposals.len(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan artifact count differs from Native proposal manifest"
    );
    // The manifest is sorted by immutable proposalKey so its digest is stable
    // across SQLite row order.  The plan artifact, conversely, preserves the
    // planner's event/index order.  Never zip those two independently ordered
    // rosters: UUID-like event IDs are not lexically ordered by planner index.
    let mut manifest_by_key = HashMap::with_capacity(manifest_proposals.len());
    for manifest_proposal in manifest_proposals {
        let proposal_key = manifest_proposal
            .get("proposalKey")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native proposal manifest has an entry without proposalKey"
                )
            })?;
        anyhow::ensure!(
            manifest_by_key
                .insert(proposal_key, manifest_proposal)
                .is_none(),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native proposal manifest has duplicate proposalKey"
        );
    }
    for (index, artifact_proposal) in artifact_proposals.iter().enumerate() {
        let event_id = artifact_proposal
            .get("eventId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan entry {index} has no eventId"
                )
            })?;
        let expected_key = format!("{event_id}:{index}");
        let manifest_proposal = manifest_by_key.get(expected_key.as_str()).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan entry {index} has no matching immutable proposalKey"
            )
        })?;
        let manifest_payload = manifest_proposal.get("payloadJson").ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Native proposal manifest entry {index} has no payload"
            )
        })?;
        anyhow::ensure!(
            manifest_proposal.get("proposalKey").and_then(Value::as_str)
                == Some(expected_key.as_str())
                && manifest_proposal.get("kind").and_then(Value::as_str)
                    == Some(CHRONICLE_EVENT_PROPOSAL_KIND)
                && canonical_json_digest(manifest_payload)?
                    == canonical_json_digest(artifact_proposal)?,
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: proposal-plan entry {index} differs from Native proposal manifest"
        );
    }
    Ok(proposal_set_id)
}

pub fn finish_task(db: &Database, payload: FinishTaskPayload) -> anyhow::Result<Value> {
    let mut compatibility_owner = super::source_revision::ForegroundValidationControl;
    finish_task_with_control(db, payload, &mut compatibility_owner)
}

pub fn finish_task_with_control(
    db: &Database,
    payload: FinishTaskPayload,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    let output_value = payload
        .output_json
        .clone()
        .unwrap_or_else(default_object_json);
    let output_json = serde_json::to_string(&output_value)?;

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            validation_owner.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            ensure_generic_task_api_allowed(conn, &payload.run_id)?;
            verify_task_lease(
                conn,
                &payload.task_id,
                &payload.run_id,
                &payload.lease_owner,
            )?;
            let attempt_is_current: Option<i64> = conn
                .query_row(
                    "SELECT 1
                       FROM narrative_extraction_attempts a
                       JOIN narrative_extraction_tasks t ON t.id = a.task_id
                      WHERE a.id = ?1
                        AND a.task_id = ?2
                        AND a.status = 'running'
                        AND a.attempt_number = t.attempt_count",
                    params![payload.attempt_id, payload.task_id],
                    |row| row.get(0),
                )
                .optional()?;
            anyhow::ensure!(
                attempt_is_current == Some(1),
                "attempt is not the current running attempt owned by task"
            );
            validate_current_chronicle_live_catalog(conn, &payload.project_id, &payload.run_id)?;
            validate_current_chronicle_ai_task_finish_input(conn, &payload, &output_value)?;
            validate_chronicle_plan_proposal_set_finish_input(conn, &payload, &output_value)?;
            let lifecycle_at = grimodex_core::now_rfc3339_millis();

            let updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed',
                        output_json = ?1,
                        error_message = NULL,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = ?4,
                        version = version + 1
                  WHERE id = ?2 AND run_id = ?3 AND status = 'running'",
                params![output_json, payload.task_id, payload.run_id, lifecycle_at],
            )?;
            anyhow::ensure!(updated == 1, "task is not running");

            let attempt_updated = conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'completed',
                        completed_at = ?4,
                        output_json = ?1
                  WHERE id = ?2 AND task_id = ?3 AND status = 'running'",
                params![
                    output_json,
                    payload.attempt_id,
                    payload.task_id,
                    lifecycle_at
                ],
            )?;
            anyhow::ensure!(
                attempt_updated == 1,
                "attempt completion lost ownership or status race"
            );

            persist_task_artifacts(
                conn,
                &payload.project_id,
                &payload.run_id,
                &payload.task_id,
                &payload.attempt_id,
                &output_value,
                payload.chronicle_stage_bundle.as_ref(),
                &payload.chronicle_stage_receipts,
                payload.historical_scope_authority_basis.as_ref(),
                &payload.artifacts,
            )?;

            // The terminal review ledger belongs to this exact current
            // Task/Attempt.  Keep it inside the same immediate transaction as
            // artifact persistence and completion so neither a process crash
            // nor a reclaimed attempt can create an orphan/duplicate
            // ProposalSet between save and finish.
            let proposal_set = payload
                .chronicle_plan_proposal_set
                .as_ref()
                .map(|finish| {
                    save_chronicle_plan_proposal_set_in_tx(conn, &payload, finish, validation_owner)
                })
                .transpose()?;

            maybe_complete_run(conn, &payload.run_id)?;

            let mut result = json!({
                "taskId": payload.task_id,
                "attemptId": payload.attempt_id,
                "status": "completed",
                "task": load_task_row(conn, &payload.task_id, &payload.run_id)?,
            });
            if let Some(proposal_set) = proposal_set {
                result["proposalSet"] = proposal_set;
            }
            Ok(result)
        })
    })
}

pub fn fail_task(db: &Database, payload: FailTaskPayload) -> anyhow::Result<Value> {
    let output_json = payload
        .output_json
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let requeue = payload.requeue.unwrap_or(false);
    let next_status = if requeue { "queued" } else { "failed" };

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            ensure_generic_task_api_allowed(conn, &payload.run_id)?;
            verify_task_lease(
                conn,
                &payload.task_id,
                &payload.run_id,
                &payload.lease_owner,
            )?;
            let lifecycle_at = grimodex_core::now_rfc3339_millis();

            let updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = ?1,
                        output_json = COALESCE(?2, output_json),
                        error_message = ?3,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = CASE WHEN ?1 = 'failed' THEN ?6 ELSE NULL END,
                        version = version + 1
                  WHERE id = ?4 AND run_id = ?5 AND status = 'running'",
                params![
                    next_status,
                    output_json,
                    payload.error_message,
                    payload.task_id,
                    payload.run_id,
                    lifecycle_at,
                ],
            )?;
            anyhow::ensure!(updated == 1, "task is not running");

            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed',
                        completed_at = ?3,
                        error_message = ?1,
                        output_json = COALESCE(?2, output_json)
                  WHERE id = ?4 AND task_id = ?5",
                params![
                    payload.error_message,
                    output_json,
                    lifecycle_at,
                    payload.attempt_id,
                    payload.task_id,
                ],
            )?;

            if requeue {
                maybe_complete_run(conn, &payload.run_id)?;
            } else {
                let run_lifecycle_at =
                    next_run_lifecycle_timestamp_in_tx(conn, &payload.project_id)?;
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET status = 'failed',
                            completed_at = ?2,
                            outcome_summary_json = ?1,
                            version = version + 1
                      WHERE id = ?3 AND status = 'running'",
                    params![
                        json!({ "failedTaskId": payload.task_id }).to_string(),
                        run_lifecycle_at,
                        payload.run_id,
                    ],
                )?;
            }

            Ok(json!({
                "taskId": payload.task_id,
                "attemptId": payload.attempt_id,
                "status": next_status,
                "task": load_task_row(conn, &payload.task_id, &payload.run_id)?,
            }))
        })
    })
}

fn maybe_complete_run(conn: &Connection, run_id: &str) -> anyhow::Result<()> {
    let remaining: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_tasks
          WHERE run_id = ?1
            AND status IN ('queued', 'running')",
        params![run_id],
        |row| row.get(0),
    )?;
    if remaining == 0 {
        let project_id: String = conn.query_row(
            "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        let run_lifecycle_at = next_run_lifecycle_timestamp_in_tx(conn, &project_id)?;
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET status = 'completed',
                    completed_at = ?2,
                    version = version + 1
              WHERE id = ?1 AND status = 'running'",
            params![run_id, run_lifecycle_at],
        )?;
    }
    Ok(())
}

/// Cold-start review restore: inline-json artifacts + proposal set + proposals
/// (current revision / payload / status) + latest decision per proposal.
pub fn get_run_review_bundle(
    db: &Database,
    run_id: String,
    project_id: String,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        ensure_run_project(conn, &run_id, &project_id)?;
        let current_chronicle_spec =
            current_chronicle_run_spec_for_run(conn, &project_id, &run_id)?;
        let typed_relation_set_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_sets
              WHERE run_id = ?1 AND project_id = ?2 AND set_kind = ?3",
            params![run_id, project_id, NIR1_ENTITY_RELATION_SET_KIND],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            typed_relation_set_count == 0,
            "NIR1_ENTITY_RELATION_REVIEW_BUNDLE_UNAVAILABLE: typed Entity/Relation Evidence is not published through the generic review bundle"
        );

        // A generic review bundle remains useful for historical/other
        // surfaces, but Chronicle's coordinator treats this read as its
        // process-restart input boundary.  For that surface, re-CAS every
        // completed DAG artifact against the current Task/Attempt and the
        // Native canonical payload digest before returning any raw JSON.
        // This prevents a stale prior-attempt artifact from becoming input to
        // a resumed synthesis task just because its shape happens to parse.
        let verified_chronicle_artifacts =
            validate_chronicle_resume_artifacts(conn, &project_id, &run_id)?;

        // This bundle is also the cold-process hydration boundary for the
        // Chronicle coordinator.  The C1 closure is intentionally not
        // durable, so expose only a Native-revalidated receipt roster; any
        // stale lifecycle, mismatched model-binding row, or missing audit
        // terminal evidence rejects the whole read rather than allowing a
        // resumed synthesis task to manufacture a new partial closure.
        let stage_receipts = if stage_provenance_tables_present(conn)? {
            super::stage_provenance::load_verified_stage_receipts_for_hydration(
                conn,
                &project_id,
                &run_id,
            )?
        } else {
            // Pre-C1 read-only ledgers may not have the sidecar tables. They
            // remain reviewable, but a resume that needs an Observation
            // terminal will reject the empty roster before claiming work.
            Vec::new()
        };

        let mut artifact_stmt = conn.prepare(
            "SELECT id, run_id, task_id, attempt_id, artifact_kind,
                    payload_storage, payload_json, payload_ref, payload_digest, created_at
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1
              ORDER BY created_at ASC, id ASC",
        )?;
        let artifacts: Vec<Value> = artifact_stmt
            .query_map(params![run_id], row_to_artifact_value)?
            .collect::<Result<_, _>>()?;
        // A Chronicle restart must never hydrate a superseded artifact merely
        // because it was written later than the current Attempt.  The
        // coordinator's in-memory index is keyed by Run + kind, so returning
        // every historical row here would make its last-write-wins behavior
        // select stale payload JSON after this function has validated only
        // the current Attempt.  Restrict Chronicle to the exact artifact rows
        // that passed the Native current-Task/current-Attempt CAS above.
        let artifacts = match verified_chronicle_artifacts {
            Some(verified) => artifacts
                .into_iter()
                .filter(|artifact| {
                    let Some(task_id) = artifact["taskId"].as_str() else {
                        return false;
                    };
                    let Some(attempt_id) = artifact["attemptId"].as_str() else {
                        return false;
                    };
                    let Some(artifact_kind) = artifact["artifactKind"].as_str() else {
                        return false;
                    };
                    verified.contains(&(
                        task_id.to_owned(),
                        attempt_id.to_owned(),
                        artifact_kind.to_owned(),
                    ))
                })
                .collect(),
            None => artifacts,
        };

        // Current Chronicle Runs have exactly one terminal review family.  Do
        // not select the most recently inserted set: bind the review bundle
        // to the immutable first revision, the exact finishing Task/Attempt,
        // its canonical plan artifact, and the Native manifest instead.
        let current_chronicle_proposal_set_id = if current_chronicle_spec {
            let plan_attempt: Option<(String, String)> = conn
                .query_row(
                "SELECT t.id, a.id
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a
                     ON a.task_id = t.id
                    AND a.attempt_number = t.attempt_count
                    AND a.status = 'completed'
                  WHERE t.run_id = ?1
                    AND t.task_kind = ?2
                    AND t.status = 'completed'",
                params![run_id, CHRONICLE_PLAN_TASK_KIND],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
                .optional()?;
            match plan_attempt {
                Some((task_id, attempt_id)) => {
                    Some(validate_chronicle_plan_proposal_set_binding_for_resume(
                        conn,
                        &project_id,
                        &run_id,
                        &task_id,
                        &attempt_id,
                    )?)
                }
                None => {
                    let proposal_set_count: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_sets
                          WHERE run_id = ?1 AND project_id = ?2",
                        params![run_id, project_id],
                        |row| row.get(0),
                    )?;
                    anyhow::ensure!(
                        proposal_set_count == 0,
                        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: incomplete Chronicle plan Task has a durable ProposalSet"
                    );
                    None
                }
            }
        } else {
            None
        };

        let proposal_set: Option<Value> = match current_chronicle_proposal_set_id.as_deref() {
            Some(proposal_set_id) => conn
                .query_row(
                    "SELECT id, run_id, project_id, set_kind, status, summary_json,
                            created_at, updated_at, version
                       FROM narrative_proposal_sets
                      WHERE id = ?1 AND run_id = ?2 AND project_id = ?3",
                    params![proposal_set_id, run_id, project_id],
                    row_to_proposal_set_value,
                )
                .optional()?,
            None if !current_chronicle_spec => conn
                .query_row(
                    "SELECT id, run_id, project_id, set_kind, status, summary_json,
                            created_at, updated_at, version
                       FROM narrative_proposal_sets
                      WHERE run_id = ?1 AND project_id = ?2
                      ORDER BY created_at DESC, id DESC
                      LIMIT 1",
                    params![run_id, project_id],
                    row_to_proposal_set_value,
                )
                .optional()?,
            None => None,
        };

        let mut proposals = Vec::new();
        if let Some(set) = proposal_set.as_ref() {
            let proposal_set_id = set
                .get("proposalSetId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("proposal set missing id"))?;
            // Resume maps the returned payload to `currentRevisionId`, so a
            // current Chronicle Run must read the revision row itself rather
            // than the denormalized initial payload on `narrative_proposals`.
            // The inner join also turns a missing/current-pointer-corrupt
            // revision into a fail-closed bundle error below.
            let proposal_query = if current_chronicle_spec {
                "SELECT p.id, p.proposal_set_id, p.proposal_key, p.kind, p.status,
                        r.payload_json AS payload_json, p.current_revision_id,
                        p.created_at, p.updated_at, r.origin_kind,
                        r.reconciliation_envelope_digest,
                        r.reconciliation_envelope_json
                   FROM narrative_proposals p
                   INNER JOIN narrative_proposal_revisions r
                           ON r.id = p.current_revision_id
                          AND r.proposal_id = p.id
                  WHERE p.proposal_set_id = ?1
                  ORDER BY p.created_at ASC, p.id ASC"
            } else {
                "SELECT p.id, p.proposal_set_id, p.proposal_key, p.kind, p.status,
                        p.payload_json, p.current_revision_id, p.created_at,
                        p.updated_at, r.origin_kind,
                        r.reconciliation_envelope_digest,
                        r.reconciliation_envelope_json
                   FROM narrative_proposals p
                   LEFT JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
                  WHERE p.proposal_set_id = ?1
                  ORDER BY p.created_at ASC, p.id ASC"
            };
            let mut proposal_stmt = conn.prepare(proposal_query)?;
            let rows: Vec<Value> = proposal_stmt
                .query_map(params![proposal_set_id], row_to_proposal_value)?
                .collect::<Result<_, _>>()?;

            if current_chronicle_spec {
                let persisted_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposals WHERE proposal_set_id = ?1",
                    params![proposal_set_id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(
                    rows.len() == persisted_count as usize,
                    "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT: current Chronicle ProposalSet has a missing current revision row"
                );
                for proposal in &rows {
                    anyhow::ensure!(
                        proposal.get("kind").and_then(Value::as_str)
                            == Some(CHRONICLE_EVENT_PROPOSAL_KIND),
                        "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT: current Chronicle ProposalSet has a non-Chronicle proposal kind"
                    );
                    let payload = proposal.get("payloadJson").ok_or_else(|| {
                        anyhow::anyhow!(
                            "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT: current Chronicle revision has no payload"
                        )
                    })?;
                    validate_chronicle_scene_event_proposal_payload(payload).map_err(|error| {
                        anyhow::anyhow!(
                            "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT: current Chronicle revision payload is invalid: {error}"
                        )
                    })?;
                }
            }

            for mut proposal in rows {
                let proposal_id = proposal
                    .get("proposalId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("proposal missing id"))?
                    .to_string();
                let latest_decision = conn
                    .query_row(
                        "SELECT id, proposal_id, revision_id, decision, decision_json,
                                created_at, created_by, actor_kind, actor_id,
                                authority_scope, override_field_paths_json
                           FROM narrative_proposal_decisions
                          WHERE proposal_id = ?1
                          ORDER BY created_at DESC, id DESC
                          LIMIT 1",
                        params![proposal_id],
                        row_to_decision_value,
                    )
                    .optional()?;
                let application = conn
                    .query_row(
                        "SELECT commit_id, revision_id, applied_entity_kind,
                                applied_entity_id, created_at, application_kind,
                                compensates_application_id
                           FROM narrative_proposal_applications
                          WHERE proposal_id = ?1
                          ORDER BY created_at DESC, id DESC
                          LIMIT 1",
                        params![proposal_id],
                        |row| {
                            Ok(json!({
                                "commitId": row.get::<_, String>(0)?,
                                "revisionId": row.get::<_, String>(1)?,
                                "appliedEntityKind": row.get::<_, String>(2)?,
                                "appliedEntityId": row.get::<_, String>(3)?,
                                "createdAt": row.get::<_, String>(4)?,
                                "applicationKind": row.get::<_, String>(5)?,
                                "compensatesApplicationId": row.get::<_, Option<String>>(6)?,
                            }))
                        },
                    )
                    .optional()?;
                if let Some(obj) = proposal.as_object_mut() {
                    obj.insert("latestDecision".to_string(), json!(latest_decision));
                    obj.insert("application".to_string(), json!(application));
                }
                proposals.push(proposal);
            }
        }

        Ok(json!({
            "runId": run_id,
            "projectId": project_id,
            "artifacts": artifacts,
            "stageReceipts": stage_receipts,
            "proposalSet": proposal_set,
            "proposals": proposals,
        }))
    })
}

fn stage_provenance_tables_present(conn: &Connection) -> anyhow::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'narrative_extraction_stage_model_bindings',
              'narrative_extraction_stage_receipts'
            )",
        [],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count == 0 || count == 2,
        "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: stage provenance tables are only partially present"
    );
    Ok(count == 2)
}

fn validate_chronicle_resume_artifacts(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Option<HashSet<(String, String, String)>>> {
    let surface_path_id: String = conn.query_row(
        "SELECT surface_path_id FROM narrative_extraction_runs WHERE id = ?1 AND project_id = ?2",
        params![run_id, project_id],
        |row| row.get(0),
    )?;
    if surface_path_id != "chronicle.extract" {
        return Ok(None);
    }

    const TASK_ARTIFACTS: [(&str, &str); 9] = [
        ("source.snapshot@1", "source.snapshot@1"),
        ("source.window-plan@1", "source.window-plan@1"),
        ("chronicle.observe-events@1", "chronicle.raw-observations@1"),
        ("evidence.resolve@1", "evidence.resolved@1"),
        (
            "chronicle.merge-local-observations@1",
            "chronicle.merged-observations@1",
        ),
        (
            "chronicle.cluster-event-observations@1",
            "chronicle.event-clusters@1",
        ),
        (
            "chronicle.synthesize-event@1",
            "chronicle.event-hypotheses@1",
        ),
        (
            "chronicle.match-existing-events@1",
            "chronicle.existing-event-matches@1",
        ),
        ("chronicle.plan-proposals@1", "chronicle.proposal-plan@1"),
    ];

    let mut verified = HashSet::new();
    let mut has_resume_topology_task = false;
    for (task_kind, artifact_kind) in TASK_ARTIFACTS {
        let task: Option<(String, String, i64)> = conn
            .query_row(
                "SELECT id, status, attempt_count
                   FROM narrative_extraction_tasks
                  WHERE run_id = ?1 AND task_kind = ?2",
                params![run_id, task_kind],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((task_id, status, attempt_count)) = task else {
            // Topology is checked by the coordinator before it can resume;
            // keep the read bundle available to recovery UI for an incomplete
            // historical Run.
            continue;
        };
        has_resume_topology_task = true;
        if status != "completed" {
            continue;
        }
        let attempt_id: Option<String> = conn
            .query_row(
                "SELECT id FROM narrative_extraction_attempts
                  WHERE task_id = ?1 AND attempt_number = ?2 AND status = 'completed'",
                params![task_id, attempt_count],
                |row| row.get(0),
            )
            .optional()?;
        let attempt_id = attempt_id.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: completed Task '{}' has no completed current Attempt",
                task_kind
            )
        })?;
        let mut artifact_stmt = conn.prepare(
            "SELECT payload_storage, payload_json, payload_digest
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND task_id = ?2 AND attempt_id = ?3
                AND artifact_kind = ?4
              ORDER BY created_at ASC, id ASC",
        )?;
        let artifacts = artifact_stmt
            .query_map(params![run_id, task_id, attempt_id, artifact_kind], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            artifacts.len() == 1,
            "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: completed Task '{}' requires exactly one current-attempt '{}' artifact",
            task_kind,
            artifact_kind
        );
        let (storage, payload_json, payload_digest) = artifacts
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("unreachable checked artifact row"))?;
        anyhow::ensure!(
            storage == "inline-json",
            "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: Chronicle artifact '{}' must use inline-json storage",
            artifact_kind
        );
        let payload_json = payload_json.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: Chronicle artifact '{}' has no inline payload",
                artifact_kind
            )
        })?;
        let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: Chronicle artifact '{}' has malformed payload JSON: {error}",
                artifact_kind
            )
        })?;
        let expected_digest = grimodex_core::canonical_json_digest(&payload)?;
        anyhow::ensure!(
            payload_digest.as_deref() == Some(expected_digest.as_str()),
            "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: Chronicle artifact '{}' payloadDigest does not match Native canonical JSON",
            artifact_kind
        );
        verified.insert((task_id, attempt_id, artifact_kind.to_owned()));
    }
    // Older Chronicle review records can use a pre-DAG task vocabulary. They
    // are never resumable by the coordinator (which requires the complete
    // current topology), but must remain readable through this generic review
    // API. Only apply the strict artifact roster projection after recognizing
    // at least one current resume-task kind.
    Ok(has_resume_topology_task.then_some(verified))
}

pub fn save_proposal_set(db: &Database, payload: SaveProposalSetPayload) -> anyhow::Result<Value> {
    save_proposal_set_atomic(db, payload, None)
}

/// Foreground Native entry point. The caller owns the lifecycle stop scope;
/// envelope eligibility is evaluated through that same transaction rather
/// than a compatibility `NeverStop` owner.
pub fn save_proposal_set_with_control(
    db: &Database,
    payload: SaveProposalSetPayload,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    save_proposal_set_atomic(db, payload, Some(control))
}

fn save_proposal_set_atomic(
    db: &Database,
    payload: SaveProposalSetPayload,
    control: Option<&mut dyn GraphWorkControl>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        payload.set_kind != NIR1_ENTITY_RELATION_SET_KIND,
        "NIR1_ENTITY_RELATION_TYPED_ADAPTER_REQUIRED: use the Native typed Entity/Relation adapter"
    );
    let mut compatibility_owner = super::source_revision::ForegroundValidationControl;
    let validation_owner: &mut dyn GraphWorkControl = match control {
        Some(control) => control,
        None => &mut compatibility_owner,
    };
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            validation_owner.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            require_narrative_extraction_allowed(conn)?;
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            anyhow::ensure!(
                !current_chronicle_run_spec_for_run(conn, &payload.project_id, &payload.run_id)?,
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_TYPED_FINISH_REQUIRED: current Chronicle Runs may persist ProposalSets only through chronicle.plan-proposals@1 FinishTask"
            );
            save_proposal_set_in_tx(conn, &payload, validation_owner)
        })
    })
}

/// Ambient-transaction proposal writer.  The generic public save wraps this
/// in its own immediate transaction; Chronicle's typed plan finish invokes it
/// from the Task terminal transaction so save and completion cannot diverge.
fn save_proposal_set_in_tx(
    conn: &Connection,
    payload: &SaveProposalSetPayload,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        payload.set_kind != NIR1_ENTITY_RELATION_SET_KIND,
        "NIR1_ENTITY_RELATION_TYPED_ADAPTER_REQUIRED: use the Native typed Entity/Relation adapter"
    );
    let proposal_set_id = payload
        .proposal_set_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let summary_value = super::stage_provenance::prepare_chronicle_v2_proposal_set_summary(
        conn,
        &payload.project_id,
        &payload.run_id,
        payload.summary_json.as_ref(),
        &payload.proposals,
    )?;
    let summary_json = serde_json::to_string(&summary_value)?;

    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, status, summary_json,
             created_at, updated_at, version)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, datetime('now'), datetime('now'), 0)",
        params![
            proposal_set_id,
            payload.run_id,
            payload.project_id,
            payload.set_kind,
            summary_json,
        ],
    )?;

    let mut saved = Vec::new();
    for proposal in &payload.proposals {
        saved.push(insert_proposal_seed(
            conn,
            &proposal_set_id,
            &payload.run_id,
            &payload.project_id,
            proposal,
            validation_owner,
        )?);
    }

    Ok(json!({
        "proposalSetId": proposal_set_id,
        "proposals": saved,
    }))
}

fn insert_proposal_seed(
    conn: &Connection,
    proposal_set_id: &str,
    run_id: &str,
    project_id: &str,
    seed: &ProposalSeed,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    let proposal_id = seed
        .proposal_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let payload_json = serde_json::to_string(&seed.payload_json)?;
    let revision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let validated_envelope = validate_reconciliation_envelope(
        conn,
        project_id,
        run_id,
        seed.reconciliation_envelope.as_ref(),
    )?;
    if let Some(envelope) = seed.reconciliation_envelope.as_ref() {
        if envelope_schema_version(envelope) == Some(2) {
            let envelope_kind = envelope
                .pointer("/projectionBinding/proposalKind")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_ENVELOPE_PROPOSAL_KIND_MISMATCH: V2 projectionBinding.proposalKind is missing"
                    )
                })?;
            anyhow::ensure!(
                seed.kind == envelope_kind,
                "NEX_ENVELOPE_PROPOSAL_KIND_MISMATCH: ProposalSeed.kind does not match projectionBinding.proposalKind"
            );
            validate_chronicle_scene_event_proposal_payload(&seed.payload_json).map_err(
                |error| anyhow::anyhow!("NEX_ENVELOPE_PROPOSAL_PAYLOAD_INVALID: {error}"),
            )?;
            anyhow::ensure!(
                envelope.pointer("/assertion/assertionKind").and_then(Value::as_str)
                    == Some("scene-event@1"),
                "NEX_NARRATIVE_V2_PILOT_ASSERTION_KIND_FORBIDDEN: production Chronicle pilot accepts only scene-event@1"
            );
            anyhow::ensure!(
                envelope.pointer("/changeIntent/changeKind").and_then(Value::as_str)
                    == Some("add"),
                "NEX_NARRATIVE_V2_PILOT_CHANGE_KIND_FORBIDDEN: production Chronicle pilot accepts only add"
            );
            ensure_v2_proposal_evidence_binding(envelope, &seed.payload_json)?;
        }
        ensure_v2_proposal_payload_digest(envelope, &seed.payload_json)?;
        let mut validation = validation_context(conn, validation_owner);
        validate_envelope_source_tokens_with_validation_context(
            &mut validation,
            project_id,
            run_id,
            envelope,
        )?;
    }
    let origin_kind = if validated_envelope.is_some() {
        ORIGIN_ENVELOPED
    } else {
        ORIGIN_LEGACY_UNBOUND
    };
    let envelope_json = validated_envelope
        .as_ref()
        .map(|envelope| envelope.canonical_json.clone());
    let envelope_digest = validated_envelope
        .as_ref()
        .map(|envelope| envelope.digest.clone());

    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json,
             current_revision_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'unreviewed', ?5, ?6, datetime('now'), datetime('now'))",
        params![
            proposal_id,
            proposal_set_id,
            seed.proposal_key,
            seed.kind,
            payload_json,
            revision_id,
        ],
    )?;

    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 'system')",
        params![
            revision_id,
            proposal_id,
            payload_json.clone(),
            origin_kind,
            envelope_json,
            envelope_digest,
            created_at,
        ],
    )?;
    if let Some(envelope) = validated_envelope.as_ref() {
        insert_source_basis_rows(conn, &revision_id, &envelope.source_basis)?;
    }
    record_revision_dependency_edges_in_tx(
        conn,
        project_id,
        run_id,
        &revision_id,
        validated_envelope
            .as_ref()
            .map(|envelope| envelope.source_basis.as_slice())
            .unwrap_or(&[]),
        &created_at,
    )?;
    if seed
        .reconciliation_envelope
        .as_ref()
        .and_then(envelope_schema_version)
        == Some(2)
    {
        let validated_envelope = validated_envelope.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2A_V2_ENVELOPE_INVALID: V2 envelope was not validated before persistence"
            )
        })?;
        materialize_initial_v2_authorities_in_tx(
            conn,
            project_id,
            run_id,
            &revision_id,
            validated_envelope,
            &created_at,
        )?;
    }

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, project_id)?;
    Ok(json!({
        "proposalId": proposal_id,
        "proposalKey": seed.proposal_key,
        "revisionId": revision_id,
        "originKind": origin_kind,
        "reconciliationEnvelopeDigest": envelope_digest,
        "reconciliationEnvelopeSchemaVersion": seed
            .reconciliation_envelope
            .as_ref()
            .and_then(envelope_schema_version),
        "status": "unreviewed",
    }))
}

/// Bind the first persisted V2 Revision to the same D1 and current-Epoch
/// Freshness authorities that C2B requires from its parent.  This is kept in
/// the ProposalSet transaction: a V2 root without these authorities would be
/// reviewable but could never safely enter the Human writer.
fn materialize_initial_v2_authorities_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    validated_envelope: &super::reconciliation_envelope::ValidatedReconciliationEnvelope,
    created_at: &str,
) -> anyhow::Result<()> {
    let semantic_epoch_id = get_current_epoch(conn, project_id)?
        .map(|epoch| epoch.id)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2A_CURRENT_SEMANTIC_EPOCH_UNAVAILABLE: project has no current Semantic Epoch"
            )
        })?;
    let envelope: Value = serde_json::from_str(&validated_envelope.canonical_json)
        .context("NEX_C2A_V2_ENVELOPE_INVALID: canonical Envelope could not be decoded")?;
    let material_basis: MaterialBasis =
        serde_json::from_value(envelope.get("effectiveMaterialBasis").cloned().ok_or_else(
            || {
                anyhow::anyhow!(
                    "NEX_C2A_V2_MATERIAL_BASIS_MISSING: effectiveMaterialBasis is required"
                )
            },
        )?)
        .context("NEX_C2A_V2_MATERIAL_BASIS_INVALID: effectiveMaterialBasis is invalid")?;
    let d1_projection = project_d1_declaration_set(
        &material_basis,
        &D1ParentAuthority {
            project_id: project_id.to_owned(),
            consumer_kind: PROPOSAL_REVISION_CONSUMER_KIND.to_owned(),
            consumer_key: revision_id.to_owned(),
            producer_id: super::human_material_basis::D1_PRODUCER_ID.to_owned(),
            producer_generation: PROPOSAL_REVISION_D1_PRODUCER_GENERATION,
        },
    )?;
    write_dependency_declaration_set_in_tx(
        conn,
        DependencyDeclarationSetRequest {
            project_id: d1_projection.project_id,
            consumer_kind: d1_projection.consumer_kind,
            consumer_key: d1_projection.consumer_key,
            producer_id: d1_projection.producer_id,
            producer_generation: d1_projection.producer_generation,
            expected_head_version: 0,
            declarations: d1_projection.declarations,
            created_at: created_at.to_owned(),
        },
    )?;

    let edges = find_edges_by_consumer(
        conn,
        project_id,
        PROPOSAL_REVISION_CONSUMER_KIND,
        revision_id,
    )?;
    let edges_and_observations = edges
        .iter()
        .map(|edge| {
            Ok((
                edge.id.clone(),
                evaluate_edge_from_db(conn, project_id, run_id, edge)?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    publish_complete_runless_freshness_in_tx(
        conn,
        project_id,
        PROPOSAL_REVISION_CONSUMER_KIND,
        revision_id,
        &edges_and_observations,
        &semantic_epoch_id,
        created_at,
    )?;
    Ok(())
}

/// Bind the typed proposal's evidence anchors/documents to the exact V2
/// material evidence set.  The Core proposal validator owns field shape and
/// vocabulary; this narrow cross-field check prevents storing two divergent
/// provenance claims for one revision.
pub(crate) fn ensure_v2_proposal_evidence_binding(
    envelope: &Value,
    proposal_payload: &Value,
) -> anyhow::Result<()> {
    let proposal = proposal_payload.as_object().ok_or_else(|| {
        anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: proposal is not an object")
    })?;
    let anchor_ids = proposal
        .get("evidenceAnchorIds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: evidenceAnchorIds missing")
        })?;
    let document_refs = proposal
        .get("evidenceDocumentRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: evidenceDocumentRefs missing")
        })?;
    let material = envelope
        .get("effectiveMaterialBasis")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: material basis missing")
        })?;
    let evidence = material
        .get("evidenceSet")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: evidenceSet missing"))?;
    let mut material_ids = Vec::with_capacity(evidence.len());
    let mut material_documents = Vec::with_capacity(evidence.len());
    for entry in evidence {
        let entry = entry.as_object().ok_or_else(|| {
            anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: evidence entry is not an object")
        })?;
        material_ids.push(
            entry
                .get("evidenceRef")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: evidenceRef missing")
                })?
                .to_owned(),
        );
        material_documents.push(
            entry
                .get("documentRef")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: documentRef missing")
                })?
                .to_owned(),
        );
    }
    let collect_strings = |values: &[Value]| -> anyhow::Result<Vec<String>> {
        values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("NEX_ENVELOPE_PROVENANCE_MISMATCH: evidence reference must be non-empty"))
            })
            .collect()
    };
    let mut expected_ids = collect_strings(anchor_ids)?;
    let mut expected_documents = collect_strings(document_refs)?;
    expected_ids.sort();
    expected_documents.sort();
    material_ids.sort();
    material_documents.sort();
    material_documents.dedup();
    anyhow::ensure!(
        expected_ids.windows(2).all(|window| window[0] != window[1])
            && expected_documents.windows(2).all(|window| window[0] != window[1])
            && expected_ids == material_ids
            && expected_documents == material_documents,
        "NEX_ENVELOPE_PROVENANCE_MISMATCH: proposal evidence anchors/documents do not exactly match Envelope evidenceSet"
    );
    Ok(())
}

pub(crate) fn insert_source_basis_rows(
    conn: &Connection,
    revision_id: &str,
    rows: &[SourceBasisRow],
) -> anyhow::Result<()> {
    for row in rows {
        conn.execute(
            "INSERT INTO narrative_revision_source_basis
                (revision_id, ordinal, source_kind, source_key, revision_token, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                revision_id,
                row.ordinal,
                row.source_kind,
                row.source_key,
                row.revision_token,
                row.observed_at,
            ],
        )?;
    }
    Ok(())
}

/// Producer-time Dependency Edge declaration (ADR 005 Amendment /
/// `dependency_edges.rs`): for every `SourceBasisRow` a Proposal's validated
/// Reconciliation Envelope carries, declares that *this Revision* read that
/// Source.
///
/// Consumer identity is `(PROPOSAL_REVISION_CONSUMER_KIND, revision_id)`
/// (Gate C2-2). It used to be `(RUN_CONSUMER_KIND, run_id)`, which is the
/// grain C2-2 exists to replace: every Proposal a Run produced shared one
/// Consumer, so editing one Scene staled all of them. A Revision is the
/// smallest durable unit that already exists here -- the row is immutable
/// once written and carries this same Source Basis in
/// `narrative_revision_source_basis`, so nothing has to be invented to key
/// an Edge to it.
///
/// The Run is still recorded, as `owning_run_id` (SCHEMA 30): it is what a
/// `snapshot:<runId>` Source of this Revision must name, and it stays true
/// after the Proposal is gone.
///
/// One Revision's Edges are its own, so unlike the Run-grained version this
/// no longer accumulates across siblings. It is still an upsert per Source
/// rather than a delete-then-redeclare: a Revision is immutable, so its
/// declared set does not shrink, and re-running the same Producer for the
/// same Revision must stay idempotent. `rows` empty (a legacy-unbound
/// Proposal/Revision with no envelope) is a no-op.
///
/// `read_set_json` per Edge is a one-element JSON array holding the
/// `SourceBasisRow`'s own `revision_token` -- the Reconciliation Envelope
/// has no field-path-level read-set below the whole-Source granularity
/// `sourceBasis` already validates, so this is the most specific true claim
/// available rather than a fabricated field list.
///
/// `row.source_key` is used directly as the Edge's `source_object_identity`
/// -- it is *not* run back through [`source_object_identity_for`]. By the
/// time this runs, `insert_proposal_seed` has already called
/// `validate_reconciliation_envelope` (which requires every `sourceBasis[].
/// sourceKey` to equal some `readSet[].inputRef`) and
/// `validate_envelope_source_tokens` (whose `resolve_source_revision` call
/// strips each source kind's own identity prefix, e.g. `project:scene:`,
/// off that same `inputRef`). So `row.source_key` already *is* the
/// fully-qualified identity `source_object_identity_for` would build --
/// re-deriving it here would prepend the prefix a second time and produce
/// an Edge no later resolver could ever match back to its real Source.
// NARRATIVE_DEPENDENCY_PRODUCER: proposal-revision-source-basis
pub(super) fn record_revision_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    rows: &[SourceBasisRow],
    created_at: &str,
) -> anyhow::Result<()> {
    for row in rows {
        let source_object_identity =
            canonical_source_object_identity(&row.source_kind, &row.source_key)?;
        let read_set_json = serde_json::to_string(&[row.revision_token.as_str()])?;
        record_dependency_edge_in_tx(
            conn,
            project_id,
            PROPOSAL_REVISION_CONSUMER_KIND,
            revision_id,
            &source_object_identity,
            &read_set_json,
            None,
            // SCHEMA 30: the declaring Run, recorded rather than left to be
            // re-derived from `consumer_key` at read time.
            Some(run_id),
            created_at,
        )?;
    }
    Ok(())
}

pub fn append_revision(db: &Database, payload: AppendRevisionPayload) -> anyhow::Result<Value> {
    let mut compatibility_owner = super::source_revision::ForegroundValidationControl;
    append_revision_with_control(db, payload, &mut compatibility_owner)
}

pub fn append_revision_with_control(
    db: &Database,
    payload: AppendRevisionPayload,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            control.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            append_revision_on_conn(conn, &payload, control)
        })
    })
}

/// Append a new revision on an existing connection/transaction.
/// Callers own the surrounding `with_immediate_transaction` so this can be
/// composed atomically with other writes (see `revise_and_decide`).
fn append_revision_on_conn(
    conn: &Connection,
    payload: &AppendRevisionPayload,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    ensure_proposal_not_applied(conn, &payload.proposal_id)?;
    ensure_current_chronicle_proposal_set_unconsumed(conn, &payload.proposal_id)?;
    let payload_json = serde_json::to_string(&payload.payload_json)?;
    let revision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let created_by = payload
        .created_by
        .clone()
        .unwrap_or_else(|| "user".to_string());

    ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
    let (
        proposal_set_id,
        current_revision_id,
        current_origin_kind,
        current_envelope_json,
        current_envelope_digest,
    ): (String, String, String, Option<String>, Option<String>) = conn.query_row(
        "SELECT p.proposal_set_id, p.current_revision_id,
                r.origin_kind, r.reconciliation_envelope_json,
                r.reconciliation_envelope_digest
           FROM narrative_proposals p
           INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
           LEFT JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
          WHERE p.id = ?1
            AND s.run_id = ?2
            AND s.project_id = ?3",
        params![payload.proposal_id, payload.run_id, payload.project_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    let _ = proposal_set_id;
    anyhow::ensure!(
        current_revision_id == payload.expected_current_revision_id,
        "NEX_PROPOSAL_REVISION_CONFLICT: expected current revision '{}', found '{}'",
        payload.expected_current_revision_id,
        current_revision_id
    );

    let current_is_v2 = current_origin_kind == ORIGIN_ENVELOPED
        && current_envelope_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<Value>(json).ok())
            .and_then(|envelope| envelope_schema_version(&envelope))
            == Some(2);
    anyhow::ensure!(
        current_origin_kind != NIR1_ENTITY_RELATION_REVISION_ORIGIN,
        "NIR1_ENTITY_RELATION_REVISION_IMMUTABLE: typed Entity/Relation Revision cannot be replaced by generic append"
    );
    if current_is_v2 {
        let child_is_v2 = payload
            .reconciliation_envelope
            .as_ref()
            .and_then(envelope_schema_version)
            == Some(2);
        anyhow::ensure!(
            child_is_v2 && payload.inherit_reconciliation_envelope.is_none(),
            "NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN: a V2 current requires a V2 child envelope"
        );
    }

    anyhow::ensure!(
        !(payload.reconciliation_envelope.is_some()
            && payload.inherit_reconciliation_envelope.is_some()),
        "NEX_REVISION_ENVELOPE_MODE_CONFLICT: supply an envelope or explicit inheritance, not both"
    );
    let inherited_envelope = if let Some(inherit) = payload.inherit_reconciliation_envelope.as_ref()
    {
        anyhow::ensure!(
            inherit.parent_revision_id == current_revision_id,
            "NEX_REVISION_ENVELOPE_PARENT_CONFLICT: inherit parent revision does not match current revision"
        );
        anyhow::ensure!(
            current_origin_kind == ORIGIN_ENVELOPED,
            "NEX_REVISION_ENVELOPE_INHERIT_UNAVAILABLE: current revision is not enveloped"
        );
        anyhow::ensure!(
            current_envelope_digest.as_deref() == Some(inherit.expected_envelope_digest.as_str()),
            "NEX_REVISION_ENVELOPE_INHERIT_CONFLICT: current envelope digest does not match expected digest"
        );
        Some(
            current_envelope_json
                .as_deref()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_REVISION_ENVELOPE_INHERIT_MISSING: current envelope JSON is missing"
                    )
                })
                .and_then(|json| {
                    serde_json::from_str(json).context(
                        "NEX_REVISION_ENVELOPE_INHERIT_INVALID: current envelope JSON is invalid",
                    )
                })?,
        )
    } else {
        None
    };
    let envelope_input = payload
        .reconciliation_envelope
        .as_ref()
        .or(inherited_envelope.as_ref());
    let validated_envelope = validate_reconciliation_envelope(
        conn,
        &payload.project_id,
        &payload.run_id,
        envelope_input,
    )?;
    if let Some(envelope) = envelope_input {
        anyhow::ensure!(
            envelope_schema_version(envelope) != Some(2),
            "NEX_NARRATIVE_V2_ACTIVATION_DISABLED: production revision append cannot activate Envelope V2"
        );
        ensure_v2_proposal_payload_digest(envelope, &payload.payload_json)?;
        let mut validation = validation_context(conn, validation_owner);
        validate_envelope_source_tokens_with_validation_context(
            &mut validation,
            &payload.project_id,
            &payload.run_id,
            envelope,
        )?;
    }
    let origin_kind = if validated_envelope.is_some() {
        ORIGIN_ENVELOPED
    } else {
        ORIGIN_LEGACY_UNBOUND
    };
    let envelope_json = validated_envelope
        .as_ref()
        .map(|envelope| envelope.canonical_json.clone());
    let envelope_digest = validated_envelope
        .as_ref()
        .map(|envelope| envelope.digest.clone());

    let next_revision: i64 = conn.query_row(
        "SELECT COALESCE(MAX(revision_number), 0) + 1
           FROM narrative_proposal_revisions
          WHERE proposal_id = ?1",
        params![payload.proposal_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            revision_id,
            payload.proposal_id,
            next_revision,
            payload_json,
            origin_kind,
            envelope_json,
            envelope_digest,
            created_at,
            created_by,
        ],
    )?;
    if let Some(envelope) = validated_envelope.as_ref() {
        insert_source_basis_rows(conn, &revision_id, &envelope.source_basis)?;
    }
    record_revision_dependency_edges_in_tx(
        conn,
        &payload.project_id,
        &payload.run_id,
        &revision_id,
        validated_envelope
            .as_ref()
            .map(|envelope| envelope.source_basis.as_slice())
            .unwrap_or(&[]),
        &created_at,
    )?;

    let updated = conn.execute(
        "UPDATE narrative_proposals
            SET payload_json = ?1,
                current_revision_id = ?2,
                status = 'unreviewed',
                updated_at = datetime('now')
          WHERE id = ?3
            AND current_revision_id = ?4",
        params![
            payload_json.clone(),
            revision_id,
            payload.proposal_id,
            payload.expected_current_revision_id
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_PROPOSAL_REVISION_CONFLICT: current revision changed concurrently"
    );

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, &payload.project_id)?;
    Ok(json!({
        "proposalId": payload.proposal_id,
        "revisionId": revision_id,
        "revisionNumber": next_revision,
        "originKind": origin_kind,
        "reconciliationEnvelopeDigest": envelope_digest,
        "status": "unreviewed",
    }))
}

pub fn append_decision(db: &Database, payload: AppendDecisionPayload) -> anyhow::Result<Value> {
    append_decision_with_actor(
        db,
        payload,
        TrustedDecisionActor::Automated {
            actor_id: "electron:automated-review".to_string(),
        },
    )
}

pub fn append_human_decision(
    db: &Database,
    payload: AppendDecisionPayload,
) -> anyhow::Result<Value> {
    append_decision_with_actor(
        db,
        payload,
        TrustedDecisionActor::Human {
            actor_id: "electron:human-review".to_string(),
        },
    )
}

fn append_decision_with_actor(
    db: &Database,
    payload: AppendDecisionPayload,
    actor: TrustedDecisionActor,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            append_decision_on_conn(conn, &payload, &actor)
        })
    })
}

/// Append a decision on an existing connection/transaction.
/// Callers own the surrounding `with_immediate_transaction` so this can be
/// composed atomically with a preceding revision (see `revise_and_decide`).
fn append_decision_on_conn(
    conn: &Connection,
    payload: &AppendDecisionPayload,
    actor: &TrustedDecisionActor,
) -> anyhow::Result<Value> {
    let proposal_status = map_decision_to_status(&payload.decision)?;
    ensure_nir1_entity_relation_decision_is_appendable(conn, payload)?;
    ensure_proposal_not_applied(conn, &payload.proposal_id)?;
    if proposal_status != "rejected" {
        ensure_current_chronicle_proposal_set_unconsumed(conn, &payload.proposal_id)?;
    }
    let decision_value = payload
        .decision_json
        .clone()
        .unwrap_or_else(default_object_json);
    validate_current_chronicle_decision_against_plan(
        conn,
        payload,
        proposal_status,
        &decision_value,
    )?;
    let decision_json = serde_json::to_string(&decision_value)?;
    let decision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let created_by = payload
        .created_by
        .clone()
        .unwrap_or_else(|| "user".to_string());
    ensure_run_project(conn, &payload.run_id, &payload.project_id)?;

    let (revision_owner, current_revision_id): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT p.id, p.current_revision_id
               FROM narrative_proposals p
               INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
               INNER JOIN narrative_proposal_revisions r ON r.id = ?1
              WHERE p.id = ?2
                AND r.proposal_id = p.id
                AND s.run_id = ?3
                AND s.project_id = ?4",
            params![
                payload.revision_id,
                payload.proposal_id,
                payload.run_id,
                payload.project_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((None, None));
    anyhow::ensure!(
        revision_owner.as_deref() == Some(payload.proposal_id.as_str()),
        "proposal revision mismatch for run/project"
    );
    anyhow::ensure!(
        current_revision_id.as_deref() == Some(payload.revision_id.as_str()),
        "NEX_PROPOSAL_REVISION_MISMATCH: decision revision '{}' is not current",
        payload.revision_id
    );
    let authority = derive_decision_authority(
        actor,
        &payload.project_id,
        &payload.proposal_id,
        &payload.revision_id,
        &decision_value,
    )?;

    conn.execute(
        "INSERT INTO narrative_proposal_decisions
            (id, proposal_id, revision_id, decision, decision_json, created_at, created_by,
             actor_kind, actor_id, authority_scope, override_field_paths_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            decision_id,
            payload.proposal_id,
            payload.revision_id,
            payload.decision,
            decision_json,
            created_at,
            created_by,
            authority.actor_kind,
            authority.actor_id,
            authority.authority_scope,
            serde_json::to_string(&authority.override_field_paths)?,
        ],
    )?;

    let updated = conn.execute(
        "UPDATE narrative_proposals
            SET status = ?1,
                updated_at = datetime('now')
          WHERE id = ?2
            AND current_revision_id = ?3",
        params![proposal_status, payload.proposal_id, payload.revision_id],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_PROPOSAL_REVISION_MISMATCH: current revision changed concurrently"
    );

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, &payload.project_id)?;
    Ok(json!({
        "decisionId": decision_id,
        "proposalId": payload.proposal_id,
        "revisionId": payload.revision_id,
        "decision": payload.decision,
        "status": proposal_status,
    }))
}

/// A typed Entity/Relation Revision is an immutable human-review decision
/// point. Generic Proposal decision replay must not turn a rejected/deferred
/// Revision back into an approved one. The one intentional transition kept
/// for the existing UI is the single approved -> rejected cancellation; once
/// that revocation is recorded, the Revision is terminal and only a new
/// immutable Revision may be decided.
fn ensure_nir1_entity_relation_decision_is_appendable(
    conn: &Connection,
    payload: &AppendDecisionPayload,
) -> anyhow::Result<()> {
    let typed_binding: Option<(String, String)> = conn
        .query_row(
            "SELECT s.set_kind, p.kind
               FROM narrative_proposals p
               INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE p.id = ?1
                AND s.run_id = ?2
                AND s.project_id = ?3",
            params![payload.proposal_id, payload.run_id, payload.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if typed_binding.as_ref()
        != Some(&(
            NIR1_ENTITY_RELATION_SET_KIND.to_owned(),
            NIR1_ENTITY_RELATION_PROPOSAL_KIND.to_owned(),
        ))
    {
        return Ok(());
    }

    let decisions: Vec<(String, String)> = conn
        .prepare(
            "SELECT decision, actor_kind
               FROM narrative_proposal_decisions
              WHERE proposal_id = ?1 AND revision_id = ?2
              ORDER BY created_at ASC, id ASC",
        )?
        .query_map(params![payload.proposal_id, payload.revision_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let Some((first_decision, _first_actor_kind)) = decisions.first() else {
        return Ok(());
    };
    let is_single_human_cancellation =
        decisions.len() == 1 && first_decision == "approved" && payload.decision == "rejected";
    if !is_single_human_cancellation {
        anyhow::bail!(
            "{NIR1_ENTITY_RELATION_DECISION_LOCKED}: typed revision decisions are terminal; create a new immutable revision"
        );
    }
    Ok(())
}

/// A fully rejected ProposalSet never enters Commit Prepare, so probable
/// duplicate semantics must be enforced at the Decision writer itself. This
/// runs before both Decision INSERT and Proposal status UPDATE and is limited
/// to the exact current Chronicle v2 contract.
fn validate_current_chronicle_decision_against_plan(
    conn: &Connection,
    payload: &AppendDecisionPayload,
    proposal_status: &str,
    decision_value: &Value,
) -> anyhow::Result<()> {
    let context: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT proposal_set.project_id, proposal_set.run_id,
                    proposal_set.id, proposal.proposal_key
               FROM narrative_proposals proposal
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
              WHERE proposal.id = ?1",
            params![payload.proposal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((project_id, run_id, proposal_set_id, proposal_key)) = context else {
        return Ok(());
    };
    anyhow::ensure!(
        project_id == payload.project_id && run_id == payload.run_id,
        "proposal revision mismatch for run/project"
    );
    if !current_chronicle_run_spec_for_run(conn, &project_id, &run_id)? {
        return Ok(());
    }
    let plan_authority = load_current_chronicle_proposal_matches(
        conn,
        &project_id,
        &run_id,
        &proposal_set_id,
    )?
    .remove(&proposal_key)
    .ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: current Proposal has no sealed match metadata"
        )
    })?;
    let match_status = plan_authority
        .match_value
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: sealed match has no status"
            )
        })?;
    anyhow::ensure!(
        matches!(match_status, "none" | "probable-duplicate"),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: unsupported sealed match status '{match_status}'"
    );
    if proposal_status == "deferred"
        && decision_value.get("reason").and_then(Value::as_str) == Some("already-satisfied")
    {
        anyhow::bail!(
            "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: current Chronicle Proposal cannot be terminalized as deferred/already-satisfied; the planner omits already-satisfied hypotheses instead of creating a Proposal"
        );
    }
    let revision_review_authority =
        load_verified_chronicle_revision_review_authority(conn, &project_id, &run_id)?;
    let current_revision_requires_probable_duplicate_review =
        current_chronicle_revision_requires_probable_duplicate_review(
            conn,
            &revision_review_authority,
            &proposal_set_id,
            &payload.proposal_id,
            &payload.revision_id,
            &plan_authority.planned_title,
        )?;
    let requires_probable_duplicate_choice =
        match_status == "probable-duplicate" || current_revision_requires_probable_duplicate_review;
    if !requires_probable_duplicate_choice {
        return Ok(());
    }
    let expected_choice = match proposal_status {
        "approved" => "create-as-new",
        "rejected" => "skip-as-same",
        "held" => "hold",
        "deferred" => anyhow::bail!(
            "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: current-revision probable-duplicate Decision 'deferred' cannot replace an explicit create-as-new, skip-as-same, or hold choice"
        ),
        _ => return Ok(()),
    };
    anyhow::ensure!(
        decision_value
            .get("probableDuplicateChoice")
            .and_then(Value::as_str)
            == Some(expected_choice),
        "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: current-revision probable-duplicate Decision '{proposal_status}' requires decisionJson.probableDuplicateChoice='{expected_choice}'"
    );
    Ok(())
}

/// Atomically append a revision then a decision that references the new revision.
/// One `with_immediate_transaction` guards both writes, so an approve can never
/// leave a fresh revision without its decision (or vice versa).
pub fn revise_and_decide(db: &Database, payload: ReviseAndDecidePayload) -> anyhow::Result<Value> {
    revise_and_decide_with_actor(
        db,
        payload,
        TrustedDecisionActor::Automated {
            actor_id: "electron:automated-review".to_string(),
        },
        &mut super::source_revision::ForegroundValidationControl,
    )
}

/// Native foreground variant. The revision and decision stay in one
/// transaction, while every eligibility Source read borrows the same
/// lifecycle-owned validation control as the caller.
pub fn revise_and_decide_with_control(
    db: &Database,
    payload: ReviseAndDecidePayload,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    revise_and_decide_with_actor(
        db,
        payload,
        TrustedDecisionActor::Automated {
            actor_id: "electron:automated-review".to_string(),
        },
        validation_owner,
    )
}

pub fn revise_and_decide_as_human(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    revise_and_decide_with_actor(
        db,
        payload,
        TrustedDecisionActor::Human {
            actor_id: "electron:human-review".to_string(),
        },
        &mut super::source_revision::ForegroundValidationControl,
    )
}

pub fn revise_and_decide_as_human_with_control(
    db: &Database,
    payload: ReviseAndDecidePayload,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    revise_and_decide_with_actor(
        db,
        payload,
        TrustedDecisionActor::Human {
            actor_id: "electron:human-review".to_string(),
        },
        validation_owner,
    )
}

fn revise_and_decide_with_actor(
    db: &Database,
    payload: ReviseAndDecidePayload,
    actor: TrustedDecisionActor,
    validation_owner: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            validation_owner.check(super::nir1_entity_relation_index::GraphWorkStage::Source)?;
            let revision_payload = AppendRevisionPayload {
                run_id: payload.run_id.clone(),
                project_id: payload.project_id.clone(),
                proposal_id: payload.proposal_id.clone(),
                payload_json: payload.payload_json.clone(),
                expected_current_revision_id: payload.expected_current_revision_id.clone(),
                created_by: payload.created_by.clone(),
                reconciliation_envelope: payload.reconciliation_envelope.clone(),
                inherit_reconciliation_envelope: payload.inherit_reconciliation_envelope.clone(),
            };
            let revision = append_revision_on_conn(conn, &revision_payload, validation_owner)?;
            let revision_id = revision["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("revise_and_decide: missing revisionId"))?
                .to_string();
            let revision_number = revision["revisionNumber"].clone();

            let decision_payload = AppendDecisionPayload {
                run_id: payload.run_id.clone(),
                project_id: payload.project_id.clone(),
                proposal_id: payload.proposal_id.clone(),
                revision_id: revision_id.clone(),
                decision: payload.decision.clone(),
                decision_json: payload.decision_json.clone(),
                created_by: payload.created_by.clone(),
            };
            let decision = append_decision_on_conn(conn, &decision_payload, &actor)?;
            let decision_id = decision["decisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("revise_and_decide: missing decisionId"))?
                .to_string();

            Ok(json!({
                "proposalId": payload.proposal_id,
                "revisionId": revision_id,
                "revisionNumber": revision_number,
                "decisionId": decision_id,
                "decision": payload.decision,
                "status": decision["status"].clone(),
            }))
        })
    })
}

fn map_decision_to_status(decision: &str) -> anyhow::Result<&'static str> {
    match decision {
        "approved" => Ok("approved"),
        "rejected" => Ok("rejected"),
        "deferred" => Ok("deferred"),
        "held" => Ok("held"),
        other => anyhow::bail!("unsupported proposal decision: {other}"),
    }
}

pub(crate) fn row_to_run_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let outcome_summary_json = row
        .get::<_, Option<String>>("outcome_summary_json")?
        .map(parse_json_column)
        .transpose()?;
    Ok(json!({
        "runId": row.get::<_, String>("id")?,
        "projectId": row.get::<_, String>("project_id")?,
        "surfacePathId": row.get::<_, String>("surface_path_id")?,
        "scopeJson": parse_json_column(row.get::<_, String>("scope_json")?)?,
        "specJson": parse_json_column(row.get::<_, String>("spec_json")?)?,
        "specDigest": row.get::<_, String>("spec_digest")?,
        "snapshotDigest": row.get::<_, Option<String>>("snapshot_digest")?,
        "catalogDigest": row.get::<_, Option<String>>("catalog_digest")?,
        "registryDigest": row.get::<_, Option<String>>("registry_digest")?,
        "status": row.get::<_, String>("status")?,
        "coverageJson": parse_json_column(row.get::<_, String>("coverage_json")?)?,
        "outcomeSummaryJson": outcome_summary_json,
        "createdAt": row.get::<_, String>("created_at")?,
        "startedAt": row.get::<_, Option<String>>("started_at")?,
        "completedAt": row.get::<_, Option<String>>("completed_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

pub(crate) fn row_to_task_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let output_json = row
        .get::<_, Option<String>>("output_json")?
        .map(parse_json_column)
        .transpose()?;
    Ok(json!({
        "taskId": row.get::<_, String>("id")?,
        "runId": row.get::<_, String>("run_id")?,
        "taskKind": row.get::<_, String>("task_kind")?,
        "status": row.get::<_, String>("status")?,
        "inputJson": parse_json_column(row.get::<_, String>("input_json")?)?,
        "outputJson": output_json,
        "priority": row.get::<_, i64>("priority")?,
        "attemptCount": row.get::<_, i64>("attempt_count")?,
        "leaseOwner": row.get::<_, Option<String>>("lease_owner")?,
        "leaseExpiresAt": row.get::<_, Option<String>>("lease_expires_at")?,
        "heartbeatAt": row.get::<_, Option<String>>("heartbeat_at")?,
        "errorMessage": row.get::<_, Option<String>>("error_message")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "startedAt": row.get::<_, Option<String>>("started_at")?,
        "completedAt": row.get::<_, Option<String>>("completed_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

fn parse_json_column(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn row_to_artifact_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let payload_json = row
        .get::<_, Option<String>>("payload_json")?
        .map(parse_json_column)
        .transpose()?;
    Ok(json!({
        "artifactId": row.get::<_, String>("id")?,
        "runId": row.get::<_, String>("run_id")?,
        "taskId": row.get::<_, Option<String>>("task_id")?,
        "attemptId": row.get::<_, Option<String>>("attempt_id")?,
        "artifactKind": row.get::<_, String>("artifact_kind")?,
        "payloadStorage": row.get::<_, String>("payload_storage")?,
        "payloadJson": payload_json,
        "payloadRef": row.get::<_, Option<String>>("payload_ref")?,
        "payloadDigest": row.get::<_, Option<String>>("payload_digest")?,
        "createdAt": row.get::<_, String>("created_at")?,
    }))
}

fn row_to_proposal_set_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "proposalSetId": row.get::<_, String>("id")?,
        "runId": row.get::<_, String>("run_id")?,
        "projectId": row.get::<_, String>("project_id")?,
        "setKind": row.get::<_, String>("set_kind")?,
        "status": row.get::<_, String>("status")?,
        "summaryJson": parse_json_column(row.get::<_, String>("summary_json")?)?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

fn row_to_proposal_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let envelope_json = row.get::<_, Option<String>>(11)?;
    let envelope_schema_version = envelope_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|envelope| envelope_schema_version(&envelope));
    Ok(json!({
        "proposalId": row.get::<_, String>("id")?,
        "proposalSetId": row.get::<_, String>("proposal_set_id")?,
        "proposalKey": row.get::<_, String>("proposal_key")?,
        "kind": row.get::<_, String>("kind")?,
        "status": row.get::<_, String>("status")?,
        "payloadJson": parse_json_column(row.get::<_, String>("payload_json")?)?,
        "currentRevisionId": row.get::<_, Option<String>>("current_revision_id")?,
        "originKind": row.get::<_, Option<String>>("origin_kind")?,
        "reconciliationEnvelopeDigest": row.get::<_, Option<String>>("reconciliation_envelope_digest")?,
        "reconciliationEnvelopeSchemaVersion": envelope_schema_version,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

fn row_to_decision_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "decisionId": row.get::<_, String>("id")?,
        "proposalId": row.get::<_, String>("proposal_id")?,
        "revisionId": row.get::<_, String>("revision_id")?,
        "decision": row.get::<_, String>("decision")?,
        "decisionJson": parse_json_column(row.get::<_, String>("decision_json")?)?,
        "createdAt": row.get::<_, String>("created_at")?,
        "createdBy": row.get::<_, String>("created_by")?,
        "actorKind": row.get::<_, String>("actor_kind")?,
        "actorId": row.get::<_, String>("actor_id")?,
        "authorityScope": row.get::<_, String>("authority_scope")?,
        "overrideFieldPaths": parse_json_column(row.get::<_, String>("override_field_paths_json")?)?,
    }))
}

/// Test-only DDL helper until migrate.rs adds the production tables.
pub fn ensure_test_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_data_migrations (
            migration_id     TEXT NOT NULL,
            contract_version INTEGER NOT NULL CHECK(contract_version > 0),
            applied_at       TEXT NOT NULL,
            PRIMARY KEY(migration_id)
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            surface_path_id TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            spec_json TEXT NOT NULL,
            spec_digest TEXT NOT NULL,
            snapshot_digest TEXT,
            catalog_digest TEXT,
            registry_digest TEXT,
            semantic_epoch_id TEXT,
            status TEXT NOT NULL,
            coverage_json TEXT NOT NULL DEFAULT '{}',
            outcome_summary_json TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_tasks (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            task_kind TEXT NOT NULL,
            status TEXT NOT NULL,
            input_json TEXT NOT NULL DEFAULT '{}',
            output_json TEXT,
            priority INTEGER NOT NULL DEFAULT 0,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            lease_owner TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_task_edges (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            from_task_id TEXT NOT NULL,
            to_task_id TEXT NOT NULL,
            edge_kind TEXT NOT NULL DEFAULT 'depends_on',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_attempts (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_message TEXT,
            output_json TEXT
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            task_id TEXT,
            attempt_id TEXT,
            artifact_kind TEXT NOT NULL,
            payload_storage TEXT NOT NULL DEFAULT 'inline-json',
            payload_json TEXT,
            payload_ref TEXT,
            payload_digest TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_sets (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            set_kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            summary_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_proposals (
            id TEXT PRIMARY KEY,
            proposal_set_id TEXT NOT NULL,
            proposal_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unreviewed',
            payload_json TEXT NOT NULL,
            current_revision_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_revisions (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            revision_number INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            plan_fragment_json TEXT,
            plan_fragment_digest TEXT,
            origin_kind TEXT NOT NULL DEFAULT 'legacy-unbound',
            reconciliation_envelope_json TEXT,
            reconciliation_envelope_digest TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_revision_source_basis (
            revision_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            source_kind TEXT NOT NULL,
            source_key TEXT NOT NULL,
            revision_token TEXT NOT NULL,
            observed_at TEXT,
            PRIMARY KEY (revision_id, ordinal),
            UNIQUE (revision_id, source_key)
        );
        CREATE TABLE IF NOT EXISTS narrative_projection_freshness (
            application_id TEXT PRIMARY KEY,
            status TEXT NOT NULL
                CHECK(status IN ('fresh','stale','source-missing','anchor-mismatch','read-set-drift')),
            reason_json TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_projection_dependencies (
            application_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_key TEXT NOT NULL,
            observed_revision_token TEXT NOT NULL,
            propagation TEXT NOT NULL CHECK(propagation = 'freshness-only'),
            PRIMARY KEY (application_id, source_kind, source_key)
        );
        CREATE TABLE IF NOT EXISTS narrative_field_authority (
            project_id TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            field_path TEXT NOT NULL,
            owner_kind TEXT NOT NULL
                CHECK(owner_kind IN ('human','ai','system','unknown')),
            explicit_lock INTEGER NOT NULL DEFAULT 0
                CHECK(explicit_lock IN (0,1)),
            version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, entity_kind, entity_id, field_path)
        );
        CREATE INDEX IF NOT EXISTS idx_narrative_field_authority_entity
            ON narrative_field_authority(project_id, entity_kind, entity_id);
        CREATE TABLE IF NOT EXISTS narrative_proposal_decisions (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            decision_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            actor_kind TEXT NOT NULL DEFAULT 'human',
            actor_id TEXT NOT NULL DEFAULT 'legacy-review',
            authority_scope TEXT NOT NULL DEFAULT 'legacy-review',
            override_field_paths_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS narrative_apply_commits (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            run_id TEXT,
            proposal_set_id TEXT,
            request_id TEXT NOT NULL,
            plan_digest TEXT NOT NULL,
            status TEXT NOT NULL,
            receipt_json TEXT,
            error_message TEXT,
            prepared_plan_json TEXT,
            prepared_policy_version INTEGER,
            prepared_at TEXT,
            authority_digest TEXT,
            session_id TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_apply_operations (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            operation_index INTEGER NOT NULL,
            operation_kind TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            result_entity_kind TEXT,
            result_entity_id TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_applications (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            proposal_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            applied_entity_kind TEXT NOT NULL,
            applied_entity_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            application_kind TEXT NOT NULL DEFAULT 'normal'
                CHECK(application_kind IN ('normal','compensation')),
            compensates_application_id TEXT,
            CHECK (
                (application_kind = 'normal' AND compensates_application_id IS NULL)
                OR
                (application_kind = 'compensation' AND compensates_application_id IS NOT NULL)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_narrative_compensation_target
            ON narrative_proposal_applications(compensates_application_id)
            WHERE application_kind = 'compensation'
              AND compensates_application_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS narrative_commit_journals (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT,
            created_at TEXT NOT NULL
        );",
    )?;
    conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS narrative_revision_immutable_after_apply_update
            BEFORE UPDATE ON narrative_proposal_revisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications WHERE revision_id = OLD.id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_REVISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_revision_envelope_immutable_update
            BEFORE UPDATE ON narrative_proposal_revisions
            WHEN OLD.origin_kind IS NOT NEW.origin_kind
              OR OLD.reconciliation_envelope_json IS NOT NEW.reconciliation_envelope_json
              OR OLD.reconciliation_envelope_digest IS NOT NEW.reconciliation_envelope_digest
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_ENVELOPE_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_proposal_revisions_v2_immutable_update_guard
            BEFORE UPDATE ON narrative_proposal_revisions
            WHEN OLD.origin_kind = 'enveloped'
             AND json_extract(OLD.reconciliation_envelope_json, '$.schemaVersion') = 2
             AND (
                OLD.id IS NOT NEW.id
                OR OLD.proposal_id IS NOT NEW.proposal_id
                OR OLD.revision_number IS NOT NEW.revision_number
                OR OLD.payload_json IS NOT NEW.payload_json
                OR OLD.plan_fragment_json IS NOT NEW.plan_fragment_json
                OR OLD.plan_fragment_digest IS NOT NEW.plan_fragment_digest
                OR OLD.origin_kind IS NOT NEW.origin_kind
                OR OLD.reconciliation_envelope_json IS NOT NEW.reconciliation_envelope_json
                OR OLD.reconciliation_envelope_digest IS NOT NEW.reconciliation_envelope_digest
                OR OLD.created_at IS NOT NEW.created_at
                OR OLD.created_by IS NOT NEW.created_by
             )
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_V2_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_source_basis_immutable_update
            BEFORE UPDATE ON narrative_revision_source_basis
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_SOURCE_BASIS_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_source_basis_immutable_delete
            BEFORE DELETE ON narrative_revision_source_basis
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications
                 WHERE revision_id = OLD.revision_id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_SOURCE_BASIS_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_revision_immutable_after_apply_delete
            BEFORE DELETE ON narrative_proposal_revisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications WHERE revision_id = OLD.id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_REVISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_decision_immutable_after_apply_update
            BEFORE UPDATE ON narrative_proposal_decisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications
                 WHERE proposal_id = OLD.proposal_id AND revision_id = OLD.revision_id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_DECISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_decision_immutable_after_apply_delete
            BEFORE DELETE ON narrative_proposal_decisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications
                 WHERE proposal_id = OLD.proposal_id AND revision_id = OLD.revision_id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_DECISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_immutable_update
            BEFORE UPDATE ON narrative_proposal_applications
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLICATION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_immutable_delete
            BEFORE DELETE ON narrative_proposal_applications
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLICATION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_kind_guard
            BEFORE INSERT ON narrative_proposal_applications
            WHEN NEW.application_kind NOT IN ('normal','compensation')
            BEGIN SELECT RAISE(ABORT, 'NEX_APPLICATION_KIND_INVALID'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_compensation_guard
            BEFORE INSERT ON narrative_proposal_applications
            WHEN (NEW.application_kind = 'normal' AND NEW.compensates_application_id IS NOT NULL)
              OR (NEW.application_kind = 'compensation' AND NEW.compensates_application_id IS NULL)
            BEGIN SELECT RAISE(ABORT, 'NEX_APPLICATION_COMPENSATION_SHAPE_INVALID'); END;",
    )?;
    Ok(())
}

#[cfg(test)]
mod unit_tests {
    use super::super::{
        transition_run_status_in_tx, ApplyCommitPayload, ClaimTaskPayload, CommitApplicationRef,
        CommitOperation, FailTaskPayload, FinishTaskPayload, NarrativeRunStatus,
        PrepareCommitPayload,
    };
    use super::*;
    use crate::{
        load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
        SetNarrativeRuntimePolicyInput,
    };
    use serde_json::json;

    #[test]
    fn project_creation_reservations_count_and_release_without_run_id_leaks() {
        let project_id = format!("lifecycle-reservation-{}", Uuid::new_v4());
        assert!(!project_creation_reservation_active(&project_id));
        try_reserve_project_creation(&project_id).expect("first reservation");
        try_reserve_project_creation(&project_id).expect("second reservation");
        assert!(project_creation_reservation_active(&project_id));
        release_project_creation(&project_id);
        assert!(project_creation_reservation_active(&project_id));
        release_project_creation(&project_id);
        assert!(!project_creation_reservation_active(&project_id));
        // An extra release is a no-op, which keeps error paths idempotent.
        release_project_creation(&project_id);
    }

    #[test]
    fn project_creation_and_destructive_admission_share_one_boundary() {
        let project_id = format!("lifecycle-destructive-{}", Uuid::new_v4());
        try_reserve_project_creation(&project_id).expect("creation reservation");
        assert!(try_reserve_project_destructive_permit(&project_id).is_err());
        release_project_creation(&project_id);

        try_reserve_project_destructive_permit(&project_id)
            .expect("destructive reservation after creation release");
        assert!(try_reserve_project_creation(&project_id).is_err());
        assert!(project_destructive_permit_active(&project_id));
        release_project_destructive_permit(&project_id);
        assert!(!project_destructive_permit_active(&project_id));
    }

    #[test]
    fn v2_evidence_binding_accepts_multiple_anchors_on_one_document() {
        let envelope = json!({
            "effectiveMaterialBasis": {
                "evidenceSet": [
                    { "evidenceRef": "anchor:two", "documentRef": "D000001" },
                    { "evidenceRef": "anchor:one", "documentRef": "D000001" },
                ],
            },
        });
        let proposal = json!({
            "evidenceAnchorIds": ["anchor:one", "anchor:two"],
            "evidenceDocumentRefs": ["D000001"],
        });
        ensure_v2_proposal_evidence_binding(&envelope, &proposal)
            .expect("two anchors may bind the same unique evidence document");

        let malformed_duplicate_documents = json!({
            "evidenceAnchorIds": ["anchor:one", "anchor:two"],
            "evidenceDocumentRefs": ["D000001", "D000001"],
        });
        let error = ensure_v2_proposal_evidence_binding(&envelope, &malformed_duplicate_documents)
            .expect_err("Proposal evidenceDocumentRefs itself remains unique");
        assert!(error
            .to_string()
            .contains("NEX_ENVELOPE_PROVENANCE_MISMATCH"));
    }

    fn test_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.with_conn(|conn| {
            conn.execute(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'p')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            // Current Chronicle Task claims now CAS their sealed catalog
            // against the live Event authority. Keep the narrow unit schema
            // representative of the columns used by that production read.
            conn.execute_batch(
                "CREATE TABLE events (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    note TEXT,
                    ordinal TEXT NOT NULL DEFAULT 'a0',
                    start_time INTEGER,
                    end_time INTEGER,
                    version INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE narrative_semantic_index_metadata (
                    project_id TEXT NOT NULL,
                    index_key TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    dirty_cache_flag INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (project_id, index_key)
                );",
            )?;
            ensure_test_schema(conn)
        })
        .expect("seed test schema");
        db
    }

    /// `ensure_test_schema` above is a hand-rolled, deliberately narrow
    /// schema subset for fast isolated tests -- it has no `tree_nodes` and
    /// no Gate C2 tables (`narrative_dependency_edges`, ...). Tests that
    /// exercise a real Reconciliation Envelope's `sourceBasis` (which
    /// re-resolves Source revisions against real domain tables, e.g.
    /// `scene-body` against `tree_nodes`) or Dependency Edge recording need
    /// the full real migration instead, matching every `tests/*.rs`
    /// integration test's own `migrated_db()` helper.
    fn full_migrated_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate");
        seed_full_db(db)
    }

    fn current_schema_full_db() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        seed_full_db(db)
    }

    fn seed_full_db(db: Database) -> Database {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    fn insert_automatic_run_for_api_test(db: &Database, run_id: &str, run_kind: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, started_at, run_kind,
                     semantic_epoch_id, work_key, version)
                 VALUES (?1, 'project-1', ?2, '{}', '{}', 'digest', 'running', '{}',
                         '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z', ?2,
                         NULL, ?1, 0)",
                params![run_id, run_kind],
            )?;
            if run_kind == "freshness-evaluation" {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET consumer_id = ?2 WHERE id = ?1",
                    params![run_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
                )?;
            }
            Ok(())
        })
        .expect("insert automatic Run");
    }

    fn insert_imported_run_with_lifecycle(
        db: &Database,
        run_id: &str,
        created_at: &str,
        started_at: Option<&str>,
        completed_at: Option<&str>,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, started_at, completed_at, version)
                 VALUES (?1, 'project-1', 'chronicle.extract', '{}', '{}', 'imported',
                         'completed', '{}', ?2, ?3, ?4, 0)",
                params![run_id, created_at, started_at, completed_at],
            )?;
            Ok(())
        })
        .expect("insert imported lifecycle Run");
    }

    fn run_lifecycle(db: &Database, run_id: &str) -> (String, Option<String>, Option<String>) {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT created_at, started_at, completed_at
                   FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("read Run lifecycle")
    }

    fn create_run_with_task(db: &Database, run_id: &str, task_id: &str) {
        create_run(
            db,
            CreateRunPayload {
                run_id: Some(run_id.to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: format!("spec-{run_id}"),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![CreateTaskSeed {
                    task_id: Some(task_id.to_string()),
                    task_kind: "extract".to_string(),
                    input_json: Some(json!({})),
                    priority: None,
                }],
            },
        )
        .expect("create manual Run with task");
    }

    fn test_sha256(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn current_chronicle_create_payload_with_mode(
        run_id: &str,
        execution_mode: &str,
    ) -> CreateRunPayload {
        let catalog_digest = canonical_json_digest(&json!({
            "kind": CHRONICLE_EXISTING_EVENTS_CATALOG_KIND,
            "events": [],
        }))
        .expect("canonical empty live Chronicle catalog");
        let spec_json = json!({
            "kind": CHRONICLE_RUN_SPEC_KIND,
            "domain": "chronicle",
            "version": 2,
            "taskChain": CHRONICLE_EXTRACT_TASK_CHAIN,
            "executionMode": execution_mode,
            "existingEventsCatalogDigest": catalog_digest,
            "coordinatorContractDigest": test_sha256('b'),
        });
        let spec_digest = canonical_json_digest(&spec_json).expect("canonical current Run spec");
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: CHRONICLE_EXTRACT_SURFACE_PATH.to_string(),
            scope_json: json!({ "folderId": "folder-1", "sceneIds": ["scene-1"] }),
            spec_json,
            spec_digest,
            snapshot_digest: Some(test_sha256('c')),
            catalog_digest: Some(catalog_digest),
            registry_digest: None,
            coverage_json: Some(json!({ "mode": "complete" })),
            tasks: CHRONICLE_EXTRACT_TASK_CHAIN
                .iter()
                .enumerate()
                .map(|(index, task_kind)| CreateTaskSeed {
                    task_id: Some(format!("{run_id}-task-{index}")),
                    task_kind: (*task_kind).to_string(),
                    input_json: Some(json!({ "stage": index + 1 })),
                    priority: Some((CHRONICLE_EXTRACT_TASK_CHAIN.len() - index) as i64),
                })
                .collect(),
        }
    }

    fn current_chronicle_create_payload(run_id: &str) -> CreateRunPayload {
        current_chronicle_create_payload_with_mode(run_id, "deterministic-fallback")
    }

    fn create_current_chronicle_run(db: &Database, run_id: &str) {
        create_run(db, current_chronicle_create_payload(run_id))
            .expect("create current Chronicle Run");
    }

    fn current_chronicle_candidate_payload(
        run_id: &str,
        project_id: &str,
        catalog: &Value,
    ) -> CreateRunPayload {
        let catalog_digest = canonical_json_digest(catalog).expect("canonical test catalog");
        let mut payload = current_chronicle_create_payload(run_id);
        payload.project_id = project_id.to_string();
        payload.snapshot_digest = Some(
            test_candidate_snapshot_payload_for_scenes(project_id, &["scene-1"], None)["snapshot"]
                ["digest"]
                .as_str()
                .expect("sealed candidate snapshot digest")
                .to_string(),
        );
        payload.catalog_digest = Some(catalog_digest.clone());
        payload.spec_json["existingEventsCatalogDigest"] = json!(catalog_digest);
        payload.spec_digest =
            canonical_json_digest(&payload.spec_json).expect("canonical candidate Run spec");
        payload
    }

    fn test_existing_events_catalog(title: &str) -> Value {
        json!({
            "kind": "chronicle.existing-events-catalog@1",
            "events": [{
                "ref": "event:existing",
                "sourceKey": "event:existing",
                "title": title,
                "note": null,
                "version": 1,
                "linkedDocumentSourceKeys": [],
                "participantEntityRefs": [],
                "startTime": null,
                "endTime": null,
                "digest": "sha256:event:existing",
                "applicationProvenanceKeys": [],
            }],
        })
    }

    fn seed_live_existing_events_catalog(db: &Database, catalog: &Value) {
        let events = catalog["events"]
            .as_array()
            .expect("test existing-event catalog events");
        db.with_conn(|conn| {
            for (index, event) in events.iter().enumerate() {
                conn.execute(
                    "INSERT INTO events
                        (id, project_id, title, note, ordinal, start_time, end_time, version)
                     VALUES (?1, 'project-1', ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        event["ref"].as_str(),
                        event["title"].as_str(),
                        event["note"].as_str(),
                        format!("a{index}"),
                        event["startTime"].as_i64(),
                        event["endTime"].as_i64(),
                        event["version"].as_i64(),
                    ],
                )?;
            }
            Ok(())
        })
        .expect("seed live existing-event authority");
    }

    fn test_candidate_snapshot_payload_for_scenes(
        project_id: &str,
        scene_ids: &[&str],
        catalog: Option<&Value>,
    ) -> Value {
        let documents = scene_ids
            .iter()
            .enumerate()
            .map(|(index, scene_id)| {
                let document_ref = format!("D{:06}", index + 1);
                let source_key = format!("project:scene:{scene_id}");
                let title = format!("Scene {index}");
                let projection = json!({
                    "schemaVersion": 1,
                    "unit": "utf16",
                    "canonicalLength": 0,
                    "segments": [],
                });
                let origin = json!({
                    "kind": "project-node",
                    "projectId": project_id,
                    "nodeId": scene_id,
                    "sourceVersion": 0,
                    "sourceUpdatedAt": "2026-08-26T00:00:00.000Z",
                    "sourceUri": null,
                });
                let content_digest = canonical_json_digest(&json!({
                    "normalizerVersion": "gdx-canonical-text/1",
                    "text": "",
                }))
                .expect("seal candidate document content");
                let document_digest = canonical_json_digest(&json!({
                    "normalizerVersion": "gdx-canonical-text/1",
                    "parentSourceKey": null,
                    "title": title,
                    "orderIndex": index,
                    "canonical": {"text": "", "blocks": []},
                }))
                .expect("seal candidate document");
                let artifact_digest = canonical_json_digest(&json!({
                    "schemaVersion": 1,
                    "normalizerVersion": "gdx-canonical-text/1",
                    "sourceKey": source_key,
                    "parentSourceKey": null,
                    "semanticDigest": document_digest,
                    "contentDigest": content_digest,
                    "projection": projection,
                    "origin": origin,
                }))
                .expect("seal candidate document artifact");
                json!({
                    "ref": document_ref,
                    "sourceKey": source_key,
                    "parentRef": null,
                    "title": title,
                    "orderIndex": index,
                    "canonical": {
                        "unit": "utf16",
                        "text": "",
                        "blocks": [],
                        "projection": projection,
                        "projectionMap": projection,
                        "diagnostics": [],
                    },
                    "contentDigest": content_digest,
                    "documentDigest": document_digest,
                    "artifactDigest": artifact_digest,
                    "origin": origin,
                })
            })
            .collect::<Vec<_>>();
        let omissions = json!([]);
        let snapshot_digest = canonical_json_digest(&json!({
            "schemaVersion": 1,
            "language": "ja",
            "normalizerVersion": "gdx-canonical-text/1",
            "documentDigests": documents
                .iter()
                .map(|document| document["documentDigest"].clone())
                .collect::<Vec<_>>(),
            "omissions": omissions,
        }))
        .expect("seal candidate snapshot");
        let snapshot_artifact_digest = canonical_json_digest(&json!({
            "schemaVersion": 1,
            "normalizerVersion": "gdx-canonical-text/1",
            "semanticDigest": snapshot_digest,
            "originProjectId": project_id,
            "documents": documents
                .iter()
                .map(|document| json!({
                    "sourceKey": document["sourceKey"].clone(),
                    "artifactDigest": document["artifactDigest"].clone(),
                }))
                .collect::<Vec<_>>(),
            "omissions": omissions,
        }))
        .expect("seal candidate snapshot artifact");
        let source_views = documents.first().map_or_else(Vec::new, |document| {
            let source_view_digest = canonical_json_digest(&json!({
                "schemaVersion": 1,
                "ref": "SV000001",
                "documentRef": document["ref"].clone(),
                "documentArtifactDigest": document["artifactDigest"].clone(),
                "documentRange": {"start": 0, "end": 0},
                "text": "",
            }))
            .expect("seal candidate source view");
            vec![json!({
                "ref": "SV000001",
                "documentRef": document["ref"].clone(),
                "documentRange": {"start": 0, "end": 0},
                "text": "",
                "digest": source_view_digest,
            })]
        });
        let authority_documents = documents
            .iter()
            .map(|document| {
                json!({
                    "documentRef": document["ref"].clone(),
                    "sourceKey": document["sourceKey"].clone(),
                    "rawStoryKey": null,
                })
            })
            .collect::<Vec<_>>();
        let mut payload = json!({
            "snapshot": {
                "schemaVersion": 1,
                "id": "snapshot-task-resume-candidate",
                "snapshotId": "snapshot-task-resume-candidate",
                "createdAt": "2026-08-26T00:00:00.000Z",
                "language": "ja",
                "normalizerVersion": "gdx-canonical-text/1",
                "digest": snapshot_digest,
                "artifactDigest": snapshot_artifact_digest,
                "origin": {
                    "kind": "grimodex-project",
                    "projectId": project_id,
                },
                "documents": documents,
                "omissions": omissions,
            },
            "sourceViews": source_views,
            "scopeAuthorityDocuments": authority_documents,
        });
        if let Some(catalog) = catalog {
            payload["existingEventsCatalog"] = catalog.clone();
        }
        payload
    }

    fn test_candidate_snapshot_payload(snapshot_digest: &str, catalog: Option<&Value>) -> Value {
        let payload =
            test_candidate_snapshot_payload_for_scenes("project-1", &["scene-1"], catalog);
        assert_eq!(
            payload["snapshot"]["digest"], snapshot_digest,
            "test Run must bind the canonical candidate snapshot digest"
        );
        payload
    }

    fn test_candidate_snapshot_output(
        run_id: &str,
        project_id: &str,
        snapshot_payload: &Value,
    ) -> Value {
        let snapshot_digest = snapshot_payload["snapshot"]["digest"]
            .as_str()
            .expect("snapshot digest");
        let authority_inputs = snapshot_payload["scopeAuthorityDocuments"]
            .as_array()
            .expect("scope authority documents")
            .iter()
            .map(|document| NarrativeScopeAuthorityDocumentInputV2 {
                document_ref: document["documentRef"]
                    .as_str()
                    .expect("authority document ref")
                    .to_string(),
                source_key: document["sourceKey"]
                    .as_str()
                    .expect("authority source key")
                    .to_string(),
                raw_story_key: document["rawStoryKey"].as_str().map(str::to_string),
            })
            .collect::<Vec<_>>();
        let composite_digest = if authority_inputs.is_empty() {
            None
        } else {
            Some(
                build_narrative_scope_authority_basis_v2(
                    project_id,
                    run_id,
                    snapshot_digest,
                    &authority_inputs,
                )
                .expect("build candidate Scope authority basis")
                .digests
                .composite_digest,
            )
        };
        json!({
            "snapshotDigest": snapshot_digest,
            "documentCount": snapshot_payload["snapshot"]["documents"]
                .as_array()
                .expect("snapshot documents")
                .len(),
            "corpusPayloadDigest": canonical_json_digest(snapshot_payload)
                .expect("candidate corpus payload digest"),
            "scopeAuthorityCompositeDigest": composite_digest,
        })
    }

    fn complete_candidate_task_with_artifact(
        db: &Database,
        run_id: &str,
        task_kind: &str,
        artifact_kind: &str,
        artifact_payload: Value,
        output_json: Value,
    ) {
        db.with_conn(|conn| {
            let task_id: String = conn.query_row(
                "SELECT id FROM narrative_extraction_tasks
                  WHERE run_id = ?1 AND task_kind = ?2",
                params![run_id, task_kind],
                |row| row.get(0),
            )?;
            let attempt_id = format!("{task_id}-candidate-attempt");
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed', output_json = ?2, attempt_count = 1,
                        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                        started_at = '2026-08-26T00:00:00.000Z',
                        completed_at = '2026-08-26T00:00:01.000Z'
                  WHERE id = ?1",
                params![task_id, serde_json::to_string(&output_json)?],
            )?;
            insert_attempt(
                conn,
                &attempt_id,
                &task_id,
                1,
                "completed",
                "2026-08-26T00:00:00.000Z",
            )?;
            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET completed_at = '2026-08-26T00:00:01.000Z', output_json = ?2
                  WHERE id = ?1",
                params![attempt_id, serde_json::to_string(&output_json)?],
            )?;
            insert_artifacts_for_attempt(
                conn,
                run_id,
                &task_id,
                &attempt_id,
                &[ArtifactInput {
                    artifact_id: Some(format!("{task_id}-{artifact_kind}")),
                    artifact_kind: artifact_kind.to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(artifact_payload.clone()),
                    payload_ref: None,
                    payload_digest: Some(canonical_json_digest(&artifact_payload)?),
                }],
            )?;
            Ok(())
        })
        .expect("complete candidate prefix Task");
    }

    fn list_task_resume_candidates(db: &Database, project_id: &str) -> anyhow::Result<Value> {
        list_chronicle_task_resume_candidates(
            db,
            super::super::models::ListChronicleTaskResumeCandidatesPayload {
                project_id: project_id.to_string(),
                limit: Some(20),
            },
        )
    }

    fn seed_ready_observation_candidate(db: &Database, run_id: &str, catalog: &Value) -> String {
        seed_live_existing_events_catalog(db, catalog);
        let payload = current_chronicle_candidate_payload(run_id, "project-1", catalog);
        let snapshot_digest = payload
            .snapshot_digest
            .clone()
            .expect("candidate snapshot digest");
        create_run(db, payload).expect("create task-resume candidate Run");
        let snapshot_payload = test_candidate_snapshot_payload(&snapshot_digest, Some(catalog));
        let snapshot_output =
            test_candidate_snapshot_output(run_id, "project-1", &snapshot_payload);
        complete_candidate_task_with_artifact(
            db,
            run_id,
            "source.snapshot@1",
            "source.snapshot@1",
            snapshot_payload,
            snapshot_output,
        );
        complete_candidate_task_with_artifact(
            db,
            run_id,
            "source.window-plan@1",
            "source.window-plan@1",
            json!({ "windows": [] }),
            json!({ "windowCount": 0 }),
        );
        snapshot_digest
    }

    type ChronicleRunTaskLedgerState = (String, i64, Vec<(String, String, i64)>, i64, i64, i64);

    fn chronicle_run_task_ledger_state(db: &Database, run_id: &str) -> ChronicleRunTaskLedgerState {
        db.with_conn(|conn| {
            let (run_status, run_version) = conn.query_row(
                "SELECT status, version FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let tasks = conn
                .prepare(
                    "SELECT task_kind, status, version
                       FROM narrative_extraction_tasks
                      WHERE run_id = ?1
                      ORDER BY task_kind ASC",
                )?
                .query_map(params![run_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let attempt_count = conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_extraction_attempts attempt
                   JOIN narrative_extraction_tasks task ON task.id = attempt.task_id
                  WHERE task.run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )?;
            let artifact_count = conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_artifacts WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )?;
            let proposal_set_count = conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )?;
            Ok((
                run_status,
                run_version,
                tasks,
                attempt_count,
                artifact_count,
                proposal_set_count,
            ))
        })
        .expect("read Chronicle Run/Task ledger state")
    }

    fn mark_current_plan_predecessors_completed(db: &Database, run_id: &str) {
        db.with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed', completed_at = '2026-08-26T00:00:00.000Z'
                  WHERE run_id = ?1 AND task_kind != ?2",
                params![run_id, CHRONICLE_PLAN_TASK_KIND],
            )?;
            anyhow::ensure!(
                changed == CHRONICLE_PLAN_PREDECESSOR_TASK_KINDS.len(),
                "test setup must complete exactly the sealed plan predecessors"
            );
            Ok(())
        })
        .expect("complete current Chronicle plan predecessors");
    }

    fn claim_current_plan(db: &Database, run_id: &str) -> (String, String) {
        mark_current_plan_predecessors_completed(db, run_id);
        let claimed = claim_task(
            db,
            ClaimTaskPayload {
                run_id: run_id.to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "chronicle-plan-test".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec![CHRONICLE_PLAN_TASK_KIND.to_string()]),
            },
        )
        .expect("claim only current terminal plan task");
        let task = claimed.get("task").expect("claimed task");
        (
            task["taskId"].as_str().expect("task id").to_string(),
            task["attemptId"].as_str().expect("attempt id").to_string(),
        )
    }

    fn mark_current_task_completed_with_artifact(
        db: &Database,
        run_id: &str,
        task_kind: &str,
        artifact_kind: &str,
        payload_json: Value,
    ) {
        db.with_conn(|conn| {
            let task_id: String = conn.query_row(
                "SELECT id FROM narrative_extraction_tasks WHERE run_id = ?1 AND task_kind = ?2",
                params![run_id, task_kind],
                |row| row.get(0),
            )?;
            let attempt_id = format!("{task_id}-completed-attempt");
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed', attempt_count = 1,
                        completed_at = '2026-08-26T00:00:00.000Z'
                  WHERE id = ?1",
                params![task_id],
            )?;
            insert_attempt(
                conn,
                &attempt_id,
                &task_id,
                1,
                "completed",
                "2026-08-26T00:00:00.000Z",
            )?;
            insert_artifacts_for_attempt(
                conn,
                run_id,
                &task_id,
                &attempt_id,
                &[ArtifactInput {
                    artifact_id: Some(format!("{task_id}-{artifact_kind}")),
                    artifact_kind: artifact_kind.to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(payload_json.clone()),
                    payload_ref: None,
                    payload_digest: Some(canonical_json_digest(&payload_json)?),
                }],
            )?;
            Ok(())
        })
        .expect("seed canonical completed predecessor artifact");
    }

    fn mark_current_task_completed_without_artifact(db: &Database, run_id: &str, task_kind: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed', completed_at = '2026-08-26T00:00:00.000Z'
                  WHERE run_id = ?1 AND task_kind = ?2",
                params![run_id, task_kind],
            )?;
            Ok(())
        })
        .expect("seed completed Chronicle prefix task");
    }

    fn valid_chronicle_proposal(event_id: &str, title: &str) -> Value {
        json!({
            "eventId": event_id,
            "title": title,
            "note": null,
            "actuality": "actual",
            "significance": "scene-level",
            "semanticType": "event",
            "evidenceAnchorIds": ["anchor:one"],
            "evidenceDocumentRefs": ["document:one"],
            "disclosure": {
                "secret": false,
                "revealDocumentRef": "document:one",
            },
            "unresolvedMetadata": {
                "participantSurfaces": [],
                "locationSurface": null,
                "temporalExpressions": [],
            },
        })
    }

    fn current_plan_finish_payload(
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        proposals: Vec<Value>,
        planned_proposals: Option<Vec<Value>>,
    ) -> FinishTaskPayload {
        let proposal_set_id = chronicle_plan_proposal_set_id(run_id, task_id);
        let planned = planned_proposals.map(|rows| {
            rows.into_iter()
                .enumerate()
                .map(|(index, proposal)| {
                    json!({
                        "proposal": proposal,
                        "match": { "status": "none" },
                        "hypothesisId": format!("hypothesis:{index}"),
                    })
                })
                .collect::<Vec<_>>()
        });
        let mut artifact_payload = json!({
            "proposalSetId": proposal_set_id,
            "proposals": proposals,
        });
        if let Some(planned) = planned {
            artifact_payload
                .as_object_mut()
                .expect("test artifact object")
                .insert("planned".to_string(), Value::Array(planned));
        }
        let proposal_rows = artifact_payload["proposals"]
            .as_array()
            .expect("test proposal roster")
            .iter()
            .enumerate()
            .map(|(index, proposal)| ProposalSeed {
                proposal_id: None,
                proposal_key: format!(
                    "{}:{index}",
                    proposal["eventId"]
                        .as_str()
                        .expect("test proposal event id")
                ),
                kind: CHRONICLE_EVENT_PROPOSAL_KIND.to_string(),
                payload_json: proposal.clone(),
                reconciliation_envelope: None,
            })
            .collect::<Vec<_>>();
        FinishTaskPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.to_string(),
            lease_owner: "chronicle-plan-test".to_string(),
            output_json: Some(json!({
                "proposalSetId": proposal_set_id,
                "proposalCount": proposal_rows.len(),
            })),
            artifacts: vec![ArtifactInput {
                artifact_id: Some(format!("{task_id}-proposal-plan")),
                artifact_kind: CHRONICLE_PLAN_ARTIFACT_KIND.to_string(),
                payload_storage: Some("inline-json".to_string()),
                payload_json: Some(artifact_payload),
                payload_ref: None,
                payload_digest: None,
            }],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: Some(ChroniclePlanProposalSetFinish {
                proposal_set: SaveProposalSetPayload {
                    run_id: run_id.to_string(),
                    project_id: "project-1".to_string(),
                    proposal_set_id: Some(proposal_set_id),
                    set_kind: CHRONICLE_PROPOSAL_SET_KIND.to_string(),
                    summary_json: Some(json!({
                        "proposalCount": proposal_rows.len(),
                        "surfacePathId": CHRONICLE_EXTRACT_SURFACE_PATH,
                    })),
                    proposals: proposal_rows,
                },
            }),
        }
    }

    fn enable_manual_apply_for_test(db: &Database) {
        let current = load_narrative_runtime_policy_from_db(db).expect("load runtime policy");
        set_narrative_runtime_policy(
            db,
            SetNarrativeRuntimePolicyInput {
                expected_version: current.version,
                runtime_mode: "manual-apply".to_string(),
                maintenance_enabled: false,
                generic_import_enabled: false,
                background_ai_enabled: false,
            },
        )
        .expect("enable manual Apply for commit guard test");
    }

    fn seed_terminal_current_chronicle_proposal(
        db: &Database,
        run_id: &str,
    ) -> (String, String, String) {
        let catalog = json!({
            "kind": CHRONICLE_EXISTING_EVENTS_CATALOG_KIND,
            "events": [],
        });
        let create_payload = current_chronicle_candidate_payload(run_id, "project-1", &catalog);
        let snapshot_digest = create_payload
            .snapshot_digest
            .clone()
            .expect("catalog-guard fixture Snapshot digest");
        create_run(db, create_payload).expect("create current Chronicle catalog-guard Run");
        // The catalog-guard tests used to mark every predecessor Task complete
        // without its Attempt/artifact ledger. A production plan Proposal can
        // only exist after this exact Snapshot authority has terminalized, and
        // current Decisions deliberately verify it before status DML.
        let snapshot_payload = test_candidate_snapshot_payload(&snapshot_digest, Some(&catalog));
        let snapshot_output =
            test_candidate_snapshot_output(run_id, "project-1", &snapshot_payload);
        complete_candidate_task_with_artifact(
            db,
            run_id,
            "source.snapshot@1",
            "source.snapshot@1",
            snapshot_payload,
            snapshot_output,
        );
        let (task_id, attempt_id) = claim_current_plan(db, run_id);
        let proposal = valid_chronicle_proposal("event:catalog-guard", "Catalog guard proposal");
        finish_task(
            db,
            current_plan_finish_payload(
                run_id,
                &task_id,
                &attempt_id,
                vec![proposal.clone()],
                Some(vec![proposal]),
            ),
        )
        .expect("terminalize current Chronicle ProposalSet");
        let proposal_set_id = chronicle_plan_proposal_set_id(run_id, &task_id);
        let (proposal_id, revision_id): (String, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT id, current_revision_id
                       FROM narrative_proposals
                      WHERE proposal_set_id = ?1",
                    params![proposal_set_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("read terminal current Proposal/Revision");
        append_decision(
            db,
            AppendDecisionPayload {
                run_id: run_id.to_string(),
                project_id: "project-1".to_string(),
                proposal_id: proposal_id.clone(),
                revision_id: revision_id.clone(),
                decision: "approved".to_string(),
                decision_json: None,
                created_by: Some("catalog-guard-test".to_string()),
            },
        )
        .expect("approve current Chronicle catalog-guard Proposal");
        (proposal_set_id, proposal_id, revision_id)
    }

    fn current_catalog_guard_prepare_payload(
        run_id: &str,
        proposal_set_id: &str,
        proposal_id: &str,
        revision_id: &str,
        request_id: &str,
    ) -> PrepareCommitPayload {
        let operation = CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: valid_chronicle_proposal("event:catalog-guard", "Catalog guard proposal"),
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        };
        PrepareCommitPayload {
            project_id: "project-1".to_string(),
            run_id: run_id.to_string(),
            proposal_set_id: proposal_set_id.to_string(),
            request_id: request_id.to_string(),
            plan_digest: "caller-plan-digest-is-recomputed".to_string(),
            session_id: "catalog-guard-session".to_string(),
            surface: Some("narrative-extraction".to_string()),
            operations: vec![operation],
            applications: vec![CommitApplicationRef {
                proposal_id: proposal_id.to_string(),
                revision_id: revision_id.to_string(),
            }],
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        }
    }

    fn insert_live_catalog_drift_event(db: &Database, event_id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO events (id, project_id, title, ordinal, version)
                 VALUES (?1, 'project-1', '宿舎が砲撃される', 'a1', 0)",
                params![event_id],
            )?;
            Ok(())
        })
        .expect("add live Event after Chronicle matching");
    }

    #[test]
    fn create_and_get_run_round_trip() {
        let db = test_db();
        let created = create_run(
            &db,
            CreateRunPayload {
                run_id: Some("run-1".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({ "folderId": "folder-1" }),
                spec_json: json!({ "domain": "chronicle" }),
                spec_digest: "digest-1".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![CreateTaskSeed {
                    task_id: Some("task-1".to_string()),
                    task_kind: "plan_windows".to_string(),
                    input_json: Some(json!({ "windowCount": 1 })),
                    priority: Some(10),
                }],
            },
        )
        .expect("create run");

        assert_eq!(created["runId"], "run-1");
        assert_eq!(created["status"], "running");

        let loaded = get_run(&db, "run-1".to_string(), "project-1".to_string()).expect("get run");
        assert_eq!(loaded["run"]["status"], "running");
        assert_eq!(loaded["tasks"].as_array().map(|v| v.len()), Some(1));
        assert_eq!(loaded["taskCounts"]["queued"], 1);
    }

    #[test]
    fn chronicle_task_resume_candidates_list_verified_completed_prefix_only() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        let snapshot_digest =
            seed_ready_observation_candidate(&db, "resume-ready-observation", &catalog);

        let listed = list_task_resume_candidates(&db, "project-1")
            .expect("list verified task-resume candidate");
        let candidates = listed.as_array().expect("candidate array");
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate["runId"], "resume-ready-observation");
        assert_eq!(candidate["projectId"], "project-1");
        assert_eq!(candidate["status"], "running");
        assert!(candidate["runSpecDigest"].as_str().is_some());
        assert_eq!(candidate["snapshotDigest"], snapshot_digest);
        assert_eq!(candidate["executionMode"], "deterministic-fallback");
        assert_eq!(candidate["language"], "ja");
        assert_eq!(candidate["existingEventsCatalog"], catalog);
        assert_eq!(
            candidate["completedTaskKinds"],
            json!(["source.snapshot@1", "source.window-plan@1"])
        );
        assert_eq!(
            candidate["nextTask"]["taskKind"],
            "chronicle.observe-events@1"
        );
        assert_eq!(candidate["nextTask"]["status"], "queued");
        assert!(candidate["nextTask"]["leaseExpiresAt"].is_null());
        assert_eq!(candidate["availability"], "ready");
        assert!(candidate["blockedCode"].is_null());

        let reviews = list_resumable_runs(
            &db,
            ListResumableRunsPayload {
                project_id: "project-1".to_string(),
                surface_path_id: Some(CHRONICLE_EXTRACT_SURFACE_PATH.to_string()),
                limit: Some(20),
            },
        )
        .expect("Review list remains readable");
        assert!(
            reviews.as_array().expect("review array").is_empty(),
            "a task-resume candidate without ProposalSet is not Review-resumable"
        );
    }

    #[test]
    fn live_chronicle_catalog_matches_fresh_start_canonical_contract() {
        let db = current_schema_full_db();
        db.with_conn(|conn| {
            // Same ordinal deliberately exercises the fresh path's secondary
            // `id` order independently of insertion order.
            conn.execute(
                "INSERT INTO events
                    (id, project_id, title, note, ordinal, start_time, end_time, version)
                 VALUES ('event:b', 'project-1', '宿舎が砲撃される', NULL,
                         'a0', 12, NULL, 2)",
                [],
            )?;
            conn.execute(
                "INSERT INTO events
                    (id, project_id, title, note, ordinal, start_time, end_time, version)
                 VALUES ('event:a', 'project-1', 'Alpha', 'note',
                         'a0', NULL, 99, 1)",
                [],
            )?;
            let catalog = load_live_chronicle_existing_events_catalog(conn, "project-1")?;
            assert_eq!(
                catalog,
                json!({
                    "kind": "chronicle.existing-events-catalog@1",
                    "events": [
                        {
                            "ref": "event:a",
                            "sourceKey": "event:a",
                            "title": "Alpha",
                            "note": "note",
                            "version": 1,
                            "linkedDocumentSourceKeys": [],
                            "participantEntityRefs": [],
                            "startTime": null,
                            "endTime": 99,
                            "digest": "sha256:event:a",
                            "applicationProvenanceKeys": [],
                        },
                        {
                            "ref": "event:b",
                            "sourceKey": "event:b",
                            "title": "宿舎が砲撃される",
                            "note": null,
                            "version": 2,
                            "linkedDocumentSourceKeys": [],
                            "participantEntityRefs": [],
                            "startTime": 12,
                            "endTime": null,
                            "digest": "sha256:event:b",
                            "applicationProvenanceKeys": [],
                        },
                    ],
                })
            );
            assert_eq!(
                canonical_json_digest(&catalog)?,
                "sha256:3a7548c257c0284af4b435d24c105a159eaa43fc512da14270659096640c3780"
            );
            Ok(())
        })
        .expect("canonicalize live Chronicle catalog");
    }

    #[test]
    fn live_catalog_drift_blocks_discovery_and_claim_without_ledger_mutation() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "resume-live-catalog-drift", &catalog);
        let ready = list_task_resume_candidates(&db, "project-1")
            .expect("sealed catalog matches live authority before drift");
        assert_eq!(ready[0]["availability"], "ready");
        let before = chronicle_run_task_ledger_state(&db, "resume-live-catalog-drift");

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO events
                    (id, project_id, title, ordinal, version)
                 VALUES ('event:live-addition', 'project-1', '宿舎が砲撃される', 'a1', 0)",
                [],
            )?;
            Ok(())
        })
        .expect("add a live Event after simulated process exit");

        let blocked = list_task_resume_candidates(&db, "project-1")
            .expect("catalog drift is a discoverable blocked recovery state");
        assert_eq!(blocked[0]["availability"], "blocked");
        assert_eq!(
            blocked[0]["blockedCode"],
            "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT"
        );
        assert_eq!(
            chronicle_run_task_ledger_state(&db, "resume-live-catalog-drift"),
            before,
            "read-only discovery must not change Run, Task, Attempt, or artifact state"
        );

        let claim_error = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "resume-live-catalog-drift".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "resuming-worker".to_string(),
                lease_duration_secs: Some(60),
                task_kinds: Some(vec!["chronicle.observe-events@1".to_string()]),
            },
        )
        .expect_err("stale ready candidate must fail again inside claim transaction");
        assert!(claim_error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT"));
        assert_eq!(
            chronicle_run_task_ledger_state(&db, "resume-live-catalog-drift"),
            before,
            "failed claim must not create a lease or Attempt"
        );
    }

    #[test]
    fn live_catalog_drift_after_claim_rejects_finish_without_terminal_dml() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "finish-live-catalog-drift", &catalog);
        let claimed = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "finish-live-catalog-drift".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "running-worker".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["chronicle.observe-events@1".to_string()]),
            },
        )
        .expect("claim while the live catalog still matches");
        let task = &claimed["task"];
        let task_id = task["taskId"].as_str().expect("claimed Task id");
        let attempt_id = task["attemptId"].as_str().expect("claimed Attempt id");
        let after_claim = chronicle_run_task_ledger_state(&db, "finish-live-catalog-drift");

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO events
                    (id, project_id, title, ordinal, version)
                 VALUES ('event:finish-race', 'project-1', '宿舎が砲撃される', 'a1', 0)",
                [],
            )?;
            Ok(())
        })
        .expect("change live Event authority while the Task is leased");

        let error = finish_task(
            &db,
            FinishTaskPayload {
                run_id: "finish-live-catalog-drift".to_string(),
                project_id: "project-1".to_string(),
                task_id: task_id.to_string(),
                attempt_id: attempt_id.to_string(),
                lease_owner: "running-worker".to_string(),
                output_json: Some(json!({ "observationCount": 0 })),
                artifacts: vec![],
                chronicle_stage_bundle: None,
                chronicle_stage_receipts: vec![],
                historical_scope_authority_basis: None,
                chronicle_plan_proposal_set: None,
            },
        )
        .expect_err("finish must compare the live catalog in its own transaction");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT"));
        assert_eq!(
            chronicle_run_task_ledger_state(&db, "finish-live-catalog-drift"),
            after_claim,
            "rejected finish must retain the claimed lease/Attempt and persist no artifact or ProposalSet"
        );
    }

    #[test]
    fn chronicle_task_resume_candidates_exclude_review_foreign_and_legacy_runs() {
        let db = full_migrated_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Other Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed foreign project");
        let catalog = test_existing_events_catalog("Existing event");

        let mut foreign =
            current_chronicle_candidate_payload("resume-foreign", "project-2", &catalog);
        foreign.scope_json = json!({ "folderId": "folder-2", "sceneIds": ["scene-2"] });
        create_run(&db, foreign).expect("create foreign current Run");

        create_run_with_task(&db, "resume-legacy", "resume-legacy-task");

        let review = current_chronicle_candidate_payload("resume-review", "project-1", &catalog);
        create_run(&db, review).expect("create completed Review Run");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET status = 'completed', completed_at = '2026-08-26T00:02:00.000Z'
                  WHERE id = 'resume-review'",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, status, summary_json,
                     created_at, updated_at, version)
                 VALUES ('resume-review-set', 'resume-review', 'project-1',
                         'chronicle.extract.review@1', 'draft', '{}',
                         '2026-08-26T00:02:00.000Z', '2026-08-26T00:02:00.000Z', 0)",
                [],
            )?;
            Ok(())
        })
        .expect("terminalize Review Run");

        let listed = list_task_resume_candidates(&db, "project-1")
            .expect("foreign, legacy, and Review rows are not task candidates");
        assert!(listed.as_array().expect("candidate array").is_empty());
    }

    #[test]
    fn chronicle_task_resume_candidates_classify_held_and_expired_next_lease() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "resume-lease", &catalog);
        let claimed = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "resume-lease".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "pre-crash-worker".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["chronicle.observe-events@1".to_string()]),
            },
        )
        .expect("claim Observation before simulated crash");
        assert_eq!(claimed["claimed"], true);

        let held = list_task_resume_candidates(&db, "project-1").expect("list held lease");
        let held = &held.as_array().expect("candidate array")[0];
        assert_eq!(held["availability"], "lease-held");
        assert_eq!(held["nextTask"]["status"], "running");
        assert!(held["nextTask"]["leaseExpiresAt"].is_string());
        assert!(held["blockedCode"].is_null());

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET lease_expires_at = '2000-01-01T00:00:00.000Z'
                  WHERE run_id = 'resume-lease'
                    AND task_kind = 'chronicle.observe-events@1'",
                [],
            )?;
            Ok(())
        })
        .expect("expire abandoned lease");
        let ready = list_task_resume_candidates(&db, "project-1").expect("list expired lease");
        assert_eq!(
            ready.as_array().expect("candidate array")[0]["availability"],
            "ready"
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET lease_expires_at = 'not-an-instant'
                  WHERE run_id = 'resume-lease'
                    AND task_kind = 'chronicle.observe-events@1'",
                [],
            )?;
            Ok(())
        })
        .expect("corrupt abandoned lease");
        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("malformed lease evidence fails discovery closed");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_LEASE_INVALID"));
    }

    #[test]
    fn chronicle_task_resume_candidates_return_explicit_blocked_durable_inputs() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        create_run(
            &db,
            current_chronicle_candidate_payload("resume-pre-snapshot", "project-1", &catalog),
        )
        .expect("create pre-snapshot Run");

        let missing_catalog =
            current_chronicle_candidate_payload("resume-missing-catalog", "project-1", &catalog);
        let snapshot_digest = missing_catalog
            .snapshot_digest
            .clone()
            .expect("snapshot digest");
        create_run(&db, missing_catalog).expect("create missing-catalog Run");
        let snapshot_payload = test_candidate_snapshot_payload(&snapshot_digest, None);
        let snapshot_output = test_candidate_snapshot_output(
            "resume-missing-catalog",
            "project-1",
            &snapshot_payload,
        );
        complete_candidate_task_with_artifact(
            &db,
            "resume-missing-catalog",
            "source.snapshot@1",
            "source.snapshot@1",
            snapshot_payload,
            snapshot_output,
        );

        let listed = list_task_resume_candidates(&db, "project-1")
            .expect("blocked durable-input candidates remain discoverable");
        let candidates = listed.as_array().expect("candidate array");
        let pre_snapshot = candidates
            .iter()
            .find(|candidate| candidate["runId"] == "resume-pre-snapshot")
            .expect("pre-snapshot candidate");
        assert_eq!(pre_snapshot["availability"], "blocked");
        assert_eq!(
            pre_snapshot["blockedCode"],
            "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE"
        );
        assert!(pre_snapshot["language"].is_null());
        assert!(pre_snapshot["existingEventsCatalog"].is_null());

        let missing_catalog = candidates
            .iter()
            .find(|candidate| candidate["runId"] == "resume-missing-catalog")
            .expect("missing-catalog candidate");
        assert_eq!(missing_catalog["availability"], "blocked");
        assert_eq!(
            missing_catalog["blockedCode"],
            "NEX_CHRONICLE_RESUME_CATALOG_MISSING"
        );
        assert_eq!(missing_catalog["language"], "ja");
        assert!(missing_catalog["existingEventsCatalog"].is_null());
    }

    #[test]
    fn snapshot_incomplete_candidate_prefers_live_lease_and_typed_discard_rechecks_it() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_live_existing_events_catalog(&db, &catalog);
        create_run(
            &db,
            current_chronicle_candidate_payload(
                "resume-snapshot-discard-race",
                "project-1",
                &catalog,
            ),
        )
        .expect("create pre-Snapshot current Chronicle Run");

        let initial_claim = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "resume-snapshot-discard-race".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "first-worker".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["source.snapshot@1".to_string()]),
            },
        )
        .expect("claim Snapshot with a future lease");
        assert_eq!(initial_claim["claimed"], true);

        let held = list_task_resume_candidates(&db, "project-1")
            .expect("active Snapshot worker remains discoverable");
        let held = &held.as_array().expect("candidate array")[0];
        assert_eq!(held["availability"], "lease-held");
        assert!(held["blockedCode"].is_null());

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET lease_expires_at = '2000-01-01T00:00:00.000Z'
                  WHERE run_id = 'resume-snapshot-discard-race'
                    AND task_kind = 'source.snapshot@1'",
                [],
            )?;
            Ok(())
        })
        .expect("expire the abandoned Snapshot lease");
        let blocked = list_task_resume_candidates(&db, "project-1")
            .expect("expired Snapshot is durably blocked");
        let blocked = &blocked.as_array().expect("candidate array")[0];
        assert_eq!(blocked["availability"], "blocked");
        assert_eq!(
            blocked["blockedCode"],
            "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE"
        );
        let expectation = ChronicleBlockedDiscardExpectation {
            next_task_id: blocked["nextTask"]["taskId"]
                .as_str()
                .expect("blocked next Task id")
                .to_string(),
            blocked_code: blocked["blockedCode"]
                .as_str()
                .expect("blocked code")
                .to_string(),
            run_spec_digest: blocked["runSpecDigest"]
                .as_str()
                .expect("Run spec digest")
                .to_string(),
            snapshot_digest: blocked["snapshotDigest"]
                .as_str()
                .expect("Snapshot digest")
                .to_string(),
            catalog_digest: blocked["catalogDigest"]
                .as_str()
                .expect("catalog digest")
                .to_string(),
        };

        let reclaimed = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "resume-snapshot-discard-race".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "replacement-worker".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["source.snapshot@1".to_string()]),
            },
        )
        .expect("another process reclaims Snapshot before discard dispatch");
        assert_eq!(reclaimed["claimed"], true);
        let before_rejected_discard =
            chronicle_run_task_ledger_state(&db, "resume-snapshot-discard-race");

        let error = cancel_run_with_expectation(
            &db,
            "resume-snapshot-discard-race".to_string(),
            "project-1".to_string(),
            Some(expectation.clone()),
        )
        .expect_err("typed discard must not cancel a newly live worker");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_DISCARD_STALE"));
        assert_eq!(
            chronicle_run_task_ledger_state(&db, "resume-snapshot-discard-race"),
            before_rejected_discard,
            "stale discard expectation must not change Run, Task, Attempt, artifact, or ProposalSet state"
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET lease_expires_at = '2000-01-01T00:00:00.000Z'
                  WHERE run_id = 'resume-snapshot-discard-race'
                    AND task_kind = 'source.snapshot@1'",
                [],
            )?;
            Ok(())
        })
        .expect("replacement worker lease eventually expires");
        let cancelled = cancel_run_with_expectation(
            &db,
            "resume-snapshot-discard-race".to_string(),
            "project-1".to_string(),
            Some(expectation),
        )
        .expect("same typed expectation may cancel once the Run is blocked again");
        assert_eq!(cancelled["status"], "cancelled");

        db.with_conn(|conn| {
            let (run_status, run_completed_at): (String, Option<String>) = conn.query_row(
                "SELECT status, completed_at
                   FROM narrative_extraction_runs
                  WHERE id = 'resume-snapshot-discard-race'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(run_status, "cancelled");
            let lifecycle_at = run_completed_at.expect("cancelled Run lifecycle timestamp");

            let (task_status, task_completed_at): (String, Option<String>) = conn.query_row(
                "SELECT status, completed_at
                   FROM narrative_extraction_tasks
                  WHERE run_id = 'resume-snapshot-discard-race'
                    AND task_kind = 'source.snapshot@1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(task_status, "cancelled");
            assert_eq!(task_completed_at.as_deref(), Some(lifecycle_at.as_str()));

            let mut statement = conn.prepare(
                "SELECT attempt_number, status, completed_at, error_message,
                        failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts
                  WHERE task_id IN (
                    SELECT id
                      FROM narrative_extraction_tasks
                     WHERE run_id = 'resume-snapshot-discard-race'
                  )
                  ORDER BY attempt_number ASC",
            )?;
            let attempts = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(attempts.len(), 2, "both reclaimed Attempts remain durable");
            for (
                attempt_number,
                status,
                completed_at,
                error_message,
                failure_code,
                retry_disposition,
                policy_version,
                next_attempt_at,
            ) in attempts
            {
                assert_eq!(status, "failed", "Attempt {attempt_number} is terminal");
                assert_eq!(completed_at.as_deref(), Some(lifecycle_at.as_str()));
                assert_eq!(
                    error_message.as_deref(),
                    Some("NEX_RUN_CANCELLED: Run cancelled")
                );
                assert_eq!(failure_code.as_deref(), Some("NEX_RUN_CANCELLED"));
                assert_eq!(retry_disposition.as_deref(), Some("terminal"));
                assert_eq!(policy_version.as_deref(), Some("v1"));
                assert_eq!(next_attempt_at, None);
            }

            let running_attempts: i64 = conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_extraction_attempts
                  WHERE status = 'running'
                    AND task_id IN (
                      SELECT id
                        FROM narrative_extraction_tasks
                       WHERE run_id = 'resume-snapshot-discard-race'
                    )",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(running_attempts, 0);
            Ok(())
        })
        .expect("cancelled Run has a coherent terminal execution ledger");
    }

    #[test]
    fn chronicle_task_resume_candidates_fail_closed_on_topology_corruption() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        create_run(
            &db,
            current_chronicle_candidate_payload("resume-bad-topology", "project-1", &catalog),
        )
        .expect("create topology-corruption Run");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = 'source.snapshot@1'
                  WHERE run_id = 'resume-bad-topology'
                    AND task_kind = 'chronicle.plan-proposals@1'",
                [],
            )?;
            Ok(())
        })
        .expect("duplicate task kind");

        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("duplicate current topology fails discovery closed");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID"));
    }

    #[test]
    fn chronicle_task_resume_candidates_fail_closed_on_malformed_current_spec() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        create_run(
            &db,
            current_chronicle_candidate_payload("resume-bad-spec", "project-1", &catalog),
        )
        .expect("create spec-corruption Run");
        db.with_conn(|conn| {
            let malformed_spec = json!({
                "kind": CHRONICLE_RUN_SPEC_KIND,
                "version": 2,
            });
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET spec_json = ?2, spec_digest = ?3
                  WHERE id = ?1",
                params![
                    "resume-bad-spec",
                    serde_json::to_string(&malformed_spec)?,
                    canonical_json_digest(&malformed_spec)?,
                ],
            )?;
            Ok(())
        })
        .expect("replace current spec with a separately canonical partial shape");

        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("partial current spec fails discovery closed");
        assert!(error.to_string().contains("NEX_CHRONICLE_RUN_SPEC_INVALID"));
    }

    #[test]
    fn chronicle_task_resume_candidates_fail_closed_on_artifact_corruption() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "resume-bad-artifact", &catalog);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_extraction_artifacts
                  WHERE run_id = 'resume-bad-artifact'
                    AND artifact_kind = 'source.window-plan@1'",
                [],
            )?;
            Ok(())
        })
        .expect("remove completed-prefix artifact");

        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("missing completed-prefix artifact fails discovery closed");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT"));
    }

    #[test]
    fn chronicle_task_resume_candidates_fail_closed_on_catalog_drift() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Sealed title");
        let snapshot_digest =
            seed_ready_observation_candidate(&db, "resume-catalog-drift", &catalog);
        let drifted_catalog = test_existing_events_catalog("Drifted title");
        let drifted_payload =
            test_candidate_snapshot_payload(&snapshot_digest, Some(&drifted_catalog));
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_artifacts
                    SET payload_json = ?2, payload_digest = ?3
                  WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
                params![
                    "resume-catalog-drift",
                    serde_json::to_string(&drifted_payload)?,
                    canonical_json_digest(&drifted_payload)?,
                ],
            )?;
            Ok(())
        })
        .expect("replace catalog with separately canonical payload");

        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("catalog body drift fails discovery closed");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_CATALOG_MISMATCH"));
    }

    #[test]
    fn chronicle_task_resume_candidates_fail_closed_on_tampered_snapshot_internals() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "resume-source-view-drift", &catalog);
        db.with_conn(|conn| {
            let payload_json: String = conn.query_row(
                "SELECT payload_json
                   FROM narrative_extraction_artifacts
                  WHERE run_id = 'resume-source-view-drift'
                    AND artifact_kind = 'source.snapshot@1'",
                [],
                |row| row.get(0),
            )?;
            let mut payload: Value = serde_json::from_str(&payload_json)?;
            payload["sourceViews"][0]["text"] = json!("tampered");
            conn.execute(
                "UPDATE narrative_extraction_artifacts
                    SET payload_json = ?2, payload_digest = ?3
                  WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
                params![
                    "resume-source-view-drift",
                    serde_json::to_string(&payload)?,
                    canonical_json_digest(&payload)?,
                ],
            )?;
            Ok(())
        })
        .expect("rewrite snapshot with a recomputed outer payload digest");

        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("tampered internal source-view seal fails discovery closed");
        assert!(error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID"));
    }

    #[test]
    fn chronicle_task_resume_candidates_revalidate_snapshot_task_output_cas() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "resume-snapshot-output-drift", &catalog);
        db.with_conn(|conn| {
            let (task_id, attempt_id, output_json): (String, String, String) = conn.query_row(
                "SELECT task.id, attempt.id, task.output_json
                   FROM narrative_extraction_tasks task
                   JOIN narrative_extraction_attempts attempt
                     ON attempt.task_id = task.id
                    AND attempt.attempt_number = task.attempt_count
                  WHERE task.run_id = 'resume-snapshot-output-drift'
                    AND task.task_kind = 'source.snapshot@1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let mut output: Value = serde_json::from_str(&output_json)?;
            output["documentCount"] = json!(999);
            let output = serde_json::to_string(&output)?;
            conn.execute(
                "UPDATE narrative_extraction_tasks SET output_json = ?2 WHERE id = ?1",
                params![task_id, &output],
            )?;
            conn.execute(
                "UPDATE narrative_extraction_attempts SET output_json = ?2 WHERE id = ?1",
                params![attempt_id, &output],
            )?;
            Ok(())
        })
        .expect("rewrite both durable snapshot outputs with the same false CAS value");

        let error = list_task_resume_candidates(&db, "project-1")
            .expect_err("snapshot output CAS is revalidated during discovery");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH"));
    }

    #[test]
    fn chronicle_task_resume_candidates_require_exact_ordered_scope_scene_roster() {
        for (run_id, scope_scene_ids, snapshot_scene_ids) in [
            (
                "resume-snapshot-missing-scene",
                vec!["scene-1", "scene-2"],
                vec!["scene-1"],
            ),
            (
                "resume-snapshot-reordered-scenes",
                vec!["scene-2", "scene-1"],
                vec!["scene-1", "scene-2"],
            ),
        ] {
            let db = full_migrated_db();
            let catalog = test_existing_events_catalog("Existing event");
            let snapshot_payload = test_candidate_snapshot_payload_for_scenes(
                "project-1",
                &snapshot_scene_ids,
                Some(&catalog),
            );
            let snapshot_digest = snapshot_payload["snapshot"]["digest"]
                .as_str()
                .expect("snapshot digest")
                .to_string();
            let mut run = current_chronicle_candidate_payload(run_id, "project-1", &catalog);
            run.scope_json = json!({
                "folderId": "folder-1",
                "sceneIds": scope_scene_ids,
            });
            run.snapshot_digest = Some(snapshot_digest.clone());
            create_run(&db, run).expect("create scope/snapshot mismatch Run");
            let snapshot_output =
                test_candidate_snapshot_output(run_id, "project-1", &snapshot_payload);
            complete_candidate_task_with_artifact(
                &db,
                run_id,
                "source.snapshot@1",
                "source.snapshot@1",
                snapshot_payload,
                snapshot_output,
            );

            let error = list_task_resume_candidates(&db, "project-1")
                .expect_err("scope/snapshot scene roster mismatch fails discovery closed");
            assert!(error
                .to_string()
                .contains("NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH"));
        }
    }

    #[test]
    fn chronicle_task_resume_candidates_validate_every_row_before_limit() {
        let db = full_migrated_db();
        let catalog = test_existing_events_catalog("Existing event");
        seed_ready_observation_candidate(&db, "resume-valid-before-limit", &catalog);
        create_run(
            &db,
            current_chronicle_candidate_payload(
                "resume-corrupt-before-limit",
                "project-1",
                &catalog,
            ),
        )
        .expect("create corrupt row before limit");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = 'source.snapshot@1'
                  WHERE run_id = 'resume-corrupt-before-limit'
                    AND task_kind = 'chronicle.plan-proposals@1'",
                [],
            )?;
            Ok(())
        })
        .expect("corrupt a candidate beyond the requested result size");

        let error = list_chronicle_task_resume_candidates(
            &db,
            super::super::models::ListChronicleTaskResumeCandidatesPayload {
                project_id: "project-1".to_string(),
                limit: Some(1),
            },
        )
        .expect_err("limit must not hide a corrupt current-contract row");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID"));
    }

    #[test]
    fn chronicle_task_resume_candidates_reject_noncanonical_request_coordinates() {
        let db = full_migrated_db();
        for payload in [
            super::super::models::ListChronicleTaskResumeCandidatesPayload {
                project_id: " project-1".to_string(),
                limit: Some(20),
            },
            super::super::models::ListChronicleTaskResumeCandidatesPayload {
                project_id: "project-1".to_string(),
                limit: Some(0),
            },
            super::super::models::ListChronicleTaskResumeCandidatesPayload {
                project_id: "project-1".to_string(),
                limit: Some(101),
            },
        ] {
            let error = list_chronicle_task_resume_candidates(&db, payload)
                .expect_err("noncanonical discovery request must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_CHRONICLE_RESUME_CANDIDATE_REQUEST_INVALID"));
        }
    }

    #[test]
    fn legacy_v1_chronicle_run_with_task_chain_remains_creatable_and_readable() {
        let db = test_db();
        let legacy_spec = json!({
            "domain": "chronicle",
            "version": 1,
            "taskChain": CHRONICLE_EXTRACT_TASK_CHAIN,
        });
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("legacy-v1-task-chain".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: CHRONICLE_EXTRACT_SURFACE_PATH.to_string(),
                scope_json: json!({}),
                spec_json: legacy_spec,
                spec_digest: "legacy-v1-spec".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![CreateTaskSeed {
                    task_id: Some("legacy-v1-task".to_string()),
                    task_kind: "legacy-extract".to_string(),
                    input_json: None,
                    priority: None,
                }],
            },
        )
        .expect("unmarked legacy Chronicle Run remains compatible");

        get_run(
            &db,
            "legacy-v1-task-chain".to_string(),
            "project-1".to_string(),
        )
        .expect("legacy Chronicle Run remains readable");
    }

    #[test]
    fn current_chronicle_create_requires_exact_task_roster_before_dml() {
        let db = test_db();
        let mut missing = current_chronicle_create_payload("current-missing-task");
        missing.tasks.pop();
        let error = create_run(&db, missing).expect_err("current Run cannot omit a sealed task");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RUN_TASK_TOPOLOGY_INVALID"));

        let mut duplicate = current_chronicle_create_payload("current-duplicate-task");
        duplicate.tasks[8].task_kind = CHRONICLE_EXTRACT_TASK_CHAIN[0].to_string();
        let error = create_run(&db, duplicate).expect_err("current Run cannot duplicate a task");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RUN_TASK_TOPOLOGY_INVALID"));

        let persisted: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count rejected current Runs");
        assert_eq!(persisted, 0, "topology validation precedes Run DML");
    }

    #[test]
    fn current_chronicle_marker_tamper_and_generic_proposal_save_fail_closed() {
        let db = test_db();
        create_current_chronicle_run(&db, "current-spec-tamper");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET spec_json = '{\"domain\":\"chronicle\",\"version\":1}'
                  WHERE id = 'current-spec-tamper'",
                [],
            )?;
            Ok(())
        })
        .expect("tamper stored v2 kind while retaining sealed catalog digest");
        let error = get_run(
            &db,
            "current-spec-tamper".to_string(),
            "project-1".to_string(),
        )
        .expect_err("non-null current catalog marker must reject kind downgrade");
        assert!(error.to_string().contains("NEX_CHRONICLE_RUN_SPEC_INVALID"));

        create_current_chronicle_run(&db, "current-generic-save");
        let error = save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "current-generic-save".to_string(),
                project_id: "project-1".to_string(),
                proposal_set_id: Some("poison-set".to_string()),
                set_kind: "arbitrary.poison@1".to_string(),
                summary_json: None,
                proposals: vec![],
            },
        )
        .expect_err("public generic save cannot poison a current Chronicle Run");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_TYPED_FINISH_REQUIRED"));
        let sets: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = 'current-generic-save'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count generic-save rows");
        assert_eq!(sets, 0, "generic save rejection precedes ProposalSet DML");
    }

    #[test]
    fn current_chronicle_claim_rejects_running_suffix_and_terminal_statuses() {
        let db = test_db();
        create_current_chronicle_run(&db, "current-running-suffix");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'running'
                  WHERE run_id = ?1 AND task_kind = ?2",
                params!["current-running-suffix", CHRONICLE_EXTRACT_TASK_CHAIN[1]],
            )?;
            Ok(())
        })
        .expect("create out-of-order running suffix");
        let error = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "current-running-suffix".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "test-owner".to_string(),
                lease_duration_secs: None,
                task_kinds: Some(vec![CHRONICLE_EXTRACT_TASK_CHAIN[0].to_string()]),
            },
        )
        .expect_err("running suffix must fail before it leases the prefix task");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID"));

        create_current_chronicle_run(&db, "current-failed-task");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'failed'
                  WHERE run_id = ?1 AND task_kind = ?2",
                params!["current-failed-task", CHRONICLE_EXTRACT_TASK_CHAIN[0]],
            )?;
            Ok(())
        })
        .expect("create terminal task status");
        let error = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "current-failed-task".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "test-owner".to_string(),
                lease_duration_secs: None,
                task_kinds: Some(vec![CHRONICLE_EXTRACT_TASK_CHAIN[0].to_string()]),
            },
        )
        .expect_err("failed current Chronicle task cannot be treated as resumable");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_CLAIM_TOPOLOGY_INVALID"));
    }

    #[test]
    fn current_ai_observation_rejects_generic_finish_without_receipt_before_dml() {
        let db = test_db();
        let run_id = "current-ai-generic-observation";
        create_run(
            &db,
            current_chronicle_create_payload_with_mode(run_id, "ai"),
        )
        .expect("create current AI Chronicle Run");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed'
                  WHERE run_id = ?1 AND task_kind IN (?2, ?3)",
                params![
                    run_id,
                    CHRONICLE_EXTRACT_TASK_CHAIN[0],
                    CHRONICLE_EXTRACT_TASK_CHAIN[1],
                ],
            )?;
            Ok(())
        })
        .expect("complete required prefix before Observe claim");
        let claimed = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: run_id.to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "ai-observation-test".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["chronicle.observe-events@1".to_string()]),
            },
        )
        .expect("claim AI Observation task");
        let task = claimed.get("task").expect("claimed observe task");
        let task_id = task["taskId"]
            .as_str()
            .expect("observe task id")
            .to_string();
        let attempt_id = task["attemptId"]
            .as_str()
            .expect("observe attempt id")
            .to_string();
        let error = finish_task(
            &db,
            FinishTaskPayload {
                run_id: run_id.to_string(),
                project_id: "project-1".to_string(),
                task_id: task_id.clone(),
                attempt_id: attempt_id.clone(),
                lease_owner: "ai-observation-test".to_string(),
                // A genuine non-empty output cannot downgrade to generic
                // completion merely by omitting its task-local receipt.
                output_json: Some(json!({ "observationCount": 1 })),
                artifacts: vec![ArtifactInput {
                    artifact_id: Some("generic-raw-observations".to_string()),
                    artifact_kind: CHRONICLE_RAW_OBSERVATIONS_ARTIFACT_KIND.to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({ "observations": [{ "localId": "forged" }] })),
                    payload_ref: None,
                    payload_digest: None,
                }],
                chronicle_stage_bundle: None,
                chronicle_stage_receipts: vec![],
                historical_scope_authority_basis: None,
                chronicle_plan_proposal_set: None,
            },
        )
        .expect_err("AI Observe cannot downgrade to a generic no-receipt finish");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_AI_STAGE_PROVENANCE_REQUIRED"));
        let state: (String, String, i64) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT t.status, a.status,
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts WHERE run_id = ?1)
                       FROM narrative_extraction_tasks t
                       JOIN narrative_extraction_attempts a ON a.id = ?2
                      WHERE t.id = ?3",
                    params![run_id, attempt_id, task_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(Into::into)
            })
            .expect("read rejected AI Observation state");
        assert_eq!(state, ("running".to_string(), "running".to_string(), 0));
    }

    #[test]
    fn current_ai_zero_work_allows_no_receipt_only_with_canonical_empty_predecessor_roster() {
        let db = test_db();
        let observation_run = "current-ai-zero-windows";
        create_run(
            &db,
            current_chronicle_create_payload_with_mode(observation_run, "ai"),
        )
        .expect("create zero-window AI Run");
        mark_current_task_completed_without_artifact(
            &db,
            observation_run,
            CHRONICLE_EXTRACT_TASK_CHAIN[0],
        );
        mark_current_task_completed_with_artifact(
            &db,
            observation_run,
            "source.window-plan@1",
            CHRONICLE_WINDOW_PLAN_ARTIFACT_KIND,
            json!({ "windows": [] }),
        );
        let observation_claim = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: observation_run.to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "zero-work-test".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["chronicle.observe-events@1".to_string()]),
            },
        )
        .expect("claim zero-window Observation");
        let observation_task = observation_claim.get("task").expect("Observation task");
        finish_task(
            &db,
            FinishTaskPayload {
                run_id: observation_run.to_string(),
                project_id: "project-1".to_string(),
                task_id: observation_task["taskId"]
                    .as_str()
                    .expect("Observation task id")
                    .to_string(),
                attempt_id: observation_task["attemptId"]
                    .as_str()
                    .expect("Observation attempt id")
                    .to_string(),
                lease_owner: "zero-work-test".to_string(),
                output_json: Some(json!({ "observationCount": 0 })),
                artifacts: vec![ArtifactInput {
                    artifact_id: Some("zero-window-observations".to_string()),
                    artifact_kind: CHRONICLE_RAW_OBSERVATIONS_ARTIFACT_KIND.to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({ "observations": [] })),
                    payload_ref: None,
                    payload_digest: None,
                }],
                chronicle_stage_bundle: None,
                chronicle_stage_receipts: vec![],
                historical_scope_authority_basis: None,
                chronicle_plan_proposal_set: None,
            },
        )
        .expect("canonical zero-window proof permits deterministic-empty Observation");

        let synthesis_run = "current-ai-zero-clusters";
        create_run(
            &db,
            current_chronicle_create_payload_with_mode(synthesis_run, "ai"),
        )
        .expect("create zero-cluster AI Run");
        for task_kind in CHRONICLE_EXTRACT_TASK_CHAIN[..6].iter() {
            if *task_kind == "chronicle.cluster-event-observations@1" {
                mark_current_task_completed_with_artifact(
                    &db,
                    synthesis_run,
                    task_kind,
                    CHRONICLE_EVENT_CLUSTERS_ARTIFACT_KIND,
                    json!({ "clusters": [] }),
                );
            } else {
                mark_current_task_completed_without_artifact(&db, synthesis_run, task_kind);
            }
        }
        let synthesis_claim = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: synthesis_run.to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "zero-work-test".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: Some(vec!["chronicle.synthesize-event@1".to_string()]),
            },
        )
        .expect("claim zero-cluster Synthesis");
        let synthesis_task = synthesis_claim.get("task").expect("Synthesis task");
        finish_task(
            &db,
            FinishTaskPayload {
                run_id: synthesis_run.to_string(),
                project_id: "project-1".to_string(),
                task_id: synthesis_task["taskId"]
                    .as_str()
                    .expect("Synthesis task id")
                    .to_string(),
                attempt_id: synthesis_task["attemptId"]
                    .as_str()
                    .expect("Synthesis attempt id")
                    .to_string(),
                lease_owner: "zero-work-test".to_string(),
                output_json: Some(json!({ "hypothesisCount": 0 })),
                artifacts: vec![ArtifactInput {
                    artifact_id: Some("zero-cluster-hypotheses".to_string()),
                    artifact_kind: CHRONICLE_EVENT_HYPOTHESES_ARTIFACT_KIND.to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({ "hypotheses": [] })),
                    payload_ref: None,
                    payload_digest: None,
                }],
                chronicle_stage_bundle: None,
                chronicle_stage_receipts: vec![],
                historical_scope_authority_basis: None,
                chronicle_plan_proposal_set: None,
            },
        )
        .expect("canonical zero-cluster proof permits deterministic-empty Synthesis");
    }

    #[test]
    fn current_plan_finish_is_atomic_and_exactly_once_after_a_precommit_failure() {
        let db = test_db();
        let run_id = "current-plan-atomic";
        create_current_chronicle_run(&db, run_id);
        let (task_id, attempt_id) = claim_current_plan(&db, run_id);
        let proposal = valid_chronicle_proposal("event:atomic", "Atomic proposal");
        let valid = current_plan_finish_payload(
            run_id,
            &task_id,
            &attempt_id,
            vec![proposal.clone()],
            Some(vec![proposal]),
        );
        let mut invalid = valid.clone();
        invalid.output_json = Some(json!({
            "proposalSetId": chronicle_plan_proposal_set_id(run_id, &task_id),
            "proposalCount": 2,
        }));

        let error = finish_task(&db, invalid).expect_err(
            "invalid terminal typed payload must roll back before it saves a ProposalSet",
        );
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_OUTPUT_INVALID"));
        let before: (String, String, i64, i64) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT t.status, a.status,
                            (SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1),
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts WHERE run_id = ?1)
                       FROM narrative_extraction_tasks t
                       JOIN narrative_extraction_attempts a ON a.id = ?2
                      WHERE t.id = ?3",
                    params![run_id, attempt_id, task_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(Into::into)
            })
            .expect("read rolled-back plan state");
        assert_eq!(before, ("running".to_string(), "running".to_string(), 0, 0));

        // Abort only after save_proposal_set_in_tx has inserted the Set,
        // Proposal, and initial Revision, when Native adds the immutable plan
        // binding to summary_json. The surrounding BEGIN IMMEDIATE must roll
        // the whole family and Task/Attempt/artifact terminalization back.
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_current_plan_after_proposal_save
                 BEFORE UPDATE OF summary_json ON narrative_proposal_sets
                 WHEN NEW.summary_json LIKE '%chroniclePlanTaskBinding%'
                 BEGIN
                   SELECT RAISE(ABORT, 'test-current-plan-post-save-failure');
                 END;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install post-save rollback trigger");
        let post_save_error = finish_task(&db, valid.clone())
            .expect_err("post-save failure must roll back the entire terminal transaction");
        assert!(
            post_save_error
                .to_string()
                .contains("test-current-plan-post-save-failure"),
            "unexpected post-save failure: {post_save_error:#}"
        );
        let post_save_rollback: (String, String, String, i64, i64, i64, i64) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT r.status, t.status, a.status,
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts WHERE run_id = ?1),
                            (SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1),
                            (SELECT COUNT(*) FROM narrative_proposals
                              WHERE proposal_set_id = ?4),
                            (SELECT COUNT(*) FROM narrative_proposal_revisions
                              WHERE proposal_id IN (
                                SELECT id FROM narrative_proposals WHERE proposal_set_id = ?4
                              ))
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.id = ?2 AND t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.id = ?3 AND a.task_id = t.id
                      WHERE r.id = ?1",
                    params![
                        run_id,
                        task_id,
                        attempt_id,
                        chronicle_plan_proposal_set_id(run_id, &task_id)
                    ],
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
                .map_err(Into::into)
            })
            .expect("read post-save rolled-back state");
        assert_eq!(
            post_save_rollback,
            (
                "running".to_string(),
                "running".to_string(),
                "running".to_string(),
                0,
                0,
                0,
                0,
            )
        );
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER fail_current_plan_after_proposal_save")?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("remove post-save rollback trigger before exact retry");

        let replay = valid.clone();
        let finished = finish_task(&db, valid).expect("valid typed plan finish");
        assert_eq!(
            finished["proposalSet"]["proposalSetId"],
            chronicle_plan_proposal_set_id(run_id, &task_id)
        );
        let replay_error = finish_task(&db, replay).expect_err(
            "a lost response replay cannot complete the reclaimed/closed attempt twice",
        );
        assert!(
            replay_error
                .to_string()
                .contains("task lease owner mismatch")
                || replay_error
                    .to_string()
                    .contains("attempt is not the current running attempt")
        );
        let after: (String, String, i64, i64, i64) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT (SELECT status FROM narrative_extraction_runs WHERE id = ?1),
                            (SELECT status FROM narrative_extraction_tasks WHERE id = ?2),
                            (SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1),
                            (SELECT COUNT(*) FROM narrative_proposals
                              WHERE proposal_set_id = ?3),
                            (SELECT COUNT(*) FROM narrative_proposal_revisions
                              WHERE proposal_id IN (
                                SELECT id FROM narrative_proposals WHERE proposal_set_id = ?3
                              ))",
                    params![
                        run_id,
                        task_id,
                        chronicle_plan_proposal_set_id(run_id, &task_id)
                    ],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .expect("read exactly-once terminal state");
        assert_eq!(
            after,
            ("completed".to_string(), "completed".to_string(), 1, 1, 1,)
        );
    }

    #[test]
    fn current_chronicle_prepare_rejects_live_catalog_drift_before_commit_dml() {
        let db = full_migrated_db();
        enable_manual_apply_for_test(&db);
        let run_id = "current-prepare-catalog-drift";
        let (proposal_set_id, proposal_id, revision_id) =
            seed_terminal_current_chronicle_proposal(&db, run_id);
        let prepare = current_catalog_guard_prepare_payload(
            run_id,
            &proposal_set_id,
            &proposal_id,
            &revision_id,
            "request-prepare-catalog-drift",
        );
        insert_live_catalog_drift_event(&db, "event:prepare-live-addition");

        let before: (i64, i64, i64) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                        row.get(0)
                    })?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_applications",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read pre-Prepare DML state");
        let error = super::super::commit::narrative_extraction_prepare_commit(&db, prepare)
            .expect_err("stale match-existing catalog must block Prepare");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT"),
            "unexpected Prepare rejection: {error:#}"
        );
        let after: (i64, i64, i64) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                        row.get(0)
                    })?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_applications",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read rejected Prepare DML state");
        assert_eq!(after, before);
        assert_eq!(after.1, 0, "Prepare drift must not create a Commit row");
    }

    #[test]
    fn current_chronicle_apply_rechecks_live_catalog_before_domain_dml() {
        let db = full_migrated_db();
        enable_manual_apply_for_test(&db);
        let run_id = "current-apply-catalog-drift";
        let (proposal_set_id, proposal_id, revision_id) =
            seed_terminal_current_chronicle_proposal(&db, run_id);
        let prepare = current_catalog_guard_prepare_payload(
            run_id,
            &proposal_set_id,
            &proposal_id,
            &revision_id,
            "request-apply-catalog-drift",
        );
        let mut sealed_plan = serde_json::to_value(&prepare).expect("serialize sealed plan");
        sealed_plan
            .as_object_mut()
            .expect("sealed plan object")
            .insert(
                "sourceContract".to_string(),
                json!({
                    "revisionEnvelopeDigest": "sha256:sealed-revision",
                    "aggregateSourceBasisDigest": "sha256:sealed-source-basis",
                    "aggregateReadSetDigest": "sha256:sealed-read-set",
                }),
            );
        let policy_version = load_narrative_runtime_policy_from_db(&db)
            .expect("load manual-apply policy")
            .version;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                     status, receipt_json, error_message, prepared_plan_json,
                     prepared_policy_version, prepared_at, authority_digest, session_id,
                     created_at, completed_at, version)
                 VALUES ('prepared-catalog-drift', 'project-1', ?1, ?2, ?3,
                         'sha256:prepared-plan', 'prepared', NULL, NULL, ?4,
                         ?5, '2026-08-26T00:00:00.000Z', 'sha256:authority',
                         'catalog-guard-session', '2026-08-26T00:00:00.000Z', NULL, 0)",
                params![
                    run_id,
                    proposal_set_id,
                    prepare.request_id,
                    sealed_plan.to_string(),
                    policy_version,
                ],
            )?;
            Ok(())
        })
        .expect("seed a durable prepared Commit before catalog drift");
        insert_live_catalog_drift_event(&db, "event:apply-live-addition");

        let before: (i64, i64, i64) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_applications",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_apply_operations",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read pre-Apply domain DML state");
        let error = super::super::commit::narrative_extraction_apply_commit(
            &db,
            ApplyCommitPayload {
                project_id: "project-1".to_string(),
                prepared_commit_id: "prepared-catalog-drift".to_string(),
                request_id: "request-apply-catalog-drift".to_string(),
                session_id: "catalog-guard-session".to_string(),
                expected_version: Some(0),
            },
        )
        .expect_err("catalog drift between Prepare and Apply must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT"),
            "unexpected Apply rejection: {error:#}"
        );
        let after: (i64, i64, i64, String) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_applications",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_apply_operations",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT status FROM narrative_apply_commits
                          WHERE id = 'prepared-catalog-drift'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read rejected Apply state");
        assert_eq!((after.0, after.1, after.2), before);
        assert_eq!(
            after.3, "invalidated",
            "catalog drift terminalizes only the Commit audit row"
        );
    }

    #[test]
    fn current_chronicle_already_applied_replay_ignores_post_apply_catalog_change() {
        let db = full_migrated_db();
        let run_id = "current-applied-catalog-replay";
        let (proposal_set_id, _, _) = seed_terminal_current_chronicle_proposal(&db, run_id);
        let receipt = json!({
            "commitId": "applied-catalog-replay",
            "requestId": "request-applied-catalog-replay",
            "planDigest": "sha256:applied-plan",
            "status": "applied",
            "created": [{ "entityKind": "event", "entityId": "event:original-apply" }],
        });
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                     status, receipt_json, error_message, prepared_plan_json,
                     prepared_policy_version, prepared_at, authority_digest, session_id,
                     created_at, completed_at, version)
                 VALUES ('applied-catalog-replay', 'project-1', ?1, ?2,
                         'request-applied-catalog-replay', 'sha256:applied-plan',
                         'applied', ?3, NULL, NULL, NULL, NULL, NULL,
                         'catalog-guard-session', '2026-08-26T00:00:00.000Z',
                         '2026-08-26T00:00:01.000Z', 1)",
                params![run_id, proposal_set_id, receipt.to_string()],
            )?;
            Ok(())
        })
        .expect("seed already-applied Chronicle Commit receipt");
        // A successful Chronicle Apply normally changes the Event Catalog
        // itself. Lost-response replay must return its sealed receipt instead
        // of reinterpreting that expected post-Apply change as pre-Apply drift.
        insert_live_catalog_drift_event(&db, "event:original-apply");

        let replay = super::super::commit::narrative_extraction_apply_commit(
            &db,
            ApplyCommitPayload {
                project_id: "project-1".to_string(),
                prepared_commit_id: "applied-catalog-replay".to_string(),
                request_id: "request-applied-catalog-replay".to_string(),
                session_id: "catalog-guard-session".to_string(),
                expected_version: Some(1),
            },
        )
        .expect("already-applied replay must return the prior receipt");
        assert_eq!(replay["status"], "applied");
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(replay["created"], receipt["created"]);
    }

    #[test]
    fn current_plan_binds_nonlexical_and_planned_rosters_and_rejects_mismatch() {
        let db = test_db();
        let run_id = "current-plan-nonlexical";
        create_current_chronicle_run(&db, run_id);
        let (task_id, attempt_id) = claim_current_plan(&db, run_id);
        // Planner order intentionally differs from lexical event-id order.
        // Manifest is key-sorted, so resume validation must look by derived
        // proposalKey rather than zip the two representations.
        let first = valid_chronicle_proposal("event:z", "Z first in plan");
        let second = valid_chronicle_proposal("event:a", "A second in plan");
        let finished = finish_task(
            &db,
            current_plan_finish_payload(
                run_id,
                &task_id,
                &attempt_id,
                vec![first.clone(), second.clone()],
                Some(vec![first.clone(), second.clone()]),
            ),
        )
        .expect("nonlexical plan roster must terminalize through key lookup");
        assert_eq!(
            finished["proposalSet"]["proposals"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );

        let mismatch_run = "current-plan-planned-mismatch";
        create_current_chronicle_run(&db, mismatch_run);
        let (mismatch_task, mismatch_attempt) = claim_current_plan(&db, mismatch_run);
        let mismatched_planned = valid_chronicle_proposal("event:z", "Displayed but not saved");
        let error = finish_task(
            &db,
            current_plan_finish_payload(
                mismatch_run,
                &mismatch_task,
                &mismatch_attempt,
                vec![first],
                Some(vec![mismatched_planned]),
            ),
        )
        .expect_err("fresh planned payload cannot diverge from saved terminal proposal");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_INVALID"));
        let rows: (String, i64, i64) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT (SELECT status FROM narrative_extraction_tasks WHERE id = ?1),
                            (SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?2),
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts WHERE run_id = ?2)",
                    params![mismatch_task, mismatch_run],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(Into::into)
            })
            .expect("read planned mismatch rollback state");
        assert_eq!(rows, ("running".to_string(), 0, 0));
    }

    #[test]
    fn current_review_bundle_rejects_a_current_revision_pointer_owned_by_another_proposal() {
        let db = test_db();
        let run_id = "current-cross-proposal-revision";
        create_current_chronicle_run(&db, run_id);
        let (task_id, attempt_id) = claim_current_plan(&db, run_id);
        let first = valid_chronicle_proposal("event:z", "Z");
        let second = valid_chronicle_proposal("event:a", "A");
        finish_task(
            &db,
            current_plan_finish_payload(run_id, &task_id, &attempt_id, vec![first, second], None),
        )
        .expect("finish current terminal set before pointer corruption");

        let proposal_set_id = chronicle_plan_proposal_set_id(run_id, &task_id);
        let ((first_proposal, _), (_, second_revision)): ((String, String), (String, String)) = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id, current_revision_id
                       FROM narrative_proposals
                      WHERE proposal_set_id = ?1
                      ORDER BY proposal_key ASC",
                )?;
                let rows = statement
                    .query_map(params![proposal_set_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((rows[0].clone(), rows[1].clone()))
            })
            .expect("read sibling proposal revisions");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposals SET current_revision_id = ?1 WHERE id = ?2",
                params![second_revision, first_proposal],
            )?;
            // Isolate the current plan artifact/read boundary: old completed
            // predecessors are not relevant to the pointer-ownership test.
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'queued'
                  WHERE run_id = ?1 AND task_kind != ?2",
                params![run_id, CHRONICLE_PLAN_TASK_KIND],
            )?;
            Ok(())
        })
        .expect("corrupt cross-proposal current revision pointer");

        let error = get_run_review_bundle(&db, run_id.to_string(), "project-1".to_string())
            .expect_err("current proposal pointer must own its joined revision");
        assert!(error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT"));
    }

    #[test]
    fn create_run_rejects_noncanonical_run_ids_before_persisting() {
        let db = test_db();
        for run_id in ["", "   ", " run-1", "run-1 ", "snapshot:run-1"] {
            let error = create_run(
                &db,
                CreateRunPayload {
                    run_id: Some(run_id.to_string()),
                    project_id: "project-1".to_string(),
                    surface_path_id: "chronicle.extract".to_string(),
                    scope_json: json!({}),
                    spec_json: json!({}),
                    spec_digest: "digest-1".to_string(),
                    snapshot_digest: None,
                    catalog_digest: None,
                    registry_digest: None,
                    coverage_json: None,
                    tasks: vec![],
                },
            )
            .expect_err("a noncanonical runId must fail closed");
            assert!(
                error.to_string().contains("NEX_RUN_ID_INVALID"),
                "unexpected error for {run_id:?}: {error}"
            );
        }

        let persisted: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count persisted Runs");
        assert_eq!(persisted, 0);
    }

    #[test]
    fn create_run_and_snapshot_resolve_keep_a_new_source_prefix_opaque() {
        let db = test_db();
        let run_id = "project:scope-authority:legacy-run";
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some(run_id.to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "digest-legacy".to_string(),
                snapshot_digest: Some("sha256:legacy-snapshot".to_string()),
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect("a legacy Run id beginning with the new Source prefix remains valid");

        let source_key = format!("snapshot:{run_id}");
        let resolved = db
            .with_conn(|conn| {
                crate::narrative_extraction::source_revision::resolve_source_revision(
                    conn,
                    "project-1",
                    run_id,
                    "snapshot-document",
                    &source_key,
                )
            })
            .expect("the historical Snapshot Source must still resolve");
        assert_eq!(resolved.revision_token, "sha256:legacy-snapshot");
    }

    #[test]
    fn generic_task_api_rejects_every_runtime_owned_automatic_run_kind() {
        let db = full_migrated_db();
        for (index, run_kind) in [
            "freshness-evaluation",
            "backfill",
            "dependency-verify",
            "semantic-index-rebuild",
            "dependency-repair",
        ]
        .into_iter()
        .enumerate()
        {
            let run_id = format!("automatic-run-{index}");
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, run_kind,
                         semantic_epoch_id, work_key, version)
                     VALUES (?1, 'project-1', ?2, '{}', '{}', 'digest', 'running', '{}',
                             '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z', ?2,
                             NULL, ?1, 0)",
                    params![run_id, run_kind],
                )?;
                if run_kind == "freshness-evaluation" {
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET consumer_id = ?2 WHERE id = ?1",
                        params![run_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
                    )?;
                }
                let error = ensure_generic_task_api_allowed(conn, &run_id)
                    .expect_err("generic lifecycle APIs must not own automatic Runs");
                assert!(
                    error.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"),
                    "unexpected error for {run_kind}: {error}"
                );
                Ok(())
            })
            .expect("automatic Run authority guard");
        }
    }

    #[test]
    fn every_generic_public_task_api_rejects_runtime_owned_automatic_runs() {
        let db = full_migrated_db();
        let assert_forbidden = |result: anyhow::Result<Value>| {
            let error = result.expect_err("automatic Run must be owned by its runtime");
            assert!(
                error.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"),
                "unexpected generic API error: {error}"
            );
        };

        for (index, run_kind) in [
            "freshness-evaluation",
            "backfill",
            "dependency-verify",
            "semantic-index-rebuild",
            "dependency-repair",
        ]
        .into_iter()
        .enumerate()
        {
            let run_id = format!("automatic-public-api-{index}");
            insert_automatic_run_for_api_test(&db, &run_id, run_kind);

            assert_forbidden(cancel_run(&db, run_id.clone(), "project-1".to_string()));
            assert_forbidden(claim_task(
                &db,
                ClaimTaskPayload {
                    run_id: run_id.clone(),
                    project_id: "project-1".to_string(),
                    lease_owner: "generic-api-test".to_string(),
                    lease_duration_secs: None,
                    task_kinds: None,
                },
            ));
            assert_forbidden(finish_task(
                &db,
                FinishTaskPayload {
                    run_id: run_id.clone(),
                    project_id: "project-1".to_string(),
                    task_id: "not-owned-task".to_string(),
                    attempt_id: "not-owned-attempt".to_string(),
                    lease_owner: "generic-api-test".to_string(),
                    output_json: None,
                    artifacts: vec![],
                    chronicle_stage_bundle: None,
                    chronicle_stage_receipts: vec![],
                    historical_scope_authority_basis: None,
                    chronicle_plan_proposal_set: None,
                },
            ));
            assert_forbidden(fail_task(
                &db,
                FailTaskPayload {
                    run_id: run_id.clone(),
                    project_id: "project-1".to_string(),
                    task_id: "not-owned-task".to_string(),
                    attempt_id: "not-owned-attempt".to_string(),
                    lease_owner: "generic-api-test".to_string(),
                    error_message: "generic API must not own this Run".to_string(),
                    output_json: None,
                    requeue: Some(false),
                },
            ));

            let (status, completed_at): (String, Option<String>) = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT status, completed_at
                           FROM narrative_extraction_runs WHERE id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(Into::into)
                })
                .expect("read guarded automatic Run");
            assert_eq!(status, "running");
            assert_eq!(completed_at, None);
        }
    }

    #[test]
    fn automatic_owner_finalizer_wins_backfill_and_rebuild_interleaving() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        for (index, (run_kind, work_key)) in [
            ("backfill", "backfill-phase-gap"),
            ("semantic-index-rebuild", "rebuild-phase-gap"),
        ]
        .into_iter()
        .enumerate()
        {
            let created = create_system_run(
                &db,
                "project-1",
                run_kind,
                &epoch_id,
                work_key,
                &json!({ "phase": "committed-before-finalize" }),
                "system-spec-digest",
                if run_kind == "backfill" {
                    SystemRunWorkKeyReuse::RunningAndCompleted
                } else {
                    SystemRunWorkKeyReuse::RunningOnly
                },
                None,
            )
            .expect("create owner Run");
            let run_id = created["runId"].as_str().expect("owner Run id").to_string();

            let generic_error = cancel_run(&db, run_id.clone(), "project-1".to_string())
                .expect_err("generic cancellation must lose the phase-gap race");
            assert!(generic_error
                .to_string()
                .contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

            db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    transition_run_status_in_tx(conn, &run_id, NarrativeRunStatus::Completed)?;
                    record_run_outcome_in_tx(
                        conn,
                        &run_id,
                        &json!({ "phase": "committed-before-finalize", "owner": true }),
                    )?;
                    Ok(())
                })
            })
            .expect("owner finalizer completes atomically");

            let (status, completed_at, outcome): (String, String, String) = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT status, completed_at, outcome_summary_json
                           FROM narrative_extraction_runs WHERE id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(Into::into)
                })
                .expect("read owner-finalized Run");
            assert_eq!(
                status, "completed",
                "owner Run {index} must remain authoritative"
            );
            assert!(completed_at.ends_with('Z'));
            assert!(outcome.contains("committed-before-finalize"));
        }
    }

    #[test]
    fn generic_cancel_persists_millisecond_timestamp_for_resumable_ordering() {
        let db = full_migrated_db();
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("manual-run-1".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "digest-1".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect("create pending manual Run");

        cancel_run(&db, "manual-run-1".to_string(), "project-1".to_string())
            .expect("cancel pending manual Run");

        let completed_at: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT completed_at FROM narrative_extraction_runs WHERE id = 'manual-run-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read cancelled Run timestamp");
        assert!(
            completed_at.ends_with('Z') && completed_at.contains('.'),
            "Run lifecycle timestamps must be RFC3339 with milliseconds: {completed_at}"
        );
    }

    #[test]
    fn every_manual_run_lifecycle_route_stays_after_imported_future_authority() {
        let db = full_migrated_db();
        let future = "2099-01-01T00:00:00.000Z";
        insert_imported_run_with_lifecycle(
            &db,
            "imported-future",
            future,
            Some(future),
            Some(future),
        );

        // Manual create is a project-scoped lifecycle allocation, including
        // the implicit start for a Run seeded with work.
        create_run_with_task(&db, "manual-create", "task-create");
        let (created, started, completed) = run_lifecycle(&db, "manual-create");
        assert!(
            created.as_str() > future,
            "manual create moved behind imported authority"
        );
        assert_eq!(started.as_deref(), Some(created.as_str()));
        assert_eq!(completed, None);

        // A pending Run can acquire its first lifecycle start through the
        // task-lease claim route, which must use the same authority.
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("manual-claim".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "spec-manual-claim".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect("create pending Run");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_tasks
                    (id, run_id, task_kind, status, input_json, priority,
                     attempt_count, created_at, version)
                 VALUES ('task-claim', 'manual-claim', 'extract', 'queued', '{}', 0, 0, ?1, 0)",
                params![future],
            )?;
            Ok(())
        })
        .expect("insert queued task for pending Run");
        let claim = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "manual-claim".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "lifecycle-test".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: None,
            },
        )
        .expect("claim pending Run task");
        assert_eq!(claim["claimed"], true);
        let (_, started, _) = run_lifecycle(&db, "manual-claim");
        assert!(
            started.as_deref().is_some_and(|value| value > future),
            "task claim moved Run start behind imported authority: {started:?}"
        );

        // Generic cancellation, completion, and failure all terminalize via
        // the same project-scoped cursor.
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("manual-cancel".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "spec-manual-cancel".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect("create cancellable Run");
        cancel_run(&db, "manual-cancel".to_string(), "project-1".to_string())
            .expect("cancel manual Run");
        let (created, _, completed) = run_lifecycle(&db, "manual-cancel");
        assert!(completed
            .as_deref()
            .is_some_and(|value| value > created.as_str()));

        create_run_with_task(&db, "manual-finish", "task-finish");
        let claim = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "manual-finish".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "finish-owner".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: None,
            },
        )
        .expect("claim finish task");
        let task = &claim["task"];
        finish_task(
            &db,
            FinishTaskPayload {
                run_id: "manual-finish".to_string(),
                project_id: "project-1".to_string(),
                task_id: task["taskId"].as_str().expect("finish task id").to_string(),
                attempt_id: task["attemptId"]
                    .as_str()
                    .expect("finish attempt id")
                    .to_string(),
                lease_owner: "finish-owner".to_string(),
                output_json: Some(json!({"ok": true})),
                artifacts: vec![],
                chronicle_stage_bundle: None,
                chronicle_stage_receipts: vec![],
                historical_scope_authority_basis: None,
                chronicle_plan_proposal_set: None,
            },
        )
        .expect("finish task");
        let (created, _, completed) = run_lifecycle(&db, "manual-finish");
        assert!(completed
            .as_deref()
            .is_some_and(|value| value > created.as_str()));

        create_run_with_task(&db, "manual-fail", "task-fail");
        let claim = claim_task(
            &db,
            ClaimTaskPayload {
                run_id: "manual-fail".to_string(),
                project_id: "project-1".to_string(),
                lease_owner: "fail-owner".to_string(),
                lease_duration_secs: Some(300),
                task_kinds: None,
            },
        )
        .expect("claim fail task");
        let task = &claim["task"];
        fail_task(
            &db,
            FailTaskPayload {
                run_id: "manual-fail".to_string(),
                project_id: "project-1".to_string(),
                task_id: task["taskId"].as_str().expect("fail task id").to_string(),
                attempt_id: task["attemptId"]
                    .as_str()
                    .expect("fail attempt id")
                    .to_string(),
                lease_owner: "fail-owner".to_string(),
                error_message: "expected failure".to_string(),
                output_json: None,
                requeue: Some(false),
            },
        )
        .expect("fail task");
        let (created, _, completed) = run_lifecycle(&db, "manual-fail");
        assert!(completed
            .as_deref()
            .is_some_and(|value| value > created.as_str()));
    }

    #[test]
    fn malformed_imported_lifecycle_is_ignored_and_maximum_fails_closed() {
        // A malformed imported lifecycle component is corrupted ordering
        // evidence: `next_run_lifecycle_timestamp_in_tx` cannot prove any
        // allocation orders after it, so the allocator fails closed with
        // NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID instead of silently ordering
        // new work past the broken row.
        let malformed = full_migrated_db();
        insert_imported_run_with_lifecycle(
            &malformed,
            "imported-malformed",
            "not-an-instant",
            None,
            None,
        );
        let malformed_error = create_run(
            &malformed,
            CreateRunPayload {
                run_id: Some("run-after-malformed".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "malformed".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect_err("malformed imported ordering evidence must fail the allocator closed");
        assert!(malformed_error
            .to_string()
            .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID"));

        let overflow = full_migrated_db();
        insert_imported_run_with_lifecycle(
            &overflow,
            "imported-overflow",
            "9999-12-31T23:59:59.999Z",
            Some("9999-12-31T23:59:59.999Z"),
            Some("9999-12-31T23:59:59.999Z"),
        );
        let error = create_run(
            &overflow,
            CreateRunPayload {
                run_id: Some("must-not-overflow".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "overflow".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect_err("maximum imported lifecycle must fail closed");
        assert!(error
            .to_string()
            .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_OVERFLOW"));
    }

    #[test]
    fn list_resumable_runs_orders_mixed_legacy_and_rfc3339_instants() {
        let db = full_migrated_db();
        db.with_conn(|conn| {
            for (run_id, status, created_at, started_at, completed_at) in [
                (
                    "run-legacy-space",
                    "running",
                    "2026-08-23 09:59:00",
                    Some("2026-08-23 10:00:00"),
                    None,
                ),
                (
                    "run-rfc3339-millis",
                    "completed",
                    "2026-08-23T09:58:00.000Z",
                    Some("2026-08-23T09:58:00.000Z"),
                    Some("2026-08-23T09:59:59.900Z"),
                ),
            ] {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at, version)
                     VALUES (?1, 'project-1', 'chronicle.extract', '{}', '{}', 'digest',
                             ?2, '{}', ?3, ?4, ?5, 0)",
                    params![run_id, status, created_at, started_at, completed_at],
                )?;
            }
            Ok(())
        })
        .expect("insert mixed timestamp Runs");

        for run_id in ["run-legacy-space", "run-rfc3339-millis"] {
            save_proposal_set(
                &db,
                SaveProposalSetPayload {
                    run_id: run_id.to_string(),
                    project_id: "project-1".to_string(),
                    proposal_set_id: Some(format!("set-{run_id}")),
                    set_kind: "chronicle.extract.review@1".to_string(),
                    summary_json: None,
                    proposals: vec![ProposalSeed {
                        proposal_id: Some(format!("proposal-{run_id}")),
                        proposal_key: format!("key-{run_id}"),
                        kind: "chronicle.event.create@1".to_string(),
                        payload_json: json!({ "title": run_id }),
                        reconciliation_envelope: None,
                    }],
                },
            )
            .expect("insert resumable ProposalSet");
        }

        let listed = list_resumable_runs(
            &db,
            ListResumableRunsPayload {
                project_id: "project-1".to_string(),
                surface_path_id: None,
                limit: Some(10),
            },
        )
        .expect("list mixed timestamp Runs");
        let run_ids: Vec<&str> = listed
            .as_array()
            .expect("resumable list")
            .iter()
            .map(|run| run["runId"].as_str().expect("runId"))
            .collect();
        assert_eq!(
            run_ids,
            vec!["run-legacy-space", "run-rfc3339-millis"],
            "ordering must compare instants, not the legacy space versus RFC3339 separator"
        );
    }

    /// Inserts a minimal `tree_nodes` scene row so `scene_body_envelope`
    /// below can build an envelope whose `sourceBasis`/`readSet`
    /// `revisionToken` actually matches what
    /// `source_revision::resolve_source_revision`'s `scene-body` resolver
    /// (`format!("v{version}@{updated_at}")`) will independently compute --
    /// `validate_envelope_source_tokens` re-resolves and compares against
    /// this live row, so a fabricated token would fail closed.
    fn seed_scene(db: &Database, scene_id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, version)
                 VALUES (?1, 'project-1', 'scene', 'Scene', 0)",
                params![scene_id],
            )?;
            Ok(())
        })
        .expect("seed scene");
    }

    fn scene_body_envelope(db: &Database, run_id: &str, task_id: &str, scene_id: &str) -> Value {
        use super::super::commit::digest_plan;
        let (version, updated_at): (i64, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT version, updated_at FROM tree_nodes
                      WHERE id = ?1 AND project_id = 'project-1'",
                    params![scene_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("scene source revision");
        // `sourceBasis[].sourceKey` must equal this same Source's
        // `readSet[].inputRef` (`validate_reconciliation_envelope`'s
        // NEX_ENVELOPE_SOURCE_BASIS_NOT_READ check), and `resolve_scene_body`
        // requires that shared value to already carry the `project:scene:`
        // prefix -- `record_revision_dependency_edges_in_tx` uses it verbatim as
        // the Edge's `source_object_identity`, so one prefixed value serves
        // both fields.
        let source_key = format!("project:scene:{scene_id}");
        let revision_token = format!("v{version}@{updated_at}");
        let read_set = json!([{
            "kind": "snapshot-document",
            "inputRef": source_key.clone(),
            "sourceKind": "scene-body",
            "revisionToken": revision_token.clone()
        }]);
        json!({
            "changeKind": "revise",
            "readSetDigest": format!("sha256:{}", digest_plan(&read_set)),
            "readSet": read_set,
            "evidenceSet": [],
            "sourceBasis": [{
                "revisionToken": revision_token,
                "sourceKey": source_key,
                "sourceKind": "scene-body"
            }],
            "proposalSchemaVersion": "1",
            "proposalSchemaId": "chronicle.event",
            "reconcilerVersion": "1.0.0",
            "reconcilerId": "test.reconciler",
            "taskId": task_id,
            "runId": run_id,
            "schemaVersion": 1
        })
    }

    /// Gate C2-2's exit criterion, as a test. This deliberately replaces
    /// `saving_proposals_declares_dependency_edges_under_the_owning_run`,
    /// which asserted the opposite -- that two sibling Proposals' Edges land
    /// under one Run Consumer -- and so pinned the very grain C2-2 exists to
    /// replace.
    #[test]
    fn saving_proposals_declares_dependency_edges_per_revision_not_per_run() {
        use super::super::dependency_edges::{
            find_edges_by_consumer, PROPOSAL_REVISION_CONSUMER_KIND,
        };

        let db = current_schema_full_db();
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("run-1".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({ "domain": "chronicle" }),
                spec_digest: "digest-1".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![CreateTaskSeed {
                    task_id: Some("task-1".to_string()),
                    task_kind: "plan_windows".to_string(),
                    input_json: None,
                    priority: None,
                }],
            },
        )
        .expect("create run");
        seed_scene(&db, "scene-1");
        seed_scene(&db, "scene-2");

        // Two sibling Proposals in one Proposal Set, each reading a
        // different Source.
        let envelope_1 = scene_body_envelope(&db, "run-1", "task-1", "scene-1");
        let envelope_2 = scene_body_envelope(&db, "run-1", "task-1", "scene-2");
        save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "run-1".to_string(),
                project_id: "project-1".to_string(),
                proposal_set_id: Some("set-1".to_string()),
                set_kind: "chronicle.extract.review@1".to_string(),
                summary_json: None,
                proposals: vec![
                    ProposalSeed {
                        proposal_id: Some("proposal-1".to_string()),
                        proposal_key: "key-1".to_string(),
                        kind: "chronicle.event.create@1".to_string(),
                        payload_json: json!({ "title": "A" }),
                        reconciliation_envelope: Some(envelope_1),
                    },
                    ProposalSeed {
                        proposal_id: Some("proposal-2".to_string()),
                        proposal_key: "key-2".to_string(),
                        kind: "chronicle.event.create@1".to_string(),
                        payload_json: json!({ "title": "B" }),
                        reconciliation_envelope: Some(envelope_2),
                    },
                ],
            },
        )
        .expect("save proposal set");

        // Nothing is declared under the Run any more.
        let run_edges = db
            .with_conn(|conn| {
                find_edges_by_consumer(conn, "project-1", "narrative-extraction-run", "run-1")
            })
            .expect("find edges by run consumer");
        assert!(
            run_edges.is_empty(),
            "the Run is no longer the Consumer of its Proposals' reads"
        );

        // Each sibling's read belongs to its own Revision, so staling one
        // cannot reach the other -- the whole point of the re-key.
        let revisions = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT p.id, r.id FROM narrative_proposals p
                       JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
                      WHERE p.proposal_set_id = 'set-1'
                      ORDER BY p.id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read the two Revisions");
        assert_eq!(revisions.len(), 2);

        let mut seen = Vec::new();
        for (proposal_id, revision_id) in &revisions {
            let edges = db
                .with_conn(|conn| {
                    find_edges_by_consumer(
                        conn,
                        "project-1",
                        PROPOSAL_REVISION_CONSUMER_KIND,
                        revision_id,
                    )
                })
                .expect("find edges by revision consumer");
            assert_eq!(
                edges.len(),
                1,
                "{proposal_id}'s Revision must declare exactly its own read"
            );
            assert_eq!(
                edges[0].owning_run_id.as_deref(),
                Some("run-1"),
                "the declaring Run is still recorded, as provenance"
            );
            assert!(edges[0].read_set_json.starts_with(r#"["v0@"#));
            seen.push(edges[0].source_object_identity.clone());
        }
        seen.sort();
        assert_eq!(
            seen,
            vec![
                "project:scene:scene-1".to_string(),
                "project:scene:scene-2".to_string()
            ],
            "between them the two Revisions still cover both Sources"
        );

        // A legacy-unbound Proposal (no envelope) in the same Run must not
        // fail or declare any Edge.
        save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "run-1".to_string(),
                project_id: "project-1".to_string(),
                proposal_set_id: Some("set-2".to_string()),
                set_kind: "chronicle.extract.review@1".to_string(),
                summary_json: None,
                proposals: vec![ProposalSeed {
                    proposal_id: Some("proposal-3".to_string()),
                    proposal_key: "key-3".to_string(),
                    kind: "chronicle.event.create@1".to_string(),
                    payload_json: json!({ "title": "C" }),
                    reconciliation_envelope: None,
                }],
            },
        )
        .expect("save legacy-unbound proposal set");

        let total_after: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count edges after the legacy-unbound proposal");
        assert_eq!(
            total_after, 2,
            "a legacy-unbound Proposal has no envelope, so it declares nothing and \
             disturbs no sibling Revision's Edges"
        );
    }

    fn seed_epoch(db: &Database, project_id: &str) -> String {
        db.with_conn(|conn| super::super::create_epoch_in_tx(conn, project_id, "initial", None))
            .expect("create epoch")
    }

    #[test]
    fn create_system_run_writes_kind_epoch_and_work_key() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");

        let created = create_system_run(
            &db,
            "project-1",
            "dependency-verify",
            &epoch_id,
            "verify-work-key",
            &json!({ "graphContractDigest": "digest-graph-1" }),
            "spec-digest-1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create system run");
        assert_eq!(created["status"], "running");
        assert_eq!(created["reused"], false);
        let run_id = created["runId"].as_str().expect("runId").to_string();

        let (run_kind, semantic_epoch_id, work_key, spec_digest): (String, String, String, String) =
            db.with_conn(|conn| {
                conn.query_row(
                    "SELECT run_kind, semantic_epoch_id, work_key, spec_digest
                       FROM narrative_extraction_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(Into::into)
            })
            .expect("read created run");
        assert_eq!(run_kind, "dependency-verify");
        assert_eq!(semantic_epoch_id, epoch_id);
        assert_eq!(work_key, "verify-work-key");
        assert_eq!(spec_digest, "spec-digest-1");
    }

    #[test]
    fn create_system_run_running_only_reuses_running_but_not_completed() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        let spec = json!({});

        let first = create_system_run(
            &db,
            "project-1",
            "semantic-index-rebuild",
            &epoch_id,
            "rebuild-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create first run");
        assert_eq!(first["reused"], false);

        // A second request against the same work_key while the first is
        // still 'running' must reuse it, not create a duplicate.
        let second = create_system_run(
            &db,
            "project-1",
            "semantic-index-rebuild",
            &epoch_id,
            "rebuild-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create second run");
        assert_eq!(second["reused"], true);
        assert_eq!(second["runId"], first["runId"]);

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'completed' WHERE id = ?1",
                params![first["runId"].as_str().expect("runId")],
            )?;
            Ok(())
        })
        .expect("mark first run completed");

        // RunningOnly must not reuse a completed Run: a fresh rebuild
        // request after the prior one finished must be able to run again.
        let third = create_system_run(
            &db,
            "project-1",
            "semantic-index-rebuild",
            &epoch_id,
            "rebuild-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create third run");
        assert_eq!(third["reused"], false);
        assert_ne!(third["runId"], first["runId"]);
    }

    #[test]
    fn create_system_run_running_and_completed_reuses_a_completed_run() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        let spec = json!({});

        let first = create_system_run(
            &db,
            "project-1",
            "backfill",
            &epoch_id,
            "backfill-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningAndCompleted,
            None,
        )
        .expect("create first run");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'completed' WHERE id = ?1",
                params![first["runId"].as_str().expect("runId")],
            )?;
            Ok(())
        })
        .expect("mark first run completed");

        // dependency-backfill's automatic-once trigger firing again after
        // the prior attempt already completed must not create a second Run.
        let second = create_system_run(
            &db,
            "project-1",
            "backfill",
            &epoch_id,
            "backfill-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningAndCompleted,
            None,
        )
        .expect("create second run");
        assert_eq!(second["reused"], true);
        assert_eq!(second["runId"], first["runId"]);
    }

    #[test]
    fn create_system_run_none_reuse_never_dedups() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        let spec = json!({});

        let first = create_system_run(
            &db,
            "project-1",
            "dependency-repair",
            &epoch_id,
            "repair-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::None,
            None,
        )
        .expect("create first run");
        let second = create_system_run(
            &db,
            "project-1",
            "dependency-repair",
            &epoch_id,
            "repair-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::None,
            None,
        )
        .expect("create second run");
        assert_eq!(first["reused"], false);
        assert_eq!(second["reused"], false);
        assert_ne!(first["runId"], second["runId"]);
    }
}
