//! DR-PUBG-5-14: a refused Graph registration asks Main for the project's Graph
//! Index build (B) wake, only while the product token exists. A fake worker
//! drives the owner; the real queue's pending events are the observable.
use super::*;

use grimodex_db::narrative_extraction::AutomaticRunKind;

const REFUSED: &str = "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED: fake";
const EXIT_BEFORE_READY: &str = "NIR1_GRAPH_WORKER_EXIT_BEFORE_READY: fake";

/// A test module may build an open token (the construction-site scan covers
/// production code); production never does.
fn open_token() -> Nir1GraphProductPublication {
    Nir1GraphProductPublication::from_const::<true>().expect("an open token")
}

fn inject_open_token(fixture: &ProductFixture) {
    *lock(
        &fixture
            .state
            .nir1_graph
            .shared
            .index_demand_product_for_test,
    ) = Some(open_token());
}

/// The Graph Index demand events Native queued for Main, as raw payloads.
fn demand_payloads(fixture: &ProductFixture) -> Vec<String> {
    fixture
        .state
        .events
        .pending_for_test()
        .into_iter()
        .filter(|(channel, _)| channel == GRAPH_INDEX_DEMAND_EVENT)
        .map(|(_, payload)| payload)
        .collect()
}

fn demand_count(fixture: &ProductFixture) -> usize {
    demand_payloads(fixture).len()
}

/// Begins until the slot is Suspended (five counted failures).
fn suspend(fixture: &ProductFixture) {
    wait_until("suspended after five failures", || {
        let _ = fixture.begin("entity");
        fixture.kind() == GraphSlotKind::Suspended
    });
}

