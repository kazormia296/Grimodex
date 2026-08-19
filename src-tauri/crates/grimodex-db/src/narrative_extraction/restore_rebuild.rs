//! Gate C2 Lane N -- Restore/Rebuild: Semantic Epoch rotation on
//! restore/migration, and read-only + repair diagnostics for the Dependency
//! Edge graph a full rebuild needs to reconcile.
//!
//! This module composes three earlier Lanes without modifying any of them:
//! Lane A's Semantic Epoch ledger (`semantic_epoch.rs`), Lane G's Dependency
//! Edge storage (`dependency_edges.rs`), and Lane E's Source revision
//! resolver (`source_revision.rs`).

use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::consumer_identity::{is_declared_consumer_kind, owning_run_id_for_consumer};
use super::dependency_edges::{
    consumer_dependency_set_digest, find_edges_by_consumer,
    parse_snapshot_run_id_from_source_identity, run_id_belongs_to_another_project, DependencyEdge,
    RUN_CONSUMER_KIND,
};
use super::digest_plan;
use super::evaluator::{
    evaluate_edge, BuildAction, EdgeComparisonInput, EdgeObservation, EvidenceFreshness,
};
use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::publish_runtime::publish_freshness_evaluation_edges_only_in_tx;
use super::repository::{create_system_run_in_tx, record_run_outcome_in_tx, SystemRunWorkKeyReuse};
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};
use super::source_revision::resolve_current_source_state;
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
/// No production caller yet -- kept for the single-Run diagnostic callers
/// this doc comment describes; [`verify_narrative_dependency_graph_for_project`]
/// below is the Run Kind Policy's project-wide Verify entry point actually
/// wired to IPC.
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RebuildDerivedStateSummary {
    pub consumers_evaluated: usize,
    pub edges_evaluated: usize,
    /// Consumers this pass could not evaluate because their
    /// `consumer_kind` is outside the declared vocabulary, or because every
    /// one of their Snapshot Edges had an unresolvable Run scope.
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
    /// Individual Edges skipped because their Snapshot Source cannot be
    /// matched to one trustworthy declaring Run -- see
    /// [`resolve_edge_consumer_scope`]. Counted rather than source-evaluated
    /// with a stand-in or inconsistent Run, which is how a present Source
    /// gets called missing. The Edge still receives an explicit `Unknown`
    /// state for authority invalidation.
    pub edges_skipped_unresolvable_scope: usize,
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
            let created = create_system_run_in_tx(
                conn,
                project_id,
                "semantic-index-rebuild",
                &epoch_id,
                REBUILD_DERIVED_WORK_KEY,
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningOnly,
                // No request identity: this Run is started by the system
                // itself, not by an addressable caller request.
                None,
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
        // Counted inside the per-Consumer closure, which cannot borrow
        // `summary` mutably alongside the counters it already updates.
        let mut skipped = 0usize;
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                let edges =
                    find_edges_by_consumer(conn, project_id, &consumer_kind, &consumer_key)?;
                if edges.is_empty() {
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
                        "NEX_CONSUMER_KIND_INVALID: skipping a Consumer whose kind is outside \
                         this build's declared vocabulary"
                    );
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
                                 evaluation and publishing Unknown for a snapshot-document \
                                 Edge whose declaring Run is missing, malformed, or inconsistent"
                            );
                            skipped_edges += 1;
                            publish_observations.push((
                                edge.id.clone(),
                                EdgeObservation {
                                    freshness: EvidenceFreshness::Unknown,
                                    reason_code: None,
                                    build_action: BuildAction::Manual,
                                },
                            ));
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
/// Covers 7 of the policy's 13 named checks, plus one this Gate added
/// (`narrative-run-kind-policy.json`'s `verifiesDurableGraph`/
/// `verifiesRebuildableState`); see [`verify_narrative_dependency_graph_for_project`]'s
/// doc comment for exactly which, and which 6 remain unimplemented.
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
    /// A `RUN_CONSUMER_KIND`-declared Edge whose Consumer (Run) belongs to
    /// a *different* project than the Edge's own `project_id` -- the
    /// Edge's `source_object_identity` has no embedded project scope of
    /// its own, so this is the one place that boundary could silently
    /// slip.
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
    /// `narrative_maintenance_finding_observations` row whose
    /// `semantic_epoch_id` is not the project's current Epoch -- same
    /// staleness shape as `edge_state_ids_outside_current_epoch`, for the
    /// Finding Observation history instead of the Edge State snapshot.
    pub finding_observation_ids_outside_current_epoch: Vec<String>,
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
    /// vocabulary (`consumer_identity::ConsumerKind`), or whose Snapshot
    /// key, stored `owning_run_id`, and Run Consumer key cannot be reconciled
    /// to one trustworthy Run id.
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
    /// A NULL stored digest is **not** reported. The column arrived in
    /// SCHEMA 24 with no writer, so every row written before Gate C2-2 has
    /// NULL and means "never computed", which is not a defect --
    /// `dependency-rebuild-derived` fills it in on the next pass.
    pub consumer_keys_with_stale_dependency_set_digest: Vec<(String, String)>,
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
}

