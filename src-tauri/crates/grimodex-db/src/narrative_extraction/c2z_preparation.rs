//! C2-Z preparation diagnostics.
//!
//! This module is deliberately read-only. It reports Legacy/Generic
//! Freshness parity, cutover readiness, and a deterministic Application
//! re-key plan without changing schema, durable graph rows, Freshness
//! authority, or human Attention state.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::commit::digest_plan;
pub(crate) use super::consumer_identity::APPLICATION_CONSUMER_KIND;
use super::dependency_edges::{
    canonical_source_object_identity, validate_stored_source_object_identity, RUN_CONSUMER_KIND,
};
use super::maintenance_runtime::{REBUILD_DERIVED_WORK_KEY, VERIFY_WORK_KEY_PREFIX};
use super::restore_rebuild::{
    DependencyGraphVerifyReport, REBUILD_CONTRACT_VERSION, VERIFY_CONTRACT_VERSION,
};
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;

/// All Verify checks required by the C2-Z policy. A stored Verify outcome must
/// explicitly report machine-readable coverage for this complete set before it
/// can be considered a cutover PASS.
pub const REQUIRED_VERIFY_CHECKS: [&str; 13] = [
    "producer-and-generation-consistency",
    "active-edge-duplicates",
    "cross-project-edge",
    "consumer-and-source-key-format",
    "application-revision-artifact-references",
    "dependency-set-digest",
    "contribution-to-application-commit-correspondence",
    "legacy-mirror-migration-parity",
    "edge-state-belongs-to-current-epoch",
    "consumer-freshness-dependency-set-digest",
    "finding-observation-belongs-to-current-epoch",
    "cursor-and-feed-head-consistency",
    "semantic-index-generation-correspondence",
];

/// The exact summary shape emitted by the manual Rebuild-Derived executor.
/// Readiness must not infer a PASS from a legacy alias or a partial object.
const REQUIRED_REBUILD_SUMMARY_FIELDS: [&str; 4] = [
    "consumersEvaluated",
    "edgesEvaluated",
    "consumersSkippedUnresolvableScope",
    "edgesSkippedUnresolvableScope",
];

/// A fail-closed state used by parity, per-gate readiness, and workspace
/// readiness reports.
#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadinessState {
    Passed,
    Incomplete,
    Blocked,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessGate {
    pub state: ReadinessState,
    pub completed: bool,
    pub passed: bool,
    pub reasons: Vec<String>,
}

impl ReadinessGate {
    fn passed() -> Self {
        Self {
            state: ReadinessState::Passed,
            completed: true,
            passed: true,
            reasons: Vec::new(),
        }
    }

    fn incomplete(reason: impl Into<String>) -> Self {
        Self {
            state: ReadinessState::Incomplete,
            completed: false,
            passed: false,
            reasons: vec![reason.into()],
        }
    }

