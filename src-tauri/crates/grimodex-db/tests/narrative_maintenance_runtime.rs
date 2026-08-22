//! C2-5B durable maintenance planning, recovery, and dispatch contract tests.
//!
//! These tests deliberately exercise only the typed planner and the existing
//! Run ledger.  They must not create Tasks/Attempts or invoke Verify/Rebuild
//! side effects.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    canonical_work_key, canonical_work_key_for_epoch, classify_failure, decide_execution,
    decide_run_recovery, decide_run_recovery_for_epoch, discover_durable_maintenance_work,
    plan_maintenance_trigger, terminalize_interrupted_runs, terminalize_interrupted_runs_for_epoch,
    terminalize_stale_interrupted_runs, AutomaticRunKind, FailureClass,
    MaintenanceExecutionDecision, MaintenanceExecutionMode, MaintenanceTrigger, RecoveryAction,
    RecoveryMode, StaleActiveRun, WorkKey, MAX_AUTOMATIC_RETRIES,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "project-c2-5a";
const EPOCH_ID: &str = "epoch-c2-5a";
const OLD_EPOCH_ID: &str = "epoch-c2-5a-old";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5A Project')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', datetime('now'))",
            params![EPOCH_ID, PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 1, 'migration', datetime('now'))",
            params![OLD_EPOCH_ID, PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed fixture");
    db
}

#[test]
fn canonical_key_namespaces_project_kind_and_work_key() {
    let key = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        "legacy-dependency-backfill:v2",
    )
    .expect("valid work key");

    assert_eq!(
        canonical_work_key(
            PROJECT_ID,
            AutomaticRunKind::Backfill,
            "legacy-dependency-backfill:v2"
        )
        .expect("canonical key"),
        key.canonical_key()
    );
    assert_ne!(
        key.canonical_key(),
        WorkKey::new(
            PROJECT_ID,
            AutomaticRunKind::Verify,
            "legacy-dependency-backfill:v2",
        )
        .expect("valid verify key")
        .canonical_key()
    );
}

#[test]
fn planner_maps_safe_open_to_backfill_and_verify_owned_followup() {
    let backfill = plan_maintenance_trigger(&MaintenanceTrigger::WorkspaceOpened {
        project_id: PROJECT_ID.to_string(),
    })
    .expect("backfill plan");
    assert_eq!(backfill.len(), 1);
    assert_eq!(backfill[0].run_kind, AutomaticRunKind::Backfill);
    assert_eq!(backfill[0].work_key, "legacy-dependency-backfill:v2");

    let cutover = plan_maintenance_trigger(&MaintenanceTrigger::BeforeCutover {
        project_id: PROJECT_ID.to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
    })
    .expect("cutover plan");
    assert_eq!(cutover.len(), 1);
    assert_eq!(cutover[0].run_kind, AutomaticRunKind::Verify);
    assert_eq!(cutover[0].semantic_epoch_id.as_deref(), Some(EPOCH_ID));

    assert_eq!(
        decide_execution(&backfill[0], MaintenanceExecutionMode::Shadow),
        MaintenanceExecutionDecision::PlanOnly
    );
    assert_eq!(
        decide_execution(&backfill[0], MaintenanceExecutionMode::ExecuteSafe),
        MaintenanceExecutionDecision::ExecuteBackfill
    );
    assert_eq!(
        decide_execution(&cutover[0], MaintenanceExecutionMode::ExecuteSafe),
        MaintenanceExecutionDecision::ExecuteVerify
    );

    let next_epoch = plan_maintenance_trigger(&MaintenanceTrigger::EpochRotated {
        project_id: PROJECT_ID.to_string(),
        semantic_epoch_id: "epoch-c2-5a-next".to_string(),
    })
    .expect("next epoch plan");
    let coalesced = grimodex_db::narrative_extraction::maintenance_runtime::coalesce_desired_work(
        cutover.into_iter().chain(next_epoch),
    );
    assert_eq!(coalesced.len(), 2);
}

#[test]
fn canonical_key_rejects_path_separators_in_every_component() {
    assert!(canonical_work_key("project/ambiguous", AutomaticRunKind::Backfill, "work").is_err());
    assert!(canonical_work_key(PROJECT_ID, AutomaticRunKind::Backfill, "work/ambiguous").is_err());
    assert!(WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "work\\ambiguous").is_err());
    assert_ne!(
        canonical_work_key_for_epoch(
            PROJECT_ID,
            AutomaticRunKind::RebuildDerived,
            "same",
            Some("epoch-a")
        )
        .expect("epoch-a key"),
        canonical_work_key_for_epoch(
            PROJECT_ID,
            AutomaticRunKind::RebuildDerived,
            "same",
            Some("epoch-b")
        )
        .expect("epoch-b key")
    );
}

