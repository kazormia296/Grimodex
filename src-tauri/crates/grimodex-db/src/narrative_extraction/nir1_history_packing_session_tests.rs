//! DI1B-3: the history in D-final. The turns are made by the product writers
//! (`SessionFixture`); the inputs under test are built by
//! `read_and_pack_native_nir1_prepared_inputs` and
//! `read_and_pack_native_nir1_selected_inputs` with `history` set, and
//! confirmed again by `revalidate_native_nir1_prepared_inputs`.
//!
//! This is a child of `session_history_tests`.

use super::*;
use crate::nir1_generation::{
    d1_selection_digest, InputRole, InputTarget, InputUse, QualificationKind,
};
use anyhow::Context as _;

const ENVELOPE: usize = 4;
const BIG_BUDGET: usize = 100_000;

fn native_request() -> NativeNir1HistoryRequest {
    NativeNir1HistoryRequest {
        now_ms: wall_clock_ms(),
        message_envelope_tokens: ENVELOPE,
    }
}

fn prepare(
    session: &SessionFixture,
    capture: &AcceptedChatInputCapture,
    purpose: PackingPurpose,
    history: Option<NativeNir1HistoryRequest>,
    budget: usize,
) -> Result<NativeNir1PreparedInputs> {
    read_and_pack_native_nir1_prepared_inputs(
        &session.snapshot,
        purpose,
        HistorySendClassification::LocalOnly,
        history,
        SESSION,
        capture,
        SCENE,
        &session.revisions,
        prepared_sql_budget(),
        |_| Ok(budget),
    )
}

/// The next Human input of the session, prepared with the history asked for.
fn next(
    session: &SessionFixture,
    text: &str,
    history: Option<NativeNir1HistoryRequest>,
    budget: usize,
) -> Result<NativeNir1PreparedInputs> {
    let key = format!("di1b3-{}", uuid::Uuid::new_v4());
    let (capture, _) = session.accept(&key, text)?;
    prepare(session, &capture, PackingPurpose::Writing, history, budget)
}

fn history_texts(prepared: &NativeNir1PreparedInputs) -> Vec<(&'static str, String)> {
    prepared
        .history_messages()
        .iter()
        .map(|message| {
            let role = match message.role() {
                InputRole::User => "user",
                InputRole::Assistant => "assistant",
                _ => "other",
            };
            (role, message.text().to_owned())
        })
        .collect()
}

fn pair(user: &str, assistant: &str) -> Vec<(&'static str, String)> {
    vec![
        ("user", user.to_owned()),
        ("assistant", assistant.to_owned()),
    ]
}

fn context_pairs(prepared: &NativeNir1PreparedInputs) -> Vec<(usize, String)> {
    prepared
        .context_items()
        .iter()
        .map(|item| (item.input_ordinal(), item.text().to_owned()))
        .collect()
}

fn context_tokens(prepared: &NativeNir1PreparedInputs) -> usize {
    prepared
        .context_items()
        .iter()
        .map(|item| estimate_nir1_context_tokens(item.text()))
        .sum()
}

fn row_counts(db: &Database) -> Result<Vec<(String, i64)>> {
    db.with_conn(|conn| {
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let mut counts = Vec::new();
        for table in tables {
            // Virtual-table shadow tables are skipped by name only when they
            // cannot be counted; every ordinary table counts.
            if let Ok(count) = conn.query_row(
                &format!("SELECT count(*) FROM \"{table}\""),
                [],
                |row| row.get::<_, i64>(0),
            ) {
                counts.push((table, count));
            }
        }
        Ok(counts)
    })
}

/// The expected rows of a history message (the K4/3 section 3 table, the
/// fixture's `history_rows`).
fn expected_history_rows(
    prepared: &NativeNir1PreparedInputs,
    adopts: &[Adopt],
    first_ordinal: usize,
) -> Result<Vec<QualificationReference>> {
    let scope = prepared.authority_bindings()[0].scope().clone();
    let mut rows = Vec::new();
    for (index, adopt) in adopts.iter().enumerate() {
        rows.extend(SessionFixture::history_rows(
            first_ordinal + index,
            adopt,
            &scope,
        )?);
    }
    Ok(rows)
}

