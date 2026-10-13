//! Tests for the DT-2 generation attempt owner. Acceptance IDs in the
//! comments refer to the DT-2 test plan (O1-O17, DG-2, DG-3); the S4 and
//! DT-3 tests cover AttemptBinding v2 (separate Main caller session and chat
//! session, Scene incarnation checks).

use super::*;
use crate::nir1_prepared_request::accept_current_chat_submission;
use grimodex_core::narrative_nir1_receipt::{
    Completion, OutputChannel, OutputObserver, ParseStatus, ProviderTerminal, TerminalStatus,
};
use grimodex_db::domain_writes::{
    tree_node_create, tree_node_delete, TreeNodeCreatePayload, TreeNodeDeletePayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::nir1_generation::{
    AttemptSceneBinding, FailureClassification, GenerationPurpose, InputReference, InputRole,
    InputTarget, NewChatInputSubmission, Nir1GenerationFailpoint, ReadBudget, StoredAttempt,
};
use grimodex_db::state::{ActiveWorkspace, PinnedWorkspaceDb, WorkspaceAuthority};
use grimodex_db::workspace_lifecycle::{AdmissionKind, LifecycleEdge, WorkspaceLifecycleObserver};
use grimodex_db::AdmissionOutcome;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// A fixed, test-only framed protocol over 127.0.0.1. It sends no HTTP,
/// accepts no configurable destination/provider, and owns no retry,
/// redirect, proxy, background task, or recovery callback. Its evidence is
/// limited to exact local request bytes, separated raw output observations,
/// explicit fixture terminal frames, and peer close behavior. It does not
/// prove any provider protocol, remote receipt, product route, real
/// provider termination bound, or D2b publication readiness.
mod loopback {
    use grimodex_core::narrative_nir1_receipt::{
        Completion, OutputChannel, OutputObserver, ProviderTerminal, TerminalObservation,
    };
    use std::io::{self, Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::thread;
    use std::time::{Duration, Instant};

    use anyhow::{ensure, Result};

    pub(super) const IO_TIMEOUT: Duration = Duration::from_secs(5);
    const MAX_FRAME_BYTES: usize = 64 * 1024;
    const TEXT: u8 = 1;
    const THINKING: u8 = 2;
    const TERMINAL: u8 = 3;
    const COMPLETE: u8 = 1;
    const LENGTH_LIMIT: u8 = 2;
    const INELIGIBLE: u8 = 3;

    pub(super) struct Response {
        pub(super) observation: TerminalObservation,
        pub(super) text: Vec<u8>,
        pub(super) thinking: Vec<u8>,
        pub(super) saw_terminal: bool,
        pub(super) peer_closed: bool,
    }

    pub(super) fn listener() -> Result<TcpListener> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }

    pub(super) fn connect(listener: &TcpListener) -> Result<TcpStream> {
        let address: SocketAddr = listener.local_addr()?;
        let stream = TcpStream::connect_timeout(&address, IO_TIMEOUT)?;
        configure(&stream)?;
        Ok(stream)
    }

    pub(super) fn accept(listener: &TcpListener) -> io::Result<TcpStream> {
        let deadline = Instant::now() + IO_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_read_timeout(Some(IO_TIMEOUT))?;
                    stream.set_write_timeout(Some(IO_TIMEOUT))?;
                    return Ok(stream);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "loopback fixture accept timed out",
                        ));
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) fn assert_no_pending_connection(listener: &TcpListener) -> Result<()> {
        match listener.accept() {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
            Ok((stream, _)) => {
                drop(stream);
                anyhow::bail!("fixture observed a second connection")
            }
            Err(error) => Err(error.into()),
        }
    }

    fn configure(stream: &TcpStream) -> io::Result<()> {
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))
    }

    pub(super) fn send_request(stream: &mut TcpStream, body: &[u8]) -> Result<()> {
        ensure!(
            body.len() <= MAX_FRAME_BYTES,
            "test request exceeds fixture bound"
        );
        let length = u32::try_from(body.len())?.to_be_bytes();
        stream.write_all(&length)?;
        stream.write_all(body)?;
        Ok(())
    }

    pub(super) fn read_request(stream: &mut TcpStream) -> Result<Vec<u8>> {
        let mut header = [0; 4];
        stream.read_exact(&mut header)?;
        let length = usize::try_from(u32::from_be_bytes(header))?;
        ensure!(
            length <= MAX_FRAME_BYTES,
            "test request exceeds fixture bound"
        );
        let mut body = vec![0; length];
        stream.read_exact(&mut body)?;
        Ok(body)
    }

    pub(super) fn write_response(
        stream: &mut TcpStream,
        text: &[u8],
        thinking: &[u8],
        terminal: u8,
    ) -> Result<()> {
        write_output(stream, text, thinking)?;
        stream.write_all(&[TERMINAL, terminal])?;
        Ok(())
    }

    pub(super) fn write_output(stream: &mut TcpStream, text: &[u8], thinking: &[u8]) -> Result<()> {
        ensure!(
            text.len() <= MAX_FRAME_BYTES && thinking.len() <= MAX_FRAME_BYTES - text.len(),
            "test response exceeds fixture bound"
        );
        for index in 0..text.len().max(thinking.len()) {
            if let Some(byte) = text.get(index) {
                write_data_frame(stream, TEXT, std::slice::from_ref(byte))?;
            }
            if let Some(byte) = thinking.get(index) {
                write_data_frame(stream, THINKING, std::slice::from_ref(byte))?;
            }
        }
        Ok(())
    }

    fn write_data_frame(stream: &mut TcpStream, channel: u8, bytes: &[u8]) -> Result<()> {
        ensure!(
            bytes.len() <= MAX_FRAME_BYTES,
            "test response exceeds fixture bound"
        );
        stream.write_all(&[channel])?;
        stream.write_all(&u32::try_from(bytes.len())?.to_be_bytes())?;
        stream.write_all(bytes)?;
        Ok(())
    }

    pub(super) fn read_response(stream: &mut TcpStream) -> Result<Response> {
        let mut observer = OutputObserver::new();
        let mut text = Vec::new();
        let mut thinking = Vec::new();
        let mut total_bytes = 0;
        let mut saw_terminal = false;
        let mut completion = Completion::UnexpectedEof;
        while let Some(tag) = read_tag(stream)? {
            match tag {
                TEXT | THINKING => {
                    ensure!(!saw_terminal, "fixture data after terminal");
                    let bytes = read_data_frame(stream)?;
                    ensure!(
                        bytes.len() <= MAX_FRAME_BYTES - total_bytes,
                        "test response exceeds fixture bound"
                    );
                    total_bytes += bytes.len();
                    let (channel, destination) = if tag == TEXT {
                        (OutputChannel::Text, &mut text)
                    } else {
                        (OutputChannel::Thinking, &mut thinking)
                    };
                    destination.extend_from_slice(&bytes);
                    // Frames deliberately split every UTF-8 scalar into
                    // one-byte events; the observer receives the exact raw
                    // bytes without decoding or normalization.
                    let _ = observer.observe(channel, &bytes);
                }
                TERMINAL => {
                    ensure!(!saw_terminal, "fixture duplicate terminal");
                    let mut status = [0; 1];
                    stream.read_exact(&mut status)?;
                    let (provider_terminal, parsed_completion) = match status[0] {
                        COMPLETE => (ProviderTerminal::Complete, Completion::Parsed),
                        LENGTH_LIMIT => (ProviderTerminal::LengthLimit, Completion::Truncated),
                        INELIGIBLE => (ProviderTerminal::Ineligible, Completion::ParseFailure),
                        _ => anyhow::bail!("fixture sent unknown terminal"),
                    };
                    let _ = observer.observe_terminal(provider_terminal);
                    completion = parsed_completion;
                    saw_terminal = true;
                }
                _ => anyhow::bail!("fixture sent unknown frame"),
            }
        }
        Ok(Response {
            observation: observer.finish(completion),
            text,
            thinking,
            saw_terminal,
            // Successful return is only possible after `read_tag` saw
            // EOF, so record the observed close explicitly.
            peer_closed: true,
        })
    }

    fn read_tag(stream: &mut TcpStream) -> io::Result<Option<u8>> {
        let mut tag = [0; 1];
        loop {
            match stream.read(&mut tag) {
                Ok(0) => return Ok(None),
                Ok(_) => return Ok(Some(tag[0])),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }

    fn read_data_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
        let mut header = [0; 4];
        stream.read_exact(&mut header)?;
        let length = usize::try_from(u32::from_be_bytes(header))?;
        ensure!(
            length <= MAX_FRAME_BYTES,
            "test response exceeds fixture bound"
        );
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    pub(super) fn wait_for_peer_close(stream: &mut TcpStream) -> io::Result<()> {
        let mut byte = [0; 1];
        loop {
            match stream.read(&mut byte) {
                Ok(0) => return Ok(()),
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unexpected bytes after fixed request",
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

const PROJECT: &str = "owner-project";
const SCENE: &str = "owner-scene";
const SESSIONS: [&str; 3] = ["owner-session-a", "owner-session-b", "owner-session-c"];
const READ_BUDGET: ReadBudget = ReadBudget {
    max_references: 8,
    max_reference_bytes: 4096,
};

fn workspace_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("nir1-owner-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
    std::fs::write(
        root.join(".grimodex/workspace.json"),
        r#"{"id":"owner-workspace"}"#,
    )
    .expect("workspace metadata");
    let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
    db.migrate().expect("schema");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects(id,title) VALUES (?1,'Owner')",
            [PROJECT],
        )?;
        for session in SESSIONS {
            conn.execute(
                "INSERT INTO chat_sessions(id,project_id,title) VALUES (?1,?2,'Owner')",
                [session, PROJECT],
            )?;
        }
        Ok(())
    })
    .expect("workspace rows");
    create_scene(&db, "initial");
    root
}

/// Create the live Scene through the Native tree writer, which mints its A1
/// scope incarnation, and attach every chat session of the project to it.
/// `tag` keeps the writer's request and event keys unique when the Scene is
/// created again.
fn create_scene(db: &grimodex_db::Database, tag: &str) {
    tree_node_create(
        db,
        TreeNodeCreatePayload {
            id: SCENE.into(),
            project_id: PROJECT.into(),
            request_id: format!("{SCENE}-create-{tag}"),
            session_id: SESSIONS[0].into(),
            event_uid: format!("{SCENE}-create-event-{tag}"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".into(),
            title: "Scene".into(),
            sort_order: "a0".into(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some(r#"{"type":"doc","content":[]}"#.into()),
            canonical_payload: None,
        },
    )
    .expect("Scene through the Native tree writer");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_sessions SET node_id=?1 WHERE project_id=?2",
            [SCENE, PROJECT],
        )?;
        Ok(())
    })
    .expect("attach the chat sessions to the Scene");
}

/// One Native process with the workspace Ready (an identity-bearing binding
/// published by the real adapter), its startup gate Open after a real sweep,
/// and one registered main caller per chat session. A caller's Main session
/// is a random UUID; the chat session of caller `i` is `SESSIONS[i]`.
struct OwnerFixture {
    root: PathBuf,
    state: Arc<AppState>,
    authority: PinnedWorkspaceDb,
    callers: Vec<CallerIdentity>,
    owns_root: bool,
}

impl OwnerFixture {
    fn new() -> Self {
        let root = workspace_root();
        Self::open(root, "app", true)
    }

    fn open(root: PathBuf, app: &str, owns_root: bool) -> Self {
        let backend =
            crate::Backend::new(root.join(app).to_string_lossy().into_owned(), None, None)
                .expect("Native backend");
        let state = Arc::clone(&backend.state);
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
        db.migrate().expect("schema");
        let authority =
            WorkspaceAuthority::from_database_for_test(db, root.clone()).expect("authority");
        *state.ws.inner.lock().expect("workspace") =
            Some(ActiveWorkspace::new(Arc::clone(&authority)));
        let view = state
            .workspace_lifecycle
            .ensure_authority_ready(&state.ws)
            .expect("Ready publication");
        assert_eq!(
            view.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
        );
        assert!(
            crate::nir1_generation::sweep_and_open_ready_entry_for_test(&state),
            "the startup gate opens after the real sweep"
        );
        let status = state
            .profile_egress
            .activate_first_restricted_publication(true)
            .expect("restricted profile");
        let locator = root.to_string_lossy().into_owned();
        state.profile_egress.bind_workspace(Some(locator.clone()));
        let callers = (0..SESSIONS.len())
            .map(|index| {
                let caller = CallerIdentity {
                    profile_id: status.profile_id.clone(),
                    caller_id: format!("owner-caller-{index}"),
                    caller_epoch: status.caller_epoch,
                    sender_id: u64::try_from(index + 1).expect("sender"),
                    workspace_id: Some(locator.clone()),
                    // Main issues one random session per sender. It is the
                    // caller's session, never a chat session.
                    session_id: uuid::Uuid::new_v4().to_string(),
                };
                state
                    .profile_egress
                    .register_caller(&caller)
                    .expect("caller");
                caller
            })
            .collect();
        Self {
            root,
            state,
            authority,
            callers,
            owns_root,
        }
    }

    fn gate(&self) -> &Nir1StartupAdmissionGate {
        self.state.workspace_lifecycle.nir1_startup_gate()
    }

    fn binding(&self) -> LiveBinding {
        ready_binding(&self.state).expect("Ready binding")
    }

    fn accept(&self, session: usize, key: &str) -> NativeAcceptedChatSubmission {
        self.accept_as(&self.callers[session], SESSIONS[session], key)
    }

    /// Accept one current Human submission by `caller` in `chat_session`.
    fn accept_as(
        &self,
        caller: &CallerIdentity,
        chat_session: &str,
        key: &str,
    ) -> NativeAcceptedChatSubmission {
        let submission = NewChatInputSubmission::new(
            format!("owner-submission-{key}"),
            format!("owner-message-{key}"),
            chat_session.into(),
            SCENE.into(),
            format!("Human turn {key}"),
            "2026-10-13T00:00:00.000Z".into(),
        )
        .expect("submission");
        accept_current_chat_submission(Arc::clone(&self.state), caller.clone(), &submission)
            .expect("accepted current Human capture")
    }

    /// One more scene-bound chat session of the project, with its own
    /// registered main caller (and that caller's own Main session).
    fn add_session(&self, index: usize) -> (CallerIdentity, String) {
        let session = format!("owner-session-extra-{index:02}");
        self.authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chat_sessions(id,project_id,title,node_id)
                     VALUES (?1,?2,'Owner',?3)",
                    [session.as_str(), PROJECT, SCENE],
                )?;
                Ok(())
            })
            .expect("chat session");
        let caller = CallerIdentity {
            caller_id: format!("owner-caller-extra-{index:02}"),
            sender_id: u64::try_from(100 + index).expect("sender"),
            session_id: uuid::Uuid::new_v4().to_string(),
            ..self.callers[0].clone()
        };
        self.state
            .profile_egress
            .register_caller(&caller)
            .expect("caller");
        (caller, session)
    }

    /// The current Scene binding, read the way the coordinator reads it: in
    /// one read transaction.
    fn scene_binding(&self) -> AttemptSceneBinding {
        self.authority
            .db()
            .with_read_transaction(|conn| {
                storage::read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)
            })
            .expect("Scene binding")
    }

    /// Delete and recreate the Scene with the same id and body, both through
    /// the Native tree writer: the A1 writer mints a new incarnation for the
    /// recreated row. `tag` keeps the writer's request keys unique.
    fn replace_scene(&self, tag: &str) {
        tree_node_delete(
            self.authority.db(),
            TreeNodeDeletePayload {
                project_id: PROJECT.into(),
                request_id: format!("{SCENE}-delete-{tag}"),
                session_id: SESSIONS[0].into(),
                event_uid: format!("{SCENE}-delete-event-{tag}"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                node_id: SCENE.into(),
                canonical_payload: None,
            },
        )
        .expect("delete the Scene through the Native tree writer");
        create_scene(self.authority.db(), tag);
    }

    /// A tree patch may change the body without a new token.
    fn edit_scene_body_in_place(&self) {
        self.authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes SET content=?3 WHERE id=?1 AND project_id=?2",
                    [
                        SCENE,
                        PROJECT,
                        r#"{"type":"doc","content":[{"type":"paragraph"}]}"#,
                    ],
                )?;
                Ok(())
            })
            .expect("edit the Scene body");
    }

    fn owner(
        &self,
        session: usize,
        submission: &NativeAcceptedChatSubmission,
    ) -> Result<Nir1GenerationOwner, Nir1GenerationRefusal> {
        Nir1GenerationOwner::capture(
            Arc::clone(&self.state),
            self.callers[session].clone(),
            submission,
        )
    }

    fn request(
        &self,
        owner: &Nir1GenerationOwner,
        submission: &NativeAcceptedChatSubmission,
    ) -> FinalDispatchRequest {
        let now = now_ms().expect("clock");
        let digest = canonical_json_digest(&json!("owner-fixture")).expect("digest");
        FinalDispatchRequest {
            project_id: PROJECT.into(),
            chat_session_id: submission.chat_session_id().into(),
            scene: self.scene_binding(),
            route_revision: owner.route_revision().into(),
            purpose: GenerationPurpose::Writing,
            scope_digest: digest.clone(),
            material_digest: digest.clone(),
            d1_digest: digest.clone(),
            provider: "test-recorder".into(),
            model: "test".into(),
            api: "internal-test".into(),
            endpoint_identity: digest,
            payload: json!({"messages": [], "submission": submission.submission_id()}),
            inputs: vec![InputReference {
                role: InputRole::User,
                target: InputTarget::Message {
                    version_id: submission.message_version_id().into(),
                    parent_attempt_id: None,
                },
            }],
            qualifications: vec![],
            created_at_ms: now,
            expires_at_ms: now + 60_000,
            budget: READ_BUDGET,
        }
    }

    fn prepared(&self, session: usize, key: &str) -> Nir1PreparedAttempt {
        let submission = self.accept(session, key);
        let owner = self.owner(session, &submission).expect("owner");
        let request = self.request(&owner, &submission);
        owner.create(request).expect("durable attempt")
    }

    fn attempt(&self, id: &str) -> StoredAttempt {
        storage::read_attempt(self.authority.db(), id, READ_BUDGET).expect("attempt row")
    }

    fn attempt_count(&self) -> i64 {
        self.authority
            .db()
            .with_conn(|conn| {
                Ok(
                    conn.query_row("SELECT count(*) FROM nir1_generation_attempts", [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("attempt count")
    }

    fn publish_new_ready_entry(&self) -> (LiveBinding, u64) {
        match self
            .state
            .workspace_lifecycle
            .try_begin_transition_kind(AdmissionKind::Open)
            .expect("admission")
        {
            AdmissionOutcome::Admitted(_) => {}
            AdmissionOutcome::NotAdmitted { reason, .. } => {
                panic!("transition not admitted: {reason:?}")
            }
        }
        let view = self
            .state
            .workspace_lifecycle
            .complete_transition_from_workspace(&self.state.ws)
            .expect("Ready publication");
        assert_eq!(
            view.status,
            crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
        );
        (self.binding(), view.revision)
    }

    fn admission_budget(&self) -> Nir1AdmissionSqlBudget {
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true))
    }
}

impl Drop for OwnerFixture {
    fn drop(&mut self) {
        if self.owns_root {
            let _ = std::fs::remove_dir_all(&self.root);
        }
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

/// The test recorder is the transport: one call is one send (DG-2).
fn record_send(
    transport: Nir1TransportOwner,
    recorder: &AtomicUsize,
    message_id: &str,
) -> StoredTerminal {
    recorder.fetch_add(1, Ordering::SeqCst);
    let text = "recorded answer";
    transport
        .finish(
            &completed(text),
            Some(NewMessageBody {
                message_id: message_id.into(),
                content: text.into(),
                thinking: String::new(),
            }),
        )
        .expect("terminal after the recorded send")
}

fn not_started(decision: Nir1TransportDecision) -> Nir1Settlement {
    match decision {
        Nir1TransportDecision::NotStarted(settlement) => settlement,
        Nir1TransportDecision::Start(_) => panic!("the transport must not start"),
    }
}

fn zero_send(decision: Nir1TransportDecision) -> StoredTerminal {
    match not_started(decision) {
        Nir1Settlement::ZeroSend(terminal) => *terminal,
        other => panic!("expected one zero-send terminal, got {other:?}"),
    }
}

/// Hold the connection mutex on another thread until `release` fires.
fn hold_connection(authority: &PinnedWorkspaceDb) -> (mpsc::Sender<()>, thread::JoinHandle<()>) {
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = Arc::clone(authority);
    let worker = thread::spawn(move || {
        holder
            .db()
            .with_conn(|_| {
                held_tx.send(()).expect("announce held mutex");
                let _ = release_rx.recv_timeout(Duration::from_secs(10));
                Ok(())
            })
            .expect("mutex holder");
    });
    held_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("connection mutex held");
    (release_tx, worker)
}

fn wait_for(condition: impl Fn() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(1));
    }
}

/// O1: the claim COMMIT holds no Core, profile, gate, participant or owner
/// mutex; each is usable from another thread during COMMIT.
#[test]
fn o1_claim_commit_holds_no_lifecycle_profile_gate_or_owner_lock() {
    let fixture = OwnerFixture::new();
    let prepared = fixture.prepared(0, "o1");
    let cancel = prepared.cancel_handle();
    let (in_commit_tx, in_commit_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = std::sync::Mutex::new(release_rx);
    prepared.hooks().test_hooks().fail_next(
        "claim",
        Nir1GenerationFailpoint::ProbeDuringCommit(Arc::new(move || {
            in_commit_tx.send(()).expect("announce COMMIT");
            release_rx
                .lock()
                .expect("release receiver")
                .recv_timeout(Duration::from_secs(5))
                .expect("release COMMIT");
        })),
    );
    let state = Arc::clone(&fixture.state);
    let caller = fixture.callers[0].clone();
    let binding = fixture.binding();
    thread::scope(|scope| {
        let owner = scope.spawn(move || prepared.claim_for_transport());
        in_commit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the owner is inside COMMIT");
        let (done_tx, done_rx) = mpsc::channel();
        scope.spawn(move || {
            state.ws.lifecycle_core().snapshot().expect("Core snapshot");
            state.profile_egress.status();
            let permit = state
                .profile_egress
                .begin_dispatch(Some(&caller))
                .expect("permit");
            state
                .profile_egress
                .with_authorized_dispatch(&permit, Some(&caller), Some(&binding.locator), || Ok(()))
                .expect("profile authorization");
            drop(
                state
                    .workspace_lifecycle
                    .nir1_startup_gate()
                    .try_lease_for_binding(&binding)
                    .expect("gate lease"),
            );
            drop(
                state
                    .ws
                    .lifecycle_core()
                    .begin_workspace_participant()
                    .expect("participant"),
            );
            cancel.cancel();
            done_tx.send(()).expect("done");
        });
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("every lock was free during COMMIT (1 s)");
        release_tx.send(()).expect("release COMMIT");
        let terminal = zero_send(owner.join().expect("owner"));
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::Cancelled),
            "cancel during COMMIT is observed at the start decision"
        );
    });
}

/// O2 / DG-2: the recorder sends once or never for one submission.
#[test]
fn o2_dg2_recorder_sends_at_most_once() {
    let fixture = OwnerFixture::new();
    let recorder = AtomicUsize::new(0);
    let submission = fixture.accept(0, "o2");
    let barrier = std::sync::Barrier::new(2);
    let refusals = thread::scope(|scope| {
        let workers = (0..2)
            .map(|index| {
                let fixture = &fixture;
                let submission = submission.clone();
                let barrier = &barrier;
                let recorder = &recorder;
                scope.spawn(move || {
                    barrier.wait();
                    let owner = fixture.owner(0, &submission)?;
                    let request = fixture.request(&owner, &submission);
                    let prepared = owner.create(request)?;
                    match prepared.claim_for_transport() {
                        Nir1TransportDecision::Start(transport) => {
                            record_send(transport, recorder, &format!("o2-output-{index}"));
                            Ok(())
                        }
                        Nir1TransportDecision::NotStarted(settlement) => {
                            panic!("unexpected settlement {settlement:?}")
                        }
                    }
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .filter_map(|worker| worker.join().expect("worker").err())
            .collect::<Vec<_>>()
    });
    assert_eq!(recorder.load(Ordering::SeqCst), 1);
    assert_eq!(refusals.len(), 1);
    assert!(matches!(
        refusals[0],
        Nir1GenerationRefusal::SameSubmissionInFlight { .. }
            | Nir1GenerationRefusal::SubmissionAlreadyAttempted { .. }
    ));
    assert_eq!(fixture.attempt_count(), 1);

    // Another claimer's claim first: this owner never sends or terminalizes.
    let prepared = fixture.prepared(1, "o2-other");
    let id = prepared.attempt_id().to_owned();
    let attempt = fixture.attempt(&id);
    assert!(storage::claim_attempt(
        fixture.authority.db(),
        &id,
        &attempt.binding,
        attempt.expires_at_ms - 1,
        READ_BUDGET,
    )
    .expect("another claimer"));
    assert!(matches!(
        not_started(prepared.claim_for_transport()),
        Nir1Settlement::ClaimLost
    ));
    assert!(fixture.attempt(&id).terminal.is_none());

    // An ambiguous own claim that was not durable, then another claimer.
    let prepared = fixture.prepared(2, "o2-vetoed");
    let id = prepared.attempt_id().to_owned();
    let hooks = prepared.hooks();
    hooks
        .test_hooks()
        .fail_next("claim", Nir1GenerationFailpoint::VetoCommit);
    let authority = Arc::clone(&fixture.authority);
    let attempt = fixture.attempt(&id);
    let claimed = Arc::new(AtomicBool::new(false));
    let probe_claimed = Arc::clone(&claimed);
    hooks
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterCommit, move || {
            if !probe_claimed.swap(true, Ordering::SeqCst) {
                assert!(storage::claim_attempt(
                    authority.db(),
                    &attempt.id,
                    &attempt.binding,
                    attempt.expires_at_ms - 1,
                    READ_BUDGET,
                )
                .expect("another claimer before the reread"));
            }
        });
    assert!(matches!(
        not_started(prepared.claim_for_transport()),
        Nir1Settlement::ClaimLost
    ));
    assert!(fixture.attempt(&id).terminal.is_none());
    assert_eq!(recorder.load(Ordering::SeqCst), 1);
}

/// O3: one in-flight attempt per chat session; other sessions proceed.
#[test]
fn o3_one_in_flight_attempt_per_session() {
    let fixture = OwnerFixture::new();
    let first = fixture.accept(0, "o3-first");
    let held = fixture.owner(0, &first).expect("first owner");
    assert_eq!(
        fixture.owner(0, &first).err(),
        Some(Nir1GenerationRefusal::SameSubmissionInFlight {
            attempt_id: held.attempt_id().into()
        })
    );
    let second = fixture.accept(0, "o3-second");
    assert_eq!(
        fixture.owner(0, &second).err(),
        Some(Nir1GenerationRefusal::SessionBusy)
    );
    let other_session = fixture.accept(1, "o3-other");
    let other = fixture.owner(1, &other_session).expect("another session");
    drop(held);
    drop(other);
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    fixture.owner(0, &second).expect("the slot is released");
}

/// O4: a resend after the terminal resolves to the same attempt.
#[test]
fn o4_resend_after_terminal_never_creates_a_second_attempt() {
    let fixture = OwnerFixture::new();
    let recorder = AtomicUsize::new(0);
    let submission = fixture.accept(0, "o4");
    let owner = fixture.owner(0, &submission).expect("owner");
    let attempt_id = owner.attempt_id().to_owned();
    let request = fixture.request(&owner, &submission);
    let Nir1TransportDecision::Start(transport) =
        owner.create(request).expect("create").claim_for_transport()
    else {
        panic!("first submission starts");
    };
    record_send(transport, &recorder, "o4-output");
    let owner = fixture.owner(0, &submission).expect("resend owner");
    let request = fixture.request(&owner, &submission);
    assert_eq!(
        owner.create(request).err(),
        Some(Nir1GenerationRefusal::SubmissionAlreadyAttempted {
            attempt_id,
            settled: true
        })
    );
    assert_eq!(fixture.attempt_count(), 1);
    assert_eq!(recorder.load(Ordering::SeqCst), 1);
}

/// O5 / DG-3: cancel before the start decision writes exactly one
/// `Cancelled` zero-send terminal; nothing is sent and nothing reclaims it.
#[test]
fn o5_cancel_before_the_start_decision_writes_one_cancelled_terminal() {
    for point in [
        Nir1OwnerProbePoint::BeforePreCommit,
        Nir1OwnerProbePoint::AfterCommit,
        Nir1OwnerProbePoint::BeforeDecision,
    ] {
        let fixture = OwnerFixture::new();
        let prepared = fixture.prepared(0, "o5");
        let expected = prepared.expected();
        let cancel = prepared.cancel_handle();
        let hooks = prepared.hooks();
        hooks.test_hooks().on(point, move || cancel.cancel());
        let terminal = zero_send(prepared.claim_for_transport());
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::Cancelled),
            "{point:?}"
        );
        assert_eq!(terminal.observation["terminalStatus"], "cancelled");
        assert!(terminal.message_version.is_none());
        if point == Nir1OwnerProbePoint::BeforePreCommit {
            // The admission writer stopped as Cancelled; the pinned
            // zero-send writer did not observe the cancel.
            assert!(hooks
                .test_hooks()
                .failures()
                .contains(&("claim", Nir1StoreFailure::Cancelled)));
            assert!(fixture.attempt(&expected.id).claimed_at_ms.is_none());
        } else {
            assert!(fixture.attempt(&expected.id).claimed_at_ms.is_some());
        }
        let workspace = active_workspace_snapshot(&fixture.state.ws).expect("workspace");
        assert_eq!(
            storage::claim_attempt_bounded(
                &workspace,
                &expected,
                &fixture.admission_budget(),
                &mut || Ok(()),
            )
            .expect("claim after the terminal"),
            Nir1ClaimOutcome::AlreadyTerminal
        );
        assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    }
}

/// O6 / DG-3: a failed post-COMMIT revalidation writes one
/// `DispatchUnavailable` terminal and releases the slot.
#[test]
fn o6_post_commit_revalidation_failure_writes_one_dispatch_unavailable_terminal() {
    type Inject = fn(&OwnerFixture, &Arc<std::sync::Mutex<Vec<Box<dyn std::any::Any + Send>>>>);
    let cases: [(&str, Inject); 5] = [
        ("invalidate callers", |fixture, _| {
            fixture.state.profile_egress.invalidate_callers()
        }),
        ("route update", |fixture, _| {
            fixture
                .state
                .profile_egress
                .with_route_update(|| Ok(()))
                .expect("route update")
        }),
        ("registration replaced", |fixture, _| {
            let mut replacement = fixture.callers[0].clone();
            replacement.caller_id = "owner-caller-replacement".into();
            fixture
                .state
                .profile_egress
                .register_caller(&replacement)
                .expect("replacement");
        }),
        ("quarantine", |fixture, keep| {
            let workspace = active_workspace_snapshot(&fixture.state.ws).expect("workspace");
            let fence = storage::quarantine_workspace_for_test(workspace).expect("quarantine");
            keep.lock().expect("keep").push(Box::new(fence));
        }),
        ("binding change", |fixture, _| {
            match fixture
                .state
                .workspace_lifecycle
                .try_begin_transition_kind(AdmissionKind::Open)
                .expect("admission")
            {
                AdmissionOutcome::Admitted(_) => {}
                AdmissionOutcome::NotAdmitted { reason, .. } => panic!("{reason:?}"),
            }
        }),
    ];
    for (name, inject) in cases {
        let fixture = Arc::new(OwnerFixture::new());
        let prepared = fixture.prepared(0, "o6");
        let id = prepared.attempt_id().to_owned();
        let keep = Arc::new(std::sync::Mutex::new(Vec::new()));
        let probe_fixture = Arc::clone(&fixture);
        let probe_keep = Arc::clone(&keep);
        let injected = Arc::new(AtomicBool::new(false));
        let probe_injected = Arc::clone(&injected);
        prepared
            .hooks()
            .test_hooks()
            .on(Nir1OwnerProbePoint::AfterCommit, move || {
                if !probe_injected.swap(true, Ordering::SeqCst) {
                    inject(&probe_fixture, &probe_keep);
                }
            });
        let terminal = zero_send(prepared.claim_for_transport());
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::DispatchUnavailable),
            "{name}"
        );
        assert!(fixture.attempt(&id).claimed_at_ms.is_some(), "{name}");
        assert_eq!(
            fixture.state.nir1_generation_registry.tracked_sessions(),
            0,
            "{name}: slot released"
        );
        drop(keep);
        if name == "binding change" {
            fixture
                .state
                .workspace_lifecycle
                .complete_transition_from_workspace(&fixture.state.ws)
                .expect("complete the transition");
        }
    }
}

