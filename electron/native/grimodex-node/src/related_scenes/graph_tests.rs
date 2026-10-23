//! CP-3a S2a tests: the Graph slot of a Related Scenes operation, its await,
//! its settle declaration and the wire that carries them. A fake worker drives
//! the product owner. An `Operation` needs a live Chronicle index proof that
//! only the database crate can build, so the paths that end a lease (release,
//! owner release, invalidation, a workspace transition, expiry, the hand-over
//! in `begin`, settle) are generic over `LeaseEnd` and run here on a registry
//! of `FakeOperation`s, each with a real Graph ticket (DR-CP3A-46).
use super::*;
use crate::nir1_graph_product::{
    GraphReadyNotice, GraphSlotKind, GraphWorker, GraphWorkerFactory, GraphWorkerStart,
};
use grimodex_db::narrative_extraction::nir1_graph::{
    c_query_worker::CQueryRetirement, Nir1QualifiedGraph,
};
use grimodex_db::narrative_extraction::Nir1GraphRequest;
use grimodex_db::state::ActiveWorkspaceSnapshot;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const PROJECT: &str = "graph-project";
const SCENE: &str = "graph-scene";
const SEED: &str = "seed-entity";

#[derive(Clone, Copy, Default)]
enum QueryMode {
    #[default]
    Ok,
    Hold,
    Unavailable(grimodex_db::narrative_extraction::nir1_graph::worker_frame::UnavailableReason),
}

#[derive(Default)]
struct FakePlan {
    creates: AtomicUsize,
    queries: AtomicUsize,
    query_mode: Mutex<QueryMode>,
    release: AtomicBool,
}

struct FakeFactory(Arc<FakePlan>);

impl GraphWorkerFactory for FakeFactory {
    fn create(&self, start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        self.0.creates.fetch_add(1, Ordering::SeqCst);
        Box::new(FakeWorker {
            plan: Arc::clone(&self.0),
            snapshot: Some(start.snapshot),
        })
    }
}

struct FakeWorker {
    plan: Arc<FakePlan>,
    snapshot: Option<ActiveWorkspaceSnapshot>,
}

impl GraphWorker for FakeWorker {
    fn prepare(&mut self, _project_id: &str) -> Result<()> {
        Ok(())
    }

    fn query(
        &mut self,
        request: &Nir1GraphRequest,
        cancel: &AtomicBool,
    ) -> Result<grimodex_db::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection>
    {
        self.plan.queries.fetch_add(1, Ordering::SeqCst);
        let mode = *self.plan.query_mode.lock().expect("query mode");
        match mode {
            QueryMode::Ok => {}
            QueryMode::Hold => {
                while !self.plan.release.load(Ordering::SeqCst) && !cancel.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("NIR1_GRAPH_WORKER_CALLER_CANCELLED"));
                }
            }
            QueryMode::Unavailable(reason) => {
                return Err(
                    grimodex_db::narrative_extraction::nir1_graph::c_query_worker::CQueryWorkerUnavailable {
                        reason,
                    }
                    .into(),
                )
            }
        }
        Ok(
            grimodex_db::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection {
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
            },
        )
    }

    fn quarantined(&self) -> bool {
        false
    }

    fn retire(self: Box<Self>) -> CQueryRetirement {
        drop(self.snapshot);
        CQueryRetirement::Retired
    }
}

fn set_mode(plan: &FakePlan, mode: QueryMode) {
    *plan.query_mode.lock().expect("query mode") = mode;
}

fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

struct Fixture {
    root: PathBuf,
    state: Arc<AppState>,
    plan: Arc<FakePlan>,
    /// Graph-ready notices already seen when the worker became READY: warming
    /// a demand that was told to wait announces its own READY (CP-2a).
    warm_notices: AtomicUsize,
}

impl Fixture {
    fn new() -> Self {
        Self::with(true, true)
    }

