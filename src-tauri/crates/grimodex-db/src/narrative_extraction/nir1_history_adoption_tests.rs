//! DI1B-2: the adoption rule on outcomes built by hand. The same rule on the
//! outcome of a real session (product writers, cold reopen) is exercised in
//! `nir1_packing_session_tests`.

use super::*;
use crate::narrative_extraction::nir1_history_budget::adoptable_turn_count;
use crate::nir1_generation_history::{
    CandidateDisposition, Failure, HistoryAttemptMaterial, HistoryMessageMaterial,
    IncompleteReason, SessionCandidateKind, SessionCandidateResult, SessionHistoryOutcome,
};

const CURRENT_DIGEST: &str = "sha256:scene-now";

fn limits() -> AdoptionLimits {
    AdoptionLimits {
        max_turns: 16,
        max_messages: 32,
        max_message_bytes: 1_024,
        token_budget: 100_000,
        message_envelope_tokens: 4,
        parent_read_rows: 1_000,
        parent_read_bytes: 1_000_000,
    }
}

fn candidate(kind: SessionCandidateKind, attempt: &str) -> SessionCandidateResult {
    SessionCandidateResult {
        kind,
        attempt_id: attempt.to_owned(),
        version_id: Some(format!("{}-{attempt}", version_prefix(kind))),
        disposition: CandidateDisposition::Qualified,
        visited_attempts: vec![attempt.to_owned()],
    }
}

fn version_prefix(kind: SessionCandidateKind) -> &'static str {
    match kind {
        SessionCandidateKind::PastHuman => "h",
        _ => "m",
    }
}

fn human_material(attempt: &str, body: &str) -> HistoryMessageMaterial {
    HistoryMessageMaterial {
        version_id: format!("h-{attempt}"),
        origin: MessageOrigin::Human,
        parent_attempt_id: None,
        body_digest: format!("sha256:h-{attempt}"),
        body: body.to_owned(),
    }
}

fn output_material(attempt: &str, body: &str) -> HistoryMessageMaterial {
    HistoryMessageMaterial {
        version_id: format!("m-{attempt}"),
        origin: MessageOrigin::Generated,
        parent_attempt_id: Some(attempt.to_owned()),
        body_digest: format!("sha256:m-{attempt}"),
        body: body.to_owned(),
    }
}

/// One turn of a hand-built outcome. `output: None` is a turn without a
/// qualified output.
struct Spec {
    attempt: &'static str,
    at: i64,
    human: &'static str,
    output: Option<&'static str>,
    scene_digest: &'static str,
}

fn spec(attempt: &'static str, at: i64, human: &'static str, output: Option<&'static str>) -> Spec {
    Spec {
        attempt,
        at,
        human,
        output,
        scene_digest: CURRENT_DIGEST,
    }
}

/// The outcome the run would return for these turns (the candidates in the
/// run's order: newest first).
fn outcome_of(specs: &[Spec]) -> SessionHistoryOutcome {
    let mut ordered: Vec<&Spec> = specs.iter().collect();
    ordered.sort_by(|a, b| (b.at, b.attempt.as_bytes()).cmp(&(a.at, a.attempt.as_bytes())));
    let mut candidates = Vec::new();
    let mut materials = BTreeMap::new();
    for spec in ordered {
        candidates.push(candidate(SessionCandidateKind::PastHuman, spec.attempt));
        if spec.output.is_some() {
            candidates.push(candidate(
                SessionCandidateKind::GeneratedOutput,
                spec.attempt,
            ));
        }
        materials.insert(
            spec.attempt.to_owned(),
            HistoryAttemptMaterial {
                created_at_ms: spec.at,
                scene_body_digest: spec.scene_digest.to_owned(),
                human: Some(human_material(spec.attempt, spec.human)),
                output: spec.output.map(|body| output_material(spec.attempt, body)),
            },
        );
    }
    SessionHistoryOutcome {
        candidates,
        without_history: None,
        a3_evaluations: 0,
        materials,
    }
}

fn free(_: &str) -> Result<ParentReadCost> {
    Ok(ParentReadCost::default())
}

