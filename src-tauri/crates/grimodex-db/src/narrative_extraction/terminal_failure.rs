//! Terminal maintenance failure -> Finding projection (C2-5B Lane C).
//!
//! This boundary owns classification and work identity only. The append-only
//! Observation and lifecycle rows are written by `finding_observation`, while
//! the Maintenance Inbox joins them directly as a read model. No Consumer
//! Freshness, Dependency Edge, Domain state, or Attention row is created here.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::evaluator::{EvidenceFreshness, FindingReasonCode};
use super::finding_identity::{
    material_basis_digest, observation_digest, stable_finding_identity, MaterialBasisInput,
    ObservationDigestInput, MAINTENANCE_FAILURE_FINDING_RULE_ID,
    MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
};
use super::finding_observation::{
    latest_finding_lifecycle_for_identity, latest_terminal_failure_observation_run_order,
    record_terminal_failure_lifecycle_in_tx, record_terminal_failure_observation_in_tx,
    resolve_terminal_failure_lifecycle_in_tx, FindingLifecycleState, TerminalFailureLifecycleWrite,
    TerminalFailureObservationWrite, TerminalFailureResolutionWrite,
};
use super::maintenance_runtime::{classify_failure, AutomaticRunKind, FailureClass};
use super::task_leases::with_immediate_transaction;
use crate::Database;

/// Consumer label used only by the Inbox read model. It is not a Freshness
/// authority and has no corresponding row in `narrative_consumer_freshness`.
pub const TERMINAL_FAILURE_CONSUMER_KIND: &str = "narrative-maintenance-failure";

const TERMINAL_FAILURE_REASON_CODE: FindingReasonCode = FindingReasonCode::ComponentIncompatible;
const TERMINAL_FAILURE_EVIDENCE: EvidenceFreshness = EvidenceFreshness::Unknown;

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct TerminalFailureProjectionOutcome {
    /// False means this call was transiently skipped or was an idempotent
    /// replay. Neither case creates a second Observation.
    pub projected: bool,
    pub finding_identity: String,
    pub finding_key: String,
    pub failure_code: String,
    pub observation_digest: String,
    pub material_basis_digest: String,
    pub lifecycle_state: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct TerminalFailureResolutionOutcome {
    pub resolved: bool,
    pub finding_identity: String,
    pub finding_key: String,
}

#[derive(Clone, Debug)]
struct MaintenanceRunContext {
    project_id: String,
    run_rowid: i64,
    run_kind: String,
    work_key: String,
    semantic_epoch_id: String,
}

impl MaintenanceRunContext {
    fn stable_subject(&self) -> anyhow::Result<String> {
        // JSON tuple encoding avoids ambiguity if a work key itself contains
        // a colon. The epoch and Run id are deliberately absent: a harmless
        // rerun in the same project/kind/work unit keeps one Finding identity.
        serde_json::to_string(&(
            "narrative-maintenance-work",
            self.project_id.as_str(),
            self.run_kind.as_str(),
            self.work_key.as_str(),
        ))
        .map_err(Into::into)
    }

    fn finding_key(&self) -> String {
        format!(
            "{TERMINAL_FAILURE_CONSUMER_KIND}:{}:{}",
            self.run_kind, self.work_key
        )
    }
}

fn load_run_context(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    expected_status: &str,
) -> anyhow::Result<MaintenanceRunContext> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!run_id.trim().is_empty(), "runId is required");
    let row: Option<(
        i64,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT rowid, project_id, status, run_kind, work_key, semantic_epoch_id,
                    terminal_reason_code
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
                ))
            },
        )
        .optional()?;
    let Some((
        run_rowid,
        run_project_id,
        status,
        run_kind,
        work_key,
        semantic_epoch_id,
        terminal_reason_code,
    )) = row
    else {
        anyhow::bail!("NEX_FINDING_RUN_MISSING: run '{run_id}' was not found");
    };
    anyhow::ensure!(
        run_project_id == project_id,
        "NEX_FINDING_RUN_PROJECT_MISMATCH: run belongs to another project"
    );
    anyhow::ensure!(
        status == expected_status,
        "NEX_FINDING_RUN_STATUS_INVALID: run '{run_id}' must be '{expected_status}', got '{status}'"
    );
    if expected_status == "completed" {
        anyhow::ensure!(
            terminal_reason_code.is_none(),
            "NEX_FINDING_RUN_TERMINAL_CODE_INVALID: completed Run carries terminal failure evidence"
        );
    }
    anyhow::ensure!(
        AutomaticRunKind::all()
            .iter()
            .any(|kind| kind.as_str() == run_kind),
        "NEX_FINDING_RUN_KIND_INVALID: run '{run_id}' is not an automatic maintenance Run"
    );
    let work_key = work_key
        .ok_or_else(|| anyhow::anyhow!("NEX_FINDING_WORK_KEY_MISSING: run has no work key"))?;
    anyhow::ensure!(
        !work_key.trim().is_empty(),
        "NEX_FINDING_WORK_KEY_MISSING: work key is empty"
    );
    anyhow::ensure!(
        !work_key
            .chars()
            .any(|character| matches!(character, '/' | '\\')),
        "NEX_FINDING_WORK_KEY_INVALID: work key must not contain path separators"
    );
    let semantic_epoch_id = semantic_epoch_id.ok_or_else(|| {
        anyhow::anyhow!("NEX_FINDING_EPOCH_MISSING: maintenance Run has no Semantic Epoch")
    })?;
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semantic epoch is required"
    );
    Ok(MaintenanceRunContext {
        project_id: project_id.to_string(),
        run_rowid,
        run_kind,
        work_key,
        semantic_epoch_id,
    })
}

