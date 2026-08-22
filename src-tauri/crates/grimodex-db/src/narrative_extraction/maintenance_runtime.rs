//! Durable coordinator and phase owner for Narrative Maintenance (C2-5B).
//!
//! Rust owns discovery, recovery, and bounded dispatch of the automatic
//! Backfill -> Verify -> conditional Rebuild -> confirmation Verify state
//! machine. Electron only wakes this owner and supplies the pinned live
//! `Database`; Repair remains a human/manual path.

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::legacy_backfill::{
    LEGACY_BACKFILL_ALGORITHM_VERSION, LEGACY_BACKFILL_WORK_KEY as WRITER_BACKFILL_WORK_KEY,
};
use super::maintenance_contracts::current_maintenance_coordinates;
use super::maintenance_skip_evidence::{
    evaluate_completed_run_skip, CompletedRunSkipDecision, CompletedRunSkipExpectation,
};
use super::restore_rebuild::{
    rebuild_narrative_derived_state_for_project, run_dependency_verify_for_project,
    DependencyGraphVerifyReport, RebuildDerivedStateOutcome, VERIFY_CONTRACT_VERSION,
    VERIFY_RUN_KIND,
};
use super::task_leases::with_immediate_transaction;
use crate::Database;

/// The only Run Kinds that an automatic maintenance planner may describe.
/// Human-only destructive work is deliberately not representable here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AutomaticRunKind {
    #[serde(rename = "backfill")]
    Backfill,
    #[serde(rename = "dependency-verify")]
    Verify,
    #[serde(rename = "semantic-index-rebuild")]
    RebuildDerived,
}

impl AutomaticRunKind {
    /// Persisted `narrative_extraction_runs.run_kind` value.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Backfill => "backfill",
            Self::Verify => "dependency-verify",
            Self::RebuildDerived => "semantic-index-rebuild",
        }
    }

    /// All automatic kinds.  Keeping this list closed is an architecture
    /// guard: background callers cannot accidentally obtain a Repair route.
    pub const fn all() -> [Self; 3] {
        [Self::Backfill, Self::Verify, Self::RebuildDerived]
    }
}

/// A canonical identity for one project-scoped unit of maintenance work.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkKey {
    pub project_id: String,
    pub run_kind: AutomaticRunKind,
    pub work_key: String,
    pub semantic_epoch_id: Option<String>,
}

impl WorkKey {
    pub fn new(
        project_id: impl Into<String>,
        run_kind: AutomaticRunKind,
        work_key: impl Into<String>,
    ) -> anyhow::Result<Self> {
        Self::new_with_epoch(project_id, run_kind, work_key, None)
    }

    /// Construct an epoch-bound work identity. The legacy `new` constructor
    /// intentionally keeps `semantic_epoch_id = None` for pre-epoch callers.
    pub fn new_for_epoch(
        project_id: impl Into<String>,
        run_kind: AutomaticRunKind,
        work_key: impl Into<String>,
        semantic_epoch_id: impl Into<String>,
    ) -> anyhow::Result<Self> {
        Self::new_with_epoch(
            project_id,
            run_kind,
            work_key,
            Some(semantic_epoch_id.into()),
        )
    }

    fn new_with_epoch(
        project_id: impl Into<String>,
        run_kind: AutomaticRunKind,
        work_key: impl Into<String>,
        semantic_epoch_id: Option<String>,
    ) -> anyhow::Result<Self> {
        let project_id = require_component(project_id.into(), "projectId")?;
        let work_key = require_component(work_key.into(), "workKey")?;
        let semantic_epoch_id = semantic_epoch_id
            .map(|epoch_id| require_component(epoch_id, "semanticEpochId"))
            .transpose()?;
        Ok(Self {
            project_id,
            run_kind,
            work_key,
            semantic_epoch_id,
        })
    }

    /// Includes the Run Kind even when the underlying work key text is equal.
    /// This prevents cross-kind coalescing (for example, a Verify key named
    /// `rebuild` cannot collide with a Rebuild key named `rebuild`).
    pub fn canonical_key(&self) -> String {
        canonical_key_parts(
            &self.project_id,
            self.run_kind,
            &self.work_key,
            self.semantic_epoch_id.as_deref(),
        )
    }
}

/// Build the same canonical key used by [`WorkKey::canonical_key`].
pub fn canonical_work_key(
    project_id: &str,
    run_kind: AutomaticRunKind,
    work_key: &str,
) -> anyhow::Result<String> {
    canonical_work_key_for_epoch(project_id, run_kind, work_key, None)
}

/// Build a canonical key with an optional Semantic Epoch component. Epoch
/// bound work must not coalesce with the same operation from another epoch.
pub fn canonical_work_key_for_epoch(
    project_id: &str,
    run_kind: AutomaticRunKind,
    work_key: &str,
    semantic_epoch_id: Option<&str>,
) -> anyhow::Result<String> {
    Ok(WorkKey::new_with_epoch(
        project_id,
        run_kind,
        work_key,
        semantic_epoch_id.map(str::to_string),
    )?
    .canonical_key())
}

fn canonical_key_parts(
    project_id: &str,
    run_kind: AutomaticRunKind,
    work_key: &str,
    semantic_epoch_id: Option<&str>,
) -> String {
    let base = format!(
        "narrative-maintenance:v1/{}/{}/{}",
        run_kind.as_str(),
        project_id,
        work_key
    );
    match semantic_epoch_id {
        Some(epoch_id) => format!("{base}/epoch/{epoch_id}"),
        None => base,
    }
}

fn require_component(value: String, name: &str) -> anyhow::Result<String> {
    let value = value.trim().to_string();
    anyhow::ensure!(!value.is_empty(), "{name} is required");
    anyhow::ensure!(
        !value
            .chars()
            .any(|character| matches!(character, '/' | '\\')),
        "{name} must not contain path separators"
    );
    Ok(value)
}

/// A legacy WorkKey without an epoch may be scoped by a caller-provided
/// expected epoch. Once a WorkKey carries an epoch, omitting or changing the
/// expected epoch is unsafe and must fail closed.
fn validate_epoch_contract(
    work: &WorkKey,
    expected_semantic_epoch_id: Option<&str>,
) -> anyhow::Result<()> {
    match (
        work.semantic_epoch_id.as_deref(),
        expected_semantic_epoch_id,
    ) {
        (Some(work_epoch), Some(expected_epoch)) => {
            anyhow::ensure!(
                work_epoch == expected_epoch,
                "semantic epoch does not match the WorkKey"
            );
            Ok(())
        }
        (Some(_), None) => {
            anyhow::bail!("semantic epoch is required when the WorkKey is epoch-bound")
        }
        (None, _) => Ok(()),
    }
}

pub const LEGACY_BACKFILL_WORK_KEY: &str = WRITER_BACKFILL_WORK_KEY;
pub const REBUILD_DERIVED_WORK_KEY: &str = "dependency-rebuild-derived";
pub const VERIFY_WORK_KEY_PREFIX: &str = "dependency-verify:";

/// Maximum number of coalesced work items accepted by one main-process cycle.
/// A cycle is deliberately bounded so a burst of trigger events cannot turn
/// one background call into an unbounded writer hold.  Project serialization
/// remains the main scheduler's responsibility; this bound is the native
/// boundary's last line of defence for callers that bypass that scheduler.
pub const MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE: usize = 32;

/// Main-only request DTO for the serialized system-work cycle.  This is not an
/// IPC/preload contract: the only production consumer is the Electron main
/// scheduler's N-API seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceCycleRequest {
    pub work: Vec<MaintenanceWorkRequest>,
    #[serde(default)]
    pub wake_project_ids: Vec<String>,
    /// Snapshot binding captured by the Electron main scheduler at enqueue
    /// time. Shared-crate callers may omit it because they already supply the
    /// pinned `Database`; the N-API adapter requires it before dispatch.
    #[serde(default)]
    pub workspace_binding: Option<MaintenanceWorkspaceBinding>,
}

/// Opaque process-local authority snapshot used by the main/N-API seam.
/// `authority_id` changes for every replacement authority, including a
/// same-path restore. `generation` is the recovery gate epoch paired with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceWorkspaceBinding {
    pub authority_id: String,
    pub generation: u64,
}

