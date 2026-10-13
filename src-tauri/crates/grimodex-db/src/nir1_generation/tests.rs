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

        fn db_path(&self) -> PathBuf {
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

    pub(super) fn admission() -> Nir1AdmissionSqlBudget {
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), open_probe())
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
        create_attempt_with_id_bounded(workspace, id, now_request(), &admission(), &mut no_check())
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
            &Nir1PinnedSqlBudget::new(),
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
            let error = create(&snapshot, &id).expect_err("held mutex");
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
        let error = create(&snapshot, &id).expect_err("per-op timeout");
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
        let reread = read_attempt_exact_bounded(
            &snapshot,
            &vetoed.id,
            budget(),
            &Nir1PinnedSqlBudget::new(),
        )
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
        let reread = read_attempt_exact_bounded(
            &snapshot,
            &applied.id,
            budget(),
            &Nir1PinnedSqlBudget::new(),
        )
        .expect("reread")
        .expect("row");
        assert_eq!(reread.claimed_at_ms, error.claim_written_at_ms());
        assert!(read_attempt_exact_bounded(
            &snapshot,
            &test_digest("never-created"),
            budget(),
            &Nir1PinnedSqlBudget::new(),
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
                    &Nir1PinnedSqlBudget::new(),
                )
                .err(),
            );
            assert_refused(
                recover_claimed_attempt_bounded(
                    &snapshot,
                    &expected(&attempt),
                    &Nir1PinnedSqlBudget::new(),
                )
                .err(),
            );
            assert_refused(
                read_attempt_exact_bounded(
                    &snapshot,
                    &attempt.id,
                    budget(),
                    &Nir1PinnedSqlBudget::new(),
                )
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
            other_request,
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
                    &Nir1PinnedSqlBudget::new(),
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
                    &Nir1PinnedSqlBudget::new(),
                )
                .err(),
                "finish",
            );
            refused(
                recover_claimed_attempt_bounded(&snapshot, &swapped, &Nir1PinnedSqlBudget::new())
                    .err(),
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
            &Nir1PinnedSqlBudget::new(),
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
        let terminal = recover(NIR1_GENERATION_OPERATION_LIMIT).expect("recovery after release");
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
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
            "caller-session".into(),
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
            request,
            &admission(),
            &mut || Ok(()),
        )
    }

    fn bind_scene(snapshot: &crate::state::ActiveWorkspaceSnapshot) {
        snapshot
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                     VALUES (?1, 'generation-project', 'scene', 'Scene', '')",
                    [SCENE],
                )?;
                conn.execute(
                    "UPDATE chat_sessions SET node_id=?1 WHERE id=?2",
                    [SCENE, SESSION],
                )?;
                Ok(())
            })
            .expect("scene-bound session");
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
    /// profile, caller or caller epoch is not the capture owner's, and a
    /// pinned workspace whose locator or authority instance is not the
    /// owner's (the same path re-opened as a new authority instance, or
    /// another locator under the same instance). Nothing is written.
    #[test]
    fn d13_capture_create_requires_the_owner_caller_and_workspace_incarnation() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        bind_scene(&snapshot);
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
        for name in ["profile", "caller", "caller epoch"] {
            let mut request = capture_request(&capture);
            match name {
                "profile" => request.binding.profile_id = "another-profile".into(),
                "caller" => request.binding.caller_id = "another-caller".into(),
                _ => request.binding.caller_epoch += 1,
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

    #[test]
    fn d9_capture_create_is_deterministic_and_requires_the_current_capture() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        bind_scene(&snapshot);
        let first = accept(&snapshot, "first");
        let attempt = create_for(&snapshot, &first, capture_request(&first)).expect("create");
        assert_eq!(
            attempt.id,
            attempt_id_for_capture(&first).expect("deterministic id")
        );
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
        wrong_session.binding.session_id = "another-session".into();
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
