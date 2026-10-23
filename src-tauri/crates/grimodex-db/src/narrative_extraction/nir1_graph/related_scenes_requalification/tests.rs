//! CP-3a S1: the requalification of a worker's Graph for one Related Scenes
//! response (acceptance R-1 to R-10 of the CP-3a TASK, and the P1-1 and P2
//! rules of its integrator addendum).
//!
//! The world is the A3 fixture of the packing tests (two approved typed
//! Revisions of `Alice knows Bob`, a query Scene `a3-future`) with four more
//! live Scenes `g1` to `g4` before the query, each pinned to Bob. The worker's
//! Graph is built from the A3 results the way the worker records them
//! (`evaluate_nir1_entity_relation_disclosure_for_graph`), so a change of the
//! database after the Graph was built is what makes it stale.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use grimodex_core::narrative_nir1::EntityInput;
use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationBindingV1, NarrativeSceneBodyDeclarationV1,
    NarrativeSceneBodySourceV1,
};
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

use super::super::{Nir1GraphEdge, Nir1GraphMaterialBinding, Nir1GraphNode, Nir1QualifiedGraph};
use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::create_nir1_entity_relation_revision;
use crate::narrative_extraction::nir1_entity_relation::tests::{
    approve_typed_revision, create_typed_run, prepare_a3_scope_fixture, request_for_run,
    seed_run_and_catalog,
};
use crate::narrative_extraction::nir1_packing::tests::di1a_graph::{write_seal, GENERATION};
use crate::narrative_extraction::nir1_packing::tests::{
    PreparedWorkspace, RAW_SOURCE_PROJECT as PROJECT, RAW_SOURCE_SCENE as QUERY,
};
use crate::narrative_extraction::retrieval_admission::{
    read_retrieval_scene_source_bounded, RetrievalSceneSourceRead,
};
use crate::narrative_extraction::scene_body_declaration::test_support::{
    set_scene_body_declaration_for_test, TEST_DECLARED_AT,
};
use crate::narrative_extraction::scene_body_declaration::{
    scene_body_title_digest, SCENE_BODY_READ_MAX_BYTES,
};
use crate::narrative_extraction::task_leases::with_immediate_transaction;
use crate::narrative_extraction::{
    ensure_scene_scope_binding_in_tx, read_narrative_scene_scope, read_retrieval_query_context,
    update_narrative_scene_scope, NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
    RetrievalQueryContextRead,
};
use crate::state::ActiveWorkspaceSnapshot;
use crate::test_support::current_schema_memory;
use crate::Database;

const SEED: &str = "nir1-alice";
const REACHED: &str = "nir1-bob";
/// Live Scenes before the query, each pinned to the reached Entity. Their
/// relation to the Revisions: `g1` and `g3` are reached through the first
/// Revision's edge, `g2` and `g4` through the second's.
const SCENES: [&str; 4] = ["g1", "g2", "g3", "g4"];

fn body(text: &str) -> String {
    json!({
        "type": "doc",
        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }],
    })
    .to_string()
}

fn add_scene(db: &Database, id: &str, sort_order: &str) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES (?1, ?2, 'scene', ?3, ?4, ?5)",
            params![
                id,
                PROJECT,
                format!("Title of {id}"),
                body(&format!("The first line of {id}.")),
                sort_order
            ],
        )?;
        ensure_scene_scope_binding_in_tx(conn, PROJECT, id, "2026-09-17T00:00:00.000Z")?;
        Ok(())
    })?;
    let current = db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, id))?;
    let exact = |reference: &str| NarrativeScopeConstraintV1::Exact {
        reference: reference.into(),
    };
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.into(),
            scene_id: id.into(),
            request_id: format!("req-scope-request-{id}"),
            session_id: "req-scope-session".into(),
            event_uid: format!("req-scope-event-{id}"),
            base_version: current.binding.version,
            updated_at: "2026-09-17T00:01:00.000Z".into(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                query_identity: NarrativeSceneQueryIdentityV1 {
                    timeline: exact("timeline:main"),
                    worldline: exact("worldline:prime"),
                    narrative_layer: exact("layer:manuscript"),
                },
                material_constraint: NarrativeSceneMaterialConstraintV1 {
                    timeline: exact("timeline:main"),
                    worldline: exact("worldline:prime"),
                    narrative_layer: exact("layer:manuscript"),
                },
                knowledge_holder: NarrativeScopePrincipalV1::Reader {},
                audience: NarrativeScopePrincipalV1::Reader {},
            },
        },
    )?;
    Ok(())
}

struct World {
    _workspace: PreparedWorkspace,
    snapshot: ActiveWorkspaceSnapshot,
    revisions: Vec<String>,
}

impl World {
    fn new() -> Result<Self> {
        TEST_NOW.with(|now| now.set(None));
        TEST_TEXT_LIMIT.with(|limit| limit.set(None));
        EVALUATED.with(|log| log.borrow_mut().clear());
        let db = current_schema_memory()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        // The Scenes are made before the Revisions: adding a Scene changes the
        // project's Scope authority, which the Revisions are bound to.
        for (index, scene) in SCENES.iter().enumerate() {
            add_scene(&db, scene, &format!("a1{}", (b'b' + index as u8) as char))?;
        }
        run_incremental_freshness_cycle(&db)?;
        let mut revisions = Vec::new();
        for index in 0..2 {
            let run_id = format!("req-run-{index}");
            create_typed_run(&db, &run_id)?;
            let created = create_nir1_entity_relation_revision(
                &db,
                request_for_run(&db, &run_id, &format!("req-proposal-{index}")),
            )?;
            approve_typed_revision(&db, &run_id, &created)?;
            revisions.push(created["revisionId"].as_str().unwrap().to_owned());
        }
        // B's seal at GENERATION, and the seed Entity pinned to the query Scene.
        write_seal(&db, GENERATION, false)?;
        db.with_conn(|conn| {
            for (index, scene) in SCENES.iter().enumerate() {
                conn.execute(
                    "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
                     VALUES (?1, ?2, ?3)",
                    params![scene, REACHED, format!("2026-10-23T00:00:0{index}Z")],
                )?;
            }
            Ok(())
        })?;
        let workspace = PreparedWorkspace::new(db)?;
        let snapshot = workspace.snapshot()?;
        Ok(Self {
            _workspace: workspace,
            snapshot,
            revisions,
        })
    }

