//! LP-GATE (DR-CQD-GATE-3〜6, 10): the Graph window of a held query, on the
//! owner with the fake worker. The window opens after the rebuild window and
//! before the admission (the S0 stamp), waits for a Freshness section in
//! flight, and ends wherever the answer is joined, cached or discarded.
use super::*;

use crate::nir1_graph_commit_gate::{FreshnessAdmission, FreshnessSection, GateLimits};
use std::sync::atomic::AtomicUsize;

/// Long limits, so a slow test never sees a window expire or Freshness give
/// up; the Graph waits `graph_wait`.
fn limits(graph_wait: Duration) -> GateLimits {
    GateLimits {
        lease_max: Duration::from_secs(60),
        admit_wait: Duration::from_secs(20),
        ceiling: Duration::from_secs(40),
        graph_wait,
        ..GateLimits::default()
    }
}

fn gate_fixture() -> ProductFixture {
    fixture_with(ProductFixture::new(), Duration::from_secs(20))
}

fn fixture_with(fixture: ProductFixture, graph_wait: Duration) -> ProductFixture {
    gate(&fixture).set_limits_for_test(limits(graph_wait));
    fixture
}

fn begin_deferred(fixture: &ProductFixture) -> GraphBegin {
    fixture
        .state
        .nir1_graph
        .begin_deferred(&fixture.state, fixture.query("entity"))
}

fn gate(fixture: &ProductFixture) -> Arc<GraphCommitGate> {
    fixture.state.nir1_graph.commit_gate()
}

/// (live windows, Freshness sections in flight).
fn live(fixture: &ProductFixture) -> (usize, u32) {
    gate(fixture).live_for_test()
}

fn enter(fixture: &ProductFixture) -> FreshnessSection {
    match gate(fixture).enter_freshness(|| false) {
        FreshnessAdmission::Admitted(section) => section,
        _ => panic!("an idle gate admits Freshness"),
    }
}

/// Records the live windows at every admission (the S0 stamp).
fn windows_at_admit(fixture: &ProductFixture) -> Arc<Mutex<Vec<usize>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let gate = gate(fixture);
    let record = Arc::clone(&seen);
    fixture
        .state
        .nir1_graph
        .set_admit_hook_for_test(Arc::new(move || {
            lock(&record).push(gate.live_for_test().0);
        }));
    seen
}

fn released(fixture: &ProductFixture) -> GraphTicket {
    let ticket = pending(begin_deferred(fixture));
    assert_eq!(live(fixture).0, 0, "no window while the query is held");
    ticket.release_after_own_commits();
    ticket
}

fn wait_answered(ticket: &GraphTicket) -> GraphTicketOutcome {
    ticket
        .wait_timeout(Duration::from_secs(5))
        .expect("the ticket settles")
}

#[test]
fn a_held_query_opens_its_window_before_the_admission_and_keeps_it_until_used() {
    let fixture = gate_fixture();
    let at_admit = windows_at_admit(&fixture);
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    assert_eq!(
        *lock(&at_admit),
        vec![1],
        "the S0 stamp is read inside the window"
    );
    assert_eq!(
        live(&fixture),
        (1, 0),
        "an answer not yet joined keeps its window"
    );
    ticket.finish(GraphTicketUse::Used);
    assert_eq!(live(&fixture), (0, 0), "a used answer ends its window");
    let counters = fixture.diagnostics().gate;
    assert_eq!((counters.windows_opened, counters.graph_waited), (1, 0));
}

#[test]
fn an_unavailable_answer_and_a_cancellation_end_the_window() {
    let fixture = gate_fixture();
    *lock(&fixture.plan.query_mode) = QueryMode::Unavailable(UnavailableReason::RegistrationDrift);
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Unavailable(_)
    ));
    assert_eq!(
        live(&fixture),
        (0, 0),
        "an unavailable answer ends its window"
    );
    drop(ticket);
    wait_until("the session's end", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    // A cancellation after an available answer.
    *lock(&fixture.plan.query_mode) = QueryMode::Ok;
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    assert_eq!(live(&fixture).0, 1);
    drop(ticket); // an unfinished ticket counts as cancelled
    assert_eq!(live(&fixture), (0, 0));
}

#[test]
fn an_unused_answer_carries_its_window_through_the_cache_to_the_child() {
    let fixture = gate_fixture();
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = released(&fixture);
    wait_until("the query in the worker", || {
        fixture.plan.queries.load(Ordering::SeqCst) == 1
    });
    // The renderer settles unused before the answer arrives: the window stays.
    ticket.finish(GraphTicketUse::Unused);
    assert_eq!(live(&fixture).0, 1);
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("the late cache", || {
        fixture.state.nir1_graph.cache_len_for_test() == 1
    });
    assert_eq!(
        live(&fixture).0,
        1,
        "the window moved into the cache unbroken"
    );
    match begin_deferred(&fixture) {
        GraphBegin::Cached(cached) => {
            assert!(cached.window.is_some(), "the child receives the window");
            assert_eq!(live(&fixture).0, 1);
            drop(cached);
        }
        _ => panic!("the child's begin is the cache hit"),
    }
    assert_eq!(
        live(&fixture),
        (0, 0),
        "the child's join (here: a drop) ends it"
    );
}

