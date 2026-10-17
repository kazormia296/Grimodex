use serde_json::json;

use super::*;
use crate::ai_audit::{claim_cli_ai_audit_dispatch_for_scope, AppendAiAuditEvent};
use crate::Database;

const PROJECT: &str = "project-1";
const ATTEMPT: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

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

fn payload(event_type: &str) -> serde_json::Value {
    let mut value = json!({"captureState": "complete", "credentialsExcluded": true});
    if event_type == "request.prepared" {
        value["request"] = json!({"body": {"model": "m"}});
    }
    value
}

fn generic(event_id: &str, execution_id: &str, event_type: &str) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: event_id.to_string(),
        execution_id: execution_id.to_string(),
        operation_id: "operation-1".to_string(),
        parent_execution_id: None,
        path_id: "chat.direct".to_string(),
        event_type: event_type.to_string(),
        timestamp: 1,
        payload: payload(event_type),
    }
}

fn reserved(path_id: &str, attempt: &str, event_type: &str) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: event_id_for_attempt(attempt, event_type).unwrap(),
        execution_id: execution_id_for_attempt(attempt).unwrap(),
        operation_id: operation_id_for_attempt(attempt).unwrap(),
        parent_execution_id: None,
        path_id: path_id.to_string(),
        event_type: event_type.to_string(),
        timestamp: 1,
        payload: payload(event_type),
    }
}

fn row_count(db: &Database) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row("SELECT count(*) FROM ai_audit_events", [], |row| row.get(0))?)
    })
    .unwrap()
}

fn dedicated_start(db: &Database, path_id: &str, attempt: &str) -> anyhow::Result<()> {
    let events = [
        reserved(path_id, attempt, "execution.started"),
        reserved(path_id, attempt, "request.prepared"),
        reserved(path_id, attempt, "request.dispatched"),
    ];
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = append_reserved_events_in_transaction(conn, PROJECT, &events);
        match result {
            Ok(_) => conn.execute_batch("COMMIT")?,
            Err(_) => {
                let _ = conn.execute_batch("ROLLBACK");
            }
        }
        result.map(|_| ())
    })
}

#[test]
fn derivation_is_deterministic_and_invertible() {
    let execution = execution_id_for_attempt(ATTEMPT).unwrap();
    assert_eq!(
        execution,
        format!("nir1-local-generation:execution:{ATTEMPT}")
    );
    assert_eq!(execution, execution_id_for_attempt(ATTEMPT).unwrap());
    assert_eq!(
        operation_id_for_attempt(ATTEMPT).unwrap(),
        format!("nir1-local-generation:operation:{ATTEMPT}")
    );
    assert_eq!(
        event_id_for_attempt(ATTEMPT, "request.prepared").unwrap(),
        format!("nir1-local-generation:event:{ATTEMPT}:request.prepared")
    );
    assert_eq!(attempt_id_from_execution_id(&execution), Some(ATTEMPT));
    assert_eq!(attempt_id_from_execution_id("execution-1"), None);
    assert_eq!(
        attempt_id_from_execution_id(&execution.to_uppercase()),
        None
    );
    for bad in ["", "a:b", "a b", "a/b"] {
        assert!(execution_id_for_attempt(bad).is_err(), "{bad}");
    }
    assert!(event_id_for_attempt(ATTEMPT, "Bad Type").is_err());
    assert!(is_reserved_id(&execution));
}

#[test]
fn constants_are_the_k5_names() {
    assert_eq!(NIR1_LOCAL_AUDIT_ID_PREFIX, "nir1-local-generation:");
    assert_eq!(NIR1_LOCAL_WRITING_PATH_ID, "nir1_local_generation_writing");
    assert_eq!(NIR1_LOCAL_REVIEW_PATH_ID, "nir1_local_generation_review");
}

#[test]
fn reserved_detection_covers_path_and_all_four_ids_with_variants() {
    for path in NIR1_LOCAL_AUDIT_PATH_IDS {
        let mut event = generic("e1", "x1", "execution.started");
        event.path_id = path.to_string();
        assert_eq!(reserved_field(&event), Some("pathId"));
        event.path_id = format!("  {}\t", path.to_uppercase());
        assert_eq!(reserved_field(&event), Some("pathId"));
    }
    let variants = |id: &str| {
        [
            id.to_string(),
            id.to_uppercase(),
            format!("  {id}"),
            format!("{id}\n"),
        ]
    };
    for id in variants("nir1-local-generation:anything") {
        let mut event = generic("e1", "x1", "execution.started");
        event.event_id = id.clone();
        assert_eq!(reserved_field(&event), Some("eventId"), "{id:?}");
        let mut event = generic("e1", "x1", "execution.started");
        event.execution_id = id.clone();
        assert_eq!(reserved_field(&event), Some("executionId"), "{id:?}");
        let mut event = generic("e1", "x1", "execution.started");
        event.operation_id = id.clone();
        assert_eq!(reserved_field(&event), Some("operationId"), "{id:?}");
        let mut event = generic("e1", "x1", "execution.started");
        event.parent_execution_id = Some(id.clone());
        assert_eq!(reserved_field(&event), Some("parentExecutionId"), "{id:?}");
    }
    // Near misses and the existing ID shapes stay unreserved.
    for id in [
        "nir1-local-generation",
        "xnir1-local-generation:a",
        "nir1-local-gen:a",
        "execution-1",
        "0b0c2f0a-0000-4000-8000-000000000000",
        "",
    ] {
        let mut event = generic(id, id, "execution.started");
        event.operation_id = id.to_string();
        event.parent_execution_id = Some(id.to_string());
        assert_eq!(reserved_field(&event), None, "{id:?}");
    }
    let mut event = generic("e1", "x1", "execution.started");
    event.path_id = "nir1_local_generation_writing2".to_string();
    assert!(!is_reserved_event(&event));
}

