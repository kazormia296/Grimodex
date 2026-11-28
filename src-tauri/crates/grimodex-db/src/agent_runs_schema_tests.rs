use std::path::Path;

use rusqlite::Connection;
use serde_json::json;

use crate::agent_runs::{
    self, ActiveStatus, AnalysisReadBasisEntryV1, AnalysisReadBasisRevision, ApprovalDecision,
    ApprovalInvalidation, CapabilityState, ClaimAnswer, ClaimRequest, ExecutionState,
    FinalizingEvidence, FinalizingRun, InterruptReason, LedgerEntry, NotResumableReason,
    OpenApproval, OpenQuestion, PendingApproval, RecoveryOutcome, RecoveryResult, ResumeGate,
    RunRoute, RunStart, RunState, RunStatus, TerminalOutcome, ToolCallUpdate,
};
use crate::{test_support::current_schema_memory, Database};

pub(crate) fn temp_workspace() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("grimodex-agent-runs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).expect("create temp workspace");
    path
}

fn seed(db: &Database, sessions: &[&str]) {
    db.with_conn(|conn| {
        conn.execute("INSERT INTO projects (id) VALUES ('p')", [])?;
        for session in sessions {
            conn.execute(
                "INSERT INTO chat_sessions (id,project_id) VALUES (?1,'p')",
                [session],
            )?;
        }
        Ok(())
    })
    .expect("seed project and sessions");
}

fn start<'a>(run_id: &'a str, session: &'a str, owner: &'a str) -> RunStart<'a> {
    RunStart {
        run_id,
        project_id: "p",
        chat_session_id: session,
        turn_id: "turn",
        route: RunRoute::Legacy,
        origin_user_message_id: "user-message",
        model_provider_id: "provider",
        model_id: "model",
        endpoint_hash: "endpoint-hash",
        execution_owner: owner,
    }
}

fn ledger_entry(id: &str) -> LedgerEntry {
    LedgerEntry {
        tool_call_id: id.into(),
        name: "read_scene".into(),
        canonical_args: json!({"id":"scene"}),
        args_digest: "digest".into(),
        execution_id: "execution".into(),
        chat_message_id: "message".into(),
        main_owned_provenance_id: "provenance".into(),
        model: "model".into(),
        capability_state: CapabilityState::NotIssued,
        execution_state: ExecutionState::Pending,
    }
}

fn approval<'a>(
    interaction_id: &'a str,
    run_id: &'a str,
    owner: &'a str,
    expected_version: i64,
) -> OpenApproval<'a> {
    OpenApproval {
        interaction_id,
        run_id,
        owner,
        expected_version,
        tool_call_id: "tool",
        tool_name: "write_scene",
        args_digest: "digest",
        request: "Approve?",
        target_basis: None,
    }
}

fn target_basis_entry(revision: AnalysisReadBasisRevision) -> AnalysisReadBasisEntryV1 {
    AnalysisReadBasisEntryV1 {
        source_kind: "scene".into(),
        source_id: "scene-id".into(),
        revision,
    }
}

fn run_state(db: &Database, run_id: &str) -> (String, i64, String) {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT status,version,execution_owner FROM agent_runs WHERE run_id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(Into::into)
    })
    .expect("run state")
}

fn interaction_state(db: &Database, id: &str) -> (String, String, Option<String>, i64) {
    db.with_conn(|conn| {
        conn.query_row(
        "SELECT kind,status,resolution,version FROM agent_run_interactions WHERE interaction_id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(Into::into)
    })
    .expect("interaction state")
}

#[test]
fn terminal_paths_clear_run_and_all_interaction_payloads() {
    let db = current_schema_memory().expect("schema");
    let workspace = temp_workspace();
    seed(
        &db,
        &[
            "complete",
            "fail",
            "stop",
            "recover-complete",
            "recover-fail",
            "recover-stop",
            "discard",
            "supersede",
        ],
    );
    for (run_id, target, expected_status) in [
        ("complete", TerminalOutcome::Completed, "completed"),
        ("fail", TerminalOutcome::ProviderError, "failed"),
        ("stop", TerminalOutcome::UserStop, "cancelled"),
        ("recover-complete", TerminalOutcome::Completed, "completed"),
        ("recover-fail", TerminalOutcome::ProviderError, "failed"),
        ("recover-stop", TerminalOutcome::UserStop, "cancelled"),
        ("discard", TerminalOutcome::DiscardedByAuthor, "discarded"),
        (
            "supersede",
            TerminalOutcome::SupersededByNewTurn,
            "discarded",
        ),
    ] {
        agent_runs::start_run(&db, &start(run_id, run_id, "owner")).expect("start");
        let question_id = format!("{run_id}-question");
        let opened = agent_runs::open_user_question(
            &db,
            &OpenQuestion {
                interaction_id: &question_id,
                run_id,
                owner: "owner",
                expected_version: 0,
                tool_call_id: "ask",
                args_digest: "digest",
                request: "Question?",
            },
        )
        .expect("question");
        assert_eq!(
            (opened.version, opened.status.as_str()),
            (1, "waiting_user")
        );
        let answered = agent_runs::answer_live(&db, run_id, "owner", 1, &question_id, 0, "Answer")
            .expect("answer");
        assert_eq!((answered.version, answered.status.as_str()), (2, "running"));
        let target_basis = [target_basis_entry(AnalysisReadBasisRevision::Version(
            "v1".into(),
        ))];
        let resolved_id = format!("{run_id}-resolved");
        agent_runs::open_approval(
            &db,
            &OpenApproval {
                target_basis: Some(&target_basis),
                ..approval(&resolved_id, run_id, "owner", 2)
            },
        )
        .expect("open resolved approval");
        agent_runs::decide_approval(
            &db,
            run_id,
            "owner",
            3,
            &resolved_id,
            0,
            ApprovalDecision::Approved,
        )
        .expect("resolve approval");
        let approval_id = format!("{run_id}-approval");
        let opened = agent_runs::open_approval(
            &db,
            &OpenApproval {
                target_basis: Some(&target_basis),
                ..approval(&approval_id, run_id, "owner", 4)
            },
        )
        .expect("approval");
        assert_eq!(
            (opened.version, opened.status.as_str()),
            (5, "waiting_approval")
        );
        agent_runs::append_tool_call(&db, run_id, "owner", ledger_entry("tool")).expect("ledger");
        agent_runs::write_checkpoint(
            &db,
            run_id,
            "owner",
            1,
            &json!({"text":"checkpoint"}),
            "digest",
        )
        .expect("checkpoint");
        let result = if expected_status == "discarded" {
            let interrupted = agent_runs::interrupt_run(
                &db,
                run_id,
                "owner",
                ActiveStatus::WaitingApproval,
                5,
                InterruptReason::AppShutdown,
            )
            .expect("interrupt");
            assert_eq!(
                (interrupted.version, interrupted.status.as_str()),
                (6, "interrupted")
            );
            if run_id == "discard" {
                agent_runs::discard_run(&db, run_id, "owner", 6).expect("discard")
            } else {
                let result = agent_runs::start_superseding_run(
                    &db,
                    run_id,
                    "owner",
                    6,
                    &start("new", run_id, "owner"),
                )
                .expect("supersede");
                assert_eq!(
                    result.started,
                    RunState {
                        run_id: "new".into(),
                        version: 0,
                        status: "running".into()
                    }
                );
                result.discarded
            }
        } else {
            agent_runs::begin_finalizing(
                &db,
                run_id,
                "owner",
                ActiveStatus::WaitingApproval,
                5,
                target,
                "assistant",
            )
            .expect("begin finalizing");
            if run_id.starts_with("recover-") {
                let recovered = agent_runs::recover_owner(
                    &db,
                    &workspace,
                    "owner",
                    None,
                    &[FinalizingEvidence {
                        run_id,
                        version: 6,
                        user_message_complete: true,
                        assistant_message_complete: true,
                    }],
                )
                .expect("recover");
                let [result]: [RecoveryResult; 1] = recovered.try_into().expect("one run changed");
                let RecoveryOutcome::Finalized { status } = result.outcome else {
                    panic!("expected finalized result: {result:?}");
                };
                RunState {
                    run_id: result.run_id,
                    version: result.version,
                    status,
                }
            } else {
                agent_runs::finish_finalizing(&db, run_id, "owner", 6).expect("finish")
            }
        };
        assert_eq!(
            (
                result.run_id.as_str(),
                result.version,
                result.status.as_str()
            ),
            (run_id, 7, expected_status)
        );
        db.with_conn(|conn| {
            let run_payload: (Option<String>, String) = conn.query_row(
                "SELECT checkpoint,tool_call_ledger FROM agent_runs WHERE run_id=?1",
                [run_id], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(run_payload, (None, "[]".into()), "{run_id}");
            for (id, expected_status) in [(&question_id, "resolved"), (&resolved_id, "resolved"), (&approval_id, "cancelled")] {
                let payload: (String, String, Option<String>, String, i64) = conn.query_row(
                    "SELECT request,resolution,target_basis,status,version FROM agent_run_interactions WHERE interaction_id=?1",
                    [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )?;
                assert_eq!(payload, ("".into(), "".into(), None, expected_status.into(), 1), "{id}");
            }
            Ok(())
        }).expect("terminal payloads");
    }
}

#[test]
fn interaction_request_limit_counts_utf8_bytes() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["question", "approval"]);
    for id in ["question", "approval"] {
        agent_runs::start_run(&db, &start(id, id, "owner")).expect("start");
    }
    let limit = "é".repeat(32_768);
    let oversized = format!("{limit}a");
    let question = |request| {
        agent_runs::open_user_question(
            &db,
            &OpenQuestion {
                interaction_id: "question",
                run_id: "question",
                owner: "owner",
                expected_version: 0,
                tool_call_id: "ask",
                args_digest: "digest",
                request,
            },
        )
    };
    let approve = |request| {
        agent_runs::open_approval(
            &db,
            &OpenApproval {
                request,
                ..approval("approval", "approval", "owner", 0)
            },
        )
    };
    for result in [question(&oversized), approve(&oversized)] {
        assert_eq!(
            result.unwrap_err().to_string(),
            "AGENT_RUN_REQUEST_TOO_LARGE"
        );
    }
    question(&limit).expect("question at limit");
    approve(&limit).expect("approval at limit");
}

#[test]
fn mark_not_resumable_preserves_the_first_reason() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    let initial = agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    for reason in [
        NotResumableReason::CheckpointWriteFailed,
        NotResumableReason::LedgerWriteFailed,
    ] {
        let state = agent_runs::mark_not_resumable(&db, "r", "owner", reason).expect("mark");
        assert_eq!(state, initial);
    }
    db.with_conn(|conn| {
        let (resumable, reason, version): (bool, String, i64) = conn.query_row(
            "SELECT resumable,not_resumable_reason,version FROM agent_runs WHERE run_id='r'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert!(!resumable);
        assert_eq!(reason, "checkpoint_write_failed");
        assert_eq!(version, initial.version);
        Ok(())
    })
    .expect("read reason");
}

#[test]
fn touch_activity_preserves_version() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET activity_at='2000-01-01 00:00:00'",
            [],
        )?;
        Ok(())
    })
    .expect("set old activity");
    agent_runs::touch_activity(&db, "r", "owner").expect("touch");
    db.with_conn(|conn| {
        let (version, refreshed): (i64, bool) = conn.query_row(
            "SELECT version,activity_at>'2000-01-01 00:00:00' FROM agent_runs WHERE run_id='r'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((version, refreshed), (0, true));
        Ok(())
    })
    .expect("read version and activity");
}

