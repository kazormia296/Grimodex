//! Publish Runtime (Gate C2 Wave 2 Lane J): the single integrated
//! transaction that turns a batch of Dependency Edge outcomes
//! (`evaluator::EdgeObservation`, Lane F -- pure, no DB I/O) into every
//! durable write a completed Freshness-evaluation Run must make. Outcomes
//! normally come from evaluation; callers may also publish an explicit
//! `Unknown` when an Edge cannot be evaluated safely.
//!
//! ADR 005 Amendment, "Mutation-time" flow (`docs/adr/005-narrative-semantic-core-boundary.md`):
//!
//! ```text
//! Source mutation
//!   -> Change Feed
//!   -> Reverse Dependency Lookup      (dependency_edges::find_edges_by_source, Lane G)
//!   -> Freshness re-evaluation        (evaluator::evaluate_edge, Lane F)
//!   -> Publish                        (this module, Lane J)
//! ```
//!
//! Two new typed writers land here -- nowhere else in the crate writes
//! either table:
//!
//! - [`write_edge_state_in_tx`] -- `narrative_dependency_edge_states`
//!   (SCHEMA_VERSION 23), one row per Edge, PK `edge_id`. A per-Edge
//!   diagnostic snapshot of the *last* evaluation only; re-evaluating an
//!   Edge overwrites this row rather than accumulating history.
//! - [`write_consumer_freshness_in_tx`] -- `narrative_consumer_freshness`,
//!   one row per Consumer, PK `(project_id, consumer_kind, consumer_key)`.
//!   This *is* the Freshness authority
//!   (`policies/narrative/semantic-core-authorities.json`'s
//!   `evidence-freshness` concern): "C2 must not create a second durable
//!   Freshness authority" (ADR 005 Amendment, "Authority matrix and C2
//!   start condition"). `finding_observation.rs`'s diagnostic history and
//!   `semantic_index_diagnostics.rs`'s dirty-cache flag are both explicitly
//!   documented as *not* this authority; this module is the only writer of
//!   it.
//!
//! [`publish_freshness_evaluation_in_tx`] is the orchestrator: one
//! caller-owned transaction that, in fixed order, writes both tables above,
//! records a Finding Observation (Lane C) for every Edge that has something
//! to explain, completes the Run (Lane B), and acknowledges the Change Feed
//! cursor reservation (Lane I). Like every other `_in_tx` helper in this
//! crate it does not open or close the transaction itself -- unlike most of
//! them, it *requires* one already be open (`!conn.is_autocommit()`):
//! in autocommit mode each step below would commit independently, so a
//! failure partway through (most plausibly the final cursor acknowledge)
//! would leave Edge State / Consumer Freshness / Finding Observation / Run
//! status changes durably committed with no matching cursor advance -- the
//! same hazard `cursor_reservation.rs`'s own mutating functions guard
//! against, for the same reason.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::consumer_identity::{
    consumer_finding_key, is_reserved_semantic_index_consumer_kind, validate_consumer_identity,
};
use super::cursor_reservation::acknowledge_cursor_reservation_in_tx;
use super::dependency_edges::consumer_dependency_set_digest;
use super::evaluator::{
    unknown_edge_observation, BuildAction, EdgeObservation, EvidenceFreshness, FindingReasonCode,
};
use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::finding_identity::{
    material_basis_digest, observation_digest, stable_finding_identity, MaterialBasisInput,
    ObservationDigestInput, BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION,
};
use super::finding_observation::{
    latest_finding_lifecycle_for_identity, record_finding_lifecycle_in_tx,
    record_finding_observation_with_identity_in_tx, FindingLifecycleState, FindingLifecycleWrite,
    FindingObservationWrite,
};

/// Fail closed (mirrors `finding_observation.rs::ensure_epoch_project`,
/// which this module cannot import -- that function is private to its own
/// module) rather than let a Semantic Epoch that belongs to a different
/// project silently attach state to the wrong project. The `evaluated_at_epoch_id`
/// / `semantic_epoch_id` foreign keys only check bare existence, not project
/// ownership.
fn ensure_epoch_belongs_to_project(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM narrative_semantic_epochs WHERE id = ?1",
            params![semantic_epoch_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!(
            "NEX_PUBLISH_RUNTIME_EPOCH_PROJECT_MISMATCH: semantic epoch '{semantic_epoch_id}' \
             does not belong to project '{project_id}'"
        ),
        None => anyhow::bail!(
            "NEX_PUBLISH_RUNTIME_EPOCH_MISSING: semantic epoch '{semantic_epoch_id}' was not found"
        ),
    }
}

/// Same fail-closed shape as [`ensure_epoch_belongs_to_project`], for the
/// Edge's own project ownership. `narrative_dependency_edge_states.edge_id`
/// FK-references `narrative_dependency_edges(id)` only, so an Edge that
/// exists but belongs to a different project would otherwise pass silently.
fn ensure_edge_belongs_to_project(
    conn: &Connection,
    project_id: &str,
    edge_id: &str,
) -> anyhow::Result<()> {
    let edge_identity: Option<(String, String, String)> = conn
        .query_row(
            "SELECT project_id, consumer_kind, consumer_key
               FROM narrative_dependency_edges WHERE id = ?1",
            params![edge_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match edge_identity {
        Some((owner, consumer_kind, consumer_key)) if owner == project_id => {
            ensure_generic_freshness_target(conn, project_id, &consumer_kind, &consumer_key)
        }
        Some((_, _, _)) => anyhow::bail!(
            "NEX_PUBLISH_RUNTIME_EDGE_PROJECT_MISMATCH: dependency edge '{edge_id}' does not \
             belong to project '{project_id}'"
        ),
        None => anyhow::bail!(
            "NEX_PUBLISH_RUNTIME_EDGE_MISSING: dependency edge '{edge_id}' was not found"
        ),
    }
}

fn ensure_generic_freshness_target(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !is_reserved_semantic_index_consumer_kind(consumer_kind)
            || super::nir1_chronicle_index::is_registered_chronicle_index(conn, project_id, consumer_key)?,
        "NEX_PUBLISH_RUNTIME_RESERVED_CONSUMER: '{consumer_kind}' is not a Generic Freshness target"
    );
    Ok(())
}

/// Upsert one Dependency Edge's latest evaluated outcome into
/// `narrative_dependency_edge_states` (SCHEMA_VERSION 23, PK `edge_id`).
/// This is a per-Edge diagnostic snapshot -- "what did the most recent
/// evaluation of this specific Edge conclude" -- not itself the Freshness
/// authority (see module docs, and [`write_consumer_freshness_in_tx`]).
/// Re-running an evaluation for the same `edge_id` overwrites this row in
/// place rather than accumulating history; history of *why* an Edge went
/// stale lives in `narrative_maintenance_finding_observations`
/// (`finding_observation.rs`, Lane C) instead.
///
/// Callers own the surrounding `BEGIN`/`COMMIT`.
pub(crate) fn write_edge_state_in_tx(
    conn: &Connection,
    project_id: &str,
    edge_id: &str,
    observation: &EdgeObservation,
    semantic_epoch_id: &str,
    evaluated_at: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!edge_id.trim().is_empty(), "edgeId is required");
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(!evaluated_at.trim().is_empty(), "evaluatedAt is required");

    ensure_edge_belongs_to_project(conn, project_id, edge_id)?;
    ensure_epoch_belongs_to_project(conn, project_id, semantic_epoch_id)?;
    write_validated_edge_state_in_tx(
        conn,
        project_id,
        edge_id,
        observation,
        semantic_epoch_id,
        evaluated_at,
    )
}

// Private to this owner: callers either validate the individual Edge or the
// exact complete Consumer Edge set in the same transaction. No validation
// capability escapes the call, and every row retains its invalidation hook.
fn write_validated_edge_state_in_tx(
    conn: &Connection,
    project_id: &str,
    edge_id: &str,
    observation: &EdgeObservation,
    semantic_epoch_id: &str,
    evaluated_at: &str,
) -> anyhow::Result<()> {
    super::nir1_chronicle_index::invalidate::before_edge_state_write(
        conn,
        project_id,
        edge_id,
        observation.freshness.as_str(),
        observation.reason_code.map(FindingReasonCode::as_str),
        observation.build_action.as_str(),
        semantic_epoch_id,
    )?;

    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(edge_id) DO UPDATE SET
             evidence_freshness = excluded.evidence_freshness,
             reason_code = excluded.reason_code,
             build_action = excluded.build_action,
             evaluated_at_epoch_id = excluded.evaluated_at_epoch_id,
             evaluated_at = excluded.evaluated_at",
        params![
            edge_id,
            project_id,
            observation.freshness.as_str(),
            observation.reason_code.map(FindingReasonCode::as_str),
            observation.build_action.as_str(),
            semantic_epoch_id,
            evaluated_at,
        ],
    )?;
    Ok(())
}

