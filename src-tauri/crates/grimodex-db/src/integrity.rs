use super::Database;

impl Database {
    pub fn integrity_check(&self) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut report = serde_json::Map::new();

        let orphaned_codex_sources: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entries WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
            |row| row.get(0),
        )?;
        report.insert("orphanedCodexSources".into(), orphaned_codex_sources.into());

        let orphaned_snippet_sources: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snippets WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
            |row| row.get(0),
        )?;
        report.insert(
            "orphanedSnippetSources".into(),
            orphaned_snippet_sources.into(),
        );

        let orphaned_snippet_scenes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snippets WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM tree_nodes)",
            [],
            |row| row.get(0),
        )?;
        report.insert(
            "orphanedSnippetScenes".into(),
            orphaned_snippet_scenes.into(),
        );

        Ok(report)
    }

    pub fn repair_integrity(&self) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut report = serde_json::Map::new();

        let codex_fixed = conn.execute(
            "UPDATE codex_entries SET source_chat_message_id = NULL WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
        )?;
        report.insert("codexSourcesFixed".into(), (codex_fixed as i64).into());

        let snippet_sources_fixed = conn.execute(
            "UPDATE snippets SET source_chat_message_id = NULL WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
        )?;
        report.insert(
            "snippetSourcesFixed".into(),
            (snippet_sources_fixed as i64).into(),
        );

        let snippet_scenes_fixed = conn.execute(
            "UPDATE snippets SET scene_id = NULL WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM tree_nodes)",
            [],
        )?;
        report.insert(
            "snippetScenesFixed".into(),
            (snippet_scenes_fixed as i64).into(),
        );

        Ok(report)
    }
}
