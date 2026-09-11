//! Trash bin (文字屑ゴミ箱) の DB 操作。
//!
//! 旧 `src-tauri/src/commands/trash_bin.rs` の実装本体を Electron 移行
//! (napi 垂直スライスへの trash_bin 追加 — workspace 読み込み時に必ず
//! `trash_bin_list` が呼ばれるため、未実装だと Electron 起動のたびに
//! エラートーストが出る) で本クレートへ移動した。Tauri コマンド側と
//! napi `Backend` の両方が薄いラッパーとして呼ぶ (S1 の抽出と同じ構図)。
//!
//! Phase 1 では文字屑のみ書き込まれる。`payload` / `preview_meta` は
//! 素の TEXT で JSON 文字列を保持し、フロント側で `JSON.parse` する。

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::{
    change_events::AppendChangeEvent,
    idempotency::{
        insert_idempotent_response, load_idempotent_response, load_row, payload_fingerprint,
        run_atomic_create, IdempotencyRequest,
    },
    narrative_extraction::change_feed::{
        append_canonical_and_narrative_change_in_tx, narrative_object_key,
        narrative_snapshot_digest, AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind,
        NarrativeChangeEventInput, NarrativeChangeOrigin,
    },
    Database,
};

/// `trash_bin_create` の引数 (FE は camelCase で送る — Tauri の引数
/// deserialize と napi 側 `from_wire` の両方が serde の rename_all で受ける)。
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBinCreatePayload {
    /// Domain-owned idempotency key supplied by the renderer.
    #[serde(default)]
    id: Option<String>,
    project_id: String,
    kind: String,
    sub_kind: String,
    origin_scene_id: Option<String>,
    origin_codex_id: Option<String>,
    preview_text: String,
    preview_meta: Option<String>,
    payload: String,
    char_count: i64,
    is_interesting: bool,
    /// Omitted means "assign once in the native transaction". Keeping omission
    /// in the fingerprint makes a retry stable without requiring renderer to
    /// remember the first wall-clock value.
    deleted_at: Option<String>,
}

/// Restore one structural Trash item as a single Native-owned mutation.
///
/// Text fragments remain editor-local insertions and are deliberately rejected:
/// TipTap state is not part of the SQLite transaction. Every structural restore
/// below creates the domain row(s), appends both ledgers, consumes the Trash row,
/// and records the retry receipt before one commit.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBinRestorePayload {
    pub request_id: String,
    pub session_id: String,
    pub project_id: String,
    pub item_id: String,
    #[serde(default)]
    pub board_id_override: Option<String>,
    #[serde(default)]
    pub drop_x: Option<f64>,
    #[serde(default)]
    pub drop_y: Option<f64>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashBinRestoreResult {
    pub new_id: String,
    pub broken_links: Vec<String>,
}

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    Ok(())
}

fn required_string<'a>(value: &'a Value, name: &str) -> anyhow::Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("Trash restore payload.{name} is required"))
}

fn optional_string(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(Value::as_str).map(str::to_string)
}

fn optional_i64(value: &Value, name: &str) -> Option<i64> {
    value.get(name).and_then(Value::as_i64)
}

fn optional_bool(value: &Value, name: &str, default: bool) -> bool {
    value.get(name).and_then(Value::as_bool).unwrap_or(default)
}

fn project_row_exists(
    conn: &rusqlite::Connection,
    table: &str,
    id_column: &str,
    id: &str,
    project_id: &str,
) -> anyhow::Result<bool> {
    anyhow::ensure!(
        matches!(
            (table, id_column),
            ("tree_nodes", "id") | ("codex_entries", "id") | ("map_boards", "id")
        ),
        "unsupported project-scoped Trash restore reference"
    );
    let sql =
        format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {id_column} = ?1 AND project_id = ?2)");
    Ok(conn.query_row(&sql, params![id, project_id], |row| row.get::<_, i64>(0))? != 0)
}

fn restore_id(sub_kind: &str, item_id: &str) -> String {
    format!("restored-{sub_kind}:{item_id}")
}

