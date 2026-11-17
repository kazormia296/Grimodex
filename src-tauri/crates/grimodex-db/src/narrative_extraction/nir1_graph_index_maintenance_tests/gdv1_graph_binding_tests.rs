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
        ("11 D1 entries removed", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_dependency_declaration_entries WHERE declaration_set_id IN (SELECT active_declaration_set_id FROM narrative_dependency_declaration_heads WHERE {g})")),
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

/// Section 3.1 "no current Semantic Epoch": the binding is left as is (dirty or
/// not), no Verify or Rebuild is dispatched while there is no epoch, and once
/// the epoch exists the binding is recognized not-current and B's hint is a
/// build. Here the epoch is created by the real Backfill Run (a wake with no
/// current epoch), not by a direct `create_epoch_in_tx`; the metadata's
/// `dirty_cache_flag` after the epoch is created is recorded.
#[test]
fn no_current_epoch_is_left_as_is_until_a_backfill_run_creates_one() -> Result<()> {
    let _serial = serial();
    for dirty in [false, true] {
        let fixture = Fixture::published()?;
        let meta = format!("project_id='{PROJECT}' AND index_key='{INDEX_KEY}'");
        execute(&fixture, "PRAGMA foreign_keys=OFF; DELETE FROM narrative_semantic_epochs")?;
        if dirty {
            execute(
                &fixture,
                &format!("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE {meta}"),
            )?;
        }
        assert_eq!(classify(&fixture)?, C::NoCurrentEpoch, "dirty={dirty}");
        assert!(!complete_registered(fixture.db())?);
        assert_eq!(fixture.judge()?, skip(Nir1GraphIndexSkipReason::NoEpoch));
        // While there is no epoch the durable chain offers only Backfill.
        let recorder = Recorder::default();
        let (discovered, _) =
            main_wake_cycle_with_discovery(&fixture, None, "workspace-opened", &recorder)?;
        assert!(
            matches!(&discovered, D::Work(work) if work.run_kind == AutomaticRunKind::Backfill),
            "dirty={dirty}: {discovered:?}"
        );
        // The Backfill Run created the epoch.
        assert!(
            run_ledger(fixture.db())?
                .iter()
                .any(|(kind, status)| kind == "backfill" && status == "completed"),
            "{:?}",
            run_ledger(fixture.db())?
        );
        let dirty_after = sealed(fixture.db())?.map(|identity| identity.1);
        // Creating the epoch dirties the binding (observed, both starting values).
        assert_eq!(dirty_after, Some(1), "dirty={dirty}");
        assert_eq!(classify(&fixture)?, C::RecognizedNotCurrent, "dirty={dirty}");
        assert!(matches!(fixture.judge()?, Nir1GraphIndexBuildDecision::Build { .. }));
        assert!(!complete_registered(fixture.db())?);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// S-4: the completed-Verify digest (T-2)
// ---------------------------------------------------------------------------

/// The digest never reads the whole-project eligibility for a recognized
/// not-current Graph, even uncontrolled; it changes with the binding's identity
/// surfaces but not with the Source the Graph edges would have resolved
/// (GDV-R5). For a current binding the uncontrolled digest is still
/// `context-unavailable` (unchanged before GDV/1).
#[test]
fn digest_reads_no_eligibility_for_a_not_current_graph() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let current = digest(&fixture).expect_err("a current binding's uncontrolled digest is unchanged");
    assert!(is_context_unavailable_termination(&current), "{current:#}");

    fixture.mark_dirty()?;
    let first = digest(&fixture)?;
    // Adding candidates changes the eligibility Source: not read, so no change.
    overflow_candidates(&fixture)?;
    let after_candidates = digest(&fixture)?;
    assert_eq!(first, after_candidates);
    // The identity surfaces are still in the digest: metadata, then Freshness.
    execute(
        &fixture,
        &format!(
            "UPDATE narrative_semantic_index_metadata SET built_at='2026-09-23T00:00:00.000Z'
              WHERE project_id='{PROJECT}'"
        ),
    )?;
    let after_metadata = digest(&fixture)?;
    assert_ne!(after_candidates, after_metadata);
    execute(
        &fixture,
        &format!(
            "UPDATE narrative_consumer_freshness SET updated_at='2026-09-23T00:00:00.000Z'
              WHERE project_id='{PROJECT}' AND {GRAPH_ROW}"
        ),
    )?;
    assert_ne!(after_metadata, digest(&fixture)?);
    // The structure is untouched by these edits: still recognized not-current.
    assert_eq!(classify(&fixture)?, C::RecognizedNotCurrent);
    Ok(())
}

/// The digest of a binding differs once it is not current. This test alone is
/// NOT evidence for the S-4 mark: the Freshness row itself is part of the digest,
/// so the digest differs even without the mark. The mark's invariant rests on
/// three things: the digest does not change when candidates are added while
/// not-current (`digest_reads_no_eligibility_for_a_not_current_graph`), the unit
/// test that the mark is disjoint from every resolved-Source status, and the
/// `NEX_VERIFY_GRAPH_STATE_CHANGED` refusals of a report sealed before the Graph
/// became not-current (`a_report_sealed_before_the_graph_became_not_current_...`).
#[test]
fn digest_of_a_binding_differs_once_it_is_not_current() -> Result<()> {
    let _serial = serial();
    use crate::narrative_extraction::source_revision::ForegroundValidationControl;
    let foreground_digest = |fixture: &Fixture| -> Result<String> {
        fixture.db().with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            let mut control = ForegroundValidationControl;
            rr::durable_graph_state_digest_with_control(&mut tx, PROJECT, &mut control)
        })
    };
    let fixture = Fixture::published()?;
    let current = foreground_digest(&fixture)?;
    assert_eq!(current, foreground_digest(&fixture)?, "the digest is deterministic");
    // Only Freshness changes (the dependency digest and every Edge row stay).
    execute(
        &fixture,
        &format!(
            "UPDATE narrative_consumer_freshness SET evidence_freshness='stale'
              WHERE project_id='{PROJECT}' AND {GRAPH_ROW}"
        ),
    )?;
    assert_eq!(classify(&fixture)?, C::RecognizedNotCurrent);
    assert_ne!(current, foreground_digest(&fixture)?);
    Ok(())
}

// ---------------------------------------------------------------------------
// re-publish: the next Verify validates the Graph in full
// ---------------------------------------------------------------------------

