//! DI-1a S4 tests (K6/2 `nir1-final-request-packing-eval`, "D-final での Graph の
//! 到達" and the acceptance of DI-1a). Acceptance IDs refer to the DI-1a TASK.
//!
//! - A-7 / A-8: D-final's reach of the Graph in a **cold process**. The test
//!   binary starts itself again (`std::env::current_exe()`) with the name of a
//!   test and the role of the child in the environment; each child builds its
//!   own diagnostic workspace (a pinned Entity, a real B and an approved
//!   Revision, all made in the test code), leaves the product owner's slot
//!   Empty, commits the capture as its last write and hands it, at once, to
//!   D-final. The fake-worker lane runs in CI and checks the protocol and the
//!   position of the request; it is not the evidence of the reach. The
//!   real-worker lane is opt-in (`#[ignore]`) and records the reach.
//! - A-9: the requalification race (a change between the worker's answer and
//!   D-final's snapshot).
//! - A-11: the old cache of one process.
use super::*;

use crate::nir1_graph_product::{GraphBegin, GraphQuery, GraphTicketOutcome, GraphTicketUse};
use crate::nir1_local_attempt::tests::{inject, Change, Target};
use crate::nir1_prepared_request::tests::{
    create_approved_revision_over, graph_candidates_for, Fixture, GRAPH_GENERATION, PROJECT_ID,
    SESSION_ID,
};
use crate::nir1_prepared_request::{
    prepare_selected_local_chat_request_with_graph, prepare_selected_local_chat_request_with_hook,
    PrivateDTransportHandoff,
};
use grimodex_db::domain_writes::{
    apply_codex_rename, CodexRenameApplyPayload, CodexRenameUndoUpdate,
};
use grimodex_db::narrative_extraction::nir1_entity_relation_index::{
    prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx,
};
use grimodex_db::narrative_extraction::read_nir1_graph_seal;
use grimodex_db::state::active_workspace_snapshot;
use grimodex_db::Database;
use serde_json::{json, Value};
use std::io::Read as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CAROL: &str = "nir1-prepared-carol";
const CAROL_EDGE: &str = "nir1-prepared-edge-carol";
/// Text that only one Revision's groups carry (the Raw body names Bob).
const BOB_TEXT: &str = "Bob waits by the door.";
const CAROL_TEXT: &str = "Carol keeps the lantern.";

// ---------------------------------------------------------------------------
// The diagnostic workspace: made in the test code, no fixture of `evals/`.
// ---------------------------------------------------------------------------

fn pin_seed(state: &AppState, entry: &str) -> anyhow::Result<()> {
    let workspace = active_workspace_snapshot(&state.ws)?;
    workspace.db().with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO scene_codex_pins(scene_id,entry_id,created_at)
             VALUES (?1,?2,'2026-10-19T00:00:00Z')",
            (SCENE_ID, entry),
        )?;
        Ok(())
    })
}

/// B, built and sealed as the foreground writer does (the writer the gated
/// B-ROUTE route calls; the route itself is crate-private to the database
/// crate and closed until PUB-G).
fn publish_real_b(state: &AppState) -> anyhow::Result<()> {
    let workspace = active_workspace_snapshot(&state.ws)?;
    let authority = workspace.db();
    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = authority
        .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT_ID))?;
    authority.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
        tx.commit()?;
        Ok(())
    })
}

fn sealed_generation(state: &AppState) -> anyhow::Result<i64> {
    let workspace = active_workspace_snapshot(&state.ws)?;
    workspace
        .db()
        .with_read_transaction(|conn| {
            Ok(read_nir1_graph_seal(conn, PROJECT_ID)?.map(|seal| seal.generation))
        })?
        .ok_or_else(|| anyhow::anyhow!("B has no current seal"))
}

/// A second approved Revision over Alice and Carol (a Codex Entity that the
/// first Revision does not bind), made by the product's own writers.
fn add_second_revision(fixture: &Fixture) -> anyhow::Result<String> {
    let writer = Database::new(&fixture.root.join("grimodex.db"))?;
    writer.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries(id,project_id,type,name,summary,updated_at)
             VALUES (?1,?2,'character','Carol','Carol keeps the lantern.',
                     '2026-09-15T00:00:00.000Z')",
            (CAROL, PROJECT_ID),
        )?;
        conn.execute(
            "INSERT INTO codex_relations
                (id,project_id,from_codex_id,to_codex_id,relation_type,directionality,
                 version,updated_at)
             VALUES (?1,?2,'nir1-prepared-alice',?3,'trusts','directed',1,
                     '2026-09-15T00:00:00.000Z')",
            (CAROL_EDGE, PROJECT_ID, CAROL),
        )?;
        Ok(())
    })?;
    grimodex_db::narrative_extraction::run_incremental_freshness_cycle(&writer)?;
    create_approved_revision_over(
        &writer,
        "nir1:prepared:carol-accepted-ir",
        &[ALICE, CAROL],
        &[CAROL_EDGE],
    )
}

// ---------------------------------------------------------------------------
// The cold-process trial (a child) and its harness (the parent).
// ---------------------------------------------------------------------------

const ROLE_ENV: &str = "NIR1_DI1A_REACH_ROLE";
const CASE_ENV: &str = "NIR1_DI1A_REACH_CASE";
const WORKER_ENV: &str = "NIR1_C_QUERY_WORKER_BIN";
const RESULT_PREFIX: &str = "DI1A-REACH-RESULT ";
/// A child that has not answered by now is killed and counted as not run.
const CHILD_DEADLINE: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkerKind {
    Fake,
    Real,
}