/// O7 / DG-3: lifecycle edges retire the lease. The owner settles with one
/// zero-send terminal, then the transition's physical exclusive proceeds, the
/// drain finds no lease and Ready is published (not RecoveryRequired).
#[test]
fn o7_lifecycle_edges_retire_the_lease_and_transitions_proceed_after_settle() {
    // Transition admitted while the owner holds its lease.
    let fixture = Arc::new(OwnerFixture::new());
    let prepared = fixture.prepared(0, "o7-transition");
    let (admitted_tx, admitted_rx) = mpsc::channel();
    let probe_fixture = Arc::clone(&fixture);
    let fired = Arc::new(AtomicBool::new(false));
    let probe_fired = Arc::clone(&fired);
    prepared
        .hooks()
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterCommit, move || {
            if !probe_fired.swap(true, Ordering::SeqCst) {
                match probe_fixture
                    .state
                    .workspace_lifecycle
                    .try_begin_transition_kind(AdmissionKind::Restore)
                    .expect("admission")
                {
                    AdmissionOutcome::Admitted(_) => admitted_tx.send(()).expect("admitted"),
                    AdmissionOutcome::NotAdmitted { reason, .. } => panic!("{reason:?}"),
                }
            }
        });
    let transition_fixture = Arc::clone(&fixture);
    let (published_tx, published_rx) = mpsc::channel();
    let transition = thread::spawn(move || {
        admitted_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("transition admitted");
        let exclusive = transition_fixture
            .state
            .workspace_lifecycle
            .acquire_transition_physical_exclusive()
            .expect("physical exclusive after the owner settled");
        drop(exclusive);
        let started = Instant::now();
        let view = transition_fixture
            .state
            .workspace_lifecycle
            .complete_transition_from_workspace(&transition_fixture.state.ws)
            .expect("publication");
        published_tx
            .send((view.status, started.elapsed()))
            .expect("published");
    });
    let terminal = zero_send(prepared.claim_for_transport());
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );
    let (status, drain) = published_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the transition finishes after the owner settles");
    transition.join().expect("transition worker");
    assert_eq!(
        status,
        crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
    );
    assert!(drain < crate::nir1_startup_barrier::NIR1_STARTUP_LEASE_DRAIN_LIMIT);
    assert_eq!(fixture.gate().active_lease_count(), 0);

    // Unavailable and Shutdown edges.
    for shutdown in [false, true] {
        let fixture = Arc::new(OwnerFixture::new());
        let prepared = fixture.prepared(0, "o7-edge");
        let probe_fixture = Arc::clone(&fixture);
        let fired = Arc::new(AtomicBool::new(false));
        let probe_fired = Arc::clone(&fired);
        prepared
            .hooks()
            .test_hooks()
            .on(Nir1OwnerProbePoint::AfterCommit, move || {
                if !probe_fired.swap(true, Ordering::SeqCst) {
                    if shutdown {
                        probe_fixture
                            .state
                            .ws
                            .lifecycle_core()
                            .request_shutdown()
                            .expect("shutdown");
                    } else {
                        probe_fixture
                            .gate()
                            .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: u64::MAX });
                    }
                }
            });
        let terminal = zero_send(prepared.claim_for_transport());
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::DispatchUnavailable),
            "shutdown={shutdown}"
        );
        assert_eq!(fixture.gate().active_lease_count(), 0);
    }

    // A Ready edge without a Transition (injected into the gate observer)
    // stops an admission writer that is waiting for the connection mutex.
    let fixture = Arc::new(OwnerFixture::new());
    let prepared = fixture.prepared(0, "o7-ready-edge");
    let hooks = prepared.hooks();
    let (zero_send_tx, zero_send_rx) = mpsc::channel();
    hooks
        .test_hooks()
        .on(Nir1OwnerProbePoint::BeforeZeroSend, move || {
            let _ = zero_send_tx.send(());
        });
    let (release, holder) = hold_connection(&fixture.authority);
    let owner = thread::spawn(move || prepared.claim_for_transport());
    wait_for(
        || fixture.authority.db().foreground_connection_waiter_count() == 1,
        "the claim to wait for the connection mutex",
    );
    let binding = fixture.binding();
    fixture
        .gate()
        .on_lifecycle_edge(&LifecycleEdge::ReadyPublished {
            binding: binding.clone(),
            revision: u64::MAX - 1,
        });
    zero_send_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the claim stopped and the owner settles");
    release.send(()).expect("release");
    holder.join().expect("holder");
    let terminal = zero_send(owner.join().expect("owner"));
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );
    assert!(hooks
        .test_hooks()
        .failures()
        .contains(&("claim", Nir1StoreFailure::Fenced)));
    let started = Instant::now();
    assert!(fixture
        .gate()
        .begin_recovery(
            &binding,
            u64::MAX - 1,
            crate::nir1_startup_barrier::NIR1_STARTUP_LEASE_DRAIN_LIMIT
        )
        .is_some());
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "no drain timeout"
    );

    // The same edge stops a long running statement inside the claim.
    let fixture = Arc::new(OwnerFixture::new());
    let prepared = fixture.prepared(0, "o7-long-sql");
    let hooks = prepared.hooks();
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TABLE owner_slow(x INTEGER);
                 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400)
                 INSERT INTO owner_slow SELECT x FROM c;
                 CREATE TEMP TRIGGER owner_slow_claim AFTER UPDATE OF claimed_at_ms
                 ON nir1_generation_attempts
                 BEGIN SELECT count(*) FROM owner_slow a, owner_slow b, owner_slow c; END;",
            )?;
            Ok(())
        })
        .expect("slow claim trigger");
    let binding = fixture.binding();
    let edge_fixture = Arc::clone(&fixture);
    let edge = thread::spawn(move || {
        thread::sleep(Duration::from_millis(40));
        edge_fixture
            .gate()
            .on_lifecycle_edge(&LifecycleEdge::ReadyPublished {
                binding,
                revision: u64::MAX - 1,
            });
    });
    let started = Instant::now();
    let terminal = zero_send(prepared.claim_for_transport());
    edge.join().expect("edge");
    assert!(started.elapsed() < Duration::from_secs(2), "bounded");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );
    assert!(hooks
        .test_hooks()
        .failures()
        .contains(&("claim", Nir1StoreFailure::Fenced)));
}

