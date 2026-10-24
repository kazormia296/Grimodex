//! CP-2a product-owner tests. A fake worker drives the owner state machine;
//! the real worker's process and DTO lifecycle is tested in grimodex-db.
use super::*;

use grimodex_db::narrative_extraction::nir1_graph::{
    c_query_worker::CQueryWorkerUnavailable, worker_frame::UnavailableReason, Nir1QualifiedGraph,
};
use grimodex_db::workspace_lifecycle::{LifecycleError, MAX_LIFECYCLE_OBSERVERS};
use grimodex_db::workspace_lifecycle::{AdmissionKind, AdmissionOutcome};
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;

const PROJECT: &str = "product-project";
const SCENE: &str = "product-scene";

fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(1));
    }
}

fn fast_config() -> GraphOwnerConfig {
    GraphOwnerConfig {
        idle_retire_after: Duration::from_millis(300),
        rebuild_min_interval: Duration::from_millis(30),
        failure_backoff_initial: Duration::from_millis(20),
        failure_backoff_max: Duration::from_millis(80),
        failures_before_suspend: 5,
        cache_ttl: Duration::from_millis(200),
    }
}

fn product_workspace_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("nir1-graph-product-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
    std::fs::write(
        root.join(".grimodex/workspace.json"),
        r#"{"id":"graph-product-workspace"}"#,
    )
    .expect("workspace metadata");
    let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
    db.migrate().expect("schema");
    db.with_conn(|conn| {
        conn.execute("INSERT INTO projects(id,title) VALUES (?1,'Graph')", [PROJECT])?;
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES (?1, ?2, 'scene', 'Scene', '')",
            [SCENE, PROJECT],
        )?;
        Ok(())
    })
    .expect("workspace rows");
    root
}

#[derive(Clone, Copy, Default)]
enum PrepareMode {
    #[default]
    Ok,
    Fail(&'static str),
    Hold,
}

#[derive(Clone, Copy, Default)]
enum QueryMode {
    #[default]
    Ok,
    Unavailable(UnavailableReason),
    Fail(&'static str),
    Hold,
    Panic,
    QuarantineFence,
    QuarantineParticipant,
    OkThenQuarantine,
}

#[derive(Default)]
struct FakePlan {
    creates: AtomicUsize,
    prepares: AtomicUsize,
    queries: AtomicUsize,
    retires: AtomicUsize,
    prepare_threads: Mutex<Vec<thread::ThreadId>>,
    query_threads: Mutex<Vec<thread::ThreadId>>,
    prepare_mode: Mutex<PrepareMode>,
    query_mode: Mutex<QueryMode>,
    release: AtomicBool,
    retire_started: AtomicUsize,
    retire_hold: AtomicBool,
    retire_release: AtomicBool,
    retire_quarantines: AtomicBool,
    retire_leaks_participant: AtomicBool,
    create_times: Mutex<Vec<Instant>>,
}

struct FakeFactory(Arc<FakePlan>);

impl GraphWorkerFactory for FakeFactory {
    fn create(&self, start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        lock(&self.0.create_times).push(Instant::now());
        self.0.creates.fetch_add(1, Ordering::SeqCst);
        Box::new(FakeWorker {
            plan: Arc::clone(&self.0),
            snapshot: Some(start.snapshot),
            core: start.core,
            binding: start.binding,
            quarantined: false,
        })
    }
}

struct FakeWorker {
    plan: Arc<FakePlan>,
    snapshot: Option<ActiveWorkspaceSnapshot>,
    core: WorkspaceLifecycleCore,
    binding: LiveBinding,
    quarantined: bool,
}

impl FakeWorker {
    /// Holds until released; a lost Ready binding fails like a real worker would.
    fn hold(&self) -> Result<()> {
        loop {
            if self.plan.release.load(Ordering::SeqCst) {
                return Ok(());
            }
            let still_ready = match self.core.snapshot() {
                Ok(snapshot) => {
                    matches!(snapshot.state, LifecycleState::Ready(ref current) if *current == self.binding)
                }
                Err(_) => false,
            };
            if !still_ready {
                return Err(LifecycleError::InvalidState.into());
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

fn projection(request: &Nir1GraphRequest) -> Nir1GraphProjection {
    Nir1GraphProjection {
        project_id: request.project_id.clone(),
        query_scene_id: request.query_scene_id.clone(),
        scope_revision: Some("scope-revision".into()),
        graph: Nir1QualifiedGraph {
            seed_entity_id: request.seed_entity_id.clone(),
            generation: 1,
            nodes: Vec::new(),
            edges: Vec::new(),
            scene_total: 0,
            scenes: Vec::new(),
        },
        elapsed: Duration::ZERO,
    }
}

impl GraphWorker for FakeWorker {
    fn prepare(&mut self, _project_id: &str) -> Result<()> {
        self.plan.prepares.fetch_add(1, Ordering::SeqCst);
        lock(&self.plan.prepare_threads).push(thread::current().id());
        let mode = *lock(&self.plan.prepare_mode);
        match mode {
            PrepareMode::Ok => Ok(()),
            PrepareMode::Fail(text) => Err(anyhow!(text)),
            PrepareMode::Hold => self.hold(),
        }
    }

    fn query(
        &mut self,
        request: &Nir1GraphRequest,
        cancel: &AtomicBool,
    ) -> Result<Nir1GraphProjection> {
        self.plan.queries.fetch_add(1, Ordering::SeqCst);
        lock(&self.plan.query_threads).push(thread::current().id());
        // The worker bounds the capacity of the request buffers, not their length.
        let capacity = request.project_id.capacity()
            + request.query_scene_id.capacity()
            + request.seed_entity_id.capacity();
        ensure!(
            capacity <= REQUEST_BYTES,
            "NIR1_GRAPH_WORKER_REQUEST_CAPACITY_LIMIT"
        );
        let mode = *lock(&self.plan.query_mode);
        match mode {
            QueryMode::Ok => Ok(projection(request)),
            QueryMode::OkThenQuarantine => {
                self.quarantined = true;
                Ok(projection(request))
            }
            QueryMode::Unavailable(reason) => Err(CQueryWorkerUnavailable { reason }.into()),
            QueryMode::Fail(text) => Err(anyhow!(text)),
            QueryMode::Hold => {
                self.hold()?;
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("NIR1_GRAPH_WORKER_CALLER_CANCELLED"));
                }
                Ok(projection(request))
            }
            QueryMode::Panic => panic!("fake owner panic"),
            QueryMode::QuarantineFence => {
                let snapshot = self
                    .snapshot
                    .take()
                    .ok_or_else(|| anyhow!("fake snapshot missing"))?;
                ensure!(
                    grimodex_db::state::leak_c_query_quarantine_fence_for_test(snapshot),
                    "fake quarantine fence unavailable"
                );
                self.quarantined = true;
                Err(anyhow!("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED: fake fence"))
            }
            QueryMode::QuarantineParticipant => {
                if let Some(snapshot) = self.snapshot.take() {
                    std::mem::forget(snapshot);
                }
                self.quarantined = true;
                Err(anyhow!("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED: fake participant"))
            }
        }
    }

    fn quarantined(&self) -> bool {
        self.quarantined
    }

    fn retire(self: Box<Self>) -> CQueryRetirement {
        let plan = Arc::clone(&self.plan);
        plan.retires.fetch_add(1, Ordering::SeqCst);
        plan.retire_started.fetch_add(1, Ordering::SeqCst);
        if plan.retire_hold.load(Ordering::SeqCst) {
            while !plan.retire_release.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(1));
            }
        }
        let FakeWorker {
            snapshot,
            quarantined,
            ..
        } = *self;
        // A retirement that cannot prove its cleanup keeps the participant for
        // the rest of the process, as the real worker's fallback does.
        let leaks_participant = plan.retire_leaks_participant.load(Ordering::SeqCst);
        if leaks_participant {
            std::mem::forget(snapshot);
        } else {
            drop(snapshot);
        }
        if quarantined || leaks_participant || plan.retire_quarantines.load(Ordering::SeqCst) {
            CQueryRetirement::Quarantined
        } else {
            CQueryRetirement::Retired
        }
    }
}

struct ProductFixture {
    root: PathBuf,
    state: Arc<AppState>,
    authority: Arc<grimodex_db::state::WorkspaceAuthority>,
    plan: Arc<FakePlan>,
}

impl ProductFixture {
    fn new() -> Self {
        Self::with(true, true, true)
    }

