//! Durable coordinator and phase owner for Narrative Maintenance (C2-5B).
//!
//! Rust owns discovery, recovery, and bounded dispatch of the automatic
//! Backfill -> Verify -> conditional Rebuild -> confirmation Verify state
//! machine. Electron only wakes this owner and supplies the pinned live
//! `Database`; Repair remains a human/manual path.

use anyhow::Context;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use super::commit::digest_plan;
use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::legacy_backfill::{
    is_valid_completed_backfill_marker, parse_maintenance_instant, BackfillSummary,
    CompletedBackfillMarker, LEGACY_BACKFILL_ALGORITHM_VERSION,
    LEGACY_BACKFILL_WORK_KEY as WRITER_BACKFILL_WORK_KEY,
};
use super::maintenance_contracts::{
    current_maintenance_coordinates, derive_ci_coordinate_mismatch_digest,
    MaintenanceContractCoordinates,
};
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
use super::nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage};
use super::restore_rebuild::{
    is_canonical_graph_state_digest, validate_canonical_verify_outcome_digest,
    validate_graph_state_digest, validate_graph_state_digest_with_control,
    validate_report_rebuild_required, validate_report_rebuild_required_with_control,
    validate_verify_check_coverage, DependencyGraphVerifyReport, RebuildDerivedStateSummary,
    REBUILD_CONTRACT_VERSION, VERIFY_CONTRACT_VERSION, VERIFY_RUN_KIND,
};
use super::source_revision::is_validation_terminated;
use super::task_leases::with_immediate_transaction;
use crate::narrative_maintenance_connection::{
    with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
};
use crate::Database;

/// Exact renderer-owned marker used to hide an in-progress Scan publication.
/// C2-ZC inventory selectors reuse this predicate so maintenance and cutover
/// cannot drift on which Projects are visible during staging.
pub(crate) const SCAN_IMPORT_STATE_KEY: &str = "scan.import.state";
pub(crate) const SCAN_IMPORT_STAGING_VALUE: &str = "staging";

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

/// Result of dispatching one automatic adapter.
///
/// A foreground product-journey barrier deliberately keeps a successful
/// Run/Task/Attempt lifecycle running until the matching authoring write
/// commits.  The cycle must preserve that durable work and tell its caller to
/// park the delivery; treating the adapter as an ordinary success would let
/// the attempt owner acquire a false finalization grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MaintenanceDispatchOutcome {
    Completed,
    ForegroundHeld,
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

    /// Stable product route identity. This is intentionally distinct from
    /// [`Self::as_str`], whose values are persisted SQLite Run Kind values.
    pub fn route_id(self) -> &'static str {
        super::maintenance_route_registry::route_id_for_run_kind(self)
            .expect("every AutomaticRunKind must have a registered route")
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
    /// Acceptance-only Freshness hold. The main/N-API seam may select one
    /// existing project for a deterministic two-project cursor gate; normal
    /// and production callers leave this unset.
    pub freshness_hold_project_id: Option<String>,
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
        if let Some(project_id) = self.freshness_hold_project_id.as_deref() {
            validate_ci_identifier(project_id, "freshnessHoldProjectId")?;
        }
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

/// Resolve the one effective coordinate set for a live maintenance operation.
/// The baseline values come from the compiled Rust contracts. A CI trigger may
/// deterministically perturb exactly one selected coordinate, but no caller
/// can provide a digest value. Production and ordinary launches always use the
/// unmodified current coordinates.
pub fn effective_maintenance_coordinates(
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
) -> anyhow::Result<MaintenanceContractCoordinates> {
    let mut coordinates = current_maintenance_coordinates()?;
    let Some(config) = ci_config else {
        return Ok(coordinates);
    };
    config.validate()?;
    match config.trigger {
        Some(NarrativeMaintenanceCiTrigger::GraphContractDigestChanged) => {
            coordinates.graph_contract_digest = derive_ci_coordinate_mismatch_digest(
                "graphContractDigest",
                &coordinates.graph_contract_digest,
            )?;
        }
        Some(NarrativeMaintenanceCiTrigger::RuleRegistryDigestChanged) => {
            coordinates.rule_registry_digest = derive_ci_coordinate_mismatch_digest(
                "ruleRegistryDigest",
                &coordinates.rule_registry_digest,
            )?;
        }
        Some(NarrativeMaintenanceCiTrigger::ProducerGenerationSetDigestChanged) => {
            coordinates.producer_generation_set_digest = derive_ci_coordinate_mismatch_digest(
                "producerGenerationSetDigest",
                &coordinates.producer_generation_set_digest,
            )?;
        }
        Some(
            NarrativeMaintenanceCiTrigger::DependencyGap
            | NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake,
        )
        | None => {}
    }
    Ok(coordinates)
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
    find_running_foreground_system_work_scoped(db, config, binding, true, true, true)
}

/// Find the durable marker that reserves the foreground slot for the current
/// authority, including an older recovery generation or terminalized phase
/// row left by a prior cycle/process. This is intentionally not an ownership
/// lookup: the caller must still use [`find_running_foreground_system_work_run`]
/// and a process-local Run handle before suppressing recovery or releasing a
/// Run.
pub fn find_running_foreground_system_work_slot(
    db: &Database,
    config: &NarrativeMaintenanceCiConfig,
    binding: &MaintenanceWorkspaceBinding,
) -> anyhow::Result<Option<ForegroundSystemWorkRun>> {
    find_running_foreground_system_work_scoped(db, config, binding, false, false, false)
}

fn find_running_foreground_system_work_scoped(
    db: &Database,
    config: &NarrativeMaintenanceCiConfig,
    binding: &MaintenanceWorkspaceBinding,
    require_running_status: bool,
    require_current_generation: bool,
    require_current_epoch: bool,
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
            "SELECT id, project_id, run_kind, work_key, semantic_epoch_id, spec_json, status,
                    outcome_summary_json
               FROM narrative_extraction_runs
              WHERE run_kind IN ('backfill', 'dependency-verify', 'semantic-index-rebuild')
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
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut matches = Vec::new();
        for row in rows {
            let (
                run_id,
                project_id,
                run_kind,
                work_key,
                epoch_id,
                spec_json,
                status,
                outcome_summary_json,
            ) = row?;
            if require_running_status && status != "running" {
                continue;
            }
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
                || marker.trigger != "workspace-opened"
                || (require_current_generation && marker.generation != binding.generation)
            {
                continue;
            }
            if require_running_status {
                // A durable marker/status pair is not enough to suppress
                // startup recovery. Only a successful, identity-bound
                // outcome may be held behind the foreground authoring
                // barrier. A Run created before cancellation/finalization
                // remains recoverable when its outcome is absent or invalid.
                let Some(outcome_summary_json) = outcome_summary_json.as_deref() else {
                    continue;
                };
                let Ok(outcome) = serde_json::from_str::<Value>(outcome_summary_json) else {
                    continue;
                };
                if validate_phase_success_outcome(
                    &run_kind,
                    &project_id,
                    &work_key,
                    epoch_id.as_deref(),
                    &outcome,
                )
                .is_err()
                {
                    continue;
                }
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
                require_current_epoch,
            )?;
            matches.push(ForegroundSystemWorkRun {
                run_id,
                project_id,
                marker,
            });
        }
        anyhow::ensure!(
            matches.len() <= 1,
            "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_NOT_UNIQUE: multiple durable Runs matched the exact product-journey barrier"
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

/// Validate the immutable success evidence produced by one automatic phase.
///
/// This is intentionally shared by normal completion and foreground release:
/// a held Run must not gain a terminal status merely because its outcome was
/// replaced with an empty object, and the normal writer/release paths must
/// agree on the same production evidence shape.
pub(crate) fn validate_phase_success_outcome(
    run_kind: &str,
    project_id: &str,
    work_key: &str,
    semantic_epoch_id: Option<&str>,
    outcome: &Value,
) -> anyhow::Result<()> {
    let object = outcome.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: successful phase outcome must be an object"
        )
    })?;
    let epoch_id = semantic_epoch_id.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: successful phase outcome requires a Semantic Epoch"
        )
    })?;
    anyhow::ensure!(
        !project_id.trim().is_empty(),
        "project identity is required"
    );
    match run_kind {
        "backfill" => {
            anyhow::ensure!(
                work_key == LEGACY_BACKFILL_WORK_KEY,
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Backfill work key is not canonical"
            );
            anyhow::ensure!(
                object.get("maintenancePhase").and_then(Value::as_str)
                    == Some("backfill-complete"),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Backfill outcome marker is missing or incorrect"
            );
            anyhow::ensure!(
                object
                    .get("backfillAlgorithmVersion")
                    .and_then(Value::as_str)
                    == Some(LEGACY_BACKFILL_ALGORITHM_VERSION),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Backfill algorithm version is missing or incorrect"
            );
            anyhow::ensure!(
                object.get("semanticEpochId").and_then(Value::as_str) == Some(epoch_id),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Backfill outcome epoch does not match the Run"
            );
            let summary = object.get("summary").ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Backfill outcome summary is missing"
                )
            })?;
            serde_json::from_value::<BackfillSummary>(summary.clone()).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Backfill outcome summary is invalid: {error}"
                )
            })?;
        }
        VERIFY_RUN_KIND => {
            anyhow::ensure!(
                work_key == format!("{VERIFY_RUN_KIND}:{epoch_id}"),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify work key is not canonical"
            );
            anyhow::ensure!(
                object
                    .get("verifyContractVersion")
                    .and_then(Value::as_str)
                    == Some(VERIFY_CONTRACT_VERSION),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify contract version is missing or incorrect"
            );
            anyhow::ensure!(
                object.get("semanticEpochId").and_then(Value::as_str) == Some(epoch_id),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify outcome epoch does not match the Run"
            );
            let report = object.get("report").ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify report is missing"
                )
            })?;
            serde_json::from_value::<DependencyGraphVerifyReport>(report.clone()).map_err(
                |error| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify report is invalid: {error}"
                    )
                },
            )?;
            validate_canonical_verify_outcome_digest(outcome).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_OUTCOME_INVALID: Verify outcome digest is invalid: {error}"
                )
            })?;
            validate_verify_check_coverage(outcome).map_err(|error| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_OUTCOME_INVALID: Verify check coverage is invalid: {error}"
                )
            })?;
            let report_digest = object
                .get("reportDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify report digest is missing"
                    )
                })?;
            let expected_digest = format!("sha256:{}", digest_plan(report));
            anyhow::ensure!(
                report_digest == expected_digest,
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify report digest does not match the report"
            );
            let graph_state_digest = object
                .get("graphStateDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify graph state digest is missing"
                    )
                })?;
            anyhow::ensure!(
                is_canonical_graph_state_digest(graph_state_digest),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Verify graph state digest is invalid"
            );
        }
        "semantic-index-rebuild" => {
            anyhow::ensure!(
                work_key == REBUILD_DERIVED_WORK_KEY,
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild work key is not canonical"
            );
            anyhow::ensure!(
                object
                    .get("rebuildContractVersion")
                    .and_then(Value::as_str)
                    == Some(REBUILD_CONTRACT_VERSION),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild contract version is missing or incorrect"
            );
            anyhow::ensure!(
                object.get("semanticEpochId").and_then(Value::as_str) == Some(epoch_id),
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild outcome epoch does not match the Run"
            );
            let summary = object.get("summary").ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild outcome summary is missing"
                )
            })?;
            serde_json::from_value::<RebuildDerivedStateSummary>(summary.clone()).map_err(
                |error| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild outcome summary is invalid: {error}"
                    )
                },
            )?;
            let summary_digest = object
                .get("summaryDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild summary digest is missing"
                    )
                })?;
            let expected_digest = format!("sha256:{}", digest_plan(summary));
            anyhow::ensure!(
                summary_digest == expected_digest,
                "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: Rebuild summary digest does not match the summary"
            );
        }
        other => anyhow::bail!(
            "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: unsupported successful Run kind '{other}'"
        ),
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
                // immutable lifecycle pair *and* the phase-specific success
                // evidence have been validated.  Completed Verify rows are
                // later rediscovery inputs, so an empty/tampered outcome must
                // not become a reusable success merely because its lifecycle
                // children still look terminal.
                let completed_outcome = conn
                    .query_row(
                        "SELECT outcome_summary_json
                           FROM narrative_extraction_runs
                          WHERE id = ?1",
                        params![barrier.run_id],
                        |row| row.get::<_, Option<String>>(0),
                    )?
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: completed foreground Run has no successful phase outcome"
                        )
                    })?;
                let completed_outcome = serde_json::from_str::<Value>(&completed_outcome)?;
                validate_phase_success_outcome(
                    &run_kind,
                    &project_id,
                    &work_key,
                    epoch_id.as_deref(),
                    &completed_outcome,
                )?;
                if run_kind == VERIFY_RUN_KIND {
                    // A completed foreground Run is already terminal.  Its
                    // duplicate release is an idempotent lifecycle replay,
                    // including after a later Semantic Epoch rotation has
                    // changed the live graph-state digest.  Keep the stored
                    // repairability bit bound to current durable inputs, but
                    // do not re-run the pre-completion graph CAS here.
                    let report: DependencyGraphVerifyReport = serde_json::from_value(
                        completed_outcome
                            .get("report")
                            .cloned()
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: completed foreground Verify outcome has no report"
                                )
                            })?,
                    )?;
                    validate_report_rebuild_required(conn, &project_id, &report)?;
                }
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
                None => {
                    anyhow::bail!(
                        "NEX_MAINTENANCE_SYSTEM_WORK_OUTCOME_INVALID: foreground Run has no successful phase outcome"
                    )
                }
            };
            validate_phase_success_outcome(
                &run_kind,
                &project_id,
                &work_key,
                epoch_id.as_deref(),
                &outcome,
            )?;
            if run_kind == VERIFY_RUN_KIND {
                validate_live_verify_outcome_rebuild_requirement(conn, &project_id, &outcome)?;
            }
            {
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
            }
            if run_kind == VERIFY_RUN_KIND {
                let outcome_digest = super::restore_rebuild::canonical_verify_outcome_digest(&outcome)?;
                outcome["outcomeDigest"] = Value::String(outcome_digest);
            }
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
                            rebuild_contract_version: REBUILD_CONTRACT_VERSION.to_string(),
                            run_kind_contract_version: VERIFY_CONTRACT_VERSION.to_string(),
                            report_digest: report_digest.to_string(),
                            graph_state_digest: outcome
                                .get("graphStateDigest")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "foreground Verify outcome has no graph state digest"
                                    )
                                })?
                                .to_string(),
                        },
                    )?;
                }
            }
            super::terminal_failure::resolve_terminal_failure_for_run_generated_in_tx(
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
    /// Main's session-scoped delivery sequence. Native/shared owners may use
    /// it to correlate receipts with the bounded delivery ledger; it is never
    /// a durable Run identity and is reset with the Native session.
    #[serde(default)]
    pub delivery_sequence: Option<u64>,
    /// Main's exact content fingerprint.  Native binds the sequence and
    /// fingerprint to the shared lifecycle ledger before any worker or Run
    /// side effect begins.
    #[serde(default)]
    pub delivery_fingerprint: Option<String>,
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
    /// A successful foreground adapter recorded its durable outcome but kept
    /// its Run/Task/Attempt lifecycle running behind the authoring barrier.
    /// The caller must park this delivery until the exact barrier Run is
    /// released; treating it as Accepted would grant false finalization and
    /// immediately retry the same held work.
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

/// Optional process-local control for a bounded maintenance cycle. The
/// callbacks are invoked only at Rust work boundaries; they never become a
/// durable authority or a renderer-facing contract. `should_stop` is checked
/// before a work item, before its adapter dispatch, and before final cycle
/// publication. `work_completed` is called only after a real adapter has
/// acquired its per-work finalization grant and committed its durable
/// terminal transition. `work_noop_completed` is used for queue executions
/// that intentionally do not dispatch an adapter; those paths have no
/// durable finalization transaction and remain independently cancellable.
pub struct MaintenanceCycleControl<'a> {
    pub should_stop: &'a dyn Fn() -> anyhow::Result<()>,
    /// Process-local cancellation signal shared with the SQLite progress hook
    /// owned by each phase-scoped maintenance connection.  The callback above
    /// remains the lifecycle authority; this signal is only the low-level
    /// observation channel needed while SQLite is executing a long statement.
    pub stop_signal: Option<Arc<AtomicBool>>,
    /// Set only while the owning adapter is inside its granted final success
    /// transaction.  A late cancellation may stop later work, but must not
    /// interrupt the transaction whose grant already linearized success.
    pub finalization_granted_signal: Option<Arc<AtomicBool>>,
    /// Record a Run whose transient foreground preemption could not
    /// synchronously cancel it because the shared connection was already
    /// owned. The Native owner retries this cleanup with the same authority
    /// before the next cycle can recover or dispatch the WorkKey.
    pub defer_preempted_run: &'a dyn Fn(&str) -> anyhow::Result<()>,
    /// Acquire the process-local finalization grant for one canonical work
    /// key.  The route owner invokes this while its final success transaction
    /// is open, immediately before the durable terminal write.
    pub grant_finalize: &'a dyn Fn(&str) -> anyhow::Result<()>,
    /// Register dynamically discovered work before it is queued, so a later
    /// work transition in this cycle cannot outrun the attempt registry.
    pub register_work: &'a dyn Fn(&DesiredWork) -> anyhow::Result<()>,
    /// Mark only the dequeued work as running; queued follow-ups remain
    /// `not-started` in the terminal receipt.
    pub work_started: &'a dyn Fn(&DesiredWork) -> anyhow::Result<()>,
    /// Complete one real adapter execution after its durable finalization.
    pub work_completed: &'a dyn Fn(&DesiredWork) -> anyhow::Result<()>,
    /// Complete one non-dispatch queue execution without a durable
    /// finalization grant.
    pub work_noop_completed: &'a dyn Fn(&DesiredWork) -> anyhow::Result<()>,
    /// Park one foreground-held queue execution without settling it as a
    /// successful work item. The native owner must leave this execution
    /// requeueable until the exact foreground Run is released.
    pub work_deferred: &'a dyn Fn(&DesiredWork) -> anyhow::Result<()>,
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
            anyhow::ensure!(
                !item
                    .reasons
                    .iter()
                    .any(|reason| reason == BEFORE_CUTOVER_FOLLOW_UP_REASON),
                "NEX_MAINTENANCE_INVALID_REQUEST: C2-ZC follow-up reason is Rust-internal"
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

/// Compose the process-local attempt callback with the phase-owned SQLite
/// GraphWorkControl.  The outer callback is deliberately checked before the
/// inner control at every Rust boundary, so cancellation is never converted
/// into a source-missing or diagnostic result by a nested resolver.
pub(crate) struct MaintenanceCycleGraphControl<'graph, 'cycle> {
    inner: &'graph mut dyn GraphWorkControl,
    cycle: Option<&'cycle MaintenanceCycleControl<'cycle>>,
}

impl<'graph, 'cycle> MaintenanceCycleGraphControl<'graph, 'cycle> {
    pub(crate) fn new(
        inner: &'graph mut dyn GraphWorkControl,
        cycle: Option<&'cycle MaintenanceCycleControl<'cycle>>,
    ) -> Self {
        Self { inner, cycle }
    }
}

impl GraphWorkControl for MaintenanceCycleGraphControl<'_, '_> {
    fn check(&mut self, stage: GraphWorkStage) -> anyhow::Result<()> {
        if let Some(cycle) = self.cycle {
            // The finalization grant is the only narrow window in which the
            // complete stop set is intentionally masked. The inner control
            // has the same grant signal and therefore masks deadline,
            // closed, generation, and foreground conditions as well.
            let finalization_granted = cycle
                .finalization_granted_signal
                .as_ref()
                .is_some_and(|signal| signal.load(Ordering::Acquire));
            if !finalization_granted {
                (cycle.should_stop)()?;
            }
        }
        self.inner.check(stage)
    }
}

/// RAII scope for the process-local finalization mask. The Native grant stays
/// recorded in the attempt registry until `work_completed`, but the Graph and
/// SQLite stop mask must end as soon as the exact terminal transaction exits,
/// including rollback/error paths.
pub(crate) struct FinalizationGrantScope {
    signal: Option<Arc<AtomicBool>>,
}

impl FinalizationGrantScope {
    pub(crate) fn new(control: &MaintenanceCycleControl<'_>) -> Self {
        Self {
            signal: control.finalization_granted_signal.clone(),
        }
    }
}

impl Drop for FinalizationGrantScope {
    fn drop(&mut self) {
        if let Some(signal) = self.signal.as_ref() {
            signal.store(false, Ordering::SeqCst);
        }
    }
}

pub(crate) fn maintenance_stop_signal(
    control: Option<&MaintenanceCycleControl<'_>>,
) -> Arc<AtomicBool> {
    control
        .and_then(|control| control.stop_signal.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
}

/// Validate the complete wire request before any phase owner claims a fault
/// or touches durable lifecycle state. Keep this shared so the N-API seam
/// cannot grow a partial allowlist that disagrees with execute mode.
pub fn preflight_maintenance_cycle_request(
    request: &MaintenanceCycleRequest,
) -> anyhow::Result<Vec<DesiredWork>> {
    if let Some(sequence) = request.delivery_sequence {
        anyhow::ensure!(
            sequence > 0,
            "NEX_MAINTENANCE_DELIVERY_SEQUENCE_INVALID: sequence must be positive"
        );
        anyhow::ensure!(
            request
                .delivery_fingerprint
                .as_deref()
                .is_some_and(|fingerprint| !fingerprint.trim().is_empty()),
            "NEX_MAINTENANCE_DELIVERY_FINGERPRINT_INVALID: sequence requires an exact fingerprint"
        );
    }
    let work = request.normalized_work()?;
    anyhow::ensure!(
        work.is_empty() || request.wake_project_ids.is_empty(),
        "NEX_MAINTENANCE_WAKE_MIXED_ACK_SCOPE: ordinary work and durable wake must use separate cycles"
    );
    for item in &work {
        validate_dispatch_contract(item)?;
    }
    Ok(work)
}

#[derive(Debug, Clone)]
pub(crate) struct DurableMaintenanceRun {
    pub(crate) run_id: String,
    pub(crate) run_kind: String,
    pub(crate) status: String,
    pub(crate) spec_json: Option<String>,
    pub(crate) semantic_epoch_id: Option<String>,
    pub(crate) work_key: Option<String>,
    pub(crate) outcome_summary_json: Option<String>,
    pub(crate) terminal_reason_code: Option<String>,
    pub(crate) completed_at: Option<String>,
    pub(crate) created_at_raw: String,
    pub(crate) started_at_raw: Option<String>,
}

pub(crate) fn load_durable_maintenance_runs(
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
    // Every automatic Run Kind fails closed on a malformed active row.
    // Silently filtering a malformed active Backfill/Rebuild from the
    // canonical candidates would let the cycle start a second canonical Run
    // beside a row that is still live.
    if !matches!(run.status.as_str(), "pending" | "running") {
        return Ok(());
    }
    let work_key = run.work_key.as_deref().filter(|value| !value.is_empty());
    anyhow::ensure!(
        work_key.is_some(),
        "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: '{}' Run '{}' has no workKey",
        run.run_kind,
        run.run_id
    );
    match run.run_kind.as_str() {
        "backfill" => {
            anyhow::ensure!(
                work_key == Some(LEGACY_BACKFILL_WORK_KEY),
                "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Backfill Run '{}' workKey is not canonical",
                run.run_id
            );
        }
        VERIFY_RUN_KIND => {
            let epoch_id = run
                .semantic_epoch_id
                .as_deref()
                .filter(|value| !value.is_empty());
            anyhow::ensure!(
                epoch_id.is_some(),
                "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Verify Run '{}' has no Semantic Epoch",
                run.run_id
            );
            let expected = format!("{VERIFY_WORK_KEY_PREFIX}{}", epoch_id.unwrap_or_default());
            anyhow::ensure!(
                work_key == Some(expected.as_str()),
                "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Verify Run '{}' workKey does not match its Semantic Epoch",
                run.run_id
            );
        }
        "semantic-index-rebuild" => {
            anyhow::ensure!(
                run.semantic_epoch_id
                    .as_deref()
                    .is_some_and(|epoch_id| !epoch_id.is_empty()),
                "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Rebuild Run '{}' has no Semantic Epoch",
                run.run_id
            );
            anyhow::ensure!(
                work_key == Some(REBUILD_DERIVED_WORK_KEY),
                "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: Rebuild Run '{}' workKey is not canonical",
                run.run_id
            );
        }
        other => anyhow::bail!(
            "NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID: unsupported active Run kind '{other}' for Run '{}'",
            run.run_id
        ),
    }
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
    let created_at = parse_maintenance_instant(&run.created_at_raw)?;

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
            let started_at = run
                .started_at_raw
                .as_deref()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' is missing started_at",
                        run.run_id
                    )
                })
                .and_then(parse_maintenance_instant)?;
            anyhow::ensure!(
                started_at >= created_at,
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' started_at precedes created_at",
                run.run_id
            );
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
            let started_at = run
                .started_at_raw
                .as_deref()
                .map(parse_maintenance_instant)
                .transpose()?;
            if let Some(started_at) = started_at {
                anyhow::ensure!(
                    started_at >= created_at,
                    "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' started_at precedes created_at",
                    run.run_id
                );
            }
            let completed_at = run
                .completed_at
                .as_deref()
                .map(parse_maintenance_instant)
                .transpose()?;
            if !allows_missing_terminal {
                anyhow::ensure!(
                    completed_at.is_some(),
                    "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' is missing completed_at",
                    run.run_id
                );
            }
            if let Some(completed_at) = completed_at {
                anyhow::ensure!(
                    completed_at >= created_at,
                    "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' completed_at precedes created_at",
                    run.run_id
                );
                if let Some(started_at) = started_at {
                    anyhow::ensure!(
                        completed_at >= started_at,
                        "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' completed_at precedes started_at",
                        run.run_id
                    );
                }
            }
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
pub(crate) fn select_latest_relevant_run(
    runs: &[DurableMaintenanceRun],
    current_epoch_id: Option<&str>,
    allow_historical_fallback: bool,
    predicate: impl Fn(&DurableMaintenanceRun) -> bool,
) -> anyhow::Result<Option<DurableMaintenanceRun>> {
    select_latest_relevant_run_with_canonicality(
        runs,
        current_epoch_id,
        allow_historical_fallback,
        true,
        predicate,
    )
}

/// One immutable row of lifecycle evidence.  Identity is diagnostic only:
/// chronology is decided solely by [`lifecycle_at`], and equal maxima are
/// never broken by a row ID or query order.
#[derive(Debug, Clone)]
pub(crate) struct LifecycleEvidence<T> {
    pub(crate) id: String,
    pub(crate) lifecycle_at: DateTime<Utc>,
    pub(crate) value: T,
}

/// Select the unique latest lifecycle evidence from one already-scoped
/// window.  Every maintenance decision that needs a "latest" Run, failure,
/// or Attempt uses this rather than relying on SQLite row order.
pub(crate) fn select_unique_latest_lifecycle_evidence<T>(
    evidence: Vec<LifecycleEvidence<T>>,
) -> anyhow::Result<Option<LifecycleEvidence<T>>> {
    let Some(max_lifecycle) = evidence.iter().map(|evidence| evidence.lifecycle_at).max() else {
        return Ok(None);
    };
    let mut maximal = evidence
        .into_iter()
        .filter(|evidence| evidence.lifecycle_at == max_lifecycle)
        .collect::<Vec<_>>();
    let maximal_ids = maximal
        .iter()
        .map(|evidence| evidence.id.as_str())
        .collect::<Vec<_>>();
    anyhow::ensure!(
        maximal.len() == 1,
        "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS: lifecycle evidence {:?} shares maximal lifecycle instant {}",
        maximal_ids,
        max_lifecycle.to_rfc3339()
    );
    Ok(maximal.pop())
}

/// Readiness uses the same lifecycle chronology as recovery, but must also
/// inspect a run with a malformed ownership key so the gate can report a
/// precise blocked/incomplete reason. Runtime recovery keeps the canonical
/// filter enabled and ignores such imported rows as non-authoritative.
pub(crate) fn select_latest_relevant_run_for_readiness(
    runs: &[DurableMaintenanceRun],
    current_epoch_id: Option<&str>,
    allow_historical_fallback: bool,
    predicate: impl Fn(&DurableMaintenanceRun) -> bool,
) -> anyhow::Result<Option<DurableMaintenanceRun>> {
    select_latest_relevant_run_with_canonicality(
        runs,
        current_epoch_id,
        allow_historical_fallback,
        false,
        predicate,
    )
}

fn select_latest_relevant_run_with_canonicality(
    runs: &[DurableMaintenanceRun],
    current_epoch_id: Option<&str>,
    allow_historical_fallback: bool,
    canonical_only: bool,
    predicate: impl Fn(&DurableMaintenanceRun) -> bool,
) -> anyhow::Result<Option<DurableMaintenanceRun>> {
    let candidates: Vec<&DurableMaintenanceRun> = runs
        .iter()
        .filter(|run| (!canonical_only || is_canonical_maintenance_work(run)) && predicate(run))
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
    // Select by the latest parsed lifecycle instant only. Creation time is
    // retained as lifecycle evidence above, but must not break a tie: an
    // equal terminal instant is ambiguous even when the rows have different
    // creation times, and UUIDs never participate in this ordering.
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
        temporal.push((lifecycle_at, run, lifecycle_timestamp_invalid));
    }
    let selected = select_unique_latest_lifecycle_evidence(
        temporal
            .into_iter()
            .map(
                |(lifecycle_at, run, lifecycle_timestamp_invalid)| LifecycleEvidence {
                    id: run.run_id.clone(),
                    lifecycle_at,
                    value: (run, lifecycle_timestamp_invalid),
                },
            )
            .collect(),
    )?;
    let Some(selected) = selected else {
        anyhow::bail!("NEX_MAINTENANCE_RUN_ORDER_EMPTY");
    };
    let (run, lifecycle_timestamp_invalid) = selected.value;
    if lifecycle_timestamp_invalid {
        if let Some(completed_at) = run.completed_at.as_deref() {
            parse_maintenance_instant(completed_at)?;
        }
        anyhow::bail!(
            "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: Run '{}' has no supported completed_at",
            run.run_id
        );
    }
    Ok(Some(run.clone()))
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
    discover_durable_maintenance_work_with_coordinates(db, project_id, reason, None)
}

