//! HC1-1 (K4/3 section 6): the history snapshot reader's enumeration,
//! capture and ordinal-0 reads, and the exclusion of legacy and
//! unknown-version bindings. Fixtures for the order and count cases insert
//! attempt rows with chosen ids and times through the storage row writer
//! (`insert_attempt_in_tx`); the product writer derives ids from captures.
use super::history_context::testing::{sample_context, sample_identity};
use super::history_context::HistoryContextGateReason;
use super::history_reads::{
    GenerationHistoryAttempt, GenerationHistoryAttemptHeader, HistoryHeaderBinding,
};
use super::*;

const OTHER_SESSION: &str = "hc1-other-session";
const OTHER_PROJECT: &str = "hc1-other-project";
const OTHER_PROJECT_SESSION: &str = "hc1-other-project-session";

fn add_session(db: &Database, project: &str, session: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO projects(id,title) VALUES (?1,'Other')",
            [project],
        )?;
        conn.execute(
            "INSERT INTO chat_sessions(id,project_id,node_id) VALUES (?1,?2,NULL)",
            params![session, project],
        )?;
        Ok(())
    })
    .expect("session");
}

/// Insert one attempt row with a chosen id and time. The slot is the null
/// slot of test-support, which the history gate treats as `Missing`.
fn insert_row(
    db: &Database,
    id: &str,
    created_at_ms: i64,
    project: &str,
    session: &str,
    inputs: Vec<InputReference>,
) {
    let mut new = request(inputs, vec![]);
    new.binding.project_id = project.into();
    new.binding.chat_session_id = session.into();
    new.created_at_ms = created_at_ms;
    new.expires_at_ms = created_at_ms + 9_000;
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            insert_attempt_in_tx(conn, id, &new, true).map(|_| ())
        })
    })
    .expect("attempt row");
}

fn stored_json(db: &Database, id: &str) -> Value {
    let json: String = db
        .with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                [id],
                |row| row.get(0),
            )?)
        })
        .expect("binding_json");
    serde_json::from_str(&json).expect("binding JSON")
}

/// Give a row a context of the known version, as the product writer does.
fn make_known(db: &Database, id: &str) {
    let mut value = stored_json(db, id);
    value["historyTurnContext"] =
        binding_value(&HistoryContextSlot::Context(Box::new(sample_context())));
    value["durableWorkspaceIdentity"] = binding_value(&sample_identity());
    store_binding_json(db, id, &canonical_binding(&value));
}

fn make_legacy(db: &Database, id: &str) {
    store_binding_json(
        db,
        id,
        &canonical_binding(&binding_value(&legacy_v1_binding())),
    );
}

fn corrupt_reference_rows(db: &Database, id: &str) {
    db.with_conn(|conn| {
        for table in [
            "nir1_generation_input_refs",
            "nir1_generation_qualification_refs",
        ] {
            conn.execute(
                &format!(
                    "UPDATE {table} SET reference_json='{{\"unreadable\":true}}'
                     WHERE attempt_id=?1"
                ),
                [id],
            )?;
        }
        Ok(())
    })
    .expect("corrupt the reference rows");
}

fn budget_for_reads() -> GenerationHistoryReadBudget {
    history_read_budget(Some(history_sql_budget(10_000_000)))
}

fn ids(headers: &[GenerationHistoryAttemptHeader]) -> Vec<&str> {
    headers.iter().map(|header| header.id.as_str()).collect()
}

fn list(
    db: &Database,
    caller_budget: &mut GenerationHistoryReadBudget,
    project: &str,
    session: &str,
) -> Result<Vec<GenerationHistoryAttemptHeader>> {
    with_snapshot(db, caller_budget, |reader, budget| {
        Ok(reader
            .list_session_attempts(budget, project, session)?
            .to_vec())
    })
}

