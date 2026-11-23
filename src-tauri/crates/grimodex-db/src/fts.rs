use rusqlite::params_from_iter;
use rusqlite::Connection;

use super::Database;

impl Database {
    pub fn fts_optimize(&self) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute_batch(
            "INSERT INTO codex_fts(codex_fts) VALUES('optimize');
             INSERT INTO snippets_fts(snippets_fts) VALUES('optimize');
             INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('optimize');
             INSERT INTO tree_nodes_fts(tree_nodes_fts) VALUES('optimize');
             INSERT INTO codex_fts_en(codex_fts_en) VALUES('optimize');
             INSERT INTO snippets_fts_en(snippets_fts_en) VALUES('optimize');
             INSERT INTO chat_messages_fts_en(chat_messages_fts_en) VALUES('optimize');
             INSERT INTO tree_nodes_fts_en(tree_nodes_fts_en) VALUES('optimize');
             INSERT INTO post_effect_annotations_fts(post_effect_annotations_fts) VALUES('optimize');
             INSERT INTO post_effect_annotations_fts_en(post_effect_annotations_fts_en) VALUES('optimize');",
        )?;
        Ok(())
    }

    /// Full-text search across scenes, codex, and snippets.
    /// `scope`: "all" | "scenes" | "scenes_live" | "codex" | "snippets" | "chat" | "chat_history"
    /// "scenes_live" は "scenes" と同じ検索で、`archived_at` が付いた場面だけを SQL の
    /// WHERE で除く（`LIMIT` の前に効くので、archived が rank の上位でも live の上位
    /// `limit` 件が返る）。core の `search_scenes` だけが使う。"scenes" と "all" は
    /// archived の場面も返したまま（他の呼び手の結果を変えない）。"all" に
    /// "scenes_live" は含めない。行単位（場面自身の `archived_at` だけを見る。祖先の
    /// folder は見ない）。不明な scope は error でなく空の list（従来どおり）。
    /// "chat" は episodic recall (chat hybrid) の sparse 腕専用で "all" には含めない
    /// (コマンドセンター検索の挙動を変えない)。`id` は message_id。
    /// Returns up to `limit` results (capped at 50).
    pub fn search_fts(
        &self,
        project_id: &str,
        query: &str,
        scope: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = self.lock_conn()?;
        let mut results: Vec<serde_json::Value> = Vec::new();
        let lim = limit.min(50) as i64;

        // Sanitize the raw query into a safe FTS5 MATCH expression (commas / hyphens /
        // colons in a raw query are FTS5 operators and raise "syntax error" /
        // "no such column"). trigram can't match <3 codepoint tokens, so fall back to
        // LIKE when the query is short or no trigram-friendly token remains.
        let match_query = to_fts_match(query);
        let use_like = query.chars().count() < 3 || match_query.is_empty();
        // Escape LIKE metacharacters so a query containing % or _ matches them
        // literally instead of as wildcards (paired with `ESCAPE '\'` in the
        // fallback LIKE clauses below). Backslash first so we don't double-escape.
        let like_escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let like_pattern = format!("%{like_escaped}%");

        let is_en: bool = conn
            .query_row(
                "SELECT language LIKE 'en%' FROM projects WHERE id = ?1",
                [project_id],
                |r| r.get(0),
            )
            .unwrap_or(false);

        if scope == "all" || scope == "scenes" || scope == "scenes_live" {
            // scenes_live だけが archived の場面を SQL で除く。条件は WHERE に入れる
            // （`LIMIT` の前に効く）。LIKE の arm・FTS の arm（ja／en の両表）の全部に入れる。
            let live_only = scope == "scenes_live";
            if use_like {
                let live_condition = if live_only {
                    " AND archived_at IS NULL"
                } else {
                    ""
                };
                let mut stmt = conn.prepare(&format!(
                    "SELECT id, title, COALESCE(synopsis, '')
                     FROM tree_nodes
                     WHERE project_id = ?1 AND node_type = 'scene'{live_condition}
                       AND (title LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\')
                     LIMIT ?3"
                ))?;
                let rows = stmt.query_map(
                    params_from_iter([project_id, like_pattern.as_str(), &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "scene",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            } else {
                let fts = if is_en {
                    "tree_nodes_fts_en"
                } else {
                    "tree_nodes_fts"
                };
                let live_condition = if live_only {
                    " AND tn.archived_at IS NULL"
                } else {
                    ""
                };
                let sql = format!(
                    "SELECT tn.id, tn.title, COALESCE(tn.synopsis, '')
                     FROM {fts}
                     JOIN tree_nodes tn ON tn.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND tn.project_id = ?2 AND tn.node_type = 'scene'{live_condition}
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "scene",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
        }

        if scope == "all" || scope == "codex" {
            if use_like {
                let mut stmt = conn.prepare(
                    "SELECT id, name, COALESCE(summary, '')
                     FROM codex_entries
                     WHERE project_id = ?1
                       AND (name LIKE ?2 ESCAPE '\\' OR aliases LIKE ?2 ESCAPE '\\' OR summary LIKE ?2 ESCAPE '\\' OR tags_cache LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\')
                     LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params_from_iter([project_id, like_pattern.as_str(), &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "codex",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            } else {
                let fts = if is_en { "codex_fts_en" } else { "codex_fts" };
                let sql = format!(
                    "SELECT e.id, e.name, COALESCE(e.summary, '')
                     FROM {fts}
                     JOIN codex_entries e ON e.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND e.project_id = ?2
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "codex",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
        }

        if scope == "all" || scope == "snippets" {
            if use_like {
                let mut stmt = conn.prepare(
                    "SELECT id, title, COALESCE(tags_cache, '')
                     FROM snippets
                     WHERE project_id = ?1 AND (title LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\' OR tags_cache LIKE ?2 ESCAPE '\\')
                     LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params_from_iter([project_id, like_pattern.as_str(), &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "snippet",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            } else {
                let fts = if is_en {
                    "snippets_fts_en"
                } else {
                    "snippets_fts"
                };
                let sql = format!(
                    "SELECT s.id, s.title, COALESCE(s.tags_cache, '')
                     FROM {fts}
                     JOIN snippets s ON s.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND s.project_id = ?2
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "snippet",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
        }

        // Chat history panel search. Unlike episodic recall's compact `chat`
        // rows, this read model carries session metadata and an FTS-highlighted
        // excerpt so the renderer never needs the generic SQL bridge.
        if scope == "chat_history" {
            let fts = if is_en {
                "chat_messages_fts_en"
            } else {
                "chat_messages_fts"
            };
            let sql = format!(
                "SELECT
                    m.id AS msg_id,
                    m.session_id,
                    s.title AS session_title,
                    s.node_id,
                    s.codex_anchor_id,
                    s.snippet_anchor_id,
                    m.role,
                    m.content,
                    snippet({fts}, 0, char(1), char(2), '...', 20)
                        AS highlighted_content,
                    m.created_at,
                    s.updated_at AS session_updated_at
                 FROM {fts}
                 JOIN chat_messages m ON m.rowid = {fts}.rowid
                 JOIN chat_sessions s ON m.session_id = s.id
                 WHERE {fts} MATCH ?1
                   AND s.project_id = ?2
                   AND m.role != 'system'
                 ORDER BY rank
                 LIMIT ?3"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                |row| {
                    Ok(serde_json::json!({
                        "msg_id": row.get::<_, String>(0)?,
                        "session_id": row.get::<_, String>(1)?,
                        "session_title": row.get::<_, String>(2)?,
                        "node_id": row.get::<_, Option<String>>(3)?,
                        "codex_anchor_id": row.get::<_, Option<String>>(4)?,
                        "snippet_anchor_id": row.get::<_, Option<String>>(5)?,
                        "role": row.get::<_, String>(6)?,
                        "content": row.get::<_, String>(7)?,
                        "highlighted_content": row.get::<_, String>(8)?,
                        "created_at": row.get::<_, String>(9)?,
                        "session_updated_at": row.get::<_, String>(10)?,
                    }))
                },
            )?;
            for row in rows {
                results.push(row?);
            }
        }

        // chat scope (episodic recall の sparse 腕)。"all" には含めない。
        // chat_messages_fts は content=chat_messages なので rowid で本体 JOIN し、
        // project スコープと role 絞り込み (user/assistant) を chat_messages 側で効かせる。
        if scope == "chat" {
            if use_like {
                let mut stmt = conn.prepare(
                    "SELECT cm.id, cm.role, substr(cm.content, 1, 80)
                     FROM chat_messages cm
                     JOIN chat_sessions cs ON cs.id = cm.session_id
                     WHERE cs.project_id = ?1
                       AND cm.role IN ('user', 'assistant')
                       AND cm.content LIKE ?2 ESCAPE '\\'
                     LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params_from_iter([project_id, like_pattern.as_str(), &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "chat",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            } else {
                let fts = if is_en {
                    "chat_messages_fts_en"
                } else {
                    "chat_messages_fts"
                };
                let sql = format!(
                    "SELECT cm.id, cm.role, substr(cm.content, 1, 80)
                     FROM {fts}
                     JOIN chat_messages cm ON cm.rowid = {fts}.rowid
                     JOIN chat_sessions cs ON cs.id = cm.session_id
                     WHERE {fts} MATCH ?1 AND cs.project_id = ?2
                       AND cm.role IN ('user', 'assistant')
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "chat",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
        }

        Ok(results)
    }

    pub fn fts_rebuild(&self) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute_batch(
            "INSERT INTO codex_fts(codex_fts) VALUES('rebuild');
             INSERT INTO snippets_fts(snippets_fts) VALUES('rebuild');
             INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild');
             INSERT INTO tree_nodes_fts(tree_nodes_fts) VALUES('rebuild');
             INSERT INTO post_effect_annotations_fts(post_effect_annotations_fts) VALUES('rebuild');",
        )?;
        rebuild_en_fts_sql(&conn)?;
        Ok(())
    }

    /// slim バックアップ（FTS 索引を空にして容量削減、backup restore Phase 3）を復元した
    /// DB を検知して `fts_rebuild` する（＋マーカーを消す）。slim 側は `app_settings` に
    /// `fts.slim_backup='1'` を書き込むので、それを見て rebuild する。`restore_backup` の
    /// happy path でも、`RESTORE_SESSION_LOST` 経由の再オープンや手動でのバックアップ昇格
    /// でも `open_workspace` から呼べば全経路で自己修復する（external content FTS は索引が
    /// 空でも MATCH がエラーにならず 0 件を返すため、マーカーが唯一の確実な検知手段。
    /// `SELECT`/`count(*)` は content 表を読むので空判定に使えない）。通常 DB は
    /// マーカーが無いので単一の scalar query だけで no-op。
    pub fn rebuild_fts_if_stale(&self) -> anyhow::Result<()> {
        let pending: bool = self.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key='fts.slim_backup' AND value='1')",
                [],
                |r| r.get(0),
            )?)
        })?;
        if pending {
            tracing::info!("open: slim backup restore detected — rebuilding FTS index");
            self.fts_rebuild()?;
            self.with_conn(|conn| {
                conn.execute("DELETE FROM app_settings WHERE key='fts.slim_backup'", [])?;
                Ok(())
            })?;
        }
        Ok(())
    }

    /// Rebuild all `_en` FTS tables from English-project content. Used on a
    /// project language change and as a manual repair.
    pub fn rebuild_en_fts(&self) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        rebuild_en_fts_sql(&conn)?;
        Ok(())
    }
}

/// Convert a raw user search string into a safe FTS5 MATCH expression.
///
/// Each token is wrapped in double quotes (an FTS5 string literal) so that `,`,
/// `-`, `:`, parentheses, etc. are not parsed as FTS5 query operators / column
/// filters. Tokens are joined with `OR` (natural-language AND tends to miss).
/// trigram can't match tokens shorter than 3 codepoints, so those are dropped;
/// if nothing remains the result is empty (the caller falls back to LIKE).
///
/// Keep in sync with `toFtsMatchQuery` in `src/lib/fts.ts`.
fn to_fts_match(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|t| t.chars().count() >= 3)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Repopulate every `_en` FTS table from scratch, restricted to English
/// projects (`projects.language LIKE 'en%'`). `_en` tables are non-external,
/// so a plain `DELETE FROM` + filtered `INSERT ... SELECT` is correct and the
/// FTS5 `('rebuild')` external-content footgun does not apply.
pub fn rebuild_en_fts_sql(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM codex_fts_en;
         INSERT INTO codex_fts_en(rowid, name, aliases, summary, tags_cache, content)
           SELECT rowid, COALESCE(name,''), COALESCE(aliases,''), COALESCE(summary,''), COALESCE(tags_cache,''), COALESCE(content,'')
           FROM codex_entries
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM snippets_fts_en;
         INSERT INTO snippets_fts_en(rowid, title, content, tags_cache)
           SELECT rowid, COALESCE(title,''), COALESCE(content,''), COALESCE(tags_cache,'')
           FROM snippets
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM tree_nodes_fts_en;
         INSERT INTO tree_nodes_fts_en(rowid, title, content)
           SELECT rowid, COALESCE(title,''), COALESCE(content,'')
           FROM tree_nodes
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM post_effect_annotations_fts_en;
         INSERT INTO post_effect_annotations_fts_en(rowid, content)
           SELECT rowid, COALESCE(content,'')
           FROM post_effect_annotations
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM chat_messages_fts_en;
         INSERT INTO chat_messages_fts_en(rowid, content)
           SELECT rowid, COALESCE(content,'')
           FROM chat_messages
           WHERE session_id IN (
             SELECT id FROM chat_sessions
             WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%')
           );",
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{to_fts_match, Database};

    #[test]
    fn quotes_tokens_and_joins_with_or() {
        assert_eq!(to_fts_match("iron crown"), "\"iron\" OR \"crown\"");
    }

    #[test]
    fn neutralizes_fts5_operators() {
        // Commas / hyphens that used to raise "syntax error" / "no such column"
        // now become a valid quoted-token expression.
        assert_eq!(
            to_fts_match("come back, with a final"),
            "\"come\" OR \"back,\" OR \"with\" OR \"final\"",
        );
        assert_eq!(
            to_fts_match("the keeping-room door"),
            "\"the\" OR \"keeping-room\" OR \"door\"",
        );
    }

    #[test]
    fn drops_tokens_shorter_than_three_codepoints() {
        assert_eq!(to_fts_match("a of in"), "");
        assert_eq!(to_fts_match("a lock"), "\"lock\"");
    }

    #[test]
    fn escapes_embedded_double_quotes() {
        assert_eq!(to_fts_match("say \"hi\""), "\"say\" OR \"\"\"hi\"\"\"");
    }

    #[test]
    fn chat_history_search_is_project_scoped_and_excludes_system_messages() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title, language, created_at, updated_at)
                   VALUES ('other-project', 'Other', 'ja', '2025-01-01', '2025-01-01');
                 INSERT INTO chat_sessions
                   (id, project_id, title, created_at, updated_at)
                   VALUES
                   ('session-local', 'default-project', 'Local chat', '2025-01-01', '2025-01-02'),
                   ('session-other', 'other-project', 'Other chat', '2025-01-01', '2025-01-02');
                 INSERT INTO chat_messages
                   (id, session_id, role, content, created_at)
                   VALUES
                   ('message-local', 'session-local', 'user', 'The moonstone opened the gate.', '2025-01-01'),
                   ('message-system', 'session-local', 'system', 'moonstone system prompt', '2025-01-01'),
                   ('message-other', 'session-other', 'assistant', 'moonstone from another project', '2025-01-01');",
            )?;
            Ok(())
        })
        .expect("seed chat history");

        let rows = db
            .search_fts("default-project", "moonstone", "chat_history", 50)
            .expect("search chat history");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["msg_id"], "message-local");
        assert_eq!(rows[0]["session_id"], "session-local");
        assert_eq!(rows[0]["session_title"], "Local chat");
        assert_eq!(rows[0]["role"], "user");
        assert_eq!(rows[0]["content"], "The moonstone opened the gate.");
        assert_eq!(rows[0]["session_updated_at"], "2025-01-02");
        assert_eq!(rows[0]["node_id"], serde_json::Value::Null);
        assert_eq!(rows[0]["codex_anchor_id"], serde_json::Value::Null);
        assert_eq!(rows[0]["snippet_anchor_id"], serde_json::Value::Null);
        assert!(
            rows[0]["highlighted_content"]
                .as_str()
                .is_some_and(|content| content.contains('\u{1}') && content.contains('\u{2}')),
            "the read model should preserve FTS highlight markers",
        );
    }

    /// 場面の検索の fixture。project `lp`（language は引数）に、archived の場面 3 件と
    /// live の場面 2 件を同じ語で置く。archived を rank の上位（語が多く本文が短い）に、
    /// live を下位（語が 1 回で本文が長い）にして、`LIMIT` が archived で埋まる形にする。
    /// 別の project `other` にも同じ語の場面を 1 件置く（project の分離の確認）。
    fn seed_scene_search(db: &Database, language: &str, word: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language, created_at, updated_at)
                   VALUES ('lp', 'Live', ?1, '2025-01-01', '2025-01-01'),
                          ('other', 'Other', ?1, '2025-01-01', '2025-01-01')",
                [language],
            )?;
            let filler = "padding ".repeat(40);
            for (id, project, content) in [
                ("arch-1", "lp", format!("{word} {word} {word}")),
                ("arch-2", "lp", format!("{word} {word}")),
                ("arch-3", "lp", format!("{word} {word} {word} {word}")),
                ("live-1", "lp", format!("{word} {filler}")),
                ("live-2", "lp", format!("{filler} {word} {filler}")),
                ("other-1", "other", format!("{word} {word} {word}")),
            ] {
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                       VALUES (?1, ?2, 'scene', ?1, ?3)",
                    rusqlite::params![id, project, content],
                )?;
            }
            conn.execute(
                "UPDATE tree_nodes SET archived_at = '2026-01-01T00:00:00Z'
                   WHERE id IN ('arch-1', 'arch-2', 'arch-3')",
                [],
            )?;
            Ok(())
        })
        .expect("seed scenes");
    }

    fn ids(rows: &[serde_json::Value]) -> Vec<String> {
        rows.iter()
            .map(|row| row["id"].as_str().expect("id").to_string())
            .collect()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    // 特性試験（scope = scenes・all は archived の場面も返す。この PR は変えない）。

    #[test]
    fn scenes_scope_returns_archived_scenes_on_the_fts_arm() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        let rows = db
            .search_fts("lp", "lighthouse", "scenes", 50)
            .expect("search scenes");
        assert_eq!(
            sorted(ids(&rows)),
            ["arch-1", "arch-2", "arch-3", "live-1", "live-2"],
        );
    }

    #[test]
    fn scenes_scope_returns_archived_scenes_on_the_like_arm() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        // 3 codepoint 未満の語は LIKE の arm に落ちる。
        seed_scene_search(&db, "ja", "灯台");
        let rows = db
            .search_fts("lp", "灯台", "scenes", 50)
            .expect("search scenes");
        assert_eq!(
            sorted(ids(&rows)),
            ["arch-1", "arch-2", "arch-3", "live-1", "live-2"],
        );
    }

    #[test]
    fn scenes_scope_returns_archived_scenes_on_the_en_fts_arm() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "en", "lighthouse");
        let rows = db
            .search_fts("lp", "lighthouse", "scenes", 50)
            .expect("search scenes");
        assert_eq!(
            sorted(ids(&rows)),
            ["arch-1", "arch-2", "arch-3", "live-1", "live-2"],
        );
    }

    #[test]
    fn scenes_scope_limit_is_filled_by_archived_scenes_that_rank_above_live_ones() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        let rows = db
            .search_fts("lp", "lighthouse", "scenes", 2)
            .expect("search scenes");
        // archived の 3 件が rank の上位で、LIMIT 2 は archived だけで埋まる（live は 0 件）。
        assert_eq!(rows.len(), 2);
        assert!(
            ids(&rows).iter().all(|id| id.starts_with("arch-")),
            "{:?}",
            ids(&rows),
        );
    }

    #[test]
    fn all_scope_returns_archived_scenes() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        let rows = db
            .search_fts("lp", "lighthouse", "all", 50)
            .expect("search all");
        assert_eq!(
            sorted(ids(&rows)),
            ["arch-1", "arch-2", "arch-3", "live-1", "live-2"],
        );
    }

    #[test]
    fn an_unknown_scope_answers_an_empty_list_not_an_error() {
        // 不明な scope を拒む分岐は無い（他の呼び手の前提。scenes_live の綴りの違いは
        // 空の結果になる）。この PR は変えない。
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        let rows = db
            .search_fts("lp", "lighthouse", "scenes_liv", 50)
            .expect("search unknown scope");
        assert!(rows.is_empty());
    }

    // scenes_live：archived の場面だけを SQL で除く（LIMIT の前）。

    fn live_ids(db: &Database, query: &str, limit: u32) -> Vec<String> {
        ids(&db
            .search_fts("lp", query, "scenes_live", limit)
            .expect("search scenes_live"))
    }

    #[test]
    fn scenes_live_drops_archived_scenes_on_the_fts_arm() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        assert_eq!(
            sorted(live_ids(&db, "lighthouse", 50)),
            ["live-1", "live-2"]
        );
    }

    #[test]
    fn scenes_live_drops_archived_scenes_on_the_like_arm() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "灯台");
        assert_eq!(sorted(live_ids(&db, "灯台", 50)), ["live-1", "live-2"]);
    }

    #[test]
    fn scenes_live_drops_archived_scenes_on_the_en_fts_arm() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "en", "lighthouse");
        assert_eq!(
            sorted(live_ids(&db, "lighthouse", 50)),
            ["live-1", "live-2"]
        );
    }

    #[test]
    fn scenes_live_limit_takes_the_top_live_scenes_when_archived_ones_rank_above() {
        // archived の 3 件が rank の上位。LIMIT が archived を除く前に効くと live は 0 件に
        // なる。除いた後に効くので live の上位 2 件が返る。FTS の arm の ja・en の両表と、
        // LIKE の arm（rank が無い。rowid の順で archived が先に並ぶ形）で確かめる。
        for (language, word) in [("ja", "lighthouse"), ("en", "lighthouse"), ("ja", "灯台")] {
            let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
            db.migrate().expect("migrate");
            seed_scene_search(&db, language, word);
            assert_eq!(
                sorted(live_ids(&db, word, 2)),
                ["live-1", "live-2"],
                "{language} {word}",
            );
            assert_eq!(live_ids(&db, word, 1).len(), 1, "{language} {word}");
        }
    }

    #[test]
    fn scenes_live_ranks_the_live_scenes_in_the_same_order_as_scenes() {
        // live の中の順は scenes と同じ（絞りは順を変えない）。
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        let all_scenes = ids(&db
            .search_fts("lp", "lighthouse", "scenes", 50)
            .expect("search scenes"));
        let expected: Vec<String> = all_scenes
            .into_iter()
            .filter(|id| id.starts_with("live-"))
            .collect();
        assert_eq!(live_ids(&db, "lighthouse", 50), expected);
    }

    #[test]
    fn scenes_live_keeps_projects_apart() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        let live = live_ids(&db, "lighthouse", 50);
        assert!(!live.iter().any(|id| id == "other-1"));
        let other = ids(&db
            .search_fts("other", "lighthouse", "scenes_live", 50)
            .expect("search other"));
        assert_eq!(other, ["other-1"]);
    }

    #[test]
    fn scenes_live_keeps_a_live_scene_under_an_archived_folder() {
        // 行単位：場面自身の archived_at だけを見る。祖先の folder が archived でも、
        // 場面が live なら出る（core の search_scenes と同じ）。
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, archived_at)
                   VALUES ('folder-a', 'lp', 'folder', 'Folder', '2026-01-01T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "UPDATE tree_nodes SET parent_id = 'folder-a' WHERE id = 'live-1'",
                [],
            )?;
            Ok(())
        })
        .expect("move live-1 under an archived folder");
        assert_eq!(
            sorted(live_ids(&db, "lighthouse", 50)),
            ["live-1", "live-2"]
        );
    }

    #[test]
    fn scenes_and_all_stay_unchanged_after_scenes_live_exists() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        seed_scene_search(&db, "ja", "lighthouse");
        for scope in ["scenes", "all"] {
            let rows = db
                .search_fts("lp", "lighthouse", scope, 50)
                .expect("search");
            assert_eq!(
                sorted(ids(&rows)),
                ["arch-1", "arch-2", "arch-3", "live-1", "live-2"],
                "{scope}",
            );
        }
    }

    #[test]
    fn short_codex_and_snippet_search_preserves_tags_cache_matches() {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO codex_entries
                   (id, project_id, type, name, tags_cache)
                   VALUES
                   ('tagged-codex', 'default-project', 'character', 'Name', '[{\"name\":\"狐\"}]');
                 INSERT INTO snippets
                   (id, project_id, title, content, tags_cache)
                   VALUES
                   ('tagged-snippet', 'default-project', 'Title', '{}', '[{\"name\":\"星\"}]');",
            )?;
            Ok(())
        })
        .expect("seed tagged rows");

        let codex = db
            .search_fts("default-project", "狐", "codex", 50)
            .expect("search codex tag");
        let snippets = db
            .search_fts("default-project", "星", "snippets", 50)
            .expect("search snippet tag");

        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0]["id"], "tagged-codex");
        assert_eq!(snippets.len(), 1);
        assert_eq!(snippets[0]["id"], "tagged-snippet");
    }
}
