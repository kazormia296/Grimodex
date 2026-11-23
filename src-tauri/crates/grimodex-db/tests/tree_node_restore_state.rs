//! 削除の undo で DB の行が削除前に戻ること（DR-UND-1、
//! `docs/plans/tree-undo-restore-decisions.md`）の受入れ試験。
//!
//! このファイルの最初の版は「今の挙動」の特性試験で、欠落を固定する。
//! 実装の commit で、欠落を固定した期待は反転する。

use grimodex_db::domain_writes::{
    tree_node_create, tree_node_create_wire_with_authority, tree_node_delete, tree_node_patch,
    TreeNodeCreatePayload, TreeNodeCreateWire, TreeNodeDeletePayload, TreeNodePatchPayload,
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
            "sourceUri": "external-root://r/a.md", "sourceMtime": "2026-01-01T00:00:00Z",
            "chronicleStartTime": 100, "chronicleStartGranularity": "day",
            "chroniclePrecision": "approx"
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

// ---------------------------------------------------------------------------
// DR-UND-1: restoreState
// ---------------------------------------------------------------------------

const PLAIN_FINGERPRINT: &str = "68f8fa140cad30068231bdbd2d6d7f7ef3602d1e3e3dff6c7c45f0481cd45dc7";

fn create_wire(db: &Database, payload: Value) -> anyhow::Result<Value> {
    tree_node_create_wire_with_authority(db, de::<TreeNodeCreateWire>(payload)?, None)
}

fn with_restore_state(mut payload: Value, restore_state: Value) -> Value {
    payload["restoreState"] = restore_state;
    payload
}

/// 全欄を埋めた scene を作って削除し、削除前の行（DB から読んだもの）を返す。
fn seeded_scene(db: &Database, id: &str) -> (serde_json::Map<String, Value>, Value) {
    create(db, create_payload(id, "scene", None)).expect("create");
    patch(
        db,
        id,
        &format!("patch-{id}"),
        json!({
            "intent": "goal", "storyTimeOrder": "b3", "storyTimeLabel": "夜",
            "povCharacterId": "pov-1", "locationId": "place-1",
            "unplacedBeatsDoc": "[{\"id\":\"b1\"}]",
            "unplacedBeatPreview": "beat", "placedBeatPreview": "[\"p\"]",
            "sourceUri": "external-root://r/a.md", "sourceMtime": "2026-01-01T00:00:00Z",
            "content": "{\"type\":\"doc\"}",
            "chronicleStartTime": 100, "chronicleStartMinute": 540,
            "chronicleStartGranularity": "time", "chronicleEndTime": 101,
            "chronicleEndGranularity": "day", "chroniclePrecision": "approx"
        }),
    )
    .expect("patch");
    let before = row(db, id).expect("row");
    let receipt = delete(db, id, &format!("delete-{id}")).expect("delete");
    (before, receipt)
}

fn restore_state_of(before: &serde_json::Map<String, Value>) -> Value {
    let mut state = serde_json::Map::new();
    for key in [
        "intent",
        "storyTimeOrder",
        "storyTimeLabel",
        "povCharacterId",
        "locationId",
        "contextMode",
        "aliases",
        "excludedAliases",
        "unplacedBeatsDoc",
        "unplacedBeatPreview",
        "placedBeatPreview",
        "createdAt",
        "chronicleStartTime",
        "chronicleStartMinute",
        "chronicleStartGranularity",
        "chronicleEndTime",
        "chronicleEndMinute",
        "chronicleEndGranularity",
        "chroniclePrecision",
    ] {
        if !before[key].is_null() {
            state.insert(key.to_string(), before[key].clone());
        }
    }
    Value::Object(state)
}

fn undo_payload_with_state(
    id: &str,
    node_type: &str,
    before: &serde_json::Map<String, Value>,
    receipt: &Value,
    req: &str,
) -> Value {
    let node = json!({
        "id": id, "parentId": before["parentId"], "nodeType": node_type,
        "title": format!("Title {id}"), "sortOrder": "a0", "synopsis": "syn",
        "status": "draft", "content": before["content"]
    });
    let mut payload = undo_create_payload(&node, receipt, req);
    payload["sourceUri"] = before["sourceUri"].clone();
    payload["sourceMtime"] = before["sourceMtime"].clone();
    with_restore_state(payload, restore_state_of(before))
}

fn count(db: &Database, sql: &str) -> i64 {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))?))
        .expect("count")
}

#[test]
fn wire_without_restore_state_keeps_the_plain_fingerprint() {
    let db = new_db();
    create_wire(&db, create_payload("fp-scene", "scene", None)).expect("create");
    assert_eq!(
        payload_hash(&db, "tree_node_create", "create-fp-scene"),
        PLAIN_FINGERPRINT
    );
}

