//! DR-IRB-3 (stage 1): the dedicated read-only Chronicle reader. These cover
//! the authority admission, the reader open order, the prepare entry that
//! never reads the connection-bound epoch or proof, the single reader slot and
//! the close evidence. They are deterministic: no thread timing is involved.
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};

use rusqlite::Connection;

use super::{publish_chronicle_index_build, read_identity::ReadIdentity, test_support::Fixture, *};
use crate::{
    narrative_extraction::{sqlite_database_file_identity, ValidationTerminationReason},
    workspace_lifecycle::WorkspaceParticipant,
    Database,
};

fn participant() -> (crate::WorkspaceLifecycleCore, WorkspaceParticipant) {
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

fn admission_read(f: &Fixture) -> ChronicleReaderAdmissionRead {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    f.db.with_read_transaction(|conn| {
        f.runtime
            .chronicle_reader_admission(conn, f.project(), &mut control)
    })
    .expect("admission read")
}

fn admit(f: &Fixture) -> ChronicleReaderAdmission {
    match admission_read(f) {
        ChronicleReaderAdmissionRead::Admitted(admission) => admission,
        other => panic!("expected an admitted build: {other:?}"),
    }
}

fn on_reader<T>(
    f: &Fixture,
    admission: &ChronicleReaderAdmission,
    participant: &WorkspaceParticipant,
    operation: impl FnOnce(&mut Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let permit = f.runtime.try_acquire_reader_permit().expect("reader slot");
    f.runtime
        .with_chronicle_reader(permit, admission, participant, operation)
}

fn prepare_on_reader(
    f: &Fixture,
    admission: &ChronicleReaderAdmission,
    participant: &WorkspaceParticipant,
) -> anyhow::Result<NirIndexBuildRead> {
    on_reader(f, admission, participant, |conn| {
        let mut control = super::super::source_revision::ForegroundValidationControl;
        prepare_chronicle_index_build_on_reader(
            conn,
            &f.runtime,
            admission,
            f.project(),
            &mut control,
        )
    })
}

fn reason(error: &anyhow::Error) -> Option<NirIndexUnavailableReason> {
    chronicle_reader_error_reason(error)
}

fn termination(error: &anyhow::Error) -> ValidationTerminationReason {
    error
        .downcast_ref::<super::super::ValidationTerminated>()
        .unwrap_or_else(|| panic!("typed termination expected: {error:#}"))
        .reason
}

/// (c)(f) The reader's prepare equals the authority's, and its plan publishes
/// through the authority's own CAS.
#[test]
fn reader_prepare_equals_authority_prepare_and_publishes() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    assert!(admission.reader_available() && !admission.already_usable());
    let (authority_plan, authority_docs) = f.prepare();
    let NirIndexBuildRead::Ready { plan, documents } =
        prepare_on_reader(&f, &admission, &p).expect("reader prepare")
    else {
        panic!("reader prepare must be ready");
    };
    assert_eq!(
        format!("{:?}", plan.snapshot),
        format!("{:?}", authority_plan.snapshot)
    );
    assert_eq!(documents, authority_docs);
    assert_eq!(
        (&plan.project, plan.owner, plan.runtime_epoch),
        (
            &authority_plan.project,
            authority_plan.owner,
            authority_plan.runtime_epoch
        )
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 0, "slot given back");
    let published = publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(documents))
        .expect("reader plan publishes on the authority");
    assert!(matches!(
        published,
        NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        }
    ));
}

