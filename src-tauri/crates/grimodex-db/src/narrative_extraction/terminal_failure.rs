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
    ensure_epoch_project, latest_terminal_failure_lifecycle_for_identity,
    latest_terminal_failure_observation_order, record_terminal_failure_lifecycle_in_tx,
    record_terminal_failure_observation_in_tx, resolve_terminal_failure_lifecycle_in_tx,
    validate_terminal_failure_replay_in_tx, FindingLifecycleState, TerminalFailureLifecycleWrite,
    TerminalFailureObservationWrite, TerminalFailureResolutionWrite, TerminalFailureRunBinding,
};
use super::maintenance_runtime::{
    classify_failure, AutomaticRunKind, FailureClass, WorkKey, LEGACY_BACKFILL_WORK_KEY,
    REBUILD_DERIVED_WORK_KEY, VERIFY_WORK_KEY_PREFIX,
};
use super::task_leases::with_immediate_transaction;
use crate::Database;

/// Consumer label used only by the Inbox read model. It is not a Freshness
/// authority and has no corresponding row in `narrative_consumer_freshness`.
pub const TERMINAL_FAILURE_CONSUMER_KIND: &str = "narrative-maintenance-failure";

const TERMINAL_FAILURE_EVIDENCE: EvidenceFreshness = EvidenceFreshness::Unknown;

/// Map a validated terminal NEX code to the diagnostic reason vocabulary that
/// predates terminal failures. The NEX code remains the immutable primary
/// evidence; this compatibility bucket is deliberately typed by semantic
/// family rather than reporting every contract failure as
/// `component-incompatible`. Codes with no narrower declared family use that
/// existing broad compatibility bucket as an explicit, non-specific fallback;
/// the exact NEX code remains the primary evidence.
fn reason_code_for_failure(failure_code: &str) -> anyhow::Result<FindingReasonCode> {
    anyhow::ensure!(
        failure_code.starts_with("NEX_"),
        "NEX_FINDING_FAILURE_CODE_INVALID: terminal code must start with NEX_"
    );
    let reason = if failure_code == "NEX_VERIFY_NO_EPOCH"
        || failure_code.contains("_NO_EPOCH")
        || failure_code.ends_with("_SOURCE_MISSING")
    {
        FindingReasonCode::SourceMissing
    } else if failure_code.contains("READ_SET") {
        FindingReasonCode::ReadSetDrift
    } else if failure_code.contains("TARGET_MODIFIED") || failure_code.contains("TARGET_MISSING") {
        FindingReasonCode::TargetModified
    } else if failure_code.contains("CONTEXT_OVERLAP") {
        FindingReasonCode::ContextOverlap
    } else if failure_code.contains("NORMALIZER") {
        FindingReasonCode::NormalizerIncompatible
    } else {
        // Contract/version/digest/identity/invariant families and future NEX
        // terminal codes intentionally share this broad compatibility bucket.
        // The exact code remains the primary immutable evidence.
        FindingReasonCode::ComponentIncompatible
    };
    Ok(reason)
}

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
    _run_id: String,
    run_kind: String,
    work_key: String,
    semantic_epoch_id: String,
    terminal_order_time: String,
}

