//! Durable, contract-aware evidence for skipping a completed maintenance Run.
//!
//! C2-5B owns Run creation, recovery, and phase dispatch. This module owns the separate
//! decision that a completed Verify Run may be omitted on a later trigger.
//! Rebuild-Derived Runs are deliberately never reusable. The evidence is kept inside the existing
//! `outcome_summary_json` column, so this slice does not add a schema, key, or
//! production scheduler migration.
//!
//! The decision is deliberately fail-closed: a missing, malformed, partial,
//! stale, or terminally unsuccessful Run is a re-run, never a skip. A caller
//! supplies the current contract coordinates; no database value is promoted
//! to a current contract merely because it was previously stored.

use anyhow::{bail, ensure, Context, Result};
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::commit::digest_plan;
use super::maintenance_runtime::{REBUILD_DERIVED_WORK_KEY, VERIFY_WORK_KEY_PREFIX};
pub use super::restore_rebuild::durable_graph_state_digest;
use super::restore_rebuild::{
    canonical_verify_outcome_digest, is_canonical_graph_state_digest,
    validate_report_rebuild_required, validate_verify_check_coverage, DependencyGraphVerifyReport,
    RebuildDerivedStateSummary, REBUILD_CONTRACT_VERSION, VERIFY_CONTRACT_VERSION,
};
use super::nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage, NeverStopGraphWorkControl};
use super::task_leases::with_immediate_transaction;
use crate::Database;

/// The nested outcome key used for this evidence.
pub const COMPLETED_RUN_SKIP_EVIDENCE_FIELD: &str = "skipEvidence";

/// Current contract version for Verify's completed-run evidence coordinate.
pub const VERIFY_RUN_KIND_CONTRACT_VERSION: &str = VERIFY_CONTRACT_VERSION;

/// Rebuild's serialized coordinate is retained for diagnostics and
/// fail-closed shape validation; Rebuild completed Runs are never accepted as
/// reusable skip evidence.
pub const REBUILD_RUN_KIND_CONTRACT_VERSION: &str = REBUILD_CONTRACT_VERSION;

const VERIFY_RUN_KIND: &str = "dependency-verify";
const REBUILD_RUN_KIND: &str = "semantic-index-rebuild";

/// The complete durable coordinate sealed after a successful terminal Run.
///
/// `report_digest` is the digest of Verify's `report`. It is not a digest of
/// this evidence object; keeping those domains separate prevents an evidence
/// rewrite from making a tampered report look valid.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedRunSkipEvidence {
    pub project_id: String,
    pub run_kind: String,
    pub work_key: String,
    pub semantic_epoch_id: String,
    pub graph_contract_digest: String,
    pub rule_registry_digest: String,
    pub producer_generation_set_digest: String,
    pub rebuild_contract_version: String,
    pub run_kind_contract_version: String,
    #[serde(alias = "successfulTerminalDigest", alias = "terminalDigest")]
    pub report_digest: String,
    /// Deterministic digest of every Durable Graph Edge row for the project
    /// at seal time. Contract/registry coordinates describe the *code and
    /// contract generation*; this describes the *data*. Skip evaluation
    /// recomputes it live and refuses reuse when any Edge row changed —
    /// including same-epoch content mutations that produce no defect the
    /// report shape can see. Evidence sealed before this field existed
    /// deserializes to the empty string and can never match, so old clean
    /// Verifies re-run once and reseal.
    /// Fingerprint of the graph/projection snapshot that produced the Verify
    /// report. This is the CAS value for clean-run reuse.
    #[serde(default)]
    pub graph_state_digest: String,
}

/// Current coordinates used to decide whether a completed Run can be
/// skipped. The report digest is optional because a trigger can decide from
/// the current input contracts before it has a newly computed report. When a
/// caller has an expected digest, it is compared as an additional condition.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedRunSkipExpectation {
    pub project_id: String,
    pub run_kind: String,
    pub work_key: String,
    pub semantic_epoch_id: String,
    pub graph_contract_digest: String,
    pub rule_registry_digest: String,
    pub producer_generation_set_digest: String,
    pub rebuild_contract_version: String,
    pub run_kind_contract_version: String,
    pub report_digest: Option<String>,
}

