//! C2-ZC canonical Freshness cutover.
//!
//! C2-ZA owns the read-only, durable readiness probes.  This module is the
//! small runtime boundary that is allowed to turn those probes into a
//! workspace-wide authority decision.  In particular, a completed database
//! Run is not scheduler liveness: the cutover API requires an explicit,
//! shared-Rust receipt minted by the main/N-API scheduler after a successful
//! cycle and combines it with the existing fail-closed readiness report.
//!
//! The marker is an activation record, not a second Freshness store.  Once it
//! exists, `narrative_consumer_freshness` is the only current Freshness value
//! this module reads or writes; the old projection tables remain compatibility
//! data and are never consulted as a fallback.

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::c2z_preparation::{
    inspect_workspace_cutover_readiness, ReadinessGate, ReadinessState, WorkspaceCutoverReadiness,
};
use super::consumer_identity::APPLICATION_CONSUMER_KIND;
use super::dependency_edges::{
    canonical_source_object_identity, consumer_dependency_set_digest, record_dependency_edge_in_tx,
};
use super::evaluator::{BuildAction, EvidenceFreshness};
use super::incremental_freshness::SuccessfulIncrementalFreshnessCycle;
use super::maintenance_lifecycle::load_completed_maintenance_run_in_tx;
use super::maintenance_runtime::{
    is_scan_staging_project_in_tx, NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION,
    REBUILD_DERIVED_WORK_KEY,
};
use super::reconciliation_envelope::SourceBasisRow;
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};
use super::task_leases::with_immediate_transaction;
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
use crate::{read_sqlite_source_revision, Database};

/// Durable activation marker for the C2-ZC Generic Consumer Freshness
/// authority.  This is intentionally a data marker rather than a schema
/// version: the schema already contains both Freshness tables and the marker
/// table.
pub const C2_ZC_CUTOVER_MIGRATION_ID: &str = Database::C2_ZC_CUTOVER_MIGRATION_ID;
pub const C2_ZC_CUTOVER_CONTRACT_VERSION: i64 = Database::C2_ZC_CUTOVER_CONTRACT_VERSION;

/// The evidence required to distinguish a completed DB Run from a scheduler
/// that is still alive and able to process the next Feed event. The main/N-API
/// owner obtains this value from shared Rust after a successful cycle; the
/// database accepts it only when it matches the current process-local receipt.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerLivenessEvidence {
    pub scheduler_instance_id: String,
    pub observed_at: String,
    pub project_ids: Vec<String>,
}

/// The sole authority exposed by the canonical read API after cutover.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CanonicalFreshnessAuthority {
    GenericConsumerFreshness,
}

/// A validated Generic Consumer Freshness row.  `authority` is deliberately
/// typed so a caller cannot mistake this read for the compatibility table.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalFreshnessRow {
    pub application_id: String,
    pub authority: CanonicalFreshnessAuthority,
    pub evidence_freshness: String,
    pub build_action: String,
    pub semantic_epoch_id: String,
    pub last_evaluated_run_id: Option<String>,
    pub dependency_set_digest: Option<String>,
    pub updated_at: String,
}

/// Readiness after combining C2-ZA's durable report with the external
/// scheduler liveness evidence.  `durable` is retained verbatim so callers
/// can distinguish a blocked graph/contract from an unavailable scheduler.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalCutoverReadiness {
    pub state: ReadinessState,
    pub ready: bool,
    pub reasons: Vec<String>,
    pub durable: WorkspaceCutoverReadiness,
    pub scheduler_liveness: ReadinessGate,
}

/// Receipt returned by the one-way authority activation.  Repeating a call
/// after the same marker is present is idempotent and returns the same
/// contract coordinates.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalCutoverReceipt {
    pub migration_id: String,
    pub contract_version: i64,
    pub authority: CanonicalFreshnessAuthority,
}

const MAX_SCHEDULER_LIVENESS_AGE: Duration = Duration::from_secs(5);

struct LiveSchedulerReceipt {
    evidence: SchedulerLivenessEvidence,
    authority_id: String,
    generation: u64,
    /// `Database` serializes access to one rusqlite connection.  The
    /// connection-local epoch is minted when that Database opens, so an
    /// authority A heartbeat cannot be replayed against authority B when both
    /// databases happen to expose the same project ids or a pointer address is
    /// later reused.
    connection_epoch: String,
    registered_at: Instant,
}

static LIVE_SCHEDULER_RECEIPT: OnceLock<Mutex<Option<LiveSchedulerReceipt>>> = OnceLock::new();

/// Inspect C2-ZC readiness.  Passing `None` is intentionally never enough:
/// the DB-only cursor/run proof remains an `Incomplete` gate even when every
/// durable row happens to be at the Feed head.
pub fn inspect_workspace_cutover_readiness_with_liveness(
    conn: &Connection,
    evidence: Option<&SchedulerLivenessEvidence>,
) -> Result<CanonicalCutoverReadiness> {
    let durable = inspect_workspace_cutover_readiness(conn)?;
    let project_ids = workspace_project_ids(conn)?;
    let mut reasons = Vec::new();

    let scheduler_liveness = match evidence {
        None => {
            reasons.push("scheduler-liveness-evidence-required".to_string());
            ReadinessGate {
                state: ReadinessState::Incomplete,
                completed: false,
                passed: false,
                reasons: vec!["scheduler-liveness-evidence-required".to_string()],
            }
        }
        Some(evidence) => {
            match validate_registered_scheduler_liveness(conn, evidence, &project_ids) {
                Ok(()) => ReadinessGate {
                    state: ReadinessState::Passed,
                    completed: true,
                    passed: true,
                    reasons: Vec::new(),
                },
                Err(reason) => {
                    let reason = reason.to_string();
                    reasons.push(reason.clone());
                    ReadinessGate {
                        state: ReadinessState::Blocked,
                        completed: false,
                        passed: false,
                        reasons: vec![reason],
                    }
                }
            }
        }
    };

    for project in &durable.projects {
        reasons.extend(project_gate_reasons(project, scheduler_liveness.passed));
    }

    let durable_requirements_passed =
        durable_requirements_passed(&durable, scheduler_liveness.passed);
    if !durable_requirements_passed && reasons.is_empty() {
        reasons.push("durable-cutover-readiness-incomplete".to_string());
    }
    let state = if scheduler_liveness.state == ReadinessState::Blocked
        || durable.state == ReadinessState::Blocked
    {
        ReadinessState::Blocked
    } else if !durable_requirements_passed || !scheduler_liveness.passed {
        ReadinessState::Incomplete
    } else {
        ReadinessState::Passed
    };

    Ok(CanonicalCutoverReadiness {
        state,
        ready: state == ReadinessState::Passed,
        reasons,
        durable,
        scheduler_liveness,
    })
}

