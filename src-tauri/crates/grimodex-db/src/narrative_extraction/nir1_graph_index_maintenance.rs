//! Gated, ledgerless owner of the whole-project NIR-1 Graph Index build (B).
//!
//! The Graph Index (`nir1-reviewed-entity-relation:v1`) is a sealed cache over
//! the existing metadata, D1, V1 and canonical Freshness authorities. Its
//! producer is `prepare_graph_index_build` in one read transaction followed by
//! `publish_nir1_entity_relation_index_in_tx` in one write transaction. This
//! module wires that producer into the Native maintenance cycle as an owned
//! route without activating it:
//!
//! * The route is pre-activation (closed until PUB-G). It is outside the
//!   production route registry and the policy parity set, and its work kind is
//!   never persisted as a Run.
//! * [`Nir1GraphIndexBuildGate`] is closed by default. Only the validated,
//!   unpackaged CI journey seam (`trigger = nir1-graph-index-build`) or a unit
//!   test opens it. Database content never opens it. With the gate closed the
//!   judgement executes no SQL and dispatch refuses before it acquires a
//!   connection.
//! * One dispatched work is one owned attempt (one B-close budget). Phase 1 is
//!   a read transaction that re-judges the project and runs either the owned
//!   cold-reopen validation or the prepare. Phase 2 is one IMMEDIATE
//!   transaction that publishes, takes the finalization reservation and grant,
//!   and commits. Failure, cancellation or drift before COMMIT publishes
//!   nothing and leaves the previous sealed generation in place.
//! * Typed refusals (capacity, Graph contract, drift) are remembered in this
//!   process together with the exact judgement inputs, so an unchanged input is
//!   not rebuilt on every wake. Nothing about this route is persisted.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::maintenance_runtime::{
    classify_failure, error_chain_contains, is_maintenance_control_or_cleanup_error,
    is_scan_staging_project_in_tx, maintenance_stop_signal, AutomaticRunKind, DesiredWork,
    FinalizationGrantScope, MaintenanceCycleControl, MaintenanceCycleGraphControl,
    MaintenanceDispatchOutcome, NarrativeMaintenanceCiConfig, NarrativeMaintenanceCiTrigger,
    BEFORE_CUTOVER_FOLLOW_UP_REASON,
};
use super::maintenance_skip_evidence::{
    Nir1GraphIndexBuildDecision, Nir1GraphIndexBuildMode, Nir1GraphIndexBuildReason,
    Nir1GraphIndexSkipReason,
};
use super::nir1_capacity;
use super::nir1_chronicle_index::NirChronicleIndexRuntime;
use super::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};
use super::nir1_entity_relation_index::{
    cold_reopen_graph_index_with_control, prepare_graph_index_build_with_control,
    publish_nir1_entity_relation_index_in_tx_with_control, GraphIndexBuildSnapshot,
    GraphWorkControl, GraphWorkStage, INDEX_KEY, PRODUCER_ID, PRODUCER_VERSION,
};
use super::restore_rebuild::{run_maintenance_graph_phase, MAINTENANCE_CONNECTION_PREEMPTED_CODE};
use super::semantic_epoch::get_current_epoch;
use super::source_revision::is_validation_capacity_exceeded;
use super::task_leases::with_immediate_transaction;
use crate::narrative_maintenance_connection::{
    with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
};
use crate::Database;

/// Canonical work key of the gated Graph Index build. With the Semantic Epoch
/// it forms the canonical key
/// `narrative-maintenance:v1/nir1-graph-index-build/{project}/nir1-graph-index-build/epoch/{epoch}`.
pub(crate) const NIR1_GRAPH_INDEX_BUILD_WORK_KEY: &str = "nir1-graph-index-build";

const GRAPH_CONSUMER_KIND: &str = "semantic-index";
/// The binding reader treats a database below this schema as unregistered.
const GRAPH_BINDING_SCHEMA_VERSION: i64 = 35;
/// Same no-wait progress cadence as the other controlled discovery reads.
const JUDGEMENT_PROGRESS_INTERVAL: i32 = 1_000;
const TRACE_TARGET: &str = "narrative.nir1_graph_index_build";

/// Activation gate for the pre-PUB-G Graph Index build route.
///
/// The field is private and the only constructors are [`Self::closed`],
/// [`Self::from_journey_seam`] and a unit-test constructor. No database
/// content, runtime policy, renderer or IPC value can open it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Nir1GraphIndexBuildGate {
    open: bool,
}

impl Nir1GraphIndexBuildGate {
    pub(crate) const fn closed() -> Self {
        Self { open: false }
    }

