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
    for bad in ["", ":", "a:", ":a", "a::b", "a b", "a/b", "a\n"] {
        assert!(execution_id_for_attempt(bad).is_err(), "{bad}");
    }
    assert!(event_id_for_attempt(ATTEMPT, "Bad Type").is_err());
    assert!(is_reserved_id(&execution));
}

/// The real attempt ID shape (`attempt_id_for_capture`): a canonical digest.
fn real_attempt_id() -> String {
    let id = grimodex_core::canonical_json_digest(&json!({
        "domain": "nir1-generation-attempt-id@1",
        "captureId": "capture-1",
        "submissionId": "submission-1",
        "submissionDigest": "sha256:00",
    }))
    .expect("digest");
    assert!(id.starts_with("sha256:") && id.len() == 71, "{id}");
    id
}

#[test]
fn derivation_accepts_the_real_sha256_attempt_id_shape() {
    let attempt = real_attempt_id();
    let execution = execution_id_for_attempt(&attempt).unwrap();
    assert_eq!(
        execution,
        format!("nir1-local-generation:execution:{attempt}")
    );
    assert_eq!(
        attempt_id_from_execution_id(&execution),
        Some(attempt.as_str())
    );
    assert_eq!(
        operation_id_for_attempt(&attempt).unwrap(),
        format!("nir1-local-generation:operation:{attempt}")
    );
    assert_eq!(
        event_id_for_attempt(&attempt, "request.prepared").unwrap(),
        format!("nir1-local-generation:event:{attempt}:request.prepared")
    );
    assert!(is_reserved_id(&execution));
    // A longer or malformed colon form is not an attempt ID.
    assert_eq!(
        attempt_id_from_execution_id("nir1-local-generation:execution:sha256:"),
        None
    );
    assert_eq!(
        attempt_id_from_execution_id("nir1-local-generation:execution::a"),
        None
    );
}

