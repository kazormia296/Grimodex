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

use serde_json::Value;

use super::{
    idempotency::{load_row, payload_fingerprint, run_atomic_create, IdempotencyRequest},
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
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
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
        // 期日切れ (retention 60 日をはるかに超える古さ)
        create(&db, payload("期日切れ", "2020-01-01T00:00:00Z")).expect("create expired");
        // 新しいもの 3 件
        create(&db, payload("i1", "2026-07-01T00:00:00Z")).expect("create");
        create(&db, payload("i2", "2026-07-02T00:00:00Z")).expect("create");
        create(&db, payload("i3", "2026-07-03T00:00:00Z")).expect("create");

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
