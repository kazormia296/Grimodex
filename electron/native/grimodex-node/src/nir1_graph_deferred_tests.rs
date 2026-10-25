//! CQ-DEFER tests (design D′; `docs/plans/nir1-lane-decisions/cq-deferred-decisions.md`).
//!
//! A Related Scenes begin commits the audit of its query embedding right after
//! it hands the Graph its query. The owner holds that query (`begin_deferred`)
//! until the begin releases it after those commits, and only then prepares a
//! worker and answers it. P* and N* are the Positive and Negative cases of the
//! TASK (§4). `i_a_*` is the integration with the real database, the product's
//! own audit writer and a worker that checks drift the way the real one does;
//! `i_b_*` is the same with the real worker binary (opt-in).
use super::*;

use grimodex_db::narrative_extraction::nir1_graph::c_query_worker::CQueryWorkerUnavailable;
use grimodex_db::narrative_extraction::nir1_graph::worker_frame::UnavailableReason;
use grimodex_semantic::audit::{
    embedding_output_payload, SemanticAuditAppender, SemanticAuditContext, SemanticAuditSession,
    TokenizerIdentity,
};
use serde_json::json;
use std::sync::atomic::AtomicUsize;

fn begin_deferred(fixture: &ProductFixture, seed: &str) -> GraphBegin {
    fixture
        .state
        .nir1_graph
        .begin_deferred(&fixture.state, fixture.query(seed))
}

fn begin_deferred_for(fixture: &ProductFixture, project: &str) -> GraphBegin {
    fixture.state.nir1_graph.begin_deferred(
        &fixture.state,
        GraphQuery {
            project_id: project.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        },
    )
}

fn creates(fixture: &ProductFixture) -> usize {
    fixture.plan.creates.load(Ordering::SeqCst)
}

fn outcome(ticket: &GraphTicket) -> GraphTicketOutcome {
    ticket
        .wait_timeout(Duration::from_secs(5))
        .expect("the ticket settles")
}

fn assert_unavailable(outcome: GraphTicketOutcome, expected: GraphUnavailable) {
    match outcome {
        GraphTicketOutcome::Unavailable(reason) => assert_eq!(reason, expected),
        GraphTicketOutcome::Available(_) => panic!("expected {expected:?}, got a Graph"),
    }
}

/// A commit of the workspace's own connection: an edit's save (F10).
fn commit_an_edit(fixture: &ProductFixture, title: &str) {
    active_workspace_snapshot(&fixture.state.ws)
        .expect("workspace")
        .db()
        .with_conn(|conn| {
            conn.execute("UPDATE tree_nodes SET title=?1 WHERE id=?2", (title, SCENE))?;
            Ok(())
        })
        .expect("edit");
}

// ---- Positive ----------------------------------------------------------------

/// P1: nothing is prepared before the release; afterwards the query is served
/// at once, the READY is never published or announced, an `unused` result
/// fills the cache with exactly one notice, the slot ends Empty without a
/// rebuild, and the renderer's re-query is the cache hit.
#[test]
fn p1_a_held_query_prepares_only_after_its_release_and_is_announced_once() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(begin_deferred(&fixture, "entity"));
    assert_eq!(fixture.kind(), GraphSlotKind::Deferred);
    // Longer than the rebuild window: only the release starts a prepare.
    thread::sleep(Duration::from_millis(80));
    assert_eq!(
        creates(&fixture),
        0,
        "nothing is created before the release"
    );
    assert_eq!(fixture.plan.prepares.load(Ordering::SeqCst), 0);
    assert!(ticket.poll().is_none());
    let released_at = Instant::now();
    ticket.release_after_own_commits();
    wait_until("the held query to reach the worker", || {
        fixture.plan.queries.load(Ordering::SeqCst) == 1
    });
    assert!(lock(&fixture.plan.create_times)[0] >= released_at);
    assert_eq!(
        fixture.kind(),
        GraphSlotKind::InUse,
        "the READY of a held query is never published"
    );
    assert!(
        lock(&notices).is_empty(),
        "the READY of a held query announces nothing"
    );
    let waiter = ticket.waiter();
    ticket.finish(GraphTicketUse::Unused);
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        waiter.wait_timeout(Duration::from_secs(5)),
        Some(GraphTicketOutcome::Available(_))
    ));
    wait_until("the late cache", || {
        fixture.state.nir1_graph.cache_len_for_test() == 1
    });
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    thread::sleep(Duration::from_millis(80));
    assert_eq!(creates(&fixture), 1, "no rebuild after a held query");
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(*lock(&notices), vec![PROJECT.to_string()]);
    let diagnostics = fixture.diagnostics();
    assert_eq!(diagnostics.deferred_released, 1);
    assert_eq!(diagnostics.prepares_ready, 1);
    assert!(matches!(
        begin_deferred(&fixture, "entity"),
        GraphBegin::Cached(_)
    ));
    assert_eq!(lock(&notices).len(), 1);
}

