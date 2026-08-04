use rusqlite::{params, Connection, ErrorCode};
use std::time::Duration;

use super::Database;

enum ConvergedV2Finalize {
    Finalized,
    Busy,
    NeedsFullMigration,
}

impl Database {
    pub fn migrate(&self) -> anyhow::Result<()> {
        self.migrate_impl(false)
    }

    /// Restore preflight operates on a disposable copy and must retain the
    /// historical full idempotent migration as its schema-compatibility probe.
    /// Normal workspace open uses `migrate()` so current schemas stay on the
    /// read-only fast path.
    pub(crate) fn migrate_for_restore_preflight(&self) -> anyhow::Result<()> {
        self.migrate_impl(true)
    }

    fn migrate_impl(&self, force_full: bool) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        const SCHEMA_VERSION: i32 = grimodex_core::SCHEMA_VERSION;
        let current: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        anyhow::ensure!(
            current <= SCHEMA_VERSION,
            "workspace schema version {current} is newer than supported version {SCHEMA_VERSION}"
        );
        if !force_full {
            if current == SCHEMA_VERSION {
                // Editor-only visual stickies were added after the v3 schema
                // marker. Keep the current marker stable, but do not let an
                // older v3 workspace take the healthy read-only fast path
                // without this additive table.
                if !Self::has_editor_stickies_table(&conn)? {
                    // Fall through to the idempotent DDL below.
                } else {
                    // Crash recovery is an open-time operational invariant, not a
                    // schema revision. The helper first performs a read-only EXISTS
                    // check, so the healthy current-version path never takes a write
                    // lock (and cannot sit behind an unrelated SQLite writer).
                    Self::recover_interrupted_post_effect_runs(&conn)?;
                    return Ok(());
                }
            }

            if current == grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION
                && grimodex_core::workspace_schema::is_converged_v2_workspace_schema(&conn)?
            {
                // Version 3 introduced the read-only open fast path, not new
                // DDL. A v2 database that already satisfies every post-v2
                // invariant must not replay the full idempotent migration just
                // to write the marker. Finalization rechecks the invariant
                // under a zero-wait write reservation so an older v2 process
                // cannot add unrepaired data between the probe and the stamp.
                // If another writer is active, retain v2 and let a later open
                // retry instead of blocking input-ready.
                let recovery_required = Self::has_interrupted_post_effect_runs(&conn)?;
                match Self::try_finalize_converged_v2_without_wait(&conn, SCHEMA_VERSION)? {
                    ConvergedV2Finalize::Finalized => return Ok(()),
                    ConvergedV2Finalize::Busy if !recovery_required => return Ok(()),
                    ConvergedV2Finalize::Busy => {
                        anyhow::bail!(
                            "workspace crash recovery is blocked by another SQLite writer; retry after it finishes"
                        )
                    }
                    ConvergedV2Finalize::NeedsFullMigration => {}
                }
            }
        }

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
                phase_resolution_mode  TEXT NOT NULL DEFAULT 'auto'
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
                -- Chronicle（作中暦日付）: events と同じ chronicleTime 日付モデルを
                -- シーンにも共有（events とは統合しない）。読む順とは独立した作中時間軸。
                chronicle_start_time        INTEGER,
                chronicle_start_minute      INTEGER,
                chronicle_start_granularity TEXT NOT NULL DEFAULT 'none',
                chronicle_end_time          INTEGER,
                chronicle_end_minute        INTEGER,
                chronicle_end_granularity   TEXT NOT NULL DEFAULT 'none',
                chronicle_precision         TEXT NOT NULL DEFAULT 'exact',
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
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_id          TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL, -- chat history survives scene deletion
                codex_anchor_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                snippet_anchor_id TEXT REFERENCES snippets(id) ON DELETE SET NULL,
                title            TEXT NOT NULL DEFAULT 'New session',
                title_manual INTEGER NOT NULL DEFAULT 0,
                model        TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_node
                ON chat_sessions(project_id, node_id);
            -- idx_chat_sessions_codex_anchor is created AFTER add_column_if_missing
            -- below (upgraded DBs lack codex_anchor_id until that ALTER runs).

