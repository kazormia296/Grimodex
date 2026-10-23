//! CP-3a S2b tests: the response of `related_scenes_graph_continue` and the
//! pieces the click is built from. The full positive path (an eligible
//! Graph-only row, its click) needs a Chronicle index proof, typed Revisions and
//! a declared Scene that only the database crate can build; it is covered there
//! (`related_scenes_requalification` tests) with these Native pieces around it:
//! the composition of the displayed set, the checkpoint, the failure mapping,
//! the wire and the one `null` of every absent Graph-only row.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::*;
use crate::related_scenes::graph_response::{
    classify, compose, requalify_in_workspace, response, row_wire, Assembled, Composition,
    GraphStop, Requalify, RowFields, Stopper, GRAPH_ONLY_DEADLINE, VERIFY_SQL_TIMEOUT,
};
use grimodex_db::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
use grimodex_db::narrative_extraction::scene_body_declaration::{
    clear_scene_body_declaration_workspace_quarantine_for_test,
    quarantine_scene_body_declaration_workspace_for_test, SCENE_BODY_READ_MAX_BYTES,
    SCENE_BODY_TITLE_MAX_BYTES,
};
use grimodex_db::narrative_extraction::{
    validation_terminated, AppendSlot, GraphOnlySceneDisclosure, GraphPathAttachment,
    GraphPathEdge, GraphPathEntity, GraphPathEvidence, NotAppended, QualifiedGraphForRelatedScenes,
    ValidationTerminationReason,
};

const INDEX_KEY: &str = grimodex_core::narrative_nir1::ENTITY_RELATION_INDEX_KEY;
const GENERATION: i64 = 7;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn ir_response(scene_ids: &[&str]) -> Value {
    json!({
        "status": "available",
        "queryBinding": "related-scenes-query:test",
        "scenes": scene_ids.iter().map(|id| json!({"sceneId": id, "irCosine": 0.5})).collect::<Vec<_>>(),
    })
}

fn composition(displayed: &[&str], ir_uses_common_slot: bool, raw_count: usize) -> Composition {
    Composition {
        displayed: displayed.iter().map(|id| (*id).to_owned()).collect(),
        slot: AppendSlot {
            ir_uses_common_slot,
            raw_count,
        },
    }
}

// ---- the displayed set and the common extra slot (DR-CP3A-23) --------------

#[test]
fn the_displayed_set_is_raw_plus_the_first_ir_scene_raw_does_not_hold() {
    // Raw R has room: the IR's first Scene that R does not hold is shown.
    assert_eq!(
        compose(&ir_response(&["a", "x", "y"]), &strings(&["a", "b"]), 8),
        Some(composition(&["a", "b", "x"], true, 2))
    );
    // R already holds every IR Scene: the IR adds nothing and the slot is free.
    assert_eq!(
        compose(&ir_response(&["a", "b"]), &strings(&["a", "b"]), 8),
        Some(composition(&["a", "b"], false, 2))
    );
    // An empty IR leaves the slot free; an empty R is allowed.
    assert_eq!(
        compose(&ir_response(&[]), &strings(&["a"]), 8),
        Some(composition(&["a"], false, 1))
    );
    assert_eq!(
        compose(&ir_response(&["x"]), &[], 8),
        Some(composition(&["x"], true, 0))
    );
    // The IR's order decides, not its position in R.
    assert_eq!(
        compose(&ir_response(&["b", "z", "x"]), &strings(&["b"]), 8),
        Some(composition(&["b", "z"], true, 1))
    );
}

#[test]
fn a_full_raw_has_no_ir_scene_and_no_free_slot() {
    let eight = strings(&["a", "b", "c", "d", "e", "f", "g", "h"]);
    // Eight Raw items: the IR Scene is not shown and the slot is closed by the
    // count alone (`ir_uses_common_slot` stays false).
    let full = compose(&ir_response(&["x"]), &eight, 8).unwrap();
    assert_eq!(full.displayed.len(), 8);
    assert!(!full.slot.ir_uses_common_slot);
    assert_eq!(full.slot.raw_count, 8);
    // Seven Raw items still take the IR Scene.
    let seven = compose(&ir_response(&["x"]), &eight[..7], 8).unwrap();
    assert_eq!(seven.displayed.len(), 8);
    assert!(seven.slot.ir_uses_common_slot);
}