/// P2: D-final's `begin` is unchanged: warming at once, a READY that is
/// announced, a query, and the rebuild afterwards.
#[test]
fn p2_dfinal_still_warms_at_once_and_rebuilds_after_its_query() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    fixture.warm();
    wait_until("the READY notice", || lock(&notices).len() == 1);
    let ticket = pending(fixture.begin("entity"));
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Used);
    wait_until("the rebuilt READY", || {
        creates(&fixture) == 2 && fixture.kind() == GraphSlotKind::Ready
    });
    assert_eq!(fixture.diagnostics().deferred_released, 0);
}

/// P3: a READY prepared before the begin's commits is retired unqueried; the
/// query is served by a worker created after the release.
#[test]
fn p3_a_ready_worker_prepared_before_the_release_is_retired_unqueried() {
    let fixture = ProductFixture::new();
    fixture.warm();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    // The owner counts the retirement once the worker's `retire` returned.
    wait_until("the READY worker to retire", || {
        fixture.diagnostics().stale_ready_retired == 1
    });
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.kind(), GraphSlotKind::Deferred);
    assert_eq!(fixture.diagnostics().stale_ready_retired, 1);
    thread::sleep(Duration::from_millis(60));
    assert_eq!(creates(&fixture), 1);
    let released_at = Instant::now();
    ticket.release_after_own_commits();
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    assert_eq!(creates(&fixture), 2);
    assert!(lock(&fixture.plan.create_times)[1] >= released_at);
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 1);
    ticket.finish(GraphTicketUse::Used);
}