/// Why a completed Run was not eligible for reuse.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompletedRunSkipReason {
    NoRun,
    AmbiguousLifecycle,
    LatestRunNotSuccessful,
    WorkKeyMismatch,
    OutcomeMissing,
    OutcomeMalformed,
    EvidenceMissing,
    EvidenceMalformed,
    ProjectMismatch,
    RunKindMismatch,
    EpochMismatch,
    GraphContractMismatch,
    RuleRegistryMismatch,
    ProducerGenerationMismatch,
    RebuildContractMismatch,
    RunKindContractMismatch,
    ReportDigestMismatch,
    DerivedStateInvalid,
    GraphStateMismatch,
    UnsupportedRunKind,
}

/// The only successful decision is `Skip`; every other branch is an explicit
/// request to execute Verify again. Rebuild is always a re-run by policy.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "kebab-case")]
pub enum CompletedRunSkipDecision {
    Skip {
        run_id: String,
        report_digest: String,
    },
    Rerun {
        reason: CompletedRunSkipReason,
    },
}

#[derive(Debug)]
struct LatestRun {
    id: String,
    project_id: String,
    run_kind: String,
    status: String,
    semantic_epoch_id: Option<String>,
    work_key: Option<String>,
    completed_at: Option<String>,
    outcome_summary_json: Option<String>,
    created_at: String,
}

enum LatestRunSelection {
    None,
    Ambiguous,
    InvalidTimestamp,
    Unique(Box<LatestRun>),
}

type PersistRunRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

fn parse_run_created_at(value: &str) -> Result<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .map(|parsed| DateTime::<Utc>::from_naive_utc_and_offset(parsed, Utc))
        .with_context(|| {
            format!(
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: created_at '{value}' is not a supported instant"
            )
        })
}

fn select_latest_run(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
) -> Result<LatestRunSelection> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, run_kind, status, semantic_epoch_id, work_key,
                completed_at, outcome_summary_json, created_at, started_at
           FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = ?2",
    )?;
    let rows = statement.query_map(params![project_id, run_kind], |row| {
        Ok((
            LatestRun {
                id: row.get(0)?,
                project_id: row.get(1)?,
                run_kind: row.get(2)?,
                status: row.get(3)?,
                semantic_epoch_id: row.get(4)?,
                work_key: row.get(5)?,
                completed_at: row.get(6)?,
                outcome_summary_json: row.get(7)?,
                created_at: row.get(8)?,
            },
            row.get::<_, Option<String>>(9)?,
        ))
    })?;
    // "Latest" is the run with the newest lifecycle instant
    // (`completed_at -> started_at -> created_at`), not the newest
    // `created_at`: run creation order and terminal order can interleave, and
    // a newer failure must not be bypassed by an older run that merely
    // started later. Ties and unparseable instants fail closed.
    let mut candidates = Vec::new();
    for row in rows {
        let (run, started_at) = row?;
        let lifecycle_raw = run
            .completed_at
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(started_at
                .as_deref()
                .filter(|value| !value.trim().is_empty()))
            .unwrap_or(run.created_at.as_str());
        let lifecycle_at = match parse_run_created_at(lifecycle_raw) {
            Ok(lifecycle_at) => lifecycle_at,
            Err(_) => return Ok(LatestRunSelection::InvalidTimestamp),
        };
        candidates.push((lifecycle_at, run));
    }
    let Some(max_lifecycle_at) = candidates
        .iter()
        .map(|(lifecycle_at, _)| *lifecycle_at)
        .max()
    else {
        return Ok(LatestRunSelection::None);
    };
    let mut maximal = candidates
        .into_iter()
        .filter_map(|(lifecycle_at, run)| (lifecycle_at == max_lifecycle_at).then_some(run));
    let Some(latest) = maximal.next() else {
        return Ok(LatestRunSelection::None);
    };
    if maximal.next().is_some() {
        return Ok(LatestRunSelection::Ambiguous);
    }
    Ok(LatestRunSelection::Unique(Box::new(latest)))
}

/// Decide whether the latest Run for the requested project/Run Kind carries
/// complete, current, successful skip evidence.
pub fn evaluate_completed_run_skip(
    conn: &Connection,
    expected: &CompletedRunSkipExpectation,
) -> Result<CompletedRunSkipDecision> {
    let mut control = NeverStopGraphWorkControl;
    evaluate_completed_run_skip_with_control(conn, expected, &mut control)
}

