use rusqlite::Connection;

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

        // AI Policy: プロジェクト単位の AI 使用方針 (chat/bodyWrite/analysis トグル)。
        // デフォルトは Full プリセット (全機能有効)。
        Self::add_column_if_missing(
            &conn,
            "projects",
            "ai_policy",
            "TEXT NOT NULL DEFAULT '{\"preset\":\"full\",\"toggles\":{\"chat\":true,\"bodyWrite\":true,\"analysis\":true}}'",
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

        // Foreshadow secret flag — existing records default false (backwards-compat)
        Self::add_column_if_missing(&conn, "foreshadows", "secret", "INTEGER NOT NULL DEFAULT 0")?;

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
                                  CHECK(effect_type IN ('review','pseudo_comment','meta_structure','consistency','intra_scene_consistency')),
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
                                  CHECK(category IN ('review','pseudo_comment','consistency_anchor','foreshadow_anchor','theme_anchor')),
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

        Ok(())
    }

    /// One-shot migration: drop legacy `color` enum column from map_stickies
    /// and replace with `palette_id` + `color_slot`. Old color names map to
    /// post-it-playful slots 0..5; gray/white fall back to slot 0.
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
