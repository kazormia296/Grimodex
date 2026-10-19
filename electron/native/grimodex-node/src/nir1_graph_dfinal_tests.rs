//! DI-1a S3 tests: D-final's Graph request, its bounded wait, the seed and the
//! kind of result. Acceptance IDs refer to the DI-1a TASK (A-5, A-6, A-10,
//! A-12, A-16, A-17). A fake worker drives the real product owner; the real
//! worker's reach is measured by the opt-in lane (S4).
use super::*;

use crate::nir1_graph_product::{
    GraphOwnerConfig, GraphSlotKind, GraphWorker, GraphWorkerFactory, GraphWorkerStart,
};
use crate::nir1_prepared_request::tests::{
    graph_candidates_for, write_graph_seal, Fixture, GRAPH_GENERATION, NO_UNSUPPORTED_INPUTS,
    SCENE_ID,
};
use crate::nir1_prepared_request::{
    prepare_selected_local_chat_request, LocalGenerationIntent, NativeSelectedPreparedRequest,
};
use grimodex_core::narrative_nir1::{EntityInput, GraphEdgeInput, ScopeBinding, ScopeValue};
use grimodex_db::narrative_extraction::nir1_graph::c_query_freshness::try_read_c_query_freshness_stamp;
use grimodex_db::narrative_extraction::nir1_graph::c_query_worker::CQueryRetirement;
use grimodex_db::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
use grimodex_db::narrative_extraction::nir1_graph::{
    Nir1GraphEdge, Nir1GraphMaterialBinding, Nir1GraphNode, Nir1QualifiedGraph,
};
use grimodex_db::narrative_extraction::Nir1GraphRequest;
use grimodex_db::nir1_generation::InputTarget;
use grimodex_db::workspace_lifecycle::{LiveBinding, WorkspaceLifecycleCore};
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::Mutex;
use std::thread::{self, ThreadId};

const ALICE: &str = "nir1-prepared-alice";
const BOB: &str = "nir1-prepared-bob";

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(2));
    }
}

fn fast_config() -> GraphOwnerConfig {
    GraphOwnerConfig {
        idle_retire_after: Duration::from_secs(30),
        rebuild_min_interval: Duration::from_millis(30),
        failure_backoff_initial: Duration::from_millis(20),
        failure_backoff_max: Duration::from_millis(80),
        failures_before_suspend: 5,
        cache_ttl: Duration::from_millis(200),
    }
}

// ---------------------------------------------------------------------------
// The fake worker: it answers the Graph of the control request's Revisions.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Plan {
    creates: AtomicUsize,
    prepares: AtomicUsize,
    queries: AtomicUsize,
    /// How long `prepare` takes (milliseconds), interrupted by `release`.
    prepare_delay_ms: AtomicU64,
    /// The first `prepare` commits a write on the parent connection after the
    /// owner's S0 stamp, so the first query is answered `stale`.
    commit_in_first_prepare: AtomicBool,
    prepare_error: Mutex<Option<&'static str>>,
    query_error: Mutex<Option<&'static str>>,
    /// Holds `query` until released.
    hold_query: AtomicBool,
    release: AtomicBool,
    prepare_threads: Mutex<Vec<ThreadId>>,
    /// Whether the parent's main connection could be read without waiting
    /// (the S0 premise) at each `prepare`.
    prepare_saw_free_connection: Mutex<Vec<bool>>,
    requests: Mutex<Vec<(String, String, String)>>,
    on_query: Mutex<Option<Box<dyn Fn() + Send>>>,
    candidates: Mutex<Option<Nir1GraphCandidates>>,
}

use grimodex_db::narrative_extraction::Nir1GraphCandidates;

struct FakeFactory(Arc<Plan>);

impl GraphWorkerFactory for FakeFactory {
    fn create(&self, start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        self.0.creates.fetch_add(1, Ordering::SeqCst);
        Box::new(FakeWorker {
            plan: Arc::clone(&self.0),
            snapshot: Some(start.snapshot),
            _binding: start.binding,
            _core: start.core,
        })
    }
}

struct FakeWorker {
    plan: Arc<Plan>,
    snapshot: Option<grimodex_db::state::ActiveWorkspaceSnapshot>,
    _binding: LiveBinding,
    _core: WorkspaceLifecycleCore,
}

fn entity(id: &str) -> Arc<EntityInput> {
    Arc::new(EntityInput {
        entity_id: id.into(),
        entity_type: "character".into(),
        label: format!("WORKER-TEXT-{id}"),
        source_token: format!("codex:{id}@1"),
        scope: ScopeBinding {
            reading: ScopeValue::LegacyAbsent,
            story: ScopeValue::LegacyAbsent,
            auto: ScopeValue::LegacyAbsent,
            phase: "draft".into(),
            reveal: "none".into(),
            pov: None,
            authority_revision: "authority".into(),
        },
        evidence: Vec::new(),
    })
}