#[derive(Debug)]
struct MaintenanceRunLedgerRow {
    id: String,
    project_id: String,
    status: String,
    run_kind: String,
    work_key: Option<String>,
    semantic_epoch_id: Option<String>,
    terminal_reason_code: Option<String>,
    created_at: String,
    completed_at: Option<String>,
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
    let row: Option<MaintenanceRunLedgerRow> = conn
        .query_row(
            "SELECT id, project_id, status, run_kind, work_key, semantic_epoch_id,
                    terminal_reason_code, created_at, completed_at
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![run_id],
            |row| {
                Ok(MaintenanceRunLedgerRow {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    status: row.get(2)?,
                    run_kind: row.get(3)?,
                    work_key: row.get(4)?,
                    semantic_epoch_id: row.get(5)?,
                    terminal_reason_code: row.get(6)?,
                    created_at: row.get(7)?,
                    completed_at: row.get(8)?,
                })
            },
        )
        .optional()?;
    let Some(MaintenanceRunLedgerRow {
        id: run_id,
        project_id: run_project_id,
        status,
        run_kind,
        work_key,
        semantic_epoch_id,
        terminal_reason_code,
        created_at,
        completed_at,
    }) = row
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
    ensure_epoch_project(conn, project_id, &semantic_epoch_id)?;
    let terminal_order_time = if expected_status == "completed" {
        completed_at.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_FINDING_RUN_ORDER_MISSING: completed Run has no durable completion time"
            )
        })?
    } else {
        created_at
    };
    Ok(MaintenanceRunContext {
        project_id: project_id.to_string(),
        _run_id: run_id,
        run_kind,
        work_key,
        semantic_epoch_id,
        terminal_order_time,
    })
}

fn validate_canonical_work_key(context: &MaintenanceRunContext) -> anyhow::Result<()> {
    let expected = match context.run_kind.as_str() {
        "backfill" => LEGACY_BACKFILL_WORK_KEY.to_string(),
        "dependency-verify" => {
            format!("{VERIFY_WORK_KEY_PREFIX}{}", context.semantic_epoch_id)
        }
        "semantic-index-rebuild" => REBUILD_DERIVED_WORK_KEY.to_string(),
        other => anyhow::bail!(
            "NEX_FINDING_RUN_KIND_INVALID: run kind '{other}' is not an automatic maintenance kind"
        ),
    };
    anyhow::ensure!(
        context.work_key == expected,
        "NEX_FINDING_WORK_KEY_POLICY_MISMATCH: work key '{}' is not canonical for run kind '{}' and epoch '{}' (expected '{}')",
        context.work_key,
        context.run_kind,
        context.semantic_epoch_id,
        expected
    );
    Ok(())
}

fn terminal_evidence(
    stable_subject: &str,
    failure_code: &str,
    reason_code: FindingReasonCode,
) -> anyhow::Result<(String, String)> {
    let input = ObservationDigestInput {
        stable_subject,
        edge_id: None,
        failure_code: Some(failure_code),
        reason_code: reason_code.as_str(),
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
            reason_code: reason_code.as_str(),
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
    validate_canonical_work_key(&context)?;
    if classification.class == FailureClass::Transient
        || classification.code == "NEX_RUN_SUPERSEDED"
        || classification.code == "NEX_MAINTENANCE_INTERRUPTED"
    {
        return skipped_outcome(&context, classification.code);
    }

    record_failure_projection_in_tx(
        conn,
        project_id,
        run_id,
        &context,
        &classification.code,
        TerminalFailureRunBinding::TerminalCode,
        observed_at,
    )
}

/// Shared projection core: write the append-only Observation and lifecycle
/// transition for one terminal failure evidence tuple, deduplicating exact
/// replays. `failure_code` is the exact immutable evidence; the retry class
/// never overwrites it.
fn record_failure_projection_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    context: &MaintenanceRunContext,
    failure_code: &str,
    run_binding: TerminalFailureRunBinding,
    observed_at: &str,
) -> anyhow::Result<TerminalFailureProjectionOutcome> {
    let failure_code = failure_code.to_string();
    let reason_code = reason_code_for_failure(&failure_code)?;
    let stable_subject = context.stable_subject()?;
    let finding_identity = stable_finding_identity(
        MAINTENANCE_FAILURE_FINDING_RULE_ID,
        MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        &stable_subject,
    )?;
    let finding_key = context.finding_key();
    let (observation_digest, material_basis_digest) =
        terminal_evidence(&stable_subject, &failure_code, reason_code)?;
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
            reason_code,
            evidence_freshness_snapshot: TERMINAL_FAILURE_EVIDENCE,
            observation_digest: &observation_digest,
            material_basis_digest: &material_basis_digest,
            observed_at,
            run_binding,
        },
    )?;

    let lifecycle_write = TerminalFailureLifecycleWrite {
        project_id,
        run_id,
        semantic_epoch_id: &context.semantic_epoch_id,
        stable_subject: &stable_subject,
        finding_identity: &finding_identity,
        finding_key: &finding_key,
        rule_id: MAINTENANCE_FAILURE_FINDING_RULE_ID,
        rule_version: MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
        state: FindingLifecycleState::New,
        failure_code: &failure_code,
        reason_code,
        evidence_freshness_snapshot: TERMINAL_FAILURE_EVIDENCE,
        observation_digest: &observation_digest,
        material_basis_digest: &material_basis_digest,
        observed_at,
    };
    if !observation.inserted {
        let replay_state = validate_terminal_failure_replay_in_tx(conn, lifecycle_write)?;
        let latest_state = latest_terminal_failure_lifecycle_for_identity(
            conn,
            project_id,
            &finding_identity,
            &finding_key,
            &context.semantic_epoch_id,
        )?
        .map(|row| row.state)
        .unwrap_or(replay_state);
        return Ok(TerminalFailureProjectionOutcome {
            projected: false,
            finding_identity,
            finding_key,
            failure_code,
            observation_digest,
            material_basis_digest,
            lifecycle_state: Some(latest_state.as_str().to_string()),
        });
    }

    let previous = latest_terminal_failure_lifecycle_for_identity(
        conn,
        project_id,
        &finding_identity,
        &finding_key,
        &context.semantic_epoch_id,
    )?;
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
            state,
            ..lifecycle_write
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

