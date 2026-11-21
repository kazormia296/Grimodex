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

/// A Suspended slot holds no project of its own, so a demand from another
/// project of the same workspace names the project whose refusal suspended the
/// slot (the only one whose B can fix it), in both begin entries. Naming the
/// demanding project would wake a B that has nothing to do with the refusal.
#[test]
fn a_suspended_begin_of_another_project_names_the_refused_project() {
    const OTHER: &str = "other-project";
    let fixture = ProductFixture::new();
    inject_open_token(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    suspend(&fixture);
    let before = demand_count(&fixture);
    let other = || GraphQuery {
        project_id: OTHER.into(),
        query_scene_id: SCENE.into(),
        seed_entity_id: "entity".into(),
    };
    assert!(matches!(
        fixture.state.nir1_graph.begin(&fixture.state, other()),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
    assert!(matches!(
        fixture
            .state
            .nir1_graph
            .begin_deferred(&fixture.state, other()),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
    let payloads = demand_payloads(&fixture);
    assert_eq!(payloads.len(), before + 2);
    let refused = format!(r#"{{"projectId":"{PROJECT}"}}"#);
    assert!(
        payloads[before..].iter().all(|payload| *payload == refused),
        "{:?}",
        &payloads[before..]
    );
    assert!(payloads.iter().all(|payload| !payload.contains(OTHER)));
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

/// DR-PUBG-5-14 (R2): a refusal that ends after a lifecycle edge (a workspace
/// switch) asks for nothing, because the event carries no binding and the old
/// workspace's refusal must not wake a project of the same name in the new one.
/// The control (no edge) asks once.
#[test]
fn a_refusal_that_ends_after_a_lifecycle_edge_asks_for_nothing() {
    for edge_during_prepare in [false, true] {
        let fixture = ProductFixture::new();
        inject_open_token(&fixture);
        *lock(&fixture.plan.prepare_mode) = PrepareMode::HoldThenFail(REFUSED);
        assert!(matches!(
            fixture.begin("entity"),
            GraphBegin::Unavailable(GraphUnavailable::Warming)
        ));
        wait_until("prepare is held", || {
            fixture.plan.prepares.load(Ordering::SeqCst) == 1
        });
        if edge_during_prepare {
            fixture
                .state
                .nir1_graph
                .edge_observer_for_test()
                .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: 1 });
        }
        fixture.plan.release.store(true, Ordering::SeqCst);
        wait_until("the failed prepare ended", || {
            lock(&fixture.state.nir1_graph.shared.slot)
                .rebuild
                .consecutive_failures
                == 1
        });
        // Give a (wrongly) late request time to arrive.
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            demand_count(&fixture),
            usize::from(!edge_during_prepare),
            "edge during prepare: {edge_during_prepare}"
        );
    }
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

/// DR-PUBG-5-18 (R-B), through a real `open_workspace` switch with no hook: once
/// the replacement is Ready, the Suspended slot an old workspace left behind is
/// stale (the Ready publication moved `ready_generation`). A begin starts a new
/// session instead of answering `registration-unavailable`, and so does not name
/// the old workspace's refused project in a new demand. This pins only that.
/// Here every demand was raised before the open, with no participant held, so
/// it says nothing about the order of those demands and `workspace:opened`: that
/// rests on the participant test below and on the reading in the DR (the
/// callers of both Suspended branches hold a participant while they ask). A
/// refusal that finishes after the switch is the next test.
#[tokio::test]
async fn once_the_replacement_is_ready_the_stale_suspended_slot_answers_and_asks_nothing() {
    for deferred in [false, true] {
        let fixture = RefusalFixture::new(if deferred { "rb-deferred" } else { "rb-begin" });
        let state = Arc::clone(fixture.state());
        *lock(&state.nir1_graph.shared.index_demand_product_for_test) = Some(open_token());
        *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
        let query = GraphQuery {
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        };
        let ask = |state: &Arc<AppState>| -> GraphBegin {
            if deferred {
                state.nir1_graph.begin_deferred(state, query.clone())
            } else {
                state.nir1_graph.begin(state, query.clone())
            }
        };
        let events = |state: &Arc<AppState>| state.events.pending_for_test();
        let demands = |state: &Arc<AppState>| {
            events(state)
                .iter()
                .filter(|(channel, _)| channel == GRAPH_INDEX_DEMAND_EVENT)
                .count()
        };

        wait_until("suspended after five failures", || {
            let _ = state.nir1_graph.begin(&state, query.clone());
            state.nir1_graph.slot_kind_for_test() == GraphSlotKind::Suspended
        });
        // The control: a begin that meets the Suspended slot asks for B.
        let before_control = demands(&state);
        assert!(matches!(
            ask(&state),
            GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
        ));
        let asked = demands(&state);
        assert_eq!(asked, before_control + 1, "deferred: {deferred}");

        // A session of the replacement must not be refused (and so not ask).
        *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
        let opened = fixture
            .backend
            .open_workspace(fixture.w2.to_string_lossy().into_owned())
            .await
            .expect("open outcome");
        let opened: serde_json::Value = serde_json::from_str(&opened).expect("open JSON");
        assert!(
            matches!(opened["status"].as_str(), Some("ready" | "migrated")),
            "deferred: {deferred}: {opened}"
        );

        assert_eq!(demands(&state), asked, "deferred: {deferred}");

        // The replacement is Ready: the old Suspended slot is stale and a begin
        // starts a new session (held, so it neither answers nor asks).
        match ask(&state) {
            GraphBegin::Unavailable(GraphUnavailable::Warming) => {}
            GraphBegin::Pending(ticket) => ticket.finish(GraphTicketUse::Unused),
            GraphBegin::Unavailable(reason) => panic!(
                "deferred: {deferred}: a stale Suspended slot answered {}",
                reason.as_str()
            ),
            GraphBegin::Cached(_) => panic!("deferred: {deferred}: unexpected cache hit"),
        }
        assert_eq!(demands(&state), asked, "deferred: {deferred}");
        fixture.plan.release.store(true, Ordering::SeqCst);
    }
}

/// DR-PUBG-5-18 (追補 4, 窓 1), with a hook: a prepare that fails (the fifth, so
/// the slot suspends) and releases its participant, as the real worker does
/// inside `prepare`, then stalls while a whole `open_workspace` switch completes
/// and the replacement is Ready. The owner thread then finishes the failure
/// branch. The Suspended slot it leaves must be stale: it records the
/// `ready_generation` read while the owner thread still held the participant,
/// not one read after the switch. If it carried the new generation, a begin in
/// the replacement would see a current Suspended slot, answer
/// `registration-unavailable` and raise a demand for the old workspace's refused
/// project (after `workspace:opened`, bound by main to the new binding).
#[tokio::test]
async fn a_refusal_that_finishes_after_the_switch_leaves_a_stale_suspended_slot() {
    for deferred in [false, true] {
        let fixture = RefusalFixture::new(if deferred {
            "rb-late-deferred"
        } else {
            "rb-late"
        });
        let state = Arc::clone(fixture.state());
        *lock(&state.nir1_graph.shared.index_demand_product_for_test) = Some(open_token());
        state.nir1_graph.set_config_for_test(GraphOwnerConfig {
            failures_before_suspend: 1,
            ..fast_config()
        });
        *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
        fixture
            .plan
            .prepare_failure_stalls
            .store(true, Ordering::SeqCst);
        let query = GraphQuery {
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        };
        let demands = |state: &Arc<AppState>| {
            state
                .events
                .pending_for_test()
                .iter()
                .filter(|(channel, _)| channel == GRAPH_INDEX_DEMAND_EVENT)
                .count()
        };

        // The first prepare fails, drops its participant and stalls.
        let _ = state.nir1_graph.begin(&state, query.clone());
        wait_until(
            "the prepare stalled after releasing its participant",
            || fixture.plan.prepare_stalled.load(Ordering::SeqCst) == 1,
        );
        assert_ne!(
            state.nir1_graph.slot_kind_for_test(),
            GraphSlotKind::Suspended,
            "deferred: {deferred}: the slot suspends only when the owner thread finishes"
        );

        // The whole switch completes while the owner thread is stalled.
        let ready_generation = |state: &Arc<AppState>| {
            state
                .nir1_graph
                .shared
                .ready_generation
                .load(Ordering::SeqCst)
        };
        let generation_before = ready_generation(&state);
        let opened = tokio::time::timeout(
            Duration::from_secs(10),
            fixture
                .backend
                .open_workspace(fixture.w2.to_string_lossy().into_owned()),
        )
        .await
        .expect("the switch completes while the owner thread is stalled")
        .expect("open outcome");
        let opened: serde_json::Value = serde_json::from_str(&opened).expect("open JSON");
        assert!(
            matches!(opened["status"].as_str(), Some("ready" | "migrated")),
            "deferred: {deferred}: {opened}"
        );
        assert!(
            ready_generation(&state) > generation_before,
            "deferred: {deferred}: the switch published a Ready"
        );
        let asked = demands(&state);

        // The owner thread resumes, in the replacement's lifecycle.
        *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
        fixture
            .plan
            .prepare_stall_release
            .store(true, Ordering::SeqCst);
        wait_until("the old session ended Suspended", || {
            state.nir1_graph.slot_kind_for_test() == GraphSlotKind::Suspended
        });
        assert_eq!(
            demands(&state),
            asked,
            "deferred: {deferred}: a refusal that ended after a lifecycle edge asks for nothing"
        );

        // The stale slot answers nothing: a begin starts a new session (held,
        // so it neither answers nor asks).
        let begin = if deferred {
            state.nir1_graph.begin_deferred(&state, query.clone())
        } else {
            state.nir1_graph.begin(&state, query.clone())
        };
        match begin {
            GraphBegin::Unavailable(GraphUnavailable::Warming) => {}
            GraphBegin::Pending(ticket) => ticket.finish(GraphTicketUse::Unused),
            GraphBegin::Unavailable(reason) => panic!(
                "deferred: {deferred}: a Suspended slot that finished after the switch answered {}",
                reason.as_str()
            ),
            GraphBegin::Cached(_) => panic!("deferred: {deferred}: unexpected cache hit"),
        }
        assert_eq!(demands(&state), asked, "deferred: {deferred}");
        fixture.plan.release.store(true, Ordering::SeqCst);
    }
}

/// DR-PUBG-5-18 (R-B): the reason the Suspended branches' events come before
/// `workspace:opened`. Their callers (Related Scenes' `begin_admitted`, D-final's
/// `ActiveWorkspaceSnapshot`) hold a workspace participant while they ask, and a
/// switch cannot reach its physical boundary (the swap, then E2) until every
/// participant has gone. Here a participant is held the way D-final holds one:
/// the open is admitted but queues no `workspace:opened` and does not finish;
/// once the participant is dropped it completes and E2 is queued.
#[tokio::test]
async fn a_held_workspace_participant_keeps_workspace_opened_out_of_the_queue() {
    let fixture = RefusalFixture::new("rb-participant");
    let state = Arc::clone(fixture.state());
    let held = grimodex_db::state::active_workspace_snapshot(&state.ws).expect("a snapshot");
    let backend = crate::Backend {
        state: Arc::clone(&state),
    };
    let target = fixture.w2.to_string_lossy().into_owned();
    let open = tokio::spawn(async move { backend.open_workspace(target).await });
    let queued_opened = |state: &Arc<AppState>| {
        state
            .events
            .pending_for_test()
            .iter()
            .any(|(channel, _)| channel == "workspace:opened")
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !open.is_finished(),
        "the open finished under a held participant"
    );
    assert!(
        !queued_opened(&state),
        "workspace:opened was queued under a held participant"
    );
    drop(held);
    let opened = tokio::time::timeout(Duration::from_secs(10), open)
        .await
        .expect("the open settles once the participant is gone")
        .expect("open task")
        .expect("open outcome");
    let opened: serde_json::Value = serde_json::from_str(&opened).expect("open JSON");
    assert!(
        matches!(opened["status"].as_str(), Some("ready" | "migrated")),
        "{opened}"
    );
    assert!(queued_opened(&state), "no workspace:opened after the open");
}

// ---- DR-PUBG-5-21: B's publish of a refused project announces `graph-ready` ----

const OTHER_PROJECT: &str = "other-project";

/// A failure wait long enough that nothing but the publish can lift it within a
/// test (`fast_config`'s 20 ms would let a test pass without the fix).
fn long_backoff(fixture: &ProductFixture, failures_before_suspend: u32) {
    fixture.state.nir1_graph.set_config_for_test(GraphOwnerConfig {
        failure_backoff_initial: Duration::from_secs(60),
        failure_backoff_max: Duration::from_secs(60),
        failures_before_suspend,
        ..fast_config()
    });
}

/// One refused prepare: the ledger holds one failure and the slot is Empty again.
fn refuse_once(fixture: &ProductFixture, mode: PrepareMode) {
    *lock(&fixture.plan.prepare_mode) = mode;
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("one counted failure", || {
        fixture.kind() == GraphSlotKind::Empty
            && lock(&fixture.state.nir1_graph.shared.slot)
                .rebuild
                .consecutive_failures
                == 1
    });
}

/// B's publish for `project` (the build's own item, as the maintenance cycle
/// reports it).
fn publish_graph_index(fixture: &ProductFixture, project: &str) {
    fixture
        .state
        .nir1_graph
        .note_maintenance_work_completed(&grimodex_db::narrative_extraction::DesiredWork {
            project_id: project.into(),
            run_kind: AutomaticRunKind::Nir1GraphIndexBuild,
            work_key: "work".into(),
            semantic_epoch_id: None,
            reasons: vec!["test".into()],
        });
}

/// One demand through the entry under test; a held query's ticket is settled.
fn demand_through(fixture: &ProductFixture, deferred: bool, project: &str) -> Option<GraphUnavailable> {
    let query = GraphQuery {
        project_id: project.into(),
        query_scene_id: SCENE.into(),
        seed_entity_id: "entity".into(),
    };
    let begin = if deferred {
        fixture.state.nir1_graph.begin_deferred(&fixture.state, query)
    } else {
        fixture.state.nir1_graph.begin(&fixture.state, query)
    };
    match begin {
        GraphBegin::Unavailable(reason) => Some(reason),
        GraphBegin::Pending(ticket) => {
            ticket.finish(GraphTicketUse::Unused);
            None
        }
        GraphBegin::Cached(_) => panic!("unexpected cache hit"),
    }
}

fn notified(notices: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    lock(notices).clone()
}

fn failure_wait_is_set(fixture: &ProductFixture) -> bool {
    lock(&fixture.state.nir1_graph.shared.slot)
        .rebuild
        .last_failure_at
        .is_some()
}

/// A refused project's publish announces it once, after B's own work, and lifts
/// the failure wait once (the failure count stays), through both begin entries.
#[test]
fn a_publish_of_the_refused_project_announces_it_once_and_lifts_the_wait() {
    for deferred in [false, true] {
        let fixture = ProductFixture::new();
        let notices = recording_notifier(&fixture);
        long_backoff(&fixture, 5);
        refuse_once(&fixture, PrepareMode::Fail(REFUSED));
        // Inside the wait the demand is answered as before, and waits for B.
        assert_eq!(
            demand_through(&fixture, deferred, PROJECT),
            Some(GraphUnavailable::RegistrationUnavailable),
            "deferred: {deferred}"
        );
        assert!(failure_wait_is_set(&fixture));
        assert!(notified(&notices).is_empty());

        publish_graph_index(&fixture, PROJECT);
        assert_eq!(notified(&notices), vec![PROJECT.to_owned()], "deferred: {deferred}");
        assert!(!failure_wait_is_set(&fixture), "deferred: {deferred}");
        assert_eq!(
            lock(&fixture.state.nir1_graph.shared.slot)
                .rebuild
                .consecutive_failures,
            1,
            "the failure count stays"
        );
        // A second publish has nothing left to announce or lift.
        publish_graph_index(&fixture, PROJECT);
        assert_eq!(notified(&notices), vec![PROJECT.to_owned()], "deferred: {deferred}");

        // The next demand starts a session instead of meeting the wait.
        *lock(&fixture.plan.prepare_mode) = PrepareMode::Ok;
        assert_ne!(
            demand_through(&fixture, deferred, PROJECT),
            Some(GraphUnavailable::RegistrationUnavailable),
            "deferred: {deferred}"
        );
    }
}

/// A publish of another project does not fix this refusal: nothing is
/// announced and the wait stays. The refused project's own publish does.
#[test]
fn a_publish_of_another_project_announces_nothing_and_keeps_the_wait() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    long_backoff(&fixture, 5);
    refuse_once(&fixture, PrepareMode::Fail(REFUSED));
    publish_graph_index(&fixture, OTHER_PROJECT);
    assert!(notified(&notices).is_empty());
    assert!(failure_wait_is_set(&fixture));
    assert_eq!(
        demand_through(&fixture, false, PROJECT),
        Some(GraphUnavailable::RegistrationUnavailable)
    );
    publish_graph_index(&fixture, PROJECT);
    assert_eq!(notified(&notices), vec![PROJECT.to_owned()]);
}

/// Without a refused registration (no failure, or a failure of another kind)
/// B's publish announces nothing and lifts no wait.
#[test]
fn a_publish_without_a_refusal_announces_nothing() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    publish_graph_index(&fixture, PROJECT);
    assert!(notified(&notices).is_empty());

    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    long_backoff(&fixture, 5);
    refuse_once(&fixture, PrepareMode::Fail(EXIT_BEFORE_READY));
    publish_graph_index(&fixture, PROJECT);
    assert!(notified(&notices).is_empty());
    assert!(failure_wait_is_set(&fixture));
    assert_eq!(
        demand_through(&fixture, false, PROJECT),
        Some(GraphUnavailable::WorkerUnavailable)
    );
}

/// A Suspended worker failure (not a refusal) is not lifted by B's publish
/// beyond D49, and announces nothing.
#[test]
fn a_suspension_for_another_reason_announces_nothing() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(EXIT_BEFORE_READY);
    suspend(&fixture);
    publish_graph_index(&fixture, PROJECT);
    assert!(notified(&notices).is_empty());
    assert_eq!(fixture.kind(), GraphSlotKind::Empty, "D49 still leaves Suspended");
}

/// A refusal of an older lifecycle epoch (a workspace switch since) announces
/// nothing, and neither does a refusal that ended after the edge.
#[test]
fn a_publish_after_a_lifecycle_edge_announces_nothing() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    long_backoff(&fixture, 5);
    refuse_once(&fixture, PrepareMode::Fail(REFUSED));
    assert_eq!(
        demand_through(&fixture, false, PROJECT),
        Some(GraphUnavailable::RegistrationUnavailable)
    );
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: 1 });
    publish_graph_index(&fixture, PROJECT);
    assert!(notified(&notices).is_empty());
    assert!(
        failure_wait_is_set(&fixture),
        "the old workspace's refusal lifts nothing"
    );

    // The refusal ends after the edge: it is not recorded at all.
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::HoldThenFail(REFUSED);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    wait_until("prepare is held", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: 1 });
    fixture.plan.release.store(true, Ordering::SeqCst);
    wait_until("the failed prepare ended", || {
        lock(&fixture.state.nir1_graph.shared.slot)
            .rebuild
            .consecutive_failures
            == 1
    });
    publish_graph_index(&fixture, PROJECT);
    assert!(notified(&notices).is_empty());
}