fn adopt(
    outcome: &SessionHistoryOutcome,
    current: &str,
    limits: AdoptionLimits,
) -> HistoryAdoption {
    adopt_history_turns(
        &HistoryAdoptionRequest {
            outcome,
            current_human_body: current,
            current_scene_body_digest: CURRENT_DIGEST,
            limits,
        },
        &mut free,
    )
    .expect("adoption")
}

fn rendered(adoption: &HistoryAdoption) -> Vec<(&'static str, String)> {
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

fn user(text: &str) -> (&'static str, String) {
    ("user", text.to_owned())
}

fn assistant(text: &str) -> (&'static str, String) {
    ("assistant", text.to_owned())
}

#[test]
fn chain_h1_m1_h2_m2_is_rendered_oldest_first_with_the_input_rows() {
    // The order of the specs is not the order of the answer.
    let outcome = outcome_of(&[
        spec("a2", 2_000, "H2", Some("M2")),
        spec("a1", 1_000, "H1", Some("M1")),
    ]);
    let adoption = adopt(&outcome, "H3", limits());
    assert_eq!(
        rendered(&adoption),
        vec![user("H1"), assistant("M1"), user("H2"), assistant("M2")]
    );
    assert!(adoption.not_adopted.is_empty());
    // The input rows are the ones K4/3 section 3 names: a past Human has no
    // parent attempt, an output names the attempt that made it.
    let rows: Vec<&InputReference> = adoption.messages().map(|message| &message.input).collect();
    assert_eq!(
        rows[0],
        &InputReference {
            role: InputRole::User,
            target: InputTarget::Message {
                version_id: "h-a1".into(),
                parent_attempt_id: None
            },
            input_use: InputUse::AdoptedHistory,
        }
    );
    assert_eq!(
        rows[1],
        &InputReference {
            role: InputRole::Assistant,
            target: InputTarget::Message {
                version_id: "m-a1".into(),
                parent_attempt_id: Some("a1".into())
            },
            input_use: InputUse::AdoptedHistory,
        }
    );
    assert!(adoption
        .messages()
        .all(|message| message.input.input_use == InputUse::AdoptedHistory));
    assert_eq!(adoption.message_count(), 4);
}

#[test]
fn equal_creation_times_are_ordered_by_the_attempt_id_bytes() {
    let outcome = outcome_of(&[
        spec("b", 5_000, "Hb", Some("Mb")),
        spec("a", 5_000, "Ha", Some("Ma")),
    ]);
    let adoption = adopt(&outcome, "now", limits());
    let ids: Vec<&str> = adoption
        .turns
        .iter()
        .map(|turn| turn.attempt_id.as_str())
        .collect();
    assert_eq!(ids, ["a", "b"]);
    // Deterministic: the same input, the same answer.
    assert_eq!(adoption, adopt(&outcome, "now", limits()));
}

#[test]
fn failed_turn_human_is_adopted_in_place() {
    // (a) The Human of a turn with no output is a user message of its own, in
    // its place in the order; consecutive user messages are allowed.
    let outcome = outcome_of(&[
        spec("a1", 1_000, "first try", None),
        spec("a2", 2_000, "H2", Some("M2")),
    ]);
    let adoption = adopt(&outcome, "H3", limits());
    assert_eq!(
        rendered(&adoption),
        vec![user("first try"), user("H2"), assistant("M2")]
    );
    assert!(adoption.turns[0].output.is_none());
}

#[test]
fn failed_turn_human_after_a_good_turn_stays_between() {
    let outcome = outcome_of(&[
        spec("a1", 1_000, "H1", Some("M1")),
        spec("a2", 2_000, "H2 failed", None),
    ]);
    let adoption = adopt(&outcome, "H3", limits());
    assert_eq!(
        rendered(&adoption),
        vec![user("H1"), assistant("M1"), user("H2 failed")]
    );
}

#[test]
fn retry_duplicate_human_without_an_output_is_not_adopted() {
    // (b) H1 failed and the user sent the same words again: the current Human
    // is H1', so H1 is not repeated.
    let outcome = outcome_of(&[
        spec("a0", 500, "earlier", Some("reply")),
        spec("a1", 1_000, "write the harbour", None),
    ]);
    let adoption = adopt(&outcome, "write the harbour", limits());
    assert_eq!(
        rendered(&adoption),
        vec![user("earlier"), assistant("reply")]
    );
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
    assert_eq!(
        NotAdoptedReason::RetryDuplicateHuman.code(),
        "retry-duplicate-human"
    );
}

#[test]
fn retry_duplicate_chain_drops_every_repeat_but_keeps_distinct_text() {
    // H, H, H' (current) all alike; then a distinct failed turn is kept.
    let outcome = outcome_of(&[
        spec("a1", 1_000, "again", None),
        spec("a2", 2_000, "again", None),
        spec("a3", 3_000, "something else", None),
        spec("a4", 4_000, "again", None),
    ]);
    let adoption = adopt(&outcome, "again", limits());
    // a4 repeats the current Human and is dropped; a3 differs from "again" so
    // it stays. a2 is compared with the kept a3, not with the current Human,
    // so it stays; a1 repeats the user message after it (a2) and is dropped.
    assert_eq!(
        rendered(&adoption),
        vec![user("again"), user("something else")]
    );
    assert_eq!(
        adoption.reason_for("a4"),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
    assert_eq!(adoption.turns.len(), 2);
}

#[test]
fn retry_duplicate_compares_with_the_next_kept_human() {
    // a1 and a2 are alike and both failed; the current Human differs. a1 is
    // the same text as the user message after it (a2), so a1 is dropped.
    let outcome = outcome_of(&[
        spec("a1", 1_000, "same", None),
        spec("a2", 2_000, "same", None),
    ]);
    let adoption = adopt(&outcome, "different", limits());
    assert_eq!(rendered(&adoption), vec![user("same")]);
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
}

#[test]
fn retry_duplicate_never_drops_the_human_of_a_turn_with_an_output() {
    // The Human has the same text as the current one, but a reply answers it.
    let outcome = outcome_of(&[spec("a1", 1_000, "again", Some("M1"))]);
    let adoption = adopt(&outcome, "again", limits());
    assert_eq!(rendered(&adoption), vec![user("again"), assistant("M1")]);
}

#[test]
fn retry_duplicate_needs_the_exact_same_text() {
    for (history, current) in [
        ("again", "again "),
        ("again", "Again"),
        ("again", "again\n"),
        ("again please", "again"),
    ] {
        let outcome = outcome_of(&[spec("a1", 1_000, history, None)]);
        let adoption = adopt(&outcome, current, limits());
        assert_eq!(
            rendered(&adoption),
            vec![user(history)],
            "{history:?} / {current:?}"
        );
    }
}

#[test]
fn retry_duplicate_of_a_human_whose_output_was_excluded() {
    // The attempt succeeded but its output did not qualify: there is no
    // adopted output, so the Human is a lone user message like a failed one.
    let mut outcome = outcome_of(&[spec("a1", 1_000, "again", None)]);
    outcome.candidates.push(SessionCandidateResult {
        kind: SessionCandidateKind::GeneratedOutput,
        attempt_id: "a1".into(),
        version_id: Some("m-a1".into()),
        disposition: CandidateDisposition::Excluded(Failure::Incomplete(
            IncompleteReason::BudgetExhausted,
        )),
        visited_attempts: Vec::new(),
    });
    let adoption = adopt(&outcome, "again", limits());
    assert!(adoption.turns.is_empty());
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::RetryDuplicateHuman)
    );
    let adoption = adopt(&outcome, "different", limits());
    assert_eq!(rendered(&adoption), vec![user("again")]);
}