    /// Open only for a validated, unpackaged CI launch whose main-only
    /// journey seam selected the Graph Index build trigger.
    pub(crate) fn from_journey_seam(config: Option<&NarrativeMaintenanceCiConfig>) -> Self {
        let selected = config.is_some_and(|config| {
            config.validate().is_ok()
                && config.trigger == Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild)
        });
        if selected {
            Self { open: true }
        } else {
            Self::closed()
        }
    }

    #[cfg(test)]
    pub(crate) const fn open_for_test() -> Self {
        Self { open: true }
    }

    pub(crate) const fn is_open(self) -> bool {
        self.open
    }
}

/// The cycle's Graph build context: the gate plus the pinned authority's
/// runtime. A gated adapter cannot be invoked without it.
#[derive(Clone, Copy)]
pub(crate) struct Nir1GraphCycleContext<'a> {
    gate: Nir1GraphIndexBuildGate,
    runtime: Option<&'a NirChronicleIndexRuntime>,
}

impl<'a> Nir1GraphCycleContext<'a> {
    pub(crate) const fn new(
        gate: Nir1GraphIndexBuildGate,
        runtime: Option<&'a NirChronicleIndexRuntime>,
    ) -> Self {
        Self { gate, runtime }
    }

    pub(crate) const fn gate_is_open(&self) -> bool {
        self.gate.is_open()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MetadataHint {
    generation: i64,
    source_digest: Option<String>,
    dependency_set_digest: Option<String>,
    dirty: i64,
    producer_id: Option<String>,
    producer_version: Option<String>,
    built_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FreshnessHint {
    evidence_freshness: String,
    build_action: String,
    semantic_epoch_id: String,
    dependency_set_digest: Option<String>,
    updated_at: String,
}

/// Identity of the sealed binding as of one judgement.
#[derive(Clone, Debug, Eq, PartialEq)]
struct BindingIdentity {
    semantic_epoch_id: String,
    metadata: Option<MetadataHint>,
    freshness: Option<FreshnessHint>,
    d1_head_version: Option<i64>,
}

/// Cheap judgement inputs. Each value is read by primary key, `EXISTS`, or an
/// indexed `MAX`, so a judgement never scans the roster. The change-feed head
/// and the A2 watermarks detect input changes while no binding exists (the
/// writers' dirty flag needs a metadata row).
#[derive(Clone, Debug, Eq, PartialEq)]
struct GraphBuildHint {
    binding: BindingIdentity,
    v1_residue: bool,
    feed_head: Option<i64>,
    a2_watermarks: [Option<i64>; 3],
    candidates: bool,
}

/// Process-local scope of one judgement: the admitted runtime owner (the
/// authority identity) and epoch, plus the connection the runtime is bound to.
#[derive(Clone, Debug, Eq, PartialEq)]
struct RecordScope {
    owner: u64,
    connection_epoch: String,
    runtime_epoch: u64,
}

#[derive(Debug)]
enum HintRead {
    Skip(Nir1GraphIndexSkipReason),
    Ready {
        scope: RecordScope,
        hint: Box<GraphBuildHint>,
    },
}

/// The process-local result of one owned attempt, keyed by its inputs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RecordedOutcome {
    Published,
    Validated,
    ValidationFailed,
    /// `limit` names the exceeded B-close bound for a capacity refusal
    /// (for example `candidate-rows` or `sql-progress`).
    Refused {
        code: String,
        limit: Option<String>,
    },
}

#[derive(Clone, Debug)]
struct RecordEntry {
    runtime_epoch: u64,
    hint: GraphBuildHint,
    outcome: RecordedOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct RecordKey {
    owner: u64,
    connection_epoch: String,
    project_id: String,
}

impl RecordKey {
    fn new(scope: &RecordScope, project_id: &str) -> Self {
        Self {
            owner: scope.owner,
            connection_epoch: scope.connection_epoch.clone(),
            project_id: project_id.to_owned(),
        }
    }
}

static RECORDS: LazyLock<Mutex<HashMap<RecordKey, RecordEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lookup_record(scope: &RecordScope, project_id: &str) -> Option<RecordEntry> {
    let records = RECORDS.lock().unwrap_or_else(|error| error.into_inner());
    records
        .get(&RecordKey::new(scope, project_id))
        .filter(|entry| entry.runtime_epoch == scope.runtime_epoch)
        .cloned()
}

fn store_record(
    scope: &RecordScope,
    project_id: &str,
    hint: GraphBuildHint,
    outcome: RecordedOutcome,
) {
    let mut records = RECORDS.lock().unwrap_or_else(|error| error.into_inner());
    // Authority identities are process-monotonic. A newer authority retires
    // every older authority's records, which keeps the map bounded by the
    // live authority's projects without a new numeric limit.
    records.retain(|key, _| key.owner >= scope.owner);
    records.insert(
        RecordKey::new(scope, project_id),
        RecordEntry {
            runtime_epoch: scope.runtime_epoch,
            hint,
            outcome,
        },
    );
}

/// Read the judgement inputs inside the caller's transaction.
fn read_build_hint(
    conn: &Connection,
    project_id: &str,
    runtime: &NirChronicleIndexRuntime,
    control: &mut dyn GraphWorkControl,
) -> Result<HintRead> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_GRAPH_BUILD_HINT_REQUIRES_TRANSACTION: Graph build judgement must read one snapshot"
    );
    control.check(GraphWorkStage::Coverage)?;
    if is_scan_staging_project_in_tx(conn, project_id)? {
        return Ok(HintRead::Skip(Nir1GraphIndexSkipReason::ScanStaging));
    }
    let schema_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if schema_version < GRAPH_BINDING_SCHEMA_VERSION {
        return Ok(HintRead::Skip(Nir1GraphIndexSkipReason::SchemaUnavailable));
    }
    let Some(epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(HintRead::Skip(Nir1GraphIndexSkipReason::NoEpoch));
    };
    let Some((owner, runtime_epoch)) = runtime.admit_native_build(conn)? else {
        return Ok(HintRead::Skip(Nir1GraphIndexSkipReason::RuntimeUnavailable));
    };
    let connection_epoch = crate::read_sqlite_source_revision(conn)?.connection_epoch;
    control.check(GraphWorkStage::Coverage)?;
    let metadata = conn
        .query_row(
            "SELECT generation, source_digest, dependency_set_digest, dirty_cache_flag,
                    producer_id, producer_version, built_at
               FROM narrative_semantic_index_metadata
              WHERE project_id = ?1 AND index_key = ?2",
            params![project_id, INDEX_KEY],
            |row| {
                Ok(MetadataHint {
                    generation: row.get(0)?,
                    source_digest: row.get(1)?,
                    dependency_set_digest: row.get(2)?,
                    dirty: row.get(3)?,
                    producer_id: row.get(4)?,
                    producer_version: row.get(5)?,
                    built_at: row.get(6)?,
                })
            },
        )
        .optional()?;
    let freshness = conn
        .query_row(
            "SELECT evidence_freshness, build_action, semantic_epoch_id,
                    dependency_set_digest, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![project_id, GRAPH_CONSUMER_KIND, INDEX_KEY],
            |row| {
                Ok(FreshnessHint {
                    evidence_freshness: row.get(0)?,
                    build_action: row.get(1)?,
                    semantic_epoch_id: row.get(2)?,
                    dependency_set_digest: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?;
    let d1_head_version = conn
        .query_row(
            "SELECT version FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![project_id, GRAPH_CONSUMER_KIND, INDEX_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let v1_residue: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM narrative_dependency_edges
             WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3
        )",
        params![project_id, GRAPH_CONSUMER_KIND, INDEX_KEY],
        |row| row.get(0),
    )?;
    control.check(GraphWorkStage::Coverage)?;
    let feed_head: Option<i64> = conn.query_row(
        "SELECT MAX(canonical_sequence) FROM narrative_change_events WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let a2_watermarks = conn.query_row(
        "SELECT (SELECT MAX(rowid) FROM narrative_proposals),
                (SELECT MAX(rowid) FROM narrative_proposal_revisions),
                (SELECT MAX(rowid) FROM narrative_proposal_decisions)",
        [],
        |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?]),
    )?;
    // Same candidate predicate as the Graph Source keyset reader; `EXISTS`
    // stops at the first current Entity/Relation proposal.
    let candidates: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM narrative_proposal_sets proposal_set
              JOIN narrative_extraction_runs extraction_run
                ON extraction_run.id = proposal_set.run_id
               AND extraction_run.project_id = proposal_set.project_id
              JOIN narrative_proposals proposal
                ON proposal.proposal_set_id = proposal_set.id
             WHERE proposal_set.project_id = ?1
               AND proposal_set.set_kind = ?2
               AND extraction_run.surface_path_id = ?3
               AND proposal.current_revision_id IS NOT NULL
        )",
        params![
            project_id,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
        ],
        |row| row.get(0),
    )?;
    control.check(GraphWorkStage::Coverage)?;
    Ok(HintRead::Ready {
        scope: RecordScope {
            owner,
            connection_epoch,
            runtime_epoch,
        },
        hint: Box::new(GraphBuildHint {
            binding: BindingIdentity {
                semantic_epoch_id: epoch.id,
                metadata,
                freshness,
                d1_head_version,
            },
            v1_residue,
            feed_head,
            a2_watermarks,
            candidates,
        }),
    })
}