/// The projection a worker would return for these candidates: every edge
/// leaves the seed. The labels are text the request must never carry.
fn projection_from(
    candidates: &Nir1GraphCandidates,
    request: &Nir1GraphRequest,
) -> Nir1GraphProjection {
    let seed = entity(&request.seed_entity_id);
    let mut nodes = vec![Nir1GraphNode {
        entity: Arc::clone(&seed),
        hop: 0,
        bindings: Vec::new(),
        binding_scopes: Vec::new(),
    }];
    let mut edges = Vec::new();
    for edge in candidates.edges() {
        let peer = entity(&format!("peer-{}", edge.edge_id));
        nodes.push(Nir1GraphNode {
            entity: Arc::clone(&peer),
            hop: edge.hop.saturating_add(1),
            bindings: Vec::new(),
            binding_scopes: Vec::new(),
        });
        let binding = &edge.binding;
        edges.push(Nir1GraphEdge {
            relation: Arc::new(GraphEdgeInput {
                edge_id: edge.edge_id.clone(),
                from_entity_id: seed.entity_id.clone(),
                to_entity_id: peer.entity_id.clone(),
                relation_type: "WORKER-RELATION-TEXT".into(),
                directionality: "directed".into(),
                source_token: "relation-source".into(),
                evidence_ids: Vec::new(),
            }),
            from: Arc::clone(&seed),
            to: peer,
            binding: Arc::new(Nir1GraphMaterialBinding {
                revision_id: binding.revision_id.clone(),
                decision_id: binding.decision_id.clone(),
                decision_token: binding.decision_token.clone(),
                freshness_token: binding.freshness_token.clone(),
                scope_authority_revision: binding.scope_authority_revision.clone(),
                query_scene_source_token: binding.query_scene_source_token.clone(),
                query_scene_scope_token: binding.query_scene_scope_token.clone(),
                query_scene_incarnation_id: binding.query_scene_incarnation_id.clone(),
                reveal_state_token: binding.reveal_state_token.clone(),
            }),
        });
    }
    Nir1GraphProjection {
        project_id: request.project_id.clone(),
        query_scene_id: request.query_scene_id.clone(),
        scope_revision: candidates.scope_revision().map(str::to_owned),
        graph: Nir1QualifiedGraph {
            seed_entity_id: request.seed_entity_id.clone(),
            generation: candidates.generation(),
            nodes,
            edges,
            scene_total: 0,
            scenes: Vec::new(),
        },
        elapsed: Duration::ZERO,
    }
}