/// Upsert one Consumer's current Freshness row into
/// `narrative_consumer_freshness` (PK `(project_id, consumer_kind,
/// consumer_key)`) -- **the** durable Freshness authority (see module
/// docs). Callers publishing an evaluation across several Edges for the
/// same Consumer are expected to have already reduced those Edges'
/// individual `EdgeObservation`s down to the single worst one (see
/// [`publish_freshness_evaluation_in_tx`]'s `freshness_severity_rank`) and
/// pass that here; this function itself has no visibility into any other
/// Edge and performs no such reduction.
///
/// `last_evaluated_run_id` is nullable in the schema (a Consumer may have a
/// Freshness row seeded by something other than a Run, e.g. legacy
/// backfill) and is written exactly as passed, `None` included.
///
/// `dependency_set_digest` (SCHEMA 24, nullable) is the digest of the
/// identity set this Consumer currently depends on -- see
/// [`consumer_dependency_set_digest`]. `None` writes SQL `NULL`, which the
/// Consumer Contract defines as "not yet evaluated", never as "no
/// dependencies" and never as an inconsistency: every workspace migrated
/// from before Gate C2-2 has NULL here and is not thereby broken.
///
/// Callers own the surrounding `BEGIN`/`COMMIT`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_consumer_freshness_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    observation: &EdgeObservation,
    semantic_epoch_id: &str,
    last_evaluated_run_id: Option<&str>,
    dependency_set_digest: Option<&str>,
    updated_at: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    validate_consumer_identity(consumer_kind, consumer_key)?;
    ensure_generic_freshness_target(conn, project_id, consumer_kind, consumer_key)?;
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(!updated_at.trim().is_empty(), "updatedAt is required");

    ensure_epoch_belongs_to_project(conn, project_id, semantic_epoch_id)?;

    super::nir1_chronicle_index::invalidate::before_consumer_state_write(
        conn,
        project_id,
        consumer_kind,
        consumer_key,
        observation.freshness.as_str(),
        observation.build_action.as_str(),
        semantic_epoch_id,
        last_evaluated_run_id,
        dependency_set_digest,
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
             semantic_epoch_id, last_evaluated_run_id, dependency_set_digest, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(project_id, consumer_kind, consumer_key) DO UPDATE SET
             evidence_freshness = excluded.evidence_freshness,
             build_action = excluded.build_action,
             semantic_epoch_id = excluded.semantic_epoch_id,
             last_evaluated_run_id = excluded.last_evaluated_run_id,
             dependency_set_digest = excluded.dependency_set_digest,
             updated_at = excluded.updated_at",
        params![
            project_id,
            consumer_kind,
            consumer_key,
            observation.freshness.as_str(),
            observation.build_action.as_str(),
            semantic_epoch_id,
            last_evaluated_run_id,
            dependency_set_digest,
            updated_at,
        ],
    )?;
    Ok(())
}

/// Seed a declared Consumer whose operation wrote no Source mutation.
///
/// An idempotent `temporal.node.ensure` still owns a real Application and
/// Generic Edge, but `change_feed::events_from_journal_entities` deliberately
/// omits its `ensure-existing` journal entity.  This owner-level seed keeps
/// the Consumer visible to the canonical read without inventing a Feed event:
/// every declared Edge receives the ratified `Unknown`/`Manual` state, and
/// the Generic Consumer row is written with the current dependency digest.
/// A later real Source mutation re-enters the normal incremental evaluator.
///
/// Callers own the surrounding transaction.  This is the only writer path
/// for this conservative initialization; callers must not issue raw SQL for
/// either Generic Freshness table.
pub(crate) fn seed_consumer_freshness_unknown_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    edge_ids: &[String],
    semantic_epoch_id: &str,
    updated_at: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Publish Runtime requires a caller-owned transaction"
    );
    anyhow::ensure!(
        !edge_ids.is_empty(),
        "NEX_PUBLISH_RUNTIME_NO_EDGES: at least one declared Edge is required to seed Generic Freshness"
    );
    ensure_generic_freshness_target(conn, project_id, consumer_kind, consumer_key)?;
    let observation = unknown_edge_observation();
    for edge_id in edge_ids {
        write_edge_state_in_tx(
            conn,
            project_id,
            edge_id,
            &observation,
            semantic_epoch_id,
            updated_at,
        )?;
    }
    let dependency_set_digest =
        consumer_dependency_set_digest(conn, project_id, consumer_kind, consumer_key)?;
    write_consumer_freshness_in_tx(
        conn,
        project_id,
        consumer_kind,
        consumer_key,
        &observation,
        semantic_epoch_id,
        None,
        Some(&dependency_set_digest),
        updated_at,
    )?;
    Ok(())
}

/// Publish a complete Consumer Freshness result without associating it with a
/// Run. The supplied Edge set must be the exact current declaration for this
/// Consumer; otherwise a partial result could overwrite the Consumer's
/// whole-set Freshness with an incomplete dependency digest.
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_complete_runless_freshness_in_tx(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    edges_and_observations: &[(String, EdgeObservation)],
    semantic_epoch_id: &str,
    now: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Publish Runtime requires a caller-owned transaction"
    );
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    validate_consumer_identity(consumer_kind, consumer_key)?;
    ensure_generic_freshness_target(conn, project_id, consumer_kind, consumer_key)?;
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(!now.trim().is_empty(), "now is required");
    anyhow::ensure!(
        !edges_and_observations.is_empty(),
        "NEX_PUBLISH_RUNTIME_NO_EDGES: at least one edge observation is required to publish a complete Consumer Freshness result"
    );

    ensure_epoch_belongs_to_project(conn, project_id, semantic_epoch_id)?;
    let current_epoch_id = super::semantic_epoch::get_current_epoch(conn, project_id)?
        .map(|epoch| epoch.id)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PUBLISH_RUNTIME_STALE_EPOCH: project '{project_id}' has no current semantic epoch"
            )
        })?;
    anyhow::ensure!(
        current_epoch_id == semantic_epoch_id,
        "NEX_PUBLISH_RUNTIME_STALE_EPOCH: semantic epoch '{semantic_epoch_id}' is not current for project '{project_id}' (current '{current_epoch_id}')"
    );

    let mut statement = conn.prepare(
        "SELECT id
           FROM narrative_dependency_edges
          WHERE project_id = ?1
            AND consumer_kind = ?2
            AND consumer_key = ?3
          ORDER BY id ASC",
    )?;
    let stored_edge_ids = statement
        .query_map(params![project_id, consumer_kind, consumer_key], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let provided_edge_ids = edges_and_observations
        .iter()
        .map(|(edge_id, _)| edge_id.clone())
        .collect::<HashSet<_>>();
    let stored_edge_id_set = stored_edge_ids.iter().cloned().collect::<HashSet<_>>();
    let edge_set_mismatch = provided_edge_ids.len() != edges_and_observations.len()
        || provided_edge_ids != stored_edge_id_set
        || edges_and_observations
            .iter()
            .any(|(edge_id, _)| edge_id.trim().is_empty())
        || stored_edge_ids
            .iter()
            .any(|edge_id| edge_id.trim().is_empty());
    anyhow::ensure!(
        !edge_set_mismatch,
        "NEX_PUBLISH_RUNTIME_RUNLESS_EDGE_SET_MISMATCH: observations must contain each declared dependency edge exactly once for consumer '{consumer_kind}:{consumer_key}'"
    );

    // The target/epoch guards and exact set comparison above cover every
    // stored Edge's ownership. This loop changes only states (plus the normal
    // invalidation hook), never declarations, Edge identities, or the epoch.
    for (edge_id, observation) in edges_and_observations {
        write_validated_edge_state_in_tx(
            conn,
            project_id,
            edge_id,
            observation,
            semantic_epoch_id,
            now,
        )?;
    }

    let worst = worst_edge_state_for_consumer(
        conn,
        project_id,
        consumer_kind,
        consumer_key,
        semantic_epoch_id,
    )?
    .ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_PUBLISH_RUNTIME_NO_EDGE_STATE: no Edge State at epoch '{semantic_epoch_id}' for complete Consumer Freshness publish"
        )
    })?;
    let dependency_set_digest =
        consumer_dependency_set_digest(conn, project_id, consumer_kind, consumer_key)?;
    write_consumer_freshness_in_tx(
        conn,
        project_id,
        consumer_kind,
        consumer_key,
        &worst,
        semantic_epoch_id,
        None,
        Some(&dependency_set_digest),
        now,
    )?;

    Ok(())
}

