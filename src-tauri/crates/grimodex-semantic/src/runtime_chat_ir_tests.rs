//! DR-CHATIR-S1-11 (chat IR S1-A0). Every deadline stop is made deterministic
//! with a past `Instant` or a thread that holds the resource; none relies on a
//! race between a sleep and a timer except where a bound is asserted with slack.

use super::audited_query::prepare_query_with;
use super::chat_ir::{
    prepare_chat_ir_query_with, with_resident_until, ResidentOutcome, AFTER_RUN_WAIT_FOR_DEADLINE,
    AFTER_START_WAIT_FOR_DEADLINE,
};
use super::embedder_admission::EmbedderAdmission;
use super::*;
use crate::audit::{ModelArtifactIdentity, TokenizerIdentity};
use crate::spec::{SPEC_EN, SPEC_JA};
use grimodex_db::WorkspaceAuthority;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct QuietEvents;
impl EventSink for QuietEvents {
    fn emit(&self, _: &str, _: serde_json::Value) {}
}

fn fixture() -> (SemanticRuntime, SemanticRequest) {
    fixture_at(Path::new(":memory:"))
}

fn fixture_at(database_path: &Path) -> (SemanticRuntime, SemanticRequest) {
    let database = Database::new(database_path).expect("create test DB");
    database.migrate().expect("migrate test DB");
    database
        .with_conn(|connection| {
            connection.execute(
                "INSERT INTO projects (id,title,language) VALUES ('project','test','ja')",
                [],
            )?;
            Ok(())
        })
        .expect("project fixture");
    let pinned = WorkspaceAuthority::from_database_for_test(
        database,
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
    )
    .expect("pinned test workspace");
    let runtime = SemanticRuntime::new(
        SemanticPaths {
            models_root: std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
            resource_semantic_root: std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
        },
        Arc::new(QuietEvents),
    );
    let request = runtime
        .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&pinned)))
        .expect("pin semantic request");
    (runtime, request)
}

fn identities() -> (ModelArtifactIdentity, TokenizerIdentity) {
    (
        ModelArtifactIdentity {
            identity_version: 1,
            fingerprint_algorithm: "sha256",
            file_name: "model_int8.onnx".into(),
            sha256: SPEC_JA.artifact_sha256.into(),
            byte_length: SPEC_JA.artifact_size,
        },
        TokenizerIdentity::from_bytes("tokenizer.json", b"test-only immutable tokenizer identity"),
    )
}

fn unit_vector() -> Vec<f32> {
    let mut vector = vec![0.0; SPEC_JA.embedding_dim];
    vector[0] = 1.0;
    vector
}

fn vector_bytes(dim: usize) -> Vec<u8> {
    let mut vector = vec![0.0_f32; dim];
    vector[0] = 1.0;
    vector.into_iter().flat_map(f32::to_le_bytes).collect()
}

fn far() -> Instant {
    Instant::now() + Duration::from_secs(30)
}

fn chat_ir(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    deadline: Instant,
    inference: impl FnOnce() -> Result<Vec<f32>>,
) -> ChatIrPrepareOutcome {
    let (model, tokenizer) = identities();
    prepare_chat_ir_query_with(
        runtime,
        request,
        "project",
        &SPEC_JA,
        "崩れた橋",
        30,
        deadline,
        model,
        tokenizer,
        inference,
    )
    .expect("chat IR prepare")
}

fn query_of(outcome: ChatIrPrepareOutcome) -> ChatIrQuery {
    match outcome {
        ChatIrPrepareOutcome::Query(query) => query,
        ChatIrPrepareOutcome::Unavailable { reason, .. } => {
            panic!("expected a query, got {reason:?}")
        }
    }
}

fn unavailable(outcome: ChatIrPrepareOutcome) -> (ChatIrUnavailable, Option<PendingTerminalAudit>) {
    match outcome {
        ChatIrPrepareOutcome::Query(_) => panic!("expected no query"),
        ChatIrPrepareOutcome::Unavailable {
            reason,
            pending_terminal_audit,
        } => (reason, pending_terminal_audit),
    }
}

fn event_types(request: &SemanticRequest) -> Vec<String> {
    request
        .db()
        .read_ai_audit_snapshot("project", None, None, None)
        .expect("audit snapshot")
        .events
        .into_iter()
        .map(|event| event.event_type)
        .collect()
}

