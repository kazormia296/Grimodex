//! E group (CB-4 S3): how a declaration expires, seen from the reader.
//!
//! CB-1's `scene_body_declaration/invalidation_tests.rs` ran every production
//! writer and looked at the storage layer (the binding no longer matches). This
//! file runs the same writers and looks at what the reader finally answers:
//!
//! 1. right after the declaration is placed the Scene is `Eligible`;
//! 2. after the production writer the reader answers `NotAppended` for the
//!    frame as it is now and for the frame the response used, and a click on
//!    the binding the response made is refused;
//! 3. putting the Scene back (title A -> B -> A with `updatedAt` restored, a
//!    folder moved and moved back, a registry changed and changed back, ...)
//!    does not make it eligible again.
//!
//! No test names *which* component of the binding differs. Before X1-2 a body
//! or title change moves the v1 token; after X1-2 it moves the body Source
//! token and the title digest. Both orders pass (XK-1, XK-2).
//!
//! ## E10: the 失効 table of the draft and the tests that hold each row
//!
//! | row (draft `scope-storage-authority`, 失効) | reader test (this file) | writer exercised |
//! |---|---|---|
//! | body save, same-text re-save, original text saved back | `e1_body_save_*` | `save_scene_body_bundle` |
//! | body patch with the same text (`bumpVersion` true/false) | `e1_body_patch_*` | `tree_node_patch` |
//! | title / metadata patch (`bumpVersion` true/false) | `e1_title_and_metadata_*` | `tree_node_patch` |
//! | title A -> B -> A, `updatedAt` restored, future `updatedAt` interrupted | `e2_*` | `tree_node_patch`, Chronicle bulk (+ undo/redo) |
//! | Scene move / reorder / story order / archive / POV and back | `e3_scene_placement_*` | `tree_node_patch` |
//! | AI Apply | `e3_ai_apply_*` | `apply_ai_tree_plan` |
//! | Codex rename propagation | `e3_codex_rename_*` | `apply_codex_rename` |
//! | Chronicle bulk (forward, undo, redo), temporal commit writers | `e3_bulk_and_temporal_*` | `agent_chronicle_bulk_mutate_impl`, `apply_*_in_tx` |
//! | folder move / reorder / archive and back (X1-1) | `e3_folder_*` | `tree_node_patch` on the folder |
//! | A1 update, same value, holder set and put back | `e4_a1_*` | `update_narrative_scene_scope` |
//! | registry change and change back (every declaration of the project) | `e4_registry_*` | `update_narrative_scene_scope_registry` |
//! | Codex character restore invalidates A1 | `e4_codex_character_restore_*` | `invalidate_character_references_with_events_in_tx` |
//! | body version restore, also with identical bytes | `e5_body_version_restore_*` | `restore_scene_revision` |
//! | project snapshot restore | `e5_project_snapshot_restore_*` | `apply_project_snapshot_restore` |
//! | backup restore and Safe Mode restore (staged image clear) | `e5_staged_restore_*` | `clear_all_scene_body_declarations_for_staged_restore` |
//! | duplicate, delete and re-create with the same id, Trash restore | `e6_*` | `tree_node_create`, `tree_node_delete`, `trash_bin::restore` |
//! | copy / move of the workspace, workspace ID change, and back | `e7_*` | (reopen of the workspace) |
//! | veto record added after the declaration, then removed | `e8_*` | (rows the Chronicle / foreshadow writers own) |
//! | revoke, resend of the revoke, re-declare | `e9_*` | `revoke_scene_body`, `declare_scene_body` |
//!
//! Rows that this file does not run: a backup older than schema 43 (no
//! declaration columns; CB-1's migration tests) and a locator that cannot be
//! determined (`tests.rs` A6).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use grimodex_core::narrative_scene_scope::NarrativeScopePrincipalV1;

use super::body_tests::{
    assert_nothing_added, assert_refused, click, disclose, disclose_with, eligible, place_real,
};
use super::tests::{add_pin, add_scene, event, execute, fixture, foreshadow, Path};
use super::*;
use crate::domain_writes::{
    apply_ai_tree_plan, apply_codex_rename, ApplyAiTreePlanPayload, CodexRenameApplyPayload,
};
use crate::narrative_extraction::scene_body_declaration::invalidation_tests as writers;
use crate::narrative_extraction::scene_body_declaration::writer_support_tests::{
    body_json, budget, declare, request_for, revoke_request, set_a1, Env, PROJECT, SCENE,
};
use crate::narrative_extraction::scene_body_declaration::{
    clear_all_scene_body_declarations_for_staged_restore, read_scene_body_declaration,
    revoke_scene_body, RevokeResponse, SceneBodyDeclarationRead,
};
use crate::narrative_extraction::task_leases::with_immediate_transaction;
use crate::narrative_extraction::{
    invalidate_character_references_with_events_in_tx, read_narrative_scene_scope,
    update_narrative_scene_scope,
};

const T1: &str = "2026-10-19T01:00:00.000Z";
const T2: &str = "2026-10-19T02:00:00.000Z";

// ---- helpers ----------------------------------------------------------------

fn db(env: &Env) -> &crate::Database {
    // The pinned handle lives as long as the Env.
    env.authority.as_ref().expect("authority").db()
}

