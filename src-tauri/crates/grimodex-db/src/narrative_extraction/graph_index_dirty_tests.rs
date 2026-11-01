//! X1-5 acceptance for `scope-storage-authority` /3 (Delta 8 (b)-(f), tests
//! 18-1 to 18-12): the change feed dirties the Graph Index (B) for every
//! transaction except a declaration-only one and a body-only one. A body-only
//! transaction (a closed allow-list) dirties the Chronicle IR Index alone.
//! These use the real writers and the X1-2 typed-Revision fixture; the
//! Chronicle Index is a metadata row here because only its dirty flag is
//! under test (its build is exercised in `nir1_chronicle_index`).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use rusqlite::params;
use serde_json::{json, Value};

use super::change_feed::{
    append_canonical_and_narrative_change_in_tx, transaction_is_scene_body_only,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin, SCENE_BODY_ONLY_CHANGED_PATHS,
};
use super::nir1_chronicle_index::{NirChronicleIndexRuntime, INDEX_KEY as CHRONICLE_INDEX_KEY};
use super::nir1_entity_relation::create_nir1_entity_relation_revision;
use super::nir1_entity_relation::tests::{append_typed_decision, request};
use super::nir1_entity_relation_index::{self, INDEX_KEY as GRAPH_INDEX_KEY};
use super::scene_scope::{read_narrative_scene_scope, NarrativeSceneScopeUpdateV1};
use super::scope_storage_authority_tests::{approved_fixture, patch, PROJECT};
use super::{
    update_narrative_scene_scope, update_narrative_scene_scope_registry,
    NarrativeSceneScopeRegistryUpdatePayload, NarrativeSceneScopeUpdatePayload,
};
use crate::agent_writes::{agent_codex_update_impl, AgentCodexUpdatePayload};
use crate::change_events::AppendChangeEvent;
use crate::domain_writes::{
    apply_codex_rename, tree_node_create, tree_node_delete, tree_node_patch, tree_patch_path,
    CodexRenameApplyPayload, CodexRenameUndoUpdate, TreeNodeCreatePayload, TreeNodeDeletePayload,
    TreeNodePatchPayload, TREE_NODE_PATCH_COLUMNS,
};
use crate::revision_restore::{restore_scene_revision, RestoreSceneRevisionPayload};
use crate::scene_body::{
    save_scene_body_bundle, SaveSceneBodyBundlePayload, SceneForeshadowSetupInput,
};
use crate::Database;
use grimodex_core::narrative_scene_scope::NarrativeScopeConstraintV1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IndexRow {
    generation: i64,
    dirty: i64,
}

fn index_row(db: &Database, key: &str) -> Result<IndexRow> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT generation, dirty_cache_flag FROM narrative_semantic_index_metadata
              WHERE project_id = ?1 AND index_key = ?2",
            params![PROJECT, key],
            |row| {
                Ok(IndexRow {
                    generation: row.get(0)?,
                    dirty: row.get(1)?,
                })
            },
        )?)
    })
}

fn graph(db: &Database) -> Result<IndexRow> {
    index_row(db, GRAPH_INDEX_KEY)
}

fn chronicle(db: &Database) -> Result<IndexRow> {
    index_row(db, CHRONICLE_INDEX_KEY)
}

fn graph_complete(db: &Database) -> Result<bool> {
    db.with_read_transaction(|conn| {
        nir1_entity_relation_index::is_complete_registered(conn, PROJECT, GRAPH_INDEX_KEY)
    })
}

fn publish_graph(db: &Database, runtime: &NirChronicleIndexRuntime) -> Result<i64> {
    let snapshot = db.with_read_transaction(|conn| {
        nir1_entity_relation_index::prepare_graph_index_build(conn, runtime, PROJECT)
    })?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let binding = nir1_entity_relation_index::publish_nir1_entity_relation_index_in_tx(
            &tx, runtime, snapshot,
        )?;
        tx.commit()?;
        Ok(binding.generation)
    })
}

/// Stands in for the request-driven Chronicle build: only the flag is read.
fn clear_chronicle(db: &Database) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 0
              WHERE project_id = ?1 AND index_key = ?2",
            params![PROJECT, CHRONICLE_INDEX_KEY],
        )?;
        Ok(())
    })
}

struct Published {
    db: Database,
    runtime: NirChronicleIndexRuntime,
    revision: String,
}

/// An approved typed Revision (anchored at `a3-source`), B published and
/// complete, and a clean Chronicle Index row.
fn published() -> Result<Published> {
    published_with(|_| Ok(()))
}

/// `published` with extra fixture rows written before B is published.
fn published_with(setup: impl FnOnce(&Database) -> Result<()>) -> Result<Published> {
    let (db, revision) = approved_fixture()?;
    setup(&db)?;
    let runtime = NirChronicleIndexRuntime::new(&db, 1);
    publish_graph(&db, &runtime)?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_index_metadata
                (project_id, index_key, generation, built_at, source_digest,
                 dependency_set_digest, dirty_cache_flag)
             VALUES (?1, ?2, 1, '2026-11-01T00:00:00.000Z', 'source', 'deps', 0)",
            params![PROJECT, CHRONICLE_INDEX_KEY],
        )?;
        Ok(())
    })?;
    assert_eq!(graph(&db)?.dirty, 0);
    assert!(graph_complete(&db)?);
    Ok(Published {
        db,
        runtime,
        revision,
    })
}

impl Published {
    /// After a write that must dirty B: B is dirty with the same generation
    /// and incomplete, Chronicle is dirty; then rebuild B and clear Chronicle.
    fn expect_both_dirty(&self, step: &str) -> Result<()> {
        let row = graph(&self.db)?;
        assert_eq!(row.dirty, 1, "{step}: B must be dirty");
        assert!(!graph_complete(&self.db)?, "{step}: B must be incomplete");
        assert_eq!(
            chronicle(&self.db)?.dirty,
            1,
            "{step}: Chronicle must be dirty"
        );
        let generation = publish_graph(&self.db, &self.runtime)?;
        assert_eq!(generation, row.generation + 1, "{step}");
        clear_chronicle(&self.db)?;
        Ok(())
    }