#[test]
fn undo_with_restore_state_returns_a_scene_row_to_its_state_before_the_delete() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-r");
    let journal_before = count(&db, "SELECT COUNT(*) FROM undo_journal");
    let response = create_wire(
        &db,
        undo_payload_with_state("scene-r", "scene", &before, &receipt, "undo-r"),
    )
    .expect("undo create");
    let after = row(&db, "scene-r").expect("restored row");
    // version と updated_at 以外（createdAt を含む）が削除前と同じ。
    assert_eq!(Value::Object(after.clone()), Value::Object(before.clone()));
    assert_eq!(after["version"], json!(0));
    for (key, expected) in [
        ("intent", json!("goal")),
        ("storyTimeOrder", json!("b3")),
        ("povCharacterId", json!("pov-1")),
        ("unplacedBeatsDoc", json!("[{\"id\":\"b1\"}]")),
        ("sourceUri", json!("external-root://r/a.md")),
    ] {
        assert_eq!(response[key], expected, "response {key}");
    }
    // 年表の 7 列も 1 組で戻る。
    for (key, expected) in [
        ("chronicleStartTime", json!(100)),
        ("chronicleStartMinute", json!(540)),
        ("chronicleStartGranularity", json!("time")),
        ("chronicleEndTime", json!(101)),
        ("chronicleEndGranularity", json!("day")),
        ("chroniclePrecision", json!("approx")),
    ] {
        assert_eq!(response[key], expected, "response {key}");
        assert_eq!(after[key], expected, "row {key}");
    }
    assert!(after["chronicleEndMinute"].is_null());
    // 復元した scene にも Scope の束縛が従来どおり作られる。
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE scene_id = 'scene-r'"
        ),
        1
    );
    // undo の create は journal を増やさない（削除の 1 件のまま）。
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM undo_journal"),
        journal_before
    );
    // FTS は 1 行（title・content を UPDATE が触らない）。
    assert_eq!(count(&db, "SELECT COUNT(*) FROM tree_nodes_fts"), 1);
}

#[test]
fn undo_with_restore_state_returns_a_note_with_its_ai_context_settings() {
    let db = new_db();
    create(&db, create_payload("note-r", "note", None)).expect("create");
    patch(
        &db,
        "note-r",
        "patch-note",
        json!({
            "contextMode": "hidden", "aliases": "[\"a\",\"b\"]",
            "excludedAliases": "[\"c\"]", "content": "{\"type\":\"doc\",\"n\":1}"
        }),
    )
    .expect("patch note");
    let before = row(&db, "note-r").expect("row");
    let receipt = delete(&db, "note-r", "delete-note").expect("delete");
    create_wire(
        &db,
        undo_payload_with_state("note-r", "note", &before, &receipt, "undo-note"),
    )
    .expect("undo note");
    let after = row(&db, "note-r").expect("restored");
    assert_eq!(Value::Object(after.clone()), Value::Object(before));
    assert_eq!(after["contextMode"], json!("hidden"));
    assert_eq!(after["aliases"], json!("[\"a\",\"b\"]"));
}

#[test]
fn undo_with_restore_state_returns_a_folder() {
    let db = new_db();
    create(&db, create_payload("folder-r", "folder", None)).expect("create");
    patch(
        &db,
        "folder-r",
        "patch-f",
        json!({ "intent": "i", "storyTimeLabel": "L" }),
    )
    .expect("patch");
    let before = row(&db, "folder-r").expect("row");
    let receipt = delete(&db, "folder-r", "delete-f").expect("delete");
    create_wire(
        &db,
        undo_payload_with_state("folder-r", "folder", &before, &receipt, "undo-f"),
    )
    .expect("undo folder");
    assert_eq!(
        Value::Object(row(&db, "folder-r").unwrap()),
        Value::Object(before)
    );
}

#[test]
fn restore_state_is_refused_for_every_origin_except_undo() {
    let db = new_db();
    for (origin, extra) in [
        ("human", json!({})),
        ("import", json!({})),
        ("restore", json!({})),
        ("migration", json!({})),
        (
            "redo",
            json!({ "originalTransactionId": "t", "undoJournalId": "j" }),
        ),
    ] {
        let mut payload = create_payload(&format!("gate-{origin}"), "scene", None);
        payload["origin"] = json!(origin);
        payload["requestId"] = json!(format!("gate-req-{origin}"));
        for (k, v) in extra.as_object().unwrap() {
            payload[k] = v.clone();
        }
        let error = create_wire(&db, with_restore_state(payload, json!({ "intent": "x" })))
            .expect_err("restoreState must be refused");
        assert!(
            error
                .to_string()
                .contains("restoreState is only accepted for undo"),
            "{origin}: {error}"
        );
        assert!(row(&db, &format!("gate-{origin}")).is_none());
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'tree_node_create'"
        ),
        0
    );
}