#[test]
fn history_enumeration_lists_only_the_session_attempts_in_the_total_order() {
    let db = database(Path::new(":memory:"));
    // A chat session ID is globally unique, so another project's attempts
    // sit under another session ID.
    add_session(&db, OTHER_PROJECT, OTHER_PROJECT_SESSION);
    add_session(&db, "generation-project", OTHER_SESSION);
    let session = "generation-session";
    let project = "generation-project";
    // Inserted out of order. The two rows at 3_000 tie on time: the smaller
    // id bytes come first. Upper case sorts before lower case in bytes.
    insert_row(&db, "b-old", 1_000, project, session, vec![]);
    insert_row(&db, "tie-b", 3_000, project, session, vec![]);
    insert_row(&db, "newest", 4_000, project, session, vec![]);
    insert_row(&db, "tie-a", 3_000, project, session, vec![]);
    insert_row(&db, "Tie-Z", 3_000, project, session, vec![]);
    insert_row(&db, "a-old", 1_000, project, session, vec![]);
    insert_row(
        &db,
        "other-session-new",
        9_000,
        project,
        OTHER_SESSION,
        vec![],
    );
    insert_row(
        &db,
        "other-project-new",
        9_500,
        OTHER_PROJECT,
        OTHER_PROJECT_SESSION,
        vec![],
    );

    let mut caller_budget = budget_for_reads();
    let headers = list(&db, &mut caller_budget, project, session).expect("enumeration");
    assert_eq!(
        ids(&headers),
        ["newest", "Tie-Z", "tie-a", "tie-b", "a-old", "b-old"]
    );
    for header in &headers {
        assert_eq!(header.project_id, project);
        assert_eq!(header.chat_session_id, session);
    }
    // A null slot is a closed gate reason, never a known context.
    assert_eq!(
        headers[0].binding,
        HistoryHeaderBinding::Current {
            scene_id: GENERATION_SCENE_ID.into(),
            scene_incarnation_id: GENERATION_SCENE_INCARNATION.into(),
            purpose: GenerationPurpose::Writing,
            gate: Some(HistoryContextGateReason::Missing),
        }
    );
    assert_eq!(headers[0].created_at_ms, 4_000);

    let mut other = budget_for_reads();
    let others = list(&db, &mut other, project, OTHER_SESSION).expect("other session");
    assert_eq!(ids(&others), ["other-session-new"]);
    let mut other_project = budget_for_reads();
    let others = list(
        &db,
        &mut other_project,
        OTHER_PROJECT,
        OTHER_PROJECT_SESSION,
    )
    .expect("other project");
    assert_eq!(ids(&others), ["other-project-new"]);
    // The project is part of the key: the same session under the wrong project
    // lists nothing.
    let mut wrong_project = budget_for_reads();
    assert!(
        list(&db, &mut wrong_project, project, OTHER_PROJECT_SESSION)
            .expect("wrong project")
            .is_empty()
    );
}

#[test]
fn history_enumeration_ignores_caller_session_and_renderer_selection() {
    let db = database(Path::new(":memory:"));
    add_session(&db, "generation-project", OTHER_SESSION);
    let (project, session) = ("generation-project", "generation-session");
    // The caller's process-local session is a different field of the binding.
    // It may name any string, including another chat session, and the
    // enumeration still goes by the chat session column alone.
    for (id, caller_session, at) in [
        ("caller-a", "main-caller-session", 1_000),
        ("caller-b", OTHER_SESSION, 2_000),
        ("caller-c", "a-caller-session-nobody-knows", 3_000),
    ] {
        let mut new = request(vec![], vec![]);
        new.binding.caller.caller_session_id = caller_session.into();
        new.created_at_ms = at;
        new.expires_at_ms = at + 9_000;
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                insert_attempt_in_tx(conn, id, &new, true).map(|_| ())
            })
        })
        .expect("attempt row");
    }
    insert_row(&db, "elsewhere", 4_000, project, OTHER_SESSION, vec![]);
    let mut caller_budget = budget_for_reads();
    let headers = list(&db, &mut caller_budget, project, session).expect("enumeration");
    assert_eq!(ids(&headers), ["caller-c", "caller-b", "caller-a"]);
    let mut other = budget_for_reads();
    assert_eq!(
        ids(&list(&db, &mut other, project, OTHER_SESSION).expect("other")),
        ["elsewhere"]
    );
}