/// Activate Generic Consumer Freshness as the workspace's canonical current
/// value.  The check and marker write occur under one immediate transaction;
/// a blocked or malformed workspace cannot leave a partial activation.
pub fn cut_over_workspace_freshness(
    conn: &Connection,
    evidence: &SchedulerLivenessEvidence,
) -> Result<CanonicalCutoverReceipt> {
    with_immediate_transaction(conn, |conn| {
        match read_cutover_marker(conn)? {
            Some(version) if version == C2_ZC_CUTOVER_CONTRACT_VERSION => {
                return Ok(CanonicalCutoverReceipt {
                    migration_id: C2_ZC_CUTOVER_MIGRATION_ID.to_string(),
                    contract_version: version,
                    authority: CanonicalFreshnessAuthority::GenericConsumerFreshness,
                });
            }
            Some(version) => anyhow::bail!(
                "NEX_C2ZC_CUTOVER_MARKER_UNSUPPORTED: marker contract version {version} is not current"
            ),
            None => {}
        }

        let readiness = inspect_workspace_cutover_readiness_with_liveness(conn, Some(evidence))?;
        anyhow::ensure!(
            readiness.ready,
            "NEX_C2ZC_CUTOVER_NOT_READY: {}",
            if readiness.reasons.is_empty() {
                "durable-cutover-readiness-incomplete".to_string()
            } else {
                readiness.reasons.join(",")
            }
        );
        validate_generic_rows_for_cutover(conn, &readiness.durable)?;
        // The irreversible cutover must not accept a clean Verify weaker
        // than an ordinary maintenance wake would: the same skip-evidence
        // evaluation (current contract coordinates, sealed graph-state
        // digest, live report CAS) runs inside this transaction against
        // each project's Verify evidence.
        for project in &readiness.durable.projects {
            let Some(current_epoch) = project.current_epoch_id.as_deref() else {
                anyhow::bail!(
                    "NEX_C2ZC_CURRENT_EPOCH_MISSING: project '{}' has no current Semantic Epoch",
                    project.project_id
                );
            };
            let coordinates = super::maintenance_contracts::current_maintenance_coordinates()?;
            let expectation = super::maintenance_skip_evidence::CompletedRunSkipExpectation {
                project_id: project.project_id.clone(),
                run_kind: "dependency-verify".to_string(),
                work_key: format!("dependency-verify:{current_epoch}"),
                semantic_epoch_id: current_epoch.to_string(),
                graph_contract_digest: coordinates.graph_contract_digest,
                rule_registry_digest: coordinates.rule_registry_digest,
                producer_generation_set_digest: coordinates.producer_generation_set_digest,
                rebuild_contract_version: super::restore_rebuild::REBUILD_CONTRACT_VERSION
                    .to_string(),
                run_kind_contract_version: super::restore_rebuild::VERIFY_CONTRACT_VERSION
                    .to_string(),
                report_digest: None,
            };
            let decision =
                super::maintenance_skip_evidence::evaluate_completed_run_skip(conn, &expectation)?;
            let super::maintenance_skip_evidence::CompletedRunSkipDecision::Skip { .. } = decision
            else {
                anyhow::bail!(
                    "NEX_C2ZC_CUTOVER_VERIFY_EVIDENCE_STALE: project '{}' Verify evidence does \
                     not satisfy the current maintenance skip contract: {decision:?}",
                    project.project_id
                );
            };
        }
        // Validation above can perform nontrivial current-state checks. The
        // activation boundary must re-read the process-local liveness receipt
        // and workspace scope immediately before writing the irreversible
        // marker; a receipt replaced/staled during readiness validation is
        // not evidence for this authority transition.
        let final_project_ids = workspace_project_ids(conn)?;
        validate_registered_scheduler_liveness(conn, evidence, &final_project_ids)?;
        let applied_at = canonical_now();
        Database::record_c2zc_cutover_marker(conn, &applied_at)?;
        Ok(CanonicalCutoverReceipt {
            migration_id: C2_ZC_CUTOVER_MIGRATION_ID.to_string(),
            contract_version: C2_ZC_CUTOVER_CONTRACT_VERSION,
            authority: CanonicalFreshnessAuthority::GenericConsumerFreshness,
        })
    })
}