    /// `publish` opens the test-only publication gate; `restricted` activates
    /// the restricted D2a profile. The fake worker is always installed.
    fn with(publish: bool, restricted: bool) -> Self {
        let root = std::env::temp_dir().join(format!("related-graph-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
        std::fs::write(
            root.join(".grimodex/workspace.json"),
            r#"{"id":"related-graph-workspace"}"#,
        )
        .expect("workspace metadata");
        let backend =
            crate::Backend::new(root.join("app").to_string_lossy().into_owned(), None, None)
                .expect("Native backend");
        let state = Arc::clone(&backend.state);
        let db = grimodex_db::Database::new(&root.join("grimodex.db")).expect("database");
        db.migrate().expect("schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects(id,title) VALUES (?1,'Graph')",
                [PROJECT],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                 VALUES (?1, ?2, 'scene', 'Scene', '')",
                [SCENE, PROJECT],
            )?;
            Ok(())
        })
        .expect("workspace rows");
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
                .activate_first_restricted_publication(true)
                .expect("restricted profile");
        }
        let plan = Arc::new(FakePlan::default());
        if publish {
            state.nir1_graph.open_publication_for_test();
        }
        state
            .nir1_graph
            .set_config_for_test(crate::nir1_graph_product::GraphOwnerConfig {
                idle_retire_after: Duration::from_millis(300),
                rebuild_min_interval: Duration::from_millis(30),
                failure_backoff_initial: Duration::from_millis(20),
                failure_backoff_max: Duration::from_millis(80),
                failures_before_suspend: 5,
                cache_ttl: Duration::from_secs(5),
            });
        state
            .nir1_graph
            .install_worker_factory_for_test(Arc::new(FakeFactory(Arc::clone(&plan))));
        Self {
            root,
            state,
            plan,
            warm_notices: AtomicUsize::new(0),
        }
    }

    fn query() -> GraphQuery {
        GraphQuery {
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: SEED.into(),
        }
    }

    /// Warms the worker until the next query is accepted.
    fn warm(&self) {
        let _ = self.state.nir1_graph.begin(&self.state, Self::query());
        wait_until("READY", || {
            self.state.nir1_graph.slot_kind_for_test() == GraphSlotKind::Ready
        });
        wait_until("the READY notice", || !self.all_graph_events().is_empty());
        self.warm_notices
            .store(self.all_graph_events().len(), Ordering::SeqCst);
    }

    /// A state that started a pending query.
    fn pending(&self) -> GraphState {
        self.warm();
        let graph = GraphState::default();
        let wire = graph.start(&self.state, Self::query());
        assert_eq!(wire, json!({"status": "pending"}));
        graph
    }

    /// The notices after the warm-up: what the operation under test caused.
    fn graph_events(&self) -> Vec<String> {
        let skip = self.warm_notices.load(Ordering::SeqCst);
        self.all_graph_events().into_iter().skip(skip).collect()
    }

    fn all_graph_events(&self) -> Vec<String> {
        self.state
            .events
            .pending_for_test()
            .into_iter()
            .filter(|(channel, _)| channel == "related-scenes:graph-ready")
            .map(|(_, payload)| payload)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.plan.release.store(true, Ordering::SeqCst);
        self.state.nir1_graph.close_for_shutdown();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !matches!(
                self.state.nir1_graph.slot_kind_for_test(),
                GraphSlotKind::Closed | GraphSlotKind::Empty | GraphSlotKind::Quarantined
            )
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Lets a held query go and waits until the worker has returned it, so what
/// the ticket's end caused (a cache entry, a notice) has happened by then.
fn let_the_query_end(fixture: &Fixture) {
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("the query to leave the worker", || {
        fixture.state.nir1_graph.slot_kind_for_test() != GraphSlotKind::InUse
    });
}

fn live_ir(ir: IrState) -> impl Fn() -> LeaseProbe {
    move || LeaseProbe { live: true, ir }
}

fn plan_of(claim: Claim) -> AwaitPlan {
    match claim {
        Claim::Await(plan) => plan,
        Claim::Reply(reason) => panic!("expected an await plan, got a reply {}", reason.as_str()),
        Claim::Violation => panic!("expected an await plan, got a violation"),
    }
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn dense(values: &[&str]) -> HashSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

// ---- begin ---------------------------------------------------------------

#[test]
fn begin_without_a_lease_is_not_requested_and_does_not_touch_the_owner() {
    // D6 (N-5): no IR operation, no Graph query. N-1's seedless half is the
    // `begin_blocking` shape: `graph_wire` is `None`, so no `graph` key exists.
    let fixture = Fixture::new();
    let wire = begin_graph::<FakeOperation>(&fixture.state, None, PROJECT, SCENE, SEED);
    assert_eq!(wire, graph_unavailable(GraphUnavailable::NotRequested));
    assert_eq!(fixture.state.nir1_graph.diagnostics().begins, 0);
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
}

#[test]
fn begin_with_seed_while_pub_g_is_closed_reports_not_activated_and_runs_no_query() {
    // N-2: the gate is closed in production (`PRODUCT_GRAPH_PUBLISHED` is
    // false). The fixture leaves the test gate closed, as production does.
    let fixture = Fixture::with(false, true);
    let graph = GraphState::default();
    let wire = graph.start(&fixture.state, Fixture::query());
    assert_eq!(wire, graph_unavailable(GraphUnavailable::NotActivated));
    assert_eq!(wire["reason"], "not-activated");
    let diagnostics = fixture.state.nir1_graph.diagnostics();
    assert_eq!(diagnostics.begins, 1);
    assert_eq!(
        diagnostics.unavailable[GraphUnavailable::NotActivated as usize],
        1
    );
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.state.nir1_graph.slot_kind_for_test(),
        GraphSlotKind::Empty
    );
    // The await answers the same reason at once: no wait, no read, no claim.
    for _ in 0..2 {
        match graph.claim(&[]) {
            Claim::Reply(GraphUnavailable::NotActivated) => {}
            _ => panic!("a closed gate must answer not-activated"),
        }
    }
    assert_eq!(fixture.state.nir1_graph.diagnostics().begins, 1);
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
}

#[test]
fn an_unrestricted_profile_never_starts_a_query() {
    let fixture = Fixture::with(true, false);
    let graph = GraphState::default();
    let wire = graph.start(&fixture.state, Fixture::query());
    assert_eq!(wire["reason"], "profile-not-restricted");
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
}

#[test]
fn begin_with_seed_and_ready_owner_returns_pending_without_a_ticket_string() {
    // N-3: `pending`, and the wire carries no ticket of its own (D1).
    let fixture = Fixture::new();
    let graph = fixture.pending();
    assert!(!graph.is_settled());
    assert_eq!(graph_pending().as_object().expect("object").len(), 1);
}

#[test]
fn a_cache_hit_answers_pending_and_waits_for_nothing() {
    let fixture = Fixture::new();
    let first = fixture.pending();
    first.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(first.claim(&[]));
    let outcome = await_graph(
        &fixture.state,
        &first,
        &plan,
        Duration::from_secs(2),
        live_ir(IrState::Available),
    );
    assert!(matches!(outcome, GraphAwait::Ready(_)));
    // The renderer did not use it: the late result fills the cache once.
    first.declare(GraphTicketUse::Unused);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 1);
    let second = GraphState::default();
    let wire = second.start(&fixture.state, Fixture::query());
    assert_eq!(wire, json!({"status": "pending"}));
    second.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(second.claim(&[]));
    let started = Instant::now();
    let outcome = await_graph(
        &fixture.state,
        &second,
        &plan,
        Duration::from_secs(2),
        live_ir(IrState::Available),
    );
    assert!(matches!(outcome, GraphAwait::Ready(_)));
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn begin_never_waits_for_the_graph() {
    // N-4: the query holds, and `start` still returns at once.
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = GraphState::default();
    let started = Instant::now();
    let wire = graph.start(&fixture.state, Fixture::query());
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(wire, json!({"status": "pending"}));
    graph.cancel();
}

// ---- cancellation ----------------------------------------------------------

#[test]
fn cancelling_the_slot_cancels_the_ticket_and_never_caches_or_announces() {
    // N-6: every lease-level cancellation is this call.
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = GraphState::default();
    graph.start(&fixture.state, Fixture::query());
    graph.set_dense_scene_ids(dense(&["a"]));
    let plan = plan_of(graph.claim(&ids(&["a"])));
    graph.cancel();
    assert!(graph.is_settled());
    fixture.plan.release.store(true, Ordering::SeqCst);
    let outcome = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_secs(2),
        live_ir(IrState::Available),
    );
    assert!(matches!(
        outcome,
        GraphAwait::Unavailable(GraphUnavailable::Cancelled)
    ));
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert!(fixture.graph_events().is_empty());
    // A second cancel, and a late declaration, do nothing.
    graph.cancel();
    graph.declare(GraphTicketUse::Unused);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
}

