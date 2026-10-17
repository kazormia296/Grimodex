use super::*;
use crate::narrative_extraction::nir1_entity_relation_index::NeverStopGraphWorkControl;
use crate::narrative_extraction::{ValidationTerminated, ValidationTerminationReason};
use crate::recovery::SafeModeState;
use crate::state::{
    active_workspace_snapshot, ActiveWorkspace, ActiveWorkspaceSnapshot, WorkspaceAuthority,
    WorkspaceState,
};
use crate::workspace_lifecycle::{LiveBinding, WorkspaceLifecycleCompatibilityView};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Barrier, Mutex,
};

fn budget() -> ReadBudget {
    ReadBudget {
        max_references: 16,
        max_reference_bytes: 16_384,
    }
}

fn test_digest(value: &str) -> String {
    canonical_json_digest(&json!(value)).expect("test digest")
}

/// The Scene that generic attempts bind. The Native A1 writer mints its scope
/// incarnation; the fixture then pins that opaque value so `binding()` stays
/// a pure helper. Storage only compares it exactly.
const GENERATION_SCENE_ID: &str = "generation-scene";
const GENERATION_SCENE_INCARNATION: &str = "generation-scene-incarnation";
const GENERATION_SCENE_UPDATED_AT: &str = "2026-10-11 00:00:00";
const GENERATION_SCENE_BODY: &str = r#"{"type":"doc","content":[]}"#;

fn database(path: &Path) -> Database {
    let db = Database::new(path).expect("database");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute("INSERT OR IGNORE INTO projects(id,title) VALUES ('generation-project','Project')",[])?;
        conn.execute(
            "INSERT OR IGNORE INTO tree_nodes
               (id,project_id,node_type,title,sort_order,content,version,created_at,updated_at)
             VALUES (?1,'generation-project','scene','Generation','a0',?2,0,?3,?3)",
            params![
                GENERATION_SCENE_ID,
                GENERATION_SCENE_BODY,
                GENERATION_SCENE_UPDATED_AT
            ],
        )?;
        crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
            conn,
            "generation-project",
            GENERATION_SCENE_ID,
            GENERATION_SCENE_UPDATED_AT,
        )?;
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET scene_incarnation_id=?2
              WHERE project_id='generation-project' AND scene_id=?1",
            params![GENERATION_SCENE_ID, GENERATION_SCENE_INCARNATION],
        )?;
        conn.execute("INSERT OR IGNORE INTO chat_sessions(id,project_id,node_id) VALUES ('generation-session','generation-project','generation-scene')",[])?;
        Ok(())
    }).expect("fixture");
    db
}

fn history_sql_budget(max_vm_steps: u64) -> GenerationHistorySnapshotSqlBudget {
    GenerationHistorySnapshotSqlBudget {
        max_vm_steps,
        deadline: Instant::now() + Duration::from_secs(30),
        busy_wait: Duration::from_millis(25),
    }
}

fn history_read_budget(
    sql: Option<GenerationHistorySnapshotSqlBudget>,
) -> GenerationHistoryReadBudget {
    GenerationHistoryReadBudget {
        max_attempts: 8,
        sql: sql.map(GenerationHistorySqlLedger::new),
        max_candidates: 8,
        max_reference_count: 16,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    }
}

fn workspace_snapshot() -> (WorkspaceState, ActiveWorkspaceSnapshot) {
    let path = std::env::temp_dir().join(format!(
        "grimodex-generation-sql-budget-{}",
        uuid::Uuid::new_v4()
    ));
    let db = database(Path::new(":memory:"));
    let authority = WorkspaceAuthority::from_database_for_test(db, path).expect("test authority");
    let state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
        safe_mode: SafeModeState::default(),
        switching: WorkspaceLifecycleCompatibilityView::new(false),
        open_lock: Mutex::new(Default::default()),
    };
    state
        .switching
        .core()
        .set_ready(LiveBinding::new(
            authority.path().to_string_lossy(),
            format!("test-workspace:{}", authority.identity()),
            authority.identity(),
            0,
        ))
        .expect("test lifecycle ready");
    let snapshot = active_workspace_snapshot(&state).expect("workspace snapshot");
    (state, snapshot)
}

fn termination_reason(error: &anyhow::Error) -> ValidationTerminationReason {
    error
        .downcast_ref::<ValidationTerminated>()
        .unwrap_or_else(|| panic!("typed termination expected: {error:#}"))
        .reason
}

/// The participant connection must be idle, out of any transaction, and able
/// to serve a fresh bounded snapshot after a refused or interrupted read.
fn assert_snapshot_connection_reusable(workspace: &ActiveWorkspaceSnapshot) {
    let database = workspace.db().db();
    assert!(database.connection_reusable());
    database
        .with_conn(|conn| {
            assert!(conn.is_autocommit());
            assert_eq!(
                conn.query_row("SELECT 3", [], |row| row.get::<_, i64>(0))?,
                3
            );
            Ok(())
        })
        .expect("connection reusable");
    let mut fresh = history_read_budget(Some(history_sql_budget(1_000_000)));
    let value = with_generation_history_snapshot(
        workspace,
        ParticipantSqlControl::default(),
        &mut fresh,
        |reader, _, _| {
            Ok(reader
                .connection
                .query_row("SELECT 4", [], |row| row.get::<_, i64>(0))?)
        },
    )
    .expect("a later bounded snapshot reuses the connection");
    assert_eq!(value, 4);
}

fn with_snapshot<T, F>(
    db: &Database,
    caller_budget: &mut GenerationHistoryReadBudget,
    read_snapshot: F,
) -> Result<T>
where
    F: for<'connection> FnOnce(
        &mut GenerationHistorySnapshotReader<'connection>,
        &mut GenerationHistoryReadBudget,
    ) -> Result<T>,
{
    let control = ParticipantSqlControl::default();
    with_snapshot_control(db, caller_budget, control, read_snapshot)
}

fn with_snapshot_control<T, F>(
    db: &Database,
    caller_budget: &mut GenerationHistoryReadBudget,
    control: ParticipantSqlControl,
    read_snapshot: F,
) -> Result<T>
where
    F: for<'connection> FnOnce(
        &mut GenerationHistorySnapshotReader<'connection>,
        &mut GenerationHistoryReadBudget,
    ) -> Result<T>,
{
    let cancellation = GenerationHistorySnapshotCancellation::from_control(&control);
    db.with_read_transaction(|connection| {
        with_generation_history_snapshot_in_tx(
            connection,
            &cancellation,
            caller_budget,
            read_snapshot,
        )
    })
}

fn generation_scene_binding() -> AttemptSceneBinding {
    AttemptSceneBinding {
        scene_id: GENERATION_SCENE_ID.into(),
        scene_incarnation_id: GENERATION_SCENE_INCARNATION.into(),
        source_token: format!("v0@{GENERATION_SCENE_UPDATED_AT}"),
        body_digest: format!(
            "sha256:{}",
            hex::encode(Sha256::digest(GENERATION_SCENE_BODY.as_bytes()))
        ),
    }
}

fn binding() -> AttemptBinding {
    AttemptBinding {
        binding_version: AttemptBindingVersion::V2,
        project_id: "generation-project".into(),
        chat_session_id: "generation-session".into(),
        scene: generation_scene_binding(),
        caller: AttemptCallerBinding {
            profile_id: "profile".into(),
            caller_id: "main-caller".into(),
            caller_epoch: 3,
            caller_session_id: "main-caller-session".into(),
        },
        workspace_binding_digest: test_digest("live-workspace-instance"),
        route_revision: "route-1".into(),
        purpose: GenerationPurpose::Writing,
        scope_digest: test_digest("scope"),
        material_digest: test_digest("material"),
        d1_digest: test_digest("d1"),
        provider: "local".into(),
        model: "test-model".into(),
        api: "chat-completions".into(),
        endpoint_identity: test_digest("loopback-endpoint"),
        history_turn_context: None,
        durable_workspace_identity: None,
    }
}

/// The product create refuses a null history slot. A test that goes through
/// the bounded (production) create records the closed reason of a build whose
/// context builder has not run.
fn production_slots(mut request: NewAttempt) -> NewAttempt {
    if request.binding.history_turn_context.is_none() {
        request.binding.history_turn_context = Some(HistoryContextSlot::Unavailable(
            HistoryUnavailableReason::WorkspaceIdentityUnavailable,
        ));
    }
    request
}

fn request(inputs: Vec<InputReference>, qualifications: Vec<QualificationReference>) -> NewAttempt {
    NewAttempt {
        binding: binding(),
        payload_digest: test_digest("final payload"),
        inputs,
        qualifications,
        created_at_ms: 1_000,
        expires_at_ms: 10_000,
        budget: budget(),
    }
}

fn human(db: &Database, id: &str, content: &str) -> MessageVersion {
    db.with_conn(|conn| {
        conn.execute("INSERT INTO chat_messages(id,session_id,role,content) VALUES (?1,'generation-session','user',?2)",
            params![id,content])?;
        Ok(())
    }).expect("human body");
    bind_human_message(db, "generation-project", "generation-session", id, 1_000)
        .expect("bind human")
}

#[test]
fn captured_human_message_requires_exact_version_session_and_pre_body_budget() -> Result<()> {
    let db = database(Path::new(":memory:"));
    let version = human(&db, "captured-human", "続けて😀この場面を書いてください。");
    let mut reserved = None;
    let (read_version, body) = db.with_read_transaction(|conn| {
        read_captured_human_message_in_tx(
            conn,
            &version.id,
            "generation-session",
            |id_bytes, body_bytes| {
                reserved = Some((id_bytes, body_bytes));
                Ok(())
            },
        )
    })?;
    assert_eq!(read_version, version);
    assert_eq!(body, "続けて😀この場面を書いてください。");
    assert_eq!(reserved, Some((version.id.len(), body.len())));

    let mut reserve_called = false;
    let error = db
        .with_read_transaction(|conn| {
            read_captured_human_message_in_tx(conn, &version.id, "another-session", |_, _| {
                reserve_called = true;
                Ok(())
            })
        })
        .err()
        .ok_or_else(|| anyhow::anyhow!("cross-session Human version unexpectedly read"))?;
    assert_eq!(
        error.to_string(),
        "NIR1_GENERATION_MESSAGE_SESSION_MISMATCH"
    );
    assert!(!reserve_called);

    let error = db
        .with_read_transaction(|conn| {
            read_captured_human_message_in_tx(conn, &version.id, "generation-session", |_, _| {
                anyhow::bail!("prepared-input budget refused")
            })
        })
        .err()
        .ok_or_else(|| anyhow::anyhow!("Human body read without reserved budget"))?;
    assert_eq!(error.to_string(), "prepared-input budget refused");

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_messages SET content='replaced after capture' WHERE id='captured-human'",
            [],
        )?;
        Ok(())
    })?;
    assert!(db
        .with_read_transaction(|conn| {
            read_captured_human_message_in_tx(
                conn,
                &version.id,
                "generation-session",
                |_, _| Ok(()),
            )
        })
        .is_err());
    Ok(())
}

fn message_input(version: &MessageVersion) -> InputReference {
    InputReference {
        role: if version.origin == MessageOrigin::Human {
            InputRole::User
        } else {
            InputRole::Assistant
        },
        target: InputTarget::Message {
            version_id: version.id.clone(),
            parent_attempt_id: version.parent_attempt_id.clone(),
        },
        input_use: if version.origin == MessageOrigin::Human {
            InputUse::CurrentTurn
        } else {
            InputUse::AdoptedHistory
        },
    }
}

fn completed(text: &str, thinking: &str) -> TerminalObservation {
    let mut observer = OutputObserver::new();
    observer
        .observe(OutputChannel::Text, text.as_bytes())
        .expect("text");
    observer
        .observe(OutputChannel::Thinking, thinking.as_bytes())
        .expect("thinking");
    observer
        .observe_terminal(ProviderTerminal::Complete)
        .expect("terminal");
    observer.finish(Completion::Parsed)
}

fn finish_success(
    db: &Database,
    attempt: &StoredAttempt,
    message: &str,
    text: &str,
) -> StoredTerminal {
    assert!(claim_attempt(db, &attempt.id, &attempt.binding, 1_500, budget()).expect("claim"));
    finish_attempt(
        db,
        &attempt.id,
        &completed(text, ""),
        Some(NewMessageBody {
            message_id: message.into(),
            content: text.into(),
            thinking: String::new(),
        }),
        2_000,
    )
    .expect("finish")
}

#[test]
fn two_level_lineage_keeps_only_adopted_inputs_and_qualification_refs() {
    let db = database(Path::new(":memory:"));
    let input = human(&db, "human-x", "current user input");
    let unrelated = human(&db, "unselected", "never adopted");
    let source = InputReference {
        role: InputRole::Context,
        target: InputTarget::RawSource {
            source_key: "scene:source-x".into(),
            revision_token: "source-v1".into(),
        },
        input_use: InputUse::SelectedMaterial,
    };
    let qualification = QualificationReference::present(
        1,
        QualificationKind::Source,
        "scene:source-x",
        "source-v1",
    );
    let m1 = create_attempt(
        &db,
        request(
            vec![message_input(&input), source],
            vec![qualification.clone()],
        ),
    )
    .expect("M1");
    let m1_terminal = finish_success(&db, &m1, "message-1", "first answer");
    let m1_version = m1_terminal.message_version.expect("M1 version");
    let m2 = create_attempt(&db, request(vec![message_input(&m1_version)], vec![])).expect("M2");
    let m2_terminal = finish_success(&db, &m2, "message-2", "second answer");
    let m2_version =
        read_message_version(&db, &m2_terminal.message_version.expect("M2 version").id)
            .expect("reread");
    assert_eq!(m2_version.parent_attempt_id, Some(m2.id.clone()));
    let saved_m2 = read_attempt(&db, &m2.id, budget()).expect("M2 refs");
    assert_eq!(saved_m2.inputs, vec![message_input(&m1_version)]);
    let saved_m1 = read_attempt(&db, &m1.id, budget()).expect("M1 refs");
    assert_eq!(saved_m1.qualifications, vec![qualification]);
    assert_eq!(saved_m1.inputs.len(), 2);
    assert!(!serde_json::to_string(&saved_m1.inputs)
        .expect("refs JSON")
        .contains(&unrelated.id));
    assert!(
        !serde_json::to_string(&saved_m2.inputs)
            .expect("refs JSON")
            .contains("source-x"),
        "ancestor refs are traversed by parent identity, not copied into every child"
    );
}

/// Two direct snapshot calls that share one caller-owned turn ledger. The
/// first reads an attempt and the second its terminal; a third call is made
/// only after the second was refused, to prove exhaustion persists.
struct HistorySqlPhases {
    first_used: u64,
    total_used: u64,
    result: Result<()>,
    third_callback_started: bool,
    third_error: Option<anyhow::Error>,
    after_third_used: u64,
}

fn run_history_sql_phases(
    workspace: &ActiveWorkspaceSnapshot,
    attempt: &str,
    limit: u64,
) -> HistorySqlPhases {
    let mut caller_budget = history_read_budget(Some(history_sql_budget(limit)));
    let first = with_generation_history_snapshot(
        workspace,
        ParticipantSqlControl::default(),
        &mut caller_budget,
        |reader, budget, _| reader.read_attempt(budget, attempt).map(|_| ()),
    );
    let first_used = caller_budget.sql.as_ref().expect("ledger").sql_steps_used();
    let result = first.and_then(|()| {
        with_generation_history_snapshot(
            workspace,
            ParticipantSqlControl::default(),
            &mut caller_budget,
            |reader, budget, _| reader.read_terminal(budget, attempt).map(|_| ()),
        )
    });
    let total_used = caller_budget.sql.as_ref().expect("ledger").sql_steps_used();
    let third_started = AtomicBool::new(false);
    let third = with_generation_history_snapshot(
        workspace,
        ParticipantSqlControl::default(),
        &mut caller_budget,
        |reader, _, _| {
            third_started.store(true, Ordering::Relaxed);
            Ok(reader
                .connection
                .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?)
        },
    );
    HistorySqlPhases {
        first_used,
        total_used,
        result,
        third_callback_started: third_started.load(Ordering::Relaxed),
        third_error: third.err(),
        after_third_used: caller_budget.sql.as_ref().expect("ledger").sql_steps_used(),
    }
}

#[test]
fn history_snapshot_sql_budget_is_shared_across_direct_calls_and_rejects_n_plus_one() {
    let (_state, workspace) = workspace_snapshot();
    let attempt = create_attempt(workspace.db().db(), request(vec![], vec![]))
        .expect("attempt")
        .id;

    let measured = run_history_sql_phases(&workspace, &attempt, 1_000_000);
    measured.result.expect("measure both SQL phases");
    let exact_n = measured.total_used;
    assert!(measured.first_used > 0 && measured.first_used < exact_n - 1);

    // N: both direct calls fit exactly; the ledger is then fully used, so a
    // third call is refused before its callback or any SQL.
    let exact = run_history_sql_phases(&workspace, &attempt, exact_n);
    exact
        .result
        .expect("exact combined SQL VM work is admitted");
    assert_eq!(exact.total_used, exact_n);
    assert!(!exact.third_callback_started);
    assert_eq!(
        termination_reason(&exact.third_error.expect("used ledger refuses")),
        ValidationTerminationReason::CapacityExceeded
    );
    assert_eq!(exact.after_third_used, exact_n, "refusal must not run SQL");

    // N+1: the first call alone fits, so only the shared, non-reset counter
    // can stop the second call.
    let over = run_history_sql_phases(&workspace, &attempt, exact_n - 1);
    assert_eq!(over.first_used, measured.first_used);
    let error = over
        .result
        .expect_err("the N+1st VM step across calls stops the read");
    assert_eq!(
        termination_reason(&error),
        ValidationTerminationReason::CapacityExceeded
    );
    assert!(!over.third_callback_started);
    assert_eq!(
        over.after_third_used, over.total_used,
        "refusal must not run SQL"
    );
    assert_eq!(
        termination_reason(&over.third_error.expect("exhausted ledger refuses")),
        ValidationTerminationReason::CapacityExceeded
    );
    assert_snapshot_connection_reusable(&workspace);
}

#[test]
fn history_snapshot_in_tx_shares_sql_ledger_and_restores_outer_progress_owner() -> Result<()> {
    let conn = Connection::open_in_memory()?;
    // Load the schema first so every measured call runs the same VM program.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })?;
    conn.execute_batch("BEGIN")?;
    let outer_calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&outer_calls);
    crate::set_sqlite_progress_handler(
        &conn,
        1,
        Some(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )?;
    let cancellation =
        GenerationHistorySnapshotCancellation::from_control(&ParticipantSqlControl::default());
    let select = |budget: &mut GenerationHistoryReadBudget, value: i64| {
        with_generation_history_snapshot_in_tx(&conn, &cancellation, budget, |reader, _| {
            Ok(reader
                .connection
                .query_row(&format!("SELECT {value}"), [], |row| row.get::<_, i64>(0))?)
        })
    };
    let mut measured = history_read_budget(Some(history_sql_budget(1_000_000)));
    select(&mut measured, 1)?;
    let first = measured.sql.as_ref().expect("ledger").sql_steps_used();
    select(&mut measured, 2)?;
    let exact_n = measured.sql.as_ref().expect("ledger").sql_steps_used();
    assert!(first > 0 && first < exact_n);

    let mut exact = history_read_budget(Some(history_sql_budget(exact_n)));
    assert_eq!(select(&mut exact, 1)?, 1);
    assert_eq!(select(&mut exact, 2)?, 2);

    let mut over = history_read_budget(Some(history_sql_budget(exact_n - 1)));
    assert_eq!(select(&mut over, 1)?, 1);
    let error = select(&mut over, 2).expect_err("N+1 across in-tx calls");
    assert_eq!(
        termination_reason(&error),
        ValidationTerminationReason::CapacityExceeded
    );

    // The outer owner keeps observing SQL after each nested capacity scope.
    let before = outer_calls.load(Ordering::Relaxed);
    conn.query_row("SELECT 3", [], |row| row.get::<_, i64>(0))?;
    assert!(outer_calls.load(Ordering::Relaxed) > before);
    conn.execute_batch("ROLLBACK")?;
    crate::set_sqlite_progress_handler(&conn, 0, None::<fn() -> bool>)?;
    Ok(())
}

fn assert_in_tx_rejects_before_sql(
    budget: &mut GenerationHistoryReadBudget,
    control: ParticipantSqlControl,
) -> anyhow::Error {
    let conn = Connection::open_in_memory().expect("open fixture db");
    conn.execute_batch("BEGIN").expect("begin snapshot");
    let progress_calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&progress_calls);
    crate::set_sqlite_progress_handler(
        &conn,
        1,
        Some(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .expect("install test progress owner");
    let cancellation = GenerationHistorySnapshotCancellation::from_control(&control);
    let started = AtomicBool::new(false);
    let error =
        with_generation_history_snapshot_in_tx(&conn, &cancellation, budget, |reader, _| {
            started.store(true, Ordering::Relaxed);
            reader
                .connection
                .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
            Ok(())
        })
        .expect_err("invalid SQL budget must be refused");
    assert!(!started.load(Ordering::Relaxed));
    assert_eq!(progress_calls.load(Ordering::Relaxed), 0, "no SQL ran");
    conn.execute_batch("ROLLBACK").expect("rollback fixture");
    crate::set_sqlite_progress_handler(&conn, 0, None::<fn() -> bool>)
        .expect("clear test progress owner");
    error
}

fn assert_direct_rejects_before_sql(
    workspace: &ActiveWorkspaceSnapshot,
    budget: &mut GenerationHistoryReadBudget,
    control: ParticipantSqlControl,
) -> anyhow::Error {
    let started = AtomicBool::new(false);
    let before = budget
        .sql
        .as_ref()
        .map(GenerationHistorySqlLedger::sql_steps_used);
    let error = with_generation_history_snapshot(workspace, control, budget, |reader, _, _| {
        started.store(true, Ordering::Relaxed);
        reader
            .connection
            .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
        Ok(())
    })
    .expect_err("invalid SQL budget must be refused");
    assert!(!started.load(Ordering::Relaxed));
    assert_eq!(
        budget
            .sql
            .as_ref()
            .map(GenerationHistorySqlLedger::sql_steps_used),
        before
    );
    error
}

#[test]
fn history_snapshot_rejects_missing_zero_expired_or_used_sql_budget_before_sql() {
    let (_state, workspace) = workspace_snapshot();
    let expired_sql = GenerationHistorySnapshotSqlBudget {
        max_vm_steps: 1_000,
        deadline: Instant::now() - Duration::from_millis(1),
        busy_wait: Duration::from_millis(25),
    };
    let expired_owner = || ParticipantSqlControl {
        stop: Arc::new(AtomicBool::new(false)),
        deadline: Some(Instant::now() - Duration::from_millis(1)),
    };
    for direct in [false, true] {
        let reject = |budget: &mut GenerationHistoryReadBudget, control| {
            if direct {
                assert_direct_rejects_before_sql(&workspace, budget, control)
            } else {
                assert_in_tx_rejects_before_sql(budget, control)
            }
        };
        let missing = reject(
            &mut history_read_budget(None),
            ParticipantSqlControl::default(),
        );
        assert!(missing
            .to_string()
            .contains("NIR1_GENERATION_HISTORY_SQL_BUDGET_MISSING"));

        let zero = reject(
            &mut history_read_budget(Some(history_sql_budget(0))),
            ParticipantSqlControl::default(),
        );
        assert!(zero
            .to_string()
            .contains("NIR1_GENERATION_HISTORY_SQL_BUDGET_INVALID"));

        let expired = reject(
            &mut history_read_budget(Some(expired_sql)),
            ParticipantSqlControl::default(),
        );
        assert_eq!(
            termination_reason(&expired),
            ValidationTerminationReason::TimedOut
        );

        // The owner's deadline is also enforced against a future SQL deadline.
        let owner_expired = reject(
            &mut history_read_budget(Some(history_sql_budget(1_000))),
            expired_owner(),
        );
        assert_eq!(
            termination_reason(&owner_expired),
            ValidationTerminationReason::TimedOut
        );

        let stopped = ParticipantSqlControl::default();
        stopped.stop.store(true, Ordering::Release);
        let cancelled = reject(
            &mut history_read_budget(Some(history_sql_budget(1_000))),
            stopped,
        );
        assert_eq!(
            termination_reason(&cancelled),
            ValidationTerminationReason::Cancelled
        );
    }
    assert_snapshot_connection_reusable(&workspace);
}

const HEAVY_HISTORY_SQL: &str = "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<100000000) SELECT sum(n) FROM x";

fn interrupted_snapshot(
    workspace: &ActiveWorkspaceSnapshot,
    sql: GenerationHistorySnapshotSqlBudget,
    control: ParticipantSqlControl,
    stop_before_heavy: bool,
) -> anyhow::Error {
    let mut caller_budget = history_read_budget(Some(sql));
    let first_phase_returned = AtomicBool::new(false);
    let stop = Arc::clone(&control.stop);
    let result =
        with_generation_history_snapshot(workspace, control, &mut caller_budget, |reader, _, _| {
            let first = reader
                .connection
                .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
            first_phase_returned.store(true, Ordering::Relaxed);
            if stop_before_heavy {
                stop.store(true, Ordering::Release);
            }
            let second = reader
                .connection
                .query_row(HEAVY_HISTORY_SQL, [], |row| row.get::<_, i64>(0))?;
            Ok((first, second))
        });
    assert!(first_phase_returned.load(Ordering::Relaxed));
    result.expect_err("the heavy phase must interrupt the whole snapshot")
}

#[test]
fn history_snapshot_interrupts_roll_back_and_leave_connection_reusable() {
    let (_state, workspace) = workspace_snapshot();

    let capacity = interrupted_snapshot(
        &workspace,
        history_sql_budget(10_000),
        ParticipantSqlControl::default(),
        false,
    );
    assert_eq!(
        termination_reason(&capacity),
        ValidationTerminationReason::CapacityExceeded
    );
    assert_snapshot_connection_reusable(&workspace);

    let cancelled = interrupted_snapshot(
        &workspace,
        history_sql_budget(u64::MAX),
        ParticipantSqlControl::default(),
        true,
    );
    assert_eq!(
        termination_reason(&cancelled),
        ValidationTerminationReason::Cancelled
    );
    assert_snapshot_connection_reusable(&workspace);

    let deadline = interrupted_snapshot(
        &workspace,
        GenerationHistorySnapshotSqlBudget {
            max_vm_steps: u64::MAX,
            deadline: Instant::now() + Duration::from_millis(200),
            busy_wait: Duration::from_millis(25),
        },
        ParticipantSqlControl::default(),
        false,
    );
    assert_eq!(
        termination_reason(&deadline),
        ValidationTerminationReason::TimedOut
    );
    assert_snapshot_connection_reusable(&workspace);
}

#[test]
fn history_snapshot_applies_and_restores_caller_busy_wait_bound() -> Result<()> {
    let (_state, workspace) = workspace_snapshot();
    let database = workspace.db().db();
    let busy_timeout = |conn: &Connection| -> Result<i64> {
        Ok(conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?)
    };
    let original = database.with_conn(busy_timeout)?;
    let bounded_wait = Duration::from_millis(31);
    assert_ne!(original, 31);
    let mut caller_budget = history_read_budget(Some(GenerationHistorySnapshotSqlBudget {
        max_vm_steps: 1_000_000,
        deadline: Instant::now() + Duration::from_secs(5),
        busy_wait: bounded_wait,
    }));
    let during_read = with_generation_history_snapshot(
        &workspace,
        ParticipantSqlControl::default(),
        &mut caller_budget,
        |reader, _, _| busy_timeout(reader.connection),
    )?;
    assert_eq!(during_read, 31);
    assert_eq!(database.with_conn(busy_timeout)?, original);

    // A failed read restores the prior timeout as well.
    let mut zero_wait = history_read_budget(Some(GenerationHistorySnapshotSqlBudget {
        max_vm_steps: 1_000_000,
        deadline: Instant::now() + Duration::from_secs(5),
        busy_wait: Duration::ZERO,
    }));
    let error = with_generation_history_snapshot(
        &workspace,
        ParticipantSqlControl::default(),
        &mut zero_wait,
        |reader, _, _| -> Result<()> {
            assert_eq!(busy_timeout(reader.connection)?, 0);
            anyhow::bail!("reader failed after observing busy wait")
        },
    )
    .expect_err("callback failure");
    assert!(error.to_string().contains("reader failed"));
    assert_eq!(database.with_conn(busy_timeout)?, original);
    assert_snapshot_connection_reusable(&workspace);
    Ok(())
}

#[test]
fn history_snapshot_reader_requires_its_exact_active_capacity_scope() -> Result<()> {
    let conn = Connection::open_in_memory()?;
    let owned = CapacityBudget::new(1_000_000, Instant::now() + Duration::from_secs(30));
    let other = CapacityBudget::new(1_000_000, Instant::now() + Duration::from_secs(30));
    let cancellation =
        GenerationHistorySnapshotCancellation::from_control(&ParticipantSqlControl::default());
    let mut caller_budget = history_read_budget(Some(history_sql_budget(1_000_000)));

    // Holding the Arc alone is not proof that the scope is installed.
    let mut outside =
        GenerationHistorySnapshotReader::new(&conn, cancellation.clone(), Arc::clone(&owned));
    let error = outside
        .read_attempt(&mut caller_budget, "attempt")
        .expect_err("reader outside its scope refuses");
    assert!(
        error.to_string().contains("scope is not active"),
        "{error:#}"
    );
    assert_eq!(caller_budget.max_attempts, 8, "refused before any debit");

    with_capacity_scope(
        &conn,
        Some(Arc::clone(&owned)),
        &mut NeverStopGraphWorkControl,
        |active, _| {
            assert!(Arc::ptr_eq(active, &owned));
            check_active_capacity(&conn, &owned)?;
            // Another active scope on the connection is not this reader's.
            let mut wrong = GenerationHistorySnapshotReader::new(
                &conn,
                cancellation.clone(),
                Arc::clone(&other),
            );
            let error = wrong
                .read_terminal(&mut caller_budget, "attempt")
                .expect_err("a different capacity budget is not the active scope");
            assert!(
                error.to_string().contains("scope is not active"),
                "{error:#}"
            );
            let exact = GenerationHistorySnapshotReader::new(
                &conn,
                cancellation.clone(),
                Arc::clone(&owned),
            );
            exact.checkpoint()?;
            Ok(())
        },
    )?;
    // The scope's exit removes the exact budget from the connection.
    assert!(check_active_capacity(&conn, &owned).is_err());

    // An active but exhausted exact budget is refused at the checkpoint.
    let tiny = CapacityBudget::new(1, Instant::now() + Duration::from_secs(30));
    let error = with_capacity_scope(
        &conn,
        Some(Arc::clone(&tiny)),
        &mut NeverStopGraphWorkControl,
        |_, _| {
            let _ = conn.query_row(HEAVY_HISTORY_SQL, [], |row| row.get::<_, i64>(0));
            GenerationHistorySnapshotReader::new(&conn, cancellation.clone(), Arc::clone(&tiny))
                .checkpoint()
        },
    )
    .expect_err("exhausted exact scope");
    assert_eq!(
        termination_reason(&error),
        ValidationTerminationReason::CapacityExceeded
    );
    Ok(())
}

#[test]
fn history_project_authority_rows_share_one_turn_ledger_and_reject_n_plus_one() {
    let mut budget = history_read_budget(Some(history_sql_budget(1_000_000)));
    budget.remaining_project_authority_rows = 2;
    budget
        .consume_project_authority_row()
        .expect("first authority row");
    assert_eq!(budget.remaining_project_authority_rows, 1);
    budget
        .consume_project_authority_row()
        .expect("second authority row in a later operation");
    assert_eq!(budget.remaining_project_authority_rows, 0);
    let error = budget
        .consume_project_authority_row()
        .expect_err("N+1 authority row must fail");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_HISTORY_PROJECT_AUTHORITY_ROW_LIMIT"));
    assert_eq!(budget.remaining_project_authority_rows, 0);

    // A zero allowance fails closed; there is no storage default.
    let mut absent = history_read_budget(Some(history_sql_budget(1_000_000)));
    assert!(absent.consume_project_authority_row().is_err());
}

#[test]
fn history_snapshot_reader_returns_owned_rows_and_reuses_attempt_reads() {
    let db = database(Path::new(":memory:"));
    let input = human(&db, "history-snapshot-human", "snapshot body");
    let attempt =
        create_attempt(&db, request(vec![message_input(&input)], vec![])).expect("attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 2,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let owned = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        let first = reader.read_attempt(budget, &attempt.id)?;
        let cached = reader.read_attempt(budget, &attempt.id)?;
        assert_eq!(first, cached);
        let message = reader.read_message(budget, &input.id)?;
        Ok((first.id, message.content, message.chat_role))
    })
    .expect("same-snapshot typed reads");
    assert_eq!(owned.0, attempt.id);
    assert_eq!(owned.1, "snapshot body");
    assert_eq!(owned.2, "user");
}

