//! C2-5B Phase 1 liveness contract for the existing incremental consumer.

use grimodex_db::narrative_extraction::{
    ensure_test_schema, run_incremental_freshness_cycle, IncrementalFreshnessCycleOutcome,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "project-c2-5b-liveness";
const OLD_EPOCH_ID: &str = "epoch-c2-5b-liveness-old";
const CURRENT_EPOCH_ID: &str = "epoch-c2-5b-liveness-current";
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

fn seed_completed_freshness_run(db: &Database, epoch_id: &str, run_id: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind,
                 semantic_epoch_id, work_key, consumer_id)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'freshness-digest',
                     'completed', '{}', ?3, ?3, 'freshness-evaluation',
                     ?4, 'freshness-evaluation:phase1',
                     'narrative-incremental-freshness/v1')",
            params![run_id, PROJECT_ID, OCCURRED_AT, epoch_id],
        )?;
        Ok(())
    })
    .expect("seed completed Freshness Run");
}

#[test]
fn missing_cursor_is_not_an_incremental_liveness_pass() {
    let db = fixture_db();
    seed_completed_freshness_run(&db, CURRENT_EPOCH_ID, "completed-without-cursor");

    let outcome = run_incremental_freshness_cycle(&db).ok();
    assert!(
        !matches!(outcome, Some(IncrementalFreshnessCycleOutcome::Idle)),
        "a completed Run without a cursor cannot prove current-epoch liveness"
    );
}

#[test]
fn old_epoch_cursor_at_feed_head_is_not_an_incremental_liveness_pass() {
    let db = fixture_db();
    seed_completed_freshness_run(&db, OLD_EPOCH_ID, "completed-old-epoch");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence,
                 updated_at, semantic_epoch_id)
             VALUES (?1, 'narrative-incremental-freshness/v1', 0, ?2, ?3)",
            params![PROJECT_ID, OCCURRED_AT, OLD_EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed old-epoch cursor at Feed head");

    let outcome = run_incremental_freshness_cycle(&db).ok();
    assert!(
        !matches!(outcome, Some(IncrementalFreshnessCycleOutcome::Idle)),
        "an old-epoch cursor cannot prove current-epoch liveness"
    );
}