#[test]
fn dropping_the_slot_cancels_a_running_query() {
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = GraphState::default();
    graph.start(&fixture.state, Fixture::query());
    drop(graph);
    let_the_query_end(&fixture);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert!(fixture.graph_events().is_empty());
}

// ---- the paths that end a lease (DR-CP3A-46) ---------------------------------

/// An operation with only what the end of a lease touches.
#[derive(Default)]
struct FakeOperation {
    graph: GraphState,
    completed: Notify,
}

impl LeaseEnd for FakeOperation {
    fn graph(&self) -> &GraphState {
        &self.graph
    }

    fn completed(&self) -> &Notify {
        &self.completed
    }
}

const OWNER: &str = "owner-a";
const OTHER_OWNER: &str = "owner-b";

struct Leases {
    fixture: Fixture,
    registry: Mutex<RelatedScenesRegistry<FakeOperation>>,
}

impl Leases {
    fn new(ttl: Duration) -> Self {
        let fixture = Fixture::new();
        fixture.warm();
        set_mode(&fixture.plan, QueryMode::Hold);
        Self {
            fixture,
            registry: Mutex::new(RelatedScenesRegistry::new(8, ttl)),
        }
    }

    /// A live lease of `owner` with no Graph query (the owner runs one query
    /// at a time, so only one lease of a test can have one).
    fn idle(&self, owner: &str) -> (String, LeaseOf<FakeOperation>) {
        let ticket = lock(&self.registry)
            .expect("registry")
            .insert(
                owner,
                SnapshotEligibility {
                    original_snapshot_usable: true,
                    supported_profile: true,
                },
                FakeOperation::default(),
                Instant::now(),
            )
            .expect("capacity");
        let lease = owned_in(&self.registry, owner, &ticket)
            .expect("registry")
            .expect("lease");
        (ticket, lease)
    }

