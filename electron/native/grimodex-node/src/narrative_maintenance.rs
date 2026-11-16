//! Main-process-only Narrative Maintenance discovery adapter.
//!
//! The planner and durable phase state live in `grimodex-db`. This module only
//! pins the already-active Database, enumerates the workspace's projects, and
//! converts the planner's desired work into the camelCase N-API page contract.
//! It never accepts a project id, path, phase, or digest from JavaScript.

use serde::Serialize;

use grimodex_db::narrative_extraction::{
    discover_before_cutover_maintenance_work_with_coordinates,
    discover_maintenance_project_for_main_with_product, effective_maintenance_coordinates,
    is_project_local_discovery_failure, DesiredWork, MaintenanceContractCoordinates,
    MaintenanceProjectDiscovery, MaintenanceWorkRequest, MaintenanceWorkspaceBinding,
    NarrativeMaintenanceCiConfig, Nir1GraphProductPublication, ValidationTerminated,
    ValidationTerminationReason, MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
};
use grimodex_db::Database;

const TRACE_TARGET: &str = "narrative.maintenance_discovery";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WakeReason {
    WorkspaceOpened,
    RestoreCompleted,
    SemanticEpochRotated,
    BeforeCutover,
}

impl WakeReason {
    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "workspace-opened" => Ok(Self::WorkspaceOpened),
            "restore-completed" => Ok(Self::RestoreCompleted),
            "semantic-epoch-rotated" => Ok(Self::SemanticEpochRotated),
            "before-cutover" => Ok(Self::BeforeCutover),
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
            Self::BeforeCutover => "before-cutover",
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
    /// B-ROUTE seam only (DR-BSEAM-1): projects main wakes so the controlled
    /// cycle judges the gated Graph Index build. Omitted from the wire when
    /// empty, so every product discovery response is unchanged.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) wake_project_ids: Vec<String>,
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

/// The wire code of a contained failure for the log (never project content).
fn contained_failure_code(error: &anyhow::Error) -> &'static str {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ValidationTerminated>())
        .map_or("project-local", |terminated| match terminated.reason {
            ValidationTerminationReason::ContextUnavailable => "context-unavailable",
            ValidationTerminationReason::CapacityExceeded => "capacity-exceeded",
            _ => "project-local",
        })
}