/// Hold the DB's connection on a thread until released (the thread acquires it
/// the ordinary way, before the code under test runs).
struct ConnectionHolder {
    release: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ConnectionHolder {
    fn new(request: &SemanticRequest) -> Self {
        let pinned = request.database();
        let (held_tx, held_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            pinned
                .db()
                .with_conn(|_| {
                    held_tx.send(()).expect("announce held");
                    let _ = release_rx.recv();
                    Ok(())
                })
                .expect("hold the connection");
        });
        held_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("holder owns the connection");
        Self {
            release,
            thread: Some(thread),
        }
    }

    fn release(&mut self) {
        let _ = self.release.send(());
        if let Some(thread) = self.thread.take() {
            thread.join().expect("holder joined");
        }
    }
}

impl Drop for ConnectionHolder {
    fn drop(&mut self) {
        self.release();
    }
}

// ---------------------------------------------------------------------------
// Segment 2: the embedder wait, and "never load".
// ---------------------------------------------------------------------------

/// A model that is not resident answers `Cold` without running the operation:
/// there is no loader in `with_resident_until`. A resident one runs.
#[test]
fn resident_only_runs_a_resident_embedder_and_answers_cold_otherwise() {
    let admission = EmbedderAdmission::default();
    let embedders: Mutex<HashMap<&'static str, u32>> = Mutex::new(HashMap::new());
    let calls = AtomicUsize::new(0);
    let cold = with_resident_until(&admission, &embedders, "ruri", far(), |_| {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(0)
    })
    .expect("cold is not an error");
    assert!(matches!(cold, ResidentOutcome::Cold));
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert!(
        embedders.lock().expect("map").is_empty(),
        "a cold lookup must not insert (load) anything"
    );
    embedders.lock().expect("map").insert("ruri", 41);
    let ran = with_resident_until(&admission, &embedders, "ruri", far(), |value| {
        *value += 1;
        Ok(*value)
    })
    .expect("resident runs");
    assert!(matches!(ran, ResidentOutcome::Ran(42)));
    // The admission was released both times.
    assert!(admission
        .foreground_until(Instant::now(), || Ok(()))
        .expect("free admission")
        .is_some());
    assert_eq!(admission.foreground_waiters_for_test(), 0);
}

/// The product entry point on a runtime with no model resident (and none
/// installed): `EmbedderCold`, no audit row at all, and no attempt to load (a
/// load attempt would end as the "not installed" error instead).
#[test]
fn prepare_chat_ir_query_on_a_cold_runtime_is_embedder_cold_without_audit() {
    let (runtime, request) = fixture();
    let outcome = runtime
        .prepare_chat_ir_query(&request, "project", &SPEC_JA, "崩れた橋", 30, far())
        .expect("a cold embedder is not an error");
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::EmbedderCold);
    assert!(pending.is_none());
    assert!(event_types(&request).is_empty());
}

/// Segment 2 (admission): another foreground inference holds the admission;
/// the wait ends at the deadline (not when the holder finishes), the queued
/// waiter is withdrawn, and the operation never ran.
#[test]
fn resident_only_stops_waiting_for_the_admission_at_the_deadline() {
    let admission = Arc::new(EmbedderAdmission::default());
    let embedders: Mutex<HashMap<&'static str, u32>> = Mutex::new(HashMap::from([("ruri", 1)]));
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder_admission = Arc::clone(&admission);
    let holder = std::thread::spawn(move || {
        holder_admission
            .foreground(|| {
                held_tx.send(()).expect("announce held");
                let _ = release_rx.recv();
                Ok(())
            })
            .expect("hold the admission");
    });
    held_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("holder owns the admission");
    let ran = AtomicBool::new(false);
    let started = Instant::now();
    let wait = Duration::from_millis(100);
    let outcome = with_resident_until(&admission, &embedders, "ruri", started + wait, |_| {
        ran.store(true, Ordering::Release);
        Ok(())
    })
    .expect("a timeout is not an error");
    let elapsed = started.elapsed();
    assert!(matches!(outcome, ResidentOutcome::TimedOut));
    assert!(!ran.load(Ordering::Acquire));
    assert!(elapsed >= wait, "gave up before the deadline: {elapsed:?}");
    assert!(elapsed < wait + Duration::from_millis(1500), "{elapsed:?}");
    assert_eq!(admission.foreground_waiters_for_test(), 0);
    release_tx.send(()).expect("release");
    holder.join().expect("holder joined");
}