    /// A live lease of `owner` whose Graph query `begin_graph` started.
    fn running(&self, owner: &str) -> (String, LeaseOf<FakeOperation>) {
        let (ticket, lease) = self.idle(owner);
        let wire = begin_graph(&self.fixture.state, Some(&lease), PROJECT, SCENE, SEED);
        assert_eq!(wire, graph_pending());
        assert!(!lease.data.graph.is_settled());
        (ticket, lease)
    }

    fn is_registered(&self, ticket: &str) -> bool {
        lock(&self.registry)
            .expect("registry")
            .entries()
            .iter()
            .any(|(key, _)| key == ticket)
    }

    /// The path cancelled the ticket: it is settled at once, and the query's
    /// result reaches neither the cache nor `graph-ready`.
    fn assert_cancelled(&self, lease: &LeaseOf<FakeOperation>, path: &str) {
        assert!(
            lease.data.graph.is_settled(),
            "{path} must cancel the Graph ticket"
        );
        let_the_query_end(&self.fixture);
        assert_eq!(
            self.fixture.state.nir1_graph.cache_len_for_test(),
            0,
            "{path}"
        );
        assert!(self.fixture.graph_events().is_empty(), "{path}");
    }
}

#[test]
fn a_release_cancels_the_graph_ticket_of_its_own_lease_only() {
    let leases = Leases::new(TTL);
    let (ticket, lease) = leases.running(OWNER);
    // Another owner's release of the same ticket changes nothing.
    release_from(&leases.registry, OTHER_OWNER, &ticket).expect("release");
    assert!(!lease.data.graph.is_settled());
    release_from(&leases.registry, OWNER, &ticket).expect("release");
    assert!(!leases.is_registered(&ticket));
    leases.assert_cancelled(&lease, "release");
}

#[test]
fn an_owner_release_cancels_the_graph_ticket_of_every_lease_of_the_owner() {
    let leases = Leases::new(TTL);
    let (ticket, lease) = leases.running(OWNER);
    let (other, _) = leases.idle(OTHER_OWNER);
    assert_eq!(
        release_owner_from(&leases.registry, OWNER).expect("owner release"),
        1
    );
    assert!(!leases.is_registered(&ticket));
    assert!(leases.is_registered(&other));
    leases.assert_cancelled(&lease, "release_owner");
}

#[test]
fn an_invalidation_cancels_the_graph_ticket() {
    // `invalidate` (a stale operation, `reconcile`, an expired `continue` or
    // await) is this call plus the withdrawal signal.
    let leases = Leases::new(TTL);
    let (ticket, lease) = leases.running(OWNER);
    assert!(invalidate_from_registry(&leases.registry, &ticket, &lease).expect("invalidate"));
    // A second invalidation finds nothing.
    assert!(!invalidate_from_registry(&leases.registry, &ticket, &lease).expect("invalidate"));
    leases.assert_cancelled(&lease, "invalidate_from_registry");
}

#[test]
fn a_workspace_transition_cancels_the_graph_ticket_of_every_lease() {
    let leases = Leases::new(TTL);
    let (first_ticket, first) = leases.running(OWNER);
    let (second_ticket, _) = leases.idle(OTHER_OWNER);
    assert_eq!(stop_every_lease(&leases.registry).expect("transition"), 2);
    assert!(!leases.is_registered(&first_ticket));
    assert!(!leases.is_registered(&second_ticket));
    leases.assert_cancelled(&first, "stop_for_workspace_transition");
}

#[test]
fn an_expired_lease_is_swept_and_its_graph_ticket_cancelled() {
    let leases = Leases::new(Duration::from_millis(200));
    let (ticket, lease) = leases.running(OWNER);
    // A live lease is not swept.
    assert!(invalidate_expired(&leases.registry, Instant::now())
        .expect("sweep")
        .is_empty());
    assert!(!lease.data.graph.is_settled());
    wait_until("the lease to expire", || !lease.is_live(Instant::now()));
    let swept = invalidate_expired(&leases.registry, Instant::now()).expect("sweep");
    assert_eq!(swept.len(), 1);
    assert!(Arc::ptr_eq(&swept[0], &lease));
    assert!(!leases.is_registered(&ticket));
    leases.assert_cancelled(&lease, "the expiry sweep");
}

