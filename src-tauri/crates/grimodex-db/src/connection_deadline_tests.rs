//! DR-CHATIR-S1-11 (chat IR S1-A0): the participant read and the audit append
//! that use the deadline-bound, waiter-free acquisition.

use super::tests::{test_db, Holder};
use crate::ai_audit::AppendAiAuditEvent;
use crate::narrative_extraction::{is_validation_terminated, ValidationTerminated};
use crate::{Database, ParticipantSqlOperationBudget, WorkspaceParticipant};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

fn test_participant() -> (crate::WorkspaceLifecycleCore, WorkspaceParticipant) {
    let core = crate::WorkspaceLifecycleCore::new();
    core.set_ready(crate::LiveBinding::new(
        "/tmp/workspace",
        "workspace-1",
        1,
        1,
    ))
    .expect("ready workspace");
    let participant = core.begin_workspace_participant().expect("participant");
    (core, participant)
}

fn budget(deadline: Instant) -> ParticipantSqlOperationBudget {
    ParticipantSqlOperationBudget::new(
        Arc::new(AtomicBool::new(false)),
        deadline,
        Duration::from_secs(5),
    )
}

fn termination_reason(
    error: anyhow::Error,
) -> crate::narrative_extraction::ValidationTerminationReason {
    assert!(is_validation_terminated(&error), "{error}");
    error
        .downcast_ref::<ValidationTerminated>()
        .expect("typed validation termination")
        .reason
}

/// Segment 1 of the deadline (connection): a busy connection ends as `None` at
/// the deadline, the body never ran, no waiter was announced at any instant,
/// and the next call runs once the holder lets go. The `TryUntil` loop turning
/// into a single `TryOnce` attempt would end it at the first `None` (fails the
/// elapsed lower bound); a blocking acquisition would hang on the holder.
#[test]
fn participant_read_until_is_none_at_the_deadline_without_a_waiter() {
    let db = Arc::new(test_db());
    let (_core, participant) = test_participant();
    let mut holder = Holder::new(&db);
    let stop = Arc::new(AtomicBool::new(false));
    let max_seen = Arc::new(AtomicUsize::new(0));
    let observer = {
        let (db, stop, max_seen) = (Arc::clone(&db), Arc::clone(&stop), Arc::clone(&max_seen));
        thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                max_seen.fetch_max(db.foreground_connection_waiter_count(), Ordering::SeqCst);
                thread::yield_now();
            }
        })
    };
    let ran = AtomicBool::new(false);
    let started = Instant::now();
    let wait = Duration::from_millis(120);
    let skipped = db
        .try_with_participant_read_transaction_until(&participant, budget(started + wait), |_| {
            ran.store(true, Ordering::Release);
            Ok(1)
        })
        .expect("a busy connection is not an error");
    let elapsed = started.elapsed();
    assert_eq!(skipped, None);
    assert!(!ran.load(Ordering::Acquire));
    assert!(elapsed >= wait, "gave up before the deadline: {elapsed:?}");
    assert!(
        elapsed < wait + Duration::from_millis(1500),
        "did not stop at the deadline: {elapsed:?}"
    );
    assert!(db.connection_reusable());
    holder.release();
    let value = db
        .try_with_participant_read_transaction_until(
            &participant,
            budget(Instant::now() + Duration::from_secs(5)),
            |conn| Ok(conn.query_row("SELECT 7", [], |row| row.get::<_, i64>(0))?),
        )
        .expect("a free connection runs");
    assert_eq!(value, Some(7));
    stop.store(true, Ordering::Release);
    observer.join().expect("observer joined");
    assert_eq!(max_seen.load(Ordering::SeqCst), 0);
}

/// The connection lock timeout of the budget bounds the acquisition on its own
/// (before the operation deadline), and a deadline that passed before the call
/// is `None` without running the body.
#[test]
fn participant_read_until_honours_the_lock_timeout_and_a_passed_deadline() {
    let db = Arc::new(test_db());
    let (_core, participant) = test_participant();
    let _holder = Holder::new(&db);
    let started = Instant::now();
    let skipped = db
        .try_with_participant_read_transaction_until(
            &participant,
            budget(started + Duration::from_secs(30))
                .with_connection_lock_timeout(Duration::from_millis(80)),
            |_| Ok(()),
        )
        .expect("not an error");
    assert_eq!(skipped, None);
    assert!(started.elapsed() < Duration::from_secs(5));

    let db = test_db();
    let ran = AtomicBool::new(false);
    let passed = db
        .try_with_participant_read_transaction_until(&participant, budget(Instant::now()), |_| {
            ran.store(true, Ordering::Release);
            Ok(())
        })
        .expect("not an error");
    assert_eq!(passed, None);
    assert!(!ran.load(Ordering::Acquire));
}

