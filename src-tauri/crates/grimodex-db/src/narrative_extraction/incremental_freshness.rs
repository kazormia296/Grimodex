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
use std::time::{Duration, Instant};

use crate::{read_sqlite_source_revision, Database};
use grimodex_core::narrative_dependency::{
    aggregate_dependency_build_actions, evaluate_dependency_effect, load_dependency_role_registry,
    DependencyEffectInput, DependencyEffectRegistry, DependencyRole,
    EvidenceFreshness as V2EvidenceFreshness, SourceChangeClass,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::change_feed::{
    get_changes_since, NarrativeChangeEventRecord, CANONICAL_TEXT_NORMALIZER_VERSION,
};
use super::commit::digest_plan;
use super::consumer_identity::{
    is_declared_consumer_kind, is_reserved_semantic_index_consumer_kind, APPLICATION_CONSUMER_KIND,
};
use super::cursor_reservation::{
    acknowledge_cursor_reservation_in_tx, release_cursor_reservation_in_tx,
    reserve_cursor_range_in_tx,
};
use super::declaration_storage::{
    list_broken_dependency_declaration_head_keys_in_tx,
    list_dependency_declaration_head_keys_for_sources_in_tx,
    list_dependency_declaration_head_keys_in_tx, read_active_dependency_declaration_set_in_tx,
    verify_active_dependency_declaration_set_unchanged_in_conn, ActiveDependencyDeclarationSet,
    ActiveDependencyDeclarationSetRead,
};
use super::dependency_edges::{find_edges_by_consumer, find_edges_by_source, DependencyEdge};
use super::evaluator::{
    evaluate_edge, unknown_edge_observation, EdgeComparisonInput, EdgeObservation,
};
use super::execution_state::{
    next_run_lifecycle_timestamp_in_tx, parse_run_lifecycle_instant, supersede_run_in_tx,
    transition_run_status_in_tx, NarrativeRunStatus,
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
const IDLE_CHECKPOINT_KIND: &str = "current-epoch-idle-checkpoint";
const IDLE_CHECKPOINT_VERSION: i64 = 1;
const MAX_CANONICAL_SEQUENCES_PER_BATCH: i64 = 32;
const TASK_LEASE_DURATION_SECS: i64 = 300;
const FAILURE_POLICY_VERSION: &str = "v1";
pub(crate) const MAX_ATTEMPTS_PER_BATCH: i64 = 3;
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

/// Linear proof that one bounded Incremental Freshness cycle completed
/// without an error. Its constructor is private: scheduler liveness can only
/// be registered by consuming a capability returned from the real cycle,
/// never by a public arbitrary heartbeat call.
#[derive(Debug)]
pub struct SuccessfulIncrementalFreshnessCycle {
    connection_epoch: String,
    completed_at: Instant,
    _private: (),
}

impl SuccessfulIncrementalFreshnessCycle {
    pub(crate) fn connection_epoch(&self) -> &str {
        &self.connection_epoch
    }

    pub(crate) fn is_fresh_for_liveness(&self, max_age: Duration) -> bool {
        self.completed_at.elapsed() <= max_age
    }
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
    idle_checkpoint: bool,
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
    v2_shadow_scope: V2ShadowSelectionScope,
    v2_shadow: IncrementalFreshnessShadowSummary,
}

impl EvaluationPlan {
    fn empty() -> Self {
        Self {
            by_consumer: BTreeMap::new(),
            affected_edge_count: 0,
            edge_declaration_guards: Vec::new(),
            source_state_guards: Vec::new(),
            producer_epoch_guards: Vec::new(),
            v2_declaration_guards: Vec::new(),
            v2_declaration_head_keys: Vec::new(),
            v2_declaration_head_snapshots: Vec::new(),
            v2_shadow_scope: V2ShadowSelectionScope::SourceBounded(Vec::new()),
            v2_shadow: IncrementalFreshnessShadowSummary::default(),
        }
    }
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
    change_class_override: Option<SourceChangeClass>,
}

/// Selects the D1 head set that a Feed evaluation is allowed to observe.
/// Ordinary mutations stay source-bounded. Ratified global markers have no
/// Source locator by design, so their selection is project-wide and every
/// selected head participates in the publish-time drift guard.
#[derive(Clone, Debug, Eq, PartialEq)]
enum V2ShadowSelectionScope {
    SourceBounded(Vec<String>),
    ComponentSchemaGlobal,
    ProjectResetGlobal,
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

/// Run a bounded Freshness cycle and return the one-use liveness capability
/// only if it completed successfully. The caller may perform its own live
/// authority/binding recheck before consuming the capability to register the
/// C2-ZC scheduler receipt.
pub fn run_incremental_freshness_cycle_with_liveness_capability(
    db: &Database,
) -> anyhow::Result<(
    IncrementalFreshnessCycleOutcome,
    SuccessfulIncrementalFreshnessCycle,
)> {
    let outcome = run_incremental_freshness_cycle(db)?;
    let completed_at = Instant::now();
    // The capability must belong to the same live SQLite authority that will
    // mint the scheduler receipt.  Capturing its connection epoch here keeps
    // a completed cycle from another Database wrapper from being reused as
    // liveness proof for this workspace.
    let connection_epoch =
        db.with_conn(|conn| Ok(read_sqlite_source_revision(conn)?.connection_epoch))?;
    Ok((
        outcome,
        SuccessfulIncrementalFreshnessCycle {
            connection_epoch,
            completed_at,
            _private: (),
        },
    ))
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
    let plan = match if batch.idle_checkpoint {
        Ok(EvaluationPlan::empty())
    } else {
        evaluate_batch(db, &batch)
    } {
        Ok(plan) => plan,
        Err(error) => {
            requeue_after_failure(db, &batch, &error)?;
            return Err(error);
        }
    };

    let publish_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
    });
    let v2_shadow_drift = match publish_result {
        Ok(drift) => drift,
        Err(error) => {
            // A stale Epoch/reservation intentionally cannot publish.
            // Requeue is best effort and CAS-scoped to this attempt, so it
            // cannot disturb a newer owner that won the race.
            requeue_after_failure(db, &batch, &error)?;
            return Err(error);
        }
    };
    // Shadow-input drift discards the now-stale D2 summary but keeps its
    // diagnostic observable: the V1 publication above committed either way.
    let v2_shadow = match v2_shadow_drift {
        None => plan.v2_shadow,
        Some(diagnostic) => {
            let mut discarded = plan.v2_shadow;
            discarded.consumers.clear();
            discarded.diagnostics.push(diagnostic);
            discarded
        }
    };

    Ok(IncrementalFreshnessCycleOutcome::Processed(
        IncrementalFreshnessBatchSummary {
            project_id: batch.project_id,
            run_id: batch.run_id,
            from_sequence_exclusive: batch.from_sequence_exclusive,
            through_sequence_inclusive: batch.through_sequence_inclusive,
            affected_edge_count: plan.affected_edge_count,
            affected_consumer_count: plan.by_consumer.len(),
            has_more: batch.has_more,
            v2_shadow,
        },
    ))
}

fn reserve_or_resume_batch_in_tx(conn: &Connection) -> anyhow::Result<ReservationOutcome> {
    let Some(project_id) = select_next_project(conn)? else {
        let Some((project_id, semantic_epoch_id, feed_head)) =
            select_idle_checkpoint_project(conn)?
        else {
            return Ok(ReservationOutcome::Idle);
        };
        return create_and_claim_idle_checkpoint_in_tx(
            conn,
            &project_id,
            &semantic_epoch_id,
            feed_head,
        );
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

#[derive(Debug)]
struct IdleCheckpointCursorState {
    acknowledged_through_sequence: i64,
    lease_owner: Option<String>,
    lease_expires_at: Option<String>,
    last_error: Option<String>,
    reserved_through_sequence: Option<i64>,
    active_run_id: Option<String>,
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

/// Find one project whose current Epoch has no Feed work left but still lacks
/// a current-Epoch Freshness Run. The zero-width checkpoint is intentionally
/// conservative: a missing cursor is valid only for an empty Feed, while an
/// existing cursor must be fully acknowledged, unreserved, lease-free, and
/// error-free. Any current-Epoch Freshness Run, including a failed or
/// cancelled one, blocks the checkpoint so a malformed history cannot be
/// papered over by a new success row.
fn select_idle_checkpoint_project(
    conn: &Connection,
) -> anyhow::Result<Option<(String, String, i64)>> {
    let mut statement = conn.prepare(
        "SELECT project.id, epoch.id,
                COALESCE((SELECT MAX(event.canonical_sequence)
                            FROM narrative_change_events event
                           WHERE event.project_id = project.id), 0)
           FROM projects project
           JOIN narrative_semantic_epochs epoch
             ON epoch.project_id = project.id
            AND epoch.epoch_number = (
                SELECT MAX(current.epoch_number)
                  FROM narrative_semantic_epochs current
                 WHERE current.project_id = project.id
            )
           LEFT JOIN narrative_change_cursors cursor
             ON cursor.project_id = project.id
            AND cursor.consumer_id = ?1
          WHERE NOT EXISTS (
                SELECT 1
                  FROM narrative_extraction_runs run
                 WHERE run.project_id = project.id
                   AND run.run_kind = 'freshness-evaluation'
                   AND run.semantic_epoch_id = epoch.id
            )
            AND (
              (
                cursor.project_id IS NULL
                AND COALESCE((SELECT MAX(event.canonical_sequence)
                                FROM narrative_change_events event
                               WHERE event.project_id = project.id), 0) = 0
              )
              OR (
                cursor.acknowledged_through_sequence =
                  COALESCE((SELECT MAX(event.canonical_sequence)
                              FROM narrative_change_events event
                             WHERE event.project_id = project.id), 0)
                AND COALESCE(cursor.last_error, '') = ''
                AND cursor.lease_owner IS NULL
                AND cursor.lease_expires_at IS NULL
                AND cursor.active_run_id IS NULL
                AND cursor.reserved_through_sequence IS NULL
                AND cursor.semantic_epoch_id IS NULL
              )
            )
          ORDER BY project.id ASC
          LIMIT 1",
    )?;
    let row = statement
        .query_row([CURSOR_CONSUMER_ID], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .optional()?;
    Ok(row)
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

fn create_and_claim_idle_checkpoint_in_tx(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    feed_head: i64,
) -> anyhow::Result<ReservationOutcome> {
    anyhow::ensure!(
        feed_head >= 0,
        "NEX_INCREMENTAL_FRESHNESS_FEED_HEAD_INVALID"
    );
    let live_feed_head = current_feed_head(conn, project_id)?;
    anyhow::ensure!(
        live_feed_head == feed_head,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_STALE: Feed head changed before reservation"
    );
    let epoch = get_current_epoch(conn, project_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_EPOCH_MISSING: project '{project_id}' has no current Semantic Epoch"
        )
    })?;
    anyhow::ensure!(
        epoch.id == semantic_epoch_id,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_EPOCH_STALE: current Semantic Epoch changed before reservation"
    );
    ensure_idle_checkpoint_cursor_is_clean(conn, project_id, feed_head)?;
    ensure_no_current_epoch_incremental_run(conn, project_id, semantic_epoch_id)?;

    let input_payload = json!({
        "kind": IDLE_CHECKPOINT_KIND,
        "version": IDLE_CHECKPOINT_VERSION,
        "projectId": project_id,
        "semanticEpochId": semantic_epoch_id,
        "fromSequenceExclusive": feed_head,
        "throughSequenceInclusive": feed_head,
        "feedHead": feed_head,
    });
    let input_digest = idle_checkpoint_digest(&input_payload);
    let task_input = idle_checkpoint_task_input(&input_payload, &input_digest)?;
    let spec_json = json!({
        "kind": "incremental-freshness-idle-checkpoint@1",
        "inputDigest": input_digest,
    });
    let spec_digest = idle_checkpoint_digest(&spec_json);
    let work_key = format!(
        "incremental-freshness:{semantic_epoch_id}:{feed_head}:{feed_head}:{}",
        input_digest.trim_start_matches("sha256:")
    );
    let created = create_system_run_in_tx(
        conn,
        project_id,
        "freshness-evaluation",
        semantic_epoch_id,
        &work_key,
        &spec_json,
        &spec_digest,
        SystemRunWorkKeyReuse::None,
        None,
    )?;
    let run_id = required_json_string(&created, "runId")?.to_string();
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
        feed_head,
    )?;
    ensure_idle_checkpoint_task_in_tx(conn, &run_id, &task_input)?;
    let claimed = claim_reserved_batch_in_tx(
        conn,
        project_id,
        semantic_epoch_id,
        &run_id,
        feed_head,
        feed_head,
        Vec::new(),
        None,
        false,
    )?;
    anyhow::ensure!(
        matches!(claimed, ReservationOutcome::Claimed(ref batch) if batch.idle_checkpoint),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_CLAIM_FAILED: checkpoint Task was not claimable"
    );
    Ok(claimed)
}

fn idle_checkpoint_task_input(payload: &Value, input_digest: &str) -> anyhow::Result<Value> {
    let mut input = payload
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("idle checkpoint payload must be an object"))?
        .clone();
    input.insert(
        "inputDigest".to_owned(),
        Value::String(input_digest.to_owned()),
    );
    Ok(Value::Object(input))
}

fn ensure_idle_checkpoint_task_in_tx(
    conn: &Connection,
    run_id: &str,
    task_input: &Value,
) -> anyhow::Result<()> {
    let task_id = format!("{run_id}:batch");
    // Task/Attempt timestamps are part of the idle checkpoint's readiness
    // envelope.  Use the project-scoped Run lifecycle allocator rather than
    // wall-clock time so an imported/future Run cannot make its own producer
    // evidence appear causally inverted.
    let created_at = idle_checkpoint_lifecycle_timestamp_in_tx(conn, run_id)?;
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority,
             attempt_count, created_at, version)
         VALUES (?1, ?2, ?3, 'queued', ?4, 100, 0, ?5, 0)",
        params![
            task_id,
            run_id,
            TASK_KIND,
            serde_json::to_string(task_input)?,
            created_at,
        ],
    )?;
    Ok(())
}