#[test]
fn claim_rejects_non_resumable_run() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    agent_runs::interrupt_run(
        &db,
        "r",
        "owner",
        ActiveStatus::Running,
        0,
        InterruptReason::AppShutdown,
    )
    .expect("interrupt");
    agent_runs::mark_not_resumable(&db, "r", "owner", NotResumableReason::RouteUnsupported)
        .expect("mark");
    for (old_owner, expected_version, gate, marker) in [
        ("owner", 1, ResumeGate::Allowed, "AGENT_RUN_NOT_RESUMABLE"),
        (
            "owner",
            1,
            ResumeGate::Blocked("blocked"),
            "AGENT_RUN_NOT_RESUMABLE",
        ),
        ("other", 1, ResumeGate::Allowed, "AGENT_RUN_OWNER_MISMATCH"),
        (
            "owner",
            0,
            ResumeGate::Allowed,
            "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
        ),
    ] {
        let claim = ClaimRequest {
            run_id: "r",
            old_owner,
            new_owner: "new",
            expected_version,
            request_id: "claim",
            gate,
            answer: None,
        };
        assert_eq!(
            agent_runs::claim_run(&db, claim).unwrap_err().to_string(),
            marker
        );
    }
    assert_eq!(
        run_state(&db, "r"),
        ("interrupted".into(), 1, "owner".into())
    );
    assert_eq!(
        agent_runs::get_run_status(&db, "r")
            .expect("read run")
            .expect("run exists")
            .resume_block_detail,
        None
    );
}

#[test]
fn owner_mutations_reject_foreign_owner() {
    fn rejects<T: std::fmt::Debug>(result: anyhow::Result<T>) {
        assert_eq!(result.unwrap_err().to_string(), "AGENT_RUN_OWNER_MISMATCH");
    }

    let db = current_schema_memory().expect("schema");
    seed(&db, &["s", "abandoned"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    rejects(agent_runs::interrupt_run(
        &db,
        "r",
        "other",
        ActiveStatus::Running,
        0,
        InterruptReason::AppShutdown,
    ));
    rejects(agent_runs::mark_not_resumable(
        &db,
        "r",
        "other",
        NotResumableReason::RouteUnsupported,
    ));
    rejects(agent_runs::touch_activity(&db, "r", "other"));
    rejects(agent_runs::write_checkpoint(
        &db,
        "r",
        "other",
        1,
        &json!({}),
        "digest",
    ));
    rejects(agent_runs::append_tool_call(
        &db,
        "r",
        "other",
        ledger_entry("tool"),
    ));
    agent_runs::append_tool_call(&db, "r", "owner", ledger_entry("tool")).expect("append");
    rejects(agent_runs::update_tool_call(
        &db,
        ToolCallUpdate {
            run_id: "r",
            owner: "other",
            tool_call_id: "tool",
            main_owned_provenance_id: None,
            capability_state: Some(CapabilityState::Issued),
            execution_state: None,
        },
    ));

    let question = OpenQuestion {
        interaction_id: "q",
        run_id: "r",
        owner: "other",
        expected_version: 0,
        tool_call_id: "question",
        args_digest: "digest",
        request: "Question?",
    };
    rejects(agent_runs::open_user_question(&db, &question));
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            owner: "owner",
            ..question
        },
    )
    .expect("open question");
    rejects(agent_runs::answer_live(
        &db, "r", "other", 1, "q", 0, "answer",
    ));
    agent_runs::answer_live(&db, "r", "owner", 1, "q", 0, "answer").expect("answer");
    rejects(agent_runs::open_approval(
        &db,
        &approval("a", "r", "other", 2),
    ));
    agent_runs::open_approval(&db, &approval("a", "r", "owner", 2)).expect("open approval");
    rejects(agent_runs::decide_approval(
        &db,
        "r",
        "other",
        3,
        "a",
        0,
        ApprovalDecision::Approved,
    ));
    rejects(agent_runs::invalidate_approval(
        &db,
        "r",
        "other",
        3,
        "a",
        0,
        ApprovalInvalidation::Expired,
    ));
    agent_runs::decide_approval(&db, "r", "owner", 3, "a", 0, ApprovalDecision::Approved)
        .expect("approve");
    rejects(agent_runs::begin_finalizing(
        &db,
        "r",
        "other",
        ActiveStatus::Running,
        4,
        TerminalOutcome::Completed,
        "assistant",
    ));
    agent_runs::begin_finalizing(
        &db,
        "r",
        "owner",
        ActiveStatus::Running,
        4,
        TerminalOutcome::Completed,
        "assistant",
    )
    .expect("begin finalizing");
    rejects(agent_runs::finish_finalizing(&db, "r", "other", 5));
    rejects(agent_runs::recover_finalizing(
        &db,
        "other",
        &FinalizingEvidence {
            run_id: "r",
            version: 5,
            user_message_complete: true,
            assistant_message_complete: true,
        },
    ));
    assert_eq!(
        run_state(&db, "r"),
        ("finalizing".into(), 5, "owner".into())
    );

    agent_runs::start_run(&db, &start("old", "abandoned", "owner")).expect("start old");
    agent_runs::interrupt_run(
        &db,
        "old",
        "owner",
        ActiveStatus::Running,
        0,
        InterruptReason::AppShutdown,
    )
    .expect("interrupt old");
    rejects(agent_runs::discard_run(&db, "old", "other", 1));
    rejects(agent_runs::start_superseding_run(
        &db,
        "old",
        "other",
        1,
        &start("new", "abandoned", "other"),
    ));
    for gate in [ResumeGate::Allowed, ResumeGate::Blocked("blocked")] {
        rejects(agent_runs::claim_run(
            &db,
            ClaimRequest {
                run_id: "old",
                old_owner: "other",
                new_owner: "new",
                expected_version: 1,
                request_id: "claim",
                gate,
                answer: None,
            },
        ));
    }
    assert_eq!(
        run_state(&db, "old"),
        ("interrupted".into(), 1, "owner".into())
    );
}

#[test]
fn schema_checks_and_partial_uniques() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    assert_eq!(
        agent_runs::start_run(&db, &start("r2", "s", "owner"))
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_UNFINISHED_SESSION_EXISTS"
    );
    db.with_conn(|conn| {
        assert!(conn.execute("UPDATE agent_runs SET status='completed',terminal_reason='user_stop' WHERE run_id='r'", []).is_err());
        assert!(conn.execute("UPDATE agent_runs SET status='completed',terminal_reason=NULL WHERE run_id='r'", []).is_err());
        conn.execute("UPDATE agent_runs SET interrupt_reason='future_reason',
            resumable=0,not_resumable_reason='future_reason' WHERE run_id='r'", [])?;
        Ok(())
    }).expect("schema checks");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "r",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("open question");
    db.with_conn(|conn| {
        assert!(conn.execute(
            "INSERT INTO agent_run_interactions
             (interaction_id,run_id,root_run_id,chat_session_id,kind,tool_call_id,tool_name,args_digest,request,status)
             VALUES ('q2','r','r','s','user_question','tool2','ask_user','digest','Question?','pending')", [],
        ).is_err());
        Ok(())
    }).expect("pending unique");
}