/// Once B re-publishes, the next Verify checks the Graph's Edges again: nothing
/// is excluded, and the same damage that is invisible while the binding is
/// not-current (a Graph Edge's Edge State missing) puts the Graph's Edges into
/// the unresolvable-scope check.
#[test]
fn after_a_republish_verify_checks_the_graph_edges_in_full() -> Result<()> {
    let _serial = serial();
    let damage = format!(
        "DELETE FROM narrative_dependency_edge_states WHERE edge_id = (SELECT id FROM narrative_dependency_edges
          WHERE project_id='{PROJECT}' AND {GRAPH_ROW} AND source_object_identity LIKE 'codex:%' ORDER BY id LIMIT 1)"
    );
    // While not-current: the Graph's Edges are outside every check.
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    execute(&fixture, &damage)?;
    let recorder = Recorder::default();
    run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &work_request(&fixture, AutomaticRunKind::Verify, &["workspace-opened"])?,
        None,
        &recorder,
    )?;
    let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
    let report = &outcome["report"];
    assert!(excluded_graph_edge_count(report).is_some());
    assert_eq!(report["edgeIdsWithUnresolvableConsumerScope"], json!([]));
    assert_eq!(report["edgeIdsWithoutCurrentEpochState"], json!([]));

    // B re-publishes (the seam wake), then Verify runs again.
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let seam = graph_seam();
    let mut idle = false;
    for _ in 0..6 {
        let recorder = Recorder::default();
        main_wake_cycle_with_discovery(&fixture, Some(&seam), "workspace-opened", &recorder)?;
        idle |= generation(fixture.db())? == Some(2);
    }
    assert!(idle, "B re-published");
    assert_eq!(classify(&fixture)?, C::Current);
    // The republished binding is valid. A current binding's Verify needs the
    // caller-owned full-eligibility context, so the report comes from the
    // foreground Verify (the same function the existing dirty-Graph tests use).
    let verify_report = |fixture: &Fixture| -> Result<serde_json::Value> {
        let report = fixture.db().with_read_transaction(|conn| {
            rr::verify_narrative_dependency_graph_for_project(conn, PROJECT)
        })?;
        Ok(serde_json::to_value(report)?)
    };
    let report = verify_report(&fixture)?;
    assert!(report.get("consumersExcludedNotCurrent").is_none(), "{report}");
    assert_eq!(report["edgeIdsWithUnresolvableConsumerScope"], json!([]));
    assert_eq!(report["edgeIdsWithoutCurrentEpochState"], json!([]));
    // With one Graph Edge's Edge State gone (a damage the classification keeps
    // as current), the Graph's Edges are inside the checks: it is reported.
    execute(&fixture, &damage)?;
    let report = verify_report(&fixture)?;
    assert!(report.get("consumersExcludedNotCurrent").is_none(), "{report}");
    assert!(
        report["edgeIdsWithUnresolvableConsumerScope"]
            .as_array()
            .is_some_and(|edges| edges.len() == 4),
        "the Graph's 4 Edges are inside the checks after the republish: {report}"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// GDV-R9 (x): the downstream gates stay closed (T-7, section 3.2 invariant)
// ---------------------------------------------------------------------------

fn seal_message(fixture: &Fixture, run_id: &str, epoch: &str) -> Result<std::result::Result<usize, String>> {
    Ok(fixture
        .db()
        .with_conn_mut(|conn| {
            crate::narrative_extraction::repair::seal_repair_plan(conn, PROJECT, run_id, epoch)
        })
        .map(|plan| plan.change_count())
        .map_err(|error| format!("{error:#}")))
}

fn project_readiness(
    fixture: &Fixture,
) -> Result<crate::narrative_extraction::ProjectCutoverReadiness> {
    fixture.db().with_conn_mut(|conn| {
        crate::narrative_extraction::inspect_project_cutover_readiness(conn, PROJECT)
    })
}

/// The motive form after three product wakes: a completed Verify that excluded
/// the Graph.
fn motive_with_excluding_verify() -> Result<(Fixture, String, String, serde_json::Value)> {
    let fixture = motive(true)?;
    product_wakes(&fixture, None, 3)?;
    let (run_id, epoch, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(excluded_graph_edge_count(&outcome["report"]).is_some(), "{outcome}");
    Ok((fixture, run_id, epoch, outcome))
}

/// A report that excluded a recognized not-current Graph passes the four
/// Verify outcome validators, but cannot seal a Repair plan and does not pass
/// the C2Z readiness Verify gate: each refusal asserts its own code/reason, so
/// another gate cannot satisfy the test. The control is the binding-less form of
/// the same workspace (an empty field; a report with the field emptied cannot be
/// made, its digest is sealed).
#[test]
fn an_excluding_report_cannot_seal_a_repair_or_pass_the_c2z_verify_gate() -> Result<()> {
    let _serial = serial();
    let (fixture, run_id, epoch, outcome) = motive_with_excluding_verify()?;

    // The four outcome validators accept the new field.
    let report: rr::DependencyGraphVerifyReport = serde_json::from_value(outcome["report"].clone())?;
    rr::validate_canonical_verify_outcome_digest(&outcome)?;
    rr::validate_verify_check_coverage(&outcome)?;
    fixture.db().with_conn(|conn| {
        let mut control = NeverStopGraphWorkControl;
        rr::validate_report_rebuild_required_with_control(conn, PROJECT, &report, &mut control)
    })?;
    crate::narrative_extraction::maintenance_runtime::validate_phase_success_outcome(
        "dependency-verify",
        PROJECT,
        &format!("dependency-verify:{epoch}"),
        Some(&epoch),
        &outcome,
    )?;

    // Repair's seal refuses with its own code.
    let seal = seal_message(&fixture, &run_id, &epoch)?;
    assert!(
        matches!(&seal, Err(message) if message.contains("NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE")),
        "{seal:?}"
    );
    // So does the apply path's re-seal.
    let reseal = fixture.db().with_conn_mut(|conn| {
        crate::narrative_extraction::repair::reseal_for_verify_run_for_test(
            conn, PROJECT, &run_id, &epoch,
        )
    });
    assert!(
        matches!(&reseal, Err(error) if error_text(error).contains("NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE")),
        "{reseal:?}"
    );

    // C2Z readiness: the Verify gate is Blocked with exactly the reason.
    use crate::narrative_extraction::ReadinessState;
    let readiness = project_readiness(&fixture)?;
    assert_eq!(readiness.verify.state, ReadinessState::Blocked);
    assert_eq!(readiness.verify.reasons, vec!["verify-graph-recognized-unavailable".to_string()]);
    assert!(readiness.verify.report_clean);
    assert!(!readiness.ready);
    let workspace = fixture
        .db()
        .with_conn_mut(crate::narrative_extraction::inspect_workspace_cutover_readiness)?;
    assert!(!workspace.ready);
    // A Graph Edge cannot be duplicated: the UNIQUE constraint refuses it.
    let duplicate = fixture.db().with_conn(|conn| {
        Ok(conn
            .execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at)
                 SELECT 'gdv1-duplicate-edge', project_id, consumer_kind, consumer_key,
                        source_object_identity, read_set_json, created_at
                   FROM narrative_dependency_edges
                  WHERE project_id=?1 AND consumer_kind='semantic-index' LIMIT 1",
                [PROJECT],
            )
            .map_err(|error| error.to_string()))
    })?;
    assert!(duplicate.is_err(), "duplicate Graph Edges are refused by the database");

    // Control: no binding, the field is empty and not serialized; the seal and
    // the gate behave as before GDV/1.
    let fixture = Fixture::new()?;
    drain_durable_chain(&fixture)?;
    let (run_id, epoch, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(outcome["report"].get("consumersExcludedNotCurrent").is_none());
    assert!(seal_message(&fixture, &run_id, &epoch)?.is_ok());
    assert_eq!(project_readiness(&fixture)?.verify.state, ReadinessState::Passed);
    Ok(())
}

/// Section 3.2 invariant (review 4 R-1): a report sealed while the Graph was
/// current (or absent) has an empty field, so the field check passes it; what
/// stops it once the Graph is not current is the S-4 mark's digest mismatch.
#[test]
fn a_report_sealed_before_the_graph_became_not_current_is_stopped_by_the_digest() -> Result<()> {
    let _serial = serial();
    use crate::narrative_extraction::ReadinessState;
    // (i) sealed while the Graph was current.
    let fixture = Fixture::published()?;
    let recorder = Recorder::default();
    run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &work_request(&fixture, AutomaticRunKind::Verify, &["workspace-opened"])?,
        None,
        &recorder,
    )?;
    let (run_id, epoch, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(outcome["report"].get("consumersExcludedNotCurrent").is_none());
    fixture.mark_dirty()?;
    assert_eq!(classify(&fixture)?, C::RecognizedNotCurrent);
    let seal = seal_message(&fixture, &run_id, &epoch)?;
    assert!(
        matches!(&seal, Err(message) if message.contains("NEX_VERIFY_GRAPH_STATE_CHANGED")),
        "{seal:?}"
    );
    let readiness = project_readiness(&fixture)?;
    assert_eq!(readiness.verify.state, ReadinessState::Blocked);
    assert!(
        readiness
            .verify
            .reasons
            .iter()
            .any(|reason| reason.contains("verify-graph-state-invalid")
                && reason.contains("NEX_VERIFY_GRAPH_STATE_CHANGED")),
        "{:?}",
        readiness.verify.reasons
    );
    assert!(!readiness.ready);

    // (ii) sealed while there was no binding (the report the setup chain made).
    let fixture = Fixture::new()?;
    drain_durable_chain(&fixture)?;
    let (run_id, epoch, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(outcome["report"].get("consumersExcludedNotCurrent").is_none());
    assert!(seal_message(&fixture, &run_id, &epoch)?.is_ok(), "before the Graph exists");
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(1));
    fixture.mark_dirty()?;
    assert_eq!(classify(&fixture)?, C::RecognizedNotCurrent);
    let seal = seal_message(&fixture, &run_id, &epoch)?;
    assert!(
        matches!(&seal, Err(message) if message.contains("NEX_VERIFY_GRAPH_STATE_CHANGED")),
        "{seal:?}"
    );
    let readiness = project_readiness(&fixture)?;
    assert!(
        readiness
            .verify
            .reasons
            .iter()
            .any(|reason| reason.contains("NEX_VERIFY_GRAPH_STATE_CHANGED")),
        "{:?}",
        readiness.verify.reasons
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// the cutover loop (T-1 marker-less form, GDV-R9)
// ---------------------------------------------------------------------------

static CUTOVER_GENERATION: AtomicUsize = AtomicUsize::new(5_000);

/// One turn of the product freshness scheduler: incremental cycle, heartbeat,
/// cutover attempt. `Ok` is a written marker; `Err` carries the message.
fn cutover_attempt(fixture: &Fixture) -> Result<std::result::Result<(), String>> {
    use crate::narrative_extraction as ne;
    let (_outcome, cycle) = ne::run_incremental_freshness_cycle_with_liveness_capability(fixture.db())?;
    let generation = CUTOVER_GENERATION.fetch_add(1, Ordering::SeqCst) as u64;
    let evidence = ne::record_live_scheduler_heartbeat(fixture.db(), "gdv1-acceptance", generation, cycle)?;
    Ok(fixture
        .db()
        .with_conn_mut(|conn| ne::cut_over_workspace_freshness(conn, &evidence))
        .map(|_| ())
        .map_err(|error| format!("{error:#}")))
}

/// The native `WakeReason::BeforeCutover` wake: the before-cutover discovery
/// decides the work, then one cycle runs it. `None` when there is no work.
fn before_cutover_wake(
    fixture: &Fixture,
    recorder: &Recorder,
) -> Result<(Option<DesiredWork>, Option<MaintenanceCycleResult>)> {
    before_cutover_wake_with(fixture, None, recorder)
}

fn before_cutover_wake_with(
    fixture: &Fixture,
    seam: Option<&NarrativeMaintenanceCiConfig>,
    recorder: &Recorder,
) -> Result<(Option<DesiredWork>, Option<MaintenanceCycleResult>)> {
    let coordinates =
        crate::narrative_extraction::maintenance_runtime::effective_maintenance_coordinates(seam)?;
    let planned = crate::narrative_extraction::discover_before_cutover_maintenance_work_with_coordinates(
        fixture.db(),
        PROJECT,
        Some(&coordinates),
    )?;
    let Some(work) = planned.clone() else {
        return Ok((None, None));
    };
    let request = MaintenanceCycleRequest {
        work: vec![MaintenanceWorkRequest {
            project_id: work.project_id,
            run_kind: work.run_kind,
            work_key: work.work_key,
            semantic_epoch_id: work.semantic_epoch_id,
            reasons: work.reasons,
        }],
        wake_project_ids: Vec::new(),
        delivery_sequence: None,
        delivery_fingerprint: None,
        workspace_binding: None,
    };
    let result = run_cycle_on(fixture.db(), Some(fixture.runtime()), &request, seam, recorder)?;
    Ok((planned, Some(result)))
}

/// Per round: the Run count change, whether the before-cutover discovery found
/// work, and the cutover attempt's result.
#[derive(Debug)]
struct CutoverRound {
    runs_added: usize,
    before_cutover_found_work: bool,
    attempt: std::result::Result<(), String>,
}

fn cutover_rounds(fixture: &Fixture, rounds: usize) -> Result<Vec<CutoverRound>> {
    let mut observed = Vec::new();
    for _ in 0..rounds {
        let before = run_ledger(fixture.db())?.len();
        let attempt = cutover_attempt(fixture)?;
        let mut found = false;
        if matches!(&attempt, Err(message) if message.contains("NEX_C2ZC_CUTOVER_NOT_READY")) {
            let recorder = Recorder::default();
            found = before_cutover_wake(fixture, &recorder)?.0.is_some();
        }
        let ok = attempt.is_ok();
        observed.push(CutoverRound {
            runs_added: run_ledger(fixture.db())?.len() - before,
            before_cutover_found_work: found,
            attempt,
        });
        if ok {
            break;
        }
    }
    Ok(observed)
}

/// A cutover-less workspace whose Graph is recognized not-current (the motive
/// form without the marker; a gate-open start can publish a Graph before the
/// cutover): the automatic maintenance reaches idle and does not add Runs
/// forever, and only the cutover does not proceed: the readiness Verify gate is
/// the one blocked gate. The control is the same marker-less workspace without a
/// binding, which cuts over.
#[test]
fn a_marker_less_workspace_with_a_not_current_graph_idles_and_does_not_cut_over() -> Result<()> {
    let _serial = serial();
    use crate::narrative_extraction::ReadinessState;
    let fixture = motive(false)?;
    let rounds = cutover_rounds(&fixture, 8)?;
    assert_eq!(rounds.len(), 8, "the cutover never succeeds: {rounds:?}");
    // The first attempt is before any Verify ran in this workspace's chain: the
    // Verify gate sees a report sealed without the Graph (the digest differs,
    // section 3.2 invariant) and the missing rebuild and phase evidence. The
    // before-cutover wake then runs [verify, rebuild, verify]. From the second
    // attempt on, the Verify gate is the only reason, with the (x) reason.
    assert!(
        matches!(&rounds[0].attempt, Err(message)
            if message.contains("NEX_C2ZC_CUTOVER_NOT_READY")
                && message.contains("NEX_VERIFY_GRAPH_STATE_CHANGED")),
        "{rounds:?}"
    );
    assert!(rounds[0].runs_added == 3 && rounds[0].before_cutover_found_work, "{rounds:?}");
    for round in &rounds[1..] {
        assert!(
            matches!(&round.attempt, Err(message)
                if message == "NEX_C2ZC_CUTOVER_NOT_READY: verify:verify-graph-recognized-unavailable"),
            "{rounds:?}"
        );
        // The discovery finds nothing and no Run is added: the Run count does
        // not grow round after round.
        assert_eq!(round.runs_added, 0, "{rounds:?}");
        assert!(!round.before_cutover_found_work, "{rounds:?}");
    }
    assert_eq!(fixture.marker()?, None, "no marker is written");
    assert!(finding_keys(fixture.db())?.is_empty());
    // The Verify gate is the only blocked gate.
    let readiness = project_readiness(&fixture)?;
    assert_eq!(readiness.verify.state, ReadinessState::Blocked);
    assert_eq!(readiness.verify.reasons, vec!["verify-graph-recognized-unavailable".to_string()]);
    assert_eq!(readiness.derived_state_rebuild.state, ReadinessState::Passed);
    assert_eq!(readiness.parity.state, ReadinessState::Passed);
    assert_eq!(readiness.no_active_backfill_or_repair.state, ReadinessState::Passed);
    assert_eq!(readiness.phase_lifecycle.state, ReadinessState::Passed);
    // The skip evidence, discovery and cycle are open: an uncontrolled skip
    // evaluation of the same Verify is a Skip, so the readiness (x) is the
    // single gate that keeps the cutover closed.
    let (_, epoch, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(excluded_graph_edge_count(&outcome["report"]).is_some());
    use crate::narrative_extraction::maintenance_skip_evidence::{
        evaluate_completed_run_skip, CompletedRunSkipExpectation,
    };
    let coordinates = crate::narrative_extraction::maintenance_contracts::current_maintenance_coordinates()?;
    let expectation = CompletedRunSkipExpectation {
        project_id: PROJECT.into(),
        run_kind: "dependency-verify".into(),
        work_key: format!("dependency-verify:{epoch}"),
        semantic_epoch_id: epoch.clone(),
        graph_contract_digest: coordinates.graph_contract_digest.clone(),
        rule_registry_digest: coordinates.rule_registry_digest.clone(),
        producer_generation_set_digest: coordinates.producer_generation_set_digest.clone(),
        rebuild_contract_version: rr::REBUILD_CONTRACT_VERSION.into(),
        run_kind_contract_version: rr::VERIFY_CONTRACT_VERSION.into(),
        report_digest: None,
    };
    let decision = fixture
        .db()
        .with_conn_mut(|conn| evaluate_completed_run_skip(conn, &expectation))?;
    assert!(format!("{decision:?}").starts_with("Skip"), "{decision:?}");

    // The same workspace with the cutover marker: cutover is already done and
    // returns early without reading readiness.
    let done = motive(true)?;
    let rounds = cutover_rounds(&done, 3)?;
    assert!(matches!(rounds.first().map(|round| &round.attempt), Some(Ok(()))), "{rounds:?}");

    // Control: no binding, no marker: the cutover is written.
    let control = Fixture::new_with_marker(false)?;
    drain_durable_chain(&control)?;
    let rounds = cutover_rounds(&control, 8)?;
    assert!(rounds.last().is_some_and(|round| round.attempt.is_ok()), "{rounds:?}");
    assert!(control.marker()?.is_some());
    Ok(())
}

// ---------------------------------------------------------------------------
// GDV-R9: the foreground Verify completion (`complete_foreground_system_work_run`)
// ---------------------------------------------------------------------------

/// Run a foreground Verify under the system-work marker and release it. The
/// release re-checks the outcome against the uncontrolled digest and, for a
/// clean report, seals the skip evidence.
fn foreground_verify_completion(
    fixture: &Fixture,
) -> Result<std::result::Result<serde_json::Value, String>> {
    use crate::narrative_extraction::maintenance_runtime as mr;
    let epoch = fixture.current_epoch()?;
    let marker = mr::NarrativeSystemWorkMarker {
        trigger: "workspace-opened".to_string(),
        canonical_work_key: mr::canonical_work_key_for_epoch(
            PROJECT,
            AutomaticRunKind::Verify,
            &format!("dependency-verify:{epoch}"),
            Some(&epoch),
        )?,
        authority_id: "authority:gdv1-acceptance".to_string(),
        generation: 1,
        product_journey_barrier_id: "barrier-gdv1".to_string(),
        correlation: "correlation-gdv1".to_string(),
    };
    let outcome = match mr::with_system_work_marker(Some(marker.clone()), || {
        rr::run_dependency_verify_for_project(fixture.db(), PROJECT)
    }) {
        Ok(outcome) => outcome,
        Err(error) => return Ok(Err(format!("run: {error:#}"))),
    };
    let barrier = mr::ForegroundSystemWorkRun {
        run_id: outcome.run_id.clone(),
        project_id: PROJECT.to_string(),
        marker,
    };
    if let Err(error) = mr::complete_foreground_system_work_run(fixture.db(), &barrier) {
        return Ok(Err(format!("release: {error:#}")));
    }
    let stored: String = fixture.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT outcome_summary_json FROM narrative_extraction_runs WHERE id = ?1",
            [&outcome.run_id],
            |row| row.get(0),
        )?)
    })?;
    Ok(Ok(serde_json::from_str(&stored)?))
}