/// Read one Application's current Generic Freshness after cutover.  A missing
/// Generic row is an error, not an invitation to consult the compatibility
/// table.  `None` is reserved for an Application id that is not present in
/// the project at all.
pub fn canonical_application_freshness(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
) -> Result<Option<CanonicalFreshnessRow>> {
    require_non_blank(project_id, "projectId")?;
    require_non_blank(application_id, "applicationId")?;
    ensure_cutover_active(conn)?;

    let application_exists: Option<i64> = conn
        .query_row(
            "SELECT 1
               FROM narrative_proposal_applications a
               JOIN narrative_apply_commits c ON c.id = a.commit_id
              WHERE a.id = ?1 AND c.project_id = ?2
              LIMIT 1",
            params![application_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    if application_exists.is_none() {
        return Ok(None);
    }

    #[allow(clippy::type_complexity)]
    let row: Option<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
    )> = conn
        .query_row(
            "SELECT evidence_freshness, build_action, semantic_epoch_id,
                    last_evaluated_run_id, dependency_set_digest, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![project_id, APPLICATION_CONSUMER_KIND, application_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((freshness, build_action, epoch_id, run_id, dependency_set_digest, updated_at)) = row
    else {
        anyhow::bail!(
            "NEX_C2ZC_GENERIC_FRESHNESS_MISSING: Generic Consumer Freshness is missing for application '{application_id}'"
        );
    };

    let evidence_freshness = EvidenceFreshness::try_from(freshness.as_str()).map_err(|error| {
        anyhow::anyhow!(
            "NEX_C2ZC_GENERIC_FRESHNESS_INVALID: application '{application_id}' has invalid evidence freshness: {error}"
        )
    })?;
    let build_action_kind = BuildAction::try_from(build_action.as_str()).map_err(|error| {
        anyhow::anyhow!(
            "NEX_C2ZC_GENERIC_FRESHNESS_INVALID: application '{application_id}' has invalid build action: {error}"
        )
    })?;
    let current_epoch = get_current_epoch(conn, project_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_C2ZC_GENERIC_FRESHNESS_CURRENT_EPOCH_MISSING: project '{project_id}' has no current Semantic Epoch"
        )
    })?;
    anyhow::ensure!(
        epoch_id == current_epoch.id,
        "NEX_C2ZC_GENERIC_FRESHNESS_EPOCH_MISMATCH: application '{application_id}' is evaluated at '{}' instead of current epoch '{}'",
        epoch_id,
        current_epoch.id
    );
    require_canonical_instant(&updated_at, "updatedAt")?;
    let expected_digest = consumer_dependency_set_digest(
        conn,
        project_id,
        APPLICATION_CONSUMER_KIND,
        application_id,
    )?;
    anyhow::ensure!(
        dependency_set_digest.as_deref() == Some(expected_digest.as_str()),
        "NEX_C2ZC_GENERIC_FRESHNESS_DIGEST_MISMATCH: application '{application_id}' has a dependency-set digest that does not match its current Generic Edges"
    );
    validate_freshness_evaluation_reference(
        conn,
        project_id,
        &current_epoch.id,
        application_id,
        evidence_freshness,
        build_action_kind,
        run_id.as_deref(),
    )?;

    Ok(Some(CanonicalFreshnessRow {
        application_id: application_id.to_string(),
        authority: CanonicalFreshnessAuthority::GenericConsumerFreshness,
        evidence_freshness: freshness,
        build_action,
        semantic_epoch_id: epoch_id,
        last_evaluated_run_id: run_id,
        dependency_set_digest,
        updated_at,
    }))
}

/// Validate the provenance of a canonical Generic Consumer Freshness row.
/// A runless row is a narrowly scoped pre-evaluation seed only: it must be
/// `unknown/manual`. Every evaluated state, including a `fresh/none` state,
/// requires an exact completed current-Epoch Freshness publisher Run.
fn validate_freshness_evaluation_reference(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
    application_id: &str,
    evidence_freshness: EvidenceFreshness,
    build_action: BuildAction,
    run_id: Option<&str>,
) -> Result<()> {
    let Some(run_id) = run_id else {
        anyhow::ensure!(
            evidence_freshness == EvidenceFreshness::Unknown && build_action == BuildAction::Manual,
            "NEX_C2ZC_GENERIC_FRESHNESS_RUN_REQUIRED: application '{application_id}' has '{}/{}' without lastEvaluatedRunId; only the deliberate unknown/manual pre-evaluation seed may omit it",
            evidence_freshness.as_str(),
            build_action.as_str(),
        );
        return Ok(());
    };
    validate_current_evaluation_run_reference(
        conn,
        project_id,
        current_epoch_id,
        application_id,
        run_id,
    )
}

/// A populated `last_evaluated_run_id` must be the exact completed
/// current-Epoch Freshness publisher. Incremental evaluation publishes from
/// its cursor-owned Freshness Run; a full Rebuild publishes from the strict
/// shared maintenance lifecycle owned by `dependency-rebuild-derived`.
/// Otherwise a stale Verify/Backfill id or an incomplete Rebuild ledger can
/// make old evidence look current after canonical cutover.
pub(crate) fn validate_current_evaluation_run_reference(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: &str,
    application_id: &str,
    run_id: &str,
) -> Result<()> {
    require_non_blank(run_id, "lastEvaluatedRunId")?;
    type EvaluationPublisherRow = (
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let row: Option<EvaluationPublisherRow> = conn
        .query_row(
            "SELECT project_id, run_kind, semantic_epoch_id, status, consumer_id,
                    spec_json, work_key, outcome_summary_json
               FROM narrative_extraction_runs
              WHERE id = ?1",
            [run_id],
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
        )
        .optional()?;
    let Some((
        run_project_id,
        run_kind,
        run_epoch_id,
        status,
        consumer_id,
        spec_json,
        work_key,
        outcome_summary_json,
    )) = row
    else {
        anyhow::bail!(
            "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISSING: application '{application_id}' references missing Freshness publisher Run '{run_id}'"
        );
    };
    let work_key = work_key.ok_or_else(|| anyhow::anyhow!(
        "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: consumer '{application_id}' references publisher Run '{run_id}' without a work key"
    ))?;
    anyhow::ensure!(
        !is_idle_checkpoint_publisher(
            &spec_json,
            &work_key,
            outcome_summary_json.as_deref(),
        ),
        "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: application '{application_id}' references idle checkpoint Run '{run_id}', which is scheduler evidence only and cannot publish Generic Consumer Freshness"
    );
    match run_kind.as_deref() {
        Some("freshness-evaluation") => {
            anyhow::ensure!(
                run_project_id == project_id
                    && run_epoch_id.as_deref() == Some(current_epoch_id)
                    && status == "completed"
                    && consumer_id.as_deref()
                        == Some(INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID),
                "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: application '{application_id}' references Run '{run_id}' that is not the completed current-Epoch Freshness publisher"
            );
            Ok(())
        }
        Some("semantic-index-rebuild") => {
            let handle = load_completed_maintenance_run_in_tx(conn, run_id).with_context(|| {
                format!(
                    "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: consumer '{application_id}' references Rebuild Run '{run_id}' without the exact completed maintenance lifecycle"
                )
            })?;
            anyhow::ensure!(
                handle.project_id == project_id
                    && handle.run_kind == "semantic-index-rebuild"
                    && handle.semantic_epoch_id == current_epoch_id
                    && handle.work_key == REBUILD_DERIVED_WORK_KEY,
                "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: application '{application_id}' references Run '{run_id}' that is not the completed current-Epoch Freshness publisher"
            );
            Ok(())
        }
        _ => anyhow::bail!(
            "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: application '{application_id}' references Run '{run_id}' that is not the completed current-Epoch Freshness publisher"
        ),
    }
}

/// An idle checkpoint is a zero-width scheduler receipt, not a Generic
/// Consumer Freshness publisher.  Keep this check at the shared provenance
/// boundary so both the irreversible cutover validator and the post-marker
/// canonical reader reject the same forged reference.
fn is_idle_checkpoint_publisher(
    spec_json: &str,
    work_key: &str,
    outcome_summary_json: Option<&str>,
) -> bool {
    let tagged_spec = serde_json::from_str::<Value>(spec_json)
        .ok()
        .and_then(|value| value.get("kind").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|kind| kind == "incremental-freshness-idle-checkpoint@1");
    if tagged_spec {
        return true;
    }

    let tagged_outcome = outcome_summary_json
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|value| value.get("kind").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|kind| kind == "current-epoch-idle-checkpoint");
    if tagged_outcome {
        return true;
    }

    let Some(coordinates) = work_key.strip_prefix("incremental-freshness:") else {
        return false;
    };
    let parts = coordinates.split(':').collect::<Vec<_>>();
    parts.len() == 4
        && parts[1].parse::<i64>().ok() == parts[2].parse::<i64>().ok()
        && parts[1].parse::<i64>().is_ok()
}

/// Mint and register the only scheduler-liveness receipt accepted by the
/// cutover gate.  This is called by the main-only N-API scheduler after it has
/// pinned the active workspace authority.  A caller cannot choose the
/// timestamp, project scope, scheduler instance, or generation: shared Rust
/// derives all of them from the live database and the N-API authority binding.
pub fn record_live_scheduler_heartbeat(
    db: &Database,
    authority_id: &str,
    generation: u64,
    successful_cycle: SuccessfulIncrementalFreshnessCycle,
) -> Result<SchedulerLivenessEvidence> {
    require_non_blank(authority_id, "authorityId")?;
    anyhow::ensure!(
        generation > 0 && generation <= NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION,
        "generation must be a safe non-zero integer"
    );
    let (project_ids, connection_epoch) = db.with_conn(|conn| {
        Ok((
            workspace_project_ids(conn)?,
            connection_epoch_identity(conn)?,
        ))
    })?;
    anyhow::ensure!(
        successful_cycle.connection_epoch() == connection_epoch,
        "NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_DATABASE_MISMATCH: completed Incremental Freshness cycle belongs to a different Database authority"
    );
    anyhow::ensure!(
        successful_cycle.is_fresh_for_liveness(MAX_SCHEDULER_LIVENESS_AGE),
        "NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE: completed Incremental Freshness cycle exceeded its monotonic age bound before heartbeat registration"
    );
    anyhow::ensure!(
        !project_ids.is_empty(),
        "NEX_C2ZC_SCHEDULER_LIVENESS_SCOPE_MISSING: workspace has no project"
    );
    let evidence = SchedulerLivenessEvidence {
        scheduler_instance_id: format!("narrative-freshness-scheduler:{authority_id}:{generation}"),
        observed_at: canonical_now(),
        project_ids,
    };
    let receipt = LiveSchedulerReceipt {
        evidence: evidence.clone(),
        authority_id: authority_id.to_string(),
        generation,
        connection_epoch,
        registered_at: Instant::now(),
    };
    let slot = LIVE_SCHEDULER_RECEIPT.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| anyhow::anyhow!("NEX_C2ZC_SCHEDULER_LIVENESS_REGISTRY_POISONED"))?;
    *guard = Some(receipt);
    Ok(evidence)
}