/// Return a canonical lifecycle instant for an idle checkpoint entity.
///
/// Automatic system Runs use a project-wide lifecycle allocator because an
/// imported workspace may legitimately contain future-dated Run evidence.
/// Idle Task/Attempt rows must share that authority: a wall-clock timestamp
/// is not a valid lower bound when the owning Run starts in the future.  Include
/// existing idle Task/Attempt timestamps as well so retries and recovery never
/// move the envelope backwards, while leaving ordinary Feed timestamps on
/// their existing path.
fn idle_checkpoint_lifecycle_timestamp_in_tx(
    conn: &Connection,
    run_id: &str,
) -> anyhow::Result<String> {
    let project_id: String = conn.query_row(
        "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let allocator_timestamp = next_run_lifecycle_timestamp_in_tx(conn, &project_id)?;
    let mut latest = parse_run_lifecycle_instant(&allocator_timestamp)?;

    let mut task_statement = conn.prepare(
        "SELECT created_at, started_at, completed_at
           FROM narrative_extraction_tasks
          WHERE run_id = ?1",
    )?;
    let tasks = task_statement.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    for task in tasks {
        let (created_at, started_at, completed_at) = task?;
        for value in [Some(created_at), started_at, completed_at]
            .into_iter()
            .flatten()
        {
            latest = latest.max(parse_run_lifecycle_instant(&value)?);
        }
    }

    let mut attempt_statement = conn.prepare(
        "SELECT attempt.started_at, attempt.completed_at
           FROM narrative_extraction_attempts attempt
           JOIN narrative_extraction_tasks task ON task.id = attempt.task_id
          WHERE task.run_id = ?1",
    )?;
    let attempts = attempt_statement.query_map([run_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for attempt in attempts {
        let (started_at, completed_at) = attempt?;
        for value in [Some(started_at), completed_at].into_iter().flatten() {
            latest = latest.max(parse_run_lifecycle_instant(&value)?);
        }
    }

    Ok(latest.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn current_feed_head(conn: &Connection, project_id: &str) -> anyhow::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0)
           FROM narrative_change_events
          WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn ensure_idle_checkpoint_cursor_is_clean(
    conn: &Connection,
    project_id: &str,
    feed_head: i64,
) -> anyhow::Result<()> {
    let cursor: Option<IdleCheckpointCursorState> = conn
        .query_row(
            "SELECT acknowledged_through_sequence, lease_owner, lease_expires_at,
                    last_error, reserved_through_sequence, active_run_id
               FROM narrative_change_cursors
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![project_id, CURSOR_CONSUMER_ID],
            |row| {
                Ok(IdleCheckpointCursorState {
                    acknowledged_through_sequence: row.get(0)?,
                    lease_owner: row.get(1)?,
                    lease_expires_at: row.get(2)?,
                    last_error: row.get(3)?,
                    reserved_through_sequence: row.get(4)?,
                    active_run_id: row.get(5)?,
                })
            },
        )
        .optional()?;
    let Some(cursor) = cursor else {
        anyhow::ensure!(
            feed_head == 0,
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_CURSOR_MISSING: non-empty Feed requires a cursor"
        );
        return Ok(());
    };
    anyhow::ensure!(
        cursor.acknowledged_through_sequence == feed_head,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_CURSOR_NOT_AT_HEAD: acknowledged {}, feed head {feed_head}",
        cursor.acknowledged_through_sequence
    );
    anyhow::ensure!(
        cursor.lease_owner.is_none()
            && cursor.lease_expires_at.is_none()
            && cursor.reserved_through_sequence.is_none()
            && cursor.active_run_id.is_none()
            && cursor
                .last_error
                .as_deref()
                .is_none_or(|error| error.trim().is_empty()),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_CURSOR_NOT_CLEAN: cursor has an active reservation, lease, or error"
    );
    Ok(())
}

fn ensure_no_current_epoch_incremental_run(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<()> {
    let existing: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM narrative_extraction_runs
            WHERE project_id = ?1
              AND run_kind = 'freshness-evaluation'
              AND semantic_epoch_id = ?2
         )",
        params![project_id, semantic_epoch_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        !existing,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_RUN_EXISTS: current Epoch already has a Freshness Run"
    );
    Ok(())
}

fn resume_active_batch_in_tx(
    conn: &Connection,
    project_id: &str,
    semantic_epoch_id: &str,
    active: ActiveReservation,
) -> anyhow::Result<ReservationOutcome> {
    let idle_checkpoint = idle_checkpoint_intent_in_tx(conn, &active, semantic_epoch_id)?;
    let exhausted_interrupted_task: Option<String> = conn
        .query_row(
            "SELECT id
               FROM narrative_extraction_tasks
              WHERE run_id = ?1 AND status = 'running'
                AND attempt_count >= ?2
                AND lease_expires_at IS NOT NULL
                AND julianday(lease_expires_at) < julianday('now')
              LIMIT 1",
            params![active.run_id, MAX_ATTEMPTS_PER_BATCH],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(task_id) = exhausted_interrupted_task {
        let message = "incremental Freshness worker was interrupted and exhausted its retry budget";
        let task_updated = if idle_checkpoint {
            let lifecycle_at = idle_checkpoint_lifecycle_timestamp_in_tx(conn, &active.run_id)?;
            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed', completed_at = ?1,
                        error_message = ?2,
                        failure_code = 'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED',
                        retry_disposition = 'terminal', policy_version = ?3,
                        next_attempt_at = NULL
                  WHERE status = 'running' AND task_id = ?4",
                params![lifecycle_at, message, FAILURE_POLICY_VERSION, task_id],
            )?;
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'failed', error_message = ?1,
                        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                        completed_at = ?2, version = version + 1
                  WHERE id = ?3 AND run_id = ?4 AND status = 'running'",
                params![message, lifecycle_at, task_id, active.run_id],
            )?
        } else {
            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        error_message = ?1,
                        failure_code = 'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED',
                        retry_disposition = 'terminal', policy_version = ?2,
                        next_attempt_at = NULL
                  WHERE status = 'running' AND task_id = ?3",
                params![message, FAILURE_POLICY_VERSION, task_id],
            )?;
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'failed', error_message = ?1,
                        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
                  WHERE id = ?2 AND run_id = ?3 AND status = 'running'",
                params![message, task_id, active.run_id],
            )?
        };
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

    // claim_next_task can reclaim an expired Task but does not terminalize
    // the displaced Attempt.  Close it first so recovery never leaves two
    // durable `running` Attempts for one Task.
    if idle_checkpoint {
        let lifecycle_at = idle_checkpoint_lifecycle_timestamp_in_tx(conn, &active.run_id)?;
        conn.execute(
            "UPDATE narrative_extraction_attempts
                SET status = 'failed', completed_at = ?1,
                    error_message = 'incremental Freshness worker was interrupted',
                    failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED',
                    retry_disposition = 'retryable', policy_version = ?2,
                    next_attempt_at = ?1
              WHERE status = 'running'
                AND task_id IN (
                  SELECT id FROM narrative_extraction_tasks
                   WHERE run_id = ?3 AND status = 'running'
                     AND lease_expires_at IS NOT NULL
                     AND julianday(lease_expires_at) < julianday('now')
                )",
            params![lifecycle_at, FAILURE_POLICY_VERSION, active.run_id],
        )?;
    } else {
        conn.execute(
            "UPDATE narrative_extraction_attempts
                SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    error_message = 'incremental Freshness worker was interrupted',
                    failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED',
                    retry_disposition = 'retryable', policy_version = ?1,
                    next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE status = 'running'
                AND task_id IN (
                  SELECT id FROM narrative_extraction_tasks
                   WHERE run_id = ?2 AND status = 'running'
                     AND lease_expires_at IS NOT NULL
                     AND julianday(lease_expires_at) < julianday('now')
                )",
            params![FAILURE_POLICY_VERSION, active.run_id],
        )?;
    }

    if idle_checkpoint {
        anyhow::ensure!(
            active.acknowledged_through_sequence == active.through_sequence,
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SHAPE_INVALID: resumed checkpoint is not zero-width"
        );
        anyhow::ensure!(
            current_feed_head(conn, project_id)? == active.through_sequence,
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_STALE: Feed head changed before resume"
        );
        return claim_reserved_batch_in_tx(
            conn,
            project_id,
            semantic_epoch_id,
            &active.run_id,
            active.acknowledged_through_sequence,
            active.through_sequence,
            Vec::new(),
            None,
            false,
        );
    }

    let prepared = prepare_reserved_change_events(
        conn,
        project_id,
        &active.run_id,
        active.acknowledged_through_sequence,
        active.through_sequence,
    );
    let has_more = has_changes_after(conn, project_id, active.through_sequence)?;

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
    let task_kinds = if from_sequence_exclusive == through_sequence_inclusive {
        // A zero-width reservation is the idle-checkpoint seam.  Claim any
        // task attached to that reservation so a corrupted task_kind cannot
        // divert recovery into the normal Feed branch; publication then
        // rejects the malformed lifecycle through the strict idle validator.
        None
    } else {
        Some(vec![TASK_KIND.to_string()])
    };
    let Some(claimed) = claim_next_task(
        conn,
        &ClaimTaskPayload {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            lease_owner: lease_owner.clone(),
            lease_duration_secs: Some(TASK_LEASE_DURATION_SECS),
            task_kinds,
        },
    )?
    else {
        return Ok(ReservationOutcome::Idle);
    };
    let idle_checkpoint = from_sequence_exclusive == through_sequence_inclusive
        || task_input_has_idle_checkpoint_tag(&claimed.input_json);
    if idle_checkpoint {
        let lifecycle_at = idle_checkpoint_lifecycle_timestamp_in_tx(conn, run_id)?;
        if claimed.attempt_number == 1 {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET started_at = ?1
                  WHERE id = ?2 AND run_id = ?3 AND status = 'running'",
                params![lifecycle_at, claimed.task_id, run_id],
            )?;
        }
        conn.execute(
            "UPDATE narrative_extraction_attempts
                SET started_at = ?1
              WHERE id = ?2 AND task_id = ?3 AND status = 'running'",
            params![lifecycle_at, claimed.attempt_id, claimed.task_id],
        )?;
    }
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
        idle_checkpoint,
    })))
}

fn idle_checkpoint_intent_in_tx(
    conn: &Connection,
    active: &ActiveReservation,
    semantic_epoch_id: &str,
) -> anyhow::Result<bool> {
    let (spec_json, work_key): (String, String) = conn.query_row(
        "SELECT spec_json, work_key
           FROM narrative_extraction_runs
          WHERE id = ?1",
        [active.run_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let spec_is_idle = serde_json::from_str::<Value>(&spec_json)
        .ok()
        .and_then(|spec| spec.get("kind").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some("incremental-freshness-idle-checkpoint@1");
    let work_key_prefix = format!(
        "incremental-freshness:{semantic_epoch_id}:{}:{}:",
        active.acknowledged_through_sequence, active.through_sequence
    );
    let work_key_is_idle = work_key
        .strip_prefix(&work_key_prefix)
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        });
    let task_exists: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM narrative_extraction_tasks
            WHERE run_id = ?1
         )",
        params![active.run_id],
        |row| row.get(0),
    )?;
    if !task_exists || active.acknowledged_through_sequence != active.through_sequence {
        return Ok(false);
    }
    if spec_is_idle || work_key_is_idle {
        return Ok(true);
    }
    // A zero-width reservation cannot be represented by a Change Set (the
    // schema requires through > from). Treat a malformed idle descriptor as
    // an idle intent too, so publication reaches the strict tagged-input
    // validator and requeues/terminalizes instead of taking the normal Feed
    // path and accidentally bypassing the checkpoint contract.
    Ok(true)
}

fn task_input_has_idle_checkpoint_tag(input_json: &str) -> bool {
    serde_json::from_str::<Value>(input_json)
        .ok()
        .and_then(|input| input.get("kind").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some(IDLE_CHECKPOINT_KIND)
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
    let v2_shadow_scope = select_v2_shadow_scope(&batch.events, signals.keys().cloned());
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
                signal
                    .change_class_override
                    .unwrap_or_else(|| source_change_class_from_feed_event(signal.latest)),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut affected_edge_count = 0;
    for (index, edge) in edges.values().enumerate() {
        if index % LEASE_HEARTBEAT_EDGE_INTERVAL == 0 {
            renew_batch_lease(db, batch)?;
        }
        edge_declaration_guards.push(edge.clone());
        if is_reserved_semantic_index_consumer_kind(&edge.consumer_kind) {
            // The Semantic Index owns its metadata/D1/V1 surface. Keep the
            // Edge declaration CAS guard, but do not route this reserved Edge
            // through the Generic Freshness evaluator or publisher.
            continue;
        }
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
            &v2_shadow_scope,
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
        v2_shadow_scope,
        v2_shadow,
    })
}