#[test]
fn schema_leaves_extensible_vocabulary_unchecked() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    db.with_conn(|conn| {
        conn.execute("UPDATE agent_runs SET route='future_route' WHERE run_id='r'", [])?;
        assert!(conn.execute(
            "UPDATE agent_runs SET finalizing_target_status='future_status' WHERE run_id='r'", [],
        ).is_err());
        assert!(conn.execute(
            "UPDATE agent_runs SET finalizing_target_reason='future_reason' WHERE run_id='r'", [],
        ).is_err());
        conn.execute(
            "UPDATE agent_runs SET finalizing_target_status='future_status',
                 finalizing_target_reason='future_reason' WHERE run_id='r'", [],
        )?;
        assert!(conn.execute("UPDATE agent_runs SET status='finalizing' WHERE run_id='r'", []).is_err());
        conn.execute(
            "UPDATE agent_runs SET status='finalizing',origin_assistant_message_id='assistant' WHERE run_id='r'", [],
        )?;
        assert!(conn.execute(
            "UPDATE agent_runs SET finalizing_target_status=NULL,finalizing_target_reason=NULL WHERE run_id='r'", [],
        ).is_err());
        assert!(conn.execute("UPDATE agent_runs SET status='future_status' WHERE run_id='r'", []).is_err());
        conn.execute(
            "INSERT INTO agent_run_interactions
             (interaction_id,run_id,root_run_id,chat_session_id,kind,tool_call_id,tool_name,args_digest,request,status)
             VALUES ('q','r','r','s','future_kind','tool','tool_name','digest','request','future_status')", [],
        )?;
        Ok(())
    }).expect("extensible values and required pairs");
}

#[test]
fn run_routes_persist_canonical_values() {
    let db = current_schema_memory().expect("schema");
    let routes = [
        (RunRoute::Legacy, "legacy"),
        (RunRoute::Mastra, "mastra"),
        (RunRoute::Cli, "cli"),
        (RunRoute::CodexApp, "codex_app"),
    ];
    seed(&db, &routes.map(|(_, name)| name));
    for (route, name) in routes {
        let mut run = start(name, name, "owner");
        run.route = route;
        agent_runs::start_run(&db, &run).expect("start");
        let stored: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT route FROM agent_runs WHERE run_id=?1",
                    [name],
                    |row| row.get(0),
                )?)
            })
            .expect("read route");
        assert_eq!(stored, name);
    }
}

#[test]
fn agent_run_queries_use_lookup_indexes() {
    let db = current_schema_memory().expect("schema");
    db.with_conn(|conn| {
        for (sql, index) in [
            (
                agent_runs::UNFINISHED_RUN_EXISTS_SQL,
                "idx_agent_runs_chat_session_id",
            ),
            (
                agent_runs::CLEAR_TERMINAL_INTERACTIONS_SQL,
                "idx_agent_run_interactions_run_id",
            ),
            (
                agent_runs::UNFINISHED_RUN_FOR_SESSION_SQL,
                "idx_agent_runs_chat_session_id",
            ),
        ] {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let plan = stmt
                .query_map(["id"], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert!(
                plan.iter()
                    .any(|detail| detail.starts_with("SEARCH ") && detail.contains(index)),
                "expected index {index} in {plan:?}"
            );
            assert!(
                !plan
                    .iter()
                    .any(|detail| detail.starts_with("SCAN agent_run")),
                "unexpected full scan in {plan:?}"
            );
        }
        Ok(())
    })
    .expect("explain AgentRun queries");
}

#[test]
fn target_basis_schema_accepts_only_null_or_json_arrays() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    agent_runs::open_approval(&db, &approval("a", "r", "owner", 0)).expect("open");
    db.with_conn(|conn| {
        let set_basis = |basis: Option<&str>| {
            conn.execute(
                "UPDATE agent_run_interactions SET target_basis=?1 WHERE interaction_id='a'",
                [basis],
            )
        };
        set_basis(None).expect("NULL accepted");
        set_basis(Some("[]")).expect("array accepted");
        for invalid in ["[", "{}", "null", "42", "\"array\""] {
            assert!(set_basis(Some(invalid)).is_err(), "{invalid}");
        }
        Ok(())
    })
    .expect("target_basis CHECK");
}

#[test]
fn open_approval_validates_target_basis_entry_and_count_limits() {
    use AnalysisReadBasisRevision::{ContentHash, Version};

    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    let initial = agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    let open = |basis: &[AnalysisReadBasisEntryV1]| {
        agent_runs::open_approval(
            &db,
            &OpenApproval {
                target_basis: Some(basis),
                ..approval("a", "r", "owner", 0)
            },
        )
    };
    let version = AnalysisReadBasisEntryV1 {
        source_kind: "é".repeat(32),
        source_id: "é".repeat(128),
        revision: Version("é".repeat(128)),
    };
    let hash = target_basis_entry(ContentHash("é".repeat(128)));
    for invalid in [
        vec![],
        vec![target_basis_entry(Version("v1".into())); 65],
        vec![AnalysisReadBasisEntryV1 {
            source_kind: String::new(),
            ..version.clone()
        }],
        vec![AnalysisReadBasisEntryV1 {
            source_kind: format!("{}k", version.source_kind),
            ..version.clone()
        }],
        vec![AnalysisReadBasisEntryV1 {
            source_id: String::new(),
            ..version.clone()
        }],
        vec![AnalysisReadBasisEntryV1 {
            source_id: format!("{}i", version.source_id),
            ..version.clone()
        }],
        vec![target_basis_entry(Version(String::new()))],
        vec![target_basis_entry(Version(format!("{}v", "é".repeat(128))))],
        vec![target_basis_entry(ContentHash(String::new()))],
        vec![target_basis_entry(ContentHash(format!(
            "{}h",
            "é".repeat(128)
        )))],
    ] {
        assert_eq!(
            open(&invalid).unwrap_err().to_string(),
            "AGENT_RUN_TARGET_BASIS_INVALID"
        );
    }
    assert_eq!(
        run_state(&db, "r"),
        (initial.status, initial.version, "owner".into())
    );
    assert_eq!(
        agent_runs::get_pending_approval(&db, "r").expect("read"),
        None
    );
    open(&[version, hash]).expect("fields at byte limits");
}

#[test]
fn open_approval_counts_encoded_target_basis_bytes() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    let open = |basis: &[AnalysisReadBasisEntryV1]| {
        agent_runs::open_approval(
            &db,
            &OpenApproval {
                target_basis: Some(basis),
                ..approval("a", "r", "owner", 0)
            },
        )
    };
    let entry = |revision_len| AnalysisReadBasisEntryV1 {
        source_kind: "s".repeat(64),
        source_id: "i".repeat(256),
        revision: AnalysisReadBasisRevision::Version("\"".repeat(revision_len)),
    };
    let mut entries = vec![entry(74); 64];
    entries[0] = entry(42);
    assert_eq!(
        serde_json::to_string(&entries).expect("encode").len(),
        32 * 1024 + 1
    );
    assert_eq!(
        open(&entries).unwrap_err().to_string(),
        "AGENT_RUN_TARGET_BASIS_INVALID"
    );
    entries[0].source_id.pop();
    assert_eq!(
        serde_json::to_string(&entries).expect("encode").len(),
        32 * 1024
    );
    open(&entries).expect("64 entries and 32 KiB accepted");
    assert_eq!(
        agent_runs::get_pending_approval(&db, "r")
            .expect("read")
            .expect("pending")
            .target_basis,
        Some(entries)
    );
}

#[test]
fn pending_approval_rejects_invalid_target_basis_json() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    agent_runs::open_approval(&db, &approval("a", "r", "owner", 0)).expect("open");
    for invalid in [
        r#"[]"#,
        r#"[null]"#,
        r#"[["scene","id","v1"]]"#,
        r#"[{"sourceId":"id","version":"v1"}]"#,
        r#"[{"sourceKind":"scene","version":"v1"}]"#,
        r#"[{"sourceKind":1,"sourceId":"id","version":"v1"}]"#,
        r#"[{"sourceKind":"scene","sourceId":true,"version":"v1"}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id"}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","version":"v1","contentHash":"hash"}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","version":"v1","contentHash":null}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","version":"v1","version":"v2"}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","version":1}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","contentHash":false}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","version":null}]"#,
        r#"[{"sourceKind":"scene","sourceId":"id","version":"v1","body":"text"}]"#,
    ] {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_run_interactions SET target_basis=?1 WHERE interaction_id='a'",
                [invalid],
            )?;
            Ok(())
        })
        .expect("SQL CHECK accepts arrays");
        assert_eq!(
            agent_runs::get_pending_approval(&db, "r")
                .unwrap_err()
                .to_string(),
            "AGENT_RUN_TARGET_BASIS_INVALID",
            "{invalid}"
        );
    }
}

