//! D group (CB-1 S4): the storage-layer matrix of how a declaration expires.
//!
//! For each row of the draft's 失効 table a declaration is placed with the
//! `#[cfg(test)]` setter, then the real production writer runs. After it:
//!
//! 1. the declaration columns are still stored, byte for byte (a writer never
//!    rewrites a declaration; it expires by its binding);
//! 2. the binding no longer holds against the Scene's current facts;
//! 3. putting the Scene back (title A -> B -> A, an `updatedAt` that is
//!    restored, an interrupted patch, a folder moved and moved back) does not
//!    make the binding hold again.
//!
//! The tests never assert *which* component of the binding differs. Before
//! X1-2 a body or title change moves the v1 token; after X1-2 it moves the
//! body Source token and the title digest. Both orders pass (XK-1, XK-2).
//! The current facts are computed here the way the declaration was bound
//! (CB-4 owns the production reader of the same facts).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::Cell;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationBindingV1, NarrativeSceneBodyDeclarationV1,
    NarrativeSceneBodySourceV1,
};
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};

use super::test_support::*;
use super::*;
use crate::chronicle_bulk::{agent_chronicle_bulk_mutate_impl, AgentChronicleBulkPayload};
use crate::domain_writes::{
    apply_ai_tree_plan, apply_codex_rename, tree_node_create, tree_node_delete, tree_node_patch,
    ApplyAiTreePlanPayload, CodexRenameApplyPayload, TreeNodeCreatePayload, TreeNodeDeletePayload,
    TreeNodePatchPayload,
};
use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
use crate::narrative_extraction::task_leases::with_immediate_transaction;
use crate::narrative_extraction::{
    ensure_scene_scope_binding_in_tx, ensure_scope_registry_in_tx,
    invalidate_character_references_with_events_in_tx, read_narrative_scene_scope,
    update_narrative_scene_scope, update_narrative_scene_scope_registry,
    NarrativeSceneScopeRegistryUpdatePayload, NarrativeSceneScopeUpdatePayload,
    NarrativeSceneScopeUpdateV1,
};
use crate::Database;

const NOW: &str = "2026-10-17T00:00:00.000Z";
pub(crate) const FAR_FUTURE: &str = "2099-01-01T00:00:00.000Z";

thread_local! {
    static REQUESTS: Cell<u64> = const { Cell::new(0) };
}

/// A request or event id that never repeats inside a test thread.
pub(crate) fn unique(label: &str) -> String {
    REQUESTS.with(|counter| {
        counter.set(counter.get() + 1);
        format!("{label}-{}", counter.get())
    })
}

fn fixture() -> Database {
    let db = crate::test_support::current_schema_memory().expect("schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'P'), ('p2', 'Q');
             INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
               VALUES ('type-p1', 'p1', 'character', 'Character'),
                      ('type-p2', 'p2', 'character', 'Character');
             INSERT INTO codex_entries (id, project_id, type, name)
               VALUES ('c1', 'p1', 'character', 'Hero');
             INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
             VALUES ('f1', 'p1', NULL, 'folder', 'Chapter 1', 'a0', '{}'),
                    ('f2', 'p1', NULL, 'folder', 'Chapter 2', 'a1', '{}'),
                    ('s1', 'p1', 'f1', 'scene', 'One', 'a0', '{\"type\":\"doc\"}'),
                    ('s2', 'p1', 'f1', 'scene', 'Two', 'a1', '{\"type\":\"doc\"}'),
                    ('s4', 'p1', NULL, 'scene', 'Four', 'a2', '{\"type\":\"doc\"}'),
                    ('s3', 'p2', NULL, 'scene', 'Three', 'a0', '{\"type\":\"doc\"}');",
        )?;
        ensure_scope_registry_in_tx(conn, "p1", NOW)?;
        ensure_scope_registry_in_tx(conn, "p2", NOW)?;
        for (project, scene) in [("p1", "s1"), ("p1", "s2"), ("p1", "s4"), ("p2", "s3")] {
            ensure_scene_scope_binding_in_tx(conn, project, scene, NOW)?;
        }
        Ok(())
    })
    .expect("seed");
    db
}

/// The Scene's facts right now, computed the way `bind` below binds them.
fn current_facts(db: &Database, project: &str, scene: &str) -> SceneBodyDeclarationCurrentFacts {
    db.with_read_transaction(|conn| facts_in(conn, project, scene))
        .expect("current facts")
}

