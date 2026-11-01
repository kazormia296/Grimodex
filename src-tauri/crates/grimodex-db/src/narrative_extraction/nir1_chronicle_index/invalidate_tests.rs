//! X1-5 acceptance for the Freshness path of `scope-storage-authority` /3
//! (Delta 8 (g), tests 18-15 to 18-20): the hook dirties the Chronicle IR
//! Index alone only for a Revision proved, in the same transaction, to be on
//! the closed list of known non-Graph Revisions; every Graph roster candidate,
//! every kind off the list and every row that cannot be read dirties both.

use rusqlite::{params, Connection};

use super::invalidate::{
    before_consumer_state_write, classify_current_revision_in_tx, suspend_current_revision_in_tx,
    CurrentRevisionIndexInput, KNOWN_NON_GRAPH_REVISION_KINDS,
};
use super::test_support::Fixture;
use super::{publish_chronicle_index_build, INDEX_KEY as CHRONICLE_INDEX_KEY};
use crate::narrative_extraction::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH as TYPED_SURFACE,
    NIR1_ENTITY_RELATION_SET_KIND as TYPED_SET,
};
use crate::narrative_extraction::nir1_entity_relation_index::{
    self, roster_candidate_page_sql, roster_candidate_predicate_sql, INDEX_KEY as GRAPH_INDEX_KEY,
};
use crate::narrative_extraction::repository::{
    CHRONICLE_EXTRACT_SURFACE_PATH as IR_SURFACE, CHRONICLE_PROPOSAL_SET_KIND as IR_SET,
};
use CurrentRevisionIndexInput::{ChronicleAndGraph, ChronicleOnly, NotCurrent};

const PROJECT: &str = "default-project";
const NOW: &str = "2026-11-01T00:00:00.000Z";

/// A Run's surface: a value, or no Run row at all.
#[derive(Clone, Copy, Debug)]
enum Surface {
    Path(&'static str),
    NoRun,
}

fn memory() -> crate::Database {
    let db = crate::test_support::fresh_migrated_memory().expect("database");
    db.with_conn(|conn| {
        conn.execute("INSERT INTO projects (id, title, language, created_at, updated_at) VALUES ('other-project', 'Other', 'ja', ?1, ?1)", [NOW])?;
        for key in [CHRONICLE_INDEX_KEY, GRAPH_INDEX_KEY] {
            conn.execute(
                "INSERT INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES (?1, ?2, 1, ?3, 'source', 'deps', 0)",
                params![PROJECT, key, NOW],
            )?;
        }
        Ok(())
    })
    .expect("index rows");
    db
}

/// A proposal whose set has `set_kind` and whose Run has `surface`, with
/// `revision` current. Direct SQL: these shapes are not all reachable through
/// the writers (the generic writer refuses the typed set kind).
fn proposal(
    conn: &Connection,
    project: &str,
    id: &str,
    set_kind: rusqlite::types::Value,
    surface: Surface,
    status: &str,
    revision: &str,
) -> rusqlite::Result<()> {
    let run = format!("{id}-run");
    if let Surface::Path(path) = surface {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at)
             VALUES (?1, ?2, ?3, '{}', '{}', 'spec', 'completed', ?4)",
            params![run, project, path, NOW],
        )?;
    }
    conn.execute(
        "INSERT INTO narrative_proposal_sets (id, run_id, project_id, set_kind, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![format!("{id}-set"), run, project, set_kind, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json, current_revision_id,
             created_at, updated_at)
         VALUES (?1, ?2, ?1, 'x15', ?3, '{}', ?4, ?5, ?5)",
        params![id, format!("{id}-set"), status, revision, NOW],
    )?;
    Ok(())
}

fn text(value: &str) -> rusqlite::types::Value {
    rusqlite::types::Value::Text(value.to_owned())
}

fn flags(conn: &Connection) -> (i64, i64) {
    let read = |key: &str| -> i64 {
        conn.query_row(
            "SELECT dirty_cache_flag FROM narrative_semantic_index_metadata
              WHERE project_id = ?1 AND index_key = ?2",
            params![PROJECT, key],
            |row| row.get(0),
        )
        .expect("flag")
    };
    (read(CHRONICLE_INDEX_KEY), read(GRAPH_INDEX_KEY))
}