#[test]
fn transient_failures_retry_with_a_hard_bound_and_contract_failures_stop() {
    let transient = classify_failure("SQLITE_BUSY: database is locked");
    assert_eq!(transient.class, FailureClass::Transient);
    assert!(transient.retryable);

    let contract = classify_failure("NEX_VERIFY_NO_EPOCH: no Semantic Epoch");
    assert_eq!(contract.class, FailureClass::Contract);
    assert!(!contract.retryable);

    let unknown = classify_failure("unexpected maintenance failure");
    assert_eq!(unknown.class, FailureClass::Contract);
    assert!(!unknown.retryable);

    assert_eq!(MAX_AUTOMATIC_RETRIES, 3);
}

#[test]
fn recovery_counts_existing_runs_without_creating_task_or_attempt_rows() {
    let db = fixture_db();
    let work = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        "legacy-dependency-backfill:v2",
    )
    .expect("valid work key");

    db.with_conn(|conn| {
        for (id, status) in [
            ("run-running", "running"),
            ("run-failed-1", "failed"),
            ("run-failed-2", "failed"),
        ] {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, run_kind, work_key)
                 VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest', ?3, '{}',
                         datetime('now'), ?4, ?5)",
                params![
                    id,
                    PROJECT_ID,
                    status,
                    work.run_kind.as_str(),
                    work.work_key
                ],
            )?;
        }
        Ok(())
    })
    .expect("seed run ledger");

    let decision =
        decide_run_recovery(&db, &work, Some("SQLITE_BUSY: locked")).expect("recovery decision");
    assert_eq!(decision.running_runs, 1);
    assert_eq!(decision.failed_runs, 2);
    assert!(matches!(
        decision.action,
        RecoveryAction::CoalescedRunning { .. }
    ));

    let task_attempt_counts = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_tasks",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_attempts",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
            ))
        })
        .expect("count tasks/attempts");
    assert_eq!(task_attempt_counts, (0, 0));
}

#[test]
fn recovery_after_failed_runs_is_bounded() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "backfill:v2")
        .expect("valid work key");
    db.with_conn(|conn| {
        for index in 0..MAX_AUTOMATIC_RETRIES {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, run_kind, work_key)
                 VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest', 'failed', '{}',
                         datetime('now'), ?3, ?4)",
                params![
                    format!("failed-{index}"),
                    PROJECT_ID,
                    work.run_kind.as_str(),
                    work.work_key
                ],
            )?;
        }
        Ok(())
    })
    .expect("seed failed runs");

    let decision =
        decide_run_recovery(&db, &work, Some("database is locked")).expect("recovery decision");
    assert!(matches!(
        decision.action,
        RecoveryAction::ManualIntervention { .. }
    ));
}

fn insert_run(
    conn: &rusqlite::Connection,
    id: &str,
    status: &str,
    epoch_id: Option<&str>,
    work: &WorkKey,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest', ?3, '{}',
                 datetime('now'), ?4, ?5, ?6)",
        params![
            id,
            work.project_id,
            status,
            work.run_kind.as_str(),
            epoch_id,
            work.work_key
        ],
    )?;
    Ok(())
}

#[test]
fn live_coalescing_and_startup_recovery_are_distinct_typed_actions() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Verify, "verify:current")
        .expect("valid work key");
    db.with_conn(|conn| {
        Ok(insert_run(
            conn,
            "run-current",
            "running",
            Some(EPOCH_ID),
            &work,
        )?)
    })
    .expect("seed current run");

    let live = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        None,
    )
    .expect("live decision");
    assert_eq!(live.mode, RecoveryMode::SameProcessLive);
    assert!(matches!(
        live.action,
        RecoveryAction::CoalescedRunning { ref run_ids, .. }
            if run_ids == &["run-current".to_string()]
    ));

    let startup = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::StartupRecovery,
        None,
    )
    .expect("startup decision");
    assert_eq!(startup.mode, RecoveryMode::StartupRecovery);
    assert!(matches!(
        startup.action,
        RecoveryAction::RecoverInterrupted { ref run_ids }
            if run_ids == &["run-current".to_string()]
    ));
}