#[test]
fn pending_approval_round_trips_target_basis_before_claim() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["existing", "new", "question"]);
    for id in ["existing", "new", "question"] {
        agent_runs::start_run(&db, &start(id, id, "old")).expect("start");
    }
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "question",
            owner: "old",
            expected_version: 0,
            tool_call_id: "ask",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    assert_eq!(
        agent_runs::get_pending_approval(&db, "question").expect("read"),
        None
    );
    assert_eq!(
        agent_runs::get_pending_approval(&db, "missing").expect("read"),
        None
    );
    agent_runs::open_approval(&db, &approval("new-approval", "new", "old", 0))
        .expect("open for new target");
    let new_target = agent_runs::get_pending_approval(&db, "new")
        .expect("read")
        .expect("pending");
    assert_eq!(new_target.interaction_id, "new-approval");
    assert_eq!(new_target.target_basis, None);

    let basis = [
        target_basis_entry(AnalysisReadBasisRevision::Version("v1".into())),
        target_basis_entry(AnalysisReadBasisRevision::ContentHash("hash".into())),
    ];
    agent_runs::open_approval(
        &db,
        &OpenApproval {
            target_basis: Some(&basis),
            ..approval("existing-approval", "existing", "old", 0)
        },
    )
    .expect("open for existing target");
    db.with_conn(|conn| {
        let question_basis: Option<String> = conn.query_row(
            "SELECT target_basis FROM agent_run_interactions WHERE interaction_id='q'", [], |row| row.get(0),
        )?;
        assert_eq!(question_basis, None);
        let stored: String = conn.query_row(
            "SELECT target_basis FROM agent_run_interactions WHERE interaction_id='existing-approval'", [], |row| row.get(0),
        )?;
        assert_eq!(serde_json::from_str::<serde_json::Value>(&stored)?, json!([
            {"sourceKind":"scene", "sourceId":"scene-id", "version":"v1"},
            {"sourceKind":"scene", "sourceId":"scene-id", "contentHash":"hash"},
        ]));
        Ok(())
    }).expect("stored JSON");
    agent_runs::interrupt_run(
        &db,
        "existing",
        "old",
        ActiveStatus::WaitingApproval,
        1,
        InterruptReason::ApprovalTimeout,
    )
    .expect("interrupt before claim");
    assert_eq!(
        agent_runs::get_pending_approval(&db, "existing").expect("read before claim"),
        Some(PendingApproval {
            interaction_id: "existing-approval".into(),
            version: 0,
            tool_call_id: "tool".into(),
            tool_name: "write_scene".into(),
            args_digest: "digest".into(),
            target_basis: Some(basis.to_vec()),
        })
    );
    agent_runs::decide_approval(
        &db,
        "new",
        "old",
        1,
        "new-approval",
        0,
        ApprovalDecision::Rejected,
    )
    .expect("decide approval");
    assert_eq!(
        agent_runs::get_pending_approval(&db, "new").expect("read resolved"),
        None
    );
}

#[test]
fn state_occ_and_terminal_are_single_winner() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    let started = agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    assert_eq!((started.version, started.status.as_str()), (0, "running"));
    for (run_id, owner, status, version, marker) in [
        (
            "missing",
            "owner",
            ActiveStatus::Running,
            0,
            "AGENT_RUN_NOT_FOUND",
        ),
        (
            "r",
            "other",
            ActiveStatus::Running,
            0,
            "AGENT_RUN_OWNER_MISMATCH",
        ),
        (
            "r",
            "owner",
            ActiveStatus::Running,
            1,
            "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
        ),
        (
            "r",
            "owner",
            ActiveStatus::WaitingUser,
            0,
            "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
        ),
    ] {
        let error = agent_runs::interrupt_run(
            &db,
            run_id,
            owner,
            status,
            version,
            InterruptReason::AppShutdown,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), marker);
    }
    let begun = agent_runs::begin_finalizing(
        &db,
        "r",
        "owner",
        ActiveStatus::Running,
        0,
        TerminalOutcome::Completed,
        "assistant",
    )
    .expect("finalizing");
    assert_eq!((begun.version, begun.status.as_str()), (1, "finalizing"));
    assert!(agent_runs::begin_finalizing(
        &db,
        "r",
        "owner",
        ActiveStatus::Running,
        0,
        TerminalOutcome::UserStop,
        "assistant"
    )
    .is_err());
    let finalizing = agent_runs::get_finalizing(&db, "r", "owner")
        .expect("get")
        .expect("row");
    assert_eq!(finalizing.version, 1);
    let finished = agent_runs::finish_finalizing(&db, "r", "owner", 1).expect("finish");
    assert_eq!(
        (finished.version, finished.status.as_str()),
        (2, "completed")
    );
    assert_eq!(
        agent_runs::finish_finalizing(&db, "r", "owner", 1)
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_TERMINAL"
    );
    db.with_conn(|conn| {
        let terminal: (String, String) = conn.query_row(
            "SELECT status,terminal_reason FROM agent_runs WHERE run_id='r'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(terminal, ("completed".into(), "completed".into()));
        Ok(())
    })
    .expect("terminal row");
}

#[test]
fn claim_replay_and_two_claims() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "old")).expect("start");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "r",
            owner: "old",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    agent_runs::interrupt_run(
        &db,
        "r",
        "old",
        ActiveStatus::WaitingUser,
        1,
        InterruptReason::AppShutdown,
    )
    .expect("interrupt");
    let answer = ClaimAnswer {
        interaction_id: "q",
        expected_version: 0,
        resolution: "Answer",
    };
    let claim = || ClaimRequest {
        run_id: "r",
        old_owner: "old",
        new_owner: "new",
        expected_version: 2,
        request_id: "key",
        gate: ResumeGate::Allowed,
        answer: Some(&answer),
    };
    let first = agent_runs::claim_run(&db, claim())
        .expect("claim")
        .expect("allowed");
    let replay = agent_runs::claim_run(&db, claim())
        .expect("replay")
        .expect("allowed");
    assert_eq!(first, replay);
    // The replay of a caller that re-reads the row's owner returns the stored result.
    let reread = agent_runs::claim_run(
        &db,
        ClaimRequest {
            old_owner: "new",
            ..claim()
        },
    )
    .expect("replay with the row's owner")
    .expect("allowed");
    assert_eq!(first, reread);
    assert_eq!(
        agent_runs::claim_run(
            &db,
            ClaimRequest {
                run_id: "r",
                old_owner: "old",
                new_owner: "other",
                expected_version: 2,
                request_id: "other-key",
                gate: ResumeGate::Allowed,
                answer: Some(&answer),
            }
        )
        .unwrap_err()
        .to_string(),
        "AGENT_RUN_OWNER_MISMATCH"
    );
    db.with_conn(|conn| {
        let reason: Option<String> = conn.query_row(
            "SELECT interrupt_reason FROM agent_runs WHERE run_id='r'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(reason, None);
        let (status, resolution): (String, String) = conn.query_row(
            "SELECT status,resolution FROM agent_run_interactions WHERE interaction_id='q'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            (status.as_str(), resolution.as_str()),
            ("resolved", "Answer")
        );
        Ok(())
    })
    .expect("answer persisted");
    agent_runs::interrupt_run(
        &db,
        "r",
        "new",
        ActiveStatus::Running,
        first.version,
        InterruptReason::RendererLost,
    )
    .expect("interrupt claimed run");
    assert_eq!(
        agent_runs::claim_run(&db, claim()).unwrap_err().to_string(),
        "AGENT_RUN_CLAIM_REPLAY_STALE"
    );
}

#[test]
fn live_answer_occ_rejects_stale_and_duplicate_resolution() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "r",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    assert!(agent_runs::answer_live(&db, "r", "owner", 0, "q", 0, "stale").is_err());
    agent_runs::answer_live(&db, "r", "owner", 1, "q", 0, "answer").expect("first answer");
    assert!(agent_runs::answer_live(&db, "r", "owner", 1, "q", 0, "duplicate").is_err());
    db.with_conn(|conn| {
        let resolution: String = conn.query_row(
            "SELECT resolution FROM agent_run_interactions WHERE interaction_id='q'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(resolution, "answer");
        Ok(())
    })
    .expect("one answer");
}