#[test]
fn chain_h1_m1_h2_m2_is_adopted_in_order_with_complete_rows() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn(
        "Tell me about the harbour.",
        &[],
        Some("The harbour is quiet."),
    )?;
    let second = session.turn(
        "And the lighthouse?",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("The lighthouse is dark."),
    )?;
    let (capture, _) = session.accept("di1b3-chain", "What happens next?")?;
    let without = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        None,
        BIG_BUDGET,
    )?;
    let prepared = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        Some(native_request()),
        BIG_BUDGET,
    )?;

    assert_eq!(
        history_texts(&prepared),
        [
            pair("Tell me about the harbour.", "The harbour is quiet."),
            pair("And the lighthouse?", "The lighthouse is dark."),
        ]
        .concat()
    );
    // The input rows come after the Human (0), the Raw and the Revisions, oldest
    // first, and no earlier ordinal moved.
    let base = without.input_references().len();
    assert_eq!(prepared.input_references().len(), base + 4);
    assert_eq!(
        &prepared.input_references()[..base],
        without.input_references()
    );
    let adopts = [
        Adopt::human(&first),
        Adopt::output(&first),
        Adopt::human(&second),
        Adopt::output(&second),
    ];
    for (index, message) in prepared.history_messages().iter().enumerate() {
        assert_eq!(message.input_ordinal(), base + index);
        let row = &prepared.input_references()[base + index];
        assert_eq!(row.input_use, InputUse::AdoptedHistory);
        assert_eq!(&row.role, message.role());
    }
    assert_eq!(
        prepared.input_references()[base + 1].role,
        InputRole::Assistant
    );
    assert_eq!(
        prepared.input_references()[base + 3].target,
        InputTarget::Message {
            version_id: second.output.clone().expect("output").1,
            parent_attempt_id: Some(second.attempt_id.clone()),
        }
    );
    // A past Human has no parent attempt.
    assert_eq!(
        prepared.input_references()[base].target,
        InputTarget::Message {
            version_id: first.human_version_id.clone(),
            parent_attempt_id: None,
        }
    );
    // The qualification rows of the history: exactly the table of K4/3
    // section 3, after the rows that were there.
    let rows_before = without.qualifications().len();
    assert_eq!(
        &prepared.qualifications()[..rows_before],
        without.qualifications()
    );
    assert_eq!(
        &prepared.qualifications()[rows_before..],
        expected_history_rows(&prepared, &adopts, base)?.as_slice()
    );
    // Nothing of the history changes what the selector chose.
    assert_eq!(context_pairs(&prepared), context_pairs(&without));
    assert_eq!(prepared.user_message(), without.user_message());
    let observation = prepared
        .history_observation()
        .expect("history was asked for");
    assert_eq!(observation.adopted_turns, 2);
    assert_eq!(observation.adopted_messages, 4);
    assert_eq!(observation.without_history, None);
    assert!(observation.not_adopted.is_empty());
    Ok(())
}