fn semantic_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// INSERT して作成行 (`SELECT *` の JSON object — 列名は snake_case のまま)
/// を返す。
pub fn create(db: &Database, payload: TrashBinCreatePayload) -> anyhow::Result<Value> {
    let fingerprint_payload = serde_json::json!({
        "projectId": payload.project_id,
        "kind": payload.kind,
        "subKind": payload.sub_kind,
        "originSceneId": payload.origin_scene_id,
        "originCodexId": payload.origin_codex_id,
        "previewText": payload.preview_text,
        "previewMeta": payload.preview_meta.as_deref().map(semantic_json),
        "payload": semantic_json(&payload.payload),
        "charCount": payload.char_count,
        "isInteresting": payload.is_interesting,
        "deletedAt": payload.deleted_at,
    });
    let payload_hash = payload_fingerprint("trash_bin_create", &fingerprint_payload)?;
    let has_request_id = payload.id.is_some();
    let id = payload
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let project_id = payload.project_id;
    let kind = payload.kind;
    let sub_kind = payload.sub_kind;
    let origin_scene_id = payload.origin_scene_id;
    let origin_codex_id = payload.origin_codex_id;
    let preview_text = payload.preview_text;
    let preview_meta = payload.preview_meta;
    let item_payload = payload.payload;
    let char_count = payload.char_count;
    let is_interesting = payload.is_interesting;
    let deleted_at = payload
        .deleted_at
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "trash_bin_create",
            request_id: has_request_id.then_some(id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "TRASH_BIN_CREATE_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            Database::execute_with_conn(
                conn,
                "INSERT INTO trash_items
                 (id, project_id, kind, sub_kind, origin_scene_id, origin_codex_id,
                  preview_text, preview_meta, payload, char_count, is_interesting, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    Value::String(id.clone()),
                    Value::String(project_id.clone()),
                    Value::String(kind.clone()),
                    Value::String(sub_kind.clone()),
                    origin_scene_id
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    origin_codex_id
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    Value::String(preview_text.clone()),
                    preview_meta
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    Value::String(item_payload.clone()),
                    Value::Number(char_count.into()),
                    Value::Bool(is_interesting),
                    Value::String(deleted_at.clone()),
                ],
                "run",
            )
            .or_else(|error| {
                let existing = Database::execute_with_conn(
                    conn,
                    "SELECT * FROM trash_items WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?;
                let Some(row) = existing.first() else {
                    return Err(error);
                };
                let stored_interesting = row.get("is_interesting").and_then(|value| {
                    value
                        .as_bool()
                        .or_else(|| value.as_i64().map(|number| number != 0))
                });
                let stored_preview_meta = row
                    .get("preview_meta")
                    .and_then(Value::as_str)
                    .map(semantic_json);
                let stored_payload = row
                    .get("payload")
                    .and_then(Value::as_str)
                    .map(semantic_json);
                let matches = row.get("project_id").and_then(Value::as_str)
                    == Some(project_id.as_str())
                    && row.get("kind").and_then(Value::as_str) == Some(kind.as_str())
                    && row.get("sub_kind").and_then(Value::as_str)
                        == Some(sub_kind.as_str())
                    && row.get("origin_scene_id")
                        == Some(
                            &origin_scene_id
                                .clone()
                                .map(Value::String)
                                .unwrap_or(Value::Null),
                        )
                    && row.get("origin_codex_id")
                        == Some(
                            &origin_codex_id
                                .clone()
                                .map(Value::String)
                                .unwrap_or(Value::Null),
                        )
                    && row.get("preview_text").and_then(Value::as_str)
                        == Some(preview_text.as_str())
                    && stored_preview_meta
                        == preview_meta.as_deref().map(semantic_json)
                    && stored_payload == Some(semantic_json(&item_payload))
                    && row.get("char_count").and_then(Value::as_i64) == Some(char_count)
                    && stored_interesting == Some(is_interesting)
                    && row.get("deleted_at").and_then(Value::as_str)
                        == Some(deleted_at.as_str());
                if matches {
                    Ok(Vec::new())
                } else {
                    Err(anyhow::anyhow!(
                        "TRASH_BIN_CREATE_IDEMPOTENCY_CONFLICT: request id reused with different payload"
                    ))
                }
            })?;
            let rows = Database::execute_with_conn(
                conn,
                "SELECT * FROM trash_items WHERE id = ?",
                &[Value::String(id.clone())],
                "get",
            )?;
            let row = rows
                .first()
                .cloned()
                .map(Value::Object)
                .ok_or_else(|| anyhow::anyhow!("trash create completed without a persisted row"))?;
            Ok((project_id.clone(), row))
        },
        |conn| load_row(conn, "trash_items", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

struct RestoredStructure {
    new_id: String,
    broken_links: Vec<String>,
    entity_kind: &'static str,
    change_kind: &'static str,
    snapshot: Value,
    scene_id: Option<String>,
}

fn restore_scene_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    item_id: &str,
    payload: &Value,
) -> anyhow::Result<RestoredStructure> {
    let new_id = restore_id("scene", item_id);
    let metadata = payload.get("metadata").and_then(Value::as_object);
    let mut broken_links = Vec::new();
    let parent_id = match optional_string(payload, "folderHintId") {
        Some(parent_id)
            if project_row_exists(conn, "tree_nodes", "id", &parent_id, project_id)? =>
        {
            Some(parent_id)
        }
        Some(_) => {
            broken_links.push("folder".to_string());
            None
        }
        None => None,
    };
    let pov_character_id = match optional_string(payload, "povCharacterId") {
        Some(entry_id)
            if project_row_exists(conn, "codex_entries", "id", &entry_id, project_id)? =>
        {
            Some(entry_id)
        }
        Some(_) => {
            broken_links.push("povCharacter".to_string());
            None
        }
        None => None,
    };
    let location_id = match metadata
        .and_then(|metadata| metadata.get("locationId"))
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        Some(entry_id)
            if project_row_exists(conn, "codex_entries", "id", &entry_id, project_id)? =>
        {
            Some(entry_id)
        }
        Some(_) => {
            broken_links.push("location".to_string());
            None
        }
        None => None,
    };
    let title = required_string(payload, "title")?;
    let content = required_string(payload, "body")?;
    let beats = payload.get("beats").and_then(Value::as_str).unwrap_or("[]");
    let synopsis = metadata
        .and_then(|metadata| metadata.get("synopsis"))
        .and_then(Value::as_str);
    let status = metadata
        .and_then(|metadata| metadata.get("status"))
        .and_then(Value::as_str);
    let sort_order = metadata
        .and_then(|metadata| metadata.get("sortOrder"))
        .and_then(Value::as_str)
        .unwrap_or("a0");
    let story_time_order = metadata
        .and_then(|metadata| metadata.get("storyTimeOrder"))
        .and_then(Value::as_str);
    let story_time_label = metadata
        .and_then(|metadata| metadata.get("storyTimeLabel"))
        .and_then(Value::as_str);
    let char_count = payload
        .get("charCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO tree_nodes (
             id, project_id, parent_id, node_type, title, synopsis, sort_order,
             story_time_order, story_time_label, pov_character_id, location_id,
             status, content, unplaced_beats_doc, char_count, version
         ) VALUES (?1, ?2, ?3, 'scene', ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                   ?11, ?12, ?13, ?14, 0)",
        params![
            new_id,
            project_id,
            parent_id,
            title,
            synopsis,
            sort_order,
            story_time_order,
            story_time_label,
            pov_character_id,
            location_id,
            status,
            content,
            beats,
            char_count,
        ],
    )?;
    let snapshot = Database::execute_with_conn(
        conn,
        "SELECT * FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(new_id.clone()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("restored Scene was not persisted"))?;
    Ok(RestoredStructure {
        new_id: new_id.clone(),
        broken_links,
        entity_kind: "scene",
        change_kind: "content",
        snapshot,
        scene_id: Some(new_id),
    })
}

