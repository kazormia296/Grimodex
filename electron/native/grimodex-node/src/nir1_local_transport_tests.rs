//! Tests of the DT-5b local transport. IDs C1-C11, L1-L8 and A1 refer to the
//! DT-5 test plan. The peer is a `#[cfg(test)]` `TcpListener` script server:
//! it exists only in this test build, counts connections, records the bytes
//! it received and plays a script of writes, pauses and closes.

use super::*;
use crate::nir1_generation_owner::tests::{
    audit_events, audit_types, chat_message_exists, hold_connection, set_project_ai_policy,
    wait_for, OwnerFixture,
};
use crate::nir1_generation_owner::{
    Nir1GenerationRefusal, Nir1OwnerControl, Nir1OwnerProbePoint, Nir1TransportDecision,
};
use crate::nir1_prepared_request::parse_loopback_chat_completions_endpoint;
use grimodex_core::nir1_local_send_policy::{decide, Nir1LocalSendPolicyDecision};
use grimodex_db::nir1_generation::FailureClassification;
use grimodex_db::workspace_lifecycle::{
    AdmissionKind, LifecycleEdge, OperationId, WorkspaceLifecycleObserver,
};
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};

// ---------------------------------------------------------------------------
// The script server.
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Step {
    Write(Vec<u8>),
    Sleep(u64),
    /// Read until the peer closes (at most 5 s) and record that it did.
    WaitPeerClose,
    /// Forward the received request to another listener.
    Relay(SocketAddr),
}

#[derive(Default)]
struct ServerShared {
    connections: AtomicUsize,
    requests: Mutex<Vec<Vec<u8>>>,
    peer_closed: AtomicBool,
    stop: AtomicBool,
}

struct TestServer {
    addr: SocketAddr,
    shared: Arc<ServerShared>,
    accept: Option<JoinHandle<()>>,
}

type OnAccept = Arc<dyn Fn() + Send + Sync>;

impl TestServer {
    fn start(script: Vec<Step>) -> Self {
        Self::start_on(Ipv4Addr::LOCALHOST.into(), script, None).expect("an IPv4 loopback listener")
    }

