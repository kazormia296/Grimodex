//! Durable coordinator and phase owner for Narrative Maintenance (C2-5B).
//!
//! Rust owns discovery, recovery, and bounded dispatch of the automatic
//! Backfill -> Verify -> conditional Rebuild -> confirmation Verify state
//! machine. Electron only wakes this owner and supplies the pinned live
//! `Database`; Repair remains a human/manual path.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::legacy_backfill::{
    is_valid_completed_backfill_marker, parse_maintenance_instant, CompletedBackfillMarker,
    LEGACY_BACKFILL_WORK_KEY as WRITER_BACKFILL_WORK_KEY,
};
use super::maintenance_contracts::current_maintenance_coordinates;
use super::maintenance_lifecycle::{
    ensure_recovery_lifecycle_is_empty_in_tx, fail_maintenance_run_in_tx,
    load_maintenance_run_in_tx, synthesize_recovery_lifecycle_in_tx, MaintenanceFailureKind,
    MaintenanceRunHandle,
};
use super::maintenance_lifecycle::{
    load_completed_maintenance_run_in_tx, release_foreground_maintenance_run_in_tx,
};
use super::maintenance_skip_evidence::{
    evaluate_completed_run_skip, persist_completed_run_skip_evidence_in_tx,
    CompletedRunSkipDecision, CompletedRunSkipEvidence, CompletedRunSkipExpectation,
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

/// Maximum number of work items dequeued and recovered by one main-process
/// cycle. A cycle is deliberately bounded so a burst of trigger events or a
/// malformed durable row cannot turn one background call into an unbounded
/// writer hold. Project serialization remains the main scheduler's
/// responsibility; this bound is the native boundary's last line of defence
/// for callers that bypass that scheduler.
pub const MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE: usize = 32;

/// Canonical product-journey owner token. The Electron main process performs
/// the outer launch gate; the shared crate repeats the check at the native
/// boundary so a forged N-API caller cannot enable the seam accidentally.
pub const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN: &str =
    "c2-5b-product-journey-owner-v1";
pub const NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION: u64 = (1u64 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeMaintenanceCiFault {
    TransientIo,
    ContractViolation,
    ProcessInterruption,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NarrativeMaintenanceCiTrigger {
    #[serde(rename = "dependency-gap")]
    DependencyGap,
    #[serde(rename = "foreground-workspace-wake")]
    ForegroundWorkspaceWake,
    #[serde(rename = "graphContractDigest-changed")]
    GraphContractDigestChanged,
    #[serde(rename = "ruleRegistryDigest-changed")]
    RuleRegistryDigestChanged,
    #[serde(rename = "producerGenerationSetDigest-changed")]
    ProducerGenerationSetDigestChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeMaintenanceCiSetup {
    Disabled,
}

/// Typed configuration accepted only by the main -> N-API -> shared-Rust
/// startup seam. It deliberately has no digest fields: product journeys read
/// durable native skip evidence instead of allowing JavaScript to choose a
/// semantic coordinate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeMaintenanceCiConfig {
    pub is_packaged: bool,
    pub ci: String,
    pub owner_token: String,
    pub fault: Option<NarrativeMaintenanceCiFault>,
    pub trigger: Option<NarrativeMaintenanceCiTrigger>,
    pub setup: Option<NarrativeMaintenanceCiSetup>,
    pub product_journey_barrier_id: Option<String>,
    pub correlation: Option<String>,
}

impl NarrativeMaintenanceCiConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.is_packaged && self.ci == "true",
            "NEX_MAINTENANCE_CI_SEAM_INACTIVE: only unpackaged CI launches may enable the product journey seam"
        );
        anyhow::ensure!(
            self.owner_token == NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN,
            "NEX_MAINTENANCE_CI_SEAM_OWNER_MISMATCH: product journey owner token is not canonical"
        );
        match (
            self.product_journey_barrier_id.as_deref(),
            self.correlation.as_deref(),
        ) {
            (Some(barrier), Some(correlation)) => {
                validate_ci_identifier(barrier, "productJourneyBarrierId")?;
                validate_ci_identifier(correlation, "correlation")?;
            }
            (None, None) => {}
            _ => anyhow::bail!(
                "NEX_MAINTENANCE_CI_SEAM_MARKER_INCOMPLETE: product journey barrier and correlation must be supplied together"
            ),
        }
        Ok(())
    }

    pub fn foreground_marker(
        &self,
        work: &DesiredWork,
        binding: &MaintenanceWorkspaceBinding,
    ) -> Option<NarrativeSystemWorkMarker> {
        if self.trigger != Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake) {
            return None;
        }
        binding.validate().ok()?;
        Some(NarrativeSystemWorkMarker {
            trigger: "workspace-opened".to_string(),
            canonical_work_key: work.canonical_key(),
            authority_id: binding.authority_id.clone(),
            generation: binding.generation,
            product_journey_barrier_id: self.product_journey_barrier_id.clone()?,
            correlation: self.correlation.clone()?,
        })
    }
}

fn validate_ci_identifier(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.is_empty(), "{name} must not be empty");
    anyhow::ensure!(value == value.trim(), "{name} must be trimmed");
    anyhow::ensure!(!value.contains('\0'), "{name} must not contain NUL");
    Ok(())
}

/// Immutable metadata stored under `Run.spec_json.systemWork`. This is
/// native-owned: the marker is inserted before the Run row is created and is
/// rejected if a caller tries to provide a conflicting value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrativeSystemWorkMarker {
    pub trigger: String,
    pub canonical_work_key: String,
    pub authority_id: String,
    pub generation: u64,
    pub product_journey_barrier_id: String,
    pub correlation: String,
}

impl NarrativeSystemWorkMarker {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.trigger == "workspace-opened",
            "systemWork.trigger must be the native workspace-opened trigger"
        );
        anyhow::ensure!(
            !self.canonical_work_key.is_empty()
                && self.canonical_work_key == self.canonical_work_key.trim()
                && !self.canonical_work_key.contains('\0'),
            "systemWork.canonicalWorkKey must be trimmed and must not contain NUL"
        );
        anyhow::ensure!(
            !self.authority_id.is_empty()
                && self.authority_id == self.authority_id.trim()
                && !self.authority_id.contains('\0'),
            "systemWork.authorityId must be trimmed and must not contain NUL"
        );
        anyhow::ensure!(
            self.generation > 0 && self.generation <= NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION,
            "systemWork.generation must be a safe non-zero integer"
        );
        anyhow::ensure!(
            !self.product_journey_barrier_id.is_empty()
                && self.product_journey_barrier_id == self.product_journey_barrier_id.trim()
                && !self.product_journey_barrier_id.contains('\0'),
            "systemWork.productJourneyBarrierId must be trimmed and must not contain NUL"
        );
        anyhow::ensure!(
            !self.correlation.is_empty()
                && self.correlation == self.correlation.trim()
                && !self.correlation.contains('\0'),
            "systemWork.correlation must be trimmed and must not contain NUL"
        );
        Ok(())
    }
}

/// The durable Run selected by the foreground product-journey barrier.  The
/// marker is returned with the id so the N-API owner can release exactly this
/// Run after an ordinary tree write; a different Run with the same project
/// or work key is never sufficient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundSystemWorkRun {
    pub run_id: String,
    pub project_id: String,
    pub marker: NarrativeSystemWorkMarker,
}