/// The worst stored Edge State across every Edge this Consumer declares,
/// restricted to the current Semantic Epoch.
///
/// The epoch restriction is what makes reading state back safe rather than
/// merely convenient. `narrative_dependency_edge_states` is keyed by
/// `edge_id` alone and survives an Epoch rotation, so without the filter a
/// row evaluated under a superseded Epoch -- exactly the rows
/// `restore_rebuild`'s Verify reports as
/// `edge_state_ids_outside_current_epoch` -- would be rolled into the
/// Consumer's *current* Freshness. The caller has just written a row at
/// `semantic_epoch_id` for every Edge outcome it received. A declared Edge
/// with no state in this Epoch remains in scope and contributes `Unknown`,
/// as detailed below.
///
/// Ordering is `source_object_identity` then `edge_id`, which is the order
/// `dependency_edges::find_edges_by_consumer` returns Edges in. Combined
/// with the strict `>` below that reproduces the previous
/// reduce-over-the-argument behaviour exactly for the whole-Consumer
/// publish every caller performs today: same winner, same
/// `build_action`, including on a tie between two equally-bad Edges (see
/// `freshness_severity_rank`'s note on ties).
///
/// An Edge the Consumer declares but that has *no* state in this Epoch is
/// `Unknown`, not absent. Dropping it would be a false PASS, and a loud one:
/// the same publish stamps a `dependency_set_digest` computed over every
/// Edge, so the stored row would claim "evaluated against this whole
/// dependency set, and clean" about a set it had not finished evaluating.
/// `Unknown` already means "Freshness could not be determined" and already
/// outranks `Stale`, so this is the value the vocabulary reserves for it.
///
/// That is why the join is a LEFT JOIN from the Edges rather than an INNER
/// JOIN from the states. The INNER JOIN made "not evaluated yet" and "has no
/// Edge" the same query result, and only the second is a reason to contribute
/// nothing.
///
/// Returns `None` only when the Consumer declares no Edges at all.
pub(crate) fn worst_edge_state_for_consumer(
    conn: &Connection,
    project_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<Option<EdgeObservation>> {
    let mut statement = conn.prepare(
        "SELECT s.evidence_freshness, s.reason_code, s.build_action
           FROM narrative_dependency_edges e
           LEFT JOIN narrative_dependency_edge_states s
             ON s.edge_id = e.id
            AND s.evaluated_at_epoch_id = ?4
          WHERE e.project_id = ?1
            AND e.consumer_kind = ?2
            AND e.consumer_key = ?3
          ORDER BY e.source_object_identity ASC, e.id ASC",
    )?;
    let rows = statement
        .query_map(
            params![project_id, consumer_kind, consumer_key, semantic_epoch_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut worst: Option<(u8, EdgeObservation)> = None;
    for (freshness, reason_code, build_action) in rows {
        let observation = match (freshness, build_action) {
            // Fail closed on a value outside the ratified vocabulary rather
            // than rank it as something it is not --
            // `EvidenceFreshness::try_from` is the same gate `evaluator.rs`
            // applies on the way in.
            (Some(freshness), Some(build_action)) => EdgeObservation {
                freshness: EvidenceFreshness::try_from(freshness.as_str())?,
                reason_code: reason_code
                    .as_deref()
                    .map(FindingReasonCode::try_from)
                    .transpose()?,
                build_action: BuildAction::try_from(build_action.as_str())?,
            },
            // Declared but not evaluated in this Epoch. `Manual` rather than
            // `None`, because "nothing to do" is precisely what is not known.
            _ => EdgeObservation {
                freshness: EvidenceFreshness::Unknown,
                reason_code: None,
                build_action: BuildAction::Manual,
            },
        };
        let rank = freshness_severity_rank(observation.freshness);
        if worst.as_ref().is_none_or(|(best, _)| rank > *best) {
            worst = Some((rank, observation));
        }
    }
    Ok(worst.map(|(_, observation)| observation))
}

/// Severity rank used to pick the single worst Freshness value across a
/// Consumer's Edges for the one `narrative_consumer_freshness` row
/// [`publish_freshness_evaluation_in_tx`] writes. Higher is worse. This is
/// a design decision -- ADR 005's Amendment fixes the six Freshness values,
/// not their relative severity for a multi-Edge Consumer rollup -- recorded
/// here:
///
/// 1. `SourceMissing` (5, worst) -- data is gone; unrecoverable without a
///    human decision (`BuildAction::Manual`). Nothing ranks worse: there is
///    no dependency left to reconcile at all.
/// 2. `Unknown` (4) -- Freshness could not even be determined (normalizer/
///    component incompatibility, `evaluator::evaluate_edge` branches 2-3).
///    This ranks above every *determinate* bad state because it blocks
///    judgment entirely: the Consumer might be Stale, might be Fresh, and
///    nothing here can tell without a recompile/resolve pass first.
/// 3. `ReadSetDrift` / `AnchorMismatch` (3, tied) -- the Consumer's
///    dependency *identity* itself moved (what it reads, or where its
///    anchor resolves), not just the Source's content. This is a more
///    fundamental break than ordinary staleness: the Consumer may be
///    reading the wrong thing entirely, not an outdated version of the
///    right thing.
/// 4. `Stale` (2) -- the Source materially changed under an otherwise
///    intact dependency. Serious, but well understood:
///    `BuildAction::RebuildRequired` is a direct, mechanical fix.
/// 5. `Fresh` (1, best) -- nothing to reconcile.
///
/// Ties (e.g. two Edges both Stale) keep the *first* Edge encountered in
/// caller-supplied order -- see the strict `>` comparison in
/// [`publish_freshness_evaluation_in_tx`], not `>=`.
fn freshness_severity_rank(freshness: EvidenceFreshness) -> u8 {
    match freshness {
        EvidenceFreshness::SourceMissing => 5,
        EvidenceFreshness::Unknown => 4,
        EvidenceFreshness::ReadSetDrift | EvidenceFreshness::AnchorMismatch => 3,
        EvidenceFreshness::Stale => 2,
        EvidenceFreshness::Fresh => 1,
    }
}

/// Material basis excludes Run, Semantic Epoch, and wall-clock context while
/// retaining the durable Edge result that determines whether a disposition
/// still applies. Observation digest remains a separate, richer domain.
fn edge_material_basis_digest(
    edge_id: &str,
    observation: &EdgeObservation,
) -> anyhow::Result<String> {
    material_basis_digest(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        &MaterialBasisInput {
            stable_subject: edge_id,
            edge_id: Some(edge_id),
            failure_code: None,
            reason_code: observation
                .reason_code
                .map(FindingReasonCode::as_str)
                .unwrap_or(""),
            evidence_freshness: observation.freshness.as_str(),
            evidence_detail_digest: None,
        },
    )
}

fn edge_finding_identity(edge_id: &str) -> anyhow::Result<String> {
    stable_finding_identity(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        edge_id,
    )
}

fn edge_observation_digest(edge_id: &str, observation: &EdgeObservation) -> anyhow::Result<String> {
    observation_digest(
        BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
        &ObservationDigestInput {
            stable_subject: edge_id,
            edge_id: Some(edge_id),
            failure_code: None,
            reason_code: observation
                .reason_code
                .map(FindingReasonCode::as_str)
                .unwrap_or(""),
            evidence_freshness: observation.freshness.as_str(),
            evidence_detail_digest: None,
        },
    )
}

/// Fail-closed CAS precondition for [`publish_freshness_evaluation_in_tx`]:
/// proves, in one query, that the reservation this publish is about to act
/// on is still the live one, and that the Run's own Semantic Epoch is still
/// the project's *current* Epoch. A Run that reserved a range under an
/// Epoch that a Restore/rebuild has since rotated past must never be
/// allowed to publish — its `EdgeObservation`s were computed against a
/// generation of the Durable Graph that no longer exists, and an
/// unconditional write would silently overwrite whatever a fresher Run
/// (reserved against the new Epoch) has already published or is about to.
///
/// Checks, all in a single `SELECT EXISTS`:
/// - the Run exists, belongs to `project_id`, is still `running`, and its
///   `semantic_epoch_id` equals `semantic_epoch_id`;
/// - the cursor row for `(project_id, consumer_id)` is still reserved for
///   exactly this Run (`active_run_id = run.id`), at the same Epoch
///   (`semantic_epoch_id = run.semantic_epoch_id`), through exactly
///   `through_sequence`;
/// - that Epoch is still `project_id`'s current one (highest
///   `epoch_number`).
///
/// Any single mismatch — a stale Epoch, a reservation another Run has since
/// taken over, a Run no longer `running`, a `through_sequence` that no
/// longer matches — fails the whole check without distinguishing which
/// condition failed. Belt-and-suspenders with
/// [`acknowledge_cursor_reservation_in_tx`]'s own full-`WHERE` `UPDATE`:
/// this is the up-front check before any write happens; that function's
/// `WHERE` is the final authority at write time.
pub(crate) fn verify_publish_reservation_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    consumer_id: &str,
    semantic_epoch_id: &str,
    through_sequence: i64,
) -> anyhow::Result<()> {
    let verified: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM narrative_extraction_runs r
              JOIN narrative_change_cursors c ON c.project_id = r.project_id
             WHERE r.id = ?1
               AND r.project_id = ?2
               AND r.semantic_epoch_id = ?3
               AND r.status = 'running'
               AND c.consumer_id = ?4
               AND c.active_run_id = r.id
               AND c.semantic_epoch_id = r.semantic_epoch_id
               AND c.reserved_through_sequence = ?5
               AND r.semantic_epoch_id = (
                 SELECT id FROM narrative_semantic_epochs
                  WHERE project_id = ?2
                  ORDER BY epoch_number DESC
                  LIMIT 1
               )
         )",
        params![
            run_id,
            project_id,
            semantic_epoch_id,
            consumer_id,
            through_sequence,
        ],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        verified,
        "NEX_PUBLISH_RUNTIME_STALE_RESERVATION: run '{run_id}' for consumer '{consumer_id}' in \
         project '{project_id}' is no longer a live reservation at epoch \
         '{semantic_epoch_id}' through sequence {through_sequence} -- the Semantic Epoch has \
         rotated, the reservation has been superseded, or the run is no longer running"
    );
    Ok(())
}