/// For a not-current Graph the foreground Verify completes and seals its skip
/// evidence (GDV-R9: the skip-evidence seal is the third place that opens). For
/// a current Graph the release is refused by the uncontrolled digest, as it is
/// before GDV/1 (see the unchanged-behaviour tests).
#[test]
fn foreground_verify_completion_seals_for_a_not_current_graph_only() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let stored = foreground_verify_completion(&fixture)?;
    let stored = stored.map_err(|message| anyhow!("not-current: {message}"))?;
    assert!(excluded_graph_edge_count(&stored["report"]).is_some(), "{stored}");
    assert!(
        stored.get("skipEvidence").is_some(),
        "the clean excluding outcome sealed its skip evidence: {stored}"
    );

    // A current Graph keeps refusing: the foreground Verify cannot complete
    // under the uncontrolled digest, which is unchanged by GDV/1.
    let fixture = Fixture::published()?;
    let refused = foreground_verify_completion(&fixture)?;
    assert!(
        matches!(&refused, Err(message) if message.contains("context-unavailable")),
        "{refused:?}"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// S-5: Rebuild-Derived and its V2 shadow (T-11)
// ---------------------------------------------------------------------------

fn rebuild_completed(fixture: &Fixture) -> Result<bool> {
    Ok(run_ledger(fixture.db())?
        .iter()
        .any(|(kind, status)| kind == "semantic-index-rebuild" && status == "completed"))
}

/// Rebuild-Derived completes in the motive form when another Consumer needs a
/// Rebuild (a missing Edge State), and the chain reaches idle without a failing
/// wake or a Finding: the V2 shadow no longer resolves the Graph's eligibility.
#[test]
fn rebuild_derived_completes_when_another_consumer_needs_a_rebuild() -> Result<()> {
    let _serial = serial();
    let fixture = motive(true)?;
    require_rebuild(&fixture)?;
    let discoveries = product_wakes(&fixture, None, 10)?;
    assert!(discoveries.iter().any(|d| matches!(d, D::Idle)), "{discoveries:?}");
    assert!(rebuild_completed(&fixture)?);
    assert!(finding_keys(fixture.db())?.is_empty());
    Ok(())
}

/// The Semantic Epoch rotated (a restore's new epoch), for the published and the
/// motive form, through the product path and the seam: no failing wake, a clean
/// completed Verify, no Finding and a bounded Run count. With the seam the
/// project keeps waking B and never fails.
#[test]
fn epoch_rotation_does_not_stall_for_a_not_current_graph() -> Result<()> {
    let _serial = serial();
    for overflow in [false, true] {
        for with_seam in [false, true] {
            let fixture = Fixture::published()?;
            if overflow {
                overflow_candidates(&fixture)?;
                let recorder = Recorder::default();
                fixture.dispatch(&recorder)?;
            } else {
                fixture.mark_dirty()?;
            }
            ensure_restore_epochs_for_workspace(
                fixture.db(),
                "restore-image-sha256:b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
            )?;
            let tag = format!("overflow={overflow} seam={with_seam}");
            let seam = graph_seam();
            let mut idle = false;
            for index in 0..8 {
                let recorder = Recorder::default();
                let (discovery, _) = main_wake_cycle_with_discovery(
                    &fixture,
                    with_seam.then_some(&seam),
                    "workspace-opened",
                    &recorder,
                )
                .map_err(|error| anyhow!("{tag} wake#{index}: {error:#}"))?;
                idle |= matches!(discovery, D::Idle);
            }
            // With the seam an idle chain is a wake for B, so only the product
            // path reaches `Idle`.
            assert!(with_seam || idle, "{tag}");
            let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
            let parsed: rr::DependencyGraphVerifyReport =
                serde_json::from_value(outcome["report"].clone())?;
            assert!(parsed.is_clean(), "{tag}: {}", outcome["report"]);
            assert!(finding_keys(fixture.db())?.is_empty(), "{tag}");
            assert!(run_ledger(fixture.db())?.len() <= 12, "{tag}: {:?}", run_ledger(fixture.db())?);
        }
    }
    Ok(())
}

/// The before-cutover forms of Rebuild (a Rebuild not completed yet, and a
/// completed Rebuild whose outcome is no longer current), with and without the
/// marker, through the product's before-cutover discovery: no failing wake, no
/// Finding, and the Run count stops growing.
#[test]
fn before_cutover_rebuild_forms_complete_for_a_not_current_graph() -> Result<()> {
    let _serial = serial();
    for marker in [true, false] {
        let fixture = motive(marker)?;
        let tag = format!("marker={marker}");
        // Form 1: no completed Rebuild: [verify, rebuild, verify] once.
        let mut first_cycle = None;
        for index in 0..5 {
            let recorder = Recorder::default();
            let (work, _) = before_cutover_wake(&fixture, &recorder)
                .map_err(|error| anyhow!("{tag} form 1 wake#{index}: {error:#}"))?;
            if index == 0 {
                assert!(
                    matches!(&work, Some(work) if work.run_kind == AutomaticRunKind::Verify
                        && work.reasons == ["before-cutover"]),
                    "{tag}: {work:?}"
                );
                first_cycle = Some(started_kinds(&recorder));
            } else {
                assert!(work.is_none(), "{tag} wake#{index}");
            }
        }
        assert_eq!(
            first_cycle,
            Some(vec!["verify".to_string(), "rebuild".to_string(), "verify".to_string()]),
            "{tag}"
        );
        assert!(rebuild_completed(&fixture)?, "{tag}");
        assert!(finding_keys(fixture.db())?.is_empty(), "{tag}");
        // Form 2: the completed Rebuild's outcome is no longer current.
        let changed = fixture.db().with_conn(|conn| {
            Ok(conn.execute(
                "UPDATE narrative_extraction_runs
                    SET outcome_summary_json = json_set(outcome_summary_json, '$.failure', json('{\"code\":\"gdv1-acceptance\"}'))
                  WHERE project_id=?1 AND run_kind='semantic-index-rebuild' AND status='completed'",
                [PROJECT],
            )?)
        })?;
        assert_eq!(changed, 1, "{tag}");
        let runs_before = run_ledger(fixture.db())?.len();
        let mut work_kinds = Vec::new();
        for index in 0..4 {
            let recorder = Recorder::default();
            let (work, _) = before_cutover_wake(&fixture, &recorder)
                .map_err(|error| anyhow!("{tag} form 2 wake#{index}: {error:#}"))?;
            work_kinds.push(work.map(|work| work.run_kind));
        }
        assert_eq!(work_kinds[0], Some(AutomaticRunKind::RebuildDerived), "{tag}: {work_kinds:?}");
        assert!(work_kinds[1..].iter().all(Option::is_none), "{tag}: {work_kinds:?}");
        assert_eq!(run_ledger(fixture.db())?.len(), runs_before + 2, "{tag}");
        assert!(finding_keys(fixture.db())?.is_empty(), "{tag}");
    }
    Ok(())
}

/// A RebuildDerived handed over by main while a Rebuild was not completed, with
/// the seam open (case C-2 does not judge in front of it): the chain completes
/// the Rebuild and the Verify, and the Graph is republished once.
#[test]
fn main_rebuild_with_the_seam_completes_and_republishes_the_graph_once() -> Result<()> {
    let _serial = serial();
    let observation = observe_main_rebuild()?;
    assert_eq!(observation.graph_builds, 1);
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    require_rebuild(&fixture)?;
    let seam = graph_seam();
    let recorder = Recorder::default();
    run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &work_request(&fixture, AutomaticRunKind::RebuildDerived, &["workspace-opened"])?,
        Some(&seam),
        &recorder,
    )?;
    assert!(rebuild_completed(&fixture)?);
    assert_eq!(generation(fixture.db())?, Some(2));
    assert_eq!(classify(&fixture)?, C::Current);
    Ok(())
}

