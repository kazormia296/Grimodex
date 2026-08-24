//! Change Feed-driven incremental Freshness runtime (Gate C2-1).
//!
//! One cycle reserves at most [`MAX_CANONICAL_SEQUENCES_PER_BATCH`]
//! canonical sequences, resolves the changed Sources back to Dependency
//! Edges, evaluates only those Edges, publishes every affected Consumer,
//! and acknowledges the range once.  Reservation, Run/Task/Attempt state,
//! all derived publications, and the final acknowledgement live on the
//! workspace's one authoritative [`Database`] connection.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use crate::Database;
use grimodex_core::narrative_dependency::{
    aggregate_dependency_build_actions, evaluate_dependency_effect, load_dependency_role_registry,
    DependencyEffectInput, DependencyEffectRegistry, EvidenceFreshness as V2EvidenceFreshness,
    SourceChangeClass,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::change_feed::{
    get_changes_since, NarrativeChangeEventRecord, CANONICAL_TEXT_NORMALIZER_VERSION,
};
use super::consumer_identity::{is_declared_consumer_kind, APPLICATION_CONSUMER_KIND};
use super::cursor_reservation::{
    acknowledge_cursor_reservation_in_tx, release_cursor_reservation_in_tx,
    reserve_cursor_range_in_tx,
};
use super::declaration_storage::{
    list_dependency_declaration_head_keys_for_sources_in_tx,
    read_active_dependency_declaration_set_in_tx,
    verify_active_dependency_declaration_set_unchanged_in_conn, ActiveDependencyDeclarationSet,
    ActiveDependencyDeclarationSetRead,
};
use super::dependency_edges::{find_edges_by_consumer, find_edges_by_source, DependencyEdge};
use super::evaluator::{
    evaluate_edge, unknown_edge_observation, EdgeComparisonInput, EdgeObservation,
};
use super::execution_state::{
    supersede_run_in_tx, transition_run_status_in_tx, NarrativeRunStatus,
};
use super::models::ClaimTaskPayload;
use super::publish_runtime::{
    publish_freshness_evaluation_edges_only_in_tx, seed_consumer_freshness_unknown_in_tx,
    verify_publish_reservation_in_tx,
};
use super::repository::{create_system_run_in_tx, record_run_outcome_in_tx, SystemRunWorkKeyReuse};
use super::restore_rebuild::{
    build_edge_comparison_input_from_source_state, resolve_edge_source_state,
    ResolvedEdgeSourceState,
};
use super::semantic_epoch::get_current_epoch;
use super::task_leases::{claim_next_task, verify_task_lease, with_immediate_transaction};
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;

const CURSOR_CONSUMER_ID: &str = INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
const TASK_KIND: &str = "incremental-freshness-batch";
const MAX_CANONICAL_SEQUENCES_PER_BATCH: i64 = 32;
const TASK_LEASE_DURATION_SECS: i64 = 300;
const FAILURE_POLICY_VERSION: &str = "v1";
const MAX_ATTEMPTS_PER_BATCH: i64 = 3;
const LEASE_HEARTBEAT_EDGE_INTERVAL: usize = 64;
pub const NARRATIVE_DEPENDENCY_V2_SHADOW_RUNTIME: &str = "NARRATIVE_DEPENDENCY_V2_SHADOW_RUNTIME";

// A Database already serializes access to its SQLite connection.  This
// process-wide gate additionally orders two automatic triggers before either
// creates a Run, including when they originate from different JS wrapper
// objects around the same workspace authority. The follower then observes
// the durable acknowledgement and returns Idle.
static CYCLE_SERIALIZER: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalFreshnessBatchSummary {
    pub project_id: String,
    pub run_id: String,
    pub from_sequence_exclusive: i64,
    pub through_sequence_inclusive: i64,
    pub affected_edge_count: usize,
    pub affected_consumer_count: usize,
    pub has_more: bool,
    pub v2_shadow: IncrementalFreshnessShadowSummary,
}

/// Non-authoritative D2 observations.  This is deliberately returned with
/// the in-memory cycle result and is never copied into V1 Edge State,
/// Consumer Freshness, or the V1 dependency-set digest column.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalFreshnessShadowSummary {
    pub active_head_count: usize,
    pub declaration_count: usize,
    pub evaluated_declaration_count: usize,
    pub consumers: Vec<IncrementalFreshnessShadowConsumerSummary>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalFreshnessShadowConsumerSummary {
    pub consumer_kind: String,
    pub consumer_key: String,
    pub declaration_set_id: String,
    pub evaluated_declaration_count: usize,
    pub freshness: String,
    pub required_actions: Vec<String>,
    pub advisory_actions: Vec<String>,
    pub compatibility_primary_action: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum IncrementalFreshnessCycleOutcome {
    Idle,
    Processed(IncrementalFreshnessBatchSummary),
}

#[derive(Debug)]
struct ClaimedBatch {
    project_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    lease_owner: String,
    semantic_epoch_id: String,
    from_sequence_exclusive: i64,
    through_sequence_inclusive: i64,
    events: Vec<NarrativeChangeEventRecord>,
    preparation_error: Option<String>,
    has_more: bool,
}

#[derive(Debug)]
struct ChangeBatchEnvelope {
    event_ids: Vec<String>,
    through_sequence_inclusive: i64,
    feed_page_digest: String,
}

#[derive(Debug)]
struct SealedChangeSet {
    event_ids: Vec<String>,
    affected_objects: Vec<String>,
    digest: String,
}

#[derive(Debug)]
struct PreparedChangeEvents {
    events: Vec<NarrativeChangeEventRecord>,
    affected_objects: Vec<String>,
    error: Option<String>,
}

#[derive(Debug)]
enum ReservationOutcome {
    Idle,
    Claimed(Box<ClaimedBatch>),
}

#[derive(Debug)]
struct EvaluationPlan {
    by_consumer: BTreeMap<(String, String), Vec<(String, EdgeObservation)>>,
    affected_edge_count: usize,
    edge_declaration_guards: Vec<DependencyEdge>,
    source_state_guards: Vec<SourceStateGuard>,
    producer_epoch_guards: Vec<ProducerEpochGuard>,
    v2_declaration_guards: Vec<ActiveDependencyDeclarationSet>,
    v2_declaration_head_keys: Vec<(String, String)>,
    v2_declaration_head_snapshots: Vec<(String, String, ActiveDependencyDeclarationSetRead)>,
    v2_shadow_source_identities: Vec<String>,
    v2_shadow: IncrementalFreshnessShadowSummary,
}

#[derive(Debug)]
struct SourceStateGuard {
    edge: DependencyEdge,
    resolving_run_id: String,
    state: ResolvedEdgeSourceState,
}

#[derive(Debug)]
struct ProducerEpochGuard {
    edge: DependencyEdge,
    matched: bool,
}

#[derive(Debug)]
struct SourceEventSignals<'a> {
    latest: &'a NarrativeChangeEventRecord,
    incarnation_replaced: bool,
}

/// Run one bounded automatic Freshness cycle on the live workspace
/// authority.  `Idle` means either no Change Feed work exists or another
/// invocation already owns the process-local cycle/Task lease.
pub fn run_incremental_freshness_cycle(
    db: &Database,
) -> anyhow::Result<IncrementalFreshnessCycleOutcome> {
    let _cycle_guard = CYCLE_SERIALIZER.lock().map_err(|error| {
        anyhow::anyhow!("NEX_INCREMENTAL_FRESHNESS_SERIALIZER_POISONED: {error}")
    })?;

    db.with_background_connection_priority(|| run_serialized_cycle(db))
}

/// Initialize one declared Application that produced no Source mutation.
///
/// `temporal.node.ensure` records an Application and Generic Edge even when
/// the semantic node already exists, while the Change Feed intentionally
/// omits that `ensure-existing` journal entity.  Keep the no-false-Feed
/// contract by using the typed Generic owner to seed every declared Edge as
/// `Unknown`/`Manual`; the next real Source mutation will use the normal
/// Change Feed evaluator and publish path.  The current Semantic Epoch is
/// read from the same authority connection, so no caller-shaped epoch can be
/// attached to the seed.
pub(crate) fn initialize_application_freshness_in_tx(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
    updated_at: &str,
) -> anyhow::Result<()> {
    let epoch = get_current_epoch(conn, project_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_C2ZC_APPLICATION_INIT_EPOCH_MISSING: project '{project_id}' has no current Semantic Epoch"
        )
    })?;
    let edges =
        find_edges_by_consumer(conn, project_id, APPLICATION_CONSUMER_KIND, application_id)?;
    anyhow::ensure!(
        !edges.is_empty(),
        "NEX_C2ZC_APPLICATION_INIT_EDGE_MISSING: Application '{application_id}' has no Generic Edge to initialize"
    );
    let edge_ids = edges.into_iter().map(|edge| edge.id).collect::<Vec<_>>();
    seed_consumer_freshness_unknown_in_tx(
        conn,
        project_id,
        APPLICATION_CONSUMER_KIND,
        application_id,
        &edge_ids,
        &epoch.id,
        updated_at,
    )
}

fn run_serialized_cycle(db: &Database) -> anyhow::Result<IncrementalFreshnessCycleOutcome> {
    let reservation =
        db.with_conn(|conn| with_immediate_transaction(conn, reserve_or_resume_batch_in_tx))?;

    let batch = match reservation {
        ReservationOutcome::Idle => return Ok(IncrementalFreshnessCycleOutcome::Idle),
        ReservationOutcome::Claimed(batch) => batch,
    };

    // Deliberately release the Database mutex between reservation/evaluation
    // and publication.  A foreground editor waiter can acquire the live
    // authority while this bounded worker computes its read-only plan.
    let plan = match evaluate_batch(db, &batch) {
        Ok(plan) => plan,
        Err(error) => {
            requeue_after_failure(db, &batch, &error)?;
            return Err(error);
        }
    };

    let publish_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
    });
    if let Err(error) = publish_result {
        // A stale Epoch/reservation intentionally cannot publish.  Requeue is
        // best effort and CAS-scoped to this attempt, so it cannot disturb a
        // newer owner that won the race.
        requeue_after_failure(db, &batch, &error)?;
        return Err(error);
    }

    Ok(IncrementalFreshnessCycleOutcome::Processed(
        IncrementalFreshnessBatchSummary {
            project_id: batch.project_id,
            run_id: batch.run_id,
            from_sequence_exclusive: batch.from_sequence_exclusive,
            through_sequence_inclusive: batch.through_sequence_inclusive,
            affected_edge_count: plan.affected_edge_count,
            affected_consumer_count: plan.by_consumer.len(),
            has_more: batch.has_more,
            v2_shadow: plan.v2_shadow,
        },
    ))
}

fn reserve_or_resume_batch_in_tx(conn: &Connection) -> anyhow::Result<ReservationOutcome> {
    let Some(project_id) = select_next_project(conn)? else {
        return Ok(ReservationOutcome::Idle);
    };
    let Some(epoch) = get_current_epoch(conn, &project_id)? else {
        // Epoch creation belongs to the semantic-epoch-event authority. The
        // Freshness consumer waits for that generation boundary and never
        // mints one as a side effect of observing the Feed.
        return Ok(ReservationOutcome::Idle);
    };

    if let Some(active) = load_active_reservation(conn, &project_id)? {
        if active.semantic_epoch_id.as_deref() != Some(epoch.id.as_str()) {
            if matches!(active.run_status.as_deref(), Some("pending" | "running")) {
                supersede_run_in_tx(conn, &active.run_id)?;
            }
            release_cursor_reservation_in_tx(
                conn,
                &project_id,
                CURSOR_CONSUMER_ID,
                &active.run_id,
                active.semantic_epoch_id.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("NEX_CURSOR_RESERVATION_INVALID: active Epoch is missing")
                })?,
                active.through_sequence,
            )?;
        } else {
            match active.run_status.as_deref() {
                Some("pending" | "running") => {
                    return resume_active_batch_in_tx(conn, &project_id, &epoch.id, active)
                }
                // Retry exhaustion is a durable dead-letter. Keep the sealed
                // range reserved but lease-free so an automatic trigger goes
                // Idle instead of minting an unbounded stream of Attempts.
                // A canonical Epoch rotation may supersede and replay it.
                Some("failed")
                    if active.terminal_reason_code.as_deref()
                        == Some("NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED") =>
                {
                    return Ok(ReservationOutcome::Idle)
                }
                _ => {
                    conn.execute(
                        "UPDATE narrative_extraction_attempts
                            SET status = 'failed', completed_at = datetime('now'),
                                error_message = 'incremental Freshness Run ended before publication',
                                failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED',
                                retry_disposition = 'retryable', policy_version = ?1,
                                next_attempt_at = datetime('now')
                          WHERE status = 'running'
                            AND task_id IN (
                              SELECT id FROM narrative_extraction_tasks WHERE run_id = ?2
                            )",
                        params![FAILURE_POLICY_VERSION, active.run_id],
                    )?;
                    release_cursor_reservation_in_tx(
                        conn,
                        &project_id,
                        CURSOR_CONSUMER_ID,
                        &active.run_id,
                        active.semantic_epoch_id.as_deref().ok_or_else(|| {
                            anyhow::anyhow!(
                                "NEX_CURSOR_RESERVATION_INVALID: active Epoch is missing"
                            )
                        })?,
                        active.through_sequence,
                    )?;
                }
            }
        }
    }

    create_and_claim_batch_in_tx(conn, &project_id, &epoch.id)
}