impl WorkerKind {
    fn name(self) -> &'static str {
        match self {
            Self::Fake => "fake",
            Self::Real => "real",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "fake" => Some(Self::Fake),
            "real" => Some(Self::Real),
            _ => None,
        }
    }
}

/// The two diagnostic projects: one approved Revision with one relation, and
/// two approved Revisions (Alice with Bob, Alice with Carol).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Case {
    Small,
    Two,
    /// The small project, the slot warmed by an earlier consumer (Related
    /// Scenes) before the capture commit: D-final then meets a `stale` Graph.
    SmallWarm,
}

impl Case {
    fn name(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Two => "two-revisions",
            Self::SmallWarm => "small-warm",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "small" => Some(Self::Small),
            "two-revisions" => Some(Self::Two),
            "small-warm" => Some(Self::SmallWarm),
            _ => None,
        }
    }
}

/// A closed label for the kind of result (no identifier, no text).
fn outcome_label(outcome: DFinalGraphOutcome) -> String {
    match outcome {
        DFinalGraphOutcome::NotRequested => "not-requested".into(),
        DFinalGraphOutcome::Unavailable { reason, busy_cause } => match busy_cause {
            Some(GraphBusyCause::SlotInUse) => format!("{}:slot-in-use", reason.as_str()),
            Some(GraphBusyCause::StampUnreadable) => {
                format!("{}:stamp-unreadable", reason.as_str())
            }
            None => reason.as_str().to_owned(),
        },
        DFinalGraphOutcome::WaitExpired(GraphWaitKind::Warming) => "wait-expired:warming".into(),
        DFinalGraphOutcome::WaitExpired(GraphWaitKind::Stale) => "wait-expired:stale".into(),
        DFinalGraphOutcome::WaitExpired(GraphWaitKind::Query) => "wait-expired:query".into(),
        DFinalGraphOutcome::Invalidated(GraphInvalidation::Seed) => "invalidated:seed".into(),
        DFinalGraphOutcome::Invalidated(GraphInvalidation::Binding) => "invalidated:binding".into(),
        DFinalGraphOutcome::Invalidated(GraphInvalidation::Seal) => "invalidated:seal".into(),
        DFinalGraphOutcome::NotUsed(GraphNotUsed::Limit) => "not-used:limit".into(),
        DFinalGraphOutcome::NotUsed(GraphNotUsed::RequiredContext) => {
            "not-used:required-context".into()
        }
        DFinalGraphOutcome::Excluded { .. } => "excluded".into(),
        DFinalGraphOutcome::Empty => "empty".into(),
        DFinalGraphOutcome::Used { .. } => "used".into(),
    }
}

fn diagnostics_json(d: crate::nir1_graph_product::GraphOwnerDiagnostics) -> Value {
    let mut unavailable = serde_json::Map::new();
    for (index, reason) in GraphUnavailable::ALL.iter().enumerate() {
        if d.unavailable[index] > 0 {
            unavailable.insert(reason.as_str().to_owned(), json!(d.unavailable[index]));
        }
    }
    json!({
        "begins": d.begins,
        "pending": d.pending,
        "cacheHits": d.cache_hits,
        "unavailable": unavailable,
        "preparesStarted": d.prepares_started,
        "preparesReady": d.prepares_ready,
        "prepareFailures": d.prepare_failures,
        "stamp0Missing": d.stamp0_missing,
        "stampFresh": d.stamp_fresh,
        "stampStale": d.stamp_stale,
        "stampUnavailable": d.stamp_unavailable,
        "driftAtQuery": d.drift_at_query,
        "quarantines": d.quarantines,
        "lateCached": d.late_cached,
    })
}

/// The threads of this process by name and state, read from `/proc`: the
/// evidence a stamp miss is investigated with (who could hold the connection).
fn thread_listing() -> Vec<Value> {
    let mut threads = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc/self/task") {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = std::fs::read_to_string(path.join("comm"))
                .map(|name| name.trim().to_owned())
                .unwrap_or_default();
            let state = std::fs::read_to_string(path.join("stat"))
                .ok()
                .and_then(|stat| {
                    stat.rsplit_once(") ")
                        .and_then(|(_, rest)| rest.chars().next())
                })
                .map(String::from)
                .unwrap_or_default();
            threads.push(json!({"name": name, "state": state}));
        }
    }
    threads
}

fn close_and_remove(fixture: &Fixture) {
    fixture.state.nir1_graph.close_for_shutdown();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline
        && !matches!(
            fixture.state.nir1_graph.slot_kind_for_test(),
            GraphSlotKind::Closed | GraphSlotKind::Empty | GraphSlotKind::Quarantined
        )
    {
        thread::sleep(Duration::from_millis(5));
    }
}

