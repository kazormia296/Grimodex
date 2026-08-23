//! Behavioral C2-5B fault-seam coverage.
//!
//! These tests exercise the same shared Backfill owner used by N-API.  The
//! fault adapter must leave a real Run/Task/Attempt triplet behind before it
//! reports a transient, terminal, or interruption outcome; it must not use a
//! test-only database fabrication path.

use grimodex_db::narrative_extraction::{
    build_maintenance_inbox, discover_durable_maintenance_work, ensure_test_schema,
    inject_legacy_backfill_fault_for_project, inject_legacy_backfill_fault_for_work,
    run_system_work_cycle, terminalize_interrupted_runs_for_epoch, AutomaticRunKind,
    InboxEntryKind, LegacyBackfillFaultOutcome, MaintenanceCycleRequest, MaintenanceCycleStatus,
    NarrativeMaintenanceCiFault, RecoveryMode, WorkKey, LEGACY_BACKFILL_WORK_KEY,
};
use grimodex_db::Database;
use serde_json::json;

const PROJECT_ID: &str = "project-c2-5b-fault";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B fault')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

#[derive(Debug, PartialEq, Eq)]
struct LifecycleSnapshot {
    run_status: String,
    task_status: String,
    attempt_status: String,
    task_kind: String,
    attempt_number: i64,
    failure_code: Option<String>,
    task_count: i64,
    attempt_count: i64,
}

fn lifecycle_snapshot(db: &Database, run_id: &str) -> LifecycleSnapshot {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT r.status, t.status, a.status, t.task_kind, a.attempt_number,
                    a.failure_code,
                    (SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = r.id),
                    (SELECT COUNT(*)
                       FROM narrative_extraction_attempts aa
                       JOIN narrative_extraction_tasks tt ON tt.id = aa.task_id
                      WHERE tt.run_id = r.id)
               FROM narrative_extraction_runs r
               JOIN narrative_extraction_tasks t ON t.run_id = r.id
               JOIN narrative_extraction_attempts a ON a.task_id = t.id
              WHERE r.id = ?1",
            [run_id],
            |row| {
                Ok(LifecycleSnapshot {
                    run_status: row.get(0)?,
                    task_status: row.get(1)?,
                    attempt_status: row.get(2)?,
                    task_kind: row.get(3)?,
                    attempt_number: row.get(4)?,
                    failure_code: row.get(5)?,
                    task_count: row.get(6)?,
                    attempt_count: row.get(7)?,
                })
            },
        )
        .map_err(Into::into)
    })
    .expect("read lifecycle triplet")
}

fn terminal_failure_inbox_count(db: &Database) -> usize {
    db.with_conn(|conn| {
        Ok(
            build_maintenance_inbox(conn, PROJECT_ID, "2026-08-23T01:00:00.000Z")?
                .into_iter()
                .filter(|entry| entry.entry_kind == InboxEntryKind::TerminalFailure)
                .count(),
        )
    })
    .expect("read maintenance Inbox")
}

fn backfill_request() -> MaintenanceCycleRequest {
    serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "backfill",
            "workKey": LEGACY_BACKFILL_WORK_KEY,
            "semanticEpochId": null,
            "reasons": ["fault-retry"]
        }],
        "wakeProjectIds": []
    }))
    .expect("canonical backfill request")
}

fn backfill_run_statuses(db: &Database) -> Vec<String> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT status
               FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'backfill'
              ORDER BY created_at, id",
        )?;
        let statuses = statement
            .query_map([PROJECT_ID], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(statuses)
    })
    .expect("read backfill statuses")
}