#[test]
fn history_enumeration_rejects_over_limit_before_materializing() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    for (index, id) in ["one", "two", "three"].into_iter().enumerate() {
        insert_row(&db, id, 1_000 + index as i64, project, session, vec![]);
    }
    // A row that cannot be parsed: reaching it would be a binding error, so
    // a limit error proves nothing was materialized.
    store_binding_json(&db, "one", r#"{"bindingVersion":2,"bogus":true}"#);

    let mut exact = budget_for_reads();
    exact.max_attempts = 3;
    exact.max_candidates = 3;
    let error = list(&db, &mut exact, project, session).expect_err("the broken row is read");
    assert!(
        format!("{error:#}").contains("NIR1_GENERATION_BINDING_INVALID"),
        "N rows are admitted and materialized: {error:#}"
    );
    assert_eq!(exact.max_attempts, 0, "the admitted count was debited");

    let mut candidates = budget_for_reads();
    candidates.max_attempts = 3;
    candidates.max_candidates = 2;
    assert_error_code(
        list(&db, &mut candidates, project, session),
        "NIR1_GENERATION_HISTORY_CANDIDATE_LIMIT",
    );
    assert_eq!(candidates.max_attempts, 3, "a refused count debits nothing");

    let mut attempts = budget_for_reads();
    attempts.max_attempts = 2;
    attempts.max_candidates = 3;
    assert_error_code(
        list(&db, &mut attempts, project, session),
        "NIR1_GENERATION_HISTORY_LIMIT",
    );
    assert_eq!(attempts.max_attempts, 2);

    // The same sessions pass once the broken row is repaired: the limits are
    // the only thing that refused them.
    store_binding_json(&db, "one", &canonical_binding(&binding_value(&binding())));
    let mut ok = budget_for_reads();
    ok.max_attempts = 3;
    ok.max_candidates = 3;
    assert_eq!(
        list(&db, &mut ok, project, session).expect("N rows").len(),
        3
    );
}

#[test]
fn history_enumeration_debits_the_shared_ledger_once_per_turn() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    for (index, id) in ["e1", "e2", "e3"].into_iter().enumerate() {
        insert_row(&db, id, 1_000 + index as i64, project, session, vec![]);
    }
    let mut caller_budget = budget_for_reads();
    let attempts_before = caller_budget.max_attempts;
    let candidates_before = caller_budget.max_candidates;
    let observed = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        let first = reader.list_session_attempts(budget, project, session)?;
        let after_first = (budget.max_attempts, reader_steps(budget));
        let second = reader.list_session_attempts(budget, project, session)?;
        assert!(Arc::ptr_eq(&first, &second), "the second call is cached");
        Ok((after_first, (budget.max_attempts, reader_steps(budget))))
    })
    .expect("two calls in one snapshot");
    assert_eq!(observed.0 .0, attempts_before - 3, "debited once, by count");
    assert!(observed.0 .1 > 0, "the SQL ledger counted the reads");
    assert_eq!(observed.1, observed.0, "a repeat costs nothing");
    assert_eq!(caller_budget.max_candidates, candidates_before);
    // The ledger belongs to the caller: a second snapshot of the same turn
    // does not get the allowance back.
    let before_second_snapshot = caller_budget.max_attempts;
    list(&db, &mut caller_budget, project, session).expect("second snapshot");
    assert_eq!(
        caller_budget.max_attempts,
        before_second_snapshot - 3,
        "a new snapshot reader has no cache, so it pays again from the same ledger"
    );
}

fn reader_steps(budget: &GenerationHistoryReadBudget) -> u64 {
    budget.sql.as_ref().expect("sql ledger").sql_steps_used()
}

