//! DR-CP4-V-6: the complete proof check may be skipped across a commit only
//! when the commit is a generic AI-audit append. These tests fix the premises
//! (the append writes only `ai_audit_events`; the complete check and the query
//! context never read audit rows) and the rule itself.
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

use super::super::{
    publish_chronicle_index_build, read_identity::ReadIdentity, test_support::Fixture,
    NirIndexPublishRead,
};
use super::*;
use crate::ai_audit::AppendAiAuditEvent;
use crate::narrative_extraction::nir1_capacity::project_read_probe::{self, Read};
use crate::Database;

fn published() -> Fixture {
    let f = Fixture::new();
    f.runtime
        .bind_embedding_generation(1)
        .expect("bind the actual generation");
    let (plan, docs) = f.prepare();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish"),
        NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        }
    ));
    f
}

fn scene(f: &Fixture) -> String {
    f.manifest["s2"].as_str().expect("S2").to_owned()
}

fn snapshot(f: &Fixture) -> NirQuerySnapshot {
    let scene = scene(f);
    f.db.with_read_transaction(|conn| {
        let NirQueryStatusRead::Available {
            snapshot: Some(snapshot),
            ..
        } = read_chronicle_query_status(conn, &f.runtime, f.project(), &scene)?
        else {
            panic!("usable first snapshot")
        };
        Ok(snapshot)
    })
    .expect("capture original query")
}

fn validate(
    conn: &mut Connection,
    f: &Fixture,
    snapshot: &NirQuerySnapshot,
) -> Option<Arc<RetrievalQueryContext>> {
    let mut control = super::super::super::source_revision::ForegroundValidationControl;
    validate_binding_with_control(
        conn,
        &f.runtime,
        snapshot.owner,
        &snapshot.proof,
        &snapshot.query,
        &mut control,
    )
    .expect("validation")
}

fn forget(snapshot: &NirQuerySnapshot) {
    *snapshot.proof.validated_read.lock().expect("proof cache") = None;
    snapshot
        .proof
        .validated_query_contexts
        .lock()
        .expect("context cache")
        .clear();
}

/// A generic local-inference audit row, as the query embedding appends.
pub(super) fn audit_event() -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        execution_id: uuid::Uuid::new_v4().to_string(),
        operation_id: uuid::Uuid::new_v4().to_string(),
        parent_execution_id: None,
        path_id: "semantic_search".into(),
        event_type: "execution.started".into(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        payload: serde_json::json!({
            "captureState": "complete",
            "modelDispatched": false,
            "executionMode": "local-native",
        }),
    }
}

/// The write clock and the lineage are the commit's own bookkeeping, not the
/// domain tables an audit append writes: the clock's AFTER INSERT trigger on
/// `ai_audit_events` advances `grimodex_write_clock` in the same commit (DR-DBC-3).
/// The premise "an append writes only audit rows" is about domain tables, so the
/// bookkeeping is removed from the comparison (the clock's own behaviour is fixed by
/// `clock_audit_append_advances_only_the_global_and_append_keys`). PR-2 moves this
/// premise onto the clock sequence.
fn without_clock_bookkeeping(mut written: BTreeSet<String>) -> BTreeSet<String> {
    written.remove("grimodex_write_clock");
    written.remove("grimodex_db_lineage");
    written
}

fn recording_tables<T>(
    conn: &mut Connection,
    reads: bool,
    body: impl FnOnce(&mut Connection) -> T,
) -> (T, BTreeSet<String>) {
    let seen = Arc::new(Mutex::new(BTreeSet::new()));
    let sink = Arc::clone(&seen);
    conn.flush_prepared_statement_cache();
    conn.authorizer(Some(move |context: AuthContext<'_>| {
        let table = match context.action {
            AuthAction::Read { table_name, .. } if reads => Some(table_name),
            AuthAction::Insert { table_name }
            | AuthAction::Update { table_name, .. }
            | AuthAction::Delete { table_name }
                if !reads =>
            {
                Some(table_name)
            }
            _ => None,
        };
        if let Some(table) = table {
            sink.lock().expect("tables").insert(table.to_owned());
        }
        Authorization::Allow
    }))
    .expect("install recorder");
    let value = body(conn);
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .expect("remove recorder");
    conn.flush_prepared_statement_cache();
    let tables = seen.lock().expect("tables").clone();
    (value, tables)
}