/// One project-scoped automatic work item delivered by the main scheduler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceWorkRequest {
    pub project_id: String,
    pub run_kind: AutomaticRunKind,
    pub work_key: String,
    pub semantic_epoch_id: Option<String>,
    pub reasons: Vec<String>,
}

/// Status returned by the live native cycle.  `Coalesced` means every item
/// was already owned by a live Run; it is not a successful execution and the
/// main scheduler must not invent a second Run for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceCycleStatus {
    Accepted,
    Coalesced,
    /// Retained for the shadow/planning API. Execute-mode maintenance no
    /// longer returns Deferred for Verify or Rebuild; the Rust phase owner
    /// dispatches them on the same live Database.
    Deferred,
}

/// Result of one bounded live-authority cycle.  `has_more` is intentionally
/// durable-scope agnostic here: enabled system adapters report whether they
/// have another durable unit to process, while the main scheduler preserves
/// the project scope when it schedules an empty wake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceCycleResult {
    pub status: MaintenanceCycleStatus,
    pub has_more: bool,
}

impl MaintenanceCycleResult {
    pub const fn accepted(has_more: bool) -> Self {
        Self {
            status: MaintenanceCycleStatus::Accepted,
            has_more,
        }
    }

    pub const fn coalesced(has_more: bool) -> Self {
        Self {
            status: MaintenanceCycleStatus::Coalesced,
            has_more,
        }
    }

    pub const fn deferred(has_more: bool) -> Self {
        Self {
            status: MaintenanceCycleStatus::Deferred,
            has_more,
        }
    }
}

impl MaintenanceCycleRequest {
    /// Validate and coalesce the wire request before any DB write.  Keeping
    /// this validation in shared Rust as well as the TS scheduler prevents a
    /// stale or hand-written main caller from reaching a Repair adapter or
    /// smuggling a path-shaped identity into a canonical key.
    pub fn normalized_work(&self) -> anyhow::Result<Vec<DesiredWork>> {
        anyhow::ensure!(
            self.work.len() <= MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
            "NEX_MAINTENANCE_BATCH_TOO_LARGE: at most {MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE} work items are allowed"
        );
        anyhow::ensure!(
            self.wake_project_ids.len() <= MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
            "NEX_MAINTENANCE_BATCH_TOO_LARGE: at most {MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE} wake projects are allowed"
        );
        for project_id in &self.wake_project_ids {
            require_component(project_id.clone(), "projectId")?;
        }

        let mut desired = Vec::with_capacity(self.work.len());
        for item in &self.work {
            anyhow::ensure!(
                !item.reasons.is_empty(),
                "NEX_MAINTENANCE_INVALID_REQUEST: at least one reason is required"
            );
            let epoch = item
                .semantic_epoch_id
                .clone()
                .map(|value| require_component(value, "semanticEpochId"))
                .transpose()?;
            if !matches!(item.run_kind, AutomaticRunKind::Backfill) {
                anyhow::ensure!(
                    epoch.is_some(),
                    "NEX_MAINTENANCE_INVALID_REQUEST: semanticEpochId is required for epoch-bound work"
                );
            }
            let mut work = DesiredWork::new_with_epoch(
                item.project_id.clone(),
                item.run_kind,
                item.work_key.clone(),
                epoch,
                item.reasons[0].clone(),
            )?;
            for reason in &item.reasons[1..] {
                work.add_reason(&require_component(reason.clone(), "reason")?);
            }
            desired.push(work);
        }
        Ok(coalesce_desired_work(desired))
    }
}

#[derive(Debug, Clone)]
struct DurableMaintenanceRun {
    run_id: String,
    run_kind: String,
    status: String,
    spec_json: Option<String>,
    semantic_epoch_id: Option<String>,
    work_key: Option<String>,
    outcome_summary_json: Option<String>,
    lifecycle_at: DateTime<Utc>,
}

fn parse_maintenance_instant(value: &str) -> anyhow::Result<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .map(|parsed| DateTime::<Utc>::from_naive_utc_and_offset(parsed, Utc))
        .map_err(|_| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: lifecycle timestamp '{value}' is not a supported instant"
            )
        })
}

fn load_durable_maintenance_runs(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<DurableMaintenanceRun>> {
    let mut statement = conn.prepare(
        "SELECT id, run_kind, status, spec_json, semantic_epoch_id, work_key,
                outcome_summary_json, created_at, started_at, completed_at
           FROM narrative_extraction_runs
          WHERE project_id = ?1
            AND run_kind IN ('backfill', 'dependency-verify', 'semantic-index-rebuild')",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
        ))
    })?;
    let mut runs = Vec::new();
    for row in rows {
        let (
            run_id,
            run_kind,
            status,
            spec_json,
            semantic_epoch_id,
            work_key,
            outcome_summary_json,
            created_at,
            started_at,
            completed_at,
        ) = row?;
        let lifecycle_raw = completed_at
            .as_deref()
            .or(started_at.as_deref())
            .unwrap_or(created_at.as_str());
        runs.push(DurableMaintenanceRun {
            run_id,
            run_kind,
            status,
            spec_json,
            semantic_epoch_id,
            work_key,
            outcome_summary_json,
            lifecycle_at: parse_maintenance_instant(lifecycle_raw)?,
        });
    }
    runs.sort_by_key(|run| Reverse(run.lifecycle_at));
    for pair in runs.windows(2) {
        let [first, second] = pair else {
            continue;
        };
        anyhow::ensure!(
            first.lifecycle_at != second.lifecycle_at,
            "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS: runs '{}' and '{}' share lifecycle instant {}",
            first.run_id,
            second.run_id,
            first.lifecycle_at.to_rfc3339()
        );
    }
    Ok(runs)
}

fn is_completed_backfill_marker(
    conn: &Connection,
    project_id: &str,
    run: &DurableMaintenanceRun,
) -> anyhow::Result<bool> {
    if run.run_kind != "backfill"
        || run.status != "completed"
        || run.work_key.as_deref() != Some(LEGACY_BACKFILL_WORK_KEY)
    {
        return Ok(false);
    }
    let Some(epoch_id) = run
        .semantic_epoch_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
    let epoch_belongs_to_project: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM narrative_semantic_epochs
              WHERE id = ?1 AND project_id = ?2
         )",
        params![epoch_id, project_id],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if !epoch_belongs_to_project {
        return Ok(false);
    }

    let Some(spec_json) = run.spec_json.as_deref() else {
        return Ok(false);
    };
    let Ok(spec) = serde_json::from_str::<Value>(spec_json) else {
        return Ok(false);
    };
    if spec.get("backfillAlgorithmVersion").and_then(Value::as_str)
        != Some(LEGACY_BACKFILL_ALGORITHM_VERSION)
    {
        return Ok(false);
    }

    let Some(outcome_json) = run.outcome_summary_json.as_deref() else {
        return Ok(false);
    };
    let Ok(outcome) = serde_json::from_str::<Value>(outcome_json) else {
        return Ok(false);
    };
    if outcome.get("maintenancePhase").and_then(Value::as_str) != Some("backfill-complete")
        || outcome
            .get("backfillAlgorithmVersion")
            .and_then(Value::as_str)
            != Some(LEGACY_BACKFILL_ALGORITHM_VERSION)
        || outcome.get("semanticEpochId").and_then(Value::as_str) != Some(epoch_id)
    {
        return Ok(false);
    }
    let Some(summary) = outcome.get("summary").and_then(Value::as_object) else {
        return Ok(false);
    };
    Ok(summary
        .get("epoch_created")
        .and_then(Value::as_bool)
        .is_some()
        && summary
            .get("contributions_created")
            .and_then(Value::as_u64)
            .is_some()
        && summary
            .get("edges_created")
            .and_then(Value::as_u64)
            .is_some()
        && summary
            .get("applications_without_run_id")
            .and_then(Value::as_u64)
            .is_some())
}