/// The channel is Main's only (never a window's) and carries nothing but the
/// project ID.
#[test]
fn the_demand_event_is_main_only_and_carries_the_project_id_only() {
    assert_eq!(
        GRAPH_INDEX_DEMAND_EVENT,
        "narrative-maintenance:graph-index-demand"
    );
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    fixture.state.nir1_graph.shared.request_index_build(PROJECT);
    assert_eq!(
        demand_payloads(&fixture),
        vec![format!(r#"{{"projectId":"{PROJECT}"}}"#)]
    );
}

/// With the product constant `false` (a build before PUB-G) no demand is
/// raised, though the owner's own gate is open (the test gate, which an
/// evaluation build opens the same way): the token is not `publication_open()`.
#[test]
fn a_refused_registration_raises_nothing_while_the_product_token_is_closed() {
    let fixture = ProductFixture::new();
    assert!(
        fixture.state.nir1_graph.shared.publication_open(),
        "precondition: the owner's test gate is open"
    );
    assert!(maintenance_product_publication().is_none());
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    suspend(&fixture);
    // Suspended: a begin is answered with the stored reason, and asks for nothing.
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
    assert_eq!(demand_count(&fixture), 0);
    assert!(matches!(
        fixture
            .state
            .nir1_graph
            .begin_deferred(&fixture.state, fixture.query("entity")),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
    assert_eq!(demand_count(&fixture), 0);
}

/// Each counted refusal and each begin answered from the Suspended slot asks
/// for B once, with the project ID only.
#[test]
fn a_refused_registration_and_a_suspended_begin_each_ask_for_the_index_build() {
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    suspend(&fixture);
    let prepares = fixture.plan.prepares.load(Ordering::SeqCst);
    assert_eq!(prepares, 5, "five counted failures suspend the slot");
    // One per counted refusal (a begin that already met the Suspended slot may add one).
    let after_failures = demand_count(&fixture);
    assert!(
        after_failures >= 5,
        "{after_failures} demands after five refusals"
    );
    // A Suspended begin asks again (the only exit of the slot is B's publish)...
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
    assert_eq!(demand_count(&fixture), after_failures + 1);
    // ...and so does the deferred entry (Related Scenes' own).
    assert!(matches!(
        fixture
            .state
            .nir1_graph
            .begin_deferred(&fixture.state, fixture.query("entity")),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
    assert_eq!(demand_count(&fixture), after_failures + 2);
    // No prepare ran for the Suspended begins.
    assert_eq!(fixture.plan.prepares.load(Ordering::SeqCst), prepares);
    let expected = format!(r#"{{"projectId":"{PROJECT}"}}"#);
    assert!(demand_payloads(&fixture)
        .iter()
        .all(|payload| *payload == expected));
}

/// The deferred entry's own failures (Related Scenes) ask too: the released
/// held query prepares, is refused, and the project is named.
#[test]
fn a_refusal_after_the_release_asks_for_the_index_build() {
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    let GraphBegin::Pending(ticket) = fixture
        .state
        .nir1_graph
        .begin_deferred(&fixture.state, fixture.query("entity"))
    else {
        panic!("an empty slot holds the query");
    };
    // Nothing is asked while the query is only held.
    assert_eq!(demand_count(&fixture), 0);
    ticket.release_after_own_commits();
    assert!(matches!(
        ticket.wait_timeout(Duration::from_secs(5)),
        Some(GraphTicketOutcome::Unavailable(
            GraphUnavailable::RegistrationUnavailable
        ))
    ));
    ticket.finish(GraphTicketUse::Unused);
    wait_until("the demand", || demand_count(&fixture) == 1);
}

/// Only a refused registration asks: every other reason (a worker that exits,
/// a busy or warming slot) leaves B alone, or the rate would follow every edit
/// and query.
#[test]
fn other_reasons_ask_for_nothing() {
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(EXIT_BEFORE_READY);
    suspend(&fixture);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::WorkerUnavailable)
    ));
    assert!(matches!(
        fixture
            .state
            .nir1_graph
            .begin_deferred(&fixture.state, fixture.query("entity")),
        GraphBegin::Unavailable(GraphUnavailable::WorkerUnavailable)
    ));
    assert_eq!(demand_count(&fixture), 0);

    // A held prepare answers `warming`/`busy` and asks for nothing either.
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("the held prepare", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    assert!(matches!(
        fixture.state.nir1_graph.begin(
            &fixture.state,
            GraphQuery {
                project_id: "another-project".into(),
                query_scene_id: SCENE.into(),
                seed_entity_id: "entity".into(),
            }
        ),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert_eq!(demand_count(&fixture), 0);
}

/// A sink that panics neither unwinds into the begin nor takes the owner down.
#[test]
fn a_panicking_sink_does_not_reach_the_owner() {
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    let raised = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&raised);
    assert!(fixture
        .state
        .nir1_graph
        .set_graph_index_demand_notifier(Arc::new(move |_notice: &GraphIndexDemandNotice| {
            counter.fetch_add(1, Ordering::SeqCst);
            panic!("a failing sink");
        })));
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    suspend(&fixture);
    assert!(raised.load(Ordering::SeqCst) >= 5);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
}

/// CP2a-D47 / D49 (j), through the demand: a Suspended registration refusal
/// asks for B; B's publish (the hook with the build's own item) leaves
/// Suspended with one retry; the retry is READY and asks for nothing further.
#[test]
fn b_publish_leaves_a_registration_refused_suspension_with_one_retry() {
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    suspend(&fixture);
    let asked = demand_count(&fixture);
    assert!(asked >= 5);
    let creates = fixture.plan.creates.load(Ordering::SeqCst);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Ok;

    // Another kind of work does not leave Suspended.
    for other in [
        AutomaticRunKind::Backfill,
        AutomaticRunKind::Verify,
        AutomaticRunKind::RebuildDerived,
    ] {
        fixture
            .state
            .nir1_graph
            .note_maintenance_work_completed(&work_item(other));
        assert_eq!(fixture.kind(), GraphSlotKind::Suspended);
    }
    // B's publish does, with the one retry of CP2a-D49 (not five).
    fixture
        .state
        .nir1_graph
        .note_maintenance_work_completed(&work_item(AutomaticRunKind::Nir1GraphIndexBuild));
    assert_eq!(fixture.kind(), GraphSlotKind::Empty);
    assert_eq!(
        lock(&fixture.state.nir1_graph.shared.slot)
            .rebuild
            .consecutive_failures,
        4
    );
    wait_until("the retry starts", || {
        matches!(
            fixture.begin("entity"),
            GraphBegin::Unavailable(GraphUnavailable::Warming)
        )
    });
    wait_until("resumed READY", || fixture.kind() == GraphSlotKind::Ready);
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), creates + 1);
    assert_eq!(demand_count(&fixture), asked, "the retry asked for nothing");
}