#[test]
fn reply_to_changed_body_is_adopted_and_counted() {
    // (c) The reply stays in its place; nothing is added to the payload.
    let mut changed = spec("a1", 1_000, "H1", Some("M1"));
    changed.scene_digest = "sha256:scene-before";
    let outcome = outcome_of(&[changed, spec("a2", 2_000, "H2", Some("M2"))]);
    let adoption = adopt(&outcome, "H3", limits());
    assert_eq!(
        rendered(&adoption),
        vec![user("H1"), assistant("M1"), user("H2"), assistant("M2")]
    );
    assert!(adoption.turns[0].scene_body_changed);
    assert!(!adoption.turns[1].scene_body_changed);
    assert_eq!(adoption.changed_body_replies(), 1);
}

#[test]
fn reply_to_changed_body_does_not_change_which_turns_the_budget_takes() {
    // The window is the newest turns whatever the Scene digest says: a
    // matching old reply is not taken ahead of a newer diverged one.
    let mut old_match = spec("a1", 1_000, "H1", Some("M1"));
    old_match.scene_digest = CURRENT_DIGEST;
    let mut new_changed = spec("a2", 2_000, "H2", Some("M2"));
    new_changed.scene_digest = "sha256:scene-before";
    let outcome = outcome_of(&[old_match, new_changed]);
    let mut tight = limits();
    tight.max_turns = 1;
    let adoption = adopt(&outcome, "H3", tight);
    assert_eq!(rendered(&adoption), vec![user("H2"), assistant("M2")]);
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::OverTurnLimit)
    );
}

