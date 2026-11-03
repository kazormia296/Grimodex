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
    conn: &Connection,
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

fn recording_tables<T>(
    conn: &Connection,
    reads: bool,
    body: impl FnOnce() -> T,
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
    let value = body();
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
        f.db.with_conn(|conn| {
            Ok(recording_tables(conn, false, || {
                crate::ai_audit::append_ai_audit_events_for_scope(
                    conn,
                    Some(f.project()),
                    &[audit_event()],
                )
            }))
        })
        .expect("append");
    assert_eq!(result.expect("generic append").inserted_count, 1);
    assert_eq!(
        written,
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
            Ok(recording_tables(conn, true, || {
                validate(conn, &f, &snapshot)
            }))
        })
        .expect("complete check");
    assert!(context.is_some(), "the complete check accepts the proof");
    assert!(
        read.contains("narrative_proposals") && read.contains("narrative_dependency_edges"),
        "the recorder saw the complete check: {read:?}"
    );
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
    let snapshot = snapshot(f);
    let (first, reads) = read(f, &snapshot);
    assert!(first.is_some(), "the original query is current");
    assert!(reads > 0, "the first validation is complete");
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
fn nir1_audit_only_inheritance_never_covers_another_connection_or_schema() {
    for case in ["other-before", "other-after", "schema", "temp-schema"] {
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
            "schema" => {
                append(&f);
                write(&f, "CREATE TABLE inv_schema_change (value INTEGER)");
            }
            _ => {
                append(&f);
                write(&f, "CREATE TEMP TABLE inv_temp_schema (value INTEGER)");
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
    let mut invalid = audit_event();
    invalid.event_id = " ".into();
    // The first row is inserted, the second fails validation: the whole
    // append rolls back and total_changes has still moved.
    assert!(f
        .db
        .append_ai_audit_events_for_scope(Some(f.project()), &[audit_event(), invalid])
        .is_err());
    let (after, reads) = read(&f, &snapshot);
    assert!(after.is_some() && !same(&first, &after));
    assert!(reads > 0, "a rolled-back append is never inherited");
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
fn nir1_audit_only_inheritance_ends_with_the_connection_and_the_runtime_epoch() {
    // Another connection (a reopened Database) has another connection epoch:
    // the runtime is bound to its own connection, so the proof is not current
    // there at all, whatever the audit-only states of the old connection are.
    let f = published();
    let (snapshot, _) = validated(&f);
    append(&f);
    let reopened = Database::new(f.path()).expect("reopened connection");
    let (after, _) = read_on(&reopened, &f, &snapshot);
    assert!(after.is_none(), "a new connection never inherits");
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
