//! PostEffects (校閲・構造分析) の純 DB 操作。
//!
//! 実装本体を旧 `src-tauri/src/commands/post_effect.rs` から本クレートへ移動した
//! (Electron 移行 Phase 3 バッチ1 — Tauri コマンドと napi `Backend` の両方が薄い
//! ラッパーとして呼ぶ。`trash_bin` / `plot_threads` / `foreshadow` と同じ構図)。
//! SQL・XPROJ ガード・エラー文字列・返却シェイプ (camelCase / snake_case) は
//! 移動前と完全に同一。
//!
//! ここに来るのは **純 DB** のコマンドのみ (`db.with_conn` ベース)。
//! `undo_journal` / `change_events` の tracked write は使わない —
//! change_events は FE (api.ts の recordChangeEvent) が invoke 解決後に記録する。
//! ネットワーク / AI 応答解析を含む `start_post_effect_run` 系と
//! `PostEffectAbortRegistry` を要する `abort_post_effect_run` はバッチ3で移す。

use std::collections::HashSet;

use rusqlite::params;
use serde_json::Value;
use uuid::Uuid;

use super::Database;

// ---------------------------------------------------------------------------
// list_post_effect_runs
// ---------------------------------------------------------------------------

pub fn list_post_effect_runs(
    db: &Database,
    project_id: String,
    effect_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> anyhow::Result<Vec<Value>> {
    db.with_conn(|conn| {
        let limit = limit.unwrap_or(20);
        let offset = offset.unwrap_or(0);
        let rows = if let Some(et) = &effect_type {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                        model, prompt_version, input_hash, status, summary,
                        error_message, started_at, completed_at
                   FROM post_effect_runs
                  WHERE project_id = ? AND effect_type = ?
                  ORDER BY started_at DESC
                  LIMIT ? OFFSET ?",
            )?;
            let r: Result<Vec<_>, _> = stmt
                .query_map(params![project_id, et, limit, offset], row_to_run_value)?
                .collect();
            r?
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                        model, prompt_version, input_hash, status, summary,
                        error_message, started_at, completed_at
                   FROM post_effect_runs
                  WHERE project_id = ?
                  ORDER BY started_at DESC
                  LIMIT ? OFFSET ?",
            )?;
            let r: Result<Vec<_>, _> = stmt
                .query_map(params![project_id, limit, offset], row_to_run_value)?
                .collect();
            r?
        };
        Ok(rows)
    })
}

// ---------------------------------------------------------------------------
// list_scene_lens_for_project
// ---------------------------------------------------------------------------

/// Outline オーバーレイ用クエリ。最新 run の lens を scene ごとに返す。
///
/// 最新判定の MAX(created_at) サブクエリは **外側と同じ母集団** (completed な
/// meta_structure run) に scope しなければならない。lens 行は
/// `process_meta_structure_scene` で run が completed になる **前** に INSERT
/// されるため、再実行・キャンセル・クラッシュ復旧 (migrate.rs の running→failed)
/// で残った failed/running run の新しい lens 行が、scope 漏れの MAX を汚染すると、
/// 直前の completed run の行が `created_at = MAX` 条件から外れて当該シーンが
/// overlay からサイレントに消える。サブクエリ側にも JOIN + status/effect_type
/// 条件を入れて MAX を completed 行のみから取る。
const SCENE_LENS_FOR_PROJECT_SQL: &str = "SELECT l.*, r.completed_at AS run_completed_at
   FROM scene_lens_data l
   JOIN post_effect_runs r ON r.id = l.run_id
  WHERE l.project_id = ?1
    AND r.effect_type = 'meta_structure'
    AND r.status = 'completed'
    AND l.created_at = (
        SELECT MAX(l2.created_at)
          FROM scene_lens_data l2
          JOIN post_effect_runs r2 ON r2.id = l2.run_id
         WHERE l2.target_id = l.target_id
           AND l2.lens_type = l.lens_type
           AND l2.project_id = l.project_id
           AND r2.effect_type = 'meta_structure'
           AND r2.status = 'completed'
    )
  ORDER BY l.created_at";