fn facts_in(
    conn: &Connection,
    project: &str,
    scene: &str,
) -> Result<SceneBodyDeclarationCurrentFacts> {
    let (incarnation, scope_token): (String, String) = conn.query_row(
        "SELECT scene_incarnation_id, source_token
           FROM narrative_scene_scope_bindings
          WHERE project_id = ?1 AND scene_id = ?2",
        params![project, scene],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (version, updated_at, title, content): (i64, String, String, String) = conn.query_row(
        "SELECT version, updated_at, title, content FROM tree_nodes WHERE id = ?1",
        params![scene],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(SceneBodyDeclarationCurrentFacts {
        project_id: project.to_owned(),
        scene_id: scene.to_owned(),
        scene_incarnation_id: incarnation,
        scope_source_token: scope_token,
        body_source: NarrativeSceneBodySourceV1 {
            source_identity: format!("project:scene:{scene}"),
            source_token: format!("v{version}@{updated_at}"),
            storage_digest: snapshot_bytes_digest(content.as_bytes()),
            canonical_digest: snapshot_bytes_digest(format!("canonical:{content}").as_bytes()),
            normalizer_version: "gdx-canonical-text/1".to_owned(),
            utf16_length: content.encode_utf16().count() as u64,
        },
        title_digest: snapshot_bytes_digest(title.as_bytes()),
        workspace_id: "test-workspace".to_owned(),
        canonical_locator_digest: test_digest('e'),
    })
}

fn bind(facts: &SceneBodyDeclarationCurrentFacts) -> NarrativeSceneBodyDeclarationBindingV1 {
    NarrativeSceneBodyDeclarationBindingV1 {
        project_id: facts.project_id.clone(),
        scene_id: facts.scene_id.clone(),
        scene_incarnation_id: facts.scene_incarnation_id.clone(),
        scope_source_token: facts.scope_source_token.clone(),
        body_source: facts.body_source.clone(),
        title_digest: facts.title_digest.clone(),
        workspace_id: facts.workspace_id.clone(),
        canonical_locator_digest: facts.canonical_locator_digest.clone(),
    }
}

/// Places a declaration bound to the Scene exactly as it is now, and checks
/// that it holds right after (so a later mismatch is caused by the writer).
fn declare(db: &Database, project: &str, scene: &str) -> NarrativeSceneBodyDeclarationV1 {
    let declaration = db
        .with_conn(|conn| {
            with_immediate_transaction(conn, |tx| {
                let declaration = NarrativeSceneBodyDeclarationV1::new(
                    Uuid::new_v4().to_string(),
                    TEST_DECLARED_AT,
                    bind(&facts_in(tx, project, scene)?),
                )?;
                set_scene_body_declaration_for_test(tx, &declaration)?;
                Ok(declaration)
            })
        })
        .expect("declare");
    assert_holds(db, &declaration, "just declared");
    declaration
}

fn stored(
    db: &Database,
    declaration: &NarrativeSceneBodyDeclarationV1,
) -> SceneBodyDeclarationRead {
    let binding = &declaration.binding;
    db.with_read_transaction(|conn| {
        read_scene_body_declaration(conn, &binding.project_id, &binding.scene_id)
    })
    .expect("read declaration")
}

fn assert_holds(db: &Database, declaration: &NarrativeSceneBodyDeclarationV1, step: &str) {
    let facts = current_facts(
        db,
        &declaration.binding.project_id,
        &declaration.binding.scene_id,
    );
    let mismatches = scene_body_declaration_binding_mismatches(declaration, &facts);
    assert!(
        mismatches.is_empty(),
        "{step}: the binding should hold, but {mismatches:?} differ"
    );
}

/// The declaration is still stored unchanged and its binding no longer holds.
fn assert_expired(db: &Database, declaration: &NarrativeSceneBodyDeclarationV1, step: &str) {
    match stored(db, declaration) {
        SceneBodyDeclarationRead::Declared(stored) => assert_eq!(
            &stored.declaration, declaration,
            "{step}: a writer must not rewrite the stored declaration"
        ),
        other => panic!("{step}: the declaration should stay stored, read {other:?}"),
    }
    let facts = current_facts(
        db,
        &declaration.binding.project_id,
        &declaration.binding.scene_id,
    );
    assert!(
        !scene_body_declaration_binding_mismatches(declaration, &facts).is_empty(),
        "{step}: the binding still holds, the declaration did not expire"
    );
}

/// A Scene that is gone, or is new, carries no declaration.
fn assert_no_declaration(db: &Database, project: &str, scene: &str, step: &str) {
    let read = db
        .with_read_transaction(|conn| read_scene_body_declaration(conn, project, scene))
        .expect("read declaration");
    assert!(
        matches!(
            read,
            SceneBodyDeclarationRead::None
                | SceneBodyDeclarationRead::Unavailable(
                    SceneBodyDeclarationUnavailableReason::BindingRowMissing
                )
        ),
        "{step}: expected no declaration, read {read:?}"
    );
}

pub(crate) fn scene_row(db: &Database, scene: &str, column: &str) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            &format!("SELECT {column} FROM tree_nodes WHERE id = ?1"),
            params![scene],
            |row| row.get(0),
        )?)
    })
    .expect("scene column")
}