    /// After a body-only write: B is untouched and complete, Chronicle is
    /// dirty; then clear Chronicle.
    fn expect_chronicle_only(&self, before: IndexRow, step: &str) -> Result<()> {
        assert_eq!(graph(&self.db)?, before, "{step}: B must stay clean");
        assert!(graph_complete(&self.db)?, "{step}: B must stay complete");
        assert_eq!(
            chronicle(&self.db)?.dirty,
            1,
            "{step}: Chronicle must be dirty"
        );
        clear_chronicle(&self.db)?;
        Ok(())
    }
}

fn body_payload(scene: &str, tag: &str, updated_at: &str) -> SaveSceneBodyBundlePayload {
    SaveSceneBodyBundlePayload {
        scene_id: scene.to_owned(),
        project_id: PROJECT.to_owned(),
        request_id: format!("x15-body-{tag}-request"),
        session_id: "x15-body-session".to_owned(),
        event_uid: format!("x15-body-{tag}-event"),
        origin: NarrativeChangeOrigin::Human,
        timelapse_steps: None,
        timelapse_doc_step_coverage: None,
        include_sidecars: false,
        base_version: None,
        updated_at: updated_at.to_owned(),
        content_json: format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{tag}"}}]}}]}}"#
        ),
        char_count: tag.chars().count() as i64,
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
    }
}

fn feed_transactions(db: &Database) -> Result<i64> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = ?1",
            [PROJECT],
            |row| row.get(0),
        )?)
    })
}

/// 18-1 and 18-11. Body saves (human and AI apply, with and without
/// sidecars, with timelapse steps, the anchor and the query Scene) leave B
/// clean, at the same generation and complete; every save dirties Chronicle.
#[test]
fn x15_body_only_saves_dirty_the_chronicle_index_alone() -> Result<()> {
    let fx = published()?;
    let before = graph(&fx.db)?;
    let variants: [(&str, &str, NarrativeChangeOrigin, bool, bool); 6] = [
        (
            "human",
            "a3-source",
            NarrativeChangeOrigin::Human,
            false,
            false,
        ),
        (
            "ai-apply",
            "a3-source",
            NarrativeChangeOrigin::AiApply,
            false,
            false,
        ),
        (
            "sidecars",
            "a3-source",
            NarrativeChangeOrigin::Human,
            true,
            false,
        ),
        (
            "doc-step",
            "a3-source",
            NarrativeChangeOrigin::Human,
            false,
            true,
        ),
        (
            "doc-step-ai",
            "nir1",
            NarrativeChangeOrigin::AiApply,
            true,
            true,
        ),
        (
            "query-scene",
            "nir1",
            NarrativeChangeOrigin::Human,
            false,
            false,
        ),
    ];
    for (index, (tag, scene, origin, sidecars, steps)) in variants.into_iter().enumerate() {
        let mut payload = body_payload(scene, tag, &format!("2026-11-01T01:00:0{index}.000Z"));
        payload.origin = origin;
        payload.include_sidecars = sidecars;
        if steps {
            payload.timelapse_steps = Some(vec![json!({
                "stepType": "replace",
                "from": 1,
                "to": 1,
                "slice": { "content": [] }
            })]);
        }
        let transactions = feed_transactions(&fx.db)?;
        save_scene_body_bundle(&fx.db, payload)?;
        assert_eq!(
            feed_transactions(&fx.db)?,
            transactions + 1,
            "{tag}: one feed transaction"
        );
        fx.expect_chronicle_only(before, tag)?;
    }
    let source_domains: BTreeSet<String> = fx.db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT DISTINCT source_domain FROM narrative_change_transactions
              WHERE project_id = ?1 AND request_id LIKE 'x15-body-%'",
        )?;
        let rows = statement
            .query_map([PROJECT], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    assert_eq!(
        source_domains,
        ["doc.step", "scene-body.save"]
            .map(str::to_owned)
            .into_iter()
            .collect(),
        "both source domains were exercised"
    );
    super::scope_storage_authority_tests::assert_revision_current(
        &fx.db,
        &fx.revision,
        "after body-only saves",
    )?;
    Ok(())
}

/// 18-2. A save that changes a foreshadow setup writes a `foreshadow` event in
/// the same transaction and dirties B too.
#[test]
fn x15_a_save_that_changes_a_foreshadow_dirties_the_graph_index() -> Result<()> {
    let fx = published()?;
    fx.db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('x15-foreshadow', ?1, 'Setup', 0, 0, 0, 1, 1)",
            [PROJECT],
        )?;
        Ok(())
    })?;
    let mut payload = body_payload("a3-source", "foreshadow", "2026-11-01T02:00:00.000Z");
    payload.include_sidecars = true;
    payload.foreshadow_setups = vec![SceneForeshadowSetupInput {
        id: "x15-setup".into(),
        foreshadow_id: "x15-foreshadow".into(),
        base_version: 0,
        from_pos: 1,
        to_pos: 3,
    }];
    payload.foreshadow_base_versions = [("x15-foreshadow".to_owned(), 0)].into_iter().collect();
    save_scene_body_bundle(&fx.db, payload)?;
    let kinds: Vec<String> = fx.db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT json_extract(event.object_key_json, '$.kind')
               FROM narrative_change_events event
               JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
              WHERE tx.request_id = 'x15-body-foreshadow-request'
              ORDER BY event.event_ordinal",
        )?;
        let rows = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    assert_eq!(kinds, ["scene", "foreshadow"]);
    fx.expect_both_dirty("foreshadow")
}

fn probe_scene(db: &Database, id: &str) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES (?1, ?2, 'scene', 'Probe', '{}', 'z0')",
            params![id, PROJECT],
        )?;
        super::ensure_scene_scope_binding_in_tx(conn, PROJECT, id, "2026-11-01T00:00:00.000Z")?;
        Ok(())
    })
}

fn event(
    object_key: Value,
    change: &str,
    mutation: &str,
    paths: &[&str],
) -> NarrativeChangeEventInput {
    let (before, after) = match mutation {
        "create" | "restore" => (None, Some(1)),
        "delete" => (Some(1), None),
        _ => (Some(1), Some(2)),
    };
    NarrativeChangeEventInput {
        object_key,
        change_kind: change.to_owned(),
        mutation_kind: mutation.to_owned(),
        before_version: before,
        before_digest: None,
        after_version: after,
        after_digest: None,
        changed_paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        text_impact: None,
        structural_impact: None,
    }
}