#[test]
fn superseding_start_discards_only_when_new_run_commits() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s", "other"]);
    agent_runs::start_run(&db, &start("old", "s", "owner")).expect("start");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "old",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    agent_runs::interrupt_run(
        &db,
        "old",
        "owner",
        ActiveStatus::WaitingUser,
        1,
        InterruptReason::AppShutdown,
    )
    .expect("interrupt");
    assert_eq!(
        agent_runs::start_run(&db, &start("blocked", "s", "owner"))
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_UNFINISHED_SESSION_EXISTS"
    );
    assert!(agent_runs::start_superseding_run(
        &db,
        "old",
        "owner",
        2,
        &start("wrong", "other", "owner")
    )
    .is_err());
    assert!(
        agent_runs::start_superseding_run(&db, "old", "owner", 2, &start("old", "s", "owner"))
            .is_err()
    );
    db.with_conn(|conn| {
        let state: (String, String, String) = conn.query_row(
            "SELECT r.status,i.status,i.request FROM agent_runs r
             JOIN agent_run_interactions i USING (run_id) WHERE r.run_id='old'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(
            state,
            ("interrupted".into(), "pending".into(), "Question?".into())
        );
        Ok(())
    })
    .expect("rollback");
    agent_runs::start_superseding_run(&db, "old", "owner", 2, &start("new", "s", "owner"))
        .expect("supersede");
    db.with_conn(|conn| {
        let old: (String, String) = conn.query_row(
            "SELECT status,terminal_reason FROM agent_runs WHERE run_id='old'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let new: String = conn.query_row(
            "SELECT status FROM agent_runs WHERE run_id='new'",
            [],
            |row| row.get(0),
        )?;
        let interaction: String = conn.query_row(
            "SELECT status FROM agent_run_interactions WHERE interaction_id='q'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old, ("discarded".into(), "superseded_by_new_turn".into()));
        assert_eq!(new, "running");
        assert_eq!(interaction, "cancelled");
        Ok(())
    })
    .expect("atomic change");
}

#[test]
fn ledger_and_checkpoint_do_not_change_state_version() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    agent_runs::append_tool_call(&db, "r", "owner", ledger_entry("tool")).expect("ledger");
    agent_runs::write_checkpoint(&db, "r", "owner", 1, &json!({"messages":[]}), "digest")
        .expect("checkpoint");
    assert_eq!(
        agent_runs::write_checkpoint(&db, "r", "owner", 1, &json!({}), "digest")
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_CHECKPOINT_STEP_MISMATCH"
    );
    assert_eq!(
        agent_runs::write_checkpoint(&db, "r", "other", 1, &json!({}), "digest")
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_OWNER_MISMATCH"
    );
    assert_eq!(
        agent_runs::append_tool_call(&db, "r", "owner", ledger_entry("tool"))
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_DUPLICATE_TOOL_CALL_ID"
    );
    agent_runs::append_tool_call(&db, "r", "owner", ledger_entry("other"))
        .expect("second ledger entry");
    db.with_conn(|conn| {
        let (version, step): (i64, i64) = conn.query_row(
            "SELECT version,checkpoint_step FROM agent_runs WHERE run_id='r'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((version, step), (0, 1));
        Ok(())
    })
    .expect("version unchanged");
}

#[test]
fn approval_open_close_and_kind_guards() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["a", "b", "c", "d", "q"]);
    for (id, session) in [("a", "a"), ("b", "b"), ("c", "c"), ("d", "d")] {
        agent_runs::start_run(&db, &start(id, session, "owner")).expect("start");
        agent_runs::open_approval(&db, &approval(id, id, "owner", 0)).expect("open");
        assert_eq!(
            run_state(&db, id),
            ("waiting_approval".into(), 1, "owner".into())
        );
        assert_eq!(
            interaction_state(&db, id),
            ("approval".into(), "pending".into(), None, 0)
        );
    }
    assert!(
        agent_runs::open_approval(&db, &approval("extra", "a", "owner", 0))
            .unwrap_err()
            .to_string()
            .contains("AGENT_RUN_PENDING_INTERACTION_EXISTS")
    );
    assert!(agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "extra",
            run_id: "a",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        }
    )
    .unwrap_err()
    .to_string()
    .contains("AGENT_RUN_PENDING_INTERACTION_EXISTS"));
    assert!(agent_runs::answer_live(&db, "a", "owner", 1, "a", 0, "wrong").is_err());
    agent_runs::decide_approval(&db, "a", "owner", 1, "a", 0, ApprovalDecision::Approved)
        .expect("approved");
    agent_runs::decide_approval(&db, "b", "owner", 1, "b", 0, ApprovalDecision::Rejected)
        .expect("rejected");
    agent_runs::invalidate_approval(
        &db,
        "c",
        "owner",
        1,
        "c",
        0,
        ApprovalInvalidation::Superseded,
    )
    .expect("superseded");
    agent_runs::invalidate_approval(&db, "d", "owner", 1, "d", 0, ApprovalInvalidation::Expired)
        .expect("expired");
    for (id, status, resolution) in [
        ("a", "resolved", Some("approved")),
        ("b", "resolved", Some("rejected")),
        ("c", "superseded", None),
        ("d", "expired", None),
    ] {
        assert_eq!(run_state(&db, id), ("running".into(), 2, "owner".into()));
        assert_eq!(
            interaction_state(&db, id),
            (
                "approval".into(),
                status.into(),
                resolution.map(str::to_string),
                1
            )
        );
    }
    agent_runs::start_run(&db, &start("q", "q", "owner")).expect("question run");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "question",
            run_id: "q",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    assert!(agent_runs::decide_approval(
        &db,
        "q",
        "owner",
        1,
        "question",
        0,
        ApprovalDecision::Approved
    )
    .is_err());
    assert!(agent_runs::invalidate_approval(
        &db,
        "q",
        "owner",
        1,
        "question",
        0,
        ApprovalInvalidation::Expired
    )
    .is_err());
    assert_eq!(
        interaction_state(&db, "question"),
        ("user_question".into(), "pending".into(), None, 0)
    );
}

#[test]
fn approval_interrupt_claim_and_terminal_lifecycle() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["a", "b", "c", "d", "q"]);
    for (id, reason) in [
        ("a", InterruptReason::ApprovalTimeout),
        ("b", InterruptReason::AppShutdown),
    ] {
        agent_runs::start_run(&db, &start(id, id, "old")).expect("start");
        agent_runs::open_approval(&db, &approval(id, id, "old", 0)).expect("open");
        agent_runs::interrupt_run(&db, id, "old", ActiveStatus::WaitingApproval, 1, reason)
            .expect("interrupt");
        assert_eq!(interaction_state(&db, id).1, "pending");
    }
    let answer = ClaimAnswer {
        interaction_id: "a",
        expected_version: 0,
        resolution: "approved",
    };
    assert!(agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "a",
            old_owner: "old",
            new_owner: "new",
            expected_version: 2,
            request_id: "bad",
            gate: ResumeGate::Allowed,
            answer: Some(&answer),
        }
    )
    .unwrap_err()
    .to_string()
    .contains("AGENT_RUN_APPROVAL_ANSWER_NOT_ALLOWED"));
    assert_eq!(run_state(&db, "a"), ("interrupted".into(), 2, "old".into()));
    assert_eq!(interaction_state(&db, "a").1, "pending");
    let claimed = agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "a",
            old_owner: "old",
            new_owner: "new",
            expected_version: 2,
            request_id: "claim-a",
            gate: ResumeGate::Allowed,
            answer: None,
        },
    )
    .expect("claim")
    .expect("allowed");
    assert_eq!(claimed.status, "waiting_approval");
    let replay = agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "a",
            old_owner: "old",
            new_owner: "new",
            expected_version: 2,
            request_id: "claim-a",
            gate: ResumeGate::Allowed,
            answer: None,
        },
    )
    .expect("replay")
    .expect("allowed");
    assert_eq!(replay, claimed);
    agent_runs::decide_approval(&db, "a", "new", 3, "a", 0, ApprovalDecision::Approved)
        .expect("decide after claim");
    agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "b",
            old_owner: "old",
            new_owner: "new",
            expected_version: 2,
            request_id: "claim-b",
            gate: ResumeGate::Allowed,
            answer: None,
        },
    )
    .expect("claim b");
    agent_runs::invalidate_approval(&db, "b", "new", 3, "b", 0, ApprovalInvalidation::Expired)
        .expect("invalidate after claim");
    agent_runs::start_run(&db, &start("q", "q", "old")).expect("question run");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "question",
            run_id: "q",
            owner: "old",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    agent_runs::interrupt_run(
        &db,
        "q",
        "old",
        ActiveStatus::WaitingUser,
        1,
        InterruptReason::QuestionTimeout,
    )
    .expect("interrupt question");
    let wrong_answer = ClaimAnswer {
        interaction_id: "other",
        expected_version: 0,
        resolution: "answer",
    };
    assert!(agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "q",
            old_owner: "old",
            new_owner: "new",
            expected_version: 2,
            request_id: "wrong-question",
            gate: ResumeGate::Allowed,
            answer: Some(&wrong_answer),
        }
    )
    .is_err());
    assert_eq!(run_state(&db, "q"), ("interrupted".into(), 2, "old".into()));
    assert_eq!(interaction_state(&db, "question").1, "pending");
    let result = agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "q",
            old_owner: "old",
            new_owner: "new",
            expected_version: 2,
            request_id: "claim-q",
            gate: ResumeGate::Allowed,
            answer: None,
        },
    )
    .expect("claim question")
    .expect("allowed");
    assert_eq!(result.status, "waiting_user");
    agent_runs::answer_live(&db, "q", "new", 3, "question", 0, "answer")
        .expect("answer after claim");
    for id in ["c", "d"] {
        agent_runs::start_run(&db, &start(id, id, "old")).expect("start terminal");
        agent_runs::open_approval(&db, &approval(id, id, "old", 0)).expect("open terminal");
        agent_runs::interrupt_run(
            &db,
            id,
            "old",
            ActiveStatus::WaitingApproval,
            1,
            InterruptReason::ApprovalTimeout,
        )
        .expect("interrupt terminal");
    }
    agent_runs::discard_run(&db, "c", "old", 2).expect("discard");
    agent_runs::start_superseding_run(&db, "d", "old", 2, &start("replacement", "d", "new"))
        .expect("supersede");
    assert_eq!(interaction_state(&db, "c").1, "cancelled");
    assert_eq!(interaction_state(&db, "d").1, "cancelled");
}

