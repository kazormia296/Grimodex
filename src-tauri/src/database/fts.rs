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

        // Sanitize the raw query into a safe FTS5 MATCH expression (commas / hyphens /
        // colons in a raw query are FTS5 operators and raise "syntax error" /
        // "no such column"). trigram can't match <3 codepoint tokens, so fall back to
        // LIKE when the query is short or no trigram-friendly token remains.
        let match_query = to_fts_match(query);
        let use_like = query.chars().count() < 3 || match_query.is_empty();
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
