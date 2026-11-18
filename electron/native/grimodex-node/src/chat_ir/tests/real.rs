//! The real Backend on a real workspace database, and the napi entry. A
//! published Chronicle index (and a resident model) cannot be made here, so the
//! steps after the first read are covered by the flow tests and by the shared
//! crate's own tests; what is real here is every refusal that comes before an
//! embedding, the gate, the permit, the pin and the lifecycle.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grimodex_db::state::{PinnedWorkspaceDb, WorkspaceAuthority};
use grimodex_db::Database;
use serde_json::{json, Value};

use super::fake::{request, Fake, PendingSpec, PrepareMode};
use crate::chat_ir::basis::basis_for;
use crate::chat_ir::flow::{execute, Backend, Prepared};
use crate::chat_ir::native::NativeBackend;
use crate::chat_ir::request::Request;
use crate::chat_ir::status::ChatIrStatus;
use crate::chat_ir::{select, GATE_CLOSED, INVALID_REQUEST};
use crate::main_grant::PrePublicationEntry;
use crate::state::AppState;

struct Rig {
    state: Arc<AppState>,
    authority: PinnedWorkspaceDb,
    path: PathBuf,
    root: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A workspace with the migrated default project (`default-project`) in
/// `language`, a second project `other`, and Scenes: `scene` (live),
/// `archived`, `other-scene` (of the second project) and a node that is not a
/// Scene.
fn rig(label: &str, language: &str) -> Rig {
    rig_with(label, language, crate::chat_ir::ChatIrConfig::default())
}

fn rig_with(label: &str, language: &str, config: crate::chat_ir::ChatIrConfig) -> Rig {
    let root = std::env::temp_dir().join(format!(
        "grimodex-node-chat-ir-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let path = root.join("workspace");
    let resources = root.join("resources");
    std::fs::create_dir_all(path.join(".grimodex")).expect("metadata directory");
    std::fs::write(
        path.join(".grimodex/workspace.json"),
        json!({"id": format!("workspace-{label}"), "created_at": "2026-01-01T00:00:00.000Z"})
            .to_string(),
    )
    .expect("workspace metadata");
    let database = Database::new(&path.join("grimodex.db")).expect("database");
    database.migrate().expect("migration");
    database
        .with_conn(|conn| {
            conn.execute("UPDATE projects SET language=?1 WHERE id='default-project'", [language])?;
            conn.execute("INSERT INTO projects (id, title) VALUES ('other', 'Other')", [])?;
            for (id, project, node_type, archived) in [
                ("scene", "default-project", "scene", None),
                ("archived", "default-project", "scene", Some("2026-01-01T00:00:00.000Z")),
                ("folder", "default-project", "folder", None),
                ("other-scene", "other", "scene", None),
            ] {
                let archived = archived.map_or("NULL".to_string(), |at| format!("'{at}'"));
                conn.execute(
                    &format!(
                        "INSERT INTO tree_nodes(id, project_id, node_type, title, sort_order, content, archived_at)
                         VALUES ('{id}', '{project}', '{node_type}', '{id}', 'a0', 'saved prose', {archived})"
                    ),
                    [],
                )?;
            }
            Ok(())
        })
        .expect("seed");
    let authority =
        WorkspaceAuthority::from_database_for_test(database, path.clone()).expect("authority");
    let mut state =
        AppState::new(&root.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
    state.chat_ir = crate::chat_ir::ChatIrState::new(config);
    state
        .narrative_maintenance_recovery_gate
        .mark_workspace_swapped();
    crate::install_test_workspace(&state, Arc::clone(&authority));
    // Opening a workspace turns the epoch once; the generation is then above 0,
    // which the index runtime requires.
    state.semantic.rotate_workspace_epoch();
    Rig {
        state: Arc::new(state),
        authority,
        path,
        root,
    }
}

impl Rig {
    fn backend(&self) -> NativeBackend {
        let participant = self
            .state
            .ws
            .lifecycle_core()
            .begin_workspace_participant()
            .expect("participant");
        let pinned = crate::pin_scoped_semantic_request(&self.state, &self.path.to_string_lossy())
            .expect("pinned request");
        NativeBackend::new(Arc::clone(&self.state), pinned, participant)
    }

    fn request(&self, scene: &str) -> Request {
        Request {
            query: "a query".into(),
            project_id: "default-project".into(),
            expected_workspace_path: self.path.to_string_lossy().into_owned(),
            current_scene_id: scene.into(),
            chronicle_event_ids: Vec::new(),
        }
    }

    fn payload(&self, scene: &str) -> Value {
        json!({
            "query": "a query",
            "projectId": "default-project",
            "expectedWorkspacePath": self.path.to_string_lossy(),
            "currentSceneId": scene,
            "chronicleEventIds": [],
        })
    }

    fn audit_rows(&self) -> i64 {
        self.authority
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM ai_audit_events", [], |row| row.get(0))?)
            })
            .expect("count")
    }

    fn open_gate(&self) {
        self.state
            .main_grant
            .gate
            .open(PrePublicationEntry::ChatAgentIr);
    }
}

// ---- S1A-2 / S1A-9 / S1A-4 / S1A-20: the entry -----------------------------------

#[tokio::test]
async fn a_closed_gate_refuses_before_the_payload_is_read_and_uses_nothing() {
    let rig = rig("gate", "ja");
    // The product never opens it.
    assert!(!rig
        .state
        .main_grant
        .gate
        .is_open(PrePublicationEntry::ChatAgentIr));
    for payload in [
        rig.payload("scene"),
        json!("not an object"),
        json!({"extra": 1}),
        Value::Null,
    ] {
        let error = select(Arc::clone(&rig.state), payload)
            .await
            .expect_err("closed");
        assert_eq!(error.to_string(), GATE_CLOSED);
    }
    assert_eq!(rig.audit_rows(), 0);
    assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
    // A gate refusal is an error, not an IR status.
    assert!(ChatIrStatus::ALL
        .iter()
        .all(|status| status.as_str() != GATE_CLOSED));
}

#[test]
fn the_chat_gate_entry_is_closed_by_default_and_has_its_own_wire_name() {
    let rig = rig("entry", "ja");
    assert_eq!(
        PrePublicationEntry::parse("chat-agent-ir"),
        Some(PrePublicationEntry::ChatAgentIr)
    );
    assert_eq!(PrePublicationEntry::ChatAgentIr.wire(), "chat-agent-ir");
    for entry in [
        PrePublicationEntry::SceneBodyDeclaration,
        PrePublicationEntry::ProfileActivation,
        PrePublicationEntry::LocalGeneration,
        PrePublicationEntry::ChatAgentIr,
    ] {
        assert!(!rig.state.main_grant.gate.is_open(entry));
    }
    // Opening one entry opens no other.
    rig.open_gate();
    assert!(rig
        .state
        .main_grant
        .gate
        .is_open(PrePublicationEntry::ChatAgentIr));
    assert!(!rig
        .state
        .main_grant
        .gate
        .is_open(PrePublicationEntry::LocalGeneration));
}

#[tokio::test]
async fn an_open_gate_refuses_a_request_of_the_wrong_shape_with_the_closed_code() {
    let rig = rig("shape", "ja");
    rig.open_gate();
    let mut extra = rig.payload("scene");
    extra["extra"] = json!(true);
    for payload in [extra, json!({}), json!([1]), Value::Null] {
        let error = select(Arc::clone(&rig.state), payload)
            .await
            .expect_err("shape");
        assert_eq!(error.to_string(), INVALID_REQUEST);
    }
    assert_eq!(rig.audit_rows(), 0);
}

/// S1-A2 N1: a candidate list that is not valid is a request error, before the
/// permit: with both places taken it is still the error, not `busy`.
#[tokio::test]
async fn an_invalid_candidate_list_is_a_request_error_before_the_permit() {
    let rig = rig("candidates", "ja");
    rig.open_gate();
    let held: Vec<_> = (0..2)
        .map(|_| rig.state.chat_ir.permits.try_acquire().unwrap())
        .collect();
    let too_many: Vec<String> = (0..31).map(|index| format!("event-{index}")).collect();
    for bad in [
        json!(too_many),
        json!(["event-1", "event-1"]),
        json!([""]),
        json!(["   "]),
        json!(["a".repeat(201)]),
        json!("event-1"),
        json!([1]),
    ] {
        let mut payload = rig.payload("scene");
        payload["chronicleEventIds"] = bad.clone();
        let error = select(Arc::clone(&rig.state), payload)
            .await
            .expect_err("a request error");
        assert_eq!(error.to_string(), INVALID_REQUEST, "{bad}");
    }
    // The key is required.
    let mut missing = rig.payload("scene");
    missing.as_object_mut().unwrap().remove("chronicleEventIds");
    let error = select(Arc::clone(&rig.state), missing)
        .await
        .expect_err("a request error");
    assert_eq!(error.to_string(), INVALID_REQUEST);
    // A valid list passes the shape: the next refusal is the saturated pool.
    let mut ok = rig.payload("scene");
    ok["chronicleEventIds"] = json!(["a".repeat(200)]);
    assert_eq!(status_of(&rig, ok).await["status"], "busy");
    drop(held);
    assert_eq!(rig.audit_rows(), 0);
    assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
}

/// A call answers before its task releases the permit and the participant (the
/// tail comes after the answer), so a test that counts them waits for the task.
async fn wait_until_idle(rig: &Rig) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline
        && (rig.state.chat_ir.permits.in_flight() != 0
            || rig
                .state
                .ws
                .lifecycle_core()
                .workspace_participant_count()
                .unwrap()
                != 0)
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn status_of(rig: &Rig, payload: Value) -> Value {
    let text = select(Arc::clone(&rig.state), payload)
        .await
        .expect("an answer");
    serde_json::from_str(&text).expect("json")
}

#[tokio::test]
async fn a_refused_query_uses_no_permit_audits_nothing_and_embeds_nothing() {
    let rig = rig("query", "ja");
    rig.open_gate();
    // Both places are taken: a query refusal still comes first (before the
    // permit), not `busy`.
    let held: Vec<_> = (0..2)
        .map(|_| rig.state.chat_ir.permits.try_acquire().unwrap())
        .collect();
    for query in ["", "   ", &"a".repeat(501), &"\u{1F600}".repeat(251)] {
        let mut payload = rig.payload("scene");
        payload["query"] = json!(query);
        let answer = status_of(&rig, payload).await;
        assert_eq!(answer["status"], "query-invalid", "{query:?}");
        assert_eq!(answer["success"], false);
    }
    assert_eq!(rig.audit_rows(), 0);
    drop(held);
}

#[tokio::test]
async fn the_third_call_is_busy_without_waiting_and_a_freed_place_works_again() {
    let rig = rig("busy", "ja");
    rig.open_gate();
    let first = rig.state.chat_ir.permits.try_acquire().unwrap();
    let second = rig.state.chat_ir.permits.try_acquire().unwrap();
    let started = Instant::now();
    let answer = status_of(&rig, rig.payload("scene")).await;
    assert_eq!(answer["status"], "busy");
    assert!(started.elapsed() < Duration::from_secs(2), "busy waited");
    drop(first);
    // Now a place is free; the call goes on and ends in its first read (no
    // index here), returning its place.
    let answer = status_of(&rig, rig.payload("scene")).await;
    assert_eq!(answer["status"], "index-unavailable");
    drop(second);
    wait_until_idle(&rig).await;
    assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
}

#[tokio::test]
async fn another_workspace_path_is_workspace_changed_and_no_row_is_touched() {
    let rig = rig("path", "ja");
    rig.open_gate();
    let mut payload = rig.payload("scene");
    payload["expectedWorkspacePath"] = json!(rig.root.join("elsewhere").to_string_lossy());
    let answer = status_of(&rig, payload).await;
    assert_eq!(answer["status"], "workspace-changed");
    assert_eq!(rig.audit_rows(), 0);
    assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
    assert_eq!(
        rig.state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .unwrap(),
        0
    );
}

/// The wait for the blocking pool is part of the deadline: the deadline is
/// counted from the acceptance on the async side, not from the task's first
/// line (a call that only got a thread after its deadline touches nothing).
#[test]
fn a_call_queued_behind_a_saturated_blocking_pool_times_out_and_touches_nothing() {
    let config = crate::chat_ir::ChatIrConfig {
        deadline: Duration::from_millis(300),
        ..Default::default()
    };
    let rig = rig_with("pool", "ja", config);
    rig.open_gate();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .expect("runtime");
    let answer = runtime.block_on(async {
        // Occupy the only blocking thread for longer than the deadline.
        let occupied =
            tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(900)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = Instant::now();
        let answer = status_of(&rig, rig.payload("scene")).await;
        assert!(
            started.elapsed() >= Duration::from_millis(600),
            "the call did not queue"
        );
        occupied.await.expect("blocking task");
        answer
    });
    assert_eq!(
        answer["status"], "timeout",
        "the queueing was not counted in the deadline"
    );
    assert_eq!(rig.audit_rows(), 0);
}

/// S1A-4 / DR-CHATIR-S1-19: the permit is taken on the async side, before the task
/// is queued, so the limit of 2 holds while the blocking pool is saturated. Two
/// calls wait in the queue holding their places and the third is `busy` at once
/// (a permit taken inside the task would let all three queue and answer only
/// once the pool is free).
#[test]
fn the_limit_holds_while_the_blocking_pool_is_saturated() {
    let rig = Arc::new(rig("pool-limit", "ja"));
    rig.open_gate();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let occupied =
            tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(1500)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Two calls queue behind the occupied thread, one after the other.
        let mut queued = Vec::new();
        for _ in 0..2 {
            let rig = Arc::clone(&rig);
            queued.push(tokio::spawn(async move {
                status_of(&rig, rig.payload("scene")).await
            }));
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(rig.state.chat_ir.permits.in_flight(), 2, "not both queued");
        let started = Instant::now();
        let third = status_of(&rig, rig.payload("scene")).await;
        assert_eq!(third["status"], "busy");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "the third call waited for the pool: {:?}",
            started.elapsed()
        );
        occupied.await.expect("blocking task");
        for call in queued {
            // The pool is free: they run and stop at the first read (no index).
            assert_eq!(call.await.expect("call")["status"], "index-unavailable");
        }
        wait_until_idle(&rig).await;
        assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
    });
}