#[test]
fn history_snapshot_reader_observes_owner_stop_between_typed_reads() {
    let db = database(Path::new(":memory:"));
    let first = create_attempt(&db, request(vec![], vec![])).expect("first attempt");
    let second = create_attempt(&db, request(vec![], vec![])).expect("second attempt");
    let stop = Arc::new(AtomicBool::new(false));
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 2,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let control = ParticipantSqlControl {
        stop: Arc::clone(&stop),
        deadline: None,
    };
    let error = with_snapshot_control(&db, &mut caller_budget, control, |reader, budget| {
        reader.read_attempt(budget, &first.id)?;
        stop.store(true, Ordering::Release);
        reader.read_attempt(budget, &second.id).map(|_| ())
    })
    .expect_err("owner stop must abort the same snapshot");
    let termination = error
        .downcast_ref::<crate::narrative_extraction::ValidationTerminated>()
        .expect("typed snapshot cancellation");
    assert_eq!(
        termination.reason,
        crate::narrative_extraction::ValidationTerminationReason::Cancelled
    );
    assert!(db.connection_reusable());
    db.with_conn(|conn| {
        assert_eq!(
            conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?,
            1
        );
        Ok(())
    })
    .expect("cancelled snapshot must leave the connection reusable");
}

#[test]
fn history_snapshot_reader_shares_attempt_budget_across_rows() {
    let db = database(Path::new(":memory:"));
    let first = create_attempt(&db, request(vec![], vec![])).expect("first attempt");
    let second = create_attempt(&db, request(vec![], vec![])).expect("second attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 1,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let error = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        reader.read_attempt(budget, &first.id)?;
        reader.read_attempt(budget, &second.id).map(|_| ())
    })
    .expect_err("shared attempt budget");
    assert!(error.to_string().contains("NIR1_GENERATION_HISTORY_LIMIT"));
}

#[test]
fn history_snapshot_reader_negative_caches_missing_attempt_for_shared_candidates() {
    let db = database(Path::new(":memory:"));
    let valid = create_attempt(&db, request(vec![], vec![])).expect("valid attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 2,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    with_snapshot(&db, &mut caller_budget, |reader, budget| {
        for _candidate in 0..2 {
            let error = reader
                .read_attempt(budget, "missing-shared-root")
                .expect_err("missing candidate root");
            assert!(error
                .to_string()
                .contains("NIR1_GENERATION_ATTEMPT_MISSING"));
        }
        assert_eq!(reader.read_attempt(budget, &valid.id)?.id, valid.id);
        Ok(())
    })
    .expect("a shared missing root must not consume the valid candidate's read");
    assert_eq!(caller_budget.max_attempts, 0);
}

#[test]
fn history_snapshot_reader_negative_caches_missing_terminal_for_shared_candidates() {
    let db = database(Path::new(":memory:"));
    let valid = create_attempt(&db, request(vec![], vec![])).expect("valid attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 2,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    with_snapshot(&db, &mut caller_budget, |reader, budget| {
        for _candidate in 0..2 {
            let error = reader
                .read_terminal(budget, "missing-shared-parent")
                .expect_err("missing parent receipt");
            assert!(error
                .to_string()
                .contains("NIR1_GENERATION_ATTEMPT_MISSING"));
        }
        assert_eq!(reader.read_attempt(budget, &valid.id)?.id, valid.id);
        Ok(())
    })
    .expect("a shared missing parent must not consume the valid candidate's read");
    assert_eq!(caller_budget.max_attempts, 0);
}

#[test]
fn history_snapshot_reader_rejects_body_before_materialization_budget() {
    let db = database(Path::new(":memory:"));
    let input = human(&db, "history-budget-human", "body larger than budget");
    let attempt =
        create_attempt(&db, request(vec![message_input(&input)], vec![])).expect("attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 1,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 1,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let error = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        reader.read_message(budget, &input.id).map(|_| ())
    })
    .expect_err("body budget");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_HISTORY_BODY_LIMIT"));
    assert_eq!(
        read_attempt(&db, &attempt.id, budget())
            .expect("attempt remains")
            .id,
        attempt.id
    );
}

#[test]
fn history_snapshot_reader_rejects_attempt_metadata_before_materialization() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 1,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 1,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let error = with_snapshot(&db, &mut caller_budget, |reader, shared_budget| {
        reader.read_attempt(shared_budget, &attempt.id).map(|_| ())
    })
    .expect_err("attempt metadata budget");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_HISTORY_BODY_LIMIT"));
}

#[test]
fn history_snapshot_reader_rejects_terminal_and_version_before_materialization() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let terminal = finish_success(&db, &attempt, "history-budget-terminal", "answer");
    assert!(terminal.message_version.is_some());
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 1,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 1,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let error = with_snapshot(&db, &mut caller_budget, |reader, shared_budget| {
        reader.read_terminal(shared_budget, &attempt.id).map(|_| ())
    })
    .expect_err("terminal/version budget");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_HISTORY_BODY_LIMIT"));
}

#[test]
fn history_snapshot_reader_rejects_oversized_version_identifier_before_fetch() {
    let db = database(Path::new(":memory:"));
    let message_id = "x".repeat(MAX_ID_BYTES + 1);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO chat_messages(id,session_id,role,content)
             VALUES (?1,'generation-session','user','imported')",
            [&message_id],
        )?;
        let (body_digest, role, _) = message_digest_in_tx(
            conn,
            &message_id,
            "generation-project",
            "generation-session",
            |_| Ok(()),
        )?;
        assert_eq!(role, "user");
        conn.execute(
            "INSERT INTO nir1_generation_message_versions
             (id,project_id,session_id,message_id,origin,body_digest,created_at_ms)
             VALUES ('oversized-version','generation-project','generation-session',?1,
                     'human',?2,1000)",
            params![message_id, body_digest],
        )?;
        Ok(())
    })
    .expect("import oversized version identifier");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 1,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    };
    let error = with_snapshot(&db, &mut caller_budget, |reader, shared_budget| {
        reader.read_message(shared_budget, "oversized-version")
    })
    .expect_err("oversized imported message_id");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_MESSAGE_VERSION_LIMIT"));
}

#[test]
fn history_snapshot_reader_and_traversal_share_one_turn_ledger() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 1,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 1,
        remaining_edges: 1,
        remaining_qualification_refs: 1,
    };
    with_snapshot(&db, &mut caller_budget, |reader, shared_budget| {
        shared_budget.consume_node()?;
        reader.read_attempt(shared_budget, &attempt.id)?;
        shared_budget.consume_edge()
    })
    .expect("the same caller ledger admits both debits");
    assert_eq!(caller_budget.remaining_nodes, 0);
    assert_eq!(caller_budget.remaining_edges, 0);

    let error = with_snapshot(&db, &mut caller_budget, |reader, shared_budget| {
        reader.read_attempt(shared_budget, &attempt.id).map(|_| ())
    })
    .expect_err("the caller ledger is not reset for a second snapshot");
    assert!(error.to_string().contains("NIR1_GENERATION_HISTORY_LIMIT"));
}

#[test]
fn concurrent_claims_consume_one_durable_right() {
    let db = Arc::new(database(Path::new(":memory:")));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let barrier = Arc::new(Barrier::new(3));
    let workers = (0..2)
        .map(|_| {
            let db = Arc::clone(&db);
            let barrier = Arc::clone(&barrier);
            let attempt = attempt.clone();
            std::thread::spawn(move || {
                barrier.wait();
                claim_attempt(&db, &attempt.id, &attempt.binding, 1_100, budget()).expect("claim")
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().expect("worker"))
            .filter(|won| *won)
            .count(),
        1
    );
    let terminal = recover_attempt(&db, &attempt.id, 1_200).expect("recover");
    assert_eq!(terminal.observation["terminalStatus"], "failed");
    assert!(
        !claim_attempt(&db, &attempt.id, &attempt.binding, 1_300, budget())
            .expect("consumed claim")
    );
}

#[test]
fn file_backed_restart_terminalizes_prepared_and_claimed_once_without_resend() {
    let directory = std::env::temp_dir().join(format!("nir1-generation-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).expect("directory");
    let path = directory.join("workspace.db");
    let (prepared, claimed) = {
        let db = database(&path);
        let prepared = create_attempt(&db, request(vec![], vec![])).expect("prepared");
        let claimed = create_attempt(&db, request(vec![], vec![])).expect("claimed");
        assert!(claim_attempt(&db, &claimed.id, &claimed.binding, 1_100, budget()).expect("claim"));
        (prepared, claimed)
    };
    {
        let db = database(&path);
        let mut pending = Vec::new();
        loop {
            let page = pending_attempt_ids(
                &db,
                "generation-project",
                pending.last().map(String::as_str),
                1,
            )
            .expect("page");
            if page.is_empty() {
                break;
            }
            pending.extend(page);
        }
        assert_eq!(pending.len(), 2);
        for attempt in [&prepared, &claimed] {
            let first = recover_attempt(&db, &attempt.id, 2_000).expect("recover once");
            let second = recover_attempt(&db, &attempt.id, 3_000).expect("repeat recovery");
            assert_eq!(first, second);
            assert_eq!(first.observation["terminalStatus"], "failed");
            assert_eq!(first.observation["parseStatus"], "not-attempted");
            assert!(first.observation["responseDigest"].is_null());
            assert!(first.observation["providerTerminal"].is_null());
            assert!(
                !claim_attempt(&db, &attempt.id, &attempt.binding, 3_000, budget())
                    .expect("no replay")
            );
        }
        assert!(pending_attempt_ids(&db, "generation-project", None, 1)
            .expect("empty")
            .is_empty());
    }
    std::fs::remove_dir_all(directory).expect("cleanup");
}

#[test]
fn recovery_clamps_regressed_clock_without_relaxing_live_completion() {
    let db = database(Path::new(":memory:"));
    let prepared = create_attempt(&db, request(vec![], vec![])).expect("prepared");
    let claimed = create_attempt(&db, request(vec![], vec![])).expect("claimed");
    assert!(claim_attempt(&db, &claimed.id, &claimed.binding, 1_100, budget()).expect("claim"));
    let failure = OutputObserver::new().finish(Completion::DispatchFailure);
    for (attempt, expected_time) in [(&prepared, 1_000), (&claimed, 1_100)] {
        let error = finish_attempt(&db, &attempt.id, &failure, None, 500)
            .expect_err("live completion still rejects time before creation");
        assert!(error.to_string().contains("NIR1_GENERATION_TIME_MISMATCH"));
        assert!(read_terminal(&db, &attempt.id).expect("pending").is_none());

        let terminal = recover_attempt(&db, &attempt.id, 500).expect("clock-regressed recovery");
        assert_eq!(terminal.completed_at_ms, expected_time);
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        assert_eq!(
            terminal.retry_classification,
            RetryClassification::NewAttemptRequired
        );
        assert_eq!(terminal.observation["terminalStatus"], "failed");
        assert_eq!(terminal.observation["parseStatus"], "not-attempted");
        assert!(terminal.observation["providerTerminal"].is_null());
        assert!(terminal.observation["responseDigest"].is_null());
        assert!(terminal.message_version.is_none());
        assert_eq!(
            read_terminal(&db, &attempt.id).expect("saved"),
            Some(terminal.clone())
        );
        assert_eq!(
            recover_attempt(&db, &attempt.id, 0).expect("idempotent"),
            terminal
        );
        assert!(
            !claim_attempt(&db, &attempt.id, &attempt.binding, 2_000, budget()).expect("no resend")
        );
    }
    assert!(pending_attempt_ids(&db, "generation-project", None, 1)
        .expect("empty")
        .is_empty());
}

#[test]
fn body_and_receipt_commit_together_and_exact_terminal_retry_is_idempotent() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    assert!(claim_attempt(&db, &attempt.id, &attempt.binding, 1_100, budget()).expect("claim"));
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TEMP TRIGGER reject_generation_terminal BEFORE UPDATE OF terminal_json
            ON nir1_generation_attempts WHEN NEW.terminal_json IS NOT NULL
            BEGIN SELECT RAISE(ABORT,'injected terminal write failure'); END;",
        )?;
        Ok(())
    })
    .expect("failpoint");
    let observation = completed("本文🌏", "推論");
    let body = NewMessageBody {
        message_id: "atomic-message".into(),
        content: "本文🌏".into(),
        thinking: "推論".into(),
    };
    assert!(finish_attempt(&db, &attempt.id, &observation, Some(body.clone()), 1_200).is_err());
    db.with_conn(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM chat_messages WHERE id='atomic-message'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM nir1_generation_message_versions",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            0
        );
        conn.execute_batch("DROP TRIGGER reject_generation_terminal")?;
        Ok(())
    })
    .expect("rollback proof");
    assert!(read_terminal(&db, &attempt.id).expect("terminal").is_none());
    let first =
        finish_attempt(&db, &attempt.id, &observation, Some(body.clone()), 1_300).expect("commit");
    let second = finish_attempt(&db, &attempt.id, &observation, Some(body), 1_400).expect("retry");
    assert_eq!(first, second);
    assert!(finish_attempt(
        &db,
        &attempt.id,
        &OutputObserver::new().finish(Completion::Cancelled),
        None,
        1_500
    )
    .is_err());
    assert_eq!(read_terminal(&db, &attempt.id).expect("saved"), Some(first));
}

#[test]
fn changed_or_deleted_body_cannot_rebind_existing_version_or_receipt() {
    let db = database(Path::new(":memory:"));
    let version = human(&db, "immutable-human", "original");
    let attempt =
        create_attempt(&db, request(vec![message_input(&version)], vec![])).expect("attempt");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_messages SET content='changed' WHERE id='immutable-human'",
            [],
        )?;
        Ok(())
    })
    .expect("external old writer edit");
    assert!(read_message_version(&db, &version.id).is_err());
    assert!(bind_human_message(
        &db,
        "generation-project",
        "generation-session",
        "immutable-human",
        2_000
    )
    .is_err());
    assert!(claim_attempt(&db, &attempt.id, &attempt.binding, 2_000, budget()).is_err());
    db.with_conn(|conn| {
        conn.execute("DELETE FROM chat_messages WHERE id='immutable-human'", [])?;
        Ok(())
    })
    .expect("delete");
    assert!(read_message_version(&db, &version.id).is_err());
    db.with_conn(|conn| { conn.execute("INSERT INTO chat_messages(id,session_id,role,content) VALUES ('immutable-human','generation-session','user','replacement')",[])?; Ok(()) }).expect("ID reuse");
    assert!(bind_human_message(
        &db,
        "generation-project",
        "generation-session",
        "immutable-human",
        3_000
    )
    .is_err());
}

#[test]
fn frozen_order_and_joint_child_budget_are_checked_before_claim() {
    let db = database(Path::new(":memory:"));
    let human = human(&db, "budget-human", "input");
    let qualification =
        QualificationReference::present(0, QualificationKind::Source, "source", "version");
    let attempt = create_attempt(
        &db,
        request(vec![message_input(&human)], vec![qualification]),
    )
    .expect("attempt");
    let exact = ReadBudget {
        max_references: 2,
        max_reference_bytes: 16_384,
    };
    assert!(read_attempt(&db, &attempt.id, exact).is_ok());
    assert!(read_attempt(
        &db,
        &attempt.id,
        ReadBudget {
            max_references: 1,
            ..exact
        }
    )
    .is_err());
    assert!(read_attempt(
        &db,
        &attempt.id,
        ReadBudget {
            max_reference_bytes: 1,
            ..exact
        }
    )
    .is_err());
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_input_refs SET ordinal=1 WHERE attempt_id=?1",
            [&attempt.id],
        )?;
        Ok(())
    })
    .expect("simulate corrupted refs");
    assert!(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_100, budget())
            .unwrap_err()
            .to_string()
            .contains("ORDINAL_MISMATCH")
    );
}

#[test]
fn imported_oversized_reference_is_rejected_before_json_materialization() {
    let db = database(Path::new(":memory:"));
    let version = human(&db, "oversized-reference-human", "input");
    let attempt =
        create_attempt(&db, request(vec![message_input(&version)], vec![])).expect("attempt");
    let oversized = format!("\"{}\"", "x".repeat(budget().max_reference_bytes + 1));
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_input_refs SET reference_json=?2 WHERE attempt_id=?1",
            params![attempt.id, oversized],
        )?;
        Ok(())
    })
    .expect("import oversized reference");
    let error = read_attempt(&db, &attempt.id, budget()).expect_err("oversized reference");
    assert!(error.to_string().contains("NIR1_GENERATION_REF_LIMIT"));
}

#[test]
fn file_backed_restored_reference_page_rejects_extra_rows_before_materialization() {
    let directory = std::env::temp_dir().join(format!("nir1-generation-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).expect("directory");
    let path = directory.join("workspace.db");
    let attempt = {
        let db = database(&path);
        let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
        let input_json = serde_json::to_string(&json!({
            "role": "context",
            "target": {
                "kind": "raw-source",
                "sourceKey": "restored-source",
                "revisionToken": "restored-v1"
            }
        }))
        .expect("input JSON");
        let qualification_json = serde_json::to_string(&json!({
            "inputOrdinal": 0,
            "kind": "source",
            "identity": "restored-source",
            "version": "restored-v1"
        }))
        .expect("qualification JSON");
        db.with_conn(|conn| {
            for ordinal in 0_i64..8 {
                conn.execute(
                    "INSERT INTO nir1_generation_input_refs
                     (attempt_id,ordinal,reference_json) VALUES (?1,?2,?3)",
                    params![attempt.id, ordinal, &input_json],
                )?;
            }
            for ordinal in 0_i64..256 {
                conn.execute(
                    "INSERT INTO nir1_generation_qualification_refs
                     (attempt_id,ordinal,reference_json) VALUES (?1,?2,?3)",
                    params![attempt.id, ordinal, &qualification_json],
                )?;
            }
            Ok(())
        })
        .expect("restore reference rows");
        attempt
    };
    {
        let db = database(&path);
        let error = read_attempt(
            &db,
            &attempt.id,
            ReadBudget {
                max_references: 8,
                max_reference_bytes: 16_384,
            },
        )
        .expect_err("restored extra references");
        assert!(error.to_string().contains("NIR1_GENERATION_REF_LIMIT"));
    }
    std::fs::remove_dir_all(directory).expect("cleanup");
}

#[test]
fn imported_oversized_binding_is_rejected_before_json_materialization() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let oversized = format!(
        r#"{{"oversized":"{}"}}"#,
        "x".repeat(MAX_BINDING_JSON_BYTES)
    );
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
            params![attempt.id, oversized],
        )?;
        Ok(())
    })
    .expect("import oversized binding");
    let error = read_attempt(&db, &attempt.id, budget()).expect_err("oversized binding");
    assert!(error.to_string().contains("NIR1_GENERATION_BINDING_LIMIT"));
}

#[test]
fn imported_oversized_message_body_is_rejected_before_digest_materialization() {
    let db = database(Path::new(":memory:"));
    let content = "x".repeat(MAX_MESSAGE_BODY_BYTES + 1);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO chat_messages(id,session_id,role,content)
             VALUES ('oversized-body','generation-session','user',?1)",
            [content],
        )?;
        Ok(())
    })
    .expect("import oversized message body");
    let error = bind_human_message(
        &db,
        "generation-project",
        "generation-session",
        "oversized-body",
        1_000,
    )
    .expect_err("oversized message body");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_MESSAGE_BODY_LIMIT"));
}

#[test]
fn imported_oversized_terminal_receipt_is_rejected_before_json_materialization() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let oversized = format!("\"{}\"", "x".repeat(MAX_TERMINAL_JSON_BYTES + 1));
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts
             SET terminal_json=?2,terminal_digest=?3,completed_at_ms=?4 WHERE id=?1",
            params![attempt.id, oversized, test_digest("terminal"), 1_100],
        )?;
        Ok(())
    })
    .expect("import oversized terminal");
    let error = read_terminal(&db, &attempt.id).expect_err("oversized terminal");
    assert!(error.to_string().contains("NIR1_GENERATION_TERMINAL_LIMIT"));
}

#[test]
fn self_consistent_corrupt_terminal_receipt_cannot_qualify_parent() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let terminal = finish_success(&db, &attempt, "corrupt-payload-message", "answer");
    let mut corrupt = terminal;
    corrupt.payload_digest = test_digest("different payload");
    corrupt.receipt_digest = receipt_digest(&corrupt).expect("receipt digest");
    let terminal_json = canonical_json_string(&serde_json::to_value(&corrupt).expect("receipt"))
        .expect("canonical receipt");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts
             SET terminal_json=?2,terminal_digest=?3 WHERE id=?1",
            params![attempt.id, terminal_json, corrupt.receipt_digest],
        )?;
        Ok(())
    })
    .expect("corrupt receipt");
    let error = read_terminal(&db, &attempt.id).expect_err("payload mismatch");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_PAYLOAD_DIGEST_MISMATCH"));
}

#[test]
fn self_consistent_invalid_terminal_observation_is_rejected() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let terminal = finish_success(&db, &attempt, "corrupt-observation-message", "answer");
    let mut corrupt = terminal;
    corrupt.observation["terminalStatus"] = json!("failed");
    corrupt.receipt_digest = receipt_digest(&corrupt).expect("receipt digest");
    let terminal_json = canonical_json_string(&serde_json::to_value(&corrupt).expect("receipt"))
        .expect("canonical receipt");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts
             SET terminal_json=?2,terminal_digest=?3 WHERE id=?1",
            params![attempt.id, terminal_json, corrupt.receipt_digest],
        )?;
        Ok(())
    })
    .expect("corrupt observation");
    let error = read_terminal(&db, &attempt.id).expect_err("observation mismatch");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_OBSERVATION_INVALID"));
}

#[test]
fn self_consistent_terminal_classification_mismatch_is_rejected() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let terminal = finish_success(&db, &attempt, "corrupt-classification-message", "answer");
    let mut corrupt = terminal;
    corrupt.failure_classification = Some(FailureClassification::Cancelled);
    corrupt.retry_classification = RetryClassification::NewAttemptRequired;
    corrupt.receipt_digest = receipt_digest(&corrupt).expect("receipt digest");
    let terminal_json = canonical_json_string(&serde_json::to_value(&corrupt).expect("receipt"))
        .expect("canonical receipt");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts
             SET terminal_json=?2,terminal_digest=?3 WHERE id=?1",
            params![attempt.id, terminal_json, corrupt.receipt_digest],
        )?;
        Ok(())
    })
    .expect("corrupt classification");
    let error = read_terminal(&db, &attempt.id).expect_err("classification mismatch");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_TERMINAL_CLASSIFICATION_INVALID"));
}