impl FakeWorker {
    fn sleep_interruptibly(&self, total: Duration) {
        let deadline = Instant::now() + total;
        while Instant::now() < deadline && !self.plan.release.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

impl GraphWorker for FakeWorker {
    fn prepare(&mut self, _project_id: &str) -> anyhow::Result<()> {
        let index = self.plan.prepares.fetch_add(1, Ordering::SeqCst);
        lock(&self.plan.prepare_threads).push(thread::current().id());
        let snapshot = self.snapshot.as_ref().expect("snapshot until retired");
        // S0's premise: while D-final waits, nothing holds the main connection.
        lock(&self.plan.prepare_saw_free_connection)
            .push(try_read_c_query_freshness_stamp(snapshot.db().db()).is_some());
        if index == 0 && self.plan.commit_in_first_prepare.load(Ordering::SeqCst) {
            snapshot.db().db().with_conn(|conn| {
                conn.execute("UPDATE chat_sessions SET title = title || '.'", [])?;
                Ok(())
            })?;
        }
        self.sleep_interruptibly(Duration::from_millis(
            self.plan.prepare_delay_ms.load(Ordering::SeqCst),
        ));
        if let Some(text) = *lock(&self.plan.prepare_error) {
            return Err(anyhow::anyhow!(text));
        }
        Ok(())
    }

    fn query(
        &mut self,
        request: &Nir1GraphRequest,
        cancel: &AtomicBool,
    ) -> anyhow::Result<Nir1GraphProjection> {
        self.plan.queries.fetch_add(1, Ordering::SeqCst);
        lock(&self.plan.requests).push((
            request.project_id.clone(),
            request.query_scene_id.clone(),
            request.seed_entity_id.clone(),
        ));
        while self.plan.hold_query.load(Ordering::SeqCst)
            && !self.plan.release.load(Ordering::SeqCst)
            && !cancel.load(Ordering::SeqCst)
        {
            thread::sleep(Duration::from_millis(2));
        }
        if let Some(hook) = lock(&self.plan.on_query).as_ref() {
            hook();
        }
        if let Some(text) = *lock(&self.plan.query_error) {
            return Err(anyhow::anyhow!(text));
        }
        let candidates = lock(&self.plan.candidates).clone().expect("candidates");
        Ok(projection_from(&candidates, request))
    }

    fn quarantined(&self) -> bool {
        false
    }

    fn retire(self: Box<Self>) -> CQueryRetirement {
        drop(self.snapshot);
        CQueryRetirement::Retired
    }
}

// ---------------------------------------------------------------------------
// The rig: a real D-final fixture on a sealed B with the fake worker behind
// the product owner.
// ---------------------------------------------------------------------------

struct Rig {
    fixture: Fixture,
    plan: Arc<Plan>,
    candidates: Nir1GraphCandidates,
}

impl Rig {
    /// The publication gate is closed, as in a product build, until `open`.
    fn new() -> Self {
        let fixture = Fixture::new().expect("fixture");
        write_graph_seal(&fixture.state, GRAPH_GENERATION, false).expect("seal and pin");
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
        let candidates = graph_candidates_for(control.authority_bindings(), GRAPH_GENERATION)
            .expect("candidates");
        let plan = Arc::new(Plan::default());
        *lock(&plan.candidates) = Some(candidates.clone());
        Self {
            fixture,
            plan,
            candidates,
        }
    }

    fn open(&self) {
        let owner = &self.fixture.state.nir1_graph;
        owner.open_publication_for_test();
        owner.set_config_for_test(fast_config());
        owner.set_dfinal_wait_for_test(GraphWaitPlan {
            budget: Duration::from_secs(10),
            step: Duration::from_millis(10),
        });
        owner.install_worker_factory_for_test(Arc::new(FakeFactory(Arc::clone(&self.plan))));
    }

    fn open_with_budget(&self, budget: Duration) {
        self.open();
        self.fixture
            .state
            .nir1_graph
            .set_dfinal_wait_for_test(GraphWaitPlan {
                budget,
                step: Duration::from_millis(10),
            });
    }

    fn owner(&self) -> &crate::nir1_graph_product::Nir1GraphProductOwner {
        &self.fixture.state.nir1_graph
    }

    fn request(&self) -> anyhow::Result<NativeSelectedPreparedRequest> {
        prepare_selected_local_chat_request(
            Arc::clone(&self.fixture.state),
            self.fixture.caller.clone(),
            SCENE_ID,
            &self.fixture.message_version_id,
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::writing_for_test(),
        )
    }

    fn pin(&self, entry: &str, created_at: &str) {
        let workspace =
            grimodex_db::state::active_workspace_snapshot(&self.fixture.state.ws).expect("ws");
        workspace
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO scene_codex_pins(scene_id,entry_id,created_at)
                     VALUES (?1,?2,?3)",
                    (SCENE_ID, entry, created_at),
                )?;
                Ok(())
            })
            .expect("pin");
    }

    fn unpin_all(&self) {
        let workspace =
            grimodex_db::state::active_workspace_snapshot(&self.fixture.state.ws).expect("ws");
        workspace
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute("DELETE FROM scene_codex_pins", [])?;
                Ok(())
            })
            .expect("unpin");
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.plan.release.store(true, Ordering::SeqCst);
        self.fixture.state.nir1_graph.close_for_shutdown();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !matches!(
                self.fixture.state.nir1_graph.slot_kind_for_test(),
                GraphSlotKind::Closed | GraphSlotKind::Empty | GraphSlotKind::Quarantined
            )
        {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

fn graph_input_count(request: NativeSelectedPreparedRequest) -> usize {
    request
        .into_parts()
        .0
        .into_d_transport_handoff()
        .input_references()
        .iter()
        .filter(|input| matches!(input.target, InputTarget::GraphEvidence { .. }))
        .count()
}

fn used(outcome: DFinalGraphOutcome) -> bool {
    matches!(outcome, DFinalGraphOutcome::Used { groups, .. } if groups > 0)
}

// ---------------------------------------------------------------------------
// A-17: the product entry stays closed.
// ---------------------------------------------------------------------------

#[test]
fn a17_a_closed_product_asks_for_nothing_and_changes_no_byte() {
    let rig = Rig::new();
    // Not opened: no seed is read, no begin, no worker.
    let first = rig.request().expect("request");
    assert_eq!(
        first.graph_outcome(),
        DFinalGraphOutcome::Unavailable {
            reason: GraphUnavailable::NotActivated,
            busy_cause: None,
        }
    );
    let diagnostics = rig.owner().diagnostics();
    assert_eq!(diagnostics.begins, 0);
    assert_eq!(rig.plan.creates.load(Ordering::SeqCst), 0);
    let first = first.into_parts().0.into_d_transport_handoff();
    // The same request, the Graph given as "none" by a test, is the same bytes.
    let none = crate::nir1_prepared_request::prepare_selected_local_chat_request_with_graph(
        Arc::clone(&rig.fixture.state),
        rig.fixture.caller.clone(),
        SCENE_ID,
        &rig.fixture.message_version_id,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
        None,
    )
    .expect("request without a Graph");
    assert_eq!(none.graph_outcome(), DFinalGraphOutcome::NotRequested);
    let none = none.into_parts().0.into_d_transport_handoff();
    assert_eq!(first.payload_digest(), none.payload_digest());
    assert_eq!(first.input_digest(), none.input_digest());
    assert_eq!(first.qualifications(), none.qualifications());
    assert!(first.graph_binding().is_none());
}

#[test]
fn a17_the_module_has_no_product_entry() {
    let source = include_str!("nir1_graph_dfinal.rs");
    for forbidden in ["#[napi", "ipcContract", "contextBridge", "ipcMain"] {
        assert!(!source.contains(forbidden), "{forbidden}");
    }
    assert!(!include_str!("lib.rs").contains("nir1_graph_dfinal::"));
}

// ---------------------------------------------------------------------------
// A-5: the request and the wait sit before the participant read.
// ---------------------------------------------------------------------------

#[test]
fn a5_a_warming_graph_is_waited_for_outside_the_database_and_reaches_the_request() {
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(150, Ordering::SeqCst);
    // The D-final thread is a plain thread, not an async runtime.
    assert!(tokio::runtime::Handle::try_current().is_err());
    let d_final_thread = thread::current().id();
    let started = Instant::now();
    let selected = rig.request().expect("request");
    assert!(
        started.elapsed() >= Duration::from_millis(150),
        "it waited for READY"
    );
    assert!(
        used(selected.graph_outcome()),
        "{:?}",
        selected.graph_outcome()
    );
    assert!(graph_input_count(selected) > 0);

    // The worker is queried once; the owner rebuilds after a query, which
    // may already be under way, so only the first build is the wait's.
    assert_eq!(rig.plan.queries.load(Ordering::SeqCst), 1);
    // The owner's thread prepared; D-final's thread did not.
    assert_ne!(lock(&rig.plan.prepare_threads)[0], d_final_thread);
    // S0's premise held during the wait: the main connection was free and in
    // autocommit, so the freshness stamp was readable, at S0 and at the query.
    assert!(lock(&rig.plan.prepare_saw_free_connection)[0]);
    assert_eq!(rig.owner().diagnostics().stamp0_missing, 0);
    assert_eq!(rig.owner().diagnostics().stamp_unavailable, 0);
    // The query asked for the pinned Entity of the query Scene.
    assert_eq!(
        *lock(&rig.plan.requests),
        vec![(
            "default-project".to_owned(),
            SCENE_ID.to_owned(),
            ALICE.to_owned()
        )]
    );
}

#[test]
fn a5_a_stale_graph_waits_for_the_rebuild_and_asks_again() {
    let rig = Rig::new();
    rig.open();
    rig.plan
        .commit_in_first_prepare
        .store(true, Ordering::SeqCst);
    let selected = rig.request().expect("request");
    assert!(
        used(selected.graph_outcome()),
        "{:?}",
        selected.graph_outcome()
    );
    // Two builds served the request: the first was stale at its query, so no
    // query reached the worker until the rebuild.
    assert!(rig.plan.prepares.load(Ordering::SeqCst) >= 2);
    assert_eq!(rig.plan.queries.load(Ordering::SeqCst), 1);
    assert_eq!(rig.owner().diagnostics().stamp_stale, 1);
    assert_eq!(
        lock(&rig.plan.prepare_saw_free_connection)[..2],
        [true, true]
    );
}

/// From another thread, reads the main connection without waiting, every few
/// milliseconds, from the moment `from` holds until `window` has passed. A
/// sample that returns `None` found the connection held or inside a
/// transaction. Returns `(samples, free)`.
fn sample_main_connection(rig: &Rig, from: impl Fn() -> bool, window: Duration) -> (usize, usize) {
    let workspace =
        grimodex_db::state::active_workspace_snapshot(&rig.fixture.state.ws).expect("ws");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !from() {
        assert!(Instant::now() < deadline, "the wait never began");
        thread::sleep(Duration::from_millis(1));
    }
    let started = Instant::now();
    let (mut samples, mut free) = (0usize, 0usize);
    while started.elapsed() < window {
        samples += 1;
        if try_read_c_query_freshness_stamp(workspace.db().db()).is_some() {
            free += 1;
        }
        thread::sleep(Duration::from_millis(5));
    }
    (samples, free)
}

#[test]
fn a5_the_main_connection_stays_free_during_the_whole_wait() {
    // While READY is awaited (the worker is preparing) ...
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(700, Ordering::SeqCst);
    let (samples, free) = thread::scope(|scope| {
        let sampler = scope.spawn(|| {
            sample_main_connection(
                &rig,
                || rig.plan.prepares.load(Ordering::SeqCst) >= 1,
                Duration::from_millis(450),
            )
        });
        let selected = rig.request().expect("request");
        assert!(
            used(selected.graph_outcome()),
            "{:?}",
            selected.graph_outcome()
        );
        sampler.join().expect("sampler")
    });
    assert!(samples >= 20, "{samples} samples");
    assert_eq!(free, samples, "the connection was held during the wait");

    // ... and while a running query is awaited.
    let rig = Rig::new();
    rig.open_with_budget(Duration::from_millis(700));
    rig.plan.hold_query.store(true, Ordering::SeqCst);
    let (samples, free) = thread::scope(|scope| {
        let sampler = scope.spawn(|| {
            sample_main_connection(
                &rig,
                || rig.plan.queries.load(Ordering::SeqCst) >= 1,
                Duration::from_millis(450),
            )
        });
        let selected = rig.request().expect("request");
        assert_eq!(
            selected.graph_outcome(),
            DFinalGraphOutcome::WaitExpired(GraphWaitKind::Query),
            "a query that outlasts the wait is the wait's expiry, not the owner's timeout"
        );
        sampler.join().expect("sampler")
    });
    assert!(samples >= 20, "{samples} samples");
    assert_eq!(
        free, samples,
        "the connection was held during the query wait"
    );
}

#[test]
fn a5_the_wait_is_bounded_and_the_request_goes_without_the_graph() {
    let rig = Rig::new();
    rig.open_with_budget(Duration::from_millis(120));
    rig.plan.prepare_delay_ms.store(5_000, Ordering::SeqCst);
    let started = Instant::now();
    let selected = rig.request().expect("the request continues");
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(120));
    assert!(elapsed < Duration::from_secs(4), "{elapsed:?}");
    assert_eq!(
        selected.graph_outcome(),
        DFinalGraphOutcome::WaitExpired(GraphWaitKind::Warming)
    );
    assert_eq!(graph_input_count(selected), 0);
}