fn select_v2_shadow_scope<I>(
    events: &[NarrativeChangeEventRecord],
    source_identities: I,
) -> V2ShadowSelectionScope
where
    I: Iterator<Item = String>,
{
    if events.iter().any(is_project_epoch_reset_marker) {
        return V2ShadowSelectionScope::ProjectResetGlobal;
    }
    if events.iter().any(is_component_schema_change) {
        return V2ShadowSelectionScope::ComponentSchemaGlobal;
    }
    V2ShadowSelectionScope::SourceBounded(source_identities.collect())
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
    // Role narrowing applies only to ordinary content changes. Missing or
    // broken evidence (a deleted Source, a lost anchor, a collapsed selected
    // set, an unavailable component) is a fact about the input's existence,
    // not about how the role consumes its content — a quality/ranking role
    // must not weaken it into an advisory content-change class.
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
    // A Source-level fact stronger than any selector narrowing is decided
    // before selector proofs are demanded: a deleted Source needs no range
    // overlap or anchor proof — its declaration is missing regardless of
    // which range of it was selected. Without this, a delete event (which
    // carries no position map) degrades SourceMissing into Unknown/manual.
    if matches!(
        base,
        SourceChangeClass::SourceMissing | SourceChangeClass::ComponentUnavailable
    ) {
        return Ok(base);
    }
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
    // Overlap without a containment or deletion verdict is no evidence either
    // way, exactly like no overlap at all.
    ShadowAnchorEvidence::Unknown
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

fn selected_v2_shadow_head_keys_in_tx(
    conn: &Connection,
    project_id: &str,
    selection_scope: &V2ShadowSelectionScope,
) -> anyhow::Result<Vec<(String, String)>> {
    match selection_scope {
        V2ShadowSelectionScope::SourceBounded(source_identities) => {
            let mut keys = list_dependency_declaration_head_keys_for_sources_in_tx(
                conn,
                project_id,
                source_identities,
            )?;
            // The source-bounded lookup INNER-joins Head -> Set -> Entry, so
            // a head whose set or entries are missing can never be selected
            // by it. Append those broken heads to every bounded selection:
            // the verified reader then surfaces them as Corrupt diagnostics
            // and publication guards instead of leaving corruption
            // unobservable under ordinary Source mutations.
            let broken = list_broken_dependency_declaration_head_keys_in_tx(conn, project_id)?;
            for key in broken {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            keys.sort();
            Ok(keys)
        }
        V2ShadowSelectionScope::ComponentSchemaGlobal
        | V2ShadowSelectionScope::ProjectResetGlobal => {
            list_dependency_declaration_head_keys_in_tx(conn, project_id)
        }
    }
}

#[allow(clippy::type_complexity)]
fn evaluate_v2_shadow<'a>(
    db: &Database,
    project_id: &str,
    selection_scope: &V2ShadowSelectionScope,
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
        let consumer_keys = selected_v2_shadow_head_keys_in_tx(conn, project_id, selection_scope)?;
        let consumer_key_snapshot = consumer_keys.to_vec();
        let mut summary = IncrementalFreshnessShadowSummary::default();
        match selection_scope {
            V2ShadowSelectionScope::SourceBounded(_) => {}
            V2ShadowSelectionScope::ComponentSchemaGlobal => summary
                .diagnostics
                .push("NEX_V2_SHADOW_INCREMENTAL_COMPONENT_SCHEMA_PROJECT_WIDE".to_owned()),
            V2ShadowSelectionScope::ProjectResetGlobal => summary
                .diagnostics
                .push("NEX_V2_SHADOW_INCREMENTAL_PROJECT_RESET_DEFERRED_TO_REBUILD".to_owned()),
        }
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
            let selected_entries = match selection_scope {
                V2ShadowSelectionScope::SourceBounded(_) => active_set
                    .entries
                    .iter()
                    .filter(|entry| signals.contains_key(&entry.source_object_identity))
                    .collect::<Vec<_>>(),
                // A schema marker invalidates only declared component
                // contracts. Other D1 declarations remain outside this
                // event's semantic effect; they are nevertheless included
                // in the selected head/set guard above.
                V2ShadowSelectionScope::ComponentSchemaGlobal => active_set
                    .entries
                    .iter()
                    .filter(|entry| entry.dependency_role == DependencyRole::ComponentContract)
                    .collect::<Vec<_>>(),
                // Restore/reset has no mutation-local Source projection. It
                // is deliberately deferred to the project-wide rebuild, but
                // every active head is still snapshotted and guarded.
                V2ShadowSelectionScope::ProjectResetGlobal => Vec::new(),
            };
            if matches!(selection_scope, V2ShadowSelectionScope::ProjectResetGlobal) {
                // The reset marker has no mutation-local projection. Keep
                // the complete active-head state in the publish guard, but
                // report the evaluation as explicitly deferred rather than
                // implying that any declaration was classified here.
                guards.push(active_set.clone());
                continue;
            }
            if matches!(
                selection_scope,
                V2ShadowSelectionScope::ComponentSchemaGlobal
            ) {
                // All project heads are selected and guarded. Only heads
                // that actually declare component contracts contribute to
                // the shadow summary; unrelated declarations are not
                // fabricated as affected by a component schema marker.
                guards.push(active_set.clone());
                if selected_entries.is_empty() {
                    continue;
                }
                summary.active_head_count += 1;
                summary.declaration_count += selected_entries.len();
            } else if selected_entries.is_empty() {
                continue;
            } else {
                summary.active_head_count += 1;
                summary.declaration_count += selected_entries.len();
                guards.push(active_set.clone());
            }
            if selected_entries.is_empty() {
                continue;
            }

            let mut effects = Vec::new();
            let mut evaluated_declaration_count = 0usize;
            let mut selector_mapping_unknown = false;
            let mut effect_mapping_unknown = false;
            for entry in selected_entries {
                let event = signals.get(&entry.source_object_identity);
                if event.is_none()
                    && !matches!(
                        selection_scope,
                        V2ShadowSelectionScope::ComponentSchemaGlobal
                    )
                {
                    continue;
                }
                let selector_change_class_result = match selection_scope {
                    V2ShadowSelectionScope::ComponentSchemaGlobal => {
                        Ok(SourceChangeClass::ComponentUnavailable)
                    }
                    _ => {
                        let event =
                            event.expect("source-bounded D2 selection must have a Feed signal");
                        let base_change_class = source_change_classes
                            .get(&entry.source_object_identity)
                            .copied()
                            .unwrap_or_else(|| source_change_class_from_feed_event(event.latest));
                        shadow_change_class_for_selector(
                            &entry.selector_json,
                            event.latest,
                            base_change_class,
                        )
                    }
                };
                let selector_change_class = match selector_change_class_result {
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

/// Re-read the non-authoritative D2 shadow inputs inside the publish
/// transaction. `Ok(None)` means the inputs are unchanged; `Ok(Some(..))`
/// carries the drift diagnostic. Drift never fails the authoritative V1
/// publication — the caller discards the stale shadow summary and commits V1
/// — so a mutating D1 head can never consume V1's retry budget or dead-letter
/// the cursor. Real read errors still propagate as `Err`.
fn check_v2_declaration_inputs_in_tx(
    conn: &Connection,
    project_id: &str,
    plan: &EvaluationPlan,
) -> anyhow::Result<Option<String>> {
    let current_keys = selected_v2_shadow_head_keys_in_tx(conn, project_id, &plan.v2_shadow_scope)?;
    if current_keys != plan.v2_declaration_head_keys {
        return Ok(Some(
            "NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED: selected D1 head key set changed after evaluation"
                .to_string(),
        ));
    }
    for (consumer_kind, consumer_key, expected_state) in &plan.v2_declaration_head_snapshots {
        let current_state = read_active_dependency_declaration_set_in_tx(
            conn,
            project_id,
            consumer_kind,
            consumer_key,
        )?;
        if &current_state != expected_state {
            return Ok(Some(format!(
                "NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED: active head state changed for {consumer_kind}:{consumer_key}"
            )));
        }
    }
    for guard in &plan.v2_declaration_guards {
        if let Err(error) = verify_active_dependency_declaration_set_unchanged_in_conn(conn, guard)
        {
            let message = error.to_string();
            if message.contains("NEX_DECLARATION_HEAD_CHANGED_AFTER_EVALUATION")
                || message.contains("NEX_DECLARATION_HEAD_INCOHERENT_AFTER_EVALUATION")
            {
                return Ok(Some(message));
            }
            return Err(error);
        }
    }
    Ok(None)
}

fn publish_batch_in_tx(
    conn: &Connection,
    batch: &ClaimedBatch,
    plan: &EvaluationPlan,
) -> anyhow::Result<Option<String>> {
    verify_task_lease(conn, &batch.task_id, &batch.run_id, &batch.lease_owner)?;
    verify_publish_reservation_in_tx(
        conn,
        &batch.project_id,
        &batch.run_id,
        CURSOR_CONSUMER_ID,
        &batch.semantic_epoch_id,
        batch.through_sequence_inclusive,
    )?;
    if batch.idle_checkpoint {
        publish_idle_checkpoint_in_tx(conn, batch)?;
        return Ok(None);
    }
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
    // D2 is shadow-only: drift in the selected V2 head/key/state snapshot is
    // recorded, the stale shadow summary is discarded by the caller, and the
    // authoritative V1 publication commits regardless. D2 cannot fail,
    // requeue, or dead-letter V1. Unrelated Sources/heads remain outside
    // ordinary bounded selection; global markers intentionally select the
    // complete project.
    let v2_shadow_drift = check_v2_declaration_inputs_in_tx(conn, &batch.project_id, plan)?;
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
    Ok(v2_shadow_drift)
}

fn publish_idle_checkpoint_in_tx(conn: &Connection, batch: &ClaimedBatch) -> anyhow::Result<()> {
    anyhow::ensure!(
        batch.from_sequence_exclusive == batch.through_sequence_inclusive
            && !batch.has_more
            && batch.events.is_empty()
            && batch.preparation_error.is_none(),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SHAPE_INVALID: checkpoint is not zero-width"
    );
    let (task_kind, input_json): (String, String) = conn.query_row(
        "SELECT task_kind, input_json
           FROM narrative_extraction_tasks
          WHERE id = ?1 AND run_id = ?2",
        params![batch.task_id, batch.run_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    anyhow::ensure!(
        task_kind == TASK_KIND,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_TASK_KIND_INVALID: Task kind is not the canonical Freshness batch"
    );
    let input_digest = validate_idle_checkpoint_task_input(&input_json, batch)?;
    validate_idle_checkpoint_run_metadata(conn, batch, &input_digest)?;
    let epoch = get_current_epoch(conn, &batch.project_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_EPOCH_MISSING: current Semantic Epoch disappeared before publication"
        )
    })?;
    anyhow::ensure!(
        epoch.id == batch.semantic_epoch_id,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_EPOCH_STALE: current Semantic Epoch changed before publication"
    );
    anyhow::ensure!(
        current_feed_head(conn, &batch.project_id)? == batch.through_sequence_inclusive,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_STALE: Feed head changed before publication"
    );

    let output = json!({
        "kind": IDLE_CHECKPOINT_KIND,
        "version": IDLE_CHECKPOINT_VERSION,
        "projectId": batch.project_id,
        "runId": batch.run_id,
        "fromSequenceExclusive": batch.from_sequence_exclusive,
        "throughSequenceInclusive": batch.through_sequence_inclusive,
        "affectedEdgeCount": 0,
        "affectedConsumerCount": 0,
        "hasMore": false,
    });
    let output_json = serde_json::to_string(&output)?;
    let completed_at = idle_checkpoint_lifecycle_timestamp_in_tx(conn, &batch.run_id)?;
    let attempt_updated = conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = 'completed', completed_at = ?1, output_json = ?2,
                error_message = NULL
          WHERE id = ?3 AND task_id = ?4 AND status = 'running'",
        params![completed_at, output_json, batch.attempt_id, batch.task_id],
    )?;
    anyhow::ensure!(
        attempt_updated == 1,
        "incremental Freshness idle checkpoint Attempt is not running"
    );
    let task_updated = conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = 'completed', output_json = ?1, error_message = NULL,
                lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                completed_at = ?2, version = version + 1
          WHERE id = ?3 AND run_id = ?4 AND status = 'running'
            AND lease_owner = ?5",
        params![
            output_json,
            completed_at,
            batch.task_id,
            batch.run_id,
            batch.lease_owner
        ],
    )?;
    anyhow::ensure!(
        task_updated == 1,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_LEASE_LOST: Task lease was lost"
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

fn validate_idle_checkpoint_task_input(
    input_json: &str,
    batch: &ClaimedBatch,
) -> anyhow::Result<String> {
    let input: Value = serde_json::from_str(input_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID: input JSON is malformed: {error}"
        )
    })?;
    anyhow::ensure!(
        input.get("kind").and_then(Value::as_str) == Some(IDLE_CHECKPOINT_KIND)
            && input.get("version").and_then(Value::as_i64) == Some(IDLE_CHECKPOINT_VERSION),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID: task input tag/version is invalid"
    );
    anyhow::ensure!(
        input.get("projectId").and_then(Value::as_str) == Some(batch.project_id.as_str())
            && input.get("semanticEpochId").and_then(Value::as_str)
                == Some(batch.semantic_epoch_id.as_str())
            && input
                .get("fromSequenceExclusive")
                .and_then(Value::as_i64)
                == Some(batch.from_sequence_exclusive)
            && input
                .get("throughSequenceInclusive")
                .and_then(Value::as_i64)
                == Some(batch.through_sequence_inclusive)
            && input.get("feedHead").and_then(Value::as_i64)
                == Some(batch.through_sequence_inclusive),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID: task input coordinates do not match the reservation"
    );
    let input_digest = input
        .get("inputDigest")
        .and_then(Value::as_str)
        .filter(|digest| digest.starts_with("sha256:") && digest.len() == "sha256:".len() + 64)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID: inputDigest is not a SHA-256 token"
            )
        })?;
    const INPUT_KEYS: [&str; 8] = [
        "kind",
        "version",
        "projectId",
        "semanticEpochId",
        "fromSequenceExclusive",
        "throughSequenceInclusive",
        "feedHead",
        "inputDigest",
    ];
    let input_object = input
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("idle checkpoint task input must be an object"))?;
    anyhow::ensure!(
        input_object.len() == INPUT_KEYS.len()
            && input_object
                .keys()
                .all(|key| INPUT_KEYS.contains(&key.as_str())),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID: task input contains unknown fields"
    );
    let mut payload = input
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("idle checkpoint task input must be an object"))?;
    payload.remove("inputDigest");
    let expected_digest = idle_checkpoint_digest(&Value::Object(payload));
    anyhow::ensure!(
        input_digest == expected_digest,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID: inputDigest does not match tagged coordinates"
    );
    Ok(input_digest.to_owned())
}