#[test]
fn terminal_rejects_cross_project_output_version_and_child_reference() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let terminal = finish_success(&db, &attempt, "cross-project-original", "answer");
    let cross_project_version = db
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects(id,title) VALUES ('other-generation-project','Other')",
                [],
            )?;
            conn.execute(
                "INSERT INTO chat_sessions(id,project_id)
                 VALUES ('other-generation-session','other-generation-project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO chat_messages(id,session_id,role,content,created_at)
                 VALUES ('cross-project-message','other-generation-session','assistant',
                         'answer','1970-01-01T00:00:02Z')",
                [],
            )?;
            bind_message_in_tx(
                conn,
                "other-generation-project",
                "other-generation-session",
                "cross-project-message",
                Some(&attempt.id),
                2_000,
            )
        })
        .expect("cross-project version");
    let mut corrupt = terminal;
    corrupt.message_version = Some(cross_project_version.clone());
    corrupt.receipt_digest = receipt_digest(&corrupt).expect("receipt digest");
    let terminal_json = canonical_json_string(&serde_json::to_value(&corrupt).expect("receipt"))
        .expect("canonical receipt");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts
             SET terminal_json=?2,terminal_digest=?3,output_version_id=?4 WHERE id=?1",
            params![
                attempt.id,
                terminal_json,
                corrupt.receipt_digest,
                cross_project_version.id
            ],
        )?;
        Ok(())
    })
    .expect("cross-project receipt");
    let error = read_terminal(&db, &attempt.id).expect_err("cross-project output version");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_MESSAGE_VERSION_MISMATCH"));

    let child_input = InputReference {
        role: InputRole::Assistant,
        target: InputTarget::Message {
            version_id: cross_project_version.id,
            parent_attempt_id: Some(attempt.id.clone()),
        },
        input_use: InputUse::AdoptedHistory,
    };
    let error = create_attempt(&db, request(vec![child_input], vec![]))
        .expect_err("cross-project child reference");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_MESSAGE_BINDING_MISMATCH"));
}

#[test]
fn terminal_rejects_binding_json_that_disagrees_with_attempt_identity() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let terminal = finish_success(&db, &attempt, "binding-mismatch-message", "answer");
    let mut wrong_binding = attempt.binding.clone();
    wrong_binding.project_id = "other-generation-project".into();
    wrong_binding.chat_session_id = "other-generation-session".into();
    let binding_json =
        canonical_json_string(&serde_json::to_value(wrong_binding).expect("binding"))
            .expect("canonical binding");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
            params![attempt.id, binding_json],
        )?;
        Ok(())
    })
    .expect("binding mismatch");
    let error = read_terminal(&db, &attempt.id).expect_err("binding mismatch");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_BINDING_MISMATCH"));
    assert_eq!(terminal.attempt_id, attempt.id);
}

#[test]
fn child_create_and_claim_reject_parent_refs_changed_after_receipt() {
    let db = database(Path::new(":memory:"));
    let parent = create_attempt(&db, request(vec![], vec![])).expect("parent");
    let terminal = finish_success(&db, &parent, "parent-ref-integrity-message", "answer");
    let parent_version = terminal.message_version.clone().expect("parent version");
    let child_input = message_input(&parent_version);
    let child = create_attempt(&db, request(vec![child_input.clone()], vec![]))
        .expect("child before imported mutation");

    let imported_reference = serde_json::to_string(&json!({
        "role": "context",
        "target": {
            "kind": "raw-source",
            "sourceKey": "imported-parent-ref",
            "revisionToken": "imported-v1"
        }
    }))
    .expect("imported reference JSON");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO nir1_generation_input_refs
             (attempt_id,ordinal,reference_json) VALUES (?1,?2,?3)",
            params![parent.id, 0_i64, imported_reference],
        )?;
        Ok(())
    })
    .expect("import parent reference");

    let error = claim_attempt(&db, &child.id, &child.binding, 2_100, budget())
        .expect_err("changed parent refs must reject child claim");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_INPUT_DIGEST_MISMATCH"));
    let error = create_attempt(&db, request(vec![child_input], vec![]))
        .expect_err("changed parent refs must reject child create");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_INPUT_DIGEST_MISMATCH"));
}

#[test]
fn imported_message_origin_must_match_current_chat_role() {
    let db = database(Path::new(":memory:"));
    let version = human(&db, "imported-role-human", "body");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_messages SET role='assistant' WHERE id='imported-role-human'",
            [],
        )?;
        conn.execute(
            "UPDATE nir1_generation_message_versions SET invalidated=0 WHERE id=?1",
            [&version.id],
        )?;
        Ok(())
    })
    .expect("import role mismatch");
    let error = read_message_version(&db, &version.id).expect_err("role mismatch");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_MESSAGE_ROLE_MISMATCH"));
}

#[test]
fn wrong_binding_expired_attempt_missing_terminal_and_body_mismatch_fail_closed() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let mut other = attempt.binding.clone();
    other.workspace_binding_digest = test_digest("copy of workspace");
    assert!(claim_attempt(&db, &attempt.id, &other, 1_100, budget()).is_err());
    assert!(claim_attempt(&db, &attempt.id, &attempt.binding, 10_000, budget()).is_err());
    assert!(finish_attempt(&db, &attempt.id, &completed("text", ""), None, 1_200).is_err());
    assert!(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_300, budget())
            .expect("still unclaimed")
    );
    assert!(finish_attempt(
        &db,
        &attempt.id,
        &completed("text", ""),
        Some(NewMessageBody {
            message_id: "bad-body".into(),
            content: "different".into(),
            thinking: String::new()
        }),
        1_400
    )
    .is_err());
    assert!(read_terminal(&db, &attempt.id)
        .expect("unfinished")
        .is_none());
}

#[test]
fn non_success_terminal_cannot_create_a_generated_message_version() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let cancelled = OutputObserver::new().finish(Completion::Cancelled);
    let error = finish_attempt(
        &db,
        &attempt.id,
        &cancelled,
        Some(NewMessageBody {
            message_id: "invalid-cancelled-output".into(),
            content: "must not persist".into(),
            thinking: String::new(),
        }),
        1_100,
    )
    .expect_err("cancelled output body");
    assert!(error
        .to_string()
        .contains("NIR1_GENERATION_NON_SUCCESS_BODY"));
    db.with_conn(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM chat_messages WHERE id='invalid-cancelled-output'",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            0
        );
        Ok(())
    })
    .expect("no generated body");
    assert!(read_terminal(&db, &attempt.id)
        .expect("no terminal")
        .is_none());
}

#[test]
fn cancellation_before_claim_is_terminal_and_has_no_reusable_output() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let cancelled = OutputObserver::new().finish(Completion::Cancelled);
    let terminal = finish_attempt(&db, &attempt.id, &cancelled, None, 1_100).expect("cancel");
    assert!(terminal.message_version.is_none());
    assert!(
        !claim_attempt(&db, &attempt.id, &attempt.binding, 1_200, budget())
            .expect("claim rejected")
    );
}

#[test]
fn renderer_sql_cannot_mutate_or_publish_generation_reference_tables() {
    let db = database(Path::new(":memory:"));
    for table in [
        "nir1_generation_attempts",
        "nir1_generation_message_versions",
        "nir1_generation_input_refs",
        "nir1_generation_qualification_refs",
        "nir1_chat_input_captures",
        "nir1_chat_input_submission_keys",
    ] {
        assert!(
            db.execute_renderer(&format!("DELETE FROM {table}"), &[], "run")
                .is_err(),
            "{table}"
        );
        assert!(
            db.execute_renderer_profile_egress(&format!("SELECT * FROM {table}"), &[], "all")
                .is_err(),
            "{table}"
        );
    }
}

#[test]
fn exact_restore_and_edit_undo_do_not_revive_invalidated_message_identity() {
    let db = database(Path::new(":memory:"));
    let version = human(&db, "restore-human", "original");
    let created: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT created_at FROM chat_messages WHERE id='restore-human'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("created");
    // The trusted canonical trigger can revoke a version during ordinary
    // generic message editing, without allowing direct marker manipulation.
    db.execute_renderer(
        "UPDATE chat_messages SET content='edit' WHERE id='restore-human'",
        &[],
        "run",
    )
    .expect("ordinary edit");
    db.execute_renderer(
        "UPDATE chat_messages SET content='original' WHERE id='restore-human'",
        &[],
        "run",
    )
    .expect("undo body");
    assert!(read_message_version(&db, &version.id).is_err());
    assert!(db
        .execute_renderer(
            "UPDATE nir1_generation_message_versions SET invalidated=0",
            &[],
            "run"
        )
        .is_err());
    let restored = human(&db, "delete-human", "same content");
    let deleted_created: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT created_at FROM chat_messages WHERE id='delete-human'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("created");
    db.with_conn(|conn| {
        conn.execute("DELETE FROM chat_messages WHERE id='delete-human'", [])?;
        Ok(())
    })
    .expect("ordinary delete");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO chat_messages(id,session_id,role,content,created_at)
            VALUES ('delete-human','generation-session','user','same content',?1)",
            [deleted_created],
        )?;
        Ok(())
    })
    .expect("byte-identical restore");
    assert!(read_message_version(&db, &restored.id).is_err());
    assert!(bind_human_message(
        &db,
        "generation-project",
        "generation-session",
        "delete-human",
        2_000
    )
    .is_err());
    assert!(!created.is_empty());
}

#[test]
fn unrelated_ui_metadata_does_not_revoke_the_body_version() {
    let db = database(Path::new(":memory:"));
    let version = human(&db, "ui-human", "unchanged");
    db.execute_renderer(
        "UPDATE chat_messages SET metadata='{}',is_starred=1 WHERE id='ui-human'",
        &[],
        "run",
    )
    .expect("ordinary UI metadata");
    assert_eq!(
        read_message_version(&db, &version.id).expect("unchanged body"),
        version
    );
}

#[test]
fn insert_replace_and_update_replace_do_not_revive_displaced_versions() {
    let db = database(Path::new(":memory:"));
    let replaced = human(&db, "replace-human", "identical");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO chat_messages(id,session_id,role,content,created_at)
            SELECT id,session_id,role,content,created_at FROM chat_messages WHERE id='replace-human'",
            [],
        )?;
        Ok(())
    })
    .expect("insert replace");
    assert!(read_message_version(&db, &replaced.id).is_err());
    let displaced = human(&db, "displaced-human", "identical");
    db.with_conn(|conn| {
        conn.execute("INSERT INTO chat_messages(id,session_id,role,content,created_at)
            SELECT 'unbound-donor',session_id,role,content,created_at FROM chat_messages WHERE id='displaced-human'",[])?;
        Ok(())
    }).expect("donor row");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE OR REPLACE chat_messages SET id='displaced-human' WHERE id='unbound-donor'",
            [],
        )?;
        Ok(())
    })
    .expect("update replace");
    assert!(read_message_version(&db, &displaced.id).is_err());
}

// ---------------------------------------------------------------------------
// DT-2 bounded writers (D1-D12).
// ---------------------------------------------------------------------------

mod bounded {
    use super::*;
    use crate::recovery::SafeModeState;
    use crate::state::{
        active_workspace_snapshot, ActiveWorkspace, ActiveWorkspaceSnapshot, WorkspaceAuthority,
        WorkspaceState,
    };
    use crate::workspace_lifecycle::{
        AdmissionKind, LiveBinding, WorkspaceLifecycleCompatibilityView,
    };
    use std::path::PathBuf;
    use std::sync::{mpsc, Mutex};
    use std::thread;

    pub(super) struct BoundedWorkspace {
        pub(super) state: WorkspaceState,
        path: PathBuf,
    }

    /// A Ready workspace over the database file under `path`, served by a new
    /// authority instance.
    fn ready_state(path: &Path) -> WorkspaceState {
        let db = database(&path.join("workspace.db"));
        let authority =
            WorkspaceAuthority::from_database_for_test(db, path.to_path_buf()).expect("authority");
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
                format!("bounded-test:{}", authority.identity()),
                authority.identity(),
                1,
            ))
            .expect("Ready");
        state
    }

    impl BoundedWorkspace {
        /// File-backed so a second `Database` can contend for the SQLite lock.
        pub(super) fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nir1-bounded-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("workspace directory");
            Self {
                state: ready_state(&path),
                path,
            }
        }

        /// The same path and database file re-opened as a new authority
        /// instance (the locator stays, the authority identity changes). Drop
        /// it before this workspace, which removes the directory.
        #[cfg(feature = "native-current-human-capture")]
        pub(super) fn reopened_state(&self) -> WorkspaceState {
            ready_state(&self.path)
        }

        pub(super) fn snapshot(&self) -> ActiveWorkspaceSnapshot {
            active_workspace_snapshot(&self.state).expect("workspace snapshot")
        }

        pub(super) fn db(&self) -> crate::state::PinnedWorkspaceDb {
            Arc::clone(self.snapshot().db())
        }

        pub(super) fn db_path(&self) -> PathBuf {
            self.path.join("workspace.db")
        }
    }

    impl Drop for BoundedWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    pub(super) fn open_probe() -> Nir1AdmissionProbe {
        Arc::new(|| true)
    }

    /// The plan defaults (mutex 100 ms, busy 100 ms, per-op 250 ms), for a test
    /// of the per-operation limit or of which limit takes effect first.
    fn production_admission() -> Nir1AdmissionSqlBudget {
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), open_probe())
    }

    /// The admission budget of a test that does not examine the per-operation
    /// limit: only that limit is widened (see `for_untimed_test`), so a test of
    /// the mutex or busy limit may use it.
    pub(super) fn admission() -> Nir1AdmissionSqlBudget {
        production_admission().for_untimed_test()
    }

    /// The pinned budget of a test that does not examine the per-operation
    /// limit.
    pub(super) fn pinned_budget() -> Nir1PinnedSqlBudget {
        Nir1PinnedSqlBudget::new().for_untimed_test()
    }

    pub(super) fn now_request() -> NewAttempt {
        let now = wall_clock_ms().expect("clock");
        NewAttempt {
            created_at_ms: now,
            expires_at_ms: now + 60_000,
            ..request(vec![], vec![])
        }
    }

    fn no_check() -> impl FnMut() -> Result<()> {
        || Ok(())
    }

    pub(super) fn create(
        workspace: &ActiveWorkspaceSnapshot,
        id: &str,
    ) -> std::result::Result<StoredAttempt, Nir1GenerationStoreError> {
        create_with(workspace, id, &admission())
    }

    /// `create` under an explicit budget, for a test of the per-operation limit
    /// or of which limit takes effect first.
    fn create_with(
        workspace: &ActiveWorkspaceSnapshot,
        id: &str,
        budget: &Nir1AdmissionSqlBudget,
    ) -> std::result::Result<StoredAttempt, Nir1GenerationStoreError> {
        create_attempt_with_id_bounded(
            workspace,
            id,
            production_slots(now_request()),
            budget,
            &mut no_check(),
        )
    }

    pub(super) fn expected(attempt: &StoredAttempt) -> Nir1ExpectedAttempt {
        Nir1ExpectedAttempt::from_stored(attempt, budget())
    }

    fn claim(
        workspace: &ActiveWorkspaceSnapshot,
        attempt: &StoredAttempt,
        budget: &Nir1AdmissionSqlBudget,
    ) -> std::result::Result<Nir1ClaimOutcome, Nir1GenerationStoreError> {
        claim_attempt_bounded(workspace, &expected(attempt), budget, &mut no_check())
    }

    fn zero_send(
        workspace: &ActiveWorkspaceSnapshot,
        attempt: &StoredAttempt,
        claim: Nir1ExpectedClaim,
        completion: Nir1ZeroSendCompletion,
    ) -> std::result::Result<StoredTerminal, Nir1GenerationStoreError> {
        finish_pretransport_attempt_bounded(
            workspace,
            &expected(attempt),
            claim,
            completion,
            &pinned_budget(),
        )
    }

    fn row_counts(db: &Database) -> (i64, i64) {
        db.with_conn(|conn| {
            Ok((
                conn.query_row("SELECT count(*) FROM nir1_generation_attempts", [], |r| {
                    r.get(0)
                })?,
                conn.query_row("SELECT count(*) FROM nir1_generation_input_refs", [], |r| {
                    r.get(0)
                })?,
            ))
        })
        .expect("row counts")
    }

    fn busy_timeout_ms(db: &Database) -> i64 {
        db.with_conn(|conn| Ok(conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?))
            .expect("busy timeout")
    }

    fn assert_failure(
        error: &Nir1GenerationStoreError,
        failure: Nir1StoreFailure,
        commit: Nir1CommitState,
    ) {
        assert_eq!(error.failure(), failure, "{error}: {:#}", error.source);
        assert_eq!(error.commit(), commit, "{error}");
    }

    /// D1: the connection mutex wait is bounded and typed.
    #[test]
    fn d1_create_reports_connection_busy_after_the_mutex_limit_and_retries_cleanly() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let id = test_digest("d1-attempt");
        {
            let _held = db.lock().expect("hold the connection mutex");
            let started = Instant::now();
            let error =
                create_with(&snapshot, &id, &production_admission()).expect_err("held mutex");
            let elapsed = started.elapsed();
            assert_failure(
                &error,
                Nir1StoreFailure::ConnectionBusy,
                Nir1CommitState::NotCommitted,
            );
            assert!(
                elapsed >= NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT,
                "{elapsed:?}"
            );
            assert!(elapsed < NIR1_GENERATION_OPERATION_LIMIT, "{elapsed:?}");
        }
        assert_eq!(row_counts(db.db()), (0, 0));
        assert!(db.connection_reusable());
        assert_eq!(create(&snapshot, &id).expect("retry after release").id, id);
    }

    /// D2: another SQLite writer is waited on for at most the busy limit.
    #[test]
    fn d2_sqlite_busy_is_bounded_and_restores_the_connection_busy_timeout() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let other = Database::new(&workspace.db_path()).expect("second connection");
        other
            .with_conn(|conn| {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                Ok(())
            })
            .expect("other writer holds the SQLite write lock");
        let id = test_digest("d2-attempt");
        let started = Instant::now();
        let error = create(&snapshot, &id).expect_err("SQLite busy");
        let elapsed = started.elapsed();
        assert_failure(
            &error,
            Nir1StoreFailure::SqliteBusy,
            Nir1CommitState::NotCommitted,
        );
        assert!(elapsed >= NIR1_GENERATION_SQLITE_BUSY_LIMIT, "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
        other
            .with_conn(|conn| {
                conn.execute_batch("ROLLBACK")?;
                Ok(())
            })
            .expect("release the SQLite write lock");
        assert_eq!(
            busy_timeout_ms(db.db()),
            5_000,
            "connection default restored"
        );
        assert!(db.connection_reusable());
        assert_eq!(create(&snapshot, &id).expect("retry").id, id);
    }

    pub(super) fn install_slow_insert_trigger(db: &Database) {
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TABLE nir1_slow(x INTEGER);
                 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400)
                 INSERT INTO nir1_slow SELECT x FROM c;
                 CREATE TEMP TRIGGER nir1_slow_attempt AFTER INSERT ON nir1_generation_attempts
                 BEGIN SELECT count(*) FROM nir1_slow a, nir1_slow b, nir1_slow c; END;",
            )?;
            Ok(())
        })
        .expect("slow TEMP trigger");
    }

    pub(super) fn remove_slow_insert_trigger(db: &Database) {
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER nir1_slow_attempt")?;
            Ok(())
        })
        .expect("drop slow trigger");
    }

    /// D3: a long statement is interrupted at the per-op limit; nothing stays.
    #[test]
    fn d3_long_sql_times_out_at_the_operation_limit_without_partial_rows() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        install_slow_insert_trigger(db.db());
        let id = test_digest("d3-attempt");
        let started = Instant::now();
        let error =
            create_with(&snapshot, &id, &production_admission()).expect_err("per-op timeout");
        let elapsed = started.elapsed();
        assert_failure(
            &error,
            Nir1StoreFailure::TimedOut,
            Nir1CommitState::NotCommitted,
        );
        assert!(elapsed >= NIR1_GENERATION_OPERATION_LIMIT, "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
        assert_eq!(row_counts(db.db()), (0, 0), "attempt and refs rolled back");
        assert!(db.connection_reusable());
        // The progress handler is gone: a statement longer than the old
        // deadline now runs to completion on the same connection.
        let count: i64 = db
            .db()
            .with_conn(|conn| {
                Ok(
                    conn.query_row("SELECT count(*) FROM nir1_slow a, nir1_slow b", [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("unbounded follow-up statement");
        assert_eq!(count, 160_000);
        assert_eq!(busy_timeout_ms(db.db()), 5_000);
        remove_slow_insert_trigger(db.db());
        assert_eq!(create(&snapshot, &id).expect("reuse").id, id);
    }

    /// D4: a refused or panicking pre-commit check rolls back; the panic
    /// reaches the caller while the connection stays reusable.
    #[test]
    fn d4_pre_commit_refusal_and_panic_roll_back_and_keep_the_connection() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let attempt = create(&snapshot, &test_digest("d4-attempt")).expect("attempt");
        let mut refuse = || -> Result<()> { anyhow::bail!("authority revoked before commit") };
        let error =
            claim_attempt_bounded(&snapshot, &expected(&attempt), &admission(), &mut refuse)
                .expect_err("pre-commit refusal");
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted);
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut explode = || -> Result<()> { panic!("pre-commit owner panic") };
            let _ =
                claim_attempt_bounded(&snapshot, &expected(&attempt), &admission(), &mut explode);
        }));
        assert!(panic.is_err(), "the panic reaches the caller");
        assert!(
            db.connection_reusable(),
            "a clean rollback keeps the connection"
        );
        assert!(read_attempt(db.db(), &attempt.id, budget())
            .expect("attempt")
            .claimed_at_ms
            .is_none());
        assert!(matches!(
            claim(&snapshot, &attempt, &admission()),
            Ok(Nir1ClaimOutcome::Claimed { .. })
        ));
    }

    /// D5: claim outcomes and the in-transaction pairing check.
    #[test]
    fn d5_claim_reports_claimed_already_claimed_and_already_terminal() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let attempt = create(&snapshot, &test_digest("d5-attempt")).expect("attempt");
        let mut swapped = expected(&attempt);
        swapped.payload_digest = test_digest("another payload");
        let error = claim_attempt_bounded(&snapshot, &swapped, &admission(), &mut no_check())
            .expect_err("pairing mismatch");
        assert_failure(
            &error,
            Nir1StoreFailure::Conflict,
            Nir1CommitState::NotCommitted,
        );
        let Ok(Nir1ClaimOutcome::Claimed { claimed_at_ms }) =
            claim(&snapshot, &attempt, &admission())
        else {
            panic!("first claim wins");
        };
        assert_eq!(
            claim(&snapshot, &attempt, &admission()).expect("second claim"),
            Nir1ClaimOutcome::AlreadyClaimed { claimed_at_ms }
        );
        zero_send(
            &snapshot,
            &attempt,
            Nir1ExpectedClaim::ClaimedAt(claimed_at_ms),
            Nir1ZeroSendCompletion::DispatchFailure,
        )
        .expect("terminal");
        assert_eq!(
            claim(&snapshot, &attempt, &admission()).expect("terminal claim"),
            Nir1ClaimOutcome::AlreadyTerminal
        );
    }

    /// D6: an ambiguous COMMIT is classified Unknown and carries the claim
    /// time this writer used; the exact reread resolves it.
    #[test]
    fn d6_unknown_commit_is_resolved_by_the_exact_reread() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let vetoed = create(&snapshot, &test_digest("d6-vetoed")).expect("attempt");
        let error = claim(
            &snapshot,
            &vetoed,
            &admission().with_failpoint(Nir1GenerationFailpoint::VetoCommit),
        )
        .expect_err("vetoed COMMIT");
        assert_eq!(error.commit(), Nir1CommitState::Unknown);
        assert!(
            error.claim_written_at_ms().is_some(),
            "claim Unknown has its time"
        );
        let reread = read_attempt_exact_bounded(&snapshot, &vetoed.id, budget(), &pinned_budget())
            .expect("reread")
            .expect("row");
        assert!(
            reread.claimed_at_ms.is_none(),
            "the vetoed claim is not durable"
        );
        assert!(workspace.db().connection_reusable());

        let applied = create(&snapshot, &test_digest("d6-applied")).expect("attempt");
        let error = claim(
            &snapshot,
            &applied,
            &admission().with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
        )
        .expect_err("error after COMMIT");
        assert_eq!(error.commit(), Nir1CommitState::Unknown);
        let reread = read_attempt_exact_bounded(&snapshot, &applied.id, budget(), &pinned_budget())
            .expect("reread")
            .expect("row");
        assert_eq!(reread.claimed_at_ms, error.claim_written_at_ms());
        assert!(read_attempt_exact_bounded(
            &snapshot,
            &test_digest("never-created"),
            budget(),
            &pinned_budget(),
        )
        .expect("confirmed absence")
        .is_none());
    }

    /// D7: admission writers stop on a lifecycle edge or the owner's cancel;
    /// the pinned zero-send writer still completes, exactly once.
    #[test]
    fn d7_admission_writers_are_fenced_while_pinned_zero_send_completes() {
        for shutdown in [false, true] {
            let workspace = BoundedWorkspace::new();
            let snapshot = workspace.snapshot();
            let attempt = create(&snapshot, &test_digest("d7-attempt")).expect("attempt");
            let core = workspace.state.lifecycle_core();
            let _transition = if shutdown {
                core.request_shutdown().expect("shutdown");
                None
            } else {
                Some(
                    core.begin_transition(AdmissionKind::Open)
                        .expect("transition"),
                )
            };
            let error = claim(&snapshot, &attempt, &admission()).expect_err("fenced claim");
            assert_failure(
                &error,
                Nir1StoreFailure::Fenced,
                Nir1CommitState::NotCommitted,
            );
            let error = create(&snapshot, &test_digest("d7-other")).expect_err("fenced create");
            assert_failure(
                &error,
                Nir1StoreFailure::Fenced,
                Nir1CommitState::NotCommitted,
            );
            let cancel = Arc::new(AtomicBool::new(true));
            let cancelled = Nir1AdmissionSqlBudget::new(Arc::clone(&cancel), open_probe());
            let error = claim(&snapshot, &attempt, &cancelled).expect_err("cancelled claim");
            assert_failure(
                &error,
                Nir1StoreFailure::Cancelled,
                Nir1CommitState::NotCommitted,
            );

            let first = zero_send(
                &snapshot,
                &attempt,
                Nir1ExpectedClaim::Unclaimed,
                Nir1ZeroSendCompletion::Cancelled,
            )
            .expect("pinned zero-send ignores the stop");
            assert_eq!(
                first.failure_classification,
                Some(FailureClassification::Cancelled)
            );
            let again = zero_send(
                &snapshot,
                &attempt,
                Nir1ExpectedClaim::Unclaimed,
                Nir1ZeroSendCompletion::Cancelled,
            )
            .expect("idempotent rewrite");
            assert_eq!(again, first);
            let error = zero_send(
                &snapshot,
                &attempt,
                Nir1ExpectedClaim::Unclaimed,
                Nir1ZeroSendCompletion::DispatchFailure,
            )
            .expect_err("different terminal");
            assert_failure(
                &error,
                Nir1StoreFailure::TerminalConflict,
                Nir1CommitState::NotCommitted,
            );
        }
    }

    /// D8: the zero-send writer only produces not-attempted terminals and
    /// never a message body or version.
    #[test]
    fn d8_zero_send_terminals_carry_no_body_and_no_provider_observation() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        for (completion, status, classification) in [
            (
                Nir1ZeroSendCompletion::Cancelled,
                "cancelled",
                FailureClassification::Cancelled,
            ),
            (
                Nir1ZeroSendCompletion::DispatchFailure,
                "failed",
                FailureClassification::DispatchUnavailable,
            ),
        ] {
            let attempt =
                create(&snapshot, &test_digest(&format!("d8-{status}"))).expect("attempt");
            let terminal = zero_send(
                &snapshot,
                &attempt,
                Nir1ExpectedClaim::Unclaimed,
                completion,
            )
            .expect("zero-send");
            assert!(terminal.message_version.is_none());
            assert_eq!(terminal.failure_classification, Some(classification));
            assert_eq!(
                terminal.retry_classification,
                RetryClassification::NewAttemptRequired
            );
            assert_eq!(terminal.observation["terminalStatus"], status);
            assert_eq!(terminal.observation["parseStatus"], "not-attempted");
            assert!(terminal.observation["providerTerminal"].is_null());
            assert!(terminal.observation["responseDigest"].is_null());
        }
        let assistant_rows: i64 = workspace
            .db()
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM chat_messages WHERE role='assistant'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("assistant rows");
        assert_eq!(assistant_rows, 0);
    }

    /// D10: COMMIT runs without the Core, a participant or this thread's
    /// lifecycle state held: another thread uses them during COMMIT.
    #[test]
    fn d10_commit_runs_without_lifecycle_guards() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let attempt = create(&snapshot, &test_digest("d10-attempt")).expect("attempt");
        let core = workspace.state.lifecycle_core();
        let (during_tx, during_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let probe = Arc::new(move || {
            during_tx.send(()).expect("announce COMMIT");
            release_rx
                .lock()
                .expect("release receiver")
                .recv_timeout(Duration::from_secs(5))
                .expect("release COMMIT");
        });
        thread::scope(|scope| {
            let owner = scope.spawn(|| {
                claim(
                    &snapshot,
                    &attempt,
                    &admission().with_failpoint(Nir1GenerationFailpoint::ProbeDuringCommit(probe)),
                )
            });
            during_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("owner reached COMMIT");
            let (done_tx, done_rx) = mpsc::channel();
            let other_core = core.clone();
            scope.spawn(move || {
                other_core.snapshot().expect("Core snapshot during COMMIT");
                drop(
                    other_core
                        .begin_workspace_participant()
                        .expect("participant during COMMIT"),
                );
                done_tx.send(()).expect("done");
            });
            done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("lifecycle use during COMMIT finished within 1 s");
            release_tx.send(()).expect("release");
            assert!(matches!(
                owner.join().expect("owner"),
                Ok(Nir1ClaimOutcome::Claimed { .. })
            ));
        });
    }

    /// D11: a nested SQL owner is refused before the connection mutex.
    #[test]
    fn d11_nested_sql_owner_is_refused_before_the_connection_mutex() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let attempt = create(&snapshot, &test_digest("d11-attempt")).expect("attempt");
        let participant = workspace
            .state
            .lifecycle_core()
            .begin_workspace_participant()
            .expect("participant");
        let assert_refused = |result: Option<Nir1GenerationStoreError>| {
            let error = result.expect("refused");
            assert_failure(
                &error,
                Nir1StoreFailure::SqlOwnerActive,
                Nir1CommitState::NotCommitted,
            );
        };
        let checks = |assert_refused: &dyn Fn(Option<Nir1GenerationStoreError>)| {
            let started = Instant::now();
            assert_refused(create(&snapshot, &test_digest("d11-nested")).err());
            assert_refused(claim(&snapshot, &attempt, &admission()).err());
            assert_refused(
                zero_send(
                    &snapshot,
                    &attempt,
                    Nir1ExpectedClaim::Unclaimed,
                    Nir1ZeroSendCompletion::Cancelled,
                )
                .err(),
            );
            assert_refused(
                finish_attempt_bounded(
                    &snapshot,
                    &expected(&attempt),
                    &OutputObserver::new().finish(Completion::Cancelled),
                    None,
                    1_000,
                    &pinned_budget(),
                )
                .err(),
            );
            assert_refused(
                recover_claimed_attempt_bounded(&snapshot, &expected(&attempt), &pinned_budget())
                    .err(),
            );
            assert_refused(
                read_attempt_exact_bounded(&snapshot, &attempt.id, budget(), &pinned_budget())
                    .err(),
            );
            // The connection mutex is held by this very scope: a writer that
            // waited for it would have taken at least the mutex limit.
            assert!(started.elapsed() < NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT);
        };
        db.db()
            .with_participant_sql_scope(&participant, |_conn| {
                checks(&assert_refused);
                Ok(())
            })
            .expect("participant scope");
        db.db()
            .with_conn(|conn| {
                crate::narrative_maintenance_connection::with_capacity_connection(
                    db.db(),
                    conn,
                    |_| {
                        checks(&assert_refused);
                        Ok(())
                    },
                )
            })
            .expect("capacity attempt");
        assert!(matches!(
            claim(&snapshot, &attempt, &admission()),
            Ok(Nir1ClaimOutcome::Claimed { .. })
        ));
    }

    /// D12: the zero-send writer checks the claim state before any terminal.
    #[test]
    fn d12_zero_send_never_terminalizes_another_claim_or_mistakes_a_sweep_terminal() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();

        let swept = create(&snapshot, &test_digest("d12-swept")).expect("attempt");
        recover_attempt(db.db(), &swept.id, wall_clock_ms().expect("clock")).expect("sweep");
        let error = zero_send(
            &snapshot,
            &swept,
            Nir1ExpectedClaim::Unclaimed,
            Nir1ZeroSendCompletion::DispatchFailure,
        )
        .expect_err("InterruptedUnknown is not this writer's DispatchFailure");
        assert_eq!(error.failure(), Nir1StoreFailure::TerminalConflict);

        let other = create(&snapshot, &test_digest("d12-other")).expect("attempt");
        let other_time = other.expires_at_ms - 1;
        assert!(
            claim_attempt(db.db(), &other.id, &other.binding, other_time, budget())
                .expect("another claimer")
        );
        for claim in [
            Nir1ExpectedClaim::Unclaimed,
            Nir1ExpectedClaim::ClaimedAt(other_time - 1),
        ] {
            let error = zero_send(&snapshot, &other, claim, Nir1ZeroSendCompletion::Cancelled)
                .expect_err("claim mismatch");
            assert_eq!(error.failure(), Nir1StoreFailure::ClaimMismatch);
        }
        assert!(read_terminal(db.db(), &other.id)
            .expect("terminal")
            .is_none());

        // Another claimer's own DispatchFailure terminal is not mistaken for
        // this writer's idempotent rewrite: the claim check comes first.
        finish_attempt(
            db.db(),
            &other.id,
            &OutputObserver::new().finish(Completion::DispatchFailure),
            None,
            other_time,
        )
        .expect("other claimer terminal");
        let error = zero_send(
            &snapshot,
            &other,
            Nir1ExpectedClaim::ClaimedAt(other_time - 1),
            Nir1ZeroSendCompletion::DispatchFailure,
        )
        .expect_err("claim mismatch before the terminal comparison");
        assert_eq!(error.failure(), Nir1StoreFailure::ClaimMismatch);
    }

    /// D14: claim and every terminal writer compare the immutable fields in
    /// their own transaction, so another same-binding attempt cannot be
    /// swapped in by ID (the claim, terminal and recover paths alike).
    #[test]
    fn d14_claim_and_terminal_writers_refuse_a_swapped_same_binding_attempt() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let paired = create(&snapshot, &test_digest("d14-paired")).expect("attempt");
        let mut other_request = now_request();
        other_request.payload_digest = test_digest("d14 other payload");
        let other = create_attempt_with_id_bounded(
            &snapshot,
            &test_digest("d14-other"),
            production_slots(other_request),
            &admission(),
            &mut no_check(),
        )
        .expect("another same-binding attempt");
        assert_eq!(other.binding, paired.binding);
        let mut swapped = expected(&paired);
        swapped.id = other.id.clone();
        let observation = OutputObserver::new().finish(Completion::Cancelled);
        let refused = |error: Option<Nir1GenerationStoreError>, path: &str| {
            let error = error.unwrap_or_else(|| panic!("{path}: the swapped attempt is refused"));
            assert_failure(
                &error,
                Nir1StoreFailure::Conflict,
                Nir1CommitState::NotCommitted,
            );
            assert!(
                error_chain_contains(&error.source, "NIR1_GENERATION_ATTEMPT_CONFLICT"),
                "{path}: {:#}",
                error.source
            );
        };
        let terminal_paths = |claim: Nir1ExpectedClaim| {
            refused(
                finish_pretransport_attempt_bounded(
                    &snapshot,
                    &swapped,
                    claim,
                    Nir1ZeroSendCompletion::DispatchFailure,
                    &pinned_budget(),
                )
                .err(),
                "zero-send",
            );
            refused(
                finish_attempt_bounded(
                    &snapshot,
                    &swapped,
                    &observation,
                    None,
                    wall_clock_ms().expect("clock"),
                    &pinned_budget(),
                )
                .err(),
                "finish",
            );
            refused(
                recover_claimed_attempt_bounded(&snapshot, &swapped, &pinned_budget()).err(),
                "recover",
            );
        };
        refused(
            claim_attempt_bounded(&snapshot, &swapped, &admission(), &mut no_check()).err(),
            "claim",
        );
        terminal_paths(Nir1ExpectedClaim::Unclaimed);
        let Ok(Nir1ClaimOutcome::Claimed { claimed_at_ms }) =
            claim(&snapshot, &other, &admission())
        else {
            panic!("the other attempt's own claim");
        };
        terminal_paths(Nir1ExpectedClaim::ClaimedAt(claimed_at_ms));
        let current = read_attempt(db.db(), &other.id, budget()).expect("other attempt");
        assert_eq!(current.claimed_at_ms, Some(claimed_at_ms));
        assert!(current.terminal.is_none(), "no swapped write reached it");
        let untouched = read_attempt(db.db(), &paired.id, budget()).expect("paired attempt");
        assert!(untouched.claimed_at_ms.is_none() && untouched.terminal.is_none());
        assert!(db.connection_reusable());
        // The exact expected fields still finish the other attempt.
        let terminal = finish_attempt_bounded(
            &snapshot,
            &expected(&other),
            &observation,
            None,
            wall_clock_ms().expect("clock"),
            &pinned_budget(),
        )
        .expect("the exact attempt finishes");
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::Cancelled)
        );
    }

    /// D15: the sweep retries a recovery only on its connection mutex
    /// timeout (no SQL ran); a lapsed operation deadline is not one.
    #[test]
    fn d15_recovery_reports_only_a_connection_mutex_timeout_as_connection_busy() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let attempt = create(&snapshot, &test_digest("d15-attempt")).expect("attempt");
        let recover = |operation: Duration| {
            recover_attempt_bounded(
                &snapshot,
                &attempt.id,
                wall_clock_ms().expect("clock"),
                ParticipantSqlOperationBudget::new(
                    Arc::new(AtomicBool::new(false)),
                    Instant::now() + operation,
                    NIR1_GENERATION_SQLITE_BUSY_LIMIT,
                ),
            )
        };
        {
            let _held = db.lock().expect("hold the connection mutex");
            let started = Instant::now();
            let busy = recover(NIR1_GENERATION_OPERATION_LIMIT).expect_err("held mutex");
            assert!(is_recovery_connection_busy(&busy), "{busy:#}");
            assert!(started.elapsed() >= NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT);
            // A deadline shorter than the mutex limit lapses first.
            let lapsed = recover(NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT / 2).expect_err("deadline");
            assert!(!is_recovery_connection_busy(&lapsed), "{lapsed:#}");
        }
        assert!(read_terminal(db.db(), &attempt.id)
            .expect("terminal")
            .is_none());
        let terminal =
            recover(NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT).expect("recovery after release");
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
    }

    /// The plan defaults stay what the constructors build; the untimed-test
    /// budgets widen the per-operation limit alone.
    #[test]
    fn untimed_test_budgets_widen_only_the_operation_limit() {
        let plan = Nir1SqlLimits::DEFAULT;
        assert_eq!(plan.mutex, Duration::from_millis(100));
        assert_eq!(plan.busy, Duration::from_millis(100));
        assert_eq!(plan.operation, Duration::from_millis(250));
        assert_eq!(production_admission().limits, plan);
        assert_eq!(Nir1PinnedSqlBudget::new().limits, plan);
        for limits in [admission().limits, pinned_budget().limits] {
            assert_eq!(limits.mutex, plan.mutex);
            assert_eq!(limits.busy, plan.busy);
            assert_eq!(
                limits.operation,
                NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT
            );
            assert!(limits.operation > plan.operation);
        }
    }

    #[test]
    #[should_panic(expected = "may only be tightened")]
    fn limits_can_only_be_tightened() {
        let _ = admission().tightened(
            NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT * 2,
            NIR1_GENERATION_SQLITE_BUSY_LIMIT,
            NIR1_GENERATION_OPERATION_LIMIT,
        );
    }
}