#[test]
fn a5_a_stop_a_shutdown_and_a_closed_owner_end_the_wait() {
    // A stop: the submission is cancelled while D-final waits.
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(10_000, Ordering::SeqCst);
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(80));
            rig.fixture.message_version_id.stop_for_test();
        });
        let started = Instant::now();
        let result = rig.request();
        assert!(result.is_err(), "a stopped request is not prepared");
        assert!(started.elapsed() < Duration::from_secs(3));
    });
    drop(rig);

    // A shutdown of the workspace.
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(10_000, Ordering::SeqCst);
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(80));
            rig.fixture
                .state
                .workspace_shutdown_requested
                .store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let result = rig.request();
        assert!(result.is_err(), "a shutdown ends the preparation");
        assert!(started.elapsed() < Duration::from_secs(3));
    });
    drop(rig);

    // The owner closes (a lifecycle edge or the shutdown of the owner): the
    // wait ends, the request goes on without the Graph.
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(10_000, Ordering::SeqCst);
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(80));
            rig.owner().close_for_shutdown();
        });
        let started = Instant::now();
        let selected = rig.request().expect("the request continues");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            selected.graph_outcome(),
            DFinalGraphOutcome::Unavailable {
                reason: GraphUnavailable::Cancelled,
                busy_cause: None,
            }
        );
    });
}