fn terminal_evidence(stable_subject: &str, failure_code: &str) -> anyhow::Result<(String, String)> {
    let input = ObservationDigestInput {
        stable_subject,
        edge_id: None,
        failure_code: Some(failure_code),
        reason_code: TERMINAL_FAILURE_REASON_CODE.as_str(),
        evidence_freshness: TERMINAL_FAILURE_EVIDENCE.as_str(),
    };
    let observation = observation_digest(
        MAINTENANCE_FAILURE_FINDING_RULE_ID,
        MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        &input,
    )?;
    let material_basis = material_basis_digest(
        MAINTENANCE_FAILURE_FINDING_RULE_ID,
        MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        &MaterialBasisInput {
            stable_subject,
            edge_id: None,
            failure_code: Some(failure_code),
            reason_code: TERMINAL_FAILURE_REASON_CODE.as_str(),
            evidence_freshness: TERMINAL_FAILURE_EVIDENCE.as_str(),
        },
    )?;
    Ok((observation, material_basis))
}

fn skipped_outcome(
    context: &MaintenanceRunContext,
    failure_code: String,
) -> anyhow::Result<TerminalFailureProjectionOutcome> {
    let stable_subject = context.stable_subject()?;
    let finding_identity = stable_finding_identity(
        MAINTENANCE_FAILURE_FINDING_RULE_ID,
        MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        &stable_subject,
    )?;
    Ok(TerminalFailureProjectionOutcome {
        projected: false,
        finding_identity,
        finding_key: context.finding_key(),
        failure_code,
        observation_digest: String::new(),
        material_basis_digest: String::new(),
        lifecycle_state: None,
    })
}

pub(crate) fn project_terminal_failure_for_run_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    failure_message: &str,
    observed_at: &str,
    allow_unset_terminal_code: bool,
) -> anyhow::Result<TerminalFailureProjectionOutcome> {
    anyhow::ensure!(
        !failure_message.trim().is_empty(),
        "failureMessage is required"
    );
    anyhow::ensure!(!observed_at.trim().is_empty(), "observedAt is required");
    let context = load_run_context(conn, project_id, run_id, "failed")?;
    let classification = classify_failure(failure_message);
    let existing_terminal_reason_code: Option<String> = conn
        .query_row(
            "SELECT terminal_reason_code
               FROM narrative_extraction_runs
              WHERE id = ?1 AND project_id = ?2 AND status = 'failed'",
            params![run_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    anyhow::ensure!(
        allow_unset_terminal_code || existing_terminal_reason_code.is_some(),
        "NEX_FINDING_FAILURE_CODE_MISSING: terminalization must persist the Run failure code before projection"
    );
    if let Some(existing) = existing_terminal_reason_code.as_deref() {
        anyhow::ensure!(
            existing == classification.code,
            "NEX_FINDING_FAILURE_CODE_MISMATCH: caller failure evidence does not match the durable Run terminal code"
        );
    } else if allow_unset_terminal_code {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET terminal_reason_code = ?1
              WHERE id = ?2 AND project_id = ?3 AND status = 'failed'
                AND terminal_reason_code IS NULL",
            params![classification.code, run_id, project_id],
        )?;
    }
    if classification.class == FailureClass::Transient
        || classification.code == "NEX_RUN_SUPERSEDED"
        || classification.code == "NEX_MAINTENANCE_INTERRUPTED"
    {
        return skipped_outcome(&context, classification.code);
    }

    let failure_code = classification.code;
    let stable_subject = context.stable_subject()?;
    let finding_identity = stable_finding_identity(
        MAINTENANCE_FAILURE_FINDING_RULE_ID,
        MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        &stable_subject,
    )?;
    let finding_key = context.finding_key();
    let (observation_digest, material_basis_digest) =
        terminal_evidence(&stable_subject, &failure_code)?;
    let observation = record_terminal_failure_observation_in_tx(
        conn,
        TerminalFailureObservationWrite {
            project_id,
            run_id,
            semantic_epoch_id: &context.semantic_epoch_id,
            stable_subject: &stable_subject,
            finding_key: &finding_key,
            finding_identity: &finding_identity,
            rule_id: MAINTENANCE_FAILURE_FINDING_RULE_ID,
            rule_version: MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
            failure_code: &failure_code,
            reason_code: TERMINAL_FAILURE_REASON_CODE,
            evidence_freshness_snapshot: TERMINAL_FAILURE_EVIDENCE,
            observation_digest: &observation_digest,
            material_basis_digest: &material_basis_digest,
            observed_at,
        },
    )?;

    let previous = latest_finding_lifecycle_for_identity(conn, project_id, &finding_identity)?;
    let state = match previous.as_ref() {
        None => FindingLifecycleState::New,
        Some(row) if row.run_id == run_id => row.state,
        Some(row)
            if row.material_basis_digest.as_deref() == Some(material_basis_digest.as_str()) =>
        {
            FindingLifecycleState::Recurring
        }
        Some(_) => FindingLifecycleState::Changed,
    };
    let lifecycle_inserted = record_terminal_failure_lifecycle_in_tx(
        conn,
        TerminalFailureLifecycleWrite {
            project_id,
            run_id,
            semantic_epoch_id: &context.semantic_epoch_id,
            stable_subject: &stable_subject,
            finding_identity: &finding_identity,
            finding_key: &finding_key,
            rule_id: MAINTENANCE_FAILURE_FINDING_RULE_ID,
            rule_version: MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
            state,
            failure_code: &failure_code,
            reason_code: TERMINAL_FAILURE_REASON_CODE,
            evidence_freshness_snapshot: TERMINAL_FAILURE_EVIDENCE,
            observation_digest: &observation_digest,
            material_basis_digest: &material_basis_digest,
            observed_at,
        },
    )?;
    Ok(TerminalFailureProjectionOutcome {
        projected: observation.inserted || lifecycle_inserted,
        finding_identity,
        finding_key,
        failure_code,
        observation_digest,
        material_basis_digest,
        lifecycle_state: Some(state.as_str().to_string()),
    })
}

/// Classify and durably project one failed automatic maintenance Run. The
/// Observation and lifecycle transition commit atomically; transient and
/// superseded failures return `projected: false` with no Finding row.
pub fn project_terminal_failure_for_run(
    db: &Database,
    project_id: &str,
    run_id: &str,
    failure_message: &str,
) -> anyhow::Result<TerminalFailureProjectionOutcome> {
    let observed_at = grimodex_core::now_rfc3339_millis();
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            project_terminal_failure_for_run_in_tx(
                conn,
                project_id,
                run_id,
                failure_message,
                &observed_at,
                false,
            )
        })
    })
}