/// D9, D13: the capture form uses one deterministic attempt per submission,
/// requires the exact current capture, and serves only its owner's caller
/// and workspace incarnation.
#[cfg(feature = "native-current-human-capture")]
mod capture {
    use super::bounded::{admission, BoundedWorkspace};
    use super::*;

    const SESSION: &str = "generation-session";
    const SCENE: &str = "generation-scene";

    fn owner(workspace: &crate::state::ActiveWorkspaceSnapshot) -> ChatInputCaptureOwner {
        let locator = workspace.path().to_string_lossy().into_owned();
        ChatInputCaptureOwner::new(
            "profile".into(),
            "main-caller".into(),
            3,
            1,
            locator.clone(),
            "main-caller-session".into(),
            "bounded-workspace".into(),
            locator,
            workspace.db().identity(),
            1,
            0,
        )
        .expect("owner")
    }

    fn accept(
        workspace: &crate::state::ActiveWorkspaceSnapshot,
        key: &str,
    ) -> AcceptedChatInputCapture {
        let submission = NewChatInputSubmission::new(
            format!("submission-{key}"),
            format!("message-{key}"),
            SESSION.into(),
            SCENE.into(),
            format!("body {key}"),
            "2026-10-13T00:00:00.000Z".into(),
        )
        .expect("submission");
        accept_current_human_chat_input(
            workspace,
            &owner(workspace),
            &submission,
            ParticipantSqlOperationBudget::new(
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(5),
                Duration::from_millis(100),
            ),
        )
        .expect("accepted capture")
    }

    fn capture_request(capture: &AcceptedChatInputCapture) -> NewAttempt {
        let mut request = super::bounded::now_request();
        request.inputs = vec![InputReference {
            role: InputRole::User,
            target: InputTarget::Message {
                version_id: capture.message_version_id().into(),
                parent_attempt_id: None,
            },
            input_use: InputUse::CurrentTurn,
        }];
        request
    }

    fn create_for(
        workspace: &crate::state::ActiveWorkspaceSnapshot,
        capture: &AcceptedChatInputCapture,
        request: NewAttempt,
    ) -> std::result::Result<StoredAttempt, Nir1GenerationStoreError> {
        create_attempt_for_capture_bounded(
            workspace,
            capture,
            production_slots(request),
            &admission(),
            &mut || Ok(()),
        )
    }

    fn attempt_count(snapshot: &crate::state::ActiveWorkspaceSnapshot) -> i64 {
        snapshot
            .db()
            .db()
            .with_conn(|conn| {
                Ok(
                    conn.query_row("SELECT count(*) FROM nir1_generation_attempts", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .expect("attempt count")
    }

    /// D13: before any transaction, the capture form refuses a binding whose
    /// profile, caller, caller epoch or Main caller session is not the
    /// capture owner's, and a
    /// pinned workspace whose locator or authority instance is not the
    /// owner's (the same path re-opened as a new authority instance, or
    /// another locator under the same instance). Nothing is written.
    #[test]
    fn d13_capture_create_requires_the_owner_caller_and_workspace_incarnation() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let capture = accept(&snapshot, "d13");
        let refused = |pinned: &crate::state::ActiveWorkspaceSnapshot,
                       capture: &AcceptedChatInputCapture,
                       request: NewAttempt,
                       failure: Nir1StoreFailure,
                       code: &str| {
            let error = create_for(pinned, capture, request).expect_err(code);
            assert_eq!(error.failure(), failure, "{error}: {:#}", error.source);
            assert_eq!(error.commit(), Nir1CommitState::NotCommitted, "{code}");
            assert!(
                error_chain_contains(&error.source, code),
                "{code}: {:#}",
                error.source
            );
        };
        for name in ["profile", "caller", "caller epoch", "caller session"] {
            let mut request = capture_request(&capture);
            match name {
                "profile" => request.binding.caller.profile_id = "another-profile".into(),
                "caller" => request.binding.caller.caller_id = "another-caller".into(),
                "caller epoch" => request.binding.caller.caller_epoch += 1,
                _ => request.binding.caller.caller_session_id = "another-caller-session".into(),
            }
            refused(
                &snapshot,
                &capture,
                request,
                Nir1StoreFailure::Conflict,
                "NIR1_GENERATION_CAPTURE_BINDING_MISMATCH",
            );
            assert_eq!(attempt_count(&snapshot), 0, "{name}");
        }

        // The same path re-opened as a new authority instance: the capture
        // row and its owner still match, only the pinned incarnation differs.
        let reopened = workspace.reopened_state();
        let reopened_snapshot =
            crate::state::active_workspace_snapshot(&reopened).expect("reopened snapshot");
        assert_eq!(reopened_snapshot.path(), snapshot.path());
        assert_ne!(reopened_snapshot.db().identity(), snapshot.db().identity());
        refused(
            &reopened_snapshot,
            &capture,
            capture_request(&capture),
            Nir1StoreFailure::NotCurrent,
            "NIR1_GENERATION_CAPTURE_WORKSPACE_MISMATCH",
        );
        drop(reopened_snapshot);
        drop(reopened);
        // Another locator under the same authority instance.
        let mut moved = capture.clone();
        moved.owner.workspace_locator = format!("{}-moved", moved.owner.workspace_locator);
        moved.owner.caller_workspace_id = moved.owner.workspace_locator.clone();
        refused(
            &snapshot,
            &moved,
            capture_request(&moved),
            Nir1StoreFailure::NotCurrent,
            "NIR1_GENERATION_CAPTURE_WORKSPACE_MISMATCH",
        );
        assert_eq!(attempt_count(&snapshot), 0, "no refusal wrote an attempt");

        // The owner's own caller and workspace incarnation still create.
        create_for(&snapshot, &capture, capture_request(&capture)).expect("owner create");
        assert_eq!(attempt_count(&snapshot), 1);
    }

    /// DT-3: the capture form binds the live Scene of the session in the same
    /// transaction. A binding built from another Scene body, or a Scene that
    /// was archived after the capture was accepted, is refused and writes
    /// nothing; the same capture then creates its one attempt.
    #[test]
    fn dt3_capture_create_binds_the_live_scene_of_the_session() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let capture = accept(&snapshot, "dt3");
        let set_archived = |value: Option<&str>| {
            snapshot
                .db()
                .db()
                .with_conn(|conn| {
                    conn.execute(
                        "UPDATE tree_nodes SET archived_at=?2
                          WHERE id=?1 AND project_id='generation-project'",
                        params![SCENE, value],
                    )?;
                    Ok(())
                })
                .expect("archive state");
        };
        let refused = |request: NewAttempt, code: &str| {
            let error = create_for(&snapshot, &capture, request).expect_err(code);
            assert_eq!(error.commit(), Nir1CommitState::NotCommitted, "{code}");
            assert!(
                error_chain_contains(&error.source, code),
                "{code}: {:#}",
                error.source
            );
            assert_eq!(attempt_count(&snapshot), 0, "{code}");
        };
        let mut another_body = capture_request(&capture);
        another_body.binding.scene.body_digest = test_digest("another body");
        refused(another_body, "NIR1_GENERATION_SCENE_BODY_MISMATCH");
        set_archived(Some("2026-10-12 00:01:00"));
        refused(capture_request(&capture), "NIR1_GENERATION_SCENE_ARCHIVED");
        set_archived(None);
        create_for(&snapshot, &capture, capture_request(&capture))
            .expect("the live Scene binds the capture");
        assert_eq!(attempt_count(&snapshot), 1);
    }

    #[test]
    fn d9_capture_create_is_deterministic_and_requires_the_current_capture() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let first = accept(&snapshot, "first");
        let attempt = create_for(&snapshot, &first, capture_request(&first)).expect("create");
        assert_eq!(
            attempt.id,
            attempt_id_for_capture(&first).expect("deterministic id")
        );
        // The stored real attempt ID is accepted by the DT-4 ID derivation and
        // inverts exactly.
        let execution = crate::nir1_local_audit::execution_id_for_attempt(&attempt.id)
            .expect("real attempt ID derives an execution ID");
        assert_eq!(
            crate::nir1_local_audit::attempt_id_from_execution_id(&execution),
            Some(attempt.id.as_str())
        );
        crate::nir1_local_audit::operation_id_for_attempt(&attempt.id).expect("operation ID");
        crate::nir1_local_audit::event_id_for_attempt(&attempt.id, "execution.started")
            .expect("event ID");
        let error = create_for(&snapshot, &first, capture_request(&first)).expect_err("resend");
        assert_eq!(error.failure(), Nir1StoreFailure::AlreadyExists);
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted);
        assert_eq!(
            attempt_count(&snapshot),
            1,
            "a resend never creates a second attempt"
        );

        let second = accept(&snapshot, "second");
        let mut wrong_session = capture_request(&second);
        wrong_session.binding.chat_session_id = "another-session".into();
        assert_eq!(
            create_for(&snapshot, &second, wrong_session)
                .expect_err("session mismatch")
                .failure(),
            Nir1StoreFailure::Conflict
        );
        let mut without_human = capture_request(&second);
        without_human.inputs.clear();
        assert_eq!(
            create_for(&snapshot, &second, without_human)
                .expect_err("no Human input")
                .failure(),
            Nir1StoreFailure::Conflict
        );
        // Accepting `third` in the same chat session supersedes `second`.
        let third = accept(&snapshot, "third");
        assert_eq!(
            create_for(&snapshot, &second, capture_request(&second))
                .expect_err("superseded capture")
                .failure(),
            Nir1StoreFailure::NotCurrent
        );
        cancel_current_human_chat_input(
            &snapshot,
            &third,
            &owner(&snapshot),
            ParticipantSqlOperationBudget::new(
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(5),
                Duration::from_millis(100),
            ),
        )
        .expect("cancel capture");
        assert_eq!(
            create_for(&snapshot, &third, capture_request(&third))
                .expect_err("cancelled capture")
                .failure(),
            Nir1StoreFailure::NotCurrent
        );
    }
}

// S4 (DT-3): the Scene `v{version}@{updated_at}` token repeats across Scene
// incarnations, and the Main-issued caller session is not a chat session.
// These tests describe the AttemptBinding v2 contract; only the helpers that
// assemble a binding change between the v1 (red) and v2 (green) shapes.

const S4_SCENE_ID: &str = "s4-scene";
/// `datetime('now')` form. The trash restore writer relies on this
/// one-second column default, so two incarnations created within the same
/// second share it; snapshot restore re-inserts the captured value verbatim.
const S4_UPDATED_AT: &str = "2026-10-12 00:00:00";
const S4_BODY: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"S4 scene body"}]}]}"#;
const S4_OTHER_BODY: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"another Scene reusing the id"}]}]}"#;
/// Main issues one random `sessionId` per sender
/// (electron/main/profileEgress.ts:648); it never names a chat_sessions row.
const S4_MAIN_CALLER_SESSION: &str = "5f0c9a52-6f39-4c41-9d0e-0b7c6d4e8a31";

#[derive(Clone, Copy, Debug)]
enum S4SceneReplacement {
    /// Delete, then recreate the same row (undo/redo or a writer that reuses
    /// the captured state).
    DeleteAndRecreate,
    /// Edit, then restore a snapshot captured before the attempt: every tree
    /// row is deleted and the captured id/created_at/updated_at/content are
    /// re-inserted without a version (column default 0).
    SnapshotRestore,
    /// A different Scene reuses the id within the same second.
    IdReuse,
}

/// Insert one live version-0 Scene row and let the Native A1 writer mint its
/// scope incarnation, as every Scene writer does. The chat session is
/// attached to the Scene, as current Human capture requires.
fn s4_insert_scene(db: &Database, updated_at: &str, content: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes
               (id,project_id,node_type,title,sort_order,content,version,created_at,updated_at)
             VALUES (?1,'generation-project','scene','S4','a0',?2,0,?3,?3)",
            params![S4_SCENE_ID, content, updated_at],
        )?;
        crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
            conn,
            "generation-project",
            S4_SCENE_ID,
            updated_at,
        )?;
        conn.execute(
            "UPDATE chat_sessions SET node_id=?1 WHERE id='generation-session'",
            [S4_SCENE_ID],
        )?;
        Ok(())
    })
    .expect("S4 scene");
}

fn s4_delete_scene(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM tree_nodes WHERE id=?1 AND project_id='generation-project'",
            [S4_SCENE_ID],
        )?;
        Ok(())
    })
    .expect("delete S4 scene");
}

/// The stored Scene token and its Native A1 incarnation.
fn s4_scene_state(db: &Database) -> (String, String) {
    db.with_read_transaction(|conn| {
        let (version, updated_at, incarnation): (i64, String, String) = conn.query_row(
            "SELECT t.version,t.updated_at,b.scene_incarnation_id
               FROM tree_nodes t
               JOIN narrative_scene_scope_bindings b
                 ON b.project_id=t.project_id AND b.scene_id=t.id
              WHERE t.id=?1 AND t.project_id='generation-project'",
            [S4_SCENE_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok((format!("v{version}@{updated_at}"), incarnation))
    })
    .expect("S4 scene state")
}

/// Replace the S4 Scene the way each ABA path does. The replacement keeps the
/// Scene token (`v{version}@{updated_at}`) and the Native A1 writer mints a
/// new incarnation.
fn s4_replace_scene(db: &Database, replacement: S4SceneReplacement) {
    match replacement {
        S4SceneReplacement::DeleteAndRecreate => {
            s4_delete_scene(db);
            s4_insert_scene(db, S4_UPDATED_AT, S4_BODY);
        }
        S4SceneReplacement::SnapshotRestore => {
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes SET content=?2,version=version+1,
                            updated_at='2026-10-12 00:05:00'
                      WHERE id=?1 AND project_id='generation-project'",
                    params![S4_SCENE_ID, S4_OTHER_BODY],
                )?;
                Ok(())
            })
            .expect("edit after the snapshot");
            s4_delete_scene(db);
            s4_insert_scene(db, S4_UPDATED_AT, S4_BODY);
            db.with_conn(|conn| {
                crate::narrative_extraction::refresh_scene_scope_source_token_in_tx(
                    conn,
                    "generation-project",
                    S4_SCENE_ID,
                    S4_UPDATED_AT,
                )?;
                Ok(())
            })
            .expect("restore refreshes the scope token");
        }
        S4SceneReplacement::IdReuse => {
            s4_delete_scene(db);
            s4_insert_scene(db, S4_UPDATED_AT, S4_OTHER_BODY);
        }
    }
}

/// Change one column of the S4 Scene (`assignment` uses `?2`).
fn s4_update_scene(db: &Database, assignment: &str, value: &str) {
    db.with_conn(|conn| {
        conn.execute(
            &format!(
                "UPDATE tree_nodes SET {assignment} WHERE id=?1 AND project_id='generation-project'"
            ),
            params![S4_SCENE_ID, value],
        )?;
        Ok(())
    })
    .expect("update the S4 Scene");
}