/// A lifecycle transition alone (no close of the owner) ends the wait: the
/// owner's edge epoch moved, so the Graph that is being prepared belongs to a
/// workspace state that is gone (A-5; K6/2 "取消、shutdown、transition").
#[test]
fn a5_a_lifecycle_transition_alone_ends_the_wait() {
    use grimodex_db::workspace_lifecycle::LifecycleEdge;
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(10_000, Ordering::SeqCst);
    let observer = rig.owner().edge_observer_for_test();
    let epoch_before = rig.owner().edge_epoch();
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(80));
            observer.on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: 1 });
        });
        let started = Instant::now();
        let selected = rig.request().expect("the request continues");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            selected.graph_outcome(),
            DFinalGraphOutcome::Unavailable {
                reason: GraphUnavailable::Cancelled,
                busy_cause: None,
            }
        );
    });
    // The edge moved the epoch and did not close the owner: the transition,
    // not a close, ended the wait.
    assert!(rig.owner().edge_epoch() > epoch_before);
    assert!(!rig.owner().is_closed());
}

/// A revoked route alone (the permit generation moved; the owner stays open
/// and its epoch is unchanged) ends the wait.
#[test]
fn a5_a_route_revocation_alone_ends_the_wait() {
    let rig = Rig::new();
    rig.open();
    rig.plan.prepare_delay_ms.store(10_000, Ordering::SeqCst);
    let epoch_before = rig.owner().edge_epoch();
    let generation_before = rig.fixture.state.profile_egress.revocation_generation();
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(80));
            rig.fixture.state.profile_egress.invalidate_callers();
        });
        let started = Instant::now();
        // The revocation also fails the later route check of D-final, so the
        // request itself may end with an error; what is pinned is that the
        // wait did not run to W (10 s here) or to the worker's 10 s prepare.
        let result = rig.request();
        assert!(started.elapsed() < Duration::from_secs(3));
        if let Ok(selected) = result {
            assert_eq!(
                selected.graph_outcome(),
                DFinalGraphOutcome::Unavailable {
                    reason: GraphUnavailable::Cancelled,
                    busy_cause: None,
                }
            );
        }
    });
    assert!(rig.fixture.state.profile_egress.revocation_generation() > generation_before);
    assert_eq!(rig.owner().edge_epoch(), epoch_before);
    assert!(!rig.owner().is_closed());
}