    fn start_on(ip: IpAddr, script: Vec<Step>, on_accept: Option<OnAccept>) -> Option<Self> {
        let listener = TcpListener::bind((ip, 0)).ok()?;
        listener.set_nonblocking(true).ok()?;
        let addr = listener.local_addr().ok()?;
        let shared = Arc::new(ServerShared::default());
        let accept_shared = Arc::clone(&shared);
        let accept = thread::spawn(move || {
            while !accept_shared.stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        accept_shared.connections.fetch_add(1, Ordering::SeqCst);
                        if let Some(on_accept) = &on_accept {
                            on_accept();
                        }
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
        Some(Self {
            addr,
            shared,
            accept: Some(accept),
        })
    }

    fn endpoint(&self) -> LoopbackChatEndpoint {
        let host = if self.addr.is_ipv4() {
            format!("127.0.0.1:{}", self.addr.port())
        } else {
            format!("[::1]:{}", self.addr.port())
        };
        parse_loopback_chat_completions_endpoint(&format!("http://{host}/v1")).expect("endpoint")
    }

    fn connections(&self) -> usize {
        self.shared.connections.load(Ordering::SeqCst)
    }

    /// The bytes of the first request (empty if none arrived).
    fn request(&self) -> Vec<u8> {
        self.shared
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .first()
            .cloned()
            .unwrap_or_default()
    }

    fn peer_closed(&self) -> bool {
        self.shared.peer_closed.load(Ordering::SeqCst)
    }
}

impl Drop for TestServer {
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

fn serve(mut stream: TcpStream, script: Vec<Step>, shared: &ServerShared) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(20)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut request = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buffer = [0u8; 4096];
    loop {
        if request_total_len(&request).is_some_and(|total| request.len() >= total) {
            break;
        }
        if Instant::now() >= deadline || shared.stop.load(Ordering::Acquire) {
            break;
        }
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
        .push(request.clone());
    for step in script {
        match step {
            Step::Write(bytes) => {
                let _ = stream.write_all(&bytes);
            }
            Step::Sleep(millis) => {
                let until = Instant::now() + Duration::from_millis(millis);
                while Instant::now() < until && !shared.stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(2));
                }
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
            Step::Relay(target) => {
                if let Ok(mut relay) = TcpStream::connect_timeout(&target, Duration::from_secs(2)) {
                    let _ = relay.write_all(&request);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Wire builders.
// ---------------------------------------------------------------------------

const HEAD_CHUNKED: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

fn chunk(data: &str) -> Vec<u8> {
    format!("{:x}\r\n{data}\r\n", data.len()).into_bytes()
}

fn sse(value: Value) -> String {
    format!("data: {value}\n\n")
}

fn text_event(content: &str, finish: Option<&str>) -> String {
    sse(json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":finish}]}))
}

fn thinking_event(content: &str) -> String {
    sse(json!({"choices":[{"index":0,"delta":{"reasoning_content":content},"finish_reason":null}]}))
}

const DONE: &str = "data: [DONE]\n\n";

fn write(bytes: impl Into<Vec<u8>>) -> Step {
    Step::Write(bytes.into())
}

/// A complete, valid answer: thinking "hm", text "Hello", `stop`, `[DONE]`.
fn ok_script() -> Vec<Step> {
    vec![
        write(HEAD_CHUNKED),
        write(chunk(&thinking_event("hm"))),
        write(chunk(&text_event("Hel", None))),
        write(chunk(&text_event("lo", Some("stop")))),
        write(chunk(DONE)),
        write("0\r\n\r\n"),
    ]
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

fn payload_json(stream: bool) -> Value {
    json!({
        "model": "test-model",
        "messages": [{"role": "user", "content": "こんにちは"}],
        "stream": stream,
    })
}

struct Claimed {
    owner: Nir1TransportOwner,
    control: Arc<Nir1OwnerControl>,
    attempt_id: String,
}

fn claim(
    fixture: &OwnerFixture,
    session: usize,
    key: &str,
    endpoint: &LoopbackChatEndpoint,
    purpose: GenerationPurpose,
    stream: bool,
) -> Claimed {
    let submission = fixture.accept(session, key);
    let owner = fixture.owner(session, &submission).expect("owner");
    let mut request = fixture.request(&owner, &submission);
    request.endpoint_identity = endpoint.identity_digest().expect("identity");
    request.payload = payload_json(stream);
    request.purpose = purpose;
    let prepared = owner.create(request).expect("durable attempt");
    let control = prepared.hooks();
    let attempt_id = prepared.attempt_id().to_owned();
    match prepared.claim_for_transport() {
        Nir1TransportDecision::Start(owner) => Claimed {
            owner,
            control,
            attempt_id,
        },
        Nir1TransportDecision::NotStarted(settlement) => panic!("{settlement:?}"),
    }
}

fn claim_writing(
    fixture: &OwnerFixture,
    session: usize,
    key: &str,
    endpoint: &LoopbackChatEndpoint,
) -> Claimed {
    claim(
        fixture,
        session,
        key,
        endpoint,
        GenerationPurpose::Writing,
        true,
    )
}

fn fast_config() -> Nir1LocalTransportConfig {
    Nir1LocalTransportConfig {
        wire: Limits::DEFAULT,
        connect_timeout: Duration::from_millis(500),
        request_write_timeout: Duration::from_secs(2),
        first_byte_timeout: Duration::from_secs(5),
        event_gap_timeout: Duration::from_secs(5),
        total_timeout: Duration::from_secs(10),
        done_body_end_timeout: Duration::from_millis(500),
        cancel_poll: Duration::from_millis(5),
        join_limit: Duration::from_secs(1),
        channel_messages: 16,
        channel_bytes: 64 * 1024,
    }
}

fn input_for(
    key: &str,
    endpoint: &LoopbackChatEndpoint,
    purpose: Nir1LocalSendPurpose,
    config: Nir1LocalTransportConfig,
    hooks: Option<Arc<TransportTestHooks>>,
) -> Nir1LocalGenerationInput {
    let Nir1LocalSendPolicyDecision::Allowed(policy_basis) = decide(None, purpose) else {
        panic!("an unset policy allows");
    };
    let mut input =
        Nir1LocalGenerationInput::new(*endpoint, purpose, policy_basis, format!("{key}-output"));
    input.config = config;
    input.hooks = hooks;
    input
}

fn start(
    claimed: Claimed,
    key: &str,
    endpoint: &LoopbackChatEndpoint,
    config: Nir1LocalTransportConfig,
) -> (Nir1LocalRun, String, Arc<Nir1OwnerControl>) {
    let Claimed {
        owner,
        control,
        attempt_id,
    } = claimed;
    let run = start_local_generation(
        owner,
        input_for(key, endpoint, Nir1LocalSendPurpose::Writing, config, None),
    );
    (run, attempt_id, control)
}

fn finished(run: &Nir1LocalRun) -> Arc<Nir1LocalRunOutcome> {
    let outcome = run
        .wait_final(Duration::from_secs(20))
        .expect("the run reaches a final state");
    assert!(outcome.state.is_final());
    assert!(run.outcome().is_some());
    outcome
}

fn terminal_status(fixture: &OwnerFixture, attempt_id: &str) -> (String, String) {
    let terminal = fixture
        .attempt(attempt_id)
        .terminal
        .expect("a durable terminal");
    (
        terminal.observation["terminalStatus"]
            .as_str()
            .expect("status")
            .to_owned(),
        terminal.observation["parseStatus"]
            .as_str()
            .expect("parse")
            .to_owned(),
    )
}

fn assert_terminal(fixture: &OwnerFixture, attempt_id: &str, status: &str, parse: &str) {
    assert_eq!(
        terminal_status(fixture, attempt_id),
        (status.to_owned(), parse.to_owned()),
        "terminal of {attempt_id}"
    );
}

fn terminal_events(fixture: &OwnerFixture) -> Vec<String> {
    audit_types(fixture)
        .into_iter()
        .filter(|name| {
            matches!(
                name.as_str(),
                "execution.succeeded"
                    | "execution.failed"
                    | "execution.cancelled"
                    | "execution.skipped"
            )
        })
        .collect()
}

fn last_audit(fixture: &OwnerFixture) -> grimodex_db::ai_audit::AiAuditEvent {
    audit_events(fixture).pop().expect("an audit event")
}

fn failure_classification(
    fixture: &OwnerFixture,
    attempt_id: &str,
) -> Option<FailureClassification> {
    fixture
        .attempt(attempt_id)
        .terminal
        .and_then(|terminal| terminal.failure_classification)
}

fn collect_text_until(run: &Nir1LocalRun, needle: &str) -> (String, String) {
    let mut text = String::new();
    let mut thinking = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !text.contains(needle) {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {needle:?}"
        );
        let delta = run.take_delta(usize::MAX);
        text.push_str(&delta.text);
        thinking.push_str(&delta.thinking);
        thread::sleep(Duration::from_millis(1));
    }
    (text, thinking)
}

fn split_request(request: &[u8]) -> (String, Vec<u8>) {
    let end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("a request head")
        + 4;
    (
        String::from_utf8(request[..end].to_vec()).expect("ASCII head"),
        request[end..].to_vec(),
    )
}

// ---------------------------------------------------------------------------
// C1: the positive path.
// ---------------------------------------------------------------------------

fn positive_case(
    ip: IpAddr,
    purpose: GenerationPurpose,
    send_purpose: Nir1LocalSendPurpose,
    key: &str,
) {
    let fixture = Arc::new(OwnerFixture::new());
    let seen_at_accept: Arc<Mutex<Option<Vec<String>>>> = Arc::new(Mutex::new(None));
    let on_accept: OnAccept = {
        let fixture = Arc::clone(&fixture);
        let seen = Arc::clone(&seen_at_accept);
        Arc::new(move || {
            *seen.lock().unwrap_or_else(PoisonError::into_inner) = Some(audit_types(&fixture));
        })
    };
    let Some(server) = TestServer::start_on(ip, ok_script(), Some(on_accept)) else {
        eprintln!("SKIPPED {key}: no loopback listener on {ip} in this environment");
        return;
    };
    let endpoint = server.endpoint();
    let claimed = claim(&fixture, 0, key, &endpoint, purpose, true);
    let attempt_id = claimed.attempt_id.clone();
    let run = start_local_generation(
        claimed.owner,
        input_for(key, &endpoint, send_purpose, fast_config(), None),
    );
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Succeeded, "{outcome:?}");
    assert_eq!(outcome.reason, "parsed");
    assert!(
        matches!(&outcome.end, Nir1LocalRunEnd::Terminal(t) if t.attempt_id == attempt_id),
        "{outcome:?}"
    );
    assert_eq!(server.connections(), 1, "one attempt, one connection");

    // The three start events were durable at accept time (before any byte).
    assert_eq!(
        seen_at_accept
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .expect("accepted"),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched"
        ]
    );

    // The request: allow-listed headers only, the exact canonical body.
    let (head, body) = split_request(&server.request());
    let lines: Vec<&str> = head.trim_end_matches("\r\n\r\n").split("\r\n").collect();
    assert_eq!(lines[0], "POST /v1/chat/completions HTTP/1.1");
    let names: Vec<&str> = lines[1..]
        .iter()
        .map(|line| line.split(": ").next().expect("name"))
        .collect();
    assert_eq!(
        names,
        [
            "Host",
            "User-Agent",
            "Accept",
            "Content-Type",
            "Content-Length",
            "Connection"
        ]
    );
    let host = if ip.is_ipv4() {
        format!("127.0.0.1:{}", server.addr.port())
    } else {
        format!("[::1]:{}", server.addr.port())
    };
    assert!(lines.contains(&format!("Host: {host}").as_str()));
    assert!(lines.contains(&"Accept: text/event-stream"));
    assert!(lines.contains(&"Connection: close"));
    assert!(lines.contains(&format!("Content-Length: {}", body.len()).as_str()));
    let sent = String::from_utf8(body).expect("UTF-8 body");
    let canonical = canonical_json_string(&payload_json(true)).expect("canonical");
    assert_eq!(sent, canonical, "the canonical payload bytes, unchanged");
    assert_eq!(
        final_payload_digest(&serde_json::from_str::<Value>(&sent).expect("JSON")).expect("digest"),
        fixture.attempt(&attempt_id).payload_digest
    );

    // Text and thinking stay separate; the success is durable and complete.
    let delta = run.take_delta(usize::MAX);
    assert_eq!(delta.text, "Hello");
    assert_eq!(delta.thinking, "hm");
    assert_eq!(delta.state, Nir1LocalRunState::Succeeded);
    assert_terminal(&fixture, &attempt_id, "succeeded", "parsed");
    let terminal = fixture.attempt(&attempt_id).terminal.expect("terminal");
    assert!(terminal.message_version.is_some());
    assert!(!terminal.receipt_digest.is_empty());
    assert!(chat_message_exists(&fixture, &format!("{key}-output")));
    assert_eq!(
        audit_types(&fixture),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded"
        ]
    );

    // A1: the audited socket is the one derived from the target and the audited
    // body is the canonical body that was sent.
    let events = audit_events(&fixture);
    let prepared = events
        .iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("request.prepared");
    let expected_socket = if ip.is_ipv4() {
        format!("127.0.0.1:{}", server.addr.port())
    } else {
        format!("[::1]:{}", server.addr.port())
    };
    assert_eq!(prepared.payload["socket"], expected_socket.as_str());
    assert_eq!(
        canonical_json_string(&prepared.payload["request"]["body"]).expect("canonical"),
        sent
    );
    assert_eq!(prepared.payload["credentialsExcluded"], true);
    assert_eq!(fixture.gate().active_lease_count(), 0);
    assert_eq!(
        fixture.state.nir1_generation_registry.tracked_sessions(),
        0,
        "the slot is released after the terminal"
    );
}

#[test]
fn c1_writing_positive_over_ipv4() {
    positive_case(
        Ipv4Addr::LOCALHOST.into(),
        GenerationPurpose::Writing,
        Nir1LocalSendPurpose::Writing,
        "c1",
    );
}

#[test]
fn c1b_review_positive() {
    positive_case(
        Ipv4Addr::LOCALHOST.into(),
        GenerationPurpose::Review,
        Nir1LocalSendPurpose::Review,
        "c1b",
    );
}

#[test]
fn c1c_positive_over_ipv6_when_available() {
    positive_case(
        Ipv6Addr::LOCALHOST.into(),
        GenerationPurpose::Writing,
        Nir1LocalSendPurpose::Writing,
        "c1c",
    );
}

// ---------------------------------------------------------------------------
// C2: the audit start comes before the connection.
// ---------------------------------------------------------------------------

#[test]
fn c2_a_failed_or_slow_audit_start_means_no_connection() {
    use grimodex_db::nir1_generation::Nir1GenerationFailpoint;
    let fixture = OwnerFixture::new();

    // The start fails at COMMIT.
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c2-veto", &endpoint);
    claimed
        .control
        .test_hooks()
        .fail_next("audit-start", Nir1GenerationFailpoint::VetoCommit);
    let (run, id, _) = start(claimed, "c2-veto", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Failed);
    assert_eq!(outcome.reason, "audit-start-failed");
    assert_eq!(server.connections(), 0);
    assert_terminal(&fixture, &id, "failed", "not-attempted");
    assert_eq!(
        failure_classification(&fixture, &id),
        Some(FailureClassification::DispatchUnavailable)
    );
    assert!(audit_types(&fixture).is_empty());

    // The start waits for the connection mutex longer than its 100 ms limit.
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c2-slow", &endpoint);
    claimed.control.test_hooks().examine_time();
    let (release, holder) = hold_connection(&fixture.authority);
    let releaser = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        let _ = release.send(());
    });
    let (run, id, _) = start(claimed, "c2-slow", &endpoint, fast_config());
    let outcome = finished(&run);
    releaser.join().expect("releaser");
    holder.join().expect("holder");
    assert_eq!(outcome.state, Nir1LocalRunState::Failed);
    assert_eq!(server.connections(), 0);
    assert_terminal(&fixture, &id, "failed", "not-attempted");
}

// ---------------------------------------------------------------------------
// C3 and C4: the policy is read right before the send, outside every lock.
// ---------------------------------------------------------------------------

#[test]
fn c3_a_policy_that_does_not_allow_means_no_connection_and_a_running_send_continues() {
    let fixture = OwnerFixture::new();
    let denied = r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":false,"analysis":true}}"#;
    for (index, value) in [denied, "not json at all"].into_iter().enumerate() {
        let server = TestServer::start(ok_script());
        let endpoint = server.endpoint();
        let key = format!("c3-{index}");
        let claimed = claim_writing(&fixture, 0, &key, &endpoint);
        // The attempt exists; the policy changes before the send.
        set_project_ai_policy(&fixture, value);
        let (run, id, _) = start(claimed, &key, &endpoint, fast_config());
        let outcome = finished(&run);
        assert_eq!(outcome.state, Nir1LocalRunState::Failed);
        assert_eq!(outcome.reason, "send-refused-policy", "{value}");
        assert!(
            matches!(
                &outcome.end,
                Nir1LocalRunEnd::Settled(Nir1Settlement::ZeroSend(_))
            ),
            "{outcome:?}"
        );
        assert_eq!(server.connections(), 0);
        assert_terminal(&fixture, &id, "failed", "not-attempted");
        assert_eq!(
            failure_classification(&fixture, &id),
            Some(FailureClassification::DispatchUnavailable)
        );
        // The start events are durable; the terminal closes them as not sent.
        let events = audit_events(&fixture);
        let tail = &events[events.len() - 4..];
        assert_eq!(tail[0].event_type, "execution.started");
        assert_eq!(tail[3].event_type, "execution.failed");
        assert_eq!(tail[3].payload["remoteOutcome"], "not-sent");
    }
    set_project_ai_policy(
        &fixture,
        r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}"#,
    );

    // Changing the policy while a send runs does not cancel it.
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("Hel", None))),
        Step::Sleep(300),
        write(chunk(&text_event("lo", Some("stop")))),
        write(chunk(DONE)),
        write("0\r\n\r\n"),
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c3-running", &endpoint);
    let (run, id, _) = start(claimed, "c3-running", &endpoint, fast_config());
    collect_text_until(&run, "Hel");
    set_project_ai_policy(&fixture, denied);
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Succeeded, "{outcome:?}");
    assert_terminal(&fixture, &id, "succeeded", "parsed");
}