#[test]
fn output_without_a_qualified_human_is_not_adopted_alone() {
    let mut outcome = outcome_of(&[spec("a1", 1_000, "H1", Some("M1"))]);
    outcome
        .candidates
        .retain(|c| c.kind != SessionCandidateKind::PastHuman);
    let adoption = adopt(&outcome, "now", limits());
    assert!(adoption.turns.is_empty());
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::OutputWithoutQualifiedHuman)
    );
}

#[test]
fn an_excluded_candidate_never_enters() {
    // Only what the run qualified is adopted, whatever material is present.
    let mut outcome = outcome_of(&[
        spec("a1", 1_000, "H1", Some("M1")),
        spec("a2", 2_000, "H2", Some("M2")),
    ]);
    for result in outcome.candidates.iter_mut() {
        if result.attempt_id == "a2" {
            result.disposition = CandidateDisposition::Excluded(Failure::Incomplete(
                IncompleteReason::BudgetExhausted,
            ));
        }
    }
    let adoption = adopt(&outcome, "now", limits());
    assert_eq!(rendered(&adoption), vec![user("H1"), assistant("M1")]);
    assert!(
        adoption.not_adopted.is_empty(),
        "an excluded attempt has no adoption reason"
    );
}

#[test]
fn the_turn_of_an_unadopted_output_is_dropped_whole() {
    // The pair rule: the Human is not adopted without the output that
    // answered it, when the output is the part that cannot be adopted.
    let mut outcome = outcome_of(&[
        spec("a1", 1_000, "H1", Some("M1")),
        spec("a2", 2_000, "H2", Some("M2")),
        spec("a3", 3_000, "H3", Some("M3")),
    ]);
    outcome.materials.get_mut("a2").expect("a2").output = None;
    let adoption = adopt(&outcome, "H4", limits());
    // The Human of a2 is not adopted alone, and a1 (older than it) goes with it.
    assert_eq!(rendered(&adoption), vec![user("H3"), assistant("M3")]);
    assert_eq!(
        adoption.reason_for("a2"),
        Some(NotAdoptedReason::BodyUnavailable)
    );
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::BeyondWindowEnd)
    );
}

#[test]
fn blank_oversize_missing_and_mismatched_bodies_are_not_adopted() {
    let mut outcome = outcome_of(&[
        spec("blank", 1_000, "   \n", Some("M")),
        spec("big", 2_000, "ok", Some("M")),
        spec("gone", 3_000, "ok", Some("M")),
        spec("origin", 4_000, "ok", Some("M")),
        spec("version", 5_000, "ok", Some("M")),
        spec("parent", 6_000, "ok", Some("M")),
        spec("fine", 7_000, "fine", Some("M")),
    ]);
    outcome.materials.get_mut("big").expect("big").output =
        Some(output_material("big", &"x".repeat(1_025)));
    // The run read the attempt but could not pay for (or find) its bodies.
    {
        let gone = outcome.materials.get_mut("gone").expect("gone");
        gone.human = None;
        gone.output = None;
    }
    outcome
        .materials
        .get_mut("origin")
        .expect("origin")
        .human
        .as_mut()
        .expect("human")
        .origin = MessageOrigin::Generated;
    outcome
        .materials
        .get_mut("version")
        .expect("version")
        .output
        .as_mut()
        .expect("out")
        .version_id = "m-other".into();
    outcome
        .materials
        .get_mut("parent")
        .expect("parent")
        .output
        .as_mut()
        .expect("out")
        .parent_attempt_id = Some("someone-else".into());
    let adoption = adopt(&outcome, "now", limits());
    assert_eq!(rendered(&adoption), vec![user("fine"), assistant("M")]);
    assert_eq!(
        adoption.reason_for("blank"),
        Some(NotAdoptedReason::BodyEmpty)
    );
    assert_eq!(
        adoption.reason_for("big"),
        Some(NotAdoptedReason::BodyOverMessageLimit)
    );
    assert_eq!(
        adoption.reason_for("gone"),
        Some(NotAdoptedReason::BodyUnavailable)
    );
    assert_eq!(
        adoption.reason_for("origin"),
        Some(NotAdoptedReason::MessageBindingMismatch)
    );
    assert_eq!(
        adoption.reason_for("version"),
        Some(NotAdoptedReason::MessageBindingMismatch)
    );
    assert_eq!(
        adoption.reason_for("parent"),
        Some(NotAdoptedReason::MessageBindingMismatch)
    );
    // A message at the limit is adopted whole.
    let mut at_limit = outcome_of(&[spec("edge", 1_000, "ok", Some("M"))]);
    at_limit.materials.get_mut("edge").expect("edge").output =
        Some(output_material("edge", &"x".repeat(1_024)));
    let adoption = adopt(&at_limit, "now", limits());
    assert_eq!(
        adoption.messages().last().expect("output").body.len(),
        1_024
    );
}