#[test]
fn approval_recovery_and_claim_active_conflict_roll_back() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["a", "b"]);
    agent_runs::start_run(&db, &start("a", "a", "dead")).expect("start a");
    agent_runs::open_approval(&db, &approval("approval", "a", "dead", 0)).expect("open");
    let recovered =
        agent_runs::recover_owner(&db, &temp_workspace(), "dead", None, &[]).expect("recover");
    assert_eq!(
        recovered,
        [RecoveryResult {
            run_id: "a".into(),
            version: 2,
            outcome: RecoveryOutcome::Interrupted,
        }]
    );
    assert_eq!(run_state(&db, "a").0, "interrupted");
    assert_eq!(interaction_state(&db, "approval").1, "pending");
    agent_runs::start_run(&db, &start("b", "b", "dead")).expect("start b");
    agent_runs::interrupt_run(
        &db,
        "b",
        "dead",
        ActiveStatus::Running,
        0,
        InterruptReason::AppShutdown,
    )
    .expect("interrupt b");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET chat_session_id='a' WHERE run_id='b'",
            [],
        )?;
        Ok(())
    })
    .expect("same session setup");
    let answer = ClaimAnswer {
        interaction_id: "missing",
        expected_version: 0,
        resolution: "answer",
    };
    assert!(agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "b",
            old_owner: "dead",
            new_owner: "new",
            expected_version: 1,
            request_id: "answer-without-pending",
            gate: ResumeGate::Allowed,
            answer: Some(&answer),
        }
    )
    .is_err());
    assert_eq!(
        run_state(&db, "b"),
        ("interrupted".into(), 1, "dead".into())
    );
    let result = agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "b",
            old_owner: "dead",
            new_owner: "new",
            expected_version: 1,
            request_id: "claim-b",
            gate: ResumeGate::Allowed,
            answer: None,
        },
    )
    .expect("claim b")
    .expect("allowed");
    assert_eq!(result.status, "running");
    assert!(agent_runs::claim_run(
        &db,
        ClaimRequest {
            run_id: "a",
            old_owner: "dead",
            new_owner: "new",
            expected_version: 2,
            request_id: "claim-a",
            gate: ResumeGate::Allowed,
            answer: None,
        }
    )
    .is_err());
    assert_eq!(
        run_state(&db, "a"),
        ("interrupted".into(), 2, "dead".into())
    );
    assert_eq!(interaction_state(&db, "approval").1, "pending");
}

#[test]
fn tool_call_update_monotonic_and_rejections() {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    let mut entry = ledger_entry("tool");
    entry.main_owned_provenance_id.clear();
    agent_runs::append_tool_call(&db, "r", "owner", entry).expect("append");
    agent_runs::write_checkpoint(&db, "r", "owner", 7, &json!({}), "digest").expect("checkpoint");
    let update_for_owner = |owner, id, provenance, capability, execution| {
        agent_runs::update_tool_call(
            &db,
            ToolCallUpdate {
                run_id: "r",
                owner,
                tool_call_id: id,
                main_owned_provenance_id: provenance,
                capability_state: capability,
                execution_state: execution,
            },
        )
    };
    let update = |id, provenance, capability, execution| {
        update_for_owner("owner", id, provenance, capability, execution)
    };
    assert!(update("missing", None, None, None)
        .unwrap_err()
        .to_string()
        .contains("AGENT_RUN_UNKNOWN_TOOL_CALL_ID"));
    for result in [
        update("tool", None, None, None),
        update("tool", Some(""), None, None),
        update("tool", None, Some(CapabilityState::NotIssued), None),
        update("tool", None, None, Some(ExecutionState::Pending)),
    ] {
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("AGENT_RUN_TOOL_CALL_TRANSITION_INVALID"));
    }
    assert_eq!(
        update_for_owner("other", "tool", Some("id"), None, None)
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_OWNER_MISMATCH"
    );
    update(
        "tool",
        Some("id"),
        Some(CapabilityState::Issued),
        Some(ExecutionState::Committed),
    )
    .expect("update");
    for result in [
        update("tool", Some("other"), None, None),
        update("tool", None, Some(CapabilityState::Issued), None),
        update("tool", None, Some(CapabilityState::AwaitingApproval), None),
        update("tool", None, None, Some(ExecutionState::Failed)),
    ] {
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("AGENT_RUN_TOOL_CALL_TRANSITION_INVALID"));
    }
    db.with_conn(|conn| {
        let (version, step, ledger): (i64, i64, String) = conn.query_row(
            "SELECT version,checkpoint_step,tool_call_ledger FROM agent_runs WHERE run_id='r'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!((version, step), (0, 7));
        let entries: Vec<LedgerEntry> = serde_json::from_str(&ledger)?;
        assert_eq!(entries[0].main_owned_provenance_id, "id");
        assert!(matches!(
            entries[0].capability_state,
            CapabilityState::Issued
        ));
        assert!(matches!(
            entries[0].execution_state,
            ExecutionState::Committed
        ));
        Ok(())
    })
    .expect("unchanged on rejection");
    agent_runs::begin_finalizing(
        &db,
        "r",
        "owner",
        ActiveStatus::Running,
        0,
        TerminalOutcome::Completed,
        "assistant",
    )
    .expect("finalize");
    agent_runs::finish_finalizing(&db, "r", "owner", 1).expect("finish");
    assert_eq!(
        update("tool", None, Some(CapabilityState::Consumed), None)
            .unwrap_err()
            .to_string(),
        "AGENT_RUN_TERMINAL"
    );
}

#[test]
fn session_delete_cascades_run_and_interaction() {
    assert_delete_cascades_run_and_interaction("DELETE FROM chat_sessions WHERE id='s'");
}

#[test]
fn project_delete_cascades_run_and_interaction() {
    assert_delete_cascades_run_and_interaction("DELETE FROM projects WHERE id='p'");
}

fn assert_delete_cascades_run_and_interaction(delete: &str) {
    let db = current_schema_memory().expect("schema");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "r",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: "Question?",
        },
    )
    .expect("question");
    db.with_conn(|conn| {
        conn.execute(delete, [])?;
        let runs: i64 = conn.query_row("SELECT count(*) FROM agent_runs", [], |row| row.get(0))?;
        let questions: i64 =
            conn.query_row("SELECT count(*) FROM agent_run_interactions", [], |row| {
                row.get(0)
            })?;
        assert_eq!((runs, questions), (0, 0));
        Ok(())
    })
    .expect("cascade");
}

#[test]
fn typed_reads_project_run_metadata_and_filter_owner_and_finalizing_lists() {
    let db = current_schema_memory().expect("schema");
    let runs = [
        ("running", "live"),
        ("finishing", "finalizing-only"),
        ("waiting_user", "question-only"),
        ("waiting_approval", "approval-only"),
        ("interrupted", "other"),
        ("done", "terminal-only"),
    ];
    seed(&db, &runs.map(|(id, _)| id));
    for (id, owner) in runs {
        agent_runs::start_run(&db, &start(id, id, owner)).expect("start");
    }
    db.with_conn(|conn| {
        for status in ["waiting_user", "waiting_approval"] {
            conn.execute("UPDATE agent_runs SET status=?1 WHERE run_id=?1", [status])?;
        }
        Ok(())
    })
    .expect("set waiting statuses");
    for (id, owner) in [("finishing", "finalizing-only"), ("done", "terminal-only")] {
        agent_runs::begin_finalizing(
            &db,
            id,
            owner,
            ActiveStatus::Running,
            0,
            TerminalOutcome::UserStop,
            "assistant",
        )
        .expect("begin finalizing");
    }
    agent_runs::finish_finalizing(&db, "done", "terminal-only", 1).expect("finish");
    agent_runs::interrupt_run(
        &db,
        "interrupted",
        "other",
        ActiveStatus::Running,
        0,
        InterruptReason::AppShutdown,
    )
    .expect("interrupt");
    agent_runs::mark_not_resumable(
        &db,
        "interrupted",
        "other",
        NotResumableReason::RouteUnsupported,
    )
    .expect("mark");

    assert_eq!(
        agent_runs::list_owners_with_active_runs(&db).expect("list owners"),
        ["approval-only", "finalizing-only", "live", "question-only"]
    );
    assert_eq!(
        agent_runs::list_finalizing(&db).expect("list finalizing"),
        [FinalizingRun {
            run_id: "finishing".into(),
            execution_owner: "finalizing-only".into(),
            target_status: "cancelled".into(),
            target_reason: "user_stop".into(),
            origin_user_message_id: "user-message".into(),
            origin_assistant_message_id: "assistant".into(),
            version: 1,
        }]
    );
    assert_eq!(
        agent_runs::get_run_status(&db, "missing").expect("read missing"),
        None
    );
    assert_eq!(
        agent_runs::get_run_status(&db, "interrupted").expect("read interrupted"),
        Some(RunStatus {
            run_id: "interrupted".into(),
            project_id: "p".into(),
            chat_session_id: "interrupted".into(),
            execution_owner: "other".into(),
            status: "interrupted".into(),
            version: 1,
            resumable: false,
            terminal_reason: None,
            interrupt_reason: Some("app_shutdown".into()),
            not_resumable_reason: Some("route_unsupported".into()),
            resume_block_detail: None,
            finalizing_target_reason: None,
        })
    );
    let done = agent_runs::get_run_status(&db, "done")
        .expect("read done")
        .expect("run");
    assert_eq!(done.terminal_reason.as_deref(), Some("user_stop"));
    assert_eq!(done.finalizing_target_reason.as_deref(), Some("user_stop"));

    for session in [
        "running",
        "finishing",
        "waiting_user",
        "waiting_approval",
        "interrupted",
    ] {
        assert_eq!(
            agent_runs::get_unfinished_run_for_session(&db, session).expect("read by session"),
            agent_runs::get_run_status(&db, session).expect("read by Run ID")
        );
    }
    for session in ["done", "missing"] {
        assert_eq!(
            agent_runs::get_unfinished_run_for_session(&db, session).expect("read by session"),
            None
        );
    }
    agent_runs::start_run(&db, &start("next", "done", "live")).expect("start after terminal Run");
    assert_eq!(
        agent_runs::get_unfinished_run_for_session(&db, "done").expect("read by session"),
        agent_runs::get_run_status(&db, "next").expect("read by Run ID")
    );
}