/// P3 (another key): a READY of another project is taken over only under the
/// rekey rule; within the rebuild interval of its last demand it is busy.
#[test]
fn p3_a_ready_of_another_key_is_taken_over_only_under_the_rekey_rule() {
    let fixture = ProductFixture::new();
    fixture
        .state
        .nir1_graph
        .set_config_for_test(GraphOwnerConfig {
            rebuild_min_interval: Duration::from_millis(200),
            ..fast_config()
        });
    fixture.warm();
    assert!(matches!(
        begin_deferred_for(&fixture, "other-project"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert_eq!(fixture.kind(), GraphSlotKind::Ready);
    thread::sleep(Duration::from_millis(220));
    let ticket = pending(begin_deferred_for(&fixture, "other-project"));
    assert_eq!(fixture.kind(), GraphSlotKind::Deferred);
    // The owner counts the retirement once the worker's `retire` returned.
    wait_until("the READY worker to retire", || {
        fixture.diagnostics().stale_ready_retired == 1
    });
    assert_eq!(fixture.plan.retires.load(Ordering::SeqCst), 1);
    ticket.release_after_own_commits();
    match outcome(&ticket) {
        GraphTicketOutcome::Available(projection) => {
            assert_eq!(projection.project_id, "other-project")
        }
        other => panic!("expected a Graph, got {other:?}"),
    }
    ticket.finish(GraphTicketUse::Used);
}

/// P1-1 (a): a demand that a held session made wait (`busy`, `warming`) is
/// announced once, when that session ends: the held session's READY announces
/// nothing, so without this it would wait for an unrelated READY.
#[test]
fn p4_a_demand_made_to_wait_by_a_held_session_is_announced_once_at_its_end() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.query_mode) = QueryMode::Hold;
    let ticket = pending(begin_deferred(&fixture, "entity"));
    ticket.release_after_own_commits();
    wait_until("the held query to reach the worker", || {
        fixture.plan.queries.load(Ordering::SeqCst) == 1
    });
    // Another window's begin, and one for another project, are made to wait.
    assert!(matches!(
        begin_deferred(&fixture, "entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert!(matches!(
        begin_deferred_for(&fixture, "other-project"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert!(lock(&notices).is_empty());
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Used);
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    wait_until("the end-of-session notices", || lock(&notices).len() == 2);
    thread::sleep(Duration::from_millis(80));
    let mut announced = lock(&notices).clone();
    announced.sort();
    assert_eq!(
        announced,
        vec!["other-project".to_string(), PROJECT.to_string()],
        "each waiting project once"
    );
}

/// P1-1 (b): the held query's own stale answer (F10) is not announced, or an
/// edit in progress would loop notice → re-query → stale, five audit rows each.
#[test]
fn p4_the_held_querys_own_stale_answer_is_not_announced() {
    let fixture = ProductFixture::new();
    let notices = recording_notifier(&fixture);
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    let ticket = pending(begin_deferred(&fixture, "entity"));
    ticket.release_after_own_commits();
    wait_until("the prepare after the release", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    commit_an_edit(&fixture, "Edited while the held query prepares");
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert_unavailable(outcome(&ticket), GraphUnavailable::Stale);
    ticket.finish(GraphTicketUse::Unused);
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    thread::sleep(Duration::from_millis(80));
    assert!(lock(&notices).is_empty(), "{:?}", lock(&notices));
}

// ---- Negative ----------------------------------------------------------------

/// N1: a commit between the release and the query (F10) is still stale.
#[test]
fn n1_a_commit_after_the_release_is_still_stale() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    let ticket = pending(begin_deferred(&fixture, "entity"));
    ticket.release_after_own_commits();
    // S0 is read before the worker is created, so the edit lands after it.
    wait_until("the prepare after the release", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    commit_an_edit(&fixture, "Edited after the release");
    fixture.plan.release.store(true, Ordering::SeqCst);
    assert_unavailable(outcome(&ticket), GraphUnavailable::Stale);
    assert_eq!(fixture.diagnostics().stamp_stale, 1);
    assert_eq!(fixture.plan.queries.load(Ordering::SeqCst), 0);
    ticket.finish(GraphTicketUse::Unused);
}

/// P2-1: the hold outlasts a begin that takes longer than the Related Scenes
/// await (a cold start loads the model before its first audit commit): a
/// release more than `GRAPH_AWAIT_LIMIT` after the hand-over is still served.
#[test]
fn n2_a_release_later_than_the_await_limit_is_still_served() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    thread::sleep(Duration::from_millis(2_300));
    assert_eq!(fixture.kind(), GraphSlotKind::Deferred);
    ticket.release_after_own_commits();
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Used);
    assert_eq!(fixture.diagnostics().deferred_expired, 0);
}

/// N3: a hold that is never released ends at its limit; the slot is free.
#[test]
fn n3_an_unreleased_hold_expires_and_frees_the_slot() {
    let fixture = ProductFixture::new();
    fixture
        .state
        .nir1_graph
        .set_deferred_release_limit_for_test(Duration::from_millis(80));
    let started = Instant::now();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    assert_unavailable(outcome(&ticket), GraphUnavailable::Timeout);
    assert!(started.elapsed() >= Duration::from_millis(70));
    wait_until("the slot to be free", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert_eq!(fixture.diagnostics().deferred_expired, 1);
    // A late release does nothing.
    ticket.release_after_own_commits();
    thread::sleep(Duration::from_millis(60));
    assert_eq!(creates(&fixture), 0);
    assert_eq!(fixture.diagnostics().deferred_released, 0);
    ticket.finish(GraphTicketUse::Unused);
    // The next query is held again.
    let next = pending(begin_deferred(&fixture, "entity"));
    next.finish(GraphTicketUse::Cancelled);
}

/// N3: an unreleased ticket that is dropped frees the slot at once (the
/// cancellation wakes the owner thread; it does not wait out the hold).
#[test]
fn n3_dropping_an_unreleased_ticket_frees_the_slot_at_once() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    // Let the owner thread reach its wait: the cancellation must wake it.
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.kind(), GraphSlotKind::Deferred);
    let dropped_at = Instant::now();
    drop(ticket);
    wait_until("the slot to be free", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert!(dropped_at.elapsed() < Duration::from_secs(1));
    assert_eq!(creates(&fixture), 0);
    assert_eq!(fixture.diagnostics().deferred_dropped, 1);
    assert_eq!(fixture.state.nir1_graph.cache_len_for_test(), 0);
}

/// N4: a release after a lifecycle edge is invalidated and prepares nothing.
#[test]
fn n4_a_release_after_a_lifecycle_edge_is_invalidated_and_never_prepares() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    fixture
        .state
        .nir1_graph
        .edge_observer_for_test()
        .on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: u64::MAX });
    ticket.release_after_own_commits();
    assert_unavailable(outcome(&ticket), GraphUnavailable::Invalidated);
    wait_until("the slot to be free", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    thread::sleep(Duration::from_millis(60));
    assert_eq!(creates(&fixture), 0);
    assert_eq!(fixture.diagnostics().deferred_released, 0);
    ticket.finish(GraphTicketUse::Unused);
}

/// N5: a shutdown while a query is held invalidates it.
#[test]
fn n5_a_shutdown_while_a_query_is_held_invalidates_it() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    fixture.state.nir1_graph.close_for_shutdown();
    assert_unavailable(outcome(&ticket), GraphUnavailable::Invalidated);
    wait_until("the closed slot", || {
        fixture.kind() == GraphSlotKind::Closed
    });
    ticket.release_after_own_commits();
    thread::sleep(Duration::from_millis(60));
    assert_eq!(creates(&fixture), 0);
    ticket.finish(GraphTicketUse::Unused);
}

