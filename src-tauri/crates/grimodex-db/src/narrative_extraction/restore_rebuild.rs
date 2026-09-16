//! Gate C2 Lane N -- Restore/Rebuild: Semantic Epoch rotation on
//! restore/migration, and read-only + repair diagnostics for the Dependency
//! Edge graph a full rebuild needs to reconcile.
//!
//! This module composes three earlier Lanes without modifying any of them:
//! Lane A's Semantic Epoch ledger (`semantic_epoch.rs`), Lane G's Dependency
//! Edge storage (`dependency_edges.rs`), and Lane E's Source revision
//! resolver (`source_revision.rs`).

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use grimodex_core::narrative_dependency::{
    aggregate_dependency_build_actions, evaluate_dependency_effect, load_dependency_role_registry,
    DependencyEffectInput, SourceChangeClass,
};

use super::consumer_identity::{
    is_declared_consumer_kind, is_reserved_semantic_index_consumer_kind, owning_run_id_for_consumer,
};
use super::declaration_storage::{
    list_dependency_declaration_head_keys_in_tx, read_active_dependency_declaration_set_in_tx,
    ActiveDependencyDeclarationSetRead,
};
use super::dependency_edges::{
    consumer_dependency_set_digest, find_edges_by_consumer,
    parse_snapshot_run_id_from_source_identity, project_id_for_run,
    run_id_belongs_to_another_project, DependencyEdge, APPLICATION_CONSUMER_KIND,
    PROPOSAL_REVISION_CONSUMER_KIND, RUN_CONSUMER_KIND,
};
use super::digest_plan;
use super::evaluator::{
    evaluate_edge, unknown_edge_observation, EdgeComparisonInput, EdgeObservation,
};
#[cfg(test)]
use super::execution_state::transition_run_status_in_tx;
use super::execution_state::NarrativeRunStatus;
use super::finding_identity::{
    stable_finding_identity, BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION,
    MAINTENANCE_FAILURE_FINDING_RULE_ID,
};
use super::maintenance_contracts::{
    current_maintenance_coordinates, MaintenanceContractCoordinates,
};
use super::maintenance_lifecycle::{
    canonical_failure_message, complete_maintenance_run_in_tx, create_maintenance_run_in_tx,
    fail_maintenance_run_in_tx, hold_maintenance_run_in_tx, load_maintenance_run_in_tx,
    MaintenanceFailureKind,
};
use super::maintenance_runtime::validate_phase_success_outcome;
use super::maintenance_skip_evidence::{
    persist_completed_run_skip_evidence_in_tx, CompletedRunSkipEvidence,
};
use super::publish_runtime::publish_freshness_evaluation_edges_only_in_tx;
#[cfg(test)]
use super::repository::create_system_run_in_tx;
use super::repository::{record_run_outcome_in_tx, SystemRunWorkKeyReuse};
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};
use super::source_revision::resolve_current_source_state;
use super::task_leases::with_immediate_transaction;
use super::terminal_failure::{
    project_terminal_failure_for_run_generated_in_tx,
    resolve_terminal_failure_for_run_generated_in_tx,
};
use super::verify_coverage::{self, VerifyCoverageCheck};
use crate::Database;
use uuid::Uuid;

const RESTORE_EPOCH_ID_DOMAIN: &[u8] = b"grimodex:semantic-epoch:restore:v1";

type RebuildRunIdentityRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);
type DurableEdgeRunResolutionRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
);
type DurableEdgeArtifactSourceRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
);
type DurableEdgeCaptureSourceRow = (String, String, String, Option<String>, i64, String, String);

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
}

/// Derive the restore Semantic Epoch ID from the project and the canonical
/// restore identity.  Length-delimited fields keep the project and image
/// boundaries unambiguous, while the domain prefix prevents this digest from
/// being reused as an identifier for another kind of object.
pub(crate) fn deterministic_restore_epoch_id(project_id: &str, restore_identity: &str) -> String {
    let mut hasher = Sha256::new();
    for value in [
        RESTORE_EPOCH_ID_DOMAIN,
        project_id.as_bytes(),
        restore_identity.as_bytes(),
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    let digest = hasher.finalize();
    let mut uuid_bytes = [0_u8; 16];
    uuid_bytes.copy_from_slice(&digest[..16]);
    // SHA-256 supplies deterministic entropy; mark the UUID as a name-based
    // (v5-equivalent) identifier and use the RFC 4122 variant so every
    // consumer can parse and classify the persisted Semantic Epoch ID.
    uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x50;
    uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(uuid_bytes).to_string()
}

fn create_restore_epoch_in_tx(
    conn: &Connection,
    project_id: &str,
    restore_identity: &str,
) -> anyhow::Result<String> {
    require_non_empty(project_id, "projectId")?;
    require_non_empty(restore_identity, "restoreIdentity")?;
    let epoch_number: i64 = conn.query_row(
        "SELECT COALESCE(MAX(epoch_number), -1) + 1
           FROM narrative_semantic_epochs
          WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let epoch_id = deterministic_restore_epoch_id(project_id, restore_identity);
    let created_at = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    conn.execute(
        "INSERT INTO narrative_semantic_epochs
            (id, project_id, epoch_number, reason, triggered_by_change_event_uid, created_at)
         VALUES (?1, ?2, ?3, 'restore', ?4, ?5)",
        params![
            epoch_id,
            project_id,
            epoch_number,
            restore_identity,
            created_at
        ],
    )?;
    Ok(epoch_id)
}

// ---------------------------------------------------------------------
// 1. Epoch rotation trigger
// ---------------------------------------------------------------------

/// Recognized `structuralImpact.event` values that mark a Semantic Epoch
/// reset, and the Semantic Epoch `reason` (Lane A's closed five-value
/// vocabulary, `semantic_epoch::VALID_REASONS`) each one maps to when this
/// Lane mints the new Epoch.
///
/// This is the same pair of trigger values `change_feed.rs`'s
/// `ensure_event_history_continuity` recognizes via its private
/// `is_epoch_reset` local (see that function's doc comment: a Change Feed
/// event whose `object_key.kind == "project"` and whose
/// `structuralImpact.event` is `"project-restored"` or
/// `"semantic-epoch-reset"` starts a new Semantic Epoch and is exempt from
/// that function's normal before/after continuity check). `change_feed.rs`
/// only needs a boolean out of that check (was this event an epoch reset, at
/// all), so it never decides *which* Semantic Epoch `reason` a reset maps
/// to. This Lane does need that mapping -- it is the caller that actually
/// mints the Epoch row Lane A's ledger stores -- so the two recognized
/// values are reimplemented here as a `match` with an explicit `reason` arm
/// each, rather than importing a shared boolean helper. Per this Lane's
/// task brief, `change_feed.rs` itself is read-only background and is not
/// touched or refactored to expose the check; duplicating the two literal
/// values here is the accepted tradeoff.
///
/// Any other `structural_impact_event` value (including one that is not a
/// recognized `structuralImpact.event` at all) rotates nothing and returns
/// `Ok(None)` -- this function is deliberately narrow and never guesses at
/// an Epoch reset the way `change_feed.rs`'s own check does not either.
pub(crate) fn rotate_epoch_for_restore_in_tx(
    conn: &Connection,
    project_id: &str,
    structural_impact_event: &str,
    triggered_by_change_event_uid: Option<&str>,
) -> anyhow::Result<Option<String>> {
    require_non_empty(project_id, "projectId")?;
    let reason = match structural_impact_event {
        "project-restored" => "restore",
        "semantic-epoch-reset" => "migration",
        _ => return Ok(None),
    };
    let epoch_id = create_epoch_in_tx(conn, project_id, reason, triggered_by_change_event_uid)?;
    // The wake identity commits with the rotation. The observer event that
    // lib.rs emits after commit is only a prompt to drain this outbox: if the
    // event is lost (crash between commit and emit, dropped listener, or an
    // idempotent replay that suppresses re-emission), the pending row still
    // re-delivers the wake at the next drain point.
    record_maintenance_wake_in_tx(conn, project_id, structural_impact_event)?;
    Ok(Some(epoch_id))
}

/// One pending durable maintenance wake written by an Epoch rotation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMaintenanceWake {
    pub id: String,
    pub project_id: String,
    pub operation: String,
    pub reason: String,
    pub created_at: String,
}

pub(crate) fn record_maintenance_wake_in_tx(
    conn: &Connection,
    project_id: &str,
    operation: &str,
) -> anyhow::Result<()> {
    record_maintenance_wake_with_reason_in_tx(conn, project_id, operation, "semantic-epoch-rotated")
}

fn record_maintenance_wake_with_reason_in_tx(
    conn: &Connection,
    project_id: &str,
    operation: &str,
    reason: &str,
) -> anyhow::Result<()> {
    require_non_empty(project_id, "projectId")?;
    require_non_empty(operation, "operation")?;
    require_non_empty(reason, "reason")?;
    conn.execute(
        "INSERT INTO narrative_maintenance_wake_outbox
            (id, project_id, operation, reason, created_at)
         VALUES (?1, ?2, ?3, ?4,
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![
            uuid::Uuid::new_v4().to_string(),
            project_id,
            operation,
            reason
        ],
    )?;
    Ok(())
}

/// Persist a native-owned wake after Electron has exhausted its bounded
/// delivery retries. The durable outbox, rather than a process-local parked
/// Map, is the recovery owner across a crash/restart. It intentionally does
/// not emit an observer event: immediately re-discovering the same failed
/// delivery would recreate an unbounded retry loop; the next ordinary open,
/// accepted cycle, or explicit drain replays the durable row.
pub fn record_maintenance_delivery_failure_wake(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<()> {
    require_non_empty(project_id, "projectId")?;
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let project_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                project_exists,
                "NEX_MAINTENANCE_DELIVERY_FAILURE_PROJECT_MISSING: project '{project_id}' does not exist"
            );
            record_maintenance_wake_with_reason_in_tx(
                conn,
                project_id,
                "maintenance-delivery-failure",
                "maintenance-delivery-failure",
            )
        })
    })
}

/// Pending (unacknowledged) maintenance wakes, oldest first.
pub fn list_pending_maintenance_wakes(
    db: &Database,
) -> anyhow::Result<Vec<PendingMaintenanceWake>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, project_id, operation, reason, created_at
               FROM narrative_maintenance_wake_outbox
              WHERE acked_at IS NULL
              ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(PendingMaintenanceWake {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    operation: row.get(2)?,
                    reason: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Acknowledge delivered wakes. Returns the number of rows newly acked.
pub fn ack_maintenance_wakes(db: &Database, ids: &[String]) -> anyhow::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    db.with_conn(|conn| {
        let mut acked = 0usize;
        for id in ids {
            acked += conn.execute(
                "UPDATE narrative_maintenance_wake_outbox
                    SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  WHERE id = ?1 AND acked_at IS NULL",
                params![id],
            )?;
        }
        Ok(acked)
    })
}

/// Mint one restore-boundary Epoch per project in a newly installed backup.
/// `restore_identity` is a domain-separated identity derived from the sealed
/// pre-Epoch candidate image (for example
/// `restore-image-sha256:<hex>`), not a raw change-event UID. It is stored in
/// `triggered_by_change_event_uid` only as the durable exactly-once correlate
/// for this restore install. A crash and retry against the same candidate
/// observes the existing marker rather than minting a second Epoch. The whole
/// project set is committed atomically on the staged candidate before its
/// image is installed or its authority is published.
pub fn ensure_restore_epochs_for_workspace(
    db: &Database,
    restore_identity: &str,
) -> anyhow::Result<Vec<String>> {
    let restore_identity = restore_identity.trim();
    require_non_empty(restore_identity, "restoreIdentity")?;
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let project_ids = {
                let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            let mut minted = Vec::new();
            for project_id in project_ids {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT id
                           FROM narrative_semantic_epochs
                          WHERE project_id = ?1 AND reason = 'restore'
                            AND triggered_by_change_event_uid = ?2
                          ORDER BY epoch_number DESC, id DESC LIMIT 1",
                        params![project_id, restore_identity],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(epoch_id) = existing {
                    minted.push(epoch_id);
                    continue;
                }
                let epoch_id = create_restore_epoch_in_tx(conn, &project_id, restore_identity)?;
                minted.push(epoch_id);
            }
            Ok(minted)
        })
    })
}

// ---------------------------------------------------------------------
// 2. Rebuild verify diagnostics (read-only)
// ---------------------------------------------------------------------

/// This diagnostic looks a Run's own declared Edges up through
/// `find_edges_by_consumer(project_id, RUN_CONSUMER_KIND, run_id)` --
/// [`RUN_CONSUMER_KIND`] and the `consumer_key = run_id` convention live in
/// `dependency_edges.rs`, which also owns the Producer side that now
/// declares Edges under this identity (`repository.rs`'s
/// `insert_proposal_seed`/`append_revision_on_conn`, wired in C2-T1).
///
/// Read-only diagnostic report: how many of a Run's declared Dependency
/// Edges point at a Source that no longer resolves. Never written to a
/// table -- callers that want this persisted (e.g. as a Finding Observation,
/// Lane C) own that decision separately.
/// The single-Run diagnostic remains available to focused/manual callers;
/// [`verify_narrative_dependency_graph_for_project`] is the project-wide
/// Verify entry point used by the Rust phase owner and IPC boundary.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RebuildVerifyReport {
    pub total_edges: usize,
    pub missing_sources: usize,
    pub edge_ids_with_missing_source: Vec<String>,
}

/// Maps a Dependency Edge's `source_object_identity` to the `source_kind`
/// string `source_revision::resolve_source_revision`'s `match` dispatches
/// on, by testing the same literal prefixes that module's resolvers strip
/// (`resolve_scene_body`, `resolve_snapshot_document`, ...). This mapping
/// must stay in lockstep with those prefixes; `source_revision.rs` is
/// read-only for this Lane so the mapping is reimplemented here rather than
/// exposed from that module. An identity matching none of the recognized
/// prefixes returns `None` -- `rebuild_verify_dependency_edges` treats that
/// the same as a missing Source (see its doc comment) rather than silently
/// skipping the Edge.
fn infer_source_kind(source_object_identity: &str) -> Option<&'static str> {
    if source_object_identity.starts_with("project:nir1-chronicle-eligibility:") {
        Some(super::nir1_chronicle_index::SOURCE_KIND)
    } else if source_object_identity.starts_with("project:nir1-entity-relation-eligibility:") {
        Some(super::nir1_entity_relation_index::SOURCE_KIND)
    } else if source_object_identity.starts_with("codex-relation:") {
        Some("codex-relation")
    } else if source_object_identity.starts_with("codex:") {
        Some("codex-entry")
    } else if source_object_identity.starts_with("scope-dependency:v1:") {
        Some("scope-dependency-projection-v1")
    } else if source_object_identity.starts_with("project:scope-authority:") {
        Some("project-scope-authority")
    } else if source_object_identity.starts_with("project:scene:") {
        Some("scene-body")
    } else if source_object_identity.starts_with("snapshot:") {
        Some("snapshot-document")
    } else if source_object_identity.starts_with("project:codex-catalog:") {
        Some("codex-catalog")
    } else if source_object_identity.starts_with("projection:") {
        Some("domain-projection")
    } else if source_object_identity.starts_with("artifact:") {
        Some("narrative-artifact")
    } else if source_object_identity.starts_with("capture:") {
        Some("import-capture")
    } else if source_object_identity.starts_with("evidence:") {
        Some("evidence-anchor")
    } else {
        None
    }
}

/// Builds a `evaluator::EdgeComparisonInput` for one Dependency Edge from
/// real DB state -- the piece nothing in this crate wired up before Gate C2
/// Run Kind Policy work: `evaluator::evaluate_edge` is a pure function of
/// this struct, but until now nothing ever constructed one from a live
/// Edge.
///
/// The stored comparison basis is the Edge's own Producer-time observation
/// (`read_set_json`'s single recorded token -- ADR 005's Producer-time
/// Dependency Declaration; see `dependency_edges.rs`/`repository.rs`'s
/// `record_run_dependency_edges_in_tx`). That token is immutable until a
/// new Producer run re-declares the Edge (`record_dependency_edge_in_tx`'s
/// upsert), which is exactly the right invariant: a Consumer correctly
/// keeps reading Stale/whatever this evaluator reports until it is
/// actually reproduced, not until someone merely re-runs this evaluator
/// again. The current signal is a fresh read of the Source right now
/// (`source_revision::resolve_current_source_state`, the same resolver
/// `edge_source_is_missing` above already uses).
///
/// `stored_digest`/`current_digest` mirror `resolve_current_source_state`'s
/// own convention: a revision token that happens to look like a digest
/// (`sha256:...`) doubles as its own digest; most Source kinds have no
/// separate digest concept, so this is not a loss of a distinct signal
/// this crate tracks elsewhere.
///
/// This generic builder supplies a healthy baseline for range/normalizer/
/// component signals because rebuild callers have no mutation-local mapping
/// to compare. Gate C2-1's incremental runtime enriches that baseline from
/// the sealed Change Feed event and optional structured range metadata before
/// calling `evaluate_edge`, making `AnchorMismatch`/`ReadSetDrift` and the
/// compatibility `Unknown` branches reachable on the mutation path without
/// changing full-rebuild semantics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedEdgeSourceState {
    current_source_exists: bool,
    comparison_available: bool,
    current_revision_token: Option<String>,
    current_digest: Option<String>,
}

pub(crate) fn resolve_edge_source_state(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<ResolvedEdgeSourceState> {
    let Some(source_kind) = infer_source_kind(&edge.source_object_identity) else {
        return Ok(ResolvedEdgeSourceState {
            current_source_exists: false,
            comparison_available: true,
            current_revision_token: None,
            current_digest: None,
        });
    };
    let state = resolve_current_source_state(
        conn,
        project_id,
        run_id,
        source_kind,
        &edge.source_object_identity,
    )?;
    Ok(ResolvedEdgeSourceState {
        current_source_exists: state.exists,
        comparison_available: state.usable,
        current_revision_token: state.revision_token,
        current_digest: state.content_digest,
    })
}

pub(crate) fn build_edge_comparison_input_from_source_state(
    edge: &DependencyEdge,
    source_state: &ResolvedEdgeSourceState,
) -> anyhow::Result<EdgeComparisonInput> {
    let stored_revision_token = first_read_set_token(&edge.read_set_json)?;
    let stored_digest = stored_revision_token
        .as_deref()
        .filter(|token| token.starts_with("sha256:"))
        .map(str::to_string);

    Ok(EdgeComparisonInput {
        stored_revision_token,
        stored_digest,
        current_source_exists: source_state.current_source_exists,
        comparison_available: source_state.comparison_available,
        current_revision_token: source_state.current_revision_token.clone(),
        current_digest: source_state.current_digest.clone(),
        ..EdgeComparisonInput::default()
    })
}

pub(crate) fn build_edge_comparison_input(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<EdgeComparisonInput> {
    let source_state = resolve_edge_source_state(conn, project_id, run_id, edge)?;
    build_edge_comparison_input_from_source_state(edge, &source_state)
}

/// The one revision token `record_run_dependency_edges_in_tx` records per
/// Edge (`serde_json::to_string(&[row.revision_token.as_str()])`) -- see
/// that function's own doc comment on why `read_set_json` is a
/// one-element array rather than a real multi-entry read set.
fn first_read_set_token(read_set_json: &str) -> anyhow::Result<Option<String>> {
    let values: Vec<Value> = serde_json::from_str(read_set_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_DEPENDENCY_READ_SET_INVALID: read_set_json must be a JSON array: {error}"
        )
    })?;
    values
        .into_iter()
        .next()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_DEPENDENCY_READ_SET_INVALID: the first read_set_json item must be a revision token string"
                )
            })
        })
        .transpose()
}

/// Combines [`build_edge_comparison_input`] and `evaluator::evaluate_edge`:
/// the full "evaluate one real Edge's Freshness right now" step. Read-only
/// -- like [`build_edge_comparison_input`], issues only `SELECT`s and is
/// safe to call outside a transaction. Persisting the result
/// (`publish_runtime.rs`'s `write_edge_state_in_tx`/
/// `write_consumer_freshness_in_tx`/`record_finding_observation_in_tx`) is
/// the caller's decision.
pub(crate) fn evaluate_edge_from_db(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<EdgeObservation> {
    let input = build_edge_comparison_input(conn, project_id, run_id, edge)?;
    Ok(evaluate_edge(&input))
}

/// Evaluate a set whose Sources each name their own Run in one caller-owned
/// SQLite snapshot. Only the current project authority is shared; every Source
/// binding and comparison is verified. The authority cannot escape this call,
/// and this loop performs no writes or callbacks between its reads.
pub(crate) fn evaluate_owned_edges_from_db_in_tx(
    conn: &Connection,
    project_id: &str,
    edges: &[DependencyEdge],
) -> anyhow::Result<Vec<EdgeObservation>> {
    anyhow::ensure!(!conn.is_autocommit(), "Edge batch requires a transaction");
    let mut authority = None;
    edges
        .iter()
        .map(|edge| {
            let run_id = edge.owning_run_id.as_deref().unwrap_or("");
            let Some(source_kind) = infer_source_kind(&edge.source_object_identity) else {
                return evaluate_edge_from_db(conn, project_id, run_id, edge);
            };
            let state = super::source_revision::resolve_current_source_state_in_batch(
                conn,
                project_id,
                run_id,
                source_kind,
                &edge.source_object_identity,
                &mut authority,
            )?;
            let state = ResolvedEdgeSourceState {
                current_source_exists: state.exists,
                comparison_available: state.usable,
                current_revision_token: state.revision_token,
                current_digest: state.content_digest,
            };
            Ok(evaluate_edge(
                &build_edge_comparison_input_from_source_state(edge, &state)?,
            ))
        })
        .collect()
}

// ---------------------------------------------------------------------
// 1b. dependency-rebuild-derived orchestrator (Run Kind Policy)
// ---------------------------------------------------------------------

/// Work key every project's Rebuild-Derived Run is created under.
/// `sameWorkKeyReuse: "reuse-running-only"` (Run Kind Policy) needs only
/// enough identity to stop two concurrent rebuilds of the same project
/// racing each other -- unlike Backfill, a completed Run under this key is
/// deliberately *not* reused, so a fresh trigger event can always start a
/// new rebuild.
const REBUILD_DERIVED_WORK_KEY: &str = "dependency-rebuild-derived";

/// Rebuild-Derived is the only writer that deliberately publishes one
/// Consumer at a time.  Every such transaction must prove that it still owns
/// the Run it is publishing for: a rotated Epoch or a reused/terminal Run is
/// not allowed to overwrite the current Freshness authority.
fn ensure_rebuild_run_identity_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<()> {
    let row: Option<RebuildRunIdentityRow> = conn
        .query_row(
            "SELECT project_id, run_kind, semantic_epoch_id, work_key, status
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![run_id],
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
    let Some((run_project_id, run_kind, run_epoch_id, work_key, status)) = row else {
        anyhow::bail!("NEX_REBUILD_DERIVED_RUN_NOT_FOUND: run '{run_id}' was not found");
    };
    anyhow::ensure!(
        run_project_id == project_id,
        "NEX_REBUILD_DERIVED_RUN_PROJECT_MISMATCH: run '{run_id}' does not belong to project '{project_id}'"
    );
    anyhow::ensure!(
        run_kind.as_deref() == Some("semantic-index-rebuild"),
        "NEX_REBUILD_DERIVED_RUN_KIND_MISMATCH: run '{run_id}' is not a semantic-index-rebuild Run"
    );
    anyhow::ensure!(
        work_key.as_deref() == Some(REBUILD_DERIVED_WORK_KEY),
        "NEX_REBUILD_DERIVED_WORK_KEY_MISMATCH: run '{run_id}' is not owned by work key '{REBUILD_DERIVED_WORK_KEY}'"
    );
    anyhow::ensure!(
        run_epoch_id.as_deref() == Some(semantic_epoch_id),
        "NEX_REBUILD_DERIVED_RUN_EPOCH_MISMATCH: run '{run_id}' is not stamped with captured epoch '{semantic_epoch_id}'"
    );
    anyhow::ensure!(
        status == NarrativeRunStatus::Running.as_str(),
        "NEX_REBUILD_DERIVED_RUN_NOT_RUNNING: run '{run_id}' is no longer running"
    );
    Ok(())
}

fn ensure_rebuild_run_is_current_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<()> {
    ensure_rebuild_run_identity_in_tx(conn, project_id, run_id, semantic_epoch_id)?;
    let current_epoch_id = get_current_epoch(conn, project_id)?.map(|epoch| epoch.id);
    anyhow::ensure!(
        current_epoch_id.as_deref() == Some(semantic_epoch_id),
        "NEX_REBUILD_DERIVED_STALE_EPOCH: run '{run_id}' captured epoch '{semantic_epoch_id}', but project '{project_id}' is now at epoch '{}'",
        current_epoch_id.as_deref().unwrap_or("<none>")
    );
    Ok(())
}

fn rebuild_failure_outcome(
    semantic_epoch_id: &str,
    work_error: Option<&str>,
    finalization_error: Option<&str>,
) -> Value {
    let message = match (work_error, finalization_error) {
        (Some(work_error), Some(finalization_error)) => {
            format!("work error: {work_error}; finalization error: {finalization_error}")
        }
        (Some(work_error), None) => work_error.to_string(),
        (None, Some(finalization_error)) => finalization_error.to_string(),
        (None, None) => "rebuild failed without an error context".to_string(),
    };
    let mut failure = serde_json::Map::new();
    failure.insert("message".to_string(), Value::String(message));
    if let Some(work_error) = work_error {
        failure.insert(
            "workError".to_string(),
            Value::String(work_error.to_string()),
        );
    }
    if let Some(finalization_error) = finalization_error {
        failure.insert(
            "finalizationError".to_string(),
            Value::String(finalization_error.to_string()),
        );
    }
    json!({
        "rebuildContractVersion": REBUILD_CONTRACT_VERSION,
        "semanticEpochId": semantic_epoch_id,
        "failure": Value::Object(failure),
    })
}

/// Persist the Rebuild outcome and terminal status as one transaction.
///
/// A rotation between the work phase and this transaction is itself a failed
/// Rebuild, never a successful one.  Its failure evidence is committed under
/// the old Run before the function returns the stale-epoch error.  Other
/// finalization failures remain transaction errors, so callers cannot observe
/// a false `Ran` result.
fn finalize_rebuild_run(
    db: &Database,
    project_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
    work_result: &anyhow::Result<RebuildDerivedStateSummary>,
) -> anyhow::Result<()> {
    let stale_epoch_error = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_rebuild_run_identity_in_tx(conn, project_id, run_id, semantic_epoch_id)?;
            let current_epoch_id = get_current_epoch(conn, project_id)?.map(|epoch| epoch.id);
            if current_epoch_id.as_deref() != Some(semantic_epoch_id) {
                let error = format!(
                    "NEX_REBUILD_DERIVED_STALE_EPOCH: run '{run_id}' captured epoch '{semantic_epoch_id}', but project '{project_id}' is now at epoch '{}'",
                    current_epoch_id.as_deref().unwrap_or("<none>")
                );
                let outcome = rebuild_failure_outcome(
                    semantic_epoch_id,
                    work_result.as_ref().err().map(ToString::to_string).as_deref(),
                    Some(&error),
                );
                record_run_outcome_in_tx(conn, run_id, &outcome)?;
                let handle = load_maintenance_run_in_tx(conn, run_id)?;
                let finalized_at = fail_maintenance_run_in_tx(
                    conn,
                    &handle,
                    MaintenanceFailureKind::Transient,
                    &error,
                )?;
                project_terminal_failure_for_run_generated_in_tx(
                    conn,
                    project_id,
                    run_id,
                    &canonical_failure_message(MaintenanceFailureKind::Transient, &error),
                    &finalized_at,
                    true,
                )?;
                return Ok(Some(error));
            }

            let outcome = match work_result {
                Ok(summary) => {
                    let summary_value = serde_json::to_value(summary)?;
                    let summary_digest = format!("sha256:{}", digest_plan(&summary_value));
                    json!({
                        "rebuildContractVersion": REBUILD_CONTRACT_VERSION,
                        "semanticEpochId": semantic_epoch_id,
                        "summaryDigest": summary_digest,
                        "summary": summary_value,
                    })
                }
                Err(error) => rebuild_failure_outcome(
                    semantic_epoch_id,
                    Some(error.to_string().as_str()),
                    None,
                ),
            };
            if work_result.is_ok() {
                validate_phase_success_outcome(
                    "semantic-index-rebuild",
                    project_id,
                    REBUILD_DERIVED_WORK_KEY,
                    Some(semantic_epoch_id),
                    &outcome,
                )?;
            }
            record_run_outcome_in_tx(conn, run_id, &outcome)?;
            if work_result.is_ok()
                && super::maintenance_runtime::foreground_system_work_barrier_requested()
            {
                // The native foreground barrier owns the terminal transition
                // for the complete Run/Task/Attempt lifecycle.
                let handle = load_maintenance_run_in_tx(conn, run_id)?;
                hold_maintenance_run_in_tx(conn, &handle)?;
                return Ok(None);
            }
            match work_result {
                Ok(_) => {
                    let handle = load_maintenance_run_in_tx(conn, run_id)?;
                    let finalized_at = complete_maintenance_run_in_tx(conn, &handle)?;
                    resolve_terminal_failure_for_run_generated_in_tx(
                        conn,
                        project_id,
                        run_id,
                        &finalized_at,
                    )?;
                }
                Err(error) => {
                    let message = error.to_string();
                    let failure_kind = maintenance_failure_kind_for_message(&message);
                    let handle = load_maintenance_run_in_tx(conn, run_id)?;
                    let finalized_at =
                        fail_maintenance_run_in_tx(conn, &handle, failure_kind, &message)?;
                    project_terminal_failure_for_run_generated_in_tx(
                        conn,
                        project_id,
                        run_id,
                        &canonical_failure_message(failure_kind, &message),
                        &finalized_at,
                        true,
                    )?;
                }
            }
            Ok(None)
        })
    })?;

    if let Some(error) = stale_epoch_error {
        anyhow::bail!(error);
    }
    Ok(())
}

fn maintenance_failure_kind_for_message(message: &str) -> MaintenanceFailureKind {
    let classification = super::maintenance_runtime::classify_failure(message);
    if classification.code == "NEX_MAINTENANCE_INTERRUPTED" {
        MaintenanceFailureKind::Interrupted
    } else if classification.retryable {
        MaintenanceFailureKind::Transient
    } else {
        MaintenanceFailureKind::Manual
    }
}

/// Version of the durable outcome written by the manual Rebuild-Derived
/// executor.  C2-Z's read-only readiness gate must reject an outcome from a
/// writer whose evidence shape it does not understand.
pub(crate) const REBUILD_CONTRACT_VERSION: &str = "1";

/// Outcome of one [`rebuild_narrative_derived_state_for_project`] call.
#[derive(Debug)]
pub enum RebuildDerivedStateOutcome {
    /// A Rebuild-Derived Run for this project was already `running`; this
    /// call did nothing further (`sameWorkKeyReuse: "reuse-running-only"`).
    AlreadyRunning { run_id: String },
    /// This call created a fresh Run and processed every supported Edge
    /// under it, publishing `Unknown` for any Edge it could not evaluate
    /// safely.
    Ran {
        run_id: String,
        summary: RebuildDerivedStateSummary,
    },
}

/// Counts from one completed `rebuild_narrative_derived_state_for_project`
/// pass.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildDerivedStateSummary {
    pub consumers_evaluated: usize,
    pub edges_evaluated: usize,
    /// Consumers this pass could not evaluate because their
    /// `consumer_kind` is outside the declared vocabulary, or because every
    /// one of their Edges had unresolvable Consumer provenance.
    ///
    /// Counted rather than folded into `consumers_evaluated`, and skipped
    /// rather than fatal. The reachable case is version skew -- a newer
    /// build declared Edges under a Consumer class this one does not
    /// implement, or an older/corrupt row violates SCHEMA 30's owner
    /// invariants -- and failing the whole Run there would let one
    /// unreadable Consumer stop the project's entire derived-state rebuild,
    /// including every Consumer this build understands perfectly well.
    /// `verify_narrative_dependency_graph_for_project` reports the same
    /// Edges under `edge_ids_with_unresolvable_consumer_scope`. For a
    /// declared Consumer, Rebuild also publishes explicit `Unknown` Edge
    /// State and Consumer Freshness so a verdict from an earlier pass in the
    /// same Epoch cannot remain authoritative.
    pub consumers_skipped_unresolvable_scope: usize,
    /// Individual Edges skipped because their Consumer kind is outside this
    /// build's vocabulary, or because the Consumer cannot be matched to one
    /// trustworthy declaring Run -- see [`resolve_edge_consumer_scope`].
    /// Counted rather than source-evaluated with a stand-in or inconsistent
    /// Run, which is how a present Source gets called missing. Every such Edge
    /// receives an explicit `Unknown` state for authority invalidation.
    pub edges_skipped_unresolvable_scope: usize,
    /// Ephemeral D2 verification from the complete active D1 head set. This
    /// sidecar is intentionally omitted from the persisted rebuild outcome;
    /// it is returned only to the in-process caller and never becomes V2
    /// Freshness authority.
    #[serde(skip)]
    pub v2_shadow: RebuildShadowVerificationSummary,
}