/// (c) A reader refuses writes; `SAVEPOINT`/`RELEASE` and the prepare path run;
/// the prepare entry refuses a connection that is not `query_only`.
#[test]
fn reader_is_read_only_and_prepare_refuses_a_writable_connection() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    let (writes_refused, savepoint_ok, query_only) = on_reader(&f, &admission, &p, |conn| {
        let refused = [
            "CREATE TABLE reader_write_probe(a)",
            "UPDATE projects SET title=title",
            "DELETE FROM projects",
            "CREATE TEMP TABLE reader_late_temp(a)",
        ]
        .iter()
        .map(|sql| conn.execute(sql, []).is_err())
        .collect::<Vec<_>>();
        let savepoint = conn.execute_batch("SAVEPOINT s; RELEASE s").is_ok();
        let query_only: i64 = conn.pragma_query_value(None, "query_only", |r| r.get(0))?;
        Ok((refused, savepoint, query_only))
    })
    .expect("reader scope");
    assert_eq!(writes_refused, [true, true, true, true]);
    assert!(savepoint_ok);
    assert_eq!(query_only, 1);
    let mut control = super::super::source_revision::ForegroundValidationControl;
    let error =
        f.db.with_read_transaction(|conn| {
            prepare_chronicle_index_build_on_reader(
                conn,
                &f.runtime,
                &admission,
                f.project(),
                &mut control,
            )
            .map(|_| ())
        })
        .expect_err("a writable connection is not a reader");
    assert!(error.to_string().contains("query_only"), "{error:#}");
    // `query_only` alone is not enough: the main database must be read-only.
    let error =
        f.db.with_read_transaction(|conn| {
            conn.execute_batch("PRAGMA query_only=ON")?;
            let result = prepare_chronicle_index_build_on_reader(
                conn,
                &f.runtime,
                &admission,
                f.project(),
                &mut control,
            )
            .map(|_| ());
            conn.execute_batch("PRAGMA query_only=OFF")?;
            result
        })
        .expect_err("a writable main database is not a reader");
    assert!(error.to_string().contains("read-only"), "{error:#}");
    // An admission made for one project is not a verdict for another.
    let error = on_reader(&f, &admission, &p, |conn| {
        let mut control = super::super::source_revision::ForegroundValidationControl;
        prepare_chronicle_index_build_on_reader(
            conn,
            &f.runtime,
            &admission,
            "another-project",
            &mut control,
        )
        .map(|_| ())
    })
    .expect_err("project mismatch");
    assert!(error.to_string().contains("project"), "{error:#}");
    assert!(f.db.connection_reusable());
}

/// (h) A reader prepare never touches the authority's proof or its caches.
#[test]
fn reader_prepare_leaves_the_authority_proof_untouched() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    let (plan, docs) = f.prepare();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish");
    let proof = f
        .runtime
        .lock()
        .expect("runtime")
        .proofs
        .get(f.project())
        .cloned()
        .expect("installed proof");
    let identity =
        f.db.with_read_transaction(|conn| Ok(ReadIdentity::read(conn)?.expect("identity")))
            .expect("identity");
    *proof.validated_read.lock().expect("cache") = Some(identity.clone());
    assert!(
        prepare_on_reader(&f, &admission, &p).is_ok(),
        "a reader prepare is an Ok verdict, whichever it is"
    );
    let after = f
        .runtime
        .lock()
        .expect("runtime")
        .proofs
        .get(f.project())
        .cloned()
        .expect("proof still installed");
    assert!(Arc::ptr_eq(&proof, &after));
    assert_eq!(*proof.validated_read.lock().expect("cache"), Some(identity));
    assert!(proof
        .validated_query_contexts
        .lock()
        .expect("contexts")
        .is_empty());
}