    /// `publish` opens the test-only publication gate; `restricted` activates
    /// the restricted D2a profile; `factory` installs the fake worker.
    fn with(publish: bool, restricted: bool, factory: bool) -> Self {
        let root = product_workspace_root();
        let backend = crate::Backend::new(
            root.join("app").to_string_lossy().into_owned(),
            None,
            None,
        )
        .expect("Native backend");
        let state = Arc::clone(&backend.state);
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
        db.migrate().expect("schema");
        let authority =
            grimodex_db::state::WorkspaceAuthority::from_database_for_test(db, root.clone())
                .expect("authority");
        *state.ws.inner.lock().expect("workspace") = Some(
            grimodex_db::state::ActiveWorkspace::new(Arc::clone(&authority)),
        );
        state
            .workspace_lifecycle
            .ensure_authority_ready(&state.ws)
            .expect("Ready publication");
        if restricted {
            state
                .profile_egress
                .activate_first_restricted_publication(
                    &crate::main_grant::ConsumedProfileActivation::for_test(),
                    true,
                )
                .expect("restricted profile");
        }
        let plan = Arc::new(FakePlan::default());
        if publish {
            state.nir1_graph.open_publication_for_test();
        }
        state.nir1_graph.set_config_for_test(fast_config());
        if factory {
            state
                .nir1_graph
                .install_worker_factory_for_test(Arc::new(FakeFactory(Arc::clone(&plan))));
        }
        Self {
            root,
            state,
            authority,
            plan,
        }
    }

    fn query(&self, seed: &str) -> GraphQuery {
        GraphQuery {
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: seed.into(),
        }
    }

    fn begin(&self, seed: &str) -> GraphBegin {
        self.state.nir1_graph.begin(&self.state, self.query(seed))
    }

    fn kind(&self) -> GraphSlotKind {
        self.state.nir1_graph.slot_kind_for_test()
    }

    fn diagnostics(&self) -> GraphOwnerDiagnostics {
        self.state.nir1_graph.diagnostics()
    }

    /// Warms the worker and waits for READY.
    fn warm(&self) {
        assert!(matches!(
            self.begin("entity"),
            GraphBegin::Unavailable(GraphUnavailable::Warming)
        ));
        wait_until("READY", || self.kind() == GraphSlotKind::Ready);
    }
}

impl Drop for ProductFixture {
    fn drop(&mut self) {
        self.plan.release.store(true, Ordering::SeqCst);
        self.plan.retire_release.store(true, Ordering::SeqCst);
        self.state.nir1_graph.close_for_shutdown();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !matches!(
                self.kind(),
                GraphSlotKind::Closed | GraphSlotKind::Empty | GraphSlotKind::Quarantined
            )
        {
            thread::sleep(Duration::from_millis(1));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Holds the workspace slot, which the owner needs for its freshness read.
fn lock_workspace_slot(
    state: &AppState,
) -> std::sync::MutexGuard<'_, Option<grimodex_db::state::ActiveWorkspace>> {
    state.ws.inner.lock().expect("workspace lock")
}

fn pending(begin: GraphBegin) -> GraphTicket {
    match begin {
        GraphBegin::Pending(ticket) => ticket,
        GraphBegin::Cached(_) => panic!("expected a pending ticket, got a cache hit"),
        GraphBegin::Unavailable(reason) => {
            panic!("expected a pending ticket, got {}", reason.as_str())
        }
    }
}

struct NoopObserver;

impl WorkspaceLifecycleObserver for NoopObserver {
    fn on_lifecycle_edge(&self, _edge: &LifecycleEdge) {}
}

#[test]
fn a1_owner_is_not_activated_before_pub_g() {
    let fixture = ProductFixture::with(false, true, true);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.diagnostics().unavailable[GraphUnavailable::NotActivated.index()],
        1
    );
}

#[test]
fn a1_module_has_no_napi_entry() {
    assert!(!include_str!("nir1_graph_product.rs").contains("#[napi"));
}

#[test]
fn activation_requires_registration_restricted_profile_and_worker() {
    let unrestricted = ProductFixture::with(true, false, true);
    assert!(matches!(
        unrestricted.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::ProfileNotRestricted)
    ));
    let no_worker = ProductFixture::with(true, true, false);
    assert!(matches!(
        no_worker.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::WorkerUnavailable)
    ));
    let fixture = ProductFixture::new();
    assert!(matches!(
        fixture.begin(""),
        GraphBegin::Unavailable(GraphUnavailable::NotRequested)
    ));
    let oversized = GraphQuery {
        project_id: "p".repeat(REQUEST_BYTES),
        ..fixture.query("entity")
    };
    assert!(matches!(
        fixture.state.nir1_graph.begin(&fixture.state, oversized),
        GraphBegin::Unavailable(GraphUnavailable::Limit)
    ));
    let core = WorkspaceLifecycleCore::new();
    for _ in 0..MAX_LIFECYCLE_OBSERVERS {
        core.register_observer(Arc::new(NoopObserver))
            .expect("observer slot");
    }
    let full = Nir1GraphProductOwner::new(&core);
    assert!(matches!(
        full.begin(&fixture.state, fixture.query("entity")),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
}

#[test]
fn first_query_warms_then_ready_serves_next_query_after_retirement() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let ticket = pending(fixture.begin("entity"));
    match ticket.wait_timeout(Duration::from_secs(2)) {
        Some(GraphTicketOutcome::Available(projection)) => {
            assert_eq!(projection.graph.seed_entity_id, "entity");
        }
        other => panic!("expected an available Graph, got {other:?}"),
    }
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    // The rebuild after this query prepares again on the same thread, so the
    // prepare list may already hold two entries: all of them and the query must
    // come from one owner thread.
    let prepared_on = lock(&fixture.plan.prepare_threads).clone();
    let queried_on = lock(&fixture.plan.query_threads).clone();
    assert!(!prepared_on.is_empty());
    assert_eq!(queried_on.len(), 1);
    let threads: HashSet<_> = prepared_on.iter().chain(queried_on.iter()).collect();
    assert_eq!(threads.len(), 1, "prepare and query share one owner thread");
    assert!(ticket.resolved_after().is_some());
    assert!(ticket.poll().is_some());
    ticket.finish(GraphTicketUse::Used);
    wait_until("rebuilt READY", || {
        fixture.plan.creates.load(Ordering::SeqCst) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
}

#[test]
fn stale_stamp_retires_without_query_and_rebuilds() {
    let fixture = ProductFixture::new();
    fixture.warm();
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects(id,title) VALUES ('stale-probe','Probe')",
                [],
            )?;
            Ok(())
        })
        .expect("commit after READY");
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Stale))
    ));
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    // The verdict is delivered first; the unused worker retires right after it.
    wait_until("stale worker retired", || {
        fixture.plan.retires.load(Ordering::SeqCst) == 1
    });
    assert_eq!(fixture.diagnostics().stamp_stale, 1);
    ticket.finish(GraphTicketUse::Used);
    wait_until("rebuilt READY", || {
        fixture.plan.creates.load(Ordering::SeqCst) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
    let next = pending(fixture.begin("entity"));
    assert!(matches!(
        next.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
}

#[test]
fn unavailable_stamp_still_queries_and_worker_drift_maps_to_stale() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Unavailable(UnavailableReason::RegistrationDrift);
    let authority = Arc::clone(&fixture.authority);
    let blocker = thread::spawn(move || {
        authority.db().with_conn(|_| {
            thread::sleep(Duration::from_secs(2));
            Ok(())
        })
    });
    thread::sleep(Duration::from_millis(50));
    let started = Instant::now();
    let ticket = pending(fixture.begin("entity"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(3)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Stale))
    ));
    let diagnostics = fixture.diagnostics();
    assert_eq!(diagnostics.stamp_unavailable, 1);
    assert_eq!(diagnostics.drift_at_query, 1);
    ticket.finish(GraphTicketUse::Used);
    blocker
        .join()
        .expect("blocker thread")
        .expect("blocker commit");
}

#[test]
fn second_window_gets_busy_without_waiting() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let first = pending(fixture.begin("entity"));
    let started = Instant::now();
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    let other_project = GraphQuery {
        project_id: "other-project".into(),
        ..fixture.query("entity")
    };
    assert!(matches!(
        fixture.state.nir1_graph.begin(&fixture.state, other_project),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        first.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    first.finish(GraphTicketUse::Used);
}

#[test]
fn idle_ready_worker_retires_after_idle_limit() {
    let fixture = ProductFixture::new();
    fixture.warm();
    wait_until("idle retirement", || fixture.kind() == GraphSlotKind::Empty);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().retired_idle, 1);
    assert_eq!(
        fixture
            .state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .expect("participant count"),
        0
    );
}

#[test]
fn ready_publication_and_startup_never_prewarm() {
    let fixture = ProductFixture::new();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.kind(), GraphSlotKind::Empty);
}