#[test]
fn history_legacy_v1_binding_is_excluded_not_a_snapshot_failure() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    let human_version = human(&db, "hc1-legacy-human", "legacy turn");
    let legacy_human = human(&db, "hc1-known-human", "known turn");
    insert_row(
        &db,
        "legacy",
        2_000,
        project,
        session,
        vec![message_input(&human_version)],
    );
    make_legacy(&db, "legacy");
    corrupt_reference_rows(&db, "legacy");
    insert_row(
        &db,
        "known",
        1_000,
        project,
        session,
        vec![message_input(&legacy_human)],
    );
    make_known(&db, "known");

    let mut caller_budget = history_budget();
    // No reference may be admitted for the excluded row: a zero reference
    // budget refuses any read of its rows, and its rows are unreadable.
    caller_budget.max_reference_count = 0;
    caller_budget.max_reference_bytes = 0;
    caller_budget.max_resolved_body_bytes = 0;
    let before = (
        caller_budget.max_resolved_body_bytes,
        caller_budget.remaining_nodes,
        caller_budget.remaining_edges,
        caller_budget.remaining_qualification_refs,
    );
    let attempts_before = caller_budget.max_attempts;
    let read = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        reader.read_attempt(budget, "legacy")
    })
    .expect("a legacy binding is excluded, not a snapshot failure");
    match &read {
        GenerationHistoryAttempt::Excluded(excluded) => {
            assert_eq!(excluded.reason, HistoryContextGateReason::LegacyBinding);
            assert_eq!(excluded.id, "legacy");
            assert_eq!(excluded.project_id, project);
            assert_eq!(excluded.chat_session_id, session);
            assert_eq!(excluded.created_at_ms, 2_000);
        }
        GenerationHistoryAttempt::Stored(_) => panic!("a legacy row must not be stored"),
    }
    assert_eq!(
        read.history_gate(),
        Some(HistoryContextGateReason::LegacyBinding)
    );
    assert_eq!(caller_budget.max_attempts, attempts_before - 1);
    assert_eq!(
        (
            caller_budget.max_resolved_body_bytes,
            caller_budget.remaining_nodes,
            caller_budget.remaining_edges,
            caller_budget.remaining_qualification_refs,
        ),
        before,
        "an excluded row debits the attempt only"
    );

    // In one snapshot the other candidate is still readable, the enumeration
    // names the legacy row with its closed reason, and the legacy row does
    // not count as holding its Human at ordinal 0 (its rows were not read).
    let mut shared = budget_for_reads();
    let (headers, known_read, legacy_count, known_count) =
        with_snapshot(&db, &mut shared, |reader, budget| {
            let headers = reader.list_session_attempts(budget, project, session)?;
            let known = reader.read_attempt(budget, "known")?;
            let legacy_count =
                reader.ordinal_zero_attempts(budget, project, session, &human_version.id)?;
            let known_count =
                reader.ordinal_zero_attempts(budget, project, session, &legacy_human.id)?;
            Ok((headers, known, legacy_count, known_count))
        })
        .expect("a session with a legacy row reads");
    assert_eq!(ids(&headers), ["legacy", "known"]);
    assert_eq!(
        headers[0].binding,
        HistoryHeaderBinding::Excluded(HistoryContextGateReason::LegacyBinding)
    );
    assert_eq!(headers[1].gate(), None);
    assert!(known_read.history_gate().is_none());
    assert_eq!(known_read.into_stored().expect("stored").inputs.len(), 1);
    // The legacy row's ordinal 0 row is unreadable here, so it cannot be
    // counted: the session is ambiguous rather than the count being exact.
    assert_eq!(legacy_count.count(), 0);
    assert!(legacy_count.is_ambiguous());
    assert_eq!(known_count.attempt_ids(), ["known"]);
}

#[test]
fn history_unsupported_binding_version_is_excluded_with_a_closed_reason() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    let human_version = human(&db, "hc1-future-human", "future turn");
    insert_row(
        &db,
        "future",
        2_000,
        project,
        session,
        vec![message_input(&human_version)],
    );
    let mut future = stored_json(&db, "future");
    future["bindingVersion"] = json!(3);
    future["historyTurnContext"] = json!({"turn": "a later writer"});
    store_binding_json(&db, "future", &canonical_binding(&future));
    corrupt_reference_rows(&db, "future");
    // A twin without the unreadable rows, for the readers that read rows
    // before the binding.
    insert_row(&db, "future-clean", 1_000, project, session, vec![]);
    let mut clean = stored_json(&db, "future-clean");
    clean["bindingVersion"] = json!(3);
    store_binding_json(&db, "future-clean", &canonical_binding(&clean));

    let mut caller_budget = history_budget();
    caller_budget.max_reference_count = 0;
    let read = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        reader.read_attempt(budget, "future")
    })
    .expect("an unknown binding version is excluded, not a snapshot failure");
    assert_eq!(
        read.history_gate(),
        Some(HistoryContextGateReason::UnsupportedBindingVersion)
    );
    assert_eq!(read.id(), "future");

    let mut listing = budget_for_reads();
    let headers = list(&db, &mut listing, project, session).expect("enumeration");
    assert_eq!(
        headers[0].binding,
        HistoryHeaderBinding::Excluded(HistoryContextGateReason::UnsupportedBindingVersion)
    );
    // Every other reader keeps refusing the row, with the same code as before.
    assert_error_code(
        read_attempt(&db, "future-clean", budget()),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
    assert_error_code(
        claim_attempt(&db, "future-clean", &binding(), 1_500, budget()),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
    assert_error_code(
        recover_attempt(&db, "future-clean", 2_000),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
}

/// K4/3 section 6: a row of an unknown binding version that has a terminal
/// has no usable receipt for the history reader. The strict readers keep
/// refusing it, and a known or legacy row keeps its receipt.
#[test]
fn history_terminal_of_an_unknown_binding_version_is_no_receipt_not_a_snapshot_failure() {
    let db = database(Path::new(":memory:"));
    let future = create_attempt(&db, request(vec![], vec![])).expect("future");
    finish_success(&db, &future, "hc1-future-message", "answer");
    let known = create_attempt(&db, request(vec![], vec![])).expect("known");
    let known_terminal = finish_success(&db, &known, "hc1-known-message", "answer");
    let legacy = create_attempt(&db, request(vec![], vec![])).expect("legacy");
    let legacy_terminal = finish_success(&db, &legacy, "hc1-legacy-message", "answer");
    let mut stored = stored_json(&db, &future.id);
    stored["bindingVersion"] = json!(3);
    store_binding_json(&db, &future.id, &canonical_binding(&stored));
    make_legacy(&db, &legacy.id);

    let mut caller_budget = history_budget();
    let (future_read, known_read, legacy_read) =
        with_snapshot(&db, &mut caller_budget, |reader, budget| {
            Ok((
                reader.read_terminal(budget, &future.id)?,
                reader.read_terminal(budget, &known.id)?,
                reader.read_terminal(budget, &legacy.id)?,
            ))
        })
        .expect("an unknown binding version is no receipt, not a snapshot failure");
    assert_eq!(future_read, None);
    assert_eq!(known_read, Some(known_terminal));
    assert_eq!(legacy_read, Some(legacy_terminal));
    // The strict readers keep their refusal with the same code.
    assert_error_code(
        read_terminal(&db, &future.id),
        "NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED",
    );
    // A malformed terminal of a known row still fails the read.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts SET terminal_digest=?2 WHERE id=?1",
            params![known.id, test_digest("tampered")],
        )?;
        Ok(())
    })
    .expect("tamper");
    let mut caller_budget = history_budget();
    assert!(with_snapshot(&db, &mut caller_budget, |reader, budget| {
        reader.read_terminal(budget, &known.id)
    })
    .is_err());
}