    fn db(&self) -> &Database {
        self.snapshot.db().db()
    }

    fn execute(&self, sql: &str) {
        self.db()
            .with_conn(|conn| {
                conn.execute_batch(sql)?;
                Ok(())
            })
            .unwrap();
    }

    fn workspace(&self) -> GraphDisclosureWorkspace {
        GraphDisclosureWorkspace::from_snapshot(&self.snapshot)
    }

    fn query(&self) -> GraphDisclosureQuery {
        let context = self
            .db()
            .with_read_transaction(|conn| {
                match read_retrieval_query_context(conn, PROJECT, QUERY)? {
                    RetrievalQueryContextRead::Available(context) => Ok(context),
                    other => anyhow::bail!("query context: {other:?}"),
                }
            })
            .unwrap();
        GraphDisclosureQuery::from_retrieval_query_context(&context)
    }

    /// Declares the Scene's whole body as it is now, with real digests and the
    /// Ready workspace's values.
    fn declare(&self, scene: &str) {
        let binding = self.snapshot.live_binding().expect("Ready binding");
        let identity = self
            .snapshot
            .durable_workspace_identity()
            .expect("durable identity");
        self.db()
            .with_conn(|conn| {
                with_immediate_transaction(conn, |tx| {
                    let RetrievalSceneSourceRead::Available(source) =
                        read_retrieval_scene_source_bounded(
                            tx,
                            PROJECT,
                            scene,
                            SCENE_BODY_READ_MAX_BYTES,
                            SCENE_BODY_READ_MAX_BYTES,
                            &mut || Ok(()),
                            &mut |_| Ok(()),
                        )?
                    else {
                        anyhow::bail!("body is not available");
                    };
                    let (incarnation, scope_token): (String, String) = tx.query_row(
                        "SELECT scene_incarnation_id, source_token
                           FROM narrative_scene_scope_bindings
                          WHERE project_id = ?1 AND scene_id = ?2",
                        params![PROJECT, scene],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    let title: String = tx.query_row(
                        "SELECT title FROM tree_nodes WHERE id = ?1",
                        [scene],
                        |row| row.get(0),
                    )?;
                    let declaration = NarrativeSceneBodyDeclarationV1::new(
                        Uuid::new_v4().to_string(),
                        TEST_DECLARED_AT,
                        NarrativeSceneBodyDeclarationBindingV1 {
                            project_id: PROJECT.to_owned(),
                            scene_id: scene.to_owned(),
                            scene_incarnation_id: incarnation,
                            scope_source_token: scope_token,
                            body_source: NarrativeSceneBodySourceV1 {
                                source_identity: source.query_source.source_key.clone(),
                                source_token: source.query_source.revision_token.clone(),
                                storage_digest: source.query_source.storage_digest.clone(),
                                canonical_digest: source.query_source.canonical_text_digest.clone(),
                                normalizer_version: source
                                    .query_source
                                    .normalizer_version
                                    .to_owned(),
                                utf16_length: u64::try_from(
                                    source.query_source.canonical_utf16_length,
                                )?,
                            },
                            title_digest: scene_body_title_digest(&title)?,
                            workspace_id: binding.workspace_id.to_string(),
                            canonical_locator_digest: identity
                                .canonical_locator_digest
                                .as_str()
                                .to_owned(),
                        },
                    )?;
                    set_scene_body_declaration_for_test(tx, &declaration)?;
                    Ok(())
                })
            })
            .unwrap();
    }

    /// The worker's Graph as of before `change`, with the tokens of the
    /// database as they are after it: its edges are current and its Scene
    /// associations are stale. (A write that reaches the change feed moves the
    /// Revisions' freshness, so a change made after the Graph was built would
    /// stale every path; this isolates the association.)
    fn projection_with_stale_scenes(&self, change: impl FnOnce()) -> Nir1GraphProjection {
        let before = self.projection();
        change();
        let mut after = self.projection();
        after.graph.scenes = before.graph.scenes;
        after
    }

    /// The worker's Graph as it is now: one edge per Revision (Alice to Bob),
    /// each Scene pinned to Bob with a one-edge path.
    fn projection(&self) -> Nir1GraphProjection {
        self.db()
            .with_read_transaction(|conn| {
                let mut edges = Vec::new();
                let mut scope_revision = None;
                let mut entities: Vec<Arc<EntityInput>> = Vec::new();
                for revision_id in &self.revisions {
                    let read = evaluate_nir1_entity_relation_disclosure_for_graph(
                        conn,
                        PROJECT,
                        revision_id,
                        QUERY,
                        None,
                    )?;
                    let Nir1EntityRelationDisclosureRead::Eligible(disclosure) = read else {
                        anyhow::bail!("the Revision is not eligible: {read:?}");
                    };
                    let bundle = &disclosure.revision.bundle;
                    if entities.is_empty() {
                        entities = bundle.entities.iter().cloned().map(Arc::new).collect();
                    }
                    let entity = |id: &str| {
                        Arc::clone(
                            entities
                                .iter()
                                .find(|entity| entity.entity_id == id)
                                .unwrap(),
                        )
                    };
                    let relation = &bundle.relations[0];
                    scope_revision = Some(disclosure.scope_authority_revision.clone());
                    edges.push(Nir1GraphEdge {
                        relation: Arc::new(relation.clone()),
                        from: entity(&relation.from_entity_id),
                        to: entity(&relation.to_entity_id),
                        binding: Arc::new(Nir1GraphMaterialBinding {
                            revision_id: disclosure.revision.revision_id.clone(),
                            decision_id: disclosure
                                .revision
                                .decision
                                .as_ref()
                                .unwrap()
                                .id()
                                .to_owned(),
                            decision_token: disclosure.decision_token.clone(),
                            freshness_token: disclosure.freshness_token.clone(),
                            scope_authority_revision: disclosure.scope_authority_revision.clone(),
                            query_scene_source_token: disclosure.query_scene_source_token.clone(),
                            query_scene_scope_token: disclosure.query_scene_scope_token.clone(),
                            query_scene_incarnation_id: disclosure
                                .query_scene_incarnation_id
                                .clone(),
                            reveal_state_token: disclosure.reveal_state_token.clone(),
                        }),
                    });
                }
                let nodes = entities
                    .iter()
                    .map(|entity| Nir1GraphNode {
                        entity: Arc::clone(entity),
                        hop: u8::from(entity.entity_id != SEED),
                        bindings: Vec::new(),
                        binding_scopes: Vec::new(),
                    })
                    .collect();
                let mut scenes = Vec::new();
                for (index, scene) in SCENES.iter().enumerate() {
                    // A Scene whose pin or row is gone has no association.
                    let Some((incarnation, scope_token, version, updated_at, rowid, created_at)) =
                        conn.query_row(
                            "SELECT b.scene_incarnation_id, b.source_token, n.version,
                                    n.updated_at, p.rowid, p.created_at
                               FROM scene_codex_pins p
                               JOIN tree_nodes n ON n.id = p.scene_id
                               JOIN narrative_scene_scope_bindings b ON b.scene_id = p.scene_id
                              WHERE p.scene_id = ?1 AND p.entry_id = ?2",
                            params![scene, REACHED],
                            |row| {
                                Ok((
                                    row.get::<_, Option<String>>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                    row.get::<_, i64>(2)?,
                                    row.get::<_, String>(3)?,
                                    row.get::<_, i64>(4)?,
                                    row.get::<_, String>(5)?,
                                ))
                            },
                        )
                        .optional()?
                    else {
                        continue;
                    };
                    scenes.push(Nir1GraphSceneAssociation {
                        scene_id: (*scene).to_owned(),
                        scene_incarnation_id: incarnation,
                        scene_source_token: format!("v{version}@{updated_at}"),
                        scene_scope_token: scope_token,
                        pin_rowid: rowid,
                        pin_entry_id: REACHED.to_owned(),
                        pin_created_at: created_at,
                        path_hop: 1,
                        path_edge_indices: vec![u16::try_from(index % 2).unwrap()],
                    });
                }
                Ok(Nir1GraphProjection {
                    project_id: PROJECT.to_owned(),
                    query_scene_id: QUERY.to_owned(),
                    scope_revision,
                    graph: Nir1QualifiedGraph {
                        seed_entity_id: SEED.to_owned(),
                        generation: GENERATION,
                        nodes,
                        edges,
                        scene_total: scenes.len(),
                        scenes,
                    },
                    elapsed: Duration::ZERO,
                })
            })
            .unwrap()
    }
}

const OPEN: AppendSlot = AppendSlot {
    ir_uses_common_slot: false,
    raw_count: 3,
};

fn transaction_budget() -> ParticipantSqlOperationBudget {
    ParticipantSqlOperationBudget::new(
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(60),
        Duration::from_secs(5),
    )
}

fn ample() -> GraphOnlyBudget {
    GraphOnlyBudget::new(u64::MAX / 2, None)
}

fn set(scenes: &[&str]) -> BTreeSet<String> {
    scenes.iter().map(|scene| (*scene).to_owned()).collect()
}

struct Call<'a> {
    world: &'a World,
    projection: &'a Nir1GraphProjection,
    displayed: BTreeSet<String>,
    slot: AppendSlot,
    budget: GraphOnlyBudget,
}