#[test]
fn a_turn_that_cannot_be_adopted_for_its_own_message_ends_the_window() {
    // The same rule as a turn that does not fit the budget: nothing older is
    // adopted, so the conversation has no hole in the middle.
    for flaw in ["blank", "big", "gone", "origin"] {
        let mut outcome = outcome_of(&[
            spec("old1", 1_000, "H1", Some("M1")),
            spec("old2", 2_000, "H2", Some("M2")),
            spec("flawed", 3_000, "H3", Some("M3")),
            spec("new1", 4_000, "H4", Some("M4")),
        ]);
        let material = outcome.materials.get_mut("flawed").expect("flawed");
        match flaw {
            "blank" => material.human.as_mut().expect("human").body = "  ".into(),
            "big" => material.output.as_mut().expect("output").body = "x".repeat(1_025),
            "gone" => material.output = None,
            _ => material.human.as_mut().expect("human").origin = MessageOrigin::Generated,
        }
        let adoption = adopt(&outcome, "now", limits());
        assert_eq!(
            rendered(&adoption),
            vec![user("H4"), assistant("M4")],
            "{flaw}"
        );
        assert!(adoption.reason_for("flawed").is_some(), "{flaw}");
        for older in ["old1", "old2"] {
            assert_eq!(
                adoption.reason_for(older),
                Some(NotAdoptedReason::BeyondWindowEnd),
                "{flaw} {older}"
            );
        }
        assert_eq!(adoption.reason_for("new1"), None, "{flaw}");
    }
}

#[test]
fn a_flawed_turn_older_than_every_adopted_turn_costs_nothing() {
    let mut outcome = outcome_of(&[
        spec("flawed", 1_000, "H1", Some("M1")),
        spec("new1", 2_000, "H2", Some("M2")),
    ]);
    outcome.materials.get_mut("flawed").expect("flawed").output = None;
    let adoption = adopt(&outcome, "now", limits());
    assert_eq!(rendered(&adoption), vec![user("H2"), assistant("M2")]);
}

#[test]
fn a_turn_with_no_material_adopts_nothing() {
    // The run always hands a qualified attempt's material on. When it did not,
    // the turn's place is unknown and the window does not guess.
    let mut outcome = outcome_of(&[
        spec("old1", 1_000, "H1", Some("M1")),
        spec("lost", 2_000, "H2", Some("M2")),
    ]);
    outcome.materials.remove("lost");
    let adoption = adopt(&outcome, "now", limits());
    assert!(adoption.turns.is_empty());
    assert_eq!(
        adoption.reason_for("lost"),
        Some(NotAdoptedReason::BodyUnavailable)
    );
}