/// Discover the first durable work item for a C2-ZC readiness wake.
///
/// `BeforeCutover` is a Verify-owned trigger: even when a previous clean
/// Verify is reusable, the trigger must execute one current Verify before its
/// Rebuild decision. Once that Verify/Rebuild/confirmation chain has already
/// completed, a repeated freshness wake is a no-op. Keeping this distinction
/// in the Rust state machine makes the wake restart-safe without asking main
/// to infer phase state from a process-local flag.
pub fn discover_before_cutover_maintenance_work_with_coordinates(
    db: &Database,
    project_id: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
) -> anyhow::Result<Option<DesiredWork>> {
    let discovered = discover_durable_maintenance_work_with_coordinates(
        db,
        project_id,
        "before-cutover",
        coordinates,
    )?;
    if discovered.is_some() {
        return Ok(discovered);
    }

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            if is_scan_staging_project_in_tx(conn, project_id)? {
                return Ok(None);
            }
            let Some(current_epoch_id) =
                super::semantic_epoch::get_current_epoch(conn, project_id)?.map(|epoch| epoch.id)
            else {
                return Ok(None);
            };
            let runs = load_durable_maintenance_runs(conn, project_id)?;
            let latest_completed_rebuild =
                select_latest_relevant_run(&runs, Some(&current_epoch_id), false, |run| {
                    run.run_kind == "semantic-index-rebuild" && run.status == "completed"
                })?;
            if latest_completed_rebuild.as_ref().is_some_and(|run| {
                completed_rebuild_outcome_is_current(project_id, &current_epoch_id, run)
            }) {
                return Ok(None);
            }
            let trigger = MaintenanceTrigger::BeforeCutover {
                project_id: project_id.to_string(),
                semantic_epoch_id: current_epoch_id,
            };
            Ok(plan_maintenance_trigger(&trigger)?.into_iter().next())
        })
    })
}

pub(crate) fn discover_before_cutover_maintenance_work_with_coordinates_and_control(
    db: &Database,
    project_id: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: &MaintenanceCycleControl<'_>,
) -> anyhow::Result<Option<DesiredWork>> {
    let first = discover_durable_maintenance_work_with_coordinates_and_control(
        db,
        project_id,
        "before-cutover",
        coordinates,
        control,
    )?;
    if first.is_some() {
        return Ok(first);
    }

    let project_id = require_component(project_id.to_string(), "projectId")?;
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
        1_000,
        stop,
        config,
        |conn, graph| {
            let mut chained = MaintenanceCycleGraphControl::new(graph, Some(control));
            with_immediate_transaction(conn, |conn| {
                chained.check(GraphWorkStage::Restore)?;
                if is_scan_staging_project_in_tx(conn, &project_id)? {
                    return Ok(None);
                }
                let Some(current_epoch_id) =
                    super::semantic_epoch::get_current_epoch(conn, &project_id)?.map(|epoch| epoch.id)
                else {
                    return Ok(None);
                };
                let runs = load_durable_maintenance_runs(conn, &project_id)?;
                chained.check(GraphWorkStage::Restore)?;
                let latest_completed_rebuild = select_latest_relevant_run(
                    &runs,
                    Some(&current_epoch_id),
                    false,
                    |run| {
                        run.run_kind == "semantic-index-rebuild" && run.status == "completed"
                    },
                )?;
                chained.check(GraphWorkStage::Coverage)?;
                if latest_completed_rebuild.is_none() {
                    return Ok(Some(before_cutover_verify_work(
                        &project_id,
                        &current_epoch_id,
                    )?));
                }
                if latest_completed_rebuild.as_ref().is_some_and(|run| {
                    !completed_rebuild_outcome_is_current(
                        &project_id,
                        &current_epoch_id,
                        run,
                    )
                }) {
                    return Ok(Some(DesiredWork::new_with_epoch(
                        project_id.clone(),
                        AutomaticRunKind::RebuildDerived,
                        REBUILD_DERIVED_WORK_KEY,
                        Some(current_epoch_id.clone()),
                        BEFORE_CUTOVER_FOLLOW_UP_REASON,
                    )?));
                }
                chained.check(GraphWorkStage::ResultAssembly)?;
                Ok(None)
            })
        },
    )?;
    let Some(result) = result else {
        anyhow::bail!(
            "NEX_MAINTENANCE_CONNECTION_PREEMPTED: before-cutover discovery could not acquire the maintenance connection without waiting"
        );
    };
    result.into_result()
}

/// Discover durable work using one effective coordinate set selected by the
/// native caller. The coordinate set is computed once per live authority
/// operation and is used only for Verify skip evidence; the durable ledger
/// remains the sole source of phase identity.
pub fn discover_durable_maintenance_work_with_coordinates(
    db: &Database,
    project_id: &str,
    reason: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
) -> anyhow::Result<Option<DesiredWork>> {
    let project_id = require_component(project_id.to_string(), "projectId")?;
    let reason = require_component(reason.to_string(), "reason")?;
    db.with_conn(|conn| {
        // Keep candidate selection, Verify outcome validation, and the
        // clean-skip decision on one SQLite snapshot. A concurrent writer
        // must not change report/reportDigest/epoch between those decisions.
        with_immediate_transaction(conn, |conn| {
            discover_durable_maintenance_work_in_tx(conn, &project_id, &reason, coordinates)
        })
    })
}

/// Controlled discovery for the Native maintenance cycle.  Candidate
/// selection, completed Verify validation, and skip evidence all share the
/// same phase-owned no-wait connection and top-level GraphWorkControl.
pub(crate) fn discover_durable_maintenance_work_with_coordinates_and_control(
    db: &Database,
    project_id: &str,
    reason: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: &MaintenanceCycleControl<'_>,
) -> anyhow::Result<Option<DesiredWork>> {
    let project_id = require_component(project_id.to_string(), "projectId")?;
    let reason = require_component(reason.to_string(), "reason")?;
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
        1_000,
        stop,
        config,
        |conn, graph| {
            let mut chained = MaintenanceCycleGraphControl::new(graph, Some(control));
            with_immediate_transaction(conn, |conn| {
                chained.check(GraphWorkStage::Restore)?;
                discover_durable_maintenance_work_in_tx_with_control(
                    conn,
                    &project_id,
                    &reason,
                    coordinates,
                    &mut chained,
                )
            })
        },
    )?;
    let Some(result) = result else {
        anyhow::bail!(
            "NEX_MAINTENANCE_CONNECTION_PREEMPTED: discovery could not acquire the maintenance connection without waiting"
        );
    };
    result.into_result()
}