/// Scenes `prefix0..prefix{n-1}`: declarable, pinned, before the query Scene.
fn scenes(env: &Env, prefix: &str, count: usize) -> Vec<String> {
    (0..count)
        .map(|index| {
            let id = format!("{prefix}{index}");
            add_scene(env, &id, None, true);
            add_pin(env, &id, &format!("2026-10-19T00:10:{index:02}Z"));
            id
        })
        .collect()
}

/// The frame association the current rows would give, or `None` when the
/// Scene or its pin is gone.
fn fresh(env: &Env, scene: &str) -> Option<Nir1GraphSceneAssociation> {
    env.with_conn(|conn| {
        let row: Option<(i64, String, String, i64, String)> = conn
            .query_row(
                "SELECT n.version, n.updated_at, p.entry_id, p.rowid, p.created_at
                   FROM tree_nodes n JOIN scene_codex_pins p ON p.scene_id = n.id
                  WHERE n.id = ?1",
                [scene],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((version, updated_at, entry, rowid, created_at)) = row else {
            return Ok(None);
        };
        let (incarnation, scope_token): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT scene_incarnation_id, source_token FROM narrative_scene_scope_bindings
                  WHERE scene_id = ?1",
                [scene],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((None, None));
        Ok(Some(Nir1GraphSceneAssociation {
            scene_id: scene.to_owned(),
            scene_incarnation_id: incarnation,
            scene_source_token: format!("v{version}@{updated_at}"),
            scene_scope_token: scope_token,
            pin_rowid: rowid,
            pin_entry_id: entry,
            pin_created_at: created_at,
            path_hop: 1,
            path_edge_indices: vec![0],
        }))
    })
}

fn answer(
    env: &Env,
    association: Nir1GraphSceneAssociation,
) -> anyhow::Result<GraphOnlySceneDisclosure> {
    disclose_with(env, &[association], &mut Path::yes(), &mut || Ok(()))
}

/// Declares the Scene's body as it is now and shows it: the response's binding.
fn arm(env: &Env, scene: &str) -> GraphOnlySceneBinding {
    place_real(env, scene);
    let shown = eligible(disclose(env, &[scene]));
    assert_eq!(shown.scene_id(), scene);
    shown.binding().clone()
}

/// The reader answers `Eligible` for the Scene as it is now.
fn assert_holds(env: &Env, scene: &str, step: &str) {
    let now = fresh(env, scene).unwrap_or_else(|| panic!("{step}: the Scene has no frame"));
    match answer(env, now).unwrap() {
        GraphOnlySceneDisclosure::Eligible(_) => {}
        other => panic!("{step}: the Scene should be eligible, got {other:?}"),
    }
}

/// The reader adds nothing for the Scene as it is now and for the frame the
/// response used, and the click on the response's binding is refused.
fn assert_expired(env: &Env, scene: &str, shown: &GraphOnlySceneBinding, step: &str) {
    if let Some(now) = fresh(env, scene) {
        let result = answer(env, now).unwrap();
        assert!(
            matches!(result, GraphOnlySceneDisclosure::NotAppended(NotAppended)),
            "{step}: the current frame must add nothing, got {result:?}"
        );
    }
    let old = answer(env, shown.association.clone()).unwrap();
    assert!(
        matches!(old, GraphOnlySceneDisclosure::NotAppended(NotAppended)),
        "{step}: the frame the response used must add nothing, got {old:?}"
    );
    assert_refused(env, shown, step);
}

fn scene_row(env: &Env, scene: &str, column: &str) -> String {
    writers::scene_row(db(env), scene, column)
}

fn patch(env: &Env, node: &str, fields: Value, bump: bool, updated_at: &str) {
    writers::patch(db(env), node, fields, bump, updated_at).expect("patch");
}

fn add_folder(env: &Env, id: &str) {
    execute(
        env,
        &format!(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
             VALUES ('{id}', 'p1', NULL, 'folder', '{id}', '{id}', '{{}}');"
        ),
    );
}

// ---- E1: body, title and metadata -------------------------------------------------

#[test]
fn e1_body_save_same_text_resave_and_original_restored_never_hold_again() {
    let env = fixture();
    let shown = arm(&env, "b1");
    let original = scene_row(&env, "b1", "content");
    let changed = body_json("Another body.");

    writers::save_body(db(&env), "b1", &changed, T1);
    assert_expired(&env, "b1", &shown, "body save");
    writers::save_body(db(&env), "b1", &changed, T2);
    assert_expired(&env, "b1", &shown, "same text saved again");
    writers::save_body(db(&env), "b1", &original, "2026-10-19T03:00:00.000Z");
    assert_eq!(scene_row(&env, "b1", "content"), original);
    assert_expired(&env, "b1", &shown, "original text saved back");
}

#[test]
fn e1_body_patch_with_the_same_text_still_expires() {
    let env = fixture();
    let ids = scenes(&env, "m", 2);
    for (scene, bump) in ids.iter().zip([true, false]) {
        let shown = arm(&env, scene);
        patch(
            &env,
            scene,
            json!({ "content": scene_row(&env, scene, "content") }),
            bump,
            T1,
        );
        assert_expired(
            &env,
            scene,
            &shown,
            &format!("identical content, bump={bump}"),
        );
    }
}

#[test]
fn e1_title_and_metadata_patches_expire() {
    let env = fixture();
    let cases = [
        ("title", json!("Renamed")),
        ("synopsis", json!("A synopsis")),
        ("status", json!("draft")),
        ("storyTimeLabel", json!("Day 3")),
        ("locationId", json!(null)),
        ("charCount", json!(99)),
    ];
    let ids = scenes(&env, "m", cases.len() * 2);
    let mut armed = Vec::new();
    for (index, scene) in ids.iter().enumerate() {
        armed.push((scene.clone(), arm(&env, scene), index));
    }
    for (scene, shown, index) in &armed {
        let (field, value) = &cases[index / 2];
        let bump = index % 2 == 0;
        patch(&env, scene, json!({ *field: value.clone() }), bump, T1);
        assert_expired(&env, scene, shown, &format!("{field} patch, bump={bump}"));
    }
}

// ---- E2: ABA and interruption -------------------------------------------------------

#[test]
fn e2_title_a_b_a_with_the_first_updated_at_never_holds_again() {
    let env = fixture();
    let ids = scenes(&env, "m", 2);
    for (scene, bump) in ids.iter().zip([true, false]) {
        let shown = arm(&env, scene);
        let title = scene_row(&env, scene, "title");
        let first_updated_at = scene_row(&env, scene, "updated_at");

        patch(&env, scene, json!({ "title": "B" }), bump, T1);
        assert_expired(&env, scene, &shown, &format!("title B, bump={bump}"));
        patch(
            &env,
            scene,
            json!({ "title": title }),
            bump,
            &first_updated_at,
        );
        assert_eq!(scene_row(&env, scene, "title"), title);
        assert_expired(
            &env,
            scene,
            &shown,
            &format!("A again, first updatedAt, bump={bump}"),
        );
        patch(&env, scene, json!({ "title": "B" }), bump, T1);
        patch(
            &env,
            scene,
            json!({ "title": title }),
            bump,
            &first_updated_at,
        );
        assert_expired(
            &env,
            scene,
            &shown,
            &format!("second round trip, bump={bump}"),
        );
    }
}

#[test]
fn e2_an_interrupted_future_updated_at_never_holds_again() {
    const FAR_FUTURE: &str = "2099-01-01T00:00:00.000Z";
    let env = fixture();
    let shown = arm(&env, "b1");
    let title = scene_row(&env, "b1", "title");

    // patch(future) -> Chronicle bulk (+ undo, redo) -> patch(same future).
    patch(&env, "b1", json!({ "title": "B" }), false, FAR_FUTURE);
    assert_expired(&env, "b1", &shown, "future patch");
    let forward = writers::bulk(
        db(&env),
        json!([{ "kind": "sceneSetPov", "sceneId": "b1",
                 "baseUpdatedAt": scene_row(&env, "b1", "updated_at"),
                 "povCharacterId": "c1" }]),
    );
    assert_expired(&env, "b1", &shown, "bulk forward");
    let journal = forward["undoJournalId"].as_str().unwrap().to_owned();
    for direction in ["undo", "redo", "undo"] {
        writers::undo_or_redo(db(&env), &journal, direction);
        assert_expired(&env, "b1", &shown, direction);
    }
    patch(&env, "b1", json!({ "title": title }), false, FAR_FUTURE);
    assert_eq!(scene_row(&env, "b1", "title"), title);
    assert_expired(&env, "b1", &shown, "same future updatedAt, title back");
    patch(
        &env,
        "b1",
        json!({ "title": "B" }),
        false,
        "2026-07-29T00:00:00.000Z",
    );
    patch(&env, "b1", json!({ "title": title }), false, FAR_FUTURE);
    assert_expired(&env, "b1", &shown, "stale and repeated");
}

// ---- E3: placement, writers of other kinds, folders ------------------------------------

#[test]
fn e3_scene_placement_fields_and_back_never_hold_again() {
    let env = fixture();
    add_folder(&env, "f2");
    let cases: [(&str, Value, Option<Value>); 5] = [
        (
            "move to a folder",
            json!({ "parentId": "f2" }),
            Some(json!({ "parentId": null })),
        ),
        (
            "reorder",
            json!({ "sortOrder": "zz" }),
            Some(json!({ "sortOrder": "aa" })),
        ),
        (
            "story time order",
            json!({ "storyTimeOrder": "m0" }),
            Some(json!({ "storyTimeOrder": null })),
        ),
        (
            "archive",
            json!({ "archivedAt": T1 }),
            Some(json!({ "archivedAt": null })),
        ),
        (
            "POV character",
            json!({ "povCharacterId": "c1" }),
            Some(json!({ "povCharacterId": null })),
        ),
    ];
    let ids = scenes(&env, "m", cases.len() * 2);
    let armed: Vec<_> = ids.iter().map(|id| (id.clone(), arm(&env, id))).collect();
    for (index, (scene, shown)) in armed.iter().enumerate() {
        let (name, forward, back) = &cases[index / 2];
        let bump = index % 2 == 0;
        patch(&env, scene, forward.clone(), bump, T1);
        assert_expired(&env, scene, shown, &format!("{name}, bump={bump}"));
        if let Some(back) = back {
            patch(&env, scene, back.clone(), bump, T2);
            assert_expired(&env, scene, shown, &format!("{name} put back, bump={bump}"));
        }
    }
}

#[test]
fn e3_ai_apply_expires() {
    let env = fixture();
    add_folder(&env, "f2");
    execute(
        &env,
        "INSERT INTO narrative_field_authority
            (project_id, entity_kind, entity_id, field_path, owner_kind, explicit_lock, version, updated_at)
         SELECT 'p1', 'tree_node', n.id, f.path, 'ai', 0, 0, 'fixture'
           FROM tree_nodes n,
                (SELECT '/parentId' AS path UNION ALL SELECT '/nodeType' UNION ALL SELECT '/title'
                 UNION ALL SELECT '/sortOrder' UNION ALL SELECT '/synopsis') f
          WHERE n.id IN ('b1', 'b2');",
    );
    let plan = |label: &str, updates: Value, ops: Value| -> ApplyAiTreePlanPayload {
        let request = writers::unique(label);
        serde_json::from_value(json!({
            "requestId": request,
            "projectId": "p1",
            "sessionId": "ai-session",
            "surface": "in-app-agent",
            "kind": "reorganize",
            "updatedAt": "2026-10-19T01:00:00Z",
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
    let renamed = arm(&env, "b1");
    apply_ai_tree_plan(
        db(&env),
        plan(
            "ai-rename",
            json!([{ "id": "b1", "baseVersion": 0, "placement": null, "title": "Renamed by AI" }]),
            json!([{ "op": "rename", "nodeId": "b1", "title": "Renamed by AI" }]),
        ),
    )
    .expect("AI rename");
    assert_eq!(scene_row(&env, "b1", "title"), "Renamed by AI");
    assert_expired(&env, "b1", &renamed, "AI rename");

    let moved = arm(&env, "b2");
    apply_ai_tree_plan(
        db(&env),
        plan(
            "ai-move",
            json!([{ "id": "b2", "baseVersion": 0,
                     "placement": { "parentId": "f2", "sortOrder": "a0" }, "title": null }]),
            json!([{ "op": "move", "nodeId": "b2", "newParentRef": "f2", "pos": {} }]),
        ),
    )
    .expect("AI move");
    assert_eq!(scene_row(&env, "b2", "parent_id"), "f2");
    assert_expired(&env, "b2", &moved, "AI move");
}

#[test]
fn e3_codex_rename_propagation_expires() {
    let env = fixture();
    let shown = arm(&env, "b1");
    let payload: CodexRenameApplyPayload = serde_json::from_value(json!({
        "requestId": writers::unique("rename"),
        "projectId": "p1",
        "sessionId": "session",
        "entryId": "c1",
        "updatedAt": T1,
        "updates": [
            { "kind": "scene-body", "refId": "b1", "baseVersion": 0,
              "value": "{\"type\":\"doc\",\"renamed\":true}", "charCount": 3 },
            { "kind": "node-title", "refId": "b1", "baseVersion": 0, "value": "Hero's scene" },
        ],
        "eventSummary": "{\"entryId\":\"c1\",\"oldName\":\"Hero\",\"newName\":\"Champion\"}",
        "eventUid": writers::unique("rename-event"),
        "timestamp": 1_792_000_000_000_i64,
    }))
    .expect("rename payload");
    apply_codex_rename(db(&env), payload).expect("codex rename");
    assert_eq!(scene_row(&env, "b1", "title"), "Hero's scene");
    assert_expired(&env, "b1", &shown, "Codex rename propagation");
}

#[test]
fn e3_bulk_and_temporal_operations_expire() {
    let env = fixture();
    let first = arm(&env, "b1");
    let second = arm(&env, "b2");
    let third = arm(&env, "b3");

    let forward = writers::bulk(
        db(&env),
        json!([
            { "kind": "sceneSetPov", "sceneId": "b1",
              "baseUpdatedAt": scene_row(&env, "b1", "updated_at"), "povCharacterId": "c1" },
            { "kind": "sceneSetDate", "sceneId": "b2",
              "baseUpdatedAt": scene_row(&env, "b2", "updated_at"),
              "startTime": 100, "startMinute": null, "startGranularity": "day",
              "endTime": null, "endMinute": null, "endGranularity": "none" },
        ]),
    );
    assert_expired(&env, "b1", &first, "bulk POV");
    assert_expired(&env, "b2", &second, "bulk date");
    let journal = forward["undoJournalId"].as_str().unwrap().to_owned();
    for direction in ["undo", "redo"] {
        writers::undo_or_redo(db(&env), &journal, direction);
        assert_expired(&env, "b1", &first, &format!("bulk {direction} (POV)"));
        assert_expired(&env, "b2", &second, &format!("bulk {direction} (date)"));
    }
    writers::bulk(
        db(&env),
        json!([{ "kind": "sceneClearDate", "sceneId": "b2",
                 "baseUpdatedAt": scene_row(&env, "b2", "updated_at") }]),
    );
    assert_expired(&env, "b2", &second, "bulk clear date");

    env.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            let version: i64 =
                tx.query_row("SELECT version FROM tree_nodes WHERE id = 'b3'", [], |r| r.get(0))?;
            let payload = crate::narrative_extraction::temporal_operations::parse_scene_metadata_patch_payload(
                &json!({ "sceneId": "b3", "baseVersion": version, "startTime": 10,
                         "startGranularity": "day", "endGranularity": "none" }),
            )?;
            crate::narrative_extraction::temporal_operations::apply_scene_metadata_patch_in_tx(
                tx, "p1", &payload, "2026-10-19T05:00:00.000Z",
            )?;
            Ok(())
        })
    });
    assert_expired(&env, "b3", &third, "temporal Chronicle metadata patch");

    let fourth = arm(&env, "b3");
    env.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            let version: i64 =
                tx.query_row("SELECT version FROM tree_nodes WHERE id = 'b3'", [], |r| r.get(0))?;
            let payload = crate::narrative_extraction::temporal_operations::parse_story_order_materialize_payload(
                &json!({ "sceneId": "b3", "baseVersion": version,
                         "storyTimeOrder": "k0", "storyTimeLabel": "Day 1" }),
            )?;
            crate::narrative_extraction::temporal_operations::apply_story_order_materialize_in_tx(
                tx, "p1", &payload, "2026-10-19T06:00:00.000Z",
            )?;
            Ok(())
        })
    });
    assert_expired(&env, "b3", &fourth, "story order materialize");
}