/// Another consumer's earlier demand: the slot is asked, prepares and is READY
/// (no query yet). The capture commit that follows makes that READY stale.
fn warm_the_slot(fixture: &Fixture) -> anyhow::Result<()> {
    let state = &fixture.state;
    let signal = state.nir1_graph.ready_signal_generation();
    match state.nir1_graph.begin(
        state,
        GraphQuery {
            project_id: PROJECT_ID.into(),
            query_scene_id: SCENE_ID.into(),
            seed_entity_id: ALICE.into(),
        },
    ) {
        GraphBegin::Unavailable(GraphUnavailable::Warming) => {}
        _ => anyhow::bail!("a cold slot answers warming"),
    }
    anyhow::ensure!(
        state
            .nir1_graph
            .wait_ready_signal(signal, Duration::from_secs(20)),
        "the slot did not reach READY"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.nir1_graph.slot_kind_for_test() != GraphSlotKind::Ready {
        anyhow::ensure!(Instant::now() < deadline, "the slot is not READY");
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

/// One cold-process trial, in this process: a new workspace, an Empty slot,
/// the capture committed last, D-final at once.
fn run_trial(kind: WorkerKind, case: Case) -> anyhow::Result<Value> {
    let began = Instant::now();
    let fixture = Fixture::new()?;
    if case == Case::Two {
        add_second_revision(&fixture)?;
    }
    pin_seed(&fixture.state, ALICE)?;
    publish_real_b(&fixture.state)?;
    let generation = sealed_generation(&fixture.state)?;
    let owner = &fixture.state.nir1_graph;
    let mut plan = None;
    match kind {
        WorkerKind::Fake => {
            // The control request (the product is still closed) names the
            // Revisions a worker would answer.
            let control = prepare_selected_local_chat_request(
                Arc::clone(&fixture.state),
                fixture.caller.clone(),
                SCENE_ID,
                &fixture.message_version_id,
                NO_UNSUPPORTED_INPUTS,
                LocalGenerationIntent::writing_for_test(),
            )?
            .into_parts()
            .0
            .into_d_transport_handoff();
            let candidates = graph_candidates_for(control.authority_bindings(), generation)?;
            let fake = Arc::new(Plan::default());
            *lock(&fake.candidates) = Some(candidates);
            owner.install_worker_factory_for_test(Arc::new(FakeFactory(Arc::clone(&fake))));
            plan = Some(fake);
        }
        WorkerKind::Real => {
            let worker = std::env::var_os(WORKER_ENV)
                .ok_or_else(|| anyhow::anyhow!("{WORKER_ENV} is missing"))?;
            owner.configure_worker_path(PathBuf::from(worker))?;
        }
    }
    owner.open_publication_for_test();
    if case == Case::SmallWarm {
        warm_the_slot(&fixture)?;
    }
    let prepared_ms = began.elapsed().as_millis();

    // The capture is the last write; D-final follows at once (interval 0).
    let submission = fixture.add_human_message("reach", "Continue after the rain.")?;
    let started = Instant::now();
    let selected = prepare_selected_local_chat_request(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        &submission,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
    )?;
    let dfinal_ms = started.elapsed().as_millis();
    let outcome = selected.graph_outcome();
    let diagnostics = owner.diagnostics();
    let handoff = selected.into_parts().0.into_d_transport_handoff();
    let graph_inputs = handoff
        .graph_binding()
        .map_or(0, |binding| binding.inputs().len());
    let missed_stamp = diagnostics.stamp0_missing > 0 || diagnostics.stamp_unavailable > 0;
    let mut record = json!({
        "worker": kind.name(),
        "case": case.name(),
        "generation": generation,
        "reached": graph_inputs > 0,
        "graphInputs": graph_inputs,
        "outcome": outcome_label(outcome),
        "dfinalMs": dfinal_ms,
        "preparedMs": prepared_ms,
        "diagnostics": diagnostics_json(diagnostics),
        "stampMiss": missed_stamp,
    });
    if missed_stamp {
        record["threads"] = json!(thread_listing());
    }
    if let Some(plan) = plan {
        record["fakeQueries"] = json!(plan.queries.load(Ordering::SeqCst));
    }
    close_and_remove(&fixture);
    let _ = std::fs::remove_dir_all(&fixture.root);
    Ok(record)
}

/// The child entry: a no-op unless the parent set the role. Ignored so that an
/// ordinary run never starts it; the parent passes `--ignored`.
#[test]
#[ignore = "the child of a cold-process trial; started by the parent tests"]
fn cold_process_child() {
    let (Some(role), Some(case)) = (
        std::env::var(ROLE_ENV)
            .ok()
            .and_then(|v| WorkerKind::parse(&v)),
        std::env::var(CASE_ENV).ok().and_then(|v| Case::parse(&v)),
    ) else {
        return;
    };
    match run_trial(role, case) {
        Ok(record) => println!("{RESULT_PREFIX}{record}"),
        Err(error) => println!("{RESULT_PREFIX}{}", json!({"error": format!("{error:#}")})),
    }
}

/// Start the test binary again for one trial and return its record.
fn run_child(kind: WorkerKind, case: Case) -> Value {
    let path = module_path!();
    let name = path.split_once("::").map_or(path, |(_, rest)| rest);
    let mut child = match Command::new(std::env::current_exe().expect("current_exe"))
        .args([
            "--exact",
            &format!("{name}::cold_process_child"),
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, kind.name())
        .env(CASE_ENV, case.name())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return json!({"error": format!("spawn: {error}")}),
    };
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let out = thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err = thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + CHILD_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    let Some(status) = status else {
        return json!({"error": "child deadline"});
    };
    match stdout
        .lines()
        .find_map(|line| line.split_once(RESULT_PREFIX).map(|(_, record)| record))
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
    {
        Some(record) => record,
        None => json!({
            "error": format!("no result (exit {status})"),
            "stderrTail": stderr.lines().rev().take(8).collect::<Vec<_>>(),
        }),
    }
}

/// The record of a series of trials: how many reached, and why the others did
/// not, with the stamp and S0 misses counted apart.
fn summarize(records: &[Value]) -> Value {
    let mut reasons = std::collections::BTreeMap::<String, usize>::new();
    let mut reached = 0usize;
    let mut errors = 0usize;
    let mut stamp_misses = 0usize;
    let mut s0_misses = 0u64;
    let mut stamp_failures = 0u64;
    let mut waits = Vec::new();
    for record in records {
        if record.get("error").is_some() {
            errors += 1;
            continue;
        }
        if record["reached"] == json!(true) {
            reached += 1;
        } else {
            let label = record["outcome"].as_str().unwrap_or("unknown").to_owned();
            *reasons.entry(label).or_default() += 1;
        }
        if record["stampMiss"] == json!(true) {
            stamp_misses += 1;
        }
        s0_misses += record["diagnostics"]["stamp0Missing"].as_u64().unwrap_or(0);
        stamp_failures += record["diagnostics"]["stampUnavailable"]
            .as_u64()
            .unwrap_or(0);
        if let Some(ms) = record["dfinalMs"].as_u64() {
            waits.push(ms);
        }
    }
    waits.sort_unstable();
    let pick = |fraction: usize| waits.get(waits.len().saturating_sub(1) * fraction / 100);
    json!({
        "trials": records.len(),
        "reached": reached,
        "notReached": records.len() - reached - errors,
        "errors": errors,
        "reasons": reasons,
        "trialsWithAStampMiss": stamp_misses,
        "s0Misses": s0_misses,
        "stampReadFailures": stamp_failures,
        "dfinalMs": {
            "min": waits.first(),
            "median": pick(50),
            "p90": pick(90),
            "max": waits.last(),
        },
    })
}

fn run_series(kind: WorkerKind, case: Case, count: usize) -> (Vec<Value>, Value) {
    let records: Vec<Value> = (0..count).map(|_| run_child(kind, case)).collect();
    let summary = summarize(&records);
    eprintln!(
        "DI-1a reach [{} / {} / N={count}]: {}",
        kind.name(),
        case.name(),
        summary
    );
    for record in &records {
        if record.get("error").is_some() || record["stampMiss"] == json!(true) {
            eprintln!("DI-1a reach investigate: {record}");
        }
    }
    if let Some(out) = std::env::var_os("NIR1_DI1A_REACH_OUT") {
        let body = json!({"summary": summary, "records": records});
        let _ = std::fs::write(out, serde_json::to_string_pretty(&body).unwrap_or_default());
    }
    (records, summary)
}

/// A-7 (CI lane, a fake worker): the protocol of the cold-process trial and the
/// position of the request. Each trial is a new process whose slot starts
/// Empty; D-final waits outside every database lock, the owner is asked once
/// and the Graph reaches the request, with no stamp or S0 miss. This checks the
/// harness and the position; it is not the evidence of the reach (the real
/// worker's lane below is).
#[test]
fn a7_a_cold_process_with_a_fake_worker_reaches_the_graph_without_a_stamp_miss() {
    let (records, summary) = run_series(WorkerKind::Fake, Case::Small, 2);
    assert_eq!(summary["errors"], json!(0), "{summary}");
    for record in &records {
        assert_eq!(record["reached"], json!(true), "{record}");
        assert_eq!(record["outcome"], json!("used"), "{record}");
        assert_eq!(record["stampMiss"], json!(false), "{record}");
        // The slot started Empty: the first answer was `warming`, and the
        // wait for READY (not a retry loop) brought the Graph.
        assert_eq!(record["diagnostics"]["unavailable"]["warming"], json!(1));
        assert_eq!(record["fakeQueries"], json!(1), "{record}");
    }
}

/// A-7 (opt-in lane, the real worker): in a new process, with the packaged
/// worker binary, D-final reaches the Graph. "At least one of the cases":
/// the small project and the two-Revision project each run once.
///
/// `cargo build --locked --release -p grimodex-db --bin nir1-c-query-worker`,
/// then `NIR1_C_QUERY_WORKER_BIN=<abs path of the binary> cargo test
/// --manifest-path electron/native/grimodex-node/Cargo.toml --lib
/// a7_a_cold_process_with_the_real_worker -- --ignored --nocapture
/// --test-threads=1`.
#[test]
#[ignore = "opt-in: needs NIR1_C_QUERY_WORKER_BIN (the packaged worker binary)"]
fn a7_a_cold_process_with_the_real_worker_reaches_the_graph() {
    let mut reached = 0usize;
    for case in [Case::Small, Case::Two] {
        let (_, summary) = run_series(WorkerKind::Real, case, 1);
        assert_eq!(summary["errors"], json!(0), "{summary}");
        reached += summary["reached"].as_u64().unwrap_or(0) as usize;
    }
    assert!(
        reached >= 1,
        "[precheck] D-final reached the Graph in none of the cold-process cases"
    );
}

/// A supplementary record (not N_R): the slot warmed by an earlier consumer,
/// then the capture commit, then D-final: the `stale` path with the real
/// worker. Ten trials, each in a new process; nothing is asserted but the
/// stop condition (no trial reached).
#[test]
#[ignore = "opt-in: needs NIR1_C_QUERY_WORKER_BIN (the packaged worker binary)"]
fn a8_supplement_the_stale_path_of_the_real_worker_is_recorded() {
    let (_, summary) = run_series(WorkerKind::Real, Case::SmallWarm, 10);
    assert_eq!(summary["errors"], json!(0), "{summary}");
    assert!(
        summary["reached"].as_u64().unwrap_or(0) > 0,
        "[precheck] the stale path reached the Graph in none of 10 trials: {summary}"
    );
}

/// The N_R of the reach record (A-8), fixed before the first measurement
/// (DR-DI1A-26) and not changed after seeing a result.
const REACH_TRIALS: usize = 30;

/// A-8 (opt-in lane, the real worker): N_R cold-process trials, each in a new
/// process. The record is the count of reached trials over N_R and the count
/// of the others by reason; there is no lower bound. A stamp or S0 miss in any
/// trial is printed with the thread listing for the investigation. Only the
/// stop condition fails the test: no trial of N_R reached the Graph.
///
/// Run as A-7's, with `a8_the_reach_of_the_real_worker_is_recorded`;
/// `NIR1_DI1A_REACH_OUT=<file>` also writes the records as JSON.
#[test]
#[ignore = "opt-in: needs NIR1_C_QUERY_WORKER_BIN (the packaged worker binary)"]
fn a8_the_reach_of_the_real_worker_is_recorded() {
    let (_, summary) = run_series(WorkerKind::Real, Case::Small, REACH_TRIALS);
    assert_eq!(summary["errors"], json!(0), "{summary}");
    assert!(
        summary["reached"].as_u64().unwrap_or(0) > 0,
        "[precheck] the Graph reached D-final in none of {REACH_TRIALS} trials: {summary}"
    );
}

// ---------------------------------------------------------------------------
// A-9: the requalification race. The worker's answer is in hand (the Graph
// step is over); a change lands before D-final opens its participant read.
// ---------------------------------------------------------------------------

fn two_revision_rig() -> (Rig, String) {
    let fixture = Fixture::new().expect("fixture");
    let second = add_second_revision(&fixture).expect("second revision");
    (Rig::over(fixture), second)
}

impl Rig {
    fn request_without_graph(&self) -> anyhow::Result<PrivateDTransportHandoff> {
        Ok(prepare_selected_local_chat_request_with_graph(
            Arc::clone(&self.fixture.state),
            self.fixture.caller.clone(),
            SCENE_ID,
            &self.fixture.message_version_id,
            NO_UNSUPPORTED_INPUTS,
            LocalGenerationIntent::writing_for_test(),
            None,
        )?
        .into_parts()
        .0
        .into_d_transport_handoff())
    }
}

fn selection_without_graph(rig: &Rig) -> PrivateDTransportHandoff {
    prepare_selected_local_chat_request_with_graph(
        Arc::clone(&rig.fixture.state),
        rig.fixture.caller.clone(),
        SCENE_ID,
        &rig.fixture.message_version_id,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
        None,
    )
    .expect("selection without a Graph")
    .into_parts()
    .0
    .into_d_transport_handoff()
}

fn accepted_revisions(handoff: &PrivateDTransportHandoff) -> std::collections::BTreeSet<String> {
    handoff
        .input_references()
        .iter()
        .filter_map(|input| match &input.target {
            InputTarget::AcceptedRevision { revision_id, .. } => Some(revision_id.clone()),
            _ => None,
        })
        .collect()
}

fn graph_revisions(handoff: &PrivateDTransportHandoff) -> std::collections::BTreeSet<String> {
    handoff
        .graph_binding()
        .map_or_else(Default::default, |binding| {
            binding
                .inputs()
                .iter()
                .map(|input| input.revision_id().to_owned())
                .collect()
        })
}

fn set_of(ids: &[&str]) -> std::collections::BTreeSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

fn request_with_hook(
    rig: &Rig,
    hook: impl FnOnce() -> anyhow::Result<()>,
) -> NativeSelectedPreparedRequest {
    prepare_selected_local_chat_request_with_hook(
        Arc::clone(&rig.fixture.state),
        rig.fixture.caller.clone(),
        SCENE_ID,
        &rig.fixture.message_version_id,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
        hook,
    )
    .expect("request with a change between the Graph step and the read")
}

fn current_seal_generation(rig: &Rig) -> Option<i64> {
    let workspace = active_workspace_snapshot(&rig.fixture.state.ws).expect("workspace");
    workspace
        .db()
        .with_read_transaction(|conn| {
            Ok(read_nir1_graph_seal(conn, PROJECT_ID)?.map(|seal| seal.generation))
        })
        .expect("seal read")
}

/// A-9 (a change that does not dirty B): Carol's live Source token changes
/// (her row's `updated_at`), which only the Revision that binds her depends
/// on. B's seal stays current. The group of that Revision is in neither the
/// request's Graph inputs nor its payload; the other Revision's Graph group
/// and the accepted IR stay.
#[test]
fn a9_a_change_that_leaves_b_clean_drops_only_that_revisions_group() {
    let (rig, second) = two_revision_rig();
    let first = rig.fixture.revision_id.clone();
    rig.open();
    let before = selection_without_graph(&rig);
    assert_eq!(accepted_revisions(&before), set_of(&[&first, &second]));
    assert!(before.canonical_payload().contains(CAROL_TEXT));
    assert!(before.canonical_payload().contains(BOB_TEXT));
    assert!(
        rig.candidates
            .edges()
            .iter()
            .any(|edge| edge.revision_id() == second),
        "the worker's answer names the Revision that is about to be changed"
    );

    // Without the change, the Graph carries both Revisions' groups.
    let baseline = rig.request().expect("baseline request");
    assert!(matches!(
        baseline.graph_outcome(),
        DFinalGraphOutcome::Used { .. }
    ));
    let baseline = baseline.into_parts().0.into_d_transport_handoff();
    assert_eq!(graph_revisions(&baseline), set_of(&[&first, &second]));

    let selected = request_with_hook(&rig, || {
        // The injection: not a writer of B.
        let workspace = active_workspace_snapshot(&rig.fixture.state.ws)?;
        let changed = workspace.db().with_conn(|conn| {
            Ok(conn.execute(
                "UPDATE codex_entries SET updated_at='2026-10-19T09:00:00.000Z' WHERE id=?1",
                [CAROL],
            )?)
        })?;
        assert_eq!(changed, 1, "the injection must change exactly one row");
        // The premises, checked at once: B's seal is the one the worker
        // answered under, the changed Revision is unavailable, the other one
        // is eligible.
        assert_eq!(current_seal_generation(&rig), Some(GRAPH_GENERATION));
        let control = selection_without_graph(&rig);
        assert_eq!(accepted_revisions(&control), set_of(&[&first]));
        assert!(
            control
                .excluded_revisions()
                .iter()
                .any(|excluded| excluded.revision_id() == second),
            "the changed Revision is unavailable to A2 or A3"
        );
        Ok(())
    });

    let outcome = selected.graph_outcome();
    assert!(
        matches!(
            outcome,
            DFinalGraphOutcome::Used { groups, .. } if groups >= 1
        ),
        "{outcome:?}"
    );
    let handoff = selected.into_parts().0.into_d_transport_handoff();
    assert_eq!(graph_revisions(&handoff), set_of(&[&first]));
    assert_eq!(accepted_revisions(&handoff), set_of(&[&first]));
    let payload = handoff.canonical_payload();
    assert!(payload.contains(BOB_TEXT), "the other Revision stays");
    assert!(
        !payload.contains(CAROL_TEXT),
        "the changed Revision is gone"
    );
    assert!(!payload.contains("Carol"), "the changed Revision is gone");
    assert!(handoff
        .excluded_revisions()
        .iter()
        .any(|excluded| excluded.revision_id() == second));
    // One query for the baseline and one for the raced request: the race did
    // not repeat the Graph step.
    assert_eq!(rig.plan.queries.load(Ordering::SeqCst), 2);
}

/// A-9 (a product writer that dirties B): a Codex summary is saved by the
/// product's writer and the incremental freshness cycle processes the change,
/// so the Revision that depends on Bob is stale and B is dirty. B's seal is
/// gone in D-final's snapshot: every Graph group is dropped. The accepted IR
/// of the Revision that does not depend on Bob stays.
#[test]
fn a9_a_product_writer_that_dirties_b_drops_every_graph_group_and_keeps_the_ir() {
    let (rig, second) = two_revision_rig();
    let first = rig.fixture.revision_id.clone();
    rig.open();
    assert_eq!(current_seal_generation(&rig), Some(GRAPH_GENERATION));

    let selected = request_with_hook(&rig, || {
        let workspace = active_workspace_snapshot(&rig.fixture.state.ws)?;
        let db = workspace.db();
        let version: i64 = db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT version FROM codex_entries WHERE id='nir1-prepared-bob'",
                [],
                |row| row.get(0),
            )?)
        })?;
        apply_codex_rename(
            db,
            CodexRenameApplyPayload {
                request_id: "di1a-a9-dirty-b".into(),
                project_id: PROJECT_ID.into(),
                session_id: SESSION_ID.into(),
                surface: None,
                entry_id: BOB.into(),
                updated_at: "2026-10-19T09:30:00.000Z".into(),
                updates: vec![CodexRenameUndoUpdate {
                    kind: "codex-summary".into(),
                    ref_id: BOB.into(),
                    detail_definition_id: None,
                    base_version: version,
                    value: "Bob left by the other door.".into(),
                    char_count: None,
                    placed_beat_preview: None,
                }],
                event_summary: json!({
                    "entryId": BOB, "oldName": "Bob", "newName": "Bob", "applied": true
                })
                .to_string(),
                event_uid: "di1a-a9-dirty-b-event".into(),
                timestamp: 1_760_866_200_000,
                redo: false,
                original_transaction_id: None,
                undo_journal_id: None,
            },
        )?;
        grimodex_db::narrative_extraction::run_incremental_freshness_cycle(db)?;
        // The premises: B is dirty (no current seal), the Revision that
        // depends on Bob is unavailable and the other one is eligible.
        assert_eq!(current_seal_generation(&rig), None, "B must be dirty");
        let control = selection_without_graph(&rig);
        assert_eq!(accepted_revisions(&control), set_of(&[&second]));
        assert!(control
            .excluded_revisions()
            .iter()
            .any(|excluded| excluded.revision_id() == first));
        Ok(())
    });

    assert_eq!(
        selected.graph_outcome(),
        DFinalGraphOutcome::Invalidated(GraphInvalidation::Seal)
    );
    let handoff = selected.into_parts().0.into_d_transport_handoff();
    assert!(handoff.graph_binding().is_none(), "no Graph group at all");
    assert_eq!(accepted_revisions(&handoff), set_of(&[&second]));
    assert!(handoff.canonical_payload().contains(CAROL_TEXT));
    assert!(!handoff.canonical_payload().contains(BOB_TEXT));
}