/// Section 8 S-5: the V2 shadow summary of a not-current Graph equals that of a
/// database without the Graph head, except for one diagnostics line. For a
/// current Graph the head is not skipped.
#[test]
fn v2_shadow_summary_skips_only_the_not_current_graph_head() -> Result<()> {
    let _serial = serial();
    use crate::narrative_extraction::source_revision::ForegroundValidationControl;
    let summarize = |fixture: &Fixture,
                     drop_graph_head: bool,
                     foreground: bool|
     -> Result<rr::RebuildShadowVerificationSummary> {
        fixture.db().with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            if drop_graph_head {
                tx.execute("PRAGMA foreign_keys=OFF", [])?;
                tx.execute(
                    "DELETE FROM narrative_dependency_declaration_heads
                      WHERE project_id=?1 AND consumer_kind='semantic-index'",
                    [PROJECT],
                )?;
            }
            let mut never = NeverStopGraphWorkControl;
            let mut foreground_control = ForegroundValidationControl;
            let control: &mut dyn GraphWorkControl =
                if foreground { &mut foreground_control } else { &mut never };
            let summary =
                rr::verify_v2_shadow_for_rebuild_in_tx_with_control(&mut tx, PROJECT, "gdv1-acceptance", control);
            tx.rollback()?;
            summary
        })
    };
    const SKIP_CODE: &str = "NEX_V2_SHADOW_REBUILD_RECOGNIZED_UNAVAILABLE:";
    // Not-current (an uncontrolled shadow must not read the eligibility).
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let skipped = summarize(&fixture, false, false)?;
    let without_head = summarize(&fixture, true, false)?;
    let mut stripped = skipped.clone();
    stripped.diagnostics.retain(|line| !line.starts_with(SKIP_CODE));
    assert_eq!(
        skipped.diagnostics.len(),
        stripped.diagnostics.len() + 1,
        "the skip is recorded as exactly one diagnostics line: {:?}",
        skipped.diagnostics
    );
    assert!(skipped
        .diagnostics
        .iter()
        .any(|line| line == &format!("{SKIP_CODE}semantic-index:{INDEX_KEY}")));
    assert_eq!(stripped, without_head);
    // Current: the head is evaluated (it needs the foreground control).
    let fixture = Fixture::published()?;
    let current = summarize(&fixture, false, true)?;
    let current_without_head = summarize(&fixture, true, true)?;
    assert!(!current.diagnostics.iter().any(|line| line.starts_with(SKIP_CODE)));
    assert_eq!(current.active_head_count, current_without_head.active_head_count + 1);
    assert!(current.evaluated_declaration_count > current_without_head.evaluated_declaration_count);
    Ok(())
}