#[test]
fn history_inputs_carry_complete_qualification_refs_and_d1_includes_history() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    session.turn(
        "Second.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    let prepared = next(&session, "Third.", Some(native_request()), BIG_BUDGET)?;
    assert_eq!(prepared.history_messages().len(), 4);

    // The completeness rule with the expected (kind, target) set holds for
    // every input, history included.
    let finalized = prepared.finalize_qualifications(BIG_BUDGET)?;
    prepared
        .check_completeness(&finalized.qualifications)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;
    let expected = prepared.expected_qualification_targets()?;
    for message in prepared.history_messages() {
        let ordinal = message.input_ordinal();
        let kinds: Vec<QualificationKind> = finalized
            .qualifications
            .iter()
            .filter(|row| row.input_ordinal == ordinal)
            .map(|row| row.kind)
            .collect();
        // Source, two Scope references, four typed N/A and the D1 selection.
        assert_eq!(kinds.len(), 8, "ordinal {ordinal}: {kinds:?}");
        assert!(kinds.contains(&QualificationKind::D1));
        assert!(expected[&ordinal]
            .iter()
            .any(|target| target.kind == QualificationKind::D1));
        // A generated output carries no Decision and no confirmation: its
        // Decision is typed N/A.
        let decision = finalized
            .qualifications
            .iter()
            .find(|row| row.input_ordinal == ordinal && row.kind == QualificationKind::Decision)
            .expect("a Decision row");
        assert!(
            matches!(
                decision.body,
                QualificationBody::NotApplicable {
                    reason: NotApplicableReason::HumanAuthored
                        | NotApplicableReason::DerivedFromParents
                }
            ),
            "{decision:?}"
        );
    }
    // The D1 usage counts the context and the history.
    let history_tokens: usize = prepared.history_messages().iter().map(|m| m.tokens()).sum();
    assert!(history_tokens > 0);
    let used = context_tokens(&prepared) + history_tokens;
    assert_eq!(finalized.d1_selection.used_tokens, u64::try_from(used)?);
    assert_eq!(
        finalized.d1_selection.remaining_tokens,
        u64::try_from(BIG_BUDGET - used)?
    );
    // The digest recomputes from the stored fields and the input rows,
    // history included; and it is not the digest of the history-free rows.
    assert_eq!(
        d1_selection_digest(&finalized.d1_selection, prepared.input_references())?,
        finalized.d1_selection_digest
    );
    let history_draft = prepared.history_draft(&finalized);
    assert!(
        matches!(
            history_draft.slot,
            crate::nir1_generation::history_context::HistoryContextSlot::Context(_)
        ),
        "{:?}",
        history_draft.slot
    );
    // Dropping a history reference is detected (rule 3).
    let mut dropped = finalized.qualifications.clone();
    let history_ordinal = prepared.history_messages()[0].input_ordinal();
    let at = dropped
        .iter()
        .position(|row| {
            row.input_ordinal == history_ordinal && row.kind == QualificationKind::Source
        })
        .expect("a Source row");
    dropped.remove(at);
    assert!(prepared.check_completeness(&dropped).is_err());
    Ok(())
}

#[test]
fn request_without_history_is_byte_identical_to_before() -> Result<()> {
    // No attempt in the session: asking for history changes nothing.
    let session = SessionFixture::new()?;
    let (capture, _) = session.accept("plain", "A first question.")?;
    let none = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        None,
        BIG_BUDGET,
    )?;
    let some = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert!(some.history_messages().is_empty());
    assert_eq!(some.input_references(), none.input_references());
    assert_eq!(some.qualifications(), none.qualifications());
    assert_eq!(context_pairs(&some), context_pairs(&none));
    let (final_none, final_some) = (
        none.finalize_qualifications(BIG_BUDGET)?,
        some.finalize_qualifications(BIG_BUDGET)?,
    );
    assert_eq!(final_some, final_none);
    assert_eq!(
        some.history_draft(&final_some),
        none.history_draft(&final_none)
    );
    assert_eq!(none.history_observation(), None);
    let observation = some.history_observation().expect("asked for");
    assert_eq!(observation.adopted_turns, 0);
    assert_eq!(observation.tokens, 0);
    Ok(())
}

#[test]
fn history_is_absent_when_none_is_asked_for_even_with_a_past_conversation() -> Result<()> {
    let mut session = SessionFixture::new()?;
    session.turn("First.", &[], Some("First answer."))?;
    let prepared = next(&session, "Second.", None, BIG_BUDGET)?;
    assert!(prepared.history_messages().is_empty());
    assert_eq!(prepared.history_observation(), None);
    assert!(prepared
        .input_references()
        .iter()
        .all(|row| row.input_use != InputUse::AdoptedHistory));
    Ok(())
}

