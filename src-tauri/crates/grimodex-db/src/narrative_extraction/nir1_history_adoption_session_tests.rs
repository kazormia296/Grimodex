//! DI1B-2: the adoption rule on the outcome of a real session. Every attempt
//! is made by the product writers (`SessionFixture`), the run reads in the
//! participant snapshot, and the adoption works from what the run handed on.
//!
//! This is a child of `session_history_tests`.

use super::*;
use crate::narrative_extraction::nir1_history_adoption::{
    adopt_history_turns, AdoptedTurn, AdoptionLimits, HistoryAdoption, HistoryAdoptionRequest,
    NotAdoptedReason,
};
use crate::narrative_extraction::nir1_history_budget::ParentReadCost;
use crate::nir1_generation::{InputReference, InputRole, InputTarget, InputUse};

fn limits() -> AdoptionLimits {
    AdoptionLimits::production(100_000, 4)
}

fn scene_digest_now(session: &SessionFixture) -> Result<String> {
    Ok(session
        .db()
        .with_read_transaction(|conn| read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE))?
        .body_digest)
}

fn adopt(
    session: &SessionFixture,
    outcome: &SessionHistoryOutcome,
    current: &str,
) -> Result<HistoryAdoption> {
    adopt_history_turns(
        &HistoryAdoptionRequest {
            outcome,
            current_human_body: current,
            current_scene_body_digest: &scene_digest_now(session)?,
            limits: limits(),
        },
        &mut |_: &str| Ok(ParentReadCost::default()),
    )
}

fn bodies(adoption: &HistoryAdoption) -> Vec<(&'static str, String)> {
    adoption
        .messages()
        .map(|message| {
            let role = match message.input.role {
                InputRole::User => "user",
                InputRole::Assistant => "assistant",
                _ => "other",
            };
            (role, message.body.clone())
        })
        .collect()
}

fn pair(user: &str, assistant: &str) -> Vec<(&'static str, String)> {
    vec![
        ("user", user.to_owned()),
        ("assistant", assistant.to_owned()),
    ]
}

/// The input row the new attempt stores for each message of the turn is the
/// row the product writer of a later turn stored for the same message
/// (`Adopt`), with the version the turn itself recorded.
fn assert_rows_match(adopted: &AdoptedTurn, turn: &Turn) {
    assert_eq!(adopted.attempt_id, turn.attempt_id);
    assert_eq!(
        adopted.human.input,
        InputReference {
            role: InputRole::User,
            target: InputTarget::Message {
                version_id: turn.human_version_id.clone(),
                parent_attempt_id: None,
            },
            input_use: InputUse::AdoptedHistory,
        }
    );
    assert_eq!(adopted.human.body_digest, turn.human_digest);
    if let Some((_, version_id, digest)) = &turn.output {
        let output = adopted.output.as_ref().expect("the output is adopted");
        assert_eq!(
            output.input,
            InputReference {
                role: InputRole::Assistant,
                target: InputTarget::Message {
                    version_id: version_id.clone(),
                    parent_attempt_id: Some(turn.attempt_id.clone()),
                },
                input_use: InputUse::AdoptedHistory,
            }
        );
        assert_eq!(&output.body_digest, digest);
    }
}

#[test]
fn chain_h1_m1_h2_m2_is_adopted_in_order_with_the_runs_bodies() -> Result<()> {
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
    session.accept("next", "What happens next?")?;
    let outcome = session.run()?;
    let adoption = adopt(&session, &outcome, "What happens next?")?;
    assert_eq!(
        bodies(&adoption),
        [
            pair("Tell me about the harbour.", "The harbour is quiet."),
            pair("And the lighthouse?", "The lighthouse is dark."),
        ]
        .concat()
    );
    assert!(adoption.not_adopted.is_empty(), "{adoption:#?}");
    assert_rows_match(&adoption.turns[0], &first);
    assert_rows_match(&adoption.turns[1], &second);
    // Nothing the adoption holds is anything but what the run read.
    for turn in [&first, &second] {
        let material = &outcome.materials[&turn.attempt_id];
        assert_eq!(
            material.human.as_ref().expect("human").body_digest,
            turn.human_digest
        );
    }
    assert_eq!(adoption.changed_body_replies(), 0);
    // The run and the adoption both write nothing: the run asserts it
    // (`run_purpose`), and the adoption has no connection to write with.
    Ok(())
}