/// The attempt an earlier turn prepared for the S4 Scene. Besides the Raw
/// Source reference, the v2 binding pins the Scene incarnation, source token
/// and body digest read in one transaction.
fn s4_scene_request(db: &Database) -> NewAttempt {
    let (token, _incarnation) = s4_scene_state(db);
    let source_key = format!("project:scene:{S4_SCENE_ID}");
    let mut attempt = request(
        vec![InputReference {
            role: InputRole::Context,
            target: InputTarget::RawSource {
                source_key: source_key.clone(),
                revision_token: token.clone(),
            },
            input_use: InputUse::SelectedMaterial,
        }],
        vec![QualificationReference::present(
            0,
            QualificationKind::Source,
            source_key,
            token,
        )],
    );
    attempt.binding.scene = db
        .with_read_transaction(|conn| {
            read_attempt_scene_binding_in_tx(conn, "generation-project", S4_SCENE_ID)
        })
        .expect("S4 Scene binding");
    attempt
}

/// A request assembled like the Native owner does for a production caller:
/// the Main caller session is part of the process-local caller binding, and
/// the chat session stays the DB-validated `generation-session`.
fn s4_production_request(db: &Database, main_caller_session: &str) -> NewAttempt {
    let mut request = s4_scene_request(db);
    request.binding.caller.caller_session_id = main_caller_session.into();
    request
}

#[test]
fn s4_old_attempt_cannot_claim_after_scene_delete_recreate_restore_or_id_reuse() {
    // Every replacement is evaluated before failing so each one reports its
    // own outcome.
    let mut accepted = Vec::new();
    for replacement in [
        S4SceneReplacement::DeleteAndRecreate,
        S4SceneReplacement::SnapshotRestore,
        S4SceneReplacement::IdReuse,
    ] {
        let db = database(Path::new(":memory:"));
        s4_insert_scene(&db, S4_UPDATED_AT, S4_BODY);
        let (old_token, old_incarnation) = s4_scene_state(&db);
        let attempt = create_attempt(&db, s4_scene_request(&db))
            .unwrap_or_else(|error| panic!("{replacement:?}: attempt for the Scene: {error:#}"));

        s4_replace_scene(&db, replacement);

        let (new_token, new_incarnation) = s4_scene_state(&db);
        assert_eq!(
            new_token, old_token,
            "{replacement:?}: the Scene token repeats across incarnations"
        );
        assert_ne!(
            new_incarnation, old_incarnation,
            "{replacement:?}: the Native A1 writer minted a new incarnation"
        );
        match claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()) {
            Ok(won) => accepted.push(format!(
                "{replacement:?}: the old attempt was claimable against a replaced Scene incarnation (won={won})"
            )),
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("NIR1_GENERATION_SCENE_INCARNATION_MISMATCH"),
                "{replacement:?}: {error:#}"
            ),
        }
    }
    assert!(accepted.is_empty(), "{}", accepted.join("\n"));
}

#[test]
fn s4_old_attempt_cannot_claim_archived_scene() {
    let db = database(Path::new(":memory:"));
    s4_insert_scene(&db, S4_UPDATED_AT, S4_BODY);
    let before = s4_scene_state(&db);
    let attempt = create_attempt(&db, s4_scene_request(&db)).expect("attempt for the Scene");
    // A tree patch may archive without bumping the version and with a
    // caller-chosen updated_at, so the token and incarnation stay the same.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-10-12 00:01:00'
              WHERE id=?1 AND project_id='generation-project'",
            [S4_SCENE_ID],
        )?;
        Ok(())
    })
    .expect("archive the Scene");
    assert_eq!(s4_scene_state(&db), before);
    match claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()) {
        Ok(won) => panic!("the old attempt was claimable against an archived Scene (won={won})"),
        Err(error) => assert!(
            error.to_string().contains("NIR1_GENERATION_SCENE_ARCHIVED"),
            "{error:#}"
        ),
    }
}

#[test]
fn s4_main_issued_caller_session_is_not_the_db_chat_session() {
    let db = database(Path::new(":memory:"));
    s4_insert_scene(&db, S4_UPDATED_AT, S4_BODY);
    let attempt = create_attempt(&db, s4_production_request(&db, S4_MAIN_CALLER_SESSION))
        .unwrap_or_else(|error| {
            panic!(
                "a Main-issued caller session must not be validated as a chat session: {error:#}"
            )
        });
    let stored_session: String = db
        .with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT session_id FROM nir1_generation_attempts WHERE id=?1",
                [&attempt.id],
                |row| row.get(0),
            )?)
        })
        .expect("stored session");
    assert_eq!(
        stored_session, "generation-session",
        "the attempt row keeps the DB-validated chat session"
    );
    assert!(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget())
            .expect("the same binding claims once")
    );
}

// DT-3: the binding version dispatcher, the separated sessions, the Scene
// binding checks, the binding size ceiling and the downgrade behaviour.

fn legacy_v1_binding() -> LegacyAttemptBindingV1 {
    let current = binding();
    LegacyAttemptBindingV1 {
        project_id: current.project_id,
        session_id: current.chat_session_id,
        profile_id: current.caller.profile_id,
        caller_id: current.caller.caller_id,
        caller_epoch: current.caller.caller_epoch,
        workspace_binding_digest: current.workspace_binding_digest,
        purpose: current.purpose,
        scope_digest: current.scope_digest,
        material_digest: current.material_digest,
        d1_digest: current.d1_digest,
        route_revision: current.route_revision,
        provider: current.provider,
        model: current.model,
        api: current.api,
        endpoint_identity: current.endpoint_identity,
    }
}

fn binding_value<T: Serialize>(binding: &T) -> Value {
    serde_json::to_value(binding).expect("binding value")
}

fn canonical_binding(value: &Value) -> String {
    canonical_json_string(value).expect("canonical binding")
}

/// Replace one attempt row's binding, as a pre-DT-3 writer, a later writer or
/// an import would have stored it.
fn store_binding_json(db: &Database, attempt_id: &str, binding_json: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts SET binding_json=?2 WHERE id=?1",
            params![attempt_id, binding_json],
        )?;
        Ok(())
    })
    .expect("store binding JSON");
}

/// Change one column of the generic fixture Scene (`assignment` uses `?2`).
fn update_generation_scene(db: &Database, assignment: &str, value: &str) {
    db.with_conn(|conn| {
        conn.execute(
            &format!(
                "UPDATE tree_nodes SET {assignment} WHERE id=?1 AND project_id='generation-project'"
            ),
            params![GENERATION_SCENE_ID, value],
        )?;
        Ok(())
    })
    .expect("update the generation Scene");
}

fn set_generation_session_node(db: &Database, node: Option<&str>) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_sessions SET node_id=?1 WHERE id='generation-session'",
            [node],
        )?;
        Ok(())
    })
    .expect("move the chat session");
}

fn read_generation_scene_binding(db: &Database) -> Result<AttemptSceneBinding> {
    db.with_read_transaction(|conn| {
        read_attempt_scene_binding_in_tx(conn, "generation-project", GENERATION_SCENE_ID)
    })
}

fn assert_error_code<T: std::fmt::Debug>(result: Result<T>, code: &str) {
    let error = result.expect_err(code);
    assert!(
        format!("{error:#}").contains(code),
        "expected {code}, got {error:#}"
    );
}

fn history_budget() -> GenerationHistoryReadBudget {
    GenerationHistoryReadBudget {
        max_attempts: 4,
        sql: Some(GenerationHistorySqlLedger::new(history_sql_budget(
            1_000_000,
        ))),
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
        remaining_project_authority_rows: 0,
        remaining_nodes: 8,
        remaining_edges: 8,
        remaining_qualification_refs: 16,
    }
}

#[test]
fn dt3_scene_reader_returns_the_bound_incarnation_token_and_body_digest() {
    let db = database(Path::new(":memory:"));
    assert_eq!(
        read_generation_scene_binding(&db).expect("fixture Scene binding"),
        generation_scene_binding()
    );
    assert_error_code(
        db.with_conn(|conn| {
            read_attempt_scene_binding_in_tx(conn, "generation-project", GENERATION_SCENE_ID)
        }),
        "NIR1_GENERATION_TRANSACTION_REQUIRED",
    );
    assert_error_code(
        db.with_read_transaction(|conn| {
            read_attempt_scene_binding_in_tx(conn, "other-project", GENERATION_SCENE_ID)
        }),
        "NIR1_GENERATION_SCENE_UNAVAILABLE",
    );
}

#[test]
fn dt3_dispatcher_reads_v1_and_v2_and_rejects_unknown_versions_keys_and_slots() {
    let current = binding_value(&binding());
    assert_eq!(current["bindingVersion"], json!(2));
    assert!(current["historyTurnContext"].is_null());
    assert!(current["durableWorkspaceIdentity"].is_null());
    match parse_attempt_binding(&canonical_binding(&current)).expect("v2 binding") {
        VersionedAttemptBinding::Current(parsed) => assert_eq!(parsed, binding()),
        VersionedAttemptBinding::LegacyV1(_) => panic!("a v2 binding was read as legacy"),
    }
    let legacy = binding_value(&legacy_v1_binding());
    assert!(legacy.get("bindingVersion").is_none());
    assert!(matches!(
        parse_attempt_binding(&canonical_binding(&legacy)).expect("v1 binding"),
        VersionedAttemptBinding::LegacyV1(_)
    ));

    // Raw stored text: canonical JSON itself would spell 2.0 as 2.
    let canonical_current = canonical_binding(&current);
    for version in [
        "1",
        "3",
        r#""2""#,
        "2.0",
        "2e0",
        "-2",
        r#"{"major":2}"#,
        "[2]",
    ] {
        let raw = canonical_current.replacen(
            r#""bindingVersion":2"#,
            &format!(r#""bindingVersion":{version}"#),
            1,
        );
        assert_ne!(raw, canonical_current);
        assert_error_code(
            parse_attempt_binding(&raw),
            "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
        );
    }
    // An explicit null is not a version; the v1 struct rejects the key.
    for base in [&current, &legacy] {
        let mut value = base.clone();
        value["bindingVersion"] = Value::Null;
        assert_error_code(
            parse_attempt_binding(&canonical_binding(&value)),
            "NIR1_GENERATION_BINDING_INVALID",
        );
    }
    for base in [&current, &legacy] {
        let mut value = base.clone();
        value["unknownAuthority"] = json!("unchecked");
        assert_error_code(
            parse_attempt_binding(&canonical_binding(&value)),
            "NIR1_GENERATION_BINDING_INVALID",
        );
    }
    for nested in ["scene", "caller"] {
        let mut value = current.clone();
        value[nested]["unknownAuthority"] = json!("unchecked");
        assert_error_code(
            parse_attempt_binding(&canonical_binding(&value)),
            "NIR1_GENERATION_BINDING_INVALID",
        );
    }
    // HS-1: the two slots accept their closed forms only. Any other value is
    // a malformed binding (a parse failure), never a silently skipped slot.
    for slot in ["historyTurnContext", "durableWorkspaceIdentity"] {
        for filled in [json!({}), json!("value"), json!(0), json!([]), json!(true)] {
            let mut value = current.clone();
            value[slot] = filled;
            assert_error_code(
                parse_attempt_binding(&canonical_binding(&value)),
                "NIR1_GENERATION_BINDING_INVALID",
            );
        }
    }
    let mut closed = current.clone();
    closed["historyTurnContext"] = json!({
        "contract": "nir1-history-turn-context/1",
        "unavailable": "d-final-incomplete"
    });
    closed["durableWorkspaceIdentity"] = binding_value(&history_context::testing::sample_identity());
    match parse_attempt_binding(&canonical_binding(&closed)).expect("closed slots") {
        VersionedAttemptBinding::Current(parsed) => {
            assert_eq!(
                parsed.history_turn_context,
                Some(HistoryContextSlot::Unavailable(
                    HistoryUnavailableReason::DFinalIncomplete
                ))
            );
            assert!(parsed.durable_workspace_identity.is_some());
        }
        VersionedAttemptBinding::LegacyV1(_) => panic!("a v2 binding was read as legacy"),
    }
    // An unknown context contract is not a parse failure of the binding.
    let mut later = current.clone();
    later["historyTurnContext"] = json!({"contract": "nir1-history-turn-context/2", "x": []});
    match parse_attempt_binding(&canonical_binding(&later)).expect("unknown contract") {
        VersionedAttemptBinding::Current(parsed) => assert_eq!(
            parsed.history_turn_context,
            Some(HistoryContextSlot::UnknownContract)
        ),
        VersionedAttemptBinding::LegacyV1(_) => panic!("a v2 binding was read as legacy"),
    }
    let mut without_scene = current.clone();
    without_scene
        .as_object_mut()
        .expect("binding object")
        .remove("scene");
    assert_error_code(
        parse_attempt_binding(&canonical_binding(&without_scene)),
        "NIR1_GENERATION_BINDING_INVALID",
    );
    let duplicated = canonical_binding(&current).replacen('{', r#"{"bindingVersion":2,"#, 1);
    assert_error_code(
        parse_attempt_binding(&duplicated),
        "NIR1_GENERATION_BINDING_INVALID",
    );
}

#[test]
fn dfa1_legacy_v1_reference_rows_are_terminalized_but_never_claimed() {
    let workspace = bounded::BoundedWorkspace::new();
    let snapshot = workspace.snapshot();
    let pinned = workspace.db();
    let db = pinned.db();
    let human = human(db, "legacy-ref-human", "input");
    let make = |source: &str| {
        create_attempt(
            db,
            request(
                vec![message_input(&human)],
                vec![QualificationReference::present(
                    0,
                    QualificationKind::Source,
                    source,
                    "digest",
                )],
            ),
        )
        .expect("attempt")
    };
    let claimed_probe = make("legacy-ref-probe");
    let recovered = make("legacy-ref-recovered");
    for attempt in [&claimed_probe, &recovered] {
        let legacy_input = LegacyInputReferenceV1 {
            role: attempt.inputs[0].role.clone(),
            target: attempt.inputs[0].target.clone(),
        };
        let legacy_qualification = LegacyQualificationReferenceV1 {
            input_ordinal: 0,
            kind: QualificationKind::Source,
            identity: attempt.qualifications[0]
                .identity()
                .expect("present")
                .to_string(),
            version: attempt.qualifications[0]
                .version()
                .expect("present")
                .to_string(),
        };
        let legacy_digest = canonical_json_digest(&json!({
            "domain":"nir1-generation-inputs@1",
            "inputs":[legacy_input],"qualifications":[legacy_qualification]}))
        .expect("legacy digest");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE nir1_generation_input_refs SET reference_json=?2 WHERE attempt_id=?1",
                params![
                    attempt.id,
                    canonical_json_string(&serde_json::to_value(&legacy_input)?)?
                ],
            )?;
            conn.execute(
                "UPDATE nir1_generation_qualification_refs SET reference_json=?2 WHERE attempt_id=?1",
                params![
                    attempt.id,
                    canonical_json_string(&serde_json::to_value(&legacy_qualification)?)?
                ],
            )?;
            conn.execute(
                "UPDATE nir1_generation_attempts SET input_digest=?2 WHERE id=?1",
                params![attempt.id, legacy_digest],
            )?;
            Ok(())
        })
        .expect("rewrite the rows as v1");
        let stored = read_attempt(db, &attempt.id, budget()).expect("v1 rows stay readable");
        assert_eq!(stored.reference_format, ReferenceFormat::LegacyV1);
        assert!(stored.inputs.is_empty() && stored.qualifications.is_empty());
        // The unbounded claim and the production claim both refuse; neither
        // validates zero references and then writes claimed_at_ms.
        assert_error_code(
            claim_attempt(db, &attempt.id, &attempt.binding, 1_500, budget()),
            "NIR1_GENERATION_REFERENCE_LEGACY_TERMINAL_ONLY",
        );
        let refused = claim_attempt_bounded(
            &snapshot,
            &bounded::expected(&stored),
            &bounded::admission(),
            &mut || Ok(()),
        )
        .expect_err("a v1 reference row is never claimed by the production writer");
        assert_eq!(refused.commit(), Nir1CommitState::NotCommitted);
        assert!(
            format!("{:#}", refused.source)
                .contains("NIR1_GENERATION_REFERENCE_LEGACY_TERMINAL_ONLY"),
            "{:#}",
            refused.source
        );
    }
    db.with_conn(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM nir1_generation_attempts WHERE claimed_at_ms IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            0
        );
        Ok(())
    })
    .expect("no claim was written");
    // Recovery and a body-less terminal still work for a v1 reference row.
    let terminal = recover_attempt_bounded(
        &snapshot,
        &recovered.id,
        2_000,
        ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT,
            NIR1_GENERATION_SQLITE_BUSY_LIMIT,
        ),
    )
    .expect("v1 reference recovery");
    assert!(terminal.message_version.is_none());
    let cancellation = OutputObserver::new().finish(Completion::Cancelled);
    let cancelled = finish_attempt(db, &claimed_probe.id, &cancellation, None, 2_000)
        .expect("v1 reference cancel");
    assert_eq!(
        cancelled.failure_classification,
        Some(FailureClassification::Cancelled)
    );
}

#[test]
fn dt3_legacy_v1_row_is_terminalized_but_never_claimed_or_read_as_current() {
    let workspace = bounded::BoundedWorkspace::new();
    let snapshot = workspace.snapshot();
    let pinned = workspace.db();
    let db = pinned.db();
    let recovered = create_attempt(db, request(vec![], vec![])).expect("recovered attempt");
    let cancelled = create_attempt(db, request(vec![], vec![])).expect("cancelled attempt");
    let legacy_json = canonical_binding(&binding_value(&legacy_v1_binding()));
    for attempt in [&recovered, &cancelled] {
        store_binding_json(db, &attempt.id, &legacy_json);
        assert_error_code(
            read_attempt(db, &attempt.id, budget()),
            "NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY",
        );
        assert_error_code(
            claim_attempt(db, &attempt.id, &attempt.binding, 1_500, budget()),
            "NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY",
        );
        let refused = claim_attempt_bounded(
            &snapshot,
            &bounded::expected(attempt),
            &bounded::admission(),
            &mut || Ok(()),
        )
        .expect_err("a legacy v1 row is never claimed by the production writer");
        assert_eq!(refused.commit(), Nir1CommitState::NotCommitted);
        assert!(
            format!("{:#}", refused.source)
                .contains("NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY"),
            "{:#}",
            refused.source
        );
        assert_error_code(
            finish_attempt(
                db,
                &attempt.id,
                &completed("legacy answer", ""),
                Some(NewMessageBody {
                    message_id: format!("legacy-body-{}", attempt.id),
                    content: "legacy answer".into(),
                    thinking: String::new(),
                }),
                1_600,
            ),
            "NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY",
        );
    }
    db.with_conn(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM nir1_generation_attempts WHERE claimed_at_ms IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM chat_messages WHERE role='assistant'",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            0
        );
        Ok(())
    })
    .expect("no claim and no generated body");

    // The production sweep terminalizes a legacy row through the bounded
    // recovery writer.
    let terminal = recover_attempt_bounded(
        &snapshot,
        &recovered.id,
        2_000,
        ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + NIR1_GENERATION_UNTIMED_TEST_OPERATION_LIMIT,
            NIR1_GENERATION_SQLITE_BUSY_LIMIT,
        ),
    )
    .expect("legacy recovery");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::InterruptedUnknown)
    );
    assert!(terminal.message_version.is_none());
    assert_eq!(
        read_terminal(db, &recovered.id).expect("legacy terminal"),
        Some(terminal.clone())
    );
    assert_eq!(
        recover_attempt(db, &recovered.id, 3_000).expect("repeat recovery"),
        terminal
    );
    let cancellation = OutputObserver::new().finish(Completion::Cancelled);
    let cancelled_terminal =
        finish_attempt(db, &cancelled.id, &cancellation, None, 2_000).expect("legacy cancel");
    assert_eq!(
        cancelled_terminal.failure_classification,
        Some(FailureClassification::Cancelled)
    );
    assert_eq!(
        read_terminal(db, &cancelled.id).expect("cancelled terminal"),
        Some(cancelled_terminal)
    );
    assert!(pending_attempt_ids(db, "generation-project", None, 8)
        .expect("pending page")
        .is_empty());
}

#[test]
fn dt3_legacy_v1_receipt_stays_readable_but_cannot_parent_or_feed_history() {
    let db = database(Path::new(":memory:"));
    let parent = create_attempt(&db, request(vec![], vec![])).expect("parent");
    let terminal = finish_success(&db, &parent, "legacy-parent-message", "answer");
    let parent_version = terminal.message_version.clone().expect("parent version");
    store_binding_json(
        &db,
        &parent.id,
        &canonical_binding(&binding_value(&legacy_v1_binding())),
    );

    assert_eq!(
        read_terminal(&db, &parent.id).expect("written terminal stays readable"),
        Some(terminal)
    );
    assert_error_code(
        create_attempt(&db, request(vec![message_input(&parent_version)], vec![])),
        "NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY",
    );
    let mut caller_budget = history_budget();
    assert_error_code(
        with_snapshot(&db, &mut caller_budget, |reader, budget| {
            reader.read_attempt(budget, &parent.id).map(|_| ())
        }),
        "NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY",
    );
}

#[test]
fn dt3_unknown_binding_version_row_is_never_claimed_or_recovered() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let mut future = binding_value(&attempt.binding);
    future["bindingVersion"] = json!(3);
    future["historyTurnContext"] = json!({"turn": "a later writer"});
    store_binding_json(&db, &attempt.id, &canonical_binding(&future));

    assert_error_code(
        read_attempt(&db, &attempt.id, budget()),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
    assert_error_code(
        recover_attempt(&db, &attempt.id, 2_000),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
    assert!(read_terminal(&db, &attempt.id)
        .expect("no terminal")
        .is_none());
    assert_eq!(
        pending_attempt_ids(&db, "generation-project", None, 8).expect("pending page"),
        vec![attempt.id.clone()]
    );
}

/// A reader that predates DT-3 knows only the v1 struct; it must not read a
/// v2 row at all, so it can neither claim nor terminalize one.
#[test]
fn dt3_v1_only_reader_rejects_v2_rows_fail_closed() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let stored: String = db
        .with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                [&attempt.id],
                |row| row.get(0),
            )?)
        })
        .expect("stored binding");
    assert_eq!(stored, canonical_binding(&binding_value(&attempt.binding)));
    let error = serde_json::from_str::<LegacyAttemptBindingV1>(&stored)
        .expect_err("a v1-only reader must reject a v2 binding");
    assert!(error.to_string().contains("unknown field"), "{error}");
    serde_json::from_str::<LegacyAttemptBindingV1>(&canonical_binding(&binding_value(
        &legacy_v1_binding(),
    )))
    .expect("the v1 reader still reads v1 rows");
}

#[test]
fn dt3_session_confusion_and_detached_sessions_are_rejected() {
    let db = database(Path::new(":memory:"));
    let mut confused = request(vec![], vec![]);
    confused.binding.caller.caller_session_id = confused.binding.chat_session_id.clone();
    assert_error_code(
        create_attempt(&db, confused),
        "NIR1_GENERATION_SESSION_CONFUSION",
    );
    let mut main_session_as_chat = request(vec![], vec![]);
    main_session_as_chat.binding.chat_session_id = S4_MAIN_CALLER_SESSION.into();
    assert_error_code(
        create_attempt(&db, main_session_as_chat),
        "NIR1_GENERATION_SESSION_MISMATCH",
    );
    set_generation_session_node(&db, None);
    assert_error_code(
        create_attempt(&db, request(vec![], vec![])),
        "NIR1_GENERATION_SESSION_SCENE_MISMATCH",
    );

    set_generation_session_node(&db, Some(GENERATION_SCENE_ID));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attached session");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes(id,project_id,node_type,title,sort_order)
             VALUES ('generation-folder','generation-project','folder','Folder','a1')",
            [],
        )?;
        Ok(())
    })
    .expect("another node");
    set_generation_session_node(&db, Some("generation-folder"));
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_SESSION_SCENE_MISMATCH",
    );
    set_generation_session_node(&db, Some(GENERATION_SCENE_ID));
    let mut other_main_session = attempt.binding.clone();
    other_main_session.caller.caller_session_id = S4_MAIN_CALLER_SESSION.into();
    assert_error_code(
        claim_attempt(&db, &attempt.id, &other_main_session, 1_500, budget()),
        "NIR1_GENERATION_BINDING_MISMATCH",
    );
    assert!(read_attempt(&db, &attempt.id, budget())
        .expect("attempt")
        .claimed_at_ms
        .is_none());
    assert!(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget())
            .expect("the exact binding still claims")
    );
}

#[test]
fn dt3_in_place_scene_changes_and_missing_incarnation_reject_the_attempt() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");

    // A tree patch may change the body without bumping the version and with a
    // caller-chosen updated_at, so the token stays the same.
    update_generation_scene(
        &db,
        "content=?2",
        r#"{"type":"doc","content":[{"type":"paragraph"}]}"#,
    );
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_SCENE_BODY_MISMATCH",
    );
    update_generation_scene(&db, "content=?2", GENERATION_SCENE_BODY);

    // An edit inside the same incarnation changes the token.
    update_generation_scene(&db, "updated_at=?2", "2026-10-11 00:00:01");
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_SCENE_SOURCE_STALE",
    );
    update_generation_scene(&db, "updated_at=?2", GENERATION_SCENE_UPDATED_AT);
    assert_eq!(
        read_generation_scene_binding(&db).expect("restored Scene"),
        generation_scene_binding()
    );

    // A Scene row without its Native scope incarnation row.
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_scene_scope_bindings
              WHERE project_id='generation-project' AND scene_id=?1",
            [GENERATION_SCENE_ID],
        )?;
        Ok(())
    })
    .expect("drop the A1 row");
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_SCENE_UNAVAILABLE",
    );
    assert_error_code(
        create_attempt(&db, request(vec![], vec![])),
        "NIR1_GENERATION_SCENE_UNAVAILABLE",
    );
    assert!(read_attempt(&db, &attempt.id, budget())
        .expect("attempt")
        .claimed_at_ms
        .is_none());
}

#[test]
fn dt3_scene_body_over_the_packing_ceiling_is_rejected_before_materialization() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    // A BLOB cannot be read as the String body, so only the scalar length
    // admission can produce the limit error below.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content=zeroblob(?2) WHERE id=?1",
            params![
                GENERATION_SCENE_ID,
                i64::try_from(MAX_PACKING_INPUT_BYTES + 1)?
            ],
        )?;
        Ok(())
    })
    .expect("oversized body");
    assert_error_code(
        read_generation_scene_binding(&db),
        "NIR1_GENERATION_SCENE_BODY_LIMIT",
    );
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_SCENE_BODY_LIMIT",
    );

    let at_ceiling = "x".repeat(MAX_PACKING_INPUT_BYTES);
    update_generation_scene(&db, "content=?2", &at_ceiling);
    assert_eq!(
        read_generation_scene_binding(&db)
            .expect("a body at the ceiling")
            .body_digest,
        format!(
            "sha256:{}",
            hex::encode(Sha256::digest(at_ceiling.as_bytes()))
        )
    );
}

#[test]
fn dt3_v2_binding_over_64_kib_is_rejected_at_create_and_before_parse() {
    let db = database(Path::new(":memory:"));
    // Every identity stays within MAX_ID_BYTES, but JSON escaping makes the
    // canonical binding larger than the storage ceiling.
    let escaped = "\u{1}".repeat(MAX_ID_BYTES);
    let mut oversized = request(vec![], vec![]);
    oversized.binding.provider = escaped.clone();
    oversized.binding.model = escaped.clone();
    oversized.binding.api = escaped;
    assert_error_code(
        create_attempt(&db, oversized),
        "NIR1_GENERATION_BINDING_LIMIT",
    );
    assert!(pending_attempt_ids(&db, "generation-project", None, 8)
        .expect("pending page")
        .is_empty());

    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let mut padded = binding_value(&attempt.binding);
    padded["model"] = json!("m".repeat(MAX_BINDING_JSON_BYTES));
    let padded = canonical_binding(&padded);
    assert!(padded.len() > MAX_BINDING_JSON_BYTES);
    store_binding_json(&db, &attempt.id, &padded);
    assert_error_code(
        read_attempt(&db, &attempt.id, budget()),
        "NIR1_GENERATION_BINDING_LIMIT",
    );
    assert_error_code(
        claim_attempt(&db, &attempt.id, &attempt.binding, 1_500, budget()),
        "NIR1_GENERATION_BINDING_LIMIT",
    );
    assert_error_code(
        recover_attempt(&db, &attempt.id, 2_000),
        "NIR1_GENERATION_BINDING_LIMIT",
    );
}