/// Publish the outcome of one Freshness-evaluation Run for one Consumer,
/// across every Edge that Run evaluated, as a single integrated write
/// inside the caller's own transaction. In fixed order:
///
/// a. [`verify_publish_reservation_in_tx`] -- fail-closed CAS precondition:
///    the Run must still be `running`, its own Semantic Epoch must still be
///    `project_id`'s current one, and the cursor's reservation must still
///    be exactly this Run's, at that Epoch, through `through_sequence`. A
///    Run that lost the race against a Semantic Epoch rotation (or a
///    second Run reserving the same range) is rejected here, before step
///    (b) writes anything.
/// b. [`write_edge_state_in_tx`] for every `(edge_id, observation)` pair.
/// c. [`write_consumer_freshness_in_tx`] exactly once, with the single
///    worst Freshness across all of `edges_and_observations`
///    (`freshness_severity_rank`) as the Consumer's rolled-up current
///    value.
/// d. [`record_finding_observation_in_tx`] for every Edge whose
///    `observation.reason_code` is `Some`. A Fresh Edge, or a synthetic
///    `Unknown` with no registered explanation, has `reason_code: None`
///    and produces no Finding.
/// e. [`transition_run_status_in_tx`] to `Completed`.
/// f. [`acknowledge_cursor_reservation_in_tx`] through `through_sequence`,
///    releasing the Change Feed cursor reservation this Run held -- itself
///    re-checking the same reservation identity in its own `UPDATE ...
///    WHERE`, so a race landing between step (a)'s check and this step
///    still fails closed rather than silently no-op-ing.
///
/// Requires `edges_and_observations` to be non-empty: with zero Edges
/// there is no basis to pick a worst Freshness for step (c), and a Run
/// that evaluated nothing has nothing to Publish -- the caller should not
/// invoke this function at all in that case, rather than let it invent a
/// value.
///
/// Like every other `_in_tx` helper in this crate, this does not open or
/// close the transaction itself -- but unlike most of them (mirroring
/// `cursor_reservation.rs`'s own mutating functions), it requires one to
/// already be open: running the six steps above under autocommit would
/// let each individually commit, so a mid-sequence failure could leave
/// durable state committed with no matching Run completion or cursor
/// advance.
/// Gate C2-1's multi-Consumer Change Feed runtime composes the narrower
/// `publish_freshness_evaluation_edges_only_in_tx` itself, then completes one
/// Run and performs one acknowledgement after every affected Consumer. This
/// single-Consumer wrapper remains available for callers whose range resolves
/// to exactly one Consumer.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_freshness_evaluation_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    consumer_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    edges_and_observations: &[(String, EdgeObservation)],
    semantic_epoch_id: &str,
    through_sequence: i64,
    now: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Publish Runtime requires a caller-owned transaction"
    );
    anyhow::ensure!(!consumer_id.trim().is_empty(), "consumerId is required");

    // a. Fail-closed CAS precondition -- before any write happens.
    verify_publish_reservation_in_tx(
        conn,
        project_id,
        run_id,
        consumer_id,
        semantic_epoch_id,
        through_sequence,
    )?;

    // b-d. Edge State / Consumer Freshness / Finding Observation writes.
    publish_freshness_evaluation_edges_only_in_tx(
        conn,
        project_id,
        run_id,
        consumer_kind,
        consumer_key,
        edges_and_observations,
        semantic_epoch_id,
        now,
    )?;

    // e. Complete the Run.
    transition_run_status_in_tx(conn, run_id, NarrativeRunStatus::Completed)?;

    // f. Release the Change Feed cursor reservation this Run held -- the
    //    same reservation identity checked again, at write time.
    acknowledge_cursor_reservation_in_tx(
        conn,
        project_id,
        consumer_id,
        run_id,
        semantic_epoch_id,
        through_sequence,
    )?;

    Ok(())
}