#[derive(Debug)]
struct ActiveReservation {
    run_id: String,
    through_sequence: i64,
    semantic_epoch_id: Option<String>,
    acknowledged_through_sequence: i64,
    run_status: Option<String>,
    terminal_reason_code: Option<String>,
}

fn load_active_reservation(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Option<ActiveReservation>> {
    conn.query_row(
        "SELECT c.active_run_id, c.reserved_through_sequence,
                c.semantic_epoch_id, c.acknowledged_through_sequence, r.status,
                r.terminal_reason_code
           FROM narrative_change_cursors c
           LEFT JOIN narrative_extraction_runs r ON r.id = c.active_run_id
          WHERE c.project_id = ?1
            AND c.consumer_id = ?2
            AND c.active_run_id IS NOT NULL",
        params![project_id, CURSOR_CONSUMER_ID],
        |row| {
            Ok(ActiveReservation {
                run_id: row.get(0)?,
                through_sequence: row.get(1)?,
                semantic_epoch_id: row.get(2)?,
                acknowledged_through_sequence: row.get(3)?,
                run_status: row.get(4)?,
                terminal_reason_code: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn select_next_project(conn: &Connection) -> anyhow::Result<Option<String>> {
    let active: Option<String> = conn
        .query_row(
            "SELECT cursor.project_id
               FROM narrative_change_cursors cursor
               LEFT JOIN narrative_extraction_runs run ON run.id = cursor.active_run_id
               JOIN narrative_semantic_epochs epoch
                 ON epoch.id = (
                   SELECT current.id FROM narrative_semantic_epochs current
                    WHERE current.project_id = cursor.project_id
                    ORDER BY current.epoch_number DESC LIMIT 1
                 )
              WHERE cursor.consumer_id = ?1 AND cursor.active_run_id IS NOT NULL
                AND (
                  cursor.semantic_epoch_id IS NULL
                  OR cursor.semantic_epoch_id <> epoch.id
                  OR run.status IS NULL
                  OR run.status <> 'failed'
                  OR COALESCE(run.terminal_reason_code, '') <>
                     'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED'
                )
              ORDER BY cursor.updated_at ASC, cursor.project_id ASC
              LIMIT 1",
            [CURSOR_CONSUMER_ID],
            |row| row.get(0),
        )
        .optional()?;
    if active.is_some() {
        return Ok(active);
    }

    conn.query_row(
        "SELECT event.project_id
           FROM narrative_change_events event
           LEFT JOIN narrative_change_cursors cursor
             ON cursor.project_id = event.project_id
            AND cursor.consumer_id = ?1
          WHERE event.canonical_sequence >
                COALESCE(cursor.acknowledged_through_sequence, 0)
            AND cursor.active_run_id IS NULL
            AND EXISTS (
              SELECT 1 FROM narrative_semantic_epochs epoch
               WHERE epoch.project_id = event.project_id
            )
          GROUP BY event.project_id
          ORDER BY MIN(event.canonical_sequence) ASC, event.project_id ASC
          LIMIT 1",
        [CURSOR_CONSUMER_ID],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn load_change_batch_envelope(
    conn: &Connection,
    project_id: &str,
    after_sequence: i64,
    limit: i64,
) -> anyhow::Result<Option<ChangeBatchEnvelope>> {
    // Read only the durable page identity here. Persisted JSON and vocabulary
    // are decoded after a Run/Task/Attempt exists, so one corrupt or
    // forward-version Feed row consumes the same bounded failure budget as an
    // evaluation error instead of starving every project before reservation.
    let mut statement = conn.prepare(
        "SELECT event.id, event.canonical_sequence
           FROM narrative_change_events event
          WHERE event.project_id = ?1
            AND event.canonical_sequence IN (
              SELECT page.canonical_sequence
                FROM narrative_change_events page
               WHERE page.project_id = ?1
                 AND page.canonical_sequence > ?2
               GROUP BY page.canonical_sequence
               ORDER BY page.canonical_sequence
               LIMIT ?3
            )
          ORDER BY event.canonical_sequence, event.event_ordinal, event.id",
    )?;
    let rows = statement
        .query_map(params![project_id, after_sequence, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let Some(through_sequence_inclusive) = rows.iter().map(|(_, sequence)| *sequence).max() else {
        return Ok(None);
    };
    let selected_event_ids = rows
        .into_iter()
        .map(|(event_id, _)| event_id)
        .collect::<Vec<_>>();
    let envelope = load_change_feed_range_envelope(
        conn,
        project_id,
        after_sequence,
        through_sequence_inclusive,
    )?
    .ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH: selected Feed page disappeared"
        )
    })?;
    anyhow::ensure!(
        envelope.event_ids == selected_event_ids,
        "NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH: selected Feed page changed while reserving"
    );
    Ok(Some(envelope))
}

fn load_change_feed_range_envelope(
    conn: &Connection,
    project_id: &str,
    after_sequence: i64,
    through_sequence_inclusive: i64,
) -> anyhow::Result<Option<ChangeBatchEnvelope>> {
    // Keep every persisted value as raw SQL text in the fingerprint. This
    // deliberately does not decode Feed JSON or enum vocabulary: malformed
    // rows still need a durable Run and the same bounded retry budget.
    let mut statement = conn.prepare(
        "SELECT event.id, event.canonical_sequence,
                json_array(
                  event.id, event.project_id, event.transaction_id,
                  event.canonical_change_event_uid, event.canonical_sequence,
                  event.event_ordinal, event.object_key_json, event.change_kind,
                  event.mutation_kind, event.before_version, event.before_digest,
                  event.after_version, event.after_digest,
                  event.changed_paths_json, event.text_impact_json,
                  event.structural_impact_json, event.occurred_at,
                  feed_transaction.id, feed_transaction.project_id,
                  feed_transaction.request_id, feed_transaction.source_domain,
                  feed_transaction.source_change_event_uid,
                  feed_transaction.source_change_event_sequence,
                  feed_transaction.cause_kind, feed_transaction.origin,
                  feed_transaction.original_transaction_id,
                  feed_transaction.commit_id, feed_transaction.journal_id,
                  feed_transaction.undo_journal_id,
                  feed_transaction.application_ids_json,
                  feed_transaction.payload_digest, feed_transaction.created_at
                )
           FROM narrative_change_events event
           LEFT JOIN narrative_change_transactions feed_transaction
             ON feed_transaction.project_id = event.project_id
            AND feed_transaction.id = event.transaction_id
          WHERE event.project_id = ?1
            AND event.canonical_sequence > ?2
            AND event.canonical_sequence <= ?3
          ORDER BY event.canonical_sequence, event.event_ordinal, event.id",
    )?;
    let rows = statement
        .query_map(
            params![project_id, after_sequence, through_sequence_inclusive],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let Some(live_through_sequence) = rows.iter().map(|(_, sequence, _)| *sequence).max() else {
        return Ok(None);
    };
    let event_ids = rows
        .iter()
        .map(|(event_id, _, _)| event_id.clone())
        .collect::<Vec<_>>();
    let raw_rows = rows
        .into_iter()
        .map(|(_, _, raw_row)| serde_json::from_str::<Value>(&raw_row))
        .collect::<Result<Vec<_>, _>>()?;
    let feed_page_digest = digest_json(&Value::Array(raw_rows))?;
    Ok(Some(ChangeBatchEnvelope {
        event_ids,
        through_sequence_inclusive: live_through_sequence,
        feed_page_digest,
    }))
}

fn prepare_change_events(
    conn: &Connection,
    project_id: &str,
    after_sequence: i64,
    through_sequence_inclusive: i64,
    fallback_event_ids: &[String],
) -> PreparedChangeEvents {
    let loaded = get_changes_since(
        conn,
        project_id,
        after_sequence,
        MAX_CANONICAL_SEQUENCES_PER_BATCH,
    );
    let events = match loaded {
        Ok(events) => events
            .into_iter()
            .filter(|event| event.canonical_sequence <= through_sequence_inclusive)
            .collect::<Vec<_>>(),
        Err(error) => {
            return PreparedChangeEvents {
                events: Vec::new(),
                affected_objects: fallback_event_ids
                    .iter()
                    .map(|event_id| format!("unresolved-change-feed-event:{event_id}"))
                    .collect(),
                error: Some(format!("{error:#}")),
            };
        }
    };
    let decoded_event_ids = events
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<Vec<_>>();
    let sealed_event_ids = fallback_event_ids
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if decoded_event_ids != sealed_event_ids {
        return PreparedChangeEvents {
            events,
            affected_objects: fallback_event_ids
                .iter()
                .map(|event_id| format!("unresolved-change-feed-event:{event_id}"))
                .collect(),
            error: Some(format!(
                "NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH: decoded event IDs do not match sealed range ({after_sequence}, {through_sequence_inclusive}]"
            )),
        };
    }
    match affected_source_identities(project_id, &events) {
        Ok(affected_objects) => PreparedChangeEvents {
            events,
            affected_objects,
            error: None,
        },
        Err(error) => PreparedChangeEvents {
            affected_objects: events
                .iter()
                .map(|event| format!("unresolved-change-feed-event:{}", event.event_id))
                .collect(),
            events,
            error: Some(format!("{error:#}")),
        },
    }
}

fn sealed_change_set_value(
    project_id: &str,
    from_sequence_exclusive: i64,
    through_sequence_inclusive: i64,
    event_ids: &[String],
    affected_objects: &[String],
    feed_page_digest: &str,
) -> Value {
    json!({
        "projectId": project_id,
        "fromSequenceExclusive": from_sequence_exclusive,
        "throughSequenceInclusive": through_sequence_inclusive,
        "eventIds": event_ids,
        "affectedObjects": affected_objects,
        "feedPageDigest": feed_page_digest,
    })
}

fn load_sealed_change_set_for_run(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    from_sequence_exclusive: i64,
    through_sequence_inclusive: i64,
) -> anyhow::Result<SealedChangeSet> {
    let mut statement = conn.prepare(
        "SELECT input_json
           FROM narrative_extraction_tasks
          WHERE run_id = ?1 AND task_kind = ?2
          ORDER BY id",
    )?;
    let task_inputs = statement
        .query_map(params![run_id, TASK_KIND], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        task_inputs.len() == 1,
        "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: Run '{run_id}' must have exactly one {TASK_KIND} Task"
    );
    let input_json = &task_inputs[0];
    let input: Value = serde_json::from_str(input_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: Task input is unreadable: {error}"
        )
    })?;
    let change_set_id = input
        .get("changeSetId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: Task input has no changeSetId"
            )
        })?;
    let (sealed_from, sealed_through, event_ids_json, affected_objects_json, digest): (
        i64,
        i64,
        String,
        String,
        String,
    ) = conn.query_row(
        "SELECT from_sequence_exclusive, through_sequence_inclusive,
                event_ids_json, affected_objects_json, digest
           FROM narrative_change_sets
          WHERE id = ?1 AND project_id = ?2",
        params![change_set_id, project_id],
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
    anyhow::ensure!(
        sealed_from == from_sequence_exclusive && sealed_through == through_sequence_inclusive,
        "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: sealed range ({sealed_from}, {sealed_through}] does not match reserved range ({from_sequence_exclusive}, {through_sequence_inclusive}]"
    );
    let event_ids = serde_json::from_str::<Vec<String>>(&event_ids_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: eventIdsJson is unreadable: {error}"
        )
    })?;
    anyhow::ensure!(
        !event_ids.is_empty() && event_ids.iter().all(|event_id| !event_id.is_empty()),
        "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: sealed event IDs must be non-empty"
    );
    let affected_objects =
        serde_json::from_str::<Vec<String>>(&affected_objects_json).map_err(|error| {
            anyhow::anyhow!(
                "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: affectedObjectsJson is unreadable: {error}"
            )
        })?;
    anyhow::ensure!(
        digest.starts_with("sha256:") && digest.len() == "sha256:".len() + 64,
        "NEX_INCREMENTAL_FRESHNESS_CHANGE_SET_INVALID: digest is not a SHA-256 token"
    );
    Ok(SealedChangeSet {
        event_ids,
        affected_objects,
        digest,
    })
}

fn prepare_reserved_change_events(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    from_sequence_exclusive: i64,
    through_sequence_inclusive: i64,
) -> PreparedChangeEvents {
    let sealed = match load_sealed_change_set_for_run(
        conn,
        project_id,
        run_id,
        from_sequence_exclusive,
        through_sequence_inclusive,
    ) {
        Ok(sealed) => sealed,
        Err(error) => {
            return PreparedChangeEvents {
                events: Vec::new(),
                affected_objects: vec![format!("unresolved-change-set:{run_id}")],
                error: Some(format!("{error:#}")),
            };
        }
    };
    let live_envelope = match load_change_feed_range_envelope(
        conn,
        project_id,
        from_sequence_exclusive,
        through_sequence_inclusive,
    ) {
        Ok(Some(envelope)) => envelope,
        Ok(None) => {
            return PreparedChangeEvents {
                events: Vec::new(),
                affected_objects: sealed
                    .event_ids
                    .iter()
                    .map(|event_id| format!("unresolved-change-feed-event:{event_id}"))
                    .collect(),
                error: Some(format!(
                    "NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH: sealed range ({from_sequence_exclusive}, {through_sequence_inclusive}] is empty"
                )),
            };
        }
        Err(error) => {
            return PreparedChangeEvents {
                events: Vec::new(),
                affected_objects: sealed
                    .event_ids
                    .iter()
                    .map(|event_id| format!("unresolved-change-feed-event:{event_id}"))
                    .collect(),
                error: Some(format!("{error:#}")),
            };
        }
    };
    let live_sealed_value = sealed_change_set_value(
        project_id,
        from_sequence_exclusive,
        through_sequence_inclusive,
        &sealed.event_ids,
        &sealed.affected_objects,
        &live_envelope.feed_page_digest,
    );
    let live_change_set_digest = match digest_json(&live_sealed_value) {
        Ok(digest) => digest,
        Err(error) => {
            return PreparedChangeEvents {
                events: Vec::new(),
                affected_objects: sealed.affected_objects,
                error: Some(format!("{error:#}")),
            };
        }
    };
    if live_envelope.event_ids != sealed.event_ids
        || live_envelope.through_sequence_inclusive != through_sequence_inclusive
        || live_change_set_digest != sealed.digest
    {
        return PreparedChangeEvents {
            events: Vec::new(),
            affected_objects: sealed
                .event_ids
                .iter()
                .map(|event_id| format!("unresolved-change-feed-event:{event_id}"))
                .collect(),
            error: Some(format!(
                "NEX_INCREMENTAL_FRESHNESS_CHANGE_FEED_PAGE_MISMATCH: live Feed rows do not match the sealed Change Set for range ({from_sequence_exclusive}, {through_sequence_inclusive}]"
            )),
        };
    }
    prepare_change_events(
        conn,
        project_id,
        from_sequence_exclusive,
        through_sequence_inclusive,
        &sealed.event_ids,
    )
}

fn create_and_claim_batch_in_tx(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<ReservationOutcome> {
    let acknowledged = conn
        .query_row(
            "SELECT acknowledged_through_sequence
               FROM narrative_change_cursors
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![project_id, CURSOR_CONSUMER_ID],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let Some(envelope) = load_change_batch_envelope(
        conn,
        project_id,
        acknowledged,
        MAX_CANONICAL_SEQUENCES_PER_BATCH,
    )?
    else {
        return Ok(ReservationOutcome::Idle);
    };
    let through_sequence = envelope.through_sequence_inclusive;
    let prepared = prepare_change_events(
        conn,
        project_id,
        acknowledged,
        through_sequence,
        &envelope.event_ids,
    );
    let affected_objects = prepared.affected_objects;
    let event_ids = envelope.event_ids;
    let sealed = sealed_change_set_value(
        project_id,
        acknowledged,
        through_sequence,
        &event_ids,
        &affected_objects,
        &envelope.feed_page_digest,
    );
    let digest = digest_json(&sealed)?;
    let change_set_id = format!(
        "incremental-freshness:{}",
        digest.trim_start_matches("sha256:")
    );
    let now = now_string();
    conn.execute(
        "INSERT OR IGNORE INTO narrative_change_sets
            (id, project_id, from_sequence_exclusive, through_sequence_inclusive,
             event_ids_json, affected_objects_json, digest, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            change_set_id,
            project_id,
            acknowledged,
            through_sequence,
            serde_json::to_string(&event_ids)?,
            serde_json::to_string(&affected_objects)?,
            digest,
            now,
        ],
    )?;

    let work_key = format!(
        "incremental-freshness:{semantic_epoch_id}:{acknowledged}:{through_sequence}:{}",
        digest.trim_start_matches("sha256:")
    );
    let created = create_system_run_in_tx(
        conn,
        project_id,
        "freshness-evaluation",
        semantic_epoch_id,
        &work_key,
        &sealed,
        &digest,
        SystemRunWorkKeyReuse::RunningOnly,
        None,
    )?;
    let run_id = required_json_string(&created, "runId")?.to_string();
    let run_status = required_json_string(&created, "status")?;
    conn.execute(
        "UPDATE narrative_extraction_runs
            SET consumer_id = ?1
          WHERE id = ?2 AND project_id = ?3
            AND (consumer_id IS NULL OR consumer_id = ?1)",
        params![CURSOR_CONSUMER_ID, run_id, project_id],
    )?;
    reserve_cursor_range_in_tx(
        conn,
        project_id,
        CURSOR_CONSUMER_ID,
        semantic_epoch_id,
        &run_id,
        through_sequence,
    )?;

    let has_more = has_changes_after(conn, project_id, through_sequence)?;
    anyhow::ensure!(
        run_status == "running",
        "NEX_INCREMENTAL_FRESHNESS_RUN_NOT_RESUMABLE: run '{run_id}' is '{run_status}'"
    );

    ensure_batch_task_in_tx(
        conn,
        &run_id,
        &change_set_id,
        acknowledged,
        through_sequence,
    )?;
    claim_reserved_batch_in_tx(
        conn,
        project_id,
        semantic_epoch_id,
        &run_id,
        acknowledged,
        through_sequence,
        prepared.events,
        prepared.error,
        has_more,
    )
}

fn resume_active_batch_in_tx(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    active: ActiveReservation,
) -> anyhow::Result<ReservationOutcome> {
    let exhausted_interrupted_task: Option<String> = conn
        .query_row(
            "SELECT id
               FROM narrative_extraction_tasks
              WHERE run_id = ?1 AND task_kind = ?2 AND status = 'running'
                AND attempt_count >= ?3
                AND lease_expires_at IS NOT NULL
                AND julianday(lease_expires_at) < julianday('now')
              LIMIT 1",
            params![active.run_id, TASK_KIND, MAX_ATTEMPTS_PER_BATCH],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(task_id) = exhausted_interrupted_task {
        let message = "incremental Freshness worker was interrupted and exhausted its retry budget";
        conn.execute(
            "UPDATE narrative_extraction_attempts
                SET status = 'failed', completed_at = datetime('now'),
                    error_message = ?1,
                    failure_code = 'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED',
                    retry_disposition = 'terminal', policy_version = ?2,
                    next_attempt_at = NULL
              WHERE status = 'running' AND task_id = ?3",
            params![message, FAILURE_POLICY_VERSION, task_id],
        )?;
        let task_updated = conn.execute(
            "UPDATE narrative_extraction_tasks
                SET status = 'failed', error_message = ?1,
                    lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                    completed_at = datetime('now'), version = version + 1
              WHERE id = ?2 AND run_id = ?3 AND status = 'running'",
            params![message, task_id, active.run_id],
        )?;
        anyhow::ensure!(
            task_updated == 1,
            "NEX_INCREMENTAL_FRESHNESS_LEASE_LOST: exhausted interrupted Task changed owner"
        );
        transition_run_status_in_tx(conn, &active.run_id, NarrativeRunStatus::Failed)?;
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET terminal_reason_code = 'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED'
              WHERE id = ?1 AND status = 'failed'",
            [active.run_id.as_str()],
        )?;
        let cursor_updated = conn.execute(
            "UPDATE narrative_change_cursors
                SET lease_owner = NULL, lease_expires_at = NULL,
                    last_error = ?1, updated_at = datetime('now')
              WHERE project_id = ?2 AND consumer_id = ?3
                AND active_run_id = ?4 AND semantic_epoch_id = ?5
                AND reserved_through_sequence = ?6",
            params![
                message,
                project_id,
                CURSOR_CONSUMER_ID,
                active.run_id,
                semantic_epoch_id,
                active.through_sequence,
            ],
        )?;
        anyhow::ensure!(
            cursor_updated == 1,
            "NEX_INCREMENTAL_FRESHNESS_LEASE_LOST: exhausted interrupted cursor changed owner"
        );
        return Ok(ReservationOutcome::Idle);
    }

    let prepared = prepare_reserved_change_events(
        conn,
        project_id,
        &active.run_id,
        active.acknowledged_through_sequence,
        active.through_sequence,
    );
    let has_more = has_changes_after(conn, project_id, active.through_sequence)?;

    // claim_next_task can reclaim an expired Task but does not terminalize
    // the displaced Attempt.  Close it first so recovery never leaves two
    // durable `running` Attempts for one Task.
    conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = 'failed', completed_at = datetime('now'),
                error_message = 'incremental Freshness worker was interrupted',
                failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED',
                retry_disposition = 'retryable', policy_version = ?1,
                next_attempt_at = datetime('now')
          WHERE status = 'running'
            AND task_id IN (
              SELECT id FROM narrative_extraction_tasks
               WHERE run_id = ?2 AND status = 'running'
                 AND lease_expires_at IS NOT NULL
                 AND julianday(lease_expires_at) < julianday('now')
            )",
        params![FAILURE_POLICY_VERSION, active.run_id],
    )?;

    claim_reserved_batch_in_tx(
        conn,
        project_id,
        semantic_epoch_id,
        &active.run_id,
        active.acknowledged_through_sequence,
        active.through_sequence,
        prepared.events,
        prepared.error,
        has_more,
    )
}

#[allow(clippy::too_many_arguments)]
fn claim_reserved_batch_in_tx(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    run_id: &str,
    from_sequence_exclusive: i64,
    through_sequence_inclusive: i64,
    events: Vec<NarrativeChangeEventRecord>,
    preparation_error: Option<String>,
    has_more: bool,
) -> anyhow::Result<ReservationOutcome> {
    let lease_owner = format!("{CURSOR_CONSUMER_ID}:{}", std::process::id());
    let Some(claimed) = claim_next_task(
        conn,
        &ClaimTaskPayload {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            lease_owner: lease_owner.clone(),
            lease_duration_secs: Some(TASK_LEASE_DURATION_SECS),
            task_kinds: Some(vec![TASK_KIND.to_string()]),
        },
    )?
    else {
        return Ok(ReservationOutcome::Idle);
    };
    let updated = conn.execute(
        "UPDATE narrative_change_cursors
            SET lease_owner = ?1, lease_expires_at = ?2, last_error = NULL,
                updated_at = datetime('now')
          WHERE project_id = ?3 AND consumer_id = ?4
            AND active_run_id = ?5 AND semantic_epoch_id = ?6
            AND reserved_through_sequence = ?7",
        params![
            lease_owner,
            claimed.lease_expires_at,
            project_id,
            CURSOR_CONSUMER_ID,
            run_id,
            semantic_epoch_id,
            through_sequence_inclusive,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_CURSOR_RESERVATION_STALE: lease claim lost"
    );

    Ok(ReservationOutcome::Claimed(Box::new(ClaimedBatch {
        project_id: project_id.to_string(),
        run_id: run_id.to_string(),
        task_id: claimed.task_id,
        attempt_id: claimed.attempt_id,
        lease_owner,
        semantic_epoch_id: semantic_epoch_id.to_string(),
        from_sequence_exclusive,
        through_sequence_inclusive,
        events,
        preparation_error,
        has_more,
    })))
}

fn ensure_batch_task_in_tx(
    conn: &Connection,
    run_id: &str,
    change_set_id: &str,
    from_sequence_exclusive: i64,
    through_sequence_inclusive: i64,
) -> anyhow::Result<()> {
    let task_id = format!("{run_id}:batch");
    conn.execute(
        "INSERT OR IGNORE INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority,
             attempt_count, created_at, version)
         VALUES (?1, ?2, ?3, 'queued', ?4, 100, 0, datetime('now'), 0)",
        params![
            task_id,
            run_id,
            TASK_KIND,
            serde_json::to_string(&json!({
                "changeSetId": change_set_id,
                "fromSequenceExclusive": from_sequence_exclusive,
                "throughSequenceInclusive": through_sequence_inclusive,
            }))?,
        ],
    )?;
    Ok(())
}

fn evaluate_batch(db: &Database, batch: &ClaimedBatch) -> anyhow::Result<EvaluationPlan> {
    if let Some(error) = batch.preparation_error.as_deref() {
        anyhow::bail!("{error}");
    }
    let identities = affected_source_identities(&batch.project_id, &batch.events)?;
    // An Apply can create a new Application whose Feed event has no Source
    // locator (for example a chronicle event).  The typed transaction still
    // carries the exact Application identities it declared; include those
    // Consumers directly so the same evaluation/publish guards produce their
    // current-epoch Generic Freshness row.  This is deliberately a forward
    // lookup by the declared identity, never a scanner or inferred locator.
    let declared_application_ids = batch
        .events
        .iter()
        .flat_map(|event| event.application_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let signals = event_signals_by_source(&batch.project_id, &batch.events)?;
    let component_changed = batch.events.iter().any(is_component_schema_change);
    let requires_full_graph = batch.events.iter().any(requires_full_graph_evaluation);
    let edges = db.with_conn(|conn| {
        let mut edges = BTreeMap::<String, DependencyEdge>::new();
        for identity in identities {
            for edge in find_edges_by_source(conn, &batch.project_id, &identity)? {
                edges.insert(edge.id.clone(), edge);
            }
        }
        for application_id in declared_application_ids {
            for edge in find_edges_by_consumer(
                conn,
                &batch.project_id,
                APPLICATION_CONSUMER_KIND,
                &application_id,
            )? {
                edges.insert(edge.id.clone(), edge);
            }
        }
        if requires_full_graph {
            for edge in all_project_edges(conn, &batch.project_id)? {
                edges.insert(edge.id.clone(), edge);
            }
        }
        Ok(edges)
    })?;

    let mut by_consumer = BTreeMap::<(String, String), Vec<(String, EdgeObservation)>>::new();
    let mut source_states = BTreeMap::<(String, String), ResolvedEdgeSourceState>::new();
    let mut edge_declaration_guards = Vec::new();
    let mut source_state_guards = Vec::new();
    let mut producer_epoch_guards = Vec::new();
    // V2 evidence starts from Feed/source facts only. A V1 Edge's private
    // read-set, anchor, or epoch state must not classify a different sealed
    // V2 declaration for the same Source.
    let source_change_classes = signals
        .iter()
        .map(|(source_object_identity, signal)| {
            (
                source_object_identity.clone(),
                source_change_class_from_feed_event(signal.latest),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut affected_edge_count = 0;
    for (index, edge) in edges.values().enumerate() {
        if index % LEASE_HEARTBEAT_EDGE_INTERVAL == 0 {
            renew_batch_lease(db, batch)?;
        }
        edge_declaration_guards.push(edge.clone());
        if !is_declared_consumer_kind(&edge.consumer_kind) {
            // A forward-version or reserved Consumer kind has no evaluator in
            // this build. Publish an explicit Unknown/Manual observation so a
            // previous build's Fresh authority cannot survive version skew.
            // The exact Edge declaration is still guarded and the Feed range
            // is acknowledged only after this publication commits.
            affected_edge_count += 1;
            by_consumer
                .entry((edge.consumer_kind.clone(), edge.consumer_key.clone()))
                .or_default()
                .push((edge.id.clone(), unknown_edge_observation()));
            continue;
        }
        let resolving_run_id = edge.owning_run_id.as_deref().unwrap_or(&batch.run_id);
        let source_cache_key = (
            edge.source_object_identity.clone(),
            resolving_run_id.to_string(),
        );
        let source_state = if let Some(state) = source_states.get(&source_cache_key) {
            state.clone()
        } else {
            let state = db.with_conn(|conn| {
                resolve_edge_source_state(conn, &batch.project_id, resolving_run_id, edge)
            })?;
            source_state_guards.push(SourceStateGuard {
                edge: edge.clone(),
                resolving_run_id: resolving_run_id.to_string(),
                state: state.clone(),
            });
            source_states.insert(source_cache_key, state.clone());
            state
        };
        let mut comparison = build_edge_comparison_input_from_source_state(edge, &source_state)?;
        let producer_epoch_matched =
            db.with_conn(|conn| edge_producer_epoch_matches(conn, edge, &batch.semantic_epoch_id))?;
        comparison.comparison_available &= producer_epoch_matched;
        producer_epoch_guards.push(ProducerEpochGuard {
            edge: edge.clone(),
            matched: producer_epoch_matched,
        });
        if let Some(event) = signals.get(&edge.source_object_identity) {
            apply_event_comparison_signals(&mut comparison, edge, event);
        }
        if component_changed {
            comparison.component_version_matches = false;
        }
        let observation = evaluate_edge(&comparison);
        affected_edge_count += 1;
        by_consumer
            .entry((edge.consumer_kind.clone(), edge.consumer_key.clone()))
            .or_default()
            .push((edge.id.clone(), observation));
    }

    let (role_registry, registry_error) = match load_dependency_role_registry() {
        Ok(registry) => (Some(registry), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let (v2_shadow, v2_declaration_guards, v2_declaration_head_keys, v2_declaration_head_snapshots) =
        evaluate_v2_shadow(
            db,
            &batch.project_id,
            &signals,
            &source_change_classes,
            role_registry.as_ref(),
            registry_error.as_deref(),
        )?;

    Ok(EvaluationPlan {
        affected_edge_count,
        by_consumer,
        edge_declaration_guards,
        source_state_guards,
        producer_epoch_guards,
        v2_declaration_guards,
        v2_declaration_head_keys,
        v2_declaration_head_snapshots,
        v2_shadow_source_identities: signals.keys().cloned().collect(),
        v2_shadow,
    })
}

fn source_change_class_from_feed_event(event: &NarrativeChangeEventRecord) -> SourceChangeClass {
    if is_component_schema_change(event) {
        return SourceChangeClass::ComponentUnavailable;
    }
    if event.mutation_kind == "delete" {
        return SourceChangeClass::SourceMissing;
    }
    let before = event_digest(event, true);
    let after = event_digest(event, false);
    if before.is_some() && before == after {
        SourceChangeClass::ExactContentRelocated
    } else {
        SourceChangeClass::SourceContentChanged
    }
}

fn shadow_change_class_for_role(
    role: grimodex_core::narrative_dependency::DependencyRole,
    base: SourceChangeClass,
) -> SourceChangeClass {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShadowRangeOverlap {
    ProvenOverlap,
    ProvenCollapsed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShadowAnchorEvidence {
    Preserved,
    Missing,
    Unknown,
}

/// Apply selector-specific evidence from the same Feed mapping used by the
/// V1 path. D2 never reads Source text to interpret a selector. A range is
/// narrowed only when a sealed selector and a deterministic position/anchor
/// mapping prove the result. Whole-document and canonical-diff mappings are
/// intentionally not proof-bearing for a persisted range, even when their
/// changed ranges happen to overlap it.
fn shadow_change_class_for_selector(
    selector_json: &str,
    event: &NarrativeChangeEventRecord,
    base: SourceChangeClass,
) -> Result<SourceChangeClass, String> {
    let value: Value = serde_json::from_str(selector_json)
        .map_err(|error| format!("selector JSON is invalid: {error}"))?;
    let selector =
        grimodex_core::narrative_dependency::validate_dependency_selector_value(&value, None)
            .map_err(|error| format!("selector validation failed: {error}"))?;
    match selector {
        grimodex_core::narrative_dependency::DependencySelector::TextRange {
            anchor_digest,
            ..
        } => {
            match shadow_range_overlap(event, &value) {
                ShadowRangeOverlap::ProvenCollapsed => {
                    return Ok(SourceChangeClass::SelectedSetCollapsed);
                }
                ShadowRangeOverlap::Unknown => {
                    return Err("text-range mapping does not prove overlap or collapse".to_owned());
                }
                ShadowRangeOverlap::ProvenOverlap => {}
            }
            if let Some(anchor_digest) = anchor_digest.as_deref() {
                match shadow_anchor_evidence(event, &value, anchor_digest) {
                    ShadowAnchorEvidence::Preserved => {}
                    ShadowAnchorEvidence::Missing => {
                        return Ok(SourceChangeClass::AnchorMissing);
                    }
                    ShadowAnchorEvidence::Unknown => {
                        return Err(
                            "text-range mapping does not prove anchor preservation".to_owned()
                        );
                    }
                }
            }
            Ok(base)
        }
        grimodex_core::narrative_dependency::DependencySelector::WholeSource => Ok(base),
        _ => Err("selector has no proof-bearing projection in the incremental Feed".to_owned()),
    }
}

fn shadow_range_overlap(
    event: &NarrativeChangeEventRecord,
    metadata: &Value,
) -> ShadowRangeOverlap {
    let Some(mapping) = event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("mapping"))
        .and_then(Value::as_object)
    else {
        return ShadowRangeOverlap::Unknown;
    };
    if mapping.get("kind").and_then(Value::as_str) != Some("position-map") {
        return ShadowRangeOverlap::Unknown;
    }
    let Some(segments) = mapping.get("segments").and_then(Value::as_array) else {
        return ShadowRangeOverlap::Unknown;
    };
    let (Some(from), Some(to)) = (
        metadata.get("from").and_then(Value::as_u64),
        metadata.get("to").and_then(Value::as_u64),
    ) else {
        return ShadowRangeOverlap::Unknown;
    };
    let mut overlapped = false;
    for segment in segments {
        let old_from = segment
            .get("oldRange")
            .and_then(|range| range.get("from"))
            .and_then(Value::as_u64);
        let old_to = segment
            .get("oldRange")
            .and_then(|range| range.get("to"))
            .and_then(Value::as_u64);
        if !ranges_overlap(from, to, old_from, old_to) {
            continue;
        }
        overlapped = true;
        if segment.get("behavior").and_then(Value::as_str) == Some("deleted") {
            return ShadowRangeOverlap::ProvenCollapsed;
        }
    }
    if overlapped {
        ShadowRangeOverlap::ProvenOverlap
    } else {
        ShadowRangeOverlap::Unknown
    }
}

fn shadow_anchor_evidence(
    event: &NarrativeChangeEventRecord,
    metadata: &Value,
    anchor_digest: &str,
) -> ShadowAnchorEvidence {
    if event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("preservedAnchorDigests"))
        .and_then(Value::as_array)
        .is_some_and(|digests| {
            digests
                .iter()
                .any(|value| value.as_str() == Some(anchor_digest))
        })
    {
        return ShadowAnchorEvidence::Preserved;
    }
    let Some(mapping) = event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("mapping"))
        .and_then(Value::as_object)
    else {
        return ShadowAnchorEvidence::Unknown;
    };
    if mapping.get("kind").and_then(Value::as_str) != Some("position-map") {
        return ShadowAnchorEvidence::Unknown;
    }
    let Some(segments) = mapping.get("segments").and_then(Value::as_array) else {
        return ShadowAnchorEvidence::Unknown;
    };
    let (Some(from), Some(to)) = (
        metadata.get("from").and_then(Value::as_u64),
        metadata.get("to").and_then(Value::as_u64),
    ) else {
        return ShadowAnchorEvidence::Unknown;
    };
    let mut overlapped = false;
    for segment in segments {
        let old_from = segment
            .get("oldRange")
            .and_then(|range| range.get("from"))
            .and_then(Value::as_u64);
        let old_to = segment
            .get("oldRange")
            .and_then(|range| range.get("to"))
            .and_then(Value::as_u64);
        if !ranges_overlap(from, to, old_from, old_to) {
            continue;
        }
        overlapped = true;
        match segment.get("behavior").and_then(Value::as_str) {
            Some("deleted") | Some("replaced") => return ShadowAnchorEvidence::Missing,
            Some("unchanged") => {
                if matches!((old_from, old_to), (Some(old_from), Some(old_to)) if old_from <= from && to <= old_to)
                {
                    return ShadowAnchorEvidence::Preserved;
                }
            }
            _ => {}
        }
    }
    if overlapped {
        ShadowAnchorEvidence::Unknown
    } else {
        ShadowAnchorEvidence::Unknown
    }
}

fn v2_freshness_rank(freshness: V2EvidenceFreshness) -> u8 {
    match freshness {
        V2EvidenceFreshness::SourceMissing => 5,
        V2EvidenceFreshness::Unknown => 4,
        V2EvidenceFreshness::ReadSetDrift | V2EvidenceFreshness::AnchorMismatch => 3,
        V2EvidenceFreshness::Stale => 2,
        V2EvidenceFreshness::Fresh => 1,
    }
}

fn evaluate_v2_shadow<'a>(
    db: &Database,
    project_id: &str,
    signals: &BTreeMap<String, SourceEventSignals<'a>>,
    source_change_classes: &BTreeMap<String, SourceChangeClass>,
    registry: Option<&DependencyEffectRegistry>,
    registry_error: Option<&str>,
) -> anyhow::Result<(
    IncrementalFreshnessShadowSummary,
    Vec<ActiveDependencyDeclarationSet>,
    Vec<(String, String)>,
    Vec<(String, String, ActiveDependencyDeclarationSetRead)>,
)> {
    db.with_conn(|conn| {
        let mut consumer_keys = BTreeSet::<(String, String)>::new();
        // A sealed D1 set may declare a source for which no V1 compatibility
        // Edge exists (or whose V1 reverse lookup did not select this Feed
        // range). Use the D1 entry/source reverse index to discover exactly
        // those headed Consumers, then let the verified reader decide
        // whether each head is active or corrupt. This is bounded by the
        // Feed's affected Source identities, not a scan of every Consumer.
        let affected_sources = signals.keys().cloned().collect::<Vec<_>>();
        for key in list_dependency_declaration_head_keys_for_sources_in_tx(
            conn,
            project_id,
            &affected_sources,
        )? {
            consumer_keys.insert(key);
        }
        let consumer_key_snapshot = consumer_keys.iter().cloned().collect::<Vec<_>>();
        let mut summary = IncrementalFreshnessShadowSummary::default();
        if let Some(error) = registry_error {
            summary
                .diagnostics
                .push(format!("NEX_V2_SHADOW_REGISTRY_UNKNOWN:{error}"));
        }
        let mut guards = Vec::new();
        let mut snapshots = Vec::new();
        for (consumer_kind, consumer_key) in consumer_keys {
            let state = read_active_dependency_declaration_set_in_tx(
                conn,
                project_id,
                &consumer_kind,
                &consumer_key,
            )?;
            let active_set = match state {
                ActiveDependencyDeclarationSetRead::Missing => {
                    snapshots.push((
                        consumer_kind.clone(),
                        consumer_key.clone(),
                        ActiveDependencyDeclarationSetRead::Missing,
                    ));
                    continue;
                }
                ActiveDependencyDeclarationSetRead::Corrupt => {
                    snapshots.push((
                        consumer_kind.clone(),
                        consumer_key.clone(),
                        ActiveDependencyDeclarationSetRead::Corrupt,
                    ));
                    summary.diagnostics.push(format!(
                        "NEX_V2_SHADOW_DECLARATION_HEAD_CORRUPT:{consumer_kind}:{consumer_key}"
                    ));
                    continue;
                }
                ActiveDependencyDeclarationSetRead::Active(active_set) => active_set,
            };
            snapshots.push((
                consumer_kind.clone(),
                consumer_key.clone(),
                ActiveDependencyDeclarationSetRead::Active(active_set.clone()),
            ));
            let affected_entries = active_set
                .entries
                .iter()
                .filter(|entry| signals.contains_key(&entry.source_object_identity))
                .collect::<Vec<_>>();
            if affected_entries.is_empty() {
                continue;
            }
            summary.active_head_count += 1;
            summary.declaration_count += affected_entries.len();
            guards.push(active_set.clone());

            let mut effects = Vec::new();
            let mut evaluated_declaration_count = 0usize;
            let mut selector_mapping_unknown = false;
            let mut effect_mapping_unknown = false;
            for entry in affected_entries {
                let Some(event) = signals.get(&entry.source_object_identity) else {
                    continue;
                };
                let base_change_class = source_change_classes
                    .get(&entry.source_object_identity)
                    .copied()
                    .unwrap_or_else(|| source_change_class_from_feed_event(event.latest));
                let selector_change_class = match shadow_change_class_for_selector(
                    &entry.selector_json,
                    event.latest,
                    base_change_class,
                ) {
                    Ok(change_class) => change_class,
                    Err(error) => {
                        selector_mapping_unknown = true;
                        evaluated_declaration_count += 1;
                        summary.diagnostics.push(format!(
                            "NEX_V2_SHADOW_SELECTOR_UNKNOWN:{}:{}:{}:{error}",
                            active_set.consumer_kind, active_set.consumer_key, entry.id,
                        ));
                        continue;
                    }
                };
                let change_class =
                    shadow_change_class_for_role(entry.dependency_role, selector_change_class);
                let Some(registry) = registry else {
                    effect_mapping_unknown = true;
                    evaluated_declaration_count += 1;
                    continue;
                };
                let effect = match evaluate_dependency_effect(
                    registry,
                    DependencyEffectInput {
                        role: entry.dependency_role.as_str(),
                        consumer_kind: &active_set.consumer_kind,
                        change_class: change_class.as_str(),
                    },
                ) {
                    Ok(effect) => effect,
                    Err(error) => {
                        effect_mapping_unknown = true;
                        summary.diagnostics.push(format!(
                            "NEX_V2_SHADOW_EFFECT_UNDEFINED:{}:{}:{}:{}:{error}",
                            active_set.consumer_kind,
                            active_set.consumer_key,
                            entry.dependency_role.as_str(),
                            change_class.as_str(),
                        ));
                        continue;
                    }
                };
                effects.push(effect);
                evaluated_declaration_count += 1;
            }

            let (freshness, required_actions, advisory_actions, compatibility_primary_action) =
                if selector_mapping_unknown || effect_mapping_unknown {
                    (
                        V2EvidenceFreshness::Unknown,
                        vec!["manual".to_owned()],
                        Vec::new(),
                        "manual".to_owned(),
                    )
                } else {
                    let action_summary = aggregate_dependency_build_actions(&effects);
                    (
                        effects
                            .iter()
                            .max_by_key(|effect| v2_freshness_rank(effect.freshness))
                            .map_or(V2EvidenceFreshness::Fresh, |effect| effect.freshness),
                        action_summary
                            .required_actions
                            .into_iter()
                            .map(|action| action.as_str().to_owned())
                            .collect(),
                        action_summary
                            .advisory_actions
                            .into_iter()
                            .map(|action| action.as_str().to_owned())
                            .collect(),
                        action_summary
                            .compatibility_primary_action
                            .as_str()
                            .to_owned(),
                    )
                };
            summary.evaluated_declaration_count += evaluated_declaration_count;
            summary
                .consumers
                .push(IncrementalFreshnessShadowConsumerSummary {
                    consumer_kind: active_set.consumer_kind,
                    consumer_key: active_set.consumer_key,
                    declaration_set_id: active_set.declaration_set_id,
                    evaluated_declaration_count,
                    freshness: freshness.as_str().to_owned(),
                    required_actions,
                    advisory_actions,
                    compatibility_primary_action,
                });
        }
        summary.diagnostics.sort();
        Ok((summary, guards, consumer_key_snapshot, snapshots))
    })
}

fn renew_batch_lease(db: &Database, batch: &ClaimedBatch) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let lease_modifier = format!("+{TASK_LEASE_DURATION_SECS} seconds");
            let task_updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)
                  WHERE id = ?2 AND run_id = ?3 AND status = 'running'
                    AND lease_owner = ?4
                    AND lease_expires_at IS NOT NULL
                    AND julianday(lease_expires_at) >= julianday('now')",
                params![
                    lease_modifier,
                    batch.task_id,
                    batch.run_id,
                    batch.lease_owner
                ],
            )?;
            anyhow::ensure!(
                task_updated == 1,
                "NEX_INCREMENTAL_FRESHNESS_LEASE_LOST: Task lease could not be renewed"
            );
            let cursor_updated = conn.execute(
                "UPDATE narrative_change_cursors
                    SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1),
                        updated_at = datetime('now')
                  WHERE project_id = ?2 AND consumer_id = ?3
                    AND active_run_id = ?4 AND semantic_epoch_id = ?5
                    AND reserved_through_sequence = ?6 AND lease_owner = ?7
                    AND lease_expires_at IS NOT NULL
                    AND julianday(lease_expires_at) >= julianday('now')",
                params![
                    lease_modifier,
                    batch.project_id,
                    CURSOR_CONSUMER_ID,
                    batch.run_id,
                    batch.semantic_epoch_id,
                    batch.through_sequence_inclusive,
                    batch.lease_owner,
                ],
            )?;
            anyhow::ensure!(
                cursor_updated == 1,
                "NEX_INCREMENTAL_FRESHNESS_LEASE_LOST: cursor lease could not be renewed"
            );
            Ok(())
        })
    })
}