/// Pure judgement over the cheap inputs and this process's record. A refusal
/// recorded for the same inputs is consulted before any build need, so an
/// unchanged over-capacity or drifted project is not rebuilt on every wake.
fn decide(hint: &GraphBuildHint, record: Option<&RecordEntry>) -> Nir1GraphIndexBuildDecision {
    use Nir1GraphIndexBuildDecision::{Build, Skip};
    let binding = &hint.binding;
    let need = match &binding.metadata {
        None => {
            if hint.v1_residue || binding.freshness.is_some() || binding.d1_head_version.is_some() {
                // A Graph surface without its metadata is not a binding the
                // producer may replace (the reader reports it as reserved).
                return Skip {
                    reason: Nir1GraphIndexSkipReason::BindingIncoherent,
                };
            }
            if !hint.candidates {
                return Skip {
                    reason: Nir1GraphIndexSkipReason::NoCandidates,
                };
            }
            Some(Nir1GraphIndexBuildReason::BindingMissing)
        }
        Some(metadata) => {
            if metadata.generation <= 0
                || !matches!(metadata.dirty, 0 | 1)
                || metadata.source_digest.is_none()
                || metadata.dependency_set_digest.is_none()
                || metadata.producer_id.as_deref() != Some(PRODUCER_ID)
                || metadata.producer_version.as_deref() != Some(PRODUCER_VERSION)
                || binding.d1_head_version.is_none_or(|version| version <= 0)
                || binding.freshness.is_none()
            {
                return Skip {
                    reason: Nir1GraphIndexSkipReason::BindingIncoherent,
                };
            }
            if metadata.dirty == 1 {
                Some(Nir1GraphIndexBuildReason::BindingDirty)
            } else if binding.freshness.as_ref().is_some_and(|freshness| {
                freshness.evidence_freshness == "fresh"
                    && freshness.build_action == "none"
                    && freshness.semantic_epoch_id == binding.semantic_epoch_id
            }) {
                None
            } else {
                Some(Nir1GraphIndexBuildReason::NotCurrent)
            }
        }
    };
    let unchanged = |entry: &RecordEntry| entry.hint == *hint;
    match (need, record) {
        (Some(_), Some(entry))
            if matches!(entry.outcome, RecordedOutcome::Refused { .. }) && unchanged(entry) =>
        {
            Skip {
                reason: Nir1GraphIndexSkipReason::RefusedUnchanged,
            }
        }
        (Some(reason), _) => Build {
            mode: Nir1GraphIndexBuildMode::Rebuild,
            reason,
        },
        (None, Some(entry)) => match &entry.outcome {
            RecordedOutcome::Published | RecordedOutcome::Validated
                if entry.hint.binding == hint.binding =>
            {
                Skip {
                    reason: Nir1GraphIndexSkipReason::BindingCurrent,
                }
            }
            RecordedOutcome::ValidationFailed if unchanged(entry) => Build {
                mode: Nir1GraphIndexBuildMode::Rebuild,
                reason: Nir1GraphIndexBuildReason::ValidationFailed,
            },
            RecordedOutcome::Refused { .. } if unchanged(entry) => Skip {
                reason: Nir1GraphIndexSkipReason::RefusedUnchanged,
            },
            _ => Build {
                mode: Nir1GraphIndexBuildMode::ValidateThenRebuild,
                reason: Nir1GraphIndexBuildReason::ColdReopenValidation,
            },
        },
        // A structurally current binding this process has not validated (a
        // cold reopen or a new authority) gets one owned full validation.
        (None, None) => Build {
            mode: Nir1GraphIndexBuildMode::ValidateThenRebuild,
            reason: Nir1GraphIndexBuildReason::ColdReopenValidation,
        },
    }
}