#[tokio::test]
async fn a_workspace_that_is_closing_is_workspace_unavailable() {
    let rig = rig("closing", "ja");
    rig.open_gate();
    rig.state.ws.lifecycle_core().request_shutdown().unwrap();
    let answer = status_of(&rig, rig.payload("scene")).await;
    assert_eq!(answer["status"], "workspace-unavailable");
    assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
}

#[tokio::test]
async fn a_whole_call_on_a_real_workspace_ends_with_a_status_and_returns_everything() {
    let rig = rig("whole", "ja");
    rig.open_gate();
    // The holders of the workspace authority before the call: the rig and the
    // active workspace. A shutdown or a restore waits for exactly this count.
    let holders = Arc::strong_count(&rig.authority);
    let answer = status_of(&rig, rig.payload("scene")).await;
    // There is no published Chronicle index, so the first read stops here.
    assert_eq!(answer["status"], "index-unavailable");
    assert_eq!(answer["success"], false);
    assert_eq!(answer["items"], json!([]));
    // `execute` ran in a blocking task that outlives the answer by its tail;
    // wait for what it holds to come back.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline
        && (rig.state.chat_ir.permits.in_flight() != 0
            || rig
                .state
                .ws
                .lifecycle_core()
                .workspace_participant_count()
                .unwrap()
                != 0)
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(rig.state.chat_ir.permits.in_flight(), 0);
    assert_eq!(
        rig.state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .unwrap(),
        0
    );
    assert_eq!(
        rig.audit_rows(),
        0,
        "a call that stopped before the embedding audited"
    );
    // S1A-12 (c): what the call pinned (the request, the participant) is gone, so
    // the authority is back to the holders it had; `wait_for_sole_owner` of a
    // shutdown or a restore would otherwise fail after its wait.
    assert_eq!(
        Arc::strong_count(&rig.authority),
        holders,
        "the call kept the workspace authority"
    );
}