impl<'a> Call<'a> {
    fn new(world: &'a World, projection: &'a Nir1GraphProjection, displayed: &[&str]) -> Self {
        Self {
            world,
            projection,
            displayed: set(displayed),
            slot: OPEN,
            budget: ample(),
        }
    }

    fn with_budget(mut self, budget: GraphOnlyBudget) -> Self {
        self.budget = budget;
        self
    }

    fn with_slot(mut self, slot: AppendSlot) -> Self {
        self.slot = slot;
        self
    }

    fn run_with(
        &self,
        transaction: ParticipantSqlOperationBudget,
        check: &mut dyn FnMut() -> Result<()>,
    ) -> Result<GraphRequalification> {
        let workspace = self.world.workspace();
        let query = self.world.query();
        let input = GraphRequalificationInput {
            project_id: PROJECT,
            query_scene_id: QUERY,
            projection: self.projection,
            displayed_scene_ids: &self.displayed,
            slot: self.slot,
            workspace: &workspace,
            query: &query,
            graph_only_budget: &self.budget,
        };
        with_graph_requalification_read(&self.world.snapshot, transaction, |conn| {
            requalify_graph_for_related_scenes(conn, &input, check)
        })
    }

    fn run(&self) -> GraphRequalification {
        self.run_with(transaction_budget(), &mut || Ok(())).unwrap()
    }
}

fn qualified(result: GraphRequalification) -> Box<QualifiedGraphForRelatedScenes> {
    match result {
        GraphRequalification::Qualified(qualified) => qualified,
        GraphRequalification::Dropped(reason) => panic!("the Graph was dropped: {reason:?}"),
    }
}

fn dropped(result: GraphRequalification) -> GraphRequalificationDrop {
    match result {
        GraphRequalification::Dropped(reason) => reason,
        GraphRequalification::Qualified(_) => panic!("the Graph was expected to be dropped"),
    }
}

fn scene_ids(attachments: &[GraphPathAttachment]) -> Vec<&str> {
    attachments
        .iter()
        .map(|attachment| attachment.scene_id.as_str())
        .collect()
}

fn graph_only_scene(qualified: &QualifiedGraphForRelatedScenes) -> Option<&str> {
    match &qualified.graph_only {
        GraphOnlySceneDisclosure::Eligible(scene) => Some(scene.scene_id()),
        GraphOnlySceneDisclosure::NotAppended(_) => None,
    }
}

fn evaluated() -> Vec<String> {
    EVALUATED.with(|log| log.borrow().clone())
}

/// The world with `g3` and `g4` declared (their Revisions are the first's and
/// the second's), so both Graph-only candidates are eligible.
fn declared_world() -> World {
    let world = World::new().unwrap();
    for scene in ["g3", "g4"] {
        world.declare(scene);
    }
    world
}

fn is_validation_terminated_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<ValidationTerminated>())
}

// ---- the whole response --------------------------------------------------------