/// The coordinator (DI-1c) calls D-final from no lock; the Graph reaches the
/// attempt it stores through the same request and wait.
#[test]
fn a5_the_coordinator_reaches_the_graph_through_the_same_wait() {
    use crate::nir1_local_attempt::{
        Nir1LocalAttempt, Nir1LocalAttemptOutcome, NIR1_LOCAL_ATTEMPT_READ_BUDGET,
    };
    use grimodex_db::nir1_generation as generation_storage;
    let rig = Rig::new();
    assert!(
        crate::nir1_generation::sweep_and_open_ready_entry_for_test(&rig.fixture.state),
        "the startup gate opens after the sweep"
    );
    rig.open();
    rig.plan.prepare_delay_ms.store(120, Ordering::SeqCst);
    let attempt = Nir1LocalAttempt::capture(
        Arc::clone(&rig.fixture.state),
        rig.fixture.caller.clone(),
        &rig.fixture.message_version_id,
        SCENE_ID,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )
    .unwrap_or_else(|refusal| panic!("capture refused: {refusal:?}"));
    let started = Instant::now();
    let outcome = attempt
        .run()
        .unwrap_or_else(|refusal| panic!("the coordinator refused: {refusal:?}"));
    assert!(started.elapsed() >= Duration::from_millis(120));
    assert!(matches!(outcome, Nir1LocalAttemptOutcome::Start(_)));
    drop(outcome);
    assert!(lock(&rig.plan.prepare_saw_free_connection)[0]);
    let attempt_id = generation_storage::attempt_id_for_capture(&rig.fixture.message_version_id)
        .expect("attempt id");
    let workspace =
        grimodex_db::state::active_workspace_snapshot(&rig.fixture.state.ws).expect("workspace");
    let stored = generation_storage::read_attempt(
        workspace.db().db(),
        &attempt_id,
        NIR1_LOCAL_ATTEMPT_READ_BUDGET,
    )
    .expect("stored attempt");
    assert!(
        stored
            .inputs
            .iter()
            .any(|input| matches!(input.target, InputTarget::GraphEvidence { .. })),
        "the stored attempt records the Graph-derived input"
    );
}

// ---------------------------------------------------------------------------
// A-6: W sits inside the SQL deadline.
// ---------------------------------------------------------------------------

#[test]
fn a6_a_wait_near_w_leaves_the_rest_of_d_final_inside_its_deadline() {
    let rig = Rig::new();
    rig.open();
    // The product's own W, not a shortened one.
    rig.owner()
        .set_dfinal_wait_for_test(GraphWaitPlan::default());
    let near = GRAPH_WAIT_BUDGET - Duration::from_millis(600);
    rig.plan
        .prepare_delay_ms
        .store(u64::try_from(near.as_millis()).unwrap(), Ordering::SeqCst);
    let started = Instant::now();
    let selected = rig
        .request()
        .expect("the read, the rendering and the re-check follow");
    let elapsed = started.elapsed();
    assert!(elapsed >= near);
    assert!(
        used(selected.graph_outcome()),
        "{:?}",
        selected.graph_outcome()
    );
    // The static bound: W plus what is kept for the rest is the SQL deadline.
    assert!(
        GRAPH_WAIT_BUDGET + GRAPH_STEP_RESERVE
            <= crate::nir1_prepared_request::PREPARATION_SQL_TIMEOUT
    );
    assert_eq!(GraphWaitPlan::default().budget, GRAPH_WAIT_BUDGET);
    assert_eq!(GraphWaitPlan::default().step, GRAPH_WAIT_STEP);
}