/// The envelope tests size their windows with `adoptable_turn_count`; the
/// product adopts with `adopt_history_turns`. Both are the same rule, and this
/// is the one place that says so: for the same costs (the tokens not binding)
/// they adopt the same number of the newest turns, including where the first
/// misfit ends the window.
#[test]
fn the_envelope_window_rule_and_the_adoption_agree() {
    let cost = |rows, bytes| ParentReadCost { rows, bytes };
    let quarter = cost(CREATE_PARENT_READ_ROWS / 4, CREATE_PARENT_READ_BYTES / 4);
    let small = cost(1, 1);
    let none = ParentReadCost::default();
    let huge = cost(CREATE_PARENT_READ_ROWS + 1, 1);
    let heavy_bytes = cost(1, CREATE_PARENT_READ_BYTES + 1);
    let scenarios: Vec<Vec<ParentReadCost>> = vec![
        vec![],
        vec![small],
        vec![quarter; 4],
        vec![quarter; 5],
        vec![
            quarter,
            quarter,
            quarter,
            cost(quarter.rows + 1, quarter.bytes),
        ],
        vec![
            quarter,
            quarter,
            quarter,
            cost(quarter.rows, quarter.bytes + 1),
        ],
        vec![small, huge, small, small],
        vec![huge, small],
        vec![small, heavy_bytes, small],
        vec![none, quarter, none, quarter, none],
        vec![none, none, huge, none],
        vec![small; HISTORY_MAX_TURNS],
        vec![small; HISTORY_MAX_TURNS + 6],
        vec![none; HISTORY_MAX_TURNS + 6],
        vec![cost(usize::MAX, 0), small],
    ];
    for (index, costs) in scenarios.iter().enumerate() {
        // Turn `i` of the outcome is `costs[i]` from the newest; the names are
        // chosen so that the oldest sorts first.
        let count = costs.len();
        let names: Vec<String> = (0..count).map(|turn| format!("t{turn:02}")).collect();
        let specs: Vec<Spec> = (0..count)
            .map(|turn| {
                let newest_rank = count - 1 - turn;
                let name: &'static str = Box::leak(names[turn].clone().into_boxed_str());
                // Distinct text, so the retry rule has nothing to drop.
                let human: &'static str = Box::leak(format!("H{turn}").into_boxed_str());
                let output = (costs[newest_rank] != none).then_some("M");
                spec(name, 1_000 * (turn as i64 + 1), human, output)
            })
            .collect();
        let outcome = outcome_of(&specs);
        let by_attempt: BTreeMap<String, ParentReadCost> = (0..count)
            .map(|turn| (names[turn].clone(), costs[count - 1 - turn]))
            .collect();
        let adoption = adopt_history_turns(
            &HistoryAdoptionRequest {
                outcome: &outcome,
                current_human_body: "now",
                current_scene_body_digest: CURRENT_DIGEST,
                limits: AdoptionLimits {
                    max_message_bytes: HISTORY_MAX_MESSAGE_BYTES,
                    ..AdoptionLimits::production(usize::MAX, 4)
                },
            },
            &mut |attempt: &str| Ok(by_attempt[attempt]),
        )
        .expect("adoption");
        assert_eq!(
            adoption.turns.len(),
            adoptable_turn_count(costs),
            "scenario {index}"
        );
    }
}

#[test]
fn the_window_is_the_newest_turns_and_the_first_misfit_ends_it() {
    // Four turns of two messages, the third (from the newest) is too big:
    // the older ones are not taken either, even though they would fit.
    let specs = [
        spec("a1", 1_000, "H1", Some("M1")),
        spec("a2", 2_000, "H2", Some("M2")),
        spec(
            "a3",
            3_000,
            "H3",
            Some("M3 is long enough to be the one that does not fit the budget"),
        ),
        spec("a4", 4_000, "H4", Some("M4")),
        spec("a5", 5_000, "H5", Some("M5")),
    ];
    let outcome = outcome_of(&specs);
    let mut small = limits();
    // a5 and a4 are 2 + 2 short messages (4 envelope + 1 token each); a3's
    // reply does not fit what is left.
    small.token_budget = 4 * (4 + 1) + 6;
    let adoption = adopt(&outcome, "now", small);
    assert_eq!(
        rendered(&adoption),
        vec![user("H4"), assistant("M4"), user("H5"), assistant("M5")]
    );
    assert_eq!(
        adoption.reason_for("a3"),
        Some(NotAdoptedReason::OverTokenBudget)
    );
    assert_eq!(
        adoption.reason_for("a2"),
        Some(NotAdoptedReason::BeyondWindowEnd)
    );
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::BeyondWindowEnd)
    );
    assert!(adoption.tokens() <= small.token_budget);
}