fn discover_cycle_work(
    db: &Database,
    project_id: &str,
    reason: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<Option<DesiredWork>> {
    match control {
        Some(control) if reason == "before-cutover" => {
            discover_before_cutover_maintenance_work_with_coordinates_and_control(
                db,
                project_id,
                coordinates,
                control,
            )
        }
        Some(control) => discover_durable_maintenance_work_with_coordinates_and_control(
            db,
            project_id,
            reason,
            coordinates,
            control,
        ),
        None => discover_durable_maintenance_work_with_coordinates(
            db,
            project_id,
            reason,
            coordinates,
        ),
    }
}

pub(crate) fn is_scan_staging_project_in_tx(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM project_settings
             WHERE project_id = ?1
               AND key = ?2
               AND value = ?3
        )",
        params![project_id, SCAN_IMPORT_STATE_KEY, SCAN_IMPORT_STAGING_VALUE],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub(crate) fn discover_durable_maintenance_work_in_tx(
    conn: &Connection,
    project_id: &str,
    reason: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
) -> anyhow::Result<Option<DesiredWork>> {
    let mut control = super::nir1_entity_relation_index::NeverStopGraphWorkControl;
    discover_durable_maintenance_work_in_tx_with_control(
        conn,
        project_id,
        reason,
        coordinates,
        &mut control,
    )
}

pub(crate) fn discover_durable_maintenance_work_in_tx_with_control(
    conn: &Connection,
    project_id: &str,
    reason: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Option<DesiredWork>> {
    control.check(GraphWorkStage::Restore)?;
    if is_scan_staging_project_in_tx(conn, project_id)? {
        // Scan staging Projects are intentionally hidden until the publish
        // writer removes the exact marker. No wake, including BeforeCutover
        // and workspace-opened, may mint maintenance authority for them.
        return Ok(None);
    }

    let (current_epoch_id, latest, active, completed_backfill, latest_completed_rebuild) = {
        let current_epoch_id =
            super::semantic_epoch::get_current_epoch(conn, project_id)?.map(|epoch| epoch.id);
        let runs = load_durable_maintenance_runs(conn, project_id)?;
        let mut completed_backfill = None;
        for run in &runs {
            control.check(GraphWorkStage::Restore)?;
            if is_completed_backfill_marker(conn, project_id, run)? {
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
        let latest_completed_rebuild =
            select_latest_relevant_run(&runs, current_epoch_id.as_deref(), false, |run| {
                run.run_kind == "semantic-index-rebuild" && run.status == "completed"
            })?;
        (
            current_epoch_id,
            latest,
            active,
            completed_backfill,
            latest_completed_rebuild,
        )
    };

    control.check(GraphWorkStage::Restore)?;

    if let Some(active) = active {
        return durable_run_work(project_id, &active, reason);
    }

    let Some(current_epoch_id) = current_epoch_id else {
        // Backfill is the only phase allowed to create the initial Epoch.
        // Restore/Epoch wakes fail closed until the restore installer has
        // durably minted its restore Epoch.
        return if is_backfill_wake(reason) {
            Ok(Some(DesiredWork::new(
                project_id.to_string(),
                AutomaticRunKind::Backfill,
                LEGACY_BACKFILL_WORK_KEY,
                reason.to_string(),
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
            project_id.to_string(),
            AutomaticRunKind::Backfill,
            LEGACY_BACKFILL_WORK_KEY,
            Some(current_epoch_id),
            reason.to_string(),
        )?));
    }

    let Some(latest) = latest else {
        // An existing current Epoch means the initial Backfill boundary has
        // already been crossed. Even a workspace-opened wake must therefore
        // begin with Verify; replaying Backfill here would loop forever after
        // a restore or restart.
        return Ok(Some(verify_work(project_id, &current_epoch_id, reason)?));
    };

    let latest_epoch_matches =
        latest.semantic_epoch_id.as_deref() == Some(current_epoch_id.as_str());
    match latest.run_kind.as_str() {
        "backfill" => {
            if !latest_epoch_matches || latest.status == "completed" {
                Ok(Some(verify_work(project_id, &current_epoch_id, reason)?))
            } else {
                Ok(Some(DesiredWork::new_with_epoch(
                    project_id.to_string(),
                    AutomaticRunKind::Backfill,
                    LEGACY_BACKFILL_WORK_KEY,
                    latest.semantic_epoch_id,
                    reason.to_string(),
                )?))
            }
        }
        VERIFY_RUN_KIND => {
            control.check(GraphWorkStage::Coverage)?;
            if !latest_epoch_matches || latest.status != "completed" {
                return Ok(Some(verify_work(project_id, &current_epoch_id, reason)?));
            }
            let Some(outcome_json) = latest.outcome_summary_json.as_deref() else {
                return Ok(Some(verify_work(project_id, &current_epoch_id, reason)?));
            };
            let report = match validate_discovered_verify_outcome(
                conn,
                project_id,
                latest.work_key.as_deref().unwrap_or_default(),
                &current_epoch_id,
                outcome_json,
                control,
            ) {
                Ok(report) => report,
                Err(error) if is_maintenance_control_or_cleanup_error(&error) => {
                    return Err(error);
                }
                Err(_) => return Ok(Some(verify_work(project_id, &current_epoch_id, reason)?)),
            };
            if report.requires_rebuild() {
                return Ok(Some(DesiredWork::new_with_epoch(
                    project_id.to_string(),
                    AutomaticRunKind::RebuildDerived,
                    REBUILD_DERIVED_WORK_KEY,
                    Some(current_epoch_id),
                    reason.to_string(),
                )?));
            }
            // A graph defect is terminal/manual evidence, not an automatic
            // Repair route. A clean report is reusable only when its CAS
            // evidence is present and current; old reports are re-run once
            // to seal the current coordinates.
            if report.is_clean() {
                control.check(GraphWorkStage::Coverage)?;
                let expected = verify_skip_expectation(project_id, &current_epoch_id, coordinates)?;
                let decision = super::maintenance_skip_evidence::evaluate_completed_run_skip_with_control(
                    conn,
                    &expected,
                    control,
                )?;
                if !matches!(decision, CompletedRunSkipDecision::Skip { .. }) {
                    return Ok(Some(verify_work(project_id, &current_epoch_id, reason)?));
                }
                if latest_completed_rebuild.as_ref().is_some_and(|run| {
                    !completed_rebuild_outcome_is_current(project_id, &current_epoch_id, run)
                }) {
                    return Ok(Some(DesiredWork::new_with_epoch(
                        project_id.to_string(),
                        AutomaticRunKind::RebuildDerived,
                        REBUILD_DERIVED_WORK_KEY,
                        Some(current_epoch_id),
                        reason.to_string(),
                    )?));
                }
                if reason == BEFORE_CUTOVER_FOLLOW_UP_REASON
                    && !latest_completed_rebuild.as_ref().is_some_and(|run| {
                        completed_rebuild_outcome_is_current(project_id, &current_epoch_id, run)
                    })
                {
                    // The first BeforeCutover wake is deliberately Verify-
                    // owned. Once that Verify has completed, this internal
                    // follow-up reason is the durable hand-off to the
                    // conditional Rebuild; it is never accepted from a
                    // renderer or an arbitrary N-API caller.
                    return Ok(Some(DesiredWork::new_with_epoch(
                        project_id.to_string(),
                        AutomaticRunKind::RebuildDerived,
                        REBUILD_DERIVED_WORK_KEY,
                        Some(current_epoch_id),
                        reason.to_string(),
                    )?));
                }
                return Ok(None);
            }
            if report.is_incomplete_only() {
                // Missing evidence is transient at this boundary. In
                // particular, a new project's feed may exist before the
                // Freshness cursor is published. Wait for that durable
                // producer anchor so a later wake can rediscover and
                // re-Verify; do not turn incomplete evidence into a manual
                // graph-repair Finding.
                return Ok(None);
            }
            // Non-clean and not rebuildable: duplicate Edges, cross-project
            // consumer scope, or other defects that only a manual Repair can
            // fix. Automatic maintenance halts here on every wake, so the
            // halt must be visible: project the durable
            // semantic-graph-requires-repair Finding (idempotent per report
            // digest) before returning no work. A later clean confirmation
            // Verify for this epoch resolves it.
            let report_digest =
                serde_json::from_str::<Value>(outcome_json)
                    .ok()
                    .and_then(|outcome| {
                        outcome
                            .get("reportDigest")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
            if let Some(report_digest) = report_digest {
                control.check(GraphWorkStage::ResultAssembly)?;
                let observed_at = grimodex_core::now_rfc3339_millis();
                super::terminal_failure::project_graph_repair_required_in_tx(
                    conn,
                    project_id,
                    &latest.run_id,
                    &current_epoch_id,
                    &report_digest,
                    &observed_at,
                )?;
            }
            control.check(GraphWorkStage::ResultAssembly)?;
            Ok(None)
        }
        "semantic-index-rebuild" => {
            if !latest_epoch_matches || latest.status == "completed" {
                Ok(Some(verify_work(project_id, &current_epoch_id, reason)?))
            } else {
                Ok(Some(DesiredWork::new_with_epoch(
                    project_id.to_string(),
                    AutomaticRunKind::RebuildDerived,
                    REBUILD_DERIVED_WORK_KEY,
                    Some(current_epoch_id),
                    reason.to_string(),
                )?))
            }
        }
        _ => Ok(Some(verify_work(project_id, &current_epoch_id, reason)?)),
    }
}

/// A completed Rebuild is a prerequisite for reusing a clean Verify result
/// only when its terminal success evidence is still understood by this
/// writer.  Treat every missing, malformed, stale, or non-canonical outcome
/// as a rebuild request; discovery remains fail-closed and never trusts a
/// contract coordinate merely because the Run is marked `completed`.
fn completed_rebuild_outcome_is_current(
    project_id: &str,
    semantic_epoch_id: &str,
    run: &DurableMaintenanceRun,
) -> bool {
    let Some(outcome_json) = run.outcome_summary_json.as_deref() else {
        return false;
    };
    let Ok(outcome) = serde_json::from_str::<Value>(outcome_json) else {
        return false;
    };
    if outcome.get("failure").is_some() {
        return false;
    }
    validate_phase_success_outcome(
        "semantic-index-rebuild",
        project_id,
        run.work_key.as_deref().unwrap_or_default(),
        Some(semantic_epoch_id),
        &outcome,
    )
    .is_ok()
}

const BEFORE_CUTOVER_FOLLOW_UP_REASON: &str = "before-cutover-follow-up";

fn maintenance_rediscovery_reason(item: &DesiredWork) -> &str {
    if item.run_kind == AutomaticRunKind::Verify
        && item.reasons.iter().any(|reason| {
            matches!(
                reason.as_str(),
                "before-cutover" | BEFORE_CUTOVER_FOLLOW_UP_REASON
            )
        })
    {
        return BEFORE_CUTOVER_FOLLOW_UP_REASON;
    }
    item.reasons
        .first()
        .map(String::as_str)
        .unwrap_or("durable-wake")
}

fn validate_discovered_verify_outcome(
    conn: &Connection,
    project_id: &str,
    work_key: &str,
    semantic_epoch_id: &str,
    outcome_json: &str,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<DependencyGraphVerifyReport> {
    control.check(GraphWorkStage::Serialization)?;
    let outcome: Value = serde_json::from_str(outcome_json).with_context(|| {
        "NEX_MAINTENANCE_VERIFY_OUTCOME_INVALID: completed Verify outcome is not JSON"
    })?;
    validate_phase_success_outcome(
        VERIFY_RUN_KIND,
        project_id,
        work_key,
        Some(semantic_epoch_id),
        &outcome,
    )?;
    validate_graph_state_digest_with_control(
        conn,
        project_id,
        outcome
            .get("graphStateDigest")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Verify outcome has no graph state digest"))?,
        control,
    )?;
    let report: DependencyGraphVerifyReport = serde_json::from_value(
        outcome
            .get("report")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Verify outcome has no report"))?,
    )
    .context("NEX_MAINTENANCE_VERIFY_OUTCOME_INVALID: Verify report shape is invalid")?;
    control.check(GraphWorkStage::Coverage)?;
    validate_report_rebuild_required_with_control(conn, project_id, &report, control).context(
        "NEX_MAINTENANCE_VERIFY_OUTCOME_INVALID: rebuildRequired does not match live repairability",
    )?;
    anyhow::ensure!(
        outcome.get("failure").is_none(),
        "NEX_MAINTENANCE_VERIFY_OUTCOME_INVALID: completed Verify outcome carries failure detail"
    );
    validate_canonical_verify_outcome_digest(&outcome)
        .context("NEX_MAINTENANCE_VERIFY_OUTCOME_INVALID: Verify outcome digest is invalid")?;
    validate_verify_check_coverage(&outcome)
        .context("NEX_MAINTENANCE_VERIFY_OUTCOME_INVALID: Verify check coverage is invalid")?;
    control.check(GraphWorkStage::Serialization)?;
    Ok(report)
}

fn validate_live_verify_outcome_rebuild_requirement(
    conn: &Connection,
    project_id: &str,
    outcome: &Value,
) -> anyhow::Result<()> {
    let graph_state_digest = outcome
        .get("graphStateDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Verify outcome has no graph state digest"))?;
    validate_graph_state_digest(conn, project_id, graph_state_digest)?;
    let report: DependencyGraphVerifyReport = serde_json::from_value(
        outcome
            .get("report")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Verify outcome has no report"))?,
    )?;
    validate_report_rebuild_required(conn, project_id, &report)
}

/// Discover durable work with a CI-only trigger resolved by Native. This
/// adapter keeps configuration parsing and coordinate selection out of the
/// renderer-facing DTO while allowing the product journey to exercise the
/// same skip-evidence mismatch as a real contract change.
pub fn discover_durable_maintenance_work_with_config(
    db: &Database,
    project_id: &str,
    reason: &str,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
) -> anyhow::Result<Option<DesiredWork>> {
    let coordinates = effective_maintenance_coordinates(ci_config)?;
    discover_durable_maintenance_work_with_coordinates(db, project_id, reason, Some(&coordinates))
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

/// Match a rediscovered work item to the exact foreground Run owned by this
/// cycle.  Backfill creates the initial Semantic Epoch as part of dispatch,
/// so its active durable row is rediscovered with an epoch-bound identity even
/// though the immutable foreground marker was intentionally created from the
/// epochless pre-dispatch WorkKey.  The run id/marker equality check remains
/// the authority boundary; this helper only admits that one canonical
/// Backfill identity transition and never broadens suppression to a different
/// phase.
fn foreground_owned_run_matches_work(
    owned: &ForegroundSystemWorkRun,
    item: &DesiredWork,
) -> anyhow::Result<bool> {
    if owned.project_id != item.project_id {
        return Ok(false);
    }
    if owned.marker.canonical_work_key == item.canonical_key() {
        return Ok(true);
    }
    if item.run_kind != AutomaticRunKind::Backfill {
        return Ok(false);
    }
    Ok(owned.marker.canonical_work_key
        == canonical_work_key_for_epoch(
            &item.project_id,
            AutomaticRunKind::Backfill,
            &item.work_key,
            None,
        )?)
}

fn is_backfill_wake(reason: &str) -> bool {
    matches!(
        reason,
        "workspace-opened" | "legacy-backfill-required" | "durable-wake" | "before-cutover"
    )
}

fn verify_skip_expectation(
    project_id: &str,
    semantic_epoch_id: &str,
    coordinates: Option<&MaintenanceContractCoordinates>,
) -> anyhow::Result<CompletedRunSkipExpectation> {
    let owned_coordinates = match coordinates {
        Some(coordinates) => coordinates.clone(),
        None => current_maintenance_coordinates()?,
    };
    Ok(CompletedRunSkipExpectation {
        project_id: project_id.to_string(),
        run_kind: VERIFY_RUN_KIND.to_string(),
        work_key: format!("{VERIFY_RUN_KIND}:{semantic_epoch_id}"),
        semantic_epoch_id: semantic_epoch_id.to_string(),
        graph_contract_digest: owned_coordinates.graph_contract_digest,
        rule_registry_digest: owned_coordinates.rule_registry_digest,
        producer_generation_set_digest: owned_coordinates.producer_generation_set_digest,
        rebuild_contract_version: REBUILD_CONTRACT_VERSION.to_string(),
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
    run_system_work_cycle_with_modes_and_config_and_foreground_owner(
        db, request, mode_for, ci_config, None,
    )
}

/// Execute a cycle while retaining one exact foreground Run owned by an
/// earlier cycle in the same process.  The owner is never trusted from the
/// caller alone: it must still be the unique running durable marker for the
/// current CI seam and workspace binding before it can suppress recovery.
///
/// A fresh process passes `None`, so a durable running row is still handled by
/// [`RecoveryMode::StartupRecovery`].  This is the narrow seam needed for the
/// Electron `hasMore` follow-up cycle: the process-local N-API state carries
/// the exact Run ID and immutable marker across cycles without making a
/// canonical WorkKey a substitute for Run identity.
pub fn run_system_work_cycle_with_modes_and_config_and_foreground_owner(
    db: &Database,
    request: &MaintenanceCycleRequest,
    mode_for: impl Fn(&DesiredWork) -> RecoveryMode,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
    foreground_owner: Option<&ForegroundSystemWorkRun>,
) -> anyhow::Result<MaintenanceCycleResult> {
    run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
        db,
        request,
        mode_for,
        ci_config,
        foreground_owner,
        None,
    )
}

/// Execute a cycle with an optional process-local cancellation/completion
/// control. Existing callers use the owner function above and retain the
/// same behavior; Native maintenance supplies this control so cancellation
/// reaches the actual Rust work loop before another durable phase starts.
pub fn run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
    db: &Database,
    request: &MaintenanceCycleRequest,
    mode_for: impl Fn(&DesiredWork) -> RecoveryMode,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
    _foreground_owner: Option<&ForegroundSystemWorkRun>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<MaintenanceCycleResult> {
    if let Some(control) = control {
        (control.should_stop)()?;
    }
    let effective_coordinates = effective_maintenance_coordinates(ci_config)?;
    if let Some(binding) = request.workspace_binding.as_ref() {
        binding.validate()?;
    }
    let mut work = preflight_maintenance_cycle_request(request)?;
    if work.is_empty() {
        for project_id in &request.wake_project_ids {
            if let Some(next) = discover_cycle_work(
                db,
                project_id,
                "durable-wake",
                Some(&effective_coordinates),
                control,
            )? {
                work.push(next);
            }
        }
    }

    // Keep the wire item in the queue so stale/epoch-less provenance remains
    // available to the recovery branch, but register every effective identity
    // before the first item can complete. Otherwise a two-item initial batch
    // can let item one observe an apparently empty registry and close the
    // attempt before item two has been dequeued.
    let normalize_work_item = |item: &DesiredWork| -> anyhow::Result<DesiredWork> {
        let recovery_work = recovery_work_key_for_item(db, item)?;
        Ok(DesiredWork {
            semantic_epoch_id: recovery_work.semantic_epoch_id.clone(),
            ..item.clone()
        })
    };
    if let Some(control) = control {
        for item in &work {
            let effective_item = normalize_work_item(item)?;
            (control.register_work)(&effective_item)?;
        }
    }
    let mut queue = std::collections::VecDeque::from(work.clone());
    let mut dequeue_count = 0usize;
    let mut dispatched_any = false;
    let mut coalesced_active = false;
    let mut handled_non_coalesced = false;
    let mut has_more = false;
    let mut foreground_held = false;
    let foreground_durable_run = match (ci_config, request.workspace_binding.as_ref()) {
        (Some(config), Some(binding))
            if config.trigger == Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake)
                && config.product_journey_barrier_id.is_some()
                && config.correlation.is_some() =>
        {
            find_running_foreground_system_work_run(db, config, binding)?
        }
        _ => None,
    };
    let foreground_slot_run = match (ci_config, request.workspace_binding.as_ref()) {
        (Some(config), Some(binding))
            if config.trigger == Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake)
                && config.product_journey_barrier_id.is_some()
                && config.correlation.is_some() =>
        {
            find_running_foreground_system_work_slot(db, config, binding)?
        }
        _ => None,
    };
    // A durable current marker consumes the one foreground marker slot even
    // after a process restart, when no process-local owner is available. The
    // restarted Run still goes through StartupRecovery below, but any fresh
    // replacement is deliberately unmarked so recovery cannot create a
    // second running marker for the same barrier.
    let mut foreground_marker_available = foreground_slot_run.is_none();
    // A durable terminal/manual outcome is a handled no-op for this
    // automatic identity. Keep the halt scoped to the canonical WorkKey so a
    // different project, phase, work-key version, or Semantic Epoch remains
    // eligible in the same bounded cycle. This also prevents the final
    // durable rediscovery check from turning a terminal Inbox item into a
    // scheduler retry wake.
    let mut terminal_halted_work = BTreeSet::new();
    // Only the exact current foreground Run may suppress its same-key
    // rediscovery. A canonical-key-only set would also suppress the ordinary
    // Verify confirmation after a Verify -> Rebuild phase chain. The durable
    // lookup below keeps this bounded to the marked Run while it is still
    // running, including after process restart when no owner handle exists.
    let mut project_ids = BTreeSet::new();
    // A selector/ledger failure is durable manual work, not an Electron
    // delivery retry. Discovery cannot safely choose a next phase for that
    // project after the current cycle has projected the error, so suppress
    // only the final automatic rediscovery pass for it.
    let mut selector_halted_projects = BTreeSet::new();
    let check_stop = || -> anyhow::Result<()> {
        if let Some(control) = control {
            (control.should_stop)()?;
        }
        Ok(())
    };
    let mark_completed = |item: &DesiredWork| -> anyhow::Result<()> {
        if let Some(control) = control {
            (control.work_completed)(item)?;
        }
        Ok(())
    };
    let mark_noop_completed = |item: &DesiredWork| -> anyhow::Result<()> {
        if let Some(control) = control {
            (control.work_noop_completed)(item)?;
        }
        Ok(())
    };
    let mark_deferred = |item: &DesiredWork| -> anyhow::Result<()> {
        if let Some(control) = control {
            (control.work_deferred)(item)?;
        }
        Ok(())
    };
    let enqueue_discovered = |queue: &mut std::collections::VecDeque<DesiredWork>,
                              item: DesiredWork|
     -> anyhow::Result<()> {
        if let Some(control) = control {
            let effective_item = normalize_work_item(&item)?;
            (control.register_work)(&effective_item)?;
        }
        queue.push_back(item);
        Ok(())
    };
    while let Some(item) = queue.pop_front() {
        check_stop()?;
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

        let recovery_work = recovery_work_key_for_item(db, &item)?;
        let recovery_work_key = recovery_work.canonical_key();
        // The RecoveryMode gate and the recovery decision must key on the
        // same effective WorkKey. A stale or epoch-less wire item is
        // normalized to the current Semantic Epoch before recovery, so the
        // mode lookup has to see that exact normalized identity too —
        // otherwise a StartupRecovery mode registered for the stale key can
        // be applied to the current-epoch key and terminalize a Run that is
        // live in this process.
        let effective_item = normalize_work_item(&item)?;
        if let Some(control) = control {
            // The durable planner may normalize a stale or epoch-less request
            // to a different canonical identity. The exact identity was
            // registered before this cycle began (or while it was enqueued as
            // a follow-up); use that same value for start, adapter dispatch,
            // finalization, and completion.
            (control.work_started)(&effective_item)?;
        }

        if terminal_halted_work.contains(&recovery_work_key) {
            // The duplicate is already registered in this attempt (initial
            // work is registered before dequeue, discovered work before it is
            // queued). Consume that exact execution before skipping it. If it
            // were left `running`, attempt finalization would wait forever
            // and the durable wake would rediscover the same halted key.
            mark_noop_completed(&effective_item)?;
            continue;
        }

        let foreground_run_is_held = if let Some(candidate) = foreground_durable_run.as_ref() {
            if !foreground_owned_run_matches_work(candidate, &effective_item)? {
                false
            } else if let (Some(config), Some(binding)) =
                (ci_config.as_ref(), request.workspace_binding.as_ref())
            {
                // Re-read the exact durable row so a release that races this
                // bounded cycle cannot be mistaken for a held lifecycle.
                find_running_foreground_system_work_run(db, config, binding)?
                    .as_ref()
                    .is_some_and(|current| current == candidate)
            } else {
                false
            }
        } else {
            false
        };
        if foreground_run_is_held {
            // The exact marked Run is still durable and running. Do not feed
            // it back through StartupRecovery before the N-API cycle ACK, and
            // do not let the caller report strict adapter success for it.
            foreground_held = true;
            mark_deferred(&effective_item)?;
            break;
        }

        // Verify-only completed-run skip is checked before recovery. Rebuild
        // completed rows are intentionally never reused.
        // The legacy completed-run skip reader has no process-local control
        // and performs a full-set scan. During a Native cycle bypass it so a
        // controlled Verify owns the same no-wait connection, progress hook,
        // and cancellation path as every other Graph phase.
        if control.is_none() && item.run_kind == AutomaticRunKind::Verify
            && !item.reasons.iter().any(|reason| {
                matches!(
                    reason.as_str(),
                    "before-cutover" | BEFORE_CUTOVER_FOLLOW_UP_REASON
                )
            })
        {
            let expected = verify_skip_expectation(
                &item.project_id,
                effective_item
                    .semantic_epoch_id
                    .as_deref()
                    .unwrap_or_default(),
                Some(&effective_coordinates),
            )?;
            let decision = db.with_conn(|conn| evaluate_completed_run_skip(conn, &expected))?;
            if matches!(decision, CompletedRunSkipDecision::Skip { .. }) {
                let next = discover_cycle_work(
                    db,
                    &item.project_id,
                    maintenance_rediscovery_reason(&item),
                    Some(&effective_coordinates),
                    control,
                )?;
                match next {
                    Some(next) if next.canonical_key() != item.canonical_key() => {
                        // The completed Verify was handled, and discovery
                        // handed the cycle to a different canonical phase.
                        handled_non_coalesced = true;
                        enqueue_discovered(&mut queue, next)?;
                        mark_noop_completed(&effective_item)?;
                        continue;
                    }
                    Some(_) => {
                        // Discovery returned this same Verify as a required
                        // confirmation after a newer Rebuild. Keep the item
                        // on the dispatch path instead of reusing the clean
                        // pre-Rebuild evidence a second time.
                    }
                    None => {
                        // No follow-up remains: the completed Verify itself
                        // was the handled item in this cycle.
                        handled_non_coalesced = true;
                        mark_noop_completed(&effective_item)?;
                        continue;
                    }
                }
            }
        }

        let action = match recover_cycle_work(db, &effective_item, mode_for(&effective_item)) {
            Ok(action) => action,
            Err(error) if is_maintenance_control_or_cleanup_error(&error) => return Err(error),
            Err(error) if item.run_kind == AutomaticRunKind::RebuildDerived => {
                project_ledger_selector_manual_intervention(db, &recovery_work, &error)?;
                handled_non_coalesced = true;
                terminal_halted_work.insert(recovery_work_key);
                selector_halted_projects.insert(recovery_work.project_id.clone());
                mark_noop_completed(&effective_item)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        match action {
            RecoveryAction::CoalescedRunning { .. } | RecoveryAction::CoalescedPending { .. } => {
                coalesced_active = true;
                has_more = true;
                mark_noop_completed(&effective_item)?;
                continue;
            }
            RecoveryAction::SkipCompleted { .. } => {
                handled_non_coalesced = true;
                // Backfill's completed row is only the durable marker for the
                // next Verify phase. No completed Rebuild can enter this arm.
                if item.run_kind == AutomaticRunKind::Backfill {
                    if let Some(next) = discover_cycle_work(
                        db,
                        &item.project_id,
                        maintenance_rediscovery_reason(&item),
                        Some(&effective_coordinates),
                        control,
                    )? {
                        enqueue_discovered(&mut queue, next)?;
                    }
                }
                mark_noop_completed(&effective_item)?;
                continue;
            }
            RecoveryAction::ManualIntervention { code } => {
                // A contract failure's durable Run already owns the terminal
                // failure and its Inbox projection. Recovery-synthesized
                // codes (retry exhausted, missing detail/ledger) have no
                // failing finalizer of their own, so project them here —
                // otherwise automatic maintenance halts with nothing in the
                // Maintenance Inbox to explain why or how to recover.
                super::terminal_failure::project_manual_intervention_finding(
                    db,
                    &recovery_work,
                    &code,
                )?;
                handled_non_coalesced = true;
                terminal_halted_work.insert(recovery_work_key);
                mark_noop_completed(&effective_item)?;
                continue;
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
                if matches!(action, RecoveryAction::Retry { .. }) {
                    // Honor the durable exponential backoff boundary written
                    // by the failing Attempt. A retry earlier than its
                    // not-before instant is refused; the durable wake keeps
                    // the scheduler polling until the boundary passes, so
                    // the 1s -> 2s -> 4s policy holds across restarts too.
                    //
                    // The failure policy's invariant is "next_attempt_at is
                    // set iff retryDisposition is retryable", so a Retry
                    // decision whose durable not-before is missing or
                    // unparseable is broken retry evidence, not permission
                    // to dispatch immediately: fail closed to manual.
                    let retry_evidence = match retry_not_before(db, &recovery_work) {
                        Ok(evidence) => evidence,
                        Err(error) if is_maintenance_control_or_cleanup_error(&error) => {
                            return Err(error);
                        }
                        Err(error) => {
                            project_ledger_selector_manual_intervention(
                                db,
                                &recovery_work,
                                &error,
                            )?;
                            handled_non_coalesced = true;
                            terminal_halted_work.insert(recovery_work_key);
                            selector_halted_projects.insert(recovery_work.project_id.clone());
                            mark_noop_completed(&effective_item)?;
                            continue;
                        }
                    };
                    match retry_evidence {
                        RetryEvidence::NoFailedAttempt => {
                            // A run-level terminal code with no Attempt
                            // ledger (older writer, import): the run-level
                            // recovery classification governs dispatch.
                        }
                        RetryEvidence::NotBefore(Some(not_before)) => {
                            match parse_maintenance_instant(&not_before) {
                                Ok(not_before_at) => {
                                    if chrono::Utc::now() < not_before_at {
                                        has_more = true;
                                        mark_noop_completed(&effective_item)?;
                                        continue;
                                    }
                                }
                                Err(_) => {
                                    super::terminal_failure::project_manual_intervention_finding(
                                        db,
                                        &recovery_work,
                                        "NEX_MAINTENANCE_RETRY_EVIDENCE_INVALID",
                                    )?;
                                    handled_non_coalesced = true;
                                    terminal_halted_work.insert(recovery_work_key);
                                    mark_noop_completed(&effective_item)?;
                                    continue;
                                }
                            }
                        }
                        RetryEvidence::NotBefore(None) => {
                            super::terminal_failure::project_manual_intervention_finding(
                                db,
                                &recovery_work,
                                "NEX_MAINTENANCE_RETRY_EVIDENCE_INVALID",
                            )?;
                            handled_non_coalesced = true;
                            terminal_halted_work.insert(recovery_work_key);
                            mark_noop_completed(&effective_item)?;
                            continue;
                        }
                    }
                }
                // A Rebuild that already committed under the current epoch
                // and contract must not be re-executed merely because
                // another item in the same Electron batch failed and the
                // whole batch was re-queued: Rebuild is the expensive phase
                // and each item commits its own transaction. When such a
                // committed outcome exists, reconcile the re-sent item
                // against the durable state machine and only dispatch when
                // discovery still demands this exact canonical Rebuild (for
                // example a newer Verify requires a fresh one).
                let committed_current_rebuild = if item.run_kind == AutomaticRunKind::RebuildDerived
                {
                    match recovery_work.semantic_epoch_id.as_deref() {
                        Some(epoch) => {
                            match has_committed_current_rebuild(db, &recovery_work, epoch) {
                                Ok(committed) => committed,
                                Err(error)
                                    if is_maintenance_control_or_cleanup_error(&error) =>
                                {
                                    return Err(error);
                                }
                                Err(error) => {
                                    project_ledger_selector_manual_intervention(
                                        db,
                                        &recovery_work,
                                        &error,
                                    )?;
                                    handled_non_coalesced = true;
                                    terminal_halted_work.insert(recovery_work_key);
                                    selector_halted_projects
                                        .insert(recovery_work.project_id.clone());
                                    mark_noop_completed(&effective_item)?;
                                    continue;
                                }
                            }
                        }
                        None => false,
                    }
                } else {
                    false
                };
                if committed_current_rebuild {
                    let next = discover_cycle_work(
                        db,
                        &item.project_id,
                        maintenance_rediscovery_reason(&item),
                        Some(&effective_coordinates),
                        control,
                    )?;
                    match next {
                        Some(next) if next.canonical_key() != item.canonical_key() => {
                            // The durable ledger moved past this Rebuild
                            // (it committed before the batch failure); hand
                            // the cycle its real next phase.
                            handled_non_coalesced = true;
                            enqueue_discovered(&mut queue, next)?;
                            mark_noop_completed(&effective_item)?;
                            continue;
                        }
                        None => {
                            handled_non_coalesced = true;
                            mark_noop_completed(&effective_item)?;
                            continue;
                        }
                        Some(_) => {
                            // Discovery still demands this exact Rebuild.
                        }
                    }
                }
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
                    handled_non_coalesced = true;
                    if let Some(next) = discover_cycle_work(
                        db,
                        &item.project_id,
                        maintenance_rediscovery_reason(&item),
                        Some(&effective_coordinates),
                        control,
                    )? {
                        enqueue_discovered(&mut queue, next)?;
                    }
                    mark_noop_completed(&effective_item)?;
                    continue;
                }
                let marker = if foreground_marker_available {
                    ci_config.and_then(|config| {
                        request
                            .workspace_binding
                            .as_ref()
                            .and_then(|binding| config.foreground_marker(&effective_item, binding))
                    })
                } else {
                    None
                };
                let dispatch_outcome = match with_system_work_marker(marker.clone(), || {
                    check_stop()?;
                    dispatch_enabled_work(
                        db,
                        &effective_item,
                        Some(&effective_coordinates),
                        control,
                    )
                }) {
                    Ok(outcome) => outcome,
                    Err(error)
                        if control.is_some()
                            && is_transient_maintenance_preemption(&error) =>
                    {
                        // A foreground waiter won a phase-scoped no-wait
                        // handoff. Park this exact execution in the Native
                        // receipt and return an accepted-but-interrupted
                        // cycle so the main scheduler requeues it without
                        // treating contention as adapter-disabled work or a
                        // persisted delivery failure.
                        mark_deferred(&effective_item)?;
                        return Ok(MaintenanceCycleResult::accepted(true));
                    }
                    Err(error) => return Err(error),
                };
                if matches!(dispatch_outcome, MaintenanceDispatchOutcome::ForegroundHeld) {
                    // The adapter has already persisted its real successful
                    // outcome and deliberately left the lifecycle running.
                    // Complete only the queue bookkeeping; the native owner
                    // must park/requeue this delivery until exact barrier
                    // release rather than granting finalization here.
                    foreground_held = true;
                    mark_deferred(&effective_item)?;
                    break;
                }
                // Register the next phase before marking this item complete.
                // The per-work completion transition may close the attempt
                // when this was the final registered item.
                let next = match discover_cycle_work(
                    db,
                    &item.project_id,
                    maintenance_rediscovery_reason(&item),
                    Some(&effective_coordinates),
                    control,
                ) {
                    Ok(next) => next,
                    Err(error) => {
                        // The adapter's final success transaction already
                        // acquired the per-work finalize grant.  Preserve
                        // that durable success even when cancellation or a
                        // discovery read arrives immediately afterwards.
                        mark_completed(&effective_item)?;
                        return Err(error);
                    }
                };
                if let Some(next) = next {
                    if let Err(error) = enqueue_discovered(&mut queue, next) {
                        // See the discovery-error case above: the current
                        // work has already crossed its finalization boundary.
                        mark_completed(&effective_item)?;
                        return Err(error);
                    }
                }
                mark_completed(&effective_item)?;
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
                    }
                }
                if marker.is_some() {
                    foreground_marker_available = false;
                }
                dispatched_any = true;
            }
        }
    }

    check_stop()?;
    if foreground_held {
        return Ok(MaintenanceCycleResult::deferred(false));
    }
    has_more |= !queue.is_empty();
    if !has_more {
        for project_id in project_ids {
            if selector_halted_projects.contains(&project_id) {
                continue;
            }
            if let Some(next) = discover_cycle_work(
                db,
                &project_id,
                "durable-wake",
                Some(&effective_coordinates),
                control,
            )? {
                let next_key = recovery_work_key_for_item(db, &next)?.canonical_key();
                if !terminal_halted_work.contains(&next_key) {
                    has_more = true;
                    break;
                }
            }
        }
    }
    check_stop()?;
    Ok(
        if !dispatched_any && coalesced_active && !handled_non_coalesced {
            MaintenanceCycleResult::coalesced(has_more)
        } else {
            MaintenanceCycleResult::accepted(has_more)
        },
    )
}

/// The Rebuild duplicate-suppression path is an optimization, but its ledger
/// selector has the same fail-closed chronology contract as normal recovery.
/// Do not turn a malformed/tied/read-failed selector into a false "absent"
/// result and dispatch a new expensive Rebuild beside the broken evidence.
fn has_committed_current_rebuild(
    db: &Database,
    work: &WorkKey,
    semantic_epoch_id: &str,
) -> anyhow::Result<bool> {
    db.with_conn(|conn| {
        let runs = load_durable_maintenance_runs(conn, &work.project_id)?;
        let selected = select_latest_relevant_run(&runs, Some(semantic_epoch_id), false, |run| {
            run.run_kind == "semantic-index-rebuild" && run.status == "completed"
        })?;
        Ok(selected.is_some_and(|run| {
            completed_rebuild_outcome_is_current(&work.project_id, semantic_epoch_id, &run)
        }))
    })
}

/// Surface a recovery selector failure through the same durable Maintenance
/// Inbox projection used by other automatic halts. The exact ambiguity code
/// is preserved; malformed/read errors get a stable generic code rather than
/// being silently treated as a missing completed Rebuild.
fn project_ledger_selector_manual_intervention(
    db: &Database,
    work: &WorkKey,
    error: &anyhow::Error,
) -> anyhow::Result<()> {
    // Connection ownership and lifecycle stop signals are process-local
    // scheduling outcomes.  They must remain retryable at the caller and can
    // never be converted into a durable selector Finding, even if a wrapped
    // operation/cleanup error reaches this helper through a future recovery
    // path.
    if is_maintenance_control_or_cleanup_error(error) {
        anyhow::bail!("{error:#}");
    }
    let code = match explicit_failure_code(&error.to_string()) {
        Some("NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS") => "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS",
        _ => "NEX_MAINTENANCE_LEDGER_SELECTOR_INVALID",
    };
    let projected = super::terminal_failure::project_manual_intervention_finding(db, work, code)?;
    anyhow::ensure!(
        projected.is_some(),
        "NEX_MAINTENANCE_LEDGER_SELECTOR_INVALID: selector failure has no durable manual Finding anchor"
    );
    Ok(())
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
    let work_key = recovery_work_key_for_item(db, item)?;
    let expected_epoch = work_key.semantic_epoch_id.as_deref();
    let decision = decide_run_recovery_for_epoch(db, &work_key, expected_epoch, mode, None)?;
    let terminalized = match decision.action {
        RecoveryAction::RecoverInterrupted { run_ids } => {
            terminalize_interrupted_runs_for_epoch(
                db,
                &item.project_id,
                &work_key,
                expected_epoch,
                &run_ids,
            )?;
            true
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
            true
        }
        action => return Ok(action),
    };
    debug_assert!(terminalized);
    // Startup interruption must not bypass the bounded failure policy: an
    // unconditional StartFresh here would let crash -> restart -> new Run
    // loop forever with `NEX_MAINTENANCE_INTERRUPTED maxAttempts` never
    // applied. Re-load the updated ledger and route the terminalized rows
    // through the ordinary recovery decision (retry with durable backoff,
    // exhausted -> manual intervention).
    let second = decide_run_recovery_for_epoch(
        db,
        &work_key,
        expected_epoch,
        RecoveryMode::SameProcessLive,
        None,
    )?;
    match second.action {
        RecoveryAction::RecoverInterrupted { .. } | RecoveryAction::RecoverStaleEpoch { .. } => {
            anyhow::bail!("NEX_MAINTENANCE_RECOVERY_INCOMPLETE: active Run remained after recovery")
        }
        action => Ok(action),
    }
}

/// Epoch-normalized canonical recovery key for one wire item. The N-API
/// recovery gate must mark exactly the identity the cycle recovered — the
/// normalized key — not the possibly stale/epoch-less wire key, or the two
/// sides of the gate track different identities forever.
pub fn recovery_canonical_key(db: &Database, item: &DesiredWork) -> anyhow::Result<String> {
    Ok(recovery_work_key_for_item(db, item)?.canonical_key())
}

/// Resolve the exact durable identity used by recovery for one requested
/// item. Epochless legacy Backfill requests are scoped to the current Epoch
/// once one exists, matching [`recover_cycle_work`] and preventing a handled
/// terminal Backfill from being rediscovered under a different canonical key.
fn recovery_work_key_for_item(db: &Database, item: &DesiredWork) -> anyhow::Result<WorkKey> {
    let current_epoch = db
        .with_conn(|conn| super::semantic_epoch::get_current_epoch(conn, &item.project_id))?
        .map(|epoch| epoch.id);
    let expected_epoch = current_epoch
        .as_deref()
        .filter(|current| item.semantic_epoch_id.as_deref() != Some(*current))
        .or(item.semantic_epoch_id.as_deref());
    WorkKey::new_with_epoch(
        item.project_id.clone(),
        item.run_kind,
        item.work_key.clone(),
        expected_epoch.map(str::to_string),
    )
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

fn dispatch_enabled_work(
    db: &Database,
    item: &DesiredWork,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<MaintenanceDispatchOutcome> {
    validate_dispatch_contract(item)?;
    // This adapter uses the exact Database supplied by the live
    // WorkspaceAuthority. It owns its transaction phases but never opens a
    // second filesystem connection.
    super::maintenance_route_registry::dispatch_enabled_work(db, item, coordinates, control)
}

/// Classify foreground/no-wait contention as a transient queue outcome.  It
/// must not enter the adapter-disabled Deferred lane or the delivery-failure
/// retry budget.
pub(crate) fn is_transient_maintenance_preemption(error: &anyhow::Error) -> bool {
    !is_maintenance_connection_cleanup_failure(error)
        && (error_chain_contains(error, "NEX_MAINTENANCE_CONNECTION_PREEMPTED")
            || error_chain_contains(error, "NEX_VALIDATION_TERMINATED:foreground-preempted"))
}

fn is_maintenance_connection_cleanup_failure(error: &anyhow::Error) -> bool {
    error_chain_contains(error, "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED")
        || error_chain_contains(error, "NIR1_MAINTENANCE_CONNECTION_UNUSABLE")
        || error_chain_contains(error, "NEX_MAINTENANCE_CONNECTION_UNUSABLE")
}

fn is_maintenance_control_or_cleanup_error(error: &anyhow::Error) -> bool {
    is_transient_maintenance_preemption(error)
        || is_validation_terminated(error)
        || error_chain_contains(error, "NEX_VALIDATION_TERMINATED:")
        || error_chain_contains(error, "NEX_MAINTENANCE_ATTEMPT_CANCELLED")
        || error_chain_contains(error, "NIR1_MAINTENANCE_CONNECTION_")
}

fn error_chain_contains(error: &anyhow::Error, marker: &str) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains(marker))
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
            planned.push(before_cutover_verify_work(project_id, semantic_epoch_id)?);
        }
    }
    Ok(planned)
}

/// Construct the legacy BeforeCutover fallback item.  A clean completed
/// Verify can make durable discovery return no work; the trigger fallback must
/// still schedule that first Verify when no current Rebuild outcome exists.
/// Keeping this constructor shared with the pure trigger planner prevents the
/// controlled no-wait path from drifting into a Rebuild-only or no-op route.
fn before_cutover_verify_work(
    project_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<DesiredWork> {
    verify_work(project_id, semantic_epoch_id, "before-cutover")
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

/// Extract the leading explicit `NEX_*` code from a failure message, if any.
pub(crate) fn explicit_failure_code(message: &str) -> Option<&str> {
    message
        .split(|character: char| character == ':' || character.is_whitespace())
        .find(|token| token.starts_with("NEX_"))
}

/// Classify only failures known to be safe to retry.  Unknown failures are
/// deliberately contract/manual failures (fail closed).
///
/// Priority order is part of the failure-identity contract:
/// 1. A known explicit `NEX_*` code maps to its exact policy, no matter what
///    ambient words ("busy", "database is locked", ...) the rest of the
///    message contains — a contract violation whose detail mentions a lock
///    must not silently become a retried transient.
/// 2. An unknown explicit `NEX_*` code fails closed to manual with that code
///    preserved as the primary immutable evidence.
/// 3. Only a message with no explicit code at all falls back to the fuzzy
///    raw SQLite / I/O substring markers.
pub fn classify_failure(message: &str) -> FailureClassification {
    if let Some(code) = explicit_failure_code(message) {
        let retryable = matches!(
            code,
            "NEX_MAINTENANCE_INTERRUPTED"
                | "NEX_MAINTENANCE_TRANSIENT"
                | "NEX_MAINTENANCE_SQLITE_LOCKED"
                | "NEX_MAINTENANCE_SQLITE_IOERR"
                | "NEX_MAINTENANCE_CONNECTION_PREEMPTED"
                | "NEX_SEMANTIC_EPOCH_CHANGED"
                | "NEX_CURSOR_RESERVATION_CONFLICT"
                | "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"
                | "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED"
                | "NEX_REBUILD_DERIVED_STALE_EPOCH"
                | "NEX_VERIFY_STALE_EPOCH"
                | "NEX_VERIFY_GRAPH_STATE_CHANGED"
        );
        return FailureClassification {
            class: if retryable {
                FailureClass::Transient
            } else {
                FailureClass::Contract
            },
            code: code.to_string(),
            retryable,
        };
    }

    let lower = message.to_ascii_lowercase();
    let transient = [
        "sqlite_busy",
        "sqlite_locked",
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
    FailureClassification {
        class: FailureClass::Contract,
        code: "NEX_MAINTENANCE_UNCLASSIFIED".to_string(),
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

/// The current-epoch portion of one durable Run ledger row.  The epoch is
/// applied while loading; stale active rows are kept separately as recovery
/// provenance and cannot contaminate the current retry chain.
#[derive(Debug, Clone)]
struct RunLedgerLifecycleEvidence {
    status: String,
    terminal_reason_code: Option<String>,
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
        let (current_rows, stale_active_runs) =
            load_current_work_lifecycle_evidence(conn, work, expected_semantic_epoch_id)?;
        let retry_chain_failures = current_retry_chain_failures(&current_rows)?;
        let latest_failed = select_unique_latest_lifecycle_evidence(retry_chain_failures.clone())?;
        let pending_run_ids = current_rows
            .iter()
            .filter(|evidence| evidence.value.status == "pending")
            .map(|evidence| evidence.id.clone())
            .collect::<Vec<_>>();
        let running_run_ids = current_rows
            .iter()
            .filter(|evidence| evidence.value.status == "running")
            .map(|evidence| evidence.id.clone())
            .collect::<Vec<_>>();
        let completed_runs = current_rows
            .iter()
            .filter(|evidence| evidence.value.status == "completed")
            .count();

        Ok(RunLedgerCounts {
            pending_runs: u32::try_from(pending_run_ids.len())?,
            running_runs: u32::try_from(running_run_ids.len())?,
            failed_runs: u32::try_from(retry_chain_failures.len())?,
            completed_runs: u32::try_from(completed_runs)?,
            total_runs: u32::try_from(current_rows.len())?,
            stale_active_runs: u32::try_from(stale_active_runs.len())?,
            pending_run_ids,
            running_run_ids,
            stale_active_run_ids: stale_active_runs
                .iter()
                .map(|run| run.run_id.clone())
                .collect(),
            stale_active_run_provenance: stale_active_runs,
            latest_failed_terminal_reason_code: latest_failed
                .and_then(|evidence| evidence.value.terminal_reason_code),
        })
    })
}

/// Load one work identity's current lifecycle evidence and stale active
/// provenance.  SQL deliberately does not order rows: every consumer must
/// pass its bounded evidence set through
/// [`select_unique_latest_lifecycle_evidence`] before deriving a latest row.
fn load_current_work_lifecycle_evidence(
    conn: &Connection,
    work: &WorkKey,
    expected_semantic_epoch_id: Option<&str>,
) -> anyhow::Result<(
    Vec<LifecycleEvidence<RunLedgerLifecycleEvidence>>,
    Vec<StaleActiveRun>,
)> {
    let mut statement = conn.prepare(
        "SELECT id, status, semantic_epoch_id, terminal_reason_code,
                created_at, started_at, completed_at
           FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3",
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
        let (id, status, row_epoch_id, terminal_reason_code, created_at, started_at, completed_at) =
            row?;
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
            Err(_error) if work.run_kind == AutomaticRunKind::Backfill && status == "completed" => {
                let fallback_raw = started_at.as_deref().unwrap_or(created_at.as_str());
                parse_maintenance_instant(fallback_raw)?
            }
            Err(error) => return Err(error),
        };
        current_rows.push(LifecycleEvidence {
            id,
            lifecycle_at,
            value: RunLedgerLifecycleEvidence {
                status,
                terminal_reason_code,
            },
        });
    }
    Ok((current_rows, stale_active_runs))
}

/// Return failed rows in the current retry chain: only failures after the
/// latest completed Run in this epoch-bound work identity consume retry
/// budget.  A failure tied with a completion has no safe before/after order,
/// so it is rejected rather than silently reset or retried.
fn current_retry_chain_failures(
    current_rows: &[LifecycleEvidence<RunLedgerLifecycleEvidence>],
) -> anyhow::Result<Vec<LifecycleEvidence<RunLedgerLifecycleEvidence>>> {
    let latest_completed_at = select_unique_latest_lifecycle_evidence(
        current_rows
            .iter()
            .filter(|evidence| evidence.value.status == "completed")
            .cloned()
            .collect(),
    )?
    .map(|evidence| evidence.lifecycle_at);
    let mut failures = Vec::new();
    for evidence in current_rows {
        if evidence.value.status != "failed" {
            continue;
        }
        match latest_completed_at.as_ref() {
            Some(completed_at) if evidence.lifecycle_at == *completed_at => {
                anyhow::bail!(
                    "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS: failed Run '{}' shares its lifecycle instant with a completed Run",
                    evidence.id
                );
            }
            Some(completed_at) if evidence.lifecycle_at < *completed_at => {}
            _ => failures.push(evidence.clone()),
        }
    }
    Ok(failures)
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

    let stop = Arc::new(AtomicBool::new(false));
    let scoped = with_narrative_maintenance_graph_control(
        db,
        Duration::ZERO,
        1_000,
        stop,
        NarrativeMaintenanceGraphControlConfig::default(),
        |conn, graph| {
            graph.check(GraphWorkStage::Restore)?;
            with_immediate_transaction(conn, |conn| {
                // Recovery is itself a maintenance owner. Use the same
                // no-wait connection scope as active work so SQLite's
                // default busy timeout cannot make startup wait behind a
                // foreground writer while terminalizing stale Runs.
                graph.check(GraphWorkStage::Restore)?;
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
                            transition_run_status_in_tx(
                                conn,
                                &run_id,
                                NarrativeRunStatus::Cancelled,
                            )?;
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
                graph.check(GraphWorkStage::ResultAssembly)?;
                Ok(result)
            })
        },
    )?;
    let Some(scoped) = scoped else {
        anyhow::bail!(
            "NEX_MAINTENANCE_CONNECTION_PREEMPTED: recovery could not acquire the maintenance connection without waiting"
        );
    };
    scoped.into_result()
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

/// Durable retry not-before boundary for one work identity: the
/// `next_attempt_at` persisted by the latest failed Attempt. Dispatch must
/// not start a retry before this instant, including after a process restart.
/// The latest failed Attempt's durable retry evidence for `work`.
/// `NoFailedAttempt` means the failure carries no Attempt-level ledger at all
/// (a run-level terminal code from an older writer or an import); the
/// run-level recovery classification governs there. `NotBefore(None)` means
/// an Attempt row exists but violates the failure policy's
/// "next_attempt_at iff retryable" invariant, which is broken retry
/// evidence, not permission to dispatch immediately.
#[derive(Debug)]
enum RetryEvidence {
    NoFailedAttempt,
    NotBefore(Option<String>),
}

fn retry_not_before(db: &Database, work: &WorkKey) -> anyhow::Result<RetryEvidence> {
    db.with_conn(|conn| {
        let (current_rows, _) =
            load_current_work_lifecycle_evidence(conn, work, work.semantic_epoch_id.as_deref())?;
        let latest_failed =
            select_unique_latest_lifecycle_evidence(current_retry_chain_failures(&current_rows)?)?;
        let Some(latest_failed) = latest_failed else {
            return Ok(RetryEvidence::NoFailedAttempt);
        };

        // Failure classification and retry not-before must come from the
        // same unique failed Run.  Selecting an Attempt across all failed
        // Runs could combine one Run's terminal code with another Run's
        // backoff after a restore/import tie.
        let mut statement = conn.prepare(
            "SELECT a.id, a.completed_at, a.next_attempt_at
               FROM narrative_extraction_attempts a
               JOIN narrative_extraction_tasks t ON t.id = a.task_id
              WHERE t.run_id = ?1 AND a.status = 'failed'",
        )?;
        let attempts = statement
            .query_map(params![latest_failed.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut lifecycle_evidence = Vec::with_capacity(attempts.len());
        for (attempt_id, completed_at, next_attempt_at) in attempts {
            let Some(completed_at) = completed_at else {
                return Ok(RetryEvidence::NotBefore(None));
            };
            lifecycle_evidence.push(LifecycleEvidence {
                id: attempt_id,
                lifecycle_at: parse_maintenance_instant(&completed_at)?,
                value: next_attempt_at,
            });
        }
        Ok(
            match select_unique_latest_lifecycle_evidence(lifecycle_evidence)? {
                None => RetryEvidence::NoFailedAttempt,
                Some(evidence) => RetryEvidence::NotBefore(evidence.value),
            },
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::build_maintenance_inbox;
    use crate::narrative_extraction::dependency_edges::consumer_dependency_set_digest;
    use crate::narrative_extraction::execution_state::{
        transition_run_status_in_tx, NarrativeRunStatus,
    };
    use crate::narrative_extraction::legacy_backfill::LEGACY_BACKFILL_ALGORITHM_VERSION;
    use crate::narrative_extraction::repository::{create_system_run_in_tx, SystemRunWorkKeyReuse};
    use crate::narrative_extraction::restore_rebuild::DependencyGraphVerifyReport;
    use crate::narrative_extraction::run_dependency_verify_for_project;
    use crate::narrative_extraction::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
    use crate::Database;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::params;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;

    fn recovery_work(kind: AutomaticRunKind, epoch_id: &str) -> WorkKey {
        let work_key = match kind {
            AutomaticRunKind::Backfill => LEGACY_BACKFILL_WORK_KEY.to_owned(),
            AutomaticRunKind::Verify => format!("{VERIFY_WORK_KEY_PREFIX}{epoch_id}"),
            AutomaticRunKind::RebuildDerived => REBUILD_DERIVED_WORK_KEY.to_owned(),
        };
        WorkKey::new_for_epoch("project-1", kind, work_key, epoch_id).expect("recovery work")
    }

    fn recovery_spec(kind: AutomaticRunKind) -> String {
        match kind {
            AutomaticRunKind::Backfill => {
                format!(r#"{{"backfillAlgorithmVersion":"{LEGACY_BACKFILL_ALGORITHM_VERSION}"}}"#)
            }
            AutomaticRunKind::Verify => {
                // Keep the recovery fixture tied to the same Rust-owned
                // contract as maintenance lifecycle creation.
                format!(r#"{{"verifyContractVersion":"{VERIFY_CONTRACT_VERSION}"}}"#)
            }
            AutomaticRunKind::RebuildDerived => "{}".to_string(),
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

    fn open_backfill_cycle_db(project_ids: &[&str]) -> Arc<Database> {
        let db = Arc::new(Database::new(std::path::Path::new(":memory:")).expect("open database"));
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            for project_id in project_ids {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, ?1)",
                    [*project_id],
                )?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed backfill projects");
        db
    }

    fn backfill_cycle_request(project_ids: &[&str]) -> MaintenanceCycleRequest {
        MaintenanceCycleRequest {
            work: project_ids
                .iter()
                .map(|project_id| MaintenanceWorkRequest {
                    project_id: (*project_id).to_string(),
                    run_kind: AutomaticRunKind::Backfill,
                    work_key: LEGACY_BACKFILL_WORK_KEY.to_string(),
                    semantic_epoch_id: None,
                    reasons: vec!["lifecycle-test".to_string()],
                })
                .collect(),
            wake_project_ids: Vec::new(),
            delivery_sequence: None,
            delivery_fingerprint: None,
            workspace_binding: None,
        }
    }

    fn open_epoch_normalization_db() -> Arc<Database> {
        let db = Arc::new(Database::new(std::path::Path::new(":memory:")).expect("open database"));
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
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed current epoch");
        db
    }

    fn open_clean_before_cutover_db() -> Database {
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
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed BeforeCutover project");

        // Let the production Verify writer seal the exact clean outcome and
        // skip evidence used by durable discovery. The Backfill marker is
        // inserted afterward so Verify is the reusable latest phase while the
        // legacy boundary is already crossed.
        run_dependency_verify_for_project(&db, "project-1").expect("seed reusable clean Verify");
        db.with_conn(|conn| {
            let backfill_spec =
                json!({ "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION });
            let backfill_outcome = json!({
                "maintenancePhase": "backfill-complete",
                "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION,
                "semanticEpochId": "epoch-current",
                "summary": {
                    "epoch_created": true,
                    "contributions_created": 0,
                    "edges_created": 0,
                    "applications_without_run_id": 0
                }
            });
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json,
                     spec_digest, status, coverage_json, outcome_summary_json,
                     created_at, completed_at, run_kind, semantic_epoch_id,
                     work_key)
                 VALUES ('backfill-complete', 'project-1', 'maintenance', '{}',
                         ?1, 'sha256:backfill', 'completed', '{}', ?2,
                         '2026-01-01T00:00:00.000Z',
                         '2026-01-01T00:00:00.000Z', 'backfill', 'epoch-current', ?3)",
                params![
                    backfill_spec.to_string(),
                    backfill_outcome.to_string(),
                    LEGACY_BACKFILL_WORK_KEY,
                ],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed completed Backfill marker");
        db
    }

    /// Make the persisted Verify report enter the repairability branch during
    /// rediscovery without changing the live graph-state digest.  The
    /// deliberately absent edge id means the ordinary (uncontrolled) helper
    /// would issue a repairability lookup and then reject the forged report;
    /// the controlled path must observe its stop before preparing that SQL.
    fn add_repairability_marker_to_persisted_verify(db: &Database) {
        db.with_conn(|conn| {
            let (run_id, outcome_json): (String, Option<String>) = conn.query_row(
                "SELECT id, outcome_summary_json
                   FROM narrative_extraction_runs
                  WHERE project_id = 'project-1'
                    AND run_kind = 'dependency-verify'
                    AND semantic_epoch_id = 'epoch-current'
                  ORDER BY completed_at DESC, id DESC
                  LIMIT 1",
                [],
                |row| {
                    Ok((row.get(0)?, row.get(1)?))
                },
            )?;
            let outcome_json = outcome_json
                .ok_or_else(|| anyhow::anyhow!("persisted Verify outcome is missing"))?;
            let mut outcome: Value = serde_json::from_str(&outcome_json)?;
            let mut report: DependencyGraphVerifyReport = serde_json::from_value(
                outcome
                    .get("report")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("persisted Verify report is missing"))?,
            )?;
            report.edge_state_ids_outside_current_epoch =
                vec!["edge-absent-from-live-graph".to_owned()];
            report.rebuild_required = true;
            let report_value = serde_json::to_value(report)?;
            outcome["report"] = report_value.clone();
            outcome["reportDigest"] = Value::String(format!(
                "sha256:{}",
                digest_plan(&report_value)
            ));
            outcome["outcomeDigest"] = Value::String(
                super::super::restore_rebuild::canonical_verify_outcome_digest(&outcome)?,
            );
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET outcome_summary_json = ?1
                  WHERE id = ?2",
                params![outcome.to_string(), run_id],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("add persisted Verify repairability marker");
    }

    struct StopBeforePersistedVerifyRepairability {
        select_count: Arc<AtomicUsize>,
        coverage_checks: usize,
        baseline_select_count: Option<usize>,
        reason: crate::narrative_extraction::source_revision::ValidationTerminationReason,
    }

    impl GraphWorkControl for StopBeforePersistedVerifyRepairability {
        fn check(&mut self, stage: GraphWorkStage) -> anyhow::Result<()> {
            match stage {
                GraphWorkStage::Coverage => {
                    self.coverage_checks += 1;
                    // Durable discovery checks Coverage once before opening
                    // the persisted outcome; validate_discovered_verify_outcome
                    // checks it a second time immediately before the
                    // repairability helper.
                    if self.coverage_checks == 2 {
                        self.baseline_select_count =
                            Some(self.select_count.load(Ordering::SeqCst));
                    }
                }
                GraphWorkStage::Digest if self.coverage_checks >= 2 => {
                    return Err(crate::narrative_extraction::validation_terminated(
                        self.reason,
                        "controlled stop before persisted Verify repairability lookup",
                    ));
                }
                _ => {}
            }
            Ok(())
        }
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

    fn seed_graph_repair_verify_fixture(db: &Database) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content)
                 VALUES ('scene-live', 'project-1', 'scene', 'Scene',
                         '{\"type\":\"doc\",\"content\":[]}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'project-1', 0, 'initial',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            let backfill_spec =
                json!({ "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION });
            let backfill_outcome = json!({
                "maintenancePhase": "backfill-complete",
                "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION,
                "semanticEpochId": "epoch-1",
                "summary": {
                    "epoch_created": true,
                    "contributions_created": 0,
                    "edges_created": 0,
                    "applications_without_run_id": 0
                }
            });
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json,
                     spec_digest, status, coverage_json, outcome_summary_json,
                     created_at, completed_at, run_kind, semantic_epoch_id,
                     work_key)
                 VALUES ('backfill-complete', 'project-1', 'maintenance', '{}',
                         ?1, 'sha256:backfill', 'completed', '{}', ?2,
                         '2026-01-01T00:00:00.000Z',
                         '2026-01-01T00:00:00.000Z', 'backfill', 'epoch-1', ?3)",
                params![
                    backfill_spec.to_string(),
                    backfill_outcome.to_string(),
                    LEGACY_BACKFILL_WORK_KEY,
                ],
            )?;
            // This is a durable row written around the Producer writer. The
            // declared graph has current derived rows, so Verify can isolate
            // the unsupported Consumer as a non-rebuildable graph defect.
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at)
                 VALUES ('edge-repair', 'project-1', 'unsupported-consumer',
                         'consumer-1', 'project:scene:scene-live', '[]',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edge_states
                    (edge_id, project_id, evidence_freshness, reason_code,
                     build_action, evaluated_at_epoch_id, evaluated_at)
                 VALUES ('edge-repair', 'project-1', 'unknown', NULL, 'manual',
                         'epoch-1', '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            let dependency_set_digest = consumer_dependency_set_digest(
                conn,
                "project-1",
                "unsupported-consumer",
                "consumer-1",
            )?;
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, dependency_set_digest,
                     updated_at)
                 VALUES ('project-1', 'unsupported-consumer', 'consumer-1',
                         'unknown', 'manual', 'epoch-1', ?1,
                         '2026-01-01T00:00:00.000Z')",
                params![dependency_set_digest],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed graph-repair Verify fixture");
    }

    fn seed_project_feed_event_without_cursor(db: &Database) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content)
                 VALUES ('scene-live', 'project-1', 'scene', 'Scene',
                         '{\"type\":\"doc\",\"content\":[]}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'project-1', 0, 'initial',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            let backfill_spec =
                json!({ "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION });
            let backfill_outcome = json!({
                "maintenancePhase": "backfill-complete",
                "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION,
                "semanticEpochId": "epoch-1",
                "summary": {
                    "epoch_created": true,
                    "contributions_created": 0,
                    "edges_created": 0,
                    "applications_without_run_id": 0
                }
            });
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json,
                     spec_digest, status, coverage_json, outcome_summary_json,
                     created_at, completed_at, run_kind, semantic_epoch_id,
                     work_key)
                 VALUES ('backfill-complete', 'project-1', 'maintenance', '{}',
                         ?1, 'sha256:backfill', 'completed', '{}', ?2,
                         '2026-01-01T00:00:00.000Z',
                         '2026-01-01T00:00:00.000Z', 'backfill', 'epoch-1', ?3)",
                params![
                    backfill_spec.to_string(),
                    backfill_outcome.to_string(),
                    LEGACY_BACKFILL_WORK_KEY,
                ],
            )?;
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, scene_id, domain, op_type,
                     entity_type, entity_id, payload, session_id, sequence,
                     timestamp, prev_hash, hash)
                 VALUES ('feed-event-1', 'project-1', 'scene-live',
                         'scene.update', 'scene.update', 'scene', 'scene-live',
                         '{}', 'feed-test', 1, 1767225600000, 'prev', 'hash')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_transactions
                    (id, project_id, request_id, source_domain,
                     source_change_event_uid, source_change_event_sequence,
                     cause_kind, origin, application_ids_json, payload_digest,
                     created_at)
                 VALUES ('feed-transaction-1', 'project-1', 'feed-request-1',
                         'scene.update', 'feed-event-1', 1, 'forward', 'human',
                         '[]', 'sha256:feed-payload',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_events
                    (id, project_id, transaction_id, canonical_change_event_uid,
                     canonical_sequence, event_ordinal, object_key_json,
                     change_kind, mutation_kind, before_version, before_digest,
                     after_version, after_digest, changed_paths_json,
                     text_impact_json, structural_impact_json, occurred_at)
                 VALUES ('feed-event-row-1', 'project-1', 'feed-transaction-1',
                         'feed-event-1', 1, 0,
                         '{\"kind\":\"scene\",\"sceneId\":\"scene-live\"}',
                         'content', 'update', 1, 'sha256:before', 2,
                         'sha256:after', '[\"/content\"]', NULL, NULL,
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed new-project feed event without cursor");
    }

    #[test]
    fn graph_repair_finding_resolves_from_sealed_verify_outcome_after_defect_removed() {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        seed_graph_repair_verify_fixture(&db);

        let first = run_dependency_verify_for_project(&db, "project-1")
            .expect("defective Verify should complete");
        assert!(!first.report.is_clean());
        assert!(!first.report.requires_rebuild());
        assert_eq!(
            first.report.edge_ids_with_unresolvable_consumer_scope,
            vec!["edge-repair".to_string()]
        );
        let graph_repair_discovery =
            discover_durable_maintenance_work(&db, "project-1", "durable-wake")
                .expect("discover graph-repair finding");
        assert!(
            graph_repair_discovery.is_none(),
            "graph defect should halt with a Finding, got {graph_repair_discovery:?}"
        );

        let finding_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'
                        AND id LIKE 'terminal-failure:v1:NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR:%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count graph-repair finding");
        assert_eq!(finding_count, 1);

        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_dependency_edges
                  WHERE id = 'edge-repair' AND project_id = 'project-1'",
                [],
            )?;
            conn.execute(
                "DELETE FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1'
                    AND consumer_kind = 'unsupported-consumer'
                    AND consumer_key = 'consumer-1'",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("remove graph defect");

        let clean = run_dependency_verify_for_project(&db, "project-1")
            .expect("clean confirmation Verify should resolve the finding");
        assert!(clean.report.is_clean());

        let inbox = db
            .with_conn(|conn| {
                build_maintenance_inbox(conn, "project-1", "2026-01-02T00:00:00.000Z")
            })
            .expect("build maintenance inbox");
        assert!(
            inbox.is_empty(),
            "resolved graph finding must leave the inbox"
        );
        let lifecycle_state: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT lifecycle_state
                       FROM narrative_maintenance_finding_lifecycle
                      WHERE project_id = 'project-1'
                      ORDER BY julianday(observed_at) DESC
                      LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read graph finding lifecycle");
        assert_eq!(lifecycle_state, "resolved");

        let work = WorkKey::new_for_epoch(
            "project-1",
            AutomaticRunKind::Verify,
            "dependency-verify:epoch-1",
            "epoch-1",
        )
        .expect("Verify work key");
        assert!(matches!(
            retry_not_before(&db, &work).expect("read Verify retry evidence"),
            RetryEvidence::NoFailedAttempt
        ));
    }

    #[test]
    fn corrupt_graph_repair_verify_anchor_stays_fail_closed_on_clean_confirmation() {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        seed_graph_repair_verify_fixture(&db);
        let first = run_dependency_verify_for_project(&db, "project-1")
            .expect("defective Verify should complete");
        discover_durable_maintenance_work(&db, "project-1", "durable-wake")
            .expect("discover graph-repair finding");

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET outcome_summary_json = json_set(outcome_summary_json,
                        '$.reportDigest', 'sha256:corrupted-report')
                  WHERE id = ?1",
                params![first.run_id],
            )?;
            conn.execute(
                "DELETE FROM narrative_dependency_edges
                  WHERE id = 'edge-repair' AND project_id = 'project-1'",
                [],
            )?;
            conn.execute(
                "DELETE FROM narrative_consumer_freshness
                  WHERE project_id = 'project-1'
                    AND consumer_kind = 'unsupported-consumer'
                    AND consumer_key = 'consumer-1'",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("corrupt sealed Verify anchor and remove defect");

        let error = run_dependency_verify_for_project(&db, "project-1")
            .expect_err("corrupt sealed Verify anchor must block resolution");
        assert!(
            error.to_string().contains("Verify outcome")
                || error.to_string().contains("NEX_FINDING"),
            "unexpected fail-closed error: {error:#}"
        );
        let resolved_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_lifecycle
                      WHERE project_id = 'project-1' AND lifecycle_state = 'resolved'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count resolved findings");
        assert_eq!(resolved_count, 0);
    }

    #[test]
    fn non_rebuildable_verify_issue_still_projects_manual_finding() {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        seed_graph_repair_verify_fixture(&db);

        let report = run_dependency_verify_for_project(&db, "project-1")
            .expect("defective Verify should complete")
            .report;
        assert!(report.has_consistency_issues());
        assert!(!report.is_incomplete_only());
        assert!(!report.requires_rebuild());
        discover_durable_maintenance_work(&db, "project-1", "durable-wake")
            .expect("discover non-rebuildable Verify");

        let finding_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'
                        AND id LIKE 'terminal-failure:v1:NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR:%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count manual graph finding");
        assert_eq!(finding_count, 1);
    }

    #[test]
    fn new_project_feed_without_cursor_waits_for_freshness_before_manual_finding() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        seed_project_feed_event_without_cursor(&db);

        let incomplete = run_dependency_verify_for_project(&db, "project-1")
            .expect("incomplete Verify should complete with a report");
        assert!(
            !incomplete.report.is_consistent(),
            "missing cursor must not claim a clean consistency result"
        );
        assert!(incomplete.report.is_incomplete_only());
        assert!(!incomplete.report.is_complete());
        assert!(incomplete
            .report
            .cursor_and_feed_head_consistency
            .incomplete
            .iter()
            .any(|item| item == "incremental-cursor-missing-with-feed-events"));
        discover_durable_maintenance_work(&db, "project-1", "durable-wake")
            .expect("discover incomplete Verify");
        let finding_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count incomplete Verify findings");
        assert_eq!(finding_count, 0);

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_change_cursors
                    (project_id, consumer_id, acknowledged_through_sequence,
                     updated_at)
                 VALUES ('project-1', ?1, 0, '2026-01-02T00:00:00.000Z')",
                params![INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("publish the Freshness cursor");

        let rediscovered = discover_durable_maintenance_work(&db, "project-1", "freshness-wake")
            .expect("rediscover after Freshness cursor appears")
            .expect("cursor coordinate change must request Verify");
        assert_eq!(rediscovered.run_kind, AutomaticRunKind::Verify);
        let clean = run_dependency_verify_for_project(&db, "project-1")
            .expect("cursor-complete Verify should finish cleanly");
        assert!(clean.report.is_clean());
        assert!(
            discover_durable_maintenance_work(&db, "project-1", "cutover-wake")
                .expect("discover post-cursor clean state")
                .is_none()
        );
        let finding_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count post-cursor findings");
        assert_eq!(finding_count, 0);
    }

    #[test]
    fn pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('pre-marker-project', 'Visible')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed visible pre-marker project");

        let work = discover_durable_maintenance_work(&db, "pre-marker-project", "before-cutover")
            .expect("discover BeforeCutover maintenance")
            .expect("visible epoch-less project must enter Backfill without reopen");
        assert_eq!(work.run_kind, AutomaticRunKind::Backfill);
        assert_eq!(work.reasons, ["before-cutover"]);
        assert_eq!(work.semantic_epoch_id, None);
    }

    #[test]
    fn hidden_scan_staging_project_is_not_discovered_until_marker_is_removed() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('scan-staging-project', 'Hidden')",
                [],
            )?;
            conn.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('scan-staging-project', 'scan.import.state', 'staging')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed hidden Scan staging project");

        crate::narrative_extraction::narrative_extraction_bootstrap_legacy_backfill(&db);
        for reason in ["workspace-opened", "before-cutover"] {
            assert_eq!(
                discover_durable_maintenance_work(&db, "scan-staging-project", reason)
                    .expect("discover hidden staging project"),
                None,
                "hidden staging project must not be eligible for {reason}"
            );
        }
        db.with_conn(|conn| {
            let counts: (i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_semantic_epochs
                      WHERE project_id = 'scan-staging-project'),
                    (SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE project_id = 'scan-staging-project')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(counts, (0, 0));
            conn.execute(
                "DELETE FROM project_settings
                  WHERE project_id = 'scan-staging-project'
                    AND key = 'scan.import.state'
                    AND value = 'staging'",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("remove Scan staging marker");

        let visible_work =
            discover_durable_maintenance_work(&db, "scan-staging-project", "before-cutover")
                .expect("discover visible project")
                .expect("marker removal makes the project eligible");
        assert_eq!(visible_work.run_kind, AutomaticRunKind::Backfill);
        assert_eq!(visible_work.semantic_epoch_id, None);
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
    fn preflight_rejects_rust_internal_c2zc_follow_up_reason() {
        let request = MaintenanceCycleRequest {
            work: vec![MaintenanceWorkRequest {
                project_id: "project".to_string(),
                run_kind: AutomaticRunKind::Verify,
                work_key: "verify:epoch-1".to_string(),
                semantic_epoch_id: Some("epoch-1".to_string()),
                reasons: vec![BEFORE_CUTOVER_FOLLOW_UP_REASON.to_string()],
            }],
            wake_project_ids: Vec::new(),
            delivery_sequence: None,
            delivery_fingerprint: None,
            workspace_binding: None,
        };
        let error = request
            .normalized_work()
            .expect_err("internal follow-up must not be accepted on the wire");
        assert!(error
            .to_string()
            .contains("C2-ZC follow-up reason is Rust-internal"));
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
            freshness_hold_project_id: None,
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
            "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v3"
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
            freshness_hold_project_id: None,
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
            rebuild_contract_version: REBUILD_CONTRACT_VERSION.to_string(),
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
    fn foreground_cycle_holds_initial_and_existing_run_until_exact_release() {
        let db = open_backfill_cycle_db(&["project-1"]);
        let mut config = ci_config(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake);
        config.product_journey_barrier_id = Some("barrier-backfill".to_string());
        config.correlation = Some("correlation-backfill".to_string());
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority:workspace-1".to_string(),
            generation: 1,
        };
        let mut request = backfill_cycle_request(&["project-1"]);
        request.workspace_binding = Some(binding.clone());

        let run_cycle = |db: &Database,
                         request: &MaintenanceCycleRequest,
                         config: &NarrativeMaintenanceCiConfig| {
            let grant_called = Arc::new(AtomicBool::new(false));
            let adapter_completed = Arc::new(AtomicBool::new(false));
            let noop_completed = Arc::new(AtomicBool::new(false));
            let deferred = Arc::new(AtomicBool::new(false));
            let grant_called_for_cycle = Arc::clone(&grant_called);
            let adapter_completed_for_cycle = Arc::clone(&adapter_completed);
            let noop_completed_for_cycle = Arc::clone(&noop_completed);
            let deferred_for_cycle = Arc::clone(&deferred);
            let should_stop = || Ok::<_, anyhow::Error>(());
            let grant_finalize = move |_work_key: &str| -> anyhow::Result<()> {
                grant_called_for_cycle.store(true, Ordering::SeqCst);
                anyhow::bail!("foreground-held work must not request finalization")
            };
            let register_work = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_started = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_completed = move |_item: &DesiredWork| -> anyhow::Result<()> {
                adapter_completed_for_cycle.store(true, Ordering::SeqCst);
                anyhow::bail!("foreground-held work must not report strict completion")
            };
            let work_noop_completed = move |_item: &DesiredWork| -> anyhow::Result<()> {
                noop_completed_for_cycle.store(true, Ordering::SeqCst);
                Ok(())
            };
            let work_deferred = move |_item: &DesiredWork| -> anyhow::Result<()> {
                deferred_for_cycle.store(true, Ordering::SeqCst);
                Ok(())
            };
            let control = MaintenanceCycleControl {
                should_stop: &should_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &|_run_id: &str| Ok::<_, anyhow::Error>(()),
                grant_finalize: &grant_finalize,
                register_work: &register_work,
                work_started: &work_started,
                work_completed: &work_completed,
                work_noop_completed: &work_noop_completed,
                work_deferred: &work_deferred,
            };
            let result =
                run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                    db,
                    request,
                    |_| RecoveryMode::StartupRecovery,
                    Some(config),
                    None,
                    Some(&control),
                )?;
            Ok::<_, anyhow::Error>((
                result,
                grant_called.load(Ordering::SeqCst),
                adapter_completed.load(Ordering::SeqCst),
                noop_completed.load(Ordering::SeqCst),
                deferred.load(Ordering::SeqCst),
            ))
        };

        let (initial, grant_called, adapter_completed, noop_completed, deferred) =
            run_cycle(&db, &request, &config).expect("initial foreground cycle");
        assert_eq!(initial.status, MaintenanceCycleStatus::Deferred);
        assert!(!initial.has_more);
        assert!(!grant_called, "held adapter must not acquire finalization");
        assert!(
            !noop_completed,
            "held adapter must not settle as no-op success"
        );
        assert!(deferred, "held adapter must use the parked callback");
        assert!(
            !adapter_completed,
            "held adapter must not report strict success"
        );

        let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
            .expect("find initial foreground Run")
            .expect("initial cycle must leave a durable foreground Run running");
        let (status, task_status, attempt_status): (String, String, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT r.status, t.status, a.status
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE r.id = ?1",
                    params![barrier.run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(Into::into)
            })
            .expect("read initial held lifecycle");
        assert_eq!(
            (
                status.as_str(),
                task_status.as_str(),
                attempt_status.as_str()
            ),
            ("running", "running", "running")
        );

        let (existing, grant_called, adapter_completed, noop_completed, deferred) =
            run_cycle(&db, &request, &config).expect("existing foreground cycle");
        assert_eq!(existing.status, MaintenanceCycleStatus::Deferred);
        assert!(!existing.has_more);
        assert!(
            !grant_called,
            "pre-existing hold must not acquire finalization"
        );
        assert!(
            !noop_completed,
            "pre-existing hold must not settle as no-op success"
        );
        assert!(deferred, "pre-existing hold must use the parked callback");
        assert!(
            !adapter_completed,
            "pre-existing hold must not report strict success"
        );

        complete_foreground_system_work_run(&db, &barrier)
            .expect("exact foreground barrier release");
        let (status, task_status, attempt_status): (String, String, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT r.status, t.status, a.status
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE r.id = ?1",
                    params![barrier.run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(Into::into)
            })
            .expect("read released lifecycle");
        assert_eq!(
            (
                status.as_str(),
                task_status.as_str(),
                attempt_status.as_str()
            ),
            ("completed", "completed", "completed")
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

    fn ci_config(trigger: NarrativeMaintenanceCiTrigger) -> NarrativeMaintenanceCiConfig {
        NarrativeMaintenanceCiConfig {
            is_packaged: false,
            ci: "true".to_string(),
            owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
            fault: None,
            trigger: Some(trigger),
            setup: None,
            freshness_hold_project_id: None,
            product_journey_barrier_id: None,
            correlation: None,
        }
    }

    #[test]
    fn ci_coordinate_trigger_changes_exactly_one_effective_coordinate() {
        let baseline = current_maintenance_coordinates().expect("baseline coordinates");
        let cases = [
            (
                NarrativeMaintenanceCiTrigger::GraphContractDigestChanged,
                "graph",
            ),
            (
                NarrativeMaintenanceCiTrigger::RuleRegistryDigestChanged,
                "rule",
            ),
            (
                NarrativeMaintenanceCiTrigger::ProducerGenerationSetDigestChanged,
                "producer",
            ),
        ];

        for (trigger, target) in cases {
            let effective = effective_maintenance_coordinates(Some(&ci_config(trigger)))
                .expect("effective coordinates");
            let changed = [
                effective.graph_contract_digest != baseline.graph_contract_digest,
                effective.rule_registry_digest != baseline.rule_registry_digest,
                effective.producer_generation_set_digest != baseline.producer_generation_set_digest,
            ];
            assert_eq!(
                changed.iter().filter(|value| **value).count(),
                1,
                "{target}"
            );
            assert_eq!(
                effective.graph_contract_digest != baseline.graph_contract_digest,
                target == "graph",
                "{target} must select only the graph coordinate",
            );
            assert_eq!(
                effective.rule_registry_digest != baseline.rule_registry_digest,
                target == "rule",
                "{target} must select only the rule coordinate",
            );
            assert_eq!(
                effective.producer_generation_set_digest != baseline.producer_generation_set_digest,
                target == "producer",
                "{target} must select only the producer coordinate",
            );
            assert!(
                effective.graph_contract_digest.starts_with("sha256:")
                    && effective.rule_registry_digest.starts_with("sha256:")
                    && effective
                        .producer_generation_set_digest
                        .starts_with("sha256:")
            );
        }
    }

    #[test]
    fn ci_coordinate_trigger_is_deterministic_and_not_js_supplied() {
        let config = ci_config(NarrativeMaintenanceCiTrigger::RuleRegistryDigestChanged);
        let first = effective_maintenance_coordinates(Some(&config)).expect("first coordinates");
        let second = effective_maintenance_coordinates(Some(&config)).expect("second coordinates");
        assert_eq!(first, second);
        assert_eq!(
            effective_maintenance_coordinates(None).expect("no trigger"),
            current_maintenance_coordinates().expect("baseline coordinates")
        );
        assert!(config.validate().is_ok());
    }

    #[test]
    fn ci_coordinate_mismatch_reaches_discovery_after_baseline_evidence() {
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
                         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                         'backfill', 'epoch-1', ?3)",
                params![
                    json!({ "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION })
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
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed completed backfill boundary");

        run_dependency_verify_for_project(&db, "project-1")
            .expect("baseline Verify must persist skip evidence");
        assert!(discover_durable_maintenance_work_with_config(
            &db,
            "project-1",
            "workspace-opened",
            None,
        )
        .expect("baseline discovery")
        .is_none());
        let changed = discover_durable_maintenance_work_with_config(
            &db,
            "project-1",
            "workspace-opened",
            Some(&ci_config(
                NarrativeMaintenanceCiTrigger::GraphContractDigestChanged,
            )),
        )
        .expect("changed discovery");
        let changed = changed.expect("changed coordinate must request Verify");
        assert_eq!(changed.run_kind, AutomaticRunKind::Verify);
        assert_eq!(changed.semantic_epoch_id.as_deref(), Some("epoch-1"));

        let changed_config = ci_config(NarrativeMaintenanceCiTrigger::GraphContractDigestChanged);
        let cycle = run_system_work_cycle_with_modes_and_config(
            &db,
            &MaintenanceCycleRequest {
                work: vec![MaintenanceWorkRequest {
                    project_id: changed.project_id.clone(),
                    run_kind: changed.run_kind,
                    work_key: changed.work_key.clone(),
                    semantic_epoch_id: changed.semantic_epoch_id.clone(),
                    reasons: changed.reasons.clone(),
                }],
                wake_project_ids: Vec::new(),
                delivery_sequence: None,
                delivery_fingerprint: None,
                workspace_binding: None,
            },
            |_| RecoveryMode::StartupRecovery,
            Some(&changed_config),
        )
        .expect("changed coordinate cycle");
        assert_eq!(cycle.status, MaintenanceCycleStatus::Accepted);

        let outcome_json: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT outcome_summary_json
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                        AND run_kind = 'dependency-verify'
                        AND status = 'completed'
                   ORDER BY rowid DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read changed Verify outcome");
        let evidence = serde_json::from_str::<Value>(&outcome_json)
            .expect("outcome JSON")
            .get("skipEvidence")
            .cloned()
            .expect("changed Verify must persist skip evidence");
        let baseline = current_maintenance_coordinates().expect("baseline coordinates");
        let effective = effective_maintenance_coordinates(Some(&changed_config))
            .expect("effective changed coordinates");
        assert_eq!(
            evidence["graphContractDigest"],
            effective.graph_contract_digest
        );
        assert_eq!(
            evidence["ruleRegistryDigest"],
            baseline.rule_registry_digest
        );
        assert_eq!(
            evidence["producerGenerationSetDigest"],
            baseline.producer_generation_set_digest
        );
        assert!(discover_durable_maintenance_work_with_config(
            &db,
            "project-1",
            "workspace-opened",
            Some(&changed_config),
        )
        .expect("rediscover changed evidence")
        .is_none());
    }

    #[test]
    fn coalesced_db_cycle_uses_noop_completion_without_a_finalize_grant() {
        let db = open_backfill_cycle_db(&["project-1"]);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json,
                     spec_digest, status, coverage_json, created_at, started_at,
                     completed_at, version, run_kind, semantic_epoch_id, work_key)
                 VALUES ('coalesced-run', 'project-1', 'maintenance', '{}', '{}',
                         'sha256:coalesced', 'running', '{}',
                         '2026-01-01T00:00:00.000Z',
                         '2026-01-01T00:00:00.000Z', NULL, 0, 'backfill',
                         NULL, ?1)",
                [LEGACY_BACKFILL_WORK_KEY],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed coalesced durable Run");

        let grant_called = Arc::new(AtomicBool::new(false));
        let adapter_completed = Arc::new(AtomicBool::new(false));
        let noop_completed = Arc::new(AtomicBool::new(false));
        let grant_called_for_cycle = Arc::clone(&grant_called);
        let adapter_completed_for_cycle = Arc::clone(&adapter_completed);
        let noop_completed_for_cycle = Arc::clone(&noop_completed);
        let request = backfill_cycle_request(&["project-1"]);
        let result = {
            let should_stop = || Ok::<_, anyhow::Error>(());
            let grant_finalize = move |_work_key: &str| -> anyhow::Result<()> {
                grant_called_for_cycle.store(true, Ordering::SeqCst);
                anyhow::bail!("coalesced work must not request adapter finalization")
            };
            let register_work = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_started = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_completed = move |_item: &DesiredWork| -> anyhow::Result<()> {
                adapter_completed_for_cycle.store(true, Ordering::SeqCst);
                anyhow::bail!("coalesced work must not report adapter completion")
            };
            let work_noop_completed = move |_item: &DesiredWork| -> anyhow::Result<()> {
                noop_completed_for_cycle.store(true, Ordering::SeqCst);
                Ok(())
            };
            let control = MaintenanceCycleControl {
                should_stop: &should_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &|_run_id: &str| Ok::<_, anyhow::Error>(()),
                grant_finalize: &grant_finalize,
                register_work: &register_work,
                work_started: &work_started,
                work_completed: &work_completed,
                work_noop_completed: &work_noop_completed,
                work_deferred: &work_noop_completed,
            };
            run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                &db,
                &request,
                |_| RecoveryMode::SameProcessLive,
                None,
                None,
                Some(&control),
            )
        };

        assert_eq!(
            result.expect("coalesced cycle").status,
            MaintenanceCycleStatus::Coalesced
        );
        assert!(noop_completed.load(Ordering::SeqCst));
        assert!(!grant_called.load(Ordering::SeqCst));
        assert!(!adapter_completed.load(Ordering::SeqCst));
        let durable_status: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = 'coalesced-run'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read coalesced Run");
        assert_eq!(durable_status, "running");
    }

    #[test]
    fn adapter_db_cancel_before_finalize_does_not_commit_terminal_success() {
        let db = open_backfill_cycle_db(&["project-1"]);
        let grant_called = Arc::new(AtomicBool::new(false));
        let request = backfill_cycle_request(&["project-1"]);
        let db_for_cycle = Arc::clone(&db);
        let grant_called_for_cycle = Arc::clone(&grant_called);
        let result = thread::spawn(move || {
            let should_stop = || Ok::<_, anyhow::Error>(());
            let grant_finalize = |_work_key: &str| -> anyhow::Result<()> {
                grant_called_for_cycle.store(true, Ordering::SeqCst);
                Err(anyhow::anyhow!(
                    "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancel won before finalization"
                ))
            };
            let register_work = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_started = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_completed = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let control = MaintenanceCycleControl {
                should_stop: &should_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &|_run_id: &str| Ok::<_, anyhow::Error>(()),
                grant_finalize: &grant_finalize,
                register_work: &register_work,
                work_started: &work_started,
                work_completed: &work_completed,
                work_noop_completed: &work_completed,
                work_deferred: &work_completed,
            };
            run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                &db_for_cycle,
                &request,
                |_| RecoveryMode::StartupRecovery,
                None,
                None,
                Some(&control),
            )
        })
        .join()
        .expect("cycle thread");

        assert!(
            result.is_err(),
            "cancel-before-finalize must abort the cycle"
        );
        assert!(grant_called.load(Ordering::SeqCst));
        let completed: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                        AND run_kind = 'backfill'
                        AND status = 'completed'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read backfill completion");
        assert_eq!(completed, 0, "cancelled final transaction must roll back");
    }

    #[test]
    fn adapter_db_finalize_before_late_cancel_keeps_durable_success() {
        let db = open_backfill_cycle_db(&["project-1"]);
        let (grant_tx, grant_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let request = backfill_cycle_request(&["project-1"]);
        let db_for_cycle = Arc::clone(&db);
        let cancel_for_cycle = Arc::clone(&cancel_requested);
        let result = thread::spawn(move || {
            let should_stop = || -> anyhow::Result<()> {
                if cancel_for_cycle.load(Ordering::SeqCst) {
                    anyhow::bail!(
                        "NEX_MAINTENANCE_ATTEMPT_CANCELLED: late cancel at cycle boundary"
                    );
                }
                Ok(())
            };
            let grant_finalize = |_work_key: &str| -> anyhow::Result<()> {
                grant_tx.send(()).expect("grant barrier receiver");
                release_rx.recv().expect("release final transaction");
                Ok(())
            };
            let register_work = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_started = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_completed = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let control = MaintenanceCycleControl {
                should_stop: &should_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &|_run_id: &str| Ok::<_, anyhow::Error>(()),
                grant_finalize: &grant_finalize,
                register_work: &register_work,
                work_started: &work_started,
                work_completed: &work_completed,
                work_noop_completed: &work_completed,
                work_deferred: &work_completed,
            };
            run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                &db_for_cycle,
                &request,
                |_| RecoveryMode::StartupRecovery,
                None,
                None,
                Some(&control),
            )
        });

        grant_rx.recv().expect("finalization grant");
        cancel_requested.store(true, Ordering::SeqCst);
        release_tx.send(()).expect("release final transaction");
        let result = result.join().expect("cycle thread");
        assert!(
            result.is_err(),
            "late cancellation should stop the next cycle boundary"
        );
        let completed: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                        AND run_kind = 'backfill'
                        AND status = 'completed'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read late-cancel completion");
        assert_eq!(completed, 1, "grant-before-cancel must preserve success");
    }

    #[test]
    fn adapter_db_partial_success_registers_initial_batch_before_cancel() {
        let db = open_backfill_cycle_db(&["project-1", "project-2"]);
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let registered = Arc::new(Mutex::new(Vec::<String>::new()));
        let first_completed = Arc::new(AtomicBool::new(false));
        let all_initial_registered = Arc::new(AtomicBool::new(false));
        let request = backfill_cycle_request(&["project-1", "project-2"]);
        let db_for_cycle = Arc::clone(&db);
        let cancel_for_cycle = Arc::clone(&cancel_requested);
        let registered_for_cycle = Arc::clone(&registered);
        let first_completed_for_cycle = Arc::clone(&first_completed);
        let all_initial_registered_for_cycle = Arc::clone(&all_initial_registered);
        let result = thread::spawn(move || {
            let should_stop = || -> anyhow::Result<()> {
                if cancel_for_cycle.load(Ordering::SeqCst) {
                    anyhow::bail!("NEX_MAINTENANCE_ATTEMPT_CANCELLED: later work cancelled");
                }
                Ok(())
            };
            let grant_finalize = |_work_key: &str| Ok::<_, anyhow::Error>(());
            let register_work = |item: &DesiredWork| -> anyhow::Result<()> {
                registered_for_cycle
                    .lock()
                    .expect("registration lock")
                    .push(item.canonical_key());
                Ok(())
            };
            let work_started = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_completed = |item: &DesiredWork| -> anyhow::Result<()> {
                if item.project_id == "project-1"
                    && !first_completed_for_cycle.swap(true, Ordering::SeqCst)
                {
                    let keys = registered_for_cycle.lock().expect("registration lock");
                    let has_project_one = keys.iter().any(|key| key.contains("/project-1/"));
                    let has_project_two = keys.iter().any(|key| key.contains("/project-2/"));
                    all_initial_registered_for_cycle
                        .store(has_project_one && has_project_two, Ordering::SeqCst);
                    cancel_for_cycle.store(true, Ordering::SeqCst);
                }
                Ok(())
            };
            let control = MaintenanceCycleControl {
                should_stop: &should_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &|_run_id: &str| Ok::<_, anyhow::Error>(()),
                grant_finalize: &grant_finalize,
                register_work: &register_work,
                work_started: &work_started,
                work_completed: &work_completed,
                work_noop_completed: &work_completed,
                work_deferred: &work_completed,
            };
            run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                &db_for_cycle,
                &request,
                |_| RecoveryMode::StartupRecovery,
                None,
                None,
                Some(&control),
            )
        })
        .join()
        .expect("cycle thread");

        assert!(result.is_err(), "later work must observe cancellation");
        assert!(all_initial_registered.load(Ordering::SeqCst));
        for (project_id, expected_completed) in [("project-1", 1), ("project-2", 0)] {
            let completed: i64 = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*)
                           FROM narrative_extraction_runs
                          WHERE project_id = ?1
                            AND run_kind = 'backfill'
                            AND status = 'completed'",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(Into::into)
                })
                .expect("read partial lifecycle");
            assert_eq!(completed, expected_completed, "{project_id}");
        }
    }

    #[test]
    fn adapter_receives_epoch_normalized_identity_for_absent_wire_epoch() {
        let db = open_epoch_normalization_db();
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let started = Arc::new(Mutex::new(Vec::<String>::new()));
        let granted = Arc::new(Mutex::new(Vec::<String>::new()));
        let completed = Arc::new(Mutex::new(Vec::<String>::new()));
        let request = backfill_cycle_request(&["project-1"]);
        let db_for_cycle = Arc::clone(&db);
        let cancel_for_cycle = Arc::clone(&cancel_requested);
        let started_for_cycle = Arc::clone(&started);
        let granted_for_cycle = Arc::clone(&granted);
        let completed_for_cycle = Arc::clone(&completed);
        let result = thread::spawn(move || {
            let should_stop = || -> anyhow::Result<()> {
                if cancel_for_cycle.load(Ordering::SeqCst) {
                    anyhow::bail!(
                        "NEX_MAINTENANCE_ATTEMPT_CANCELLED: normalized identity test complete"
                    );
                }
                Ok(())
            };
            let grant_finalize = |work_key: &str| -> anyhow::Result<()> {
                granted_for_cycle
                    .lock()
                    .expect("grant lock")
                    .push(work_key.to_string());
                cancel_for_cycle.store(true, Ordering::SeqCst);
                Ok(())
            };
            let register_work = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
            let work_started = |item: &DesiredWork| -> anyhow::Result<()> {
                started_for_cycle
                    .lock()
                    .expect("start lock")
                    .push(item.canonical_key());
                Ok(())
            };
            let work_completed = |item: &DesiredWork| -> anyhow::Result<()> {
                completed_for_cycle
                    .lock()
                    .expect("completion lock")
                    .push(item.canonical_key());
                Ok(())
            };
            let control = MaintenanceCycleControl {
                should_stop: &should_stop,
                stop_signal: None,
                finalization_granted_signal: None,
                defer_preempted_run: &|_run_id: &str| Ok::<_, anyhow::Error>(()),
                grant_finalize: &grant_finalize,
                register_work: &register_work,
                work_started: &work_started,
                work_completed: &work_completed,
                work_noop_completed: &work_completed,
                work_deferred: &work_completed,
            };
            run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                &db_for_cycle,
                &request,
                |_| RecoveryMode::StartupRecovery,
                None,
                None,
                Some(&control),
            )
        })
        .join()
        .expect("cycle thread");

        assert!(
            result.is_err(),
            "the test stop should end before Verify follow-up"
        );
        let started = started.lock().expect("start lock");
        let granted = granted.lock().expect("grant lock");
        let completed = completed.lock().expect("completion lock");
        assert_eq!(started.len(), 2);
        assert_eq!(granted.len(), 1);
        assert_eq!(completed.len(), 2);
        assert!(started
            .last()
            .expect("adapter start")
            .contains("/epoch/epoch-current"));
        assert_eq!(started.last().expect("adapter start"), &granted[0]);
        assert_eq!(
            started.last().expect("adapter start"),
            completed.last().expect("adapter completion")
        );
    }

    #[test]
    fn ci_setup_and_production_misuse_fail_closed_at_native_boundary() {
        let mut config = ci_config(NarrativeMaintenanceCiTrigger::DependencyGap);
        config.is_packaged = true;
        assert!(config.validate().is_err());
        config.is_packaged = false;
        config.ci = "false".to_string();
        assert!(config.validate().is_err());
        config.ci = "true".to_string();
        config.owner_token = "forged-owner".to_string();
        assert!(config.validate().is_err());
    }

    #[test]
    fn wrapped_preemption_is_propagated_before_selector_projection() {
        let db = open_pending_recovery_db();
        let work = recovery_work(AutomaticRunKind::RebuildDerived, "epoch-current");
        let messages = [
            (
                "NEX_MAINTENANCE_CONNECTION_PREEMPTED: maintenance connection is busy",
                true,
            ),
            (
                "NIR1_MAINTENANCE_CONNECTION_OPERATION_FAILED: NEX_MAINTENANCE_CONNECTION_PREEMPTED: maintenance connection is busy; NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: rollback failed",
                false,
            ),
            (
                "outer operation failed: NEX_VALIDATION_TERMINATED:foreground-preempted: foreground waiter arrived",
                true,
            ),
        ];

        for (message, transient) in messages {
            let error = anyhow::anyhow!(message);
            assert!(
                is_transient_maintenance_preemption(&error) == transient,
                "preemption classification was wrong for: {message}"
            );
            assert!(is_maintenance_control_or_cleanup_error(&error));
            let projection_error = project_ledger_selector_manual_intervention(&db, &work, &error)
                .expect_err("transient contention must not project a selector Finding");
            assert!(
                is_maintenance_control_or_cleanup_error(&projection_error),
                "projection guard changed the transient error: {projection_error:#}"
            );
        }

        let finding_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count selector findings");
        assert_eq!(finding_count, 0);
    }

    #[test]
    fn controlled_discovery_propagates_stop_without_fallback_or_finding() {
        let db = open_pending_recovery_db();
        let should_stop = || {
            Err(crate::narrative_extraction::validation_terminated(
                crate::narrative_extraction::ValidationTerminationReason::ForegroundPreempted,
                "foreground waiter owns the next maintenance handoff",
            ))
        };
        let no_op = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
        let no_op_run = |_run_id: &str| Ok::<_, anyhow::Error>(());
        let no_op_finalize = |_work_key: &str| Ok::<_, anyhow::Error>(());
        let control = MaintenanceCycleControl {
            should_stop: &should_stop,
            stop_signal: None,
            finalization_granted_signal: None,
            defer_preempted_run: &no_op_run,
            grant_finalize: &no_op_finalize,
            register_work: &no_op,
            work_started: &no_op,
            work_completed: &no_op,
            work_noop_completed: &no_op,
            work_deferred: &no_op,
        };

        let error = discover_durable_maintenance_work_with_coordinates_and_control(
            &db,
            "project-1",
            "durable-wake",
            None,
            &control,
        )
        .expect_err("controlled stop must escape discovery");
        assert!(is_maintenance_control_or_cleanup_error(&error));

        let finding_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
        })
        .expect("count discovery findings");
        assert_eq!(finding_count, 0);
    }

    fn assert_persisted_verify_rediscovery_stops_before_repairability_lookup(
        reason: crate::narrative_extraction::source_revision::ValidationTerminationReason,
    ) {
        let db = open_clean_before_cutover_db();
        add_repairability_marker_to_persisted_verify(&db);

        let select_count = Arc::new(AtomicUsize::new(0));
        let select_count_for_hook = Arc::clone(&select_count);
        db.with_conn(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(context.action, AuthAction::Select) {
                    select_count_for_hook.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))?;

            let mut control = StopBeforePersistedVerifyRepairability {
                select_count: Arc::clone(&select_count),
                coverage_checks: 0,
                baseline_select_count: None,
                reason,
            };
            let result = with_immediate_transaction(conn, |conn| {
                discover_durable_maintenance_work_in_tx_with_control(
                    conn,
                    "project-1",
                    "durable-wake",
                    None,
                    &mut control,
                )
            });
            let observed_select_count = select_count.load(Ordering::SeqCst);
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;

            let error = result.expect_err(
                "controlled persisted Verify rediscovery must stop before repairability lookup",
            );
            assert!(
                is_validation_terminated(&error),
                "stop must remain typed through discovery instead of becoming fallback work: {error:#}"
            );
            assert_eq!(
                control.coverage_checks, 2,
                "the stop boundary must be the Coverage check inside outcome validation"
            );
            assert_eq!(
                Some(observed_select_count),
                control.baseline_select_count,
                "cancellation/preemption must prevent the next repairability SELECT"
            );
            Ok::<_, anyhow::Error>(())
        })
        .expect("controlled persisted Verify rediscovery boundary");
    }

    #[test]
    fn persisted_verify_rediscovery_cancellation_stops_before_repairability_sql() {
        assert_persisted_verify_rediscovery_stops_before_repairability_lookup(
            crate::narrative_extraction::source_revision::ValidationTerminationReason::Cancelled,
        );
    }

    #[test]
    fn persisted_verify_rediscovery_foreground_preemption_stops_before_repairability_sql() {
        assert_persisted_verify_rediscovery_stops_before_repairability_lookup(
            crate::narrative_extraction::source_revision::ValidationTerminationReason::
                ForegroundPreempted,
        );
    }

    #[test]
    fn before_cutover_without_completed_rebuild_matches_legacy_verify_schedule() {
        let trigger = MaintenanceTrigger::BeforeCutover {
            project_id: "project-1".to_string(),
            semantic_epoch_id: "epoch-current".to_string(),
        };
        let legacy = plan_maintenance_trigger(&trigger).expect("legacy BeforeCutover plan");
        let controlled = before_cutover_verify_work("project-1", "epoch-current")
            .expect("controlled BeforeCutover fallback");

        assert_eq!(legacy, vec![controlled.clone()]);
        assert_eq!(controlled.run_kind, AutomaticRunKind::Verify);
        assert_eq!(controlled.work_key, "dependency-verify:epoch-current");
        assert_eq!(
            controlled.semantic_epoch_id.as_deref(),
            Some("epoch-current")
        );
        assert_eq!(controlled.reasons, vec!["before-cutover"]);
    }

    #[test]
    fn controlled_before_cutover_requeues_verify_after_reusable_clean_verify() {
        let db = open_clean_before_cutover_db();
        let legacy =
            discover_before_cutover_maintenance_work_with_coordinates(&db, "project-1", None)
                .expect("legacy BeforeCutover discovery");

        let should_stop = || Ok::<_, anyhow::Error>(());
        let no_op = |_item: &DesiredWork| Ok::<_, anyhow::Error>(());
        let no_op_run = |_run_id: &str| Ok::<_, anyhow::Error>(());
        let no_op_finalize = |_work_key: &str| Ok::<_, anyhow::Error>(());
        let control = MaintenanceCycleControl {
            should_stop: &should_stop,
            stop_signal: None,
            finalization_granted_signal: None,
            defer_preempted_run: &no_op_run,
            grant_finalize: &no_op_finalize,
            register_work: &no_op,
            work_started: &no_op,
            work_completed: &no_op,
            work_noop_completed: &no_op,
            work_deferred: &no_op,
        };
        let controlled = discover_before_cutover_maintenance_work_with_coordinates_and_control(
            &db,
            "project-1",
            None,
            &control,
        )
        .expect("controlled BeforeCutover discovery");

        assert_eq!(legacy, controlled);
        let work = controlled.expect("BeforeCutover must schedule Verify");
        assert_eq!(work.run_kind, AutomaticRunKind::Verify);
        assert_eq!(work.work_key, "dependency-verify:epoch-current");
        assert_eq!(work.reasons, vec!["before-cutover"]);
    }

    #[test]
    fn equal_latest_failed_runs_fail_closed_for_recovery_and_retry_evidence() {
        let db = open_pending_recovery_db();
        let work = recovery_work(AutomaticRunKind::RebuildDerived, "epoch-current");
        db.with_conn(|conn| {
            for (run_id, terminal_code) in [
                ("failed-tie-a", "NEX_MAINTENANCE_TRANSIENT"),
                ("failed-tie-b", "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"),
            ] {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at,
                         terminal_reason_code, run_kind, semantic_epoch_id, work_key)
                     VALUES (?1, 'project-1', 'maintenance', '{}', '{}', 'digest',
                             'failed', '{}', '2026-01-03T00:00:00.000Z',
                             '2026-01-03T00:00:01.000Z', '2026-01-03T00:00:02.000Z',
                             ?2, 'semantic-index-rebuild', 'epoch-current', ?3)",
                    params![run_id, terminal_code, work.work_key],
                )?;
            }
            Ok(())
        })
        .expect("seed equal-instant failed Runs");

        let ledger_error = read_run_ledger_for_epoch(&db, &work, Some("epoch-current"))
            .expect_err("equal maximal failed Runs must not be ordered by row ID");
        assert!(
            ledger_error
                .to_string()
                .contains("NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS"),
            "unexpected ledger error: {ledger_error:#}"
        );
        let retry_error = retry_not_before(&db, &work)
            .expect_err("retry evidence must use the same unique lifecycle selector");
        assert!(
            retry_error
                .to_string()
                .contains("NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS"),
            "unexpected retry selector error: {retry_error:#}"
        );
    }

    #[test]
    fn rebuild_selector_errors_are_durable_manual_halts_not_new_dispatches() {
        for (label, rows, unreadable_spec_json, expected_code) in [
            (
                "equal completed lifecycle instant",
                vec![
                    ("rebuild-tie-a", "2026-01-03T00:00:02.000Z"),
                    ("rebuild-tie-b", "2026-01-03T00:00:02.000Z"),
                ],
                false,
                "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS",
            ),
            (
                "malformed completed lifecycle instant",
                vec![("rebuild-malformed", "not-an-instant")],
                false,
                "NEX_MAINTENANCE_LEDGER_SELECTOR_INVALID",
            ),
            (
                "SQLite read conversion failure",
                vec![("rebuild-unreadable", "2026-01-03T00:00:02.000Z")],
                true,
                "NEX_MAINTENANCE_LEDGER_SELECTOR_INVALID",
            ),
        ] {
            let db = Database::new(std::path::Path::new(":memory:"))
                .expect("open selector-projection database");
            db.migrate().expect("migrate selector-projection database");
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES ('epoch-current', 'project-1', 0, 'initial',
                             '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                for (run_id, completed_at) in &rows {
                    conn.execute(
                        "INSERT INTO narrative_extraction_runs
                            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                             status, coverage_json, created_at, started_at, completed_at,
                             run_kind, semantic_epoch_id, work_key)
                         VALUES (?1, 'project-1', 'maintenance', '{}', '{}', 'digest',
                                 'completed', '{}', '2026-01-03T00:00:00.000Z',
                                 '2026-01-03T00:00:01.000Z', ?2,
                                 'semantic-index-rebuild', 'epoch-current',
                                 'dependency-rebuild-derived')",
                        params![run_id, completed_at],
                    )?;
                }
                if unreadable_spec_json {
                    // SQLite's dynamic typing allows this imported/corrupt
                    // BLOB in a TEXT column. The durable selector reads it
                    // as String, so this exercises a real row-conversion
                    // error rather than a synthetic error return.
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET spec_json = X'00'
                          WHERE id = 'rebuild-unreadable'",
                        [],
                    )?;
                }
                Ok(())
            })
            .expect("seed selector error evidence");
            let request = MaintenanceCycleRequest {
                work: vec![MaintenanceWorkRequest {
                    project_id: "project-1".to_string(),
                    run_kind: AutomaticRunKind::RebuildDerived,
                    work_key: REBUILD_DERIVED_WORK_KEY.to_string(),
                    semantic_epoch_id: Some("epoch-current".to_string()),
                    reasons: vec!["selector-error-regression".to_string()],
                }],
                wake_project_ids: Vec::new(),
                delivery_sequence: None,
                delivery_fingerprint: None,
                workspace_binding: None,
            };

            let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
                .unwrap_or_else(|error| panic!("{label} must project manual evidence: {error:#}"));
            assert_eq!(
                result,
                MaintenanceCycleResult::accepted(false),
                "{label} must not become a delivery retry"
            );
            let (rebuild_count, manual_finding_count): (i64, i64) = db
                .with_conn(|conn| {
                    Ok((
                        conn.query_row(
                            "SELECT COUNT(*) FROM narrative_extraction_runs
                              WHERE project_id = 'project-1'
                                AND run_kind = 'semantic-index-rebuild'",
                            [],
                            |row| row.get(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
                              WHERE project_id = 'project-1'
                                AND id LIKE ?1",
                            params![format!("terminal-failure:v1:{expected_code}:%")],
                            |row| row.get(0),
                        )?,
                    ))
                })
                .expect("inspect selector manual projection");
            assert_eq!(
                rebuild_count,
                i64::try_from(rows.len()).expect("row count fits i64"),
                "{label} must not dispatch a replacement Rebuild"
            );
            assert_eq!(
                manual_finding_count, 1,
                "{label} must be durable/manual-intervention-visible"
            );
        }
    }

    #[test]
    fn ledger_missing_verdict_projects_an_inbox_finding_onto_a_completed_run_anchor() {
        // FAILURE_LEDGER_MISSING is selected exactly when NO failed Run
        // exists, so the failed-Run anchor is structurally impossible for it.
        // The projection must anchor on the latest non-failed Run instead —
        // otherwise the halt verdict never reaches the Maintenance Inbox.
        let db = open_pending_recovery_db();
        let work = recovery_work(AutomaticRunKind::Verify, "epoch-current");
        db.with_conn(|conn| {
            insert_pending_recovery_run(
                conn,
                "run-ledger-gap",
                AutomaticRunKind::Verify,
                "epoch-current",
                &work.work_key,
            )?;
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET status = 'completed',
                        started_at = '2026-01-03T00:00:01.000Z',
                        completed_at = '2026-01-03T00:00:02.000Z'
                  WHERE id = 'run-ledger-gap'",
                [],
            )?;
            Ok(())
        })
        .expect("seed completed run without any failed ledger row");

        let decision = decide_run_recovery_for_epoch(
            &db,
            &work,
            Some("epoch-current"),
            RecoveryMode::SameProcessLive,
            Some("database is locked"),
        )
        .expect("ledger-gap decision");
        assert!(matches!(
            decision.action,
            RecoveryAction::ManualIntervention { ref code }
                if code == "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING"
        ));

        let projected =
            crate::narrative_extraction::terminal_failure::project_manual_intervention_finding(
                &db,
                &work,
                "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING",
            )
            .expect("ledger-gap projection");
        assert!(
            projected.is_some(),
            "ledger-gap verdict must project a durable Finding"
        );
        let anchored: (i64, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*), MAX(run_id)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("read projected observation");
        assert_eq!(anchored, (1, "run-ledger-gap".to_string()));

        // Replaying the identical verdict is idempotent.
        crate::narrative_extraction::terminal_failure::project_manual_intervention_finding(
            &db,
            &work,
            "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING",
        )
        .expect("idempotent ledger-gap replay");
        let replay_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_maintenance_finding_observations
                      WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count replayed observations");
        assert_eq!(replay_count, 1);
    }
}