#[test]
fn nir1_premise_generic_audit_append_writes_only_audit_rows() {
    let f = published();
    let (result, written) =
        f.db.with_conn_mut(|conn| {
            Ok(recording_tables(conn, false, |conn| {
                crate::ai_audit::append_ai_audit_events_for_scope(
                    conn,
                    Some(f.project()),
                    &[audit_event()],
                )
            }))
        })
        .expect("append");
    assert_eq!(result.expect("generic append").inserted_count, 1);
    // The write authorizer does not report SQLite's own AUTOINCREMENT write
    // to `sqlite_sequence`; that table is covered by the read-side premise
    // tests (the complete check, the status read and qualify never read it).
    assert_eq!(
        without_clock_bookkeeping(written),
        BTreeSet::from(["ai_audit_events".to_owned()]),
        "the append writes no other table"
    );
}

#[test]
fn nir1_premise_complete_check_and_query_context_never_read_audit_rows() {
    let f = published();
    crate::ai_audit::append_ai_audit_events_for_scope(
        &f.db.lock().expect("conn"),
        Some(f.project()),
        &[audit_event()],
    )
    .expect("an audit row exists");
    let snapshot = snapshot(&f);
    forget(&snapshot);
    let (context, read) =
        f.db.with_read_transaction(|conn| {
            Ok(recording_tables(conn, true, |conn| {
                validate(conn, &f, &snapshot)
            }))
        })
        .expect("complete check");
    assert!(context.is_some(), "the complete check accepts the proof");
    // The recorder saw the complete check's branches: the roster, the edges,
    // the Scope authority (tree) and the sealed Run corpus.
    for table in [
        "narrative_proposals",
        "narrative_dependency_edges",
        "tree_nodes",
        "narrative_extraction_artifacts",
    ] {
        assert!(read.contains(table), "{table} not read: {read:?}");
    }
    for audit in ["ai_audit_events", "sqlite_sequence"] {
        assert!(
            !read.contains(audit),
            "{audit} is read by the check: {read:?}"
        );
    }
}

type Context = Arc<RetrievalQueryContext>;

fn same(a: &Option<Context>, b: &Option<Context>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if Arc::ptr_eq(a, b))
}

/// One Read transaction's validation on `db`, with the Scope-authority reads
/// of the complete check (and of a fresh query context) counted.
fn read_on(db: &Database, f: &Fixture, snapshot: &NirQuerySnapshot) -> (Option<Context>, usize) {
    let (context, reads) = project_read_probe::recording(|| {
        db.with_read_transaction(|conn| Ok(validate(conn, f, snapshot)))
            .expect("read")
    });
    (
        context,
        reads.get(&Read::AuthorityTree).copied().unwrap_or(0),
    )
}

fn read(f: &Fixture, snapshot: &NirQuerySnapshot) -> (Option<Context>, usize) {
    read_on(&f.db, f, snapshot)
}

fn append(f: &Fixture) {
    f.db.append_ai_audit_events_for_scope(Some(f.project()), &[audit_event()])
        .expect("generic audit append");
}

fn write(f: &Fixture, sql: &str) {
    f.db.with_conn(|conn| {
        conn.execute_batch(sql)?;
        Ok(())
    })
    .expect("write");
}

fn identity(f: &Fixture) -> ReadIdentity {
    f.db.with_read_transaction(|conn| Ok(ReadIdentity::read(conn)?.expect("Read state")))
        .expect("identity")
}

