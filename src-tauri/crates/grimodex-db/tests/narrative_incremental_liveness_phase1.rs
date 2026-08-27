//! C2-ZA durable liveness evidence for the incremental Freshness consumer.
//!
//! These tests deliberately keep scheduler `Idle` semantics intact.  A
//! completed Run and a cursor at the Feed head are database facts, not proof
//! that a scheduler is still alive; with no external health seam they remain
//! incomplete readiness evidence.

use grimodex_db::narrative_extraction::{
    ensure_test_schema, inspect_project_cutover_readiness, run_incremental_freshness_cycle,
    IncrementalFreshnessCycleOutcome, ReadinessState,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

const PROJECT_ID: &str = "project-c2-5b-liveness";
const OLD_EPOCH_ID: &str = "epoch-c2-5b-liveness-old";
const CURRENT_EPOCH_ID: &str = "epoch-c2-5b-liveness-current";
const CONSUMER_ID: &str = "narrative-incremental-freshness/v1";
const OCCURRED_AT: &str = "2026-08-22T00:00:00.000Z";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B liveness project')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![OLD_EPOCH_ID, PROJECT_ID, OCCURRED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 1, 'restore', ?3)",
            params![CURRENT_EPOCH_ID, PROJECT_ID, OCCURRED_AT],
        )?;
        Ok(())
    })
    .expect("seed liveness fixture");
    db
}

fn seed_scene_feed_event(db: &Database, sequence: i64) {
    db.with_conn(|conn| seed_scene_feed_event_in_tx(conn, sequence))
        .expect("seed canonical Feed event");
}

fn seed_scene_feed_event_in_tx(conn: &Connection, sequence: i64) -> anyhow::Result<()> {
    let scene_id = format!("scene-c2-5b-liveness-{sequence}");
    let event_uid = format!("canonical-c2-5b-liveness-{sequence}");
    let transaction_id = format!("transaction-c2-5b-liveness-{sequence}");
    let event_id = format!("event-c2-5b-liveness-{sequence}");
    conn.execute(
        "INSERT INTO tree_nodes
            (id, project_id, node_type, title, content, version, updated_at)
         VALUES (?1, ?2, 'scene', ?1, '{}', 2, ?3)",
        params![scene_id, PROJECT_ID, OCCURRED_AT],
    )?;
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, ?3, 'scene', 'scene.update', 'scene', ?3,
                 '{}', 'c2-5b-liveness-test', ?4, 1787078400000, 'fixture-prev', 'fixture-hash')",
        params![event_uid, PROJECT_ID, scene_id, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'scene.update', ?4, ?5, 'forward', 'human', '[]',
                 ?6, ?7)",
        params![
            transaction_id,
            PROJECT_ID,
            format!("request-c2-5b-liveness-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:payload-c2-5b-liveness-{sequence}"),
            OCCURRED_AT,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, text_impact_json,
             structural_impact_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'content', 'update',
                 1, ?7, 2, ?8, '[\"/content\"]', ?9, NULL, ?10)",
        params![
            event_id,
            PROJECT_ID,
            transaction_id,
            event_uid,
            sequence,
            json!({ "kind": "scene", "sceneId": scene_id }).to_string(),
            format!("sha256:before-c2-5b-liveness-{sequence}"),
            format!("sha256:after-c2-5b-liveness-{sequence}"),
            json!({ "normalizerVersion": "gdx-canonical-text/1" }).to_string(),
            OCCURRED_AT,
        ],
    )?;
    Ok(())
}

fn process_one_feed_range() -> (Database, String) {
    let db = fixture_db();
    seed_scene_feed_event(&db, 1);
    let outcome = run_incremental_freshness_cycle(&db).expect("process canonical Feed range");
    let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
        panic!("a canonical Feed range must be processed, not Idle");
    };
    assert_eq!(summary.project_id, PROJECT_ID);
    assert_eq!(summary.through_sequence_inclusive, 1);
    let run_id = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'
                  ORDER BY created_at DESC, id DESC LIMIT 1",
                [PROJECT_ID],
                |row| row.get(0),
            )?)
        })
        .expect("read completed Freshness Run");
    (db, run_id)
}