#[test]
fn an_ir_response_that_is_not_available_or_not_readable_composes_nothing() {
    assert_eq!(
        compose(
            &json!({"status": "unavailable", "reason": "failed"}),
            &[],
            8
        ),
        None
    );
    assert_eq!(compose(&json!({"status": "available"}), &[], 8), None);
    assert_eq!(
        compose(
            &json!({"status": "available", "scenes": [{"sceneId": 3}]}),
            &[],
            8
        ),
        None
    );
}

#[test]
fn the_fusion_limit_the_composition_uses_is_the_policys() {
    assert_eq!(ranking_policy::fusion_limits().unwrap().0, 8);
}

// ---- the failure mapping (DR-CP3A-27) -------------------------------------

#[test]
fn an_error_of_the_requalification_maps_to_one_closed_reason() {
    let stop = |reason| anyhow::Error::new(GraphStop(reason));
    assert_eq!(
        classify(&stop(GraphUnavailable::Cancelled)),
        GraphUnavailable::Cancelled
    );
    assert_eq!(
        classify(&stop(GraphUnavailable::Invalidated).context("while reading")),
        GraphUnavailable::Invalidated
    );
    let terminated = |reason| validation_terminated(reason, "TEST");
    for (reason, expected) in [
        (
            ValidationTerminationReason::TimedOut,
            GraphUnavailable::Timeout,
        ),
        (
            ValidationTerminationReason::Cancelled,
            GraphUnavailable::Cancelled,
        ),
        (
            ValidationTerminationReason::CapacityExceeded,
            GraphUnavailable::Limit,
        ),
        (
            ValidationTerminationReason::Closed,
            GraphUnavailable::Invalidated,
        ),
        (
            ValidationTerminationReason::WorkspaceGenerationChanged,
            GraphUnavailable::Invalidated,
        ),
    ] {
        assert_eq!(classify(&terminated(reason)), expected);
    }
    // Storage and everything else is a failure of the whole Graph, with the
    // same reason whatever it was about: it can not name a candidate.
    assert_eq!(classify(&anyhow!("SQLITE_IOERR")), GraphUnavailable::Failed);
}

#[test]
fn the_graph_only_deadline_stays_inside_the_transaction_deadline() {
    assert!(GRAPH_ONLY_DEADLINE < VERIFY_SQL_TIMEOUT);
    assert_eq!(VERIFY_SQL_TIMEOUT, Duration::from_secs(2));
    assert_eq!(GRAPH_ONLY_DEADLINE, Duration::from_millis(500));
}

// ---- the wire (DR-CP3A-24) -------------------------------------------------

fn path_edge() -> GraphPathEdge {
    GraphPathEdge {
        edge_id: "edge-1".into(),
        relation_type: "knows".into(),
        directionality: "directed".into(),
        from: GraphPathEntity {
            entity_id: "e-from".into(),
            label: "Alice".into(),
        },
        to: GraphPathEntity {
            entity_id: "e-to".into(),
            label: "Bob".into(),
        },
        evidence: vec![GraphPathEvidence {
            evidence_id: "ev-1".into(),
            quote: "Alice knows Bob".into(),
        }],
    }
}

fn attachment(scene: &str) -> GraphPathAttachment {
    GraphPathAttachment {
        scene_id: scene.into(),
        hop: 1,
        pin_entity_id: "e-to".into(),
        edges: vec![path_edge()],
    }
}

fn qualified(attachments: Vec<GraphPathAttachment>) -> QualifiedGraphForRelatedScenes {
    QualifiedGraphForRelatedScenes {
        attachments,
        graph_only: GraphOnlySceneDisclosure::NotAppended(NotAppended),
        graph_only_row: None,
    }
}

fn wire_of(assembled: Assembled) -> Value {
    match assembled {
        Assembled::Available { wire, click } => {
            assert!(click.is_none(), "no row, no click entry");
            wire
        }
        Assembled::Unavailable(reason) => panic!("unavailable: {}", reason.as_str()),
    }
}

#[test]
fn the_available_response_has_exactly_the_documented_keys() {
    let wire = wire_of(response("binding-1", qualified(vec![attachment("s-1")])));
    assert_eq!(
        wire,
        json!({
            "status": "available",
            "queryBinding": "binding-1",
            "pathAttachments": [{
                "sceneId": "s-1",
                "hop": 1,
                "edges": [{
                    "relationType": "knows",
                    "directionality": "directed",
                    "from": {"entityId": "e-from", "label": "Alice"},
                    "to": {"entityId": "e-to", "label": "Bob"},
                    "evidence": [{"evidenceId": "ev-1", "quote": "Alice knows Bob"}],
                }],
            }],
            "graphOnly": null,
        })
    );
    // No token, digest, revision or edge ID of the material is on the wire.
    let text = wire.to_string();
    for forbidden in ["edge-1", "Digest", "digest", "token", "revision"] {
        assert!(!text.contains(forbidden), "{forbidden} in {text}");
    }
}