fn body_event(scene: &str) -> NarrativeChangeEventInput {
    event(
        json!({ "kind": "scene", "sceneId": scene }),
        "content",
        "update",
        &["/charCount", "/content", "/placedBeatPreview"],
    )
}

fn declaration_event(scene: &str) -> NarrativeChangeEventInput {
    event(
        json!({ "kind": "scene-body-declaration", "sceneId": scene }),
        "metadata",
        "update",
        &["/bodyDeclaration"],
    )
}

fn input(
    cause: NarrativeChangeCauseKind,
    origin: NarrativeChangeOrigin,
    events: Vec<NarrativeChangeEventInput>,
) -> AppendNarrativeChangeTransactionInput {
    let uid = uuid::Uuid::new_v4().to_string();
    AppendNarrativeChangeTransactionInput {
        project_id: PROJECT.to_owned(),
        request_id: format!("x15-feed-{uid}"),
        source_domain: "x15.feed-probe".to_owned(),
        source_change_event_uid: uid,
        cause_kind: cause,
        origin,
        original_transaction_id: None,
        commit_id: None,
        journal_id: None,
        undo_journal_id: None,
        application_ids: vec![],
        occurred_at: "2026-11-01T00:00:00.000Z".to_owned(),
        events,
    }
}

fn forward(events: Vec<NarrativeChangeEventInput>) -> AppendNarrativeChangeTransactionInput {
    input(
        NarrativeChangeCauseKind::Forward,
        NarrativeChangeOrigin::Human,
        events,
    )
}