/// The enumeration reads `session_id` and uses only the session index: no
/// project-wide scan and no scan of `binding_json`.
#[test]
fn history_enumeration_statements_search_the_session_index() {
    let db = database(Path::new(":memory:"));
    let plans = db
        .with_read_transaction(|conn| {
            let mut plans = Vec::new();
            for sql in [
                "SELECT 1 FROM nir1_generation_attempts
                 WHERE project_id=?1 AND session_id=?2 LIMIT ?3",
                "SELECT rowid,octet_length(id),octet_length(binding_json),created_at_ms
                 FROM nir1_generation_attempts
                 WHERE project_id=?1 AND session_id=?2
                 ORDER BY created_at_ms DESC, id ASC LIMIT ?3",
            ] {
                let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let details = statement
                    .query_map(params!["p", "s", 3], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                plans.push(details);
            }
            Ok(plans)
        })
        .expect("query plans");
    for details in plans {
        assert!(
            details.iter().any(|detail| detail
                .starts_with("SEARCH nir1_generation_attempts USING")
                && detail.contains("idx_nir1_generation_attempts_session")),
            "{details:?}"
        );
        assert!(
            !details
                .iter()
                .any(|detail| detail.starts_with("SCAN nir1_generation_attempts")),
            "{details:?}"
        );
    }
}

#[test]
fn history_malformed_binding_still_aborts_the_whole_read() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    insert_row(&db, "good", 1_000, project, session, vec![]);
    insert_row(&db, "bad", 2_000, project, session, vec![]);
    let malformed = [
        // Valid JSON, wrong shape: an unknown field of a version 2 binding,
        // a version 2 binding without its Scene, a legacy binding with an
        // unknown field.
        r#"{"bindingVersion":2,"bogus":true}"#.to_owned(),
        {
            let mut value = stored_json(&db, "good");
            value.as_object_mut().expect("object").remove("scene");
            canonical_binding(&value)
        },
        {
            let mut value = binding_value(&legacy_v1_binding());
            value["unexpected"] = json!(1);
            canonical_binding(&value)
        },
        // A binding that is well formed but is another session's.
        {
            let mut value = stored_json(&db, "good");
            value["chatSessionId"] = json!("somewhere-else");
            canonical_binding(&value)
        },
    ];
    for (index, raw) in malformed.iter().enumerate() {
        store_binding_json(&db, "bad", raw);
        let mut caller_budget = history_budget();
        assert!(
            with_snapshot(&db, &mut caller_budget, |reader, budget| {
                reader.read_attempt(budget, "bad").map(|_| ())
            })
            .is_err(),
            "read_attempt case {index}"
        );
        let mut listing = budget_for_reads();
        assert!(
            list(&db, &mut listing, project, session).is_err(),
            "enumeration case {index}: the good row does not rescue the read"
        );
    }
}