#[test]
fn cancelled_ticket_never_publishes_or_caches() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    assert!(fixture
        .state
        .nir1_graph
        .set_graph_ready_notifier(Arc::new(move |_notice: &GraphReadyNotice| {
            counted.fetch_add(1, Ordering::SeqCst);
        })));
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(fixture.begin("entity"));
    let waiter = ticket.waiter();
    ticket.finish(GraphTicketUse::Cancelled);
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        waiter.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Cancelled))
    ));
    wait_until("worker retired", || {
        fixture.plan.retires.load(Ordering::SeqCst) == 1
    });
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn late_unused_result_fills_the_single_entry_cache_and_notifies() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let notices = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = Arc::clone(&notices);
    assert!(fixture
        .state
        .nir1_graph
        .set_graph_ready_notifier(Arc::new(move |notice: &GraphReadyNotice| {
            lock(&recorded).push(notice.project_id.clone());
        })));
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(fixture.begin("entity"));
    ticket.finish(GraphTicketUse::Unused);
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("late cache", || {
        fixture.state.nir1_graph.cache_len_for_test() == 1
    });
    assert_eq!(lock(&notices).clone(), vec![PROJECT.to_string()]);
    match fixture.begin("entity") {
        GraphBegin::Cached(projection) => {
            assert_eq!(projection.graph.seed_entity_id, "entity");
        }
        _ => panic!("the late result must be served once from the cache"),
    }
    assert!(!matches!(fixture.begin("entity"), GraphBegin::Cached(_)));
}

#[test]
fn quarantine_reports_restart_required_and_never_spawns_again() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::QuarantineParticipant;
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::RestartRequired))
    ));
    wait_until("quarantined slot", || fixture.kind() == GraphSlotKind::Quarantined);
    assert!(fixture.state.nir1_graph.is_quarantined());
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    let creates = fixture.plan.creates.load(Ordering::SeqCst);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RestartRequired)
    ));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), creates);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn owner_thread_panic_resolves_ticket_and_retires_worker() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Panic;
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Failed))
    ));
    wait_until("panicked worker retired", || {
        fixture.plan.retires.load(Ordering::SeqCst) == 1
    });
    wait_until("slot emptied", || fixture.kind() == GraphSlotKind::Empty);
    assert_eq!(fixture.diagnostics().panics, 1);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn edge_during_query_discards_result() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(fixture.begin("entity"));
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable {
            revision: u64::MAX,
        });
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Invalidated))
    ));
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn begin_never_waits_for_db_or_preparation() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    for _ in 0..10 {
        let started = Instant::now();
        assert!(matches!(
            fixture.begin("entity"),
            GraphBegin::Unavailable(GraphUnavailable::Warming | GraphUnavailable::Busy)
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    let authority = Arc::clone(&fixture.authority);
    let blocker = thread::spawn(move || {
        authority.db().with_conn(|_| {
            thread::sleep(Duration::from_secs(2));
            Ok(())
        })
    });
    thread::sleep(Duration::from_millis(50));
    let started = Instant::now();
    let _ = fixture.begin("entity");
    assert!(started.elapsed() < Duration::from_secs(1));
    fixture.plan.release.store(true, Ordering::SeqCst);
    blocker
        .join()
        .expect("blocker thread")
        .expect("blocker commit");
}

#[test]
fn startup_failures_back_off_then_suspend_until_ready_edge() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) =
        PrepareMode::Fail("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY: fake");
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("suspended after five failures", || {
        let _ = fixture.begin("entity");
        fixture.kind() == GraphSlotKind::Suspended
    });
    assert_eq!(fixture.plan.prepares.load(Ordering::SeqCst), 5);
    assert_eq!(fixture.diagnostics().prepare_failures, 5);
    let creates = fixture.plan.creates.load(Ordering::SeqCst);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::WorkerUnavailable)
    ));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), creates);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Ok;
    let binding = ready_binding(&fixture.state).expect("Ready binding");
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::ReadyPublished {
            binding,
            revision: 1,
        });
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("resumed READY", || fixture.kind() == GraphSlotKind::Ready);
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), creates + 1);
}

#[test]
fn quarantine_fence_path_quarantines_the_slot() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::QuarantineFence;
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::RestartRequired))
    ));
    wait_until("fenced slot", || fixture.kind() == GraphSlotKind::Quarantined);
    assert!(fixture.state.nir1_graph.is_quarantined());
    assert_eq!(fixture.diagnostics().quarantines, 1);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RestartRequired)
    ));
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn configure_and_resume_are_explicit_and_bounded() {
    let owner = Nir1GraphProductOwner {
        shared: Arc::new(Shared::new()),
    };
    {
        let mut slot = lock(&owner.shared.slot);
        slot.phase = Phase::Suspended {
            ready_generation: 0,
            reason: GraphUnavailable::WorkerUnavailable,
        };
        slot.rebuild.consecutive_failures = 5;
        slot.rebuild.last_failure = Some(GraphUnavailable::WorkerUnavailable);
    }
    owner.resume_after_graph_index_change();
    assert_eq!(owner.slot_kind_for_test(), GraphSlotKind::Empty);
    assert_eq!(lock(&owner.shared.slot).rebuild.consecutive_failures, 0);

    let directory =
        std::env::temp_dir().join(format!("nir1-graph-configure-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("directory");
    let name = if cfg!(windows) {
        "nir1-c-query-worker.exe"
    } else {
        "nir1-c-query-worker"
    };
    let worker = directory.join(name);
    std::fs::write(&worker, b"").expect("worker file");
    owner
        .configure_worker_path(worker.clone())
        .expect("configured once");
    assert!(owner.configure_worker_path(worker).is_err());
    assert!(owner
        .configure_worker_path(PathBuf::from(name))
        .is_err());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn unclassified_query_failure_is_reported_as_failed_and_retires_the_worker() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Fail("fake unclassified query failure");
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Failed))
    ));
    wait_until("worker retired", || {
        fixture.plan.retires.load(Ordering::SeqCst) == 1
    });
    ticket.finish(GraphTicketUse::Used);
}

/// A Native backend whose active workspace is `w1`, with a second valid
/// workspace `w2` for the refusal-scope checks. The owner is armed as in
/// production (restricted profile, fake worker); nothing spawns until demand.
struct RefusalFixture {
    root: PathBuf,
    backend: crate::Backend,
    w1: PathBuf,
    w2: PathBuf,
    plan: Arc<FakePlan>,
}

fn refusal_workspace(path: &Path) {
    std::fs::create_dir_all(path.join(".grimodex")).expect("workspace metadata directory");
    std::fs::write(
        path.join(".grimodex/workspace.json"),
        serde_json::json!({
            "id": format!("workspace-{}", uuid::Uuid::new_v4()),
            "created_at": "2026-01-01T00:00:00.000Z"
        })
        .to_string(),
    )
    .expect("workspace metadata");
    let database = grimodex_db::Database::new(&path.join("grimodex.db")).expect("database");
    database.migrate().expect("database migration");
}

impl RefusalFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "nir1-graph-refusal-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        let w1 = root.join("w1");
        let w2 = root.join("w2");
        refusal_workspace(&w1);
        refusal_workspace(&w2);
        let state = AppState::new(
            &root.join("app").to_string_lossy(),
            &root.join("resources").to_string_lossy(),
        )
        .expect("app state");
        state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        let database = grimodex_db::Database::new(&w1.join("grimodex.db")).expect("database");
        let authority =
            grimodex_db::state::WorkspaceAuthority::from_database_for_test(database, w1.clone())
                .expect("workspace authority");
        crate::install_test_workspace(&state, authority);
        state
            .profile_egress
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("restricted profile");
        let plan = Arc::new(FakePlan::default());
        state.nir1_graph.open_publication_for_test();
        state.nir1_graph.set_config_for_test(fast_config());
        state
            .nir1_graph
            .install_worker_factory_for_test(Arc::new(FakeFactory(Arc::clone(&plan))));
        Self {
            root,
            backend: crate::Backend {
                state: Arc::new(state),
            },
            w1,
            w2,
            plan,
        }
    }

    fn state(&self) -> &Arc<AppState> {
        &self.backend.state
    }

    /// Drives the owner for `w1` into quarantine with the given failure mode.
    fn quarantine_w1(&self, mode: QueryMode) {
        let state = self.state();
        let query = GraphQuery {
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        };
        assert!(matches!(
            state.nir1_graph.begin(state, query.clone()),
            GraphBegin::Unavailable(GraphUnavailable::Warming)
        ));
        wait_until("READY for w1", || {
            state.nir1_graph.slot_kind_for_test() == GraphSlotKind::Ready
        });
        *lock(&self.plan.query_mode) = mode;
        let ticket = pending(state.nir1_graph.begin(state, query));
        assert!(matches!(
            ticket.wait_timeout(Duration::from_secs(2)),
            Some(GraphTicketOutcome::Unavailable(GraphUnavailable::RestartRequired))
        ));
        wait_until("quarantined w1", || state.nir1_graph.is_quarantined());
        ticket.finish(GraphTicketUse::Used);
    }
}