#[test]
fn a_lease_that_died_during_the_hand_over_cancels_the_ticket() {
    let leases = Leases::new(TTL);
    let (ticket, lease) = leases.idle(OWNER);
    // The operation is invalidated before `begin_graph` hands the query over.
    assert!(lock(&leases.registry)
        .expect("registry")
        .invalidate(&ticket));
    let wire = begin_graph(&leases.fixture.state, Some(&lease), PROJECT, SCENE, SEED);
    // The owner accepted the query, so the wire says `pending`; the ticket is
    // already cancelled and the await will answer `cancelled`.
    assert_eq!(wire, graph_pending());
    leases.assert_cancelled(&lease, "begin_graph's liveness check");
}

#[test]
fn settle_declares_only_on_a_live_lease_of_its_owner() {
    let leases = Leases::new(TTL);
    let (ticket, lease) = leases.running(OWNER);
    assert!(matches!(
        settle_in(
            &leases.registry,
            OTHER_OWNER,
            &ticket,
            GraphTicketUse::Unused,
            Instant::now()
        )
        .expect("settle"),
        Settled::Unknown
    ));
    assert!(!lease.data.graph.is_settled());
    assert!(matches!(
        settle_in(
            &leases.registry,
            OWNER,
            &ticket,
            GraphTicketUse::Unused,
            Instant::now()
        )
        .expect("settle"),
        Settled::Declared
    ));
    assert!(leases.is_registered(&ticket));
    let_the_query_end(&leases.fixture);
    wait_until("the late cache", || {
        leases.fixture.state.nir1_graph.cache_len_for_test() == 1
    });
}

#[test]
fn settle_on_an_expired_lease_cancels_and_never_caches_or_announces() {
    // Contract P3-7 / safety P3-4: `unused` on an expired lease must not put
    // the late result into the cache or announce it.
    let leases = Leases::new(Duration::from_millis(200));
    let (ticket, lease) = leases.running(OWNER);
    wait_until("the lease to expire", || !lease.is_live(Instant::now()));
    let settled = settle_in(
        &leases.registry,
        OWNER,
        &ticket,
        GraphTicketUse::Unused,
        Instant::now(),
    )
    .expect("settle");
    let Settled::Expired(expired) = settled else {
        panic!("an expired lease takes no declaration");
    };
    assert!(Arc::ptr_eq(&expired, &lease));
    assert!(!leases.is_registered(&ticket));
    leases.assert_cancelled(&lease, "settle on an expired lease");
    // The ticket is gone: a second settle finds nothing.
    assert!(matches!(
        settle_in(
            &leases.registry,
            OWNER,
            &ticket,
            GraphTicketUse::Unused,
            Instant::now()
        )
        .expect("settle"),
        Settled::Unknown
    ));
}

// ---- settle ---------------------------------------------------------------

#[test]
fn settle_unused_before_the_result_caches_and_announces_the_project_once() {
    // N-13.
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = GraphState::default();
    graph.start(&fixture.state, Fixture::query());
    graph.declare(GraphTicketUse::Unused);
    // The declaration is first; a later one changes nothing.
    graph.declare(GraphTicketUse::Used);
    graph.declare(GraphTicketUse::Cancelled);
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("late cache", || {
        fixture.state.nir1_graph.cache_len_for_test() == 1
    });
    assert_eq!(
        fixture.graph_events(),
        vec![json!({"projectId": PROJECT}).to_string()]
    );
}

#[test]
fn settle_used_and_cancelled_never_cache_or_announce() {
    for use_ in [GraphTicketUse::Used, GraphTicketUse::Cancelled] {
        let fixture = Fixture::new();
        fixture.warm();
        set_mode(&fixture.plan, QueryMode::Hold);
        let graph = GraphState::default();
        graph.start(&fixture.state, Fixture::query());
        graph.declare(use_);
        let_the_query_end(&fixture);
        assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0, "{use_:?}");
        assert!(fixture.graph_events().is_empty(), "{use_:?}");
    }
}

#[test]
fn settle_after_the_result_arrived_caches_only_when_unused() {
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    assert!(matches!(
        await_graph(
            &fixture.state,
            &graph,
            &plan,
            Duration::from_secs(2),
            live_ir(IrState::Available)
        ),
        GraphAwait::Ready(_)
    ));
    graph.declare(GraphTicketUse::Used);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert!(fixture.graph_events().is_empty());
}

#[test]
fn settle_releases_an_outstanding_await_without_reading_anything() {
    // N-14: the await is on another thread; the declaration ends it.
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = Arc::new(GraphState::default());
    graph.start(&fixture.state, Fixture::query());
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    let state = Arc::clone(&fixture.state);
    let waiting_graph = Arc::clone(&graph);
    let waiter = std::thread::spawn(move || {
        await_graph(
            &state,
            &waiting_graph,
            &plan,
            Duration::from_secs(5),
            live_ir(IrState::Available),
        )
    });
    std::thread::sleep(Duration::from_millis(60));
    let settled_at = Instant::now();
    graph.declare(GraphTicketUse::Used);
    let outcome = waiter.join().expect("await thread");
    assert!(matches!(
        outcome,
        GraphAwait::Unavailable(GraphUnavailable::Cancelled)
    ));
    assert!(settled_at.elapsed() < Duration::from_secs(1));
}