/// A test writer: one canonical event and one feed transaction through the
/// production append, in one write transaction.
fn append_probe(db: &Database, narrative: &AppendNarrativeChangeTransactionInput) -> Result<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        append_canonical_and_narrative_change_in_tx(
            &tx,
            PROJECT,
            "x15-feed-session",
            &AppendChangeEvent {
                event_uid: narrative.source_change_event_uid.clone(),
                scene_id: None,
                domain: "editor".to_owned(),
                op_type: narrative.source_domain.clone(),
                entity_type: None,
                entity_id: None,
                payload: "{}".to_owned(),
                timestamp: 1,
            },
            narrative,
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// 18-3, 18-6 and 18-10 (the helper). The closed allow-list and its
/// fail-safe edges, one property at a time.
#[test]
fn x15_body_only_classification_is_a_closed_allow_list() {
    let body = body_event("s");
    assert!(transaction_is_scene_body_only(&forward(vec![body.clone()])));
    // Every P_body path, sidecars included, is a body path.
    let all = event(
        json!({ "kind": "scene", "sceneId": "s" }),
        "content",
        "update",
        &SCENE_BODY_ONLY_CHANGED_PATHS,
    );
    assert!(transaction_is_scene_body_only(&forward(vec![all])));
    assert!(transaction_is_scene_body_only(&input(
        NarrativeChangeCauseKind::Forward,
        NarrativeChangeOrigin::AiApply,
        vec![body.clone()],
    )));
    // 18-3: body + declaration is body-only; a declaration alone is not
    // (the declaration rule handles it); any other kind added is not.
    assert!(transaction_is_scene_body_only(&forward(vec![
        body.clone(),
        declaration_event("s")
    ])));
    assert!(!transaction_is_scene_body_only(&forward(vec![
        declaration_event("s")
    ])));
    let others = [
        event(
            json!({"kind": "scene", "sceneId": "s"}),
            "content",
            "update",
            &["/content", "/title"],
        ),
        event(
            json!({"kind": "scene", "sceneId": "s"}),
            "metadata",
            "update",
            &["/title"],
        ),
        event(
            json!({"kind": "component", "componentId": "tree-node:f"}),
            "content",
            "update",
            &["/content"],
        ),
        event(
            json!({"kind": "scene-scope", "sceneId": "s"}),
            "metadata",
            "update",
            &["/scope"],
        ),
        event(
            json!({"kind": "scope-registry", "projectId": PROJECT}),
            "metadata",
            "update",
            &["/registry"],
        ),
        event(
            json!({"kind": "foreshadow", "foreshadowId": "f"}),
            "association",
            "update",
            &["/payoffs", "/setups"],
        ),
        event(
            json!({"kind": "codex-entry", "entryId": "c"}),
            "content",
            "update",
            &["/summary"],
        ),
        event(
            json!({"kind": "project", "projectId": PROJECT}),
            "metadata",
            "update",
            &["/"],
        ),
    ];
    for other in &others {
        assert!(
            !transaction_is_scene_body_only(&forward(vec![body.clone(), other.clone()])),
            "{other:?}"
        );
        assert!(
            !transaction_is_scene_body_only(&forward(vec![other.clone()])),
            "{other:?}"
        );
    }
    // 18-10: each P_body-outside path of a Scene, alone or with a body path.
    for path in [
        "/title",
        "/parentId",
        "/sortOrder",
        "/storyTimeOrder",
        "/archivedAt",
        "/povCharacterId",
        "/updatedAt",
        "/synopsis",
        "/status",
        "/storyTimeLabel",
        "/locationId",
        "/",
    ] {
        let scene = event(
            json!({"kind": "scene", "sceneId": "s"}),
            "content",
            "update",
            &["/content", path],
        );
        assert!(
            !transaction_is_scene_body_only(&forward(vec![scene])),
            "{path}"
        );
    }
    // 18-5: cause and origin.
    for (cause, origin) in [
        (NarrativeChangeCauseKind::Undo, NarrativeChangeOrigin::Undo),
        (NarrativeChangeCauseKind::Redo, NarrativeChangeOrigin::Redo),
        (NarrativeChangeCauseKind::Undo, NarrativeChangeOrigin::Human),
        (
            NarrativeChangeCauseKind::Forward,
            NarrativeChangeOrigin::Undo,
        ),
        (
            NarrativeChangeCauseKind::Forward,
            NarrativeChangeOrigin::Redo,
        ),
        (
            NarrativeChangeCauseKind::Forward,
            NarrativeChangeOrigin::Restore,
        ),
        (
            NarrativeChangeCauseKind::Forward,
            NarrativeChangeOrigin::Import,
        ),
        (
            NarrativeChangeCauseKind::Forward,
            NarrativeChangeOrigin::Migration,
        ),
    ] {
        assert!(
            !transaction_is_scene_body_only(&input(cause, origin, vec![body.clone()])),
            "{cause:?} {origin:?}"
        );
    }
    // 18-6: events that cannot be classified, and no event.
    let mut unclassified = Vec::new();
    for key in [
        json!(null),
        json!("scene"),
        json!({ "sceneId": "s" }),
        json!({ "kind": "scenes", "sceneId": "s" }),
        json!({ "kind": "scene" }),
        json!({ "kind": "scene", "sceneId": "" }),
        json!({ "kind": "scene", "sceneId": 7 }),
        json!({ "kind": "scene", "sceneId": "s", "extra": "x" }),
    ] {
        unclassified.push(event(key, "content", "update", &["/content"]));
    }
    unclassified.push(event(
        json!({"kind": "scene", "sceneId": "s"}),
        "content",
        "update",
        &[],
    ));
    unclassified.push(event(
        json!({"kind": "scene", "sceneId": "s"}),
        "contents",
        "update",
        &["/content"],
    ));
    unclassified.push(event(
        json!({"kind": "scene", "sceneId": "s"}),
        "content",
        "upsert",
        &["/content"],
    ));
    for mutation in ["create", "delete", "restore"] {
        unclassified.push(event(
            json!({"kind": "scene", "sceneId": "s"}),
            "content",
            mutation,
            &["/content"],
        ));
    }
    for item in &unclassified {
        assert!(
            !transaction_is_scene_body_only(&forward(vec![item.clone()])),
            "{item:?}"
        );
        assert!(
            !transaction_is_scene_body_only(&forward(vec![body.clone(), item.clone()])),
            "{item:?}"
        );
    }
    assert!(!transaction_is_scene_body_only(&forward(vec![])));
}

/// 18-3, 18-5 and 18-6 through the production append (a test writer): the
/// dispatch at the end of the feed append follows the classification.
#[test]
fn x15_feed_append_dispatch_follows_the_classification() -> Result<()> {
    let fx = published_with(|db| {
        for index in 0..8 {
            probe_scene(db, &format!("x15-probe-{index}"))?;
        }
        Ok(())
    })?;
    let before = graph(&fx.db)?;
    append_probe(&fx.db, &forward(vec![body_event("x15-probe-0")]))?;
    fx.expect_chronicle_only(before, "body event")?;
    append_probe(
        &fx.db,
        &forward(vec![
            body_event("x15-probe-1"),
            declaration_event("x15-probe-1"),
        ]),
    )?;
    fx.expect_chronicle_only(before, "body + declaration")?;
    append_probe(&fx.db, &forward(vec![declaration_event("x15-probe-2")]))?;
    assert_eq!(graph(&fx.db)?, before, "declaration only");
    assert_eq!(chronicle(&fx.db)?.dirty, 0, "declaration only (C17)");

    append_probe(
        &fx.db,
        &forward(vec![
            body_event("x15-probe-3"),
            event(
                json!({"kind": "scene", "sceneId": "x15-probe-4"}),
                "metadata",
                "update",
                &["/title"],
            ),
        ]),
    )?;
    fx.expect_both_dirty("body + title")?;
    append_probe(
        &fx.db,
        &forward(vec![
            body_event("x15-probe-5"),
            event(
                json!({"kind": "scene-scope", "sceneId": "x15-probe-5"}),
                "metadata",
                "update",
                &["/scope"],
            ),
        ]),
    )?;
    fx.expect_both_dirty("body + scene-scope")?;
    append_probe(
        &fx.db,
        &input(
            NarrativeChangeCauseKind::Forward,
            NarrativeChangeOrigin::Import,
            vec![body_event("x15-probe-6")],
        ),
    )?;
    fx.expect_both_dirty("origin import")?;
    append_probe(
        &fx.db,
        &forward(vec![event(
            json!({"kind": "scene", "sceneId": "x15-probe-7", "extra": "x"}),
            "content",
            "update",
            &["/content"],
        )]),
    )
    .map_or_else(
        |error| {
            assert_eq!(
                graph(&fx.db).unwrap(),
                before,
                "a refused append writes nothing: {error}"
            );
            Ok(())
        },
        |()| fx.expect_both_dirty("object key with an extra field"),
    )?;
    // Events the feed refuses leave both Indexes as they were.
    let before = graph(&fx.db)?;
    for bad in [
        forward(vec![]),
        forward(vec![event(
            json!({"kind": "scene"}),
            "content",
            "update",
            &["/content"],
        )]),
        forward(vec![event(
            json!({"kind": "unknown", "id": "x"}),
            "content",
            "update",
            &["/content"],
        )]),
        forward(vec![event(
            json!({"kind": "scene", "sceneId": "x15-probe-0"}),
            "content",
            "update",
            &[],
        )]),
        forward(vec![event(
            json!({"kind": "scene", "sceneId": "x15-probe-0"}),
            "contents",
            "update",
            &["/content"],
        )]),
    ] {
        assert!(append_probe(&fx.db, &bad).is_err());
        assert_eq!(graph(&fx.db)?, before);
        assert_eq!(chronicle(&fx.db)?.dirty, 0);
    }
    Ok(())
}

fn patch_fields(
    db: &Database,
    scene: &str,
    tag: &str,
    fields: Value,
    updated_at: &str,
) -> Result<Value> {
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: PROJECT.to_owned(),
            request_id: format!("x15-patch-{tag}-request"),
            session_id: "x15-patch-session".to_owned(),
            event_uid: format!("x15-patch-{tag}-event"),
            node_id: scene.to_owned(),
            patch: fields.as_object().cloned().expect("patch object"),
            base_version: None,
            bump_version: true,
            updated_at: updated_at.to_owned(),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )
}