// ---------------------------------------------------------------------------
// DT-3 on the DT-2 bounded writers. Create and claim re-read the chat session
// and the Scene incarnation inside their own IMMEDIATE transaction, and the
// claim commits its CAS in that same transaction. The terminal writers record
// an observation, so they never require a current Scene.
// ---------------------------------------------------------------------------

mod dt3_bounded {
    use super::bounded::{admission, expected, pinned_budget, BoundedWorkspace};
    use super::*;

    fn no_check() -> impl FnMut() -> Result<()> {
        || Ok(())
    }

    /// An unclaimed zero-send terminal of `attempt` through the pinned writer.
    fn zero_send(
        snapshot: &ActiveWorkspaceSnapshot,
        attempt: &StoredAttempt,
    ) -> std::result::Result<StoredTerminal, Nir1GenerationStoreError> {
        finish_pretransport_attempt_bounded(
            snapshot,
            &expected(attempt),
            Nir1ExpectedClaim::Unclaimed,
            Nir1ZeroSendCompletion::DispatchFailure,
            &pinned_budget(),
        )
    }

    /// The attempt of the S4 Scene, created by the production writer in a
    /// fresh workspace. Its binding pins the Scene incarnation, token and
    /// body read in the create transaction's snapshot.
    fn scene_workspace() -> (BoundedWorkspace, StoredAttempt) {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let pinned = workspace.db();
        s4_insert_scene(pinned.db(), S4_UPDATED_AT, S4_BODY);
        let now = wall_clock_ms().expect("clock");
        let attempt = create_attempt_with_id_bounded(
            &snapshot,
            &test_digest("dt3-bounded-scene-attempt"),
            production_slots(NewAttempt {
                created_at_ms: now,
                expires_at_ms: now + 60_000,
                ..s4_scene_request(pinned.db())
            }),
            &admission(),
            &mut no_check(),
        )
        .expect("the production create binds the live Scene");
        (workspace, attempt)
    }

    /// Every way the Scene or the session can stop matching the attempt's
    /// binding between create and claim is refused by the production claim,
    /// inside the transaction that would have committed its CAS. The attempt
    /// stays unclaimed, and the pinned zero-send writer still records its
    /// terminal: a terminal is an observation, not a send.
    #[test]
    fn dt3_bounded_claim_refuses_a_changed_scene_or_session_and_zero_send_still_records() {
        type Change = fn(&Database);
        // (name, change, expected code, whether the Scene token repeats while
        // the incarnation is new)
        let cases: [(&str, Change, &str, bool); 7] = [
            (
                "delete and recreate",
                |db| s4_replace_scene(db, S4SceneReplacement::DeleteAndRecreate),
                "NIR1_GENERATION_SCENE_INCARNATION_MISMATCH",
                true,
            ),
            (
                "snapshot restore",
                |db| s4_replace_scene(db, S4SceneReplacement::SnapshotRestore),
                "NIR1_GENERATION_SCENE_INCARNATION_MISMATCH",
                true,
            ),
            (
                "id reuse",
                |db| s4_replace_scene(db, S4SceneReplacement::IdReuse),
                "NIR1_GENERATION_SCENE_INCARNATION_MISMATCH",
                true,
            ),
            (
                "archived",
                |db| s4_update_scene(db, "archived_at=?2", "2026-10-12 00:01:00"),
                "NIR1_GENERATION_SCENE_ARCHIVED",
                false,
            ),
            (
                "body changed in place",
                |db| s4_update_scene(db, "content=?2", S4_OTHER_BODY),
                "NIR1_GENERATION_SCENE_BODY_MISMATCH",
                false,
            ),
            (
                "edited inside the incarnation",
                |db| s4_update_scene(db, "updated_at=?2", "2026-10-12 00:00:01"),
                "NIR1_GENERATION_SCENE_SOURCE_STALE",
                false,
            ),
            (
                "chat session detached from the Scene",
                |db| set_generation_session_node(db, None),
                "NIR1_GENERATION_SESSION_SCENE_MISMATCH",
                false,
            ),
        ];
        for (name, change, code, aba) in cases {
            let (workspace, attempt) = scene_workspace();
            let snapshot = workspace.snapshot();
            let pinned = workspace.db();
            let db = pinned.db();
            let before = s4_scene_state(db);
            change(db);
            if aba {
                let after = s4_scene_state(db);
                assert_eq!(after.0, before.0, "{name}: the Scene token repeats");
                assert_ne!(after.1, before.1, "{name}: the incarnation is new");
            }
            let error = claim_attempt_bounded(
                &snapshot,
                &expected(&attempt),
                &admission(),
                &mut no_check(),
            )
            .expect_err(name);
            assert_eq!(error.commit(), Nir1CommitState::NotCommitted, "{name}");
            assert!(
                error_chain_contains(&error.source, code),
                "{name}: expected {code}, got {:#}",
                error.source
            );
            assert!(
                read_attempt(db, &attempt.id, budget())
                    .expect("attempt")
                    .claimed_at_ms
                    .is_none(),
                "{name}: no claim reached COMMIT"
            );
            let terminal = zero_send(&snapshot, &attempt)
                .unwrap_or_else(|error| panic!("{name}: zero-send must record: {error}"));
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::DispatchUnavailable),
                "{name}"
            );
            assert!(pinned.connection_reusable(), "{name}");
        }
    }

    /// Create reads the same things in its own transaction: a binding built
    /// from an older Scene snapshot, an unknown chat session, a session that
    /// is not on the Scene, or a merged caller/chat session is refused before
    /// a row exists.
    #[test]
    fn dt3_bounded_create_refuses_a_binding_that_does_not_match_the_live_scene() {
        type Mutate = fn(&Database, &mut NewAttempt);
        let cases: [(&str, Mutate, &str); 8] = [
            (
                "another incarnation",
                |_, request| {
                    request.binding.scene.scene_incarnation_id = "another-incarnation".into()
                },
                "NIR1_GENERATION_SCENE_INCARNATION_MISMATCH",
            ),
            (
                "stale source token",
                |_, request| request.binding.scene.source_token = "v9@2026-10-11 00:00:00".into(),
                "NIR1_GENERATION_SCENE_SOURCE_STALE",
            ),
            (
                "another body",
                |_, request| request.binding.scene.body_digest = test_digest("another body"),
                "NIR1_GENERATION_SCENE_BODY_MISMATCH",
            ),
            (
                "unknown Scene",
                |_, request| request.binding.scene.scene_id = "unknown-scene".into(),
                "NIR1_GENERATION_SCENE_UNAVAILABLE",
            ),
            (
                "archived Scene",
                |db, _| update_generation_scene(db, "archived_at=?2", "2026-10-12 00:01:00"),
                "NIR1_GENERATION_SCENE_ARCHIVED",
            ),
            (
                "a Main caller session as the chat session",
                |_, request| request.binding.chat_session_id = S4_MAIN_CALLER_SESSION.into(),
                "NIR1_GENERATION_SESSION_MISMATCH",
            ),
            (
                "chat session not on the Scene",
                |db, _| set_generation_session_node(db, None),
                "NIR1_GENERATION_SESSION_SCENE_MISMATCH",
            ),
            (
                "caller session equal to the chat session",
                |_, request| {
                    request.binding.caller.caller_session_id =
                        request.binding.chat_session_id.clone()
                },
                "NIR1_GENERATION_SESSION_CONFUSION",
            ),
        ];
        for (index, (name, mutate, code)) in cases.into_iter().enumerate() {
            let workspace = BoundedWorkspace::new();
            let snapshot = workspace.snapshot();
            let pinned = workspace.db();
            let db = pinned.db();
            let now = wall_clock_ms().expect("clock");
            let mut stale = NewAttempt {
                created_at_ms: now,
                expires_at_ms: now + 60_000,
                ..request(vec![], vec![])
            };
            mutate(db, &mut stale);
            let id = test_digest(&format!("dt3-bounded-create-{index}"));
            let error = create_attempt_with_id_bounded(
                &snapshot,
                &id,
                production_slots(stale),
                &admission(),
                &mut no_check(),
            )
            .expect_err(name);
            assert_eq!(error.commit(), Nir1CommitState::NotCommitted, "{name}");
            assert!(
                error_chain_contains(&error.source, code),
                "{name}: expected {code}, got {:#}",
                error.source
            );
            assert!(
                pending_attempt_ids(db, "generation-project", None, 8)
                    .expect("pending page")
                    .is_empty(),
                "{name}: nothing was written"
            );
            assert!(pinned.connection_reusable(), "{name}");
        }
    }

    /// The terminal writers do not re-check the Scene. Attempts that were
    /// claimed before their Scene was replaced still record their
    /// observation, with a generated body or as a recovered interruption.
    #[test]
    fn dt3_scene_change_after_claim_does_not_block_the_terminal_record() {
        let (workspace, attempt) = scene_workspace();
        let snapshot = workspace.snapshot();
        let pinned = workspace.db();
        let db = pinned.db();
        let now = wall_clock_ms().expect("clock");
        let second = create_attempt_with_id_bounded(
            &snapshot,
            &test_digest("dt3-bounded-second-attempt"),
            production_slots(NewAttempt {
                created_at_ms: now,
                expires_at_ms: now + 60_000,
                payload_digest: test_digest("dt3 second payload"),
                ..s4_scene_request(db)
            }),
            &admission(),
            &mut no_check(),
        )
        .expect("a second attempt of the same Scene");
        for claimed in [&attempt, &second] {
            let Ok(Nir1ClaimOutcome::Claimed { .. }) =
                claim_attempt_bounded(&snapshot, &expected(claimed), &admission(), &mut no_check())
            else {
                panic!("the live Scene claims");
            };
        }
        s4_replace_scene(db, S4SceneReplacement::DeleteAndRecreate);
        assert_ne!(
            s4_scene_state(db).1,
            attempt.binding.scene.scene_incarnation_id,
            "the Scene was replaced after the claims"
        );
        let terminal = finish_attempt_bounded(
            &snapshot,
            &expected(&attempt),
            &completed("recorded answer", ""),
            Some(NewMessageBody {
                message_id: "dt3-after-claim-message".into(),
                content: "recorded answer".into(),
                thinking: String::new(),
            }),
            wall_clock_ms().expect("clock"),
            &pinned_budget(),
        )
        .expect("a replaced Scene does not block the observation of a claimed attempt");
        assert!(terminal.message_version.is_some());
        let recovered =
            recover_claimed_attempt_bounded(&snapshot, &expected(&second), &pinned_budget())
                .expect("a replaced Scene does not block the recovery of a claimed attempt");
        assert_eq!(
            recovered.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
    }
}

/// DF+-a (K4/3 sections 2, 3 and 13): the closed reference types, the
/// versioned reference rows and the pure completeness rule.
mod df_plus_reference_format {
    use super::*;
    use std::collections::BTreeSet;

    const Q: &str = "scene-q";