/// N6: while a query is held, a second Related Scenes query is busy, and
/// D-final waits (warming) for the same key and is busy for another.
#[test]
fn n6_a_second_query_while_one_is_held_is_busy() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    assert!(matches!(
        begin_deferred(&fixture, "entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    assert!(matches!(
        fixture.state.nir1_graph.begin(
            &fixture.state,
            GraphQuery {
                project_id: "other-project".into(),
                query_scene_id: SCENE.into(),
                seed_entity_id: "entity".into(),
            }
        ),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    assert_eq!(creates(&fixture), 0);
    ticket.finish(GraphTicketUse::Cancelled);
    wait_until("the slot to be free", || {
        fixture.kind() == GraphSlotKind::Empty
    });
}

/// N7: a second release, a release after a cancellation and a release by
/// another ticket do nothing.
#[test]
fn n7_a_second_release_or_one_after_a_cancellation_does_nothing() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    ticket.release_after_own_commits();
    ticket.release_after_own_commits();
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Used);
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    assert_eq!(fixture.diagnostics().deferred_released, 1);
    assert_eq!(creates(&fixture), 1);

    let cancelled = pending(begin_deferred(&fixture, "entity"));
    let release = cancelled.release_handle();
    cancelled.finish(GraphTicketUse::Cancelled);
    release.release_after_own_commits();
    wait_until("the slot to be free", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    thread::sleep(Duration::from_millis(60));
    assert_eq!(creates(&fixture), 1);
    assert_eq!(fixture.diagnostics().deferred_released, 1);
    assert_eq!(fixture.diagnostics().deferred_dropped, 1);

    // A ticket that is not the held one cannot release it (`Arc` identity).
    let held = pending(begin_deferred(&fixture, "entity"));
    let binding = ready_binding(&fixture.state).expect("Ready binding");
    let foreign = TicketShared::new(
        Arc::clone(&fixture.state.nir1_graph.shared),
        CacheKey {
            binding,
            caller_epoch: 0,
            project_id: PROJECT.into(),
            query_scene_id: SCENE.into(),
            seed_entity_id: "entity".into(),
        },
        fixture.state.nir1_graph.edge_epoch(),
        true,
    );
    fixture.state.nir1_graph.shared.release_deferred(&foreign);
    thread::sleep(Duration::from_millis(60));
    assert_eq!(fixture.kind(), GraphSlotKind::Deferred);
    assert_eq!(creates(&fixture), 1);
    held.release_after_own_commits();
    assert!(matches!(outcome(&held), GraphTicketOutcome::Available(_)));
    held.finish(GraphTicketUse::Used);
}

/// N8: registration refusals after the release (F10) still count: backoff,
/// then Suspended after five, and the suspended slot refuses the next query.
#[test]
fn n8_refusals_after_the_release_still_count_and_suspend_at_five() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) =
        PrepareMode::Fail("NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED: fake");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut answered = Vec::new();
    while fixture.kind() != GraphSlotKind::Suspended {
        assert!(Instant::now() < deadline, "not suspended: {answered:?}");
        if let GraphBegin::Pending(ticket) = begin_deferred(&fixture, "entity") {
            ticket.release_after_own_commits();
            if let GraphTicketOutcome::Unavailable(reason) = outcome(&ticket) {
                answered.push(reason);
            }
            ticket.finish(GraphTicketUse::Unused);
            wait_until("the end of the session", || {
                !matches!(
                    fixture.kind(),
                    GraphSlotKind::Deferred | GraphSlotKind::Preparing | GraphSlotKind::InUse
                )
            });
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        answered,
        vec![GraphUnavailable::RegistrationUnavailable; 5],
        "every refusal is answered through the held ticket"
    );
    assert_eq!(fixture.plan.prepares.load(Ordering::SeqCst), 5);
    assert_eq!(fixture.diagnostics().prepare_failures, 5);
    assert!(matches!(
        begin_deferred(&fixture, "entity"),
        GraphBegin::Unavailable(GraphUnavailable::RegistrationUnavailable)
    ));
}