fn verify_v2_declaration_inputs_in_tx(
    conn: &Connection,
    project_id: &str,
    plan: &EvaluationPlan,
) -> anyhow::Result<()> {
    let current_keys = list_dependency_declaration_head_keys_for_sources_in_tx(
        conn,
        project_id,
        &plan.v2_shadow_source_identities,
    )?;
    anyhow::ensure!(
        current_keys == plan.v2_declaration_head_keys,
        "NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED: affected-source head key set changed after evaluation"
    );
    for (consumer_kind, consumer_key, expected_state) in &plan.v2_declaration_head_snapshots {
        let current_state = read_active_dependency_declaration_set_in_tx(
            conn,
            project_id,
            consumer_kind,
            consumer_key,
        )?;
        anyhow::ensure!(
            &current_state == expected_state,
            "NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED: active head state changed for {consumer_kind}:{consumer_key}"
        );
    }
    for guard in &plan.v2_declaration_guards {
        verify_active_dependency_declaration_set_unchanged_in_conn(conn, guard)?;
    }
    Ok(())
}

fn publish_batch_in_tx(
    conn: &Connection,
    batch: &ClaimedBatch,
    plan: &EvaluationPlan,
) -> anyhow::Result<()> {
    verify_task_lease(conn, &batch.task_id, &batch.run_id, &batch.lease_owner)?;
    verify_publish_reservation_in_tx(
        conn,
        &batch.project_id,
        &batch.run_id,
        CURSOR_CONSUMER_ID,
        &batch.semantic_epoch_id,
        batch.through_sequence_inclusive,
    )?;
    for edge in &plan.edge_declaration_guards {
        let current_edge = load_edge_by_id(conn, &edge.project_id, &edge.id)?;
        anyhow::ensure!(
            current_edge.as_ref() == Some(edge),
            "NEX_INCREMENTAL_FRESHNESS_EDGE_CHANGED: '{}' changed after evaluation",
            edge.id
        );
    }
    for guard in &plan.source_state_guards {
        let current = resolve_edge_source_state(
            conn,
            &batch.project_id,
            &guard.resolving_run_id,
            &guard.edge,
        )?;
        anyhow::ensure!(
            current == guard.state,
            "NEX_INCREMENTAL_FRESHNESS_SOURCE_CHANGED: '{}' changed after evaluation",
            guard.edge.source_object_identity
        );
    }
    for guard in &plan.producer_epoch_guards {
        let current = edge_producer_epoch_matches(conn, &guard.edge, &batch.semantic_epoch_id)?;
        anyhow::ensure!(
            current == guard.matched,
            "NEX_SEMANTIC_EPOCH_CHANGED: Edge producer Epoch changed before publication"
        );
    }
    // D2 is shadow-only, but the bounded V2 reverse lookup is still part of
    // the plan's input. Re-run the exact source-bounded key/state snapshot
    // before any V1 row is written so a no-head -> new-head race (or a head
    // disappearing/corrupting) cannot acknowledge a Feed range without
    // evaluating the declaration that was present for its affected Source.
    // The outer caller rolls this transaction back and requeues the existing
    // reservation. Unrelated heads are outside the bounded lookup and do not
    // participate in this guard.
    verify_v2_declaration_inputs_in_tx(conn, &batch.project_id, plan)?;
    let now = now_string();
    for ((consumer_kind, consumer_key), observations) in &plan.by_consumer {
        publish_freshness_evaluation_edges_only_in_tx(
            conn,
            &batch.project_id,
            &batch.run_id,
            consumer_kind,
            consumer_key,
            observations,
            &batch.semantic_epoch_id,
            &now,
        )?;
    }

    let output = json!({
        "projectId": batch.project_id,
        "runId": batch.run_id,
        "fromSequenceExclusive": batch.from_sequence_exclusive,
        "throughSequenceInclusive": batch.through_sequence_inclusive,
        "affectedEdgeCount": plan.affected_edge_count,
        "affectedConsumerCount": plan.by_consumer.len(),
        "hasMore": batch.has_more,
    });
    let output_json = serde_json::to_string(&output)?;
    let attempt_updated = conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = 'completed', completed_at = datetime('now'), output_json = ?1,
                error_message = NULL, failure_code = NULL,
                retry_disposition = NULL, policy_version = NULL, next_attempt_at = NULL
          WHERE id = ?2 AND task_id = ?3 AND status = 'running'",
        params![output_json, batch.attempt_id, batch.task_id],
    )?;
    anyhow::ensure!(
        attempt_updated == 1,
        "incremental Freshness Attempt is not running"
    );
    let task_updated = conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = 'completed', output_json = ?1, error_message = NULL,
                lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                completed_at = datetime('now'), version = version + 1
          WHERE id = ?2 AND run_id = ?3 AND status = 'running'
            AND lease_owner = ?4",
        params![output_json, batch.task_id, batch.run_id, batch.lease_owner],
    )?;
    anyhow::ensure!(
        task_updated == 1,
        "incremental Freshness Task lease was lost"
    );
    record_run_outcome_in_tx(conn, &batch.run_id, &output)?;
    transition_run_status_in_tx(conn, &batch.run_id, NarrativeRunStatus::Completed)?;
    acknowledge_cursor_reservation_in_tx(
        conn,
        &batch.project_id,
        CURSOR_CONSUMER_ID,
        &batch.run_id,
        &batch.semantic_epoch_id,
        batch.through_sequence_inclusive,
    )?;
    Ok(())
}