// ---- S1A-10 / S1A-25 / S1A-26: the first read ----------------------------------

#[test]
fn the_first_read_refuses_by_project_language_and_scene_before_anything_is_embedded() {
    for (language, scene, project, expected) in [
        ("fr", "scene", "default-project", ChatIrStatus::Unsupported),
        (
            "en-US",
            "scene",
            "default-project",
            ChatIrStatus::Unsupported,
        ),
        ("", "scene", "default-project", ChatIrStatus::Unsupported),
        ("JA", "scene", "default-project", ChatIrStatus::Unsupported),
        (
            "ja",
            "scene",
            "no-such-project",
            ChatIrStatus::ProjectUnavailable,
        ),
        (
            "ja",
            "missing",
            "default-project",
            ChatIrStatus::NoCurrentScene,
        ),
        (
            "ja",
            "archived",
            "default-project",
            ChatIrStatus::NoCurrentScene,
        ),
        (
            "ja",
            "folder",
            "default-project",
            ChatIrStatus::NoCurrentScene,
        ),
        (
            "ja",
            "other-scene",
            "default-project",
            ChatIrStatus::NoCurrentScene,
        ),
        ("ja", "", "default-project", ChatIrStatus::NoCurrentScene),
        // A supported language and a live Scene go on to the index, which is
        // absent here.
        (
            "ja",
            "scene",
            "default-project",
            ChatIrStatus::IndexUnavailable,
        ),
        (
            "en",
            "scene",
            "default-project",
            ChatIrStatus::IndexUnavailable,
        ),
    ] {
        let rig = rig("first", language);
        let mut request = rig.request(scene);
        request.project_id = project.into();
        let backend = rig.backend();
        let outcome = backend.first_read(
            &request,
            Instant::now() + Duration::from_secs(5),
            Duration::from_secs(1),
        );
        assert_eq!(
            outcome.err(),
            Some(expected),
            "{language:?} {scene:?} {project:?}"
        );
        assert_eq!(
            rig.audit_rows(),
            0,
            "{language:?} {scene:?}: something was audited"
        );
    }
}

