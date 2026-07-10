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

use super::Database;

/// `trash_bin_create` の引数 (FE は camelCase で送る — Tauri の引数
/// deserialize と napi 側 `from_wire` の両方が serde の rename_all で受ける)。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBinCreatePayload {
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
    deleted_at: String,
}

/// INSERT して作成行 (`SELECT *` の JSON object — 列名は snake_case のまま)
/// を返す。
pub fn create(db: &Database, payload: TrashBinCreatePayload) -> anyhow::Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO trash_items
         (id, project_id, kind, sub_kind, origin_scene_id, origin_codex_id,
          preview_text, preview_meta, payload, char_count, is_interesting, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(payload.project_id),
            Value::String(payload.kind),
            Value::String(payload.sub_kind),
            payload
                .origin_scene_id
                .map(Value::String)
                .unwrap_or(Value::Null),
            payload
                .origin_codex_id
                .map(Value::String)
                .unwrap_or(Value::Null),
            Value::String(payload.preview_text),
            payload
                .preview_meta
                .map(Value::String)
                .unwrap_or(Value::Null),
            Value::String(payload.payload),
            Value::Number(payload.char_count.into()),
            Value::Bool(payload.is_interesting),
            Value::String(payload.deleted_at),
        ],
        "run",
    )?;
    let rows = db.execute(
        "SELECT * FROM trash_items WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?;
    Ok(rows
        .first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null))
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
            deleted_at: deleted_at.to_string(),
        }
    }

    #[test]
    fn create_list_delete_roundtrip() {
        let db = test_db();
        let created = create(&db, payload("消した文字屑（日本語）", "2026-07-10T00:00:00Z"))
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
