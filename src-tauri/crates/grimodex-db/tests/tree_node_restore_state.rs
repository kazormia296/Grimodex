//! 削除の undo で DB の行が削除前に戻ること（DR-UND-1、
//! `docs/plans/tree-undo-restore-decisions.md`）の受入れ試験。
//!
//! このファイルの最初の版は「今の挙動」の特性試験で、欠落を固定する。
//! 実装の commit で、欠落を固定した期待は反転する。

use grimodex_db::domain_writes::{
    tree_node_create, tree_node_delete, tree_node_patch, TreeNodeCreatePayload,
    TreeNodeDeletePayload, TreeNodePatchPayload,
};
use grimodex_db::Database;
use rusqlite::OptionalExtension;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const P: &str = "undo-p1";
const SESSION: &str = "undo-session";

fn de<T: DeserializeOwned>(value: Value) -> anyhow::Result<T> {
    Ok(serde_json::from_value(value)?)
}

fn new_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "INSERT INTO projects (id, title) VALUES ('{P}', 'One'), ('undo-p2', 'Two');
             INSERT INTO narrative_semantic_epochs
                 (id, project_id, epoch_number, reason, created_at)
             VALUES ('undo-epoch', '{P}', 0, 'initial', '2026-08-23T00:00:00.000Z');
             INSERT INTO chat_sessions (id, project_id, title)
               VALUES ('{SESSION}', '{P}', 'Local session');
             INSERT INTO codex_entries (id, project_id, type, name)
               VALUES ('pov-1', '{P}', 'character', 'Pov'),
                      ('place-1', '{P}', 'location', 'Place'),
                      ('foreign-codex', 'undo-p2', 'character', 'Foreign');"
        ))?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn create_payload(id: &str, node_type: &str, parent: Option<&str>) -> Value {
    json!({
        "id": id, "projectId": P, "requestId": format!("create-{id}"),
        "sessionId": SESSION, "eventUid": format!("uid-create-{id}"),
        "origin": "human", "parentId": parent, "nodeType": node_type,
        "title": format!("Title {id}"), "sortOrder": "a0", "synopsis": "syn",
        "status": "draft", "sourceUri": null, "sourceMtime": null,
        "content": null
    })
}

fn create(db: &Database, payload: Value) -> anyhow::Result<Value> {
    tree_node_create(db, de::<TreeNodeCreatePayload>(payload)?)
}

fn patch(db: &Database, id: &str, req: &str, patch: Value) -> anyhow::Result<Value> {
    tree_node_patch(
        db,
        de::<TreeNodePatchPayload>(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION,
            "eventUid": format!("uid-{req}"), "nodeId": id,
            "patch": patch, "baseVersion": null, "bumpVersion": false,
            "updatedAt": "2026-08-24T00:00:00.000Z", "changeEvent": null,
            "origin": "human"
        }))?,
    )
}

fn delete(db: &Database, id: &str, req: &str) -> anyhow::Result<Value> {
    tree_node_delete(
        db,
        de::<TreeNodeDeletePayload>(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION,
            "eventUid": format!("uid-{req}"), "origin": "human", "nodeId": id
        }))?,
    )
}

/// undo の create の payload（今の renderer が渡す欄だけ）。
fn undo_create_payload(node: &Value, delete_receipt: &Value, req: &str) -> Value {
    json!({
        "id": node["id"], "projectId": P, "requestId": req,
        "sessionId": SESSION, "eventUid": format!("uid-{req}"),
        "origin": "undo",
        "originalTransactionId": delete_receipt["maintenanceTransactionId"],
        "undoJournalId": delete_receipt["undoJournalId"],
        "parentId": node["parentId"], "nodeType": node["nodeType"],
        "title": node["title"], "sortOrder": node["sortOrder"],
        "synopsis": node["synopsis"], "status": node["status"],
        "sourceUri": null, "sourceMtime": null,
        "content": node["content"]
    })
}

fn row(db: &Database, id: &str) -> Option<serde_json::Map<String, Value>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT json_object(
                   'parentId', parent_id, 'intent', intent,
                   'storyTimeOrder', story_time_order, 'storyTimeLabel', story_time_label,
                   'povCharacterId', pov_character_id, 'locationId', location_id,
                   'chronicleStartTime', chronicle_start_time,
                   'chronicleStartMinute', chronicle_start_minute,
                   'chronicleStartGranularity', chronicle_start_granularity,
                   'chronicleEndTime', chronicle_end_time,
                   'chronicleEndMinute', chronicle_end_minute,
                   'chronicleEndGranularity', chronicle_end_granularity,
                   'chroniclePrecision', chronicle_precision,
                   'content', content, 'unplacedBeatsDoc', unplaced_beats_doc,
                   'unplacedBeatPreview', unplaced_beat_preview,
                   'placedBeatPreview', placed_beat_preview,
                   'sourceUri', source_uri, 'sourceMtime', source_mtime,
                   'contextMode', context_mode, 'aliases', aliases,
                   'excludedAliases', excluded_aliases,
                   'createdAt', created_at, 'version', version)
                   FROM tree_nodes WHERE id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
    .expect("row")
    .map(|s| {
        serde_json::from_str::<Value>(&s)
            .expect("json")
            .as_object()
            .cloned()
            .expect("object")
    })
}

