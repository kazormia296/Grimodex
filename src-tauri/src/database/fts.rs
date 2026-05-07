use rusqlite::params_from_iter;

use super::Database;

impl Database {
    pub fn fts_optimize(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "INSERT INTO codex_fts(codex_fts) VALUES('optimize');
             INSERT INTO snippets_fts(snippets_fts) VALUES('optimize');
             INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('optimize');
             INSERT INTO tree_nodes_fts(tree_nodes_fts) VALUES('optimize');",
        )?;
        Ok(())
    }

    /// Full-text search across scenes, codex, and snippets.
    /// `scope`: "all" | "scenes" | "codex" | "snippets"
    /// Returns up to `limit` results (capped at 50).
    pub fn search_fts(
        &self,
        project_id: &str,
        query: &str,
        scope: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut results: Vec<serde_json::Value> = Vec::new();
        let lim = limit.min(50) as i64;

        // FTS5 trigram requires ≥3 chars; fall back to LIKE for shorter queries.
        let use_like = query.chars().count() < 3;
        let like_pattern = format!("%{query}%");

        if scope == "all" || scope == "scenes" {
            if use_like {
                let mut stmt = conn.prepare(
                    "SELECT id, title, COALESCE(synopsis, '')
                     FROM tree_nodes
                     WHERE project_id = ?1 AND node_type = 'scene'
                       AND (title LIKE ?2 OR content LIKE ?2)
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
                let mut stmt = conn.prepare(
                    "SELECT tn.id, tn.title, COALESCE(tn.synopsis, '')
                     FROM tree_nodes_fts
                     JOIN tree_nodes tn ON tn.rowid = tree_nodes_fts.rowid
                     WHERE tree_nodes_fts MATCH ?1 AND tn.project_id = ?2 AND tn.node_type = 'scene'
                     ORDER BY rank LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params_from_iter([query, project_id, &lim.to_string()]),
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
                       AND (name LIKE ?2 OR aliases LIKE ?2 OR summary LIKE ?2)
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
                let mut stmt = conn.prepare(
                    "SELECT e.id, e.name, COALESCE(e.summary, '')
                     FROM codex_fts
                     JOIN codex_entries e ON e.rowid = codex_fts.rowid
                     WHERE codex_fts MATCH ?1 AND e.project_id = ?2
                     ORDER BY rank LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params_from_iter([query, project_id, &lim.to_string()]),
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
                     WHERE project_id = ?1 AND (title LIKE ?2 OR content LIKE ?2)
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
                let mut stmt = conn.prepare(
                    "SELECT s.id, s.title, COALESCE(s.tags_cache, '')
                     FROM snippets_fts
                     JOIN snippets s ON s.rowid = snippets_fts.rowid
                     WHERE snippets_fts MATCH ?1 AND s.project_id = ?2
                     ORDER BY rank LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params_from_iter([query, project_id, &lim.to_string()]),
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

        Ok(results)
    }

    pub fn fts_rebuild(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "INSERT INTO codex_fts(codex_fts) VALUES('rebuild');
             INSERT INTO snippets_fts(snippets_fts) VALUES('rebuild');
             INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild');
             INSERT INTO tree_nodes_fts(tree_nodes_fts) VALUES('rebuild');",
        )?;
        Ok(())
    }
}