#[test]
fn the_graph_only_row_has_exactly_the_documented_keys_and_nothing_else() {
    let path = attachment("s-9");
    let wire = row_wire(
        &RowFields {
            scene_id: "s-9",
            title: "A declared Scene",
            excerpt: "The first line.",
            start_utf16: 3,
            end_utf16: 18,
            path: &path,
        },
        "related-scenes-graph-scene:handle",
    )
    .unwrap();
    assert_eq!(
        wire,
        json!({
            "sceneId": "s-9",
            "sceneTitle": "A declared Scene",
            "excerpt": "The first line.",
            "canonicalRange": {"start": 3, "end": 18},
            "navigationIdentity": "related-scenes-graph-scene:handle",
            "path": {
                "hop": 1,
                "pinEntityId": "e-to",
                "edges": [{
                    "relationType": "knows",
                    "directionality": "directed",
                    "from": {"entityId": "e-from", "label": "Alice"},
                    "to": {"entityId": "e-to", "label": "Bob"},
                    "evidence": [{"evidenceId": "ev-1", "quote": "Alice knows Bob"}],
                }],
            },
        })
    );
}

#[test]
fn the_graph_only_row_is_bounded_and_belongs_to_its_path() {
    let path = attachment("s-9");
    let fields = |title: &str, excerpt: &str, scene: &str| {
        row_wire(
            &RowFields {
                scene_id: scene,
                title,
                excerpt,
                start_utf16: 0,
                end_utf16: 1,
                path: &path,
            },
            "handle",
        )
    };
    let title = |bytes: usize| "t".repeat(bytes);
    // The limits the declaration and the body read already keep: at the limit
    // the row is made, one byte over it is not.
    assert!(fields(&title(SCENE_BODY_TITLE_MAX_BYTES), "x", "s-9").is_some());
    assert!(fields(&title(SCENE_BODY_TITLE_MAX_BYTES + 1), "x", "s-9").is_none());
    assert!(fields("t", &title(SCENE_BODY_READ_MAX_BYTES), "s-9").is_some());
    assert!(fields("t", &title(SCENE_BODY_READ_MAX_BYTES + 1), "s-9").is_none());
    // A path for another Scene is not this row's path.
    assert!(fields("t", "x", "s-other").is_none());
}

// ---- the requalification in a workspace (DR-CP3A-22, N-8, N-10) ------------

impl Fixture {
    fn database(&self) -> grimodex_db::state::PinnedWorkspaceDb {
        grimodex_db::state::active_database(&self.state.ws).expect("active database")
    }

    /// The world the requalification reads: the seed Entity pinned to the query
    /// Scene, and B sealed at `GENERATION`.
    fn seed_world(&self) {
        self.database()
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES ('s2b-epoch', ?1, 0, 'initial', '2026-10-23T00:00:00Z')",
                    [PROJECT],
                )?;
                conn.execute(
                    &format!(
                        "INSERT INTO narrative_semantic_index_metadata
                            (project_id, index_key, generation, built_at, source_digest,
                             dependency_set_digest, dirty_cache_flag)
                         VALUES (?1, ?2, {GENERATION}, '2026-10-23T00:00:00Z',
                                 'sha256:s2b-source', 'sha256:s2b-dependency', 0)"
                    ),
                    [PROJECT, INDEX_KEY],
                )?;
                conn.execute(
                    "INSERT INTO narrative_consumer_freshness
                        (project_id, consumer_kind, consumer_key, evidence_freshness,
                         build_action, semantic_epoch_id, updated_at)
                     VALUES (?1, 'semantic-index', ?2, 'fresh', 'none', 's2b-epoch',
                             '2026-10-23T00:00:00Z')",
                    [PROJECT, INDEX_KEY],
                )?;
                conn.execute(
                    "INSERT INTO codex_entries(id, project_id, type, name, summary, updated_at)
                     VALUES (?1, ?2, 'character', 'Seed', 'Seed.', '2026-10-23T00:00:00Z')",
                    [SEED, PROJECT],
                )?;
                conn.execute(
                    "INSERT INTO scene_codex_pins(scene_id, entry_id, created_at)
                     VALUES (?1, ?2, '2026-10-23T00:00:00Z')",
                    [SCENE, SEED],
                )?;
                Ok(())
            })
            .expect("seed world");
    }

    fn execute(&self, sql: &str) {
        self.database()
            .db()
            .with_conn(|conn| {
                conn.execute_batch(sql)?;
                Ok(())
            })
            .expect("statement");
    }

    fn workspace(&self) -> grimodex_db::state::ActiveWorkspaceSnapshot {
        grimodex_db::state::active_workspace_snapshot(&self.state.ws).expect("workspace snapshot")
    }
}