fn reset(conn: &Connection) {
    conn.execute(
        "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 0 WHERE project_id = ?1",
        [PROJECT],
    )
    .expect("reset");
}

/// The hook's effect for `revision`: (Chronicle dirty, Graph dirty).
fn hook_effect(conn: &Connection, revision: &str) -> (i64, i64) {
    reset(conn);
    suspend_current_revision_in_tx(conn, PROJECT, "proposal-revision", revision).expect("hook");
    let effect = flags(conn);
    reset(conn);
    effect
}

fn expected_effect(class: CurrentRevisionIndexInput) -> (i64, i64) {
    match class {
        NotCurrent => (0, 0),
        ChronicleOnly => (1, 0),
        ChronicleAndGraph => (1, 1),
    }
}

/// A case: its name, its proposals' (set kind, Run surface), its class.
type Case = (
    &'static str,
    Vec<(rusqlite::types::Value, Surface)>,
    CurrentRevisionIndexInput,
);

/// 18-17, 18-18 and 18-19. Each row shape and its classification, through
/// the classification and through the hook.
#[test]
fn x15_freshness_classification_is_a_closed_list_of_known_non_graph_revisions() {
    let db = memory();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let cases: Vec<Case> = vec![
            ("typed-both", vec![(text(TYPED_SET), Surface::Path(TYPED_SURFACE))], ChronicleAndGraph),
            ("typed-set-only", vec![(text(TYPED_SET), Surface::Path("other.surface"))], ChronicleAndGraph),
            ("typed-surface-only", vec![(text("other.kind@1"), Surface::Path(TYPED_SURFACE))], ChronicleAndGraph),
            ("typed-set-ir-surface", vec![(text(TYPED_SET), Surface::Path(IR_SURFACE))], ChronicleAndGraph),
            ("typed-set-no-run", vec![(text(TYPED_SET), Surface::NoRun)], ChronicleAndGraph),
            ("ir", vec![(text(IR_SET), Surface::Path(IR_SURFACE))], ChronicleOnly),
            ("ir-set-other-surface", vec![(text(IR_SET), Surface::Path("other.surface"))], ChronicleAndGraph),
            ("other-set-ir-surface", vec![(text("other.kind@1"), Surface::Path(IR_SURFACE))], ChronicleAndGraph),
            ("unknown", vec![(text("future.kind@1"), Surface::Path("future.surface"))], ChronicleAndGraph),
            ("generic", vec![(text("generic.proposals@1"), Surface::Path("generic"))], ChronicleAndGraph),
            ("ir-no-run", vec![(text(IR_SET), Surface::NoRun)], ChronicleAndGraph),
            ("empty-set", vec![(text(""), Surface::Path(IR_SURFACE))], ChronicleAndGraph),
            ("empty-surface", vec![(text(IR_SET), Surface::Path(""))], ChronicleAndGraph),
            ("non-text-set", vec![(rusqlite::types::Value::Integer(1), Surface::Path(IR_SURFACE))], ChronicleAndGraph),
            ("ir-twice", vec![(text(IR_SET), Surface::Path(IR_SURFACE)), (text(IR_SET), Surface::Path(IR_SURFACE))], ChronicleOnly),
            ("ir-and-typed", vec![(text(IR_SET), Surface::Path(IR_SURFACE)), (text(TYPED_SET), Surface::Path(TYPED_SURFACE))], ChronicleAndGraph),
            ("ir-and-unknown", vec![(text(IR_SET), Surface::Path(IR_SURFACE)), (text("future.kind@1"), Surface::Path("future.surface"))], ChronicleAndGraph),
            ("ir-and-no-run", vec![(text(IR_SET), Surface::Path(IR_SURFACE)), (text(IR_SET), Surface::NoRun)], ChronicleAndGraph),
        ];
        for (name, rows, _) in &cases {
            for (index, (set_kind, surface)) in rows.iter().enumerate() {
                proposal(&tx, PROJECT, &format!("{name}-{index}"), set_kind.clone(), *surface, "approved", &format!("rev-{name}"))?;
            }
        }
        // Another project's proposal with the same Revision does not make it
        // current here; a proposal whose set row is missing cannot name a
        // project (it is not current, as before X1-5).
        proposal(&tx, "other-project", "elsewhere", text(TYPED_SET), Surface::Path(TYPED_SURFACE), "approved", "rev-elsewhere")?;
        tx.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, payload_json, current_revision_id, created_at, updated_at)
             VALUES ('orphan', 'missing-set', 'orphan', 'x15', '{}', 'rev-orphan', ?1, ?1)",
            [NOW],
        )?;
        for (name, _, class) in &cases {
            let revision = format!("rev-{name}");
            assert_eq!(classify_current_revision_in_tx(&tx, PROJECT, &revision)?, *class, "{name}");
            assert_eq!(hook_effect(&tx, &revision), expected_effect(*class), "{name}");
        }
        for revision in ["rev-none", "rev-elsewhere", "rev-orphan"] {
            assert_eq!(classify_current_revision_in_tx(&tx, PROJECT, revision)?, NotCurrent, "{revision}");
            assert_eq!(hook_effect(&tx, revision), (0, 0), "{revision}");
        }
        // Another consumer kind is not a proposal Revision (as before).
        reset(&tx);
        suspend_current_revision_in_tx(&tx, PROJECT, "semantic-index", "rev-typed-both")?;
        assert_eq!(flags(&tx), (0, 0));
        // The edge-side hooks reach the same judgement.
        before_consumer_state_write(&tx, PROJECT, "proposal-revision", "rev-ir", "fresh", "none", "epoch", Some("run"), Some("digest"))?;
        assert_eq!(flags(&tx), (1, 0), "consumer Freshness of an IR");
        reset(&tx);
        before_consumer_state_write(&tx, PROJECT, "proposal-revision", "rev-typed-set-only", "fresh", "none", "epoch", Some("run"), Some("digest"))?;
        assert_eq!(flags(&tx), (1, 1), "consumer Freshness of a typed Revision");
        tx.rollback()?;
        Ok(())
    })
    .expect("classification");
}