pub(crate) fn patch(
    db: &Database,
    node: &str,
    fields: Value,
    bump_version: bool,
    updated_at: &str,
) -> Result<Value> {
    let label = unique("patch");
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: "p1".into(),
            request_id: label.clone(),
            session_id: "session".into(),
            event_uid: format!("{label}-event"),
            node_id: node.into(),
            patch: fields.as_object().cloned().expect("patch object"),
            base_version: None,
            bump_version,
            updated_at: updated_at.into(),
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

pub(crate) fn bulk(db: &Database, operations: Value) -> Value {
    let payload: AgentChronicleBulkPayload = serde_json::from_value(json!({
        "requestId": unique("bulk"),
        "projectId": "p1",
        "sessionId": "session",
        "surface": "manual",
        "operations": operations,
    }))
    .expect("bulk payload");
    agent_chronicle_bulk_mutate_impl(db, payload).expect("chronicle bulk")
}

pub(crate) fn undo_or_redo(db: &Database, journal_id: &str, direction: &str) {
    crate::undo_replay_test_support::replay_undo_journal(
        db,
        "p1",
        &unique(direction),
        journal_id,
        direction,
    );
}

pub(crate) fn save_body(db: &Database, scene: &str, content: &str, updated_at: &str) {
    let request = Uuid::new_v4().to_string();
    let payload = serde_json::from_value(json!({
        "sceneId": scene,
        "projectId": "p1",
        "requestId": request,
        "sessionId": "session",
        "eventUid": request,
        "origin": "human",
        "timelapseSteps": null,
        "includeSidecars": false,
        "baseVersion": null,
        "updatedAt": updated_at,
        "contentJson": content,
        "charCount": 0,
        "placedBeatPreview": null,
        "unplacedBeatsDoc": "[]",
        "unplacedBeatPreview": null,
        "authorshipSpans": [],
        "foreshadowSetups": [],
        "foreshadowPayoffs": [],
        "foreshadowBaseVersions": {},
        "annotationAnchors": [],
        "beatMentions": [],
        "beatPovOverrides": [],
        "docContentSize": 0,
    }))
    .expect("body save payload");
    crate::scene_body::save_scene_body_bundle(db, payload).expect("save scene body");
}

// ---- body, title and metadata ---------------------------------------------

#[test]
fn body_save_invalidates_and_same_text_resave_too() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let original = scene_row(&db, "s1", "content");

    save_body(
        &db,
        "s1",
        "{\"type\":\"doc\",\"x\":1}",
        "2026-10-17T01:00:00.000Z",
    );
    assert_expired(&db, &declaration, "body save");

    // Saving the very same text again, and saving the original text back,
    // each move the Scene on; neither makes the declaration current again.
    save_body(
        &db,
        "s1",
        "{\"type\":\"doc\",\"x\":1}",
        "2026-10-17T02:00:00.000Z",
    );
    assert_expired(&db, &declaration, "same text re-saved");
    save_body(&db, "s1", &original, "2026-10-17T03:00:00.000Z");
    assert_eq!(scene_row(&db, "s1", "content"), original);
    assert_expired(&db, &declaration, "original text restored by a later save");
}

#[test]
fn body_patch_with_the_same_text_still_invalidates() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    for bump in [true, false] {
        patch(
            &db,
            "s1",
            json!({ "content": scene_row(&db, "s1", "content") }),
            bump,
            "2026-10-17T01:00:00.000Z",
        )
        .unwrap();
        assert_expired(
            &db,
            &declaration,
            &format!("identical content patch, bump={bump}"),
        );
    }
}

#[test]
fn title_and_metadata_patch_invalidate() {
    for (field, value) in [
        ("title", json!("Renamed")),
        ("synopsis", json!("A synopsis")),
        ("status", json!("draft")),
        ("storyTimeLabel", json!("Day 3")),
        ("locationId", json!(null)),
        ("charCount", json!(99)),
    ] {
        for bump in [true, false] {
            let db = fixture();
            let declaration = declare(&db, "p1", "s1");
            patch(
                &db,
                "s1",
                json!({ field: value }),
                bump,
                "2026-10-17T01:00:00.000Z",
            )
            .unwrap();
            assert_expired(&db, &declaration, &format!("{field} patch, bump={bump}"));
        }
    }
}