fn requeue_after_failure(
    db: &Database,
    batch: &ClaimedBatch,
    error: &anyhow::Error,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let message = format!("{error:#}");
            let attempt_count: i64 = conn.query_row(
                "SELECT attempt_count
                   FROM narrative_extraction_tasks
                  WHERE id = ?1 AND run_id = ?2",
                params![batch.task_id, batch.run_id],
                |row| row.get(0),
            )?;
            let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;
            let failure_code = if terminal {
                "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED"
            } else {
                "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"
            };
            let retry_disposition = if terminal { "terminal" } else { "retryable" };
            let attempt_updated = conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed', completed_at = datetime('now'), error_message = ?1,
                        failure_code = ?2, retry_disposition = ?3, policy_version = ?4,
                        next_attempt_at = CASE
                          WHEN ?3 = 'retryable' THEN datetime('now') ELSE NULL END
                  WHERE id = ?5 AND task_id = ?6 AND status = 'running'",
                params![
                    message,
                    failure_code,
                    retry_disposition,
                    FAILURE_POLICY_VERSION,
                    batch.attempt_id,
                    batch.task_id
                ],
            )?;
            if attempt_updated == 0 {
                return Ok(());
            }
            let task_status = if terminal { "failed" } else { "queued" };
            let task_updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = ?1, error_message = ?2,
                        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                        completed_at = CASE WHEN ?1 = 'failed' THEN datetime('now') ELSE NULL END,
                        version = version + 1
                  WHERE id = ?3 AND run_id = ?4 AND status = 'running'
                    AND lease_owner = ?5",
                params![
                    task_status,
                    message,
                    batch.task_id,
                    batch.run_id,
                    batch.lease_owner
                ],
            )?;
            anyhow::ensure!(
                task_updated == 1,
                "NEX_INCREMENTAL_FRESHNESS_LEASE_LOST: failed Attempt lost its Task lease"
            );
            if terminal {
                transition_run_status_in_tx(conn, &batch.run_id, NarrativeRunStatus::Failed)?;
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET terminal_reason_code = ?1
                      WHERE id = ?2 AND status = 'failed'",
                    params![failure_code, batch.run_id],
                )?;
            }
            let cursor_updated = conn.execute(
                "UPDATE narrative_change_cursors
                    SET lease_owner = NULL, lease_expires_at = NULL,
                        last_error = ?1, updated_at = datetime('now')
                  WHERE project_id = ?2 AND consumer_id = ?3
                    AND active_run_id = ?4 AND semantic_epoch_id = ?5
                    AND reserved_through_sequence = ?6",
                params![
                    message,
                    batch.project_id,
                    CURSOR_CONSUMER_ID,
                    batch.run_id,
                    batch.semantic_epoch_id,
                    batch.through_sequence_inclusive,
                ],
            )?;
            anyhow::ensure!(
                cursor_updated == 1,
                "NEX_INCREMENTAL_FRESHNESS_LEASE_LOST: failed Attempt lost its cursor reservation"
            );
            Ok(())
        })
    })
}