#[test]
fn a_current_graph_attaches_the_displayed_paths_and_discloses_one_graph_only_scene() {
    let world = declared_world();
    let projection = world.projection();
    let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
    assert_eq!(scene_ids(&result.attachments), ["g1", "g2"]);
    // The displayed Scenes are not Graph-only candidates; the first candidate
    // in tuple order that is eligible is.
    assert_eq!(graph_only_scene(&result), Some("g3"));
    let GraphOnlySceneDisclosure::Eligible(scene) = &result.graph_only else {
        unreachable!()
    };
    assert_eq!(scene.title(), "Title of g3");
    assert_eq!(scene.excerpt(), "The first line of g3.");

    // The path additions carry the text of the Revision, one or two edges.
    let first = &result.attachments[0];
    assert_eq!(first.hop, 1);
    assert_eq!(first.edges.len(), 1);
    let edge = &first.edges[0];
    assert_eq!(edge.edge_id, "nir1-edge");
    assert_eq!(edge.relation_type, "knows");
    assert_eq!(
        edge.directionality,
        projection.graph.edges[0].relation.directionality
    );
    assert_eq!(
        (edge.from.entity_id.as_str(), edge.from.label.as_str()),
        (SEED, "Alice")
    );
    assert_eq!(
        (edge.to.entity_id.as_str(), edge.to.label.as_str()),
        (REACHED, "Bob")
    );
    assert_eq!(
        edge.evidence
            .iter()
            .map(|evidence| (evidence.evidence_id.as_str(), evidence.quote.as_str()))
            .collect::<Vec<_>>(),
        [
            ("nir1-evidence-alice", "Alice"),
            ("nir1-evidence-bob", "Bob")
        ]
    );
}

#[test]
fn the_graph_a3_version_gives_the_tokens_of_the_complete_version() {
    // The worker made its tokens with the Graph's A3 (the Decision read for who
    // approved it); D-final derives them with the complete one. Equal tokens
    // are what lets one comparison serve both (DR-CP3A-6).
    let world = World::new().unwrap();
    world
        .db()
        .with_read_transaction(|conn| {
            let reads = Nir1ProjectReads::load(conn, PROJECT, QUERY)?;
            for revision_id in &world.revisions {
                let graph = evaluate_nir1_entity_relation_disclosure_for_graph(
                    conn,
                    PROJECT,
                    revision_id,
                    QUERY,
                    Some(&reads),
                )?;
                let complete =
                    crate::narrative_extraction::evaluate_nir1_entity_relation_disclosure(
                        conn,
                        PROJECT,
                        revision_id,
                        QUERY,
                    )?;
                let (
                    Nir1EntityRelationDisclosureRead::Eligible(graph),
                    Nir1EntityRelationDisclosureRead::Eligible(complete),
                ) = (graph, complete)
                else {
                    panic!("both versions qualify the Revision");
                };
                assert_eq!(graph.decision_token, complete.decision_token);
                assert_eq!(graph.freshness_token, complete.freshness_token);
                assert_eq!(
                    graph.scope_authority_revision,
                    complete.scope_authority_revision
                );
                assert_eq!(
                    graph.query_scene_source_token,
                    complete.query_scene_source_token
                );
                assert_eq!(
                    graph.query_scene_scope_token,
                    complete.query_scene_scope_token
                );
                assert_eq!(
                    graph.query_scene_incarnation_id,
                    complete.query_scene_incarnation_id
                );
                assert_eq!(graph.reveal_state_token, complete.reveal_state_token);
                assert_eq!(
                    graph.revision.decision.as_ref().unwrap().id(),
                    complete.revision.decision.as_ref().unwrap().id()
                );
            }
            Ok(())
        })
        .unwrap();
}

// ---- R-1, R-2: the seal and the seed ---------------------------------------------

#[test]
fn requalification_seal_mismatch_drops_the_whole_graph() {
    let world = World::new().unwrap();
    let projection = world.projection();
    // Another generation.
    write_seal(world.db(), GENERATION + 1, false).unwrap();
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1"]).run()),
        GraphRequalificationDrop::SealMismatch
    );
    // Dirty: B has no current seal.
    write_seal(world.db(), GENERATION, true).unwrap();
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1"]).run()),
        GraphRequalificationDrop::SealUnavailable
    );
    // Neither reached step 2: no Revision was evaluated.
    assert!(evaluated().is_empty());
    // The seal as the Graph was made under holds.
    write_seal(world.db(), GENERATION, false).unwrap();
    assert!(matches!(
        Call::new(&world, &projection, &["g1"]).run(),
        GraphRequalification::Qualified(_)
    ));
}

#[test]
fn requalification_seed_change_drops_the_whole_graph() {
    let world = World::new().unwrap();
    let projection = world.projection();
    let call = || Call::new(&world, &projection, &["g1"]);
    // A pin of the query Scene that sorts before the seed's moves the seed.
    world.execute(&format!(
        "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
         VALUES ('{QUERY}', '{REACHED}', '2000-01-01T00:00:00Z');"
    ));
    assert_eq!(dropped(call().run()), GraphRequalificationDrop::SeedChanged);
    world.execute(&format!(
        "DELETE FROM scene_codex_pins WHERE scene_id = '{QUERY}' AND entry_id = '{REACHED}';"
    ));
    assert!(matches!(call().run(), GraphRequalification::Qualified(_)));
    // Deleted and inserted again: the rule reads the same Entity, so it holds.
    world.execute(&format!(
        "DELETE FROM scene_codex_pins WHERE scene_id = '{QUERY}' AND entry_id = '{SEED}';
         INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
         VALUES ('{QUERY}', '{SEED}', '2026-10-19T00:00:00Z');"
    ));
    assert!(matches!(call().run(), GraphRequalification::Qualified(_)));
    // No pin at all.
    world.execute(&format!(
        "DELETE FROM scene_codex_pins WHERE scene_id = '{QUERY}';"
    ));
    assert_eq!(dropped(call().run()), GraphRequalificationDrop::SeedChanged);
    // Another Graph's seed.
    world.execute(&format!(
        "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
         VALUES ('{QUERY}', '{SEED}', '2026-10-19T00:00:00Z');"
    ));
    let mut other_seed = world.projection();
    other_seed.graph.seed_entity_id = REACHED.to_owned();
    assert_eq!(
        dropped(Call::new(&world, &other_seed, &["g1"]).run()),
        GraphRequalificationDrop::SeedChanged
    );
}

#[test]
fn a_graph_made_for_another_project_or_scene_is_dropped_before_anything_is_read() {
    let world = World::new().unwrap();
    let mut projection = world.projection();
    projection.query_scene_id = "another-scene".to_owned();
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1"]).run()),
        GraphRequalificationDrop::ProjectOrSceneMismatch
    );
    let mut projection = world.projection();
    projection.project_id = "another-project".to_owned();
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1"]).run()),
        GraphRequalificationDrop::ProjectOrSceneMismatch
    );
    assert!(evaluated().is_empty());
}