#[test]
fn e3_folder_move_reorder_archive_and_back_never_hold_again() {
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
            json!({ "archivedAt": T1 }),
            json!({ "archivedAt": null }),
        ),
    ];
    for (name, forward, back) in cases {
        for bump in [true, false] {
            let env = fixture();
            add_folder(&env, "f2");
            // Two Scenes under f1, and one outside it.
            for id in ["u1", "u2"] {
                add_scene(&env, id, Some("f1"), true);
                add_pin(&env, id, "2026-10-19T00:20:00Z");
            }
            let under_a = arm(&env, "u1");
            let under_b = arm(&env, "u2");
            let outside = arm(&env, "b1");

            patch(&env, "f1", forward.clone(), bump, T1);
            assert_expired(&env, "u1", &under_a, &format!("folder {name}, bump={bump}"));
            assert_expired(
                &env,
                "u2",
                &under_b,
                &format!("folder {name} (2), bump={bump}"),
            );
            assert_holds(&env, "b1", "a Scene outside the folder is not touched");
            let _ = &outside;

            patch(&env, "f1", back.clone(), bump, T2);
            assert_expired(
                &env,
                "u1",
                &under_a,
                &format!("folder {name} back, bump={bump}"),
            );
            assert_expired(
                &env,
                "u2",
                &under_b,
                &format!("folder {name} back (2), bump={bump}"),
            );
            assert_holds(&env, "b1", "the outside Scene after the round trip");
        }
    }
}