fn affected_source_identities(
    project_id: &str,
    events: &[NarrativeChangeEventRecord],
) -> anyhow::Result<Vec<String>> {
    let mut identities = BTreeSet::new();
    for event in events {
        if let Some(identity) = source_identity_for_event(project_id, event)? {
            identities.insert(identity);
        }
        if event_may_change_catalog_via_scene_anchor(event) {
            identities.insert(format!("project:codex-catalog:{project_id}"));
        }
    }
    Ok(identities.into_iter().collect())
}

fn source_identity_for_event(
    project_id: &str,
    event: &NarrativeChangeEventRecord,
) -> anyhow::Result<Option<String>> {
    let kind = event
        .object_key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("NEX_CHANGE_FEED_OBJECT_KEY_INVALID: kind is missing"))?;
    let required = |field: &str| -> anyhow::Result<&str> {
        event
            .object_key
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!("NEX_CHANGE_FEED_OBJECT_KEY_INVALID: {kind}.{field} is missing")
            })
    };
    Ok(match kind {
        "scene" => Some(format!("project:scene:{}", required("sceneId")?)),
        "temporal-projection" => Some(format!("projection:{}", required("projectionId")?)),
        "codex-entry"
        | "codex-relation"
        | "codex-phase"
        | "codex-detail-definition"
        | "codex-detail-value" => Some(format!("project:codex-catalog:{project_id}")),
        "component" if is_component_schema_change(event) => None,
        "component" => component_source_identity(project_id, required("componentId")?)?,
        // import-source is the transaction-level marker for creating a new
        // project.  It is not an import-capture/evidence Source identity;
        // the same transaction carries the concrete imported catalog events.
        "import-source" => {
            required("sourceSetId")?;
            None
        }
        "project"
        | "chronicle-event"
        | "plot-thread"
        | "plot-marker"
        | "plot-branch"
        | "foreshadow"
        | "foreshadow-setup"
        | "foreshadow-payoff"
        | "temporal-node"
        | "temporal-constraint"
        | "calendar" => None,
        other => {
            anyhow::bail!("NEX_CHANGE_FEED_OBJECT_KEY_UNSUPPORTED: no Source locator for '{other}'")
        }
    })
}