type ConnectionHolder = (mpsc::Sender<()>, thread::JoinHandle<()>);

#[test]
fn c4_the_policy_read_is_outside_the_cancel_lock_and_holds_no_lease() {
    let fixture = Arc::new(OwnerFixture::new());
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c4", &endpoint);
    // After the audit start, hold the connection mutex so the policy read
    // waits for its limit.
    let (held_tx, held_rx) = mpsc::channel();
    let holder: Arc<Mutex<Option<ConnectionHolder>>> = Arc::new(Mutex::new(None));
    {
        let authority = Arc::clone(&fixture.authority);
        let holder = Arc::clone(&holder);
        let fired = AtomicBool::new(false);
        claimed
            .control
            .test_hooks()
            .on(Nir1OwnerProbePoint::AfterAuditStart, move || {
                if !fired.swap(true, Ordering::SeqCst) {
                    *holder.lock().unwrap_or_else(PoisonError::into_inner) =
                        Some(hold_connection(&authority));
                    held_tx.send(()).expect("held");
                }
            });
    }
    let cancel = claimed.owner.cancel_handle();
    let (run, id, _) = start(claimed, "c4", &endpoint, fast_config());
    held_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the policy read is waiting on the held connection");

    // Cancel does not wait for the database.
    let started = Instant::now();
    cancel.cancel();
    assert!(started.elapsed() < Duration::from_millis(500));
    // No lease is held, so a closing edge drains at once.
    assert_eq!(fixture.gate().active_lease_count(), 0);
    fixture
        .gate()
        .on_lifecycle_edge(&LifecycleEdge::TransitionAdmitted {
            operation_id: OperationId::new(11),
            kind: AdmissionKind::Restore,
            revision: u64::MAX - 1,
        });
    let started = Instant::now();
    fixture
        .gate()
        .drain_before_ready(OperationId::new(11), Duration::from_millis(250))
        .expect("the drain finds no lease");
    assert!(started.elapsed() < Duration::from_millis(250));

    let (release, worker) = holder
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .expect("holder");
    let _ = release.send(());
    worker.join().expect("holder worker");
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled, "{outcome:?}");
    assert_eq!(server.connections(), 0);
    assert_terminal(&fixture, &id, "cancelled", "not-attempted");
}