#[test]
fn generic_append_rejects_each_reserved_field_and_writes_nothing() {
    let db = database();
    let execution = execution_id_for_attempt(ATTEMPT).unwrap();
    let mut cases = Vec::new();
    for path in NIR1_LOCAL_AUDIT_PATH_IDS {
        let mut event = generic("e-path", "x-path", "execution.started");
        event.path_id = path.to_string();
        cases.push(("pathId", event));
    }
    let mut event = generic(&execution, "x-event", "execution.started");
    cases.push(("eventId", {
        event.event_id = event_id_for_attempt(ATTEMPT, "execution.started").unwrap();
        event
    }));
    cases.push((
        "executionId",
        generic("e-exec", &execution, "execution.started"),
    ));
    let mut event = generic("e-op", "x-op", "execution.started");
    event.operation_id = operation_id_for_attempt(ATTEMPT).unwrap();
    cases.push(("operationId", event));
    let mut event = generic("e-parent", "x-parent", "execution.started");
    event.parent_execution_id = Some(execution.clone());
    cases.push(("parentExecutionId", event));

    for (field, bad) in cases {
        // A valid first event, then the reserved one: the whole batch fails.
        let batch = [generic("ok-1", "x-ok", "execution.started"), bad];
        let error = db.append_ai_audit_events(PROJECT, &batch).expect_err(field);
        let typed = error
            .downcast_ref::<Nir1LocalAuditReservedError>()
            .expect("typed reserved error");
        assert_eq!(typed.field, field);
        assert_eq!(typed.event_index, 1);
        assert!(error.to_string().contains("AI_AUDIT_RESERVED_NAMESPACE"));
        assert_eq!(row_count(&db), 0, "{field}: nothing is written");
        // Same through the scope form and the free function.
        assert!(db
            .append_ai_audit_events_for_scope(Some(PROJECT), &batch)
            .is_err());
        let free = db
            .with_conn(|conn| {
                crate::ai_audit::append_ai_audit_events_for_scope(conn, Some(PROJECT), &batch)
            })
            .expect_err("free function");
        assert!(free.downcast_ref::<Nir1LocalAuditReservedError>().is_some());
        assert_eq!(row_count(&db), 0);
    }
}

#[test]
fn generic_append_of_unreserved_batches_is_unchanged() {
    let db = database();
    let result = db
        .append_ai_audit_events(
            PROJECT,
            &[
                generic("e1", "x1", "execution.started"),
                generic("e2", "x1", "request.prepared"),
                generic("e3", "x1", "request.dispatched"),
            ],
        )
        .unwrap();
    assert_eq!(result.inserted_count, 3);
    assert_eq!(row_count(&db), 3);
}

#[test]
fn only_the_dedicated_append_writes_the_reserved_namespace() {
    let db = database();
    for (index, path) in NIR1_LOCAL_AUDIT_PATH_IDS.iter().enumerate() {
        let attempt = format!("attempt-{index}");
        dedicated_start(&db, path, &attempt).unwrap();
        let rows: Vec<(String, String)> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT event_type, path_id FROM ai_audit_events
                     WHERE execution_id = ?1 ORDER BY sequence",
                )?;
                let rows = stmt
                    .query_map([execution_id_for_attempt(&attempt).unwrap()], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            [
                "execution.started",
                "request.prepared",
                "request.dispatched"
            ]
        );
        assert!(rows.iter().all(|row| row.1 == *path));
    }
    assert_eq!(row_count(&db), 6);
    assert!(db.verify_ai_audit_chain(PROJECT, None).unwrap().ok);
}