fn component_source_identity(
    project_id: &str,
    component_id: &str,
) -> anyhow::Result<Option<String>> {
    let Some((component_kind, persisted_id)) = component_id.split_once(':') else {
        return Ok(None);
    };
    let source_bearing = matches!(
        component_kind,
        "tree-node"
            | "tree_node"
            | "note"
            | "map-note"
            | "codex-detail-definition"
            | "codex-tag"
            | "codex-type"
            | "codex-detail-value"
            | "codex-entry-tag"
            | "codex_semantic_binding"
            | "temporal_projection"
    );
    if !source_bearing {
        return Ok(None);
    }
    anyhow::ensure!(
        !persisted_id.is_empty(),
        "NEX_CHANGE_FEED_OBJECT_KEY_INVALID: componentId persisted identity is missing"
    );
    Ok(match component_kind {
        "tree-node" | "tree_node" | "note" | "map-note" => {
            Some(format!("project:scene:{persisted_id}"))
        }
        "codex-detail-definition"
        | "codex-tag"
        | "codex-type"
        | "codex-detail-value"
        | "codex-entry-tag"
        | "codex_semantic_binding" => Some(format!("project:codex-catalog:{project_id}")),
        "temporal_projection" => Some(format!("projection:{persisted_id}")),
        _ => None,
    })
}

fn event_signals_by_source<'a>(
    project_id: &str,
    events: &'a [NarrativeChangeEventRecord],
) -> anyhow::Result<BTreeMap<String, SourceEventSignals<'a>>> {
    // No DB lookup is required for the mutable Sources whose event digest is
    // a valid comparison basis. Import Evidence is intentionally omitted:
    // the binding resolver owns its digest semantics. Reuse the locator so
    // Change Set and evaluation identities cannot drift for component-backed
    // Sources such as Codex types/tags.
    let mut result = BTreeMap::new();
    for event in events {
        if let Some(identity) = source_identity_for_event(project_id, event)? {
            upsert_event_signals(&mut result, identity, event);
        }
        if event_may_change_catalog_via_scene_anchor(event) {
            upsert_event_signals(
                &mut result,
                format!("project:codex-catalog:{project_id}"),
                event,
            );
        }
    }
    Ok(result)
}

fn upsert_event_signals<'a>(
    result: &mut BTreeMap<String, SourceEventSignals<'a>>,
    identity: String,
    event: &'a NarrativeChangeEventRecord,
) {
    let replaced = event_replaces_source_incarnation(event);
    result
        .entry(identity)
        .and_modify(|signals| {
            signals.latest = event;
            signals.incarnation_replaced |= replaced;
        })
        .or_insert(SourceEventSignals {
            latest: event,
            incarnation_replaced: replaced,
        });
}

