//! CP-4 S1a tests. They run only with `--features nir1-graph-eval`. Every
//! workspace here is synthetic and made in the test code; no fixture of
//! `evals/` (and none of the frozen G-01..G-08 materials) is read.
use super::*;

use crate::nir1_graph_product::{
    GraphQuery, GraphTicket, GraphTicketOutcome, GraphWorker, GraphWorkerFactory, GraphWorkerStart,
};
use grimodex_db::narrative_extraction::nir1_graph::{
    c_query_worker::CQueryRetirement, worker_projection::Nir1GraphProjection, Nir1QualifiedGraph,
};
use grimodex_db::narrative_extraction::Nir1GraphRequest;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::time::Duration;

const PROJECT: &str = "eval-project";
const SCENE: &str = "eval-scene";

/// The registry and the record log are process-wide: one test at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    lock(&SERIAL)
}

fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

struct EchoFactory;

struct EchoWorker {
    /// Set: the query waits (at most 5 s) until the flag is cleared.
    hold: Option<Arc<AtomicBool>>,
}

impl GraphWorkerFactory for EchoFactory {
    fn create(&self, _start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        Box::new(EchoWorker { hold: None })
    }
}

/// A worker whose queries wait while `hold` is set.
struct HoldFactory(Arc<AtomicBool>);

impl GraphWorkerFactory for HoldFactory {
    fn create(&self, _start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        Box::new(EchoWorker {
            hold: Some(Arc::clone(&self.0)),
        })
    }
}