fn skipped(reason: Nir1GraphIndexSkipReason) -> (Nir1GraphIndexBuildDecision, Option<String>) {
    (Nir1GraphIndexBuildDecision::Skip { reason }, None)
}

fn log_decision(site: &'static str, decision: Nir1GraphIndexBuildDecision) {
    tracing::debug!(
        target: TRACE_TARGET,
        site,
        decision = decision.code(),
        "NIR1_GRAPH_INDEX_BUILD_DECISION"
    );
}

/// Judge one project for the gated Graph Index build. Returns the typed skip
/// evidence and, for a build, the current Semantic Epoch it was judged under.
///
/// The gate, the cycle owner, the runtime and the C2-ZC wake reasons are
/// checked before any connection is acquired; the remaining inputs are read
/// on the phase-scoped no-wait connection inside one read transaction.
pub(crate) fn judge_graph_index_build(
    db: &Database,
    project_id: &str,
    reason: &str,
    control: Option<&MaintenanceCycleControl<'_>>,
    graph: &Nir1GraphCycleContext<'_>,
) -> Result<(Nir1GraphIndexBuildDecision, Option<String>)> {
    if !graph.gate.is_open() {
        return Ok(skipped(Nir1GraphIndexSkipReason::GateClosed));
    }
    let Some(control) = control else {
        return Ok(skipped(Nir1GraphIndexSkipReason::NoCycleOwner));
    };
    let Some(runtime) = graph.runtime else {
        return Ok(skipped(Nir1GraphIndexSkipReason::RuntimeUnavailable));
    };
    if reason == "before-cutover" || reason == BEFORE_CUTOVER_FOLLOW_UP_REASON {
        return Ok(skipped(Nir1GraphIndexSkipReason::BeforeCutoverFlow));
    }
    let stop = maintenance_stop_signal(Some(control));
    let config = control
        .finalization_granted_signal
        .as_ref()
        .map(|signal| {
            NarrativeMaintenanceGraphControlConfig::with_finalization_granted(Arc::clone(signal))
        })
        .unwrap_or_default();
    let result = with_narrative_maintenance_graph_control(
        db,
        Duration::ZERO,
        JUDGEMENT_PROGRESS_INTERVAL,
        stop,
        config,
        |conn, inner| {
            let mut chained = MaintenanceCycleGraphControl::new(inner, Some(control));
            let tx = conn.unchecked_transaction()?;
            let judged = match read_build_hint(&tx, project_id, runtime, &mut chained)? {
                HintRead::Skip(reason) => skipped(reason),
                HintRead::Ready { scope, hint } => {
                    let record = lookup_record(&scope, project_id);
                    (
                        decide(&hint, record.as_ref()),
                        Some(hint.binding.semantic_epoch_id),
                    )
                }
            };
            tx.rollback()?;
            Ok(judged)
        },
    )?;
    let Some(result) = result else {
        bail!(
            "{MAINTENANCE_CONNECTION_PREEMPTED_CODE}: Graph build judgement could not acquire the maintenance connection without waiting"
        );
    };
    result.into_result()
}

