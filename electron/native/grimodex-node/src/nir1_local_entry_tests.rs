//! Tests of the DD-1a entry (K5/3 "IPC の command", S20; K4/3 取消の結束).
//! IDs E1-E10 refer to the decisions record
//! (`docs/plans/nir1-lane-decisions/dd1a-decisions.md`). The peer is a
//! `#[cfg(test)]` loopback recorder: it exists only in this test build, counts
//! connections, keeps the bytes it received and plays a script.

use super::test_hooks::Nir1LocalEntryTestHooks;
use super::*;
use crate::nir1_generation::{final_payload_digest, sweep_and_open_ready_entry_for_test};
use crate::nir1_generation_owner::Nir1OwnerProbePoint;
use crate::nir1_local_attempt::Nir1LocalAttemptProbe;
use crate::nir1_prepared_request::tests::{
    native_state_for_workspace, write_local_route, Fixture, PROJECT_ID, REVISION_SCENE_ID,
    SCENE_ID, SESSION_ID,
};
use grimodex_db::nir1_generation::Nir1GenerationFailpoint;
use grimodex_db::state::active_workspace_snapshot;
use grimodex_db::Database;
use serde_json::json;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;
use std::thread::JoinHandle;

// ---------------------------------------------------------------------------
// The loopback recorder.
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Step {
    Write(Vec<u8>),
    /// Read until the peer closes (at most 5 s) and record that it did.
    WaitPeerClose,
}

#[derive(Default)]
struct Recorded {
    connections: AtomicUsize,
    requests: Mutex<Vec<Vec<u8>>>,
    peer_closed: AtomicBool,
    stop: AtomicBool,
}

struct Recorder {
    addr: SocketAddr,
    shared: Arc<Recorded>,
    accept: Option<JoinHandle<()>>,
}

impl Recorder {
    fn start(script: Vec<Step>) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("loopback listener");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("address");
        let shared = Arc::new(Recorded::default());
        let accept_shared = Arc::clone(&shared);
        let accept = thread::spawn(move || {
            while !accept_shared.stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        accept_shared.connections.fetch_add(1, Ordering::SeqCst);
                        let script = script.clone();
                        let shared = Arc::clone(&accept_shared);
                        thread::spawn(move || serve(stream, script, &shared));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            addr,
            shared,
            accept: Some(accept),
        }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.addr.port())
    }

    fn connections(&self) -> usize {
        self.shared.connections.load(Ordering::SeqCst)
    }

    fn body(&self) -> Vec<u8> {
        let requests = self
            .shared
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let request = requests.first().cloned().unwrap_or_default();
        match request.windows(4).position(|window| window == b"\r\n\r\n") {
            Some(end) => request[end + 4..].to_vec(),
            None => Vec::new(),
        }
    }

    fn peer_closed(&self) -> bool {
        self.shared.peer_closed.load(Ordering::SeqCst)
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

fn request_total_len(received: &[u8]) -> Option<usize> {
    let end = received
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?
        + 4;
    let head = String::from_utf8_lossy(&received[..end]);
    let length = head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .and_then(|value| value.trim().parse::<usize>().ok())?;
    Some(end + length)
}

fn serve(mut stream: TcpStream, script: Vec<Step>, shared: &Recorded) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(20)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut request = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buffer = [0u8; 4096];
    while !request_total_len(&request).is_some_and(|total| request.len() >= total)
        && Instant::now() < deadline
        && !shared.stop.load(Ordering::Acquire)
    {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => request.extend_from_slice(&buffer[..count]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }
    }
    shared
        .requests
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(request);
    for step in script {
        match step {
            Step::Write(bytes) => {
                let _ = stream.write_all(&bytes);
            }
            Step::WaitPeerClose => {
                let until = Instant::now() + Duration::from_secs(5);
                while Instant::now() < until && !shared.stop.load(Ordering::Acquire) {
                    match stream.read(&mut buffer) {
                        Ok(0) => {
                            shared.peer_closed.store(true, Ordering::SeqCst);
                            break;
                        }
                        Ok(_) => {}
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => {
                            shared.peer_closed.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
        }
    }
}

const HEAD_CHUNKED: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

fn chunk(data: &str) -> Vec<u8> {
    format!("{:x}\r\n{data}\r\n", data.len()).into_bytes()
}

fn text_event(content: &str, finish: Option<&str>) -> String {
    format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":finish}]})
    )
}

fn thinking_event(content: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"reasoning_content":content},"finish_reason":null}]})
    )
}

/// thinking "hm", text "Hello", `stop`, `[DONE]`.
fn ok_script() -> Vec<Step> {
    text_script(&["Hel", "lo"])
}

fn text_script(parts: &[&str]) -> Vec<Step> {
    let mut steps = vec![
        Step::Write(HEAD_CHUNKED.into()),
        Step::Write(chunk(&thinking_event("hm"))),
    ];
    for (index, part) in parts.iter().enumerate() {
        let finish = (index + 1 == parts.len()).then_some("stop");
        steps.push(Step::Write(chunk(&text_event(part, finish))));
    }
    steps.push(Step::Write(chunk("data: [DONE]\n\n")));
    steps.push(Step::Write(b"0\r\n\r\n".to_vec()));
    steps
}

/// The head and one text event, then nothing until the client closes.
fn hold_script() -> Vec<Step> {
    vec![
        Step::Write(HEAD_CHUNKED.into()),
        Step::Write(chunk(&text_event("partial", None))),
        Step::WaitPeerClose,
    ]
}

fn fast_config() -> Nir1LocalTransportConfig {
    Nir1LocalTransportConfig {
        connect_timeout: Duration::from_millis(500),
        request_write_timeout: Duration::from_secs(2),
        first_byte_timeout: Duration::from_secs(5),
        event_gap_timeout: Duration::from_secs(5),
        total_timeout: Duration::from_secs(10),
        done_body_end_timeout: Duration::from_millis(500),
        cancel_poll: Duration::from_millis(5),
        join_limit: Duration::from_secs(1),
        ..Nir1LocalTransportConfig::DEFAULT
    }
}

// ---------------------------------------------------------------------------
// The rig: the prepared-request fixture (restricted profile, registered
// caller, Ready workspace, approved Revision), the startup gate open, the
// route pointed at the recorder.
// ---------------------------------------------------------------------------

struct Rig {
    fixture: Fixture,
    recorder: Recorder,
}

impl Rig {
    fn new(script: Vec<Step>) -> Self {
        Self::with_hooks(script, Nir1LocalEntryTestHooks::default())
    }

    fn with_hooks(script: Vec<Step>, hooks: Nir1LocalEntryTestHooks) -> Self {
        let rig = Self::without_startup_gate(script, hooks);
        assert!(sweep_and_open_ready_entry_for_test(rig.state()));
        rig
    }