// ---- R-3: the nine tokens and the scope revision ------------------------------------

type Tamper = Box<dyn Fn(&mut Nir1GraphMaterialBinding)>;

fn token_tamperings() -> Vec<(&'static str, Tamper)> {
    vec![
        ("revision", Box::new(|b| b.revision_id = "other".into())),
        ("decision id", Box::new(|b| b.decision_id = "other".into())),
        (
            "decision token",
            Box::new(|b| b.decision_token = "sha256:x".into()),
        ),
        (
            "freshness",
            Box::new(|b| b.freshness_token = "sha256:x".into()),
        ),
        (
            "scope authority revision",
            Box::new(|b| b.scope_authority_revision = "other".into()),
        ),
        (
            "query source",
            Box::new(|b| b.query_scene_source_token = "v0@x".into()),
        ),
        (
            "query scope",
            Box::new(|b| b.query_scene_scope_token = "other".into()),
        ),
        (
            "query incarnation",
            Box::new(|b| b.query_scene_incarnation_id = "other".into()),
        ),
        (
            "reveal state",
            Box::new(|b| b.reveal_state_token = "other".into()),
        ),
    ]
}

#[test]
fn any_single_path_token_mismatch_drops_every_attachment() {
    let world = World::new().unwrap();
    for (name, tamper) in token_tamperings() {
        let mut projection = world.projection();
        // Only the second edge (the path of `g2`) is changed; `g1`'s is intact.
        let mut binding = (*projection.graph.edges[1].binding).clone();
        tamper(&mut binding);
        projection.graph.edges[1].binding = Arc::new(binding);
        assert_eq!(
            dropped(Call::new(&world, &projection, &["g1", "g2"]).run()),
            GraphRequalificationDrop::PathNotCurrent,
            "{name}"
        );
    }
    // The scope revision of the frame.
    let mut projection = world.projection();
    projection.scope_revision = Some("other".to_owned());
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1", "g2"]).run()),
        GraphRequalificationDrop::PathNotCurrent
    );
    projection.scope_revision = None;
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1", "g2"]).run()),
        GraphRequalificationDrop::PathNotCurrent
    );
    // An edge the Revision does not have.
    let mut projection = world.projection();
    let mut relation = (*projection.graph.edges[1].relation).clone();
    relation.edge_id = "no-such-edge".to_owned();
    projection.graph.edges[1].relation = Arc::new(relation);
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1", "g2"]).run()),
        GraphRequalificationDrop::PathNotCurrent
    );
    // Intact, the same call qualifies.
    let projection = world.projection();
    assert!(matches!(
        Call::new(&world, &projection, &["g1", "g2"]).run(),
        GraphRequalification::Qualified(_)
    ));
}

#[test]
fn a_change_of_the_database_after_the_graph_was_made_drops_the_attachments() {
    for (name, sql) in [
        (
            "the query Scene's body",
            "UPDATE tree_nodes SET content = '{\"type\":\"doc\",\"content\":[]}',
                    version = version + 1, updated_at = '2026-10-23T00:00:00.000Z'
              WHERE id = 'a3-future';",
        ),
        (
            // Archiving a Scene changes the project's Scope authority, which
            // every Revision's tokens are bound to: the Graph made before it
            // is stale as a whole.
            "a Scene archived",
            "UPDATE tree_nodes SET archived_at = '2026-10-23 00:00:00' WHERE id = 'g3';",
        ),
    ] {
        let world = World::new().unwrap();
        let projection = world.projection();
        world.execute(sql);
        let outcome = Call::new(&world, &projection, &["g1", "g2"])
            .run_with(transaction_budget(), &mut || Ok(()));
        match outcome {
            Ok(GraphRequalification::Dropped(reason)) => {
                assert!(
                    matches!(
                        reason,
                        GraphRequalificationDrop::PathNotCurrent
                            | GraphRequalificationDrop::SeedChanged
                    ),
                    "{name}: {reason:?}"
                );
            }
            Ok(GraphRequalification::Qualified(_)) => panic!("{name}: the Graph still holds"),
            Err(error) => panic!("{name}: {error:#}"),
        }
    }
}

// ---- R-4: the pin -----------------------------------------------------------------------

#[test]
fn attached_scene_pin_move_delete_reinsert_or_archive_drops_the_graph() {
    type Change = (&'static str, &'static str);
    let changes: [Change; 5] = [
        (
            "moved",
            "UPDATE scene_codex_pins SET created_at = '2030-01-01T00:00:00Z' WHERE scene_id = 'g2';",
        ),
        (
            "deleted",
            "DELETE FROM scene_codex_pins WHERE scene_id = 'g2';",
        ),
        (
            "reinserted",
            "DELETE FROM scene_codex_pins WHERE scene_id = 'g2';
             INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
             VALUES ('g2', 'nir1-bob', '2026-10-23T00:00:01Z');",
        ),
        (
            "archived",
            "UPDATE tree_nodes SET archived_at = '2026-10-23 00:00:00' WHERE id = 'g2';",
        ),
        (
            "to another Entity",
            "UPDATE scene_codex_pins SET entry_id = 'nir1-alice' WHERE scene_id = 'g2';",
        ),
    ];
    for (name, sql) in changes {
        let world = World::new().unwrap();
        let projection = world.projection_with_stale_scenes(|| world.execute(sql));
        assert_eq!(
            dropped(Call::new(&world, &projection, &["g1", "g2"]).run()),
            GraphRequalificationDrop::PathNotCurrent,
            "{name}"
        );
        // The same change to a Scene that is not displayed does not touch the
        // path additions (it can only keep that Scene from being Graph-only).
        let world = World::new().unwrap();
        let projection = world.projection_with_stale_scenes(|| world.execute(sql));
        let result = qualified(Call::new(&world, &projection, &["g1"]).run());
        assert_eq!(scene_ids(&result.attachments), ["g1"], "{name}");
    }
}

// ---- R-5, R-6: the Graph-only candidate -----------------------------------------------------