/// Outline オーバーレイ用: scene ごとに最新 run の lens を返す。
/// 各 lens に run の completed_at (`runCompletedAt`) を付け、stale 判定に使う。
pub fn list_scene_lens_for_project(db: &Database, project_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(SCENE_LENS_FOR_PROJECT_SQL)?;
        let rows: Result<Vec<Value>, _> = stmt
            .query_map(params![project_id], |row| {
                let mut v = row_to_lens_value(row)?;
                v["runCompletedAt"] =
                    serde_json::json!(row.get::<_, Option<String>>("run_completed_at")?);
                Ok(v)
            })?
            .collect();
        Ok(Value::Array(rows?))
    })
}

// ---------------------------------------------------------------------------
// list_annotations_for_scene
// ---------------------------------------------------------------------------

pub fn list_annotations_for_scene(
    db: &Database,
    project_id: String,
    scene_id: String,
    status: Option<String>,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let annotations = if let Some(st) = &status {
            let mut stmt = conn.prepare(
                "SELECT * FROM post_effect_annotations
                  WHERE project_id = ? AND scene_id = ? AND status = ?
                  ORDER BY range_start, created_at",
            )?;
            let r: Result<Vec<_>, _> = stmt
                .query_map(params![project_id, scene_id, st], row_to_annotation_value)?
                .collect();
            r?
        } else {
            let mut stmt = conn.prepare(
                "SELECT * FROM post_effect_annotations
                  WHERE project_id = ? AND scene_id = ?
                  ORDER BY range_start, created_at",
            )?;
            let r: Result<Vec<_>, _> = stmt
                .query_map(params![project_id, scene_id], row_to_annotation_value)?
                .collect();
            r?
        };

        // 両端のどちらかが上記 annotations に含まれる relation を返す
        let ann_ids: Vec<String> = annotations
            .iter()
            .filter_map(|a| a["id"].as_str().map(|s: &str| s.to_string()))
            .collect();

        let relations = if ann_ids.is_empty() {
            vec![]
        } else {
            let placeholders = ann_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT * FROM post_effect_annotation_relations
                  WHERE annotation_a_id IN ({placeholders})
                     OR annotation_b_id IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            // params は ann_ids を 2 回渡す必要がある
            let all_ids: Vec<&dyn rusqlite::ToSql> = ann_ids
                .iter()
                .chain(ann_ids.iter())
                .map(|s| s as &dyn rusqlite::ToSql)
                .collect();
            let r: Result<Vec<_>, _> = stmt
                .query_map(all_ids.as_slice(), row_to_relation_value)?
                .collect();
            r?
        };

        Ok(serde_json::json!({
            "annotations": annotations,
            "relations": relations,
        }))
    })
}

// ---------------------------------------------------------------------------
// list_annotations_for_project
// ---------------------------------------------------------------------------

pub fn list_annotations_for_project(
    db: &Database,
    project_id: String,
    status: Option<String>,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let annotations = if let Some(st) = &status {
            let mut stmt = conn.prepare(
                "SELECT * FROM post_effect_annotations
                  WHERE project_id = ? AND status = ?
                  ORDER BY scene_id, range_start, created_at",
            )?;
            let r: Result<Vec<_>, _> = stmt
                .query_map(params![project_id, st], row_to_annotation_value)?
                .collect();
            r?
        } else {
            let mut stmt = conn.prepare(
                "SELECT * FROM post_effect_annotations
                  WHERE project_id = ?
                  ORDER BY scene_id, range_start, created_at",
            )?;
            let r: Result<Vec<_>, _> = stmt
                .query_map(params![project_id], row_to_annotation_value)?
                .collect();
            r?
        };
        Ok(serde_json::json!({ "annotations": annotations }))
    })
}

// ---------------------------------------------------------------------------
// update_annotation_status
// ---------------------------------------------------------------------------

