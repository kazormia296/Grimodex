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

fn validate_payload(payload: &SaveSceneBodyBundlePayload) -> anyhow::Result<()> {
    if payload.scene_id.is_empty() || payload.project_id.is_empty() {
        anyhow::bail!("sceneId and projectId must not be empty");
    }
    if payload.char_count < 0 || payload.doc_content_size < 0 {
        anyhow::bail!("scene document sizes must be non-negative");
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
            let updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
                  RETURNING version, updated_at",
                    params![
                        payload.content_json,
                        payload.unplaced_beats_doc,
                        payload.char_count,
                        payload.placed_beat_preview,
                        payload.unplaced_beat_preview,
                        updated_at,
                        payload.scene_id,
                        payload.project_id,
                    ],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "scene not found in project: {} / {}",
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
                        "SELECT EXISTS(SELECT 1 FROM foreshadows WHERE id = ?1)",
                        params![setup.foreshadow_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        continue;
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
                    conn.execute(
                        "UPDATE foreshadows
                            SET payoff_scene_id = ?1,
                                payoff_from_pos = ?2,
                                payoff_to_pos = ?3,
                                updated_at = ?4
                          WHERE id = ?5",
                        params![
                            payload.scene_id,
                            payoff.from_pos,
                            payoff.to_pos,
                            now_ms,
                            payoff.foreshadow_id,
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