/// Rediscover the next durable phase from the Run ledger. Callers must use
/// this instead of replaying a trigger as a phase instruction: the trigger is
/// only a wake reason, while the completed outcome and current Semantic Epoch
/// are the Rust-owned state machine.
pub fn discover_durable_maintenance_work(
    db: &Database,
    project_id: &str,
    reason: &str,
) -> anyhow::Result<Option<DesiredWork>> {
    let project_id = require_component(project_id.to_string(), "projectId")?;
    let reason = require_component(reason.to_string(), "reason")?;
    let (current_epoch_id, latest, active, completed_backfill) = db.with_conn(|conn| {
        let current_epoch_id =
            super::semantic_epoch::get_current_epoch(conn, &project_id)?.map(|epoch| epoch.id);
        let runs = load_durable_maintenance_runs(conn, &project_id)?;
        let active = runs
            .iter()
            .find(|run| matches!(run.status.as_str(), "pending" | "running"))
            .cloned();
        let latest = runs.first().cloned();
        let mut completed_backfill = None;
        for run in &runs {
            if is_completed_backfill_marker(conn, &project_id, run)? {
                completed_backfill = Some(run.clone());
                break;
            }
        }
        Ok((current_epoch_id, latest, active, completed_backfill))
    })?;

    if let Some(active) = active {
        return durable_run_work(&project_id, &active, reason.as_str());
    }

    let Some(current_epoch_id) = current_epoch_id else {
        // Backfill is the only phase allowed to create the initial Epoch.
        // Restore/Epoch wakes fail closed until the restore installer has
        // durably minted its restore Epoch.
        return if is_backfill_wake(reason.as_str()) {
            Ok(Some(DesiredWork::new(
                project_id,
                AutomaticRunKind::Backfill,
                LEGACY_BACKFILL_WORK_KEY,
                reason,
            )?))
        } else {
            Ok(None)
        };
    };

    // A restored image may already contain a current Epoch while carrying no
    // completed Backfill marker at all (for example a pre-C2 backup). Epoch
    // existence alone therefore cannot prove that the legacy declarations
    // crossed the Backfill boundary. Run the current-epoch Backfill once;
    // any historical completed Backfill, even one from an older Epoch, is the
    // durable evidence that the boundary was already crossed and leads to
    // Verify-first handling below.
    if completed_backfill.is_none() {
        return Ok(Some(DesiredWork::new_with_epoch(
            project_id,
            AutomaticRunKind::Backfill,
            LEGACY_BACKFILL_WORK_KEY,
            Some(current_epoch_id),
            reason,
        )?));
    }

    let Some(latest) = latest else {
        // An existing current Epoch means the initial Backfill boundary has
        // already been crossed. Even a workspace-opened wake must therefore
        // begin with Verify; replaying Backfill here would loop forever after
        // a restore or restart.
        return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?));
    };

    let latest_epoch_matches =
        latest.semantic_epoch_id.as_deref() == Some(current_epoch_id.as_str());
    match latest.run_kind.as_str() {
        "backfill" => {
            if !latest_epoch_matches || latest.status == "completed" {
                Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?))
            } else {
                Ok(Some(DesiredWork::new_with_epoch(
                    project_id,
                    AutomaticRunKind::Backfill,
                    LEGACY_BACKFILL_WORK_KEY,
                    latest.semantic_epoch_id,
                    reason,
                )?))
            }
        }
        VERIFY_RUN_KIND => {
            if !latest_epoch_matches || latest.status != "completed" {
                return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?));
            }
            let Some(outcome_json) = latest.outcome_summary_json.as_deref() else {
                return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?));
            };
            let outcome: Value = match serde_json::from_str(outcome_json) {
                Ok(value) => value,
                Err(_) => return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?)),
            };
            let Some(report_value) = outcome.get("report") else {
                return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?));
            };
            let report: DependencyGraphVerifyReport =
                match serde_json::from_value(report_value.clone()) {
                    Ok(report) => report,
                    Err(_) => {
                        return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?))
                    }
                };
            if report.requires_rebuild() {
                return Ok(Some(DesiredWork::new_with_epoch(
                    project_id,
                    AutomaticRunKind::RebuildDerived,
                    REBUILD_DERIVED_WORK_KEY,
                    Some(current_epoch_id),
                    reason,
                )?));
            }
            // A graph defect is terminal/manual evidence, not an automatic
            // Repair route. A clean report is reusable only when its CAS
            // evidence is present and current; old reports are re-run once
            // to seal the current coordinates.
            if report.is_clean() {
                let expected = verify_skip_expectation(&project_id, &current_epoch_id)?;
                let decision = db.with_conn(|conn| evaluate_completed_run_skip(conn, &expected))?;
                if matches!(decision, CompletedRunSkipDecision::Skip { .. }) {
                    return Ok(None);
                }
                return Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?));
            }
            Ok(None)
        }
        "semantic-index-rebuild" => {
            if !latest_epoch_matches || latest.status == "completed" {
                Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?))
            } else {
                Ok(Some(DesiredWork::new_with_epoch(
                    project_id,
                    AutomaticRunKind::RebuildDerived,
                    REBUILD_DERIVED_WORK_KEY,
                    Some(current_epoch_id),
                    reason,
                )?))
            }
        }
        _ => Ok(Some(verify_work(&project_id, &current_epoch_id, &reason)?)),
    }
}

fn durable_run_work(
    project_id: &str,
    run: &DurableMaintenanceRun,
    reason: &str,
) -> anyhow::Result<Option<DesiredWork>> {
    let work_key = run.work_key.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: '{}' Run has no workKey",
            run.run_kind
        )
    })?;
    let kind = match run.run_kind.as_str() {
        "backfill" => AutomaticRunKind::Backfill,
        VERIFY_RUN_KIND => AutomaticRunKind::Verify,
        "semantic-index-rebuild" => AutomaticRunKind::RebuildDerived,
        other => anyhow::bail!(
            "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: unsupported active Run kind '{other}'"
        ),
    };
    anyhow::ensure!(
        match kind {
            AutomaticRunKind::Backfill => work_key == LEGACY_BACKFILL_WORK_KEY,
            AutomaticRunKind::Verify => run
                .semantic_epoch_id
                .as_deref()
                .is_some_and(|epoch| { work_key == format!("{VERIFY_WORK_KEY_PREFIX}{epoch}") }),
            AutomaticRunKind::RebuildDerived => work_key == REBUILD_DERIVED_WORK_KEY,
        },
        "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Run workKey does not match its phase"
    );
    if !matches!(kind, AutomaticRunKind::Backfill) {
        anyhow::ensure!(
            run.semantic_epoch_id.is_some(),
            "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: epoch-bound Run has no semantic epoch"
        );
    }
    Ok(Some(DesiredWork::new_with_epoch(
        project_id,
        kind,
        work_key,
        run.semantic_epoch_id.clone(),
        reason,
    )?))
}

fn is_backfill_wake(reason: &str) -> bool {
    matches!(
        reason,
        "workspace-opened" | "legacy-backfill-required" | "durable-wake"
    )
}