impl GraphWorker for EchoWorker {
    fn prepare(&mut self, _project_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn query(
        &mut self,
        request: &Nir1GraphRequest,
        _cancel: &AtomicBool,
    ) -> anyhow::Result<Nir1GraphProjection> {
        if let Some(hold) = &self.hold {
            let deadline = Instant::now() + Duration::from_secs(5);
            while hold.load(std::sync::atomic::Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        Ok(Nir1GraphProjection {
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
        })
    }

    fn quarantined(&self) -> bool {
        false
    }

    fn retire(self: Box<Self>) -> CQueryRetirement {
        CQueryRetirement::Retired
    }
}

/// A Ready, restricted workspace with an empty project (the shape of the
/// product owner's own tests).
struct OwnerFixture {
    state: Arc<AppState>,
    _root: PathBuf,
}

impl OwnerFixture {
    fn new(restricted: bool) -> Self {
        let root = std::env::temp_dir().join(format!("nir1-graph-eval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
        std::fs::write(
            root.join(".grimodex/workspace.json"),
            r#"{"id":"graph-eval-workspace"}"#,
        )
        .expect("workspace metadata");
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
        let backend =
            crate::Backend::new(root.join("app").to_string_lossy().into_owned(), None, None)
                .expect("Native backend");
        let state = Arc::clone(&backend.state);
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
        Self { state, _root: root }
    }

    fn begin(&self, seed: &str) -> GraphBegin {
        self.state.nir1_graph.begin(
            &self.state,
            GraphQuery {
                project_id: PROJECT.into(),
                query_scene_id: SCENE.into(),
                seed_entity_id: seed.into(),
            },
        )
    }

    /// CQ-DEFER：Related Scenes の入口（release まで保留される）。
    fn begin_deferred(&self, seed: &str) -> GraphBegin {
        self.state.nir1_graph.begin_deferred(
            &self.state,
            GraphQuery {
                project_id: PROJECT.into(),
                query_scene_id: SCENE.into(),
                seed_entity_id: seed.into(),
            },
        )
    }

    fn install_echo_worker(&self) {
        self.state
            .nir1_graph
            .install_worker_factory_for_test(Arc::new(EchoFactory));
    }

    fn begin_in(&self, project: &str, seed: &str) -> GraphBegin {
        self.state.nir1_graph.begin(
            &self.state,
            GraphQuery {
                project_id: project.into(),
                query_scene_id: SCENE.into(),
                seed_entity_id: seed.into(),
            },
        )
    }

    /// Warming, then READY, then a pending ticket.
    fn pending_after_warm(&self) -> GraphTicket {
        assert!(matches!(
            self.begin("entity"),
            GraphBegin::Unavailable(GraphUnavailable::Warming)
        ));
        wait_until("READY", || {
            self.state.nir1_graph.slot_kind_for_eval() == GraphSlotKind::Ready
        });
        match self.begin("entity") {
            GraphBegin::Pending(ticket) => ticket,
            GraphBegin::Cached(_) => panic!("expected a pending ticket, got a cache hit"),
            GraphBegin::Unavailable(reason) => panic!("expected pending, got {}", reason.as_str()),
        }
    }
}

impl Drop for OwnerFixture {
    fn drop(&mut self) {
        self.state.nir1_graph.close_for_shutdown();
    }
}

fn sample_records() -> Vec<Value> {
    samples_json()["records"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

// ---- P-7: the gate opens only for the registered owner ------------------------

#[test]
fn p7_the_gate_opens_only_for_the_owner_register_was_given() {
    let _serial = serial();
    let registered = OwnerFixture::new(true);
    let other = OwnerFixture::new(true);
    registered.install_echo_worker();
    other.install_echo_worker();
    // Before the registration the evaluation build is as closed as the product.
    assert!(!registered.state.nir1_graph.publication_is_open());
    assert!(matches!(
        registered.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
    record_registration(&registered.state, WorkerSetup::NotAttempted);
    assert!(registered.state.nir1_graph.publication_is_open());
    // Restricted and open: `gate_reason` has nothing to refuse, so the owner
    // admits the query (the first one warms the slot).
    let profile = registered.state.profile_egress.status();
    assert!(profile.restricted && profile.in_flight_stopped);
    let ticket = registered.pending_after_warm();
    ticket.finish(GraphTicketUse::Used);
    // Another AppState of the same process stays closed.
    assert!(!other.state.nir1_graph.publication_is_open());
    assert!(matches!(
        other.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
    let status = status_json();
    assert_eq!(status["registered"], true);
    assert_eq!(status["alive"], true);
    assert_eq!(status["owner"]["publicationOpen"], true);
    assert_eq!(status["worker"]["state"], "not-attempted");
}

#[test]
fn p7_an_unrestricted_profile_still_refuses_after_registration() {
    let _serial = serial();
    let fixture = OwnerFixture::new(false);
    fixture.install_echo_worker();
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::ProfileNotRestricted)
    ));
}

// ---- the begin records ----------------------------------------------------------

#[test]
fn begin_records_carry_the_slot_the_outcome_and_the_settlement() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    fixture.install_echo_worker();
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    clear_samples();
    let ticket = fixture.pending_after_warm();
    match ticket.wait_timeout(Duration::from_secs(2)) {
        Some(GraphTicketOutcome::Available(_)) => {}
        other => panic!("expected an available Graph, got {other:?}"),
    }
    ticket.finish(GraphTicketUse::Used);
    let records = sample_records();
    assert_eq!(records.len(), 2, "{records:?}");
    let warming = &records[0];
    assert_eq!(warming["startSlot"]["kind"], "empty");
    assert_eq!(warming["startSlot"]["readyFresh"], false);
    assert_eq!(warming["begin"], "unavailable");
    assert_eq!(warming["reason"], "warming");
    assert!(warming["ticket"].is_null());
    let pending = &records[1];
    assert_eq!(pending["startSlot"]["kind"], "ready");
    assert_eq!(pending["startSlot"]["readyFresh"], true, "the first READY is new");
    assert!(pending["startSlot"]["preparesReady"].as_u64() >= Some(1));
    assert!(pending["busyCause"].is_null());
    // The owner thread tried the second stamp between the hand-over and the
    // settlement, on the eval clock.
    let stamp = &pending["ticket"]["freshnessStamp"];
    let attempted = stamp["attemptedAtNs"].as_u64().expect("stamp attempt");
    let result = stamp["result"].as_str().expect("stamp result");
    assert!(
        ["fresh", "stale", "unavailable", "stamp0-missing"].contains(&result),
        "{stamp}"
    );
    assert_eq!(stamp["matched"].is_boolean(), ["fresh", "stale"].contains(&result));
    assert_eq!(pending["begin"], "pending");
    assert!(pending["reason"].is_null());
    assert_eq!(pending["ticket"]["settled"], true);
    assert_eq!(pending["ticket"]["outcome"], "available");
    assert_eq!(pending["ticket"]["disposition"], "used");
    let begun = pending["tBeginNs"].as_u64().expect("begin time");
    let returned = pending["tReturnedNs"].as_u64().expect("return time");
    let settled = pending["ticket"]["tSettledNs"]
        .as_u64()
        .expect("settle time");
    assert!(begun <= returned && returned <= settled + 1_000_000_000);
    assert!(begun <= attempted && attempted <= settled);
    assert!(records[0]["seq"].as_u64() < records[1]["seq"].as_u64());
    // Records carry no identifier of the query.
    let text = samples_json().to_string();
    for identifier in [PROJECT, SCENE, "entity"] {
        assert!(
            !text.contains(identifier),
            "{identifier} leaked into the record"
        );
    }
    assert_eq!(clear_samples(), 2);
    assert!(sample_records().is_empty());
}

#[test]
fn an_owner_that_was_not_registered_leaves_no_record() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    fixture.install_echo_worker();
    clear_samples();
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
    assert!(sample_records().is_empty());
}

#[test]
fn the_record_log_is_bounded_and_counts_what_it_dropped() {
    let _serial = serial();
    let fixture = OwnerFixture::new(false);
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    clear_samples();
    for _ in 0..SAMPLE_CAPACITY + 3 {
        let _ = fixture.begin("entity");
    }
    let samples = samples_json();
    assert_eq!(
        samples["records"].as_array().map(Vec::len),
        Some(SAMPLE_CAPACITY)
    );
    assert_eq!(samples["dropped"], 3);
    clear_samples();
}

// ---- the next-query cache -------------------------------------------------------

#[test]
fn clearing_the_next_query_cache_drops_a_late_result_before_the_next_sample() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    fixture.install_echo_worker();
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    let ticket = fixture.pending_after_warm();
    assert!(ticket.wait_timeout(Duration::from_secs(2)).is_some());
    // An unused Available result fills the single-entry cache.
    ticket.finish(GraphTicketUse::Unused);
    wait_until("late cache", || {
        fixture.state.nir1_graph.cache_occupied_for_eval()
    });
    assert!(fixture.state.nir1_graph.clear_next_query_cache_for_eval());
    assert!(!fixture.state.nir1_graph.cache_occupied_for_eval());
    assert!(!fixture.state.nir1_graph.clear_next_query_cache_for_eval());
    clear_samples();
    let next = fixture.begin("entity");
    assert!(
        !matches!(next, GraphBegin::Cached(_)),
        "the cache was emptied"
    );
    let records = sample_records();
    assert_eq!(records[0]["cacheOccupiedAtBegin"], false);
    if let GraphBegin::Pending(ticket) = next {
        ticket.finish(GraphTicketUse::Cancelled);
    }
}

// ---- the worker path --------------------------------------------------------------

#[test]
fn the_worker_is_the_fixed_name_next_to_the_loaded_library() {
    let _serial = serial();
    let directory =
        std::env::temp_dir().join(format!("nir1-graph-eval-worker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("directory");
    let library = directory.join("grimodex-node.node");
    let missing = OwnerFixture::new(true);
    match configure_worker(&missing.state, &library) {
        WorkerSetup::Refused { path, reason } => {
            assert_eq!(path, Some(directory.join(WORKER_FILE_NAME)));
            assert!(reason.contains("NIR1_GRAPH_WORKER_PATH"), "{reason}");
        }
        other => panic!("a missing worker must be refused, got {other:?}"),
    }
    assert!(!missing.state.nir1_graph.worker_configured_for_eval());
    // Another name next to the library is never taken.
    std::fs::write(directory.join("nir1-c-query-worker-other"), b"").expect("decoy");
    let decoy = OwnerFixture::new(true);
    assert!(matches!(
        configure_worker(&decoy.state, &library),
        WorkerSetup::Refused { .. }
    ));
    std::fs::write(directory.join(WORKER_FILE_NAME), b"").expect("worker file");
    let present = OwnerFixture::new(true);
    assert_eq!(
        configure_worker(&present.state, &library),
        WorkerSetup::Configured(directory.join(WORKER_FILE_NAME))
    );
    assert!(present.state.nir1_graph.worker_configured_for_eval());
    // The product factory keeps its single configuration.
    assert!(matches!(
        configure_worker(&present.state, &library),
        WorkerSetup::Refused { .. }
    ));
}

#[test]
fn the_mapping_of_an_address_names_its_file() {
    let maps = "\
55d0c0000000-55d0c0001000 r--p 00000000 08:02 131 /opt/eval/grimodex-node.node
55d0c0001000-55d0c0009000 r-xp 00001000 08:02 131 /opt/eval/grimodex-node.node
7f0000000000-7f0000001000 rw-p 00000000 00:00 0
7f0000002000-7f0000003000 r-xp 00000000 08:02 77                         /opt/old dir/lib.so (deleted)
7f0000004000-7f0000005000 r-xp 00000000 08:02 78                         /opt/with space/lib.so
";
    assert_eq!(
        mapping_path_for(maps, 0x55d0_c000_1234),
        Some(PathBuf::from("/opt/eval/grimodex-node.node"))
    );
    assert_eq!(mapping_path_for(maps, 0x7f00_0000_0800), None, "anonymous");
    assert_eq!(mapping_path_for(maps, 0x7f00_0000_2800), None, "deleted");
    assert_eq!(
        mapping_path_for(maps, 0x7f00_0000_4800),
        Some(PathBuf::from("/opt/with space/lib.so"))
    );
    assert_eq!(mapping_path_for(maps, 0x10), None, "unmapped");
}

#[cfg(target_os = "linux")]
#[test]
fn the_loaded_library_of_the_test_binary_is_the_test_executable() {
    let library = loaded_library_path().expect("mapped file");
    let executable = std::env::current_exe().expect("test executable");
    assert_eq!(
        library.canonicalize().expect("library"),
        executable.canonicalize().expect("executable")
    );
}

// ---- the A3 record ------------------------------------------------------------------

#[test]
fn the_a3_record_matches_the_product_qualification_without_the_database_mutex() {
    let _serial = serial();
    use crate::nir1_prepared_request::tests::{Fixture, PROJECT_ID, SCENE_ID};
    use grimodex_db::narrative_extraction::{
        evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosureRead,
    };
    use grimodex_db::state::active_workspace_snapshot;
    let fixture = Fixture::new().expect("prepared fixture");
    // The registered AppState has no workspace at all: a record that took a
    // lifecycle participant or the DB of the registered state could not run.
    let bare_root =
        std::env::temp_dir().join(format!("nir1-graph-eval-bare-{}", uuid::Uuid::new_v4()));
    let bare = crate::Backend::new(bare_root.to_string_lossy().into_owned(), None, None)
        .expect("bare backend");
    let bare_state = Arc::clone(&bare.state);
    record_registration(&bare_state, WorkerSetup::NotAttempted);
    let database = fixture.root.join("grimodex.db");
    let revision_ids = vec![fixture.revision_id.clone(), "missing-revision".to_owned()];
    // Hold the workspace's DB mutex on another thread for the whole record.
    let (held_tx, held_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = {
        let state = Arc::clone(&fixture.state);
        std::thread::spawn(move || {
            let workspace = active_workspace_snapshot(&state.ws).expect("workspace");
            workspace
                .db()
                .with_conn(|_conn| {
                    held_tx.send(()).expect("held");
                    let _ = release_rx.recv_timeout(Duration::from_secs(20));
                    Ok(())
                })
                .expect("hold the DB mutex");
        })
    };
    held_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the DB mutex is held");
    let (done_tx, done_rx) = mpsc::channel();
    {
        let database = database.clone();
        let revision_ids = revision_ids.clone();
        std::thread::spawn(move || {
            let _ = done_tx.send(read_a3_json(&database, PROJECT_ID, SCENE_ID, &revision_ids));
        });
    }
    let record = done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the record must not wait for the DB mutex")
        .expect("A3 record");
    release_tx.send(()).expect("release");
    holder.join().expect("holder");
    assert_eq!(record["connection"], "read-only-own");
    assert_eq!(record["readOnly"], true, "read back from the open connection");
    assert_eq!(record["queryOnly"], true);
    let revisions = record["revisions"].as_array().expect("revisions");
    assert_eq!(revisions.len(), 2);
    // The same verdict as the product's qualification on the workspace's own
    // connection.
    let workspace = active_workspace_snapshot(&fixture.state.ws).expect("workspace");
    let product = workspace
        .db()
        .db()
        .with_read_transaction(|conn| {
            evaluate_nir1_entity_relation_disclosure(
                conn,
                PROJECT_ID,
                &fixture.revision_id,
                SCENE_ID,
            )
        })
        .expect("product qualification");
    // The prepared fixture's approved Revision is eligible: the positive path.
    assert!(
        matches!(product, Nir1EntityRelationDisclosureRead::Eligible(_)),
        "the fixture's Revision must qualify"
    );
    assert_eq!(revisions[0]["a3"], "eligible");
    assert!(revisions[0]["reason"].is_null());
    assert_eq!(revisions[1]["a3"], "unavailable");
    let opened = record["tOpenStartedNs"].as_u64().expect("open");
    let snapshot = record["tSnapshotNs"].as_u64().expect("snapshot");
    let finished = record["tFinishedNs"].as_u64().expect("finished");
    assert!(opened <= snapshot && snapshot <= finished);
}

#[test]
fn the_a3_record_refuses_a_relative_or_foreign_database_path() {
    for path in ["grimodex.db", "/tmp/other.db"] {
        assert!(read_a3_json(Path::new(path), PROJECT, SCENE, &["r".to_owned()]).is_err());
    }
    assert!(read_a3_json(Path::new("/tmp/grimodex.db"), PROJECT, SCENE, &[]).is_err());
}

#[test]
fn the_free_functions_refuse_before_a_registration_and_never_panic() {
    let _serial = serial();
    // A registration of a dropped AppState is not alive.
    {
        let fixture = OwnerFixture::new(false);
        record_registration(&fixture.state, WorkerSetup::NotAttempted);
    }
    // The fixture's Backend and AppState are gone.
    let status = status_json();
    assert_eq!(status["registered"], true);
    assert_eq!(status["alive"], false);
    assert!(nir1_graph_eval_diagnostics().is_err());
    assert!(nir1_graph_eval_clear_next_query_cache().is_err());
    assert!(nir1_graph_eval_samples().is_ok());
    assert!(nir1_graph_eval_clock_ns()
        .expect("clock")
        .parse::<u64>()
        .is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_build_capabilities_report_the_evaluation_feature() {
    let root = std::env::temp_dir().join(format!("nir1-graph-eval-cap-{}", uuid::Uuid::new_v4()));
    let backend = crate::Backend::new(root.to_string_lossy().into_owned(), None, None)
        .expect("Native backend");
    let capabilities: Value = serde_json::from_str(
        &backend
            .get_native_build_capabilities()
            .await
            .expect("capabilities"),
    )
    .expect("json");
    assert_eq!(capabilities["nir1GraphEval"], true);
}

// ---- review follow-up: fail closed, busy causes, summaries -----------------------

#[test]
fn a_refused_worker_leaves_the_gate_closed() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    fixture.install_echo_worker();
    record_registration(
        &fixture.state,
        WorkerSetup::Refused {
            path: None,
            reason: "NIR1_GRAPH_WORKER_PATH".into(),
        },
    );
    assert!(!fixture.state.nir1_graph.publication_is_open());
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::NotActivated)
    ));
    let status = status_json();
    assert_eq!(status["gateOpened"], false);
    assert_eq!(status["worker"]["state"], "refused");
    assert_eq!(status["owner"]["publicationOpen"], false);
}

#[test]
fn busy_answers_name_their_cause() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    let hold = Arc::new(AtomicBool::new(true));
    fixture
        .state
        .nir1_graph
        .install_worker_factory_for_test(Arc::new(HoldFactory(Arc::clone(&hold))));
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    clear_samples();
    let ticket = fixture.pending_after_warm();
    // The slot is in use while the held query runs.
    assert!(matches!(
        fixture.begin("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    hold.store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(ticket.wait_timeout(Duration::from_secs(5)).is_some());
    ticket.finish(GraphTicketUse::Used);
    wait_until("READY again", || {
        fixture.state.nir1_graph.slot_kind_for_eval() == GraphSlotKind::Ready
    });
    // Another project's demand on a READY slot of this one.
    assert!(matches!(
        fixture.begin_in("eval-project-other", "entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    let records = sample_records();
    let causes: Vec<_> = records
        .iter()
        .filter(|record| record["reason"] == "busy")
        .map(|record| record["busyCause"].as_str().unwrap_or("").to_owned())
        .collect();
    assert_eq!(causes, vec!["in-use".to_owned(), "other-key".to_owned()], "{records:?}");
    let in_use = records
        .iter()
        .find(|record| record["busyCause"] == "in-use")
        .expect("in-use record");
    assert_eq!(in_use["startSlot"]["kind"], "in-use");
    assert_eq!(in_use["startSlot"]["readyFresh"], false);
    // A begin that is not busy carries no cause.
    assert!(records
        .iter()
        .filter(|record| record["reason"] != "busy")
        .all(|record| record["busyCause"].is_null()));
    clear_samples();
}

#[test]
fn a_settled_ticket_is_kept_as_its_summary() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    fixture.install_echo_worker();
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    clear_samples();
    let ticket = fixture.pending_after_warm();
    assert!(ticket.wait_timeout(Duration::from_secs(2)).is_some());
    let open = samples_json()["records"][1]["ticket"].clone();
    assert_eq!(open["disposition"], Value::Null, "not declared yet");
    ticket.finish(GraphTicketUse::Used);
    let first = samples_json()["records"][1]["ticket"].clone();
    let second = samples_json()["records"][1]["ticket"].clone();
    assert_eq!(first, second, "the summary shows what the waiter showed");
    assert_eq!(first["disposition"], "used");
    assert_eq!(first["outcome"], "available");
    assert_eq!(first["tSettledNs"], open["tSettledNs"]);
    assert_eq!(first["freshnessStamp"], open["freshnessStamp"]);
    clear_samples();
}

// ---- CQ-DEFER（D′）：保留の入口も `begin` と同じく記録される ----------------

#[test]
fn a_held_begin_is_recorded_and_its_release_is_counted() {
    let _serial = serial();
    let fixture = OwnerFixture::new(true);
    fixture.install_echo_worker();
    record_registration(&fixture.state, WorkerSetup::NotAttempted);
    clear_samples();
    let before = diagnostics_json(&fixture.state);
    let ticket = match fixture.begin_deferred("entity") {
        GraphBegin::Pending(ticket) => ticket,
        GraphBegin::Cached(_) => panic!("expected a held ticket, got a cache hit"),
        GraphBegin::Unavailable(reason) => panic!("expected pending, got {}", reason.as_str()),
    };
    // 保留中：release まで worker は無い。
    assert_eq!(diagnostics_json(&fixture.state)["slot"], "deferred");
    // 保留中の 2 件目の Related Scenes の begin は busy で、原因が記録される。
    assert!(matches!(
        fixture.begin_deferred("entity"),
        GraphBegin::Unavailable(GraphUnavailable::Busy)
    ));
    ticket.release_after_own_commits();
    match ticket.wait_timeout(Duration::from_secs(2)) {
        Some(GraphTicketOutcome::Available(_)) => {}
        other => panic!("expected an available Graph, got {other:?}"),
    }
    ticket.finish(GraphTicketUse::Used);
    // 保留つきの session は READY を残さない。
    wait_until("empty slot", || {
        fixture.state.nir1_graph.slot_kind_for_eval() == GraphSlotKind::Empty
    });
    let records = sample_records();
    assert_eq!(records.len(), 2, "{records:?}");
    assert_eq!(records[0]["startSlot"]["kind"], "empty");
    assert_eq!(records[0]["begin"], "pending");
    assert_eq!(records[0]["ticket"]["outcome"], "available");
    assert_eq!(records[0]["ticket"]["disposition"], "used");
    assert_eq!(records[1]["startSlot"]["kind"], "deferred");
    assert_eq!(records[1]["reason"], "busy");
    assert_eq!(records[1]["busyCause"], "deferred-held");
    let after = diagnostics_json(&fixture.state);
    let delta = |key: &str| after[key].as_u64().expect(key) - before[key].as_u64().expect(key);
    assert_eq!(delta("deferredReleased"), 1, "{after}");
    assert_eq!(delta("deferredExpired"), 0, "{after}");
    assert_eq!(delta("deferredDropped"), 0, "{after}");
    assert_eq!(delta("staleReadyRetired"), 0, "{after}");
    assert_eq!(delta("preparesReady"), 1, "{after}");
    assert_eq!(after["slot"], "empty");
    clear_samples();
}
