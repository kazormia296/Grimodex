//! Acceptance tests for GDV/1 (`nir1-graph-dirty-binding-verify-proposal/1`,
//! contract revision 6 section 8): Verify, the completed-Verify digest and the
//! Rebuild V2 shadow treat a coherent but not-current declared Graph binding as
//! "recognized, rebuildable, not query usable" instead of a manual defect.
//!
//! The Graph fixture is the B-ROUTE test fixture of the parent module. "The
//! motive form" is V0 (b): 2,065 candidates (one above the B-close bound), a
//! dirty binding, and B refusing the rebuild for the unchanged inputs.
//!
//! The behaviour of the code that GDV/1 does not touch is checked against the
//! build before GDV/1 in `gdv1_unchanged_behaviour_tests.rs`, which uses no new
//! API so the same file runs on the base and on this branch.

use super::*;
use crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome;
use crate::narrative_extraction::maintenance_runtime::MaintenanceProjectDiscovery as D;
use crate::narrative_extraction::nir1_entity_relation_index::{
    classify_graph_binding_with_control, BindingRead, GraphBindingClass as C,
    NeverStopGraphWorkControl,
};
use crate::narrative_extraction::restore_rebuild as rr;

const GRAPH_ROW: &str = "consumer_kind='semantic-index'";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn read_binding(fixture: &Fixture) -> Result<BindingRead> {
    fixture.db().with_conn_mut(|conn| {
        crate::narrative_extraction::nir1_entity_relation_index::read(conn, PROJECT)
    })
}

fn is_dirty_registered(fixture: &Fixture) -> Result<bool> {
    Ok(matches!(read_binding(fixture)?, BindingRead::Registered(binding) if binding.dirty))
}

fn classify(fixture: &Fixture) -> Result<C> {
    fixture.db().with_conn_mut(|conn| {
        let mut control = NeverStopGraphWorkControl;
        classify_graph_binding_with_control(conn, PROJECT, &mut control)
    })
}

fn execute(fixture: &Fixture, sql: &str) -> Result<()> {
    fixture.db().with_conn(|conn| {
        conn.execute_batch(sql)?;
        Ok(())
    })
}

/// The motive form (V0 (b)) with or without the C2-ZC cutover marker.
fn motive(marker: bool) -> Result<Fixture> {
    let fixture = Fixture::published_with_marker(marker)?;
    overflow_candidates(&fixture)?;
    let recorder = Recorder::default();
    fixture.dispatch(&recorder)?;
    assert_eq!(fixture.record(), refused_capacity("candidate-rows"));
    assert_eq!(fixture.marker()?.is_some(), marker);
    Ok(fixture)
}

/// Started work, folded to a kind.
fn started_kinds(recorder: &Recorder) -> Vec<String> {
    recorder
        .started
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .map(|key| {
            if is_graph_key(key) {
                "graph-build".to_string()
            } else if key.contains("dependency-verify") {
                "verify".to_string()
            } else if key.contains("rebuild") {
                "rebuild".to_string()
            } else {
                key.clone()
            }
        })
        .collect()
}

fn work_request(
    fixture: &Fixture,
    run_kind: AutomaticRunKind,
    reasons: &[&str],
) -> Result<MaintenanceCycleRequest> {
    let epoch = fixture.current_epoch()?;
    Ok(MaintenanceCycleRequest {
        work: vec![MaintenanceWorkRequest {
            project_id: PROJECT.into(),
            run_kind,
            work_key: if run_kind == AutomaticRunKind::Verify {
                format!("dependency-verify:{epoch}")
            } else {
                "dependency-rebuild-derived".to_string()
            },
            semantic_epoch_id: Some(epoch),
            reasons: reasons.iter().map(|reason| reason.to_string()).collect(),
        }],
        wake_project_ids: Vec::new(),
        delivery_sequence: None,
        delivery_fingerprint: None,
        workspace_binding: None,
    })
}