// ---------------------------------------------------------------------------
// A-10: the seed.
// ---------------------------------------------------------------------------

#[test]
fn a10_no_pin_means_no_request_no_wait_and_no_graph_group() {
    let rig = Rig::new();
    rig.open();
    rig.unpin_all();
    rig.plan.prepare_delay_ms.store(5_000, Ordering::SeqCst);
    let started = Instant::now();
    let selected = rig.request().expect("request");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "it did not wait"
    );
    assert_eq!(selected.graph_outcome(), DFinalGraphOutcome::NotRequested);
    assert_eq!(graph_input_count(selected), 0);
    // B is sealed and current, yet the owner was never asked.
    assert_eq!(rig.owner().diagnostics().begins, 0);
    assert_eq!(rig.plan.creates.load(Ordering::SeqCst), 0);
    assert_eq!(rig.plan.queries.load(Ordering::SeqCst), 0);
}

#[test]
fn a10_several_pins_give_one_deterministic_seed() {
    let rig = Rig::new();
    rig.open();
    // Bob was pinned before Alice: the earliest pin is the seed.
    rig.pin(BOB, "2026-01-01T00:00:00Z");
    for _ in 0..2 {
        let selected = rig.request().expect("request");
        // The seed D-final asked about and the seed its snapshot read again
        // are the same (Bob), so the Graph is neither invalidated nor empty.
        assert!(
            used(selected.graph_outcome()),
            "{:?}",
            selected.graph_outcome()
        );
        assert!(graph_input_count(selected) > 0);
    }
    // The fake worker answers with the seed of the request, which is Bob's;
    // the candidates it builds are for that seed.
    assert!(lock(&rig.plan.requests)
        .iter()
        .all(|(_, _, seed)| seed == BOB));
    assert!(!lock(&rig.plan.requests).is_empty());
    // Two pins at the same time: the Entity ID breaks the tie.
    rig.pin(ALICE, "2026-01-01T00:00:00Z");
    lock(&rig.plan.requests).clear();
    let _ = rig.request().expect("request");
    let seeds = lock(&rig.plan.requests).clone();
    assert!(seeds.iter().all(|(_, _, seed)| seed == ALICE), "{seeds:?}");
}

#[test]
fn a10_a_seed_that_changes_after_the_request_invalidates_the_graph() {
    let rig = Rig::new();
    rig.open();
    // While the worker answers, a pin earlier than Alice's is added: the
    // snapshot of D-final names another seed than the one it asked about.
    let state = Arc::clone(&rig.fixture.state);
    *lock(&rig.plan.on_query) = Some(Box::new(move || {
        let workspace = grimodex_db::state::active_workspace_snapshot(&state.ws).expect("ws");
        workspace
            .db()
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO scene_codex_pins(scene_id,entry_id,created_at)
                     VALUES (?1,?2,'2026-01-01T00:00:00Z')",
                    (SCENE_ID, BOB),
                )?;
                Ok(())
            })
            .expect("pin");
    }));
    let selected = rig.request().expect("request");
    assert_eq!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Invalidated(GraphInvalidation::Seed)
    );
    assert_eq!(graph_input_count(selected), 0);
    assert_eq!(
        *lock(&rig.plan.requests),
        vec![(
            "default-project".to_owned(),
            SCENE_ID.to_owned(),
            ALICE.to_owned()
        )]
    );
}

// ---------------------------------------------------------------------------
// A-12: the kind of result is kept as a computed value.
// ---------------------------------------------------------------------------