#[test]
fn session_recreated_with_same_id_lists_old_attempts_but_message_versions_are_invalidated() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    let old_human = human(
        &db,
        "hc1-recreated-human",
        "before the session was recreated",
    );
    insert_row(
        &db,
        "old-attempt",
        1_000,
        project,
        session,
        vec![message_input(&old_human)],
    );
    // The attempt row has no foreign key to chat_sessions.
    db.with_conn(|conn| {
        conn.execute("DELETE FROM chat_sessions WHERE id=?1", [session])?;
        conn.execute(
            "INSERT INTO chat_sessions(id,project_id,node_id)
             VALUES (?1,?2,'generation-scene')",
            params![session, project],
        )?;
        Ok(())
    })
    .expect("recreate the session under the same id");

    let mut caller_budget = budget_for_reads();
    let (headers, message_error) = with_snapshot(&db, &mut caller_budget, |reader, budget| {
        let headers = reader.list_session_attempts(budget, project, session)?;
        let message_error = reader
            .read_message(budget, &old_human.id)
            .expect_err("the old Human's version is invalidated");
        Ok((headers, format!("{message_error:#}")))
    })
    .expect("snapshot");
    assert_eq!(ids(&headers), ["old-attempt"], "the old attempt is listed");
    assert!(
        message_error.contains("NIR1_GENERATION_MESSAGE_VERSION_MISSING"),
        "{message_error}"
    );
}

#[test]
fn ordinal_zero_attempt_count_reads_only_listed_attempts() {
    let db = database(Path::new(":memory:"));
    add_session(&db, "generation-project", OTHER_SESSION);
    let (project, session) = ("generation-project", "generation-session");
    let target = human(&db, "hc1-ordinal-target", "the counted Human");
    let lonely = human(&db, "hc1-ordinal-lonely", "no attempt at all");
    let at_position_one = human(&db, "hc1-ordinal-second", "not at ordinal 0");
    let twice = human(&db, "hc1-ordinal-twice", "two attempts");

    // One attempt for the target; the target as ordinal 1 of another does
    // not count; an attempt of another session does not count.
    insert_row(
        &db,
        "t-once",
        5_000,
        project,
        session,
        vec![message_input(&target)],
    );
    make_known(&db, "t-once");
    insert_row(
        &db,
        "t-second-position",
        4_000,
        project,
        session,
        vec![message_input(&at_position_one), message_input(&target)],
    );
    make_known(&db, "t-second-position");
    insert_row(
        &db,
        "t-other-session",
        3_000,
        project,
        OTHER_SESSION,
        vec![message_input(&target)],
    );
    make_known(&db, "t-other-session");
    // A gated attempt whose rows are unreadable cannot be counted; it makes
    // the session ambiguous instead (the review finding of HC1-2: a gated
    // second attempt must never leave an exact count of one).
    insert_row(
        &db,
        "gated",
        2_000,
        project,
        session,
        vec![message_input(&twice)],
    );
    corrupt_reference_rows(&db, "gated");
    insert_row(
        &db,
        "twice-1",
        1_500,
        project,
        session,
        vec![message_input(&twice)],
    );
    make_known(&db, "twice-1");
    insert_row(
        &db,
        "twice-2",
        1_400,
        project,
        session,
        vec![message_input(&twice)],
    );
    make_known(&db, "twice-2");

    let mut caller_budget = budget_for_reads();
    caller_budget.max_attempts = 8;
    caller_budget.max_candidates = 8;
    let references_before = (
        caller_budget.max_reference_count,
        caller_budget.max_reference_bytes,
    );
    let (once, none, position, two, repeat, spent) =
        with_snapshot(&db, &mut caller_budget, |reader, budget| {
            let once = reader.ordinal_zero_attempts(budget, project, session, &target.id)?;
            let spent = (budget.max_reference_count, budget.max_reference_bytes);
            let none = reader.ordinal_zero_attempts(budget, project, session, &lonely.id)?;
            let position =
                reader.ordinal_zero_attempts(budget, project, session, &at_position_one.id)?;
            let two = reader.ordinal_zero_attempts(budget, project, session, &twice.id)?;
            let repeat = reader.ordinal_zero_attempts(budget, project, session, &target.id)?;
            let after = (budget.max_reference_count, budget.max_reference_bytes);
            assert_eq!(after, spent, "the index is built once per turn");
            Ok((once, none, position, two, repeat, spent))
        })
        .expect("counts");
    assert_eq!(once.count(), 1);
    assert_eq!(once.attempt_ids(), ["t-once"]);
    assert_eq!(none.count(), 0, "an attempt that was never created");
    assert_eq!(position.count(), 1, "its own ordinal 0 attempt only");
    assert_eq!(position.attempt_ids(), ["t-second-position"]);
    assert_eq!(two.count(), 2, "the unreadable gated row cannot be counted");
    assert_eq!(two.attempt_ids(), ["twice-1", "twice-2"]);
    assert!(
        once.is_ambiguous() && two.is_ambiguous(),
        "the unreadable row makes every count a lower bound"
    );
    // "Exactly one" can be taken only through `sole_attempt`, and an
    // ambiguous session never yields one, whatever the count says.
    assert_eq!(once.sole_attempt(), None);
    assert_eq!(position.sole_attempt(), None);
    assert_eq!(two.sole_attempt(), None);
    assert_eq!(repeat, once);
    // Five listed attempts in the session (t-once, t-second-position, gated,
    // twice-1, twice-2) have their ordinal 0 row read and debited once each.
    assert_eq!(spent.0, references_before.0 - 5);
    assert!(spent.1 < references_before.1);

    // The reference ledger is a hard limit: three rows cannot read four.
    let mut tight = budget_for_reads();
    tight.max_reference_count = 3;
    assert_error_code(
        with_snapshot(&db, &mut tight, |reader, budget| {
            reader
                .ordinal_zero_attempts(budget, project, session, &target.id)
                .map(|_| ())
        }),
        "NIR1_GENERATION_REF_LIMIT",
    );
}