pub(crate) fn evaluate_completed_run_skip_with_control(
    conn: &Connection,
    expected: &CompletedRunSkipExpectation,
    control: &mut dyn GraphWorkControl,
) -> Result<CompletedRunSkipDecision> {
    control.check(GraphWorkStage::Restore)?;
    if validate_expectation_shape(expected).is_err() {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::EvidenceMalformed,
        });
    }
    if !is_supported_run_kind(&expected.run_kind) {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::UnsupportedRunKind,
        });
    }

    let latest = match select_latest_run(conn, &expected.project_id, &expected.run_kind)? {
        LatestRunSelection::None => {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::NoRun,
            })
        }
        LatestRunSelection::Ambiguous => {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::AmbiguousLifecycle,
            })
        }
        LatestRunSelection::InvalidTimestamp => {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::EvidenceMalformed,
            })
        }
        LatestRunSelection::Unique(latest) => *latest,
    };
    control.check(GraphWorkStage::Restore)?;

    // A newer failed/running/cancelled Run must not be bypassed by an older
    // successful Run. `completed_at` is checked as well as status because a
    // malformed terminal row is not durable success evidence.
    if latest.status != "completed"
        || latest
            .completed_at
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::LatestRunNotSuccessful,
        });
    }
    if latest.project_id != expected.project_id {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::ProjectMismatch,
        });
    }
    if latest.run_kind != expected.run_kind {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RunKindMismatch,
        });
    }
    if latest.semantic_epoch_id.as_deref() != Some(expected.semantic_epoch_id.as_str()) {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::EpochMismatch,
        });
    }
    if latest.work_key.as_deref() != Some(expected.work_key.as_str())
        || !canonical_work_key_matches(
            &latest.run_kind,
            expected.semantic_epoch_id.as_str(),
            latest.work_key.as_deref(),
        )
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::WorkKeyMismatch,
        });
    }

    let Some(outcome_json) = latest.outcome_summary_json.as_deref() else {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::OutcomeMissing,
        });
    };
    let outcome: Value = match serde_json::from_str(outcome_json) {
        Ok(value) => value,
        Err(_) => {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::OutcomeMalformed,
            })
        }
    };
    if outcome.get("semanticEpochId").and_then(Value::as_str)
        != Some(expected.semantic_epoch_id.as_str())
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::EpochMismatch,
        });
    }
    let Some(evidence_value) = outcome.get(COMPLETED_RUN_SKIP_EVIDENCE_FIELD) else {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::EvidenceMissing,
        });
    };
    let evidence: CompletedRunSkipEvidence = match serde_json::from_value(evidence_value.clone()) {
        Ok(value) => value,
        Err(_) => {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::EvidenceMalformed,
            })
        }
    };
    if validate_evidence_shape(&evidence).is_err() {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: if is_canonical_digest(&evidence.report_digest) {
                CompletedRunSkipReason::EvidenceMalformed
            } else {
                CompletedRunSkipReason::ReportDigestMismatch
            },
        });
    }

    if evidence.project_id != expected.project_id {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::ProjectMismatch,
        });
    }
    if evidence.run_kind != expected.run_kind {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RunKindMismatch,
        });
    }
    if evidence.work_key != expected.work_key {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::WorkKeyMismatch,
        });
    }
    if evidence.semantic_epoch_id != expected.semantic_epoch_id {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::EpochMismatch,
        });
    }
    if evidence.graph_contract_digest != expected.graph_contract_digest {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::GraphContractMismatch,
        });
    }
    if evidence.rule_registry_digest != expected.rule_registry_digest {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RuleRegistryMismatch,
        });
    }
    if evidence.producer_generation_set_digest != expected.producer_generation_set_digest {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::ProducerGenerationMismatch,
        });
    }
    if evidence.rebuild_contract_version != expected.rebuild_contract_version
        || expected.rebuild_contract_version != REBUILD_RUN_KIND_CONTRACT_VERSION
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RebuildContractMismatch,
        });
    }
    if evidence.run_kind_contract_version != expected.run_kind_contract_version
        || expected.run_kind_contract_version
            != supported_run_kind_contract_version(&expected.run_kind)
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RunKindContractMismatch,
        });
    }
    if outcome_contract_version(&expected.run_kind, &outcome)
        != Some(supported_run_kind_contract_version(&expected.run_kind))
        || evidence.run_kind_contract_version
            != outcome_contract_version(&expected.run_kind, &outcome).unwrap_or_default()
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RunKindContractMismatch,
        });
    }

    let outcome_digest = match successful_outcome_digest(
        &expected.run_kind,
        &outcome,
        &expected.semantic_epoch_id,
    ) {
        Ok(digest) => digest,
        Err(_) => {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::ReportDigestMismatch,
            })
        }
    };
    if expected.run_kind == VERIFY_RUN_KIND {
        let Some(report) = outcome.get("report").and_then(|value| {
            serde_json::from_value::<DependencyGraphVerifyReport>(value.clone()).ok()
        }) else {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::DerivedStateInvalid,
            });
        };
        if !report.is_clean() {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::DerivedStateInvalid,
            });
        }
        // Same-transaction data CAS first: any Edge-row change since the
        // evidence was sealed — including one that produces no defect the
        // report shape can see — refuses reuse with the precise reason.
        // Empty (pre-field) evidence never matches.
        if evidence.graph_state_digest
            != super::restore_rebuild::durable_graph_state_digest_with_control(
                conn,
                &expected.project_id,
                control,
            )?
        {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::GraphStateMismatch,
            });
        }
        if validate_report_rebuild_required(conn, &expected.project_id, &report).is_err() {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::DerivedStateInvalid,
            });
        }
        if !live_verify_report_matches_sealed_with_control(
            conn,
            &expected.project_id,
            &evidence.report_digest,
            &evidence.graph_state_digest,
            control,
        )? {
            return Ok(CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::DerivedStateInvalid,
            });
        }
    }
    if evidence.report_digest != outcome_digest
        || expected
            .report_digest
            .as_deref()
            .is_some_and(|digest| digest != evidence.report_digest)
    {
        return Ok(CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::ReportDigestMismatch,
        });
    }

    Ok(CompletedRunSkipDecision::Skip {
        run_id: latest.id,
        report_digest: evidence.report_digest,
    })
}