pub(crate) fn resolve_terminal_failure_for_run_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    observed_at: &str,
) -> anyhow::Result<TerminalFailureResolutionOutcome> {
    let context = load_run_context(conn, project_id, run_id, "completed")?;
    let stable_subject = context.stable_subject()?;
    let finding_identity = stable_finding_identity(
        MAINTENANCE_FAILURE_FINDING_RULE_ID,
        MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        &stable_subject,
    )?;
    let finding_key = context.finding_key();
    let Some((failure_run_rowid, current_material_basis_digest)) =
        latest_terminal_failure_observation_run_order(
            conn,
            project_id,
            &context.semantic_epoch_id,
            &finding_identity,
            &finding_key,
            MAINTENANCE_FAILURE_FINDING_RULE_ID,
            MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        )?
    else {
        return Ok(TerminalFailureResolutionOutcome {
            resolved: false,
            finding_identity,
            finding_key,
        });
    };
    // SQLite's durable Run rowid is the execution-ledger order. A completed
    // Run created before the failure cannot close it merely because the
    // resolver was called later (wall-clock timestamps may tie).
    if context.run_rowid <= failure_run_rowid {
        return Ok(TerminalFailureResolutionOutcome {
            resolved: false,
            finding_identity,
            finding_key,
        });
    }
    if latest_finding_lifecycle_for_identity(conn, project_id, &finding_identity)?.is_some_and(
        |latest| {
            latest.state == FindingLifecycleState::Resolved
                && latest.semantic_epoch_id == context.semantic_epoch_id
        },
    ) {
        return Ok(TerminalFailureResolutionOutcome {
            resolved: false,
            finding_identity,
            finding_key,
        });
    }
    let lifecycle_id = resolve_terminal_failure_lifecycle_in_tx(
        conn,
        TerminalFailureResolutionWrite {
            project_id,
            run_id,
            semantic_epoch_id: &context.semantic_epoch_id,
            stable_subject: &stable_subject,
            finding_identity: &finding_identity,
            finding_key: &finding_key,
            rule_id: MAINTENANCE_FAILURE_FINDING_RULE_ID,
            rule_version: MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
            material_basis_digest: &current_material_basis_digest,
            observed_at,
        },
    )?;
    Ok(TerminalFailureResolutionOutcome {
        resolved: lifecycle_id.is_some(),
        finding_identity,
        finding_key,
    })
}

/// Resolve the active terminal Finding for the same project/run-kind/work-key
/// after a successful maintenance Run. Different work keys, run kinds, or
/// epochs cannot close one another's Finding identity.
pub fn resolve_terminal_failure_for_run(
    db: &Database,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<TerminalFailureResolutionOutcome> {
    let observed_at = grimodex_core::now_rfc3339_millis();
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            resolve_terminal_failure_for_run_in_tx(conn, project_id, run_id, &observed_at)
        })
    })
}