fn verify_skip_expectation(
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<CompletedRunSkipExpectation> {
    let coordinates = current_maintenance_coordinates()?;
    Ok(CompletedRunSkipExpectation {
        project_id: project_id.to_string(),
        run_kind: VERIFY_RUN_KIND.to_string(),
        work_key: format!("{VERIFY_RUN_KIND}:{semantic_epoch_id}"),
        semantic_epoch_id: semantic_epoch_id.to_string(),
        graph_contract_digest: coordinates.graph_contract_digest,
        rule_registry_digest: coordinates.rule_registry_digest,
        producer_generation_set_digest: coordinates.producer_generation_set_digest,
        run_kind_contract_version: VERIFY_CONTRACT_VERSION.to_string(),
        report_digest: None,
    })
}

/// Execute one coalesced request on the caller's live `Database` authority.
///
/// The function deliberately accepts `&Database`, not a filesystem path.  A
/// caller that has pinned `WorkspaceAuthority` therefore keeps the matching
/// lease and SQLite connection for the complete cycle; this is the critical
/// guard against the detached second-writer/`SQLITE_BUSY_SNAPSHOT` failure
/// that removed the old post-open Backfill worker.
///
/// Execute mode dispatches every automatic phase on this same live Database.
/// Repair is not representable in the request enum at all.
pub fn run_system_work_cycle(
    db: &Database,
    request: &MaintenanceCycleRequest,
    mode: RecoveryMode,
) -> anyhow::Result<MaintenanceCycleResult> {
    run_system_work_cycle_with_modes(db, request, |_| mode)
}

/// Execute a cycle with recovery mode selected per canonical WorkKey.
///
/// The Electron process uses this form because one bounded batch can contain
/// a key already recovered in the current workspace generation and another
/// key first observed after a handoff. A workspace-wide boolean would let the
/// latter coalesce a persisted interrupted Run forever.
pub fn run_system_work_cycle_with_modes(
    db: &Database,
    request: &MaintenanceCycleRequest,
    mode_for: impl Fn(&DesiredWork) -> RecoveryMode,
) -> anyhow::Result<MaintenanceCycleResult> {
    let mut work = request.normalized_work()?;
    anyhow::ensure!(
        work.is_empty() || request.wake_project_ids.is_empty(),
        "NEX_MAINTENANCE_WAKE_MIXED_ACK_SCOPE: ordinary work and durable wake must use separate cycles"
    );
    if work.is_empty() {
        for project_id in &request.wake_project_ids {
            if let Some(next) = discover_durable_maintenance_work(db, project_id, "durable-wake")? {
                work.push(next);
            }
        }
    }

    // Validate the entire initial batch before recovering or dispatching any
    // item. Follow-up phases are generated only from durable outcomes below.
    for item in &work {
        validate_dispatch_contract(item)?;
    }

    let mut queue = std::collections::VecDeque::from(work.clone());
    let mut dispatch_count = 0usize;
    let mut dispatched_any = false;
    let mut coalesced_active = false;
    let mut has_more = false;
    let mut project_ids = BTreeSet::new();
    while let Some(item) = queue.pop_front() {
        project_ids.insert(item.project_id.clone());
        if dispatch_count >= MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE {
            has_more = true;
            break;
        }

        // Verify-only completed-run skip is checked before recovery. Rebuild
        // completed rows are intentionally never reused.
        if item.run_kind == AutomaticRunKind::Verify {
            let expected = verify_skip_expectation(
                &item.project_id,
                item.semantic_epoch_id.as_deref().unwrap_or_default(),
            )?;
            let decision = db.with_conn(|conn| evaluate_completed_run_skip(conn, &expected))?;
            if matches!(decision, CompletedRunSkipDecision::Skip { .. }) {
                if let Some(next) = discover_durable_maintenance_work(
                    db,
                    &item.project_id,
                    item.reasons
                        .first()
                        .map(String::as_str)
                        .unwrap_or("durable-wake"),
                )? {
                    if next.run_kind != AutomaticRunKind::Verify
                        || next.semantic_epoch_id != item.semantic_epoch_id
                    {
                        queue.push_back(next);
                    }
                }
                continue;
            }
        }

        let action = recover_cycle_work(db, &item, mode_for(&item))?;
        match action {
            RecoveryAction::CoalescedRunning { .. } | RecoveryAction::CoalescedPending { .. } => {
                coalesced_active = true;
                has_more = true;
                continue;
            }
            RecoveryAction::SkipCompleted { .. } => {
                // Backfill's completed row is only the durable marker for the
                // next Verify phase. No completed Rebuild can enter this arm.
                if item.run_kind == AutomaticRunKind::Backfill {
                    if let Some(next) = discover_durable_maintenance_work(
                        db,
                        &item.project_id,
                        item.reasons
                            .first()
                            .map(String::as_str)
                            .unwrap_or("durable-wake"),
                    )? {
                        queue.push_back(next);
                    }
                }
                continue;
            }
            RecoveryAction::ManualIntervention { code } => {
                anyhow::bail!("{code}: maintenance work requires manual intervention")
            }
            RecoveryAction::RecoverInterrupted { .. }
            | RecoveryAction::RecoverStaleEpoch { .. } => {
                // `recover_cycle_work` terminalizes explicit candidates and
                // returns a second decision, so this arm is unreachable.
                anyhow::bail!(
                    "NEX_MAINTENANCE_RECOVERY_INCOMPLETE: active Run remained after recovery"
                )
            }
            RecoveryAction::StartFresh | RecoveryAction::Retry { .. } => {
                let current_epoch = db
                    .with_conn(|conn| {
                        super::semantic_epoch::get_current_epoch(conn, &item.project_id)
                    })?
                    .map(|epoch| epoch.id);
                // Backfill is only dispatched before the first Epoch exists.
                // Once an Epoch is present, a stale/epoch-less Backfill item
                // is recovery provenance; rediscover the current Verify
                // phase instead of dispatching it under an old Epoch.
                let backfill_requires_rediscovery = item.run_kind == AutomaticRunKind::Backfill
                    && current_epoch.is_some()
                    && current_epoch.as_deref() != item.semantic_epoch_id.as_deref();
                if backfill_requires_rediscovery
                    || current_epoch.as_deref() != item.semantic_epoch_id.as_deref()
                {
                    if let Some(next) = discover_durable_maintenance_work(
                        db,
                        &item.project_id,
                        item.reasons
                            .first()
                            .map(String::as_str)
                            .unwrap_or("durable-wake"),
                    )? {
                        queue.push_back(next);
                    }
                    continue;
                }
                dispatch_enabled_work(db, &item)?;
                dispatch_count += 1;
                dispatched_any = true;
                if let Some(next) = discover_durable_maintenance_work(
                    db,
                    &item.project_id,
                    item.reasons
                        .first()
                        .map(String::as_str)
                        .unwrap_or("durable-wake"),
                )? {
                    queue.push_back(next);
                }
            }
        }
    }

    has_more |= !queue.is_empty();
    if !has_more {
        for project_id in project_ids {
            if discover_durable_maintenance_work(db, &project_id, "durable-wake")?.is_some() {
                has_more = true;
                break;
            }
        }
    }
    Ok(if !dispatched_any && coalesced_active {
        MaintenanceCycleResult::coalesced(has_more)
    } else {
        MaintenanceCycleResult::accepted(has_more)
    })
}

fn recover_cycle_work(
    db: &Database,
    item: &DesiredWork,
    mode: RecoveryMode,
) -> anyhow::Result<RecoveryAction> {
    let current_epoch = db
        .with_conn(|conn| super::semantic_epoch::get_current_epoch(conn, &item.project_id))?
        .map(|epoch| epoch.id);
    let expected_epoch = current_epoch
        .as_deref()
        .filter(|current| item.semantic_epoch_id.as_deref() != Some(*current))
        .or(item.semantic_epoch_id.as_deref());
    let work_key = WorkKey::new_with_epoch(
        item.project_id.clone(),
        item.run_kind,
        item.work_key.clone(),
        expected_epoch.map(str::to_string),
    )?;
    let decision = decide_run_recovery_for_epoch(db, &work_key, expected_epoch, mode, None)?;
    match decision.action {
        RecoveryAction::RecoverInterrupted { run_ids } => {
            terminalize_interrupted_runs_for_epoch(
                db,
                &item.project_id,
                &work_key,
                expected_epoch,
                &run_ids,
            )?;
            // The just-terminalized row is provenance for this recovery, not
            // a failed attempt that should consume the next cycle's retry
            // budget. Start the same durable WorkKey anew.
            Ok(RecoveryAction::StartFresh)
        }
        RecoveryAction::RecoverStaleEpoch { runs } => {
            let expected_epoch = expected_epoch.ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_STALE_EPOCH_UNSCOPED: stale recovery requires an epoch-bound work key"
                )
            })?;
            terminalize_stale_interrupted_runs_for_epoch(
                db,
                &item.project_id,
                &work_key,
                expected_epoch,
                &runs,
            )?;
            Ok(RecoveryAction::StartFresh)
        }
        action => Ok(action),
    }
}