/// 18-16 (the subset property) and 18-19 (the shared predicate). Over every
/// combination of set kind, Run surface (or no Run) and proposal status, the
/// production roster candidate page returns only Revisions the hook dirties
/// both Indexes for, and it returns each typed-both row.
#[test]
fn x15_every_graph_roster_candidate_dirties_both_indexes() {
    let db = memory();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let set_kinds = [TYPED_SET, IR_SET, "future.kind@1", ""];
        let surfaces = [
            Surface::Path(TYPED_SURFACE),
            Surface::Path(IR_SURFACE),
            Surface::Path("future.surface"),
            Surface::Path(""),
            Surface::NoRun,
        ];
        let statuses = ["unreviewed", "approved", "rejected", "superseded"];
        let mut all = Vec::new();
        for (k, set_kind) in set_kinds.iter().enumerate() {
            for (s, surface) in surfaces.iter().enumerate() {
                for (t, status) in statuses.iter().enumerate() {
                    let id = format!("p{k}{s}{t}");
                    let revision = format!("r{k}{s}{t}");
                    proposal(&tx, PROJECT, &id, text(set_kind), *surface, status, &revision)?;
                    all.push((revision, *set_kind, *surface));
                }
            }
        }
        let candidates: Vec<String> = {
            let sql = roster_candidate_page_sql();
            let mut statement = tx.prepare(&sql)?;
            let rows = statement
                .query_map(params![PROJECT, "", 1000], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        assert_eq!(candidates.len(), statuses.len(), "only typed-both rows are candidates");
        for revision in &candidates {
            assert_eq!(classify_current_revision_in_tx(&tx, PROJECT, revision)?, ChronicleAndGraph, "{revision}");
            assert_eq!(hook_effect(&tx, revision), (1, 1), "{revision}");
        }
        for (revision, set_kind, surface) in &all {
            let class = classify_current_revision_in_tx(&tx, PROJECT, revision)?;
            let known = matches!(surface, Surface::Path(path) if *set_kind == IR_SET && *path == IR_SURFACE);
            assert_eq!(class == ChronicleOnly, known, "{revision} {set_kind} {surface:?}");
        }
        tx.rollback()?;
        Ok(())
    })
    .expect("subset property");
}

#[test]
fn x15_the_shared_fragments_carry_only_the_contract_constants() {
    for constant in [TYPED_SET, TYPED_SURFACE, IR_SET, IR_SURFACE] {
        assert!(
            !constant.contains('\'') && !constant.is_empty(),
            "{constant}"
        );
    }
    assert_eq!(KNOWN_NON_GRAPH_REVISION_KINDS, [(IR_SET, IR_SURFACE)]);
    assert_eq!(
        (IR_SET, IR_SURFACE),
        ("chronicle.extract.review@1", "chronicle.extract")
    );
    assert!(roster_candidate_page_sql().contains(&roster_candidate_predicate_sql()));
}

