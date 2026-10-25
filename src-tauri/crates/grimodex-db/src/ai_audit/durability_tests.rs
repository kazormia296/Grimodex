//! 外部送信の前の commit だけを停電にも耐える commit にする仕組みの試験。

use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::Database;

const PROJECT: &str = "project-1";

fn database() -> Database {
    let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('project-1', 'Project', datetime('now'), datetime('now'))",
            [],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn event(event_id: &str, execution_id: &str, event_type: &str) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: event_id.to_string(),
        execution_id: execution_id.to_string(),
        operation_id: "operation-1".to_string(),
        parent_execution_id: None,
        path_id: "chat.direct".to_string(),
        event_type: event_type.to_string(),
        timestamp: 1,
        payload: json!({"captureState": "complete", "credentialsExcluded": true}),
    }
}

fn pragma(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .expect("read pragma")
}

fn connection_levels(db: &Database) -> (i64, i64, bool) {
    db.with_conn(|conn| {
        Ok((
            pragma(conn, "synchronous"),
            pragma(conn, "fullfsync"),
            conn.is_autocommit(),
        ))
    })
    .expect("read connection levels")
}

/// この thread で記録した COMMIT 時点の `synchronous` を取り出す。
fn commits() -> Vec<i64> {
    commit_test_probe::take_observed_commit_synchronous()
}

/// WAL の file DB（製品と同じ `Database::new`）。
fn file_database(name: &str) -> (Database, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "grimodex-ai-audit-durability-{name}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let db = Database::new(&dir.join("grimodex.db")).expect("open file db");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        assert_eq!(journal_mode, "wal");
        conn.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('project-1', 'Project', datetime('now'), datetime('now'))",
            [],
        )?;
        Ok(())
    })
    .expect("seed project");
    (db, dir)
}

fn cli_lifecycle(execution_id: &str) -> [AppendAiAuditEvent; 3] {
    let mut cli = [
        event(
            &format!("{execution_id}-start"),
            execution_id,
            "execution.started",
        ),
        event(
            &format!("{execution_id}-prepared"),
            execution_id,
            "request.prepared",
        ),
        event(
            &format!("{execution_id}-dispatched"),
            execution_id,
            "request.dispatched",
        ),
    ];
    for item in &mut cli {
        item.path_id = "cli_chat_stream".to_string();
    }
    cli[1].payload = json!({
        "captureState": "partial",
        "credentialsExcluded": true,
        "request": {
            "provider": "cli",
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "hello"}],
            "options": {"cli": "codex"}
        }
    });
    cli
}

fn cli_digest() -> String {
    hex::encode(Sha256::digest(
        br#"{"cli":"codex","model":"gpt-test","prompt":"hello"}"#,
    ))
}

fn audit_rows(db: &Database) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM ai_audit_events", [], |row| row.get(0))?)
    })
    .expect("count audit rows")
}

#[test]
fn only_batches_with_request_dispatched_are_power_loss_durable() {
    use AiAuditCommitDurability::{ConnectionDefault, PowerLossDurable};
    let cases: [(&[&str], AiAuditCommitDurability); 9] = [
        (
            &["execution.started", "request.prepared"],
            ConnectionDefault,
        ),
        (
            &[
                "execution.started",
                "request.prepared",
                "request.dispatched",
            ],
            PowerLossDurable,
        ),
        (&["request.dispatched"], PowerLossDurable),
        (&["response.partial", "response.partial"], ConnectionDefault),
        (&["request.prepared", "response.partial"], ConnectionDefault),
        (&["transport.attempt.started"], ConnectionDefault),
        (&["transport.attempt.finished"], ConnectionDefault),
        (
            &["response.completed", "execution.succeeded"],
            ConnectionDefault,
        ),
        (&["execution.failed"], ConnectionDefault),
    ];
    for (event_types, expected) in cases {
        let batch: Vec<_> = event_types
            .iter()
            .enumerate()
            .map(|(index, event_type)| event(&format!("e{index}"), "x", event_type))
            .collect();
        assert_eq!(
            external_dispatch_commit_durability(&batch),
            expected,
            "{event_types:?}"
        );
    }
}