#[test]
fn project_fault_helper_must_not_follow_a_rotated_epoch_from_a_preflighted_work_item() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('fault-epoch-one', ?1, 0, 'initial',
                     '2026-08-23T00:00:00.000Z')",
            [PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed first Semantic Epoch");

    let planned = discover_durable_maintenance_work(&db, PROJECT_ID, "durable-wake")
        .expect("discover preflighted Backfill")
        .expect("current Epoch without a completed Backfill needs Backfill");
    assert_eq!(planned.run_kind, AutomaticRunKind::Backfill);
    assert_eq!(
        planned.semantic_epoch_id.as_deref(),
        Some("fault-epoch-one")
    );

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('fault-epoch-two', ?1, 1, 'restore',
                     '2026-08-23T00:00:01.000Z')",
            [PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("rotate Semantic Epoch after discovery");

    let expected_work = planned.work_key_identity();
    let error = inject_legacy_backfill_fault_for_work(
        &db,
        &expected_work,
        &["durable-wake".to_string()],
        NarrativeMaintenanceCiFault::ContractViolation,
    )
    .expect_err("preflighted E1 must be rejected after rotation to E2");
    assert!(
        error
            .to_string()
            .contains("NEX_MAINTENANCE_FAULT_EPOCH_MISMATCH"),
        "unexpected stale-epoch error: {error}"
    );
    let lifecycle_count: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill'",
                [PROJECT_ID],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("read fault lifecycle count");
    assert_eq!(
        lifecycle_count, 0,
        "epoch TOCTOU must not create a Backfill lifecycle under a replacement Epoch"
    );
}

#[test]
fn epochless_expected_fault_is_rejected_atomically_after_epoch_rotation() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-rotated', ?1, 1, 'restore',
                     '2026-08-23T01:00:00.000Z')",
            [PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("rotate the current Semantic Epoch before the fault write");
    let expected = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        LEGACY_BACKFILL_WORK_KEY,
    )
    .expect("epoch-less Backfill identity");
    let error = inject_legacy_backfill_fault_for_work(
        &db,
        &expected,
        &["workspace-opened".to_string()],
        NarrativeMaintenanceCiFault::ContractViolation,
    )
    .expect_err("an epoch-less preflight identity cannot inject after rotation");
    assert!(
        error
            .to_string()
            .contains("NEX_MAINTENANCE_FAULT_EPOCH_MISMATCH"),
        "unexpected stale-epoch error: {error}"
    );
    let (epoch_count, run_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read atomic stale-epoch evidence");
    assert_eq!(epoch_count, 1);
    assert_eq!(run_count, 0);
}

#[test]
fn crafted_fault_reason_cannot_inject_a_backfill_lifecycle() {
    let db = fixture_db();
    let expected = WorkKey::new(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        LEGACY_BACKFILL_WORK_KEY,
    )
    .expect("epoch-less Backfill identity");
    let error = inject_legacy_backfill_fault_for_work(
        &db,
        &expected,
        &["fault-preflight".to_string()],
        NarrativeMaintenanceCiFault::ContractViolation,
    )
    .expect_err("a private sentinel reason must fail planner revalidation");
    assert!(
        error
            .to_string()
            .contains("NEX_MAINTENANCE_FAULT_PLANNER_MISMATCH"),
        "unexpected crafted-reason error: {error}"
    );
    let run_count: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs WHERE project_id = ?1",
                [PROJECT_ID],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("read crafted-reason lifecycle evidence");
    assert_eq!(run_count, 0);
}

#[test]
fn transient_fault_leaves_one_failed_attempt_without_inbox_projection() {
    let db = fixture_db();
    let outcome = inject_legacy_backfill_fault_for_project(
        &db,
        PROJECT_ID,
        NarrativeMaintenanceCiFault::TransientIo,
    )
    .expect("inject transient fault");
    let run_id = match outcome {
        LegacyBackfillFaultOutcome::Failed {
            run_id,
            failure_code,
            ..
        } => {
            assert_eq!(failure_code, "NEX_MAINTENANCE_TRANSIENT");
            run_id
        }
        other => panic!("expected durable transient failure, got {other:?}"),
    };
    assert_eq!(
        lifecycle_snapshot(&db, &run_id),
        LifecycleSnapshot {
            run_status: "failed".to_string(),
            task_status: "failed".to_string(),
            attempt_status: "failed".to_string(),
            task_kind: "maintenance-backfill".to_string(),
            attempt_number: 1,
            failure_code: Some("NEX_MAINTENANCE_TRANSIENT".to_string()),
            task_count: 1,
            attempt_count: 1,
        }
    );
    assert_eq!(terminal_failure_inbox_count(&db), 0);
}