/// N9: neither `begin_deferred` nor a release waits: not for a prepare in
/// progress, nor for the workspace lock.
#[test]
fn n9_begin_deferred_and_release_never_wait() {
    let fixture = ProductFixture::new();
    *lock(&fixture.plan.prepare_mode) = PrepareMode::Hold;
    let ticket = pending(begin_deferred(&fixture, "entity"));
    let started = Instant::now();
    ticket.release_after_own_commits();
    assert!(started.elapsed() < Duration::from_millis(100));
    wait_until("the held prepare", || {
        fixture.plan.prepares.load(Ordering::SeqCst) == 1
    });
    let started = Instant::now();
    assert!(matches!(
        begin_deferred(&fixture, "entity"),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    {
        let _workspace = lock_workspace_slot(&fixture.state);
        assert!(matches!(
            begin_deferred(&fixture, "entity"),
            GraphBegin::Unavailable(GraphUnavailable::Warming)
        ));
    }
    assert!(started.elapsed() < Duration::from_millis(500));
    ticket.finish(GraphTicketUse::Cancelled);
}

/// The S0 counter sees a release made inside an open read of the workspace's
/// connection (the owner's wait-0 stamp read finds the connection busy). The
/// begin releases outside every read (`begin_releases_the_held_query_…`).
#[test]
fn a_release_inside_an_open_read_shows_as_a_missing_s0_stamp() {
    let fixture = ProductFixture::new();
    let ticket = pending(begin_deferred(&fixture, "entity"));
    ticket.release_after_own_commits();
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Used);
    assert_eq!(fixture.diagnostics().stamp0_missing, 0);
    assert_eq!(fixture.diagnostics().stamp_fresh, 1);
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });
    let second = pending(begin_deferred(&fixture, "entity"));
    active_workspace_snapshot(&fixture.state.ws)
        .expect("workspace")
        .db()
        .with_read_transaction(|_conn| {
            second.release_after_own_commits();
            wait_until("the prepare of the second query", || {
                fixture.plan.prepares.load(Ordering::SeqCst) == 2
            });
            Ok(())
        })
        .expect("read");
    assert!(matches!(outcome(&second), GraphTicketOutcome::Available(_)));
    second.finish(GraphTicketUse::Used);
    assert_eq!(fixture.diagnostics().stamp0_missing, 1);
}

/// The begin releases its held query after the audited query embedding (its
/// only commits) and after its last participant read has closed, and before
/// the Index build is scheduled; the guard is the only releaser.
#[test]
fn begin_releases_the_held_query_after_its_own_commits_and_reads() {
    let source = include_str!("related_scenes/begin.rs");
    let at = |needle: &str| {
        assert_eq!(source.matches(needle).count(), 1, "{needle}");
        source.find(needle).expect("needle")
    };
    let handed_over = at("graph::begin_graph(");
    let embedding = at("prepare_related_scene_query(");
    let last_read = source
        .rfind("with_participant_read_transaction(")
        .expect("a participant read");
    let read_closed = at("ensure!(source_current");
    let outcome_decided = at("})();");
    let release = at("graph_release.release()");
    let schedule = at("build::schedule(");
    assert!(handed_over < embedding, "the query is handed over first");
    assert!(embedding < last_read && last_read < read_closed);
    assert!(read_closed < outcome_decided && outcome_decided < release);
    assert!(release < schedule);
    assert!(!source.contains("release_after_own_commits"));
}

// ---- (i-a) the integration: real database, the product's audit writer ---------

/// What a real worker checks, in the same shape: its own connection to the
/// workspace file reads `PRAGMA data_version` (which other connections' commits
/// move) when its registration starts and ends, and again at the query
/// (`nir1_graph.rs` registration and query drift checks).
#[derive(Default)]
struct DriftPlan {
    prepares: AtomicUsize,
    refused: AtomicUsize,
    queries: AtomicUsize,
    drifted: AtomicUsize,
    registering: AtomicBool,
    registration_ms: AtomicU64,
}

struct DriftFactory {
    db_path: PathBuf,
    plan: Arc<DriftPlan>,
}

struct DriftWorker {
    db_path: PathBuf,
    plan: Arc<DriftPlan>,
    _snapshot: ActiveWorkspaceSnapshot,
    connection: Option<grimodex_db::Database>,
    registered: Option<i64>,
}

fn data_version(db: &grimodex_db::Database) -> Result<i64> {
    db.with_conn(|conn| Ok(conn.query_row("PRAGMA data_version", [], |row| row.get(0))?))
}

impl GraphWorkerFactory for DriftFactory {
    fn create(&self, start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        Box::new(DriftWorker {
            db_path: self.db_path.clone(),
            plan: Arc::clone(&self.plan),
            _snapshot: start.snapshot,
            connection: None,
            registered: None,
        })
    }
}

