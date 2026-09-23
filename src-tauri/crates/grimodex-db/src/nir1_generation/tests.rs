use super::*;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Barrier,
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

fn database(path: &Path) -> Database {
    let db = Database::new(path).expect("database");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute("INSERT OR IGNORE INTO projects(id,title) VALUES ('generation-project','Project')",[])?;
        conn.execute("INSERT OR IGNORE INTO chat_sessions(id,project_id) VALUES ('generation-session','generation-project')",[])?;
        Ok(())
    }).expect("fixture");
    db
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

fn binding() -> AttemptBinding {
    AttemptBinding {
        project_id: "generation-project".into(),
        session_id: "generation-session".into(),
        profile_id: "profile".into(),
        caller_id: "main-caller".into(),
        caller_epoch: 3,
        workspace_binding_digest: test_digest("live-workspace-instance"),
        purpose: GenerationPurpose::Writing,
        scope_digest: test_digest("scope"),
        material_digest: test_digest("material"),
        d1_digest: test_digest("d1"),
        route_revision: "route-1".into(),
        provider: "local".into(),
        model: "test-model".into(),
        api: "chat-completions".into(),
        endpoint_identity: test_digest("loopback-endpoint"),
    }
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
    };
    let qualification = QualificationReference {
        input_ordinal: 1,
        kind: QualificationKind::Source,
        identity: "scene:source-x".into(),
        version: "source-v1".into(),
    };
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

#[test]
fn history_snapshot_reader_returns_owned_rows_and_reuses_attempt_reads() {
    let db = database(Path::new(":memory:"));
    let input = human(&db, "history-snapshot-human", "snapshot body");
    let attempt =
        create_attempt(&db, request(vec![message_input(&input)], vec![])).expect("attempt");
    let mut caller_budget = GenerationHistoryReadBudget {
        max_attempts: 2,
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 1,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 1,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 1,
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
        let (body_digest, role) = message_digest_in_tx(
            conn,
            &message_id,
            "generation-project",
            "generation-session",
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
        max_candidates: 8,
        max_reference_count: 8,
        max_reference_bytes: 16_384,
        max_resolved_body_bytes: 16_384,
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
    let qualification = QualificationReference {
        input_ordinal: 0,
        kind: QualificationKind::Source,
        identity: "source".into(),
        version: "version".into(),
    };
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
    wrong_binding.session_id = "other-generation-session".into();
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

#[test]
fn prepared_claim_rolls_back_denial_and_panic_then_commits_under_callback() {
    let db = database(Path::new(":memory:"));
    let attempt = create_attempt(&db, request(vec![], vec![])).expect("attempt");
    let denied = with_prepared_claim(&db, &attempt.id, &attempt.binding, budget(), |_prepared| {
        anyhow::bail!("authority revoked before final claim")
    });
    assert!(denied.is_err());
    assert!(read_attempt(&db, &attempt.id, budget())
        .expect("rollback")
        .claimed_at_ms
        .is_none());
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = with_prepared_claim(&db, &attempt.id, &attempt.binding, budget(), |_prepared| {
            panic!("authority owner panic before claim")
        });
    }));
    assert!(panic.is_err());
    assert!(db.connection_reusable());
    assert!(
        with_prepared_claim(&db, &attempt.id, &attempt.binding, budget(), |prepared| {
            prepared.commit(1_200)
        })
        .expect("commit")
    );
    assert!(
        !with_prepared_claim(&db, &attempt.id, &attempt.binding, budget(), |prepared| {
            prepared.commit(1_300)
        })
        .expect("consumed")
    );
}