#[test]
fn graph_only_failure_changes_neither_the_state_nor_the_attachments() {
    let baseline = {
        let world = declared_world();
        let projection = world.projection();
        let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
        assert_eq!(graph_only_scene(&result), Some("g3"));
        result.attachments
    };

    type Change = (&'static str, &'static str);
    let changes: [Change; 6] = [
        (
            "the pin moved",
            "UPDATE scene_codex_pins SET created_at = '2031-01-01T00:00:00Z' WHERE scene_id = 'g3';",
        ),
        (
            "the body changed after the declaration",
            "UPDATE tree_nodes SET content = '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Rewritten.\"}]}]}', version = version + 1, updated_at = '2026-10-23T01:00:00.000Z' WHERE id = 'g3';",
        ),
        (
            "the declaration was removed",
            "UPDATE narrative_scene_scope_bindings SET body_declaration_json = NULL, body_declaration_token = NULL WHERE scene_id = 'g3';",
        ),
        (
            "the title changed",
            "UPDATE tree_nodes SET title = 'Another title' WHERE id = 'g3';",
        ),
        (
            "the Scene was archived",
            "UPDATE tree_nodes SET archived_at = '2026-10-23 00:00:00' WHERE id = 'g3';",
        ),
        (
            "the pin was deleted",
            "DELETE FROM scene_codex_pins WHERE scene_id = 'g3';",
        ),
    ];
    for (name, sql) in changes {
        let world = declared_world();
        let projection = world.projection_with_stale_scenes(|| world.execute(sql));
        let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
        // The first candidate failed; the next one (`g4`) is the one adopted,
        // and the path additions are the same as without any failure.
        assert_eq!(result.attachments, baseline, "{name}");
        assert_eq!(graph_only_scene(&result), Some("g4"), "{name}");
    }

    // Every candidate failing: still `Qualified`, the same attachments, and
    // nothing in the value says which candidate failed or why.
    let world = declared_world();
    let projection = world.projection();
    world.execute(
        "UPDATE narrative_scene_scope_bindings SET body_declaration_json = NULL,
                body_declaration_token = NULL WHERE scene_id IN ('g3', 'g4');",
    );
    let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
    assert_eq!(result.attachments, baseline);
    assert_eq!(graph_only_scene(&result), None);
    assert!(matches!(
        result.graph_only,
        GraphOnlySceneDisclosure::NotAppended(NotAppended)
    ));

    // A candidate's path that no longer holds is the same answer. `g4`'s is the
    // second edge; `g3`'s (the first edge) is intact and adopted.
    let world = declared_world();
    let mut projection = world.projection();
    let mut binding = (*projection.graph.edges[1].binding).clone();
    binding.freshness_token = "sha256:stale".into();
    projection.graph.edges[1].binding = Arc::new(binding);
    let result = qualified(Call::new(&world, &projection, &["g1"]).run());
    assert_eq!(scene_ids(&result.attachments), ["g1"]);
    assert_eq!(graph_only_scene(&result), Some("g3"));
    let result = qualified(Call::new(&world, &projection, &["g1", "g3"]).run());
    assert_eq!(graph_only_scene(&result), None, "g4's path is stale");
}

#[test]
fn graph_only_slot_closed_makes_no_database_read_for_candidates() {
    let world = declared_world();
    let projection = world.projection();
    let declaration_reads = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&declaration_reads);
    world
        .db()
        .with_conn(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(context.action, AuthAction::Read { column_name, .. }
                    if column_name == "body_declaration_json")
                {
                    counted.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))?;
            Ok(())
        })
        .unwrap();
    for slot in [
        AppendSlot {
            ir_uses_common_slot: true,
            raw_count: 3,
        },
        AppendSlot {
            ir_uses_common_slot: false,
            raw_count: 8,
        },
    ] {
        let budget = ample();
        let result = qualified(
            Call::new(&world, &projection, &["g1", "g2"])
                .with_slot(slot)
                .with_budget(budget.clone())
                .run(),
        );
        assert_eq!(graph_only_scene(&result), None);
        assert_eq!(scene_ids(&result.attachments), ["g1", "g2"]);
        assert_eq!(
            declaration_reads.load(Ordering::SeqCst),
            0,
            "a closed slot reads no declaration"
        );
        assert_eq!(budget.vm_steps_used(), 0, "and installs no budget");
    }
    // With the slot open the candidates are read.
    let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
    assert_eq!(graph_only_scene(&result), Some("g3"));
    assert!(declaration_reads.load(Ordering::SeqCst) > 0);
    world
        .db()
        .with_conn(|conn| {
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            Ok(())
        })
        .unwrap();
}

// ---- R-7: the Graph-only budget and the real cancel -----------------------------------------------

#[test]
fn graph_only_sql_budget_n_and_n_plus_one() {
    let world = declared_world();
    let projection = world.projection();
    let displayed = ["g1", "g2"];
    let used = {
        let budget = ample();
        let result = qualified(
            Call::new(&world, &projection, &displayed)
                .with_budget(budget.clone())
                .run(),
        );
        assert_eq!(graph_only_scene(&result), Some("g3"));
        budget.vm_steps_used()
    };
    assert!(used > 0);
    println!("GRAPH_ONLY_VM_STEPS g3 eligible (2 Revisions, 2 candidates declared): {used}");

    let baseline = qualified(Call::new(&world, &projection, &displayed).run()).attachments;
    // N steps are within the budget; N + 1 is not. (The count is exact: the
    // progress handler runs at every VM instruction.)
    let at = |max: u64| {
        let budget = GraphOnlyBudget::new(max, None);
        qualified(
            Call::new(&world, &projection, &displayed)
                .with_budget(budget)
                .run(),
        )
    };
    let within = at(used);
    assert_eq!(graph_only_scene(&within), Some("g3"));
    let over = at(used - 1);
    // Over the budget: no Graph-only Scene, the Graph's state and the path
    // additions are untouched, and it is a `Qualified`, never a failure.
    assert_eq!(graph_only_scene(&over), None);
    assert_eq!(over.attachments, baseline);
    assert!(matches!(
        over.graph_only,
        GraphOnlySceneDisclosure::NotAppended(NotAppended)
    ));
    // However early it runs out, the answer is the same.
    for max in [0, 1, 7, 100, used / 4, used / 2, used - 1] {
        let result = at(max);
        assert_eq!(graph_only_scene(&result), None, "budget {max}");
        assert_eq!(result.attachments, baseline, "budget {max}");
    }
}