#[test]
fn the_first_read_closes_its_transaction_before_it_returns() {
    let rig = rig("closed", "ja");
    let backend = rig.backend();
    let _ = backend.first_read(
        &rig.request("scene"),
        Instant::now() + Duration::from_secs(5),
        Duration::from_secs(1),
    );
    // The connection is free: a call that waits for it at most 200 ms gets it.
    let got = rig
        .authority
        .db()
        .try_with_conn_until(Instant::now() + Duration::from_millis(200), |_| Ok(()))
        .expect("acquire");
    assert!(got.is_some(), "the first read kept the connection");
}

#[test]
fn a_busy_connection_ends_the_first_read_at_the_probe_not_at_the_deadline() {
    let rig = rig("probe", "ja");
    let backend = rig.backend();
    let database = rig.authority.db();
    let held = Arc::new(std::sync::Barrier::new(2));
    std::thread::scope(|scope| {
        let barrier = Arc::clone(&held);
        scope.spawn(move || {
            database
                .with_conn(|_| {
                    barrier.wait();
                    std::thread::sleep(Duration::from_millis(2500));
                    Ok(())
                })
                .unwrap();
        });
        held.wait();
        let started = Instant::now();
        let outcome = backend.first_read(
            &rig.request("scene"),
            Instant::now() + Duration::from_secs(10),
            Duration::from_millis(150),
        );
        let elapsed = started.elapsed();
        assert_eq!(outcome.err(), Some(ChatIrStatus::ConnectionBusy));
        assert!(
            elapsed >= Duration::from_millis(100),
            "{elapsed:?}: it did not wait for the connection at all"
        );
        assert!(
            elapsed < Duration::from_millis(2000),
            "{elapsed:?}: it waited for the holder, not for the probe"
        );
    });
    assert_eq!(rig.audit_rows(), 0);
}