/// (m) A reader (`query_only`, read-only main) is never the authority's primary
/// connection: asking the runtime for its connection-bound epoch on one fails
/// closed with an error, never silently answers (DR-DBC-5, C5 #3).
#[test]
fn reader_open_order_and_the_epoch_of_a_foreign_connection() {
    let f = Fixture::new();
    let identity = sqlite_database_file_identity(f.path()).expect("identity");
    let reader = Database::open_chronicle_reader_at(f.path(), &identity).expect("reader");
    reader
        .with_conn(|conn| {
            let query_only: i64 = conn.pragma_query_value(None, "query_only", |r| r.get(0))?;
            assert_eq!(query_only, 1);
            let error = f
                .runtime
                .current_epoch(conn)
                .expect_err("a reader is not the authority connection");
            assert!(error
                .to_string()
                .contains("NIR1_RUNTIME_REQUIRES_THE_AUTHORITY_CONNECTION"));
            // The reader still reads the same write clock the authority does.
            let on_reader = crate::read_db_clock(conn)?;
            let on_authority = f.db.with_conn(crate::read_db_clock)?;
            assert_eq!(on_reader, on_authority);
            Ok(())
        })
        .expect("reader state");
    // A plain read-only connection (not even `query_only`) is refused too.
    let raw = Connection::open_with_flags(
        f.path(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("raw read-only");
    assert!(f.runtime.current_epoch(&raw).is_err());
    // The authority's own connection is bound to this runtime.
    f.db.with_conn(|conn| {
        assert_eq!(f.runtime.current_epoch(conn)?.map(|_| ()), Ok(()));
        Ok(())
    })
    .expect("authority connection");
}

/// (m') A replaced database (another lineage) is not the one the runtime is bound to.
#[test]
fn a_new_lineage_is_refused_with_the_lineage_reason() {
    let f = Fixture::new();
    f.db.with_conn(|conn| {
        assert!(f.runtime.current_epoch(conn)?.is_ok());
        crate::write_clock::rotate_db_lineage(conn)?;
        assert_eq!(
            f.runtime.current_epoch(conn)?,
            Err(NirIndexUnavailableReason::DatabaseLineageChanged)
        );
        Ok(())
    })
    .expect("lineage binding");
}

/// (n) Admission runs inside the authority's read transaction without
/// re-entering the connection mutex that transaction holds, and names the
/// authority's exact file.
#[test]
fn admission_runs_in_the_authority_transaction_and_names_its_file() {
    let f = Fixture::new();
    let admission = admit(&f);
    let ChronicleReaderTarget::File { path, identity } = &admission.target else {
        panic!("a file database is readable");
    };
    assert_eq!(
        path,
        &std::fs::canonicalize(f.path()).expect("canonical path")
    );
    assert_eq!(
        identity,
        &sqlite_database_file_identity(f.path()).expect("identity")
    );
    assert_eq!(admission.runtime_epoch, 1);
}

/// (n) An in-memory database cannot be read by a second connection: a typed
/// mark and a typed error, never a silent fallback or a lost reservation.
#[test]
fn admission_marks_an_in_memory_database_and_the_reader_refuses_it() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("memory db");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute("INSERT INTO projects (id, title) VALUES ('p', 'P')", [])?;
        Ok(())
    })
    .expect("project");
    let runtime = NirChronicleIndexRuntime::new(&db, 1);
    let mut control = super::super::source_revision::ForegroundValidationControl;
    let read = db
        .with_read_transaction(|conn| runtime.chronicle_reader_admission(conn, "p", &mut control))
        .expect("admission");
    let ChronicleReaderAdmissionRead::Admitted(admission) = read else {
        panic!("a project without an index is admitted");
    };
    assert!(!admission.reader_available());
    let (_core, p) = participant();
    let permit = runtime.try_acquire_reader_permit().expect("slot");
    let error = runtime
        .with_chronicle_reader(permit, &admission, &p, |_| Ok(()))
        .expect_err("no reader for a memory database");
    assert_eq!(
        reason(&error),
        Some(NirIndexUnavailableReason::ReaderUnavailableForMemoryDatabase)
    );
    assert_eq!(runtime.live_chronicle_readers(), 0, "nothing was opened");
}

#[test]
fn admission_keeps_the_rebuild_requested_verdicts() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let before =
        f.db.with_read_transaction(|conn| f.runtime.rebuild_requested(conn, f.project()))
            .expect("hint");
    assert_eq!(before, Some(true));
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish");
    assert!(matches!(
        admission_read(&f),
        ChronicleReaderAdmissionRead::Idle
    ));
    f.runtime.stop().expect("stop");
    assert!(matches!(
        admission_read(&f),
        ChronicleReaderAdmissionRead::Stopped
    ));
}

/// The usable-proof verdict lives in the admission: no reader is needed.
#[test]
fn admission_records_a_current_proof_and_prepare_reports_it() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let (plan, docs) = f.prepare();
    let mut admission = admit(&f);
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish");
    admission.proof_current = true;
    assert!(admission.already_usable());
    assert!(matches!(
        prepare_on_reader(&f, &admission, &p).expect("prepare"),
        NirIndexBuildRead::AlreadyUsable
    ));
}

/// E13 slot: one per authority. Until a reader is open, dropping the permit
/// (an early return, an error, an unwind) gives the slot back.
#[test]
fn reader_slot_is_single_and_a_permit_dropped_before_open_gives_it_back() {
    let f = Fixture::new();
    let first = f.runtime.try_acquire_reader_permit().expect("first");
    assert!(f.runtime.try_acquire_reader_permit().is_none());
    assert_eq!(f.runtime.live_chronicle_readers(), 1);
    assert!(
        !f.runtime.chronicle_reader_slot_blocked(),
        "in use is not blocked"
    );
    first.release_unused();
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
    drop(f.runtime.try_acquire_reader_permit().expect("again"));
    assert_eq!(f.runtime.live_chronicle_readers(), 0, "drop gives it back");
    let unwound = catch_unwind(AssertUnwindSafe(|| {
        let _permit = f.runtime.try_acquire_reader_permit().expect("permit");
        panic!("between permit and open");
    }));
    assert!(unwound.is_err());
    assert_eq!(
        f.runtime.live_chronicle_readers(),
        0,
        "unwind gives it back"
    );
}

