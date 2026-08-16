//! Gate C2 Lane N -- Restore/Rebuild: Semantic Epoch rotation on
//! restore/migration, and read-only + repair diagnostics for the Dependency
//! Edge graph a full rebuild needs to reconcile.
//!
//! This module composes three earlier Lanes without modifying any of them:
//! Lane A's Semantic Epoch ledger (`semantic_epoch.rs`), Lane G's Dependency
//! Edge storage (`dependency_edges.rs`), and Lane E's Source revision
//! resolver (`source_revision.rs`).

use rusqlite::{params, params_from_iter, Connection};
use serde_json::json;

use super::dependency_edges::{find_edges_by_consumer, DependencyEdge, RUN_CONSUMER_KIND};
use super::digest_plan;
use super::evaluator::{evaluate_edge, EdgeComparisonInput, EdgeObservation};
use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::publish_runtime::publish_freshness_evaluation_edges_only_in_tx;
use super::repository::{create_system_run_in_tx, SystemRunWorkKeyReuse};
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};
use super::task_leases::with_immediate_transaction;
use crate::Database;

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
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
    Ok(Some(epoch_id))
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
    if source_object_identity.starts_with("project:scene:") {
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
/// `read_set_overlaps` / `normalizer_version_matches` /
/// `component_version_matches` are not backed by any stored per-Edge state
/// anywhere in this crate yet -- no Wave has added the columns those
/// checks would need -- so this always reports them healthy
/// (`EdgeComparisonInput::default()`'s baseline). That means
/// `evaluate_edge`'s `ReadSetDrift`/`Unknown` (normalizer/component)
/// branches are not yet reachable through this builder; only
/// `SourceMissing`/`Fresh`/`ExactContentRelocated`/`Stale` are. Documented
/// here rather than silently pretended otherwise; widening this is future
/// scope, not a correctness bug in what it does cover.
pub(crate) fn build_edge_comparison_input(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<EdgeComparisonInput> {
    let stored_revision_token = first_read_set_token(&edge.read_set_json)?;
    let stored_digest = stored_revision_token
        .as_deref()
        .filter(|token| token.starts_with("sha256:"))
        .map(str::to_string);

    let mut input = EdgeComparisonInput {
        stored_revision_token,
        stored_digest,
        ..EdgeComparisonInput::default()
    };

    let Some(source_kind) = infer_source_kind(&edge.source_object_identity) else {
        input.current_source_exists = false;
        return Ok(input);
    };
    match resolve_current_source_state(
        conn,
        project_id,
        run_id,
        source_kind,
        &edge.source_object_identity,
    ) {
        Ok(state) => {
            input.current_source_exists = state.exists;
            input.current_revision_token = state.revision_token;
            input.current_digest = state.content_digest;
        }
        Err(_) => {
            input.current_source_exists = false;
        }
    }
    Ok(input)
}

/// The one revision token `record_run_dependency_edges_in_tx` records per
/// Edge (`serde_json::to_string(&[row.revision_token.as_str()])`) -- see
/// that function's own doc comment on why `read_set_json` is a
/// one-element array rather than a real multi-entry read set.
fn first_read_set_token(read_set_json: &str) -> anyhow::Result<Option<String>> {
    let values: Vec<String> = serde_json::from_str(read_set_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_DEPENDENCY_READ_SET_INVALID: read_set_json must be a JSON array of strings: {error}"
        )
    })?;
    Ok(values.into_iter().next())
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

/// Outcome of one [`rebuild_narrative_derived_state_for_project`] call.
pub(crate) enum RebuildDerivedStateOutcome {
    /// A Rebuild-Derived Run for this project was already `running`; this
    /// call did nothing further (`sameWorkKeyReuse: "reuse-running-only"`).
    AlreadyRunning { run_id: String },
    /// This call created a fresh Run and evaluated every Edge under it.
    Ran {
        run_id: String,
        summary: RebuildDerivedStateSummary,
    },
}

/// Counts from one completed `rebuild_narrative_derived_state_for_project`
/// pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct RebuildDerivedStateSummary {
    pub consumers_evaluated: usize,
    pub edges_evaluated: usize,
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
///      Edges declare, evaluate every one of that Consumer's Edges
///      (`evaluate_edge_from_db`) and publish the batch
///      (`publish_freshness_evaluation_edges_only_in_tx`), in its own
///      transaction per Consumer -- so one Consumer's publish failure
///      does not roll back every other Consumer already rebuilt in this
///      pass. A project with zero Edges is a no-op pass (0 Consumers, 0
///      Edges), not an error.
///   3. Finalize the Run's status to `completed`/`failed`, always
///      attempted even on phase 2 failure.
pub(crate) fn rebuild_narrative_derived_state_for_project(
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
            let created = create_system_run_in_tx(
                conn,
                project_id,
                "semantic-index-rebuild",
                &epoch_id,
                REBUILD_DERIVED_WORK_KEY,
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningOnly,
            )?;
            let run_id = created["runId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("create_system_run_in_tx returned no runId"))?
                .to_string();
            let already_running = created["reused"].as_bool().unwrap_or(false);
            Ok((run_id, epoch_id, already_running))
        })
    })?;

    if already_running {
        return Ok(RebuildDerivedStateOutcome::AlreadyRunning { run_id });
    }

    let work_result =
        rebuild_derived_state_edges_in_project(db, project_id, &run_id, &semantic_epoch_id, &now);

    let finalize_status = if work_result.is_ok() {
        NarrativeRunStatus::Completed
    } else {
        NarrativeRunStatus::Failed
    };
    let finalize_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            transition_run_status_in_tx(conn, &run_id, finalize_status)
        })
    });
    if let Err(finalize_error) = finalize_result {
        tracing::error!(
            "dependency-rebuild-derived: failed to finalize run '{run_id}' status: {finalize_error}"
        );
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
    let mut summary = RebuildDerivedStateSummary::default();
    for (consumer_kind, consumer_key) in consumers {
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                let edges =
                    find_edges_by_consumer(conn, project_id, &consumer_kind, &consumer_key)?;
                if edges.is_empty() {
                    return Ok(());
                }
                let mut edges_and_observations = Vec::with_capacity(edges.len());
                for edge in &edges {
                    let observation = evaluate_edge_from_db(conn, project_id, run_id, edge)?;
                    edges_and_observations.push((edge.id.clone(), observation));
                }
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    project_id,
                    run_id,
                    &consumer_kind,
                    &consumer_key,
                    &edges_and_observations,
                    semantic_epoch_id,
                    now,
                )?;
                summary.consumers_evaluated += 1;
                summary.edges_evaluated += edges_and_observations.len();
                Ok(())
            })
        })?;
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
        get_current_epoch, list_epochs, record_dependency_edge_in_tx,
    };
    use crate::Database;
    use rusqlite::params;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
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
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record run-scoped edge")
    }

    #[test]
    fn verify_reports_no_missing_sources_when_every_edge_resolves() {
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
        let keep_id = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let broken_id = seed_run_edge(
            &db,
            "project-1",
            "run-1",
            "project:scene:scene-does-not-exist",
        );

        let deleted = db
            .with_conn(|conn| {
                rebuild_repair_dependency_edges_in_tx(conn, "project-1", &[broken_id.clone()])
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
        let db = test_db();
        let project_1_edge = seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");
        let project_2_edge = seed_run_edge(&db, "project-2", "run-1", "project:scene:scene-live");

        // Ask to delete project-1's edge id, but scope the repair to
        // project-2: the id exists, but not under that project, so nothing
        // is deleted.
        let deleted = db
            .with_conn(|conn| {
                rebuild_repair_dependency_edges_in_tx(conn, "project-2", &[project_1_edge.clone()])
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
    fn rebuild_derived_state_evaluates_and_publishes_every_consumer() {
        let db = test_db();
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
        seed_epoch_for_rebuild(&db, "project-1");

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

        // A genuinely still-'running' row (simulating an in-flight
        // concurrent call) IS reused.
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'running' WHERE id = ?1",
                params![second_run_id],
            )?;
            Ok(())
        })
        .expect("simulate an in-flight run");
        let third = rebuild_narrative_derived_state_for_project(&db, "project-1")
            .expect("third rebuild call");
        match third {
            RebuildDerivedStateOutcome::AlreadyRunning { run_id } => {
                assert_eq!(run_id, second_run_id)
            }
            RebuildDerivedStateOutcome::Ran { .. } => {
                panic!("a still-running run must be reused")
            }
        }
    }
}