/// Steps (a)-(c) of [`publish_freshness_evaluation_in_tx`]'s doc comment,
/// factored out so a caller that has no Change Feed cursor reservation to
/// acknowledge and no single `run_id` it should mark `Completed` as a side
/// effect of publishing (`dependency-rebuild-derived`'s orchestrator,
/// evaluating every Edge across every Consumer in one Run rather than one
/// cursor-triggered Consumer) can reuse the per-Edge/per-Consumer publish
/// logic without also inheriting the live cursor-based flow's (d)/(e)
/// steps. `publish_freshness_evaluation_in_tx` above is now a thin wrapper
/// adding those two steps for that flow.
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_freshness_evaluation_edges_only_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    consumer_kind: &str,
    consumer_key: &str,
    edges_and_observations: &[(String, EdgeObservation)],
    semantic_epoch_id: &str,
    now: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "Narrative Publish Runtime requires a caller-owned transaction"
    );
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!run_id.trim().is_empty(), "runId is required");
    anyhow::ensure!(!consumer_kind.trim().is_empty(), "consumerKind is required");
    anyhow::ensure!(!consumer_key.trim().is_empty(), "consumerKey is required");
    ensure_generic_freshness_target(conn, project_id, consumer_kind, consumer_key)?;
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    anyhow::ensure!(!now.trim().is_empty(), "now is required");
    anyhow::ensure!(
        !edges_and_observations.is_empty(),
        "NEX_PUBLISH_RUNTIME_NO_EDGES: at least one edge observation is required to publish \
         a Freshness evaluation"
    );

    // a. Per-Edge diagnostic snapshot, one row each.
    for (edge_id, observation) in edges_and_observations {
        write_edge_state_in_tx(
            conn,
            project_id,
            edge_id,
            observation,
            semantic_epoch_id,
            now,
        )?;
    }

    // b. The single worst Freshness across the Consumer's Edges becomes its
    //    rolled-up current value -- read back from the Edge States just
    //    written, *not* reduced over `edges_and_observations`.
    //
    //    The difference only shows when a caller publishes a subset of a
    //    Consumer's Edges, and then it is the whole point. Reducing over the
    //    argument would let a partial publish overwrite the Consumer row
    //    using only the Edges in hand, so an Edge that went `stale` in an
    //    earlier publish and was not re-evaluated in this one would simply
    //    stop counting and the Consumer would roll back to `fresh` while its
    //    own Edge State still said otherwise. No caller does that today
    //    (`restore_rebuild`'s Rebuild-Derived orchestrator passes every Edge
    //    `find_edges_by_consumer` returns), which is exactly why it was safe
    //    -- and exactly why Gate C2-1's Change-Feed-driven incremental
    //    evaluation, whose reason for existing is to re-evaluate only the
    //    Edges a Source change touched, must not inherit it.
    let worst = worst_edge_state_for_consumer(
        conn,
        project_id,
        consumer_kind,
        consumer_key,
        semantic_epoch_id,
    )?
    .ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_PUBLISH_RUNTIME_NO_EDGE_STATE: no Edge State at epoch '{semantic_epoch_id}' \
             for consumer '{consumer_kind}:{consumer_key}' after writing {} of them",
            edges_and_observations.len()
        )
    })?;
    write_consumer_freshness_in_tx(
        conn,
        project_id,
        consumer_kind,
        consumer_key,
        &worst,
        semantic_epoch_id,
        Some(run_id),
        Some(&consumer_dependency_set_digest(
            conn,
            project_id,
            consumer_kind,
            consumer_key,
        )?),
        now,
    )?;

    // c. One Finding Observation per Edge with something to explain, plus an
    // explicit lifecycle record for every stable Finding that transitions to
    // or from an active condition. Freshness remains owned by the table above.
    for (edge_id, observation) in edges_and_observations {
        let finding_key = consumer_finding_key(consumer_kind, consumer_key);
        let finding_identity = edge_finding_identity(edge_id)?;
        let material_basis_digest = edge_material_basis_digest(edge_id, observation)?;
        let previous = latest_finding_lifecycle_for_identity(conn, project_id, &finding_identity)?;

        if let Some(reason_code) = observation.reason_code {
            let observation_digest = edge_observation_digest(edge_id, observation)?;
            let lifecycle_state = match previous.as_ref() {
                None => FindingLifecycleState::New,
                Some(row) if row.state == FindingLifecycleState::Resolved => {
                    FindingLifecycleState::New
                }
                Some(row)
                    if row.observation_digest.as_deref() == Some(observation_digest.as_str()) =>
                {
                    FindingLifecycleState::Recurring
                }
                Some(_) => FindingLifecycleState::Changed,
            };
            record_finding_observation_with_identity_in_tx(
                conn,
                FindingObservationWrite {
                    project_id,
                    run_id,
                    semantic_epoch_id,
                    edge_id: Some(edge_id.as_str()),
                    finding_key: &finding_key,
                    finding_identity: &finding_identity,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    reason_code,
                    evidence_freshness_snapshot: observation.freshness,
                    observation_digest: &observation_digest,
                    material_basis_digest: &material_basis_digest,
                    observed_at: now,
                },
            )?;
            record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    project_id,
                    finding_identity: &finding_identity,
                    finding_key: &finding_key,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    state: lifecycle_state,
                    observation_digest: Some(&observation_digest),
                    material_basis_digest: Some(&material_basis_digest),
                    run_id,
                    semantic_epoch_id,
                    observed_at: now,
                },
            )?;
        } else if previous
            .as_ref()
            .is_some_and(|row| row.state != FindingLifecycleState::Resolved)
        {
            // A fresh evaluation closes the prior Finding explicitly. The
            // resolved row has no observation digest because it represents
            // absence of a reason, not a new diagnostic finding. Keep the
            // prior Finding's basis as the durable evidence anchor; the
            // lifecycle writer verifies that it belongs to an exact prior
            // Observation rather than accepting a caller-supplied digest.
            let resolved_material_basis_digest = previous
                .as_ref()
                .and_then(|row| row.material_basis_digest.as_deref())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_PUBLISH_RUNTIME_RESOLVED_EVIDENCE_MISSING: active Finding has no material basis"
                    )
                })?;
            record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    project_id,
                    finding_identity: &finding_identity,
                    finding_key: &finding_key,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    state: FindingLifecycleState::Resolved,
                    observation_digest: None,
                    material_basis_digest: Some(resolved_material_basis_digest),
                    run_id,
                    semantic_epoch_id,
                    observed_at: now,
                },
            )?;
        }
    }

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::narrative_extraction::attention::{
        get_attention, is_attention_applicable, set_attention_in_tx, AttentionDisposition,
        SetAttentionRequest,
    };
    use crate::narrative_extraction::cursor_reservation::{
        release_cursor_reservation_in_tx, reserve_cursor_range_in_tx,
    };
    use crate::narrative_extraction::dependency_edges::{
        record_dependency_edge_in_tx, RUN_CONSUMER_KIND,
    };
    use crate::narrative_extraction::evaluator::BuildAction;
    use crate::narrative_extraction::finding_observation::{
        list_finding_lifecycle_for_identity, FindingLifecycleState,
    };
    use crate::narrative_extraction::semantic_epoch::create_epoch_in_tx;
    use crate::narrative_extraction::semantic_index_diagnostics::compute_dependency_set_digest;
    use crate::narrative_extraction::task_leases::with_immediate_transaction;
    use crate::Database;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_test_db(db)
    }

    fn current_schema_test_db() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        seed_test_db(db)
    }

    fn seed_test_db(db: Database) -> Database {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Other Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed projects");
        db
    }

    fn seed_epoch(conn: &Connection, project_id: &str) -> String {
        create_epoch_in_tx(conn, project_id, "initial", None).expect("create epoch")
    }

    /// `epoch_id` seeds the Run's own `semantic_epoch_id` column, exactly
    /// as [`create_system_run_in_tx`](super::super::repository::create_system_run_in_tx)
    /// stamps it at real creation time -- [`verify_publish_reservation_in_tx`]
    /// requires this to match the reservation's epoch, so every test Run
    /// needs a real one, not `NULL`.
    fn seed_run(conn: &Connection, run_id: &str, project_id: &str, epoch_id: &str) {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, version, semantic_epoch_id)
             VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', 'digest-1',
                     'running', '{}', datetime('now'), 0, ?3)",
            params![run_id, project_id, epoch_id],
        )
        .expect("insert run");
    }

    fn seed_cursor(conn: &Connection, project_id: &str, consumer_id: &str) {
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence, updated_at)
             VALUES (?1, ?2, 0, '2026-08-15T00:00:00.000Z')",
            params![project_id, consumer_id],
        )
        .expect("insert cursor");
    }

    /// Reserves `[0, through_sequence]` for `run_id` at `epoch_id`, in its
    /// own transaction -- the precondition every real publish call must
    /// satisfy now that [`verify_publish_reservation_in_tx`] checks it.
    fn reserve_cursor(
        conn: &Connection,
        project_id: &str,
        consumer_id: &str,
        epoch_id: &str,
        run_id: &str,
        through_sequence: i64,
    ) {
        with_immediate_transaction(conn, |conn| {
            reserve_cursor_range_in_tx(
                conn,
                project_id,
                consumer_id,
                epoch_id,
                run_id,
                through_sequence,
            )
        })
        .expect("reserve cursor range");
    }

    fn seed_edge(
        conn: &Connection,
        project_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
        source_object_identity: &str,
    ) -> String {
        record_dependency_edge_in_tx(
            conn,
            project_id,
            consumer_kind,
            consumer_key,
            source_object_identity,
            r#"["/body"]"#,
            None,
            None,
            "2026-08-15T00:00:00.000Z",
        )
        .expect("record edge")
    }

    fn consumer_freshness_value(conn: &Connection, consumer_key: &str) -> String {
        consumer_freshness_value_for(conn, RUN_CONSUMER_KIND, consumer_key)
    }

    fn consumer_freshness_value_for(
        conn: &Connection,
        consumer_kind: &str,
        consumer_key: &str,
    ) -> String {
        conn.query_row(
            "SELECT evidence_freshness FROM narrative_consumer_freshness
              WHERE project_id = 'project-1' AND consumer_kind = ?1 AND consumer_key = ?2",
            params![consumer_kind, consumer_key],
            |row| row.get(0),
        )
        .expect("consumer freshness row")
    }

    fn stored_dependency_set_digest(conn: &Connection, consumer_key: &str) -> Option<String> {
        conn.query_row(
            "SELECT dependency_set_digest FROM narrative_consumer_freshness
              WHERE project_id = 'project-1' AND consumer_kind = ?1 AND consumer_key = ?2",
            params![RUN_CONSUMER_KIND, consumer_key],
            |row| row.get(0),
        )
        .expect("consumer freshness row")
    }

    fn fresh() -> EdgeObservation {
        EdgeObservation {
            freshness: EvidenceFreshness::Fresh,
            reason_code: None,
            build_action: BuildAction::None,
        }
    }

    fn stale() -> EdgeObservation {
        EdgeObservation {
            freshness: EvidenceFreshness::Stale,
            reason_code: Some(FindingReasonCode::SourceRevisionChanged),
            build_action: BuildAction::RebuildRequired,
        }
    }

    fn source_missing() -> EdgeObservation {
        EdgeObservation {
            freshness: EvidenceFreshness::SourceMissing,
            reason_code: Some(FindingReasonCode::SourceMissing),
            build_action: BuildAction::Manual,
        }
    }

    fn finding_count(conn: &Connection, project_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .expect("count findings")
    }

    #[test]
    fn complete_runless_publication_rejects_inexact_sets_before_any_state_write() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let epoch = seed_epoch(&tx, "project-1");
            let foreign_epoch = seed_epoch(&tx, "project-2");
            let first = seed_edge(&tx, "project-1", RUN_CONSUMER_KIND, "one", "scene:first");
            let second = seed_edge(&tx, "project-1", RUN_CONSUMER_KIND, "one", "scene:second");
            let other = seed_edge(&tx, "project-1", RUN_CONSUMER_KIND, "other", "scene:other");
            let foreign = seed_edge(&tx, "project-2", RUN_CONSUMER_KIND, "one", "scene:foreign");
            for ids in [
                vec![first.clone()],
                vec![first.clone(), first.clone()],
                vec![first.clone(), other],
                vec![first.clone(), foreign],
                vec![first.clone(), second.clone(), "absent".into()],
            ] {
                let values = ids.into_iter().map(|id| (id, fresh())).collect::<Vec<_>>();
                let before = tx.total_changes();
                let error = publish_complete_runless_freshness_in_tx(
                    &tx, "project-1", RUN_CONSUMER_KIND, "one", &values, &epoch,
                    "2026-09-08T00:00:00.000Z",
                ).expect_err("only the exact complete Consumer may publish");
                assert!(error.to_string().contains("RUNLESS_EDGE_SET_MISMATCH"));
                assert_eq!(tx.total_changes(), before, "reject before any state write");
            }
            let values = vec![(first, fresh()), (second, stale())];
            let before = tx.total_changes();
            let error = publish_complete_runless_freshness_in_tx(
                &tx, "project-1", RUN_CONSUMER_KIND, "one", &values, &foreign_epoch,
                "2026-09-08T00:00:00.000Z",
            ).expect_err("foreign epoch must fail before the batch");
            assert!(error.to_string().contains("EPOCH_PROJECT_MISMATCH"));
            assert_eq!(tx.total_changes(), before);
            publish_complete_runless_freshness_in_tx(
                &tx, "project-1", RUN_CONSUMER_KIND, "one", &values, &epoch,
                "2026-09-08T00:00:00.000Z",
            )?;
            assert_eq!(consumer_freshness_value(&tx, "one"), "stale");
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states WHERE project_id='project-1'",
                [], |r| r.get(0),
            )?;
            assert_eq!(count, 2);
            Ok(())
        }).expect("complete batch identity and worst-result checks");
    }

    #[test]
    fn publisher_rejects_reserved_semantic_index_before_writing_generic_state() {
        let db = test_db();
        let edge_id = db
            .with_conn(|conn| {
                let edge_id = seed_edge(
                    conn,
                    "project-1",
                    "semantic-index",
                    "lexical",
                    "project:scene:scene-live",
                );
                let epoch_id = seed_epoch(conn, "project-1");
                conn.execute(
                    "INSERT INTO narrative_dependency_edge_states
                        (edge_id, project_id, evidence_freshness, reason_code, build_action,
                         evaluated_at_epoch_id, evaluated_at)
                     VALUES (?1, 'project-1', 'stale', 'source-revision-changed',
                             'rebuild-required', ?2, '2026-08-15T00:00:00.000Z')",
                    params![edge_id, epoch_id],
                )?;
                conn.execute(
                    "INSERT INTO narrative_consumer_freshness
                        (project_id, consumer_kind, consumer_key, evidence_freshness,
                         build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
                     VALUES ('project-1', 'semantic-index', 'lexical', 'stale',
                             'rebuild-required', ?1, 'previous-run', '2026-08-15T00:00:00.000Z')",
                    params![epoch_id],
                )?;
                Ok::<_, anyhow::Error>(edge_id)
            })
            .expect("seed reserved publisher fixture");

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    let epoch_id =
                        super::super::semantic_epoch::get_current_epoch(conn, "project-1")?
                            .ok_or_else(|| anyhow::anyhow!("fixture has no epoch"))?
                            .id;
                    publish_freshness_evaluation_edges_only_in_tx(
                        conn,
                        "project-1",
                        "semantic-index-rebuild-run",
                        "semantic-index",
                        "lexical",
                        &[(edge_id.clone(), stale())],
                        &epoch_id,
                        "2026-08-15T00:00:01.000Z",
                    )
                })
            })
            .expect_err("reserved Semantic Index must never enter the Generic publisher");
        assert!(
            error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_RESERVED_CONSUMER"),
            "unexpected reserved publisher rejection: {error:#}"
        );

        db.with_conn(|conn| {
            let edge_state: (String, Option<String>, String, String, String) = conn.query_row(
                "SELECT evidence_freshness, reason_code, build_action,
                        evaluated_at_epoch_id, evaluated_at
                   FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![edge_id],
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
            assert_eq!(
                edge_state,
                (
                    "stale".to_string(),
                    Some("source-revision-changed".to_string()),
                    "rebuild-required".to_string(),
                    conn.query_row(
                        "SELECT semantic_epoch_id FROM narrative_consumer_freshness
                          WHERE project_id = 'project-1' AND consumer_kind = 'semantic-index'
                            AND consumer_key = 'lexical'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?,
                    "2026-08-15T00:00:00.000Z".to_string(),
                )
            );
            let freshness: (String, String, Option<String>, String) = conn.query_row(
                "SELECT evidence_freshness, build_action, last_evaluated_run_id, updated_at
                   FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'semantic-index'
                    AND consumer_key = 'lexical'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                freshness,
                (
                    "stale".to_string(),
                    "rebuild-required".to_string(),
                    Some("previous-run".to_string()),
                    "2026-08-15T00:00:00.000Z".to_string(),
                )
            );
            assert_eq!(finding_count(conn, "project-1"), 0);
            Ok::<_, anyhow::Error>(())
        })
        .expect("reserved publisher rejection must leave state untouched");
    }

    #[test]
    fn production_publish_preserves_attention_on_harmless_epoch_rerun_and_tracks_material_changes()
    {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let consumer_id = "consumer-finding-identity";
            let consumer_key = "proposal-finding-identity";
            let edge_id = seed_edge(
                conn,
                "project-1",
                "proposal",
                consumer_key,
                "project:scene:scene-finding-identity",
            );
            seed_cursor(conn, "project-1", consumer_id);

            let epoch_one = seed_epoch(conn, "project-1");
            seed_run(conn, "run-finding-identity-1", "project-1", &epoch_one);
            reserve_cursor(
                conn,
                "project-1",
                consumer_id,
                &epoch_one,
                "run-finding-identity-1",
                1,
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-finding-identity-1",
                    consumer_id,
                    "proposal",
                    consumer_key,
                    &[(edge_id.clone(), stale())],
                    &epoch_one,
                    1,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;

            let first_material: String = conn.query_row(
                "SELECT material_basis_digest
                   FROM narrative_maintenance_finding_observations
                  WHERE project_id = 'project-1' AND edge_id = ?1",
                params![edge_id],
                |row| row.get(0),
            )?;
            set_attention_in_tx(
                conn,
                SetAttentionRequest {
                    project_id: "project-1",
                    finding_key: "proposal:proposal-finding-identity",
                    disposition: AttentionDisposition::Dismissed,
                    material_basis_digest: &first_material,
                    snoozed_until: None,
                    set_at: "2026-08-15T01:01:00.000Z",
                    actor_id: "author-1",
                    request_id: "request-finding-identity",
                    reason: None,
                    expected_version: 0,
                },
            )?;

            // A new Run in a new Semantic Epoch evaluates the same Edge and
            // the same durable condition. This calls the full production
            // writer, including reservation verification and completion.
            let epoch_two = seed_epoch(conn, "project-1");
            seed_run(conn, "run-finding-identity-2", "project-1", &epoch_two);
            reserve_cursor(
                conn,
                "project-1",
                consumer_id,
                &epoch_two,
                "run-finding-identity-2",
                2,
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-finding-identity-2",
                    consumer_id,
                    "proposal",
                    consumer_key,
                    &[(edge_id.clone(), stale())],
                    &epoch_two,
                    2,
                    "2026-08-15T02:00:00.000Z",
                )
            })?;

            let observation_rows: Vec<(String, String, String, String)> = conn
                .prepare(
                    "SELECT finding_identity, material_basis_digest, run_id,
                            semantic_epoch_id
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1' AND edge_id = ?1
                      ORDER BY rowid ASC",
                )?
                .query_map(params![edge_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(observation_rows.len(), 2);
            assert_eq!(observation_rows[0].0, observation_rows[1].0);
            assert_eq!(observation_rows[0].1, observation_rows[1].1);
            assert_eq!(observation_rows[0].2, "run-finding-identity-1");
            assert_eq!(observation_rows[1].2, "run-finding-identity-2");
            assert_ne!(observation_rows[0].3, observation_rows[1].3);

            let lifecycle =
                list_finding_lifecycle_for_identity(conn, "project-1", &observation_rows[0].0)?;
            assert_eq!(
                lifecycle.iter().map(|row| row.state).collect::<Vec<_>>(),
                vec![FindingLifecycleState::New, FindingLifecycleState::Recurring]
            );
            let attention = get_attention(conn, "project-1", "proposal:proposal-finding-identity")?
                .expect("Attention after harmless rerun");
            assert_eq!(
                attention.finding_identity.as_deref(),
                Some(observation_rows[0].0.as_str())
            );
            assert!(is_attention_applicable(
                &attention,
                &observation_rows[1].1,
                "2026-08-15T02:01:00.000Z"
            ));

            // A reason and Freshness change is a material change even though
            // the Edge identity remains stable. The disposition must stop
            // applying and lifecycle must become Changed.
            let epoch_three = seed_epoch(conn, "project-1");
            seed_run(conn, "run-finding-identity-3", "project-1", &epoch_three);
            reserve_cursor(
                conn,
                "project-1",
                consumer_id,
                &epoch_three,
                "run-finding-identity-3",
                3,
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-finding-identity-3",
                    consumer_id,
                    "proposal",
                    consumer_key,
                    &[(edge_id.clone(), source_missing())],
                    &epoch_three,
                    3,
                    "2026-08-15T03:00:00.000Z",
                )
            })?;
            let changed_material: String = conn.query_row(
                "SELECT material_basis_digest
                   FROM narrative_maintenance_finding_observations
                  WHERE project_id = 'project-1' AND edge_id = ?1
                  ORDER BY rowid DESC LIMIT 1",
                params![edge_id],
                |row| row.get(0),
            )?;
            assert_ne!(changed_material, first_material);
            let changed_lifecycle =
                list_finding_lifecycle_for_identity(conn, "project-1", &observation_rows[0].0)?;
            assert_eq!(changed_lifecycle[2].state, FindingLifecycleState::Changed);
            assert!(!is_attention_applicable(
                &attention,
                &changed_material,
                "2026-08-15T03:01:00.000Z"
            ));

            // A Fresh result emits no new Observation but closes the stable
            // Finding explicitly with a Resolved lifecycle record.
            let epoch_four = seed_epoch(conn, "project-1");
            seed_run(conn, "run-finding-identity-4", "project-1", &epoch_four);
            reserve_cursor(
                conn,
                "project-1",
                consumer_id,
                &epoch_four,
                "run-finding-identity-4",
                4,
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-finding-identity-4",
                    consumer_id,
                    "proposal",
                    consumer_key,
                    &[(edge_id.clone(), fresh())],
                    &epoch_four,
                    4,
                    "2026-08-15T04:00:00.000Z",
                )
            })?;
            let resolved_lifecycle =
                list_finding_lifecycle_for_identity(conn, "project-1", &observation_rows[0].0)?;
            assert_eq!(resolved_lifecycle.len(), 4);
            assert_eq!(resolved_lifecycle[3].state, FindingLifecycleState::Resolved);
            assert_eq!(
                consumer_freshness_value_for(conn, "proposal", consumer_key),
                "fresh"
            );
            Ok(())
        })
        .expect("production Finding identity lifecycle regression");
    }

    #[test]
    fn single_fresh_edge_publishes_state_and_freshness_without_a_finding_observation() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-1", 5);
            let edge_id = seed_edge(conn, "project-1", "proposal", "proposal-1", "project:scene:scene-1");

            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[(edge_id.clone(), fresh())],
                    &epoch_id,
                    5,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;

            let (edge_freshness, edge_reason): (String, Option<String>) = conn.query_row(
                "SELECT evidence_freshness, reason_code FROM narrative_dependency_edge_states
                  WHERE edge_id = ?1",
                params![edge_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(edge_freshness, "fresh");
            assert_eq!(edge_reason, None);

            let (consumer_freshness, run_id): (String, Option<String>) = conn.query_row(
                "SELECT evidence_freshness, last_evaluated_run_id FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'proposal' AND consumer_key = 'proposal-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(consumer_freshness, "fresh");
            assert_eq!(run_id.as_deref(), Some("run-1"));

            assert_eq!(
                finding_count(conn, "project-1"),
                0,
                "a Fresh edge with no reason code must not create a Finding Observation"
            );

            let run_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(run_status, "completed");

            let (acknowledged, active_run): (i64, Option<String>) = conn.query_row(
                "SELECT acknowledged_through_sequence, active_run_id FROM narrative_change_cursors
                  WHERE project_id = 'project-1' AND consumer_id = 'consumer-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(acknowledged, 5);
            assert_eq!(active_run, None);
            Ok(())
        })
        .expect("publish fresh edge");
    }

    #[test]
    fn single_stale_edge_creates_a_finding_observation() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-1", 3);
            let edge_id = seed_edge(conn, "project-1", "proposal", "proposal-1", "project:scene:scene-1");

            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[(edge_id.clone(), stale())],
                    &epoch_id,
                    3,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;

            assert_eq!(finding_count(conn, "project-1"), 1);
            let (finding_key, reason_code, freshness_snapshot, stored_edge_id): (
                String,
                String,
                String,
                Option<String>,
            ) = conn.query_row(
                "SELECT finding_key, reason_code, evidence_freshness_snapshot, edge_id
                   FROM narrative_maintenance_finding_observations WHERE project_id = 'project-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(finding_key, "proposal:proposal-1");
            assert_eq!(reason_code, "source-revision-changed");
            assert_eq!(freshness_snapshot, "stale");
            assert_eq!(stored_edge_id.as_deref(), Some(edge_id.as_str()));

            let consumer_freshness: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'proposal' AND consumer_key = 'proposal-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(consumer_freshness, "stale");
            Ok(())
        })
        .expect("publish stale edge");
    }

    #[test]
    fn worst_freshness_across_edges_wins_the_consumer_freshness_row() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-1", 7);
            let edge_fresh = seed_edge(conn, "project-1", "proposal", "proposal-1", "project:scene:scene-1");
            let edge_stale = seed_edge(conn, "project-1", "proposal", "proposal-1", "project:scene:scene-2");
            let edge_missing = seed_edge(conn, "project-1", "proposal", "proposal-1", "project:scene:scene-3");

            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[
                        (edge_fresh.clone(), fresh()),
                        (edge_stale.clone(), stale()),
                        (edge_missing.clone(), source_missing()),
                    ],
                    &epoch_id,
                    7,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;

            // Each Edge keeps its own individually evaluated state...
            let edge_fresh_state: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![edge_fresh],
                |row| row.get(0),
            )?;
            assert_eq!(edge_fresh_state, "fresh");
            let edge_stale_state: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![edge_stale],
                |row| row.get(0),
            )?;
            assert_eq!(edge_stale_state, "stale");
            let edge_missing_state: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![edge_missing],
                |row| row.get(0),
            )?;
            assert_eq!(edge_missing_state, "source-missing");

            // ...but the Consumer's single rolled-up row reflects the worst
            // of the three: source-missing beats stale beats fresh.
            let (consumer_freshness, build_action): (String, String) = conn.query_row(
                "SELECT evidence_freshness, build_action FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1' AND consumer_kind = 'proposal' AND consumer_key = 'proposal-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(consumer_freshness, "source-missing");
            assert_eq!(build_action, "manual");

            // Only the two Edges with a reason code (stale, source-missing)
            // produce a Finding Observation -- the fresh one does not.
            assert_eq!(finding_count(conn, "project-1"), 2);
            Ok(())
        })
        .expect("publish across multiple edges");
    }

    #[test]
    fn run_and_cursor_transition_together_with_the_freshness_publish() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-1", 42);
            let edge_id = seed_edge(
                conn,
                "project-1",
                "codex-entry",
                "entry-1",
                "project:codex:entry-source",
            );

            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    "consumer-a",
                    "codex-entry",
                    "entry-1",
                    &[(edge_id, fresh())],
                    &epoch_id,
                    42,
                    "2026-08-15T02:00:00.000Z",
                )
            })?;

            let (status, completed_at): (String, Option<String>) = conn.query_row(
                "SELECT status, completed_at FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(status, "completed");
            assert!(completed_at.is_some());

            let (acknowledged, semantic_epoch, reserved, active_run): (
                i64,
                Option<String>,
                Option<i64>,
                Option<String>,
            ) = conn.query_row(
                "SELECT acknowledged_through_sequence, semantic_epoch_id, reserved_through_sequence,
                        active_run_id
                   FROM narrative_change_cursors
                  WHERE project_id = 'project-1' AND consumer_id = 'consumer-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(acknowledged, 42);
            assert_eq!(semantic_epoch, None);
            assert_eq!(reserved, None);
            assert_eq!(active_run, None);
            Ok(())
        })
        .expect("run and cursor updated together");
    }

    #[test]
    fn empty_edges_list_fails_closed_before_any_write() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-1", 1);

            let error = with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[],
                    &epoch_id,
                    1,
                    "2026-08-15T01:00:00.000Z",
                )
            })
            .expect_err("empty edge list must be rejected");
            assert!(error.to_string().contains("NEX_PUBLISH_RUNTIME_NO_EDGES"));

            // Nothing must have been written: the Run must still be running
            // and the cursor must still be unacknowledged and reserved.
            let run_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(run_status, "running");
            let (acknowledged, active_run): (i64, Option<String>) = conn.query_row(
                "SELECT acknowledged_through_sequence, active_run_id FROM narrative_change_cursors
                  WHERE project_id = 'project-1' AND consumer_id = 'consumer-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(acknowledged, 0);
            assert_eq!(active_run.as_deref(), Some("run-1"));
            Ok(())
        })
        .expect("query after rejected publish");
    }

    /// The regression Gate C2-1 would otherwise have shipped.
    ///
    /// A second publish that re-evaluates only *one* of a Consumer's Edges
    /// must not let the Edges it did not look at stop counting. Reducing
    /// over the caller's argument did exactly that: the Consumer rolled back
    /// to `fresh` while its other Edge's own Edge State still said
    /// `source-missing`, so the durable Freshness authority contradicted the
    /// per-Edge diagnostic it is a rollup of -- and nothing errored.
    #[test]
    fn a_partial_republish_does_not_roll_consumer_freshness_backwards() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            let edge_fresh = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-1",
            );
            let edge_missing = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-2",
            );

            // Round 1: the whole Consumer. One Edge is gone, so the Consumer
            // rolls up to source-missing.
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[
                        (edge_fresh.clone(), fresh()),
                        (edge_missing.clone(), source_missing()),
                    ],
                    &epoch_id,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;
            assert_eq!(consumer_freshness_value(conn, "run-1"), "source-missing");

            // Round 2: only the healthy Edge is re-evaluated, as an
            // incremental Change-Feed-driven pass would do after an edit to
            // scene-1 alone. scene-2 is still missing and was not looked at.
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[(edge_fresh.clone(), fresh())],
                    &epoch_id,
                    "2026-08-15T02:00:00.000Z",
                )
            })?;

            assert_eq!(
                consumer_freshness_value(conn, "run-1"),
                "source-missing",
                "an Edge that was not re-evaluated must keep contributing its stored state"
            );
            let untouched: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![edge_missing],
                |row| row.get(0),
            )?;
            assert_eq!(
                untouched, "source-missing",
                "round 2 must not have touched the Edge it was not given"
            );
            Ok(())
        })
        .expect("partial republish");
    }

    /// An Edge State left behind by a superseded Semantic Epoch must not be
    /// rolled into the current Consumer Freshness. Reading state back is
    /// only safe because of that filter: `narrative_dependency_edge_states`
    /// is keyed by `edge_id` alone and survives an Epoch rotation.
    #[test]
    fn a_prior_epochs_edge_state_does_not_contribute_to_the_rollup() {
        let db = test_db();
        db.with_conn(|conn| {
            let old_epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &old_epoch_id);
            let edge_missing = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-2",
            );
            let edge_fresh = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-1",
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[
                        (edge_fresh.clone(), fresh()),
                        (edge_missing.clone(), source_missing()),
                    ],
                    &old_epoch_id,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;
            assert_eq!(consumer_freshness_value(conn, "run-1"), "source-missing");

            // Rotate. The stale Edge State row for edge_missing stays behind,
            // still stamped with the superseded Epoch.
            let new_epoch_id = with_immediate_transaction(conn, |conn| {
                create_epoch_in_tx(conn, "project-1", "restore", None)
            })?;
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[(edge_fresh.clone(), fresh())],
                    &new_epoch_id,
                    "2026-08-15T03:00:00.000Z",
                )
            })?;

            assert_eq!(
                consumer_freshness_value(conn, "run-1"),
                "unknown",
                "the prior Epoch's source-missing must not leak in, and the Edge that was \
                 not re-evaluated must not silently vanish either -- it is unknown, and \
                 unknown outranks fresh"
            );
            Ok(())
        })
        .expect("epoch rotation rollup");
    }

    /// The false PASS the LEFT JOIN exists to stop: a Consumer must not be
    /// published `fresh` while one of the Edges its own dependency-set digest
    /// covers has never been evaluated in this Epoch.
    #[test]
    fn a_consumer_is_not_fresh_while_one_of_its_edges_is_unevaluated() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            let evaluated = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-1",
            );
            // Declared, never evaluated. No Edge State row will exist for it.
            seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-2",
            );

            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[(evaluated.clone(), fresh())],
                    &epoch_id,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;

            assert_eq!(
                consumer_freshness_value(conn, "run-1"),
                "unknown",
                "publishing one Edge of two must not certify the Consumer clean"
            );
            // ...and the digest still covers both, which is exactly why the
            // rollup may not quietly drop one of them.
            let digest = stored_dependency_set_digest(conn, "run-1")
                .expect("publish must write a dependency set digest");
            assert_eq!(
                digest,
                compute_dependency_set_digest(&[
                    "project:scene:scene-1".to_string(),
                    "project:scene:scene-2".to_string(),
                ])
            );
            Ok(())
        })
        .expect("partial evaluation");
    }

    /// The Consumer's dependency-set digest is written by the publish, and
    /// it tracks *which* Sources the Consumer reads rather than their
    /// content: adding an Edge changes it even when every Edge is Fresh.
    #[test]
    fn publishing_records_the_consumers_dependency_set_digest() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            let edge_one = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-1",
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[(edge_one.clone(), fresh())],
                    &epoch_id,
                    "2026-08-15T01:00:00.000Z",
                )
            })?;
            let first = stored_dependency_set_digest(conn, "run-1")
                .expect("publish must write a dependency set digest");
            assert_eq!(
                first,
                compute_dependency_set_digest(&["project:scene:scene-1".to_string()]),
                "the stored digest must be the digest of the Consumer's Edge identities"
            );

            let edge_two = seed_edge(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-2",
            );
            with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_edges_only_in_tx(
                    conn,
                    "project-1",
                    "run-1",
                    RUN_CONSUMER_KIND,
                    "run-1",
                    &[(edge_one.clone(), fresh()), (edge_two.clone(), fresh())],
                    &epoch_id,
                    "2026-08-15T02:00:00.000Z",
                )
            })?;
            let second =
                stored_dependency_set_digest(conn, "run-1").expect("digest must still be present");
            assert_ne!(
                first, second,
                "the dependency set changed, so its digest must change -- even though every \
                 Edge is Fresh and no per-Edge state moved"
            );
            Ok(())
        })
        .expect("dependency set digest");
    }

    #[test]
    fn publish_requires_a_caller_owned_transaction() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-1", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            let edge_id = seed_edge(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
            );
            assert!(conn.is_autocommit());

            let error = publish_freshness_evaluation_in_tx(
                conn,
                "project-1",
                "run-1",
                "consumer-a",
                "proposal",
                "proposal-1",
                &[(edge_id, fresh())],
                &epoch_id,
                1,
                "2026-08-15T01:00:00.000Z",
            )
            .expect_err("publish outside a transaction must be rejected");
            assert!(error.to_string().contains("caller-owned transaction"));
            Ok(())
        })
        .expect("autocommit guard runs outside any transaction");
    }

    #[test]
    fn write_edge_state_fails_closed_when_edge_belongs_to_a_different_project() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            let edge_id = seed_edge(
                conn,
                "project-2",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
            );

            let error = write_edge_state_in_tx(
                conn,
                "project-1",
                &edge_id,
                &fresh(),
                &epoch_id,
                "2026-08-15T01:00:00.000Z",
            )
            .expect_err("edge owned by another project must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_EDGE_PROJECT_MISMATCH"));
            Ok(())
        })
        .expect("query after rejected write");
    }

    /// Same Producer-time gate as `dependency_edges`', on the Freshness
    /// authority's own writer. Both have to refuse, or the two tables could
    /// disagree about what a Consumer even is.
    #[test]
    fn write_consumer_freshness_refuses_a_kind_carrying_the_finding_key_separator() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            let error = write_consumer_freshness_in_tx(
                conn,
                "project-1",
                "a:b",
                "c",
                &fresh(),
                &epoch_id,
                None,
                None,
                "2026-08-15T01:00:00.000Z",
            )
            .expect_err("a consumer kind containing the separator must be refused");
            assert!(
                error.to_string().contains("NEX_CONSUMER_KIND_INVALID"),
                "unexpected error: {error}"
            );
            Ok(())
        })
        .expect("consumer identity gate");
    }

    #[test]
    fn write_consumer_freshness_fails_closed_when_epoch_belongs_to_a_different_project() {
        let db = current_schema_test_db();
        db.with_conn(|conn| {
            let other_epoch_id = seed_epoch(conn, "project-2");

            let error = write_consumer_freshness_in_tx(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                &fresh(),
                &other_epoch_id,
                None,
                None,
                "2026-08-15T01:00:00.000Z",
            )
            .expect_err("epoch owned by another project must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_EPOCH_PROJECT_MISMATCH"));
            Ok(())
        })
        .expect("query after rejected write");
    }

    // -- verify_publish_reservation_in_tx / acknowledge_cursor_reservation_in_tx --

    /// The exact hazard this CAS check exists to prevent: Run A reserves
    /// and evaluates against Epoch E1; a Restore rotates the project to
    /// Epoch E2 before Run A publishes; Run B reserves a fresh range
    /// against E2. Run A's now-stale publish must be rejected outright --
    /// not partially applied, not silently overwriting Run B's live
    /// reservation or `narrative_consumer_freshness` with E1-era results.
    #[test]
    fn stale_run_from_a_rotated_epoch_cannot_publish_over_a_fresher_reservation() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_e1 = seed_epoch(conn, "project-1");
            seed_run(conn, "run-a", "project-1", &epoch_e1);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_e1, "run-a", 5);
            let edge_id = seed_edge(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
            );

            // Restore rotates the project to a new Semantic Epoch while
            // Run A is still mid-flight (already reserved, not yet
            // published).
            let epoch_e2 = create_epoch_in_tx(conn, "project-1", "restore", None)?;

            // Recovery releases Run A's exact stale-Epoch reservation without
            // acknowledging it. Run B can then reserve the same cursor under
            // the new Epoch; the strengthened reservation CAS forbids a direct
            // takeover while Run A is still active.
            with_immediate_transaction(conn, |conn| {
                release_cursor_reservation_in_tx(
                    conn,
                    "project-1",
                    "consumer-a",
                    "run-a",
                    &epoch_e1,
                    5,
                )
            })?;
            seed_run(conn, "run-b", "project-1", &epoch_e2);
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_e2, "run-b", 8);

            // Run A's stale publish must be rejected: its own Epoch (E1)
            // is no longer current, and the cursor's reservation now
            // belongs to Run B, not Run A.
            let error = with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-a",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[(edge_id, fresh())],
                    &epoch_e1,
                    5,
                    "2026-08-15T01:00:00.000Z",
                )
            })
            .expect_err("a stale run's publish must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_STALE_RESERVATION"));

            // Nothing must have been written: no Consumer Freshness row at
            // all (neither Run has published yet), Run A is still
            // running, and Run B's reservation is completely undisturbed.
            let freshness_row_exists: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM narrative_consumer_freshness
                     WHERE project_id = 'project-1' AND consumer_kind = 'proposal'
                       AND consumer_key = 'proposal-1'
                 )",
                [],
                |row| row.get(0),
            )?;
            assert!(
                !freshness_row_exists,
                "stale publish must not create or overwrite the Consumer Freshness row"
            );
            let run_a_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-a'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(run_a_status, "running");
            let (semantic_epoch, reserved, active_run): (
                Option<String>,
                Option<i64>,
                Option<String>,
            ) = conn.query_row(
                "SELECT semantic_epoch_id, reserved_through_sequence, active_run_id
                       FROM narrative_change_cursors
                      WHERE project_id = 'project-1' AND consumer_id = 'consumer-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(semantic_epoch.as_deref(), Some(epoch_e2.as_str()));
            assert_eq!(reserved, Some(8));
            assert_eq!(active_run.as_deref(), Some("run-b"));
            Ok(())
        })
        .expect("query after rejected stale publish");
    }

    #[test]
    fn publish_rejects_when_the_reservation_belongs_to_a_different_run() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-a", "project-1", &epoch_id);
            seed_run(conn, "run-b", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            // The cursor is reserved for run-b, but run-a is the one
            // attempting to publish.
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-b", 5);
            let edge_id = seed_edge(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
            );

            let error = with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-a",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[(edge_id, fresh())],
                    &epoch_id,
                    5,
                    "2026-08-15T01:00:00.000Z",
                )
            })
            .expect_err("a run without the live reservation must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_STALE_RESERVATION"));
            Ok(())
        })
        .expect("query after rejected publish");
    }

    #[test]
    fn publish_rejects_when_through_sequence_does_not_match_the_reservation() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-a", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-a", 5);
            let edge_id = seed_edge(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
            );

            // Publishing a through_sequence other than the one actually
            // reserved (10, not 5) must be rejected, not silently
            // truncated or extended.
            let error = with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-a",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[(edge_id, fresh())],
                    &epoch_id,
                    10,
                    "2026-08-15T01:00:00.000Z",
                )
            })
            .expect_err("a through_sequence mismatch must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_STALE_RESERVATION"));
            Ok(())
        })
        .expect("query after rejected publish");
    }

    #[test]
    fn publish_rejects_when_the_run_is_no_longer_running() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = seed_epoch(conn, "project-1");
            seed_run(conn, "run-a", "project-1", &epoch_id);
            seed_cursor(conn, "project-1", "consumer-a");
            reserve_cursor(conn, "project-1", "consumer-a", &epoch_id, "run-a", 5);
            let edge_id = seed_edge(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "project:scene:scene-1",
            );

            // A Run that has already terminated (e.g. cancelled out from
            // under an in-flight evaluation) must not be able to publish.
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'cancelled' WHERE id = 'run-a'",
                [],
            )?;

            let error = with_immediate_transaction(conn, |conn| {
                publish_freshness_evaluation_in_tx(
                    conn,
                    "project-1",
                    "run-a",
                    "consumer-a",
                    "proposal",
                    "proposal-1",
                    &[(edge_id, fresh())],
                    &epoch_id,
                    5,
                    "2026-08-15T01:00:00.000Z",
                )
            })
            .expect_err("a non-running run must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_PUBLISH_RUNTIME_STALE_RESERVATION"));
            Ok(())
        })
        .expect("query after rejected publish");
    }
}