/// E5/E8: without close evidence the slot stays taken and the error is typed.
#[test]
fn unproven_close_keeps_the_slot_and_is_typed() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    crate::narrative_maintenance_connection::set_chronicle_reader_close_failpoint_for_test(true);
    let error = on_reader(&f, &admission, &p, |_| Ok(()))
        .expect_err("close evidence is required even for an Ok operation");
    crate::narrative_maintenance_connection::set_chronicle_reader_close_failpoint_for_test(false);
    assert_eq!(
        reason(&error),
        Some(NirIndexUnavailableReason::ReaderCloseUnproven)
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 1);
    assert!(f.runtime.try_acquire_reader_permit().is_none());
    assert!(
        f.runtime.chronicle_reader_slot_blocked(),
        "an unproven close is told apart from a slot in use"
    );
    assert!(f.db.connection_reusable(), "the authority is untouched");
}

/// E8 (a), P3-1: a panic before the close verdict leaves the slot unconsumed.
/// The slot stays taken and is marked blocked (not merely "in use"), so the
/// caller stops instead of retrying.
#[test]
fn panic_before_the_close_verdict_blocks_the_slot_for_good() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    crate::narrative_maintenance_connection::set_chronicle_reader_close_panic_failpoint_for_test(
        true,
    );
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _ = on_reader(&f, &admission, &p, |_| Ok(()));
    }));
    crate::narrative_maintenance_connection::set_chronicle_reader_close_panic_failpoint_for_test(
        false,
    );
    assert!(panic.is_err(), "the panic propagates");
    assert_eq!(f.runtime.live_chronicle_readers(), 1, "slot kept");
    assert!(
        f.runtime.chronicle_reader_slot_blocked(),
        "an unjudged close is blocked, not 'in use'"
    );
    assert!(f.runtime.try_acquire_reader_permit().is_none());
    assert!(f.db.connection_reusable(), "the authority is untouched");
}

/// E8 (a), P3-1: a panic while the connection is being opened (where the
/// connection's own `Drop` would swallow a failed close) also blocks the slot.
#[test]
fn panic_during_the_reader_open_blocks_the_slot_for_good() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    crate::narrative_maintenance_connection::set_chronicle_reader_open_panic_failpoint_for_test(
        true,
    );
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _ = on_reader(&f, &admission, &p, |_| Ok(()));
    }));
    crate::narrative_maintenance_connection::set_chronicle_reader_open_panic_failpoint_for_test(
        false,
    );
    assert!(panic.is_err(), "the panic propagates");
    assert!(f.runtime.chronicle_reader_slot_blocked());
    assert!(f.runtime.try_acquire_reader_permit().is_none());
    assert!(f.db.connection_reusable());
}

/// Counterpart of the two above: a clean reader gives the slot back and does
/// not mark it blocked.
#[test]
fn a_clean_reader_does_not_block_the_slot() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    on_reader(&f, &admission, &p, |_| Ok(())).expect("clean reader");
    assert!(!f.runtime.chronicle_reader_slot_blocked());
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
}

/// P3-5 (ii): the reader's snapshot is taken first; when the authority commits
/// afterwards (a human `held` decision here), publishing that plan is `Stale`.
/// The reader itself saw the older, consistent snapshot.
#[test]
fn authority_commit_after_the_reader_snapshot_makes_the_plan_stale() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    let NirIndexBuildRead::Ready { plan, documents } =
        prepare_on_reader(&f, &admission, &p).expect("reader prepare")
    else {
        panic!("reader prepare must be ready");
    };
    let revision = documents[0].revision_id.clone();
    let outcomes = f.outcomes(documents);
    f.hold(&revision);
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).expect("stale publish"),
        NirIndexPublishRead::Stale
    ));
    assert_eq!(f.published_count(), 0, "nothing was published");
    // A reader opened after the commit sees the new state and publishes.
    let admission = admit(&f);
    let NirIndexBuildRead::Ready { plan, documents } =
        prepare_on_reader(&f, &admission, &p).expect("fresh reader prepare")
    else {
        panic!("fresh reader prepare must be ready");
    };
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(documents))
            .expect("fresh publish"),
        NirIndexPublishRead::Published { .. }
    ));
}