thread_local! {
    static ACTIVE_SYSTEM_WORK_MARKER: RefCell<Option<NarrativeSystemWorkMarker>> =
        const { RefCell::new(None) };
}

/// Attach one marker to the system Run created by a synchronous adapter call.
/// The guard is process-local and never crosses a renderer or IPC boundary.
pub(crate) fn with_system_work_marker<T>(
    marker: Option<NarrativeSystemWorkMarker>,
    operation: impl FnOnce() -> T,
) -> T {
    struct MarkerGuard(Option<NarrativeSystemWorkMarker>);
    impl Drop for MarkerGuard {
        fn drop(&mut self) {
            let previous = self.0.take();
            ACTIVE_SYSTEM_WORK_MARKER.with(|slot| {
                let _ = slot.replace(previous);
            });
        }
    }

    let previous = ACTIVE_SYSTEM_WORK_MARKER.with(|slot| slot.replace(marker));
    let _guard = MarkerGuard(previous);
    operation()
}

pub(crate) fn active_system_work_marker() -> Option<NarrativeSystemWorkMarker> {
    ACTIVE_SYSTEM_WORK_MARKER.with(|slot| slot.borrow().clone())
}

/// A successful automatic adapter must leave its marked Run running until the
/// ordinary foreground write commits. Failures still terminalize immediately;
/// the barrier only spans the successful work/authoring overlap.
pub(crate) fn foreground_system_work_barrier_requested() -> bool {
    active_system_work_marker().is_some()
}

pub(crate) fn spec_with_active_system_work_marker(spec_json: &Value) -> anyhow::Result<Value> {
    let Some(marker) = active_system_work_marker() else {
        return Ok(spec_json.clone());
    };
    marker.validate()?;
    let mut spec = spec_json.as_object().cloned().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_MAINTENANCE_SYSTEM_WORK_SPEC_INVALID: system-work Run spec must be a JSON object"
        )
    })?;
    let marker_value = serde_json::to_value(marker)?;
    if let Some(existing) = spec.get("systemWork") {
        anyhow::ensure!(
            existing == &marker_value,
            "NEX_MAINTENANCE_SYSTEM_WORK_MARKER_CONFLICT: Run systemWork marker is immutable"
        );
    } else {
        spec.insert("systemWork".to_string(), marker_value);
    }
    Ok(Value::Object(spec))
}

/// Product-journey foreground barriers are discovered from durable state only
/// after the native cycle has committed the marked Run.  Matching every
/// immutable marker field, the authority binding, and the canonical work key
/// prevents an unrelated system Run from satisfying the journey assertion.
pub fn find_running_foreground_system_work_run(
    db: &Database,
    config: &NarrativeMaintenanceCiConfig,
    binding: &MaintenanceWorkspaceBinding,
) -> anyhow::Result<Option<ForegroundSystemWorkRun>> {
    config.validate()?;
    binding.validate()?;
    let barrier_id = config
        .product_journey_barrier_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("foreground barrier id is required"))?;
    let correlation = config
        .correlation
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("foreground correlation is required"))?;
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, project_id, run_kind, work_key, semantic_epoch_id, spec_json
               FROM narrative_extraction_runs
              WHERE status = 'running'
                AND run_kind IN ('backfill', 'dependency-verify', 'semantic-index-rebuild')
              ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut matches = Vec::new();
        for row in rows {
            let (run_id, project_id, run_kind, work_key, epoch_id, spec_json) = row?;
            let Some(spec_json) = spec_json else {
                continue;
            };
            let spec: Value = serde_json::from_str(&spec_json).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_SPEC_MALFORMED: Run '{run_id}' has malformed spec_json: {error}"
                )
            })?;
            let Some(marker_value) = spec.get("systemWork") else {
                continue;
            };
            let marker: NarrativeSystemWorkMarker =
                serde_json::from_value(marker_value.clone()).map_err(|error| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_MARKER_MALFORMED: Run '{run_id}' has an invalid systemWork marker: {error}"
                    )
                })?;
            marker.validate()?;
            if marker.product_journey_barrier_id != barrier_id
                || marker.correlation != correlation
                || marker.authority_id != binding.authority_id
                || marker.generation != binding.generation
                || marker.trigger != "workspace-opened"
            {
                continue;
            }
            validate_foreground_run_identity(
                conn,
                &ForegroundSystemWorkRun {
                    run_id: run_id.clone(),
                    project_id: project_id.clone(),
                    marker: marker.clone(),
                },
                &run_kind,
                &work_key,
                epoch_id.as_deref(),
                &spec_json,
                true,
            )?;
            matches.push(ForegroundSystemWorkRun {
                run_id,
                project_id,
                marker,
            });
        }
        anyhow::ensure!(
            matches.len() <= 1,
            "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_NOT_UNIQUE: multiple running Runs matched the exact product-journey barrier"
        );
        Ok(matches.pop())
    })
}

fn automatic_kind_for_run_kind(run_kind: &str) -> anyhow::Result<AutomaticRunKind> {
    match run_kind {
        "backfill" => Ok(AutomaticRunKind::Backfill),
        "dependency-verify" => Ok(AutomaticRunKind::Verify),
        "semantic-index-rebuild" => Ok(AutomaticRunKind::RebuildDerived),
        other => anyhow::bail!(
            "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_RUN_KIND_MISMATCH: unsupported Run kind '{other}'"
        ),
    }
}

fn validate_foreground_run_identity(
    conn: &Connection,
    barrier: &ForegroundSystemWorkRun,
    run_kind: &str,
    work_key: &str,
    epoch_id: Option<&str>,
    spec_json: &str,
    require_current_epoch: bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        barrier.project_id.trim() == barrier.project_id,
        "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_PROJECT_INVALID: project identity is not trimmed"
    );
    let spec: Value = serde_json::from_str(spec_json)?;
    let persisted_marker: NarrativeSystemWorkMarker = serde_json::from_value(
        spec.get("systemWork")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("foreground Run is missing systemWork marker"))?,
    )?;
    persisted_marker.validate()?;
    anyhow::ensure!(
        persisted_marker == barrier.marker,
        "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_MARKER_MISMATCH: immutable marker changed"
    );
    let kind = automatic_kind_for_run_kind(run_kind)?;
    let expected_epochful_key =
        canonical_work_key_for_epoch(&barrier.project_id, kind, work_key, epoch_id)?;
    let expected_epochless_backfill_key =
        canonical_work_key_for_epoch(&barrier.project_id, kind, work_key, None)?;
    anyhow::ensure!(
        persisted_marker.canonical_work_key == expected_epochful_key
            || (kind == AutomaticRunKind::Backfill
                && persisted_marker.canonical_work_key == expected_epochless_backfill_key),
        "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_WORK_KEY_MISMATCH: immutable work identity changed"
    );
    let Some(epoch_id) = epoch_id else {
        anyhow::ensure!(
            kind == AutomaticRunKind::Backfill,
            "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_EPOCH_MISSING: foreground Run is not epoch-bound"
        );
        return Ok(());
    };
    if require_current_epoch {
        let current_epoch_id = super::semantic_epoch::get_current_epoch(conn, &barrier.project_id)?
            .map(|epoch| epoch.id);
        anyhow::ensure!(
            current_epoch_id.as_deref() == Some(epoch_id),
            "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_STALE_EPOCH: foreground Run is not bound to the current Semantic Epoch"
        );
    }
    Ok(())
}