// ---- E4: A1, registry, Codex characters -------------------------------------------------

#[test]
fn e4_a1_update_same_value_holder_set_and_put_back_never_hold_again() {
    let env = fixture();
    add_pin(&env, SCENE, "2026-10-19T00:30:00Z");
    let shown = arm(&env, SCENE);
    let version = |env: &Env| {
        db(env)
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SCENE))
            .unwrap()
            .binding
            .version
    };
    // The same A1 value, written again: a new generation.
    let reader = |env: &Env| {
        update_narrative_scene_scope(
            db(env),
            a1_with(version(env), NarrativeScopePrincipalV1::Reader {}, T1),
        )
        .expect("A1 update");
    };
    reader(&env);
    assert_expired(&env, SCENE, &shown, "A1 written again");
    update_narrative_scene_scope(
        db(&env),
        a1_with(
            version(&env),
            NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            },
            T2,
        ),
    )
    .expect("A1 holder set");
    assert_expired(&env, SCENE, &shown, "A1 holder set");
    update_narrative_scene_scope(
        db(&env),
        a1_with(
            version(&env),
            NarrativeScopePrincipalV1::Reader {},
            "2026-10-19T03:00:00.000Z",
        ),
    )
    .expect("A1 holder back");
    assert_expired(&env, SCENE, &shown, "A1 holder put back");
}