/// `update_annotation_status` の中核ロジック。
/// **XPROJ ガード**: `WHERE id = ? AND project_id = ?` で現在プロジェクトに限定する
/// (project_id は呼び出し側の現在プロジェクト)。他プロジェクトの annotation id を
/// 渡しても 0 行 = bail し、状態を書き換えられない (fail-closed)。コマンドから分離してテスト可能に。
///
/// `&rusqlite::Connection` を受けるので Tauri / napi の双方が `db.with_conn` 経由で呼ぶ。
pub fn update_annotation_status_inner(
    conn: &rusqlite::Connection,
    annotation_id: &str,
    status: &str,
    project_id: &str,
) -> anyhow::Result<Value> {
    // dismiss_source を status に合わせて更新
    let dismiss_source = if status == "dismissed" {
        Some("manual")
    } else {
        None
    };

    let affected = if let Some(src) = dismiss_source {
        conn.execute(
            "UPDATE post_effect_annotations
                SET status = ?,
                    metadata = json_set(metadata, '$.dismiss_source', ?),
                    updated_at = datetime('now')
              WHERE id = ? AND project_id = ?",
            params![status, src, annotation_id, project_id],
        )?
    } else {
        conn.execute(
            "UPDATE post_effect_annotations
                SET status = ?, updated_at = datetime('now')
              WHERE id = ? AND project_id = ?",
            params![status, annotation_id, project_id],
        )?
    };
    if affected == 0 {
        anyhow::bail!("annotation not found in project (id={annotation_id})");
    }

    let ann = conn.query_row(
        "SELECT * FROM post_effect_annotations WHERE id = ? AND project_id = ?",
        params![annotation_id, project_id],
        row_to_annotation_value,
    )?;
    Ok(ann)
}

// ---------------------------------------------------------------------------
// reply_to_annotation
// ---------------------------------------------------------------------------

/// `reply_to_annotation` の引数。**snake_case** (FE は `args` の下に snake_case で
/// キーを送る) — `#[serde(rename_all = ...)]` を **付けない** こと。
#[derive(serde::Deserialize)]
pub struct ReplyToAnnotationArgs {
    parent_id: String,
    content: String,
    author_role: String,
    /// XPROJ ガード: 親 annotation が属するべき現在プロジェクト。
    project_id: String,
}