/// One cycle judgement of the gated route, turned into at most one
/// epoch-bound work item.
pub(crate) struct GraphBuildPlan {
    decision: Nir1GraphIndexBuildDecision,
    work: Option<DesiredWork>,
}

impl GraphBuildPlan {
    /// A stale sealed binding (dirty, not current, or not yet validated by
    /// this process) is rebuilt or validated by its own producer before the
    /// durable chain re-verifies the graph. Verify classifies every edge of a
    /// non-validated declared binding as a manual defect, so re-verifying
    /// first would halt the cycle instead of repairing a rebuildable binding.
    /// A missing binding has no footprint and waits for the durable chain.
    pub(crate) fn preempts_durable_chain(&self) -> bool {
        self.work.is_some()
            && matches!(
                self.decision,
                Nir1GraphIndexBuildDecision::Build {
                    reason: Nir1GraphIndexBuildReason::BindingDirty
                        | Nir1GraphIndexBuildReason::NotCurrent
                        | Nir1GraphIndexBuildReason::ValidationFailed
                        | Nir1GraphIndexBuildReason::ColdReopenValidation,
                    ..
                }
            )
    }

    pub(crate) fn into_work(self) -> Option<DesiredWork> {
        self.work
    }
}

/// Cycle discovery for the gated route: a `Build` judgement becomes one
/// epoch-bound work item; every `Skip` is no work.
pub(crate) fn plan_graph_index_build(
    db: &Database,
    project_id: &str,
    reason: &str,
    control: Option<&MaintenanceCycleControl<'_>>,
    graph: &Nir1GraphCycleContext<'_>,
) -> Result<GraphBuildPlan> {
    let (decision, epoch) = judge_graph_index_build(db, project_id, reason, control, graph)?;
    if graph.gate.is_open() {
        log_decision("discovery", decision);
    }
    let work = match (decision, epoch) {
        (Nir1GraphIndexBuildDecision::Build { .. }, Some(epoch)) => {
            Some(DesiredWork::new_with_epoch(
                project_id,
                AutomaticRunKind::Nir1GraphIndexBuild,
                NIR1_GRAPH_INDEX_BUILD_WORK_KEY,
                Some(epoch),
                reason,
            )?)
        }
        _ => None,
    };
    Ok(GraphBuildPlan { decision, work })
}

enum PhaseOne {
    Nothing(Nir1GraphIndexBuildDecision),
    StaleItem,
    Validated(bool),
    Prepared(Box<GraphIndexBuildSnapshot>),
}

enum BuildFailure {
    /// Cancellation, lifecycle stop, close, timeout, foreground preemption,
    /// connection cleanup, or an unproven rollback: a typed stop that leaves
    /// no record and is surfaced to the cycle unchanged.
    Stop,
    /// A transient failure for the delivery retry path.
    Retry,
    /// A typed refusal with a stable code (and, for capacity, the exceeded
    /// bound); the previous sealed generation is retained and the inputs are
    /// recorded.
    Refuse { code: String, limit: Option<String> },
}

