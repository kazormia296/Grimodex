//! Main-process-only Narrative Maintenance discovery adapter.
//!
//! The planner and durable phase state live in `grimodex-db`. This module only
//! pins the already-active Database, enumerates the workspace's projects, and
//! converts the planner's desired work into the camelCase N-API page contract.
//! It never accepts a project id, path, phase, or digest from JavaScript.

use serde::Serialize;

use grimodex_db::narrative_extraction::{
    get_current_epoch, plan_maintenance_trigger, DesiredWork, MaintenanceTrigger,
    MaintenanceWorkRequest, MaintenanceWorkspaceBinding, MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
};
use grimodex_db::Database;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WakeReason {
    WorkspaceOpened,
    RestoreCompleted,
}

impl WakeReason {
    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "workspace-opened" => Ok(Self::WorkspaceOpened),
            "restore-completed" => Ok(Self::RestoreCompleted),
            _ => anyhow::bail!(
                "NEX_MAINTENANCE_DISCOVERY_INVALID_REASON: '{value}' is not a supported wake reason"
            ),
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
/// Stable project-id ordering makes the result deterministic. All pages are
/// produced while one pinned Database authority is held; JavaScript receives
/// the complete result before any queue mutation occurs.
pub(crate) fn discover_all(
    db: &Database,
    binding: MaintenanceWorkspaceBinding,
    reason: WakeReason,
) -> anyhow::Result<DiscoveryResult> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
        let mut project_ids = Vec::new();
        for row in statement.query_map([], |row| row.get::<_, String>(0))? {
            project_ids.push(row?);
        }

        let mut pages = Vec::new();
        let mut page_work = Vec::new();
        for project_id in project_ids {
            let trigger = match reason {
                WakeReason::WorkspaceOpened => MaintenanceTrigger::WorkspaceOpened { project_id },
                WakeReason::RestoreCompleted => match get_current_epoch(conn, &project_id)? {
                    Some(epoch) => MaintenanceTrigger::RestoreCompleted {
                        project_id,
                        semantic_epoch_id: epoch.id,
                    },
                    None => MaintenanceTrigger::LegacyBackfillRequired { project_id },
                },
            };
            let planned = plan_maintenance_trigger(&trigger)?;
            if !page_work.is_empty()
                && page_work.len() + planned.len() > MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE
            {
                pages.push(DiscoveryWorkPage { work: page_work });
                page_work = Vec::new();
            }
            anyhow::ensure!(
                planned.len() <= MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
                "NEX_MAINTENANCE_DISCOVERY_PROJECT_TOO_LARGE: planner returned too much work for one project"
            );
            page_work.extend(planned.into_iter().map(work_request));
        }

        if !page_work.is_empty() {
            pages.push(DiscoveryWorkPage { work: page_work });
        }
        Ok(DiscoveryResult {
            workspace_binding: binding,
            pages,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::narrative_extraction::AutomaticRunKind;

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
}
