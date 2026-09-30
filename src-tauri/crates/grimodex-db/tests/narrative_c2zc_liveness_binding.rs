//! C2-ZC scheduler receipts are bound to the exact Database authority.
//!
//! This characterization test is intentionally separate from the immutable
//! public RED contract.  Two in-memory workspaces can expose the same project
//! ids, so project-set equality alone must not let a receipt cross the
//! authority boundary.

use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use grimodex_db::narrative_extraction::{
    ensure_test_schema, inspect_workspace_cutover_readiness_with_liveness,
    record_live_scheduler_heartbeat, run_incremental_freshness_cycle_with_liveness_capability,
    ReadinessState, SchedulerLivenessEvidence,
};
use grimodex_db::Database;

static LIVENESS_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn serialize_liveness_test() -> std::sync::MutexGuard<'static, ()> {
    LIVENESS_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('same-project', 'Same project')",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

fn scheduler_heartbeat(
    db: &Database,
    authority_id: &str,
    generation: u64,
) -> SchedulerLivenessEvidence {
    let (_outcome, successful_cycle) = run_incremental_freshness_cycle_with_liveness_capability(db)
        .expect("run successful scheduler cycle before liveness receipt");
    record_live_scheduler_heartbeat(db, authority_id, generation, successful_cycle)
        .expect("mint capability-bound scheduler receipt")
}

#[test]
fn same_project_receipt_cannot_cross_database_authority() {
    let _test_guard = serialize_liveness_test();
    let authority_a = fixture_db();
    let authority_b = fixture_db();
    let evidence = scheduler_heartbeat(&authority_a, "authority-a", 1);

    authority_b
        .with_conn(|conn| {
            let readiness =
                inspect_workspace_cutover_readiness_with_liveness(conn, Some(&evidence))?;
            assert_eq!(readiness.state, ReadinessState::Blocked);
            assert!(readiness.reasons.iter().any(|reason| {
                reason.contains("NEX_C2ZC_SCHEDULER_LIVENESS_DATABASE_MISMATCH")
            }));
            Ok::<_, anyhow::Error>(())
        })
        .expect("cross-authority readiness report");
}

#[test]
fn completed_cycle_capability_cannot_cross_database_authority() {
    let _test_guard = serialize_liveness_test();
    let authority_a = fixture_db();
    let authority_b = fixture_db();
    let (_outcome, successful_cycle) =
        run_incremental_freshness_cycle_with_liveness_capability(&authority_a)
            .expect("run cycle on first authority");

    let error = record_live_scheduler_heartbeat(&authority_b, "authority-b", 1, successful_cycle)
        .expect_err("do not turn another authority's successful cycle into a heartbeat");
    assert!(error
        .to_string()
        .contains("NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_DATABASE_MISMATCH"));
}

#[test]
fn completed_cycle_capability_expires_before_a_late_heartbeat() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    let (_outcome, successful_cycle) =
        run_incremental_freshness_cycle_with_liveness_capability(&db)
            .expect("run cycle before delayed heartbeat");

    std::thread::sleep(Duration::from_secs(6));
    let error = record_live_scheduler_heartbeat(&db, "authority-a", 1, successful_cycle)
        .expect_err("a retained old cycle cannot mint a fresh scheduler receipt");
    assert!(error
        .to_string()
        .contains("NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE"));
}

#[test]
fn authority_generation_replacement_rejects_the_previous_receipt() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    let previous = scheduler_heartbeat(&db, "authority-a", 1);
    let _current = scheduler_heartbeat(&db, "authority-b", 2);

    db.with_conn(|conn| {
        let readiness = inspect_workspace_cutover_readiness_with_liveness(conn, Some(&previous))?;
        assert_eq!(readiness.state, ReadinessState::Blocked);
        assert!(readiness
            .reasons
            .iter()
            .any(|reason| { reason.contains("NEX_C2ZC_SCHEDULER_LIVENESS_RECEIPT_MISMATCH") }));
        Ok::<_, anyhow::Error>(())
    })
    .expect("stale authority readiness report");
}