/// Name the B-close bound behind a capacity refusal. Admission failures carry
/// their field (`NIR1_GRAPH_CAPACITY_EXCEEDED: <field> exceeds <maximum>`);
/// the attempt budget reports SQL, deadline, or the COMMIT reservation.
fn capacity_limit(error: &anyhow::Error) -> Option<String> {
    const ADMISSION: &str = "NIR1_GRAPH_CAPACITY_EXCEEDED: ";
    let text = format!("{error:#}");
    if let Some(index) = text.find(ADMISSION) {
        let field = text[index + ADMISSION.len()..]
            .split_whitespace()
            .next()
            .filter(|field| {
                field
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
            });
        if let Some(field) = field {
            return Some(field.to_owned());
        }
    }
    [
        ("NIR1 Graph SQL capacity exceeded", "sql-progress"),
        ("NIR1 Graph capacity deadline exceeded", "deadline"),
        ("COMMIT capacity reservation refused", "commit-reservation"),
    ]
    .iter()
    .find(|(marker, _)| text.contains(marker))
    .map(|(_, limit)| (*limit).to_owned())
}

fn graph_contract_code(error: &anyhow::Error) -> Option<String> {
    error.chain().find_map(|cause| {
        cause
            .to_string()
            .split(|character: char| {
                !(character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_')
            })
            .find(|token| token.starts_with("NIR1_GRAPH_") && token.len() > "NIR1_GRAPH_".len())
            .map(str::to_owned)
    })
}

fn classify_build_failure(error: &anyhow::Error) -> BuildFailure {
    if is_maintenance_control_or_cleanup_error(error)
        || error_chain_contains(error, "NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED")
        || error_chain_contains(error, "NEX_DB_TRANSACTION_CLEANUP_UNPROVEN")
    {
        return BuildFailure::Stop;
    }
    if is_validation_capacity_exceeded(error) {
        return BuildFailure::Refuse {
            code: "NIR1_GRAPH_CAPACITY_EXCEEDED".to_owned(),
            limit: capacity_limit(error),
        };
    }
    if let Some(code) = graph_contract_code(error) {
        return BuildFailure::Refuse { code, limit: None };
    }
    let classification = classify_failure(&format!("{error:#}"));
    if classification.retryable {
        BuildFailure::Retry
    } else {
        BuildFailure::Refuse {
            code: classification.code,
            limit: None,
        }
    }
}

fn settle_failure(
    error: anyhow::Error,
    observed: Option<(RecordScope, GraphBuildHint)>,
    project_id: &str,
) -> Result<MaintenanceDispatchOutcome> {
    match classify_build_failure(&error) {
        BuildFailure::Stop | BuildFailure::Retry => Err(error),
        BuildFailure::Refuse { code, limit } => {
            tracing::debug!(
                target: TRACE_TARGET,
                code = %code,
                limit = limit.as_deref().unwrap_or("none"),
                "NIR1_GRAPH_INDEX_BUILD_REFUSED"
            );
            if let Some((scope, hint)) = observed {
                store_record(
                    &scope,
                    project_id,
                    hint,
                    RecordedOutcome::Refused { code, limit },
                );
            }
            Ok(MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover: false })
        }
    }
}

/// Gated adapter for one Graph Index build work item. Reached only through
/// the gated route table, which already re-checked the gate; the gate is
/// checked again here before anything else.
pub(crate) fn dispatch_graph_index_build(
    db: &Database,
    item: &DesiredWork,
    control: Option<&MaintenanceCycleControl<'_>>,
    graph: &Nir1GraphCycleContext<'_>,
) -> Result<MaintenanceDispatchOutcome> {
    if !graph.gate.is_open() {
        return Ok(MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover: false });
    }
    ensure!(
        item.run_kind == AutomaticRunKind::Nir1GraphIndexBuild
            && item.work_key == NIR1_GRAPH_INDEX_BUILD_WORK_KEY,
        "NEX_MAINTENANCE_UNKNOWN_NIR1_GRAPH_WORK_KEY: dispatch item is not the canonical Graph Index build work"
    );
    let expected_epoch = item.semantic_epoch_id.as_deref().ok_or_else(|| {
        anyhow!(
            "NEX_MAINTENANCE_UNKNOWN_NIR1_GRAPH_WORK_KEY: Graph Index build work requires a Semantic Epoch"
        )
    })?;
    let (Some(control), Some(runtime)) = (control, graph.runtime) else {
        log_decision(
            "dispatch",
            Nir1GraphIndexBuildDecision::Skip {
                reason: if control.is_none() {
                    Nir1GraphIndexSkipReason::NoCycleOwner
                } else {
                    Nir1GraphIndexSkipReason::RuntimeUnavailable
                },
            },
        );
        return Ok(MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover: false });
    };
    (control.should_stop)()?;
    // One dispatched work is one owned full-set attempt: the B-close budget
    // (SQL counts and the cooperative deadline) covers the judgement, the
    // validation or prepare, and the publish of this work only.
    nir1_capacity::with_attempt(|| run_owned_attempt(db, item, expected_epoch, control, runtime))
}