impl DependencyGraphVerifyReport {
    /// Whether every check this report covers came back clean. Does not
    /// mean the Durable Graph is fully healthy -- only that the 7 checks
    /// this report actually runs found nothing; see the struct's own doc
    /// comment on the 6 it does not.
    pub fn is_clean(&self) -> bool {
        self.edge_ids_with_missing_source.is_empty()
            && self.duplicate_edge_keys.is_empty()
            && self.edge_ids_with_cross_project_consumer.is_empty()
            && self.edge_ids_with_malformed_keys.is_empty()
            && self.edge_state_ids_outside_current_epoch.is_empty()
            && self
                .finding_observation_ids_outside_current_epoch
                .is_empty()
            && self.duplicate_edge_ids_to_deactivate.is_empty()
            && self.edge_ids_with_unresolvable_consumer_scope.is_empty()
            && self
                .consumer_keys_with_stale_dependency_set_digest
                .is_empty()
            && self.orphaned_attention_finding_keys.is_empty()
    }
}

/// `dependency-verify` (Run Kind Policy): read-only diagnostic across the
/// Durable Dependency Graph and the Rebuildable Derived State for the
/// *whole* project -- every Consumer, not one Run's own Edges. Writes
/// nothing to any table this function reads from; the caller (the
/// `dependency-verify` Run orchestrator, not yet implemented -- see this
/// module's remaining scope) owns recording a Run/typed-diagnostic/
/// Finding-Observation outcome from this report, per
/// `forbidSideEffectRepair: true`.
///
/// Currently checks 7 of the policy's 13 named items:
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
/// Not yet implemented, and not silently treated as passing (the caller
/// must not present this report as if it covered them):
/// `application-revision-artifact-references`, `dependency-set-digest`
/// (the Semantic Index half -- nothing writes
/// `narrative_semantic_index_metadata` yet; the Consumer half is covered
/// above), `contribution-to-application-commit-correspondence`,
/// `legacy-mirror-migration-parity`, `cursor-and-feed-head-consistency`,
/// `semantic-index-generation-correspondence`.
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
    require_non_empty(project_id, "projectId")?;
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
            create_system_run_in_tx(
                conn,
                project_id,
                VERIFY_RUN_KIND,
                &epoch_id,
                &format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningOnly,
                None,
            )
        })
    })?;
    let run_id = created["runId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("create_system_run_in_tx returned no runId"))?
        .to_string();

    let report =
        db.with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, project_id));
    match report {
        Ok(report) => {
            let report_value = serde_json::to_value(&report)?;
            let report_digest = format!("sha256:{}", digest_plan(&report_value));
            let outcome = json!({
                "verifyContractVersion": VERIFY_CONTRACT_VERSION,
                "semanticEpochId": epoch_id,
                "reportDigest": report_digest,
                "report": report_value,
            });
            db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    record_run_outcome_in_tx(conn, &run_id, &outcome)?;
                    transition_run_status_in_tx(conn, &run_id, NarrativeRunStatus::Completed)
                })
            })?;
            Ok(VerifyRunOutcome {
                run_id,
                semantic_epoch_id: epoch_id,
                report_digest,
                report,
            })
        }
        Err(error) => {
            let _ = db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    record_run_outcome_in_tx(
                        conn,
                        &run_id,
                        &json!({ "failure": error.to_string() }),
                    )?;
                    transition_run_status_in_tx(conn, &run_id, NarrativeRunStatus::Failed)
                })
            });
            Err(error)
        }
    }
}