// ---------------------------------------------------------------------------
// C5: the connection goes to the target only, and only that peer is accepted.
// ---------------------------------------------------------------------------

#[test]
fn c5_a_peer_that_is_not_the_target_gets_no_byte() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c5", &endpoint);
    let hooks = Arc::new(TransportTestHooks::default());
    *hooks
        .peer_override
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        server.addr.port().wrapping_add(1),
    ));
    let Claimed {
        owner, attempt_id, ..
    } = claimed;
    let run = start_local_generation(
        owner,
        input_for(
            "c5",
            &endpoint,
            Nir1LocalSendPurpose::Writing,
            fast_config(),
            Some(hooks),
        ),
    );
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Failed);
    assert_eq!(outcome.reason, "peer-mismatch");
    assert_eq!(server.connections(), 1, "the connection was opened");
    wait_for(
        || !server.shared.requests.lock().unwrap().is_empty(),
        "the server to see the connection end",
    );
    assert!(server.request().is_empty(), "not one byte was written");
    assert_terminal(&fixture, &attempt_id, "failed", "not-attempted");
    let last = last_audit(&fixture);
    assert_eq!(last.event_type, "execution.failed");
    assert_eq!(last.payload["remoteOutcome"], "not-sent");
}

/// The transport has no name resolution and no host-string connect.
#[test]
fn c5_the_source_never_resolves_a_name_or_connects_by_host_string() {
    let source = include_str!("nir1_local_transport.rs");
    for forbidden in [
        "ToSocketAddrs",
        "to_socket_addrs",
        "TcpStream::connect(",
        "lookup_host",
        "getaddrinfo",
        "reqwest",
        "hyper",
        "proxy",
        "Proxy",
    ] {
        assert!(!source.contains(forbidden), "{forbidden}");
    }
    assert_eq!(source.matches("connect_timeout(").count(), 1);
}

// ---------------------------------------------------------------------------
// C6: no proxy.
// ---------------------------------------------------------------------------

#[test]
fn c6_proxy_environment_variables_are_not_used() {
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("proxy listener");
    proxy.set_nonblocking(true).expect("nonblocking");
    let proxy_url = format!(
        "http://127.0.0.1:{}",
        proxy.local_addr().expect("addr").port()
    );
    let names = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ];
    for name in names {
        std::env::set_var(name, &proxy_url);
    }
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c6", &endpoint);
    let (run, id, _) = start(claimed, "c6", &endpoint, fast_config());
    let outcome = finished(&run);
    for name in names {
        std::env::remove_var(name);
    }
    assert_eq!(outcome.state, Nir1LocalRunState::Succeeded, "{outcome:?}");
    assert_eq!(server.connections(), 1);
    assert!(
        matches!(proxy.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock),
        "the proxy was never contacted"
    );
    assert_terminal(&fixture, &id, "succeeded", "parsed");
}

// ---------------------------------------------------------------------------
// C7 and C8: bad responses end the attempt, with one connection.
// ---------------------------------------------------------------------------

#[test]
fn c7_bad_statuses_and_disconnects_are_failed_invalid_without_a_retry() {
    let fixture = OwnerFixture::new();
    let status = |line: &str| {
        vec![write(format!(
            "HTTP/1.1 {line}\r\nContent-Length: 0\r\nLocation: http://127.0.0.1:1/v1\r\nConnection: close\r\n\r\n"
        ))]
    };
    let cases: Vec<(&str, Vec<Step>)> = vec![
        ("redirect", status("302 Found")),
        ("unauthorized", status("401 Unauthorized")),
        ("rate-limited", status("429 Too Many Requests")),
        ("server-error", status("500 Internal Server Error")),
        ("closed-before-head", vec![]),
        (
            "closed-mid-stream",
            vec![write(HEAD_CHUNKED), write(chunk(&text_event("Hel", None)))],
        ),
        (
            "closed-mid-event",
            vec![write(HEAD_CHUNKED), write(chunk("data: {\"choi"))],
        ),
    ];
    for (name, script) in cases {
        let server = TestServer::start(script);
        let endpoint = server.endpoint();
        let key = format!("c7-{name}");
        let claimed = claim_writing(&fixture, 0, &key, &endpoint);
        let (run, id, _) = start(claimed, &key, &endpoint, fast_config());
        let outcome = finished(&run);
        assert_eq!(
            outcome.state,
            Nir1LocalRunState::Failed,
            "{name}: {outcome:?}"
        );
        assert_terminal(&fixture, &id, "failed", "invalid");
        assert_eq!(
            failure_classification(&fixture, &id),
            Some(FailureClassification::InvalidOutput),
            "{name}"
        );
        thread::sleep(Duration::from_millis(30));
        assert_eq!(server.connections(), 1, "{name}: no retry, no reconnect");
        assert!(!chat_message_exists(&fixture, &format!("{key}-output")));
        // The audit records that the request was sent and what was observed.
        assert_eq!(
            last_audit(&fixture).event_type,
            "execution.failed",
            "{name}"
        );
        assert_eq!(last_audit(&fixture).payload["remoteOutcome"], "observed");
    }
}