/// 18-4. A `content`-only Scene patch is body-only; `content` with `title`
/// (change kind `content`), and each Scope or display field, dirty B.
#[test]
fn x15_scene_patch_is_body_only_only_for_body_fields() -> Result<()> {
    let fx = published()?;
    let before = graph(&fx.db)?;
    patch(
        &fx.db,
        "a3-source",
        "content",
        "content",
        json!("{}"),
        true,
        "2026-11-01T03:00:00.000Z",
    )?;
    fx.expect_chronicle_only(before, "content")?;
    patch_fields(
        &fx.db,
        "a3-source",
        "body-fields",
        json!({"content": "{\"type\":\"doc\"}", "charCount": 3, "placedBeatPreview": null}),
        "2026-11-01T03:00:01.000Z",
    )?;
    fx.expect_chronicle_only(before, "body fields")?;
    tree_node_create(
        &fx.db,
        TreeNodeCreatePayload {
            id: "x15-folder".to_owned(),
            project_id: PROJECT.to_owned(),
            request_id: "x15-folder-create".to_owned(),
            session_id: "x15-session".to_owned(),
            event_uid: "x15-folder-create-event".to_owned(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "folder".to_owned(),
            title: "Folder".to_owned(),
            sort_order: "b0".to_owned(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: None,
            canonical_payload: None,
        },
    )?;
    fx.expect_both_dirty("folder create")?;
    let dirtying: [(&str, Value); 7] = [
        ("content-title", json!({"content": "{}", "title": "Both"})),
        ("title", json!({"title": "Renamed"})),
        ("synopsis", json!({"synopsis": "Short"})),
        ("pov", json!({"povCharacterId": "nir1-alice"})),
        ("sort", json!({"sortOrder": "a9"})),
        ("parent", json!({"parentId": "x15-folder"})),
        ("archive", json!({"archivedAt": "2026-11-01T03:59:00.000Z"})),
    ];
    for (index, (tag, fields)) in dirtying.into_iter().enumerate() {
        patch_fields(
            &fx.db,
            "a3-future",
            tag,
            fields,
            &format!("2026-11-01T03:10:0{index}.000Z"),
        )?;
        fx.expect_both_dirty(tag)?;
    }
    // A key that has no feed path is refused before anything is written.
    let refused = patch_fields(
        &fx.db,
        "a3-source",
        "unsupported",
        json!({"content": "{}", "notAColumn": 1}),
        "2026-11-01T03:20:00.000Z",
    );
    assert!(refused
        .unwrap_err()
        .to_string()
        .contains("unsupported field"));
    let before = graph(&fx.db)?;
    assert_eq!(before.dirty, 0);
    assert_eq!(chronicle(&fx.db)?.dirty, 0);
    Ok(())
}

/// 18-4. Every column the patch writer accepts has its own feed path, so a
/// patch cannot write a column its feed event does not name.
#[test]
fn x15_tree_node_patch_columns_map_one_to_one_to_feed_paths() {
    let mut wires = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for (wire, column) in TREE_NODE_PATCH_COLUMNS {
        assert!(wires.insert(wire), "{wire}");
        let path = tree_patch_path(wire).unwrap_or_else(|| panic!("{wire} ({column}) has no path"));
        assert!(paths.insert(path), "{wire} shares {path}");
    }
    assert_eq!(paths.len(), 28);
    for key in ["updatedAt", "version", "nodeType", "projectId", "id"] {
        assert_eq!(tree_patch_path(key), None, "{key}");
    }
    // The body paths of the patch writer are inside P_body; the others are not.
    for path in &paths {
        let body = matches!(
            *path,
            "/content"
                | "/charCount"
                | "/placedBeatPreview"
                | "/unplacedBeatPreview"
                | "/unplacedBeatsDoc"
        );
        assert_eq!(SCENE_BODY_ONLY_CHANGED_PATHS.contains(path), body, "{path}");
    }
}

/// 18-5. A body version restore (origin `restore`) and the undo of a
/// body-only patch dirty B even though their events are body events.
#[test]
fn x15_restore_and_undo_of_a_body_write_dirty_the_graph_index() -> Result<()> {
    let fx = published()?;
    let before = graph(&fx.db)?;
    patch(
        &fx.db,
        "a3-source",
        "undo-base",
        "content",
        json!("{\"type\":\"doc\",\"content\":[]}"),
        true,
        "2026-11-01T04:00:00.000Z",
    )?;
    fx.expect_chronicle_only(before, "forward content patch")?;
    let (transaction_id, journal_id): (String, Option<String>) = fx.db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id, undo_journal_id FROM narrative_change_transactions
              WHERE request_id = 'x12-patch-undo-base-request'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })?;
    let mut fields = serde_json::Map::new();
    fields.insert("content".to_owned(), json!("{}"));
    tree_node_patch(
        &fx.db,
        TreeNodePatchPayload {
            project_id: PROJECT.to_owned(),
            request_id: "x15-undo-request".to_owned(),
            session_id: "x15-patch-session".to_owned(),
            event_uid: "x15-undo-event".to_owned(),
            node_id: "a3-source".to_owned(),
            patch: fields,
            base_version: None,
            bump_version: true,
            updated_at: "2026-11-01T04:00:01.000Z".to_owned(),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Undo,
            original_transaction_id: Some(transaction_id),
            undo_journal_id: journal_id,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )?;
    fx.expect_both_dirty("undo of a content patch")?;

    let (content, version): (String, i64) = fx.db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO content_versions
                (id, entity_type, entity_id, content, version_number, snapshot_type)
             VALUES ('x15-version', 'scene', 'a3-source', '{\"type\":\"doc\"}', 1, 'auto')",
            [],
        )?;
        Ok(conn.query_row(
            "SELECT content, version FROM tree_nodes WHERE id = 'a3-source'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })?;
    restore_scene_revision(
        &fx.db,
        RestoreSceneRevisionPayload {
            request_id: "x15-restore-request".to_owned(),
            session_id: "x15-session".to_owned(),
            project_id: PROJECT.to_owned(),
            entity_type: "scene".to_owned(),
            entity_id: "a3-source".to_owned(),
            revision_id: "x15-version".to_owned(),
            content: "{\"type\":\"doc\"}".to_owned(),
            current_content: content,
            expected_version: version,
            char_count: 0,
            placed_beat_preview: None,
        },
    )?;
    fx.expect_both_dirty("body version restore")
}

fn set_material_timeline_unresolved(db: &Database, scene: &str, tag: &str) -> Result<()> {
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene))?;
    let mut material_constraint = current.binding.material_constraint.clone();
    material_constraint.timeline = NarrativeScopeConstraintV1::Unresolved {
        reason: tag.to_owned(),
    };
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.to_owned(),
            scene_id: scene.to_owned(),
            request_id: format!("x15-a1-{tag}"),
            session_id: "x15-session".to_owned(),
            event_uid: format!("x15-a1-{tag}-event"),
            base_version: current.binding.version,
            updated_at: "2026-11-01T05:00:00.000Z".to_owned(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: current.binding.schema_version,
                compatibility_marker: current.binding.compatibility_marker,
                query_identity: current.binding.query_identity.clone(),
                material_constraint,
                knowledge_holder: current.binding.knowledge_holder.clone(),
                audience: current.binding.audience.clone(),
            },
        },
    )?;
    Ok(())
}

