use rusqlite::{params_from_iter, Connection};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn migrate(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL DEFAULT 'Untitled Project',
                genre           TEXT,
                pov             TEXT,
                tense           TEXT,
                language        TEXT NOT NULL DEFAULT 'ja',
                style_guide     TEXT,
                ai_instructions TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS tree_nodes (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                node_type   TEXT NOT NULL,
                title       TEXT NOT NULL DEFAULT 'Untitled',
                sort_order  REAL NOT NULL DEFAULT 0.0,
                status      TEXT DEFAULT 'outline',
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_tree_parent
                ON tree_nodes(project_id, parent_id, sort_order);

            CREATE TABLE IF NOT EXISTS codex_types (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                slug        TEXT NOT NULL,
                label       TEXT NOT NULL,
                color       TEXT NOT NULL DEFAULT '#888888',
                icon        TEXT,
                file_prefix TEXT NOT NULL,
                is_builtin  INTEGER NOT NULL DEFAULT 0,
                sort_order  REAL NOT NULL DEFAULT 0.0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, slug),
                UNIQUE(project_id, file_prefix)
            );
            CREATE INDEX IF NOT EXISTS idx_codex_types_project
                ON codex_types(project_id);

            CREATE TABLE IF NOT EXISTS codex_entries (
                id                      TEXT PRIMARY KEY,
                project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id               TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                type                    TEXT NOT NULL DEFAULT 'character',
                name                    TEXT NOT NULL DEFAULT 'Untitled',
                aliases                 TEXT,
                excluded_aliases        TEXT,
                summary                 TEXT,
                tags_cache              TEXT,
                context_mode            TEXT NOT NULL DEFAULT 'mentioned'
                                          CHECK(context_mode IN ('always', 'mentioned', 'suppress', 'hidden')),
                source_chat_message_id  TEXT,
                created_at              TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_codex_project
                ON codex_entries(project_id, type);
            CREATE INDEX IF NOT EXISTS idx_codex_name
                ON codex_entries(project_id, name);
            CREATE INDEX IF NOT EXISTS idx_codex_parent
                ON codex_entries(parent_id);

            CREATE TABLE IF NOT EXISTS codex_relation_dismissed (
                entry_id     TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                PRIMARY KEY (entry_id, dismissed_id)
            );

            CREATE TABLE IF NOT EXISTS codex_tags (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                color       TEXT,
                type_filter TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_codex_tags_project
                ON codex_tags(project_id);

            CREATE TABLE IF NOT EXISTS codex_entry_tags (
                entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                tag_id   TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
                PRIMARY KEY (entry_id, tag_id)
            );
            CREATE INDEX IF NOT EXISTS idx_codex_entry_tags_tag
                ON codex_entry_tags(tag_id);

            CREATE TABLE IF NOT EXISTS codex_detail_definitions (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                type_slug         TEXT NOT NULL,
                name              TEXT NOT NULL,
                field_type        TEXT NOT NULL DEFAULT 'text',
                field_config      TEXT,
                sort_order        REAL NOT NULL DEFAULT 0.0,
                include_in_context INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, type_slug, name)
            );
            CREATE INDEX IF NOT EXISTS idx_codex_detail_defs
                ON codex_detail_definitions(project_id, type_slug, sort_order);

            CREATE TABLE IF NOT EXISTS codex_detail_values (
                id            TEXT PRIMARY KEY,
                entry_id      TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
                value         TEXT,
                UNIQUE(entry_id, definition_id)
            );
            CREATE INDEX IF NOT EXISTS idx_codex_detail_values_entry
                ON codex_detail_values(entry_id);
            CREATE INDEX IF NOT EXISTS idx_codex_detail_values_def
                ON codex_detail_values(definition_id);

            CREATE TABLE IF NOT EXISTS snippets (
                id                      TEXT PRIMARY KEY,
                project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title                   TEXT NOT NULL DEFAULT 'Untitled',
                content                 TEXT NOT NULL DEFAULT '',
                tags                    TEXT,
                scene_id                TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                source_chat_message_id  TEXT,
                usage_count             INTEGER NOT NULL DEFAULT 0,
                created_at              TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_snippets_project
                ON snippets(project_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS chat_sessions (
                id           TEXT PRIMARY KEY,
                project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_id      TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                title        TEXT NOT NULL DEFAULT 'New session',
                title_manual INTEGER NOT NULL DEFAULT 0,
                model        TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
                pinned_codex TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_node
                ON chat_sessions(project_id, node_id);

            CREATE TABLE IF NOT EXISTS chat_messages (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content     TEXT NOT NULL,
                model       TEXT,
                tokens_in   INTEGER,
                tokens_out  INTEGER,
                duration_ms INTEGER,
                metadata    TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session
                ON chat_messages(session_id, created_at);

            CREATE TABLE IF NOT EXISTS authorship_spans (
                id          TEXT PRIMARY KEY,
                node_id     TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                from_pos    INTEGER NOT NULL,
                to_pos      INTEGER NOT NULL,
                source      TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
                model       TEXT,
                timestamp   TEXT,
                chat_msg_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_authorship_node
                ON authorship_spans(node_id, source);

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- FTS5 full-text search indexes (trigram tokenizer for Japanese)
            CREATE VIRTUAL TABLE IF NOT EXISTS codex_fts USING fts5(
                name, aliases, summary, tags_cache,
                content=codex_entries, content_rowid=rowid,
                tokenize='trigram'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
                title, content, tags,
                content=snippets, content_rowid=rowid,
                tokenize='trigram'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
                content,
                content=chat_messages, content_rowid=rowid,
                tokenize='trigram'
            );

            -- Triggers to keep FTS indexes in sync: codex_entries
            CREATE TRIGGER IF NOT EXISTS codex_fts_ai AFTER INSERT ON codex_entries BEGIN
                INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
                VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS codex_fts_ad AFTER DELETE ON codex_entries BEGIN
                INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
                VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS codex_fts_au AFTER UPDATE ON codex_entries BEGIN
                INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
                VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''));
                INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
                VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''));
            END;

            -- Triggers to keep FTS indexes in sync: snippets
            CREATE TRIGGER IF NOT EXISTS snippets_fts_ai AFTER INSERT ON snippets BEGIN
                INSERT INTO snippets_fts(rowid, title, content, tags)
                VALUES (new.rowid, new.title, new.content, COALESCE(new.tags, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS snippets_fts_ad AFTER DELETE ON snippets BEGIN
                INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
                VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS snippets_fts_au AFTER UPDATE ON snippets BEGIN
                INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
                VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags, ''));
                INSERT INTO snippets_fts(rowid, title, content, tags)
                VALUES (new.rowid, new.title, new.content, COALESCE(new.tags, ''));
            END;

            -- Triggers to keep FTS indexes in sync: chat_messages
            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
                INSERT INTO chat_messages_fts(rowid, content)
                VALUES (new.rowid, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
                INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN
                INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
                INSERT INTO chat_messages_fts(rowid, content)
                VALUES (new.rowid, new.content);
            END;

            -- Triggers to nullify orphaned references on deletion
            CREATE TRIGGER IF NOT EXISTS nullify_codex_source_on_msg_delete
            AFTER DELETE ON chat_messages BEGIN
                UPDATE codex_entries SET source_chat_message_id = NULL
                WHERE source_chat_message_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS nullify_snippet_source_on_msg_delete
            AFTER DELETE ON chat_messages BEGIN
                UPDATE snippets SET source_chat_message_id = NULL
                WHERE source_chat_message_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS nullify_snippet_scene_on_node_delete
            AFTER DELETE ON tree_nodes BEGIN
                UPDATE snippets SET scene_id = NULL
                WHERE scene_id = old.id;
            END;

            -- Seed default project + chapter node
            INSERT OR IGNORE INTO projects (id, title, language, created_at, updated_at)
              VALUES ('default-project', '無題のプロジェクト', 'ja', datetime('now'), datetime('now'));
            INSERT OR IGNORE INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at)
              VALUES ('default-chapter', 'default-project', 'chapter', '第1章', 0.0, datetime('now'), datetime('now'));

            -- Seed built-in codex types for default project
            INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, file_prefix, is_builtin, sort_order, created_at)
              VALUES ('builtin-character', 'default-project', 'character', 'キャラクター', '#534AB7', 'char', 1, 0.0, datetime('now'));
            INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, file_prefix, is_builtin, sort_order, created_at)
              VALUES ('builtin-location', 'default-project', 'location', '場所', '#0F6E56', 'loc', 1, 1.0, datetime('now'));
            INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, file_prefix, is_builtin, sort_order, created_at)
              VALUES ('builtin-item', 'default-project', 'item', 'アイテム', '#BA7517', 'item', 1, 2.0, datetime('now'));
            INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, file_prefix, is_builtin, sort_order, created_at)
              VALUES ('builtin-lore', 'default-project', 'lore', '伝承', '#993C1D', 'lore', 1, 3.0, datetime('now'));",
        )?;

        Ok(())
    }

    pub fn execute(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;

        let native_params: Vec<Box<dyn rusqlite::types::ToSql>> = params
            .iter()
            .map(|v| -> Box<dyn rusqlite::types::ToSql> {
                match v {
                    Value::Null => Box::new(Option::<String>::None),
                    Value::Bool(b) => Box::new(*b),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            Box::new(i)
                        } else {
                            Box::new(n.as_f64().unwrap_or(0.0))
                        }
                    }
                    Value::String(s) => Box::new(s.clone()),
                    _ => Box::new(v.to_string()),
                }
            })
            .collect();

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            native_params.iter().map(|p| p.as_ref()).collect();

        match method {
            "run" => {
                conn.execute(sql, params_from_iter(param_refs.iter()))?;
                Ok(vec![])
            }
            _ => {
                // "all" or "get"
                let mut stmt = conn.prepare(sql)?;
                let column_names: Vec<String> = stmt
                    .column_names()
                    .iter()
                    .map(|s| s.to_string())
                    .collect();

                let rows = stmt.query_map(params_from_iter(param_refs.iter()), |row| {
                    let mut map = serde_json::Map::new();
                    for (i, col_name) in column_names.iter().enumerate() {
                        let val: Value = match row.get_ref(i) {
                            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                            Ok(rusqlite::types::ValueRef::Integer(n)) => {
                                Value::Number(n.into())
                            }
                            Ok(rusqlite::types::ValueRef::Real(f)) => {
                                Value::Number(
                                    serde_json::Number::from_f64(f)
                                        .unwrap_or_else(|| 0.into()),
                                )
                            }
                            Ok(rusqlite::types::ValueRef::Text(s)) => {
                                Value::String(
                                    String::from_utf8_lossy(s).to_string(),
                                )
                            }
                            Ok(rusqlite::types::ValueRef::Blob(b)) => {
                                Value::String(format!("[blob {} bytes]", b.len()))
                            }
                            Err(_) => Value::Null,
                        };
                        map.insert(col_name.clone(), val);
                    }
                    Ok(map)
                })?;

                let mut result = Vec::new();
                for row in rows {
                    result.push(row?);
                }

                if method == "get" {
                    return Ok(result.into_iter().take(1).collect());
                }

                Ok(result)
            }
        }
    }

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
        report.insert("orphanedSnippetSources".into(), orphaned_snippet_sources.into());

        let orphaned_snippet_scenes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snippets WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM tree_nodes)",
            [],
            |row| row.get(0),
        )?;
        report.insert("orphanedSnippetScenes".into(), orphaned_snippet_scenes.into());

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
        report.insert("snippetSourcesFixed".into(), (snippet_sources_fixed as i64).into());

        let snippet_scenes_fixed = conn.execute(
            "UPDATE snippets SET scene_id = NULL WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM tree_nodes)",
            [],
        )?;
        report.insert("snippetScenesFixed".into(), (snippet_scenes_fixed as i64).into());

        Ok(report)
    }

    pub fn fts_optimize(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "INSERT INTO codex_fts(codex_fts) VALUES('optimize');
             INSERT INTO snippets_fts(snippets_fts) VALUES('optimize');
             INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('optimize');",
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    #[test]
    fn test_migrate_creates_all_tables() {
        let db = test_db();
        let expected_tables = [
            "projects", "tree_nodes", "codex_entries", "codex_relation_dismissed",
            "snippets", "chat_sessions", "chat_messages", "authorship_spans", "settings",
        ];
        for table in &expected_tables {
            let rows = db
                .execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    &[Value::String((*table).into())],
                    "all",
                )
                .expect("query");
            assert_eq!(rows.len(), 1, "table '{}' should exist", table);
        }
    }

    #[test]
    fn test_migrate_creates_fts_tables() {
        let db = test_db();
        let expected = ["codex_fts", "snippets_fts", "chat_messages_fts"];
        for table in &expected {
            let rows = db
                .execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    &[Value::String((*table).into())],
                    "all",
                )
                .expect("query");
            assert_eq!(rows.len(), 1, "FTS table '{}' should exist", table);
        }
    }

    #[test]
    fn test_seed_data() {
        let db = test_db();
        let projects = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0]["id"], Value::String("default-project".into()));
        assert_eq!(projects[0]["language"], Value::String("ja".into()));

        let nodes = db
            .execute("SELECT * FROM tree_nodes", &[], "all")
            .expect("select");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["id"], Value::String("default-chapter".into()));
        assert_eq!(nodes[0]["node_type"], Value::String("chapter".into()));
    }

    #[test]
    fn test_crud_projects() {
        let db = test_db();

        db.execute(
            "INSERT INTO projects (id, title, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("proj-1".into()),
                Value::String("Test Novel".into()),
                Value::String("fantasy".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        let rows = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 2); // seed + test

        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::String("proj-1".into())],
                "get",
            )
            .expect("select one");
        assert_eq!(rows[0]["title"], Value::String("Test Novel".into()));
        assert_eq!(rows[0]["genre"], Value::String("fantasy".into()));

        db.execute(
            "UPDATE projects SET title = ? WHERE id = ?",
            &[
                Value::String("Updated Novel".into()),
                Value::String("proj-1".into()),
            ],
            "run",
        )
        .expect("update");

        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::String("proj-1".into())],
                "get",
            )
            .expect("select after update");
        assert_eq!(rows[0]["title"], Value::String("Updated Novel".into()));

        db.execute(
            "DELETE FROM projects WHERE id = ?",
            &[Value::String("proj-1".into())],
            "run",
        )
        .expect("delete");

        let rows = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 1); // seed remains
    }

    #[test]
    fn test_crud_tree_nodes() {
        let db = test_db();

        // Create a scene under the default chapter
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("scene-1".into()),
                Value::String("default-project".into()),
                Value::String("default-chapter".into()),
                Value::String("scene".into()),
                Value::String("Opening".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert scene node");

        let rows = db
            .execute(
                "SELECT * FROM tree_nodes WHERE parent_id = ?",
                &[Value::String("default-chapter".into())],
                "all",
            )
            .expect("select children");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("Opening".into()));
        assert_eq!(rows[0]["node_type"], Value::String("scene".into()));

        // Update
        db.execute(
            "UPDATE tree_nodes SET title = ? WHERE id = ?",
            &[
                Value::String("Prologue".into()),
                Value::String("scene-1".into()),
            ],
            "run",
        )
        .expect("update");

        let rows = db
            .execute(
                "SELECT title FROM tree_nodes WHERE id = ?",
                &[Value::String("scene-1".into())],
                "get",
            )
            .expect("get");
        assert_eq!(rows[0]["title"], Value::String("Prologue".into()));
    }

    #[test]
    fn test_cascade_delete_project_to_nodes() {
        let db = test_db();

        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("proj-del".into()),
                Value::String("Deletable".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert project");

        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("ch-del".into()),
                Value::String("proj-del".into()),
                Value::String("chapter".into()),
                Value::String("Ch1".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert chapter");

        db.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("sc-del".into()),
                Value::String("proj-del".into()),
                Value::String("ch-del".into()),
                Value::String("scene".into()),
                Value::String("S1".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert scene");

        db.execute(
            "DELETE FROM projects WHERE id = ?",
            &[Value::String("proj-del".into())],
            "run",
        )
        .expect("delete project");

        let nodes = db
            .execute(
                "SELECT * FROM tree_nodes WHERE project_id = ?",
                &[Value::String("proj-del".into())],
                "all",
            )
            .expect("select nodes");
        assert_eq!(nodes.len(), 0);
    }

    #[test]
    fn test_crud_codex_entries() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("codex-1".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("太郎".into()),
                Value::String("主人公".into()),
                Value::String(r#"["主人公","勇者"]"#.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        let rows = db
            .execute("SELECT * FROM codex_entries", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("太郎".into()));

        db.execute(
            "UPDATE codex_entries SET summary = ? WHERE id = ?",
            &[
                Value::String("更新された主人公".into()),
                Value::String("codex-1".into()),
            ],
            "run",
        )
        .expect("update");

        let rows = db
            .execute(
                "SELECT summary FROM codex_entries WHERE id = ?",
                &[Value::String("codex-1".into())],
                "get",
            )
            .expect("get");
        assert_eq!(rows[0]["summary"], Value::String("更新された主人公".into()));

        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::String("codex-1".into())],
            "run",
        )
        .expect("delete");

        let rows = db
            .execute("SELECT * FROM codex_entries", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn test_crud_snippets() {
        let db = test_db();

        db.execute(
            "INSERT INTO snippets (id, project_id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("snip-1".into()),
                Value::String("default-project".into()),
                Value::String("伏線メモ".into()),
                Value::String("第3章で回収する伏線。".into()),
                Value::String(r#"["伏線"]"#.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        let rows = db
            .execute("SELECT * FROM snippets", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("伏線メモ".into()));

        db.execute(
            "UPDATE snippets SET title = ? WHERE id = ?",
            &[
                Value::String("更新されたメモ".into()),
                Value::String("snip-1".into()),
            ],
            "run",
        )
        .expect("update");

        let rows = db
            .execute(
                "SELECT title FROM snippets WHERE id = ?",
                &[Value::String("snip-1".into())],
                "get",
            )
            .expect("get");
        assert_eq!(rows[0]["title"], Value::String("更新されたメモ".into()));
    }

    #[test]
    fn test_crud_chat_sessions_and_messages() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("sess-1".into()),
                Value::String("default-project".into()),
                Value::String("Test Session".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert session");

        let rows = db
            .execute("SELECT * FROM chat_sessions", &[], "all")
            .expect("select sessions");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("Test Session".into()));

        db.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("msg-1".into()),
                Value::String("sess-1".into()),
                Value::String("user".into()),
                Value::String("Hello".into()),
                Value::Null,
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert message");

        db.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("msg-2".into()),
                Value::String("sess-1".into()),
                Value::String("assistant".into()),
                Value::String("Hi there!".into()),
                Value::String("claude-sonnet".into()),
                Value::String("2025-01-01T00:00:01Z".into()),
            ],
            "run",
        )
        .expect("insert assistant message");

        let rows = db
            .execute(
                "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at",
                &[Value::String("sess-1".into())],
                "all",
            )
            .expect("select messages");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["role"], Value::String("user".into()));
        assert_eq!(rows[1]["model"], Value::String("claude-sonnet".into()));
    }

    #[test]
    fn test_chat_messages_role_check_constraint() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("sess-1".into()),
                Value::String("default-project".into()),
                Value::String("Test".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert session");

        let result = db.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-bad".into()),
                Value::String("sess-1".into()),
                Value::String("invalid_role".into()),
                Value::String("test".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_cascade_delete_session_to_messages() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("sess-1".into()),
                Value::String("default-project".into()),
                Value::String("Test".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert session");

        db.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-1".into()),
                Value::String("sess-1".into()),
                Value::String("user".into()),
                Value::String("Hello".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert message");

        db.execute(
            "DELETE FROM chat_sessions WHERE id = ?",
            &[Value::String("sess-1".into())],
            "run",
        )
        .expect("delete session");

        let msgs = db
            .execute("SELECT * FROM chat_messages", &[], "all")
            .expect("select messages");
        assert_eq!(msgs.len(), 0);
    }

    #[test]
    fn test_crud_settings() {
        let db = test_db();

        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            &[
                Value::String("editor.fontSize".into()),
                Value::String("16".into()),
            ],
            "run",
        )
        .expect("insert setting");

        let rows = db
            .execute(
                "SELECT value FROM settings WHERE key = ?",
                &[Value::String("editor.fontSize".into())],
                "get",
            )
            .expect("get setting");
        assert_eq!(rows[0]["value"], Value::String("16".into()));

        db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            &[
                Value::String("editor.fontSize".into()),
                Value::String("18".into()),
            ],
            "run",
        )
        .expect("update setting");

        let rows = db
            .execute(
                "SELECT value FROM settings WHERE key = ?",
                &[Value::String("editor.fontSize".into())],
                "get",
            )
            .expect("get updated setting");
        assert_eq!(rows[0]["value"], Value::String("18".into()));
    }

    #[test]
    fn test_fts5_codex_search() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("c1".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("太郎".into()),
                Value::String("勇敢な主人公".into()),
                Value::String(r#"["主人公","勇者"]"#.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("c2".into()),
                Value::String("default-project".into()),
                Value::String("location".into()),
                Value::String("魔王城".into()),
                Value::String("最終ダンジョン".into()),
                Value::String(r#"["ダンジョン"]"#.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // Search by summary
        let rows = db
            .execute(
                "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
                &[Value::String("勇敢な主人公".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("太郎".into()));

        // Search by name
        let rows = db
            .execute(
                "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
                &[Value::String("魔王城".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("魔王城".into()));
    }

    #[test]
    fn test_fts5_snippets_search() {
        let db = test_db();

        db.execute(
            "INSERT INTO snippets (id, project_id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("s1".into()),
                Value::String("default-project".into()),
                Value::String("森の描写".into()),
                Value::String("暗い森の中、一筋の光が差し込んだ。".into()),
                Value::String(r#"["描写","森"]"#.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        let rows = db
            .execute(
                "SELECT title FROM snippets_fts WHERE snippets_fts MATCH ?",
                &[Value::String("森の描写".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("森の描写".into()));
    }

    #[test]
    fn test_fts5_chat_messages_search() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("sess-fts".into()),
                Value::String("default-project".into()),
                Value::String("FTS Test".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert session");

        db.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-fts".into()),
                Value::String("sess-fts".into()),
                Value::String("user".into()),
                Value::String("太郎のキャラクター設定について教えてください".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert message");

        let rows = db
            .execute(
                "SELECT content FROM chat_messages_fts WHERE chat_messages_fts MATCH ?",
                &[Value::String("キャラクター設定".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_fts5_sync_on_update() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("c-upd".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("山田太郎".into()),
                Value::String("主人公キャラ".into()),
                Value::String("[]".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        db.execute(
            "UPDATE codex_entries SET name = ? WHERE id = ?",
            &[
                Value::String("鈴木次郎".into()),
                Value::String("c-upd".into()),
            ],
            "run",
        )
        .expect("update");

        // Old name should not match
        let rows = db
            .execute(
                "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
                &[Value::String("山田太郎".into())],
                "all",
            )
            .expect("fts search old");
        assert_eq!(rows.len(), 0);

        // New name should match
        let rows = db
            .execute(
                "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
                &[Value::String("鈴木次郎".into())],
                "all",
            )
            .expect("fts search new");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_fts5_sync_on_delete() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("c-del".into()),
                Value::String("default-project".into()),
                Value::String("item".into()),
                Value::String("伝説の聖剣".into()),
                Value::String("伝説の武器".into()),
                Value::String("[]".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        let rows = db
            .execute(
                "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
                &[Value::String("伝説の聖剣".into())],
                "all",
            )
            .expect("fts before delete");
        assert_eq!(rows.len(), 1);

        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::String("c-del".into())],
            "run",
        )
        .expect("delete");

        let rows = db
            .execute(
                "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
                &[Value::String("伝説の聖剣".into())],
                "all",
            )
            .expect("fts after delete");
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn test_nullify_codex_source_on_message_delete() {
        let db = test_db();

        // Create session + message
        db.execute(
            "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("s1".into()), Value::String("default-project".into()), Value::String("Session".into())],
            "run",
        ).expect("insert session");
        db.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
            &[Value::String("msg1".into()), Value::String("s1".into()), Value::String("user".into()), Value::String("hello".into())],
            "run",
        ).expect("insert message");

        // Create codex entry referencing the message
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("cx1".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("テスト".into()), Value::String("msg1".into())],
            "run",
        ).expect("insert codex");

        // Delete the message
        db.execute(
            "DELETE FROM chat_messages WHERE id = ?",
            &[Value::String("msg1".into())],
            "run",
        ).expect("delete message");

        // Verify source was nullified
        let rows = db.execute(
            "SELECT source_chat_message_id FROM codex_entries WHERE id = ?",
            &[Value::String("cx1".into())],
            "all",
        ).expect("query");
        assert_eq!(rows[0]["source_chat_message_id"], Value::Null);
    }

    #[test]
    fn test_nullify_snippet_scene_on_node_delete() {
        let db = test_db();

        // Create scene node
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("sc1".into()), Value::String("default-project".into()), Value::String("default-chapter".into()), Value::String("scene".into()), Value::String("シーン1".into()), Value::Number(serde_json::Number::from_f64(0.0).unwrap())],
            "run",
        ).expect("insert scene node");

        // Create snippet referencing the scene
        db.execute(
            "INSERT INTO snippets (id, project_id, title, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("sn1".into()), Value::String("default-project".into()), Value::String("テスト".into()), Value::String("sc1".into())],
            "run",
        ).expect("insert snippet");

        // Delete the scene node
        db.execute(
            "DELETE FROM tree_nodes WHERE id = ?",
            &[Value::String("sc1".into())],
            "run",
        ).expect("delete scene node");

        // Verify scene_id was nullified
        let rows = db.execute(
            "SELECT scene_id FROM snippets WHERE id = ?",
            &[Value::String("sn1".into())],
            "all",
        ).expect("query");
        assert_eq!(rows[0]["scene_id"], Value::Null);
    }

    #[test]
    fn test_integrity_check_clean_db() {
        let db = test_db();
        let report = db.integrity_check().expect("integrity check");
        assert_eq!(report["orphanedCodexSources"], Value::Number(0.into()));
        assert_eq!(report["orphanedSnippetSources"], Value::Number(0.into()));
        assert_eq!(report["orphanedSnippetScenes"], Value::Number(0.into()));
    }

    #[test]
    fn test_integrity_check_detects_and_repairs_orphans() {
        let db = test_db();

        // Insert codex with non-existent source_chat_message_id
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("cx-orphan".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("孤立テスト".into()), Value::String("nonexistent".into())],
            "run",
        ).expect("insert");

        let report = db.integrity_check().expect("check");
        assert_eq!(report["orphanedCodexSources"], Value::Number(1.into()));

        let repair = db.repair_integrity().expect("repair");
        assert_eq!(repair["codexSourcesFixed"], Value::Number(1.into()));

        let report2 = db.integrity_check().expect("check2");
        assert_eq!(report2["orphanedCodexSources"], Value::Number(0.into()));
    }

    #[test]
    fn test_fts_optimize_succeeds() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[
                Value::String("c-opt".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("テスト太郎".into()),
                Value::String("テスト用キャラクター".into()),
                Value::String("[]".into()),
            ],
            "run",
        ).expect("insert codex");

        db.execute(
            "INSERT INTO snippets (id, project_id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[
                Value::String("s-opt".into()),
                Value::String("default-project".into()),
                Value::String("テストスニペット".into()),
                Value::String("スニペット内容".into()),
                Value::String("[]".into()),
            ],
            "run",
        ).expect("insert snippet");

        db.fts_optimize().expect("fts_optimize should succeed");
    }

    #[test]
    fn test_data_persists_across_reopen() {
        let dir = std::env::temp_dir().join("grimodex_test_persist_v2");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("persist.db");
        std::fs::remove_file(&db_path).ok();

        {
            let db = Database::new(&db_path).expect("open db");
            db.migrate().expect("migrate");
            db.execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                &[
                    Value::String("proj-persist".into()),
                    Value::String("Persisted Novel".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                ],
                "run",
            )
            .expect("insert");
        }

        {
            let db = Database::new(&db_path).expect("reopen db");
            db.migrate().expect("migrate again");

            let rows = db
                .execute(
                    "SELECT * FROM projects WHERE id = ?",
                    &[Value::String("proj-persist".into())],
                    "get",
                )
                .expect("select");
            assert_eq!(rows[0]["title"], Value::String("Persisted Novel".into()));
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_wal_mode_enabled() {
        let dir = std::env::temp_dir().join("grimodex_test_wal_v2");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("test.db");
        std::fs::remove_file(&db_path).ok();
        let db = Database::new(&db_path).expect("open db");
        let rows = db
            .execute("PRAGMA journal_mode", &[], "get")
            .expect("pragma");
        let mode = rows[0]
            .values()
            .next()
            .expect("value")
            .as_str()
            .expect("str")
            .to_lowercase();
        assert_eq!(mode, "wal");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_authorship_spans_crud() {
        let db = test_db();

        // Create a scene node first
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("sc-attr".into()), Value::String("default-project".into()), Value::String("default-chapter".into()), Value::String("scene".into()), Value::String("S1".into()), Value::Number(serde_json::Number::from_f64(0.0).unwrap())],
            "run",
        ).expect("insert scene");

        db.execute(
            "INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source, model, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("attr-1".into()),
                Value::String("sc-attr".into()),
                Value::Number(0.into()),
                Value::Number(100.into()),
                Value::String("ai".into()),
                Value::String("claude-sonnet".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        ).expect("insert span");

        let rows = db.execute(
            "SELECT * FROM authorship_spans WHERE node_id = ?",
            &[Value::String("sc-attr".into())],
            "all",
        ).expect("select spans");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["source"], Value::String("ai".into()));
        assert_eq!(rows[0]["from_pos"], Value::Number(0.into()));
        assert_eq!(rows[0]["to_pos"], Value::Number(100.into()));
    }
}