#[test]
fn restore_state_rejects_unknown_incomplete_and_mistyped_keys() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-bad");
    let base = undo_payload_with_state("scene-bad", "scene", &before, &receipt, "undo-bad");
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "unknown key",
            json!({ "bogus": "x" }),
            "unknown field `bogus`",
        ),
        // 年表の 7 列は 1 組：片方だけ・形違いの組は拒む（範囲の整合は見ない。下の忠実な復元の試験）。
        (
            "chronicle key alone",
            json!({ "chronicleStartTime": 5 }),
            "one group",
        ),
        (
            "chronicle without precision",
            json!({ "chronicleStartGranularity": "none", "chronicleEndGranularity": "none" }),
            "one group",
        ),
        (
            "chronicle day as string",
            json!({ "chronicleStartTime": "5" }),
            "invalid type",
        ),
        (
            "chronicle fractional day",
            json!({ "chronicleStartTime": 1.5 }),
            "invalid type",
        ),
        (
            "chronicle unsafe day",
            json!({
                "chronicleStartTime": 9007199254740992_i64,
                "chronicleStartGranularity": "day",
                "chronicleEndGranularity": "none",
                "chroniclePrecision": "exact"
            }),
            "safe integer",
        ),
        (
            "chronicle bad granularity",
            json!({
                "chronicleStartGranularity": "century",
                "chronicleEndGranularity": "none",
                "chroniclePrecision": "exact"
            }),
            "granularity",
        ),
        (
            "chronicle bad precision",
            json!({
                "chronicleStartGranularity": "none",
                "chronicleEndGranularity": "none",
                "chroniclePrecision": "roughly"
            }),
            "chroniclePrecision",
        ),
        (
            "archivedAt",
            json!({ "archivedAt": "2026-01-01T00:00:00Z" }),
            "unknown field `archivedAt`",
        ),
        (
            "version",
            json!({ "version": 3 }),
            "unknown field `version`",
        ),
        ("string as number", json!({ "intent": 5 }), "invalid type"),
        (
            "number as string",
            json!({ "storyTimeOrder": 7 }),
            "invalid type",
        ),
        (
            "bad contextMode",
            json!({ "contextMode": "weird" }),
            "restoreState.contextMode",
        ),
        (
            "aliases not json",
            json!({ "aliases": "not json" }),
            "restoreState.aliases",
        ),
        (
            "aliases not strings",
            json!({ "aliases": "[1]" }),
            "restoreState.aliases",
        ),
        (
            "beats not array",
            json!({ "unplacedBeatsDoc": "{}" }),
            "restoreState.unplacedBeatsDoc",
        ),
        (
            "bad createdAt",
            json!({ "createdAt": "yesterday" }),
            "restoreState.createdAt",
        ),
        (
            "createdAt naive T form",
            json!({ "createdAt": "2026-01-01T00:00:00" }),
            "restoreState.createdAt",
        ),
    ];
    for (name, state, needle) in cases {
        let error = create_wire(&db, with_restore_state(base.clone(), state)).expect_err(name);
        assert!(error.to_string().contains(needle), "{name}: {error}");
        assert!(row(&db, "scene-bad").is_none(), "{name} left a row behind");
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM idempotency_requests WHERE request_id = 'undo-bad'"
        ),
        0
    );
}

#[test]
fn restore_state_codex_references_are_nulled_when_gone_and_refused_across_projects() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-ref");
    // undo の間に Codex を消した：NULL に倒して成功する。
    db.with_conn(|conn| {
        conn.execute("DELETE FROM codex_entries WHERE id = 'pov-1'", [])?;
        Ok(())
    })
    .expect("delete codex");
    let response = create_wire(
        &db,
        undo_payload_with_state("scene-ref", "scene", &before, &receipt, "undo-ref"),
    )
    .expect("undo with a vanished reference");
    let after = row(&db, "scene-ref").expect("row");
    assert!(after["povCharacterId"].is_null());
    assert!(response["povCharacterId"].is_null());
    assert_eq!(after["locationId"], json!("place-1"));

    // 別 project の Codex は拒み、行も receipt も残さない（同じ transaction）。
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name) VALUES ('pov-1', 'undo-p1', 'character', 'Pov')",
            [],
        )?;
        Ok(())
    })
    .expect("recreate codex");
    let (before2, receipt2) = seeded_scene(&db, "scene-ref2");
    let mut payload =
        undo_payload_with_state("scene-ref2", "scene", &before2, &receipt2, "undo-ref2");
    payload["restoreState"]["locationId"] = json!("foreign-codex");
    let error = create_wire(&db, payload).expect_err("another project's entry");
    assert!(
        error.to_string().contains("restoreState.locationId"),
        "{error}"
    );
    assert!(row(&db, "scene-ref2").is_none());
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM idempotency_requests WHERE request_id = 'undo-ref2'"
        ),
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE scene_id = 'scene-ref2'"
        ),
        0
    );
}