/// Delete one current-epoch Edge State of a non-Graph Edge: that Consumer then
/// needs a same-epoch Rebuild (`rebuild_required = true`).
fn require_rebuild(fixture: &Fixture) -> Result<()> {
    let removed = fixture.db().with_conn(|conn| {
        Ok(conn.execute(
            "DELETE FROM narrative_dependency_edge_states
              WHERE edge_id = (SELECT id FROM narrative_dependency_edges
                                WHERE project_id=?1 AND consumer_kind <> 'semantic-index'
                                ORDER BY id LIMIT 1)",
            [PROJECT],
        )?)
    })?;
    assert_eq!(removed, 1);
    Ok(())
}

fn last_verify(fixture: &Fixture) -> Result<Option<(String, String, serde_json::Value)>> {
    Ok(fixture
        .db()
        .with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, semantic_epoch_id, outcome_summary_json FROM narrative_extraction_runs
                      WHERE project_id=?1 AND run_kind='dependency-verify' AND status='completed'
                      ORDER BY rowid DESC LIMIT 1",
                    [PROJECT],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?)
        })?
        .map(|(id, epoch, summary)| {
            (
                id,
                epoch,
                serde_json::from_str(&summary).unwrap_or(serde_json::Value::Null),
            )
        }))
}

fn excluded_graph_edge_count(report: &serde_json::Value) -> Option<u64> {
    let excluded = report["consumersExcludedNotCurrent"].as_array()?;
    let [entry] = excluded.as_slice() else {
        return None;
    };
    (entry["consumerKind"] == "semantic-index" && entry["consumerKey"] == INDEX_KEY)
        .then(|| entry["edgeCount"].as_u64())
        .flatten()
}

fn product_wakes(
    fixture: &Fixture,
    seam: Option<&NarrativeMaintenanceCiConfig>,
    count: usize,
) -> Result<Vec<D>> {
    let mut discoveries = Vec::new();
    for index in 0..count {
        let recorder = Recorder::default();
        let (discovery, _) =
            main_wake_cycle_with_discovery(fixture, seam, "workspace-opened", &recorder)
                .map_err(|error| anyhow!("wake#{index} must not fail: {error:#}"))?;
        discoveries.push(discovery);
    }
    Ok(discoveries)
}

fn digest(fixture: &Fixture) -> Result<String> {
    fixture
        .db()
        .with_conn_mut(|conn| rr::durable_graph_state_digest(conn, PROJECT))
}

// ---------------------------------------------------------------------------
// T-3 / case C: measurement and acceptance (DR-PUBG-5-16)
// ---------------------------------------------------------------------------

/// What one T-3 form did: the kinds started by the first cycle, the Graph
/// generation after it and after all wakes, and how many Graph builds started
/// in total.
#[derive(Debug, PartialEq)]
struct OrderObservation {
    first_cycle: Vec<String>,
    generation_after_first_cycle: Option<i64>,
    generation_after_all_wakes: Option<i64>,
    graph_builds: usize,
}

/// Form (a): main hands over the durable Verify (dirty Graph, B can rebuild).
fn observe_main_verify() -> Result<OrderObservation> {
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let seam = graph_seam();
    let mut kinds = Vec::new();
    let mut after_first = None;
    for index in 0..6 {
        let recorder = Recorder::default();
        main_wake_cycle_with_discovery(&fixture, Some(&seam), "workspace-opened", &recorder)?;
        kinds.push(started_kinds(&recorder));
        if index == 0 {
            after_first = Some(generation(fixture.db())?);
        }
    }
    Ok(OrderObservation {
        first_cycle: kinds[0].clone(),
        generation_after_first_cycle: after_first.flatten(),
        generation_after_all_wakes: generation(fixture.db())?,
        graph_builds: kinds
            .iter()
            .flatten()
            .filter(|kind| kind.as_str() == "graph-build")
            .count(),
    })
}