// ---- the await ----------------------------------------------------------------

#[test]
fn the_await_is_bounded_and_returns_timeout() {
    // N-12: a ticket that never resolves ends at the limit.
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = GraphState::default();
    graph.start(&fixture.state, Fixture::query());
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    let started = Instant::now();
    let outcome = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_millis(120),
        live_ir(IrState::Available),
    );
    assert!(matches!(
        outcome,
        GraphAwait::Unavailable(GraphUnavailable::Timeout)
    ));
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(120), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    graph.cancel();
}

#[test]
fn the_await_limit_is_the_documented_two_seconds_and_a_step_is_shorter() {
    assert_eq!(GRAPH_AWAIT_LIMIT, Duration::from_secs(2));
    assert!(GRAPH_WAIT_STEP < Duration::from_millis(100));
}

#[test]
fn the_await_waits_for_the_ir_response_too_and_gives_up_with_timeout() {
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    let outcome = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_millis(100),
        live_ir(IrState::Pending),
    );
    assert!(matches!(
        outcome,
        GraphAwait::Unavailable(GraphUnavailable::Timeout)
    ));
    // The IR response arriving later releases the same await.
    let late_ir = AtomicBool::new(false);
    let started = Instant::now();
    let outcome = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_secs(2),
        || {
            if started.elapsed() > Duration::from_millis(80) {
                late_ir.store(true, Ordering::SeqCst);
            }
            LeaseProbe {
                live: true,
                ir: if late_ir.load(Ordering::SeqCst) {
                    IrState::Available
                } else {
                    IrState::Pending
                },
            }
        },
    );
    assert!(matches!(outcome, GraphAwait::Ready(_)));
}

#[test]
fn a_stopped_chronicle_stops_the_graph_and_a_stopped_graph_leaves_the_ir_alone() {
    // N-15. The IR half: the await only reads the IR response, never writes it.
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    let outcome = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_secs(2),
        live_ir(IrState::Unavailable),
    );
    assert!(matches!(
        outcome,
        GraphAwait::Unavailable(GraphUnavailable::Cancelled)
    ));
    let lease_gone = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_secs(2),
        || LeaseProbe {
            live: false,
            ir: IrState::Available,
        },
    );
    assert!(matches!(
        lease_gone,
        GraphAwait::Unavailable(GraphUnavailable::Invalidated)
    ));
}

#[test]
fn a_graph_that_failed_is_reported_with_its_own_reason() {
    use grimodex_db::narrative_extraction::nir1_graph::worker_frame::UnavailableReason;
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(
        &fixture.plan,
        QueryMode::Unavailable(UnavailableReason::SeedNotFound),
    );
    let graph = GraphState::default();
    graph.start(&fixture.state, Fixture::query());
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    let outcome = await_graph(
        &fixture.state,
        &graph,
        &plan,
        Duration::from_secs(2),
        live_ir(IrState::Available),
    );
    // Whatever the closed reason is, it is one of the 14 and not a hang.
    match outcome {
        GraphAwait::Unavailable(reason) => {
            assert!(GraphUnavailable::ALL.contains(&reason));
        }
        GraphAwait::Ready(_) => panic!("a failed query is not ready"),
    }
}

#[test]
fn shutdown_and_a_lifecycle_edge_end_the_await_in_finite_time() {
    // N-16: the epoch moves, the await returns invalidated within a step.
    let fixture = Fixture::new();
    fixture.warm();
    set_mode(&fixture.plan, QueryMode::Hold);
    let graph = Arc::new(GraphState::default());
    graph.start(&fixture.state, Fixture::query());
    graph.set_dense_scene_ids(dense(&[]));
    let plan = plan_of(graph.claim(&[]));
    let state = Arc::clone(&fixture.state);
    let waiting_graph = Arc::clone(&graph);
    let waiter = std::thread::spawn(move || {
        await_graph(
            &state,
            &waiting_graph,
            &plan,
            Duration::from_secs(5),
            live_ir(IrState::Available),
        )
    });
    std::thread::sleep(Duration::from_millis(60));
    let before = Instant::now();
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(
            &grimodex_db::workspace_lifecycle::LifecycleEdge::Unavailable { revision: u64::MAX },
        );
    let outcome = waiter.join().expect("await thread");
    assert!(
        matches!(
            outcome,
            GraphAwait::Unavailable(GraphUnavailable::Invalidated | GraphUnavailable::Cancelled)
        ),
        "the edge must end the await"
    );
    assert!(before.elapsed() < Duration::from_secs(2));
    graph.cancel();
}