#[test]
fn guard_enables_full_and_restores_connection_default_on_drop() {
    let db = database();
    assert_eq!(
        connection_levels(&db),
        (1, 0, true),
        "Database opens NORMAL"
    );
    db.with_conn(|conn| {
        {
            let _guard = PowerLossDurableCommitGuard::enable(conn)?;
            assert_eq!(pragma(conn, "synchronous"), SQLITE_SYNCHRONOUS_FULL);
            assert_eq!(pragma(conn, "fullfsync"), 1);
        }
        assert_eq!(pragma(conn, "synchronous"), 1);
        assert_eq!(pragma(conn, "fullfsync"), 0);
        Ok(())
    })
    .expect("guard scope");
}

#[test]
fn guard_never_weakens_a_stronger_level_and_refuses_inside_a_transaction() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA synchronous=EXTRA")?;
        {
            let _guard = PowerLossDurableCommitGuard::enable(conn)?;
            assert_eq!(pragma(conn, "synchronous"), 3, "EXTRA stays EXTRA");
        }
        assert_eq!(pragma(conn, "synchronous"), 3);
        conn.execute_batch("PRAGMA synchronous=NORMAL; BEGIN")?;
        let error = PowerLossDurableCommitGuard::enable(conn)
            .err()
            .expect("a guard cannot start inside a transaction");
        assert!(error.to_string().contains("outside a transaction"));
        conn.execute_batch("ROLLBACK")?;
        assert_eq!(pragma(conn, "synchronous"), 1);
        Ok(())
    })
    .expect("guard scope");
}

#[test]
fn guard_rolls_back_and_restores_when_the_transaction_panics() {
    let db = database();
    db.with_conn(|conn| {
        let unwind = catch_unwind(AssertUnwindSafe(|| {
            let _guard = PowerLossDurableCommitGuard::enable(conn).expect("enable");
            conn.execute_batch("BEGIN IMMEDIATE").expect("begin");
            append_ai_audit_events_in_transaction(
                conn,
                Some(PROJECT),
                &[event("panic-start", "panic", "execution.started")],
            )
            .expect("insert inside the transaction");
            panic!("simulated panic before COMMIT");
        }));
        assert!(unwind.is_err());
        assert!(conn.is_autocommit(), "the open transaction is rolled back");
        assert_eq!(pragma(conn, "synchronous"), 1);
        assert_eq!(pragma(conn, "fullfsync"), 0);
        Ok(())
    })
    .expect("panic scope");
    assert_eq!(
        audit_rows(&db),
        0,
        "the panicked transaction is not committed"
    );
}

#[test]
fn external_append_restores_connection_default_after_commit_and_after_failure() {
    let db = database();
    commits();
    db.append_external_ai_audit_events(
        PROJECT,
        &[
            event("ok-start", "ok", "execution.started"),
            event("ok-prepared", "ok", "request.prepared"),
            event("ok-dispatched", "ok", "request.dispatched"),
        ],
    )
    .expect("durable pre-dispatch batch");
    assert_eq!(commits(), [SQLITE_SYNCHRONOUS_FULL]);
    assert_eq!(connection_levels(&db), (1, 0, true));
    assert_eq!(audit_rows(&db), 3);

    // prepared の無い dispatched は lifecycle の検査で拒否される。失敗でも元に戻る。
    let error = db
        .append_external_ai_audit_events(
            PROJECT,
            &[
                event("bad-start", "bad", "execution.started"),
                event("bad-dispatched", "bad", "request.dispatched"),
            ],
        )
        .expect_err("dispatch without prepared must fail closed");
    assert!(error.to_string().contains("request.prepared"));
    assert!(
        commits().is_empty(),
        "the failed batch never reaches COMMIT"
    );
    assert_eq!(connection_levels(&db), (1, 0, true));
    assert_eq!(audit_rows(&db), 3, "the failed batch is rolled back");
}