/// After a close nothing is announced.
#[test]
fn a_publish_after_close_announces_nothing() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    long_backoff(&fixture, 5);
    refuse_once(&fixture, PrepareMode::Fail(REFUSED));
    assert_eq!(
        demand_through(&fixture, false, PROJECT),
        Some(GraphUnavailable::RegistrationUnavailable)
    );
    fixture.state.nir1_graph.close_for_shutdown();
    publish_graph_index(&fixture, PROJECT);
    assert!(notified(&notices).is_empty());
}

/// A suspension by refusal: one publish announces the project once, however many
/// demands the Suspended slot answered, through both entries.
#[test]
fn a_suspended_refusal_is_announced_once_by_the_publish() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
    suspend(&fixture);
    for deferred in [false, true, false] {
        assert_eq!(
            demand_through(&fixture, deferred, PROJECT),
            Some(GraphUnavailable::RegistrationUnavailable)
        );
    }
    assert!(notified(&notices).is_empty());
    publish_graph_index(&fixture, PROJECT);
    assert_eq!(notified(&notices), vec![PROJECT.to_owned()]);
    assert_eq!(fixture.kind(), GraphSlotKind::Empty);
    publish_graph_index(&fixture, PROJECT);
    assert_eq!(notified(&notices), vec![PROJECT.to_owned()]);
}