impl Drop for RefusalFixture {
    fn drop(&mut self) {
        self.plan.release.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Awaits an entry call that must settle within 2 s. A wait for physical
/// exclusion that never ends fails the test with a message instead of hanging it.
async fn within_two_seconds<T, E: std::fmt::Debug>(
    what: &str,
    call: impl std::future::Future<Output = std::result::Result<T, E>>,
) -> T {
    match tokio::time::timeout(Duration::from_secs(2), call).await {
        Ok(outcome) => outcome.unwrap_or_else(|error| panic!("{what} failed: {error:?}")),
        Err(_) => panic!("{what} did not return within 2 s"),
    }
}

#[tokio::test]
async fn quarantine_fence_refuses_w1_restore_and_open_but_w2_opens() {
    let fixture = RefusalFixture::new("fence");
    fixture.quarantine_w1(QueryMode::QuarantineFence);
    let restore = within_two_seconds(
        "Restore of the fenced workspace",
        fixture.backend.restore_backup("missing.db".to_string()),
    )
    .await;
    let restore: serde_json::Value = serde_json::from_str(&restore).expect("restore JSON");
    assert_eq!(restore["status"], "not-admitted");
    assert_eq!(restore["reasonCode"], NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE);
    let open = within_two_seconds(
        "Open of the fenced workspace",
        fixture
            .backend
            .open_workspace(fixture.w1.to_string_lossy().into_owned()),
    )
    .await;
    let open: serde_json::Value = serde_json::from_str(&open).expect("open JSON for w1");
    assert_eq!(open["reasonCode"], NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE);
    let other = within_two_seconds(
        "Open of the other workspace",
        fixture
            .backend
            .open_workspace(fixture.w2.to_string_lossy().into_owned()),
    )
    .await;
    let other: serde_json::Value = serde_json::from_str(&other).expect("open JSON for w2");
    assert!(matches!(other["status"].as_str(), Some("ready" | "migrated")));
}

#[tokio::test]
async fn restore_and_open_entries_are_unchanged_without_quarantine() {
    let fixture = RefusalFixture::new("unchanged");
    let restore = fixture
        .backend
        .restore_backup("grimodex-missing-backup.db".to_string())
        .await
        .expect("restore outcome");
    let restore: serde_json::Value = serde_json::from_str(&restore).expect("restore JSON");
    assert_eq!(restore["status"], "unchanged");
    assert_eq!(restore["operationOutcome"], "failed");
    let open = fixture
        .backend
        .open_workspace(fixture.w1.to_string_lossy().into_owned())
        .await
        .expect("open outcome");
    let open: serde_json::Value = serde_json::from_str(&open).expect("open JSON");
    assert_ne!(open["reasonCode"], NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE);
}

#[tokio::test]
async fn quarantine_fence_shutdown_never_reports_closed() {
    let fixture = RefusalFixture::new("shutdown-fence");
    fixture.quarantine_w1(QueryMode::QuarantineFence);
    let first = tokio::time::timeout(
        Duration::from_secs(10),
        fixture.backend.shutdown_workspace_lifecycle(),
    )
    .await
    .expect("a fenced shutdown settles within 10 s");
    assert!(first.is_err(), "a fenced C-query must never report Closed");
    assert!(fixture.backend.shutdown_workspace_lifecycle().await.is_err());
}

#[tokio::test]
async fn quarantine_participant_shutdown_never_completes() {
    let fixture = RefusalFixture::new("shutdown-participant");
    fixture.quarantine_w1(QueryMode::QuarantineParticipant);
    let outcome = tokio::time::timeout(
        Duration::from_secs(1),
        fixture.backend.shutdown_workspace_lifecycle(),
    )
    .await;
    assert!(outcome.is_err(), "a leaked participant keeps shutdown open");
    assert!(
        fixture
            .state()
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .expect("participant count")
            >= 1
    );
}

#[test]
fn other_key_demand_retires_after_min_interval_and_rekeys() {
    let fixture = ProductFixture::new();
    let first_demand = Instant::now();
    fixture.warm();
    // The idle limit must outlast the 500 ms window, or the first session would
    // retire for idleness instead of by the rekey this case checks.
    fixture
        .state
        .nir1_graph
        .set_config_for_test(GraphOwnerConfig {
            rebuild_min_interval: Duration::from_millis(400),
            idle_retire_after: Duration::from_secs(5),
            ..fast_config()
        });
    let other = GraphQuery {
        project_id: "other-project".into(),
        ..fixture.query("entity")
    };
    // Inside the window the other key is refused and READY stays on the first key.
    assert!(matches!(
        fixture.state.nir1_graph.begin(&fixture.state, other.clone()),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    if first_demand.elapsed() < Duration::from_millis(400) {
        assert_eq!(fixture.kind(), GraphSlotKind::Ready);
    }
    thread::sleep(Duration::from_millis(500).saturating_sub(first_demand.elapsed()));
    // Past the window a demand for the other key starts the rekey. Under load the
    // first demand may already have started it, so this outcome is not asserted.
    let _ = fixture.state.nir1_graph.begin(&fixture.state, other.clone());
    wait_until("rekeyed READY", || {
        fixture.plan.retires.load(Ordering::SeqCst) == 1
            && fixture.plan.creates.load(Ordering::SeqCst) == 2
            && fixture.kind() == GraphSlotKind::Ready
    });
    let ticket = pending(fixture.state.nir1_graph.begin(&fixture.state, other));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn ready_edge_retires_the_worker_and_releases_its_participant() {
    let fixture = ProductFixture::new();
    fixture.warm();
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable {
            revision: u64::MAX,
        });
    wait_until("edge retirement", || fixture.kind() == GraphSlotKind::Empty);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().retired_edge, 1);
    assert_eq!(
        fixture
            .state
            .ws
            .lifecycle_core()
            .workspace_participant_count()
            .expect("participant count"),
        0
    );
}

#[test]
fn ready_shutdown_request_closes_the_owner_without_a_new_worker() {
    let fixture = ProductFixture::new();
    fixture.warm();
    fixture
        .state
        .ws
        .lifecycle_core()
        .request_shutdown()
        .expect("shutdown request");
    wait_until("closed owner", || fixture.kind() == GraphSlotKind::Closed);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Invalidated)
    ));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn preparing_edge_discards_the_worker_once_prepare_returns() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("prepare started", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable {
            revision: u64::MAX,
        });
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("discarded before READY", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().prepares_ready, 0);
}

#[test]
fn cancel_before_the_freshness_read_never_queries() {
    let fixture = ProductFixture::new();
    fixture.warm();
    // Holding the workspace slot blocks the owner at the S1 read, before the query.
    let held = lock_workspace_slot(&fixture.state);
    let ticket = pending(fixture.begin("entity"));
    ticket.finish(GraphTicketUse::Cancelled);
    drop(held);
    wait_until("back to READY after cancel", || {
        fixture.kind() == GraphSlotKind::Ready
    });
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 0);
}

/// Admits a Restore transition, then drains the owner through physical
/// exclusion on another thread and completes the transition. Returns the
/// status published by the completed transition.
fn admit_restore_and_drain(
    state: &Arc<AppState>,
) -> crate::workspace_lifecycle_view::WorkspaceLifecycleStatus {
    match state
        .workspace_lifecycle
        .try_begin_transition_kind(AdmissionKind::Restore)
        .expect("restore admission")
    {
        AdmissionOutcome::Admitted(_) => {}
        AdmissionOutcome::NotAdmitted { reason, .. } => {
            panic!("restore must be admitted: {reason:?}")
        }
    }
    let drainer = Arc::clone(state);
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let exclusive = drainer
            .workspace_lifecycle
            .acquire_transition_physical_exclusive()
            .expect("physical exclusion once the owner settles");
        drop(exclusive);
        let view = drainer
            .workspace_lifecycle
            .complete_transition_from_workspace(&drainer.ws)
            .expect("transition publication");
        let _ = sender.send(view.status);
    });
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("the Restore transition completes in bounded time")
}