/// Read the nested evidence from the latest Run without making a skip
/// decision. Invalid or incomplete evidence is represented as `None`; the
/// decision API above returns the typed re-run reason for diagnostics.
pub fn read_completed_run_skip_evidence(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
) -> Result<Option<CompletedRunSkipEvidence>> {
    let latest = match select_latest_run(conn, project_id, run_kind)? {
        LatestRunSelection::None
        | LatestRunSelection::Ambiguous
        | LatestRunSelection::InvalidTimestamp => return Ok(None),
        LatestRunSelection::Unique(latest) => *latest,
    };
    let LatestRun {
        project_id: row_project_id,
        run_kind: row_run_kind,
        status,
        semantic_epoch_id: row_epoch_id,
        work_key,
        completed_at,
        outcome_summary_json: outcome_json,
        ..
    } = latest;
    if row_project_id != project_id || row_run_kind != run_kind {
        return Ok(None);
    }
    if status != "completed"
        || completed_at
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Ok(None);
    }
    let Some(row_epoch_id) = row_epoch_id.as_deref() else {
        return Ok(None);
    };
    if !canonical_work_key_matches(run_kind, row_epoch_id, work_key.as_deref()) {
        return Ok(None);
    }
    let Some(outcome_json) = outcome_json else {
        return Ok(None);
    };
    let outcome: Value = match serde_json::from_str(&outcome_json) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let Some(evidence) = outcome.get(COMPLETED_RUN_SKIP_EVIDENCE_FIELD) else {
        return Ok(None);
    };
    let parsed: CompletedRunSkipEvidence = match serde_json::from_value(evidence.clone()) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if validate_evidence_shape(&parsed).is_err()
        || parsed.project_id != row_project_id
        || parsed.run_kind != row_run_kind
        || parsed.semantic_epoch_id != row_epoch_id
        || parsed.work_key != work_key.clone().unwrap_or_default()
        || parsed.rebuild_contract_version != REBUILD_RUN_KIND_CONTRACT_VERSION
        || parsed.run_kind_contract_version
            != supported_run_kind_contract_version(row_run_kind.as_str())
    {
        return Ok(None);
    }
    let outcome_digest = match successful_outcome_digest(run_kind, &outcome, row_epoch_id) {
        Ok(digest) => digest,
        Err(_) => return Ok(None),
    };
    if run_kind == VERIFY_RUN_KIND {
        let Some(report) = outcome.get("report").and_then(|value| {
            serde_json::from_value::<DependencyGraphVerifyReport>(value.clone()).ok()
        }) else {
            return Ok(None);
        };
        if !report.is_clean() {
            return Ok(None);
        }
        if parsed.graph_state_digest != durable_graph_state_digest(conn, project_id)? {
            return Ok(None);
        }
        if validate_report_rebuild_required(conn, project_id, &report).is_err() {
            return Ok(None);
        }
        if !live_verify_report_matches_sealed(
            conn,
            project_id,
            &parsed.report_digest,
            &parsed.graph_state_digest,
        )? {
            return Ok(None);
        }
    }
    if outcome_digest != parsed.report_digest {
        return Ok(None);
    }
    Ok(Some(parsed))
}