/// (j) A reader on another file than the admitted one is refused and closed.
#[test]
fn reader_refuses_a_different_file_identity() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let mut admission = admit(&f);
    admission.target = ChronicleReaderTarget::File {
        path: f.path().to_path_buf(),
        identity: "dev:0:ino:0".into(),
    };
    let error = on_reader(&f, &admission, &p, |_| Ok(())).expect_err("identity mismatch");
    assert_eq!(
        reason(&error),
        Some(NirIndexUnavailableReason::ReaderIdentityMismatch)
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 0, "closed, slot back");
}

#[test]
fn open_failure_is_typed_and_gives_the_slot_back() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let mut admission = admit(&f);
    admission.target = ChronicleReaderTarget::File {
        path: f.path().with_extension("missing"),
        identity: "x".into(),
    };
    let error = on_reader(&f, &admission, &p, |_| Ok(())).expect_err("no such file");
    assert_eq!(
        reason(&error),
        Some(NirIndexUnavailableReason::ReaderOpenFailed)
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
}

/// An admission from another runtime is refused before anything opens.
#[test]
fn admission_of_another_runtime_is_refused() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let mut admission = admit(&f);
    admission.owner += 1;
    assert!(on_reader(&f, &admission, &p, |_| Ok(())).is_err());
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
}

/// (s) A panic inside the operation closes the reader, gives the slot back and
/// leaves the authority reusable.
#[test]
fn panic_in_the_operation_closes_the_reader_and_frees_the_slot() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _ = on_reader::<()>(&f, &admission, &p, |_| panic!("reader operation panic"));
    }))
    .expect_err("the panic propagates");
    assert_eq!(
        panic.downcast_ref::<&str>(),
        Some(&"reader operation panic")
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
    assert!(f.db.connection_reusable());
    assert!(
        on_reader(&f, &admission, &p, |_| Ok(())).is_ok(),
        "reusable"
    );
}

/// Stop and epoch changes end the reader as typed terminations and close it.
#[test]
fn stop_and_epoch_change_terminate_the_reader_typed_and_closed() {
    let f = Fixture::new();
    let admission = admit(&f);

    let (core, p) = participant();
    core.request_shutdown().expect("shutdown");
    let error = on_reader(&f, &admission, &p, |_| Ok(())).expect_err("stopped participant");
    assert_eq!(termination(&error), ValidationTerminationReason::Cancelled);
    assert_eq!(reason(&error), None, "a termination is not a reader reason");
    assert_eq!(f.runtime.live_chronicle_readers(), 0);

    let (_core, p) = participant();
    f.runtime.pause().expect("pause rotates the epoch");
    let error = on_reader(&f, &admission, &p, |_| Ok(())).expect_err("epoch changed");
    assert_eq!(
        termination(&error),
        ValidationTerminationReason::WorkspaceGenerationChanged
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
}

#[test]
fn raw_busy_inside_the_reader_maps_to_reader_busy() {
    let busy = anyhow::Error::new(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
        None,
    ));
    assert_eq!(reason(&busy), Some(NirIndexUnavailableReason::ReaderBusy));
    assert_eq!(reason(&anyhow::anyhow!("other")), None);
}

/// The admission's proof verdict is computed, not assumed: with the hint true
/// and a proof the runtime still holds as current, the admission says so.
#[test]
fn admission_computes_the_current_proof_verdict() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish");
    // No proof of this state is current yet after a change the hint sees: the
    // generation moves, so the hint is true and a full check rejects the proof.
    f.db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_semantic_index_metadata SET generation=generation+1 WHERE project_id=?1",
            [f.project()],
        )?;
        Ok(())
    })
    .expect("generation moves");
    let ChronicleReaderAdmissionRead::Admitted(rejected) = admission_read(&f) else {
        panic!("the hint is true after the change");
    };
    assert!(!rejected.already_usable(), "a stale proof is not usable");
    // The verdict is the runtime's own: a proof validated for exactly this
    // committed state (its read identity) is current although the hint is true.
    let proof = f
        .runtime
        .lock()
        .expect("runtime")
        .proofs
        .get(f.project())
        .cloned()
        .expect("proof");
    let identity =
        f.db.with_read_transaction(|conn| Ok(ReadIdentity::read(conn)?.expect("identity")))
            .expect("identity");
    *proof.validated_read.lock().expect("cache") = Some(identity);
    let ChronicleReaderAdmissionRead::Admitted(current) = admission_read(&f) else {
        panic!("the hint is still true");
    };
    assert!(current.already_usable());
}