/// O8: an ambiguous claim COMMIT that is durable is reconciled by the exact
/// reread and starts once under the same entry.
#[test]
fn o8_error_after_commit_is_reconciled_and_starts_once() {
    let fixture = OwnerFixture::new();
    let recorder = AtomicUsize::new(0);
    let prepared = fixture.prepared(0, "o8");
    let id = prepared.attempt_id().to_owned();
    prepared
        .hooks()
        .test_hooks()
        .fail_next("claim", Nir1GenerationFailpoint::ErrorAfterCommit);
    let Nir1TransportDecision::Start(transport) = prepared.claim_for_transport() else {
        panic!("the reconciled own claim starts");
    };
    assert_eq!(
        Some(transport.claimed_at_ms()),
        fixture.attempt(&id).claimed_at_ms
    );
    let terminal = record_send(transport, &recorder, "o8-output");
    assert!(terminal.message_version.is_some());
    assert_eq!(recorder.load(Ordering::SeqCst), 1);
}

/// O8b: an ambiguous own claim never starts under a later entry. If that
/// entry's sweep already terminalized it, the owner reports AlreadySettled.
#[test]
fn o8b_unknown_claim_never_starts_under_a_later_entry() {
    for sweep_first in [false, true] {
        let fixture = Arc::new(OwnerFixture::new());
        let prepared = fixture.prepared(0, "o8b");
        let id = prepared.attempt_id().to_owned();
        let hooks = prepared.hooks();
        hooks
            .test_hooks()
            .fail_next("claim", Nir1GenerationFailpoint::ErrorAfterCommit);
        let probe_fixture = Arc::clone(&fixture);
        let fired = Arc::new(AtomicBool::new(false));
        let probe_fired = Arc::clone(&fired);
        hooks
            .test_hooks()
            .on(Nir1OwnerProbePoint::AfterCommit, move || {
                if !probe_fired.swap(true, Ordering::SeqCst) {
                    probe_fixture.publish_new_ready_entry();
                    if sweep_first {
                        assert!(crate::nir1_generation::sweep_and_open_ready_entry_for_test(
                            &probe_fixture.state
                        ));
                    }
                }
            });
        let settlement = not_started(prepared.claim_for_transport());
        let terminal = fixture.attempt(&id).terminal.expect("terminal");
        if sweep_first {
            assert!(matches!(settlement, Nir1Settlement::AlreadySettled));
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::InterruptedUnknown)
            );
        } else {
            assert!(matches!(settlement, Nir1Settlement::ZeroSend(_)));
            assert_eq!(
                terminal.failure_classification,
                Some(FailureClassification::DispatchUnavailable)
            );
        }
    }
}