    /// The fixture before the sweep opens the startup gate.
    fn without_startup_gate(script: Vec<Step>, mut hooks: Nir1LocalEntryTestHooks) -> Self {
        let fixture = Fixture::new().expect("fixture");
        let recorder = Recorder::start(script);
        write_local_route(&fixture.state, &recorder.base_url(), 16_384, 1024).expect("route");
        if hooks.transport_config.is_none() {
            hooks.transport_config = Some(fast_config());
        }
        fixture.state.nir1_local_entry.set_test_hooks(hooks);
        Self { fixture, recorder }
    }

    fn state(&self) -> &Arc<AppState> {
        &self.fixture.state
    }

    fn caller(&self) -> CallerIdentity {
        self.fixture.caller.clone()
    }

    fn open_gate(&self) {
        self.state()
            .main_grant
            .gate
            .open(PrePublicationEntry::LocalGeneration);
    }

    fn create(&self, purpose: &str) -> String {
        let response: Value = serde_json::from_str(&wire_conversation_create(
            self.state(),
            json!({"purpose": purpose, "sceneId": SCENE_ID}),
            &caller_json(&self.caller()),
        ))
        .expect("json");
        assert_eq!(response["status"], "created", "{response}");
        response["conversationId"]
            .as_str()
            .expect("conversation id")
            .to_owned()
    }

    /// Capture one user input in `conversation` as `caller` (the #611 writer).
    fn capture_as(&self, caller: &CallerIdentity, conversation: &str, key: &str) {
        let request = serde_json::from_value(json!({
            "submissionId": format!("dd1a-submission-{key}"),
            "messageId": format!("dd1a-message-{key}"),
            "chatSessionId": conversation,
            "sceneId": SCENE_ID,
            "content": format!("Write the next beat ({key})."),
            "createdAt": "2026-10-26T10:00:00.000Z",
        }))
        .expect("capture request");
        prepared::capture_current_chat_input(Arc::clone(self.state()), caller.clone(), request)
            .unwrap_or_else(|error| panic!("capture refused: {error:#}"));
    }

    fn capture(&self, conversation: &str, key: &str) {
        self.capture_as(&self.caller(), conversation, key);
    }

    fn start_as(
        &self,
        caller: &CallerIdentity,
        purpose: &str,
        conversation: &str,
        scene_id: &str,
        key_verdict: &str,
    ) -> Value {
        serde_json::from_str(&wire_generation_start(
            self.state(),
            json!({"purpose": purpose, "conversationId": conversation, "sceneId": scene_id}),
            json!({"endpointId": "fixture-local", "keyVerdict": key_verdict}),
            &caller_json(caller),
        ))
        .expect("json")
    }

    fn start(&self, purpose: &str, conversation: &str) -> Value {
        self.start_as(&self.caller(), purpose, conversation, SCENE_ID, "absent")
    }

    fn started(&self, purpose: &str, conversation: &str) -> String {
        let response = self.start(purpose, conversation);
        assert_eq!(response["status"], "started", "{response}");
        response["handle"].as_str().expect("handle").to_owned()
    }

    fn continue_as(&self, caller: &CallerIdentity, handle: &str) -> Value {
        serde_json::from_str(&wire_generation_continue(
            self.state(),
            json!({ "handle": handle }),
            &caller_json(caller),
        ))
        .expect("json")
    }

    fn cancel_as(&self, caller: &CallerIdentity, handle: &str) -> Value {
        serde_json::from_str(&wire_generation_cancel(
            self.state(),
            json!({ "handle": handle }),
            &caller_json(caller),
        ))
        .expect("json")
    }

    fn cancel(&self, handle: &str) -> Value {
        self.cancel_as(&self.caller(), handle)
    }