#[test]
fn graph_only_deadline_before_and_after() {
    let world = declared_world();
    let projection = world.projection();
    let base = Instant::now();
    let deadline = base + Duration::from_millis(100);
    let run = |now: Instant| {
        TEST_NOW.with(|clock| clock.set(Some(now)));
        let result = qualified(
            Call::new(&world, &projection, &["g1", "g2"])
                .with_budget(GraphOnlyBudget::new(u64::MAX / 2, Some(deadline)))
                .run(),
        );
        TEST_NOW.with(|clock| clock.set(None));
        result
    };
    let before = run(base + Duration::from_millis(99));
    assert_eq!(graph_only_scene(&before), Some("g3"));
    let at = run(deadline);
    assert_eq!(graph_only_scene(&at), None);
    let after = run(base + Duration::from_millis(101));
    assert_eq!(graph_only_scene(&after), None);
    // The path additions are the same on both sides of the deadline.
    assert_eq!(at.attachments, before.attachments);
    assert_eq!(after.attachments, before.attachments);
}

#[test]
fn the_budget_is_not_in_force_outside_the_graph_only_judgement() {
    // A budget of zero steps stops only the Graph-only judgement: the path
    // additions and the seal and seed reads run under the transaction.
    let world = declared_world();
    let projection = world.projection();
    let budget = GraphOnlyBudget::new(0, None);
    let result = qualified(
        Call::new(&world, &projection, &["g1", "g2"])
            .with_budget(budget.clone())
            .run(),
    );
    assert_eq!(scene_ids(&result.attachments), ["g1", "g2"]);
    assert_eq!(graph_only_scene(&result), None);
    // The progress owner is the participant's again: the budget no longer counts.
    let counted = budget.vm_steps_used();
    world
        .db()
        .with_read_transaction(|conn| {
            let _: i64 = conn.query_row("SELECT count(*) FROM tree_nodes", [], |row| row.get(0))?;
            Ok(())
        })
        .unwrap();
    assert_eq!(budget.vm_steps_used(), counted);
}

#[test]
fn a_real_cancel_inside_the_graph_only_judgement_is_an_error() {
    let world = declared_world();
    let projection = world.projection();
    // How many checkpoints a whole requalification calls.
    let total = {
        let calls = AtomicUsize::new(0);
        let mut check = || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        Call::new(&world, &projection, &["g1", "g2"])
            .run_with(transaction_budget(), &mut check)
            .unwrap();
        calls.load(Ordering::SeqCst)
    };
    assert!(total > 10);
    // A cancel at any checkpoint is an `Err` (never a result without the
    // Graph-only Scene, and never a `NotAppended` standing in for it).
    for cancel_at in 1..=total {
        let calls = AtomicUsize::new(0);
        let mut check = || {
            if calls.fetch_add(1, Ordering::SeqCst) + 1 >= cancel_at {
                anyhow::bail!("the lease was cancelled");
            }
            Ok(())
        };
        let outcome = Call::new(&world, &projection, &["g1", "g2"])
            .run_with(transaction_budget(), &mut check);
        let error = outcome.expect_err("a cancel is an error");
        assert!(
            error.to_string().contains("the lease was cancelled"),
            "cancel at {cancel_at}: {error:#}"
        );
    }
}

#[test]
fn a_cancel_during_a_budgeted_judgement_wins_over_the_budget() {
    // The budget runs out and the lease is cancelled: the cancel is the answer.
    let world = declared_world();
    let projection = world.projection();
    let calls = AtomicUsize::new(0);
    let mut check = || {
        // Cancel only from the Graph-only judgement on (after the path
        // additions' checkpoints).
        if calls.fetch_add(1, Ordering::SeqCst) >= 12 {
            anyhow::bail!("the lease was cancelled");
        }
        Ok(())
    };
    let outcome = Call::new(&world, &projection, &["g1", "g2"])
        .with_budget(GraphOnlyBudget::new(0, None))
        .run_with(transaction_budget(), &mut check);
    assert!(outcome.is_err(), "a cancel is not hidden by the budget");
}

#[test]
fn the_participant_stop_and_deadline_are_errors_not_a_budget() {
    let world = declared_world();
    let projection = world.projection();
    // The participant's stop flag, raised while the Graph-only judgement runs
    // (by a checkpoint late in the call), stops SQLite with a typed error.
    let stop = Arc::new(AtomicBool::new(false));
    let budget = ParticipantSqlOperationBudget::new(
        Arc::clone(&stop),
        Instant::now() + Duration::from_secs(60),
        Duration::from_secs(5),
    );
    let calls = AtomicUsize::new(0);
    let mut check = || {
        if calls.fetch_add(1, Ordering::SeqCst) >= 14 {
            stop.store(true, Ordering::Release);
        }
        Ok(())
    };
    let outcome = Call::new(&world, &projection, &["g1", "g2"]).run_with(budget, &mut check);
    let error = outcome.expect_err("the participant stop is an error");
    assert!(is_validation_terminated_error(&error), "{error:#}");

    // The transaction's own deadline in the past is a timeout of the Graph.
    let expired = ParticipantSqlOperationBudget::new(
        Arc::new(AtomicBool::new(false)),
        Instant::now() - Duration::from_millis(1),
        Duration::from_secs(1),
    );
    let outcome = Call::new(&world, &projection, &["g1", "g2"]).run_with(expired, &mut || Ok(()));
    let error = outcome.expect_err("an elapsed transaction deadline is an error");
    assert!(is_validation_terminated_error(&error), "{error:#}");
}

// ---- R-8, R-9: the text, and the work ----------------------------------------------------------------

#[test]
fn path_text_comes_from_the_parent_read_not_the_worker() {
    let world = World::new().unwrap();
    let mut projection = world.projection();
    // The worker's text is altered (its tokens are not): nothing of it may
    // reach the output.
    for edge in &mut projection.graph.edges {
        let mut relation = (*edge.relation).clone();
        relation.relation_type = "WORKER-RELATION-TYPE".into();
        relation.evidence_ids = vec!["worker-evidence".into()];
        edge.relation = Arc::new(relation);
        let mut from = (*edge.from).clone();
        from.label = "WORKER-LABEL".into();
        from.evidence[0].quote = "WORKER-QUOTE".into();
        edge.from = Arc::new(from);
    }
    for node in &mut projection.graph.nodes {
        let mut entity = (*node.entity).clone();
        entity.label = "WORKER-NODE-LABEL".into();
        node.entity = Arc::new(entity);
    }
    let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
    let text = result
        .attachments
        .iter()
        .flat_map(|attachment| &attachment.edges)
        .flat_map(|edge| {
            [
                edge.relation_type.clone(),
                edge.from.label.clone(),
                edge.to.label.clone(),
            ]
            .into_iter()
            .chain(edge.evidence.iter().map(|evidence| evidence.quote.clone()))
        })
        .collect::<Vec<_>>();
    assert!(!text.is_empty());
    assert!(
        text.iter().all(|text| !text.contains("WORKER")),
        "no worker text in {text:?}"
    );
    assert!(text.contains(&"knows".to_owned()));
    assert!(text.contains(&"Alice".to_owned()));
}