#[test]
fn c8_a_non_stream_json_answer_is_not_a_success() {
    let fixture = OwnerFixture::new();
    let body = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"Hello"},"finish_reason":"stop"}]}"#;
    let server = TestServer::start(vec![write(format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ))]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "c8", &endpoint);
    let (run, id, _) = start(claimed, "c8", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Failed);
    assert_terminal(&fixture, &id, "failed", "invalid");
    assert_eq!(server.connections(), 1, "no fallback request");
    assert!(!chat_message_exists(&fixture, "c8-output"));
    assert_eq!(run.take_delta(usize::MAX).text, "");
}

// ---------------------------------------------------------------------------
// C9: the attempt's bindings are checked before any connection.
// ---------------------------------------------------------------------------

#[test]
fn c9_a_target_payload_or_purpose_that_is_not_the_bound_one_sends_nothing() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let other = TestServer::start(ok_script());
    let endpoint = server.endpoint();

    // Another target than the one the attempt bound.
    let claimed = claim_writing(&fixture, 0, "c9-target", &endpoint);
    let (run, id, _) = start(claimed, "c9-target", &other.endpoint(), fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.reason, "target-identity-mismatch");
    assert_terminal(&fixture, &id, "failed", "not-attempted");

    // Another purpose.
    let claimed = claim_writing(&fixture, 0, "c9-purpose", &endpoint);
    let Claimed {
        owner, attempt_id, ..
    } = claimed;
    let run = start_local_generation(
        owner,
        input_for(
            "c9-purpose",
            &endpoint,
            Nir1LocalSendPurpose::Review,
            fast_config(),
            None,
        ),
    );
    assert_eq!(finished(&run).reason, "purpose-mismatch");
    assert_terminal(&fixture, &attempt_id, "failed", "not-attempted");

    // A payload that is not the one whose digest the attempt stored.
    let claimed = claim_writing(&fixture, 0, "c9-payload", &endpoint);
    let Claimed {
        mut owner,
        attempt_id,
        ..
    } = claimed;
    owner.replace_canonical_payload_for_test(
        canonical_json_string(&json!({"model":"other","messages":[],"stream":true}))
            .expect("canonical"),
    );
    let run = start_local_generation(
        owner,
        input_for(
            "c9-payload",
            &endpoint,
            Nir1LocalSendPurpose::Writing,
            fast_config(),
            None,
        ),
    );
    assert_eq!(finished(&run).reason, "payload-digest-mismatch");
    assert_terminal(&fixture, &attempt_id, "failed", "not-attempted");

    // A payload that does not ask for a stream.
    let claimed = claim(
        &fixture,
        0,
        "c9-stream",
        &endpoint,
        GenerationPurpose::Writing,
        false,
    );
    let (run, id, _) = start(claimed, "c9-stream", &endpoint, fast_config());
    assert_eq!(finished(&run).reason, "payload-not-streaming");
    assert_terminal(&fixture, &id, "failed", "not-attempted");

    assert_eq!(server.connections(), 0);
    assert_eq!(other.connections(), 0);
    assert!(
        audit_types(&fixture).is_empty(),
        "nothing was audited as started: the binding check comes first"
    );
}

// ---------------------------------------------------------------------------
// C10: one attempt, one send.
// ---------------------------------------------------------------------------

#[test]
fn c10_the_same_submission_cannot_be_sent_twice() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("Hel", None))),
        Step::Sleep(200),
        write(chunk(&text_event("lo", Some("stop")))),
        write(chunk(DONE)),
        write("0\r\n\r\n"),
    ]);
    let endpoint = server.endpoint();
    let submission = fixture.accept(0, "c10");
    let owner = fixture.owner(0, &submission).expect("owner");
    let mut request = fixture.request(&owner, &submission);
    request.endpoint_identity = endpoint.identity_digest().expect("identity");
    request.payload = payload_json(true);
    let prepared = owner.create(request).expect("attempt");
    let Nir1TransportDecision::Start(owner) = prepared.claim_for_transport() else {
        panic!("start");
    };
    let run = start_local_generation(
        owner,
        input_for(
            "c10",
            &endpoint,
            Nir1LocalSendPurpose::Writing,
            fast_config(),
            None,
        ),
    );
    // While it runs, the same submission has no second owner...
    assert!(matches!(
        fixture.owner(0, &submission),
        Err(Nir1GenerationRefusal::SameSubmissionInFlight { .. })
    ));
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Succeeded);
    // ...and after the terminal the attempt is never created again.
    let again = fixture.owner(0, &submission).expect("an owner");
    let request = fixture.request(&again, &submission);
    assert!(matches!(
        again.create(request),
        Err(Nir1GenerationRefusal::SubmissionAlreadyAttempted { .. })
    ));
    assert_eq!(server.connections(), 1);
    assert_eq!(fixture.attempt_count(), 1);
}

// ---------------------------------------------------------------------------
// C11: the extent of what is promised.
// ---------------------------------------------------------------------------

#[test]
fn c11_a_listener_that_is_not_openai_compatible_still_gets_the_whole_request() {
    let fixture = OwnerFixture::new();
    let sink = TestServer::start(vec![]);
    let cases: Vec<(&str, Vec<Step>)> = vec![
        ("not-http", vec![write("garbage that is not http\r\n\r\n")]),
        ("silent-close", vec![]),
        ("relay", vec![Step::Relay(sink.addr)]),
    ];
    for (name, script) in cases {
        let server = TestServer::start(script);
        let endpoint = server.endpoint();
        let key = format!("c11-{name}");
        let claimed = claim_writing(&fixture, 0, &key, &endpoint);
        let (run, id, _) = start(claimed, &key, &endpoint, fast_config());
        let outcome = finished(&run);
        assert_eq!(outcome.state, Nir1LocalRunState::Failed, "{name}");
        assert_terminal(&fixture, &id, "failed", "invalid");
        let (head, body) = split_request(&server.request());
        assert!(head.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        assert_eq!(
            String::from_utf8(body).expect("UTF-8"),
            canonical_json_string(&payload_json(true)).expect("canonical"),
            "{name}: the request reached the listener whole"
        );
        if name == "relay" {
            wait_for(
                || !sink.shared.requests.lock().unwrap().is_empty(),
                "the relay to arrive",
            );
            assert_eq!(sink.request(), server.request());
        }
    }
}

// ---------------------------------------------------------------------------
// L1 - L3: cancel.
// ---------------------------------------------------------------------------

#[test]
fn l1_cancel_while_streaming_closes_the_socket_and_writes_one_terminal() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("He", None))),
        Step::WaitPeerClose,
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l1", &endpoint);
    let (run, id, _) = start(claimed, "l1", &endpoint, fast_config());
    collect_text_until(&run, "He");
    assert_eq!(run.state(), Nir1LocalRunState::Running);
    run.cancel_handle().cancel();
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled, "{outcome:?}");
    assert_eq!(outcome.reason, "cancelled");
    assert!(!outcome.io_thread_detached);
    wait_for(
        || server.peer_closed(),
        "the server to see the socket close",
    );
    assert_terminal(&fixture, &id, "cancelled", "not-attempted");
    assert_eq!(
        audit_types(&fixture),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.partial",
            "execution.cancelled"
        ]
    );
    assert_eq!(terminal_events(&fixture).len(), 1);
    assert!(!chat_message_exists(&fixture, "l1-output"));
    assert_eq!(fixture.gate().active_lease_count(), 0);
    assert!(
        !fixture.gate().is_closed(),
        "a joined thread does not quarantine"
    );
}