impl GraphWorker for DriftWorker {
    fn prepare(&mut self, _project_id: &str) -> Result<()> {
        self.plan.prepares.fetch_add(1, Ordering::SeqCst);
        let db = grimodex_db::Database::new(&self.db_path)?;
        let before = data_version(&db)?;
        self.plan.registering.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(
            self.plan.registration_ms.load(Ordering::SeqCst),
        ));
        let after = data_version(&db)?;
        self.plan.registering.store(false, Ordering::SeqCst);
        if before != after {
            self.plan.refused.fetch_add(1, Ordering::SeqCst);
            return Err(anyhow!(
                "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED: drift-checking fake"
            ));
        }
        self.registered = Some(before);
        self.connection = Some(db);
        Ok(())
    }

    fn query(
        &mut self,
        request: &Nir1GraphRequest,
        _cancel: &AtomicBool,
    ) -> Result<Nir1GraphProjection> {
        self.plan.queries.fetch_add(1, Ordering::SeqCst);
        let db = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("not prepared"))?;
        if Some(data_version(db)?) != self.registered {
            self.plan.drifted.fetch_add(1, Ordering::SeqCst);
            return Err(CQueryWorkerUnavailable {
                reason: UnavailableReason::RegistrationDrift,
            }
            .into());
        }
        Ok(projection(request))
    }

    fn quarantined(&self) -> bool {
        false
    }

    fn retire(self: Box<Self>) -> CQueryRetirement {
        CQueryRetirement::Retired
    }
}

/// The commits of a Related Scenes begin as the product makes them
/// (`grimodex-semantic` `prepare_query_with` → `start_embedding_audit` with no
/// pre-dispatch preflight → `SemanticAuditSession::start`, the inference, then
/// `dispatch_and_run`): one append of `execution.started`, `request.prepared`,
/// `request.dispatched`, the inference, one append of `response.completed`,
/// `execution.succeeded`. Only the inference is a stand-in. Returns the
/// operation ID.
fn commit_like_a_begin(appender: Arc<dyn SemanticAuditAppender>, inference: Duration) -> String {
    let operation_id = format!("cq-defer-{}", uuid::Uuid::new_v4());
    let context = SemanticAuditContext {
        project_id: Some(PROJECT.into()),
        operation_id: operation_id.clone(),
        parent_execution_id: None,
        path_id: "semantic_search".into(),
        inference_kind: "embedding.query".into(),
        model: json!({
            "engine": "onnx-runtime",
            "tokenizerIdentity": TokenizerIdentity::from_bytes("tokenizer.json", b"cq-defer"),
        }),
        input: json!({"rawText": "the query"}),
        metadata: json!({
            "domain": "scene", "sceneScope": null, "descriptionMode": false,
            "sharedConsumers": ["raw-related-scenes", "nir1-related-scenes"],
        }),
    };
    let mut session = SemanticAuditSession::start(appender, context).expect("audit start");
    session
        .dispatch_and_run(
            || {
                thread::sleep(inference);
                Ok(vec![0.0_f32; 4])
            },
            |vector| embedding_output_payload(vector),
        )
        .expect("audit terminal");
    operation_id
}

fn audit_event_types(fixture: &ProductFixture, operation_id: &str) -> Vec<String> {
    active_workspace_snapshot(&fixture.state.ws)
        .expect("workspace")
        .db()
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT event_type FROM ai_audit_events WHERE operation_id=?1 ORDER BY sequence",
            )?;
            let types = statement
                .query_map([operation_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(types)
        })
        .expect("audit rows")
}

fn drift_fixture(registration: Duration) -> (ProductFixture, Arc<DriftPlan>) {
    let fixture = ProductFixture::with(true, true, false);
    let plan = Arc::new(DriftPlan::default());
    plan.registration_ms
        .store(registration.as_millis() as u64, Ordering::SeqCst);
    fixture
        .state
        .nir1_graph
        .install_worker_factory_for_test(Arc::new(DriftFactory {
            db_path: fixture.root.join("grimodex.db"),
            plan: Arc::clone(&plan),
        }));
    (fixture, plan)
}