fn validate_dispatch_contract(item: &DesiredWork) -> anyhow::Result<()> {
    match item.run_kind {
        AutomaticRunKind::Backfill => {
            anyhow::ensure!(
                item.work_key == LEGACY_BACKFILL_WORK_KEY,
                "NEX_MAINTENANCE_UNKNOWN_BACKFILL_WORK_KEY: '{}'",
                item.work_key
            );
            Ok(())
        }
        AutomaticRunKind::Verify => {
            anyhow::ensure!(
                item.work_key == format!("{VERIFY_WORK_KEY_PREFIX}{}", item.semantic_epoch_id.as_deref().unwrap_or_default()),
                "NEX_MAINTENANCE_VERIFY_WORK_KEY_MISMATCH: work key is not bound to its Semantic Epoch"
            );
            Ok(())
        }
        AutomaticRunKind::RebuildDerived => {
            anyhow::ensure!(
                item.work_key == REBUILD_DERIVED_WORK_KEY,
                "NEX_MAINTENANCE_UNKNOWN_REBUILD_WORK_KEY: '{}'",
                item.work_key
            );
            Ok(())
        }
    }
}

fn dispatch_enabled_work(db: &Database, item: &DesiredWork) -> anyhow::Result<()> {
    validate_dispatch_contract(item)?;
    // This adapter uses the exact Database supplied by the live
    // WorkspaceAuthority. It owns its transaction phases but never opens a
    // second filesystem connection.
    match item.run_kind {
        AutomaticRunKind::Backfill => {
            super::bootstrap_legacy_dependency_backfill_for_project(db, &item.project_id)?;
            Ok(())
        }
        AutomaticRunKind::Verify => {
            run_dependency_verify_for_project(db, &item.project_id)?;
            Ok(())
        }
        AutomaticRunKind::RebuildDerived => {
            match rebuild_narrative_derived_state_for_project(db, &item.project_id)? {
                RebuildDerivedStateOutcome::AlreadyRunning { .. }
                | RebuildDerivedStateOutcome::Ran { .. } => Ok(()),
            }
        }
    }
}

/// Trigger vocabulary consumed by the pure desired-work planner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MaintenanceTrigger {
    WorkspaceOpened {
        project_id: String,
    },
    LegacyBackfillRequired {
        project_id: String,
    },
    LegacyBackfillCompleted {
        project_id: String,
        semantic_epoch_id: String,
    },
    EpochRotated {
        project_id: String,
        semantic_epoch_id: String,
    },
    RestoreCompleted {
        project_id: String,
        semantic_epoch_id: String,
    },
    RuleDigestChanged {
        project_id: String,
        semantic_epoch_id: String,
    },
    DerivedStateInvalid {
        project_id: String,
        semantic_epoch_id: String,
    },
    VerifyRequested {
        project_id: String,
        semantic_epoch_id: String,
    },
    BeforeCutover {
        project_id: String,
        semantic_epoch_id: String,
    },
}

/// One coalescible desired work item.  The public scalar fields make the
/// canonical key explicit and keep this DTO convenient for Rust and JSON
/// callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesiredWork {
    pub project_id: String,
    pub run_kind: AutomaticRunKind,
    pub work_key: String,
    pub semantic_epoch_id: Option<String>,
    pub reasons: Vec<String>,
}

impl DesiredWork {
    pub fn new(
        project_id: impl Into<String>,
        run_kind: AutomaticRunKind,
        work_key: impl Into<String>,
        reason: impl Into<String>,
    ) -> anyhow::Result<Self> {
        Self::new_with_epoch(project_id, run_kind, work_key, None, reason)
    }

    fn new_with_epoch(
        project_id: impl Into<String>,
        run_kind: AutomaticRunKind,
        work_key: impl Into<String>,
        semantic_epoch_id: Option<String>,
        reason: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let key = WorkKey::new(project_id, run_kind, work_key)?;
        let semantic_epoch_id = semantic_epoch_id
            .map(|epoch_id| require_component(epoch_id, "semanticEpochId"))
            .transpose()?;
        let reason = require_component(reason.into(), "reason")?;
        Ok(Self {
            project_id: key.project_id,
            run_kind: key.run_kind,
            work_key: key.work_key,
            semantic_epoch_id,
            reasons: vec![reason],
        })
    }

    pub fn work_key_identity(&self) -> WorkKey {
        WorkKey {
            project_id: self.project_id.clone(),
            run_kind: self.run_kind,
            work_key: self.work_key.clone(),
            semantic_epoch_id: self.semantic_epoch_id.clone(),
        }
    }

    pub fn canonical_key(&self) -> String {
        self.work_key_identity().canonical_key()
    }

    fn add_reason(&mut self, reason: &str) {
        if !self.reasons.iter().any(|existing| existing == reason) {
            self.reasons.push(reason.to_string());
        }
    }
}

/// Convert one trigger into one or more desired work items.  This is pure:
/// no database, runtime policy, Finding, or adapter is consulted.
pub fn plan_maintenance_trigger(trigger: &MaintenanceTrigger) -> anyhow::Result<Vec<DesiredWork>> {
    let mut planned = Vec::new();
    match trigger {
        MaintenanceTrigger::WorkspaceOpened { project_id }
        | MaintenanceTrigger::LegacyBackfillRequired { project_id } => {
            planned.push(DesiredWork::new(
                project_id,
                AutomaticRunKind::Backfill,
                LEGACY_BACKFILL_WORK_KEY,
                match trigger {
                    MaintenanceTrigger::WorkspaceOpened { .. } => "workspace-opened",
                    MaintenanceTrigger::LegacyBackfillRequired { .. } => "legacy-backfill-required",
                    _ => unreachable!("matched backfill trigger"),
                },
            )?);
        }
        MaintenanceTrigger::LegacyBackfillCompleted {
            project_id,
            semantic_epoch_id,
        }
        | MaintenanceTrigger::VerifyRequested {
            project_id,
            semantic_epoch_id,
        } => {
            planned.push(verify_work(
                project_id,
                semantic_epoch_id,
                trigger_reason(trigger),
            )?);
        }
        MaintenanceTrigger::EpochRotated {
            project_id,
            semantic_epoch_id,
        }
        | MaintenanceTrigger::RestoreCompleted {
            project_id,
            semantic_epoch_id,
        }
        | MaintenanceTrigger::RuleDigestChanged {
            project_id,
            semantic_epoch_id,
        }
        | MaintenanceTrigger::DerivedStateInvalid {
            project_id,
            semantic_epoch_id,
        } => {
            planned.push(verify_work(
                project_id,
                semantic_epoch_id,
                trigger_reason(trigger),
            )?);
        }
        MaintenanceTrigger::BeforeCutover {
            project_id,
            semantic_epoch_id,
        } => {
            // Verify owns the conditional Rebuild decision. Rust discovers
            // that follow-up from the durable report; callers never enqueue
            // Rebuild speculatively before the first Verify.
            planned.push(verify_work(
                project_id,
                semantic_epoch_id,
                "before-cutover",
            )?);
        }
    }
    Ok(planned)
}

fn verify_work(
    project_id: &str,
    semantic_epoch_id: &str,
    reason: &str,
) -> anyhow::Result<DesiredWork> {
    let epoch_id = require_component(semantic_epoch_id.to_string(), "semanticEpochId")?;
    DesiredWork::new_with_epoch(
        project_id,
        AutomaticRunKind::Verify,
        format!("{VERIFY_WORK_KEY_PREFIX}{epoch_id}"),
        Some(epoch_id),
        reason,
    )
}

fn trigger_reason(trigger: &MaintenanceTrigger) -> &'static str {
    match trigger {
        MaintenanceTrigger::WorkspaceOpened { .. } => "workspace-opened",
        MaintenanceTrigger::LegacyBackfillRequired { .. } => "legacy-backfill-required",
        MaintenanceTrigger::LegacyBackfillCompleted { .. } => "legacy-backfill-completed",
        MaintenanceTrigger::EpochRotated { .. } => "semantic-epoch-rotated",
        MaintenanceTrigger::RestoreCompleted { .. } => "restore-completed",
        MaintenanceTrigger::RuleDigestChanged { .. } => "rule-digest-changed",
        MaintenanceTrigger::DerivedStateInvalid { .. } => "derived-state-invalid",
        MaintenanceTrigger::VerifyRequested { .. } => "verify-requested",
        MaintenanceTrigger::BeforeCutover { .. } => "before-cutover",
    }
}