fn validate_idle_checkpoint_run_metadata(
    conn: &Connection,
    batch: &ClaimedBatch,
    input_digest: &str,
) -> anyhow::Result<()> {
    let (spec_json, spec_digest, work_key): (String, String, String) = conn.query_row(
        "SELECT spec_json, spec_digest, work_key
           FROM narrative_extraction_runs
          WHERE id = ?1 AND project_id = ?2
            AND run_kind = 'freshness-evaluation'
            AND semantic_epoch_id = ?3",
        params![batch.run_id, batch.project_id, batch.semantic_epoch_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let spec: Value = serde_json::from_str(&spec_json).map_err(|error| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID: spec JSON is malformed: {error}"
        )
    })?;
    let spec_object = spec.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID: spec must be an object"
        )
    })?;
    const SPEC_KEYS: [&str; 2] = ["kind", "inputDigest"];
    anyhow::ensure!(
        spec_object.len() == SPEC_KEYS.len()
            && spec_object
                .keys()
                .all(|key| SPEC_KEYS.contains(&key.as_str())),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID: spec contains unknown fields"
    );
    anyhow::ensure!(
        spec.get("kind").and_then(Value::as_str)
            == Some("incremental-freshness-idle-checkpoint@1")
            && spec.get("inputDigest").and_then(Value::as_str) == Some(input_digest),
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID: spec kind or inputDigest does not match task input"
    );
    anyhow::ensure!(
        idle_checkpoint_digest(&spec) == spec_digest,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID: spec_digest does not match spec JSON"
    );
    let expected_work_key = format!(
        "incremental-freshness:{}:{}:{}:{}",
        batch.semantic_epoch_id,
        batch.from_sequence_exclusive,
        batch.through_sequence_inclusive,
        input_digest.trim_start_matches("sha256:")
    );
    anyhow::ensure!(
        work_key == expected_work_key,
        "NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID: work_key does not match checkpoint coordinates"
    );
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
            let lifecycle_at = if batch.idle_checkpoint {
                Some(idle_checkpoint_lifecycle_timestamp_in_tx(conn, &batch.run_id)?)
            } else {
                None
            };
            let attempt_updated = if let Some(lifecycle_at) = lifecycle_at.as_deref() {
                let next_attempt_at = (!terminal).then(|| lifecycle_at.to_owned());
                conn.execute(
                    "UPDATE narrative_extraction_attempts
                        SET status = 'failed', completed_at = ?1, error_message = ?2,
                            failure_code = ?3, retry_disposition = ?4, policy_version = ?5,
                            next_attempt_at = ?6
                      WHERE id = ?7 AND task_id = ?8 AND status = 'running'",
                    params![
                        lifecycle_at,
                        message,
                        failure_code,
                        retry_disposition,
                        FAILURE_POLICY_VERSION,
                        next_attempt_at,
                        batch.attempt_id,
                        batch.task_id
                    ],
                )?
            } else {
                conn.execute(
                    "UPDATE narrative_extraction_attempts
                        SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), error_message = ?1,
                            failure_code = ?2, retry_disposition = ?3, policy_version = ?4,
                            next_attempt_at = CASE
                              WHEN ?3 = 'retryable' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
                      WHERE id = ?5 AND task_id = ?6 AND status = 'running'",
                    params![
                        message,
                        failure_code,
                        retry_disposition,
                        FAILURE_POLICY_VERSION,
                        batch.attempt_id,
                        batch.task_id
                    ],
                )?
            };
            if attempt_updated == 0 {
                return Ok(());
            }
            let task_status = if terminal { "failed" } else { "queued" };
            let task_updated = if let Some(lifecycle_at) = lifecycle_at.as_deref() {
                let completed_at = terminal.then(|| lifecycle_at.to_owned());
                conn.execute(
                    "UPDATE narrative_extraction_tasks
                        SET status = ?1, error_message = ?2,
                            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                            completed_at = ?3, version = version + 1
                      WHERE id = ?4 AND run_id = ?5 AND status = 'running'
                        AND lease_owner = ?6",
                    params![
                        task_status,
                        message,
                        completed_at,
                        batch.task_id,
                        batch.run_id,
                        batch.lease_owner
                    ],
                )?
            } else {
                conn.execute(
                    "UPDATE narrative_extraction_tasks
                        SET status = ?1, error_message = ?2,
                            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                            completed_at = CASE WHEN ?1 = 'failed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
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
                )?
            };
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
        if event_changes_project_scope_authority(event) {
            identities.insert(project_scope_authority_identity(project_id));
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
        if event_changes_project_scope_authority(event) {
            upsert_project_scope_authority_signals(
                &mut result,
                project_scope_authority_identity(project_id),
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
            change_class_override: None,
        });
}

fn project_scope_authority_identity(project_id: &str) -> String {
    format!("project:scope-authority:{project_id}")
}