#[test]
fn a12_each_kind_of_result_is_a_value_of_the_preparation() {
    // Used.
    let rig = Rig::new();
    rig.open();
    let selected = rig.request().expect("request");
    let outcome = selected.graph_outcome();
    assert!(used(outcome), "{outcome:?}");
    let DFinalGraphOutcome::Used { groups, .. } = outcome else {
        unreachable!()
    };
    assert_eq!(groups, graph_input_count(selected));
    drop(rig);

    // Unavailable: the worker failed, or the preparation of it failed.
    let rig = Rig::new();
    rig.open();
    *lock(&rig.plan.query_error) = Some("worker failed");
    let selected = rig.request().expect("request");
    assert!(matches!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Unavailable {
            reason: GraphUnavailable::Failed,
            busy_cause: None
        }
    ));
    drop(rig);
    let rig = Rig::new();
    rig.open();
    *lock(&rig.plan.prepare_error) = Some("worker would not prepare");
    let selected = rig.request().expect("request");
    assert!(matches!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Unavailable {
            reason: GraphUnavailable::WorkerUnavailable,
            ..
        }
    ));
    drop(rig);

    // Invalidated: B was rebuilt at another generation while the worker
    // answered; the seal D-final reads is not the one the worker answered under.
    let rig = Rig::new();
    rig.open();
    let state = Arc::clone(&rig.fixture.state);
    *lock(&rig.plan.on_query) = Some(Box::new(move || {
        write_graph_seal(&state, GRAPH_GENERATION + 1, false).expect("seal");
    }));
    let selected = rig.request().expect("request");
    assert_eq!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Invalidated(GraphInvalidation::Seal)
    );
    assert_eq!(graph_input_count(selected), 0);
    drop(rig);

    // Excluded: the worker named a Revision the Native selection does not know.
    let rig = Rig::new();
    rig.open();
    let ghost = {
        let mut edges = rig.candidates.edges().to_vec();
        for edge in &mut edges {
            edge.binding.revision_id = "ghost-revision".into();
        }
        Nir1GraphCandidates::new(
            rig.candidates.project_id().into(),
            rig.candidates.query_scene_id().into(),
            rig.candidates.seed_entity_id().into(),
            rig.candidates.generation(),
            rig.candidates.scope_revision().map(str::to_owned),
            edges,
        )
        .expect("ghost candidates")
    };
    *lock(&rig.plan.candidates) = Some(ghost);
    let selected = rig.request().expect("request");
    assert!(matches!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Excluded { revisions } if revisions >= 1
    ));
    assert_eq!(graph_input_count(selected), 0);
    drop(rig);

    // Unavailable(Limit): the pinned Entity ID is longer than a request holds.
    let rig = Rig::new();
    rig.open();
    rig.unpin_all();
    let workspace =
        grimodex_db::state::active_workspace_snapshot(&rig.fixture.state.ws).expect("ws");
    let huge = "e"
        .repeat(grimodex_db::narrative_extraction::nir1_graph::c_query_worker::REQUEST_BYTES + 1);
    workspace
        .db()
        .db()
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_entries(id,project_id,type,name,summary,updated_at)
                 VALUES (?1,'default-project','character','Huge','Huge.','2026-10-19T00:00:00Z')",
                [&huge],
            )?;
            conn.execute(
                "INSERT INTO scene_codex_pins(scene_id,entry_id,created_at)
                 VALUES (?1,?2,'2026-10-19T00:00:00Z')",
                (SCENE_ID, &huge),
            )?;
            Ok(())
        })
        .expect("huge pin");
    let selected = rig.request().expect("request");
    assert_eq!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Unavailable {
            reason: GraphUnavailable::Limit,
            busy_cause: None
        }
    );
    assert_eq!(rig.owner().diagnostics().begins, 0);
}

#[test]
fn a12_busy_names_its_cause() {
    // The cause is the owner's stamp counters moving during the request.
    assert_eq!(busy_cause_of(10, 10), GraphBusyCause::SlotInUse);
    assert_eq!(busy_cause_of(10, 11), GraphBusyCause::StampUnreadable);
}

// ---------------------------------------------------------------------------
// A-16: D-final yields the slot.
// ---------------------------------------------------------------------------

#[test]
fn a16_a_busy_slot_is_not_waited_for_and_its_ticket_is_not_cancelled() {
    let rig = Rig::new();
    rig.open();
    // Related Scenes' query: warm the slot, then hold a query in flight.
    rig.plan.hold_query.store(true, Ordering::SeqCst);
    let state = Arc::clone(&rig.fixture.state);
    let query = GraphQuery {
        project_id: "default-project".into(),
        query_scene_id: SCENE_ID.into(),
        seed_entity_id: ALICE.into(),
    };
    assert!(matches!(
        state.nir1_graph.begin(&state, query.clone()),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("READY", || {
        state.nir1_graph.slot_kind_for_test() == GraphSlotKind::Ready
    });
    let GraphBegin::Pending(ticket) = state.nir1_graph.begin(&state, query) else {
        panic!("the query is pending");
    };
    wait_until("the query is in flight", || {
        rig.plan.queries.load(Ordering::SeqCst) == 1
    });

    let started = Instant::now();
    let selected = rig.request().expect("request");
    assert!(started.elapsed() < Duration::from_secs(3), "no wait");
    assert_eq!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Unavailable {
            reason: GraphUnavailable::Busy,
            busy_cause: Some(GraphBusyCause::SlotInUse),
        }
    );
    assert_eq!(graph_input_count(selected), 0);
    // The other consumer's ticket is still running, and finishes.
    assert!(ticket.poll().is_none());
    rig.plan.hold_query.store(false, Ordering::SeqCst);
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(5)),
        Some(GraphTicketOutcome::Available(_))
    ));
    ticket.finish(GraphTicketUse::Used);
}