#[test]
fn restore_state_requests_replay_by_request_id_and_conflict_on_a_different_state() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-idem");
    let payload = undo_payload_with_state("scene-idem", "scene", &before, &receipt, "undo-idem");
    let first = create_wire(&db, payload.clone()).expect("first");
    let second = create_wire(&db, payload.clone()).expect("same payload replays");
    assert_eq!(first, second);
    let mut changed = payload;
    changed["restoreState"]["intent"] = json!("another goal");
    let error = create_wire(&db, changed).expect_err("different restoreState");
    assert!(
        error
            .to_string()
            .contains("TREE_NODE_CREATE_REQUEST_CONFLICT"),
        "{error}"
    );
}

#[test]
fn restore_state_does_not_roll_back_updated_at_or_version() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-tok");
    create_wire(
        &db,
        undo_payload_with_state("scene-tok", "scene", &before, &receipt, "undo-tok"),
    )
    .expect("undo");
    // updated_at は削除前の値（patch の 2026-08-24）に戻らず、作り直した時刻になる。
    let updated_at: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT updated_at FROM tree_nodes WHERE id = 'scene-tok'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("updated_at");
    assert_ne!(updated_at, "2026-08-24T00:00:00.000Z");
    assert!(updated_at.as_str() > "2026-08-24T00:00:00.000Z");
}

fn chronicle_row(db: &Database, id: &str) -> Value {
    let row = row(db, id).expect("row");
    json!([
        row["chronicleStartTime"],
        row["chronicleStartMinute"],
        row["chronicleStartGranularity"],
        row["chronicleEndTime"],
        row["chronicleEndMinute"],
        row["chronicleEndGranularity"],
        row["chroniclePrecision"]
    ])
}

/// `tree_node_patch`（検査なし）や、制約の前から DB にある行も、undo は忠実に戻す
/// （形の検査だけ。厳密な persistence matrix も範囲の整合も求めない）。
#[test]
fn restore_state_puts_back_a_chronicle_range_the_strict_matrix_would_refuse() {
    let db = new_db();
    create(&db, create_payload("scene-legacy", "scene", None)).expect("create");
    // none に day が付いた非 canonical な組と、粗い粒度に付いた minute。
    patch(
        &db,
        "scene-legacy",
        "patch-legacy",
        json!({
            "chronicleStartTime": 50, "chronicleStartMinute": 30,
            "chronicleStartGranularity": "day",
            "chronicleEndTime": 50, "chronicleEndGranularity": "none",
            "chroniclePrecision": "unknown"
        }),
    )
    .expect("patch");
    let before = row(&db, "scene-legacy").expect("row");
    let before_chronicle = chronicle_row(&db, "scene-legacy");
    let receipt = delete(&db, "scene-legacy", "delete-legacy").expect("delete");
    create_wire(
        &db,
        undo_payload_with_state("scene-legacy", "scene", &before, &receipt, "undo-legacy"),
    )
    .expect("a range that existed comes back");
    assert_eq!(chronicle_row(&db, "scene-legacy"), before_chronicle);
}

/// 日付の整合は行の中だけで決まる：削除と undo の間に他の場面が変わっても、
/// 戻す値は変わらず、他の場面の行にも触れない。
#[test]
fn restore_state_chronicle_does_not_depend_on_other_scenes() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-solo");
    create(&db, create_payload("scene-other", "scene", None)).expect("other scene");
    patch(
        &db,
        "scene-other",
        "patch-other",
        json!({
            "chronicleStartTime": 1, "chronicleStartGranularity": "day",
            "chronicleEndGranularity": "none", "chroniclePrecision": "exact"
        }),
    )
    .expect("patch other");
    let other_before = chronicle_row(&db, "scene-other");
    create_wire(
        &db,
        undo_payload_with_state("scene-solo", "scene", &before, &receipt, "undo-solo"),
    )
    .expect("undo");
    assert_eq!(chronicle_row(&db, "scene-solo")[0], json!(100));
    assert_eq!(chronicle_row(&db, "scene-other"), other_before);
}

/// `"restoreState": null` is "absent" to Rust (an `Option`), so it is a plain
/// create. Main and the browser mock refuse it first (a non-object
/// `restoreState`), so production never reaches Rust with it.
#[test]
fn a_null_restore_state_is_a_plain_create_in_rust() {
    let db = new_db();
    let (before, receipt) = seeded_scene(&db, "scene-null");
    let mut payload =
        undo_payload_with_state("scene-null", "scene", &before, &receipt, "undo-null");
    payload["restoreState"] = Value::Null;
    create_wire(&db, payload).expect("null restoreState is absent");
    let after = row(&db, "scene-null").expect("row");
    assert!(after["intent"].is_null(), "nothing was restored");
}