/// O9: an unresolvable claim COMMIT quarantines the gate entry; the session
/// stays refused until the next Ready entry's sweep terminalizes the attempt.
#[test]
fn o9_unresolved_claim_quarantines_the_gate_until_the_next_sweep() {
    let fixture = Arc::new(OwnerFixture::new());
    let prepared = fixture.prepared(0, "o9");
    let id = prepared.attempt_id().to_owned();
    let hooks = prepared.hooks();
    hooks
        .test_hooks()
        .fail_next("claim", Nir1GenerationFailpoint::ErrorAfterCommit);
    let held = Arc::new(std::sync::Mutex::new(None));
    let probe_held = Arc::clone(&held);
    let authority = Arc::clone(&fixture.authority);
    hooks
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterCommit, move || {
            let mut held = probe_held.lock().expect("held");
            if held.is_none() {
                *held = Some(hold_connection(&authority));
            }
        });
    let settlement = not_started(prepared.claim_for_transport());
    let (release, holder) = held.lock().expect("held").take().expect("mutex holder");
    assert!(matches!(
        settlement,
        Nir1Settlement::Unresolved {
            ref attempt_id,
            gate_quarantined: true,
        } if *attempt_id == id
    ));
    assert!(hooks
        .test_hooks()
        .failures()
        .contains(&("reread", Nir1StoreFailure::ConnectionBusy)));
    release.send(()).expect("release");
    holder.join().expect("holder");
    assert!(fixture.gate().is_closed());
    let same_session = fixture.accept(0, "o9-next");
    assert_eq!(
        fixture.owner(0, &same_session).err(),
        Some(Nir1GenerationRefusal::GateClosed)
    );
    let other_session = fixture.accept(1, "o9-other");
    assert_eq!(
        fixture.owner(1, &other_session).err(),
        Some(Nir1GenerationRefusal::GateClosed)
    );
    assert_eq!(
        fixture.state.nir1_generation_registry.unresolved_attempts(),
        vec![id.clone()]
    );
    let attempt = fixture.attempt(&id);
    assert!(attempt.claimed_at_ms.is_some() && attempt.terminal.is_none());

    fixture.publish_new_ready_entry();
    assert!(crate::nir1_generation::sweep_and_open_ready_entry_for_test(
        &fixture.state
    ));
    assert_eq!(
        fixture
            .attempt(&id)
            .terminal
            .expect("swept")
            .failure_classification,
        Some(FailureClassification::InterruptedUnknown)
    );
    let same_session = fixture.accept(0, "o9-after-sweep");
    fixture
        .owner(0, &same_session)
        .expect("the session is accepted after the sweep");
}