            -- External AI runtime thread bindings are kept separate from
            -- chat_sessions so one local session can be resumed by more than
            -- one runtime. The runtime + external id pair is globally unique
            -- to prevent cross-session thread hijacking.
            CREATE TABLE IF NOT EXISTS chat_runtime_threads (
                session_id          TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                runtime             TEXT NOT NULL,
                external_thread_id  TEXT NOT NULL,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                history_revision    TEXT,
                last_turn_id        TEXT,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL,
                PRIMARY KEY (session_id, runtime),
                UNIQUE (runtime, external_thread_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_runtime_threads_project
                ON chat_runtime_threads(project_id, runtime);

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

            -- Per-message prompt snapshot: the finalized system prompt actually
            -- sent for a chat turn, keyed to the triggering user message. Side-table
            -- (kept out of chat_messages.metadata) so the heavy prompt text stays out
            -- of the listMessages full-row load and is fetched lazily on demand.
            -- Mirrors src/db/schema.ts chatMessagePrompts. CASCADE drops the snapshot
            -- when the message (or its session) is deleted.
            CREATE TABLE IF NOT EXISTS chat_message_prompts (
                message_id    TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
                system_prompt TEXT NOT NULL,
                layers        TEXT,
                total_tokens  INTEGER,
                model         TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );

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
                updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
                version               INTEGER NOT NULL DEFAULT 0
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
                -- Chronicle（作中暦日付）— tree_nodes と同じ型・既定値でミラー。
                chronicle_start_time        INTEGER,
                chronicle_start_minute      INTEGER,
                chronicle_start_granularity TEXT NOT NULL DEFAULT 'none',
                chronicle_end_time          INTEGER,
                chronicle_end_minute        INTEGER,
                chronicle_end_granularity   TEXT NOT NULL DEFAULT 'none',
                chronicle_precision         TEXT NOT NULL DEFAULT 'exact',
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
                name, aliases, summary, tags_cache, content,
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
            -- `content` (ProseMirror body JSON) is indexed alongside the metadata
            -- columns so search_codex can match on the body, not just name/summary.
            CREATE TRIGGER IF NOT EXISTS codex_fts_ai AFTER INSERT ON codex_entries BEGIN
                INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache, content)
                VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''), COALESCE(new.content, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS codex_fts_ad AFTER DELETE ON codex_entries BEGIN
                INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache, content)
                VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''), COALESCE(old.content, ''));
            END;
            CREATE TRIGGER IF NOT EXISTS codex_fts_au AFTER UPDATE ON codex_entries
              WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache OR old.content IS NOT new.content
            BEGIN
                INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache, content)
                VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''), COALESCE(old.content, ''));
                INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache, content)
                VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''), COALESCE(new.content, ''));
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

            -- editor_stickies: display-only notes owned by the exact editor
            -- document. They are intentionally not Map Stickies and never
            -- enter export, search, lint, semantic, or AI context pipelines.
            CREATE TABLE IF NOT EXISTS editor_stickies (
                id                 TEXT PRIMARY KEY,
                project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                document_key       TEXT NOT NULL,
                body               TEXT NOT NULL DEFAULT '{\"type\":\"doc\",\"content\":[]}',
                palette_id         TEXT NOT NULL DEFAULT 'post-it-playful',
                color_slot         INTEGER NOT NULL DEFAULT 0 CHECK(color_slot >= 0),
                inline_offset      REAL NOT NULL DEFAULT 0,
                block_offset       REAL NOT NULL DEFAULT 0,
                z_index            INTEGER NOT NULL DEFAULT 0,
                version            INTEGER NOT NULL DEFAULT 0,
                tree_node_id       TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id     TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                phase_id           TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
                snippet_id         TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                chronicle_event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
                created_at         TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL),
                CHECK (
                    (CASE WHEN tree_node_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN chronicle_event_id IS NOT NULL THEN 1 ELSE 0 END) = 1
                )
            );
            CREATE INDEX IF NOT EXISTS idx_editor_stickies_project_document
                ON editor_stickies(project_id, document_key);
            CREATE INDEX IF NOT EXISTS idx_editor_stickies_tree_node
                ON editor_stickies(tree_node_id)
                WHERE tree_node_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_editor_stickies_codex_entry
                ON editor_stickies(codex_entry_id)
                WHERE codex_entry_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_editor_stickies_phase
                ON editor_stickies(phase_id)
                WHERE phase_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_editor_stickies_snippet
                ON editor_stickies(snippet_id)
                WHERE snippet_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_editor_stickies_event
                ON editor_stickies(chronicle_event_id)
                WHERE chronicle_event_id IS NOT NULL;

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

            -- Seed default project (folder is no longer auto-created so the workspace can stay empty).
            -- Title uses the language-neutral schema default 'Untitled Project' (a placeholder
            -- the user renames) so an English user landing on the bootstrap project does not see
            -- a hardcoded Japanese title. Language stays the documented 'ja' fallback.
            INSERT OR IGNORE INTO projects (id, title, language, created_at, updated_at)
              VALUES ('default-project', 'Untitled Project', 'ja', datetime('now'), datetime('now'));",
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
                codex_link_dirty_at INTEGER,
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
        // impact-review: 既存 DB の foreshadows に Codex 変更 stale 用カラムを追加
        // (新 DB は上の CREATE TABLE で済)。
        Self::add_column_if_missing(&conn, "foreshadows", "codex_link_dirty_at", "INTEGER")?;

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

        // AI Policy: プロジェクト単位の AI 使用方針 (chat/bodyWrite/analysis/structureWrite/
        // knowledgeWrite トグル)。新規/import プロジェクトの既定は autonomous な直接書き込み
        // 2 軸 (knowledgeWrite/structureWrite) を OFF にした安全側 (security F-6)。chat/
        // analysis/本文提案(staged)は維持。drizzle 側 schema.ts の .default() が実際の新規
        // insert を支配し、この SQL DEFAULT は fresh DB / 非 drizzle insert 用に一致させる。
        // 既存 DB で列が既にある場合この DEFAULT は遡及せず、欠損キーは parseAiPolicy が補完。
        Self::add_column_if_missing(
            &conn,
            "projects",
            "ai_policy",
            "TEXT NOT NULL DEFAULT '{\"preset\":\"custom\",\"toggles\":{\"chat\":true,\"bodyWrite\":true,\"analysis\":true,\"structureWrite\":false,\"knowledgeWrite\":false}}'",
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
        // 本格暦化: Chronicle（作中暦日付）列を tree_nodes と snapshot ミラーへ追加。
        Self::migrate_tree_nodes_chronicle(&conn)?;

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
                                  CHECK(effect_type IN ('review','pseudo_comment','meta_structure','consistency','intra_scene_consistency','typo_detection','intent_drift','timeline_consistency','impact_review')),
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
                                  CHECK(category IN ('review','pseudo_comment','consistency_anchor','foreshadow_anchor','theme_anchor','typo_anchor','intent_anchor','timeline_anchor','impact_review_anchor')),
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
        // impact-review: timeline migration の **後** に走る (target は 'timeline_*')。順序厳守。
        Self::migrate_post_effect_impact_review_categories(&conn)?;
        // ライブ読者コメントの初期実装で、既存 annotation に永続マーカーを
        // 付けずに保存された行を補修する。通常の疑似コメントへは影響しない。
        Self::migrate_live_pseudo_comment_metadata(&conn)?;

        // impact-review 差分基準テーブル（Codex エントリ単位の前回レビュー時スナップショット）。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS impact_review_baselines (
                entry_id      TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                snapshot_json TEXT NOT NULL,
                content_hash  TEXT NOT NULL,
                reviewed_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_impact_baselines_project
                ON impact_review_baselines(project_id);",
        )?;

        // PostEffect クラッシュリカバリ: プロセス強制終了等で running のまま残った run を
        // 起動時に failed へ落とす。idx_runs_running_scope の UNIQUE が次回起動を
        // ブロックするのを防ぐ目的も兼ねる。設計書 §run のステータス遷移 を参照。
        Self::recover_interrupted_post_effect_runs(&conn)?;

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
            -- created_at / updated_at は ms-since-epoch INTEGER。Drizzle の mode: 'timestamp_ms'
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
                ON scene_chunks(scene_id, chunk_index);

            -- Codex semantic index (stage 3): 1 entry = 1 embedding row.
            -- Codex bodies are short, so no chunking — PK=entry_id enforces
            -- one vector per entry. Brand-new table, so IF NOT EXISTS covers
            -- both fresh and existing DBs (no separate migration helper needed).
            CREATE TABLE IF NOT EXISTS codex_chunks (
                entry_id         TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
                entry_name       TEXT NOT NULL,
                entry_type       TEXT NOT NULL,
                text             TEXT NOT NULL,
                embedding        BLOB NOT NULL,
                embedding_dim    INTEGER NOT NULL,
                model_id         TEXT NOT NULL,
                content_hash     TEXT NOT NULL,
                chunker_version  TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_codex_chunks_model
                ON codex_chunks(model_id);

            -- Chronicle event semantic index (Phase 3): 1 event = 1 embedding row.
            -- Event records (title + note + primary/location/participant names) are
            -- short, so no chunking — PK=event_id enforces one vector per event.
            -- Brand-new table, so IF NOT EXISTS covers both fresh and existing DBs
            -- (no separate migration helper needed). FK cascade requires
            -- PRAGMA foreign_keys=ON (already set; codex cascade test passes).
            CREATE TABLE IF NOT EXISTS event_chunks (
                event_id         TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                event_title      TEXT NOT NULL,
                event_kind       TEXT NOT NULL,
                text             TEXT NOT NULL,
                embedding        BLOB NOT NULL,
                embedding_dim    INTEGER NOT NULL,
                model_id         TEXT NOT NULL,
                content_hash     TEXT NOT NULL,
                chunker_version  TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_event_chunks_model
                ON event_chunks(model_id);

            -- Chat episodic-memory index: 1 chat_message = 1 embedding row.
            -- エピソード記憶 (過去の対話) を scene/codex と同じ意味検索経路で recall
            -- するための埋め込み表。chat_messages には project_id が無いので、検索の
            -- スコープ (project.db 単位) を効かせるため project_id / session_id を
            -- index 時に非正規化して持つ (chat_sessions JOIN を読み出し時に省く)。
            -- inserted_to_editor / extracted_count は「実際に効いた発話」を recall で
            -- 重み付けするための信号 (metadata から非正規化)。signal が変わると content
            -- hash も変わるよう upsert 側で hash 入力に含め、再 index で列が更新される。
            -- codex_chunks と同じく Rust 専用 (Drizzle mirror 不要)。1 message 1 vector
            -- なので PK=message_id・INSERT OR REPLACE。
            CREATE TABLE IF NOT EXISTS chat_message_chunks (
                message_id         TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
                session_id         TEXT NOT NULL,
                project_id         TEXT NOT NULL,
                role               TEXT NOT NULL,
                text               TEXT NOT NULL,
                inserted_to_editor INTEGER NOT NULL DEFAULT 0,
                extracted_count    INTEGER NOT NULL DEFAULT 0,
                embedding          BLOB NOT NULL,
                embedding_dim      INTEGER NOT NULL,
                model_id           TEXT NOT NULL,
                content_hash       TEXT NOT NULL,
                chunker_version    TEXT NOT NULL,
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_message_chunks_project
                ON chat_message_chunks(project_id);
            CREATE INDEX IF NOT EXISTS idx_chat_message_chunks_model
                ON chat_message_chunks(model_id);
            CREATE INDEX IF NOT EXISTS idx_chat_message_chunks_session
                ON chat_message_chunks(session_id);",
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

        // Complete AI-use audit ledger. Project/scene/message identifiers are
        // intentionally not foreign keys: mutable content deletion must not
        // erase this forward-only history, and a durable Browser journal may
        // be replayed before its project snapshot exists. Existing AI rows are
        // not backfilled because their exact request/response payloads are
        // unknowable.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_audit_events (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id            TEXT NOT NULL,
                project_id          TEXT,
                sequence            INTEGER NOT NULL,
                event_id            TEXT NOT NULL,
                execution_id        TEXT NOT NULL,
                operation_id        TEXT NOT NULL,
                parent_execution_id TEXT,
                path_id             TEXT NOT NULL,
                event_type          TEXT NOT NULL,
                timestamp           INTEGER NOT NULL,
                recorded_at         INTEGER NOT NULL,
                payload             TEXT NOT NULL,
                payload_sha256      TEXT NOT NULL,
                prev_hash           TEXT NOT NULL,
                hash                TEXT NOT NULL,
                CHECK (
                    (scope_id = 'workspace' AND project_id IS NULL)
                    OR
                    (project_id IS NOT NULL AND scope_id = 'project:' || project_id)
                )
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_audit_scope_seq
                ON ai_audit_events(scope_id, sequence);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_audit_scope_event
                ON ai_audit_events(scope_id, event_id);
            CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_execution
                ON ai_audit_events(scope_id, execution_id, sequence);
            CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_execution_event_type
                ON ai_audit_events(scope_id, execution_id, event_type);
            CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_operation
                ON ai_audit_events(scope_id, operation_id, sequence);
            CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_timestamp
                ON ai_audit_events(scope_id, timestamp, sequence);",
        )?;
        Self::migrate_ai_audit_events_project_identity(&conn)?;

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

        Self::migrate_ai_write_infrastructure(&conn)?;
        Self::migrate_idempotency_ledger(&conn)?;

        // Index codex body `content` in codex_fts (legacy DBs indexed only
        // name/aliases/summary/tags_cache). Fresh DBs already get the new schema
        // from the CREATE batch above; this rebuilds the virtual table + triggers
        // for existing DBs and re-indexes their rows. Must run after the codex_fts
        // CREATE above; idempotent once the `content` column is present.
        Self::migrate_codex_fts_add_content(&conn)?;

        Self::ensure_en_fts(&conn)?;

        // Codex-scoped chat sessions: anchor to a codex entry (node_id stays NULL).
        Self::add_column_if_missing(
            &conn,
            "chat_sessions",
            "codex_anchor_id",
            "TEXT REFERENCES codex_entries(id) ON DELETE SET NULL",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_codex_anchor
                ON chat_sessions(project_id, codex_anchor_id);",
        )?;

        // Snippet-scoped chat sessions: anchor to a snippet (codex_anchor_id と同型)。
        Self::add_column_if_missing(
            &conn,
            "chat_sessions",
            "snippet_anchor_id",
            "TEXT REFERENCES snippets(id) ON DELETE SET NULL",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_snippet_anchor
                ON chat_sessions(project_id, snippet_anchor_id);",
        )?;

        // ⑦ AI運用ツール群: プロンプト再利用ライブラリ（per-project）。
        // schema.ts の `promptTemplates` テーブルと列を手動同期している。
        // snippets とは別概念で、ユーザーが保存する再利用可能なプロンプト
        // テンプレート。v1 はパラメータ置換なしのプレーンテキスト。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prompt_templates (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title       TEXT NOT NULL DEFAULT 'Untitled',
                content     TEXT NOT NULL DEFAULT '',
                usage_count INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_templates_project
                ON prompt_templates(project_id, created_at);",
        )?;

        // A/B 比較 (③): モデル/プロンプトの 2 構成を同一プロンプトに対して走らせ、
        // どちらを採用したかを記録する履歴。surface は "chat" | "inline" 等。
        // chosen は採用したカラム ('a' | 'b')、未採用なら NULL。Drizzle 側の
        // src/db/schema.ts abComparisons とミラー。project 削除で CASCADE。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ab_comparisons (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface           TEXT NOT NULL,
                prompt            TEXT NOT NULL,
                model_a           TEXT,
                model_b           TEXT,
                prompt_variant_a  TEXT,
                prompt_variant_b  TEXT,
                response_a        TEXT NOT NULL,
                response_b        TEXT NOT NULL,
                chosen            TEXT,
                created_at        TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ab_comparisons_project_created
                ON ab_comparisons(project_id, created_at);",
        )?;

        // A/B 比較 (③) — N 枠 (スロット) 版。同一プロンプトに対し任意数の構成
        // (provider / model / プロンプト追記) を走らせた結果と採用判断を記録する履歴。
        // slots は各枠の構成 + 応答を持つ JSON TEXT 配列、chosen は採用した枠の slotId
        // ("baseline" 等)、未採用なら NULL。旧 2 枠版 ab_comparisons を置き換える
        // (旧テーブルは互換のため残置)。Drizzle 側 src/db/schema.ts abComparisonRuns と
        // ミラー。project 削除で CASCADE。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ab_comparison_runs (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface     TEXT NOT NULL,
                prompt      TEXT NOT NULL,
                slots       TEXT NOT NULL,
                chosen      TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ab_comparison_runs_project_created
                ON ab_comparison_runs(project_id, created_at);",
        )?;

        // プロットスレッド (Plottr 型): タイムライン上の名前付き横レーン。
        // src/db/schema.ts の plotThreads とミラー。project 削除で CASCADE。
        // sort_order はレーン縦順の base62 fractional-index (treeNodes.sort_order と同 idiom)。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS plot_threads (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name          TEXT NOT NULL DEFAULT '',
                color         TEXT,
                description   TEXT,
                sort_order    TEXT NOT NULL DEFAULT 'a0',
                -- 束ねレイアウトの生存スパン明示指定 (NULL=最初/最後のマーカーから導出)。
                -- シーン削除で ON DELETE SET NULL → override 解除 (スレッド自体は残る)。
                start_node_id TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                end_node_id   TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_plot_threads_project
                ON plot_threads(project_id);",
        )?;
        // 束ねレイアウト (Phase B): 既存 DB の plot_threads に生存スパン override 列を
        // 追加 (新 DB は上の CREATE TABLE で済)。ON DELETE SET NULL の FK 付き。
        Self::add_column_if_missing(
            &conn,
            "plot_threads",
            "start_node_id",
            "TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL",
        )?;
        Self::add_column_if_missing(
            &conn,
            "plot_threads",
            "end_node_id",
            "TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL",
        )?;

        // プロットスレッドが特定シーンで踏む段階マーカー。phase_type は CHECK enum
        // (後から広げると table rebuild になるため初版で確定)。src/db/schema.ts の
        // plotThreadSceneLinks とミラー。thread / scene 削除でいずれも CASCADE。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS plot_thread_scene_links (
                id          TEXT PRIMARY KEY,
                thread_id   TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
                node_id     TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                phase_type  TEXT NOT NULL
                              CHECK(phase_type IN ('introduce','develop','turn','climax','resolve')),
                note        TEXT,
                sort_order  TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_plot_thread_links_thread
                ON plot_thread_scene_links(thread_id);
            CREATE INDEX IF NOT EXISTS idx_plot_thread_links_node
                ON plot_thread_scene_links(node_id);",
        )?;

        // プロットスレッドの分岐 / 合流エッジ。特定シーン(at_node_id)で from→to の
        // スレッド間を繋ぐ（'branch'=枝分かれ / 'merge'=収束）。src/db/schema.ts の
        // plotThreadBranches とミラー。project_id は XPROJ ガード用に非正規化保持し、
        // from/to スレッド・at シーンのいずれが消えても CASCADE で孤児を残さない。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS plot_thread_branches (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                from_thread_id  TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
                to_thread_id    TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
                at_node_id      TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                kind            TEXT NOT NULL
                                  CHECK(kind IN ('branch','merge')),
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_plot_thread_branches_project
                ON plot_thread_branches(project_id);
            CREATE INDEX IF NOT EXISTS idx_plot_thread_branches_from
                ON plot_thread_branches(from_thread_id);
            CREATE INDEX IF NOT EXISTS idx_plot_thread_branches_to
                ON plot_thread_branches(to_thread_id);",
        )?;

        // 作中年表(Chronicle)の出来事。Scene-anchored ではない独立エンティティ。
        // point(end_time=NULL)/interval 両対応。precision は CHECK enum。
        // primary_codex_id=ホームレーン(人物)。codex 削除で SET NULL（出来事は残す）。
        // src/db/schema.ts の events とミラー。project 削除で CASCADE。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title            TEXT NOT NULL DEFAULT '',
                note             TEXT,
                detail           TEXT,
                ordinal          TEXT NOT NULL DEFAULT 'a0',
                primary_codex_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                location_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                start_time       INTEGER,
                end_time         INTEGER,
                start_minute     INTEGER,
                end_minute       INTEGER,
                start_granularity TEXT NOT NULL DEFAULT 'none'
                                   CHECK(start_granularity IN ('none','season','year','month','day','time')),
                end_granularity  TEXT NOT NULL DEFAULT 'none'
                                   CHECK(end_granularity IN ('none','season','year','month','day','time')),
                precision        TEXT NOT NULL DEFAULT 'exact'
                                   CHECK(precision IN ('exact','approx','unknown')),
                kind             TEXT NOT NULL DEFAULT 'generic'
                                   CHECK(kind IN ('generic','birth','death')),
                secret           INTEGER NOT NULL DEFAULT 0,
                reveal_scene_id  TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
                version          INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_events_project
                ON events(project_id);
            CREATE INDEX IF NOT EXISTS idx_events_ordinal
                ON events(project_id, ordinal);",
        )?;
        // Existing Chronicle databases predate aggregate OCC. This rescue must
        // run after the CREATE above because fresh migrations reach Chronicle
        // after the general AI-write infrastructure migration.
        Self::add_column_if_missing(&conn, "events", "version", "INTEGER NOT NULL DEFAULT 0")?;
        // 既存 DB（P0 で events 作成済）への列追加。CHECK 無しの素 ALTER。
        Self::add_column_if_missing(&conn, "events", "kind", "TEXT NOT NULL DEFAULT 'generic'")?;
        Self::add_column_if_missing(
            &conn,
            "events",
            "location_codex_id",
            "TEXT REFERENCES codex_entries(id) ON DELETE SET NULL",
        )?;
        // 本格暦化: 時刻（分）＋粒度。既存 DB へは CHECK 無しの素 ALTER で追加。
        Self::add_column_if_missing(&conn, "events", "start_minute", "INTEGER")?;
        Self::add_column_if_missing(&conn, "events", "end_minute", "INTEGER")?;
        Self::add_column_if_missing(
            &conn,
            "events",
            "start_granularity",
            "TEXT NOT NULL DEFAULT 'none'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "events",
            "end_granularity",
            "TEXT NOT NULL DEFAULT 'none'",
        )?;
        // AI 秘匿（reveal アンカー方式）。既存 DB へは CHECK 無しの素 ALTER で追加。
        // secret 既定 0=表示・reveal_scene_id 既定 NULL（後方互換・挙動不変）。
        Self::add_column_if_missing(&conn, "events", "secret", "INTEGER NOT NULL DEFAULT 0")?;
        Self::add_column_if_missing(
            &conn,
            "events",
            "reveal_scene_id",
            "TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL",
        )?;
        // 出来事の詳細（リッチテキスト = ProseMirror JSON）。既存 DB へは素 ALTER で追加。
        Self::add_column_if_missing(&conn, "events", "detail", "TEXT")?;

        // 出来事への参加 codex（多対多）。主参加は events.primary_codex_id。
        // src/db/schema.ts の eventParticipants とミラー。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS event_participants (
                event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                role            TEXT,
                PRIMARY KEY (event_id, codex_entry_id)
            );
            CREATE INDEX IF NOT EXISTS idx_event_participants_codex
                ON event_participants(codex_entry_id);",
        )?;

        // scene↔event 0..N 橋（0=オフページ）。scene/event いずれ削除でも CASCADE。
        // src/db/schema.ts の sceneEvents とミラー。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS scene_events (
                scene_id  TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                PRIMARY KEY (scene_id, event_id)
            );
            CREATE INDEX IF NOT EXISTS idx_scene_events_event
                ON scene_events(event_id);",
        )?;

        // 1プロジェクト1暦（暦ライト・任意）。season_boundaries は JSON。
        // src/db/schema.ts の projectCalendar とミラー。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS project_calendar (
                project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                days_per_year     INTEGER NOT NULL DEFAULT 360,
                season_boundaries TEXT NOT NULL DEFAULT '[]',
                start_year        INTEGER NOT NULL DEFAULT 0,
                months            TEXT NOT NULL DEFAULT '[]',
                weekday_names     TEXT NOT NULL DEFAULT '[]',
                weekday_start_index INTEGER NOT NULL DEFAULT 0,
                eras              TEXT NOT NULL DEFAULT '[]',
                reform            TEXT NOT NULL DEFAULT 'null',
                timezone          TEXT NOT NULL DEFAULT 'null',
                lunar_tz_minutes  INTEGER NOT NULL DEFAULT 480,
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )?;
        // 本格暦化: 開始年・月定義・曜日名。既存 DB（暦ライト時代に作成済）へ追加。
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "start_year",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "months",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "weekday_names",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "weekday_start_index",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        // 未割当出来事の整理用サブレーン id（複数の未割当レーンに振り分ける）。
        Self::add_column_if_missing(&conn, "events", "lane_group", "TEXT")?;
        // グレゴリオ閏＋年齢表記（満/数え）。既存 DB（暦ライト/本格暦化時代）へ追加。
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "leap_rule",
            "TEXT NOT NULL DEFAULT '{\"kind\":\"none\"}'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "age_reckoning",
            "TEXT NOT NULL DEFAULT 'full'",
        )?;
        // 元号/年号（年粒度ラベル）。既存 DB へ追加。
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "eras",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        // ユリウス→グレゴリオ改暦（JSON）。既存 DB へ追加。
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "reform",
            "TEXT NOT NULL DEFAULT 'null'",
        )?;
        // タイムゾーン/夏時間（JSON）。既存 DB へ追加。
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "timezone",
            "TEXT NOT NULL DEFAULT 'null'",
        )?;
        // 旧暦の節気判定 UTC オフセット分（480=中国 / 540=日本）。既存 DB へ追加。
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "lunar_tz_minutes",
            "INTEGER NOT NULL DEFAULT 480",
        )?;

        // 出来事間の因果エッジ（cause→effect）。効果が原因より前なら整合チェックで矛盾。
        // src/db/schema.ts の eventRelations とミラー。event 削除で CASCADE。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS event_relations (
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                cause_event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                effect_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                PRIMARY KEY (cause_event_id, effect_event_id)
            );
            CREATE INDEX IF NOT EXISTS idx_event_relations_project
                ON event_relations(project_id);
            CREATE INDEX IF NOT EXISTS idx_event_relations_effect
                ON event_relations(effect_event_id);",
        )?;

        // Fix (DB health audit 2026-07): FK child columns that lacked a covering
        // index. Without one, every ON DELETE CASCADE / SET NULL / RESTRICT check
        // full-scans the child table when the parent row is deleted; the
        // self-referential tree_nodes.parent_id in particular makes bulk subtree
        // deletes O(n²). All idempotent (IF NOT EXISTS); tables are created above.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent ON tree_nodes(parent_id);
             CREATE INDEX IF NOT EXISTS idx_tree_nodes_location ON tree_nodes(location_id);
             CREATE INDEX IF NOT EXISTS idx_tree_nodes_pov ON tree_nodes(pov_character_id);
             CREATE INDEX IF NOT EXISTS idx_ai_usage_scene_node ON ai_usage(scene_node_id);
             CREATE INDEX IF NOT EXISTS idx_map_node_positions_ai_branch ON map_node_positions(ai_branch_id);
             CREATE INDEX IF NOT EXISTS idx_map_node_positions_snippet ON map_node_positions(snippet_id);
             CREATE INDEX IF NOT EXISTS idx_map_node_positions_sticky ON map_node_positions(sticky_id);
             CREATE INDEX IF NOT EXISTS idx_chat_sessions_node ON chat_sessions(node_id);
             CREATE INDEX IF NOT EXISTS idx_post_effect_annotations_scene ON post_effect_annotations(scene_id);
             CREATE INDEX IF NOT EXISTS idx_pear_run ON post_effect_annotation_relations(run_id);
             CREATE INDEX IF NOT EXISTS idx_pear_project ON post_effect_annotation_relations(project_id);
             CREATE INDEX IF NOT EXISTS idx_post_effect_runs_scope_target ON post_effect_runs(scope_target_id);
             CREATE INDEX IF NOT EXISTS idx_psnap_entries_version ON project_snapshot_entries(version_id);
             CREATE INDEX IF NOT EXISTS idx_psnap_tree_body_version ON project_snapshot_tree_nodes(body_version_id);
             CREATE INDEX IF NOT EXISTS idx_psnap_codex_body_version ON project_snapshot_codex_entries(body_version_id);
             CREATE INDEX IF NOT EXISTS idx_psnap_snippets_body_version ON project_snapshot_snippets(body_version_id);
             CREATE INDEX IF NOT EXISTS idx_pinned_codex_entry ON chat_session_pinned_codex(codex_entry_id);
             CREATE INDEX IF NOT EXISTS idx_pinned_codex_snippet ON chat_session_pinned_codex(snippet_id);
             CREATE INDEX IF NOT EXISTS idx_pinned_codex_sticky ON chat_session_pinned_codex(sticky_id);
             CREATE INDEX IF NOT EXISTS idx_trash_items_origin_codex ON trash_items(origin_codex_id);
             CREATE INDEX IF NOT EXISTS idx_trash_items_origin_scene ON trash_items(origin_scene_id);
             CREATE INDEX IF NOT EXISTS idx_cpdo_definition ON codex_phase_detail_overrides(definition_id);
             CREATE INDEX IF NOT EXISTS idx_codex_dismissed_dismissed ON codex_dismissed_relations(dismissed_id);
             CREATE INDEX IF NOT EXISTS idx_scene_beat_pov_char ON scene_beat_pov_cache(pov_character_id);
             CREATE INDEX IF NOT EXISTS idx_map_ai_branches_session ON map_ai_branches(session_id);
             CREATE INDEX IF NOT EXISTS idx_chat_summaries_last_msg ON chat_summaries(last_msg_id);",
        )?;

        // Stamp only after every fresh/rescue migration above has succeeded.
        // Headless MCP uses this as its schema-skew gate; advancing earlier
        // could make a partially migrated database look compatible after a
        // crash or later migration failure.
        anyhow::ensure!(
            grimodex_core::workspace_schema::has_v3_checkpoint_invariants(&conn)?,
            "workspace schema did not satisfy version 3 invariants after migration"
        );
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;

        Ok(())
    }

    /// Recover runs left active by a terminated process without turning every
    /// healthy workspace open into a SQLite write. The read probe is also what
    /// lets a current-schema open proceed while another connection owns a
    /// `BEGIN IMMEDIATE` reservation.
    fn recover_interrupted_post_effect_runs(conn: &Connection) -> anyhow::Result<()> {
        if !Self::has_interrupted_post_effect_runs(conn)? {
            return Ok(());
        }
        conn.execute(
            "UPDATE post_effect_runs
                SET status = 'failed',
                    error_message = COALESCE(error_message, 'Process terminated unexpectedly'),
                    completed_at = datetime('now')
              WHERE status = 'running'",
            [],
        )?;
        Ok(())
    }

    fn has_editor_stickies_table(conn: &Connection) -> anyhow::Result<bool> {
        Ok(conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'editor_stickies'
            )",
            [],
            |row| row.get(0),
        )?)
    }

    fn has_interrupted_post_effect_runs(conn: &Connection) -> anyhow::Result<bool> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM post_effect_runs WHERE status = 'running' LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
    }

    /// Atomically recover open-time state and advance a marker-only schema
    /// revision without ever waiting for another SQLite writer.
    ///
    /// The compatibility probe is repeated after `BEGIN IMMEDIATE`; otherwise
    /// an older v2 process could commit unrepaired data between the initial
    /// read probe and the v3 stamp. SQLITE_BUSY/LOCKED leaves both data and the
    /// previous marker untouched. All other failures remain fatal.
    fn try_finalize_converged_v2_without_wait(
        conn: &Connection,
        schema_version: i32,
    ) -> anyhow::Result<ConvergedV2Finalize> {
        let original_timeout_ms: i64 =
            conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
        anyhow::ensure!(
            original_timeout_ms >= 0,
            "SQLite returned a negative busy_timeout"
        );

        conn.busy_timeout(Duration::ZERO)?;
        let finalize_result = match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => {
                let transaction_result = (|| {
                    if !grimodex_core::workspace_schema::is_converged_v2_workspace_schema(conn)? {
                        conn.execute_batch("ROLLBACK")?;
                        return Ok(ConvergedV2Finalize::NeedsFullMigration);
                    }
                    Self::recover_interrupted_post_effect_runs(conn)?;
                    conn.pragma_update(None, "user_version", schema_version)?;
                    grimodex_core::commit_or_rollback(conn)?;
                    Ok(ConvergedV2Finalize::Finalized)
                })();
                if transaction_result.is_err() && !conn.is_autocommit() {
                    let _ = conn.execute_batch("ROLLBACK");
                }
                transaction_result
            }
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                ) =>
            {
                Ok(ConvergedV2Finalize::Busy)
            }
            Err(error) => Err(error.into()),
        };
        let restore_result = conn.busy_timeout(Duration::from_millis(
            u64::try_from(original_timeout_ms)
                .map_err(|error| anyhow::anyhow!("invalid SQLite busy_timeout: {error}"))?,
        ));

        match (finalize_result, restore_result) {
            (Ok(outcome), Ok(())) => Ok(outcome),
            (Ok(_), Err(error)) => Err(error.into()),
            (Err(error), _) => Err(error),
        }
    }

    /// AI write infrastructure: undo-journal, entity version counters, and
    /// prose staging. `migrate()` stamps `user_version` after later migrations.
    pub(super) fn migrate_ai_write_infrastructure(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS undo_journal (
                id                  TEXT PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface             TEXT NOT NULL,
                entity_kind         TEXT NOT NULL,
                entity_id           TEXT NOT NULL,
                op_kind             TEXT NOT NULL,
                before_json         TEXT,
                after_json          TEXT,
                base_version        INTEGER NOT NULL,
                result_version      INTEGER NOT NULL,
                change_event_uid    TEXT,
                created_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_undo_journal_project_entity
                ON undo_journal(project_id, entity_kind, entity_id);
            CREATE TABLE IF NOT EXISTS prose_staging (
                id                  TEXT PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                scene_id            TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                proposed_content    TEXT NOT NULL,
                base_version        INTEGER NOT NULL,
                status              TEXT NOT NULL DEFAULT 'proposed'
                                      CHECK(status IN ('proposed','accepted','discarded')),
                source_surface      TEXT NOT NULL,
                source_session_id   TEXT,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_prose_staging_project_scene
                ON prose_staging(project_id, scene_id, status);",
        )?;

        Self::add_column_if_missing(
            conn,
            "codex_entries",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        // 表記→読みの配列 (JSON Record<string, string[]>)。IME 変換辞書注入・ルビ・
        // 五十音ソート用 (docs/Grimodex_IME連携設計書.md §3.1)。aliases と同じ nullable
        // TEXT で、base CREATE TABLE には足さず version と同様この rescue のみで導入する。
        // seed_schema_parity のゲート4(iii)は seed(readings 無し)→migrate でこの
        // add_column_if_missing が足し、from-scratch と一致することを検証して緑になる。
        Self::add_column_if_missing(conn, "codex_entries", "readings", "TEXT")?;
        Self::add_column_if_missing(conn, "snippets", "version", "INTEGER NOT NULL DEFAULT 0")?;
        Self::add_column_if_missing(conn, "tree_nodes", "version", "INTEGER NOT NULL DEFAULT 0")?;
        Self::add_column_if_missing(
            conn,
            "codex_entry_phases",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Ok(())
    }

    /// Durable create-request tombstones. These rows deliberately do not
    /// reference the created entity: entity delete/cascade/prune must not erase
    /// the replay proof and allow a delayed request to resurrect that entity.
    pub(super) fn migrate_idempotency_ledger(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS idempotency_requests (
                domain       TEXT NOT NULL,
                request_id   TEXT NOT NULL,
                project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                payload_hash TEXT NOT NULL,
                tombstone_json TEXT NOT NULL,
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (domain, request_id)
            );
            CREATE INDEX IF NOT EXISTS idx_idempotency_requests_project_created
                ON idempotency_requests(project_id, created_at);",
        )?;
        Ok(())
    }

    /// Create the non-external `_en` FTS tables (porter unicode61) and their
    /// language-guarded sync triggers, then backfill English content exactly
    /// once. Existing trigram tables/triggers are left untouched (English rows
    /// are also indexed there but never queried for English projects).
    pub(super) fn ensure_en_fts(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS fts_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        // Fix (DB health audit 2026-07): the `_en` AFTER DELETE triggers below
        // used to be language-guarded (`WHEN (SELECT language FROM projects ...)
        // LIKE 'en%'`). On an FK ON DELETE CASCADE the parent row (projects /
        // chat_sessions) is deleted *first*, so the guard subquery returns NULL,
        // the guard fails, and the `_en` index row is never removed → orphan.
        // When the base table later reuses that rowid, INSERT into the
        // standalone (non-external-content) FTS5 table fails with a duplicate
        // rowid constraint, blocking all subsequent writes on that table.
        // Deleting a non-existent rowid is a harmless no-op, so the guard is
        // unnecessary on delete: drop the legacy guarded triggers once and let
        // the unguarded definitions below recreate them. Idempotent via the
        // `en_ad_unguarded` flag so this runs at most once per DB.
        let ad_unguarded: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM fts_meta WHERE key = 'en_ad_unguarded')",
            [],
            |r| r.get(0),
        )?;
        if !ad_unguarded {
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS codex_fts_en_ad;
                 DROP TRIGGER IF EXISTS snippets_fts_en_ad;
                 DROP TRIGGER IF EXISTS chat_messages_fts_en_ad;
                 DROP TRIGGER IF EXISTS tree_nodes_fts_en_ad;
                 DROP TRIGGER IF EXISTS post_effect_annotations_fts_en_ad;",
            )?;
        }

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS codex_fts_en USING fts5(
                 name, aliases, summary, tags_cache, content,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts_en USING fts5(
                 title, content, tags_cache,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts_en USING fts5(
                 content,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS tree_nodes_fts_en USING fts5(
                 title, content,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS post_effect_annotations_fts_en USING fts5(
                 content,
                 tokenize='porter unicode61'
             );

             -- codex_entries (direct project_id)
             CREATE TRIGGER IF NOT EXISTS codex_fts_en_ai AFTER INSERT ON codex_entries
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO codex_fts_en(rowid, name, aliases, summary, tags_cache, content)
                 VALUES (new.rowid, COALESCE(new.name,''), COALESCE(new.aliases,''), COALESCE(new.summary,''), COALESCE(new.tags_cache,''), COALESCE(new.content,''));
             END;
             CREATE TRIGGER IF NOT EXISTS codex_fts_en_ad AFTER DELETE ON codex_entries
               WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM codex_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS codex_fts_en_au AFTER UPDATE ON codex_entries
               WHEN (old.name IS NOT new.name OR old.aliases IS NOT new.aliases OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache OR old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM codex_fts_en WHERE rowid = old.rowid;
                 INSERT INTO codex_fts_en(rowid, name, aliases, summary, tags_cache, content)
                 VALUES (new.rowid, COALESCE(new.name,''), COALESCE(new.aliases,''), COALESCE(new.summary,''), COALESCE(new.tags_cache,''), COALESCE(new.content,''));
             END;

             -- snippets (direct project_id)
             CREATE TRIGGER IF NOT EXISTS snippets_fts_en_ai AFTER INSERT ON snippets
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO snippets_fts_en(rowid, title, content, tags_cache)
                 VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache,''));
             END;
             CREATE TRIGGER IF NOT EXISTS snippets_fts_en_ad AFTER DELETE ON snippets
               WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM snippets_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS snippets_fts_en_au AFTER UPDATE ON snippets
               WHEN (old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags_cache IS NOT new.tags_cache)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM snippets_fts_en WHERE rowid = old.rowid;
                 INSERT INTO snippets_fts_en(rowid, title, content, tags_cache)
                 VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache,''));
             END;

             -- chat_messages (project_id via chat_sessions)
             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_ai AFTER INSERT ON chat_messages
               WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)) LIKE 'en%'
             BEGIN
                 INSERT INTO chat_messages_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_ad AFTER DELETE ON chat_messages
               WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = old.session_id)) LIKE 'en%'
             BEGIN
                 DELETE FROM chat_messages_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_au AFTER UPDATE ON chat_messages
               WHEN (old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)) LIKE 'en%'
             BEGIN
                 DELETE FROM chat_messages_fts_en WHERE rowid = old.rowid;
                 INSERT INTO chat_messages_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;

             -- tree_nodes (direct project_id)
             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_ai AFTER INSERT ON tree_nodes
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO tree_nodes_fts_en(rowid, title, content)
                 VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''));
             END;
             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_ad AFTER DELETE ON tree_nodes
             BEGIN
                 DELETE FROM tree_nodes_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_au AFTER UPDATE ON tree_nodes
               WHEN (old.title IS NOT new.title OR old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM tree_nodes_fts_en WHERE rowid = old.rowid;
                 INSERT INTO tree_nodes_fts_en(rowid, title, content)
                 VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''));
             END;

             -- post_effect_annotations (direct project_id)
             CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_ai AFTER INSERT ON post_effect_annotations
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO post_effect_annotations_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_ad AFTER DELETE ON post_effect_annotations
             BEGIN
                 DELETE FROM post_effect_annotations_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_au AFTER UPDATE ON post_effect_annotations
               WHEN (old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM post_effect_annotations_fts_en WHERE rowid = old.rowid;
                 INSERT INTO post_effect_annotations_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;",
        )?;

        // One-time backfill of pre-existing English content (flagged so it runs
        // exactly once, independent of content shape).
        let done: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM fts_meta WHERE key = 'en_backfilled')",
            [],
            |r| r.get(0),
        )?;
        if !done {
            super::fts::rebuild_en_fts_sql(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO fts_meta(key, value) VALUES ('en_backfilled', '1')",
                [],
            )?;
        }
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
    fn verify_post_effect_category_migration(
        conn: &Connection,
        checks: &[(&str, &str)],
        migration_name: &str,
    ) -> anyhow::Result<()> {
        for (table, marker) in checks {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [*table],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    anyhow::anyhow!("{migration_name}: cannot read schema for {table}: {error}")
                })?;
            if !sql.contains(marker) {
                anyhow::bail!("{migration_name}: {table} CHECK does not contain {marker}");
            }

            // The migration edits only CHECK text, but verify the affected
            // tables' FK rows without scanning every b-tree in the workspace.
            let pragma = format!("PRAGMA foreign_key_check('{table}')");
            let mut statement = conn.prepare(&pragma)?;
            let mut rows = statement.query([])?;
            if rows.next()?.is_some() {
                anyhow::bail!(
                    "{migration_name}: foreign_key_check reported a violation in {table}"
                );
            }
        }
        Ok(())
    }

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

        let mut checks = Vec::new();
        if runs_needs {
            checks.push(("post_effect_runs", "typo_detection"));
        }
        if anns_needs {
            checks.push(("post_effect_annotations", "typo_anchor"));
        }
        Self::verify_post_effect_category_migration(conn, &checks, "typo CHECK widening")?;

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

        let mut checks = Vec::new();
        if runs_needs {
            checks.push(("post_effect_runs", "intent_drift"));
        }
        if anns_needs {
            checks.push(("post_effect_annotations", "intent_anchor"));
        }
        Self::verify_post_effect_category_migration(conn, &checks, "intent CHECK widening")?;

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

        let mut checks = Vec::new();
        if runs_needs {
            checks.push(("post_effect_runs", "timeline_consistency"));
        }
        if anns_needs {
            checks.push(("post_effect_annotations", "timeline_anchor"));
        }
        Self::verify_post_effect_category_migration(conn, &checks, "timeline CHECK widening")?;

        Ok(())
    }

    /// One-shot migration: 既存 DB の post_effect_runs / post_effect_annotations CHECK 制約に
    /// impact_review / impact_review_anchor を追加する。
    /// timeline migration の **後** に走るため、.replace のターゲットは timeline 追加済の
    /// CHECK 文字列 (`'timeline_consistency')` / `'timeline_anchor')`) でなければならない。ズレると
    /// 一致せず silent no-op (warn) になり、既存 DB が impact_review effect を insert 不能になる。
    pub(super) fn migrate_post_effect_impact_review_categories(
        conn: &Connection,
    ) -> anyhow::Result<()> {
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
            .is_some_and(|s| !s.contains("impact_review'"));
        let anns_needs = anns_sql
            .as_deref()
            .is_some_and(|s| !s.contains("impact_review_anchor"));

        if !runs_needs && !anns_needs {
            return Ok(());
        }

        let current_version: i64 = conn.query_row("PRAGMA schema_version", [], |row| row.get(0))?;

        conn.pragma_update(None, "writable_schema", true)?;

        if runs_needs {
            if let Some(old) = runs_sql {
                let new = old.replace(
                    "'timeline_consistency')",
                    "'timeline_consistency','impact_review')",
                );
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_runs'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_runs CHECK constraint not in expected form; skipping impact_review migration"
                    );
                }
            }
        }

        if anns_needs {
            if let Some(old) = anns_sql {
                let new = old.replace(
                    "'timeline_anchor')",
                    "'timeline_anchor','impact_review_anchor')",
                );
                if new != old {
                    conn.execute(
                        "UPDATE sqlite_master SET sql = ?1 \
                         WHERE type = 'table' AND name = 'post_effect_annotations'",
                        params![new],
                    )?;
                } else {
                    tracing::warn!(
                        "post_effect_annotations CHECK constraint not in expected form; skipping impact_review_anchor migration"
                    );
                }
            }
        }

        conn.pragma_update(None, "schema_version", current_version + 1)?;
        conn.pragma_update(None, "writable_schema", false)?;

        let mut checks = Vec::new();
        if runs_needs {
            checks.push(("post_effect_runs", "impact_review"));
        }
        if anns_needs {
            checks.push(("post_effect_annotations", "impact_review_anchor"));
        }
        Self::verify_post_effect_category_migration(conn, &checks, "impact_review CHECK widening")?;

        Ok(())
    }

    /// ライブ読者コメントの初期版で保存された annotation を補修する。
    ///
    /// ライブ実行は通常の `pseudo_comment` と同じテーブルを使うため、annotation
    /// 単体には種別が残らない。`run_id` の prompt_version を正本として `live` を
    /// metadata に付与し、本文レイヤーを OFF にしても表示できる状態へ戻す。
    /// SQLite の JSON 関数は壊れた metadata で失敗し得るため、invalid JSON と
    /// object 以外の JSON は空オブジェクトから補修する。
    pub(super) fn migrate_live_pseudo_comment_metadata(conn: &Connection) -> anyhow::Result<()> {
        conn.execute(
            "UPDATE post_effect_annotations
                SET metadata = json_set(
                        CASE
                          WHEN json_valid(metadata) AND json_type(metadata) = 'object'
                          THEN metadata
                          ELSE '{}'
                        END,
                        '$.live', 1
                    ),
                    updated_at = datetime('now')
              WHERE category = 'pseudo_comment'
                AND run_id IN (
                    SELECT id
                      FROM post_effect_runs
                     WHERE prompt_version = 'pseudo_comment_live_v1.0'
                )
                AND COALESCE(
                      CASE
                        WHEN json_valid(metadata)
                        THEN json_extract(metadata, '$.live')
                        ELSE NULL
                      END,
                      0
                    ) != 1",
            [],
        )?;
        Ok(())
    }

    /// One-shot migration: add scene intent column to tree_nodes and snapshot mirror.
    pub(super) fn migrate_tree_nodes_intent(conn: &Connection) -> anyhow::Result<()> {
        Self::add_column_if_missing(conn, "tree_nodes", "intent", "TEXT")?;
        Self::add_column_if_missing(conn, "project_snapshot_tree_nodes", "intent", "TEXT")?;
        Ok(())
    }

    /// One-shot migration: 本格暦化 — add Chronicle（作中暦日付）columns to
    /// tree_nodes and its snapshot mirror. events と同じ chronicleTime 日付モデルを
    /// シーンに共有する（events とは統合しない）。CHECK 無しの素 ALTER（events 列追加
    /// と同流儀）。granularity= 'none' / precision= 'exact' で NOT NULL を満たす。
    pub(super) fn migrate_tree_nodes_chronicle(conn: &Connection) -> anyhow::Result<()> {
        for table in ["tree_nodes", "project_snapshot_tree_nodes"] {
            Self::add_column_if_missing(conn, table, "chronicle_start_time", "INTEGER")?;
            Self::add_column_if_missing(conn, table, "chronicle_start_minute", "INTEGER")?;
            Self::add_column_if_missing(
                conn,
                table,
                "chronicle_start_granularity",
                "TEXT NOT NULL DEFAULT 'none'",
            )?;
            Self::add_column_if_missing(conn, table, "chronicle_end_time", "INTEGER")?;
            Self::add_column_if_missing(conn, table, "chronicle_end_minute", "INTEGER")?;
            Self::add_column_if_missing(
                conn,
                table,
                "chronicle_end_granularity",
                "TEXT NOT NULL DEFAULT 'none'",
            )?;
            Self::add_column_if_missing(
                conn,
                table,
                "chronicle_precision",
                "TEXT NOT NULL DEFAULT 'exact'",
            )?;
        }
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

    /// One-shot migration: index the codex body `content` column in codex_fts so
    /// search matches the ProseMirror body, not just name/aliases/summary/tags_cache.
    /// FTS5 columns are fixed at creation, so the virtual table and its triggers are
    /// rebuilt and the existing rows are re-indexed via the FTS5 'rebuild' command.
    /// Idempotent: a no-op once codex_fts already carries the `content` column.
    pub(super) fn migrate_codex_fts_add_content(conn: &Connection) -> anyhow::Result<()> {
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(codex_fts)")?
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<Result<_, _>>()?;
        if columns.iter().any(|c| c == "content") {
            return Ok(());
        }
        // Atomic rebuild: a partial failure must not leave codex_fts dropped.
        conn.execute_batch(
            "BEGIN;
             DROP TRIGGER IF EXISTS codex_fts_ai;
             DROP TRIGGER IF EXISTS codex_fts_ad;
             DROP TRIGGER IF EXISTS codex_fts_au;
             DROP TABLE IF EXISTS codex_fts;
             CREATE VIRTUAL TABLE codex_fts USING fts5(
                 name, aliases, summary, tags_cache, content,
                 content=codex_entries, content_rowid=rowid,
                 tokenize='trigram'
             );
             CREATE TRIGGER codex_fts_ai AFTER INSERT ON codex_entries BEGIN
                 INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache, content)
                 VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''), COALESCE(new.content, ''));
             END;
             CREATE TRIGGER codex_fts_ad AFTER DELETE ON codex_entries BEGIN
                 INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache, content)
                 VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''), COALESCE(old.content, ''));
             END;
             CREATE TRIGGER codex_fts_au AFTER UPDATE ON codex_entries
               WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache OR old.content IS NOT new.content
             BEGIN
                 INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache, content)
                 VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''), COALESCE(old.content, ''));
                 INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache, content)
                 VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''), COALESCE(new.content, ''));
             END;
             INSERT INTO codex_fts(codex_fts) VALUES('rebuild');
             COMMIT;",
        )?;
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

    /// Remove the historical project FK from the append-only AI audit ledger.
    ///
    /// `project_id` is scope identity, not ownership: deleting a mutable
    /// project must retain its audit trail, and Browser crash recovery can
    /// legitimately replay a project-scoped event before the project row from
    /// a newer in-memory snapshot has been persisted. SQLite cannot drop a
    /// foreign key in place, so preserve every stored field and rebuild only
    /// when the legacy FK is present.
    fn verify_ai_audit_events_project_identity_migration(
        conn: &Connection,
        expected_row_count: i64,
        expected_max_id: Option<i64>,
        expected_sequence_high_water: i64,
    ) -> anyhow::Result<()> {
        let row_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM ai_audit_events", [], |row| row.get(0))?;
        if row_count != expected_row_count {
            anyhow::bail!(
                "ai_audit_events row count changed during project identity migration: expected {expected_row_count}, got {row_count}"
            );
        }

        let max_id: Option<i64> =
            conn.query_row("SELECT MAX(id) FROM ai_audit_events", [], |row| row.get(0))?;
        if max_id != expected_max_id {
            anyhow::bail!(
                "ai_audit_events max id changed during project identity migration: expected {expected_max_id:?}, got {max_id:?}"
            );
        }

        let sequence_high_water: i64 = conn.query_row(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'ai_audit_events'), 0)",
            [],
            |row| row.get(0),
        )?;
        if sequence_high_water != expected_sequence_high_water {
            anyhow::bail!(
                "ai_audit_events sqlite_sequence changed during project identity migration: expected {expected_sequence_high_water}, got {sequence_high_water}"
            );
        }

        const REQUIRED_INDEXES: &[&str] = &[
            "uq_ai_audit_scope_seq",
            "uq_ai_audit_scope_event",
            "idx_ai_audit_scope_execution",
            "idx_ai_audit_scope_execution_event_type",
            "idx_ai_audit_scope_operation",
            "idx_ai_audit_scope_timestamp",
        ];
        for index in REQUIRED_INDEXES {
            let present: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [*index],
                |row| row.get(0),
            )?;
            if present != 1 {
                anyhow::bail!(
                    "ai_audit_events project identity migration is missing index {index}"
                );
            }
        }

        let mut statement = conn.prepare("PRAGMA foreign_key_check('ai_audit_events')")?;
        let mut rows = statement.query([])?;
        if rows.next()?.is_some() {
            anyhow::bail!(
                "ai_audit_events project identity migration left a foreign-key violation"
            );
        }
        Ok(())
    }

    pub(super) fn migrate_ai_audit_events_project_identity(
        conn: &Connection,
    ) -> anyhow::Result<()> {
        let has_project_fk = conn
            .prepare("PRAGMA foreign_key_list(ai_audit_events)")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>("table")?,
                    row.get::<_, String>("from")?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|(table, from)| table == "projects" && from == "project_id");
        if !has_project_fk {
            return Ok(());
        }

        let row_count_before: i64 =
            conn.query_row("SELECT COUNT(*) FROM ai_audit_events", [], |row| row.get(0))?;
        let max_id_before: Option<i64> =
            conn.query_row("SELECT MAX(id) FROM ai_audit_events", [], |row| row.get(0))?;
        let sequence_high_water_before: i64 = conn.query_row(
            "SELECT MAX(
                COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'ai_audit_events'), 0),
                COALESCE((SELECT MAX(id) FROM ai_audit_events), 0)
            )",
            [],
            |row| row.get(0),
        )?;

        let foreign_keys_enabled: bool =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        if foreign_keys_enabled {
            // PRAGMA foreign_keys has no effect inside a transaction.
            conn.pragma_update(None, "foreign_keys", false)?;
        }

        let migration = conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TEMP TABLE grimodex_ai_audit_sequence_high_water (
                sequence INTEGER NOT NULL
             );
             INSERT INTO grimodex_ai_audit_sequence_high_water (sequence)
             SELECT MAX(
                COALESCE((
                    SELECT seq FROM sqlite_sequence WHERE name = 'ai_audit_events'
                ), 0),
                COALESCE((SELECT MAX(id) FROM ai_audit_events), 0)
             );
             CREATE TABLE grimodex_ai_audit_events_without_project_fk (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id            TEXT NOT NULL,
                project_id          TEXT,
                sequence            INTEGER NOT NULL,
                event_id            TEXT NOT NULL,
                execution_id        TEXT NOT NULL,
                operation_id        TEXT NOT NULL,
                parent_execution_id TEXT,
                path_id             TEXT NOT NULL,
                event_type          TEXT NOT NULL,
                timestamp           INTEGER NOT NULL,
                recorded_at         INTEGER NOT NULL,
                payload             TEXT NOT NULL,
                payload_sha256      TEXT NOT NULL,
                prev_hash           TEXT NOT NULL,
                hash                TEXT NOT NULL,
                CHECK (
                    (scope_id = 'workspace' AND project_id IS NULL)
                    OR
                    (project_id IS NOT NULL AND scope_id = 'project:' || project_id)
                )
             );
             INSERT INTO grimodex_ai_audit_events_without_project_fk
                (id, scope_id, project_id, sequence, event_id, execution_id,
                 operation_id, parent_execution_id, path_id, event_type,
                 timestamp, recorded_at, payload, payload_sha256, prev_hash, hash)
             SELECT id, scope_id, project_id, sequence, event_id, execution_id,
                    operation_id, parent_execution_id, path_id, event_type,
                    timestamp, recorded_at, payload, payload_sha256, prev_hash, hash
               FROM ai_audit_events;
             DROP TABLE ai_audit_events;
             ALTER TABLE grimodex_ai_audit_events_without_project_fk
                RENAME TO ai_audit_events;
             CREATE UNIQUE INDEX uq_ai_audit_scope_seq
                ON ai_audit_events(scope_id, sequence);
             CREATE UNIQUE INDEX uq_ai_audit_scope_event
                ON ai_audit_events(scope_id, event_id);
             CREATE INDEX idx_ai_audit_scope_execution
                ON ai_audit_events(scope_id, execution_id, sequence);
             CREATE INDEX idx_ai_audit_scope_execution_event_type
                ON ai_audit_events(scope_id, execution_id, event_type);
             CREATE INDEX idx_ai_audit_scope_operation
                ON ai_audit_events(scope_id, operation_id, sequence);
             CREATE INDEX idx_ai_audit_scope_timestamp
                ON ai_audit_events(scope_id, timestamp, sequence);
             UPDATE sqlite_sequence
                SET seq = (
                    SELECT sequence FROM grimodex_ai_audit_sequence_high_water
                )
              WHERE name = 'ai_audit_events';
             INSERT INTO sqlite_sequence (name, seq)
             SELECT 'ai_audit_events', sequence
               FROM grimodex_ai_audit_sequence_high_water
              WHERE sequence > 0
                AND NOT EXISTS (
                    SELECT 1 FROM sqlite_sequence WHERE name = 'ai_audit_events'
                );
             DELETE FROM sqlite_sequence
              WHERE name = 'grimodex_ai_audit_events_without_project_fk';
             DROP TABLE grimodex_ai_audit_sequence_high_water;
             COMMIT;",
        );
        if migration.is_err() && !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK;");
        }
        let restore_foreign_keys = if foreign_keys_enabled {
            conn.pragma_update(None, "foreign_keys", true)
        } else {
            Ok(())
        };
        match (migration, restore_foreign_keys) {
            (Err(migration_error), _) => return Err(migration_error.into()),
            (Ok(()), Err(restore_error)) => return Err(restore_error.into()),
            (Ok(()), Ok(())) => {}
        }

        let remaining_project_fks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('ai_audit_events')
              WHERE \"table\" = 'projects' AND \"from\" = 'project_id'",
            [],
            |row| row.get(0),
        )?;
        if remaining_project_fks != 0 {
            anyhow::bail!("ai_audit_events project foreign key migration did not take effect");
        }
        Self::verify_ai_audit_events_project_identity_migration(
            conn,
            row_count_before,
            max_id_before,
            sequence_high_water_before,
        )?;
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
    use std::time::{Duration, Instant};

    fn temp_database_path(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("grimodex-migrate-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create migration test directory");
        dir.join("grimodex.db")
    }

    #[test]
    fn current_schema_migrate_is_read_only_while_another_connection_writes() {
        let path = temp_database_path("current-version-lock");
        let initializer = Database::new(&path).expect("open database");
        initializer.migrate().expect("create current schema");
        drop(initializer);

        let locker = Connection::open(&path).expect("open competing connection");
        locker
            .busy_timeout(Duration::from_millis(50))
            .expect("set competing busy timeout");
        locker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write reservation");

        // `Database::new` is part of the native workspace-open path. Its
        // connection PRAGMAs must also remain compatible with an unrelated WAL
        // writer before migrate reaches the current-version read fast path.
        let db = Database::new(&path).expect("open current database while writer is active");
        db.migrate()
            .expect("current-version open migration must remain read-only");
        let optimize_started = Instant::now();
        let optimize_result = db.optimize_without_wait();
        assert!(
            optimize_started.elapsed() < Duration::from_secs(1),
            "non-blocking optimize waited behind the writer"
        );
        if let Err(error) = optimize_result {
            assert!(
                error.to_string().contains("database is locked"),
                "unexpected optimize error: {error:#}"
            );
        }
        let restored_timeout_ms: i64 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read restored busy timeout");
        assert_eq!(restored_timeout_ms, 5_000);

        locker.execute_batch("ROLLBACK").expect("release writer");
        drop(locker);
        drop(db);
        std::fs::remove_dir_all(path.parent().expect("test directory"))
            .expect("remove migration test directory");
    }

    #[test]
    fn migrate_rejects_a_newer_schema_version() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        let future_version = grimodex_core::SCHEMA_VERSION + 1;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('future-running', 'default-project', 'review', 'project',
                         'model', 'v1', 'running')",
                [],
            )?;
            conn.pragma_update(None, "user_version", future_version)?;
            Ok(())
        })
        .expect("stamp future schema version");

        let error = db
            .migrate()
            .expect_err("newer workspace schema must not be opened by an older binary");
        assert_eq!(
            error.to_string(),
            format!(
                "workspace schema version {future_version} is newer than supported version {}",
                grimodex_core::SCHEMA_VERSION
            )
        );
        db.with_conn(|conn| {
            let retained_version: i32 =
                conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let retained_status: String = conn.query_row(
                "SELECT status FROM post_effect_runs WHERE id = 'future-running'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(retained_version, future_version);
            assert_eq!(retained_status, "running");
            Ok(())
        })
        .expect("future schema rejection must not mutate recovery state");
    }

    #[test]
    fn converged_previous_schema_migrate_does_not_wait_for_writer() {
        let path = temp_database_path("converged-previous-version-lock");
        let db = Database::new(&path).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(None, "user_version", 2)?;
            Ok(())
        })
        .expect("mark database as schema version 2");

        let locker = Connection::open(&path).expect("open competing connection");
        locker
            .busy_timeout(Duration::from_millis(50))
            .expect("set competing busy timeout");
        locker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write reservation");

        let started = Instant::now();
        db.migrate()
            .expect("converged version 2 must use the non-blocking fast path");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "converged version 2 waited behind an unrelated writer"
        );
        let version_while_locked: i32 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read version after failed migration");
        assert_eq!(version_while_locked, 2);
        let restored_timeout_ms: i64 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read restored busy timeout");
        assert_eq!(restored_timeout_ms, 5_000);

        locker.execute_batch("ROLLBACK").expect("release writer");
        db.migrate()
            .expect("retry marker update after lock release");
        let migrated_version: i32 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read migrated version");
        assert_eq!(migrated_version, grimodex_core::SCHEMA_VERSION);

        drop(locker);
        drop(db);
        std::fs::remove_dir_all(path.parent().expect("test directory"))
            .expect("remove migration test directory");
    }

    #[test]
    fn converged_previous_schema_preserves_post_effect_crash_recovery() {
        let db =
            Database::new(std::path::Path::new(":memory:")).expect("open crash recovery fixture");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(None, "user_version", 2)?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('interrupted-run', 'default-project', 'review', 'project',
                         'model', 'v1', 'running')",
                [],
            )?;
            Ok(())
        })
        .expect("create interrupted v2 run");

        db.migrate()
            .expect("recover interrupted run before marker finalization");
        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let status: String = conn.query_row(
                "SELECT status FROM post_effect_runs WHERE id = 'interrupted-run'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            assert_eq!(status, "failed");
            Ok(())
        })
        .expect("verify crash recovery and marker");
    }

    #[test]
    fn converged_previous_schema_reports_blocked_recovery_without_waiting() {
        let path = temp_database_path("blocked-v2-crash-recovery");
        let db = Database::new(&path).expect("open crash recovery fixture");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(None, "user_version", 2)?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('interrupted-run', 'default-project', 'review', 'project',
                         'model', 'v1', 'running')",
                [],
            )?;
            Ok(())
        })
        .expect("create interrupted v2 run");

        let locker = Connection::open(&path).expect("open competing connection");
        locker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write reservation");

        let started = Instant::now();
        let error = db
            .migrate()
            .expect_err("blocked recovery must remain retryable");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "blocked recovery waited for SQLite's normal busy timeout"
        );
        assert!(
            error.to_string().contains("crash recovery is blocked"),
            "unexpected blocked recovery error: {error:#}"
        );
        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let status: String = conn.query_row(
                "SELECT status FROM post_effect_runs WHERE id = 'interrupted-run'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(version, 2);
            assert_eq!(status, "running");
            Ok(())
        })
        .expect("blocked recovery must not partially mutate state");

        locker.execute_batch("ROLLBACK").expect("release writer");
        drop(locker);
        drop(db);
        std::fs::remove_dir_all(path.parent().expect("test directory"))
            .expect("remove migration test directory");
    }

    #[test]
    fn incomplete_previous_schema_still_runs_full_migration() {
        let path = temp_database_path("incomplete-previous-version-lock");
        let db = Database::new(&path).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute_batch("DROP INDEX idx_ai_audit_scope_timestamp")?;
            conn.pragma_update(None, "user_version", 2)?;
            conn.busy_timeout(Duration::from_millis(50))?;
            Ok(())
        })
        .expect("create incomplete schema version 2");

        let locker = Connection::open(&path).expect("open competing connection");
        locker
            .busy_timeout(Duration::from_millis(50))
            .expect("set competing busy timeout");
        locker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write reservation");

        let error = db
            .migrate()
            .expect_err("incomplete version 2 must retain the full migration");
        assert!(
            error.to_string().contains("database is locked"),
            "expected SQLITE_BUSY from the migration write, got {error:#}"
        );
        let version_while_locked: i32 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read version after blocked full migration");
        assert_eq!(version_while_locked, 2);

        locker.execute_batch("ROLLBACK").expect("release writer");
        db.migrate().expect("repair incomplete schema after retry");
        db.with_conn(|conn| {
            let restored_index: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                     WHERE type = 'index' AND name = 'idx_ai_audit_scope_timestamp'
                )",
                [],
                |row| row.get(0),
            )?;
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert!(restored_index);
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            Ok(())
        })
        .expect("verify repaired schema");

        drop(locker);
        drop(db);
        std::fs::remove_dir_all(path.parent().expect("test directory"))
            .expect("remove migration test directory");
    }

    #[test]
    fn full_migration_does_not_stamp_an_unrepairable_previous_schema() {
        let db =
            Database::new(std::path::Path::new(":memory:")).expect("open malformed schema fixture");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute_batch(
                "ALTER TABLE ai_audit_events RENAME TO ai_audit_events_valid;
                 CREATE TABLE ai_audit_events AS
                    SELECT * FROM ai_audit_events_valid;
                 DROP TABLE ai_audit_events_valid;",
            )?;
            conn.pragma_update(None, "user_version", 2)?;
            Ok(())
        })
        .expect("replace audit ledger with malformed same-name table");

        let error = db
            .migrate()
            .expect_err("full migration must not stamp an unrepairable schema");
        assert!(
            error
                .to_string()
                .contains("did not satisfy version 3 invariants"),
            "unexpected migration error: {error:#}"
        );
        let retained_version: i32 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read retained schema version");
        assert_eq!(retained_version, 2);
    }

    #[test]
    fn migrate_decouples_legacy_ai_audit_project_fk_without_changing_rows() {
        let db = Database::new(std::path::Path::new(":memory:"))
            .expect("open in-memory database for legacy audit migration");
        db.migrate().expect("initial migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('doomed-project', 'Doomed')",
                [],
            )?;
            conn.execute(
                "INSERT INTO ai_audit_events
                    (scope_id, project_id, sequence, event_id, execution_id, operation_id,
                     parent_execution_id, path_id, event_type, timestamp, recorded_at,
                     payload, payload_sha256, prev_hash, hash)
                 VALUES
                    ('project:project-1', 'project-1', 1, 'event-1', 'execution-1',
                     'operation-1', NULL, 'browser_byok_web', 'execution.started', 1, 2,
                     '{\"captureState\":\"complete\"}', 'payload-hash', 'prev-hash', 'hash-1')",
                [],
            )?;
            conn.execute(
                "INSERT INTO ai_audit_events
                    (scope_id, project_id, sequence, event_id, execution_id, operation_id,
                     parent_execution_id, path_id, event_type, timestamp, recorded_at,
                     payload, payload_sha256, prev_hash, hash)
                 VALUES
                    ('project:doomed-project', 'doomed-project', 1, 'event-doomed',
                     'execution-doomed', 'operation-doomed', NULL, 'browser_byok_web',
                     'execution.started', 3, 4, '{\"captureState\":\"complete\"}',
                     'payload-hash-doomed', 'prev-hash-doomed', 'hash-doomed')",
                [],
            )?;

            conn.pragma_update(None, "foreign_keys", false)?;
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE grimodex_ai_audit_events_with_project_fk (
                    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_id            TEXT NOT NULL,
                    project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
                    sequence            INTEGER NOT NULL,
                    event_id            TEXT NOT NULL,
                    execution_id        TEXT NOT NULL,
                    operation_id        TEXT NOT NULL,
                    parent_execution_id TEXT,
                    path_id             TEXT NOT NULL,
                    event_type          TEXT NOT NULL,
                    timestamp           INTEGER NOT NULL,
                    recorded_at         INTEGER NOT NULL,
                    payload             TEXT NOT NULL,
                    payload_sha256      TEXT NOT NULL,
                    prev_hash           TEXT NOT NULL,
                    hash                TEXT NOT NULL,
                    CHECK (
                        (scope_id = 'workspace' AND project_id IS NULL)
                        OR
                        (project_id IS NOT NULL AND scope_id = 'project:' || project_id)
                    )
                 );
                 INSERT INTO grimodex_ai_audit_events_with_project_fk
                    SELECT * FROM ai_audit_events;
                 DROP TABLE ai_audit_events;
                 ALTER TABLE grimodex_ai_audit_events_with_project_fk
                    RENAME TO ai_audit_events;
                 CREATE UNIQUE INDEX uq_ai_audit_scope_seq
                    ON ai_audit_events(scope_id, sequence);
                 CREATE UNIQUE INDEX uq_ai_audit_scope_event
                    ON ai_audit_events(scope_id, event_id);
                 CREATE INDEX idx_ai_audit_scope_execution
                    ON ai_audit_events(scope_id, execution_id, sequence);
                 CREATE INDEX idx_ai_audit_scope_execution_event_type
                    ON ai_audit_events(scope_id, execution_id, event_type);
                 CREATE INDEX idx_ai_audit_scope_operation
                    ON ai_audit_events(scope_id, operation_id, sequence);
                 CREATE INDEX idx_ai_audit_scope_timestamp
                    ON ai_audit_events(scope_id, timestamp, sequence);
                 COMMIT;",
            )?;
            conn.pragma_update(None, "foreign_keys", true)?;
            conn.execute("DELETE FROM projects WHERE id = 'doomed-project'", [])?;
            conn.pragma_update(None, "user_version", 2)?;
            let legacy_fk_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('ai_audit_events')
                  WHERE \"table\" = 'projects' AND \"from\" = 'project_id'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(legacy_fk_count, 1);
            let legacy_sequence: i64 = conn.query_row(
                "SELECT seq FROM sqlite_sequence WHERE name = 'ai_audit_events'",
                [],
                |row| row.get(0),
            )?;
            let remaining_max_id: i64 =
                conn.query_row("SELECT MAX(id) FROM ai_audit_events", [], |row| row.get(0))?;
            assert_eq!(legacy_sequence, 2);
            assert_eq!(remaining_max_id, 1);
            Ok(())
        })
        .expect("build legacy audit schema");

        db.migrate().expect("migrate legacy audit schema");
        db.with_conn(|conn| {
            let remaining_fk_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('ai_audit_events')",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(remaining_fk_count, 0);
            let row: (String, String, i64, String, String) = conn.query_row(
                "SELECT scope_id, project_id, sequence, event_id, hash
                   FROM ai_audit_events WHERE id = 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(
                row,
                (
                    "project:project-1".to_string(),
                    "project-1".to_string(),
                    1,
                    "event-1".to_string(),
                    "hash-1".to_string(),
                )
            );
            let index_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_index_list('ai_audit_events')
                  WHERE origin = 'c'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(index_count, 6);

            conn.execute("DELETE FROM projects WHERE id = 'project-1'", [])?;
            let retained: i64 = conn.query_row(
                "SELECT COUNT(*) FROM ai_audit_events WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(retained, 1);
            conn.execute(
                "INSERT INTO ai_audit_events
                    (scope_id, project_id, sequence, event_id, execution_id, operation_id,
                     path_id, event_type, timestamp, recorded_at, payload, payload_sha256,
                     prev_hash, hash)
                 VALUES ('project:missing-project', 'missing-project', 1, 'event-2',
                         'execution-2', 'operation-2', 'browser_byok_web',
                         'execution.started', 3, 4, '{}', 'payload-hash-2',
                         'prev-hash-2', 'hash-2')",
                [],
            )?;
            let new_id: i64 = conn.query_row(
                "SELECT id FROM ai_audit_events WHERE event_id = 'event-2'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(new_id, 3, "migration must preserve issued id high-water");
            Ok(())
        })
        .expect("verify migrated audit schema");

        db.migrate().expect("migration remains idempotent");
    }

    #[test]
    fn failed_ai_audit_fk_rebuild_restores_foreign_key_enforcement() {
        let conn = Connection::open_in_memory()
            .expect("open in-memory database for failed audit migration");
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys before failed audit migration");
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE ai_audit_events (
                id INTEGER PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE CASCADE
             );
             CREATE TABLE grimodex_ai_audit_events_without_project_fk (
                id INTEGER PRIMARY KEY
             );",
        )
        .expect("create conflicting legacy audit migration fixture");

        Database::migrate_ai_audit_events_project_identity(&conn)
            .expect_err("conflicting migration table must fail the rebuild");

        let foreign_keys_enabled: bool = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("read foreign key state after failed audit migration");
        assert!(
            foreign_keys_enabled,
            "failed migration must restore FK mode"
        );
        let project_fk_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('ai_audit_events')
                  WHERE \"table\" = 'projects' AND \"from\" = 'project_id'",
                [],
                |row| row.get(0),
            )
            .expect("inspect legacy audit foreign key after failed migration");
        assert_eq!(project_fk_count, 1, "old table must remain intact");
    }

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
    fn migrate_backfills_chronicle_columns_on_legacy_events() {
        // Regression: a P0-era Chronicle install has events WITHOUT the
        // kind / location_codex_id / aggregate version columns. migrate() must
        // backfill them via add_column_if_missing — the fresh-DB CREATE TABLE
        // already includes them, so the legacy ALTER path is otherwise never
        // exercised.
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            // P0 events table (pre kind / location_codex_id).
            conn.execute_batch(
                "CREATE TABLE events (
                    id               TEXT PRIMARY KEY,
                    project_id       TEXT NOT NULL,
                    title            TEXT NOT NULL DEFAULT '',
                    note             TEXT,
                    ordinal          TEXT NOT NULL DEFAULT 'a0',
                    primary_codex_id TEXT,
                    start_time       INTEGER,
                    end_time         INTEGER,
                    precision        TEXT NOT NULL DEFAULT 'exact'
                                       CHECK(precision IN ('exact','approx','unknown')),
                    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 INSERT INTO events (id, project_id) VALUES ('e1', 'p1');",
            )?;
            Ok(())
        })
        .unwrap();

        // Must not error on the legacy (pre-kind / pre-location) table.
        db.migrate().unwrap();

        db.with_conn(|conn| {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(events)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            assert!(
                cols.iter().any(|c| c == "kind"),
                "kind column should be backfilled"
            );
            assert!(
                cols.iter().any(|c| c == "location_codex_id"),
                "location_codex_id column should be backfilled"
            );
            assert!(
                cols.iter().any(|c| c == "version"),
                "version column should be backfilled"
            );
            // The pre-existing legacy row picks up the DEFAULT backfill value.
            let (kind, version): (String, i64) = conn.query_row(
                "SELECT kind, version FROM events WHERE id = 'e1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(
                kind, "generic",
                "legacy row kind should default to 'generic'"
            );
            assert_eq!(version, 0, "legacy event version should default to zero");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migrate_backfills_version_on_legacy_codex_entry_phases() {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE codex_entry_phases (
                    id                    TEXT PRIMARY KEY,
                    entry_id              TEXT NOT NULL,
                    anchor_node_id         TEXT,
                    label                 TEXT NOT NULL DEFAULT '',
                    summary_override      TEXT,
                    content_override      TEXT,
                    context_mode_override TEXT,
                    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 INSERT INTO codex_entry_phases (id, entry_id)
                 VALUES ('phase-1', 'entry-1');",
            )?;
            Ok(())
        })
        .unwrap();

        db.migrate().unwrap();

        db.with_conn(|conn| {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(codex_entry_phases)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            assert!(
                cols.iter().any(|c| c == "version"),
                "version column should be backfilled"
            );
            let version: i64 = conn.query_row(
                "SELECT version FROM codex_entry_phases WHERE id = 'phase-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(version, 0, "legacy phase version should default to zero");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migrate_stamps_schema_version_only_after_all_steps_succeed() {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            // A deliberately malformed legacy table makes the later Chronicle
            // index creation fail, after AI-write infrastructure has migrated.
            conn.execute_batch(
                "CREATE TABLE events (id TEXT PRIMARY KEY);
                 PRAGMA user_version = 0;",
            )?;
            Ok(())
        })
        .unwrap();

        db.migrate()
            .expect_err("incomplete Chronicle schema must fail migration");

        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert_eq!(
                version, 0,
                "failed migration must not advertise the new schema version"
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migrate_backfills_chronicle_columns_on_legacy_tree_nodes() {
        // Regression: 本格暦化 — a pre-chronicle install has tree_nodes (and the
        // snapshot mirror) WITHOUT the chronicle_* columns. migrate() must
        // backfill all 7 on both tables via add_column_if_missing — the fresh-DB
        // CREATE TABLE already includes them, so the legacy ALTER path is
        // otherwise never exercised. Restore relies on these being present.
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            // Pre-chronicle tree_nodes / project_snapshot_tree_nodes (no chronicle_*).
            conn.execute_batch(
                "CREATE TABLE tree_nodes (
                    id               TEXT PRIMARY KEY,
                    project_id       TEXT NOT NULL,
                    parent_id        TEXT,
                    node_type        TEXT NOT NULL,
                    title            TEXT NOT NULL DEFAULT 'Untitled',
                    sort_order       TEXT NOT NULL DEFAULT 'a0',
                    story_time_order TEXT,
                    pov_character_id TEXT,
                    location_id      TEXT,
                    content          TEXT NOT NULL DEFAULT '{}',
                    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 INSERT INTO tree_nodes (id, project_id, node_type)
                   VALUES ('n1', 'p1', 'scene');
                 CREATE TABLE project_snapshot_tree_nodes (
                    snapshot_id     TEXT NOT NULL,
                    node_id         TEXT NOT NULL,
                    node_type       TEXT NOT NULL,
                    title           TEXT NOT NULL,
                    sort_order      TEXT NOT NULL,
                    body_version_id TEXT,
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (snapshot_id, node_id)
                 );",
            )?;
            Ok(())
        })
        .unwrap();

        // Must not error on the legacy (pre-chronicle) tables.
        db.migrate().unwrap();

        db.with_conn(|conn| {
            let chronicle_cols = [
                "chronicle_start_time",
                "chronicle_start_minute",
                "chronicle_start_granularity",
                "chronicle_end_time",
                "chronicle_end_minute",
                "chronicle_end_granularity",
                "chronicle_precision",
            ];
            for table in ["tree_nodes", "project_snapshot_tree_nodes"] {
                let cols: Vec<String> = conn
                    .prepare(&format!("PRAGMA table_info({table})"))?
                    .query_map([], |row| row.get::<_, String>("name"))?
                    .collect::<Result<_, _>>()?;
                for expected in chronicle_cols {
                    assert!(
                        cols.iter().any(|c| c == expected),
                        "{table}.{expected} should be backfilled"
                    );
                }
            }
            // The pre-existing legacy row picks up the NOT NULL DEFAULT backfill.
            let (start_gran, precision): (String, String) = conn.query_row(
                "SELECT chronicle_start_granularity, chronicle_precision
                 FROM tree_nodes WHERE id = 'n1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(start_gran, "none", "legacy granularity should default");
            assert_eq!(precision, "exact", "legacy precision should default");
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
    fn migrate_fresh_db_creates_plot_thread_tables() {
        // プロットスレッド機能の 3 テーブルが fresh DB で作られていること。
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            for t in [
                "plot_threads",
                "plot_thread_scene_links",
                "plot_thread_branches",
            ] {
                let exists: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |row| row.get(0),
                )?;
                assert_eq!(exists, 1, "{t} table should exist on a fresh DB");
            }
            // 束ねレイアウトの生存スパン override 列 (start/end) も存在すること。
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(plot_threads)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            for c in ["start_node_id", "end_node_id"] {
                assert!(
                    cols.iter().any(|n| n == c),
                    "plot_threads.{c} column should exist on a fresh DB"
                );
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn plot_thread_scene_links_enforces_phase_type_check() {
        // phase_type の CHECK enum が不正値を弾くこと。
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id) VALUES ('p1');
                 INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1');
                 INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('t1','p1','Thread','a0');",
            )?;
            Ok(())
        })
        .unwrap();

        // 正常な phase_type は挿入できる。
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type) \
                 VALUES ('l1','t1','s1','introduce')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        // 不正な phase_type は CHECK 制約で弾かれる。
        let bad = db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type) \
                 VALUES ('l2','t1','s1','BOGUS')",
                [],
            )?;
            Ok(())
        });
        assert!(bad.is_err(), "invalid phase_type must be rejected by CHECK");
    }

    #[test]
    fn plot_thread_branches_enforce_kind_check_and_cascade() {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id) VALUES ('p1');
                 INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1');
                 INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('t1','p1','A','a0');
                 INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('t2','p1','B','a1');",
            )?;
            Ok(())
        })
        .unwrap();

        // 正常な branch / merge は挿入できる。
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO plot_thread_branches (id, project_id, from_thread_id, to_thread_id, at_node_id, kind) \
                 VALUES ('b1','p1','t1','t2','s1','branch')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        // 不正な kind は CHECK で弾かれる。
        let bad = db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO plot_thread_branches (id, project_id, from_thread_id, to_thread_id, at_node_id, kind) \
                 VALUES ('b2','p1','t1','t2','s1','BOGUS')",
                [],
            )?;
            Ok(())
        });
        assert!(bad.is_err(), "invalid kind must be rejected by CHECK");

        // from スレッド削除で branch も CASCADE 削除される。FK を明示的に有効化して
        // デフォルト設定に依存しないようにする。
        db.with_conn(|conn| {
            conn.pragma_update(None, "foreign_keys", true)?;
            conn.execute("DELETE FROM plot_threads WHERE id='t1'", [])?;
            let remaining: i64 =
                conn.query_row("SELECT COUNT(*) FROM plot_thread_branches", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(remaining, 0, "branch should cascade-delete with its thread");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migrate_fresh_db_creates_chat_message_prompts() {
        // Per-message prompt snapshot side-table must exist on a fresh DB.
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_message_prompts'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(exists, 1, "chat_message_prompts table should exist");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn chat_message_prompt_snapshot_cascades_on_message_and_session_delete() {
        // FK CASCADE: deleting a message (or its session) removes the snapshot.
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id) VALUES ('p1');
                 INSERT INTO chat_sessions (id, project_id) VALUES ('s1', 'p1');
                 INSERT INTO chat_messages (id, session_id, role, content)
                     VALUES ('m1', 's1', 'user', 'hi'), ('m2', 's1', 'user', 'yo');
                 INSERT INTO chat_message_prompts (message_id, system_prompt)
                     VALUES ('m1', 'SYS-1'), ('m2', 'SYS-2');",
            )?;

            // Deleting one message drops only its snapshot.
            conn.execute("DELETE FROM chat_messages WHERE id = 'm1'", [])?;
            let after_msg: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chat_message_prompts WHERE message_id = 'm1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(after_msg, 0, "snapshot should cascade on message delete");

            // Deleting the session drops the remaining snapshot too.
            conn.execute("DELETE FROM chat_sessions WHERE id = 's1'", [])?;
            let remaining: i64 =
                conn.query_row("SELECT COUNT(*) FROM chat_message_prompts", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(remaining, 0, "snapshot should cascade on session delete");
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
    fn migrate_legacy_chat_sessions_without_codex_anchor_id() {
        // Regression: upgraded DBs have chat_sessions without codex_anchor_id.
        // migrate() must not CREATE INDEX on the missing column in the initial
        // batch — that used to fail with "no such column: codex_anchor_id" on
        // every workspace open.
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT 't',
                    language TEXT NOT NULL DEFAULT 'ja',
                    phase_resolution_mode TEXT NOT NULL DEFAULT 'auto',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 CREATE TABLE chat_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    node_id TEXT,
                    title TEXT NOT NULL DEFAULT 'New session',
                    title_manual INTEGER NOT NULL DEFAULT 0,
                    model TEXT NOT NULL DEFAULT 'm',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);",
            )?;
            Ok(())
        })
        .unwrap();

        db.migrate().unwrap();

        db.with_conn(|conn| {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(chat_sessions)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<_, _>>()?;
            assert!(cols.iter().any(|c| c == "codex_anchor_id"));
            assert!(cols.iter().any(|c| c == "snippet_anchor_id"));

            let index_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='idx_chat_sessions_codex_anchor'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(index_count, 1);

            let snippet_index_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='idx_chat_sessions_snippet_anchor'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(snippet_index_count, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn chat_sessions_snippet_anchor_id_migration_adds_column_and_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE snippets (id TEXT PRIMARY KEY);
             CREATE TABLE chat_sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_id TEXT,
                title TEXT NOT NULL DEFAULT 'New session',
                title_manual INTEGER NOT NULL DEFAULT 0,
                model TEXT NOT NULL DEFAULT 'm',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .unwrap();

        Database::add_column_if_missing(
            &conn,
            "chat_sessions",
            "snippet_anchor_id",
            "TEXT REFERENCES snippets(id) ON DELETE SET NULL",
        )
        .expect("add snippet_anchor_id");
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_snippet_anchor
                ON chat_sessions(project_id, snippet_anchor_id);",
        )
        .unwrap();

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(chat_sessions)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(columns.iter().any(|c| c == "snippet_anchor_id"));

        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='idx_chat_sessions_snippet_anchor'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
    }

    #[test]
    fn chat_sessions_codex_anchor_id_migration_adds_column_and_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE codex_entries (id TEXT PRIMARY KEY);
             CREATE TABLE chat_sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_id TEXT,
                title TEXT NOT NULL DEFAULT 'New session',
                title_manual INTEGER NOT NULL DEFAULT 0,
                model TEXT NOT NULL DEFAULT 'm',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .unwrap();

        Database::add_column_if_missing(
            &conn,
            "chat_sessions",
            "codex_anchor_id",
            "TEXT REFERENCES codex_entries(id) ON DELETE SET NULL",
        )
        .expect("add codex_anchor_id");
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_codex_anchor
                ON chat_sessions(project_id, codex_anchor_id);",
        )
        .unwrap();

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(chat_sessions)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(columns.iter().any(|c| c == "codex_anchor_id"));

        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='idx_chat_sessions_codex_anchor'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
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

    #[test]
    fn migrate_marks_legacy_live_pseudo_comments_without_touching_manual_ones() {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().expect("initial migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('live-run', 'p1', 'pseudo_comment', 'scene', 'model',
                         'pseudo_comment_live_v1.0', 'completed')",
                [],
            )?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('manual-run', 'p1', 'pseudo_comment', 'scene', 'model',
                         'pseudo_comment_v2.1', 'completed')",
                [],
            )?;
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, run_id, category, content, metadata)
                 VALUES ('live-ann', 'p1', 'live-run', 'pseudo_comment', 'ライブ', '{}')",
                [],
            )?;
            conn.execute_batch(
                r#"INSERT INTO post_effect_annotations
                    (id, project_id, run_id, category, content, metadata)
                 VALUES
                    ('live-invalid', 'p1', 'live-run', 'pseudo_comment', 'invalid', 'not-json'),
                    ('live-array', 'p1', 'live-run', 'pseudo_comment', 'array', '[]'),
                    ('live-scalar', 'p1', 'live-run', 'pseudo_comment', 'scalar', '1'),
                    ('live-object', 'p1', 'live-run', 'pseudo_comment', 'object', '{"kept":true}');"#,
            )?;
            conn.execute(
                "INSERT INTO post_effect_annotations
                    (id, project_id, run_id, category, content, metadata)
                 VALUES ('manual-ann', 'p1', 'manual-run', 'pseudo_comment', '通常', '{}')",
                [],
            )?;
            conn.pragma_update(None, "user_version", 2)?;
            Ok(())
        })
        .expect("insert fixtures");

        db.migrate().expect("repair migrate");
        db.with_conn(|conn| {
            let live: i64 = conn.query_row(
                "SELECT json_extract(metadata, '$.live')
                   FROM post_effect_annotations WHERE id = 'live-ann'",
                [],
                |row| row.get(0),
            )?;
            let manual: Option<i64> = conn.query_row(
                "SELECT json_extract(metadata, '$.live')
                   FROM post_effect_annotations WHERE id = 'manual-ann'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(live, 1);
            assert_eq!(manual, None);
            for id in ["live-invalid", "live-array", "live-scalar", "live-object"] {
                let repaired: i64 = conn.query_row(
                    "SELECT json_extract(metadata, '$.live')
                       FROM post_effect_annotations WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                assert_eq!(repaired, 1, "{id} must be repaired as a live object");
            }
            let preserved_object_field: bool = conn.query_row(
                "SELECT json_extract(metadata, '$.kept')
                   FROM post_effect_annotations WHERE id = 'live-object'",
                [],
                |row| row.get(0),
            )?;
            assert!(preserved_object_field);
            Ok(())
        })
        .expect("verify metadata repair");
    }
}