/// DR-PUBG-5-21 判断 2 (ii): a demand of another project that met the refusal
/// (inside the wait, or from the Suspended slot) is announced too, once, by the
/// refused project's publish; its own project's publish is not the one that
/// fixes it.
#[test]
fn a_demanding_project_other_than_the_refused_one_is_announced_too() {
    for suspended in [false, true] {
        for deferred in [false, true] {
            let fixture = ProductFixture::new();
            let notices = recording_notifier(&fixture);
            if suspended {
                *lock(&fixture.plan.prepare_mode) = PrepareMode::Fail(REFUSED);
                suspend(&fixture);
            } else {
                long_backoff(&fixture, 5);
                refuse_once(&fixture, PrepareMode::Fail(REFUSED));
            }
            assert_eq!(
                demand_through(&fixture, deferred, OTHER_PROJECT),
                Some(GraphUnavailable::RegistrationUnavailable),
                "suspended: {suspended}, deferred: {deferred}"
            );
            publish_graph_index(&fixture, OTHER_PROJECT);
            assert!(
                notified(&notices).is_empty(),
                "suspended: {suspended}, deferred: {deferred}"
            );
            publish_graph_index(&fixture, PROJECT);
            let mut announced = notified(&notices);
            announced.sort();
            assert_eq!(
                announced,
                vec![OTHER_PROJECT.to_owned(), PROJECT.to_owned()],
                "suspended: {suspended}, deferred: {deferred}"
            );
        }
    }
}