/// Release one exact foreground Run after the ordinary authoring write has
/// committed.  The Run is real durable work: its adapter recorded the native
/// outcome before the barrier, and this owner-only transition supplies the
/// terminal lifecycle timestamp.  A mismatched or unrelated Run fails closed.
pub fn complete_foreground_system_work_run(
    db: &Database,
    barrier: &ForegroundSystemWorkRun,
) -> anyhow::Result<()> {
    barrier.marker.validate()?;
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let row: Option<(String, String, String, String, Option<String>, String)> = conn
                .query_row(
                    "SELECT project_id, run_kind, work_key, status, semantic_epoch_id, spec_json
                       FROM narrative_extraction_runs
                      WHERE id = ?1",
                    params![barrier.run_id],
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
            let Some((project_id, run_kind, work_key, status, epoch_id, spec_json)) = row else {
                anyhow::bail!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_RUN_MISSING: exact foreground Run is not running"
                );
            };
            anyhow::ensure!(
                project_id == barrier.project_id,
                "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_PROJECT_MISMATCH: exact foreground Run belongs to another project"
            );
            anyhow::ensure!(
                status == "running" || status == "completed",
                "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_RUN_MISSING: exact foreground Run is not running or completed"
            );
            validate_foreground_run_identity(
                conn,
                barrier,
                &run_kind,
                &work_key,
                epoch_id.as_deref(),
                &spec_json,
                status == "running",
            )?;
            if status == "completed" {
                // A duplicate release is idempotent only after the complete
                // immutable lifecycle pair has been validated.
                load_completed_maintenance_run_in_tx(conn, &barrier.run_id)?;
                return Ok(());
            }
            let handle = load_maintenance_run_in_tx(conn, &barrier.run_id)?;
            let mut outcome = match conn
                .query_row(
                    "SELECT outcome_summary_json FROM narrative_extraction_runs WHERE id = ?1",
                    params![barrier.run_id],
                    |row| row.get::<_, Option<String>>(0),
                )?
                .as_deref()
            {
                Some(text) => serde_json::from_str::<Value>(text)?,
                None => json!({}),
            };
            let outcome_object = outcome.as_object_mut().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: foreground Run outcome is not an object"
                )
            })?;
            outcome_object.insert(
                "foregroundBarrierReleased".to_string(),
                Value::Bool(true),
            );
            outcome_object.insert(
                "productJourneyBarrierId".to_string(),
                Value::String(barrier.marker.product_journey_barrier_id.clone()),
            );
            outcome_object.insert(
                "correlation".to_string(),
                Value::String(barrier.marker.correlation.clone()),
            );
            super::repository::record_run_outcome_in_tx(conn, &barrier.run_id, &outcome)?;
            let finalized_at = release_foreground_maintenance_run_in_tx(conn, &handle)?;
            if run_kind == VERIFY_RUN_KIND {
                let epoch_id = epoch_id.as_ref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_EPOCH_MISSING: foreground Verify Run is not epoch-bound"
                    )
                })?;
                let report: DependencyGraphVerifyReport = serde_json::from_value(
                    outcome
                        .get("report")
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("foreground Verify outcome has no report"))?,
                )?;
                if report.is_clean() {
                    let report_digest = outcome
                        .get("reportDigest")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            anyhow::anyhow!("foreground Verify outcome has no report digest")
                        })?;
                    let coordinates = current_maintenance_coordinates()?;
                    persist_completed_run_skip_evidence_in_tx(
                        conn,
                        &barrier.run_id,
                        &CompletedRunSkipEvidence {
                            project_id: project_id.clone(),
                            run_kind: VERIFY_RUN_KIND.to_string(),
                            work_key: work_key.clone(),
                            semantic_epoch_id: epoch_id.clone(),
                            graph_contract_digest: coordinates.graph_contract_digest,
                            rule_registry_digest: coordinates.rule_registry_digest,
                            producer_generation_set_digest: coordinates
                                .producer_generation_set_digest,
                            run_kind_contract_version: VERIFY_CONTRACT_VERSION.to_string(),
                            report_digest: report_digest.to_string(),
                        },
                    )?;
                }
            }
            super::terminal_failure::resolve_terminal_failure_for_run_in_tx(
                conn,
                &project_id,
                &barrier.run_id,
                &finalized_at,
            )?;
            Ok(())
        })
    })
}

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

impl MaintenanceWorkspaceBinding {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.authority_id.trim().is_empty(),
            "authorityId is required"
        );
        anyhow::ensure!(
            self.generation > 0 && self.generation <= NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION,
            "generation must be a safe non-zero integer"
        );
        Ok(())
    }
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
    terminal_reason_code: Option<String>,
    completed_at: Option<String>,
    created_at_raw: String,
    started_at_raw: Option<String>,
}

fn load_durable_maintenance_runs(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<DurableMaintenanceRun>> {
    let mut statement = conn.prepare(
        "SELECT id, run_kind, status, spec_json, semantic_epoch_id, work_key,
                outcome_summary_json, created_at, started_at, completed_at,
                terminal_reason_code
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
            row.get::<_, Option<String>>(10)?,
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
            created_at_raw,
            started_at,
            completed_at,
            terminal_reason_code,
        ) = row?;
        let run = DurableMaintenanceRun {
            run_id,
            run_kind,
            status,
            spec_json,
            semantic_epoch_id,
            work_key,
            outcome_summary_json,
            terminal_reason_code,
            completed_at,
            created_at_raw,
            started_at_raw: started_at,
        };
        validate_active_maintenance_run(&run)?;
        runs.push(run);
    }
    Ok(runs)
}

fn validate_active_maintenance_run(run: &DurableMaintenanceRun) -> anyhow::Result<()> {
    if run.run_kind != VERIFY_RUN_KIND || !matches!(run.status.as_str(), "pending" | "running") {
        return Ok(());
    }
    let epoch_id = run
        .semantic_epoch_id
        .as_deref()
        .filter(|value| !value.is_empty());
    anyhow::ensure!(
        epoch_id.is_some(),
        "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Verify Run '{}' has no Semantic Epoch",
        run.run_id
    );
    let work_key = run.work_key.as_deref().filter(|value| !value.is_empty());
    anyhow::ensure!(
        work_key.is_some(),
        "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Verify Run '{}' has no workKey",
        run.run_id
    );
    let expected = format!("{VERIFY_WORK_KEY_PREFIX}{}", epoch_id.unwrap_or_default());
    anyhow::ensure!(
        work_key == Some(expected.as_str()),
        "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Verify Run '{}' workKey does not match its Semantic Epoch",
        run.run_id
    );
    Ok(())
}

fn is_canonical_maintenance_work(run: &DurableMaintenanceRun) -> bool {
    if !matches!(
        run.status.as_str(),
        "pending" | "running" | "completed" | "failed" | "cancelled"
    ) {
        return false;
    }
    match run.run_kind.as_str() {
        "backfill" => run.work_key.as_deref() == Some(LEGACY_BACKFILL_WORK_KEY),
        VERIFY_RUN_KIND => run
            .semantic_epoch_id
            .as_deref()
            .zip(run.work_key.as_deref())
            .is_some_and(|(epoch_id, work_key)| {
                !epoch_id.is_empty() && work_key == format!("{VERIFY_WORK_KEY_PREFIX}{epoch_id}")
            }),
        "semantic-index-rebuild" => {
            run.semantic_epoch_id
                .as_deref()
                .is_some_and(|epoch_id| !epoch_id.is_empty())
                && run.work_key.as_deref() == Some(REBUILD_DERIVED_WORK_KEY)
        }
        _ => false,
    }
}