/// Recompute the read-only Verify report against live derived state before a
/// completed Run is reused. Stored clean evidence alone is insufficient: an
/// Edge State or Consumer Freshness row may have been deleted or become stale
/// after the owner committed its report.
fn live_verify_report_matches_sealed(
    conn: &Connection,
    project_id: &str,
    sealed_report_digest: &str,
    sealed_graph_state_digest: &str,
) -> Result<bool> {
    let mut control = NeverStopGraphWorkControl;
    live_verify_report_matches_sealed_with_control(
        conn,
        project_id,
        sealed_report_digest,
        sealed_graph_state_digest,
        &mut control,
    )
}

fn live_verify_report_matches_sealed_with_control(
    conn: &Connection,
    project_id: &str,
    sealed_report_digest: &str,
    sealed_graph_state_digest: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    control.check(GraphWorkStage::Restore)?;
    if !is_canonical_graph_state_digest(sealed_graph_state_digest) {
        return Ok(false);
    }
    let live_graph_state_digest =
        super::restore_rebuild::durable_graph_state_digest_with_control(
            conn, project_id, control,
        )?;
    if live_graph_state_digest != sealed_graph_state_digest {
        return Ok(false);
    }
    let report =
        super::restore_rebuild::verify_narrative_dependency_graph_for_project_with_control(
            conn, project_id, control,
        )?;
    if !report.is_clean() {
        return Ok(false);
    }
    control.check(GraphWorkStage::Serialization)?;
    let value = serde_json::to_value(report)?;
    control.check(GraphWorkStage::Serialization)?;
    Ok(format!("sha256:{}", digest_plan(&value)) == sealed_report_digest)
}

/// Attach skip evidence to an already successful Verify Run in one transaction.
/// The existing outcome and report digest are verified before the nested
/// evidence is sealed, so a caller cannot mark a failed, Rebuild, or partially
/// observed Run as reusable.
pub fn persist_completed_run_skip_evidence(
    db: &Database,
    run_id: &str,
    evidence: &CompletedRunSkipEvidence,
) -> Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            persist_completed_run_skip_evidence_in_tx(conn, run_id, evidence)
        })
    })
}

/// Transaction-composing form of [`persist_completed_run_skip_evidence`].
pub fn persist_completed_run_skip_evidence_in_tx(
    conn: &Connection,
    run_id: &str,
    evidence: &CompletedRunSkipEvidence,
) -> Result<()> {
    let mut control = NeverStopGraphWorkControl;
    persist_completed_run_skip_evidence_in_tx_with_control(conn, run_id, evidence, &mut control)
}