#[test]
fn recovery_respects_owner_and_finalizing_evidence() {
    let db = current_schema_memory().expect("schema");
    let workspace = temp_workspace();
    seed(&db, &["a", "b", "c", "d", "e", "f"]);
    for (run, session, owner) in [
        ("r1", "a", "dead"),
        ("r2", "b", "live"),
        ("r3", "c", "dead"),
        ("r4", "d", "dead"),
        ("r5", "e", "dead"),
        ("r6", "f", "dead"),
    ] {
        agent_runs::start_run(&db, &start(run, session, owner)).expect("start");
    }
    agent_runs::begin_finalizing(
        &db,
        "r3",
        "dead",
        ActiveStatus::Running,
        0,
        TerminalOutcome::Completed,
        "assistant3",
    )
    .expect("finalizing completed");
    agent_runs::begin_finalizing(
        &db,
        "r4",
        "dead",
        ActiveStatus::Running,
        0,
        TerminalOutcome::UserStop,
        "assistant4",
    )
    .expect("finalizing stop");
    agent_runs::begin_finalizing(
        &db,
        "r5",
        "dead",
        ActiveStatus::Running,
        0,
        TerminalOutcome::Completed,
        "assistant5",
    )
    .expect("finalizing incomplete");
    agent_runs::begin_finalizing(
        &db,
        "r6",
        "dead",
        ActiveStatus::Running,
        0,
        TerminalOutcome::Completed,
        "assistant6",
    )
    .expect("finalizing without evidence");
    let recovered = agent_runs::recover_owner(
        &db,
        &workspace,
        "dead",
        None,
        &[
            FinalizingEvidence {
                run_id: "r3",
                version: 1,
                user_message_complete: true,
                assistant_message_complete: true,
            },
            FinalizingEvidence {
                run_id: "r4",
                version: 1,
                user_message_complete: true,
                assistant_message_complete: false,
            },
            FinalizingEvidence {
                run_id: "r5",
                version: 1,
                user_message_complete: true,
                assistant_message_complete: false,
            },
        ],
    )
    .expect("recover even when one finalizing run lacks evidence");
    assert_eq!(
        recovered,
        [
            RecoveryResult {
                run_id: "r1".into(),
                version: 1,
                outcome: RecoveryOutcome::Interrupted,
            },
            RecoveryResult {
                run_id: "r3".into(),
                version: 2,
                outcome: RecoveryOutcome::Finalized {
                    status: "completed".into(),
                },
            },
            RecoveryResult {
                run_id: "r4".into(),
                version: 1,
                outcome: RecoveryOutcome::NeedsStopMessageReplay,
            },
            RecoveryResult {
                run_id: "r5".into(),
                version: 2,
                outcome: RecoveryOutcome::Interrupted,
            },
            RecoveryResult {
                run_id: "r6".into(),
                version: 1,
                outcome: RecoveryOutcome::Skipped {
                    reason: "AGENT_RUN_FINALIZING_EVIDENCE_MISSING",
                },
            },
        ]
    );
    db.with_conn(|conn| {
        for (run, expected) in [
            ("r1", "interrupted"),
            ("r2", "running"),
            ("r3", "completed"),
            ("r4", "finalizing"),
            ("r5", "interrupted"),
            ("r6", "finalizing"),
        ] {
            let status: String = conn.query_row(
                "SELECT status FROM agent_runs WHERE run_id=?1",
                [run],
                |row| row.get(0),
            )?;
            assert_eq!(status, expected);
        }
        Ok(())
    })
    .expect("statuses");

    let stale_evidence = FinalizingEvidence {
        run_id: "r6",
        version: 0,
        user_message_complete: true,
        assistant_message_complete: true,
    };
    let retried = agent_runs::recover_owner(&db, &workspace, "dead", None, &[stale_evidence])
        .expect("retry with stale evidence");
    assert_eq!(
        retried,
        [
            RecoveryResult {
                run_id: "r4".into(),
                version: 1,
                outcome: RecoveryOutcome::Skipped {
                    reason: "AGENT_RUN_FINALIZING_EVIDENCE_MISSING"
                },
            },
            RecoveryResult {
                run_id: "r6".into(),
                version: 1,
                outcome: RecoveryOutcome::Skipped {
                    reason: "AGENT_RUN_FINALIZING_EVIDENCE_MISSING"
                },
            },
        ]
    );
}

#[test]
fn owner_recovery_respects_lock_and_optional_activity_age() {
    let db = current_schema_memory().expect("schema");
    let workspace = temp_workspace();
    let holder = agent_runs::try_lock_owner(&workspace, "owner").expect("live owner's lock");
    seed(&db, &["old", "recent"]);
    for id in ["old", "recent"] {
        agent_runs::start_run(&db, &start(id, id, "owner")).expect("start");
    }
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET activity_at=datetime('now','-25 hours') WHERE run_id='old'",
            [],
        )?;
        Ok(())
    })
    .expect("age old run");
    assert!(
        agent_runs::recover_owner(&db, &workspace, "owner", None, &[])
            .expect("busy owner lock")
            .is_empty()
    );
    assert_eq!(run_state(&db, "old"), ("running".into(), 0, "owner".into()));
    assert_eq!(
        run_state(&db, "recent"),
        ("running".into(), 0, "owner".into())
    );
    drop(holder);

    assert_eq!(
        agent_runs::recover_owner(&db, &workspace, "owner", Some(86_400), &[])
            .expect("recover only old run"),
        [RecoveryResult {
            run_id: "old".into(),
            version: 1,
            outcome: RecoveryOutcome::Interrupted
        }]
    );
    assert_eq!(
        agent_runs::recover_owner(&db, &workspace, "owner", None, &[])
            .expect("recover without age threshold"),
        [RecoveryResult {
            run_id: "recent".into(),
            version: 1,
            outcome: RecoveryOutcome::Interrupted
        }]
    );
    assert!(agent_runs::try_lock_owner(&workspace, "owner").is_ok());
}

#[test]
fn live_finalizing_recovery_checks_version_and_applies_message_evidence() {
    let db = current_schema_memory().expect("schema");
    let workspace = temp_workspace();
    let _live_lock = agent_runs::try_lock_owner(&workspace, "owner").expect("live owner's lock");
    seed(&db, &["complete", "incomplete", "stop"]);
    for (id, target, assistant_complete, expected_status, expected_version, expected_outcome) in [
        (
            "complete",
            TerminalOutcome::Completed,
            true,
            "completed",
            2,
            RecoveryOutcome::Finalized {
                status: "completed".into(),
            },
        ),
        (
            "incomplete",
            TerminalOutcome::Completed,
            false,
            "interrupted",
            2,
            RecoveryOutcome::Interrupted,
        ),
        (
            "stop",
            TerminalOutcome::UserStop,
            false,
            "finalizing",
            1,
            RecoveryOutcome::NeedsStopMessageReplay,
        ),
    ] {
        agent_runs::start_run(&db, &start(id, id, "owner")).expect("start");
        agent_runs::begin_finalizing(
            &db,
            id,
            "owner",
            ActiveStatus::Running,
            0,
            target,
            "assistant",
        )
        .expect("begin finalizing");
        let mut evidence = FinalizingEvidence {
            run_id: id,
            version: 0,
            user_message_complete: true,
            assistant_message_complete: assistant_complete,
        };
        assert_eq!(
            agent_runs::recover_finalizing(&db, "owner", &evidence)
                .unwrap_err()
                .to_string(),
            "AGENT_RUN_VERSION_OR_STATUS_MISMATCH"
        );
        assert_eq!(run_state(&db, id), ("finalizing".into(), 1, "owner".into()));
        evidence.version = 1;
        assert_eq!(
            agent_runs::recover_finalizing(&db, "owner", &evidence).expect("recover finalizing"),
            RecoveryResult {
                run_id: id.into(),
                version: expected_version,
                outcome: expected_outcome
            }
        );
        let state = agent_runs::get_run_status(&db, id)
            .expect("read")
            .expect("run");
        assert_eq!(state.status, expected_status);
        assert_eq!(state.version, expected_version);
        assert!(state.resumable);
        if expected_status == "interrupted" {
            assert_eq!(state.interrupt_reason.as_deref(), Some("renderer_lost"));
        }
    }
}