fn validate_relevant_run_timestamp(
    run: &DurableMaintenanceRun,
    field: &str,
    value: Option<&str>,
    required: bool,
) -> anyhow::Result<()> {
    let Some(value) = value else {
        anyhow::ensure!(
            !required,
            "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' is missing {field}",
            run.run_id
        );
        return Ok(());
    };
    if parse_maintenance_instant(value).is_err() {
        anyhow::bail!(
            "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' has an unsupported {field}",
            run.run_id
        );
    }
    Ok(())
}

const RETRYABLE_NULL_TERMINAL_REASON: &str = "NEX_MAINTENANCE_SQLITE_LOCKED";

fn is_retryable_failed_backfill_without_terminal(run: &DurableMaintenanceRun) -> bool {
    run.run_kind == "backfill"
        && run.status == "failed"
        && run.started_at_raw.is_none()
        && run.completed_at.is_none()
        && run.terminal_reason_code.as_deref() == Some(RETRYABLE_NULL_TERMINAL_REASON)
}

/// Validate lifecycle shape only after project, coordinate, and status
/// relevance has selected the discovery window. This keeps malformed rows
/// from an unrelated epoch from poisoning a current candidate while making
/// malformed current active/terminal state fail closed.
fn validate_relevant_maintenance_run_lifecycle(run: &DurableMaintenanceRun) -> anyhow::Result<()> {
    validate_relevant_run_timestamp(run, "created_at", Some(&run.created_at_raw), true)?;

    match run.status.as_str() {
        "pending" => {
            anyhow::ensure!(
                run.started_at_raw.is_none(),
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: pending Run '{}' has a started_at",
                run.run_id
            );
            anyhow::ensure!(
                run.completed_at.is_none(),
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: pending Run '{}' has a terminal completed_at",
                run.run_id
            );
        }
        "running" => {
            validate_relevant_run_timestamp(
                run,
                "started_at",
                run.started_at_raw.as_deref(),
                true,
            )?;
            anyhow::ensure!(
                run.completed_at.is_none(),
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: running Run '{}' has a terminal completed_at",
                run.run_id
            );
        }
        "completed" | "failed" | "cancelled" => {
            // Backfill's completion marker has an intentionally stricter
            // shared validator. A malformed/missing terminal timestamp must
            // remain rerunnable so discovery can compare its valid
            // created_at/started_at against a fresh retry and fail closed
            // only if the malformed marker is still maximal. A failed
            // Backfill with the recognized retryable lock disposition is the
            // other permitted NULL-terminal shape; it is a retry candidate,
            // not reusable terminal evidence.
            let allows_missing_terminal = (run.run_kind == "backfill" && run.status == "completed")
                || is_retryable_failed_backfill_without_terminal(run);
            if !allows_missing_terminal {
                validate_relevant_run_timestamp(
                    run,
                    "completed_at",
                    run.completed_at.as_deref(),
                    true,
                )?;
            }
            validate_relevant_run_timestamp(
                run,
                "started_at",
                run.started_at_raw.as_deref(),
                false,
            )?;
        }
        _ => {}
    }
    Ok(())
}

/// Select a unique maximal lifecycle candidate from one discovery window.
/// When current-epoch rows exist, older epochs are outside that window; they
/// may still be terminal evidence (for example a historical Backfill marker)
/// but must not make a unique current candidate ambiguous. If no current-epoch
/// row exists, the available historical rows form the fallback window.
fn select_latest_relevant_run(
    runs: &[DurableMaintenanceRun],
    current_epoch_id: Option<&str>,
    allow_historical_fallback: bool,
    predicate: impl Fn(&DurableMaintenanceRun) -> bool,
) -> anyhow::Result<Option<DurableMaintenanceRun>> {
    let candidates: Vec<&DurableMaintenanceRun> = runs
        .iter()
        .filter(|run| is_canonical_maintenance_work(run) && predicate(run))
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    let current_candidates: Vec<&DurableMaintenanceRun> = current_epoch_id
        .map(|epoch_id| {
            candidates
                .iter()
                .copied()
                .filter(|run| run.semantic_epoch_id.as_deref() == Some(epoch_id))
                .collect()
        })
        .unwrap_or_default();
    let relevant = if current_candidates.is_empty()
        && (allow_historical_fallback || current_epoch_id.is_none())
    {
        candidates
    } else {
        current_candidates
    };
    if relevant.is_empty() {
        return Ok(None);
    }
    for run in &relevant {
        validate_relevant_maintenance_run_lifecycle(run)?;
    }
    // Terminal recovery can finish an interrupted row and create its fresh
    // replacement within one millisecond. Use the row's creation instant as
    // causal chronology before declaring a genuine lifecycle tie; UUIDs never
    // participate in this ordering.
    let mut temporal = Vec::with_capacity(relevant.len());
    for run in relevant {
        let created_at = parse_maintenance_instant(&run.created_at_raw)?;
        let mut lifecycle_instants = vec![created_at];
        let mut lifecycle_timestamp_invalid = false;
        if let Some(completed_at) = run.completed_at.as_deref() {
            match parse_maintenance_instant(completed_at) {
                Ok(completed_at) => lifecycle_instants.push(completed_at),
                Err(_) => lifecycle_timestamp_invalid = true,
            }
        } else if run.status == "completed" {
            lifecycle_timestamp_invalid = true;
        }
        if let Some(started_at) = run.started_at_raw.as_deref() {
            if let Ok(started_at) = parse_maintenance_instant(started_at) {
                lifecycle_instants.push(started_at);
            }
        }
        let lifecycle_at = lifecycle_instants
            .into_iter()
            .max()
            .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_RUN_ORDER_EMPTY"))?;
        temporal.push((lifecycle_at, created_at, run, lifecycle_timestamp_invalid));
    }
    let max_lifecycle = temporal
        .iter()
        .map(|(lifecycle_at, created_at, _, _)| (*lifecycle_at, *created_at))
        .max()
        .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_RUN_ORDER_EMPTY"))?;
    let maximal: Vec<(&DurableMaintenanceRun, bool)> = temporal
        .into_iter()
        .filter(|(lifecycle_at, created_at, _, _)| (*lifecycle_at, *created_at) == max_lifecycle)
        .map(|(_, _, run, lifecycle_timestamp_invalid)| (run, lifecycle_timestamp_invalid))
        .collect();
    let maximal_ids = maximal
        .iter()
        .map(|(run, _)| run.run_id.as_str())
        .collect::<Vec<_>>();
    anyhow::ensure!(
        maximal.len() == 1,
        "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS: runs {:?} share lifecycle instant {} in the relevant discovery window",
        maximal_ids,
        max_lifecycle.0.to_rfc3339()
    );
    if let Some((run, true)) = maximal.iter().find(|(_, invalid)| *invalid) {
        if let Some(completed_at) = run.completed_at.as_deref() {
            parse_maintenance_instant(completed_at)?;
        }
        anyhow::bail!(
            "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' has no supported completed_at",
            run.run_id
        );
    }
    Ok(maximal.first().map(|(run, _)| (*run).clone()))
}