    fn blocked(reason: impl Into<String>) -> Self {
        Self {
            state: ReadinessState::Blocked,
            completed: false,
            passed: false,
            reasons: vec![reason.into()],
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReadiness {
    pub state: ReadinessState,
    pub completed: bool,
    pub passed: bool,
    pub reasons: Vec<String>,
    pub run_id: Option<String>,
    pub contract_supported: bool,
    pub report_clean: bool,
    pub check_coverage_complete: bool,
}

impl VerifyReadiness {
    fn from_gate(gate: ReadinessGate) -> Self {
        Self {
            state: gate.state,
            completed: gate.completed,
            passed: gate.passed,
            reasons: gate.reasons,
            run_id: None,
            contract_supported: false,
            report_clean: false,
            check_coverage_complete: false,
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCutoverReadiness {
    pub project_id: String,
    pub current_epoch_id: Option<String>,
    pub state: ReadinessState,
    pub ready: bool,
    pub legacy_backfill: ReadinessGate,
    pub verify: VerifyReadiness,
    pub derived_state_rebuild: ReadinessGate,
    pub parity: ReadinessGate,
    pub no_active_backfill_or_repair: ReadinessGate,
    pub phase_lifecycle: ReadinessGate,
    pub incremental_runtime: ReadinessGate,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCutoverReadiness {
    pub state: ReadinessState,
    pub ready: bool,
    pub projects: Vec<ProjectCutoverReadiness>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshnessStatusMismatch {
    pub application_id: String,
    pub legacy_status: Option<String>,
    pub generic_status: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySetMismatch {
    pub application_id: String,
    pub legacy_sources: Vec<String>,
    pub generic_sources: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedGenericFreshness {
    pub application_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidLegacyDependency {
    pub application_id: String,
    pub source_kind: String,
    pub source_key: String,
    pub reason: String,
}

type LegacyDependencyLoad = (BTreeMap<String, Vec<String>>, Vec<InvalidLegacyDependency>);
type BackfillRunRow = (String, String, Option<String>);
type VerifyRunRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type IncrementalCursorRow = (
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);
type IncrementalLatestRunRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshnessParityReport {
    pub project_id: String,
    pub state: ReadinessState,
    pub legacy_application_ids: Vec<String>,
    pub generic_application_ids: Vec<String>,
    pub missing_legacy_application_ids: Vec<String>,
    pub missing_generic_application_ids: Vec<String>,
    pub status_mismatches: Vec<FreshnessStatusMismatch>,
    pub dependency_mismatches: Vec<DependencySetMismatch>,
    pub unsupported_generic_values: Vec<UnsupportedGenericFreshness>,
    pub invalid_legacy_dependencies: Vec<InvalidLegacyDependency>,
}

impl FreshnessParityReport {
    pub fn is_passed(&self) -> bool {
        self.state == ReadinessState::Passed
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RekeyMappingKind {
    Exact,
    FanOut,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationRekeyCandidate {
    pub edge_id: String,
    pub run_id: String,
    pub application_id: String,
    pub old_consumer_kind: String,
    pub old_consumer_key: String,
    pub new_consumer_kind: String,
    pub new_consumer_key: String,
    pub source_object_identity: String,
    pub planned_read_set_json: String,
    pub mapping_kind: RekeyMappingKind,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationRekeyFanOut {
    pub edge_id: String,
    pub run_id: String,
    pub source_object_identity: String,
    pub candidates: Vec<ApplicationRekeyCandidate>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnattributedRekeyItem {
    pub edge_id: Option<String>,
    pub run_id: Option<String>,
    pub application_id: Option<String>,
    pub source_object_identity: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyCollision {
    pub edge_id: String,
    pub application_id: String,
    pub source_object_identity: String,
    pub planned_read_set_json: String,
    pub existing_edge_id: String,
    pub existing_read_set_json: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyInvalidItem {
    pub edge_id: Option<String>,
    pub application_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingApplicationTarget {
    pub edge_id: String,
    pub application_id: String,
    pub source_object_identity: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationRekeyPlan {
    pub project_id: String,
    pub exact: Vec<ApplicationRekeyCandidate>,
    pub fan_out: Vec<ApplicationRekeyFanOut>,
    pub unattributed: Vec<UnattributedRekeyItem>,
    pub collisions: Vec<RekeyCollision>,
    pub invalid: Vec<RekeyInvalidItem>,
    pub applications_without_run_id: Vec<String>,
    pub existing_targets: Vec<ExistingApplicationTarget>,
}

impl ApplicationRekeyPlan {
    /// Whether every candidate is deterministic and does not conflict with a
    /// stored Application target. A fan-out is safe when every exact legacy
    /// dependency match is enumerated; it is not collapsed into one guess.
    pub fn is_safe(&self) -> bool {
        self.unattributed.is_empty()
            && self.collisions.is_empty()
            && self.invalid.is_empty()
            && self.applications_without_run_id.is_empty()
    }
}

#[derive(Debug, Clone)]
struct LegacyDependency {
    application_id: String,
    run_id: Option<String>,
    source_object_identity: String,
    observed_revision_token: String,
}

#[derive(Debug, Clone)]
struct RunEdgeForRekey {
    id: String,
    run_id: String,
    source_object_identity: String,
    read_set_json: String,
    owning_run_id: Option<String>,
    owning_run_exists_in_project: bool,
}

/// Read-only Legacy ↔ Generic Application Freshness parity report.
pub fn inspect_legacy_generic_freshness_parity(
    conn: &Connection,
    project_id: &str,
) -> Result<FreshnessParityReport> {
    require_project_id(project_id)?;

    let (legacy_statuses, application_ids) = load_legacy_statuses(conn, project_id)?;
    let generic_statuses = load_generic_statuses(conn, project_id)?;
    let (legacy_dependencies, invalid_legacy_dependencies) =
        load_legacy_dependencies(conn, project_id)?;
    let generic_dependencies = load_generic_application_dependencies(conn, project_id)?;
    let legacy_application_ids = legacy_statuses.keys().cloned().collect::<Vec<_>>();
    let generic_application_ids = generic_statuses.keys().cloned().collect::<Vec<_>>();
    let all_application_ids = application_ids
        .into_iter()
        .chain(legacy_statuses.keys().cloned())
        .chain(generic_statuses.keys().cloned())
        .chain(legacy_dependencies.keys().cloned())
        .chain(generic_dependencies.keys().cloned())
        .collect::<BTreeSet<_>>();

    let missing_legacy_application_ids = all_application_ids
        .iter()
        .filter(|application_id| !legacy_statuses.contains_key(*application_id))
        .cloned()
        .collect::<Vec<_>>();
    let missing_generic_application_ids = all_application_ids
        .iter()
        .filter(|application_id| !generic_statuses.contains_key(*application_id))
        .cloned()
        .collect::<Vec<_>>();

    let mut status_mismatches = Vec::new();
    let mut unsupported_generic_values = Vec::new();
    for application_id in &all_application_ids {
        let legacy_status = legacy_statuses.get(application_id).cloned();
        let generic_status = generic_statuses.get(application_id).cloned();
        if let Some(value) = generic_status.as_deref() {
            if !legacy_status_value_is_supported(value) {
                unsupported_generic_values.push(UnsupportedGenericFreshness {
                    application_id: application_id.clone(),
                    value: value.to_string(),
                });
            } else if legacy_status
                .as_deref()
                .is_some_and(|status| status != value)
            {
                status_mismatches.push(FreshnessStatusMismatch {
                    application_id: application_id.clone(),
                    legacy_status,
                    generic_status,
                });
            }
        } else if legacy_status.is_some() {
            // Missing Generic rows are represented by the dedicated coverage
            // vector rather than as a status mismatch.
            continue;
        }
    }

    let mut dependency_mismatches = Vec::new();
    for application_id in &all_application_ids {
        // A missing Freshness row is an evidence-coverage gap, not a proven
        // dependency mismatch. Compare dependency sets only once both
        // authority rows exist and carry Legacy-compatible values; otherwise
        // the report must remain Incomplete rather than escalating absence to
        // a false inconsistency.
        let Some(legacy_status) = legacy_statuses.get(application_id) else {
            continue;
        };
        let Some(generic_status) = generic_statuses.get(application_id) else {
            continue;
        };
        if !legacy_status_value_is_supported(legacy_status)
            || !legacy_status_value_is_supported(generic_status)
        {
            continue;
        }
        let legacy_sources = legacy_dependencies
            .get(application_id)
            .cloned()
            .unwrap_or_default();
        let generic_sources = generic_dependencies
            .get(application_id)
            .cloned()
            .unwrap_or_default();
        if legacy_sources != generic_sources {
            dependency_mismatches.push(DependencySetMismatch {
                application_id: application_id.clone(),
                legacy_sources,
                generic_sources,
            });
        }
    }

    let state = if !status_mismatches.is_empty()
        || !dependency_mismatches.is_empty()
        || !unsupported_generic_values.is_empty()
        || !invalid_legacy_dependencies.is_empty()
    {
        ReadinessState::Blocked
    } else if !missing_legacy_application_ids.is_empty()
        || !missing_generic_application_ids.is_empty()
    {
        ReadinessState::Incomplete
    } else {
        ReadinessState::Passed
    };

    Ok(FreshnessParityReport {
        project_id: project_id.to_string(),
        state,
        legacy_application_ids,
        generic_application_ids,
        missing_legacy_application_ids,
        missing_generic_application_ids,
        status_mismatches,
        dependency_mismatches,
        unsupported_generic_values,
        invalid_legacy_dependencies,
    })
}

/// Pure read-only planner for moving legacy Backfill Run Edges to the
/// Application Consumer kind. It never inserts, updates, deletes, or records
/// a migration marker.
pub fn plan_application_rekey(conn: &Connection, project_id: &str) -> Result<ApplicationRekeyPlan> {
    require_project_id(project_id)?;

    let (legacy_dependencies, mut invalid) = load_legacy_dependencies_for_rekey(conn, project_id)?;
    let mut applications_without_run_id = BTreeSet::new();
    let mut expected_by_run_source: BTreeMap<(String, String), Vec<LegacyDependency>> =
        BTreeMap::new();
    let mut all_legacy_by_application: BTreeMap<String, Vec<LegacyDependency>> = BTreeMap::new();
    let mut legacy_rows_by_application_source: BTreeMap<(String, String), usize> = BTreeMap::new();
    for dependency in legacy_dependencies {
        *legacy_rows_by_application_source
            .entry((
                dependency.application_id.clone(),
                dependency.source_object_identity.clone(),
            ))
            .or_default() += 1;
        if let Some(run_id) = dependency.run_id.clone() {
            expected_by_run_source
                .entry((run_id, dependency.source_object_identity.clone()))
                .or_default()
                .push(dependency.clone());
        } else {
            applications_without_run_id.insert(dependency.application_id.clone());
        }
        all_legacy_by_application
            .entry(dependency.application_id.clone())
            .or_default()
            .push(dependency);
    }
    for ((application_id, source_object_identity), row_count) in legacy_rows_by_application_source {
        if row_count > 1 {
            invalid.push(RekeyInvalidItem {
                edge_id: None,
                application_id: Some(application_id),
                reason: format!(
                    "canonical-source-duplicate:{source_object_identity}:{row_count}-legacy-rows"
                ),
            });
        }
    }

    let run_edges = load_run_edges(conn, project_id)?;
    let mut exact = Vec::new();
    let mut fan_out = Vec::new();
    let mut unattributed = Vec::new();
    let mut collisions = Vec::new();
    let mut existing_targets = Vec::new();
    let mut matched_legacy = BTreeSet::new();

    for edge in run_edges {
        if !edge.owning_run_exists_in_project {
            invalid.push(RekeyInvalidItem {
                edge_id: Some(edge.id.clone()),
                application_id: None,
                reason: "run-edge-owning-run-missing-or-foreign-project".to_string(),
            });
            continue;
        }
        if validate_stored_source_object_identity(&edge.source_object_identity).is_err() {
            invalid.push(RekeyInvalidItem {
                edge_id: Some(edge.id.clone()),
                application_id: None,
                reason: "run-edge-source-identity-invalid".to_string(),
            });
            continue;
        }
        if edge.owning_run_id.as_deref() != Some(edge.run_id.as_str()) {
            invalid.push(RekeyInvalidItem {
                edge_id: Some(edge.id.clone()),
                application_id: None,
                reason: "run-edge-owning-run-missing-or-mismatched".to_string(),
            });
            continue;
        }

        let old_read_token = match single_rekey_read_set_token(&edge.read_set_json) {
            Ok(token) => token,
            Err(_) => {
                invalid.push(RekeyInvalidItem {
                    edge_id: Some(edge.id.clone()),
                    application_id: None,
                    reason: "run-edge-read-set-invalid".to_string(),
                });
                continue;
            }
        };

        let key = (edge.run_id.clone(), edge.source_object_identity.clone());
        let candidates = expected_by_run_source
            .get(&key)
            .cloned()
            .unwrap_or_default();
        if candidates.is_empty() {
            unattributed.push(UnattributedRekeyItem {
                edge_id: Some(edge.id),
                run_id: Some(edge.run_id),
                application_id: None,
                source_object_identity: Some(edge.source_object_identity),
                reason: "run-edge-has-no-legacy-application-dependency".to_string(),
            });
            continue;
        }

        let mapping_kind = if candidates.len() == 1 {
            RekeyMappingKind::Exact
        } else {
            RekeyMappingKind::FanOut
        };
        let mut planned_candidates = Vec::new();
        for dependency in candidates {
            matched_legacy.insert((
                dependency.application_id.clone(),
                dependency.source_object_identity.clone(),
            ));
            let planned_read_set_json =
                serde_json::to_string(&[dependency.observed_revision_token])?;
            if let Some((existing_edge_id, existing_read_set_json)) =
                find_existing_application_edge(
                    conn,
                    project_id,
                    &dependency.application_id,
                    &dependency.source_object_identity,
                )?
            {
                if existing_read_set_json != planned_read_set_json {
                    collisions.push(RekeyCollision {
                        edge_id: edge.id.clone(),
                        application_id: dependency.application_id.clone(),
                        source_object_identity: dependency.source_object_identity.clone(),
                        planned_read_set_json: planned_read_set_json.clone(),
                        existing_edge_id,
                        existing_read_set_json,
                    });
                } else {
                    existing_targets.push(ExistingApplicationTarget {
                        edge_id: existing_edge_id,
                        application_id: dependency.application_id.clone(),
                        source_object_identity: dependency.source_object_identity.clone(),
                    });
                }
            }
            let application_id = dependency.application_id;
            planned_candidates.push(ApplicationRekeyCandidate {
                edge_id: edge.id.clone(),
                run_id: edge.run_id.clone(),
                application_id: application_id.clone(),
                old_consumer_kind: RUN_CONSUMER_KIND.to_string(),
                old_consumer_key: edge.run_id.clone(),
                new_consumer_kind: APPLICATION_CONSUMER_KIND.to_string(),
                new_consumer_key: application_id,
                source_object_identity: dependency.source_object_identity,
                planned_read_set_json,
                mapping_kind: mapping_kind.clone(),
            });
        }
        let matching_read_set = planned_candidates.iter().any(|candidate| {
            single_rekey_read_set_token(&candidate.planned_read_set_json)
                .map(|token| token == old_read_token)
                .unwrap_or(false)
        });
        if !matching_read_set {
            invalid.push(RekeyInvalidItem {
                edge_id: Some(edge.id.clone()),
                application_id: planned_candidates
                    .first()
                    .map(|candidate| candidate.application_id.clone()),
                reason: if mapping_kind == RekeyMappingKind::Exact {
                    "run-edge-read-set-mismatch".to_string()
                } else {
                    "run-edge-read-set-mismatch-fan-out".to_string()
                },
            });
            continue;
        }
        if mapping_kind == RekeyMappingKind::Exact {
            exact.extend(planned_candidates);
        } else {
            fan_out.push(ApplicationRekeyFanOut {
                edge_id: edge.id,
                run_id: edge.run_id,
                source_object_identity: edge.source_object_identity,
                candidates: planned_candidates,
            });
        }
    }

    for dependencies in all_legacy_by_application.values() {
        for dependency in dependencies {
            if dependency.run_id.is_some()
                && !matched_legacy.contains(&(
                    dependency.application_id.clone(),
                    dependency.source_object_identity.clone(),
                ))
            {
                unattributed.push(UnattributedRekeyItem {
                    edge_id: None,
                    run_id: dependency.run_id.clone(),
                    application_id: Some(dependency.application_id.clone()),
                    source_object_identity: Some(dependency.source_object_identity.clone()),
                    reason: "legacy-application-dependency-has-no-run-edge".to_string(),
                });
            }
        }
    }

    let mut applications_without_run_id =
        applications_without_run_id.into_iter().collect::<Vec<_>>();
    applications_without_run_id.sort();
    Ok(ApplicationRekeyPlan {
        project_id: project_id.to_string(),
        exact,
        fan_out,
        unattributed,
        collisions,
        invalid,
        applications_without_run_id,
        existing_targets,
    })
}

/// Inspect every Project in this database connection. A Workspace is ready
/// only when every Project is ready; missing Projects are reported as
/// incomplete rather than vacuously passing.
pub fn inspect_workspace_cutover_readiness(conn: &Connection) -> Result<WorkspaceCutoverReadiness> {
    let mut statement = conn.prepare("SELECT id FROM projects ORDER BY created_at ASC, id ASC")?;
    let project_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if project_ids.is_empty() {
        return Ok(WorkspaceCutoverReadiness {
            state: ReadinessState::Incomplete,
            ready: false,
            projects: Vec::new(),
        });
    }
    let projects = project_ids
        .iter()
        .map(|project_id| inspect_project_cutover_readiness(conn, project_id))
        .collect::<Result<Vec<_>>>()?;
    let state = aggregate_states(projects.iter().map(|project| project.state));
    Ok(WorkspaceCutoverReadiness {
        state,
        ready: state == ReadinessState::Passed,
        projects,
    })
}

/// Inspect one Project's C2-Z gates without triggering any Run or repair.
pub fn inspect_project_cutover_readiness(
    conn: &Connection,
    project_id: &str,
) -> Result<ProjectCutoverReadiness> {
    require_project_id(project_id)?;
    let current_epoch_id = current_epoch_id(conn, project_id)?;
    let legacy_backfill = inspect_backfill_gate(conn, project_id, current_epoch_id.as_deref())?;
    let mut verify = inspect_verify_gate(conn, project_id, current_epoch_id.as_deref())?;
    let derived_state_rebuild =
        inspect_rebuild_gate(conn, project_id, current_epoch_id.as_deref())?;
    let parity_report = inspect_legacy_generic_freshness_parity(conn, project_id)?;
    let parity = gate_from_state(parity_report.state, "legacy-generic-parity");
    let no_active_backfill_or_repair = inspect_active_gate(conn, project_id)?;
    let phase_lifecycle =
        inspect_phase_lifecycle_gate(conn, project_id, current_epoch_id.as_deref())?;
    let incremental_runtime =
        inspect_incremental_runtime_gate(conn, project_id, current_epoch_id.as_deref())?;

    // Keep Verify's detail fields useful even when the gate is incomplete.
    if verify.run_id.is_none() && verify.completed {
        verify.reasons.push("verify-run-id-missing".to_string());
    }
    let state = aggregate_states([
        legacy_backfill.state,
        verify.state,
        derived_state_rebuild.state,
        parity.state,
        no_active_backfill_or_repair.state,
        phase_lifecycle.state,
        incremental_runtime.state,
    ]);
    Ok(ProjectCutoverReadiness {
        project_id: project_id.to_string(),
        current_epoch_id,
        state,
        ready: state == ReadinessState::Passed,
        legacy_backfill,
        verify,
        derived_state_rebuild,
        parity,
        no_active_backfill_or_repair,
        phase_lifecycle,
        incremental_runtime,
    })
}

fn require_project_id(project_id: &str) -> Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    Ok(())
}

fn current_epoch_id(conn: &Connection, project_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM narrative_semantic_epochs
          WHERE project_id = ?1 ORDER BY epoch_number DESC LIMIT 1",
        params![project_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn aggregate_states(states: impl IntoIterator<Item = ReadinessState>) -> ReadinessState {
    let states = states.into_iter().collect::<Vec<_>>();
    if states.contains(&ReadinessState::Blocked) {
        ReadinessState::Blocked
    } else if states.contains(&ReadinessState::Incomplete) {
        ReadinessState::Incomplete
    } else {
        ReadinessState::Passed
    }
}

fn gate_from_state(state: ReadinessState, name: &str) -> ReadinessGate {
    match state {
        ReadinessState::Passed => ReadinessGate::passed(),
        ReadinessState::Incomplete => ReadinessGate::incomplete(name),
        ReadinessState::Blocked => ReadinessGate::blocked(name),
    }
}

fn load_legacy_statuses(
    conn: &Connection,
    project_id: &str,
) -> Result<(BTreeMap<String, String>, BTreeSet<String>)> {
    let mut statement = conn.prepare(
        "SELECT a.id, f.status
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id = a.commit_id
           LEFT JOIN narrative_projection_freshness f ON f.application_id = a.id
          WHERE c.project_id = ?1
          ORDER BY a.id ASC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut statuses = BTreeMap::new();
    let mut application_ids = BTreeSet::new();
    for row in rows {
        let (application_id, status) = row?;
        application_ids.insert(application_id.clone());
        if let Some(status) = status {
            statuses.insert(application_id, status);
        }
    }
    Ok((statuses, application_ids))
}

fn load_generic_statuses(conn: &Connection, project_id: &str) -> Result<BTreeMap<String, String>> {
    let mut statement = conn.prepare(
        "SELECT consumer_key, evidence_freshness
           FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = ?2
          ORDER BY consumer_key ASC",
    )?;
    let rows = statement.query_map(params![project_id, APPLICATION_CONSUMER_KIND], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()?)
}

fn legacy_status_value_is_supported(value: &str) -> bool {
    matches!(
        value,
        "fresh" | "stale" | "source-missing" | "anchor-mismatch" | "read-set-drift"
    )
}

fn load_legacy_dependencies(conn: &Connection, project_id: &str) -> Result<LegacyDependencyLoad> {
    let mut statement = conn.prepare(
        "SELECT a.id, d.source_kind, d.source_key
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id = a.commit_id
           JOIN narrative_projection_dependencies d ON d.application_id = a.id
          WHERE c.project_id = ?1
          ORDER BY a.id ASC, d.source_kind ASC, d.source_key ASC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut dependencies: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut invalid = Vec::new();
    for row in rows {
        let (application_id, source_kind, source_key) = row?;
        match canonical_source_object_identity(&source_kind, &source_key) {
            Ok(identity) => {
                dependencies
                    .entry(application_id)
                    .or_default()
                    .insert(identity);
            }
            Err(error) => invalid.push(InvalidLegacyDependency {
                application_id,
                source_kind,
                source_key,
                reason: error.to_string(),
            }),
        }
    }
    Ok((
        dependencies
            .into_iter()
            .map(|(application_id, sources)| (application_id, sources.into_iter().collect()))
            .collect(),
        invalid,
    ))
}

fn load_generic_application_dependencies(
    conn: &Connection,
    project_id: &str,
) -> Result<BTreeMap<String, Vec<String>>> {
    let mut statement = conn.prepare(
        "SELECT consumer_key, source_object_identity
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2
          ORDER BY consumer_key ASC, source_object_identity ASC",
    )?;
    let rows = statement.query_map(params![project_id, APPLICATION_CONSUMER_KIND], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut dependencies: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in rows {
        let (application_id, source_identity) = row?;
        anyhow::ensure!(
            !source_identity.trim().is_empty(),
            "NEX_C2Z_GENERIC_SOURCE_INVALID: application '{application_id}' has an empty source identity"
        );
        dependencies
            .entry(application_id)
            .or_default()
            .insert(source_identity);
    }
    Ok(dependencies
        .into_iter()
        .map(|(application_id, sources)| (application_id, sources.into_iter().collect()))
        .collect())
}

fn load_legacy_dependencies_for_rekey(
    conn: &Connection,
    project_id: &str,
) -> Result<(Vec<LegacyDependency>, Vec<RekeyInvalidItem>)> {
    let mut statement = conn.prepare(
        "SELECT a.id, c.run_id, d.source_kind, d.source_key, d.observed_revision_token
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id = a.commit_id
           JOIN narrative_projection_dependencies d ON d.application_id = a.id
          WHERE c.project_id = ?1
          ORDER BY a.id ASC, d.source_kind ASC, d.source_key ASC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut dependencies = Vec::new();
    let mut invalid = Vec::new();
    for row in rows {
        let (application_id, run_id, source_kind, source_key, observed_revision_token) = row?;
        match canonical_source_object_identity(&source_kind, &source_key) {
            Ok(source_object_identity) => dependencies.push(LegacyDependency {
                application_id,
                run_id,
                source_object_identity,
                observed_revision_token,
            }),
            Err(error) => invalid.push(RekeyInvalidItem {
                edge_id: None,
                application_id: Some(application_id),
                reason: format!("invalid-legacy-source:{source_kind}:{source_key}: {error}"),
            }),
        }
    }
    Ok((dependencies, invalid))
}

fn load_run_edges(conn: &Connection, project_id: &str) -> Result<Vec<RunEdgeForRekey>> {
    let mut statement = conn.prepare(
        "SELECT edge.id, edge.consumer_key, edge.source_object_identity,
                edge.read_set_json, edge.owning_run_id,
                CASE WHEN run.id IS NULL THEN 0 ELSE 1 END
           FROM narrative_dependency_edges edge
           LEFT JOIN narrative_extraction_runs run
             ON run.id = edge.owning_run_id AND run.project_id = ?1
          WHERE edge.project_id = ?1 AND edge.consumer_kind = ?2
          ORDER BY edge.consumer_key ASC, edge.source_object_identity ASC, edge.id ASC",
    )?;
    let rows = statement.query_map(params![project_id, RUN_CONSUMER_KIND], |row| {
        Ok(RunEdgeForRekey {
            id: row.get(0)?,
            run_id: row.get(1)?,
            source_object_identity: row.get(2)?,
            read_set_json: row.get(3)?,
            owning_run_id: row.get(4)?,
            owning_run_exists_in_project: row.get::<_, i64>(5)? != 0,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn single_rekey_read_set_token(read_set_json: &str) -> Result<String> {
    let values: Vec<Value> = serde_json::from_str(read_set_json)?;
    anyhow::ensure!(
        values.len() == 1,
        "C2-Z re-key read set must contain exactly one observed token"
    );
    let token = values[0]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("C2-Z re-key read set token must be a string"))?;
    anyhow::ensure!(
        !token.trim().is_empty() && token.trim() == token,
        "C2-Z re-key read set token must be non-empty and unpadded"
    );
    Ok(token.to_string())
}

fn find_existing_application_edge(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
    source_object_identity: &str,
) -> Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT id, read_set_json
           FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3
            AND source_object_identity = ?4",
        params![
            project_id,
            APPLICATION_CONSUMER_KIND,
            application_id,
            source_object_identity
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(Into::into)
}

fn inspect_backfill_gate(
    conn: &Connection,
    project_id: &str,
    epoch_id: Option<&str>,
) -> Result<ReadinessGate> {
    let Some(epoch_id) = epoch_id else {
        return Ok(ReadinessGate::incomplete("current-semantic-epoch-missing"));
    };
    let row: Option<BackfillRunRow> = conn
        .query_row(
            "SELECT id, status, semantic_epoch_id
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'backfill'
                AND work_key = 'legacy-dependency-backfill:v3'
              ORDER BY created_at DESC, id DESC LIMIT 1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((_, status, run_epoch_id)) = row else {
        return Ok(ReadinessGate::incomplete("legacy-backfill-run-missing"));
    };
    if status != "completed" {
        return Ok(if matches!(status.as_str(), "pending" | "running") {
            ReadinessGate::blocked("legacy-backfill-active")
        } else {
            ReadinessGate::blocked("legacy-backfill-not-completed")
        });
    }
    if run_epoch_id.as_deref() != Some(epoch_id) {
        return Ok(ReadinessGate::blocked("legacy-backfill-epoch-mismatch"));
    }
    Ok(ReadinessGate::passed())
}

fn inspect_verify_gate(
    conn: &Connection,
    project_id: &str,
    epoch_id: Option<&str>,
) -> Result<VerifyReadiness> {
    let Some(epoch_id) = epoch_id else {
        return Ok(VerifyReadiness::from_gate(ReadinessGate::incomplete(
            "current-semantic-epoch-missing",
        )));
    };
    let row: Option<VerifyRunRow> = conn
        .query_row(
            "SELECT id, status, semantic_epoch_id, work_key, outcome_summary_json
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'dependency-verify'
              ORDER BY created_at DESC, id DESC LIMIT 1",
            params![project_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((run_id, status, run_epoch_id, work_key, outcome_json)) = row else {
        return Ok(VerifyReadiness::from_gate(ReadinessGate::incomplete(
            "verify-run-missing",
        )));
    };
    let mut result = VerifyReadiness::from_gate(ReadinessGate::incomplete("verify-incomplete"));
    result.run_id = Some(run_id);
    if status != "completed" {
        result.state = ReadinessState::Blocked;
        result.reasons = vec!["verify-run-not-completed".to_string()];
        return Ok(result);
    }
    result.completed = true;
    if run_epoch_id.as_deref() != Some(epoch_id) {
        result.state = ReadinessState::Blocked;
        result.reasons = vec!["verify-epoch-mismatch".to_string()];
        return Ok(result);
    }
    let expected_work_key = format!("{VERIFY_WORK_KEY_PREFIX}{epoch_id}");
    match work_key.as_deref() {
        None => {
            result.state = ReadinessState::Incomplete;
            result.reasons = vec!["verify-work-key-missing".to_string()];
            return Ok(result);
        }
        Some(value) if value != expected_work_key => {
            result.state = ReadinessState::Blocked;
            result.reasons = vec!["verify-work-key-mismatch".to_string()];
            return Ok(result);
        }
        Some(_) => {}
    }
    let Some(outcome_json) = outcome_json else {
        result.reasons = vec!["verify-outcome-missing".to_string()];
        return Ok(result);
    };
    let outcome: Value = match serde_json::from_str(&outcome_json) {
        Ok(value) => value,
        Err(error) => {
            result.reasons = vec![format!("verify-outcome-malformed: {error}")];
            return Ok(result);
        }
    };
    match outcome.get("semanticEpochId").and_then(Value::as_str) {
        None => {
            result.state = ReadinessState::Incomplete;
            result.reasons = vec!["verify-outcome-semantic-epoch-missing".to_string()];
            return Ok(result);
        }
        Some(outcome_epoch_id) if outcome_epoch_id != epoch_id => {
            result.state = ReadinessState::Blocked;
            result.reasons = vec!["verify-outcome-semantic-epoch-mismatch".to_string()];
            return Ok(result);
        }
        Some(_) => {}
    }
    result.contract_supported = outcome.get("verifyContractVersion").and_then(Value::as_str)
        == Some(VERIFY_CONTRACT_VERSION);
    if !result.contract_supported {
        result.state = ReadinessState::Incomplete;
        result.reasons = vec!["verify-contract-unsupported".to_string()];
        return Ok(result);
    }
    let Some(report_value) = outcome.get("report") else {
        result.reasons = vec!["verify-report-missing".to_string()];
        return Ok(result);
    };
    let report: DependencyGraphVerifyReport = match serde_json::from_value(report_value.clone()) {
        Ok(report) => report,
        Err(error) => {
            result.reasons = vec![format!("verify-report-malformed: {error}")];
            return Ok(result);
        }
    };
    let expected_digest = format!("sha256:{}", digest_plan(report_value));
    if outcome.get("reportDigest").and_then(Value::as_str) != Some(expected_digest.as_str()) {
        result.state = ReadinessState::Blocked;
        result.reasons = vec!["verify-report-digest-mismatch".to_string()];
        return Ok(result);
    }
    result.report_clean = report.is_clean();
    result.check_coverage_complete = has_full_verify_coverage(&outcome);
    if !result.report_clean {
        result.state = ReadinessState::Blocked;
        result.reasons = vec!["verify-report-not-clean".to_string()];
    } else if !result.check_coverage_complete {
        result.state = ReadinessState::Incomplete;
        result.reasons = vec!["verify-check-coverage-incomplete".to_string()];
    } else {
        result.state = ReadinessState::Passed;
        result.passed = true;
        result.reasons.clear();
    }
    Ok(result)
}

fn has_full_verify_coverage(outcome: &Value) -> bool {
    let Some(coverage) = outcome.get("checkCoverage").and_then(Value::as_object) else {
        return false;
    };
    if coverage.get("complete").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some(required) = coverage.get("required").and_then(Value::as_array) else {
        return false;
    };
    let Some(covered) = coverage.get("covered").and_then(Value::as_array) else {
        return false;
    };
    let required_set = required
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let covered_set = covered
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let expected_set = REQUIRED_VERIFY_CHECKS.into_iter().collect::<BTreeSet<_>>();
    required_set == expected_set
        && expected_set.iter().all(|check| covered_set.contains(check))
        && coverage
            .get("missing")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
}

fn inspect_rebuild_gate(
    conn: &Connection,
    project_id: &str,
    epoch_id: Option<&str>,
) -> Result<ReadinessGate> {
    let Some(epoch_id) = epoch_id else {
        return Ok(ReadinessGate::incomplete("current-semantic-epoch-missing"));
    };
    let row: Option<VerifyRunRow> = conn
        .query_row(
            "SELECT id, status, semantic_epoch_id, work_key, outcome_summary_json
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'semantic-index-rebuild'
              ORDER BY created_at DESC, id DESC LIMIT 1",
            params![project_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((_, status, run_epoch_id, work_key, outcome_json)) = row else {
        return Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-run-missing",
        ));
    };
    if status != "completed" {
        return Ok(ReadinessGate::blocked(
            "derived-state-rebuild-not-completed",
        ));
    }
    if run_epoch_id.as_deref() != Some(epoch_id) {
        return Ok(ReadinessGate::blocked(
            "derived-state-rebuild-epoch-mismatch",
        ));
    }
    match work_key.as_deref() {
        None => {
            return Ok(ReadinessGate::incomplete(
                "derived-state-rebuild-work-key-missing",
            ));
        }
        Some(value) if value != REBUILD_DERIVED_WORK_KEY => {
            return Ok(ReadinessGate::blocked(
                "derived-state-rebuild-work-key-mismatch",
            ));
        }
        Some(_) => {}
    }
    let Some(outcome_json) = outcome_json else {
        return Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-summary-missing",
        ));
    };
    let outcome: Value = match serde_json::from_str(&outcome_json) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ReadinessGate::incomplete(
                "derived-state-rebuild-summary-malformed",
            ));
        }
    };

    match outcome
        .get("rebuildContractVersion")
        .and_then(Value::as_str)
    {
        None => {
            return Ok(ReadinessGate::incomplete(
                "derived-state-rebuild-contract-missing",
            ));
        }
        Some(version) if version != REBUILD_CONTRACT_VERSION => {
            return Ok(ReadinessGate::blocked(
                "derived-state-rebuild-contract-unsupported",
            ));
        }
        Some(_) => {}
    }
    match outcome.get("semanticEpochId").and_then(Value::as_str) {
        None => {
            return Ok(ReadinessGate::incomplete(
                "derived-state-rebuild-outcome-semantic-epoch-missing",
            ));
        }
        Some(outcome_epoch_id) if outcome_epoch_id != epoch_id => {
            return Ok(ReadinessGate::blocked(
                "derived-state-rebuild-outcome-semantic-epoch-mismatch",
            ));
        }
        Some(_) => {}
    }

    let Some(summary) = outcome.get("summary").and_then(Value::as_object) else {
        return Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-summary-missing",
        ));
    };
    if summary.keys().any(|key| {
        !REQUIRED_REBUILD_SUMMARY_FIELDS
            .iter()
            .any(|field| *field == key)
    }) {
        return Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-summary-shape-invalid",
        ));
    }
    let summary_value = Value::Object(summary.clone());
    let Some(summary_digest) = outcome.get("summaryDigest").and_then(Value::as_str) else {
        return Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-summary-digest-missing",
        ));
    };
    let expected_summary_digest = format!("sha256:{}", digest_plan(&summary_value));
    if summary_digest != expected_summary_digest {
        return Ok(ReadinessGate::blocked(
            "derived-state-rebuild-summary-digest-mismatch",
        ));
    }
    if REQUIRED_REBUILD_SUMMARY_FIELDS
        .iter()
        .any(|field| summary.get(*field).and_then(Value::as_u64).is_none())
    {
        return Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-summary-incomplete",
        ));
    }
    let skipped_consumers = summary
        .get("consumersSkippedUnresolvableScope")
        .and_then(Value::as_u64);
    let skipped_edges = summary
        .get("edgesSkippedUnresolvableScope")
        .and_then(Value::as_u64);
    match (skipped_consumers, skipped_edges) {
        (Some(0), Some(0)) => Ok(ReadinessGate::passed()),
        (Some(_), Some(_)) => Ok(ReadinessGate::blocked(
            "derived-state-rebuild-skipped-unresolvable-scope",
        )),
        _ => Ok(ReadinessGate::incomplete(
            "derived-state-rebuild-summary-incomplete",
        )),
    }
}

/// The maintenance lifecycle contract behind each phase Run: exactly one
/// Task and exactly one Attempt, all terminalized together. A completed Run
/// row alone proves neither that the phase actually executed under the
/// lifecycle owner nor when it did; this gate proves both the closure and
/// the Backfill -> Rebuild -> confirmation-Verify causal order from parsed
/// lifecycle instants, failing closed on unparseable or tied evidence.
fn inspect_phase_lifecycle_gate(
    conn: &Connection,
    project_id: &str,
    epoch_id: Option<&str>,
) -> Result<ReadinessGate> {
    let Some(epoch_id) = epoch_id else {
        return Ok(ReadinessGate::incomplete("current-semantic-epoch-missing"));
    };

    struct PhaseRun {
        run_id: String,
        created_at: String,
        completed_at: Option<String>,
    }

    let latest_phase = |run_kind: &str, work_key: Option<&str>| -> Result<Option<PhaseRun>> {
        let (sql, params_vec): (String, Vec<&str>) = match work_key {
            Some(work_key) => (
                "SELECT id, status, semantic_epoch_id, created_at, completed_at
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3
                  ORDER BY created_at DESC, id DESC LIMIT 1"
                    .to_string(),
                vec![project_id, run_kind, work_key],
            ),
            None => (
                "SELECT id, status, semantic_epoch_id, created_at, completed_at
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = ?2
                  ORDER BY created_at DESC, id DESC LIMIT 1"
                    .to_string(),
                vec![project_id, run_kind],
            ),
        };
        type PhaseRunRow = (String, String, Option<String>, String, Option<String>);
        let row: Option<PhaseRunRow> = conn
            .query_row(&sql, rusqlite::params_from_iter(params_vec), |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .optional()?;
        Ok(
            row.and_then(|(run_id, status, run_epoch, created_at, completed_at)| {
                (status == "completed" && run_epoch.as_deref() == Some(epoch_id)).then_some(
                    PhaseRun {
                        run_id,
                        created_at,
                        completed_at,
                    },
                )
            }),
        )
    };

    let backfill = latest_phase("backfill", Some("legacy-dependency-backfill:v3"))?;
    let verify = latest_phase("dependency-verify", None)?;
    let rebuild = latest_phase("semantic-index-rebuild", None)?;
    let (Some(backfill), Some(verify), Some(rebuild)) = (backfill, verify, rebuild) else {
        // The per-phase gates report the precise missing/blocked reason.
        return Ok(ReadinessGate::incomplete(
            "phase-lifecycle-evidence-missing",
        ));
    };

    for (phase, run) in [
        ("backfill", &backfill),
        ("verify", &verify),
        ("rebuild", &rebuild),
    ] {
        let (task_total, task_closed): (i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'completed'
                                       AND completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)
               FROM narrative_extraction_tasks WHERE run_id = ?1",
            params![run.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (attempt_total, attempt_closed): (i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN a.status = 'completed'
                                       AND a.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)
               FROM narrative_extraction_attempts a
               JOIN narrative_extraction_tasks t ON t.id = a.task_id
              WHERE t.run_id = ?1",
            params![run.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if task_total != 1 || task_closed != 1 || attempt_total != 1 || attempt_closed != 1 {
            return Ok(ReadinessGate::blocked(format!(
                "phase-lifecycle-closure-invalid:{phase}"
            )));
        }
    }

    let parse_instant = |value: Option<&str>| -> Option<chrono::DateTime<chrono::Utc>> {
        value.and_then(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|parsed| parsed.with_timezone(&chrono::Utc))
        })
    };
    let backfill_completed = parse_instant(backfill.completed_at.as_deref());
    let rebuild_created = parse_instant(Some(rebuild.created_at.as_str()));
    let rebuild_completed = parse_instant(rebuild.completed_at.as_deref());
    let verify_created = parse_instant(Some(verify.created_at.as_str()));
    let (
        Some(backfill_completed),
        Some(rebuild_created),
        Some(rebuild_completed),
        Some(verify_created),
    ) = (
        backfill_completed,
        rebuild_created,
        rebuild_completed,
        verify_created,
    )
    else {
        return Ok(ReadinessGate::blocked("phase-lifecycle-instant-invalid"));
    };
    // The clean Verify the readiness gate accepted must be the confirmation
    // Verify that strictly followed the Rebuild, and the Rebuild must not
    // predate the Backfill boundary. Equal instants cannot prove order.
    if !(backfill_completed <= rebuild_created && rebuild_completed < verify_created) {
        return Ok(ReadinessGate::blocked("phase-causality-unproven"));
    }
    Ok(ReadinessGate::passed())
}

fn inspect_active_gate(conn: &Connection, project_id: &str) -> Result<ReadinessGate> {
    // Every automatic maintenance kind blocks an irreversible cutover while
    // active: a running Verify or Rebuild changes the very evidence the
    // other gates are reading.
    let active_runs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_extraction_runs
          WHERE project_id = ?1 AND status IN ('pending', 'running')
            AND run_kind IN ('backfill', 'dependency-repair',
                             'dependency-verify', 'semantic-index-rebuild')",
        params![project_id],
        |row| row.get(0),
    )?;
    if active_runs > 0 {
        return Ok(ReadinessGate::blocked("active-backfill-or-repair-run"));
    }
    let (_lease_count, malformed_lease_count): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE
                    WHEN trim(expires_at) = '' OR julianday(expires_at) IS NULL
                    THEN 1 ELSE 0 END), 0)
           FROM narrative_maintenance_repair_leases
          WHERE project_id = ?1",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if malformed_lease_count > 0 {
        return Ok(ReadinessGate::blocked("repair-lease-malformed"));
    }
    let live_lease: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_maintenance_repair_leases
          WHERE project_id = ?1 AND julianday(expires_at) >= julianday('now')",
        params![project_id],
        |row| row.get(0),
    )?;
    if live_lease > 0 {
        return Ok(ReadinessGate::blocked("active-repair-lease"));
    }
    Ok(ReadinessGate::passed())
}

fn inspect_incremental_runtime_gate(
    conn: &Connection,
    project_id: &str,
    epoch_id: Option<&str>,
) -> Result<ReadinessGate> {
    let Some(epoch_id) = epoch_id else {
        return Ok(ReadinessGate::incomplete("current-semantic-epoch-missing"));
    };
    let feed_head: i64 = conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0)
           FROM narrative_change_events WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let cursor: Option<IncrementalCursorRow> = conn
        .query_row(
            "SELECT acknowledged_through_sequence, last_error, semantic_epoch_id,
                    active_run_id, reserved_through_sequence, lease_expires_at
               FROM narrative_change_cursors
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![project_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
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
    let Some((acknowledged, last_error, cursor_epoch, active_run_id, reserved, lease_expires_at)) =
        cursor
    else {
        return Ok(ReadinessGate::incomplete(
            "incremental-freshness-cursor-missing",
        ));
    };
    if acknowledged > feed_head {
        return Ok(ReadinessGate::blocked("cursor-acknowledges-past-feed-head"));
    }
    if acknowledged < feed_head {
        return Ok(ReadinessGate::incomplete(
            "cursor-acknowledges-before-feed-head",
        ));
    }
    if last_error
        .as_deref()
        .is_some_and(|error| !error.trim().is_empty())
    {
        return Ok(ReadinessGate::blocked("incremental-freshness-cursor-error"));
    }
    match (
        active_run_id.as_deref(),
        reserved,
        cursor_epoch.as_deref(),
        lease_expires_at.as_deref(),
    ) {
        // A cursor's epoch and lease belong to the reservation owner.  A
        // cursor with no owner must have all reservation columns cleared;
        // accepting a current epoch without a run would let a stale lease
        // masquerade as durable quiescence.
        (None, None, None, None) => {}
        (Some(run_id), Some(reserved), Some(cursor_epoch), Some(lease_expires_at)) => {
            if reserved < acknowledged || reserved > feed_head {
                return Ok(ReadinessGate::blocked("cursor-reservation-range-invalid"));
            }
            if cursor_epoch != epoch_id {
                return Ok(ReadinessGate::blocked("cursor-reservation-epoch-mismatch"));
            }
            if lease_expires_at.trim().is_empty() {
                return Ok(ReadinessGate::blocked("cursor-reservation-lease-invalid"));
            }
            let lease_valid: bool = conn.query_row(
                "SELECT julianday(?1) IS NOT NULL
                   AND julianday(?1) > julianday('now')",
                [lease_expires_at],
                |row| row.get(0),
            )?;
            if !lease_valid {
                return Ok(ReadinessGate::blocked("cursor-reservation-lease-invalid"));
            }
            let active: Option<(String, String)> = conn
                .query_row(
                    "SELECT project_id, status FROM narrative_extraction_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((run_project_id, status)) = active else {
                return Ok(ReadinessGate::blocked("cursor-active-run-missing"));
            };
            if run_project_id != project_id || !matches!(status.as_str(), "pending" | "running") {
                return Ok(ReadinessGate::blocked("cursor-active-run-invalid"));
            }
            // A reservation, even a well-formed one with a future lease, is
            // active work rather than completed liveness evidence.  Do not
            // let an older completed Run below satisfy the gate while this
            // reservation still owns the cursor.
            return Ok(ReadinessGate::incomplete(
                "incremental-freshness-reservation-active",
            ));
        }
        _ => return Ok(ReadinessGate::blocked("cursor-reservation-shape-invalid")),
    }
    let latest: Option<IncrementalLatestRunRow> = conn
        .query_row(
            "SELECT id, project_id, semantic_epoch_id, status, completed_at,
                    work_key, outcome_summary_json
               FROM narrative_extraction_runs
              WHERE project_id = ?1
                AND run_kind = 'freshness-evaluation'
                AND consumer_id = ?2
              ORDER BY (julianday(created_at) IS NULL) DESC,
                       julianday(created_at) DESC, created_at DESC, id DESC
              LIMIT 1",
            params![project_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
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
    let Some((run_id, run_project_id, run_epoch, status, completed_at, work_key, outcome_json)) =
        latest
    else {
        return Ok(ReadinessGate::incomplete(
            "incremental-freshness-completed-run-missing",
        ));
    };
    if run_project_id != project_id
        || run_epoch.as_deref() != Some(epoch_id)
        || status != "completed"
        || !completed_at.as_deref().is_some_and(is_canonical_instant)
        || work_key
            .as_deref()
            .is_none_or(|key| incremental_work_key_range(key, epoch_id).is_none())
    {
        return Ok(ReadinessGate::incomplete(
            "incremental-freshness-completed-run-not-current",
        ));
    }
    let Some(outcome_json) = outcome_json else {
        return Ok(ReadinessGate::incomplete(
            "incremental-freshness-completed-outcome-missing",
        ));
    };
    let outcome: Value = match serde_json::from_str(&outcome_json) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ReadinessGate::blocked(
                "incremental-freshness-completed-outcome-malformed",
            ))
        }
    };
    let outcome_run_id = outcome.get("runId").and_then(Value::as_str);
    let outcome_project_id = outcome.get("projectId").and_then(Value::as_str);
    let through_sequence = outcome
        .get("throughSequenceInclusive")
        .and_then(Value::as_i64);
    let from_sequence = outcome.get("fromSequenceExclusive").and_then(Value::as_i64);
    let has_more = outcome.get("hasMore").and_then(Value::as_bool);
    let Some(from_sequence) = from_sequence else {
        return Ok(ReadinessGate::blocked(
            "incremental-freshness-completed-outcome-sequence-invalid",
        ));
    };
    if from_sequence < 0 || from_sequence > feed_head {
        return Ok(ReadinessGate::blocked(
            "incremental-freshness-completed-outcome-sequence-invalid",
        ));
    }
    let Some((work_key_from, work_key_through)) = work_key
        .as_deref()
        .and_then(|key| incremental_work_key_range(key, epoch_id))
    else {
        return Ok(ReadinessGate::blocked(
            "incremental-freshness-completed-work-key-invalid",
        ));
    };
    if outcome_run_id != Some(run_id.as_str())
        || outcome_project_id != Some(project_id)
        || work_key_from != from_sequence
        || work_key_through != feed_head
        || through_sequence != Some(feed_head)
        || has_more != Some(false)
    {
        return Ok(ReadinessGate::blocked(
            "incremental-freshness-completed-outcome-not-at-feed-head",
        ));
    }
    // The database can prove that the last observed run reached the Feed
    // head, but it cannot prove that a scheduler is still alive and able to
    // process the next event.  Keep this gate incomplete until a real
    // external scheduler-health evidence seam exists; a completed Run must
    // never self-attest its producer's liveness.
    Ok(ReadinessGate::incomplete(
        "incremental-freshness-scheduler-liveness-evidence-unavailable",
    ))
}

fn is_canonical_instant(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == value)
        .unwrap_or(false)
}

fn incremental_work_key_range(key: &str, epoch_id: &str) -> Option<(i64, i64)> {
    let mut parts = key.split(':');
    if parts.next()? != "incremental-freshness" || parts.next()? != epoch_id {
        return None;
    }
    let from = parts.next()?.parse::<i64>().ok()?;
    let through = parts.next()?.parse::<i64>().ok()?;
    let digest = parts.next()?;
    if parts.next().is_some() || digest.trim().is_empty() {
        return None;
    }
    Some((from, through))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::Database;
    use rusqlite::{params, Connection};
    use std::path::Path;

    use super::super::restore_rebuild::rebuild_narrative_derived_state_for_project;

    const PROJECT_ID: &str = "project-c2z";
    const EPOCH_ID: &str = "epoch-c2z";
    const APPLICATION_ID: &str = "application-c2z";
    const COMMIT_ID: &str = "commit-c2z";
    const RUN_ID: &str = "run-c2z";
    const SOURCE_IDENTITY: &str = "project:scene:scene-c2z";

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate db");
        db.with_conn(|conn| seed_project(conn, PROJECT_ID))
            .expect("seed project");
        db
    }

    fn seed_project(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-Z project')",
            params![project_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-20T00:00:00.000Z')",
            params![EPOCH_ID, project_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, version, run_kind,
                 semantic_epoch_id, work_key)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest-c2z', 'completed',
                     '{}', '2026-08-20T00:00:00.000Z',
                     '2026-08-20T00:00:01.000Z', 0, 'backfill', ?3,
                     'legacy-dependency-backfill:v3')",
            params![RUN_ID, project_id, EPOCH_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, run_id, request_id, plan_digest, status, created_at)
             VALUES (?1, ?2, ?3, 'request-c2z', 'digest-c2z', 'committed',
                     '2026-08-20T00:00:00.000Z')",
            params![COMMIT_ID, project_id, RUN_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                 applied_entity_id, created_at)
             VALUES (?1, ?2, 'proposal-c2z', 'revision-c2z', 'codex-entry',
                     'entry-c2z', '2026-08-20T00:00:00.000Z')",
            params![APPLICATION_ID, COMMIT_ID],
        )?;
        Ok(())
    }

    fn seed_legacy_freshness_and_dependency(conn: &Connection, status: &str) {
        conn.execute(
            "INSERT INTO narrative_projection_freshness
                (application_id, status, reason_json, version, updated_at)
             VALUES (?1, ?2, NULL, 0, '2026-08-20T00:00:00.000Z')",
            params![APPLICATION_ID, status],
        )
        .expect("seed legacy freshness");
        conn.execute(
            "INSERT INTO narrative_projection_dependencies
                (application_id, source_kind, source_key, observed_revision_token, propagation)
             VALUES (?1, 'scene-body', ?2, 'token-c2z', 'freshness-only')",
            params![APPLICATION_ID, SOURCE_IDENTITY],
        )
        .expect("seed legacy dependency");
    }

    fn seed_generic_application(conn: &Connection, status: &str) {
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness,
                 build_action, semantic_epoch_id, last_evaluated_run_id,
                 dependency_set_digest, updated_at)
             VALUES (?1, 'application', ?2, ?3, 'none', ?4, NULL, 'digest-c2z',
                     '2026-08-20T00:00:00.000Z')",
            params![PROJECT_ID, APPLICATION_ID, status, EPOCH_ID],
        )
        .expect("seed generic freshness");
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at, owning_run_id)
             VALUES ('edge-application-c2z', ?1, 'application', ?2, ?3,
                     '[\"token-c2z\"]', '2026-08-20T00:00:00.000Z', ?4)",
            params![PROJECT_ID, APPLICATION_ID, SOURCE_IDENTITY, RUN_ID],
        )
        .expect("seed generic dependency");
    }

    #[test]
    fn parity_is_exact_and_read_only() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_legacy_freshness_and_dependency(conn, "fresh");
            seed_generic_application(conn, "fresh");
            let before = conn.total_changes();

            let report = inspect_legacy_generic_freshness_parity(conn, PROJECT_ID)?;

            assert!(report.is_passed());
            assert!(report.status_mismatches.is_empty());
            assert!(report.dependency_mismatches.is_empty());
            assert_eq!(conn.total_changes(), before);
            Ok(())
        })
        .expect("parity report");
    }

    #[test]
    fn parity_unknown_or_missing_generic_rows_fails_closed() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_legacy_freshness_and_dependency(conn, "fresh");
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, dependency_set_digest, updated_at)
                 VALUES (?1, 'application', ?2, 'unknown', 'manual', ?3,
                         'digest-c2z', '2026-08-20T00:00:00.000Z')",
                params![PROJECT_ID, APPLICATION_ID, EPOCH_ID],
            )?;

            let report = inspect_legacy_generic_freshness_parity(conn, PROJECT_ID)?;

            assert!(!report.is_passed());
            assert_eq!(report.state, ReadinessState::Blocked);
            assert_eq!(report.unsupported_generic_values.len(), 1);

            conn.execute(
                "DELETE FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_kind = 'application'",
                params![PROJECT_ID],
            )?;
            let missing = inspect_legacy_generic_freshness_parity(conn, PROJECT_ID)?;
            assert_eq!(missing.state, ReadinessState::Incomplete);
            assert_eq!(
                missing.missing_generic_application_ids,
                vec![APPLICATION_ID]
            );
            Ok(())
        })
        .expect("fail-closed parity report");
    }