#[test]
fn title_a_b_a_and_interruption_never_match_again() {
    for bump in [true, false] {
        let db = fixture();
        let declaration = declare(&db, "p1", "s1");
        let original_updated_at = scene_row(&db, "s1", "updated_at");

        // A -> B -> A, with `updatedAt` restored to its first value.
        patch(
            &db,
            "s1",
            json!({ "title": "B" }),
            bump,
            "2026-10-17T01:00:00.000Z",
        )
        .unwrap();
        assert_expired(&db, &declaration, &format!("title B, bump={bump}"));
        patch(
            &db,
            "s1",
            json!({ "title": "One" }),
            bump,
            &original_updated_at,
        )
        .unwrap();
        assert_eq!(scene_row(&db, "s1", "title"), "One");
        assert_expired(
            &db,
            &declaration,
            &format!("title back to A with the first updatedAt, bump={bump}"),
        );
        // ... and again with the same declared `updatedAt`.
        patch(
            &db,
            "s1",
            json!({ "title": "B" }),
            bump,
            "2026-10-17T01:00:00.000Z",
        )
        .unwrap();
        patch(
            &db,
            "s1",
            json!({ "title": "One" }),
            bump,
            &original_updated_at,
        )
        .unwrap();
        assert_expired(
            &db,
            &declaration,
            &format!("second round trip, bump={bump}"),
        );
    }
}

#[test]
fn title_round_trip_through_an_interrupting_patch_and_bulk_never_matches_again() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");

    // patch(future) -> Chronicle bulk -> patch(same future): the interruption
    // that would let an updatedAt-only token repeat (XK-1).
    patch(&db, "s1", json!({ "title": "B" }), false, FAR_FUTURE).unwrap();
    assert_expired(&db, &declaration, "future patch");
    let updated_at = scene_row(&db, "s1", "updated_at");
    let forward = bulk(
        &db,
        json!([{ "kind": "sceneSetPov", "sceneId": "s1",
                 "baseUpdatedAt": updated_at, "povCharacterId": "c1" }]),
    );
    assert_expired(&db, &declaration, "Chronicle bulk forward");
    let journal = forward["undoJournalId"].as_str().unwrap().to_owned();
    for direction in ["undo", "redo", "undo"] {
        undo_or_redo(&db, &journal, direction);
        assert_expired(&db, &declaration, direction);
    }
    patch(&db, "s1", json!({ "title": "One" }), false, FAR_FUTURE).unwrap();
    assert_eq!(scene_row(&db, "s1", "title"), "One");
    assert_expired(&db, &declaration, "same future updatedAt again, title back");
    patch(
        &db,
        "s1",
        json!({ "title": "B" }),
        false,
        "2026-07-29T00:00:00.000Z",
    )
    .unwrap();
    patch(&db, "s1", json!({ "title": "One" }), false, FAR_FUTURE).unwrap();
    assert_expired(&db, &declaration, "stale and repeated declarations");
}

// ---- Scene placement and Scope fields --------------------------------------

#[test]
fn scene_move_reorder_story_order_archive_pov_invalidate() {
    let cases: [(&str, Value, Option<Value>); 5] = [
        (
            "move to another folder",
            json!({ "parentId": "f2" }),
            Some(json!({ "parentId": "f1" })),
        ),
        (
            "reorder",
            json!({ "sortOrder": "b0" }),
            Some(json!({ "sortOrder": "a0" })),
        ),
        (
            "story time order",
            json!({ "storyTimeOrder": "m0" }),
            Some(json!({ "storyTimeOrder": null })),
        ),
        (
            "archive",
            json!({ "archivedAt": "2026-10-17T01:00:00.000Z" }),
            Some(json!({ "archivedAt": null })),
        ),
        (
            "POV character",
            json!({ "povCharacterId": "c1" }),
            Some(json!({ "povCharacterId": null })),
        ),
    ];
    for (name, forward, back) in cases {
        for bump in [true, false] {
            let db = fixture();
            let declaration = declare(&db, "p1", "s1");
            patch(&db, "s1", forward.clone(), bump, "2026-10-17T01:00:00.000Z").unwrap();
            assert_expired(&db, &declaration, &format!("{name}, bump={bump}"));
            if let Some(back) = back.clone() {
                patch(&db, "s1", back, bump, "2026-10-17T02:00:00.000Z").unwrap();
                assert_expired(&db, &declaration, &format!("{name} put back, bump={bump}"));
            }
        }
    }
}