/// CB-1's payload builder names Scene `s1` and unresolved query axes; the
/// reader needs resolved axes, so the Scene's own A1 is rewritten with the
/// same axes the fixture gave it.
fn a1_with(
    base_version: i64,
    holder: NarrativeScopePrincipalV1,
    updated_at: &str,
) -> crate::narrative_extraction::NarrativeSceneScopeUpdatePayload {
    use grimodex_core::narrative_scene_scope::NarrativeScopeConstraintV1::Exact;
    let mut payload = writers::a1_payload(base_version, holder, updated_at);
    payload.scope.query_identity.timeline = Exact {
        reference: "tl".into(),
    };
    payload.scope.query_identity.worldline = Exact {
        reference: "wl".into(),
    };
    payload.scope.query_identity.narrative_layer = Exact {
        reference: "ly".into(),
    };
    payload
}

#[test]
fn e4_registry_change_and_change_back_expire_every_declaration_of_the_project() {
    let env = fixture();
    add_pin(&env, SCENE, "2026-10-19T00:30:00Z");
    let armed: Vec<(String, GraphOnlySceneBinding)> = ["b1", "b2", "b3", SCENE]
        .iter()
        .map(|scene| (scene.to_string(), arm(&env, scene)))
        .collect();

    writers::registry_edit(db(&env), Some("timeline:extra"));
    for (scene, shown) in &armed {
        assert_expired(&env, scene, shown, &format!("registry change, {scene}"));
    }
    // A -> B -> A on the registry brings none of them back (XK-3).
    writers::registry_edit(db(&env), None);
    for (scene, shown) in &armed {
        assert_expired(&env, scene, shown, &format!("registry put back, {scene}"));
    }
}