/// (i-a) A held query released after the begin's audit commits (made by the
/// product's writer through the workspace's own connection, and by a second
/// connection) is prepared and answered without drift. The controls are
/// refused: a release before those commits (the mutation of the release point)
/// overlaps the registration, and a READY prepared before them is stale.
#[test]
fn i_a_a_query_released_after_the_begins_commits_is_valid_and_the_controls_are_refused() {
    // D = 10.84 ms is the inference between the two appends; the registration
    // window is wide enough to contain both appends in the controls.
    let inference = Duration::from_millis(11);
    let (fixture, plan) = drift_fixture(Duration::from_millis(150));
    let workspace = active_workspace_snapshot(&fixture.state.ws).expect("workspace");
    let authority: Arc<grimodex_db::WorkspaceAuthority> = Arc::clone(workspace.db());
    let product_writer: Arc<dyn SemanticAuditAppender> = authority;
    drop(workspace);
    let other_writer: Arc<dyn SemanticAuditAppender> = Arc::new(
        grimodex_db::Database::new(&fixture.root.join("grimodex.db")).expect("second connection"),
    );

    // The design: hold, the begin's commits, release, prepare, query.
    let ticket = pending(begin_deferred(&fixture, "entity"));
    let operation = commit_like_a_begin(Arc::clone(&product_writer), inference);
    commit_like_a_begin(Arc::clone(&other_writer), inference);
    assert_eq!(
        audit_event_types(&fixture, &operation),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded"
        ],
        "the stand-in commits what the product's begin commits, in its order"
    );
    ticket.release_after_own_commits();
    assert!(matches!(outcome(&ticket), GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Used);
    let diagnostics = fixture.diagnostics();
    assert_eq!(plan.refused.load(Ordering::SeqCst), 0);
    assert_eq!(plan.drifted.load(Ordering::SeqCst), 0);
    assert_eq!(diagnostics.prepare_failures, 0);
    assert_eq!(diagnostics.drift_at_query, 0);
    assert_eq!(diagnostics.stamp_stale, 0);
    assert_eq!(diagnostics.prepares_ready, 1);
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });

    // Control 1: released before the begin's commits (the release placed
    // before the audited embedding): the registration overlaps them.
    let early = pending(begin_deferred(&fixture, "entity"));
    early.release_after_own_commits();
    wait_until("the registration", || {
        plan.registering.load(Ordering::SeqCst)
    });
    commit_like_a_begin(Arc::clone(&product_writer), inference);
    assert_unavailable(outcome(&early), GraphUnavailable::RegistrationUnavailable);
    early.finish(GraphTicketUse::Unused);
    assert_eq!(plan.refused.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.diagnostics().prepare_failures, 1);
    wait_until("the end of the session", || {
        fixture.kind() == GraphSlotKind::Empty
    });

    // Control 2: a READY prepared before the begin's commits (D-final's
    // warming, as a held query never keeps one) is stale at its query.
    plan.registration_ms.store(0, Ordering::SeqCst);
    let warm_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // The failure above leaves a short backoff.
        match fixture.begin("entity") {
            GraphBegin::Unavailable(GraphUnavailable::Warming) => break,
            _ => {
                assert!(Instant::now() < warm_deadline, "no warming");
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    wait_until("READY", || fixture.kind() == GraphSlotKind::Ready);
    commit_like_a_begin(Arc::clone(&product_writer), inference);
    let late = pending(fixture.begin("entity"));
    assert_unavailable(outcome(&late), GraphUnavailable::Stale);
    late.finish(GraphTicketUse::Unused);
    let diagnostics = fixture.diagnostics();
    assert_eq!(diagnostics.stamp_stale + diagnostics.drift_at_query, 1);
}

// ---- (i-b) the same with the real worker binary (opt-in) ---------------------

/// (i-b) With the packaged worker and a real, sealed B: a held query released
/// after the begin's audit commits (the product's connection and a second one)
/// is READY and available with no prepare failure and no drift; the control,
/// a READY prepared before the same commits, is stale.
///
/// `cargo build --locked --release -p grimodex-db --bin nir1-c-query-worker`,
/// then `NIR1_C_QUERY_WORKER_BIN=<abs path> cargo test --manifest-path
/// electron/native/grimodex-node/Cargo.toml --lib
/// i_b_the_real_worker -- --ignored --nocapture --test-threads=1`.
#[test]
#[ignore = "opt-in: needs NIR1_C_QUERY_WORKER_BIN (the packaged worker binary)"]
fn i_b_the_real_worker_answers_a_query_released_after_the_begins_commits() {
    use crate::nir1_prepared_request::tests::{Fixture, PROJECT_ID, SCENE_ID};
    use grimodex_db::narrative_extraction::nir1_entity_relation_index::{
        prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx,
    };
    const ALICE: &str = "nir1-prepared-alice";
    let worker =
        std::env::var_os("NIR1_C_QUERY_WORKER_BIN").expect("NIR1_C_QUERY_WORKER_BIN is missing");
    let fixture = Fixture::new().expect("fixture");
    let state = Arc::clone(&fixture.state);
    // B, built and sealed as the foreground writer does (as DI-1a's reach test).
    {
        let workspace = active_workspace_snapshot(&state.ws).expect("workspace");
        let authority = workspace.db();
        let runtime = authority.nir_chronicle_index_runtime();
        let snapshot = authority
            .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT_ID))
            .expect("B snapshot");
        authority
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
                tx.commit()?;
                Ok(())
            })
            .expect("B publish");
    }
    let owner = &state.nir1_graph;
    owner
        .configure_worker_path(PathBuf::from(worker))
        .expect("worker path");
    owner.open_publication_for_test();
    let query = GraphQuery {
        project_id: PROJECT_ID.into(),
        query_scene_id: SCENE_ID.into(),
        seed_entity_id: ALICE.into(),
    };
    let workspace = active_workspace_snapshot(&state.ws).expect("workspace");
    let authority: Arc<grimodex_db::WorkspaceAuthority> = Arc::clone(workspace.db());
    let product_writer: Arc<dyn SemanticAuditAppender> = authority;
    drop(workspace);
    let other_writer: Arc<dyn SemanticAuditAppender> = Arc::new(
        grimodex_db::Database::new(&fixture.root.join("grimodex.db")).expect("second connection"),
    );
    let commit = |appender: &Arc<dyn SemanticAuditAppender>| {
        let operation_id = format!("cq-defer-{}", uuid::Uuid::new_v4());
        let context = SemanticAuditContext {
            project_id: Some(PROJECT_ID.into()),
            operation_id: operation_id.clone(),
            parent_execution_id: None,
            path_id: "semantic_search".into(),
            inference_kind: "embedding.query".into(),
            model: json!({
                "engine": "onnx-runtime",
                "tokenizerIdentity": TokenizerIdentity::from_bytes("tokenizer.json", b"cq-defer"),
            }),
            input: json!({"rawText": "the query"}),
            metadata: json!({"domain": "scene"}),
        };
        let mut session =
            SemanticAuditSession::start(Arc::clone(appender), context).expect("audit start");
        session
            .dispatch_and_run(
                || {
                    thread::sleep(Duration::from_millis(11));
                    Ok(vec![0.0_f32; 4])
                },
                |vector| embedding_output_payload(vector),
            )
            .expect("audit terminal");
    };

    let started = Instant::now();
    let ticket = match owner.begin_deferred(&state, query.clone()) {
        GraphBegin::Pending(ticket) => ticket,
        GraphBegin::Unavailable(reason) => panic!("not held: {}", reason.as_str()),
        GraphBegin::Cached(_) => panic!("not held: a cache hit"),
    };
    commit(&product_writer);
    commit(&other_writer);
    let released = started.elapsed();
    ticket.release_after_own_commits();
    let answer = ticket.wait_timeout(Duration::from_secs(20));
    let answered = started.elapsed();
    let diagnostics = owner.diagnostics();
    eprintln!(
        "CQ-DEFER real worker: released={released:?} answered={answered:?} diagnostics={diagnostics:?}"
    );
    match answer {
        Some(GraphTicketOutcome::Available(_)) => {}
        Some(GraphTicketOutcome::Unavailable(reason)) => {
            panic!("the released query was {}", reason.as_str())
        }
        None => panic!("the released query did not settle"),
    }
    ticket.finish(GraphTicketUse::Used);
    assert_eq!(diagnostics.prepare_failures, 0);
    assert_eq!(diagnostics.drift_at_query, 0);
    assert_eq!(diagnostics.stamp_stale, 0);
    assert_eq!(diagnostics.prepares_ready, 1);

    // Control: a READY prepared before the same commits is stale at its query.
    let deadline = Instant::now() + Duration::from_secs(20);
    while owner.slot_kind_for_test() != GraphSlotKind::Empty {
        assert!(Instant::now() < deadline, "the session did not end");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(matches!(
        owner.begin(&state, query.clone()),
        GraphBegin::Unavailable(GraphUnavailable::Warming)
    ));
    while owner.slot_kind_for_test() != GraphSlotKind::Ready {
        assert!(Instant::now() < deadline, "no READY for the control");
        thread::sleep(Duration::from_millis(5));
    }
    commit(&product_writer);
    commit(&other_writer);
    let control = match owner.begin(&state, query) {
        GraphBegin::Pending(ticket) => ticket,
        GraphBegin::Unavailable(reason) => panic!("control not served: {}", reason.as_str()),
        GraphBegin::Cached(_) => panic!("control: a cache hit"),
    };
    let control_answer = control.wait_timeout(Duration::from_secs(20));
    let after = owner.diagnostics();
    eprintln!("CQ-DEFER real worker control: {control_answer:?} diagnostics={after:?}");
    assert!(matches!(
        control_answer,
        Some(GraphTicketOutcome::Unavailable(GraphUnavailable::Stale))
    ));
    control.finish(GraphTicketUse::Unused);
    owner.close_for_shutdown();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !matches!(
        owner.slot_kind_for_test(),
        GraphSlotKind::Closed | GraphSlotKind::Empty | GraphSlotKind::Quarantined
    ) {
        assert!(Instant::now() < deadline, "the owner did not close");
        thread::sleep(Duration::from_millis(5));
    }
    let _ = std::fs::remove_dir_all(&fixture.root);
}