/// A validated proof (complete check once, then its verdict kept) and a table
/// no authority reads.
fn validated(f: &Fixture) -> (NirQuerySnapshot, Option<Context>) {
    write(
        f,
        "CREATE TABLE IF NOT EXISTS inv_unrelated_rows (value INTEGER)",
    );
    // A table created after migration needs its clock trigger (the migration invariant
    // installs it for real tables), or its writes would not move the identity.
    crate::write_clock::cover_adhoc_tables_for_test(&f.db).expect("cover the test table");
    // The status read validates the proof and keeps its query context.
    let snapshot = snapshot(f);
    let (first, reads) = read(f, &snapshot);
    assert!(first.is_some(), "the original query is current");
    assert_eq!(reads, 0, "the status read's context is reused");
    let (again, reads) = read(f, &snapshot);
    assert!(same(&first, &again) && reads == 0, "same state reuses");
    (snapshot, first)
}

#[test]
fn nir1_audit_only_commits_keep_the_validated_proof_and_its_query_context() {
    let f = published();
    let (snapshot, first) = validated(&f);
    // The query embedding appends twice between begin and qualify.
    append(&f);
    append(&f);
    let (after, reads) = read(&f, &snapshot);
    assert!(after.is_some());
    assert_eq!(reads, 0, "no complete check and no fresh query context");
    assert!(
        same(&first, &after),
        "the kept context moves to the new state"
    );
    assert_eq!(
        snapshot
            .proof
            .validated_read
            .lock()
            .expect("proof cache")
            .clone(),
        Some(identity(&f)),
        "the verdict now names the current state"
    );
    // A later audit-only commit continues from there.
    append(&f);
    let (later, reads) = read(&f, &snapshot);
    assert!(same(&first, &later) && reads == 0);
}

#[test]
fn nir1_audit_only_inheritance_never_covers_another_write_of_this_connection() {
    for audit_first in [true, false] {
        let f = published();
        let (snapshot, first) = validated(&f);
        if audit_first {
            append(&f);
            write(&f, "INSERT INTO inv_unrelated_rows VALUES (1)");
        } else {
            write(&f, "INSERT INTO inv_unrelated_rows VALUES (1)");
            append(&f);
        }
        let (after, reads) = read(&f, &snapshot);
        assert!(reads > 0, "complete check (audit first: {audit_first})");
        assert!(after.is_some() && !same(&first, &after));
    }
}

#[test]
fn nir1_a_write_between_two_audit_appends_restarts_the_audit_only_states() {
    let f = published();
    let (snapshot, first) = validated(&f);
    append(&f);
    // Inherited: the verdict now names the state after this append.
    let (inherited, reads) = read(&f, &snapshot);
    assert!(same(&first, &inherited) && reads == 0);
    write(&f, "INSERT INTO inv_unrelated_rows VALUES (3)");
    append(&f);
    let (after, reads) = read(&f, &snapshot);
    assert!(after.is_some() && !same(&first, &after));
    assert!(
        reads > 0,
        "the write between the appends is never inherited"
    );
}

#[test]
fn nir1_audit_only_inheritance_never_covers_another_commit_or_schema() {
    for case in ["other-before", "other-after", "schema"] {
        let f = published();
        let (snapshot, first) = validated(&f);
        let other = || {
            let other = Database::new(f.path()).expect("second connection");
            other
                .with_conn(|conn| {
                    conn.execute_batch("INSERT INTO inv_unrelated_rows VALUES (2)")?;
                    Ok(())
                })
                .expect("other commit");
        };
        match case {
            "other-before" => {
                other();
                append(&f);
            }
            "other-after" => {
                append(&f);
                other();
            }
            _ => {
                append(&f);
                write(&f, "CREATE TABLE inv_schema_change (value INTEGER)");
            }
        }
        let (after, reads) = read(&f, &snapshot);
        assert!(after.is_some() && !same(&first, &after));
        assert!(reads > 0, "complete check after {case}");
    }
}