fn codex_version(db: &Database, entry: &str) -> Result<i64> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM codex_entries WHERE id = ?1",
            [entry],
            |row| row.get(0),
        )?)
    })
}

fn update_codex_summary(db: &Database, entry: &str, summary: &str) -> Result<()> {
    let base_version = codex_version(db, entry)?;
    agent_codex_update_impl(
        db,
        AgentCodexUpdatePayload {
            project_id: PROJECT.to_owned(),
            session_id: "x15-codex-session".to_owned(),
            surface: None,
            entry_id: entry.to_owned(),
            base_version,
            type_slug: None,
            name: None,
            summary: Some(summary.to_owned()),
            content: None,
            timelapse_doc_step_coverage: None,
            aliases: None,
            excluded_aliases: None,
            readings: None,
            tags_cache: None,
            parent_id: None,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: None,
            authorship_span_lanes: None,
        },
    )?;
    Ok(())
}

fn rename_payload(tag: &str, updates: Vec<CodexRenameUndoUpdate>) -> CodexRenameApplyPayload {
    CodexRenameApplyPayload {
        request_id: format!("x15-rename-{tag}-request"),
        project_id: PROJECT.to_owned(),
        session_id: "x15-rename-session".to_owned(),
        surface: Some("x15".to_owned()),
        entry_id: "nir1-bob".to_owned(),
        updated_at: "2026-11-01T06:00:00.000Z".to_owned(),
        updates,
        event_summary: "{}".to_owned(),
        event_uid: format!("x15-rename-{tag}-event"),
        timestamp: 1,
        redo: false,
        original_transaction_id: None,
        undo_journal_id: None,
    }
}

fn scene_version(db: &Database, scene: &str) -> Result<i64> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM tree_nodes WHERE id = ?1",
            [scene],
            |row| row.get(0),
        )?)
    })
}

/// 18-7 and 18-12. Writers of a B input dirty B in the same transaction as
/// today, through the feed or through the paths outside it. The Codex
/// summary edit is the write G-08's `graph-index-unusable` variant makes.
#[test]
fn x15_graph_input_writers_still_dirty_the_graph_index() -> Result<()> {
    let fx = published()?;
    let mut second = request(&fx.db);
    second.proposal_key = "nir1:review:x15-second".to_owned();
    let created = create_nir1_entity_relation_revision(&fx.db, second)?;
    fx.expect_both_dirty("typed Revision write")?;
    append_typed_decision(&fx.db, "nir1-run", &created, "rejected")?;
    fx.expect_both_dirty("Decision")?;
    update_codex_summary(&fx.db, "nir1-bob", "Bob, the summary edit")?;
    fx.expect_both_dirty("Codex summary edit (G-08)")?;
    let entry_version = codex_version(&fx.db, "nir1-bob")?;
    apply_codex_rename(
        &fx.db,
        rename_payload(
            "summary",
            vec![CodexRenameUndoUpdate {
                kind: "codex-summary".to_owned(),
                ref_id: "nir1-bob".to_owned(),
                detail_definition_id: None,
                base_version: entry_version,
                value: "Robert".to_owned(),
                char_count: None,
                placed_beat_preview: None,
            }],
        ),
    )?;
    fx.expect_both_dirty("Codex rename with a summary update")?;
    set_material_timeline_unresolved(&fx.db, "a3-future", "a1")?;
    fx.expect_both_dirty("A1 setting")?;
    let current = fx
        .db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "nir1"))?;
    let mut timeline_refs = current.registry.timeline_refs.clone();
    timeline_refs.push("timeline:x15".to_owned());
    update_narrative_scene_scope_registry(
        &fx.db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: PROJECT.to_owned(),
            request_id: "x15-registry".to_owned(),
            session_id: "x15-session".to_owned(),
            event_uid: "x15-registry-event".to_owned(),
            base_version: current.registry_revision,
            updated_at: "2026-11-01T06:00:01.000Z".to_owned(),
            registry: grimodex_core::narrative_scene_scope::NarrativeSceneScopeRegistryV1 {
                timeline_refs,
                ..current.registry
            },
        },
    )?;
    fx.expect_both_dirty("registry")?;
    tree_node_create(
        &fx.db,
        TreeNodeCreatePayload {
            id: "x15-new-scene".to_owned(),
            project_id: PROJECT.to_owned(),
            request_id: "x15-scene-create".to_owned(),
            session_id: "x15-session".to_owned(),
            event_uid: "x15-scene-create-event".to_owned(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".to_owned(),
            title: "New".to_owned(),
            sort_order: "c0".to_owned(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".to_owned()),
            canonical_payload: None,
        },
    )?;
    fx.expect_both_dirty("Scene create")?;
    tree_node_delete(
        &fx.db,
        TreeNodeDeletePayload {
            project_id: PROJECT.to_owned(),
            request_id: "x15-scene-delete".to_owned(),
            session_id: "x15-session".to_owned(),
            event_uid: "x15-scene-delete-event".to_owned(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: "x15-new-scene".to_owned(),
            canonical_payload: None,
        },
    )?;
    fx.expect_both_dirty("Scene delete")?;
    fx.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        super::create_epoch_in_tx(&tx, PROJECT, "integrity-repair", None)?;
        tx.commit()?;
        Ok(())
    })?;
    fx.expect_both_dirty("semantic epoch")
}

fn typed_publisher(db: &Database, revision: &str) -> Result<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT last_evaluated_run_id FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'proposal-revision' AND consumer_key = ?2",
            params![PROJECT, revision],
            |row| row.get(0),
        )?)
    })
}

/// 18-16 (real writers). A typed Revision's Freshness is a B input: after a
/// Codex edit (which dirties B through the feed) and a rebuild, the
/// incremental Freshness publish of the typed consumer (a new publisher)
/// dirties B again through the Freshness hook.
#[test]
fn x15_typed_revision_freshness_still_dirties_the_graph_index() -> Result<()> {
    let fx = published()?;
    update_codex_summary(&fx.db, "nir1-alice", "Alice, edited")?;
    fx.expect_both_dirty("Codex edit")?;
    let publisher_before = typed_publisher(&fx.db, &fx.revision)?;
    while matches!(
        super::incremental_freshness::run_incremental_freshness_cycle(&fx.db)?,
        super::incremental_freshness::IncrementalFreshnessCycleOutcome::Processed(_)
    ) {}
    assert_ne!(
        typed_publisher(&fx.db, &fx.revision)?,
        publisher_before,
        "a new publisher"
    );
    fx.expect_both_dirty("typed Revision Freshness")
}