/// O9b: exhausted zero-send writes leave the slot unresolved but keep the
/// gate Open; other sessions proceed, and the next sweep releases it.
#[test]
fn o9b_exhausted_zero_send_leaves_the_slot_unresolved_without_quarantine() {
    for drop_prepared in [false, true] {
        let fixture = Arc::new(OwnerFixture::new());
        let prepared = fixture.prepared(0, "o9b");
        let id = prepared.attempt_id().to_owned();
        let hooks = prepared.hooks();
        if !drop_prepared {
            let probe_fixture = Arc::clone(&fixture);
            let fired = Arc::new(AtomicBool::new(false));
            let probe_fired = Arc::clone(&fired);
            hooks
                .test_hooks()
                .on(Nir1OwnerProbePoint::AfterCommit, move || {
                    if !probe_fired.swap(true, Ordering::SeqCst) {
                        probe_fixture
                            .state
                            .profile_egress
                            .with_route_update(|| Ok(()))
                            .expect("route update");
                    }
                });
        }
        let held = Arc::new(std::sync::Mutex::new(None));
        let probe_held = Arc::clone(&held);
        let authority = Arc::clone(&fixture.authority);
        hooks
            .test_hooks()
            .on(Nir1OwnerProbePoint::BeforeZeroSend, move || {
                let mut held = probe_held.lock().expect("held");
                if held.is_none() {
                    *held = Some(hold_connection(&authority));
                }
            });
        if drop_prepared {
            drop(prepared);
        } else {
            assert!(matches!(
                not_started(prepared.claim_for_transport()),
                Nir1Settlement::Unresolved {
                    ref attempt_id,
                    gate_quarantined: false,
                } if *attempt_id == id
            ));
        }
        let (release, holder) = held.lock().expect("held").take().expect("mutex holder");
        release.send(()).expect("release");
        holder.join().expect("holder");
        let busy = hooks
            .test_hooks()
            .failures()
            .iter()
            .filter(|failure| **failure == ("zero-send", Nir1StoreFailure::ConnectionBusy))
            .count();
        assert_eq!(busy, NIR1_ZERO_SEND_TERMINAL_ATTEMPTS);
        assert!(!fixture.gate().is_closed(), "the gate stays Open");
        assert!(fixture.attempt(&id).terminal.is_none());
        let same_session = fixture.accept(0, "o9b-next");
        assert_eq!(
            fixture.owner(0, &same_session).err(),
            Some(Nir1GenerationRefusal::SessionUnresolved {
                attempt_id: id.clone()
            })
        );
        let other_session = fixture.accept(1, "o9b-other");
        drop(
            fixture
                .owner(1, &other_session)
                .expect("another session proceeds"),
        );

        fixture.publish_new_ready_entry();
        assert!(crate::nir1_generation::sweep_and_open_ready_entry_for_test(
            &fixture.state
        ));
        assert_eq!(
            fixture
                .attempt(&id)
                .terminal
                .expect("swept")
                .failure_classification,
            Some(FailureClassification::InterruptedUnknown)
        );
        fixture
            .owner(0, &same_session)
            .expect("the session is accepted after the sweep");
    }
}

/// O10: bounded owner operations fail typed, then the connection is reused.
#[test]
fn o10_owner_operations_fail_typed_and_the_connection_is_reused() {
    let fixture = OwnerFixture::new();
    let submission = fixture.accept(0, "o10");
    let owner = fixture.owner(0, &submission).expect("owner");
    // The request carries a Scene binding read from the database, so it is
    // built before the connection mutex is held.
    let request = fixture.request(&owner, &submission);
    let (release, holder) = hold_connection(&fixture.authority);
    let started = Instant::now();
    assert_eq!(
        owner.create(request).err(),
        Some(Nir1GenerationRefusal::Store(
            Nir1StoreFailure::ConnectionBusy
        ))
    );
    assert!(started.elapsed() < storage::NIR1_GENERATION_OPERATION_LIMIT);
    release.send(()).expect("release");
    holder.join().expect("holder");

    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TABLE owner_slow_insert(x INTEGER);
                 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400)
                 INSERT INTO owner_slow_insert SELECT x FROM c;
                 CREATE TEMP TRIGGER owner_slow_attempt AFTER INSERT ON nir1_generation_attempts
                 BEGIN SELECT count(*) FROM owner_slow_insert a, owner_slow_insert b,
                 owner_slow_insert c; END;",
            )?;
            Ok(())
        })
        .expect("slow insert trigger");
    let owner = fixture.owner(0, &submission).expect("owner");
    let request = fixture.request(&owner, &submission);
    assert_eq!(
        owner.create(request).err(),
        Some(Nir1GenerationRefusal::Store(Nir1StoreFailure::TimedOut))
    );
    assert_eq!(fixture.attempt_count(), 0);
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER owner_slow_attempt")?;
            Ok(())
        })
        .expect("drop trigger");
    let owner = fixture.owner(0, &submission).expect("owner");
    let request = fixture.request(&owner, &submission);
    let prepared = owner.create(request).expect("the connection is reused");
    assert!(fixture.authority.db().connection_reusable());
    drop(prepared);
}

/// O11 (#628): a transient maintenance release changes no lease, gate or
/// slot; and a running maintenance acquisition yields to the owner's write
/// without the workspace leaving Ready.
#[test]
fn o11_transient_maintenance_release_and_owner_writes_coexist() {
    let fixture = Arc::new(OwnerFixture::new());
    let recorder = AtomicUsize::new(0);
    let prepared = fixture.prepared(0, "o11");
    let probe_fixture = Arc::clone(&fixture);
    let fired = Arc::new(AtomicBool::new(false));
    let probe_fired = Arc::clone(&fired);
    prepared
        .hooks()
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterCommit, move || {
            if probe_fired.swap(true, Ordering::SeqCst) {
                return;
            }
            let mut permit = match probe_fixture
                .state
                .ws
                .lifecycle_core()
                .admit_maintenance_permit()
                .expect("maintenance")
            {
                grimodex_db::PermitAdmission::Admitted(permit) => permit,
                grimodex_db::PermitAdmission::NotAdmitted { reason, .. } => panic!("{reason:?}"),
            };
            permit.start().expect("start");
            permit.mark_joined().expect("join");
            permit.release().expect("transient release");
        });
    let Nir1TransportDecision::Start(transport) = prepared.claim_for_transport() else {
        panic!("the owner completes across a transient maintenance release");
    };
    assert!(!transport.should_stop());
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 1);
    record_send(transport, &recorder, "o11-output");
    assert_eq!(recorder.load(Ordering::SeqCst), 1);

    let prepared = fixture.prepared(1, "o11-foreground");
    let (release, holder) = hold_connection(&fixture.authority);
    let owner = thread::spawn(move || prepared.claim_for_transport());
    wait_for(
        || fixture.authority.db().foreground_connection_waiter_count() == 1,
        "the owner to wait as a foreground writer",
    );
    let maintenance_db = Arc::clone(&fixture.authority);
    let preempted = thread::spawn(move || {
        let _no_wait = maintenance_db.db().enter_maintenance_connection_no_wait();
        maintenance_db
            .db()
            .with_conn(|_| Ok(()))
            .expect_err("maintenance yields to the foreground owner")
            .to_string()
    })
    .join()
    .expect("maintenance attempt");
    assert!(preempted.contains("NEX_MAINTENANCE_CONNECTION_PREEMPTED"));
    release.send(()).expect("release");
    holder.join().expect("holder");
    let Nir1TransportDecision::Start(transport) = owner.join().expect("owner") else {
        panic!("the owner starts after the mutex is released");
    };
    record_send(transport, &recorder, "o11-foreground-output");
    assert!(matches!(
        fixture
            .state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("Core")
            .state,
        LifecycleState::Ready(_)
    ));
}