fn empty_projection(generation: i64, seed: &str) -> Nir1GraphProjection {
    Nir1GraphProjection {
        project_id: PROJECT.into(),
        query_scene_id: SCENE.into(),
        scope_revision: None,
        graph: grimodex_db::narrative_extraction::nir1_graph::Nir1QualifiedGraph {
            seed_entity_id: seed.into(),
            generation,
            nodes: Vec::new(),
            edges: Vec::new(),
            scene_total: 0,
            scenes: Vec::new(),
        },
        elapsed: Duration::ZERO,
    }
}

struct Never;

impl Stopper for Never {
    fn check(&mut self) -> Result<()> {
        Ok(())
    }
}

fn run(
    fixture: &Fixture,
    projection: &Nir1GraphProjection,
    composition: &Composition,
    checkpoint: &mut dyn Stopper,
) -> Result<Assembled> {
    requalify_in_workspace(
        &fixture.workspace(),
        &Requalify {
            project_id: PROJECT,
            query_scene_id: SCENE,
            projection,
            composition,
            query_binding: "related-scenes-query:test",
        },
        checkpoint,
    )
}

fn unavailable_reason(assembled: Assembled) -> GraphUnavailable {
    match assembled {
        Assembled::Unavailable(reason) => reason,
        Assembled::Available { .. } => panic!("the Graph was expected to be unavailable"),
    }
}

#[test]
fn a_current_empty_graph_answers_available_with_no_paths_and_a_null_graph_only_row() {
    let fixture = Fixture::new();
    fixture.seed_world();
    let wire = wire_of(
        run(
            &fixture,
            &empty_projection(GENERATION, SEED),
            &composition(&["a"], false, 1),
            &mut Never,
        )
        .unwrap(),
    );
    assert_eq!(
        wire,
        json!({
            "status": "available",
            "queryBinding": "related-scenes-query:test",
            "pathAttachments": [],
            "graphOnly": null,
        })
    );
}

#[test]
fn every_reason_the_graph_only_row_is_absent_gives_the_same_bytes() {
    // N-8 (Mandatory defense 9): no candidate, a closed slot (the IR's Scene,
    // eight Raw items) and a workspace quarantined after the read answer with
    // byte-identical responses. Nothing in the bytes says which.
    let fixture = Fixture::new();
    fixture.seed_world();
    let projection = empty_projection(GENERATION, SEED);
    let bytes = |composition: &Composition| {
        wire_of(run(&fixture, &projection, composition, &mut Never).unwrap()).to_string()
    };
    let no_candidate = bytes(&composition(&["a"], false, 1));
    let ir_took_the_slot = bytes(&composition(&["a"], true, 1));
    let raw_is_full = bytes(&composition(&["a"], false, 8));
    quarantine_scene_body_declaration_workspace_for_test(&fixture.workspace());
    let quarantined = bytes(&composition(&["a"], false, 1));
    clear_scene_body_declaration_workspace_quarantine_for_test(&fixture.workspace());
    for other in [&ir_took_the_slot, &raw_is_full, &quarantined] {
        assert_eq!(&no_candidate, other);
    }
}

#[test]
fn a_seed_or_seal_that_changed_makes_the_whole_graph_invalidated() {
    let composition = composition(&["a"], false, 1);
    // The Graph was asked for another seed than the rule gives now.
    let fixture = Fixture::new();
    fixture.seed_world();
    assert_eq!(
        unavailable_reason(
            run(
                &fixture,
                &empty_projection(GENERATION, "another-seed"),
                &composition,
                &mut Never
            )
            .unwrap()
        ),
        GraphUnavailable::Invalidated
    );
    // B was rebuilt after the worker answered.
    assert_eq!(
        unavailable_reason(
            run(
                &fixture,
                &empty_projection(GENERATION + 1, SEED),
                &composition,
                &mut Never
            )
            .unwrap()
        ),
        GraphUnavailable::Invalidated
    );
    // The seed's pin is gone.
    fixture.execute("DELETE FROM scene_codex_pins;");
    assert_eq!(
        unavailable_reason(
            run(
                &fixture,
                &empty_projection(GENERATION, SEED),
                &composition,
                &mut Never
            )
            .unwrap()
        ),
        GraphUnavailable::Invalidated
    );
    // B has no seal at all.
    let fixture = Fixture::new();
    assert_eq!(
        unavailable_reason(
            run(
                &fixture,
                &empty_projection(GENERATION, SEED),
                &composition,
                &mut Never
            )
            .unwrap()
        ),
        GraphUnavailable::Invalidated
    );
}