// ---------------------------------------------------------------------------
// incremental Freshness (T-12) and the Finding resolution
// ---------------------------------------------------------------------------

/// Every Graph surface that Freshness could write: the metadata, the consumer
/// Freshness row and the Edge States of the Graph binding.
fn graph_surfaces(fixture: &Fixture) -> Result<Vec<String>> {
    fixture.db().with_conn(|conn| {
        let mut rows = Vec::new();
        rows.push(format!(
            "metadata {:?}",
            conn.query_row(
                "SELECT generation, source_digest, dependency_set_digest, dirty_cache_flag, built_at
                   FROM narrative_semantic_index_metadata WHERE project_id=?1 AND index_key=?2",
                params![PROJECT, INDEX_KEY],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                )),
            )?
        ));
        rows.push(format!(
            "freshness {:?}",
            conn.query_row(
                "SELECT evidence_freshness, build_action, semantic_epoch_id, dependency_set_digest, updated_at
                   FROM narrative_consumer_freshness
                  WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
                params![PROJECT, INDEX_KEY],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                )),
            )?
        ));
        let mut statement = conn.prepare(
            "SELECT s.edge_id, s.evidence_freshness, s.build_action, s.evaluated_at_epoch_id, s.evaluated_at
               FROM narrative_dependency_edge_states s
               JOIN narrative_dependency_edges e ON e.id = s.edge_id
              WHERE e.project_id=?1 AND e.consumer_kind='semantic-index' AND e.consumer_key=?2
              ORDER BY s.edge_id",
        )?;
        let states = statement
            .query_map(params![PROJECT, INDEX_KEY], |row| {
                Ok(format!(
                    "edge-state {} {} {} {} {}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.extend(states);
        Ok(rows)
    })
}

/// The premise of the two tests below: in the motive form (2,065 candidates, one
/// above the B-close bound) a read of the whole-project eligibility Source is a
/// capacity failure. Anything in the incremental cycle that resolved it would
/// make the cycle fail the same way.
fn assert_resolving_the_eligibility_would_fail_for_capacity(fixture: &Fixture) -> Result<()> {
    let error = fixture
        .db()
        .with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            let result =
                crate::narrative_extraction::nir1_entity_relation_index::read_eligibility_source(
                    &mut tx, PROJECT,
                )
                .map(|source| source.digest);
            tx.rollback()?;
            Ok(result)
        })?
        .expect_err("the eligibility Source of the motive form is over the candidate bound");
    assert!(
        format!("{error:#}").contains("candidate-rows"),
        "capacity failure of the candidate rows: {error:#}"
    );
    Ok(())
}