#[test]
fn old_epoch_running_and_completed_rows_are_not_reused_for_current_epoch() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "backfill:current")
        .expect("valid work key");
    db.with_conn(|conn| {
        insert_run(
            conn,
            "run-old-running",
            "running",
            Some(OLD_EPOCH_ID),
            &work,
        )?;
        insert_run(
            conn,
            "run-old-completed",
            "completed",
            Some(OLD_EPOCH_ID),
            &work,
        )?;
        Ok(())
    })
    .expect("seed old epoch runs");

    let decision = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        None,
    )
    .expect("epoch-scoped decision");
    assert_eq!(decision.running_runs, 0);
    assert_eq!(decision.completed_runs, 0);
    let RecoveryAction::RecoverStaleEpoch { ref runs } = decision.action else {
        panic!("expected typed stale epoch recovery action");
    };
    assert_eq!(
        runs,
        &[StaleActiveRun {
            run_id: "run-old-running".to_string(),
            semantic_epoch_id: Some(OLD_EPOCH_ID.to_string()),
        }]
    );

    let terminalized = terminalize_stale_interrupted_runs(
        &db,
        PROJECT_ID,
        &WorkKey::new_for_epoch(
            PROJECT_ID,
            AutomaticRunKind::Backfill,
            "backfill:current",
            EPOCH_ID,
        )
        .expect("epoch-bound current work key"),
        runs,
    )
    .expect("stale run can be terminalized with its provenance");
    assert_eq!(
        terminalized.failed_run_ids,
        vec!["run-old-running".to_string()]
    );

    db.with_conn(|conn| {
        insert_run(
            conn,
            "run-old-running-forged",
            "running",
            Some(OLD_EPOCH_ID),
            &work,
        )?;
        Ok(())
    })
    .expect("seed forged-provenance target");
    let forged = terminalize_stale_interrupted_runs(
        &db,
        PROJECT_ID,
        &WorkKey::new_for_epoch(
            PROJECT_ID,
            AutomaticRunKind::Backfill,
            "backfill:current",
            EPOCH_ID,
        )
        .expect("epoch-bound current work key"),
        &[StaleActiveRun {
            run_id: "run-old-running-forged".to_string(),
            semantic_epoch_id: Some("epoch-forged".to_string()),
        }],
    )
    .expect_err("forged stale epoch provenance must fail closed");
    assert!(forged
        .to_string()
        .contains("does not match recovery provenance"));
}

#[test]
fn failures_before_a_completed_run_do_not_exhaust_the_next_cycle() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "backfill:reset")
        .expect("valid work key");
    db.with_conn(|conn| {
        for index in 0..MAX_AUTOMATIC_RETRIES {
            insert_run(
                conn,
                &format!("run-before-{index}"),
                "failed",
                Some(EPOCH_ID),
                &work,
            )?;
        }
        insert_run(conn, "run-completed", "completed", Some(EPOCH_ID), &work)?;
        insert_run(conn, "run-after", "failed", Some(EPOCH_ID), &work)?;
        Ok(())
    })
    .expect("seed completed cycle");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET created_at = CASE id
                    WHEN 'run-before-0' THEN '2026-08-23T08:00:00.000Z'
                    WHEN 'run-before-1' THEN '2026-08-23T08:01:00.000Z'
                    WHEN 'run-before-2' THEN '2026-08-23T08:02:00.000Z'
                    WHEN 'run-completed' THEN '2026-08-23T09:00:00.000Z'
                    WHEN 'run-after' THEN '2026-08-23T10:00:00.000Z'
                    ELSE created_at END
              WHERE project_id = ?1 AND work_key = ?2",
            params![PROJECT_ID, work.work_key],
        )?;
        Ok(())
    })
    .expect("make the intended lifecycle ordering explicit");

    let decision = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        Some("database is locked"),
    )
    .expect("next-cycle decision");
    assert_eq!(decision.failed_runs, 1);
    assert!(matches!(
        decision.action,
        RecoveryAction::Retry { attempt: 2, .. }
    ));
}

#[test]
fn recovery_uses_lifecycle_instants_not_rowid_after_successful_retry() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Verify, "verify:chronology")
        .expect("valid verify work key");
    db.with_conn(|conn| {
        // Insert the successful retry first, then import an older failed row.
        // A rowid-based ledger would mistake the latter for the current
        // failure and either demand missing failure detail or consume retry
        // budget again.
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind,
                 semantic_epoch_id, work_key)
             VALUES ('verify-success', ?1, 'maintenance', '{}', '{}', 'digest',
                     'completed', '{}', '2026-08-23T10:00:00.000Z',
                     '2026-08-23T10:01:00.000Z', ?2, ?3, ?4)",
            params![PROJECT_ID, work.run_kind.as_str(), EPOCH_ID, work.work_key],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind,
                 semantic_epoch_id, work_key)
             VALUES ('verify-old-failure', ?1, 'maintenance', '{}', '{}', 'digest',
                     'failed', '{}', '2026-08-23T09:00:00.000Z',
                     '2026-08-23T09:01:00.000Z', ?2, ?3, ?4)",
            params![PROJECT_ID, work.run_kind.as_str(), EPOCH_ID, work.work_key],
        )?;
        Ok(())
    })
    .expect("seed reverse rowid/lifecycle chronology");

    let decision = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        None,
    )
    .expect("successful retry must reset the current failure cycle");
    assert_eq!(decision.failed_runs, 0);
    assert!(matches!(decision.action, RecoveryAction::StartFresh));
}