#[test]
fn ai_apply_invalidates() {
    let db = fixture();
    db.with_conn(|conn| {
        for node in ["s1", "s2"] {
            for path in [
                "/parentId",
                "/nodeType",
                "/title",
                "/sortOrder",
                "/synopsis",
            ] {
                conn.execute(
                    "INSERT INTO narrative_field_authority
                        (project_id, entity_kind, entity_id, field_path, owner_kind,
                         explicit_lock, version, updated_at)
                     VALUES ('p1', 'tree_node', ?1, ?2, 'ai', 0, 0, 'fixture')",
                    params![node, path],
                )?;
            }
        }
        Ok(())
    })
    .unwrap();
    let ai_plan = |label: &str, updates: Value, ops: Value| -> ApplyAiTreePlanPayload {
        let request = unique(label);
        serde_json::from_value(json!({
            "requestId": request,
            "projectId": "p1",
            "sessionId": "ai-session",
            "surface": "in-app-agent",
            "kind": "reorganize",
            "updatedAt": "2026-10-17T01:00:00Z",
            "model": "model-1",
            "traceId": "trace-1",
            "authorityRoute": "interactive-agent-command",
            "caller": "chat-tool-executor",
            "controls": ["knowledge-write-policy", "stable-request-id", "agent-provenance",
                         "field-authority", "typed-writer", "occ", "undo-journal",
                         "change-event", "change-feed"],
            "provenance": { "requestId": request, "traceId": "trace-1" },
            "writesAuthorityProtectedField": false,
            "creates": [],
            "updates": updates,
            "ops": ops,
        }))
        .expect("AI plan payload")
    };

    // A title-only update (no Scope field).
    let renamed = declare(&db, "p1", "s1");
    apply_ai_tree_plan(
        &db,
        ai_plan(
            "ai-rename",
            json!([{ "id": "s1", "baseVersion": 0, "placement": null, "title": "Renamed by AI" }]),
            json!([{ "op": "rename", "nodeId": "s1", "title": "Renamed by AI" }]),
        ),
    )
    .expect("AI rename");
    assert_eq!(scene_row(&db, "s1", "title"), "Renamed by AI");
    assert_expired(&db, &renamed, "AI rename");

    // A placement update (a Scope field).
    let moved = declare(&db, "p1", "s2");
    apply_ai_tree_plan(
        &db,
        ai_plan(
            "ai-move",
            json!([{ "id": "s2", "baseVersion": 0,
                     "placement": { "parentId": "f2", "sortOrder": "a0" }, "title": null }]),
            json!([{ "op": "move", "nodeId": "s2", "newParentRef": "f2", "pos": {} }]),
        ),
    )
    .expect("AI move");
    assert_eq!(scene_row(&db, "s2", "parent_id"), "f2");
    assert_expired(&db, &moved, "AI move");
}

#[test]
fn codex_rename_propagation_invalidates() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let payload: CodexRenameApplyPayload = serde_json::from_value(json!({
        "requestId": unique("rename"),
        "projectId": "p1",
        "sessionId": "session",
        "entryId": "c1",
        "updatedAt": "2026-10-17T01:00:00.000Z",
        "updates": [
            { "kind": "scene-body", "refId": "s1", "baseVersion": 0,
              "value": "{\"type\":\"doc\",\"renamed\":true}", "charCount": 3 },
            { "kind": "node-title", "refId": "s1", "baseVersion": 0, "value": "Hero's scene" },
        ],
        "eventSummary": "{\"entryId\":\"c1\",\"oldName\":\"Hero\",\"newName\":\"Champion\"}",
        "eventUid": unique("rename-event"),
        "timestamp": 1_792_000_000_000_i64,
    }))
    .expect("rename payload");
    apply_codex_rename(&db, payload).expect("codex rename propagation");
    assert_eq!(scene_row(&db, "s1", "title"), "Hero's scene");
    assert_expired(&db, &declaration, "Codex rename propagation");
}