#[test]
fn nir1_rolled_back_audit_append_is_not_an_audit_only_commit() {
    let f = published();
    let (snapshot, first) = validated(&f);
    let committed = f.db.with_conn(crate::read_db_clock).expect("clock").seq;
    let mut invalid = audit_event();
    invalid.event_id = " ".into();
    // The first row is inserted, the second fails validation: the whole
    // append rolls back. The write clock rolls back with it (DR-DBC-5), so the
    // committed state is exactly the validated one and its verdict stays valid;
    // the failed append records nothing as an audit-only commit.
    assert!(f
        .db
        .append_ai_audit_events_for_scope(Some(f.project()), &[audit_event(), invalid])
        .is_err());
    assert_eq!(
        f.db.with_conn(crate::read_db_clock).expect("clock").seq,
        committed
    );
    let (after, reads) = read(&f, &snapshot);
    assert!(
        same(&first, &after) && reads == 0,
        "the unchanged state reuses its verdict"
    );
    // A real append afterwards is joined by the audit-only list as usual.
    append(&f);
    let (after, reads) = read(&f, &snapshot);
    assert!(after.is_some() && reads == 0);
}

#[test]
fn nir1_audit_after_a_freshness_change_still_sees_the_change() {
    let f = published();
    let (snapshot, _) = validated(&f);
    write(
        &f,
        &format!(
            "UPDATE narrative_consumer_freshness SET evidence_freshness='stale'
              WHERE project_id='{}' AND consumer_kind='semantic-index'",
            f.project()
        ),
    );
    append(&f);
    append(&f);
    let (after, _) = read(&f, &snapshot);
    assert!(after.is_none(), "the stale index is not current");
}

#[test]
fn nir1_audit_only_inheritance_ends_with_the_lineage_and_the_runtime_epoch() {
    // A replaced database (a restore, a shadow migration or a handoff mints a new
    // lineage) is not the one the runtime is bound to: the proof is not current
    // there at all, whatever the audit-only states of the old lineage are.
    let f = published();
    let (snapshot, _) = validated(&f);
    append(&f);
    f.db.with_conn(|conn| crate::write_clock::rotate_db_lineage(conn).map(drop))
        .expect("a new lineage");
    let (after, _) = read(&f, &snapshot);
    assert!(after.is_none(), "a new lineage never inherits");
    // A runtime epoch change is checked outside the inheritance.
    let f = published();
    let (snapshot, _) = validated(&f);
    append(&f);
    f.runtime
        .bind_embedding_generation(2)
        .expect("new generation");
    let (after, _) = read(&f, &snapshot);
    assert!(after.is_none(), "the runtime epoch moved");
}