fn restore_grid_chapter_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    item_id: &str,
    payload: &Value,
) -> anyhow::Result<RestoredStructure> {
    let new_id = restore_id("grid-chapter", item_id);
    let mut broken_links = Vec::new();
    let parent_id = match optional_string(payload, "parentId") {
        Some(parent_id)
            if project_row_exists(conn, "tree_nodes", "id", &parent_id, project_id)? =>
        {
            Some(parent_id)
        }
        Some(_) => {
            broken_links.push("parent".to_string());
            None
        }
        None => None,
    };
    conn.execute(
        "INSERT INTO tree_nodes
             (id, project_id, parent_id, node_type, title, sort_order, version)
         VALUES (?1, ?2, ?3, 'folder', ?4, ?5, 0)",
        params![
            new_id,
            project_id,
            parent_id,
            required_string(payload, "title")?,
            payload
                .get("sortOrder")
                .and_then(Value::as_str)
                .unwrap_or("a0"),
        ],
    )?;
    let snapshot = Database::execute_with_conn(
        conn,
        "SELECT * FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(new_id.clone()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("restored Grid chapter was not persisted"))?;
    Ok(RestoredStructure {
        new_id,
        broken_links,
        entity_kind: "tree_node",
        change_kind: "metadata",
        snapshot,
        scene_id: None,
    })
}

fn restore_codex_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    item_id: &str,
    payload: &Value,
) -> anyhow::Result<RestoredStructure> {
    let new_id = restore_id("codex-entry", item_id);
    let mut broken_links = Vec::new();
    let parent_id = match optional_string(payload, "parentId") {
        Some(parent_id)
            if project_row_exists(conn, "codex_entries", "id", &parent_id, project_id)? =>
        {
            Some(parent_id)
        }
        Some(_) => {
            broken_links.push("parent".to_string());
            None
        }
        None => None,
    };
    let requested_type = required_string(payload, "category")?;
    let type_exists = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM codex_types WHERE project_id = ?1 AND slug = ?2
         )",
        params![project_id, requested_type],
        |row| row.get::<_, i64>(0),
    )? != 0;
    let entry_type = if type_exists {
        requested_type
    } else {
        broken_links.push("category".to_string());
        "lore"
    };
    conn.execute(
        "INSERT INTO codex_entries (
             id, project_id, parent_id, type, name, aliases, excluded_aliases,
             summary, content, icon, context_mode, children_budget, notes, version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)",
        params![
            new_id,
            project_id,
            parent_id,
            entry_type,
            required_string(payload, "name")?,
            optional_string(payload, "aliases"),
            optional_string(payload, "excludedAliases"),
            optional_string(payload, "summary"),
            payload.get("body").and_then(Value::as_str).unwrap_or("{}"),
            optional_string(payload, "icon"),
            payload
                .get("contextMode")
                .and_then(Value::as_str)
                .unwrap_or("mentioned"),
            payload
                .get("childrenBudget")
                .and_then(Value::as_str)
                .unwrap_or("compact"),
            optional_string(payload, "notes"),
        ],
    )?;
    let snapshot = Database::execute_with_conn(
        conn,
        "SELECT * FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(new_id.clone()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("restored Codex entry was not persisted"))?;
    Ok(RestoredStructure {
        new_id,
        broken_links,
        entity_kind: "codex_entry",
        change_kind: "metadata",
        snapshot,
        scene_id: None,
    })
}