/// A held connection is retried: released inside the budget, the read runs.
#[test]
fn participant_read_until_takes_the_connection_released_in_time() {
    let db = Arc::new(test_db());
    let (_core, participant) = test_participant();
    let mut holder = Holder::new(&db);
    let releaser = thread::spawn(move || {
        thread::sleep(Duration::from_millis(60));
        holder.release();
    });
    let value = db
        .try_with_participant_read_transaction_until(
            &participant,
            budget(Instant::now() + Duration::from_secs(5)),
            |_| Ok(5),
        )
        .expect("not an error");
    releaser.join().expect("releaser joined");
    assert_eq!(value, Some(5));
}

/// A stopped participant is a typed stop even while the connection is busy
/// (it must not be retried until the deadline as if it were "busy").
#[test]
fn participant_read_until_reports_a_stopped_participant_as_an_error() {
    let db = Arc::new(test_db());
    let (core, participant) = test_participant();
    let _holder = Holder::new(&db);
    core.request_shutdown().expect("shutdown requested");
    let started = Instant::now();
    let error = db
        .try_with_participant_read_transaction_until(
            &participant,
            budget(started + Duration::from_secs(30)),
            |_| Ok(()),
        )
        .expect_err("a stopped participant is an error even when busy");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(
        termination_reason(error),
        crate::narrative_extraction::ValidationTerminationReason::Cancelled
    );
}

/// The stop is also observed **while** the call waits for the connection: a
/// shutdown requested mid-wait ends the call at once as a typed stop (long
/// before its deadline), not as "connection busy" at the deadline. Without the
/// stop check in the acquisition loop this call waits for its 30 s deadline.
#[test]
fn participant_read_until_observes_a_stop_requested_while_it_waits() {
    let db = Arc::new(test_db());
    let (core, participant) = test_participant();
    let _holder = Holder::new(&db);
    let started = Instant::now();
    let stopper = thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        core.request_shutdown().expect("shutdown requested");
        core
    });
    let error = db
        .try_with_participant_read_transaction_until(
            &participant,
            budget(started + Duration::from_secs(30)),
            |_| Ok(()),
        )
        .expect_err("a stop requested mid-wait is an error, not connection-busy");
    let _core = stopper.join().expect("stopper joined");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the stop was not observed while waiting: {:?}",
        started.elapsed()
    );
    assert_eq!(
        termination_reason(error),
        crate::narrative_extraction::ValidationTerminationReason::Cancelled
    );
}