/// `reply_to_annotation` の中核ロジック。
/// 親の project_id / scene_id / run_id / persona を継承して子 annotation を
/// INSERT し、read-back した Value を返す。コマンド本体から分離してテスト可能にする。
pub fn reply_to_annotation_inner(
    conn: &rusqlite::Connection,
    args: &ReplyToAnnotationArgs,
) -> anyhow::Result<Value> {
    // 親の project_id / scene_id / run_id / persona を継承する
    #[allow(clippy::type_complexity)]
    let (project_id, scene_id, run_id, persona): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        // XPROJ ガード: 親は現在プロジェクトのものに限定 (他プロジェクトの
        // parent_id を渡しても 0 行 = NoRows エラーで fail-closed)。
        "SELECT project_id, scene_id, run_id, persona
           FROM post_effect_annotations WHERE id = ? AND project_id = ?",
        params![args.parent_id, args.project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    let author_role = match args.author_role.as_str() {
        "user" | "ai" | "system" => args.author_role.as_str(),
        _ => "user",
    };
    let new_id = Uuid::new_v4().to_string();
    let metadata = serde_json::json!({ "persona": persona });
    conn.execute(
        "INSERT INTO post_effect_annotations
            (id, project_id, run_id, anchor_type, scene_id,
             category, persona, content, author_role, parent_id,
             status, metadata, created_at, updated_at)
         VALUES (?, ?, ?, 'scene_range', ?,
                 'pseudo_comment', ?, ?, ?, ?,
                 'open', ?, datetime('now'), datetime('now'))",
        params![
            new_id,
            project_id,
            run_id,
            scene_id,
            persona,
            args.content,
            author_role,
            args.parent_id,
            metadata.to_string(),
        ],
    )?;

    let ann = conn.query_row(
        "SELECT * FROM post_effect_annotations WHERE id = ?",
        params![new_id],
        row_to_annotation_value,
    )?;
    Ok(ann)
}

// ---------------------------------------------------------------------------
// save_post_effect_annotations
// ---------------------------------------------------------------------------

pub fn save_post_effect_annotations(
    db: &Database,
    project_id: String,
    scene_id: String,
    annotations: Vec<Value>,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        let anchored_ids: HashSet<&str> = annotations
            .iter()
            .filter_map(|ann| ann["id"].as_str())
            .collect();
        for ann in &annotations {
            let id = ann["id"].as_str().unwrap_or("");
            let range_start = ann["range_start"].as_i64().unwrap_or(0);
            let range_end = ann["range_end"].as_i64().unwrap_or(0);
            let text_snapshot = ann["text_snapshot"].as_str().unwrap_or("");
            conn.execute(
                "UPDATE post_effect_annotations
                    SET range_start = ?, range_end = ?, text_snapshot = ?,
                        updated_at = datetime('now')
                  WHERE id = ? AND project_id = ? AND scene_id = ?",
                params![
                    range_start,
                    range_end,
                    text_snapshot,
                    id,
                    project_id,
                    scene_id
                ],
            )?;
        }

        // ライブ読者コメントだけは、本文から mark が消えた時点で寿命を終える。
        // 通常の疑似コメントは orphaned として校閲パネルに残す既存仕様を維持する。
        let live_ids = conn
            .prepare(
                "SELECT id FROM post_effect_annotations
                  WHERE project_id = ? AND scene_id = ?
                    AND category = 'pseudo_comment'
                    AND json_extract(metadata, '$.live') = 1",
            )?
            .query_map(params![project_id, scene_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in live_ids {
            if !anchored_ids.contains(id.as_str()) {
                conn.execute(
                    "DELETE FROM post_effect_annotations
                      WHERE id = ? AND project_id = ? AND scene_id = ?",
                    params![id, project_id, scene_id],
                )?;
            }
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Row → serde_json::Value ヘルパー
// ---------------------------------------------------------------------------

pub fn row_to_run_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id":               row.get::<_, String>(0)?,
        "projectId":        row.get::<_, String>(1)?,
        "effectType":       row.get::<_, String>(2)?,
        "scopeType":        row.get::<_, String>(3)?,
        "scopeTargetId":    row.get::<_, Option<String>>(4)?,
        "model":            row.get::<_, String>(5)?,
        "promptVersion":    row.get::<_, String>(6)?,
        "inputHash":        row.get::<_, Option<String>>(7)?,
        "status":           row.get::<_, String>(8)?,
        "summary":          row.get::<_, Option<String>>(9)?,
        "errorMessage":     row.get::<_, Option<String>>(10)?,
        "startedAt":        row.get::<_, String>(11)?,
        "completedAt":      row.get::<_, Option<String>>(12)?,
    }))
}

pub fn row_to_annotation_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str: String = row.get("metadata").unwrap_or_else(|_| "{}".into());
    let metadata: Value =
        serde_json::from_str(&metadata_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":           row.get::<_, String>("id")?,
        "projectId":    row.get::<_, String>("project_id")?,
        "runId":        row.get::<_, Option<String>>("run_id")?,
        "anchorType":   row.get::<_, String>("anchor_type")?,
        "sceneId":      row.get::<_, Option<String>>("scene_id")?,
        "rangeStart":   row.get::<_, Option<i64>>("range_start")?,
        "rangeEnd":     row.get::<_, Option<i64>>("range_end")?,
        "textSnapshot": row.get::<_, Option<String>>("text_snapshot")?,
        "category":     row.get::<_, String>("category")?,
        "persona":      row.get::<_, Option<String>>("persona")?,
        "severity":     row.get::<_, Option<String>>("severity")?,
        "content":      row.get::<_, String>("content")?,
        "authorRole":   row.get::<_, String>("author_role")?,
        "parentId":     row.get::<_, Option<String>>("parent_id")?,
        "status":       row.get::<_, String>("status")?,
        "metadata":     metadata,
        "createdAt":    row.get::<_, String>("created_at")?,
        "updatedAt":    row.get::<_, String>("updated_at")?,
    }))
}