#[test]
fn e4_codex_character_restore_invalidating_a1_expires() {
    let env = fixture();
    add_pin(&env, SCENE, "2026-10-19T00:30:00Z");
    let version = db(&env)
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SCENE))
        .unwrap()
        .binding
        .version;
    update_narrative_scene_scope(
        db(&env),
        a1_with(
            version,
            NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            },
            T1,
        ),
    )
    .expect("A1 names the character as holder");
    // The query Scene's holder must be the same character for the reader.
    set_query_holder_to_character(&env);
    let declared = arm(&env, SCENE);

    let events = env.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            invalidate_character_references_with_events_in_tx(tx, "p1", "c1", T2)
        })
    });
    assert!(
        !events.is_empty(),
        "the Scene that names c1 gets an A1 event"
    );
    // The restore also reset the query Scene's A1 (it names c1 too), so the
    // query is unavailable and nothing can be shown. The Scene's own A1 moved
    // on from the one the declaration was bound to.
    assert_expired(&env, SCENE, &declared, "character restore invalidates A1");
    let current_scope_token: String = env.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT source_token FROM narrative_scene_scope_bindings WHERE scene_id = ?1",
            [SCENE],
            |row| row.get(0),
        )?)
    });
    assert_ne!(current_scope_token, declared.scope_source_token);
}

/// Gives the query Scene (and so the query context) the same holder, so the
/// Scene that names the character is a candidate the reader accepts.
fn set_query_holder_to_character(env: &Env) {
    let query_scene = super::tests::QUERY;
    let version = db(env)
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, query_scene))
        .unwrap()
        .binding
        .version;
    use grimodex_core::narrative_scene_scope::NarrativeScopeConstraintV1::Exact;
    let mut payload = writers::a1_payload(
        version,
        NarrativeScopePrincipalV1::Character {
            reference: "c1".into(),
        },
        T1,
    );
    payload.scene_id = query_scene.into();
    payload.scope.query_identity.timeline = Exact {
        reference: "tl".into(),
    };
    payload.scope.query_identity.worldline = Exact {
        reference: "wl".into(),
    };
    payload.scope.query_identity.narrative_layer = Exact {
        reference: "ly".into(),
    };
    update_narrative_scene_scope(db(env), payload).expect("query Scene holder");
}

// ---- E5: restores ---------------------------------------------------------------------------

fn revision_restore(env: &Env, scene: &str, request: &str, same_bytes: bool) {
    let target = body_json("A restored body.");
    let revision = writers::unique("revision");
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type)
             VALUES (?1, 'scene', ?2, ?3, 1, 'auto')",
            params![revision, scene, target],
        )?;
        if same_bytes {
            conn.execute(
                "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
                params![scene, target],
            )?;
        }
        Ok(())
    });
    let version: i64 = env.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM tree_nodes WHERE id = ?1",
            [scene],
            |r| r.get(0),
        )?)
    });
    crate::revision_restore::restore_scene_revision(
        db(env),
        crate::revision_restore::RestoreSceneRevisionPayload {
            request_id: request.to_owned(),
            session_id: "session".into(),
            project_id: PROJECT.into(),
            entity_type: "scene".into(),
            entity_id: scene.into(),
            revision_id: revision,
            content: target.clone(),
            current_content: scene_row(env, scene, "content"),
            expected_version: version,
            char_count: 8,
            placed_beat_preview: None,
        },
    )
    .expect("restore the revision");
    assert_eq!(scene_row(env, scene, "content"), target);
}

#[test]
fn e5_body_version_restore_expires_also_with_identical_bytes() {
    let env = fixture();
    for (scene, same) in [("b1", false), ("b2", true)] {
        let shown = arm(&env, scene);
        revision_restore(&env, scene, &writers::unique("restore"), same);
        assert_expired(
            &env,
            scene,
            &shown,
            &format!("revision restore, identical={same}"),
        );
        // A declaration made afterwards is a new one and holds; the old
        // binding is still refused.
        place_real(&env, scene);
        assert_holds(&env, scene, "declared again after the restore");
        assert_refused(&env, &shown, "the old response after a new declaration");
    }
}

#[test]
fn e5_project_snapshot_restore_clears_the_declaration() {
    use crate::project_snapshots::{
        apply_project_snapshot_restore, create_project_snapshot,
        ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
    };
    let env = fixture();
    let shown = arm(&env, "b1");
    create_project_snapshot(
        db(&env),
        CreateProjectSnapshotPayload {
            project_id: PROJECT.into(),
            snapshot_id: "snap-1".into(),
            name: "Snapshot".into(),
            description: None,
            created_at: T1.into(),
            tree_rows: Vec::new(),
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        },
    )
    .expect("snapshot");
    let selected = [RestoreScope::Labels].into_iter().collect();
    let inserts = env.with_conn(|conn| {
        crate::project_snapshots::build_canonical_restore_plan(conn, PROJECT, "snap-1", &selected)
    });
    apply_project_snapshot_restore(
        db(&env),
        ApplyProjectSnapshotRestorePayload {
            request_id: writers::unique("snapshot-restore"),
            session_id: "session".into(),
            project_id: PROJECT.into(),
            snapshot_id: "snap-1".into(),
            scopes: vec![RestoreScope::Labels],
            inserts,
        },
    )
    .expect("restore");
    assert_expired(&env, "b1", &shown, "project snapshot restore");
    place_real(&env, "b1");
    assert_holds(&env, "b1", "declared again after the restore");
}