// ---------------------------------------------------------------------------
// A-11: the old cache of one process. Request 1, a change by a product writer,
// request 2 (the single-entry cache still holds the Graph of before the
// change), B built and sealed again, request 3.
// ---------------------------------------------------------------------------

/// A rig over a real B (built and sealed by the foreground writer), so that B
/// can be rebuilt the way the product does.
fn rig_over_real_b(two_revisions: bool) -> (Rig, Option<String>) {
    let fixture = Fixture::new().expect("fixture");
    let second = two_revisions.then(|| add_second_revision(&fixture).expect("second revision"));
    pin_seed(&fixture.state, ALICE).expect("pin");
    publish_real_b(&fixture.state).expect("B");
    let generation = sealed_generation(&fixture.state).expect("generation");
    let control = prepare_selected_local_chat_request_with_graph(
        Arc::clone(&fixture.state),
        fixture.caller.clone(),
        SCENE_ID,
        &fixture.message_version_id,
        NO_UNSUPPORTED_INPUTS,
        LocalGenerationIntent::writing_for_test(),
        None,
    )
    .expect("control request")
    .into_parts()
    .0
    .into_d_transport_handoff();
    let candidates =
        graph_candidates_for(control.authority_bindings(), generation).expect("candidates");
    let plan = Arc::new(Plan::default());
    *lock(&plan.candidates) = Some(candidates.clone());
    (
        Rig {
            fixture,
            plan,
            candidates,
        },
        second,
    )
}