/// 18-8. A registration lent before a body-only save stays usable after it;
/// a Codex summary edit makes it unusable in the same commit.
#[test]
fn x15_a_lent_registration_survives_a_body_save_but_not_a_graph_input_write() -> Result<()> {
    let fx = published()?;
    let before = graph(&fx.db)?;
    let snapshot = fx.db.with_read_transaction(|conn| {
        nir1_entity_relation_index::prepare_graph_index_build(conn, &fx.runtime, PROJECT)
    })?;
    let mut payload = body_payload("a3-source", "lent", "2026-11-01T07:00:00.000Z");
    payload.include_sidecars = true;
    save_scene_body_bundle(&fx.db, payload)?;
    assert_eq!(graph(&fx.db)?, before);
    assert!(graph_complete(&fx.db)?, "the registration is still usable");
    // A snapshot sealed before the save still describes B's input.
    let republished = fx.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let binding = nir1_entity_relation_index::publish_nir1_entity_relation_index_in_tx(
            &tx,
            &fx.runtime,
            snapshot,
        )?;
        tx.commit()?;
        Ok(binding.generation)
    })?;
    assert_eq!(republished, before.generation + 1);
    let stale = fx.db.with_read_transaction(|conn| {
        nir1_entity_relation_index::prepare_graph_index_build(conn, &fx.runtime, PROJECT)
    })?;
    update_codex_summary(&fx.db, "nir1-alice", "Alice, changed")?;
    assert!(
        !graph_complete(&fx.db)?,
        "the same commit made the registration unusable"
    );
    let error = fx.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let outcome = nir1_entity_relation_index::publish_nir1_entity_relation_index_in_tx(
            &tx,
            &fx.runtime,
            stale,
        );
        tx.rollback()?;
        Ok(outcome.err().map(|error| error.to_string()))
    })?;
    assert!(
        error
            .as_deref()
            .is_some_and(|error| error.contains("NIR1_GRAPH_SNAPSHOT_STALE")),
        "{error:?}"
    );
    Ok(())
}

/// The tables a body-only transaction must not write: the Graph Index's
/// inputs (B's roster, typed Revisions and their Decisions, Codex, the Scene
/// Scope bindings and registry, the semantic epoch).
const GRAPH_INPUT_TABLES: [&str; 10] = [
    "codex_entries",
    "codex_relations",
    "narrative_proposal_sets",
    "narrative_proposals",
    "narrative_proposal_revisions",
    "narrative_proposal_decisions",
    "narrative_scene_scope_bindings",
    "narrative_scope_registries",
    "narrative_semantic_epochs",
    "narrative_extraction_runs",
];