/// Drain the project's incremental Freshness cycles; every cycle must succeed.
fn drain_incremental_freshness(
    fixture: &Fixture,
) -> Result<Vec<crate::narrative_extraction::incremental_freshness::IncrementalFreshnessBatchSummary>>
{
    let mut batches = Vec::new();
    loop {
        match run_incremental_freshness_cycle(fixture.db())? {
            IncrementalFreshnessCycleOutcome::Processed(batch) => {
                batches.push(batch);
                assert!(batches.len() < 64, "the change feed drains");
            }
            _ => return Ok(batches),
        }
    }
}

/// A real Scene edit (a tree-node patch with a change-feed event) in the motive
/// form: the incremental Freshness cycle succeeds. The edit's feed reaches the
/// consumers that read that Scene (here a Proposal Revision) and not the Graph
/// binding (a Scene edit does not select the Graph's Edges at all), so no Graph
/// surface is touched; resolving the eligibility would have been a capacity
/// failure (the premise is asserted), so the cycle not failing is the proof that
/// it did not.
#[test]
fn incremental_freshness_after_a_scene_edit_does_not_resolve_the_eligibility() -> Result<()> {
    let _serial = serial();
    use crate::narrative_extraction::scope_storage_authority_tests::patch;
    let fixture = motive(true)?;
    assert_resolving_the_eligibility_would_fail_for_capacity(&fixture)?;
    let graph_before = graph_surfaces(&fixture)?;
    patch(
        fixture.db(),
        "a3-source",
        "gdv1-edit",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-27T00:00:00.000Z",
    )?;
    let batches = drain_incremental_freshness(&fixture)?;
    assert!(!batches.is_empty(), "the edit produced incremental work");
    // The feed reached a consumer (the Revision that reads the Scene) ...
    let affected = batches
        .iter()
        .flat_map(|batch| batch.v2_shadow.consumers.iter())
        .map(|consumer| consumer.consumer_kind.as_str())
        .collect::<Vec<_>>();
    assert!(affected.contains(&"proposal-revision"), "{affected:?}");
    // ... and not the Graph binding: the Scene's identity is not one of the
    // Graph Edges' sources (they are `codex:`, `codex-relation:` and the
    // project eligibility), so the feed never selects them, and no Graph surface
    // changed. Only a full-Graph event (an epoch reset or a component schema
    // change, not an edit) selects every Edge of the project.
    let graph_sources: Vec<String> = fixture.db().with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT source_object_identity FROM narrative_dependency_edges
              WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
        )?;
        let rows = statement
            .query_map(params![PROJECT, INDEX_KEY], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    })?;
    assert_eq!(graph_sources.len(), 4, "{graph_sources:?}");
    assert!(graph_sources.iter().all(|source| !source.starts_with("project:scene:")));
    assert!(!affected.contains(&"semantic-index"), "{affected:?}");
    assert_eq!(graph_surfaces(&fixture)?, graph_before);
    assert!(is_dirty_registered(&fixture)?, "the binding is still the dirty one");
    // No maintenance-failure Finding (a stalled Verify or Rebuild).
    assert!(
        finding_keys(fixture.db())?
            .iter()
            .all(|key| !key.starts_with("narrative-maintenance-failure:")),
        "{:?}",
        finding_keys(fixture.db())?
    );
    Ok(())
}

/// A `semantic-graph-requires-repair` Finding that the durable discovery
/// projects for a defect Rebuild cannot fix (here an unsupported Consumer with
/// current derived rows, next to a not-current Graph) is resolved by the next
/// clean Verify, which still excludes the not-current Graph. The Finding comes
/// from the product discovery for a non-Graph defect: no Graph-caused Finding is
/// reachable for a sealed binding (the contract's section 2.3).
#[test]
fn a_semantic_graph_requires_repair_finding_is_resolved_by_the_next_clean_verify() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let epoch = fixture.current_epoch()?;
    fixture.db().with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at)
             VALUES ('gdv1-unsupported-edge', ?1, 'unsupported-consumer', 'consumer-1',
                     'project:scene:a3-source', '[]', '2026-01-01T00:00:00.000Z')",
            [PROJECT],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edge_states
                (edge_id, project_id, evidence_freshness, reason_code, build_action,
                 evaluated_at_epoch_id, evaluated_at)
             VALUES ('gdv1-unsupported-edge', ?1, 'unknown', NULL, 'manual', ?2,
                     '2026-01-01T00:00:00.000Z')",
            params![PROJECT, epoch],
        )?;
        let dependency_set_digest =
            crate::narrative_extraction::dependency_edges::consumer_dependency_set_digest(
                conn,
                PROJECT,
                "unsupported-consumer",
                "consumer-1",
            )?;
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                 semantic_epoch_id, dependency_set_digest, updated_at)
             VALUES (?1, 'unsupported-consumer', 'consumer-1', 'unknown', 'manual', ?2, ?3,
                     '2026-01-01T00:00:00.000Z')",
            params![PROJECT, epoch, dependency_set_digest],
        )?;
        Ok(())
    })?;
    product_wakes(&fixture, None, 4)?;
    let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
    assert!(excluded_graph_edge_count(&outcome["report"]).is_some(), "{outcome}");
    let defective: rr::DependencyGraphVerifyReport =
        serde_json::from_value(outcome["report"].clone())?;
    assert!(!defective.is_clean(), "the unrelated defect keeps the report non-clean");
    assert!(!defective.requires_rebuild(), "and it is not one a Rebuild can fix");
    let states = |fixture: &Fixture| -> Result<Vec<String>> {
        fixture.db().with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT lifecycle_state FROM narrative_maintenance_finding_lifecycle
                  WHERE project_id = ?1 AND finding_key LIKE 'narrative-maintenance-failure:%'
                  ORDER BY rowid",
            )?;
            let rows = statement
                .query_map([PROJECT], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        })
    };
    let open = states(&fixture)?;
    assert_eq!(open.len(), 1, "the discovery projects the Finding: {open:?}");
    assert_eq!(open[0], "new", "{open:?}");

    // The defect is fixed: the next Verify is clean (the Graph stays excluded)
    // and resolves the Finding.
    execute(
        &fixture,
        "DELETE FROM narrative_consumer_freshness WHERE consumer_kind='unsupported-consumer';
         DELETE FROM narrative_dependency_edge_states WHERE edge_id='gdv1-unsupported-edge';
         DELETE FROM narrative_dependency_edges WHERE id='gdv1-unsupported-edge'",
    )?;
    product_wakes(&fixture, None, 4)?;
    let (_, _, outcome) = last_verify(&fixture)?.expect("completed Verify");
    let parsed: rr::DependencyGraphVerifyReport = serde_json::from_value(outcome["report"].clone())?;
    assert!(parsed.is_clean(), "{}", outcome["report"]);
    assert!(excluded_graph_edge_count(&outcome["report"]).is_some());
    // The lifecycle is an append-only log: the Finding went new -> resolved.
    assert_eq!(states(&fixture)?, vec!["new".to_string(), "resolved".to_string()]);
    Ok(())
}