/// Graph defects a Rebuild cannot fix require a manual Repair. This is the
/// dedicated Finding code behind the `semantic-graph-requires-repair` UI
/// degradation declared by the Run Kind policy.
pub const SEMANTIC_GRAPH_REQUIRES_REPAIR_CODE: &str = "NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR";

/// Recovery-synthesized manual codes have no failing Run finalizer of their
/// own: the individual failed Runs were transient (Finding route `none`),
/// yet automatic maintenance halts durably. These codes must still surface
/// in the Maintenance Inbox or the user sees an unexplained permanent stop.
fn is_synthetic_manual_code(code: &str) -> bool {
    matches!(
        code,
        "NEX_MAINTENANCE_RETRY_EXHAUSTED"
            | "NEX_MAINTENANCE_FAILURE_DETAIL_MISSING"
            | "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING"
    )
}

/// Durably project a recovery-synthesized `ManualIntervention` decision as a
/// terminal Finding bound to the stable work subject, the synthetic failure
/// code, and the anchored epoch. Exact contract codes are skipped: their
/// failing finalizer already projected the exact evidence. Idempotent across
/// repeated cycles; returns `None` when nothing needed projection.
pub(crate) fn project_manual_intervention_finding(
    db: &Database,
    work: &WorkKey,
    code: &str,
) -> anyhow::Result<Option<TerminalFailureProjectionOutcome>> {
    if !is_synthetic_manual_code(code) {
        return Ok(None);
    }
    let observed_at = grimodex_core::now_rfc3339_millis();
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            // Anchor on the latest failed Run for the work identity; the
            // Finding identity itself is run-independent.
            let anchor: Option<(String, Option<String>, String)> = conn
                .query_row(
                    "SELECT id, semantic_epoch_id,
                            COALESCE(completed_at, started_at, created_at)
                       FROM narrative_extraction_runs
                      WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3
                        AND status = 'failed'
                        AND (?4 IS NULL OR semantic_epoch_id = ?4)
                      ORDER BY julianday(COALESCE(completed_at, started_at, created_at)) DESC,
                               id ASC
                      LIMIT 1",
                    params![
                        work.project_id,
                        work.run_kind.as_str(),
                        work.work_key,
                        work.semantic_epoch_id.as_deref(),
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((run_id, row_epoch_id, terminal_order_time)) = anchor else {
                return Ok(None);
            };
            let Some(semantic_epoch_id) = work
                .semantic_epoch_id
                .clone()
                .or(row_epoch_id)
                .filter(|epoch| !epoch.trim().is_empty())
            else {
                // A legacy epoch-less anchor cannot carry an epoch-bound
                // Finding; leave it to the epoch-bound rediscovery.
                return Ok(None);
            };
            ensure_epoch_project(conn, &work.project_id, &semantic_epoch_id)?;
            let context = MaintenanceRunContext {
                project_id: work.project_id.clone(),
                _run_id: run_id.clone(),
                run_kind: work.run_kind.as_str().to_string(),
                work_key: work.work_key.clone(),
                semantic_epoch_id,
                terminal_order_time,
            };
            validate_canonical_work_key(&context)?;
            record_failure_projection_in_tx(
                conn,
                &work.project_id,
                &run_id,
                &context,
                code,
                TerminalFailureRunBinding::SyntheticRecovery,
                &observed_at,
            )
            .map(Some)
        })
    })
}

