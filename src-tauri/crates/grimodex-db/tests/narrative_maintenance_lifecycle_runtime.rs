//! RED-first C2-5B integration coverage for the Run/Task/Attempt owner.
//!
//! The accepted foreground runtime already dispatches the three automatic
//! phases and can hold/release a marked Run.  These tests pin the missing
//! lifecycle contract at that boundary: every phase owns one Task and one
//! Attempt, foreground success holds all three rows, and recovery preserves
//! exact Attempt failure metadata.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    complete_foreground_system_work_run, find_running_foreground_system_work_run,
    run_system_work_cycle, run_system_work_cycle_with_modes_and_config, AutomaticRunKind,
    MaintenanceCycleRequest, MaintenanceCycleStatus, NarrativeMaintenanceCiConfig,
    MaintenanceWorkspaceBinding, NarrativeMaintenanceCiTrigger, RecoveryMode, WorkKey,
    LEGACY_BACKFILL_WORK_KEY, REBUILD_DERIVED_WORK_KEY, VERIFY_WORK_KEY_PREFIX,
};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::json;

const PROJECT_ID: &str = "project-c2-5b-lifecycle";
const EPOCH_ID: &str = "epoch-c2-5b-lifecycle";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B lifecycle')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-23T00:00:00.000Z')",
            params![EPOCH_ID, PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed lifecycle fixture");
    db
}

fn request(run_kind: AutomaticRunKind) -> MaintenanceCycleRequest {
    let (work_key, semantic_epoch_id) = match run_kind {
        AutomaticRunKind::Backfill => (LEGACY_BACKFILL_WORK_KEY, None),
        AutomaticRunKind::Verify => (VERIFY_WORK_KEY_PREFIX, Some(EPOCH_ID)),
        AutomaticRunKind::RebuildDerived => (REBUILD_DERIVED_WORK_KEY, Some(EPOCH_ID)),
    };
    let work_key = if run_kind == AutomaticRunKind::Verify {
        format!("{work_key}{EPOCH_ID}")
    } else {
        work_key.to_string()
    };
    serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": run_kind,
            "workKey": work_key,
            "semanticEpochId": semantic_epoch_id,
            "reasons": ["lifecycle-integration"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid maintenance request")
}

fn lifecycle_rows_for_run(
    db: &Database,
    run_id: &str,
) -> anyhow::Result<(
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
)> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT r.status, t.status, a.status,
                    r.completed_at, t.completed_at, a.completed_at
               FROM narrative_extraction_runs r
               JOIN narrative_extraction_tasks t ON t.run_id = r.id
               JOIN narrative_extraction_attempts a ON a.task_id = t.id
              WHERE r.id = ?1",
            [run_id],
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
        .map_err(Into::into)
    })
}

#[test]
fn automatic_success_owns_exactly_one_task_and_attempt_and_finalizes_atomically() {
    for run_kind in AutomaticRunKind::all() {
        let db = fixture_db();
        run_system_work_cycle(&db, &request(run_kind), RecoveryMode::SameProcessLive)
            .expect("automatic phase succeeds");

        let rows: Vec<(String, String, String, String, String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT r.status, t.status, a.status,
                            r.completed_at, t.completed_at, a.completed_at
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE r.project_id = ?1 AND r.run_kind = ?2",
                )?;
                let rows = statement
                    .query_map(params![PROJECT_ID, run_kind.as_str()], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read automatic lifecycle");
        assert_eq!(rows.len(), 1, "one lifecycle pair belongs to each phase");
        let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) =
            &rows[0];
        assert_eq!(run_status, "completed");
        assert_eq!(task_status, "completed");
        assert_eq!(attempt_status, "completed");
        assert_eq!(run_at, task_at);
        assert_eq!(task_at, attempt_at);
    }
}