fn index_rows(f: &Fixture) -> ((i64, i64), (i64, i64)) {
    f.db.with_conn(|conn| {
        let read = |key: &str| -> rusqlite::Result<(i64, i64)> {
            conn.query_row(
                "SELECT generation, dirty_cache_flag FROM narrative_semantic_index_metadata
                  WHERE project_id = ?1 AND index_key = ?2",
                params![f.project(), key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        };
        Ok((read(CHRONICLE_INDEX_KEY)?, read(GRAPH_INDEX_KEY)?))
    })
    .expect("index rows")
}

fn ir_publishers(f: &Fixture) -> Vec<(String, Option<String>)> {
    f.db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT freshness.consumer_key, freshness.last_evaluated_run_id
               FROM narrative_consumer_freshness freshness
               JOIN narrative_proposals proposal ON proposal.current_revision_id = freshness.consumer_key
              WHERE freshness.project_id = ?1 AND freshness.consumer_kind = 'proposal-revision'
              ORDER BY freshness.consumer_key",
        )?;
        let rows = statement
            .query_map([f.project()], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .expect("IR publishers")
}

fn publish_graph(f: &Fixture) -> i64 {
    let snapshot =
        f.db.with_read_transaction(|conn| {
            nir1_entity_relation_index::prepare_graph_index_build(conn, &f.runtime, f.project())
        })
        .expect("Graph snapshot");
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let binding = nir1_entity_relation_index::publish_nir1_entity_relation_index_in_tx(
            &tx, &f.runtime, snapshot,
        )?;
        tx.commit()?;
        Ok(binding.generation)
    })
    .expect("Graph publish")
}

fn graph_complete(f: &Fixture) -> bool {
    f.db.with_read_transaction(|conn| {
        nir1_entity_relation_index::is_complete_registered(conn, f.project(), GRAPH_INDEX_KEY)
    })
    .expect("Graph registration")
}

/// Add an approved typed Revision to the product-made workspace through the
/// typed writer and the Human Decision (its anchor Scene and Codex rows are
/// fixture rows, as in the typed-Revision tests).
fn approve_typed_revision_in(f: &Fixture) -> String {
    use crate::narrative_extraction::nir1_entity_relation::tests::{
        approve_typed_revision, request,
    };
    crate::narrative_extraction::narrative_extraction_create_run(
        &f.db,
        crate::narrative_extraction::CreateRunPayload {
            run_id: Some("nir1-run".into()),
            project_id: f.project().to_owned(),
            surface_path_id: TYPED_SURFACE.into(),
            scope_json: serde_json::json!({}),
            spec_json: serde_json::json!({}),
            spec_digest: "spec-nir1".into(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("typed run");
    f.db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('nir1', ?1, 'scene', 'NIR1', '{}', 'z0')",
            [f.project()],
        )?;
        crate::narrative_extraction::ensure_scene_scope_binding_in_tx(conn, f.project(), "nir1", NOW)?;
        conn.execute_batch(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('nir1-alice', 'default-project', 'character', 'Alice', 'Alice', '2026-09-12T00:00:00Z'),
                    ('nir1-bob', 'default-project', 'character', 'Bob', 'Bob', '2026-09-12T00:00:00Z');
             INSERT INTO codex_relations
                (id, project_id, from_codex_id, to_codex_id, relation_type, directionality, version, updated_at)
             VALUES ('nir1-edge', 'default-project', 'nir1-alice', 'nir1-bob', 'knows', 'directed', 1,
                     '2026-09-12T00:00:00Z');",
        )?;
        Ok(())
    })
    .expect("typed fixture rows");
    let created =
        crate::narrative_extraction::nir1_entity_relation::create_nir1_entity_relation_revision(
            &f.db,
            request(&f.db),
        )
        .expect("typed Revision");
    approve_typed_revision(&f.db, "nir1-run", &created).expect("typed approval");
    created["revisionId"].as_str().expect("revision").to_owned()
}