/// Project the durable "graph requires manual Repair" Finding for a
/// completed, non-clean, non-rebuild Verify report. The Finding is anchored
/// on the completed Verify Run whose outcome carries the exact report,
/// report digest, and repair candidates; a semantically different report is
/// produced by a newer Verify Run and re-surfaces the Finding through that
/// new anchor. A later clean confirmation Verify for the same epoch-bound
/// work key resolves the chain.
pub(crate) fn project_graph_repair_required_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    semantic_epoch_id: &str,
    report_digest: &str,
    observed_at: &str,
) -> anyhow::Result<TerminalFailureProjectionOutcome> {
    anyhow::ensure!(!report_digest.trim().is_empty(), "reportDigest is required");
    ensure_epoch_project(conn, project_id, semantic_epoch_id)?;
    let context = MaintenanceRunContext {
        project_id: project_id.to_string(),
        _run_id: run_id.to_string(),
        run_kind: "dependency-verify".to_string(),
        work_key: format!("{VERIFY_WORK_KEY_PREFIX}{semantic_epoch_id}"),
        semantic_epoch_id: semantic_epoch_id.to_string(),
        terminal_order_time: observed_at.to_string(),
    };
    validate_canonical_work_key(&context)?;
    record_failure_projection_in_tx(
        conn,
        project_id,
        run_id,
        &context,
        SEMANTIC_GRAPH_REQUIRES_REPAIR_CODE,
        TerminalFailureRunBinding::CompletedReport,
        observed_at,
    )
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
    if validate_canonical_work_key(&context).is_err() {
        return Ok(TerminalFailureResolutionOutcome {
            resolved: false,
            finding_identity,
            finding_key,
        });
    }
    let Some((failure_observed_at, current_material_basis_digest)) =
        latest_terminal_failure_observation_order(
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
    // A successful Run can close a terminal failure only when its durable
    // completion time is strictly newer than the Observation that recorded
    // that failure. Equal or malformed timestamps fail closed; no implicit
    // SQLite rowid or UUID ordering is used as a chronology surrogate.
    let success_is_newer: Option<i64> = conn.query_row(
        "SELECT CASE
                    WHEN julianday(?1) IS NOT NULL AND julianday(?2) IS NOT NULL
                         AND julianday(?1) > julianday(?2)
                    THEN 1 ELSE 0
                END",
        params![context.terminal_order_time, failure_observed_at],
        |row| row.get(0),
    )?;
    if success_is_newer != Some(1) {
        return Ok(TerminalFailureResolutionOutcome {
            resolved: false,
            finding_identity,
            finding_key,
        });
    }
    if latest_terminal_failure_lifecycle_for_identity(
        conn,
        project_id,
        &finding_identity,
        &finding_key,
        &context.semantic_epoch_id,
    )?
    .is_some_and(|latest| latest.state == FindingLifecycleState::Resolved)
    {
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