#[test]
fn a_read_after_the_pinned_workspace_stopped_being_current_is_workspace_changed() {
    let rig = rig("epoch", "ja");
    let backend = rig.backend();
    // The semantic epoch turns (a cancelled close, a quiescence).
    rig.state.semantic.rotate_workspace_epoch();
    let outcome = backend.first_read(
        &rig.request("scene"),
        Instant::now() + Duration::from_secs(5),
        Duration::from_secs(1),
    );
    assert_eq!(outcome.err(), Some(ChatIrStatus::WorkspaceChanged));
}

/// What a read returns once the workspace is closing is an ordinary status, not
/// `internal` (the real error of the real stop, not a constructed one).
#[test]
fn a_read_after_a_shutdown_request_is_workspace_unavailable() {
    let rig = rig("stopped-read", "ja");
    let backend = rig.backend();
    rig.state.ws.lifecycle_core().request_shutdown().unwrap();
    let outcome = backend.first_read(
        &rig.request("scene"),
        Instant::now() + Duration::from_secs(5),
        Duration::from_secs(1),
    );
    assert_eq!(outcome.err(), Some(ChatIrStatus::WorkspaceUnavailable));
}

// ---- S1A-8 / S1A-11 / S1A-14: the embedding step -----------------------------------

#[test]
fn a_model_that_is_not_resident_is_embedder_cold_and_nothing_is_audited() {
    let rig = rig("cold", "ja");
    let backend = rig.backend();
    let basis = basis_for("ja").unwrap().unwrap();
    let outcome = backend
        .prepare(
            &rig.request("scene"),
            &basis,
            Instant::now() + Duration::from_secs(5),
        )
        .expect("an outcome");
    match outcome {
        Prepared::Unavailable { status, pending } => {
            assert_eq!(status, ChatIrStatus::EmbedderCold);
            assert!(pending.is_none());
        }
        Prepared::Query(_) => panic!("a query without a model"),
    }
    assert_eq!(rig.audit_rows(), 0);
}