/// O8c: an ambiguous create COMMIT is reconciled by the exact reread, or,
/// when the reread fails too, quarantines the gate entry and the session.
#[test]
fn o8c_unknown_create_is_reconciled_or_quarantined() {
    let fixture = Arc::new(OwnerFixture::new());
    let recorder = AtomicUsize::new(0);
    let submission = fixture.accept(0, "o8c");
    let owner = fixture.owner(0, &submission).expect("owner");
    owner
        .hooks()
        .test_hooks()
        .fail_next("create", Nir1GenerationFailpoint::ErrorAfterCommit);
    let request = fixture.request(&owner, &submission);
    let prepared = owner
        .create(request)
        .expect("the durable create is reconciled");
    let Nir1TransportDecision::Start(transport) = prepared.claim_for_transport() else {
        panic!("starts");
    };
    record_send(transport, &recorder, "o8c-output");

    let submission = fixture.accept(1, "o8c-unresolved");
    let owner = fixture.owner(1, &submission).expect("owner");
    let id = owner.attempt_id().to_owned();
    let hooks = owner.hooks();
    hooks
        .test_hooks()
        .fail_next("create", Nir1GenerationFailpoint::ErrorAfterCommit);
    let held = Arc::new(std::sync::Mutex::new(None));
    let probe_held = Arc::clone(&held);
    let authority = Arc::clone(&fixture.authority);
    hooks
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterCommit, move || {
            let mut held = probe_held.lock().expect("held");
            if held.is_none() {
                *held = Some(hold_connection(&authority));
            }
        });
    let request = fixture.request(&owner, &submission);
    assert_eq!(
        owner.create(request).err(),
        Some(Nir1GenerationRefusal::Unresolved {
            attempt_id: id.clone()
        })
    );
    let (release, holder) = held.lock().expect("held").take().expect("mutex holder");
    release.send(()).expect("release");
    holder.join().expect("holder");
    assert!(fixture.gate().is_closed(), "the entry is quarantined");
    assert_eq!(
        fixture.state.nir1_generation_registry.unresolved_attempts(),
        vec![id.clone()]
    );
    fixture.publish_new_ready_entry();
    assert!(crate::nir1_generation::sweep_and_open_ready_entry_for_test(
        &fixture.state
    ));
    assert_eq!(
        fixture
            .attempt(&id)
            .terminal
            .expect("swept")
            .failure_classification,
        Some(FailureClassification::InterruptedUnknown)
    );
    assert_eq!(recorder.load(Ordering::SeqCst), 1);
}

/// O12: dropped owners settle exactly once and never resend.
#[test]
fn o12_dropped_owners_settle_exactly_once_without_resend() {
    let fixture = OwnerFixture::new();
    let submission = fixture.accept(2, "o12-cancelled-before-create");
    let owner = fixture.owner(2, &submission).expect("owner");
    owner.cancel_handle().cancel();
    let request = fixture.request(&owner, &submission);
    assert_eq!(
        owner.create(request).err(),
        Some(Nir1GenerationRefusal::Cancelled)
    );
    let abandoned = fixture.prepared(2, "o12-abandoned");
    let abandoned_id = abandoned.attempt_id().to_owned();
    let Nir1Settlement::ZeroSend(terminal) = abandoned.abandon() else {
        panic!("abandon writes the zero-send terminal");
    };
    assert_eq!(terminal.attempt_id, abandoned_id);
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );

    let prepared = fixture.prepared(0, "o12-prepared");
    let expected = prepared.expected();
    drop(prepared);
    let terminal = fixture.attempt(&expected.id).terminal.expect("zero-send");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );

    let prepared = fixture.prepared(1, "o12-transport");
    let expected = prepared.expected();
    let Nir1TransportDecision::Start(transport) = prepared.claim_for_transport() else {
        panic!("starts");
    };
    drop(transport);
    let terminal = fixture.attempt(&expected.id).terminal.expect("recovered");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::InterruptedUnknown)
    );
    let workspace = active_workspace_snapshot(&fixture.state.ws).expect("workspace");
    assert_eq!(
        storage::claim_attempt_bounded(
            &workspace,
            &expected,
            &fixture.admission_budget(),
            &mut || Ok(()),
        )
        .expect("no resend"),
        Nir1ClaimOutcome::AlreadyTerminal
    );
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
}

/// O13: after a restart the sweep terminalizes the claimed attempt and the
/// old submission is refused at capture; no new attempt is created.
#[test]
fn o13_restart_terminalizes_and_never_reaccepts_the_old_submission() {
    let first = OwnerFixture::new();
    let submission = first.accept(0, "o13");
    let owner = first.owner(0, &submission).expect("owner");
    let request = first.request(&owner, &submission);
    let id = owner.attempt_id().to_owned();
    let Nir1TransportDecision::Start(transport) =
        owner.create(request).expect("create").claim_for_transport()
    else {
        panic!("starts before the crash");
    };

    let restarted = OwnerFixture::open(first.root.clone(), "restarted-app", false);
    let terminal = restarted.attempt(&id).terminal.expect("swept on Ready");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::InterruptedUnknown)
    );
    let resend = NewChatInputSubmission::new(
        "owner-submission-o13".into(),
        "owner-message-o13".into(),
        SESSIONS[0].into(),
        SCENE.into(),
        "Human turn o13".into(),
        "2026-10-13T00:00:00.000Z".into(),
    )
    .expect("submission");
    let refused = accept_current_chat_submission(
        Arc::clone(&restarted.state),
        restarted.callers[0].clone(),
        &resend,
    )
    .err()
    .expect("the old submission is not accepted again");
    assert!(refused
        .to_string()
        .contains("NIR1_CHAT_CAPTURE_IDEMPOTENCY_CONFLICT"));
    // The old process's late cleanup finds the terminal and writes nothing.
    drop(transport);
    assert_eq!(restarted.attempt(&id).terminal, Some(terminal));
    assert_eq!(restarted.attempt_count(), 1);
    drop(restarted);
}

fn start_loopback_owner(fixture: &OwnerFixture, key: &str) -> Nir1TransportOwner {
    match fixture.prepared(0, key).claim_for_transport() {
        Nir1TransportDecision::Start(transport) => transport,
        Nir1TransportDecision::NotStarted(settlement) => panic!("{settlement:?}"),
    }
}

/// O14: the exact canonical body is sent once and its observation commits
/// one body, version and receipt.
#[test]
fn o14_loopback_commits_exact_body_version_and_receipt_once() {
    let fixture = OwnerFixture::new();
    let listener = loopback::listener().expect("loopback listener");
    let transport = start_loopback_owner(&fixture, "o14-success");
    let id = transport.attempt_id().to_owned();
    let expected_payload = transport.canonical_payload().to_owned();
    let text = "  本文 e\u{301}🙂\n";
    let thinking = " 推敲中🙂 \n";
    let expected_text = text.as_bytes().to_vec();
    let expected_thinking = thinking.as_bytes().to_vec();
    let response = thread::scope(|scope| -> anyhow::Result<loopback::Response> {
        let peer = scope.spawn(|| -> anyhow::Result<()> {
            let mut stream = loopback::accept(&listener)?;
            assert_eq!(
                loopback::read_request(&mut stream)?,
                expected_payload.as_bytes(),
                "loopback body is the exact canonical payload"
            );
            loopback::write_response(&mut stream, &expected_text, &expected_thinking, 1)?;
            Ok(())
        });
        let mut client = loopback::connect(&listener)?;
        loopback::send_request(&mut client, expected_payload.as_bytes())?;
        let response = loopback::read_response(&mut client)?;
        peer.join().expect("peer thread")?;
        loopback::assert_no_pending_connection(&listener)?;
        Ok(response)
    })
    .expect("bounded success fixture");
    assert!(response.saw_terminal && response.peer_closed);
    assert_eq!(
        response.observation.terminal_status,
        TerminalStatus::Succeeded
    );
    assert_eq!(response.observation.parse_status, ParseStatus::Parsed);
    let body = NewMessageBody {
        message_id: "o14-generated-output".into(),
        content: String::from_utf8(response.text).expect("strict text UTF-8"),
        thinking: String::from_utf8(response.thinking).expect("strict thinking UTF-8"),
    };
    let terminal = transport
        .finish(&response.observation, Some(body))
        .expect("terminal");
    let version = terminal.message_version.as_ref().expect("body version");
    assert_eq!(version.message_id, "o14-generated-output");
    assert_eq!(version.parent_attempt_id.as_deref(), Some(id.as_str()));
    assert_eq!(fixture.attempt(&id).terminal, Some(terminal));
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            let (saved_text, metadata): (String, Option<String>) = conn.query_row(
                "SELECT content,metadata FROM chat_messages WHERE id='o14-generated-output'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(saved_text, text);
            let saved: Value = serde_json::from_str(metadata.as_deref().expect("thinking"))?;
            assert_eq!(saved["thinking_blocks"][0]["thinking"], thinking);
            Ok(())
        })
        .expect("saved body");
}