#[test]
fn ordinal_zero_count_includes_gated_and_legacy_attempts_and_marks_unknown_versions_ambiguous() {
    // K4/3 section 6, the exactly-one rule: one gated (or legacy) attempt and
    // one known attempt holding the same Human at ordinal 0 are two attempts.
    let db = database(Path::new(":memory:"));
    let project = "generation-project";
    let human_version = human(&db, "hc1-ordinal-count", "counted");
    // The legacy fixture binding fixes the default session.
    let sessions = ["hc1-count-gated", "generation-session", "hc1-count-future"];
    for session in [sessions[0], sessions[2]] {
        add_session(&db, project, session);
    }
    // Null slot (gated) first in the order, then a known attempt.
    insert_row(
        &db,
        "g-gated",
        2_000,
        project,
        sessions[0],
        vec![message_input(&human_version)],
    );
    insert_row(
        &db,
        "g-known",
        1_000,
        project,
        sessions[0],
        vec![message_input(&human_version)],
    );
    make_known(&db, "g-known");
    // Legacy binding with readable rows.
    insert_row(
        &db,
        "l-legacy",
        2_000,
        project,
        sessions[1],
        vec![message_input(&human_version)],
    );
    make_legacy(&db, "l-legacy");
    insert_row(
        &db,
        "l-known",
        1_000,
        project,
        sessions[1],
        vec![message_input(&human_version)],
    );
    make_known(&db, "l-known");
    // An unknown bindingVersion cannot be counted.
    insert_row(
        &db,
        "f-future",
        2_000,
        project,
        sessions[2],
        vec![message_input(&human_version)],
    );
    let mut future = stored_json(&db, "f-future");
    future["bindingVersion"] = json!(3);
    store_binding_json(&db, "f-future", &canonical_binding(&future));
    insert_row(
        &db,
        "f-known",
        1_000,
        project,
        sessions[2],
        vec![message_input(&human_version)],
    );
    make_known(&db, "f-known");

    let mut caller_budget = budget_for_reads();
    let (gated, legacy, future_session) =
        with_snapshot(&db, &mut caller_budget, |reader, budget| {
            Ok((
                reader.ordinal_zero_attempts(budget, project, sessions[0], &human_version.id)?,
                reader.ordinal_zero_attempts(budget, project, sessions[1], &human_version.id)?,
                reader.ordinal_zero_attempts(budget, project, sessions[2], &human_version.id)?,
            ))
        })
        .expect("counts");
    assert_eq!(gated.count(), 2, "a gated attempt is counted");
    assert_eq!(gated.attempt_ids(), ["g-gated", "g-known"]);
    assert!(!gated.is_ambiguous());
    assert_eq!(legacy.count(), 2, "a legacy attempt is counted");
    assert_eq!(legacy.attempt_ids(), ["l-legacy", "l-known"]);
    assert!(!legacy.is_ambiguous());
    assert_eq!(gated.sole_attempt(), None, "two holders are not one");
    assert_eq!(future_session.attempt_ids(), ["f-known"]);
    assert_eq!(
        future_session.sole_attempt(),
        None,
        "one counted holder is not exactly one when a row could not be counted"
    );
    assert!(
        future_session.is_ambiguous(),
        "an unknown-version attempt makes the count ambiguous"
    );
}