    /// Continue until the handle is drained; the concatenated text and
    /// thinking and the last view.
    fn drain(&self, handle: &str) -> (String, String, Value) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let (mut text, mut thinking) = (String::new(), String::new());
        loop {
            let view = self.continue_as(&self.caller(), handle);
            assert_eq!(view["status"], "ok", "{view}");
            text.push_str(view["text"].as_str().unwrap_or_default());
            thinking.push_str(view["thinking"].as_str().unwrap_or_default());
            if view["drained"] == true {
                return (text, thinking, view);
            }
            assert!(Instant::now() < deadline, "the run did not end: {view}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_final(&self, handle: &str) {
        wait_until(
            || {
                self.state()
                    .nir1_local_entry
                    .entry_for(handle, &self.caller())
                    .is_some_and(|entry| entry.is_final())
            },
            "the run to end",
        );
    }

    fn read(&self, conversation: &str, offset: u32, limit: u32) -> Value {
        serde_json::from_str(&wire_conversation_read(
            self.state(),
            json!({"conversationId": conversation, "offset": offset, "limit": limit}),
            &caller_json(&self.caller()),
        ))
        .expect("json")
    }

    fn list(&self) -> Value {
        serde_json::from_str(&wire_conversation_list(
            self.state(),
            &caller_json(&self.caller()),
        ))
        .expect("json")
    }

    fn query_i64(&self, sql: &str) -> i64 {
        let workspace = active_workspace_snapshot(&self.state().ws).expect("workspace");
        workspace
            .db()
            .db()
            .with_read_transaction(|conn| {
                conn.query_row(sql, [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("query")
    }

    /// One text value of a scalar subquery (`NULL` when no row matches).
    fn query_text(&self, sql: &str, value: &str) -> Option<String> {
        let workspace = active_workspace_snapshot(&self.state().ws).expect("workspace");
        workspace
            .db()
            .db()
            .with_read_transaction(|conn| {
                conn.query_row(&format!("SELECT ({sql})"), [value], |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("query")
    }

    fn execute(&self, sql: &str) {
        let workspace = active_workspace_snapshot(&self.state().ws).expect("workspace");
        workspace
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute_batch(sql)?;
                Ok(())
            })
            .expect("execute");
    }

    fn attempts(&self) -> i64 {
        self.query_i64("SELECT COUNT(*) FROM nir1_generation_attempts")
    }

    fn audit_events(&self) -> i64 {
        self.query_i64("SELECT COUNT(*) FROM ai_audit_events")
    }

    fn capture_state(&self, key: &str) -> String {
        self.query_text(
            "SELECT state FROM nir1_chat_input_captures WHERE submission_id=?1",
            &format!("dd1a-submission-{key}"),
        )
        .expect("capture row")
    }

    fn set_policy(&self, value: &str) {
        self.execute(&format!(
            "UPDATE projects SET ai_policy='{value}' WHERE id='{PROJECT_ID}'"
        ));
    }

    /// A second caller registered for the same workspace (another window).
    fn other_caller(&self, sender_id: u64) -> CallerIdentity {
        let mut caller = self.caller();
        caller.caller_id = format!("dd1a-other-caller-{sender_id}");
        caller.sender_id = sender_id;
        caller.session_id = format!("dd1a-other-session-{sender_id}");
        self.state()
            .profile_egress
            .register_caller(&caller)
            .expect("register");
        caller
    }
}

fn caller_json(caller: &CallerIdentity) -> String {
    json!({
        "profileId": caller.profile_id,
        "callerId": caller.caller_id,
        "callerEpoch": caller.caller_epoch,
        "senderId": caller.sender_id,
        "workspaceId": caller.workspace_id,
        "sessionId": caller.session_id,
    })
    .to_string()
}

fn reason(response: &Value) -> &str {
    response["reason"].as_str().unwrap_or_default()
}

fn wait_until(condition: impl Fn() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(2));
    }
}

/// A rendezvous between a probe on the starter thread and the test: the
/// `at`-th hit (1-based) blocks until the test releases it.
#[derive(Clone)]
struct Pause {
    at: usize,
    hits: Arc<AtomicUsize>,
    reached: mpsc::SyncSender<()>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
}

struct PauseControl {
    reached: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
}

fn pause(at: usize) -> (Pause, PauseControl) {
    let (reached_tx, reached_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::channel();
    (
        Pause {
            at,
            hits: Arc::new(AtomicUsize::new(0)),
            reached: reached_tx,
            release: Arc::new(Mutex::new(release_rx)),
        },
        PauseControl {
            reached: reached_rx,
            release: release_tx,
        },
    )
}

impl Pause {
    fn hit(&self) {
        if self.hits.fetch_add(1, Ordering::SeqCst) + 1 == self.at {
            let _ = self.reached.send(());
            let release = self.release.lock().expect("pause");
            let _ = release.recv_timeout(Duration::from_secs(10));
        }
    }
}

impl PauseControl {
    fn wait(&self, what: &str) {
        self.reached
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("{what}: the probe was not reached"));
    }

    fn release(&self) {
        let _ = self.release.send(());
    }
}

// ---------------------------------------------------------------------------
// E1: the Native gate.
// ---------------------------------------------------------------------------

/// E1 (必須防御 16): with the gate closed, all six commands are refused with
/// the gate's reason before any argument (the caller identity included) is
/// read: nothing is created, captured, attempted or sent. The same requests
/// pass once the gate is opened, so the refusal is the gate's.
#[test]
fn e1_the_closed_gate_refuses_the_six_commands_before_anything() {
    let rig = Rig::new(ok_script());
    // A marked conversation from an earlier process and a current capture in
    // it (the capture entry is not this route's command).
    let conversation = "nir1-local-writing-0123abcd-4567-89ab-cdef-0123456789ab";
    rig.execute(&format!(
        "INSERT INTO chat_sessions (id, project_id, node_id, created_at, updated_at)
         VALUES ('{conversation}', '{PROJECT_ID}', '{SCENE_ID}',
                 '2026-10-26T09:00:00.000Z', '2026-10-26T09:00:00.000Z')"
    ));
    rig.capture(conversation, "e1");
    let handle = "0123456789abcdef0123456789abcdef";
    let counts = || {
        (
            rig.query_i64("SELECT COUNT(*) FROM chat_sessions"),
            rig.attempts(),
            rig.query_i64("SELECT COUNT(*) FROM nir1_chat_input_captures WHERE state='current'"),
        )
    };
    let before = counts();
    let caller = caller_json(&rig.caller());
    for caller_identity in [caller.as_str(), "not json"] {
        let responses: [String; 6] = [
            wire_generation_start(
                rig.state(),
                json!({"purpose":"writing","conversationId":conversation,"sceneId":SCENE_ID}),
                json!({"endpointId":"fixture-local","keyVerdict":"absent"}),
                caller_identity,
            ),
            wire_generation_continue(rig.state(), json!({ "handle": handle }), caller_identity),
            wire_generation_cancel(rig.state(), json!({ "handle": handle }), caller_identity),
            wire_conversation_create(
                rig.state(),
                json!({"purpose":"writing","sceneId":SCENE_ID}),
                caller_identity,
            ),
            wire_conversation_list(rig.state(), caller_identity),
            wire_conversation_read(
                rig.state(),
                json!({"conversationId":conversation,"offset":0,"limit":10}),
                caller_identity,
            ),
        ];
        for response in &responses {
            let response: Value = serde_json::from_str(response).expect("json");
            assert_eq!(reason(&response), "NIR1_LOCAL_GATE_CLOSED", "{response}");
            let mut keys: Vec<&String> = response.as_object().expect("object").keys().collect();
            keys.sort();
            assert_eq!(keys, ["reason", "status"], "{response}");
        }
    }
    assert_eq!(
        counts(),
        before,
        "nothing was written while the gate was closed"
    );
    assert_eq!(rig.recorder.connections(), 0);
    assert_eq!(rig.state().nir1_local_entry.start_record_count(), 0);
    // Opened (as Main's seam would): the same start goes through.
    rig.open_gate();
    let handle = rig.started("writing", conversation);
    let (text, _, _) = rig.drain(&handle);
    assert_eq!(text, "Hello");
    assert_eq!(rig.recorder.connections(), 1);
}

/// E1b: the product code never opens the gate (only Main's
/// `main_open_pre_publication_gate`, which parses the wire kind), and the
/// entry emits no event: output leaves only by continue.
#[test]
fn e1b_only_main_opens_the_gate_and_the_entry_broadcasts_nothing() {
    for (name, source) in [
        ("lib.rs", include_str!("lib.rs")),
        ("nir1_local_entry.rs", include_str!("nir1_local_entry.rs")),
        ("main_grant.rs", include_str!("main_grant.rs")),
        ("state.rs", include_str!("state.rs")),
    ] {
        let product = source
            .split("\n#[cfg(test)]\n")
            .next()
            .expect("product part");
        assert!(
            !product.contains("PrePublicationEntry::LocalGeneration)"),
            "{name} names the local generation gate in product code"
        );
    }
    let entry = include_str!("nir1_local_entry.rs")
        .split("\n#[cfg(test)]\n#[path")
        .next()
        .expect("product part")
        .to_owned();
    for forbidden in [".events.", "emit(", "EventQueue", "nir1_local_entry_events"] {
        assert!(!entry.contains(forbidden), "the entry uses {forbidden}");
    }
    assert_eq!(
        PrePublicationEntry::parse("nir1-local-generation"),
        Some(PrePublicationEntry::LocalGeneration)
    );
}

// ---------------------------------------------------------------------------
// E2-E4: the conversations (S20).
// ---------------------------------------------------------------------------

/// E2: the create writes the mark and the purpose into the ID only; the title
/// and the model keep their defaults; a CW rename does not change the stage.
#[test]
fn e2_the_mark_is_in_the_id_and_a_rename_does_not_move_it() {
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let writing = rig.create("writing");
    let review = rig.create("review");
    assert_eq!(
        conversations::local_conversation_purpose(&writing),
        Some(GenerationPurpose::Writing)
    );
    assert_eq!(
        conversations::local_conversation_purpose(&review),
        Some(GenerationPurpose::Review)
    );
    assert_eq!(
        rig.query_text("SELECT title FROM chat_sessions WHERE id=?1", &writing)
            .as_deref(),
        Some("New session"),
        "no content in the title"
    );
    assert_eq!(
        rig.query_text("SELECT node_id FROM chat_sessions WHERE id=?1", &writing)
            .as_deref(),
        Some(SCENE_ID)
    );
    // A CW rename (title, title_manual, updated_at) changes nothing.
    rig.execute(&format!(
        "UPDATE chat_sessions SET title='nir1-local-review-renamed', title_manual=1,
                updated_at='2030-01-01T00:00:00.000Z' WHERE id='{writing}'"
    ));
    let list = rig.list();
    let entry = list["conversations"]
        .as_array()
        .expect("list")
        .iter()
        .find(|entry| entry["conversationId"] == writing.as_str())
        .expect("still listed")
        .clone();
    assert_eq!(entry["displayName"]["purpose"], "writing");
    assert!(
        !list.to_string().contains("renamed"),
        "no title is returned"
    );
    rig.capture(&writing, "e2");
    let handle = rig.started("writing", &writing);
    let (text, _, view) = rig.drain(&handle);
    assert_eq!(
        (text.as_str(), view["state"].as_str()),
        ("Hello", Some("succeeded"))
    );
    assert_eq!(rig.read(&writing, 0, 10)["purpose"], "writing");
    // The create refuses a node that is not a live Scene, a caller that is
    // not registered, and any other shape.
    rig.execute(&format!(
        "UPDATE tree_nodes SET archived_at='2026-10-26T00:00:00.000Z' WHERE id='{REVISION_SCENE_ID}'"
    ));
    for scene in ["nir1-prepared-missing-scene", REVISION_SCENE_ID] {
        let response: Value = serde_json::from_str(&wire_conversation_create(
            rig.state(),
            json!({"purpose":"writing","sceneId":scene}),
            &caller_json(&rig.caller()),
        ))
        .expect("json");
        assert_eq!(reason(&response), "NIR1_LOCAL_SCENE_MISMATCH", "{response}");
    }
    let mut stranger = rig.caller();
    stranger.caller_id = "dd1a-unregistered".into();
    let response: Value = serde_json::from_str(&wire_conversation_create(
        rig.state(),
        json!({"purpose":"writing","sceneId":SCENE_ID}),
        &caller_json(&stranger),
    ))
    .expect("json");
    assert_eq!(
        reason(&response),
        "NIR1_LOCAL_PROFILE_NOT_ADMITTED",
        "{response}"
    );
    for wire in [
        json!({"purpose":"chat","sceneId":SCENE_ID}),
        json!({"purpose":"writing","sceneId":SCENE_ID,"title":"x"}),
        json!({"purpose":"writing","sceneId":" padded "}),
    ] {
        let response: Value = serde_json::from_str(&wire_conversation_create(
            rig.state(),
            wire,
            &caller_json(&rig.caller()),
        ))
        .expect("json");
        assert_eq!(
            reason(&response),
            "NIR1_LOCAL_REQUEST_INVALID",
            "{response}"
        );
    }
}

/// E3: the list returns only marked conversations, with the purpose and the
/// creation time as the display name. A near-miss ID and the fixture's
/// ordinary session are not listed.
#[test]
fn e3_the_list_returns_only_this_routes_conversations() {
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let first = rig.create("writing");
    let second = rig.create("review");
    rig.execute(&format!(
        "INSERT INTO chat_sessions (id, project_id, node_id, title)
         VALUES ('nir1-local-writing-NOT-A-UUID', '{PROJECT_ID}', '{SCENE_ID}', 'forged'),
                ('nir1-local-writing-0123abcd-4567-89ab-cdef-0123456789AB', '{PROJECT_ID}', '{SCENE_ID}', 'upper')"
    ));
    let list = rig.list();
    assert_eq!(list["status"], "ok", "{list}");
    assert_eq!(list["truncated"], false);
    let ids: Vec<&str> = list["conversations"]
        .as_array()
        .expect("list")
        .iter()
        .map(|entry| entry["conversationId"].as_str().expect("id"))
        .collect();
    assert_eq!(ids.len(), 2, "{list}");
    assert!(ids.contains(&first.as_str()) && ids.contains(&second.as_str()));
    assert!(!ids.contains(&SESSION_ID));
    for entry in list["conversations"].as_array().expect("list") {
        let mut keys: Vec<&String> = entry.as_object().expect("object").keys().collect();
        keys.sort();
        assert_eq!(keys, ["conversationId", "displayName"], "{entry}");
        assert!(entry["displayName"]["createdAt"].is_string());
    }
    assert!(!list.to_string().contains("forged"));
}

/// E4 (S20 の (1)〜(6)): the read returns only stage-2 rows of a marked
/// conversation: the captured input and the success output of this route.
/// A user row without a capture, another route's output, a row whose version
/// no longer matches, the audit and the title are not returned; a session that
/// is not this route's (the fixture's ordinary session, which has a capture)
/// is refused.
#[test]
fn e4_the_read_returns_only_the_row_stage() {
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    // A user row that no capture accepted (as an unrestricted renderer would
    // have written it).
    rig.execute(&format!(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at)
         VALUES ('dd1a-uncaptured', '{conversation}', 'user', 'UNCAPTURED_CANARY',
                 '2026-10-26T09:00:00.000Z')"
    ));
    rig.capture(&conversation, "e4");
    let handle = rig.started("writing", &conversation);
    let (text, thinking, _) = rig.drain(&handle);
    assert_eq!((text.as_str(), thinking.as_str()), ("Hello", "hm"));
    let page = rig.read(&conversation, 0, 64);
    assert_eq!(page["status"], "ok", "{page}");
    assert_eq!(page["purpose"], "writing");
    assert_eq!(page["total"], 2, "{page}");
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows[0]["kind"], "input");
    assert_eq!(rows[0]["text"], "Write the next beat (e4).");
    assert_eq!(rows[0]["attemptStatus"], "succeeded");
    assert_eq!(rows[1]["kind"], "output");
    assert_eq!(rows[1]["text"], "Hello");
    assert!(rows[1]["thinking"].to_string().contains("hm"), "{page}");
    assert!(!page.to_string().contains("UNCAPTURED_CANARY"));
    assert!(!page.to_string().contains("New session"));
    // The fixture's ordinary session has a current capture, but no mark.
    assert_eq!(
        reason(&rig.read(SESSION_ID, 0, 10)),
        "NIR1_LOCAL_NOT_THIS_ROUTE"
    );
    let missing = "nir1-local-writing-0123abcd-4567-89ab-cdef-0123456789ab";
    assert_eq!(
        reason(&rig.read(missing, 0, 10)),
        "NIR1_LOCAL_CONVERSATION_MISSING"
    );
    for limit in [0, 65] {
        assert_eq!(
            reason(&rig.read(&conversation, 0, limit)),
            "NIR1_LOCAL_REQUEST_INVALID"
        );
    }
    // Ranges.
    let second = rig.read(&conversation, 1, 1);
    assert_eq!(second["rows"].as_array().expect("rows").len(), 1);
    assert_eq!(second["rows"][0]["kind"], "output");
    // Another caller of the same workspace may read (not bound to the creator).
    let other = rig.other_caller(2);
    let response: Value = serde_json::from_str(&wire_conversation_read(
        rig.state(),
        json!({"conversationId":conversation,"offset":0,"limit":10}),
        &caller_json(&other),
    ))
    .expect("json");
    assert_eq!(response["status"], "ok", "{response}");
    // Another route's output (the binding's provider differs) is not a row.
    rig.execute(
        "UPDATE nir1_generation_attempts
            SET binding_json = json_set(binding_json, '$.provider', 'other-provider')",
    );
    let page = rig.read(&conversation, 0, 64);
    assert_eq!(page["total"], 1, "{page}");
    assert!(!page.to_string().contains("\"Hello\""));
    // A row whose content changed after its version was recorded no longer
    // verifies: only its ID and a closed reason are returned.
    rig.execute("UPDATE chat_messages SET content='TAMPERED_CANARY' WHERE id='dd1a-message-e4'");
    let page = rig.read(&conversation, 0, 64);
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{page}");
    assert!(
        rows[0]["text"].is_null() && rows[0]["unavailable"].is_string(),
        "{page}"
    );
    assert!(!page.to_string().contains("TAMPERED_CANARY"));
}

// ---------------------------------------------------------------------------
// E5-E6: the start.
// ---------------------------------------------------------------------------

/// E5 (K5/3 Negative): each check before DT-2's capture refuses with a typed
/// reason, with no attempt, no audit event, no connection, and no start
/// record, so the same input can be pressed again.
#[test]
fn e5_the_checks_before_the_capture_refuse_and_can_be_pressed_again() {
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let writing = rig.create("writing");
    let review = rig.create("review");
    // No current capture yet.
    assert_eq!(
        reason(&rig.start("writing", &writing)),
        "NIR1_LOCAL_CAPTURE_NOT_CURRENT"
    );
    // A capture by another caller is not this caller's input.
    let other = rig.other_caller(2);
    rig.capture_as(&other, &review, "e5-other");
    assert_eq!(
        reason(&rig.start("review", &review)),
        "NIR1_LOCAL_CAPTURE_NOT_CURRENT"
    );
    rig.capture(&writing, "e5");
    let caller = rig.caller();
    let cases: Vec<(Value, &str)> = vec![
        // The fixture's ordinary session has a current capture of this caller.
        (
            rig.start("writing", SESSION_ID),
            "NIR1_LOCAL_NOT_THIS_ROUTE",
        ),
        (rig.start("review", &writing), "NIR1_LOCAL_PURPOSE_MISMATCH"),
        (
            rig.start_as(&caller, "writing", &writing, REVISION_SCENE_ID, "absent"),
            "NIR1_LOCAL_SCENE_MISMATCH",
        ),
        (
            rig.start_as(&caller, "writing", &writing, SCENE_ID, "present"),
            "NIR1_LOCAL_KEY_PRESENT",
        ),
        (
            rig.start_as(&caller, "writing", &writing, SCENE_ID, "check-failed"),
            "NIR1_LOCAL_KEY_CHECK_FAILED",
        ),
        (
            rig.start(
                "writing",
                "nir1-local-writing-0123abcd-4567-89ab-cdef-0123456789ab",
            ),
            "NIR1_LOCAL_CONVERSATION_MISSING",
        ),
    ];
    for (response, expected) in &cases {
        assert_eq!(reason(response), *expected, "{response}");
    }
    let mut stranger = rig.caller();
    stranger.caller_epoch += 1;
    assert_eq!(
        reason(&rig.start_as(&stranger, "writing", &writing, SCENE_ID, "absent")),
        "NIR1_LOCAL_PROFILE_NOT_ADMITTED"
    );
    for intent in [
        json!({"purpose":"writing","conversationId":writing,"sceneId":SCENE_ID,"messages":[]}),
        json!({"purpose":"writing","conversationId":writing}),
        json!({"purpose":"agent","conversationId":writing,"sceneId":SCENE_ID}),
    ] {
        let response: Value = serde_json::from_str(&wire_generation_start(
            rig.state(),
            intent,
            json!({"endpointId":"fixture-local","keyVerdict":"absent"}),
            &caller_json(&rig.caller()),
        ))
        .expect("json");
        assert_eq!(
            reason(&response),
            "NIR1_LOCAL_REQUEST_INVALID",
            "{response}"
        );
    }
    assert_eq!(rig.attempts(), 0);
    assert_eq!(rig.audit_events(), 0);
    assert_eq!(rig.recorder.connections(), 0);
    assert_eq!(rig.state().nir1_local_entry.start_record_count(), 0);
    // Pressed again with the key removed: it starts and sends once.
    let handle = rig.started("writing", &writing);
    let (text, _, view) = rig.drain(&handle);
    assert_eq!(
        (text.as_str(), view["state"].as_str()),
        ("Hello", Some("succeeded"))
    );
    assert_eq!(rig.recorder.connections(), 1);
}

/// E5b: a closed startup gate is refused before the capture and can be
/// pressed again once the gate opens (K5/3:601's example).
#[test]
fn e5b_a_start_before_the_startup_gate_opens_can_be_pressed_again() {
    let rig = Rig::without_startup_gate(ok_script(), Nir1LocalEntryTestHooks::default());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e5b");
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_STARTUP_GATE_CLOSED"
    );
    assert_eq!(rig.state().nir1_local_entry.start_record_count(), 0);
    assert!(sweep_and_open_ready_entry_for_test(rig.state()));
    let handle = rig.started("writing", &conversation);
    let (_, _, view) = rig.drain(&handle);
    assert_eq!(view["state"], "succeeded");
}

/// E6 (K5/3:600): after DT-2's `capture` was called, the same capture is
/// refused again wherever the first start ended: the policy refusal (the owner
/// released before the create), a clean create failure, and a success. No
/// owner is rebuilt, no second attempt and no second send.
#[test]
fn e6_the_same_capture_is_never_started_twice() {
    // (1) The AI use policy refused after the capture.
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e6-policy");
    rig.set_policy(
        r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":false,"analysis":true}}"#,
    );
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_POLICY_DENIED"
    );
    rig.set_policy(r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}"#);
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_ALREADY_STARTED"
    );
    assert_eq!((rig.attempts(), rig.recorder.connections()), (0, 0));
    // A new input (a new capture) of the same conversation starts.
    rig.capture(&conversation, "e6-policy-again");
    let handle = rig.started("writing", &conversation);
    let _ = rig.drain(&handle);
    assert_eq!((rig.attempts(), rig.recorder.connections()), (1, 1));
    // (2) After a success.
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_ALREADY_STARTED"
    );
    assert_eq!((rig.attempts(), rig.recorder.connections()), (1, 1));

    // (3) A clean create failure (the COMMIT is vetoed and the reread
    // confirms the absence).
    let rig = Rig::with_hooks(
        ok_script(),
        Nir1LocalEntryTestHooks {
            owner_setup: Some(Arc::new(|hooks| {
                hooks.fail_next("create", Nir1GenerationFailpoint::VetoCommit);
            })),
            ..Default::default()
        },
    );
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e6-create");
    let handle = rig.started("writing", &conversation);
    let (_, _, view) = rig.drain(&handle);
    assert_eq!(view["state"], "failed", "{view}");
    assert_eq!(rig.attempts(), 0, "the vetoed create left no attempt");
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_ALREADY_STARTED"
    );
    assert_eq!((rig.attempts(), rig.recorder.connections()), (0, 0));
}