#[test]
fn restore_admission_drains_the_ready_worker_before_physical_exclusion() {
    let fixture = ProductFixture::new();
    fixture.warm();
    assert_eq!(
        admit_restore_and_drain(&fixture.state),
        crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
    );
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().retired_edge, 1);
    assert_eq!(fixture.kind(), GraphSlotKind::Empty);
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn restore_admission_during_prepare_discards_the_worker_before_physical_exclusion() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("prepare started", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    assert_eq!(
        admit_restore_and_drain(&fixture.state),
        crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
    );
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().prepares_ready, 0);
    assert_eq!(fixture.kind(), GraphSlotKind::Empty);
}

#[test]
fn restore_admission_during_query_invalidates_and_retires() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(fixture.begin("entity"));
    assert_eq!(
        admit_restore_and_drain(&fixture.state),
        crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
    );
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Invalidated))
    ));
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn failure_backoff_doubles_and_caps() {
    let config = GraphOwnerConfig {
        failure_backoff_initial: Duration::from_secs(2),
        failure_backoff_max: Duration::from_secs(60),
        ..GraphOwnerConfig::default()
    };
    assert_eq!(failure_backoff(&config, 0), Duration::ZERO);
    assert_eq!(failure_backoff(&config, 1), Duration::from_secs(2));
    assert_eq!(failure_backoff(&config, 2), Duration::from_secs(4));
    assert_eq!(failure_backoff(&config, 3), Duration::from_secs(8));
    assert_eq!(failure_backoff(&config, 6), Duration::from_secs(60));
    assert_eq!(failure_backoff(&config, u32::MAX), Duration::from_secs(60));
}

#[test]
fn cache_entry_is_usable_only_before_ttl_with_the_same_epochs() {
    let ttl = Duration::from_millis(200);
    let stored_at = Instant::now();
    let key = CacheKey {
        binding: LiveBinding::new("/workspace", "workspace-id", 1, 0),
        caller_epoch: 1,
        project_id: PROJECT.into(),
        query_scene_id: SCENE.into(),
        seed_entity_id: "entity".into(),
    };
    let entry = CacheEntry {
        key: key.clone(),
        projection: Arc::new(projection(&Nir1GraphRequest {
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        })),
        stored_at,
        edge_epoch: 7,
    };
    assert!(cache_entry_usable(
        &entry,
        &key,
        7,
        stored_at + ttl - Duration::from_nanos(1),
        ttl
    ));
    assert!(!cache_entry_usable(&entry, &key, 7, stored_at + ttl, ttl));
    assert!(!cache_entry_usable(&entry, &key, 8, stored_at, ttl));
    let other_caller = CacheKey {
        caller_epoch: 2,
        ..key.clone()
    };
    assert!(!cache_entry_usable(&entry, &other_caller, 7, stored_at, ttl));
}

#[test]
fn idle_deadline_is_last_demand_plus_limit() {
    let last = Instant::now();
    let config = GraphOwnerConfig::default();
    assert_eq!(
        idle_deadline(&config, last),
        last + Duration::from_secs(120)
    );
}

#[test]
fn rebuild_not_before_respects_min_interval_and_backoff() {
    let config = fast_config();
    let started = Instant::now();
    let mut ledger = RebuildLedger::default();
    assert_eq!(rebuild_not_before(&config, &ledger), None);
    ledger.last_prepare_started = Some(started);
    assert_eq!(
        rebuild_not_before(&config, &ledger),
        Some(started + Duration::from_millis(30))
    );
    let backoff_only = RebuildLedger {
        last_prepare_started: None,
        consecutive_failures: 3,
        last_failure_at: Some(started),
        last_failure: Some(GraphUnavailable::Failed),
    };
    assert_eq!(
        rebuild_not_before(&config, &backoff_only),
        Some(started + Duration::from_millis(80))
    );
    let both = RebuildLedger {
        last_prepare_started: Some(started),
        consecutive_failures: 1,
        last_failure_at: Some(started),
        last_failure: Some(GraphUnavailable::Failed),
    };
    assert_eq!(
        rebuild_not_before(&config, &both),
        Some(started + Duration::from_millis(30))
    );
}

#[test]
fn failure_mapping_matches_the_dsn_table() {
    use CQueryFailure as F;
    use PrepareFailureEffect as E;
    assert_eq!(
        prepare_failure(F::WorkerStartup),
        (GraphUnavailable::WorkerUnavailable, E::Count)
    );
    assert_eq!(
        prepare_failure(F::Deadline),
        (GraphUnavailable::WorkerUnavailable, E::Count)
    );
    assert_eq!(
        prepare_failure(F::StartupRegistrationRefused),
        (GraphUnavailable::RegistrationUnavailable, E::Count)
    );
    // CQ-LIM-2: the worker's startup marker for a registration that ends before
    // READY because an approved Revision is over the per-Revision limit is
    // classified as that same refusal, so Native reports the existing
    // `registration-unavailable` reason and counts it toward the backoff. No new
    // reason joins the closed set.
    let over_limit = anyhow::anyhow!(
        "NIR1_GRAPH_WORKER_EXIT_BEFORE_READY: NIR1_C_QUERY_STARTUP_REGISTRATION_REVISION_INPUT_LIMIT"
    );
    assert_eq!(
        grimodex_db::narrative_extraction::nir1_graph::c_query_worker::classify_c_query_failure(
            &over_limit
        ),
        F::StartupRegistrationRefused
    );
    assert_eq!(GraphUnavailable::ALL.len(), 14);
    assert_eq!(
        GraphUnavailable::RegistrationUnavailable.as_str(),
        "registration-unavailable"
    );
    assert_eq!(
        prepare_failure(F::BindingLost),
        (GraphUnavailable::Invalidated, E::DoNotCount)
    );
    assert_eq!(
        prepare_failure(F::CapacityBusy),
        (GraphUnavailable::Busy, E::DoNotCount)
    );
    assert_eq!(
        prepare_failure(F::CleanupUnproved),
        (GraphUnavailable::RestartRequired, E::Quarantine)
    );
    assert_eq!(query_failure(F::Deadline), GraphUnavailable::Timeout);
    assert_eq!(query_failure(F::Cancelled), GraphUnavailable::Cancelled);
    assert_eq!(query_failure(F::BindingLost), GraphUnavailable::Invalidated);
    assert_eq!(query_failure(F::CapacityBusy), GraphUnavailable::Busy);
    assert_eq!(query_failure(F::Other), GraphUnavailable::Failed);
    for (reason, expected) in [
        (
            UnavailableReason::ReaderUnavailable,
            GraphUnavailable::Cancelled,
        ),
        (
            UnavailableReason::RegistrationRequired,
            GraphUnavailable::RegistrationUnavailable,
        ),
        (
            UnavailableReason::RegistrationProjectMismatch,
            GraphUnavailable::Failed,
        ),
        (
            UnavailableReason::SeedNotFound,
            GraphUnavailable::Invalidated,
        ),
        (UnavailableReason::RegistrationDrift, GraphUnavailable::Stale),
        (UnavailableReason::QueryInvalidated, GraphUnavailable::Timeout),
    ] {
        assert_eq!(query_failure(F::Unavailable(reason)), expected, "{reason}");
        assert_eq!(prepare_failure(F::Unavailable(reason)).0, GraphUnavailable::WorkerUnavailable);
    }
}

#[test]
fn unavailable_reasons_are_the_closed_dsn_set() {
    let names: Vec<&str> = GraphUnavailable::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "not-requested",
            "not-activated",
            "profile-not-restricted",
            "warming",
            "stale",
            "busy",
            "limit",
            "timeout",
            "registration-unavailable",
            "invalidated",
            "cancelled",
            "restart-required",
            "worker-unavailable",
            "failed",
        ]
    );
    assert_eq!(names.iter().copied().collect::<HashSet<_>>().len(), 14);
}

#[test]
fn worker_reason_categories_map_to_the_closed_set() {
    for (text, expected) in [
        ("query-worker-work-steps", GraphUnavailable::Limit),
        ("query-worker-work-deadline", GraphUnavailable::Timeout),
        (
            "query-worker-work-validation-cancelled",
            GraphUnavailable::Cancelled,
        ),
        (
            "query-worker-work-validation-workspace-generation-changed",
            GraphUnavailable::Invalidated,
        ),
        ("query-worker-work-other", GraphUnavailable::Failed),
        // The semantic Graph limits are limits; a contradiction between two
        // approved Revisions is the generic failure, never a limit or a stale.
        ("query-worker-work-node-limit", GraphUnavailable::Limit),
        ("query-worker-work-edge-limit", GraphUnavailable::Limit),
        (
            "query-worker-work-node-limit-pre-cleanup-work-failed-node-limit",
            GraphUnavailable::Limit,
        ),
        (
            "query-worker-work-edge-limit-pre-cleanup-work-failed-edge-limit",
            GraphUnavailable::Limit,
        ),
        (
            "query-worker-work-endpoint-version-conflict",
            GraphUnavailable::Failed,
        ),
        (
            "query-worker-work-endpoint-version-conflict-pre-cleanup-work-failed-endpoint-version-conflict",
            GraphUnavailable::Failed,
        ),
    ] {
        let reason = UnavailableReason::parse(text).expect("allowlisted worker reason");
        assert_eq!(
            query_failure(CQueryFailure::Unavailable(reason)),
            expected,
            "{text}"
        );
    }
}