/// 範囲の不整合（end が start より前、`time` で day か minute が無い、範囲外の minute）は
/// 拒まずに書き戻す：`tree_node_patch` は検査なしでこれらを書けるので、そういう行の undo が
/// subtree の途中で止まってはならない（形の検査は残る）。
#[test]
fn restore_state_puts_back_an_inconsistent_legacy_range_faithfully() {
    let cases: [(&str, Value); 4] = [
        (
            "end before start",
            json!({
                "chronicleStartTime": 10, "chronicleStartGranularity": "day",
                "chronicleEndTime": 9, "chronicleEndGranularity": "day",
                "chroniclePrecision": "exact"
            }),
        ),
        (
            "time without a minute",
            json!({
                "chronicleStartTime": 5, "chronicleStartGranularity": "time",
                "chronicleEndGranularity": "none", "chroniclePrecision": "exact"
            }),
        ),
        (
            "time without a day",
            json!({
                "chronicleStartMinute": 30, "chronicleStartGranularity": "time",
                "chronicleEndGranularity": "none", "chroniclePrecision": "approx"
            }),
        ),
        (
            "minute out of range",
            json!({
                "chronicleStartTime": 5, "chronicleStartMinute": 1440,
                "chronicleStartGranularity": "time",
                "chronicleEndGranularity": "none", "chroniclePrecision": "exact"
            }),
        ),
    ];
    for (index, (name, range)) in cases.into_iter().enumerate() {
        let db = new_db();
        let id = format!("scene-incons-{index}");
        create(&db, create_payload(&id, "scene", None)).expect("create");
        patch(&db, &id, &format!("patch-incons-{index}"), range)
            .expect("tree_node_patch writes it unchecked");
        let before = row(&db, &id).expect("row");
        let before_chronicle = chronicle_row(&db, &id);
        let receipt = delete(&db, &id, &format!("delete-incons-{index}")).expect("delete");
        create_wire(
            &db,
            undo_payload_with_state(
                &id,
                "scene",
                &before,
                &receipt,
                &format!("undo-incons-{index}"),
            ),
        )
        .unwrap_or_else(|error| panic!("{name}: the undo must succeed: {error}"));
        assert_eq!(chronicle_row(&db, &id), before_chronicle, "{name}");
        assert_eq!(
            Value::Object(row(&db, &id).unwrap()),
            Value::Object(before),
            "{name}"
        );
    }
}

// ---------------------------------------------------------------------------
// DR-UND-2: 中身のある folder の undo。journal の束縛は「delete の記録
// （`before_json.nodes`）に含まれる id」までで、それ以外は拒む。
//
// この節の拒否の試験は、束縛を緩める前（`entity_id == node_id` だけ）でも後でも
// 同じ結果になる。緩和が広がりすぎたとき（記録の外・別の journal・別 project・壊れた記録・
// Redo／delete／patch）に落ちることを、変異試験で確かめる。
// ---------------------------------------------------------------------------

const BINDING: &str = "tree replay target does not match the named Undo Journal";

type Before = std::collections::BTreeMap<String, serde_json::Map<String, Value>>;

/// 1 つの delete で消える subtree（親が先）。`(id, nodeType, parentId)`。
const TREE_NODES: [(&str, &str, Option<&str>); 5] = [
    ("folder-a", "folder", None),
    ("scene-a1", "scene", Some("folder-a")),
    ("folder-b", "folder", Some("folder-a")),
    ("scene-b1", "scene", Some("folder-b")),
    ("note-b2", "note", Some("folder-b")),
];

struct Tree {
    db: Database,
    receipt: Value,
    before: Before,
}

/// `nodes` の各 node を作り、欄を埋め、root を delete する。
fn seed_tree(db: &Database, nodes: &[(&str, &str, Option<&str>)]) -> (Before, Value) {
    for (id, kind, parent) in nodes {
        create(db, create_payload(id, kind, *parent)).expect("create tree node");
    }
    for (id, kind, _) in nodes {
        let fields = match *kind {
            "scene" => json!({
                "intent": format!("intent-{id}"), "storyTimeOrder": "b3",
                "povCharacterId": "pov-1",
                "content": format!("{{\"type\":\"doc\",\"of\":\"{id}\"}}"),
                "chronicleStartTime": 7, "chronicleStartGranularity": "day",
                "chroniclePrecision": "approx"
            }),
            "note" => json!({
                "contextMode": "hidden", "aliases": "[\"n\"]",
                "content": format!("{{\"type\":\"doc\",\"of\":\"{id}\"}}")
            }),
            _ => json!({ "intent": format!("intent-{id}") }),
        };
        patch(db, id, &format!("patch-{id}"), fields).expect("patch tree node");
    }
    let before = nodes
        .iter()
        .map(|(id, _, _)| (id.to_string(), row(db, id).expect("row before delete")))
        .collect::<Before>();
    let receipt = delete(db, nodes[0].0, &format!("delete-{}", nodes[0].0)).expect("delete root");
    (before, receipt)
}