/// The embedder map itself is bounded too (a download job takes it briefly):
/// held by someone else until past the deadline is `TimedOut`, and the
/// admission is not left held.
#[test]
fn resident_only_stops_waiting_for_the_embedder_map_at_the_deadline() {
    let admission = EmbedderAdmission::default();
    let embedders: Mutex<HashMap<&'static str, u32>> = Mutex::new(HashMap::from([("ruri", 1)]));
    let guard = embedders.lock().expect("hold the map");
    let started = Instant::now();
    let outcome = with_resident_until(
        &admission,
        &embedders,
        "ruri",
        started + Duration::from_millis(80),
        |_| Ok(()),
    )
    .expect("a timeout is not an error");
    assert!(matches!(outcome, ResidentOutcome::TimedOut));
    assert!(started.elapsed() < Duration::from_millis(1500));
    drop(guard);
    assert!(admission
        .foreground_until(Instant::now(), || Ok(()))
        .expect("admission free")
        .is_some());
}

// ---------------------------------------------------------------------------
// Segment 1 (connection) as seen from the semantic side, and the audit.
// ---------------------------------------------------------------------------

/// The shape of the audit of a chat IR query equals the Related Scenes one
/// (same event types in the same order, same payloads) except for the consumer
/// attribution. The Related Scenes path is not touched: its `sharedConsumers`
/// is fixed by its own test below.
#[test]
fn chat_ir_audit_equals_the_related_scenes_audit_except_the_consumer() {
    fn normalized(request: &SemanticRequest) -> Vec<(String, String, serde_json::Value)> {
        request
            .db()
            .read_ai_audit_snapshot("project", None, None, None)
            .expect("audit snapshot")
            .events
            .into_iter()
            .map(|event| {
                let mut payload = event.payload;
                if let Some(metadata) = payload
                    .get_mut("metadata")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    metadata.remove("sharedConsumers");
                    metadata.remove("consumer");
                }
                (event.event_type, event.path_id, payload)
            })
            .collect()
    }

    let (runtime, request) = fixture();
    let (model, tokenizer) = identities();
    prepare_query_with(
        &runtime,
        &request,
        "project",
        "崩れた橋",
        30,
        &SPEC_JA,
        model,
        tokenizer,
        || Ok(unit_vector()),
    )
    .expect("Related Scenes query");
    let related = normalized(&request);
    let related_consumers: Vec<serde_json::Value> = request
        .db()
        .read_ai_audit_snapshot("project", None, None, None)
        .expect("snapshot")
        .events
        .into_iter()
        .filter(|event| event.event_type == "request.prepared")
        .map(|event| event.payload["metadata"]["sharedConsumers"].clone())
        .collect();
    assert_eq!(
        related_consumers,
        vec![serde_json::json!([
            "raw-related-scenes",
            "nir1-related-scenes"
        ])],
        "the Related Scenes attribution is unchanged"
    );

    let (runtime, request) = fixture();
    let query = query_of(chat_ir(&runtime, &request, far(), || Ok(unit_vector())));
    assert_eq!(normalized(&request), related);
    let prepared = request
        .db()
        .read_ai_audit_snapshot("project", None, None, None)
        .expect("snapshot")
        .events
        .into_iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("request.prepared");
    assert_eq!(
        prepared.payload["metadata"]["sharedConsumers"],
        serde_json::json!(["chat-ir"])
    );
    assert_eq!(prepared.payload["metadata"]["consumer"], "chat-ir");
    assert_eq!(query.model_identity().model_id, SPEC_JA.full_model_id());
    assert!(!query.execution_id().is_empty());
}

/// The records before inference are one batch that must be durable inside the
/// deadline. A connection that stays busy for the whole deadline means: no
/// inference, no audit row, no IR, no foreground waiter, no pending records.
#[test]
fn a_busy_connection_before_inference_means_no_inference_and_no_ir() {
    let (runtime, request) = fixture();
    let mut holder = ConnectionHolder::new(&request);
    let calls = AtomicUsize::new(0);
    let started = Instant::now();
    let outcome = chat_ir(
        &runtime,
        &request,
        started + Duration::from_millis(100),
        || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(unit_vector())
        },
    );
    let elapsed = started.elapsed();
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::ConnectionBusy);
    assert!(pending.is_none());
    assert_eq!(calls.load(Ordering::Relaxed), 0, "no inference");
    assert!(elapsed >= Duration::from_millis(100), "{elapsed:?}");
    assert!(elapsed < Duration::from_millis(100) + Duration::from_millis(1500));
    assert_eq!(request.db().foreground_connection_waiter_count(), 0);
    holder.release();
    assert!(event_types(&request).is_empty(), "nothing was written");
}

