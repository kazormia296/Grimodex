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
                parent_id   TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                node_type   TEXT NOT NULL,
                title       TEXT NOT NULL DEFAULT 'Untitled',
                synopsis    TEXT,
                sort_order  REAL NOT NULL DEFAULT 0.0,
                status      TEXT DEFAULT 'outline',
                content     TEXT NOT NULL DEFAULT '{}',
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
                is_builtin  INTEGER NOT NULL DEFAULT 0,
                sort_order  REAL NOT NULL DEFAULT 0.0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, slug)
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
                content                 TEXT NOT NULL DEFAULT '{}',
                icon                    BLOB,
                tags_cache              TEXT,
                context_mode            TEXT NOT NULL DEFAULT 'mentioned'
                                          CHECK(context_mode IN ('always', 'mentioned', 'suppress', 'hidden')),
                source_chat_message_id  TEXT REFERENCES chat_messages(id),
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
                field_type        TEXT NOT NULL DEFAULT 'text'
                                    CHECK(field_type IN ('text', 'dropdown', 'codex_reference')),
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
                content                 TEXT NOT NULL DEFAULT '{}',
                tags                    TEXT,
                scene_id                TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                source_chat_message_id  TEXT REFERENCES chat_messages(id),
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
                id              TEXT PRIMARY KEY,
                node_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                from_pos        INTEGER NOT NULL,
                to_pos          INTEGER NOT NULL,
                source          TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
                model           TEXT,
                timestamp       TEXT,
                chat_msg_id     TEXT,
                CHECK (
                    (node_id IS NOT NULL AND codex_entry_id IS NULL AND snippet_id IS NULL) OR
                    (node_id IS NULL AND codex_entry_id IS NOT NULL AND snippet_id IS NULL) OR
                    (node_id IS NULL AND codex_entry_id IS NULL AND snippet_id IS NOT NULL)
                )
            );
            CREATE INDEX IF NOT EXISTS idx_authorship_node
                ON authorship_spans(node_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_codex
                ON authorship_spans(codex_entry_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_snippet
                ON authorship_spans(snippet_id, source);

            CREATE TABLE IF NOT EXISTS content_versions (
                id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                entity_type    TEXT NOT NULL CHECK(entity_type IN ('scene', 'note', 'codex_entry', 'snippet')),
                entity_id      TEXT NOT NULL,
                content        TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                snapshot_type  TEXT NOT NULL DEFAULT 'auto' CHECK(snapshot_type IN ('auto', 'manual')),
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(entity_type, entity_id, version_number)
            );
            CREATE INDEX IF NOT EXISTS idx_cv_entity
                ON content_versions(entity_type, entity_id, version_number DESC);

            CREATE TABLE IF NOT EXISTS project_snapshots (
                id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                description TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_project_snapshots
                ON project_snapshots(project_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS project_snapshot_entries (
                snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
                version_id  TEXT NOT NULL REFERENCES content_versions(id),
                PRIMARY KEY (snapshot_id, version_id)
            );

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

            CREATE VIRTUAL TABLE IF NOT EXISTS tree_nodes_fts USING fts5(
                title, content,
                content=tree_nodes, content_rowid=rowid,
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
            CREATE TRIGGER IF NOT EXISTS codex_fts_au AFTER UPDATE ON codex_entries
              WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache
            BEGIN
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
            CREATE TRIGGER IF NOT EXISTS snippets_fts_au AFTER UPDATE ON snippets
              WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags IS NOT new.tags
            BEGIN
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
            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE ON chat_messages
              WHEN old.content IS NOT new.content
            BEGIN
                INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
                INSERT INTO chat_messages_fts(rowid, content)
                VALUES (new.rowid, new.content);
            END;

            -- Triggers to keep FTS indexes in sync: tree_nodes
            CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_ai AFTER INSERT ON tree_nodes BEGIN
                INSERT INTO tree_nodes_fts(rowid, title, content)
                VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_ad AFTER DELETE ON tree_nodes BEGIN
                INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
                VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_au AFTER UPDATE ON tree_nodes
              WHEN old.title IS NOT new.title OR old.content IS NOT new.content
            BEGIN
                INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
                VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
                INSERT INTO tree_nodes_fts(rowid, title, content)
                VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
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

            -- Triggers to cascade-delete content_versions for polymorphic entity_id
            CREATE TRIGGER IF NOT EXISTS delete_cv_on_tree_node_delete
            AFTER DELETE ON tree_nodes BEGIN
                DELETE FROM content_versions
                WHERE entity_type IN ('scene', 'note') AND entity_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS delete_cv_on_codex_entry_delete
            AFTER DELETE ON codex_entries BEGIN
                DELETE FROM content_versions
                WHERE entity_type = 'codex_entry' AND entity_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS delete_cv_on_snippet_delete
            AFTER DELETE ON snippets BEGIN
                DELETE FROM content_versions
                WHERE entity_type = 'snippet' AND entity_id = old.id;
            END;

            -- Seed built-in codex types for every new project
            CREATE TRIGGER IF NOT EXISTS seed_builtin_codex_types
            AFTER INSERT ON projects BEGIN
                INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, is_builtin, sort_order, created_at)
                  VALUES (new.id || '-character', new.id, 'character', 'キャラクター', '#534AB7', 1, 0.0, datetime('now'));
                INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, is_builtin, sort_order, created_at)
                  VALUES (new.id || '-location', new.id, 'location', '場所', '#0F6E56', 1, 1.0, datetime('now'));
                INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, is_builtin, sort_order, created_at)
                  VALUES (new.id || '-item', new.id, 'item', 'アイテム', '#BA7517', 1, 2.0, datetime('now'));
                INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, is_builtin, sort_order, created_at)
                  VALUES (new.id || '-lore', new.id, 'lore', '伝承', '#993C1D', 1, 3.0, datetime('now'));
            END;

            -- Seed default project + folder node
            INSERT OR IGNORE INTO projects (id, title, language, created_at, updated_at)
              VALUES ('default-project', '無題のプロジェクト', 'ja', datetime('now'), datetime('now'));
            INSERT OR IGNORE INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at)
              VALUES ('default-chapter', 'default-project', 'folder', '第1章', 0.0, datetime('now'), datetime('now'));",
        )?;

        // Idempotent column additions
        let _ = conn.execute("ALTER TABLE snippets ADD COLUMN content_source TEXT", []);
        // Migration: clear corrupted icon data (blobs and non-data-URL strings from old blob storage)
        let _ = conn.execute(
            "UPDATE codex_entries SET icon = NULL WHERE icon IS NOT NULL AND (typeof(icon) = 'blob' OR icon NOT LIKE 'data:%')",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE codex_entries ADD COLUMN children_budget TEXT NOT NULL DEFAULT 'compact'",
            [],
        );
        let _ = conn.execute("ALTER TABLE codex_entries ADD COLUMN notes TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE codex_types ADD COLUMN palette_index INTEGER",
            [],
        );
        // Assign palette indices to existing builtin types
        let _ = conn.execute(
            "UPDATE codex_types SET palette_index = 0 WHERE slug = 'character' AND palette_index IS NULL",
            [],
        );
        let _ = conn.execute(
            "UPDATE codex_types SET palette_index = 1 WHERE slug = 'location' AND palette_index IS NULL",
            [],
        );
        let _ = conn.execute(
            "UPDATE codex_types SET palette_index = 2 WHERE slug = 'item' AND palette_index IS NULL",
            [],
        );
        let _ = conn.execute(
            "UPDATE codex_types SET palette_index = 3 WHERE slug = 'lore' AND palette_index IS NULL",
            [],
        );
        // Recreate seed trigger to include palette_index for new projects
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS seed_builtin_codex_types;
             CREATE TRIGGER IF NOT EXISTS seed_builtin_codex_types
             AFTER INSERT ON projects BEGIN
                 INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
                   VALUES (new.id || '-character', new.id, 'character', 'キャラクター', '#534AB7', 0, 1, 0.0, datetime('now'));
                 INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
                   VALUES (new.id || '-location', new.id, 'location', '場所', '#0F6E56', 1, 1, 1.0, datetime('now'));
                 INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
                   VALUES (new.id || '-item', new.id, 'item', 'アイテム', '#BA7517', 2, 1, 2.0, datetime('now'));
                 INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
                   VALUES (new.id || '-lore', new.id, 'lore', '伝承', '#993C1D', 3, 1, 3.0, datetime('now'));
             END;",
        )?;

        // v2: Recreate FTS UPDATE triggers with WHEN guards so that non-FTS
        // column updates (e.g. updated_at) don't touch FTS indexes.
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS codex_fts_au;
             DROP TRIGGER IF EXISTS snippets_fts_au;
             DROP TRIGGER IF EXISTS chat_messages_fts_au;
             DROP TRIGGER IF EXISTS tree_nodes_fts_au;

             CREATE TRIGGER IF NOT EXISTS codex_fts_au AFTER UPDATE ON codex_entries
               WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache
             BEGIN
                 INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
                 VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''));
                 INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
                 VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''));
             END;

             CREATE TRIGGER IF NOT EXISTS snippets_fts_au AFTER UPDATE ON snippets
               WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags IS NOT new.tags
             BEGIN
                 INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
                 VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags, ''));
                 INSERT INTO snippets_fts(rowid, title, content, tags)
                 VALUES (new.rowid, new.title, new.content, COALESCE(new.tags, ''));
             END;

             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE ON chat_messages
               WHEN old.content IS NOT new.content
             BEGIN
                 INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
                 VALUES ('delete', old.rowid, old.content);
                 INSERT INTO chat_messages_fts(rowid, content)
                 VALUES (new.rowid, new.content);
             END;

             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_au AFTER UPDATE ON tree_nodes
               WHEN old.title IS NOT new.title OR old.content IS NOT new.content
             BEGIN
                 INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
                 VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
                 INSERT INTO tree_nodes_fts(rowid, title, content)
                 VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
             END;",
        )?;

        // v3: Collapse legacy part/chapter container types into folder
        conn.execute_batch(
            "UPDATE tree_nodes SET node_type = 'folder' WHERE node_type IN ('part', 'chapter');",
        )?;

        // v4: Codex Quick pins persistence
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS codex_quick_pins (
                entry_id TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE
            )",
            [],
        );

        // v5: Progressive Summarization
        let _ = conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN is_summarized INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_summaries (
                id                  TEXT PRIMARY KEY,
                session_id          TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                summary             TEXT NOT NULL,
                source_message_ids  TEXT NOT NULL,
                token_count         INTEGER,
                created_at          TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_summaries_session ON chat_summaries(session_id, created_at)",
            [],
        );

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
                let column_names: Vec<String> =
                    stmt.column_names().iter().map(|s| s.to_string()).collect();

                let rows = stmt.query_map(params_from_iter(param_refs.iter()), |row| {
                    let mut map = serde_json::Map::new();
                    for (i, col_name) in column_names.iter().enumerate() {
                        let val: Value = match row.get_ref(i) {
                            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                            Ok(rusqlite::types::ValueRef::Integer(n)) => Value::Number(n.into()),
                            Ok(rusqlite::types::ValueRef::Real(f)) => Value::Number(
                                serde_json::Number::from_f64(f).unwrap_or_else(|| 0.into()),
                            ),
                            Ok(rusqlite::types::ValueRef::Text(s)) => {
                                Value::String(String::from_utf8_lossy(s).to_string())
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

    /// Drop and rebuild all FTS5 indexes from scratch.
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
            "projects",
            "tree_nodes",
            "codex_entries",
            "codex_relation_dismissed",
            "snippets",
            "chat_sessions",
            "chat_messages",
            "authorship_spans",
            "settings",
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
        let expected = [
            "codex_fts",
            "snippets_fts",
            "chat_messages_fts",
            "tree_nodes_fts",
        ];
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
        assert_eq!(nodes[0]["node_type"], Value::String("folder".into()));
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
                Value::String("folder".into()),
                Value::String("Ch1".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert folder");

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
        )
        .expect("delete message");

        // Verify source was nullified
        let rows = db
            .execute(
                "SELECT source_chat_message_id FROM codex_entries WHERE id = ?",
                &[Value::String("cx1".into())],
                "all",
            )
            .expect("query");
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
        )
        .expect("delete scene node");

        // Verify scene_id was nullified
        let rows = db
            .execute(
                "SELECT scene_id FROM snippets WHERE id = ?",
                &[Value::String("sn1".into())],
                "all",
            )
            .expect("query");
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

        // source_chat_message_id now has a FK constraint; temporarily disable to simulate
        // corrupted/migrated data that integrity_check is designed to catch
        db.execute("PRAGMA foreign_keys=OFF", &[], "run")
            .expect("disable fk");
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("cx-orphan".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("孤立テスト".into()), Value::String("nonexistent".into())],
            "run",
        ).expect("insert orphan");
        db.execute("PRAGMA foreign_keys=ON", &[], "run")
            .expect("enable fk");

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

        let rows = db
            .execute(
                "SELECT * FROM authorship_spans WHERE node_id = ?",
                &[Value::String("sc-attr".into())],
                "all",
            )
            .expect("select spans");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["source"], Value::String("ai".into()));
        assert_eq!(rows[0]["from_pos"], Value::Number(0.into()));
        assert_eq!(rows[0]["to_pos"], Value::Number(100.into()));
    }

    // --- BUG 1: codex_detail_definitions.type_slug FK ---

    #[test]
    fn test_codex_detail_definitions_crud() {
        let db = test_db();

        // Insert a definition for built-in type
        db.execute(
            "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("def-1".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("身長".into()),
                Value::String("text".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
            ],
            "run",
        ).expect("insert definition");

        let rows = db
            .execute(
                "SELECT * FROM codex_detail_definitions WHERE id = ?",
                &[Value::String("def-1".into())],
                "get",
            )
            .expect("select");
        assert_eq!(rows[0]["name"], Value::String("身長".into()));
        assert_eq!(rows[0]["type_slug"], Value::String("character".into()));
    }

    #[test]
    fn test_codex_detail_definitions_allows_any_type_slug() {
        // Per schema spec: type_slug is a logical reference to codex_types.slug (no FK).
        // Validation is enforced at the application layer, not the DB layer.
        let db = test_db();

        let result = db.execute(
            "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("def-custom".into()),
                Value::String("default-project".into()),
                Value::String("nonexistent-type".into()),
                Value::String("テスト".into()),
                Value::String("text".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
            ],
            "run",
        );
        assert!(
            result.is_ok(),
            "DB should allow any type_slug; app layer validates"
        );
    }

    #[test]
    fn test_codex_entries_allows_any_type() {
        // Per schema spec: type is a logical reference to codex_types.slug (no FK).
        // Validation is enforced at the application layer, not the DB layer.
        let db = test_db();

        let result = db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("ce-custom".into()),
                Value::String("default-project".into()),
                Value::String("nonexistent-type".into()),
                Value::String("テスト".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        );
        assert!(
            result.is_ok(),
            "DB should allow any type; app layer validates"
        );
    }

    // --- BUG 3: field_type CHECK constraint ---

    #[test]
    fn test_codex_detail_definitions_rejects_invalid_field_type() {
        let db = test_db();

        let result = db.execute(
            "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("def-badft".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("テスト".into()),
                Value::String("invalid_type".into()),
                Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
            ],
            "run",
        );
        assert!(
            result.is_err(),
            "Should reject definition with invalid field_type"
        );
    }

    // --- BUG 4: Built-in types seeded for new projects ---

    #[test]
    fn test_builtin_types_seeded_on_new_project() {
        let db = test_db();

        // Create a new project
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("new-project".into()),
                Value::String("新プロジェクト".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert new project");

        // Check that built-in types were seeded
        let rows = db
            .execute(
                "SELECT * FROM codex_types WHERE project_id = ? ORDER BY sort_order",
                &[Value::String("new-project".into())],
                "all",
            )
            .expect("select types");

        assert_eq!(rows.len(), 4, "Should have 4 built-in types");
        assert_eq!(rows[0]["slug"], Value::String("character".into()));
        assert_eq!(rows[1]["slug"], Value::String("location".into()));
        assert_eq!(rows[2]["slug"], Value::String("item".into()));
        assert_eq!(rows[3]["slug"], Value::String("lore".into()));

        // All should be marked as built-in
        for row in &rows {
            assert_eq!(row["is_builtin"], Value::Number(1.into()));
        }
    }

    // --- Cascade delete tests for new tables ---

    #[test]
    fn test_cascade_delete_codex_entry_to_entry_tags() {
        let db = test_db();

        // Insert codex entry
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("ce-cas".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("テスト".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        ).expect("insert entry");

        // Insert a tag
        db.execute(
            "INSERT INTO codex_tags (id, project_id, name) VALUES (?, ?, ?)",
            &[
                Value::String("tag-1".into()),
                Value::String("default-project".into()),
                Value::String("重要".into()),
            ],
            "run",
        )
        .expect("insert tag");

        // Link entry to tag
        db.execute(
            "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES (?, ?)",
            &[
                Value::String("ce-cas".into()),
                Value::String("tag-1".into()),
            ],
            "run",
        )
        .expect("insert entry_tag");

        // Delete the entry
        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::String("ce-cas".into())],
            "run",
        )
        .expect("delete entry");

        // entry_tags should be cascade-deleted
        let rows = db
            .execute(
                "SELECT * FROM codex_entry_tags WHERE entry_id = ?",
                &[Value::String("ce-cas".into())],
                "all",
            )
            .expect("select entry_tags");
        assert_eq!(rows.len(), 0, "entry_tags should be cascade-deleted");
    }

    #[test]
    fn test_cascade_delete_codex_entry_to_detail_values() {
        let db = test_db();

        // Insert codex entry
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("ce-dv".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("テスト".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        ).expect("insert entry");

        // Insert a detail definition
        db.execute(
            "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("ddef-1".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("身長".into()),
                Value::String("text".into()),
            ],
            "run",
        ).expect("insert definition");

        // Insert a detail value
        db.execute(
            "INSERT INTO codex_detail_values (id, entry_id, definition_id, value) VALUES (?, ?, ?, ?)",
            &[
                Value::String("dval-1".into()),
                Value::String("ce-dv".into()),
                Value::String("ddef-1".into()),
                Value::String("170cm".into()),
            ],
            "run",
        ).expect("insert detail value");

        // Delete the entry
        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::String("ce-dv".into())],
            "run",
        )
        .expect("delete entry");

        // detail_values should be cascade-deleted
        let rows = db
            .execute(
                "SELECT * FROM codex_detail_values WHERE entry_id = ?",
                &[Value::String("ce-dv".into())],
                "all",
            )
            .expect("select detail_values");
        assert_eq!(rows.len(), 0, "detail_values should be cascade-deleted");
    }

    // --- codex_types CRUD ---

    #[test]
    fn test_codex_types_crud() {
        let db = test_db();

        // Verify built-in types exist
        let rows = db.execute(
            "SELECT * FROM codex_types WHERE project_id = ? AND is_builtin = 1 ORDER BY sort_order",
            &[Value::String("default-project".into())],
            "all",
        ).expect("select built-in types");
        assert_eq!(rows.len(), 4);

        // Insert user-defined type
        db.execute(
            "INSERT INTO codex_types (id, project_id, slug, label, color, is_builtin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("custom-org".into()),
                Value::String("default-project".into()),
                Value::String("organization".into()),
                Value::String("組織".into()),
                Value::String("#FF0000".into()),
                Value::Number(0.into()),
                Value::Number(serde_json::Number::from_f64(4.0).unwrap()),
            ],
            "run",
        ).expect("insert custom type");

        // Verify total count
        let rows = db
            .execute(
                "SELECT * FROM codex_types WHERE project_id = ?",
                &[Value::String("default-project".into())],
                "all",
            )
            .expect("select all types");
        assert_eq!(rows.len(), 5);

        // Create codex entry with custom type
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("ce-org".into()),
                Value::String("default-project".into()),
                Value::String("organization".into()),
                Value::String("騎士団".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        ).expect("entry with custom type should succeed");
    }

    // --- codex_tags CRUD ---

    #[test]
    fn test_codex_tags_crud() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_tags (id, project_id, name, color) VALUES (?, ?, ?, ?)",
            &[
                Value::String("tag-crud".into()),
                Value::String("default-project".into()),
                Value::String("重要".into()),
                Value::String("#FF0000".into()),
            ],
            "run",
        )
        .expect("insert tag");

        let rows = db
            .execute(
                "SELECT * FROM codex_tags WHERE id = ?",
                &[Value::String("tag-crud".into())],
                "get",
            )
            .expect("select tag");
        assert_eq!(rows[0]["name"], Value::String("重要".into()));

        // Delete
        db.execute(
            "DELETE FROM codex_tags WHERE id = ?",
            &[Value::String("tag-crud".into())],
            "run",
        )
        .expect("delete tag");
        let rows = db
            .execute(
                "SELECT * FROM codex_tags WHERE id = ?",
                &[Value::String("tag-crud".into())],
                "all",
            )
            .expect("select after delete");
        assert_eq!(rows.len(), 0);
    }

    // --- context_mode CHECK constraint ---

    #[test]
    fn test_context_mode_rejects_invalid_value() {
        let db = test_db();

        let result = db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, context_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("ce-badcm".into()),
                Value::String("default-project".into()),
                Value::String("character".into()),
                Value::String("テスト".into()),
                Value::String("invalid_mode".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        );
        assert!(result.is_err(), "Should reject invalid context_mode");
    }

    // --- authorship_spans CHECK constraint ---

    #[test]
    fn test_authorship_spans_check_rejects_zero_owners() {
        let db = test_db();

        // All three owner columns NULL → CHECK violation
        let result = db.execute(
            "INSERT INTO authorship_spans (id, from_pos, to_pos, source) VALUES (?, ?, ?, ?)",
            &[
                Value::String("span-no-owner".into()),
                Value::Number(0.into()),
                Value::Number(10.into()),
                Value::String("human".into()),
            ],
            "run",
        );
        assert!(
            result.is_err(),
            "Should reject span with no owner (node_id/codex_entry_id/snippet_id all NULL)"
        );
    }

    #[test]
    fn test_authorship_spans_check_rejects_two_owners() {
        let db = test_db();

        // Two owner columns set → CHECK violation
        let result = db.execute(
            "INSERT INTO authorship_spans (id, node_id, codex_entry_id, from_pos, to_pos, source) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("span-two-owners".into()),
                Value::String("default-chapter".into()),
                Value::String("some-codex".into()),
                Value::Number(0.into()),
                Value::Number(10.into()),
                Value::String("ai".into()),
            ],
            "run",
        );
        assert!(result.is_err(), "Should reject span with two owners");
    }

    #[test]
    fn test_authorship_spans_check_accepts_single_owner() {
        let db = test_db();

        // node_id only → OK
        let r1 = db.execute(
            "INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("span-node".into()),
                Value::String("default-chapter".into()),
                Value::Number(0.into()),
                Value::Number(10.into()),
                Value::String("human".into()),
            ],
            "run",
        );
        assert!(r1.is_ok(), "Should accept span with node_id only");
    }

    // --- content_versions cascade delete via triggers ---

    #[test]
    fn test_content_versions_cascade_on_tree_node_delete() {
        let db = test_db();

        // Insert a scene node
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("scene-cv".into()), Value::String("default-project".into()), Value::String("scene".into()), Value::String("シーン".into()), Value::Number(serde_json::Number::from_f64(1.0).unwrap())],
            "run",
        ).expect("insert scene");

        // Insert a content_version referencing the scene
        db.execute(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number) VALUES (?, ?, ?, ?, ?)",
            &[Value::String("cv-1".into()), Value::String("scene".into()), Value::String("scene-cv".into()), Value::String("{}".into()), Value::Number(1.into())],
            "run",
        ).expect("insert version");

        // Delete the scene node
        db.execute(
            "DELETE FROM tree_nodes WHERE id = ?",
            &[Value::String("scene-cv".into())],
            "run",
        )
        .expect("delete scene");

        // content_versions should be cascade-deleted via trigger
        let rows = db
            .execute(
                "SELECT * FROM content_versions WHERE entity_id = ?",
                &[Value::String("scene-cv".into())],
                "all",
            )
            .expect("query");
        assert_eq!(
            rows.len(),
            0,
            "content_versions should be deleted when tree_node is deleted"
        );
    }

    #[test]
    fn test_content_versions_cascade_on_codex_entry_delete() {
        let db = test_db();

        // Insert codex entry
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("ce-cv".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("テスト".into())],
            "run",
        ).expect("insert entry");

        // Insert content_version
        db.execute(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number) VALUES (?, ?, ?, ?, ?)",
            &[Value::String("cv-2".into()), Value::String("codex_entry".into()), Value::String("ce-cv".into()), Value::String("{}".into()), Value::Number(1.into())],
            "run",
        ).expect("insert version");

        // Delete codex entry
        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::String("ce-cv".into())],
            "run",
        )
        .expect("delete entry");

        let rows = db
            .execute(
                "SELECT * FROM content_versions WHERE entity_id = ?",
                &[Value::String("ce-cv".into())],
                "all",
            )
            .expect("query");
        assert_eq!(
            rows.len(),
            0,
            "content_versions should be deleted when codex_entry is deleted"
        );
    }
}