#[test]
fn a_turn_is_never_cut_to_fit() {
    // A turn that does not fit is left out whole: its Human is not adopted
    // without its reply and the reply is not shortened.
    let outcome = outcome_of(&[spec(
        "a1",
        1_000,
        "H1",
        Some("a reply that costs more than one token"),
    )]);
    let mut tight = limits();
    tight.token_budget = 4 + 1 + 4; // the Human fits, the reply does not.
    let adoption = adopt(&outcome, "now", tight);
    assert!(adoption.turns.is_empty());
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::OverTokenBudget)
    );
}

#[test]
fn turn_message_and_token_limits_are_exact() {
    let specs: Vec<Spec> = (0..6)
        .map(|n| {
            spec(
                ["a0", "a1", "a2", "a3", "a4", "a5"][n],
                1_000 + n as i64,
                "h",
                Some("m"),
            )
        })
        .collect();
    let outcome = outcome_of(&specs);
    // Turns: 3 fit, 4 do not.
    for (max_turns, expected) in [(3usize, 3usize), (4, 4), (0, 0)] {
        let mut l = limits();
        l.max_turns = max_turns;
        assert_eq!(adopt(&outcome, "now", l).turns.len(), expected);
    }
    // Messages: 2 per turn.
    for (max_messages, expected) in [(5usize, 2usize), (6, 3), (7, 3), (1, 0)] {
        let mut l = limits();
        l.max_messages = max_messages;
        assert_eq!(
            adopt(&outcome, "now", l).turns.len(),
            expected,
            "max_messages {max_messages}"
        );
    }
    // Tokens: a turn is 2 * (4 + 1) = 10.
    for (token_budget, expected) in [(29usize, 2usize), (30, 3), (31, 3), (9, 0)] {
        let mut l = limits();
        l.token_budget = token_budget;
        let adoption = adopt(&outcome, "now", l);
        assert_eq!(
            adoption.turns.len(),
            expected,
            "token_budget {token_budget}"
        );
        assert!(adoption.tokens() <= token_budget);
    }
    // The reason is the dimension that ended the window.
    let mut l = limits();
    l.max_turns = 2;
    assert_eq!(
        adopt(&outcome, "now", l).reason_for("a3"),
        Some(NotAdoptedReason::OverTurnLimit)
    );
    let mut l = limits();
    l.max_messages = 4;
    assert_eq!(
        adopt(&outcome, "now", l).reason_for("a3"),
        Some(NotAdoptedReason::OverMessageLimit)
    );
}

#[test]
fn the_parent_read_budget_ends_the_window_and_is_asked_only_for_what_it_needs() {
    let specs = [
        spec("a1", 1_000, "H1", Some("M1")),
        spec("a2", 2_000, "H2", Some("M2")),
        spec("a3", 3_000, "H3", None),
        spec("a4", 4_000, "H4", Some("M4")),
    ];
    let outcome = outcome_of(&specs);
    let mut l = limits();
    l.parent_read_rows = 100;
    l.parent_read_bytes = 10_000;
    let mut asked: Vec<String> = Vec::new();
    let adoption = adopt_history_turns(
        &HistoryAdoptionRequest {
            outcome: &outcome,
            current_human_body: "now",
            current_scene_body_digest: CURRENT_DIGEST,
            limits: l,
        },
        &mut |attempt: &str| {
            asked.push(attempt.to_owned());
            Ok(ParentReadCost {
                rows: 60,
                bytes: 1_000,
            })
        },
    )
    .expect("adoption");
    // a4 (60 rows) fits; the lone a3 costs nothing and is not asked; a2 would
    // make 120 rows and ends the window; a1 is not asked at all.
    assert_eq!(asked, ["a4", "a2"]);
    assert_eq!(
        rendered(&adoption),
        vec![user("H3"), user("H4"), assistant("M4")]
    );
    assert_eq!(
        adoption.reason_for("a2"),
        Some(NotAdoptedReason::OverParentReadBudget)
    );
    assert_eq!(
        adoption.reason_for("a1"),
        Some(NotAdoptedReason::BeyondWindowEnd)
    );
    // Exactly at the budget fits (N), one over does not (N + 1).
    for (allowed_rows, fits) in [(100usize, true), (99, false)] {
        let mut one_limits = limits();
        one_limits.parent_read_rows = allowed_rows;
        let one = outcome_of(&[spec("a1", 1_000, "H1", Some("M1"))]);
        let adoption = adopt_history_turns(
            &HistoryAdoptionRequest {
                outcome: &one,
                current_human_body: "now",
                current_scene_body_digest: CURRENT_DIGEST,
                limits: one_limits,
            },
            &mut |_: &str| {
                Ok(ParentReadCost {
                    rows: 100,
                    bytes: 0,
                })
            },
        )
        .expect("adoption");
        assert_eq!(
            adoption.turns.len(),
            usize::from(fits),
            "rows {allowed_rows}"
        );
    }
    // The bytes are checked the same way.
    for (allowed_bytes, fits) in [(2_000usize, true), (1_999, false)] {
        let mut one_limits = limits();
        one_limits.parent_read_bytes = allowed_bytes;
        let one = outcome_of(&[spec("a1", 1_000, "H1", Some("M1"))]);
        let adoption = adopt_history_turns(
            &HistoryAdoptionRequest {
                outcome: &one,
                current_human_body: "now",
                current_scene_body_digest: CURRENT_DIGEST,
                limits: one_limits,
            },
            &mut |_: &str| {
                Ok(ParentReadCost {
                    rows: 1,
                    bytes: 2_000,
                })
            },
        )
        .expect("adoption");
        assert_eq!(
            adoption.turns.len(),
            usize::from(fits),
            "bytes {allowed_bytes}"
        );
    }
}

