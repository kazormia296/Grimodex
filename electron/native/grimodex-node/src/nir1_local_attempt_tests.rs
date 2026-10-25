//! Tests of the DI-1c coordinator (S3). Acceptance IDs in the comments refer
//! to the DI-1c TASK (A-9 to A-13, A-19). The recorder counts sends: a
//! transport that was never started is a send of zero.

use super::*;
use crate::nir1_prepared_request::tests::{
    create_approved_revision_with_key, graph_candidates_for, write_graph_seal, write_local_route,
    Fixture, GRAPH_GENERATION, NO_UNSUPPORTED_INPUTS, PROJECT_ID, REVISION_SCENE_ID, SCENE_ID,
    SESSION_ID,
};
use crate::nir1_prepared_request::MainKeyVerdict;
use grimodex_core::narrative_nir1_receipt::{
    Completion, OutputChannel, OutputObserver, ProviderTerminal, TerminalObservation,
};
use grimodex_db::narrative_extraction::{
    self, NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
};
use grimodex_db::nir1_generation::history_context::HISTORY_ELIGIBILITY_WINDOW_MS;
use grimodex_db::nir1_generation::Nir1StoreFailure;
use grimodex_db::nir1_generation::{
    self as generation_storage, D1SelectionParameters, FailureClassification, GenerationPurpose,
    InputTarget, NewMessageBody, NotApplicableReason, QualificationBody, QualificationKind,
    StoredAttempt,
};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const READ: ReadBudget = NIR1_LOCAL_ATTEMPT_READ_BUDGET;

fn ready_fixture() -> Fixture {
    let fixture = Fixture::new().expect("fixture");
    assert!(
        crate::nir1_generation::sweep_and_open_ready_entry_for_test(&fixture.state),
        "the startup gate opens after the sweep"
    );
    fixture
}

fn capture(fixture: &Fixture) -> Nir1LocalAttempt {
    Nir1LocalAttempt::capture(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        &fixture.message_version_id,
        SCENE_ID,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|refusal| panic!("capture refused: {refusal:?}"))
}

/// The recorder is the transport: one `Start` is one send (DG-2).
#[derive(Default)]
struct Recorder {
    sends: AtomicUsize,
}

impl Recorder {
    fn sends(&self) -> usize {
        self.sends.load(Ordering::SeqCst)
    }