/// Crate-internal authority switch used by existing producer paths.  It is a
/// pure marker read so a caller can keep its surrounding Apply transaction.
pub(crate) fn is_generic_freshness_canonical(conn: &Connection) -> Result<bool> {
    match read_cutover_marker(conn)? {
        None => Ok(false),
        Some(version) if version == C2_ZC_CUTOVER_CONTRACT_VERSION => Ok(true),
        Some(version) => anyhow::bail!(
            "NEX_C2ZC_CUTOVER_MARKER_UNSUPPORTED: marker contract version {version} is not current"
        ),
    }
}

/// Resolve the Semantic Epoch for an ordinary Narrative Run at the C2-ZC
/// writer boundary. The marker is the only activation switch: before it, the
/// legacy NULL provenance remains valid. Scan staging Projects are hidden
/// from the canonical workspace until their publish transaction removes the
/// staging marker and mints their birth Epoch.
pub(crate) fn current_c2zc_run_epoch_in_tx(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<String>> {
    match read_cutover_marker(conn)? {
        None => Ok(None),
        Some(version) if version == C2_ZC_CUTOVER_CONTRACT_VERSION => {
            let project_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [project_id],
                |row| row.get(0),
            )?;
            if !project_exists || is_scan_staging_project_in_tx(conn, project_id)? {
                return Ok(None);
            }
            get_current_epoch(conn, project_id)?
                .map(|epoch| epoch.id)
                .map(Some)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_C2ZC_RUN_CURRENT_EPOCH_MISSING: project '{project_id}' has no current Semantic Epoch"
                    )
                })
        }
        Some(version) => anyhow::bail!(
            "NEX_C2ZC_CUTOVER_MARKER_UNSUPPORTED: marker contract version {version} is not current"
        ),
    }
}

/// The canonical authority event that proves a Project was created by one of
/// the allowed Project-birth writers.  Each variant keeps its own identity
/// contract; a generic "any change event" bootstrap would let unrelated
/// writes fabricate a Semantic Epoch boundary.
#[derive(Clone, Copy)]
enum C2zcProjectBirthAuthority<'a> {
    ProjectCreate,
    ImportApply {
        import_session_id: &'a str,
    },
    ScanPublish {
        request_id: &'a str,
        session_id: &'a str,
    },
}

impl C2zcProjectBirthAuthority<'_> {
    fn marker_unsupported_code(self) -> &'static str {
        match self {
            Self::ProjectCreate => "NEX_C2ZC_PROJECT_BIRTH_MARKER_UNSUPPORTED",
            Self::ImportApply { .. } => "NEX_C2ZC_IMPORT_PROJECT_BIRTH_MARKER_UNSUPPORTED",
            Self::ScanPublish { .. } => "NEX_C2ZC_SCAN_PUBLISH_MARKER_UNSUPPORTED",
        }
    }

    fn event_missing_code(self) -> &'static str {
        match self {
            Self::ProjectCreate => "NEX_C2ZC_PROJECT_BIRTH_EVENT_MISSING",
            Self::ImportApply { .. } => "NEX_C2ZC_IMPORT_PROJECT_BIRTH_EVENT_MISSING",
            Self::ScanPublish { .. } => "NEX_C2ZC_SCAN_PUBLISH_EVENT_MISSING",
        }
    }

    fn epoch_conflict_code(self) -> &'static str {
        match self {
            Self::ProjectCreate => "NEX_C2ZC_PROJECT_BIRTH_EPOCH_CONFLICT",
            Self::ImportApply { .. } => "NEX_C2ZC_IMPORT_PROJECT_BIRTH_EPOCH_CONFLICT",
            Self::ScanPublish { .. } => "NEX_C2ZC_SCAN_PUBLISH_EPOCH_CONFLICT",
        }
    }

    fn event_description(self) -> &'static str {
        match self {
            Self::ProjectCreate => "project.create",
            Self::ImportApply { .. } => "import.session.apply",
            Self::ScanPublish { .. } => "scan.import.publish",
        }
    }
}