/// Form (b): main hands over a RebuildDerived (dirty Graph, a non-Graph Edge
/// State missing).
fn observe_main_rebuild() -> Result<OrderObservation> {
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    require_rebuild(&fixture)?;
    let seam = graph_seam();
    let mut kinds = Vec::new();
    let recorder = Recorder::default();
    run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &work_request(
            &fixture,
            AutomaticRunKind::RebuildDerived,
            &["workspace-opened"],
        )?,
        Some(&seam),
        &recorder,
    )?;
    kinds.push(started_kinds(&recorder));
    let after_first = generation(fixture.db())?;
    for _ in 0..6 {
        let recorder = Recorder::default();
        main_wake_cycle_with_discovery(&fixture, Some(&seam), "workspace-opened", &recorder)?;
        kinds.push(started_kinds(&recorder));
    }
    Ok(OrderObservation {
        first_cycle: kinds[0].clone(),
        generation_after_first_cycle: after_first,
        generation_after_all_wakes: generation(fixture.db())?,
        graph_builds: kinds
            .iter()
            .flatten()
            .filter(|kind| kind.as_str() == "graph-build")
            .count(),
    })
}

/// Case C-2 (DR-PUBG-5-16): the Graph producer's judgement runs in front of a
/// durable Verify that main handed to the cycle, and only there. In front of a
/// RebuildDerived item it is not taken, so the extra Graph publish that the
/// full form (C-1) leaves behind does not appear.
#[test]
fn case_c2_judges_the_graph_before_a_main_verify_and_leaves_no_extra_publish() -> Result<()> {
    let _serial = serial();
    let verify = observe_main_verify()?;
    let rebuild = observe_main_rebuild()?;
    eprintln!("GDV1 case C observation (a) main Verify = {verify:?}");
    eprintln!("GDV1 case C observation (b) main RebuildDerived = {rebuild:?}");

    // (a) B is judged in front of the Verify, B rebuilds once, and no further
    // Graph build starts in any later wake.
    assert_eq!(
        verify.first_cycle.first().map(String::as_str),
        Some("graph-build")
    );
    assert_eq!(verify.generation_after_first_cycle, Some(2));
    assert_eq!(verify.generation_after_all_wakes, Some(2));
    assert_eq!(verify.graph_builds, 1);

    // (b) the same numbers as the form without case C: generation 2 after the
    // first cycle and after all wakes, one Graph build in total, and the
    // RebuildDerived runs first.
    assert_eq!(
        rebuild.first_cycle.first().map(String::as_str),
        Some("rebuild")
    );
    assert_eq!(rebuild.generation_after_first_cycle, Some(2));
    assert_eq!(rebuild.generation_after_all_wakes, Some(2));
    assert_eq!(rebuild.graph_builds, 1);
    Ok(())
}