// ---- the claim ---------------------------------------------------------------

#[test]
fn an_operation_verifies_once_and_a_second_await_is_cancelled() {
    // P2-1: no memo; the second call answers cancelled and changes nothing.
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&["a", "b"]));
    assert!(matches!(graph.claim(&ids(&["a"])), Claim::Await(_)));
    for raw in [ids(&["a"]), ids(&["b"]), Vec::new()] {
        match graph.claim(&raw) {
            Claim::Reply(GraphUnavailable::Cancelled) => {}
            _ => panic!("a second await must be cancelled"),
        }
    }
    assert!(!graph.is_settled(), "the first await is not disturbed");
}

#[test]
fn a_claimed_r_outside_the_dense_hits_is_refused() {
    // P1-2: R is a selection out of the dense hits.
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&["a", "b", "c"]));
    assert!(matches!(graph.claim(&ids(&["a", "x"])), Claim::Violation));
    // The state is not claimed by a refusal; the caller cancels the Graph.
    graph.cancel();
    assert!(matches!(
        graph.claim(&ids(&["a"])),
        Claim::Reply(GraphUnavailable::Cancelled)
    ));
}

#[test]
fn a_subset_of_the_dense_hits_is_accepted_even_when_empty() {
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&["a", "b", "c"]));
    assert!(matches!(graph.claim(&[]), Claim::Await(_)));
}

#[test]
fn a_claim_before_begin_recorded_the_dense_hits_is_a_violation() {
    let fixture = Fixture::new();
    let graph = fixture.pending();
    assert!(matches!(graph.claim(&ids(&["a"])), Claim::Violation));
    assert!(matches!(graph.claim(&[]), Claim::Violation));
}

#[test]
fn the_pending_query_is_not_cached_when_the_claim_is_refused() {
    let fixture = Fixture::new();
    let graph = fixture.pending();
    graph.set_dense_scene_ids(dense(&["a"]));
    assert!(matches!(graph.claim(&ids(&["z"])), Claim::Violation));
    graph.cancel();
    let_the_query_end(&fixture);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
}

// ---- the wire ---------------------------------------------------------------

#[test]
fn graph_continue_parses_exactly_the_two_shapes() {
    let await_request = GraphContinueRequest::parse(json!({
        "operationTicket": "t", "rawSceneIds": ["a", "b"]
    }))
    .expect("await");
    assert_eq!(
        await_request,
        GraphContinueRequest::Await {
            operation_ticket: "t".into(),
            raw_scene_ids: ids(&["a", "b"]),
        }
    );
    for (text, expected) in [
        ("used", SettleWire::Used),
        ("unused", SettleWire::Unused),
        ("cancelled", SettleWire::Cancelled),
    ] {
        assert_eq!(
            GraphContinueRequest::parse(json!({"operationTicket": "t", "settle": text}))
                .expect("settle"),
            GraphContinueRequest::Settle {
                operation_ticket: "t".into(),
                settle: expected,
            }
        );
    }
}

#[test]
fn graph_continue_rejects_malformed_requests_and_unknown_fields() {
    // N-19.
    let long_id = "x".repeat(201);
    let bad = [
        json!({}),
        json!({"operationTicket": "t"}),
        json!({"operationTicket": "  ", "rawSceneIds": []}),
        json!({"operationTicket": "t", "rawSceneIds": [], "settle": "used"}),
        json!({"operationTicket": "t", "settle": "later"}),
        json!({"operationTicket": "t", "settle": 1}),
        json!({"operationTicket": "t", "rawSceneIds": [], "extra": true}),
        json!({"operationTicket": "t", "rawSceneIds": "a"}),
        json!({"operationTicket": "t", "rawSceneIds": ["a", "a"]}),
        json!({"operationTicket": "t", "rawSceneIds": [""]}),
        json!({"operationTicket": "t", "rawSceneIds": [" "]}),
        json!({"operationTicket": "t", "rawSceneIds": [long_id]}),
        json!({"operationTicket": "t", "rawSceneIds": [1]}),
        json!({"operationTicket": "x".repeat(201), "rawSceneIds": []}),
        json!({"ownerKey": "o", "operationTicket": "t", "rawSceneIds": []}),
        json!("operationTicket"),
        json!(null),
    ];
    for request in bad {
        let error = GraphContinueRequest::parse(request.clone()).expect_err(&request.to_string());
        assert_eq!(error.to_string(), "RELATED_SCENES_INVALID_REQUEST");
    }
}