fn seed_completed_freshness_run(
    db: &Database,
    epoch_id: &str,
    run_id: &str,
    through_sequence: i64,
    outcome: Value,
) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, outcome_summary_json, created_at, started_at, completed_at,
                 run_kind, semantic_epoch_id, work_key, consumer_id)
             VALUES (?1, ?2, 'freshness-evaluation', '{}', '{}', 'freshness-digest',
                     'completed', '{}', ?3, ?4, ?4, ?4, 'freshness-evaluation',
                     ?5, ?6, ?7)",
            params![
                run_id,
                PROJECT_ID,
                serde_json::to_string(&outcome)?,
                OCCURRED_AT,
                epoch_id,
                format!("incremental-freshness:{epoch_id}:0:{through_sequence}:fixture"),
                CONSUMER_ID,
            ],
        )?;
        Ok(())
    })
    .expect("seed completed Freshness Run");
}

fn seed_acknowledged_cursor(db: &Database, acknowledged: i64, epoch_id: Option<&str>) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence,
                 updated_at, semantic_epoch_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![PROJECT_ID, CONSUMER_ID, acknowledged, OCCURRED_AT, epoch_id],
        )?;
        Ok(())
    })
    .expect("seed Freshness cursor");
}

fn incremental_readiness(db: &Database) -> (ReadinessState, Vec<String>) {
    db.with_conn(|conn| {
        let readiness = inspect_project_cutover_readiness(conn, PROJECT_ID)?;
        Ok((
            readiness.incremental_runtime.state,
            readiness.incremental_runtime.reasons,
        ))
    })
    .expect("inspect C2-ZA readiness")
}