fn event_may_change_catalog_via_scene_anchor(event: &NarrativeChangeEventRecord) -> bool {
    if event.mutation_kind != "delete" {
        return false;
    }
    match event.object_key.get("kind").and_then(Value::as_str) {
        Some("scene") => true,
        Some("component") => event
            .object_key
            .get("componentId")
            .and_then(Value::as_str)
            .is_some_and(|component_id| {
                ["tree-node:", "tree_node:", "note:", "map-note:"]
                    .iter()
                    .any(|prefix| component_id.starts_with(prefix))
            }),
        _ => false,
    }
}

fn apply_event_comparison_signals(
    comparison: &mut EdgeComparisonInput,
    edge: &DependencyEdge,
    signals: &SourceEventSignals<'_>,
) {
    let event = signals.latest;
    if signals.incarnation_replaced {
        comparison.current_revision_token = Some(format!("replaced:{}", event.event_id));
        comparison.current_digest = None;
    }
    if let Some(normalizer) = event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("normalizerVersion"))
        .and_then(Value::as_str)
    {
        comparison.normalizer_version_matches = normalizer == CANONICAL_TEXT_NORMALIZER_VERSION;
    }

    // A Feed event's before/after digest is a valid Edge comparison basis
    // only when the Edge's immutable stored token names the event's before
    // version and the live Source still names its after version. This
    // prevents a later, not-yet-reserved edit from laundering a stale Edge
    // into ExactContentRelocated while the background worker yields the DB.
    let stored_version = comparison
        .stored_revision_token
        .as_deref()
        .and_then(parse_leading_version);
    let current_version = comparison
        .current_revision_token
        .as_deref()
        .and_then(parse_leading_version);
    let event_versions_bound = matches!(
        (
            stored_version,
            event.before_version,
            current_version,
            event.after_version
        ),
        (Some(stored), Some(before), Some(current), Some(after))
            if stored == before && current == after
    );
    if event_versions_bound {
        comparison.stored_digest = event_digest(event, true);
        comparison.current_digest = event_digest(event, false);
    }

    // Future Edge producers may persist a structured range basis alongside
    // the first token.  Existing one-token arrays remain whole-Source reads.
    if let Ok(read_set) = serde_json::from_str::<Value>(&edge.read_set_json) {
        if let Some(metadata) = read_set.as_array().and_then(|values| values.get(1)) {
            if metadata.get("kind").and_then(Value::as_str) == Some("text-range") {
                comparison.read_set_overlaps = mapping_overlaps_range(event, metadata);
                comparison.anchor_matches = mapping_preserves_anchor(event, metadata);
                if let Some(normalizer) = metadata.get("normalizerVersion").and_then(Value::as_str)
                {
                    comparison.normalizer_version_matches &=
                        normalizer == CANONICAL_TEXT_NORMALIZER_VERSION;
                }
            }
        }
    }
}

fn event_replaces_source_incarnation(event: &NarrativeChangeEventRecord) -> bool {
    matches!(event.mutation_kind.as_str(), "create" | "restore")
        && matches!(
            event.object_key.get("kind").and_then(Value::as_str),
            Some("scene" | "temporal-projection")
        )
}

fn event_digest(event: &NarrativeChangeEventRecord, before: bool) -> Option<String> {
    let canonical_field = if before {
        "oldCanonicalDigest"
    } else {
        "newCanonicalDigest"
    };
    event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get(canonical_field))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            if before {
                event.before_digest.clone()
            } else {
                event.after_digest.clone()
            }
        })
}

fn mapping_overlaps_range(event: &NarrativeChangeEventRecord, metadata: &Value) -> bool {
    let mapping = event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("mapping"))
        .and_then(Value::as_object);
    let mapping_kind = mapping
        .and_then(|mapping| mapping.get("kind"))
        .and_then(Value::as_str);
    if mapping_kind == Some("whole-document") {
        // The writer explicitly says it has no coordinate map. That is not
        // evidence that a persisted range stopped overlapping the Source;
        // material content change still falls through to ordinary Stale,
        // while a persisted quote (when present) is checked separately.
        return true;
    }
    let Some(from) = metadata.get("from").and_then(Value::as_u64) else {
        return false;
    };
    let Some(to) = metadata.get("to").and_then(Value::as_u64) else {
        return false;
    };
    if mapping_kind == Some("canonical-diff") {
        // changedOldRanges identifies edited coordinates, not whether the
        // Consumer's range still exists in the new document. With no
        // delete/position semantics, canonical-diff cannot prove drift.
        return true;
    }
    event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("mapping"))
        .and_then(|mapping| mapping.get("segments"))
        .and_then(Value::as_array)
        .is_some_and(|segments| {
            segments.iter().any(|segment| {
                segment.get("behavior").and_then(Value::as_str) != Some("deleted")
                    && ranges_overlap(
                        from,
                        to,
                        segment
                            .get("oldRange")
                            .and_then(|range| range.get("from"))
                            .and_then(Value::as_u64),
                        segment
                            .get("oldRange")
                            .and_then(|range| range.get("to"))
                            .and_then(Value::as_u64),
                    )
            })
        })
}

fn mapping_preserves_anchor(event: &NarrativeChangeEventRecord, metadata: &Value) -> bool {
    let Some(anchor_digest) = metadata.get("anchorDigest").and_then(Value::as_str) else {
        return true;
    };
    let mapping_kind = event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("mapping"))
        .and_then(|mapping| mapping.get("kind"))
        .and_then(Value::as_str);
    if matches!(mapping_kind, Some("whole-document" | "canonical-diff")) {
        // Neither mapping carries quote-resolution evidence. Canonical-diff
        // can classify range overlap, but absence from its changed ranges is
        // not proof that the persisted quote disappeared.
        return true;
    }
    if event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("preservedAnchorDigests"))
        .and_then(Value::as_array)
        .is_some_and(|digests| {
            digests
                .iter()
                .any(|value| value.as_str() == Some(anchor_digest))
        })
    {
        return true;
    }
    let Some(from) = metadata.get("from").and_then(Value::as_u64) else {
        return false;
    };
    let Some(to) = metadata.get("to").and_then(Value::as_u64) else {
        return false;
    };
    event
        .text_impact
        .as_ref()
        .and_then(|impact| impact.get("mapping"))
        .and_then(|mapping| mapping.get("segments"))
        .and_then(Value::as_array)
        .is_some_and(|segments| {
            segments.iter().any(|segment| {
                if segment.get("behavior").and_then(Value::as_str) != Some("unchanged") {
                    return false;
                }
                let old_from = segment
                    .get("oldRange")
                    .and_then(|range| range.get("from"))
                    .and_then(Value::as_u64);
                let old_to = segment
                    .get("oldRange")
                    .and_then(|range| range.get("to"))
                    .and_then(Value::as_u64);
                matches!((old_from, old_to), (Some(old_from), Some(old_to)) if old_from <= from && to <= old_to)
            })
        })
}

fn ranges_overlap(from: u64, to: u64, other_from: Option<u64>, other_to: Option<u64>) -> bool {
    matches!((other_from, other_to), (Some(other_from), Some(other_to)) if from < other_to && other_from < to)
}

fn is_component_schema_change(event: &NarrativeChangeEventRecord) -> bool {
    event.object_key.get("kind").and_then(Value::as_str) == Some("component")
        && event
            .structural_impact
            .as_ref()
            .and_then(|impact| impact.get("event"))
            .and_then(Value::as_str)
            == Some("schema-component-changed")
}

fn requires_full_graph_evaluation(event: &NarrativeChangeEventRecord) -> bool {
    let kind = event.object_key.get("kind").and_then(Value::as_str);
    let structural_event = event
        .structural_impact
        .as_ref()
        .and_then(|impact| impact.get("event"))
        .and_then(Value::as_str);
    let requires_full_rebuild = event
        .structural_impact
        .as_ref()
        .and_then(|impact| impact.get("requiresFullRebuild"))
        .and_then(Value::as_bool)
        == Some(true);
    requires_full_rebuild
        && matches!(
            (kind, structural_event),
            (Some("component"), Some("schema-component-changed"))
                | (
                    Some("project"),
                    Some("project-restored" | "semantic-epoch-reset")
                )
        )
}

fn edge_producer_epoch_matches(
    conn: &Connection,
    edge: &DependencyEdge,
    semantic_epoch_id: &str,
) -> anyhow::Result<bool> {
    let Some(owning_run_id) = edge.owning_run_id.as_deref() else {
        return Ok(false);
    };
    conn.query_row(
        "SELECT COALESCE(semantic_epoch_id = ?1, 0)
           FROM narrative_extraction_runs
          WHERE id = ?2 AND project_id = ?3",
        params![semantic_epoch_id, owning_run_id, edge.project_id],
        |row| row.get(0),
    )
    .optional()
    .map(|matches| matches.unwrap_or(false))
    .map_err(Into::into)
}

fn all_project_edges(conn: &Connection, project_id: &str) -> anyhow::Result<Vec<DependencyEdge>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, consumer_kind, consumer_key, source_object_identity,
                read_set_json, generated_by_transaction_id, created_at, owning_run_id
           FROM narrative_dependency_edges
          WHERE project_id = ?1
          ORDER BY consumer_kind, consumer_key, source_object_identity",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok(DependencyEdge {
            id: row.get(0)?,
            project_id: row.get(1)?,
            consumer_kind: row.get(2)?,
            consumer_key: row.get(3)?,
            source_object_identity: row.get(4)?,
            read_set_json: row.get(5)?,
            generated_by_transaction_id: row.get(6)?,
            created_at: row.get(7)?,
            owning_run_id: row.get(8)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn load_edge_by_id(
    conn: &Connection,
    project_id: &str,
    edge_id: &str,
) -> anyhow::Result<Option<DependencyEdge>> {
    conn.query_row(
        "SELECT id, project_id, consumer_kind, consumer_key, source_object_identity,
                read_set_json, generated_by_transaction_id, created_at, owning_run_id
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND id = ?2",
        params![project_id, edge_id],
        |row| {
            Ok(DependencyEdge {
                id: row.get(0)?,
                project_id: row.get(1)?,
                consumer_kind: row.get(2)?,
                consumer_key: row.get(3)?,
                source_object_identity: row.get(4)?,
                read_set_json: row.get(5)?,
                generated_by_transaction_id: row.get(6)?,
                created_at: row.get(7)?,
                owning_run_id: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn has_changes_after(
    conn: &Connection,
    project_id: &str,
    through_sequence: i64,
) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM narrative_change_events
            WHERE project_id = ?1 AND canonical_sequence > ?2
         )",
        params![project_id, through_sequence],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn required_json_string<'a>(value: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("NEX_INCREMENTAL_FRESHNESS_RUN_INVALID: {key} is missing"))
}

fn parse_leading_version(token: &str) -> Option<i64> {
    token
        .strip_prefix('v')?
        .split_once('@')?
        .0
        .parse::<i64>()
        .ok()
}

fn digest_json(value: &Value) -> anyhow::Result<String> {
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(value)?))
    ))
}