/// 送信前の commit だけが COMMIT の時点で FULL になる（WAL の file DB で確かめる）。
#[test]
fn only_pre_dispatch_commits_on_external_paths_commit_at_full_on_a_wal_database() {
    let (db, dir) = file_database("paths");
    commits();

    // renderer の begin（started＋prepared）は dispatched より前なので NORMAL。
    db.append_external_ai_audit_events(
        PROJECT,
        &[
            event("r-start", "r", "execution.started"),
            event("r-prepared", "r", "request.prepared"),
        ],
    )
    .expect("renderer begin");
    // markAiAuditDispatched の batch は FULL。
    db.append_external_ai_audit_events(
        PROJECT,
        &[event("r-dispatched", "r", "request.dispatched")],
    )
    .expect("renderer dispatched");
    // 送信後の microbatch と終端は NORMAL。
    db.append_external_ai_audit_events(
        PROJECT,
        &[
            event("r-partial-1", "r", "response.partial"),
            event("r-partial-2", "r", "response.partial"),
        ],
    )
    .expect("partials");
    db.append_external_ai_audit_events(
        PROJECT,
        &[
            event("r-completed", "r", "response.completed"),
            event("r-done", "r", "execution.succeeded"),
        ],
    )
    .expect("terminal");
    assert_eq!(commits(), [1, SQLITE_SYNCHRONOUS_FULL, 1, 1]);

    // 汎用の append（local の semantic など）は dispatched を含んでも NORMAL のまま。
    db.append_ai_audit_events(
        PROJECT,
        &[
            event("s-start", "s", "execution.started"),
            event("s-prepared", "s", "request.prepared"),
            event("s-dispatched", "s", "request.dispatched"),
        ],
    )
    .expect("generic local batch");
    assert_eq!(commits(), [1]);

    // CLI／Codex：dispatched を含む batch と claim は FULL。
    db.append_external_ai_audit_events(PROJECT, &cli_lifecycle("c"))
        .expect("cli lifecycle");
    db.claim_cli_ai_audit_dispatch(
        Some(PROJECT),
        "c",
        "operation-1",
        None,
        "cli_chat_stream",
        &cli_digest(),
    )
    .expect("claim");
    assert_eq!(
        commits(),
        [SQLITE_SYNCHRONOUS_FULL, SQLITE_SYNCHRONOUS_FULL]
    );
    assert_eq!(connection_levels(&db), (1, 0, true));

    // 同じ execution の 2 回目の claim は拒否され、COMMIT に届かず、元に戻る。
    db.claim_cli_ai_audit_dispatch(
        Some(PROJECT),
        "c",
        "operation-1",
        None,
        "cli_chat_stream",
        &cli_digest(),
    )
    .expect_err("second claim must fail closed");
    assert!(commits().is_empty());
    assert_eq!(connection_levels(&db), (1, 0, true));
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn external_append_still_rejects_the_nir1_local_namespace_before_the_guard() {
    let db = database();
    commits();
    let mut batch = [
        event("n-start", "n", "execution.started"),
        event("n-prepared", "n", "request.prepared"),
        event("n-dispatched", "n", "request.dispatched"),
    ];
    for item in &mut batch {
        item.path_id = crate::nir1_local_audit::NIR1_LOCAL_WRITING_PATH_ID.to_string();
    }
    let error = db
        .append_external_ai_audit_events(PROJECT, &batch)
        .expect_err("the NIR-1 local namespace is reserved for the dedicated append");
    assert!(error.to_string().contains("AI_AUDIT_RESERVED_NAMESPACE"));
    assert!(commits().is_empty());
    assert_eq!(connection_levels(&db), (1, 0, true));
    assert_eq!(audit_rows(&db), 0);
}

/// 戻し損ねたら append は失敗し（送信しない側）、接続は quarantine されて以後使われない。
#[test]
fn a_failed_restore_fails_the_append_and_quarantines_the_connection() {
    for claim in [false, true] {
        let db = database();
        if claim {
            db.append_external_ai_audit_events(PROJECT, &cli_lifecycle("q"))
                .expect("cli lifecycle");
        }
        commits();
        fail_next_durability_restore_for_test();
        let error = if claim {
            db.claim_cli_ai_audit_dispatch(
                Some(PROJECT),
                "q",
                "operation-1",
                None,
                "cli_chat_stream",
                &cli_digest(),
            )
            .expect_err("restore failure must fail the claim")
        } else {
            db.append_external_ai_audit_events(
                PROJECT,
                &[
                    event("q-start", "q", "execution.started"),
                    event("q-prepared", "q", "request.prepared"),
                    event("q-dispatched", "q", "request.dispatched"),
                ],
            )
            .expect_err("restore failure must fail the append")
        };
        assert!(error
            .downcast_ref::<AiAuditDurabilityRestoreError>()
            .is_some());
        assert!(error
            .to_string()
            .contains("AI_AUDIT_DURABILITY_RESTORE_FAILED"));
        assert_eq!(commits(), [SQLITE_SYNCHRONOUS_FULL], "claim={claim}");
        assert!(!db.connection_reusable(), "claim={claim}");
        assert!(db.with_conn(|_| Ok(())).is_err(), "claim={claim}");
    }
}