/// E6a (K5/3 Negative): a second input while the first is in flight is
/// refused at DT-2's capture (`SessionBusy`), with one connection in total;
/// pressed again after the first ends, it is refused by the record.
#[test]
fn e6a_a_second_start_in_the_same_conversation_is_session_busy_then_recorded() {
    let rig = Rig::new(hold_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e6a-first");
    let first = rig.started("writing", &conversation);
    wait_until(|| rig.recorder.connections() == 1, "the first send");
    rig.capture(&conversation, "e6a-second");
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_SESSION_BUSY"
    );
    assert_eq!(rig.recorder.connections(), 1);
    // End the first (a user cancel), then press the second again.
    assert_eq!(rig.cancel(&first)["status"], "ok");
    let (_, _, view) = rig.drain(&first);
    assert_eq!(view["state"], "cancelled");
    assert_eq!(
        reason(&rig.start("writing", &conversation)),
        "NIR1_LOCAL_ALREADY_STARTED"
    );
    assert_eq!((rig.attempts(), rig.recorder.connections()), (1, 1));
}

/// E6b (B-2): the policy read before the attempt refuses a purpose whose item
/// is off and an unreadable value: no attempt, no audit event, no send, no
/// owner left. Review needs `analysis`, Writing `bodyWrite`.
#[test]
fn e6b_the_policy_before_the_attempt_refuses_with_nothing_written() {
    for (purpose, policy, expected) in [
        (
            "writing",
            r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":false,"analysis":true}}"#,
            "NIR1_LOCAL_POLICY_DENIED",
        ),
        (
            "review",
            r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":false}}"#,
            "NIR1_LOCAL_POLICY_DENIED",
        ),
        ("writing", "{not json", "NIR1_LOCAL_POLICY_UNREADABLE"),
    ] {
        let rig = Rig::new(ok_script());
        rig.open_gate();
        let conversation = rig.create(purpose);
        rig.capture(&conversation, "e6b");
        rig.set_policy(policy);
        assert_eq!(
            reason(&rig.start(purpose, &conversation)),
            expected,
            "{purpose} {policy}"
        );
        assert_eq!(rig.attempts(), 0);
        assert_eq!(rig.audit_events(), 0);
        assert_eq!(rig.recorder.connections(), 0);
        assert_eq!(rig.state().nir1_generation_registry.tracked_sessions(), 0);
        assert_eq!(rig.state().nir1_local_entry.handle_count(), 0);
    }
}