#[test]
fn e5_staged_restore_clear_expires_every_declaration() {
    let env = fixture();
    let armed: Vec<_> = ["b1", "b2", "b3"]
        .iter()
        .map(|s| (s.to_string(), arm(&env, s)))
        .collect();
    let cleared = clear_all_scene_body_declarations_for_staged_restore(db(&env)).expect("clear");
    assert_eq!(cleared, 3);
    for (scene, shown) in &armed {
        assert_expired(
            &env,
            scene,
            shown,
            &format!("backup / Safe Mode restore, {scene}"),
        );
    }
    place_real(&env, "b1");
    assert_holds(&env, "b1", "declared again after the restore");
}

// ---- E6: identity ----------------------------------------------------------------------------

#[test]
fn e6_a_duplicate_has_no_declaration() {
    let env = fixture();
    let shown = arm(&env, "b1");
    let content = scene_row(&env, "b1", "content");
    writers::create_scene(db(&env), "b1-copy", "Title of b1", &content);
    set_a1(db(&env), PROJECT, "b1-copy", true);
    add_pin(&env, "b1-copy", "2026-10-19T00:40:00Z");
    // Everything but the declaration is in place for the copy.
    let result = answer(&env, fresh(&env, "b1-copy").unwrap()).unwrap();
    assert!(
        matches!(result, GraphOnlySceneDisclosure::NotAppended(NotAppended)),
        "{result:?}"
    );
    place_real(&env, "b1-copy");
    assert_holds(
        &env,
        "b1-copy",
        "control: the copy is eligible once it is declared",
    );
    assert_holds(&env, "b1", "the original is untouched by its duplicate");
    click(&env, &shown).expect("click");
}

/// The Scene has no declaration (or no binding row at all).
fn assert_no_stored_declaration(env: &Env, scene: &str, step: &str) {
    let read = env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, scene));
    assert!(
        matches!(
            read,
            SceneBodyDeclarationRead::None | SceneBodyDeclarationRead::Unavailable(_)
        ),
        "{step}: expected no declaration, read {read:?}"
    );
}

#[test]
fn e6_delete_and_recreate_with_the_same_id_has_no_declaration() {
    let env = fixture();
    let shown = arm(&env, "b1");
    let content = scene_row(&env, "b1", "content");
    let title = scene_row(&env, "b1", "title");
    writers::delete_scene(db(&env), "b1");
    assert_expired(&env, "b1", &shown, "after delete");
    writers::create_scene(db(&env), "b1", &title, &content);
    add_pin(&env, "b1", "2026-10-19T00:00:00Z");
    assert_no_stored_declaration(&env, "b1", "recreated with the same id");
    assert_expired(&env, "b1", &shown, "recreated with the same id");
}

#[test]
fn e6_trash_restore_does_not_bring_back_the_declaration() {
    let env = fixture();
    let shown = arm(&env, "b1");
    let title = scene_row(&env, "b1", "title");
    let content = scene_row(&env, "b1", "content");
    writers::delete_scene(db(&env), "b1");
    let trash: crate::trash_bin::TrashBinCreatePayload = serde_json::from_value(json!({
        "id": "trash-b1",
        "projectId": "p1",
        "kind": "structure-item",
        "subKind": "scene",
        "originSceneId": null,
        "originCodexId": null,
        "previewText": "restore candidate",
        "previewMeta": null,
        "payload": json!({
            "originalId": "b1", "title": title, "body": content, "beats": "[]",
            "povCharacterId": null, "folderHintId": null, "folderHintName": null,
            "metadata": { "synopsis": null, "status": "draft", "nodeType": "scene",
                          "locationId": null, "sortOrder": "a0", "storyTimeOrder": null,
                          "storyTimeLabel": null },
            "charCount": 0
        }).to_string(),
        "charCount": 0,
        "isInteresting": true,
        "deletedAt": "2026-10-19T01:00:00Z",
    }))
    .expect("trash payload");
    crate::trash_bin::create(db(&env), trash).expect("trash item");
    let restored = crate::trash_bin::restore(
        db(&env),
        crate::trash_bin::TrashBinRestorePayload {
            request_id: writers::unique("trash-restore"),
            session_id: "session".into(),
            project_id: PROJECT.into(),
            item_id: "trash-b1".into(),
            board_id_override: None,
            drop_x: None,
            drop_y: None,
        },
    )
    .expect("restore from Trash");
    assert_no_stored_declaration(&env, &restored.new_id, "the restored Scene");
    assert_no_stored_declaration(&env, "b1", "the deleted Scene's id");
    set_a1(db(&env), PROJECT, &restored.new_id, true);
    add_pin(&env, &restored.new_id, "2026-10-19T00:41:00Z");
    if let Some(now) = fresh(&env, &restored.new_id) {
        let result = answer(&env, now).unwrap();
        assert!(
            matches!(result, GraphOnlySceneDisclosure::NotAppended(NotAppended)),
            "{result:?}"
        );
    }
    assert_expired(&env, "b1", &shown, "the old response after a Trash restore");
}

// ---- E7: the workspace ------------------------------------------------------------------------

#[cfg(unix)]
mod workspace {
    use super::*;
    use std::path::{Path as FsPath, PathBuf};