/// A deadline that already passed: nothing runs, nothing is written.
#[test]
fn a_passed_deadline_means_no_inference_and_no_audit() {
    let (runtime, request) = fixture();
    let calls = AtomicUsize::new(0);
    let outcome = chat_ir(&runtime, &request, Instant::now(), || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(unit_vector())
    });
    let (reason, _) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::ConnectionBusy);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert!(event_types(&request).is_empty());
}

/// The deadline is checked again after the pre-inference records and before the
/// model starts. The execution is closed (`execution.cancelled`, written
/// outside the passed deadline as a deferred record) and the model never ran.
#[test]
fn the_deadline_is_checked_again_before_inference() {
    let (runtime, request) = fixture();
    AFTER_START_WAIT_FOR_DEADLINE.with(|wait| wait.set(true));
    let calls = AtomicUsize::new(0);
    let outcome = chat_ir(
        &runtime,
        &request,
        Instant::now() + Duration::from_millis(1500),
        || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(unit_vector())
        },
    );
    AFTER_START_WAIT_FOR_DEADLINE.with(|wait| wait.set(false));
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::Timeout);
    assert_eq!(calls.load(Ordering::Relaxed), 0, "the model never started");
    assert_eq!(
        event_types(&request),
        vec![
            "execution.started",
            "request.prepared",
            "request.dispatched"
        ],
        "the deadline had passed, so the closing record is deferred"
    );
    let mut pending = pending.expect("the cancellation is deferred");
    assert_eq!(pending.event_count(), 1);
    assert!(pending.flush_with_budget().expect("flush"));
    assert!(pending.is_empty());
    assert_eq!(
        event_types(&request).last().map(String::as_str),
        Some("execution.cancelled")
    );
}

/// B again, the other side: the terminal records **were** written, but only
/// after the deadline. That is late too: no IR (the inference result is
/// dropped), and nothing is pending because the records are durable. The audit
/// shows the complete execution.
#[test]
fn a_terminal_that_became_durable_after_the_deadline_is_not_used_either() {
    let (runtime, request) = fixture();
    AFTER_RUN_WAIT_FOR_DEADLINE.with(|wait| wait.set(true));
    let outcome = chat_ir(
        &runtime,
        &request,
        Instant::now() + Duration::from_millis(1500),
        || Ok(unit_vector()),
    );
    AFTER_RUN_WAIT_FOR_DEADLINE.with(|wait| wait.set(false));
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::Timeout);
    assert!(
        pending.is_none(),
        "the terminal records are already durable"
    );
    assert_eq!(
        event_types(&request).last().map(String::as_str),
        Some("execution.succeeded")
    );
}

/// B (user confirmation 2026-11-17): the inference completed but its terminal
/// records cannot be made durable inside the deadline. The result is **not
/// used**: no query exists (the outcome has no query variant with pending
/// records), the records travel as `PendingTerminalAudit`, the audit shows no
/// terminal row yet, and writing them later (outside the deadline) completes
/// the execution exactly as if it had been written in time.
#[test]
fn a_terminal_that_misses_the_deadline_is_not_used_and_is_written_later() {
    let (runtime, request) = fixture();
    let holder_slot: std::cell::RefCell<Option<ConnectionHolder>> = std::cell::RefCell::new(None);
    let deadline = Instant::now() + Duration::from_millis(1500);
    let outcome = chat_ir(&runtime, &request, deadline, || {
        // The records before inference are durable. Now the connection becomes
        // busy and stays busy past the deadline, as a long maintenance run would.
        *holder_slot.borrow_mut() = Some(ConnectionHolder::new(&request));
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(unit_vector())
    });
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::Timeout);
    let mut pending = pending.expect("terminal records are deferred");
    assert_eq!(
        pending.event_count(),
        2,
        "response.completed + execution.succeeded"
    );
    assert_eq!(request.db().foreground_connection_waiter_count(), 0);

    // A flush while the connection is still busy fails to write and keeps the
    // records (the failure case: pending stays with the owner).
    assert!(!pending
        .flush_until(Instant::now() + Duration::from_millis(60))
        .expect("busy is not an error"));
    assert_eq!(pending.event_count(), 2);

    holder_slot.borrow_mut().take().expect("holder").release();
    assert_eq!(
        event_types(&request),
        vec![
            "execution.started",
            "request.prepared",
            "request.dispatched"
        ],
        "no terminal row was written inside the deadline"
    );
    assert!(pending.flush_with_budget().expect("flush"));
    assert!(pending.is_empty());
    assert_eq!(
        event_types(&request),
        vec![
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded"
        ]
    );
    // Writing again is idempotent (the same events are skipped).
    assert!(pending.flush_with_budget().expect("flush again"));
    assert_eq!(event_types(&request).len(), 5);
}

