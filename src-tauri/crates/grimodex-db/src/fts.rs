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
    /// `scope`: "all" | "scenes" | "codex" | "snippets" | "chat"
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

        if scope == "all" || scope == "scenes" {
            if use_like {
                let mut stmt = conn.prepare(
                    "SELECT id, title, COALESCE(synopsis, '')
                     FROM tree_nodes
                     WHERE project_id = ?1 AND node_type = 'scene'
                       AND (title LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\')
                     LIMIT ?3",
                )?;
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
                let sql = format!(
                    "SELECT tn.id, tn.title, COALESCE(tn.synopsis, '')
                     FROM {fts}
                     JOIN tree_nodes tn ON tn.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND tn.project_id = ?2 AND tn.node_type = 'scene'
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
                       AND (name LIKE ?2 ESCAPE '\\' OR aliases LIKE ?2 ESCAPE '\\' OR summary LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\')
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
                     WHERE project_id = ?1 AND (title LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\')
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
    use super::to_fts_match;

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
}