    fn context() -> CompletenessContext<'static> {
        CompletenessContext {
            target_scene_id: Q,
            expected_targets: None,
        }
    }

    fn message(role: InputRole, input_use: InputUse, version: &str) -> InputReference {
        let parent_attempt_id = (role == InputRole::Assistant).then(|| "parent-attempt".to_owned());
        InputReference {
            role,
            target: InputTarget::Message {
                version_id: version.into(),
                parent_attempt_id,
            },
            input_use,
        }
    }

    fn raw(source_key: &str) -> InputReference {
        InputReference {
            role: InputRole::Context,
            target: InputTarget::RawSource {
                source_key: source_key.into(),
                revision_token: "raw-token".into(),
            },
            input_use: InputUse::SelectedMaterial,
        }
    }

    fn revision(id: &str) -> InputReference {
        InputReference {
            role: InputRole::Context,
            target: InputTarget::AcceptedRevision {
                revision_id: id.into(),
                bundle_digest: test_digest(id),
            },
            input_use: InputUse::SelectedMaterial,
        }
    }

    fn na(
        ordinal: usize,
        kind: QualificationKind,
        reason: NotApplicableReason,
    ) -> QualificationReference {
        QualificationReference::not_applicable(ordinal, kind, reason)
    }

    fn scope(ordinal: usize, role: ScopeRole, components: &[&str]) -> QualificationReference {
        QualificationReference::scope(
            ordinal,
            role,
            scope_identity(role, components).expect("identity"),
            "scope-token",
        )
    }

    fn scene_scope(ordinal: usize) -> Vec<QualificationReference> {
        vec![
            scope(ordinal, ScopeRole::QuerySceneScope, &[Q]),
            scope(ordinal, ScopeRole::QuerySceneIncarnation, &[Q]),
        ]
    }

    fn d1(ordinal: usize) -> QualificationReference {
        d1_selection_reference(ordinal, &test_digest("selection"))
    }

    fn message_refs(
        ordinal: usize,
        version: &str,
        decision: NotApplicableReason,
        d1_cell: Option<NotApplicableReason>,
    ) -> Vec<QualificationReference> {
        use NotApplicableReason as N;
        use QualificationKind as K;
        let mut refs = vec![
            QualificationReference::present(ordinal, K::Source, version, "body-digest"),
            na(ordinal, K::Revision, N::NotARevision),
            na(ordinal, K::Decision, decision),
            na(ordinal, K::Freshness, N::ImmutableMessageVersion),
            na(ordinal, K::Index, N::NotIndexDerived),
        ];
        refs.extend(scene_scope(ordinal));
        refs.push(match d1_cell {
            Some(reason) => na(ordinal, K::D1, reason),
            None => d1(ordinal),
        });
        refs
    }

    fn current_human_refs(ordinal: usize) -> Vec<QualificationReference> {
        message_refs(
            ordinal,
            "human-v",
            NotApplicableReason::HumanAuthored,
            Some(NotApplicableReason::FixedUserSlot),
        )
    }

    fn raw_refs(
        ordinal: usize,
        source_key: &str,
        freshness: NotApplicableReason,
    ) -> Vec<QualificationReference> {
        use NotApplicableReason as N;
        use QualificationKind as K;
        let mut refs = vec![
            QualificationReference::present(ordinal, K::Source, source_key, "raw-token"),
            na(ordinal, K::Revision, N::NotARevision),
            na(ordinal, K::Decision, N::ManuscriptSource),
            na(ordinal, K::Freshness, freshness),
            na(ordinal, K::Index, N::NotIndexDerived),
            d1(ordinal),
        ];
        refs.extend(scene_scope(ordinal));
        refs
    }

    fn revision_refs(
        ordinal: usize,
        id: &str,
        sources: &[&str],
        proofs: &[(&str, &str)],
        typed_scopes: usize,
    ) -> Vec<QualificationReference> {
        use QualificationKind as K;
        let mut refs = vec![
            QualificationReference::present(ordinal, K::Revision, id, "bundle"),
            QualificationReference::present(ordinal, K::Decision, "decision-1", "decision-token"),
            QualificationReference::present(ordinal, K::Freshness, id, "freshness-token"),
            na(ordinal, K::Index, NotApplicableReason::NotIndexDerived),
            d1(ordinal),
        ];
        for source in sources {
            refs.push(QualificationReference::present(
                ordinal,
                K::Source,
                *source,
                "source-token",
            ));
        }
        refs.push(scope(ordinal, ScopeRole::ProjectAuthority, &["project"]));
        refs.push(scope(ordinal, ScopeRole::QuerySceneScope, &[Q]));
        refs.push(scope(ordinal, ScopeRole::QuerySceneSource, &[Q]));
        refs.push(scope(ordinal, ScopeRole::QuerySceneIncarnation, &[Q]));
        refs.push(scope(ordinal, ScopeRole::RevealState, &[Q]));
        refs.push(scope(ordinal, ScopeRole::ScopeAxis, &[Q]));
        for index in 0..typed_scopes {
            refs.push(scope(
                ordinal,
                ScopeRole::TypedScope,
                &[id, &index.to_string()],
            ));
        }
        for (anchor, incarnation) in proofs {
            refs.push(scope(
                ordinal,
                ScopeRole::MaterialSceneProof,
                &[anchor, incarnation],
            ));
        }
        refs
    }

    fn table_inputs() -> Vec<InputReference> {
        vec![
            message(InputRole::User, InputUse::CurrentTurn, "human-v"),
            message(InputRole::User, InputUse::AdoptedHistory, "past-human-v"),
            message(
                InputRole::Assistant,
                InputUse::AdoptedHistory,
                "generated-v",
            ),
            raw("project:scene:scene-q"),
            revision("revision-1"),
        ]
    }

    fn table_refs() -> Vec<QualificationReference> {
        let mut refs = current_human_refs(0);
        refs.extend(message_refs(
            1,
            "past-human-v",
            NotApplicableReason::HumanAuthored,
            None,
        ));
        refs.extend(message_refs(
            2,
            "generated-v",
            NotApplicableReason::DerivedFromParents,
            None,
        ));
        refs.extend(raw_refs(
            3,
            "project:scene:scene-q",
            NotApplicableReason::TargetSceneBodyNotADependency,
        ));
        refs.extend(revision_refs(
            4,
            "revision-1",
            &["project:scene:scene-q", "evidence:e1"],
            &[("anchor", "incarnation-a")],
            2,
        ));
        refs
    }

    fn check(
        inputs: &[InputReference],
        refs: &[QualificationReference],
    ) -> std::result::Result<(), CompletenessViolation> {
        check_attempt_completeness(inputs, refs, &context())
    }

    fn reason_of(inputs: &[InputReference], refs: &[QualificationReference]) -> CompletenessReason {
        check(inputs, refs).expect_err("incomplete").reason
    }

    #[test]
    fn completeness_requires_exactly_one_current_turn_at_ordinal_zero() {
        // A past Human first and the current turn second: the D1 selection
        // would start from the wrong input.
        let reordered = vec![
            message(InputRole::User, InputUse::AdoptedHistory, "past-human-v"),
            message(InputRole::User, InputUse::CurrentTurn, "human-v"),
        ];
        let mut refs = message_refs(0, "past-human-v", NotApplicableReason::HumanAuthored, None);
        refs.extend(current_human_refs(1));
        assert_eq!(
            check(&reordered, &refs),
            Err(CompletenessViolation {
                input_ordinal: Some(0),
                kind: None,
                scope_role: None,
                reason: CompletenessReason::InputUseMismatch,
            })
        );
        // Two current-turn inputs.
        let doubled = vec![
            message(InputRole::User, InputUse::CurrentTurn, "human-v"),
            message(InputRole::User, InputUse::CurrentTurn, "human-v-2"),
        ];
        let mut refs = current_human_refs(0);
        refs.extend(current_human_refs(1));
        assert_eq!(
            reason_of(&doubled, &refs),
            CompletenessReason::InputUseMismatch
        );
        // A conversation attempt without a current turn.
        let history_only = vec![message(
            InputRole::User,
            InputUse::AdoptedHistory,
            "past-human-v",
        )];
        let refs = message_refs(0, "past-human-v", NotApplicableReason::HumanAuthored, None);
        assert_eq!(
            reason_of(&history_only, &refs),
            CompletenessReason::InputUseMismatch
        );
        // The intended order stays complete.
        assert_eq!(check(&table_inputs(), &table_refs()), Ok(()));
    }

    #[test]
    fn completeness_accepts_every_table_row() {
        assert_eq!(check(&table_inputs(), &table_refs()), Ok(()));
    }

    #[test]
    fn completeness_rejects_missing_kind_and_empty_input() {
        let inputs = table_inputs();
        // An input without any row fails on its first kind.
        let mut refs = table_refs();
        refs.retain(|reference| reference.input_ordinal != 4);
        let violation = check(&inputs, &refs).expect_err("empty input");
        assert_eq!(violation.reason, CompletenessReason::MissingKind);
        assert_eq!(violation.input_ordinal, Some(4));
        assert_eq!(violation.kind, Some(QualificationKind::Source));
        // Every one of the 7 kinds is reported individually.
        for kind in ALL_QUALIFICATION_KINDS {
            for ordinal in 0..inputs.len() {
                let mut refs = table_refs();
                refs.retain(|reference| {
                    !(reference.input_ordinal == ordinal && reference.kind == kind)
                });
                let violation = check(&inputs, &refs).expect_err("missing kind");
                assert_eq!(
                    violation.reason,
                    CompletenessReason::MissingKind,
                    "{ordinal} {kind:?}"
                );
                assert_eq!(violation.input_ordinal, Some(ordinal));
                assert_eq!(violation.kind, Some(kind));
            }
        }
        let mut refs = table_refs();
        refs.push(QualificationReference::present(
            9,
            QualificationKind::Source,
            "x",
            "y",
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::QualificationInputMissing
        );
    }

    #[test]
    fn completeness_rejects_duplicate_kind_target() {
        let inputs = table_inputs();
        for version in ["source-token", "another-version"] {
            let mut refs = table_refs();
            refs.push(QualificationReference::present(
                4,
                QualificationKind::Source,
                "evidence:e1",
                version,
            ));
            assert_eq!(
                reason_of(&inputs, &refs),
                CompletenessReason::DuplicateTarget
            );
        }
        let mut refs = table_refs();
        refs.push(scope(
            4,
            ScopeRole::MaterialSceneProof,
            &["anchor", "incarnation-a"],
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::DuplicateTarget
        );
        let mut refs = table_refs();
        refs.push(scope(4, ScopeRole::TypedScope, &["revision-1", "0"]));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::DuplicateTarget
        );
        let mut refs = table_refs();
        refs.push(QualificationReference::present(
            4,
            QualificationKind::Revision,
            "revision-1",
            "another-bundle",
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::DuplicateTarget
        );
    }

    #[test]
    fn completeness_rejects_collapsing_to_one_ref_per_kind() {
        let inputs = vec![revision("revision-1")];
        let full = revision_refs(
            0,
            "revision-1",
            &["project:scene:scene-q", "evidence:e1", "evidence:e2"],
            &[("anchor-a", "inc-a"), ("anchor-b", "inc-b")],
            2,
        );
        assert_eq!(check(&inputs, &full), Ok(()));
        let expected: BTreeSet<TypedTarget> = full
            .iter()
            .filter_map(|reference| typed_target(reference).expect("target"))
            .collect();
        let expected_map = BTreeMap::from([(0usize, expected)]);
        let with_expected = CompletenessContext {
            target_scene_id: Q,
            expected_targets: Some(&expected_map),
        };
        assert_eq!(
            check_attempt_completeness(&inputs, &full, &with_expected),
            Ok(())
        );

        // Source collapsed to one reference: only the expected set sees it.
        let mut collapsed = full.clone();
        collapsed.retain(|reference| reference.identity() != Some("evidence:e2"));
        assert_eq!(check(&inputs, &collapsed), Ok(()));
        let violation = check_attempt_completeness(&inputs, &collapsed, &with_expected)
            .expect_err("collapsed Source");
        assert_eq!(violation.reason, CompletenessReason::ExpectedTargetMissing);
        assert_eq!(violation.kind, Some(QualificationKind::Source));

        // Scope collapsed to one reference: the closed roles are missing.
        let mut collapsed = full.clone();
        let kept = collapsed
            .iter()
            .position(|reference| reference.scope_role() == Some(ScopeRole::QuerySceneScope))
            .expect("kept");
        let kept = collapsed[kept].clone();
        collapsed.retain(|reference| reference.kind != QualificationKind::Scope);
        collapsed.push(kept);
        assert_eq!(
            check(&inputs, &collapsed),
            Err(CompletenessViolation {
                input_ordinal: Some(0),
                kind: Some(QualificationKind::Scope),
                scope_role: Some(ScopeRole::ProjectAuthority),
                reason: CompletenessReason::ScopeRoleMissing,
            })
        );

        // A reference outside the expected set is incomplete as well.
        let mut extra = full.clone();
        extra.push(QualificationReference::present(
            0,
            QualificationKind::Source,
            "evidence:unexpected",
            "t",
        ));
        let violation = check_attempt_completeness(&inputs, &extra, &with_expected)
            .expect_err("unexpected Source");
        assert_eq!(violation.reason, CompletenessReason::UnexpectedTarget);
    }

    #[test]
    fn typed_target_not_fooled_by_colon_in_ids() {
        // A joined string cannot tell these apart; the typed tuple can.
        let first = scope_identity(ScopeRole::MaterialSceneProof, &["a:b", "c"]).expect("first");
        let second = scope_identity(ScopeRole::MaterialSceneProof, &["a", "b:c"]).expect("second");
        assert_ne!(first, second);
        assert_eq!(
            parse_scope_identity(ScopeRole::MaterialSceneProof, &first),
            Some(vec!["a:b".to_owned(), "c".to_owned()])
        );
        assert_eq!(
            parse_scope_identity(ScopeRole::MaterialSceneProof, &second),
            Some(vec!["a".to_owned(), "b:c".to_owned()])
        );
        // A Scene named "x:y" is not the proof of anchor "x" in incarnation "y".
        let scene_named = scope_identity(ScopeRole::QuerySceneScope, &["x:y"]).expect("scene");
        let proof = scope_identity(ScopeRole::MaterialSceneProof, &["x", "y"]).expect("proof");
        assert_ne!(scene_named, proof);
        assert_eq!(
            parse_scope_identity(ScopeRole::MaterialSceneProof, &scene_named),
            None
        );
        assert_eq!(
            parse_scope_identity(ScopeRole::QuerySceneScope, &proof),
            None
        );
        // The naive unescaped join of the pair collides; the typed targets do not.
        let naive = |a: &str, b: &str| format!("scene:{a}:{b}");
        assert_eq!(naive("a:b", "c"), naive("a", "b:c"));
        let reference = |identity: &str| {
            QualificationReference::scope(0, ScopeRole::MaterialSceneProof, identity, "t")
        };
        assert_ne!(
            typed_target(&reference(&first)).expect("first"),
            typed_target(&reference(&second)).expect("second")
        );
        // Both proofs live in one Revision input without a duplicate.
        let inputs = vec![revision("revision-1")];
        let refs = revision_refs(
            0,
            "revision-1",
            &["project:scene:scene-q"],
            &[("a:b", "c"), ("a", "b:c")],
            0,
        );
        assert_eq!(check(&inputs, &refs), Ok(()));
        // A Scene or revision ID that contains `%` and `:` round-trips.
        let weird = "id%3A:%25";
        let identity = scope_identity(ScopeRole::TypedScope, &[weird, "7"]).expect("typed");
        assert_eq!(
            parse_scope_identity(ScopeRole::TypedScope, &identity),
            Some(vec![weird.to_owned(), "7".to_owned()])
        );
        // An unescaped colon in a component is malformed.
        assert_eq!(
            parse_scope_identity(ScopeRole::QuerySceneScope, "scene:a%zz"),
            None
        );
        assert_eq!(
            parse_scope_identity(ScopeRole::QuerySceneScope, "scene:"),
            None
        );
        assert_eq!(
            parse_scope_identity(ScopeRole::QuerySceneScope, "scene:a:b"),
            None
        );
        // Source keys keep their own colons: the whole identity is the target.
        let source =
            QualificationReference::present(0, QualificationKind::Source, "project:scene:a:b", "t");
        assert_eq!(
            typed_target(&source)
                .expect("source")
                .expect("present")
                .components,
            vec!["project:scene:a:b".to_owned()]
        );
        assert!(scope_identity(ScopeRole::QuerySceneScope, &["a", "b"]).is_err());
        // A malformed Scope identity is incomplete.
        let mut refs = table_refs();
        let position = refs
            .iter()
            .position(|reference| {
                reference.input_ordinal == 0
                    && reference.scope_role() == Some(ScopeRole::QuerySceneScope)
            })
            .expect("scope");
        refs[position] =
            QualificationReference::scope(0, ScopeRole::QuerySceneScope, "scene:a:b", "t");
        assert_eq!(
            reason_of(&table_inputs(), &refs),
            CompletenessReason::MalformedTarget
        );
    }

    #[test]
    fn typed_na_rejects_forged_cells() {
        use NotApplicableReason as N;
        use QualificationKind as K;
        let inputs = table_inputs();
        let replace = |ordinal: usize, kind: K, replacement: Vec<QualificationReference>| {
            let mut refs = table_refs();
            refs.retain(|reference| {
                !(reference.input_ordinal == ordinal && reference.kind == kind)
            });
            refs.extend(replacement);
            refs
        };
        // An N/A where the table requires a reference.
        let refs = replace(0, K::Source, vec![na(0, K::Source, N::HumanAuthored)]);
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::NotApplicableNotInTable
        );
        let refs = replace(0, K::Scope, vec![na(0, K::Scope, N::HumanAuthored)]);
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::NotApplicableNotInTable
        );
        // The right cell with a reason the table does not give it.
        let refs = replace(
            0,
            K::Decision,
            vec![na(0, K::Decision, N::DerivedFromParents)],
        );
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::NotApplicableNotInTable
        );
        let refs = replace(2, K::Decision, vec![na(2, K::Decision, N::HumanAuthored)]);
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::NotApplicableNotInTable
        );
        let refs = replace(0, K::D1, vec![na(0, K::D1, N::NotIndexDerived)]);
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::NotApplicableNotInTable
        );
        // A past Human has a D1 selection, not the fixed slot.
        let refs = replace(1, K::D1, vec![na(1, K::D1, N::FixedUserSlot)]);
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::NotApplicableNotInTable
        );
        // A reference together with a typed N/A.
        let mut refs = table_refs();
        refs.push(QualificationReference::present(
            0,
            K::Revision,
            "revision-x",
            "bundle",
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ReferenceAndNotApplicable
        );
        let mut refs = table_refs();
        refs.push(na(4, K::Index, N::NotIndexDerived));
        refs.push(QualificationReference::present(
            4,
            K::Index,
            "sealed-graph-index",
            "g1",
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ReferenceAndNotApplicable
        );
        // A reference where the table puts an N/A.
        let refs = replace(
            0,
            K::Revision,
            vec![QualificationReference::present(
                0,
                K::Revision,
                "revision-x",
                "bundle",
            )],
        );
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ReferenceNotInTable
        );
        // Two N/A rows of one kind.
        let mut refs = table_refs();
        refs.push(na(0, K::Revision, N::NotARevision));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::DuplicateNotApplicable
        );
        // Graph-derived input has no N/A for the Index (Pending).
        let graph = InputReference {
            role: InputRole::Context,
            target: InputTarget::GraphEvidence {
                evidence_ref: "evidence-1".into(),
                source_key: "project:scene:other".into(),
                revision_token: "t".into(),
            },
            input_use: InputUse::SelectedMaterial,
        };
        let mut graph_refs = revision_refs(0, "revision-1", &["project:scene:other"], &[], 0);
        graph_refs.retain(|reference| reference.kind != K::Index);
        graph_refs.push(na(0, K::Index, N::NotIndexDerived));
        assert_eq!(
            reason_of(std::slice::from_ref(&graph), &graph_refs),
            CompletenessReason::NotApplicableNotInTable
        );
        graph_refs.pop();
        assert_eq!(
            reason_of(std::slice::from_ref(&graph), &graph_refs),
            CompletenessReason::MissingKind
        );
        graph_refs.push(QualificationReference::present(
            0,
            K::Index,
            "sealed-graph-index",
            "g1",
        ));
        assert_eq!(check(&[graph], &graph_refs), Ok(()));
        // Artifact is unsupported, with or without rows.
        let artifact = InputReference {
            role: InputRole::Context,
            target: InputTarget::Artifact {
                artifact_id: "artifact-1".into(),
                payload_digest: test_digest("artifact"),
            },
            input_use: InputUse::SelectedMaterial,
        };
        assert_eq!(
            reason_of(std::slice::from_ref(&artifact), &[]),
            CompletenessReason::UnsupportedInput
        );
        assert_eq!(
            reason_of(&[artifact], &revision_refs(0, "revision-1", &["s"], &[], 0)),
            CompletenessReason::UnsupportedInput
        );
        // An unknown reason or role is not a value of the closed types.
        let unknown_reason = json!({"referenceVersion":2,"state":"not-applicable",
            "inputOrdinal":0,"kind":"revision","reason":"made-up"});
        assert!(serde_json::from_value::<QualificationReference>(unknown_reason).is_err());
        let unknown_role = json!({"referenceVersion":2,"state":"present","inputOrdinal":0,
            "kind":"scope","identity":"scene:x","version":"v","scopeRole":"made-up"});
        assert!(serde_json::from_value::<QualificationReference>(unknown_role).is_err());
        // A Scope role on a non-Scope reference, or none on a Scope reference.
        let mut refs = table_refs();
        refs.push(QualificationReference {
            input_ordinal: 0,
            kind: K::Source,
            body: QualificationBody::Present {
                identity: "x".into(),
                version: "v".into(),
                scope_role: Some(ScopeRole::ScopeAxis),
            },
        });
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ScopeRoleInvalid
        );
        let mut refs = table_refs();
        refs.push(QualificationReference::present(0, K::Scope, "scene:x", "v"));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ScopeRoleInvalid
        );
        // Input-use that does not fit the input.
        let misuse = vec![message(
            InputRole::User,
            InputUse::SelectedMaterial,
            "human-v",
        )];
        assert_eq!(
            reason_of(&misuse, &[]),
            CompletenessReason::InputUseMismatch
        );
    }

    #[test]
    fn raw_freshness_na_reason_follows_source_key() {
        use NotApplicableReason as N;
        // The target Scene's body is not a dependency of the output.
        let target = vec![raw("project:scene:scene-q")];
        assert_eq!(
            check(
                &target,
                &raw_refs(0, "project:scene:scene-q", N::TargetSceneBodyNotADependency)
            ),
            Ok(())
        );
        assert_eq!(
            reason_of(
                &target,
                &raw_refs(0, "project:scene:scene-q", N::ExactSourceToken)
            ),
            CompletenessReason::NotApplicableReasonMismatch
        );
        // Any other Raw is covered by its exact source token.
        let other = vec![raw("project:scene:another-scene")];
        assert_eq!(
            check(
                &other,
                &raw_refs(0, "project:scene:another-scene", N::ExactSourceToken)
            ),
            Ok(())
        );
        assert_eq!(
            reason_of(
                &other,
                &raw_refs(
                    0,
                    "project:scene:another-scene",
                    N::TargetSceneBodyNotADependency
                )
            ),
            CompletenessReason::NotApplicableReasonMismatch
        );
        // Another reason is outside the cell altogether.
        assert_eq!(
            reason_of(
                &other,
                &raw_refs(0, "project:scene:another-scene", N::ImmutableMessageVersion)
            ),
            CompletenessReason::NotApplicableNotInTable
        );
        // The writer accepts both reasons for a Raw; the rule picks one.
        assert!(validate_reference_shapes(
            &target,
            &raw_refs(0, "project:scene:scene-q", N::ExactSourceToken)
        )
        .is_ok());
    }

    #[test]
    fn scope_role_requirements_follow_the_input_type() {
        // A Human carries exactly its Scene's scope and incarnation.
        let inputs = vec![message(InputRole::User, InputUse::CurrentTurn, "human-v")];
        let mut refs = current_human_refs(0);
        refs.push(scope(0, ScopeRole::RevealState, &[Q]));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ScopeRoleNotAllowed
        );
        let mut refs = current_human_refs(0);
        refs.retain(|reference| reference.scope_role() != Some(ScopeRole::QuerySceneIncarnation));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ScopeRoleMissing
        );
        // A query-Scene role must name the attempt's target Scene.
        let mut refs = current_human_refs(0);
        refs.retain(|reference| reference.scope_role() != Some(ScopeRole::QuerySceneScope));
        refs.push(scope(0, ScopeRole::QuerySceneScope, &["other-scene"]));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::ScopeSceneMismatch
        );
        // A singleton role cannot repeat for a Revision.
        let inputs = vec![revision("revision-1")];
        let mut refs = revision_refs(0, "revision-1", &["s"], &[], 0);
        refs.push(scope(0, ScopeRole::RevealState, &[Q]));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::DuplicateTarget
        );
        let mut refs = revision_refs(0, "revision-1", &["s"], &[], 0);
        refs.push(QualificationReference::scope(
            0,
            ScopeRole::ScopeAxis,
            scope_identity(ScopeRole::ScopeAxis, &[Q]).expect("axis"),
            "other-axis-token",
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::DuplicateTarget
        );
        // A D1 reference must carry the selection identity.
        let mut refs = revision_refs(0, "revision-1", &["s"], &[], 0);
        refs.retain(|reference| reference.kind != QualificationKind::D1);
        refs.push(QualificationReference::present(
            0,
            QualificationKind::D1,
            "selection",
            "v",
        ));
        assert_eq!(
            reason_of(&inputs, &refs),
            CompletenessReason::MalformedTarget
        );
    }

    #[test]
    fn scope_role_classification_is_by_kind_and_role_not_identity_string() {
        use QualificationKind as K;
        use ReferenceClass as C;
        use ScopeRole as R;
        let table = [
            (K::Source, None, C::Dependency),
            (K::Revision, None, C::Dependency),
            (K::Decision, None, C::Dependency),
            (K::Index, None, C::Dependency),
            (K::Freshness, None, C::RequestContext),
            (K::D1, None, C::D1Selection),
            (K::Scope, Some(R::TypedScope), C::Dependency),
            (K::Scope, Some(R::ProjectAuthority), C::RequestContext),
            (K::Scope, Some(R::RevealState), C::RequestContext),
            (K::Scope, Some(R::QuerySceneSource), C::RequestContext),
            (K::Scope, Some(R::MaterialSceneProof), C::RequestContext),
            (K::Scope, Some(R::QuerySceneScope), C::TurnContext),
            (K::Scope, Some(R::QuerySceneIncarnation), C::TurnContext),
            (K::Scope, Some(R::ScopeAxis), C::TurnContext),
        ];
        for (kind, role, class) in table {
            assert_eq!(
                classify_reference(kind, role),
                Some(class),
                "{kind:?} {role:?}"
            );
            // The class never depends on the identity text.
            for identity in [
                "scene:x",
                "project:scope-authority:p",
                "revision:r:typed-scope:0",
                "",
            ] {
                let reference = QualificationReference {
                    input_ordinal: 0,
                    kind,
                    body: QualificationBody::Present {
                        identity: identity.into(),
                        version: "v".into(),
                        scope_role: role,
                    },
                };
                assert_eq!(
                    classify_reference(reference.kind, reference.scope_role()),
                    Some(class)
                );
            }
        }
        // Eight roles, all classified; a Scope reference without a role is not.
        assert_eq!(
            table.iter().filter(|(kind, ..)| *kind == K::Scope).count(),
            8
        );
        assert_eq!(classify_reference(K::Scope, None), None);
    }

    #[test]
    fn reference_json_v2_roundtrip_and_v1_still_readable() -> Result<()> {
        let input = message(InputRole::User, InputUse::CurrentTurn, "human-v");
        let value = serde_json::to_value(&input)?;
        assert_eq!(value["referenceVersion"], json!(2));
        assert_eq!(value["inputUse"], json!("current-turn"));
        let json = canonical_json_string(&value)?;
        assert_eq!(serde_json::from_str::<InputReference>(&json)?, input);
        let present = scope(0, ScopeRole::ProjectAuthority, &["project:1"]);
        let not_applicable = na(
            0,
            QualificationKind::Revision,
            NotApplicableReason::NotARevision,
        );
        let source = QualificationReference::present(0, QualificationKind::Source, "k", "t");
        for reference in [&present, &not_applicable, &source] {
            let value = serde_json::to_value(reference)?;
            assert_eq!(value["referenceVersion"], json!(2));
            let json = canonical_json_string(&value)?;
            assert_eq!(
                &serde_json::from_str::<QualificationReference>(&json)?,
                reference
            );
        }
        assert_eq!(serde_json::to_value(&present)?["state"], json!("present"));
        assert_eq!(
            serde_json::to_value(&present)?["scopeRole"],
            json!("project-authority")
        );
        assert_eq!(
            serde_json::to_value(&not_applicable)?["state"],
            json!("not-applicable")
        );
        assert_eq!(
            serde_json::to_value(&not_applicable)?["reason"],
            json!("not-a-revision")
        );
        assert!(serde_json::to_value(&source)?.get("scopeRole").is_none());
        // Unknown fields and unknown versions are rejected.
        let mut extra = serde_json::to_value(&input)?;
        extra["extra"] = json!(1);
        assert!(serde_json::from_value::<InputReference>(extra).is_err());
        let mut extra = serde_json::to_value(&not_applicable)?;
        extra["identity"] = json!("x");
        assert!(serde_json::from_value::<QualificationReference>(extra).is_err());
        let mut unknown = serde_json::to_value(&input)?;
        unknown["referenceVersion"] = json!(3);
        assert!(serde_json::from_value::<InputReference>(unknown.clone()).is_err());
        assert_error_code(
            parse_versioned_reference::<InputReference, LegacyInputReferenceV1>(
                &unknown.to_string(),
            )
            .map(|_| ()),
            REFERENCE_VERSION_UNSUPPORTED_ERROR,
        );
        let null_version = r#"{"referenceVersion":null,"role":"user","target":{"kind":"message","versionId":"v","parentAttemptId":null}}"#;
        assert!(
            parse_versioned_reference::<InputReference, LegacyInputReferenceV1>(null_version)
                .is_err()
        );
        // Stored rows: v2 is written; v1 stays readable but is not exposed.
        let db = database(Path::new(":memory:"));
        let human = human(&db, "reference-human", "input");
        let current = create_attempt(
            &db,
            request(
                vec![message_input(&human)],
                vec![QualificationReference::present(
                    0,
                    QualificationKind::Source,
                    "reference-human",
                    "digest",
                )],
            ),
        )?;
        assert_eq!(current.reference_format, ReferenceFormat::V2);
        let read = read_attempt(&db, &current.id, budget())?;
        assert_eq!(read.reference_format, ReferenceFormat::V2);
        assert_eq!(read.inputs, current.inputs);
        let raw_rows = |db: &Database, table: &str| -> Vec<String> {
            db.with_conn(|conn| {
                let mut statement = conn.prepare(&format!(
                    "SELECT reference_json FROM {table} WHERE attempt_id=?1 ORDER BY ordinal"
                ))?;
                let rows = statement
                    .query_map([&current.id], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("rows")
        };
        let input_rows = raw_rows(&db, "nir1_generation_input_refs");
        assert!(input_rows[0].contains("\"referenceVersion\":2"));
        let set_rows = |db: &Database, table: &str, json: &str, digest: Option<&str>| {
            db.with_conn(|conn| {
                conn.execute(
                    &format!(
                        "UPDATE {table} SET reference_json=?2 WHERE attempt_id=?1 AND ordinal=0"
                    ),
                    params![current.id, json],
                )?;
                if let Some(digest) = digest {
                    conn.execute(
                        "UPDATE nir1_generation_attempts SET input_digest=?2 WHERE id=?1",
                        params![current.id, digest],
                    )?;
                }
                Ok(())
            })
            .expect("set rows");
        };
        let legacy_input = LegacyInputReferenceV1 {
            role: current.inputs[0].role.clone(),
            target: current.inputs[0].target.clone(),
        };
        let legacy_qualification = LegacyQualificationReferenceV1 {
            input_ordinal: 0,
            kind: QualificationKind::Source,
            identity: "reference-human".into(),
            version: "digest".into(),
        };
        let legacy_digest = canonical_json_digest(&json!({
            "domain":"nir1-generation-inputs@1",
            "inputs":[legacy_input],"qualifications":[legacy_qualification]}))?;
        assert_ne!(legacy_digest, current.input_digest);
        // Mixed formats are refused.
        set_rows(
            &db,
            "nir1_generation_input_refs",
            &canonical_json_string(&serde_json::to_value(&legacy_input)?)?,
            None,
        );
        assert_error_code(
            read_attempt(&db, &current.id, budget()),
            REFERENCE_FORMAT_MIXED_ERROR,
        );
        // All rows v1, digest in the v1 domain: readable, flagged, not exposed.
        set_rows(
            &db,
            "nir1_generation_qualification_refs",
            &canonical_json_string(&serde_json::to_value(&legacy_qualification)?)?,
            Some(&legacy_digest),
        );
        let legacy = read_attempt(&db, &current.id, budget())?;
        assert_eq!(legacy.reference_format, ReferenceFormat::LegacyV1);
        assert!(legacy.inputs.is_empty() && legacy.qualifications.is_empty());
        assert_eq!(legacy.input_digest, legacy_digest);
        // The v1 rows do not verify against the v2 domain digest.
        set_rows(
            &db,
            "nir1_generation_input_refs",
            &canonical_json_string(&serde_json::to_value(&legacy_input)?)?,
            Some(&current.input_digest),
        );
        assert_error_code(
            read_attempt(&db, &current.id, budget()),
            "NIR1_GENERATION_INPUT_DIGEST_MISMATCH",
        );
        // A row with an unknown version is refused outright.
        set_rows(
            &db,
            "nir1_generation_input_refs",
            &unknown.to_string(),
            Some(&legacy_digest),
        );
        assert_error_code(
            read_attempt(&db, &current.id, budget()),
            REFERENCE_VERSION_UNSUPPORTED_ERROR,
        );
        Ok(())
    }

    #[test]
    fn writer_rejects_open_shapes_but_stores_incomplete_attempts() -> Result<()> {
        use NotApplicableReason as N;
        use QualificationKind as K;
        let db = database(Path::new(":memory:"));
        let human = human(&db, "shape-human", "input");
        let current = message_input(&human);
        let create = |inputs: Vec<InputReference>, refs: Vec<QualificationReference>| {
            create_attempt(&db, request(inputs, refs))
        };
        // An N/A the table does not give this cell, an unknown pairing of
        // input-use, and a role on the wrong kind are refused.
        for (refs, code) in [
            (
                vec![na(0, K::Source, N::HumanAuthored)],
                "NIR1_GENERATION_NOT_APPLICABLE_NOT_IN_TABLE",
            ),
            (
                vec![na(0, K::Revision, N::HumanAuthored)],
                "NIR1_GENERATION_NOT_APPLICABLE_NOT_IN_TABLE",
            ),
            (
                vec![na(0, K::D1, N::NotIndexDerived)],
                "NIR1_GENERATION_NOT_APPLICABLE_NOT_IN_TABLE",
            ),
            (
                vec![QualificationReference::present(0, K::Scope, "scene:x", "v")],
                "NIR1_GENERATION_SCOPE_ROLE_MISMATCH",
            ),
            (
                vec![QualificationReference {
                    input_ordinal: 0,
                    kind: K::Source,
                    body: QualificationBody::Present {
                        identity: "x".into(),
                        version: "v".into(),
                        scope_role: Some(ScopeRole::ScopeAxis),
                    },
                }],
                "NIR1_GENERATION_SCOPE_ROLE_MISMATCH",
            ),
            (
                vec![na(1, K::Revision, N::NotARevision)],
                "NIR1_GENERATION_QUALIFICATION_INPUT_MISSING",
            ),
        ] {
            assert_error_code(create(vec![current.clone()], refs), code);
        }
        let mut misused = current.clone();
        misused.input_use = InputUse::SelectedMaterial;
        assert_error_code(
            create(vec![misused], vec![]),
            "NIR1_GENERATION_INPUT_USE_MISMATCH",
        );
        let mut wrong_role = current.clone();
        wrong_role.role = InputRole::Context;
        assert_error_code(
            create(vec![wrong_role], vec![]),
            "NIR1_GENERATION_INPUT_USE_MISMATCH",
        );
        let rows: i64 = db.with_conn(|conn| {
            Ok(
                conn.query_row("SELECT count(*) FROM nir1_generation_attempts", [], |row| {
                    row.get(0)
                })?,
            )
        })?;
        assert_eq!(rows, 0, "a refused shape stores nothing");
        // Attempts that break the completeness rule are stored (and then not
        // used as history): missing kinds, a reference with an N/A,
        // a duplicate target.
        let incomplete = vec![
            vec![],
            vec![QualificationReference::present(
                0,
                K::Source,
                "shape-human",
                "d",
            )],
            vec![
                QualificationReference::present(0, K::Source, "shape-human", "d"),
                QualificationReference::present(0, K::Source, "shape-human", "another"),
                na(0, K::Revision, N::NotARevision),
                QualificationReference::present(0, K::Revision, "r", "b"),
            ],
        ];
        for refs in incomplete {
            let stored = create(vec![current.clone()], refs.clone())?;
            let read = read_attempt(&db, &stored.id, budget())?;
            assert_eq!(read.qualifications, refs);
            assert!(check_attempt_completeness(
                &read.inputs,
                &read.qualifications,
                &CompletenessContext {
                    target_scene_id: GENERATION_SCENE_ID,
                    expected_targets: None
                }
            )
            .is_err());
        }
        Ok(())
    }

    #[test]
    fn d1_selection_digest_is_recomputable_from_stored_rows() -> Result<()> {
        let db = database(Path::new(":memory:"));
        let human = human(&db, "d1-human", "input");
        let inputs = vec![message_input(&human), raw("project:scene:generation-scene")];
        let parameters = D1SelectionParameters {
            estimator_version: "nir1-context-estimator-v1".into(),
            selector_budget_tokens: 1_000,
            used_tokens: 640,
            remaining_tokens: 360,
        };
        let selection = d1_selection_digest(&parameters, &inputs)?;
        let stored = create_attempt(
            &db,
            request(inputs.clone(), vec![d1_selection_reference(1, &selection)]),
        )?;
        let read = read_attempt(&db, &stored.id, budget())?;
        let recorded = read
            .qualifications
            .iter()
            .find(|reference| reference.kind == QualificationKind::D1)
            .and_then(|reference| reference.version())
            .expect("D1 reference")
            .to_owned();
        assert_eq!(d1_selection_digest(&parameters, &read.inputs)?, recorded);
        // Every component is bound.
        let changed = |parameters: D1SelectionParameters| {
            d1_selection_digest(&parameters, &read.inputs).expect("digest")
        };
        for other in [
            D1SelectionParameters {
                estimator_version: "other".into(),
                ..parameters.clone()
            },
            D1SelectionParameters {
                selector_budget_tokens: 1_001,
                remaining_tokens: 361,
                ..parameters.clone()
            },
            D1SelectionParameters {
                used_tokens: 641,
                remaining_tokens: 359,
                ..parameters.clone()
            },
        ] {
            assert_ne!(changed(other), recorded);
        }
        let mut other_target = read.inputs.clone();
        other_target[1].target = InputTarget::RawSource {
            source_key: "project:scene:generation-scene".into(),
            revision_token: "changed-token".into(),
        };
        assert_ne!(d1_selection_digest(&parameters, &other_target)?, recorded);
        let mut reordered = read.inputs.clone();
        reordered.push(raw("project:scene:later"));
        assert_ne!(d1_selection_digest(&parameters, &reordered)?, recorded);
        let mut other_use = read.inputs.clone();
        other_use[1].input_use = InputUse::AdoptedHistory;
        assert_ne!(d1_selection_digest(&parameters, &other_use)?, recorded);
        // The current Human has a fixed slot and is not part of the selection.
        let mut other_human = read.inputs.clone();
        other_human[0].target = InputTarget::Message {
            version_id: "another-human-version".into(),
            parent_attempt_id: None,
        };
        assert_eq!(d1_selection_digest(&parameters, &other_human)?, recorded);
        // Usage and remainder must add up to the budget.
        assert_error_code(
            d1_selection_digest(
                &D1SelectionParameters {
                    remaining_tokens: 1,
                    ..parameters.clone()
                },
                &read.inputs,
            ),
            "NIR1_GENERATION_D1_SELECTION_INVALID",
        );
        assert_error_code(
            d1_selection_digest(
                &D1SelectionParameters {
                    estimator_version: String::new(),
                    ..parameters
                },
                &read.inputs,
            ),
            "NIR1_GENERATION_D1_SELECTION_INVALID",
        );
        Ok(())
    }

    #[test]
    fn input_digest_domain_is_v2_and_matches_node_final_digest() -> Result<()> {
        assert_eq!(INPUT_DIGEST_DOMAIN, "nir1-generation-inputs@2");
        let inputs = table_inputs();
        let refs = table_refs();
        // The node `final_input_digest` builds this exact JSON with this domain.
        let expected = canonical_json_digest(&json!({
            "domain": "nir1-generation-inputs@2",
            "inputs": inputs,
            "qualifications": refs,
        }))?;
        assert_eq!(input_digest(&inputs, &refs)?, expected);
        let old_domain = canonical_json_digest(&json!({
            "domain": "nir1-generation-inputs@1",
            "inputs": inputs,
            "qualifications": refs,
        }))?;
        assert_ne!(old_domain, expected);
        // A stored attempt carries the v2 digest.
        let db = database(Path::new(":memory:"));
        let human = human(&db, "digest-human", "input");
        let stored = create_attempt(
            &db,
            request(
                vec![message_input(&human)],
                vec![QualificationReference::present(
                    0,
                    QualificationKind::Source,
                    "digest-human",
                    "d",
                )],
            ),
        )?;
        assert_eq!(
            stored.input_digest,
            input_digest(&stored.inputs, &stored.qualifications)?
        );
        Ok(())
    }
}


// ---------------------------------------------------------------------------
// DT-4 T2: bounded read of `projects.ai_policy` (K5/3 B-2). The reader reports
// what the cell holds and decides nothing.
// ---------------------------------------------------------------------------

mod project_ai_policy_read {
    use super::bounded::{admission, open_probe, BoundedWorkspace};
    use super::*;

    const PROJECT: &str = "generation-project";

    fn production_admission() -> Nir1AdmissionSqlBudget {
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), open_probe())
    }

    fn set_policy(db: &Database, value: rusqlite::types::Value) {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE projects SET ai_policy=?2 WHERE id=?1",
                params![PROJECT, value],
            )?;
            Ok(())
        })
        .expect("set the policy cell");
    }

    fn set_text(db: &Database, text: &str) {
        set_policy(db, rusqlite::types::Value::Text(text.to_owned()));
    }

    fn read(
        workspace: &ActiveWorkspaceSnapshot,
        budget: &Nir1AdmissionSqlBudget,
    ) -> std::result::Result<Nir1ProjectAiPolicyRead, Nir1GenerationStoreError> {
        read_project_ai_policy_bounded(workspace, PROJECT, budget)
    }

    fn assert_refused(error: &Nir1GenerationStoreError, failure: Nir1StoreFailure) {
        assert_eq!(error.failure(), failure, "{error}: {:#}", error.source);
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted, "{error}");
    }

    /// The migration default of a new project is a readable text, returned as
    /// stored (the preset is `custom`, with chat, bodyWrite and analysis true).
    #[test]
    fn it_returns_the_stored_text_exactly() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let Nir1ProjectAiPolicyRead::Text(default) =
            read(&snapshot, &admission()).expect("default policy")
        else {
            panic!("the column default is text");
        };
        assert!(default.contains("\"preset\":\"custom\""), "{default}");
        let exact = " {\"preset\":\"off\",\"toggles\":{\"chat\":false}} \n\u{3042}";
        set_text(workspace.db().db(), exact);
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::Text(exact.to_owned())
        );
    }

    /// There is no cache: each read sees the value committed just before it,
    /// whatever it was a moment ago, and an empty text is a text.
    #[test]
    fn every_read_goes_to_the_database_and_sees_the_latest_commit() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        for value in [
            "a",
            "",
            "{\"preset\":\"full\"}",
            "b",
            "{\"preset\":\"off\"}",
        ] {
            set_text(db.db(), value);
            assert_eq!(
                read(&snapshot, &admission()).expect("read"),
                Nir1ProjectAiPolicyRead::Text(value.to_owned())
            );
        }
        // A change through another connection is seen as well.
        let other = Database::new(&workspace.db_path()).expect("second connection");
        set_text(&other, "from-another-connection");
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::Text("from-another-connection".into())
        );
    }

    #[test]
    fn a_missing_project_row_is_reported_as_missing() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        assert_eq!(
            read_project_ai_policy_bounded(&snapshot, "no-such-project", &admission())
                .expect("read"),
            Nir1ProjectAiPolicyRead::ProjectMissing
        );
        // The project's row being deleted after an earlier successful read is
        // seen by the next read.
        assert!(matches!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::Text(_)
        ));
        workspace
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM projects;")?;
                Ok(())
            })
            .expect("delete projects");
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::ProjectMissing
        );
    }

    #[test]
    fn a_cell_that_is_not_valid_text_is_not_returned_as_a_policy() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        // The column's TEXT affinity turns a number into its text, which the
        // policy decision then rejects as not an object; a blob keeps its
        // storage class and is never read as a policy.
        set_policy(db.db(), rusqlite::types::Value::Integer(1));
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::Text("1".into())
        );
        set_policy(
            db.db(),
            rusqlite::types::Value::Blob(b"{\"preset\":\"full\"}".to_vec()),
        );
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::NotText
        );
        // Text storage class holding bytes that are not UTF-8.
        db.db()
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE projects SET ai_policy=CAST(X'ff7b7d' AS TEXT) WHERE id=?1",
                    [PROJECT],
                )?;
                Ok(())
            })
            .expect("invalid utf-8 text");
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::NotText
        );
    }

    /// The length is tested before the value is loaded, at the shared limit.
    #[test]
    fn an_oversize_text_is_reported_without_being_loaded() {
        use grimodex_core::nir1_local_send_policy::NIR1_LOCAL_SEND_POLICY_MAX_BYTES as LIMIT;
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let at_limit = "x".repeat(LIMIT);
        set_text(db.db(), &at_limit);
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::Text(at_limit)
        );
        set_text(db.db(), &"x".repeat(LIMIT + 1));
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::TooLarge
        );
        // The limit is in bytes, not characters.
        set_text(db.db(), &"\u{3042}".repeat(LIMIT / 3 + 1));
        assert_eq!(
            read(&snapshot, &admission()).expect("read"),
            Nir1ProjectAiPolicyRead::TooLarge
        );
    }

    /// A held connection mutex ends the read at the mutex limit, typed, with
    /// nothing read, and a retry after the release works.
    #[test]
    fn a_held_connection_mutex_refuses_at_the_mutex_limit() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        {
            let _held = db.lock().expect("hold the connection mutex");
            let started = Instant::now();
            let error = read(&snapshot, &production_admission()).expect_err("held mutex");
            let elapsed = started.elapsed();
            assert_refused(&error, Nir1StoreFailure::ConnectionBusy);
            assert!(
                elapsed >= NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT,
                "{elapsed:?}"
            );
            assert!(elapsed < NIR1_GENERATION_OPERATION_LIMIT, "{elapsed:?}");
        }
        assert!(db.connection_reusable());
        assert!(matches!(
            read(&snapshot, &admission()).expect("retry"),
            Nir1ProjectAiPolicyRead::Text(_)
        ));
    }

    /// The read is a snapshot read: another connection's open write
    /// transaction does not delay it, and it writes nothing.
    #[test]
    fn a_writer_on_another_connection_does_not_block_the_read_and_nothing_is_written() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let db = workspace.db();
        let other = Database::new(&workspace.db_path()).expect("second connection");
        other
            .with_conn(|conn| {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                Ok(())
            })
            .expect("other writer");
        let changes_before = db
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?)
            })
            .expect("changes");
        let started = Instant::now();
        assert!(matches!(
            read(&snapshot, &production_admission()).expect("read beside a writer"),
            Nir1ProjectAiPolicyRead::Text(_)
        ));
        assert!(started.elapsed() < NIR1_GENERATION_OPERATION_LIMIT);
        other
            .with_conn(|conn| {
                conn.execute_batch("ROLLBACK")?;
                Ok(())
            })
            .expect("release");
        let changes_after = db
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?)
            })
            .expect("changes");
        assert_eq!(changes_before, changes_after, "the read wrote nothing");
    }

    #[test]
    fn the_owners_cancel_and_a_false_probe_refuse_the_read() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let cancel = Arc::new(AtomicBool::new(true));
        let cancelled = Nir1AdmissionSqlBudget::new(Arc::clone(&cancel), open_probe());
        assert_refused(
            &read(&snapshot, &cancelled).expect_err("cancelled before the read"),
            Nir1StoreFailure::Cancelled,
        );
        let closed =
            Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| false));
        assert_refused(
            &read(&snapshot, &closed).expect_err("admission closed"),
            Nir1StoreFailure::Fenced,
        );
        assert!(workspace.db().connection_reusable());
        assert!(read(&snapshot, &admission()).is_ok());
    }

    #[test]
    fn an_invalid_project_id_is_refused_before_any_read() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        for id in ["", " generation-project", &"p".repeat(MAX_ID_BYTES + 1)] {
            assert_refused(
                &read_project_ai_policy_bounded(&snapshot, id, &admission())
                    .expect_err("invalid id"),
                Nir1StoreFailure::Invalid,
            );
        }
    }
}