/// O14: invalid UTF-8 or a missing provider terminal never publishes a body.
#[test]
fn o14_loopback_invalid_output_and_eof_never_publish_a_body() {
    for (key, text, thinking, terminal_frame) in [
        (
            "o14-invalid-utf8",
            vec![0xf0, 0x28, 0x8c, 0x28],
            vec![0xf0, 0x28, 0x8c, 0x28],
            true,
        ),
        (
            "o14-eof",
            b"valid text".to_vec(),
            b"valid thinking".to_vec(),
            false,
        ),
    ] {
        let fixture = OwnerFixture::new();
        let listener = loopback::listener().expect("loopback listener");
        let transport = start_loopback_owner(&fixture, key);
        let expected_payload = transport.canonical_payload().to_owned();
        let response = thread::scope(|scope| -> anyhow::Result<loopback::Response> {
            let peer = scope.spawn(|| -> anyhow::Result<()> {
                let mut stream = loopback::accept(&listener)?;
                assert_eq!(
                    loopback::read_request(&mut stream)?,
                    expected_payload.as_bytes()
                );
                if terminal_frame {
                    loopback::write_response(&mut stream, &text, &thinking, 1)?;
                } else {
                    loopback::write_output(&mut stream, &text, &thinking)?;
                }
                Ok(())
            });
            let mut client = loopback::connect(&listener)?;
            loopback::send_request(&mut client, expected_payload.as_bytes())?;
            let response = loopback::read_response(&mut client)?;
            peer.join().expect("peer thread")?;
            loopback::assert_no_pending_connection(&listener)?;
            Ok(response)
        })
        .expect("bounded fixture");
        assert_eq!(response.saw_terminal, terminal_frame, "{key}");
        assert_eq!(response.observation.terminal_status, TerminalStatus::Failed);
        assert_eq!(response.observation.parse_status, ParseStatus::Invalid);
        let terminal = transport
            .finish(&response.observation, None)
            .expect("failure terminal");
        assert!(terminal.message_version.is_none(), "{key}");
        assert_eq!(
            terminal.failure_classification,
            Some(FailureClassification::InvalidOutput),
            "{key}"
        );
    }
}

/// O14: cancel after the start decision is the transport's to observe; the
/// peer sees the close, and the old attempt is never claimed again.
#[test]
fn o14_loopback_cancel_after_start_closes_the_peer_and_never_reuses_the_attempt() {
    let fixture = OwnerFixture::new();
    let listener = loopback::listener().expect("loopback listener");
    let transport = start_loopback_owner(&fixture, "o14-cancel");
    let id = transport.attempt_id().to_owned();
    let cancel = transport.cancel_handle();
    let expected_payload = transport.canonical_payload().to_owned();
    let accepted = AtomicUsize::new(0);
    let (request_tx, request_rx) = mpsc::channel();
    let (closed_tx, closed_rx) = mpsc::channel();
    thread::scope(|scope| -> anyhow::Result<()> {
        let peer = scope.spawn(|| -> anyhow::Result<()> {
            let mut stream = loopback::accept(&listener)?;
            accepted.fetch_add(1, Ordering::SeqCst);
            request_tx
                .send(loopback::read_request(&mut stream)?)
                .expect("peer-observed request");
            loopback::wait_for_peer_close(&mut stream)?;
            closed_tx.send(()).expect("peer close");
            Ok(())
        });
        let mut client = loopback::connect(&listener)?;
        loopback::send_request(&mut client, expected_payload.as_bytes())?;
        assert_eq!(
            request_rx.recv_timeout(loopback::IO_TIMEOUT)?,
            expected_payload.as_bytes()
        );
        assert!(!transport.should_stop());
        cancel.cancel();
        // The (test) transport observes the stop and closes the connection.
        assert!(transport.should_stop());
        client.shutdown(std::net::Shutdown::Both)?;
        closed_rx.recv_timeout(loopback::IO_TIMEOUT)?;
        peer.join().expect("peer thread")?;
        loopback::assert_no_pending_connection(&listener)?;
        Ok(())
    })
    .expect("bounded cancellation fixture");
    let terminal = transport
        .finish(&OutputObserver::new().finish(Completion::Cancelled), None)
        .expect("cancelled terminal");
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::Cancelled)
    );
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
    let workspace = active_workspace_snapshot(&fixture.state.ws).expect("workspace");
    let expected = Nir1ExpectedAttempt::from_stored(&fixture.attempt(&id), READ_BUDGET);
    assert_eq!(
        storage::claim_attempt_bounded(
            &workspace,
            &expected,
            &fixture.admission_budget(),
            &mut || Ok(()),
        )
        .expect("terminal claim"),
        Nir1ClaimOutcome::AlreadyTerminal
    );
}

/// O15 (registry): the session bound counts in-flight and unresolved slots
/// and is checked after the same-key refusals but before any allocation: a
/// refused 17th session gets no slot and no token. An unresolved slot stops
/// counting only once a later Open entry prunes it.
#[test]
fn o15_registry_checks_the_session_bound_before_allocation() {
    let registry = Nir1GenerationRegistry::default();
    let binding = LiveBinding::new("/o15-registry", "o15-workspace", 1, 1);
    let reserve = |index: usize, submission: &str, open_entry_epoch: Option<u64>| {
        registry.reserve(
            Nir1SessionKey {
                binding: binding.clone(),
                project_id: PROJECT.into(),
                chat_session_id: format!("o15-session-{index:02}"),
            },
            submission,
            &format!("o15-attempt-{index:02}"),
            open_entry_epoch,
        )
    };
    let next_token = || registry.inner.lock().expect("registry").next_token;
    let mut held = (0..NIR1_GENERATION_MAX_TRACKED_SESSIONS)
        .map(|index| {
            reserve(index, &format!("o15-submission-{index:02}"), None).expect("within the bound")
        })
        .collect::<Vec<_>>();
    let seventeenth = NIR1_GENERATION_MAX_TRACKED_SESSIONS;
    let token = next_token();
    assert_eq!(
        reserve(seventeenth, "o15-submission-16", None).err(),
        Some(Nir1GenerationRefusal::InFlightCapacity)
    );
    assert_eq!(
        registry.tracked_sessions(),
        NIR1_GENERATION_MAX_TRACKED_SESSIONS,
        "no slot was allocated"
    );
    assert_eq!(next_token(), token, "no token was allocated");
    // Same-key refusals are decided before the bound.
    assert_eq!(
        reserve(0, "o15-submission-00", None).err(),
        Some(Nir1GenerationRefusal::SameSubmissionInFlight {
            attempt_id: "o15-attempt-00".into()
        })
    );
    assert_eq!(
        reserve(0, "o15-another-submission", None).err(),
        Some(Nir1GenerationRefusal::SessionBusy)
    );
    // An unresolved slot counts until an Open entry after its epoch.
    held.pop().expect("slot").mark_unresolved(7);
    assert_eq!(
        reserve(seventeenth, "o15-submission-16", Some(7)).err(),
        Some(Nir1GenerationRefusal::InFlightCapacity)
    );
    let admitted = reserve(seventeenth, "o15-submission-16", Some(8))
        .expect("the unresolved slot is pruned before the bound");
    assert!(registry.unresolved_attempts().is_empty());
    assert_eq!(
        registry.tracked_sessions(),
        NIR1_GENERATION_MAX_TRACKED_SESSIONS
    );
    // A released in-flight slot admits another session.
    drop(held.pop());
    let another =
        reserve(seventeenth + 1, "o15-submission-17", None).expect("a released slot admits it");
    drop(held);
    drop(admitted);
    drop(another);
    assert_eq!(registry.tracked_sessions(), 0);
}

/// O15: the 17th tracked chat session is refused at capture with
/// `InFlightCapacity`; the refused capture keeps no slot, participant,
/// workspace operation or lease. A released slot admits the session.
#[test]
fn o15_the_seventeenth_session_capture_is_refused_and_keeps_nothing() {
    let fixture = OwnerFixture::new();
    let callers = fixture
        .callers
        .iter()
        .cloned()
        .zip(SESSIONS.iter().map(|session| (*session).to_owned()))
        .chain(
            (fixture.callers.len()..=NIR1_GENERATION_MAX_TRACKED_SESSIONS)
                .map(|index| fixture.add_session(index)),
        )
        .collect::<Vec<_>>();
    assert_eq!(callers.len(), NIR1_GENERATION_MAX_TRACKED_SESSIONS + 1);
    let submissions = callers
        .iter()
        .enumerate()
        .map(|(index, (caller, chat_session))| {
            fixture.accept_as(caller, chat_session, &format!("o15-{index:02}"))
        })
        .collect::<Vec<_>>();
    let capture = |index: usize| {
        Nir1GenerationOwner::capture(
            Arc::clone(&fixture.state),
            callers[index].0.clone(),
            &submissions[index],
        )
    };
    let mut owners = (0..NIR1_GENERATION_MAX_TRACKED_SESSIONS)
        .map(|index| capture(index).expect("within the bound"))
        .collect::<Vec<_>>();
    let core = fixture.state.ws.lifecycle_core();
    let participants = core.workspace_participant_count().expect("participants");
    let operations = || {
        fixture
            .state
            .workspace_operation_active
            .load(Ordering::Acquire)
    };
    let active_operations = operations();
    let seventeenth = NIR1_GENERATION_MAX_TRACKED_SESSIONS;
    assert_eq!(
        capture(seventeenth).err(),
        Some(Nir1GenerationRefusal::InFlightCapacity)
    );
    assert_eq!(
        fixture.state.nir1_generation_registry.tracked_sessions(),
        NIR1_GENERATION_MAX_TRACKED_SESSIONS
    );
    assert_eq!(
        core.workspace_participant_count().expect("participants"),
        participants
    );
    assert_eq!(operations(), active_operations);
    assert_eq!(fixture.gate().active_lease_count(), 0);
    drop(owners.pop());
    let admitted = capture(seventeenth).expect("a released slot admits the session");
    assert_eq!(
        fixture.state.nir1_generation_registry.tracked_sessions(),
        NIR1_GENERATION_MAX_TRACKED_SESSIONS
    );
    drop(admitted);
    drop(owners);
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
}