pub fn row_to_relation_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str: String = row.get("metadata").unwrap_or_else(|_| "{}".into());
    let metadata: Value =
        serde_json::from_str(&metadata_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":              row.get::<_, String>("id")?,
        "projectId":       row.get::<_, String>("project_id")?,
        "runId":           row.get::<_, Option<String>>("run_id")?,
        "annotationAId":   row.get::<_, String>("annotation_a_id")?,
        "annotationBId":   row.get::<_, String>("annotation_b_id")?,
        "relationType":    row.get::<_, String>("relation_type")?,
        "direction":       row.get::<_, String>("direction")?,
        "description":     row.get::<_, Option<String>>("description")?,
        "status":          row.get::<_, String>("status")?,
        "metadata":        metadata,
        "createdAt":       row.get::<_, String>("created_at")?,
    }))
}

pub fn row_to_lens_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metrics_str: String = row.get("metrics").unwrap_or_else(|_| "{}".into());
    let metrics: Value =
        serde_json::from_str(&metrics_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":         row.get::<_, String>("id")?,
        "projectId":  row.get::<_, String>("project_id")?,
        "runId":      row.get::<_, String>("run_id")?,
        "targetId":   row.get::<_, Option<String>>("target_id")?,
        "lensType":   row.get::<_, String>("lens_type")?,
        "metrics":    metrics,
        "finding":    row.get::<_, Option<String>>("finding")?,
        "severity":   row.get::<_, String>("severity")?,
        "createdAt":  row.get::<_, String>("created_at")?,
    }))
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod reply_to_annotation_tests {
    use super::{reply_to_annotation_inner, ReplyToAnnotationArgs};
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_annotations (
                id          TEXT PRIMARY KEY,
                project_id  TEXT,
                run_id      TEXT,
                anchor_type TEXT,
                scene_id    TEXT,
                range_start INTEGER,
                range_end   INTEGER,
                text_snapshot TEXT,
                category    TEXT NOT NULL,
                persona     TEXT,
                severity    TEXT,
                content     TEXT,
                author_role TEXT,
                parent_id   TEXT,
                status      TEXT NOT NULL,
                metadata    TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT,
                updated_at  TEXT
            );",
        )
        .unwrap();
        conn
    }

    /// 親 (pseudo_comment / open) を継承対象の 4 列込みで INSERT する。
    /// persona は `Option` で渡し、NULL ケースもカバーできるようにする。
    fn insert_parent(
        conn: &Connection,
        id: &str,
        project_id: &str,
        scene_id: Option<&str>,
        run_id: Option<&str>,
        persona: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, project_id, scene_id, run_id, anchor_type,
                 category, persona, content, author_role, status, metadata)
             VALUES (?, ?, ?, ?, 'scene_range',
                     'pseudo_comment', ?, 'parent body', 'ai', 'open', '{}')",
            params![id, project_id, scene_id, run_id, persona],
        )
        .unwrap();
    }

    fn args(parent_id: &str, content: &str, author_role: &str) -> ReplyToAnnotationArgs {
        // 既存テストは親と同一プロジェクトを前提 (proj-1 / proj)。XPROJ ガードの
        // 不一致ケースは args_in() で別途検証する。
        args_in(parent_id, content, author_role, "proj-1")
    }

    fn args_in(
        parent_id: &str,
        content: &str,
        author_role: &str,
        project_id: &str,
    ) -> ReplyToAnnotationArgs {
        ReplyToAnnotationArgs {
            parent_id: parent_id.to_string(),
            content: content.to_string(),
            author_role: author_role.to_string(),
            project_id: project_id.to_string(),
        }
    }

    // ---- (a) inheritance ----

    #[test]
    fn inherits_parent_fields() {
        let conn = open_db();
        insert_parent(
            &conn,
            "parent-1",
            "proj-1",
            Some("scene-7"),
            Some("run-9"),
            Some("校閲者A"),
        );

        let child =
            reply_to_annotation_inner(&conn, &args("parent-1", "返信本文", "user")).unwrap();

        // Uuid はランダムなので返り値から child id を読み戻す
        let child_id = child["id"].as_str().unwrap();
        assert_ne!(child_id, "parent-1");

        // 4 つの継承フィールドが親と一致
        assert_eq!(child["projectId"].as_str(), Some("proj-1"));
        assert_eq!(child["sceneId"].as_str(), Some("scene-7"));
        assert_eq!(child["runId"].as_str(), Some("run-9"));
        assert_eq!(child["persona"].as_str(), Some("校閲者A"));

        // 親子リンク・固定値
        assert_eq!(child["parentId"].as_str(), Some("parent-1"));
        assert_eq!(child["status"].as_str(), Some("open"));
        assert_eq!(child["category"].as_str(), Some("pseudo_comment"));
        assert_eq!(child["content"].as_str(), Some("返信本文"));
        assert_eq!(child["authorRole"].as_str(), Some("user"));

        // metadata.persona も親 persona を反映
        assert_eq!(child["metadata"]["persona"].as_str(), Some("校閲者A"));
    }

    // ---- (b) author_role fallback ----

    fn author_role_for(input: &str) -> String {
        let conn = open_db();
        insert_parent(&conn, "p", "proj-1", Some("s"), Some("r"), Some("persona"));
        let child = reply_to_annotation_inner(&conn, &args("p", "c", input)).unwrap();
        child["authorRole"].as_str().unwrap().to_string()
    }

    #[test]
    fn author_role_known_values_pass_through() {
        assert_eq!(author_role_for("user"), "user");
        assert_eq!(author_role_for("ai"), "ai");
        assert_eq!(author_role_for("system"), "system");
    }

    #[test]
    fn author_role_unknown_falls_back_to_user() {
        assert_eq!(author_role_for("garbage"), "user");
        assert_eq!(author_role_for(""), "user");
    }

    // ---- (c) NULL persona ----

    #[test]
    fn null_persona_parent_yields_null_child_persona() {
        let conn = open_db();
        insert_parent(&conn, "p", "proj-1", Some("s"), Some("r"), None);

        let child = reply_to_annotation_inner(&conn, &args("p", "c", "user")).unwrap();

        assert!(child["persona"].is_null());
        assert!(child["metadata"]["persona"].is_null());
    }

    // ---- (d) XPROJ guard: 別プロジェクトの parent_id では返信できない ----

    #[test]
    fn rejects_reply_to_parent_in_another_project() {
        let conn = open_db();
        insert_parent(&conn, "p", "proj-A", Some("s"), Some("r"), None);

        // proj-B から proj-A の親へ返信を試みる → 親 lookup が 0 行で Err
        let res = reply_to_annotation_inner(&conn, &args_in("p", "侵入", "user", "proj-B"));
        assert!(res.is_err(), "cross-project reply must be rejected");

        // 子 annotation が作られていないこと
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM post_effect_annotations WHERE parent_id = 'p'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "no child row may be inserted on rejection");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod xproj_scope_tests {
    use super::update_annotation_status_inner;
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_annotations (
                id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT, anchor_type TEXT,
                scene_id TEXT, range_start INTEGER, range_end INTEGER, text_snapshot TEXT,
                category TEXT NOT NULL, persona TEXT, severity TEXT, content TEXT,
                author_role TEXT, parent_id TEXT, status TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn insert_ann(conn: &Connection, id: &str, project_id: &str) {
        // anchor_type / created_at / updated_at は row_to_annotation_value が
        // 非 Option で読むため必ず埋める (read-back を成立させる)。
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, project_id, anchor_type, category, content, author_role,
                 status, metadata, created_at, updated_at)
             VALUES (?, ?, 'scene_range', 'consistency_anchor', 'c', 'ai',
                     'open', '{}', '2024-01-01', '2024-01-01')",
            params![id, project_id],
        )
        .unwrap();
    }

    fn status_of(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT status FROM post_effect_annotations WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn update_annotation_status_rejects_other_project() {
        let conn = open_db();
        insert_ann(&conn, "a1", "proj-A");

        // 別プロジェクトからの更新は弾かれ、状態は変わらない
        let res = update_annotation_status_inner(&conn, "a1", "dismissed", "proj-B");
        assert!(res.is_err(), "cross-project update must be rejected");
        assert_eq!(status_of(&conn, "a1"), "open");

        // 同一プロジェクトなら更新できる
        let ok = update_annotation_status_inner(&conn, "a1", "dismissed", "proj-A");
        assert!(ok.is_ok());
        assert_eq!(status_of(&conn, "a1"), "dismissed");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod list_scene_lens_for_project_tests {
    use super::SCENE_LENS_FOR_PROJECT_SQL;
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_runs (
                id           TEXT PRIMARY KEY,
                effect_type  TEXT,
                status       TEXT,
                completed_at TEXT
            );
            CREATE TABLE scene_lens_data (
                id          TEXT PRIMARY KEY,
                project_id  TEXT,
                run_id      TEXT,
                target_id   TEXT,
                lens_type   TEXT,
                metrics     TEXT NOT NULL DEFAULT '{}',
                finding     TEXT,
                severity    TEXT NOT NULL DEFAULT 'info',
                created_at  TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn add_run(conn: &Connection, id: &str, effect_type: &str, status: &str, completed_at: &str) {
        conn.execute(
            "INSERT INTO post_effect_runs (id, effect_type, status, completed_at)
             VALUES (?, ?, ?, ?)",
            params![id, effect_type, status, completed_at],
        )
        .unwrap();
    }

    fn add_lens(
        conn: &Connection,
        id: &str,
        run_id: &str,
        target_id: &str,
        lens_type: &str,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO scene_lens_data
                (id, project_id, run_id, target_id, lens_type, finding, severity, created_at)
             VALUES (?, 'p1', ?, ?, ?, 'f', 'info', ?)",
            params![id, run_id, target_id, lens_type, created_at],
        )
        .unwrap();
    }

    /// SQL を走らせ、返ってきた lens 行の run_id 一覧を返す。
    fn query_run_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare(SCENE_LENS_FOR_PROJECT_SQL).unwrap();
        stmt.query_map(params!["p1"], |row| row.get::<_, String>("run_id"))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn newer_failed_run_does_not_shadow_completed_lens() {
        // 回帰ガード: completed run の lens が、後から失敗した re-run の
        // 新しい lens 行 (MAX を汚染) によって overlay から消えてはならない。
        let conn = open_db();
        add_run(
            &conn,
            "rA",
            "meta_structure",
            "completed",
            "2026-01-01T00:00:00",
        );
        add_lens(
            &conn,
            "lA",
            "rA",
            "s1",
            "plot_structure",
            "2026-01-01T00:00:00",
        );
        // 後から走って失敗した re-run。lens 行は finalize 前に INSERT 済みで残る。
        add_run(
            &conn,
            "rB",
            "meta_structure",
            "failed",
            "2026-01-02T00:00:00",
        );
        add_lens(
            &conn,
            "lB",
            "rB",
            "s1",
            "plot_structure",
            "2026-01-02T00:00:00",
        );

        assert_eq!(
            query_run_ids(&conn),
            vec!["rA".to_string()],
            "completed run の lens のみ返るべき"
        );
    }

    #[test]
    fn running_rerun_does_not_shadow_completed_lens() {
        // クラッシュ前 (running のまま) の re-run も同様に shadow してはならない。
        let conn = open_db();
        add_run(
            &conn,
            "rA",
            "meta_structure",
            "completed",
            "2026-01-01T00:00:00",
        );
        add_lens(&conn, "lA", "rA", "s1", "pacing", "2026-01-01T00:00:00");
        add_run(&conn, "rB", "meta_structure", "running", "");
        add_lens(&conn, "lB", "rB", "s1", "pacing", "2026-01-02T00:00:00");

        assert_eq!(query_run_ids(&conn), vec!["rA".to_string()]);
    }

    #[test]
    fn newest_completed_run_wins() {
        // 正常系: 同一 scene+lens を 2 回 completed したら最新だけ返る。
        let conn = open_db();
        add_run(
            &conn,
            "rA",
            "meta_structure",
            "completed",
            "2026-01-01T00:00:00",
        );
        add_lens(
            &conn,
            "lA",
            "rA",
            "s1",
            "plot_structure",
            "2026-01-01T00:00:00",
        );
        add_run(
            &conn,
            "rB",
            "meta_structure",
            "completed",
            "2026-01-03T00:00:00",
        );
        add_lens(
            &conn,
            "lB",
            "rB",
            "s1",
            "plot_structure",
            "2026-01-03T00:00:00",
        );

        assert_eq!(query_run_ids(&conn), vec!["rB".to_string()]);
    }
}
