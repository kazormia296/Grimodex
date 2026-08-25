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

use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::c2z_preparation::{
    inspect_workspace_cutover_readiness, ReadinessGate, ReadinessState, WorkspaceCutoverReadiness,
};
use super::consumer_identity::APPLICATION_CONSUMER_KIND;
use super::dependency_edges::{
    canonical_source_object_identity, consumer_dependency_set_digest, record_dependency_edge_in_tx,
};
use super::evaluator::{BuildAction, EvidenceFreshness};
use super::maintenance_runtime::NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION;
use super::reconciliation_envelope::SourceBasisRow;
use super::semantic_epoch::get_current_epoch;
use super::task_leases::with_immediate_transaction;
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

    EvidenceFreshness::try_from(freshness.as_str()).map_err(|error| {
        anyhow::anyhow!(
            "NEX_C2ZC_GENERIC_FRESHNESS_INVALID: application '{application_id}' has invalid evidence freshness: {error}"
        )
    })?;
    BuildAction::try_from(build_action.as_str()).map_err(|error| {
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
    if let Some(run_id) = run_id.as_deref() {
        let run_project: Option<String> = conn
            .query_row(
                "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        anyhow::ensure!(
            run_project.as_deref() == Some(project_id),
            "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: application '{application_id}' has a run outside project '{project_id}'"
        );
    }

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

/// Mint and register the only scheduler-liveness receipt accepted by the
/// cutover gate.  This is called by the main-only N-API scheduler after it has
/// pinned the active workspace authority.  A caller cannot choose the
/// timestamp, project scope, scheduler instance, or generation: shared Rust
/// derives all of them from the live database and the N-API authority binding.
pub fn record_live_scheduler_heartbeat(
    db: &Database,
    authority_id: &str,
    generation: u64,
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
    Ok(project_ids)
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
            EvidenceFreshness::try_from(freshness.as_str())?;
            BuildAction::try_from(build_action.as_str())?;
            anyhow::ensure!(
                epoch_id.as_deref() == Some(current_epoch),
                "NEX_C2ZC_GENERIC_FRESHNESS_EPOCH_MISMATCH: application '{application_id}' is not at current epoch"
            );
            if let Some(last_evaluated_run_id) = last_evaluated_run_id.as_deref() {
                anyhow::ensure!(
                    !last_evaluated_run_id.trim().is_empty(),
                    "NEX_C2ZC_GENERIC_FRESHNESS_RUN_INVALID: application '{application_id}' has an empty evaluation run"
                );
            }
            let run_project: Option<String> = if let Some(run_id) = last_evaluated_run_id.as_deref()
            {
                conn.query_row(
                    "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()?
            } else {
                None
            };
            if last_evaluated_run_id.is_some() {
                anyhow::ensure!(
                    run_project.as_deref() == Some(project.project_id.as_str()),
                    "NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH: application '{application_id}' has an evaluation run outside its project"
                );
            }
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