/// 18-15 and 18-20. The product-made workspace (production planner and
/// provider, explicit Human approval; two current Chronicle IR Revisions with
/// edges on Scene S1): B and Chronicle are published; a body save of S1 and
/// the incremental Freshness publish it causes (the IR consumers get a new
/// publisher) dirty Chronicle and leave B clean, at the same generation and
/// complete. Withdrawing an IR approval (a Decision) dirties both as before.
#[test]
fn x15_ir_freshness_after_a_body_save_leaves_the_graph_index_clean() {
    let f = Fixture::new();
    let typed_revision = approve_typed_revision_in(&f);
    let (plan, docs) = f.prepare();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
        .expect("Chronicle publish");
    let generation = publish_graph(&f);
    assert!(graph_complete(&f));
    let roster =
        f.db.with_read_transaction(|conn| {
            nir1_entity_relation_index::read_eligibility_source(conn, f.project())
        })
        .expect("roster");
    assert!(
        roster
            .roster
            .iter()
            .any(|entry| entry.material_kind == "relation"),
        "B holds the approved typed Revision {typed_revision}"
    );
    let before = index_rows(&f);
    assert_eq!(before, ((1, 0), (generation, 0)));
    let ir_revisions: Vec<String> = f.manifest["revisionIds"]
        .as_array()
        .expect("revision ids")
        .iter()
        .map(|id| id.as_str().expect("id").to_owned())
        .collect();
    f.db.with_conn(|conn| {
        for revision in &ir_revisions {
            assert_eq!(
                classify_current_revision_in_tx(conn, f.project(), revision)?,
                ChronicleOnly
            );
        }
        Ok(())
    })
    .expect("the IR is a known non-Graph Revision");
    let publishers_before = ir_publishers(&f);

    let scene = f.manifest["s1"].as_str().expect("S1").to_owned();
    crate::scene_body::save_scene_body_bundle(
        &f.db,
        crate::scene_body::SaveSceneBodyBundlePayload {
            scene_id: scene,
            project_id: f.project().to_owned(),
            request_id: "x15-ir-body-request".to_owned(),
            session_id: "x15-ir-session".to_owned(),
            event_uid: "x15-ir-body-event".to_owned(),
            origin: crate::narrative_extraction::change_feed::NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            timelapse_doc_step_coverage: None,
            include_sidecars: false,
            base_version: None,
            updated_at: "2026-11-01T09:00:00.000Z".to_owned(),
            content_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"edited"}]}]}"#.to_owned(),
            char_count: 6,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_owned(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: Default::default(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 0,
        },
    )
    .expect("body save");
    assert_eq!(
        index_rows(&f),
        ((1, 1), (generation, 0)),
        "the save is body-only"
    );
    f.db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 0
              WHERE project_id = ?1 AND index_key = ?2",
            params![f.project(), CHRONICLE_INDEX_KEY],
        )?;
        Ok(())
    })
    .expect("isolate the Freshness path");
    while matches!(
        crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle(&f.db)
            .expect("incremental Freshness"),
        crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome::Processed(_)
    ) {}
    let publishers_after = ir_publishers(&f);
    assert_ne!(
        publishers_after, publishers_before,
        "the IR consumers got a new publisher"
    );
    assert_eq!(
        index_rows(&f),
        ((1, 1), (generation, 0)),
        "IR Freshness dirties Chronicle alone"
    );
    assert!(graph_complete(&f), "B stays complete");

    // 18-20: G-08's chronicle-index-unusable withdraws an IR approval; the
    // Decision path outside the feed still dirties both.
    let proposal: String =
        f.db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_proposals WHERE current_revision_id = ?1",
                [&ir_revisions[0]],
                |row| row.get(0),
            )?)
        })
        .expect("IR proposal");
    crate::narrative_extraction::narrative_extraction_append_human_decision(
        &f.db,
        crate::narrative_extraction::AppendDecisionPayload {
            run_id: f.manifest["runId"].as_str().expect("run").to_owned(),
            project_id: f.project().to_owned(),
            proposal_id: proposal,
            revision_id: ir_revisions[0].clone(),
            decision: "rejected".to_owned(),
            decision_json: None,
            created_by: Some("x15-reviewer".to_owned()),
        },
    )
    .expect("withdraw the IR approval");
    assert_eq!(
        index_rows(&f),
        ((1, 1), (generation, 1)),
        "a Decision dirties both"
    );
}