fn build_tree() -> Tree {
    let db = new_db();
    let (before, receipt) = seed_tree(&db, &TREE_NODES);
    Tree {
        db,
        receipt,
        before,
    }
}

fn kind_of(id: &str) -> &'static str {
    TREE_NODES
        .iter()
        .find(|(candidate, _, _)| *candidate == id)
        .map(|(_, kind, _)| *kind)
        .expect("known node")
}

/// 実際の renderer と同じ形：削除前の行の列を `restoreState` に入れた undo の create。
fn undo_node(tree: &Tree, id: &str, req: &str) -> Value {
    undo_payload_with_state(id, kind_of(id), &tree.before[id], &tree.receipt, req)
}

fn row_counts(db: &Database) -> (i64, i64, i64) {
    (
        count(db, "SELECT COUNT(*) FROM tree_nodes"),
        count(db, "SELECT COUNT(*) FROM narrative_change_transactions"),
        count(db, "SELECT COUNT(*) FROM narrative_change_events"),
    )
}

/// 拒まれ、行も feed も増えないこと。
fn assert_refused(db: &Database, payload: Value, message: &str, label: &str) {
    let before = row_counts(db);
    let error = create_wire(db, payload).expect_err(label);
    assert!(error.to_string().contains(message), "{label}: {error}");
    assert_eq!(row_counts(db), before, "{label}: nothing is written");
}

fn journal_id(receipt: &Value) -> String {
    receipt["undoJournalId"]
        .as_str()
        .expect("journal id")
        .to_string()
}

/// 実際の journal の行を直接書き換えて、壊れた記録・偽の記録を作る（lineage は有効なまま）。
fn forge_record(db: &Database, receipt: &Value, before_json: Option<&str>) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE undo_journal SET before_json = ?1 WHERE id = ?2",
            rusqlite::params![before_json, journal_id(receipt)],
        )?;
        Ok(())
    })
    .expect("forge before_json");
}

fn forge_op_kind(db: &Database, receipt: &Value, op_kind: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE undo_journal SET op_kind = ?1 WHERE id = ?2",
            rusqlite::params![op_kind, journal_id(receipt)],
        )?;
        Ok(())
    })
    .expect("forge op_kind");
}

fn replay_delete(
    db: &Database,
    id: &str,
    origin: &str,
    receipt: &Value,
    req: &str,
) -> anyhow::Result<Value> {
    tree_node_delete(
        db,
        de::<TreeNodeDeletePayload>(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION,
            "eventUid": format!("uid-{req}"), "origin": origin, "nodeId": id,
            "originalTransactionId": receipt["maintenanceTransactionId"],
            "undoJournalId": receipt["undoJournalId"]
        }))?,
    )
}

fn replay_patch(
    db: &Database,
    id: &str,
    origin: &str,
    receipt: &Value,
    req: &str,
) -> anyhow::Result<Value> {
    tree_node_patch(
        db,
        de::<TreeNodePatchPayload>(json!({
            "projectId": P, "requestId": req, "sessionId": SESSION,
            "eventUid": format!("uid-{req}"), "nodeId": id,
            "patch": { "intent": "replayed" }, "baseVersion": null, "bumpVersion": false,
            "updatedAt": "2026-08-25T00:00:00.000Z", "changeEvent": null,
            "origin": origin,
            "originalTransactionId": receipt["maintenanceTransactionId"],
            "undoJournalId": receipt["undoJournalId"]
        }))?,
    )
}

/// 記録にある id と同じ id の生きた node（削除の後に人が作り直したもの）。
fn live_node(db: &Database, id: &str) {
    let mut payload = create_payload(id, "scene", None);
    payload["requestId"] = json!(format!("live-{id}"));
    payload["eventUid"] = json!(format!("uid-live-{id}"));
    create(db, payload).expect("a live node of that id");
}

/// T2a：記録に無い id（未使用の id・別の経路で作って消した id）は、journal が有効でも作れない。
#[test]
fn a_replay_journal_does_not_create_an_id_that_it_did_not_record() {
    let tree = build_tree();
    let mut ghost = undo_node(&tree, "scene-a1", "undo-ghost");
    ghost["id"] = json!("ghost-1");
    ghost["parentId"] = Value::Null;
    assert_refused(&tree.db, ghost, BINDING, "unused id");
    assert!(row(&tree.db, "ghost-1").is_none());

    // 別の場所で作って消した id も、この journal の記録には無い。
    create(&tree.db, create_payload("other-1", "scene", None)).expect("create other");
    delete(&tree.db, "other-1", "delete-other-1").expect("delete other");
    let mut other = undo_node(&tree, "scene-a1", "undo-other");
    other["id"] = json!("other-1");
    other["parentId"] = Value::Null;
    assert_refused(&tree.db, other, BINDING, "id deleted elsewhere");
}