fn restore_snippet_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    item_id: &str,
    payload: &Value,
) -> anyhow::Result<RestoredStructure> {
    let new_id = restore_id("snippet", item_id);
    let mut broken_links = Vec::new();
    let scene_id = match optional_string(payload, "sceneId") {
        Some(scene_id) if project_row_exists(conn, "tree_nodes", "id", &scene_id, project_id)? => {
            Some(scene_id)
        }
        Some(_) => {
            broken_links.push("scene".to_string());
            None
        }
        None => None,
    };
    conn.execute(
        "INSERT INTO snippets (
             id, project_id, title, content, tags_cache, content_source,
             scene_id, version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![
            new_id,
            project_id,
            required_string(payload, "title")?,
            payload.get("body").and_then(Value::as_str).unwrap_or("{}"),
            optional_string(payload, "tags"),
            optional_string(payload, "contentSource"),
            scene_id,
        ],
    )?;
    let snapshot = Database::execute_with_conn(
        conn,
        "SELECT * FROM snippets WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(new_id.clone()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("restored Snippet was not persisted"))?;
    Ok(RestoredStructure {
        new_id,
        broken_links,
        entity_kind: "snippet",
        change_kind: "content",
        snapshot,
        scene_id: None,
    })
}

fn restore_map_sticky_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    item_id: &str,
    payload: &Value,
    options: &TrashBinRestorePayload,
) -> anyhow::Result<RestoredStructure> {
    let new_id = restore_id("map-sticky", item_id);
    let original_board_id = required_string(payload, "boardId")?;
    let board_id = options
        .board_id_override
        .as_deref()
        .unwrap_or(original_board_id);
    anyhow::ensure!(
        project_row_exists(conn, "map_boards", "id", board_id, project_id)?,
        "Trash restore boardId is not owned by projectId"
    );
    let mut broken_links = Vec::new();
    if board_id != original_board_id {
        broken_links.push("board".to_string());
    }
    let x = options
        .drop_x
        .or_else(|| payload.get("x").and_then(Value::as_f64))
        .ok_or_else(|| anyhow::anyhow!("Trash restore payload.x is required"))?;
    let y = options
        .drop_y
        .or_else(|| payload.get("y").and_then(Value::as_f64))
        .ok_or_else(|| anyhow::anyhow!("Trash restore payload.y is required"))?;
    conn.execute(
        "INSERT INTO map_stickies
             (id, board_id, title, body, preview_text, palette_id, color_slot)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new_id,
            board_id,
            optional_string(payload, "title"),
            payload.get("body").and_then(Value::as_str).unwrap_or("{}"),
            optional_string(payload, "previewText"),
            payload
                .get("paletteId")
                .and_then(Value::as_str)
                .unwrap_or("post-it-playful"),
            optional_i64(payload, "colorSlot").unwrap_or(0),
        ],
    )?;
    conn.execute(
        "INSERT INTO map_node_positions (
             id, board_id, node_ref_type, sticky_id, x, y, pinned, z_index
         ) VALUES (?1, ?2, 'sticky', ?3, ?4, ?5, ?6, ?7)",
        params![
            format!("position:{new_id}"),
            board_id,
            new_id,
            x,
            y,
            optional_bool(payload, "pinned", false),
            optional_i64(payload, "zIndex").unwrap_or(0),
        ],
    )?;
    let snapshot = Database::execute_with_conn(
        conn,
        "SELECT s.*, p.x, p.y, p.pinned, p.z_index
           FROM map_stickies s
           JOIN map_node_positions p ON p.sticky_id = s.id
           JOIN map_boards b ON b.id = s.board_id
          WHERE s.id = ?1 AND b.project_id = ?2",
        &[
            Value::String(new_id.clone()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("restored Map Sticky was not persisted"))?;
    Ok(RestoredStructure {
        new_id,
        broken_links,
        entity_kind: "map_sticky",
        change_kind: "content",
        snapshot,
        scene_id: None,
    })
}

fn restore_foreshadow_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    item_id: &str,
    payload: &Value,
) -> anyhow::Result<RestoredStructure> {
    if let Some(snapshot_project_id) = payload.get("projectId").and_then(Value::as_str) {
        anyhow::ensure!(
            snapshot_project_id == project_id,
            "Trash restore payload projectId does not match authority projectId"
        );
    }
    let new_id = restore_id("foreshadow", item_id);
    let mut broken_links = vec!["setups".to_string()];
    let payoff_scene_id = match optional_string(payload, "payoffSceneRef") {
        Some(scene_id) if project_row_exists(conn, "tree_nodes", "id", &scene_id, project_id)? => {
            Some(scene_id)
        }
        Some(_) => {
            broken_links.insert(0, "payoffScene".to_string());
            None
        }
        None => None,
    };
    let now = Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO foreshadows (
             id, project_id, title, intent, notes, payoff_scene_id,
             payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned,
             secret, load_bearing, version, codex_link_dirty_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                   ?11, ?12, 0, ?13, ?14, ?14)",
        params![
            new_id,
            project_id,
            required_string(payload, "title")?,
            optional_string(payload, "intent"),
            optional_string(payload, "notes"),
            payoff_scene_id,
            optional_i64(payload, "payoffFromPos"),
            optional_i64(payload, "payoffToPos"),
            optional_bool(payload, "payoffConfirmed", false),
            optional_bool(payload, "abandoned", false),
            optional_bool(payload, "secret", true),
            optional_string(payload, "loadBearing"),
            optional_i64(payload, "codexLinkDirtyAt"),
            now,
        ],
    )?;
    let snapshot = Database::execute_with_conn(
        conn,
        "SELECT * FROM foreshadows WHERE id = ?1 AND project_id = ?2",
        &[
            Value::String(new_id.clone()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("restored Foreshadow was not persisted"))?;
    Ok(RestoredStructure {
        new_id,
        broken_links,
        entity_kind: "foreshadow",
        change_kind: "metadata",
        snapshot,
        scene_id: None,
    })
}

/// Restore a structural Trash item and consume it in the same transaction as
/// the canonical audit event and Narrative Change Feed append.
pub fn restore(
    db: &Database,
    payload: TrashBinRestorePayload,
) -> anyhow::Result<TrashBinRestoreResult> {
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.item_id, "itemId")?;
    anyhow::ensure!(
        payload.drop_x.map(f64::is_finite).unwrap_or(true)
            && payload.drop_y.map(f64::is_finite).unwrap_or(true),
        "Trash restore coordinates must be finite"
    );
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.request_id.clear();
    fingerprint_payload.session_id.clear();
    let request_hash = payload_fingerprint("trash_bin_restore", &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "trash_bin_restore",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "TRASH_BIN_RESTORE_IDEMPOTENCY_CONFLICT",
    };

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            let result = serde_json::from_value(response)?;
            tx.commit()?;
            return Ok(result);
        }
        let trash_row = tx
            .query_row(
                "SELECT kind, sub_kind, payload
                   FROM trash_items
                  WHERE id = ?1 AND project_id = ?2",
                params![payload.item_id, payload.project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("Trash item is not owned by projectId"))?;
        anyhow::ensure!(
            trash_row.0 == "structure-item",
            "text-fragment restore is editor-local and cannot use trash_bin_restore"
        );
        let item_payload: Value = serde_json::from_str(&trash_row.2)?;
        let restored = match trash_row.1.as_str() {
            "scene" => {
                restore_scene_in_tx(&tx, &payload.project_id, &payload.item_id, &item_payload)?
            }
            "grid-chapter" => restore_grid_chapter_in_tx(
                &tx,
                &payload.project_id,
                &payload.item_id,
                &item_payload,
            )?,
            "codex-entry" => {
                restore_codex_in_tx(&tx, &payload.project_id, &payload.item_id, &item_payload)?
            }
            "snippet" => {
                restore_snippet_in_tx(&tx, &payload.project_id, &payload.item_id, &item_payload)?
            }
            "map-sticky" => restore_map_sticky_in_tx(
                &tx,
                &payload.project_id,
                &payload.item_id,
                &item_payload,
                &payload,
            )?,
            "foreshadow" => {
                restore_foreshadow_in_tx(&tx, &payload.project_id, &payload.item_id, &item_payload)?
            }
            other => anyhow::bail!("unsupported structural Trash subKind '{other}'"),
        };
        let occurred_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let timestamp = Utc::now().timestamp_millis();
        let change_event_uid = uuid::Uuid::new_v4().to_string();
        let canonical_payload = json!({
            "requestId": payload.request_id,
            "itemId": payload.item_id,
            "subKind": trash_row.1,
            "newId": restored.new_id,
            "brokenLinks": restored.broken_links,
        });
        append_canonical_and_narrative_change_in_tx(
            &tx,
            &payload.project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: change_event_uid.clone(),
                scene_id: restored.scene_id.clone(),
                domain: "trash".to_string(),
                op_type: "trash.restore".to_string(),
                entity_type: Some(restored.entity_kind.to_string()),
                entity_id: Some(restored.new_id.clone()),
                payload: canonical_payload.to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: payload.project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: "trash.restore".to_string(),
                source_change_event_uid: change_event_uid,
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: Vec::new(),
                occurred_at,
                events: vec![NarrativeChangeEventInput {
                    object_key: narrative_object_key(restored.entity_kind, &restored.new_id),
                    change_kind: restored.change_kind.to_string(),
                    mutation_kind: "restore".to_string(),
                    before_version: None,
                    before_digest: None,
                    after_version: restored.snapshot.get("version").and_then(Value::as_i64),
                    after_digest: Some(narrative_snapshot_digest(&restored.snapshot)?),
                    changed_paths: vec!["/".to_string()],
                    text_impact: None,
                    structural_impact: Some(json!({ "changedPaths": ["/"] })),
                }],
            },
        )?;
        let deleted = tx.execute(
            "DELETE FROM trash_items WHERE id = ?1 AND project_id = ?2",
            params![payload.item_id, payload.project_id],
        )?;
        anyhow::ensure!(deleted == 1, "Trash item disappeared during restore");
        let result = TrashBinRestoreResult {
            new_id: restored.new_id,
            broken_links: restored.broken_links,
        };
        insert_idempotent_response(
            &tx,
            &idempotency_request,
            &payload.project_id,
            &serde_json::to_value(&result)?,
        )?;
        tx.commit()?;
        Ok(result)
    })
}