#[test]
fn history_reads_write_nothing() {
    let db = database(Path::new(":memory:"));
    let (project, session) = ("generation-project", "generation-session");
    let target = human(&db, "hc1-write-zero", "read only");
    insert_row(
        &db,
        "w1",
        1_000,
        project,
        session,
        vec![message_input(&target)],
    );
    make_known(&db, "w1");
    let total_changes = |db: &Database| -> i64 {
        db.with_conn(|conn| Ok(conn.query_row("SELECT total_changes()", [], |row| row.get(0))?))
            .expect("changes")
    };
    let before = total_changes(&db);
    let mut caller_budget = budget_for_reads();
    with_snapshot(&db, &mut caller_budget, |reader, budget| {
        reader.list_session_attempts(budget, project, session)?;
        reader.ordinal_zero_attempts(budget, project, session, &target.id)?;
        reader.read_capture_by_message_version(&target.id)?;
        reader.read_attempt(budget, "w1")?;
        Ok(())
    })
    .expect("reads");
    assert_eq!(total_changes(&db), before);
}

#[cfg(feature = "native-current-human-capture")]
mod captures {
    use super::super::bounded::BoundedWorkspace;
    use super::history_reads::HistoryCaptureState;
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

    fn op_budget() -> ParticipantSqlOperationBudget {
        ParticipantSqlOperationBudget::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
            Duration::from_millis(100),
        )
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
        accept_current_human_chat_input(workspace, &owner(workspace), &submission, op_budget())
            .expect("accepted capture")
    }

    fn capture_of(
        workspace: &crate::state::ActiveWorkspaceSnapshot,
        version: &str,
    ) -> Option<history_reads::GenerationHistoryCapture> {
        let mut caller_budget = budget_for_reads();
        with_generation_history_snapshot(
            workspace,
            ParticipantSqlControl::default(),
            &mut caller_budget,
            |reader, _, _| reader.read_capture_by_message_version(version),
        )
        .expect("capture read")
    }

    #[test]
    fn capture_read_by_message_version_returns_project_session_scene_and_state() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let first = accept(&snapshot, "first");
        let found = capture_of(&snapshot, first.message_version_id()).expect("capture row");
        assert_eq!(found.project_id, "generation-project");
        assert_eq!(found.chat_session_id, SESSION);
        assert_eq!(found.scene_id, SCENE);
        assert_eq!(found.state, HistoryCaptureState::Current);

        // A new user row supersedes the first capture (the product trigger).
        let second = accept(&snapshot, "second");
        assert_eq!(
            capture_of(&snapshot, first.message_version_id())
                .expect("first")
                .state,
            HistoryCaptureState::Superseded
        );
        assert_eq!(
            capture_of(&snapshot, second.message_version_id())
                .expect("second")
                .state,
            HistoryCaptureState::Current
        );

        cancel_current_human_chat_input(&snapshot, &second, &owner(&snapshot), op_budget())
            .expect("cancel");
        assert_eq!(
            capture_of(&snapshot, second.message_version_id())
                .expect("second")
                .state,
            HistoryCaptureState::Cancelled
        );

        // A version without a capture row is `None`, not an error: a Human
        // bound by `bind_human_message`, and an id that names nothing.
        let bound = human(snapshot.db().db(), "hc1-bound-only", "bound, not captured");
        assert_eq!(capture_of(&snapshot, &bound.id), None);
        assert_eq!(capture_of(&snapshot, "no-such-version"), None);
    }

    #[test]
    fn session_deleted_and_recreated_removes_the_capture_with_the_session() {
        let workspace = BoundedWorkspace::new();
        let snapshot = workspace.snapshot();
        let first = accept(&snapshot, "recreated");
        assert!(capture_of(&snapshot, first.message_version_id()).is_some());
        snapshot
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute("DELETE FROM chat_sessions WHERE id=?1", [SESSION])?;
                conn.execute(
                    "INSERT INTO chat_sessions(id,project_id,node_id)
                     VALUES (?1,'generation-project',?2)",
                    params![SESSION, SCENE],
                )?;
                Ok(())
            })
            .expect("recreate the session");
        assert_eq!(
            capture_of(&snapshot, first.message_version_id()),
            None,
            "the capture row cascades away with its session"
        );
    }
}