/// T2b：別の delete（J2）の子の id は、J1 の journal では作れない。
#[test]
fn one_deletes_journal_does_not_create_another_deletes_nodes() {
    let tree = build_tree();
    let (before_z, receipt_z) = seed_tree(
        &tree.db,
        &[
            ("folder-z", "folder", None),
            ("scene-z1", "scene", Some("folder-z")),
        ],
    );
    assert_ne!(tree.receipt["undoJournalId"], receipt_z["undoJournalId"]);
    // folder-a は戻っている（J1 の root）。J2 の子 scene-z1 を J1 の名で作る。
    create_wire(&tree.db, undo_node(&tree, "folder-a", "undo-a-root")).expect("root");
    let mut foreign = undo_payload_with_state(
        "scene-z1",
        "scene",
        &before_z["scene-z1"],
        &tree.receipt,
        "undo-z1-under-j1",
    );
    foreign["parentId"] = json!("folder-a");
    assert_refused(&tree.db, foreign, BINDING, "another delete's child");
    // J2 の名なら J2 自身の root から戻る。
    create_wire(
        &tree.db,
        undo_payload_with_state(
            "folder-z",
            "folder",
            &before_z["folder-z"],
            &receipt_z,
            "undo-z-root",
        ),
    )
    .expect("J2 restores its own root");
}

/// T2c：root は戻っていても、同じ journal の root をもう 1 度 create しても行は変わらない
/// （`restoreState` で既存の行を書き換えられない）。
#[test]
fn a_replay_create_cannot_overwrite_a_row_that_already_exists() {
    let tree = build_tree();
    create_wire(&tree.db, undo_node(&tree, "folder-a", "undo-a-root")).expect("root");
    let existing = row(&tree.db, "folder-a").expect("restored root");
    let mut again = undo_node(&tree, "folder-a", "undo-a-root-again");
    again["restoreState"]["intent"] = json!("overwritten");
    again["title"] = json!("overwritten");
    let before = row_counts(&tree.db);
    create_wire(&tree.db, again).expect_err("the id already exists");
    assert_eq!(row_counts(&tree.db), before);
    assert_eq!(row(&tree.db, "folder-a").expect("row"), existing);
}

/// T2d：別 project の payload では、project の journal を名指ししても作れない。
#[test]
fn a_replay_journal_of_another_project_creates_nothing() {
    let tree = build_tree();
    create_wire(&tree.db, undo_node(&tree, "folder-a", "undo-a-root")).expect("root");
    let mut foreign = undo_node(&tree, "scene-a1", "undo-a1-foreign");
    foreign["projectId"] = json!("undo-p2");
    foreign["parentId"] = Value::Null;
    let before = row_counts(&tree.db);
    create_wire(&tree.db, foreign).expect_err("journal belongs to another project");
    assert_eq!(row_counts(&tree.db), before);
    assert!(row(&tree.db, "scene-a1").is_none());
}

/// T2e／T2e'／T2h：壊れた・偽の記録、project の違う記録、id が別の欄に現れるだけの記録は、
/// 子の create を通さない（fail closed。文言は束縛の拒否と同じ）。
#[test]
fn a_damaged_or_forged_delete_record_does_not_bind_a_child() {
    let forged: Vec<(&str, Option<String>)> = vec![
        ("sql null", None),
        ("not json", Some("not json".to_string())),
        ("an array", Some("[]".to_string())),
        ("no nodes", Some(json!({"rootId": "folder-a"}).to_string())),
        ("empty nodes", Some(json!({"rootId": "folder-a", "nodes": []}).to_string())),
        ("nodes is not an array", Some(json!({"rootId": "folder-a", "nodes": {"id": "scene-a1", "projectId": P}}).to_string())),
        ("root id differs", Some(json!({"rootId": "folder-x", "nodes": [{"id": "scene-a1", "projectId": P}]}).to_string())),
        ("no root id", Some(json!({"nodes": [{"id": "scene-a1", "projectId": P}]}).to_string())),
        ("the node has no project", Some(json!({"rootId": "folder-a", "nodes": [{"id": "scene-a1"}]}).to_string())),
        ("the node is of another project", Some(json!({"rootId": "folder-a", "nodes": [{"id": "scene-a1", "projectId": "undo-p2"}]}).to_string())),
        ("the id is not a string", Some(json!({"rootId": "folder-a", "nodes": [{"id": 7, "projectId": P}]}).to_string())),
        (
            // id が別の node の parentId・本文・title にだけ現れる（部分一致で通してはならない）。
            "the id only appears in other fields",
            Some(json!({"rootId": "folder-a", "nodes": [
                {"id": "folder-a", "projectId": P, "content": "scene-a1", "title": "scene-a1"},
                {"id": "x-1", "projectId": P, "parentId": "scene-a1", "content": "{\"id\":\"scene-a1\"}"}
            ]}).to_string()),
        ),
    ];
    for (label, record) in forged {
        let tree = build_tree();
        create_wire(&tree.db, undo_node(&tree, "folder-a", "undo-a-root")).expect("root");
        forge_record(&tree.db, &tree.receipt, record.as_deref());
        assert_refused(
            &tree.db,
            undo_node(&tree, "scene-a1", "undo-a1"),
            BINDING,
            label,
        );
        assert!(row(&tree.db, "scene-a1").is_none(), "{label}");
    }
}