#[test]
fn worker_path_validation_accepts_only_an_absolute_worker_file() {
    let directory =
        std::env::temp_dir().join(format!("nir1-graph-worker-path-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("directory");
    let name = if cfg!(windows) {
        "nir1-c-query-worker.exe"
    } else {
        "nir1-c-query-worker"
    };
    let worker = directory.join(name);
    std::fs::write(&worker, b"").expect("worker file");
    assert!(ProcessGraphWorkerFactory::from_path(worker.clone()).is_ok());
    assert!(ProcessGraphWorkerFactory::from_path(PathBuf::from(name)).is_err());
    assert!(ProcessGraphWorkerFactory::from_path(directory.join("missing-worker")).is_err());
    assert!(ProcessGraphWorkerFactory::from_path(directory.clone()).is_err());
    let alias = directory.join("alias-worker");
    std::fs::write(&alias, b"").expect("alias file");
    assert!(ProcessGraphWorkerFactory::from_path(alias).is_err());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn open_relabel_requires_quarantine_conflict_and_active_operation() {
    let owner = Nir1GraphProductOwner {
        shared: Arc::new(Shared::new()),
    };
    let wire = r#"{"status":"not-admitted","reasonCode":"active-operation"}"#;
    assert_eq!(
        owner.relabel_open_refusal(wire.into(), "/quarantined", Some("ws-q"), None),
        wire
    );
    lock(&owner.shared.slot).phase = Phase::Quarantined {
        binding: LiveBinding::new("/quarantined", "ws-q", 1, 0),
    };
    assert_eq!(
        owner.relabel_open_refusal(wire.into(), "/other", Some("ws-other"), None),
        wire
    );
    let other_reason = r#"{"status":"not-admitted","reasonCode":"maintenance-admission-closed"}"#;
    assert_eq!(
        owner.relabel_open_refusal(other_reason.into(), "/quarantined", None, None),
        other_reason
    );
    let relabeled =
        owner.relabel_open_refusal(wire.into(), "/quarantined", None, None);
    let value: serde_json::Value = serde_json::from_str(&relabeled).expect("json");
    assert_eq!(value["reasonCode"], NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE);
    assert_eq!(value["status"], "not-admitted");
}

// ---- CP-2a review fixes: retirement races, stale quarantine, rekey window ----

#[test]
fn stale_retirement_that_quarantines_never_rebuilds() {
    let fixture = ProductFixture::new();
    fixture.warm();
    // The unused worker's retirement cannot prove its cleanup. The stale verdict
    // must end the session in Quarantined, not start a second prepare.
    fixture
        .plan
        .retire_quarantines
        .store(true, Ordering::SeqCst);
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects(id,title) VALUES ('stale-quarantine','Probe')",
                [],
            )?;
            Ok(())
        })
        .expect("commit after READY");
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Stale))
    ));
    wait_until("quarantined slot", || {
        fixture.kind() == GraphSlotKind::Quarantined
    });
    // A rebuild would start after the 30 ms rebuild interval; wait well past it.
    thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.kind(), GraphSlotKind::Quarantined);
    assert_eq!(fixture.plan.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    assert!(fixture.state.nir1_graph.is_quarantined());
    assert!(fixture
        .state
        .nir1_graph
        .blocks_restore_of_current_workspace(&fixture.state));
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RestartRequired)
    ));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().quarantines, 1);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn idle_retirement_refuses_queries_while_the_worker_retires() {
    let fixture = ProductFixture::new();
    // The hold is set before READY, so the idle retirement it catches starts later.
    fixture.plan.retire_hold.store(true, Ordering::SeqCst);
    fixture.warm();
    wait_until("idle retirement started", || {
        fixture.plan.retire_started.load(Ordering::SeqCst) == 1
    });
    assert_eq!(fixture.kind(), GraphSlotKind::Retiring);
    // A Query sent now would wait on a thread that has stopped reading its channel.
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    fixture.plan.retire_release.store(true, Ordering::SeqCst);
    wait_until("idle retirement finished", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().retired_idle, 1);
}

#[test]
fn edge_retirement_refuses_queries_while_the_worker_retires() {
    let fixture = ProductFixture::new();
    fixture.plan.retire_hold.store(true, Ordering::SeqCst);
    fixture.warm();
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: u64::MAX });
    wait_until("retirement started", || {
        fixture.plan.retire_started.load(Ordering::SeqCst) == 1
    });
    assert_eq!(fixture.kind(), GraphSlotKind::Retiring);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    fixture.plan.retire_release.store(true, Ordering::SeqCst);
    wait_until("retirement finished", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    // A short idle limit can win the race with the edge; either one retires once.
    let diagnostics = fixture.diagnostics();
    assert_eq!(diagnostics.retired_edge + diagnostics.retired_idle, 1);
}

#[test]
fn queued_query_is_settled_when_its_session_ends() {
    let fixture = ProductFixture::new();
    let owner = Arc::clone(&fixture.state.nir1_graph.shared);
    let binding = ready_binding(&fixture.state).expect("Ready binding");
    let (commands, receiver) = mpsc::sync_channel(COMMAND_CAPACITY);
    let ticket = TicketShared::new(
        owner,
        CacheKey {
            binding,
            caller_epoch: 0,
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        },
        0,
    );
    commands
        .try_send(Command::Query {
            request: Nir1GraphRequest {
                project_id: PROJECT.into(),
                query_scene_id: SCENE.into(),
                seed_entity_id: "entity".into(),
            },
            ticket: Arc::clone(&ticket),
        })
        .expect("queued query");
    // The session's sender is the only one, and the session has ended.
    drop(commands);
    settle_queued(&receiver);
    assert!(matches!(
        ticket.wait_timeout(Duration::from_millis(100)),
        Some(GraphTicketOutcome::Unavailable(
            GraphUnavailable::Invalidated
        ))
    ));
}