#[test]
fn real_attempt_id_passes_dedicated_append_and_generic_append_is_rejected() {
    let db = database();
    let attempt = real_attempt_id();
    dedicated_start(&db, NIR1_LOCAL_WRITING_PATH_ID, &attempt).unwrap();
    assert_eq!(row_count(&db), 3);
    let execution = execution_id_for_attempt(&attempt).unwrap();
    let error = db
        .append_ai_audit_events(
            PROJECT,
            &[generic("pre-real", &execution, "execution.finished")],
        )
        .expect_err("generic append into a real-shaped execution is rejected");
    assert_eq!(rejected_field(&error), "executionId");
    let error = db
        .append_ai_audit_events(
            PROJECT,
            &[generic(
                &event_id_for_attempt(&attempt, "execution.finished").unwrap(),
                "x-other",
                "execution.finished",
            )],
        )
        .expect_err("generic eventId in the namespace is rejected");
    assert_eq!(rejected_field(&error), "eventId");
    assert_eq!(row_count(&db), 3);
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

/// S16: the bounded start / terminal / sweep writers (DT-4 T3). The two
/// `*_audit_contract` tests are the audit contract tests of the two routes
/// (`auditTestName` of the registry).
mod contract {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use grimodex_core::narrative_nir1_receipt::{
        Completion, OutputChannel, OutputObserver, ProviderTerminal, TerminalObservation,
    };
    use grimodex_core::nir1_local_send_policy::{
        decide, Nir1LocalSendPolicyBasis, Nir1LocalSendPolicyDecision, Nir1LocalSendPurpose,
    };
    use grimodex_core::{canonical_json_digest, canonical_json_string};
    use rusqlite::params;
    use serde_json::{json, Value};

    use super::*;
    use crate::ai_audit::{
        read_ai_audit_snapshot_for_scope, verify_ai_audit_chain_for_scope, AiAuditEvent,
    };
    use crate::narrative_maintenance_connection::ParticipantSqlOperationBudget;
    use crate::nir1_generation::history_context::{HistoryContextSlot, HistoryUnavailableReason};
    use crate::nir1_generation::{
        append_local_audit_start_bounded, claim_attempt_bounded, create_attempt_with_id_bounded,
        finish_attempt_bounded, finish_attempt_with_audit_bounded,
        finish_pretransport_attempt_bounded, read_attempt_exact_bounded, recover_attempt_bounded,
        recover_claimed_attempt_bounded, AttemptBinding, AttemptBindingVersion,
        AttemptCallerBinding, AttemptSceneBinding, FailureClassification, GenerationPurpose,
        NewAttempt, NewMessageBody, Nir1AdmissionSqlBudget, Nir1CommitState, Nir1ExpectedAttempt,
        Nir1ExpectedClaim, Nir1GenerationFailpoint, Nir1GenerationStoreError,
        Nir1LocalAuditObserved, Nir1LocalAuditStart, Nir1PinnedSqlBudget, Nir1StoreFailure,
        Nir1ZeroSendCompletion, ReadBudget, StoredAttempt,
    };
    use crate::recovery::SafeModeState;
    use crate::state::{
        active_workspace_snapshot, ActiveWorkspace, ActiveWorkspaceSnapshot, WorkspaceAuthority,
        WorkspaceState,
    };
    use crate::workspace_lifecycle::{LiveBinding, WorkspaceLifecycleCompatibilityView};

    const GEN_PROJECT: &str = "generation-project";
    const SCENE_ID: &str = "generation-scene";
    const SCENE_INCARNATION: &str = "generation-scene-incarnation";
    const SCENE_UPDATED_AT: &str = "2026-10-11 00:00:00";
    const SCENE_BODY: &str = r#"{"type":"doc","content":[]}"#;
    const SOCKET: &str = "127.0.0.1:11434";

    struct Workspace {
        state: WorkspaceState,
        path: PathBuf,
    }

    impl Workspace {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("nir1-local-audit-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("workspace directory");
            let db = fixture_database(&path.join("workspace.db"));
            let authority =
                WorkspaceAuthority::from_database_for_test(db, path.clone()).expect("authority");
            let state = WorkspaceState {
                inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
                safe_mode: SafeModeState::default(),
                switching: WorkspaceLifecycleCompatibilityView::new(false),
                open_lock: Mutex::new(Default::default()),
            };
            state
                .lifecycle_core()
                .set_ready(LiveBinding::new(
                    path.to_string_lossy(),
                    format!("local-audit-test:{}", authority.identity()),
                    authority.identity(),
                    1,
                ))
                .expect("Ready");
            Self { state, path }
        }

        fn snapshot(&self) -> ActiveWorkspaceSnapshot {
            active_workspace_snapshot(&self.state).expect("workspace snapshot")
        }

        fn db(&self) -> crate::state::PinnedWorkspaceDb {
            Arc::clone(self.snapshot().db())
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn fixture_database(path: &Path) -> Database {
        let db = Database::new(path).expect("database");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects(id,title) VALUES (?1,'Project')",
                [GEN_PROJECT],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO tree_nodes
                   (id,project_id,node_type,title,sort_order,content,version,created_at,updated_at)
                 VALUES (?1,?2,'scene','Generation','a0',?3,0,?4,?4)",
                params![SCENE_ID, GEN_PROJECT, SCENE_BODY, SCENE_UPDATED_AT],
            )?;
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                conn,
                GEN_PROJECT,
                SCENE_ID,
                SCENE_UPDATED_AT,
            )?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET scene_incarnation_id=?2
                  WHERE project_id=?3 AND scene_id=?1",
                params![SCENE_ID, SCENE_INCARNATION, GEN_PROJECT],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO chat_sessions(id,project_id,node_id)
                 VALUES ('generation-session',?1,?2)",
                params![GEN_PROJECT, SCENE_ID],
            )?;
            Ok(())
        })
        .expect("fixture");
        db
    }

    fn digest_of(value: &str) -> String {
        canonical_json_digest(&json!(value)).expect("digest")
    }

    fn purpose_path(purpose: &GenerationPurpose) -> &'static str {
        match purpose {
            GenerationPurpose::Writing => NIR1_LOCAL_WRITING_PATH_ID,
            GenerationPurpose::Review => NIR1_LOCAL_REVIEW_PATH_ID,
        }
    }

    fn purpose_name(purpose: &GenerationPurpose) -> &'static str {
        match purpose {
            GenerationPurpose::Writing => "writing",
            GenerationPurpose::Review => "review",
        }
    }

    fn policy_purpose(purpose: &GenerationPurpose) -> Nir1LocalSendPurpose {
        match purpose {
            GenerationPurpose::Writing => Nir1LocalSendPurpose::Writing,
            GenerationPurpose::Review => Nir1LocalSendPurpose::Review,
        }
    }

    fn basis(purpose: &GenerationPurpose) -> Nir1LocalSendPolicyBasis {
        let raw = r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}"#;
        match decide(Some(raw), policy_purpose(purpose)) {
            Nir1LocalSendPolicyDecision::Allowed(basis) => basis,
            other => panic!("the full policy allows: {other:?}"),
        }
    }

    fn request_body() -> Value {
        json!({
            "model": "local-model",
            "messages": [
                {"role": "system", "content": "You write fiction."},
                {"role": "user", "content": "続きを書いて"}
            ],
            "max_tokens": 1024,
            "stream": true,
        })
    }

    fn payload_digest(request: &Value) -> String {
        canonical_json_digest(&json!({
            "domain": "nir1-generation-payload@1",
            "payload": request,
        }))
        .expect("payload digest")
    }

    fn binding(purpose: &GenerationPurpose) -> AttemptBinding {
        AttemptBinding {
            binding_version: AttemptBindingVersion::V2,
            project_id: GEN_PROJECT.into(),
            chat_session_id: "generation-session".into(),
            scene: AttemptSceneBinding {
                scene_id: SCENE_ID.into(),
                scene_incarnation_id: SCENE_INCARNATION.into(),
                source_token: format!("v0@{SCENE_UPDATED_AT}"),
                body_digest: format!(
                    "sha256:{}",
                    hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
                        SCENE_BODY.as_bytes()
                    ))
                ),
            },
            caller: AttemptCallerBinding {
                profile_id: "profile".into(),
                caller_id: "main-caller".into(),
                caller_epoch: 3,
                caller_session_id: "main-caller-session".into(),
            },
            workspace_binding_digest: digest_of("live-workspace-instance"),
            route_revision: "route-1".into(),
            purpose: purpose.clone(),
            scope_digest: digest_of("scope"),
            material_digest: digest_of("material"),
            d1_digest: digest_of("d1"),
            provider: "local".into(),
            model: "local-model".into(),
            api: "chat-completions".into(),
            endpoint_identity: digest_of("loopback-endpoint"),
            // The product create refuses a null history slot (HS-1). These
            // audit tests do not build a history context, so they record the
            // closed reason of a build whose context builder has not run.
            history_turn_context: Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::WorkspaceIdentityUnavailable,
            )),
            durable_workspace_identity: None,
        }
    }

    fn now_ms() -> i64 {
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    }

    fn admission() -> Nir1AdmissionSqlBudget {
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true))
            .for_untimed_test()
    }

    fn pinned() -> Nir1PinnedSqlBudget {
        Nir1PinnedSqlBudget::new().for_untimed_test()
    }

    fn read_budget() -> ReadBudget {
        ReadBudget {
            max_references: 16,
            max_reference_bytes: 16_384,
        }
    }

    struct Fixture {
        attempt: StoredAttempt,
        request: Value,
    }

    impl Fixture {
        fn expected(&self) -> Nir1ExpectedAttempt {
            Nir1ExpectedAttempt::from_stored(&self.attempt, read_budget())
        }

        fn start(&self) -> Nir1LocalAuditStart {
            Nir1LocalAuditStart {
                request: self.request.clone(),
                payload_digest: self.attempt.payload_digest.clone(),
                socket: SOCKET.into(),
                policy_basis: basis(&self.attempt.binding.purpose),
                timestamp_ms: 5_000,
            }
        }
    }

    fn real_attempt_id(seed: &str) -> String {
        canonical_json_digest(&json!({
            "domain": "nir1-generation-attempt-id@1",
            "captureId": seed,
            "submissionId": "submission",
            "submissionDigest": "sha256:00",
        }))
        .expect("attempt id")
    }

    /// A created attempt (not yet claimed).
    fn created(workspace: &Workspace, purpose: &GenerationPurpose, seed: &str) -> Fixture {
        let request = request_body();
        let now = now_ms();
        let attempt = create_attempt_with_id_bounded(
            &workspace.snapshot(),
            &real_attempt_id(seed),
            NewAttempt {
                binding: binding(purpose),
                payload_digest: payload_digest(&request),
                inputs: vec![],
                qualifications: vec![],
                created_at_ms: now,
                expires_at_ms: now + 60_000,
                budget: read_budget(),
            },
            &admission(),
            &mut || Ok(()),
        )
        .expect("create attempt");
        Fixture { attempt, request }
    }

    /// A claimed attempt.
    fn claimed(workspace: &Workspace, purpose: &GenerationPurpose, seed: &str) -> Fixture {
        let fixture = created(workspace, purpose, seed);
        claim_attempt_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &admission(),
            &mut || Ok(()),
        )
        .expect("claim");
        let attempt = read_attempt_exact_bounded(
            &workspace.snapshot(),
            &fixture.attempt.id,
            read_budget(),
            &pinned(),
        )
        .expect("reread")
        .expect("exists");
        Fixture { attempt, ..fixture }
    }

    fn start(
        workspace: &Workspace,
        fixture: &Fixture,
    ) -> Result<crate::nir1_generation::Nir1LocalAuditStarted, Nir1GenerationStoreError> {
        append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &fixture.start(),
            &admission(),
            &mut || Ok(()),
        )
    }

    fn audit_events(workspace: &Workspace) -> Vec<AiAuditEvent> {
        workspace
            .db()
            .db()
            .with_conn(|conn| {
                Ok(read_ai_audit_snapshot_for_scope(
                    conn,
                    Some(GEN_PROJECT),
                    None,
                    None,
                    Some(1_000),
                )?
                .events)
            })
            .expect("audit events")
    }

    fn types(workspace: &Workspace) -> Vec<String> {
        audit_events(workspace)
            .into_iter()
            .map(|event| event.event_type)
            .collect()
    }

    fn assert_chain_ok(workspace: &Workspace) {
        let verified = workspace
            .db()
            .db()
            .with_conn(|conn| verify_ai_audit_chain_for_scope(conn, Some(GEN_PROJECT), None))
            .expect("verify");
        assert!(verified.ok, "{verified:?}");
    }

    fn attempt_terminal_present(workspace: &Workspace, fixture: &Fixture) -> bool {
        read_attempt_exact_bounded(
            &workspace.snapshot(),
            &fixture.attempt.id,
            read_budget(),
            &pinned(),
        )
        .expect("reread")
        .expect("exists")
        .terminal
        .is_some()
    }

    fn observation(text: &str, thinking: &str, completion: Completion) -> TerminalObservation {
        let mut observer = OutputObserver::new();
        observer
            .observe(OutputChannel::Text, text.as_bytes())
            .unwrap();
        observer
            .observe(OutputChannel::Thinking, thinking.as_bytes())
            .unwrap();
        if matches!(completion, Completion::Parsed) {
            observer
                .observe_terminal(ProviderTerminal::Complete)
                .unwrap();
        }
        observer.finish(completion)
    }

    fn success(
        workspace: &Workspace,
        fixture: &Fixture,
        text: &str,
        thinking: &str,
        budget: &Nir1PinnedSqlBudget,
    ) -> Result<crate::nir1_generation::StoredTerminal, Nir1GenerationStoreError> {
        finish_attempt_with_audit_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &observation(text, thinking, Completion::Parsed),
            Some(NewMessageBody {
                message_id: format!("assistant-{}", fixture.attempt.id),
                content: text.into(),
                thinking: thinking.into(),
            }),
            now_ms(),
            &Nir1LocalAuditObserved {
                text: text.into(),
                thinking: thinking.into(),
                usage: Some(json!({"prompt_tokens": 12, "completion_tokens": 3})),
                finish_reason: Some("stop".into()),
                http_status: Some(200),
            },
            budget,
        )
    }

    fn payload_of<'a>(events: &'a [AiAuditEvent], event_type: &str) -> &'a Value {
        &events
            .iter()
            .find(|event| event.event_type == event_type)
            .unwrap_or_else(|| panic!("{event_type} missing"))
            .payload
    }

    fn assert_store_failure(
        error: &Nir1GenerationStoreError,
        failure: Nir1StoreFailure,
        commit: Nir1CommitState,
    ) {
        assert_eq!(error.failure(), failure, "{error}: {error:#?}");
        assert_eq!(error.commit(), commit, "{error}");
    }

    /// The audit contract of one route: start in one batch, a request that
    /// serializes to the sent body, no credential, a terminal in the attempt's
    /// transaction, nothing after the terminal, and no generic access.
    fn audit_contract(purpose: GenerationPurpose) {
        let path_id = purpose_path(&purpose);
        let workspace = Workspace::new();
        let fixture = claimed(&workspace, &purpose, "contract");

        // Start: three events, one transaction, in the validator's order.
        let started = start(&workspace, &fixture).expect("start");
        assert_eq!(started.inserted_count, 3);
        assert_eq!(
            started.execution_id,
            execution_id_for_attempt(&fixture.attempt.id).unwrap()
        );
        let events = audit_events(&workspace);
        assert_eq!(
            events
                .iter()
                .map(|e| (e.sequence, e.event_type.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1, "execution.started"),
                (2, "request.prepared"),
                (3, "request.dispatched")
            ]
        );
        for event in &events {
            assert_eq!(event.path_id, path_id);
            assert_eq!(event.execution_id, started.execution_id);
            assert_eq!(
                event.operation_id,
                operation_id_for_attempt(&fixture.attempt.id).unwrap()
            );
            assert_eq!(event.parent_execution_id, None);
            assert!(is_reserved_id(&event.event_id));
            assert_eq!(event.payload["captureState"], "complete");
            assert_eq!(event.payload["attemptId"], fixture.attempt.id.as_str());
        }
        let prepared = payload_of(&events, "request.prepared");
        assert_eq!(prepared["credentialsExcluded"], true);
        assert_eq!(
            prepared["payloadDigest"],
            fixture.attempt.payload_digest.as_str()
        );
        assert_eq!(prepared["socket"], SOCKET);
        assert_eq!(prepared["provider"], "local");
        assert_eq!(prepared["purpose"], purpose_name(&purpose));
        assert_eq!(prepared["route"]["pathId"], path_id);
        assert_eq!(prepared["policyBasis"]["purpose"], purpose_name(&purpose));
        assert_eq!(prepared["policyBasis"]["source"], "stored");
        // D-final: serializing the audited request value as canonical JSON
        // yields exactly the body that was sent, and its digest is the
        // attempt's payload digest.
        let audited = &prepared["request"]["body"];
        assert_eq!(
            canonical_json_string(audited).unwrap(),
            canonical_json_string(&fixture.request).unwrap()
        );
        assert_eq!(payload_digest(audited), fixture.attempt.payload_digest);
        // Nothing but the request body can hold a credential-shaped key.
        let mut without_request = prepared.clone();
        without_request.as_object_mut().unwrap().remove("request");
        assert!(!without_request
            .to_string()
            .to_lowercase()
            .contains("authorization"));
        // `request.dispatched` is a hand-off record, never delivery evidence.
        assert_eq!(
            payload_of(&events, "request.dispatched")["handoffOnly"],
            true
        );
        assert_chain_ok(&workspace);

        // The start is idempotent (identical events are skipped).
        assert_eq!(start(&workspace, &fixture).unwrap().inserted_count, 0);
        assert_eq!(audit_events(&workspace).len(), 3);

        // Success: response.completed then execution.succeeded, in the same
        // transaction as the attempt terminal.
        assert!(!attempt_terminal_present(&workspace, &fixture));
        let terminal =
            success(&workspace, &fixture, "本文です", "考え中", &pinned()).expect("success");
        assert!(terminal.message_version.is_some());
        let events = audit_events(&workspace);
        assert_eq!(
            events
                .iter()
                .map(|e| e.event_type.as_str())
                .collect::<Vec<_>>(),
            vec![
                "execution.started",
                "request.prepared",
                "request.dispatched",
                "response.completed",
                "execution.succeeded"
            ]
        );
        let completed = payload_of(&events, "response.completed");
        assert_eq!(completed["response"]["text"], "本文です");
        assert_eq!(completed["response"]["thinking"], "考え中");
        assert_eq!(completed["response"]["finishReason"], "stop");
        assert_eq!(completed["response"]["usage"]["prompt_tokens"], 12);
        let succeeded = payload_of(&events, "execution.succeeded");
        assert_eq!(succeeded["terminalStatus"], "succeeded");
        assert_eq!(succeeded["captureState"], "complete");
        assert_chain_ok(&workspace);

        // After the terminal nothing can be appended: not by the dedicated
        // append, not by the generic one, not by a repeated finish.
        let after = [reserved(path_id, &fixture.attempt.id, "response.partial")];
        let error = workspace
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let result = append_reserved_events_in_transaction(conn, GEN_PROJECT, &after);
                let _ = conn.execute_batch("ROLLBACK");
                Ok(result)
            })
            .unwrap()
            .expect_err("terminal execution");
        assert!(
            error.to_string().contains("already reached terminal"),
            "{error}"
        );
        let generic = workspace
            .db()
            .db()
            .append_ai_audit_events_for_scope(Some(GEN_PROJECT), &after);
        assert!(generic.is_err());
        let again = success(&workspace, &fixture, "本文です", "考え中", &pinned())
            .expect("an identical repeated terminal returns the stored one");
        assert_eq!(again.receipt_digest, terminal.receipt_digest);
        assert_eq!(audit_events(&workspace).len(), 5);
        // A sweep finds nothing to do for the finished attempt.
        recover_attempt_bounded(
            &workspace.snapshot(),
            &fixture.attempt.id,
            now_ms(),
            ParticipantSqlOperationBudget::new(
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(10),
                Duration::from_millis(100),
            ),
        )
        .expect("sweep");
        assert_eq!(audit_events(&workspace).len(), 5);
    }

    #[test]
    fn nir1_local_writing_audit_contract() {
        audit_contract(GenerationPurpose::Writing);
    }

    #[test]
    fn nir1_local_review_audit_contract() {
        audit_contract(GenerationPurpose::Review);
    }

    #[test]
    fn failure_and_cancel_close_with_the_partial_response_they_observed() {
        for purpose in [GenerationPurpose::Writing, GenerationPurpose::Review] {
            let workspace = Workspace::new();
            let failed = claimed(&workspace, &purpose, "failed");
            start(&workspace, &failed).unwrap();
            let terminal = finish_attempt_with_audit_bounded(
                &workspace.snapshot(),
                &failed.expected(),
                &observation("途中", "思考", Completion::UnexpectedEof),
                None,
                now_ms(),
                &Nir1LocalAuditObserved {
                    text: "途中".into(),
                    thinking: "思考".into(),
                    http_status: Some(200),
                    ..Default::default()
                },
                &pinned(),
            )
            .expect("failed finish");
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::InvalidOutput)
            );
            let events = audit_events(&workspace);
            let tail: Vec<_> = events
                .iter()
                .skip(3)
                .map(|e| e.event_type.as_str())
                .collect();
            assert_eq!(tail, vec!["response.partial", "execution.failed"]);
            assert_eq!(
                payload_of(&events, "response.partial")["captureState"],
                "partial"
            );
            assert_eq!(
                payload_of(&events, "response.partial")["response"]["text"],
                "途中"
            );
            let closing = payload_of(&events, "execution.failed");
            assert_eq!(closing["terminalStatus"], "failed");
            assert_eq!(closing["httpStatus"], 200);
            assert_eq!(closing["remoteOutcome"], "observed");
            assert_chain_ok(&workspace);

            // Cancelled with nothing observed: no response.partial.
            let cancelled = claimed(&workspace, &purpose, "cancelled");
            start(&workspace, &cancelled).unwrap();
            finish_attempt_with_audit_bounded(
                &workspace.snapshot(),
                &cancelled.expected(),
                &observation("", "", Completion::Cancelled),
                None,
                now_ms(),
                &Nir1LocalAuditObserved::default(),
                &pinned(),
            )
            .expect("cancelled finish");
            let events = audit_events(&workspace);
            let tail: Vec<_> = events
                .iter()
                .skip(5)
                .map(|e| e.event_type.as_str())
                .collect();
            assert_eq!(
                tail,
                vec![
                    "execution.started",
                    "request.prepared",
                    "request.dispatched",
                    "execution.cancelled"
                ]
            );
            assert_chain_ok(&workspace);
        }
    }

    #[test]
    fn observed_data_must_match_the_terminal_observation_and_nothing_is_written() {
        let workspace = Workspace::new();
        let fixture = claimed(&workspace, &GenerationPurpose::Writing, "mismatch");
        start(&workspace, &fixture).unwrap();
        let error = finish_attempt_with_audit_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &observation("a", "", Completion::Cancelled),
            None,
            now_ms(),
            &Nir1LocalAuditObserved {
                text: "different".into(),
                ..Default::default()
            },
            &pinned(),
        )
        .expect_err("audit data that is not what was observed");
        assert_store_failure(
            &error,
            Nir1StoreFailure::Invalid,
            Nir1CommitState::NotCommitted,
        );
        assert!(!attempt_terminal_present(&workspace, &fixture));
        assert_eq!(types(&workspace).len(), 3);
    }

    #[test]
    fn zero_send_and_data_less_terminals_close_conservatively() {
        let workspace = Workspace::new();
        // Zero send after the start (the connection / verification failed).
        let zero = claimed(&workspace, &GenerationPurpose::Writing, "zero");
        start(&workspace, &zero).unwrap();
        let claimed_at = zero.attempt.claimed_at_ms.expect("claimed");
        finish_pretransport_attempt_bounded(
            &workspace.snapshot(),
            &zero.expected(),
            Nir1ExpectedClaim::ClaimedAt(claimed_at),
            Nir1ZeroSendCompletion::DispatchFailure,
            &pinned(),
        )
        .expect("zero send");
        let events = audit_events(&workspace);
        assert_eq!(events.last().unwrap().event_type, "execution.failed");
        let closing = &events.last().unwrap().payload;
        assert_eq!(closing["remoteOutcome"], "not-sent");
        assert_eq!(closing["classification"], "dispatch-unavailable");
        assert_eq!(closing["responseObserved"], false);

        // A cancelled zero send closes as cancelled.
        let cancelled = claimed(&workspace, &GenerationPurpose::Review, "zero-cancel");
        start(&workspace, &cancelled).unwrap();
        finish_pretransport_attempt_bounded(
            &workspace.snapshot(),
            &cancelled.expected(),
            Nir1ExpectedClaim::ClaimedAt(cancelled.attempt.claimed_at_ms.unwrap()),
            Nir1ZeroSendCompletion::Cancelled,
            &pinned(),
        )
        .expect("cancelled zero send");
        assert_eq!(types(&workspace).last().unwrap(), "execution.cancelled");

        // A post-transport terminal without audit data (conservative).
        let plain = claimed(&workspace, &GenerationPurpose::Writing, "plain");
        start(&workspace, &plain).unwrap();
        finish_attempt_bounded(
            &workspace.snapshot(),
            &plain.expected(),
            &observation("", "", Completion::DispatchFailure),
            None,
            now_ms(),
            &pinned(),
        )
        .expect("data-less finish");
        let events = audit_events(&workspace);
        assert_eq!(events.last().unwrap().event_type, "execution.failed");
        assert_eq!(events.last().unwrap().payload["remoteOutcome"], "unknown");
        assert_eq!(events.last().unwrap().payload["conservative"], true);

        // A data-less success of a started execution is rejected as a whole
        // transaction (it must go through `*_with_audit`): the attempt stays
        // unfinished, no audit event is written, and the claimed recover then
        // closes the execution conservatively.
        let silent = claimed(&workspace, &GenerationPurpose::Writing, "silent-success");
        start(&workspace, &silent).unwrap();
        let before = audit_events(&workspace).len();
        let error = finish_attempt_bounded(
            &workspace.snapshot(),
            &silent.expected(),
            &observation("x", "", Completion::Parsed),
            Some(NewMessageBody {
                message_id: "assistant-silent".into(),
                content: "x".into(),
                thinking: String::new(),
            }),
            now_ms(),
            &pinned(),
        )
        .expect_err("data-less success of a started execution");
        assert_store_failure(
            &error,
            Nir1StoreFailure::Invalid,
            Nir1CommitState::NotCommitted,
        );
        assert_eq!(audit_events(&workspace).len(), before);
        assert!(!attempt_terminal_present(&workspace, &silent));
        let recovered =
            recover_claimed_attempt_bounded(&workspace.snapshot(), &silent.expected(), &pinned())
                .expect("recover after the rejection");
        assert_eq!(
            recovered.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        let events = audit_events(&workspace);
        assert_eq!(events.last().unwrap().event_type, "execution.failed");
        assert_eq!(events.last().unwrap().payload["conservative"], true);
        assert_eq!(events.last().unwrap().payload["source"], "recovery");
        assert_ne!(
            events.last().unwrap().payload["classification"],
            "audit-data-missing"
        );

        // The same success through the audit-aware writer is accepted.
        let audited = claimed(&workspace, &GenerationPurpose::Writing, "audited-success");
        start(&workspace, &audited).unwrap();
        success(&workspace, &audited, "x", "", &pinned()).expect("audited success");
        assert_eq!(types(&workspace).last().unwrap(), "execution.succeeded");

        // An attempt whose execution was never started keeps the data-less
        // success path (DT-2 owner tests use it); no audit event is written.
        let unaudited = claimed(&workspace, &GenerationPurpose::Writing, "unaudited-success");
        let before = audit_events(&workspace).len();
        finish_attempt_bounded(
            &workspace.snapshot(),
            &unaudited.expected(),
            &observation("x", "", Completion::Parsed),
            Some(NewMessageBody {
                message_id: "assistant-unaudited".into(),
                content: "x".into(),
                thinking: String::new(),
            }),
            now_ms(),
            &pinned(),
        )
        .expect("data-less success without a started execution");
        assert!(attempt_terminal_present(&workspace, &unaudited));
        assert_eq!(audit_events(&workspace).len(), before);
        assert_chain_ok(&workspace);
    }

    #[test]
    fn sweep_closes_a_started_execution_once_and_never_an_execution_less_attempt() {
        let workspace = Workspace::new();
        let with_execution = claimed(&workspace, &GenerationPurpose::Writing, "sweep-a");
        start(&workspace, &with_execution).unwrap();
        let without_execution = claimed(&workspace, &GenerationPurpose::Review, "sweep-b");
        let unclaimed = created(&workspace, &GenerationPurpose::Review, "sweep-c");
        let sweep = |id: &str| {
            recover_attempt_bounded(
                &workspace.snapshot(),
                id,
                now_ms(),
                ParticipantSqlOperationBudget::new(
                    Arc::new(AtomicBool::new(false)),
                    Instant::now() + Duration::from_secs(10),
                    Duration::from_millis(100),
                ),
            )
            .expect("sweep")
        };
        let terminal = sweep(&with_execution.attempt.id);
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        let events = audit_events(&workspace);
        assert_eq!(
            events
                .iter()
                .map(|e| e.event_type.as_str())
                .collect::<Vec<_>>(),
            vec![
                "execution.started",
                "request.prepared",
                "request.dispatched",
                "execution.failed"
            ]
        );
        let closing = &events.last().unwrap().payload;
        assert_eq!(closing["classification"], "interrupted-unknown");
        assert_eq!(closing["remoteOutcome"], "unknown");
        assert_eq!(closing["responseObserved"], false);
        assert_eq!(closing["source"], "recovery");
        // Re-running changes nothing; the attempts without an execution get no
        // audit event, claimed or not.
        sweep(&with_execution.attempt.id);
        sweep(&without_execution.attempt.id);
        sweep(&unclaimed.attempt.id);
        assert_eq!(audit_events(&workspace).len(), 4);
        assert!(attempt_terminal_present(&workspace, &without_execution));
        assert!(attempt_terminal_present(&workspace, &unclaimed));
        assert_chain_ok(&workspace);

        // recover_claimed (the owner's own cleanup) closes the same way.
        let owned = claimed(&workspace, &GenerationPurpose::Review, "sweep-d");
        start(&workspace, &owned).unwrap();
        recover_claimed_attempt_bounded(&workspace.snapshot(), &owned.expected(), &pinned())
            .expect("recover claimed");
        let events = audit_events(&workspace);
        assert_eq!(events.last().unwrap().event_type, "execution.failed");
        assert_eq!(events.len(), 8);
        assert_eq!(events.last().unwrap().path_id, NIR1_LOCAL_REVIEW_PATH_ID);
    }

    #[test]
    fn a_terminal_that_already_closed_the_execution_is_not_closed_twice() {
        let workspace = Workspace::new();
        let fixture = claimed(&workspace, &GenerationPurpose::Writing, "twice");
        start(&workspace, &fixture).unwrap();
        success(&workspace, &fixture, "x", "", &pinned()).unwrap();
        assert_eq!(audit_events(&workspace).len(), 5);
        // A repeated conservative recovery of the finished attempt returns the
        // stored terminal and writes nothing.
        recover_claimed_attempt_bounded(&workspace.snapshot(), &fixture.expected(), &pinned())
            .expect("recover");
        assert_eq!(audit_events(&workspace).len(), 5);
    }

    #[test]
    fn start_requires_a_claimed_unfinished_attempt_with_the_stored_digest() {
        let workspace = Workspace::new();
        // Unclaimed.
        let unclaimed = created(&workspace, &GenerationPurpose::Writing, "unclaimed");
        let error = start(&workspace, &unclaimed).expect_err("unclaimed");
        assert_store_failure(
            &error,
            Nir1StoreFailure::ClaimMismatch,
            Nir1CommitState::NotCommitted,
        );

        let fixture = claimed(&workspace, &GenerationPurpose::Writing, "digest");
        // A digest that is not the stored one.
        let mut other = fixture.start();
        other.payload_digest = digest_of("other payload");
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &other,
            &admission(),
            &mut || Ok(()),
        )
        .expect_err("digest mismatch");
        assert_store_failure(
            &error,
            Nir1StoreFailure::Conflict,
            Nir1CommitState::NotCommitted,
        );
        // A request whose digest is not the stored one, even with the right
        // digest string handed in.
        let mut other = fixture.start();
        other.request = json!({"model": "other"});
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &other,
            &admission(),
            &mut || Ok(()),
        )
        .expect_err("request is not the bound payload");
        assert_store_failure(
            &error,
            Nir1StoreFailure::Conflict,
            Nir1CommitState::NotCommitted,
        );
        // The policy basis of the other purpose.
        let mut other = fixture.start();
        other.policy_basis = basis(&GenerationPurpose::Review);
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &other,
            &admission(),
            &mut || Ok(()),
        )
        .expect_err("purpose mismatch");
        assert_store_failure(
            &error,
            Nir1StoreFailure::Invalid,
            Nir1CommitState::NotCommitted,
        );
        // An invalid socket and a negative time.
        for mutate in [
            (|s: &mut Nir1LocalAuditStart| s.socket = String::new()) as fn(&mut _),
            |s| s.socket = "a\nb".into(),
            |s| s.timestamp_ms = -1,
            |s| s.request = json!([1]),
        ] {
            let mut other = fixture.start();
            mutate(&mut other);
            assert!(append_local_audit_start_bounded(
                &workspace.snapshot(),
                &fixture.expected(),
                &other,
                &admission(),
                &mut || Ok(()),
            )
            .is_err());
        }
        assert!(audit_events(&workspace).is_empty());

        // After the attempt terminal there is no start.
        recover_claimed_attempt_bounded(&workspace.snapshot(), &fixture.expected(), &pinned())
            .unwrap();
        let error = start(&workspace, &fixture).expect_err("terminal attempt");
        assert_store_failure(
            &error,
            Nir1StoreFailure::TerminalConflict,
            Nir1CommitState::NotCommitted,
        );
        assert!(audit_events(&workspace).is_empty());
    }

    #[test]
    fn a_start_that_cannot_be_written_in_the_limits_is_a_typed_failure_with_no_event() {
        let workspace = Workspace::new();
        let fixture = claimed(&workspace, &GenerationPurpose::Writing, "limits");
        {
            // The connection mutex held elsewhere: the plan's 100 ms wait.
            let db = workspace.db();
            let _held = db.lock().expect("hold the connection mutex");
            let production =
                Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true));
            let began = Instant::now();
            let error = append_local_audit_start_bounded(
                &workspace.snapshot(),
                &fixture.expected(),
                &fixture.start(),
                &production,
                &mut || Ok(()),
            )
            .expect_err("held mutex");
            assert_store_failure(
                &error,
                Nir1StoreFailure::ConnectionBusy,
                Nir1CommitState::NotCommitted,
            );
            assert!(began.elapsed() < Duration::from_millis(1_000));
        }
        // A cancelled owner and a closed admission also stop the start.
        let cancelled =
            Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(true)), Arc::new(|| true))
                .for_untimed_test();
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &fixture.start(),
            &cancelled,
            &mut || Ok(()),
        )
        .expect_err("cancelled");
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted);
        let closed =
            Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| false))
                .for_untimed_test();
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &fixture.start(),
            &closed,
            &mut || Ok(()),
        )
        .expect_err("closed admission");
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted);
        // A refusing pre-commit check rolls the three events back.
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &fixture.start(),
            &admission(),
            &mut || anyhow::bail!("profile permit lost"),
        )
        .expect_err("pre-commit refusal");
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted);
        assert!(audit_events(&workspace).is_empty());
        // And the start still works afterwards (the connection is reusable).
        start(&workspace, &fixture).expect("start after the failures");
        assert_eq!(audit_events(&workspace).len(), 3);
    }

    #[test]
    fn start_commit_outcomes_are_classified_and_a_later_terminal_closes_a_durable_start() {
        let workspace = Workspace::new();
        // The commit is vetoed: the outcome is Unknown to the writer, nothing
        // is durable.
        let vetoed = claimed(&workspace, &GenerationPurpose::Writing, "veto");
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &vetoed.expected(),
            &vetoed.start(),
            &admission().with_failpoint(Nir1GenerationFailpoint::VetoCommit),
            &mut || Ok(()),
        )
        .expect_err("vetoed commit");
        assert_eq!(error.commit(), Nir1CommitState::Unknown);
        assert!(audit_events(&workspace).is_empty());

        // The commit applied but the writer reports an error: Unknown, and the
        // three events are durable. The caller sends nothing; its zero-send
        // terminal closes the execution in the same transaction.
        let durable = claimed(&workspace, &GenerationPurpose::Review, "after-commit");
        let error = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &durable.expected(),
            &durable.start(),
            &admission().with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
            &mut || Ok(()),
        )
        .expect_err("commit applied, outcome unknown");
        assert_eq!(error.commit(), Nir1CommitState::Unknown);
        assert_eq!(audit_events(&workspace).len(), 3);
        finish_pretransport_attempt_bounded(
            &workspace.snapshot(),
            &durable.expected(),
            Nir1ExpectedClaim::ClaimedAt(durable.attempt.claimed_at_ms.unwrap()),
            Nir1ZeroSendCompletion::DispatchFailure,
            &pinned(),
        )
        .expect("zero-send terminal");
        assert_eq!(types(&workspace).last().unwrap(), "execution.failed");
        assert_chain_ok(&workspace);
    }

    #[test]
    fn the_attempt_terminal_and_the_audit_terminal_commit_or_roll_back_together() {
        let workspace = Workspace::new();
        let fixture = claimed(&workspace, &GenerationPurpose::Writing, "atomic");
        start(&workspace, &fixture).unwrap();
        let pinned_veto = pinned().with_failpoint(Nir1GenerationFailpoint::VetoCommit);
        let error =
            success(&workspace, &fixture, "本文", "", &pinned_veto).expect_err("vetoed commit");
        assert_eq!(error.commit(), Nir1CommitState::Unknown);
        // Neither half is durable.
        assert!(!attempt_terminal_present(&workspace, &fixture));
        assert_eq!(audit_events(&workspace).len(), 3);
        // The commit applied: both halves are durable, never one.
        let pinned_after = pinned().with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit);
        let error = success(&workspace, &fixture, "本文", "", &pinned_after)
            .expect_err("commit applied, outcome unknown");
        assert_eq!(error.commit(), Nir1CommitState::Unknown);
        assert!(attempt_terminal_present(&workspace, &fixture));
        assert_eq!(
            types(&workspace).last().map(String::as_str),
            Some("execution.succeeded")
        );
        assert_eq!(audit_events(&workspace).len(), 5);
        assert_chain_ok(&workspace);
    }

    /// The plan's own limits in an optimized build (the production one); the
    /// untimed test limit in a debug build, where unoptimized JSON and hashing
    /// are an order of magnitude slower than the product and the 250 ms limit
    /// says nothing about it.
    fn measured_pinned() -> Nir1PinnedSqlBudget {
        if cfg!(debug_assertions) {
            pinned()
        } else {
            Nir1PinnedSqlBudget::new()
        }
    }

    fn measured_admission() -> Nir1AdmissionSqlBudget {
        if cfg!(debug_assertions) {
            admission()
        } else {
            Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true))
        }
    }

    fn assert_within_plan_limit(elapsed: Duration) {
        if !cfg!(debug_assertions) {
            assert!(elapsed < Duration::from_millis(250), "{elapsed:?}");
        }
    }

    /// The largest success the route can record, written under the plan's own
    /// limits (mutex 100 ms, busy 100 ms, operation 250 ms), not the untimed
    /// test limit. Text and thinking are each at the storage ceiling
    /// (`MAX_MESSAGE_BODY_BYTES`, 2 MiB); the stored thinking metadata wraps
    /// the thinking in JSON and must also fit 2 MiB, so the thinking is the
    /// ceiling less the wrapper.
    #[test]
    fn the_largest_success_terminal_fits_the_operation_limit() {
        let workspace = Workspace::new();
        let text = "あ".repeat((2 * 1024 * 1024) / 3);
        let thinking = "x".repeat(2 * 1024 * 1024 - 64);
        // Baseline: the same terminal of an attempt that has no execution
        // (no audit event is written), under the untimed test limit.
        let plain = claimed(&workspace, &GenerationPurpose::Writing, "largest-plain");
        let began = Instant::now();
        success(&workspace, &plain, &text, &thinking, &pinned()).expect("baseline");
        eprintln!(
            "NIR1_LOCAL_AUDIT_MEASURE largest-success-terminal-without-execution-ms={}",
            began.elapsed().as_millis()
        );
        assert!(audit_events(&workspace).is_empty());
        let fixture = claimed(&workspace, &GenerationPurpose::Writing, "largest");
        start(&workspace, &fixture).unwrap();
        let began = Instant::now();
        let result = success(&workspace, &fixture, &text, &thinking, &measured_pinned());
        let elapsed = began.elapsed();
        eprintln!(
            "NIR1_LOCAL_AUDIT_MEASURE largest-success-terminal-ms={}",
            elapsed.as_millis()
        );
        result.expect("the largest success fits the plan's 250 ms operation limit");
        assert_within_plan_limit(elapsed);
        assert_eq!(types(&workspace).last().unwrap(), "execution.succeeded");
        assert_chain_ok(&workspace);
    }

    /// The start of a large request (the prompt may be large) under the plan's
    /// limits.
    #[test]
    fn a_large_start_fits_the_operation_limit() {
        let workspace = Workspace::new();
        let purpose = GenerationPurpose::Writing;
        let mut request = request_body();
        request["messages"][1]["content"] = Value::String("あ".repeat(512 * 1024));
        let now = now_ms();
        let attempt = create_attempt_with_id_bounded(
            &workspace.snapshot(),
            &real_attempt_id("large-start"),
            NewAttempt {
                binding: binding(&purpose),
                payload_digest: payload_digest(&request),
                inputs: vec![],
                qualifications: vec![],
                created_at_ms: now,
                expires_at_ms: now + 60_000,
                budget: read_budget(),
            },
            &admission(),
            &mut || Ok(()),
        )
        .unwrap();
        let fixture = Fixture { attempt, request };
        claim_attempt_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &admission(),
            &mut || Ok(()),
        )
        .unwrap();
        let production = measured_admission();
        let began = Instant::now();
        let result = append_local_audit_start_bounded(
            &workspace.snapshot(),
            &fixture.expected(),
            &fixture.start(),
            &production,
            &mut || Ok(()),
        );
        let elapsed = began.elapsed();
        eprintln!(
            "NIR1_LOCAL_AUDIT_MEASURE large-start-1.5MiB-ms={}",
            elapsed.as_millis()
        );
        result.expect("a large start fits the plan's limits");
        assert_within_plan_limit(elapsed);
    }
}