/// Bind a Project created through the normal Project writer to its first
/// Semantic Epoch once C2-ZC owns Generic Consumer Freshness. The caller must
/// have appended its canonical `project.create` event in the same transaction.
pub(crate) fn mint_c2zc_project_birth_epoch_in_tx(
    conn: &Connection,
    project_id: &str,
    project_create_event_uid: &str,
) -> Result<Option<String>> {
    mint_c2zc_project_birth_epoch_for_canonical_event_in_tx(
        conn,
        project_id,
        project_create_event_uid,
        "projectCreateEventUid",
        C2zcProjectBirthAuthority::ProjectCreate,
    )
}

/// Bind a Project created through Import Apply to its first Semantic Epoch.
/// Import has a distinct canonical authority event: its exact session identity
/// and payload target must match, so an arbitrary import-domain event cannot
/// mint a Project-birth Epoch.
pub(crate) fn mint_c2zc_import_project_birth_epoch_in_tx(
    conn: &Connection,
    project_id: &str,
    import_session_id: &str,
    import_apply_event_uid: &str,
) -> Result<Option<String>> {
    require_non_blank(import_session_id, "importSessionId")?;
    mint_c2zc_project_birth_epoch_for_canonical_event_in_tx(
        conn,
        project_id,
        import_apply_event_uid,
        "importApplyEventUid",
        C2zcProjectBirthAuthority::ImportApply { import_session_id },
    )
}

/// Bind a Project published by the Scan staging writer to its first Semantic
/// Epoch. Scan has a separate canonical event identity from Import Apply:
/// only the exact publish event payload can establish this birth authority.
pub(crate) fn mint_c2zc_scan_publish_project_birth_epoch_in_tx(
    conn: &Connection,
    project_id: &str,
    request_id: &str,
    session_id: &str,
    scan_publish_event_uid: &str,
) -> Result<Option<String>> {
    require_non_blank(request_id, "requestId")?;
    require_non_blank(session_id, "sessionId")?;
    mint_c2zc_project_birth_epoch_for_canonical_event_in_tx(
        conn,
        project_id,
        scan_publish_event_uid,
        "scanPublishEventUid",
        C2zcProjectBirthAuthority::ScanPublish {
            request_id,
            session_id,
        },
    )
}

fn mint_c2zc_project_birth_epoch_for_canonical_event_in_tx(
    conn: &Connection,
    project_id: &str,
    event_uid: &str,
    event_uid_parameter_name: &str,
    authority: C2zcProjectBirthAuthority<'_>,
) -> Result<Option<String>> {
    require_non_blank(project_id, "projectId")?;
    require_non_blank(event_uid, event_uid_parameter_name)?;

    match read_cutover_marker(conn)? {
        None => return Ok(None),
        Some(version) if version == C2_ZC_CUTOVER_CONTRACT_VERSION => {}
        Some(version) => anyhow::bail!(
            "{}: marker contract version {version} is not current",
            authority.marker_unsupported_code()
        ),
    }

    let event_matches: bool = match authority {
        C2zcProjectBirthAuthority::ProjectCreate => conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM change_events
                  WHERE project_id = ?1
                    AND event_uid = ?2
                    AND domain = 'project'
                    AND op_type = 'project.create'
               )",
            params![project_id, event_uid],
            |row| row.get(0),
        )?,
        C2zcProjectBirthAuthority::ImportApply { import_session_id } => conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM change_events
                  WHERE project_id = ?1
                    AND event_uid = ?2
                    AND domain = 'import'
                    AND op_type = 'import.session.apply'
                    AND entity_type = 'import_session'
                    AND entity_id = ?3
                    AND json_extract(payload, '$.projectId') = ?1
                    AND json_extract(payload, '$.sessionId') = ?3
               )",
            params![project_id, event_uid, import_session_id],
            |row| row.get(0),
        )?,
        C2zcProjectBirthAuthority::ScanPublish {
            request_id,
            session_id,
        } => conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM change_events
                  WHERE project_id = ?1
                    AND event_uid = ?2
                    AND domain = 'scan'
                    AND op_type = 'scan.import.publish'
                    AND entity_type = 'project'
                    AND entity_id = ?1
                    AND session_id = ?4
                    AND json_valid(payload)
                    AND json_type(payload) = 'object'
                    AND json_type(payload, '$.projectId') = 'text'
                    AND json_extract(payload, '$.projectId') = ?1
                    AND json_type(payload, '$.requestId') = 'text'
                    AND json_extract(payload, '$.requestId') = ?3
                    AND json_type(payload, '$.sessionId') = 'text'
                    AND json_extract(payload, '$.sessionId') = ?4
                    AND NOT EXISTS (
                        SELECT 1 FROM json_each(payload)
                         WHERE key NOT IN (
                             'projectId', 'requestId', 'sessionId',
                             'authorityRoute', 'authorityCaller', 'authorityEvidence'
                         )
                    )
                    AND (
                        json_type(payload, '$.authorityRoute') IS NULL
                        OR json_extract(payload, '$.authorityRoute') = 'import-apply'
                    )
                    AND (
                        json_type(payload, '$.authorityCaller') IS NULL
                        OR json_extract(payload, '$.authorityCaller') = 'import-session'
                    )
               )",
            params![project_id, event_uid, request_id, session_id],
            |row| row.get(0),
        )?,
    };
    anyhow::ensure!(
        event_matches,
        "{}: Project '{}' has no canonical {} event '{}' in this transaction",
        authority.event_missing_code(),
        project_id,
        authority.event_description(),
        event_uid
    );
    anyhow::ensure!(
        get_current_epoch(conn, project_id)?.is_none(),
        "{}: Project '{}' already has a Semantic Epoch",
        authority.epoch_conflict_code(),
        project_id
    );

    Ok(Some(create_epoch_in_tx(
        conn,
        project_id,
        "initial",
        Some(event_uid),
    )?))
}

/// Producer generation for the post-cutover Application Edge writer. Folded
/// into `producer_generation_set_digest`: changing this writer's algorithm
/// must rotate the coordinate that invalidates clean-Verify reuse.
pub(crate) const C2ZC_APPLICATION_DEPENDENCY_GENERATION: &str = "c2zc-application-dependency/v1";