#[test]
fn rekeyed_session_keeps_the_new_key_for_its_own_idle_window() {
    let fixture = ProductFixture::new();
    fixture
        .state
        .nir1_graph
        .set_config_for_test(GraphOwnerConfig {
            idle_retire_after: Duration::from_millis(700),
            ..fast_config()
        });
    let started = Instant::now();
    fixture.warm();
    // The other key's demand arrives inside the first key's idle window.
    thread::sleep(Duration::from_millis(500).saturating_sub(started.elapsed()));
    let other = GraphQuery {
        project_id: "other-project".into(),
        ..fixture.query("entity")
    };
    // Busy while the first key is still READY; Warming if its idle limit already ran.
    assert!(matches!(
        fixture
            .state
            .nir1_graph
            .begin(&fixture.state, other.clone()),
        GraphBegin::Unavailable(GraphUnavailable::Busy | GraphUnavailable::Warming)
    ));
    wait_until("rekeyed READY", || {
        fixture.plan.creates.load(Ordering::SeqCst) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
    // The first key's idle deadline has passed. The new key runs its own window
    // from its demand, so it must still be READY here.
    thread::sleep(Duration::from_millis(800).saturating_sub(started.elapsed()));
    assert_eq!(fixture.kind(), GraphSlotKind::Ready);
    let ticket = pending(fixture.state.nir1_graph.begin(&fixture.state, other));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn preparing_refuses_another_key_as_busy_without_reserving_it() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("prepare started", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    let other = GraphQuery {
        project_id: "other-project".into(),
        ..fixture.query("entity")
    };
    assert!(matches!(
        fixture.state.nir1_graph.begin(&fixture.state, other),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert_eq!(fixture.kind(), GraphSlotKind::Preparing);
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("READY for the prepared key", || {
        fixture.kind() == GraphSlotKind::Ready
    });
    // The refused key reserved no rebuild: the only worker is the first key's.
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn quarantined_late_unused_result_never_refills_the_cache() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let notified = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&notified);
    assert!(fixture.state.nir1_graph.set_graph_ready_notifier(Arc::new(
        move |_notice: &GraphReadyNotice| {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    )));
    // The result is delivered, but its cleanup cannot be proved: quarantine.
    *lock(&fixture.plan.query_mode) = QueryMode::OkThenQuarantine;
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    wait_until("quarantined slot", || {
        fixture.kind() == GraphSlotKind::Quarantined
    });
    // The caller finishes late and unused, after the quarantine.
    ticket.finish(GraphTicketUse::Unused);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert_eq!(notified.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RestartRequired)
    ));
}

#[test]
fn request_is_rebuilt_to_its_length_before_the_worker_sees_it() {
    let fixture = ProductFixture::new();
    fixture.warm();
    // A short project id in a large allocation: the worker bounds capacity, not length.
    let mut project_id = String::with_capacity(REQUEST_BYTES);
    project_id.push_str(PROJECT);
    let query = GraphQuery {
        project_id,
        ..fixture.query("entity")
    };
    let ticket = pending(fixture.state.nir1_graph.begin(&fixture.state, query));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn shutdown_during_prepare_discards_the_worker_and_closes() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("prepare started", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    fixture
        .state
        .ws
        .lifecycle_core()
        .request_shutdown()
        .expect("shutdown request");
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("closed owner", || fixture.kind() == GraphSlotKind::Closed);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().prepares_ready, 0);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Invalidated)
    ));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn shutdown_during_query_invalidates_the_ticket_and_retires() {
    let fixture = ProductFixture::new();
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(fixture.begin("entity"));
    fixture
        .state
        .ws
        .lifecycle_core()
        .request_shutdown()
        .expect("shutdown request");
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(
            GraphUnavailable::Invalidated
        ))
    ));
    wait_until("closed owner", || fixture.kind() == GraphSlotKind::Closed);
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn dto_is_delivered_only_after_the_worker_retires() {
    let fixture = ProductFixture::new();
    fixture.warm();
    fixture.plan.retire_hold.store(true, Ordering::SeqCst);
    let ticket = pending(fixture.begin("entity"));
    wait_until("retirement started", || {
        fixture.plan.retire_started.load(Ordering::SeqCst) == 1
    });
    // The result is not visible while the worker's retirement is still running.
    assert!(ticket.poll().is_none());
    assert!(ticket.wait_timeout(Duration::from_millis(50)).is_none());
    fixture.plan.retire_release.store(true, Ordering::SeqCst);
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn new_ready_publication_never_prewarms() {
    let fixture = ProductFixture::new();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
    // A Restore admitted and completed publishes a new Ready entry, with no demand.
    assert_eq!(
        admit_restore_and_drain(&fixture.state),
        crate::workspace_lifecycle_view::WorkspaceLifecycleStatus::Ready
    );
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.kind(), GraphSlotKind::Empty);
}

// ---- CP-2a review fixes (round 2): announcements and participant quarantine ----

/// Records the project of every graph-ready notice.
fn recording_notifier(fixture: &ProductFixture) -> Arc<Mutex<Vec<String>>> {
    let notices = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = Arc::clone(&notices);
    assert!(fixture.state.nir1_graph.set_graph_ready_notifier(Arc::new(
        move |notice: &GraphReadyNotice| {
            lock(&recorded).push(notice.project_id.clone());
        }
    )));
    notices
}

/// A query answered stale or busy through its ticket leaves the demand unserved,
/// exactly like a warming answer: the READY that the session rebuilds afterwards
/// is announced once, for that project (DSN §3.4 (a)).
fn assert_ticket_answer_is_announced_by_the_rebuilt_ready(
    arrange: impl FnOnce(&ProductFixture),
    expected: GraphUnavailable,
) {
    let fixture = ProductFixture::new();
    // The hook is in place before the first warming answer, so that READY is announced too.
    let notices = recording_notifier(&fixture);
    fixture.warm();
    wait_until("announcement of the first READY", || {
        lock(&notices).len() == 1
    });
    arrange(&fixture);
    let ticket = pending(fixture.begin("entity"));
    match ticket.wait_timeout(Duration::from_secs(2)) {
        Some(GraphTicketOutcome::Unavailable(reason)) => assert_eq!(reason, expected),
        other => panic!("expected {expected:?}, got {other:?}"),
    }
    wait_until("announcement of the rebuilt READY", || {
        lock(&notices).len() == 2
    });
    assert_eq!(
        lock(&notices).clone(),
        vec![PROJECT.to_string(), PROJECT.to_string()]
    );
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn stale_stamp_answered_through_a_ticket_is_announced_by_the_rebuilt_ready() {
    assert_ticket_answer_is_announced_by_the_rebuilt_ready(
        |fixture| {
            fixture
                .authority
                .db()
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO projects(id,title) VALUES ('announce-probe','Probe')",
                        [],
                    )?;
                    Ok(())
                })
                .expect("commit after READY");
        },
        GraphUnavailable::Stale,
    );
}

#[test]
fn worker_drift_answered_through_a_ticket_is_announced_by_the_rebuilt_ready() {
    assert_ticket_answer_is_announced_by_the_rebuilt_ready(
        |fixture| {
            *lock(&fixture.plan.query_mode) =
                QueryMode::Unavailable(UnavailableReason::RegistrationDrift);
        },
        GraphUnavailable::Stale,
    );
}

#[test]
fn busy_worker_answered_through_a_ticket_is_announced_by_the_rebuilt_ready() {
    assert_ticket_answer_is_announced_by_the_rebuilt_ready(
        |fixture| {
            *lock(&fixture.plan.query_mode) = QueryMode::Fail("NIR1_GRAPH_WORKER_CAPACITY_BUSY");
        },
        GraphUnavailable::Busy,
    );
}