/// project の trash item を deleted_at 降順で返す (既定 50 件)。
pub fn list(db: &Database, project_id: String, limit: Option<i64>) -> anyhow::Result<Vec<Value>> {
    let limit = limit.unwrap_or(50);
    let rows = db.execute(
        "SELECT * FROM trash_items
         WHERE project_id = ?
         ORDER BY deleted_at DESC
         LIMIT ?",
        &[Value::String(project_id), Value::Number(limit.into())],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

pub fn delete(db: &Database, id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM trash_items WHERE id = ?",
        &[Value::String(id)],
        "run",
    )?;
    Ok(())
}

pub fn clear_all(db: &Database, project_id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM trash_items WHERE project_id = ?",
        &[Value::String(project_id)],
        "run",
    )?;
    Ok(())
}

/// 期日切れ・件数超過のアイテムを刈り取り、残件数を返す。
/// Phase 1 では起動時に呼ぶだけ (バックグラウンド実行は Phase 7)。
pub fn prune(
    db: &Database,
    project_id: String,
    retention_days: i64,
    max_count: i64,
) -> anyhow::Result<i64> {
    // 1. 期日切れ削除（deleted_at < now - retention_days）
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days);
    let cutoff_str = cutoff.to_rfc3339();
    db.execute(
        "DELETE FROM trash_items
         WHERE project_id = ? AND deleted_at < ?",
        &[Value::String(project_id.clone()), Value::String(cutoff_str)],
        "run",
    )?;

    // 2. 件数超過削除（古い順に max_count 件まで残す）
    db.execute(
        "DELETE FROM trash_items
         WHERE id IN (
             SELECT id FROM trash_items
             WHERE project_id = ?
             ORDER BY deleted_at DESC
             LIMIT -1 OFFSET ?
         )",
        &[
            Value::String(project_id.clone()),
            Value::Number(max_count.into()),
        ],
        "run",
    )?;

    // 残件数を返す
    let rows = db.execute(
        "SELECT COUNT(*) AS n FROM trash_items WHERE project_id = ?",
        &[Value::String(project_id)],
        "get",
    )?;
    let count = rows
        .first()
        .and_then(|m| m.get("n"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        crate::test_support::current_schema_memory().expect("current-schema fixture")
    }

    /// trash_items.project_id は projects(id) への FK (foreign_keys=ON) なので
    /// migrate が seed する 'default-project' を使う。
    const PROJECT: &str = "default-project";

    fn payload(preview: &str, deleted_at: &str) -> TrashBinCreatePayload {
        TrashBinCreatePayload {
            id: None,
            project_id: PROJECT.to_string(),
            kind: "text-fragment".to_string(),
            sub_kind: "text-fragment".to_string(),
            origin_scene_id: None,
            origin_codex_id: None,
            preview_text: preview.to_string(),
            preview_meta: None,
            payload: "{\"text\":\"…\"}".to_string(),
            char_count: preview.chars().count() as i64,
            is_interesting: false,
            deleted_at: Some(deleted_at.to_string()),
        }
    }

    fn structure_payload(id: &str, sub_kind: &str, value: Value) -> TrashBinCreatePayload {
        TrashBinCreatePayload {
            id: Some(id.to_string()),
            project_id: PROJECT.to_string(),
            kind: "structure-item".to_string(),
            sub_kind: sub_kind.to_string(),
            origin_scene_id: None,
            origin_codex_id: None,
            preview_text: "restore candidate".to_string(),
            preview_meta: None,
            payload: value.to_string(),
            char_count: 17,
            is_interesting: true,
            deleted_at: Some("2026-08-13T00:00:00Z".to_string()),
        }
    }

    fn scene_structure_payload(id: &str) -> TrashBinCreatePayload {
        structure_payload(
            id,
            "scene",
            json!({
                "originalId": "old-scene",
                "title": "Restored Scene",
                "body": "{\"type\":\"doc\",\"content\":[]}",
                "beats": "[]",
                "povCharacterId": null,
                "folderHintId": null,
                "folderHintName": null,
                "metadata": {
                    "synopsis": "restored synopsis",
                    "status": "draft",
                    "nodeType": "scene",
                    "locationId": null,
                    "sortOrder": "b0",
                    "storyTimeOrder": null,
                    "storyTimeLabel": null
                },
                "charCount": 0
            }),
        )
    }

    fn restore_request(item_id: &str) -> TrashBinRestorePayload {
        TrashBinRestorePayload {
            request_id: format!("restore-request:{item_id}"),
            session_id: "session-1".to_string(),
            project_id: PROJECT.to_string(),
            item_id: item_id.to_string(),
            board_id_override: None,
            drop_x: None,
            drop_y: None,
        }
    }

    #[test]
    fn create_list_delete_roundtrip() {
        let db = test_db();
        let created = create(
            &db,
            payload("消した文字屑（日本語）", "2026-07-10T00:00:00Z"),
        )
        .expect("create");
        assert_eq!(
            created["preview_text"].as_str(),
            Some("消した文字屑（日本語）"),
            "SELECT * の行が snake_case 列名のまま返る"
        );
        let id = created["id"].as_str().expect("id").to_string();

        let listed = list(&db, PROJECT.to_string(), None).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"].as_str(), Some(id.as_str()));

        delete(&db, id).expect("delete");
        assert!(list(&db, PROJECT.to_string(), None)
            .expect("list after delete")
            .is_empty());
    }

    #[test]
    fn structural_restore_is_atomic_ordered_and_retry_safe() {
        let db = test_db();
        create(&db, scene_structure_payload("trash-scene-1")).expect("create Trash row");

        let first = restore(&db, restore_request("trash-scene-1")).expect("restore Scene");
        assert_eq!(first.new_id, "restored-scene:trash-scene-1");
        assert!(first.broken_links.is_empty());
        let mut replay_request = restore_request("trash-scene-1");
        replay_request.session_id = "session-after-restart".to_string();
        let replay = restore(&db, replay_request).expect("retry restore");
        assert_eq!(replay, first);

        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                    params![first.new_id, PROJECT],
                    |row| row.get::<_, i64>(0),
                )?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM trash_items WHERE id = 'trash-scene-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM change_events
                      WHERE project_id = ?1 AND op_type = 'trash.restore'",
                    [PROJECT],
                    |row| row.get::<_, i64>(0),
                )?,
                1
            );
            let feed = conn.query_row(
                "SELECT t.origin, t.request_id, e.event_ordinal, e.mutation_kind,
                        e.object_key_json
                   FROM narrative_change_transactions t
                   JOIN narrative_change_events e ON e.transaction_id = t.id
                  WHERE t.project_id = ?1 AND t.source_domain = 'trash.restore'",
                [PROJECT],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )?;
            assert_eq!(feed.0, "restore");
            assert_eq!(feed.1, "restore-request:trash-scene-1");
            assert_eq!(feed.2, 0);
            assert_eq!(feed.3, "restore");
            assert_eq!(
                serde_json::from_str::<Value>(&feed.4)?,
                json!({
                    "kind": "scene",
                    "sceneId": "restored-scene:trash-scene-1"
                })
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM idempotency_requests
                      WHERE domain = 'trash_bin_restore'
                        AND request_id = 'restore-request:trash-scene-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                1
            );
            Ok(())
        })
        .expect("inspect restore");
    }

    #[test]
    fn structural_restore_rejects_cross_project_authority() {
        let db = test_db();
        create(&db, scene_structure_payload("trash-cross-project")).expect("create Trash row");
        db.with_conn(|conn| {
            conn.execute("INSERT INTO projects (id, title) VALUES ('p2', 'Two')", [])?;
            Ok(())
        })
        .expect("create second project");
        let mut request = restore_request("trash-cross-project");
        request.project_id = "p2".to_string();
        let error = restore(&db, request).expect_err("reject cross-project restore");
        assert!(error.to_string().contains("not owned by projectId"));
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM trash_items WHERE id = 'trash-cross-project'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id = 'restored-scene:trash-cross-project'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                0
            );
            Ok(())
        })
        .expect("inspect rejected restore");
    }

    #[test]
    fn feed_append_failure_rolls_back_restore_and_trash_consumption() {
        let db = test_db();
        create(&db, scene_structure_payload("trash-feed-failure")).expect("create Trash row");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_trash_feed
                   BEFORE INSERT ON narrative_change_transactions
                   WHEN NEW.source_domain = 'trash.restore'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced trash feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");

        let error =
            restore(&db, restore_request("trash-feed-failure")).expect_err("Feed append must fail");
        assert!(error.to_string().contains("forced trash feed failure"));
        db.with_conn(|conn| {
            for (sql, expected) in [
                (
                    "SELECT COUNT(*) FROM trash_items WHERE id = 'trash-feed-failure'",
                    1,
                ),
                (
                    "SELECT COUNT(*) FROM tree_nodes WHERE id = 'restored-scene:trash-feed-failure'",
                    0,
                ),
                (
                    "SELECT COUNT(*) FROM change_events WHERE op_type = 'trash.restore'",
                    0,
                ),
                (
                    "SELECT COUNT(*) FROM narrative_change_transactions WHERE source_domain = 'trash.restore'",
                    0,
                ),
                (
                    "SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'trash_bin_restore'",
                    0,
                ),
            ] {
                assert_eq!(
                    conn.query_row(sql, [], |row| row.get::<_, i64>(0))?,
                    expected,
                    "{sql}"
                );
            }
            Ok(())
        })
        .expect("inspect rollback");
    }

    #[test]
    fn create_is_idempotent_by_client_id_and_conflicts_on_payload_change() {
        let db = test_db();
        let mut request = payload("SECRET_TRASH_MANUSCRIPT_SENTINEL", "2026-07-10T00:00:00Z");
        request.id = Some("trash-request-1".to_string());
        let first = create(&db, request.clone()).expect("first create");
        let ledger = db
            .execute(
                "SELECT tombstone_json FROM idempotency_requests
                  WHERE domain = 'trash_bin_create'
                    AND request_id = 'trash-request-1'",
                &[],
                "get",
            )
            .expect("read ledger");
        assert!(!ledger[0]["tombstone_json"]
            .as_str()
            .expect("tombstone")
            .contains("SECRET_TRASH_MANUSCRIPT_SENTINEL"));
        let retry = create(&db, request.clone()).expect("exact retry");
        assert_eq!(retry["id"], first["id"]);
        assert_eq!(first["__idempotency"]["replayed"], Value::Bool(false));
        assert_eq!(retry["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(retry["__idempotency"]["entityPresent"], Value::Bool(true));

        prune(&db, PROJECT.to_string(), 1, 0).expect("prune created entity");
        let deleted_retry = create(&db, request.clone()).expect("retry after prune");
        assert_eq!(deleted_retry["id"], first["id"]);
        assert_eq!(
            deleted_retry["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );

        let mut conflicting = request;
        conflicting.preview_text = "別の文字屑".to_string();
        let error = create(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("TRASH_BIN_CREATE_IDEMPOTENCY_CONFLICT"));
        assert!(list(&db, PROJECT.to_string(), None)
            .expect("list")
            .is_empty());
    }

    #[test]
    fn omitted_deleted_at_is_assigned_once_and_survives_reopen() {
        let path = std::env::temp_dir().join(format!(
            "grimodex-trash-idempotency-{}.db",
            uuid::Uuid::new_v4()
        ));
        let mut request = payload("再送", "unused");
        request.id = Some("trash-reopen-request".to_string());
        request.deleted_at = None;

        let first = {
            let db = Database::new(&path).expect("open database");
            db.migrate().expect("migrate");
            create(&db, request.clone()).expect("first create")
        };
        let retry = {
            let db = Database::new(&path).expect("reopen database");
            db.migrate().expect("migrate after reopen");
            create(&db, request).expect("retry after reopen")
        };
        assert_eq!(retry["deleted_at"], first["deleted_at"]);
        assert_eq!(retry["__idempotency"]["replayed"], Value::Bool(true));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn json_string_key_order_is_semantic_but_explicit_deleted_at_is_not() {
        let db = test_db();
        let mut first = payload("json", "2026-07-10T00:00:00Z");
        first.id = Some("trash-json-request".to_string());
        first.preview_meta = Some(r#"{"b":2,"a":{"y":2,"x":1}}"#.to_string());
        first.payload = r#"{"text":"same","meta":{"b":2,"a":1}}"#.to_string();
        create(&db, first.clone()).expect("first create");

        let mut reordered = first.clone();
        reordered.preview_meta = Some(r#"{"a":{"x":1,"y":2},"b":2}"#.to_string());
        reordered.payload = r#"{"meta":{"a":1,"b":2},"text":"same"}"#.to_string();
        let replay = create(&db, reordered).expect("semantic JSON retry");
        assert_eq!(replay["__idempotency"]["replayed"], Value::Bool(true));

        let mut changed_time = first;
        changed_time.deleted_at = Some("2026-07-11T00:00:00Z".to_string());
        let error = create(&db, changed_time).expect_err("timestamp conflict");
        assert!(error
            .to_string()
            .contains("TRASH_BIN_CREATE_IDEMPOTENCY_CONFLICT"));
    }

    #[test]
    fn list_respects_limit_and_order() {
        let db = test_db();
        create(&db, payload("古い", "2026-07-01T00:00:00Z")).expect("create old");
        create(&db, payload("新しい", "2026-07-09T00:00:00Z")).expect("create new");
        let limited = list(&db, PROJECT.to_string(), Some(1)).expect("list limit 1");
        assert_eq!(limited.len(), 1);
        assert_eq!(
            limited[0]["preview_text"].as_str(),
            Some("新しい"),
            "deleted_at 降順の先頭"
        );
    }

    #[test]
    fn clear_all_deletes_only_target_project() {
        let db = test_db();
        create(&db, payload("a", "2026-07-01T00:00:00Z")).expect("create");
        create(&db, payload("b", "2026-07-02T00:00:00Z")).expect("create");
        clear_all(&db, PROJECT.to_string()).expect("clear_all");
        assert!(list(&db, PROJECT.to_string(), None)
            .expect("list after clear")
            .is_empty());
    }

    #[test]
    fn prune_drops_expired_and_over_count_items() {
        let db = test_db();
        let now = chrono::Utc::now();
        let expired = (now - chrono::Duration::days(365)).to_rfc3339();
        let i1 = (now - chrono::Duration::days(3)).to_rfc3339();
        let i2 = (now - chrono::Duration::days(2)).to_rfc3339();
        let i3 = (now - chrono::Duration::days(1)).to_rfc3339();
        // 期日切れ (retention 60 日をはるかに超える古さ)
        create(&db, payload("期日切れ", &expired)).expect("create expired");
        // 新しいもの 3 件
        create(&db, payload("i1", &i1)).expect("create");
        create(&db, payload("i2", &i2)).expect("create");
        create(&db, payload("i3", &i3)).expect("create");

        // retention で 1 件、max_count=2 で古い方からもう 1 件消え、残 2 件。
        let remaining = prune(&db, PROJECT.to_string(), 60, 2).expect("prune");
        assert_eq!(remaining, 2);
        let rows = list(&db, PROJECT.to_string(), None).expect("list after prune");
        let previews: Vec<_> = rows
            .iter()
            .map(|r| r["preview_text"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(previews, vec!["i3", "i2"], "新しい 2 件だけが残る");
    }
}