fn payload_hash(db: &Database, domain: &str, request_id: &str) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT payload_hash FROM idempotency_requests
              WHERE domain = ?1 AND request_id = ?2",
            [domain, request_id],
            |r| r.get::<_, String>(0),
        )?)
    })
    .expect("payload hash")
}

/// `restoreState` を持たない通常の create の fingerprint は変えない。
/// 欄を足すとき `skip_serializing_if` を落とすと、この値が変わる。
#[test]
fn plain_create_fingerprint_is_pinned() {
    let db = new_db();
    create(&db, create_payload("fp-scene", "scene", None)).expect("create");
    assert_eq!(
        payload_hash(&db, "tree_node_create", "create-fp-scene"),
        "68f8fa140cad30068231bdbd2d6d7f7ef3602d1e3e3dff6c7c45f0481cd45dc7"
    );
}

/// 今の undo（renderer が渡す欄だけ）で欠落する欄を実 DB で固定する。
/// 実装後、この欠落の期待は「戻る」に反転する。
#[test]
fn current_undo_of_a_scene_drops_non_create_columns() {
    let db = new_db();
    create(&db, create_payload("scene-a", "scene", None)).expect("create");
    patch(
        &db,
        "scene-a",
        "patch-a",
        json!({
            "intent": "goal", "storyTimeOrder": "b3", "storyTimeLabel": "夜",
            "povCharacterId": "pov-1", "locationId": "place-1",
            "unplacedBeatsDoc": "[{\"id\":\"b1\"}]",
            "unplacedBeatPreview": "beat", "placedBeatPreview": "[\"p\"]",
            "sourceUri": "external-root://r/a.md", "sourceMtime": "2026-01-01T00:00:00Z"
        }),
    )
    .expect("patch");
    let before = row(&db, "scene-a").expect("row");
    assert_eq!(before["storyTimeOrder"], json!("b3"));
    let receipt = delete(&db, "scene-a", "delete-a").expect("delete");
    assert!(row(&db, "scene-a").is_none());
    let node = json!({
        "id": "scene-a", "parentId": null, "nodeType": "scene",
        "title": "Title scene-a", "sortOrder": "a0", "synopsis": "syn",
        "status": "draft", "content": "{\"type\":\"doc\"}"
    });
    create(&db, undo_create_payload(&node, &receipt, "undo-a")).expect("undo create");
    let after = row(&db, "scene-a").expect("restored row");
    for key in [
        "intent",
        "storyTimeOrder",
        "storyTimeLabel",
        "povCharacterId",
        "locationId",
        "unplacedBeatPreview",
        "placedBeatPreview",
        "sourceUri",
        "sourceMtime",
        "contextMode",
    ] {
        assert!(after[key].is_null(), "{key} is dropped by today's undo");
    }
    assert_eq!(after["aliases"], json!("[]"));
    assert_eq!(after["excludedAliases"], json!("[]"));
    assert_eq!(after["unplacedBeatsDoc"], json!("[]"));
    assert_eq!(after["chronicleStartGranularity"], json!("none"));
    assert_eq!(after["chroniclePrecision"], json!("exact"));
    assert_eq!(after["content"], json!("{\"type\":\"doc\"}"));
    assert_ne!(after["createdAt"], before["createdAt"]);
}

/// folder と子の undo：子の create が journal の束縛（`entity_id == node_id`）で
/// 拒まれるかを今の実 DB で確かめる（反証 P1-1）。結果を固定する。
#[test]
fn current_undo_of_a_folder_subtree_child_is_pinned() {
    let db = new_db();
    create(&db, create_payload("folder-a", "folder", None)).expect("create folder");
    create(&db, create_payload("child-a", "scene", Some("folder-a"))).expect("create child");
    let receipt = delete(&db, "folder-a", "delete-folder").expect("delete folder");
    let folder = json!({
        "id": "folder-a", "parentId": null, "nodeType": "folder",
        "title": "Title folder-a", "sortOrder": "a0", "synopsis": "syn",
        "status": "draft", "content": null
    });
    let child = json!({
        "id": "child-a", "parentId": "folder-a", "nodeType": "scene",
        "title": "Title child-a", "sortOrder": "a0", "synopsis": "syn",
        "status": "draft", "content": null
    });
    create(&db, undo_create_payload(&folder, &receipt, "undo-folder")).expect("undo folder");
    let outcome = create(&db, undo_create_payload(&child, &receipt, "undo-child"));
    assert_eq!(
        outcome.as_ref().err().map(|e| e.to_string()),
        Some("tree replay target does not match the named Undo Journal".to_string()),
        "outcome: {outcome:?}"
    );
}