// ---------------------------------------------------------------------------
// E7: continue.
// ---------------------------------------------------------------------------

/// E7 (必須防御 14): the output goes only to the exact caller that started
/// the run. Another sender, another epoch, another caller session and an
/// unknown handle look the same; each continue returns at most the bound; a
/// drained handle is gone.
#[test]
fn e7_continue_returns_bounded_output_only_to_the_starting_caller() {
    let long = "x".repeat(NIR1_LOCAL_CONTINUE_MAX_BYTES + 1000);
    let rig = Rig::new(text_script(&[long.as_str()]));
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e7");
    let handle = rig.started("writing", &conversation);
    let other = rig.other_caller(2);
    let mut epoch = rig.caller();
    epoch.caller_epoch += 1;
    let mut session = rig.caller();
    session.session_id = "dd1a-another-caller-session".into();
    for stranger in [&other, &epoch, &session] {
        assert_eq!(
            reason(&rig.continue_as(stranger, &handle)),
            "NIR1_LOCAL_HANDLE_NOT_FOUND"
        );
        assert_eq!(
            reason(&rig.cancel_as(stranger, &handle)),
            "NIR1_LOCAL_HANDLE_NOT_FOUND"
        );
    }
    assert_eq!(
        reason(&rig.continue_as(&rig.caller(), "0123456789abcdef0123456789abcdef")),
        "NIR1_LOCAL_HANDLE_NOT_FOUND"
    );
    rig.wait_final(&handle);
    let first = rig.continue_as(&rig.caller(), &handle);
    assert_eq!(first["status"], "ok", "{first}");
    assert_eq!(
        first["text"].as_str().expect("text").len(),
        NIR1_LOCAL_CONTINUE_MAX_BYTES
    );
    assert_eq!(first["drained"], false);
    let (rest, _, view) = rig.drain(&handle);
    assert_eq!(rest.len(), 1000);
    assert_eq!(view["state"], "succeeded");
    assert_eq!(
        reason(&rig.continue_as(&rig.caller(), &handle)),
        "NIR1_LOCAL_HANDLE_NOT_FOUND",
        "a drained handle is gone"
    );
}