pub(crate) fn persist_completed_run_skip_evidence_in_tx_with_control(
    conn: &Connection,
    run_id: &str,
    evidence: &CompletedRunSkipEvidence,
    control: &mut dyn GraphWorkControl,
) -> Result<()> {
    control.check(GraphWorkStage::ResultAssembly)?;
    ensure!(
        !conn.is_autocommit(),
        "NEX_MAINTENANCE_SKIP_TRANSACTION_REQUIRED: completed-run skip evidence must run inside a caller-owned transaction"
    );
    ensure!(!run_id.trim().is_empty(), "runId is required");
    validate_evidence_shape(evidence)?;
    ensure!(
        evidence.run_kind_contract_version
            == supported_run_kind_contract_version(&evidence.run_kind),
        "NEX_MAINTENANCE_SKIP_CONTRACT_VERSION_UNSUPPORTED: '{}' is not the current contract version for '{}'",
        evidence.run_kind_contract_version,
        evidence.run_kind
    );
    ensure!(
        evidence.rebuild_contract_version == REBUILD_RUN_KIND_CONTRACT_VERSION,
        "NEX_MAINTENANCE_SKIP_REBUILD_CONTRACT_VERSION_UNSUPPORTED: '{}' is not the current Rebuild contract version",
        evidence.rebuild_contract_version
    );
    let row: Option<PersistRunRow> = conn
        .query_row(
            "SELECT project_id, run_kind, status, semantic_epoch_id, work_key,
                    completed_at, outcome_summary_json, version
               FROM narrative_extraction_runs WHERE id = ?1",
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
    control.check(GraphWorkStage::ResultAssembly)?;
    let Some((
        project_id,
        run_kind,
        status,
        epoch_id,
        work_key,
        completed_at,
        outcome_json,
        version,
    )) = row
    else {
        bail!("NEX_MAINTENANCE_SKIP_RUN_MISSING: Run '{run_id}' does not exist");
    };
    ensure!(
        status == "completed"
            && completed_at
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
        "NEX_MAINTENANCE_SKIP_RUN_NOT_SUCCESSFUL: Run '{run_id}' is not a completed terminal Run"
    );
    ensure!(
        project_id == evidence.project_id,
        "NEX_MAINTENANCE_SKIP_PROJECT_MISMATCH: Run '{run_id}' belongs to project '{project_id}'"
    );
    ensure!(
        run_kind == evidence.run_kind,
        "NEX_MAINTENANCE_SKIP_RUN_KIND_MISMATCH: Run '{run_id}' has kind '{run_kind}'"
    );
    ensure!(
        epoch_id.as_deref() == Some(evidence.semantic_epoch_id.as_str()),
        "NEX_MAINTENANCE_SKIP_EPOCH_MISMATCH: Run '{run_id}' is not bound to the evidence epoch"
    );
    ensure!(
        work_key.as_deref() == Some(evidence.work_key.as_str()),
        "NEX_MAINTENANCE_SKIP_WORK_KEY_MISMATCH: Run '{run_id}' is not bound to the evidence work key"
    );
    ensure!(
        canonical_work_key_matches(&run_kind, &evidence.semantic_epoch_id, work_key.as_deref()),
        "NEX_MAINTENANCE_SKIP_WORK_KEY_MISMATCH: Run '{run_id}' has a non-canonical work key"
    );
    let outcome_json = outcome_json.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_MAINTENANCE_SKIP_OUTCOME_MISSING: Run '{run_id}' has no terminal outcome"
        )
    })?;
    let mut outcome: Value = serde_json::from_str(&outcome_json)
        .with_context(|| format!("NEX_MAINTENANCE_SKIP_OUTCOME_MALFORMED: Run '{run_id}'"))?;
    control.check(GraphWorkStage::Serialization)?;
    let outcome_digest =
        successful_outcome_digest(&run_kind, &outcome, &evidence.semantic_epoch_id)?;
    ensure!(
        evidence.report_digest == outcome_digest,
        "NEX_MAINTENANCE_SKIP_REPORT_DIGEST_MISMATCH: evidence report digest does not match Run '{run_id}'"
    );
    let outcome_graph_state_digest = outcome
        .get("graphStateDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_SKIP_GRAPH_STATE_DIGEST_MISSING: Verify outcome has no graph state digest"
            )
        })?;
    ensure!(
        outcome_graph_state_digest == evidence.graph_state_digest,
        "NEX_MAINTENANCE_SKIP_GRAPH_STATE_DIGEST_MISMATCH: evidence graph state digest does not match Run '{run_id}'"
    );
    ensure!(
        super::restore_rebuild::durable_graph_state_digest_with_control(
            conn,
            &evidence.project_id,
            control,
        )? == evidence.graph_state_digest,
        "NEX_MAINTENANCE_SKIP_GRAPH_STATE_CHANGED: graph state changed before skip evidence was sealed"
    );
    control.check(GraphWorkStage::Coverage)?;
    if run_kind == VERIFY_RUN_KIND {
        let report: DependencyGraphVerifyReport = serde_json::from_value(
            outcome
                .get("report")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Verify outcome has no report"))?,
        )?;
        validate_report_rebuild_required(conn, &evidence.project_id, &report)?;
    }
    let evidence_value = serde_json::to_value(evidence)?;
    control.check(GraphWorkStage::Serialization)?;
    if let Some(existing) = outcome.get(COMPLETED_RUN_SKIP_EVIDENCE_FIELD) {
        let existing_semantics =
            serde_json::from_value::<CompletedRunSkipEvidence>(existing.clone())
                .ok()
                .filter(|parsed| validate_evidence_shape(parsed).is_ok());
        ensure!(
            existing_semantics.as_ref() == Some(evidence),
            "NEX_MAINTENANCE_SKIP_EVIDENCE_CONFLICT: Run '{run_id}' already has different skip evidence"
        );
    } else {
        let object = outcome.as_object_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_SKIP_OUTCOME_SHAPE_INVALID: Run '{run_id}' outcome is not an object"
            )
        })?;
        object.insert(
            COMPLETED_RUN_SKIP_EVIDENCE_FIELD.to_string(),
            evidence_value,
        );
        let serialized_outcome = serde_json::to_string(&outcome)?;
        control.check(GraphWorkStage::Serialization)?;
        let changed = conn
            .execute(
                "UPDATE narrative_extraction_runs
                SET outcome_summary_json = ?1, version = version + 1
              WHERE id = ?2
                AND status = 'completed'
                AND version = ?3
                AND outcome_summary_json = ?4",
                params![serialized_outcome, run_id, version, outcome_json],
            )
            .with_context(|| {
                format!(
                "NEX_MAINTENANCE_SKIP_EVIDENCE_LOST: Run '{run_id}' changed while sealing evidence"
            )
            })?;
        ensure!(
            changed == 1,
            "NEX_MAINTENANCE_SKIP_EVIDENCE_LOST: Run '{run_id}' changed while sealing evidence"
        );
    }
    control.check(GraphWorkStage::ResultAssembly)?;
    Ok(())
}