const SNAPSHOT_BODY_MARKERS: [&str; 5] = [
    "a3-copy-checkpoint-marker",
    "a3-copy-ledger-marker",
    "a3-copy-request-marker",
    "a3-copy-resolution-marker",
    "a3-copy-target-basis-marker",
];

pub(crate) fn seed_snapshot_contents(path: &Path) -> Database {
    let db = Database::new(path).expect("db");
    db.migrate().expect("migrate");
    seed(&db, &["s"]);
    agent_runs::start_run(&db, &start("r", "s", "owner")).expect("start");
    let ledger = LedgerEntry {
        canonical_args: json!({"body": SNAPSHOT_BODY_MARKERS[1]}),
        ..ledger_entry("tool")
    };
    agent_runs::append_tool_call(&db, "r", "owner", ledger).expect("ledger");
    agent_runs::write_checkpoint(
        &db,
        "r",
        "owner",
        2,
        &json!({"body": SNAPSHOT_BODY_MARKERS[0]}),
        "digest",
    )
    .expect("checkpoint");
    agent_runs::open_user_question(
        &db,
        &OpenQuestion {
            interaction_id: "q",
            run_id: "r",
            owner: "owner",
            expected_version: 0,
            tool_call_id: "tool",
            args_digest: "digest",
            request: SNAPSHOT_BODY_MARKERS[2],
        },
    )
    .expect("question");
    agent_runs::answer_live(&db, "r", "owner", 1, "q", 0, SNAPSHOT_BODY_MARKERS[3])
        .expect("answer");
    let basis = [target_basis_entry(AnalysisReadBasisRevision::Version(
        SNAPSHOT_BODY_MARKERS[4].into(),
    ))];
    agent_runs::open_approval(
        &db,
        &OpenApproval {
            target_basis: Some(&basis),
            ..approval("a", "r", "owner", 2)
        },
    )
    .expect("approval");
    agent_runs::decide_approval(&db, "r", "owner", 3, "a", 0, ApprovalDecision::Approved)
        .expect("decide approval");
    db
}

pub(crate) fn assert_snapshot_body_bytes(path: &Path, present: bool) {
    let bytes = std::fs::read(path).expect("read snapshot bytes");
    for marker in SNAPSHOT_BODY_MARKERS {
        assert_eq!(
            bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes()),
            present,
            "unexpected presence of {marker} in {}",
            path.display()
        );
    }
}

pub(crate) fn assert_scrubbed_snapshot(path: &Path) {
    let conn = Connection::open(path).expect("read copy");
    let row: (String, Option<String>, i64, Option<String>, bool) = conn
        .query_row(
            "SELECT status,interrupt_reason,resumable,not_resumable_reason,
                checkpoint IS NULL AND checkpoint_step=0 AND checkpoint_digest IS NULL
                    AND tool_call_ledger='[]'
           FROM agent_runs WHERE run_id='r'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("run");
    assert_eq!(
        row,
        (
            "interrupted".into(),
            Some("copied_snapshot".into()),
            0,
            Some("restored_from_copy".into()),
            true,
        )
    );
    for id in ["q", "a"] {
        let interaction: (String, String, Option<String>) = conn
            .query_row(
                "SELECT request,resolution,target_basis FROM agent_run_interactions WHERE interaction_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("interaction");
        assert_eq!(interaction, (String::new(), String::new(), None));
    }
    assert_snapshot_body_bytes(path, false);
}

#[test]
fn snapshot_scrub_empties_content_and_interrupts_nonterminal() {
    let dir = temp_workspace();
    let path = dir.join("copy.db");
    drop(seed_snapshot_contents(&path));
    assert_snapshot_body_bytes(&path, true);
    agent_runs::scrub_snapshot_copy(&path).expect("scrub isolated copy");
    assert_scrubbed_snapshot(&path);

    let scrubbed = std::fs::read(&path).expect("first scrub bytes");
    agent_runs::scrub_snapshot_copy(&path).expect("repeat scrub");
    assert!(
        std::fs::read(&path).expect("repeat scrub bytes") == scrubbed,
        "repeat scrub rewrote the SQLite image"
    );
    std::fs::remove_dir_all(dir).expect("clean snapshot fixture");
}

#[test]
fn snapshot_scrub_skips_vacuum_without_agent_run_changes() {
    let dir = temp_workspace();
    let old = dir.join("old.db");
    Connection::open(&old)
        .expect("old db")
        .execute_batch("CREATE TABLE legacy (body TEXT); INSERT INTO legacy VALUES ('keep');")
        .expect("old schema");
    let empty = dir.join("empty.db");
    Database::new(&empty)
        .expect("empty db")
        .migrate()
        .expect("migrate");

    for path in [old, empty] {
        let before = std::fs::read(&path).expect("read before scrub");
        agent_runs::scrub_snapshot_copy(&path).expect("scrub without changes");
        assert!(
            std::fs::read(&path).expect("read after scrub") == before,
            "scrub with no changed rows rewrote {}",
            path.display()
        );
    }
    std::fs::remove_dir_all(dir).expect("clean snapshot fixtures");
}

#[test]
fn agent_runs_backup_scrubs_copy() {
    let dir = temp_workspace();
    let db = seed_snapshot_contents(&dir.join("live.db"));
    let backup = dir.join("backup.db");
    db.backup_to(&backup).expect("backup");
    assert_scrubbed_snapshot(&backup);
    assert_eq!(run_state(&db, "r").0, "running");
    drop(db);
    std::fs::remove_dir_all(dir).expect("clean backup fixture");
}

#[test]
fn agent_runs_backup_removes_copy_on_scrub_failure() {
    let dir = temp_workspace();
    let path = dir.join("live.db");
    let db = seed_snapshot_contents(&path);
    db.with_conn(|conn| Ok(conn.execute_batch("DROP TABLE agent_run_interactions")?))
        .expect("break scrub schema");
    let backup = dir.join("backup.db");
    let error = db.backup_to(&backup).expect_err("scrub must fail");
    assert!(
        error.to_string().contains("agent_run_interactions"),
        "{error:#}"
    );
    assert!(!backup.exists());
    assert!(!dir.join("backup.db.sqlite.tmp").exists());
    drop(db);
    std::fs::remove_dir_all(dir).expect("clean failed backup fixture");
}

#[test]
fn owner_lock_blocks_second_holder_and_releases_on_drop() {
    let dir = temp_workspace();
    let first = agent_runs::try_lock_owner(&dir, "owner-1").expect("first lock");
    assert!(agent_runs::try_lock_owner(&dir, "owner-1").is_err());
    assert!(!agent_runs::owner_lock_is_available(&dir, "owner-1").expect("probe live"));
    drop(first);
    assert!(agent_runs::owner_lock_is_available(&dir, "owner-1").expect("probe dead"));
    assert!(agent_runs::try_lock_owner(&dir, "owner-1").is_ok());
    assert!(agent_runs::try_lock_owner(Path::new("."), "../escape").is_err());
}

#[test]
fn schema_50_upgrades_49_and_installs_write_clock_triggers() {
    let db = current_schema_memory().expect("current schema");
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE agent_run_interactions;
             DROP TABLE agent_runs;
             PRAGMA user_version = 49;",
        )?;
        Ok(())
    })
    .expect("prepare schema 49");
    db.migrate().expect("upgrade to 50");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, 50);
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        for table in ["agent_runs", "agent_run_interactions"] {
            let triggers: i64 = conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1
                   AND name LIKE 'grimodex_clock_%'",
                [table],
                |row| row.get(0),
            )?;
            assert_eq!(
                triggers, 3,
                "{table} needs insert/update/delete write clocks"
            );
        }
        Ok(())
    })
    .expect("verify migration");
}

#[test]
fn schema_checkpoint_requires_agent_run_lookup_indexes() {
    use grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants;

    let db = current_schema_memory().expect("schema");
    db.with_conn(|conn| {
        for index in [
            "idx_agent_runs_chat_session_id",
            "idx_agent_runs_project_id",
            "idx_agent_run_interactions_run_id",
        ] {
            conn.execute_batch(&format!("SAVEPOINT missing_index; DROP INDEX {index};"))?;
            assert!(
                !has_current_schema_checkpoint_invariants(conn)?,
                "expected missing index {index} to invalidate the checkpoint"
            );
            conn.execute_batch("ROLLBACK TO missing_index; RELEASE missing_index;")?;
        }
        assert!(has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("verify AgentRun lookup index invariants");
}