#[test]
fn a_graph_made_for_another_scene_is_dropped_before_anything_is_read() {
    let fixture = Fixture::new();
    fixture.seed_world();
    let mut projection = empty_projection(GENERATION, SEED);
    projection.query_scene_id = "another-scene".into();
    assert_eq!(
        unavailable_reason(
            run(
                &fixture,
                &projection,
                &composition(&["a"], false, 1),
                &mut Never
            )
            .unwrap()
        ),
        GraphUnavailable::Invalidated
    );
}

struct StopAfter {
    calls: usize,
    after: usize,
    reason: GraphUnavailable,
}

impl Stopper for StopAfter {
    fn check(&mut self) -> Result<()> {
        self.calls += 1;
        if self.calls > self.after {
            Err(anyhow::Error::new(GraphStop(self.reason)))
        } else {
            Ok(())
        }
    }
}

#[test]
fn a_stop_from_the_checkpoint_is_an_error_with_its_own_reason_not_a_graph_state() {
    let fixture = Fixture::new();
    fixture.seed_world();
    for (reason, after) in [
        (GraphUnavailable::Cancelled, 0),
        (GraphUnavailable::Invalidated, 1),
        (GraphUnavailable::Cancelled, 2),
    ] {
        let mut stop = StopAfter {
            calls: 0,
            after,
            reason,
        };
        let error = match run(
            &fixture,
            &empty_projection(GENERATION, SEED),
            &composition(&["a"], false, 1),
            &mut stop,
        ) {
            Err(error) => error,
            Ok(_) => panic!("a real stop must not produce a response"),
        };
        assert_eq!(classify(&error), reason, "after {after} calls");
    }
}

#[test]
fn the_graph_only_text_has_no_path_to_the_request_packing_or_evaluation_outputs() {
    // Mandatory defense 2 (N-9, structural). A Graph-only title or excerpt can
    // only be held by `graph_response` and the operation's slot; none of the
    // modules that build the AI request, pack context, keep history, write
    // audit or export evaluation output names either of them. (The positive
    // content check needs an eligible row, which only the database crate can
    // build; its types print nothing: `the_output_types_print_without_their_
    // contents` there.)
    for (name, source) in [
        (
            "nir1_prepared_request.rs",
            include_str!("../nir1_prepared_request.rs"),
        ),
        ("nir1_generation.rs", include_str!("../nir1_generation.rs")),
        (
            "nir1_graph_dfinal.rs",
            include_str!("../nir1_graph_dfinal.rs"),
        ),
        (
            "nir1_local_attempt.rs",
            include_str!("../nir1_local_attempt.rs"),
        ),
        (
            "nir1_local_send_policy.rs",
            include_str!("../nir1_local_send_policy.rs"),
        ),
        (
            "nir1_local_transport.rs",
            include_str!("../nir1_local_transport.rs"),
        ),
        ("profile_egress.rs", include_str!("../profile_egress.rs")),
    ] {
        for needle in [
            "graph_response",
            "related_scenes::graph",
            "ClickEntry",
            "GraphOnlyRow",
        ] {
            assert!(!source.contains(needle), "{name} names {needle}");
        }
    }
}

/// R-3 of the TASK: the Native side of one requalification (a workspace
/// snapshot, a participant read, the seed and the seal read again), for the
/// record in DR-CP3A-29. An empty Graph: the database crate's
/// `measure_requalification_time` measures the paths and the row. Run with
/// `--nocapture`.
#[test]
fn measure_the_native_requalification_overhead() {
    let fixture = Fixture::new();
    fixture.seed_world();
    let projection = empty_projection(GENERATION, SEED);
    let composition = composition(&["a"], false, 1);
    let mut times = Vec::new();
    for _ in 0..21 {
        let started = Instant::now();
        wire_of(run(&fixture, &projection, &composition, &mut Never).unwrap());
        times.push(started.elapsed());
    }
    times.sort();
    println!(
        "MEASURE native requalification overhead (empty Graph): median {:?}, max {:?}",
        times[10], times[20]
    );
    assert!(times[20] < Duration::from_secs(2));
}