/// Segment 1 of the deadline (SQL): the SQL runs under the same deadline. An
/// endless statement is interrupted at the deadline as a typed `TimedOut`, the
/// transaction is rolled back and the connection stays usable.
#[test]
fn participant_read_until_interrupts_sql_at_the_deadline() {
    let db = test_db();
    let (_core, participant) = test_participant();
    let started = Instant::now();
    let wait = Duration::from_millis(150);
    let error = db
        .try_with_participant_read_transaction_until(&participant, budget(started + wait), |conn| {
            Ok(conn.query_row(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
                 SELECT count(*) FROM c",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect_err("an endless statement is stopped by the deadline");
    let elapsed = started.elapsed();
    assert_eq!(
        termination_reason(error),
        crate::narrative_extraction::ValidationTerminationReason::TimedOut
    );
    assert!(elapsed >= wait, "{elapsed:?}");
    assert!(elapsed < wait + Duration::from_millis(1500), "{elapsed:?}");
    assert!(db.connection_reusable());
    assert_eq!(
        db.try_with_participant_read_transaction_until(
            &participant,
            budget(Instant::now() + Duration::from_secs(5)),
            |conn| Ok(conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?),
        )
        .expect("usable again"),
        Some(1)
    );
}

/// DR-MPS-15 is kept: a maintenance worker in no-wait mode that holds the
/// connection while the calls run is not preempted at its next acquisition,
/// and no waiter is published.
#[test]
fn participant_read_until_does_not_preempt_a_maintenance_run() {
    let db = Arc::new(test_db());
    let (_core, participant) = test_participant();
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let maintenance_db = Arc::clone(&db);
    let maintenance = thread::spawn(move || {
        let _no_wait = maintenance_db.enter_maintenance_connection_no_wait();
        maintenance_db
            .with_conn(|_| {
                held_tx.send(()).expect("announce held");
                let _ = release_rx.recv();
                Ok(())
            })
            .expect("first acquisition");
        maintenance_db.with_conn(|_| Ok(()))
    });
    held_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("maintenance holds the connection");
    for _ in 0..5 {
        assert_eq!(
            db.try_with_participant_read_transaction_until(
                &participant,
                budget(Instant::now() + Duration::from_millis(20)),
                |_| Ok(()),
            )
            .expect("not an error"),
            None
        );
    }
    assert_eq!(db.foreground_connection_waiter_count(), 0);
    release_tx.send(()).expect("release");
    maintenance
        .join()
        .expect("maintenance thread joined")
        .expect("the maintenance run was not preempted");
}

fn started_event(execution_id: &str, event_id: &str) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: event_id.to_string(),
        execution_id: execution_id.to_string(),
        operation_id: "operation-1".into(),
        parent_execution_id: None,
        path_id: "semantic_search".into(),
        event_type: "execution.started".into(),
        timestamp: 1_700_000_000_000,
        payload: serde_json::json!({
            "captureState": "complete",
            "modelDispatched": false,
            "executionMode": "local-native",
        }),
    }
}

fn audit_rows(db: &Database) -> Vec<(String, String, String, String)> {
    db.read_ai_audit_snapshot_for_scope(None, None, None, None)
        .expect("snapshot")
        .events
        .into_iter()
        .map(|event| {
            (
                event.event_id,
                event.event_type,
                event.payload_sha256,
                event.path_id,
            )
        })
        .collect()
}

/// Equivalence: the deadline-bound append writes the same rows, in the same
/// order, as the existing append (same validation, same canonical payload
/// digest), and a re-append of the same event is idempotent (a terminal that
/// was deferred can be written again without a collision).
#[test]
fn audit_append_until_writes_what_the_existing_append_writes() {
    let existing = test_db();
    let bounded = test_db();
    let events = [started_event("execution-1", "event-1")];
    let left = existing
        .append_ai_audit_events_for_scope(None, &events)
        .expect("existing append");
    let right = bounded
        .try_append_ai_audit_events_for_scope_until(
            None,
            &events,
            Instant::now() + Duration::from_secs(5),
        )
        .expect("bounded append")
        .expect("connection available");
    assert_eq!(left.inserted_count, right.inserted_count);
    assert_eq!(left.tail_sequence, right.tail_sequence);
    assert_eq!(audit_rows(&existing), audit_rows(&bounded));
    let again = bounded
        .try_append_ai_audit_events_for_scope_until(
            None,
            &events,
            Instant::now() + Duration::from_secs(5),
        )
        .expect("idempotent re-append")
        .expect("connection available");
    assert_eq!(again.inserted_count, 0);
    assert_eq!(audit_rows(&bounded).len(), 1);
    // The reserved NIR-1 namespace stays refused by the same guard, before any
    // transaction opens.
    let mut reserved = started_event("execution-2", "event-2");
    reserved.path_id = crate::nir1_local_audit::NIR1_LOCAL_WRITING_PATH_ID.into();
    let error = bounded
        .try_append_ai_audit_events_for_scope_until(
            None,
            &[reserved],
            Instant::now() + Duration::from_secs(5),
        )
        .expect_err("the generic append refuses the reserved namespace");
    assert!(
        error.to_string().contains("AI_AUDIT_RESERVED_NAMESPACE"),
        "{error}"
    );
    assert_eq!(audit_rows(&bounded).len(), 1);
}

/// The audit append is bound by the deadline on both waits: a busy connection
/// is `None` (nothing written, no waiter), and a SQLite write lock held by
/// another connection ends at the (clipped) busy wait, far below the fixed 5 s
/// the existing append waits. Without the clip this test takes about 5 s.
#[test]
fn audit_append_until_is_bounded_by_the_deadline() {
    let db = Arc::new(test_db());
    let events = [started_event("execution-3", "event-3")];
    {
        let mut holder = Holder::new(&db);
        let started = Instant::now();
        let skipped = db
            .try_append_ai_audit_events_for_scope_until(
                None,
                &events,
                started + Duration::from_millis(100),
            )
            .expect("not an error");
        assert_eq!(skipped, None);
        assert!(started.elapsed() < Duration::from_millis(1500));
        assert_eq!(db.foreground_connection_waiter_count(), 0);
        holder.release();
    }
    assert!(audit_rows(&db).is_empty());

    let directory = std::env::temp_dir().join(format!("chat-ir-audit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("directory");
    let path = directory.join("workspace.db");
    let file_db = Database::new(&path).expect("file database");
    file_db.migrate().expect("migrate");
    let other = rusqlite::Connection::open(&path).expect("second connection");
    other
        .execute_batch("BEGIN IMMEDIATE")
        .expect("another writer holds the write lock");
    let started = Instant::now();
    let outcome = file_db.try_append_ai_audit_events_for_scope_until(
        None,
        &events,
        started + Duration::from_millis(300),
    );
    let elapsed = started.elapsed();
    assert!(
        outcome.is_err(),
        "a write lock held elsewhere is an error, not a silent skip"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "busy wait not clipped: {elapsed:?}"
    );
    other.execute_batch("ROLLBACK").expect("release");
    assert!(file_db.connection_reusable());
    let written = file_db
        .try_append_ai_audit_events_for_scope_until(
            None,
            &events,
            Instant::now() + Duration::from_secs(5),
        )
        .expect("not an error");
    assert!(written.is_some());
    std::fs::remove_dir_all(&directory).ok();
}