fn scope_columns(db: &Database) -> Result<Vec<Vec<rusqlite::types::Value>>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, node_type, parent_id, sort_order, story_time_order, archived_at,
                    pov_character_id
               FROM tree_nodes WHERE project_id = ?1 ORDER BY id",
        )?;
        let rows = statement
            .query_map([PROJECT], |row| {
                (0..7)
                    .map(|index| row.get(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

/// Run `write` with an update hook and return the tables it wrote.
fn tables_written(db: &Database, write: impl FnOnce() -> Result<()>) -> Result<BTreeSet<String>> {
    let written = Arc::new(Mutex::new(BTreeSet::new()));
    let sink = Arc::clone(&written);
    db.with_conn(|conn| {
        conn.update_hook(Some(
            move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                sink.lock().expect("hook sink").insert(table.to_owned());
            },
        ))?;
        Ok(())
    })?;
    let outcome = write();
    db.with_conn(|conn| {
        conn.update_hook(None::<fn(rusqlite::hooks::Action, &str, &str, i64)>)?;
        Ok(())
    })?;
    outcome?;
    let tables = written.lock().expect("hook sink").clone();
    Ok(tables)
}

type BodyOnlyWriter = Box<dyn FnOnce(&Database) -> Result<()>>;

/// 18-9 (writes). Each writer that can write a body-only transaction, called
/// in that shape, writes none of the Graph Index's input tables and no Scope
/// column of `tree_nodes`.
#[test]
fn x15_body_only_writers_write_no_graph_input() -> Result<()> {
    let fx = published()?;
    let schema_tables: BTreeSet<String> = fx.db.with_conn(|conn| {
        let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let rows = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    for table in GRAPH_INPUT_TABLES {
        assert!(schema_tables.contains(table), "{table} is a table");
    }
    let before = graph(&fx.db)?;
    let scene_version = scene_version(&fx.db, "a3-future")?;
    let writers: Vec<(&str, BodyOnlyWriter)> = vec![
        (
            "save",
            Box::new(|db| {
                save_scene_body_bundle(
                    db,
                    body_payload("a3-source", "hook-save", "2026-11-01T08:00:00.000Z"),
                )?;
                Ok(())
            }),
        ),
        (
            "save-sidecars",
            Box::new(|db| {
                let mut payload = body_payload("nir1", "hook-sidecars", "2026-11-01T08:00:01.000Z");
                payload.include_sidecars = true;
                payload.origin = NarrativeChangeOrigin::AiApply;
                save_scene_body_bundle(db, payload)?;
                Ok(())
            }),
        ),
        (
            "patch",
            Box::new(|db| {
                patch(
                    db,
                    "a3-source",
                    "hook-patch",
                    "content",
                    json!("{}"),
                    true,
                    "2026-11-01T08:00:02.000Z",
                )
            }),
        ),
        (
            "rename-scene-body",
            Box::new(move |db| {
                apply_codex_rename(
                    db,
                    rename_payload(
                        "hook-scene",
                        vec![CodexRenameUndoUpdate {
                            kind: "scene-body".to_owned(),
                            ref_id: "a3-future".to_owned(),
                            detail_definition_id: None,
                            base_version: scene_version,
                            value: r#"{"type":"doc","content":[]}"#.to_owned(),
                            char_count: Some(0),
                            placed_beat_preview: None,
                        }],
                    ),
                )?;
                Ok(())
            }),
        ),
    ];
    for (name, writer) in writers {
        let scope_before = scope_columns(&fx.db)?;
        let tables = tables_written(&fx.db, || writer(&fx.db))?;
        let graph_inputs: Vec<&str> = GRAPH_INPUT_TABLES
            .into_iter()
            .filter(|table| tables.contains(*table))
            .collect();
        assert!(graph_inputs.is_empty(), "{name} wrote {graph_inputs:?}");
        assert!(
            tables.contains("narrative_change_transactions"),
            "{name} wrote a feed transaction"
        );
        assert_eq!(
            scope_columns(&fx.db)?,
            scope_before,
            "{name} moved a Scope column"
        );
        fx.expect_chronicle_only(before, name)?;
    }
    Ok(())
}

/// The source patterns that build a Scene feed object key.
const SCENE_KEY_BUILDERS: [&str; 4] = [
    r#""kind": "scene","#,
    r#""kind":"scene","#,
    "narrative_object_key(",
    "tree_object_key(",
];

/// Production source of a file without its test modules.
fn production_source(source: &str) -> &str {
    source
        .split("\n#[cfg(test)]\nmod ")
        .next()
        .unwrap_or(source)
}

/// 18-9 (writers). The production callers of the feed append are pinned per
/// file, and the files that build a Scene feed object key (the only shape a
/// body event can take) are pinned too. A new caller or a new Scene event
/// builder fails here and must be classified: either it cannot write a
/// body-only transaction, or it joins `x15_body_only_writers_write_no_graph_input`.
#[test]
fn x15_feed_append_callers_and_scene_event_builders_are_pinned() {
    let files: [(&str, &str); 21] = [
        (
            "revision_restore.rs",
            include_str!("../revision_restore.rs"),
        ),
        ("scene_body.rs", include_str!("../scene_body.rs")),
        ("chronicle_bulk.rs", include_str!("../chronicle_bulk.rs")),
        ("integrity.rs", include_str!("../integrity.rs")),
        ("chronicle.rs", include_str!("../chronicle.rs")),
        ("snippet_writes.rs", include_str!("../snippet_writes.rs")),
        ("domain_writes.rs", include_str!("../domain_writes.rs")),
        ("agent_writes.rs", include_str!("../agent_writes.rs")),
        ("trash_bin.rs", include_str!("../trash_bin.rs")),
        ("foreshadow.rs", include_str!("../foreshadow.rs")),
        ("codex_writes.rs", include_str!("../codex_writes.rs")),
        (
            "project_snapshots.rs",
            include_str!("../project_snapshots.rs"),
        ),
        ("narrative_extraction/commit.rs", include_str!("commit.rs")),
        ("map_writes.rs", include_str!("../map_writes.rs")),
        (
            "narrative_extraction/scene_scope.rs",
            include_str!("scene_scope.rs"),
        ),
        (
            "narrative_extraction/change_feed.rs",
            include_str!("change_feed.rs"),
        ),
        ("migrate.rs", include_str!("../migrate.rs")),
        ("import/commit.rs", include_str!("../import/commit.rs")),
        ("narrative_extraction/undo.rs", include_str!("undo.rs")),
        ("plot_threads.rs", include_str!("../plot_threads.rs")),
        (
            "narrative_extraction/scene_body_declaration/writer.rs",
            include_str!("scene_body_declaration/writer.rs"),
        ),
    ];
    let mut callers = Vec::new();
    let mut scene_builders = Vec::new();
    for (name, source) in files {
        let production = production_source(source);
        let calls = production
            .matches("append_narrative_change_transaction_in_tx(")
            .count()
            + production
                .matches("append_canonical_and_narrative_change_in_tx(")
                .count();
        callers.push((name, calls));
        if SCENE_KEY_BUILDERS
            .iter()
            .any(|pattern| production.contains(pattern))
        {
            scene_builders.push(name);
        }
    }
    assert_eq!(
        callers,
        [
            ("revision_restore.rs", 1),
            ("scene_body.rs", 1),
            ("chronicle_bulk.rs", 1),
            ("integrity.rs", 1),
            ("chronicle.rs", 2),
            ("snippet_writes.rs", 1),
            ("domain_writes.rs", 7),
            ("agent_writes.rs", 4),
            ("trash_bin.rs", 1),
            ("foreshadow.rs", 1),
            ("codex_writes.rs", 1),
            ("project_snapshots.rs", 1),
            ("narrative_extraction/commit.rs", 1),
            ("map_writes.rs", 1),
            ("narrative_extraction/scene_scope.rs", 2),
            ("narrative_extraction/change_feed.rs", 3),
            ("migrate.rs", 1),
            ("import/commit.rs", 1),
            ("narrative_extraction/undo.rs", 4),
            ("plot_threads.rs", 1),
            ("narrative_extraction/scene_body_declaration/writer.rs", 1),
        ],
        "a new feed append caller must be classified for X1-5"
    );
    // Files that can name a Scene object key, and why each can or cannot
    // write a body-only transaction:
    // - revision_restore.rs: body version restore, origin `restore` (never).
    // - scene_body.rs: the body save (body-only; hook-tested above).
    // - chronicle_bulk.rs: Chronicle date paths, outside P_body (never).
    // - domain_writes.rs: `tree_node_patch` and the Codex rename propagation
    //   (body-only for body fields; hook-tested above). Its AI tree plan and
    //   folder writers name structural paths or `component` keys.
    // - trash_bin.rs: restore from the trash, mutation `restore` (never).
    // - project_snapshots.rs: snapshot restore, origin `restore` (never).
    // - map_writes.rs: promotes a sticky to a new Scene, mutation `create`.
    // - narrative_extraction/change_feed.rs: the generic key mapping and the
    //   append itself (the classification lives here).
    // - plot_threads.rs: plot markers and branches, not Scene keys.
    assert_eq!(
        scene_builders,
        [
            "revision_restore.rs",
            "scene_body.rs",
            "chronicle_bulk.rs",
            "domain_writes.rs",
            "trash_bin.rs",
            "project_snapshots.rs",
            "map_writes.rs",
            "narrative_extraction/change_feed.rs",
            "plot_threads.rs",
        ],
        "a new Scene feed event builder must be classified for X1-5"
    );
}