/// An inference error whose terminal (`execution.failed`) cannot be written in
/// time: the error is not lost as a plain `Err` with its record dropped; the
/// record is deferred and the reason says the inference failed.
#[test]
fn a_failed_inference_whose_terminal_misses_the_deadline_is_deferred() {
    let (runtime, request) = fixture();
    let holder_slot: std::cell::RefCell<Option<ConnectionHolder>> = std::cell::RefCell::new(None);
    let deadline = Instant::now() + Duration::from_millis(1500);
    let outcome = chat_ir(&runtime, &request, deadline, || {
        *holder_slot.borrow_mut() = Some(ConnectionHolder::new(&request));
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        Err(anyhow!("synthetic inference failure"))
    });
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::InferenceFailed);
    let mut pending = pending.expect("execution.failed is deferred");
    assert_eq!(pending.event_count(), 1);
    holder_slot.borrow_mut().take().expect("holder").release();
    assert!(pending.flush_with_budget().expect("flush"));
    assert_eq!(
        event_types(&request).last().map(String::as_str),
        Some("execution.failed")
    );
}

/// DR-CHATIR-S1-12: another writer (a second connection to the file) that holds
/// the write lock past the clipped (1 s) busy wait is the same "not durable in
/// time" as a held connection, in both phases. Before inference: `ConnectionBusy`,
/// no inference, nothing written, nothing pending. After inference: the result is
/// dropped, the reason is `Timeout` (which also says "the terminal audit could
/// not be written"), the terminal records are pending and a later flush writes
/// them. The deadline (30 s) is far, so only the clip ends the wait.
#[test]
fn a_writer_that_outlasts_the_clipped_busy_wait_is_busy_before_and_deferred_after_inference() {
    let directory = std::env::temp_dir().join(format!("chat-ir-busy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("directory");
    let path = directory.join("workspace.db");
    let (runtime, request) = fixture_at(&path);
    let other = rusqlite::Connection::open(&path).expect("second connection");
    other
        .execute_batch("BEGIN IMMEDIATE")
        .expect("another writer holds the write lock");

    let calls = AtomicUsize::new(0);
    let started = Instant::now();
    let outcome = chat_ir(&runtime, &request, far(), || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(unit_vector())
    });
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::ConnectionBusy);
    assert!(pending.is_none());
    assert_eq!(calls.load(Ordering::Relaxed), 0, "no inference");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the busy wait was not clipped: {:?}",
        started.elapsed()
    );
    other.execute_batch("ROLLBACK").expect("release");
    assert!(event_types(&request).is_empty(), "nothing was written");

    let outcome = chat_ir(&runtime, &request, far(), || {
        other
            .execute_batch("BEGIN IMMEDIATE")
            .expect("another writer takes the lock after the start records");
        Ok(unit_vector())
    });
    let (reason, pending) = unavailable(outcome);
    assert_eq!(reason, ChatIrUnavailable::Timeout);
    let mut pending = pending.expect("the terminal records are pending");
    assert_eq!(pending.event_count(), 2);
    other.execute_batch("ROLLBACK").expect("release");
    assert!(pending.flush_with_budget().expect("flush"));
    assert_eq!(
        event_types(&request).last().map(String::as_str),
        Some("execution.succeeded")
    );
    std::fs::remove_dir_all(&directory).ok();
}