/// The same before-cutover Rebuild forms with the B-ROUTE seam open: the cycle
/// never judges the BeforeCutover flow (the binding), so the chain is the same
/// `[verify, rebuild, verify]`, no Graph build starts, and nothing fails.
#[test]
fn before_cutover_rebuild_forms_are_unchanged_with_the_seam_open() -> Result<()> {
    let _serial = serial();
    let seam = graph_seam();
    for marker in [true, false] {
        let fixture = motive(marker)?;
        let tag = format!("marker={marker}");
        let recorder = Recorder::default();
        let (work, _) = before_cutover_wake_with(&fixture, Some(&seam), &recorder)?;
        assert!(
            matches!(&work, Some(work) if work.run_kind == AutomaticRunKind::Verify),
            "{tag}: {work:?}"
        );
        assert_eq!(
            started_kinds(&recorder),
            vec!["verify".to_string(), "rebuild".to_string(), "verify".to_string()],
            "{tag}"
        );
        for index in 0..3 {
            let recorder = Recorder::default();
            let (work, _) = before_cutover_wake_with(&fixture, Some(&seam), &recorder)
                .map_err(|error| anyhow!("{tag} wake#{index}: {error:#}"))?;
            assert!(work.is_none(), "{tag} wake#{index}");
            assert!(started_kinds(&recorder).is_empty(), "{tag} wake#{index}");
        }
        assert!(finding_keys(fixture.db())?.is_empty(), "{tag}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// "残る止まり" (section 5): current by the structure, false by full validation
// ---------------------------------------------------------------------------

/// The stored `source_digest` of the binding and the eligibility digest that a
/// foreground read of the live Source gives now.
fn stored_and_live_source_digest(fixture: &Fixture) -> Result<(String, String)> {
    let stored = match read_binding(fixture)? {
        BindingRead::Registered(binding) => binding.source_digest.clone(),
        other => bail!("not a registered binding: {other:?}"),
    };
    let live = fixture.db().with_conn_mut(|conn| {
        let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
        let digest =
            crate::narrative_extraction::nir1_entity_relation_index::read_eligibility_source(
                &mut tx, PROJECT,
            )?
            .digest;
        tx.rollback()?;
        Ok(digest)
    })?;
    Ok((stored, live))
}

/// The two forms that the contract's section 5 lists and the prototype did not
/// make (the eligibility's Source digest differing from the stored one, and an
/// Edge differing from the Source), with the two it did make (an Edge State that
/// is stale, and one of another epoch): each is `Current` by the structure, is
/// false by full validation (an `Ok(false)`, not a capacity error), is not
/// repaired by B (the hint is `Skip{BindingCurrent}`), is not excluded by
/// Verify (its Graph Edges stay unresolvable: manual), and the cycle and
/// discovery results are the same as the build before GDV/1 (the shapes 22 and
/// 23 in `gdv1_unchanged_behaviour_tests.rs`, and 17 and 18, are compared with
/// values taken on that build).
#[test]
fn current_but_false_forms_stay_manual() -> Result<()> {
    let _serial = serial();
    let (k, p) = (INDEX_KEY, PROJECT);
    let g = format!("project_id='{p}' AND consumer_kind='semantic-index' AND consumer_key='{k}'");
    let shapes = binding_shapes();
    let shape = |prefix: &str| -> String {
        shapes
            .iter()
            .find(|(name, _)| name.starts_with(prefix))
            .map(|(_, sql)| sql.clone())
            .unwrap_or_else(|| panic!("no shape {prefix}"))
    };
    let forms: Vec<(&str, String)> = vec![
        ("17 Edge State stale", shape("17")),
        ("18 Edge State of another epoch", shape("18")),
        (
            "22 Source digest drift",
            "UPDATE narrative_proposal_revisions
                SET payload_json = replace(payload_json, 'nir1-alice', 'nir1-alicx')"
                .to_string(),
        ),
        (
            "23 Edge differs from the Source",
            format!(
                "UPDATE narrative_dependency_edges
                    SET read_set_json='[\"codex:nir1-alice@2099-01-01T00:00:00Z\"]'
                  WHERE {g} AND source_object_identity='codex:nir1-alice'"
            ),
        ),
    ];
    for (name, sql) in forms {
        let fixture = Fixture::published()?;
        execute(&fixture, &sql)?;
        // Not a dirty form: nothing marked the binding.
        assert!(!is_dirty_registered(&fixture)?, "{name}");
        assert_eq!(classify(&fixture)?, C::Current, "{name}");
        assert_eq!(
            fixture
                .db()
                .with_conn_mut(|conn| is_complete_registered(conn, PROJECT, INDEX_KEY))?,
            false,
            "{name}: full validation is false and does not fail"
        );
        assert_eq!(
            format!("{:?}", fixture.judge()?),
            "Skip { reason: BindingCurrent }",
            "{name}: B does not repair it"
        );
        // Which check is false: the Source digest (22) or the Edge (23).
        let (stored, live) = stored_and_live_source_digest(&fixture)?;
        match name {
            "22 Source digest drift" => assert_ne!(stored, live, "{name}"),
            "23 Edge differs from the Source" => assert_eq!(stored, live, "{name}"),
            _ => {}
        }
        // Verify keeps the Graph's Edges unresolvable and excludes nothing:
        // a manual defect, as before GDV/1.
        let report = fixture
            .db()
            .with_conn_mut(|conn| rr::verify_narrative_dependency_graph_for_project(conn, PROJECT))?;
        assert!(report.consumers_excluded_not_current.is_empty(), "{name}");
        assert_eq!(report.edge_ids_with_unresolvable_consumer_scope.len(), 4, "{name}");
        assert!(!report.is_clean(), "{name}");
        assert!(!report.requires_rebuild(), "{name}: not rebuildable");
        assert!(!report.is_incomplete_only(), "{name}: not transient");
    }
    Ok(())
}

/// The shape 21 of the prototype (a raw proposal row that is not a Graph
/// candidate, no dirty mark) is NOT a current-but-false form: it leaves the
/// eligibility's Source alone, so the binding is `Current`, full validation is
/// true, Verify is clean, and nothing is manual. Section 5's list of forms that
/// stay manual does not include it; it was an attempt at the Source digest
/// drift that did not change the Source (the real drift is shape 22).
#[test]
fn a_proposal_row_that_is_not_a_candidate_does_not_change_the_source() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let before = stored_and_live_source_digest(&fixture)?;
    execute(
        &fixture,
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json, current_revision_id, created_at, updated_at)
         SELECT 'gdv1-drift-candidate', proposal_set_id, 'gdv1-drift-candidate', kind, 'unreviewed', '{}',
                current_revision_id, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z'
           FROM narrative_proposals LIMIT 1",
    )?;
    assert!(!is_dirty_registered(&fixture)?);
    assert_eq!(classify(&fixture)?, C::Current);
    let after = stored_and_live_source_digest(&fixture)?;
    assert_eq!(before.0, after.0);
    assert_eq!(after.0, after.1, "the live Source digest is the stored one");
    assert!(complete_registered(fixture.db())?);
    let report = fixture
        .db()
        .with_conn_mut(|conn| rr::verify_narrative_dependency_graph_for_project(conn, PROJECT))?;
    assert!(report.is_clean());
    assert!(report.edge_ids_with_unresolvable_consumer_scope.is_empty());
    Ok(())
}

// ---------------------------------------------------------------------------
// case C-2: a failed judgement does not end the cycle (DR-PUBG-5-16)
// ---------------------------------------------------------------------------

use crate::narrative_extraction::maintenance_runtime::is_graph_judgement_local_failure;
use crate::narrative_extraction::source_revision::{
    validation_terminated, ValidationTerminationReason,
};
use rusqlite::Connection;
use std::cell::Cell;
use std::rc::Rc;

/// A Verify item in front of a dirty Graph binding, with the B-ROUTE seam open,
/// and `failure` raised inside the judgement's read transaction (once). Returns
/// the cycle's result, what started, and how many times the judgement ran.
fn cycle_with_a_failing_judgement(
    failure: impl Fn(&Connection) -> anyhow::Error + 'static,
) -> Result<(Result<MaintenanceCycleResult>, Vec<String>, usize)> {
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let judged = Rc::new(Cell::new(0usize));
    let counter = Rc::clone(&judged);
    let _hook = install_hook(move |stage, conn| {
        if stage == TestStage::BeforeJudgement {
            counter.set(counter.get() + 1);
            if counter.get() == 1 {
                return Err(failure(conn.expect("inside the judgement's transaction")));
            }
        }
        Ok(())
    });
    let recorder = Recorder::default();
    let request = work_request(&fixture, AutomaticRunKind::Verify, &["workspace-opened"])?;
    let result = run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &request,
        Some(&graph_seam()),
        &recorder,
    );
    Ok((result, started_kinds(&recorder), judged.get()))
}