/// `dependency-rebuild-derived` (Run Kind Policy): discards and recomputes
/// every Rebuildable Derived State row this crate owns today
/// (`narrative_dependency_edge_states`, `narrative_consumer_freshness`,
/// `narrative_maintenance_finding_observations`) from the Durable Graph
/// and current Source state, for every Consumer in the project. Never
/// touches Domain state or the Durable Dependency declarations
/// (`narrative_dependency_edges`, `narrative_application_contributions`)
/// -- those are only ever read here, through
/// [`evaluate_edge_from_db`]/[`build_edge_comparison_input`].
///
/// Composes Lane A (`semantic_epoch`), G (`dependency_edges`), this
/// module's own `evaluate_edge_from_db` (E/F), and J
/// (`publish_runtime::publish_freshness_evaluation_edges_only_in_tx`).
///
/// Owns its own transaction(s) -- callers must not already be inside one.
/// Same 3-phase shape as
/// `legacy_backfill::bootstrap_legacy_dependency_backfill_for_project`,
/// for the same reason (a work-phase failure must not erase the Run
/// record explaining it):
///
///   1. Reuse-check + Run creation (`create_system_run_in_tx`,
///      `SystemRunWorkKeyReuse::RunningOnly`) under the project's
///      *existing* current Semantic Epoch -- unlike Backfill, this does
///      not mint one: Rebuild-Derived recomputes state *from* a Durable
///      Graph that is expected to already exist under a real Epoch: a
///      project with no Epoch yet has nothing for this to rebuild from,
///      so this fails closed (`NEX_REBUILD_DERIVED_NO_EPOCH`) rather than
///      silently minting one for a project that has never had Producer
///      activity.
///   2. For every distinct `(consumer_kind, consumer_key)` this project's
///      Edges declare, evaluate every Edge whose scope can be resolved
///      (`evaluate_edge_from_db`), represent an unresolvable Edge as
///      `Unknown`/`Manual`, and publish the whole batch
///      (`publish_freshness_evaluation_edges_only_in_tx`), in its own
///      transaction per Consumer -- so one Consumer's publish failure
///      does not roll back every other Consumer already rebuilt in this
///      pass. A project with zero Edges is a no-op pass (0 Consumers, 0
///      Edges), not an error.
///   3. Finalize the Run's status to `completed`/`failed`, always
///      attempted even on phase 2 failure.
pub fn rebuild_narrative_derived_state_for_project(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<RebuildDerivedStateOutcome> {
    let now = grimodex_core::now_rfc3339_millis();

    let (run_id, semantic_epoch_id, already_running) = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let epoch_id = get_current_epoch(conn, project_id)?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_REBUILD_DERIVED_NO_EPOCH: project '{project_id}' has no Semantic \
                         Epoch yet; there is no Durable Graph under one for this to rebuild from"
                    )
                })?
                .id;
            let spec = json!({});
            let spec_digest = format!("sha256:{}", digest_plan(&spec));
            let handle = create_maintenance_run_in_tx(
                conn,
                project_id,
                "semantic-index-rebuild",
                &epoch_id,
                REBUILD_DERIVED_WORK_KEY,
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningOnly,
            )?;
            Ok((handle.run_id, epoch_id, handle.reused))
        })
    })?;

    if already_running {
        return Ok(RebuildDerivedStateOutcome::AlreadyRunning { run_id });
    }

    let work_result =
        rebuild_derived_state_edges_in_project(db, project_id, &run_id, &semantic_epoch_id, &now);

    if let Err(finalize_error) =
        finalize_rebuild_run(db, project_id, &run_id, &semantic_epoch_id, &work_result)
    {
        tracing::error!(
            "dependency-rebuild-derived: failed to finalize run '{run_id}' status: {finalize_error}"
        );
        return match work_result {
            Ok(_) => Err(anyhow::anyhow!(
                "NEX_REBUILD_DERIVED_FINALIZE_FAILED: {finalize_error}"
            )),
            Err(work_error) => Err(anyhow::anyhow!(
                "NEX_REBUILD_DERIVED_WORK_AND_FINALIZE_FAILED: work error: {work_error}; finalization error: {finalize_error}"
            )),
        };
    }

    match work_result {
        Ok(summary) => Ok(RebuildDerivedStateOutcome::Ran { run_id, summary }),
        Err(error) => Err(error),
    }
}

/// Every distinct Consumer this project's Durable Dependency Edges
/// declare. Read-only.
fn list_distinct_consumers(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT consumer_kind, consumer_key
           FROM narrative_dependency_edges
          WHERE project_id = ?1
          ORDER BY consumer_kind ASC, consumer_key ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RebuildShadowVerificationSummary {
    pub active_head_count: usize,
    pub declaration_count: usize,
    pub evaluated_declaration_count: usize,
    pub diagnostics: Vec<String>,
}

/// Verify every active D1 head in the project against current Sources during
/// a Rebuild. Full rebuild is deliberately project-wide (unlike the bounded
/// incremental Feed lookup), so V2-only Consumers and Sources are covered.
/// This is an in-memory observation only: Rebuild never writes a V2
/// Freshness row, changes a V1 dependency-set digest, or treats a D1 defect
/// as a V1 failure. Selectors that need a Feed position/anchor proof remain
/// Unknown here because Rebuild has no mutation-local mapping input.
fn verify_v2_shadow_for_rebuild_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<RebuildShadowVerificationSummary> {
    let mut verification = RebuildShadowVerificationSummary::default();
    let head_keys = match list_dependency_declaration_head_keys_in_tx(conn, project_id) {
        Ok(keys) => keys,
        Err(error) => {
            verification
                .diagnostics
                .push(format!("NEX_V2_SHADOW_REBUILD_HEAD_LOOKUP_UNKNOWN:{error}"));
            return Ok(verification);
        }
    };
    let registry = match load_dependency_role_registry() {
        Ok(registry) => Some(registry),
        Err(error) => {
            verification
                .diagnostics
                .push(format!("NEX_V2_SHADOW_REBUILD_REGISTRY_UNKNOWN:{error}"));
            None
        }
    };
    for (consumer_kind, consumer_key) in head_keys {
        let active_set = match read_active_dependency_declaration_set_in_tx(
            conn,
            project_id,
            &consumer_kind,
            &consumer_key,
        ) {
            Ok(ActiveDependencyDeclarationSetRead::Missing) => {
                verification.diagnostics.push(format!(
                    "NEX_V2_SHADOW_REBUILD_DECLARATION_HEAD_INCOHERENT:{consumer_kind}:{consumer_key}"
                ));
                continue;
            }
            Ok(ActiveDependencyDeclarationSetRead::Corrupt) => {
                verification.diagnostics.push(format!(
                    "NEX_V2_SHADOW_REBUILD_DECLARATION_HEAD_CORRUPT:{consumer_kind}:{consumer_key}"
                ));
                continue;
            }
            Ok(ActiveDependencyDeclarationSetRead::Active(active_set)) => active_set,
            Err(error) => {
                verification.diagnostics.push(format!(
                    "NEX_V2_SHADOW_REBUILD_DECLARATION_HEAD_UNKNOWN:{consumer_kind}:{consumer_key}:{error}"
                ));
                continue;
            }
        };
        verification.active_head_count += 1;
        verification.declaration_count += active_set.entries.len();
        let mut effects = Vec::new();
        let mut unknown_mapping = false;
        for entry in active_set.entries {
            let base_change_class = rebuild_source_change_class_from_source(
                conn,
                project_id,
                run_id,
                &entry.source_object_identity,
            );
            let selector_value: Value = match serde_json::from_str(&entry.selector_json) {
                Ok(value) => value,
                Err(error) => {
                    unknown_mapping = true;
                    verification.diagnostics.push(format!(
                        "NEX_V2_SHADOW_REBUILD_SELECTOR_UNKNOWN:{}:{}:{}:{error}",
                        consumer_kind, consumer_key, entry.id
                    ));
                    continue;
                }
            };
            let selector =
                match grimodex_core::narrative_dependency::validate_dependency_selector_value(
                    &selector_value,
                    None,
                ) {
                    Ok(selector) => selector,
                    Err(error) => {
                        unknown_mapping = true;
                        verification.diagnostics.push(format!(
                            "NEX_V2_SHADOW_REBUILD_SELECTOR_UNKNOWN:{}:{}:{}:{error}",
                            consumer_kind, consumer_key, entry.id
                        ));
                        continue;
                    }
                };
            let change_class = match selector {
                grimodex_core::narrative_dependency::DependencySelector::WholeSource => {
                    rebuild_source_change_class_for_role(entry.dependency_role, base_change_class)
                }
                _ => {
                    unknown_mapping = true;
                    verification.diagnostics.push(format!(
                        "NEX_V2_SHADOW_REBUILD_SELECTOR_UNKNOWN:{}:{}:{}:no Feed projection",
                        consumer_kind, consumer_key, entry.id
                    ));
                    continue;
                }
            };
            let Some(registry) = registry.as_ref() else {
                unknown_mapping = true;
                continue;
            };
            match evaluate_dependency_effect(
                registry,
                DependencyEffectInput {
                    role: entry.dependency_role.as_str(),
                    consumer_kind: &consumer_kind,
                    change_class: change_class.as_str(),
                },
            ) {
                Ok(effect) => effects.push(effect),
                Err(error) => {
                    unknown_mapping = true;
                    verification.diagnostics.push(format!(
                        "NEX_V2_SHADOW_REBUILD_EFFECT_UNKNOWN:{}:{}:{}:{}:{error}",
                        consumer_kind,
                        consumer_key,
                        entry.dependency_role.as_str(),
                        change_class.as_str()
                    ));
                }
            }
            verification.evaluated_declaration_count += 1;
        }
        // Exercise the same independent required/advisory aggregation used by
        // the incremental shadow path. The result is deliberately discarded
        // at this non-authoritative restore boundary.
        if !unknown_mapping {
            let _ = aggregate_dependency_build_actions(&effects);
        }
    }
    verification.diagnostics.sort();
    Ok(verification)
}

fn rebuild_source_change_class_from_source(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    source_object_identity: &str,
) -> SourceChangeClass {
    let Some(source_kind) = infer_source_kind(source_object_identity) else {
        return SourceChangeClass::ComponentUnavailable;
    };
    let resolver_run_id = match parse_snapshot_run_id_from_source_identity(source_object_identity) {
        Ok(Some(snapshot_run_id)) => match project_id_for_run(conn, snapshot_run_id) {
            Ok(Some(owner)) if owner != project_id => {
                return SourceChangeClass::ComponentUnavailable;
            }
            Ok(_) => snapshot_run_id,
            Err(_) => return SourceChangeClass::ComponentUnavailable,
        },
        Ok(None) => run_id,
        Err(_) => return SourceChangeClass::ComponentUnavailable,
    };
    match resolve_current_source_state(
        conn,
        project_id,
        resolver_run_id,
        source_kind,
        source_object_identity,
    ) {
        Ok(state) if !state.exists => SourceChangeClass::SourceMissing,
        Ok(state) if !state.usable => SourceChangeClass::ComponentUnavailable,
        Ok(_) => SourceChangeClass::SourceContentChanged,
        Err(_) => SourceChangeClass::ComponentUnavailable,
    }
}

fn rebuild_source_change_class_for_role(
    role: grimodex_core::narrative_dependency::DependencyRole,
    base: SourceChangeClass,
) -> SourceChangeClass {
    // Mirror of the incremental `shadow_change_class_for_role` contract:
    // missing/broken evidence classes are never weakened by a role.
    if matches!(
        base,
        SourceChangeClass::SourceMissing
            | SourceChangeClass::AnchorMissing
            | SourceChangeClass::SelectedSetCollapsed
            | SourceChangeClass::ComponentUnavailable
    ) {
        return base;
    }
    match role {
        grimodex_core::narrative_dependency::DependencyRole::QualityContext => {
            SourceChangeClass::QualityInputChanged
        }
        grimodex_core::narrative_dependency::DependencyRole::RankingOnly => {
            SourceChangeClass::RankingInputChanged
        }
        _ => base,
    }
}

/// Phase 2 of [`rebuild_narrative_derived_state_for_project`]: evaluate and
/// publish every Consumer's Edges, one transaction per Consumer.
fn rebuild_derived_state_edges_in_project(
    db: &Database,
    project_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
    now: &str,
) -> anyhow::Result<RebuildDerivedStateSummary> {
    let consumers = db.with_conn(|conn| list_distinct_consumers(conn, project_id))?;
    // Full Rebuild verifies the complete active D1 head set once, including
    // V2-only Consumers that have no V1 compatibility Edge. The sidecar is
    // returned in memory and skipped by the persisted Run outcome.
    let mut summary = RebuildDerivedStateSummary {
        v2_shadow: db
            .with_conn(|conn| verify_v2_shadow_for_rebuild_in_tx(conn, project_id, run_id))?,
        ..Default::default()
    };
    for (consumer_kind, consumer_key) in consumers {
        // Counted inside the per-Consumer closure, which cannot borrow
        // `summary` mutably alongside the counters it already updates.
        let mut skipped = 0usize;
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                // BEGIN IMMEDIATE serializes this validation with Epoch
                // rotation and makes the captured Run identity the authority
                // for every Consumer publish in this pass.
                ensure_rebuild_run_is_current_in_tx(conn, project_id, run_id, semantic_epoch_id)?;
                let edges =
                    find_edges_by_consumer(conn, project_id, &consumer_kind, &consumer_key)?;
                if edges.is_empty() {
                    return Ok(());
                }
                if is_reserved_semantic_index_consumer_kind(&consumer_kind) {
                    // The declared NIR-1 index is rebuilt by its own audited
                    // producer. Unknown bindings remain manual-terminal.
                    // Generic Rebuild must not publish either as usable.
                    tracing::debug!(
                        target: "narrative.rebuild",
                        consumer_kind = %consumer_kind,
                        consumer_key = %consumer_key,
                        "NEX_RESERVED_SEMANTIC_INDEX_REBUILD_SKIPPED"
                    );
                    return Ok(());
                }
                // Two separate questions, deliberately not one. Whether the
                // *kind* is one this build implements decides if the Consumer
                // is evaluable at all; which *Run* an Edge's
                // `snapshot:<runId>` Source must name is per-Edge and comes
                // from the Edge itself.
                if !is_declared_consumer_kind(&consumer_kind) {
                    tracing::warn!(
                        target: "narrative.rebuild",
                        consumer_kind = %consumer_kind,
                        consumer_key = %consumer_key,
                        "NEX_CONSUMER_KIND_UNRESOLVABLE: publishing Unknown for a Consumer \
                         whose kind is outside this build's declared vocabulary"
                    );
                    let publish_observations = edges
                        .iter()
                        .map(|edge| (edge.id.clone(), unknown_edge_observation()))
                        .collect::<Vec<_>>();
                    publish_freshness_evaluation_edges_only_in_tx(
                        conn,
                        project_id,
                        run_id,
                        &consumer_kind,
                        &consumer_key,
                        &publish_observations,
                        semantic_epoch_id,
                        now,
                    )?;
                    summary.edges_skipped_unresolvable_scope += edges.len();
                    skipped += 1;
                    return Ok(());
                }
                let mut publish_observations = Vec::with_capacity(edges.len());
                let mut evaluated_edges = 0usize;
                let mut skipped_edges = 0usize;
                for edge in &edges {
                    let owning_run_id = match resolve_edge_consumer_scope(
                        conn,
                        project_id,
                        edge,
                        &consumer_kind,
                        &consumer_key,
                    )? {
                        EdgeConsumerScope::NotRequired => "",
                        EdgeConsumerScope::Resolved(owning_run_id) => owning_run_id,
                        EdgeConsumerScope::Unresolvable => {
                            tracing::warn!(
                                target: "narrative.rebuild",
                                edge_id = %edge.id,
                                consumer_kind = %consumer_kind,
                                consumer_key = %consumer_key,
                                "NEX_CONSUMER_OWNING_RUN_UNRESOLVABLE: skipping source \
                                 evaluation and publishing Unknown for an Edge whose declaring \
                                 Run is missing, malformed, or inconsistent"
                            );
                            skipped_edges += 1;
                            publish_observations
                                .push((edge.id.clone(), unknown_edge_observation()));
                            continue;
                        }
                    };
                    let observation = evaluate_edge_from_db(conn, project_id, owning_run_id, edge)?;
                    publish_observations.push((edge.id.clone(), observation));
                    evaluated_edges += 1;
                }
                summary.edges_skipped_unresolvable_scope += skipped_edges;
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    project_id,
                    run_id,
                    &consumer_kind,
                    &consumer_key,
                    &publish_observations,
                    semantic_epoch_id,
                    now,
                )?;
                summary.edges_evaluated += evaluated_edges;
                if evaluated_edges == 0 {
                    // The explicit Unknown Edge States above invalidate any
                    // verdicts from an earlier pass in the same Epoch, but
                    // do not turn an unresolvable scope into an evaluation.
                    skipped += 1;
                } else {
                    summary.consumers_evaluated += 1;
                }
                Ok(())
            })
        })?;
        summary.consumers_skipped_unresolvable_scope += skipped;
    }
    Ok(summary)
}

/// `true` when `edge`'s Source is broken: either its `source_object_identity`
/// does not match any recognized `source_kind` prefix (see
/// `infer_source_kind`), or `resolve_current_source_state` reports it does
/// not currently exist, or resolving it errors at all (a malformed key, a
/// project-scope mismatch, an unsealed/non-current source, ...). Every one
/// of those outcomes means this diagnostic cannot certify the Edge's Source
/// is healthy, so -- matching this crate's fail-closed convention elsewhere
/// (`semantic_epoch::create_epoch_in_tx` on an unrecognized `reason`,
/// `change_feed`'s continuity check on a lineage mismatch) -- it is counted
/// as broken rather than silently skipped or allowed to abort the whole
/// report over one bad Edge.
fn edge_source_is_missing(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge: &DependencyEdge,
) -> bool {
    let Some(source_kind) = infer_source_kind(&edge.source_object_identity) else {
        return true;
    };
    match resolve_current_source_state(
        conn,
        project_id,
        run_id,
        source_kind,
        &edge.source_object_identity,
    ) {
        Ok(state) => !state.exists,
        Err(_) => true,
    }
}

/// Read-only diagnostic: for every Dependency Edge Run `run_id` declared
/// (Lane G, looked up via `find_edges_by_consumer` under the
/// [`RUN_CONSUMER_KIND`] convention), resolves the Edge's Source's current
/// state (Lane E, `source_revision::resolve_current_source_state`) and
/// counts how many no longer resolve. Writes nothing -- this function issues
/// only `SELECT`s (through `find_edges_by_consumer` and
/// `resolve_current_source_state`, neither of which mutate) and is safe to
/// call outside a transaction.
#[allow(dead_code)]
pub(crate) fn rebuild_verify_dependency_edges(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<RebuildVerifyReport> {
    require_non_empty(project_id, "projectId")?;
    require_non_empty(run_id, "runId")?;

    let edges = find_edges_by_consumer(conn, project_id, RUN_CONSUMER_KIND, run_id)?;
    let mut edge_ids_with_missing_source = Vec::new();
    for edge in &edges {
        if edge_source_is_missing(conn, project_id, run_id, edge) {
            edge_ids_with_missing_source.push(edge.id.clone());
        }
    }
    Ok(RebuildVerifyReport {
        total_edges: edges.len(),
        missing_sources: edge_ids_with_missing_source.len(),
        edge_ids_with_missing_source,
    })
}

// ---------------------------------------------------------------------
// 2b. dependency-verify (Run Kind Policy) -- project-wide diagnostics
// ---------------------------------------------------------------------

/// Read-only diagnostic report for one `dependency-verify` Run
/// (Run Kind Policy), across the whole project rather than one other
/// Run's Edges (contrast [`rebuild_verify_dependency_edges`] above, which
/// predates the Run Kind Policy and stays scoped to a single Run's own
/// declared Edges for that narrower diagnostic's own callers).
///
/// Covers the implemented durable-graph consistency checks and the
/// rebuildable-state completeness checks. The explicit `rebuild_required`
/// decision is consumed by the Rust C2-5B phase owner; it is not an Electron
/// or caller-provided phase hint.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGraphVerifyReport {
    pub total_edges: usize,
    /// Edge whose Source no longer resolves, or whose
    /// `source_object_identity` matches no recognized `source_kind`
    /// prefix at all (`infer_source_kind`).
    pub edge_ids_with_missing_source: Vec<String>,
    /// Two-or-more `narrative_dependency_edges` rows sharing the same
    /// `(project_id, consumer_kind, consumer_key, source_object_identity)`
    /// key. Defense-in-depth: `record_dependency_edge_in_tx`'s own
    /// `UNIQUE` index should make this structurally impossible through
    /// this crate's own writers; a nonzero count here means something
    /// wrote around that writer.
    pub duplicate_edge_keys: Vec<(String, String, String, String)>,
    /// An Edge whose stored declaring Run belongs to a *different* project
    /// than the Edge's own `project_id` -- the Edge's
    /// `source_object_identity` has no embedded project scope of its own, so
    /// this is the one place that boundary could silently slip.
    pub edge_ids_with_cross_project_consumer: Vec<String>,
    /// Edge with an empty `consumer_key` or a `source_object_identity`
    /// matching no recognized prefix (`infer_source_kind`) -- the latter
    /// overlaps `edge_ids_with_missing_source` by construction (an
    /// unrecognized prefix is *always* treated as a missing Source, see
    /// `edge_source_is_missing`'s doc comment), so this field exists to
    /// name the *shape* problem distinctly from the *resolution* problem,
    /// not to report a disjoint edge set.
    pub edge_ids_with_malformed_keys: Vec<String>,
    /// `narrative_dependency_edge_states` row whose `evaluated_at_epoch_id`
    /// is not the project's *current* Semantic Epoch -- a stale diagnostic
    /// snapshot left over from before the most recent Epoch rotation
    /// (restore, migration, integrity repair), which
    /// `dependency-rebuild-derived` should refresh.
    pub edge_state_ids_outside_current_epoch: Vec<String>,
    /// Durable Graph Edge whose rebuildable state has not been published for
    /// the project's current Semantic Epoch.  A missing row is different from
    /// a stale row, but both require the conditional Rebuild follow-up.
    pub edge_ids_without_current_epoch_state: Vec<String>,
    /// Historical (edge-scoped) `narrative_maintenance_finding_observations`
    /// row whose `semantic_epoch_id` is not the project's current Epoch.
    /// This is diagnostic history, not a missing current projection: the
    /// finding writer intentionally retains one row per observation across
    /// Epochs, so it is never by itself a Rebuild follow-up predicate.
    pub finding_observation_ids_outside_current_epoch: Vec<String>,
    /// Consumer declared by at least one Edge whose rolled-up Freshness row
    /// has not been published for the current Semantic Epoch.
    pub consumer_keys_without_current_epoch_freshness: Vec<(String, String)>,
    /// The concrete `dependency-repair` candidates this Verify found, for
    /// its one implemented repair category (`deactivate-duplicate-edge`):
    /// exactly what [`duplicate_edge_ids_to_deactivate`] resolved
    /// `duplicate_edge_keys` into.
    ///
    /// `duplicate_edge_keys` above only *counts* duplicate groups, which
    /// is enough to diagnose but not enough to seal a plan from -- and
    /// "the Repair plan is derived from the Verify result" is only true if
    /// the Verify result actually names the rows. `seal_repair_plan` reads
    /// its plan out of this field on a stored, completed Verify Run, and
    /// refuses to seal from a live re-derivation.
    pub duplicate_edge_ids_to_deactivate: Vec<String>,
    /// Edge whose Consumer's `consumer_kind` is outside the declared
    /// vocabulary (`consumer_identity::ConsumerKind`), or whose stored
    /// `owning_run_id`, optional Snapshot key, and Run Consumer key cannot be
    /// reconciled to one trustworthy Run id.
    ///
    /// Part of `consumer-and-source-key-format`, reported separately from
    /// `edge_ids_with_malformed_keys` because the shape is different: the
    /// key can be well formed while its kind is not implemented (a newer
    /// build wrote the row, or a Gate C2-2 Producer landed ahead of its
    /// readers), or while its non-key owner provenance is inconsistent.
    /// Kept out of
    /// `edge_ids_with_missing_source` deliberately -- an unresolvable
    /// Consumer scope says nothing about whether the Sources exist, and
    /// filing it there would report healthy Sources as gone.
    pub edge_ids_with_unresolvable_consumer_scope: Vec<String>,
    /// `(consumer_kind, consumer_key)` whose stored
    /// `narrative_consumer_freshness.dependency_set_digest` no longer
    /// matches a freshly computed digest of the Consumer's current
    /// Dependency Edges -- the Run Kind Policy's
    /// `consumer-freshness-dependency-set-digest` check.
    ///
    /// This is the "is this Consumer still reading the same things?"
    /// question, which no per-Edge Freshness value can answer: a Consumer
    /// that stopped depending on a Source entirely has no Edge left to go
    /// stale, so its rolled-up Freshness stays clean while the Freshness
    /// row describes a dependency set that no longer exists.
    ///
    /// A NULL stored digest is not stale and is reported separately as
    /// incomplete below. The distinction prevents "not inconsistent" from
    /// becoming a false claim that Verify completed this check.
    pub consumer_keys_with_stale_dependency_set_digest: Vec<(String, String)>,
    /// `(consumer_kind, consumer_key)` whose stored dependency-set digest is
    /// NULL. SCHEMA 24 made the column nullable before it had a writer, so NULL
    /// means `not-yet-evaluated`, not graph inconsistency. It is still an
    /// incomplete Verify input and must remain visible until
    /// `dependency-rebuild-derived` publishes a computed digest.
    pub consumer_keys_with_uncomputed_dependency_set_digest: Vec<(String, String)>,
    /// `narrative_maintenance_attention.finding_key` values that name no
    /// Consumer this project currently declares an Edge for.
    ///
    /// A human's snooze / dismiss / flag is durable state
    /// (`maintenance-attention-contract.json`: `epochBinding: none`,
    /// `backflowPolicy: forbid`), so Gate C2-2's Consumer re-key does not
    /// delete it -- but `finding_key` is `{consumer_kind}:{consumer_key}`,
    /// and re-keying a Consumer changes it. The disposition survives and
    /// stops matching anything.
    ///
    /// Reporting it is the honest middle: deleting would discard a human
    /// decision the roadmap explicitly protects, and re-pointing one Run's
    /// disposition at each of its Revisions would *broaden* it -- "I
    /// dismissed this Run's problem" is not "I dismissed each of these
    /// twelve Revisions' problems", and the difference is exactly a new
    /// problem going unseen. Re-homing them is Gate C2-3's Finding identity
    /// work, which the roadmap already sequences after this.
    pub orphaned_attention_finding_keys: Vec<String>,
    /// Orphaned Attention rows for which C2-3 could not prove exactly one
    /// current Consumer target (zero/multiple candidates or a target key
    /// conflict). These rows are deliberately preserved and must be surfaced
    /// to an operator rather than guessed into a new Consumer.
    pub orphaned_attention_rehome_ambiguities: Vec<String>,
    /// The typed production check for revision-owned artifact references.
    pub application_revision_artifact_references: VerifyCoverageCheck,
    /// The typed production check for the Semantic Index half of the
    /// dependency-set digest contract.
    pub semantic_index_dependency_set_digest: VerifyCoverageCheck,
    /// The typed production check for Application Contribution provenance.
    pub contribution_to_application_commit_correspondence: VerifyCoverageCheck,
    /// The typed production check for the Legacy/Generic Application mirror.
    pub legacy_mirror_migration_parity: VerifyCoverageCheck,
    /// The typed production check for cursor/feed parent-child coherence.
    pub cursor_and_feed_head_consistency: VerifyCoverageCheck,
    /// The typed production check for Semantic Index producer generation.
    pub semantic_index_generation_correspondence: VerifyCoverageCheck,
    /// Explicit Verify decision: the current derived state is missing or
    /// stale and a same-epoch Rebuild must run before confirmation Verify.
    pub rebuild_required: bool,
}

impl DependencyGraphVerifyReport {
    /// Whether every consistency check this report covers found no defect.
    /// A NULL dependency-set digest is deliberately excluded: it is
    /// incomplete evidence, not proof of inconsistency.
    pub fn is_consistent(&self) -> bool {
        self.edge_ids_with_missing_source.is_empty()
            && self.duplicate_edge_keys.is_empty()
            && self.edge_ids_with_cross_project_consumer.is_empty()
            && self.edge_ids_with_malformed_keys.is_empty()
            && self.edge_state_ids_outside_current_epoch.is_empty()
            && self.duplicate_edge_ids_to_deactivate.is_empty()
            && self.edge_ids_with_unresolvable_consumer_scope.is_empty()
            && self
                .consumer_keys_with_stale_dependency_set_digest
                .is_empty()
            && self.orphaned_attention_finding_keys.is_empty()
            && self.orphaned_attention_rehome_ambiguities.is_empty()
            && self
                .application_revision_artifact_references
                .is_consistent()
            && self.semantic_index_dependency_set_digest.is_consistent()
            && self
                .semantic_index_dependency_set_digest
                .has_reserved_footprint_observation()
            && self
                .contribution_to_application_commit_correspondence
                .is_consistent()
            && self.legacy_mirror_migration_parity.is_consistent()
            && self.cursor_and_feed_head_consistency.is_consistent()
            && self
                .semantic_index_generation_correspondence
                .is_consistent()
            && self
                .semantic_index_generation_correspondence
                .has_reserved_footprint_observation()
    }

    /// Whether every covered check had enough stored evidence to run.
    pub fn is_complete(&self) -> bool {
        self.consumer_keys_with_uncomputed_dependency_set_digest
            .is_empty()
            && self.edge_ids_without_current_epoch_state.is_empty()
            && self
                .consumer_keys_without_current_epoch_freshness
                .is_empty()
            && self.application_revision_artifact_references.is_complete()
            && self.semantic_index_dependency_set_digest.is_complete()
            && self
                .semantic_index_dependency_set_digest
                .has_reserved_footprint_observation()
            && self
                .contribution_to_application_commit_correspondence
                .is_complete()
            && self.legacy_mirror_migration_parity.is_complete()
            && self.cursor_and_feed_head_consistency.is_complete()
            && self.semantic_index_generation_correspondence.is_complete()
            && self
                .semantic_index_generation_correspondence
                .has_reserved_footprint_observation()
    }

    /// Whether all thirteen policy checks are both consistent and complete.
    pub fn is_clean(&self) -> bool {
        self.is_consistent() && self.is_complete() && !self.rebuild_required
    }

    /// Whether a completed Verify check found a concrete inconsistency. An
    /// incomplete check is intentionally not an inconsistency: its evidence
    /// is insufficient to claim either a clean graph or a manual defect.
    pub fn has_consistency_issues(&self) -> bool {
        !self.edge_ids_with_missing_source.is_empty()
            || !self.duplicate_edge_keys.is_empty()
            || !self.edge_ids_with_cross_project_consumer.is_empty()
            || !self.edge_ids_with_malformed_keys.is_empty()
            || !self.edge_state_ids_outside_current_epoch.is_empty()
            || !self.duplicate_edge_ids_to_deactivate.is_empty()
            || !self.edge_ids_with_unresolvable_consumer_scope.is_empty()
            || !self
                .consumer_keys_with_stale_dependency_set_digest
                .is_empty()
            || !self.orphaned_attention_finding_keys.is_empty()
            || !self.orphaned_attention_rehome_ambiguities.is_empty()
            || !self
                .application_revision_artifact_references
                .issues
                .is_empty()
            || !self.semantic_index_dependency_set_digest.issues.is_empty()
            || !self
                .contribution_to_application_commit_correspondence
                .issues
                .is_empty()
            || !self.legacy_mirror_migration_parity.issues.is_empty()
            || !self.cursor_and_feed_head_consistency.issues.is_empty()
            || !self
                .semantic_index_generation_correspondence
                .issues
                .is_empty()
    }

    /// Whether this report has no concrete issue and is waiting only for
    /// missing evidence. Such a report must wait for its producer/freshness
    /// anchor instead of becoming a manual graph-repair Finding.
    pub fn is_incomplete_only(&self) -> bool {
        !self.has_consistency_issues() && !self.is_complete()
    }

    /// Whether this Verify result requires the conditional Rebuild phase.
    pub fn requires_rebuild(&self) -> bool {
        self.rebuild_required
    }
}