/// T2f：journal が delete のものでなければ（op_kind／entity_kind の違い）、記録に id があっても通さない。
#[test]
fn a_journal_that_is_not_a_delete_does_not_bind_a_child() {
    for op_kind in ["create", "update"] {
        let tree = build_tree();
        create_wire(&tree.db, undo_node(&tree, "folder-a", "undo-a-root")).expect("root");
        forge_op_kind(&tree.db, &tree.receipt, op_kind);
        assert_refused(
            &tree.db,
            undo_node(&tree, "scene-a1", "undo-a1"),
            BINDING,
            op_kind,
        );
    }
    let tree = build_tree();
    create_wire(&tree.db, undo_node(&tree, "folder-a", "undo-a-root")).expect("root");
    tree.db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE undo_journal SET entity_kind = 'codex_entry' WHERE id = ?1",
                [journal_id(&tree.receipt)],
            )?;
            Ok(())
        })
        .expect("forge entity_kind");
    assert_refused(
        &tree.db,
        undo_node(&tree, "scene-a1", "undo-a1"),
        BINDING,
        "entity_kind",
    );
}

/// T2g：緩むのは `("create", Undo)` だけ。Redo の create・delete・patch は、記録にある id でも
/// `entity_id == node_id` を要求する（descendant の id では通らない）。
#[test]
fn only_an_undo_create_may_name_a_recorded_descendant() {
    // ("create", Redo)：journal を create のものに偽る（実際の redo of create の形）。
    let tree = build_tree();
    forge_op_kind(&tree.db, &tree.receipt, "create");
    let mut redo_create = undo_node(&tree, "scene-a1", "redo-a1");
    redo_create["origin"] = json!("redo");
    redo_create["parentId"] = Value::Null;
    redo_create
        .as_object_mut()
        .expect("object")
        .remove("restoreState");
    assert_refused(&tree.db, redo_create, BINDING, "create/redo");
    assert!(row(&tree.db, "scene-a1").is_none());

    // ("delete", Redo)：journal は delete のまま。descendant が生きていても消せない。
    let tree = build_tree();
    live_node(&tree.db, "scene-a1");
    let before = row_counts(&tree.db);
    let error = replay_delete(&tree.db, "scene-a1", "redo", &tree.receipt, "redo-del-a1")
        .expect_err("delete/redo");
    assert!(error.to_string().contains(BINDING), "{error}");
    assert_eq!(row_counts(&tree.db), before);
    assert!(row(&tree.db, "scene-a1").is_some());

    // ("delete", Undo)：journal を create のものに偽る。
    let tree = build_tree();
    forge_op_kind(&tree.db, &tree.receipt, "create");
    live_node(&tree.db, "scene-a1");
    let error = replay_delete(&tree.db, "scene-a1", "undo", &tree.receipt, "undo-del-a1")
        .expect_err("delete/undo");
    assert!(error.to_string().contains(BINDING), "{error}");
    assert!(row(&tree.db, "scene-a1").is_some());

    // ("patch", Undo／Redo)：journal を update のものに偽る。
    for origin in ["undo", "redo"] {
        let tree = build_tree();
        forge_op_kind(&tree.db, &tree.receipt, "update");
        live_node(&tree.db, "scene-a1");
        let error = replay_patch(
            &tree.db,
            "scene-a1",
            origin,
            &tree.receipt,
            &format!("{origin}-patch-a1"),
        )
        .expect_err("patch");
        assert!(error.to_string().contains(BINDING), "{origin}: {error}");
        assert!(row(&tree.db, "scene-a1").expect("row")["intent"].is_null());
    }
}

/// T2i：`restoreState` を付けても、記録に無い id の create は束縛で先に拒まれる。
#[test]
fn restore_state_does_not_open_a_create_that_the_journal_did_not_record() {
    let tree = build_tree();
    let mut ghost = undo_node(&tree, "scene-a1", "undo-ghost-state");
    ghost["id"] = json!("ghost-2");
    ghost["parentId"] = Value::Null;
    ghost["restoreState"]["intent"] = json!("planted");
    assert_refused(&tree.db, ghost, BINDING, "ghost with restoreState");
    assert!(row(&tree.db, "ghost-2").is_none());
}