#[test]
fn discovery_rejects_same_lifecycle_instant_instead_of_using_uuid_order() {
    let db = fixture_db();
    db.with_conn(|conn| {
        for id in ["verify-random-id-a", "verify-random-id-b"] {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, started_at, completed_at,
                     run_kind, semantic_epoch_id, work_key)
                 VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest', 'completed', '{}',
                         '2026-08-23T11:00:00.000Z', '2026-08-23T11:00:00.000Z',
                         '2026-08-23T11:00:00.000Z', 'dependency-verify', ?3, ?4)",
                params![id, PROJECT_ID, EPOCH_ID, "dependency-verify:epoch-c2-5a"],
            )?;
        }
        Ok(())
    })
    .expect("seed same-instant imported Runs");

    let error = discover_durable_maintenance_work(&db, PROJECT_ID, "restore-completed")
        .expect_err("same lifecycle instant must not be ordered by UUID");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS"));
}

#[test]
fn missing_failure_detail_fails_closed_to_manual_intervention() {
    let db = fixture_db();
    let work = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::Verify,
        "verify:missing-detail",
    )
    .expect("valid work key");
    db.with_conn(|conn| {
        Ok(insert_run(
            conn,
            "run-failed",
            "failed",
            Some(EPOCH_ID),
            &work,
        )?)
    })
    .expect("seed failed run");

    let decision = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::StartupRecovery,
        None,
    )
    .expect("missing detail decision");
    assert!(matches!(
        decision.action,
        RecoveryAction::ManualIntervention { ref code }
            if code == "NEX_MAINTENANCE_FAILURE_DETAIL_MISSING"
    ));
}

#[test]
fn empty_ledger_without_failure_detail_starts_fresh_not_retry() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "backfill:first")
        .expect("valid work key");

    let decision = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        None,
    )
    .expect("first-cycle decision");
    assert!(matches!(decision.action, RecoveryAction::StartFresh));
    assert_eq!(decision.failed_runs, 0);
    assert_eq!(decision.total_runs, 0);
}

#[test]
fn completed_non_backfill_or_cancelled_only_rows_start_a_fresh_cycle() {
    let db = fixture_db();
    let verify_work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Verify, "verify:new-cycle")
        .expect("valid verify work key");
    db.with_conn(|conn| {
        insert_run(
            conn,
            "verify-completed",
            "completed",
            Some(EPOCH_ID),
            &verify_work,
        )?;
        Ok(())
    })
    .expect("seed completed verify run");
    let completed = decide_run_recovery_for_epoch(
        &db,
        &verify_work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        None,
    )
    .expect("completed verify decision");
    assert!(matches!(completed.action, RecoveryAction::StartFresh));

    let backfill_work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "backfill:completed")
        .expect("valid backfill work key");
    db.with_conn(|conn| {
        insert_run(
            conn,
            "backfill-completed",
            "completed",
            Some(EPOCH_ID),
            &backfill_work,
        )?;
        Ok(())
    })
    .expect("seed completed backfill run");
    let completed_with_failure = decide_run_recovery_for_epoch(
        &db,
        &backfill_work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        Some("database is locked"),
    )
    .expect("completed backfill failure decision");
    assert!(matches!(
        completed_with_failure.action,
        RecoveryAction::ManualIntervention { ref code }
            if code == "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING"
    ));

    let cancelled_work = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::RebuildDerived,
        "rebuild:new-cycle",
    )
    .expect("valid rebuild work key");
    db.with_conn(|conn| {
        insert_run(
            conn,
            "rebuild-cancelled",
            "cancelled",
            Some(EPOCH_ID),
            &cancelled_work,
        )?;
        Ok(())
    })
    .expect("seed cancelled rebuild run");
    let cancelled = decide_run_recovery_for_epoch(
        &db,
        &cancelled_work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        None,
    )
    .expect("cancelled rebuild decision");
    assert!(matches!(cancelled.action, RecoveryAction::StartFresh));
}

