//! DI-1b (DI1B-4): the history of a conversation in the Native request, from
//! the product writers up to the rendered payload.
//!
//! One process runs capture, prepare, create and the success terminal of one
//! turn, and then the next capture and prepare. Nothing is carried from one
//! turn to the next except what the product stores: no process-local cache,
//! READY or preparation result is reused (every turn is a new
//! `Nir1LocalAttempt`, a new snapshot and a new run of the history
//! re-authorization). The clock is Native's; a test advances it with
//! `test_clock::advance`.

use super::*;

use grimodex_core::narrative_nir1_receipt::{
    Completion, OutputChannel, OutputObserver, ProviderTerminal, TerminalObservation,
};
use grimodex_db::domain_writes::{tree_node_create, tree_node_patch};
use grimodex_db::domain_writes::{TreeNodeCreatePayload, TreeNodePatchPayload};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    self, NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
};
use grimodex_db::nir1_generation::history_context::HISTORY_ELIGIBILITY_WINDOW_MS;
use grimodex_db::nir1_generation::{
    self as generation_storage, InputRole, InputTarget, InputUse, NewMessageBody, StoredAttempt,
};
use grimodex_db::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use serde_json::{json, Value};

use super::tests::{
    create_approved_revision_with_key, write_local_route, Fixture, NO_UNSUPPORTED_INPUTS,
    PROJECT_ID, REVISION_SCENE_ID, SCENE_ID, SESSION_ID,
};
use crate::nir1_generation::test_clock;
use crate::nir1_local_attempt::{
    Nir1LocalAttempt, Nir1LocalAttemptOutcome, Nir1LocalAttemptProbe,
    NIR1_LOCAL_ATTEMPT_READ_BUDGET,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const FIRST_REQUEST: &str = "Continue this scene, preserving the established voice.";
const CANARY_H1: &str = "CANARY-HUMAN-ONE";
const CANARY_M1: &str = "CANARY-REPLY-ONE";

/// A fixture whose target Scene has a story-time key and a point of view, as
/// a manuscript in use has: the history of a turn is recorded against those
/// axes, and without them the turn has no history context to compare.
pub(in crate::nir1_prepared_request) fn ready_fixture() -> Fixture {
    let fixture = Fixture::new().expect("fixture");
    assert!(
        crate::nir1_generation::sweep_and_open_ready_entry_for_test(&fixture.state),
        "the startup gate opens after the sweep"
    );
    patch_node(
        &fixture,
        SCENE_ID,
        "axis-time",
        "storyTimeOrder",
        json!("k-1"),
    );
    patch_node(
        &fixture,
        SCENE_ID,
        "axis-pov",
        "povCharacterId",
        json!("nir1-prepared-alice"),
    );
    fixture
}

fn workspace_of(fixture: &Fixture) -> ActiveWorkspaceSnapshot {
    active_workspace_snapshot(&fixture.state.ws).expect("workspace")
}

fn completed(text: &str) -> TerminalObservation {
    let mut observer = OutputObserver::new();
    observer
        .observe(OutputChannel::Text, text.as_bytes())
        .expect("text");
    observer
        .observe_terminal(ProviderTerminal::Complete)
        .expect("terminal");
    observer.finish(Completion::Parsed)
}

/// What a finished turn sent.
pub(in crate::nir1_prepared_request) struct Sent {
    pub(in crate::nir1_prepared_request) attempt_id: String,
    pub(in crate::nir1_prepared_request) payload: Value,
}

/// One whole turn through the product path: the coordinator's capture,
/// prepare, assemble, create, re-observation and claim, and then the success
/// terminal with the generated reply.
pub(in crate::nir1_prepared_request) fn send_turn(
    fixture: &Fixture,
    submission: &NativeAcceptedChatSubmission,
    answer: &str,
) -> Sent {
    let outcome = Nir1LocalAttempt::capture(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        submission,
        SCENE_ID,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|refusal| panic!("capture refused: {refusal:?}"))
    .run()
    .unwrap_or_else(|refusal| panic!("the coordinator refused: {refusal:?}"));
    let Nir1LocalAttemptOutcome::Start(transport) = outcome else {
        panic!("the turn must start the transport")
    };
    let attempt_id = transport.attempt_id().to_owned();
    let payload: Value = serde_json::from_str(transport.canonical_payload()).expect("payload json");
    transport
        .finish(
            &completed(answer),
            Some(NewMessageBody {
                message_id: format!("{attempt_id}-reply"),
                content: answer.into(),
                thinking: String::new(),
            }),
        )
        .expect("terminal after the recorded send");
    Sent {
        attempt_id,
        payload,
    }
}

/// The turn is prepared as the coordinator would and nothing is created.
fn prepare(
    fixture: &Fixture,
    submission: &NativeAcceptedChatSubmission,
) -> PrivateDTransportHandoff {
    let (request, ..) = prepare_selected_local_chat_request(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        submission,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|error| panic!("prepare failed: {error:#}"))
    .into_parts();
    request.into_d_transport_handoff()
}

/// `(role, content)` of every message of a payload.
fn messages_of(payload: &Value) -> Vec<(String, String)> {
    payload["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|message| {
            (
                message["role"].as_str().expect("role").to_owned(),
                message["content"].as_str().expect("content").to_owned(),
            )
        })
        .collect()
}

fn roles_of(payload: &Value) -> Vec<String> {
    messages_of(payload)
        .into_iter()
        .map(|(role, _)| role)
        .collect()
}

fn contents_of(payload: &Value) -> Vec<String> {
    messages_of(payload)
        .into_iter()
        .map(|(_, content)| content)
        .collect()
}

fn stored(fixture: &Fixture, attempt_id: &str) -> StoredAttempt {
    generation_storage::read_attempt(
        workspace_of(fixture).db().db(),
        attempt_id,
        NIR1_LOCAL_ATTEMPT_READ_BUDGET,
    )
    .expect("stored attempt")
}