#[test]
fn chain_is_adopted_the_same_after_a_cold_reopen() -> Result<()> {
    let directory =
        std::env::temp_dir().join(format!("di1b-adopt-reopen-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("grimodex.db");
    let result = (|| -> Result<()> {
        let mut session = SessionFixture::new_on_file(&path)?;
        let first = session.turn("First.", &[], Some("First answer."))?;
        let second = session.turn(
            "Second.",
            &[Adopt::human(&first), Adopt::output(&first)],
            Some("Second answer."),
        )?;
        session.accept("warm", "Third.")?;
        let warm = adopt(&session, &session.run()?, "Third.")?;
        let session = session.reopen(&path)?;
        session.accept("cold", "Third.")?;
        let cold = adopt(&session, &session.run()?, "Third.")?;
        assert_eq!(warm.turns.len(), 2);
        assert_eq!(bodies(&cold), bodies(&warm));
        assert_rows_match(&cold.turns[0], &first);
        assert_rows_match(&cold.turns[1], &second);
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&directory);
    result
}

#[test]
fn failed_turn_human_is_adopted_when_the_next_message_is_different() -> Result<()> {
    // (a) A1 ended with no output. The user then asked something else.
    let mut session = SessionFixture::new()?;
    let failed = session.turn("Describe the sea.", &[], None)?;
    let good = session.turn("Describe the sky.", &[], Some("Grey."))?;
    session.accept("next", "And the moon?")?;
    let adoption = adopt(&session, &session.run()?, "And the moon?")?;
    assert_eq!(
        bodies(&adoption),
        [
            vec![("user", "Describe the sea.".to_owned())],
            pair("Describe the sky.", "Grey."),
        ]
        .concat()
    );
    assert!(adoption.turns[0].output.is_none());
    assert_rows_match(&adoption.turns[0], &failed);
    assert_rows_match(&adoption.turns[1], &good);
    Ok(())
}

#[test]
fn retry_duplicate_resend_after_a_failed_turn_adopts_h1prime_and_m2_only() -> Result<()> {
    // K4/3's example: H1 failed, the same words were sent again (H1', which
    // has an output), and the next message differs. H1 is not repeated.
    let mut session = SessionFixture::new()?;
    let failed = session.turn("Describe the sea.", &[], None)?;
    let resent = session.turn("Describe the sea.", &[], Some("Blue."))?;
    session.accept("next", "And the sky?")?;
    let adoption = adopt(&session, &session.run()?, "And the sky?")?;
    assert_eq!(bodies(&adoption), pair("Describe the sea.", "Blue."));
    assert_rows_match(&adoption.turns[0], &resent);
    assert_eq!(
        adoption.reason_for(&failed.attempt_id),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
    Ok(())
}

#[test]
fn retry_duplicate_current_human_repeats_the_failed_one() -> Result<()> {
    // The failed turn's words are sent again as the current Human: the
    // request carries them once (as the current user message).
    let mut session = SessionFixture::new()?;
    let failed = session.turn("Describe the sea.", &[], None)?;
    session.accept("next", "Describe the sea.")?;
    let adoption = adopt(&session, &session.run()?, "Describe the sea.")?;
    assert!(adoption.turns.is_empty());
    assert_eq!(
        adoption.reason_for(&failed.attempt_id),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
    // Not the same words: the failed Human is a message of its own.
    let adoption = adopt(&session, &session.run()?, "Describe the sea, please.")?;
    assert_eq!(
        bodies(&adoption),
        vec![("user", "Describe the sea.".to_owned())]
    );
    Ok(())
}

#[test]
fn reply_to_changed_body_is_adopted_in_place_and_counted() -> Result<()> {
    // (c) The body of the target Scene is saved after the reply. Q8 keeps the
    // history; the adoption keeps the reply and marks it.
    let mut session = SessionFixture::new()?;
    let first = session.turn("Tell me about the harbour.", &[], Some("It is quiet."))?;
    let before = scene_digest_now(&session)?;
    save_body(session.db(), SCENE, "hc1-rewritten-body", &clock_stamp())?;
    assert_ne!(scene_digest_now(&session)?, before);
    let second = session.turn(
        "And now?",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("It is stormy."),
    )?;
    session.accept("next", "Continue.")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &first);
    assert_turn_adopted(&outcome, &second);
    let adoption = adopt(&session, &outcome, "Continue.")?;
    assert_eq!(
        bodies(&adoption),
        [
            pair("Tell me about the harbour.", "It is quiet."),
            pair("And now?", "It is stormy.")
        ]
        .concat()
    );
    // The first reply was written against the old body, the second against
    // the body now.
    assert!(adoption.turns[0].scene_body_changed);
    assert!(!adoption.turns[1].scene_body_changed);
    assert_eq!(adoption.changed_body_replies(), 1);
    Ok(())
}

#[test]
fn a_body_the_run_could_not_pay_for_drops_that_turn_and_keeps_the_rest() -> Result<()> {
    // The last body the run charges is the newest output (read once more for
    // the adoption). One byte short of it, the run still qualifies every
    // candidate; the adoption has no body for that reply, so the turn is left
    // out whole and the older turn is adopted.
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    let second = session.turn(
        "Second.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    session.accept("next", "Third.")?;
    let mut probe = SessionFixture::generous_budget();
    let baseline = session.run_with(&mut probe)?;
    let generous = SessionFixture::generous_budget();
    let consumed = generous.max_resolved_body_bytes - probe.max_resolved_body_bytes;
    let adoption = adopt(&session, &baseline, "Third.")?;
    assert_eq!(adoption.turns.len(), 2);

    let mut short = SessionFixture::generous_budget();
    short.max_resolved_body_bytes = consumed - 1;
    let outcome = session.run_with(&mut short)?;
    assert_eq!(outcome.without_history, None);
    assert_turn_adopted(&outcome, &first);
    assert_turn_adopted(&outcome, &second);
    assert!(outcome.materials[&second.attempt_id].output.is_none());
    let adoption = adopt(&session, &outcome, "Third.")?;
    assert_eq!(bodies(&adoption), pair("First.", "First answer."));
    assert_eq!(
        adoption.reason_for(&second.attempt_id),
        Some(NotAdoptedReason::BodyUnavailable)
    );
    Ok(())
}

#[test]
fn only_what_the_run_qualified_is_adopted() -> Result<()> {
    // A Scope edit retires the first turn (a reading-position change); the
    // second turn, made after it, is the only one the run qualifies.
    let mut session = SessionFixture::new()?;
    let stale = session.turn("Old.", &[], Some("Old answer."))?;
    let moved = format!("{}x", session.sort_order_of(SCENE)?);
    session.patch_node(SCENE, "di1b-adopt-move", "sortOrder", json!(moved))?;
    let fresh = session.turn("New.", &[], Some("New answer."))?;
    session.accept("next", "Then?")?;
    let outcome = session.run()?;
    assert!(!is_qualified(&outcome, PastHuman, &stale.attempt_id));
    let adoption = adopt(&session, &outcome, "Then?")?;
    assert_eq!(bodies(&adoption), pair("New.", "New answer."));
    assert_rows_match(&adoption.turns[0], &fresh);
    // The retired turn is not a "not adopted" entry either: the adoption only
    // reports on what the run qualified.
    assert_eq!(adoption.reason_for(&stale.attempt_id), None);
    assert!(!outcome.materials.contains_key(&stale.attempt_id));
    Ok(())
}

#[test]
fn review_history_is_adopted_for_a_review_turn_only() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let writing = session.turn("Write it.", &[], Some("Written."))?;
    let review = session.run_turn(
        TurnSpec::new("Review it.")
            .purpose(GenerationPurpose::Review)
            .reply("Reviewed."),
    )?;
    session.accept("next", "More.")?;
    let writing_turn = adopt(&session, &session.run()?, "More.")?;
    assert_eq!(bodies(&writing_turn), pair("Write it.", "Written."));
    assert_rows_match(&writing_turn.turns[0], &writing);
    let review_turn = adopt(&session, &session.run_review()?, "More.")?;
    assert_eq!(bodies(&review_turn), pair("Review it.", "Reviewed."));
    assert_rows_match(&review_turn.turns[0], &review);
    Ok(())
}