fn folder_event_has_live_scene_subtree_impact(event: &NarrativeChangeEventRecord) -> bool {
    let Some(impact) = event
        .structural_impact
        .as_ref()
        .and_then(|impact| impact.get("liveSceneSubtreeImpact"))
    else {
        return false;
    };
    let before_count = impact
        .get("beforeCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let after_count = impact
        .get("afterCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    before_count > 0 || after_count > 0
}

fn event_changes_project_scope_authority(event: &NarrativeChangeEventRecord) -> bool {
    let node_type = match event.object_key.get("kind").and_then(Value::as_str) {
        Some("scene") => Some("scene"),
        Some("component") => event
            .object_key
            .get("componentId")
            .and_then(Value::as_str)
            .filter(|component_id| {
                component_id.starts_with("tree-node:") || component_id.starts_with("tree_node:")
            })
            .and_then(|_| {
                event
                    .structural_impact
                    .as_ref()
                    .and_then(|impact| impact.get("nodeType"))
                    .and_then(Value::as_str)
            }),
        _ => None,
    };
    event.changed_paths.iter().any(|path| match node_type {
        // Commit-journal projections deliberately collapse their field paths
        // to `/`. A Scene key therefore also covers Chronicle-only calendar
        // patches; only membership transitions or the typed Story-order root
        // can make that whole-object marker an aggregate axis change.
        Some("scene") if path == "/" => {
            event.change_kind == "order"
                || (event.change_kind == "content"
                    && matches!(
                        event.mutation_kind.as_str(),
                        "create" | "delete" | "restore"
                    ))
        }
        Some("scene") => matches!(
            path.as_str(),
            "/parentId" | "/sortOrder" | "/storyTimeOrder" | "/archivedAt"
        ),
        Some("folder") => {
            matches!(path.as_str(), "/parentId" | "/sortOrder" | "/archivedAt")
                && folder_event_has_live_scene_subtree_impact(event)
        }
        _ => false,
    })
}

fn upsert_project_scope_authority_signals<'a>(
    result: &mut BTreeMap<String, SourceEventSignals<'a>>,
    identity: String,
    event: &'a NarrativeChangeEventRecord,
) {
    result
        .entry(identity)
        .and_modify(|signals| {
            signals.latest = event;
            signals.incarnation_replaced = false;
            signals.change_class_override = Some(SourceChangeClass::SourceContentChanged);
        })
        .or_insert(SourceEventSignals {
            latest: event,
            incarnation_replaced: false,
            change_class_override: Some(SourceChangeClass::SourceContentChanged),
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

fn is_project_epoch_reset_marker(event: &NarrativeChangeEventRecord) -> bool {
    event.object_key.get("kind").and_then(Value::as_str) == Some("project")
        && matches!(
            event
                .structural_impact
                .as_ref()
                .and_then(|impact| impact.get("event"))
                .and_then(Value::as_str),
            Some("project-restored" | "semantic-epoch-reset")
        )
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

/// Idle checkpoints are scheduler evidence, so their descriptors must have
/// one stable digest across producer, recovery, and readiness readers.  Keep
/// the legacy insertion-order digest for ordinary Feed payloads: changing it
/// would invalidate existing change-set work keys and cursor proofs.
fn idle_checkpoint_digest(value: &Value) -> String {
    format!("sha256:{}", digest_plan(value))
}

fn now_string() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::super::c2z_preparation::{inspect_project_cutover_readiness, ReadinessState};
    use super::super::declaration_storage::{
        write_dependency_declaration_set, DependencyDeclaration, DependencyDeclarationSetRequest,
    };
    use super::super::dependency_edges::record_dependency_edge_in_tx;
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

    fn seed_component_shadow_head(
        db: &Database,
        project_id: &str,
        consumer_key: &str,
        expected_head_version: i64,
        producer_generation: i64,
    ) {
        write_dependency_declaration_set(
            db,
            DependencyDeclarationSetRequest {
                project_id: project_id.to_owned(),
                consumer_kind: "narrative-extraction-run".to_owned(),
                consumer_key: consumer_key.to_owned(),
                producer_id: format!("nir0-d2-component-race-producer-{producer_generation}"),
                producer_generation,
                expected_head_version,
                declarations: vec![DependencyDeclaration {
                    source_object_identity: "component-contract:extractor".to_owned(),
                    role: DependencyRole::ComponentContract,
                    selector: DependencySelector::ComponentContract {
                        contract_id: "extractor".to_owned(),
                        contract_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_owned(),
                    },
                }],
                created_at: OCCURRED_AT.to_owned(),
            },
        )
        .expect("seed component-contract D2 head");
    }

    fn seed_completed_incremental_run(
        conn: &Connection,
        run_id: &str,
        epoch_id: &str,
        completed_at: &str,
    ) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, outcome_summary_json, created_at, started_at,
                 completed_at, version, run_kind, consumer_id, semantic_epoch_id, work_key)
             VALUES (?1, ?2, 'freshness-evaluation', '{}', '{}', 'digest-idle-fixture',
                     'completed', '{}', ?3, ?4, ?4, ?5, 0, 'freshness-evaluation',
                     ?6, ?7, ?8)",
            params![
                run_id,
                PROJECT_ID,
                serde_json::to_string(&json!({
                    "runId": run_id,
                    "projectId": PROJECT_ID,
                    "fromSequenceExclusive": 0,
                    "throughSequenceInclusive": 1,
                    "hasMore": false,
                }))?,
                OCCURRED_AT,
                completed_at,
                CURSOR_CONSUMER_ID,
                epoch_id,
                format!("incremental-freshness:{epoch_id}:0:1:fixture"),
            ],
        )?;
        Ok(())
    }

    fn rotated_idle_checkpoint_db() -> Database {
        let db = fixture_db();
        db.with_conn(|conn| {
            seed_completed_incremental_run(
                conn,
                "incremental-e0-completed",
                EPOCH_ID,
                "2026-08-19T00:00:03.000Z",
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-c2-1-idle-e1', ?1, 1, 'restore',
                         '2026-08-19T00:00:10.000Z')",
                [PROJECT_ID],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_cursors
                    (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                 VALUES (?1, ?2, 1, '2026-08-19T00:00:11.000Z')",
                params![PROJECT_ID, CURSOR_CONSUMER_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed rotated idle-checkpoint fixture");
        db
    }

    const IDLE_SURFACE_TABLES: &[&str] = &[
        "narrative_change_sets",
        "narrative_projection_freshness",
        "narrative_projection_dependencies",
        "narrative_application_contributions",
        "narrative_temporal_nodes",
        "narrative_temporal_constraints",
        "narrative_temporal_projections",
        "narrative_dependency_edges",
        "narrative_dependency_edge_states",
        "narrative_consumer_freshness",
        "narrative_maintenance_finding_observations",
        "narrative_maintenance_finding_lifecycle",
        "narrative_maintenance_attention",
        "narrative_semantic_index_metadata",
        "narrative_dependency_declaration_sets",
        "narrative_dependency_declaration_entries",
        "narrative_dependency_declaration_heads",
    ];

    fn idle_surface_snapshot(conn: &Connection) -> anyhow::Result<Vec<(String, Vec<String>)>> {
        IDLE_SURFACE_TABLES
            .iter()
            .map(|table| {
                let columns = conn
                    .prepare(&format!("PRAGMA table_info(\"{table}\")"))?
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                anyhow::ensure!(
                    !columns.is_empty(),
                    "idle surface table {table} has no columns"
                );
                let projection = columns
                    .iter()
                    .map(|column| format!("quote(\"{column}\")"))
                    .collect::<Vec<_>>()
                    .join(" || '|' || ");
                let mut rows = conn
                    .prepare(&format!("SELECT {projection} FROM \"{table}\""))?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows.sort();
                Ok(((*table).to_owned(), rows))
            })
            .collect()
    }

    #[test]
    fn idle_current_epoch_checkpoint_after_epoch_rotation_is_not_idle() {
        let db = rotated_idle_checkpoint_db();
        let before_surfaces = db
            .with_conn(idle_surface_snapshot)
            .expect("snapshot idle surfaces before checkpoint");

        let first = run_incremental_freshness_cycle(&db)
            .expect("idle checkpoint cycle should complete without an error");
        let IncrementalFreshnessCycleOutcome::Processed(summary) = first else {
            panic!("a clean current Epoch at the Feed head requires one zero-width checkpoint");
        };
        assert_eq!(summary.project_id, PROJECT_ID);
        assert_eq!(summary.from_sequence_exclusive, 1);
        assert_eq!(summary.through_sequence_inclusive, 1);
        assert_eq!(summary.affected_edge_count, 0);
        assert_eq!(summary.affected_consumer_count, 0);
        assert!(!summary.has_more);

        let run_id = db
            .with_conn(|conn| {
                let run: (String, String, String, String, String, String, String) = conn
                    .query_row(
                        "SELECT id, status, run_kind, consumer_id, semantic_epoch_id,
                                work_key, outcome_summary_json
                           FROM narrative_extraction_runs
                          WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'
                            AND consumer_id = ?2 AND semantic_epoch_id = 'epoch-c2-1-idle-e1'",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID],
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
                    )?;
                assert_eq!(run.1, "completed");
                assert_eq!(run.2, "freshness-evaluation");
                assert_eq!(run.3, CURSOR_CONSUMER_ID);
                assert_eq!(run.4, "epoch-c2-1-idle-e1");
                assert!(run
                    .5
                    .starts_with("incremental-freshness:epoch-c2-1-idle-e1:1:1:"));
                let outcome: Value = serde_json::from_str(&run.6)?;
                assert_eq!(outcome["runId"].as_str(), Some(run.0.as_str()));
                assert_eq!(outcome["projectId"].as_str(), Some(PROJECT_ID));
                assert_eq!(outcome["fromSequenceExclusive"].as_i64(), Some(1));
                assert_eq!(outcome["throughSequenceInclusive"].as_i64(), Some(1));
                assert_eq!(outcome["hasMore"].as_bool(), Some(false));
                assert_eq!(outcome["affectedEdgeCount"].as_i64(), Some(0));
                assert_eq!(outcome["affectedConsumerCount"].as_i64(), Some(0));
                let (task_kind, input_json, task_status, attempt_status): (
                    String,
                    String,
                    String,
                    String,
                ) = conn.query_row(
                    "SELECT t.task_kind, t.input_json, t.status, a.status
                       FROM narrative_extraction_tasks t
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE t.run_id = ?1",
                    [run.0.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(task_kind, TASK_KIND);
                assert_eq!(task_status, "completed");
                assert_eq!(attempt_status, "completed");
                let input: Value = serde_json::from_str(&input_json)?;
                assert_eq!(
                    input["kind"].as_str(),
                    Some("current-epoch-idle-checkpoint")
                );
                assert_eq!(
                    input["semanticEpochId"].as_str(),
                    Some("epoch-c2-1-idle-e1")
                );
                assert_eq!(input["fromSequenceExclusive"].as_i64(), Some(1));
                assert_eq!(input["throughSequenceInclusive"].as_i64(), Some(1));
                assert!(input["inputDigest"].as_str().is_some());
                let change_set_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_sets WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(
                    change_set_count, 0,
                    "zero-width checkpoints cannot create Change Sets"
                );
                let cursor: (i64, Option<String>, Option<i64>, Option<String>) = conn.query_row(
                    "SELECT acknowledged_through_sequence, active_run_id,
                            reserved_through_sequence, last_error
                       FROM narrative_change_cursors
                      WHERE project_id = ?1 AND consumer_id = ?2",
                    params![PROJECT_ID, CURSOR_CONSUMER_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(cursor, (1, None, None, None));
                Ok::<_, anyhow::Error>(run.0)
            })
            .expect("inspect zero-width checkpoint lifecycle");

        let second =
            run_incremental_freshness_cycle(&db).expect("the next clean wake should remain idle");
        assert_eq!(second, IncrementalFreshnessCycleOutcome::Idle);
        let after_surfaces = db
            .with_conn(idle_surface_snapshot)
            .expect("snapshot idle surfaces after checkpoint");
        assert_eq!(
            before_surfaces, after_surfaces,
            "zero-width checkpoint must not mutate Generic, Edge, Finding, D2, or Change Set surfaces"
        );
        db.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'
                    AND consumer_id = ?2 AND semantic_epoch_id = 'epoch-c2-1-idle-e1'",
                params![PROJECT_ID, CURSOR_CONSUMER_ID],
                |row| row.get(0),
            )?;
            assert_eq!(count, 1);
            let persisted_id: String = conn.query_row(
                "SELECT id FROM narrative_extraction_runs WHERE id = ?1",
                [run_id.as_str()],
                |row| row.get(0),
            )?;
            assert_eq!(persisted_id, run_id);
            Ok::<_, anyhow::Error>(())
        })
        .expect("confirm one-shot idle checkpoint");
    }

    #[test]
    fn idle_checkpoint_readiness_accepts_the_producer_digest_shape() {
        let db = rotated_idle_checkpoint_db();
        let outcome = run_incremental_freshness_cycle(&db)
            .expect("idle checkpoint producer should complete successfully");
        assert!(matches!(
            outcome,
            IncrementalFreshnessCycleOutcome::Processed(_)
        ));

        let readiness = db
            .with_conn(|conn| inspect_project_cutover_readiness(conn, PROJECT_ID))
            .expect("inspect current-Epoch readiness after idle checkpoint");
        assert_eq!(
            readiness.incremental_runtime.state,
            ReadinessState::Incomplete,
            "unexpected readiness: {readiness:?}"
        );
        assert_eq!(
            readiness.incremental_runtime.reasons,
            vec!["incremental-freshness-scheduler-liveness-evidence-unavailable"],
            "a producer-created idle checkpoint must satisfy all durable metadata checks"
        );
    }

    #[test]
    fn idle_checkpoint_readiness_accepts_producer_after_future_imported_run_lifecycle() {
        let db = rotated_idle_checkpoint_db();
        seed_future_imported_run_lifecycle(&db);

        let outcome = run_incremental_freshness_cycle(&db)
            .expect("idle checkpoint producer should continue future lifecycle");
        assert!(matches!(
            outcome,
            IncrementalFreshnessCycleOutcome::Processed(_)
        ));

        let readiness = db
            .with_conn(|conn| inspect_project_cutover_readiness(conn, PROJECT_ID))
            .expect("inspect current-Epoch readiness after future lifecycle checkpoint");
        assert_eq!(
            readiness.incremental_runtime.state,
            ReadinessState::Incomplete,
            "unexpected readiness: {readiness:?}"
        );
        assert_eq!(
            readiness.incremental_runtime.reasons,
            vec!["incremental-freshness-scheduler-liveness-evidence-unavailable"],
            "a producer-created idle checkpoint must follow imported Run lifecycle authority"
        );
    }

    fn seed_future_imported_run_lifecycle(db: &Database) {
        db.with_conn(|conn| {
            // Imported projects may carry a lifecycle authority ahead of the
            // wall clock. Every recovery branch must continue that authority
            // for its Attempt, Task, and Run timestamps.
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, started_at, completed_at,
                     run_kind, semantic_epoch_id)
                 VALUES ('imported-future-lifecycle-variants', ?1, 'imported', '{}', '{}',
                         'sha256:future-import-variants', 'completed', '{}',
                         '2099-01-01T00:00:00.000Z',
                         '2099-01-01T00:00:00.001Z',
                         '2099-01-01T00:00:00.002Z',
                         'interpretation', ?2)",
                params![PROJECT_ID, EPOCH_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed future imported Run lifecycle variant");
    }

    fn reserve_claimed_idle_checkpoint(db: &Database) -> ClaimedBatch {
        let reservation = db
            .with_conn(|conn| with_immediate_transaction(conn, reserve_or_resume_batch_in_tx))
            .expect("reserve idle checkpoint for recovery fixture");
        let ReservationOutcome::Claimed(batch) = reservation else {
            panic!("fixture must produce an idle checkpoint reservation");
        };
        assert!(batch.idle_checkpoint);
        *batch
    }

    fn reserve_unpublished_idle_checkpoint(db: &Database) -> (String, String) {
        let batch = reserve_claimed_idle_checkpoint(db);
        let run_id = batch.run_id.clone();
        let task_id = batch.task_id.clone();
        db.with_conn(|conn| {
            // Model a worker crash after claim. The durable reservation and
            // tagged input remain, while both leases are expired so the next
            // wake must use the normal claim/Attempt recovery path.
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET lease_expires_at = '2000-01-01T00:00:00.000Z',
                        heartbeat_at = '2000-01-01T00:00:00.000Z'
                  WHERE id = ?1 AND run_id = ?2",
                params![task_id, run_id],
            )?;
            conn.execute(
                "UPDATE narrative_change_cursors
                    SET lease_expires_at = '2000-01-01T00:00:00.000Z'
                  WHERE project_id = ?1 AND consumer_id = ?2 AND active_run_id = ?3",
                params![PROJECT_ID, CURSOR_CONSUMER_ID, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("expire idle checkpoint leases");
        (run_id, task_id)
    }

    #[test]
    fn idle_current_epoch_checkpoint_resumes_tagged_task_after_expired_lease() {
        let db = rotated_idle_checkpoint_db();
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);

        let resumed = run_incremental_freshness_cycle(&db)
            .expect("expired idle checkpoint should resume through the durable lifecycle");
        let IncrementalFreshnessCycleOutcome::Processed(summary) = resumed else {
            panic!("expired idle checkpoint must be reclaimed and completed");
        };
        assert_eq!(summary.run_id, run_id);
        assert_eq!(summary.from_sequence_exclusive, 1);
        assert_eq!(summary.through_sequence_inclusive, 1);
        assert_eq!(summary.affected_edge_count, 0);
        assert_eq!(summary.affected_consumer_count, 0);

        db.with_conn(|conn| {
            let statuses: (i64, i64) = conn.query_row(
                "SELECT
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1",
                [task_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(
                statuses,
                (1, 1),
                "recovery must close the displaced Attempt"
            );
            let (task_status, run_status, change_sets): (String, String, i64) = conn.query_row(
                "SELECT task.status, run.status,
                        (SELECT COUNT(*) FROM narrative_change_sets WHERE project_id = ?1)
                   FROM narrative_extraction_tasks task
                   JOIN narrative_extraction_runs run ON run.id = task.run_id
                  WHERE task.id = ?2 AND run.id = ?3",
                params![PROJECT_ID, task_id, run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(task_status, "completed");
            assert_eq!(run_status, "completed");
            assert_eq!(change_sets, 0, "idle recovery must not create a Change Set");
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect resumed idle checkpoint lifecycle");
    }

    #[test]
    fn future_imported_idle_checkpoint_recovery_resumes_to_success_and_only_lacks_scheduler_liveness(
    ) {
        let db = rotated_idle_checkpoint_db();
        seed_future_imported_run_lifecycle(&db);
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);

        let resumed = run_incremental_freshness_cycle(&db)
            .expect("future imported idle checkpoint should resume successfully");
        assert!(matches!(
            resumed,
            IncrementalFreshnessCycleOutcome::Processed(summary)
                if summary.run_id == run_id
                    && summary.from_sequence_exclusive == 1
                    && summary.through_sequence_inclusive == 1
        ));

        db.with_conn(|conn| {
            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                readiness.incremental_runtime.reasons,
                vec!["incremental-freshness-scheduler-liveness-evidence-unavailable"]
            );
            let statuses: (i64, i64) = conn.query_row(
                "SELECT
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1",
                [task_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(statuses, (1, 1));
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect future imported recovery readiness");
    }

    #[test]
    fn idle_checkpoint_readiness_accepts_failed_retry_metadata_before_completion() {
        let db = rotated_idle_checkpoint_db();
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = 'corrupted-idle-checkpoint-kind'
                  WHERE id = ?1 AND run_id = ?2",
                params![task_id, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt idle task kind to exercise retry metadata");

        let first_error = run_incremental_freshness_cycle(&db)
            .expect_err("the first malformed idle retry must fail closed");
        assert!(first_error
            .to_string()
            .contains("NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_TASK_KIND_INVALID"));
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = ?1
                  WHERE id = ?2 AND run_id = ?3",
                params![TASK_KIND, task_id, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("restore canonical idle task kind before retry");

        let second = run_incremental_freshness_cycle(&db)
            .expect("a corrected idle retry must complete the same Run");
        assert!(matches!(
            second,
            IncrementalFreshnessCycleOutcome::Processed(_)
        ));
        db.with_conn(|conn| {
            let mut rows = conn.prepare(
                "SELECT attempt_number, status, completed_at, failure_code,
                        retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1
                  ORDER BY attempt_number",
            )?;
            let attempts = rows
                .query_map([task_id.as_str()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(attempts.len(), 3);
            assert_eq!(attempts[0].0, 1);
            assert_eq!(attempts[1].0, 2);
            assert_eq!(attempts[2].0, 3);
            for failed in &attempts[..2] {
                assert_eq!(failed.1, "failed");
                assert!(failed.2.contains('T') && failed.2.ends_with('Z'));
                assert!(failed
                    .3
                    .as_deref()
                    .is_some_and(|value| value.starts_with("NEX_")));
                assert_eq!(failed.4.as_deref(), Some("retryable"));
                assert_eq!(failed.5.as_deref(), Some("v1"));
                assert!(failed
                    .6
                    .as_deref()
                    .is_some_and(|value| value.contains('T') && value.ends_with('Z')));
            }
            assert_eq!(attempts[2].1, "completed");
            assert!(attempts[2].2.contains('T') && attempts[2].2.ends_with('Z'));
            assert_eq!(attempts[2].3, None);
            assert_eq!(attempts[2].4, None);
            assert_eq!(attempts[2].5, None);
            assert_eq!(attempts[2].6, None);
            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                readiness.incremental_runtime.reasons,
                vec!["incremental-freshness-scheduler-liveness-evidence-unavailable"]
            );
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect failed-retry idle readiness topology");
    }

    #[test]
    fn future_imported_idle_checkpoint_retry_repair_has_monotonic_failed_attempts_and_readiness() {
        let db = rotated_idle_checkpoint_db();
        seed_future_imported_run_lifecycle(&db);
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = 'corrupted-idle-checkpoint-kind'
                  WHERE id = ?1 AND run_id = ?2",
                params![task_id, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt future imported idle task kind");

        let first_error = run_incremental_freshness_cycle(&db)
            .expect_err("future imported malformed idle retry must fail closed");
        assert!(first_error
            .to_string()
            .contains("NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_TASK_KIND_INVALID"));
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = ?1
                  WHERE id = ?2 AND run_id = ?3",
                params![TASK_KIND, task_id, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("repair future imported idle task kind");

        assert!(matches!(
            run_incremental_freshness_cycle(&db)
                .expect("future imported malformed idle retry should repair to success"),
            IncrementalFreshnessCycleOutcome::Processed(_)
        ));

        db.with_conn(|conn| {
            let mut rows = conn.prepare(
                "SELECT attempt_number, status, started_at, completed_at, next_attempt_at
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1
                  ORDER BY attempt_number",
            )?;
            let attempts = rows
                .query_map([task_id.as_str()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(attempts.len(), 3);
            for pair in attempts.windows(2) {
                assert!(
                    pair[0].3 <= pair[1].2,
                    "attempt timestamps must be monotonic: previous={:?}, next={:?}",
                    pair[0],
                    pair[1]
                );
            }
            for attempt in &attempts[..2] {
                let next_attempt_at = attempt
                    .4
                    .as_deref()
                    .expect("failed Attempt must have next_attempt_at");
                assert!(
                    attempt.2.as_str() <= attempt.3.as_str()
                        && attempt.3.as_str() <= next_attempt_at,
                    "failed Attempt timestamps must be monotonic: {attempt:?}"
                );
            }
            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                readiness.incremental_runtime.reasons,
                vec!["incremental-freshness-scheduler-liveness-evidence-unavailable"]
            );
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect future imported retry timestamps and readiness");
    }

    #[test]
    fn corrupted_idle_task_kind_at_retry_limit_terminalizes_without_fourth_attempt() {
        let db = rotated_idle_checkpoint_db();
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = 'corrupted-idle-checkpoint-kind', attempt_count = ?1
                  WHERE id = ?2 AND run_id = ?3",
                params![MAX_ATTEMPTS_PER_BATCH, task_id, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt idle task kind at retry limit");

        let outcome = run_incremental_freshness_cycle(&db)
            .expect("an exhausted corrupted idle reservation must terminalize safely");
        assert_eq!(outcome, IncrementalFreshnessCycleOutcome::Idle);
        db.with_conn(|conn| {
            let (task_status, run_status, terminal_reason, attempts): (
                String,
                String,
                Option<String>,
                i64,
            ) = conn.query_row(
                "SELECT task.status, run.status, run.terminal_reason_code,
                        (SELECT COUNT(*) FROM narrative_extraction_attempts
                          WHERE task_id = task.id)
                   FROM narrative_extraction_tasks task
                   JOIN narrative_extraction_runs run ON run.id = task.run_id
                  WHERE task.id = ?1 AND run.id = ?2",
                params![task_id, run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(task_status, "failed");
            assert_eq!(run_status, "failed");
            assert_eq!(
                terminal_reason.as_deref(),
                Some("NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED")
            );
            assert_eq!(attempts, 1, "recovery must not claim a fourth Attempt");
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect exhausted corrupted idle reservation");
    }

    #[test]
    fn future_imported_idle_checkpoint_exhaustion_has_no_fourth_attempt_and_monotonic_lifecycle() {
        let db = rotated_idle_checkpoint_db();
        seed_future_imported_run_lifecycle(&db);
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET task_kind = 'corrupted-idle-checkpoint-kind', attempt_count = ?1
                  WHERE id = ?2 AND run_id = ?3",
                params![MAX_ATTEMPTS_PER_BATCH, task_id, run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt future imported idle task at retry limit");

        assert_eq!(
            run_incremental_freshness_cycle(&db)
                .expect("future imported exhausted idle checkpoint should terminalize"),
            IncrementalFreshnessCycleOutcome::Idle
        );
        db.with_conn(|conn| {
            let (
                run_created_at,
                run_started_at,
                run_completed_at,
                task_created_at,
                task_started_at,
                task_completed_at,
                attempt_count,
                attempts,
            ): (String, String, String, String, String, String, i64, i64) = conn.query_row(
                "SELECT run.created_at, run.started_at, run.completed_at,
                        task.created_at, task.started_at, task.completed_at,
                        task.attempt_count,
                        (SELECT COUNT(*) FROM narrative_extraction_attempts
                          WHERE task_id = task.id)
                   FROM narrative_extraction_tasks task
                   JOIN narrative_extraction_runs run ON run.id = task.run_id
                  WHERE task.id = ?1 AND run.id = ?2",
                params![task_id, run_id],
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
                    ))
                },
            )?;
            let (attempt_started_at, attempt_completed_at): (String, String) = conn.query_row(
                "SELECT started_at, completed_at
                   FROM narrative_extraction_attempts
                  WHERE task_id = ?1
                  ORDER BY attempt_number",
                [task_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let timestamps = [
                run_created_at,
                run_started_at,
                task_created_at,
                task_started_at,
                attempt_started_at,
                attempt_completed_at,
                task_completed_at,
                run_completed_at,
            ];
            for pair in timestamps.windows(2) {
                assert!(
                    pair[0] <= pair[1],
                    "future imported lifecycle timestamps must be nondecreasing: {pair:?}"
                );
            }
            assert_eq!(attempt_count, MAX_ATTEMPTS_PER_BATCH);
            assert_eq!(attempts, 1, "exhaustion must not claim a fourth Attempt");
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect future imported exhaustion lifecycle");
    }

    #[test]
    fn malformed_idle_checkpoint_tag_requeues_and_terminalizes_without_feed_surfaces() {
        let db = rotated_idle_checkpoint_db();
        let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
        db.with_conn(|conn| {
            let mut input: Value = conn
                .query_row(
                    "SELECT input_json FROM narrative_extraction_tasks WHERE id = ?1",
                    [task_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .and_then(|json| {
                    serde_json::from_str(&json)
                        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
                })?;
            input["kind"] = json!("incremental-freshness-batch");
            conn.execute(
                "UPDATE narrative_extraction_tasks SET input_json = ?1 WHERE id = ?2",
                params![serde_json::to_string(&input)?, task_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt idle checkpoint tag");

        // The crashed claim already consumed the first Attempt. Two
        // malformed retries therefore reach the configured terminal limit.
        for attempt in 1..=(MAX_ATTEMPTS_PER_BATCH - 1) {
            let error = run_incremental_freshness_cycle(&db)
                .expect_err("malformed checkpoint tag must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID"),
                "unexpected attempt {attempt} error: {error:#}"
            );
            if attempt < MAX_ATTEMPTS_PER_BATCH - 1 {
                db.with_conn(|conn| {
                    let status: String = conn.query_row(
                        "SELECT status FROM narrative_extraction_tasks WHERE id = ?1",
                        [task_id.as_str()],
                        |row| row.get(0),
                    )?;
                    assert_eq!(status, "queued");
                    Ok::<_, anyhow::Error>(())
                })
                .expect("retryable malformed checkpoint should be queued");
            }
        }

        db.with_conn(|conn| {
            let (task_status, run_status, change_sets): (String, String, i64) = conn.query_row(
                "SELECT task.status, run.status,
                        (SELECT COUNT(*) FROM narrative_change_sets WHERE project_id = ?1)
                   FROM narrative_extraction_tasks task
                   JOIN narrative_extraction_runs run ON run.id = task.run_id
                  WHERE task.id = ?2 AND run.id = ?3",
                params![PROJECT_ID, task_id, run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(task_status, "failed");
            assert_eq!(run_status, "failed");
            assert_eq!(change_sets, 0);
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect terminal malformed checkpoint");
        assert_eq!(
            run_incremental_freshness_cycle(&db).expect("terminal checkpoint wake"),
            IncrementalFreshnessCycleOutcome::Idle
        );
    }

    #[test]
    fn malformed_idle_checkpoint_digest_requeues_without_bypassing_validation() {
        let db = rotated_idle_checkpoint_db();
        let (_run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
        db.with_conn(|conn| {
            let mut input: Value = conn
                .query_row(
                    "SELECT input_json FROM narrative_extraction_tasks WHERE id = ?1",
                    [task_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .and_then(|json| {
                    serde_json::from_str(&json)
                        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
                })?;
            input["inputDigest"] = json!(format!("sha256:{}", "0".repeat(64)));
            conn.execute(
                "UPDATE narrative_extraction_tasks SET input_json = ?1 WHERE id = ?2",
                params![serde_json::to_string(&input)?, task_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt idle checkpoint digest");

        let error = run_incremental_freshness_cycle(&db)
            .expect_err("malformed checkpoint digest must fail closed");
        assert!(error
            .to_string()
            .contains("NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_INPUT_INVALID"));
        db.with_conn(|conn| {
            let status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_tasks WHERE id = ?1",
                [task_id.as_str()],
                |row| row.get(0),
            )?;
            assert_eq!(status, "queued");
            Ok::<_, anyhow::Error>(())
        })
        .expect("malformed digest should use the ordinary retry disposition");
    }

    #[test]
    fn idle_checkpoint_run_metadata_is_bound_to_task_digest_and_work_key() {
        for mutation in [
            "spec-kind",
            "spec-input-digest",
            "spec-extra",
            "spec-digest",
            "work-key",
        ] {
            let db = rotated_idle_checkpoint_db();
            let (run_id, task_id) = reserve_unpublished_idle_checkpoint(&db);
            db.with_conn(|conn| {
                let (input_json, spec_json): (String, String) = conn.query_row(
                    "SELECT task.input_json, run.spec_json
                       FROM narrative_extraction_tasks task
                       JOIN narrative_extraction_runs run ON run.id = task.run_id
                      WHERE task.id = ?1 AND run.id = ?2",
                    params![task_id, run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let input: Value = serde_json::from_str(&input_json)?;
                let input_digest = input["inputDigest"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("fixture input digest missing"))?;
                match mutation {
                    "spec-kind" => {
                        let mut spec: Value = serde_json::from_str(&spec_json)?;
                        spec["kind"] = json!("incremental-freshness-batch@1");
                        conn.execute(
                            "UPDATE narrative_extraction_runs SET spec_json = ?1 WHERE id = ?2",
                            params![serde_json::to_string(&spec)?, run_id],
                        )?;
                    }
                    "spec-input-digest" => {
                        let mut spec: Value = serde_json::from_str(&spec_json)?;
                        spec["inputDigest"] = json!(format!("sha256:{}", "1".repeat(64)));
                        conn.execute(
                            "UPDATE narrative_extraction_runs SET spec_json = ?1 WHERE id = ?2",
                            params![serde_json::to_string(&spec)?, run_id],
                        )?;
                    }
                    "spec-extra" => {
                        let mut spec: Value = serde_json::from_str(&spec_json)?;
                        spec["unexpected"] = json!(true);
                        let recalculated_digest = idle_checkpoint_digest(&spec);
                        conn.execute(
                            "UPDATE narrative_extraction_runs
                                SET spec_json = ?1, spec_digest = ?2
                              WHERE id = ?3",
                            params![serde_json::to_string(&spec)?, recalculated_digest, run_id],
                        )?;
                    }
                    "spec-digest" => {
                        conn.execute(
                            "UPDATE narrative_extraction_runs SET spec_digest = ?1 WHERE id = ?2",
                            params![format!("sha256:{}", "2".repeat(64)), run_id],
                        )?;
                    }
                    "work-key" => {
                        conn.execute(
                            "UPDATE narrative_extraction_runs
                                SET work_key = ?1
                              WHERE id = ?2",
                            params![
                                format!(
                                    "incremental-freshness:epoch-c2-1-idle-e1:1:1:{}",
                                    "3".repeat(64)
                                ),
                                run_id
                            ],
                        )?;
                    }
                    _ => unreachable!("test mutation is exhaustive"),
                }
                assert!(!input_digest.is_empty());
                Ok::<_, anyhow::Error>(())
            })
            .expect("corrupt idle checkpoint Run metadata");

            let error = run_incremental_freshness_cycle(&db)
                .expect_err("Run metadata corruption must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_SPEC_INVALID"),
                "mutation {mutation} returned unexpected error: {error:#}"
            );
            db.with_conn(|conn| {
                let status: String = conn.query_row(
                    "SELECT status FROM narrative_extraction_tasks WHERE id = ?1",
                    [task_id.as_str()],
                    |row| row.get(0),
                )?;
                assert_eq!(status, "queued", "mutation {mutation} should be retryable");
                let change_sets: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_sets WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(change_sets, 0);
                Ok::<_, anyhow::Error>(())
            })
            .expect("inspect metadata-corruption retry");
        }
    }

    #[test]
    fn malformed_current_epoch_freshness_run_blocks_idle_checkpoint() {
        for status in ["failed", "cancelled", "pending"] {
            let db = rotated_idle_checkpoint_db();
            db.with_conn(|conn| {
                seed_completed_incremental_run(
                    conn,
                    "incremental-e1-malformed-run",
                    "epoch-c2-1-idle-e1",
                    "2026-08-19T00:00:12.000Z",
                )?;
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET consumer_id = NULL, status = ?1,
                            terminal_reason_code = NULL
                      WHERE id = 'incremental-e1-malformed-run'",
                    [status],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed malformed current-Epoch run");
            assert_eq!(
                run_incremental_freshness_cycle(&db)
                    .expect("malformed current-Epoch run should suppress minting"),
                IncrementalFreshnessCycleOutcome::Idle,
                "status {status} must block an idle checkpoint"
            );
            db.with_conn(|conn| {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_extraction_runs
                      WHERE project_id = ?1 AND semantic_epoch_id = 'epoch-c2-1-idle-e1'",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 1);
                Ok::<_, anyhow::Error>(())
            })
            .expect("inspect suppressed malformed current-Epoch run");
        }
    }

    fn empty_epoch_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open empty test database");
        db.migrate().expect("migrate empty test database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-empty', 'Empty')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-empty', 'project-empty', 0, 'initial',
                         '2026-08-19T00:00:00.000Z')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed empty current Epoch");
        db
    }

    #[test]
    fn idle_current_epoch_checkpoint_allows_absent_cursor_only_at_feed_head_zero() {
        let db = empty_epoch_db();
        let first = run_incremental_freshness_cycle(&db).expect("head-zero checkpoint cycle");
        let IncrementalFreshnessCycleOutcome::Processed(summary) = first else {
            panic!("an empty Feed with no cursor requires one durable checkpoint");
        };
        assert_eq!(summary.project_id, "project-empty");
        assert_eq!(summary.from_sequence_exclusive, 0);
        assert_eq!(summary.through_sequence_inclusive, 0);
        assert_eq!(summary.affected_edge_count, 0);
        assert_eq!(summary.affected_consumer_count, 0);
        assert_eq!(
            run_incremental_freshness_cycle(&db).expect("head-zero second wake"),
            IncrementalFreshnessCycleOutcome::Idle
        );
        db.with_conn(|conn| {
            let (runs, acknowledged, change_sets): (i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE project_id = 'project-empty'
                        AND run_kind = 'freshness-evaluation'),
                    (SELECT acknowledged_through_sequence
                       FROM narrative_change_cursors
                      WHERE project_id = 'project-empty'
                        AND consumer_id = ?1),
                    (SELECT COUNT(*) FROM narrative_change_sets
                      WHERE project_id = 'project-empty')",
                [CURSOR_CONSUMER_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!((runs, acknowledged, change_sets), (1, 0, 0));
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect head-zero checkpoint");
    }

    #[test]
    fn idle_checkpoint_processes_one_empty_project_per_wake_in_id_order() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open multi-project db");
        db.migrate().expect("migrate multi-project db");
        db.with_conn(|conn| {
            for (project_id, epoch_id) in [
                ("project-idle-a", "epoch-idle-a"),
                ("project-idle-b", "epoch-idle-b"),
            ] {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, 'Idle project')",
                    [project_id],
                )?;
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES (?1, ?2, 0, 'initial', '2026-08-19T00:00:00.000Z')",
                    params![epoch_id, project_id],
                )?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed two empty current Epochs");

        let first = run_incremental_freshness_cycle(&db).expect("first bounded wake");
        let IncrementalFreshnessCycleOutcome::Processed(first) = first else {
            panic!("first empty project must receive the checkpoint");
        };
        assert_eq!(first.project_id, "project-idle-a");
        let second = run_incremental_freshness_cycle(&db).expect("second bounded wake");
        let IncrementalFreshnessCycleOutcome::Processed(second) = second else {
            panic!("second empty project must receive the checkpoint on the next wake");
        };
        assert_eq!(second.project_id, "project-idle-b");
        assert_eq!(
            run_incremental_freshness_cycle(&db).expect("third bounded wake"),
            IncrementalFreshnessCycleOutcome::Idle
        );
        db.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE run_kind = 'freshness-evaluation'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 2, "one checkpoint per project, no same-wake churn");
            Ok::<_, anyhow::Error>(())
        })
        .expect("inspect bounded multi-project wake");
    }

    #[test]
    fn idle_checkpoint_suppresses_missing_epoch_and_unclean_cursor_candidates() {
        let missing_epoch = Database::new(std::path::Path::new(":memory:")).expect("open db");
        missing_epoch.migrate().expect("migrate db");
        missing_epoch
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-no-epoch', 'No epoch')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project without an Epoch");
        assert_eq!(
            run_incremental_freshness_cycle(&missing_epoch).expect("missing epoch wake"),
            IncrementalFreshnessCycleOutcome::Idle
        );

        for mutation in [
            "missing",
            "ack-mismatch",
            "error",
            "reservation",
            "lease",
            "epoch",
        ] {
            let db = rotated_idle_checkpoint_db();
            db.with_conn(|conn| {
                if mutation == "missing" {
                    conn.execute(
                        "DELETE FROM narrative_change_cursors
                          WHERE project_id = ?1 AND consumer_id = ?2",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID],
                    )?;
                    return Ok::<_, anyhow::Error>(());
                }
                conn.execute(
                    "UPDATE narrative_change_cursors
                        SET acknowledged_through_sequence = 1,
                            lease_owner = NULL, lease_expires_at = NULL,
                            last_error = NULL, reserved_through_sequence = NULL,
                            active_run_id = NULL, semantic_epoch_id = NULL
                      WHERE project_id = ?1 AND consumer_id = ?2",
                    params![PROJECT_ID, CURSOR_CONSUMER_ID],
                )?;
                match mutation {
                    "ack-mismatch" => conn.execute(
                        "UPDATE narrative_change_cursors
                            SET acknowledged_through_sequence = 0
                          WHERE project_id = ?1 AND consumer_id = ?2",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID],
                    )?,
                    "error" => conn.execute(
                        "UPDATE narrative_change_cursors SET last_error = 'cursor failure'
                          WHERE project_id = ?1 AND consumer_id = ?2",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID],
                    )?,
                    "reservation" => conn.execute(
                        "UPDATE narrative_change_cursors
                            SET reserved_through_sequence = 1,
                                active_run_id = 'incremental-e0-completed',
                                semantic_epoch_id = 'epoch-c2-1-idle-e1'
                          WHERE project_id = ?1 AND consumer_id = ?2",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID],
                    )?,
                    "lease" => conn.execute(
                        "UPDATE narrative_change_cursors SET lease_owner = 'stale-owner'
                          WHERE project_id = ?1 AND consumer_id = ?2",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID],
                    )?,
                    "epoch" => conn.execute(
                        "UPDATE narrative_change_cursors SET semantic_epoch_id = ?3
                          WHERE project_id = ?1 AND consumer_id = ?2",
                        params![PROJECT_ID, CURSOR_CONSUMER_ID, EPOCH_ID],
                    )?,
                    _ => unreachable!("test mutation is exhaustive"),
                };
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed unclean cursor");
            let outcome = run_incremental_freshness_cycle(&db).expect("unclean cursor wake");
            if matches!(mutation, "missing" | "ack-mismatch") {
                let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
                    panic!("a missing/behind cursor with Feed work must process real Feed work");
                };
                assert_eq!(summary.from_sequence_exclusive, 0);
                assert_eq!(summary.through_sequence_inclusive, 1);
                db.with_conn(|conn| {
                    let idle_runs: i64 = conn.query_row(
                        "SELECT COUNT(*)
                           FROM narrative_extraction_runs
                          WHERE project_id = ?1 AND semantic_epoch_id = 'epoch-c2-1-idle-e1'
                            AND work_key LIKE 'incremental-freshness:%:1:1:%'",
                        [PROJECT_ID],
                        |row| row.get(0),
                    )?;
                    assert_eq!(idle_runs, 0);
                    Ok::<_, anyhow::Error>(())
                })
                .expect("inspect ack-mismatch non-idle processing");
            } else {
                assert_eq!(
                    outcome,
                    IncrementalFreshnessCycleOutcome::Idle,
                    "cursor mutation {mutation} must not mint a checkpoint"
                );
            }
        }
    }

    #[test]
    fn idle_checkpoint_publish_rejects_epoch_rotation_and_feed_advance() {
        for mutation in ["epoch", "feed"] {
            let db = rotated_idle_checkpoint_db();
            let batch = reserve_claimed_idle_checkpoint(&db);
            db.with_conn(|conn| {
                match mutation {
                    "epoch" => {
                        conn.execute(
                            "INSERT INTO narrative_semantic_epochs
                                (id, project_id, epoch_number, reason, created_at)
                             VALUES ('epoch-c2-1-idle-e2', ?1, 2, 'restore',
                                     '2026-08-19T00:00:20.000Z')",
                            [PROJECT_ID],
                        )?;
                    }
                    "feed" => {
                        conn.execute(
                            "UPDATE narrative_change_events
                                SET canonical_sequence = 2
                              WHERE id = 'event-phase-cas' AND project_id = ?1",
                            [PROJECT_ID],
                        )?;
                    }
                    _ => unreachable!("test mutation is exhaustive"),
                }
                Ok::<_, anyhow::Error>(())
            })
            .expect("mutate idle checkpoint publish authority");
            let error = db
                .with_conn(|conn| {
                    with_immediate_transaction(conn, |conn| {
                        publish_batch_in_tx(conn, &batch, &EvaluationPlan::empty())
                    })
                })
                .expect_err("stale idle checkpoint must not publish");
            assert!(
                error
                    .to_string()
                    .contains("NEX_PUBLISH_RUNTIME_STALE_RESERVATION")
                    || error
                        .to_string()
                        .contains("NEX_INCREMENTAL_FRESHNESS_IDLE_CHECKPOINT_STALE"),
                "mutation {mutation} returned unexpected stale error: {error:#}"
            );
            db.with_conn(|conn| {
                let change_sets: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_sets WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(change_sets, 0);
                Ok::<_, anyhow::Error>(())
            })
            .expect("inspect stale idle checkpoint publication");
        }
    }

    fn mark_component_schema_change(db: &Database) {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_change_events
                    SET object_key_json = ?1,
                        structural_impact_json = ?2
                  WHERE id = 'event-phase-cas'",
                params![
                    r#"{"kind":"component","componentId":"extractor"}"#,
                    r#"{"event":"schema-component-changed","requiresFullRebuild":true}"#,
                ],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("mark CAS Feed event as component schema change");
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

    #[test]
    fn project_scope_authority_feed_selection_is_axis_exact() {
        let event = |kind: &str,
                     node_type: &str,
                     change_kind: &str,
                     mutation_kind: &str,
                     paths: &[&str]| {
            let changed_paths = paths
                .iter()
                .map(|path| (*path).to_owned())
                .collect::<Vec<_>>();
            let mut structural_impact = serde_json::json!({
                "changedPaths": changed_paths,
                "nodeType": node_type,
            });
            if node_type == "folder" {
                structural_impact["liveSceneSubtreeImpact"] = serde_json::json!({
                    "beforeCount": 1,
                    "afterCount": 1,
                });
            }
            NarrativeChangeEventRecord {
                event_id: format!("scope-{kind}-{node_type}-{mutation_kind}"),
                project_id: PROJECT_ID.to_owned(),
                transaction_id: "scope-transaction".to_owned(),
                canonical_change_event_uid: "scope-canonical".to_owned(),
                canonical_sequence: 1,
                event_ordinal: 0,
                object_key: if kind == "scene" {
                    serde_json::json!({ "kind": "scene", "sceneId": "scene-scope" })
                } else {
                    serde_json::json!({
                        "kind": "component",
                        "componentId": "tree-node:node-scope",
                    })
                },
                change_kind: change_kind.to_owned(),
                mutation_kind: mutation_kind.to_owned(),
                before_version: Some(1),
                before_digest: Some("sha256:before".to_owned()),
                after_version: Some(2),
                after_digest: Some("sha256:after".to_owned()),
                changed_paths: changed_paths.clone(),
                text_impact: None,
                structural_impact: Some(structural_impact),
                cause_kind: super::super::change_feed::NarrativeChangeCauseKind::Forward,
                origin: super::super::change_feed::NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: Vec::new(),
                occurred_at: OCCURRED_AT.to_owned(),
            }
        };

        assert!(event_changes_project_scope_authority(&event(
            "scene",
            "scene",
            "metadata",
            "update",
            &["/sortOrder"],
        )));
        assert!(event_changes_project_scope_authority(&event(
            "component",
            "folder",
            "metadata",
            "update",
            &["/parentId"],
        )));
        let mut empty_folder = event("component", "folder", "metadata", "update", &["/sortOrder"]);
        empty_folder.structural_impact = Some(serde_json::json!({
            "changedPaths": ["/sortOrder"],
            "nodeType": "folder",
            "liveSceneSubtreeImpact": {
                "beforeCount": 0,
                "afterCount": 0,
            },
        }));
        assert!(!event_changes_project_scope_authority(&empty_folder));
        assert!(!event_changes_project_scope_authority(&event(
            "scene",
            "scene",
            "content",
            "restore",
            &["/content", "/charCount"],
        )));
        assert!(!event_changes_project_scope_authority(&event(
            "scene",
            "scene",
            "calendar",
            "update",
            &["/"],
        )));
        assert!(event_changes_project_scope_authority(&event(
            "scene",
            "scene",
            "order",
            "update",
            &["/"],
        )));
        assert!(event_changes_project_scope_authority(&event(
            "scene",
            "scene",
            "content",
            "create",
            &["/"],
        )));
        assert!(!event_changes_project_scope_authority(&event(
            "component",
            "folder",
            "metadata",
            "create",
            &["/"],
        )));
        assert!(!event_changes_project_scope_authority(&event(
            "component",
            "note",
            "metadata",
            "update",
            &["/sortOrder"],
        )));
        assert!(!event_changes_project_scope_authority(&event(
            "component",
            "folder",
            "metadata",
            "update",
            &["/storyTimeOrder"],
        )));
    }

    #[test]
    fn project_reset_scope_dominates_a_mixed_component_schema_batch() {
        let marker = |kind: &str, structural_event: &str| NarrativeChangeEventRecord {
            event_id: format!("marker-{kind}-{structural_event}"),
            project_id: PROJECT_ID.to_owned(),
            transaction_id: "marker-transaction".to_owned(),
            canonical_change_event_uid: "marker-canonical".to_owned(),
            canonical_sequence: 1,
            event_ordinal: 0,
            object_key: serde_json::json!({ "kind": kind }),
            change_kind: "schema".to_owned(),
            mutation_kind: "update".to_owned(),
            before_version: Some(1),
            before_digest: Some("sha256:before".to_owned()),
            after_version: Some(2),
            after_digest: Some("sha256:after".to_owned()),
            changed_paths: vec!["/".to_owned()],
            text_impact: None,
            structural_impact: Some(serde_json::json!({ "event": structural_event })),
            cause_kind: super::super::change_feed::NarrativeChangeCauseKind::Forward,
            origin: super::super::change_feed::NarrativeChangeOrigin::Migration,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: Vec::new(),
            occurred_at: OCCURRED_AT.to_owned(),
        };
        let events = vec![
            marker("component", "schema-component-changed"),
            marker("project", "project-restored"),
        ];
        assert_eq!(
            select_v2_shadow_scope(&events, std::iter::empty()),
            V2ShadowSelectionScope::ProjectResetGlobal
        );
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
    fn incremental_feed_skips_reserved_semantic_index_without_mutating_any_surface() {
        let db = fixture_db();
        let (semantic_existing_edge_id, semantic_absent_edge_id) = db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_semantic_index_metadata
                        (project_id, index_key, generation, built_at, source_digest,
                         dependency_set_digest, dirty_cache_flag)
                     VALUES (?1, 'lexical', 7, '2026-08-15T00:00:00.000Z',
                             'source-before', 'dependency-before', 0)",
                    params![PROJECT_ID],
                )?;
                let existing = record_dependency_edge_in_tx(
                    conn,
                    PROJECT_ID,
                    "semantic-index",
                    "lexical-existing",
                    &format!("project:scene:{SCENE_ID}"),
                    r#"["/body"]"#,
                    None,
                    None,
                    OCCURRED_AT,
                )?;
                let absent = record_dependency_edge_in_tx(
                    conn,
                    PROJECT_ID,
                    "semantic-index",
                    "lexical-absent",
                    &format!("project:scene:{SCENE_ID}"),
                    r#"["/content"]"#,
                    None,
                    None,
                    OCCURRED_AT,
                )?;
                conn.execute(
                    "INSERT INTO narrative_dependency_edge_states
                        (edge_id, project_id, evidence_freshness, reason_code, build_action,
                         evaluated_at_epoch_id, evaluated_at)
                     VALUES (?1, ?2, 'stale', 'source-revision-changed',
                             'rebuild-required', ?3, '2026-08-15T00:00:02.000Z')",
                    params![existing, PROJECT_ID, EPOCH_ID],
                )?;
                conn.execute(
                    "INSERT INTO narrative_consumer_freshness
                        (project_id, consumer_kind, consumer_key, evidence_freshness,
                         build_action, semantic_epoch_id, last_evaluated_run_id, updated_at)
                     VALUES (?1, 'semantic-index', 'lexical-existing', 'stale',
                             'rebuild-required', ?2, 'previous-run', '2026-08-15T00:00:02.000Z')",
                    params![PROJECT_ID, EPOCH_ID],
                )?;
                Ok::<_, anyhow::Error>((existing, absent))
            })
            .expect("seed reserved Semantic Index Feed fixture");

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
                          WHERE project_id = ?1 AND consumer_kind = 'semantic-index'
                            AND consumer_key = 'lexical-existing'",
                        params![PROJECT_ID],
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
                let edge_snapshot: (String, String) = conn.query_row(
                    "SELECT consumer_key, read_set_json
                       FROM narrative_dependency_edges WHERE id = ?1",
                    params![semantic_existing_edge_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let metadata: (i64, String, String, i64) = conn.query_row(
                    "SELECT generation, source_digest, dependency_set_digest, dirty_cache_flag
                       FROM narrative_semantic_index_metadata
                      WHERE project_id = ?1 AND index_key = 'lexical'",
                    params![PROJECT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                let finding_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
                      WHERE project_id = ?1 AND finding_key LIKE 'semantic-index:%'",
                    params![PROJECT_ID],
                    |row| row.get(0),
                )?;
                Ok::<_, anyhow::Error>((
                    existing_state,
                    existing_freshness,
                    edge_snapshot,
                    metadata,
                    finding_count,
                ))
            })
            .expect("capture reserved surfaces before Feed cycle");

        let outcome = run_incremental_freshness_cycle(&db).expect("run incremental Feed cycle");
        let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
            panic!("the fixture Feed must produce one processed cycle");
        };
        assert_eq!(summary.affected_edge_count, 1);
        assert_eq!(summary.affected_consumer_count, 1);

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
                      WHERE project_id = ?1 AND consumer_kind = 'semantic-index'
                        AND consumer_key = 'lexical-existing'",
                    params![PROJECT_ID],
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
            let absent_edge_state_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                params![semantic_absent_edge_id],
                |row| row.get(0),
            )?;
            let absent_freshness_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_kind = 'semantic-index'
                    AND consumer_key = 'lexical-absent'",
                params![PROJECT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(absent_edge_state_count, 0);
            assert_eq!(absent_freshness_count, 0);
            let edge_snapshot: (String, String) = conn.query_row(
                "SELECT consumer_key, read_set_json
                   FROM narrative_dependency_edges WHERE id = ?1",
                params![semantic_existing_edge_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(edge_snapshot, before.2);
            let metadata: (i64, String, String, i64) = conn.query_row(
                "SELECT generation, source_digest, dependency_set_digest, dirty_cache_flag
                   FROM narrative_semantic_index_metadata
                  WHERE project_id = ?1 AND index_key = 'lexical'",
                params![PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(metadata, before.3);
            let finding_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
                  WHERE project_id = ?1 AND finding_key LIKE 'semantic-index:%'",
                params![PROJECT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(finding_count, before.4);
            let supported_freshness: String = conn.query_row(
                "SELECT evidence_freshness FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_kind = 'narrative-extraction-run'
                    AND consumer_key = ?2",
                params![PROJECT_ID, CONSUMER_RUN_ID],
                |row| row.get(0),
            )?;
            assert_eq!(supported_freshness, "stale");
            let acknowledged: i64 = conn.query_row(
                "SELECT acknowledged_through_sequence FROM narrative_change_cursors
                  WHERE project_id = ?1 AND consumer_id = ?2",
                params![PROJECT_ID, CURSOR_CONSUMER_ID],
                |row| row.get(0),
            )?;
            assert_eq!(acknowledged, 1, "Feed cycle must acknowledge its range");
            Ok::<_, anyhow::Error>(())
        })
        .expect("reserved surfaces must remain unchanged after Feed cycle");
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
    fn publish_commits_v1_and_discards_shadow_when_a_new_affected_v2_head_appears() {
        let db = fixture_db();
        let (batch, plan) = reserve_and_evaluate(&db);
        seed_shadow_head(
            &db,
            CONSUMER_RUN_ID,
            &format!("project:scene:{SCENE_ID}"),
            0,
            1,
        );

        let drift = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect("a new affected V2 head is drift, not a V1 failure")
            .expect("shadow drift must be reported alongside the committed V1 publication");
        assert!(
            drift.contains("NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED"),
            "unexpected drift diagnostic: {drift}"
        );
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
        .expect("inspect V1 acknowledgement after shadow drift");
    }

    #[test]
    fn publish_commits_v1_and_discards_shadow_when_an_affected_v2_head_changes() {
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

        let drift = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect("a changed affected V2 head is drift, not a V1 failure")
            .expect("shadow drift must be reported alongside the committed V1 publication");
        assert!(
            drift.contains("NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED"),
            "unexpected drift diagnostic: {drift}"
        );
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
        .expect("inspect V1 acknowledgement after shadow drift");
    }

    #[test]
    fn publish_commits_v1_and_discards_shadow_on_new_project_wide_v2_head() {
        let db = fixture_db();
        mark_component_schema_change(&db);
        let (batch, plan) = reserve_and_evaluate(&db);
        assert_eq!(
            plan.v2_shadow_scope,
            V2ShadowSelectionScope::ComponentSchemaGlobal
        );
        seed_component_shadow_head(&db, PROJECT_ID, CONSUMER_RUN_ID, 0, 1);

        let drift = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect("a new project-wide V2 head is drift, not a V1 failure")
            .expect("shadow drift must be reported alongside the committed V1 publication");
        assert!(
            drift.contains("NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED"),
            "unexpected drift diagnostic: {drift}"
        );
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
        .expect("inspect V1 acknowledgement after shadow drift");
    }

    #[test]
    fn publish_commits_v1_and_discards_shadow_on_changed_project_wide_v2_head() {
        let db = fixture_db();
        mark_component_schema_change(&db);
        seed_component_shadow_head(&db, PROJECT_ID, CONSUMER_RUN_ID, 0, 1);
        let (batch, plan) = reserve_and_evaluate(&db);
        seed_component_shadow_head(&db, PROJECT_ID, CONSUMER_RUN_ID, 1, 2);

        let drift = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect("a changed project-wide V2 head is drift, not a V1 failure")
            .expect("shadow drift must be reported alongside the committed V1 publication");
        assert!(
            drift.contains("NEX_V2_SHADOW_DECLARATION_INPUT_CHANGED"),
            "unexpected drift diagnostic: {drift}"
        );
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
        .expect("inspect V1 acknowledgement after shadow drift");
    }

    #[test]
    fn unrelated_project_v2_head_drift_does_not_block_component_schema_publication() {
        let db = fixture_db();
        mark_component_schema_change(&db);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('unrelated-project', 'Unrelated')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed unrelated project");
        let (batch, plan) = reserve_and_evaluate(&db);
        seed_component_shadow_head(&db, "unrelated-project", "unrelated-consumer", 0, 1);

        let drift = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect("unrelated project V2 head must stay outside the global project guard");
        assert!(drift.is_none(), "unexpected drift: {drift:?}");

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
        .expect("inspect V1 acknowledgement after unrelated project drift");
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

        let drift = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| publish_batch_in_tx(conn, &batch, &plan))
            })
            .expect("unrelated V2 head must stay outside the bounded publication guard");
        assert!(drift.is_none(), "unexpected drift: {drift:?}");

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