fn run_owned_attempt(
    db: &Database,
    item: &DesiredWork,
    expected_epoch: &str,
    control: &MaintenanceCycleControl<'_>,
    runtime: &NirChronicleIndexRuntime,
) -> Result<MaintenanceDispatchOutcome> {
    let project_id = item.project_id.as_str();
    let observed = RefCell::new(None::<(RecordScope, GraphBuildHint)>);
    let phase_one = run_maintenance_graph_phase(db, control, |conn, graph_control| {
        let tx = conn.unchecked_transaction()?;
        let (scope, hint) = match read_build_hint(&tx, project_id, runtime, graph_control)? {
            HintRead::Skip(reason) => {
                tx.rollback()?;
                return Ok(PhaseOne::Nothing(Nir1GraphIndexBuildDecision::Skip {
                    reason,
                }));
            }
            HintRead::Ready { scope, hint } => (scope, *hint),
        };
        if hint.binding.semantic_epoch_id != expected_epoch {
            tx.rollback()?;
            return Ok(PhaseOne::StaleItem);
        }
        let decision = decide(&hint, lookup_record(&scope, project_id).as_ref());
        observed.replace(Some((scope, hint)));
        let outcome = match decision {
            Nir1GraphIndexBuildDecision::Skip { .. } => PhaseOne::Nothing(decision),
            Nir1GraphIndexBuildDecision::Build {
                mode: Nir1GraphIndexBuildMode::ValidateThenRebuild,
                ..
            } => {
                #[cfg(test)]
                test_hooks::fire(test_hooks::TestStage::BeforeValidation, Some(&tx))?;
                PhaseOne::Validated(cold_reopen_graph_index_with_control(
                    &tx,
                    project_id,
                    graph_control,
                )?)
            }
            Nir1GraphIndexBuildDecision::Build {
                mode: Nir1GraphIndexBuildMode::Rebuild,
                ..
            } => {
                #[cfg(test)]
                test_hooks::fire(test_hooks::TestStage::BeforePrepare, Some(&tx))?;
                PhaseOne::Prepared(Box::new(prepare_graph_index_build_with_control(
                    &tx,
                    runtime,
                    project_id,
                    graph_control,
                )?))
            }
        };
        // Close the pinned read snapshot before the phase releases the
        // connection; no transaction outlives its phase.
        tx.rollback()?;
        Ok(outcome)
    });
    let observed = observed.into_inner();
    let phase_one = match phase_one {
        Ok(phase_one) => phase_one,
        Err(error) => return settle_failure(error, observed, project_id),
    };
    match phase_one {
        PhaseOne::Nothing(decision) => {
            log_decision("dispatch", decision);
            Ok(MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover: false })
        }
        // The Semantic Epoch moved after discovery. Nothing ran; the cycle
        // re-plans the project under its current epoch.
        PhaseOne::StaleItem => {
            Ok(MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover: true })
        }
        PhaseOne::Validated(valid) => {
            let (scope, hint) = observed.ok_or_else(|| {
                anyhow!("NIR1_GRAPH_BUILD_JUDGEMENT_MISSING: validation ran without its inputs")
            })?;
            let outcome = if valid {
                RecordedOutcome::Validated
            } else {
                RecordedOutcome::ValidationFailed
            };
            tracing::debug!(
                target: TRACE_TARGET,
                valid,
                "NIR1_GRAPH_INDEX_BUILD_VALIDATED"
            );
            store_record(&scope, project_id, hint, outcome);
            // A failed validation hands the project to a fresh rebuild work
            // (a new attempt) planned by the cycle immediately.
            Ok(MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover: !valid })
        }
        PhaseOne::Prepared(snapshot) => {
            let observed = observed.ok_or_else(|| {
                anyhow!("NIR1_GRAPH_BUILD_JUDGEMENT_MISSING: prepare ran without its inputs")
            })?;
            publish_owned_snapshot(db, item, control, runtime, *snapshot, observed)
        }
    }
}

