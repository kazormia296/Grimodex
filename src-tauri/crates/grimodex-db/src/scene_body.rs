//! Atomic persistence for the Electron scene-body autosave hot path.
//!
//! Renderer-derived document metadata crosses IPC once, then content and every
//! schema-backed sidecar are committed under one `BEGIN IMMEDIATE`.

use std::collections::HashSet;
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::Database;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneAuthorshipSpanInput {
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneForeshadowSetupInput {
    pub id: String,
    pub foreshadow_id: String,
    pub from_pos: i64,
    pub to_pos: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneForeshadowPayoffInput {
    pub foreshadow_id: String,
    pub from_pos: i64,
    pub to_pos: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneAnnotationAnchorInput {
    pub id: String,
    pub range_start: i64,
    pub range_end: i64,
    pub text_snapshot: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneBeatMentionInput {
    pub beat_id: String,
    pub codex_id: String,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSceneBodyBundlePayload {
    pub scene_id: String,
    pub project_id: String,
    pub include_sidecars: bool,
    pub base_version: Option<i64>,
    pub updated_at: String,
    pub content_json: String,
    pub char_count: i64,
    pub placed_beat_preview: Option<String>,
    pub unplaced_beats_doc: String,
    pub unplaced_beat_preview: Option<String>,
    pub authorship_spans: Vec<SceneAuthorshipSpanInput>,
    pub foreshadow_setups: Vec<SceneForeshadowSetupInput>,
    pub foreshadow_payoffs: Vec<SceneForeshadowPayoffInput>,
    pub annotation_anchors: Vec<SceneAnnotationAnchorInput>,
    pub beat_mentions: Vec<SceneBeatMentionInput>,
    pub beat_pov_overrides: Vec<String>,
    pub doc_content_size: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSceneBodyBundleResult {
    pub placed_beat_preview: Option<String>,
    pub unplaced_beat_preview: Option<String>,
    pub content_version: i64,
    pub content_updated_at: String,
    /// Number of SQLite transactions committed by this domain operation.
    pub db_transaction_count: u32,
}

/// Extract the plain text represented by the ProseMirror JSON document.
///
/// Live annotation anchors may be intentionally absent from `annotation_anchors`
/// after a user resolves/dismisses a comment. The body text is the authority for
/// deciding whether the generated comment's target still exists.
fn scene_text_from_content_json(content_json: &str) -> Option<String> {
    fn append_node_text(node: &serde_json::Value, output: &mut String) {
        let node_type = node.get("type").and_then(serde_json::Value::as_str);
        if node_type == Some("sceneBeat") {
            return;
        }
        if node_type == Some("text") {
            if let Some(text) = node.get("text").and_then(serde_json::Value::as_str) {
                output.push_str(text);
            }
            return;
        }
        if let Some(children) = node.get("content").and_then(serde_json::Value::as_array) {
            for child in children {
                append_node_text(child, output);
            }
        }
    }

    let document: serde_json::Value = serde_json::from_str(content_json).ok()?;
    if document.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
        return None;
    }
    let mut text = String::new();
    let Some(children) = document.get("content") else {
        return Some(text);
    };
    let children = children.as_array()?;
    for (index, child) in children.iter().enumerate() {
        if index > 0 {
            text.push('\n');
        }
        append_node_text(child, &mut text);
    }
    Some(text)
}

fn validate_payload(payload: &SaveSceneBodyBundlePayload) -> anyhow::Result<()> {
    if payload.scene_id.is_empty() || payload.project_id.is_empty() {
        anyhow::bail!("sceneId and projectId must not be empty");
    }
    if payload.char_count < 0 || payload.doc_content_size < 0 {
        anyhow::bail!("scene document sizes must be non-negative");
    }
    if payload.base_version.is_some_and(|version| version < 0) {
        anyhow::bail!("scene base version must be non-negative");
    }
    if payload.updated_at.trim().is_empty()
        || chrono::DateTime::parse_from_rfc3339(&payload.updated_at).is_err()
    {
        anyhow::bail!("scene updatedAt must be a valid RFC3339 timestamp");
    }
    for span in &payload.authorship_spans {
        if span.from_pos < 0
            || span.to_pos < span.from_pos
            || !matches!(span.source.as_str(), "human" | "ai" | "unknown")
        {
            anyhow::bail!("invalid authorship span range");
        }
    }
    for setup in &payload.foreshadow_setups {
        if setup.id.is_empty()
            || setup.foreshadow_id.is_empty()
            || setup.from_pos < 0
            || setup.to_pos < setup.from_pos
        {
            anyhow::bail!("invalid foreshadow setup anchor");
        }
    }
    for payoff in &payload.foreshadow_payoffs {
        if payoff.foreshadow_id.is_empty() || payoff.from_pos < 0 || payoff.to_pos < payoff.from_pos
        {
            anyhow::bail!("invalid foreshadow payoff anchor");
        }
    }
    for annotation in &payload.annotation_anchors {
        if annotation.id.is_empty()
            || annotation.range_start < 0
            || annotation.range_end < annotation.range_start
        {
            anyhow::bail!("invalid annotation anchor");
        }
    }
    for mention in &payload.beat_mentions {
        if mention.beat_id.is_empty()
            || mention.codex_id.is_empty()
            || !matches!(mention.role.as_str(), "actor" | "target" | "mentioned")
        {
            anyhow::bail!("invalid beat mention");
        }
    }
    if payload
        .beat_pov_overrides
        .iter()
        .any(|codex_id| codex_id.is_empty())
    {
        anyhow::bail!("invalid beat POV override");
    }
    Ok(())
}

pub fn save_scene_body_bundle(
    db: &Database,
    payload: SaveSceneBodyBundlePayload,
) -> anyhow::Result<SaveSceneBodyBundleResult> {
    validate_payload(&payload)?;
    db.with_conn(|conn| {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<SaveSceneBodyBundleResult> {
            let updated = conn
                .query_row(
                    "UPDATE tree_nodes
                        SET content = ?1,
                            unplaced_beats_doc = ?2,
                            char_count = ?3,
                            placed_beat_preview = ?4,
                            unplaced_beat_preview = ?5,
                            version = version + 1,
                            updated_at = ?6
                      WHERE id = ?7 AND project_id = ?8
                        AND (?9 IS NULL OR version = ?9)
                  RETURNING version, updated_at",
                    params![
                        payload.content_json,
                        payload.unplaced_beats_doc,
                        payload.char_count,
                        payload.placed_beat_preview,
                        payload.unplaced_beat_preview,
                        payload.updated_at,
                        payload.scene_id,
                        payload.project_id,
                        payload.base_version,
                    ],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "scene content conflict or scene not found in project: {} / {}",
                        payload.project_id,
                        payload.scene_id
                    )
                })?;

            if payload.include_sidecars {
                conn.execute(
                    "DELETE FROM authorship_spans WHERE node_id = ?1",
                    params![payload.scene_id],
                )?;
                for span in &payload.authorship_spans {
                    conn.execute(
                        "INSERT INTO authorship_spans
                            (id, node_id, from_pos, to_pos, source, model, timestamp,
                             chat_msg_id, trace_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            payload.scene_id,
                            span.from_pos,
                            span.to_pos,
                            span.source,
                            span.model,
                            span.timestamp,
                            span.chat_msg_id,
                            span.trace_id,
                        ],
                    )?;
                }

                let now_ms = chrono::Utc::now().timestamp_millis();
                let mut valid_setup_ids = Vec::new();
                for setup in &payload.foreshadow_setups {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM foreshadows
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![setup.foreshadow_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        anyhow::bail!(
                            "foreshadow setup '{}' is not owned by project '{}'",
                            setup.id,
                            payload.project_id
                        );
                    }
                    let existing: Option<(String, String)> = conn
                        .query_row(
                            "SELECT foreshadow_id, scene_id
                               FROM foreshadow_setups
                              WHERE id = ?1",
                            params![setup.id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?;
                    if let Some((existing_foreshadow_id, existing_scene_id)) = existing {
                        if existing_foreshadow_id != setup.foreshadow_id
                            || existing_scene_id != payload.scene_id
                        {
                            anyhow::bail!(
                                "foreshadow setup '{}' belongs to a different anchor",
                                setup.id
                            );
                        }
                    }
                    conn.execute(
                        "INSERT INTO foreshadow_setups
                            (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                             attribution, is_orphan, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, 'designated_existing',
                                 'human', 0, ?6, ?6)
                         ON CONFLICT(id) DO UPDATE SET
                            from_pos = excluded.from_pos,
                            to_pos = excluded.to_pos,
                            is_orphan = 0,
                            updated_at = excluded.updated_at",
                        params![
                            setup.id,
                            setup.foreshadow_id,
                            payload.scene_id,
                            setup.from_pos,
                            setup.to_pos,
                            now_ms,
                        ],
                    )?;
                    valid_setup_ids.push(setup.id.clone());
                }
                for payoff in &payload.foreshadow_payoffs {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM foreshadows
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![payoff.foreshadow_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        anyhow::bail!(
                            "foreshadow payoff '{}' is not owned by project '{}'",
                            payoff.foreshadow_id,
                            payload.project_id
                        );
                    }
                    conn.execute(
                        "UPDATE foreshadows
                            SET payoff_scene_id = ?1,
                                payoff_from_pos = ?2,
                                payoff_to_pos = ?3,
                                updated_at = ?4
                          WHERE id = ?5 AND project_id = ?6",
                        params![
                            payload.scene_id,
                            payoff.from_pos,
                            payoff.to_pos,
                            now_ms,
                            payoff.foreshadow_id,
                            payload.project_id,
                        ],
                    )?;
                }
                if valid_setup_ids.is_empty() {
                    if payload.doc_content_size <= 2 {
                        conn.execute(
                            "UPDATE foreshadow_setups
                                SET is_orphan = 1, updated_at = ?1
                              WHERE scene_id = ?2",
                            params![now_ms, payload.scene_id],
                        )?;
                    }
                } else {
                    let valid: HashSet<&str> = valid_setup_ids.iter().map(String::as_str).collect();
                    let mut statement =
                        conn.prepare("SELECT id FROM foreshadow_setups WHERE scene_id = ?1")?;
                    let existing = statement
                        .query_map(params![payload.scene_id], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(statement);
                    for id in existing {
                        if !valid.contains(id.as_str()) {
                            conn.execute(
                                "UPDATE foreshadow_setups
                                    SET is_orphan = 1, updated_at = ?1
                                  WHERE id = ?2",
                                params![now_ms, id],
                            )?;
                        }
                    }
                }

                for annotation in &payload.annotation_anchors {
                    conn.execute(
                        "UPDATE post_effect_annotations
                            SET range_start = ?1,
                                range_end = ?2,
                                text_snapshot = ?3,
                                updated_at = datetime('now')
                          WHERE id = ?4 AND project_id = ?5 AND scene_id = ?6",
                        params![
                            annotation.range_start,
                            annotation.range_end,
                            annotation.text_snapshot,
                            annotation.id,
                            payload.project_id,
                            payload.scene_id,
                        ],
                    )?;
                }

                // ライブ読者コメントは本文 mark が消えたら保存対象からも消す。
                // ただし、解決/却下で mark だけが外れた場合は本文の text_snapshot が
                // 残っていれば保持する。手動/通常の疑似コメントは orphaned として
                // 残す既存仕様を維持する。
                let anchored_annotation_ids: HashSet<&str> = payload
                    .annotation_anchors
                    .iter()
                    .map(|annotation| annotation.id.as_str())
                    .collect();
                let scene_text = scene_text_from_content_json(&payload.content_json);
                let live_ids = conn
                    .prepare(
                        "SELECT id, text_snapshot FROM post_effect_annotations
                          WHERE project_id = ?1 AND scene_id = ?2
                            AND category = 'pseudo_comment'
                            AND json_extract(metadata, '$.live') = 1",
                    )?
                    .query_map(params![payload.project_id, payload.scene_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for (id, text_snapshot) in live_ids {
                    // 不正な本文JSONでは誤削除を避け、次回の正常な保存へ委ねる。
                    if scene_text.is_none() {
                        continue;
                    }
                    // found_text が空のシーン全体コメントは、消えた本文を
                    // 指しているとは判定できないため、生成物を保持する。
                    let Some(snapshot) = text_snapshot.as_deref().filter(|text| !text.is_empty())
                    else {
                        continue;
                    };
                    let target_still_exists = scene_text.as_deref().is_some_and(|text| {
                        text.contains(snapshot)
                    });
                    if target_still_exists {
                        continue;
                    }
                    if !anchored_annotation_ids.contains(id.as_str()) {
                        conn.execute(
                            "DELETE FROM post_effect_annotations
                              WHERE id = ?1 AND project_id = ?2 AND scene_id = ?3",
                            params![id, payload.project_id, payload.scene_id],
                        )?;
                    }
                }

                let mut wanted_mentions = HashSet::new();
                for mention in &payload.beat_mentions {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM codex_entries
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![mention.codex_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        continue;
                    }
                    conn.execute(
                        "INSERT INTO scene_codex_mentions
                            (scene_id, codex_entry_id, source, role)
                         VALUES (?1, ?2, 'beat', ?3)
                         ON CONFLICT(scene_id, codex_entry_id, source)
                         DO UPDATE SET role = excluded.role",
                        params![payload.scene_id, mention.codex_id, mention.role],
                    )?;
                    wanted_mentions.insert(mention.codex_id.as_str());
                }
                let mut statement = conn.prepare(
                    "SELECT codex_entry_id FROM scene_codex_mentions
                      WHERE scene_id = ?1 AND source = 'beat'",
                )?;
                let existing = statement
                    .query_map(params![payload.scene_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(statement);
                for codex_id in existing {
                    if !wanted_mentions.contains(codex_id.as_str()) {
                        conn.execute(
                            "DELETE FROM scene_codex_mentions
                              WHERE scene_id = ?1
                                AND codex_entry_id = ?2
                                AND source = 'beat'",
                            params![payload.scene_id, codex_id],
                        )?;
                    }
                }

                let mut wanted_povs = HashSet::new();
                for codex_id in &payload.beat_pov_overrides {
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM codex_entries
                             WHERE id = ?1 AND project_id = ?2
                        )",
                        params![codex_id, payload.project_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        continue;
                    }
                    conn.execute(
                        "INSERT OR IGNORE INTO scene_beat_pov_cache
                            (scene_id, pov_character_id)
                         VALUES (?1, ?2)",
                        params![payload.scene_id, codex_id],
                    )?;
                    wanted_povs.insert(codex_id.as_str());
                }
                let mut statement = conn.prepare(
                    "SELECT pov_character_id FROM scene_beat_pov_cache
                      WHERE scene_id = ?1",
                )?;
                let existing = statement
                    .query_map(params![payload.scene_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(statement);
                for codex_id in existing {
                    if !wanted_povs.contains(codex_id.as_str()) {
                        conn.execute(
                            "DELETE FROM scene_beat_pov_cache
                              WHERE scene_id = ?1 AND pov_character_id = ?2",
                            params![payload.scene_id, codex_id],
                        )?;
                    }
                }
            }

            Ok(SaveSceneBodyBundleResult {
                placed_beat_preview: payload.placed_beat_preview.clone(),
                unplaced_beat_preview: payload.unplaced_beat_preview.clone(),
                content_version: updated.0,
                content_updated_at: updated.1,
                db_transaction_count: 1,
            })
        })();

        match result {
            Ok(value) => {
                if let Err(error) = conn.execute_batch("COMMIT") {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open test db");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Project')",
            &[Value::String("p1".into())],
            "run",
        )
        .expect("insert project");
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
             VALUES (?, ?, 'scene', 'Scene', ?)",
            &[
                Value::String("s1".into()),
                Value::String("p1".into()),
                Value::String("{\"old\":true}".into()),
            ],
            "run",
        )
        .expect("insert scene");
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('c1', 'p1', 'character', 'Character'),
                    ('c2', 'p1', 'character', 'Stale Character')",
            &[],
            "run",
        )
        .expect("insert codex");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('f1', 'p1', 'Setup', 0, 0, 0, 1, 1),
                    ('f2', 'p1', 'Payoff', 0, 0, 0, 1, 1)",
            &[],
            "run",
        )
        .expect("insert foreshadows");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO authorship_spans
                (id, node_id, from_pos, to_pos, source)
             VALUES ('old-span', 's1', 0, 1, 'unknown');
             INSERT INTO foreshadow_setups
                (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                 attribution, is_orphan, created_at, updated_at)
             VALUES ('setup-stale', 'f1', 's1', 0, 1, 'designated_existing',
                     'human', 0, 1, 1);
             INSERT INTO post_effect_annotations
                (id, project_id, scene_id, range_start, range_end, text_snapshot,
                 category, content)
             VALUES ('a1', 'p1', 's1', 0, 1, 'old', 'review', 'Review');
             INSERT INTO scene_codex_mentions
                (scene_id, codex_entry_id, source, role)
             VALUES ('s1', 'c2', 'beat', 'target');
             INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id)
             VALUES ('s1', 'c2');",
            )?;
            Ok(())
        })
        .expect("seed stale sidecars");
        db
    }

    fn payload() -> SaveSceneBodyBundlePayload {
        SaveSceneBodyBundlePayload {
            scene_id: "s1".into(),
            project_id: "p1".into(),
            include_sidecars: true,
            base_version: None,
            updated_at: "2026-07-28T00:00:00.000Z".into(),
            content_json: "{\"type\":\"doc\"}".into(),
            char_count: 12,
            placed_beat_preview: Some("[\"beat\"]".into()),
            unplaced_beats_doc: "[]".into(),
            unplaced_beat_preview: None,
            authorship_spans: vec![SceneAuthorshipSpanInput {
                from_pos: 1,
                to_pos: 4,
                source: "human".into(),
                model: None,
                timestamp: None,
                chat_msg_id: None,
                trace_id: None,
            }],
            foreshadow_setups: vec![SceneForeshadowSetupInput {
                id: "setup-current".into(),
                foreshadow_id: "f1".into(),
                from_pos: 2,
                to_pos: 5,
            }],
            foreshadow_payoffs: vec![SceneForeshadowPayoffInput {
                foreshadow_id: "f2".into(),
                from_pos: 6,
                to_pos: 9,
            }],
            annotation_anchors: vec![SceneAnnotationAnchorInput {
                id: "a1".into(),
                range_start: 3,
                range_end: 8,
                text_snapshot: "updated".into(),
            }],
            beat_mentions: vec![SceneBeatMentionInput {
                beat_id: "b1".into(),
                codex_id: "c1".into(),
                role: "actor".into(),
            }],
            beat_pov_overrides: vec!["c1".into()],
            doc_content_size: 20,
        }
    }

    #[test]
    fn saves_content_and_sidecars_in_one_bundle() {
        let db = test_db();
        let result = save_scene_body_bundle(&db, payload()).expect("save");
        assert_eq!(result.content_version, 1);
        assert_eq!(result.placed_beat_preview.as_deref(), Some("[\"beat\"]"));
        assert_eq!(result.db_transaction_count, 1);

        let rows = db
            .execute(
                "SELECT content, char_count, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load scene");
        assert_eq!(rows[0]["content"], "{\"type\":\"doc\"}");
        assert_eq!(rows[0]["char_count"], 12);
        assert_eq!(rows[0]["version"], 1);

        let span_count = db
            .execute(
                "SELECT count(*) AS count FROM authorship_spans WHERE node_id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load spans");
        assert_eq!(span_count[0]["count"], 1);
        let mention_count = db
            .execute(
                "SELECT count(*) AS count FROM scene_codex_mentions WHERE scene_id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load mentions");
        assert_eq!(mention_count[0]["count"], 1);

        let current_setup = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = 'setup-current'",
                &[],
                "get",
            )
            .expect("load current setup");
        assert_eq!(current_setup[0]["from_pos"], 2);
        assert_eq!(current_setup[0]["to_pos"], 5);
        assert_eq!(current_setup[0]["is_orphan"], 0);
        let stale_setup = db
            .execute(
                "SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-stale'",
                &[],
                "get",
            )
            .expect("load stale setup");
        assert_eq!(stale_setup[0]["is_orphan"], 1);

        let payoff = db
            .execute(
                "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos
                   FROM foreshadows WHERE id = 'f2'",
                &[],
                "get",
            )
            .expect("load payoff");
        assert_eq!(payoff[0]["payoff_scene_id"], "s1");
        assert_eq!(payoff[0]["payoff_from_pos"], 6);
        assert_eq!(payoff[0]["payoff_to_pos"], 9);

        let annotation = db
            .execute(
                "SELECT range_start, range_end, text_snapshot
                   FROM post_effect_annotations WHERE id = 'a1'",
                &[],
                "get",
            )
            .expect("load annotation");
        assert_eq!(annotation[0]["range_start"], 3);
        assert_eq!(annotation[0]["range_end"], 8);
        assert_eq!(annotation[0]["text_snapshot"], "updated");

        let mentions = db
            .execute(
                "SELECT codex_entry_id, role FROM scene_codex_mentions
                  WHERE scene_id = 's1' AND source = 'beat'",
                &[],
                "all",
            )
            .expect("load mentions");
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["codex_entry_id"], "c1");
        assert_eq!(mentions[0]["role"], "actor");
        let povs = db
            .execute(
                "SELECT pov_character_id FROM scene_beat_pov_cache WHERE scene_id = 's1'",
                &[],
                "all",
            )
            .expect("load POV cache");
        assert_eq!(povs.len(), 1);
        assert_eq!(povs[0]["pov_character_id"], "c1");
    }

    #[test]
    fn rejects_stale_base_version_without_mutating_content() {
        let db = test_db();
        let mut first = payload();
        first.base_version = Some(0);
        save_scene_body_bundle(&db, first).expect("first versioned save");

        let mut stale = payload();
        stale.base_version = Some(0);
        stale.content_json = "{\"stale\":true}".into();
        let error = save_scene_body_bundle(&db, stale).expect_err("stale save");
        assert!(error.to_string().contains("conflict"));

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "load after stale save",
            )
            .expect("load scene");
        assert_eq!(rows[0]["content"], "{\"type\":\"doc\"}");
        assert_eq!(rows[0]["version"], 1);
    }

    #[test]
    fn uses_renderer_timestamp_for_monotonic_content_tokens() {
        let db = test_db();
        let mut first = payload();
        first.include_sidecars = false;
        first.updated_at = "2026-07-28T00:00:00.000Z".into();
        save_scene_body_bundle(&db, first).expect("first save");

        let mut second = payload();
        second.include_sidecars = false;
        second.updated_at = "2026-07-28T00:00:00.001Z".into();
        let result = save_scene_body_bundle(&db, second).expect("second save");

        assert_eq!(result.content_updated_at, "2026-07-28T00:00:00.001Z");
        let rows = db
            .execute(
                "SELECT version, updated_at FROM tree_nodes WHERE id = 's1'",
                &[],
                "load timestamp token",
            )
            .expect("load timestamp token");
        assert_eq!(rows[0]["version"], 2);
        assert_eq!(rows[0]["updated_at"], "2026-07-28T00:00:00.001Z");
    }

    #[test]
    fn rejects_foreign_foreshadow_setup_without_mutating_scene() {
        let db = test_db();
        db.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other Project')",
            &[],
            "insert other project",
        )
        .expect("insert other project");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('f-foreign', 'p2', 'Foreign', 0, 0, 0, 1, 1)",
            &[],
            "insert foreign foreshadow",
        )
        .expect("insert foreign foreshadow");

        let mut foreign = payload();
        foreign.foreshadow_setups[0].foreshadow_id = "f-foreign".into();
        let error = save_scene_body_bundle(&db, foreign).expect_err("foreign setup");
        assert!(error.to_string().contains("not owned by project"));

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load after foreign setup",
            )
            .expect("load after foreign setup");
        assert_eq!(rows[0]["content"], "{\"old\":true}");
        assert_eq!(rows[0]["version"], 0);
    }

    #[test]
    fn rejects_setup_id_rebinding_without_mutating_existing_anchor() {
        let db = test_db();
        let mut rebinding = payload();
        rebinding.foreshadow_setups[0].id = "setup-stale".into();
        rebinding.foreshadow_setups[0].foreshadow_id = "f2".into();
        let error = save_scene_body_bundle(&db, rebinding).expect_err("setup rebinding");
        assert!(error.to_string().contains("different anchor"));

        let rows = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = 'setup-stale'",
                &[],
                "load after setup rebinding",
            )
            .expect("load after setup rebinding");
        assert_eq!(rows[0]["from_pos"], 0);
        assert_eq!(rows[0]["to_pos"], 1);
        assert_eq!(rows[0]["is_orphan"], 0);
    }

    #[test]
    fn rejects_foreign_foreshadow_payoff_without_mutating_scene() {
        let db = test_db();
        db.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other Project')",
            &[],
            "insert other project",
        )
        .expect("insert other project");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES ('f-foreign', 'p2', 'Foreign', 0, 0, 0, 1, 1)",
            &[],
            "insert foreign foreshadow",
        )
        .expect("insert foreign foreshadow");

        let mut foreign = payload();
        foreign.foreshadow_payoffs[0].foreshadow_id = "f-foreign".into();
        let error = save_scene_body_bundle(&db, foreign).expect_err("foreign payoff");
        assert!(error.to_string().contains("not owned by project"));

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = 's1'",
                &[],
                "load after foreign payoff",
            )
            .expect("load after foreign payoff");
        assert_eq!(rows[0]["content"], "{\"old\":true}");
        assert_eq!(rows[0]["version"], 0);
    }

    #[test]
    fn skips_sidecars_for_file_backed_content() {
        let db = test_db();
        let mut file_backed = payload();
        file_backed.include_sidecars = false;
        file_backed.content_json = "{\"external\":true}".into();
        let result = save_scene_body_bundle(&db, file_backed).expect("save external content");
        assert_eq!(result.db_transaction_count, 1);

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load scene");
        assert_eq!(rows[0]["content"], "{\"external\":true}");
        assert_eq!(rows[0]["version"], 1);
        let sidecars = db
            .execute(
                "SELECT
                    (SELECT source FROM authorship_spans WHERE id = 'old-span') AS source,
                    (SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-stale') AS is_orphan,
                    (SELECT text_snapshot FROM post_effect_annotations WHERE id = 'a1') AS annotation,
                    (SELECT codex_entry_id FROM scene_codex_mentions
                      WHERE scene_id = 's1' AND source = 'beat') AS mention,
                    (SELECT pov_character_id FROM scene_beat_pov_cache
                      WHERE scene_id = 's1') AS pov",
                &[],
                "get",
            )
            .expect("load untouched sidecars");
        assert_eq!(sidecars[0]["source"], "unknown");
        assert_eq!(sidecars[0]["is_orphan"], 0);
        assert_eq!(sidecars[0]["annotation"], "old");
        assert_eq!(sidecars[0]["mention"], "c2");
        assert_eq!(sidecars[0]["pov"], "c2");
    }

    #[test]
    fn deletes_live_annotations_whose_body_anchor_is_missing() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('live-a1', 'p1', 's1', 0, 3, '本文',
                         'pseudo_comment', 'ライブ', '{\"live\":true}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('manual-a1', 'p1', 's1', 0, 3, '本文',
                         'pseudo_comment', '手動疑似', '{\"live\":false}')",
                [],
            )?;
            Ok(())
        })
        .expect("insert live annotations");

        save_scene_body_bundle(&db, payload()).expect("save without live anchor");

        let rows = db
            .execute(
                "SELECT id FROM post_effect_annotations
                  WHERE scene_id = 's1' ORDER BY id",
                &[],
                "load annotations",
            )
            .expect("load annotations");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "a1");
        assert_eq!(rows[1]["id"], "manual-a1");
    }

    #[test]
    fn keeps_live_annotation_when_target_text_remains_without_body_mark() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('live-a1', 'p1', 's1', 0, 3, '本文',
                         'pseudo_comment', 'ライブ', '{\"live\":true}')",
                [],
            )?;
            Ok(())
        })
        .expect("insert live annotation");

        let mut payload = payload();
        payload.content_json =
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"本文"}]}]}"#
                .into();
        payload.annotation_anchors.clear();
        save_scene_body_bundle(&db, payload).expect("save without visible mark");

        let rows = db
            .execute(
                "SELECT id FROM post_effect_annotations WHERE id = 'live-a1'",
                &[],
                "load retained annotation",
            )
            .expect("load annotations");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn keeps_live_annotation_without_a_text_snapshot() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, scene_id, range_start, range_end,
                     text_snapshot, category, content, metadata)
                 VALUES ('live-a1', 'p1', 's1', 0, 0, NULL,
                         'pseudo_comment', 'シーン全体の感想', '{\"live\":true}')",
                [],
            )?;
            Ok(())
        })
        .expect("insert scene-level live annotation");

        save_scene_body_bundle(&db, payload()).expect("save scene-level annotation");

        let rows = db
            .execute(
                "SELECT id FROM post_effect_annotations WHERE id = 'live-a1'",
                &[],
                "load scene-level annotation",
            )
            .expect("load annotations");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn rolls_content_back_when_a_sidecar_insert_fails_after_update() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER force_authorship_failure
                   BEFORE INSERT ON authorship_spans
                   BEGIN
                     SELECT RAISE(ABORT, 'forced authorship failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");

        assert!(save_scene_body_bundle(&db, payload()).is_err());

        let rows = db
            .execute(
                "SELECT content, version FROM tree_nodes WHERE id = ?",
                &[Value::String("s1".into())],
                "get",
            )
            .expect("load rolled back scene");
        assert_eq!(rows[0]["content"], "{\"old\":true}");
        assert_eq!(rows[0]["version"], 0);
        let spans = db
            .execute(
                "SELECT id, source FROM authorship_spans WHERE node_id = 's1'",
                &[],
                "all",
            )
            .expect("load restored spans");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0]["id"], "old-span");
        assert_eq!(spans[0]["source"], "unknown");
    }
}