#[test]
fn completed_current_epoch_run_and_cursor_at_feed_head_do_not_prove_scheduler_liveness() {
    let (db, run_id) = process_one_feed_range();

    db.with_conn(|conn| {
        let (status, project_id, consumer_id, epoch_id, completed_at, outcome_json): (
            String,
            String,
            String,
            String,
            Option<String>,
            String,
        ) = conn.query_row(
            "SELECT status, project_id, consumer_id, semantic_epoch_id, completed_at,
                    outcome_summary_json
               FROM narrative_extraction_runs WHERE id = ?1",
            [run_id.as_str()],
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
        )?;
        assert_eq!(status, "completed");
        assert_eq!(project_id, PROJECT_ID);
        assert_eq!(consumer_id, CONSUMER_ID);
        assert_eq!(epoch_id, CURRENT_EPOCH_ID);
        assert!(completed_at.is_some());

        let outcome: Value = serde_json::from_str(&outcome_json)?;
        assert_eq!(outcome["runId"], run_id);
        assert_eq!(outcome["projectId"], PROJECT_ID);
        assert_eq!(outcome["throughSequenceInclusive"], 1);
        assert_eq!(outcome["hasMore"], false);

        let (acknowledged, cursor_epoch, active_run, reserved, last_error): (
            i64,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn.query_row(
            "SELECT acknowledged_through_sequence, semantic_epoch_id, active_run_id,
                    reserved_through_sequence, last_error
               FROM narrative_change_cursors
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![PROJECT_ID, CONSUMER_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(acknowledged, 1);
        assert_eq!(cursor_epoch, None);
        assert_eq!(active_run, None);
        assert_eq!(reserved, None);
        assert_eq!(last_error, None);

        let feed_head: i64 = conn.query_row(
            "SELECT COALESCE(MAX(canonical_sequence), 0)
               FROM narrative_change_events WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(feed_head, acknowledged);
        Ok(())
    })
    .expect("Run and cursor evidence must be atomically bound");

    let (state, reasons) = incremental_readiness(&db);
    assert_eq!(
        state,
        ReadinessState::Incomplete,
        "DB-only current-epoch evidence cannot prove scheduler liveness: {reasons:?}"
    );
    assert!(reasons.iter().any(|reason| {
        reason == "incremental-freshness-scheduler-liveness-evidence-unavailable"
    }));
}

#[test]
fn stopped_scheduler_with_old_completed_run_and_head_cursor_is_incomplete() {
    let db = fixture_db();
    seed_scene_feed_event(&db, 1);
    seed_completed_freshness_run(
        &db,
        CURRENT_EPOCH_ID,
        "old-completed-freshness-run",
        1,
        json!({
            "runId": "old-completed-freshness-run",
            "projectId": PROJECT_ID,
            "fromSequenceExclusive": 0,
            "throughSequenceInclusive": 1,
            "hasMore": false,
        }),
    );
    seed_acknowledged_cursor(&db, 1, None);

    let (state, reasons) = incremental_readiness(&db);
    assert_eq!(state, ReadinessState::Incomplete, "{reasons:?}");
    assert!(reasons.iter().any(|reason| {
        reason == "incremental-freshness-scheduler-liveness-evidence-unavailable"
    }));
}

#[test]
fn new_feed_after_ack_is_not_ready_but_remains_scheduler_work() {
    let (db, _) = process_one_feed_range();
    seed_scene_feed_event(&db, 2);

    let (state, _) = incremental_readiness(&db);
    assert_ne!(state, ReadinessState::Passed);
    assert!(matches!(
        run_incremental_freshness_cycle(&db).expect("process new Feed range"),
        IncrementalFreshnessCycleOutcome::Processed(_)
    ));
}

#[test]
fn old_epoch_run_and_cursor_at_feed_head_are_not_ready() {
    let db = fixture_db();
    seed_scene_feed_event(&db, 1);
    let outcome = json!({
        "runId": "old-epoch-run",
        "projectId": PROJECT_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": 1,
        "hasMore": false,
    });
    seed_completed_freshness_run(&db, OLD_EPOCH_ID, "old-epoch-run", 1, outcome);
    seed_acknowledged_cursor(&db, 1, Some(OLD_EPOCH_ID));

    let (state, _) = incremental_readiness(&db);
    assert_ne!(state, ReadinessState::Passed);
}

#[test]
fn missing_run_or_cursor_is_not_ready() {
    let db_without_run = fixture_db();
    seed_scene_feed_event(&db_without_run, 1);
    seed_acknowledged_cursor(&db_without_run, 1, None);
    assert_ne!(
        incremental_readiness(&db_without_run).0,
        ReadinessState::Passed
    );

    let (db_without_cursor, _) = process_one_feed_range();
    db_without_cursor
        .with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_change_cursors
                  WHERE project_id = ?1 AND consumer_id = ?2",
                params![PROJECT_ID, CONSUMER_ID],
            )?;
            Ok(())
        })
        .expect("remove cursor from negative fixture");
    assert_ne!(
        incremental_readiness(&db_without_cursor).0,
        ReadinessState::Passed
    );
}

fn assert_tampered_outcome_is_not_ready<F>(label: &str, mutate: F)
where
    F: FnOnce(&mut Value, &str),
{
    let (db, run_id) = process_one_feed_range();
    db.with_conn(|conn| {
        let original: String = conn.query_row(
            "SELECT outcome_summary_json FROM narrative_extraction_runs WHERE id = ?1",
            [run_id.as_str()],
            |row| row.get(0),
        )?;
        let mut outcome: Value = serde_json::from_str(&original)?;
        mutate(&mut outcome, &run_id);
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET outcome_summary_json = ?1, version = version + 1
              WHERE id = ?2 AND status = 'completed'",
            params![serde_json::to_string(&outcome)?, run_id],
        )?;
        Ok(())
    })
    .expect("tamper outcome fixture");

    let (state, reasons) = incremental_readiness(&db);
    assert_ne!(
        state,
        ReadinessState::Passed,
        "tampered {label} must not pass: {reasons:?}"
    );
}