/// Producer-time Application declaration used once C2-ZC is active.  It
/// records only the typed Generic dependency Edges.  The incremental runtime
/// remains the sole writer of Edge State and Consumer Freshness; a new
/// Application therefore stays fail-closed until its Change Feed range is
/// evaluated by that live authority.  The caller's Apply transaction owns the
/// surrounding atomicity.
// NARRATIVE_DEPENDENCY_PRODUCER: post-cutover-application-dependency
pub(crate) fn write_application_dependencies_in_tx(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
    run_id: &str,
    source_rows: &[SourceBasisRow],
    now: &str,
) -> Result<()> {
    require_non_blank(project_id, "projectId")?;
    require_non_blank(application_id, "applicationId")?;
    require_non_blank(run_id, "runId")?;
    require_non_blank(now, "updatedAt")?;
    anyhow::ensure!(
        !source_rows.is_empty(),
        "NEX_C2ZC_APPLICATION_SOURCE_BASIS_MISSING: canonical Application writes require at least one source"
    );
    let mut sources = std::collections::BTreeMap::<String, String>::new();
    for source in source_rows {
        let identity = canonical_source_object_identity(&source.source_kind, &source.source_key)?;
        anyhow::ensure!(
            !source.revision_token.trim().is_empty()
                && source.revision_token.trim() == source.revision_token,
            "NEX_C2ZC_APPLICATION_SOURCE_TOKEN_INVALID: source '{identity}' has an invalid revision token"
        );
        if let Some(previous) = sources.insert(identity.clone(), source.revision_token.clone()) {
            anyhow::ensure!(
                previous == source.revision_token,
                "NEX_C2ZC_APPLICATION_SOURCE_TOKEN_CONFLICT: source '{identity}' has conflicting revision tokens"
            );
        }
    }

    for (identity, revision_token) in sources {
        let read_set_json = serde_json::to_string(&[revision_token])?;
        record_dependency_edge_in_tx(
            conn,
            project_id,
            APPLICATION_CONSUMER_KIND,
            application_id,
            &identity,
            &read_set_json,
            None,
            Some(run_id),
            now,
        )?;
    }
    Ok(())
}

fn ensure_cutover_active(conn: &Connection) -> Result<()> {
    match read_cutover_marker(conn)? {
        Some(version) if version == C2_ZC_CUTOVER_CONTRACT_VERSION => Ok(()),
        Some(version) => anyhow::bail!(
            "NEX_C2ZC_CUTOVER_MARKER_UNSUPPORTED: marker contract version {version} is not current"
        ),
        None => anyhow::bail!(
            "NEX_C2ZC_CUTOVER_NOT_ACTIVE: Generic Consumer Freshness cutover is not active"
        ),
    }
}

fn read_cutover_marker(conn: &Connection) -> Result<Option<i64>> {
    Database::read_c2zc_cutover_marker(conn)
}

fn workspace_project_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
    let project_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    project_ids
        .into_iter()
        .map(|project_id| -> Result<Option<String>> {
            if is_scan_staging_project_in_tx(conn, &project_id)? {
                Ok(None)
            } else {
                Ok(Some(project_id))
            }
        })
        .collect::<Result<Vec<_>>>()
        .map(|project_ids| project_ids.into_iter().flatten().collect())
}

fn validate_scheduler_liveness(
    evidence: &SchedulerLivenessEvidence,
    expected_project_ids: &[String],
) -> Result<()> {
    require_non_blank(&evidence.scheduler_instance_id, "schedulerInstanceId")?;
    require_non_blank(&evidence.observed_at, "observedAt")?;
    let parsed = DateTime::parse_from_rfc3339(&evidence.observed_at).map_err(|error| {
        anyhow::anyhow!("NEX_C2ZC_SCHEDULER_LIVENESS_INVALID: observedAt is not RFC3339: {error}")
    })?;
    anyhow::ensure!(
        parsed.to_rfc3339_opts(SecondsFormat::Millis, true) == evidence.observed_at,
        "NEX_C2ZC_SCHEDULER_LIVENESS_INVALID: observedAt must be canonical RFC3339 milliseconds"
    );
    let actual = evidence
        .project_ids
        .iter()
        .map(|project_id| project_id.trim())
        .collect::<Vec<_>>();
    anyhow::ensure!(
        actual.iter().all(|project_id| !project_id.is_empty()),
        "NEX_C2ZC_SCHEDULER_LIVENESS_INVALID: projectIds must be non-empty"
    );
    let actual_set = actual.iter().copied().collect::<BTreeSet<_>>();
    anyhow::ensure!(
        actual_set.len() == actual.len(),
        "NEX_C2ZC_SCHEDULER_LIVENESS_INVALID: projectIds must not contain duplicates"
    );
    let expected_set = expected_project_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    anyhow::ensure!(
        actual_set == expected_set,
        "NEX_C2ZC_SCHEDULER_LIVENESS_SCOPE_MISMATCH: evidence projectIds do not cover the workspace"
    );
    anyhow::ensure!(
        !actual_set.is_empty(),
        "NEX_C2ZC_SCHEDULER_LIVENESS_SCOPE_MISMATCH: workspace has no project to activate"
    );
    Ok(())
}

fn validate_registered_scheduler_liveness(
    conn: &Connection,
    evidence: &SchedulerLivenessEvidence,
    expected_project_ids: &[String],
) -> Result<()> {
    validate_scheduler_liveness(evidence, expected_project_ids)?;
    let slot = LIVE_SCHEDULER_RECEIPT.get_or_init(|| Mutex::new(None));
    let guard = slot
        .lock()
        .map_err(|_| anyhow::anyhow!("NEX_C2ZC_SCHEDULER_LIVENESS_REGISTRY_POISONED"))?;
    let Some(receipt) = guard.as_ref() else {
        anyhow::bail!(
            "NEX_C2ZC_SCHEDULER_LIVENESS_RECEIPT_MISSING: no live N-API scheduler receipt is registered"
        );
    };
    if receipt.registered_at.elapsed() > MAX_SCHEDULER_LIVENESS_AGE {
        anyhow::bail!(
            "NEX_C2ZC_SCHEDULER_LIVENESS_STALE: live scheduler receipt exceeded its monotonic age bound"
        );
    }
    anyhow::ensure!(
        receipt.evidence == *evidence,
        "NEX_C2ZC_SCHEDULER_LIVENESS_RECEIPT_MISMATCH: evidence was not minted by the current scheduler authority"
    );
    anyhow::ensure!(
        receipt.generation > 0 && !receipt.authority_id.trim().is_empty(),
        "NEX_C2ZC_SCHEDULER_LIVENESS_RECEIPT_INVALID: authority binding is invalid"
    );
    anyhow::ensure!(
        receipt.connection_epoch == connection_epoch_identity(conn)?,
        "NEX_C2ZC_SCHEDULER_LIVENESS_DATABASE_MISMATCH: receipt belongs to a different Database authority"
    );
    // The receipt is process-local and replaced on authority swap.  Reading
    // the project set again here closes the gap between N-API registration and
    // the cutover transaction without introducing a durable liveness table.
    let current_project_ids = workspace_project_ids(conn)?;
    anyhow::ensure!(
        current_project_ids == expected_project_ids,
        "NEX_C2ZC_SCHEDULER_LIVENESS_SCOPE_CHANGED: workspace project scope changed after heartbeat"
    );
    Ok(())
}