fn is_completed_backfill_marker(
    conn: &Connection,
    project_id: &str,
    run: &DurableMaintenanceRun,
) -> anyhow::Result<bool> {
    is_valid_completed_backfill_marker(
        conn,
        project_id,
        &CompletedBackfillMarker {
            run_kind: &run.run_kind,
            status: &run.status,
            spec_json: run.spec_json.as_deref(),
            semantic_epoch_id: run.semantic_epoch_id.as_deref(),
            work_key: run.work_key.as_deref(),
            completed_at: run.completed_at.as_deref(),
            outcome_summary_json: run.outcome_summary_json.as_deref(),
        },
    )
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
        let mut completed_backfill = None;
        for run in &runs {
            if is_completed_backfill_marker(conn, &project_id, run)? {
                completed_backfill = Some(run.clone());
                break;
            }
        }
        let active = select_latest_relevant_run(&runs, current_epoch_id.as_deref(), true, |run| {
            matches!(run.status.as_str(), "pending" | "running")
        })?;
        // Once a current epoch exists, a current Backfill marker is the
        // deterministic boundary. Historical Verify/Rebuild rows are not a
        // fallback state machine for that new epoch. Before that boundary,
        // still inspect canonical non-Backfill rows so a malformed maximal
        // Verify candidate fails closed; malformed Backfill rows themselves
        // are intentionally rerunnable.
        let latest =
            select_latest_relevant_run(&runs, current_epoch_id.as_deref(), false, |run| {
                completed_backfill.is_some() || run.run_kind != "backfill"
            })?;
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
    run_system_work_cycle_with_modes_and_config(db, request, mode_for, None)
}

/// Execute a cycle with the optional main-only product-journey context. The
/// context is consumed only for the first newly-created Run in this cycle;
/// follow-up Verify/Rebuild rows are ordinary durable phase rows and must not
/// inherit a foreground barrier marker.
pub fn run_system_work_cycle_with_modes_and_config(
    db: &Database,
    request: &MaintenanceCycleRequest,
    mode_for: impl Fn(&DesiredWork) -> RecoveryMode,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
) -> anyhow::Result<MaintenanceCycleResult> {
    if let Some(binding) = request.workspace_binding.as_ref() {
        binding.validate()?;
    }
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
    let mut dequeue_count = 0usize;
    let mut dispatched_any = false;
    let mut coalesced_active = false;
    let mut has_more = false;
    let mut foreground_marker_available = true;
    // Only the exact foreground Run created by this cycle may suppress its
    // same-key rediscovery. A canonical-key-only set would also suppress the
    // ordinary Verify confirmation after a Verify -> Rebuild phase chain.
    // The durable lookup below keeps this ownership bounded to the marked Run
    // while it is still running; pre-existing active rows remain subject to
    // the caller-selected StartupRecovery/SameProcessLive mode.
    let mut foreground_owned_run: Option<ForegroundSystemWorkRun> = None;
    let mut project_ids = BTreeSet::new();
    while let Some(item) = queue.pop_front() {
        project_ids.insert(item.project_id.clone());
        // Bound both actual adapter dispatch and dequeue/recovery progress.
        // Follow-up discovery can enqueue more work without incrementing the
        // dequeue bound; limiting only dispatches would let malformed durable
        // rows spin forever before the boundary is reached.
        if dequeue_count >= MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE {
            has_more = true;
            break;
        }
        dequeue_count += 1;

        let foreground_run_is_held = if let Some(owned) = foreground_owned_run.as_ref() {
            if owned.project_id != item.project_id
                || owned.marker.canonical_work_key != item.canonical_key()
            {
                false
            } else if let (Some(config), Some(binding)) =
                (ci_config.as_ref(), request.workspace_binding.as_ref())
            {
                find_running_foreground_system_work_run(db, config, binding)?
                    .as_ref()
                    .is_some_and(|current| current == owned)
            } else {
                false
            }
        } else {
            false
        };
        if foreground_run_is_held {
            // The exact marked Run is still durable and running. Do not feed
            // it back through StartupRecovery before the N-API cycle ACK.
            continue;
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
                let marker = if foreground_marker_available {
                    ci_config.and_then(|config| {
                        request
                            .workspace_binding
                            .as_ref()
                            .and_then(|binding| config.foreground_marker(&item, binding))
                    })
                } else {
                    None
                };
                with_system_work_marker(marker.clone(), || dispatch_enabled_work(db, &item))?;
                if let (Some(expected_marker), Some(config), Some(binding)) = (
                    marker.as_ref(),
                    ci_config.as_ref(),
                    request.workspace_binding.as_ref(),
                ) {
                    if let Some(created) =
                        find_running_foreground_system_work_run(db, config, binding)?
                    {
                        anyhow::ensure!(
                            created.project_id == item.project_id
                                && created.marker == *expected_marker
                                && created.marker.canonical_work_key == item.canonical_key(),
                            "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_DISPATCH_MISMATCH: marked Run does not match the dispatched WorkKey"
                        );
                        foreground_owned_run = Some(created);
                    }
                }
                if marker.is_some() {
                    foreground_marker_available = false;
                }
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
    // Validate every persisted active Verify row before the requested WorkKey
    // is used for recovery. A malformed row must not disappear merely because
    // its work key fails canonical filtering and thereby permit a duplicate
    // adapter dispatch.
    db.with_conn(|conn| load_durable_maintenance_runs(conn, &item.project_id).map(|_| ()))?;
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
    let explicit_code = message
        .split(|character: char| character == ':' || character.is_whitespace())
        .find(|token| token.starts_with("NEX_"));
    if explicit_code == Some("NEX_MAINTENANCE_INTERRUPTED") {
        return FailureClassification {
            class: FailureClass::Transient,
            code: "NEX_MAINTENANCE_INTERRUPTED".to_string(),
            retryable: true,
        };
    }
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

    let code = explicit_code
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
            if !matches!(
                status.as_str(),
                "pending" | "running" | "completed" | "failed" | "cancelled"
            ) {
                continue;
            }
            let epoch_matches = expected_semantic_epoch_id
                .map(|expected| row_epoch_id.as_deref() == Some(expected))
                .unwrap_or(true);
            if !epoch_matches {
                if matches!(status.as_str(), "pending" | "running") {
                    stale_active_runs.push(StaleActiveRun {
                        run_id: id,
                        semantic_epoch_id: row_epoch_id,
                    });
                }
                continue;
            }
            let lifecycle_raw = completed_at
                .as_deref()
                .or(started_at.as_deref())
                .unwrap_or(created_at.as_str());
            let lifecycle_at = match parse_maintenance_instant(lifecycle_raw) {
                Ok(lifecycle_at) => lifecycle_at,
                Err(_error)
                    if work.run_kind == AutomaticRunKind::Backfill && status == "completed" =>
                {
                    let fallback_raw = started_at.as_deref().unwrap_or(created_at.as_str());
                    parse_maintenance_instant(fallback_raw)?
                }
                Err(error) => {
                    return Err(error);
                }
            };
            current_rows.push((lifecycle_at, id, status, terminal_reason_code));
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

/// Check the same strict Backfill completion marker used by durable
/// discovery. Generic Run-ledger counts intentionally include malformed
/// terminal rows for diagnostics, but recovery must not treat those rows as a
/// completed once-boundary or it can rediscover the same work forever.
fn has_valid_completed_backfill_marker(
    db: &Database,
    work: &WorkKey,
    expected_semantic_epoch_id: Option<&str>,
) -> anyhow::Result<bool> {
    if work.run_kind != AutomaticRunKind::Backfill || work.work_key != LEGACY_BACKFILL_WORK_KEY {
        return Ok(false);
    }
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT run_kind, status, spec_json, semantic_epoch_id, work_key,
                    completed_at, outcome_summary_json
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3
                AND status = 'completed'",
        )?;
        let rows = statement.query_map(
            params![work.project_id, work.run_kind.as_str(), work.work_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )?;
        for row in rows {
            let (run_kind, status, spec_json, epoch_id, work_key, completed_at, outcome_json) =
                row?;
            if expected_semantic_epoch_id
                .is_some_and(|expected| epoch_id.as_deref() != Some(expected))
            {
                continue;
            }
            if is_valid_completed_backfill_marker(
                conn,
                &work.project_id,
                &CompletedBackfillMarker {
                    run_kind: &run_kind,
                    status: &status,
                    spec_json: spec_json.as_deref(),
                    semantic_epoch_id: epoch_id.as_deref(),
                    work_key: work_key.as_deref(),
                    completed_at: completed_at.as_deref(),
                    outcome_summary_json: outcome_json.as_deref(),
                },
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    })
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
    let has_valid_backfill_marker =
        has_valid_completed_backfill_marker(db, work, expected_semantic_epoch_id)?;
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
        && has_valid_backfill_marker
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
/// The operation is one IMMEDIATE transaction. Running maintenance rows are
/// terminalized through their owned Task/Attempt pair; pending compatibility
/// rows are cancelled at Run level because they have not started an Attempt.
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
                match status {
                    NarrativeRunStatus::Running => {
                        result.failed_run_ids.push(run_id.clone());
                        let handle = load_or_synthesize_recovery_lifecycle_in_tx(conn, &run_id)?;
                        fail_maintenance_run_in_tx(
                            conn,
                            &handle,
                            MaintenanceFailureKind::Interrupted,
                            "NEX_MAINTENANCE_INTERRUPTED: process interruption",
                        )?;
                    }
                    NarrativeRunStatus::Pending => {
                        ensure_recovery_lifecycle_is_empty_in_tx(conn, &run_id)?;
                        result.cancelled_pending_run_ids.push(run_id.clone());
                        transition_run_status_in_tx(conn, &run_id, NarrativeRunStatus::Cancelled)?;
                        anyhow::ensure!(
                            conn.execute(
                                "UPDATE narrative_extraction_runs
                                    SET terminal_reason_code = 'NEX_MAINTENANCE_INTERRUPTED'
                                  WHERE id = ?1 AND status = 'cancelled'",
                                params![run_id],
                            )? == 1,
                            "run terminalization lost its row: '{run_id}'"
                        );
                    }
                    _ => unreachable!("active status was validated above"),
                }
            }
            Ok(result)
        })
    })
}