#[test]
fn run_outcome_binding_and_completion_flags_are_required() {
    assert_tampered_outcome_is_not_ready("runId", |outcome, _| {
        outcome["runId"] = Value::String("different-run".to_string());
    });
    assert_tampered_outcome_is_not_ready("projectId", |outcome, _| {
        outcome["projectId"] = Value::String("different-project".to_string());
    });
    assert_tampered_outcome_is_not_ready("throughSequenceInclusive", |outcome, _| {
        outcome["throughSequenceInclusive"] = json!(0);
    });
    assert_tampered_outcome_is_not_ready("hasMore", |outcome, _| {
        outcome["hasMore"] = json!(true);
    });
}

#[test]
fn active_reservation_is_not_completed_liveness_evidence() {
    let (db, run_id) = process_one_feed_range();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_change_cursors
                SET semantic_epoch_id = ?1, reserved_through_sequence = 1,
                    active_run_id = ?2,
                    lease_expires_at = '2099-01-01T00:00:00.000Z'
              WHERE project_id = ?3 AND consumer_id = ?4",
            params![CURRENT_EPOCH_ID, run_id, PROJECT_ID, CONSUMER_ID],
        )?;
        Ok(())
    })
    .expect("seed active reservation shape");

    assert_ne!(incremental_readiness(&db).0, ReadinessState::Passed);
}

#[test]
fn stale_lease_without_active_reservation_is_not_durable_liveness() {
    let (db, _) = process_one_feed_range();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_change_cursors
                SET lease_expires_at = '2020-01-01T00:00:00.000Z'
              WHERE project_id = ?1 AND consumer_id = ?2",
            params![PROJECT_ID, CONSUMER_ID],
        )?;
        Ok(())
    })
    .expect("seed stale lease without reservation owner");

    let (state, reasons) = incremental_readiness(&db);
    assert_ne!(state, ReadinessState::Passed);
    assert!(
        reasons.iter().any(|reason| reason.contains("reservation")),
        "{reasons:?}"
    );
}

#[test]
fn malformed_newer_run_cannot_be_hidden_by_an_older_valid_run() {
    let (db, _) = process_one_feed_range();
    let valid_run_id = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'freshness-evaluation'
                  ORDER BY rowid DESC LIMIT 1",
                [PROJECT_ID],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("read valid run");
    let malformed_outcome = json!({
        "runId": "malformed-newer-run",
        "projectId": PROJECT_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": 1,
        "hasMore": false,
    });
    seed_completed_freshness_run(
        &db,
        CURRENT_EPOCH_ID,
        "malformed-newer-run",
        1,
        malformed_outcome,
    );
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET created_at = 'not-an-instant', completed_at = 'not-an-instant'
              WHERE id = 'malformed-newer-run'",
            [],
        )?;
        Ok(())
    })
    .expect("make the newest run timestamp malformed");

    let (state, reasons) = incremental_readiness(&db);
    assert_ne!(state, ReadinessState::Passed);
    assert!(
        reasons
            .iter()
            .any(|reason| reason == "incremental-freshness-run-lifecycle-invalid"),
        "{reasons:?}; valid run was {valid_run_id}"
    );
}

#[test]
fn work_key_range_must_match_completed_outcome_range() {
    let (db, run_id) = process_one_feed_range();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET work_key = ?1
              WHERE id = ?2",
            params![
                format!("incremental-freshness:{CURRENT_EPOCH_ID}:1:1:fixture"),
                run_id,
            ],
        )?;
        Ok(())
    })
    .expect("tamper completed work key range");

    assert_ne!(incremental_readiness(&db).0, ReadinessState::Passed);
}