/// [`discover_all_with_product`] without the product publication token (the
/// seam-only form that the existing B-ROUTE and BSEAM tests use).
#[cfg(test)]
pub(crate) fn discover_all(
    db: &Database,
    binding: MaintenanceWorkspaceBinding,
    reason: WakeReason,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
) -> anyhow::Result<DiscoveryResult> {
    discover_all_with_product(db, binding, reason, ci_config, None)
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
///
/// Under the B-ROUTE seam or the product publication token (DR-PUBG-5-13) a
/// project can also be returned as a wake (`wake_project_ids`, DR-BSEAM-1):
/// main then starts an empty-work cycle for it, and that controlled cycle
/// judges the gated Graph Index build. Without either the list is always empty
/// and is omitted from the wire.
///
/// A project whose own discovery fails for a reason that its state alone
/// determines (`is_project_local_discovery_failure`) does not stop the
/// others: it is returned as "no work" and logged by code only. If no project
/// succeeded, the first such error is returned, so a workspace with one
/// project, or one whose every project fails, keeps the error. The
/// BeforeCutover flow never contains a failure (a dropped project would let a
/// cutover proceed), and every other error propagates unchanged.
///
/// Production passes `nir1_graph_product::maintenance_product_publication()`.
pub(crate) fn discover_all_with_product(
    db: &Database,
    binding: MaintenanceWorkspaceBinding,
    reason: WakeReason,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
    product: Option<Nir1GraphProductPublication>,
) -> anyhow::Result<DiscoveryResult> {
    discover_projects(
        db,
        binding,
        reason,
        ci_config,
        &mut |project_id, coordinates| {
            discover_maintenance_project_for_main_with_product(
                db,
                project_id,
                reason.durable_reason(),
                Some(coordinates),
                ci_config,
                product,
            )
        },
    )
}

fn discover_projects(
    db: &Database,
    binding: MaintenanceWorkspaceBinding,
    reason: WakeReason,
    ci_config: Option<&NarrativeMaintenanceCiConfig>,
    discover_project: &mut dyn FnMut(
        &str,
        &MaintenanceContractCoordinates,
    ) -> anyhow::Result<MaintenanceProjectDiscovery>,
) -> anyhow::Result<DiscoveryResult> {
    let project_ids = db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT projects.id
               FROM projects
              WHERE NOT EXISTS (
                    SELECT 1
                      FROM project_settings
                     WHERE project_settings.project_id = projects.id
                       AND project_settings.key = 'scan.import.state'
                       AND project_settings.value = 'staging'
              )
              ORDER BY projects.id ASC",
        )?;
        let mut project_ids = Vec::new();
        for row in statement.query_map([], |row| row.get::<_, String>(0))? {
            project_ids.push(row?);
        }
        Ok(project_ids)
    })?;

    let mut pages = Vec::new();
    let mut page_work = Vec::new();
    let mut wake_project_ids = Vec::new();
    let mut succeeded = 0usize;
    let mut first_contained: Option<anyhow::Error> = None;
    let effective_coordinates = effective_maintenance_coordinates(ci_config)?;
    for project_id in project_ids {
        let planned = match reason {
            WakeReason::BeforeCutover => {
                succeeded += 1;
                discover_before_cutover_maintenance_work_with_coordinates(
                    db,
                    &project_id,
                    Some(&effective_coordinates),
                )?
            }
            _ => match discover_project(&project_id, &effective_coordinates) {
                Ok(MaintenanceProjectDiscovery::Work(work)) => {
                    succeeded += 1;
                    Some(work)
                }
                Ok(MaintenanceProjectDiscovery::Idle) => {
                    succeeded += 1;
                    None
                }
                Ok(MaintenanceProjectDiscovery::GraphIndexBuildWake) => {
                    succeeded += 1;
                    wake_project_ids.push(project_id.clone());
                    None
                }
                Err(error) if is_project_local_discovery_failure(&error) => {
                    tracing::warn!(
                        target: TRACE_TARGET,
                        code = contained_failure_code(&error),
                        "NARRATIVE_MAINTENANCE_PROJECT_DISCOVERY_CONTAINED"
                    );
                    first_contained.get_or_insert(error);
                    None
                }
                Err(error) => return Err(error),
            },
        }
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
    if succeeded == 0 {
        if let Some(error) = first_contained {
            return Err(error);
        }
    }

    if !page_work.is_empty() {
        pages.push(DiscoveryWorkPage { work: page_work });
    }
    Ok(DiscoveryResult {
        workspace_binding: binding,
        pages,
        wake_project_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::narrative_extraction::maintenance_runtime::NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN;
    use grimodex_db::narrative_extraction::validation_terminated;
    use grimodex_db::narrative_extraction::{
        discover_durable_maintenance_work_with_coordinates, run_dependency_verify_for_project,
        run_incremental_freshness_cycle, run_system_work_cycle, AutomaticRunKind,
        IncrementalFreshnessCycleOutcome, MaintenanceCycleRequest, NarrativeMaintenanceCiTrigger,
        RecoveryMode,
    };
    use serde_json::json;

    fn before_cutover_test_database(seed_freshness_cursor: bool) -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        let backfill_spec = json!({ "backfillAlgorithmVersion": "3" }).to_string();
        let backfill_outcome = json!({
            "maintenancePhase": "backfill-complete",
            "backfillAlgorithmVersion": "3",
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
                         'backfill', 'epoch-1', 'legacy-dependency-backfill:v3')",
                [backfill_spec.as_str(), backfill_outcome.as_str()],
            )?;
            if seed_freshness_cursor {
                // An existing released cursor at the empty Feed head means
                // the idle checkpoint updates only bookkeeping. Omitting the
                // row intentionally exercises cursor creation as a semantic
                // Verify input in the companion regression below.
                conn.execute(
                    "INSERT INTO narrative_change_cursors
                        (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                     VALUES ('default-project', 'narrative-incremental-freshness/v1', 0,
                             '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed completed backfill boundary");
        db
    }

    fn test_binding() -> MaintenanceWorkspaceBinding {
        MaintenanceWorkspaceBinding {
            authority_id: "authority:test".to_string(),
            generation: 1,
        }
    }

    fn ci_seam(trigger: Option<NarrativeMaintenanceCiTrigger>) -> NarrativeMaintenanceCiConfig {
        NarrativeMaintenanceCiConfig {
            is_packaged: false,
            ci: "true".to_string(),
            owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
            fault: None,
            trigger,
            setup: None,
            freshness_hold_project_id: None,
            product_journey_barrier_id: None,
            correlation: None,
        }
    }

    /// A project whose durable Backfill -> Verify chain has nothing to do.
    fn idle_durable_chain_database() -> Database {
        let db = before_cutover_test_database(true);
        run_dependency_verify_for_project(&db, "default-project")
            .expect("baseline Verify must persist durable skip evidence");
        let product = discover_all(&db, test_binding(), WakeReason::WorkspaceOpened, None)
            .expect("product discovery");
        assert!(product.pages.is_empty(), "precondition: idle durable chain");
        db
    }

    /// DR-BSEAM-1 (P-0). Main starts a maintenance cycle only for what this
    /// discovery returns, and the gated Graph Index build (B) is judged only
    /// inside a cycle. With the B-ROUTE seam and an idle durable chain the
    /// discovery must therefore still ask main to wake the project, or B is
    /// never built (missing) or rebuilt (dirty) in that session.
    #[test]
    fn b_route_discovery_wakes_an_idle_project_so_the_cycle_judges_the_graph_index() {
        let db = idle_durable_chain_database();
        let seam = ci_seam(Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild));
        for reason in [
            WakeReason::WorkspaceOpened,
            WakeReason::RestoreCompleted,
            WakeReason::SemanticEpochRotated,
        ] {
            let discovered =
                discover_all(&db, test_binding(), reason, Some(&seam)).expect("B-ROUTE discovery");
            assert!(
                discovered.pages.is_empty(),
                "main never names the gated Graph build work"
            );
            let wire = serde_json::to_value(&discovered).expect("serialize discovery");
            assert_eq!(
                wire.get("wakeProjectIds"),
                Some(&json!(["default-project"])),
                "{reason:?}: {wire}"
            );
        }
    }

    /// Without the B-ROUTE seam the discovery wire stays byte-identical (no
    /// `wakeProjectIds` key) and an invalid seam is still refused before any
    /// planner call, so main starts no additional cycle.
    #[test]
    fn discovery_wire_is_unchanged_outside_the_b_route_seam() {
        let db = idle_durable_chain_database();
        let product = serde_json::to_string(
            &discover_all(&db, test_binding(), WakeReason::WorkspaceOpened, None)
                .expect("product discovery"),
        )
        .expect("serialize product discovery");
        assert_eq!(
            product,
            r#"{"workspaceBinding":{"authorityId":"authority:test","generation":1},"pages":[]}"#
        );
        let mut closed = vec![ci_seam(None)];
        for trigger in [
            NarrativeMaintenanceCiTrigger::DependencyGap,
            NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake,
        ] {
            closed.push(ci_seam(Some(trigger)));
        }
        // Coordinate triggers still reach Verify as ordinary work, never a wake.
        for trigger in [
            NarrativeMaintenanceCiTrigger::GraphContractDigestChanged,
            NarrativeMaintenanceCiTrigger::RuleRegistryDigestChanged,
            NarrativeMaintenanceCiTrigger::ProducerGenerationSetDigestChanged,
        ] {
            let discovered = discover_all(
                &db,
                test_binding(),
                WakeReason::WorkspaceOpened,
                Some(&ci_seam(Some(trigger))),
            )
            .expect("coordinate trigger discovery");
            assert!(!discovered.pages.is_empty(), "{trigger:?}");
            assert!(discovered.wake_project_ids.is_empty(), "{trigger:?}");
        }
        for config in &closed {
            let wire = serde_json::to_string(
                &discover_all(
                    &db,
                    test_binding(),
                    WakeReason::WorkspaceOpened,
                    Some(config),
                )
                .expect("seam discovery"),
            )
            .expect("serialize seam discovery");
            assert_eq!(wire, product, "{config:?}");
        }

        let mut packaged = ci_seam(Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild));
        packaged.is_packaged = true;
        let mut not_ci = ci_seam(Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild));
        not_ci.ci = "false".to_string();
        let mut forged_owner = ci_seam(Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild));
        forged_owner.owner_token = "forged-owner".to_string();
        for config in [&packaged, &not_ci, &forged_owner] {
            assert!(
                discover_all(
                    &db,
                    test_binding(),
                    WakeReason::WorkspaceOpened,
                    Some(config)
                )
                .is_err(),
                "{config:?}"
            );
        }

        // The C2-ZC BeforeCutover flow is never a B-ROUTE wake.
        let seam = ci_seam(Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild));
        let before_cutover =
            discover_all(&db, test_binding(), WakeReason::BeforeCutover, Some(&seam))
                .expect("before-cutover discovery");
        assert!(before_cutover.wake_project_ids.is_empty());
        assert!(serde_json::to_value(&before_cutover)
            .expect("serialize")
            .get("wakeProjectIds")
            .is_none());
    }

    /// A project with durable work keeps its ordinary work item under the
    /// B-ROUTE seam; the cycle that runs it judges B after the durable chain.
    #[test]
    fn b_route_discovery_keeps_durable_work_as_work_not_as_a_wake() {
        let db = before_cutover_test_database(true);
        let seam = ci_seam(Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild));
        let product = discover_all(&db, test_binding(), WakeReason::WorkspaceOpened, None)
            .expect("product discovery");
        let discovered = discover_all(
            &db,
            test_binding(),
            WakeReason::WorkspaceOpened,
            Some(&seam),
        )
        .expect("B-ROUTE discovery");
        assert!(!product.pages.is_empty(), "precondition: durable work");
        assert_eq!(
            serde_json::to_value(&discovered).expect("serialize"),
            serde_json::to_value(&product).expect("serialize")
        );
    }

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
        assert_eq!(
            WakeReason::parse("before-cutover").unwrap(),
            WakeReason::BeforeCutover
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
    fn native_discovery_excludes_hidden_scan_staging_projects() {
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

        let discovered = discover_all(
            &db,
            MaintenanceWorkspaceBinding {
                authority_id: "authority:test".to_string(),
                generation: 1,
            },
            WakeReason::WorkspaceOpened,
            None,
        )
        .expect("discover workspace maintenance");
        assert!(discovered
            .pages
            .iter()
            .flat_map(|page| page.work.iter())
            .all(|work| work.project_id != "scan-staging-project"));
    }

    #[test]
    fn native_discovery_uses_the_same_effective_coordinates_as_the_live_ci_cycle() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        let backfill_spec = json!({ "backfillAlgorithmVersion": "3" }).to_string();
        let backfill_outcome = json!({
            "maintenancePhase": "backfill-complete",
            "backfillAlgorithmVersion": "3",
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
                         'backfill', 'epoch-1', 'legacy-dependency-backfill:v3')",
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
            freshness_hold_project_id: None,
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

    #[test]
    fn before_cutover_discovery_starts_with_verify_after_a_reusable_verify() {
        let db = before_cutover_test_database(true);

        run_dependency_verify_for_project(&db, "default-project")
            .expect("baseline Verify must persist durable evidence");

        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority:test".to_string(),
            generation: 1,
        };
        let discovered = discover_all(&db, binding, WakeReason::BeforeCutover, None)
            .expect("discover before-cutover preparation");
        let work = discovered
            .pages
            .into_iter()
            .flat_map(|page| page.work)
            .next()
            .expect("Verify work must be dispatchable");
        assert_eq!(work.run_kind, AutomaticRunKind::Verify);
        assert_eq!(work.semantic_epoch_id.as_deref(), Some("epoch-1"));

        let followup = discover_durable_maintenance_work_with_coordinates(
            &db,
            "default-project",
            "before-cutover-follow-up",
            None,
        )
        .expect("discover durable BeforeCutover follow-up")
        .expect("completed Verify must hand off to Rebuild");
        assert_eq!(followup.run_kind, AutomaticRunKind::RebuildDerived);
        assert_eq!(followup.semantic_epoch_id.as_deref(), Some("epoch-1"));

        let request = MaintenanceCycleRequest {
            work: vec![work],
            wake_project_ids: Vec::new(),
            delivery_sequence: None,
            delivery_fingerprint: None,
            workspace_binding: None,
        };
        let cycle = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
            .expect("BeforeCutover Verify/Rebuild chain");
        assert!(
            !cycle.has_more,
            "the bounded preparation chain should drain"
        );
        let phases: Vec<(String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT run_kind, status
                       FROM narrative_extraction_runs
                      WHERE project_id = 'default-project'
                        AND run_kind IN ('dependency-verify', 'semantic-index-rebuild')
                      ORDER BY created_at ASC, rowid ASC",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<std::result::Result<Vec<(String, String)>, _>>()?;
                Ok::<_, anyhow::Error>(rows)
            })
            .expect("read preparation phase ledger");
        assert!(phases.len() >= 4);
        assert_eq!(
            &phases[phases.len() - 3..],
            &[
                ("dependency-verify".to_string(), "completed".to_string()),
                (
                    "semantic-index-rebuild".to_string(),
                    "completed".to_string()
                ),
                ("dependency-verify".to_string(), "completed".to_string()),
            ]
        );
        let repeated = discover_all(
            &db,
            MaintenanceWorkspaceBinding {
                authority_id: "authority:test".to_string(),
                generation: 1,
            },
            WakeReason::BeforeCutover,
            None,
        )
        .expect("repeat BeforeCutover discovery");
        assert!(
            repeated.pages.is_empty(),
            "a completed current-Epoch chain must be idempotent"
        );

        // Renderer layout persistence uses the legacy change log but is not a
        // canonical Narrative Feed transaction.  It is therefore outside the
        // Verify cursor/feed read closure and must not invalidate sealed
        // Verify evidence when it arrives after the chain completed.
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, scene_id, domain, op_type,
                     entity_type, entity_id, payload, session_id, sequence,
                     timestamp, prev_hash, hash)
                 VALUES ('c2-zc-layout-snapshot-after-chain', 'default-project',
                         NULL, 'layout', 'layout.snapshot', 'workspace',
                         'default-project', '{}', 'c2-zc-test', 1,
                         1787893741387, 'layout-prev', 'layout-after-chain')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("insert unrelated legacy layout event");

        // The main freshness scheduler emits a zero-width checkpoint once
        // the current Epoch is at the Feed head.  That checkpoint updates
        // only cursor bookkeeping; it must not make the already confirmed
        // BeforeCutover Verify evidence look stale and mint another Verify
        // on the next readiness wake.
        let idle = run_incremental_freshness_cycle(&db)
            .expect("current-Epoch idle checkpoint should complete");
        assert!(matches!(
            idle,
            IncrementalFreshnessCycleOutcome::Processed(summary)
                if summary.from_sequence_exclusive == summary.through_sequence_inclusive
                    && !summary.has_more
        ));
        let repeated_after_idle = discover_all(
            &db,
            MaintenanceWorkspaceBinding {
                authority_id: "authority:test".to_string(),
                generation: 1,
            },
            WakeReason::BeforeCutover,
            None,
        )
        .expect("repeat BeforeCutover discovery after idle checkpoint");
        assert!(
            repeated_after_idle.pages.is_empty(),
            "idle cursor bookkeeping must not invalidate completed current-Epoch Verify evidence"
        );
    }

    #[test]
    fn idle_cursor_creation_remains_a_verify_input_without_a_preexisting_cursor() {
        let db = before_cutover_test_database(false);
        run_dependency_verify_for_project(&db, "default-project")
            .expect("baseline Verify must persist durable skip evidence");

        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority:test".to_string(),
            generation: 1,
        };
        let baseline = discover_all(&db, binding.clone(), WakeReason::WorkspaceOpened, None)
            .expect("discover baseline before idle checkpoint");
        assert!(
            baseline.pages.is_empty(),
            "pre-idle Verify evidence should be reusable even without a cursor row"
        );

        let idle = run_incremental_freshness_cycle(&db)
            .expect("missing empty-feed cursor should be created by idle checkpoint");
        assert!(matches!(
            idle,
            IncrementalFreshnessCycleOutcome::Processed(summary)
                if summary.from_sequence_exclusive == summary.through_sequence_inclusive
                    && !summary.has_more
        ));

        let after_idle = discover_all(&db, binding, WakeReason::WorkspaceOpened, None)
            .expect("discover after semantic cursor creation");
        let work = after_idle
            .pages
            .iter()
            .flat_map(|page| page.work.iter())
            .collect::<Vec<_>>();
        assert_eq!(
            work.len(),
            1,
            "creating the previously absent cursor must invalidate old Verify evidence"
        );
        assert_eq!(work[0].run_kind, AutomaticRunKind::Verify);
        assert_eq!(work[0].semantic_epoch_id.as_deref(), Some("epoch-1"));
    }

    // -----------------------------------------------------------------------
    // DR-PUBG-5-13 (PR-1): the product gate and the containment of one
    // project's failure.
    // -----------------------------------------------------------------------

    fn projects_database(ids: &[&str]) -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            for id in ids {
                conn.execute("INSERT INTO projects(id, title) VALUES (?1, 'p')", [id])?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed projects");
        db
    }

    fn verify_work(project_id: &str) -> DesiredWork {
        DesiredWork {
            project_id: project_id.to_string(),
            run_kind: AutomaticRunKind::Verify,
            work_key: "dependency-verify:epoch-1".to_string(),
            semantic_epoch_id: Some("epoch-1".to_string()),
            reasons: vec!["workspace-opened".to_string()],
        }
    }

    fn work_projects(discovered: &DiscoveryResult) -> Vec<&str> {
        discovered
            .pages
            .iter()
            .flat_map(|page| page.work.iter())
            .map(|work| work.project_id.as_str())
            .collect()
    }

    /// Discover with a per-project answer injected in place of the planner.
    fn discover_with(
        db: &Database,
        reason: WakeReason,
        answer: &mut dyn FnMut(&str) -> anyhow::Result<MaintenanceProjectDiscovery>,
    ) -> anyhow::Result<DiscoveryResult> {
        discover_projects(db, test_binding(), reason, None, &mut |project, _| {
            answer(project)
        })
    }

    /// A project whose own state fails its discovery (a bound its project
    /// exceeded, or an uncontrolled read of its sealed binding) is "no work"
    /// for that project; the others are still discovered.
    #[test]
    fn a_project_local_failure_does_not_stop_the_other_projects_discovery() {
        let db = projects_database(&["a-project", "b-project", "c-project", "d-project"]);
        for reason in [
            WakeReason::WorkspaceOpened,
            WakeReason::RestoreCompleted,
            WakeReason::SemanticEpochRotated,
        ] {
            let discovered = discover_with(&db, reason, &mut |project| match project {
                "b-project" => Err(validation_terminated(
                    ValidationTerminationReason::CapacityExceeded,
                    "NIR1_GRAPH_CAPACITY_EXCEEDED: stored-edge-rows exceeds 8193",
                )),
                "c-project" => Err(validation_terminated(
                    ValidationTerminationReason::ContextUnavailable,
                    "Entity/Relation eligibility requires a caller-owned validation context",
                )
                .context("discovery")),
                // A migrated database already has its default project.
                "default-project" => Ok(MaintenanceProjectDiscovery::Idle),
                other => Ok(MaintenanceProjectDiscovery::Work(verify_work(other))),
            })
            .unwrap_or_else(|error| panic!("{reason:?}: {error:#}"));
            assert_eq!(
                work_projects(&discovered),
                ["a-project", "d-project"],
                "{reason:?}"
            );
            // The wire gains nothing: no key for a contained project.
            assert_eq!(
                serde_json::to_string(&discovered).expect("serialize"),
                serde_json::to_string(&DiscoveryResult {
                    workspace_binding: test_binding(),
                    pages: vec![DiscoveryWorkPage {
                        work: vec![
                            work_request(verify_work("a-project")),
                            work_request(verify_work("d-project")),
                        ],
                    }],
                    wake_project_ids: Vec::new(),
                })
                .expect("serialize"),
                "{reason:?}"
            );
        }
    }

    /// With no project succeeding, the error is kept (a workspace with one
    /// project, or a systemic failure, is not turned into "nothing to do").
    #[test]
    fn the_error_is_kept_when_no_project_succeeded() {
        for ids in [&["only-project"][..], &["a-project", "b-project"][..]] {
            let db = projects_database(ids);
            let error = discover_with(&db, WakeReason::WorkspaceOpened, &mut |_| {
                Err(validation_terminated(
                    ValidationTerminationReason::CapacityExceeded,
                    "NIR1_GRAPH_CAPACITY_EXCEEDED: candidate-rows exceeds 2064",
                ))
            })
            .expect_err("no project succeeded");
            assert!(is_project_local_discovery_failure(&error), "{error:#}");
        }
        // An idle project counts as a success.
        let db = projects_database(&["a-project", "b-project"]);
        let discovered = discover_with(&db, WakeReason::WorkspaceOpened, &mut |project| {
            if project == "a-project" {
                Ok(MaintenanceProjectDiscovery::Idle)
            } else {
                Err(validation_terminated(
                    ValidationTerminationReason::ContextUnavailable,
                    "test",
                ))
            }
        })
        .expect("a successful idle project keeps the others");
        assert!(discovered.pages.is_empty());
    }

    /// Only the two typed project-local failures are contained. Timing,
    /// lifecycle, retryable and unknown failures still fail the discovery, so
    /// main retries and reports them.
    #[test]
    fn every_other_failure_still_fails_the_whole_discovery() {
        let db = projects_database(&["a-project", "b-project"]);
        let others: Vec<anyhow::Error> = vec![
            validation_terminated(ValidationTerminationReason::Cancelled, "test"),
            validation_terminated(ValidationTerminationReason::TimedOut, "test"),
            validation_terminated(ValidationTerminationReason::Closed, "test"),
            validation_terminated(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                "test",
            ),
            validation_terminated(ValidationTerminationReason::ForegroundPreempted, "test"),
            validation_terminated(ValidationTerminationReason::CleanupFailed, "test"),
            anyhow::anyhow!(
                "NEX_MAINTENANCE_CONNECTION_PREEMPTED: discovery could not acquire the connection"
            ),
            anyhow::anyhow!("NEX_MAINTENANCE_SQLITE_LOCKED: database is locked"),
            anyhow::anyhow!("no such table: narrative_extraction_runs"),
        ];
        for other in others {
            let text = format!("{other:#}");
            let mut failing = Some(other);
            let result = discover_with(&db, WakeReason::WorkspaceOpened, &mut |project| {
                if project == "b-project" {
                    Err(failing.take().expect("b-project is asked once"))
                } else {
                    Ok(MaintenanceProjectDiscovery::Work(verify_work(project)))
                }
            });
            let error = result.expect_err(&text);
            assert_eq!(format!("{error:#}"), text);
        }
    }

    /// The BeforeCutover flow never asks the injected per-project planner and
    /// so never contains a failure: a dropped project would let a cutover go
    /// ahead without that project's maintenance.
    #[test]
    fn before_cutover_discovery_does_not_use_the_contained_path() {
        let db = before_cutover_test_database(true);
        let mut asked = 0usize;
        let discovered = discover_with(&db, WakeReason::BeforeCutover, &mut |_| {
            asked += 1;
            Ok(MaintenanceProjectDiscovery::Idle)
        })
        .expect("before-cutover discovery");
        assert_eq!(asked, 0);
        assert!(discovered.wake_project_ids.is_empty());
    }

    /// Under the product token an idle project is woken for the Graph build
    /// (W1), except in the BeforeCutover flow; with no token nothing changes.
    #[test]
    fn product_gate_discovery_wakes_an_idle_project_like_the_seam() {
        let db = idle_durable_chain_database();
        let token = Nir1GraphProductPublication::from_const::<true>();
        for reason in [
            WakeReason::WorkspaceOpened,
            WakeReason::RestoreCompleted,
            WakeReason::SemanticEpochRotated,
        ] {
            let discovered = discover_all_with_product(&db, test_binding(), reason, None, token)
                .expect("product-gate discovery");
            assert!(discovered.pages.is_empty(), "{reason:?}");
            let wire = serde_json::to_value(&discovered).expect("serialize discovery");
            assert_eq!(
                wire.get("wakeProjectIds"),
                Some(&json!(["default-project"])),
                "{reason:?}: {wire}"
            );
            let closed = serde_json::to_string(
                &discover_all_with_product(&db, test_binding(), reason, None, None)
                    .expect("closed discovery"),
            )
            .expect("serialize closed discovery");
            assert_eq!(
                closed,
                r#"{"workspaceBinding":{"authorityId":"authority:test","generation":1},"pages":[]}"#,
                "{reason:?}"
            );
        }
        let before_cutover =
            discover_all_with_product(&db, test_binding(), WakeReason::BeforeCutover, None, token)
                .expect("before-cutover discovery");
        assert!(before_cutover.wake_project_ids.is_empty());
    }
}