/// What Related Scenes does with a result it does not use: the finished,
/// unused ticket of an available Graph fills the single-entry cache.
fn fill_the_cache_like_related_scenes(rig: &Rig) {
    let state = &rig.fixture.state;
    let GraphBegin::Pending(ticket) = state.nir1_graph.begin(
        state,
        GraphQuery {
            project_id: PROJECT_ID.into(),
            query_scene_id: SCENE_ID.into(),
            seed_entity_id: ALICE.into(),
        },
    ) else {
        panic!("a ready slot with a fresh stamp takes the query");
    };
    let outcome = ticket
        .wait_timeout(Duration::from_secs(10))
        .expect("the query settles");
    assert!(matches!(outcome, GraphTicketOutcome::Available(_)));
    ticket.finish(GraphTicketUse::Unused);
}

/// The inject of DI-1c's table, except the index generation, which here is a
/// real rebuild of B (the writer the B-ROUTE route calls) at the next generation.
fn inject_change(rig: &Rig, change: Change) {
    match change {
        Change::IndexGeneration => publish_real_b(&rig.fixture.state).expect("B again"),
        other => inject(&Target::of(&rig.fixture), other),
    }
}

/// The Graph of a request: where it came from (the worker's query count and
/// the cache's hits since `before`) and what it carries.
struct GraphSource {
    queries: usize,
    cache_hits: u64,
}