#[test]
fn foreground_success_holds_all_three_rows_then_exact_release_shares_one_timestamp() {
    let db = fixture_db();
    let binding = MaintenanceWorkspaceBinding {
        authority_id: "authority-c2-5b-lifecycle".to_string(),
        generation: 17,
    };
    let config = NarrativeMaintenanceCiConfig {
        is_packaged: false,
        ci: "true".to_string(),
        owner_token: "c2-5b-product-journey-owner-v1".to_string(),
        fault: None,
        trigger: Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake),
        setup: None,
        product_journey_barrier_id: Some("barrier-c2-5b-lifecycle".to_string()),
        correlation: Some("correlation-c2-5b-lifecycle".to_string()),
    };
    let mut foreground_request = request(AutomaticRunKind::RebuildDerived);
    foreground_request.workspace_binding = Some(binding.clone());

    let result = run_system_work_cycle_with_modes_and_config(
        &db,
        &foreground_request,
        |_| RecoveryMode::SameProcessLive,
        Some(&config),
    )
    .expect("foreground phase succeeds");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);

    let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
        .expect("find exact foreground Run")
        .expect("foreground Run remains held");
    let held = lifecycle_rows_for_run(&db, &barrier.run_id);
    assert!(held.is_ok(), "held Run must own Task and Attempt");
    let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) =
        held.expect("read held lifecycle");
    assert_eq!(
        (run_status.as_str(), task_status.as_str(), attempt_status.as_str()),
        ("running", "running", "running")
    );
    assert_eq!((run_at, task_at, attempt_at), (None, None, None));

    complete_foreground_system_work_run(&db, &barrier).expect("release exact foreground Run");
    let released = lifecycle_rows_for_run(&db, &barrier.run_id).expect("read released lifecycle");
    let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) = released;
    assert_eq!(
        (run_status.as_str(), task_status.as_str(), attempt_status.as_str()),
        ("completed", "completed", "completed")
    );
    assert!(run_at.is_some());
    assert_eq!(run_at, task_at);
    assert_eq!(task_at, attempt_at);
}

#[test]
fn startup_interruption_fails_the_exact_attempt_and_preserves_failure_metadata() {
    let db = fixture_db();
    let work = WorkKey::new_for_epoch(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        LEGACY_BACKFILL_WORK_KEY,
        EPOCH_ID,
    )
    .expect("valid recovery work key");
    let spec = r#"{"backfillAlgorithmVersion":"2"}"#;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('interrupted-lifecycle-run', ?1, 'maintenance', '{}', ?2,
                     'sha256:backfill', 'running', '{}', ?3, ?3,
                     'backfill', ?4, ?5)",
            params![PROJECT_ID, spec, "2026-08-23T00:00:00.000Z", EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, priority, attempt_count,
                 created_at, started_at, version)
             VALUES ('interrupted-lifecycle-task', 'interrupted-lifecycle-run',
                     'maintenance-backfill', 'running', ?1, 0, 1, ?2, ?2, 0)",
            params![spec, "2026-08-23T00:00:00.000Z"],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at)
             VALUES ('interrupted-lifecycle-attempt', 'interrupted-lifecycle-task',
                     1, 'running', ?1)",
            ["2026-08-23T00:00:00.000Z"],
        )?;
        Ok(())
    })
    .expect("seed interrupted lifecycle");

    let result = grimodex_db::narrative_extraction::maintenance_runtime::terminalize_interrupted_runs_for_epoch(
        &db,
        PROJECT_ID,
        &work,
        Some(EPOCH_ID),
        &["interrupted-lifecycle-run".to_string()],
    )
    .expect("startup recovery terminalizes all lifecycle rows");
    assert_eq!(result.failed_run_ids, ["interrupted-lifecycle-run"]);

    let metadata: (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT r.status, t.status, a.status,
                        r.completed_at, t.completed_at, a.completed_at,
                        a.error_message, a.failure_code, a.retry_disposition,
                        a.next_attempt_at
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = 'interrupted-lifecycle-run'",
                [],
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
                        row.get(8)?,
                        row.get(9)?,
                    ))
                },
            )
            .map_err(Into::into)
        })
        .expect("read interrupted lifecycle metadata");
    assert_eq!(
        (&metadata.0, &metadata.1, &metadata.2),
        (&"failed".to_string(), &"failed".to_string(), &"failed".to_string())
    );
    assert!(metadata.3.is_some());
    assert_eq!(metadata.3, metadata.4);
    assert_eq!(metadata.4, metadata.5);
    assert_eq!(metadata.5, metadata.9);
    assert_eq!(
        metadata.6.as_deref(),
        Some("NEX_MAINTENANCE_INTERRUPTED: process interruption")
    );
    assert_eq!(metadata.7.as_deref(), Some("NEX_MAINTENANCE_INTERRUPTED"));
    assert_eq!(metadata.8.as_deref(), Some("retryable"));
}