/// The real runtime's own string for an epoch that turned before the embedding
/// is the one the table maps (the other codes are checked against the source
/// text in the unit tests).
#[test]
fn the_runtimes_epoch_error_is_workspace_changed() {
    let rig = rig("epoch-error", "ja");
    let backend = rig.backend();
    rig.state.semantic.rotate_workspace_epoch();
    let basis = basis_for("ja").unwrap().unwrap();
    let outcome = backend.prepare(
        &rig.request("scene"),
        &basis,
        Instant::now() + Duration::from_secs(5),
    );
    assert_eq!(outcome.err(), Some(ChatIrStatus::WorkspaceChanged));
}

// ---- S1A-13 / S1A-20: shutdown while a call (and its tail) holds the participant ---

#[test]
fn shutdown_is_not_held_up_by_a_call_in_its_tail() {
    let rig = rig("shutdown", "ja");
    let participant = rig
        .state
        .ws
        .lifecycle_core()
        .begin_workspace_participant()
        .unwrap();
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Pending(PendingSpec::never(Duration::from_millis(500)));
    fake.participant = Some(participant);
    let pool = crate::chat_ir::permit::PermitPool::new(2);
    let permit = pool.try_acquire().unwrap();
    let ledger = Mutex::new(crate::chat_ir::ledger::Ledger::new(10));
    let config = crate::chat_ir::ChatIrConfig {
        tail_slice: Duration::from_millis(100),
        close_flush: Duration::from_millis(200),
        ..Default::default()
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| {
            execute(
                fake,
                permit,
                config,
                &ledger,
                request(),
                Instant::now(),
                sender,
            );
        });
        receiver.blocking_recv().expect("an answer");
        // The task is in its 30 s tail and holds the participant.
        assert_eq!(
            rig.state
                .ws
                .lifecycle_core()
                .workspace_participant_count()
                .unwrap(),
            1
        );
        let requested = Instant::now();
        rig.state.ws.lifecycle_core().request_shutdown().unwrap();
        handle.join().unwrap();
        let waited = requested.elapsed();
        // slice 100 ms + close flush 200 ms, plus one attempt in progress.
        assert!(
            waited < Duration::from_secs(10), // the tail budget is 30 s
            "shutdown waited {waited:?} for the tail"
        );
        eprintln!(
            "S1A-13: participant released {waited:?} after the shutdown request (tail budget 30 s)"
        );
    });
    assert_eq!(
        rig.state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .unwrap(),
        0
    );
    assert_eq!(pool.in_flight(), 0);
}

// ---- S1A-19: nothing the model wrote is logged ---------------------------------------

mod log_capture {
    use std::sync::{Arc, Mutex, OnceLock};
    use tracing::field::{Field, Visit};
    use tracing::span::{Attributes, Id, Record};
    use tracing::{Event, Metadata, Subscriber};

    /// Records every event and span of the process, whatever its level and
    /// thread. It is the global default: a call runs on a blocking thread, which
    /// a thread-local subscriber does not see (and a callsite first reached from
    /// such a thread would be disabled for the test thread as well).
    struct Capture(Arc<Mutex<Vec<String>>>);