#[test]
fn a_served_query_leaves_nothing_to_announce_at_the_rebuilt_ready() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    fixture.warm();
    wait_until("announcement of the first READY", || {
        lock(&notices).len() == 1
    });
    let first = pending(fixture.begin("entity"));
    assert!(matches!(
        first.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    first.finish(GraphTicketUse::Used);
    wait_until("rebuilt READY", || {
        fixture.plan.creates.load(Ordering::SeqCst) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
    // The owner serves a query only after the rebuild passed its announcement
    // check, so a notice from that READY is already recorded once this one is answered.
    let second = pending(fixture.begin("entity"));
    assert!(matches!(
        second.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    assert_eq!(lock(&notices).clone(), vec![PROJECT.to_string()]);
    second.finish(GraphTicketUse::Used);
}

#[test]
fn a_ready_for_one_project_does_not_consume_another_projects_waiting_demand() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    fixture.warm();
    wait_until("announcement of the first READY", || {
        lock(&notices).len() == 1
    });
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let first = pending(fixture.begin("entity"));
    // A window on another project is told busy while the slot is in use.
    let other = GraphQuery {
        project_id: "other-project".into(),
        ..fixture.query("entity")
    };
    assert!(matches!(
        fixture.state.nir1_graph.begin(&fixture.state, other),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        first.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    first.finish(GraphTicketUse::Used);
    wait_until("rebuilt READY", || {
        fixture.plan.creates.load(Ordering::SeqCst) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
    // The rebuilt READY is for the first project, which had no demand left waiting.
    let second = pending(fixture.begin("entity"));
    assert!(matches!(
        second.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    assert_eq!(lock(&notices).clone(), vec![PROJECT.to_string()]);
    // The other project is still waiting for a READY of its own.
    assert!(fixture
        .state
        .nir1_graph
        .shared
        .take_unserved("other-project"));
    second.finish(GraphTicketUse::Used);
}

#[test]
fn unserved_projects_are_distinct_bounded_and_taken_once() {
    let shared = Shared::new();
    assert!(!shared.take_unserved("a"));
    shared.mark_unserved("a");
    shared.mark_unserved("a");
    shared.mark_unserved("b");
    assert!(shared.take_unserved("a"));
    assert!(
        !shared.take_unserved("a"),
        "a project is announced once per wait"
    );
    assert!(shared.take_unserved("b"));
    // Past the bound the oldest project is forgotten.
    for index in 0..=MAX_UNSERVED_PROJECTS {
        shared.mark_unserved(&format!("project-{index}"));
    }
    assert!(!shared.take_unserved("project-0"));
    for index in 1..=MAX_UNSERVED_PROJECTS {
        assert!(shared.take_unserved(&format!("project-{index}")));
    }
}

#[test]
fn a_result_finished_unused_after_it_arrived_fills_the_cache_and_announces() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let notices = recording_notifier(&fixture);
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    // The result arrived first; only now does the caller report that it was unused.
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    ticket.finish(GraphTicketUse::Unused);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 1);
    assert_eq!(lock(&notices).clone(), vec![PROJECT.to_string()]);
    assert_eq!(fixture.diagnostics().late_cached, 1);
}

#[test]
fn dropping_an_unfinished_ticket_cancels_the_query_and_never_caches() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(fixture.begin("entity"));
    let waiter = ticket.waiter();
    wait_until("query started", || {
        fixture.plan.queries.load(Ordering::SeqCst) == 1
    });
    // The owner of the ticket goes away without settling it (the operation is released).
    drop(ticket);
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        waiter.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Cancelled))
    ));
    wait_until("cancelled query's worker retired", || {
        fixture.plan.retires.load(Ordering::SeqCst) == 1
    });
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert!(lock(&notices).is_empty());
}

#[test]
fn rebuild_waits_for_the_minimum_interval_after_the_previous_prepare() {
    let fixture = ProductFixture::new();
    let interval = Duration::from_millis(300);
    fixture
        .state
        .nir1_graph
        .set_config_for_test(GraphOwnerConfig {
            rebuild_min_interval: interval,
            idle_retire_after: Duration::from_secs(5),
            ..fast_config()
        });
    fixture.warm();
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(2)),
        Some(GraphTicketOutcome::Available(_))
    ));
    ticket.finish(GraphTicketUse::Used);
    wait_until("rebuilt READY", || {
        fixture.plan.creates.load(Ordering::SeqCst) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
    // The first worker is created before its prepare is recorded and the second
    // only after the interval, so this gap cannot be shorter than the interval.
    let created = lock(&fixture.plan.create_times).clone();
    assert!(
        created[1].duration_since(created[0]) >= interval,
        "the rebuild started {:?} after the previous worker",
        created[1].duration_since(created[0])
    );
}

#[test]
fn restore_is_refused_once_core_holds_the_fence_before_the_slot_reports_it() {
    let fixture = ProductFixture::new();
    fixture.warm();
    // The worker's retirement stalls after its fence was taken and before the
    // owner publishes the slot as Quarantined.
    fixture.plan.retire_hold.store(true, Ordering::SeqCst);
    *lock(&fixture.plan.query_mode) = QueryMode::QuarantineFence;
    let ticket = pending(fixture.begin("entity"));
    wait_until("retirement started", || {
        fixture.plan.retire_started.load(Ordering::SeqCst) == 1
    });
    assert_ne!(fixture.kind(), GraphSlotKind::Quarantined);
    assert!(fixture
        .state
        .nir1_graph
        .blocks_restore_of_current_workspace(&fixture.state));
    fixture.plan.retire_release.store(true, Ordering::SeqCst);
    wait_until("quarantined slot", || {
        fixture.kind() == GraphSlotKind::Quarantined
    });
    ticket.finish(GraphTicketUse::Used);
}

/// Core holds no fence for a retained participant, so only the entries can
/// refuse, and none of them may wait for a physical exclusion that never comes.
async fn assert_every_open_and_restore_is_refused(fixture: &RefusalFixture) {
    assert!(fixture
        .state()
        .ws
        .lifecycle_core()
        .c_query_quarantine_binding()
        .expect("fence record")
        .is_none());
    for (what, target) in [("W1", &fixture.w1), ("W2", &fixture.w2)] {
        let open = within_two_seconds(
            &format!("Open of {what}"),
            fixture
                .backend
                .open_workspace(target.to_string_lossy().into_owned()),
        )
        .await;
        let open: serde_json::Value = serde_json::from_str(&open).expect("open JSON");
        assert_eq!(open["status"], "not-admitted", "{what}");
        assert_eq!(
            open["reasonCode"], NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE,
            "{what}"
        );
    }
    let restore = within_two_seconds(
        "Restore",
        fixture.backend.restore_backup("missing.db".to_string()),
    )
    .await;
    let restore: serde_json::Value = serde_json::from_str(&restore).expect("restore JSON");
    assert_eq!(restore["status"], "not-admitted");
    assert_eq!(
        restore["reasonCode"],
        NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE
    );
}

#[tokio::test]
async fn retained_participant_quarantine_refuses_every_open_and_restore_within_two_seconds() {
    let fixture = RefusalFixture::new("participant-refusal");
    fixture.quarantine_w1(QueryMode::QuarantineParticipant);
    assert_every_open_and_restore_is_refused(&fixture).await;
    // Nothing was admitted, so Core is still Ready and not stuck in a transition.
    assert!(matches!(
        fixture
            .state()
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("snapshot")
            .state,
        LifecycleState::Ready(_)
    ));
}

/// The way the review reached it: a maintenance failure moves Core from Ready
/// to RecoveryRequired, the Unavailable edge retires the READY worker, and its
/// cleanup is not proved, so Core records no fence and the participant stays.
#[tokio::test]
async fn participant_quarantine_at_the_unavailable_edge_refuses_every_open_and_restore() {
    let fixture = RefusalFixture::new("participant-edge");
    let state = fixture.state();
    let query = GraphQuery {
        project_id: PROJECT.into(),
        query_scene_id: SCENE.into(),
        seed_entity_id: "entity".into(),
    };
    assert!(matches!(
        state.nir1_graph.begin(state, query),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("READY for w1", || {
        state.nir1_graph.slot_kind_for_test() == GraphSlotKind::Ready
    });
    fixture
        .plan
        .retire_leaks_participant
        .store(true, Ordering::SeqCst);
    state
        .ws
        .lifecycle_core()
        .mark_safe_mode_recovery_required()
        .expect("Core leaves Ready");
    wait_until("quarantined w1", || state.nir1_graph.is_quarantined());
    assert!(matches!(
        state
            .ws
            .lifecycle_core()
            .snapshot()
            .expect("snapshot")
            .state,
        LifecycleState::RecoveryRequired { .. }
    ));
    assert_every_open_and_restore_is_refused(&fixture).await;
}

#[test]
fn open_entry_refuses_only_when_the_quarantine_retained_a_participant() {
    let fixture = ProductFixture::new();
    assert!(fixture
        .state
        .nir1_graph
        .refuse_open_while_participant_quarantined(&fixture.state)
        .is_none());
    fixture.warm();
    *lock(&fixture.plan.query_mode) = QueryMode::QuarantineFence;
    let ticket = pending(fixture.begin("entity"));
    wait_until("fenced slot", || {
        fixture.kind() == GraphSlotKind::Quarantined
    });
    // A fence keeps Core's own refusal; the entry adds nothing of its own.
    assert!(fixture
        .state
        .nir1_graph
        .refuse_open_while_participant_quarantined(&fixture.state)
        .is_none());
    ticket.finish(GraphTicketUse::Used);
}

// ---------------------------------------------------------------------------
// DI-1a S3: the READY signal D-final waits on (DSN §1.3 E7, DR-DI1A-5).
// ---------------------------------------------------------------------------

#[test]
fn the_ready_signal_moves_when_a_session_reaches_ready_and_when_it_ends() {
    let fixture = ProductFixture::new();
    let owner = &fixture.state.nir1_graph;
    let start = owner.ready_signal_generation();
    // A wait that nothing answers ends at its bound.
    let started = Instant::now();
    assert!(!owner.wait_ready_signal(start, Duration::from_millis(40)));
    assert!(started.elapsed() >= Duration::from_millis(40));
    assert!(started.elapsed() < Duration::from_secs(2));

    // READY: a waiter that read the generation before `begin` is woken.
    let waiter = {
        let state = Arc::clone(&fixture.state);
        thread::spawn(move || {
            state
                .nir1_graph
                .wait_ready_signal(start, Duration::from_secs(5))
        })
    };
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    assert!(waiter.join().expect("waiter"));
    wait_until("READY", || fixture.kind() == GraphSlotKind::Ready);
    let ready = owner.ready_signal_generation();
    assert_ne!(ready, start);
    // A generation already past the one a waiter holds returns at once.
    assert!(owner.wait_ready_signal(start, Duration::from_secs(5)));

    // The end of the session moves it again, so a waiter re-reads the slot.
    let waiter = {
        let state = Arc::clone(&fixture.state);
        thread::spawn(move || {
            state
                .nir1_graph
                .wait_ready_signal(ready, Duration::from_secs(5))
        })
    };
    owner.close_for_shutdown();
    assert!(waiter.join().expect("waiter"));
    assert!(owner.is_closed());
}

#[test]
fn a_lifecycle_edge_moves_the_ready_signal_and_the_edge_epoch() {
    let fixture = ProductFixture::new();
    let owner = &fixture.state.nir1_graph;
    let before = owner.ready_signal_generation();
    let epoch = owner.edge_epoch();
    let observer = owner.edge_observer_for_test();
    observer.on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: 1 });
    assert_ne!(owner.ready_signal_generation(), before);
    assert_ne!(owner.edge_epoch(), epoch);
}