#[test]
fn a_cache_entry_that_is_discarded_ends_its_window() {
    let fixture = gate_fixture();
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    ticket.finish(GraphTicketUse::Unused);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 1);
    assert_eq!(live(&fixture).0, 1);
    // A begin for another key finds an entry it cannot use and drops it.
    wait_until("the session's end", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    let other = fixture
        .state
        .nir1_graph
        .begin_deferred(&fixture.state, fixture.query("another-entity"));
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
    assert_eq!(live(&fixture), (0, 0));
    drop(other);
}

#[test]
fn a_shutdown_and_an_edge_end_every_window() {
    let fixture = gate_fixture();
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    assert_eq!(live(&fixture).0, 1);
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: u64::MAX });
    assert_eq!(live(&fixture), (0, 0), "an edge ends the window at once");
    drop(enter(&fixture));
    drop(ticket);
    let fixture = gate_fixture();
    let ticket = released(&fixture);
    let _ = wait_answered(&ticket);
    fixture.state.nir1_graph.close_for_shutdown();
    assert_eq!(live(&fixture), (0, 0), "a shutdown ends the window at once");
    drop(ticket);
}

#[test]
fn a_cancellation_during_the_admission_ends_the_window_it_raced() {
    let fixture = gate_fixture();
    let entered = Arc::new(AtomicBool::new(false));
    let go = Arc::new(AtomicBool::new(false));
    let windows = Arc::new(AtomicUsize::new(usize::MAX));
    {
        let entered = Arc::clone(&entered);
        let go = Arc::clone(&go);
        let windows = Arc::clone(&windows);
        let gate = gate(&fixture);
        fixture
            .state
            .nir1_graph
            .set_admit_hook_for_test(Arc::new(move || {
                windows.store(gate.live_for_test().0, Ordering::SeqCst);
                entered.store(true, Ordering::SeqCst);
                while !go.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(1));
                }
            }));
    }
    let ticket = released(&fixture);
    wait_until("the admission", || entered.load(Ordering::SeqCst));
    assert_eq!(windows.load(Ordering::SeqCst), 1);
    ticket.finish(GraphTicketUse::Cancelled);
    assert_eq!(live(&fixture), (0, 0), "the cancellation ends the window");
    go.store(true, Ordering::SeqCst);
    wait_until("the slot to be free", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert_eq!(live(&fixture), (0, 0));
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
}

#[test]
fn an_owner_panic_ends_the_window_of_its_query() {
    let fixture = gate_fixture();
    *lock(&fixture.plan.query_mode) = QueryMode::Panic;
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Unavailable(GraphUnavailable::Failed)
    ));
    assert_eq!(live(&fixture), (0, 0));
}

#[test]
fn the_window_waits_for_a_freshness_section_in_flight() {
    let fixture = gate_fixture();
    let at_admit = windows_at_admit(&fixture);
    let section = enter(&fixture);
    let ticket = released(&fixture);
    let gate = gate(&fixture);
    wait_until("the owner to wait at the gate", || {
        gate.graph_waiters_for_test() == 1
    });
    assert_eq!(fixture.plan.creates.load(Ordering::SeqCst), 0);
    assert!(
        lock(&at_admit).is_empty(),
        "no admission while the section is in flight"
    );
    drop(section);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    assert_eq!(*lock(&at_admit), vec![1]);
    let counters = fixture.diagnostics().gate;
    assert_eq!((counters.graph_waited, counters.graph_wait_expired), (1, 0));
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn past_its_budget_the_held_query_goes_on_without_a_window() {
    let fixture = fixture_with(ProductFixture::new(), Duration::from_millis(100));
    let at_admit = windows_at_admit(&fixture);
    let section = enter(&fixture);
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    assert_eq!(*lock(&at_admit), vec![0], "admitted without a window");
    assert_eq!(live(&fixture), (0, 1));
    let counters = fixture.diagnostics().gate;
    assert_eq!(
        (counters.graph_wait_expired, counters.windows_opened),
        (1, 0)
    );
    drop(section);
    ticket.finish(GraphTicketUse::Used);
}

#[test]
fn freshness_waits_for_an_open_window_and_enters_when_it_ends() {
    let fixture = gate_fixture();
    let ticket = released(&fixture);
    assert!(matches!(
        wait_answered(&ticket),
        GraphTicketOutcome::Available(_)
    ));
    let gate = gate(&fixture);
    let freshness = {
        let gate = Arc::clone(&gate);
        thread::spawn(move || match gate.enter_freshness(|| false) {
            FreshnessAdmission::Admitted(_) => "admitted",
            FreshnessAdmission::Overridden(_) => "overridden",
            FreshnessAdmission::Deferred => "deferred",
            FreshnessAdmission::Stopped => "stopped",
        })
    };
    wait_until("Freshness to wait at the gate", || {
        gate.freshness_blocked_for_test()
    });
    ticket.finish(GraphTicketUse::Used);
    assert_eq!(freshness.join().expect("join"), "admitted");
    assert_eq!(gate.counters().waited_admit, 1);
}

#[test]
fn a_closed_product_never_opens_a_window_and_freshness_never_waits() {
    let fixture = fixture_with(
        ProductFixture::with(false, true, true),
        Duration::from_secs(20),
    );
    assert!(matches!(
        begin_deferred(&fixture),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
    let started = Instant::now();
    drop(enter(&fixture));
    assert!(started.elapsed() < Duration::from_millis(50));
    assert_eq!(fixture.diagnostics().gate, Default::default());
    assert_eq!(live(&fixture), (0, 0));
}