#[test]
fn bulk_and_temporal_operations_invalidate() {
    let db = fixture();
    let first = declare(&db, "p1", "s1");
    let second = declare(&db, "p1", "s2");
    let third = declare(&db, "p1", "s4");

    // Chronicle bulk: POV, date, clear date; then undo and redo.
    let forward = bulk(
        &db,
        json!([
            { "kind": "sceneSetPov", "sceneId": "s1",
              "baseUpdatedAt": scene_row(&db, "s1", "updated_at"), "povCharacterId": "c1" },
            { "kind": "sceneSetDate", "sceneId": "s2",
              "baseUpdatedAt": scene_row(&db, "s2", "updated_at"),
              "startTime": 100, "startMinute": null, "startGranularity": "day",
              "endTime": null, "endMinute": null, "endGranularity": "none" },
        ]),
    );
    assert_expired(&db, &first, "bulk POV");
    assert_expired(&db, &second, "bulk date");
    let journal = forward["undoJournalId"].as_str().unwrap().to_owned();
    undo_or_redo(&db, &journal, "undo");
    assert_expired(&db, &first, "bulk undo (POV)");
    assert_expired(&db, &second, "bulk undo (date)");
    undo_or_redo(&db, &journal, "redo");
    assert_expired(&db, &first, "bulk redo (POV)");
    assert_expired(&db, &second, "bulk redo (date)");
    bulk(
        &db,
        json!([{ "kind": "sceneClearDate", "sceneId": "s2",
                 "baseUpdatedAt": scene_row(&db, "s2", "updated_at") }]),
    );
    assert_expired(&db, &second, "bulk clear date");

    // Temporal commit writers: the Chronicle range and the story order.
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            let version: i64 =
                tx.query_row("SELECT version FROM tree_nodes WHERE id = 's4'", [], |r| r.get(0))?;
            let payload = crate::narrative_extraction::temporal_operations::parse_scene_metadata_patch_payload(
                &json!({ "sceneId": "s4", "baseVersion": version, "startTime": 10,
                         "startGranularity": "day", "endGranularity": "none" }),
            )?;
            crate::narrative_extraction::temporal_operations::apply_scene_metadata_patch_in_tx(
                tx, "p1", &payload, "2026-10-17T05:00:00.000Z",
            )?;
            Ok(())
        })
    })
    .unwrap();
    assert_expired(&db, &third, "temporal Chronicle metadata patch");
    let fourth = declare(&db, "p1", "s4");
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            let version: i64 =
                tx.query_row("SELECT version FROM tree_nodes WHERE id = 's4'", [], |r| r.get(0))?;
            let payload = crate::narrative_extraction::temporal_operations::parse_story_order_materialize_payload(
                &json!({ "sceneId": "s4", "baseVersion": version,
                         "storyTimeOrder": "k0", "storyTimeLabel": "Day 1" }),
            )?;
            crate::narrative_extraction::temporal_operations::apply_story_order_materialize_in_tx(
                tx, "p1", &payload, "2026-10-17T06:00:00.000Z",
            )?;
            Ok(())
        })
    })
    .unwrap();
    assert_expired(&db, &fourth, "story order materialize");
}

// ---- folders (X1-1) --------------------------------------------------------

#[test]
fn folder_move_reorder_archive_and_back_never_match_again() {
    let cases: [(&str, Value, Value); 3] = [
        (
            "move",
            json!({ "parentId": "f2" }),
            json!({ "parentId": null }),
        ),
        (
            "reorder",
            json!({ "sortOrder": "z0" }),
            json!({ "sortOrder": "a0" }),
        ),
        (
            "archive",
            json!({ "archivedAt": "2026-10-17T01:00:00.000Z" }),
            json!({ "archivedAt": null }),
        ),
    ];
    for (name, forward, back) in cases {
        for bump in [true, false] {
            let db = fixture();
            // Both Scenes under the folder, and a Scene outside it.
            let under_a = declare(&db, "p1", "s1");
            let under_b = declare(&db, "p1", "s2");
            let outside = declare(&db, "p1", "s4");

            patch(&db, "f1", forward.clone(), bump, "2026-10-17T01:00:00.000Z").unwrap();
            assert_expired(
                &db,
                &under_a,
                &format!("folder {name} (first Scene), bump={bump}"),
            );
            assert_expired(
                &db,
                &under_b,
                &format!("folder {name} (second Scene), bump={bump}"),
            );
            assert_holds(&db, &outside, "a Scene outside the folder is not touched");

            patch(&db, "f1", back.clone(), bump, "2026-10-17T02:00:00.000Z").unwrap();
            assert_expired(
                &db,
                &under_a,
                &format!("folder {name} put back, bump={bump}"),
            );
            assert_expired(
                &db,
                &under_b,
                &format!("folder {name} put back (2), bump={bump}"),
            );
            assert_holds(
                &db,
                &outside,
                "outside Scene still holds after the round trip",
            );
        }
    }
}

// ---- A1, registry and Codex characters -------------------------------------