/// O16: an owner serves only its own capture. A request for another project,
/// chat session or Scene is refused at create (`SubmissionMismatch`). Another
/// registered caller passes capture, but the store's capture-owner check
/// refuses its create: for a different caller, and also for the same caller
/// reached through another Main sender with its own session (DT-3: the Main
/// caller session is part of the process-local caller binding, never the chat
/// session). No refusal writes an attempt or keeps a slot.
#[test]
fn o16_create_refuses_another_project_session_scene_or_caller() {
    let fixture = OwnerFixture::new();
    let submission = fixture.accept(0, "o16");
    let core = fixture.state.ws.lifecycle_core();
    let participants = core.workspace_participant_count().expect("participants");

    type Tamper = fn(&mut FinalDispatchRequest);
    let tampers: [(&str, Tamper); 3] = [
        ("project", |request| {
            request.project_id = "another-project".into()
        }),
        ("chat session", |request| {
            request.chat_session_id = SESSIONS[1].into()
        }),
        ("scene", |request| {
            request.scene.scene_id = "another-scene".into()
        }),
    ];
    for (name, tamper) in tampers {
        let owner = fixture.owner(0, &submission).expect("owner");
        let mut request = fixture.request(&owner, &submission);
        tamper(&mut request);
        assert_eq!(
            owner.create(request).err(),
            Some(Nir1GenerationRefusal::SubmissionMismatch),
            "{name}"
        );
        assert_eq!(fixture.attempt_count(), 0, "{name}");
        assert_eq!(
            fixture.state.nir1_generation_registry.tracked_sessions(),
            0,
            "{name}"
        );
    }

    let another_caller = CallerIdentity {
        caller_id: "owner-caller-second".into(),
        sender_id: 99,
        ..fixture.callers[0].clone()
    };
    let another_main_session = CallerIdentity {
        sender_id: 98,
        session_id: uuid::Uuid::new_v4().to_string(),
        ..fixture.callers[0].clone()
    };
    assert_ne!(
        another_main_session.session_id,
        fixture.callers[0].session_id
    );
    for (name, caller) in [
        ("another caller", another_caller),
        (
            "another Main session of the same caller",
            another_main_session,
        ),
    ] {
        fixture
            .state
            .profile_egress
            .register_caller(&caller)
            .expect(name);
        let owner = Nir1GenerationOwner::capture(Arc::clone(&fixture.state), caller, &submission)
            .expect("the capture itself is not caller-checked by the owner");
        let request = fixture.request(&owner, &submission);
        assert_eq!(
            owner.create(request).err(),
            Some(Nir1GenerationRefusal::Store(Nir1StoreFailure::Conflict)),
            "{name}"
        );
        assert_eq!(fixture.attempt_count(), 0, "{name}");
        assert_eq!(
            fixture.state.nir1_generation_registry.tracked_sessions(),
            0,
            "{name}"
        );
    }
    assert_eq!(
        core.workspace_participant_count().expect("participants"),
        participants
    );
    assert_eq!(fixture.gate().active_lease_count(), 0);

    // The capture owner's own caller still creates the one attempt.
    let owner = fixture.owner(0, &submission).expect("owner");
    let request = fixture.request(&owner, &submission);
    let prepared = owner.create(request).expect("the owner's caller creates");
    assert!(matches!(prepared.abandon(), Nir1Settlement::ZeroSend(_)));
    assert_eq!(fixture.attempt_count(), 1);
}

/// O17: an unknown create COMMIT that the exact reread resolves to a
/// confirmed absence is refused like a NotCommitted create. A cancel seen by
/// the fence recheck after the pre-commit checks (before COMMIT) is
/// `Cancelled`, not a store failure. Nothing is durable, the slot is
/// released, and the submission's one attempt can still be created.
#[test]
fn o17_unknown_create_resolved_absent_is_refused_like_not_committed() {
    let fixture = OwnerFixture::new();
    let submission = fixture.accept(0, "o17");
    let owner = fixture.owner(0, &submission).expect("owner");
    let cancel = owner.cancel_handle();
    let hooks = owner.hooks();
    hooks
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterPreCommit, move || cancel.cancel());
    let reread = Arc::new(AtomicBool::new(false));
    let probe_reread = Arc::clone(&reread);
    hooks
        .test_hooks()
        .on(Nir1OwnerProbePoint::AfterCommit, move || {
            probe_reread.store(true, Ordering::SeqCst);
        });
    let request = fixture.request(&owner, &submission);
    assert_eq!(
        owner.create(request).err(),
        Some(Nir1GenerationRefusal::Cancelled)
    );
    assert!(
        reread.load(Ordering::SeqCst),
        "the COMMIT outcome was unknown and the exact reread ran"
    );
    assert!(hooks
        .test_hooks()
        .failures()
        .contains(&("create", Nir1StoreFailure::Cancelled)));
    assert_eq!(fixture.attempt_count(), 0);
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
    // One mapping serves both paths. NotCurrent cannot arise after the
    // operation today, so the shared mapping pins it directly.
    for (failure, refusal) in [
        (
            Nir1StoreFailure::NotCurrent,
            Nir1GenerationRefusal::SubmissionNotCurrent,
        ),
        (
            Nir1StoreFailure::Cancelled,
            Nir1GenerationRefusal::Cancelled,
        ),
        (
            Nir1StoreFailure::Conflict,
            Nir1GenerationRefusal::Store(Nir1StoreFailure::Conflict),
        ),
    ] {
        assert_eq!(create_refusal(failure), refusal);
    }
    let owner = fixture.owner(0, &submission).expect("a fresh owner");
    let request = fixture.request(&owner, &submission);
    let prepared = owner.create(request).expect("the submission's one attempt");
    assert!(matches!(prepared.abandon(), Nir1Settlement::ZeroSend(_)));
    assert_eq!(fixture.attempt_count(), 1);
}

/// S4 (DT-3): Main issues one random `sessionId` per sender
/// (electron/main/profileEgress.ts:648). It is a process-local caller binding
/// and never a `chat_sessions` row, so the attempt binds the DB-validated chat
/// session separately from the Main caller session, and the same owner claims
/// and starts it.
#[test]
fn s4_production_caller_session_binds_chat_session_separately() {
    let fixture = OwnerFixture::new();
    let caller = fixture.callers[0].clone();
    assert!(
        uuid::Uuid::parse_str(&caller.session_id).is_ok() && caller.session_id != SESSIONS[0],
        "the fixture caller has a Main-shaped session, not a chat session"
    );
    let recorder = AtomicUsize::new(0);
    let submission = fixture.accept(0, "s4");
    let owner = fixture.owner(0, &submission).expect("owner");
    let request = fixture.request(&owner, &submission);
    let prepared = owner
        .create(request)
        .expect("a Main caller session is not validated as a chat session");
    let stored = fixture.attempt(prepared.attempt_id());
    assert_eq!(stored.binding.chat_session_id, SESSIONS[0]);
    assert_eq!(stored.binding.caller.caller_session_id, caller.session_id);
    assert_eq!(stored.binding.scene.scene_id, SCENE);
    let column: String = fixture
        .authority
        .db()
        .with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT session_id FROM nir1_generation_attempts WHERE id=?1",
                [prepared.attempt_id()],
                |row| row.get(0),
            )?)
        })
        .expect("stored chat session");
    assert_eq!(column, SESSIONS[0], "the row keeps the DB chat session");
    let Nir1TransportDecision::Start(transport) = prepared.claim_for_transport() else {
        panic!("the owner that persisted the request claims it");
    };
    record_send(transport, &recorder, "s4-output");
    assert_eq!(recorder.load(Ordering::SeqCst), 1);
}

/// DT-3: the claim re-reads the Scene in its own transaction. A Scene that was
/// deleted and recreated between create and claim is a new incarnation, so
/// the claim is refused before COMMIT (the store tests cover the restore
/// paths in which the token repeats as well); the owner writes its one
/// zero-send terminal (the pinned writer needs no current Scene) and nothing
/// is sent.
#[test]
fn dt3_scene_replaced_between_create_and_claim_writes_one_zero_send() {
    let fixture = OwnerFixture::new();
    let prepared = fixture.prepared(0, "dt3-aba");
    let id = prepared.attempt_id().to_owned();
    let hooks = prepared.hooks();
    let before = fixture.attempt(&id).binding.scene;
    fixture.replace_scene("aba");
    let after = fixture.scene_binding();
    assert_ne!(
        after.scene_incarnation_id, before.scene_incarnation_id,
        "the Native A1 writer minted a new incarnation"
    );
    let terminal = zero_send(prepared.claim_for_transport());
    assert_eq!(terminal.attempt_id, id);
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );
    let stored = fixture.attempt(&id);
    assert!(stored.claimed_at_ms.is_none(), "no claim reached COMMIT");
    assert_eq!(stored.terminal, Some(terminal));
    assert!(
        hooks
            .test_hooks()
            .failures()
            .iter()
            .any(|(stage, _)| *stage == "claim"),
        "the claim writer refused"
    );
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);
}

/// DT-3: a Scene snapshot that is no longer the stored Scene is refused at
/// create in the create transaction. Nothing is durable and the slot is
/// released; a fresh snapshot creates the submission's one attempt.
#[test]
fn dt3_stale_scene_snapshot_is_refused_at_create() {
    let fixture = OwnerFixture::new();
    let submission = fixture.accept(0, "dt3-stale");
    let owner = fixture.owner(0, &submission).expect("owner");
    let stale = fixture.request(&owner, &submission);
    fixture.edit_scene_body_in_place();
    assert!(matches!(
        owner.create(stale).err(),
        Some(Nir1GenerationRefusal::Store(_))
    ));
    assert_eq!(fixture.attempt_count(), 0);
    assert_eq!(fixture.state.nir1_generation_registry.tracked_sessions(), 0);

    let owner = fixture.owner(0, &submission).expect("a fresh owner");
    let request = fixture.request(&owner, &submission);
    let prepared = owner.create(request).expect("a fresh snapshot creates");
    assert!(matches!(prepared.abandon(), Nir1Settlement::ZeroSend(_)));
    assert_eq!(fixture.attempt_count(), 1);
}

/// DT-3: the process-local part of the stored binding must be this owner's
/// live caller (with its Main session). An owner whose caller registration no
/// longer matches the attempt does not claim it; it writes the zero-send
/// terminal and nothing is sent.
#[test]
fn dt3_owner_does_not_claim_a_binding_that_is_not_its_own() {
    let fixture = OwnerFixture::new();
    let mut prepared = fixture.prepared(0, "dt3-foreign");
    let id = prepared.attempt_id().to_owned();
    prepared
        .inner
        .as_mut()
        .expect("prepared")
        .core
        .caller
        .session_id = uuid::Uuid::new_v4().to_string();
    let terminal = zero_send(prepared.claim_for_transport());
    assert_eq!(
        terminal.failure_classification,
        Some(FailureClassification::DispatchUnavailable)
    );
    let stored = fixture.attempt(&id);
    assert!(
        stored.claimed_at_ms.is_none(),
        "the foreign owner never claimed"
    );
    assert_eq!(stored.terminal, Some(terminal));
}

/// A-1: no N-API attribute reaches the owner module.
#[test]
fn a1_owner_has_no_napi_entry() {
    let source = include_str!("nir1_generation_owner.rs");
    assert!(!source.contains(&format!("#[{}", "napi")));
}
