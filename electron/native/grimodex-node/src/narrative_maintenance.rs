//! Main-process-only Narrative Maintenance discovery adapter.
//!
//! The planner and durable phase state live in `grimodex-db`. This module only
//! pins the already-active Database, enumerates the workspace's projects, and
//! converts the planner's desired work into the camelCase N-API page contract.
//! It never accepts a project id, path, phase, or digest from JavaScript.

use serde::Serialize;

use grimodex_db::narrative_extraction::{
    discover_durable_maintenance_work_with_coordinates, effective_maintenance_coordinates,
    DesiredWork, MaintenanceWorkRequest, MaintenanceWorkspaceBinding, NarrativeMaintenanceCiConfig,
    MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
};
use grimodex_db::Database;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WakeReason {
    WorkspaceOpened,
    RestoreCompleted,
    SemanticEpochRotated,
}

impl WakeReason {
    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "workspace-opened" => Ok(Self::WorkspaceOpened),
            "restore-completed" => Ok(Self::RestoreCompleted),
            "semantic-epoch-rotated" => Ok(Self::SemanticEpochRotated),
            _ => anyhow::bail!(
                "NEX_MAINTENANCE_DISCOVERY_INVALID_REASON: '{value}' is not a supported wake reason"
            ),
        }
    }

    fn durable_reason(self) -> &'static str {
        match self {
            Self::WorkspaceOpened => "workspace-opened",
            Self::RestoreCompleted => "restore-completed",
            Self::SemanticEpochRotated => "semantic-epoch-rotated",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryWorkPage {
    pub(crate) work: Vec<MaintenanceWorkRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryResult {
    pub(crate) workspace_binding: MaintenanceWorkspaceBinding,
    pub(crate) pages: Vec<DiscoveryWorkPage>,
}

fn work_request(work: DesiredWork) -> MaintenanceWorkRequest {
    MaintenanceWorkRequest {
        project_id: work.project_id,
        run_kind: work.run_kind,
        work_key: work.work_key,
        semantic_epoch_id: work.semantic_epoch_id,
        reasons: work.reasons,
    }
}

/// Discover all bounded pages from the exact live Database authority.
///
/// Stable project-id ordering makes the result deterministic. Project ids are
/// read under one short connection guard, which is released before asking the
/// DB-aware durable planner about each project. The planner opens its own
/// short guard; keeping the enumeration guard alive here would deadlock on the
/// non-reentrant Database connection mutex. The `Database` itself remains the
/// one pinned authority for every planner call, and JavaScript receives the
/// complete result before any queue mutation occurs.
pub(crate) fn discover_all(
    db: &Database,
    binding: MaintenanceWorkspaceBinding,
    reason: WakeReason,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
) -> anyhow::Result<DiscoveryResult> {
    let project_ids = db.with_conn(|conn| {
        let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
        let mut project_ids = Vec::new();
        for row in statement.query_map([], |row| row.get::<_, String>(0))? {
            project_ids.push(row?);
        }
        Ok(project_ids)
    })?;

    let mut pages = Vec::new();
    let mut page_work = Vec::new();
    let effective_coordinates = effective_maintenance_coordinates(ci_config)?;
    for project_id in project_ids {
        let planned = discover_durable_maintenance_work_with_coordinates(
            db,
            &project_id,
            reason.durable_reason(),
            Some(&effective_coordinates),
        )?
        .into_iter()
        .map(work_request)
        .collect::<Vec<_>>();
        anyhow::ensure!(
            planned.len() <= MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
            "NEX_MAINTENANCE_DISCOVERY_PROJECT_TOO_LARGE: planner returned too much work for one project"
        );
        if !page_work.is_empty()
            && page_work.len() + planned.len() > MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE
        {
            pages.push(DiscoveryWorkPage { work: page_work });
            page_work = Vec::new();
        }
        page_work.extend(planned);
    }

    if !page_work.is_empty() {
        pages.push(DiscoveryWorkPage { work: page_work });
    }
    Ok(DiscoveryResult {
        workspace_binding: binding,
        pages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::narrative_extraction::maintenance_runtime::NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN;
    use grimodex_db::narrative_extraction::{
        run_dependency_verify_for_project, AutomaticRunKind, NarrativeMaintenanceCiTrigger,
    };
    use serde_json::json;

    #[test]
    fn wake_reason_is_closed_and_does_not_accept_renderer_phase_names() {
        assert_eq!(
            WakeReason::parse("workspace-opened").unwrap(),
            WakeReason::WorkspaceOpened
        );
        assert_eq!(
            WakeReason::parse("restore-completed").unwrap(),
            WakeReason::RestoreCompleted
        );
        assert_eq!(
            WakeReason::parse("semantic-epoch-rotated").unwrap(),
            WakeReason::SemanticEpochRotated
        );
        assert!(WakeReason::parse("workspace:restored").is_err());
        assert!(WakeReason::parse("repair").is_err());
    }

    #[test]
    fn work_request_conversion_preserves_only_planner_owned_fields() {
        let request = work_request(DesiredWork {
            project_id: "project-1".to_string(),
            run_kind: AutomaticRunKind::Verify,
            work_key: "dependency-verify:epoch-1".to_string(),
            semantic_epoch_id: Some("epoch-1".to_string()),
            reasons: vec!["restore-completed".to_string()],
        });
        let json = serde_json::to_value(request).expect("serialize discovery work");
        assert_eq!(json["projectId"], "project-1");
        assert_eq!(json["runKind"], "dependency-verify");
        assert!(json.get("graphContractDigest").is_none());
        assert!(json.get("ruleRegistryDigest").is_none());
        assert!(json.get("producerGenerationSetDigest").is_none());
    }

    #[test]
    fn native_discovery_uses_the_same_effective_coordinates_as_the_live_ci_cycle() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        let backfill_spec = json!({ "backfillAlgorithmVersion": "2" }).to_string();
        let backfill_outcome = json!({
            "maintenancePhase": "backfill-complete",
            "backfillAlgorithmVersion": "2",
            "semanticEpochId": "epoch-1",
            "summary": {
                "epoch_created": true,
                "contributions_created": 0,
                "edges_created": 0,
                "applications_without_run_id": 0
            }
        })
        .to_string();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'default-project', 0, 'initial',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, outcome_summary_json, created_at, completed_at,
                     run_kind, semantic_epoch_id, work_key)
                 VALUES ('backfill-complete', 'default-project', 'maintenance', ?1, ?1,
                         'sha256:backfill', 'completed', '{}', ?2,
                         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                         'backfill', 'epoch-1', 'legacy-dependency-backfill:v2')",
                [backfill_spec.as_str(), backfill_outcome.as_str()],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed completed backfill boundary");

        run_dependency_verify_for_project(&db, "default-project")
            .expect("baseline Verify must persist native skip evidence");
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority:test".to_string(),
            generation: 1,
        };
        let baseline = discover_all(&db, binding.clone(), WakeReason::WorkspaceOpened, None)
            .expect("baseline native discovery");
        assert!(
            baseline.pages.is_empty(),
            "baseline evidence should be reusable"
        );

        let changed_config = NarrativeMaintenanceCiConfig {
            is_packaged: false,
            ci: "true".to_string(),
            owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
            fault: None,
            trigger: Some(NarrativeMaintenanceCiTrigger::GraphContractDigestChanged),
            setup: None,
            product_journey_barrier_id: None,
            correlation: None,
        };
        let changed = discover_all(
            &db,
            binding,
            WakeReason::WorkspaceOpened,
            Some(&changed_config),
        )
        .expect("changed native discovery");
        let work = changed
            .pages
            .iter()
            .flat_map(|page| page.work.iter())
            .collect::<Vec<_>>();
        assert_eq!(work.len(), 1, "changed graph coordinate must reach Verify");
        assert_eq!(work[0].project_id, "default-project");
        assert_eq!(work[0].run_kind, AutomaticRunKind::Verify);
    }
}