fn is_supported_run_kind(run_kind: &str) -> bool {
    run_kind == VERIFY_RUN_KIND
}

fn supported_run_kind_contract_version(run_kind: &str) -> &'static str {
    match run_kind {
        VERIFY_RUN_KIND => VERIFY_RUN_KIND_CONTRACT_VERSION,
        REBUILD_RUN_KIND => REBUILD_RUN_KIND_CONTRACT_VERSION,
        _ => "",
    }
}

fn canonical_work_key_matches(run_kind: &str, epoch_id: &str, work_key: Option<&str>) -> bool {
    match run_kind {
        VERIFY_RUN_KIND => work_key == Some(&format!("{VERIFY_WORK_KEY_PREFIX}{epoch_id}")),
        REBUILD_RUN_KIND => work_key == Some(REBUILD_DERIVED_WORK_KEY),
        _ => false,
    }
}

fn validate_expectation_shape(expected: &CompletedRunSkipExpectation) -> Result<()> {
    validate_component(&expected.project_id, "projectId")?;
    validate_component(&expected.run_kind, "runKind")?;
    validate_component(&expected.work_key, "workKey")?;
    validate_component(&expected.semantic_epoch_id, "semanticEpochId")?;
    validate_digest(&expected.graph_contract_digest, "graphContractDigest")?;
    validate_digest(&expected.rule_registry_digest, "ruleRegistryDigest")?;
    validate_digest(
        &expected.producer_generation_set_digest,
        "producerGenerationSetDigest",
    )?;
    validate_component(&expected.rebuild_contract_version, "rebuildContractVersion")?;
    validate_component(
        &expected.run_kind_contract_version,
        "runKindContractVersion",
    )?;
    ensure!(
        canonical_work_key_matches(
            &expected.run_kind,
            &expected.semantic_epoch_id,
            Some(&expected.work_key),
        ),
        "workKey is not canonical for run kind and epoch"
    );
    if let Some(report_digest) = expected.report_digest.as_deref() {
        validate_digest(report_digest, "reportDigest")?;
    }
    Ok(())
}

fn validate_evidence_shape(evidence: &CompletedRunSkipEvidence) -> Result<()> {
    let expected = CompletedRunSkipExpectation {
        project_id: evidence.project_id.clone(),
        run_kind: evidence.run_kind.clone(),
        work_key: evidence.work_key.clone(),
        semantic_epoch_id: evidence.semantic_epoch_id.clone(),
        graph_contract_digest: evidence.graph_contract_digest.clone(),
        rule_registry_digest: evidence.rule_registry_digest.clone(),
        producer_generation_set_digest: evidence.producer_generation_set_digest.clone(),
        rebuild_contract_version: evidence.rebuild_contract_version.clone(),
        run_kind_contract_version: evidence.run_kind_contract_version.clone(),
        report_digest: Some(evidence.report_digest.clone()),
    };
    validate_expectation_shape(&expected)?;
    validate_digest(&evidence.graph_contract_digest, "graphContractDigest")?;
    validate_digest(&evidence.rule_registry_digest, "ruleRegistryDigest")?;
    validate_digest(
        &evidence.producer_generation_set_digest,
        "producerGenerationSetDigest",
    )?;
    validate_digest(&evidence.report_digest, "reportDigest")?;
    ensure!(
        is_canonical_graph_state_digest(&evidence.graph_state_digest),
        "graphStateDigest must be a canonical sha256 digest"
    );
    ensure!(
        is_supported_run_kind(&evidence.run_kind),
        "NEX_MAINTENANCE_SKIP_RUN_KIND_UNSUPPORTED: '{}' cannot carry completed-run skip evidence",
        evidence.run_kind
    );
    Ok(())
}