#[test]
fn transient_failure_without_a_failed_ledger_row_fails_closed() {
    let db = fixture_db();
    let work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Verify, "verify:missing-row")
        .expect("valid verify work key");
    let decision = decide_run_recovery_for_epoch(
        &db,
        &work,
        Some(EPOCH_ID),
        RecoveryMode::SameProcessLive,
        Some("database is locked"),
    )
    .expect("missing failure ledger decision");
    assert!(matches!(
        decision.action,
        RecoveryAction::ManualIntervention { ref code }
            if code == "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING"
    ));
}

#[test]
fn epoch_contract_mismatch_fails_closed_for_recovery_and_terminalization() {
    let db = fixture_db();
    let epoch_bound_work = WorkKey::new_for_epoch(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        "backfill:epoch-contract",
        EPOCH_ID,
    )
    .expect("valid epoch-bound work key");

    let missing_expected = decide_run_recovery_for_epoch(
        &db,
        &epoch_bound_work,
        None,
        RecoveryMode::StartupRecovery,
        None,
    )
    .expect_err("epoch-bound work requires expected epoch");
    assert!(missing_expected
        .to_string()
        .contains("semantic epoch is required"));

    let wrong_expected = decide_run_recovery_for_epoch(
        &db,
        &epoch_bound_work,
        Some(OLD_EPOCH_ID),
        RecoveryMode::StartupRecovery,
        None,
    )
    .expect_err("mismatched expected epoch must fail closed");
    assert!(wrong_expected
        .to_string()
        .contains("does not match the WorkKey"));

    let target_work = WorkKey::new(PROJECT_ID, AutomaticRunKind::Backfill, "backfill:target")
        .expect("valid legacy-compatible work key");
    db.with_conn(|conn| {
        insert_run(
            conn,
            "run-wrong-epoch",
            "running",
            Some(OLD_EPOCH_ID),
            &target_work,
        )?;
        Ok(())
    })
    .expect("seed mismatched target");
    let target_error = terminalize_interrupted_runs_for_epoch(
        &db,
        PROJECT_ID,
        &target_work,
        Some(EPOCH_ID),
        &["run-wrong-epoch".to_string()],
    )
    .expect_err("target row epoch must match expected epoch");
    assert!(target_error
        .to_string()
        .contains("does not match maintenance work"));
    let status: String = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-wrong-epoch'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("read unchanged target");
    assert_eq!(status, "running");
}

#[test]
fn terminalize_interrupted_run_ids_is_transactional_and_does_not_create_children() {
    let db = fixture_db();
    let work = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        "backfill:terminalize",
    )
    .expect("valid work key");
    db.with_conn(|conn| {
        insert_run(conn, "run-running", "running", Some(EPOCH_ID), &work)?;
        insert_run(conn, "run-pending", "pending", Some(EPOCH_ID), &work)?;
        Ok(())
    })
    .expect("seed active runs");

    let result = terminalize_interrupted_runs(
        &db,
        PROJECT_ID,
        &work,
        &["run-running".to_string(), "run-pending".to_string()],
    )
    .expect("terminalize active runs");
    assert_eq!(result.failed_run_ids, vec!["run-running".to_string()]);
    assert_eq!(
        result.cancelled_pending_run_ids,
        vec!["run-pending".to_string()]
    );

    db.with_conn(|conn| {
        let statuses = ["run-running", "run-pending"]
            .into_iter()
            .map(|id| {
                conn.query_row(
                    "SELECT status, terminal_reason_code
                       FROM narrative_extraction_runs WHERE id = ?1",
                    [id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            statuses,
            vec![
                (
                    "failed".to_string(),
                    Some("NEX_MAINTENANCE_INTERRUPTED".to_string())
                ),
                (
                    "cancelled".to_string(),
                    Some("NEX_MAINTENANCE_INTERRUPTED".to_string())
                ),
            ]
        );
        let children: (i64, i64) = (
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_tasks",
                [],
                |row| row.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_attempts",
                [],
                |row| row.get(0),
            )?,
        );
        assert_eq!(children, (0, 0));
        Ok(())
    })
    .expect("inspect terminalized runs");

    db.with_conn(|conn| {
        Ok(insert_run(
            conn,
            "run-rollback",
            "running",
            Some(EPOCH_ID),
            &work,
        )?)
    })
    .expect("seed rollback run");
    let error = terminalize_interrupted_runs(
        &db,
        PROJECT_ID,
        &work,
        &["run-rollback".to_string(), "does-not-exist".to_string()],
    )
    .expect_err("unknown run must roll back the batch");
    assert!(error.to_string().contains("run does not belong"));
    let rollback_status: String = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-rollback'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("read rollback status");
    assert_eq!(rollback_status, "running");
}
