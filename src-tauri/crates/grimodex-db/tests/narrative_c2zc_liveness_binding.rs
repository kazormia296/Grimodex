//! C2-ZC scheduler receipts are bound to the exact Database authority.
//!
//! This characterization test is intentionally separate from the immutable
//! public RED contract.  Two in-memory workspaces can expose the same project
//! ids, so project-set equality alone must not let a receipt cross the
//! authority boundary.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use grimodex_db::narrative_extraction::{
    inspect_workspace_cutover_readiness_with_liveness, record_live_scheduler_heartbeat,
    ReadinessState,
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
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('same-project', 'Same project')",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

#[test]
fn same_project_receipt_cannot_cross_database_authority() {
    let _test_guard = serialize_liveness_test();
    let authority_a = fixture_db();
    let authority_b = fixture_db();
    let evidence = record_live_scheduler_heartbeat(&authority_a, "authority-a", 1)
        .expect("mint receipt for authority A");

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
fn authority_generation_replacement_rejects_the_previous_receipt() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    let previous = record_live_scheduler_heartbeat(&db, "authority-a", 1)
        .expect("mint first authority receipt");
    let _current = record_live_scheduler_heartbeat(&db, "authority-b", 2)
        .expect("replace receipt for the current authority");

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