#[test]
fn l2_cancel_before_the_connection_sends_nothing() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l2", &endpoint);
    let cancel = claimed.owner.cancel_handle();
    // After the audit start is durable and before the policy read.
    claimed
        .control
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterAuditStart, move || {
            cancel.cancel()
        });
    let (run, id, _) = start(claimed, "l2", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled);
    assert_eq!(outcome.reason, "send-refused-cancelled");
    assert_eq!(server.connections(), 0);
    assert_terminal(&fixture, &id, "cancelled", "not-attempted");
    let last = last_audit(&fixture);
    assert_eq!(last.event_type, "execution.cancelled");
    assert_eq!(last.payload["remoteOutcome"], "not-sent");
}

#[test]
fn l3_a_cancel_racing_the_first_byte_decides_by_the_go() {
    // Cancel just before the second decision: refused, no byte.
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l3-before", &endpoint);
    let cancel = claimed.owner.cancel_handle();
    let calls = AtomicUsize::new(0);
    claimed
        .control
        .test_hooks()
        .on(Nir1OwnerProbePoint::BeforeSendDecision, move || {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                cancel.cancel();
            }
        });
    let (run, id, _) = start(claimed, "l3-before", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled);
    assert_eq!(outcome.reason, "send-refused-cancelled");
    wait_for(
        || !server.shared.requests.lock().unwrap().is_empty(),
        "the server to see the connection end",
    );
    assert!(server.request().is_empty(), "no byte after a refusal");
    assert_terminal(&fixture, &id, "cancelled", "not-attempted");
    assert_eq!(last_audit(&fixture).payload["remoteOutcome"], "not-sent");

    // Cancel just after the second decision said go: a send that may have
    // begun, so the audit is never `not-sent`.
    let fixture = OwnerFixture::new();
    let server = TestServer::start(vec![write(HEAD_CHUNKED), Step::WaitPeerClose]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l3-after", &endpoint);
    let cancel = claimed.owner.cancel_handle();
    let calls = AtomicUsize::new(0);
    claimed
        .control
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterSendDecision, move || {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                cancel.cancel();
            }
        });
    let (run, id, _) = start(claimed, "l3-after", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled);
    assert_eq!(outcome.reason, "cancelled");
    assert_terminal(&fixture, &id, "cancelled", "not-attempted");
    assert_eq!(last_audit(&fixture).event_type, "execution.cancelled");
    assert_eq!(last_audit(&fixture).payload["remoteOutcome"], "observed");
    assert_eq!(terminal_events(&fixture).len(), 1);
}

// ---------------------------------------------------------------------------
// L4: a join that overruns.
// ---------------------------------------------------------------------------

#[test]
fn l4_a_join_overrun_writes_one_terminal_quarantines_and_discards_the_thread() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("He", None))),
        Step::WaitPeerClose,
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l4", &endpoint);
    let hooks = Arc::new(TransportTestHooks::default());
    hooks.wedge_io.store(true, Ordering::Release);
    let Claimed {
        owner, attempt_id, ..
    } = claimed;
    let mut config = fast_config();
    config.join_limit = Duration::from_millis(200);
    config.connect_timeout = Duration::from_millis(100);
    let run = start_local_generation(
        owner,
        input_for(
            "l4",
            &endpoint,
            Nir1LocalSendPurpose::Writing,
            config,
            Some(Arc::clone(&hooks)),
        ),
    );
    collect_text_until(&run, "He");
    run.cancel();
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled, "{outcome:?}");
    assert!(outcome.io_thread_detached);
    assert!(fixture.gate().is_closed(), "the gate entry is quarantined");
    assert!(
        matches!(
            fixture.owner(1, &fixture.accept(1, "l4-next")),
            Err(Nir1GenerationRefusal::GateClosed)
        ),
        "the next capture finds the gate closed"
    );
    assert_terminal(&fixture, &attempt_id, "cancelled", "not-attempted");
    let before = audit_types(&fixture);
    assert_eq!(terminal_events(&fixture), ["execution.cancelled"]);
    assert!(!hooks.io_exited.load(Ordering::Acquire), "still detached");

    // The detached thread is released: it ends, writes nothing, and nothing
    // it saw reaches the run.
    hooks.release_io.store(true, Ordering::Release);
    wait_for(
        || hooks.io_exited.load(Ordering::Acquire),
        "the detached thread to end",
    );
    thread::sleep(Duration::from_millis(50));
    assert_eq!(audit_types(&fixture), before);
    assert_eq!(terminal_events(&fixture).len(), 1);
    assert_eq!(run.state(), Nir1LocalRunState::Cancelled);
    assert_terminal(&fixture, &attempt_id, "cancelled", "not-attempted");
}

#[test]
fn l4b_the_io_thread_ends_by_itself_even_when_shutdown_does_not_wake_it() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("He", None))),
        Step::WaitPeerClose,
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l4b", &endpoint);
    let hooks = Arc::new(TransportTestHooks::default());
    hooks.suppress_shutdown.store(true, Ordering::Release);
    let Claimed {
        owner, attempt_id, ..
    } = claimed;
    let run = start_local_generation(
        owner,
        input_for(
            "l4b",
            &endpoint,
            Nir1LocalSendPurpose::Writing,
            fast_config(),
            Some(Arc::clone(&hooks)),
        ),
    );
    collect_text_until(&run, "He");
    run.cancel();
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled);
    assert!(
        !outcome.io_thread_detached,
        "the abort flag ends a blocked read within one slice"
    );
    assert!(!fixture.gate().is_closed());
    assert!(hooks.io_exited.load(Ordering::Acquire));
    assert_terminal(&fixture, &attempt_id, "cancelled", "not-attempted");
}