fn connection_epoch_identity(conn: &Connection) -> Result<String> {
    Ok(read_sqlite_source_revision(conn)?.connection_epoch)
}

fn project_gate_reasons(
    project: &super::c2z_preparation::ProjectCutoverReadiness,
    scheduler_liveness_passed: bool,
) -> Vec<String> {
    let mut reasons = Vec::new();
    append_gate_reasons(
        &mut reasons,
        "legacy-backfill",
        project.legacy_backfill.passed,
        &project.legacy_backfill.reasons,
        scheduler_liveness_passed,
    );
    append_gate_reasons(
        &mut reasons,
        "verify",
        project.verify.passed,
        &project.verify.reasons,
        scheduler_liveness_passed,
    );
    append_gate_reasons(
        &mut reasons,
        "derived-state-rebuild",
        project.derived_state_rebuild.passed,
        &project.derived_state_rebuild.reasons,
        scheduler_liveness_passed,
    );
    append_gate_reasons(
        &mut reasons,
        "parity",
        project.parity.passed,
        &project.parity.reasons,
        scheduler_liveness_passed,
    );
    append_gate_reasons(
        &mut reasons,
        "no-active-backfill-or-repair",
        project.no_active_backfill_or_repair.passed,
        &project.no_active_backfill_or_repair.reasons,
        scheduler_liveness_passed,
    );
    append_gate_reasons(
        &mut reasons,
        "phase-lifecycle",
        project.phase_lifecycle.passed,
        &project.phase_lifecycle.reasons,
        scheduler_liveness_passed,
    );
    append_gate_reasons(
        &mut reasons,
        "incremental-runtime",
        project.incremental_runtime.passed,
        &project.incremental_runtime.reasons,
        scheduler_liveness_passed,
    );
    reasons
}

fn append_gate_reasons(
    reasons: &mut Vec<String>,
    name: &str,
    passed: bool,
    gate_reasons: &[String],
    scheduler_liveness_passed: bool,
) {
    if passed {
        return;
    }
    let reasons_for_gate = gate_reasons
        .iter()
        .filter(|reason| {
            !(scheduler_liveness_passed
                && name == "incremental-runtime"
                && reason.as_str()
                    == "incremental-freshness-scheduler-liveness-evidence-unavailable")
        })
        .collect::<Vec<_>>();
    if reasons_for_gate.is_empty() {
        if scheduler_liveness_passed && name == "incremental-runtime" {
            return;
        }
        reasons.push(format!("{name}-not-passed"));
    } else {
        reasons.extend(
            reasons_for_gate
                .into_iter()
                .map(|reason| format!("{name}:{reason}")),
        );
    }
}

fn durable_requirements_passed(
    durable: &WorkspaceCutoverReadiness,
    scheduler_liveness_passed: bool,
) -> bool {
    !durable.projects.is_empty()
        && durable.projects.iter().all(|project| {
            project.legacy_backfill.passed
                && project.verify.passed
                && project.derived_state_rebuild.passed
                && project.parity.passed
                && project.no_active_backfill_or_repair.passed
                && project.phase_lifecycle.passed
                && (project.incremental_runtime.passed
                    || (scheduler_liveness_passed
                        && project.incremental_runtime.reasons.len() == 1
                        && project.incremental_runtime.reasons[0]
                            == "incremental-freshness-scheduler-liveness-evidence-unavailable"))
        })
}