    /// Count what a finished run would send: a `Start` is the only send
    /// authority, so any other result is a send of zero. The transport is
    /// dropped unsent (its drop writes the conservative terminal), so this
    /// observes a run without finishing it.
    fn observe(&self, result: &RunResult) {
        if matches!(result, Ok(Nir1LocalAttemptOutcome::Start(_))) {
            self.sends.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Record the send of a `Start` and settle it with an answer; every other
    /// outcome sends nothing.
    fn send(&self, outcome: Nir1LocalAttemptOutcome, message_id: &str) {
        let Nir1LocalAttemptOutcome::Start(transport) = outcome else {
            return;
        };
        self.sends.fetch_add(1, Ordering::SeqCst);
        transport
            .finish(
                &completed("recorded answer"),
                Some(NewMessageBody {
                    message_id: message_id.into(),
                    content: "recorded answer".into(),
                    thinking: String::new(),
                }),
            )
            .expect("terminal after the recorded send");
    }
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

fn workspace_of(fixture: &Fixture) -> ActiveWorkspaceSnapshot {
    active_workspace_snapshot(&fixture.state.ws).expect("workspace")
}

fn attempt_ids(fixture: &Fixture) -> Vec<String> {
    workspace_of(fixture)
        .db()
        .db()
        .with_read_transaction(|conn| {
            let mut statement =
                conn.prepare("SELECT id FROM nir1_generation_attempts ORDER BY id")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .expect("attempt ids")
}

fn stored(fixture: &Fixture, id: &str) -> StoredAttempt {
    generation_storage::read_attempt(workspace_of(fixture).db().db(), id, READ)
        .expect("stored attempt")
}

fn binding_json(fixture: &Fixture, id: &str) -> String {
    workspace_of(fixture)
        .db()
        .db()
        .with_read_transaction(|conn| {
            conn.query_row(
                "SELECT binding_json FROM nir1_generation_attempts WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("binding json")
}

/// The request the coordinator would create now, for the digest tests.
fn final_request(
    fixture: &Fixture,
    submission: &NativeAcceptedChatSubmission,
) -> FinalDispatchRequest {
    let selected = prepare_selected_local_chat_request(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        submission,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|error| panic!("selected request: {error:#}"));
    let (request, scene, expected_scope, _witness) = selected.into_parts();
    let handoff = request.into_d_transport_handoff();
    build_final_dispatch_request(submission, &handoff, scene, expected_scope)
        .expect("final request")
}

// ---------------------------------------------------------------------------
// Product-shaped changes, injected between the preparation and the dispatch.
// ---------------------------------------------------------------------------

/// What a probe closure needs to change the world; owned, so the closure can
/// be `'static`.
#[derive(Clone)]
pub(crate) struct Target {
    state: Arc<AppState>,
    caller: CallerIdentity,
    revision_id: String,
}

impl Target {
    pub(crate) fn of(fixture: &Fixture) -> Self {
        Self {
            state: Arc::clone(&fixture.state),
            caller: fixture.caller.clone(),
            revision_id: fixture.revision_id.clone(),
        }
    }

    fn workspace(&self) -> ActiveWorkspaceSnapshot {
        active_workspace_snapshot(&self.state.ws).expect("workspace")
    }
}

/// A write must touch exactly one row.
fn one_row(changed: Result<usize>, what: &str) {
    assert_eq!(changed.expect(what), 1, "{what} must touch exactly one row");
}

fn save_scene_scope(target: &Target, scene_id: &str, request_id: &str) {
    let workspace = target.workspace();
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
            updated_at: "2026-10-18T00:00:00.000Z".into(),
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

/// The kinds of change that the dispatch-time check must not let a prepared
/// request survive (K6/2 DI-1c). `CHANGES` is the seven that every request
/// answers to. The eighth, an index generation, is an input of a request that
/// has Graph-derived inputs only (DI-1a): `GRAPH_CHANGES` adds it, and a
/// request without a Graph does not answer to it (see
/// `a9_an_index_generation_is_not_an_input_of_the_final_request`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Change {
    /// The target Scene's Scope setting is saved by the product writer.
    Scope,
    /// The Raw Source body changes.
    Source,
    /// The anchor Scene's Scope changes, so the adopted Revision's authority
    /// no longer has the Scope it was qualified with.
    Revision,
    /// The Decision row of the adopted Revision changes.
    Decision,
    /// An Evidence Source of the Revision changes, so its canonical Freshness
    /// is no longer the one that qualified it.
    Freshness,
    /// The route settings are rewritten without the profile's revoking write.
    Route,
    /// The profile's route update, which revokes every counted permit.
    Revocation,
    /// B is rebuilt and sealed again: the Graph Index has a new generation.
    IndexGeneration,
}

const GRAPH_CHANGES: [Change; 8] = [
    Change::Scope,
    Change::Source,
    Change::Revision,
    Change::Decision,
    Change::Freshness,
    Change::Route,
    Change::Revocation,
    Change::IndexGeneration,
];

const CHANGES: [Change; 7] = [
    Change::Scope,
    Change::Source,
    Change::Revision,
    Change::Decision,
    Change::Freshness,
    Change::Route,
    Change::Revocation,
];

pub(crate) fn inject(target: &Target, change: Change) {
    let db = || target.workspace();
    match change {
        Change::Scope => save_scene_scope(target, SCENE_ID, "di1c-scope-save"),
        Change::Source => one_row(
            db().db().with_conn(|conn| {
                Ok(conn.execute(
                    "UPDATE tree_nodes
                        SET content=?1, version=version+1, updated_at='2026-10-18T00:00:00.000Z'
                      WHERE project_id=?2 AND id=?3 AND node_type='scene'",
                    (
                        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Raw changed after the preparation."}]}]}).to_string(),
                        PROJECT_ID,
                        SCENE_ID,
                    ),
                )?)
            }),
            "the Raw body change",
        ),
        Change::Revision => save_scene_scope(target, REVISION_SCENE_ID, "di1c-anchor-scope-save"),
        Change::Decision => one_row(
            db().db().with_conn(|conn| {
                Ok(conn.execute(
                    "UPDATE narrative_proposal_decisions SET decision_json=?1 WHERE revision_id=?2",
                    (
                        json!({"reviewerNote":"Decision changed after the preparation"})
                            .to_string(),
                        target.revision_id.as_str(),
                    ),
                )?)
            }),
            "the Decision change",
        ),
        Change::Freshness => one_row(
            db().db().with_conn(|conn| {
                Ok(conn.execute(
                    "UPDATE codex_entries SET summary=?1, updated_at='2026-10-18T00:00:00Z'
                      WHERE project_id=?2 AND id='nir1-prepared-bob'",
                    ("Changed Evidence Source", PROJECT_ID),
                )?)
            }),
            "the Evidence Source change",
        ),
        Change::Route => {
            // Not the profile's revoking writer: only the settings change.
            write_local_route(&target.state, "http://127.0.0.1:12346/v1", 16_384, 1024)
                .expect("route settings");
        }
        Change::Revocation => {
            target
                .state
                .profile_egress
                .with_route_update(|| {
                    write_local_route(&target.state, "http://127.0.0.1:12347/v1", 16_384, 1024)
                })
                .expect("route update");
        }
        Change::IndexGeneration => {
            write_graph_seal(&target.state, GRAPH_GENERATION + 1, false).expect("seal again");
        }
    }
}

type Seen = Arc<Mutex<Vec<Nir1LocalAttemptProbe>>>;

/// A coordinator whose probe injects `change` at `point` and records the
/// probe points it saw.
fn attempt_with_change(
    fixture: &Fixture,
    point: Nir1LocalAttemptProbe,
    change: Change,
) -> (Nir1LocalAttempt, Seen) {
    let seen: Seen = Arc::default();
    let recorded = Arc::clone(&seen);
    let target = Target::of(fixture);
    let attempt = capture(fixture).with_probe(move |probe| {
        recorded.lock().expect("probe log").push(probe);
        if probe == point {
            inject(&target, change);
        }
    });
    (attempt, seen)
}

/// The terminal of an attempt that was never sent: a transport-less terminal
/// and no claim.
fn assert_never_sent(fixture: &Fixture, id: &str) {
    let attempt = stored(fixture, id);
    assert_eq!(attempt.claimed_at_ms, None, "nothing was claimed");
    let terminal = attempt.terminal.expect("a zero-send terminal");
    assert_eq!(terminal.message_version, None, "no answer was stored");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );
}

// ---------------------------------------------------------------------------
// A-10 / A-13: the real path (DG-1) and the digest bindings.
// ---------------------------------------------------------------------------

/// A-10, DG-1: capture, Native selection, handoff, create, re-read. What is
/// stored is what the payload carries, and the Scene, the Scope token and the
/// restore epoch are the values of the D-final snapshot.
#[test]
fn a10_the_real_path_stores_what_the_payload_carries() {
    let fixture = ready_fixture();
    let attempt_id = generation_storage::attempt_id_for_capture(&fixture.message_version_id)
        .expect("attempt id");
    let planned = final_request(&fixture, &fixture.message_version_id);
    let expected_scope = workspace_of(&fixture)
        .db()
        .db()
        .with_read_transaction(|conn| {
            generation_storage::read_expected_scope_in_tx(conn, PROJECT_ID, SCENE_ID)
        })
        .expect("expected scope");

    let outcome = start_local_attempt(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        &fixture.message_version_id,
        SCENE_ID,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|refusal| panic!("the coordinator refused: {refusal:?}"));
    let Nir1LocalAttemptOutcome::Start(transport) = &outcome else {
        panic!("the coordinator must start the transport")
    };
    assert_eq!(transport.attempt_id(), attempt_id);
    // The payload the transport would send is the one that was prepared.
    let sent: Value = serde_json::from_str(transport.canonical_payload()).expect("payload json");
    assert_eq!(sent, planned.payload);

    let attempt = stored(&fixture, &attempt_id);
    assert!(attempt.claimed_at_ms.is_some(), "the claim is durable");
    assert_eq!(
        attempt.payload_digest,
        crate::nir1_generation::final_payload_digest(&planned.payload).expect("digest")
    );
    assert_eq!(attempt.inputs, planned.inputs);
    assert_eq!(attempt.qualifications, planned.qualifications);
    assert_eq!(
        attempt.input_digest,
        crate::nir1_generation::final_input_digest(&planned.inputs, &planned.qualifications)
            .expect("input digest")
    );
    // Snapshot-bound values.
    let binding = &attempt.binding;
    assert_eq!(binding.scene, planned.scene);
    let scene_now = workspace_of(&fixture)
        .db()
        .db()
        .with_read_transaction(|conn| {
            generation_storage::read_attempt_scene_binding_in_tx(conn, PROJECT_ID, SCENE_ID)
        })
        .expect("scene");
    assert_eq!(binding.scene, scene_now);
    assert_eq!(planned.expected_scope, expected_scope);
    let Some(HistoryContextSlot::Context(context)) = &binding.history_turn_context else {
        panic!("the stored slot is a context")
    };
    let token = expected_scope.scope_binding.as_ref().expect("scope row");
    assert_eq!(context.target.binding_token_digest, token.token_digest);
    let epoch = expected_scope.restore_epoch.as_ref().expect("epoch row");
    assert_eq!(context.restore_epoch.id_digest, epoch.id_digest);
    // The comparison marker is the D1 selection digest (R-10).
    assert_eq!(binding.d1_digest, context.d1.selection_digest.as_str());
    assert_eq!(
        binding.d1_digest,
        d1_selection_digest(
            &D1SelectionParameters {
                estimator_version: context.d1.estimator_version.as_wire().to_owned(),
                selector_budget_tokens: context.d1.selector_budget_tokens.get(),
                used_tokens: context.d1.used_tokens.get(),
                remaining_tokens: context.d1.remaining_tokens.get(),
            },
            &attempt.inputs
        )
        .expect("d1 digest")
    );
    // The purpose is the typed intent's (R-9); the route values are the
    // prepared route's.
    assert_eq!(binding.purpose, GenerationPurpose::Writing);
    assert_eq!(binding.provider, "openai-compatible");
    assert_eq!(binding.model, "fixture-local-model");
    assert_eq!(binding.api, "chat-completions");
    // The times are Native's: a lifetime, never a caller's time.
    assert_eq!(
        attempt.expires_at_ms - attempt.created_at_ms,
        NIR1_LOCAL_ATTEMPT_LIFETIME_MS
    );
    assert_eq!(
        i64::try_from(context.eligible_until_ms.get()).expect("eligibility fits"),
        attempt.created_at_ms + HISTORY_ELIGIBILITY_WINDOW_MS
    );
    // Only digests: no URL, endpoint id, label, port, body text or key.
    let wire = binding_json(&fixture, &attempt_id);
    for secret in [
        "127.0.0.1",
        "12345",
        "\"fixture-local\"",
        "\"fixture\"",
        "http://",
        "Alice looked at Bob",
        "Continue this scene",
        "api_key",
        "apiKey",
    ] {
        assert!(
            !wire.contains(secret),
            "the stored binding carries no {secret}"
        );
    }
    let recorder = Recorder::default();
    recorder.send(outcome, "a10-answer");
    assert_eq!(recorder.sends(), 1);
    assert!(stored(&fixture, &attempt_id).terminal.is_some());
}

/// A-13: the scope, material and d1 digests follow their inputs, and the
/// endpoint identity is the credential-free digest of the route.
#[test]
fn a13_the_digests_follow_their_inputs() {
    let fixture = ready_fixture();
    let base = final_request(&fixture, &fixture.message_version_id);
    for digest in [
        &base.scope_digest,
        &base.material_digest,
        &base.d1_digest,
        &base.endpoint_identity,
    ] {
        assert!(digest.starts_with("sha256:"), "a digest: {digest}");
    }
    // Deterministic: the same inputs give the same digests.
    let again = final_request(&fixture, &fixture.message_version_id);
    assert_eq!(again.scope_digest, base.scope_digest);
    assert_eq!(again.material_digest, base.material_digest);
    assert_eq!(again.d1_digest, base.d1_digest);
    assert_eq!(again.endpoint_identity, base.endpoint_identity);

    // The target Scene's Scope token: the scope digest follows.
    let target = Target::of(&fixture);
    save_scene_scope(&target, SCENE_ID, "a13-scope-save");
    let scope_changed = final_request(&fixture, &fixture.message_version_id);
    assert_ne!(scope_changed.scope_digest, base.scope_digest);

    // The Raw Source token: the material digest follows.
    let fixture = ready_fixture();
    let target = Target::of(&fixture);
    let base = final_request(&fixture, &fixture.message_version_id);
    inject(&target, Change::Source);
    let raw_changed = final_request(&fixture, &fixture.message_version_id);
    assert_ne!(raw_changed.material_digest, base.material_digest);

    // Another adopted Revision (a different bundle): the material digest and
    // the Scope identity of the adopted authorities follow.
    let fixture = ready_fixture();
    let base = final_request(&fixture, &fixture.message_version_id);
    create_approved_revision_with_key(
        workspace_of(&fixture).db().db(),
        "nir1:prepared:accepted-ir-second",
    )
    .expect("a second Revision");
    let two_revisions = final_request(&fixture, &fixture.message_version_id);
    assert_ne!(two_revisions.material_digest, base.material_digest);
    assert_ne!(two_revisions.scope_digest, base.scope_digest);
    assert_ne!(two_revisions.d1_digest, base.d1_digest);

    // The endpoint identity follows the route's address. The profile's route
    // update revokes the older capture, so a new one is accepted.
    let fixture = ready_fixture();
    let target = Target::of(&fixture);
    let base = final_request(&fixture, &fixture.message_version_id);
    inject(&target, Change::Revocation);
    fixture
        .state
        .profile_egress
        .register_caller(&fixture.caller)
        .expect("register the caller again");
    let submission = fixture
        .add_human_message("a13-route", "Continue after the route change.")
        .expect("a new capture");
    let route_changed = final_request(&fixture, &submission);
    assert_ne!(route_changed.endpoint_identity, base.endpoint_identity);
}

/// A request without a Graph has no Graph-derived input, and every Index row
/// is a typed N/A (A-9 of DI-1c, read this way by DI-1a). A change of an index
/// generation therefore does not reach it; a request with Graph-derived inputs
/// is covered by the `a3_` tests below.
#[test]
fn a9_an_index_generation_is_not_an_input_of_a_request_without_a_graph() {
    let fixture = ready_fixture();
    let request = final_request(&fixture, &fixture.message_version_id);
    assert!(request
        .inputs
        .iter()
        .all(|input| !matches!(input.target, InputTarget::GraphEvidence { .. })));
    let index_rows = request
        .qualifications
        .iter()
        .filter(|row| row.kind == QualificationKind::Index)
        .collect::<Vec<_>>();
    assert!(
        !index_rows.is_empty(),
        "every Revision input has an Index row"
    );
    for row in index_rows {
        assert!(
            matches!(
                &row.body,
                QualificationBody::NotApplicable {
                    reason: NotApplicableReason::NotIndexDerived,
                    ..
                }
            ),
            "an Index row is not applicable: {row:?}"
        );
    }
    // B is sealed after the create: the request has no input to re-observe it
    // for, and is claimed.
    let (_, recorder, _, result) =
        run_with_change(Nir1LocalAttemptProbe::AfterCreate, Change::IndexGeneration);
    assert!(
        matches!(result, Ok(Nir1LocalAttemptOutcome::Start(_))),
        "a request without a Graph answers to no index generation: {}",
        describe(&result)
    );
    assert_eq!(recorder.sends(), 1);
}

// ---------------------------------------------------------------------------
// A-9: changes between the preparation and the dispatch.
// ---------------------------------------------------------------------------

type RunResult = Result<Nir1LocalAttemptOutcome, Nir1LocalAttemptRefusal>;

/// Run one change at one point, with the recorder as the only sink.
fn run_with_change(
    point: Nir1LocalAttemptProbe,
    change: Change,
) -> (Fixture, Recorder, Seen, RunResult) {
    let fixture = ready_fixture();
    let (attempt, seen) = attempt_with_change(&fixture, point, change);
    let result = attempt.run();
    // The recorder is the only sink: it counts a `Start`, nothing else.
    let recorder = Recorder::default();
    recorder.observe(&result);
    (fixture, recorder, seen, result)
}

fn abandoned_reason(result: &RunResult) -> &str {
    match result {
        Ok(Nir1LocalAttemptOutcome::Abandoned { reason, .. }) => reason,
        Ok(Nir1LocalAttemptOutcome::NotStarted(settlement)) => {
            panic!("not started, not abandoned: {settlement:?}")
        }
        Ok(Nir1LocalAttemptOutcome::Start(_)) => panic!("the transport must not start"),
        Err(refusal) => panic!("the attempt must be abandoned, was refused: {refusal:?}"),
    }
}

fn describe(result: &RunResult) -> String {
    match result {
        Ok(Nir1LocalAttemptOutcome::Start(_)) => "started".into(),
        Ok(Nir1LocalAttemptOutcome::NotStarted(settlement)) => {
            format!("not started: {settlement:?}")
        }
        Ok(Nir1LocalAttemptOutcome::Abandoned { reason, settlement }) => {
            format!("abandoned ({reason}): {settlement:?}")
        }
        Err(refusal) => format!("refused: {}", refusal.reason()),
    }
}

fn assert_zero_send_settlement(result: &RunResult) {
    let settlement = match result {
        Ok(Nir1LocalAttemptOutcome::Abandoned { settlement, .. })
        | Ok(Nir1LocalAttemptOutcome::NotStarted(settlement)) => settlement,
        _ => panic!("the attempt must not start: {}", describe(result)),
    };
    assert!(
        matches!(settlement, Nir1Settlement::ZeroSend(_)),
        "one zero-send terminal: {settlement:?}"
    );
}

/// A-9 (after the create, before the re-observation): every change is found
/// by the dispatch-time check. The recorder receives nothing and the attempt
/// ends with a transport-less terminal.
#[test]
fn a9_every_change_after_the_create_abandons_the_attempt() {
    for change in CHANGES {
        let (fixture, recorder, seen, result) =
            run_with_change(Nir1LocalAttemptProbe::AfterCreate, change);
        assert!(
            seen.lock()
                .expect("probe log")
                .contains(&Nir1LocalAttemptProbe::AfterCreate),
            "{change:?}: the change was injected after the create"
        );
        assert!(
            !seen
                .lock()
                .expect("probe log")
                .contains(&Nir1LocalAttemptProbe::BeforeClaim),
            "{change:?}: the claim is never reached"
        );
        let reason = abandoned_reason(&result).to_owned();
        let expected: &[&str] = match change {
            Change::Source => &[
                "NIR1_NATIVE_RAW_SOURCE_STALE",
                "NIR1_NATIVE_PREPARED_RAW_SOURCE_BODY_STALE",
            ],
            Change::Scope | Change::Revision | Change::Decision | Change::Freshness => {
                &["NIR1_NATIVE_PREPARED_REVISION_STALE"]
            }
            Change::Route => &["NIR1_PREPARED_ROUTE_CHANGED"],
            Change::Revocation => &["D2A_EGRESS_DENIED", "NIR1_PREPARED_ROUTE_REVOKED"],
            Change::IndexGeneration => &["NIR1_NATIVE_PREPARED_GRAPH_STALE"],
        };
        assert!(
            expected.iter().any(|code| reason.contains(code)),
            "{change:?}: unexpected reason {reason}"
        );
        assert_zero_send_settlement(&result);
        let ids = attempt_ids(&fixture);
        assert_eq!(ids.len(), 1, "{change:?}: the attempt row exists once");
        assert_never_sent(&fixture, &ids[0]);
        assert_eq!(recorder.sends(), 0, "{change:?}: nothing is sent");
        assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    }
}

/// A-9 (after the preparation, before the create): the create re-reads the
/// Scope binding and the Scene incarnation, so a saved Scope or a changed Raw
/// body creates no attempt at all, and a revoked permit is refused by the
/// owner; every other change is found by the dispatch-time check after the
/// create.
#[test]
fn a9_every_change_after_the_preparation_is_stopped_before_a_send() {
    for change in CHANGES {
        let (fixture, recorder, _, result) =
            run_with_change(Nir1LocalAttemptProbe::AfterPrepare, change);
        match change {
            Change::Scope | Change::Source | Change::Revocation => {
                // The create refuses (the Scope token moved, the Scene
                // incarnation differs, or the permit was revoked).
                let expected = match change {
                    Change::Scope => Nir1GenerationRefusal::SubmissionNotCurrent,
                    Change::Source => Nir1GenerationRefusal::Store(Nir1StoreFailure::Invalid),
                    _ => Nir1GenerationRefusal::ProfileRevoked,
                };
                assert!(
                    matches!(&result, Err(Nir1LocalAttemptRefusal::Owner(refusal)) if *refusal == expected),
                    "{change:?}: the create refuses: {}",
                    describe(&result)
                );
                assert_eq!(attempt_ids(&fixture).len(), 0, "{change:?}: no attempt");
            }
            _ => {
                assert_zero_send_settlement(&result);
                let ids = attempt_ids(&fixture);
                assert_eq!(ids.len(), 1, "{change:?}: one attempt");
                assert_never_sent(&fixture, &ids[0]);
            }
        }
        assert_eq!(recorder.sends(), 0, "{change:?}: nothing is sent");
        assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    }
}

/// A-9 (after the re-observation, before the claim): the claim's own
/// transaction re-reads the capture and the Scope binding.
#[test]
fn a9_a_scope_save_just_before_the_claim_stops_the_claim() {
    let (fixture, recorder, seen, result) =
        run_with_change(Nir1LocalAttemptProbe::BeforeClaim, Change::Scope);
    assert!(seen
        .lock()
        .expect("probe log")
        .contains(&Nir1LocalAttemptProbe::BeforeClaim));
    assert_zero_send_settlement(&result);
    let ids = attempt_ids(&fixture);
    assert_eq!(ids.len(), 1);
    assert_never_sent(&fixture, &ids[0]);
    assert_eq!(recorder.sends(), 0);
}

// ---------------------------------------------------------------------------
// A-18 and the claim-side residual: observed, not required (R-8).
// ---------------------------------------------------------------------------

/// What a run did, for the observation tests: whether a transport was
/// started, and the terminal of an attempt that was not.
fn observed_outcome(fixture: &Fixture, result: &RunResult) -> String {
    match result {
        Ok(Nir1LocalAttemptOutcome::Start(_)) => "started (one send)".into(),
        Ok(Nir1LocalAttemptOutcome::NotStarted(settlement)) => {
            format!("stopped by the claim: {}", settlement_kind(settlement))
        }
        Ok(Nir1LocalAttemptOutcome::Abandoned { reason, settlement }) => {
            format!(
                "abandoned by the re-observation ({reason}): {}",
                settlement_kind(settlement)
            )
        }
        Err(refusal) => format!(
            "refused: {} (attempt rows: {})",
            refusal.reason(),
            attempt_ids(fixture).len()
        ),
    }
}

fn settlement_kind(settlement: &Nir1Settlement) -> &'static str {
    match settlement {
        Nir1Settlement::ZeroSend(_) => "one zero-send terminal",
        Nir1Settlement::AlreadySettled => "already settled",
        Nir1Settlement::ClaimLost => "claim lost",
        Nir1Settlement::Unresolved { .. } => "unresolved",
    }
}

/// The window between the re-observation and the claim COMMIT (the claim's
/// own transaction reads the capture, the Scope token and the restore epoch).
/// The Scope save, the route rewrite and the revocation are stopped there by
/// design and asserted. The other four (source, revision, Decision,
/// freshness) are not read by the claim: they are observed and recorded in
/// the decisions (DR-DI1C-9), not required. In every case the run sends at
/// most once and a stopped attempt has one transport-less terminal.
#[test]
fn a18_before_the_claim_the_claim_stops_what_it_reads_and_the_rest_is_observed() {
    let mut observations = Vec::new();
    for change in CHANGES {
        let (fixture, recorder, seen, result) =
            run_with_change(Nir1LocalAttemptProbe::BeforeClaim, change);
        assert!(seen
            .lock()
            .expect("probe log")
            .contains(&Nir1LocalAttemptProbe::BeforeClaim));
        let started = matches!(result, Ok(Nir1LocalAttemptOutcome::Start(_)));
        assert_eq!(recorder.sends(), usize::from(started), "{change:?}");
        let by_design = matches!(change, Change::Scope | Change::Route | Change::Revocation);
        if by_design {
            assert!(!started, "{change:?}: the claim stops what it reads");
        }
        if !started {
            assert_zero_send_settlement(&result);
            let ids = attempt_ids(&fixture);
            assert_eq!(ids.len(), 1, "{change:?}");
            assert_eq!(stored(&fixture, &ids[0]).claimed_at_ms, None, "{change:?}");
        }
        observations.push(format!(
            "BeforeClaim {change:?}: {}",
            observed_outcome(&fixture, &result)
        ));
    }
    for line in observations {
        eprintln!("A-18 observation: {line}");
    }
}

/// Changes after the claim COMMIT, before the start decision (K4/3 "after
/// COMMIT"): the start decision reads no database, so none of these is read
/// there. Recorded as residual (A-18); nothing here is a pass condition other
/// than "at most one send" and a consistent ledger.
#[derive(Clone, Copy, Debug)]
enum AfterCommitChange {
    /// The target Scene's Scope setting is saved (the token moves).
    ScopeToken,
    /// The Scene body is saved.
    BodySave,
    /// A new user message becomes the session's current capture.
    NewUserRow,
    /// The target Scene row is deleted.
    SceneDelete,
    /// The project row is deleted.
    ProjectDelete,
}

fn inject_after_commit(target: &Target, change: AfterCommitChange) -> String {
    let result: Result<usize> =
        match change {
            AfterCommitChange::ScopeToken => {
                save_scene_scope(target, SCENE_ID, "a18-scope-save");
                Ok(1)
            }
            AfterCommitChange::BodySave => {
                inject(target, Change::Source);
                Ok(1)
            }
            AfterCommitChange::NewUserRow => {
                let submission = generation_storage::NewChatInputSubmission::new(
                    "a18-new-user-submission".into(),
                    "a18-new-user-message".into(),
                    SESSION_ID.into(),
                    SCENE_ID.into(),
                    "A newer user turn".into(),
                    "2026-10-18T00:00:00.000Z".into(),
                )
                .expect("submission");
                crate::nir1_prepared_request::accept_current_chat_submission(
                    Arc::clone(&target.state),
                    target.caller.clone(),
                    &submission,
                )
                .map(|_| 1)
            }
            AfterCommitChange::SceneDelete => target.workspace().db().db().with_conn(|conn| {
                Ok(conn.execute(
                    "DELETE FROM tree_nodes WHERE project_id=?1 AND id=?2",
                    (PROJECT_ID, SCENE_ID),
                )?)
            }),
            AfterCommitChange::ProjectDelete => target.workspace().db().db().with_conn(|conn| {
                Ok(conn.execute("DELETE FROM projects WHERE id=?1", [PROJECT_ID])?)
            }),
        };
    match result {
        Ok(rows) => format!("injected ({rows} row)"),
        Err(error) => format!("not injected ({error:#})"),
    }
}

#[test]
fn a18_after_the_claim_commit_the_residual_changes_are_observed() {
    use crate::nir1_generation_owner::Nir1OwnerProbePoint;
    let mut observations = Vec::new();
    for change in [
        AfterCommitChange::ScopeToken,
        AfterCommitChange::BodySave,
        AfterCommitChange::NewUserRow,
        AfterCommitChange::SceneDelete,
        AfterCommitChange::ProjectDelete,
    ] {
        let fixture = ready_fixture();
        let target = Target::of(&fixture);
        let attempt = capture(&fixture);
        let note = Arc::new(std::sync::Mutex::new(String::new()));
        let probe_note = Arc::clone(&note);
        attempt
            .owner()
            .hooks()
            .test_hooks()
            .on(Nir1OwnerProbePoint::AfterCommit, move || {
                *probe_note.lock().expect("note") = inject_after_commit(&target, change);
            });
        let result = attempt.run();
        let recorder = Recorder::default();
        recorder.observe(&result);
        assert!(recorder.sends() <= 1, "{change:?}: at most one send");
        let injected = note.lock().expect("note").clone();
        let outcome = observed_outcome(&fixture, &result);
        observations.push(format!("AfterCommit {change:?}: {injected} -> {outcome}"));
        drop(result);
        // Observed too: a deleted project can leave the slot unresolved until
        // the next Ready entry's sweep (the terminal write needs the rows).
        let tracked = fixture.state.nir1_generation_registry.tracked_sessions();
        let unresolved = fixture
            .state
            .nir1_generation_registry
            .unresolved_attempts()
            .len();
        observations.push(format!(
            "AfterCommit {change:?}: slots left {tracked} (unresolved {unresolved})"
        ));
    }
    for line in observations {
        eprintln!("A-18 observation: {line}");
    }
}

/// A-11: a refusal before the create leaves no attempt row, and one after it
/// leaves a transport-less terminal and nothing claimed.
#[test]
fn a11_an_ineligible_attempt_is_not_persisted() {
    // Unsupported inputs and a key verdict refuse before any owner exists.
    let fixture = ready_fixture();
    for (unsupported, generation) in [
        (
            UnsupportedInputIntent::from_presence(true, false, false),
            LocalGenerationIntent::writing_for_test(),
        ),
        (
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::new(
                GenerationPurpose::Writing,
                MainKeyVerdict::Present,
                "fixture-local".into(),
            ),
        ),
    ] {
        let refusal = Nir1LocalAttempt::capture(
            Arc::clone(&fixture.state),
            fixture.caller.clone(),
            &fixture.message_version_id,
            SCENE_ID,
            unsupported,
            generation,
        )
        .err()
        .expect("the capture refuses");
        assert!(matches!(refusal, Nir1LocalAttemptRefusal::Prepare(_)));
        assert_eq!(fixture.attempt_count().expect("count"), 0);
        assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    }

    // A route the Native prepare cannot support: nothing is created and the
    // session slot is released.
    let fixture = ready_fixture();
    let attempt = capture(&fixture);
    std::fs::write(&fixture.state.ai_settings_path, "{ not json").expect("break the route");
    let refusal = attempt.run().err().expect("the preparation refuses");
    assert!(matches!(refusal, Nir1LocalAttemptRefusal::Prepare(_)));
    assert_eq!(fixture.attempt_count().expect("count"), 0);
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);

    // No accepted Revision remains: the required context is missing.
    let fixture = ready_fixture();
    one_row(
        workspace_of(&fixture).db().db().with_conn(|conn| {
            Ok(conn.execute(
                "UPDATE narrative_proposals SET status='rejected' WHERE current_revision_id=?1",
                [fixture.revision_id.as_str()],
            )?)
        }),
        "the withdrawn approval",
    );
    let refusal = capture(&fixture)
        .run()
        .err()
        .expect("no accepted Revision remains");
    let Nir1LocalAttemptRefusal::Prepare(error) = refusal else {
        panic!("a preparation refusal")
    };
    assert!(
        error
            .to_string()
            .contains("NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"),
        "{error}"
    );
    assert_eq!(fixture.attempt_count().expect("count"), 0);

    // A capture that is dropped before `run` (where DD-1 checks the AI use
    // policy) writes nothing and frees the slot. Until then the owner is
    // there for the caller to look at.
    let fixture = ready_fixture();
    let pending = capture(&fixture);
    assert_eq!(
        pending.owner().attempt_id(),
        generation_storage::attempt_id_for_capture(&fixture.message_version_id)
            .expect("attempt id")
    );
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 1);
    drop(pending);
    assert_eq!(fixture.attempt_count().expect("count"), 0);
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
}

/// A-19: nothing is held across the stages. The create returns its lease
/// before the re-observation, and the re-observation holds none: the startup
/// gate has no active lease at any probe point, and the registry slot is the
/// only thing the owner holds until it settles.
#[test]
fn a19_no_lease_or_lock_spans_the_stages() {
    let fixture = ready_fixture();
    let state = Arc::clone(&fixture.state);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&observed);
    let attempt = capture(&fixture).with_probe(move |point| {
        let gate = state.workspace_lifecycle.nir1_startup_gate();
        sink.lock()
            .expect("probe log")
            .push((point, gate.active_lease_count()));
    });
    let outcome = attempt.run().expect("the coordinator runs");
    let recorder = Recorder::default();
    recorder.send(outcome, "a19-answer");
    assert_eq!(recorder.sends(), 1);
    let observed = observed.lock().expect("probe log");
    assert_eq!(
        observed.iter().map(|(point, _)| *point).collect::<Vec<_>>(),
        vec![
            Nir1LocalAttemptProbe::AfterPrepare,
            Nir1LocalAttemptProbe::AfterCreate,
            Nir1LocalAttemptProbe::BeforeClaim,
        ]
    );
    assert!(
        observed.iter().all(|(_, leases)| *leases == 0),
        "no startup lease is held between the stages: {observed:?}"
    );
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
}

/// The product code of every top-level `nir1_*.rs` file (everything before
/// its trailing `#[cfg(test)] mod`) with its comments removed.
fn product_code(text: &str) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    let mut end = lines.len();
    for (index, line) in lines.iter().enumerate() {
        if *line != "#[cfg(test)]" {
            continue;
        }
        let item = lines[index + 1..]
            .iter()
            .find(|next| !next.trim_start().starts_with("#["))
            .copied()
            .unwrap_or("");
        if item.starts_with("mod ")
            || item.starts_with("pub(crate) mod ")
            || item.starts_with("pub mod ")
        {
            end = index;
            break;
        }
    }
    lines[..end]
        .iter()
        .filter(|line| !line.trim_start().starts_with("//"))
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
}

/// The product path calls only the capture forms of the create and the
/// claim, which re-read the capture, the Scope binding and the restore epoch.
/// The forms that do not (`claim_attempt_bounded` for the storage tests and a
/// second claimer, the test-support creates) must not be called from the
/// product code of any `nir1_*.rs` file of this crate, so that a later slice
/// (DD-1, DT-5) cannot drop the K4/3 re-reads by calling them.
#[test]
fn the_product_path_uses_only_the_capture_forms() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut scanned = Vec::new();
    for entry in std::fs::read_dir(&directory).expect("source directory") {
        let path = entry.expect("entry").path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !(name.starts_with("nir1_") && name.ends_with(".rs") && !name.ends_with("_tests.rs")) {
            continue;
        }
        let code = product_code(&std::fs::read_to_string(&path).expect("source"));
        for forbidden in [
            "claim_attempt_bounded(",
            "create_attempt_bounded(",
            "create_attempt(",
            "create_attempt_with_id_bounded(",
        ] {
            assert!(
                !code.contains(forbidden),
                "{name} must not call {forbidden} outside its tests"
            );
        }
        scanned.push(name.to_owned());
    }
    // The scan really covers the owner and the coordinator.
    for required in ["nir1_generation_owner.rs", "nir1_local_attempt.rs"] {
        assert!(scanned.iter().any(|name| name == required), "{required}");
    }
    assert!(
        scanned.len() >= 6,
        "the scan covers the nir1 files: {scanned:?}"
    );
}

// ---------------------------------------------------------------------------
// DI-1a S2: Graph-derived inputs in the attempt (A-3, A-19, A-20).
// ---------------------------------------------------------------------------

/// The Graph's candidates for this fixture, on a sealed B: what the worker
/// would have recorded for every relation of the control request's Revisions.
fn graph_candidates(fixture: &Fixture) -> grimodex_db::narrative_extraction::Nir1GraphCandidates {
    write_graph_seal(&fixture.state, GRAPH_GENERATION, false).expect("seal");
    let control = prepare_selected_local_chat_request(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        &fixture.message_version_id,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|error| panic!("control request: {error:#}"))
    .into_parts()
    .0
    .into_d_transport_handoff();
    graph_candidates_for(control.authority_bindings(), GRAPH_GENERATION).expect("candidates")
}

fn graph_final_request(
    fixture: &Fixture,
    graph: &grimodex_db::narrative_extraction::Nir1GraphCandidates,
) -> FinalDispatchRequest {
    let selected = crate::nir1_prepared_request::prepare_selected_local_chat_request_with_graph(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        &fixture.message_version_id,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
        Some(graph),
    )
    .unwrap_or_else(|error| panic!("Graph request: {error:#}"));
    let (request, scene, expected_scope, _witness) = selected.into_parts();
    let handoff = request.into_d_transport_handoff();
    build_final_dispatch_request(&fixture.message_version_id, &handoff, scene, expected_scope)
        .expect("final request")
}

fn graph_ordinals_of(request: &FinalDispatchRequest) -> Vec<usize> {
    request
        .inputs
        .iter()
        .enumerate()
        .filter(|(_, input)| matches!(input.target, InputTarget::GraphEvidence { .. }))
        .map(|(ordinal, _)| ordinal)
        .collect()
}

/// A coordinator with the Graph's candidates, whose probe injects `change` at
/// `point`.
fn graph_attempt_with_change(
    fixture: &Fixture,
    point: Nir1LocalAttemptProbe,
    change: Change,
) -> (Nir1LocalAttempt, Seen) {
    let graph = graph_candidates(fixture);
    let (attempt, seen) = attempt_with_change(fixture, point, change);
    (attempt.with_graph_candidates(graph), seen)
}

/// A-19, DG-1: the Graph request is stored as it was prepared and reads back
/// the same, and its digests bind the Graph (a request without one has the
/// digests it had before).
#[test]
fn a3_a_graph_request_is_stored_whole_and_its_digests_bind_the_graph() {
    let fixture = ready_fixture();
    let control = final_request(&fixture, &fixture.message_version_id);
    let graph = graph_candidates(&fixture);
    let planned = graph_final_request(&fixture, &graph);

    let ordinals = graph_ordinals_of(&planned);
    assert!(!ordinals.is_empty(), "the Graph reached the request");
    assert!(graph_ordinals_of(&control).is_empty());
    for ordinal in &ordinals {
        let index = planned
            .qualifications
            .iter()
            .filter(|row| row.input_ordinal == *ordinal && row.kind == QualificationKind::Index)
            .collect::<Vec<_>>();
        assert_eq!(index.len(), 1);
        assert!(matches!(index[0].body, QualificationBody::Present { .. }));
    }
    // The Graph is bound by the digests; the same request again is the same.
    assert_ne!(planned.scope_digest, control.scope_digest);
    assert_ne!(planned.material_digest, control.material_digest);
    assert_ne!(planned.d1_digest, control.d1_digest);
    let again = graph_final_request(&fixture, &graph);
    assert_eq!(again.scope_digest, planned.scope_digest);
    assert_eq!(again.material_digest, planned.material_digest);
    assert_eq!(again.d1_digest, planned.d1_digest);
    // A new generation of B changes the scope and material digests.
    write_graph_seal(&fixture.state, GRAPH_GENERATION + 1, false).expect("seal again");
    let next = grimodex_db::narrative_extraction::Nir1GraphCandidates::new(
        graph.project_id().to_owned(),
        graph.query_scene_id().to_owned(),
        graph.seed_entity_id().to_owned(),
        GRAPH_GENERATION + 1,
        graph.scope_revision().map(str::to_owned),
        graph.edges().to_vec(),
    )
    .expect("next candidates");
    let rebuilt = graph_final_request(&fixture, &next);
    assert_ne!(rebuilt.scope_digest, planned.scope_digest);
    assert_ne!(rebuilt.material_digest, planned.material_digest);
    write_graph_seal(&fixture.state, GRAPH_GENERATION, false).expect("seal back");

    // The coordinator stores what it prepared.
    let attempt_id = generation_storage::attempt_id_for_capture(&fixture.message_version_id)
        .expect("attempt id");
    let outcome = capture(&fixture)
        .with_graph_candidates(graph)
        .run()
        .unwrap_or_else(|refusal| panic!("the coordinator refused: {refusal:?}"));
    let recorder = Recorder::default();
    recorder.send(outcome, "a3-graph-answer");
    assert_eq!(recorder.sends(), 1);
    let attempt = stored(&fixture, &attempt_id);
    assert_eq!(attempt.inputs, planned.inputs);
    assert_eq!(attempt.qualifications, planned.qualifications);
    assert_eq!(
        attempt.input_digest,
        crate::nir1_generation::final_input_digest(&planned.inputs, &planned.qualifications)
            .expect("input digest")
    );
    assert_eq!(attempt.binding.scope_digest, planned.scope_digest);
    assert_eq!(attempt.binding.material_digest, planned.material_digest);
}

/// A-3 (DI-1a): an index generation changed after the preparation, after the
/// create, and just before the claim. A request with Graph-derived inputs is
/// stopped by the dispatch-time check in the first two; the claim re-reads the
/// capture, the Scope binding and the restore epoch only, so the third is the
/// same residual as a Revision change at that point (A-18).
#[test]
fn a3_an_index_generation_change_stops_a_graph_request_before_the_claim() {
    for point in [
        Nir1LocalAttemptProbe::AfterPrepare,
        Nir1LocalAttemptProbe::AfterCreate,
    ] {
        let fixture = ready_fixture();
        let (attempt, seen) = graph_attempt_with_change(&fixture, point, Change::IndexGeneration);
        let result = attempt.run();
        let recorder = Recorder::default();
        recorder.observe(&result);
        assert!(
            seen.lock().expect("probe log").contains(&point),
            "{point:?}: injected"
        );
        assert!(
            !seen
                .lock()
                .expect("probe log")
                .contains(&Nir1LocalAttemptProbe::BeforeClaim),
            "{point:?}: the claim is never reached"
        );
        let reason = abandoned_reason(&result).to_owned();
        assert!(
            reason.contains("NIR1_NATIVE_PREPARED_GRAPH_STALE"),
            "{point:?}: unexpected reason {reason}"
        );
        assert_zero_send_settlement(&result);
        let ids = attempt_ids(&fixture);
        assert_eq!(ids.len(), 1, "{point:?}: the attempt row exists once");
        assert_never_sent(&fixture, &ids[0]);
        assert_eq!(recorder.sends(), 0, "{point:?}: nothing is sent");
        assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    }

    // Just before the claim: the Index generation and a Revision change are
    // alike (neither is re-read by the claim, DR-DI1C-9), so they behave
    // alike: the request is sent, as the DI-1c Revision residual is. The
    // residual is recorded in the decisions and the PR body (DR-DI1A-16).
    let mut sends = Vec::new();
    for change in [Change::IndexGeneration, Change::Revision] {
        let fixture = ready_fixture();
        let (attempt, seen) =
            graph_attempt_with_change(&fixture, Nir1LocalAttemptProbe::BeforeClaim, change);
        let result = attempt.run();
        let recorder = Recorder::default();
        recorder.observe(&result);
        assert!(seen
            .lock()
            .expect("probe log")
            .contains(&Nir1LocalAttemptProbe::BeforeClaim));
        assert_eq!(
            recorder.sends(),
            1,
            "{change:?}: the claim reads neither, so the request is sent"
        );
        assert!(
            matches!(result, Ok(Nir1LocalAttemptOutcome::Start(_))),
            "{change:?}: started"
        );
        eprintln!(
            "A-3 observation: BeforeClaim {change:?} -> {}",
            observed_outcome(&fixture, &result)
        );
        sends.push(recorder.sends());
    }
    assert_eq!(sends[0], sends[1]);
}

/// A-3 (DI-1a): every change of the DI-1c table is found for a Graph request
/// too, after the create; the Graph-derived inputs add the index generation.
#[test]
fn a3_every_change_after_the_create_abandons_a_graph_request() {
    for change in GRAPH_CHANGES {
        let fixture = ready_fixture();
        let (attempt, seen) =
            graph_attempt_with_change(&fixture, Nir1LocalAttemptProbe::AfterCreate, change);
        let result = attempt.run();
        let recorder = Recorder::default();
        recorder.observe(&result);
        assert!(
            !seen
                .lock()
                .expect("probe log")
                .contains(&Nir1LocalAttemptProbe::BeforeClaim),
            "{change:?}: the claim is never reached"
        );
        let reason = abandoned_reason(&result).to_owned();
        let expected: &[&str] = match change {
            Change::Source => &[
                "NIR1_NATIVE_RAW_SOURCE_STALE",
                "NIR1_NATIVE_PREPARED_RAW_SOURCE_BODY_STALE",
            ],
            // A product writer that changes a Scope or a Revision's material
            // also dirties B, so the seal check can answer before the
            // Revision's own check does: either reason is a stale request.
            Change::Scope | Change::Revision | Change::Decision | Change::Freshness => &[
                "NIR1_NATIVE_PREPARED_REVISION_STALE",
                "NIR1_NATIVE_PREPARED_GRAPH_STALE",
            ],
            Change::Route => &["NIR1_PREPARED_ROUTE_CHANGED"],
            Change::Revocation => &["D2A_EGRESS_DENIED", "NIR1_PREPARED_ROUTE_REVOKED"],
            Change::IndexGeneration => &["NIR1_NATIVE_PREPARED_GRAPH_STALE"],
        };
        assert!(
            expected.iter().any(|code| reason.contains(code)),
            "{change:?}: unexpected reason {reason}"
        );
        assert_zero_send_settlement(&result);
        let ids = attempt_ids(&fixture);
        assert_eq!(ids.len(), 1, "{change:?}: the attempt row exists once");
        assert_never_sent(&fixture, &ids[0]);
        assert_eq!(recorder.sends(), 0, "{change:?}: nothing is sent");
    }
}

/// A-3: B is dirtied by a product writer after the create: the seal is gone,
/// so the Graph-derived inputs are no longer current.
#[test]
fn a3_a_dirty_index_after_the_create_abandons_a_graph_request() {
    let fixture = ready_fixture();
    let graph = graph_candidates(&fixture);
    let target = Target::of(&fixture);
    let attempt = capture(&fixture)
        .with_graph_candidates(graph)
        .with_probe(move |probe| {
            if probe == Nir1LocalAttemptProbe::AfterCreate {
                write_graph_seal(&target.state, GRAPH_GENERATION, true).expect("dirty");
            }
        });
    let result = attempt.run();
    let reason = abandoned_reason(&result).to_owned();
    assert!(
        reason.contains("NIR1_NATIVE_PREPARED_GRAPH_STALE"),
        "{reason}"
    );
    assert_zero_send_settlement(&result);
}

/// A-20: the references of a Graph request fit the attempt's read budget, and
/// a request over it is refused at the create, never cut.
#[test]
fn a20_graph_references_fit_the_read_budget_and_an_oversized_request_is_refused() {
    let fixture = ready_fixture();
    let graph = graph_candidates(&fixture);
    let planned = graph_final_request(&fixture, &graph);
    let references = planned.inputs.len() + planned.qualifications.len();
    assert!(
        references <= planned.budget.max_references,
        "{references} references against {}",
        planned.budget.max_references
    );
    assert!(references > 1);

    // One reference fewer than the request has: the create refuses and writes
    // no attempt (the store does not drop rows to fit).
    let mut oversized = graph_final_request(&fixture, &graph);
    oversized.budget = ReadBudget {
        max_references: references - 1,
        max_reference_bytes: planned.budget.max_reference_bytes,
    };
    let refusal = capture(&fixture)
        .owner
        .create(oversized)
        .err()
        .expect("an oversized request is refused");
    eprintln!("A-20 observation: {refusal:?}");
    assert_eq!(attempt_ids(&fixture).len(), 0, "no attempt row");
}