#[test]
fn graph_continue_refuses_null_in_place_of_a_missing_key() {
    // Safety P3-1 (DR-CP3A-47): serde reads `null` as `None`, so without the
    // check these would pass as an await or a settle. Main refuses them too.
    let bad = [
        json!({"operationTicket": "t", "rawSceneIds": ["a"], "settle": null}),
        json!({"operationTicket": "t", "rawSceneIds": null, "settle": "unused"}),
        json!({"operationTicket": "t", "rawSceneIds": null}),
        json!({"operationTicket": "t", "settle": null}),
        json!({"operationTicket": "t", "rawSceneIds": null, "settle": null}),
        json!({"operationTicket": null, "settle": "used"}),
    ];
    for request in bad {
        let error = GraphContinueRequest::parse(request.clone()).expect_err(&request.to_string());
        assert_eq!(error.to_string(), "RELATED_SCENES_INVALID_REQUEST");
    }
    // The two shapes without `null` still parse.
    assert!(matches!(
        GraphContinueRequest::parse(json!({"operationTicket": "t", "rawSceneIds": ["a"]})),
        Ok(GraphContinueRequest::Await { .. })
    ));
    assert!(matches!(
        GraphContinueRequest::parse(json!({"operationTicket": "t", "settle": "unused"})),
        Ok(GraphContinueRequest::Settle { .. })
    ));
}

#[test]
fn raw_scene_ids_accept_eight_and_reject_nine() {
    // K1b boundary: maxScenes is 8.
    let eight: Vec<String> = (0..8).map(|index| format!("s{index}")).collect();
    assert!(
        GraphContinueRequest::parse(json!({"operationTicket": "t", "rawSceneIds": eight})).is_ok()
    );
    let nine: Vec<String> = (0..9).map(|index| format!("s{index}")).collect();
    assert!(
        GraphContinueRequest::parse(json!({"operationTicket": "t", "rawSceneIds": nine})).is_err()
    );
    let boundary_id = "y".repeat(200);
    assert!(GraphContinueRequest::parse(
        json!({"operationTicket": "t", "rawSceneIds": [boundary_id]})
    )
    .is_ok());
}

#[test]
fn the_seed_of_a_begin_request_is_optional_and_not_unknown() {
    let with: BeginRequest = serde_json::from_value(json!({
        "ownerKey": "o", "expectedWorkspacePath": "/w", "projectId": "p",
        "currentSceneId": "s", "query": "q", "graphSeedEntityId": "e"
    }))
    .expect("with seed");
    assert_eq!(with.graph_seed_entity_id.as_deref(), Some("e"));
    let without: BeginRequest = serde_json::from_value(json!({
        "ownerKey": "o", "expectedWorkspacePath": "/w", "projectId": "p",
        "currentSceneId": "s", "query": "q"
    }))
    .expect("without seed");
    assert_eq!(without.graph_seed_entity_id, None);
    assert!(serde_json::from_value::<BeginRequest>(json!({
        "ownerKey": "o", "expectedWorkspacePath": "/w", "projectId": "p",
        "currentSceneId": "s", "query": "q", "graphSeed": "e"
    }))
    .is_err());
}

#[test]
fn the_wire_reasons_are_the_closed_fourteen() {
    for reason in GraphUnavailable::ALL {
        let wire = graph_unavailable(reason);
        assert_eq!(wire["status"], "unavailable");
        assert_eq!(wire["reason"], reason.as_str());
        assert_eq!(wire.as_object().expect("object").len(), 2);
    }
    assert_eq!(GraphUnavailable::ALL.len(), 14);
}

// ---- the gate at return -----------------------------------------------------

#[test]
fn the_gate_is_rechecked_where_the_result_leaves() {
    // N-11: closed gate, unrestricted profile, closed owner.
    let closed = Fixture::with(false, true);
    assert_eq!(
        gate_reason(&closed.state),
        Some(GraphUnavailable::NotActivated)
    );
    let unrestricted = Fixture::with(true, false);
    assert_eq!(
        gate_reason(&unrestricted.state),
        Some(GraphUnavailable::ProfileNotRestricted)
    );
    let open = Fixture::new();
    assert_eq!(gate_reason(&open.state), None);
    open.state.nir1_graph.close_for_shutdown();
    assert_eq!(
        gate_reason(&open.state),
        Some(GraphUnavailable::Invalidated)
    );
}

#[test]
fn the_ready_notice_reaches_the_event_queue_with_the_project_id_only() {
    // CP2a-D11: the notifier AppState installs, observed on a fresh queue.
    let queue = crate::state::EventQueue::new();
    let notifier = crate::state::graph_ready_notifier(queue.clone());
    notifier(&GraphReadyNotice {
        project_id: "p-1".into(),
    });
    assert_eq!(
        queue.pending_for_test(),
        vec![(
            "related-scenes:graph-ready".to_owned(),
            json!({"projectId": "p-1"}).to_string()
        )]
    );
}

#[path = "graph_response_tests.rs"]
mod response;