/// Section 7 (binding): the gated route never judges the C2-ZC BeforeCutover
/// flow. A project is not judged when ANY item's reasons carries
/// `before-cutover`; the positive control (`[workspace-opened]` Verify) is.
#[test]
fn case_c2_never_judges_the_before_cutover_flow() -> Result<()> {
    let _serial = serial();
    let observe = |run_kind: AutomaticRunKind, reasons: &[&str]| -> Result<Vec<String>> {
        let fixture = Fixture::published()?;
        fixture.mark_dirty()?;
        let recorder = Recorder::default();
        let request = work_request(&fixture, run_kind, reasons)?;
        run_cycle_on(
            fixture.db(),
            Some(fixture.runtime()),
            &request,
            Some(&graph_seam()),
            &recorder,
        )?;
        Ok(started_kinds(&recorder))
    };
    let strs = |kinds: &[&str]| kinds.iter().map(|kind| kind.to_string()).collect::<Vec<_>>();

    // Positive control: a plain Verify is judged first.
    let positive = observe(AutomaticRunKind::Verify, &["workspace-opened"])?;
    assert_eq!(positive.first().map(String::as_str), Some("graph-build"));
    // before-cutover anywhere in the reasons: not judged in front of the work.
    for reasons in [&["workspace-opened", "before-cutover"][..], &["before-cutover"][..]] {
        assert_eq!(
            observe(AutomaticRunKind::Verify, reasons)?,
            strs(&["verify", "rebuild", "verify"]),
            "{reasons:?}"
        );
    }
    // The follow-up reason is Rust-internal: the request preflight refuses it
    // before the cycle (so it cannot be handed in), and the guard in the cycle
    // stays as a defence for an internally raised item.
    let fixture = Fixture::published()?;
    let request = work_request(
        &fixture,
        AutomaticRunKind::Verify,
        &["before-cutover-follow-up"],
    )?;
    let error = preflight_maintenance_cycle_request(&request).expect_err("preflight refuses it");
    assert!(
        error_text(&error).contains("NEX_MAINTENANCE_INVALID_REQUEST")
            && error_text(&error).contains("C2-ZC follow-up reason is Rust-internal"),
        "{error:#}"
    );
    // C-2 does not judge in front of a RebuildDerived at all; the last
    // rediscovery of the cycle still wakes B for a plain reason (an existing
    // behaviour that GDV/1 does not change).
    assert_eq!(
        observe(AutomaticRunKind::RebuildDerived, &["workspace-opened"])?
            .first()
            .map(String::as_str),
        Some("rebuild")
    );
    assert_eq!(
        observe(
            AutomaticRunKind::RebuildDerived,
            &["workspace-opened", "before-cutover"]
        )?,
        strs(&["rebuild", "graph-build", "verify"])
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// section 3.1: the classification (T-6)
// ---------------------------------------------------------------------------

fn digest_of(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

/// The 21 binding shapes of the contract's T-6 (section 2.6): SQL that turns
/// the published Graph into the shape. `PRAGMA foreign_keys=OFF` builds the
/// shapes that a legitimate write cannot produce.
fn binding_shapes() -> Vec<(&'static str, String)> {
    let (k, p) = (INDEX_KEY, PROJECT);
    let g = format!("project_id='{p}' AND consumer_kind='semantic-index' AND consumer_key='{k}'");
    let meta = format!("project_id='{p}' AND index_key='{k}'");
    let first_codex_edge = format!(
        "(SELECT id FROM narrative_dependency_edges WHERE {g} AND source_object_identity LIKE 'codex:%' ORDER BY id LIMIT 1)"
    );
    let first_edge =
        format!("(SELECT id FROM narrative_dependency_edges WHERE {g} ORDER BY id LIMIT 1)");
    vec![
        ("00 current", String::new()),
        ("01 dirty=1", format!("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE {meta}")),
        ("02 dirty=0, Freshness stale", format!("UPDATE narrative_consumer_freshness SET evidence_freshness='stale' WHERE {g}")),
        ("03 dirty=0, build_action=rebuild-required", format!("UPDATE narrative_consumer_freshness SET build_action='rebuild-required' WHERE {g}")),
        ("04 dirty=0, Freshness epoch is another", format!("PRAGMA foreign_keys=OFF; UPDATE narrative_consumer_freshness SET semantic_epoch_id='other-epoch' WHERE {g}")),
        ("05 no current epoch, dirty=0", "PRAGMA foreign_keys=OFF; DELETE FROM narrative_semantic_epochs".to_string()),
        ("05b no current epoch, dirty=1", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_semantic_epochs; UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE {meta}")),
        ("06 no Freshness row", format!("DELETE FROM narrative_consumer_freshness WHERE {g}")),
        ("07 dirty=1, Freshness digest mismatch", format!("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE {meta}; UPDATE narrative_consumer_freshness SET dependency_set_digest='{}' WHERE {g}", digest_of('0'))),
        ("08 dirty=0, Freshness digest mismatch", format!("UPDATE narrative_consumer_freshness SET dependency_set_digest='{}' WHERE {g}", digest_of('0'))),
        ("09 metadata generation differs from the D1 head", format!("UPDATE narrative_semantic_index_metadata SET generation=generation+1 WHERE {meta}")),
        ("10 producer_id mismatch", format!("UPDATE narrative_semantic_index_metadata SET producer_id='someone-else' WHERE {meta}")),
        ("11 D1 entries removed", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_dependency_declaration_entries WHERE declaration_set_id IN (SELECT declaration_set_id FROM narrative_dependency_declaration_heads WHERE {g})")),
        ("12 metadata only", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_dependency_declaration_heads WHERE {g}; DELETE FROM narrative_dependency_edges WHERE {g}; DELETE FROM narrative_consumer_freshness WHERE {g}")),
        ("13 edges only", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_semantic_index_metadata WHERE {meta}")),
        ("14 one V1 Edge removed", format!("DELETE FROM narrative_dependency_edges WHERE id={first_codex_edge}")),
        ("15 read set not canonical", format!("UPDATE narrative_dependency_edges SET read_set_json='[\"b\",\"a\"]' WHERE id={first_codex_edge}")),
        ("16 eligibility token mismatch", format!("UPDATE narrative_dependency_edges SET read_set_json='[\"{}\"]' WHERE {g} AND source_object_identity LIKE 'project:%'", digest_of('1'))),
        ("17 Edge State stale", format!("UPDATE narrative_dependency_edge_states SET evidence_freshness='stale' WHERE edge_id={first_edge}")),
        ("18 Edge State of another epoch", format!("PRAGMA foreign_keys=OFF; UPDATE narrative_dependency_edge_states SET evaluated_at_epoch_id='other-epoch' WHERE edge_id={first_edge}")),
        ("19 metadata source_digest differs", format!("UPDATE narrative_semantic_index_metadata SET source_digest='{}' WHERE {meta}", digest_of('2'))),
    ]
}

#[derive(Debug, PartialEq)]
struct ShapeRow {
    reader: &'static str,
    class: String,
    complete: Option<bool>,
    hint: String,
}

fn observe_shape(sql: &str) -> Result<ShapeRow> {
    let fixture = Fixture::published()?;
    if !sql.is_empty() {
        execute(&fixture, sql)?;
    }
    let reader = match read_binding(&fixture)? {
        BindingRead::Missing => "Missing",
        BindingRead::Reserved => "Reserved",
        BindingRead::Registered(binding) if binding.dirty => "Registered{dirty}",
        BindingRead::Registered(_) => "Registered",
    };
    Ok(ShapeRow {
        reader,
        class: format!("{:?}", classify(&fixture)?),
        complete: complete_registered(fixture.db()).ok(),
        hint: fixture
            .judge()
            .map(|decision| format!("{decision:?}"))
            .unwrap_or_else(|error| format!("ERR {error:#}")),
    })
}

/// Contract section 8, Positive/Negative: for each of the 21 shapes, the helper
/// is `Incoherent` exactly when the reader is `Reserved`; a recognized
/// not-current shape never reads the eligibility (`is_complete_registered` is
/// `Ok(false)`, not a capacity error) and B's hint is a `Build`; a shape with
/// no current Semantic Epoch is left as is. Every shape must apply (no SQL is
/// silently skipped). The helper and the reader share one structural read, so
/// the agreement is a regression test, not independent evidence.
#[test]
fn classification_table_matches_reader_and_b_hint() -> Result<()> {
    let _serial = serial();
    const BUILD_DIRTY: &str = "Build { mode: Rebuild, reason: BindingDirty }";
    const BUILD_NOT_CURRENT: &str = "Build { mode: Rebuild, reason: NotCurrent }";
    const BUILD_VALIDATE: &str = "Build { mode: ValidateThenRebuild, reason: ColdReopenValidation }";
    const SKIP_CURRENT: &str = "Skip { reason: BindingCurrent }";
    const SKIP_INCOHERENT: &str = "Skip { reason: BindingIncoherent }";
    const SKIP_NO_EPOCH: &str = "Skip { reason: NoEpoch }";
    // (name prefix, reader, class, is_complete_registered, B's hint)
    let expected: [(&str, &str, &str, bool, &str); 21] = [
        ("00", "Registered", "Current", true, SKIP_CURRENT),
        ("01", "Registered{dirty}", "RecognizedNotCurrent", false, BUILD_DIRTY),
        ("02", "Registered", "RecognizedNotCurrent", false, BUILD_NOT_CURRENT),
        ("03", "Registered", "RecognizedNotCurrent", false, BUILD_NOT_CURRENT),
        ("04", "Registered", "RecognizedNotCurrent", false, BUILD_NOT_CURRENT),
        ("05 ", "Registered", "NoCurrentEpoch", false, SKIP_NO_EPOCH),
        ("05b", "Registered{dirty}", "NoCurrentEpoch", false, SKIP_NO_EPOCH),
        ("06", "Reserved", "Incoherent", false, SKIP_INCOHERENT),
        ("07", "Reserved", "Incoherent", false, BUILD_DIRTY),
        ("08", "Reserved", "Incoherent", false, BUILD_VALIDATE),
        ("09", "Reserved", "Incoherent", false, BUILD_VALIDATE),
        ("10", "Reserved", "Incoherent", false, SKIP_INCOHERENT),
        ("11", "Reserved", "Incoherent", false, SKIP_CURRENT),
        ("12", "Reserved", "Incoherent", false, SKIP_INCOHERENT),
        ("13", "Reserved", "Incoherent", false, SKIP_INCOHERENT),
        ("14", "Reserved", "Incoherent", false, SKIP_CURRENT),
        ("15", "Reserved", "Incoherent", false, SKIP_CURRENT),
        ("16", "Reserved", "Incoherent", false, SKIP_CURRENT),
        // Current by the helper, false by full validation; B does not repair them.
        ("17", "Registered", "Current", false, SKIP_CURRENT),
        ("18", "Registered", "Current", false, SKIP_CURRENT),
        ("19", "Reserved", "Incoherent", false, BUILD_VALIDATE),
    ];
    let shapes = binding_shapes();
    assert_eq!(shapes.len(), 21);
    for (name, sql) in shapes {
        let (_, reader, class, complete, hint) = expected
            .iter()
            .find(|(prefix, ..)| name.starts_with(prefix))
            .unwrap_or_else(|| panic!("no expectation for {name}"));
        let row = observe_shape(&sql)?;
        assert_eq!(row.reader, *reader, "{name}");
        assert_eq!(row.class, *class, "{name}");
        assert_eq!(row.complete, Some(*complete), "{name}");
        assert_eq!(row.hint, *hint, "{name}");
        // The invariants the table encodes.
        assert_eq!(row.class == "Incoherent", row.reader == "Reserved", "{name}");
        if row.class == "RecognizedNotCurrent" {
            assert_eq!(row.complete, Some(false), "{name}");
            assert!(row.hint.starts_with("Build"), "{name}: {}", row.hint);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// the motive form (V0 (b)), T-1
// ---------------------------------------------------------------------------

/// The motive form, with and without the cutover marker, through the product
/// path (no seam) and the B-ROUTE seam: classification, no failing wake,
/// completed clean Verify that excludes the Graph, no Finding, a chain that
/// reaches idle, a bounded Run count, and a binding that stays dirty.
#[test]
fn motive_form_does_not_stall_with_and_without_the_cutover_marker() -> Result<()> {
    let _serial = serial();
    for marker in [true, false] {
        let fixture = motive(marker)?;
        let tag = format!("marker={marker}");
        // (0) the binding is `Registered{dirty:true}` by the reader's structural
        // read and is recognized not-current by the helper.
        assert!(is_dirty_registered(&fixture)?, "{tag}");
        assert_eq!(classify(&fixture)?, C::RecognizedNotCurrent, "{tag}");
        let runs_before = run_ledger(fixture.db())?.len();

        // (1) six product wakes never fail; the chain reaches idle on wake#1.
        let discoveries = product_wakes(&fixture, None, 6)?;
        assert!(
            matches!(&discoveries[0], D::Work(work) if work.run_kind == AutomaticRunKind::Verify),
            "{tag}: {:?}",
            discoveries[0]
        );
        assert!(
            discoveries[1..].iter().all(|d| matches!(d, D::Idle)),
            "{tag}: {discoveries:?}"
        );
        // (2) the new Verify is completed and clean; the Graph is excluded.
        let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
        let report = &outcome["report"];
        assert!(excluded_graph_edge_count(report).is_some_and(|count| count > 0), "{tag}: {report}");
        assert_eq!(report["edgeIdsWithUnresolvableConsumerScope"], json!([]));
        assert_eq!(report["edgeIdsWithMissingSource"], json!([]));
        let parsed: rr::DependencyGraphVerifyReport = serde_json::from_value(report.clone())?;
        assert!(parsed.is_clean(), "{tag}: {report}");
        // (3) no Finding.
        assert!(finding_keys(fixture.db())?.is_empty(), "{tag}");
        // (4) the Run count is bounded: the product path adds Verify only.
        let runs_idle = run_ledger(fixture.db())?;
        assert_eq!(runs_idle.len(), runs_before + 1, "{tag}: {runs_idle:?}");
        // (5) with the seam the project keeps waking B, B stays refused for the
        // unchanged inputs and no wake adds a Run, a Finding or fails.
        let seam = graph_seam();
        for discovery in product_wakes(&fixture, Some(&seam), 6)? {
            assert!(matches!(discovery, D::GraphIndexBuildWake), "{tag}: {discovery:?}");
        }
        assert_eq!(run_ledger(fixture.db())?, runs_idle, "{tag}");
        assert!(finding_keys(fixture.db())?.is_empty(), "{tag}");
        // The binding is not removed: it stays dirty and unavailable to the reader.
        assert!(is_dirty_registered(&fixture)?, "{tag}");
        assert_eq!(fixture.record(), refused_capacity("candidate-rows"), "{tag}");
    }
    Ok(())
}

/// Control: with no Graph binding the same excess is idle in the same number of
/// wakes and adds no Run (V0's control).
#[test]
fn motive_form_control_without_a_binding_is_idle() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::new()?;
    drain_durable_chain(&fixture)?;
    overflow_candidates(&fixture)?;
    let runs = run_ledger(fixture.db())?.len();
    for discovery in product_wakes(&fixture, None, 4)? {
        assert!(matches!(discovery, D::Idle), "{discovery:?}");
    }
    assert_eq!(run_ledger(fixture.db())?.len(), runs);
    assert!(finding_keys(fixture.db())?.is_empty());
    Ok(())
}

/// T-4: a deadline refusal (`elapsed_deadline`) that leaves the binding dirty
/// does not stop Verify, with and without `rebuild_required` on another
/// Consumer.
#[test]
fn deadline_refusal_with_a_dirty_binding_does_not_stall() -> Result<()> {
    let _serial = serial();
    for rebuild_required in [false, true] {
        let fixture = Fixture::published()?;
        fixture.mark_dirty()?;
        let deadline = Duration::from_secs(2);
        let budget = CapacityBudget::new(SQL_PROGRESS_LIMIT, Instant::now() + deadline);
        let hook = install_hook(move |stage, _| {
            if stage == TestStage::BeforePrepare {
                std::thread::sleep(deadline + Duration::from_millis(200));
            }
            Ok(())
        });
        let recorder = Recorder::default();
        let outcome = with_attempt_budget_for_test(budget, || fixture.dispatch(&recorder))?;
        assert_eq!(outcome, no_finalization(false));
        assert_eq!(fixture.record(), refused_capacity("deadline"));
        drop(hook);
        if rebuild_required {
            require_rebuild(&fixture)?;
        }
        let discoveries = product_wakes(&fixture, None, 8)?;
        assert!(discoveries.iter().any(|d| matches!(d, D::Idle)), "{discoveries:?}");
        let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
        assert!(excluded_graph_edge_count(&outcome["report"]).is_some());
        assert!(finding_keys(fixture.db())?.is_empty(), "no semantic-graph-requires-repair");
        let runs = run_ledger(fixture.db())?;
        assert_eq!(
            runs.iter()
                .any(|(kind, status)| kind == "semantic-index-rebuild" && status == "completed"),
            rebuild_required,
            "{runs:?}"
        );
    }
    Ok(())
}

/// T-8 (2): a database whose Graph binding is not current opened with the gate
/// closed (an evaluation DB copy opened by the product build). Verify excludes
/// the Graph and completes, B never runs, the exclusion lasts as long as B does
/// not run (GDV-R1: no upper bound on the period), and the reader says the
/// Graph is unavailable.
#[test]
fn closed_gate_database_keeps_the_exclusion_and_the_reader_unavailable() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let record_before = fixture.record();
    let discoveries = product_wakes(&fixture, None, 6)?;
    assert!(discoveries.iter().any(|d| matches!(d, D::Idle)), "{discoveries:?}");
    let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(excluded_graph_edge_count(&outcome["report"]).is_some_and(|count| count > 0));
    assert_eq!(fixture.record(), record_before, "the closed gate never runs B");
    assert!(is_dirty_registered(&fixture)?, "the exclusion lasts while B does not run");
    assert!(
        reader_query(&fixture)?.is_none(),
        "the reader does not register a dirty Graph: it is unavailable"
    );
    Ok(())
}