fn assistant_turn_cost(texts: &[&str]) -> usize {
    texts
        .iter()
        .map(|text| estimate_nir1_context_tokens(text) + PLAIN_CHAT_MESSAGE_ENVELOPE_TOKENS)
        .sum()
}

fn history_rows(handoff: &PrivateDTransportHandoff) -> Vec<(usize, usize)> {
    handoff
        .render_correspondence()
        .iter()
        .filter_map(|row| match row.position() {
            PreparedPayloadPosition::HistoryMessage(index) => Some((index, row.input_ordinal())),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

/// H1 M1 H2 M2 H3 M3 are rendered oldest first between the system message and
/// the current Human, each with the role of its input row. The correspondence
/// names every history message by its place in the payload; the stored
/// attempt of the third turn holds the ancestors as history inputs with the
/// parent attempt of each reply, and the create accepted them (the parent
/// receipts and versions are checked by the storage). `chain_..` and
/// `three_turn_chain_through_product_writers_adopts_all_ancestors`.
#[test]
fn chain_h1_m1_h2_m2_is_adopted_in_order_and_positions_are_in_render_correspondence() {
    let fixture = ready_fixture();
    let one = send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    assert_eq!(
        roles_of(&one.payload),
        ["system", "user"],
        "the first turn has no history"
    );
    let second = fixture
        .add_human_message("turn-two", "SECOND-REQUEST")
        .expect("second Human");
    let two = send_turn(&fixture, &second, "ANSWER-TWO");
    assert_eq!(
        roles_of(&two.payload),
        ["system", "user", "assistant", "user"]
    );
    assert_eq!(
        contents_of(&two.payload)[1..],
        [FIRST_REQUEST, "ANSWER-ONE", "SECOND-REQUEST"]
    );
    let third = fixture
        .add_human_message("turn-three", "THIRD-REQUEST")
        .expect("third Human");
    let three = send_turn(&fixture, &third, "ANSWER-THREE");
    assert_eq!(
        roles_of(&three.payload),
        ["system", "user", "assistant", "user", "assistant", "user"]
    );
    assert_eq!(
        contents_of(&three.payload)[1..],
        [
            FIRST_REQUEST,
            "ANSWER-ONE",
            "SECOND-REQUEST",
            "ANSWER-TWO",
            "THIRD-REQUEST"
        ]
    );

    // The third attempt adopted the ancestors (the history rows are
    // `AdoptedHistory`; a reply names its parent attempt).
    let attempt = stored(&fixture, &three.attempt_id);
    let adopted = attempt
        .inputs
        .iter()
        .filter(|input| input.input_use == InputUse::AdoptedHistory)
        .collect::<Vec<_>>();
    assert_eq!(adopted.len(), 4);
    let roles = adopted
        .iter()
        .map(|input| input.role.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        roles,
        [
            InputRole::User,
            InputRole::Assistant,
            InputRole::User,
            InputRole::Assistant
        ]
    );
    let parents = adopted
        .iter()
        .map(|input| match &input.target {
            InputTarget::Message {
                parent_attempt_id, ..
            } => parent_attempt_id.clone(),
            other => panic!("a history input is a message: {other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        parents,
        [
            None,
            Some(one.attempt_id.clone()),
            None,
            Some(two.attempt_id.clone())
        ]
    );

    // The fourth turn, prepared and not created: the correspondence.
    let fourth = fixture
        .add_human_message("turn-four", "FOURTH-REQUEST")
        .expect("fourth Human");
    let handoff = prepare(&fixture, &fourth);
    let payload: Value = serde_json::from_str(handoff.canonical_payload()).expect("payload");
    assert_eq!(payload["messages"].as_array().expect("messages").len(), 8);
    let rows = history_rows(&handoff);
    assert_eq!(
        rows.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4, 5],
        "every history message has one position, oldest first"
    );
    let messages = messages_of(&payload);
    for (index, ordinal) in &rows {
        let reference = &handoff.input_references()[*ordinal];
        assert_eq!(reference.input_use, InputUse::AdoptedHistory);
        // Payload message `index + 1`: the system message is message 0.
        let (role, _) = &messages[index + 1];
        let expected = match reference.role {
            InputRole::User => "user",
            InputRole::Assistant => "assistant",
            ref other => panic!("history role {other:?}"),
        };
        assert_eq!(role, expected);
    }
    assert!(
        rows.windows(2).all(|pair| pair[0].1 < pair[1].1),
        "the input rows follow the rendered order"
    );
    // The usage counts the history: the text in the conversation, the
    // envelope of every message.
    let budget = handoff.budget();
    let history_texts = messages[1..7]
        .iter()
        .map(|(_, content)| content.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        budget.history_tokens,
        history_texts
            .iter()
            .map(|text| estimate_nir1_context_tokens(text))
            .sum::<usize>()
    );
    assert_eq!(
        budget.conversation_tokens,
        budget.history_tokens + estimate_nir1_context_tokens("FOURTH-REQUEST")
    );
    assert_eq!(
        budget.envelope_tokens,
        plain_chat_message_envelope_tokens(8).expect("envelope")
    );
    assert_eq!(
        budget.input_tokens,
        budget.system_tokens + budget.conversation_tokens + budget.envelope_tokens
    );
    assert!(budget.reserved_total_tokens <= budget.context_window_tokens);
}

/// With no history, the payload is the two-message payload of before, with
/// the usage of before: the envelope of two messages, no history tokens, and
/// a payload digest that follows the canonical form of exactly that payload.
#[test]
fn request_without_history_is_byte_identical_to_before() {
    let fixture = ready_fixture();
    let handoff = prepare(&fixture, &fixture.message_version_id);
    assert!(history_rows(&handoff).is_empty());
    let payload: Value = serde_json::from_str(handoff.canonical_payload()).expect("payload");
    let messages = messages_of(&payload);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].0, "system");
    assert_eq!(messages[1], ("user".to_owned(), FIRST_REQUEST.to_owned()));
    let route = handoff.route();
    let expected = json!({
        "model": route.model,
        "messages": [
            {"role": "system", "content": messages[0].1},
            {"role": "user", "content": FIRST_REQUEST},
        ],
        "max_tokens": route.output_tokens,
        "stream": true,
    });
    assert_eq!(
        handoff.canonical_payload(),
        canonical_json_string(&expected).expect("canonical")
    );
    assert_eq!(
        handoff.payload_digest(),
        crate::nir1_generation::final_payload_digest(&expected).expect("digest")
    );
    let budget = handoff.budget();
    assert_eq!(budget.history_tokens, 0);
    assert_eq!(
        budget.envelope_tokens,
        plain_chat_message_envelope_tokens(2).unwrap()
    );
    assert_eq!(
        budget.conversation_tokens,
        estimate_nir1_context_tokens(FIRST_REQUEST)
    );
    assert!(handoff
        .input_references()
        .iter()
        .all(|input| input.input_use != InputUse::AdoptedHistory));
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/// The history is placed after the selection, in what the selector's budget
/// leaves over: Raw and the Revisions are the same with or without it, the
/// oldest turns go first and whole, the request never reserves more than the
/// window, and the D1 usage counts the history.
#[test]
fn history_shares_the_final_budget_and_never_displaces_required_raw() {
    let fixture = ready_fixture();
    let one = send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    drop(one);
    let second = fixture.add_human_message("t2", "SECOND-REQUEST").unwrap();
    send_turn(&fixture, &second, "ANSWER-TWO");
    let third = fixture.add_human_message("t3", "THIRD-REQUEST").unwrap();
    send_turn(&fixture, &third, "ANSWER-THREE");
    let fourth = fixture.add_human_message("t4", "FOURTH-REQUEST").unwrap();

    // Room for everything.
    let roomy = prepare(&fixture, &fourth);
    let roomy_payload: Value = serde_json::from_str(roomy.canonical_payload()).unwrap();
    let roomy_messages = messages_of(&roomy_payload);
    assert_eq!(roomy_messages.len(), 8);
    let system = roomy_messages[0].1.clone();
    let turn_cost = [
        assistant_turn_cost(&[FIRST_REQUEST, "ANSWER-ONE"]),
        assistant_turn_cost(&["SECOND-REQUEST", "ANSWER-TWO"]),
        assistant_turn_cost(&["THIRD-REQUEST", "ANSWER-THREE"]),
    ];
    let history_cost = turn_cost.iter().sum::<usize>();
    let context_tokens = usize::try_from(roomy.d1_selection().used_tokens).unwrap() - history_cost;
    let route = resolve_supported_local_route(&fixture.state.ai_settings_path).unwrap();
    let non_context = non_context_budget_for_user(&route, "FOURTH-REQUEST").unwrap();
    let selector_budget = roomy.budget().packing_context_budget_tokens;
    assert_eq!(selector_budget, route.context_window_tokens - non_context);

    // Each case sets the selector's budget to what the Raw and the
    // Revisions take plus `room`, by the size of the window.
    for (room, kept_turns) in [
        (history_cost, 3usize),
        (history_cost - 1, 2),
        (turn_cost[1] + turn_cost[2], 2),
        (turn_cost[1] + turn_cost[2] - 1, 1),
        (turn_cost[2], 1),
        (turn_cost[2] - 1, 0),
        (0, 0),
    ] {
        let window = non_context + context_tokens + room;
        write_local_route(
            &fixture.state,
            "http://127.0.0.1:12345/v1",
            u32::try_from(window).unwrap(),
            u32::try_from(route.output_tokens).unwrap(),
        )
        .unwrap();
        let handoff = prepare(&fixture, &fourth);
        let payload: Value = serde_json::from_str(handoff.canonical_payload()).unwrap();
        let messages = messages_of(&payload);
        assert_eq!(
            messages.len(),
            2 + 2 * kept_turns,
            "room {room}: {kept_turns} turns fit"
        );
        // The Raw and the Revisions are the ones of the roomy request.
        assert_eq!(messages[0].1, system, "room {room}: the system message");
        // The newest turns stay, whole and in order.
        let expected = roomy_messages[1 + 2 * (3 - kept_turns)..7]
            .iter()
            .map(|(_, content)| content.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            contents_of(&payload)[1..messages.len() - 1],
            expected[..],
            "room {room}"
        );
        let budget = handoff.budget();
        assert!(
            budget.reserved_total_tokens <= budget.context_window_tokens,
            "room {room}: the request fits the window"
        );
        // D1 counts the history with the context.
        let kept_cost = turn_cost[3 - kept_turns..].iter().sum::<usize>();
        assert_eq!(
            usize::try_from(handoff.d1_selection().used_tokens).unwrap(),
            context_tokens + kept_cost
        );
        assert_eq!(
            usize::try_from(handoff.d1_selection().remaining_tokens).unwrap(),
            room - kept_cost,
            "room {room}"
        );
    }
}

// ---------------------------------------------------------------------------
// The same process: turn 1, a change, turn 2
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Between {
    /// The anchor Scene's Scope is saved by the Scene Scope writer.
    AnchorScope,
    /// The target Scene's own Scope is saved.
    TargetScope,
    /// The target Scene's point of view moves to another character.
    Viewpoint,
    /// The target Scene's story-time key moves.
    StoryTime,
    /// The target Scene's body is saved (Q8).
    TargetBody,
    /// An unrelated Scene is created, retitled and saved (Q8).
    UnrelatedScene,
    /// The user cancels turn 1, then sends the same text again.
    UserCancelThenResend,
    /// A snapshot restore of a scope that does not touch the body: the
    /// project's restore epoch moves.
    RestoreEpoch,
    /// 29 days pass (inside the 30-day window).
    TwentyNineDays,
    /// 31 days pass.
    ThirtyOneDays,
}

fn save_scene_scope(fixture: &Fixture, scene_id: &str, request_id: &str) {
    let workspace = workspace_of(fixture);
    let db = workspace.db().db();
    let current = db
        .with_read_transaction(|conn| {
            narrative_extraction::read_narrative_scene_scope(conn, PROJECT_ID, scene_id)
        })
        .expect("scope read");
    narrative_extraction::update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT_ID.into(),
            scene_id: scene_id.into(),
            request_id: request_id.into(),
            session_id: SESSION_ID.into(),
            event_uid: format!("event-{request_id}"),
            base_version: current.binding.version,
            updated_at: "2026-10-19T00:00:00.000Z".into(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: current.binding.compatibility_marker,
                query_identity: current.binding.query_identity,
                material_constraint: current.binding.material_constraint,
                knowledge_holder: current.binding.knowledge_holder,
                audience: current.binding.audience,
            },
        },
    )
    .expect("scene scope save");
}

fn patch_node(fixture: &Fixture, node: &str, tag: &str, field: &str, value: Value) {
    let mut patch = serde_json::Map::new();
    patch.insert(field.to_owned(), value);
    tree_node_patch(
        workspace_of(fixture).db().db(),
        TreeNodePatchPayload {
            project_id: PROJECT_ID.to_owned(),
            request_id: format!("di1b-patch-{tag}-request"),
            session_id: "di1b-world".to_owned(),
            event_uid: format!("di1b-patch-{tag}-event"),
            node_id: node.to_owned(),
            patch,
            base_version: None,
            bump_version: true,
            updated_at: "2026-10-19T00:00:00.000Z".to_owned(),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )
    .expect("node patch");
}

fn save_body(fixture: &Fixture, scene: &str, tag: &str) {
    save_scene_body_bundle(
        workspace_of(fixture).db().db(),
        SaveSceneBodyBundlePayload {
            scene_id: scene.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            request_id: format!("di1b-body-{tag}-request"),
            session_id: "di1b-body-session".to_owned(),
            event_uid: format!("di1b-body-{tag}-event"),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            timelapse_doc_step_coverage: None,
            include_sidecars: false,
            base_version: None,
            updated_at: "2026-10-19T00:00:00.000Z".to_owned(),
            content_json: format!(
                r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{tag}"}}]}}]}}"#
            ),
            char_count: tag.chars().count() as i64,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_owned(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: Default::default(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 0,
        },
    )
    .expect("scene body save");
}

fn restore_labels_scope(fixture: &Fixture) {
    use grimodex_db::project_snapshots::{
        apply_project_snapshot_restore, create_project_snapshot,
        ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
    };
    let workspace = workspace_of(fixture);
    let db = workspace.db().db();
    create_project_snapshot(
        db,
        CreateProjectSnapshotPayload {
            project_id: PROJECT_ID.to_owned(),
            snapshot_id: "di1b-snapshot".to_owned(),
            name: "di1b".to_owned(),
            description: None,
            created_at: "2026-10-19T00:00:00.000Z".to_owned(),
            tree_rows: Vec::new(),
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        },
    )
    .expect("snapshot");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO labels(id,project_id,name,color) VALUES ('di1b-label',?1,'Label','red')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("label");
    // The snapshot holds no label, so restoring the Labels scope removes the
    // label above, inserts nothing, and moves the project's restore epoch.
    let scopes = vec![RestoreScope::Labels];
    apply_project_snapshot_restore(
        db,
        ApplyProjectSnapshotRestorePayload {
            request_id: "di1b-restore-request".to_owned(),
            session_id: "di1b-restore-session".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            snapshot_id: "di1b-snapshot".to_owned(),
            scopes,
            inserts: Vec::new(),
        },
    )
    .expect("restore");
}

/// Turn 1 (a Human with a canary and a reply with a canary) and then the
/// change, in one process. Returns what turn 2 sent and the guard of the
/// clock, which must outlive turn 2.
fn turn_two_after(change: Between) -> (Fixture, Sent, Sent, String, Option<test_clock::ClockSkew>) {
    let fixture = ready_fixture();
    let first_text = format!("{CANARY_H1} {FIRST_REQUEST}");
    // The fixture's first Human is the canary-free one; the canary Human is
    // sent as the first turn of a new capture on the same session.
    let canary = fixture
        .add_human_message("canary-one", &first_text)
        .expect("canary Human");
    let one = if change == Between::UserCancelThenResend {
        // The attempt is created and the transport starts; then the user
        // cancels. The conservative terminal is written when the transport is
        // dropped.
        let outcome = Nir1LocalAttempt::capture(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            &canary,
            SCENE_ID,
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::writing_for_test(),
        )
        .expect("capture")
        .run()
        .expect("run");
        let Nir1LocalAttemptOutcome::Start(transport) = outcome else {
            panic!("the turn must start")
        };
        let attempt_id = transport.attempt_id().to_owned();
        let payload: Value = serde_json::from_str(transport.canonical_payload()).unwrap();
        cancel_current_chat_submission(Arc::clone(&fixture.state), &canary).expect("user cancel");
        drop(transport);
        assert_eq!(
            workspace_of(&fixture)
                .db()
                .db()
                .with_read_transaction(|conn| conn
                    .query_row(
                        "SELECT state FROM nir1_chat_input_captures WHERE capture_id=?1",
                        [canary.capture.capture_id()],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(Into::into))
                .expect("capture state"),
            "cancelled",
            "the user's cancel reached the capture"
        );
        Sent {
            attempt_id,
            payload,
        }
    } else {
        send_turn(&fixture, &canary, CANARY_M1)
    };

    let mut skew = None;
    match change {
        Between::AnchorScope => save_scene_scope(&fixture, REVISION_SCENE_ID, "di1b-anchor-scope"),
        Between::TargetScope => save_scene_scope(&fixture, SCENE_ID, "di1b-target-scope"),
        Between::Viewpoint => patch_node(
            &fixture,
            SCENE_ID,
            "pov",
            "povCharacterId",
            json!("nir1-prepared-bob"),
        ),
        Between::StoryTime => patch_node(
            &fixture,
            SCENE_ID,
            "story-time",
            "storyTimeOrder",
            json!("k-9"),
        ),
        Between::TargetBody => save_body(&fixture, SCENE_ID, "The target body was rewritten."),
        Between::UnrelatedScene => {
            tree_node_create(
                workspace_of(&fixture).db().db(),
                TreeNodeCreatePayload {
                    id: "di1b-unrelated".into(),
                    project_id: PROJECT_ID.into(),
                    request_id: "di1b-unrelated-create".into(),
                    session_id: "di1b-world".into(),
                    event_uid: "di1b-unrelated-create-event".into(),
                    origin: NarrativeChangeOrigin::Human,
                    original_transaction_id: None,
                    undo_journal_id: None,
                    parent_id: None,
                    node_type: "scene".into(),
                    title: "Unrelated".into(),
                    sort_order: "z9".into(),
                    synopsis: None,
                    status: None,
                    source_uri: None,
                    source_mtime: None,
                    content: Some("{}".into()),
                    canonical_payload: None,
                },
            )
            .expect("unrelated Scene");
            patch_node(
                &fixture,
                "di1b-unrelated",
                "title",
                "title",
                json!("Retitled"),
            );
            save_body(&fixture, "di1b-unrelated", "An unrelated body.");
        }
        Between::UserCancelThenResend => {}
        Between::RestoreEpoch => restore_labels_scope(&fixture),
        Between::TwentyNineDays => skew = Some(test_clock::advance(29 * DAY_MS)),
        Between::ThirtyOneDays => skew = Some(test_clock::advance(31 * DAY_MS)),
    }

    let resend = change == Between::UserCancelThenResend;
    let second_text = if resend {
        first_text.clone()
    } else {
        "SECOND-REQUEST".to_owned()
    };
    let second = fixture
        .add_human_message("turn-two", &second_text)
        .expect("second Human");
    if matches!(change, Between::AnchorScope | Between::RestoreEpoch) {
        // The write retired the approval the turn would have used: the turn
        // is refused before anything is created (fail closed) until a
        // Revision is approved again.
        let refusal = Nir1LocalAttempt::capture(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            &second,
            SCENE_ID,
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::writing_for_test(),
        )
        .expect("capture")
        .run()
        .err()
        .expect("a turn without an approved Revision is refused");
        assert!(
            refusal
                .reason()
                .contains("NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"),
            "{change:?}: {}",
            refusal.reason()
        );
        assert_eq!(
            fixture.attempt_count().expect("attempts"),
            1,
            "{change:?}: the refused turn created no attempt"
        );
        let workspace = workspace_of(&fixture);
        narrative_extraction::run_incremental_freshness_cycle(workspace.db().db())
            .expect("freshness cycle");
        create_approved_revision_with_key(workspace.db().db(), "nir1:prepared:approved-again")
            .expect("a Revision approved again");
    }
    let two = send_turn(&fixture, &second, "ANSWER-TWO");
    (fixture, one, two, second_text, skew)
}

/// What turn 2 carries of turn 1.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Carried {
    /// The Human and the reply.
    Both,
    /// The Human only: the reply was generated from material that no longer
    /// qualifies, the Human did not depend on it (a turn without an output is
    /// a unit of its own, DR-DI1B-5 (a)).
    HumanOnly,
    /// Nothing.
    Nothing,
}

/// (i)-(vii): the history that turn 2 carries is what the re-authorization
/// of the product gives after the change (HC-1's rules), and nothing of a
/// candidate that did not qualify reaches the payload, the input rows, the
/// qualification rows or the stored slot.
#[test]
fn same_process_change_between_turns_drops_unqualified_history() {
    use Between::*;
    for (change, carried) in [
        // Q8: a body save and the edits of an unrelated Scene keep the
        // history.
        (TargetBody, Carried::Both),
        (UnrelatedScene, Carried::Both),
        // Inside the 30 days the history stays.
        (TwentyNineDays, Carried::Both),
        // (i) A write that retires the approval of the Revision the reply
        // was generated from: the reply is gone, the Human of the same turn
        // stays (the target's own Scope token did not move).
        (AnchorScope, Carried::HumanOnly),
        // (ii) The axes, the target's own Scope, (vi) the restore epoch and
        // (vii) 31 days retire all of it.
        (Viewpoint, Carried::Nothing),
        (StoryTime, Carried::Nothing),
        (TargetScope, Carried::Nothing),
        (RestoreEpoch, Carried::Nothing),
        (ThirtyOneDays, Carried::Nothing),
        // (v) The cancelled turn's Human is not history, even when the user
        // sends the same text again.
        (UserCancelThenResend, Carried::Nothing),
    ] {
        let (fixture, one, two, second_text, _skew) = turn_two_after(change);
        let first_text = format!("{CANARY_H1} {FIRST_REQUEST}");
        let attempt = stored(&fixture, &two.attempt_id);
        let adopted_rows = attempt
            .inputs
            .iter()
            .filter(|input| input.input_use == InputUse::AdoptedHistory)
            .count();
        match carried {
            Carried::Both => {
                assert_eq!(
                    roles_of(&two.payload),
                    ["system", "user", "assistant", "user"],
                    "{change:?}: the history stays"
                );
                assert_eq!(
                    contents_of(&two.payload)[1..],
                    [
                        first_text.clone(),
                        CANARY_M1.to_owned(),
                        second_text.clone()
                    ],
                    "{change:?}"
                );
                assert_eq!(adopted_rows, 2, "{change:?}");
            }
            Carried::HumanOnly => {
                assert_eq!(
                    roles_of(&two.payload),
                    ["system", "user", "user"],
                    "{change:?}: the Human stays alone"
                );
                assert_eq!(
                    contents_of(&two.payload)[1..],
                    [first_text.clone(), second_text.clone()],
                    "{change:?}"
                );
                assert_eq!(adopted_rows, 1, "{change:?}");
            }
            Carried::Nothing => {
                assert_eq!(
                    roles_of(&two.payload),
                    ["system", "user"],
                    "{change:?}: the history is gone"
                );
                assert_eq!(messages_of(&two.payload)[1].1, second_text, "{change:?}");
                assert_eq!(adopted_rows, 0, "{change:?}");
            }
        }
        if carried != Carried::Both {
            // Nothing of the reply that did not qualify is in the request,
            // the rows or the slot.
            let rows = format!("{:?}{:?}", attempt.inputs, attempt.qualifications);
            let slot = format!("{:?}", attempt.binding);
            assert!(
                !two.payload.to_string().contains(CANARY_M1),
                "{change:?}: the reply is in the payload"
            );
            let reply_version = stored(&fixture, &one.attempt_id)
                .terminal
                .and_then(|terminal| terminal.message_version)
                .map(|version| version.id);
            for secret in [Some(CANARY_M1.to_owned()), reply_version]
                .into_iter()
                .flatten()
            {
                assert!(!rows.contains(&secret), "{change:?}: rows hold {secret}");
                assert!(!slot.contains(&secret), "{change:?}: slot holds {secret}");
            }
        }
        if carried == Carried::Nothing {
            // Nor is anything of the Human (a resend repeats its text as the
            // current Human, which is not history).
            if change != UserCancelThenResend {
                assert!(
                    !two.payload.to_string().contains(CANARY_H1),
                    "{change:?}: the Human is in the payload"
                );
            }
            let rows = format!("{:?}{:?}", attempt.inputs, attempt.qualifications);
            assert!(
                !rows.contains(&one.attempt_id),
                "{change:?}: the attempt of turn 1 is named"
            );
        }
    }
}

/// The chain goes on after the changes that keep the history: the turn after
/// them adopts the turn in between as well (Q8 and an unrelated edit), and
/// after a write that took the reply of turn 1 away the next turn adopts the
/// Human of turn 1 and the reply that came after it.
#[test]
fn the_chain_continues_after_the_changes_that_keep_history() {
    for (change, expected_roles, expected_canary_reply) in [
        (
            Between::TargetBody,
            &["system", "user", "assistant", "user", "assistant", "user"][..],
            true,
        ),
        (
            Between::UnrelatedScene,
            &["system", "user", "assistant", "user", "assistant", "user"][..],
            true,
        ),
        (
            Between::AnchorScope,
            &["system", "user", "user", "assistant", "user"][..],
            false,
        ),
    ] {
        let (fixture, _one, _two, _text, _skew) = turn_two_after(change);
        let third = fixture
            .add_human_message("turn-three", "THIRD-REQUEST")
            .unwrap();
        let three = send_turn(&fixture, &third, "ANSWER-THREE");
        assert_eq!(roles_of(&three.payload), expected_roles, "{change:?}");
        let contents = contents_of(&three.payload);
        assert!(contents.iter().any(|c| c.contains(CANARY_H1)), "{change:?}");
        assert!(contents.contains(&"ANSWER-TWO".to_owned()), "{change:?}");
        assert_eq!(
            contents.contains(&CANARY_M1.to_owned()),
            expected_canary_reply,
            "{change:?}"
        );
    }
}

/// The 30 days end at the Native clock: a past turn is still history at 29
/// days and gone at 31, the boundary is the window of the store.
#[test]
fn the_thirty_day_window_follows_the_native_clock() {
    let fixture = ready_fixture();
    send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    // The window is a store constant: 30 days.
    assert_eq!(HISTORY_ELIGIBILITY_WINDOW_MS, 30 * DAY_MS);
    let probe = |days: i64, key: &str, kept: bool| {
        let _skew = test_clock::advance(days * DAY_MS);
        let submission = fixture.add_human_message(key, "NEXT-REQUEST").unwrap();
        let handoff = prepare(&fixture, &submission);
        let payload: Value = serde_json::from_str(handoff.canonical_payload()).unwrap();
        assert_eq!(
            roles_of(&payload).len(),
            if kept { 4 } else { 2 },
            "{days} days: kept {kept}"
        );
    };
    probe(1, "day-1", true);
    probe(29, "day-29", true);
    probe(31, "day-31", false);
}

// ---------------------------------------------------------------------------
// Other sessions, the renderer, and the checks before the send
// ---------------------------------------------------------------------------

#[test]
fn other_session_history_is_absent() {
    let fixture = ready_fixture();
    send_turn(&fixture, &fixture.message_version_id, CANARY_M1);
    let other_session = "nir1-prepared-other-session";
    workspace_of(&fixture)
        .db()
        .db()
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO chat_sessions(id,project_id,node_id) VALUES (?1,?2,?3)",
                (other_session, PROJECT_ID, SCENE_ID),
            )?;
            Ok(())
        })
        .expect("session");
    let submission = NewChatInputSubmission::new(
        "nir1-prepared-submission-other-session".into(),
        "nir1-prepared-other-session-message".into(),
        other_session.into(),
        SCENE_ID.into(),
        "The first request of a new conversation.".into(),
        "2026-09-26T10:00:00.000Z".into(),
    )
    .unwrap();
    let accepted = accept_current_chat_submission(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        &submission,
    )
    .expect("accepted in the other session");
    let handoff = prepare(&fixture, &accepted);
    let payload: Value = serde_json::from_str(handoff.canonical_payload()).unwrap();
    assert_eq!(roles_of(&payload), ["system", "user"]);
    assert!(!payload.to_string().contains(CANARY_M1));
    assert!(!payload.to_string().contains(FIRST_REQUEST));
}

#[test]
fn renderer_cannot_supply_history() {
    let fixture = ready_fixture();
    send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    let second = fixture
        .add_human_message("turn-two", "SECOND-REQUEST")
        .unwrap();
    let before = fixture.generation_storage_counts().unwrap();
    let error = prepare_selected_local_chat_request(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        &second,
        UnsupportedInputIntent::from_presence(false, true, false),
        LocalGenerationIntent::writing_for_test(),
    )
    .err()
    .expect("a renderer history is refused");
    assert_eq!(error.to_string(), "NIR1_PREPARED_HISTORY_INPUT_UNSUPPORTED");
    assert_eq!(fixture.generation_storage_counts().unwrap(), before);
}

#[test]
fn history_run_writes_nothing_in_the_d_final_snapshot() {
    let fixture = ready_fixture();
    send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    let second = fixture
        .add_human_message("turn-two", "SECOND-REQUEST")
        .unwrap();
    let rows_before = fixture.generation_storage_counts().unwrap();
    let handoff = prepare(&fixture, &second);
    assert_eq!(history_rows(&handoff).len(), 2, "the history was adopted");
    assert_eq!(
        fixture.generation_storage_counts().unwrap(),
        rows_before,
        "the preparation, history included, writes no generation row"
    );
}

/// The return-time re-check (`revalidate`): a history that stops qualifying
/// between the render and the return stops the turn. (A past reply is
/// rewritten by the renderer; the Raw and the Revisions are untouched.)
#[test]
fn revalidation_rejects_history_that_stops_qualifying_after_render() {
    let fixture = ready_fixture();
    let one = send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    let second = fixture
        .add_human_message("turn-two", "SECOND-REQUEST")
        .unwrap();
    let error = prepare_local_chat_request_with_test_hook(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        &second,
        std::slice::from_ref(&fixture.revision_id),
        || {
            rewrite_message(&fixture, &format!("{}-reply", one.attempt_id));
            Ok(())
        },
    )
    .err()
    .expect("the history no longer qualifies");
    assert!(
        error
            .to_string()
            .contains("NIR1_NATIVE_PREPARED_HISTORY_STALE"),
        "{error:#}"
    );
}

fn rewrite_message(fixture: &Fixture, message_id: &str) {
    workspace_of(fixture)
        .db()
        .db()
        .execute_renderer(
            "UPDATE chat_messages SET content = ?1 WHERE id = ?2",
            &[json!("a rewritten reply"), json!(message_id)],
            "run",
        )
        .expect("renderer rewrite");
}

/// The dispatch-time re-check (`reobserve_prepared_for_dispatch`): a change
/// after the create stops the attempt before the claim, and nothing is sent.
#[test]
fn reobserve_for_dispatch_rejects_stale_history() {
    let fixture = ready_fixture();
    let one = send_turn(&fixture, &fixture.message_version_id, "ANSWER-ONE");
    let second = fixture
        .add_human_message("turn-two", "SECOND-REQUEST")
        .unwrap();
    let target = ProbeTarget {
        state: Arc::clone(&fixture.state),
        message_id: format!("{}-reply", one.attempt_id),
    };
    let outcome = Nir1LocalAttempt::capture(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        &second,
        SCENE_ID,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .expect("capture")
    .with_probe(move |probe| {
        if probe == Nir1LocalAttemptProbe::AfterCreate {
            target.rewrite_reply();
        }
    })
    .run()
    .expect("the coordinator settles the attempt");
    match outcome {
        Nir1LocalAttemptOutcome::Abandoned { reason, .. } => assert!(
            reason.contains("NIR1_NATIVE_PREPARED_HISTORY_STALE"),
            "{reason}"
        ),
        Nir1LocalAttemptOutcome::Start(_) => panic!("a stale history must not be sent"),
        Nir1LocalAttemptOutcome::NotStarted(settlement) => {
            panic!("not started, not abandoned: {settlement:?}")
        }
    }
}

/// A turn that failed (its transport ended without an answer) is a unit of
/// its own: its Human stays history when the next request is a different
/// one, and a request sent again with the same text does not repeat it
/// (DR-DI1B-5 (a) and (b)).
#[test]
fn failed_turn_human_and_retry_duplicate_through_the_product_path() {
    let failed_first_turn = || {
        let fixture = ready_fixture();
        let outcome = Nir1LocalAttempt::capture(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            &fixture.message_version_id,
            SCENE_ID,
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::writing_for_test(),
        )
        .expect("capture")
        .run()
        .expect("run");
        let Nir1LocalAttemptOutcome::Start(transport) = outcome else {
            panic!("the turn must start")
        };
        // The transport ends without an answer: the conservative terminal.
        drop(transport);
        fixture
    };
    // (a) A different request: the failed turn's Human is history.
    let fixture = failed_first_turn();
    let second = fixture
        .add_human_message("turn-two", "A DIFFERENT REQUEST")
        .unwrap();
    let two = send_turn(&fixture, &second, "ANSWER-TWO");
    assert_eq!(roles_of(&two.payload), ["system", "user", "user"]);
    assert_eq!(
        contents_of(&two.payload)[1..],
        [FIRST_REQUEST, "A DIFFERENT REQUEST"]
    );
    // (b) The same text sent again: the earlier Human is not repeated.
    let fixture = failed_first_turn();
    let second = fixture
        .add_human_message("turn-two", FIRST_REQUEST)
        .unwrap();
    let two = send_turn(&fixture, &second, "ANSWER-TWO");
    assert_eq!(roles_of(&two.payload), ["system", "user"]);
    assert_eq!(contents_of(&two.payload)[1..], [FIRST_REQUEST]);
    // The turn after the retry has the answered turn only.
    let third = fixture
        .add_human_message("turn-three", "THIRD-REQUEST")
        .unwrap();
    let three = send_turn(&fixture, &third, "ANSWER-THREE");
    assert_eq!(
        contents_of(&three.payload)[1..],
        [FIRST_REQUEST, "ANSWER-TWO", "THIRD-REQUEST"]
    );
}

/// DR-DI1B-9c: a session at the limit of the candidate attempts. The run
/// reads at most 128 attempts of a session; the attempt a turn creates is part
/// of the session by the dispatch-time re-check but is not history, so a turn
/// prepared with 127 or 128 attempts behind it is not refused for its own
/// attempt. With one more attempt than the run can enumerate the turn goes on
/// without history (a spent budget is "no history", never a stop).
#[test]
#[ignore = "129 turns through the product path take about 4 minutes in a debug build; run with --ignored"]
fn a_session_at_the_attempt_limit_still_passes_the_dispatch_check() {
    let fixture = ready_fixture();
    // 127 turns that fail without an answer (the cheapest attempt the product
    // path writes), then the 128th attempt is prepared, created, re-checked
    // and claimed.
    let fail = |submission: &NativeAcceptedChatSubmission| {
        let outcome = Nir1LocalAttempt::capture(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            submission,
            SCENE_ID,
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::writing_for_test(),
        )
        .expect("capture")
        .run()
        .expect("run");
        let Nir1LocalAttemptOutcome::Start(transport) = outcome else {
            panic!("the turn must start")
        };
        let payload: Value = serde_json::from_str(transport.canonical_payload()).unwrap();
        drop(transport);
        payload
    };
    fail(&fixture.message_version_id);
    for index in 1..127 {
        let submission = fixture
            .add_human_message(&format!("limit-{index}"), &format!("REQUEST {index}"))
            .unwrap();
        fail(&submission);
    }
    assert_eq!(fixture.attempt_count().unwrap(), 127);
    // The 128th attempt: 127 behind it. Its history is the last turns (the
    // window is 16 turns), and the dispatch check passes.
    let submission = fixture
        .add_human_message("limit-127", "REQUEST 127")
        .unwrap();
    let last = fail(&submission);
    assert_eq!(fixture.attempt_count().unwrap(), 128);
    assert_eq!(
        roles_of(&last).len(),
        18,
        "16 turns of history, the system message and the Human"
    );
    // 128 attempts are behind the next turn: the run reads them all, the
    // attempt it creates is the 129th, and the dispatch check leaves its own
    // attempt out.
    let submission = fixture
        .add_human_message("limit-128", "REQUEST 128")
        .unwrap();
    let last = fail(&submission);
    assert_eq!(fixture.attempt_count().unwrap(), 129);
    assert_eq!(roles_of(&last).len(), 18);
    // 129 attempts are behind the next turn: the session cannot be read to
    // its end, the turn goes on without history.
    let submission = fixture
        .add_human_message("limit-129", "REQUEST 129")
        .unwrap();
    let last = fail(&submission);
    assert_eq!(roles_of(&last), ["system", "user"]);
}

struct ProbeTarget {
    state: Arc<AppState>,
    message_id: String,
}

impl ProbeTarget {
    fn rewrite_reply(&self) {
        active_workspace_snapshot(&self.state.ws)
            .expect("workspace")
            .db()
            .db()
            .execute_renderer(
                "UPDATE chat_messages SET content = ?1 WHERE id = ?2",
                &[json!("a rewritten reply"), json!(self.message_id)],
                "run",
            )
            .expect("renderer rewrite");
    }
}

/// The same numbers as the JS test `budget parity vector: the Native
/// arithmetic with a history` (scripts/quality/nir1-packing/final-request/
/// payload.test.mjs): the text of the system message, the Human and the
/// history message (one token each), the envelope of three messages
/// (4 * 3 + 2), the output limit and the safety margin.
#[test]
fn budget_with_history_matches_the_js_mirror() {
    let history = [RenderedHistoryMessage {
        role: "user",
        text: "h",
    }];
    let usage = final_plain_chat_budget_usage("s", &history, "u", 64, 4096).unwrap();
    assert_eq!(usage.history_tokens, 1);
    assert_eq!(usage.conversation_tokens, 2);
    assert_eq!(usage.envelope_tokens, 14);
    assert_eq!(usage.input_tokens, 1 + 2 + 14);
    assert_eq!(usage.reserved_total_tokens, 1 + 1 + 1 + 14 + 64 + 32);
    // Without a history: the arithmetic of before.
    let bare = final_plain_chat_budget_usage("s", &[], "u", 64, 4096).unwrap();
    assert_eq!(bare.history_tokens, 0);
    assert_eq!(bare.envelope_tokens, 10);
    assert_eq!(bare.reserved_total_tokens, 1 + 1 + 10 + 64 + 32);
    // A history message adds exactly its envelope constant; the selector's
    // budget (`non_context_budget_for_user`) counts two messages only.
    assert_eq!(
        plain_chat_message_envelope_tokens(3).unwrap()
            - plain_chat_message_envelope_tokens(2).unwrap(),
        PLAIN_CHAT_MESSAGE_ENVELOPE_TOKENS
    );
    assert!(plain_chat_message_envelope_tokens(usize::MAX).is_err());
}