/// Coalesce duplicate desired work while preserving first-seen order and
/// merging unique reasons.  The key includes project and Run Kind.
pub fn coalesce_desired_work<I>(items: I) -> Vec<DesiredWork>
where
    I: IntoIterator<Item = DesiredWork>,
{
    let mut positions = BTreeMap::<String, usize>::new();
    let mut result: Vec<DesiredWork> = Vec::new();
    for item in items {
        let key = item.canonical_key();
        if let Some(position) = positions.get(&key).copied() {
            for reason in item.reasons {
                result[position].add_reason(&reason);
            }
            continue;
        }
        positions.insert(key, result.len());
        result.push(item);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaintenanceExecutionMode {
    Shadow,
    ExecuteSafe,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaintenanceExecutionDecision {
    PlanOnly,
    ExecuteBackfill,
    ExecuteVerify,
    ExecuteRebuildDerived,
    Deferred { reason: String },
}

/// Shadow mode remains plan-only. Execute mode accepts every automatic phase;
/// Repair is not representable by [`AutomaticRunKind`].
pub fn decide_execution(
    work: &DesiredWork,
    mode: MaintenanceExecutionMode,
) -> MaintenanceExecutionDecision {
    if mode == MaintenanceExecutionMode::Shadow {
        return MaintenanceExecutionDecision::PlanOnly;
    }
    match work.run_kind {
        AutomaticRunKind::Backfill => MaintenanceExecutionDecision::ExecuteBackfill,
        AutomaticRunKind::Verify => MaintenanceExecutionDecision::ExecuteVerify,
        AutomaticRunKind::RebuildDerived => MaintenanceExecutionDecision::ExecuteRebuildDerived,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailureClass {
    Transient,
    Contract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureClassification {
    pub class: FailureClass,
    pub code: String,
    pub retryable: bool,
}

/// Classify only failures known to be safe to retry.  Unknown failures are
/// deliberately contract/manual failures (fail closed).
pub fn classify_failure(message: &str) -> FailureClassification {
    let lower = message.to_ascii_lowercase();
    let transient = [
        "sqlite_busy",
        "sqlite_locked",
        "nex_maintenance_sqlite_locked",
        "nex_maintenance_transient",
        "nex_maintenance_sqlite_ioerr",
        "database is locked",
        "database table is locked",
        "interrupted",
        "process interruption",
        "workspace switching",
        "lease timeout",
        "transient io",
        "sqlite_ioerr",
        "i/o error",
        "input/output error",
        "io error",
        "temporarily unavailable",
    ]
    .iter()
    .any(|marker| lower.contains(marker));

    if transient {
        return FailureClassification {
            class: FailureClass::Transient,
            code: "NEX_MAINTENANCE_TRANSIENT".to_string(),
            retryable: true,
        };
    }

    let code = message
        .split(|character: char| character == ':' || character.is_whitespace())
        .find(|token| token.starts_with("NEX_"))
        .unwrap_or("NEX_MAINTENANCE_UNCLASSIFIED")
        .to_string();
    if matches!(
        code.as_str(),
        "NEX_SEMANTIC_EPOCH_CHANGED"
            | "NEX_CURSOR_RESERVATION_CONFLICT"
            | "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"
            | "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED"
            | "NEX_MAINTENANCE_INTERRUPTED"
            | "NEX_MAINTENANCE_TRANSIENT"
            | "NEX_REBUILD_DERIVED_STALE_EPOCH"
            | "NEX_VERIFY_STALE_EPOCH"
    ) {
        return FailureClassification {
            class: FailureClass::Transient,
            code,
            retryable: true,
        };
    }
    FailureClassification {
        class: FailureClass::Contract,
        code,
        retryable: false,
    }
}

pub const MAX_AUTOMATIC_RETRIES: u32 = 3;
const INITIAL_RETRY_BACKOFF_MS: u64 = 1_000;

/// Distinguishes an in-process live single-flight from a row left behind by a
/// process interruption. Persisted `running` rows are never permanently
/// coalesced during startup recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecoveryMode {
    SameProcessLive,
    StartupRecovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleActiveRun {
    pub run_id: String,
    pub semantic_epoch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunLedgerCounts {
    pub pending_runs: u32,
    pub running_runs: u32,
    pub failed_runs: u32,
    pub completed_runs: u32,
    pub total_runs: u32,
    pub stale_active_runs: u32,
    #[serde(skip)]
    pub pending_run_ids: Vec<String>,
    #[serde(skip)]
    pub running_run_ids: Vec<String>,
    #[serde(skip)]
    pub stale_active_run_ids: Vec<String>,
    #[serde(skip)]
    pub stale_active_run_provenance: Vec<StaleActiveRun>,
    /// Latest durable reason for a failed row that is still newer than the
    /// most recent completed row. Recovery must classify this persisted value
    /// instead of silently treating a failed Backfill as missing detail.
    #[serde(skip)]
    pub latest_failed_terminal_reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecoveryAction {
    /// An existing running Run is the durable single-flight marker.  The
    /// coordinator must reuse/coalesce it rather than creating another row.
    CoalescedRunning {
        running_runs: u32,
        run_ids: Vec<String>,
    },
    /// A pending row is also a live same-process marker. It is kept separate
    /// from `CoalescedRunning` so a startup path cannot accidentally reuse it.
    CoalescedPending {
        pending_runs: u32,
        run_ids: Vec<String>,
    },
    /// Active rows discovered after process startup for the expected epoch
    /// must be terminalized by an explicit adapter before a new cycle can be
    /// planned.
    RecoverInterrupted {
        run_ids: Vec<String>,
    },
    /// Active rows from another Semantic Epoch. Their row epoch is retained
    /// as provenance so a later adapter can terminalize exactly the rows
    /// observed by this decision without pretending they belong to the
    /// current WorkKey epoch.
    RecoverStaleEpoch {
        runs: Vec<StaleActiveRun>,
    },
    SkipCompleted {
        completed_runs: u32,
    },
    /// No durable row exists for this work identity.  This is the typed
    /// first-cycle action; it is intentionally distinct from `Retry`, which
    /// requires a known failure from an existing cycle.
    StartFresh,
    Retry {
        attempt: u32,
        backoff_ms: u64,
    },
    ManualIntervention {
        code: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryDecision {
    pub mode: RecoveryMode,
    pub expected_semantic_epoch_id: Option<String>,
    pub pending_runs: u32,
    pub running_runs: u32,
    pub failed_runs: u32,
    pub completed_runs: u32,
    pub total_runs: u32,
    pub stale_active_runs: u32,
    pub stale_active_run_ids: Vec<String>,
    pub stale_active_run_provenance: Vec<StaleActiveRun>,
    pub action: RecoveryAction,
}

/// Read the existing Run ledger for one work key, scoped to an expected
/// Semantic Epoch when one is supplied. Old-epoch completed rows cannot cause
/// a skip, and old-epoch active rows are surfaced as recovery candidates.
pub fn read_run_ledger_for_epoch(
    db: &Database,
    work: &WorkKey,
    expected_semantic_epoch_id: Option<&str>,
) -> anyhow::Result<RunLedgerCounts> {
    validate_epoch_contract(work, expected_semantic_epoch_id)?;
    if let Some(epoch_id) = expected_semantic_epoch_id {
        anyhow::ensure!(!epoch_id.trim().is_empty(), "semanticEpochId is required");
    }
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, status, semantic_epoch_id, terminal_reason_code,
                    created_at, started_at, completed_at
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3
              ORDER BY (julianday(COALESCE(completed_at, started_at, created_at)) IS NULL) ASC,
                       julianday(COALESCE(completed_at, started_at, created_at)) ASC,
                       COALESCE(completed_at, started_at, created_at) ASC, id ASC",
        )?;
        let rows = statement.query_map(
            params![work.project_id, work.run_kind.as_str(), work.work_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )?;
        let mut current_rows = Vec::new();
        let mut stale_active_runs = Vec::new();
        for row in rows {
            let (
                id,
                status,
                row_epoch_id,
                terminal_reason_code,
                created_at,
                started_at,
                completed_at,
            ) = row?;
            let lifecycle_raw = completed_at
                .as_deref()
                .or(started_at.as_deref())
                .unwrap_or(created_at.as_str());
            let lifecycle_at = parse_maintenance_instant(lifecycle_raw)?;
            let epoch_matches = expected_semantic_epoch_id
                .map(|expected| row_epoch_id.as_deref() == Some(expected))
                .unwrap_or(true);
            if epoch_matches {
                current_rows.push((lifecycle_at, id, status, terminal_reason_code));
            } else if matches!(status.as_str(), "pending" | "running") {
                stale_active_runs.push(StaleActiveRun {
                    run_id: id,
                    semantic_epoch_id: row_epoch_id,
                });
            }
        }

        let latest_completed_key = current_rows
            .iter()
            .filter(|(_, _, status, _)| status == "completed")
            .map(|(lifecycle_at, id, _, _)| (*lifecycle_at, id.as_str()))
            .max_by(|left, right| left.cmp(right));
        let mut pending_run_ids = Vec::new();
        let mut running_run_ids = Vec::new();
        let mut failed_runs = 0_u32;
        let mut completed_runs = 0_u32;
        let mut latest_failed_terminal_reason_code = None;
        for (lifecycle_at, id, status, terminal_reason_code) in &current_rows {
            match status.as_str() {
                "pending" => pending_run_ids.push(id.clone()),
                "running" => running_run_ids.push(id.clone()),
                "failed"
                    if latest_completed_key
                        .as_ref()
                        .map(|(completed_at, completed_id)| {
                            (*lifecycle_at, id.as_str()) > (*completed_at, *completed_id)
                        })
                        .unwrap_or(true) =>
                {
                    failed_runs = failed_runs.saturating_add(1);
                    latest_failed_terminal_reason_code = terminal_reason_code.clone();
                }
                "completed" => completed_runs = completed_runs.saturating_add(1),
                _ => {}
            }
        }

        Ok(RunLedgerCounts {
            pending_runs: u32::try_from(pending_run_ids.len())?,
            running_runs: u32::try_from(running_run_ids.len())?,
            failed_runs,
            completed_runs,
            total_runs: u32::try_from(current_rows.len())?,
            stale_active_runs: u32::try_from(stale_active_runs.len())?,
            pending_run_ids,
            running_run_ids,
            stale_active_run_ids: stale_active_runs
                .iter()
                .map(|run| run.run_id.clone())
                .collect(),
            stale_active_run_provenance: stale_active_runs,
            latest_failed_terminal_reason_code,
        })
    })
}

/// Read the existing Run ledger without epoch scoping for legacy callers.
/// New automatic callers should use [`read_run_ledger_for_epoch`].
pub fn read_run_ledger(db: &Database, work: &WorkKey) -> anyhow::Result<RunLedgerCounts> {
    read_run_ledger_for_epoch(db, work, None)
}

/// Decide whether the next automatic request should reuse, retry, skip, or
/// stop based on the durable Run ledger and the current failure class.
pub fn decide_run_recovery(
    db: &Database,
    work: &WorkKey,
    failure_message: Option<&str>,
) -> anyhow::Result<RecoveryDecision> {
    decide_run_recovery_for_epoch(
        db,
        work,
        None,
        RecoveryMode::SameProcessLive,
        failure_message,
    )
}

/// Epoch-scoped recovery decision with an explicit distinction between live
/// same-process coalescing and startup recovery of persisted active rows.
pub fn decide_run_recovery_for_epoch(
    db: &Database,
    work: &WorkKey,
    expected_semantic_epoch_id: Option<&str>,
    mode: RecoveryMode,
    failure_message: Option<&str>,
) -> anyhow::Result<RecoveryDecision> {
    let counts = read_run_ledger_for_epoch(db, work, expected_semantic_epoch_id)?;
    let durable_failure_message =
        failure_message.or(counts.latest_failed_terminal_reason_code.as_deref());
    let mut current_active_run_ids = counts.running_run_ids.clone();
    current_active_run_ids.extend(counts.pending_run_ids.clone());
    let action = if !counts.stale_active_run_provenance.is_empty() {
        RecoveryAction::RecoverStaleEpoch {
            runs: counts.stale_active_run_provenance.clone(),
        }
    } else if mode == RecoveryMode::StartupRecovery && !current_active_run_ids.is_empty() {
        RecoveryAction::RecoverInterrupted {
            run_ids: current_active_run_ids,
        }
    } else if counts.running_runs > 0 {
        RecoveryAction::CoalescedRunning {
            running_runs: counts.running_runs,
            run_ids: counts.running_run_ids.clone(),
        }
    } else if counts.pending_runs > 0 {
        RecoveryAction::CoalescedPending {
            pending_runs: counts.pending_runs,
            run_ids: counts.pending_run_ids.clone(),
        }
    } else if work.run_kind == AutomaticRunKind::Backfill
        && counts.completed_runs > 0
        && counts.failed_runs == 0
        && durable_failure_message.is_none()
    {
        RecoveryAction::SkipCompleted {
            completed_runs: counts.completed_runs,
        }
    } else if counts.failed_runs == 0 && durable_failure_message.is_none() {
        RecoveryAction::StartFresh
    } else if let Some(message) = durable_failure_message {
        let classification = classify_failure(message);
        if !classification.retryable {
            RecoveryAction::ManualIntervention {
                code: classification.code,
            }
        } else if counts.failed_runs == 0 {
            RecoveryAction::ManualIntervention {
                code: "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING".to_string(),
            }
        } else if counts.failed_runs >= MAX_AUTOMATIC_RETRIES {
            RecoveryAction::ManualIntervention {
                code: "NEX_MAINTENANCE_RETRY_EXHAUSTED".to_string(),
            }
        } else {
            let attempt = counts.failed_runs.saturating_add(1);
            RecoveryAction::Retry {
                attempt,
                backoff_ms: retry_backoff_ms(attempt),
            }
        }
    } else {
        retry_or_manual(&counts, durable_failure_message)
    };

    Ok(RecoveryDecision {
        mode,
        expected_semantic_epoch_id: expected_semantic_epoch_id.map(str::to_string),
        pending_runs: counts.pending_runs,
        running_runs: counts.running_runs,
        failed_runs: counts.failed_runs,
        completed_runs: counts.completed_runs,
        total_runs: counts.total_runs,
        stale_active_runs: counts.stale_active_runs,
        stale_active_run_ids: counts.stale_active_run_ids,
        stale_active_run_provenance: counts.stale_active_run_provenance,
        action,
    })
}

fn retry_or_manual(counts: &RunLedgerCounts, failure_message: Option<&str>) -> RecoveryAction {
    if failure_message.is_none() && counts.failed_runs > 0 {
        return RecoveryAction::ManualIntervention {
            code: "NEX_MAINTENANCE_FAILURE_DETAIL_MISSING".to_string(),
        };
    }
    if counts.failed_runs >= MAX_AUTOMATIC_RETRIES {
        return RecoveryAction::ManualIntervention {
            code: "NEX_MAINTENANCE_RETRY_EXHAUSTED".to_string(),
        };
    }
    let attempt = counts.failed_runs.saturating_add(1);
    RecoveryAction::Retry {
        attempt,
        backoff_ms: retry_backoff_ms(attempt),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterruptedRunTerminalization {
    pub failed_run_ids: Vec<String>,
    pub cancelled_pending_run_ids: Vec<String>,
}

/// Safely terminalize explicit active Run IDs discovered by startup recovery.
/// The operation is one `BEGIN IMMEDIATE` transaction and touches only the
/// Run rows; it never creates or mutates Task/Attempt rows.
pub fn terminalize_interrupted_runs(
    db: &Database,
    project_id: &str,
    work: &WorkKey,
    run_ids: &[String],
) -> anyhow::Result<InterruptedRunTerminalization> {
    terminalize_interrupted_runs_for_epoch(
        db,
        project_id,
        work,
        work.semantic_epoch_id.as_deref(),
        run_ids,
    )
}

/// Epoch-aware form of [`terminalize_interrupted_runs`].  A legacy
/// epoch-less WorkKey continues to accept legacy rows with any epoch when no
/// expected epoch is supplied.  Once the caller supplies an expected epoch,
/// every target row must carry exactly that epoch; this prevents recovery from
/// terminalizing a row belonging to another semantic cycle.
pub fn terminalize_interrupted_runs_for_epoch(
    db: &Database,
    project_id: &str,
    work: &WorkKey,
    expected_semantic_epoch_id: Option<&str>,
    run_ids: &[String],
) -> anyhow::Result<InterruptedRunTerminalization> {
    validate_epoch_contract(work, expected_semantic_epoch_id)?;
    if let Some(epoch_id) = expected_semantic_epoch_id {
        anyhow::ensure!(!epoch_id.trim().is_empty(), "semanticEpochId is required");
    }
    terminalize_interrupted_runs_impl(
        db,
        project_id,
        work,
        run_ids,
        expected_semantic_epoch_id,
        None,
    )
}

/// Terminalize stale active rows returned by [`RecoveryAction::RecoverStaleEpoch`].
/// The WorkKey remains bound to the current epoch, while each target carries
/// the observed old-row epoch as provenance. Both the provenance and the
/// current-vs-stale distinction are checked again inside the transaction.
pub fn terminalize_stale_interrupted_runs(
    db: &Database,
    project_id: &str,
    work: &WorkKey,
    stale_runs: &[StaleActiveRun],
) -> anyhow::Result<InterruptedRunTerminalization> {
    let Some(expected_semantic_epoch_id) = work.semantic_epoch_id.as_deref() else {
        anyhow::bail!("stale recovery requires an epoch-bound WorkKey");
    };
    terminalize_stale_interrupted_runs_for_epoch(
        db,
        project_id,
        work,
        expected_semantic_epoch_id,
        stale_runs,
    )
}

/// Epoch-explicit stale recovery form. A legacy epoch-less WorkKey may use
/// this API when the caller has a trusted current-epoch expectation from the
/// planner; an epoch-bound WorkKey must still match that expectation.
pub fn terminalize_stale_interrupted_runs_for_epoch(
    db: &Database,
    project_id: &str,
    work: &WorkKey,
    expected_semantic_epoch_id: &str,
    stale_runs: &[StaleActiveRun],
) -> anyhow::Result<InterruptedRunTerminalization> {
    validate_epoch_contract(work, Some(expected_semantic_epoch_id))?;
    anyhow::ensure!(
        !expected_semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );
    let mut expected_row_epochs = BTreeMap::new();
    let mut run_ids = Vec::with_capacity(stale_runs.len());
    for stale_run in stale_runs {
        anyhow::ensure!(
            stale_run.semantic_epoch_id.as_deref() != Some(expected_semantic_epoch_id),
            "stale recovery row is from the current semantic epoch"
        );
        anyhow::ensure!(
            expected_row_epochs
                .insert(
                    stale_run.run_id.clone(),
                    stale_run.semantic_epoch_id.clone()
                )
                .is_none(),
            "duplicate stale run ID '{}'",
            stale_run.run_id
        );
        run_ids.push(stale_run.run_id.clone());
    }
    terminalize_interrupted_runs_impl(
        db,
        project_id,
        work,
        &run_ids,
        Some(expected_semantic_epoch_id),
        Some(&expected_row_epochs),
    )
}

fn terminalize_interrupted_runs_impl(
    db: &Database,
    project_id: &str,
    work: &WorkKey,
    run_ids: &[String],
    expected_semantic_epoch_id: Option<&str>,
    expected_row_epochs: Option<&BTreeMap<String, Option<String>>>,
) -> anyhow::Result<InterruptedRunTerminalization> {
    anyhow::ensure!(
        project_id == work.project_id,
        "projectId does not match work key"
    );
    anyhow::ensure!(!run_ids.is_empty(), "at least one run ID is required");
    let mut unique_ids = BTreeSet::new();
    for run_id in run_ids {
        anyhow::ensure!(!run_id.trim().is_empty(), "run ID is required");
        anyhow::ensure!(unique_ids.insert(run_id), "duplicate run ID '{run_id}'");
    }

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let mut active = Vec::with_capacity(run_ids.len());
            for run_id in run_ids {
                let row: Option<(String, String, String, Option<String>)> = conn
                    .query_row(
                        "SELECT project_id, run_kind, work_key, semantic_epoch_id
                           FROM narrative_extraction_runs WHERE id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let Some((run_project_id, run_kind, run_work_key, row_epoch_id)) = row else {
                    anyhow::bail!("run does not belong to maintenance work: '{run_id}'");
                };
                anyhow::ensure!(
                    run_project_id == project_id
                        && run_kind == work.run_kind.as_str()
                        && run_work_key == work.work_key,
                    "run does not belong to maintenance work: '{run_id}'"
                );
                if let Some(row_epochs) = expected_row_epochs {
                    let expected_row_epoch = row_epochs.get(run_id).ok_or_else(|| {
                        anyhow::anyhow!("run epoch provenance is missing: '{run_id}'")
                    })?;
                    anyhow::ensure!(
                        &row_epoch_id == expected_row_epoch,
                        "run semantic epoch does not match recovery provenance: '{run_id}'"
                    );
                    if let Some(expected_epoch_id) = expected_semantic_epoch_id {
                        anyhow::ensure!(
                            row_epoch_id.as_deref() != Some(expected_epoch_id),
                            "run semantic epoch is not stale: '{run_id}'"
                        );
                    }
                } else if let Some(expected_epoch_id) = expected_semantic_epoch_id {
                    anyhow::ensure!(
                        row_epoch_id.as_deref() == Some(expected_epoch_id),
                        "run semantic epoch does not match maintenance work: '{run_id}'"
                    );
                }
                let status: String = conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                    params![run_id],
                    |row| row.get(0),
                )?;
                let status = NarrativeRunStatus::try_from(status.as_str())?;
                anyhow::ensure!(
                    matches!(
                        status,
                        NarrativeRunStatus::Pending | NarrativeRunStatus::Running
                    ),
                    "run '{run_id}' is not active and cannot be recovered"
                );
                active.push((run_id.clone(), status));
            }

            let mut result = InterruptedRunTerminalization {
                failed_run_ids: Vec::new(),
                cancelled_pending_run_ids: Vec::new(),
            };
            for (run_id, status) in active {
                let target = match status {
                    NarrativeRunStatus::Running => {
                        result.failed_run_ids.push(run_id.clone());
                        NarrativeRunStatus::Failed
                    }
                    NarrativeRunStatus::Pending => {
                        result.cancelled_pending_run_ids.push(run_id.clone());
                        NarrativeRunStatus::Cancelled
                    }
                    _ => unreachable!("active status was validated above"),
                };
                transition_run_status_in_tx(conn, &run_id, target)?;
                anyhow::ensure!(
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET terminal_reason_code = 'NEX_MAINTENANCE_INTERRUPTED'
                          WHERE id = ?1 AND status = ?2",
                        params![run_id, target.as_str()],
                    )? == 1,
                    "run terminalization lost its row: '{run_id}'"
                );
            }
            Ok(result)
        })
    })
}

pub const fn retry_backoff_ms(attempt: u32) -> u64 {
    match attempt {
        0 | 1 => INITIAL_RETRY_BACKOFF_MS,
        2 => INITIAL_RETRY_BACKOFF_MS * 2,
        _ => INITIAL_RETRY_BACKOFF_MS * 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_kind_set_is_closed() {
        assert_eq!(AutomaticRunKind::all().len(), 3);
        assert_eq!(AutomaticRunKind::Backfill.as_str(), "backfill");
        assert_eq!(AutomaticRunKind::Verify.as_str(), "dependency-verify");
        assert_eq!(
            AutomaticRunKind::RebuildDerived.as_str(),
            "semantic-index-rebuild"
        );
        assert_eq!(
            serde_json::to_string(&AutomaticRunKind::RebuildDerived).expect("serialize kind"),
            "\"semantic-index-rebuild\""
        );
    }

    #[test]
    fn coalesce_merges_reasons_without_duplicate_keys() {
        let first =
            DesiredWork::new("project", AutomaticRunKind::Backfill, "key", "a").expect("work");
        let second =
            DesiredWork::new("project", AutomaticRunKind::Backfill, "key", "b").expect("work");
        let result = coalesce_desired_work([first, second]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].reasons, ["a", "b"]);
    }
}