#[test]
fn requalification_reads_each_revision_once_and_bounds_the_work() {
    let world = declared_world();
    let projection = world.projection();
    // Four displayed paths over two Revisions, and the Graph-only candidate
    // path over the same two: each Revision is evaluated once.
    let displayed = ["g1", "g2", "g3", "g4"];
    let result = qualified(Call::new(&world, &projection, &displayed).run());
    assert_eq!(result.attachments.len(), 4);
    let mut revisions = evaluated();
    assert_eq!(revisions.len(), 2, "{revisions:?}");
    revisions.sort();
    revisions.dedup();
    assert_eq!(revisions.len(), 2);
    // At most 8 Scenes of at most 2 edges.
    assert!(result.attachments.len() <= MAX_GRAPH_SCENES);
    assert!(result
        .attachments
        .iter()
        .all(|attachment| (1..=MAX_PATH_EDGES).contains(&attachment.edges.len())));

    // A Revision only the Graph-only candidate needs is evaluated once, by it.
    EVALUATED.with(|log| log.borrow_mut().clear());
    let result = qualified(Call::new(&world, &projection, &["g1", "g3"]).run());
    assert_eq!(scene_ids(&result.attachments), ["g1", "g3"]);
    assert_eq!(graph_only_scene(&result), Some("g4"));
    assert_eq!(evaluated().len(), 2, "{:?}", evaluated());
}

#[test]
fn the_text_of_the_path_additions_is_bounded_before_it_is_copied() {
    let world = World::new().unwrap();
    let projection = world.projection();
    let edge_bytes = |edge: &GraphPathEdge| {
        edge.edge_id.len()
            + edge.relation_type.len()
            + edge.directionality.len()
            + edge.from.entity_id.len()
            + edge.from.label.len()
            + edge.to.entity_id.len()
            + edge.to.label.len()
            + edge
                .evidence
                .iter()
                .map(|evidence| evidence.evidence_id.len() + evidence.quote.len())
                .sum::<usize>()
    };
    let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
    // Each Revision's edge is charged once, however many Scenes use it: `g1`
    // uses the first Revision's edge, `g2` the second's.
    let once: usize = result
        .attachments
        .iter()
        .map(|attachment| edge_bytes(&attachment.edges[0]))
        .sum();
    let more = qualified(Call::new(&world, &projection, &["g1", "g2", "g3", "g4"]).run());
    assert_eq!(more.attachments.len(), 4);
    TEST_TEXT_LIMIT.with(|limit| limit.set(Some(once)));
    assert!(matches!(
        Call::new(&world, &projection, &["g1", "g2", "g3", "g4"]).run(),
        GraphRequalification::Qualified(_)
    ));
    TEST_TEXT_LIMIT.with(|limit| limit.set(Some(once - 1)));
    assert_eq!(
        dropped(Call::new(&world, &projection, &["g1", "g2"]).run()),
        GraphRequalificationDrop::AttachmentLimit
    );
    TEST_TEXT_LIMIT.with(|limit| limit.set(None));
}

#[test]
fn a_malformed_association_is_not_current() {
    let world = World::new().unwrap();
    type Change = (&'static str, Box<dyn Fn(&mut Nir1GraphSceneAssociation)>);
    let changes: Vec<Change> = vec![
        ("no edge", Box::new(|a| a.path_edge_indices.clear())),
        (
            "three edges",
            Box::new(|a| a.path_edge_indices = vec![0, 1, 0]),
        ),
        ("hop differs from the count", Box::new(|a| a.path_hop = 2)),
        (
            "index outside the frame",
            Box::new(|a| a.path_edge_indices = vec![9]),
        ),
        (
            "pin at another Entity",
            Box::new(|a| a.pin_entry_id = "elsewhere".into()),
        ),
    ];
    for (name, change) in changes {
        let mut projection = world.projection();
        change(&mut projection.graph.scenes[0]);
        assert_eq!(
            dropped(Call::new(&world, &projection, &["g1"]).run()),
            GraphRequalificationDrop::PathNotCurrent,
            "{name}"
        );
    }
}

#[test]
fn the_output_types_print_without_their_contents() {
    let world = declared_world();
    let projection = world.projection();
    let result = qualified(Call::new(&world, &projection, &["g1", "g2"]).run());
    let printed = format!("{result:?}");
    for secret in ["Alice", "Bob", "knows", "Title of g3", "first line"] {
        assert!(!printed.contains(secret), "{secret} in {printed}");
    }
}

#[test]
fn the_default_step_budget_is_the_graph_querys() {
    assert_eq!(GRAPH_ONLY_VM_STEPS, super::super::QUERY_SQL_STEPS);
    assert_eq!(GRAPH_ONLY_VM_STEPS, 600_000);
}

/// K1b rule 5: the VM steps of the Graph-only judgement, for the record in
/// DR-CP3A-4. The counts are exact and do not depend on the build or the
/// machine. Run with `--nocapture`.
#[test]
fn measure_graph_only_vm_steps() {
    let world = declared_world();
    let projection = world.projection();
    let steps = |displayed: &[&str], budget: GraphOnlyBudget| {
        let result = qualified(
            Call::new(&world, &projection, displayed)
                .with_budget(budget.clone())
                .run(),
        );
        (
            graph_only_scene(&result).map(str::to_owned),
            budget.vm_steps_used(),
        )
    };
    // The Revisions already evaluated by the path additions.
    let cached = steps(&["g1", "g2"], ample());
    // Nothing displayed: the judgement evaluates both Revisions itself.
    let uncached = steps(&[], ample());
    println!("MEASURE graph-only, Revisions cached by the path additions: {cached:?}");
    println!("MEASURE graph-only, Revisions evaluated inside the budget: {uncached:?}");
    assert!(cached.0.is_some() && uncached.0.is_some());
    assert!(uncached.1 > cached.1);
    assert!(uncached.1 < GRAPH_ONLY_VM_STEPS / 4);
}