    fn copy_dir(from: &FsPath, to: &FsPath) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn sibling(env: &Env, suffix: &str) -> PathBuf {
        let name = env.path.file_name().unwrap().to_string_lossy().into_owned();
        env.path.with_file_name(format!("{name}-{suffix}"))
    }

    #[test]
    fn e7_a_copy_of_the_workspace_is_refused_and_the_original_path_holds_again() {
        let mut env = fixture();
        let shown = arm(&env, "b1");
        env.close();
        let copy = sibling(&env, "copy");
        copy_dir(&env.path, &copy);
        env.reopen_via(&copy);
        // Same workspace ID, same rows, another canonical locator.
        assert_expired(&env, "b1", &shown, "a copy of the workspace");
        env.close();
        let _ = std::fs::remove_dir_all(&copy);

        // Back at the original folder with the original ID: the same bytes of
        // the declaration are valid again, and the old response is allowed.
        env.reopen();
        assert_holds(&env, "b1", "the original path");
        assert!(matches!(
            click(&env, &shown).unwrap(),
            GraphOnlyClick::Allowed(_)
        ));
    }

    #[test]
    fn e7_a_moved_workspace_and_a_changed_workspace_id_are_refused() {
        let mut env = fixture();
        let shown = arm(&env, "b1");

        // The workspace ID changes.
        let original_id = env.workspace_id.clone();
        env.close();
        env.workspace_id = "another-workspace-id".into();
        env.reopen();
        assert_expired(&env, "b1", &shown, "another workspace ID");

        // The folder moves (another canonical locator, the ID restored).
        env.close();
        let moved = sibling(&env, "moved");
        copy_dir(&env.path, &moved);
        env.workspace_id = original_id;
        env.reopen_via(&moved);
        assert_expired(&env, "b1", &shown, "a moved workspace");
        env.close();
        let _ = std::fs::remove_dir_all(&moved);

        env.reopen();
        assert_holds(&env, "b1", "the original path and ID");
    }
}

// ---- E8: veto records ---------------------------------------------------------------------------

#[test]
fn e8_secret_records_added_after_the_declaration_expire_it_and_removing_them_restores_it() {
    let env = fixture();
    let ids = scenes(&env, "m", 3);
    let armed: Vec<_> = ids.iter().map(|id| (id.clone(), arm(&env, id))).collect();

    foreshadow(&env, "fs1", 1, Some("m0"));
    event(&env, "ev1", 1, Some("m1"));
    event(&env, "ev2", 1, None);
    execute(
        &env,
        "INSERT INTO scene_events (scene_id, event_id) VALUES ('m2', 'ev2');",
    );
    for (scene, shown) in &armed {
        assert_expired(&env, scene, shown, &format!("secret record, {scene}"));
    }

    // The records are rows the author can remove; the binding was never
    // touched, so the same bytes of the declaration are usable again.
    execute(
        &env,
        "DELETE FROM scene_events WHERE event_id = 'ev2';
         DELETE FROM events WHERE id IN ('ev1', 'ev2');
         DELETE FROM foreshadows WHERE id = 'fs1';",
    );
    for (scene, _) in &armed {
        assert_holds(&env, scene, &format!("records removed, {scene}"));
    }
}

#[test]
fn e8_a_pov_added_after_the_declaration_does_not_come_back_when_removed() {
    let env = fixture();
    let shown = arm(&env, "b1");
    patch(&env, "b1", json!({ "povCharacterId": "c1" }), true, T1);
    assert_expired(&env, "b1", &shown, "POV set");
    patch(&env, "b1", json!({ "povCharacterId": null }), true, T2);
    assert_expired(&env, "b1", &shown, "POV removed again");
}

// ---- E9: revoke, resend, re-declare ----------------------------------------------------------------

#[test]
fn e9_a_revoke_its_resend_and_a_new_declaration() {
    let env = Env::new();
    add_pin(&env, SCENE, "2026-10-19T00:50:00Z");
    let request = request_for(&env, PROJECT, SCENE);
    declare(&env, request.clone()).expect("production declaration");
    let shown = eligible(disclose(&env, &[SCENE])).binding().clone();
    let token = env.declaration_token(SCENE).expect("declared");

    let revoke = revoke_request(PROJECT, SCENE, &token);
    let revoked = revoke_scene_body(
        &env.snapshot(),
        revoke.clone(),
        &budget(),
    )
    .unwrap();
    assert_eq!(revoked.response, RevokeResponse::Revoked);
    assert_expired(&env, SCENE, &shown, "after the revoke");

    // The resend answers from its record and brings nothing back.
    let replay = revoke_scene_body(
        &env.snapshot(),
        revoke.clone(),
        &budget(),
    )
    .unwrap();
    assert!(replay.replayed);
    assert_expired(&env, SCENE, &shown, "the revoke resent");

    // Sending the very first declare request again is a replay of its record.
    let _ = declare(&env, request);
    assert_nothing_added(&disclose(&env, &[SCENE]));
    assert_refused(&env, &shown, "after the declaration request was resent");

    // A new declaration is a new one: it holds, and the old response does not.
    declare(&env, request_for(&env, PROJECT, SCENE)).expect("declared again");
    assert_holds(&env, SCENE, "declared again");
    assert_refused(&env, &shown, "the old response after a new declaration");
}