fn now_string() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::super::declaration_storage::{
        write_dependency_declaration_set, DependencyDeclaration, DependencyDeclarationSetRequest,
    };
    use super::*;
    use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};

    const PROJECT_ID: &str = "project-c2-1-phase-cas";
    const EPOCH_ID: &str = "epoch-c2-1-phase-cas";
    const SCENE_ID: &str = "scene-c2-1-phase-cas";
    const EDGE_ID: &str = "edge-c2-1-phase-cas";
    const CONSUMER_RUN_ID: &str = "consumer-run-c2-1-phase-cas";
    const OCCURRED_AT: &str = "2026-08-19T00:00:00.000Z";
    const SOURCE_UPDATED_AT: &str = "2026-08-19T00:00:02.000Z";

    fn fixture_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open test database");
        db.migrate().expect("migrate test database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES (?1, 'C2-1 phase CAS')",
                [PROJECT_ID],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES (?1, ?2, 0, 'initial', ?3)",
                params![EPOCH_ID, PROJECT_ID, OCCURRED_AT],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, version, updated_at)
                 VALUES (?1, ?2, 'scene', 'CAS scene', '{}', 2, ?3)",
                params![SCENE_ID, PROJECT_ID, SOURCE_UPDATED_AT],
            )?;
            seed_completed_consumer_run(conn, CONSUMER_RUN_ID)?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, generated_by_transaction_id, created_at, owning_run_id)
                 VALUES (?1, ?2, 'narrative-extraction-run', ?3, ?4, ?5, NULL, ?6, ?3)",
                params![
                    EDGE_ID,
                    PROJECT_ID,
                    CONSUMER_RUN_ID,
                    format!("project:scene:{SCENE_ID}"),
                    r#"["v1@2026-08-19T00:00:01.000Z"]"#,
                    OCCURRED_AT,
                ],
            )?;
            seed_scene_change(conn)?;
            Ok(())
        })
        .expect("seed phase CAS fixture");
        db
    }

    fn seed_completed_consumer_run(conn: &Connection, run_id: &str) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind, semantic_epoch_id)
             VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', ?1,
                     'completed', '{}', ?3, ?3, 'interpretation', ?4)",
            params![run_id, PROJECT_ID, OCCURRED_AT, EPOCH_ID],
        )?;
        Ok(())
    }

    fn seed_scene_change(conn: &Connection) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO change_events
                (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id,
                 payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES ('canonical-phase-cas', ?1, ?2, 'scene', 'scene.update', 'scene', ?2,
                     '{}', 'c2-1-phase-cas', 1, 1787078400000,
                     'fixture-prev', 'fixture-hash')",
            params![PROJECT_ID, SCENE_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_change_transactions
                (id, project_id, request_id, source_domain, source_change_event_uid,
                 source_change_event_sequence, cause_kind, origin, application_ids_json,
                 payload_digest, created_at)
             VALUES ('transaction-phase-cas', ?1, 'request-phase-cas', 'scene.update',
                     'canonical-phase-cas', 1, 'forward', 'human', '[]',
                     'sha256:phase-cas-payload', ?2)",
            params![PROJECT_ID, OCCURRED_AT],
        )?;
        conn.execute(
            r#"INSERT INTO narrative_change_events
                (id, project_id, transaction_id, canonical_change_event_uid,
                 canonical_sequence, event_ordinal, object_key_json, change_kind,
                 mutation_kind, before_version, before_digest, after_version,
                 after_digest, changed_paths_json, text_impact_json,
                 structural_impact_json, occurred_at)
             VALUES ('event-phase-cas', ?1, 'transaction-phase-cas',
                     'canonical-phase-cas', 1, 0, ?2, 'content', 'update',
                     1, 'sha256:before', 2, 'sha256:after', '["/content"]',
                     '{"normalizerVersion":"gdx-canonical-text/1"}', NULL, ?3)"#,
            params![
                PROJECT_ID,
                format!(r#"{{"kind":"scene","sceneId":"{SCENE_ID}"}}"#),
                OCCURRED_AT,
            ],
        )?;
        Ok(())
    }

    fn seed_shadow_head(
        db: &Database,
        consumer_key: &str,
        source_object_identity: &str,
        expected_head_version: i64,
        producer_generation: i64,
    ) {
        write_dependency_declaration_set(
            db,
            DependencyDeclarationSetRequest {
                project_id: PROJECT_ID.to_owned(),
                consumer_kind: "narrative-extraction-run".to_owned(),
                consumer_key: consumer_key.to_owned(),
                producer_id: format!("nir0-d2-race-producer-{producer_generation}"),
                producer_generation,
                expected_head_version,
                declarations: vec![DependencyDeclaration {
                    source_object_identity: source_object_identity.to_owned(),
                    role: DependencyRole::DirectEvidence,
                    selector: DependencySelector::WholeSource,
                }],
                created_at: OCCURRED_AT.to_owned(),
            },
        )
        .expect("seed deterministic D2 head");
    }

    fn reserve_and_evaluate_batch(db: &Database) -> (ClaimedBatch, EvaluationPlan) {
        let reservation = db
            .with_conn(|conn| with_immediate_transaction(conn, reserve_or_resume_batch_in_tx))
            .expect("reserve deterministic Feed range");
        let ReservationOutcome::Claimed(batch) = reservation else {
            panic!("fixture must produce a claimed batch");
        };
        let plan = evaluate_batch(db, &batch).expect("evaluate claimed batch");
        (*batch, plan)
    }

    fn reserve_and_evaluate(db: &Database) -> (ClaimedBatch, EvaluationPlan) {
        let (batch, plan) = reserve_and_evaluate_batch(db);
        assert_eq!(plan.affected_edge_count, 1);
        (batch, plan)
    }

    fn assert_publish_rolled_back(db: &Database, batch: &ClaimedBatch) {
        db.with_conn(|conn| {
            let edge_state_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                [EDGE_ID],
                |row| row.get(0),
            )?;
            assert_eq!(
                edge_state_count, 0,
                "failed publish must not leave Edge State"
            );

            let consumer_state_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_key = ?2",
                params![PROJECT_ID, CONSUMER_RUN_ID],
                |row| row.get(0),
            )?;
            assert_eq!(
                consumer_state_count, 0,
                "failed publish must not leave a Consumer rollup"
            );

            let (acknowledged, active_run_id): (i64, Option<String>) = conn.query_row(
                "SELECT acknowledged_through_sequence, active_run_id
                   FROM narrative_change_cursors
                  WHERE project_id = ?1 AND consumer_id = ?2",
                params![PROJECT_ID, CURSOR_CONSUMER_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(
                acknowledged, 0,
                "failed publish must not advance the cursor"
            );
            assert_eq!(
                active_run_id.as_deref(),
                Some(batch.run_id.as_str()),
                "the reserved range must remain owned for retry"
            );
            Ok(())
        })
        .expect("inspect rolled-back publication");
    }

    #[test]
    fn publish_rejects_a_scene_source_token_changed_after_evaluation() {
        let db = fixture_db();
        let (batch, plan) = reserve_and_evaluate(&db);

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes
                    SET version = version + 1, updated_at = '2026-08-19T00:00:03.000Z'
                  WHERE id = ?1 AND project_id = ?2",
                params![SCENE_ID, PROJECT_ID],
            )?;
            Ok(())
        })
        .expect("mutate live Source after evaluation");

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect_err("source CAS must reject a stale evaluation plan");
        assert!(
            format!("{error:#}").contains("NEX_INCREMENTAL_FRESHNESS_SOURCE_CHANGED"),
            "unexpected publish failure: {error:#}"
        );
        assert_publish_rolled_back(&db, &batch);
    }

    #[test]
    fn evaluation_deduplicates_source_state_guards_for_shared_proposal_revisions() {
        let db = fixture_db();
        db.with_conn(|conn| {
            use super::super::dependency_edges::{
                record_dependency_edge_in_tx, PROPOSAL_REVISION_CONSUMER_KIND,
            };

            conn.execute(
                "DELETE FROM narrative_dependency_edges WHERE id = ?1 AND project_id = ?2",
                params![EDGE_ID, PROJECT_ID],
            )?;
            let source_object_identity = format!("project:scene:{SCENE_ID}");
            for revision_id in [
                "revision-c2-1-phase-cas-shared-1",
                "revision-c2-1-phase-cas-shared-2",
            ] {
                record_dependency_edge_in_tx(
                    conn,
                    PROJECT_ID,
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    revision_id,
                    &source_object_identity,
                    r#"["v1@2026-08-19T00:00:01.000Z"]"#,
                    None,
                    Some(CONSUMER_RUN_ID),
                    OCCURRED_AT,
                )?;
            }
            Ok(())
        })
        .expect("seed two writer-valid Proposal Revision Edges sharing the Source and owning Run");

        let (_batch, plan) = reserve_and_evaluate_batch(&db);
        assert_eq!(plan.affected_edge_count, 2);
        assert_eq!(plan.edge_declaration_guards.len(), 2);
        assert_eq!(plan.source_state_guards.len(), 1);
        assert_eq!(plan.producer_epoch_guards.len(), 2);
    }

    #[test]
    fn publish_rejects_an_edge_redeclared_after_evaluation() {
        let db = fixture_db();
        let (batch, plan) = reserve_and_evaluate(&db);

        db.with_conn(|conn| {
            let replacement_run_id = "consumer-run-c2-1-phase-cas-redeclared";
            seed_completed_consumer_run(conn, replacement_run_id)?;
            conn.execute(
                r#"UPDATE narrative_dependency_edges
                    SET read_set_json = '["v99@2026-08-19T00:00:03.000Z"]',
                        owning_run_id = ?1
                  WHERE id = ?2 AND project_id = ?3"#,
                params![replacement_run_id, EDGE_ID, PROJECT_ID],
            )?;
            Ok(())
        })
        .expect("redeclare Dependency Edge after evaluation");

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect_err("edge CAS must reject a stale evaluation plan");
        assert!(
            format!("{error:#}").contains("NEX_INCREMENTAL_FRESHNESS_EDGE_CHANGED"),
            "unexpected publish failure: {error:#}"
        );
        assert_publish_rolled_back(&db, &batch);
    }

    #[test]
    fn publish_rejects_an_unknown_consumer_edge_redeclared_after_evaluation() {
        let db = fixture_db();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET consumer_kind = 'application-contribution',
                        consumer_key = 'reserved-consumer',
                        owning_run_id = NULL
                  WHERE id = ?1 AND project_id = ?2",
                params![EDGE_ID, PROJECT_ID],
            )?;
            Ok(())
        })
        .expect("seed a reserved Consumer Edge");
        let (batch, plan) = reserve_and_evaluate(&db);

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET read_set_json = '[\"v99@2026-08-19T00:00:03.000Z\"]'
                  WHERE id = ?1 AND project_id = ?2",
                params![EDGE_ID, PROJECT_ID],
            )?;
            Ok(())
        })
        .expect("redeclare the reserved Consumer Edge after evaluation");

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect_err("unknown Consumer Edge CAS must reject a stale plan");
        assert!(
            format!("{error:#}").contains("NEX_INCREMENTAL_FRESHNESS_EDGE_CHANGED"),
            "unexpected publish failure: {error:#}"
        );
        assert_publish_rolled_back(&db, &batch);
    }

    #[test]
    fn publish_rejects_a_new_affected_v2_head_after_evaluation() {
        let db = fixture_db();
        let (batch, plan) = reserve_and_evaluate(&db);
        seed_shadow_head(
            &db,
            CONSUMER_RUN_ID,
            &format!("project:scene:{SCENE_ID}"),
            0,
            1,
        );

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect_err("new affected V2 head must invalidate the publication plan");
        assert!(
            format!("{error:#}").contains("NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED"),
            "unexpected publish failure: {error:#}"
        );
        assert_publish_rolled_back(&db, &batch);
    }

    #[test]
    fn publish_rejects_an_affected_v2_head_changed_after_evaluation() {
        let db = fixture_db();
        seed_shadow_head(
            &db,
            CONSUMER_RUN_ID,
            &format!("project:scene:{SCENE_ID}"),
            0,
            1,
        );
        let (batch, plan) = reserve_and_evaluate(&db);
        seed_shadow_head(
            &db,
            CONSUMER_RUN_ID,
            &format!("project:scene:{SCENE_ID}"),
            1,
            2,
        );

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect_err("changed affected V2 head must invalidate the publication plan");
        assert!(
            format!("{error:#}").contains("NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED"),
            "unexpected publish failure: {error:#}"
        );
        assert_publish_rolled_back(&db, &batch);
    }

    #[test]
    fn unrelated_v2_head_change_does_not_block_v1_publication() {
        let db = fixture_db();
        let (batch, plan) = reserve_and_evaluate(&db);
        seed_shadow_head(
            &db,
            "unrelated-v2-consumer",
            "project:scene:unrelated-v2-scene",
            0,
            1,
        );

        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
        })
        .expect("unrelated V2 head must stay outside the bounded publication guard");

        db.with_conn(|conn| {
            let acknowledged: i64 = conn.query_row(
                "SELECT acknowledged_through_sequence
                   FROM narrative_change_cursors
                  WHERE project_id = ?1 AND consumer_id = ?2",
                params![PROJECT_ID, CURSOR_CONSUMER_ID],
                |row| row.get(0),
            )?;
            anyhow::ensure!(acknowledged == 1, "the V1 cursor must be acknowledged");
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect V1 acknowledgement after unrelated V2 head drift");
    }
}