// ---------------------------------------------------------------------------
// L5: the gate closes during a send.
// ---------------------------------------------------------------------------

#[test]
fn l5_a_closing_gate_cancels_the_send_and_a_transition_waits_for_the_terminal() {
    let fixture = Arc::new(OwnerFixture::new());
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("He", None))),
        Step::WaitPeerClose,
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l5", &endpoint);
    let (run, id, _) = start(claimed, "l5", &endpoint, fast_config());
    collect_text_until(&run, "He");

    // A real transition is admitted while the send is in flight. Its drain
    // does not wait for the transport (no lease), the supervisor sees the lost
    // entry and cancels, and the physical exclusive waits for the terminal.
    match fixture
        .state
        .workspace_lifecycle
        .try_begin_transition_kind(AdmissionKind::Restore)
        .expect("admission")
    {
        grimodex_db::AdmissionOutcome::Admitted(_) => {}
        grimodex_db::AdmissionOutcome::NotAdmitted { reason, .. } => {
            panic!("transition not admitted: {reason:?}")
        }
    }
    let exclusive_fixture = Arc::clone(&fixture);
    let exclusive_id = id.clone();
    let (acquired_tx, acquired_rx) = mpsc::channel();
    let transition = thread::spawn(move || {
        let exclusive = exclusive_fixture
            .state
            .workspace_lifecycle
            .acquire_transition_physical_exclusive()
            .expect("physical exclusive");
        let terminal_was_durable = exclusive_fixture.attempt(&exclusive_id).terminal.is_some();
        drop(exclusive);
        exclusive_fixture
            .state
            .workspace_lifecycle
            .complete_transition_from_workspace(&exclusive_fixture.state.ws)
            .expect("publication");
        acquired_tx.send(terminal_was_durable).expect("report");
    });
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Cancelled, "{outcome:?}");
    assert_eq!(outcome.reason, "cancelled");
    assert!(
        acquired_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the transition proceeds"),
        "the exclusive was granted only after the terminal write"
    );
    transition.join().expect("transition");
    assert_terminal(&fixture, &id, "cancelled", "not-attempted");
    assert_eq!(fixture.gate().active_lease_count(), 0);
}

// ---------------------------------------------------------------------------
// L6: deadlines.
// ---------------------------------------------------------------------------

fn failed_by(config: Nir1LocalTransportConfig, script: Vec<Step>, key: &str, reason: &str) {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(script);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, key, &endpoint);
    let started = Instant::now();
    let (run, id, _) = start(claimed, key, &endpoint, config);
    let outcome = finished(&run);
    assert_eq!(
        outcome.state,
        Nir1LocalRunState::Failed,
        "{key}: {outcome:?}"
    );
    assert_eq!(outcome.reason, reason, "{key}");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{key}: the terminal is written within the limits"
    );
    assert_terminal(&fixture, &id, "failed", "invalid");
    assert_eq!(server.connections(), 1, "{key}");
    assert!(!outcome.io_thread_detached);
    assert_eq!(last_audit(&fixture).event_type, "execution.failed");
}

#[test]
fn l6_each_deadline_ends_the_attempt_failed_invalid() {
    let mut first_byte = fast_config();
    first_byte.first_byte_timeout = Duration::from_millis(250);
    // The peer accepts and reads the request but never answers.
    failed_by(
        first_byte,
        vec![Step::Sleep(4000)],
        "l6-first-byte",
        "first-byte-timeout",
    );

    let mut gap = fast_config();
    gap.event_gap_timeout = Duration::from_millis(250);
    failed_by(
        gap,
        vec![
            write(HEAD_CHUNKED),
            write(chunk(&text_event("He", None))),
            Step::Sleep(4000),
        ],
        "l6-event-gap",
        "event-gap-timeout",
    );

    let mut total = fast_config();
    total.total_timeout = Duration::from_millis(400);
    let mut trickle = vec![write(HEAD_CHUNKED)];
    for _ in 0..60 {
        trickle.push(write(chunk(&text_event("x", None))));
        trickle.push(Step::Sleep(50));
    }
    failed_by(total, trickle, "l6-total", "total-timeout");

    // `[DONE]` arrived but the body never ends (close-delimited framing).
    let mut done = fast_config();
    done.done_body_end_timeout = Duration::from_millis(250);
    failed_by(
        done,
        vec![
            write(
                "HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n".to_owned()
                    + &text_event("Hello", Some("stop"))
                    + DONE,
            ),
            Step::Sleep(4000),
        ],
        "l6-done-body-end",
        "done-body-end-timeout",
    );
}

/// The request-write deadline is a deadline: an expired one stops at once
/// (a real stalled write needs a peer that stops reading for megabytes).
#[test]
fn l6_an_expired_write_deadline_stops_the_write() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
    let mut stream = TcpStream::connect_timeout(
        &listener.local_addr().expect("addr"),
        Duration::from_secs(2),
    )
    .expect("connect");
    let abort = AtomicBool::new(false);
    assert_eq!(
        write_all_until(&mut stream, b"x", Instant::now(), &abort),
        Err(IoEnd::WriteTimeout)
    );
    abort.store(true, Ordering::Release);
    assert_eq!(
        write_all_until(
            &mut stream,
            b"x",
            Instant::now() + Duration::from_secs(5),
            &abort
        ),
        Err(IoEnd::Aborted)
    );
}

// ---------------------------------------------------------------------------
// L7: a crash before the terminal.
// ---------------------------------------------------------------------------

#[test]
fn l7_an_owner_dropped_before_its_terminal_is_recovered_once_and_never_resent() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l7-drop", &endpoint);
    let Claimed {
        owner, attempt_id, ..
    } = claimed;
    let bound = verify_binding(
        &owner,
        &input_for(
            "l7-drop",
            &endpoint,
            Nir1LocalSendPurpose::Writing,
            fast_config(),
            None,
        ),
    )
    .map_err(|reason| reason.to_owned())
    .expect("binding");
    let Nir1LocalSendPolicyDecision::Allowed(policy_basis) =
        decide(None, Nir1LocalSendPurpose::Writing)
    else {
        panic!("allowed");
    };
    owner
        .append_audit_start(&Nir1LocalAuditStart {
            request: bound.request,
            payload_digest: bound.payload_digest,
            socket: endpoint.socket_addr().to_string(),
            policy_basis,
            timestamp_ms: now_ms().expect("clock"),
        })
        .expect("start");
    drop(owner);
    let terminal = fixture.attempt(&attempt_id).terminal.expect("recovered");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::InterruptedUnknown)
    );
    let last = last_audit(&fixture);
    assert_eq!(last.event_type, "execution.failed");
    assert_eq!(last.payload["conservative"], true);
    assert_eq!(terminal_events(&fixture).len(), 1);
    assert_eq!(server.connections(), 0, "nothing was resent");
}