/// Bumped whenever the shape of `DependencyGraphVerifyReport` or the set of
/// checks behind it changes in a way that makes an older stored report
/// unsafe to seal a Repair plan from.
///
/// `"3"` is what Gate C2-2 ships. The report gained
/// `edge_ids_with_unresolvable_consumer_scope`,
/// `consumer_keys_with_stale_dependency_set_digest` and
/// `orphaned_attention_finding_keys`, and `edge_ids_with_missing_source` no
/// longer absorbs Edges whose Consumer scope could not be resolved.
///
/// `"2"` existed only on the branch that built this Gate, as the state after
/// the first two fields and before the third. No build carrying it was
/// released, so no stored report can be at `"2"` -- it is skipped rather than
/// preserved, and the single step `"1"` -> `"3"` is the whole story a
/// workspace can experience.
///
/// A stored `"1"` report is refused by `repair.rs`'s
/// `NEX_REPAIR_VERIFY_CONTRACT_VERSION_MISMATCH` gate, which runs before the
/// report is deserialized at all -- correct twice over here, since a `"1"`
/// report both omits the new fields (none is `#[serde(default)]`, so it would
/// not deserialize either) and asserts a clean bill of health over a strictly
/// smaller set of checks. The operational consequence is that an in-flight
/// Verify result does not survive this upgrade: re-run Verify before sealing
/// a Repair.
pub(crate) const VERIFY_CONTRACT_VERSION: &str = "3";

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
    pub report: DependencyGraphVerifyReport,
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
        let kind_is_declared = is_declared_consumer_kind(consumer_kind);
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
            // Only ask "is the Source missing?" when the question can be
            // answered. Without an owning Run a `snapshot:` Source resolves
            // to an error, which `edge_source_is_missing` reports as
            // `true` -- a Source that is present being filed as gone. The
            // Consumer is reported under its own heading above instead.
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
    report.orphaned_attention_finding_keys = orphaned_attention_finding_keys(conn, project_id)?;

    if let Some(current_epoch_id) = get_current_epoch(conn, project_id)?.map(|epoch| epoch.id) {
        report.edge_state_ids_outside_current_epoch =
            edge_state_ids_outside_epoch(conn, project_id, &current_epoch_id)?;
        report.finding_observation_ids_outside_current_epoch =
            finding_observation_ids_outside_epoch(conn, project_id, &current_epoch_id)?;
    }

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

    Ok(report)
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
    /// Every current Source kind except `snapshot-document` ignores Run
    /// scope, so no owner has to be supplied to its resolver.
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
/// SCHEMA 30's stored `owning_run_id` is primary. Empty/whitespace-only
/// historical values are treated as absent so a Run Consumer can still use
/// its exact `consumer_key` compatibility fallback; a non-empty malformed or
/// mismatched stored value is never hidden by that fallback. Snapshot Edges
/// additionally require the `snapshot:<runId>` suffix, effective owner, and
/// (for Run Consumers) `consumer_key` to agree byte-for-byte. A persisted Run
/// owned by another project is unresolvable scope; an absent Run remains a
/// resolved scope so the Source resolver can diagnose it as genuinely
/// missing.
fn resolve_edge_consumer_scope<'a>(
    conn: &Connection,
    project_id: &str,
    edge: &'a DependencyEdge,
    consumer_kind: &str,
    consumer_key: &'a str,
) -> anyhow::Result<EdgeConsumerScope<'a>> {
    let snapshot_run_id =
        match parse_snapshot_run_id_from_source_identity(&edge.source_object_identity) {
            Ok(Some(run_id)) => run_id,
            Ok(None) => return Ok(EdgeConsumerScope::NotRequired),
            Err(_) => return Ok(EdgeConsumerScope::Unresolvable),
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
/// clears.
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
    let mut statement = conn.prepare(
        "SELECT a.finding_key
           FROM narrative_maintenance_attention a
          WHERE a.project_id = ?1
            AND NOT EXISTS (
                SELECT 1 FROM narrative_dependency_edges e
                 WHERE e.project_id = a.project_id
                   AND e.consumer_kind || ':' || e.consumer_key = a.finding_key
            )
          ORDER BY a.finding_key ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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
/// Rows with a NULL digest are skipped, not reported. NULL means "never
/// computed" -- the column landed in SCHEMA 24 with no writer, so every
/// workspace that predates Gate C2-2 has NULL for every Consumer, and
/// reporting those would turn a Verify on an ordinary upgraded workspace
/// into a wall of false findings. They converge on the next
/// `dependency-rebuild-derived`, which writes the digest for every Consumer
/// it publishes.
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
          WHERE project_id = ?1 AND dependency_set_digest IS NOT NULL
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
        "SELECT edge_id
           FROM narrative_dependency_edge_states
          WHERE project_id = ?1 AND evaluated_at_epoch_id != ?2
          ORDER BY edge_id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, current_epoch_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn finding_observation_ids_outside_epoch(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT id
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?1 AND semantic_epoch_id != ?2
          ORDER BY id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, current_epoch_id], |row| {
            row.get::<_, String>(0)
        })?
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
        PROPOSAL_REVISION_CONSUMER_KIND,
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
                Some(run_id),
                "2026-08-15T00:00:00.000Z",
            )
        })
        .expect("record run-scoped edge")
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
        let db = test_db();
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

    // -- verify_narrative_dependency_graph_for_project ----------------------

    #[test]
    fn project_verify_reports_missing_and_malformed_across_every_consumer() {
        let db = test_db();
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
        let db = test_db();
        seed_run_edge(&db, "project-1", "run-1", "project:scene:scene-live");

        let report = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("verify project");
        assert_eq!(report.total_edges, 1);
        assert!(report.is_clean());
    }

    /// An Edge under a Consumer kind this build does not implement gets its
    /// own report heading and, crucially, stays *out* of
    /// `edge_ids_with_missing_source`: its Source is present and healthy,
    /// and only the Consumer's scope is unresolvable. Filing it as a missing
    /// Source is the fabricated-Finding failure Gate C2-2's seam exists to
    /// prevent.
    /// Version skew must not stop the rebuild. A Consumer under a kind this
    /// build does not implement is skipped and counted; every Consumer it
    /// does understand is still evaluated and published in the same pass.
    #[test]
    fn rebuild_derived_state_skips_an_unresolvable_consumer_without_failing_the_run() {
        let db = test_db();
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

        let published: Vec<String> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT consumer_kind FROM narrative_consumer_freshness
                      WHERE project_id = 'project-1'",
                )?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read consumer freshness");
        assert_eq!(
            published,
            vec![RUN_CONSUMER_KIND.to_string()],
            "only the Consumer this build understands may get a Freshness row"
        );
    }

    #[test]
    fn a_blank_snapshot_owner_is_unresolvable_and_counted_when_every_edge_is_skipped() {
        let db = test_db();
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
        let db = test_db();
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
            (String, Option<String>, String, String),
            (String, Option<String>, String, String),
            (String, String, String, Option<String>),
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        let db = test_db();
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
        assert!(!after.is_clean());
    }

    /// The regression the whole seam exists to prevent, in the one shape the
    /// schema still permits: a Revision Consumer whose Edge names a
    /// `snapshot:<runId>` Source that really exists, with no declaring Run
    /// recorded. It must be reported as unresolvable scope -- reporting it as
    /// a missing Source would be a fabricated Finding about a present Source.
    #[test]
    fn a_snapshot_edge_with_no_declaring_run_is_unresolvable_not_missing() {
        let db = test_db();
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

    /// Gate C2-2's Consumer re-key changes `finding_key`, so a human's
    /// disposition stops matching. It must not be deleted -- Attention is
    /// durable human state -- so Verify has to be the thing that says it is
    /// no longer attached to anything.
    #[test]
    fn project_verify_reports_an_attention_row_whose_consumer_no_longer_exists() {
        let db = test_db();
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

    /// A workspace upgraded from before Gate C2-2 has NULL in every
    /// `dependency_set_digest`, which means "never computed" -- reporting
    /// those would turn an ordinary Verify into a wall of false findings.
    #[test]
    fn project_verify_ignores_a_consumer_whose_dependency_set_digest_was_never_computed() {
        let db = test_db();
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
            "NULL means not-yet-computed, which is not a defect"
        );
        assert!(report.is_clean());
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
            stored["reportDigest"].as_str(),
            Some(outcome.report_digest.as_str())
        );
        assert_eq!(
            format!("sha256:{}", digest_plan(&stored["report"])),
            outcome.report_digest
        );
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
        let db = test_db();
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

    // -- regression: rebuild-derived must resolve a snapshot-document Source
    //    under its OWNING Consumer's run id, not the Rebuild Run's own id --

    #[test]
    fn rebuild_derived_state_resolves_a_snapshot_document_source_correctly() {
        let db = test_db();
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