#[test]
fn a_failing_parent_read_cost_is_the_callers_error() {
    let outcome = outcome_of(&[spec("a1", 1_000, "H1", Some("M1"))]);
    let error = adopt_history_turns(
        &HistoryAdoptionRequest {
            outcome: &outcome,
            current_human_body: "now",
            current_scene_body_digest: CURRENT_DIGEST,
            limits: limits(),
        },
        &mut |_: &str| Err(anyhow::anyhow!("read failed")),
    )
    .expect_err("the error is returned, not turned into a smaller window");
    assert!(error.to_string().contains("read failed"));
}

#[test]
fn production_limits_never_exceed_the_recorded_values() {
    let l = AdoptionLimits::production(1_000_000, 4);
    assert_eq!(l.max_turns, 16);
    assert_eq!(l.max_messages, 32);
    assert_eq!(l.max_message_bytes, 65_536);
    assert_eq!(l.token_budget, 8_192);
    assert_eq!(l.parent_read_rows, CREATE_PARENT_READ_ROWS);
    assert_eq!(l.parent_read_bytes, CREATE_PARENT_READ_BYTES);
    // A request with less left takes less; it never takes more.
    assert_eq!(AdoptionLimits::production(100, 4).token_budget, 100);
    assert_eq!(AdoptionLimits::production(0, 4).token_budget, 0);
}

#[test]
fn a_run_without_history_adopts_nothing() {
    let outcome = SessionHistoryOutcome {
        candidates: Vec::new(),
        without_history: Some(crate::nir1_generation_history::NoHistory::SessionOverBudget),
        a3_evaluations: 0,
        materials: BTreeMap::new(),
    };
    let adoption = adopt(&outcome, "now", limits());
    assert_eq!(adoption, HistoryAdoption::default());
    assert_eq!(adoption.message_count(), 0);
    assert_eq!(adoption.tokens(), 0);
}

#[test]
fn reason_codes_are_a_closed_set_without_text() {
    let all = [
        NotAdoptedReason::OutputWithoutQualifiedHuman,
        NotAdoptedReason::BodyUnavailable,
        NotAdoptedReason::MessageBindingMismatch,
        NotAdoptedReason::BodyEmpty,
        NotAdoptedReason::BodyOverMessageLimit,
        NotAdoptedReason::RetryDuplicateHuman,
        NotAdoptedReason::OverTurnLimit,
        NotAdoptedReason::OverMessageLimit,
        NotAdoptedReason::OverTokenBudget,
        NotAdoptedReason::OverParentReadBudget,
        NotAdoptedReason::BeyondWindowEnd,
    ];
    let codes: std::collections::BTreeSet<&str> = all.iter().map(|r| r.code()).collect();
    assert_eq!(codes.len(), all.len());
    assert!(codes
        .iter()
        .all(|code| code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')));
}