#[test]
fn nir1_audit_only_inheritance_keeps_the_batch_identical_to_a_complete_check() {
    let f = published();
    let (snapshot, _) = validated(&f);
    let qualify = |f: &Fixture| {
        f.db.with_read_transaction(|conn| {
            let NirQualifiedRead::Qualified(batch) =
                qualify_chronicle_index_snapshot(conn, &f.runtime, &snapshot)?
            else {
                panic!("qualified");
            };
            Ok(batch)
        })
        .expect("qualify")
    };
    let shape = |batch: &NirQualifiedBatch| {
        batch
            .documents()
            .iter()
            .map(|document| {
                (
                    document.revision_id().to_owned(),
                    document.embedding().to_vec(),
                    document.document().serialized_statement.clone(),
                    document
                        .evidence_handles()
                        .iter()
                        .map(|handle| {
                            (
                                handle.scene_id().to_owned(),
                                handle.evidence_id().to_owned(),
                                handle.excerpt(),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>()
    };
    append(&f);
    append(&f);
    let (inherited, reads) = project_read_probe::recording(|| qualify(&f));
    assert_eq!(reads.get(&Read::AuthorityTree).copied().unwrap_or(0), 0);
    forget(&snapshot);
    let (complete, reads) = project_read_probe::recording(|| qualify(&f));
    assert!(reads.get(&Read::AuthorityTree).copied().unwrap_or(0) > 0);
    assert_eq!(shape(&inherited), shape(&complete));
    assert_eq!(
        QueryBinding::from(inherited.query_context()),
        QueryBinding::from(complete.query_context())
    );
}

/// DR-CP4-V-6: the begin status read keeps its query context under the
/// DR-CP4-V-1 P2 rule, so the qualify after the query embedding's audit-only
/// commits reuses it instead of reading the Scope authority again.
#[test]
fn nir1_status_read_context_is_reused_across_audit_only_commits() {
    let f = published();
    let snapshot = snapshot(&f);
    forget(&snapshot);
    let scene = scene(&f);
    // The begin status read: it validates the proof and keeps its context.
    let (status, read_tables) =
        f.db.with_read_transaction(|conn| {
            Ok(recording_tables(conn, true, |conn| {
                read_chronicle_query_status(conn, &f.runtime, f.project(), &scene)
            }))
        })
        .expect("status read");
    let NirQueryStatusRead::Available {
        query_context,
        snapshot: Some(_),
        ..
    } = status.expect("status")
    else {
        panic!("usable status");
    };
    for audit in ["ai_audit_events", "sqlite_sequence"] {
        assert!(
            !read_tables.contains(audit),
            "{audit} read by the status read"
        );
    }
    append(&f);
    append(&f);
    let (after, reads) = read(&f, &snapshot);
    assert_eq!(reads, 0, "qualify reuses the status read's context");
    assert!(after.is_some_and(|after| Arc::ptr_eq(&after, &query_context)));
}

#[test]
fn nir1_status_read_keeps_no_context_in_a_write_transaction() {
    let f = published();
    let snapshot = snapshot(&f);
    forget(&snapshot);
    let scene = scene(&f);
    f.db.with_conn_mut(|conn| {
        let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
        tx.execute_batch("CREATE TABLE inv_write_state (value INTEGER)")?;
        let NirQueryStatusRead::Available { .. } =
            read_chronicle_query_status(&mut tx, &f.runtime, f.project(), &scene)?
        else {
            panic!("status");
        };
        tx.rollback()?;
        Ok(())
    })
    .expect("write transaction");
    assert!(snapshot
        .proof
        .validated_query_contexts
        .lock()
        .expect("context cache")
        .is_empty());
}

/// Install a write recorder on the Database's connection while `body` runs
/// through the Database API (which takes the connection itself).
fn recording_writes<T>(db: &Database, body: impl FnOnce() -> T) -> (T, BTreeSet<String>) {
    let seen = Arc::new(Mutex::new(BTreeSet::new()));
    let sink = Arc::clone(&seen);
    db.with_conn_mut(|conn| {
        conn.flush_prepared_statement_cache();
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if let AuthAction::Insert { table_name }
            | AuthAction::Update { table_name, .. }
            | AuthAction::Delete { table_name } = context.action
            {
                sink.lock().expect("tables").insert(table_name.to_owned());
            }
            Authorization::Allow
        }))?;
        Ok(())
    })
    .expect("install recorder");
    let value = body();
    db.with_conn_mut(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        conn.flush_prepared_statement_cache();
        Ok(())
    })
    .expect("remove recorder");
    let tables = seen.lock().expect("tables").clone();
    (value, tables)
}

#[test]
fn nir1_premise_every_audit_append_shape_writes_only_audit_rows() {
    // Appends need no publication; the build plan gives the documents.
    let f = Fixture::new();
    let (_, docs) = f.prepare();
    let doc = docs.into_iter().next().expect("a document");
    let only_audit = BTreeSet::from(["ai_audit_events".to_owned()]);
    // The Fixture's five-event embedding audit through the Database API.
    let (_, written) = recording_writes(&f.db, || f.outcome(doc.clone(), false));
    assert_eq!(
        without_clock_bookkeeping(written),
        only_audit,
        "Fixture outcome()"
    );
    for skip in [false, true] {
        // The generic append (connection default durability).
        let (events, ..) = f.outcome_audit(&doc, skip);
        let (result, written) = recording_writes(&f.db, || {
            f.db.append_ai_audit_events_for_scope(Some(f.project()), &events)
        });
        assert_eq!(result.expect("generic").inserted_count, events.len());
        assert_eq!(
            without_clock_bookkeeping(written),
            only_audit,
            "generic append, skip {skip}"
        );
        // The external dispatch append: with request.dispatched it commits
        // power-loss durable (PRAGMA synchronous around the transaction).
        let (events, ..) = f.outcome_audit(&doc, skip);
        assert_eq!(
            events.iter().any(|e| e.event_type == "request.dispatched"),
            !skip
        );
        let (result, written) = recording_writes(&f.db, || {
            f.db.append_external_ai_audit_events_for_scope(Some(f.project()), &events)
        });
        assert_eq!(result.expect("external").inserted_count, events.len());
        assert_eq!(
            without_clock_bookkeeping(written),
            only_audit,
            "external append, skip {skip}"
        );
    }
}

#[test]
fn nir1_premise_whole_qualify_never_reads_audit_rows() {
    let f = published();
    crate::ai_audit::append_ai_audit_events_for_scope(
        &f.db.lock().expect("conn"),
        Some(f.project()),
        &[audit_event()],
    )
    .expect("an audit row exists");
    let snapshot = snapshot(&f);
    forget(&snapshot);
    let (qualified, read) =
        f.db.with_read_transaction(|conn| {
            Ok(recording_tables(conn, true, |conn| {
                qualify_chronicle_index_snapshot(conn, &f.runtime, &snapshot)
            }))
        })
        .expect("qualify");
    assert!(matches!(
        qualified.expect("qualify"),
        NirQualifiedRead::Qualified(_)
    ));
    for table in [
        "narrative_proposals",
        "tree_nodes",
        "narrative_extraction_artifacts",
    ] {
        assert!(read.contains(table), "{table} not read: {read:?}");
    }
    for audit in ["ai_audit_events", "sqlite_sequence"] {
        assert!(!read.contains(audit), "{audit} read by qualify: {read:?}");
    }
}

#[test]
fn nir1_append_rolled_back_at_commit_is_not_an_audit_only_commit() {
    let f = published();
    // A deferred foreign key violated by a temp trigger on every audit row:
    // the append body succeeds (both states are read) and COMMIT fails.
    write(
        &f,
        "CREATE TEMP TABLE inv_parent (id INTEGER PRIMARY KEY);
         CREATE TEMP TABLE inv_child (parent INTEGER REFERENCES inv_parent(id)
             DEFERRABLE INITIALLY DEFERRED);
         CREATE TEMP TRIGGER inv_fail_commit AFTER INSERT ON main.ai_audit_events
         BEGIN INSERT INTO inv_child VALUES (999); END;",
    );
    let (snapshot, first) = validated(&f);
    let error =
        f.db.append_ai_audit_events_for_scope(Some(f.project()), &[audit_event()])
            .expect_err("COMMIT fails on the deferred foreign key");
    assert!(error.to_string().contains("FOREIGN KEY"), "{error:#}");
    // The failed commit rolled the write clock back with it: the committed state is the
    // validated one (its verdict is still right), and nothing was recorded as an
    // audit-only commit (DR-DBC-5).
    let (after, reads) = read(&f, &snapshot);
    assert!(
        same(&first, &after) && reads == 0,
        "an append that did not commit leaves the state unchanged"
    );
}

#[test]
fn nir1_audit_only_inheritance_never_covers_a_user_version_change() {
    let f = published();
    let (snapshot, first) = validated(&f);
    append(&f);
    let version: i64 =
        f.db.with_conn(|conn| Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?))
            .expect("user_version");
    write(&f, &format!("PRAGMA user_version={}", version + 1));
    let (after, reads) = read(&f, &snapshot);
    assert!(
        !(reads == 0 && same(&first, &after)),
        "a user_version change is never inherited"
    );
}

#[test]
fn nir1_audit_only_states_keep_their_bounds() {
    use super::super::read_identity::{state_for_test as state, AuditOnlyStates};
    // One database's list keeps its last `max_states` states.
    let mut states = AuditOnlyStates::new(4, 3);
    for changes in 0..5 {
        states.record("", state("c", changes), state("c", changes + 1));
    }
    assert!(states.joined("", &state("c", 3), &state("c", 5)));
    assert!(
        !states.joined("", &state("c", 2), &state("c", 5)),
        "pushed out"
    );
    assert!(
        !states.joined("", &state("c", 3), &state("c", 4)),
        "not the last"
    );
    // Another write between appends starts the list again.
    states.record("", state("c", 7), state("c", 8));
    assert!(!states.joined("", &state("c", 5), &state("c", 8)));
    assert!(states.joined("", &state("c", 7), &state("c", 8)));
    // Databases beyond `max_connections` push out the least recently used.
    let mut states = AuditOnlyStates::new(2, 3);
    states.record("", state("a", 0), state("a", 1));
    states.record("", state("b", 0), state("b", 1));
    states.record("", state("a", 1), state("a", 2)); // `a` used again
    states.record("", state("c", 0), state("c", 1)); // pushes out `b`
    assert!(states.joined("", &state("a", 0), &state("a", 2)));
    assert!(
        !states.joined("", &state("b", 0), &state("b", 1)),
        "pushed out"
    );
    assert!(states.joined("", &state("c", 0), &state("c", 1)));
    // States of different lineages are never joined.
    states.record("", state("a", 2), state("d", 3));
    assert!(!states.joined("", &state("a", 2), &state("d", 3)));
    // The same lineage and sequence in another file (a duplicated workspace
    // folder) never reads this file's list (DR-DBC-5).
    let mut states = AuditOnlyStates::new(4, 3);
    states.record("/ws/a/grimodex.db", state("l", 4), state("l", 5));
    assert!(states.joined("/ws/a/grimodex.db", &state("l", 4), &state("l", 5)));
    assert!(!states.joined("/ws/b/grimodex.db", &state("l", 4), &state("l", 5)));
}

/// The TEMP schema is private to one connection and moves nothing a covered read
/// depends on (DR-DBC-5): an audit-only list survives it.
#[test]
fn nir1_audit_only_inheritance_ignores_the_temp_schema() {
    let f = published();
    let (snapshot, first) = validated(&f);
    append(&f);
    write(&f, "CREATE TEMP TABLE inv_temp_schema (value INTEGER)");
    let (after, reads) = read(&f, &snapshot);
    assert!(
        after.is_some() && reads == 0,
        "inherited across a TEMP change"
    );
    let _ = first;
}

/// A file put back from an older copy under the same path keeps its lineage and
/// can reach the same sequence values again. A workspace authority opened on it
/// never inherits the lists recorded before (P2-1 of the DR-DBC-5 review; the
/// old connection-epoch key made every reopened `Database` start a fresh list).
#[test]
fn nir1_audit_only_lists_are_not_inherited_by_a_reopened_workspace_authority() {
    let f = published();
    let (snapshot, first) = validated(&f);
    append(&f);
    // Positive control: without a reopen the audit-only commit is inherited.
    let (kept, reads) = read(&f, &snapshot);
    assert!(same(&first, &kept) && reads == 0);
    append(&f);
    let dir = std::env::temp_dir().join(format!("nir1-audit-lease-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("lease directory");
    let lease = crate::workspace_lease::try_acquire_shared(&dir).expect("shared lease");
    let reopened = Database::new(f.path()).expect("the same file, opened again");
    let authority = crate::WorkspaceAuthority::new(reopened, f.path().to_path_buf(), lease);
    let (after, reads) = read(&f, &snapshot);
    assert!(after.is_some());
    assert!(
        reads > 0,
        "the lists of the file are dropped when an authority opens it"
    );
    drop(authority);
    std::fs::remove_dir_all(&dir).expect("remove the lease directory");
}

#[test]
fn nir1_audit_only_states_forget_one_file_only() {
    use super::super::read_identity::{state_for_test as state, AuditOnlyStates};
    let mut states = AuditOnlyStates::new(4, 3);
    states.record("/ws/a/grimodex.db", state("l", 4), state("l", 5));
    states.record("/ws/b/grimodex.db", state("l", 4), state("l", 5));
    states.forget("/ws/a/grimodex.db");
    assert!(!states.joined("/ws/a/grimodex.db", &state("l", 4), &state("l", 5)));
    assert!(states.joined("/ws/b/grimodex.db", &state("l", 4), &state("l", 5)));
}