#[test]
fn history_shares_the_final_budget_and_never_displaces_required_raw() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First question.", &[], Some("First answer."))?;
    session.turn(
        "Second question.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    let roomy = next(
        &session,
        "Third question.",
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert_eq!(roomy.history_messages().len(), 4);
    let used_by_context = context_tokens(&roomy);
    let message_tokens: Vec<usize> = roomy
        .history_messages()
        .iter()
        .map(|m| m.tokens())
        .collect();
    let newest_turn: usize = message_tokens[2] + message_tokens[3];
    let all: usize = message_tokens.iter().sum();

    // Room for the newest turn only: the older turn is left out whole, the
    // Raw and the IR are the ones the budget alone chose.
    let budget = used_by_context + newest_turn;
    let baseline = next(&session, "Third question.", None, budget)?;
    let tight = next(&session, "Third question.", Some(native_request()), budget)?;
    assert_eq!(context_pairs(&baseline), context_pairs(&roomy));
    assert_eq!(context_pairs(&tight), context_pairs(&baseline));
    assert_eq!(
        history_texts(&tight),
        pair("Second question.", "Second answer.")
    );
    let finalized = tight.finalize_qualifications(budget)?;
    assert_eq!(
        finalized.d1_selection.used_tokens,
        u64::try_from(used_by_context + newest_turn)?
    );
    assert_eq!(finalized.d1_selection.remaining_tokens, 0);
    let observation = tight.history_observation().expect("asked for");
    assert_eq!(observation.adopted_turns, 1);
    assert!(
        observation.not_adopted.contains(&"over-token-budget"),
        "{observation:?}"
    );

    // One token short of the newest turn: nothing is adopted, a message is
    // never shortened and the context is still the same.
    let short = next(
        &session,
        "Third question.",
        Some(native_request()),
        used_by_context + newest_turn - 1,
    )?;
    assert!(short.history_messages().is_empty());
    let baseline_short = next(
        &session,
        "Third question.",
        None,
        used_by_context + newest_turn - 1,
    )?;
    assert_eq!(context_pairs(&short), context_pairs(&baseline_short));
    // With room for everything the whole conversation is adopted.
    let everything = next(
        &session,
        "Third question.",
        Some(native_request()),
        used_by_context + all,
    )?;
    assert_eq!(everything.history_messages().len(), 4);
    Ok(())
}