fn load_or_synthesize_recovery_lifecycle_in_tx(
    conn: &Connection,
    run_id: &str,
) -> anyhow::Result<MaintenanceRunHandle> {
    let strict_error = match load_maintenance_run_in_tx(conn, run_id) {
        Ok(handle) => return Ok(handle),
        Err(error) => error,
    };
    let task_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    let attempt_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_attempts a
           JOIN narrative_extraction_tasks t ON t.id = a.task_id
          WHERE t.run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    if task_count != 0 || attempt_count != 0 {
        return Err(strict_error);
    }
    synthesize_recovery_lifecycle_in_tx(conn, run_id)
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
    use crate::narrative_extraction::execution_state::{
        transition_run_status_in_tx, NarrativeRunStatus,
    };
    use crate::narrative_extraction::legacy_backfill::LEGACY_BACKFILL_ALGORITHM_VERSION;
    use crate::narrative_extraction::repository::{create_system_run_in_tx, SystemRunWorkKeyReuse};
    use crate::narrative_extraction::restore_rebuild::DependencyGraphVerifyReport;
    use crate::Database;
    use rusqlite::params;
    use serde_json::json;

    fn recovery_work(kind: AutomaticRunKind, epoch_id: &str) -> WorkKey {
        let work_key = match kind {
            AutomaticRunKind::Backfill => LEGACY_BACKFILL_WORK_KEY.to_owned(),
            AutomaticRunKind::Verify => format!("{VERIFY_WORK_KEY_PREFIX}{epoch_id}"),
            AutomaticRunKind::RebuildDerived => REBUILD_DERIVED_WORK_KEY.to_owned(),
        };
        WorkKey::new_for_epoch("project-1", kind, work_key, epoch_id).expect("recovery work")
    }

    fn recovery_spec(kind: AutomaticRunKind) -> &'static str {
        match kind {
            AutomaticRunKind::Backfill => r#"{"backfillAlgorithmVersion":"2"}"#,
            AutomaticRunKind::Verify => r#"{"verifyContractVersion":"6"}"#,
            AutomaticRunKind::RebuildDerived => "{}",
        }
    }

    fn recovery_task_kind(kind: AutomaticRunKind) -> &'static str {
        match kind {
            AutomaticRunKind::Backfill => "maintenance-backfill",
            AutomaticRunKind::Verify => "maintenance-dependency-verify",
            AutomaticRunKind::RebuildDerived => "maintenance-semantic-index-rebuild",
        }
    }

    fn open_pending_recovery_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-current', 'project-1', 0, 'initial',
                         '2026-01-01T00:00:00.000Z'),
                        ('epoch-stale', 'project-1', 1, 'restore',
                         '2026-01-02T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed pending recovery project");
        db
    }

    fn insert_pending_recovery_run(
        conn: &rusqlite::Connection,
        run_id: &str,
        kind: AutomaticRunKind,
        epoch_id: &str,
        work_key: &str,
    ) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at, completed_at, version,
                 run_kind, semantic_epoch_id, work_key)
             VALUES (?1, 'project-1', 'maintenance', '{}', ?2, ?3,
                     'pending', '{}', '2026-01-03T00:00:00.000Z', NULL, NULL, 0,
                     ?4, ?5, ?6)",
            params![
                run_id,
                recovery_spec(kind),
                format!("digest:{run_id}"),
                kind.as_str(),
                epoch_id,
                work_key,
            ],
        )?;
        Ok(())
    }

    fn insert_recovery_children(
        conn: &rusqlite::Connection,
        run_id: &str,
        kind: AutomaticRunKind,
        with_attempt: bool,
    ) -> anyhow::Result<()> {
        let task_id = format!("task-{run_id}");
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, priority, attempt_count,
                 created_at, started_at, version)
             VALUES (?1, ?2, ?3, 'running', ?4, 0, ?5,
                     '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 0)",
            params![
                task_id,
                run_id,
                recovery_task_kind(kind),
                recovery_spec(kind),
                if with_attempt { 1 } else { 0 },
            ],
        )?;
        if with_attempt {
            conn.execute(
                "INSERT INTO narrative_extraction_attempts
                    (id, task_id, attempt_number, status, started_at)
                 VALUES (?1, ?2, 1, 'running', '2026-01-03T00:00:00.000Z')",
                params![format!("attempt-{run_id}"), task_id],
            )?;
        }
        Ok(())
    }

    fn recovery_shape(
        conn: &rusqlite::Connection,
        run_id: &str,
    ) -> anyhow::Result<(String, i64, i64)> {
        let status = conn.query_row(
            "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        let task_count = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        let attempt_count = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_extraction_attempts a
               JOIN narrative_extraction_tasks t ON t.id = a.task_id
              WHERE t.run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        Ok((status, task_count, attempt_count))
    }

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
    fn pending_interrupted_recovery_accepts_canonical_zero_child_runs_for_all_kinds() {
        for kind in AutomaticRunKind::all() {
            for stale in [false, true] {
                let db = open_pending_recovery_db();
                let run_id = format!("pending-{}-{}", kind.as_str(), stale);
                let work = recovery_work(kind, "epoch-current");
                let row_epoch = if stale {
                    "epoch-stale"
                } else {
                    "epoch-current"
                };
                db.with_conn(|conn| {
                    insert_pending_recovery_run(conn, &run_id, kind, row_epoch, &work.work_key)
                })
                .expect("seed canonical pending run");

                let result = if stale {
                    terminalize_stale_interrupted_runs_for_epoch(
                        &db,
                        "project-1",
                        &work,
                        "epoch-current",
                        &[StaleActiveRun {
                            run_id: run_id.clone(),
                            semantic_epoch_id: Some("epoch-stale".to_owned()),
                        }],
                    )
                } else {
                    terminalize_interrupted_runs_for_epoch(
                        &db,
                        "project-1",
                        &work,
                        Some("epoch-current"),
                        std::slice::from_ref(&run_id),
                    )
                };
                let result = result.expect("canonical pending recovery succeeds");
                assert_eq!(result.failed_run_ids, Vec::<String>::new());
                assert_eq!(result.cancelled_pending_run_ids, vec![run_id.clone()]);
                db.with_conn(|conn| {
                    let (status, task_count, attempt_count) = recovery_shape(conn, &run_id)?;
                    assert_eq!(status, "cancelled");
                    assert_eq!(task_count, 0);
                    assert_eq!(attempt_count, 0);
                    Ok(())
                })
                .expect("inspect canonical pending recovery");
            }
        }
    }

    #[test]
    fn pending_interrupted_recovery_rejects_owned_children_and_rolls_back_batch() {
        for kind in AutomaticRunKind::all() {
            for stale in [false, true] {
                for with_attempt in [false, true] {
                    let db = open_pending_recovery_db();
                    let valid_id = format!("valid-{}-{}-{}", kind.as_str(), stale, with_attempt);
                    let malformed_id =
                        format!("malformed-{}-{}-{}", kind.as_str(), stale, with_attempt);
                    let work = recovery_work(kind, "epoch-current");
                    let row_epoch = if stale {
                        "epoch-stale"
                    } else {
                        "epoch-current"
                    };
                    db.with_conn(|conn| {
                        insert_pending_recovery_run(
                            conn,
                            &valid_id,
                            kind,
                            row_epoch,
                            &work.work_key,
                        )?;
                        insert_pending_recovery_run(
                            conn,
                            &malformed_id,
                            kind,
                            row_epoch,
                            &work.work_key,
                        )?;
                        insert_recovery_children(conn, &malformed_id, kind, with_attempt)
                    })
                    .expect("seed malformed pending batch");

                    let result = if stale {
                        terminalize_stale_interrupted_runs_for_epoch(
                            &db,
                            "project-1",
                            &work,
                            "epoch-current",
                            &[
                                StaleActiveRun {
                                    run_id: valid_id.clone(),
                                    semantic_epoch_id: Some("epoch-stale".to_owned()),
                                },
                                StaleActiveRun {
                                    run_id: malformed_id.clone(),
                                    semantic_epoch_id: Some("epoch-stale".to_owned()),
                                },
                            ],
                        )
                    } else {
                        terminalize_interrupted_runs_for_epoch(
                            &db,
                            "project-1",
                            &work,
                            Some("epoch-current"),
                            &[valid_id.clone(), malformed_id.clone()],
                        )
                    };
                    let error = result.expect_err("owned pending children must be rejected");
                    assert!(
                        error
                            .to_string()
                            .contains("NEX_MAINTENANCE_LIFECYCLE_OWNERSHIP_INVALID"),
                        "unexpected error: {error:#}"
                    );
                    db.with_conn(|conn| {
                        let (valid_status, valid_tasks, valid_attempts) =
                            recovery_shape(conn, &valid_id)?;
                        assert_eq!(valid_status, "pending");
                        assert_eq!(valid_tasks, 0);
                        assert_eq!(valid_attempts, 0);
                        let (malformed_status, malformed_tasks, malformed_attempts) =
                            recovery_shape(conn, &malformed_id)?;
                        assert_eq!(malformed_status, "pending");
                        assert_eq!(malformed_tasks, 1);
                        assert_eq!(malformed_attempts, if with_attempt { 1 } else { 0 });
                        Ok(())
                    })
                    .expect("malformed pending recovery rolls back all mutations");
                }
            }
        }
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

    #[test]
    fn product_journey_marker_has_exact_native_owned_shape() {
        let config = NarrativeMaintenanceCiConfig {
            is_packaged: false,
            ci: "true".to_string(),
            owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
            fault: None,
            trigger: Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake),
            setup: None,
            product_journey_barrier_id: Some("barrier-1".to_string()),
            correlation: Some("correlation-1".to_string()),
        };
        let work = DesiredWork::new(
            "project-1",
            AutomaticRunKind::Backfill,
            LEGACY_BACKFILL_WORK_KEY,
            "workspace-opened",
        )
        .expect("desired work");
        let marker = config
            .foreground_marker(
                &work,
                &MaintenanceWorkspaceBinding {
                    authority_id: "authority:workspace-1".to_string(),
                    generation: 7,
                },
            )
            .expect("foreground marker");
        let value = serde_json::to_value(&marker).expect("marker JSON");
        let mut keys = value
            .as_object()
            .expect("marker object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "authorityId",
                "canonicalWorkKey",
                "correlation",
                "generation",
                "productJourneyBarrierId",
                "trigger",
            ]
        );
        assert_eq!(marker.trigger, "workspace-opened");
        assert_eq!(
            marker.canonical_work_key,
            "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v2"
        );
    }

    #[test]
    fn conflicting_system_work_marker_is_rejected_before_run_insert() {
        let marker = NarrativeSystemWorkMarker {
            trigger: "workspace-opened".to_string(),
            canonical_work_key: "narrative-maintenance:v1/backfill/project-1/work".to_string(),
            authority_id: "authority:workspace-1".to_string(),
            generation: 1,
            product_journey_barrier_id: "barrier-1".to_string(),
            correlation: "correlation-1".to_string(),
        };
        let error = with_system_work_marker(Some(marker), || {
            spec_with_active_system_work_marker(&json!({
                "systemWork": {
                    "trigger": "workspace-opened",
                    "canonicalWorkKey": "unrelated",
                    "authorityId": "authority:workspace-1",
                    "generation": 1,
                    "productJourneyBarrierId": "barrier-1",
                    "correlation": "correlation-1"
                }
            }))
        })
        .expect_err("a caller-provided conflicting marker must fail closed");
        assert!(error.to_string().contains("MARKER_CONFLICT"));
    }

    #[test]
    fn unrelated_running_run_cannot_satisfy_exact_foreground_barrier() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        let config = NarrativeMaintenanceCiConfig {
            is_packaged: false,
            ci: "true".to_string(),
            owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
            fault: None,
            trigger: Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake),
            setup: None,
            product_journey_barrier_id: Some("barrier-expected".to_string()),
            correlation: Some("correlation-expected".to_string()),
        };
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority:workspace-1".to_string(),
            generation: 1,
        };
        let unrelated = NarrativeSystemWorkMarker {
            trigger: "workspace-opened".to_string(),
            canonical_work_key: "narrative-maintenance:v1/backfill/project-1/unrelated".to_string(),
            authority_id: binding.authority_id.clone(),
            generation: binding.generation,
            product_journey_barrier_id: "barrier-other".to_string(),
            correlation: "correlation-other".to_string(),
        };
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'project-1', 0, 'initial',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project authority");
        with_system_work_marker(Some(unrelated), || {
            db.with_conn(|conn| {
                create_system_run_in_tx(
                    conn,
                    "project-1",
                    "backfill",
                    "epoch-1",
                    "unrelated",
                    &json!({ "phase": "foreground-test" }),
                    "sha256:test",
                    SystemRunWorkKeyReuse::None,
                    None,
                )
            })
        })
        .expect("insert unrelated real running Run");
        assert!(
            find_running_foreground_system_work_run(&db, &config, &binding)
                .expect("barrier lookup")
                .is_none(),
            "a different barrier/correlation must not satisfy the foreground journey"
        );
    }

    #[test]
    fn foreground_verify_stays_running_until_exact_release_then_seals_skip_evidence() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'project-1', 0, 'initial',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project and current epoch");

        let marker = NarrativeSystemWorkMarker {
            trigger: "workspace-opened".to_string(),
            canonical_work_key: canonical_work_key_for_epoch(
                "project-1",
                AutomaticRunKind::Verify,
                "dependency-verify:epoch-1",
                Some("epoch-1"),
            )
            .expect("canonical Verify work key"),
            authority_id: "authority:workspace-1".to_string(),
            generation: 1,
            product_journey_barrier_id: "barrier-verify".to_string(),
            correlation: "correlation-verify".to_string(),
        };

        let outcome = with_system_work_marker(Some(marker.clone()), || {
            run_dependency_verify_for_project(&db, "project-1")
        })
        .expect("foreground Verify should record its real outcome");
        let status_before_release: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                    params![outcome.run_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read held Verify status");
        assert_eq!(status_before_release, "running");

        let barrier = ForegroundSystemWorkRun {
            run_id: outcome.run_id.clone(),
            project_id: "project-1".to_string(),
            marker,
        };
        complete_foreground_system_work_run(&db, &barrier)
            .expect("exact foreground barrier release");

        let (status_after_release, outcome_json): (String, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status, outcome_summary_json
                       FROM narrative_extraction_runs WHERE id = ?1",
                    params![outcome.run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("read completed Verify outcome");
        assert_eq!(status_after_release, "completed");
        let outcome_json: Value = serde_json::from_str(&outcome_json).expect("outcome JSON");
        assert_eq!(
            outcome_json
                .get("foregroundBarrierReleased")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(outcome_json.get("skipEvidence").is_some());

        let coordinates = current_maintenance_coordinates().expect("maintenance coordinates");
        let expected = CompletedRunSkipExpectation {
            project_id: "project-1".to_string(),
            run_kind: VERIFY_RUN_KIND.to_string(),
            work_key: "dependency-verify:epoch-1".to_string(),
            semantic_epoch_id: "epoch-1".to_string(),
            graph_contract_digest: coordinates.graph_contract_digest,
            rule_registry_digest: coordinates.rule_registry_digest,
            producer_generation_set_digest: coordinates.producer_generation_set_digest,
            run_kind_contract_version: VERIFY_CONTRACT_VERSION.to_string(),
            report_digest: Some(outcome.report_digest),
        };
        let decision = db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &expected))
            .expect("evaluate released Verify evidence");
        assert!(matches!(decision, CompletedRunSkipDecision::Skip { .. }));

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                 (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-2', 'project-1', 1, 'manual-rebuild',
                         '2026-01-02T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("rotate the current Semantic Epoch after completion");
        complete_foreground_system_work_run(&db, &barrier)
            .expect("duplicate exact release remains idempotent after epoch rotation");
        let mut wrong_project = barrier.clone();
        wrong_project.project_id = "project-2".to_string();
        assert!(complete_foreground_system_work_run(&db, &wrong_project).is_err());
        let mut wrong_authority = barrier.clone();
        wrong_authority.marker.authority_id = "authority:workspace-2".to_string();
        assert!(complete_foreground_system_work_run(&db, &wrong_authority).is_err());
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed'
                  WHERE task_id IN (
                        SELECT id FROM narrative_extraction_tasks WHERE run_id = ?1
                  )",
                params![barrier.run_id],
            )?;
            Ok(())
        })
        .expect("corrupt the completed Attempt for idempotence coverage");
        assert!(
            complete_foreground_system_work_run(&db, &barrier).is_err(),
            "duplicate release must reject a completed Run whose Attempt pair was corrupted"
        );
    }

    #[test]
    fn rediscovery_orders_new_terminal_run_after_imported_future_run() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'project-1', 0, 'initial',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, outcome_summary_json, created_at, completed_at,
                     run_kind, semantic_epoch_id, work_key)
                 VALUES ('backfill-complete', 'project-1', 'maintenance', ?1, ?1,
                         'sha256:backfill', 'completed', '{}', ?2,
                         '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
                         'backfill', 'epoch-1', ?3)",
                params![
                    json!({
                        "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION
                    })
                    .to_string(),
                    json!({
                        "maintenancePhase": "backfill-complete",
                        "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION,
                        "semanticEpochId": "epoch-1",
                        "summary": {
                            "epoch_created": true,
                            "contributions_created": 0,
                            "edges_created": 0,
                            "applications_without_run_id": 0
                        }
                    })
                    .to_string(),
                    LEGACY_BACKFILL_WORK_KEY,
                ],
            )?;
            let future_report = serde_json::to_value(DependencyGraphVerifyReport {
                rebuild_required: true,
                ..DependencyGraphVerifyReport::default()
            })?;
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, outcome_summary_json, created_at, completed_at,
                     run_kind, semantic_epoch_id, work_key)
                 VALUES ('imported-future-verify', 'project-1', 'maintenance', '{}', '{}',
                         'sha256:verify', 'completed', '{}', ?1,
                         '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
                         'dependency-verify', 'epoch-1', 'dependency-verify:epoch-1')",
                params![json!({ "report": future_report }).to_string()],
            )?;
            let created = create_system_run_in_tx(
                conn,
                "project-1",
                "semantic-index-rebuild",
                "epoch-1",
                REBUILD_DERIVED_WORK_KEY,
                &json!({}),
                "sha256:rebuild",
                SystemRunWorkKeyReuse::None,
                None,
            )?;
            let run_id = created["runId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("created Run has no id"))?;
            transition_run_status_in_tx(conn, run_id, NarrativeRunStatus::Completed)?;
            Ok(())
        })
        .expect("seed imported and newly completed maintenance Runs");

        let next = discover_durable_maintenance_work(&db, "project-1", "durable-wake")
            .expect("rediscover next maintenance phase")
            .expect("completed rebuild must request confirmation Verify");
        assert_eq!(next.run_kind, AutomaticRunKind::Verify);
        assert_eq!(next.semantic_epoch_id.as_deref(), Some("epoch-1"));
    }
}
