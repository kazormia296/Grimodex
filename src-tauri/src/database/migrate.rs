use rusqlite::{params, Connection};

use super::Database;

impl Database {
    pub fn migrate(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id                     TEXT PRIMARY KEY,
                title                  TEXT NOT NULL DEFAULT 'Untitled Project',
                genre                  TEXT,
                pov                    TEXT,
                tense                  TEXT,
                language               TEXT NOT NULL DEFAULT 'ja',
                style_guide            TEXT,
                ai_instructions        TEXT,
                outline                TEXT,
                target_readers         TEXT,
                phase_resolution_mode  TEXT NOT NULL DEFAULT 'reading'
                                         CHECK(phase_resolution_mode IN ('reading', 'story', 'auto')),
                created_at             TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS tree_nodes (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                node_type         TEXT NOT NULL CHECK(node_type IN ('folder','scene','note')),
                title             TEXT NOT NULL DEFAULT 'Untitled',
                synopsis          TEXT,
                intent            TEXT,
                sort_order        TEXT NOT NULL DEFAULT 'a0',
                story_time_order  TEXT,
                story_time_label  TEXT,
                pov_character_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                location_id       TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                status            TEXT DEFAULT 'outline'
                                    CHECK(status IS NULL OR status IN ('outline','draft','complete','revision','final')),
                content           TEXT NOT NULL DEFAULT '{}',
                unplaced_beats_doc TEXT NOT NULL DEFAULT '[]',
                char_count        INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_tree_parent
                ON tree_nodes(project_id, parent_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_tree_story_time
                ON tree_nodes(project_id, story_time_order);
            CREATE INDEX IF NOT EXISTS idx_tree_pov
                ON tree_nodes(project_id, pov_character_id)
                WHERE pov_character_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_tree_location
                ON tree_nodes(project_id, location_id)
                WHERE location_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS codex_types (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                slug        TEXT NOT NULL,
                label       TEXT NOT NULL,
                color         TEXT NOT NULL DEFAULT '#888888',
                palette_index INTEGER,
                icon          TEXT,
                is_builtin    INTEGER NOT NULL DEFAULT 0,
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
                icon                    TEXT,
                tags_cache              TEXT,
                context_mode            TEXT NOT NULL DEFAULT 'mentioned'
                                          CHECK(context_mode IN ('always', 'mentioned', 'suppress', 'hidden')),
                children_budget         TEXT NOT NULL DEFAULT 'compact'
                                          CHECK(children_budget IN ('none', 'compact', 'standard', 'generous')),
                source_chat_message_id  TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
                notes                   TEXT,
                created_at              TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
                -- Composite FK: (project_id, type) must reference a row in codex_types.
                -- RESTRICT prevents type deletion while entries exist; CASCADE propagates slug renames.
                FOREIGN KEY (project_id, type) REFERENCES codex_types(project_id, slug)
                  ON UPDATE CASCADE ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_codex_project
                ON codex_entries(project_id, type);
            CREATE INDEX IF NOT EXISTS idx_codex_name
                ON codex_entries(project_id, name);
            CREATE INDEX IF NOT EXISTS idx_codex_parent
                ON codex_entries(parent_id);
            CREATE INDEX IF NOT EXISTS idx_codex_entries_src_msg
                ON codex_entries(source_chat_message_id)
                WHERE source_chat_message_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS codex_quick_pins (
                entry_id   TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_codex_quick_pins_created
                ON codex_quick_pins(created_at);

            CREATE TABLE IF NOT EXISTS codex_dismissed_relations (
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

            CREATE TABLE IF NOT EXISTS labels (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                color       TEXT NOT NULL,
                sort_order  REAL NOT NULL DEFAULT 0.0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_labels_project
                ON labels(project_id);

            CREATE TABLE IF NOT EXISTS tree_node_labels (
                node_id  TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
                PRIMARY KEY (node_id, label_id)
            );
            CREATE INDEX IF NOT EXISTS idx_tree_node_labels_label
                ON tree_node_labels(label_id);

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
                UNIQUE(project_id, type_slug, name),
                -- Composite FK: (project_id, type_slug) must reference a row in codex_types.
                FOREIGN KEY (project_id, type_slug) REFERENCES codex_types(project_id, slug)
                  ON UPDATE CASCADE ON DELETE RESTRICT
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
                tags_cache              TEXT,
                content_source          TEXT CHECK(content_source IS NULL OR content_source IN ('human','ai')),
                scene_id                TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                source_chat_message_id  TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
                usage_count             INTEGER NOT NULL DEFAULT 0,
                created_at              TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_snippets_project
                ON snippets(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_snippets_scene
                ON snippets(scene_id)
                WHERE scene_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_snippets_src_msg
                ON snippets(source_chat_message_id)
                WHERE source_chat_message_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS snippet_entry_tags (
                snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
                tag_id     TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
                PRIMARY KEY (snippet_id, tag_id)
            );
            CREATE INDEX IF NOT EXISTS idx_snippet_entry_tags_tag_id
                ON snippet_entry_tags(tag_id);

            CREATE TABLE IF NOT EXISTS chat_sessions (
                id           TEXT PRIMARY KEY,
                project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_id      TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL, -- chat history survives scene deletion
                title        TEXT NOT NULL DEFAULT 'New session',
                title_manual INTEGER NOT NULL DEFAULT 0,
                model        TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_node
                ON chat_sessions(project_id, node_id);

            -- Normalized pin table: one row per pinned codex entry / snippet
            -- per session. Replaces the former chat_sessions.pinned_codex
            -- JSON blob so FK cascades remove stale refs automatically.
            CREATE TABLE IF NOT EXISTS chat_session_pinned_codex (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                with_children   INTEGER NOT NULL DEFAULT 0,
                pin_source      TEXT NOT NULL DEFAULT 'manual'
                                  CHECK(pin_source IN ('manual','chat_mention')),
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (
                    (CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END) = 1
                )
            );
            CREATE INDEX IF NOT EXISTS idx_chat_pin_session
                ON chat_session_pinned_codex(session_id, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_pin_codex
                ON chat_session_pinned_codex(session_id, codex_entry_id)
                WHERE codex_entry_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_pin_snippet
                ON chat_session_pinned_codex(session_id, snippet_id)
                WHERE snippet_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS chat_messages (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content     TEXT NOT NULL,
                model       TEXT,
                tokens_in   INTEGER,
                tokens_out  INTEGER,
                duration_ms INTEGER,
                metadata      TEXT,
                is_starred    INTEGER NOT NULL DEFAULT 0,
                is_summarized INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session
                ON chat_messages(session_id, created_at);

            CREATE TABLE IF NOT EXISTS generation_logs (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                kind          TEXT NOT NULL CHECK(kind IN ('inline-ai','beat')),
                command_id    TEXT,
                instruction   TEXT,
                prompt_full   TEXT,
                model         TEXT,
                trace_id      TEXT NOT NULL UNIQUE,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_generation_logs_project_trace
                ON generation_logs(project_id, trace_id);
            CREATE INDEX IF NOT EXISTS idx_generation_logs_scene
                ON generation_logs(scene_node_id);

            CREATE TABLE IF NOT EXISTS chat_summaries (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                summary     TEXT NOT NULL,
                token_count INTEGER,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_summaries_session
                ON chat_summaries(session_id, created_at);

            -- Set of messages summarized by each chat_summaries row.
            -- Replaces chat_summaries.source_message_ids JSON array.
            CREATE TABLE IF NOT EXISTS chat_summary_messages (
                summary_id TEXT NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
                message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
                PRIMARY KEY (summary_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_summary_messages_msg
                ON chat_summary_messages(message_id);

            CREATE TABLE IF NOT EXISTS codex_entry_phases (
                id                    TEXT PRIMARY KEY,
                entry_id              TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                anchor_node_id        TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                label                 TEXT NOT NULL DEFAULT '',
                summary_override      TEXT,
                content_override      TEXT,
                context_mode_override TEXT
                                        CHECK(context_mode_override IS NULL OR
                                              context_mode_override IN ('always','mentioned','suppress','hidden')),
                created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_codex_phases_entry
                ON codex_entry_phases(entry_id);
            CREATE INDEX IF NOT EXISTS idx_codex_phases_anchor
                ON codex_entry_phases(anchor_node_id);

            CREATE TABLE IF NOT EXISTS codex_phase_detail_overrides (
                phase_id      TEXT NOT NULL REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
                definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
                value         TEXT,
                PRIMARY KEY (phase_id, definition_id)
            );
            CREATE INDEX IF NOT EXISTS idx_phase_detail_overrides_phase
                ON codex_phase_detail_overrides(phase_id);

            CREATE TABLE IF NOT EXISTS authorship_spans (
                id              TEXT PRIMARY KEY,
                node_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                detail_value_id TEXT REFERENCES codex_detail_values(id) ON DELETE CASCADE,
                from_pos        INTEGER NOT NULL,
                to_pos          INTEGER NOT NULL,
                source          TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
                model           TEXT,
                timestamp       TEXT,
                chat_msg_id     TEXT,
                trace_id        TEXT,
                phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
                -- Exactly one owning document
                CHECK (
                    (CASE WHEN node_id         IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN codex_entry_id  IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id      IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END) = 1
                ),
                -- phase_id (authorship in phase contentOverride) requires codex_entry_id
                CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL)
            );
            CREATE INDEX IF NOT EXISTS idx_authorship_node
                ON authorship_spans(node_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_codex
                ON authorship_spans(codex_entry_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_snippet
                ON authorship_spans(snippet_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_detail
                ON authorship_spans(detail_value_id);
            CREATE INDEX IF NOT EXISTS idx_authorship_phase
                ON authorship_spans(phase_id)
                WHERE phase_id IS NOT NULL;

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
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_project_snapshots
                ON project_snapshots(project_id, created_at DESC);

            -- version_id uses ON DELETE RESTRICT so pruning logic cannot
            -- silently strip a version that is referenced by a snapshot;
            -- the snapshot feature relies on blocking such deletes.
            -- Legacy (pre-structural-snapshot) entries live here; new
            -- snapshots write to project_snapshot_tree_nodes / _codex_entries /
            -- _snippets / _aux below. Restore detects which form is present.
            CREATE TABLE IF NOT EXISTS project_snapshot_entries (
                snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
                version_id  TEXT NOT NULL REFERENCES content_versions(id) ON DELETE RESTRICT,
                PRIMARY KEY (snapshot_id, version_id)
            );

            -- Structural snapshot tables: capture per-row metadata so restore
            -- can recreate deleted entities and revert structural changes
            -- (title / parent / sort_order / status / pov / location ...).
            -- body content stays in content_versions and is referenced by
            -- body_version_id (RESTRICT FK, same protection as legacy entries).
            CREATE TABLE IF NOT EXISTS project_snapshot_tree_nodes (
                snapshot_id        TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
                node_id            TEXT NOT NULL,
                parent_id          TEXT,
                node_type          TEXT NOT NULL,
                title              TEXT NOT NULL,
                synopsis           TEXT,
                intent             TEXT,
                sort_order         TEXT NOT NULL,
                story_time_order   TEXT,
                story_time_label   TEXT,
                pov_character_id   TEXT,
                location_id        TEXT,
                status             TEXT,
                body_version_id    TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
                unplaced_beats_doc TEXT NOT NULL DEFAULT '[]',
                char_count         INTEGER NOT NULL DEFAULT 0,
                -- Original entity timestamps preserved so restore brings
                -- back the real created/updated dates, not the moment of restore.
                created_at         TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (snapshot_id, node_id)
            );

            CREATE TABLE IF NOT EXISTS project_snapshot_codex_entries (
                snapshot_id            TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
                entry_id               TEXT NOT NULL,
                type                   TEXT NOT NULL,
                name                   TEXT NOT NULL,
                parent_id              TEXT,
                aliases                TEXT,
                excluded_aliases       TEXT,
                summary                TEXT,
                icon                   TEXT,
                context_mode           TEXT NOT NULL,
                children_budget        TEXT NOT NULL,
                notes                  TEXT,
                body_version_id        TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
                created_at             TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (snapshot_id, entry_id)
            );

            CREATE TABLE IF NOT EXISTS project_snapshot_snippets (
                snapshot_id            TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
                snippet_id             TEXT NOT NULL,
                title                  TEXT NOT NULL,
                scene_id               TEXT,
                source_chat_message_id TEXT,
                body_version_id        TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
                created_at             TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (snapshot_id, snippet_id)
            );

            -- Aux: per-snapshot, per-scope JSON payload. One row per scope.
            -- payload_json shape is defined in src/features/revision/projectSnapshotScopes.ts.
            CREATE TABLE IF NOT EXISTS project_snapshot_aux (
                snapshot_id  TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
                scope        TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (snapshot_id, scope)
            );

            -- App-wide key-value store (shared across projects). All current
            -- setting keys (editor/display/ai/keys/data/revision/tree/export)
            -- live here since they're user preferences, not project metadata.
            CREATE TABLE IF NOT EXISTS app_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Project-scoped key-value store. Reserved for future keys that
            -- need per-project overrides (e.g. project-specific naming rules).
            -- Currently unused by the app, but the table exists so adding a
            -- project-scoped key later does not require a schema change.
            CREATE TABLE IF NOT EXISTS project_settings (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                PRIMARY KEY (project_id, key)
            );

            -- FTS5 full-text search indexes (trigram tokenizer for Japanese)
            CREATE VIRTUAL TABLE IF NOT EXISTS codex_fts USING fts5(
                name, aliases, summary, tags_cache,
                content=codex_entries, content_rowid=rowid,
                tokenize='trigram'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
                title, content, tags_cache,
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
                INSERT INTO snippets_fts(rowid, title, content, tags_cache)
                VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS snippets_fts_ad AFTER DELETE ON snippets BEGIN
                INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
                VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS snippets_fts_au AFTER UPDATE ON snippets
              WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags_cache IS NOT new.tags_cache
            BEGIN
                INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
                VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache, ''));
                INSERT INTO snippets_fts(rowid, title, content, tags_cache)
                VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache, ''));
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

            -- (Nullify-on-delete behavior for source_chat_message_id / scene_id
            --  is now enforced by FK ON DELETE SET NULL; explicit triggers removed.)

            -- Triggers to cascade-delete content_versions for polymorphic entity_id.
            -- Versions referenced by any project_snapshot_* table are protected
            -- (those FKs are ON DELETE RESTRICT, so an unconditional DELETE
            -- would fail with FOREIGN KEY constraint failed and roll back the
            -- enclosing tree_nodes / codex_entries / snippets delete).
            CREATE TRIGGER IF NOT EXISTS delete_cv_on_tree_node_delete
            AFTER DELETE ON tree_nodes BEGIN
                DELETE FROM content_versions
                WHERE entity_type IN ('scene', 'note')
                  AND entity_id = old.id
                  AND id NOT IN (SELECT version_id FROM project_snapshot_entries)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_tree_nodes WHERE body_version_id IS NOT NULL)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_codex_entries WHERE body_version_id IS NOT NULL)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_snippets WHERE body_version_id IS NOT NULL);
            END;

            CREATE TRIGGER IF NOT EXISTS delete_cv_on_codex_entry_delete
            AFTER DELETE ON codex_entries BEGIN
                DELETE FROM content_versions
                WHERE entity_type = 'codex_entry'
                  AND entity_id = old.id
                  AND id NOT IN (SELECT version_id FROM project_snapshot_entries)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_tree_nodes WHERE body_version_id IS NOT NULL)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_codex_entries WHERE body_version_id IS NOT NULL)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_snippets WHERE body_version_id IS NOT NULL);
            END;

            CREATE TRIGGER IF NOT EXISTS delete_cv_on_snippet_delete
            AFTER DELETE ON snippets BEGIN
                DELETE FROM content_versions
                WHERE entity_type = 'snippet'
                  AND entity_id = old.id
                  AND id NOT IN (SELECT version_id FROM project_snapshot_entries)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_tree_nodes WHERE body_version_id IS NOT NULL)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_codex_entries WHERE body_version_id IS NOT NULL)
                  AND id NOT IN (SELECT body_version_id FROM project_snapshot_snippets WHERE body_version_id IS NOT NULL);
            END;

            -- Seed built-in codex types for every new project
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
            END;

            -- map_boards: per-project boards with viewport/show state
            CREATE TABLE IF NOT EXISTS map_boards (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title         TEXT NOT NULL DEFAULT 'Main',
                sort_order    REAL NOT NULL DEFAULT 0.0,
                mode          TEXT NOT NULL DEFAULT 'free' CHECK(mode IN ('free', 'theme')),
                viewport_x    REAL NOT NULL DEFAULT 0,
                viewport_y    REAL NOT NULL DEFAULT 0,
                viewport_zoom REAL NOT NULL DEFAULT 1.0,
                show_config   TEXT NOT NULL DEFAULT '{}',
                color_by      TEXT NOT NULL DEFAULT 'none',
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_map_boards_project
                ON map_boards(project_id);

            -- map_ai_branches: AI branch seeds (responses live in derived Stickies)
            CREATE TABLE IF NOT EXISTS map_ai_branches (
                id            TEXT PRIMARY KEY,
                board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                prompt        TEXT NOT NULL,
                seed_node_ids TEXT NOT NULL DEFAULT '[]',
                session_id    TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
                model         TEXT,
                token_usage   INTEGER,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_map_ai_branches_board
                ON map_ai_branches(board_id);

            -- map_stickies: Map-only lightweight memos with ProseMirror body.
            -- Color is referenced as (palette_id, color_slot); the palette is
            -- defined in code (see src/lib/stickyPalettes.ts), the slot is an
            -- index into that palette's `colors` array.
            CREATE TABLE IF NOT EXISTS map_stickies (
                id                     TEXT PRIMARY KEY,
                board_id               TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                title                  TEXT,
                body                   TEXT NOT NULL DEFAULT '{\"type\":\"doc\",\"content\":[]}',
                preview_text           TEXT,
                palette_id             TEXT NOT NULL DEFAULT 'post-it-playful',
                color_slot             INTEGER NOT NULL DEFAULT 0
                                         CHECK(color_slot >= 0),
                ai_branch_id           TEXT REFERENCES map_ai_branches(id) ON DELETE SET NULL,
                -- AI由来フラグ。ai_branch_id は「現在の所属 branch」(採用で NULL 化)、
                -- こちらは「AI が生成した付箋か」という出自で採用後も保持する。
                ai_derived             INTEGER NOT NULL DEFAULT 0,
                source_chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
                created_at             TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_map_stickies_board
                ON map_stickies(board_id);
            CREATE INDEX IF NOT EXISTS idx_map_stickies_ai_branch
                ON map_stickies(ai_branch_id);
            CREATE INDEX IF NOT EXISTS idx_map_stickies_chat_msg
                ON map_stickies(source_chat_message_id)
                WHERE source_chat_message_id IS NOT NULL;

            -- map_node_positions: positions for all node types on a board
            CREATE TABLE IF NOT EXISTS map_node_positions (
                id              TEXT PRIMARY KEY,
                board_id        TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                node_ref_type   TEXT NOT NULL
                                    CHECK(node_ref_type IN ('scene','codex','snippet','note','sticky','ai_branch')),
                tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,
                ai_branch_id    TEXT REFERENCES map_ai_branches(id) ON DELETE CASCADE,
                x               REAL NOT NULL,
                y               REAL NOT NULL,
                pinned          INTEGER NOT NULL DEFAULT 0,
                z_index         INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (
                    (CASE WHEN tree_node_id   IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN sticky_id      IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN ai_branch_id   IS NOT NULL THEN 1 ELSE 0 END) = 1
                ),
                CHECK (
                    (node_ref_type IN ('scene','note') AND tree_node_id   IS NOT NULL) OR
                    (node_ref_type = 'codex'           AND codex_entry_id IS NOT NULL) OR
                    (node_ref_type = 'snippet'         AND snippet_id     IS NOT NULL) OR
                    (node_ref_type = 'sticky'          AND sticky_id      IS NOT NULL) OR
                    (node_ref_type = 'ai_branch'       AND ai_branch_id   IS NOT NULL)
                )
            );
            CREATE INDEX IF NOT EXISTS idx_map_pos_board
                ON map_node_positions(board_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_map_pos_uniq_scene
                ON map_node_positions(board_id, tree_node_id)
                WHERE tree_node_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_map_pos_uniq_codex
                ON map_node_positions(board_id, codex_entry_id)
                WHERE codex_entry_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_map_pos_uniq_snippet
                ON map_node_positions(board_id, snippet_id)
                WHERE snippet_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_map_pos_uniq_sticky
                ON map_node_positions(board_id, sticky_id)
                WHERE sticky_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_map_pos_uniq_ai
                ON map_node_positions(board_id, ai_branch_id)
                WHERE ai_branch_id IS NOT NULL;

            -- map_edges: user-drawn edges with bidirectional / multi-label support
            CREATE TABLE IF NOT EXISTS map_edges (
                id                  TEXT PRIMARY KEY,
                board_id            TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                from_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
                to_position_id      TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
                forward_label       TEXT,
                backward_label      TEXT,
                labels              TEXT NOT NULL DEFAULT '[]',
                style               TEXT NOT NULL DEFAULT 'solid'
                                        CHECK(style IN ('solid', 'dashed', 'dotted')),
                color               TEXT NOT NULL DEFAULT '#000000',
                direction           TEXT NOT NULL DEFAULT 'none'
                                        CHECK(direction IN ('none', 'forward', 'bidirectional')),
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_map_edges_board
                ON map_edges(board_id);
            CREATE INDEX IF NOT EXISTS idx_map_edges_from
                ON map_edges(from_position_id);
            CREATE INDEX IF NOT EXISTS idx_map_edges_to
                ON map_edges(to_position_id);

            -- map_frames: grouping frames (visual only, no containment in DB)
            CREATE TABLE IF NOT EXISTS map_frames (
                id            TEXT PRIMARY KEY,
                board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                title         TEXT NOT NULL DEFAULT 'Frame',
                x             REAL NOT NULL,
                y             REAL NOT NULL,
                width         REAL NOT NULL,
                height        REAL NOT NULL,
                background    TEXT NOT NULL DEFAULT '#f5f5f5',
                border_color  TEXT NOT NULL DEFAULT '#cccccc',
                z_index       INTEGER NOT NULL DEFAULT -1,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_map_frames_board
                ON map_frames(board_id);

            -- Lint persistent ignore list (Phase 2)
            CREATE TABLE IF NOT EXISTS lint_ignored_diagnostics (
                id              TEXT PRIMARY KEY,
                rule_id         TEXT NOT NULL,
                scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                text_snippet    TEXT NOT NULL,
                context_before  TEXT NOT NULL,
                context_after   TEXT NOT NULL,
                note            TEXT,
                created_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lint_ignored_scene
                ON lint_ignored_diagnostics(scene_id);
            CREATE INDEX IF NOT EXISTS idx_lint_ignored_rule
                ON lint_ignored_diagnostics(rule_id);

            -- Project-scoped term dictionary driving project/term-consistency.
            -- variants is JSON array of strings; severity is 'warning' | 'info'.
            -- No SQL-level UNIQUE on preferred so duplicate display rows are
            -- allowed (variants are what matter); the CRUD layer enforces
            -- no-duplicate-variant across the table.
            CREATE TABLE IF NOT EXISTS lint_term_dictionary (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                preferred  TEXT NOT NULL,
                variants   TEXT NOT NULL,
                severity   TEXT NOT NULL DEFAULT 'warning',
                note       TEXT,
                enabled    INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lint_term_dict_preferred
                ON lint_term_dictionary(preferred);
            CREATE INDEX IF NOT EXISTS idx_lint_term_dict_sort
                ON lint_term_dictionary(sort_order);
            -- idx_lint_term_dict_project is created in the additive section
            -- below, AFTER add_column_if_missing adds project_id to existing
            -- DBs (the column does not yet exist here on an upgraded DB).

            -- Lint event history (Phase 2-3 writes; schema only for now).
            -- Append-only event log for self-tuning suggestions like
            -- 'you ignore ja/quote-period 80% of the time → turn it off?'.
            -- `scene_id` uses ON DELETE SET NULL (vs CASCADE on the
            -- ignore table) so deleting a scene preserves the historical
            -- record while breaking the FK link.
            CREATE TABLE IF NOT EXISTS lint_action_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id     TEXT NOT NULL,
                action      TEXT NOT NULL,
                scene_id    TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                occurred_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lint_action_log_rule
                ON lint_action_log(rule_id);
            CREATE INDEX IF NOT EXISTS idx_lint_action_log_occurred
                ON lint_action_log(occurred_at);

            -- Seed a default Map board for every new project
            CREATE TRIGGER IF NOT EXISTS seed_default_map_board
            AFTER INSERT ON projects BEGIN
                INSERT OR IGNORE INTO map_boards (id, project_id, title, sort_order, mode, viewport_x, viewport_y, viewport_zoom, show_config, color_by, created_at, updated_at)
                  VALUES (new.id || '-main-board', new.id, 'Main', 0.0, 'free', 0, 0, 1.0, '{}', 'none', datetime('now'), datetime('now'));
            END;

            -- Seed default project (folder is no longer auto-created so the workspace can stay empty)
            INSERT OR IGNORE INTO projects (id, title, language, created_at, updated_at)
              VALUES ('default-project', '無題のプロジェクト', 'ja', datetime('now'), datetime('now'));",
        )?;

        // Foreshadow register tables (added post-initial schema)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS foreshadows (
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title            TEXT NOT NULL,
                intent           TEXT,
                notes            TEXT,
                payoff_scene_id  TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                payoff_from_pos  INTEGER,
                payoff_to_pos    INTEGER,
                payoff_confirmed INTEGER NOT NULL DEFAULT 0,
                abandoned        INTEGER NOT NULL DEFAULT 0,
                secret           INTEGER NOT NULL DEFAULT 1,
                load_bearing     TEXT,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_foreshadows_project
                ON foreshadows(project_id);
            CREATE INDEX IF NOT EXISTS idx_foreshadows_payoff_scene
                ON foreshadows(payoff_scene_id);

            CREATE TABLE IF NOT EXISTS foreshadow_setups (
                id                 TEXT PRIMARY KEY,
                foreshadow_id      TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
                scene_id           TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                from_pos           INTEGER NOT NULL,
                to_pos             INTEGER NOT NULL,
                kind               TEXT NOT NULL,
                strength           TEXT,
                ai_strength        TEXT,
                ai_reasoning       TEXT,
                attribution        TEXT NOT NULL DEFAULT 'human',
                ai_rationale       TEXT,
                last_evaluated_at  INTEGER,
                is_orphan          INTEGER NOT NULL DEFAULT 0,
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_fs_setup_fid
                ON foreshadow_setups(foreshadow_id);
            CREATE INDEX IF NOT EXISTS idx_fs_setup_scene
                ON foreshadow_setups(scene_id);
            CREATE INDEX IF NOT EXISTS idx_fs_setup_orphan
                ON foreshadow_setups(is_orphan);

            CREATE TABLE IF NOT EXISTS foreshadow_codex_links (
                foreshadow_id   TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
                codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                PRIMARY KEY (foreshadow_id, codex_entry_id)
            );
            CREATE INDEX IF NOT EXISTS idx_fs_codex_codex
                ON foreshadow_codex_links(codex_entry_id);",
        )?;

        // Beat system (Phase B) — role-aware codex mention cache per scene.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS scene_codex_mentions (
                scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                source          TEXT NOT NULL,
                role            TEXT NOT NULL DEFAULT 'mentioned',
                PRIMARY KEY (scene_id, codex_entry_id, source)
            );
            CREATE INDEX IF NOT EXISTS idx_scm_codex ON scene_codex_mentions(codex_entry_id);
            CREATE INDEX IF NOT EXISTS idx_scm_scene  ON scene_codex_mentions(scene_id);",
        )?;

        // Beat system (Phase A) — additive columns on tree_nodes.
        // Existing DBs miss these because CREATE TABLE IF NOT EXISTS won't add columns.
        Self::add_column_if_missing(
            &conn,
            "tree_nodes",
            "unplaced_beats_doc",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "tree_nodes",
            "char_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(&conn, "tree_nodes", "unplaced_beat_preview", "TEXT")?;
        Self::add_column_if_missing(&conn, "tree_nodes", "placed_beat_preview", "TEXT")?;

        // External MD mount — file-backed scene metadata (additive).
        Self::add_column_if_missing(&conn, "tree_nodes", "source_uri", "TEXT")?;
        Self::add_column_if_missing(&conn, "tree_nodes", "source_mtime", "TEXT")?;
        Self::add_column_if_missing(&conn, "tree_nodes", "archived_at", "TEXT")?;

        // Phase 4 (chat outline): projects.outline は既存 DB に対する additive 追加。
        // 著者が手書きする物語全体の outline を保持し、AI コンテキスト L2 に常時注入される。
        Self::add_column_if_missing(&conn, "projects", "outline", "TEXT")?;

        // AI Policy: プロジェクト単位の AI 使用方針 (chat/bodyWrite/analysis/structureWrite トグル)。
        // デフォルトは Full プリセット (全機能有効)。既存 DB で structureWrite 欠損の行は
        // フロントの parseAiPolicy が stored preset から導出するため migration は不要。
        Self::add_column_if_missing(
            &conn,
            "projects",
            "ai_policy",
            "TEXT NOT NULL DEFAULT '{\"preset\":\"full\",\"toggles\":{\"chat\":true,\"bodyWrite\":true,\"analysis\":true,\"structureWrite\":true}}'",
        )?;

        // Onboarding: mark sample workspace projects so EditorScreen can
        // trigger SampleTour on first open.
        Self::add_column_if_missing(&conn, "projects", "is_sample", "INTEGER NOT NULL DEFAULT 0")?;

        // Grid panel — Scene×Codex explicit pins (many-to-many).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS scene_codex_pins (
                scene_id   TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                entry_id   TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (scene_id, entry_id)
            );
            CREATE INDEX IF NOT EXISTS idx_scene_codex_pins_scene ON scene_codex_pins(scene_id);
            CREATE INDEX IF NOT EXISTS idx_scene_codex_pins_entry ON scene_codex_pins(entry_id);",
        )?;

        // Map Stickies: add sticky_id to authorship_spans (additive column)
        Self::add_column_if_missing(
            &conn,
            "authorship_spans",
            "sticky_id",
            "TEXT REFERENCES map_stickies(id) ON DELETE CASCADE",
        )?;
        Self::add_column_if_missing(&conn, "authorship_spans", "trace_id", "TEXT")?;

        // AI provenance logs for forward capture of slash/Beat generation.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS generation_logs (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                kind          TEXT NOT NULL CHECK(kind IN ('inline-ai','beat')),
                command_id    TEXT,
                instruction   TEXT,
                prompt_full   TEXT,
                model         TEXT,
                trace_id      TEXT NOT NULL UNIQUE,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_generation_logs_project_trace
                ON generation_logs(project_id, trace_id);
            CREATE INDEX IF NOT EXISTS idx_generation_logs_scene
                ON generation_logs(scene_node_id);",
        )?;

        // Extend authorship_spans CHECK to allow sticky_id as a 5th exclusive owner.
        Self::migrate_authorship_spans_check_with_sticky(&conn)?;

        // Foreshadow secret flag — existing records default false (backwards-compat)
        Self::add_column_if_missing(&conn, "foreshadows", "secret", "INTEGER NOT NULL DEFAULT 0")?;

        // 想定読者プロフィール (kouetsu 疑似コメント「ターゲット読者層」ペルソナの実体)。
        // 既存プロジェクトは NULL = 未設定 (ターゲット読者層ペルソナは選択不可)。
        Self::add_column_if_missing(&conn, "projects", "target_readers", "TEXT")?;

        // lint_term_dictionary を project スコープ化 (project_id 追加)。旧 DB の
        // 用語辞書はワークスペース共有だったため、最古プロジェクトへ寄せる。
        // ALTER では FK/NOT NULL を付けられないため列は nullable で追加し、
        // backfill 後に孤児行 (project が 1 つも無い DB) を掃除する。新規 DB は
        // CREATE TABLE 側で NOT NULL FK 付きで作られる。
        Self::add_column_if_missing(&conn, "lint_term_dictionary", "project_id", "TEXT")?;
        conn.execute_batch(
            "UPDATE lint_term_dictionary
                SET project_id = (
                    SELECT id FROM projects ORDER BY created_at ASC, rowid ASC LIMIT 1
                )
              WHERE project_id IS NULL;
             DELETE FROM lint_term_dictionary WHERE project_id IS NULL;
             CREATE INDEX IF NOT EXISTS idx_lint_term_dict_project
                 ON lint_term_dictionary(project_id);",
        )?;

        // Note AI context injection (Phase A): context_mode / aliases on tree_nodes.
        Self::migrate_tree_nodes_note_context(&conn)?;
        Self::migrate_tree_nodes_intent(&conn)?;

        // Chat session pins: extend codex/snippet CHECK to include sticky (Phase D).
        Self::migrate_chat_session_pinned_add_sticky(&conn)?;

        // Codex typed relations (Phase C): Map User edge promotion target.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS codex_relations (
                id                  TEXT PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                relation_type       TEXT NOT NULL DEFAULT 'custom',
                label               TEXT,
                depth_hint          INTEGER,
                source_map_edge_id  TEXT,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_codex_relations_project
                ON codex_relations(project_id);
            CREATE INDEX IF NOT EXISTS idx_codex_relations_from
                ON codex_relations(from_codex_id);
            CREATE INDEX IF NOT EXISTS idx_codex_relations_to
                ON codex_relations(to_codex_id);",
        )?;
        Self::migrate_codex_relations_source_map_edge_id(&conn)?;

        // Beat-level POV override cache for Matrix ★ display.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS scene_beat_pov_cache (
                scene_id          TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                pov_character_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                PRIMARY KEY (scene_id, pov_character_id)
            );
            CREATE INDEX IF NOT EXISTS idx_scene_beat_pov_scene ON scene_beat_pov_cache(scene_id);",
        )?;

        // Sticky color: enum text → (palette_id, color_slot). Existing DBs
        // still have the old `color` column; rebuild the table to migrate.
        Self::migrate_stickies_color_to_palette_slot(&conn)?;

        // delete_cv_on_*_delete triggers originally dropped *all* content_versions
        // for the deleted entity. Versions referenced by a snapshot entry have
        // ON DELETE RESTRICT, so the trigger would fail with FOREIGN KEY
        // constraint failed and abort the enclosing delete. Existing DBs still
        // hold the buggy CREATE TRIGGER IF NOT EXISTS definitions; drop them
        // here so the recreated batch above installs the snapshot-aware version.
        Self::migrate_cv_triggers_protect_snapshot_versions(&conn)?;

        // PostEffects — 書き換えずに注釈を重ねる AI パスの実行単位と成果物。
        // 設計詳細は docs/Grimodex_PostEffects設計書.md。
        // enum CHECK と FTS5 仮想テーブル/トリガはここに直書きする（Drizzle では表現不可）。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS post_effect_runs (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                effect_type     TEXT NOT NULL
                                  CHECK(effect_type IN ('review','pseudo_comment','meta_structure','consistency','intra_scene_consistency','typo_detection','intent_drift','timeline_consistency')),
                scope_type      TEXT NOT NULL
                                  CHECK(scope_type IN ('scene','folder','project')),
                scope_target_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                model           TEXT NOT NULL,
                prompt_version  TEXT NOT NULL,
                input_hash      TEXT,
                status          TEXT NOT NULL
                                  CHECK(status IN ('running','completed','failed','cancelled')),
                summary         TEXT,
                error_message   TEXT,
                started_at      TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_runs_project_effect
                ON post_effect_runs(project_id, effect_type, started_at DESC);
            -- 同じ (project, effect_type, scope) で running は同時 1 本まで。
            -- SQLite は NULL を distinct 扱いするため COALESCE で空文字に正規化する
            -- (project 全体スコープ scope_target_id IS NULL も含めて単一性を保つ)。
            CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_running_scope
                ON post_effect_runs(project_id, effect_type, scope_type, COALESCE(scope_target_id, ''))
                WHERE status = 'running';

            CREATE TABLE IF NOT EXISTS post_effect_annotations (
                id             TEXT PRIMARY KEY,
                project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id         TEXT REFERENCES post_effect_runs(id) ON DELETE SET NULL,
                anchor_type    TEXT NOT NULL DEFAULT 'scene_range'
                                  CHECK(anchor_type IN ('scene_range','codex_entry','synopsis')),
                scene_id       TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                range_start    INTEGER,
                range_end      INTEGER,
                text_snapshot  TEXT,
                category       TEXT NOT NULL
                                  CHECK(category IN ('review','pseudo_comment','consistency_anchor','foreshadow_anchor','theme_anchor','typo_anchor','intent_anchor','timeline_anchor')),
                persona        TEXT,
                severity       TEXT CHECK(severity IS NULL OR severity IN ('info','suggestion','warning','error')),
                content        TEXT NOT NULL,
                author_role    TEXT NOT NULL DEFAULT 'ai'
                                  CHECK(author_role IN ('ai','user','system')),
                parent_id      TEXT REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
                status         TEXT NOT NULL DEFAULT 'open'
                                  CHECK(status IN ('open','resolved','dismissed')),
                metadata       TEXT NOT NULL DEFAULT '{}',
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_pea_scene
                ON post_effect_annotations(project_id, scene_id, status);
            CREATE INDEX IF NOT EXISTS idx_pea_run
                ON post_effect_annotations(run_id);
            CREATE INDEX IF NOT EXISTS idx_pea_parent
                ON post_effect_annotations(parent_id);

            -- FTS5: annotation の content を横断検索する。
            -- 既存 chat_messages_fts と同じ external-content + trigger 同期方式。
            CREATE VIRTUAL TABLE IF NOT EXISTS post_effect_annotations_fts USING fts5(
                content,
                content=post_effect_annotations, content_rowid=rowid,
                tokenize='trigram'
            );
            CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_ai
              AFTER INSERT ON post_effect_annotations BEGIN
                INSERT INTO post_effect_annotations_fts(rowid, content)
                VALUES (new.rowid, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_ad
              AFTER DELETE ON post_effect_annotations BEGIN
                INSERT INTO post_effect_annotations_fts(post_effect_annotations_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_au
              AFTER UPDATE ON post_effect_annotations
              WHEN old.content IS NOT new.content
            BEGIN
                INSERT INTO post_effect_annotations_fts(post_effect_annotations_fts, rowid, content)
                VALUES ('delete', old.rowid, old.content);
                INSERT INTO post_effect_annotations_fts(rowid, content)
                VALUES (new.rowid, new.content);
            END;

            CREATE TABLE IF NOT EXISTS post_effect_annotation_relations (
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id           TEXT REFERENCES post_effect_runs(id) ON DELETE SET NULL,
                annotation_a_id  TEXT NOT NULL REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
                annotation_b_id  TEXT NOT NULL REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
                relation_type    TEXT NOT NULL
                                   CHECK(relation_type IN ('contradiction','foreshadowing','theme_echo')),
                direction        TEXT NOT NULL DEFAULT 'bidirectional'
                                   CHECK(direction IN ('bidirectional','a_to_b')),
                description      TEXT,
                status           TEXT NOT NULL DEFAULT 'open'
                                   CHECK(status IN ('open','resolved','dismissed')),
                metadata         TEXT NOT NULL DEFAULT '{}',
                created_at       TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_pear_a
                ON post_effect_annotation_relations(annotation_a_id);
            CREATE INDEX IF NOT EXISTS idx_pear_b
                ON post_effect_annotation_relations(annotation_b_id);

            CREATE TABLE IF NOT EXISTS scene_lens_data (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id      TEXT NOT NULL REFERENCES post_effect_runs(id) ON DELETE CASCADE,
                target_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                lens_type   TEXT NOT NULL
                              CHECK(lens_type IN ('plot_structure','pacing','character_arc','pov')),
                metrics     TEXT NOT NULL DEFAULT '{}',
                finding     TEXT,
                severity    TEXT NOT NULL DEFAULT 'info'
                              CHECK(severity IN ('info','suggestion','warning','error')),
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_lens_run_target
                ON scene_lens_data(run_id, target_id);
            CREATE INDEX IF NOT EXISTS idx_lens_target_type
                ON scene_lens_data(target_id, lens_type);",
        )?;

        // 既存 DB の post_effect_runs / post_effect_annotations CHECK 制約に
        // typo_detection / typo_anchor を追加 (新 DB は上の CREATE TABLE で済)。
        Self::migrate_post_effect_typo_categories(&conn)?;
        Self::migrate_post_effect_intent_categories(&conn)?;
        // intent migration の後でなければ .replace ターゲットがズレるので順序厳守。
        Self::migrate_post_effect_timeline_categories(&conn)?;

        // PostEffect クラッシュリカバリ: プロセス強制終了等で running のまま残った run を
        // 起動時に failed へ落とす。idx_runs_running_scope の UNIQUE が次回起動を
        // ブロックするのを防ぐ目的も兼ねる。設計書 §run のステータス遷移 を参照。
        conn.execute(
            "UPDATE post_effect_runs
                SET status = 'failed',
                    error_message = COALESCE(error_message, 'Process terminated unexpectedly'),
                    completed_at = datetime('now')
              WHERE status = 'running'",
            [],
        )?;

        // Trash bin (削除物の物理ゴミ箱) — Phase 1 では文字屑のみ書き込む。
        // payload / preview_meta は素の TEXT で JSON.stringify を保持。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS trash_items (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind            TEXT NOT NULL,
                sub_kind        TEXT NOT NULL,
                origin_scene_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                origin_codex_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                preview_text    TEXT NOT NULL,
                preview_meta    TEXT,
                payload         TEXT NOT NULL,
                char_count      INTEGER NOT NULL,
                is_interesting  INTEGER NOT NULL DEFAULT 0,
                deleted_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_trash_project_deleted
                ON trash_items(project_id, deleted_at DESC);
            CREATE INDEX IF NOT EXISTS idx_trash_project_kind_deleted
                ON trash_items(project_id, kind, deleted_at DESC);

            -- Semantic search: 本文 prose の埋め込みチャンクを保存する。
            -- Drizzle schema (src/db/schema.ts) と完全一致させる。
            -- created_at / updated_at は ms-since-epoch INTEGER。Drizzle の mode: 'timestamp'
            -- は Date を ms-INTEGER で serialize するため SQL DEFAULT は付けない。
            -- 詳細: temp/semantic-prose-search-context.md §3.1。
            CREATE TABLE IF NOT EXISTS scene_chunks (
                id               TEXT PRIMARY KEY,
                scene_id         TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                chunk_index      INTEGER NOT NULL,
                text             TEXT NOT NULL,
                char_start       INTEGER NOT NULL,
                char_end         INTEGER NOT NULL,
                dialogue_ratio   REAL NOT NULL DEFAULT 0,
                embedding        BLOB NOT NULL,
                embedding_dim    INTEGER NOT NULL,
                model_id         TEXT NOT NULL,
                content_hash     TEXT NOT NULL,
                chunker_version  TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_scene_chunks_scene
                ON scene_chunks(scene_id);
            CREATE INDEX IF NOT EXISTS idx_scene_chunks_model
                ON scene_chunks(model_id);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_scene_chunks_scene_index
                ON scene_chunks(scene_id, chunk_index);",
        )?;

        // Chat summaries: generation tracking for Tier-based progressive summarization.
        Self::add_column_if_missing(
            &conn,
            "chat_summaries",
            "generation",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        Self::add_column_if_missing(
            &conn,
            "chat_summaries",
            "source_msg_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            &conn,
            "chat_summaries",
            "last_msg_id",
            "TEXT REFERENCES chat_messages(id) ON DELETE SET NULL",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_summaries_generation
                ON chat_summaries(session_id, generation);",
        )?;

        // 執筆タイムラプス: append-only change event log + state snapshots.
        // See src/db/schema.ts changeEvents / stateSnapshots for the TS-side
        // schema and src/features/timelapse/recorder.ts for the write window.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS change_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid    TEXT,
                project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                scene_id     TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                domain       TEXT NOT NULL,
                op_type      TEXT NOT NULL,
                entity_type  TEXT,
                entity_id    TEXT,
                payload      TEXT NOT NULL,
                session_id   TEXT NOT NULL,
                sequence     INTEGER NOT NULL,
                timestamp    INTEGER NOT NULL,
                prev_hash    TEXT NOT NULL,
                hash         TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_change_events_project_ts
                ON change_events(project_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_change_events_scene_ts
                ON change_events(scene_id, timestamp);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_change_events_project_seq
                ON change_events(project_id, sequence);

            CREATE TABLE IF NOT EXISTS state_snapshots (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                domain            TEXT NOT NULL,
                entity_type       TEXT,
                entity_id         TEXT,
                anchor_sequence   INTEGER NOT NULL,
                anchor_timestamp  INTEGER NOT NULL,
                payload           TEXT NOT NULL,
                encoding          TEXT NOT NULL DEFAULT 'json',
                created_at        INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_state_snap_project_seq
                ON state_snapshots(project_id, anchor_sequence);
            CREATE INDEX IF NOT EXISTS idx_state_snap_domain_seq
                ON state_snapshots(project_id, domain, anchor_sequence);",
        )?;
        Self::add_column_if_missing(&conn, "change_events", "event_uid", "TEXT")?;
        // The unique index MUST be created here, AFTER add_column_if_missing.
        // On a pre-event_uid DB the column does not exist until that call, so an
        // in-batch `CREATE INDEX ... (event_uid)` would fail with "no such
        // column" (IF NOT EXISTS only suppresses duplicate index *names*, not
        // column-resolution errors). All-NULL legacy event_uid values are safe:
        // SQLite treats NULLs as distinct in a UNIQUE index.
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_change_events_project_uid
                ON change_events(project_id, event_uid);",
        )?;

        // Sticky 採用/不採用 (Plan B): AI由来 provenance を branch 所属から分離。
        // ai_branch_id は採用 (adopt) で NULL 化されるため、「AI が生成した付箋か」
        // という出自は別カラムで保持する。StickyNode の onCopy 帰属ラベルはこれを見る。
        // 既存 DB 用の additive 追加 (新規 DB は CREATE TABLE 側で付与済)。
        Self::add_column_if_missing(
            &conn,
            "map_stickies",
            "ai_derived",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        // 既存 branch 由来の付箋を遡及マーク。ai_derived = 1 のみ対象なので冪等。
        conn.execute(
            "UPDATE map_stickies SET ai_derived = 1 \
             WHERE ai_branch_id IS NOT NULL AND ai_derived = 0",
            [],
        )?;

        // AI usage ledger (N4): append-only per-generation token/cost record
        // spanning ALL AI generation surfaces (chat, agent, map branch, tree
        // scaffold, beat, foreshadow, inline-ai, synopsis, session title,
        // summarization, context creator). One row per LLM generation. Mirrors
        // src/db/schema.ts aiUsage. tokens_in/tokens_out/cost_usd are nullable:
        // streaming providers that do not opt into usage (and aborted streams)
        // deliver no usage, but the row is still recorded so invocations are
        // counted. scene_node_id is SET NULL (not CASCADE) on scene deletion so
        // historical spend survives; project deletion CASCADEs the whole ledger.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_usage (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface       TEXT NOT NULL,
                scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                model         TEXT,
                provider      TEXT,
                tokens_in     INTEGER,
                tokens_out    INTEGER,
                cache_read_tokens  INTEGER,
                cache_write_tokens INTEGER,
                cost_usd      REAL,
                duration_ms   INTEGER,
                trace_id      TEXT,
                ref_id        TEXT,
                metadata      TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ai_usage_project_created
                ON ai_usage(project_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_ai_usage_project_surface
                ON ai_usage(project_id, surface);",
        )?;

        // N4: prompt cache 計測列を ai_usage に追加。CREATE TABLE の直後に置くこと —
        // 既存 DB は IF NOT EXISTS が no-op → ここで列を ALTER 追加、新規 DB は上の
        // CREATE で列付きで作られ ここは no-op。CREATE より前に呼ぶと fresh DB で
        // 「no such table」になる (add_column_if_missing は欠落テーブルを ALTER する)。
        Self::migrate_ai_usage_cache_tokens(&conn)?;

        Ok(())
    }

    /// One-shot migration: drop legacy `color` enum column from map_stickies
    /// and replace with `palette_id` + `color_slot`. Old color names map to
    /// post-it-playful slots 0..5; gray/white fall back to slot 0.
    /// 既存 DB の post_effect_runs.effect_type / post_effect_annotations.category の
    /// CHECK 制約に `typo_detection` / `typo_anchor` を追加する。
    ///
    /// CHECK を緩める方向 (許容値の追加) のみで既存データに矛盾は生じないため、
    /// `writable_schema` で sqlite_master.sql を直接書き換える方式を採る
    /// (テーブル再構築より影響範囲が小さく、FTS5/triggers/indexes/外部 FK の
    /// 取り回しが要らない)。冪等性は CHECK 文字列の中に新値が含まれるかで判定。
    pub(super) fn migrate_post_effect_typo_categories(conn: &Connection) -> anyhow::Result<()> {
        let runs_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_effect_runs'",
                [],
                |row| row.get(0),
            )
            .ok();
        let anns_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_effect_annotations'",
                [],
                |row| row.get(0),
            )
            .ok();

        let runs_needs = runs_sql
            .as_deref()
            .is_some_and(|s| !s.contains("typo_detection"));
        let anns_needs = anns_sql
            .as_deref()
            .is_some_and(|s| !s.contains("typo_anchor"));

        if !runs_needs && !anns_needs {
            return Ok(());
        }

        // schema_version を bump して次の statement で sqlite が schema を読み直すよう促す
        let current_version: i64 = conn.query_row("PRAGMA schema_version", [], |row| row.get(0))?;

        conn.pragma_update(None, "writable_schema", true)?;

        if runs_needs {
            if let Some(old) = runs_sql {
                let new = old.replace(
                    "'consistency','intra_scene_consistency')",
                    "'consistency','intra_scene_consistency','typo_detection')",
                );
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_runs'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_runs CHECK constraint not in expected form; skipping typo_detection migration"
                    );
                }
            }
        }

        if anns_needs {
            if let Some(old) = anns_sql {
                let new = old.replace(
                    "'foreshadow_anchor','theme_anchor')",
                    "'foreshadow_anchor','theme_anchor','typo_anchor')",
                );
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_annotations'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_annotations CHECK constraint not in expected form; skipping typo_anchor migration"
                    );
                }
            }
        }

        conn.pragma_update(None, "schema_version", current_version + 1)?;
        conn.pragma_update(None, "writable_schema", false)?;

        // 反映を確認: integrity_check が ok を返さなければ巻き戻して bail
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            anyhow::bail!("integrity_check failed after typo CHECK widening: {integrity}");
        }

        Ok(())
    }

    /// 既存 DB の post_effect CHECK に `intent_drift` / `intent_anchor` を追加する。
    pub(super) fn migrate_post_effect_intent_categories(conn: &Connection) -> anyhow::Result<()> {
        let runs_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_effect_runs'",
                [],
                |row| row.get(0),
            )
            .ok();
        let anns_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_effect_annotations'",
                [],
                |row| row.get(0),
            )
            .ok();

        let runs_needs = runs_sql
            .as_deref()
            .is_some_and(|s| !s.contains("intent_drift"));
        let anns_needs = anns_sql
            .as_deref()
            .is_some_and(|s| !s.contains("intent_anchor"));

        if !runs_needs && !anns_needs {
            return Ok(());
        }

        let current_version: i64 = conn.query_row("PRAGMA schema_version", [], |row| row.get(0))?;

        conn.pragma_update(None, "writable_schema", true)?;

        if runs_needs {
            if let Some(old) = runs_sql {
                let new = old.replace("'typo_detection')", "'typo_detection','intent_drift')");
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_runs'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_runs CHECK constraint not in expected form; skipping intent_drift migration"
                    );
                }
            }
        }

        if anns_needs {
            if let Some(old) = anns_sql {
                let new = old.replace("'typo_anchor')", "'typo_anchor','intent_anchor')");
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_annotations'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_annotations CHECK constraint not in expected form; skipping intent_anchor migration"
                    );
                }
            }
        }