#[test]
fn transient_fault_is_followed_by_a_distinct_completed_retry_run() {
    let db = fixture_db();
    let first = inject_legacy_backfill_fault_for_project(
        &db,
        PROJECT_ID,
        NarrativeMaintenanceCiFault::TransientIo,
    )
    .expect("inject transient fault");
    let first_run_id = match first {
        LegacyBackfillFaultOutcome::Failed { run_id, .. } => run_id,
        other => panic!("expected durable transient failure, got {other:?}"),
    };

    let result = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::SameProcessLive)
        .expect("retry dispatch completes the sealed Backfill work");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    let statuses = backfill_run_statuses(&db);
    assert_eq!(statuses, vec!["failed", "completed"]);
    let retry_run_id: String = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT id
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill' AND id <> ?2
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1",
                [PROJECT_ID, first_run_id.as_str()],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("read distinct retry Run");
    assert_ne!(retry_run_id, first_run_id);
    let retry = lifecycle_snapshot(&db, &retry_run_id);
    assert_eq!(retry.run_status, "completed");
    assert_eq!(retry.task_status, "completed");
    assert_eq!(retry.attempt_status, "completed");
    assert_eq!(retry.task_kind, "maintenance-backfill");
    assert_eq!(retry.attempt_number, 1);
    assert_eq!((retry.task_count, retry.attempt_count), (1, 1));
    assert_eq!(terminal_failure_inbox_count(&db), 0);
}

#[test]
fn terminal_fault_leaves_exact_failed_triplet_and_one_inbox_identity() {
    let db = fixture_db();
    let outcome = inject_legacy_backfill_fault_for_project(
        &db,
        PROJECT_ID,
        NarrativeMaintenanceCiFault::ContractViolation,
    )
    .expect("inject terminal fault");
    let run_id = match outcome {
        LegacyBackfillFaultOutcome::Failed {
            run_id,
            failure_code,
            ..
        } => {
            assert_eq!(failure_code, "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION");
            run_id
        }
        other => panic!("expected durable terminal failure, got {other:?}"),
    };
    let snapshot = lifecycle_snapshot(&db, &run_id);
    assert_eq!(snapshot.run_status, "failed");
    assert_eq!(snapshot.task_status, "failed");
    assert_eq!(snapshot.attempt_status, "failed");
    assert_eq!(snapshot.task_kind, "maintenance-backfill");
    assert_eq!(snapshot.attempt_number, 1);
    assert_eq!(
        snapshot.failure_code.as_deref(),
        Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION")
    );
    assert_eq!((snapshot.task_count, snapshot.attempt_count), (1, 1));
    assert_eq!(terminal_failure_inbox_count(&db), 1);
}

#[test]
fn interruption_leaves_running_triplet_then_recovery_marks_attempt_interrupted() {
    let db = fixture_db();
    let outcome = inject_legacy_backfill_fault_for_project(
        &db,
        PROJECT_ID,
        NarrativeMaintenanceCiFault::ProcessInterruption,
    )
    .expect("inject interruption");
    let (run_id, epoch_id) = match outcome {
        LegacyBackfillFaultOutcome::Running {
            run_id,
            semantic_epoch_id,
        } => (run_id, semantic_epoch_id),
        other => panic!("expected durable running triplet, got {other:?}"),
    };
    let running = lifecycle_snapshot(&db, &run_id);
    assert_eq!(
        (
            running.run_status.as_str(),
            running.task_status.as_str(),
            running.attempt_status.as_str(),
        ),
        ("running", "running", "running")
    );
    assert_eq!((running.task_count, running.attempt_count), (1, 1));
    assert_eq!(running.attempt_number, 1);
    assert_eq!(running.failure_code, None);

    let work = WorkKey::new_for_epoch(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        LEGACY_BACKFILL_WORK_KEY,
        epoch_id,
    )
    .expect("canonical backfill work");
    let recovered = terminalize_interrupted_runs_for_epoch(
        &db,
        PROJECT_ID,
        &work,
        work.semantic_epoch_id.as_deref(),
        &[run_id.clone()],
    )
    .expect("terminalize interrupted lifecycle");
    assert_eq!(recovered.failed_run_ids, vec![run_id.clone()]);
    let interrupted = lifecycle_snapshot(&db, &run_id);
    assert_eq!(interrupted.run_status, "failed");
    assert_eq!(interrupted.task_status, "failed");
    assert_eq!(interrupted.attempt_status, "failed");
    assert_eq!(interrupted.attempt_number, 1);
    assert_eq!(
        interrupted.failure_code.as_deref(),
        Some("NEX_MAINTENANCE_INTERRUPTED")
    );
    assert_eq!((interrupted.task_count, interrupted.attempt_count), (1, 1));
}