/// The record is bounded: more refused projects than `MAX_UNSERVED_PROJECTS`
/// drop the oldest, and each row's waiting list is bounded the same way.
#[test]
fn the_refusal_record_is_bounded() {
    let mut slot = SlotState {
        phase: Phase::Empty,
        session: None,
        rebuild: RebuildLedger::default(),
        exited: Vec::new(),
        deferred: None,
        refusals: Vec::new(),
    };
    for at in 0..MAX_UNSERVED_PROJECTS + 3 {
        slot.watch_refusal(&format!("refused-{at}"), "demand", 7);
    }
    assert_eq!(slot.refusals.len(), MAX_UNSERVED_PROJECTS);
    assert!(slot.take_refusal("refused-0", 7).is_none());
    assert!(slot.take_refusal("refused-10", 7).is_some());
    for at in 0..MAX_UNSERVED_PROJECTS + 3 {
        slot.watch_refusal("one", &format!("waiting-{at}"), 7);
    }
    let waiting = slot.take_refusal("one", 7).expect("a row");
    assert_eq!(waiting.len(), MAX_UNSERVED_PROJECTS);
    assert_eq!(waiting[0], "waiting-3");
    // A row of another epoch is dropped, never returned.
    slot.watch_refusal("old", "demand", 7);
    assert!(slot.take_refusal("old", 8).is_none());
    assert!(slot.refusals.is_empty());
}