fn validate_generic_rows_for_cutover(
    conn: &Connection,
    durable: &WorkspaceCutoverReadiness,
) -> Result<()> {
    for project in &durable.projects {
        let current_epoch = project.current_epoch_id.as_deref().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_C2ZC_CURRENT_EPOCH_MISSING: project '{}' has no current Semantic Epoch",
                project.project_id
            )
        })?;
        let mut statement = conn.prepare(
            "SELECT a.id, f.evidence_freshness, f.build_action,
                    f.semantic_epoch_id, f.last_evaluated_run_id,
                    f.dependency_set_digest, f.updated_at
               FROM narrative_proposal_applications a
               JOIN narrative_apply_commits c ON c.id = a.commit_id
               LEFT JOIN narrative_consumer_freshness f
                 ON f.project_id = c.project_id
                AND f.consumer_kind = ?2
                AND f.consumer_key = a.id
              WHERE c.project_id = ?1
              ORDER BY a.id ASC",
        )?;
        let rows = statement.query_map(
            params![project.project_id, APPLICATION_CONSUMER_KIND],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )?;
        for row in rows {
            let (
                application_id,
                freshness,
                build_action,
                epoch_id,
                last_evaluated_run_id,
                digest,
                updated_at,
            ) = row?;
            let freshness = freshness.ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_C2ZC_GENERIC_FRESHNESS_MISSING: Generic row missing for application '{application_id}'"
                )
            })?;
            let build_action = build_action.ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_C2ZC_GENERIC_FRESHNESS_CONTRACT_INVALID: build action missing for application '{application_id}'"
                )
            })?;
            let evidence_freshness = EvidenceFreshness::try_from(freshness.as_str())?;
            let build_action_kind = BuildAction::try_from(build_action.as_str())?;
            anyhow::ensure!(
                epoch_id.as_deref() == Some(current_epoch),
                "NEX_C2ZC_GENERIC_FRESHNESS_EPOCH_MISMATCH: application '{application_id}' is not at current epoch"
            );
            validate_freshness_evaluation_reference(
                conn,
                &project.project_id,
                current_epoch,
                &application_id,
                evidence_freshness,
                build_action_kind,
                last_evaluated_run_id.as_deref(),
            )?;
            anyhow::ensure!(
                digest.as_deref().is_some_and(|value| !value.trim().is_empty()),
                "NEX_C2ZC_GENERIC_FRESHNESS_DIGEST_MISSING: application '{application_id}' has no dependency-set digest"
            );
            require_canonical_instant(
                updated_at.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_C2ZC_GENERIC_FRESHNESS_UPDATED_AT_MISSING: application '{application_id}' has no update timestamp"
                    )
                })?,
                "updatedAt",
            )?;
            let expected_digest = consumer_dependency_set_digest(
                conn,
                &project.project_id,
                APPLICATION_CONSUMER_KIND,
                &application_id,
            )?;
            anyhow::ensure!(
                digest.as_deref() == Some(expected_digest.as_str()),
                "NEX_C2ZC_GENERIC_FRESHNESS_DIGEST_MISMATCH: application '{application_id}' has a dependency-set digest that does not match its current Generic Edges"
            );

            // The dependency-set digest proves which Edges exist, not that
            // they were evaluated. Every declared Generic Edge must carry a
            // current-Epoch Edge State, and the stored Consumer roll-up must
            // equal the same worst-state reduction the publish runtime
            // performs — a `fresh/none` row over stale or unevaluated Edges
            // must not survive an irreversible cutover.
            let (declared_edges, unevaluated_edges): (i64, i64) = conn.query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN s.edge_id IS NULL THEN 1 ELSE 0 END), 0)
                   FROM narrative_dependency_edges e
                   LEFT JOIN narrative_dependency_edge_states s
                     ON s.edge_id = e.id AND s.evaluated_at_epoch_id = ?4
                  WHERE e.project_id = ?1 AND e.consumer_kind = ?2 AND e.consumer_key = ?3",
                params![
                    project.project_id,
                    APPLICATION_CONSUMER_KIND,
                    application_id,
                    current_epoch
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            anyhow::ensure!(
                declared_edges > 0,
                "NEX_C2ZC_GENERIC_EDGE_STATE_MISSING: application '{application_id}' declares no Generic Edges to ground its Freshness"
            );
            anyhow::ensure!(
                unevaluated_edges == 0,
                "NEX_C2ZC_GENERIC_EDGE_STATE_MISSING: application '{application_id}' has {unevaluated_edges} Generic Edge(s) without a current-Epoch Edge State"
            );
            let worst = super::publish_runtime::worst_edge_state_for_consumer(
                conn,
                &project.project_id,
                APPLICATION_CONSUMER_KIND,
                &application_id,
                current_epoch,
            )?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_C2ZC_GENERIC_EDGE_STATE_MISSING: application '{application_id}' has no Edge State roll-up"
                )
            })?;
            anyhow::ensure!(
                worst.freshness.as_str() == freshness
                    && worst.build_action.as_str() == build_action,
                "NEX_C2ZC_GENERIC_FRESHNESS_AGGREGATION_MISMATCH: application '{application_id}' stores '{freshness}/{build_action}' but its Edge States re-aggregate to '{}/{}'",
                worst.freshness.as_str(),
                worst.build_action.as_str()
            );
        }
    }
    Ok(())
}

fn require_non_blank(value: &str, name: &str) -> Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    anyhow::ensure!(
        value.trim() == value,
        "{name} must not contain surrounding whitespace"
    );
    Ok(())
}

fn require_canonical_instant(value: &str, name: &str) -> Result<()> {
    require_non_blank(value, name)?;
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|error| {
        anyhow::anyhow!("NEX_C2ZC_CONTRACT_INSTANT_INVALID: {name} is not RFC3339: {error}")
    })?;
    anyhow::ensure!(
        parsed.to_rfc3339_opts(SecondsFormat::Millis, true) == value,
        "NEX_C2ZC_CONTRACT_INSTANT_INVALID: {name} must be canonical RFC3339 milliseconds"
    );
    Ok(())
}

fn canonical_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::path::Path;

    fn migrated_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db
    }

    #[test]
    fn import_project_birth_rejects_a_canonical_event_with_mismatched_payload_target() {
        let db = migrated_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z")?;
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, ?2)",
                    params!["imported-project", "Imported project"],
                )?;
                // The database row and session entity look like Import Apply,
                // but the canonical payload does not bind that event to this
                // Project. It must not be accepted as a birth authority.
                conn.execute(
                    "INSERT INTO change_events (
                         event_uid, project_id, scene_id, domain, op_type,
                         entity_type, entity_id, payload, session_id, sequence,
                         timestamp, prev_hash, hash
                     ) VALUES (?1, ?2, NULL, 'import', 'import.session.apply',
                               'import_session', ?3, ?4, ?3, 1, 0, '', '')",
                    params![
                        "import-event",
                        "imported-project",
                        "import-session",
                        r#"{"projectId":"another-project","sessionId":"import-session"}"#,
                    ],
                )?;

                let error = mint_c2zc_import_project_birth_epoch_in_tx(
                    conn,
                    "imported-project",
                    "import-session",
                    "import-event",
                )
                .expect_err("mismatched canonical payload must not mint a birth Epoch");
                assert!(error
                    .to_string()
                    .contains("NEX_C2ZC_IMPORT_PROJECT_BIRTH_EVENT_MISSING"));
                let epoch_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = ?1",
                    ["imported-project"],
                    |row| row.get(0),
                )?;
                assert_eq!(epoch_count, 0);
                Ok(())
            })
        })
        .expect("verify mismatched Import authority event is rejected");
    }

    #[test]
    fn scan_publish_birth_requires_its_exact_canonical_event_payload() {
        let db = migrated_db();
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z")?;
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, ?2)",
                    params!["scan-project", "Scan project"],
                )?;
                conn.execute(
                    "INSERT INTO change_events (
                         event_uid, project_id, scene_id, domain, op_type,
                         entity_type, entity_id, payload, session_id, sequence,
                         timestamp, prev_hash, hash
                     ) VALUES (?1, ?2, NULL, 'scan', 'scan.import.publish',
                               'project', ?2, ?3, ?4, 1, 0, '', '')",
                    params![
                        "scan-event",
                        "scan-project",
                        r#"{"projectId":"scan-project","requestId":"scan-request","sessionId":"scan-session","extra":true}"#,
                        "scan-session",
                    ],
                )?;

                let error = mint_c2zc_scan_publish_project_birth_epoch_in_tx(
                    conn,
                    "scan-project",
                    "scan-request",
                    "scan-session",
                    "scan-event",
                )
                .expect_err("extra payload fields must not mint a Scan birth Epoch");
                assert!(error
                    .to_string()
                    .contains("NEX_C2ZC_SCAN_PUBLISH_EVENT_MISSING"));
                let epoch_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = ?1",
                    ["scan-project"],
                    |row| row.get(0),
                )?;
                assert_eq!(epoch_count, 0);
                Ok(())
            })
        })
        .expect("verify exact Scan publish authority event validation");
    }
}