/// A failure that has nothing to do with the deadline stays an error (an
/// invalid vector, a stale epoch): it is not turned into "no IR".
#[test]
fn real_failures_stay_errors() {
    let (runtime, request) = fixture();
    let (model, tokenizer) = identities();
    let error = prepare_chat_ir_query_with(
        &runtime,
        &request,
        "project",
        &SPEC_JA,
        "崩れた橋",
        30,
        far(),
        model,
        tokenizer,
        || Ok(vec![1.0; 3]),
    )
    .err()
    .expect("an invalid vector is an error");
    assert!(
        format!("{error:#}").contains("SEMANTIC_QUERY_VECTOR_INVALID"),
        "{error:#}"
    );

    let (runtime, request) = fixture();
    runtime.rotate_workspace_epoch();
    let (model, tokenizer) = identities();
    assert!(prepare_chat_ir_query_with(
        &runtime,
        &request,
        "project",
        &SPEC_JA,
        "崩れた橋",
        30,
        far(),
        model,
        tokenizer,
        || Ok(unit_vector()),
    )
    .is_err());
}

/// D: the identity of the loaded model is checked against the spec the caller
/// gave (an English spec with the Japanese artifact is a model change).
#[test]
fn a_given_spec_that_does_not_match_the_loaded_model_is_refused() {
    let (runtime, request) = fixture();
    let (model, tokenizer) = identities();
    let error = prepare_chat_ir_query_with(
        &runtime,
        &request,
        "project",
        &SPEC_EN,
        "崩れた橋",
        30,
        far(),
        model,
        tokenizer,
        || Ok(unit_vector()),
    )
    .err()
    .expect("model changed");
    assert!(format!("{error:#}").contains("SEMANTIC_QUERY_MODEL_CHANGED"));
    assert!(event_types(&request).is_empty(), "refused before any audit");
}

// ---------------------------------------------------------------------------
// Segment 3: scoring.
// ---------------------------------------------------------------------------

/// Same scores as `score_accepted_documents` for the same vectors (the
/// equivalence), and the same errors for a wrong length, a non-finite value and
/// a different identity.
#[test]
fn chat_ir_scoring_is_equivalent_to_the_existing_scoring() {
    let (runtime, request) = fixture();
    let (model, tokenizer) = identities();
    let existing = prepare_query_with(
        &runtime,
        &request,
        "project",
        "崩れた橋",
        30,
        &SPEC_JA,
        model,
        tokenizer,
        || Ok(unit_vector()),
    )
    .expect("existing query");
    let chat = query_of(chat_ir(&runtime, &request, far(), || Ok(unit_vector())));

    let mut half = vec![0.0_f32; SPEC_JA.embedding_dim];
    half[0] = 0.5;
    half[1] = 0.5;
    let half_bytes: Vec<u8> = half.into_iter().flat_map(f32::to_le_bytes).collect();
    let one = vector_bytes(SPEC_JA.embedding_dim);
    let mut orthogonal = vec![0.0_f32; SPEC_JA.embedding_dim];
    orthogonal[2] = 1.0;
    let orthogonal_bytes: Vec<u8> = orthogonal.into_iter().flat_map(f32::to_le_bytes).collect();
    let pool: Vec<&[u8]> = vec![&one, &half_bytes, &orthogonal_bytes, &one];

    let left = runtime
        .score_accepted_documents(&existing, existing.model_identity(), &pool)
        .expect("existing scores");
    let ChatIrScoreOutcome::Scores(right) = runtime
        .score_chat_ir_documents_until(&chat, &SPEC_JA, chat.model_identity(), &pool, far())
        .expect("chat IR scores")
    else {
        panic!("not timed out");
    };
    assert_eq!(left, right);

    // Errors: wrong length, non-finite, mismatched identity.
    let short = [0_u8; 8];
    let nan: Vec<u8> = std::iter::once(f32::NAN)
        .chain(std::iter::repeat_n(0.0, SPEC_JA.embedding_dim - 1))
        .flat_map(f32::to_le_bytes)
        .collect();
    for bad in [&short[..], &nan[..]] {
        let left = runtime
            .score_accepted_documents(&existing, existing.model_identity(), &[bad])
            .expect_err("existing refuses");
        let right = runtime
            .score_chat_ir_documents_until(&chat, &SPEC_JA, chat.model_identity(), &[bad], far())
            .err()
            .expect("chat IR refuses");
        assert_eq!(left.to_string(), right.to_string());
    }
    let mut other = chat.model_identity().clone();
    other.model_id = "someone-else".into();
    let left = runtime
        .score_accepted_documents(&existing, &other, &[])
        .expect_err("existing refuses");
    let right = runtime
        .score_chat_ir_documents_until(&chat, &SPEC_JA, &other, &[], far())
        .err()
        .expect("chat IR refuses");
    assert_eq!(left.to_string(), right.to_string());
}