#[test]
fn l7b_a_supervisor_that_panics_is_recovered_by_the_owner_and_marks_the_run_failed() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l7-panic", &endpoint);
    claimed
        .control
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterAuditStart, || {
            panic!("injected supervisor panic")
        });
    let (run, id, _) = start(claimed, "l7-panic", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Failed);
    assert_eq!(outcome.reason, "supervisor-ended");
    assert_eq!(server.connections(), 0);
    wait_for(
        || fixture.attempt(&id).terminal.is_some(),
        "the owner's recovery to write the terminal",
    );
    assert_eq!(
        failure_classification(&fixture, &id),
        Some(FailureClassification::InterruptedUnknown)
    );
    assert_eq!(terminal_events(&fixture).len(), 1);
    assert_eq!(last_audit(&fixture).payload["conservative"], true);
}

#[test]
fn l7c_a_failed_terminal_write_returns_the_durable_terminal_to_the_run() {
    use grimodex_db::nir1_generation::Nir1GenerationFailpoint;
    let fixture = OwnerFixture::new();

    // COMMIT applied but reported ambiguous: the success is durable and the
    // run says so.
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l7c-applied", &endpoint);
    claimed
        .control
        .test_hooks()
        .fail_next("finish", Nir1GenerationFailpoint::ErrorAfterCommit);
    let (run, id, _) = start(claimed, "l7c-applied", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Succeeded, "{outcome:?}");
    assert!(
        matches!(&outcome.end, Nir1LocalRunEnd::FinishFailed { durable: Some(t), .. } if t.attempt_id == id),
        "{outcome:?}"
    );
    let Nir1LocalRunEnd::FinishFailed { failure, .. } = &outcome.end else {
        panic!("{outcome:?}");
    };
    assert_ne!(*failure, Nir1StoreFailure::TerminalConflict);
    assert_terminal(&fixture, &id, "succeeded", "parsed");
    assert!(chat_message_exists(&fixture, "l7c-applied-output"));

    // COMMIT vetoed: the conservative recovery is the durable terminal, and
    // the answer is not stored.
    let server = TestServer::start(ok_script());
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l7c-veto", &endpoint);
    claimed
        .control
        .test_hooks()
        .fail_next("finish", Nir1GenerationFailpoint::VetoCommit);
    let (run, id, _) = start(claimed, "l7c-veto", &endpoint, fast_config());
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Failed, "{outcome:?}");
    assert!(
        matches!(
            &outcome.end,
            Nir1LocalRunEnd::FinishFailed {
                durable: Some(_),
                ..
            }
        ),
        "{outcome:?}"
    );
    assert_eq!(
        failure_classification(&fixture, &id),
        Some(FailureClassification::InterruptedUnknown)
    );
    assert!(!chat_message_exists(&fixture, "l7c-veto-output"));
    assert_eq!(server.connections(), 1, "never resent");
}

// ---------------------------------------------------------------------------
// L8: the run handle.
// ---------------------------------------------------------------------------

#[test]
fn l8_output_leaves_only_by_the_run_handle_and_is_unconfirmed_until_the_terminal() {
    let fixture = OwnerFixture::new();
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&thinking_event("hm"))),
        write(chunk(&text_event("Hel", None))),
        Step::Sleep(400),
        write(chunk(&text_event("lo", Some("stop")))),
        write(chunk(DONE)),
        write("0\r\n\r\n"),
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l8", &endpoint);
    let (run, id, _) = start(claimed, "l8", &endpoint, fast_config());
    let (text, thinking) = collect_text_until(&run, "Hel");
    assert_eq!(text, "Hel");
    assert_eq!(thinking, "hm");
    // Mid-stream: running, nothing stored as an answer.
    assert_eq!(run.state(), Nir1LocalRunState::Running);
    assert!(fixture.attempt(&id).terminal.is_none());
    assert!(!chat_message_exists(&fixture, "l8-output"));
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Succeeded);
    let rest = run.take_delta(2);
    assert_eq!(rest.text, "lo");
    assert_eq!(rest.thinking, "");
    assert_eq!(rest.state, Nir1LocalRunState::Succeeded);
    assert_eq!(run.take_delta(usize::MAX).text, "");
    assert!(chat_message_exists(&fixture, "l8-output"));

    // The module has no broadcast path.
    let source = include_str!("nir1_local_transport.rs");
    for forbidden in ["emit(", "Emitter", "BrowserWindow", "webContents", "napi"] {
        assert!(!source.contains(forbidden), "{forbidden}");
    }
}

#[test]
fn l8b_output_beyond_the_channel_limit_is_a_failure() {
    let fixture = OwnerFixture::new();
    let mut config = fast_config();
    config.wire.max_text_bytes = 8;
    let server = TestServer::start(vec![
        write(HEAD_CHUNKED),
        write(chunk(&text_event("12345", None))),
        write(chunk(&text_event("67890", None))),
        write(chunk(&text_event("abc", Some("stop")))),
        write(chunk(DONE)),
        write("0\r\n\r\n"),
    ]);
    let endpoint = server.endpoint();
    let claimed = claim_writing(&fixture, 0, "l8b", &endpoint);
    let (run, id, _) = start(claimed, "l8b", &endpoint, config);
    let outcome = finished(&run);
    assert_eq!(outcome.state, Nir1LocalRunState::Failed);
    let delta = run.take_delta(usize::MAX);
    assert!(delta.text.len() <= 8, "{delta:?}");
    assert_terminal(&fixture, &id, "failed", "invalid");
    assert!(!chat_message_exists(&fixture, "l8b-output"));
}

// ---------------------------------------------------------------------------
// A1: a success is only ever written together with its audit.
// ---------------------------------------------------------------------------

#[test]
fn a1_the_transport_writes_terminals_only_through_the_audit_aware_paths() {
    let source = include_str!("nir1_local_transport.rs");
    assert!(source.contains("finish_with_audit("));
    assert!(!source.contains("owner.finish("));
    assert!(!source.contains("finish_without_audit"));
}

#[test]
fn take_prefix_cuts_at_character_boundaries_and_always_makes_progress() {
    let mut text = "aé😀b".to_owned();
    assert_eq!(take_prefix(&mut text, 2), "a");
    assert_eq!(take_prefix(&mut text, 1), "é");
    assert_eq!(take_prefix(&mut text, 1), "😀");
    assert_eq!(take_prefix(&mut text, 0), "");
    assert_eq!(take_prefix(&mut text, 10), "b");
    assert_eq!(take_prefix(&mut text, 10), "");
}

#[test]
fn the_default_config_is_valid_and_orders_the_connect_and_join_limits() {
    assert!(Nir1LocalTransportConfig::DEFAULT.is_valid());
    assert!(
        Nir1LocalTransportConfig::DEFAULT.connect_timeout
            < Nir1LocalTransportConfig::DEFAULT.join_limit
    );
    let mut bad = Nir1LocalTransportConfig::DEFAULT;
    bad.join_limit = bad.connect_timeout;
    assert!(!bad.is_valid());
}