#[test]
fn dedicated_append_requires_the_derived_reserved_shape() {
    let db = database();
    let mut cases: Vec<AppendAiAuditEvent> = Vec::new();
    cases.push(generic("e1", "x1", "execution.started"));
    let mut event = reserved(NIR1_LOCAL_WRITING_PATH_ID, ATTEMPT, "execution.started");
    event.path_id = "chat.direct".to_string();
    cases.push(event);
    let mut event = reserved(NIR1_LOCAL_WRITING_PATH_ID, ATTEMPT, "execution.started");
    event.operation_id = operation_id_for_attempt("other").unwrap();
    cases.push(event);
    let mut event = reserved(NIR1_LOCAL_WRITING_PATH_ID, ATTEMPT, "execution.started");
    event.event_id = event_id_for_attempt(ATTEMPT, "request.prepared").unwrap();
    cases.push(event);
    let mut event = reserved(NIR1_LOCAL_WRITING_PATH_ID, ATTEMPT, "execution.started");
    event.parent_execution_id = Some(execution_id_for_attempt("p").unwrap());
    cases.push(event);
    let mut event = reserved(NIR1_LOCAL_WRITING_PATH_ID, ATTEMPT, "execution.started");
    event.execution_id = event.execution_id.to_uppercase();
    cases.push(event);
    for bad in cases {
        let good = reserved(NIR1_LOCAL_REVIEW_PATH_ID, "good", "execution.started");
        let result = db.with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let result = append_reserved_events_in_transaction(conn, PROJECT, &[good, bad]);
            conn.execute_batch("ROLLBACK")?;
            Ok(result.map(|_| ()))
        });
        assert!(result.unwrap().is_err());
        assert_eq!(row_count(&db), 0);
    }
}

/// The field a typed reserved-namespace rejection names; fails when the
/// rejection came from some other validator.
fn rejected_field(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<Nir1LocalAuditReservedError>()
        .unwrap_or_else(|| panic!("expected a reserved-namespace error, got: {error:#}"))
        .field
}

#[test]
fn generic_append_cannot_terminate_or_preempt_a_dedicated_execution() {
    let db = database();
    // Pre-emption: a renderer cannot claim the execution ID before Native.
    let execution = execution_id_for_attempt(ATTEMPT).unwrap();
    let error = db
        .append_ai_audit_events(
            PROJECT,
            &[generic("pre-1", &execution, "execution.started")],
        )
        .expect_err("pre-emption is rejected");
    assert_eq!(rejected_field(&error), "executionId");
    assert_eq!(row_count(&db), 0);
    dedicated_start(&db, NIR1_LOCAL_WRITING_PATH_ID, ATTEMPT).unwrap();
    assert_eq!(row_count(&db), 3);

    // Injection: a generic terminal for the dedicated execution is rejected,
    // whether it reuses the reserved path or presents the execution as a
    // chat.direct one.
    // The reserved path is reported first (pathId); the chat.direct disguise is
    // still caught through the reserved execution ID.
    for (path, field) in [
        ("chat.direct", "executionId"),
        (NIR1_LOCAL_WRITING_PATH_ID, "pathId"),
    ] {
        let mut terminal = generic("inj-1", &execution, "execution.failed");
        terminal.operation_id = operation_id_for_attempt(ATTEMPT).unwrap();
        terminal.path_id = path.to_string();
        let error = db
            .append_ai_audit_events(PROJECT, &[terminal])
            .expect_err("injected terminal is rejected");
        assert_eq!(rejected_field(&error), field, "{path}");
    }
    let mut chained = generic("inj-2", "x-child", "execution.started");
    chained.parent_execution_id = Some(execution);
    let error = db
        .append_ai_audit_events(PROJECT, &[chained])
        .expect_err("chained child is rejected");
    assert_eq!(rejected_field(&error), "parentExecutionId");
    assert_eq!(row_count(&db), 3);
}

#[test]
fn cli_claim_is_unchanged_and_cannot_target_reserved_ids() {
    let db = database();
    let execution = execution_id_for_attempt(ATTEMPT).unwrap();
    let operation = operation_id_for_attempt(ATTEMPT).unwrap();
    let digest = "0".repeat(64);
    let error = db
        .with_conn(|conn| {
            Ok(claim_cli_ai_audit_dispatch_for_scope(
                conn,
                Some(PROJECT),
                &execution,
                &operation,
                None,
                "cli_chat_stream",
                &digest,
            ))
        })
        .unwrap()
        .expect_err("no pre-dispatch evidence exists for a reserved ID");
    assert!(error
        .to_string()
        .contains("AI_AUDIT_DISPATCH_PRECONDITION_FAILED"));
    assert_eq!(row_count(&db), 0);
    // Even with a dedicated execution present, the CLI path cannot touch it.
    dedicated_start(&db, NIR1_LOCAL_REVIEW_PATH_ID, ATTEMPT).unwrap();
    let error = db
        .with_conn(|conn| {
            Ok(claim_cli_ai_audit_dispatch_for_scope(
                conn,
                Some(PROJECT),
                &execution,
                &operation,
                None,
                "cli_chat_stream",
                &digest,
            ))
        })
        .unwrap()
        .expect_err("path mismatch");
    assert!(
        error
            .to_string()
            .contains("AI_AUDIT_DISPATCH_PRECONDITION_FAILED: durable execution identity mismatch"),
        "{error}"
    );
    assert_eq!(row_count(&db), 3);
}