fn validate_component(value: &str, name: &str) -> Result<()> {
    ensure!(!value.trim().is_empty(), "{name} is required");
    ensure!(
        value == value.trim(),
        "{name} must not have surrounding whitespace"
    );
    ensure!(
        !value.chars().any(char::is_whitespace),
        "{name} must not contain whitespace"
    );
    Ok(())
}

fn validate_digest(value: &str, name: &str) -> Result<()> {
    ensure!(
        value.starts_with("sha256:"),
        "{name} must use the sha256: digest prefix"
    );
    let hex = &value["sha256:".len()..];
    ensure!(
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
        "{name} must be sha256: followed by exactly 64 lowercase hexadecimal characters"
    );
    Ok(())
}

fn is_canonical_digest(value: &str) -> bool {
    validate_digest(value, "digest").is_ok()
}

fn outcome_contract_version<'a>(run_kind: &str, outcome: &'a Value) -> Option<&'a str> {
    let key = match run_kind {
        VERIFY_RUN_KIND => "verifyContractVersion",
        REBUILD_RUN_KIND => "rebuildContractVersion",
        _ => return None,
    };
    outcome.get(key).and_then(Value::as_str)
}

fn successful_outcome_digest(
    run_kind: &str,
    outcome: &Value,
    expected_epoch_id: &str,
) -> Result<String> {
    ensure!(
        is_supported_run_kind(run_kind),
        "NEX_MAINTENANCE_SKIP_RUN_KIND_UNSUPPORTED: '{run_kind}'"
    );
    ensure!(
        outcome.get("failure").is_none(),
        "NEX_MAINTENANCE_SKIP_OUTCOME_FAILED: terminal outcome carries failure"
    );
    ensure!(
        outcome_contract_version(run_kind, outcome)
            == Some(supported_run_kind_contract_version(run_kind)),
        "NEX_MAINTENANCE_SKIP_CONTRACT_MISMATCH: outcome contract version is not current"
    );
    ensure!(
        outcome.get("semanticEpochId").and_then(Value::as_str) == Some(expected_epoch_id),
        "NEX_MAINTENANCE_SKIP_EPOCH_MISMATCH: outcome semantic epoch is not bound to the Run"
    );
    let (payload_key, digest_key) = match run_kind {
        VERIFY_RUN_KIND => ("report", "reportDigest"),
        REBUILD_RUN_KIND => ("summary", "summaryDigest"),
        _ => unreachable!(),
    };
    let payload = outcome.get(payload_key).ok_or_else(|| {
        anyhow::anyhow!("NEX_MAINTENANCE_SKIP_REPORT_MISSING: outcome has no {payload_key}")
    })?;
    match run_kind {
        VERIFY_RUN_KIND => {
            let report = serde_json::from_value::<DependencyGraphVerifyReport>(payload.clone())
                .with_context(|| {
                    "NEX_MAINTENANCE_SKIP_REPORT_SHAPE_INVALID: Verify report shape is not current"
                })?;
            validate_verify_check_coverage(outcome).with_context(|| {
                "NEX_MAINTENANCE_SKIP_COVERAGE_SHAPE_INVALID: Verify check coverage is not current"
            })?;
            let recorded_outcome_digest = outcome
                .get("outcomeDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SKIP_OUTCOME_DIGEST_MISSING: Verify outcome has no whole-outcome digest"
                    )
                })?;
            ensure!(
                recorded_outcome_digest == canonical_verify_outcome_digest(outcome)?,
                "NEX_MAINTENANCE_SKIP_OUTCOME_DIGEST_MISMATCH: Verify outcome whole-outcome digest does not match"
            );
            ensure!(
                report.is_clean(),
                "NEX_MAINTENANCE_SKIP_DERIVED_STATE_INVALID: Verify report is not clean"
            );
        }
        REBUILD_RUN_KIND => {
            serde_json::from_value::<RebuildDerivedStateSummary>(payload.clone()).with_context(
                || "NEX_MAINTENANCE_SKIP_SUMMARY_SHAPE_INVALID: Rebuild summary shape is not current",
            )?;
        }
        _ => unreachable!(),
    }
    let recorded_digest = outcome
        .get(digest_key)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_SKIP_REPORT_DIGEST_MISSING: outcome has no report digest ({digest_key})"
            )
        })?;
    validate_digest(recorded_digest, digest_key)?;
    let expected_digest = format!("sha256:{}", digest_plan(payload));
    ensure!(
        recorded_digest == expected_digest,
        "NEX_MAINTENANCE_SKIP_REPORT_DIGEST_MISMATCH: recorded '{recorded_digest}', expected '{expected_digest}'"
    );
    Ok(recorded_digest.to_string())
}