    struct Text(String);
    impl Visit for Text {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.0.push_str(&format!("{}={value:?} ", field.name()));
        }
    }

    impl Subscriber for Capture {
        fn enabled(&self, _: &Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, attributes: &Attributes<'_>) -> Id {
            let mut text = Text(String::new());
            attributes.record(&mut text);
            if text.0.contains(super::SECRET) {
                self.0.lock().unwrap().push(text.0);
            }
            Id::from_u64(1)
        }
        fn record(&self, _: &Id, _: &Record<'_>) {}
        fn record_follows_from(&self, _: &Id, _: &Id) {}
        fn event(&self, event: &Event<'_>) {
            // Only what this test looks at, so the process-wide subscriber
            // neither grows without bound nor slows the other tests: the chat
            // IR's own events and any line that carries the secret.
            let target = event.metadata().target();
            let mut text = Text(target.to_string() + " ");
            event.record(&mut text);
            if target.starts_with("grimodex_node::chat_ir") || text.0.contains(super::SECRET) {
                self.0.lock().unwrap().push(text.0);
            }
        }
        fn enter(&self, _: &Id) {}
        fn exit(&self, _: &Id) {}
    }

    pub(super) fn lines() -> Arc<Mutex<Vec<String>>> {
        static LINES: OnceLock<Arc<Mutex<Vec<String>>>> = OnceLock::new();
        Arc::clone(LINES.get_or_init(|| {
            let lines = Arc::new(Mutex::new(Vec::new()));
            // No other test installs a subscriber; if one ever does, the
            // sanity check in the test (an event of its own is seen) fails.
            let _ = tracing::subscriber::set_global_default(Capture(Arc::clone(&lines)));
            lines
        }))
    }
}

const SECRET: &str = "SECRET-QUERY-TOKEN-7f3a";
/// A candidate event ID that carries the secret's text, so the capture sees it
/// wherever it is written (S1-A2: candidate IDs are never logged either).
const SECRET_EVENT_ID: &str = "SECRET-QUERY-TOKEN-7f3a-event-id";

#[tokio::test]
async fn no_path_logs_the_query() {
    let secret = SECRET;
    let lines = log_capture::lines();
    tracing::info!("log capture is installed");
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("log capture is installed")),
        "the capture sees no event: this test would prove nothing"
    );
    let rig = rig("log", "ja");
    rig.open_gate();
    let mut payload = rig.payload("scene");
    payload["query"] = json!(secret);
    payload["chronicleEventIds"] = json!([SECRET_EVENT_ID]);
    // Refusals, a normal end, a refused query and a busy call.
    status_of(&rig, payload.clone()).await;
    let mut other_path = payload.clone();
    other_path["expectedWorkspacePath"] = json!("/nowhere");
    status_of(&rig, other_path).await;
    let mut long = payload.clone();
    long["query"] = json!(format!("{secret}{}", "a".repeat(600)));
    status_of(&rig, long).await;
    wait_until_idle(&rig).await;
    let held: Vec<_> = (0..2)
        .map(|_| rig.state.chat_ir.permits.try_acquire().unwrap())
        .collect();
    status_of(&rig, payload).await;
    drop(held);
    // The tail path, with the query as the request's own.
    let mut fake = Fake::new();
    fake.prepare = PrepareMode::Pending(PendingSpec::on_call(Duration::ZERO, 1));
    let pool = crate::chat_ir::permit::PermitPool::new(1);
    let permit = pool.try_acquire().unwrap();
    let ledger = Mutex::new(crate::chat_ir::ledger::Ledger::new(10));
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let mut secret_request = request();
    secret_request.query = secret.into();
    secret_request.chronicle_event_ids = vec![SECRET_EVENT_ID.to_string()];
    execute(
        fake,
        permit,
        crate::chat_ir::ChatIrConfig::default(),
        &ledger,
        secret_request,
        Instant::now(),
        sender,
    );
    // The blocking tasks of the calls above end (tail included) before looking.
    wait_until_idle(&rig).await;
    let captured = lines.lock().unwrap().join("\n");
    assert!(
        captured.contains("terminal audit tail ended"),
        "the call paths logged nothing at all: the capture is not seeing the calls"
    );
    assert!(
        !captured.contains(secret),
        "the query reached a log line:\n{captured}"
    );
    assert!(
        !captured.contains(SECRET_EVENT_ID),
        "a candidate event ID reached a log line:\n{captured}"
    );
}