/// A runtime pause while the reader's statement is running is seen by the
/// progress hook, not only at the next check.
#[test]
fn a_runtime_pause_interrupts_a_running_reader_statement() {
    let f = Fixture::new();
    let (_core, p) = participant();
    let admission = admit(&f);
    let error = on_reader(&f, &admission, &p, |conn| {
        f.runtime.pause().expect("pause rotates the epoch");
        Ok(conn.query_row(
            "WITH RECURSIVE walk(value) AS (
                SELECT 1 UNION ALL SELECT value + 1 FROM walk WHERE value < 10000000
             ) SELECT sum(value) FROM walk",
            [],
            |row| row.get::<_, i64>(0),
        )?)
    })
    .expect_err("the pause must interrupt the statement");
    assert_eq!(
        termination(&error),
        ValidationTerminationReason::WorkspaceGenerationChanged
    );
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
}

/// E7: 待つ側の上限を試験で縮めた値。
const SHORT_BOUND: std::time::Duration = std::time::Duration::from_millis(60);

/// E7 (p'): stop を無視して止まらない reader。待つ側は上限（試験では短縮）で
/// 先に進み、reader の participant は count から外れ、slot は塞がり、
/// authority の transition は physical exclusive まで完了できる。
/// reader が遅れて終わっても slot は戻らず、participant は二重に減らない。
#[test]
fn a_reader_that_ignores_stop_is_forced_at_the_bound_and_its_slot_is_blocked() {
    let f = Fixture::new();
    let (core, p) = participant();
    let admission = admit(&f);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    std::thread::scope(|scope| {
        let (fr, ar, pr) = (&f, &admission, &p);
        let reader = scope.spawn(move || {
            on_reader(fr, ar, pr, |_| {
                entered_tx.send(()).expect("entered");
                // stop を見ずに寝る（試験用）。
                let _ = release_rx.recv_timeout(std::time::Duration::from_secs(30));
                Ok(())
            })
        });
        entered_rx.recv().expect("reader entered");
        assert_eq!(core.workspace_participant_count().expect("count"), 1);
        assert_eq!(f.runtime.live_chronicle_readers(), 1);

        let ticket = match core
            .begin_transition(crate::AdmissionKind::Open)
            .expect("Open admission")
        {
            crate::AdmissionOutcome::Admitted(ticket) => ticket,
            crate::AdmissionOutcome::NotAdmitted { .. } => panic!("Open admitted"),
        };
        assert!(
            matches!(
                core.physical_exclusive_for_ticket(&ticket),
                Err(crate::LifecycleError::ActiveOperations)
            ),
            "before the bound the live reader's participant still blocks the exclusive"
        );

        // 上限の前は何も強制しない。
        let wait = crate::ReaderStopBoundedWait::with_bound(&core, SHORT_BOUND);
        assert_eq!(wait.poll(), 0, "not forced before the bound");
        assert_eq!(core.workspace_participant_count().expect("count"), 1);
        assert!(!f.runtime.chronicle_reader_slot_blocked());

        // 上限を過ぎたら一度だけ強制する。
        std::thread::sleep(SHORT_BOUND * 2);
        assert_eq!(wait.poll(), 1, "the reader is forced once at the bound");
        assert_eq!(wait.poll(), 0, "and not again");
        assert_eq!(core.workspace_participant_count().expect("count"), 0);
        assert!(f.runtime.chronicle_reader_slot_blocked());
        assert!(f.runtime.try_acquire_reader_permit().is_none());

        // 順序：participant が外れた後で、同じ lifecycle lock の下で exclusive が通る。
        let exclusive = core
            .physical_exclusive_for_ticket(&ticket)
            .expect("the transition reaches its physical exclusive");
        drop(exclusive);

        // reader が遅れて終わる。stop 済みなので typed な停止で、close は証明される
        // が slot は戻らない。
        release_tx.send(()).expect("release the reader");
        let late = reader.join().expect("reader thread").expect_err("stopped");
        assert_eq!(termination(&late), ValidationTerminationReason::Cancelled);
    });
    assert!(f.runtime.chronicle_reader_slot_blocked());
    assert!(
        f.runtime.try_acquire_reader_permit().is_none(),
        "never given back"
    );
    assert_eq!(
        f.runtime.live_chronicle_readers(),
        1,
        "the slot stays taken"
    );
    drop(p);
    assert_eq!(
        core.workspace_participant_count().expect("count"),
        0,
        "the late drop of the participant does not count twice"
    );
    assert!(f.db.connection_reusable(), "the authority is untouched");
}