/// HS-1 (K4/3 section 2): the history slots of the v2 binding and the storage
/// writer that fixes them. Nothing here builds a context from a database; the
/// builder is a later step.
mod hs1_slots {
    use super::bounded::{admission, BoundedWorkspace};
    use super::history_context::testing::{max_context, sample_context, sample_identity};
    use super::history_context::{eligible_until_ms, HistoryInt, HISTORY_ELIGIBILITY_WINDOW_MS};
    use super::*;

    const CONTROL: char = '\u{1}';

    fn context_slot() -> Option<HistoryContextSlot> {
        Some(HistoryContextSlot::Context(Box::new(sample_context())))
    }

    /// A request the way the product writes it: a context and an identity,
    /// with the inputs the caller gives.
    fn with_context(
        inputs: Vec<InputReference>,
        qualifications: Vec<QualificationReference>,
    ) -> NewAttempt {
        let mut attempt = request(inputs, qualifications);
        attempt.binding.history_turn_context = context_slot();
        attempt.binding.durable_workspace_identity = Some(sample_identity());
        attempt
    }

    /// One Raw input with only a Source reference: the completeness rule
    /// needs more, so the structure is incomplete (the writer still stores it).
    fn incomplete_inputs() -> (Vec<InputReference>, Vec<QualificationReference>) {
        (
            vec![InputReference {
                role: InputRole::Context,
                target: InputTarget::RawSource {
                    source_key: "scene:source-x".into(),
                    revision_token: "source-v1".into(),
                },
                input_use: InputUse::SelectedMaterial,
            }],
            vec![QualificationReference::present(
                0,
                QualificationKind::Source,
                "scene:source-x",
                "source-v1",
            )],
        )
    }

    fn stored_binding_json(db: &Database, id: &str) -> String {
        db.with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                [id],
                |row| row.get(0),
            )?)
        })
        .expect("stored binding_json")
    }

    fn json_len(binding: &AttemptBinding) -> usize {
        canonical_binding(&binding_value(binding)).len()
    }

    /// The seven identities that storage does not tie to a database row, in
    /// the order `pad_to` fills them.
    fn free_fields(binding: &mut AttemptBinding) -> [&mut String; 7] {
        [
            &mut binding.caller.profile_id,
            &mut binding.caller.caller_id,
            &mut binding.caller.caller_session_id,
            &mut binding.route_revision,
            &mut binding.provider,
            &mut binding.model,
            &mut binding.api,
        ]
    }

    /// Grow free identities (each at most `MAX_ID_BYTES`) with JSON-escaped
    /// control characters and plain bytes until the canonical JSON of the
    /// binding is exactly `target` bytes.
    fn pad_to(binding: &mut AttemptBinding, target: usize) {
        for index in 0..7 {
            let current = json_len(binding);
            assert!(current <= target, "padding overshot before field {index}");
            let remaining = target - current;
            if remaining == 0 {
                break;
            }
            let field_len = free_fields(binding)[index].len();
            let full_add = 6 * MAX_ID_BYTES - field_len;
            let (control, plain) = if remaining >= full_add {
                (MAX_ID_BYTES, 0)
            } else {
                // 6c + p = remaining + field_len and c + p <= MAX_ID_BYTES.
                let total = remaining + field_len;
                let control = total.saturating_sub(MAX_ID_BYTES).div_ceil(5);
                (control, total - 6 * control)
            };
            assert!(control + plain <= MAX_ID_BYTES);
            *free_fields(binding)[index] =
                format!("{}{}", CONTROL.to_string().repeat(control), "p".repeat(plain));
        }
        assert_eq!(json_len(binding), target, "padding reached the target");
    }

    /// Pad the free identities so that the binding WITHOUT its slots is
    /// exactly `size_without_slots` bytes, then keep the slots as they are.
    fn pad_without_slots(attempt: &mut NewAttempt, size_without_slots: usize) {
        let mut bare = attempt.binding.clone();
        bare.history_turn_context = None;
        bare.durable_workspace_identity = None;
        pad_to(&mut bare, size_without_slots);
        attempt.binding.caller = bare.caller;
        attempt.binding.route_revision = bare.route_revision;
        attempt.binding.provider = bare.provider;
        attempt.binding.model = bare.model;
        attempt.binding.api = bare.api;
    }

    #[test]
    fn v2_binding_with_both_slots_at_max_ids_fits_64_kib() {
        let mut binding = binding();
        // Twelve identities at 4,096 B of bytes JSON does not escape.
        let long = |tag: &str| format!("{tag}{}", "i".repeat(MAX_ID_BYTES - tag.len()));
        binding.project_id = long("p");
        binding.chat_session_id = long("c");
        binding.scene.scene_id = long("s");
        binding.scene.scene_incarnation_id = long("n");
        binding.scene.source_token = long("t");
        binding.caller.profile_id = long("f");
        binding.caller.caller_id = long("k");
        binding.caller.caller_session_id = long("m");
        binding.route_revision = long("r");
        binding.provider = long("v");
        binding.model = long("d");
        binding.api = long("a");
        let without_slots = json_len(&binding);
        binding.history_turn_context = Some(HistoryContextSlot::Context(Box::new(max_context())));
        binding.durable_workspace_identity = Some(sample_identity());
        let with_slots = json_len(&binding);
        assert!(
            with_slots <= MAX_BINDING_JSON_BYTES,
            "{with_slots} B exceeds the ceiling"
        );
        // The slots cost their pinned sizes plus the two keys; the margin to
        // the ceiling is what K4/3 models as 13,417 B.
        assert_eq!(with_slots, 51_974, "binding with both slots, 12 IDs at 4,096 B");
        assert_eq!(MAX_BINDING_JSON_BYTES - with_slots, 13_562);
        assert_eq!(with_slots - without_slots, 1_953);
    }

    #[test]
    fn slots_over_64_kib_downgrade_to_binding_limit_and_attempt_is_created() {
        let db = database(Path::new(":memory:"));
        let mut attempt = with_context(vec![], vec![]);
        // Without the slots the binding fits with 100 B to spare; the slots
        // do not.
        pad_without_slots(&mut attempt, MAX_BINDING_JSON_BYTES - 100);
        assert!(json_len(&attempt.binding) > MAX_BINDING_JSON_BYTES);

        let predicted = effective_attempt_binding(&attempt).expect("downgraded binding");
        let stored = create_attempt(&db, attempt.clone()).expect("the attempt is created");
        assert_eq!(stored.binding, predicted);
        assert_eq!(
            stored.binding.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::BindingLimit
            ))
        );
        assert!(stored.binding.durable_workspace_identity.is_none());
        assert!(stored_binding_json(&db, &stored.id).len() <= MAX_BINDING_JSON_BYTES);
        let reread = read_attempt(&db, &stored.id, budget()).expect("reread");
        assert_eq!(reread.binding, stored.binding);
        // The send continues: the attempt is claimed and reaches a terminal.
        let terminal = finish_success(&db, &stored, "limit-message", "answer");
        assert!(terminal.message_version.is_some());
    }

    #[test]
    fn binding_limit_boundary_is_exact() {
        let db = database(Path::new(":memory:"));
        let created = 1_000;
        let mut exact = with_context(vec![], vec![]);
        // The writer sets this value, so the measured length is the stored one.
        if let Some(HistoryContextSlot::Context(context)) =
            exact.binding.history_turn_context.as_mut()
        {
            context.eligible_until_ms = eligible_until_ms(created).expect("eligible");
        }
        pad_to(&mut exact.binding, MAX_BINDING_JSON_BYTES);
        let stored = create_attempt(&db, exact.clone()).expect("exactly 64 KiB is kept");
        assert_eq!(stored.binding, exact.binding);
        assert!(stored.binding.history_turn_context.as_ref().is_some_and(HistoryContextSlot::is_context));
        assert_eq!(stored_binding_json(&db, &stored.id).len(), MAX_BINDING_JSON_BYTES);

        let mut over = with_context(vec![], vec![]);
        if let Some(HistoryContextSlot::Context(context)) = over.binding.history_turn_context.as_mut() {
            context.eligible_until_ms = eligible_until_ms(created).expect("eligible");
        }
        pad_to(&mut over.binding, MAX_BINDING_JSON_BYTES + 1);
        over.payload_digest = test_digest("one byte over");
        let downgraded = create_attempt(&db, over).expect("one byte over is downgraded");
        assert_eq!(
            downgraded.binding.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::BindingLimit
            ))
        );
        assert!(downgraded.binding.durable_workspace_identity.is_none());
    }

    #[test]
    fn binding_over_64_kib_without_slots_is_still_rejected() {
        let db = database(Path::new(":memory:"));
        // Slots empty (null) or closed reasons: nothing to drop, so refused.
        for slot in [
            None,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::DFinalIncomplete,
            )),
        ] {
            let mut oversized = request(vec![], vec![]);
            // Over the ceiling even with null slots.
            pad_to(&mut oversized.binding, MAX_BINDING_JSON_BYTES + 1);
            oversized.binding.history_turn_context = slot;
            assert_error_code(
                create_attempt(&db, oversized),
                "NIR1_GENERATION_BINDING_LIMIT",
            );
        }
        // A context is dropped, but the binding is still too large without it.
        let mut hopeless = with_context(vec![], vec![]);
        pad_without_slots(&mut hopeless, MAX_BINDING_JSON_BYTES + 1);
        assert_error_code(
            create_attempt(&db, hopeless.clone()),
            "NIR1_GENERATION_BINDING_LIMIT",
        );
        assert_error_code(
            effective_attempt_binding(&hopeless),
            "NIR1_GENERATION_BINDING_LIMIT",
        );
        assert!(pending_attempt_ids(&db, "generation-project", None, 8)
            .expect("pending page")
            .is_empty());
    }

    #[test]
    fn binding_that_fits_only_without_any_slot_is_stored_with_null_slots() {
        let db = database(Path::new(":memory:"));
        let mut attempt = with_context(vec![], vec![]);
        // 10 B below the ceiling without slots: even the closed reason
        // (about 70 B) does not fit, but the send must not stop for it.
        pad_without_slots(&mut attempt, MAX_BINDING_JSON_BYTES - 10);
        let stored = create_attempt(&db, attempt).expect("the attempt is created");
        assert!(stored.binding.history_turn_context.is_none());
        assert!(stored.binding.durable_workspace_identity.is_none());
        assert_eq!(
            stored_binding_json(&db, &stored.id).len(),
            MAX_BINDING_JSON_BYTES - 10
        );
    }

    #[test]
    fn incomplete_structure_overrides_caller_context_with_d_final_incomplete() {
        let db = database(Path::new(":memory:"));
        let (inputs, qualifications) = incomplete_inputs();
        let incomplete = with_context(inputs, qualifications);
        assert!(check_attempt_completeness(
            &incomplete.inputs,
            &incomplete.qualifications,
            &CompletenessContext {
                target_scene_id: GENERATION_SCENE_ID,
                expected_targets: None,
            },
        )
        .is_err());
        let predicted = effective_attempt_binding(&incomplete).expect("effective");
        let stored = create_attempt(&db, incomplete).expect("DR-DFP-4: the attempt is stored");
        assert_eq!(
            stored.binding.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::DFinalIncomplete
            ))
        );
        assert_eq!(stored.binding, predicted);
        assert_eq!(
            read_attempt(&db, &stored.id, budget()).expect("reread").binding,
            stored.binding
        );
        // A complete structure keeps the context the caller gave.
        let complete = create_attempt(&db, with_context(vec![], vec![])).expect("complete");
        assert!(complete
            .binding
            .history_turn_context
            .as_ref()
            .is_some_and(HistoryContextSlot::is_context));
        assert_eq!(complete.binding.durable_workspace_identity, Some(sample_identity()));
    }

    #[test]
    fn context_without_a_durable_identity_is_workspace_identity_unavailable() {
        let db = database(Path::new(":memory:"));
        let mut attempt = with_context(vec![], vec![]);
        attempt.binding.durable_workspace_identity = None;
        let stored = create_attempt(&db, attempt).expect("stored");
        assert_eq!(
            stored.binding.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::WorkspaceIdentityUnavailable
            ))
        );
    }

    #[test]
    fn eligible_until_is_created_at_plus_30_days_from_the_stored_row() {
        let db = database(Path::new(":memory:"));
        let mut attempt = with_context(vec![], vec![]);
        attempt.created_at_ms = 1_234_567;
        attempt.expires_at_ms = 1_234_567 + 60_000;
        // Whatever the caller wrote is ignored.
        if let Some(HistoryContextSlot::Context(context)) =
            attempt.binding.history_turn_context.as_mut()
        {
            context.eligible_until_ms = HistoryInt::MAX;
        }
        let stored = create_attempt(&db, attempt).expect("stored");
        let reread = read_attempt(&db, &stored.id, budget()).expect("reread");
        let Some(HistoryContextSlot::Context(context)) = &reread.binding.history_turn_context else {
            panic!("the context is kept");
        };
        assert_eq!(
            context.eligible_until_ms.get(),
            u64::try_from(reread.created_at_ms + HISTORY_ELIGIBILITY_WINDOW_MS).expect("ms")
        );
        assert_eq!(reread.created_at_ms, 1_234_567);

        let mut overflow = with_context(vec![], vec![]);
        overflow.payload_digest = test_digest("overflow");
        overflow.created_at_ms = i64::MAX - 5;
        overflow.expires_at_ms = i64::MAX;
        let stored = create_attempt(&db, overflow).expect("overflow is a closed reason");
        assert_eq!(
            stored.binding.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::EligibilityOverflow
            ))
        );
        // Larger than the canonical-JSON safe range is also an overflow.
        let mut beyond = with_context(vec![], vec![]);
        beyond.payload_digest = test_digest("beyond the safe range");
        beyond.created_at_ms = 9_007_199_254_740_991;
        beyond.expires_at_ms = beyond.created_at_ms + 1;
        let stored = create_attempt(&db, beyond).expect("beyond the safe range");
        assert_eq!(
            stored.binding.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::EligibilityOverflow
            ))
        );
    }

    #[test]
    fn production_create_never_writes_a_null_slot() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let pinned = workspace.db();
        let db = pinned.db();
        let now = wall_clock_ms().expect("clock");
        let null_slot = NewAttempt {
            created_at_ms: now,
            expires_at_ms: now + 60_000,
            ..request(vec![], vec![])
        };
        assert!(null_slot.binding.history_turn_context.is_none());
        let error = create_attempt_with_id_bounded(
            &snapshot,
            &test_digest("null-slot"),
            null_slot.clone(),
            &admission(),
            &mut || Ok(()),
        )
        .expect_err("the product create refuses a null slot");
        assert_eq!(error.commit(), Nir1CommitState::NotCommitted);
        assert!(
            format!("{:#}", error.source).contains("NIR1_GENERATION_HISTORY_SLOT_REQUIRED"),
            "{:#}",
            error.source
        );
        assert_error_code(
            effective_attempt_binding(&null_slot),
            "NIR1_GENERATION_HISTORY_SLOT_REQUIRED",
        );
        assert!(pending_attempt_ids(db, "generation-project", None, 8)
            .expect("pending page")
            .is_empty());
        // Only the test-support writer may store null.
        let stored = create_attempt(db, null_slot.clone()).expect("test-support writes null");
        assert!(stored.binding.history_turn_context.is_none());
        // An unknown contract is read-only: neither writer stores it.
        let mut unknown = null_slot;
        unknown.binding.history_turn_context = Some(HistoryContextSlot::UnknownContract);
        assert_error_code(
            create_attempt(db, unknown.clone()),
            "NIR1_GENERATION_HISTORY_SLOT_UNWRITABLE",
        );
        let error = create_attempt_with_id_bounded(
            &snapshot,
            &test_digest("unknown-slot"),
            NewAttempt {
                created_at_ms: now,
                expires_at_ms: now + 60_000,
                ..unknown
            },
            &admission(),
            &mut || Ok(()),
        )
        .expect_err("an unknown contract is not writable");
        assert!(
            format!("{:#}", error.source).contains("NIR1_GENERATION_HISTORY_SLOT_UNWRITABLE"),
            "{:#}",
            error.source
        );
    }

    #[test]
    fn production_create_keeps_a_context_and_the_stored_form_matches_the_prediction() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let pinned = workspace.db();
        let db = pinned.db();
        let now = wall_clock_ms().expect("clock");
        let attempt = NewAttempt {
            created_at_ms: now,
            expires_at_ms: now + 60_000,
            ..with_context(vec![], vec![])
        };
        let predicted = effective_attempt_binding(&attempt).expect("effective");
        let stored = create_attempt_with_id_bounded(
            &snapshot,
            &test_digest("product-context"),
            attempt,
            &admission(),
            &mut || Ok(()),
        )
        .expect("the product create stores a context");
        assert_eq!(stored.binding, predicted);
        assert!(stored
            .binding
            .history_turn_context
            .as_ref()
            .is_some_and(HistoryContextSlot::is_context));
        // The expected form that claim and terminal writers compare is the
        // stored one, so a downgrade cannot make them refuse.
        let expected = Nir1ExpectedAttempt::from_stored(&stored, budget());
        let reread = read_attempt(db, &stored.id, budget()).expect("reread");
        assert!(expected.matches(&reread));
    }

    #[test]
    fn effective_binding_function_predicts_the_stored_binding() {
        let db = database(Path::new(":memory:"));
        let (incomplete_inputs, incomplete_qualifications) = incomplete_inputs();
        let mut identity_missing = with_context(vec![], vec![]);
        identity_missing.binding.durable_workspace_identity = None;
        let mut overflow = with_context(vec![], vec![]);
        overflow.created_at_ms = i64::MAX - 5;
        overflow.expires_at_ms = i64::MAX;
        let mut closed_reason = with_context(vec![], vec![]);
        closed_reason.binding.history_turn_context = Some(HistoryContextSlot::Unavailable(
            HistoryUnavailableReason::SceneScopeUnavailable,
        ));
        let cases = [
            ("normal", with_context(vec![], vec![])),
            (
                "incomplete",
                with_context(incomplete_inputs, incomplete_qualifications),
            ),
            ("identity missing", identity_missing),
            ("eligibility overflow", overflow),
            ("closed reason is kept", closed_reason),
        ];
        for (index, (name, mut attempt)) in cases.into_iter().enumerate() {
            attempt.payload_digest = test_digest(&format!("predict-{index}"));
            let predicted = effective_attempt_binding(&attempt).expect(name);
            let stored = create_attempt(&db, attempt).expect(name);
            assert_eq!(stored.binding, predicted, "{name}");
            let reread = read_attempt(&db, &stored.id, budget()).expect(name);
            assert_eq!(reread.binding, predicted, "{name}");
            assert!(Nir1ExpectedAttempt::from_stored(&stored, budget()).matches(&reread));
        }
        // A binding over the ceiling only because of its slots is downgraded.
        let mut over_limit = with_context(vec![], vec![]);
        over_limit.payload_digest = test_digest("predict-limit");
        pad_without_slots(&mut over_limit, MAX_BINDING_JSON_BYTES - 100);
        let predicted = effective_attempt_binding(&over_limit).expect("downgrade");
        assert_eq!(
            predicted.history_turn_context,
            Some(HistoryContextSlot::Unavailable(
                HistoryUnavailableReason::BindingLimit
            ))
        );
        let stored = create_attempt(&db, over_limit).expect("downgraded create");
        assert_eq!(stored.binding, predicted);
        let reread = read_attempt(&db, &stored.id, budget()).expect("reread");
        assert_eq!(reread.binding, predicted);
    }

    #[test]
    fn context_slot_has_no_update_path_and_attempts_stay_immutable() {
        let db = database(Path::new(":memory:"));
        let stored = create_attempt(&db, with_context(vec![], vec![])).expect("attempt");
        let before = stored_binding_json(&db, &stored.id);
        finish_success(&db, &stored, "immutable-message", "answer");
        assert_eq!(stored_binding_json(&db, &stored.id), before);
        let recovered = create_attempt(
            &db,
            NewAttempt {
                payload_digest: test_digest("recovered"),
                ..with_context(vec![], vec![])
            },
        )
        .expect("second attempt");
        let before = stored_binding_json(&db, &recovered.id);
        recover_attempt(&db, &recovered.id, 2_000).expect("recover");
        assert_eq!(stored_binding_json(&db, &recovered.id), before);

        // Source: the only UPDATEs of the attempt row set the claim or the
        // terminal columns. No statement can repair a slot afterwards.
        let source = include_str!("../nir1_generation.rs");
        let updates: Vec<&str> = source
            .match_indices("UPDATE nir1_generation_attempts SET")
            .map(|(at, marker)| &source[at + marker.len()..at + marker.len() + 40])
            .collect();
        assert!(!updates.is_empty());
        for update in updates {
            assert!(
                update.trim_start().starts_with("claimed_at_ms")
                    || update.trim_start().starts_with("terminal_json"),
                "an UPDATE of the attempt row touches {update:?}"
            );
        }
        assert!(!source.contains("UPDATE nir1_generation_attempts SET binding_json"));
    }

    #[test]
    fn slot_with_unknown_contract_does_not_fail_claim_and_recovery() {
        let db = database(Path::new(":memory:"));
        let claimed = create_attempt(&db, with_context(vec![], vec![])).expect("attempt");
        let recovered = create_attempt(
            &db,
            NewAttempt {
                payload_digest: test_digest("unknown recovered"),
                ..with_context(vec![], vec![])
            },
        )
        .expect("second attempt");
        for id in [&claimed.id, &recovered.id] {
            let mut value = serde_json::from_str::<Value>(&stored_binding_json(&db, id)).expect("json");
            value["historyTurnContext"] =
                json!({"contract": "nir1-history-turn-context/2", "a": ["later", {"shape": 1}]});
            store_binding_json(&db, id, &canonical_binding(&value));
        }
        let read = read_attempt(&db, &claimed.id, budget()).expect("an unknown contract is read");
        assert_eq!(
            read.binding.history_turn_context,
            Some(HistoryContextSlot::UnknownContract)
        );
        assert!(claim_attempt(&db, &claimed.id, &read.binding, 1_500, budget()).expect("claim"));
        recover_attempt(&db, &recovered.id, 2_000).expect("recovery reads it");
        assert_eq!(
            pending_attempt_ids(&db, "generation-project", None, 8).expect("pending page"),
            vec![claimed.id.clone()]
        );
    }
}