/// Compute the canonical fingerprint of the durable graph state consumed by
/// Verify.  A report digest only proves the serialized answer; this digest
/// proves the row snapshot from which that answer was produced, including
/// the rebuildable projections and durable human attention state.
///
/// Terminal maintenance-failure Observations/lifecycle and Attention exactly
/// linked to those Observations are deliberately outside this coordinate.
/// They are durable audit/Inbox output written after Verify seals its report,
/// not graph input consumed by Verify. Including them would make a completed
/// Verify invalidate itself. Ordinary consumer Finding and Attention rows,
/// including unlinked terminal-looking rows, remain fail-closed inputs.
///
/// Every collection is ordered by its stable key before it enters the
/// canonical JSON domain.  SQLite's `rowid` and UUID creation order are
/// deliberately not part of the domain, so the same logical workspace state
/// has the same fingerprint on every process.
pub fn durable_graph_state_digest(conn: &Connection, project_id: &str) -> anyhow::Result<String> {
    require_non_empty(project_id, "projectId")?;

    let semantic_epochs = {
        let mut statement = conn.prepare(
            "SELECT id, epoch_number, reason, triggered_by_change_event_uid, created_at
               FROM narrative_semantic_epochs
              WHERE project_id = ?1
              ORDER BY epoch_number ASC, id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "epochNumber": row.get::<_, i64>(1)?,
                    "reason": row.get::<_, String>(2)?,
                    "triggeredByChangeEventUid": row.get::<_, Option<String>>(3)?,
                    "createdAt": row.get::<_, String>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let edges = {
        let mut statement = conn.prepare(
            "SELECT id, consumer_kind, consumer_key, source_object_identity,
                    read_set_json, generated_by_transaction_id, created_at, owning_run_id
               FROM narrative_dependency_edges
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "consumerKind": row.get::<_, String>(1)?,
                    "consumerKey": row.get::<_, String>(2)?,
                    "sourceObjectIdentity": row.get::<_, String>(3)?,
                    "readSetJson": row.get::<_, String>(4)?,
                    "generatedByTransactionId": row.get::<_, Option<String>>(5)?,
                    "createdAt": row.get::<_, String>(6)?,
                    "owningRunId": row.get::<_, Option<String>>(7)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let edge_resolution_inputs = {
        let mut statement = conn.prepare(
            "SELECT id, consumer_kind, consumer_key, source_object_identity,
                    owning_run_id
               FROM narrative_dependency_edges
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?;
        let edge_rows = statement
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        edge_rows
            .into_iter()
            .map(
                |(edge_id, consumer_kind, consumer_key, source_identity, owning_run_id)| {
                    durable_edge_resolution_input(
                        conn,
                        project_id,
                        &edge_id,
                        &consumer_kind,
                        &consumer_key,
                        &source_identity,
                        owning_run_id.as_deref(),
                    )
                },
            )
            .collect::<anyhow::Result<Vec<_>>>()?
    };
    let edge_states = {
        let mut statement = conn.prepare(
            "SELECT edge_id, evidence_freshness, reason_code, build_action,
                    evaluated_at_epoch_id, evaluated_at
               FROM narrative_dependency_edge_states
              WHERE project_id = ?1
              ORDER BY edge_id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "edgeId": row.get::<_, String>(0)?,
                    "evidenceFreshness": row.get::<_, String>(1)?,
                    "reasonCode": row.get::<_, Option<String>>(2)?,
                    "buildAction": row.get::<_, String>(3)?,
                    "evaluatedAtEpochId": row.get::<_, String>(4)?,
                    "evaluatedAt": row.get::<_, String>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let consumer_freshness = {
        let mut statement = conn.prepare(
            "SELECT consumer_kind, consumer_key, evidence_freshness, build_action,
                    semantic_epoch_id, last_evaluated_run_id, dependency_set_digest,
                    updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1
              ORDER BY consumer_kind ASC, consumer_key ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "consumerKind": row.get::<_, String>(0)?,
                    "consumerKey": row.get::<_, String>(1)?,
                    "evidenceFreshness": row.get::<_, String>(2)?,
                    "buildAction": row.get::<_, String>(3)?,
                    "semanticEpochId": row.get::<_, String>(4)?,
                    "lastEvaluatedRunId": row.get::<_, Option<String>>(5)?,
                    "dependencySetDigest": row.get::<_, Option<String>>(6)?,
                    "updatedAt": row.get::<_, String>(7)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let application_contributions = {
        let mut statement = conn.prepare(
            "SELECT id, application_id, commit_id, proposal_id, revision_id,
                    operation_id, target_object_identity, field_path, target_state,
                    maintenance_ownership, baseline_sequence, target_state_sequence,
                    target_state_updated_at, created_at
               FROM narrative_application_contributions
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "applicationId": row.get::<_, String>(1)?,
                    "commitId": row.get::<_, String>(2)?,
                    "proposalId": row.get::<_, String>(3)?,
                    "revisionId": row.get::<_, String>(4)?,
                    "operationId": row.get::<_, Option<String>>(5)?,
                    "targetObjectIdentity": row.get::<_, String>(6)?,
                    "fieldPath": row.get::<_, String>(7)?,
                    "targetState": row.get::<_, String>(8)?,
                    "maintenanceOwnership": row.get::<_, String>(9)?,
                    "baselineSequence": row.get::<_, Option<i64>>(10)?,
                    "targetStateSequence": row.get::<_, Option<i64>>(11)?,
                    "targetStateUpdatedAt": row.get::<_, Option<String>>(12)?,
                    "createdAt": row.get::<_, String>(13)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    // Contribution Verify follows every foreign-key-like reference before it
    // can claim correspondence.  Keep the referenced row closure in the CAS
    // fingerprint as well: otherwise deleting or re-pointing an Application,
    // Proposal, Revision, Commit, or optional Operation would leave an old
    // clean Verify reusable even though the check reads that live row.
    let contribution_provenance = {
        let mut statement = conn.prepare(
            "SELECT contribution.id, contribution.project_id,
                    contribution.application_id, contribution.commit_id,
                    contribution.proposal_id, contribution.revision_id,
                    contribution.operation_id,
                    application.commit_id, application.proposal_id,
                    application.revision_id,
                    apply_commit.project_id, apply_commit.run_id,
                    apply_commit.proposal_set_id, apply_commit.status,
                    apply_commit.plan_digest,
                    proposal.proposal_set_id,
                    proposal_set.project_id,
                    revision.proposal_id, revision.origin_kind,
                    operation.commit_id, operation.operation_index,
                    operation.status,
                    operation_commit.project_id
               FROM narrative_application_contributions contribution
               LEFT JOIN narrative_proposal_applications application
                 ON application.id = contribution.application_id
               LEFT JOIN narrative_apply_commits apply_commit
                 ON apply_commit.id = contribution.commit_id
               LEFT JOIN narrative_proposals proposal
                 ON proposal.id = contribution.proposal_id
               LEFT JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               LEFT JOIN narrative_proposal_revisions revision
                 ON revision.id = contribution.revision_id
               LEFT JOIN narrative_apply_operations operation
                 ON operation.id = contribution.operation_id
               LEFT JOIN narrative_apply_commits operation_commit
                 ON operation_commit.id = operation.commit_id
              WHERE contribution.project_id = ?1
              ORDER BY contribution.id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "contributionId": row.get::<_, String>(0)?,
                    "contributionProjectId": row.get::<_, String>(1)?,
                    "contributionApplicationId": row.get::<_, String>(2)?,
                    "contributionCommitId": row.get::<_, String>(3)?,
                    "contributionProposalId": row.get::<_, String>(4)?,
                    "contributionRevisionId": row.get::<_, String>(5)?,
                    "contributionOperationId": row.get::<_, Option<String>>(6)?,
                    "applicationCommitId": row.get::<_, Option<String>>(7)?,
                    "applicationProposalId": row.get::<_, Option<String>>(8)?,
                    "applicationRevisionId": row.get::<_, Option<String>>(9)?,
                    "commitProjectId": row.get::<_, Option<String>>(10)?,
                    "commitRunId": row.get::<_, Option<String>>(11)?,
                    "commitProposalSetId": row.get::<_, Option<String>>(12)?,
                    "commitStatus": row.get::<_, Option<String>>(13)?,
                    "commitPlanDigest": row.get::<_, Option<String>>(14)?,
                    "proposalSetId": row.get::<_, Option<String>>(15)?,
                    "proposalSetProjectId": row.get::<_, Option<String>>(16)?,
                    "revisionProposalId": row.get::<_, Option<String>>(17)?,
                    "revisionOriginKind": row.get::<_, Option<String>>(18)?,
                    "operationCommitId": row.get::<_, Option<String>>(19)?,
                    "operationIndex": row.get::<_, Option<i64>>(20)?,
                    "operationStatus": row.get::<_, Option<String>>(21)?,
                    "operationCommitProjectId": row.get::<_, Option<String>>(22)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let application_operations = {
        let mut statement = conn.prepare(
            "SELECT o.id, o.commit_id, o.operation_index, o.operation_kind,
                    o.payload_json, o.result_entity_kind, o.result_entity_id,
                    o.status, o.created_at
               FROM narrative_apply_operations o
               JOIN narrative_apply_commits c ON c.id = o.commit_id
              WHERE c.project_id = ?1
              ORDER BY o.commit_id ASC, o.operation_index ASC, o.id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "commitId": row.get::<_, String>(1)?,
                    "operationIndex": row.get::<_, i64>(2)?,
                    "operationKind": row.get::<_, String>(3)?,
                    "payloadJson": row.get::<_, String>(4)?,
                    "resultEntityKind": row.get::<_, Option<String>>(5)?,
                    "resultEntityId": row.get::<_, Option<String>>(6)?,
                    "status": row.get::<_, String>(7)?,
                    "createdAt": row.get::<_, String>(8)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    // The C2-Z durable Verify checks below also read the legacy mirror,
    // Revision/Artifact provenance, and the Change Feed/cursor tables. Keep
    // those inputs in the compare-and-swap fingerprint as well; otherwise a
    // row could change after Verify while its graphStateDigest stayed equal.
    let application_revision_artifacts = {
        let mut statement = conn.prepare(
            "SELECT a.id, a.commit_id, a.proposal_id, a.revision_id,
                    c.proposal_set_id, p.proposal_set_id, ps.project_id,
                    r.origin_kind, r.proposal_id,
                    b.ordinal, b.source_kind, b.source_key,
                    b.revision_token, b.observed_at
               FROM narrative_proposal_applications a
               LEFT JOIN narrative_apply_commits c ON c.id = a.commit_id
               LEFT JOIN narrative_proposals p ON p.id = a.proposal_id
               LEFT JOIN narrative_proposal_sets ps ON ps.id = p.proposal_set_id
               LEFT JOIN narrative_proposal_revisions r ON r.id = a.revision_id
               LEFT JOIN narrative_revision_source_basis b ON b.revision_id = a.revision_id
              WHERE c.project_id = ?1
                 OR (c.id IS NULL AND ps.project_id = ?1)
              ORDER BY a.id ASC, b.ordinal ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "applicationId": row.get::<_, String>(0)?,
                    "commitId": row.get::<_, String>(1)?,
                    "proposalId": row.get::<_, String>(2)?,
                    "revisionId": row.get::<_, String>(3)?,
                    "commitProposalSetId": row.get::<_, Option<String>>(4)?,
                    "proposalProposalSetId": row.get::<_, Option<String>>(5)?,
                    "proposalSetProjectId": row.get::<_, Option<String>>(6)?,
                    "originKind": row.get::<_, Option<String>>(7)?,
                    "revisionProposalId": row.get::<_, Option<String>>(8)?,
                    "ordinal": row.get::<_, Option<i64>>(9)?,
                    "sourceKind": row.get::<_, Option<String>>(10)?,
                    "sourceKey": row.get::<_, Option<String>>(11)?,
                    "revisionToken": row.get::<_, Option<String>>(12)?,
                    "observedAt": row.get::<_, Option<String>>(13)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let extraction_artifacts = {
        let mut statement = conn.prepare(
            "SELECT artifact.id, artifact.run_id, run.project_id, artifact.task_id,
                    artifact.attempt_id, artifact.artifact_kind,
                    artifact.payload_storage, artifact.payload_json,
                    artifact.payload_ref, artifact.payload_digest, artifact.created_at
               FROM narrative_extraction_artifacts artifact
               LEFT JOIN narrative_extraction_runs run ON run.id = artifact.run_id
              WHERE run.project_id = ?1
                 OR EXISTS (
                    SELECT 1
                      FROM narrative_revision_source_basis b
                      JOIN narrative_proposal_revisions r ON r.id = b.revision_id
                      JOIN narrative_proposal_applications a ON a.revision_id = r.id
                      JOIN narrative_apply_commits c ON c.id = a.commit_id
                     WHERE c.project_id = ?1
                       AND b.source_kind = 'narrative-artifact'
                       AND b.source_key = 'artifact:' || artifact.id
                 )
              ORDER BY artifact.id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "runId": row.get::<_, String>(1)?,
                    "runProjectId": row.get::<_, Option<String>>(2)?,
                    "taskId": row.get::<_, Option<String>>(3)?,
                    "attemptId": row.get::<_, Option<String>>(4)?,
                    "artifactKind": row.get::<_, String>(5)?,
                    "payloadStorage": row.get::<_, String>(6)?,
                    "payloadJson": row.get::<_, Option<String>>(7)?,
                    "payloadRef": row.get::<_, Option<String>>(8)?,
                    "payloadDigest": row.get::<_, Option<String>>(9)?,
                    "createdAt": row.get::<_, String>(10)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let legacy_projection_freshness = {
        let mut statement = conn.prepare(
            "SELECT f.application_id, f.status, f.reason_json, f.version, f.updated_at
               FROM narrative_projection_freshness f
               JOIN narrative_proposal_applications a ON a.id = f.application_id
               JOIN narrative_apply_commits c ON c.id = a.commit_id
              WHERE c.project_id = ?1
              ORDER BY f.application_id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "applicationId": row.get::<_, String>(0)?,
                    "status": row.get::<_, String>(1)?,
                    "reasonJson": row.get::<_, Option<String>>(2)?,
                    "version": row.get::<_, i64>(3)?,
                    "updatedAt": row.get::<_, String>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let legacy_projection_dependencies = {
        let mut statement = conn.prepare(
            "SELECT d.application_id, d.source_kind, d.source_key,
                    d.observed_revision_token, d.propagation
               FROM narrative_projection_dependencies d
               JOIN narrative_proposal_applications a ON a.id = d.application_id
               JOIN narrative_apply_commits c ON c.id = a.commit_id
              WHERE c.project_id = ?1
              ORDER BY d.application_id ASC, d.source_kind ASC, d.source_key ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "applicationId": row.get::<_, String>(0)?,
                    "sourceKind": row.get::<_, String>(1)?,
                    "sourceKey": row.get::<_, String>(2)?,
                    "observedRevisionToken": row.get::<_, String>(3)?,
                    "propagation": row.get::<_, String>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let change_transactions = {
        let mut statement = conn.prepare(
            "SELECT id, request_id, source_domain, source_change_event_uid,
                    source_change_event_sequence, cause_kind,
                    original_transaction_id, commit_id, journal_id,
                    undo_journal_id, application_ids_json, payload_digest, created_at
               FROM narrative_change_transactions
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "requestId": row.get::<_, String>(1)?,
                    "sourceDomain": row.get::<_, String>(2)?,
                    "sourceChangeEventUid": row.get::<_, String>(3)?,
                    "sourceChangeEventSequence": row.get::<_, i64>(4)?,
                    "causeKind": row.get::<_, String>(5)?,
                    "originalTransactionId": row.get::<_, Option<String>>(6)?,
                    "commitId": row.get::<_, Option<String>>(7)?,
                    "journalId": row.get::<_, Option<String>>(8)?,
                    "undoJournalId": row.get::<_, Option<String>>(9)?,
                    "applicationIdsJson": row.get::<_, String>(10)?,
                    "payloadDigest": row.get::<_, String>(11)?,
                    "createdAt": row.get::<_, String>(12)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let canonical_change_events = {
        let mut statement = conn.prepare(
            "SELECT transaction_row.id,
                    transaction_row.source_change_event_uid,
                    transaction_row.source_change_event_sequence,
                    event.event_uid, event.sequence, event.op_type
               FROM narrative_change_transactions transaction_row
               LEFT JOIN change_events event
                 ON event.project_id = transaction_row.project_id
                AND event.event_uid = transaction_row.source_change_event_uid
              WHERE transaction_row.project_id = ?1
              ORDER BY transaction_row.id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    // Keep the expected transaction-side identity alongside
                    // the optional joined event.  Verify's LEFT JOIN treats
                    // a missing referenced legacy event as a concrete
                    // malformed-input result; retaining both sides here
                    // prevents absence from hashing like a different valid
                    // event or disappearing from the CAS domain.
                    "transactionId": row.get::<_, String>(0)?,
                    "expectedEventUid": row.get::<_, String>(1)?,
                    "expectedSequence": row.get::<_, i64>(2)?,
                    "eventUid": row.get::<_, Option<String>>(3)?,
                    "sequence": row.get::<_, Option<i64>>(4)?,
                    "opType": row.get::<_, Option<String>>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let change_feed_events = {
        let mut statement = conn.prepare(
            "SELECT id, transaction_id, canonical_change_event_uid,
                    canonical_sequence, event_ordinal, object_key_json,
                    change_kind, mutation_kind, before_version, before_digest,
                    after_version, after_digest, changed_paths_json,
                    text_impact_json, structural_impact_json, occurred_at
               FROM narrative_change_events
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "transactionId": row.get::<_, String>(1)?,
                    "canonicalChangeEventUid": row.get::<_, String>(2)?,
                    "canonicalSequence": row.get::<_, i64>(3)?,
                    "eventOrdinal": row.get::<_, i64>(4)?,
                    "objectKeyJson": row.get::<_, String>(5)?,
                    "changeKind": row.get::<_, String>(6)?,
                    "mutationKind": row.get::<_, String>(7)?,
                    "beforeVersion": row.get::<_, Option<i64>>(8)?,
                    "beforeDigest": row.get::<_, Option<String>>(9)?,
                    "afterVersion": row.get::<_, Option<i64>>(10)?,
                    "afterDigest": row.get::<_, Option<String>>(11)?,
                    "changedPathsJson": row.get::<_, String>(12)?,
                    "textImpactJson": row.get::<_, Option<String>>(13)?,
                    "structuralImpactJson": row.get::<_, Option<String>>(14)?,
                    "occurredAt": row.get::<_, String>(15)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let change_cursors = {
        let mut statement = conn.prepare(
            "SELECT cursor.consumer_id, cursor.acknowledged_through_sequence,
                    cursor.lease_owner, cursor.lease_expires_at,
                    cursor.semantic_epoch_id, cursor.reserved_through_sequence,
                    cursor.active_run_id, active_run.project_id,
                    active_run.semantic_epoch_id, active_run.run_kind,
                    active_run.status
               FROM narrative_change_cursors cursor
               LEFT JOIN narrative_extraction_runs active_run
                 ON active_run.id = cursor.active_run_id
              WHERE cursor.project_id = ?1
              ORDER BY cursor.consumer_id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "consumerId": row.get::<_, String>(0)?,
                    "acknowledgedThroughSequence": row.get::<_, i64>(1)?,
                    "leaseOwner": row.get::<_, Option<String>>(2)?,
                    "leaseExpiresAt": row.get::<_, Option<String>>(3)?,
                    "semanticEpochId": row.get::<_, Option<String>>(4)?,
                    "reservedThroughSequence": row.get::<_, Option<i64>>(5)?,
                    "activeRunId": row.get::<_, Option<String>>(6)?,
                    "activeRunProjectId": row.get::<_, Option<String>>(7)?,
                    "activeRunSemanticEpochId": row.get::<_, Option<String>>(8)?,
                    "activeRunKind": row.get::<_, Option<String>>(9)?,
                    "activeRunStatus": row.get::<_, Option<String>>(10)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let semantic_index_metadata = {
        let mut statement = conn.prepare(
            "SELECT index_key, generation, built_at, source_digest,
                    dependency_set_digest, dirty_cache_flag
               FROM narrative_semantic_index_metadata
              WHERE project_id = ?1
              ORDER BY index_key ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "indexKey": row.get::<_, String>(0)?,
                    "generation": row.get::<_, i64>(1)?,
                    "builtAt": row.get::<_, String>(2)?,
                    "sourceDigest": row.get::<_, String>(3)?,
                    "dependencySetDigest": row.get::<_, String>(4)?,
                    "dirtyCacheFlag": row.get::<_, i64>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let dependency_declaration_state = {
        let mut statement = conn.prepare(
            "SELECT set_row.id, set_row.consumer_kind, set_row.consumer_key,
                    set_row.producer_id, set_row.producer_generation,
                    set_row.dependency_set_digest, set_row.state,
                    entry.source_object_identity, entry.dependency_key,
                    entry.dependency_role, entry.selector_digest
               FROM narrative_dependency_declaration_sets set_row
               LEFT JOIN narrative_dependency_declaration_entries entry
                 ON entry.declaration_set_id = set_row.id
              WHERE set_row.project_id = ?1
              ORDER BY set_row.id ASC, entry.id ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "consumerKind": row.get::<_, String>(1)?,
                    "consumerKey": row.get::<_, String>(2)?,
                    "producerId": row.get::<_, String>(3)?,
                    "producerGeneration": row.get::<_, i64>(4)?,
                    "dependencySetDigest": row.get::<_, String>(5)?,
                    "state": row.get::<_, String>(6)?,
                    "sourceObjectIdentity": row.get::<_, Option<String>>(7)?,
                    "dependencyKey": row.get::<_, Option<String>>(8)?,
                    "role": row.get::<_, Option<String>>(9)?,
                    "selectorDigest": row.get::<_, Option<String>>(10)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let dependency_declaration_heads = {
        let mut statement = conn.prepare(
            "SELECT consumer_kind, consumer_key, active_declaration_set_id,
                    producer_id, producer_generation, version, updated_at
               FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1
              ORDER BY consumer_kind ASC, consumer_key ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(json!({
                    "consumerKind": row.get::<_, String>(0)?,
                    "consumerKey": row.get::<_, String>(1)?,
                    "activeDeclarationSetId": row.get::<_, String>(2)?,
                    "producerId": row.get::<_, String>(3)?,
                    "producerGeneration": row.get::<_, i64>(4)?,
                    "version": row.get::<_, i64>(5)?,
                    "updatedAt": row.get::<_, String>(6)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let finding_observations = {
        let mut statement = conn.prepare(
            "SELECT id, run_id, semantic_epoch_id, edge_id, finding_key, reason_code,
                    evidence_freshness_snapshot, material_basis_digest, observed_at,
                    finding_identity, rule_id, rule_version, observation_digest
               FROM narrative_maintenance_finding_observations
              WHERE project_id = ?1
                AND rule_id <> ?2
              ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(
                params![project_id, MAINTENANCE_FAILURE_FINDING_RULE_ID],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "runId": row.get::<_, String>(1)?,
                        "semanticEpochId": row.get::<_, String>(2)?,
                        "edgeId": row.get::<_, Option<String>>(3)?,
                        "findingKey": row.get::<_, String>(4)?,
                        "reasonCode": row.get::<_, String>(5)?,
                        "evidenceFreshnessSnapshot": row.get::<_, String>(6)?,
                        "materialBasisDigest": row.get::<_, String>(7)?,
                        "observedAt": row.get::<_, String>(8)?,
                        "findingIdentity": row.get::<_, Option<String>>(9)?,
                        "ruleId": row.get::<_, String>(10)?,
                        "ruleVersion": row.get::<_, i64>(11)?,
                        "observationDigest": row.get::<_, String>(12)?,
                    }))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let finding_lifecycle = {
        let mut statement = conn.prepare(
            "SELECT id, finding_identity, finding_key, rule_id, rule_version,
                    lifecycle_state, observation_digest, material_basis_digest, run_id,
                    semantic_epoch_id, observed_at
               FROM narrative_maintenance_finding_lifecycle AS lifecycle
              WHERE lifecycle.project_id = ?1
                AND lifecycle.rule_id <> ?2
              ORDER BY lifecycle.id ASC",
        )?;
        let rows = statement
            .query_map(
                params![project_id, MAINTENANCE_FAILURE_FINDING_RULE_ID],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "findingIdentity": row.get::<_, String>(1)?,
                        "findingKey": row.get::<_, String>(2)?,
                        "ruleId": row.get::<_, String>(3)?,
                        "ruleVersion": row.get::<_, i64>(4)?,
                        "lifecycleState": row.get::<_, String>(5)?,
                        "observationDigest": row.get::<_, Option<String>>(6)?,
                        "materialBasisDigest": row.get::<_, Option<String>>(7)?,
                        "runId": row.get::<_, String>(8)?,
                        "semanticEpochId": row.get::<_, String>(9)?,
                        "observedAt": row.get::<_, String>(10)?,
                    }))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let attention = {
        let mut statement = conn.prepare(
            "SELECT finding_key, finding_identity, identity_resolution_status,
                    disposition, material_basis_digest, snoozed_until, set_at,
                    actor_id, request_id, payload_digest, reason, version
               FROM narrative_maintenance_attention AS attention
              WHERE attention.project_id = ?1
                AND NOT EXISTS (
                    SELECT 1
                      FROM narrative_maintenance_finding_observations AS observation
                     WHERE observation.project_id = attention.project_id
                       AND observation.finding_key = attention.finding_key
                       AND observation.finding_identity = attention.finding_identity
                       AND observation.material_basis_digest = attention.material_basis_digest
                       AND observation.rule_id = ?2
                )
              ORDER BY attention.finding_key ASC",
        )?;
        let rows = statement
            .query_map(
                params![project_id, MAINTENANCE_FAILURE_FINDING_RULE_ID],
                |row| {
                    Ok(json!({
                        "findingKey": row.get::<_, String>(0)?,
                        "findingIdentity": row.get::<_, Option<String>>(1)?,
                        "identityResolutionStatus": row.get::<_, String>(2)?,
                        "disposition": row.get::<_, String>(3)?,
                        "materialBasisDigest": row.get::<_, String>(4)?,
                        "snoozedUntil": row.get::<_, Option<String>>(5)?,
                        "setAt": row.get::<_, String>(6)?,
                        "actorId": row.get::<_, String>(7)?,
                        "requestId": row.get::<_, String>(8)?,
                        "payloadDigest": row.get::<_, String>(9)?,
                        "reason": row.get::<_, Option<String>>(10)?,
                        "version": row.get::<_, i64>(11)?,
                    }))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    let state = json!({
        "domain": "grimodex:narrative-graph-state:v1",
        "projectId": project_id,
        "semanticEpochs": semantic_epochs,
        "edges": edges,
        "edgeResolutionInputs": edge_resolution_inputs,
        "edgeStates": edge_states,
        "consumerFreshness": consumer_freshness,
        "applicationContributions": application_contributions,
        "contributionProvenance": contribution_provenance,
        "applicationOperations": application_operations,
        "applicationRevisionArtifacts": application_revision_artifacts,
        "extractionArtifacts": extraction_artifacts,
        "legacyProjectionFreshness": legacy_projection_freshness,
        "legacyProjectionDependencies": legacy_projection_dependencies,
        "changeTransactions": change_transactions,
        "canonicalChangeEvents": canonical_change_events,
        "changeFeedEvents": change_feed_events,
        "changeCursors": change_cursors,
        "semanticIndexMetadata": semantic_index_metadata,
        "dependencyDeclarationState": dependency_declaration_state,
        "dependencyDeclarationHeads": dependency_declaration_heads,
        "findingObservations": finding_observations,
        "findingLifecycle": finding_lifecycle,
        "attention": attention,
    });
    Ok(format!("sha256:{}", digest_plan(&state)))
}

pub(crate) fn validate_graph_state_digest(
    conn: &Connection,
    project_id: &str,
    expected: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        is_canonical_graph_state_digest(expected),
        "NEX_VERIFY_GRAPH_STATE_DIGEST_INVALID: graphStateDigest is not a canonical sha256 digest"
    );
    let live = durable_graph_state_digest(conn, project_id)?;
    anyhow::ensure!(
        live == expected,
        "NEX_VERIFY_GRAPH_STATE_CHANGED: graph state changed after Verify observed it; run Verify again"
    );
    Ok(())
}

pub(crate) fn is_canonical_graph_state_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// `dependency-verify` (Run Kind Policy): read-only diagnostic across the
/// Durable Dependency Graph and the Rebuildable Derived State for the
/// *whole* project -- every Consumer, not one Run's own Edges. Writes
/// nothing to any table this function reads from; the C2-5B Verify owner
/// records the report and terminal Run outcome, while this diagnostic remains
/// read-only per `forbidSideEffectRepair: true`.
///
/// The report inspects all 13 policy-named items. The six checks formerly
/// outside the production report are represented by typed
/// `VerifyCoverageCheck` fields below. Semantic Index remains `reserved`: its
/// two checks inspect the four authoritative surfaces and pass only when the
/// project has no reserved-consumer footprint. No producer, writer, schema,
/// migration, or D1 activation is inferred or added by this diagnostic.
///
/// - `verifiesDurableGraph`: an inlined version of
///   [`edge_source_is_missing`] (closest existing match to
///   "producer-and-generation-consistency" -- this crate does not yet
///   track a separate Producer "generation" concept beyond "does the
///   Source still resolve"), `active-edge-duplicates`,
///   `cross-project-edge`, `consumer-and-source-key-format` (both the key
///   *shape* and, since Gate C2-2, whether the `consumer_kind` names a
///   Consumer class this build implements at all).
/// - `verifiesRebuildableState`: `edge-state-belongs-to-current-epoch`,
///   `finding-observation-belongs-to-current-epoch`,
///   `consumer-freshness-dependency-set-digest`.
///
/// Runs a `dependency-verify` under a real Run and persists its report, so
/// a later Repair can prove which diagnostic result it was sealed from.
///
/// Before this existed, `verifyRunId` was a free string: Repair accepted any
/// non-empty value and re-derived its candidates from live Edges, so a
/// "sealed plan derived from a Verify result" was neither sealed to, nor
/// derived from, anything. The Run's `outcome_summary_json` now holds the
/// report plus its digest, and `seal_repair_plan` refuses to work from
/// anything else.
pub fn run_dependency_verify_for_project(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<VerifyRunOutcome> {
    run_dependency_verify_for_project_with_coordinates(db, project_id, None)
}

/// Run Verify while sealing skip evidence against one Native-selected
/// coordinate set. The ordinary API keeps the compiled current coordinates;
/// the main-only CI seam passes the effective set computed for the same live
/// authority and never a JavaScript-provided digest.
/// The Verify check catalogue this executor runs, matching the policy's 13
/// `REQUIRED_VERIFY_CHECKS`. The Semantic Index checks are production-owned
/// as a reserved-authority footprint scan: only all-four-zero state passes;
/// an observed row remains incomplete and manual/terminal rather than being
/// sent to Rebuild. No producer/writer binding is claimed by this catalogue.
pub const PRODUCTION_VERIFY_COVERED_CHECKS: [&str; 13] = [
    "producer-and-generation-consistency",
    "active-edge-duplicates",
    "cross-project-edge",
    "consumer-and-source-key-format",
    "application-revision-artifact-references",
    "dependency-set-digest",
    "contribution-to-application-commit-correspondence",
    "legacy-mirror-migration-parity",
    "edge-state-belongs-to-current-epoch",
    "consumer-freshness-dependency-set-digest",
    "finding-observation-belongs-to-current-epoch",
    "cursor-and-feed-head-consistency",
    "semantic-index-generation-correspondence",
];

/// Every policy check has a production diagnostic implementation. This stays
/// explicit so the persisted coverage object cannot silently drift if a
/// future check is removed from the catalogue.
pub const PRODUCTION_VERIFY_MISSING_CHECKS: [&str; 0] = [];

/// The Rust-owned Verify coverage object persisted with every production
/// Verify outcome. Semantic Index authority remains reserved, but its
/// footprint scan is a real production check; callers must not synthesize a
/// different list or use fixture-only coverage to make readiness pass.
pub fn production_verify_check_coverage() -> Value {
    let complete = PRODUCTION_VERIFY_MISSING_CHECKS.is_empty()
        && super::c2z_preparation::REQUIRED_VERIFY_CHECKS == PRODUCTION_VERIFY_COVERED_CHECKS;
    json!({
        "complete": complete,
        "required": super::c2z_preparation::REQUIRED_VERIFY_CHECKS,
        "covered": PRODUCTION_VERIFY_COVERED_CHECKS,
        "missing": PRODUCTION_VERIFY_MISSING_CHECKS,
    })
}

/// Validate the complete machine-readable coverage object against the
/// compiled Rust catalogue.  Return the compiled `complete` bit only after
/// exact equality; a caller-supplied `complete: true` or covered/missing list
/// is never authoritative.
pub(crate) fn validate_verify_check_coverage(outcome: &Value) -> anyhow::Result<bool> {
    let supplied = outcome
        .get("checkCoverage")
        .ok_or_else(|| anyhow::anyhow!("Verify outcome check coverage is missing"))?;
    let canonical = production_verify_check_coverage();
    anyhow::ensure!(
        supplied == &canonical,
        "Verify outcome check coverage does not match the compiled catalogue"
    );
    canonical
        .get("complete")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow::anyhow!("compiled Verify coverage has no complete flag"))
}

/// Compute the digest that seals the versioned Verify outcome, including the
/// canonical coverage object.  Skip evidence is appended after terminal
/// success and is intentionally excluded from this immutable outcome
/// coordinate; the digest field itself is excluded to avoid recursion.
pub fn canonical_verify_outcome_digest(outcome: &Value) -> anyhow::Result<String> {
    let mut object = outcome
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Verify outcome must be a JSON object"))?;
    object.remove("outcomeDigest");
    object.remove("skipEvidence");
    Ok(format!("sha256:{}", digest_plan(&Value::Object(object))))
}

/// Require the stored whole-outcome digest to bind report, contract version,
/// epoch, graph state, and exact coverage together.
pub(crate) fn validate_canonical_verify_outcome_digest(outcome: &Value) -> anyhow::Result<()> {
    let recorded = outcome
        .get("outcomeDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Verify outcome whole-outcome digest is missing"))?;
    anyhow::ensure!(
        recorded == canonical_verify_outcome_digest(outcome)?,
        "Verify outcome whole-outcome digest does not match the outcome"
    );
    Ok(())
}

pub fn run_dependency_verify_for_project_with_coordinates(
    db: &Database,
    project_id: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
) -> anyhow::Result<VerifyRunOutcome> {
    require_non_empty(project_id, "projectId")?;
    let effective_coordinates = match coordinates {
        Some(coordinates) => coordinates.clone(),
        None => current_maintenance_coordinates()?,
    };
    let epoch_id = db
        .with_conn(|conn| get_current_epoch(conn, project_id))?
        .map(|epoch| epoch.id)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_VERIFY_NO_EPOCH: project '{project_id}' has no Semantic Epoch")
        })?;

    let spec = json!({ "verifyContractVersion": VERIFY_CONTRACT_VERSION });
    let spec_digest = format!("sha256:{}", digest_plan(&spec));
    let created = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            create_maintenance_run_in_tx(
                conn,
                project_id,
                VERIFY_RUN_KIND,
                &epoch_id,
                &format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningOnly,
            )
        })
    })?;
    let run_id = created.run_id;
    if created.reused {
        anyhow::bail!(
            "NEX_VERIFY_ALREADY_RUNNING: dependency-verify Run '{run_id}' is already running"
        );
    }

    let verification = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let report = verify_narrative_dependency_graph_for_project(conn, project_id)?;
            let graph_state_digest = durable_graph_state_digest(conn, project_id)?;
            Ok((report, graph_state_digest))
        })
    });
    match verification {
        Ok((report, graph_state_digest)) => {
            let report_value = serde_json::to_value(&report)?;
            let report_digest = format!("sha256:{}", digest_plan(&report_value));
            let outcome = json!({
                "verifyContractVersion": VERIFY_CONTRACT_VERSION,
                "semanticEpochId": epoch_id,
                "reportDigest": report_digest,
                "graphStateDigest": graph_state_digest,
                "report": report_value,
                "checkCoverage": production_verify_check_coverage(),
            });
            let outcome_digest = canonical_verify_outcome_digest(&outcome)?;
            let mut outcome = outcome;
            outcome["outcomeDigest"] = Value::String(outcome_digest);
            db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    validate_phase_success_outcome(
                        VERIFY_RUN_KIND,
                        project_id,
                        &format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                        Some(&epoch_id),
                        &outcome,
                    )?;
                    validate_graph_state_digest(
                        conn,
                        project_id,
                        outcome
                            .get("graphStateDigest")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                anyhow::anyhow!("Verify graph state digest is missing")
                            })?,
                    )?;
                    record_run_outcome_in_tx(conn, &run_id, &outcome)?;
                    if super::maintenance_runtime::foreground_system_work_barrier_requested() {
                        // The native product-journey barrier owns the terminal
                        // transition until the ordinary authoring write has
                        // committed. Keep the real Verify outcome durable now;
                        // release seals lifecycle and skip evidence together.
                        let handle = load_maintenance_run_in_tx(conn, &run_id)?;
                        hold_maintenance_run_in_tx(conn, &handle)?;
                        return Ok(());
                    }
                    let handle = load_maintenance_run_in_tx(conn, &run_id)?;
                    let finalized_at = complete_maintenance_run_in_tx(conn, &handle)?;
                    if report.is_clean() {
                        persist_completed_run_skip_evidence_in_tx(
                            conn,
                            &run_id,
                            &CompletedRunSkipEvidence {
                                project_id: project_id.to_string(),
                                run_kind: VERIFY_RUN_KIND.to_string(),
                                work_key: format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                                semantic_epoch_id: epoch_id.clone(),
                                graph_contract_digest: effective_coordinates.graph_contract_digest,
                                rule_registry_digest: effective_coordinates.rule_registry_digest,
                                producer_generation_set_digest: effective_coordinates
                                    .producer_generation_set_digest,
                                rebuild_contract_version: REBUILD_CONTRACT_VERSION.to_string(),
                                run_kind_contract_version: VERIFY_CONTRACT_VERSION.to_string(),
                                report_digest: report_digest.clone(),
                                graph_state_digest: outcome
                                    .get("graphStateDigest")
                                    .and_then(Value::as_str)
                                    .ok_or_else(|| {
                                        anyhow::anyhow!("Verify graph state digest is missing")
                                    })?
                                    .to_string(),
                            },
                        )?;
                        // Only a clean confirmation resolves the work's
                        // terminal Findings. A completed-but-defective
                        // report must keep the semantic-graph-requires-
                        // repair Finding open, or the halt goes dark again.
                        resolve_terminal_failure_for_run_generated_in_tx(
                            conn,
                            project_id,
                            &run_id,
                            &finalized_at,
                        )?;
                    }
                    Ok(())
                })
            })?;
            Ok(VerifyRunOutcome {
                run_id,
                semantic_epoch_id: epoch_id,
                report_digest,
                graph_state_digest,
                report,
            })
        }
        Err(error) => {
            db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    record_run_outcome_in_tx(
                        conn,
                        &run_id,
                        &json!({ "failure": error.to_string() }),
                    )?;
                    let message = error.to_string();
                    let failure_kind = maintenance_failure_kind_for_message(&message);
                    let handle = load_maintenance_run_in_tx(conn, &run_id)?;
                    let finalized_at =
                        fail_maintenance_run_in_tx(conn, &handle, failure_kind, &message)?;
                    project_terminal_failure_for_run_generated_in_tx(
                        conn,
                        project_id,
                        &run_id,
                        &canonical_failure_message(failure_kind, &message),
                        &finalized_at,
                        true,
                    )?;
                    Ok(())
                })
            })?;
            Err(error)
        }
    }
}

/// Bumped whenever the shape of `DependencyGraphVerifyReport` or the set of
/// checks behind it changes in a way that makes an older stored report
/// unsafe to seal a Repair plan from.
///
/// Version 9 adds typed evidence for all six previously uncovered policy
/// checks, including the reserved Semantic Index authority-footprint counts.
/// Version 8 seals a canonical graph-state fingerprint alongside the report so
/// both clean-run reuse and non-clean manual/Repair decisions are
/// compare-and-swap decisions over the same live graph generation.
///
/// Version 7 additionally records the Rebuild contract version in completed
/// Verify skip evidence, so a current Verify cannot seal a stale Rebuild
/// outcome after the Rebuild contract changes.
///
/// `"6"` explicitly records whether the current derived state requires a
/// conditional Rebuild, including missing current-epoch Edge State and
/// Consumer Freshness rows.
///
/// `"5"` adds the exact material-digest -> Observation -> Edge mapping to
/// the orphaned Attention re-home ambiguity report. A Run owner candidate
/// alone is no longer enough to claim that a durable disposition can move.
///
/// `"4"` separates a NULL dependency-set digest from a stale non-NULL digest
/// through `consumer_keys_with_uncomputed_dependency_set_digest`, and makes
/// `is_clean()` require both consistency and complete evidence. A stored
/// version-`"3"` report omitted that field and could therefore look clean while
/// hiding Consumers that had never been evaluated.
///
/// `"3"` was Gate C2-2's original shape. The report gained
/// `edge_ids_with_unresolvable_consumer_scope`,
/// `consumer_keys_with_stale_dependency_set_digest` and
/// `orphaned_attention_finding_keys`, and `edge_ids_with_missing_source` no
/// longer absorbs Edges whose Consumer scope could not be resolved.
///
/// `"2"` existed only on the branch that built this Gate, as the state after
/// the first two fields and before the third. No build carrying it was
/// released, so no stored report can be at `"2"` -- it is skipped rather than
/// preserved. Released workspaces therefore move `"1"` -> `"3"` -> `"4"` -> `"5"` ->
/// Version 6 -> 7 -> 8.
/// `"2"` remains a branch-only value.
///
/// A stored report under an older version is refused by `repair.rs`'s
/// `NEX_REPAIR_VERIFY_CONTRACT_VERSION_MISMATCH` gate, which runs before the
/// report is deserialized at all. Older reports omit required fields (none is
/// `#[serde(default)]`) and may assert a clean bill of health over less
/// evidence. The operational consequence is that an in-flight Verify result
/// does not survive this upgrade: re-run Verify before sealing a Repair.
pub(crate) const VERIFY_CONTRACT_VERSION: &str = "9";

/// `narrative_extraction_runs.run_kind` value a Verify Run is stored
/// under. Shared with `repair.rs` so the writer and the reader that
/// validates it cannot drift apart.
pub(crate) const VERIFY_RUN_KIND: &str = "dependency-verify";

/// A completed `dependency-verify` Run and the report it produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRunOutcome {
    pub run_id: String,
    pub semantic_epoch_id: String,
    pub report_digest: String,
    pub graph_state_digest: String,
    pub report: DependencyGraphVerifyReport,
}

/// Read the Run row that supplies an Edge's scope binding.  The explicit
/// `exists` marker is intentional: deleting a previously-resolved Run must
/// change the graph CAS just as much as changing one of its revisions.
fn durable_edge_run_resolution_input(
    conn: &Connection,
    run_id: Option<&str>,
) -> anyhow::Result<Value> {
    let Some(run_id) = run_id else {
        return Ok(json!({
            "exists": false,
            "id": Value::Null,
        }));
    };
    let row: Option<DurableEdgeRunResolutionRow> = conn
        .query_row(
            "SELECT id, project_id, semantic_epoch_id, run_kind, status,
                    snapshot_digest, surface_path_id, spec_digest, coverage_json,
                    started_at, completed_at, version
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![run_id],
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
                ))
            },
        )
        .optional()?;
    Ok(match row {
        Some((
            id,
            project_id,
            semantic_epoch_id,
            run_kind,
            status,
            snapshot_digest,
            surface_path_id,
            spec_digest,
            coverage_json,
            started_at,
            completed_at,
            version,
        )) => json!({
            "exists": true,
            "id": id,
            "projectId": project_id,
            "semanticEpochId": semantic_epoch_id,
            "runKind": run_kind,
            "status": status,
            "snapshotDigest": snapshot_digest,
            "surfacePathId": surface_path_id,
            "specDigest": spec_digest,
            "coverageJson": coverage_json,
            "startedAt": started_at,
            "completedAt": completed_at,
            "version": version,
        }),
        None => json!({
            "exists": false,
            "id": run_id,
        }),
    })
}

fn durable_edge_scene_source_input(
    conn: &Connection,
    project_id: &str,
    source_identity: &str,
) -> anyhow::Result<Value> {
    let scene_id = source_identity
        .strip_prefix("project:scene:")
        .unwrap_or_default();
    let row: Option<(String, String, String, i64, String)> = if scene_id.is_empty() {
        None
    } else {
        conn.query_row(
            "SELECT id, project_id, node_type, version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
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
        .optional()?
    };
    Ok(match row {
        Some((id, owner_project_id, node_type, version, updated_at)) => json!({
            "exists": true,
            "id": id,
            "projectId": owner_project_id,
            "nodeType": node_type,
            "version": version,
            "updatedAt": updated_at,
        }),
        None => json!({
            "exists": false,
            "id": scene_id,
            "projectId": project_id,
            "nodeType": "scene",
        }),
    })
}

fn durable_edge_projection_source_input(
    conn: &Connection,
    project_id: &str,
    source_identity: &str,
) -> anyhow::Result<Value> {
    let projection_id = source_identity
        .strip_prefix("projection:")
        .unwrap_or(source_identity);
    let row: Option<(String, String, String, i64, String)> = if projection_id.is_empty() {
        None
    } else {
        conn.query_row(
            "SELECT id, project_id, status, version, updated_at
               FROM narrative_temporal_projections
              WHERE id = ?1 AND project_id = ?2",
            params![projection_id, project_id],
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
        .optional()?
    };
    Ok(match row {
        Some((id, owner_project_id, status, version, updated_at)) => json!({
            "exists": true,
            "id": id,
            "projectId": owner_project_id,
            "status": status,
            "version": version,
            "updatedAt": updated_at,
        }),
        None => json!({
            "exists": false,
            "id": projection_id,
            "projectId": project_id,
        }),
    })
}

fn durable_edge_artifact_source_input(
    conn: &Connection,
    project_id: &str,
    source_identity: &str,
) -> anyhow::Result<Value> {
    let artifact_id = source_identity
        .strip_prefix("artifact:")
        .unwrap_or_default();
    let row: Option<DurableEdgeArtifactSourceRow> = if artifact_id.is_empty() {
        None
    } else {
        conn.query_row(
            "SELECT artifact.id, artifact.run_id, run.project_id,
                    artifact.artifact_kind, artifact.payload_digest,
                    artifact.payload_json, artifact.created_at
               FROM narrative_extraction_artifacts artifact
               LEFT JOIN narrative_extraction_runs run ON run.id = artifact.run_id
              WHERE artifact.id = ?1
                AND (run.project_id = ?2 OR run.project_id IS NULL)",
            params![artifact_id, project_id],
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
        .optional()?
    };
    Ok(match row {
        Some((
            id,
            run_id,
            owner_project_id,
            artifact_kind,
            payload_digest,
            payload_json,
            created_at,
        )) => json!({
            "exists": true,
            "id": id,
            "runId": run_id,
            "projectId": owner_project_id,
            "artifactKind": artifact_kind,
            "payloadDigest": payload_digest,
            "payloadJson": payload_json,
            "createdAt": created_at,
        }),
        None => json!({
            "exists": false,
            "id": artifact_id,
            "projectId": project_id,
        }),
    })
}

fn durable_edge_capture_source_input(
    conn: &Connection,
    source_identity: &str,
) -> anyhow::Result<Value> {
    let capture_id = source_identity.strip_prefix("capture:").unwrap_or_default();
    let row: Option<DurableEdgeCaptureSourceRow> = if capture_id.is_empty() {
        None
    } else {
        conn.query_row(
            "SELECT id, state, source_kind, sealed_digest, version,
                        created_at, updated_at
                   FROM import_captures
                  WHERE id = ?1",
            params![capture_id],
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
        .optional()?
    };
    Ok(match row {
        Some((id, state, source_kind, sealed_digest, version, created_at, updated_at)) => json!({
            "exists": true,
            "id": id,
            "state": state,
            "sourceKind": source_kind,
            "sealedDigest": sealed_digest,
            "version": version,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }),
        None => json!({
            "exists": false,
            "id": capture_id,
        }),
    })
}

fn durable_edge_evidence_source_input(
    conn: &Connection,
    project_id: &str,
    source_identity: &str,
) -> anyhow::Result<Value> {
    let anchor_id = source_identity
        .strip_prefix("evidence:")
        .unwrap_or_default();
    let mut statement = conn.prepare(
        "SELECT b.id, b.session_id, b.evidence_anchor_id, b.source_document_key,
                b.target_scene_id, b.source_document_digest,
                b.committed_storage_digest, b.projection_status, b.committed_at,
                n.project_id
           FROM import_evidence_bindings b
           JOIN tree_nodes n
             ON n.id = b.target_scene_id
            AND n.project_id = ?2
          WHERE b.evidence_anchor_id = ?1
          ORDER BY b.committed_at DESC, b.id ASC",
    )?;
    let rows = if anchor_id.is_empty() {
        Vec::new()
    } else {
        statement
            .query_map(params![anchor_id, project_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "sessionId": row.get::<_, String>(1)?,
                    "evidenceAnchorId": row.get::<_, String>(2)?,
                    "sourceDocumentKey": row.get::<_, String>(3)?,
                    "targetSceneId": row.get::<_, String>(4)?,
                    "sourceDocumentDigest": row.get::<_, String>(5)?,
                    "committedStorageDigest": row.get::<_, String>(6)?,
                    "projectionStatus": row.get::<_, String>(7)?,
                    "committedAt": row.get::<_, String>(8)?,
                    "projectId": row.get::<_, String>(9)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(json!({
        "exists": !rows.is_empty(),
        "id": anchor_id,
        "rows": rows,
    }))
}

fn durable_edge_scope_authority_source_input(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Value> {
    let project_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        params![project_id],
        |row| row.get(0),
    )?;
    let mut statement = conn.prepare(
        "SELECT id, parent_id, node_type, sort_order, story_time_order,
                archived_at IS NOT NULL
           FROM tree_nodes
          WHERE project_id = ?1
          ORDER BY id ASC",
    )?;
    let nodes = statement
        .query_map(params![project_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "parentId": row.get::<_, Option<String>>(1)?,
                "nodeType": row.get::<_, String>(2)?,
                "sortOrder": row.get::<_, String>(3)?,
                "storyTimeOrder": row.get::<_, Option<String>>(4)?,
                "archived": row.get::<_, bool>(5)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({
        "projectExists": project_exists,
        "projectId": project_id,
        "nodes": nodes,
    }))
}

/// Capture the exact live scope/source inputs used while Verify resolves one
/// Edge.  The raw Edge row is not enough: its owning Run and the resolver's
/// row can be deleted or re-pointed while preserving the Edge itself.  Each
/// lookup records explicit absence, and the resolver token/error is retained
/// as a compact guard for source kinds whose revision is an aggregate (for
/// example the Codex catalog).
fn durable_edge_resolution_input(
    conn: &Connection,
    project_id: &str,
    edge_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    source_identity: &str,
    owning_run_id: Option<&str>,
) -> anyhow::Result<Value> {
    let (snapshot_run_id, snapshot_parse_error) =
        match parse_snapshot_run_id_from_source_identity(source_identity) {
            Ok(value) => (value.map(str::to_string), None),
            Err(error) => (None, Some(error.to_string())),
        };
    let source_kind = infer_source_kind(source_identity);
    let source_run_id = snapshot_run_id
        .as_deref()
        .or(owning_run_id)
        .unwrap_or_default();
    let resolved_source = match source_kind {
        Some(kind) => match resolve_current_source_state(
            conn,
            project_id,
            source_run_id,
            kind,
            source_identity,
        ) {
            Ok(state) => json!({
                "status": if state.usable { "usable" } else if state.exists { "stale" } else { "missing" },
                "exists": state.exists,
                "usable": state.usable,
                "revisionToken": state.revision_token,
                "contentDigest": state.content_digest,
                "version": state.version,
                "normalizerVersion": state.normalizer_version,
            }),
            Err(error) => json!({
                "status": "error",
                "error": error.to_string(),
            }),
        },
        None => json!({
            "status": "unsupported",
        }),
    };
    let source_row = match source_kind {
        Some("snapshot-document") => {
            durable_edge_run_resolution_input(conn, snapshot_run_id.as_deref())?
        }
        Some("scene-body") => durable_edge_scene_source_input(conn, project_id, source_identity)?,
        Some("domain-projection") => {
            durable_edge_projection_source_input(conn, project_id, source_identity)?
        }
        Some("narrative-artifact") => {
            durable_edge_artifact_source_input(conn, project_id, source_identity)?
        }
        Some("import-capture") => durable_edge_capture_source_input(conn, source_identity)?,
        Some("evidence-anchor") => {
            durable_edge_evidence_source_input(conn, project_id, source_identity)?
        }
        Some("project-scope-authority") => {
            durable_edge_scope_authority_source_input(conn, project_id)?
        }
        // Codex catalog has no single resolver row; its aggregate resolver
        // token above covers every catalog row consumed by Verify.
        Some("codex-catalog") => json!({"resolver": "aggregate"}),
        None => json!({"exists": false}),
        Some(other) => json!({"resolver": other}),
    };
    Ok(json!({
        "edgeId": edge_id,
        "consumerKind": consumer_kind,
        "consumerKey": consumer_key,
        "sourceObjectIdentity": source_identity,
        "sourceKind": source_kind,
        "owningRunId": owning_run_id,
        "owningRun": durable_edge_run_resolution_input(conn, owning_run_id)?,
        "snapshotRunId": snapshot_run_id,
        "snapshotParseError": snapshot_parse_error,
        "sourceRow": source_row,
        "resolvedSource": resolved_source,
    }))
}

pub fn verify_narrative_dependency_graph_for_project(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<DependencyGraphVerifyReport> {
    require_non_empty(project_id, "projectId")?;

    let mut report = DependencyGraphVerifyReport::default();

    let consumers = list_distinct_consumers(conn, project_id)?;
    for (consumer_kind, consumer_key) in &consumers {
        let edges = find_edges_by_consumer(conn, project_id, consumer_kind, consumer_key)?;
        report.total_edges += edges.len();

        // Consumer-kind support is resolved once per Consumer. Snapshot Run
        // scope is resolved per Edge below because SCHEMA 30 records the
        // declaring Run on each Edge independently.
        let kind_is_declared = is_declared_consumer_kind(consumer_kind)
            || (is_reserved_semantic_index_consumer_kind(consumer_kind)
                && super::nir1_chronicle_index::is_complete_registered_chronicle_index(
                    conn,
                    project_id,
                    consumer_key,
                )?)
            || (is_reserved_semantic_index_consumer_kind(consumer_kind)
                && super::nir1_entity_relation_index::is_registered(
                    conn,
                    project_id,
                    consumer_key,
                )?);
        if !kind_is_declared {
            report
                .edge_ids_with_unresolvable_consumer_scope
                .extend(edges.iter().map(|edge| edge.id.clone()));
        }

        for edge in &edges {
            if consumer_key.trim().is_empty()
                || infer_source_kind(&edge.source_object_identity).is_none()
            {
                report.edge_ids_with_malformed_keys.push(edge.id.clone());
            }
            // Only ask "is the Source missing?" when the Consumer provenance
            // is trustworthy. Otherwise a live Source can be filed as gone,
            // or a Proposal Revision whose declaring Run is absent can be
            // certified through a Run-independent Source. The Consumer is
            // reported under its own heading instead.
            if !kind_is_declared {
                continue;
            }
            let owning_run_id = match resolve_edge_consumer_scope(
                conn,
                project_id,
                edge,
                consumer_kind,
                consumer_key,
            )? {
                EdgeConsumerScope::NotRequired => "",
                EdgeConsumerScope::Resolved(owning_run_id) => owning_run_id,
                EdgeConsumerScope::Unresolvable => {
                    report
                        .edge_ids_with_unresolvable_consumer_scope
                        .push(edge.id.clone());
                    continue;
                }
            };
            if edge_source_is_missing(conn, project_id, owning_run_id, edge) {
                report.edge_ids_with_missing_source.push(edge.id.clone());
            }
        }
    }

    report.consumer_keys_with_stale_dependency_set_digest =
        consumer_keys_with_stale_dependency_set_digest(conn, project_id)?;
    report.consumer_keys_with_uncomputed_dependency_set_digest =
        consumer_keys_with_uncomputed_dependency_set_digest(conn, project_id)?;
    report.orphaned_attention_finding_keys = orphaned_attention_finding_keys(conn, project_id)?;
    report.orphaned_attention_rehome_ambiguities =
        orphaned_attention_rehome_ambiguities(conn, project_id)?;

    let current_epoch_id = get_current_epoch(conn, project_id)?.map(|epoch| epoch.id);
    if let Some(current_epoch_id) = current_epoch_id.as_deref() {
        report.edge_state_ids_outside_current_epoch =
            edge_state_ids_outside_epoch(conn, project_id, current_epoch_id)?;
        report.finding_observation_ids_outside_current_epoch =
            finding_observation_ids_outside_epoch(conn, project_id, current_epoch_id)?;
        report.edge_ids_without_current_epoch_state =
            edge_ids_without_current_epoch_state(conn, project_id, current_epoch_id)?;
        report.consumer_keys_without_current_epoch_freshness =
            consumer_keys_without_current_epoch_freshness(conn, project_id, current_epoch_id)?;
    }

    report.application_revision_artifact_references =
        verify_coverage::verify_application_revision_artifact_references(conn, project_id)?;
    let (semantic_index_digest, semantic_index_generation) =
        verify_coverage::verify_semantic_index_checks(conn, project_id)?;
    report.semantic_index_dependency_set_digest = semantic_index_digest;
    report.semantic_index_generation_correspondence = semantic_index_generation;
    report.contribution_to_application_commit_correspondence =
        verify_coverage::verify_contribution_to_application_commit_correspondence(
            conn, project_id,
        )?;
    report.legacy_mirror_migration_parity = verify_coverage::verify_legacy_mirror_migration_parity(
        conn,
        project_id,
        current_epoch_id.as_deref(),
    )?;
    report.cursor_and_feed_head_consistency =
        verify_coverage::verify_cursor_and_feed_head_consistency(
            conn,
            project_id,
            current_epoch_id.as_deref(),
        )?;

    report.duplicate_edge_keys = duplicate_edge_keys(conn, project_id)?;
    report.duplicate_edge_ids_to_deactivate = {
        let mut ids = duplicate_edge_ids_to_deactivate(conn, project_id)?;
        // Sealed into a plan digest downstream, so the order has to be a
        // property of the data, not of the query planner.
        ids.sort();
        ids
    };
    report.edge_ids_with_cross_project_consumer =
        cross_project_run_consumer_edge_ids(conn, project_id)?;
    report.rebuild_required = report_requires_derived_rebuild(conn, project_id, &report)?;

    Ok(report)
}

/// Keep the automatic phase boundary explicit.  `semantic-index-rebuild`
/// writes only current-epoch Edge State and Consumer Freshness projections;
/// it does not mutate Semantic Index metadata/D1 declarations, canonical
/// Change Feed rows/cursors, Applications, Contributions, or Legacy mirror
/// rows.  Findings from those durable checks therefore require Verify/manual
/// handling and must never cause a Verify -> Rebuild -> Verify churn loop.
pub(crate) fn report_requires_derived_rebuild(
    conn: &Connection,
    project_id: &str,
    report: &DependencyGraphVerifyReport,
) -> anyhow::Result<bool> {
    // The Rebuild writer walks current-project Dependency Edges and publishes
    // their Edge State/Freshness.  A malformed/orphaned derived row can still
    // be observed by Verify, but it is not a Rebuild target: silently routing
    // it through Rebuild would leave the same row in place and create a
    // Verify -> Rebuild -> Verify loop.  Resolve repairability against the
    // same live graph snapshot instead of assuming every derived finding is
    // writable merely because its field name sounds derived.
    for edge_id in &report.edge_state_ids_outside_current_epoch {
        let has_rebuildable_edge_state: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM narrative_dependency_edges
                 WHERE id = ?1 AND project_id = ?2
                   AND consumer_kind <> 'semantic-index'
            )",
            params![edge_id, project_id],
            |row| row.get(0),
        )?;
        if has_rebuildable_edge_state {
            return Ok(true);
        }
    }
    if !report.edge_ids_without_current_epoch_state.is_empty() {
        return Ok(true);
    }

    for (consumer_kind, consumer_key) in report
        .consumer_keys_without_current_epoch_freshness
        .iter()
        .chain(report.consumer_keys_with_stale_dependency_set_digest.iter())
        .chain(
            report
                .consumer_keys_with_uncomputed_dependency_set_digest
                .iter(),
        )
    {
        if consumer_kind == "semantic-index" {
            continue;
        }
        let has_rebuildable_consumer: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM narrative_dependency_edges
                 WHERE project_id = ?1
                   AND consumer_kind = ?2
                   AND consumer_key = ?3
            )",
            params![project_id, consumer_kind, consumer_key],
            |row| row.get(0),
        )?;
        if has_rebuildable_consumer {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Recompute the conditional Rebuild classification from the same live graph
/// that was CAS-validated by a durable outcome reader.  `rebuildRequired` is
/// sealed inside the report/outcome digests, but those digests alone cannot
/// prevent an actor from changing the bool and re-signing every serialized
/// digest.  The persisted bool therefore has to equal this canonical,
/// repairability-aware result before any read/skip/discovery/Repair path may
/// trust it.
pub(crate) fn validate_report_rebuild_required(
    conn: &Connection,
    project_id: &str,
    report: &DependencyGraphVerifyReport,
) -> anyhow::Result<()> {
    let expected = report_requires_derived_rebuild(conn, project_id, report)?;
    anyhow::ensure!(
        report.rebuild_required == expected,
        "NEX_VERIFY_REBUILD_REQUIRED_MISMATCH: stored rebuildRequired does not match live derived repairability"
    );
    Ok(())
}

/// Validate the reserved Semantic Index footprint independently of the
/// rebuildability decision.  A nonzero footprint is a terminal/manual
/// finding in C2-ZC: no current Rebuild writer owns those rows, so it must
/// not be converted into a Rebuild request merely because a persisted report
/// was replayed by a destructive Repair reader.
pub(crate) fn validate_reserved_semantic_index_footprint(
    report: &DependencyGraphVerifyReport,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        report
            .semantic_index_dependency_set_digest
            .has_reserved_footprint_observation()
            && report
                .semantic_index_generation_correspondence
                .has_reserved_footprint_observation(),
        "NEX_VERIFY_RESERVED_SEMANTIC_INDEX_FOOTPRINT_INVALID: persisted Semantic Index observedCounts are not the exact all-zero reserved footprint"
    );
    Ok(())
}

/// Rows sharing the same `(project_id, consumer_kind, consumer_key,
/// source_object_identity)` key -- see
/// [`DependencyGraphVerifyReport::duplicate_edge_keys`]'s doc comment on
/// why this should always come back empty through this crate's own
/// writers.
fn duplicate_edge_keys(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<(String, String, String, String)>> {
    let mut statement = conn.prepare(
        "SELECT consumer_kind, consumer_key, source_object_identity, COUNT(*) as c
           FROM narrative_dependency_edges
          WHERE project_id = ?1
          GROUP BY consumer_kind, consumer_key, source_object_identity
         HAVING COUNT(*) > 1
          ORDER BY consumer_kind ASC, consumer_key ASC, source_object_identity ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?.to_string(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The `dependency-repair` Run Kind's `deactivate-duplicate-edge` category,
/// made concrete: for every group of duplicate `(consumer_kind,
/// consumer_key, source_object_identity)` keys ([`duplicate_edge_keys`]
/// above only counts them), every id in that group *except* the
/// most-recently-created one. `record_dependency_edge_in_tx`'s own upsert
/// treats the newest Producer declaration as authoritative, so a Repair
/// keeping that one and removing the rest is the one unambiguous,
/// mechanically-derivable choice -- never a guess at which duplicate is
/// "correct". `narrative_dependency_edges` has no soft-delete/status
/// column, so "deactivate" here is the same hard `DELETE`
/// [`rebuild_repair_dependency_edges_in_tx`] already performs for its own
/// (pre-Run-Kind-Policy) callers.
pub(crate) fn duplicate_edge_ids_to_deactivate(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT id FROM narrative_dependency_edges e1
          WHERE project_id = ?1
            AND EXISTS (
              SELECT 1 FROM narrative_dependency_edges e2
               WHERE e2.project_id = e1.project_id
                 AND e2.consumer_kind = e1.consumer_kind
                 AND e2.consumer_key = e1.consumer_key
                 AND e2.source_object_identity = e1.source_object_identity
                 AND (e2.created_at > e1.created_at
                      OR (e2.created_at = e1.created_at AND e2.id > e1.id))
            )
          ORDER BY id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgeConsumerScope<'a> {
    /// The Source resolver does not consume Run scope. Any Consumer kind that
    /// requires stored owner provenance has already had it validated before
    /// this variant is returned.
    NotRequired,
    /// The Snapshot key, stored owner (or safe Run-Consumer fallback), and
    /// Run Consumer key all agree on this exact Run id.
    Resolved(&'a str),
    /// A Snapshot Edge lacks one trustworthy Run id. It must be diagnosed
    /// and skipped, never passed to a resolver whose scope error is folded
    /// into `source-missing`.
    Unresolvable,
}

/// Resolves the Run scope a Source resolver may safely receive for one Edge.
///
/// SCHEMA 30's stored `owning_run_id` is primary. Proposal Revision and
/// Application keys cannot recover their declaring Run, so every one of those
/// Edges requires a nonblank stored owner naming a persisted Run in the same
/// project, even when the Source resolver itself does not consume Run scope.
/// Empty/whitespace-only historical values are treated as absent only for the
/// Run-Consumer compatibility fallback to its exact `consumer_key`; a
/// non-empty malformed or mismatched stored value is never hidden by that
/// fallback. Snapshot Edges additionally require the `snapshot:<runId>`
/// suffix and an appropriate resolver scope: Run/Proposal Revision owners
/// must agree byte-for-byte, while an Application Edge keeps its fresh owner
/// and resolves the historical snapshot through the embedded same-project
/// Run.
fn resolve_edge_consumer_scope<'a>(
    conn: &Connection,
    project_id: &str,
    edge: &'a DependencyEdge,
    consumer_kind: &str,
    consumer_key: &'a str,
) -> anyhow::Result<EdgeConsumerScope<'a>> {
    // This Source is bound to sealed documents in one exact Run. Unlike a
    // Run-independent project Scope authority, its resolver must receive the
    // validated owner; passing the NotRequired sentinel would mark a healthy
    // Source missing and permanently block canonical cutover/rebuild.
    if edge
        .source_object_identity
        .starts_with(grimodex_core::narrative_scope_dependency_projection::SOURCE_PREFIX)
    {
        let Ok(identity) = grimodex_core::narrative_scope_dependency_projection::ScopeDependencyIdentity::from_source_key(
            &edge.source_object_identity,
        ) else {
            return Ok(EdgeConsumerScope::Unresolvable);
        };
        let Some(owner) = edge
            .owning_run_id
            .as_deref()
            .or_else(|| owning_run_id_for_consumer(consumer_kind, consumer_key))
        else {
            return Ok(EdgeConsumerScope::Unresolvable);
        };
        if owner.trim().is_empty()
            || owner.trim() != owner
            || identity.project_id != project_id
            || identity.run_id != owner
            || (consumer_kind == RUN_CONSUMER_KIND && consumer_key != owner)
            || project_id_for_run(conn, owner)?.as_deref() != Some(project_id)
        {
            return Ok(EdgeConsumerScope::Unresolvable);
        }
        return Ok(EdgeConsumerScope::Resolved(owner));
    }
    let snapshot_run_id =
        match parse_snapshot_run_id_from_source_identity(&edge.source_object_identity) {
            Ok(run_id) => run_id,
            Err(_) => return Ok(EdgeConsumerScope::Unresolvable),
        };

    if matches!(
        consumer_kind,
        PROPOSAL_REVISION_CONSUMER_KIND | APPLICATION_CONSUMER_KIND
    ) {
        let Some(owning_run_id) = edge.owning_run_id.as_deref() else {
            return Ok(EdgeConsumerScope::Unresolvable);
        };
        if owning_run_id.trim().is_empty()
            || owning_run_id.trim() != owning_run_id
            || project_id_for_run(conn, owning_run_id)?.as_deref() != Some(project_id)
        {
            return Ok(EdgeConsumerScope::Unresolvable);
        }
        return Ok(match snapshot_run_id {
            Some(snapshot_run_id) if consumer_kind == APPLICATION_CONSUMER_KIND => {
                if project_id_for_run(conn, snapshot_run_id)?.as_deref() != Some(project_id) {
                    EdgeConsumerScope::Unresolvable
                } else {
                    EdgeConsumerScope::Resolved(snapshot_run_id)
                }
            }
            Some(snapshot_run_id) if owning_run_id == snapshot_run_id => {
                EdgeConsumerScope::Resolved(owning_run_id)
            }
            Some(_) => EdgeConsumerScope::Unresolvable,
            None => EdgeConsumerScope::NotRequired,
        });
    }

    let Some(snapshot_run_id) = snapshot_run_id else {
        return Ok(EdgeConsumerScope::NotRequired);
    };

    let stored_owning_run_id = match edge.owning_run_id.as_deref() {
        Some(value) if value.trim().is_empty() => None,
        Some(value) if value.trim() != value => return Ok(EdgeConsumerScope::Unresolvable),
        value => value,
    };
    let Some(owning_run_id) =
        stored_owning_run_id.or_else(|| owning_run_id_for_consumer(consumer_kind, consumer_key))
    else {
        return Ok(EdgeConsumerScope::Unresolvable);
    };
    if owning_run_id != snapshot_run_id
        || (consumer_kind == RUN_CONSUMER_KIND && consumer_key != snapshot_run_id)
        || run_id_belongs_to_another_project(conn, project_id, owning_run_id)?
    {
        return Ok(EdgeConsumerScope::Unresolvable);
    }
    Ok(EdgeConsumerScope::Resolved(owning_run_id))
}

/// Attention rows whose `finding_key` names no Consumer this project still
/// declares an Edge for.
///
/// Compares by *building* `{consumer_kind}:{consumer_key}` from the Consumer
/// side rather than by splitting the stored key. A `consumer_key` may contain
/// the separator (`narrative-consumer-contract.json` permits it, and
/// `finding_key` is parsed on the first one only), so composing is exact
/// where splitting would have to re-implement that rule.
///
/// Scoped to Edges because Edges are what defines a Consumer here --
/// `list_distinct_consumers` reads the same table, and a Freshness row
/// without one is itself the stale leftover `dependency-rebuild-derived`
/// clears. Attention exactly linked to a terminal maintenance-failure
/// Observation is durable Inbox output rather than a graph Consumer, so it is
/// excluded by the same boundary as [`durable_graph_state_digest`].
fn orphaned_attention_finding_keys(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<String>> {
    let attention_exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_maintenance_attention'
         )",
        [],
        |row| row.get(0),
    )?;
    if !attention_exists {
        return Ok(Vec::new());
    }
    let observation_exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_maintenance_finding_observations'
         )",
        [],
        |row| row.get(0),
    )?;
    let query = if observation_exists {
        "SELECT a.finding_key
           FROM narrative_maintenance_attention a
          WHERE a.project_id = ?1
            AND NOT EXISTS (
                SELECT 1 FROM narrative_dependency_edges e
                 WHERE e.project_id = a.project_id
                   AND e.consumer_kind || ':' || e.consumer_key = a.finding_key
            )
            AND NOT EXISTS (
                SELECT 1
                  FROM narrative_maintenance_finding_observations o
                 WHERE o.project_id = a.project_id
                   AND o.finding_key = a.finding_key
                   AND o.finding_identity = a.finding_identity
                   AND o.material_basis_digest = a.material_basis_digest
                   AND o.rule_id = ?2
            )
          ORDER BY a.finding_key ASC"
    } else {
        "SELECT a.finding_key
           FROM narrative_maintenance_attention a
          WHERE a.project_id = ?1
            AND NOT EXISTS (
                SELECT 1 FROM narrative_dependency_edges e
                 WHERE e.project_id = a.project_id
                   AND e.consumer_kind || ':' || e.consumer_key = a.finding_key
            )
          ORDER BY a.finding_key ASC"
    };
    let mut statement = conn.prepare(query)?;
    let rows = if observation_exists {
        statement
            .query_map(
                params![project_id, MAINTENANCE_FAILURE_FINDING_RULE_ID],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

/// Read-only companion to [`orphaned_attention_finding_keys`]. It identifies
/// rows that cannot be safely re-homed by the C2-3 exact
/// material-digest -> Observation -> Edge rule. The report intentionally
/// includes zero-candidate rows as well as rows with multiple candidates and
/// target-key conflicts.
fn orphaned_attention_rehome_ambiguities(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<String>> {
    let attention_exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_maintenance_attention'
         )",
        [],
        |row| row.get(0),
    )?;
    if !attention_exists {
        return Ok(Vec::new());
    }
    let mapping_tables_available: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_dependency_edges'
        ) AND EXISTS(
            SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'narrative_maintenance_finding_observations'
        )",
        [],
        |row| row.get(0),
    )?;
    if !mapping_tables_available {
        let mut fallback = conn.prepare(
            "SELECT finding_key
               FROM narrative_maintenance_attention
              WHERE project_id = ?1
              ORDER BY finding_key ASC",
        )?;
        let mut keys = fallback
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let legacy = conn
            .prepare(
                "SELECT finding_key || ' (legacy-identity-unresolved)'
                   FROM narrative_maintenance_attention
                  WHERE project_id = ?1
                    AND identity_resolution_status = 'legacy-unresolved'
                  ORDER BY finding_key ASC",
            )?
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        keys.extend(legacy);
        keys.sort();
        keys.dedup();
        return Ok(keys);
    }
    let mut orphan_statement = conn.prepare(
        "SELECT a.finding_key, a.material_basis_digest
           FROM narrative_maintenance_attention a
          WHERE a.project_id = ?1
            AND NOT EXISTS (
                SELECT 1 FROM narrative_dependency_edges e0
                 WHERE e0.project_id = a.project_id
                   AND e0.consumer_kind || ':' || e0.consumer_key = a.finding_key
            )
            AND NOT EXISTS (
                SELECT 1
                  FROM narrative_maintenance_finding_observations terminal_observation
                 WHERE terminal_observation.project_id = a.project_id
                   AND terminal_observation.finding_key = a.finding_key
                   AND terminal_observation.finding_identity = a.finding_identity
                   AND terminal_observation.material_basis_digest = a.material_basis_digest
                   AND terminal_observation.rule_id = ?2
            )
          ORDER BY a.finding_key ASC",
    )?;
    let orphan_rows = orphan_statement
        .query_map(
            params![project_id, MAINTENANCE_FAILURE_FINDING_RULE_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut unresolved = Vec::new();
    for (finding_key, material_digest) in orphan_rows {
        // Keep this candidate query byte-for-byte equivalent in meaning to
        // `rehome_orphaned_attention_in_tx`: the report must explain the
        // exact Edge/Observation chain that the migration would use, not a
        // looser Consumer-level count.
        let mut candidate_statement = conn.prepare(
            "SELECT DISTINCT e.consumer_kind || ':' || e.consumer_key,
                    COALESCE(NULLIF(o.finding_identity, ''), ''), e.id,
                    o.reason_code, o.evidence_freshness_snapshot
               FROM narrative_dependency_edges e
               JOIN narrative_maintenance_finding_observations o
                 ON o.project_id = e.project_id
                AND o.edge_id = e.id
                AND o.material_basis_digest = ?2
                AND o.finding_key = ?3
              WHERE e.project_id = ?1
                AND e.consumer_kind || ':' || e.consumer_key <> ?3
              ORDER BY 1, 3, 4, 5",
        )?;
        let candidates: Vec<(String, String, String, String, String)> = candidate_statement
            .query_map(params![project_id, material_digest, finding_key], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut target_conflicts = Vec::new();
        for (target_key, _, _, _, _) in &candidates {
            let target_exists: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM narrative_maintenance_attention
                     WHERE project_id = ?1 AND finding_key = ?2
                )",
                params![project_id, target_key],
                |row| row.get(0),
            )?;
            if target_exists && !target_conflicts.contains(target_key) {
                target_conflicts.push(target_key.clone());
            }
        }
        if candidates.len() != 1 {
            let candidate_edges = candidates
                .iter()
                .map(|(target_key, _, edge_id, _, _)| format!("{target_key}@{edge_id}"))
                .collect::<Vec<_>>()
                .join(",");
            let target_conflicts = target_conflicts.join(",");
            unresolved.push(format!(
                "{project_id}:{finding_key} (exact-candidate-count={};candidate-edges={candidate_edges};target-conflicts={target_conflicts})",
                candidates.len()
            ));
            continue;
        }
        let (target_key, observed_identity, edge_id, _, _) = &candidates[0];
        if !target_conflicts.is_empty() {
            unresolved.push(format!(
                "{project_id}:{finding_key} (target-conflict={target_key};candidate-edge={edge_id})"
            ));
            continue;
        }
        let expected_identity = stable_finding_identity(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            edge_id,
        )?;
        if !observed_identity.is_empty() && observed_identity != &expected_identity {
            unresolved.push(format!(
                "{project_id}:{finding_key} (observation-identity-mismatch;candidate-edge={edge_id})"
            ));
        }
    }
    let status_column_exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM pragma_table_info('narrative_maintenance_attention')
             WHERE name = 'identity_resolution_status'
         )",
        [],
        |row| row.get(0),
    )?;
    if status_column_exists {
        let legacy = conn
            .prepare(
                "SELECT finding_key || ' (legacy-identity-unresolved)'
                   FROM narrative_maintenance_attention
                  WHERE project_id = ?1
                    AND identity_resolution_status = 'legacy-unresolved'
                  ORDER BY finding_key ASC",
            )?
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        unresolved.extend(legacy);
    }
    unresolved.sort();
    unresolved.dedup();
    Ok(unresolved)
}

/// Consumers whose stored `narrative_consumer_freshness.dependency_set_digest`
/// disagrees with a freshly computed digest of their current Dependency
/// Edges -- the Run Kind Policy's `consumer-freshness-dependency-set-digest`.
///
/// Read-only, and it recomputes rather than trusting any second stored
/// copy: the whole point of the check is that the stored digest may be out
/// of date, so comparing it against another stored value would prove
/// nothing.
///
/// Rows with a NULL digest are skipped here because NULL is not a stale
/// comparison. [`consumer_keys_with_uncomputed_dependency_set_digest`] reports
/// them as incomplete instead, preserving the contract distinction between a
/// graph inconsistency and evidence that has never been computed.
///
/// A Consumer that has a Freshness row but no Edges at all *is* compared:
/// `consumer_dependency_set_digest` returns the digest of the empty set for
/// it, which is a real value, and a stored digest that disagrees with it
/// means the Consumer's dependencies were dropped without its Freshness
/// being re-published -- exactly the drift this check exists to name.
fn consumer_keys_with_stale_dependency_set_digest(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT consumer_kind, consumer_key, dependency_set_digest
               FROM narrative_consumer_freshness
              WHERE project_id = ?1
                AND consumer_kind <> 'semantic-index'
                AND dependency_set_digest IS NOT NULL
              ORDER BY consumer_kind ASC, consumer_key ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stale = Vec::new();
    for (consumer_kind, consumer_key, stored_digest) in rows {
        let current_digest =
            consumer_dependency_set_digest(conn, project_id, &consumer_kind, &consumer_key)?;
        if current_digest != stored_digest {
            stale.push((consumer_kind, consumer_key));
        }
    }
    Ok(stale)
}

/// Consumers whose dependency-set digest has never been computed. Kept
/// separate from stale digests because NULL is not an inconsistency, but a
/// Verify result that hides it is incomplete and must not return `is_clean()`.
fn consumer_keys_with_uncomputed_dependency_set_digest(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT consumer_kind, consumer_key
               FROM narrative_consumer_freshness
              WHERE project_id = ?1
                AND consumer_kind <> 'semantic-index'
                AND dependency_set_digest IS NULL
              ORDER BY consumer_kind ASC, consumer_key ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Edges whose declaring Run belongs to a different project than the Edge's
/// own `project_id` -- the one place that boundary could silently slip, since
/// `source_object_identity` carries no project scope of its own.
///
/// Joins on `owning_run_id` (SCHEMA 30) rather than on `consumer_key`. The
/// old join could only inspect `RUN_CONSUMER_KIND` rows, because only for
/// those was `consumer_key` a Run id -- which meant every future Consumer
/// kind would have been added to a check that silently skipped it. Every Edge
/// now names its declaring Run directly, so the check covers all kinds and
/// keeps covering them.
///
/// An Edge with no `owning_run_id` is not reported here: it has no Run to
/// compare against, which is a different fact from having one in the wrong
/// project. `edge_ids_with_unresolvable_consumer_scope` is where that shows.
fn cross_project_run_consumer_edge_ids(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT e.id
           FROM narrative_dependency_edges e
           INNER JOIN narrative_extraction_runs r ON r.id = e.owning_run_id
          WHERE e.project_id = ?1
            AND r.project_id != e.project_id
          ORDER BY e.id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn edge_state_ids_outside_epoch(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT state.edge_id
               FROM narrative_dependency_edge_states state
              WHERE state.project_id = ?1
                AND state.evaluated_at_epoch_id != ?2
                AND NOT EXISTS (
                    SELECT 1 FROM narrative_dependency_edges edge
                     WHERE edge.project_id = state.project_id
                       AND edge.id = state.edge_id
                       AND edge.consumer_kind = 'semantic-index'
                )
              ORDER BY state.edge_id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, current_epoch_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Edge States that have not been published for the current Semantic Epoch.
/// The LEFT JOIN is intentional: a missing derived row is the primary signal
/// that Verify must request a Rebuild rather than certify an empty result.
fn edge_ids_without_current_epoch_state(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT e.id
               FROM narrative_dependency_edges e
               LEFT JOIN narrative_dependency_edge_states s
                 ON s.edge_id = e.id AND s.evaluated_at_epoch_id = ?2
              WHERE e.project_id = ?1
                AND e.consumer_kind <> 'semantic-index'
                AND s.edge_id IS NULL
              ORDER BY e.id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, current_epoch_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Consumers declared by current Durable Edges that have no current-epoch
/// rolled-up Freshness row. This complements the Edge-level LEFT JOIN and
/// makes the Rebuild decision explicit for zero-state Consumers.
fn consumer_keys_without_current_epoch_freshness(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT e.consumer_kind, e.consumer_key
               FROM narrative_dependency_edges e
               LEFT JOIN narrative_consumer_freshness f
             ON f.project_id = e.project_id
            AND f.consumer_kind = e.consumer_kind
            AND f.consumer_key = e.consumer_key
            AND f.semantic_epoch_id = ?2
              WHERE e.project_id = ?1
                AND e.consumer_kind <> 'semantic-index'
                AND f.project_id IS NULL
              ORDER BY e.consumer_kind ASC, e.consumer_key ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, current_epoch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn finding_observation_ids_outside_epoch(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
) -> anyhow::Result<Vec<String>> {
    // Durable terminal-failure history is audit history, not rebuildable
    // edge state; it must stay exempt across rule version bumps, or every
    // Verify after an upgrade would dirty on pre-upgrade rows. Exempt by
    // rule id, not by the exact current version.
    let mut statement = conn.prepare(
        "SELECT id
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND semantic_epoch_id != ?2
            AND rule_id != ?3
          ORDER BY id ASC",
    )?;
    let rows = statement
        .query_map(
            params![
                project_id,
                current_epoch_id,
                MAINTENANCE_FAILURE_FINDING_RULE_ID,
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------
// 3. Rebuild repair
// ---------------------------------------------------------------------

/// Deletes exactly the Dependency Edges named in `edge_ids` (typically the
/// `edge_ids_with_missing_source` a prior `rebuild_verify_dependency_edges`
/// call reported), scoped to `project_id`. Lane G's
/// `delete_edges_for_consumer_in_tx` clears an entire Consumer's Edge set at
/// once and has no per-Edge-id variant, which does not fit a repair step
/// that wants to remove only the specific broken Edges a diagnostic named
/// (a Consumer may also have other, healthy Edges this repair must leave
/// alone) -- so this issues a direct `DELETE ... WHERE project_id = ?1 AND
/// id IN (...)` instead of reusing that function. The `project_id` predicate
/// is what keeps this repair from ever touching another project's Edge even
/// if (implausibly, since ids are UUIDs) an id were to collide.
///
/// Ambient-transaction helper, matching `dependency_edges.rs`'s and
/// `semantic_epoch.rs`'s own `_in_tx` functions in this crate: no
/// `BEGIN`/`COMMIT` of its own, the caller owns the surrounding transaction.
///
/// `edge_ids` empty is a no-op that returns `Ok(0)` without issuing SQL.
/// Returns the number of rows actually deleted.
pub(crate) fn rebuild_repair_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    edge_ids: &[String],
) -> anyhow::Result<usize> {
    require_non_empty(project_id, "projectId")?;
    if edge_ids.is_empty() {
        return Ok(0);
    }

    // `?1` is `project_id`; the edge id placeholders start at `?2`, matching
    // the numbered-placeholder convention this crate's other dynamic-length
    // `IN (...)` builders use (see `project_snapshots.rs`'s insert-column
    // placeholder builder).
    let placeholders = (0..edge_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM narrative_dependency_edges WHERE project_id = ?1 AND id IN ({placeholders})"
    );
    let mut bound_params = Vec::with_capacity(edge_ids.len() + 1);
    bound_params.push(project_id.to_string());
    bound_params.extend(edge_ids.iter().cloned());

    let affects_current: bool = conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges e JOIN narrative_proposals p ON p.current_revision_id=e.consumer_key
            WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' AND e.id IN ({placeholders}))"),
        params_from_iter(bound_params.iter()), |row| row.get(0),
    )?;
    if affects_current {
        super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, project_id)?;
    }
    let deleted = conn.execute(&sql, params_from_iter(bound_params.iter()))?;
    Ok(deleted)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::narrative_extraction::evaluator::{
        BuildAction, EvidenceFreshness, FindingReasonCode,
    };
    use crate::narrative_extraction::{
        get_current_epoch, list_epochs, record_dependency_edge_in_tx, APPLICATION_CONSUMER_KIND,
        PROPOSAL_REVISION_CONSUMER_KIND,
    };
    use crate::Database;
    use rusqlite::params;
    use std::collections::BTreeMap;
    use std::path::Path;

    type StoredEdgeState = (String, Option<String>, String, String);
    type StoredConsumerState = (String, String, String, Option<String>);

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_database(db)
    }

    fn current_schema_db() -> Database {
        seed_database(crate::test_support::current_schema_memory().expect("current-schema fixture"))
    }

    fn seed_database(db: Database) -> Database {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Project Two')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                 VALUES ('scene-live', 'project-1', 'scene', 'Scene', '{\"type\":\"doc\",\"content\":[]}')",
                [],
            )?;
            Ok(())
        })
        .expect("seed projects and a live scene");
        db
    }

    // -- rotate_epoch_for_restore_in_tx -----------------------------------

    #[test]
    fn project_restored_mints_an_epoch_with_reason_restore() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(
                    conn,
                    "project-1",
                    "project-restored",
                    Some("change-event-1"),
                )
            })
            .expect("rotate on project-restored")
            .expect("project-restored must mint an epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, epoch_id);
        assert_eq!(current.epoch_number, 0);
        assert_eq!(current.reason, "restore");
    }

    #[test]
    fn semantic_epoch_reset_mints_an_epoch_with_reason_migration() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "semantic-epoch-reset", None)
            })
            .expect("rotate on semantic-epoch-reset")
            .expect("semantic-epoch-reset must mint an epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, epoch_id);
        assert_eq!(current.reason, "migration");
    }

    #[test]
    fn unrecognized_structural_impact_event_rotates_nothing() {
        let db = test_db();
        let result = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "schema-component-changed", None)
            })
            .expect("call must not error");
        assert_eq!(result, None);

        let all = db
            .with_conn(|conn| list_epochs(conn, "project-1"))
            .expect("list epochs");
        assert!(
            all.is_empty(),
            "an unrecognized structuralImpact.event must not mint an epoch"
        );
    }

    #[test]
    fn two_restores_advance_the_epoch_number_and_keep_it_current() {
        let db = test_db();
        db.with_conn(|conn| {
            rotate_epoch_for_restore_in_tx(conn, "project-1", "project-restored", None)
        })
        .expect("first restore")
        .expect("first restore must mint an epoch");
        let second_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "semantic-epoch-reset", None)
            })
            .expect("second restore")
            .expect("second restore must mint an epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, second_id);
        assert_eq!(current.epoch_number, 1);
        assert_eq!(current.reason, "migration");

        let all = db
            .with_conn(|conn| list_epochs(conn, "project-1"))
            .expect("list epochs");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn restore_epoch_id_is_stable_project_scoped_and_domain_separated() {
        let restore_identity = "restore-image-sha256:deadbeef";
        let same = deterministic_restore_epoch_id("project-1", restore_identity);
        assert_eq!(
            same,
            deterministic_restore_epoch_id("project-1", restore_identity)
        );
        let parsed = uuid::Uuid::parse_str(&same).expect("restore epoch id is canonical UUID");
        assert_eq!(
            same.len(),
            36,
            "restore epoch UUID uses canonical string form"
        );
        assert_eq!(
            parsed.as_bytes()[6] >> 4,
            5,
            "restore epoch UUID is version 5"
        );
        assert_eq!(
            parsed.as_bytes()[8] & 0xc0,
            0x80,
            "restore epoch UUID uses the RFC 4122 variant"
        );
        assert_ne!(
            same,
            deterministic_restore_epoch_id("project-1", "restore-image-sha256:cafebabe")
        );
        assert_ne!(
            same,
            deterministic_restore_epoch_id("project-2", restore_identity)
        );
        assert_ne!(
            same,
            deterministic_restore_epoch_id("project-1", "semantic-epoch-reset:deadbeef")
        );
        assert_ne!(
            deterministic_restore_epoch_id("ab", "c"),
            deterministic_restore_epoch_id("a", "bc"),
            "project and restore identity boundaries must be length-delimited"
        );
    }

    #[test]
    fn installed_restore_identity_mints_each_project_epoch_exactly_once() {
        let db = test_db();
        let project_ids = db
            .with_conn(|conn| {
                let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(ids)
            })
            .expect("list seeded projects");
        let first =
            ensure_restore_epochs_for_workspace(&db, "restore-image-sha256:restore-image-1")
                .expect("mint restore epochs");
        assert_eq!(first.len(), project_ids.len());
        let retry =
            ensure_restore_epochs_for_workspace(&db, "restore-image-sha256:restore-image-1")
                .expect("retry restore epoch mint");
        assert_eq!(retry, first);
        for project_id in project_ids {
            let epochs = db
                .with_conn(|conn| list_epochs(conn, &project_id))
                .expect("list restore epochs");
            assert_eq!(epochs.len(), 1);
            assert_eq!(epochs[0].reason, "restore");
        }
        let second =
            ensure_restore_epochs_for_workspace(&db, "restore-image-sha256:restore-image-2")
                .expect("a distinct restored image gets a new epoch");
        assert_ne!(second, first);
    }

    #[test]
    fn system_run_timestamps_are_cross_kind_monotonic_and_project_scoped() {
        let same_project = test_db();
        let same_project_created = same_project
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES ('epoch-timestamp-1', 'project-1', 0, 'initial',
                             '2026-08-23T00:00:00.000Z')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at,
                         run_kind, semantic_epoch_id, work_key)
                     VALUES ('future-verify', 'project-1', 'maintenance', '{}', '{}', 'digest',
                             'completed', '{}', '2099-01-01T00:00:00.000Z',
                             '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
                             'dependency-verify', 'epoch-timestamp-1', 'future-verify')",
                    [],
                )?;
                let created = create_system_run_in_tx(
                    conn,
                    "project-1",
                    "semantic-index-rebuild",
                    "epoch-timestamp-1",
                    "dependency-rebuild-derived",
                    &json!({}),
                    "sha256:test",
                    SystemRunWorkKeyReuse::None,
                    None,
                )?;
                let run_id = created["runId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("created Run has no id"))?;
                conn.query_row(
                    "SELECT created_at FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
            })
            .expect("same-project cross-kind Run timestamp");
        assert_eq!(
            same_project_created, "2099-01-01T00:00:00.001Z",
            "a cross-kind follow-up must not share the predecessor instant"
        );
        same_project
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at,
                         run_kind, semantic_epoch_id, work_key)
                     VALUES ('future-max', 'project-1', 'maintenance', '{}', '{}', 'digest',
                             'completed', '{}', '9999-12-31T23:59:59.999Z',
                             '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z',
                             'dependency-verify', 'epoch-timestamp-1', 'future-max')",
                    [],
                )?;
                let error = create_system_run_in_tx(
                    conn,
                    "project-1",
                    "semantic-index-rebuild",
                    "epoch-timestamp-1",
                    "dependency-rebuild-overflow",
                    &json!({}),
                    "sha256:test",
                    SystemRunWorkKeyReuse::None,
                    None,
                )
                .expect_err("max imported instant must fail closed");
                assert!(error
                    .to_string()
                    .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_OVERFLOW"));
                Ok(())
            })
            .expect("validate max lifecycle overflow");

        let separate_project = test_db();
        let current_project_created = separate_project
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-future', 'Future')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at,
                         run_kind, semantic_epoch_id, work_key)
                     VALUES ('future-other-project', 'project-future', 'maintenance', '{}', '{}', 'digest',
                             'completed', '{}', '2099-01-01T00:00:00.000Z',
                             '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
                             'dependency-verify', NULL, 'future-verify')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES ('epoch-timestamp-current', 'project-1', 0, 'initial',
                             '2026-08-23T00:00:00.000Z')",
                    [],
                )?;
                let created = create_system_run_in_tx(
                    conn,
                    "project-1",
                    "dependency-verify",
                    "epoch-timestamp-current",
                    "dependency-verify:epoch-timestamp-current",
                    &json!({}),
                    "sha256:test",
                    SystemRunWorkKeyReuse::None,
                    None,
                )?;
                let run_id = created["runId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("created Run has no id"))?;
                conn.query_row(
                    "SELECT created_at FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
            })
            .expect("other-project future Run must not poison timestamp");
        assert!(current_project_created.as_str() < "2099-01-01T00:00:00.000Z");
    }

    // -- rebuild_verify_dependency_edges -----------------------------------

    fn seed_run_edge(
        db: &Database,
        project_id: &str,
        run_id: &str,
        source_object_identity: &str,
    ) -> String {
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                project_id,
                RUN_CONSUMER_KIND,
                run_id,
                source_object_identity,
                r#"["/body"]"#,
                None,
                Some(run_id),
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record run-scoped edge")
    }

    fn seed_application_fixture(
        db: &Database,
        application_id: &str,
        commit_id: &str,
        proposal_id: &str,
        revision_id: &str,
    ) {
        seed_application_fixture_with_origin(
            db,
            application_id,
            commit_id,
            proposal_id,
            revision_id,
            "enveloped",
        );
    }

    fn seed_application_fixture_with_origin(
        db: &Database,
        application_id: &str,
        commit_id: &str,
        proposal_id: &str,
        revision_id: &str,
        origin_kind: &str,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, created_at, updated_at)
                 VALUES (?1, 'run-1', 'project-1', 'extraction',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
                params![format!("set-{proposal_id}")],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, payload_json,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?1, 'codex-entry', '{}',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
                params![proposal_id, format!("set-{proposal_id}")],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     created_at, created_by)
                 VALUES (?1, ?2, 1, '{}', ?3,
                         '2026-08-15T00:00:00.000Z', 'test')",
                params![revision_id, proposal_id, origin_kind],
            )?;
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, request_id, plan_digest, status, created_at)
                 VALUES (?1, 'project-1', ?1, 'sha256:test', 'completed',
                         '2026-08-15T00:00:00.000Z')",
                params![commit_id],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'codex-entry', 'entity-1',
                         '2026-08-15T00:00:00.000Z')",
                params![application_id, commit_id, proposal_id, revision_id],
            )?;
            Ok(())
        })
        .expect("seed Application/Proposal/Revision fixture");
    }

    fn seed_sealed_snapshot_run(db: &Database, project_id: &str, run_id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, snapshot_digest, created_at, version)
                 VALUES (?1, ?2, 'x', '{}', '{}', 'd',
                         'completed', '{}', 'sha256:snap',
                         '2026-08-15T00:00:00.000Z', 0)",
                params![run_id, project_id],
            )?;
            Ok(())
        })
        .expect("seed a real sealed snapshot Run");
    }

    fn seed_raw_snapshot_edge(
        db: &Database,
        edge_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
        source_run_id: &str,
        owning_run_id: Option<&str>,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at, owning_run_id)
                 VALUES (?1, 'project-1', ?2, ?3, ?4, '[\"sha256:snap\"]',
                         '2026-08-15T00:00:00.000Z', ?5)",
                params![
                    edge_id,
                    consumer_kind,
                    consumer_key,
                    format!("snapshot:{source_run_id}"),
                    owning_run_id,
                ],
            )?;
            Ok(())
        })
        .expect("seed a raw snapshot Edge fixture");
    }

    fn seed_raw_edge(
        db: &Database,
        edge_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
        source_object_identity: &str,
        owning_run_id: Option<&str>,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at, owning_run_id)
                 VALUES (?1, 'project-1', ?2, ?3, ?4, '[\"/body\"]',
                         '2026-08-15T00:00:00.000Z', ?5)",
                params![
                    edge_id,
                    consumer_kind,
                    consumer_key,
                    source_object_identity,
                    owning_run_id,
                ],
            )?;
            Ok(())
        })
        .expect("seed a raw Dependency Edge fixture");
    }

    #[test]
    fn verify_reports_no_missing_sources_when_every_edge_resolves() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-1"))
            .expect("verify run edges");
        assert_eq!(
            report,
            RebuildVerifyReport {
                total_edges: 1,
                missing_sources: 0,
                edge_ids_with_missing_source: Vec::new(),
            }
        );
    }

    #[test]
    fn verify_detects_a_deleted_scene_source_as_missing() {
        let db = current_schema_db();
        let healthy_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let missing_id = seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-1"))
            .expect("verify run edges");
        assert_eq!(report.total_edges, 2);
        assert_eq!(report.missing_sources, 1);
        assert_eq!(report.edge_ids_with_missing_source, vec![missing_id]);
        assert!(!report.edge_ids_with_missing_source.contains(&healthy_id));
    }

    #[test]
    fn verify_treats_an_unrecognized_source_identity_shape_as_missing() {
        let db = current_schema_db();
        let unrecognized_id = seed_run_edge(&db, "project-1", "run-1", "totally:unknown:identity");

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-1"))
            .expect("verify run edges");
        assert_eq!(report.total_edges, 1);
        assert_eq!(report.missing_sources, 1);
        assert_eq!(report.edge_ids_with_missing_source, vec![unrecognized_id]);
    }

    #[test]
    fn verify_is_scoped_to_the_named_run_and_project() {
        let db = current_schema_db();
        seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );
        // A different run in the same project must not be counted.
        seed_run_edge(
            &db,
            "project-1",
            "run-2",
            "project:scene:scene-does-not-exist",
        );

        let report = db
            .with_conn(|conn| rebuild_verify_dependency_edges(conn, "project-1", "run-2"))
            .expect("verify run-2 edges only");
        assert_eq!(report.total_edges, 1);
    }

    // -- rebuild_repair_dependency_edges_in_tx ------------------------------

    #[test]
    fn repair_deletes_only_the_named_edges() {
        let db = current_schema_db();
        let keep_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let broken_id = seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );

        let deleted = db
            .with_conn(|conn| {
                rebuild_repair_dependency_edges_in_tx(
                    conn,
                    "project-1",
                    std::slice::from_ref(&broken_id),
                )
            })
            .expect("repair broken edge");
        assert_eq!(deleted, 1);

        let remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("list remaining edges");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, keep_id);
    }

    #[test]
    fn repair_does_not_touch_another_projects_edges() {
        let db = current_schema_db();
        let project_1_edge = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let project_2_edge = seed_run_edge(&db, "project-2", "run-1", "project:scene:scene-live");

        // Ask to delete project-1's edge id, but scope the repair to
        // project-2: the id exists, but not under that project, so nothing
        // is deleted.
        let deleted = db
            .with_conn(|conn| {
                rebuild_repair_dependency_edges_in_tx(
                    conn,
                    "project-2",
                    std::slice::from_ref(&project_1_edge),
                )
            })
            .expect("repair scoped to project-2");
        assert_eq!(deleted, 0);

        let project_1_remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("list project-1 edges");
        assert_eq!(project_1_remaining.len(), 1);
        assert_eq!(project_1_remaining[0].id, project_1_edge);

        let project_2_remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-2", RUN_CONSUMER_KIND, "run-1"))
            .expect("list project-2 edges");
        assert_eq!(project_2_remaining.len(), 1);
        assert_eq!(project_2_remaining[0].id, project_2_edge);
    }

    #[test]
    fn repair_with_empty_edge_ids_is_a_no_op() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let deleted = db
            .with_conn(|conn| rebuild_repair_dependency_edges_in_tx(conn, "project-1", &[]))
            .expect("no-op repair");
        assert_eq!(deleted, 0);

        let remaining = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("list edges");
        assert_eq!(remaining.len(), 1);
    }

    // -- evaluate_edge_from_db / build_edge_comparison_input ---------------

    fn current_scene_revision_token(db: &Database, scene_id: &str) -> String {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT version, updated_at FROM tree_nodes WHERE id = ?1",
                params![scene_id],
                |row| {
                    let version: i64 = row.get(0)?;
                    let updated_at: String = row.get(1)?;
                    Ok(format!("v{version}@{updated_at}"))
                },
            )
            .map_err(Into::into)
        })
        .expect("read current scene revision token")
    }

    #[test]
    fn evaluate_edge_from_db_reports_fresh_when_stored_token_matches_current() {
        let db = current_schema_db();
        let current_token = current_scene_revision_token(&db, "scene-live");
        let edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    "project:scene:scene-live",
                    &format!(r#"["{current_token}"]"#),
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record edge with current token");

        let edges = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("load edge");
        let edge = edges.into_iter().find(|e| e.id == edge_id).expect("edge");

        let observation = db
            .with_conn(|conn| evaluate_edge_from_db(conn, "project-1", "run-1", &edge))
            .expect("evaluate edge");
        assert_eq!(observation.freshness, EvidenceFreshness::Fresh);
        assert_eq!(observation.reason_code, None);
        assert_eq!(observation.build_action, BuildAction::None);
    }

    #[test]
    fn evaluate_edge_from_db_reports_stale_when_stored_token_is_outdated() {
        let db = current_schema_db();
        let edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    "project:scene:scene-live",
                    r#"["v-100@1999-01-01T00:00:00.000Z"]"#,
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record edge with a stale token");

        let edges = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("load edge");
        let edge = edges.into_iter().find(|e| e.id == edge_id).expect("edge");

        let observation = db
            .with_conn(|conn| evaluate_edge_from_db(conn, "project-1", "run-1", &edge))
            .expect("evaluate edge");
        assert_eq!(observation.freshness, EvidenceFreshness::Stale);
        assert_eq!(
            observation.reason_code,
            Some(FindingReasonCode::SourceRevisionChanged)
        );
        assert_eq!(observation.build_action, BuildAction::RebuildRequired);
    }

    #[test]
    fn evaluate_edge_from_db_reports_source_missing_for_a_deleted_scene() {
        let db = current_schema_db();
        let edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    "project:scene:scene-does-not-exist",
                    r#"["v0@2026-01-01T00:00:00.000Z"]"#,
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record edge pointing at a nonexistent scene");

        let edges = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("load edge");
        let edge = edges.into_iter().find(|e| e.id == edge_id).expect("edge");

        let observation = db
            .with_conn(|conn| evaluate_edge_from_db(conn, "project-1", "run-1", &edge))
            .expect("evaluate edge");
        assert_eq!(observation.freshness, EvidenceFreshness::SourceMissing);
        assert_eq!(
            observation.reason_code,
            Some(FindingReasonCode::SourceMissing)
        );
        assert_eq!(observation.build_action, BuildAction::Manual);
    }

    #[test]
    fn evaluate_edge_from_db_treats_an_unrecognized_source_identity_as_missing() {
        let db = current_schema_db();
        let edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    "totally:unknown:identity",
                    r#"["v0@2026-01-01T00:00:00.000Z"]"#,
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record edge with an unrecognized source identity");

        let edges = db
            .with_conn(|conn| find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1"))
            .expect("load edge");
        let edge = edges.into_iter().find(|e| e.id == edge_id).expect("edge");

        let observation = db
            .with_conn(|conn| evaluate_edge_from_db(conn, "project-1", "run-1", &edge))
            .expect("evaluate edge");
        assert_eq!(observation.freshness, EvidenceFreshness::SourceMissing);
    }

    // -- rebuild_narrative_derived_state_for_project ------------------------

    fn seed_epoch_for_rebuild(db: &Database, project_id: &str) -> String {
        db.with_conn(|conn| create_epoch_in_tx(conn, project_id, "initial", None))
            .expect("create epoch")
    }

    #[test]
    fn rebuild_derived_state_fails_closed_with_no_epoch() {
        let db = test_db();
        let error = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect_err("a project with no epoch must fail closed");
        assert!(error
            .to_string()
            .starts_with("NEX_REBUILD_DERIVED_NO_EPOCH"));
    }

    #[test]
    fn rebuild_derived_state_is_a_no_op_pass_with_zero_edges() {
        let db = test_db();
        seed_epoch_for_rebuild(&db, "project-1");

        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild with no edges");
        let (run_id, summary) = match outcome {
            RebuildDerivedStateOutcome::Ran { run_id, summary } => (run_id, summary),
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("first call must create a fresh run")
            }
        };
        assert_eq!(summary.consumers_evaluated, 0);
        assert_eq!(summary.edges_evaluated, 0);

        let status: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                    params![run_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read run status");
        assert_eq!(status, "completed");
    }

    #[test]
    fn rebuild_failure_persists_versioned_evidence_before_failed_status() {
        let db = test_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let edge_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET read_set_json = '[123]'
                  WHERE id = ?1",
                params![edge_id],
            )?;
            Ok(())
        })
        .expect("corrupt only the test edge read set");

        let error = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect_err("malformed read set must fail the rebuild work phase");
        assert!(error
            .to_string()
            .contains("NEX_DEPENDENCY_READ_SET_INVALID"));

        db.with_conn(|conn| {
            let (status, outcome_json): (String, String) = conn.query_row(
                "SELECT status, outcome_summary_json
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'semantic-index-rebuild'
                  ORDER BY created_at DESC, id DESC LIMIT 1",
                params!["project-1"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(status, "failed");
            let outcome: Value = serde_json::from_str(&outcome_json)?;
            assert_eq!(
                outcome
                    .get("rebuildContractVersion")
                    .and_then(Value::as_str),
                Some(REBUILD_CONTRACT_VERSION)
            );
            assert_eq!(
                outcome.get("semanticEpochId").and_then(Value::as_str),
                Some(epoch_id.as_str())
            );
            assert!(outcome
                .get("failure")
                .and_then(Value::as_object)
                .and_then(|failure| failure.get("message"))
                .and_then(Value::as_str)
                .is_some_and(|message| message.contains("NEX_DEPENDENCY_READ_SET_INVALID")));
            Ok(())
        })
        .expect("failed rebuild evidence should be durable");
    }

    #[test]
    fn rebuild_projection_failure_rolls_back_status_and_terminal_evidence() {
        let db = test_db();
        seed_epoch_for_rebuild(&db, "project-1");
        let edge_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET read_set_json = '[123]'
                  WHERE id = ?1",
                params![edge_id],
            )?;
            conn.execute_batch(
                "CREATE TRIGGER reject_rebuild_terminal_lifecycle
                   BEFORE INSERT ON narrative_maintenance_finding_lifecycle
                   BEGIN
                     SELECT RAISE(ABORT, 'forced rebuild lifecycle failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("seed rebuild projection failure fixture");

        let error = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect_err("a rebuild projection failure must not commit status");
        assert!(error
            .to_string()
            .contains("forced rebuild lifecycle failure"));

        db.with_conn(|conn| {
            let (status, outcome, terminal_code, observations): (
                String,
                Option<String>,
                Option<String>,
                i64,
            ) = conn.query_row(
                "SELECT r.status, r.outcome_summary_json, r.terminal_reason_code,
                        (SELECT COUNT(*) FROM narrative_maintenance_finding_observations)
                   FROM narrative_extraction_runs r
                  WHERE r.project_id = 'project-1'
                    AND r.run_kind = 'semantic-index-rebuild'
                  ORDER BY julianday(COALESCE(r.completed_at, r.started_at, r.created_at)) DESC,
                           COALESCE(r.completed_at, r.started_at, r.created_at) DESC,
                           r.id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(status, "running");
            assert_eq!(outcome, None);
            assert_eq!(terminal_code, None);
            assert_eq!(observations, 0);
            Ok(())
        })
        .expect("failed rebuild finalization must roll back atomically");
    }

    #[test]
    fn rebuild_success_never_reports_success_when_finalization_fails() {
        let db = test_db();
        seed_epoch_for_rebuild(&db, "project-1");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_rebuild_completion
                   BEFORE UPDATE OF status ON narrative_extraction_runs
                   WHEN OLD.run_kind = 'semantic-index-rebuild' AND NEW.status = 'completed'
                   BEGIN
                     SELECT RAISE(ABORT, 'forced rebuild finalization failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("install finalization failure trigger");

        let error = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect_err("a finalization failure must not be reported as Ran");
        assert!(error
            .to_string()
            .contains("forced rebuild finalization failure"));

        db.with_conn(|conn| {
            let (status, outcome): (String, Option<String>) = conn.query_row(
                "SELECT status, outcome_summary_json
                   FROM narrative_extraction_runs
                  WHERE project_id = 'project-1'
                    AND run_kind = 'semantic-index-rebuild'
                  ORDER BY created_at DESC, id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(status, "running");
            assert_eq!(
                outcome, None,
                "the failed finalization transaction must roll back"
            );
            Ok(())
        })
        .expect("read failed finalization state");
    }

    #[test]
    fn rebuild_work_and_finalization_failures_return_both_contexts() {
        let db = test_db();
        seed_epoch_for_rebuild(&db, "project-1");
        let edge_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET read_set_json = '[123]'
                  WHERE id = ?1",
                params![edge_id],
            )?;
            conn.execute_batch(
                "CREATE TRIGGER reject_rebuild_failure
                   BEFORE UPDATE OF status ON narrative_extraction_runs
                   WHEN OLD.run_kind = 'semantic-index-rebuild' AND NEW.status = 'failed'
                   BEGIN
                     SELECT RAISE(ABORT, 'forced rebuild failure finalization');
                   END;",
            )?;
            Ok(())
        })
        .expect("install combined failure fixture");

        let error = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect_err("both work and finalization failures must remain errors");
        let message = error.to_string();
        assert!(message.contains("NEX_DEPENDENCY_READ_SET_INVALID"));
        assert!(message.contains("forced rebuild failure finalization"));
    }

    #[test]
    fn rebuild_publish_rejects_a_rotated_epoch_before_writing_a_consumer() {
        let db = test_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let run_id = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    let handle = create_maintenance_run_in_tx(
                        conn,
                        "project-1",
                        "semantic-index-rebuild",
                        &epoch_id,
                        REBUILD_DERIVED_WORK_KEY,
                        &json!({}),
                        &format!("sha256:{}", digest_plan(&json!({}))),
                        SystemRunWorkKeyReuse::RunningOnly,
                    )?;
                    Ok(handle.run_id)
                })
            })
            .expect("create an in-flight rebuild run");
        seed_run_edge(&db, "project-1", &run_id, "project:scene:scene-live");
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "restore", None))
            .expect("rotate the semantic epoch");

        let error = rebuild_derived_state_edges_in_project(
            &db,
            "project-1",
            &run_id,
            &epoch_id,
            "2026-08-21T00:00:00.000Z",
        )
        .expect_err("a rotated rebuild must not publish consumer state");
        assert!(error
            .to_string()
            .contains("NEX_REBUILD_DERIVED_STALE_EPOCH"));

        db.with_conn(|conn| {
            let status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| row.get(0),
            )?;
            assert_eq!(status, "running");
            let freshness_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(freshness_count, 0);
            Ok(())
        })
        .expect("stale publish must leave durable state untouched");
    }

    #[test]
    fn rebuild_finalization_after_epoch_rotation_is_failed_and_returns_error() {
        let db = test_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let run_id = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    let handle = create_maintenance_run_in_tx(
                        conn,
                        "project-1",
                        "semantic-index-rebuild",
                        &epoch_id,
                        REBUILD_DERIVED_WORK_KEY,
                        &json!({}),
                        &format!("sha256:{}", digest_plan(&json!({}))),
                        SystemRunWorkKeyReuse::RunningOnly,
                    )?;
                    Ok(handle.run_id)
                })
            })
            .expect("create an in-flight rebuild run");
        let generic_error = crate::narrative_extraction::repository::cancel_run(
            &db,
            run_id.clone(),
            "project-1".to_string(),
        )
        .expect_err("generic cancellation must not win the Rebuild finalization gap");
        assert!(generic_error
            .to_string()
            .contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "restore", None))
            .expect("rotate the semantic epoch");

        let work_result: Result<RebuildDerivedStateSummary, anyhow::Error> =
            Ok(RebuildDerivedStateSummary::default());
        let error = finalize_rebuild_run(&db, "project-1", &run_id, &epoch_id, &work_result)
            .expect_err("epoch rotation must reject successful finalization");
        assert!(error
            .to_string()
            .contains("NEX_REBUILD_DERIVED_STALE_EPOCH"));

        db.with_conn(|conn| {
            let (status, outcome_json): (String, String) = conn.query_row(
                "SELECT status, outcome_summary_json
                   FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(status, "failed");
            let outcome: Value = serde_json::from_str(&outcome_json)?;
            assert!(outcome["failure"]["finalizationError"]
                .as_str()
                .is_some_and(|value| value.contains("NEX_REBUILD_DERIVED_STALE_EPOCH")));
            Ok(())
        })
        .expect("stale finalization evidence should be durable");
    }

    #[test]
    fn rebuild_derived_state_evaluates_and_publishes_every_consumer() {
        let db = current_schema_db();
        seed_epoch_for_rebuild(&db, "project-1");
        let current_token = current_scene_revision_token(&db, "scene-live");

        // Consumer run-1: one Fresh edge (stored token matches current).
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-live",
                &format!(r#"["{current_token}"]"#),
                None,
                Some("run-1"),
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record fresh edge for run-1");

        // Consumer run-2: one Stale edge (outdated stored token).
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-2",
                "project:scene:scene-live",
                r#"["v-100@1999-01-01T00:00:00.000Z"]"#,
                None,
                Some("run-2"),
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record stale edge for run-2");

        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild with two consumers");
        let summary = match outcome {
            RebuildDerivedStateOutcome::Ran { summary, .. } => summary,
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("first call must create a fresh run")
            }
        };
        assert_eq!(summary.consumers_evaluated, 2);
        assert_eq!(summary.edges_evaluated, 2);

        let (freshness_1, freshness_2): (String, String) = db
            .with_conn(|conn| {
                let f1 = conn.query_row(
                    "SELECT evidence_freshness FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1' AND consumer_kind = ?1 AND consumer_key = 'run-1'",
                    params![RUN_CONSUMER_KIND],
                    |row| row.get(0),
                )?;
                let f2 = conn.query_row(
                    "SELECT evidence_freshness FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1' AND consumer_kind = ?1 AND consumer_key = 'run-2'",
                    params![RUN_CONSUMER_KIND],
                    |row| row.get(0),
                )?;
                Ok((f1, f2))
            })
            .expect("read consumer freshness rows");
        assert_eq!(freshness_1, "fresh");
        assert_eq!(freshness_2, "stale");
    }

    #[test]
    fn rebuild_derived_state_reuses_a_still_running_run_but_not_a_completed_one() {
        let db = test_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");

        let first = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("first rebuild call");
        let first_run_id = match first {
            RebuildDerivedStateOutcome::Ran { run_id, .. } => run_id,
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("first call must create a fresh run")
            }
        };

        // The first call already finalized to 'completed'; RunningOnly must
        // not reuse it, so a second call creates a distinct new run.
        let second = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("second rebuild call");
        let second_run_id = match second {
            RebuildDerivedStateOutcome::Ran { run_id, .. } => run_id,
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("a completed run must not be reused by RunningOnly")
            }
        };
        assert_ne!(second_run_id, first_run_id);

        // A genuinely still-running row with its owned lifecycle pair
        // (simulating an in-flight concurrent call) IS reused.
        let in_flight_run_id = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    let handle = create_maintenance_run_in_tx(
                        conn,
                        "project-1",
                        "semantic-index-rebuild",
                        &epoch_id,
                        REBUILD_DERIVED_WORK_KEY,
                        &json!({}),
                        &format!("sha256:{}", digest_plan(&json!({}))),
                        SystemRunWorkKeyReuse::RunningOnly,
                    )?;
                    Ok(handle.run_id)
                })
            })
            .expect("seed an in-flight lifecycle-owned rebuild Run");
        let third = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("third rebuild call");
        match third {
            RebuildDerivedStateOutcome::AlreadyRunning { run_id } => {
                assert_eq!(run_id, in_flight_run_id)
            }
            RebuildDerivedStateOutcome::Ran { .. } => {
                panic!("a still-running run must be reused")
            }
        }
    }

    // -- verify_narrative_dependency_graph_for_project ----------------------

    #[test]
    fn project_verify_reports_missing_and_malformed_across_every_consumer() {
        let db = current_schema_db();
        let healthy_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let missing_id = seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );
        let malformed_id = seed_run_edge(&db, "project-1", "run-2", "totally:unknown:identity");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(report.total_edges, 3);
        assert!(report.edge_ids_with_missing_source.contains(&missing_id));
        assert!(!report.edge_ids_with_missing_source.contains(&healthy_id));
        // An unrecognized source-identity shape is always treated as a
        // missing source too (edge_source_is_missing's own doc comment).
        assert!(report.edge_ids_with_missing_source.contains(&malformed_id));
        assert_eq!(
            report.edge_ids_with_malformed_keys,
            vec![malformed_id.clone()]
        );
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_is_clean_with_only_healthy_edges() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(report.total_edges, 1);
        assert!(report.is_consistent());
        assert!(report.is_complete());
        assert!(report.is_clean());
    }

    #[test]
    fn persisted_rebuild_required_must_match_recomputed_repairability() {
        let clean_db = current_schema_db();
        let clean_report = clean_db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("compute a clean Verify report");
        assert!(!clean_report.rebuild_required);
        let mut forged_clean_report = clean_report.clone();
        forged_clean_report.rebuild_required = true;
        clean_db
            .with_conn(|conn| {
                validate_report_rebuild_required(conn, "project-1", &forged_clean_report)
            })
            .expect_err("a clean/manual report cannot store rebuildRequired=true");

        let repairable_db = current_schema_db();
        seed_epoch_for_rebuild(&repairable_db, "project-1");
        seed_run_edge(
            &repairable_db,
            "project-1",
            "run-repairable",
            "project:scene:scene-live",
        );
        let repairable_report = repairable_db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("compute a repairable Verify report");
        assert!(repairable_report.rebuild_required);
        let mut forged_repairable_report = repairable_report;
        forged_repairable_report.rebuild_required = false;
        repairable_db
            .with_conn(|conn| {
                validate_report_rebuild_required(conn, "project-1", &forged_repairable_report)
            })
            .expect_err("a repairable report cannot store rebuildRequired=false");
    }

    #[test]
    fn project_verify_rejects_reserved_semantic_index_checks_without_all_counts() {
        let db = current_schema_db();
        let mut report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report.is_clean());

        report
            .semantic_index_dependency_set_digest
            .observed_counts
            .remove("v1EdgeRows");
        assert!(!report
            .semantic_index_dependency_set_digest
            .has_reserved_footprint_observation());
        assert!(!report.is_consistent());
        assert!(!report.is_complete());
        assert!(!report.is_clean());
    }

    #[test]
    fn production_verify_coverage_reports_all_policy_checks() {
        let coverage = production_verify_check_coverage();
        assert_eq!(coverage["complete"], Value::Bool(true));
        assert_eq!(coverage["required"].as_array().map(Vec::len), Some(13));
        assert_eq!(coverage["covered"].as_array().map(Vec::len), Some(13));
        assert_eq!(coverage["required"], coverage["covered"]);
        assert_eq!(coverage["missing"], serde_json::json!([]));
    }

    #[test]
    fn reserved_semantic_index_checks_ignore_unrelated_embedding_chunks() {
        let db = current_schema_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO scene_chunks
                    (id, scene_id, chunk_index, text, char_start, char_end,
                     embedding, embedding_dim, model_id, content_hash,
                     chunker_version, created_at, updated_at)
                 VALUES ('scene-chunk-1', 'scene-live', 0, 'unrelated prose', 0, 14,
                         zeroblob(4), 1, 'test-model', 'sha256:chunk',
                         'test-chunker', 1, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed an unrelated scene embedding chunk");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        let expected_counts = json!({
            "metadataRows": 0,
            "activeD1HeadRows": 0,
            "v1EdgeRows": 0,
            "consumerFreshnessRows": 0,
        });
        for check in [
            &report.semantic_index_dependency_set_digest,
            &report.semantic_index_generation_correspondence,
        ] {
            let encoded = serde_json::to_value(check).expect("serialize semantic check");
            assert_eq!(encoded["observedCounts"], expected_counts);
            assert!(check.is_consistent());
            assert!(check.is_complete());
        }
        assert!(!report.rebuild_required);
        assert!(report.is_clean());
    }

    #[test]
    fn verify_outcome_digest_seals_exact_check_coverage() {
        let mut outcome = json!({
            "verifyContractVersion": VERIFY_CONTRACT_VERSION,
            "semanticEpochId": "epoch-1",
            "reportDigest": "sha256:report",
            "graphStateDigest": "sha256:graph",
            "report": {},
            "checkCoverage": production_verify_check_coverage(),
        });
        outcome["outcomeDigest"] =
            Value::String(canonical_verify_outcome_digest(&outcome).expect("outcome digest"));
        assert!(validate_verify_check_coverage(&outcome).is_ok());
        assert!(validate_canonical_verify_outcome_digest(&outcome).is_ok());

        outcome["checkCoverage"]["complete"] = Value::Bool(false);
        assert!(validate_verify_check_coverage(&outcome).is_err());
        assert!(validate_canonical_verify_outcome_digest(&outcome).is_err());
    }

    #[test]
    fn project_verify_reports_a_missing_revision_artifact_reference() {
        let db = current_schema_db();
        seed_application_fixture(&db, "application-1", "commit-1", "proposal-1", "revision-1");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_revision_source_basis
                    (revision_id, ordinal, source_kind, source_key, revision_token)
                 VALUES ('revision-1', 0, 'narrative-artifact', 'artifact:missing',
                         'sha256:artifact-token')",
                [],
            )?;
            Ok(())
        })
        .expect("seed typed artifact source basis");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .application_revision_artifact_references
            .issues
            .iter()
            .any(|issue| issue.contains("artifact-missing:missing")));
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_rejects_an_applied_legacy_unbound_revision() {
        let db = current_schema_db();
        seed_application_fixture_with_origin(
            &db,
            "application-legacy-unbound",
            "commit-legacy-unbound",
            "proposal-legacy-unbound",
            "revision-legacy-unbound",
            "legacy-unbound",
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("legacy-unbound-applied")));
        assert!(!report.rebuild_required);
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_reports_an_application_with_a_missing_commit() {
        let db = current_schema_db();
        db.with_conn(|conn| {
            // A missing Commit is project-scoped only when its Proposal Set
            // supplies the authoritative owner.  Keep the fixture inside
            // that supported closure; an Application with neither source is
            // intentionally workspace-level and excluded from this Verify.
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, created_at, updated_at)
                 VALUES ('set-missing-commit', 'run-missing-commit', 'project-1',
                         'extraction', '2026-08-15T00:00:00.000Z',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, payload_json,
                     created_at, updated_at)
                 VALUES ('proposal-missing', 'set-missing-commit', 'proposal-missing',
                         'codex-entry', '{}', '2026-08-15T00:00:00.000Z',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at)
                 VALUES ('application-missing-commit', 'commit-missing', 'proposal-missing',
                         'revision-missing', 'codex-entry', 'entity-missing',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed an Application whose Commit row is absent");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(
                |issue| issue.contains("application-missing-commit:commit:commit-missing:missing")
            ));
        assert!(!report.rebuild_required);
        assert!(!report.is_clean());
    }

    #[test]
    fn missing_commit_applications_are_scoped_by_their_proposal_set_project() {
        let db = current_schema_db();
        db.with_conn(|conn| {
            let (project_id, suffix) = ("project-1", "a");
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'extraction',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
                params![
                    format!("set-missing-{suffix}"),
                    format!("run-{suffix}"),
                    project_id
                ],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, payload_json,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?1, 'codex-entry', '{}',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
                params![
                    format!("proposal-missing-{suffix}"),
                    format!("set-missing-{suffix}")
                ],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'codex-entry', ?5,
                         '2026-08-15T00:00:00.000Z')",
                params![
                    format!("application-missing-{suffix}"),
                    format!("commit-missing-{suffix}"),
                    format!("proposal-missing-{suffix}"),
                    format!("revision-missing-{suffix}"),
                    format!("entity-missing-{suffix}")
                ],
            )?;
            Ok(())
        })
        .expect("seed project one missing-Commit Application");

        let project_one_before = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest project one before foreign Application");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, created_at, updated_at)
                 VALUES ('set-missing-b', 'run-b', 'project-2', 'extraction',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, payload_json,
                     created_at, updated_at)
                 VALUES ('proposal-missing-b', 'set-missing-b', 'proposal-missing-b',
                         'codex-entry', '{}', '2026-08-15T00:00:00.000Z',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at)
                 VALUES ('application-missing-b', 'commit-missing-b',
                         'proposal-missing-b', 'revision-missing-b', 'codex-entry',
                         'entity-missing-b', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            // This row has neither a Commit nor a Proposal Set, so it is
            // workspace-level evidence and must not be mixed into either
            // project's Verify report or digest projection.
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at)
                 VALUES ('application-missing-unattributed', 'commit-missing-unattributed',
                         'proposal-missing-unattributed', 'revision-missing-unattributed',
                         'codex-entry', 'entity-missing-unattributed',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed foreign and unattributed missing-Commit Applications");
        let project_one_report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project one");
        assert!(project_one_report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("application-missing-a:commit:commit-missing-a")));
        assert!(!project_one_report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("application-missing-b")));
        assert!(!project_one_report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("application-missing-unattributed")));

        let project_two_report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-2"))
            .expect("verify project two");
        assert!(project_two_report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("application-missing-b:commit:commit-missing-b")));
        assert!(!project_two_report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("application-missing-a")));
        assert!(!project_two_report
            .application_revision_artifact_references
            .incomplete
            .iter()
            .any(|issue| issue.contains("application-missing-unattributed")));

        let project_one_after = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest project one after foreign Application");
        assert_eq!(
            project_one_before, project_one_after,
            "a project Verify CAS must not include another project's missing-Commit Application"
        );
    }

    #[test]
    fn project_verify_reports_contribution_commit_provenance_drift() {
        let db = current_schema_db();
        seed_application_fixture(&db, "application-1", "commit-1", "proposal-1", "revision-1");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_application_contributions
                    (id, project_id, application_id, commit_id, proposal_id, revision_id,
                     target_object_identity, field_path, target_state, created_at)
                 VALUES ('contribution-1', 'project-1', 'application-1', 'wrong-commit',
                         'proposal-1', 'revision-1', 'object-1', '/title', 'unchanged',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed contribution with drifted commit provenance");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .contribution_to_application_commit_correspondence
            .issues
            .iter()
            .any(|issue| issue.contains("application-commit-mismatch")));
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_reports_legacy_generic_mirror_status_drift() {
        let db = current_schema_db();
        seed_application_fixture(&db, "application-1", "commit-1", "proposal-1", "revision-1");
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint current epoch");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_projection_freshness
                    (application_id, status, updated_at)
                 VALUES ('application-1', 'fresh', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, dependency_set_digest, updated_at)
                 VALUES ('project-1', 'application', 'application-1', 'stale', 'manual',
                         ?1, '', '2026-08-15T00:00:00.000Z')",
                params![epoch_id],
            )?;
            Ok(())
        })
        .expect("seed Legacy/Generic mirror rows");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .legacy_mirror_migration_parity
            .issues
            .iter()
            .any(|issue| issue.contains("status-mismatch")));
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_reports_a_cursor_acknowledging_past_the_feed_head() {
        let db = current_schema_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, scene_id, domain, op_type, entity_type,
                     entity_id, payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('event-1', 'project-1', 'scene-live', 'scene', 'update', 'scene',
                         'scene-live', '{}', 'session-1', 1, 1, 'prev', 'hash')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_transactions
                    (id, project_id, request_id, source_domain, source_change_event_uid,
                     source_change_event_sequence, cause_kind, origin, payload_digest, created_at)
                 VALUES ('transaction-1', 'project-1', 'request-1', 'update', 'event-1',
                         1, 'forward', 'human', 'sha256:transaction',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_events
                    (id, project_id, transaction_id, canonical_change_event_uid,
                     canonical_sequence, event_ordinal, object_key_json, change_kind,
                     mutation_kind, changed_paths_json, occurred_at)
                 VALUES ('feed-event-1', 'project-1', 'transaction-1', 'event-1', 1, 0,
                         '{\"kind\":\"scene\",\"id\":\"scene-live\"}', 'content',
                         'update', '[]', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_cursors
                    (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                 VALUES ('project-1', 'reader-1', 2, '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed feed and invalid cursor");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .cursor_and_feed_head_consistency
            .issues
            .iter()
            .any(|issue| issue.contains("acknowledges-past-feed-head")));
        assert!(!report.rebuild_required);
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_rejects_reserved_semantic_index_metadata_footprint() {
        let db = current_schema_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES ('project-1', 'lexical', 1, '2026-08-15T00:00:00.000Z',
                         'source', 'dependency', 0)",
                [],
            )?;
            Ok(())
        })
        .expect("seed Semantic Index metadata without a generation owner");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .semantic_index_dependency_set_digest
            .incomplete
            .iter()
            .any(|issue| issue.contains("reserved-consumer-kind-footprint")));
        assert!(report
            .semantic_index_generation_correspondence
            .incomplete
            .iter()
            .any(|issue| issue.contains("reserved-consumer-kind-footprint")));
        assert_eq!(
            report.semantic_index_dependency_set_digest.observed_counts["metadataRows"],
            1
        );
        assert!(!report.rebuild_required);
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_rejects_reserved_semantic_index_d1_footprint() {
        use crate::narrative_extraction::{
            write_dependency_declaration_set, DependencyDeclaration,
            DependencyDeclarationSetRequest,
        };
        use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};

        let db = current_schema_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES ('project-1', 'lexical', 1, '2026-08-15T00:00:00.000Z',
                         'source', 'dependency', 0)",
                [],
            )?;
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "semantic-index",
                "lexical",
                "project:scene:scene-live",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed Semantic Index V1 metadata and typed edge");
        write_dependency_declaration_set(
            &db,
            DependencyDeclarationSetRequest {
                project_id: "project-1".to_string(),
                consumer_kind: "semantic-index".to_string(),
                consumer_key: "lexical".to_string(),
                producer_id: "semantic-index-test-producer".to_string(),
                producer_generation: 1,
                expected_head_version: 0,
                declarations: vec![DependencyDeclaration {
                    source_object_identity: "project:scene:scene-live".to_string(),
                    role: DependencyRole::RankingOnly,
                    selector: DependencySelector::WholeSource,
                }],
                created_at: "2026-08-15T00:00:00.000Z".to_string(),
            },
        )
        .expect("seed active Semantic Index D1 head through the typed writer");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(report
            .semantic_index_dependency_set_digest
            .incomplete
            .iter()
            .any(|issue| issue.contains("reserved-consumer-kind-footprint")));
        assert!(report
            .semantic_index_generation_correspondence
            .incomplete
            .iter()
            .any(|issue| issue.contains("reserved-consumer-kind-footprint")));
        assert_eq!(
            report.semantic_index_dependency_set_digest.observed_counts,
            BTreeMap::from([
                ("metadataRows".to_string(), 1),
                ("activeD1HeadRows".to_string(), 1),
                ("v1EdgeRows".to_string(), 1),
                ("consumerFreshnessRows".to_string(), 0),
            ])
        );
        assert!(!report.rebuild_required);
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_rejects_reserved_semantic_index_freshness_footprint() {
        let db = current_schema_db();
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint current epoch");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, dependency_set_digest, updated_at)
                 VALUES ('project-1', 'semantic-index', 'lexical', 'unknown', 'manual',
                         ?1, NULL, '2026-08-15T00:00:00.000Z')",
                params![epoch_id],
            )?;
            Ok(())
        })
        .expect("seed reserved Semantic Index freshness");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        for check in [
            &report.semantic_index_dependency_set_digest,
            &report.semantic_index_generation_correspondence,
        ] {
            assert!(check
                .incomplete
                .iter()
                .any(|issue| issue.contains("reserved-consumer-kind-footprint")));
            assert_eq!(check.observed_counts["consumerFreshnessRows"], 1);
        }
        assert!(!report.rebuild_required);
        assert!(!report.is_clean());
    }

    /// An Edge under a Consumer kind this build does not implement gets its
    /// own report heading and, crucially, stays *out* of
    /// `edge_ids_with_missing_source`: its Source is present and healthy,
    /// and only the Consumer's scope is unresolvable. Filing it as a missing
    /// Source is the fabricated-Finding failure Gate C2-2's seam exists to
    /// prevent.
    /// Version skew must not stop the rebuild. A Consumer under a kind this
    /// build does not implement is skipped and counted; every Consumer it
    /// does understand is still evaluated and published in the same pass;
    /// the unknown Consumer receives an explicit Unknown/Manual publication.
    #[test]
    fn rebuild_derived_state_skips_an_unresolvable_consumer_without_failing_the_run() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                "application-contribution",
                "contribution-1",
                "project:scene:scene-live",
                r#"["/body"]"#,
                None,
                None,
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record an edge under an unimplemented consumer kind");
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint an epoch");

        let outcome =
            rebuild_narrative_derived_state_for_project(&db, "project-1").expect("rebuild derived");
        let RebuildDerivedStateOutcome::Ran { summary, .. } = outcome else {
            panic!("expected a fresh Rebuild-Derived Run");
        };
        assert_eq!(summary.consumers_evaluated, 1);
        assert_eq!(summary.edges_evaluated, 1);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 1);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);

        let published: Vec<String> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT consumer_kind FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'
                      ORDER BY consumer_kind",
                )?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read consumer freshness");
        assert_eq!(
            published,
            vec![
                "application-contribution".to_string(),
                RUN_CONSUMER_KIND.to_string(),
            ],
            "unknown Consumers must be invalidated while supported Consumers are evaluated"
        );
    }

    #[test]
    fn rebuild_skips_reserved_semantic_index_without_mutating_its_v1_or_derived_state() {
        use crate::narrative_extraction::{
            write_dependency_declaration_set, DependencyDeclaration,
            DependencyDeclarationSetRequest,
        };
        use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};

        let db = current_schema_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        seed_run_edge(
            &db,
            "project-1",
            "run-supported",
            "project:scene:scene-live",
        );
        let semantic_existing_edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    "semantic-index",
                    "lexical-existing",
                    "project:scene:scene-live",
                    r#"["/body"]"#,
                    None,
                    None,
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record existing reserved Semantic Index edge");
        let semantic_absent_edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    "semantic-index",
                    "lexical-absent",
                    "project:scene:scene-live",
                    r#"["/content"]"#,
                    None,
                    None,
                    "2026-08-15T00:00:01.000Z",
                )
            })
            .expect("record absent-state reserved Semantic Index edge");

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES ('project-1', 'lexical', 7, '2026-08-15T00:00:00.000Z',
                         'source-before', 'dependency-before', 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edge_states
                    (edge_id, project_id, evidence_freshness, reason_code, build_action,
                     evaluated_at_epoch_id, evaluated_at)
                 VALUES (?1, 'project-1', 'stale', 'source-revision-changed',
                         'rebuild-required', ?2, '2026-08-15T00:00:02.000Z')",
                params![semantic_existing_edge_id, epoch_id],
            )?;
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
                 VALUES ('project-1', 'semantic-index', 'lexical-existing', 'stale',
                         'rebuild-required', ?1, 'previous-run', '2026-08-15T00:00:02.000Z')",
                params![epoch_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed reserved metadata and existing state");

        write_dependency_declaration_set(
            &db,
            DependencyDeclarationSetRequest {
                project_id: "project-1".to_string(),
                consumer_kind: "semantic-index".to_string(),
                consumer_key: "lexical-existing".to_string(),
                producer_id: "semantic-index-test-producer".to_string(),
                producer_generation: 1,
                expected_head_version: 0,
                declarations: vec![DependencyDeclaration {
                    source_object_identity: "project:scene:scene-live".to_string(),
                    role: DependencyRole::RankingOnly,
                    selector: DependencySelector::WholeSource,
                }],
                created_at: "2026-08-15T00:00:02.000Z".to_string(),
            },
        )
        .expect("seed reserved D1 declaration");

        let before = db
            .with_conn(|conn| {
                let existing_state: (String, Option<String>, String, String, String) = conn
                    .query_row(
                        "SELECT evidence_freshness, reason_code, build_action,
                                evaluated_at_epoch_id, evaluated_at
                           FROM narrative_dependency_edge_states
                          WHERE edge_id = ?1",
                        params![semantic_existing_edge_id],
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
                let existing_freshness: (String, String, String, Option<String>, String) = conn
                    .query_row(
                        "SELECT evidence_freshness, build_action, semantic_epoch_id,
                                last_evaluated_run_id, updated_at
                           FROM narrative_consumer_freshness
                          WHERE project_id = 'project-1'
                            AND consumer_kind = 'semantic-index'
                            AND consumer_key = 'lexical-existing'",
                        [],
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
                let v1_read_set: String = conn.query_row(
                    "SELECT read_set_json FROM narrative_dependency_edges WHERE id = ?1",
                    params![semantic_existing_edge_id],
                    |row| row.get(0),
                )?;
                let metadata: (i64, String, String, i64) = conn.query_row(
                    "SELECT generation, source_digest, dependency_set_digest, dirty_cache_flag
                       FROM narrative_semantic_index_metadata
                      WHERE project_id = 'project-1' AND index_key = 'lexical'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                let d1_head: Option<(String, String, i64, i64, String)> = conn
                    .query_row(
                        "SELECT active_declaration_set_id, producer_id, producer_generation,
                                version, updated_at
                           FROM narrative_dependency_declaration_heads
                          WHERE project_id = 'project-1'
                            AND consumer_kind = 'semantic-index'
                            AND consumer_key = 'lexical-existing'",
                        [],
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
                Ok::<_, anyhow::Error>((
                    existing_state,
                    existing_freshness,
                    v1_read_set,
                    metadata,
                    d1_head,
                ))
            })
            .expect("capture reserved state before rebuild");

        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must continue with a reserved Consumer present");
        let RebuildDerivedStateOutcome::Ran { summary, .. } = outcome else {
            panic!("expected a fresh Rebuild-Derived Run");
        };
        assert_eq!(summary.consumers_evaluated, 1);
        assert_eq!(summary.edges_evaluated, 1);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 0);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 0);

        db.with_conn(|conn| {
            let after_state: (String, Option<String>, String, String, String) = conn.query_row(
                "SELECT evidence_freshness, reason_code, build_action,
                        evaluated_at_epoch_id, evaluated_at
                   FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![semantic_existing_edge_id],
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
            assert_eq!(after_state, before.0);
            let after_freshness: (String, String, String, Option<String>, String) = conn
                .query_row(
                    "SELECT evidence_freshness, build_action, semantic_epoch_id,
                            last_evaluated_run_id, updated_at
                       FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'
                        AND consumer_kind = 'semantic-index'
                        AND consumer_key = 'lexical-existing'",
                    [],
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
            assert_eq!(after_freshness, before.1);
            let absent_state_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![semantic_absent_edge_id],
                |row| row.get(0),
            )?;
            let absent_freshness_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'semantic-index'
                    AND consumer_key = 'lexical-absent'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(absent_state_count, 0);
            assert_eq!(absent_freshness_count, 0);
            let v1_read_set: String = conn.query_row(
                "SELECT read_set_json FROM narrative_dependency_edges WHERE id = ?1",
                params![semantic_existing_edge_id],
                |row| row.get(0),
            )?;
            assert_eq!(v1_read_set, before.2);
            let metadata: (i64, String, String, i64) = conn.query_row(
                "SELECT generation, source_digest, dependency_set_digest, dirty_cache_flag
                   FROM narrative_semantic_index_metadata
                  WHERE project_id = 'project-1' AND index_key = 'lexical'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(metadata, before.3);
            let d1_head: Option<(String, String, i64, i64, String)> = conn
                .query_row(
                    "SELECT active_declaration_set_id, producer_id, producer_generation,
                            version, updated_at
                       FROM narrative_dependency_declaration_heads
                      WHERE project_id = 'project-1'
                        AND consumer_kind = 'semantic-index'
                        AND consumer_key = 'lexical-existing'",
                    [],
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
            assert_eq!(d1_head, before.4);
            let supported_freshness: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = ?1
                    AND consumer_key = 'run-supported'",
                params![RUN_CONSUMER_KIND],
                |row| row.get(0),
            )?;
            assert_eq!(supported_freshness, "stale");
            Ok::<_, anyhow::Error>(())
        })
        .expect("reserved state must remain unchanged after rebuild");
    }

    #[test]
    fn a_blank_snapshot_owner_is_unresolvable_and_counted_when_every_edge_is_skipped() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_raw_snapshot_edge(
            &db,
            "edge-blank-owner",
            PROPOSAL_REVISION_CONSUMER_KIND,
            "revision-1",
            "run-1",
            Some(""),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.edge_ids_with_unresolvable_consumer_scope,
            vec!["edge-blank-owner".to_string()]
        );
        assert!(
            !report
                .edge_ids_with_missing_source
                .contains(&"edge-blank-owner".to_string()),
            "a real sealed snapshot must not be reported missing because its owner is blank"
        );

        seed_epoch_for_rebuild(&db, "project-1");
        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must skip the unresolvable Edge without failing");
        let RebuildDerivedStateOutcome::Ran { summary, .. } = outcome else {
            panic!("expected a fresh Rebuild-Derived Run");
        };
        assert_eq!(summary.consumers_evaluated, 0);
        assert_eq!(summary.edges_evaluated, 0);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 1);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);
    }

    #[test]
    fn a_partial_skip_counts_the_edge_once_without_skipping_the_consumer() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                PROPOSAL_REVISION_CONSUMER_KIND,
                "revision-mixed",
                "project:scene:scene-live",
                r#"["/body"]"#,
                None,
                Some("run-1"),
                "2026-08-15T00:00:00.000Z",
            )?;
            Ok(())
        })
        .expect("seed one evaluable Edge");
        seed_raw_snapshot_edge(
            &db,
            "edge-mixed-blank-owner",
            PROPOSAL_REVISION_CONSUMER_KIND,
            "revision-mixed",
            "run-1",
            Some(""),
        );

        seed_epoch_for_rebuild(&db, "project-1");
        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must publish the evaluable Edge and skip only the malformed one");
        let RebuildDerivedStateOutcome::Ran { summary, .. } = outcome else {
            panic!("expected a fresh Rebuild-Derived Run");
        };
        assert_eq!(summary.consumers_evaluated, 1);
        assert_eq!(summary.edges_evaluated, 1);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 0);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);
    }

    #[test]
    fn rebuild_replaces_old_fresh_authority_when_every_edge_becomes_unresolvable() {
        let db = test_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_sealed_snapshot_run(&db, "project-1", "run-2");
        let edge_id = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    "revision-stale-authority",
                    "snapshot:run-1",
                    r#"["sha256:snap"]"#,
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record a valid snapshot Edge");
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");

        let first = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("publish the initial Fresh authority");
        let first_run_id = match first {
            RebuildDerivedStateOutcome::Ran { run_id, summary } => {
                assert_eq!(summary.consumers_evaluated, 1);
                assert_eq!(summary.edges_evaluated, 1);
                run_id
            }
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("first rebuild must create a fresh Run")
            }
        };
        let initial: (String, String, String, String, Option<String>) = db
            .with_conn(|conn| {
                let (edge_freshness, edge_action) = conn.query_row(
                    "SELECT evidence_freshness, build_action
                       FROM narrative_dependency_edge_states
                      WHERE edge_id = ?1",
                    params![edge_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let (consumer_freshness, consumer_action, last_run_id) = conn.query_row(
                    "SELECT evidence_freshness, build_action, last_evaluated_run_id
                       FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'
                        AND consumer_kind = ?1
                        AND consumer_key = 'revision-stale-authority'",
                    params![PROPOSAL_REVISION_CONSUMER_KIND],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                Ok((
                    edge_freshness,
                    edge_action,
                    consumer_freshness,
                    consumer_action,
                    last_run_id,
                ))
            })
            .expect("read the initial Fresh authority");
        assert_eq!(
            initial,
            (
                "fresh".to_string(),
                "none".to_string(),
                "fresh".to_string(),
                "none".to_string(),
                Some(first_run_id),
            )
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET owning_run_id = 'run-2'
                  WHERE id = ?1",
                params![edge_id],
            )?;
            Ok(())
        })
        .expect("simulate a historical Edge with an inconsistent owner");

        let second = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must invalidate the old Fresh authority");
        let (second_run_id, summary) = match second {
            RebuildDerivedStateOutcome::Ran { run_id, summary } => (run_id, summary),
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("completed rebuild must not be reused")
            }
        };
        assert_eq!(summary.consumers_evaluated, 0);
        assert_eq!(summary.edges_evaluated, 0);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 1);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);

        let rebuilt: (
            String,
            Option<String>,
            String,
            String,
            String,
            String,
            Option<String>,
        ) = db
            .with_conn(|conn| {
                let edge_state = conn.query_row(
                    "SELECT evidence_freshness, reason_code, build_action,
                            evaluated_at_epoch_id
                       FROM narrative_dependency_edge_states
                      WHERE edge_id = ?1",
                    params![edge_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                let consumer_state = conn.query_row(
                    "SELECT evidence_freshness, build_action, last_evaluated_run_id
                       FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'
                        AND consumer_kind = ?1
                        AND consumer_key = 'revision-stale-authority'",
                    params![PROPOSAL_REVISION_CONSUMER_KIND],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                Ok((
                    edge_state.0,
                    edge_state.1,
                    edge_state.2,
                    edge_state.3,
                    consumer_state.0,
                    consumer_state.1,
                    consumer_state.2,
                ))
            })
            .expect("read the rebuilt authority");
        assert_eq!(
            rebuilt,
            (
                "unknown".to_string(),
                None,
                "manual".to_string(),
                epoch_id,
                "unknown".to_string(),
                "manual".to_string(),
                Some(second_run_id.clone()),
            )
        );
        let second_status: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                    params![second_run_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read the second Run status");
        assert_eq!(second_status, "completed");
    }

    #[test]
    fn rebuild_replaces_existing_freshness_for_an_unknown_consumer_kind() {
        let db = test_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let edge_id = "edge-unknown-consumer-authority";
        let consumer_kind = "application-contribution";
        let consumer_key = "contribution-unknown-authority";
        seed_raw_edge(
            &db,
            edge_id,
            consumer_kind,
            consumer_key,
            "project:scene:scene-live",
            None,
        );

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edge_states
                    (edge_id, project_id, evidence_freshness, reason_code, build_action,
                     evaluated_at_epoch_id, evaluated_at)
                 VALUES (?1, 'project-1', 'fresh', NULL, 'none', ?2, ?3)",
                params![edge_id, epoch_id, "2026-08-15T00:00:00.000Z"],
            )?;
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
                 VALUES ('project-1', ?1, ?2, 'fresh', 'none', ?3, 'legacy-run', ?4)",
                params![
                    consumer_kind,
                    consumer_key,
                    epoch_id,
                    "2026-08-15T00:00:00.000Z"
                ],
            )?;
            Ok(())
        })
        .expect("seed an old Fresh authority for the reserved Consumer");

        let (run_id, summary) = match rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must invalidate the old unknown-Consumer authority")
        {
            RebuildDerivedStateOutcome::Ran { run_id, summary } => (run_id, summary),
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("expected a fresh Rebuild-Derived Run")
            }
        };
        assert_eq!(summary.consumers_evaluated, 0);
        assert_eq!(summary.edges_evaluated, 0);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 1);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);

        let states: (String, String, String, String, Option<String>) = db
            .with_conn(|conn| {
                let edge_state = conn.query_row(
                    "SELECT evidence_freshness, build_action
                       FROM narrative_dependency_edge_states
                      WHERE edge_id = ?1",
                    [edge_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let consumer_state = conn.query_row(
                    "SELECT evidence_freshness, build_action, last_evaluated_run_id
                       FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'
                        AND consumer_kind = ?1
                        AND consumer_key = ?2",
                    params![consumer_kind, consumer_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                Ok((
                    edge_state.0,
                    edge_state.1,
                    consumer_state.0,
                    consumer_state.1,
                    consumer_state.2,
                ))
            })
            .expect("read the invalidated unknown-Consumer authority");
        assert_eq!(
            states,
            (
                "unknown".to_string(),
                "manual".to_string(),
                "unknown".to_string(),
                "manual".to_string(),
                Some(run_id),
            )
        );
    }

    #[test]
    fn rebuild_keeps_an_unresolvable_edge_unknown_when_evaluable_edges_are_mixed_in() {
        let db = test_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_sealed_snapshot_run(&db, "project-1", "run-2");
        let current_token = current_scene_revision_token(&db, "scene-live");
        let (scene_edge_id, snapshot_edge_id) = db
            .with_conn(|conn| {
                let scene_edge_id = record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    "revision-mixed-authority",
                    "project:scene:scene-live",
                    &format!(r#"["{current_token}"]"#),
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )?;
                let snapshot_edge_id = record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    "revision-mixed-authority",
                    "snapshot:run-1",
                    r#"["sha256:snap"]"#,
                    None,
                    Some("run-1"),
                    "2026-08-15T00:00:00.000Z",
                )?;
                Ok((scene_edge_id, snapshot_edge_id))
            })
            .expect("record valid mixed Edges");
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");

        rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("publish the initial Fresh mixed Consumer");
        let initial_freshness: Vec<String> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT evidence_freshness
                       FROM narrative_dependency_edge_states
                      WHERE edge_id IN (?1, ?2)
                      ORDER BY edge_id ASC",
                )?;
                let rows = statement
                    .query_map(params![scene_edge_id, snapshot_edge_id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read initial mixed Edge states");
        assert_eq!(
            initial_freshness,
            vec!["fresh".to_string(), "fresh".to_string()]
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET owning_run_id = 'run-2'
                  WHERE id = ?1",
                params![snapshot_edge_id],
            )?;
            Ok(())
        })
        .expect("make only the snapshot Edge owner inconsistent");

        let second = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild the mixed Consumer");
        let (second_run_id, summary) = match second {
            RebuildDerivedStateOutcome::Ran { run_id, summary } => (run_id, summary),
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("completed rebuild must not be reused")
            }
        };
        assert_eq!(summary.consumers_evaluated, 1);
        assert_eq!(summary.edges_evaluated, 1);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 0);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);

        let (scene_state, snapshot_state, consumer_state): (
            StoredEdgeState,
            StoredEdgeState,
            StoredConsumerState,
        ) = db
            .with_conn(|conn| {
                let scene_state = conn.query_row(
                    "SELECT evidence_freshness, reason_code, build_action,
                            evaluated_at_epoch_id
                       FROM narrative_dependency_edge_states
                      WHERE edge_id = ?1",
                    params![scene_edge_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                let snapshot_state = conn.query_row(
                    "SELECT evidence_freshness, reason_code, build_action,
                            evaluated_at_epoch_id
                       FROM narrative_dependency_edge_states
                      WHERE edge_id = ?1",
                    params![snapshot_edge_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                let consumer_state = conn.query_row(
                    "SELECT evidence_freshness, build_action, semantic_epoch_id,
                            last_evaluated_run_id
                       FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'
                        AND consumer_kind = ?1
                        AND consumer_key = 'revision-mixed-authority'",
                    params![PROPOSAL_REVISION_CONSUMER_KIND],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                Ok((scene_state, snapshot_state, consumer_state))
            })
            .expect("read the mixed rebuilt authority");
        assert_eq!(
            scene_state,
            (
                "fresh".to_string(),
                None,
                "none".to_string(),
                epoch_id.clone(),
            )
        );
        assert_eq!(
            snapshot_state,
            (
                "unknown".to_string(),
                None,
                "manual".to_string(),
                epoch_id.clone(),
            )
        );
        assert_eq!(
            consumer_state,
            (
                "unknown".to_string(),
                "manual".to_string(),
                epoch_id,
                Some(second_run_id),
            )
        );
    }

    #[test]
    fn a_run_snapshot_edge_with_a_different_stored_owner_is_unresolvable_not_missing() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_sealed_snapshot_run(&db, "project-1", "run-2");
        seed_raw_snapshot_edge(
            &db,
            "edge-owner-mismatch",
            RUN_CONSUMER_KIND,
            "run-1",
            "run-1",
            Some("run-2"),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.edge_ids_with_unresolvable_consumer_scope,
            vec!["edge-owner-mismatch".to_string()]
        );
        assert!(
            !report
                .edge_ids_with_missing_source
                .contains(&"edge-owner-mismatch".to_string()),
            "a mismatched owner is a malformed scope, not proof that the snapshot is gone"
        );
    }

    #[test]
    fn a_blank_stored_owner_does_not_hide_a_run_consumers_exact_fallback() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_raw_snapshot_edge(
            &db,
            "edge-run-fallback",
            RUN_CONSUMER_KIND,
            "run-1",
            "run-1",
            Some(""),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(
            report.edge_ids_with_unresolvable_consumer_scope.is_empty(),
            "the Run consumer key is the exact compatibility fallback"
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "the real sealed snapshot resolves through that fallback"
        );
    }

    #[test]
    fn a_snapshot_owner_from_another_project_is_unresolvable_not_missing() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-2", "foreign-run");
        seed_raw_snapshot_edge(
            &db,
            "edge-cross-project-owner",
            PROPOSAL_REVISION_CONSUMER_KIND,
            "revision-cross-project",
            "foreign-run",
            Some("foreign-run"),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.edge_ids_with_unresolvable_consumer_scope,
            vec!["edge-cross-project-owner".to_string()]
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "a foreign-project owner is invalid scope, not proof that the snapshot is gone"
        );

        seed_epoch_for_rebuild(&db, "project-1");
        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must skip the foreign-project scope");
        let RebuildDerivedStateOutcome::Ran { summary, .. } = outcome else {
            panic!("expected a fresh Rebuild-Derived Run");
        };
        assert_eq!(summary.consumers_evaluated, 0);
        assert_eq!(summary.edges_evaluated, 0);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 1);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 1);
    }

    #[test]
    fn a_double_prefixed_snapshot_identity_is_unresolvable_not_missing() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_raw_snapshot_edge(
            &db,
            "edge-double-prefix",
            PROPOSAL_REVISION_CONSUMER_KIND,
            "revision-double-prefix",
            "snapshot:run-1",
            Some("snapshot:run-1"),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.edge_ids_with_unresolvable_consumer_scope,
            vec!["edge-double-prefix".to_string()]
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "a malformed double prefix must not be translated into source-missing"
        );
    }

    #[test]
    fn project_verify_names_an_unresolvable_consumer_scope_without_calling_the_source_missing() {
        let db = current_schema_db();
        let run_scoped = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let unknown_scope = db
            .with_conn(|conn| {
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    // Reserved in narrative-consumer-contract.json, with no
                    // Producer and no reader in this build.
                    "application-contribution",
                    "contribution-1",
                    "project:scene:scene-live",
                    r#"["/body"]"#,
                    None,
                    None,
                    "2026-08-15T00:00:00.000Z",
                )
            })
            .expect("record an edge under an unimplemented consumer kind");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");

        assert_eq!(report.total_edges, 2);
        assert_eq!(
            report.edge_ids_with_unresolvable_consumer_scope,
            vec![unknown_scope.clone()]
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "scene-live exists for both Consumers; neither Edge has a missing Source"
        );
        assert!(
            !report.edge_ids_with_malformed_keys.contains(&unknown_scope),
            "the key is well formed -- it names a Consumer class this build does not implement"
        );
        assert!(!report.edge_ids_with_malformed_keys.contains(&run_scoped));
        assert!(!report.is_clean());
    }

    /// The `consumer-freshness-dependency-set-digest` check: a Consumer that
    /// stopped depending on a Source has no Edge left to go stale, so its
    /// rolled-up Freshness stays clean while its stored digest describes a
    /// dependency set that no longer exists.
    #[test]
    fn project_verify_detects_a_consumer_freshness_dependency_set_digest_that_drifted() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let dropped = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-second");
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint an epoch");

        // Publishing stamps the digest of both Edges.
        rebuild_narrative_derived_state_for_project(&db, "project-1").expect("rebuild derived");
        let before = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(
            before
                .consumer_keys_with_stale_dependency_set_digest
                .is_empty(),
            "a freshly published Consumer must agree with its own dependency set"
        );

        // Drop one dependency without re-publishing the Consumer.
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_dependency_edges WHERE id = ?1",
                params![dropped],
            )?;
            Ok(())
        })
        .expect("drop one edge");

        let after = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            after.consumer_keys_with_stale_dependency_set_digest,
            vec![(RUN_CONSUMER_KIND.to_string(), "run-1".to_string())]
        );
        assert!(!after.is_consistent());
        assert!(after.is_complete());
        assert!(!after.is_clean());
    }

    /// The regression the whole seam exists to prevent, in the one shape the
    /// schema still permits: a Revision Consumer whose Edge names a
    /// `snapshot:<runId>` Source that really exists, with no declaring Run
    /// recorded. It must be reported as unresolvable scope -- reporting it as
    /// a missing Source would be a fabricated Finding about a present Source.
    #[test]
    fn a_snapshot_edge_with_no_declaring_run_is_unresolvable_not_missing() {
        let db = current_schema_db();
        // A real, sealed Run whose snapshot the Edge names.
        seed_sealed_snapshot_run(&db, "project-1", "run-1");
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let orphan = "edge-null-owner".to_string();
        // The typed writer rejects new Snapshot Edges without an owner. Raw
        // SQL represents an upgraded/corrupted historical row the tolerant
        // read side still has to diagnose honestly.
        seed_raw_snapshot_edge(
            &db,
            &orphan,
            PROPOSAL_REVISION_CONSUMER_KIND,
            "revision-1",
            "run-1",
            None,
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");

        assert!(
            report
                .edge_ids_with_unresolvable_consumer_scope
                .contains(&orphan),
            "a snapshot Edge with no declaring Run must be named as unresolvable"
        );
        assert!(
            !report.edge_ids_with_missing_source.contains(&orphan),
            "the snapshot Source exists; calling it missing is the fabricated Finding \
             this seam was built to stop"
        );
    }

    #[test]
    fn proposal_revision_owner_failures_are_unresolvable_for_non_snapshot_sources() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-2", "foreign-run");
        for (edge_id, consumer_key, owning_run_id) in [
            ("edge-scene-owner-blank", "revision-blank", Some("")),
            (
                "edge-scene-owner-cross-project",
                "revision-cross-project",
                Some("foreign-run"),
            ),
            (
                "edge-scene-owner-dangling",
                "revision-dangling",
                Some("run-does-not-exist"),
            ),
            ("edge-scene-owner-null", "revision-null", None),
        ] {
            seed_raw_edge(
                &db,
                edge_id,
                PROPOSAL_REVISION_CONSUMER_KIND,
                consumer_key,
                "project:scene:scene-live",
                owning_run_id,
            );
        }

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        let mut unresolvable = report.edge_ids_with_unresolvable_consumer_scope.clone();
        unresolvable.sort();
        assert_eq!(
            unresolvable,
            vec![
                "edge-scene-owner-blank".to_string(),
                "edge-scene-owner-cross-project".to_string(),
                "edge-scene-owner-dangling".to_string(),
                "edge-scene-owner-null".to_string(),
            ],
            "a Proposal Revision's declaring Run is required provenance even when the Source resolver itself does not consume Run scope"
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "the live Scene is not missing merely because its Consumer provenance is invalid"
        );

        seed_epoch_for_rebuild(&db, "project-1");
        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must quarantine invalid owner provenance");
        let RebuildDerivedStateOutcome::Ran { summary, .. } = outcome else {
            panic!("expected a fresh Rebuild-Derived Run");
        };
        assert_eq!(summary.consumers_evaluated, 0);
        assert_eq!(summary.edges_evaluated, 0);
        assert_eq!(summary.consumers_skipped_unresolvable_scope, 4);
        assert_eq!(summary.edges_skipped_unresolvable_scope, 4);

        let states: Vec<(String, String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT edge_id, evidence_freshness, build_action
                       FROM narrative_dependency_edge_states
                      WHERE edge_id LIKE 'edge-scene-owner-%'
                      ORDER BY edge_id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read quarantined Edge States");
        assert_eq!(states.len(), 4);
        assert!(states
            .iter()
            .all(|(_, freshness, action)| freshness == "unknown" && action == "manual"));
    }

    #[test]
    fn application_owner_scope_requires_a_same_project_persisted_run() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "application-owner-local");
        seed_sealed_snapshot_run(&db, "project-2", "application-owner-foreign");
        seed_raw_edge(
            &db,
            "edge-application-owner-local",
            APPLICATION_CONSUMER_KIND,
            "application-local",
            "project:scene:scene-live",
            Some("application-owner-local"),
        );
        seed_raw_edge(
            &db,
            "edge-application-owner-null",
            APPLICATION_CONSUMER_KIND,
            "application-null",
            "project:scene:scene-live",
            None,
        );
        seed_raw_edge(
            &db,
            "edge-application-owner-foreign",
            APPLICATION_CONSUMER_KIND,
            "application-foreign",
            "project:scene:scene-live",
            Some("application-owner-foreign"),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        let mut unresolvable = report.edge_ids_with_unresolvable_consumer_scope.clone();
        unresolvable.sort();
        assert_eq!(
            unresolvable,
            vec![
                "edge-application-owner-foreign".to_string(),
                "edge-application-owner-null".to_string(),
            ],
            "Application Edges require a persisted owner Run in the same project"
        );
        assert!(
            !report
                .edge_ids_with_unresolvable_consumer_scope
                .contains(&"edge-application-owner-local".to_string()),
            "a same-project Application owner must remain evaluable"
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "invalid Application owner provenance must not fabricate a missing Source"
        );
    }

    #[test]
    fn application_snapshot_dependency_uses_embedded_apply_run_with_fresh_owner() {
        let db = current_schema_db();
        seed_sealed_snapshot_run(&db, "project-1", "backfill-owner");
        seed_sealed_snapshot_run(&db, "project-1", "apply-run");
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                APPLICATION_CONSUMER_KIND,
                "application-snapshot",
                "snapshot:apply-run",
                r#"["sha256:snap"]"#,
                None,
                Some("backfill-owner"),
                "2026-08-15T00:00:00.000Z",
            )?;
            Ok(())
        })
        .expect("Application snapshot dependency keeps the fresh Backfill owner");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify Application snapshot dependency");
        assert!(report.edge_ids_with_unresolvable_consumer_scope.is_empty());
        assert!(report.edge_ids_with_missing_source.is_empty());
    }

    #[test]
    fn a_dangling_snapshot_owner_is_unresolvable_not_missing() {
        let db = current_schema_db();
        seed_raw_snapshot_edge(
            &db,
            "edge-dangling-owner",
            PROPOSAL_REVISION_CONSUMER_KIND,
            "revision-dangling-owner",
            "run-does-not-exist",
            Some("run-does-not-exist"),
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.edge_ids_with_unresolvable_consumer_scope,
            vec!["edge-dangling-owner".to_string()]
        );
        assert!(
            report.edge_ids_with_missing_source.is_empty(),
            "a dangling declaring-Run reference is invalid Consumer provenance, not a trustworthy Source-missing observation"
        );
    }

    /// Gate C2-2's Consumer re-key changes `finding_key`, so a human's
    /// disposition stops matching. It must not be deleted -- Attention is
    /// durable human state -- so Verify has to be the thing that says it is
    /// no longer attached to anything.
    #[test]
    fn project_verify_reports_an_attention_row_whose_consumer_no_longer_exists() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        db.with_conn(|conn| {
            for (finding_key, disposition) in [
                ("narrative-extraction-run:run-1", "dismissed"),
                ("proposal-revision:revision-gone", "snoozed"),
            ] {
                conn.execute(
                    "INSERT INTO narrative_maintenance_attention
                        (project_id, finding_key, disposition, material_basis_digest, set_at,
                         actor_id, request_id, payload_digest, version)
                     VALUES ('project-1', ?1, ?2, 'sha256:basis',
                             '2026-08-15T00:00:00.000Z', 'author-1', ?1, 'sha256:payload', 1)",
                    params![finding_key, disposition],
                )?;
            }
            Ok(())
        })
        .expect("seed two dispositions");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");

        assert_eq!(
            report.orphaned_attention_finding_keys,
            vec!["proposal-revision:revision-gone".to_string()],
            "only the disposition whose Consumer declares no Edge is orphaned"
        );
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_reports_exact_edge_candidates_and_target_conflicts_for_attention_rehome() {
        let db = current_schema_db();
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("create current epoch");
        let old_finding_key = "legacy:old";
        let material_digest = "legacy-material";
        db.with_conn(|conn| {
            for (edge_id, consumer_key, observation_id) in [
                ("edge-report-a", "revision-a", "observation-report-a"),
                ("edge-report-b", "revision-b", "observation-report-b"),
            ] {
                conn.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key,
                         source_object_identity, read_set_json, created_at)
                     VALUES (?1, 'project-1', 'proposal-revision', ?2,
                             'project:scene:scene-live', '[]',
                             '2026-08-15T00:00:00.000Z')",
                    params![edge_id, consumer_key],
                )?;
                conn.execute(
                    "INSERT INTO narrative_maintenance_finding_observations
                        (id, project_id, run_id, semantic_epoch_id, edge_id,
                         finding_key, reason_code, evidence_freshness_snapshot,
                         material_basis_digest, observed_at, finding_identity,
                         rule_id, rule_version, observation_digest)
                     VALUES (?1, 'project-1', 'run-old', ?2, ?3, ?4,
                             'source-missing', 'source-missing', ?5,
                             '2026-08-15T00:00:00.000Z', NULL,
                             'narrative.consumer-freshness', 1, ?6)",
                    params![
                        observation_id,
                        epoch_id,
                        edge_id,
                        old_finding_key,
                        material_digest,
                        format!("observation-{edge_id}"),
                    ],
                )?;
            }
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, finding_identity, disposition,
                     material_basis_digest, snoozed_until, set_at, actor_id,
                     request_id, payload_digest, reason, version)
                 VALUES ('project-1', ?1, NULL, 'dismissed', ?2, NULL,
                         '2026-08-15T00:00:00.000Z', 'author-1',
                         'request-report', 'payload-report', NULL, 1)",
                params![old_finding_key, material_digest],
            )?;
            Ok(())
        })
        .expect("seed exact rehome candidates");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.orphaned_attention_finding_keys,
            vec![old_finding_key]
        );
        assert_eq!(report.orphaned_attention_rehome_ambiguities.len(), 1);
        let ambiguity = &report.orphaned_attention_rehome_ambiguities[0];
        assert!(ambiguity.contains("exact-candidate-count=2"));
        assert!(ambiguity.contains("edge-report-a"));
        assert!(ambiguity.contains("edge-report-b"));

        // A target Attention conflict is reported even when its target has
        // no Observation of the orphan's old material digest; the actual
        // re-home writer blocks on the target row alone.
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, finding_identity, disposition,
                     material_basis_digest, snoozed_until, set_at, actor_id,
                     request_id, payload_digest, reason, version)
                 VALUES ('project-1', 'proposal-revision:revision-a', NULL,
                         'dismissed', 'target-material', NULL,
                         '2026-08-15T00:00:00.000Z', 'author-1',
                         'request-report-target', 'payload-report-target', NULL, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed target Attention conflict");
        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify target conflict");
        let ambiguity = &report.orphaned_attention_rehome_ambiguities[0];
        assert!(ambiguity.contains("target-conflicts=proposal-revision:revision-a"));
    }

    /// A workspace upgraded from before Gate C2-2 has NULL in every
    /// `dependency_set_digest`, which means "never computed". It is reported
    /// as incomplete rather than stale: not a defect, but not a clean Verify.
    #[test]
    fn project_verify_is_not_clean_when_a_dependency_set_digest_was_never_computed() {
        let db = current_schema_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint an epoch");
        // The shape a pre-C2-2 publish left behind: a Freshness row with no
        // digest at all.
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                     semantic_epoch_id, updated_at)
                 VALUES ('project-1', ?1, 'run-1', 'fresh', 'none', ?2,
                         '2026-08-15T00:00:00.000Z')",
                params![RUN_CONSUMER_KIND, epoch_id],
            )?;
            Ok(())
        })
        .expect("seed a pre-C2-2 freshness row");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert!(
            report
                .consumer_keys_with_stale_dependency_set_digest
                .is_empty(),
            "NULL means not-yet-computed, not stale"
        );
        assert_eq!(
            report.consumer_keys_with_uncomputed_dependency_set_digest,
            vec![(RUN_CONSUMER_KIND.to_string(), "run-1".to_string())]
        );
        assert!(report.is_consistent());
        assert!(!report.is_complete());
        assert!(
            !report.is_clean(),
            "not inconsistent is not the same as completely verified"
        );
    }

    #[test]
    fn project_verify_keeps_orphaned_freshness_manual_instead_of_routing_rebuild() {
        let db = current_schema_db();
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint an epoch");
        db.with_conn(|conn| {
            // Rebuild enumerates current-project Dependency Edges, so this
            // Freshness row has no publisher-owned target. Verify must still
            // report its stale digest, but must not dispatch a Rebuild that
            // cannot touch it.
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, dependency_set_digest, updated_at)
                 VALUES ('project-1', ?2, 'orphan-freshness', 'fresh', 'none',
                         ?1, 'sha256:orphan-stale', '2026-08-15T00:00:00.000Z')",
                params![epoch_id, RUN_CONSUMER_KIND],
            )?;
            Ok(())
        })
        .expect("seed orphaned Freshness");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.consumer_keys_with_stale_dependency_set_digest,
            vec![(
                RUN_CONSUMER_KIND.to_string(),
                "orphan-freshness".to_string()
            )]
        );
        assert!(!report.is_consistent());
        assert!(report.is_complete());
        assert!(
            !report.rebuild_required,
            "an orphaned Freshness row is a manual finding, not a Rebuild target"
        );
    }

    #[test]
    fn a_verify_run_records_its_report_under_a_completed_run() {
        let db = test_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint an epoch");

        let outcome =
            run_dependency_verify_for_project(&db, "project-1").expect("run dependency-verify");
        assert_eq!(outcome.semantic_epoch_id, epoch_id);
        assert_eq!(outcome.report.total_edges, 1);

        let (run_kind, status, run_epoch_id, stored) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT run_kind, status, semantic_epoch_id, outcome_summary_json
                       FROM narrative_extraction_runs WHERE id = ?1",
                    params![outcome.run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .expect("read back the Verify Run");
        assert_eq!(run_kind, VERIFY_RUN_KIND);
        assert_eq!(status, "completed");
        assert_eq!(run_epoch_id.as_deref(), Some(epoch_id.as_str()));

        // The stored result is what `seal_repair_plan` reads, so it has to
        // carry the report itself plus the digest that binds it.
        let stored: serde_json::Value =
            serde_json::from_str(&stored.expect("outcome recorded")).expect("outcome is json");
        assert_eq!(
            stored["verifyContractVersion"].as_str(),
            Some(VERIFY_CONTRACT_VERSION)
        );
        assert_eq!(
            stored["report"]["consumerKeysWithUncomputedDependencySetDigest"],
            json!([]),
            "the version-5 stored report must carry the completeness field even when empty"
        );
        assert_eq!(
            stored["reportDigest"].as_str(),
            Some(outcome.report_digest.as_str())
        );
        assert_eq!(
            format!("sha256:{}", digest_plan(&stored["report"])),
            outcome.report_digest
        );
        assert_eq!(stored["checkCoverage"], production_verify_check_coverage());
        assert!(validate_verify_check_coverage(&stored)
            .expect("stored Verify check coverage must validate"));
        validate_canonical_verify_outcome_digest(&stored)
            .expect("stored Verify outcome digest must validate");
        let verify_outcome = json!({
            "verifyContractVersion": stored["verifyContractVersion"],
            "checkCoverage": stored["checkCoverage"],
        });
        println!(
            "C2ZC_RUST_VERIFY_OUTCOME={}",
            serde_json::to_string(&verify_outcome).expect("serialize Verify outcome sentinel")
        );
    }

    #[test]
    fn verify_resolution_failure_rolls_back_status_and_outcome() {
        let db = test_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let failure_run_id = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    let handle = create_maintenance_run_in_tx(
                        conn,
                        "project-1",
                        VERIFY_RUN_KIND,
                        &epoch_id,
                        &format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                        &json!({ "verifyContractVersion": VERIFY_CONTRACT_VERSION }),
                        &format!(
                            "sha256:{}",
                            digest_plan(
                                &json!({ "verifyContractVersion": VERIFY_CONTRACT_VERSION })
                            )
                        ),
                        SystemRunWorkKeyReuse::RunningOnly,
                    )?;
                    let run_id = handle.run_id;
                    transition_run_status_in_tx(conn, &run_id, NarrativeRunStatus::Failed)?;
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET terminal_reason_code = ?1
                          WHERE id = ?2",
                        params!["NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION", run_id],
                    )?;
                    Ok(run_id)
                })
            })
            .expect("seed a failed Verify Run");
        crate::narrative_extraction::project_terminal_failure_for_run(
            &db,
            "project-1",
            &failure_run_id,
            "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: prior verify failure",
        )
        .expect("project prior Verify failure");
        db.with_conn(|conn| {
            // Resolution is intentionally ordered by the durable timestamps,
            // not by insertion order.  Move the seeded failure into the past
            // so this fixture reaches the lifecycle writer; otherwise the
            // freshly-created Verify Run is correctly a no-op when its
            // completion time is not strictly newer than a same-millisecond
            // failure Observation.
            let prior_observed_at = "2000-01-01T00:00:00.000Z";
            conn.execute(
                "UPDATE narrative_maintenance_finding_observations
                    SET observed_at = ?1
                  WHERE run_id = ?2",
                params![prior_observed_at, failure_run_id],
            )?;
            conn.execute(
                "UPDATE narrative_maintenance_finding_lifecycle
                    SET observed_at = ?1
                  WHERE run_id = ?2 AND lifecycle_state = 'new'",
                params![prior_observed_at, failure_run_id],
            )?;
            conn.execute_batch(
                "CREATE TRIGGER reject_verify_terminal_lifecycle
                   BEFORE INSERT ON narrative_maintenance_finding_lifecycle
                   BEGIN
                     SELECT RAISE(ABORT, 'forced verify lifecycle failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("install Verify resolution failure trigger");

        let error = run_dependency_verify_for_project(&db, "project-1")
            .expect_err("a Verify resolution failure must not commit status");
        assert!(error
            .to_string()
            .contains("forced verify lifecycle failure"));

        db.with_conn(|conn| {
            let (status, outcome, terminal_code, observations): (
                String,
                Option<String>,
                Option<String>,
                i64,
            ) = conn.query_row(
                "SELECT r.status, r.outcome_summary_json, r.terminal_reason_code,
                        (SELECT COUNT(*) FROM narrative_maintenance_finding_observations)
                   FROM narrative_extraction_runs r
                  WHERE r.project_id = 'project-1' AND r.run_kind = 'dependency-verify'
                  ORDER BY julianday(COALESCE(r.completed_at, r.started_at, r.created_at)) DESC,
                           COALESCE(r.completed_at, r.started_at, r.created_at) DESC,
                           r.id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(status, "running");
            assert_eq!(outcome, None);
            assert_eq!(terminal_code, None);
            assert_eq!(observations, 1);
            Ok(())
        })
        .expect("failed Verify resolution must roll back atomically");
    }

    #[test]
    fn verify_reused_legacy_running_run_fails_closed_without_duplicate_execution() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("create Verify epoch");
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                create_system_run_in_tx(
                    conn,
                    "project-1",
                    VERIFY_RUN_KIND,
                    &epoch_id,
                    &format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                    &json!({ "verifyContractVersion": VERIFY_CONTRACT_VERSION }),
                    "digest",
                    SystemRunWorkKeyReuse::RunningOnly,
                    None,
                )
                .map(|_| ())
            })
        })
        .expect("seed an active Verify run");

        let error = run_dependency_verify_for_project(&db, "project-1")
            .expect_err("a legacy running Verify without lifecycle ownership must fail closed");
        assert!(error
            .to_string()
            .contains("NEX_MAINTENANCE_LIFECYCLE_OWNERSHIP_INVALID"));
        db.with_conn(|conn| {
            let run_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = 'project-1' AND run_kind = 'dependency-verify'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(run_count, 1);
            Ok(())
        })
        .expect("reused Verify must not create another Run");
    }

    #[test]
    fn a_verify_run_needs_a_semantic_epoch() {
        let db = test_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let error = run_dependency_verify_for_project(&db, "project-1")
            .expect_err("a project with no Semantic Epoch cannot run a Verify");
        assert!(
            error.to_string().contains("NEX_VERIFY_NO_EPOCH"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn project_verify_detects_an_edge_state_left_over_from_a_prior_epoch() {
        let db = test_db();
        let edge_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let old_epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("mint the first epoch");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edge_states
                    (edge_id, project_id, evidence_freshness, build_action,
                     evaluated_at_epoch_id, evaluated_at)
                 VALUES (?1, 'project-1', 'fresh', 'none', ?2, '2026-08-14T00:00:00.000Z')",
                params![edge_id, old_epoch_id],
            )?;
            Ok(())
        })
        .expect("seed a stale edge state");
        // Rotate to a new current epoch, leaving the edge_state row above
        // behind under the old one.
        db.with_conn(|conn| {
            rotate_epoch_for_restore_in_tx(conn, "project-1", "project-restored", None)
        })
        .expect("rotate epoch")
        .expect("restore must mint an epoch");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(report.edge_state_ids_outside_current_epoch, vec![edge_id]);
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_detects_a_cross_project_run_consumer() {
        let db = current_schema_db();
        // A Run that belongs to project-2 but has an Edge recorded under
        // project-1 -- exactly the boundary slip this check exists to
        // catch (the Edge's own source_object_identity carries no project
        // scope of its own).
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, version)
                 VALUES ('run-in-project-2', 'project-2', 'x', '{}', '{}', 'd',
                         'completed', '{}', '2026-08-15T00:00:00.000Z', 0)",
                [],
            )?;
            Ok(())
        })
        .expect("seed a run belonging to project-2");
        let crossing_id = "edge-cross-project-consumer".to_string();
        // The typed writer now rejects this known foreign owner. Raw SQL
        // represents an upgraded/corrupted historical row the read-only
        // verifier must continue to diagnose.
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at, owning_run_id)
                 VALUES (?1, 'project-1', ?2, 'run-in-project-2',
                         'project:scene:scene-live', '[\"/body\"]',
                         '2026-08-15T00:00:00.000Z', 'run-in-project-2')",
                params![crossing_id, RUN_CONSUMER_KIND],
            )?;
            Ok(())
        })
        .expect("seed a raw cross-project Edge fixture");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.edge_ids_with_cross_project_consumer,
            vec![crossing_id]
        );
        assert!(!report.is_clean());
    }

    #[test]
    fn project_verify_does_not_dirty_on_durable_terminal_history_from_prior_epoch() {
        let db = test_db();
        let old_epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let current_epoch_id = db
            .with_conn(|conn| {
                rotate_epoch_for_restore_in_tx(conn, "project-1", "project-restored", None)
            })
            .expect("rotate epoch")
            .expect("restore must mint the current epoch");
        assert_ne!(old_epoch_id, current_epoch_id);

        let edge_id = "edge-observation-from-prior-epoch";
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES (?1, 'project-1', 'run-old', ?2, ?3,
                         'narrative-extraction-run:run-old', 'source-missing',
                         'source-missing', 'sha256:edge-basis',
                         '2026-08-15T00:00:00.000Z', NULL,
                         'narrative.consumer-freshness', 1, 'sha256:edge-observation')",
                params![edge_id, old_epoch_id, edge_id],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('terminal-failure:v1:NEX_MAINTENANCE_UNCLASSIFIED:00000000-0000-4000-8000-000000000001',
                         'project-1', 'run-terminal-old', ?1, NULL,
                         'narrative-maintenance-failure:backfill:legacy-dependency-backfill:v2',
                         'component-incompatible', 'unknown', 'sha256:terminal-basis',
                         '2026-08-15T00:00:00.000Z', 'terminal-identity',
                         'narrative.maintenance-contract-failure', 1,
                         'sha256:terminal-observation')",
                params![old_epoch_id],
            )?;
            Ok(())
        })
        .expect("seed edge and durable terminal observations from the prior epoch");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(
            report.finding_observation_ids_outside_current_epoch,
            vec![edge_id.to_string()],
            "Verify must report rebuildable edge history but ignore durable terminal history"
        );
    }

    #[test]
    fn graph_state_excludes_only_exact_terminal_failure_output_rows() {
        let db = current_schema_db();
        let epoch_id = seed_epoch_for_rebuild(&db, "project-1");
        let baseline = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest baseline graph state");

        let terminal_key =
            "narrative-maintenance-failure:dependency-verify:dependency-verify:epoch-1";
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('terminal-failure:v1:NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR:run-terminal',
                         'project-1', 'run-terminal', ?1, NULL, ?2,
                         'component-incompatible', 'unknown', 'sha256:terminal-basis',
                         '2026-08-15T00:00:00.000Z', 'terminal-identity', ?3, 1,
                         'sha256:terminal-observation')",
                params![epoch_id, terminal_key, MAINTENANCE_FAILURE_FINDING_RULE_ID],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_lifecycle
                    (id, project_id, finding_identity, finding_key, rule_id, rule_version,
                     lifecycle_state, observation_digest, material_basis_digest, run_id,
                     semantic_epoch_id, observed_at)
                 VALUES ('terminal-lifecycle', 'project-1', 'terminal-identity', ?1, ?2, 1,
                         'new', 'sha256:terminal-observation', 'sha256:terminal-basis',
                         'run-terminal', ?3, '2026-08-15T00:00:00.000Z')",
                params![terminal_key, MAINTENANCE_FAILURE_FINDING_RULE_ID, epoch_id],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_lifecycle
                    (id, project_id, finding_identity, finding_key, rule_id, rule_version,
                     lifecycle_state, observation_digest, material_basis_digest, run_id,
                     semantic_epoch_id, observed_at)
                 VALUES ('terminal-lifecycle-resolved', 'project-1', 'terminal-identity',
                         ?1, ?2, 1, 'resolved', 'sha256:terminal-observation',
                         'sha256:terminal-basis', 'run-terminal', ?3,
                         '2026-08-15T00:00:01.000Z')",
                params![terminal_key, MAINTENANCE_FAILURE_FINDING_RULE_ID, epoch_id],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, finding_identity, identity_resolution_status,
                     disposition, material_basis_digest, snoozed_until, set_at, actor_id,
                     request_id, payload_digest, reason, version)
                 VALUES ('project-1', ?1, 'terminal-identity', 'resolved', 'snoozed',
                         'sha256:terminal-basis', '2026-09-01T00:00:00.000Z',
                         '2026-08-15T00:00:00.000Z', 'author-1', 'terminal-attention',
                         'sha256:terminal-attention', 'review later', 1)",
                [terminal_key],
            )?;
            Ok(())
        })
        .expect("seed exact terminal output rows");

        let after_terminal_output = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest graph state after terminal output");
        assert_eq!(
            after_terminal_output, baseline,
            "Verify must not invalidate itself on its terminal audit/Inbox output"
        );
        let terminal_report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify exact terminal Attention");
        assert!(terminal_report.orphaned_attention_finding_keys.is_empty());
        assert!(terminal_report
            .orphaned_attention_rehome_ambiguities
            .is_empty());

        let unlinked_key = "terminal-failure:v1:NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR:forged";
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, finding_identity, identity_resolution_status,
                     disposition, material_basis_digest, snoozed_until, set_at, actor_id,
                     request_id, payload_digest, reason, version)
                 VALUES ('project-1', ?1, 'unlinked-identity', 'resolved', 'snoozed',
                         'sha256:unlinked-basis', '2026-09-01T00:00:00.000Z',
                         '2026-08-15T00:00:01.000Z', 'author-1', 'unlinked-attention',
                         'sha256:unlinked-attention', 'forged terminal-looking row', 1)",
                [unlinked_key],
            )?;
            Ok(())
        })
        .expect("seed unlinked terminal-looking Attention");
        let after_unlinked_attention = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest graph state after unlinked Attention");
        assert_ne!(after_unlinked_attention, after_terminal_output);
        let unlinked_report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify unlinked terminal-looking Attention");
        assert!(unlinked_report
            .orphaned_attention_finding_keys
            .contains(&unlinked_key.to_string()));

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('ordinary-observation', 'project-1', 'run-ordinary', ?1, NULL,
                         'proposal-revision:ordinary', 'source-missing', 'source-missing',
                         'sha256:ordinary-basis', '2026-08-15T00:00:02.000Z', NULL,
                         'narrative.consumer-freshness', 1,
                         'sha256:ordinary-observation')",
                [epoch_id],
            )?;
            Ok(())
        })
        .expect("seed ordinary consumer Finding");
        let after_ordinary_finding = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest graph state after ordinary Finding");
        assert_ne!(
            after_ordinary_finding, after_unlinked_attention,
            "ordinary consumer Finding rows remain part of the graph-state CAS"
        );
    }

    #[test]
    fn graph_state_cas_includes_contribution_and_active_cursor_row_closures() {
        let contribution_db = current_schema_db();
        contribution_db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_application_contributions
                        (id, project_id, application_id, commit_id, proposal_id, revision_id,
                         operation_id, target_object_identity, field_path, target_state,
                         maintenance_ownership, created_at)
                     VALUES ('contribution-closure', 'project-1', 'application-closure',
                             'commit-closure', 'proposal-closure', 'revision-closure',
                             'operation-closure', 'object-closure', '/title', 'unchanged',
                             'maintained', '2026-08-15T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed contribution with unresolved references");
        let contribution_before = contribution_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest unresolved contribution closure");
        contribution_db
            .with_conn(|conn| {
                // This foreign-project Application/Commit pair is deliberately
                // outside the project-scoped Application fingerprint.  The
                // Contribution closure must still make the input-only
                // cross-project reference visible to CAS.
                conn.execute(
                    "INSERT INTO projects (id, title)
                     VALUES ('project-closure-foreign', 'Closure foreign project')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_apply_commits
                        (id, project_id, request_id, plan_digest, status, created_at)
                     VALUES ('commit-foreign', 'project-closure-foreign', 'closure-request',
                             'sha256:closure', 'committed',
                             '2026-08-15T00:00:00.000Z')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_proposal_applications
                        (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                         applied_entity_id, created_at)
                     VALUES ('application-closure', 'commit-foreign', 'proposal-closure',
                             'revision-closure', 'codex-entry', 'entity-closure',
                             '2026-08-15T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("add the previously missing Application reference");
        let contribution_after = contribution_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest contribution closure after Application insertion");
        assert_ne!(
            contribution_before, contribution_after,
            "Contribution Verify inputs must include cross-project Application closure rows"
        );
        contribution_db
            .with_conn(|conn| {
                // This operation remains outside the older project-scoped
                // operation query because its referenced Commit is absent;
                // the Contribution closure must still bind its existence.
                conn.execute(
                    "INSERT INTO narrative_apply_operations
                        (id, commit_id, operation_index, operation_kind, payload_json,
                         status, created_at)
                     VALUES ('operation-closure', 'missing-commit', 0, 'codex-entry',
                             '{}', 'applied', '2026-08-15T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("add the previously missing Operation reference");
        let operation_after = contribution_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest contribution closure after Operation insertion");
        assert_ne!(
            contribution_after, operation_after,
            "Contribution Verify inputs must include missing Operation closure rows"
        );

        let cursor_db = test_db();
        let cursor_epoch = cursor_db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("seed current epoch for cursor closure");
        cursor_db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, run_kind, semantic_epoch_id,
                         work_key)
                     VALUES ('cursor-closure-run', 'project-1', 'maintenance', '{}', '{}',
                             'sha256:cursor-spec', 'pending', '{}',
                             '2026-08-15T00:00:00.000Z', 'freshness-evaluation',
                             ?1, 'cursor-closure-work')",
                    params![cursor_epoch],
                )?;
                conn.execute(
                    "INSERT INTO narrative_change_cursors
                        (project_id, consumer_id, acknowledged_through_sequence,
                     updated_at, semantic_epoch_id, reserved_through_sequence,
                     active_run_id)
                 VALUES ('project-1', 'cursor-closure', 0,
                             '2026-08-15T00:00:00.000Z', ?1, 0,
                             'cursor-closure-run')",
                    params![cursor_epoch],
                )?;
                Ok(())
            })
            .expect("seed active cursor Run closure");
        let cursor_before = cursor_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest active cursor closure");
        cursor_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET project_id = 'project-2' WHERE id = 'cursor-closure-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate active cursor Run project");
        let cursor_after_project = cursor_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor closure after Run project mutation");
        assert_ne!(
            cursor_before, cursor_after_project,
            "cursor CAS must include the active Run project closure"
        );
        cursor_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET project_id = 'project-1', semantic_epoch_id = NULL
                      WHERE id = 'cursor-closure-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate active cursor Run semantic epoch");
        let cursor_after_epoch = cursor_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor closure after Run epoch mutation");
        assert_ne!(
            cursor_after_project, cursor_after_epoch,
            "cursor CAS must include the active Run semantic epoch closure"
        );
        cursor_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET semantic_epoch_id = ?1, run_kind = 'dependency-verify'
                      WHERE id = 'cursor-closure-run'",
                    params![cursor_epoch],
                )?;
                Ok(())
            })
            .expect("mutate active cursor Run kind");
        let cursor_after_kind = cursor_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor closure after Run kind mutation");
        assert_ne!(
            cursor_after_epoch, cursor_after_kind,
            "cursor CAS must include the active Run kind closure"
        );
        cursor_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET run_kind = 'freshness-evaluation', status = 'running'
                      WHERE id = 'cursor-closure-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate active cursor Run status");
        let cursor_after_status = cursor_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor closure after Run status mutation");
        assert_ne!(
            cursor_after_kind, cursor_after_status,
            "cursor CAS must include the active Run status closure"
        );
        cursor_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET work_key = 'cursor-closure-work-mutated'
                      WHERE id = 'cursor-closure-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate active cursor Run work key");
        let cursor_after_work_key = cursor_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor closure after Run work-key mutation");
        assert_eq!(
            cursor_after_status, cursor_after_work_key,
            "active Run work key is outside Verify's cursor/feed read closure"
        );

        let freshness_db = current_schema_db();
        let freshness_epoch = freshness_db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("seed current epoch for freshness closure");
        freshness_db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_consumer_freshness
                        (project_id, consumer_kind, consumer_key, evidence_freshness,
                         build_action, semantic_epoch_id, dependency_set_digest, updated_at)
                     VALUES ('project-1', 'application', 'freshness-closure', 'fresh',
                             'none', ?1, 'sha256:old-freshness-digest',
                             '2026-08-15T00:00:00.000Z')",
                    params![freshness_epoch],
                )?;
                Ok(())
            })
            .expect("seed consumer Freshness closure");
        let freshness_before = freshness_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest consumer Freshness closure");
        freshness_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_consumer_freshness
                        SET dependency_set_digest = 'sha256:new-freshness-digest'
                      WHERE project_id = 'project-1'
                        AND consumer_kind = 'application'
                        AND consumer_key = 'freshness-closure'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate consumer Freshness dependency digest");
        let freshness_after = freshness_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest consumer Freshness closure after mutation");
        assert_ne!(
            freshness_before, freshness_after,
            "consumer Freshness dependency digest is a Verify input and must be CAS-bound"
        );
    }

    #[test]
    fn graph_state_cas_ignores_cursor_bookkeeping_but_binds_semantic_cursor_state() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("seed current epoch for cursor read closure");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_change_cursors
                    (project_id, consumer_id, acknowledged_through_sequence,
                     last_error, updated_at, semantic_epoch_id)
                 VALUES ('project-1', 'cursor-read-closure', 0, NULL,
                         '2026-08-15T00:00:00.000Z', ?1)",
                params![epoch_id],
            )?;
            Ok(())
        })
        .expect("seed cursor read closure");

        let baseline = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor read closure baseline");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_change_cursors
                    SET last_error = 'transient idle note',
                        updated_at = '2026-08-15T00:00:01.000Z'
                  WHERE project_id = 'project-1'
                    AND consumer_id = 'cursor-read-closure'",
                [],
            )?;
            Ok(())
        })
        .expect("mutate cursor bookkeeping fields");
        let after_bookkeeping = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor read closure after bookkeeping mutation");
        assert_eq!(
            baseline, after_bookkeeping,
            "cursor updated_at/last_error are scheduler bookkeeping, not Verify inputs"
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_change_cursors
                    SET acknowledged_through_sequence = 1
                  WHERE project_id = 'project-1'
                    AND consumer_id = 'cursor-read-closure'",
                [],
            )?;
            Ok(())
        })
        .expect("mutate semantic cursor acknowledgement");
        let after_acknowledgement = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor read closure after acknowledgement mutation");
        assert_ne!(
            baseline, after_acknowledgement,
            "cursor acknowledgement is a Verify input and must invalidate the graph CAS"
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_change_cursors
                    SET lease_owner = 'cursor-reader',
                        lease_expires_at = '2026-08-15T00:00:10.000Z'
                  WHERE project_id = 'project-1'
                    AND consumer_id = 'cursor-read-closure'",
                [],
            )?;
            Ok(())
        })
        .expect("mutate semantic cursor lease fields");
        let after_lease = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest cursor read closure after lease mutation");
        assert_ne!(
            after_acknowledgement, after_lease,
            "cursor lease state is a Verify input and must invalidate the graph CAS"
        );
    }

    #[test]
    fn graph_state_cas_ignores_unreferenced_legacy_change_events() {
        let db = current_schema_db();
        let baseline = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest baseline without legacy layout event");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, scene_id, domain, op_type,
                     entity_type, entity_id, payload, session_id, sequence,
                     timestamp, prev_hash, hash)
                 VALUES ('unreferenced-layout-event', 'project-1', NULL,
                         'layout', 'layout.snapshot', 'workspace', 'project-1',
                         '{}', 'layout-session', 1, 1787893741387,
                         'layout-prev', 'layout-hash')",
                [],
            )?;
            Ok(())
        })
        .expect("seed an unreferenced legacy layout event");
        let after_layout_event = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after unreferenced legacy layout event");
        assert_eq!(
            baseline, after_layout_event,
            "legacy events outside a Narrative transaction are outside Verify's read closure"
        );
    }

    #[test]
    fn graph_state_cas_tracks_referenced_canonical_event_mutations_and_absence() {
        let db = current_schema_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, scene_id, domain, op_type,
                     entity_type, entity_id, payload, session_id, sequence,
                     timestamp, prev_hash, hash)
                 VALUES ('referenced-canonical-event', 'project-1', 'scene-live',
                         'scene', 'update', 'scene', 'scene-live', '{}',
                         'canonical-session', 1, 1787893741387,
                         'canonical-prev', 'canonical-hash')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_transactions
                    (id, project_id, request_id, source_domain,
                     source_change_event_uid, source_change_event_sequence,
                     cause_kind, origin, payload_digest, created_at)
                 VALUES ('referenced-canonical-transaction', 'project-1',
                         'canonical-request', 'update',
                         'referenced-canonical-event', 1, 'forward', 'human',
                         'sha256:canonical-transaction',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed referenced canonical event and transaction");

        let baseline = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest referenced canonical event baseline");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE change_events
                    SET op_type = 'delete'
                  WHERE project_id = 'project-1'
                    AND event_uid = 'referenced-canonical-event'",
                [],
            )?;
            Ok(())
        })
        .expect("mutate referenced canonical event operation");
        let after_operation = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after referenced canonical operation mutation");
        assert_ne!(
            baseline, after_operation,
            "referenced canonical event operation is a Verify input"
        );

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE change_events
                    SET sequence = 2
                  WHERE project_id = 'project-1'
                    AND event_uid = 'referenced-canonical-event'",
                [],
            )?;
            Ok(())
        })
        .expect("mutate referenced canonical event sequence");
        let after_sequence = db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after referenced canonical sequence mutation");
        assert_ne!(
            after_operation, after_sequence,
            "referenced canonical event sequence is a Verify input"
        );

        let after_deletion = db
            .with_conn(|conn| {
                // Production schema keeps this reference RESTRICTed. Disable
                // FK enforcement only in this corruption fixture so the
                // digest and Verify coverage can prove that a missing
                // referenced event remains an explicit LEFT JOIN result.
                conn.pragma_update(None, "foreign_keys", false)?;
                conn.execute(
                    "DELETE FROM change_events
                      WHERE project_id = 'project-1'
                        AND event_uid = 'referenced-canonical-event'",
                    [],
                )?;
                conn.pragma_update(None, "foreign_keys", true)?;
                durable_graph_state_digest(conn, "project-1")
            })
            .expect("digest after deleting referenced canonical event");
        assert_ne!(
            after_sequence, after_deletion,
            "a missing referenced canonical event must invalidate the graph CAS"
        );

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify missing referenced canonical event");
        assert!(
            report
                .cursor_and_feed_head_consistency
                .issues
                .iter()
                .any(|issue| issue.contains("source-event-missing:referenced-canonical-event")),
            "Verify must fail closed when the LEFT JOIN cannot resolve a referenced event"
        );
    }

    #[test]
    fn graph_state_cas_includes_each_edge_scope_and_source_resolution_closure() {
        let owner_db = current_schema_db();
        owner_db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, snapshot_digest, created_at, version)
                     VALUES ('edge-owner-run', 'project-1', 'source', '{}', '{}', 'digest',
                             'completed', '{}', 'sha256:owner-snapshot',
                             '2026-08-15T00:00:00.000Z', 0)",
                    [],
                )?;
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    RUN_CONSUMER_KIND,
                    "edge-owner-run",
                    "project:scene:scene-live",
                    r#"["/body"]"#,
                    None,
                    Some("edge-owner-run"),
                    "2026-08-15T00:00:00.000Z",
                )?;
                Ok(())
            })
            .expect("seed an owned Edge and its owning Run");
        let owner_before = owner_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest owned Edge closure");
        owner_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET project_id = 'project-2'
                      WHERE id = 'edge-owner-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate the owning Run project");
        let owner_project_changed = owner_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after owning Run project mutation");
        assert_ne!(
            owner_before, owner_project_changed,
            "an Edge's owning Run project is a Verify scope input"
        );

        let owner_snapshot_db = current_schema_db();
        owner_snapshot_db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, snapshot_digest, created_at, version)
                     VALUES ('edge-owner-run', 'project-1', 'source', '{}', '{}', 'digest',
                             'completed', '{}', 'sha256:owner-snapshot',
                             '2026-08-15T00:00:00.000Z', 0)",
                    [],
                )?;
                record_dependency_edge_in_tx(
                    conn,
                    "project-1",
                    RUN_CONSUMER_KIND,
                    "edge-owner-run",
                    "project:scene:scene-live",
                    r#"["/body"]"#,
                    None,
                    Some("edge-owner-run"),
                    "2026-08-15T00:00:00.000Z",
                )?;
                Ok(())
            })
            .expect("seed a second owned Edge closure");
        let owner_snapshot_before = owner_snapshot_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest owning Run snapshot input");
        owner_snapshot_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET snapshot_digest = 'sha256:owner-snapshot-new'
                      WHERE id = 'edge-owner-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate the owning Run snapshot digest");
        let owner_snapshot_changed = owner_snapshot_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after owning Run snapshot mutation");
        assert_ne!(
            owner_snapshot_before, owner_snapshot_changed,
            "an Edge's owning Run snapshot digest is a Verify source input"
        );
        owner_snapshot_db
            .with_conn(|conn| {
                conn.execute(
                    "DELETE FROM narrative_extraction_runs WHERE id = 'edge-owner-run'",
                    [],
                )?;
                Ok(())
            })
            .expect("delete the owning Run row");
        let owner_deleted = owner_snapshot_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after owning Run deletion");
        assert_ne!(
            owner_snapshot_changed, owner_deleted,
            "an Edge's missing owning Run must invalidate the graph CAS"
        );

        let source_db = current_schema_db();
        seed_raw_edge(
            &source_db,
            "scene-resolution-edge",
            RUN_CONSUMER_KIND,
            "scene-resolution-run",
            "project:scene:scene-live",
            None,
        );
        let source_before = source_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest scene Source closure");
        source_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes
                        SET version = version + 1,
                            updated_at = '2026-08-16T00:00:00.000Z'
                      WHERE id = 'scene-live' AND project_id = 'project-1'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate the scene Source revision");
        let source_revision_changed = source_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after scene Source revision mutation");
        assert_ne!(
            source_before, source_revision_changed,
            "an Edge's Source resolver revision must be graph-CAS bound"
        );
        source_db
            .with_conn(|conn| {
                conn.execute("DELETE FROM tree_nodes WHERE id = 'scene-live'", [])?;
                Ok(())
            })
            .expect("delete the scene Source row");
        let source_deleted = source_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after scene Source deletion");
        assert_ne!(
            source_revision_changed, source_deleted,
            "an Edge's missing Source resolver row must invalidate the graph CAS"
        );

        let snapshot_db = current_schema_db();
        seed_sealed_snapshot_run(&snapshot_db, "project-1", "edge-snapshot-source");
        seed_raw_snapshot_edge(
            &snapshot_db,
            "snapshot-resolution-edge",
            RUN_CONSUMER_KIND,
            "edge-snapshot-source",
            "edge-snapshot-source",
            Some("edge-snapshot-source"),
        );
        let snapshot_before = snapshot_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest snapshot Source closure");
        snapshot_db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET snapshot_digest = 'sha256:snap-new'
                      WHERE id = 'edge-snapshot-source'",
                    [],
                )?;
                Ok(())
            })
            .expect("mutate the snapshot Source revision");
        let snapshot_changed = snapshot_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after snapshot Source mutation");
        assert_ne!(
            snapshot_before, snapshot_changed,
            "snapshot Source identity and revision must be graph-CAS bound"
        );
        snapshot_db
            .with_conn(|conn| {
                conn.execute(
                    "DELETE FROM narrative_extraction_runs WHERE id = 'edge-snapshot-source'",
                    [],
                )?;
                Ok(())
            })
            .expect("delete the snapshot Source row");
        let snapshot_deleted = snapshot_db
            .with_conn(|conn| durable_graph_state_digest(conn, "project-1"))
            .expect("digest after snapshot Source deletion");
        assert_ne!(
            snapshot_changed, snapshot_deleted,
            "a missing snapshot Source row must invalidate the graph CAS"
        );
    }

    // -- regression: rebuild-derived must resolve a snapshot-document Source
    //    under its OWNING Consumer's run id, not the Rebuild Run's own id --

    #[test]
    fn rebuild_derived_state_resolves_a_snapshot_document_source_correctly() {
        let db = current_schema_db();
        seed_epoch_for_rebuild(&db, "project-1");

        // The Run that produced and sealed a snapshot -- this is the
        // Consumer/owning run the Edge's source_object_identity
        // ("snapshot:<runId>") must resolve against.
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, snapshot_digest, created_at, version)
                 VALUES ('owning-run', 'project-1', 'x', '{}', '{}', 'd',
                         'completed', '{}', 'sha256:snapshot-digest-1',
                         '2026-08-15T00:00:00.000Z', 0)",
                [],
            )?;
            Ok(())
        })
        .expect("seed the owning run with a sealed snapshot digest");
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "owning-run",
                "snapshot:owning-run",
                r#"["sha256:snapshot-digest-1"]"#,
                None,
                Some("owning-run"),
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record an edge over the snapshot source");

        let outcome = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("rebuild must not error resolving the snapshot source");
        let summary = match outcome {
            RebuildDerivedStateOutcome::Ran { summary, .. } => summary,
            RebuildDerivedStateOutcome::AlreadyRunning { .. } => {
                panic!("first call must create a fresh run")
            }
        };
        assert_eq!(summary.consumers_evaluated, 1);
        assert_eq!(summary.edges_evaluated, 1);

        let freshness: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT evidence_freshness FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1' AND consumer_kind = ?1
                        AND consumer_key = 'owning-run'",
                    params![RUN_CONSUMER_KIND],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read consumer freshness");
        // The stored token (recorded above) matches the current
        // snapshot_digest exactly, so this must resolve Fresh -- if the
        // Rebuild Run's own id were wrongly used instead of 'owning-run',
        // resolve_snapshot_document would reject it with
        // NEX_SOURCE_PROJECT_MISMATCH and this would incorrectly read
        // 'source-missing'.
        assert_eq!(freshness, "fresh");
    }
}