/// E7: 通常は上限に達しない。reader が上限より前に終われば slot は戻り、
/// 上限を過ぎた poll も何も強制しない。reader でない participant は強制されない。
#[test]
fn a_reader_that_stops_in_time_is_not_forced_and_a_plain_participant_is_never_forced() {
    let f = Fixture::new();
    let (core, p) = participant();
    let admission = admit(&f);
    on_reader(&f, &admission, &p, |_| Ok(())).expect("clean reader");
    assert_eq!(f.runtime.live_chronicle_readers(), 0);
    assert!(!f.runtime.chronicle_reader_slot_blocked());

    // reader の scope が終われば registration は無い。participant は残る。
    let wait = crate::ReaderStopBoundedWait::with_bound(&core, std::time::Duration::ZERO);
    assert_eq!(wait.poll(), 0, "no reader is open: nothing to force");
    assert_eq!(
        core.workspace_participant_count().expect("count"),
        1,
        "a participant that is not a reader is awaited, never forced"
    );
    assert!(!f.runtime.chronicle_reader_slot_blocked());
    drop(f.runtime.try_acquire_reader_permit().expect("slot is free"));
}

/// E7 (P3-1): a force that lands after the scope's last check (commit／close)
/// must not let an `Ok` plan go on as a counted-out participant. The result is
/// read as a typed `Cancelled`, the slot is blocked, the participant is out.
#[test]
fn a_force_after_the_scope_returned_turns_an_ok_into_cancelled() {
    let f = Fixture::new();
    let (core, p) = participant();
    let admission = admit(&f);
    let wait = crate::ReaderStopBoundedWait::with_bound(&core, std::time::Duration::ZERO);
    runtime::AFTER_READER_SCOPE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            assert_eq!(wait.poll(), 1, "the hold is still registered here");
        }));
    });
    let error = on_reader(&f, &admission, &p, |_| Ok(7))
        .expect_err("a forced reader never returns Ok to its caller");
    assert_eq!(termination(&error), ValidationTerminationReason::Cancelled);
    assert_eq!(core.workspace_participant_count().expect("count"), 0);
    assert!(f.runtime.chronicle_reader_slot_blocked());
    assert!(f.runtime.try_acquire_reader_permit().is_none());
}

/// E7 (P3-3): a forced reader's participant leaves the count, but a second,
/// unrelated participant stays counted, so the waiting side still waits for it.
#[test]
fn another_participant_stays_counted_while_a_reader_is_forced() {
    let f = Fixture::new();
    let (core, p) = participant();
    let other = core
        .begin_workspace_participant()
        .expect("other participant");
    let admission = admit(&f);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    std::thread::scope(|scope| {
        let (fr, ar, pr) = (&f, &admission, &p);
        let reader = scope.spawn(move || {
            on_reader(fr, ar, pr, |_| {
                entered_tx.send(()).expect("entered");
                let _ = release_rx.recv_timeout(std::time::Duration::from_secs(30));
                Ok(())
            })
        });
        entered_rx.recv().expect("reader entered");
        assert_eq!(core.workspace_participant_count().expect("count"), 2);
        let wait = crate::ReaderStopBoundedWait::with_bound(&core, std::time::Duration::ZERO);
        assert_eq!(wait.poll(), 1);
        assert_eq!(
            core.workspace_participant_count().expect("count"),
            1,
            "only the reader's participant is counted out"
        );
        release_tx.send(()).expect("release");
        assert!(reader.join().expect("reader thread").is_err());
    });
    assert_eq!(core.workspace_participant_count().expect("count"), 1);
    drop(other);
    assert_eq!(core.workspace_participant_count().expect("count"), 0);
}