fn graph_source_since(rig: &Rig, queries: usize, hits: u64) -> GraphSource {
    GraphSource {
        queries: rig.plan.queries.load(Ordering::SeqCst) - queries,
        cache_hits: rig.owner().diagnostics().cache_hits - hits,
    }
}

/// D-final's rule that a request keeps a Raw and an accepted IR: a change that
/// leaves no eligible Revision refuses the whole request, so nothing is sent.
const REQUIRED_CONTEXT_MISSING: &str = "NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING";

enum Prepared {
    Request(Box<PrivateDTransportHandoff>, DFinalGraphOutcome),
    /// No request at all (the only refusal this case may end in).
    Refused,
}

fn prepare(rig: &Rig, label: &str) -> Prepared {
    match rig.request() {
        Ok(selected) => {
            let outcome = selected.graph_outcome();
            Prepared::Request(
                Box::new(selected.into_parts().0.into_d_transport_handoff()),
                outcome,
            )
        }
        Err(error) => {
            assert!(
                format!("{error:#}").contains(REQUIRED_CONTEXT_MISSING),
                "{label}: {error:#}"
            );
            Prepared::Refused
        }
    }
}

#[test]
fn a11_the_single_entry_cache_does_not_carry_an_old_graph_into_a_later_request() {
    for change in [
        Change::Scope,
        Change::Source,
        Change::Revision,
        Change::Decision,
        Change::Freshness,
        Change::IndexGeneration,
    ] {
        let (rig, _) = rig_over_real_b(false);
        let first = rig.fixture.revision_id.clone();
        rig.open();
        // A cache that holds for the whole case (the fast test config's 200 ms
        // would let it lapse between two requests).
        rig.owner()
            .set_config_for_test(crate::nir1_graph_product::GraphOwnerConfig {
                cache_ttl: Duration::from_secs(30),
                ..fast_config()
            });
        let old_generation = sealed_generation(&rig.fixture.state).expect("generation");
        let label = format!("{change:?}");

        // Request 1: the worker answers; D-final's ticket is Used, which does
        // not fill the cache.
        let queries = rig.plan.queries.load(Ordering::SeqCst);
        let hits = rig.owner().diagnostics().cache_hits;
        let Prepared::Request(one, outcome) = prepare(&rig, &label) else {
            panic!("{label}: request 1 is refused");
        };
        assert!(used(outcome), "{label}: {outcome:?}");
        assert_eq!(graph_revisions(&one), set_of(&[&first]), "{label}");
        let source = graph_source_since(&rig, queries, hits);
        assert_eq!(
            (source.queries, source.cache_hits),
            (1, 0),
            "{label}: worker"
        );
        assert_eq!(rig.owner().cache_len_for_test(), 0, "{label}: not cached");

        // The Graph of before the change reaches the cache (an unused ticket).
        fill_the_cache_like_related_scenes(&rig);
        assert_eq!(rig.owner().cache_len_for_test(), 1, "{label}: cached");

        // The change, by the product's writer.
        inject_change(&rig, change);

        // Request 2: the cache returns the old Graph; D-final requalifies it
        // in its own snapshot and the old material does not reach the request.
        let queries = rig.plan.queries.load(Ordering::SeqCst);
        let hits = rig.owner().diagnostics().cache_hits;
        let two = prepare(&rig, &label);
        let source = graph_source_since(&rig, queries, hits);
        assert_eq!(
            (source.queries, source.cache_hits),
            (0, 1),
            "{label}: request 2 got its Graph from the cache"
        );
        let two_note = match &two {
            Prepared::Request(handoff, outcome) => {
                assert!(
                    !used(*outcome),
                    "{label}: the old Graph was used: {outcome:?}"
                );
                assert!(handoff.graph_binding().is_none(), "{label}: a Graph input");
                outcome_label(*outcome)
            }
            Prepared::Refused => "the whole request refused (no eligible Revision)".into(),
        };

        // B is built and sealed again; the worker answers from the new world.
        publish_real_b(&rig.fixture.state).expect("B rebuilt");
        let new_generation = sealed_generation(&rig.fixture.state).expect("generation");
        assert!(new_generation > old_generation, "{label}");
        let fresh_revisions = match rig.request_without_graph() {
            Ok(fresh) => {
                *lock(&rig.plan.candidates) = Some(
                    graph_candidates_for(fresh.authority_bindings(), new_generation)
                        .expect("candidates of the new world"),
                );
                accepted_revisions(&fresh)
            }
            Err(error) => {
                assert!(
                    format!("{error:#}").contains(REQUIRED_CONTEXT_MISSING),
                    "{label}"
                );
                *lock(&rig.plan.candidates) =
                    Some(graph_candidates_for(&[], new_generation).expect("no candidates"));
                set_of(&[])
            }
        };

        // Request 3: from the worker, under the new generation; nothing of the
        // old Revision or the old generation.
        let queries = rig.plan.queries.load(Ordering::SeqCst);
        let hits = rig.owner().diagnostics().cache_hits;
        let three = prepare(&rig, &label);
        let source = graph_source_since(&rig, queries, hits);
        assert_eq!(
            (source.queries, source.cache_hits),
            (1, 0),
            "{label}: request 3 got its Graph from the worker"
        );
        let three_note = match &three {
            Prepared::Request(handoff, outcome) => {
                if let Some(binding) = handoff.graph_binding() {
                    assert_eq!(binding.seal().generation, new_generation, "{label}");
                    assert_ne!(binding.seal().generation, old_generation, "{label}");
                }
                assert!(
                    graph_revisions(handoff).is_subset(&fresh_revisions),
                    "{label}: request 3 carries a Revision of the old world"
                );
                if fresh_revisions.is_empty() {
                    assert!(!handoff.canonical_payload().contains(BOB_TEXT), "{label}");
                }
                format!(
                    "{}, Graph inputs {}",
                    outcome_label(*outcome),
                    graph_revisions(handoff).len()
                )
            }
            Prepared::Refused => {
                assert!(fresh_revisions.is_empty(), "{label}");
                "the whole request refused (no eligible Revision)".into()
            }
        };
        eprintln!(
            "DI-1a A-11 [{label}]: request 1 from the worker, not cached; request 2 from the cache: {two_note}; request 3 from the worker at generation {new_generation}: {three_note}"
        );
    }
}