pub(crate) fn a1_payload(
    base_version: i64,
    holder: NarrativeScopePrincipalV1,
    updated_at: &str,
) -> NarrativeSceneScopeUpdatePayload {
    let unresolved = || NarrativeScopeConstraintV1::Unresolved {
        reason: "not-set".into(),
    };
    let request = unique("a1");
    NarrativeSceneScopeUpdatePayload {
        project_id: "p1".into(),
        scene_id: "s1".into(),
        request_id: request.clone(),
        session_id: "session".into(),
        event_uid: format!("{request}-event"),
        base_version,
        updated_at: updated_at.into(),
        scope: NarrativeSceneScopeUpdateV1 {
            schema_version: 1,
            compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: unresolved(),
                worldline: unresolved(),
                narrative_layer: unresolved(),
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: NarrativeScopeConstraintV1::Any,
                worldline: NarrativeScopeConstraintV1::Any,
                narrative_layer: NarrativeScopeConstraintV1::Any,
            },
            knowledge_holder: holder,
            audience: NarrativeScopePrincipalV1::Reader {},
        },
    }
}

pub(crate) fn a1_version(db: &Database) -> i64 {
    db.with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
        .unwrap()
        .binding
        .version
}

#[test]
fn a1_update_invalidates() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    update_narrative_scene_scope(
        &db,
        a1_payload(
            a1_version(&db),
            NarrativeScopePrincipalV1::Reader {},
            "2026-10-17T01:00:00.000Z",
        ),
    )
    .expect("A1 update");
    assert_expired(&db, &declaration, "A1 update");
    // Setting the same A1 value again, and setting it back, do not restore it.
    update_narrative_scene_scope(
        &db,
        a1_payload(
            a1_version(&db),
            NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            },
            "2026-10-17T02:00:00.000Z",
        ),
    )
    .expect("A1 character holder");
    assert_expired(&db, &declaration, "A1 holder set");
    update_narrative_scene_scope(
        &db,
        a1_payload(
            a1_version(&db),
            NarrativeScopePrincipalV1::Reader {},
            "2026-10-17T03:00:00.000Z",
        ),
    )
    .expect("A1 holder back");
    assert_expired(&db, &declaration, "A1 holder put back");
}

pub(crate) fn registry_edit(db: &Database, add: Option<&str>) {
    let (revision, mut registry) = db
        .with_read_transaction(|conn| {
            let read = read_narrative_scene_scope(conn, "p1", "s1")?;
            Ok((read.registry_revision, read.registry))
        })
        .unwrap();
    match add {
        Some(reference) => registry.timeline_refs.push(reference.into()),
        None => {
            registry.timeline_refs.pop();
        }
    }
    update_narrative_scene_scope_registry(
        db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: "p1".into(),
            request_id: unique("registry"),
            session_id: "session".into(),
            event_uid: unique("registry-event"),
            base_version: revision,
            updated_at: "2026-10-17T01:00:00.000Z".into(),
            registry,
        },
    )
    .expect("registry update");
}

#[test]
fn registry_update_invalidates_every_declaration_in_project() {
    let db = fixture();
    let in_project = [
        declare(&db, "p1", "s1"),
        declare(&db, "p1", "s2"),
        declare(&db, "p1", "s4"),
    ];
    let other_project = declare(&db, "p2", "s3");

    registry_edit(&db, Some("timeline:extra"));
    for (index, declaration) in in_project.iter().enumerate() {
        assert_expired(
            &db,
            declaration,
            &format!("registry change, Scene #{index}"),
        );
    }
    assert_holds(&db, &other_project, "another project's declaration");

    // A -> B -> A on the registry does not bring any of them back (XK-3).
    registry_edit(&db, None);
    for (index, declaration) in in_project.iter().enumerate() {
        assert_expired(
            &db,
            declaration,
            &format!("registry put back, Scene #{index}"),
        );
    }
    assert_holds(
        &db,
        &other_project,
        "another project's declaration after the round trip",
    );
}

#[test]
fn codex_character_restore_a1_invalidation_invalidates() {
    let db = fixture();
    // A1 names the character as knowledge holder.
    update_narrative_scene_scope(
        &db,
        a1_payload(
            a1_version(&db),
            NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            },
            "2026-10-17T01:00:00.000Z",
        ),
    )
    .expect("A1 names the character");
    let declaration = declare(&db, "p1", "s1");
    let unrelated = declare(&db, "p1", "s2");

    // The writer both Codex restore paths (a delete-cascade restore and an
    // undo of a type change) run to reset every binding that names the
    // restored character (agent_writes.rs).
    let events = db
        .with_conn(|conn| {
            with_immediate_transaction(conn, |tx| {
                invalidate_character_references_with_events_in_tx(
                    tx,
                    "p1",
                    "c1",
                    "2026-10-17T02:00:00.000Z",
                )
            })
        })
        .unwrap();
    assert_eq!(
        events.len(),
        1,
        "one A1 event for the one binding that names c1"
    );
    assert_expired(&db, &declaration, "character restore invalidates A1");
    assert_holds(&db, &unrelated, "a Scene that does not name the character");
}