/// E7b: a caller that is no longer registered (an epoch change) gets no more
/// output; its run is stopped, and the capture is left alone (not a
/// withdrawal, K4/3).
#[test]
fn e7b_a_revoked_caller_stops_its_run_without_touching_the_capture() {
    let rig = Rig::new(hold_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e7b");
    let handle = rig.started("writing", &conversation);
    wait_until(|| rig.recorder.connections() == 1, "the send");
    rig.state().profile_egress.invalidate_callers();
    assert_eq!(
        reason(&rig.continue_as(&rig.caller(), &handle)),
        "NIR1_LOCAL_CALLER_REVOKED"
    );
    wait_until(|| rig.recorder.peer_closed(), "the socket to close");
    assert_eq!(rig.capture_state("e7b"), "current");
    assert_eq!(rig.state().nir1_local_entry.handle_count(), 0);
}

// ---------------------------------------------------------------------------
// E8-E9: the cancel.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Moment {
    BeforeCreate,
    BetweenCreateAndClaim,
    AfterClaimCommit,
    BeforeDecision,
    AfterSendStarted,
}

/// E8 (K4/3:477): the user's cancel through `nir1_local_generation_cancel` at
/// each moment stops the owner and cancels the capture, in one command.
/// Before the start decision nothing is sent (no attempt, or a `Cancelled`
/// zero-send terminal); after the send started the transport closes.
#[test]
fn e8_a_cancel_at_every_moment_stops_the_owner_and_cancels_the_capture() {
    for moment in [
        Moment::BeforeCreate,
        Moment::BetweenCreateAndClaim,
        Moment::AfterClaimCommit,
        Moment::BeforeDecision,
        Moment::AfterSendStarted,
    ] {
        // A clean create does not fire `AfterCommit` (only its unknown-COMMIT
        // path does), so the first `AfterCommit` is the claim's.
        let (gate, control) = pause(1);
        let mut hooks = Nir1LocalEntryTestHooks::default();
        match moment {
            Moment::BeforeCreate | Moment::BetweenCreateAndClaim => {
                let point = if matches!(moment, Moment::BeforeCreate) {
                    Nir1LocalAttemptProbe::AfterPrepare
                } else {
                    Nir1LocalAttemptProbe::AfterCreate
                };
                hooks.attempt_probe = Some(Arc::new(move |seen| {
                    if seen == point {
                        gate.hit();
                    }
                }));
            }
            Moment::AfterClaimCommit | Moment::BeforeDecision => {
                let point = if matches!(moment, Moment::AfterClaimCommit) {
                    Nir1OwnerProbePoint::AfterCommit
                } else {
                    Nir1OwnerProbePoint::BeforeDecision
                };
                hooks.owner_setup = Some(Arc::new(move |owner_hooks| {
                    let gate = gate.clone();
                    owner_hooks.on(point, move || gate.hit());
                }));
            }
            Moment::AfterSendStarted => {}
        }
        let rig = Rig::with_hooks(hold_script(), hooks);
        rig.open_gate();
        let conversation = rig.create("writing");
        rig.capture(&conversation, "e8");
        let handle = rig.started("writing", &conversation);
        if matches!(moment, Moment::AfterSendStarted) {
            wait_until(|| rig.recorder.connections() == 1, "the send");
            assert_eq!(rig.cancel(&handle)["status"], "ok", "{moment:?}");
        } else {
            control.wait(&format!("{moment:?}"));
            assert_eq!(rig.cancel(&handle)["status"], "ok", "{moment:?}");
            control.release();
        }
        let (_, _, view) = rig.drain(&handle);
        assert_eq!(view["state"], "cancelled", "{moment:?}: {view}");
        assert_eq!(rig.capture_state("e8"), "cancelled", "{moment:?}");
        match moment {
            Moment::BeforeCreate => {
                assert_eq!(rig.attempts(), 0, "{moment:?}");
                assert_eq!(rig.recorder.connections(), 0, "{moment:?}");
            }
            Moment::BetweenCreateAndClaim | Moment::AfterClaimCommit | Moment::BeforeDecision => {
                assert_eq!(rig.attempts(), 1, "{moment:?}");
                assert_eq!(
                    rig.recorder.connections(),
                    0,
                    "{moment:?}: nothing was sent"
                );
                assert_eq!(
                    rig.query_i64(
                        "SELECT COUNT(*) FROM nir1_generation_attempts
                          WHERE json_extract(terminal_json,'$.observation.terminalStatus')='cancelled'"
                    ),
                    1,
                    "{moment:?}: one Cancelled zero-send terminal"
                );
            }
            Moment::AfterSendStarted => {
                assert_eq!(rig.recorder.connections(), 1);
                wait_until(|| rig.recorder.peer_closed(), "the socket to close");
            }
        }
        // The same capture cannot be started again.
        assert_eq!(
            reason(&rig.start("writing", &conversation)),
            "NIR1_LOCAL_CAPTURE_NOT_CURRENT",
            "{moment:?}"
        );
    }
}