fn publish_owned_snapshot(
    db: &Database,
    item: &DesiredWork,
    control: &MaintenanceCycleControl<'_>,
    runtime: &NirChronicleIndexRuntime,
    snapshot: GraphIndexBuildSnapshot,
    prepared: (RecordScope, GraphBuildHint),
) -> Result<MaintenanceDispatchOutcome> {
    let project_id = item.project_id.as_str();
    let work_key = item.canonical_key();
    #[cfg(test)]
    if let Err(error) = test_hooks::fire(test_hooks::TestStage::BetweenPhases, None) {
        return settle_failure(error, Some(prepared), project_id);
    }
    // The prepare snapshot was closed with its phase. Observe the attempt and
    // lifecycle stop before opening the publish transaction.
    (control.should_stop)()?;
    let granted = Cell::new(false);
    let published = run_maintenance_graph_phase(db, control, |conn, graph_control| {
        // Both guards live outside the transaction closure: the reservation
        // is taken after the final controlled boundary and must last through
        // COMMIT; the grant mask ends with the transaction on every path.
        let mut reservation = None;
        let _finalization_scope = FinalizationGrantScope::new(control);
        with_immediate_transaction(conn, |conn| {
            graph_control.check(GraphWorkStage::Publish)?;
            // Cancellable: the snapshot is re-validated against the live
            // roster, Source, D1 and runtime epoch, and every write stays
            // uncommitted until the grant below.
            let binding = publish_nir1_entity_relation_index_in_tx_with_control(
                conn,
                runtime,
                snapshot,
                graph_control,
            )?;
            #[cfg(test)]
            test_hooks::fire(test_hooks::TestStage::AfterPublish, Some(conn))?;
            let HintRead::Ready { scope, hint } =
                read_build_hint(conn, project_id, runtime, graph_control)?
            else {
                bail!(
                    "NIR1_GRAPH_PUBLISHED_BINDING_INCOHERENT: the published binding has no judgement inputs"
                );
            };
            // Last controlled boundary before the finalization reservation.
            graph_control.check(GraphWorkStage::ResultAssembly)?;
            #[cfg(test)]
            test_hooks::fire(
                test_hooks::TestStage::BeforeFinalizationReservation,
                Some(conn),
            )?;
            reservation = Some(db.try_reserve_maintenance_finalization().ok_or_else(|| {
                anyhow!(
                    "{MAINTENANCE_CONNECTION_PREEMPTED_CODE}: foreground waiter arrived before the Graph finalization reservation"
                )
            })?);
            // Linearizes with cancellation: a cancel that won returns an error
            // here and the transaction rolls back. After the grant, the stop
            // set is masked until COMMIT; the SQL budget is not.
            (control.grant_finalize)(&work_key)?;
            granted.set(true);
            Ok((binding.generation, scope, hint))
        })
    });
    match published {
        Ok((generation, scope, hint)) => {
            tracing::debug!(
                target: TRACE_TARGET,
                generation,
                "NIR1_GRAPH_INDEX_BUILD_PUBLISHED"
            );
            store_record(&scope, project_id, *hint, RecordedOutcome::Published);
            Ok(MaintenanceDispatchOutcome::Completed)
        }
        // After the grant only COMMIT (and its cleanup) can fail. Keep the
        // Verify/Rebuild final-transaction semantics: surface the error.
        Err(error) if granted.get() => Err(error),
        Err(error) => settle_failure(error, Some(prepared), project_id),
    }
}

#[cfg(test)]
pub(crate) fn recorded_outcome_for_test(
    db: &Database,
    runtime: &NirChronicleIndexRuntime,
    project_id: &str,
) -> Option<RecordedOutcome> {
    let scope = db
        .with_conn(|conn| {
            let Some((owner, runtime_epoch)) = runtime.admit_native_build(conn)? else {
                return Ok(None);
            };
            Ok(Some(RecordScope {
                owner,
                connection_epoch: crate::read_sqlite_source_revision(conn)?.connection_epoch,
                runtime_epoch,
            }))
        })
        .ok()
        .flatten()?;
    lookup_record(&scope, project_id).map(|entry| entry.outcome)
}

/// Test-only injection points inside the owned attempt. The hook runs on the
/// cycle's thread with the stage's connection (inside the stage's
/// transaction), or with no connection between the two phases.
#[cfg(test)]
pub(crate) mod test_hooks {
    use rusqlite::Connection;
    use std::cell::RefCell;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum TestStage {
        BeforeValidation,
        BeforePrepare,
        BetweenPhases,
        AfterPublish,
        BeforeFinalizationReservation,
    }

    type Hook = Box<dyn FnMut(TestStage, Option<&Connection>) -> anyhow::Result<()>>;

    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) struct HookGuard;

    impl Drop for HookGuard {
        fn drop(&mut self) {
            HOOK.with(|slot| slot.borrow_mut().take());
        }
    }

    pub(crate) fn install(
        hook: impl FnMut(TestStage, Option<&Connection>) -> anyhow::Result<()> + 'static,
    ) -> HookGuard {
        HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        HookGuard
    }

    pub(super) fn fire(stage: TestStage, conn: Option<&Connection>) -> anyhow::Result<()> {
        let Some(mut hook) = HOOK.with(|slot| slot.borrow_mut().take()) else {
            return Ok(());
        };
        let result = hook(stage, conn);
        HOOK.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_none() {
                *slot = Some(hook);
            }
        });
        result
    }
}

#[cfg(test)]
#[path = "nir1_graph_index_maintenance_tests.rs"]
mod tests;