        conn.pragma_update(None, "schema_version", current_version + 1)?;
        conn.pragma_update(None, "writable_schema", false)?;

        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            anyhow::bail!("integrity_check failed after intent CHECK widening: {integrity}");
        }

        Ok(())
    }

    /// 既存 DB の post_effect CHECK に `timeline_consistency` / `timeline_anchor` を追加する。
    ///
    /// intent migration の **後** に走るため、.replace のターゲットは intent 追加済の
    /// CHECK 文字列 (`'intent_drift')` / `'intent_anchor')`) でなければならない。ズレると
    /// 一致せず silent no-op (warn) になり、既存 DB が timeline effect を insert 不能になる。
    pub(super) fn migrate_post_effect_timeline_categories(conn: &Connection) -> anyhow::Result<()> {
        let runs_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_effect_runs'",
                [],
                |row| row.get(0),
            )
            .ok();
        let anns_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_effect_annotations'",
                [],
                |row| row.get(0),
            )
            .ok();

        let runs_needs = runs_sql
            .as_deref()
            .is_some_and(|s| !s.contains("timeline_consistency"));
        let anns_needs = anns_sql
            .as_deref()
            .is_some_and(|s| !s.contains("timeline_anchor"));

        if !runs_needs && !anns_needs {
            return Ok(());
        }

        let current_version: i64 = conn.query_row("PRAGMA schema_version", [], |row| row.get(0))?;

        conn.pragma_update(None, "writable_schema", true)?;

        if runs_needs {
            if let Some(old) = runs_sql {
                let new = old.replace("'intent_drift')", "'intent_drift','timeline_consistency')");
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_runs'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_runs CHECK constraint not in expected form; skipping timeline_consistency migration"
                    );
                }
            }
        }

        if anns_needs {
            if let Some(old) = anns_sql {
                let new = old.replace("'intent_anchor')", "'intent_anchor','timeline_anchor')");
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_annotations'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_annotations CHECK constraint not in expected form; skipping timeline_anchor migration"
                    );
                }
            }
        }

        conn.pragma_update(None, "schema_version", current_version + 1)?;
        conn.pragma_update(None, "writable_schema", false)?;

        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            anyhow::bail!("integrity_check failed after timeline CHECK widening: {integrity}");
        }

        Ok(())
    }

    /// One-shot migration: add scene intent column to tree_nodes and snapshot mirror.
    pub(super) fn migrate_tree_nodes_intent(conn: &Connection) -> anyhow::Result<()> {
        Self::add_column_if_missing(conn, "tree_nodes", "intent", "TEXT")?;
        Self::add_column_if_missing(conn, "project_snapshot_tree_nodes", "intent", "TEXT")?;
        Ok(())
    }

    pub(super) fn migrate_stickies_color_to_palette_slot(conn: &Connection) -> anyhow::Result<()> {
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(map_stickies)")?
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<Result<_, _>>()?;
        let has_legacy_color = columns.iter().any(|c| c == "color");
        if !has_legacy_color {
            return Ok(());
        }
        conn.execute_batch(
            "BEGIN;
            CREATE TABLE map_stickies_new (
                id                     TEXT PRIMARY KEY,
                board_id               TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                title                  TEXT,
                body                   TEXT NOT NULL DEFAULT '{\"type\":\"doc\",\"content\":[]}',
                preview_text           TEXT,
                palette_id             TEXT NOT NULL DEFAULT 'post-it-playful',
                color_slot             INTEGER NOT NULL DEFAULT 0
                                         CHECK(color_slot >= 0),
                ai_branch_id           TEXT REFERENCES map_ai_branches(id) ON DELETE SET NULL,
                source_chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
                created_at             TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO map_stickies_new
                (id, board_id, title, body, preview_text, palette_id, color_slot,
                 ai_branch_id, source_chat_message_id, created_at, updated_at)
            SELECT
                id, board_id, title, body, preview_text,
                'post-it-playful',
                CASE color
                    WHEN 'yellow' THEN 0
                    WHEN 'orange' THEN 1
                    WHEN 'pink'   THEN 2
                    WHEN 'green'  THEN 3
                    WHEN 'blue'   THEN 4
                    WHEN 'purple' THEN 5
                    ELSE 0
                END,
                ai_branch_id, source_chat_message_id, created_at, updated_at
            FROM map_stickies;
            DROP TABLE map_stickies;
            ALTER TABLE map_stickies_new RENAME TO map_stickies;
            CREATE INDEX IF NOT EXISTS idx_map_stickies_board
                ON map_stickies(board_id);
            CREATE INDEX IF NOT EXISTS idx_map_stickies_ai_branch
                ON map_stickies(ai_branch_id);
            CREATE INDEX IF NOT EXISTS idx_map_stickies_chat_msg
                ON map_stickies(source_chat_message_id)
                WHERE source_chat_message_id IS NOT NULL;
            COMMIT;",
        )?;
        Ok(())
    }

    /// One-shot migration: add Note AI context columns to tree_nodes.
    /// Non-note rows keep context_mode NULL; existing notes default to 'mentioned'.
    pub(super) fn migrate_tree_nodes_note_context(conn: &Connection) -> anyhow::Result<()> {
        Self::add_column_if_missing(conn, "tree_nodes", "context_mode", "TEXT")?;
        Self::add_column_if_missing(conn, "tree_nodes", "aliases", "TEXT NOT NULL DEFAULT '[]'")?;
        Self::add_column_if_missing(
            conn,
            "tree_nodes",
            "excluded_aliases",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        conn.execute_batch(
            "UPDATE tree_nodes SET context_mode = 'mentioned'
             WHERE node_type = 'note' AND context_mode IS NULL;",
        )?;
        Ok(())
    }

    /// One-shot migration: add prompt-cache token columns to ai_usage (N4).
    /// 既存 DB の CREATE TABLE IF NOT EXISTS は列を足さないため明示 ADD COLUMN。
    /// 既存行は NULL (= 当時はキャッシュ未計測) のまま、集計側で 0 扱い。
    pub(super) fn migrate_ai_usage_cache_tokens(conn: &Connection) -> anyhow::Result<()> {
        Self::add_column_if_missing(conn, "ai_usage", "cache_read_tokens", "INTEGER")?;
        Self::add_column_if_missing(conn, "ai_usage", "cache_write_tokens", "INTEGER")?;
        Ok(())
    }

    /// One-shot migration: extend chat_session_pinned_codex CHECK to allow sticky_id.
    /// SQLite cannot ALTER CHECK constraints — table rebuild required (down not supported).
    pub(super) fn migrate_chat_session_pinned_add_sticky(conn: &Connection) -> anyhow::Result<()> {
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(chat_session_pinned_codex)")?
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<Result<_, _>>()?;
        if columns.iter().any(|c| c == "sticky_id") {
            return Ok(());
        }
        // PRAGMA foreign_keys has no effect inside a transaction; disable before BEGIN.
        conn.pragma_update(None, "foreign_keys", false)?;
        conn.execute_batch(
            "BEGIN;
            CREATE TABLE chat_session_pinned_codex_new (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,
                with_children   INTEGER NOT NULL DEFAULT 0,
                pin_source      TEXT NOT NULL DEFAULT 'manual'
                                  CHECK(pin_source IN ('manual','chat_mention')),
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (
                    (CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN sticky_id      IS NOT NULL THEN 1 ELSE 0 END) = 1
                )
            );
            INSERT INTO chat_session_pinned_codex_new
                (id, session_id, codex_entry_id, snippet_id, sticky_id,
                 with_children, pin_source, created_at)
            SELECT id, session_id, codex_entry_id, snippet_id, NULL,
                   with_children, pin_source, created_at
            FROM chat_session_pinned_codex;
            DROP TABLE chat_session_pinned_codex;
            ALTER TABLE chat_session_pinned_codex_new RENAME TO chat_session_pinned_codex;
            CREATE INDEX IF NOT EXISTS idx_chat_pin_session
                ON chat_session_pinned_codex(session_id, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_pin_codex
                ON chat_session_pinned_codex(session_id, codex_entry_id)
                WHERE codex_entry_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_pin_snippet
                ON chat_session_pinned_codex(session_id, snippet_id)
                WHERE snippet_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_pin_sticky
                ON chat_session_pinned_codex(session_id, sticky_id)
                WHERE sticky_id IS NOT NULL;
            COMMIT;",
        )?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let fk_errors: Vec<String> = conn
            .prepare("PRAGMA foreign_key_check(chat_session_pinned_codex)")?
            .query_map([], |row| {
                let table: String = row.get(0)?;
                let rowid: Option<i64> = row.get(1)?;
                let parent: String = row.get(2)?;
                let fkid: i64 = row.get(3)?;
                Ok(format!(
                    "table={table} rowid={rowid:?} parent={parent} fkid={fkid}"
                ))
            })?
            .collect::<Result<_, _>>()?;
        if !fk_errors.is_empty() {
            anyhow::bail!(
                "foreign key check failed after chat_session_pinned_codex rebuild: {}",
                fk_errors.join("; ")
            );
        }
        Ok(())
    }

    /// One-shot migration: extend authorship_spans CHECK to include sticky_id as
    /// a 5th exclusive owner (Map Sticky authorship). The sticky_id column was
    /// added additively earlier, but the CHECK still required exactly one of the
    /// original four FKs to be NOT NULL — causing sticky-only inserts (e.g.
    /// Map AI branch) to fail.
    /// SQLite cannot ALTER CHECK constraints — table rebuild required.
    pub(super) fn migrate_authorship_spans_check_with_sticky(
        conn: &Connection,
    ) -> anyhow::Result<()> {
        let create_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'authorship_spans'",
                [],
                |row| row.get(0),
            )
            .ok();
        let Some(create_sql) = create_sql else {
            return Ok(());
        };
        // Keep additive provenance columns when rebuilding. Future rebuilds of
        // authorship_spans must carry trace_id through both CREATE and SELECT.
        Self::add_column_if_missing(conn, "authorship_spans", "trace_id", "TEXT")?;

        // Detect whether the existing CHECK already references sticky_id. The
        // additive ALTER TABLE only touches the column list, not CHECK clauses,
        // so a CHECK mentioning sticky_id is the marker of the new schema.
        if create_sql.contains("CASE WHEN sticky_id") {
            return Ok(());
        }
        // PRAGMA foreign_keys has no effect inside a transaction; disable before BEGIN.
        conn.pragma_update(None, "foreign_keys", false)?;
        conn.execute_batch(
            "BEGIN;
            CREATE TABLE authorship_spans_new (
                id              TEXT PRIMARY KEY,
                node_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                detail_value_id TEXT REFERENCES codex_detail_values(id) ON DELETE CASCADE,
                sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,
                from_pos        INTEGER NOT NULL,
                to_pos          INTEGER NOT NULL,
                source          TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
                model           TEXT,
                timestamp       TEXT,
                chat_msg_id     TEXT,
                trace_id        TEXT,
                phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
                CHECK (
                    (CASE WHEN node_id         IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN codex_entry_id  IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id      IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN sticky_id       IS NOT NULL THEN 1 ELSE 0 END) = 1
                ),
                CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL)
            );
            INSERT INTO authorship_spans_new
                (id, node_id, codex_entry_id, snippet_id, detail_value_id, sticky_id,
                 from_pos, to_pos, source, model, timestamp, chat_msg_id, trace_id, phase_id)
            SELECT id, node_id, codex_entry_id, snippet_id, detail_value_id, sticky_id,
                   from_pos, to_pos, source, model, timestamp, chat_msg_id, trace_id, phase_id
            FROM authorship_spans;
            DROP TABLE authorship_spans;
            ALTER TABLE authorship_spans_new RENAME TO authorship_spans;
            CREATE INDEX IF NOT EXISTS idx_authorship_node
                ON authorship_spans(node_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_codex
                ON authorship_spans(codex_entry_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_snippet
                ON authorship_spans(snippet_id, source);
            CREATE INDEX IF NOT EXISTS idx_authorship_detail
                ON authorship_spans(detail_value_id);
            CREATE INDEX IF NOT EXISTS idx_authorship_phase
                ON authorship_spans(phase_id)
                WHERE phase_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_authorship_sticky
                ON authorship_spans(sticky_id)
                WHERE sticky_id IS NOT NULL;
            COMMIT;",
        )?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let fk_errors: Vec<String> = conn
            .prepare("PRAGMA foreign_key_check(authorship_spans)")?
            .query_map([], |row| {
                let table: String = row.get(0)?;
                let rowid: Option<i64> = row.get(1)?;
                let parent: String = row.get(2)?;
                let fkid: i64 = row.get(3)?;
                Ok(format!(
                    "table={table} rowid={rowid:?} parent={parent} fkid={fkid}"
                ))
            })?
            .collect::<Result<_, _>>()?;
        if !fk_errors.is_empty() {
            anyhow::bail!(
                "foreign key check failed after authorship_spans rebuild: {}",
                fk_errors.join("; ")
            );
        }
        Ok(())
    }

    /// Drop FK on codex_relations.source_map_edge_id so promoted edge IDs survive
    /// user-edge deletion (traceability for Map → Relation promotion).
    pub(super) fn migrate_codex_relations_source_map_edge_id(
        conn: &Connection,
    ) -> anyhow::Result<()> {
        let table_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'codex_relations'",
            [],
            |row| row.get(0),
        )?;
        if table_exists == 0 {
            return Ok(());
        }

        let has_source_edge_fk = conn
            .prepare("PRAGMA foreign_key_list(codex_relations)")?
            .query_map([], |row| row.get::<_, String>("from"))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|col| col == "source_map_edge_id");
        if !has_source_edge_fk {
            return Ok(());
        }

        conn.pragma_update(None, "foreign_keys", false)?;
        conn.execute_batch(
            "BEGIN;
            CREATE TABLE codex_relations_new (
                id                  TEXT PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                relation_type       TEXT NOT NULL DEFAULT 'custom',
                label               TEXT,
                depth_hint          INTEGER,
                source_map_edge_id  TEXT,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL
            );
            INSERT INTO codex_relations_new
                (id, project_id, from_codex_id, to_codex_id, relation_type, label,
                 depth_hint, source_map_edge_id, created_at, updated_at)
            SELECT id, project_id, from_codex_id, to_codex_id, relation_type, label,
                   depth_hint, source_map_edge_id, created_at, updated_at
            FROM codex_relations;
            DROP TABLE codex_relations;
            ALTER TABLE codex_relations_new RENAME TO codex_relations;
            CREATE INDEX IF NOT EXISTS idx_codex_relations_project
                ON codex_relations(project_id);
            CREATE INDEX IF NOT EXISTS idx_codex_relations_from
                ON codex_relations(from_codex_id);
            CREATE INDEX IF NOT EXISTS idx_codex_relations_to
                ON codex_relations(to_codex_id);
            COMMIT;",
        )?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let fk_errors: Vec<String> = conn
            .prepare("PRAGMA foreign_key_check(codex_relations)")?
            .query_map([], |row| {
                let table: String = row.get(0)?;
                let rowid: Option<i64> = row.get(1)?;
                let parent: String = row.get(2)?;
                let fkid: i64 = row.get(3)?;
                Ok(format!(
                    "table={table} rowid={rowid:?} parent={parent} fkid={fkid}"
                ))
            })?
            .collect::<Result<_, _>>()?;
        if !fk_errors.is_empty() {
            anyhow::bail!(
                "foreign key check failed after codex_relations rebuild: {}",
                fk_errors.join("; ")
            );
        }
        Ok(())
    }

    /// One-shot migration: drop the legacy delete_cv_on_*_delete triggers so
    /// the snapshot-aware versions installed by `migrate()` take effect on
    /// pre-existing databases. The original triggers wrote
    /// `DELETE FROM content_versions WHERE entity_type = X AND entity_id = Y`
    /// unconditionally; that violated the RESTRICT FK from any
    /// project_snapshot_* table whose `version_id` / `body_version_id`
    /// referenced that row, and caused the enclosing tree_nodes /
    /// codex_entries / snippets delete to fail with
    /// `FOREIGN KEY constraint failed`. Rerun on every migrate so a snapshot
    /// schema bump (adding another protected source table) re-installs the
    /// trigger body without requiring a one-shot guard.
    pub(super) fn migrate_cv_triggers_protect_snapshot_versions(
        conn: &Connection,
    ) -> anyhow::Result<()> {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS delete_cv_on_tree_node_delete;
             DROP TRIGGER IF EXISTS delete_cv_on_codex_entry_delete;
             DROP TRIGGER IF EXISTS delete_cv_on_snippet_delete;
             CREATE TRIGGER delete_cv_on_tree_node_delete
             AFTER DELETE ON tree_nodes BEGIN
                 DELETE FROM content_versions
                 WHERE entity_type IN ('scene', 'note')
                   AND entity_id = old.id
                   AND id NOT IN (SELECT version_id FROM project_snapshot_entries)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_tree_nodes WHERE body_version_id IS NOT NULL)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_codex_entries WHERE body_version_id IS NOT NULL)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_snippets WHERE body_version_id IS NOT NULL);
             END;
             CREATE TRIGGER delete_cv_on_codex_entry_delete
             AFTER DELETE ON codex_entries BEGIN
                 DELETE FROM content_versions
                 WHERE entity_type = 'codex_entry'
                   AND entity_id = old.id
                   AND id NOT IN (SELECT version_id FROM project_snapshot_entries)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_tree_nodes WHERE body_version_id IS NOT NULL)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_codex_entries WHERE body_version_id IS NOT NULL)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_snippets WHERE body_version_id IS NOT NULL);
             END;
             CREATE TRIGGER delete_cv_on_snippet_delete
             AFTER DELETE ON snippets BEGIN
                 DELETE FROM content_versions
                 WHERE entity_type = 'snippet'
                   AND entity_id = old.id
                   AND id NOT IN (SELECT version_id FROM project_snapshot_entries)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_tree_nodes WHERE body_version_id IS NOT NULL)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_codex_entries WHERE body_version_id IS NOT NULL)
                   AND id NOT IN (SELECT body_version_id FROM project_snapshot_snippets WHERE body_version_id IS NOT NULL);
             END;",
        )?;
        Ok(())
    }

    /// Add a column to an existing table if it does not already exist.
    /// `column_def` is the SQL fragment after the column name, e.g. `"TEXT NOT NULL DEFAULT '[]'"`.
    /// Use for additive schema changes — SQLite ALTER TABLE only supports a narrow subset, so
    /// renames / type changes still require the table-rebuild dance.
    pub(super) fn add_column_if_missing(
        conn: &Connection,
        table: &str,
        column: &str,
        column_def: &str,
    ) -> anyhow::Result<()> {
        let existing: Vec<String> = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<Result<_, _>>()?;
        if existing.iter().any(|n| n == column) {
            return Ok(());
        }
        // table/column come from compile-time literals at every call site; not user input.
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {column_def};"
        ))?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn open_legacy_post_effect_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Old schema (pre-typo) — must NOT contain 'typo_detection' / 'typo_anchor'
        conn.execute_batch(
            "CREATE TABLE post_effect_runs (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL,
                effect_type     TEXT NOT NULL
                                  CHECK(effect_type IN ('review','pseudo_comment','meta_structure','consistency','intra_scene_consistency')),
                scope_type      TEXT NOT NULL,
                scope_target_id TEXT,
                model           TEXT NOT NULL,
                prompt_version  TEXT NOT NULL,
                input_hash      TEXT,
                status          TEXT NOT NULL DEFAULT 'running',
                summary         TEXT,
                error_message   TEXT,
                started_at      TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at    TEXT
            );
            CREATE TABLE post_effect_annotations (
                id             TEXT PRIMARY KEY,
                project_id     TEXT NOT NULL,
                run_id         TEXT,
                anchor_type    TEXT NOT NULL DEFAULT 'scene_range',
                scene_id       TEXT,
                range_start    INTEGER,
                range_end      INTEGER,
                text_snapshot  TEXT,
                category       TEXT NOT NULL
                                  CHECK(category IN ('review','pseudo_comment','consistency_anchor','foreshadow_anchor','theme_anchor')),
                persona        TEXT,
                severity       TEXT,
                content        TEXT NOT NULL,
                author_role    TEXT NOT NULL DEFAULT 'ai',
                parent_id      TEXT,
                status         TEXT NOT NULL DEFAULT 'open',
                metadata       TEXT NOT NULL DEFAULT '{}',
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn migrate_backfills_event_uid_on_legacy_change_events() {
        // Regression: a pre-event_uid install has change_events WITHOUT the
        // event_uid column. migrate() must add the column and create the unique
        // index in the right order — an in-batch index on the missing column
        // used to fail with "no such column: event_uid" on every workspace open.
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE change_events (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id   TEXT NOT NULL,
                    scene_id     TEXT,
                    domain       TEXT NOT NULL,
                    op_type      TEXT NOT NULL,
                    entity_type  TEXT,
                    entity_id    TEXT,
                    payload      TEXT NOT NULL,
                    session_id   TEXT NOT NULL,
                    sequence     INTEGER NOT NULL,
                    timestamp    INTEGER NOT NULL,
                    prev_hash    TEXT NOT NULL,
                    hash         TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX uq_change_events_project_seq
                    ON change_events(project_id, sequence);",
            )?;
            Ok(())
        })
        .unwrap();

        // Must not error on the legacy (pre-event_uid) table.
        db.migrate().unwrap();

        db.with_conn(|conn| {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(change_events)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            assert!(
                cols.iter().any(|c| c == "event_uid"),
                "event_uid column should be backfilled"
            );
            let idx_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'uq_change_events_project_uid'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(idx_count, 1, "uq_change_events_project_uid should exist");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migrate_fresh_db_creates_ai_usage_cache_columns() {
        // Regression: migrate_ai_usage_cache_tokens は CREATE TABLE ai_usage の
        // 直後で呼ぶ必要がある。CREATE より前で呼ぶと fresh DB では
        // add_column_if_missing が存在しない ai_usage を ALTER しようとして
        // "no such table: ai_usage" で migrate() ごと落ちる (fresh install のみ顕在化)。
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(ai_usage)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            assert!(
                cols.iter().any(|c| c == "cache_read_tokens"),
                "ai_usage.cache_read_tokens should exist on a fresh DB"
            );
            assert!(
                cols.iter().any(|c| c == "cache_write_tokens"),
                "ai_usage.cache_write_tokens should exist on a fresh DB"
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn typo_categories_migration_widens_runs_check() {
        let conn = open_legacy_post_effect_db();
        // Before: typo_detection 不可
        let before = conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r1', 'p1', 'typo_detection', 'scene', 'm', 'v')",
            [],
        );
        assert!(
            before.is_err(),
            "legacy schema should reject typo_detection"
        );

        Database::migrate_post_effect_typo_categories(&conn).expect("migration ok");

        // After: typo_detection 可
        conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r1', 'p1', 'typo_detection', 'scene', 'm', 'v')",
            [],
        )
        .expect("typo_detection should be accepted after migration");
    }

    #[test]
    fn typo_categories_migration_widens_annotations_check() {
        let conn = open_legacy_post_effect_db();
        let before = conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a1', 'p1', 'typo_anchor', 'x')",
            [],
        );
        assert!(before.is_err(), "legacy schema should reject typo_anchor");

        Database::migrate_post_effect_typo_categories(&conn).expect("migration ok");

        conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a1', 'p1', 'typo_anchor', 'x')",
            [],
        )
        .expect("typo_anchor should be accepted after migration");
    }

    #[test]
    fn typo_categories_migration_is_idempotent() {
        let conn = open_legacy_post_effect_db();
        Database::migrate_post_effect_typo_categories(&conn).expect("first run");
        // 2回目以降は no-op (sql に typo_detection が含まれる → 早期 return)
        Database::migrate_post_effect_typo_categories(&conn).expect("second run no-op");
        Database::migrate_post_effect_typo_categories(&conn).expect("third run no-op");

        // 機能が保たれている
        conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r2', 'p1', 'typo_detection', 'scene', 'm', 'v')",
            [],
        )
        .unwrap();
    }

    fn open_post_typo_post_effect_db() -> Connection {
        let conn = open_legacy_post_effect_db();
        Database::migrate_post_effect_typo_categories(&conn).expect("typo migration");
        conn
    }

    #[test]
    fn intent_categories_migration_widens_runs_check() {
        let conn = open_post_typo_post_effect_db();
        let before = conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r-intent', 'p1', 'intent_drift', 'scene', 'm', 'v')",
            [],
        );
        assert!(
            before.is_err(),
            "pre-intent schema should reject intent_drift"
        );

        Database::migrate_post_effect_intent_categories(&conn).expect("migration ok");

        conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r-intent', 'p1', 'intent_drift', 'scene', 'm', 'v')",
            [],
        )
        .expect("intent_drift accepted after migration");
    }

    #[test]
    fn intent_categories_migration_widens_annotations_check() {
        let conn = open_post_typo_post_effect_db();
        let before = conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a-intent', 'p1', 'intent_anchor', 'x')",
            [],
        );
        assert!(
            before.is_err(),
            "pre-intent schema should reject intent_anchor"
        );

        Database::migrate_post_effect_intent_categories(&conn).expect("migration ok");

        conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a-intent', 'p1', 'intent_anchor', 'x')",
            [],
        )
        .expect("intent_anchor accepted after migration");
    }

    #[test]
    fn intent_categories_migration_is_idempotent() {
        let conn = open_post_typo_post_effect_db();
        Database::migrate_post_effect_intent_categories(&conn).expect("first");
        Database::migrate_post_effect_intent_categories(&conn).expect("second no-op");
        Database::migrate_post_effect_intent_categories(&conn).expect("third no-op");

        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }

    /// timeline migration は intent migration の後に走る前提なので、テストの
    /// ベースラインも typo + intent を適用済の状態にする。
    fn open_post_intent_post_effect_db() -> Connection {
        let conn = open_post_typo_post_effect_db();
        Database::migrate_post_effect_intent_categories(&conn).expect("intent migration");
        conn
    }

    #[test]
    fn timeline_categories_migration_widens_runs_check() {
        let conn = open_post_intent_post_effect_db();
        let before = conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r-tl', 'p1', 'timeline_consistency', 'project', 'm', 'v')",
            [],
        );
        assert!(
            before.is_err(),
            "pre-timeline schema should reject timeline_consistency"
        );

        Database::migrate_post_effect_timeline_categories(&conn).expect("migration ok");

        conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r-tl', 'p1', 'timeline_consistency', 'project', 'm', 'v')",
            [],
        )
        .expect("timeline_consistency accepted after migration");
    }

    #[test]
    fn timeline_categories_migration_widens_annotations_check() {
        let conn = open_post_intent_post_effect_db();
        let before = conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a-tl', 'p1', 'timeline_anchor', 'x')",
            [],
        );
        assert!(
            before.is_err(),
            "pre-timeline schema should reject timeline_anchor"
        );

        Database::migrate_post_effect_timeline_categories(&conn).expect("migration ok");

        conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a-tl', 'p1', 'timeline_anchor', 'x')",
            [],
        )
        .expect("timeline_anchor accepted after migration");
    }

    #[test]
    fn timeline_categories_migration_preserves_intent_and_is_idempotent() {
        let conn = open_post_intent_post_effect_db();
        Database::migrate_post_effect_timeline_categories(&conn).expect("first");
        Database::migrate_post_effect_timeline_categories(&conn).expect("second no-op");

        // 既存の intent_drift / intent_anchor が消えていないこと (CHECK 文字列の累積)。
        conn.execute(
            "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
             VALUES ('r-keep', 'p1', 'intent_drift', 'scene', 'm', 'v')",
            [],
        )
        .expect("intent_drift still accepted");
        conn.execute(
            "INSERT INTO post_effect_annotations (id, project_id, category, content)
             VALUES ('a-keep', 'p1', 'intent_anchor', 'x')",
            [],
        )
        .expect("intent_anchor still accepted");

        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }

    #[test]
    fn tree_nodes_intent_column_migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, synopsis TEXT);
             CREATE TABLE project_snapshot_tree_nodes (
                snapshot_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                synopsis TEXT,
                PRIMARY KEY (snapshot_id, node_id)
             );",
        )
        .unwrap();

        Database::migrate_tree_nodes_intent(&conn).expect("first");
        Database::migrate_tree_nodes_intent(&conn).expect("second no-op");

        conn.execute(
            "INSERT INTO tree_nodes (id, intent) VALUES ('n1', '狙いテスト')",
            [],
        )
        .expect("intent column writable");
    }
}