/// The checks the existing scoring makes against the DB-read spec are made
/// against the spec the caller gives now: a different spec, or a workspace
/// epoch that changed, is refused.
#[test]
fn chat_ir_scoring_checks_the_given_spec_and_the_epoch() {
    let (runtime, request) = fixture();
    let chat = query_of(chat_ir(&runtime, &request, far(), || Ok(unit_vector())));
    let error = runtime
        .score_chat_ir_documents_until(&chat, &SPEC_EN, chat.model_identity(), &[], far())
        .err()
        .expect("spec changed");
    assert!(error.to_string().contains("SEMANTIC_QUERY_MODEL_CHANGED"));
    runtime.rotate_workspace_epoch();
    assert!(runtime
        .score_chat_ir_documents_until(&chat, &SPEC_JA, chat.model_identity(), &[], far())
        .is_err());
    assert!(runtime
        .validate_chat_ir_query_current(&chat, &SPEC_JA)
        .is_err());
}

/// Segment 3: the deadline is observed before every candidate. A deadline that
/// has passed stops before the first one (an invalid vector later in the pool is
/// never reached), and with a live deadline the same invalid vector is an error.
#[test]
fn chat_ir_scoring_stops_at_the_deadline() {
    let (runtime, request) = fixture();
    let chat = query_of(chat_ir(&runtime, &request, far(), || Ok(unit_vector())));
    let one = vector_bytes(SPEC_JA.embedding_dim);
    let bad = [0_u8; 3];
    let pool: Vec<&[u8]> = vec![&one, &bad];
    let outcome = runtime
        .score_chat_ir_documents_until(
            &chat,
            &SPEC_JA,
            chat.model_identity(),
            &pool,
            Instant::now(),
        )
        .expect("a stop is not an error");
    assert!(matches!(outcome, ChatIrScoreOutcome::TimedOut));
    assert!(runtime
        .score_chat_ir_documents_until(&chat, &SPEC_JA, chat.model_identity(), &pool, far())
        .is_err());
}

/// The loop checks between candidates, not only at the start: it stops after
/// two candidates and never reaches the invalid third.
#[test]
fn the_scoring_loop_checks_the_stop_between_candidates() {
    let one = vector_bytes(SPEC_JA.embedding_dim);
    let bad = [0_u8; 3];
    let pool: Vec<&[u8]> = vec![&one, &one, &bad];
    let query = unit_vector();
    let asked = AtomicUsize::new(0);
    let stopped = super::chat_ir::score_vectors_until(&query, SPEC_JA.embedding_dim, &pool, || {
        asked.fetch_add(1, Ordering::Relaxed) >= 2
    })
    .expect("stopped before the invalid candidate");
    assert!(stopped.is_none());
    assert_eq!(asked.load(Ordering::Relaxed), 3);
    let live = super::chat_ir::score_vectors_until(&query, SPEC_JA.embedding_dim, &pool, || false);
    assert!(live.is_err());
}

/// D: neither the prepare nor the scoring reads the DB. With the connection
/// held by someone else, scoring still answers at once and announces no waiter
/// (the existing scoring re-reads `projects.language` and would block).
#[test]
fn chat_ir_scoring_does_not_touch_the_database() {
    let (runtime, request) = fixture();
    let chat = query_of(chat_ir(&runtime, &request, far(), || Ok(unit_vector())));
    let mut holder = ConnectionHolder::new(&request);
    let one = vector_bytes(SPEC_JA.embedding_dim);
    let started = Instant::now();
    let ChatIrScoreOutcome::Scores(scores) = runtime
        .score_chat_ir_documents_until(&chat, &SPEC_JA, chat.model_identity(), &[&one], far())
        .expect("scores")
    else {
        panic!("not timed out");
    };
    assert_eq!(scores, vec![1.0]);
    assert!(started.elapsed() < Duration::from_millis(1000));
    assert_eq!(request.db().foreground_connection_waiter_count(), 0);
    holder.release();
}