// ---- identity: duplicate, delete, recreate, trash --------------------------

pub(crate) fn create_scene(db: &Database, id: &str, title: &str, content: &str) {
    let label = unique("create");
    tree_node_create(
        db,
        TreeNodeCreatePayload {
            id: id.into(),
            project_id: "p1".into(),
            request_id: label.clone(),
            session_id: "session".into(),
            event_uid: format!("{label}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: Some("f1".into()),
            node_type: "scene".into(),
            title: title.into(),
            sort_order: "a9".into(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some(content.into()),
            canonical_payload: None,
        },
    )
    .expect("create Scene");
}

pub(crate) fn delete_scene(db: &Database, id: &str) {
    let label = unique("delete");
    tree_node_delete(
        db,
        TreeNodeDeletePayload {
            project_id: "p1".into(),
            request_id: label.clone(),
            session_id: "session".into(),
            event_uid: format!("{label}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: id.into(),
            canonical_payload: None,
        },
    )
    .expect("delete Scene");
}

#[test]
fn duplicate_has_no_declaration() {
    let db = fixture();
    let original = declare(&db, "p1", "s1");
    // A duplicate is a new Scene with copied title and body.
    let content = scene_row(&db, "s1", "content");
    create_scene(&db, "s1-copy", "One", &content);
    assert_no_declaration(&db, "p1", "s1-copy", "duplicate");
    assert_holds(&db, &original, "the original is untouched by its duplicate");
}

#[test]
fn delete_and_recreate_with_same_id_has_no_declaration() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let content = scene_row(&db, "s1", "content");
    delete_scene(&db, "s1");
    assert_no_declaration(&db, "p1", "s1", "after delete");
    create_scene(&db, "s1", "One", &content);
    assert_no_declaration(&db, "p1", "s1", "recreated with the same id");
    // The old declaration cannot be matched to the new Scene even if some
    // writer had left it behind: its incarnation differs.
    let facts = current_facts(&db, "p1", "s1");
    assert!(
        !scene_body_declaration_binding_mismatches(&declaration, &facts).is_empty(),
        "the new Scene is not the declared one"
    );
}

#[test]
fn trash_restore_does_not_bring_back_declaration() {
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let title = scene_row(&db, "s1", "title");
    let content = scene_row(&db, "s1", "content");
    delete_scene(&db, "s1");

    let item_id = "trash-s1";
    let trash: crate::trash_bin::TrashBinCreatePayload = serde_json::from_value(json!({
        "id": item_id,
        "projectId": "p1",
        "kind": "structure-item",
        "subKind": "scene",
        "originSceneId": null,
        "originCodexId": null,
        "previewText": "restore candidate",
        "previewMeta": null,
        "payload": json!({
            "originalId": "s1",
            "title": title,
            "body": content,
            "beats": "[]",
            "povCharacterId": null,
            "folderHintId": null,
            "folderHintName": null,
            "metadata": { "synopsis": null, "status": "draft", "nodeType": "scene",
                          "locationId": null, "sortOrder": "a0", "storyTimeOrder": null,
                          "storyTimeLabel": null },
            "charCount": 0
        }).to_string(),
        "charCount": 0,
        "isInteresting": true,
        "deletedAt": "2026-10-17T01:00:00Z",
    }))
    .expect("trash payload");
    crate::trash_bin::create(&db, trash).expect("trash item");
    let restored = crate::trash_bin::restore(
        &db,
        crate::trash_bin::TrashBinRestorePayload {
            request_id: unique("trash-restore"),
            session_id: "session".into(),
            project_id: "p1".into(),
            item_id: item_id.into(),
            board_id_override: None,
            drop_x: None,
            drop_y: None,
        },
    )
    .expect("restore Scene from Trash");

    assert_no_declaration(&db, "p1", &restored.new_id, "Scene restored from Trash");
    assert_no_declaration(&db, "p1", "s1", "the deleted Scene's id");
    let facts = current_facts(&db, "p1", &restored.new_id);
    assert!(
        !scene_body_declaration_binding_mismatches(&declaration, &facts).is_empty(),
        "the restored Scene is not the declared one"
    );
}