    #[test]
    fn application_rekey_plan_enumerates_fanout_without_writing() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_legacy_freshness_and_dependency(conn, "fresh");
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at)
                 VALUES ('application-c2z-2', ?1, 'proposal-c2z-2', 'revision-c2z-2',
                         'codex-entry', 'entry-c2z-2', '2026-08-20T00:00:00.000Z')",
                params![COMMIT_ID],
            )?;
            conn.execute(
                "INSERT INTO narrative_projection_dependencies
                    (application_id, source_kind, source_key, observed_revision_token,
                     propagation)
                 VALUES ('application-c2z-2', 'scene-body', ?1, 'token-c2z-2',
                         'freshness-only')",
                params![SOURCE_IDENTITY],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at, owning_run_id)
                 VALUES ('edge-run-c2z', ?1, 'narrative-extraction-run', ?2, ?3,
                         '[\"token-c2z\"]', '2026-08-20T00:00:00.000Z', ?2)",
                params![PROJECT_ID, RUN_ID, SOURCE_IDENTITY],
            )?;
            let before = conn.total_changes();
            let plan = plan_application_rekey(conn, PROJECT_ID)?;

            assert!(plan.exact.is_empty());
            assert_eq!(plan.fan_out.len(), 1);
            assert_eq!(plan.fan_out[0].candidates.len(), 2);
            assert!(plan.unattributed.is_empty());
            assert!(plan.collisions.is_empty());
            assert!(plan.invalid.is_empty());
            assert_eq!(conn.total_changes(), before);
            Ok(())
        })
        .expect("rekey dry-run");
    }

    #[test]
    fn readiness_does_not_call_clean_verify_a_full_cutover_pass() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_legacy_freshness_and_dependency(conn, "fresh");
            seed_generic_application(conn, "fresh");
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, outcome_summary_json, created_at, completed_at,
                     version, run_kind, semantic_epoch_id, work_key)
                 VALUES ('verify-c2z', ?1, 'chronicle.verify', '{}', '{}', 'digest',
                         'completed', '{}', ?2, '2026-08-20T00:00:00.000Z',
                         '2026-08-20T00:00:01.000Z', 0, 'dependency-verify', ?3,
                         'dependency-verify:epoch-c2z')",
                params![
                    PROJECT_ID,
                    r#"{"verifyContractVersion":"4","semanticEpochId":"epoch-c2z","reportDigest":"sha256:stub","report":{"totalEdges":0}}"#,
                    EPOCH_ID,
                ],
            )?;
            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;

            assert!(!readiness.ready);
            assert_eq!(readiness.verify.state, ReadinessState::Incomplete);
            assert!(!readiness.verify.completed || !readiness.verify.passed);
            assert_eq!(readiness.incremental_runtime.state, ReadinessState::Incomplete);
            Ok(())
        })
        .expect("readiness report");
    }

    #[test]
    fn verify_outcome_must_name_the_current_semantic_epoch() {
        let db = test_db();
        db.with_conn(|conn| {
            let insert_verify = |outcome: &str| -> anyhow::Result<()> {
                conn.execute(
                    "DELETE FROM narrative_extraction_runs WHERE id = 'verify-c2z-epoch'",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, outcome_summary_json, created_at, completed_at,
                         version, run_kind, semantic_epoch_id, work_key)
                     VALUES ('verify-c2z-epoch', ?1, 'chronicle.verify', '{}', '{}', 'digest',
                             'completed', '{}', ?2, '2026-08-20T00:00:00.000Z',
                             '2026-08-20T00:00:01.000Z', 0, 'dependency-verify', ?3,
                             'dependency-verify:epoch-c2z')",
                    params![PROJECT_ID, outcome, EPOCH_ID],
                )?;
                Ok(())
            };

            insert_verify(r#"{"verifyContractVersion":"4"}"#)?;
            let missing = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(missing.verify.state, ReadinessState::Incomplete);
            assert!(missing
                .verify
                .reasons
                .iter()
                .any(|reason| reason == "verify-outcome-semantic-epoch-missing"));

            insert_verify(r#"{"verifyContractVersion":"4","semanticEpochId":"epoch-other"}"#)?;
            let mismatched = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(mismatched.verify.state, ReadinessState::Blocked);
            assert!(mismatched
                .verify
                .reasons
                .iter()
                .any(|reason| reason == "verify-outcome-semantic-epoch-mismatch"));
            Ok(())
        })
        .expect("verify outcome epoch is required");
    }

    #[test]
    fn verify_run_without_canonical_work_key_is_incomplete() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, outcome_summary_json, created_at, completed_at,
                     version, run_kind, semantic_epoch_id)
                 VALUES ('verify-c2z-work-key-missing', ?1, 'chronicle.verify', '{}', '{}',
                         'digest', 'completed', '{}', '{}', '2026-08-20T00:00:02.000Z',
                         '2026-08-20T00:00:03.000Z', 0, 'dependency-verify', ?2)",
                params![PROJECT_ID, EPOCH_ID],
            )?;

            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;

            assert_eq!(readiness.verify.state, ReadinessState::Incomplete);
            assert!(readiness.verify.completed);
            assert!(!readiness.verify.passed);
            assert!(readiness
                .verify
                .reasons
                .iter()
                .any(|reason| reason == "verify-work-key-missing"));
            Ok(())
        })
        .expect("missing Verify work key remains incomplete");
    }

    #[test]
    fn verify_run_with_noncanonical_work_key_is_blocked() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, outcome_summary_json, created_at, completed_at,
                     version, run_kind, semantic_epoch_id, work_key)
                 VALUES ('verify-c2z-work-key-mismatch', ?1, 'chronicle.verify', '{}', '{}',
                         'digest', 'completed', '{}', '{}', '2026-08-20T00:00:02.000Z',
                         '2026-08-20T00:00:03.000Z', 0, 'dependency-verify', ?2,
                         'dependency-verify:not-the-current-epoch')",
                params![PROJECT_ID, EPOCH_ID],
            )?;

            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;

            assert_eq!(readiness.verify.state, ReadinessState::Blocked);
            assert!(readiness.verify.completed);
            assert!(!readiness.verify.passed);
            assert!(readiness
                .verify
                .reasons
                .iter()
                .any(|reason| reason == "verify-work-key-mismatch"));
            Ok(())
        })
        .expect("noncanonical Verify work key is blocked");
    }

    #[test]
    fn rebuild_summary_missing_keeps_cutover_incomplete() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, completed_at, version, run_kind,
                     semantic_epoch_id, work_key)
                 VALUES ('rebuild-c2z-no-summary', ?1, 'maintenance', '{}', '{}', 'digest',
                         'completed', '{}', '2026-08-20T00:00:00.000Z',
                         '2026-08-20T00:00:01.000Z', 0, 'semantic-index-rebuild', ?2,
                         'dependency-rebuild-derived')",
                params![PROJECT_ID, EPOCH_ID],
            )?;
            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                readiness.derived_state_rebuild.state,
                ReadinessState::Incomplete
            );
            assert!(readiness
                .derived_state_rebuild
                .reasons
                .iter()
                .any(|reason| reason == "derived-state-rebuild-summary-missing"));
            Ok(())
        })
        .expect("missing rebuild evidence remains incomplete");
    }

    #[test]
    fn rebuild_run_without_canonical_work_key_is_incomplete() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, completed_at, version, run_kind,
                     semantic_epoch_id)
                 VALUES ('rebuild-c2z-work-key-missing', ?1, 'maintenance', '{}', '{}',
                         'digest', 'completed', '{}', '2026-08-20T00:00:02.000Z',
                         '2026-08-20T00:00:03.000Z', 0, 'semantic-index-rebuild', ?2)",
                params![PROJECT_ID, EPOCH_ID],
            )?;

            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;

            assert_eq!(
                readiness.derived_state_rebuild.state,
                ReadinessState::Incomplete
            );
            assert!(readiness
                .derived_state_rebuild
                .reasons
                .iter()
                .any(|reason| reason == "derived-state-rebuild-work-key-missing"));
            Ok(())
        })
        .expect("missing Rebuild work key remains incomplete");
    }

    #[test]
    fn rebuild_run_with_noncanonical_work_key_is_blocked() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, completed_at, version, run_kind,
                     semantic_epoch_id, work_key)
                 VALUES ('rebuild-c2z-work-key-mismatch', ?1, 'maintenance', '{}', '{}',
                         'digest', 'completed', '{}', '2026-08-20T00:00:02.000Z',
                         '2026-08-20T00:00:03.000Z', 0, 'semantic-index-rebuild', ?2,
                         'dependency-rebuild-derived:not-canonical')",
                params![PROJECT_ID, EPOCH_ID],
            )?;

            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;

            assert_eq!(
                readiness.derived_state_rebuild.state,
                ReadinessState::Blocked
            );
            assert!(readiness
                .derived_state_rebuild
                .reasons
                .iter()
                .any(|reason| reason == "derived-state-rebuild-work-key-mismatch"));
            Ok(())
        })
        .expect("noncanonical Rebuild work key is blocked");
    }

    #[test]
    fn production_rebuild_outcome_is_accepted_by_cutover_reader() {
        let db = test_db();
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("manual rebuild executor should complete");

        db.with_conn(|conn| {
            let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                readiness.derived_state_rebuild.state,
                ReadinessState::Passed
            );

            let outcome_json: String = conn.query_row(
                "SELECT outcome_summary_json
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'semantic-index-rebuild'
                  ORDER BY created_at DESC, id DESC LIMIT 1",
                params![PROJECT_ID],
                |row| row.get(0),
            )?;
            let outcome: Value = serde_json::from_str(&outcome_json)?;
            assert_eq!(
                outcome
                    .get("rebuildContractVersion")
                    .and_then(Value::as_str),
                Some(REBUILD_CONTRACT_VERSION)
            );
            assert_eq!(
                outcome.get("semanticEpochId").and_then(Value::as_str),
                Some(EPOCH_ID)
            );
            assert!(outcome
                .get("summaryDigest")
                .and_then(Value::as_str)
                .is_some_and(|digest| digest.starts_with("sha256:")));
            let summary = outcome
                .get("summary")
                .and_then(Value::as_object)
                .expect("camelCase rebuild summary");
            for field in REQUIRED_REBUILD_SUMMARY_FIELDS {
                assert!(summary.get(field).and_then(Value::as_u64).is_some());
            }
            Ok(())
        })
        .expect("production rebuild evidence should be readable");
    }

    #[test]
    fn rebuild_outcome_tamper_and_missing_evidence_fail_closed() {
        let db = test_db();
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("manual rebuild executor should complete");

        db.with_conn(|conn| {
            let tampered = r#"{
                "rebuildContractVersion":"1",
                "semanticEpochId":"epoch-c2z",
                "summaryDigest":"sha256:tampered",
                "summary":{
                    "consumersEvaluated":0,
                    "edgesEvaluated":0,
                    "consumersSkippedUnresolvableScope":0,
                    "edgesSkippedUnresolvableScope":0
                }
            }"#;
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET outcome_summary_json = ?1
                  WHERE project_id = ?2 AND run_kind = 'semantic-index-rebuild'",
                params![tampered, PROJECT_ID],
            )?;
            let tampered_readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                tampered_readiness.derived_state_rebuild.state,
                ReadinessState::Blocked
            );
            assert!(tampered_readiness
                .derived_state_rebuild
                .reasons
                .iter()
                .any(|reason| reason == "derived-state-rebuild-summary-digest-mismatch"));

            let missing_contract = r#"{
                "semanticEpochId":"epoch-c2z",
                "summaryDigest":"sha256:tampered",
                "summary":{
                    "consumersEvaluated":0,
                    "edgesEvaluated":0,
                    "consumersSkippedUnresolvableScope":0,
                    "edgesSkippedUnresolvableScope":0
                }
            }"#;
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET outcome_summary_json = ?1
                  WHERE project_id = ?2 AND run_kind = 'semantic-index-rebuild'",
                params![missing_contract, PROJECT_ID],
            )?;
            let missing_readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
            assert_eq!(
                missing_readiness.derived_state_rebuild.state,
                ReadinessState::Incomplete
            );
            assert!(missing_readiness
                .derived_state_rebuild
                .reasons
                .iter()
                .any(|reason| reason == "derived-state-rebuild-contract-missing"));
            Ok(())
        })
        .expect("tampered rebuild evidence must remain fail-closed");
    }

    #[test]
    fn workspace_readiness_requires_every_project() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-c2z-blocked', 'Blocked')",
                [],
            )?;
            let report = inspect_workspace_cutover_readiness(conn)?;
            assert!(!report.ready);
            assert!(report.projects.len() >= 2);
            assert!(report
                .projects
                .iter()
                .any(|project| project.state != ReadinessState::Passed));
            Ok(())
        })
        .expect("workspace readiness report");
    }

    fn seed_run_edge_with_legacy_dependency(
        conn: &Connection,
        suffix: &str,
        run_id: &str,
    ) -> anyhow::Result<()> {
        let commit_id = format!("commit-{suffix}");
        let application_id = format!("application-{suffix}");
        let edge_id = format!("edge-{suffix}");
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, run_id, request_id, plan_digest, status, created_at)
             VALUES (?1, ?2, ?3, ?4, 'digest-c2z', 'committed',
                     '2026-08-20T00:00:00.000Z')",
            params![commit_id, PROJECT_ID, run_id, format!("request-{suffix}")],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                 applied_entity_id, created_at)
             VALUES (?1, ?2, ?3, ?4, 'codex-entry', ?5,
                     '2026-08-20T00:00:00.000Z')",
            params![
                application_id,
                commit_id,
                format!("proposal-{suffix}"),
                format!("revision-{suffix}"),
                format!("entry-{suffix}")
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_projection_dependencies
                (application_id, source_kind, source_key, observed_revision_token,
                 propagation)
             VALUES (?1, 'scene-body', ?2, ?3, 'freshness-only')",
            params![application_id, SOURCE_IDENTITY, format!("token-{suffix}")],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at, owning_run_id)
             VALUES (?1, ?2, 'narrative-extraction-run', ?3, ?4,
                     '[\"token-c2z\"]', '2026-08-20T00:00:00.000Z', ?3)",
            params![edge_id, PROJECT_ID, run_id, SOURCE_IDENTITY],
        )?;
        Ok(())
    }

    #[test]
    fn rekey_plan_invalidates_dangling_and_foreign_owning_runs() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_run_edge_with_legacy_dependency(conn, "dangling", "run-dangling")?;

            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-c2z-foreign', 'Foreign')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
                 VALUES ('run-foreign', 'project-c2z-foreign', 'maintenance', '{}', '{}',
                         'digest', 'completed', '{}', '2026-08-20T00:00:00.000Z',
                         'backfill', ?1, 'legacy-dependency-backfill:v3')",
                params![EPOCH_ID],
            )?;
            seed_run_edge_with_legacy_dependency(conn, "foreign", "run-foreign")?;

            let before = conn.total_changes();
            let plan = plan_application_rekey(conn, PROJECT_ID)?;
            assert!(plan
                .invalid
                .iter()
                .any(|item| { item.reason == "run-edge-owning-run-missing-or-foreign-project" }));
            assert!(!plan.is_safe());
            assert_eq!(conn.total_changes(), before);
            Ok(())
        })
        .expect("invalid owning runs must fail closed");
    }

    #[test]
    fn rekey_plan_invalidates_alias_rows_that_collapse_to_one_application_source() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_projection_dependencies
                    (application_id, source_kind, source_key, observed_revision_token,
                     propagation)
                 VALUES
                    (?1, 'domain-projection', 'projection:projection-c2z', 'token-domain',
                     'freshness-only'),
                    (?1, 'projection', 'projection:projection-c2z', 'token-projection',
                     'freshness-only')",
                params![APPLICATION_ID],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at, owning_run_id)
                 VALUES ('edge-run-projection-c2z', ?1, ?2, ?3, 'projection:projection-c2z',
                         '[\"token-c2z\"]', '2026-08-20T00:00:00.000Z', ?3)",
                params![PROJECT_ID, RUN_CONSUMER_KIND, RUN_ID],
            )?;

            let plan = plan_application_rekey(conn, PROJECT_ID)?;
            assert!(plan.invalid.iter().any(|item| {
                item.application_id.as_deref() == Some(APPLICATION_ID)
                    && item.reason.contains("canonical-source-duplicate")
            }));
            assert!(!plan.is_safe());
            Ok(())
        })
        .expect("canonical alias duplicates must remain unsafe");
    }

    #[test]
    fn malformed_repair_lease_blocks_cutover_readiness() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_maintenance_repair_leases
                    (project_id, lease_owner, verify_run_id, repair_plan_digest,
                     semantic_epoch_id, claimed_at, expires_at)
                 VALUES (?1, 'owner-c2z', 'verify-c2z', 'plan-c2z', ?2,
                         '2026-08-20T00:00:00.000Z', 'not-a-date')",
                params![PROJECT_ID, EPOCH_ID],
            )?;
            let before = conn.total_changes();
            let gate = inspect_active_gate(conn, PROJECT_ID)?;
            assert_eq!(gate.state, ReadinessState::Blocked);
            assert!(gate
                .reasons
                .iter()
                .any(|reason| reason == "repair-lease-malformed"));
            assert_eq!(conn.total_changes(), before);
            Ok(())
        })
        .expect("malformed lease must block");
    }
}