/// A judgement that fails for a reason of its own (a SQL failure, the no-wait
/// connection refused) does not take the cycle with it: the project's Verify
/// still runs (it excludes the not-current Graph), no Graph build is put in
/// front of it, and the cycle is accepted. The Graph is built later, by the
/// cycle's last rediscovery, whose judgement succeeds.
#[test]
fn a_failed_graph_judgement_does_not_end_the_cycle() -> Result<()> {
    let _serial = serial();
    type Failure = Box<dyn Fn(&Connection) -> anyhow::Error>;
    let failures: Vec<(&str, Failure)> = vec![
        (
            "a SQL failure of the judgement's own read",
            Box::new(|conn| {
                conn.execute_batch("SELECT * FROM gdv1_no_such_table")
                    .map_err(anyhow::Error::from)
                    .expect_err("the table does not exist")
            }),
        ),
        (
            "the no-wait maintenance connection refused",
            Box::new(|_| {
                anyhow!(
                    "{}: Graph build judgement could not acquire the maintenance connection without waiting",
                    rr::MAINTENANCE_CONNECTION_PREEMPTED_CODE
                )
            }),
        ),
    ];
    for (name, failure) in failures {
        let (result, started, judged) = cycle_with_a_failing_judgement(failure)?;
        let result = result.unwrap_or_else(|error| panic!("{name}: the cycle failed: {error:#}"));
        assert_eq!(result.status, MaintenanceCycleStatus::Accepted, "{name}");
        // The failing C-2 judgement ran once; the Verify ran first; B was not
        // put in front of it (the same order as the form without case C).
        assert!(judged >= 1, "{name}");
        assert_eq!(started.first().map(String::as_str), Some("verify"), "{name}: {started:?}");
    }
    Ok(())
}

/// What ends the cycle itself is not swallowed: a typed termination of any
/// reason, the attempt's cancellation, a lifecycle stop and a connection cleanup
/// failure all propagate, and nothing (no Verify) started.
#[test]
fn a_graph_judgement_failure_that_ends_the_cycle_still_ends_it() -> Result<()> {
    let _serial = serial();
    type Failure = Box<dyn Fn() -> anyhow::Error>;
    let failures: Vec<(&str, Failure)> = vec![
        ("typed cancelled", Box::new(|| validation_terminated(ValidationTerminationReason::Cancelled, "stop"))),
        ("typed timeout", Box::new(|| validation_terminated(ValidationTerminationReason::TimedOut, "stop"))),
        ("typed closed", Box::new(|| validation_terminated(ValidationTerminationReason::Closed, "stop"))),
        (
            "typed foreground preempted",
            Box::new(|| validation_terminated(ValidationTerminationReason::ForegroundPreempted, "stop")),
        ),
        (
            "attempt cancelled (plain)",
            Box::new(|| anyhow!("NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation requested at a Rust work boundary")),
        ),
        (
            "lifecycle stop (plain)",
            Box::new(|| anyhow!("NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED: transition is draining this execution")),
        ),
        (
            "connection cleanup failed",
            Box::new(|| anyhow!("NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: the connection could not be restored")),
        ),
    ];
    for (name, failure) in failures {
        let (result, started, _) = cycle_with_a_failing_judgement(move |_| failure())?;
        assert!(result.is_err(), "{name}: the cycle must end, got {result:?}");
        assert!(started.is_empty(), "{name}: nothing may start: {started:?}");
    }
    Ok(())
}

/// The allowlist in one table (the shape of DR-PUBG-5-15's allowlist test).
#[test]
fn graph_judgement_local_failure_is_an_allowlist_of_two() {
    let preempted = anyhow!(
        "{}: could not acquire the maintenance connection without waiting",
        rr::MAINTENANCE_CONNECTION_PREEMPTED_CODE
    );
    assert!(is_graph_judgement_local_failure(&preempted));
    assert!(is_graph_judgement_local_failure(&preempted.context("judgement")));
    let sql: anyhow::Error = rusqlite::Error::QueryReturnedNoRows.into();
    assert!(is_graph_judgement_local_failure(&sql));
    assert!(is_graph_judgement_local_failure(&sql.context("read hint")));
    for reason in [
        ValidationTerminationReason::ContextUnavailable,
        ValidationTerminationReason::Cancelled,
        ValidationTerminationReason::TimedOut,
        ValidationTerminationReason::Closed,
        ValidationTerminationReason::WorkspaceGenerationChanged,
        ValidationTerminationReason::ForegroundPreempted,
        ValidationTerminationReason::CleanupFailed,
        ValidationTerminationReason::CapacityExceeded,
    ] {
        let error = validation_terminated(reason, "test");
        assert!(!is_graph_judgement_local_failure(&error), "{reason:?}");
        // A SQL failure underneath a typed termination is still a termination.
        let wrapped = anyhow::Error::from(rusqlite::Error::QueryReturnedNoRows)
            .context(validation_terminated(reason, "wrapped").to_string());
        assert!(
            !is_graph_judgement_local_failure(&wrapped),
            "{reason:?}: the typed text in the chain keeps it a termination"
        );
    }
    for text in [
        "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation requested",
        "NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED: draining",
        "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: x",
        "NIR1_MAINTENANCE_CONNECTION_UNUSABLE: x",
        "NEX_MAINTENANCE_CONNECTION_UNUSABLE: x",
        "NIR1_GRAPH_CAPACITY_EXCEEDED: x",
        "something else entirely",
    ] {
        assert!(!is_graph_judgement_local_failure(&anyhow!("{text}")), "{text}");
    }
    // The preempted code together with a cleanup failure is a cleanup failure.
    let both = anyhow!(
        "{}: x; NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: y",
        rr::MAINTENANCE_CONNECTION_PREEMPTED_CODE
    );
    assert!(!is_graph_judgement_local_failure(&both));
}