/// A-11 with two Revisions: a Codex change that only the first one depends on.
/// The cache still holds the Graph of both; request 2 carries no group, no ID
/// and no text of the first Revision, and keeps the second; request 3 (B built
/// again, the worker answering from the new world) does the same.
#[test]
fn a11_an_old_revision_is_out_of_requests_two_and_three_while_the_other_stays() {
    let (rig, second) = rig_over_real_b(true);
    let second = second.expect("second Revision");
    let first = rig.fixture.revision_id.clone();
    rig.open();
    rig.owner()
        .set_config_for_test(crate::nir1_graph_product::GraphOwnerConfig {
            cache_ttl: Duration::from_secs(30),
            ..fast_config()
        });
    let old_generation = sealed_generation(&rig.fixture.state).expect("generation");

    let Prepared::Request(one, outcome) = prepare(&rig, "request 1") else {
        panic!("request 1 is refused");
    };
    assert!(used(outcome), "{outcome:?}");
    assert_eq!(graph_revisions(&one), set_of(&[&first, &second]));
    assert!(one.canonical_payload().contains(BOB_TEXT));
    fill_the_cache_like_related_scenes(&rig);
    assert_eq!(rig.owner().cache_len_for_test(), 1);

    inject_change(&rig, Change::Freshness);

    let queries = rig.plan.queries.load(Ordering::SeqCst);
    let hits = rig.owner().diagnostics().cache_hits;
    let Prepared::Request(two, outcome) = prepare(&rig, "request 2") else {
        panic!("request 2 is refused");
    };
    let source = graph_source_since(&rig, queries, hits);
    assert_eq!(
        (source.queries, source.cache_hits),
        (0, 1),
        "from the cache"
    );
    assert!(
        used(outcome),
        "the other Revision's group is current: {outcome:?}"
    );
    assert_eq!(graph_revisions(&two), set_of(&[&second]));
    assert_eq!(accepted_revisions(&two), set_of(&[&second]));
    assert!(!two.canonical_payload().contains(BOB_TEXT), "the old text");
    assert!(two.canonical_payload().contains(CAROL_TEXT));
    assert!(two
        .excluded_revisions()
        .iter()
        .any(|excluded| excluded.revision_id() == first));

    publish_real_b(&rig.fixture.state).expect("B rebuilt");
    let new_generation = sealed_generation(&rig.fixture.state).expect("generation");
    assert!(new_generation > old_generation);
    let fresh = rig.request_without_graph().expect("the new world");
    assert_eq!(accepted_revisions(&fresh), set_of(&[&second]));
    *lock(&rig.plan.candidates) =
        Some(graph_candidates_for(fresh.authority_bindings(), new_generation).expect("candidates"));
    let queries = rig.plan.queries.load(Ordering::SeqCst);
    let hits = rig.owner().diagnostics().cache_hits;
    let Prepared::Request(three, outcome) = prepare(&rig, "request 3") else {
        panic!("request 3 is refused");
    };
    let source = graph_source_since(&rig, queries, hits);
    assert_eq!(
        (source.queries, source.cache_hits),
        (1, 0),
        "from the worker"
    );
    assert!(used(outcome), "{outcome:?}");
    assert_eq!(graph_revisions(&three), set_of(&[&second]));
    let binding = three.graph_binding().expect("a Graph");
    assert_eq!(binding.seal().generation, new_generation);
    assert_ne!(binding.seal().generation, old_generation);
    assert!(
        !three.canonical_payload().contains(BOB_TEXT),
        "the old text"
    );
    assert!(three.canonical_payload().contains(CAROL_TEXT));
}