#[test]
fn failed_turn_human_and_retry_duplicate_through_d_final() -> Result<()> {
    let mut session = SessionFixture::new()?;
    // (a) A failed turn's Human is a user message of its own.
    session.turn("Describe the sea.", &[], None)?;
    session.turn("Describe the sky.", &[], Some("Grey."))?;
    let prepared = next(
        &session,
        "And the moon?",
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert_eq!(
        history_texts(&prepared),
        [
            vec![("user", "Describe the sea.".to_owned())],
            pair("Describe the sky.", "Grey."),
        ]
        .concat()
    );
    // (b) A failed Human whose words are sent again as the current Human is
    // not carried twice.
    let mut session = SessionFixture::new()?;
    session.turn("Describe the sea.", &[], None)?;
    let repeated = next(
        &session,
        "Describe the sea.",
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert!(repeated.history_messages().is_empty());
    assert!(repeated
        .history_observation()
        .expect("asked for")
        .not_adopted
        .contains(&"retry-duplicate-human"));
    // Other words: the failed Human is a message of its own.
    let other = next(
        &session,
        "Describe the sea, please.",
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert_eq!(
        history_texts(&other),
        vec![("user", "Describe the sea.".to_owned())]
    );
    Ok(())
}

#[test]
fn reply_to_changed_body_is_adopted_in_place_and_counted_through_d_final() -> Result<()> {
    let mut session = SessionFixture::new()?;
    session.turn("Tell me about the harbour.", &[], Some("It is quiet."))?;
    save_body(session.db(), SCENE, "di1b3-rewritten-body", &clock_stamp())?;
    let prepared = next(&session, "Continue.", Some(native_request()), BIG_BUDGET)?;
    assert_eq!(
        history_texts(&prepared),
        pair("Tell me about the harbour.", "It is quiet.")
    );
    let observation = prepared.history_observation().expect("asked for");
    assert_eq!(observation.changed_body_replies, 1);
    // The Raw is the body now, next to the reply written against the old one.
    assert!(prepared
        .context_items()
        .iter()
        .any(|item| item.text().contains("di1b3-rewritten-body")));
    Ok(())
}

#[test]
fn review_turn_adopts_review_history_only_through_d_final() -> Result<()> {
    let mut session = SessionFixture::new()?;
    session.turn("Write it.", &[], Some("Written."))?;
    session.run_turn(
        TurnSpec::new("Review it.")
            .purpose(GenerationPurpose::Review)
            .reply("Reviewed."),
    )?;
    let (capture, _) = session.accept("di1b3-purpose", "More.")?;
    let writing = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert_eq!(history_texts(&writing), pair("Write it.", "Written."));
    let review = prepare(
        &session,
        &capture,
        PackingPurpose::Review,
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert_eq!(history_texts(&review), pair("Review it.", "Reviewed."));
    Ok(())
}

#[test]
fn other_session_history_is_absent_and_the_range_is_the_captures() -> Result<()> {
    let mut session = SessionFixture::new()?;
    session.turn("A secret of the first session.", &[], Some("Kept."))?;
    session.db().with_conn(|conn| {
        conn.execute(
            "INSERT INTO chat_sessions(id,project_id,node_id) VALUES (?1,?2,?3)",
            params!["di1b3-other-session", PROJECT, SCENE],
        )?;
        Ok(())
    })?;
    let submission = NewChatInputSubmission::new(
        "di1b3-other-submission".into(),
        "di1b3-other-message".into(),
        "di1b3-other-session".into(),
        SCENE.into(),
        "Hello from the other session.".into(),
        "2026-10-18T10:00:00.000Z".into(),
    )?;
    let capture = accept_current_human_chat_input(
        &session.snapshot,
        &session.owner()?,
        &submission,
        prepared_sql_budget(),
    )?;
    let prepared = read_and_pack_native_nir1_prepared_inputs(
        &session.snapshot,
        PackingPurpose::Writing,
        HistorySendClassification::LocalOnly,
        Some(native_request()),
        "di1b3-other-session",
        &capture,
        SCENE,
        &session.revisions,
        prepared_sql_budget(),
        |_| Ok(BIG_BUDGET),
    )?;
    assert!(prepared.history_messages().is_empty());
    let observation = prepared.history_observation().expect("asked for");
    assert_eq!(observation.adopted_turns, 0);
    // The first session's conversation is not named anywhere in the inputs.
    assert!(prepared
        .context_items()
        .iter()
        .all(|item| !item.text().contains("A secret of the first session.")));
    Ok(())
}

#[test]
fn the_native_selection_adopts_the_same_history_as_the_callers_list() -> Result<()> {
    let mut session = SessionFixture::new()?;
    session.turn("First.", &[], Some("First answer."))?;
    let (capture, _) = session.accept("di1b3-selected", "Second.")?;
    let by_list = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        Some(native_request()),
        BIG_BUDGET,
    )?;
    let selected = read_and_pack_native_nir1_selected_inputs(
        &session.snapshot,
        PackingPurpose::Writing,
        HistorySendClassification::LocalOnly,
        Some(native_request()),
        SESSION,
        &capture,
        SCENE,
        None,
        prepared_sql_budget(),
        |_| Ok(BIG_BUDGET),
    )?;
    assert_eq!(
        history_texts(selected.prepared()),
        pair("First.", "First answer.")
    );
    assert_eq!(history_texts(selected.prepared()), history_texts(&by_list));
    // The Native selection still returns what a create compares.
    assert_eq!(selected.scene_binding().scene_id, SCENE);
    Ok(())
}

#[test]
fn history_run_writes_nothing_in_the_d_final_snapshot() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    session.turn(
        "Second.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    let (capture, _) = session.accept("di1b3-writes", "Third.")?;
    let before = row_counts(session.db())?;
    let prepared = prepare(
        &session,
        &capture,
        PackingPurpose::Writing,
        Some(native_request()),
        BIG_BUDGET,
    )?;
    assert_eq!(prepared.history_messages().len(), 4);
    assert_eq!(row_counts(session.db())?, before);
    // The snapshot connection is writable again afterwards.
    session.accept("di1b3-writes-after", "Fourth.")?;
    Ok(())
}

#[test]
fn revalidation_confirms_adopted_history_and_rejects_history_that_stops_qualifying() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    session.turn(
        "Second.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    let now = wall_clock_ms();
    let prepared = next(
        &session,
        "Third.",
        Some(NativeNir1HistoryRequest {
            now_ms: now,
            message_envelope_tokens: ENVELOPE,
        }),
        BIG_BUDGET,
    )?;
    assert_eq!(prepared.history_messages().len(), 4);
    revalidate_native_nir1_prepared_inputs(
        &session.snapshot,
        SESSION,
        &prepared,
        prepared_sql_budget(),
        now,
    )?;
    // The same history no longer qualifies once its 30 days are over: the turn
    // stops with a closed code; the Human, the Raw and the Revisions are
    // still what they were.
    let thirty_one_days = 31 * 24 * 60 * 60 * 1_000;
    let error = revalidate_native_nir1_prepared_inputs(
        &session.snapshot,
        SESSION,
        &prepared,
        prepared_sql_budget(),
        now + thirty_one_days,
    )
    .err()
    .context("expired history was accepted at the return")?;
    assert!(
        format!("{error:#}").contains("NIR1_NATIVE_PREPARED_HISTORY_STALE"),
        "{error:#}"
    );
    Ok(())
}

/// A session with two settled turns and a prepared next request that adopted
/// both (four messages), to be changed afterwards.
fn prepared_with_two_turns() -> Result<(SessionFixture, NativeNir1PreparedInputs, i64)> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    session.turn(
        "Second.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    let now = wall_clock_ms();
    let prepared = next(
        &session,
        "Third.",
        Some(NativeNir1HistoryRequest {
            now_ms: now,
            message_envelope_tokens: ENVELOPE,
        }),
        BIG_BUDGET,
    )?;
    assert_eq!(prepared.history_messages().len(), 4);
    revalidate_native_nir1_prepared_inputs(
        &session.snapshot,
        SESSION,
        &prepared,
        prepared_sql_budget(),
        now,
    )?;
    Ok((session, prepared, now))
}

/// Only the history part of the return-time check, in a participant read
/// transaction of its own. A Scope, point-of-view or epoch change of the
/// target Scene also fails the Human, Raw or Revision checks that run before
/// it, with their own codes; calling the history confirmation alone shows that
/// it rejects the change by itself (it does not lean on those checks).
fn confirm_history_alone(
    session: &SessionFixture,
    prepared: &NativeNir1PreparedInputs,
    now: i64,
) -> Result<()> {
    let history = prepared.history.as_ref().expect("history");
    let budget = prepared_sql_budget();
    let checkpoint_budget = budget.clone();
    session
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(session.snapshot.participant(), budget, |conn| {
            let mut checkpoint = || checkpoint_budget.check(session.snapshot.participant());
            confirm_history_in_snapshot(
                conn,
                prepared,
                history,
                &session.snapshot,
                now,
                &checkpoint_budget,
                &mut checkpoint,
            )
        })
}

/// The history confirmation says the history is stale (and not some other
/// failure): the turn stops, nothing is sent.
fn assert_history_stale(session: &SessionFixture, prepared: &NativeNir1PreparedInputs, now: i64) {
    let error = confirm_history_alone(session, prepared, now)
        .expect_err("the history no longer qualifies, but the confirmation accepted it");
    assert!(
        format!("{error:#}").contains("NIR1_NATIVE_PREPARED_HISTORY_STALE"),
        "{error:#}"
    );
}

#[test]
fn revalidation_rejects_each_way_the_history_stops_qualifying() -> Result<()> {
    // (i) A write that changes the Scene's Scope (its reading position).
    {
        let (session, prepared, now) = prepared_with_two_turns()?;
        let moved = format!("{}x", session.sort_order_of(SCENE)?);
        session.patch_node(SCENE, "di1b3-stale-move", "sortOrder", json!(moved))?;
        assert_history_stale(&session, &prepared, now);
    }
    // (ii) The point of view, and the story-time axis, of the target Scene.
    {
        let (session, prepared, now) = prepared_with_two_turns()?;
        session.patch_node(SCENE, "di1b3-stale-pov", "povCharacterId", Value::Null)?;
        assert_history_stale(&session, &prepared, now);
    }
    {
        let (session, prepared, now) = prepared_with_two_turns()?;
        session.patch_node(SCENE, "di1b3-stale-time", "storyTimeOrder", Value::Null)?;
        assert_history_stale(&session, &prepared, now);
    }
    // (iii) The restore epoch of the project changes.
    {
        let (session, prepared, now) = prepared_with_two_turns()?;
        session.db().with_conn(|conn| {
            crate::narrative_extraction::semantic_epoch::create_epoch_in_tx(
                conn, PROJECT, "restore", None,
            )?;
            Ok(())
        })?;
        assert_history_stale(&session, &prepared, now);
    }
    // (iv) A message body that is not the one adopted (the prepared value is
    // changed; the stored message is immutable, so this is the comparison).
    {
        let (session, mut prepared, now) = prepared_with_two_turns()?;
        let history = prepared.history.as_mut().expect("history");
        history.turns[0].human.body.push_str(" (changed)");
        assert_history_stale(&session, &prepared, now);
    }
    {
        let (session, mut prepared, now) = prepared_with_two_turns()?;
        let history = prepared.history.as_mut().expect("history");
        history.turns[1]
            .output
            .as_mut()
            .expect("output")
            .body_digest = "sha256:other".into();
        assert_history_stale(&session, &prepared, now);
    }
    Ok(())
}

#[test]
fn revalidation_keeps_history_over_writes_that_do_not_touch_its_authority() -> Result<()> {
    // Q8: a body, a title, a synopsis and a label of other Scenes do not stop
    // the turn (the Revision's own anchor is not among them: a write there
    // retires the Revision, which the Revision check reports on its own).
    let (session, prepared, now) = prepared_with_two_turns()?;
    save_body(
        session.db(),
        "a3-source",
        "di1b3-other-body",
        &clock_stamp(),
    )?;
    for (tag, field, value) in [
        ("title", "title", json!("Retitled")),
        ("synopsis", "synopsis", json!("Only a synopsis")),
        ("label", "storyTimeLabel", json!("A label")),
    ] {
        session.patch_node("a3-source", &format!("di1b3-other-{tag}"), field, value)?;
    }
    run_incremental_freshness_cycle(session.db())?;
    confirm_history_alone(&session, &prepared, now)?;
    Ok(())
}

#[test]
fn revalidation_does_not_continue_with_a_part_of_the_history_when_its_budget_is_spent() -> Result<()>
{
    let mut session = SessionFixture::new()?;
    session.turn("First.", &[], Some("First answer."))?;
    let now = wall_clock_ms();
    let prepared = next(
        &session,
        "Second.",
        Some(NativeNir1HistoryRequest {
            now_ms: now,
            message_envelope_tokens: ENVELOPE,
        }),
        BIG_BUDGET,
    )?;
    assert_eq!(prepared.history_messages().len(), 2);
    // A confirmation operation with no more than the tail the rest of the read
    // keeps leaves the history no time: the run ends before any SQL. What was
    // adopted is not sent on the strength of nothing.
    let budget = ParticipantSqlOperationBudget::new(
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(3),
        Duration::from_millis(100),
    );
    let error =
        revalidate_native_nir1_prepared_inputs(&session.snapshot, SESSION, &prepared, budget, now)
            .err()
            .context("history without a budget was accepted at the return")?;
    assert!(
        format!("{error:#}").contains("NIR1_NATIVE_PREPARED_HISTORY_STALE"),
        "{error:#}"
    );
    Ok(())
}

#[test]
fn three_turn_chain_through_the_native_history_adopts_all_ancestors() -> Result<()> {
    // Three turns by the product writers, each one adopting the turns before
    // it through D-final, not by hand: the create accepts the rows D-final
    // wrote (the parent receipt and version are validated), and the next turn's
    // run re-authorizes the attempt that carries them.
    let mut session = SessionFixture::new()?;
    let first = session.run_turn(
        TurnSpec::new("Turn one.")
            .reply("Answer one.")
            .native_history(wall_clock_ms(), ENVELOPE),
    )?;
    let second = session.run_turn(
        TurnSpec::new("Turn two.")
            .reply("Answer two.")
            .native_history(wall_clock_ms(), ENVELOPE),
    )?;
    let third = session.run_turn(
        TurnSpec::new("Turn three.")
            .reply("Answer three.")
            .native_history(wall_clock_ms(), ENVELOPE),
    )?;
    let prepared = next(&session, "Turn four.", Some(native_request()), BIG_BUDGET)?;
    assert_eq!(
        history_texts(&prepared),
        [
            pair("Turn one.", "Answer one."),
            pair("Turn two.", "Answer two."),
            pair("Turn three.", "Answer three."),
        ]
        .concat()
    );
    let observation = prepared.history_observation().expect("asked for");
    assert_eq!(observation.adopted_turns, 3);
    assert!(observation.not_adopted.is_empty(), "{observation:?}");
    // The attempts D-final built are the ones the run qualified.
    let outcome = session.run()?;
    for turn in [&first, &second, &third] {
        assert!(outcome.qualified().any(|result| {
            result.attempt_id == turn.attempt_id
                && result.kind == SessionCandidateKind::GeneratedOutput
        }));
    }
    Ok(())
}