/// E8b (K4/3): a failed capture writer is not a success; the owner is already
/// stopped; the same command again finishes the capture's cancellation.
#[test]
fn e8b_a_failed_capture_writer_is_refused_and_a_retry_finishes() {
    let rig = Rig::new(hold_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e8b");
    let handle = rig.started("writing", &conversation);
    wait_until(|| rig.recorder.connections() == 1, "the send");
    rig.execute(
        "CREATE TRIGGER dd1a_block_cancel BEFORE UPDATE OF state
           ON nir1_chat_input_captures WHEN NEW.state='cancelled'
         BEGIN SELECT RAISE(ABORT,'dd1a writer failure'); END;",
    );
    assert_eq!(
        reason(&rig.cancel(&handle)),
        "NIR1_LOCAL_CANCEL_CAPTURE_FAILED"
    );
    assert_eq!(rig.capture_state("e8b"), "current");
    wait_until(|| rig.recorder.peer_closed(), "the owner stopped the send");
    rig.wait_final(&handle);
    // Draining does not drop a withdrawal that is still pending.
    let _ = rig.drain(&handle);
    assert!(rig
        .state()
        .nir1_local_entry
        .entry_for(&handle, &rig.caller())
        .is_some());
    rig.execute("DROP TRIGGER dd1a_block_cancel;");
    assert_eq!(rig.cancel(&handle)["status"], "ok");
    assert_eq!(rig.capture_state("e8b"), "cancelled");
    let (_, _, view) = rig.drain(&handle);
    assert_eq!(view["state"], "cancelled");
    assert_eq!(rig.state().nir1_local_entry.handle_count(), 0);
}

/// E8c: a cancel after the run is over changes nothing (DR-DD1A-9).
#[test]
fn e8c_a_cancel_after_the_end_changes_nothing() {
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e8c");
    let handle = rig.started("writing", &conversation);
    rig.wait_final(&handle);
    assert_eq!(rig.cancel(&handle)["status"], "ok");
    assert_eq!(rig.capture_state("e8c"), "current");
    let (text, _, view) = rig.drain(&handle);
    assert_eq!(
        (text.as_str(), view["state"].as_str()),
        ("Hello", Some("succeeded"))
    );
}

/// E9 (K4/3): a stop that is not a withdrawal (Main's sender entry: the sender
/// was destroyed or its window closed) stops the owner and leaves the capture
/// current.
#[test]
fn e9_a_destroyed_sender_stops_the_run_and_leaves_the_capture() {
    let rig = Rig::new(hold_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e9");
    let handle = rig.started("writing", &conversation);
    wait_until(|| rig.recorder.connections() == 1, "the send");
    assert_eq!(cancel_sender(rig.state(), rig.caller().sender_id + 1), 0);
    assert_eq!(cancel_sender(rig.state(), rig.caller().sender_id), 1);
    wait_until(|| rig.recorder.peer_closed(), "the socket to close");
    assert_eq!(rig.capture_state("e9"), "current");
    assert_eq!(
        reason(&rig.continue_as(&rig.caller(), &handle)),
        "NIR1_LOCAL_HANDLE_NOT_FOUND"
    );
}

/// E9b (K5/3 必須防御 13): while the transport waits, no startup lease is
/// held, and continue and the owner's cancel do not wait for a database
/// connection someone else holds.
#[test]
fn e9b_no_lease_is_held_and_continue_does_not_wait_for_the_database() {
    let rig = Rig::new(hold_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e9b");
    let handle = rig.started("writing", &conversation);
    wait_until(|| rig.recorder.connections() == 1, "the send");
    assert_eq!(
        rig.state()
            .workspace_lifecycle
            .nir1_startup_gate()
            .active_lease_count(),
        0
    );
    let workspace = active_workspace_snapshot(&rig.state().ws).expect("workspace");
    let (release, holder) = crate::nir1_generation_owner::tests::hold_connection(workspace.db());
    let started = Instant::now();
    let view = rig.continue_as(&rig.caller(), &handle);
    assert_eq!(view["status"], "ok", "{view}");
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "continue waited"
    );
    let entry = rig
        .state()
        .nir1_local_entry
        .entry_for(&handle, &rig.caller())
        .expect("entry");
    let started = Instant::now();
    entry.cancel.cancel();
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "cancel() waited"
    );
    release.send(()).expect("release");
    holder.join().expect("holder");
    wait_until(|| rig.recorder.peer_closed(), "the socket to close");
}

// ---------------------------------------------------------------------------
// E10: the positive path.
// ---------------------------------------------------------------------------

/// E10 (K5/3 Positive): restricted, the default policy, `127.0.0.1`, no key:
/// one connection, the body is the attempt's payload, the output is
/// delivered, the audit chain is complete, Review works in its own
/// conversation, and after a cold reopen the list and the read still return
/// the conversation.
#[test]
fn e10_writing_and_review_reach_the_recorder_once_and_survive_a_cold_reopen() {
    let rig = Rig::new(ok_script());
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e10");
    let handle = rig.started("writing", &conversation);
    let (text, thinking, view) = rig.drain(&handle);
    assert_eq!((text.as_str(), thinking.as_str()), ("Hello", "hm"));
    assert_eq!(view["state"], "succeeded");
    assert_eq!(rig.recorder.connections(), 1);
    let body: Value = serde_json::from_slice(&rig.recorder.body()).expect("json body");
    let stored = rig
        .query_text(
            "SELECT payload_digest FROM nir1_generation_attempts WHERE session_id=?1",
            &conversation,
        )
        .expect("attempt");
    assert_eq!(final_payload_digest(&body).expect("digest"), stored);
    let types = {
        let workspace = active_workspace_snapshot(&rig.state().ws).expect("workspace");
        workspace
            .db()
            .db()
            .with_read_transaction(|conn| {
                let mut statement =
                    conn.prepare("SELECT event_type FROM ai_audit_events ORDER BY id")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .expect("audit")
    };
    assert_eq!(
        types,
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded"
        ]
    );
    // Review in its own conversation.
    let review_rig = Rig::new(ok_script());
    review_rig.open_gate();
    let review = review_rig.create("review");
    review_rig.capture(&review, "e10-review");
    let handle = review_rig.started("review", &review);
    let (_, _, view) = review_rig.drain(&handle);
    assert_eq!(view["state"], "succeeded");
    assert_eq!(review_rig.recorder.connections(), 1);
    // Cold reopen: a new process over the same database file, another caller.
    let database = Database::new(&rig.fixture.root.join("grimodex.db")).expect("database");
    let (state, caller) = native_state_for_workspace(
        &rig.fixture.root,
        database,
        "dd1a-reopen",
        9,
        "dd1a-reopen-session",
    )
    .expect("reopened state");
    state
        .main_grant
        .gate
        .open(PrePublicationEntry::LocalGeneration);
    let list: Value =
        serde_json::from_str(&wire_conversation_list(&state, &caller_json(&caller))).expect("json");
    assert!(list.to_string().contains(&conversation), "{list}");
    let page: Value = serde_json::from_str(&wire_conversation_read(
        &state,
        json!({"conversationId":conversation,"offset":0,"limit":10}),
        &caller_json(&caller),
    ))
    .expect("json");
    assert_eq!(page["total"], 2, "{page}");
    assert_eq!(page["rows"][1]["text"], "Hello");
}

/// E8d (K4/3 順序): the owner is stopped first, without the database, even
/// when the capture writer's entry is refused (here, a workspace shutdown was
/// requested): the cancel is not a success, nothing is created or sent, and a
/// retry after the refusal clears finishes the capture.
#[test]
fn e8d_the_owner_stops_even_when_the_capture_writer_cannot_run() {
    let (gate, control) = pause(1);
    let rig = Rig::with_hooks(
        hold_script(),
        Nir1LocalEntryTestHooks {
            attempt_probe: Some(Arc::new(move |seen| {
                if seen == Nir1LocalAttemptProbe::AfterPrepare {
                    gate.hit();
                }
            })),
            ..Default::default()
        },
    );
    rig.open_gate();
    let conversation = rig.create("writing");
    rig.capture(&conversation, "e8d");
    let handle = rig.started("writing", &conversation);
    control.wait("AfterPrepare");
    rig.state()
        .workspace_shutdown_requested
        .store(true, Ordering::Release);
    assert_eq!(
        reason(&rig.cancel(&handle)),
        "NIR1_LOCAL_CANCEL_CAPTURE_FAILED"
    );
    control.release();
    rig.wait_final(&handle);
    let view = rig.continue_as(&rig.caller(), &handle);
    assert_eq!(view["state"], "cancelled", "{view}");
    assert_eq!(rig.attempts(), 0);
    assert_eq!(rig.recorder.connections(), 0);
    assert_eq!(rig.capture_state("e8d"), "current");
    rig.state()
        .workspace_shutdown_requested
        .store(false, Ordering::Release);
    assert_eq!(rig.cancel(&handle)["status"], "ok");
    assert_eq!(rig.capture_state("e8d"), "cancelled");
}
