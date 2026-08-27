use anyhow::Context;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use std::time::Duration;

use super::codex_relation_keys::build_codex_relation_semantic_key;
use super::Database;

enum ConvergedPreviousFinalize {
    Finalized,
    Busy,
    NeedsFullMigration,
}

impl Database {
    /// First workspace schema that owns the `schema_data_migrations` table.
    /// Restore compatibility may treat a missing table as provably
    /// pre-cutover only for an older, non-negative `user_version`.
    pub(crate) const SCHEMA_DATA_MIGRATIONS_INTRODUCED_SCHEMA_VERSION: i32 = 23;

    /// C2-ZC's activation marker is deliberately kept behind the schema-owner
    /// module.  `schema_data_migrations` is not a general-purpose runtime
    /// table: C2-ZB and every later schema/data contract must serialize its
    /// writes through this owner so a cutover cannot race a migration
    /// checkpoint or silently acquire a second marker-writing authority.
    pub(crate) const C2_ZC_CUTOVER_MIGRATION_ID: &'static str =
        "narrative-c2-canonical-freshness-v1";
    pub(crate) const C2_ZC_CUTOVER_CONTRACT_VERSION: i64 = 1;

    pub(crate) fn read_c2zc_cutover_marker(conn: &Connection) -> anyhow::Result<Option<i64>> {
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                  WHERE type = 'table' AND name = 'schema_data_migrations'
             )",
            [],
            |row| row.get(0),
        )?;
        if !table_exists {
            anyhow::bail!("NEX_C2ZC_CUTOVER_MARKER_MISSING: schema_data_migrations is unavailable");
        }
        conn.query_row(
            "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
            [Self::C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub(crate) fn record_c2zc_cutover_marker(
        conn: &Connection,
        applied_at: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !applied_at.trim().is_empty() && applied_at.trim() == applied_at,
            "NEX_C2ZC_CUTOVER_MARKER_TIMESTAMP_INVALID: appliedAt must be non-empty and unpadded"
        );
        let current = Self::read_c2zc_cutover_marker(conn)?;
        if let Some(version) = current {
            anyhow::ensure!(
                version == Self::C2_ZC_CUTOVER_CONTRACT_VERSION,
                "NEX_C2ZC_CUTOVER_MARKER_UNSUPPORTED: marker contract version {version} is not current"
            );
            return Ok(());
        }
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, ?3)",
            params![
                Self::C2_ZC_CUTOVER_MIGRATION_ID,
                Self::C2_ZC_CUTOVER_CONTRACT_VERSION,
                applied_at,
            ],
        )?;
        Ok(())
    }

    pub fn migrate(&self) -> anyhow::Result<()> {
        self.migrate_impl(false)
    }

    /// Open-time operational recovery for a DB that already satisfies the
    /// current schema checkpoint. Must not run schema DDL — Gate A requires
    /// upgrades to go through the shadow migration supervisor instead.
    pub(crate) fn recover_open_time_state_without_schema_ddl(&self) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        Self::recover_interrupted_post_effect_runs(&conn)?;
        Ok(())
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
                // A current marker is not sufficient when an interrupted or
                // prerelease migration left required physical objects absent.
                // The checkpoint is read-only, so a healthy workspace retains
                // the non-blocking open path.
                if !grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(
                    &conn,
                )? {
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
                && grimodex_core::workspace_schema::is_previous_workspace_schema_write_compatible(
                    &conn,
                )?
            {
                // The immediately previous marker may already carry every
                // current physical invariant after a prerelease/interrupted
                // marker update. Avoid replaying the full migration merely to
                // advance the marker. Finalization rechecks the invariant under
                // a zero-wait write reservation so an older process cannot
                // mutate the schema between the probe and stamp.
                let recovery_required = Self::has_interrupted_post_effect_runs(&conn)?;
                match Self::try_finalize_previous_schema_without_wait(&conn, SCHEMA_VERSION)? {
                    ConvergedPreviousFinalize::Finalized => return Ok(()),
                    ConvergedPreviousFinalize::Busy if !recovery_required => return Ok(()),
                    ConvergedPreviousFinalize::Busy => {
                        anyhow::bail!(
                            "workspace crash recovery is blocked by another SQLite writer; retry after it finishes"
                        )
                    }
                    ConvergedPreviousFinalize::NeedsFullMigration => {}
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
                version           INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, type_slug, name),
                -- Composite FK: (project_id, type_slug) must reference a row in codex_types.
                FOREIGN KEY (project_id, type_slug) REFERENCES codex_types(project_id, slug)
                  ON UPDATE CASCADE ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_codex_detail_defs
                ON codex_detail_definitions(project_id, type_slug, sort_order);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_detail_defs_project_id
                ON codex_detail_definitions(project_id, id);

            CREATE TABLE IF NOT EXISTS codex_detail_semantic_bindings (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                definition_id     TEXT NOT NULL,
                facet_key         TEXT NOT NULL,
                projection_kind   TEXT NOT NULL
                                    CHECK(projection_kind IN ('scalar-text', 'summary-text', 'enum', 'entity-reference')),
                temporal_policy   TEXT NOT NULL
                                    CHECK(temporal_policy IN ('base-only', 'phase-on-durable-change', 'base-and-phase', 'derived', 'manual-only')),
                source            TEXT NOT NULL
                                    CHECK(source IN ('preset', 'user', 'reviewed-ai')),
                confirmed         INTEGER NOT NULL DEFAULT 0
                                    CHECK(confirmed IN (0, 1)),
                version           INTEGER NOT NULL DEFAULT 0
                                    CHECK(version >= 0),
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (project_id, definition_id)
                  REFERENCES codex_detail_definitions(project_id, id)
                  ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_codex_detail_semantic_bindings_project_facet
                ON codex_detail_semantic_bindings(project_id, facet_key);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_detail_semantic_binding_definition_facet
                ON codex_detail_semantic_bindings(definition_id, facet_key);

            CREATE TABLE IF NOT EXISTS codex_detail_values (
                id            TEXT PRIMARY KEY,
                entry_id      TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
                value         TEXT,
                version       INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
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
                mechanism        TEXT,
                version          INTEGER NOT NULL DEFAULT 0,
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
                role               TEXT NOT NULL DEFAULT 'unspecified',
                strength           TEXT,
                ai_strength        TEXT,
                ai_reasoning       TEXT,
                attribution        TEXT NOT NULL DEFAULT 'human',
                ai_rationale       TEXT,
                last_evaluated_at  INTEGER,
                is_orphan          INTEGER NOT NULL DEFAULT 0,
                evidence_anchor_id TEXT,
                semantic_key       TEXT NOT NULL DEFAULT '',
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
                directionality      TEXT NOT NULL DEFAULT 'directed'
                    CHECK (directionality IN ('directed', 'symmetric')),
                inverse_label       TEXT,
                semantic_key        TEXT NOT NULL DEFAULT '',
                version             INTEGER NOT NULL DEFAULT 1,
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
                ON codex_relations(to_codex_id);
            CREATE INDEX IF NOT EXISTS idx_codex_relations_semantic_key
                ON codex_relations(semantic_key);",
        )?;
        Self::migrate_codex_relations_source_map_edge_id(&conn)?;
        Self::migrate_codex_relations_v7(&conn)?;

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
                version       INTEGER NOT NULL DEFAULT 0,
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
                semantic_key TEXT NOT NULL DEFAULT '',
                version     INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_plot_thread_links_thread
                ON plot_thread_scene_links(thread_id);
            CREATE INDEX IF NOT EXISTS idx_plot_thread_links_node
                ON plot_thread_scene_links(node_id);"
            // semantic_key index is created only after SCHEMA 11
            // add_column_if_missing, so schema-2 → current upgrades do not
            // CREATE INDEX against a pre-OCC table that still lacks the column.
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
                semantic_key    TEXT NOT NULL DEFAULT '',
                version         INTEGER NOT NULL DEFAULT 0,
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
                incarnation_token TEXT NOT NULL DEFAULT '',
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
                version           INTEGER NOT NULL DEFAULT 0,
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
        // Temporal extraction snapshots and Calendar Editor writes use this
        // generation token for compare-and-swap and stale-artifact detection.
        Self::add_column_if_missing(
            &conn,
            "project_calendar",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
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

        // SCHEMA 4: Native-owned Narrative runtime policy (Release Gate B Foundation).
        // Must exist before the marker advances so renderer cannot own authority.
        crate::narrative_runtime_policy::ensure_narrative_runtime_policy_row(&conn)?;
        // Narrative Extraction persistence (Run / Proposal / Apply).
        // Mirrors src/db/schema.ts and the ensure_test_schema shape in
        // narrative_extraction/repository.rs, plus Apply／Provenance tables.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_extraction_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface_path_id TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                spec_json TEXT NOT NULL,
                spec_digest TEXT NOT NULL,
                snapshot_digest TEXT,
                catalog_digest TEXT,
                registry_digest TEXT,
                status TEXT NOT NULL,
                coverage_json TEXT NOT NULL DEFAULT '{}',
                outcome_summary_json TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS narrative_extraction_tasks (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                task_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                input_json TEXT NOT NULL DEFAULT '{}',
                output_json TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                lease_owner TEXT,
                lease_expires_at TEXT,
                heartbeat_at TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS narrative_extraction_task_edges (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                from_task_id TEXT NOT NULL,
                to_task_id TEXT NOT NULL,
                edge_kind TEXT NOT NULL DEFAULT 'depends_on',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_extraction_attempts (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                error_message TEXT,
                output_json TEXT
            );
            CREATE TABLE IF NOT EXISTS narrative_extraction_artifacts (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                task_id TEXT,
                attempt_id TEXT,
                artifact_kind TEXT NOT NULL,
                payload_storage TEXT NOT NULL DEFAULT 'inline-json',
                payload_json TEXT,
                payload_ref TEXT,
                payload_digest TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_proposal_sets (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                set_kind TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                summary_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS narrative_proposals (
                id TEXT PRIMARY KEY,
                proposal_set_id TEXT NOT NULL,
                proposal_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'unreviewed',
                payload_json TEXT NOT NULL,
                current_revision_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_proposal_revisions (
                id TEXT PRIMARY KEY,
                proposal_id TEXT NOT NULL,
                revision_number INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                plan_fragment_json TEXT,
                plan_fragment_digest TEXT,
                origin_kind TEXT NOT NULL DEFAULT 'legacy-unbound',
                reconciliation_envelope_json TEXT,
                reconciliation_envelope_digest TEXT,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_revision_source_basis (
                revision_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                source_kind TEXT NOT NULL,
                source_key TEXT NOT NULL,
                revision_token TEXT NOT NULL,
                observed_at TEXT,
                PRIMARY KEY (revision_id, ordinal),
                UNIQUE (revision_id, source_key)
            );
            CREATE TABLE IF NOT EXISTS narrative_proposal_decisions (
                id TEXT PRIMARY KEY,
                proposal_id TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                decision TEXT NOT NULL,
                decision_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_apply_commits (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id TEXT,
                proposal_set_id TEXT,
                request_id TEXT NOT NULL,
                plan_digest TEXT NOT NULL,
                status TEXT NOT NULL,
                receipt_json TEXT,
                error_message TEXT,
                prepared_plan_json TEXT,
                prepared_policy_version INTEGER,
                prepared_at TEXT,
                authority_digest TEXT,
                session_id TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS narrative_apply_operations (
                id TEXT PRIMARY KEY,
                commit_id TEXT NOT NULL,
                operation_index INTEGER NOT NULL,
                operation_kind TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                result_entity_kind TEXT,
                result_entity_id TEXT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_proposal_applications (
                id TEXT PRIMARY KEY,
                commit_id TEXT NOT NULL,
                proposal_id TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                applied_entity_kind TEXT NOT NULL,
                applied_entity_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_commit_journals (
                id TEXT PRIMARY KEY,
                commit_id TEXT NOT NULL,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                before_json TEXT,
                after_json TEXT,
                created_at TEXT NOT NULL
            );",
        )?;

        // Temporal Constraint Graph persistence (SCHEMA_VERSION 10): Nodes /
        // Constraints / Projections. Mirrors src/db/schema.ts. Kind-specific
        // shapes are polymorphic JSON blobs (subject_json / payload_json), not
        // exploded into columns, matching the TS domain model in
        // src/features/narrative-extraction/temporal/{nodes,constraints}.ts.
        // The STN solver and Review UI are out of scope for this slice; these
        // tables are pure domain persistence + atomic commit/undo.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_temporal_nodes (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                timeline_kind TEXT NOT NULL DEFAULT 'primary'
                                CHECK(timeline_kind IN ('primary','alternate','embedded-fiction','hypothetical')),
                timeline_key  TEXT,
                subject_kind  TEXT NOT NULL
                                CHECK(subject_kind IN ('scene','event','state-boundary','phase-boundary','named-period')),
                subject_json  TEXT NOT NULL,
                semantic_key  TEXT NOT NULL,
                shape         TEXT NOT NULL DEFAULT 'unknown'
                                CHECK(shape IN ('point','interval','unknown')),
                fingerprint   TEXT NOT NULL,
                version       INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_narrative_temporal_nodes_semantic_key
                ON narrative_temporal_nodes(project_id, semantic_key);
            CREATE INDEX IF NOT EXISTS idx_narrative_temporal_nodes_project
                ON narrative_temporal_nodes(project_id);

            CREATE TABLE IF NOT EXISTS narrative_temporal_constraints (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind              TEXT NOT NULL
                                    CHECK(kind IN ('absolute-window','relative-offset','interval-relation','duration','symbolic')),
                authority         TEXT NOT NULL
                                    CHECK(authority IN ('user-metadata','user-confirmed','explicit-story-text','existing-domain-relation','deterministic-derived','model-inferred','projection-derived')),
                strictness        TEXT NOT NULL CHECK(strictness IN ('hard','soft')),
                semantic_key      TEXT NOT NULL,
                source_ids_json   TEXT NOT NULL DEFAULT '[]',
                fingerprint       TEXT NOT NULL,
                payload_json      TEXT NOT NULL,
                version           INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_narrative_temporal_constraints_semantic_key
                ON narrative_temporal_constraints(project_id, semantic_key);
            CREATE INDEX IF NOT EXISTS idx_narrative_temporal_constraints_project
                ON narrative_temporal_constraints(project_id, kind);

            CREATE TABLE IF NOT EXISTS narrative_temporal_projections (
                id                      TEXT PRIMARY KEY,
                project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                target_kind             TEXT NOT NULL CHECK(target_kind IN ('scene-time','event-time','scene-story-order')),
                target_id               TEXT NOT NULL,
                constraint_set_digest   TEXT NOT NULL,
                solver_version          TEXT NOT NULL,
                calendar_digest         TEXT,
                projected_value_digest  TEXT NOT NULL,
                target_result_version   INTEGER NOT NULL,
                application_id          TEXT NOT NULL,
                status                  TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('current','invalidated','undone')),
                version                 INTEGER NOT NULL DEFAULT 0,
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_narrative_temporal_projections_target
                ON narrative_temporal_projections(project_id, target_kind, target_id);",
        )?;

        // SCHEMA_VERSION 11: Plot Thread / Marker / Branch OCC + semantic keys.
        Self::add_column_if_missing(
            &conn,
            "plot_threads",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            &conn,
            "plot_thread_scene_links",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            &conn,
            "plot_thread_scene_links",
            "semantic_key",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Self::add_column_if_missing(
            &conn,
            "plot_thread_branches",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            &conn,
            "plot_thread_branches",
            "semantic_key",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        // Backfill semantic keys. Duplicate groups get `#dup:{id}` suffix so we
        // never delete legacy rows while keeping keys unique for new writers.
        conn.execute_batch(
            "UPDATE plot_thread_scene_links
                SET semantic_key = thread_id || '|' || node_id || '|' || phase_type
              WHERE semantic_key = '' OR semantic_key IS NULL;
             UPDATE plot_thread_scene_links
                SET semantic_key = semantic_key || '#dup:' || id
              WHERE id IN (
                SELECT id FROM plot_thread_scene_links a
                 WHERE EXISTS (
                   SELECT 1 FROM plot_thread_scene_links b
                    WHERE b.semantic_key = a.semantic_key
                      AND b.rowid < a.rowid
                 )
              );
             UPDATE plot_thread_branches
                SET semantic_key = from_thread_id || '|' || to_thread_id || '|' || at_node_id || '|' || kind
              WHERE semantic_key = '' OR semantic_key IS NULL;
             UPDATE plot_thread_branches
                SET semantic_key = semantic_key || '#dup:' || id
              WHERE id IN (
                SELECT id FROM plot_thread_branches a
                 WHERE EXISTS (
                   SELECT 1 FROM plot_thread_branches b
                    WHERE b.semantic_key = a.semantic_key
                      AND b.rowid < a.rowid
                 )
              );
             CREATE INDEX IF NOT EXISTS idx_plot_thread_links_semantic_key
                ON plot_thread_scene_links(semantic_key);
             CREATE INDEX IF NOT EXISTS idx_plot_thread_branches_semantic_key
                ON plot_thread_branches(semantic_key);
             CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_thread_links_semantic_key
                ON plot_thread_scene_links(semantic_key);
             CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_thread_branches_semantic_key
                ON plot_thread_branches(semantic_key);",
        )?;

        // SCHEMA_VERSION 12: Foreshadow root OCC and multi-payoff persistence.
        Self::add_column_if_missing(
            &conn,
            "foreshadows",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(&conn, "foreshadows", "mechanism", "TEXT")?;
        Self::add_column_if_missing(
            &conn,
            "foreshadow_setups",
            "role",
            "TEXT NOT NULL DEFAULT 'unspecified'",
        )?;
        Self::add_column_if_missing(&conn, "foreshadow_setups", "evidence_anchor_id", "TEXT")?;
        Self::add_column_if_missing(
            &conn,
            "foreshadow_setups",
            "semantic_key",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS foreshadow_payoffs (
                id                 TEXT PRIMARY KEY,
                foreshadow_id      TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
                scene_id           TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                from_pos           INTEGER,
                to_pos             INTEGER,
                role               TEXT NOT NULL DEFAULT 'unspecified',
                confirmed          INTEGER NOT NULL DEFAULT 0,
                is_primary         INTEGER NOT NULL DEFAULT 0,
                attribution        TEXT NOT NULL DEFAULT 'human',
                ai_rationale       TEXT,
                is_orphan          INTEGER NOT NULL DEFAULT 0,
                evidence_anchor_id TEXT,
                semantic_key       TEXT NOT NULL DEFAULT '',
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS foreshadow_setup_payoff_links (
                foreshadow_id TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
                setup_id      TEXT NOT NULL REFERENCES foreshadow_setups(id) ON DELETE CASCADE,
                payoff_id     TEXT NOT NULL REFERENCES foreshadow_payoffs(id) ON DELETE CASCADE,
                bridge_kind   TEXT NOT NULL DEFAULT 'unspecified',
                explanation   TEXT,
                created_at    INTEGER NOT NULL,
                PRIMARY KEY (foreshadow_id, setup_id, payoff_id)
            );

            UPDATE foreshadow_setups
               SET role = 'unspecified'
             WHERE role IS NULL OR role = '';
            UPDATE foreshadow_setups
               SET semantic_key = foreshadow_id || '|' || scene_id || '|' || from_pos || '|' || to_pos
             WHERE semantic_key IS NULL OR semantic_key = '';
            UPDATE foreshadow_setups
               SET semantic_key = semantic_key || '#dup:' || id
             WHERE id IN (
                SELECT id FROM foreshadow_setups a
                 WHERE EXISTS (
                    SELECT 1 FROM foreshadow_setups b
                     WHERE b.semantic_key = a.semantic_key
                       AND b.rowid < a.rowid
                 )
             );

            INSERT INTO foreshadow_payoffs (
                id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
                is_primary, attribution, ai_rationale, is_orphan, evidence_anchor_id,
                semantic_key, created_at, updated_at
            )
            SELECT
                'legacy-payoff:' || id,
                id,
                payoff_scene_id,
                payoff_from_pos,
                payoff_to_pos,
                'unspecified',
                payoff_confirmed,
                1,
                'human',
                NULL,
                0,
                NULL,
                id || '|' || payoff_scene_id || '|' || COALESCE(payoff_from_pos, '') || '|' || COALESCE(payoff_to_pos, ''),
                created_at,
                updated_at
              FROM foreshadows root
             WHERE payoff_scene_id IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM foreshadow_payoffs payoff
                    WHERE payoff.id = 'legacy-payoff:' || root.id
               );
            UPDATE foreshadow_payoffs
               SET semantic_key = foreshadow_id || '|' || scene_id || '|' || COALESCE(from_pos, '') || '|' || COALESCE(to_pos, '')
             WHERE semantic_key IS NULL OR semantic_key = '';
            UPDATE foreshadow_payoffs
               SET semantic_key = semantic_key || '#dup:' || id
             WHERE id IN (
                SELECT id FROM foreshadow_payoffs a
                 WHERE EXISTS (
                    SELECT 1 FROM foreshadow_payoffs b
                     WHERE b.semantic_key = a.semantic_key
                       AND b.rowid < a.rowid
                 )
             );

            CREATE INDEX IF NOT EXISTS idx_fs_setup_semantic_key
                ON foreshadow_setups(semantic_key);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_fs_setup_semantic_key
                ON foreshadow_setups(semantic_key);
            CREATE INDEX IF NOT EXISTS idx_fs_payoff_fid
                ON foreshadow_payoffs(foreshadow_id);
            CREATE INDEX IF NOT EXISTS idx_fs_payoff_scene
                ON foreshadow_payoffs(scene_id);
            CREATE INDEX IF NOT EXISTS idx_fs_payoff_semantic_key
                ON foreshadow_payoffs(semantic_key);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_fs_payoff_semantic_key
                ON foreshadow_payoffs(semantic_key);
            CREATE INDEX IF NOT EXISTS idx_fs_payoff_link_setup
                ON foreshadow_setup_payoff_links(setup_id);
            CREATE INDEX IF NOT EXISTS idx_fs_payoff_link_payoff
                ON foreshadow_setup_payoff_links(payoff_id);",
        )?;

        // SCHEMA_VERSION 13: Import Session persistence and native import commit
        // receipts. Scan staging remains independent until import orchestration
        // is wired through this durable session boundary.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS import_sessions (
                id                         TEXT PRIMARY KEY,
                state                      TEXT NOT NULL,
                adapter_id                 TEXT,
                adapter_version            TEXT,
                target_json                TEXT NOT NULL,
                source_package_digest      TEXT,
                source_package_ref         TEXT,
                extraction_run_ids_json    TEXT NOT NULL DEFAULT '[]',
                proposal_set_ids_json      TEXT NOT NULL DEFAULT '[]',
                error_message              TEXT,
                version                    INTEGER NOT NULL DEFAULT 0,
                created_at                 TEXT NOT NULL,
                updated_at                 TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_source_packages (
                id                 TEXT PRIMARY KEY,
                session_id         TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE,
                digest             TEXT NOT NULL,
                adapter_id         TEXT NOT NULL,
                adapter_version    TEXT NOT NULL,
                package_json       TEXT NOT NULL,
                created_at         TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_source_mappings (
                id                      TEXT PRIMARY KEY,
                source_set_id           TEXT NOT NULL,
                source_object_key       TEXT NOT NULL,
                source_object_kind      TEXT NOT NULL,
                target_kind             TEXT NOT NULL,
                target_id               TEXT NOT NULL,
                source_record_digest    TEXT NOT NULL,
                target_state_digest     TEXT NOT NULL,
                adapter_id              TEXT NOT NULL,
                adapter_version         TEXT NOT NULL,
                first_import_session_id TEXT NOT NULL,
                last_import_session_id  TEXT NOT NULL,
                status                  TEXT NOT NULL DEFAULT 'active',
                version                 INTEGER NOT NULL DEFAULT 0,
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_source_baselines (
                mapping_id              TEXT PRIMARY KEY REFERENCES import_source_mappings(id) ON DELETE CASCADE,
                source_digest           TEXT NOT NULL,
                target_digest           TEXT NOT NULL,
                normalized_body_digest  TEXT,
                target_version          INTEGER,
                adapter_version         TEXT NOT NULL,
                normalizer_version      TEXT NOT NULL,
                committed_at            TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_commits (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL,
                request_id      TEXT NOT NULL,
                plan_digest     TEXT NOT NULL,
                project_id      TEXT,
                status          TEXT NOT NULL,
                receipt_json    TEXT,
                error_message   TEXT,
                created_at      TEXT NOT NULL,
                UNIQUE(request_id)
            );
            CREATE TABLE IF NOT EXISTS import_evidence_bindings (
                id                        TEXT PRIMARY KEY,
                session_id                TEXT NOT NULL,
                evidence_anchor_id        TEXT NOT NULL,
                source_document_key       TEXT NOT NULL,
                target_scene_id           TEXT NOT NULL,
                source_document_digest    TEXT NOT NULL,
                committed_storage_digest  TEXT NOT NULL,
                projection_status         TEXT NOT NULL,
                committed_at              TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_import_sessions_state
                ON import_sessions(state, updated_at);
            CREATE INDEX IF NOT EXISTS idx_import_source_packages_session
                ON import_source_packages(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_import_source_mappings_source
                ON import_source_mappings(source_set_id, source_object_key);
            CREATE INDEX IF NOT EXISTS idx_import_source_mappings_target
                ON import_source_mappings(target_kind, target_id);
            CREATE INDEX IF NOT EXISTS idx_import_commits_session
                ON import_commits(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_import_evidence_bindings_session
                ON import_evidence_bindings(session_id, target_scene_id);",
        )?;

        // SCHEMA_VERSION 14: durable import capture inventory. Native filesystem
        // selection remains outside this migration; these tables only preserve
        // portable inventory, digest, and decoding metadata.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS import_captures (
                id            TEXT PRIMARY KEY,
                state         TEXT NOT NULL,
                source_kind   TEXT NOT NULL,
                sealed_digest TEXT,
                budget_json   TEXT NOT NULL,
                version       INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_capture_entries (
                id                  TEXT PRIMARY KEY,
                capture_id          TEXT NOT NULL REFERENCES import_captures(id) ON DELETE CASCADE,
                resource_key        TEXT NOT NULL,
                parent_resource_key TEXT,
                relative_path       TEXT NOT NULL,
                kind                TEXT NOT NULL,
                byte_length         INTEGER NOT NULL,
                extension           TEXT,
                capture_status      TEXT NOT NULL,
                raw_digest          TEXT,
                blob_ref            TEXT,
                created_at          TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_capture_blobs (
                digest      TEXT PRIMARY KEY,
                byte_length INTEGER NOT NULL,
                created_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_decoded_resources (
                id              TEXT PRIMARY KEY,
                capture_id      TEXT NOT NULL REFERENCES import_captures(id) ON DELETE CASCADE,
                resource_key    TEXT NOT NULL,
                decoder_id      TEXT NOT NULL,
                decoder_version TEXT NOT NULL,
                kind            TEXT NOT NULL,
                digest          TEXT NOT NULL,
                decoded_json    TEXT NOT NULL,
                created_at      TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS generic_extraction_schemas (
                id          TEXT NOT NULL,
                revision    INTEGER NOT NULL,
                name        TEXT NOT NULL,
                description TEXT,
                digest      TEXT NOT NULL,
                schema_json TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                UNIQUE(id, revision)
            );
            CREATE INDEX IF NOT EXISTS idx_import_captures_state
                ON import_captures(state, updated_at);
            CREATE INDEX IF NOT EXISTS idx_import_capture_entries_capture
                ON import_capture_entries(capture_id, capture_status, relative_path);
            CREATE INDEX IF NOT EXISTS idx_import_decoded_resources_capture
                ON import_decoded_resources(capture_id, resource_key);
            CREATE INDEX IF NOT EXISTS idx_generic_extraction_schemas_digest
                ON generic_extraction_schemas(digest);",
        )?;

        // SCHEMA_VERSION 15: Prepared Commit seal columns + revision plan fragments.
        // Fresh CREATE TABLE above already includes these; add_column covers
        // upgrades from SCHEMA 14 workspaces.
        Self::add_column_if_missing(
            &conn,
            "narrative_apply_commits",
            "prepared_plan_json",
            "TEXT",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_apply_commits",
            "prepared_policy_version",
            "INTEGER",
        )?;
        Self::add_column_if_missing(&conn, "narrative_apply_commits", "prepared_at", "TEXT")?;
        Self::add_column_if_missing(&conn, "narrative_apply_commits", "authority_digest", "TEXT")?;
        Self::add_column_if_missing(&conn, "narrative_apply_commits", "session_id", "TEXT")?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_revisions",
            "plan_fragment_json",
            "TEXT",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_revisions",
            "plan_fragment_digest",
            "TEXT",
        )?;

        // SCHEMA_VERSION 17: Proposal Revision Envelope identity and the
        // source-basis vector are immutable persistence facts. Existing rows
        // deliberately default to legacy-unbound and remain reviewable but
        // cannot be applied until re-extracted/re-reviewed.
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_revisions",
            "origin_kind",
            "TEXT NOT NULL DEFAULT 'legacy-unbound'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_revisions",
            "reconciliation_envelope_json",
            "TEXT",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_revisions",
            "reconciliation_envelope_digest",
            "TEXT",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_revision_source_basis (
                revision_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                source_kind TEXT NOT NULL,
                source_key TEXT NOT NULL,
                revision_token TEXT NOT NULL,
                observed_at TEXT,
                PRIMARY KEY (revision_id, ordinal),
                UNIQUE (revision_id, source_key)
            );",
        )?;

        // SCHEMA_VERSION 18: Prepared Commit source-basis OCC records the
        // freshness-only dependency of each immutable Application. These
        // tables intentionally have no source/domain foreign keys: source
        // deletion must never cascade into audit history or domain rows.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_projection_freshness (
                application_id TEXT PRIMARY KEY,
                status TEXT NOT NULL
                    CHECK(status IN ('fresh','stale','source-missing','anchor-mismatch','read-set-drift')),
                reason_json TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS narrative_projection_dependencies (
                application_id TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                source_key TEXT NOT NULL,
                observed_revision_token TEXT NOT NULL,
                propagation TEXT NOT NULL CHECK(propagation = 'freshness-only'),
                PRIMARY KEY (application_id, source_kind, source_key)
            );
            CREATE INDEX IF NOT EXISTS idx_narrative_projection_dependencies_source
                ON narrative_projection_dependencies(source_kind, source_key);",
        )?;

        // SCHEMA_VERSION 19: Native field authority is an independent
        // ownership ledger. It has no foreign keys into domain rows so a
        // deleted source/entity cannot cascade into decision or application
        // history. Decision actor metadata is stored in dedicated columns;
        // free-form decision_json is not an authority grant.
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_decisions",
            "actor_kind",
            "TEXT NOT NULL DEFAULT 'human'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_decisions",
            "actor_id",
            "TEXT NOT NULL DEFAULT 'legacy-review'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_decisions",
            "authority_scope",
            "TEXT NOT NULL DEFAULT 'legacy-review'",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_decisions",
            "override_field_paths_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_field_authority (
                project_id   TEXT NOT NULL,
                entity_kind  TEXT NOT NULL,
                entity_id    TEXT NOT NULL,
                field_path   TEXT NOT NULL,
                owner_kind   TEXT NOT NULL
                    CHECK(owner_kind IN ('human','ai','system','unknown')),
                explicit_lock INTEGER NOT NULL DEFAULT 0
                    CHECK(explicit_lock IN (0,1)),
                version      INTEGER NOT NULL DEFAULT 0,
                updated_at   TEXT NOT NULL,
                PRIMARY KEY(project_id, entity_kind, entity_id, field_path)
            );
            CREATE INDEX IF NOT EXISTS idx_narrative_field_authority_entity
            ON narrative_field_authority(project_id, entity_kind, entity_id);",
        )?;

        // SCHEMA_VERSION 20: Semantic retraction is a new immutable
        // Application, never an UPDATE/DELETE of the compensated history.
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_applications",
            "application_kind",
            "TEXT NOT NULL DEFAULT 'normal' CHECK(application_kind IN ('normal','compensation'))",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_proposal_applications",
            "compensates_application_id",
            "TEXT",
        )?;
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS narrative_source_basis_immutable_delete;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_narrative_compensation_target
                ON narrative_proposal_applications(compensates_application_id)
                WHERE application_kind = 'compensation'
                  AND compensates_application_id IS NOT NULL;
            CREATE TRIGGER IF NOT EXISTS narrative_revision_immutable_after_apply_update
                BEFORE UPDATE ON narrative_proposal_revisions
                WHEN EXISTS(
                    SELECT 1 FROM narrative_proposal_applications
                     WHERE revision_id = OLD.id
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_REVISION');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_revision_envelope_immutable_update
                BEFORE UPDATE ON narrative_proposal_revisions
                WHEN OLD.origin_kind IS NOT NEW.origin_kind
                  OR OLD.reconciliation_envelope_json IS NOT NEW.reconciliation_envelope_json
                  OR OLD.reconciliation_envelope_digest IS NOT NEW.reconciliation_envelope_digest
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_REVISION_ENVELOPE_IMMUTABLE');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_source_basis_immutable_update
                BEFORE UPDATE ON narrative_revision_source_basis
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_REVISION_SOURCE_BASIS_IMMUTABLE');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_source_basis_immutable_delete
                BEFORE DELETE ON narrative_revision_source_basis
                WHEN EXISTS(
                    SELECT 1 FROM narrative_proposal_applications
                     WHERE revision_id = OLD.revision_id
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_REVISION_SOURCE_BASIS_IMMUTABLE');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_revision_immutable_after_apply_delete
                BEFORE DELETE ON narrative_proposal_revisions
                WHEN EXISTS(
                    SELECT 1 FROM narrative_proposal_applications
                     WHERE revision_id = OLD.id
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_REVISION');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_decision_immutable_after_apply_update
                BEFORE UPDATE ON narrative_proposal_decisions
                WHEN EXISTS(
                    SELECT 1 FROM narrative_proposal_applications
                     WHERE proposal_id = OLD.proposal_id
                       AND revision_id = OLD.revision_id
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_DECISION');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_decision_immutable_after_apply_delete
                BEFORE DELETE ON narrative_proposal_decisions
                WHEN EXISTS(
                    SELECT 1 FROM narrative_proposal_applications
                     WHERE proposal_id = OLD.proposal_id
                       AND revision_id = OLD.revision_id
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_DECISION');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_application_immutable_update
                BEFORE UPDATE ON narrative_proposal_applications
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLICATION');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_application_immutable_delete
                BEFORE DELETE ON narrative_proposal_applications
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLICATION');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_application_kind_guard
                BEFORE INSERT ON narrative_proposal_applications
                WHEN NEW.application_kind NOT IN ('normal','compensation')
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_APPLICATION_KIND_INVALID');
                END;
            CREATE TRIGGER IF NOT EXISTS narrative_application_compensation_guard
                BEFORE INSERT ON narrative_proposal_applications
                WHEN (NEW.application_kind = 'normal' AND NEW.compensates_application_id IS NOT NULL)
                  OR (NEW.application_kind = 'compensation' AND NEW.compensates_application_id IS NULL)
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_APPLICATION_COMPENSATION_SHAPE_INVALID');
                END;",
        )?;

        // SCHEMA_VERSION 16: a generation token identifies one physical
        // scene-event association incarnation. Legacy rows deliberately use
        // the empty token so tokenless journals can only match migrated state.
        Self::add_column_if_missing(
            &conn,
            "scene_events",
            "incarnation_token",
            "TEXT NOT NULL DEFAULT ''",
        )?;

        // SCHEMA_VERSION 21: Narrative Maintenance Change Feed foundation.
        // This is not a second audit ledger. Every feed transaction is linked
        // to one canonical change_events row and exists only for downstream
        // freshness / dependency invalidation. Existing SCHEMA 18 projection
        // dependencies/freshness and SCHEMA 20 immutable Applications remain
        // authoritative for their respective domains.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_change_transactions (
                id                           TEXT NOT NULL,
                project_id                   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                request_id                   TEXT NOT NULL CHECK(length(request_id) > 0),
                source_domain                TEXT NOT NULL CHECK(length(source_domain) > 0),
                source_change_event_uid      TEXT NOT NULL CHECK(length(source_change_event_uid) > 0),
                source_change_event_sequence INTEGER NOT NULL CHECK(source_change_event_sequence > 0),
                cause_kind                   TEXT NOT NULL
                    CHECK(cause_kind IN ('forward','undo','redo')),
                original_transaction_id      TEXT,
                commit_id                    TEXT,
                journal_id                   TEXT,
                application_ids_json         TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(application_ids_json)
                      AND json_type(application_ids_json) = 'array'),
                payload_digest               TEXT NOT NULL CHECK(length(payload_digest) > 0),
                created_at                   TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, id),
                UNIQUE(project_id, source_domain, request_id),
                UNIQUE(project_id, source_change_event_uid),
                FOREIGN KEY(project_id, source_change_event_uid)
                    REFERENCES change_events(project_id, event_uid) ON DELETE RESTRICT,
                FOREIGN KEY(project_id, original_transaction_id)
                    REFERENCES narrative_change_transactions(project_id, id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS narrative_change_events (
                id                         TEXT NOT NULL,
                project_id                 TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                transaction_id             TEXT NOT NULL,
                canonical_change_event_uid TEXT NOT NULL,
                canonical_sequence         INTEGER NOT NULL CHECK(canonical_sequence > 0),
                event_ordinal              INTEGER NOT NULL CHECK(event_ordinal >= 0),
                object_key_json            TEXT NOT NULL CHECK(json_valid(object_key_json)),
                change_kind                TEXT NOT NULL
                    CHECK(change_kind IN ('content','metadata','order','association','catalog','calendar','policy','schema','unknown')),
                mutation_kind              TEXT NOT NULL
                    CHECK(mutation_kind IN ('create','update','delete','restore')),
                before_version             INTEGER,
                before_digest              TEXT,
                after_version              INTEGER,
                after_digest               TEXT,
                changed_paths_json         TEXT NOT NULL
                    CHECK(json_valid(changed_paths_json)
                      AND json_type(changed_paths_json) = 'array'),
                text_impact_json           TEXT CHECK(text_impact_json IS NULL OR json_valid(text_impact_json)),
                structural_impact_json     TEXT CHECK(structural_impact_json IS NULL OR json_valid(structural_impact_json)),
                occurred_at                TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, id),
                UNIQUE(project_id, canonical_change_event_uid, event_ordinal),
                FOREIGN KEY(project_id, transaction_id)
                    REFERENCES narrative_change_transactions(project_id, id) ON DELETE CASCADE,
                FOREIGN KEY(project_id, canonical_change_event_uid)
                    REFERENCES change_events(project_id, event_uid) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS narrative_change_object_heads (
                project_id                   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                object_identity               TEXT NOT NULL,
                after_version                 INTEGER,
                after_digest                  TEXT,
                event_id                      TEXT NOT NULL,
                canonical_sequence            INTEGER NOT NULL CHECK(canonical_sequence > 0),
                event_ordinal                 INTEGER NOT NULL CHECK(event_ordinal >= 0),
                updated_at                    TEXT NOT NULL,
                PRIMARY KEY(project_id, object_identity),
                FOREIGN KEY(project_id, event_id)
                    REFERENCES narrative_change_events(project_id, id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS narrative_change_cursors (
                project_id                    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                consumer_id                   TEXT NOT NULL CHECK(length(consumer_id) > 0),
                acknowledged_through_sequence INTEGER NOT NULL DEFAULT 0
                    CHECK(acknowledged_through_sequence >= 0),
                lease_owner                   TEXT,
                lease_expires_at              TEXT,
                last_error                    TEXT,
                updated_at                    TEXT NOT NULL,
                PRIMARY KEY(project_id, consumer_id)
            );
            CREATE TABLE IF NOT EXISTS narrative_change_sets (
                id                         TEXT NOT NULL,
                project_id                 TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                from_sequence_exclusive    INTEGER NOT NULL CHECK(from_sequence_exclusive >= 0),
                through_sequence_inclusive INTEGER NOT NULL
                    CHECK(through_sequence_inclusive > from_sequence_exclusive),
                event_ids_json             TEXT NOT NULL
                    CHECK(json_valid(event_ids_json) AND json_type(event_ids_json) = 'array'),
                affected_objects_json      TEXT NOT NULL
                    CHECK(json_valid(affected_objects_json) AND json_type(affected_objects_json) = 'array'),
                digest                     TEXT NOT NULL CHECK(length(digest) > 0),
                created_at                 TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, from_sequence_exclusive, through_sequence_inclusive, digest)
            );
            CREATE INDEX IF NOT EXISTS idx_narrative_change_transactions_project_sequence
                ON narrative_change_transactions(project_id, source_change_event_sequence);
            CREATE INDEX IF NOT EXISTS idx_narrative_change_events_project_sequence
                ON narrative_change_events(project_id, canonical_sequence, event_ordinal);
            CREATE INDEX IF NOT EXISTS idx_narrative_change_object_heads_project_sequence
                ON narrative_change_object_heads(project_id, canonical_sequence, event_ordinal);
            CREATE INDEX IF NOT EXISTS idx_narrative_change_cursors_project
                ON narrative_change_cursors(project_id, consumer_id);
            CREATE INDEX IF NOT EXISTS idx_narrative_change_sets_project_range
                ON narrative_change_sets(project_id, from_sequence_exclusive, through_sequence_inclusive);",
        )?;
        // Interrupted/prerelease SCHEMA 21 builds may have created the feed
        // transaction table before all nullable correlation fields landed.
        // SQLite's CREATE TABLE IF NOT EXISTS cannot repair that partial
        // shape, so keep the shadow migrator able to converge it safely.
        Self::add_column_if_missing(&conn, "narrative_change_transactions", "journal_id", "TEXT")?;

        // SCHEMA_VERSION 22: every feed transaction identifies the authority
        // that originated it. SQLite cannot add a NOT NULL column without a
        // default to a populated table, so rebuild the SCHEMA 21 parent while
        // preserving its child events and deterministic transaction identity.
        Self::migrate_narrative_change_transactions_v22(&conn)?;
        Self::backfill_narrative_change_object_heads(&conn)?;

        // SCHEMA_VERSION 23: Gate C2-01 Semantic Build Graph persistence.
        // ADR 005 fixes the contract this schema implements: Dependency Edge,
        // Edge State, Consumer Freshness, Application Contribution, Reverse
        // Lookup, Incremental Evaluator, Cursor, and Backfill
        // persistence/runtime, and nothing else. narrative_consumer_freshness
        // is the one durable Freshness authority (semantic-core-authorities
        // concern `evidence-freshness`); narrative_maintenance_finding_observations
        // is epoch-bound rebuildable diagnostic history and is never read as
        // the current value; narrative_maintenance_attention is durable
        // user state that never backflows into the Change Feed or into
        // Freshness. A Semantic Epoch is the generation boundary a restore,
        // migration, or full rebuild advances; see
        // `docs/adr/006-narrative-mutation-authority-routes.md`'s
        // `semantic-epoch-event` control.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_data_migrations (
                migration_id     TEXT NOT NULL,
                contract_version INTEGER NOT NULL CHECK(contract_version > 0),
                applied_at       TEXT NOT NULL,
                PRIMARY KEY(migration_id)
            );",
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_semantic_epochs (
                id                             TEXT NOT NULL,
                project_id                     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                epoch_number                   INTEGER NOT NULL CHECK(epoch_number >= 0),
                reason                         TEXT NOT NULL
                    CHECK(reason IN ('initial','restore','migration','integrity-repair','manual-rebuild')),
                triggered_by_change_event_uid  TEXT,
                created_at                     TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, epoch_number)
            );
            CREATE TABLE IF NOT EXISTS narrative_dependency_edges (
                id                          TEXT NOT NULL,
                project_id                  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                consumer_kind               TEXT NOT NULL CHECK(length(consumer_kind) > 0),
                consumer_key                TEXT NOT NULL CHECK(length(consumer_key) > 0),
                source_object_identity      TEXT NOT NULL CHECK(length(source_object_identity) > 0),
                read_set_json                TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(read_set_json) AND json_type(read_set_json) = 'array'),
                generated_by_transaction_id TEXT,
                created_at                  TEXT NOT NULL,
                owning_run_id               TEXT,
                PRIMARY KEY(id),
                UNIQUE(project_id, consumer_kind, consumer_key, source_object_identity)
            );
            CREATE TABLE IF NOT EXISTS narrative_dependency_edge_states (
                edge_id               TEXT NOT NULL,
                project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                evidence_freshness    TEXT NOT NULL
                    CHECK(evidence_freshness IN ('fresh','stale','source-missing','anchor-mismatch','read-set-drift','unknown')),
                reason_code           TEXT
                    CHECK(reason_code IS NULL OR reason_code IN (
                        'source-revision-changed','source-missing','evidence-overlap','context-overlap',
                        'exact-content-relocated','quote-not-found','quote-ambiguous','read-set-drift',
                        'normalizer-incompatible','component-incompatible','target-modified'
                    )),
                build_action          TEXT NOT NULL
                    CHECK(build_action IN ('none','revalidate-exact','reanchor-candidate','resolve-only','recompile-only','rebuild-required','refresh-available','manual')),
                evaluated_at_epoch_id TEXT NOT NULL REFERENCES narrative_semantic_epochs(id),
                evaluated_at          TEXT NOT NULL,
                PRIMARY KEY(edge_id),
                FOREIGN KEY(edge_id) REFERENCES narrative_dependency_edges(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS narrative_consumer_freshness (
                project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                consumer_kind         TEXT NOT NULL CHECK(length(consumer_kind) > 0),
                consumer_key          TEXT NOT NULL CHECK(length(consumer_key) > 0),
                evidence_freshness    TEXT NOT NULL
                    CHECK(evidence_freshness IN ('fresh','stale','source-missing','anchor-mismatch','read-set-drift','unknown')),
                build_action          TEXT NOT NULL
                    CHECK(build_action IN ('none','revalidate-exact','reanchor-candidate','resolve-only','recompile-only','rebuild-required','refresh-available','manual')),
                semantic_epoch_id     TEXT NOT NULL REFERENCES narrative_semantic_epochs(id),
                last_evaluated_run_id TEXT,
                updated_at            TEXT NOT NULL,
                PRIMARY KEY(project_id, consumer_kind, consumer_key)
            );
            CREATE TABLE IF NOT EXISTS narrative_application_contributions (
                id                     TEXT NOT NULL,
                project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                application_id         TEXT NOT NULL CHECK(length(application_id) > 0),
                commit_id              TEXT NOT NULL CHECK(length(commit_id) > 0),
                proposal_id            TEXT NOT NULL CHECK(length(proposal_id) > 0),
                revision_id            TEXT NOT NULL CHECK(length(revision_id) > 0),
                operation_id           TEXT
                    CHECK(operation_id IS NULL OR length(operation_id) > 0),
                target_object_identity TEXT NOT NULL CHECK(length(target_object_identity) > 0),
                field_path             TEXT NOT NULL CHECK(length(field_path) > 0),
                target_state           TEXT NOT NULL
                    CHECK(target_state IN ('unchanged','modified','missing','superseded','undone','not-applicable')),
                maintenance_ownership  TEXT NOT NULL DEFAULT 'maintained'
                    CHECK(maintenance_ownership IN ('maintained','user-owned','detached')),
                baseline_sequence      INTEGER
                    CHECK(baseline_sequence IS NULL OR baseline_sequence > 0),
                target_state_sequence  INTEGER
                    CHECK(target_state_sequence IS NULL OR target_state_sequence > 0),
                target_state_updated_at TEXT,
                created_at             TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, application_id, target_object_identity, field_path)
            );
            CREATE TABLE IF NOT EXISTS narrative_maintenance_finding_observations (
                id                           TEXT NOT NULL,
                project_id                   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id                       TEXT NOT NULL,
                semantic_epoch_id            TEXT NOT NULL REFERENCES narrative_semantic_epochs(id),
                edge_id                      TEXT,
                finding_key                  TEXT NOT NULL CHECK(length(finding_key) > 0),
                reason_code                  TEXT NOT NULL CHECK(reason_code IN (
                        'source-revision-changed','source-missing','evidence-overlap','context-overlap',
                        'exact-content-relocated','quote-not-found','quote-ambiguous','read-set-drift',
                        'normalizer-incompatible','component-incompatible','target-modified'
                    )),
                evidence_freshness_snapshot  TEXT NOT NULL
                    CHECK(evidence_freshness_snapshot IN ('fresh','stale','source-missing','anchor-mismatch','read-set-drift','unknown')),
                material_basis_digest        TEXT NOT NULL CHECK(length(material_basis_digest) > 0),
                observed_at                  TEXT NOT NULL,
                finding_identity             TEXT,
                rule_id                      TEXT NOT NULL DEFAULT 'narrative.consumer-freshness',
                rule_version                 INTEGER NOT NULL DEFAULT 1 CHECK(rule_version > 0),
                observation_digest           TEXT NOT NULL DEFAULT '',
                PRIMARY KEY(id)
            );
            CREATE TABLE IF NOT EXISTS narrative_maintenance_finding_lifecycle (
                id                         TEXT NOT NULL,
                project_id                 TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                finding_identity           TEXT NOT NULL CHECK(length(finding_identity) > 0),
                finding_key                TEXT NOT NULL CHECK(length(finding_key) > 0),
                rule_id                    TEXT NOT NULL CHECK(length(rule_id) > 0),
                rule_version               INTEGER NOT NULL CHECK(rule_version > 0),
                lifecycle_state            TEXT NOT NULL CHECK(lifecycle_state IN ('new','recurring','changed','resolved')),
                observation_digest         TEXT,
                material_basis_digest      TEXT,
                run_id                     TEXT NOT NULL,
                semantic_epoch_id         TEXT NOT NULL REFERENCES narrative_semantic_epochs(id),
                observed_at                TEXT NOT NULL,
                PRIMARY KEY(id)
            );
            CREATE TABLE IF NOT EXISTS narrative_maintenance_attention (
                project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                finding_key            TEXT NOT NULL CHECK(length(finding_key) > 0),
                finding_identity       TEXT,
                identity_resolution_status TEXT NOT NULL DEFAULT 'resolved'
                    CHECK(identity_resolution_status IN ('resolved','unresolved','legacy-unresolved')),
                disposition            TEXT NOT NULL CHECK(disposition IN ('snoozed','dismissed','flagged')),
                material_basis_digest  TEXT NOT NULL CHECK(length(material_basis_digest) > 0),
                snoozed_until          TEXT,
                set_at                 TEXT NOT NULL,
                set_by                 TEXT,
                PRIMARY KEY(project_id, finding_key)
            );
            -- SCHEMA 24 (Gate C2 Lane K/N Run Kind Policy). A Semantic Index
            -- may own only the five fields fixed in
            -- semantic-core-authorities.json's semanticIndexAllowedFields;
            -- index_key distinguishes multiple indexes a project may build
            -- (e.g. embeddings vs. a future secondary index) under one row
            -- shape.
            CREATE TABLE IF NOT EXISTS narrative_semantic_index_metadata (
                project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                index_key              TEXT NOT NULL CHECK(length(index_key) > 0),
                generation              INTEGER NOT NULL CHECK(generation >= 0),
                built_at                TEXT NOT NULL,
                source_digest           TEXT NOT NULL CHECK(length(source_digest) > 0),
                dependency_set_digest   TEXT NOT NULL CHECK(length(dependency_set_digest) > 0),
                dirty_cache_flag        INTEGER NOT NULL CHECK(dirty_cache_flag IN (0, 1)),
                PRIMARY KEY(project_id, index_key)
            );
            -- SCHEMA 24 (Gate C2 Lane N Repair). Durable claim covering the
            -- human-approval interval between a Verify-derived sealed repair
            -- plan being shown to a human and its approved execution; not a
            -- general workspace write lock (SQLite's own BEGIN IMMEDIATE
            -- already serializes the DML itself). One active claim per
            -- project by construction (PRIMARY KEY(project_id)); a stale
            -- claim past expires_at may be reclaimed by a fresh one.
            CREATE TABLE IF NOT EXISTS narrative_maintenance_repair_leases (
                project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                lease_owner             TEXT NOT NULL CHECK(length(lease_owner) > 0),
                verify_run_id           TEXT NOT NULL CHECK(length(verify_run_id) > 0),
                repair_plan_digest      TEXT NOT NULL CHECK(length(repair_plan_digest) > 0),
                semantic_epoch_id       TEXT NOT NULL REFERENCES narrative_semantic_epochs(id),
                claimed_at              TEXT NOT NULL,
                expires_at              TEXT NOT NULL,
                PRIMARY KEY(project_id)
            );
            -- Durable wake outbox: a Semantic Epoch rotation commits its wake
            -- identity in the same transaction, so a lost observer event (or
            -- an idempotent replay that suppresses re-emission) can never
            -- strand a rotated Epoch without a maintenance wake. Rows stay
            -- pending until main acknowledges the delivered wake.
            CREATE TABLE IF NOT EXISTS narrative_maintenance_wake_outbox (
                id          TEXT NOT NULL PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                operation   TEXT NOT NULL CHECK(length(operation) > 0),
                reason      TEXT NOT NULL CHECK(length(reason) > 0),
                created_at  TEXT NOT NULL,
                acked_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_narrative_wake_outbox_pending
                ON narrative_maintenance_wake_outbox(project_id)
                WHERE acked_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_narrative_semantic_epochs_project
                ON narrative_semantic_epochs(project_id, epoch_number);
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_edges_source
                ON narrative_dependency_edges(project_id, source_object_identity);
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_edges_consumer
                ON narrative_dependency_edges(project_id, consumer_kind, consumer_key);
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_edge_states_project
                ON narrative_dependency_edge_states(project_id, evidence_freshness);
            CREATE INDEX IF NOT EXISTS idx_narrative_consumer_freshness_epoch
                ON narrative_consumer_freshness(project_id, semantic_epoch_id);
            CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_target
                ON narrative_application_contributions(project_id, target_object_identity);
            CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_field
                ON narrative_application_contributions(project_id, target_object_identity, field_path);
            CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_application
                ON narrative_application_contributions(project_id, application_id);
            CREATE INDEX IF NOT EXISTS idx_narrative_finding_observations_key
                ON narrative_maintenance_finding_observations(project_id, finding_key, semantic_epoch_id);",
        )?;

        // SCHEMA_VERSION 33 / NIR-0 D1: sealed Dependency Declaration Set
        // storage.  V1 `narrative_dependency_edges` remains unchanged and
        // remains the canonical Freshness input until a later shadow/cutover
        // lane.  A declaration set is complete only inside the writer's one
        // transaction; `sealed` is the sole durable state.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_dependency_declaration_sets (
                id                    TEXT NOT NULL,
                project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                consumer_kind         TEXT NOT NULL CHECK(length(consumer_kind) > 0),
                consumer_key          TEXT NOT NULL CHECK(length(consumer_key) > 0),
                producer_id           TEXT NOT NULL CHECK(length(producer_id) > 0),
                producer_generation   INTEGER NOT NULL CHECK(producer_generation >= 0),
                dependency_set_digest TEXT NOT NULL
                    CHECK(length(dependency_set_digest) = 71
                      AND dependency_set_digest GLOB 'sha256:*'
                      AND substr(dependency_set_digest, 8) NOT GLOB '*[^0-9a-f]*'),
                state                 TEXT NOT NULL CHECK(state = 'sealed'),
                created_at            TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, consumer_kind, consumer_key,
                       producer_generation)
            );
            CREATE TABLE IF NOT EXISTS narrative_dependency_declaration_entries (
                id                    TEXT NOT NULL,
                declaration_set_id    TEXT NOT NULL
                    REFERENCES narrative_dependency_declaration_sets(id) ON DELETE CASCADE,
                source_object_identity TEXT NOT NULL CHECK(length(source_object_identity) > 0),
                dependency_key        TEXT NOT NULL
                    CHECK(length(dependency_key) = 71 AND dependency_key GLOB 'sha256:*'
                      AND substr(dependency_key, 8) NOT GLOB '*[^0-9a-f]*'),
                dependency_role       TEXT NOT NULL CHECK(length(dependency_role) > 0),
                role_contract_version TEXT NOT NULL
                    CHECK(length(role_contract_version) > 0),
                selector_json         TEXT NOT NULL
                    CHECK(json_valid(selector_json) AND json_type(selector_json) = 'object'),
                selector_digest        TEXT NOT NULL
                    CHECK(length(selector_digest) = 71 AND selector_digest GLOB 'sha256:*'
                      AND substr(selector_digest, 8) NOT GLOB '*[^0-9a-f]*'),
                created_at            TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(declaration_set_id, source_object_identity, dependency_key)
            );
            CREATE TABLE IF NOT EXISTS narrative_dependency_declaration_heads (
                project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                consumer_kind           TEXT NOT NULL CHECK(length(consumer_kind) > 0),
                consumer_key             TEXT NOT NULL CHECK(length(consumer_key) > 0),
                active_declaration_set_id TEXT NOT NULL
                    REFERENCES narrative_dependency_declaration_sets(id),
                producer_id              TEXT NOT NULL CHECK(length(producer_id) > 0),
                producer_generation     INTEGER NOT NULL CHECK(producer_generation >= 0),
                version                 INTEGER NOT NULL CHECK(version >= 1),
                updated_at              TEXT NOT NULL,
                PRIMARY KEY(project_id, consumer_kind, consumer_key)
            );
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_declaration_sets_consumer
                ON narrative_dependency_declaration_sets(project_id, consumer_kind, consumer_key);
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_declaration_entries_set
                ON narrative_dependency_declaration_entries(declaration_set_id);
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_declaration_entries_source
                ON narrative_dependency_declaration_entries(source_object_identity);
            CREATE INDEX IF NOT EXISTS idx_narrative_dependency_declaration_heads_set
                ON narrative_dependency_declaration_heads(active_declaration_set_id);",
        )?;

        // SCHEMA_VERSION 34 / NIR-0 C2A: durable, non-authoritative Chronicle
        // stage audit metadata.  The pure closure remains an input-side
        // contract, but a successful task completion stores the verified
        // model bindings and terminal receipts atomically with the task output
        // and extraction artifacts. The C1 closure remains ephemeral and is
        // never retained as a durable row (ADR 011 §2.1/plan 34f).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS narrative_extraction_stage_model_bindings (
                id                  TEXT NOT NULL PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id              TEXT NOT NULL,
                task_id             TEXT NOT NULL,
                attempt_id          TEXT NOT NULL,
                stage_execution_id  TEXT NOT NULL,
                binding_json        TEXT NOT NULL
                    CHECK(json_valid(binding_json)
                      AND json_type(binding_json) = 'object'),
                binding_digest      TEXT NOT NULL
                    CHECK(length(binding_digest) = 71
                      AND binding_digest GLOB 'sha256:*'
                      AND substr(binding_digest, 8) NOT GLOB '*[^0-9a-f]*'),
                created_at          TEXT NOT NULL,
                UNIQUE(project_id, stage_execution_id)
            );
            CREATE TABLE IF NOT EXISTS narrative_extraction_stage_receipts (
                id                    TEXT NOT NULL PRIMARY KEY,
                project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                run_id               TEXT NOT NULL,
                task_id              TEXT NOT NULL,
                attempt_id           TEXT NOT NULL,
                stage_execution_id   TEXT NOT NULL,
                receipt_json         TEXT NOT NULL
                    CHECK(json_valid(receipt_json)
                      AND json_type(receipt_json) = 'object'),
                receipt_digest       TEXT NOT NULL
                    CHECK(length(receipt_digest) = 71
                      AND receipt_digest GLOB 'sha256:*'
                      AND substr(receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'),
                model_binding_digest TEXT NOT NULL
                    CHECK(length(model_binding_digest) = 71
                      AND model_binding_digest GLOB 'sha256:*'
                      AND substr(model_binding_digest, 8) NOT GLOB '*[^0-9a-f]*'),
                terminal_status      TEXT NOT NULL
                    CHECK(terminal_status IN ('succeeded', 'failed', 'cancelled', 'skipped')),
                created_at           TEXT NOT NULL,
                UNIQUE(project_id, stage_execution_id)
            );
            CREATE INDEX IF NOT EXISTS idx_narrative_stage_model_bindings_owner
                ON narrative_extraction_stage_model_bindings(project_id, run_id, task_id, attempt_id);
            CREATE INDEX IF NOT EXISTS idx_narrative_stage_receipts_owner
                ON narrative_extraction_stage_receipts(project_id, run_id, task_id, attempt_id);
            ",
        )?;
        Self::repair_narrative_v2_monotonicity_trigger(&conn)?;

        // Epoch markers used to advance the durable Project object head with
        // their synthetic reset state; the writer no longer does, and any
        // head still pointing at a marker event is deleted so the next real
        // Project mutation chains from genuine domain state instead of
        // reporting a discontinuity against the sentinel.
        conn.execute(
            "DELETE FROM narrative_change_object_heads
              WHERE EXISTS (
                    SELECT 1
                      FROM narrative_change_events e
                     WHERE e.project_id = narrative_change_object_heads.project_id
                       AND e.id = narrative_change_object_heads.event_id
                       AND json_extract(e.object_key_json, '$.kind') = 'project'
                       AND json_extract(e.structural_impact_json, '$.event')
                               IN ('project-restored', 'semantic-epoch-reset'))",
            [],
        )?;

        // New Run columns: run_kind distinguishes cursor-bound Runs (the
        // Freshness evaluator) from non-cursor-bound Runs (interpretation,
        // Semantic Index rebuild, manual rebuild, backfill); the Cursor
        // table remains the reservation authority, not the Run row.
        Self::add_column_if_missing(
            &conn,
            "narrative_extraction_runs",
            "run_kind",
            "TEXT NOT NULL DEFAULT 'interpretation' CHECK(run_kind IN ('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill'))",
        )?;
        Self::add_column_if_missing(&conn, "narrative_extraction_runs", "consumer_id", "TEXT")?;
        Self::add_column_if_missing(
            &conn,
            "narrative_extraction_runs",
            "semantic_epoch_id",
            "TEXT REFERENCES narrative_semantic_epochs(id)",
        )?;
        Self::add_column_if_missing(&conn, "narrative_extraction_runs", "work_key", "TEXT")?;
        Self::add_column_if_missing(
            &conn,
            "narrative_extraction_runs",
            "terminal_reason_code",
            "TEXT CHECK(terminal_reason_code IS NULL OR terminal_reason_code GLOB 'NEX_*')",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_extraction_runs",
            "superseded_by_run_id",
            "TEXT REFERENCES narrative_extraction_runs(id)",
        )?;

        // SCHEMA 24 (Gate C2 Lane N Verify/Rebuild): the last Source
        // revision token/digest a Dependency Edge was evaluated against.
        // Mutation-time incremental evaluation gets this from the Change
        // Feed event that triggered it; a full Rebuild has no such event to
        // source it from, so the evaluator's own last-known baseline must be
        // durable. NULL for an Edge that has never been evaluated yet —
        // `evaluator::evaluate_edge`'s own first-observation branch already
        // treats a missing stored baseline as Stale/RebuildRequired rather
        // than defaulting to fresh.
        Self::add_column_if_missing(
            &conn,
            "narrative_dependency_edge_states",
            "observed_source_revision_token",
            "TEXT",
        )?;
        Self::add_column_if_missing(
            &conn,
            "narrative_dependency_edge_states",
            "observed_source_digest",
            "TEXT",
        )?;
        // SCHEMA 24 (Gate C2 Lane N Verify): a digest of the Consumer's
        // current dependency set (Lane M's compute_dependency_set_digest),
        // stamped at the same time as evidence_freshness/build_action so
        // Verify can detect drift between what the Consumer was last
        // evaluated against and its Dependency Edges as they exist now.
        // NULL for rows written before this column existed.
        Self::add_column_if_missing(
            &conn,
            "narrative_consumer_freshness",
            "dependency_set_digest",
            "TEXT",
        )?;

        // Run/Task/Attempt each own a separate status vocabulary and CHECK
        // constraint; adding one requires the rebuild pattern since SQLite
        // cannot ALTER TABLE ADD a multi-value CHECK to a populated table.
        Self::migrate_narrative_extraction_status_v23(&conn)?;
        // Cursor reservation columns for the Change Feed consumer that
        // drives the Freshness evaluator Run; existing pre-C2 consumers keep
        // using only acknowledged_through_sequence/lease.
        Self::migrate_narrative_change_cursors_v23(&conn)?;
        // SCHEMA 24 (Gate C2 Lane K/N Run Kind Policy,
        // narrative-run-kind-policy.json): run_kind gains
        // 'dependency-verify'/'dependency-repair'. dependency-backfill and
        // dependency-rebuild-derived reuse the existing 'backfill'/
        // 'semantic-index-rebuild' values and need no CHECK change.
        Self::migrate_run_kind_v24(&conn)?;
        // SCHEMA 25: Maintenance Attention gains the controls its route in
        // ADR 006 now requires — a row version for OCC, a request identity
        // for idempotent replay, and a mandatory actor. Without them two
        // windows setting a disposition on the same finding silently
        // last-write-wins, and a retried set could not be told apart from a
        // second deliberate one.
        Self::migrate_narrative_maintenance_attention_v25(&conn)?;
        // SCHEMA 26: a system Run records the *request* that asked for it,
        // separately from the work_key that says what the work is. Two
        // different concepts the policy already distinguishes
        // (`sameWorkKeyReuse` vs `sameRequestIdReuse`) but the schema could
        // not express, so a retried request and a second deliberate one
        // looked identical. Nullable: Runs created before this, and
        // interpretation Runs that have no request identity, keep NULL.
        Self::migrate_narrative_run_request_identity_v26(&conn)?;

        // SCHEMA 27: a Repair lease names the Run currently entitled to
        // apply it, so the mutation transaction can prove it still holds
        // the lease rather than assuming the claim it made minutes earlier
        // survived a slow backup.
        Self::migrate_narrative_repair_lease_run_binding_v27(&conn)?;

        // SCHEMA 28: Application Contributions are addressed by the ratified
        // Object Addressing kind. Two writers had been storing two different
        // vocabularies for one object, so a backfilled row and a live row
        // describing the same entity could never join.
        Self::migrate_narrative_contribution_target_identity_v28(&conn)?;

        // SCHEMA 28: repair Dependency Edges the pre-#535 Backfill wrote
        // double-prefixed. Re-running the Backfill cannot do it -- the work
        // key reuses a completed Run without comparing its sealed spec, so
        // the v2 transform never executes on a workspace that already ran v1.
        Self::migrate_narrative_dependency_edge_identity_v28(&conn)?;

        // SCHEMA 29's rebuild and SCHEMA 28's completion marker both write
        // `narrative_application_contributions`, and `migrate_impl` otherwise
        // runs in autocommit -- so without this savepoint a failure between
        // them is durable. Two distinct hazards live in that window:
        //
        //   * the marker step opens with three unconditional DELETEs of C2
        //     derived state, while the rebuild fails closed on an orphaned
        //     Contribution. Marker-first would pay the whole discard and then
        //     refuse to open, leaving Consumer Freshness -- the durable
        //     Freshness authority -- empty on a workspace nothing can rebuild
        //     until the orphan is repaired by hand.
        //   * the rebuild's own DROP+RENAME is a batch. Interrupted between
        //     them, the table is simply gone; the next open recreates it empty
        //     from `CREATE TABLE IF NOT EXISTS`, the rebuild's own guard sees
        //     the v29 columns and returns, and the checkpoint passes -- losing
        //     every Contribution attribution row while reporting health.
        //
        // Making the pair atomic answers both, and makes their relative order
        // a matter of taste rather than of data. They are ordered rebuild-first
        // anyway, so the only step that can refuse runs before the only step
        // that destroys.
        conn.execute_batch("SAVEPOINT narrative_c2_schema_30")?;
        let c2_result = (|| -> anyhow::Result<()> {
            Self::migrate_narrative_application_contributions_v29(&conn)?;
            Self::finish_narrative_c2_identity_data_migration_v28(&conn)?;
            // SCHEMA 30: a Dependency Edge records the Run that declared it,
            // instead of that being inferrable only from `consumer_kind`.
            //
            // `restore_rebuild` has to answer "which Run is this Edge's
            // `snapshot:<runId>` Source expected to name?" before it can
            // resolve that Source at all. It answered by reading
            // `consumer_key`, which is only correct while every Consumer is a
            // Run. Gate C2-2's finer grain breaks that, and breaks it
            // silently: `resolve_snapshot_document` requires an exact match,
            // and `build_edge_comparison_input` turns the resulting error into
            // `current_source_exists = false`, so present Sources would be
            // reported missing.
            //
            // Storing it per Edge rather than deriving it through
            // `narrative_proposal_revisions -> narrative_proposals ->
            // narrative_proposal_sets.run_id` is deliberate: it is a
            // *provenance* fact, so it stays true after the Proposal it came
            // from is deleted, exactly like the Contribution provenance
            // SCHEMA 29 added. Nullable, because an Edge whose declaring Run
            // cannot be identified must say so rather than name a wrong one.
            Self::migrate_narrative_dependency_edge_owning_run_v30(&conn)?;
            // ...and with every Edge naming its Run, the Edges the live
            // Producer declared under a Run can move onto the Revisions that
            // actually read those Sources.
            Self::migrate_narrative_consumer_grain_v30(&conn)?;
            Ok(())
        })();
        match c2_result {
            Ok(()) => conn.execute_batch("RELEASE narrative_c2_schema_30")?,
            Err(error) => {
                // `?` here would replace the migration's own error with
                // whatever the unwind failed on, losing the only description
                // of why the workspace could not be upgraded.
                if let Err(unwind) = conn.execute_batch(
                    "ROLLBACK TO narrative_c2_schema_30; RELEASE narrative_c2_schema_30",
                ) {
                    tracing::error!(
                        target: "narrative.migrate",
                        %unwind,
                        "failed to unwind the Gate C2 schema savepoint"
                    );
                }
                return Err(error);
            }
        }

        // After the rebuild, never with the other Contribution indexes in the
        // base DDL batch. That batch runs against whatever shape the table
        // already has, and on a SCHEMA 23-28 workspace that shape has no
        // `commit_id` -- the index would fail with "no such column" and the
        // workspace would stop opening. A fresh database does not show it,
        // because its base DDL creates the column in the same statement.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_commit
                ON narrative_application_contributions(project_id, commit_id);",
        )?;

        // SCHEMA 31: versioned Finding identity and append-only lifecycle.
        // This is deliberately after the C2-2 re-key so the backfill can
        // derive identities from the durable Edge subject and never from a
        // transient Run or Semantic Epoch.
        Self::migrate_narrative_finding_identity_v31(&conn)?;

        // SCHEMA 32 / C2-ZB: move legacy Backfill Run Edges onto their
        // durable Application identities. The savepoint is schema-owned and
        // spans every project's read-only preflight, all graph/derived-state
        // writes, touched-project migration Epochs, and the completion marker.
        // `user_version` remains unchanged until the checkpoint below.
        conn.execute_batch("SAVEPOINT narrative_c2_schema_32")?;
        let c2zb_result = (|| -> anyhow::Result<()> {
            let c2zb_marker_due = crate::narrative_extraction::c2zb_application_rekey::migrate_narrative_application_rekey_v32(
                &conn,
            )?;

            // The schema migration engine is the sole writer of
            // schema_data_migrations. Keep the C2-ZB marker inside the same
            // savepoint, after all data re-key writes and before the
            // checkpoint/user_version stamp, so marker-trigger failures and
            // deferred-constraint failures can unwind the whole migration.
            // The marker is written exactly once, when the data phase ran: an
            // existing marker is either a current-version no-op or fails
            // closed upstream, and its contract_version/applied_at provenance
            // is never rewritten here.
            if c2zb_marker_due {
                conn.execute(
                    "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
                     VALUES (?1, ?2, ?3)",
                    params![
                        crate::narrative_extraction::c2zb_application_rekey::C2_ZB_MIGRATION_ID,
                        crate::narrative_extraction::c2zb_application_rekey::C2_ZB_CONTRACT_VERSION,
                        chrono::Utc::now()
                            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                            .to_string(),
                    ],
                )
                .context("recording the C2-ZB Application re-key marker")?;
            }

            // The marker is part of the checkpoint, not a substitute for it.
            // Keep both the invariant check and the user_version stamp inside
            // the same savepoint as every C2-ZB write. A trigger, interrupted
            // connection, or any other post-rekey failure must roll back the
            // edge/history/derived-state changes, marker, and schema version
            // together so the next open can retry the complete migration.
            anyhow::ensure!(
                grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(&conn)?,
                "workspace schema did not satisfy current schema invariants after migration"
            );
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            Ok(())
        })();
        match c2zb_result {
            Ok(()) => {
                if let Err(error) = conn.execute_batch("RELEASE narrative_c2_schema_32") {
                    if let Err(unwind) = conn.execute_batch(
                        "ROLLBACK TO narrative_c2_schema_32; RELEASE narrative_c2_schema_32",
                    ) {
                        tracing::error!(
                            target: "narrative.migrate",
                            %unwind,
                            "failed to unwind the C2-ZB schema savepoint after RELEASE failed"
                        );
                    }
                    return Err(error.into());
                }
            }
            Err(error) => {
                if let Err(unwind) = conn.execute_batch(
                    "ROLLBACK TO narrative_c2_schema_32; RELEASE narrative_c2_schema_32",
                ) {
                    tracing::error!(
                        target: "narrative.migrate",
                        %unwind,
                        "failed to unwind the C2-ZB schema savepoint"
                    );
                }
                return Err(error);
            }
        }

        Ok(())
    }

    fn repair_narrative_v2_monotonicity_trigger(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch("SAVEPOINT narrative_c2a_trigger_repair")?;
        let repair = conn.execute_batch(
            r#"
            DROP TRIGGER IF EXISTS narrative_proposal_revisions_v2_monotonicity_guard;
            CREATE TRIGGER narrative_proposal_revisions_v2_monotonicity_guard
                BEFORE INSERT ON narrative_proposal_revisions
                WHEN EXISTS (
                    SELECT 1
                      FROM narrative_proposals p
                      JOIN narrative_proposal_revisions current_revision
                        ON current_revision.id = p.current_revision_id
                     WHERE p.id = NEW.proposal_id
                       AND current_revision.origin_kind = 'enveloped'
                       AND json_extract(current_revision.reconciliation_envelope_json,
                                        '$.schemaVersion') = 2
                )
                AND (
                    NEW.origin_kind <> 'enveloped'
                    OR NEW.reconciliation_envelope_json IS NULL
                    OR json_extract(NEW.reconciliation_envelope_json,
                                    '$.schemaVersion') IS NOT 2
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN');
                END;
            DROP TRIGGER IF EXISTS narrative_proposals_v2_pointer_monotonicity_guard;
            CREATE TRIGGER narrative_proposals_v2_pointer_monotonicity_guard
                BEFORE UPDATE OF current_revision_id ON narrative_proposals
                WHEN EXISTS (
                    SELECT 1
                      FROM narrative_proposal_revisions old_revision
                     WHERE old_revision.id = OLD.current_revision_id
                       AND old_revision.origin_kind = 'enveloped'
                       AND json_extract(old_revision.reconciliation_envelope_json,
                                        '$.schemaVersion') = 2
                )
                AND NOT EXISTS (
                    SELECT 1
                      FROM narrative_proposal_revisions new_revision
                     WHERE new_revision.id = NEW.current_revision_id
                       AND new_revision.origin_kind = 'enveloped'
                       AND json_extract(new_revision.reconciliation_envelope_json,
                                        '$.schemaVersion') = 2
                )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN');
                END;
            DROP TRIGGER IF EXISTS narrative_proposal_revisions_v2_immutable_update_guard;
            CREATE TRIGGER narrative_proposal_revisions_v2_immutable_update_guard
                BEFORE UPDATE ON narrative_proposal_revisions
                WHEN OLD.origin_kind = 'enveloped'
                 AND json_extract(OLD.reconciliation_envelope_json,
                                  '$.schemaVersion') = 2
                 AND (
                    OLD.id IS NOT NEW.id
                    OR OLD.proposal_id IS NOT NEW.proposal_id
                    OR OLD.revision_number IS NOT NEW.revision_number
                    OR OLD.payload_json IS NOT NEW.payload_json
                    OR OLD.plan_fragment_json IS NOT NEW.plan_fragment_json
                    OR OLD.plan_fragment_digest IS NOT NEW.plan_fragment_digest
                    OR OLD.origin_kind IS NOT NEW.origin_kind
                    OR OLD.reconciliation_envelope_json IS NOT NEW.reconciliation_envelope_json
                    OR OLD.reconciliation_envelope_digest IS NOT NEW.reconciliation_envelope_digest
                    OR OLD.created_at IS NOT NEW.created_at
                    OR OLD.created_by IS NOT NEW.created_by
                 )
                BEGIN
                    SELECT RAISE(ABORT, 'NEX_REVISION_V2_IMMUTABLE');
                END;
            "#,
        );
        match repair {
            Ok(()) => {
                if let Err(error) = conn.execute_batch("RELEASE narrative_c2a_trigger_repair") {
                    if let Err(unwind) = conn.execute_batch(
                        "ROLLBACK TO narrative_c2a_trigger_repair;
                         RELEASE narrative_c2a_trigger_repair",
                    ) {
                        tracing::error!(
                            target: "narrative.migrate",
                            %unwind,
                            "failed to unwind C2A trigger repair after release failure"
                        );
                    }
                    return Err(error.into());
                }
            }
            Err(error) => {
                if let Err(unwind) = conn.execute_batch(
                    "ROLLBACK TO narrative_c2a_trigger_repair;
                     RELEASE narrative_c2a_trigger_repair",
                ) {
                    tracing::error!(
                        target: "narrative.migrate",
                        %unwind,
                        "failed to unwind C2A trigger repair"
                    );
                }
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn backfill_narrative_change_object_heads(conn: &Connection) -> anyhow::Result<()> {
        if !conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_change_object_heads'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }

        let rows = conn
            .prepare(
                "SELECT project_id, object_key_json, after_version, after_digest,
                        id, canonical_sequence, event_ordinal, occurred_at
                   FROM narrative_change_events
                  ORDER BY project_id, canonical_sequence, event_ordinal",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for (
            project_id,
            object_key_json,
            after_version,
            after_digest,
            event_id,
            canonical_sequence,
            event_ordinal,
            occurred_at,
        ) in rows
        {
            let mut object_key: serde_json::Value = serde_json::from_str(&object_key_json)?;
            // SCHEMA 21 accepted the project aggregate marker without an
            // explicit projectId. Preserve that historical row by deriving
            // the identity from its already-scoped project column.
            if object_key.get("kind").and_then(serde_json::Value::as_str) == Some("project")
                && object_key.get("projectId").is_none()
            {
                if let Some(object) = object_key.as_object_mut() {
                    object.insert(
                        "projectId".to_string(),
                        serde_json::Value::String(project_id.clone()),
                    );
                }
            }
            let identity = crate::canonical_feed_snapshots::object_key_identity(&object_key)?;
            conn.execute(
                "INSERT INTO narrative_change_object_heads (
                    project_id, object_identity, after_version, after_digest, event_id,
                    canonical_sequence, event_ordinal, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(project_id, object_identity) DO UPDATE SET
                    after_version = excluded.after_version,
                    after_digest = excluded.after_digest,
                    event_id = excluded.event_id,
                    canonical_sequence = excluded.canonical_sequence,
                    event_ordinal = excluded.event_ordinal,
                    updated_at = excluded.updated_at
                  WHERE excluded.canonical_sequence > narrative_change_object_heads.canonical_sequence
                     OR (excluded.canonical_sequence = narrative_change_object_heads.canonical_sequence
                         AND excluded.event_ordinal > narrative_change_object_heads.event_ordinal)",
                rusqlite::params![
                    project_id,
                    identity,
                    after_version,
                    after_digest,
                    event_id,
                    canonical_sequence,
                    event_ordinal,
                    occurred_at,
                ],
            )?;
        }
        Ok(())
    }

    fn migrate_narrative_change_transactions_v22(conn: &Connection) -> anyhow::Result<()> {
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_change_transactions'
             )",
            [],
            |row| row.get(0),
        )?;
        if !table_exists {
            return Ok(());
        }

        let origin_shape = conn
            .prepare(
                "SELECT type, \"notnull\", dflt_value
                   FROM pragma_table_info('narrative_change_transactions')
                  WHERE name = 'origin'",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let undo_journal_shape = conn
            .prepare(
                "SELECT type, \"notnull\", dflt_value
                   FROM pragma_table_info('narrative_change_transactions')
                  WHERE name = 'undo_journal_id'",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let table_sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'table' AND name = 'narrative_change_transactions'",
            [],
            |row| row.get(0),
        )?;
        let compact_table_sql = table_sql
            .chars()
            .filter(|character| !character.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        let schema_ready = origin_shape.as_slice() == [("TEXT".to_string(), true, None)]
            && undo_journal_shape.as_slice() == [("TEXT".to_string(), false, None)]
            && compact_table_sql.contains(
                "check(originin('human','ai-apply','import','undo','redo','restore','migration'))",
            );
        if schema_ready {
            return Ok(());
        }

        anyhow::ensure!(
            conn.is_autocommit(),
            "SCHEMA 22 Change Feed origin migration requires autocommit"
        );
        let row_count_before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions",
            [],
            |row| row.get(0),
        )?;
        let had_origin = !origin_shape.is_empty();
        let origin_expression = if had_origin {
            "CASE
                WHEN origin IN ('human','ai-apply','import','undo','redo','restore','migration')
                    THEN origin
                WHEN cause_kind = 'undo' THEN 'undo'
                WHEN cause_kind = 'redo' THEN 'redo'
                ELSE 'migration'
             END"
        } else {
            "CASE cause_kind
                WHEN 'undo' THEN 'undo'
                WHEN 'redo' THEN 'redo'
                ELSE 'migration'
             END"
        };
        let undo_journal_expression = if undo_journal_shape.is_empty() {
            "NULL"
        } else {
            "undo_journal_id"
        };

        let foreign_keys_enabled: bool =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        conn.pragma_update(None, "foreign_keys", false)?;
        let migration_result = (|| -> anyhow::Result<()> {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let rebuild_result = (|| -> anyhow::Result<()> {
                conn.execute_batch(
                    "DROP TABLE IF EXISTS narrative_change_transactions_v22;
                     CREATE TABLE narrative_change_transactions_v22 (
                        id                           TEXT NOT NULL,
                        project_id                   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        request_id                   TEXT NOT NULL CHECK(length(request_id) > 0),
                        source_domain                TEXT NOT NULL CHECK(length(source_domain) > 0),
                        source_change_event_uid      TEXT NOT NULL CHECK(length(source_change_event_uid) > 0),
                        source_change_event_sequence INTEGER NOT NULL CHECK(source_change_event_sequence > 0),
                        cause_kind                   TEXT NOT NULL
                            CHECK(cause_kind IN ('forward','undo','redo')),
                        origin                       TEXT NOT NULL
                            CHECK(origin IN ('human','ai-apply','import','undo','redo','restore','migration')),
                        original_transaction_id      TEXT,
                        commit_id                    TEXT,
                        journal_id                   TEXT,
                        undo_journal_id              TEXT,
                        application_ids_json         TEXT NOT NULL DEFAULT '[]'
                            CHECK(json_valid(application_ids_json)
                              AND json_type(application_ids_json) = 'array'),
                        payload_digest               TEXT NOT NULL CHECK(length(payload_digest) > 0),
                        created_at                   TEXT NOT NULL,
                        PRIMARY KEY(id),
                        UNIQUE(project_id, id),
                        UNIQUE(project_id, source_domain, request_id),
                        UNIQUE(project_id, source_change_event_uid),
                        FOREIGN KEY(project_id, source_change_event_uid)
                            REFERENCES change_events(project_id, event_uid) ON DELETE RESTRICT,
                        FOREIGN KEY(project_id, original_transaction_id)
                            REFERENCES narrative_change_transactions(project_id, id) ON DELETE CASCADE
                     );",
                )?;
                conn.execute_batch(&format!(
                    "INSERT INTO narrative_change_transactions_v22
                        (id, project_id, request_id, source_domain,
                         source_change_event_uid, source_change_event_sequence,
                         cause_kind, origin, original_transaction_id, commit_id,
                         journal_id, undo_journal_id, application_ids_json,
                         payload_digest, created_at)
                     SELECT id, project_id, request_id, source_domain,
                            source_change_event_uid, source_change_event_sequence,
                            cause_kind, {origin_expression}, original_transaction_id,
                            commit_id, journal_id, {undo_journal_expression}, application_ids_json,
                            payload_digest, created_at
                       FROM narrative_change_transactions;"
                ))?;
                conn.execute_batch(
                    "DROP TABLE narrative_change_transactions;
                     ALTER TABLE narrative_change_transactions_v22
                        RENAME TO narrative_change_transactions;
                     CREATE INDEX idx_narrative_change_transactions_project_sequence
                        ON narrative_change_transactions(project_id, source_change_event_sequence);",
                )?;
                Ok(())
            })();
            match rebuild_result {
                Ok(()) => grimodex_core::commit_or_rollback(conn),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })();
        let restore_foreign_keys = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled);
        if let Err(error) = migration_result {
            restore_foreign_keys?;
            return Err(error);
        }
        restore_foreign_keys?;

        let row_count_after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            row_count_after == row_count_before,
            "SCHEMA 22 Change Feed origin migration changed transaction row count"
        );
        let foreign_key_errors: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM pragma_foreign_key_check
              WHERE \"table\" IN ('narrative_change_transactions','narrative_change_events')",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            foreign_key_errors == 0,
            "SCHEMA 22 Change Feed origin migration left foreign key violations"
        );
        Ok(())
    }

    /// SCHEMA_VERSION 23: Run, Task, and Attempt each get their own status
    /// CHECK constraint instead of sharing one untyped `status TEXT`
    /// column — `policies/narrative/narrative-execution-state.json` is the
    /// contract this enforces physically. Attempt also gains typed failure
    /// columns (`failure_code`/`retry_disposition`/`policy_version`/
    /// `next_attempt_at`) per `narrative-failure-policy.json`. SQLite cannot
    /// ALTER TABLE ADD a CHECK constraint to a populated table, so this
    /// rebuilds all three tables in one transaction.
    fn migrate_narrative_extraction_status_v23(conn: &Connection) -> anyhow::Result<()> {
        let runs_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_extraction_runs'
             )",
            [],
            |row| row.get(0),
        )?;
        if !runs_exists {
            return Ok(());
        }
        let runs_sql = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'narrative_extraction_runs'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        let compact_runs_sql = Self::compact(&runs_sql);
        let schema_ready = compact_runs_sql.contains(
            "check(statusin('pending','running','completed','failed','cancelled','superseded'))",
        );
        if schema_ready {
            return Ok(());
        }

        // Fail closed on any status value the new CHECK does not allow,
        // rather than silently coercing it — NEX_EXECUTION_STATUS_INVALID
        // is a manual-intervention failure code, not something this
        // migration should assign itself.
        let invalid_run_statuses: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT status FROM narrative_extraction_runs
                  WHERE status NOT IN ('pending','running','completed','failed','cancelled','superseded')",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        anyhow::ensure!(
            invalid_run_statuses.is_empty(),
            "SCHEMA 23 execution-state migration found narrative_extraction_runs rows with an \
             unrecognized status (NEX_EXECUTION_STATUS_INVALID): {invalid_run_statuses:?}"
        );
        let invalid_task_statuses: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT status FROM narrative_extraction_tasks
                  WHERE status NOT IN ('queued','running','completed','failed','cancelled')",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        anyhow::ensure!(
            invalid_task_statuses.is_empty(),
            "SCHEMA 23 execution-state migration found narrative_extraction_tasks rows with an \
             unrecognized status (NEX_EXECUTION_STATUS_INVALID): {invalid_task_statuses:?}"
        );
        let invalid_attempt_statuses: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT status FROM narrative_extraction_attempts
                  WHERE status NOT IN ('running','completed','failed')",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        anyhow::ensure!(
            invalid_attempt_statuses.is_empty(),
            "SCHEMA 23 execution-state migration found narrative_extraction_attempts rows with an \
             unrecognized status (NEX_EXECUTION_STATUS_INVALID): {invalid_attempt_statuses:?}"
        );

        anyhow::ensure!(
            conn.is_autocommit(),
            "SCHEMA 23 execution-state migration requires autocommit"
        );
        let run_count_before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs",
            [],
            |row| row.get(0),
        )?;
        let task_count_before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_tasks",
            [],
            |row| row.get(0),
        )?;
        let attempt_count_before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_attempts",
            [],
            |row| row.get(0),
        )?;

        let foreign_keys_enabled: bool =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        conn.pragma_update(None, "foreign_keys", false)?;
        let migration_result = (|| -> anyhow::Result<()> {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let rebuild_result = (|| -> anyhow::Result<()> {
                conn.execute_batch(
                    "DROP TABLE IF EXISTS narrative_extraction_runs_v23;
                     CREATE TABLE narrative_extraction_runs_v23 (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        surface_path_id TEXT NOT NULL,
                        scope_json TEXT NOT NULL,
                        spec_json TEXT NOT NULL,
                        spec_digest TEXT NOT NULL,
                        snapshot_digest TEXT,
                        catalog_digest TEXT,
                        registry_digest TEXT,
                        status TEXT NOT NULL
                            CHECK(status IN ('pending','running','completed','failed','cancelled','superseded')),
                        coverage_json TEXT NOT NULL DEFAULT '{}',
                        outcome_summary_json TEXT,
                        created_at TEXT NOT NULL,
                        started_at TEXT,
                        completed_at TEXT,
                        version INTEGER NOT NULL DEFAULT 0,
                        run_kind TEXT NOT NULL DEFAULT 'interpretation'
                            CHECK(run_kind IN ('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill')),
                        consumer_id TEXT,
                        semantic_epoch_id TEXT REFERENCES narrative_semantic_epochs(id),
                        work_key TEXT,
                        terminal_reason_code TEXT
                            CHECK(terminal_reason_code IS NULL OR terminal_reason_code GLOB 'NEX_*'),
                        superseded_by_run_id TEXT REFERENCES narrative_extraction_runs(id)
                     );
                     INSERT INTO narrative_extraction_runs_v23
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                         outcome_summary_json, created_at, started_at, completed_at, version,
                         run_kind, consumer_id, semantic_epoch_id, work_key, terminal_reason_code,
                         superseded_by_run_id)
                     SELECT id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                            snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                            outcome_summary_json, created_at, started_at, completed_at, version,
                            'interpretation', NULL, NULL, NULL, NULL, NULL
                       FROM narrative_extraction_runs;
                     DROP TABLE narrative_extraction_runs;
                     ALTER TABLE narrative_extraction_runs_v23 RENAME TO narrative_extraction_runs;

                     DROP TABLE IF EXISTS narrative_extraction_tasks_v23;
                     CREATE TABLE narrative_extraction_tasks_v23 (
                        id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL,
                        task_kind TEXT NOT NULL,
                        status TEXT NOT NULL
                            CHECK(status IN ('queued','running','completed','failed','cancelled')),
                        input_json TEXT NOT NULL DEFAULT '{}',
                        output_json TEXT,
                        priority INTEGER NOT NULL DEFAULT 0,
                        attempt_count INTEGER NOT NULL DEFAULT 0,
                        lease_owner TEXT,
                        lease_expires_at TEXT,
                        heartbeat_at TEXT,
                        error_message TEXT,
                        created_at TEXT NOT NULL,
                        started_at TEXT,
                        completed_at TEXT,
                        version INTEGER NOT NULL DEFAULT 0
                     );
                     INSERT INTO narrative_extraction_tasks_v23
                        (id, run_id, task_kind, status, input_json, output_json, priority,
                         attempt_count, lease_owner, lease_expires_at, heartbeat_at, error_message,
                         created_at, started_at, completed_at, version)
                     SELECT id, run_id, task_kind, status, input_json, output_json, priority,
                            attempt_count, lease_owner, lease_expires_at, heartbeat_at, error_message,
                            created_at, started_at, completed_at, version
                       FROM narrative_extraction_tasks;
                     DROP TABLE narrative_extraction_tasks;
                     ALTER TABLE narrative_extraction_tasks_v23 RENAME TO narrative_extraction_tasks;

                     DROP TABLE IF EXISTS narrative_extraction_attempts_v23;
                     CREATE TABLE narrative_extraction_attempts_v23 (
                        id TEXT PRIMARY KEY,
                        task_id TEXT NOT NULL,
                        attempt_number INTEGER NOT NULL,
                        status TEXT NOT NULL
                            CHECK(status IN ('running','completed','failed')),
                        started_at TEXT NOT NULL,
                        completed_at TEXT,
                        error_message TEXT,
                        output_json TEXT,
                        failure_code TEXT
                            CHECK(failure_code IS NULL OR failure_code GLOB 'NEX_*'),
                        retry_disposition TEXT
                            CHECK(retry_disposition IS NULL OR retry_disposition IN ('retryable','terminal','superseded','manual')),
                        policy_version TEXT,
                        next_attempt_at TEXT,
                        CHECK((next_attempt_at IS NULL) OR (retry_disposition IS NOT NULL AND retry_disposition = 'retryable'))
                     );
                     INSERT INTO narrative_extraction_attempts_v23
                        (id, task_id, attempt_number, status, started_at, completed_at,
                         error_message, output_json, failure_code, retry_disposition,
                         policy_version, next_attempt_at)
                     SELECT id, task_id, attempt_number, status, started_at, completed_at,
                            error_message, output_json,
                            CASE WHEN status = 'failed' THEN 'NEX_LEGACY_UNCLASSIFIED' ELSE NULL END,
                            CASE WHEN status = 'failed' THEN 'terminal' ELSE NULL END,
                            CASE WHEN status = 'failed' THEN 'legacy' ELSE NULL END,
                            NULL
                       FROM narrative_extraction_attempts;
                     DROP TABLE narrative_extraction_attempts;
                     ALTER TABLE narrative_extraction_attempts_v23 RENAME TO narrative_extraction_attempts;",
                )?;
                Ok(())
            })();
            match rebuild_result {
                Ok(()) => grimodex_core::commit_or_rollback(conn),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })();
        let restore_foreign_keys = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled);
        if let Err(error) = migration_result {
            restore_foreign_keys?;
            return Err(error);
        }
        restore_foreign_keys?;

        let run_count_after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs",
            [],
            |row| row.get(0),
        )?;
        let task_count_after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_tasks",
            [],
            |row| row.get(0),
        )?;
        let attempt_count_after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_attempts",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            run_count_after == run_count_before
                && task_count_after == task_count_before
                && attempt_count_after == attempt_count_before,
            "SCHEMA 23 execution-state migration changed row counts (runs {run_count_before}->{run_count_after}, \
             tasks {task_count_before}->{task_count_after}, attempts {attempt_count_before}->{attempt_count_after})"
        );
        let foreign_key_errors: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM pragma_foreign_key_check
              WHERE \"table\" IN ('narrative_extraction_runs','narrative_extraction_tasks','narrative_extraction_attempts')",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            foreign_key_errors == 0,
            "SCHEMA 23 execution-state migration left foreign key violations"
        );
        Ok(())
    }

    /// SCHEMA_VERSION 23: the Change Feed consumer cursor gains reservation
    /// columns so the Freshness evaluator Run can reserve an unacknowledged
    /// range instead of only acknowledging a completed one. Pre-C2 consumers
    /// keep using only `acknowledged_through_sequence`/lease; the new
    /// columns stay NULL for them.
    fn migrate_narrative_change_cursors_v23(conn: &Connection) -> anyhow::Result<()> {
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_change_cursors'
             )",
            [],
            |row| row.get(0),
        )?;
        if !table_exists {
            return Ok(());
        }
        let table_sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'narrative_change_cursors'",
            [],
            |row| row.get(0),
        )?;
        let compact_table_sql = Self::compact(&table_sql);
        let schema_ready = compact_table_sql.contains(
            "check((active_run_idisnullandreserved_through_sequenceisnull)or(active_run_idisnotnullandreserved_through_sequenceisnotnullandsemantic_epoch_idisnotnull))",
        );
        if schema_ready {
            return Ok(());
        }

        anyhow::ensure!(
            conn.is_autocommit(),
            "SCHEMA 23 cursor reservation migration requires autocommit"
        );
        let row_count_before: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_change_cursors", [], |row| {
                row.get(0)
            })?;

        let foreign_keys_enabled: bool =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        conn.pragma_update(None, "foreign_keys", false)?;
        let migration_result = (|| -> anyhow::Result<()> {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let rebuild_result = (|| -> anyhow::Result<()> {
                conn.execute_batch(
                    "DROP TABLE IF EXISTS narrative_change_cursors_v23;
                     CREATE TABLE narrative_change_cursors_v23 (
                        project_id                    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        consumer_id                   TEXT NOT NULL CHECK(length(consumer_id) > 0),
                        acknowledged_through_sequence INTEGER NOT NULL DEFAULT 0
                            CHECK(acknowledged_through_sequence >= 0),
                        lease_owner                   TEXT,
                        lease_expires_at              TEXT,
                        last_error                    TEXT,
                        updated_at                    TEXT NOT NULL,
                        semantic_epoch_id             TEXT REFERENCES narrative_semantic_epochs(id),
                        reserved_through_sequence     INTEGER,
                        active_run_id                 TEXT REFERENCES narrative_extraction_runs(id),
                        PRIMARY KEY(project_id, consumer_id),
                        CHECK(
                            (active_run_id IS NULL AND reserved_through_sequence IS NULL)
                            OR (active_run_id IS NOT NULL AND reserved_through_sequence IS NOT NULL
                                AND semantic_epoch_id IS NOT NULL)
                        ),
                        CHECK(
                            reserved_through_sequence IS NULL
                            OR reserved_through_sequence >= acknowledged_through_sequence
                        )
                     );
                     INSERT INTO narrative_change_cursors_v23
                        (project_id, consumer_id, acknowledged_through_sequence, lease_owner,
                         lease_expires_at, last_error, updated_at)
                     SELECT project_id, consumer_id, acknowledged_through_sequence, lease_owner,
                            lease_expires_at, last_error, updated_at
                       FROM narrative_change_cursors;
                     DROP TABLE narrative_change_cursors;
                     ALTER TABLE narrative_change_cursors_v23 RENAME TO narrative_change_cursors;
                     CREATE INDEX IF NOT EXISTS idx_narrative_change_cursors_project
                        ON narrative_change_cursors(project_id, consumer_id);",
                )?;
                Ok(())
            })();
            match rebuild_result {
                Ok(()) => grimodex_core::commit_or_rollback(conn),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })();
        let restore_foreign_keys = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled);
        if let Err(error) = migration_result {
            restore_foreign_keys?;
            return Err(error);
        }
        restore_foreign_keys?;

        let row_count_after: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_change_cursors", [], |row| {
                row.get(0)
            })?;
        anyhow::ensure!(
            row_count_after == row_count_before,
            "SCHEMA 23 cursor reservation migration changed row count"
        );
        let foreign_key_errors: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM pragma_foreign_key_check
              WHERE \"table\" = 'narrative_change_cursors'",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            foreign_key_errors == 0,
            "SCHEMA 23 cursor reservation migration left foreign key violations"
        );
        Ok(())
    }

    /// SCHEMA_VERSION 24 (`policies/narrative/narrative-run-kind-policy.json`):
    /// `narrative_extraction_runs.run_kind` gains `'dependency-verify'` and
    /// `'dependency-repair'`. `dependency-backfill`/`dependency-rebuild-derived`
    /// reuse the existing `'backfill'`/`'semantic-index-rebuild'` values and
    /// need no CHECK change. SQLite cannot `ALTER TABLE ADD` a wider
    /// multi-value `CHECK` to a populated table, so this rebuilds
    /// `narrative_extraction_runs` alone (Task/Attempt are untouched — their
    /// status vocabularies do not change at SCHEMA 24) using the same
    /// rebuild-and-verify pattern `migrate_narrative_extraction_status_v23`
    /// established.
    fn migrate_run_kind_v24(conn: &Connection) -> anyhow::Result<()> {
        let runs_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_extraction_runs'
             )",
            [],
            |row| row.get(0),
        )?;
        if !runs_exists {
            return Ok(());
        }
        let runs_sql = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'narrative_extraction_runs'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        let compact_runs_sql = Self::compact(&runs_sql);
        let schema_ready = compact_runs_sql.contains(
            "check(run_kindin('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill','dependency-verify','dependency-repair'))",
        );
        if schema_ready {
            return Ok(());
        }

        // Fail closed on any run_kind value the new CHECK does not allow,
        // rather than silently coercing it — a workspace that already has a
        // run_kind this migration does not recognize means an assumption
        // about the closed vocabulary was wrong, not something to paper
        // over.
        let invalid_run_kinds: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT run_kind FROM narrative_extraction_runs
                  WHERE run_kind NOT IN (
                    'interpretation','freshness-evaluation','semantic-index-rebuild',
                    'manual-rebuild','backfill','dependency-verify','dependency-repair'
                  )",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        anyhow::ensure!(
            invalid_run_kinds.is_empty(),
            "SCHEMA 24 run_kind migration found narrative_extraction_runs rows with an \
             unrecognized run_kind: {invalid_run_kinds:?}"
        );

        anyhow::ensure!(
            conn.is_autocommit(),
            "SCHEMA 24 run_kind migration requires autocommit"
        );
        let row_count_before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs",
            [],
            |row| row.get(0),
        )?;

        let foreign_keys_enabled: bool =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        conn.pragma_update(None, "foreign_keys", false)?;
        let migration_result = (|| -> anyhow::Result<()> {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let rebuild_result = (|| -> anyhow::Result<()> {
                conn.execute_batch(
                    "DROP TABLE IF EXISTS narrative_extraction_runs_v24;
                     CREATE TABLE narrative_extraction_runs_v24 (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        surface_path_id TEXT NOT NULL,
                        scope_json TEXT NOT NULL,
                        spec_json TEXT NOT NULL,
                        spec_digest TEXT NOT NULL,
                        snapshot_digest TEXT,
                        catalog_digest TEXT,
                        registry_digest TEXT,
                        status TEXT NOT NULL
                            CHECK(status IN ('pending','running','completed','failed','cancelled','superseded')),
                        coverage_json TEXT NOT NULL DEFAULT '{}',
                        outcome_summary_json TEXT,
                        created_at TEXT NOT NULL,
                        started_at TEXT,
                        completed_at TEXT,
                        version INTEGER NOT NULL DEFAULT 0,
                        run_kind TEXT NOT NULL DEFAULT 'interpretation'
                            CHECK(run_kind IN (
                                'interpretation','freshness-evaluation','semantic-index-rebuild',
                                'manual-rebuild','backfill','dependency-verify','dependency-repair'
                            )),
                        consumer_id TEXT,
                        semantic_epoch_id TEXT REFERENCES narrative_semantic_epochs(id),
                        work_key TEXT,
                        terminal_reason_code TEXT
                            CHECK(terminal_reason_code IS NULL OR terminal_reason_code GLOB 'NEX_*'),
                        superseded_by_run_id TEXT REFERENCES narrative_extraction_runs(id)
                     );
                     INSERT INTO narrative_extraction_runs_v24
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                         outcome_summary_json, created_at, started_at, completed_at, version,
                         run_kind, consumer_id, semantic_epoch_id, work_key, terminal_reason_code,
                         superseded_by_run_id)
                     SELECT id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                            snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                            outcome_summary_json, created_at, started_at, completed_at, version,
                            run_kind, consumer_id, semantic_epoch_id, work_key, terminal_reason_code,
                            superseded_by_run_id
                       FROM narrative_extraction_runs;
                     DROP TABLE narrative_extraction_runs;
                     ALTER TABLE narrative_extraction_runs_v24 RENAME TO narrative_extraction_runs;",
                )?;
                Ok(())
            })();
            match rebuild_result {
                Ok(()) => grimodex_core::commit_or_rollback(conn),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })();
        let restore_foreign_keys = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled);
        if let Err(error) = migration_result {
            restore_foreign_keys?;
            return Err(error);
        }
        restore_foreign_keys?;

        let row_count_after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            row_count_after == row_count_before,
            "SCHEMA 24 run_kind migration changed row count ({row_count_before} -> {row_count_after})"
        );
        let foreign_key_errors: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM pragma_foreign_key_check
              WHERE \"table\" = 'narrative_extraction_runs'",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            foreign_key_errors == 0,
            "SCHEMA 24 run_kind migration left foreign key violations"
        );
        Ok(())
    }

    /// SCHEMA 25: give `narrative_maintenance_attention` the controls its
    /// ADR 006 route requires — `version` (OCC), `request_id` +
    /// `payload_digest` (the provenance of the write that last touched the
    /// row), a mandatory `actor_id`, and an optional `reason`.
    ///
    /// Replay itself is resolved from the shared `idempotency_requests`
    /// ledger, not from these columns: `clear` deletes the row, so a row
    /// that is gone cannot answer "have I already applied this requestId?".
    /// See `attention.rs`'s `clear_attention_in_tx`.
    ///
    /// `actor_id` replaces the nullable `set_by`: an Attention row is durable
    /// user state, so "who decided this" is not optional. Pre-existing rows
    /// inherit `set_by` where it was set and the explicit sentinel
    /// `'unknown-legacy-actor'` where it was NULL, rather than being dropped
    /// or silently attributed to whoever migrates.
    ///
    /// Rebuild rather than ALTER TABLE ADD: `actor_id`/`request_id`/
    /// `payload_digest` are NOT NULL with a non-empty CHECK, which SQLite
    /// cannot add to a populated table in place.
    fn migrate_narrative_maintenance_attention_v25(conn: &Connection) -> anyhow::Result<()> {
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_maintenance_attention'
             )",
            [],
            |row| row.get(0),
        )?;
        if !table_exists {
            return Ok(());
        }
        let table_sql = conn.query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'table' AND name = 'narrative_maintenance_attention'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        if Self::compact(&table_sql).contains("actor_idtextnotnull") {
            return Ok(());
        }

        anyhow::ensure!(
            conn.is_autocommit(),
            "SCHEMA 25 attention migration requires autocommit"
        );
        let row_count_before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_attention",
            [],
            |row| row.get(0),
        )?;

        let foreign_keys_enabled: bool =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        conn.pragma_update(None, "foreign_keys", false)?;
        let migration_result = (|| -> anyhow::Result<()> {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let rebuild_result = (|| -> anyhow::Result<()> {
                conn.execute_batch(
                    "DROP TABLE IF EXISTS narrative_maintenance_attention_v25;
                     CREATE TABLE narrative_maintenance_attention_v25 (
                        project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        finding_key            TEXT NOT NULL CHECK(length(finding_key) > 0),
                        disposition            TEXT NOT NULL CHECK(disposition IN ('snoozed','dismissed','flagged')),
                        material_basis_digest  TEXT NOT NULL CHECK(length(material_basis_digest) > 0),
                        snoozed_until          TEXT,
                        set_at                 TEXT NOT NULL,
                        actor_id               TEXT NOT NULL CHECK(length(actor_id) > 0),
                        request_id             TEXT NOT NULL CHECK(length(request_id) > 0),
                        payload_digest         TEXT NOT NULL CHECK(length(payload_digest) > 0),
                        reason                 TEXT,
                        version                INTEGER NOT NULL CHECK(version > 0),
                        PRIMARY KEY(project_id, finding_key)
                     );
                     INSERT INTO narrative_maintenance_attention_v25
                        (project_id, finding_key, disposition, material_basis_digest,
                         snoozed_until, set_at, actor_id, request_id, payload_digest,
                         reason, version)
                     SELECT project_id, finding_key, disposition, material_basis_digest,
                            snoozed_until, set_at,
                            COALESCE(NULLIF(TRIM(COALESCE(set_by, '')), ''), 'unknown-legacy-actor'),
                            'legacy-migration-v25',
                            'legacy-migration-v25',
                            NULL,
                            1
                       FROM narrative_maintenance_attention;
                     DROP TABLE narrative_maintenance_attention;
                     ALTER TABLE narrative_maintenance_attention_v25
                        RENAME TO narrative_maintenance_attention;",
                )?;
                Ok(())
            })();
            match rebuild_result {
                Ok(()) => grimodex_core::commit_or_rollback(conn),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })();
        let restore_foreign_keys = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled);
        if let Err(error) = migration_result {
            restore_foreign_keys?;
            return Err(error);
        }
        restore_foreign_keys?;

        let row_count_after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_attention",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            row_count_after == row_count_before,
            "SCHEMA 25 attention migration changed row count ({row_count_before} -> {row_count_after})"
        );
        let foreign_key_errors: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM pragma_foreign_key_check
              WHERE \"table\" = 'narrative_maintenance_attention'",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            foreign_key_errors == 0,
            "SCHEMA 25 attention migration left foreign key violations"
        );
        Ok(())
    }

    /// SCHEMA 26: request identity on a system Run, kept distinct from
    /// `work_key`.
    ///
    /// `work_key` answers "is this the same work?" and drives
    /// `sameWorkKeyReuse`. These answer "is this the same *request*?" and
    /// drive `sameRequestIdReuse: idempotent-replay`. Collapsing them makes a
    /// retried request indistinguishable from a second deliberate one, which
    /// for `dependency-repair` means a destructive operation could run twice.
    ///
    /// Plain ADD COLUMN: all four are nullable, so no rebuild is needed and
    /// existing Runs simply carry NULL.
    fn migrate_narrative_run_request_identity_v26(conn: &Connection) -> anyhow::Result<()> {
        if !conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_extraction_runs'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }
        for (column, declaration) in [
            ("request_id", "TEXT"),
            ("idempotency_domain", "TEXT"),
            ("request_payload_digest", "TEXT"),
            ("actor_id", "TEXT"),
        ] {
            Self::add_column_if_missing(conn, "narrative_extraction_runs", column, declaration)?;
        }
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_narrative_runs_request_identity
                ON narrative_extraction_runs(project_id, idempotency_domain, request_id)
             WHERE request_id IS NOT NULL AND idempotency_domain IS NOT NULL;",
        )?;
        Ok(())
    }

    /// SCHEMA 27: bind a Repair lease to the Run that holds it.
    ///
    /// The lease already records owner, Verify Run, plan digest and Epoch,
    /// which is enough to say *what* was approved but not *which execution*
    /// is currently entitled to apply it. `repair.rs` compare-and-swaps the
    /// whole row — this column included — at the top of the transaction that
    /// deletes Edges, and releases it under the same predicate, so a worker
    /// whose lease expired and was re-claimed by someone else cannot mutate
    /// the graph or delete the new holder's lease.
    ///
    /// Plain ADD COLUMN: nullable, so a lease claimed before this migration
    /// simply carries NULL and fails the CAS, which is the safe direction.
    /// Every Source identity prefix as of SCHEMA 28, longest first so
    /// `project:codex-catalog:` is tested before anything shorter could
    /// shadow it.
    ///
    /// Frozen here rather than read from `dependency_edges.rs` for the same
    /// reason the Contribution prefix table below is: a migration has to keep
    /// describing the same transition after the live rule changes. A test
    /// asserts this list still agrees with
    /// `canonical_source_object_identity`, so the two can only diverge
    /// deliberately.
    const SOURCE_IDENTITY_PREFIXES_V28: &'static [&'static str] = &[
        "project:codex-catalog:",
        "project:scene:",
        "projection:",
        "snapshot:",
        "artifact:",
        "capture:",
        "evidence:",
    ];

    /// The Dependency Edge Consumer kind whose `consumer_key` is a Run id,
    /// frozen as of SCHEMA 28. Mirrors `dependency_edges.rs`'s
    /// `RUN_CONSUMER_KIND`; frozen for the same reason the prefix tables are,
    /// and pinned to it by a test.
    const RUN_CONSUMER_KIND_V28: &'static str = "narrative-extraction-run";

    /// Legacy `kind:` prefix -> canonical `kind:` prefix, frozen as of
    /// SCHEMA 28. Kinds already canonical in both old vocabularies
    /// (`scene:`, `foreshadow:`, `codex-entry:`, ...) are absent on purpose:
    /// leaving them out is what makes this re-runnable, since a canonical
    /// prefix is never itself a key. Every entry ends in `:`, and no entry is
    /// a prefix of another, so a row matches at most one.
    ///
    /// An associated const rather than a local one so the schema checkpoint's
    /// copy of the left column can be pinned against it.
    const LEGACY_TARGET_IDENTITY_PREFIXES_V28: &'static [(&'static str, &'static str)] = &[
        // Writer-row vocabulary (`applied_entity_kind`), via Backfill.
        ("codex_entry:", "codex-entry:"),
        ("codex_relation:", "codex-relation:"),
        ("codex_phase:", "codex-phase:"),
        ("codex_entry_phase:", "codex-phase:"),
        ("codex_detail_definition:", "codex-detail-definition:"),
        ("codex_detail_value:", "codex-detail-value:"),
        (
            "codex_semantic_binding:",
            "component:codex_semantic_binding:",
        ),
        ("plot_thread:", "plot-thread:"),
        ("plot_thread_marker:", "plot-marker:"),
        ("plot_thread_branch:", "plot-branch:"),
        ("foreshadow_setup:", "foreshadow-setup:"),
        ("foreshadow_payoff:", "foreshadow-payoff:"),
        ("temporal_node:", "temporal-node:"),
        ("temporal_constraint:", "temporal-constraint:"),
        ("temporal_projection:", "temporal-projection:"),
        // Temporal annotation rows address the object they annotate.
        ("temporal_event_chronicle:", "chronicle-event:"),
        ("temporal_scene_chronicle:", "scene:"),
        ("temporal_scene_story_order:", "scene:"),
        // Written by *both* old vocabularies, canonical in neither.
        ("event:", "chronicle-event:"),
        // Field Authority vocabulary, via Apply. The only other FA kind that
        // was not already canonical.
        (
            "codex-detail-semantic-binding:",
            "component:codex_semantic_binding:",
        ),
    ];

    /// Collapses a run of repeats of one Source prefix down to a single one,
    /// which is the exact shape the pre-#535 Backfill produced by re-deriving
    /// an already-qualified key: `project:scene:project:scene:s1`. Returns
    /// `None` when the identity is already well-formed.
    fn collapse_doubled_source_prefix(identity: &str) -> Option<String> {
        let prefix = Self::SOURCE_IDENTITY_PREFIXES_V28
            .iter()
            .find(|prefix| identity.starts_with(**prefix))?;
        let mut rest = &identity[prefix.len()..];
        let mut collapsed = false;
        while let Some(next) = rest.strip_prefix(*prefix) {
            rest = next;
            collapsed = true;
        }
        if !collapsed || rest.is_empty() {
            return None;
        }
        Some(format!("{prefix}{rest}"))
    }

    /// SCHEMA 28: repair `narrative_dependency_edges.source_object_identity`
    /// rows the pre-#535 Legacy Backfill wrote double-prefixed.
    ///
    /// `record_legacy_dependency_edges_in_tx` used to re-derive the identity
    /// from a `source_key` that was already fully qualified, producing
    /// `project:scene:project:scene:s1`. `restore_rebuild.rs`'s
    /// `infer_source_kind` matches on the leading prefix and then hands the
    /// remainder to a resolver that strips its own prefix again, so every one
    /// of those Edges resolves to nothing and evaluates as `source-missing`.
    ///
    /// Fixing the writer does not fix them, and neither does re-running the
    /// Backfill: `find_reusable_system_run` matches on
    /// `(project_id, run_kind, work_key, status)` only -- it never compares
    /// the sealed spec -- so a Run left `completed` under
    /// `LEGACY_BACKFILL_ALGORITHM_VERSION = "1"` is reused and the v2
    /// transform never executes.
    ///
    /// `narrative_dependency_edges` is `UNIQUE(project_id, consumer_kind,
    /// consumer_key, source_object_identity)`, so collapsing an identity can
    /// collide with a correct Edge the same Consumer already declared. The
    /// malformed row loses in that case: both rows describe the same Source
    /// read, and only the canonical one was ever resolvable, so it carries
    /// nothing the survivor lacks. Its Edge State row is deleted explicitly
    /// rather than left to the FK's `ON DELETE CASCADE`, which does nothing
    /// unless `PRAGMA foreign_keys` happens to be on.
    /// The C2 identity data migration's id in `schema_data_migrations`.
    pub(crate) const C2_IDENTITY_MIGRATION_ID: &'static str = "narrative-c2-identity-v28";

    /// Which revision of that migration's side effects a workspace has seen.
    ///
    /// Bump this whenever the migration gains a side effect, even within one
    /// `SCHEMA_VERSION`. That is the whole point: revision 1 rewrote
    /// identities but left Freshness decided on the old ones in place on the
    /// non-collision path, and no amount of looking at today's rows can tell
    /// a workspace that stopped there from one that never needed the repair.
    pub(crate) const C2_IDENTITY_CONTRACT_VERSION: i64 = 2;

    /// Closes out the SCHEMA 28 identity repair: discard the C2 derived state
    /// wholesale, correct Contributions left pointing at an unresolvable
    /// target, and record that this contract revision has been applied.
    ///
    /// **Why a durable marker rather than inspecting the rows.** The earlier
    /// check asked "are any repairable identities left?", which conflates two
    /// different workspaces: one the migration never touched, and one an
    /// earlier SCHEMA 28 build already rewrote. Those are indistinguishable
    /// from the current rows, because the distinguishing evidence -- what
    /// *else* that build did -- was never written down. A workspace migrated
    /// by revision 1 has canonical Edge identities *and* Consumer Freshness
    /// that was decided against the identities they replaced, and the identity
    /// probe calls it healthy.
    ///
    /// **Why the discard is unconditional rather than targeted.** Revision 1's
    /// invalidation only covered Consumers whose identity that same pass
    /// changed. Re-running it now finds nothing to change, so a targeted pass
    /// would clear nothing. There is no record of which Consumers the earlier
    /// pass touched, so the conservative reading is the only sound one: put
    /// every C2 derived state back to absent, which is exactly the "not yet
    /// evaluated" state Rebuild-Derived exists to fill. C2 is still shadow
    /// infrastructure with no production reader, so the cost is recomputation,
    /// while the alternative is serving a stale `source-missing` as truth.
    ///
    /// `narrative_consumer_freshness` is the durable Freshness authority, not
    /// a cache, which is precisely why it cannot be left to sort itself out.
    fn finish_narrative_c2_identity_data_migration_v28(conn: &Connection) -> anyhow::Result<()> {
        if Self::has_c2_identity_data_migration_marker(conn)? {
            return Ok(());
        }

        // Rebuildable derived state. Absent *is* the initial state, so
        // deleting is a reset, not data loss.
        for table in [
            "narrative_dependency_edge_states",
            "narrative_consumer_freshness",
            "narrative_maintenance_finding_observations",
        ] {
            if Self::table_exists_for_v28(conn, table)? {
                conn.execute(&format!("DELETE FROM {table}"), [])
                    .with_context(|| format!("clearing C2 derived state in '{table}'"))?;
            }
        }

        // An earlier revision marked these `unresolved:` but left the state
        // the Apply had written. `unchanged` asserts the field still matches
        // what was applied to an object that cannot be found, which is a
        // claim this migration is in a position to withdraw.
        if Self::table_exists_for_v28(conn, "narrative_application_contributions")? {
            conn.execute(
                "UPDATE narrative_application_contributions
                    SET target_state = 'missing'
                  WHERE substr(target_object_identity, 1, ?1) = ?2
                    AND target_state <> 'missing'",
                params![
                    Self::UNRESOLVED_TARGET_PREFIX_V28.len() as i64,
                    Self::UNRESOLVED_TARGET_PREFIX_V28
                ],
            )
            .context("correcting unresolved Contribution target states")?;
        }

        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(migration_id)
             DO UPDATE SET contract_version = excluded.contract_version,
                 applied_at = excluded.applied_at",
            params![
                Self::C2_IDENTITY_MIGRATION_ID,
                Self::C2_IDENTITY_CONTRACT_VERSION,
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
            ],
        )
        .context("recording the C2 identity data migration marker")?;
        Ok(())
    }

    /// Whether this workspace has seen the current revision of the C2
    /// identity data migration's side effects.
    pub(crate) fn has_c2_identity_data_migration_marker(conn: &Connection) -> anyhow::Result<bool> {
        if !Self::table_exists_for_v28(conn, "schema_data_migrations")? {
            return Ok(false);
        }
        let applied: Option<i64> = conn
            .query_row(
                "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
                params![Self::C2_IDENTITY_MIGRATION_ID],
                |row| row.get(0),
            )
            .optional()?;
        Ok(applied.is_some_and(|version| version >= Self::C2_IDENTITY_CONTRACT_VERSION))
    }

    /// The `unresolved:` prefix as of SCHEMA 28, frozen for the same reason
    /// the identity prefix tables are. A test pins it to the live constant.
    const UNRESOLVED_TARGET_PREFIX_V28: &'static str = "unresolved:";

    fn table_exists_for_v28(conn: &Connection, table: &str) -> anyhow::Result<bool> {
        Ok(conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
             )",
            params![table],
            |row| row.get::<_, bool>(0),
        )?)
    }

    fn migrate_narrative_dependency_edge_identity_v28(conn: &Connection) -> anyhow::Result<()> {
        if !conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_dependency_edges'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }

        let rows: Vec<(String, String, String, String, String)> = conn
            .prepare(
                "SELECT id, project_id, consumer_kind, consumer_key, source_object_identity
                   FROM narrative_dependency_edges
                  ORDER BY id ASC",
            )?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut affected_consumers: std::collections::BTreeSet<(String, String, String)> =
            std::collections::BTreeSet::new();

        for (id, project_id, consumer_kind, consumer_key, identity) in rows {
            let repaired = match Self::collapse_doubled_source_prefix(&identity) {
                Some(repaired) => repaired,
                None => match Self::canonicalize_bare_projection_identity(
                    conn,
                    &project_id,
                    &consumer_kind,
                    &consumer_key,
                    &identity,
                )? {
                    Some(repaired) => repaired,
                    None => continue,
                },
            };
            let canonical_exists: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM narrative_dependency_edges
                     WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3
                       AND source_object_identity = ?4 AND id <> ?5
                 )",
                params![project_id, consumer_kind, consumer_key, repaired, id],
                |row| row.get(0),
            )?;
            affected_consumers.insert((
                project_id.clone(),
                consumer_kind.clone(),
                consumer_key.clone(),
            ));

            if canonical_exists {
                conn.execute(
                    "DELETE FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                    params![id],
                )
                .with_context(|| format!("dropping Edge State for superseded Edge '{id}'"))?;
                conn.execute(
                    "DELETE FROM narrative_dependency_edges WHERE id = ?1",
                    params![id],
                )
                .with_context(|| {
                    format!("dropping malformed Edge '{id}' superseded by '{repaired}'")
                })?;
                continue;
            }

            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET source_object_identity = ?2
                  WHERE id = ?1",
                params![id, repaired],
            )
            .with_context(|| {
                format!("repairing Edge source identity '{identity}' to '{repaired}'")
            })?;
        }

        Self::invalidate_derived_freshness_for_consumers_v28(conn, &affected_consumers)
    }

    /// Recovers the Source kind for an Edge whose identity carries no prefix
    /// at all, so a legitimately-bare `domain-projection` key can be
    /// canonicalized like the writers now do.
    ///
    /// A bare key is not necessarily corruption: `resolve_domain_projection`
    /// falls back to `.unwrap_or(source_key)`, so
    /// `{"sourceKind":"domain-projection","sourceKey":"projection-1"}` was a
    /// valid envelope that the pre-#535 Producer copied verbatim into an
    /// Edge. `infer_source_kind` only recognises `projection:`-prefixed
    /// identities, so those Edges read as an unknown Source forever, and
    /// re-running the Backfill does not help: the Edge upsert key includes
    /// `source_object_identity`, so the canonical row is *added* beside the
    /// bare one rather than replacing it, and worst-edge aggregation then
    /// drags the whole Consumer to `source-missing`.
    ///
    /// The kind is read back from the rows that declared the Source, scoped
    /// to the Edge's own Run: a Proposal Revision's Source Basis for a live
    /// Producer Edge, or a legacy Application's projection dependencies for a
    /// backfilled one. Rewrites only when every declaration agrees the Source
    /// is a projection. No declaration, or a disagreement, leaves the row
    /// untouched -- it stays visibly unresolvable rather than being guessed
    /// into pointing at some other object.
    fn canonicalize_bare_projection_identity(
        conn: &Connection,
        project_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
        identity: &str,
    ) -> anyhow::Result<Option<String>> {
        if Self::SOURCE_IDENTITY_PREFIXES_V28
            .iter()
            .any(|prefix| identity.starts_with(prefix))
        {
            return Ok(None);
        }

        // Both writers key an Edge under `(RUN_CONSUMER_KIND, run_id)`, so
        // the Edge names its own Run and the declaration can be read back
        // from that Run alone. A Consumer of any other kind has no Run to
        // narrow to and falls back to the project.
        let run_id = (consumer_kind == Self::RUN_CONSUMER_KIND_V28).then_some(consumer_key);

        let mut kinds: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (table_probe, sql, run_scoped_sql) in [
            (
                "narrative_revision_source_basis",
                "SELECT DISTINCT b.source_kind
                   FROM narrative_revision_source_basis b
                   JOIN narrative_proposal_revisions r ON r.id = b.revision_id
                   JOIN narrative_proposals p ON p.id = r.proposal_id
                   JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                  WHERE s.project_id = ?1 AND b.source_key = ?2",
                "SELECT DISTINCT b.source_kind
                   FROM narrative_revision_source_basis b
                   JOIN narrative_proposal_revisions r ON r.id = b.revision_id
                   JOIN narrative_proposals p ON p.id = r.proposal_id
                   JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                  WHERE s.project_id = ?1 AND b.source_key = ?2 AND s.run_id = ?3",
            ),
            (
                "narrative_projection_dependencies",
                "SELECT DISTINCT d.source_kind
                   FROM narrative_projection_dependencies d
                   JOIN narrative_proposal_applications a ON a.id = d.application_id
                   JOIN narrative_apply_commits c ON c.id = a.commit_id
                  WHERE c.project_id = ?1 AND d.source_key = ?2",
                "SELECT DISTINCT d.source_kind
                   FROM narrative_projection_dependencies d
                   JOIN narrative_proposal_applications a ON a.id = d.application_id
                   JOIN narrative_apply_commits c ON c.id = a.commit_id
                  WHERE c.project_id = ?1 AND d.source_key = ?2 AND c.run_id = ?3",
            ),
        ] {
            if !conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
                 )",
                params![table_probe],
                |row| row.get::<_, bool>(0),
            )? {
                continue;
            }
            let found = match run_id {
                Some(run_id) => conn
                    .prepare(run_scoped_sql)?
                    .query_map(params![project_id, identity, run_id], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?,
                None => conn
                    .prepare(sql)?
                    .query_map(params![project_id, identity], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?,
            };
            kinds.extend(found);
        }

        let projection_only = !kinds.is_empty()
            && kinds
                .iter()
                .all(|kind| matches!(kind.as_str(), "domain-projection" | "projection"));
        if !projection_only {
            return Ok(None);
        }
        Ok(Some(format!("projection:{identity}")))
    }

    /// Drops the Freshness state that was computed against an Edge identity
    /// this migration has just changed.
    ///
    /// Rewriting the identity is not enough on its own.
    /// `narrative_consumer_freshness` is not a cache -- it is the durable
    /// authority for a Consumer's current Freshness -- and
    /// `narrative_dependency_edge_states` holds the last evaluation of each
    /// Edge. A workspace that ran Rebuild-Derived before this migration has
    /// `source-missing` recorded in both, decided from an identity that no
    /// longer exists, and nothing else would ever revisit it: the Semantic
    /// Epoch does not rotate here. The moment C2-T2 wires the read path,
    /// that stale verdict would be served as the truth.
    ///
    /// Deleting rather than re-evaluating: evaluation needs a Run and an
    /// Epoch, which a migration has no business minting. Absent rows are
    /// already the "not yet evaluated" state the Rebuild-Derived path is
    /// built to fill, so removing them asks for the recompute instead of
    /// faking its answer. Finding Observations keyed on the same Consumer go
    /// too, since `finding_key` is `<consumer_kind>:<consumer_key>` and those
    /// diagnostics describe the same superseded evaluation.
    fn invalidate_derived_freshness_for_consumers_v28(
        conn: &Connection,
        consumers: &std::collections::BTreeSet<(String, String, String)>,
    ) -> anyhow::Result<()> {
        for (project_id, consumer_kind, consumer_key) in consumers {
            conn.execute(
                "DELETE FROM narrative_dependency_edge_states
                  WHERE edge_id IN (
                        SELECT id FROM narrative_dependency_edges
                         WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3
                  )",
                params![project_id, consumer_kind, consumer_key],
            )
            .with_context(|| {
                format!(
                    "clearing Edge States for repaired Consumer '{consumer_kind}:{consumer_key}'"
                )
            })?;

            for (table, sql) in [
                (
                    "narrative_consumer_freshness",
                    "DELETE FROM narrative_consumer_freshness
                      WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
                ),
                (
                    "narrative_maintenance_finding_observations",
                    "DELETE FROM narrative_maintenance_finding_observations
                      WHERE project_id = ?1 AND finding_key = ?2 || ':' || ?3",
                ),
            ] {
                if !conn.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
                     )",
                    params![table],
                    |row| row.get::<_, bool>(0),
                )? {
                    continue;
                }
                conn.execute(sql, params![project_id, consumer_kind, consumer_key])
                    .with_context(|| {
                        format!("clearing {table} for repaired Consumer '{consumer_kind}:{consumer_key}'")
                    })?;
            }
        }
        Ok(())
    }

    /// The Consumer kind `repository.rs` declares Proposal Revision Edges
    /// under. Frozen here for the same reason `RUN_CONSUMER_KIND_V28` is: a
    /// migration must keep meaning what it meant when it ran.
    const PROPOSAL_REVISION_CONSUMER_KIND_V30: &'static str = "proposal-revision";

    /// The only prefix `canonical_source_object_identity` ever *adds* to a
    /// `source_key`. Every other Source kind rejects a bare key outright, so
    /// a stored identity either equals its Source Basis key or is that key
    /// with this in front. The re-key below matches on exactly those two
    /// shapes rather than re-implementing the canonicaliser.
    const DECORATED_SOURCE_PREFIX_V30: &'static str = "projection:";

    /// Gate C2-2: move the Edges the live Producer declared under a Run onto
    /// the Revisions that actually read those Sources.
    ///
    /// Not a re-derivation from nothing. `narrative_revision_source_basis`
    /// already stores, per Revision, the exact `(source_kind, source_key,
    /// revision_token)` list the Producer built each Edge from -- so the
    /// finer attribution is read out of durable data rather than guessed.
    /// That is what the roadmap's "without fabricating cross-run identity"
    /// requires, and it is why the re-key is possible at all: nothing here
    /// has to decide which Proposal of a Run "probably" read a Source.
    ///
    /// One Run Edge can become several Revision Edges. The Run-grained
    /// writer upserted per Source, so two Revisions reading the same Scene
    /// collapsed into one row; both get their own now.
    ///
    /// Edges with no matching Source Basis row are left under the Run. Those
    /// are `legacy_backfill.rs`'s, declared for Applications that have no
    /// Revision to attribute a read to -- a Run is still their legitimate
    /// Consumer, and the contract keeps `narrative-extraction-run` declared
    /// for exactly them.
    ///
    /// Derived state for the touched Consumers is discarded rather than
    /// re-pointed: it was evaluated against a Consumer identity that no
    /// longer exists, and re-evaluating needs a Run and an Epoch that a
    /// migration has no business minting. Absent rows are the "not yet
    /// evaluated" state `dependency-rebuild-derived` exists to fill.
    fn migrate_narrative_consumer_grain_v30(conn: &Connection) -> anyhow::Result<()> {
        if Self::has_c2_consumer_grain_data_migration_marker(conn)? {
            return Ok(());
        }
        if !Self::table_exists_for_v28(conn, "narrative_dependency_edges")?
            || !Self::table_exists_for_v28(conn, "narrative_revision_source_basis")?
        {
            Self::record_c2_consumer_grain_marker_v30(conn)?;
            return Ok(());
        }

        // (edge_id, project_id, identity, owning_run_id, revision_id, token)
        let matches: Vec<(String, String, String, String, String, String)> = conn
            .prepare(
                "SELECT e.id, e.project_id, e.source_object_identity, e.owning_run_id,
                        sb.revision_id, sb.revision_token
                   FROM narrative_dependency_edges e
                   JOIN narrative_proposal_sets ps
                     ON ps.run_id = e.owning_run_id AND ps.project_id = e.project_id
                   JOIN narrative_proposals p ON p.proposal_set_id = ps.id
                   JOIN narrative_proposal_revisions r ON r.proposal_id = p.id
                   JOIN narrative_revision_source_basis sb ON sb.revision_id = r.id
                  WHERE e.consumer_kind = ?1
                    AND e.owning_run_id IS NOT NULL
                    AND (e.source_object_identity = sb.source_key
                         OR e.source_object_identity = ?2 || sb.source_key)
                  ORDER BY e.id ASC, sb.revision_id ASC",
            )?
            .query_map(
                params![
                    Self::RUN_CONSUMER_KIND_V28,
                    Self::DECORATED_SOURCE_PREFIX_V30
                ],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?
            .collect::<Result<_, _>>()?;

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let mut touched_runs: std::collections::BTreeSet<(String, String)> =
            std::collections::BTreeSet::new();
        let mut rekeyed_edge_ids: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();

        for (edge_id, project_id, identity, owning_run_id, revision_id, token) in matches {
            conn.execute(
                "INSERT INTO narrative_dependency_edges (
                     id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, generated_by_transaction_id, created_at, owning_run_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)
                 ON CONFLICT(project_id, consumer_kind, consumer_key, source_object_identity)
                 DO NOTHING",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    project_id,
                    Self::PROPOSAL_REVISION_CONSUMER_KIND_V30,
                    revision_id,
                    identity,
                    serde_json::to_string(&[token])?,
                    now,
                    owning_run_id,
                ],
            )
            .context("re-keying a Dependency Edge onto its Proposal Revision")?;
            touched_runs.insert((project_id, owning_run_id));
            rekeyed_edge_ids.insert(edge_id);
        }

        // A Run Edge may carry *two* declarations at once. Both Producers
        // wrote under `(RUN_CONSUMER_KIND, run_id)` and the writer upserts on
        // `(project_id, consumer_kind, consumer_key, source_object_identity)`,
        // so a Revision and an Application of the same Run reading the same
        // Source collapsed into one row -- with nothing on it saying it came
        // from both. Deleting such a row because it matched a Revision would
        // silently drop the Application's dependency, which is not this
        // migration's to remove: the contract keeps `narrative-extraction-run`
        // declared precisely for Applications that have no Revision to
        // attribute a read to, and re-keying those is C2-Z's work.
        //
        // So the Run Edge is kept whenever the same `(Run, Source)` is also
        // declared in `narrative_projection_dependencies`. The Revision Edges
        // are added either way; the cost of keeping it is a duplicate
        // Consumer, and the cost of not keeping it is a lost dependency.
        let application_declared: std::collections::BTreeSet<String> =
            if Self::table_exists_for_v28(conn, "narrative_projection_dependencies")? {
                conn.prepare(
                    "SELECT e.id
                   FROM narrative_dependency_edges e
                   JOIN narrative_apply_commits c ON c.run_id = e.owning_run_id
                   JOIN narrative_proposal_applications a ON a.commit_id = c.id
                   JOIN narrative_projection_dependencies pd ON pd.application_id = a.id
                  WHERE e.consumer_kind = ?1
                    AND (e.source_object_identity = pd.source_key
                         OR e.source_object_identity = ?2 || pd.source_key)",
                )?
                .query_map(
                    params![
                        Self::RUN_CONSUMER_KIND_V28,
                        Self::DECORATED_SOURCE_PREFIX_V30
                    ],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<_, _>>()?
            } else {
                std::collections::BTreeSet::new()
            };

        for edge_id in &rekeyed_edge_ids {
            if application_declared.contains(edge_id) {
                continue;
            }
            conn.execute(
                "DELETE FROM narrative_dependency_edges WHERE id = ?1",
                params![edge_id],
            )
            .context("removing a Run-grained Edge that was re-keyed")?;
        }

        let consumers: std::collections::BTreeSet<(String, String, String)> = touched_runs
            .into_iter()
            .map(|(project_id, run_id)| {
                (project_id, Self::RUN_CONSUMER_KIND_V28.to_string(), run_id)
            })
            .collect();
        Self::invalidate_derived_freshness_for_consumers_v28(conn, &consumers)?;

        Self::record_c2_consumer_grain_marker_v30(conn)
    }

    fn record_c2_consumer_grain_marker_v30(conn: &Connection) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(migration_id)
             DO UPDATE SET contract_version = excluded.contract_version,
                 applied_at = excluded.applied_at",
            params![
                Self::C2_CONSUMER_GRAIN_MIGRATION_ID,
                Self::C2_CONSUMER_GRAIN_CONTRACT_VERSION,
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
            ],
        )
        .context("recording the C2 Consumer grain data migration marker")?;
        Ok(())
    }

    /// SCHEMA 31: give every Finding a stable, rule-versioned identity and
    /// retain explicit lifecycle records. Existing observations are
    /// backfilled from their durable Edge subject when available; legacy rows
    /// without an Edge retain a NULL identity rather than using finding_key as
    /// a false edge subject.
    /// Neither Run nor Semantic Epoch participates in either digest.
    fn migrate_narrative_finding_identity_v31(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch("SAVEPOINT narrative_c2_schema_31")?;
        let result = (|| -> anyhow::Result<()> {
            if Self::table_exists_for_v28(conn, "narrative_maintenance_finding_observations")? {
                Self::add_column_if_missing(
                    conn,
                    "narrative_maintenance_finding_observations",
                    "finding_identity",
                    "TEXT",
                )?;
                Self::add_column_if_missing(
                    conn,
                    "narrative_maintenance_finding_observations",
                    "rule_id",
                    "TEXT NOT NULL DEFAULT 'narrative.consumer-freshness'",
                )?;
                Self::add_column_if_missing(
                    conn,
                    "narrative_maintenance_finding_observations",
                    "rule_version",
                    "INTEGER NOT NULL DEFAULT 1 CHECK(rule_version > 0)",
                )?;
                Self::add_column_if_missing(
                    conn,
                    "narrative_maintenance_finding_observations",
                    "observation_digest",
                    "TEXT NOT NULL DEFAULT ''",
                )?;
                Self::backfill_narrative_finding_observations_v31(conn)?;
            }

            if Self::table_exists_for_v28(conn, "narrative_maintenance_attention")? {
                Self::add_column_if_missing(
                    conn,
                    "narrative_maintenance_attention",
                    "finding_identity",
                    "TEXT",
                )?;
                Self::add_column_if_missing(
                    conn,
                    "narrative_maintenance_attention",
                    "identity_resolution_status",
                    "TEXT NOT NULL DEFAULT 'resolved' CHECK(identity_resolution_status IN ('resolved','unresolved','legacy-unresolved'))",
                )?;
                // Only exact one-candidate mappings move. Ambiguous and
                // conflicting rows remain at their old key; restore/verify
                // reports them rather than silently choosing a target.
                let unresolved =
                    crate::narrative_extraction::rehome_orphaned_attention_in_tx(conn)?;
                if !unresolved.is_empty() {
                    tracing::warn!(
                        target: "narrative.migrate",
                        count = unresolved.len(),
                        "preserved ambiguous or conflicting orphaned Attention rows"
                    );
                }
                // Existing, non-orphan Attention rows can be converted only
                // when their old digest identifies one observation on the
                // current Edge. Orphan rows were handled above; leaving
                // ambiguous/conflicting rows byte-for-byte intact is the
                // fail-closed migration policy.
                if Self::table_exists_for_v28(conn, "narrative_maintenance_finding_observations")?
                    && Self::table_exists_for_v28(conn, "narrative_dependency_edges")?
                {
                    Self::backfill_narrative_attention_identity_v31(conn)?;
                }
                Self::mark_legacy_unresolved_attention_v31(conn)?;
            }

            if Self::table_exists_for_v28(conn, "narrative_maintenance_finding_observations")? {
                Self::backfill_narrative_finding_observation_material_bases_v31(conn)?;
            }

            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS narrative_maintenance_finding_lifecycle (
                    id                         TEXT NOT NULL,
                    project_id                 TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    finding_identity           TEXT NOT NULL CHECK(length(finding_identity) > 0),
                    finding_key                TEXT NOT NULL CHECK(length(finding_key) > 0),
                    rule_id                    TEXT NOT NULL CHECK(length(rule_id) > 0),
                    rule_version               INTEGER NOT NULL CHECK(rule_version > 0),
                    lifecycle_state            TEXT NOT NULL CHECK(lifecycle_state IN ('new','recurring','changed','resolved')),
                    observation_digest         TEXT,
                    material_basis_digest      TEXT,
                    run_id                     TEXT NOT NULL,
                    semantic_epoch_id         TEXT NOT NULL REFERENCES narrative_semantic_epochs(id),
                    observed_at                TEXT NOT NULL,
                    PRIMARY KEY(id)
                );
                CREATE INDEX IF NOT EXISTS idx_narrative_finding_lifecycle_identity
                    ON narrative_maintenance_finding_lifecycle(project_id, finding_identity, observed_at);
                CREATE INDEX IF NOT EXISTS idx_narrative_finding_lifecycle_key
                    ON narrative_maintenance_finding_lifecycle(project_id, finding_key, observed_at);",
            )?;
            Self::seed_narrative_finding_lifecycle_v31(conn)?;
            Self::record_c2_finding_identity_marker_v31(conn)?;
            Ok(())
        })();
        match result {
            Ok(()) => conn
                .execute_batch("RELEASE narrative_c2_schema_31")
                .map_err(Into::into),
            Err(error) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO narrative_c2_schema_31; RELEASE narrative_c2_schema_31",
                );
                Err(error)
            }
        }
    }

    fn stable_finding_identity_digest_v31(stable_subject: &str) -> anyhow::Result<String> {
        crate::narrative_extraction::stable_finding_identity(
            crate::narrative_extraction::BUNDLED_FINDING_RULE_ID,
            crate::narrative_extraction::BUNDLED_FINDING_RULE_VERSION,
            stable_subject,
        )
    }

    fn observation_digest_v31(
        stable_subject: &str,
        edge_id: Option<&str>,
        reason_code: &str,
        freshness: &str,
    ) -> anyhow::Result<String> {
        crate::narrative_extraction::observation_digest(
            crate::narrative_extraction::BUNDLED_FINDING_RULE_ID,
            crate::narrative_extraction::BUNDLED_FINDING_RULE_VERSION,
            &crate::narrative_extraction::ObservationDigestInput {
                stable_subject,
                edge_id,
                failure_code: None,
                reason_code,
                evidence_freshness: freshness,
                evidence_detail_digest: None,
            },
        )
    }

    fn material_basis_digest_v31(
        stable_subject: &str,
        edge_id: Option<&str>,
        reason_code: &str,
        freshness: &str,
    ) -> anyhow::Result<String> {
        crate::narrative_extraction::material_basis_digest(
            crate::narrative_extraction::BUNDLED_FINDING_RULE_ID,
            crate::narrative_extraction::BUNDLED_FINDING_RULE_VERSION,
            &crate::narrative_extraction::MaterialBasisInput {
                stable_subject,
                edge_id,
                failure_code: None,
                reason_code,
                evidence_freshness: freshness,
                evidence_detail_digest: None,
            },
        )
    }

    fn backfill_narrative_finding_observations_v31(conn: &Connection) -> anyhow::Result<()> {
        let rows: Vec<(String, Option<String>, String, String, String)> = conn
            .prepare(
                "SELECT id, edge_id, finding_key, reason_code,
                        evidence_freshness_snapshot
                   FROM narrative_maintenance_finding_observations
                  WHERE finding_identity IS NULL OR finding_identity = ''",
            )?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        for (id, edge_id, _finding_key, reason_code, freshness) in rows {
            let Some(edge_id) = edge_id.as_deref() else {
                // This is a diagnostic-only legacy row. `finding_key` is a
                // consumer label and is not a valid subject for an
                // edge-scoped identity, so leave finding_identity NULL.
                continue;
            };
            let finding_identity = Self::stable_finding_identity_digest_v31(edge_id)?;
            let observation_digest =
                Self::observation_digest_v31(edge_id, Some(edge_id), &reason_code, &freshness)?;
            conn.execute(
                "UPDATE narrative_maintenance_finding_observations
                    SET finding_identity = ?1, observation_digest = ?2
                  WHERE id = ?3",
                params![finding_identity, observation_digest, id],
            )?;
        }
        // A prerelease row may have had an identity but no digest. Fill only
        // the missing digest, preserving any already-published identity.
        let rows: Vec<(String, Option<String>, String, String, String)> = conn
            .prepare(
                "SELECT id, edge_id, finding_key, reason_code,
                        evidence_freshness_snapshot
                   FROM narrative_maintenance_finding_observations
                  WHERE observation_digest IS NULL OR observation_digest = ''",
            )?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        for (id, edge_id, finding_key, reason_code, freshness) in rows {
            let (stable_subject, edge_ref) = match edge_id.as_deref() {
                Some(edge_id) => (edge_id, Some(edge_id)),
                None => {
                    // Keep a deterministic diagnostic digest for a legacy
                    // row while refusing to claim it has a valid identity.
                    (finding_key.as_str(), None)
                }
            };
            let observation_digest =
                Self::observation_digest_v31(stable_subject, edge_ref, &reason_code, &freshness)?;
            conn.execute(
                "UPDATE narrative_maintenance_finding_observations
                    SET observation_digest = ?1
                  WHERE id = ?2",
                params![observation_digest, id],
            )?;
        }
        Ok(())
    }

    fn backfill_narrative_attention_identity_v31(conn: &Connection) -> anyhow::Result<()> {
        let attention_rows: Vec<(String, String, String)> = conn
            .prepare(
                "SELECT project_id, finding_key, COALESCE(finding_identity, '')
                   FROM narrative_maintenance_attention
                  WHERE EXISTS (
                    SELECT 1 FROM narrative_dependency_edges e
                     WHERE e.project_id = narrative_maintenance_attention.project_id
                       AND e.consumer_kind || ':' || e.consumer_key =
                           narrative_maintenance_attention.finding_key
                  )",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;
        for (project_id, finding_key, _) in attention_rows {
            let candidates: Vec<(String, String, String, String)> = conn
                .prepare(
                    "SELECT DISTINCT o.edge_id,
                            COALESCE(NULLIF(o.finding_identity, ''), ''),
                            o.reason_code, o.evidence_freshness_snapshot
                       FROM narrative_maintenance_attention a
                       JOIN narrative_maintenance_finding_observations o
                         ON o.project_id = a.project_id
                        AND o.finding_key = a.finding_key
                        AND o.material_basis_digest = a.material_basis_digest
                       JOIN narrative_dependency_edges e
                         ON e.project_id = o.project_id
                        AND e.id = o.edge_id
                        AND e.consumer_kind || ':' || e.consumer_key = a.finding_key
                      WHERE a.project_id = ?1 AND a.finding_key = ?2
                        AND o.edge_id IS NOT NULL
                      ORDER BY o.edge_id",
                )?
                .query_map(params![project_id, finding_key], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<_, _>>()?;
            if candidates.len() != 1 {
                continue;
            }
            let (edge_id, observed_identity, reason_code, freshness) = candidates[0].clone();
            let identity = Self::stable_finding_identity_digest_v31(&edge_id)?;
            if !observed_identity.is_empty() && observed_identity != identity {
                continue;
            }
            let material_basis_digest = Self::material_basis_digest_v31(
                &edge_id,
                Some(&edge_id),
                &reason_code,
                &freshness,
            )?;
            conn.execute(
                "UPDATE narrative_maintenance_attention
                    SET finding_identity = ?1, material_basis_digest = ?2
                  WHERE project_id = ?3 AND finding_key = ?4",
                params![identity, material_basis_digest, project_id, finding_key],
            )?;
        }
        Ok(())
    }

    fn backfill_narrative_finding_observation_material_bases_v31(
        conn: &Connection,
    ) -> anyhow::Result<()> {
        let rows: Vec<(String, Option<String>, String, String, String)> = conn
            .prepare(
                "SELECT id, edge_id, finding_key, reason_code,
                        evidence_freshness_snapshot
                   FROM narrative_maintenance_finding_observations
                  ORDER BY id",
            )?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        for (id, edge_id, finding_key, reason_code, freshness) in rows {
            let stable_subject = edge_id.as_deref().unwrap_or(finding_key.as_str());
            let material_basis_digest = Self::material_basis_digest_v31(
                stable_subject,
                edge_id.as_deref(),
                &reason_code,
                &freshness,
            )?;
            conn.execute(
                "UPDATE narrative_maintenance_finding_observations
                    SET material_basis_digest = ?1
                  WHERE id = ?2",
                params![material_basis_digest, id],
            )?;
        }
        Ok(())
    }

    fn mark_legacy_unresolved_attention_v31(conn: &Connection) -> anyhow::Result<()> {
        // A pre-C2-3 Attention with no exact Observation -> Edge proof is a
        // durable diagnostic state, not a silently stale disposition. Keep
        // its key and digest untouched, but make the unresolved reason
        // visible to Verify/read-model consumers.
        conn.execute(
            "UPDATE narrative_maintenance_attention
                SET identity_resolution_status = CASE
                    WHEN finding_identity IS NULL OR finding_identity = ''
                    THEN 'legacy-unresolved'
                    ELSE 'resolved'
                END",
            [],
        )?;
        Ok(())
    }

    fn seed_narrative_finding_lifecycle_v31(conn: &Connection) -> anyhow::Result<()> {
        // The latest durable Observation is the baseline established by the
        // migration itself. Marking it `new` makes the first equivalent live
        // publish explicitly `recurring`, while preserving append-only
        // history and excluding rows whose Edge-scoped identity is unknown.
        conn.execute(
            "INSERT INTO narrative_maintenance_finding_lifecycle
                (id, project_id, finding_identity, finding_key, rule_id, rule_version,
                 lifecycle_state, observation_digest, material_basis_digest, run_id,
                 semantic_epoch_id, observed_at)
             SELECT lower(hex(randomblob(16))), project_id, finding_identity, finding_key,
                    rule_id, rule_version, 'new', observation_digest, material_basis_digest,
                    run_id, semantic_epoch_id, observed_at
               FROM (
                    SELECT o.*,
                           ROW_NUMBER() OVER (
                               PARTITION BY o.project_id, o.finding_identity
                               ORDER BY o.observed_at DESC, o.rowid DESC
                           ) AS rank_in_identity
                      FROM narrative_maintenance_finding_observations o
                     WHERE o.finding_identity IS NOT NULL
                       AND o.finding_identity <> ''
                       AND o.observation_digest IS NOT NULL
                       AND o.observation_digest <> ''
               ) latest
              WHERE rank_in_identity = 1
                AND NOT EXISTS (
                    SELECT 1
                      FROM narrative_maintenance_finding_lifecycle l
                     WHERE l.project_id = latest.project_id
                       AND l.finding_identity = latest.finding_identity
                )",
            [],
        )?;
        Ok(())
    }

    fn record_c2_finding_identity_marker_v31(conn: &Connection) -> anyhow::Result<()> {
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(migration_id)
             DO UPDATE SET contract_version = excluded.contract_version,
                 applied_at = excluded.applied_at",
            params![
                Self::C2_FINDING_IDENTITY_MIGRATION_ID,
                Self::C2_FINDING_IDENTITY_CONTRACT_VERSION,
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
            ],
        )?;
        Ok(())
    }

    pub(crate) const C2_FINDING_IDENTITY_MIGRATION_ID: &'static str =
        "narrative-c2-finding-identity-v31";
    pub(crate) const C2_FINDING_IDENTITY_CONTRACT_VERSION: i64 = 1;

    fn has_c2_consumer_grain_data_migration_marker(conn: &Connection) -> anyhow::Result<bool> {
        if !Self::table_exists_for_v28(conn, "schema_data_migrations")? {
            return Ok(false);
        }
        let applied: Option<i64> = conn
            .query_row(
                "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
                [Self::C2_CONSUMER_GRAIN_MIGRATION_ID],
                |row| row.get(0),
            )
            .optional()?;
        Ok(applied.is_some_and(|version| version >= Self::C2_CONSUMER_GRAIN_CONTRACT_VERSION))
    }

    /// Mirrors `grimodex_core::workspace_schema`'s constants of the same
    /// name; a test pins them.
    const C2_CONSUMER_GRAIN_MIGRATION_ID: &'static str = "narrative-c2-consumer-grain-v30";
    const C2_CONSUMER_GRAIN_CONTRACT_VERSION: i64 = 1;

    /// SCHEMA 30: `narrative_dependency_edges.owning_run_id` -- the Run that
    /// declared this Edge.
    ///
    /// The backfill is exact rather than a guess. Every Edge that exists when
    /// this runs was written by one of two Producers
    /// (`repository.rs`'s `record_run_dependency_edges_in_tx` and
    /// `legacy_backfill.rs`'s `record_legacy_dependency_edges_in_tx`), and
    /// both key the Edge under `(RUN_CONSUMER_KIND, run_id)` -- so for those
    /// rows `consumer_key` *is* the declaring Run's id, and copying it across
    /// restates a fact rather than inventing one. That is also precisely the
    /// equivalence this column exists to stop depending on, which is why the
    /// copy happens once, here, instead of at every read.
    ///
    /// Rows under any other `consumer_kind` keep NULL. None exist today --
    /// `ConsumerKind` has one variant -- but a row written by a newer build
    /// and read by this one must not have a Run id inferred for it from a
    /// `consumer_key` that no longer means that.
    fn migrate_narrative_dependency_edge_owning_run_v30(conn: &Connection) -> anyhow::Result<()> {
        if !Self::table_exists_for_v28(conn, "narrative_dependency_edges")? {
            return Ok(());
        }
        Self::add_column_if_missing(conn, "narrative_dependency_edges", "owning_run_id", "TEXT")?;
        conn.execute(
            "UPDATE narrative_dependency_edges
                SET owning_run_id = consumer_key
              WHERE owning_run_id IS NULL AND consumer_kind = ?1",
            params![Self::RUN_CONSUMER_KIND_V28],
        )
        .context("backfilling narrative_dependency_edges.owning_run_id for SCHEMA 30")?;
        Ok(())
    }

    /// SCHEMA 29: give `narrative_application_contributions` the provenance,
    /// value-baseline and ownership columns Application Contribution
    /// ownership needs (PR #534 out-of-scope item 4).
    ///
    /// The columns, since neither DDL below may carry SQL comments (the
    /// schema-contract generator collapses newlines, so a `--` comment would
    /// swallow the rest of the statement and the browser mock could not
    /// execute the recorded DDL):
    ///
    /// * `commit_id` / `proposal_id` / `revision_id` / `operation_id` --
    ///   which Prepared Commit, Proposal Revision and operation produced this
    ///   field write. `operation_id` is nullable because a pre-Gate-C2
    ///   Application has no `narrative_apply_operations` row to point at.
    /// * `maintenance_ownership` -- the axis ratified as
    ///   `maintenanceOwnershipStates` in
    ///   `policies/narrative/semantic-state-vocabulary.json`, whose JSON
    ///   Schema pins the three values with a `const` and which
    ///   `validate-semantic-core-boundary.mjs` cross-checks, so the CHECK
    ///   must list exactly those.
    /// * `baseline_sequence` -- the canonical `change_events.sequence` this
    ///   Application's own write landed on: the self-stale guard's lower
    ///   bound, so an Application is never marked `modified` by its own
    ///   event.
    /// * `target_state_sequence` / `target_state_updated_at` -- what last
    ///   moved `target_state`, making at-least-once Change Feed delivery
    ///   idempotent here.
    ///
    /// There is deliberately no per-field `committed_value_digest`. An earlier
    /// revision of SCHEMA 29 carried one, on the assumption that
    /// `affected_fields`'s field paths are JSON pointers into the canonical
    /// snapshot. They are not -- they are Field Authority *coordinates*, and
    /// they diverge from the snapshot shape three different ways:
    ///
    /// * nesting -- a `chronicle-event`'s scalars live under `/eventData`,
    ///   so `/title` resolves against nothing;
    /// * casing -- `canonical_plot_thread_snapshot` selects the row verbatim,
    ///   so its key is `sort_order` while the coordinate is `/sortOrder`;
    /// * absence -- a temporal constraint's `/nodes` has no counterpart in
    ///   `collect_constraint_snapshot`'s `json_object` at all.
    ///
    /// Whole families of kinds therefore digested to NULL, and a NULL could
    /// not be told apart from the legitimate "this field has no canonical
    /// representation". (Other kinds did digest cleanly -- a codex entry
    /// create resolved every one of its paths -- which is what let the gap go
    /// unnoticed.)
    ///
    /// It is left out rather than repaired because nothing needs it. A
    /// superseding Application is visible in this table, and a human edit is
    /// visible in the Change Feed's `origin` and `changed_paths` -- at object
    /// grain, since `changed_paths` collapses to `"/"` on create and delete
    /// and the event digests cover the whole snapshot, which is enough for
    /// every consumer that exists today.
    ///
    /// It is also recoverable. `narrative_commit_journals.after_json` keeps
    /// each Application's full entity snapshot, so a nullable
    /// `ALTER TABLE ADD COLUMN` plus a backfill from the journal reintroduces
    /// the column without a rebuild. Two caveats for whoever does that:
    /// `ColumnContract` compares by `ordinal`, so the fresh DDL has to append
    /// the column in the same position `ADD COLUMN` puts it, or
    /// `validate_migrated_schema` rejects the import; and a Redo rewrites
    /// `after_json` in place, so the journal holds the latest replay rather
    /// than the original apply. Reintroducing it also means fixing the
    /// coordinate-to-pointer projection above, which is the actual work.
    ///
    /// A rebuild rather than a stack of `ADD COLUMN`s, because `commit_id`,
    /// `proposal_id` and `revision_id` are NOT NULL with no defensible
    /// default: they have to come from the Application row each Contribution
    /// already points at, which `ADD COLUMN` cannot express.
    ///
    /// **Fails closed on an orphan.** `application_id` has no foreign key, so
    /// a Contribution can outlive its `narrative_proposal_applications` row.
    /// Such a row cannot be given provenance, and dropping it would silently
    /// discard attribution history, so the migration stops instead --
    /// matching how SCHEMA 23 refuses to coerce an unrecognized Attempt
    /// status.
    ///
    /// `operation_id` is deliberately *not* reconstructed: it cannot be
    /// identified rather than guessed, because `narrative_apply_operations`
    /// carries no unique key this table could join on. It stays NULL, which
    /// is the honest answer.
    ///
    /// `baseline_sequence` *is* reconstructed, and the earlier claim that "no
    /// single canonical event corresponds to it" was simply wrong. Every
    /// Apply appends exactly one `narrative.commit.apply` row to
    /// `change_events` carrying its `commit_id`, and `commit.rs` stores that
    /// row's `sequence` as the live path's baseline -- so the join below
    /// reads the same number the live path would have written, on the same
    /// scale the projection compares against (`narrative_change_events.
    /// canonical_sequence` is the source change event's `sequence`).
    ///
    /// It is a grouped derived table rather than the correlated subquery this
    /// first used. `change_events` is the canonical audit log and grows with
    /// every edit a person makes; it carries no index on `entity_id` or
    /// `op_type`, so a correlated lookup rescans the whole project's history
    /// once per Contribution row. On a workspace with a long history that is
    /// minutes of work at open time. The derived table scans it once.
    /// `MIN` is a formality -- a commit has exactly one apply event -- that
    /// keeps the aggregate well defined.
    ///
    /// Writing NULL here was not a missing nicety. The projection admits an
    /// event when `COALESCE(baseline_sequence, -1) < sequence`, so NULL means
    /// "every event ever recorded postdates this Application". On a migrated
    /// workspace the consumer cursor does not exist either, so the first pump
    /// starts at 0 and replays the project's whole history: a human edit made
    /// *before* the Application would be read as evidence the field was
    /// changed *after* it, and the row would report `modified` -- or
    /// `missing`, for a delete -- while holding exactly what the Application
    /// wrote. NULL now survives only where it is true: an Application with no
    /// canonical apply event, which predates the Change Feed entirely, and
    /// for which every Feed event genuinely is later.
    ///
    /// `maintenance_ownership` starts at `maintained` here and is then
    /// re-projected from the Field Authority ledger by
    /// [`Self::reproject_contribution_ownership_v29`], which runs as part of
    /// this migration rather than "its own step, not this one" -- the column
    /// asserts who may keep maintaining a field, and shipping every migrated
    /// row as `maintained` asserts that of fields the author already owns.
    fn migrate_narrative_application_contributions_v29(conn: &Connection) -> anyhow::Result<()> {
        if !conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_application_contributions'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }
        let already_migrated: Vec<String> = conn
            .prepare("PRAGMA table_info(narrative_application_contributions)")?
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<Result<_, _>>()?;
        if already_migrated.iter().any(|name| name == "commit_id") {
            return Ok(());
        }

        let orphans: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_application_contributions c
               LEFT JOIN narrative_proposal_applications a ON a.id = c.application_id
              WHERE a.id IS NULL",
            [],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            orphans == 0,
            "NEX_CONTRIBUTION_ORPHAN: {orphans} Application Contribution row(s) have no \
             narrative_proposal_applications row to take commit/proposal/revision provenance \
             from; SCHEMA 29 will not invent it or drop the attribution"
        );

        conn.execute_batch(
            "CREATE TABLE narrative_application_contributions_v29 (
                id                     TEXT NOT NULL,
                project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                application_id         TEXT NOT NULL CHECK(length(application_id) > 0),
                commit_id              TEXT NOT NULL CHECK(length(commit_id) > 0),
                proposal_id            TEXT NOT NULL CHECK(length(proposal_id) > 0),
                revision_id            TEXT NOT NULL CHECK(length(revision_id) > 0),
                operation_id           TEXT
                    CHECK(operation_id IS NULL OR length(operation_id) > 0),
                target_object_identity TEXT NOT NULL CHECK(length(target_object_identity) > 0),
                field_path             TEXT NOT NULL CHECK(length(field_path) > 0),
                target_state           TEXT NOT NULL
                    CHECK(target_state IN ('unchanged','modified','missing','superseded','undone','not-applicable')),
                maintenance_ownership  TEXT NOT NULL DEFAULT 'maintained'
                    CHECK(maintenance_ownership IN ('maintained','user-owned','detached')),
                baseline_sequence      INTEGER
                    CHECK(baseline_sequence IS NULL OR baseline_sequence > 0),
                target_state_sequence  INTEGER
                    CHECK(target_state_sequence IS NULL OR target_state_sequence > 0),
                target_state_updated_at TEXT,
                created_at             TEXT NOT NULL,
                PRIMARY KEY(id),
                UNIQUE(project_id, application_id, target_object_identity, field_path)
             );
             INSERT INTO narrative_application_contributions_v29 (
                id, project_id, application_id, commit_id, proposal_id, revision_id,
                operation_id, target_object_identity, field_path, target_state,
                maintenance_ownership, baseline_sequence,
                target_state_sequence, target_state_updated_at, created_at
             )
             SELECT c.id, c.project_id, c.application_id,
                    a.commit_id, a.proposal_id, a.revision_id,
                    NULL, c.target_object_identity, c.field_path, c.target_state,
                    'maintained', apply_event.sequence, NULL, NULL, c.created_at
               FROM narrative_application_contributions c
               JOIN narrative_proposal_applications a ON a.id = c.application_id
               LEFT JOIN (
                    SELECT project_id, entity_id, MIN(sequence) AS sequence
                      FROM change_events
                     WHERE op_type = 'narrative.commit.apply'
                     GROUP BY project_id, entity_id
               ) apply_event
                 ON apply_event.project_id = c.project_id
                AND apply_event.entity_id = a.commit_id;
             DROP TABLE narrative_application_contributions;
             ALTER TABLE narrative_application_contributions_v29
                RENAME TO narrative_application_contributions;
             CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_target
                ON narrative_application_contributions(project_id, target_object_identity);
             CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_field
                ON narrative_application_contributions(project_id, target_object_identity, field_path);
             CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_application
                ON narrative_application_contributions(project_id, application_id);
             CREATE INDEX IF NOT EXISTS idx_narrative_application_contributions_commit
                ON narrative_application_contributions(project_id, commit_id);",
        )
        .context("rebuilding narrative_application_contributions for SCHEMA 29")?;
        Self::reproject_contribution_ownership_v29(conn)
            .context("re-projecting Contribution ownership from Field Authority for SCHEMA 29")?;
        Ok(())
    }

    /// Replays the Field Authority ledger onto the freshly rebuilt
    /// Contribution rows, so `maintenance_ownership` starts out agreeing with
    /// the ledger that already decides who holds each field.
    ///
    /// Without this the rebuild ships every pre-existing row as `maintained`
    /// -- "maintenance may keep proposing and applying to this field" -- for
    /// fields a person had already written or explicitly locked. Nothing
    /// self-corrects it: ownership is only ever stamped forward, on the next
    /// human write, so a field the author took and never touched again would
    /// have reported the wrong owner for the life of the workspace.
    ///
    /// Reuses `mark_fields_user_owned_in_tx` rather than restating its UPDATE
    /// as migration SQL. The kind vocabularies differ on the two sides and
    /// the translation between them lives in one function; a second copy here
    /// would be a second thing to keep in step, which is the failure this
    /// branch has already had to fix twice.
    fn reproject_contribution_ownership_v29(conn: &Connection) -> anyhow::Result<()> {
        if !Self::table_exists_for_v28(conn, "narrative_field_authority")? {
            return Ok(());
        }
        crate::narrative_extraction::application_contributions::
            reproject_user_ownership_from_authority_in_tx(conn, None)
    }

    /// Moves one Contribution onto its canonical identity.
    ///
    /// `narrative_application_contributions` is `UNIQUE(project_id,
    /// application_id, target_object_identity, field_path)`. Two rows only
    /// collide here if they already described the same field of the same
    /// object under different spellings, in which case they were always one
    /// record; the rewritten row is dropped rather than duplicated.
    fn rewrite_contribution_identity(
        conn: &Connection,
        id: &str,
        identity: &str,
        rewritten: &str,
    ) -> anyhow::Result<()> {
        let collides: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM narrative_application_contributions AS other
                  JOIN narrative_application_contributions AS row_to_move
                    ON row_to_move.id = ?1
                 WHERE other.id <> row_to_move.id
                   AND other.project_id = row_to_move.project_id
                   AND other.application_id = row_to_move.application_id
                   AND other.field_path = row_to_move.field_path
                   AND other.target_object_identity = ?2
             )",
            params![id, rewritten],
            |row| row.get(0),
        )?;
        if collides {
            conn.execute(
                "DELETE FROM narrative_application_contributions WHERE id = ?1",
                params![id],
            )
            .with_context(|| format!("dropping Contribution '{id}' superseded by '{rewritten}'"))?;
            return Ok(());
        }
        conn.execute(
            "UPDATE narrative_application_contributions
                SET target_object_identity = ?2
              WHERE id = ?1",
            params![id, rewritten],
        )
        .with_context(|| {
            format!("rewriting Contribution target identity '{identity}' to '{rewritten}'")
        })?;
        Ok(())
    }

    /// SCHEMA 28: rewrite `narrative_application_contributions
    /// .target_object_identity` into the ratified Object Addressing
    /// vocabulary.
    ///
    /// Two writers had been filling this column from two different
    /// vocabularies -- `commit.rs` from the Field Authority ledger's
    /// (`event:e1`), `legacy_backfill.rs` from the writer-row one
    /// (`codex_entry:e1`) -- and neither was the one
    /// `policies/narrative/change-feed-writers.json` declares for the
    /// `narrative-extraction.apply` writer. Both now emit the canonical form,
    /// but existing rows still carry the old ones, and re-running the
    /// Backfill will not repair them: its work key reuses
    /// `RunningAndCompleted`, so a project that already ran it is skipped
    /// regardless of `LEGACY_BACKFILL_ALGORITHM_VERSION`.
    ///
    /// Rewrites rather than deletes and re-derives. The Backfill can only
    /// ever restore its own one-row-per-Application sentinel; the per-field
    /// rows a live Apply wrote are not reproducible from anything it reads,
    /// so deleting them would lose real history.
    ///
    /// The prefix table is deliberately duplicated here instead of calling
    /// `application_contributions.rs`. A migration describes one fixed
    /// transition between two schema versions and has to keep meaning that
    /// after the live mapping changes again; binding it to today's function
    /// would silently redefine what SCHEMA 28 did.
    fn migrate_narrative_contribution_target_identity_v28(conn: &Connection) -> anyhow::Result<()> {
        if !conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_application_contributions'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }

        const LEGACY_TARGET_IDENTITY_PREFIXES: &[(&str, &str)] =
            Database::LEGACY_TARGET_IDENTITY_PREFIXES_V28;

        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT id, target_object_identity
                   FROM narrative_application_contributions",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        for (id, identity) in rows {
            // `codex.detail.value.set` is the one operation whose two writers
            // disagree about the *object*, not just its spelling: `commit.rs`
            // records the detail-value row, while `affected_fields` reports
            // the owning Codex Entry plus `/details/<definitionId>`.
            // Hyphenating the kind would leave the two pointing at different
            // objects with different ids, so the row is projected onto its
            // Entry. Every other kind was checked and already agrees.
            let detail_value_id = identity
                .strip_prefix("codex_detail_value:")
                .or_else(|| identity.strip_prefix("codex-detail-value:"));
            if let Some(detail_value_id) = detail_value_id {
                let entry_id: Option<String> = conn
                    .query_row(
                        "SELECT entry_id FROM codex_detail_values WHERE id = ?1",
                        params![detail_value_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                // A deleted detail value cannot be projected. Say so rather
                // than guess: `unresolved:` is not a canonical object key, so
                // nothing joins it, and it is greppable for manual review.
                // Such a row also stops being `unchanged`: its target does not
                // exist, so the field this Application wrote cannot still
                // match what was applied. `missing` is exactly that state.
                let (rewritten, target_state) = match entry_id {
                    Some(entry_id) => (format!("codex-entry:{entry_id}"), None),
                    None => (
                        format!("unresolved:codex-detail-value:{detail_value_id}"),
                        Some("missing"),
                    ),
                };
                if rewritten != identity {
                    Self::rewrite_contribution_identity(conn, &id, &identity, &rewritten)?;
                }
                if let Some(target_state) = target_state {
                    conn.execute(
                        "UPDATE narrative_application_contributions
                            SET target_state = ?2
                          WHERE id = ?1 AND target_state = 'unchanged'",
                        params![id, target_state],
                    )
                    .with_context(|| {
                        format!("marking unresolvable Contribution '{id}' as {target_state}")
                    })?;
                }
                continue;
            }

            let Some(rewritten) =
                LEGACY_TARGET_IDENTITY_PREFIXES
                    .iter()
                    .find_map(|(legacy, canonical)| {
                        identity
                            .strip_prefix(legacy)
                            .map(|rest| format!("{canonical}{rest}"))
                    })
            else {
                continue;
            };
            Self::rewrite_contribution_identity(conn, &id, &identity, &rewritten)?;
        }
        Ok(())
    }

    fn migrate_narrative_repair_lease_run_binding_v27(conn: &Connection) -> anyhow::Result<()> {
        if !conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'narrative_maintenance_repair_leases'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }
        Self::add_column_if_missing(
            conn,
            "narrative_maintenance_repair_leases",
            "active_run_id",
            "TEXT",
        )?;
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
    /// an older process could mutate the schema between the initial read probe
    /// and marker stamp. SQLITE_BUSY/LOCKED leaves both data and the previous
    /// marker untouched. All other failures remain fatal.
    fn try_finalize_previous_schema_without_wait(
        conn: &Connection,
        schema_version: i32,
    ) -> anyhow::Result<ConvergedPreviousFinalize> {
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
                    if !grimodex_core::workspace_schema::is_previous_workspace_schema_write_compatible(conn)? {
                        conn.execute_batch("ROLLBACK")?;
                        return Ok(ConvergedPreviousFinalize::NeedsFullMigration);
                    }
                    Self::recover_interrupted_post_effect_runs(conn)?;
                    conn.pragma_update(None, "user_version", schema_version)?;
                    grimodex_core::commit_or_rollback(conn)?;
                    Ok(ConvergedPreviousFinalize::Finalized)
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
                Ok(ConvergedPreviousFinalize::Busy)
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
        // SCHEMA_VERSION 8: Detail Definition / Detail Value OCC columns.
        // ALTER TABLE cannot use non-constant defaults (datetime('now')), so
        // timestamps use a constant sentinel and are backfilled immediately.
        Self::add_column_if_missing(
            conn,
            "codex_detail_definitions",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            conn,
            "codex_detail_definitions",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Self::add_column_if_missing(
            conn,
            "codex_detail_values",
            "version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::add_column_if_missing(
            conn,
            "codex_detail_values",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Self::add_column_if_missing(
            conn,
            "codex_detail_values",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        conn.execute_batch(
            "UPDATE codex_detail_definitions
                SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, datetime('now'))
              WHERE updated_at = '';
             UPDATE codex_detail_values
                SET created_at = COALESCE(NULLIF(created_at, ''), datetime('now')),
                    updated_at = COALESCE(NULLIF(updated_at, ''), NULLIF(created_at, ''), datetime('now'))
              WHERE created_at = '' OR updated_at = '';",
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
        // Ensure v7 columns exist before rebuild so SELECT can always project them
        // whether the legacy table already had SCHEMA 7 columns or not.
        Self::add_column_if_missing(
            conn,
            "codex_relations",
            "directionality",
            "TEXT NOT NULL DEFAULT 'directed'",
        )?;
        Self::add_column_if_missing(conn, "codex_relations", "inverse_label", "TEXT")?;
        Self::add_column_if_missing(
            conn,
            "codex_relations",
            "semantic_key",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Self::add_column_if_missing(
            conn,
            "codex_relations",
            "version",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        conn.execute_batch(
            "BEGIN;
            CREATE TABLE codex_relations_new (
                id                  TEXT PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                relation_type       TEXT NOT NULL DEFAULT 'custom',
                label               TEXT,
                directionality      TEXT NOT NULL DEFAULT 'directed'
                    CHECK (directionality IN ('directed', 'symmetric')),
                inverse_label       TEXT,
                semantic_key        TEXT NOT NULL DEFAULT '',
                version             INTEGER NOT NULL DEFAULT 1,
                depth_hint          INTEGER,
                source_map_edge_id  TEXT,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL
            );
            INSERT INTO codex_relations_new
                (id, project_id, from_codex_id, to_codex_id, relation_type, label,
                 directionality, inverse_label, semantic_key, version,
                 depth_hint, source_map_edge_id, created_at, updated_at)
            SELECT id, project_id, from_codex_id, to_codex_id, relation_type, label,
                   directionality, inverse_label, semantic_key, version,
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
            CREATE INDEX IF NOT EXISTS idx_codex_relations_semantic_key
                ON codex_relations(semantic_key);
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

    /// SCHEMA_VERSION 7: directionality / inverse_label / semantic_key / version.
    /// Existing rows stay directed; semantic_key is backfilled without deleting
    /// legacy duplicates. Index is non-unique on purpose.
    pub(super) fn migrate_codex_relations_v7(conn: &Connection) -> anyhow::Result<()> {
        let table_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'codex_relations'",
            [],
            |row| row.get(0),
        )?;
        if table_exists == 0 {
            return Ok(());
        }

        Self::add_column_if_missing(
            conn,
            "codex_relations",
            "directionality",
            "TEXT NOT NULL DEFAULT 'directed'",
        )?;
        Self::add_column_if_missing(conn, "codex_relations", "inverse_label", "TEXT")?;
        Self::add_column_if_missing(
            conn,
            "codex_relations",
            "semantic_key",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Self::add_column_if_missing(
            conn,
            "codex_relations",
            "version",
            "INTEGER NOT NULL DEFAULT 1",
        )?;

        let mut select = conn.prepare(
            "SELECT id, project_id, from_codex_id, to_codex_id, relation_type, label, inverse_label, directionality
               FROM codex_relations
              WHERE semantic_key = '' OR semantic_key IS NULL",
        )?;
        let rows = select
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(select);

        let mut update =
            conn.prepare("UPDATE codex_relations SET semantic_key = ?1 WHERE id = ?2")?;
        for (id, project_id, from_id, to_id, relation_type, label, inverse_label, directionality) in
            rows
        {
            let key = build_codex_relation_semantic_key(
                &project_id,
                &from_id,
                &to_id,
                &relation_type,
                &directionality,
                label.as_deref().unwrap_or(""),
                inverse_label.as_deref(),
            );
            update.execute(rusqlite::params![key, id])?;
        }

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_codex_relations_semantic_key
                ON codex_relations(semantic_key);",
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

    /// Lowercased, whitespace-stripped `sqlite_master.sql` for idempotency
    /// checks that need to detect a specific CHECK/constraint clause
    /// regardless of the formatting SQLite echoes it back with.
    fn compact(sql: &str) -> String {
        sql.chars()
            .filter(|character| !character.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::time::{Duration, Instant};

    fn temp_database_path(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("grimodex-migrate-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create migration test directory");
        dir.join("grimodex.db")
    }

    fn seed_finding_identity_migration_fixture(db: &Database, ambiguous: bool) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-finding-identity', 'Finding Identity')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-finding-identity', 'project-finding-identity', 1,
                         'initial', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            let edge_count = if ambiguous { 2 } else { 1 };
            for index in 1..=edge_count {
                let edge_id = format!("edge-finding-identity-{index}");
                let source_identity = format!("project:scene:scene-{index}");
                conn.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key,
                         source_object_identity, read_set_json, created_at, owning_run_id)
                     VALUES (?1, 'project-finding-identity', 'proposal-revision',
                             'revision-finding-identity', ?2, '[]',
                             '2026-08-15T00:00:00.000Z', 'run-old')",
                    params![edge_id, source_identity],
                )?;
                let observation_id = format!("observation-finding-identity-{index}");
                conn.execute(
                    "INSERT INTO narrative_maintenance_finding_observations
                        (id, project_id, run_id, semantic_epoch_id, edge_id,
                         finding_key, reason_code, evidence_freshness_snapshot,
                         material_basis_digest, observed_at, finding_identity,
                         rule_id, rule_version, observation_digest)
                     VALUES (?1, 'project-finding-identity', 'run-old',
                             'epoch-finding-identity', ?2,
                             'proposal-revision:revision-finding-identity',
                             'source-missing', 'source-missing', 'legacy-material',
                             '2026-08-15T00:00:00.000Z', '',
                             'narrative.consumer-freshness', 1, '')",
                    params![observation_id, edge_id],
                )?;
            }
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, finding_identity, disposition,
                     material_basis_digest, snoozed_until, set_at, actor_id,
                     request_id, payload_digest, reason, version)
                 VALUES ('project-finding-identity',
                         'proposal-revision:revision-finding-identity', NULL,
                         'dismissed', 'legacy-material', NULL,
                         '2026-08-15T00:00:00.000Z', 'author-1',
                         'request-finding-identity', 'payload-finding-identity',
                         NULL, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed Finding identity migration fixture");
    }

    #[test]
    fn schema_31_converts_unique_observation_and_attention_material_basis() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        seed_finding_identity_migration_fixture(&db, false);

        db.with_conn(Database::migrate_narrative_finding_identity_v31)
            .expect("run SCHEMA 31 identity migration");

        let expected_material = crate::narrative_extraction::material_basis_digest(
            crate::narrative_extraction::BUNDLED_FINDING_RULE_ID,
            crate::narrative_extraction::BUNDLED_FINDING_RULE_VERSION,
            &crate::narrative_extraction::MaterialBasisInput {
                stable_subject: "edge-finding-identity-1",
                edge_id: Some("edge-finding-identity-1"),
                failure_code: None,
                reason_code: "source-missing",
                evidence_freshness: "source-missing",
                evidence_detail_digest: None,
            },
        )
        .expect("compute current material basis");
        db.with_conn(|conn| {
            let observation_material: String = conn.query_row(
                "SELECT material_basis_digest
                   FROM narrative_maintenance_finding_observations
                  WHERE id = 'observation-finding-identity-1'",
                [],
                |row| row.get(0),
            )?;
            let (attention_identity, attention_material): (Option<String>, String) = conn
                .query_row(
                    "SELECT finding_identity, material_basis_digest
                       FROM narrative_maintenance_attention
                      WHERE project_id = 'project-finding-identity'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
            assert_eq!(observation_material, expected_material);
            assert_eq!(attention_material, expected_material);
            assert_eq!(
                attention_identity,
                Some(
                    crate::narrative_extraction::stable_finding_identity(
                        crate::narrative_extraction::BUNDLED_FINDING_RULE_ID,
                        crate::narrative_extraction::BUNDLED_FINDING_RULE_VERSION,
                        "edge-finding-identity-1",
                    )
                    .expect("stable identity")
                )
            );
            Ok(())
        })
        .expect("verify SCHEMA 31 identity conversion");
    }

    #[test]
    fn schema_31_preserves_ambiguous_attention_material_and_identity() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        seed_finding_identity_migration_fixture(&db, true);

        db.with_conn(Database::migrate_narrative_finding_identity_v31)
            .expect("run SCHEMA 31 identity migration");

        db.with_conn(|conn| {
            let (identity, material): (Option<String>, String) = conn.query_row(
                "SELECT finding_identity, material_basis_digest
                   FROM narrative_maintenance_attention
                  WHERE project_id = 'project-finding-identity'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(identity, None);
            assert_eq!(material, "legacy-material");
            Ok(())
        })
        .expect("verify ambiguous Attention remains untouched");
    }

    #[test]
    fn schema_31_does_not_map_attention_through_a_non_current_observation_edge() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-finding-chain', 'Finding Chain')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-finding-chain', 'project-finding-chain', 1,
                         'initial', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at)
                 VALUES ('edge-current', 'project-finding-chain', 'proposal-revision',
                         'revision-current', 'project:scene:current', '[]',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at)
                 VALUES ('edge-historical', 'project-finding-chain', 'proposal-revision',
                         'revision-historical', 'project:scene:historical', '[]',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            // The Observation retains the old finding key, but its Edge is
            // no longer the current Edge for that Consumer. A finding-key /
            // digest-only migration must not use this row as identity proof.
            conn.execute(
                "INSERT INTO narrative_maintenance_finding_observations
                    (id, project_id, run_id, semantic_epoch_id, edge_id,
                     finding_key, reason_code, evidence_freshness_snapshot,
                     material_basis_digest, observed_at, finding_identity,
                     rule_id, rule_version, observation_digest)
                 VALUES ('observation-historical', 'project-finding-chain', 'run-old',
                         'epoch-finding-chain', 'edge-historical',
                         'proposal-revision:revision-current', 'source-missing',
                         'source-missing', 'legacy-material',
                         '2026-08-15T00:00:00.000Z', '',
                         'narrative.consumer-freshness', 1, '')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_maintenance_attention
                    (project_id, finding_key, finding_identity, disposition,
                     material_basis_digest, snoozed_until, set_at, actor_id,
                     request_id, payload_digest, reason, version)
                 VALUES ('project-finding-chain', 'proposal-revision:revision-current',
                         NULL, 'dismissed', 'legacy-material', NULL,
                         '2026-08-15T00:00:00.000Z', 'author-1',
                         'request-finding-chain', 'payload-finding-chain', NULL, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed non-current observation chain");

        db.with_conn(Database::migrate_narrative_finding_identity_v31)
            .expect("run SCHEMA 31 identity migration");

        db.with_conn(|conn| {
            let (identity, status, material): (Option<String>, String, String) = conn.query_row(
                "SELECT finding_identity, identity_resolution_status, material_basis_digest
                   FROM narrative_maintenance_attention
                  WHERE project_id = 'project-finding-chain'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(identity, None);
            assert_eq!(status, "legacy-unresolved");
            assert_eq!(material, "legacy-material");
            Ok(())
        })
        .expect("historical observation must not resolve current Attention");
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
    fn restore_preflight_repairs_a_stale_c2a_trigger_on_current_schema() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-stale-trigger', 'Stale trigger')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, summary_json, created_at, updated_at)
                 VALUES ('set-stale-trigger', 'run-stale-trigger', 'project-stale-trigger',
                         'chronicle.extract.review@1', '{}', datetime('now'), datetime('now'))",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, status, payload_json,
                     current_revision_id, created_at, updated_at)
                 VALUES ('proposal-stale-trigger', 'set-stale-trigger',
                         'event:stale-trigger', 'chronicle.create-event@1', 'unreviewed',
                         '{}', 'revision-stale-trigger-parent', datetime('now'), datetime('now'))",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     reconciliation_envelope_json, created_at, created_by)
                 VALUES ('revision-stale-trigger-parent', 'proposal-stale-trigger', 1, '{}',
                         'enveloped', '{\"schemaVersion\":2}', datetime('now'), 'migration-test')",
                [],
            )?;
            conn.execute_batch(
                r#"
                DROP TRIGGER narrative_proposal_revisions_v2_monotonicity_guard;
                CREATE TRIGGER narrative_proposal_revisions_v2_monotonicity_guard
                    BEFORE INSERT ON narrative_proposal_revisions
                    WHEN EXISTS (
                        SELECT 1
                          FROM narrative_proposals p
                          JOIN narrative_proposal_revisions current_revision
                            ON current_revision.id = p.current_revision_id
                         WHERE p.id = NEW.proposal_id
                           AND current_revision.origin_kind = 'enveloped'
                           AND json_extract(current_revision.reconciliation_envelope_json,
                                            '$.schemaVersion') = 2
                    )
                    AND (
                        NEW.origin_kind <> 'enveloped'
                        OR NEW.reconciliation_envelope_json IS NULL
                        OR json_extract(NEW.reconciliation_envelope_json,
                                        '$.schemaVersion') <> 2
                    )
                    BEGIN
                        SELECT RAISE(ABORT, 'NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN');
                    END;
                "#,
            )?;
            assert!(!grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(
                conn
            )?);
            Ok(())
        })
        .expect("seed current schema with stale C2A trigger");

        db.migrate_for_restore_preflight()
            .expect("restore preflight must converge a current schema with a stale trigger");

        db.with_conn(|conn| {
            assert!(
                grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?
            );
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            for (case, envelope_json) in [
                ("missing-schema-version", "{}"),
                ("null-schema-version", r#"{"schemaVersion":null}"#),
            ] {
                let child_id = format!("revision-stale-trigger-{case}");
                let error = conn
                    .execute(
                        "INSERT INTO narrative_proposal_revisions
                            (id, proposal_id, revision_number, payload_json, origin_kind,
                             reconciliation_envelope_json, created_at, created_by)
                         VALUES (?1, 'proposal-stale-trigger', 2, '{}', 'enveloped', ?2,
                                 datetime('now'), 'migration-test')",
                        params![child_id, envelope_json],
                    )
                    .expect_err("repaired trigger must reject a non-V2 child envelope");
                assert!(
                    error
                        .to_string()
                        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"),
                    "{case}: unexpected trigger error: {error}"
                );
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_revisions WHERE id = ?1",
                    [&child_id],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0, "{case}: rejected child persisted");
            }

            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     reconciliation_envelope_json, created_at, created_by)
                 VALUES ('revision-stale-trigger-numeric-boundary', 'proposal-stale-trigger',
                         2, '{}', 'enveloped', '{\"schemaVersion\":2.0}',
                         datetime('now'), 'migration-test')",
                [],
            )?;
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_revisions
                  WHERE id = 'revision-stale-trigger-numeric-boundary'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 1, "integer-valued 2.0 boundary must remain accepted");
            Ok(())
        })
        .expect("verify repaired C2A trigger and schema checkpoint");
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
    fn schema_4_full_migration_restores_runtime_policy_from_previous_marker() {
        // SCHEMA 4 intentionally disables the v2→v3 marker-only fast path so the
        // Native-owned narrative_runtime_policy singleton is never skipped.
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute("DELETE FROM narrative_runtime_policy", [])?;
            conn.pragma_update(None, "user_version", 3)?;
            Ok(())
        })
        .expect("simulate schema 3 workspace missing runtime policy");

        db.migrate()
            .expect("full migration must recreate Native runtime policy");
        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            assert!(
                grimodex_core::workspace_schema::has_v4_checkpoint_invariants(conn)?,
                "runtime policy singleton must exist after migration"
            );
            Ok(())
        })
        .expect("verify schema 4 policy restore");
    }

    #[test]
    fn converged_previous_schema_migrate_does_not_wait_for_writer() {
        let path = temp_database_path("converged-previous-version-lock");
        let db = Database::new(&path).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            Ok(())
        })
        .expect("mark database as the previous schema version");

        let locker = Connection::open(&path).expect("open competing connection");
        locker
            .busy_timeout(Duration::from_millis(50))
            .expect("set competing busy timeout");
        locker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write reservation");

        let started = Instant::now();
        db.migrate()
            .expect("converged previous schema must use the non-blocking fast path");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "converged previous schema waited behind an unrelated writer"
        );
        let version_while_locked: i32 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read version after failed migration");
        assert_eq!(
            version_while_locked,
            grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
        );
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
    fn converged_previous_schema_migrate_repairs_missing_editor_stickies() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE editor_stickies;")?;
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            Ok(())
        })
        .expect("simulate previous workspace missing sticky table");

        db.migrate()
            .expect("one migration must recreate editor stickies");
        db.with_conn(|conn| {
            let table_exists: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                     WHERE type = 'table' AND name = 'editor_stickies'
                )",
                [],
                |row| row.get(0),
            )?;
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert!(table_exists);
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            Ok(())
        })
        .expect("verify sticky table repair");
    }

    #[test]
    fn converged_previous_schema_preserves_post_effect_crash_recovery() {
        let db =
            Database::new(std::path::Path::new(":memory:")).expect("open crash recovery fixture");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('interrupted-run', 'default-project', 'review', 'project',
                         'model', 'v1', 'running')",
                [],
            )?;
            Ok(())
        })
        .expect("create interrupted previous-schema run");

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
    fn schema_4_recovers_interrupted_runs_when_upgrading_from_version_3() {
        let db =
            Database::new(std::path::Path::new(":memory:")).expect("open crash recovery fixture");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(None, "user_version", 3)?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('interrupted-run', 'default-project', 'review', 'project',
                         'model', 'v1', 'running')",
                [],
            )?;
            Ok(())
        })
        .expect("create interrupted schema 3 run");

        db.migrate()
            .expect("recover interrupted run during schema 4 migration");
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
        let path = temp_database_path("blocked-previous-crash-recovery");
        let db = Database::new(&path).expect("open crash recovery fixture");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, model, prompt_version, status)
                 VALUES ('interrupted-run', 'default-project', 'review', 'project',
                         'model', 'v1', 'running')",
                [],
            )?;
            Ok(())
        })
        .expect("create interrupted previous-schema run");

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
            assert_eq!(version, grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,);
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
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            conn.busy_timeout(Duration::from_millis(50))?;
            Ok(())
        })
        .expect("create incomplete previous schema");

        let locker = Connection::open(&path).expect("open competing connection");
        locker
            .busy_timeout(Duration::from_millis(50))
            .expect("set competing busy timeout");
        locker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write reservation");

        let error = db
            .migrate()
            .expect_err("incomplete previous schema must retain the full migration");
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
        assert_eq!(
            version_while_locked,
            grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
        );

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
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            Ok(())
        })
        .expect("replace audit ledger with malformed same-name table");

        let error = db
            .migrate()
            .expect_err("full migration must not stamp an unrepairable schema");
        assert!(
            error
                .to_string()
                .contains("did not satisfy current schema invariants after migration"),
            "unexpected migration error: {error:#}"
        );
        let retained_version: i32 = db
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("read retained schema version");
        assert_eq!(
            retained_version,
            grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
        );
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
    fn migrate_backfills_occ_columns_on_legacy_codex_details() {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            // Minimal pre-v8 tables: only the columns that existed before OCC.
            // Do not stub projects/codex_entries — migrate() creates the full
            // tables via CREATE TABLE IF NOT EXISTS.
            conn.execute_batch(
                "CREATE TABLE codex_detail_definitions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    type_slug TEXT NOT NULL,
                    name TEXT NOT NULL,
                    field_type TEXT NOT NULL DEFAULT 'text',
                    field_config TEXT,
                    sort_order REAL NOT NULL DEFAULT 0.0,
                    include_in_context INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 CREATE TABLE codex_detail_values (
                    id TEXT PRIMARY KEY,
                    entry_id TEXT NOT NULL,
                    definition_id TEXT NOT NULL,
                    value TEXT
                 );
                 INSERT INTO codex_detail_definitions
                   (id, project_id, type_slug, name)
                   VALUES ('d1', 'p1', 'character', '年齢');
                 INSERT INTO codex_detail_values (id, entry_id, definition_id, value)
                   VALUES ('v1', 'e1', 'd1', '17');",
            )?;
            Ok(())
        })
        .unwrap();

        db.migrate().unwrap();

        db.with_conn(|conn| {
            let def_cols: Vec<String> = conn
                .prepare("PRAGMA table_info(codex_detail_definitions)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            assert!(
                def_cols.iter().any(|c| c == "version"),
                "definition version column should be backfilled"
            );
            assert!(
                def_cols.iter().any(|c| c == "updated_at"),
                "definition updated_at column should be backfilled"
            );
            let value_cols: Vec<String> = conn
                .prepare("PRAGMA table_info(codex_detail_values)")?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<Result<_, _>>()?;
            assert!(
                value_cols.iter().any(|c| c == "version"),
                "value version column should be backfilled"
            );
            assert!(
                value_cols.iter().any(|c| c == "created_at"),
                "value created_at column should be backfilled"
            );
            assert!(
                value_cols.iter().any(|c| c == "updated_at"),
                "value updated_at column should be backfilled"
            );
            let def_version: i64 = conn.query_row(
                "SELECT version FROM codex_detail_definitions WHERE id = 'd1'",
                [],
                |row| row.get(0),
            )?;
            let value_version: i64 = conn.query_row(
                "SELECT version FROM codex_detail_values WHERE id = 'v1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(def_version, 0);
            assert_eq!(value_version, 0);
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

    #[test]
    fn migrate_codex_relations_v7_backfills_directed_semantic_keys_without_deleting_duplicates() {
        let conn = Connection::open_in_memory().expect("open fixture db");
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE codex_entries (id TEXT PRIMARY KEY);
             INSERT INTO projects (id) VALUES ('p1');
             INSERT INTO codex_entries (id) VALUES ('a'), ('b');
             CREATE TABLE codex_relations (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                from_codex_id TEXT NOT NULL,
                to_codex_id TEXT NOT NULL,
                relation_type TEXT NOT NULL DEFAULT 'custom',
                label TEXT,
                depth_hint INTEGER,
                source_map_edge_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO codex_relations
                (id, project_id, from_codex_id, to_codex_id, relation_type, label)
             VALUES
                ('r1', 'p1', 'a', 'b', 'friend', '友人'),
                ('r2', 'p1', 'a', 'b', 'friend', '友人');",
        )
        .expect("create legacy relations fixture");

        Database::migrate_codex_relations_v7(&conn).expect("migrate v7 columns");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM codex_relations", [], |row| row.get(0))
            .expect("count relations");
        assert_eq!(count, 2, "legacy duplicates must be retained");

        let keys: Vec<String> = conn
            .prepare("SELECT semantic_key FROM codex_relations ORDER BY id")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0], keys[1]);
        assert!(keys[0].starts_with("d\t"), "legacy rows stay directed");
        assert!(keys[0].contains("友人"));

        let index_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'index' AND name = 'idx_codex_relations_semantic_key'",
                [],
                |row| row.get(0),
            )
            .expect("index probe");
        assert_eq!(index_exists, 1);

        let unique: i64 = conn
            .query_row(
                "SELECT \"unique\" FROM pragma_index_list('codex_relations')
                  WHERE name = 'idx_codex_relations_semantic_key'",
                [],
                |row| row.get(0),
            )
            .expect("unique probe");
        assert_eq!(unique, 0, "semantic_key index must remain non-unique");
    }

    #[test]
    fn schema_16_migrates_scene_event_rows_to_the_legacy_incarnation() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Project');
                 INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order)
                 VALUES ('s1', 'p1', 'scene', 'Scene', '{}', 'a0');
                 INSERT INTO events
                    (id, project_id, title, ordinal, created_at, updated_at)
                 VALUES ('e1', 'p1', 'Event', 'a0', datetime('now'), datetime('now'));
                 INSERT INTO scene_events (scene_id, event_id, incarnation_token)
                 VALUES ('s1', 'e1', 'pre-v16-placeholder');
                 ALTER TABLE scene_events DROP COLUMN incarnation_token;",
            )?;
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            Ok(())
        })
        .expect("simulate schema 16 workspace");

        db.migrate().expect("migrate schema 16 to current");
        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let token: String = conn.query_row(
                "SELECT incarnation_token FROM scene_events
                 WHERE scene_id = 's1' AND event_id = 'e1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            assert_eq!(token, "");
            assert!(
                grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?
            );
            Ok(())
        })
        .expect("verify schema 16 scene-event migration");
    }

    #[test]
    fn previous_marker_probe_is_bound_to_marker_16_and_current_physical_schema() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            assert!(
                grimodex_core::workspace_schema::is_previous_workspace_schema_write_compatible(
                    conn
                )?
            );

            conn.pragma_update(None, "user_version", 15)?;
            assert!(
                !grimodex_core::workspace_schema::is_previous_workspace_schema_write_compatible(
                    conn
                )?
            );

            conn.pragma_update(
                None,
                "user_version",
                grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
            )?;
            conn.execute_batch("DROP TRIGGER narrative_revision_envelope_immutable_update")?;
            assert!(
                !grimodex_core::workspace_schema::is_previous_workspace_schema_write_compatible(
                    conn
                )?
            );
            Ok(())
        })
        .expect("probe previous marker compatibility");
    }

    // -- SCHEMA_VERSION 23: Gate C2-01 Semantic Build Graph -----------------

    #[test]
    fn schema_23_full_migration_creates_semantic_build_graph_and_status_checks() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            for table in [
                "narrative_semantic_epochs",
                "narrative_dependency_edges",
                "narrative_dependency_edge_states",
                "narrative_consumer_freshness",
                "narrative_application_contributions",
                "narrative_maintenance_finding_observations",
                "narrative_maintenance_attention",
            ] {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )?;
                assert!(exists, "expected SCHEMA 23 table to exist: {table}");
            }
            assert!(
                grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?
            );
            Ok(())
        })
        .expect("verify SCHEMA 23 Semantic Build Graph tables");

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Test')",
                [],
            )
            .ok();
            let rejected = conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at)
                 VALUES ('bad-run', 'proj-1', 's', '{}', '{}', 'd', 'bogus', 'now')",
                [],
            );
            assert!(rejected.is_err(), "unknown Run status must violate the SCHEMA 23 CHECK");

            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at)
                 VALUES ('superseded-run', 'proj-1', 's', '{}', '{}', 'd', 'superseded', 'now')",
                [],
            )?;

            let bad_failure_code = conn.execute(
                "INSERT INTO narrative_extraction_attempts
                    (id, task_id, attempt_number, status, started_at, failure_code)
                 VALUES ('bad-attempt', 'missing-task', 1, 'failed', 'now', 'NOT_NEX_PREFIXED')",
                [],
            );
            assert!(
                bad_failure_code.is_err(),
                "failure_code without the NEX_ prefix must violate the SCHEMA 23 CHECK"
            );

            let bad_next_attempt = conn.execute(
                "INSERT INTO narrative_extraction_attempts
                    (id, task_id, attempt_number, status, started_at, retry_disposition, next_attempt_at)
                 VALUES ('bad-attempt-2', 'missing-task', 1, 'failed', 'now', 'terminal', '2026-01-01')",
                [],
            );
            assert!(
                bad_next_attempt.is_err(),
                "next_attempt_at must require retry_disposition = retryable"
            );
            Ok(())
        })
        .expect("verify SCHEMA 23 status/failure CHECK constraints");
    }

    #[test]
    fn schema_23_migration_is_idempotent() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("first migrate to current schema");
        db.migrate()
            .expect("second migrate on an already-current database must be a no-op");
        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            Ok(())
        })
        .expect("schema version stable after repeated migrate");
    }

    fn seed_pre_v23_execution_state_tables(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('proj-1');
             CREATE TABLE narrative_extraction_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface_path_id TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                spec_json TEXT NOT NULL,
                spec_digest TEXT NOT NULL,
                snapshot_digest TEXT,
                catalog_digest TEXT,
                registry_digest TEXT,
                status TEXT NOT NULL,
                coverage_json TEXT NOT NULL DEFAULT '{}',
                outcome_summary_json TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                version INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE narrative_extraction_tasks (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                task_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                input_json TEXT NOT NULL DEFAULT '{}',
                output_json TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                lease_owner TEXT,
                lease_expires_at TEXT,
                heartbeat_at TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                version INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE narrative_extraction_attempts (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                error_message TEXT,
                output_json TEXT
             );
             INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at)
             VALUES ('run-1', 'proj-1', 's', '{}', '{}', 'd', 'completed', 'now');
             INSERT INTO narrative_extraction_tasks (id, run_id, task_kind, status, created_at)
             VALUES ('task-1', 'run-1', 'kind-a', 'completed', 'now');
             INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at)
             VALUES
                ('attempt-legacy-failed', 'task-1', 1, 'failed', 'now'),
                ('attempt-ok', 'task-1', 2, 'completed', 'now');",
        )
        .expect("seed pre-SCHEMA-23 execution-state tables");
    }

    #[test]
    fn migrate_narrative_extraction_status_v23_normalizes_legacy_failed_attempts() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v23_execution_state_tables(&conn);

        Database::migrate_narrative_extraction_status_v23(&conn)
            .expect("SCHEMA 23 execution-state migration");

        let (failure_code, retry_disposition, policy_version): (
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT failure_code, retry_disposition, policy_version
                   FROM narrative_extraction_attempts WHERE id = 'attempt-legacy-failed'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read normalized legacy attempt");
        assert_eq!(failure_code.as_deref(), Some("NEX_LEGACY_UNCLASSIFIED"));
        assert_eq!(retry_disposition.as_deref(), Some("terminal"));
        assert_eq!(policy_version.as_deref(), Some("legacy"));

        let clean: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT failure_code, retry_disposition
                   FROM narrative_extraction_attempts WHERE id = 'attempt-ok'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read non-failed attempt");
        assert_eq!(clean, (None, None));

        // Idempotent: a second run against the now-current shape is a no-op.
        Database::migrate_narrative_extraction_status_v23(&conn)
            .expect("second SCHEMA 23 execution-state migration must be a no-op");
    }

    #[test]
    fn migrate_narrative_extraction_status_v23_rejects_unrecognized_status() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v23_execution_state_tables(&conn);
        conn.execute(
            "UPDATE narrative_extraction_runs SET status = 'bogus-status' WHERE id = 'run-1'",
            [],
        )
        .expect("corrupt run status");

        let error = Database::migrate_narrative_extraction_status_v23(&conn)
            .expect_err("unrecognized status must fail closed, not silently coerce");
        assert!(
            error.to_string().contains("NEX_EXECUTION_STATUS_INVALID"),
            "unexpected error: {error:#}"
        );

        // Failing closed must not have left a partial rebuild behind.
        let status: String = conn
            .query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .expect("original row must remain readable");
        assert_eq!(status, "bogus-status");
    }

    #[test]
    fn migrate_narrative_change_cursors_v23_keeps_pre_c2_consumers_reservation_free() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('proj-1');
             CREATE TABLE narrative_change_cursors (
                project_id                    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                consumer_id                   TEXT NOT NULL CHECK(length(consumer_id) > 0),
                acknowledged_through_sequence INTEGER NOT NULL DEFAULT 0
                    CHECK(acknowledged_through_sequence >= 0),
                lease_owner                   TEXT,
                lease_expires_at              TEXT,
                last_error                    TEXT,
                updated_at                    TEXT NOT NULL,
                PRIMARY KEY(project_id, consumer_id)
             );
             INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence, updated_at)
             VALUES ('proj-1', 'legacy-consumer', 42, 'now');",
        )
        .expect("seed pre-SCHEMA-23 cursor table");

        Database::migrate_narrative_change_cursors_v23(&conn)
            .expect("SCHEMA 23 cursor reservation migration");

        let (semantic_epoch_id, reserved_through_sequence, active_run_id): (
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT semantic_epoch_id, reserved_through_sequence, active_run_id
                   FROM narrative_change_cursors WHERE consumer_id = 'legacy-consumer'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read migrated legacy cursor");
        assert_eq!(semantic_epoch_id, None);
        assert_eq!(reserved_through_sequence, None);
        assert_eq!(active_run_id, None);

        let acknowledged: i64 = conn
            .query_row(
                "SELECT acknowledged_through_sequence FROM narrative_change_cursors
                  WHERE consumer_id = 'legacy-consumer'",
                [],
                |row| row.get(0),
            )
            .expect("read preserved acknowledgment");
        assert_eq!(acknowledged, 42);

        Database::migrate_narrative_change_cursors_v23(&conn)
            .expect("second SCHEMA 23 cursor reservation migration must be a no-op");
    }

    fn seed_pre_v24_run_kind_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('proj-1');
             CREATE TABLE narrative_semantic_epochs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                epoch_number INTEGER NOT NULL CHECK(epoch_number >= 0),
                reason TEXT NOT NULL,
                triggered_by_change_event_uid TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(project_id, epoch_number)
             );
             INSERT INTO narrative_semantic_epochs (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-1', 'proj-1', 0, 'initial', 'now');
             CREATE TABLE narrative_extraction_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface_path_id TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                spec_json TEXT NOT NULL,
                spec_digest TEXT NOT NULL,
                snapshot_digest TEXT,
                catalog_digest TEXT,
                registry_digest TEXT,
                status TEXT NOT NULL
                    CHECK(status IN ('pending','running','completed','failed','cancelled','superseded')),
                coverage_json TEXT NOT NULL DEFAULT '{}',
                outcome_summary_json TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                run_kind TEXT NOT NULL DEFAULT 'interpretation'
                    CHECK(run_kind IN ('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill')),
                consumer_id TEXT,
                semantic_epoch_id TEXT REFERENCES narrative_semantic_epochs(id),
                work_key TEXT,
                terminal_reason_code TEXT
                    CHECK(terminal_reason_code IS NULL OR terminal_reason_code GLOB 'NEX_*'),
                superseded_by_run_id TEXT REFERENCES narrative_extraction_runs(id)
             );
             INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at, run_kind)
             VALUES
                ('run-1', 'proj-1', 'chronicle.extract', '{}', '{}', 'digest-1', 'completed', 'now', 'interpretation'),
                ('run-2', 'proj-1', 'chronicle.extract', '{}', '{}', 'digest-2', 'completed', 'now', 'backfill');",
        )
        .expect("seed pre-SCHEMA-24 run_kind table");
    }

    #[test]
    fn migrate_run_kind_v24_widens_check_preserves_rows_and_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v24_run_kind_table(&conn);

        Database::migrate_run_kind_v24(&conn).expect("SCHEMA 24 run_kind migration");

        let rows: Vec<(String, String)> = conn
            .prepare("SELECT id, run_kind FROM narrative_extraction_runs ORDER BY id")
            .expect("prepare row read")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query rows")
            .collect::<Result<_, _>>()
            .expect("collect rows");
        assert_eq!(
            rows,
            vec![
                ("run-1".to_owned(), "interpretation".to_owned()),
                ("run-2".to_owned(), "backfill".to_owned()),
            ]
        );

        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at, run_kind)
             VALUES ('run-3', 'proj-1', 'x', '{}', '{}', 'd3', 'completed', 'now', 'dependency-verify')",
            [],
        )
        .expect("dependency-verify run_kind must now be accepted");
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at, run_kind)
             VALUES ('run-4', 'proj-1', 'x', '{}', '{}', 'd4', 'completed', 'now', 'dependency-repair')",
            [],
        )
        .expect("dependency-repair run_kind must now be accepted");

        let foreign_key_errors: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("run foreign_key_check");
        assert_eq!(foreign_key_errors, 0);

        // Idempotent: a second run against the now-current shape is a no-op.
        Database::migrate_run_kind_v24(&conn)
            .expect("second SCHEMA 24 run_kind migration must be a no-op");
    }

    #[test]
    fn migrate_repair_lease_run_binding_v27_adds_the_column_and_keeps_existing_leases() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        // The pre-SCHEMA-27 shape: everything the lease needs to say *what*
        // was approved, but nothing saying which execution may apply it.
        conn.execute_batch(
            "CREATE TABLE narrative_maintenance_repair_leases (
                project_id              TEXT NOT NULL,
                lease_owner             TEXT NOT NULL,
                verify_run_id           TEXT NOT NULL,
                repair_plan_digest      TEXT NOT NULL,
                semantic_epoch_id       TEXT NOT NULL,
                claimed_at              TEXT NOT NULL,
                expires_at              TEXT NOT NULL,
                PRIMARY KEY(project_id)
             );
             INSERT INTO narrative_maintenance_repair_leases
                VALUES ('proj-1', 'owner-1', 'verify-1', 'sha256:d', 'epoch-1',
                        '2026-08-15T00:00:00.000Z', '2026-08-15T00:15:00.000Z');",
        )
        .expect("seed a pre-v27 lease table");

        Database::migrate_narrative_repair_lease_run_binding_v27(&conn)
            .expect("SCHEMA 27 lease run-binding migration");

        // A lease claimed before this migration carries NULL, which fails
        // `assert_repair_lease_still_held_in_tx`'s CAS — the safe direction.
        let (owner, active_run_id): (String, Option<String>) = conn
            .query_row(
                "SELECT lease_owner, active_run_id FROM narrative_maintenance_repair_leases
                  WHERE project_id = 'proj-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read the migrated lease");
        assert_eq!(owner, "owner-1");
        assert_eq!(active_run_id, None);

        Database::migrate_narrative_repair_lease_run_binding_v27(&conn)
            .expect("second SCHEMA 27 lease migration must be a no-op");
    }

    #[test]
    fn migrate_repair_lease_run_binding_v27_is_a_no_op_without_the_table() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        Database::migrate_narrative_repair_lease_run_binding_v27(&conn)
            .expect("a workspace with no lease table must migrate cleanly");
    }

    fn seed_pre_v28_contributions(conn: &Connection, rows: &[(&str, &str, &str)]) {
        conn.execute_batch(
            "CREATE TABLE narrative_application_contributions (
                id                     TEXT PRIMARY KEY,
                project_id             TEXT NOT NULL,
                application_id         TEXT NOT NULL,
                target_object_identity TEXT NOT NULL,
                field_path             TEXT NOT NULL,
                target_state           TEXT NOT NULL,
                created_at             TEXT NOT NULL,
                UNIQUE(project_id, application_id, target_object_identity, field_path)
             );",
        )
        .expect("seed a pre-v28 contributions table");
        for (id, identity, field_path) in rows {
            conn.execute(
                "INSERT INTO narrative_application_contributions
                    (id, project_id, application_id, target_object_identity,
                     field_path, target_state, created_at)
                 VALUES (?1, 'proj-1', ?1, ?2, ?3, 'unchanged',
                         '2026-08-15T00:00:00.000Z')",
                params![id, identity, field_path],
            )
            .expect("seed a pre-v28 contribution");
        }
    }

    fn migrated_identity(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT target_object_identity FROM narrative_application_contributions
              WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("read the migrated contribution")
    }

    #[test]
    fn migrate_contribution_target_identity_v28_canonicalizes_both_old_vocabularies() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_contributions(
            &conn,
            &[
                // Written by the Legacy Backfill from `applied_entity_kind`.
                (
                    "backfill-codex",
                    "codex_entry:entry-1",
                    "/legacy-application",
                ),
                (
                    "backfill-marker",
                    "plot_thread_marker:marker-1",
                    "/legacy-application",
                ),
                // Temporal annotation rows address what they annotate.
                (
                    "backfill-scene-chronicle",
                    "temporal_scene_chronicle:scene-1",
                    "/legacy-application",
                ),
                // Written by Apply from the Field Authority ledger. Canonical
                // in neither vocabulary.
                ("apply-event", "event:event-1", "/title"),
                (
                    "apply-binding",
                    "codex-detail-semantic-binding:binding-1",
                    "/boundEntityId",
                ),
                // Already canonical; must be left exactly as-is.
                ("apply-scene", "scene:scene-9", "/storyTimeOrder"),
                ("apply-foreshadow", "foreshadow:fs-1", "/note"),
            ],
        );

        Database::migrate_narrative_contribution_target_identity_v28(&conn)
            .expect("SCHEMA 28 contribution identity migration");

        assert_eq!(
            migrated_identity(&conn, "backfill-codex"),
            "codex-entry:entry-1"
        );
        assert_eq!(
            migrated_identity(&conn, "backfill-marker"),
            "plot-marker:marker-1"
        );
        assert_eq!(
            migrated_identity(&conn, "backfill-scene-chronicle"),
            "scene:scene-1"
        );
        assert_eq!(
            migrated_identity(&conn, "apply-event"),
            "chronicle-event:event-1"
        );
        assert_eq!(
            migrated_identity(&conn, "apply-binding"),
            "component:codex_semantic_binding:binding-1"
        );
        assert_eq!(migrated_identity(&conn, "apply-scene"), "scene:scene-9");
        assert_eq!(
            migrated_identity(&conn, "apply-foreshadow"),
            "foreshadow:fs-1"
        );
    }

    /// Re-running must not rewrite an already-canonical row a second time --
    /// `codex-entry:` is not itself a key in the prefix table, so a second
    /// pass has nothing to match.
    #[test]
    fn migrate_contribution_target_identity_v28_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_contributions(
            &conn,
            &[("row-1", "codex_entry:entry-1", "/legacy-application")],
        );

        Database::migrate_narrative_contribution_target_identity_v28(&conn)
            .expect("first SCHEMA 28 pass");
        let once = migrated_identity(&conn, "row-1");
        Database::migrate_narrative_contribution_target_identity_v28(&conn)
            .expect("second SCHEMA 28 pass must be a no-op");
        assert_eq!(once, migrated_identity(&conn, "row-1"));
        assert_eq!(once, "codex-entry:entry-1");
    }

    /// `_` is a single-character wildcard in SQL `LIKE`, so a prefix match
    /// written that way would also rewrite unrelated kinds. Matching is done
    /// on exact string prefixes in Rust; this pins that.
    #[test]
    fn migrate_contribution_target_identity_v28_matches_prefixes_literally() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_contributions(
            &conn,
            &[
                (
                    "wildcard-bait",
                    "codexXentry:entry-1",
                    "/legacy-application",
                ),
                ("unknown-kind", "not-a-kind:thing-1", "/legacy-application"),
            ],
        );

        Database::migrate_narrative_contribution_target_identity_v28(&conn)
            .expect("SCHEMA 28 contribution identity migration");

        assert_eq!(
            migrated_identity(&conn, "wildcard-bait"),
            "codexXentry:entry-1"
        );
        assert_eq!(
            migrated_identity(&conn, "unknown-kind"),
            "not-a-kind:thing-1"
        );
    }

    fn seed_pre_v28_edges(conn: &Connection, rows: &[(&str, &str, &str)]) {
        conn.execute_batch(
            "CREATE TABLE narrative_dependency_edges (
                id                     TEXT PRIMARY KEY,
                project_id             TEXT NOT NULL,
                consumer_kind          TEXT NOT NULL,
                consumer_key           TEXT NOT NULL,
                source_object_identity TEXT NOT NULL,
                read_set_json          TEXT NOT NULL DEFAULT '[]',
                created_at             TEXT NOT NULL,
                UNIQUE(project_id, consumer_kind, consumer_key, source_object_identity)
             );
             CREATE TABLE narrative_dependency_edge_states (
                edge_id      TEXT PRIMARY KEY,
                project_id   TEXT NOT NULL,
                evaluated_at TEXT NOT NULL
             );",
        )
        .expect("seed a pre-v28 edges table");
        for (id, consumer_key, identity) in rows {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, created_at)
                 VALUES (?1, 'proj-1', 'narrative-extraction-run', ?2, ?3,
                         '2026-08-15T00:00:00.000Z')",
                params![id, consumer_key, identity],
            )
            .expect("seed a pre-v28 edge");
            conn.execute(
                "INSERT INTO narrative_dependency_edge_states (edge_id, project_id, evaluated_at)
                 VALUES (?1, 'proj-1', '2026-08-15T00:00:00.000Z')",
                params![id],
            )
            .expect("seed a pre-v28 edge state");
        }
    }

    fn edge_identities(conn: &Connection) -> Vec<String> {
        conn.prepare(
            "SELECT source_object_identity FROM narrative_dependency_edges
              ORDER BY source_object_identity ASC",
        )
        .expect("prepare edge read")
        .query_map([], |row| row.get(0))
        .expect("read edges")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect edges")
    }

    #[test]
    fn migrate_dependency_edge_identity_v28_collapses_every_doubled_prefix() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(
            &conn,
            &[
                ("e1", "run-1", "project:scene:project:scene:scene-1"),
                ("e2", "run-1", "snapshot:snapshot:run-legacy-1"),
                (
                    "e3",
                    "run-1",
                    "project:codex-catalog:project:codex-catalog:project-1",
                ),
                ("e4", "run-1", "projection:projection:proj-1"),
                ("e5", "run-1", "artifact:artifact:artifact-1"),
                ("e6", "run-1", "capture:capture:capture-1"),
                ("e7", "run-1", "evidence:evidence:evidence-1"),
                // Already correct; must survive untouched.
                ("e8", "run-1", "project:scene:scene-9"),
            ],
        );

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        assert_eq!(
            edge_identities(&conn),
            vec![
                "artifact:artifact-1",
                "capture:capture-1",
                "evidence:evidence-1",
                "project:codex-catalog:project-1",
                "project:scene:scene-1",
                "project:scene:scene-9",
                "projection:proj-1",
                "snapshot:run-legacy-1",
            ]
        );
    }

    /// The repaired identity can already exist for the same Consumer, which
    /// the table's UNIQUE forbids. The malformed row loses, and its Edge
    /// State goes with it rather than being orphaned.
    #[test]
    fn migrate_dependency_edge_identity_v28_drops_a_row_that_would_collide() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(
            &conn,
            &[
                ("wrong", "run-1", "project:scene:project:scene:scene-1"),
                ("right", "run-1", "project:scene:scene-1"),
                // Same malformed identity under a *different* Consumer has
                // nothing to collide with and must be repaired, not dropped.
                ("other", "run-2", "project:scene:project:scene:scene-1"),
            ],
        );

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        let surviving: Vec<String> = conn
            .prepare("SELECT id FROM narrative_dependency_edges ORDER BY id ASC")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("read")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert_eq!(surviving, vec!["other".to_string(), "right".to_string()]);

        let orphan_states: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states
                  WHERE edge_id NOT IN (SELECT id FROM narrative_dependency_edges)",
                [],
                |row| row.get(0),
            )
            .expect("count orphan states");
        assert_eq!(orphan_states, 0, "a dropped Edge must not orphan its State");
    }

    /// A bare `projection-1` was a legal envelope value, so the pre-#535
    /// Producer stored it verbatim. It is not a doubled prefix, so prefix
    /// collapsing alone leaves it -- and the v2 Backfill only *adds* the
    /// canonical Edge beside it, because the upsert key includes the
    /// identity. The kind is recovered from the Source Basis that declared it.
    #[test]
    fn migrate_dependency_edge_identity_v28_canonicalizes_a_bare_projection_key() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(&conn, &[("e1", "run-1", "projection-1")]);
        conn.execute_batch(
            "CREATE TABLE narrative_revision_source_basis (
                revision_id TEXT NOT NULL,
                ordinal     INTEGER NOT NULL,
                source_kind TEXT NOT NULL,
                source_key  TEXT NOT NULL
             );
             CREATE TABLE narrative_proposal_revisions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL);
             CREATE TABLE narrative_proposals (id TEXT PRIMARY KEY, proposal_set_id TEXT NOT NULL);
             CREATE TABLE narrative_proposal_sets (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL);
             INSERT INTO narrative_proposal_sets VALUES ('set-1', 'proj-1', 'run-1');
             INSERT INTO narrative_proposals VALUES ('proposal-1', 'set-1');
             INSERT INTO narrative_proposal_revisions VALUES ('revision-1', 'proposal-1');
             INSERT INTO narrative_revision_source_basis
                VALUES ('revision-1', 0, 'domain-projection', 'projection-1');",
        )
        .expect("seed the declaring Source Basis");

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        assert_eq!(edge_identities(&conn), vec!["projection:projection-1"]);
    }

    #[test]
    fn migrate_dependency_edge_identity_v28_keeps_a_new_prefix_opaque_in_a_bare_projection_key() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(&conn, &[("e1", "run-1", "project:scope-authority:legacy")]);
        conn.execute_batch(
            "CREATE TABLE narrative_revision_source_basis (
                revision_id TEXT NOT NULL,
                ordinal     INTEGER NOT NULL,
                source_kind TEXT NOT NULL,
                source_key  TEXT NOT NULL
             );
             CREATE TABLE narrative_proposal_revisions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL);
             CREATE TABLE narrative_proposals (id TEXT PRIMARY KEY, proposal_set_id TEXT NOT NULL);
             CREATE TABLE narrative_proposal_sets (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL);
             INSERT INTO narrative_proposal_sets VALUES ('set-1', 'proj-1', 'run-1');
             INSERT INTO narrative_proposals VALUES ('proposal-1', 'set-1');
             INSERT INTO narrative_proposal_revisions VALUES ('revision-1', 'proposal-1');
             INSERT INTO narrative_revision_source_basis
                VALUES ('revision-1', 0, 'domain-projection', 'project:scope-authority:legacy');",
        )
        .expect("seed the declaring Source Basis");

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        let identity = edge_identities(&conn);
        assert_eq!(identity, vec!["projection:project:scope-authority:legacy"]);
        assert_eq!(
            crate::narrative_extraction::canonical_source_object_identity(
                "domain-projection",
                &identity[0]
            )
            .expect("the migration must produce an identity accepted by the current validator"),
            identity[0]
        );
    }

    /// An Edge names its own Run through `consumer_key`, so a declaration
    /// belonging to a *different* Run says nothing about this Edge's Source
    /// -- two Runs can use the same bare key for different objects. Scoping
    /// project-wide would decorate the identity on someone else's evidence.
    #[test]
    fn migrate_dependency_edge_identity_v28_ignores_another_runs_declaration() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(&conn, &[("e1", "run-1", "projection-1")]);
        conn.execute_batch(
            "CREATE TABLE narrative_revision_source_basis (
                revision_id TEXT NOT NULL,
                ordinal     INTEGER NOT NULL,
                source_kind TEXT NOT NULL,
                source_key  TEXT NOT NULL
             );
             CREATE TABLE narrative_proposal_revisions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL);
             CREATE TABLE narrative_proposals (id TEXT PRIMARY KEY, proposal_set_id TEXT NOT NULL);
             CREATE TABLE narrative_proposal_sets (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL);
             INSERT INTO narrative_proposal_sets VALUES ('set-2', 'proj-1', 'run-2');
             INSERT INTO narrative_proposals VALUES ('proposal-2', 'set-2');
             INSERT INTO narrative_proposal_revisions VALUES ('revision-2', 'proposal-2');
             INSERT INTO narrative_revision_source_basis
                VALUES ('revision-2', 0, 'domain-projection', 'projection-1');",
        )
        .expect("seed another Run's Source Basis");

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        assert_eq!(
            edge_identities(&conn),
            vec!["projection-1"],
            "run-2's declaration must not resolve run-1's Edge"
        );
    }

    /// Without a declaration the kind cannot be known, and decorating the key
    /// anyway could point the Edge at a different object. The row stays
    /// visibly unresolvable instead.
    #[test]
    fn migrate_dependency_edge_identity_v28_leaves_an_unattributable_bare_key() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(&conn, &[("e1", "run-1", "mystery-1")]);

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        assert_eq!(edge_identities(&conn), vec!["mystery-1"]);
    }

    /// Rewriting an Edge's identity invalidates every verdict reached against
    /// the old one. `narrative_consumer_freshness` is the durable Freshness
    /// authority, not a cache, and nothing else would revisit it -- the
    /// Semantic Epoch does not rotate here.
    #[test]
    fn migrate_dependency_edge_identity_v28_clears_freshness_decided_on_the_old_identity() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(
            &conn,
            &[
                ("wrong", "run-1", "project:scene:project:scene:scene-1"),
                ("untouched", "run-2", "project:scene:scene-2"),
            ],
        );
        conn.execute_batch(
            "CREATE TABLE narrative_consumer_freshness (
                project_id         TEXT NOT NULL,
                consumer_kind      TEXT NOT NULL,
                consumer_key       TEXT NOT NULL,
                evidence_freshness TEXT NOT NULL,
                PRIMARY KEY(project_id, consumer_kind, consumer_key)
             );
             CREATE TABLE narrative_maintenance_finding_observations (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL,
                finding_key TEXT NOT NULL
             );
             INSERT INTO narrative_consumer_freshness
                VALUES ('proj-1', 'narrative-extraction-run', 'run-1', 'source-missing'),
                       ('proj-1', 'narrative-extraction-run', 'run-2', 'fresh');
             INSERT INTO narrative_maintenance_finding_observations
                VALUES ('finding-1', 'proj-1', 'narrative-extraction-run:run-1'),
                       ('finding-2', 'proj-1', 'narrative-extraction-run:run-2');",
        )
        .expect("seed derived Freshness state");

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        let surviving_freshness: Vec<String> = conn
            .prepare("SELECT consumer_key FROM narrative_consumer_freshness ORDER BY consumer_key")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("read")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert_eq!(
            surviving_freshness,
            vec!["run-2".to_string()],
            "the repaired Consumer's stale verdict must go; an untouched one must not"
        );

        let surviving_states: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states WHERE edge_id = 'wrong'",
                [],
                |row| row.get(0),
            )
            .expect("count edge states");
        assert_eq!(surviving_states, 0);

        let surviving_findings: Vec<String> = conn
            .prepare("SELECT id FROM narrative_maintenance_finding_observations ORDER BY id")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("read")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert_eq!(surviving_findings, vec!["finding-2".to_string()]);
    }

    /// The collision path drops the malformed Edge instead of updating it,
    /// but the Consumer's aggregate verdict was still computed with that Edge
    /// in the set, so it is just as stale.
    #[test]
    fn migrate_dependency_edge_identity_v28_clears_freshness_after_a_collision_drop() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(
            &conn,
            &[
                ("wrong", "run-1", "project:scene:project:scene:scene-1"),
                ("right", "run-1", "project:scene:scene-1"),
            ],
        );
        conn.execute_batch(
            "CREATE TABLE narrative_consumer_freshness (
                project_id         TEXT NOT NULL,
                consumer_kind      TEXT NOT NULL,
                consumer_key       TEXT NOT NULL,
                evidence_freshness TEXT NOT NULL,
                PRIMARY KEY(project_id, consumer_kind, consumer_key)
             );
             INSERT INTO narrative_consumer_freshness
                VALUES ('proj-1', 'narrative-extraction-run', 'run-1', 'source-missing');",
        )
        .expect("seed derived Freshness state");

        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("SCHEMA 28 edge identity migration");

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness",
                [],
                |row| row.get(0),
            )
            .expect("count freshness");
        assert_eq!(remaining, 0);
        let states: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states",
                [],
                |row| row.get(0),
            )
            .expect("count states");
        assert_eq!(
            states, 0,
            "the surviving Edge's own State was decided alongside the dropped one"
        );
    }

    /// Seeds a fully-migrated workspace, plants pre-#535 rows, and rewinds
    /// the marker so the next `migrate()` sees the shape a real upgrade does.
    fn seed_full_schema_with_unrepaired_rows(db: &Database, stamp_version: i32) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Test')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at)
                 VALUES ('edge-1', 'proj-1', 'narrative-extraction-run', 'run-1',
                         'project:scene:project:scene:scene-1', '[]',
                         '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'proj-1', 0, 'initial', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, updated_at)
                 VALUES ('proj-1', 'narrative-extraction-run', 'run-1', 'source-missing',
                         'rebuild-required', 'epoch-1', '2026-08-15T00:00:00.000Z')",
                [],
            )?;
            // An older build reached this marker without the data migration,
            // which is exactly the state that has no completion record.
            conn.execute(
                "DELETE FROM schema_data_migrations WHERE migration_id = ?1",
                params![Database::C2_IDENTITY_MIGRATION_ID],
            )?;
            conn.pragma_update(None, "user_version", stamp_version)?;
            Ok(())
        })
        .expect("seed unrepaired rows");
    }

    fn edge_identity(db: &Database) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT source_object_identity FROM narrative_dependency_edges WHERE id = 'edge-1'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("read edge identity")
    }

    /// The state an earlier SCHEMA 28 build could actually leave behind:
    /// identities already canonical, but Freshness still holding the verdict
    /// it reached against the identities they replaced. Nothing in today's
    /// rows distinguishes this from a healthy workspace, which is why the
    /// completion marker exists.
    #[test]
    fn a_partially_migrated_workspace_has_its_derived_state_discarded() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open");
        db.migrate().expect("reach the current schema");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Test');
                 INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at)
                 VALUES ('edge-1', 'proj-1', 'narrative-extraction-run', 'run-1',
                         'project:scene:scene-1', '[]', '2026-08-15T00:00:00.000Z');
                 INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('epoch-1', 'proj-1', 0, 'initial', '2026-08-15T00:00:00.000Z');
                 INSERT INTO narrative_dependency_edge_states
                    (edge_id, project_id, evidence_freshness, build_action,
                     evaluated_at_epoch_id, evaluated_at)
                 VALUES ('edge-1', 'proj-1', 'source-missing', 'rebuild-required',
                         'epoch-1', '2026-08-15T00:00:00.000Z');
                 INSERT INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, updated_at)
                 VALUES ('proj-1', 'narrative-extraction-run', 'run-1', 'source-missing',
                         'rebuild-required', 'epoch-1', '2026-08-15T00:00:00.000Z');",
            )?;
            conn.execute(
                "DELETE FROM schema_data_migrations WHERE migration_id = ?1",
                params![Database::C2_IDENTITY_MIGRATION_ID],
            )?;
            conn.pragma_update(None, "user_version", grimodex_core::SCHEMA_VERSION)?;
            Ok(())
        })
        .expect("seed a partially migrated workspace");

        db.migrate().expect("migrate");

        assert_eq!(
            edge_identity(&db),
            "project:scene:scene-1",
            "the identity was already canonical and must be left alone"
        );
        assert_eq!(
            consumer_freshness_rows(&db),
            0,
            "Freshness decided against the replaced identity must not survive"
        );
        assert_eq!(edge_state_rows(&db), 0, "Edge State is rebuildable");
        assert!(
            Database::has_c2_identity_data_migration_marker(&db.lock_conn().expect("lock"))
                .expect("marker"),
            "the migration must record that it ran"
        );

        // Second open: the marker is what stops this repeating.
        db.migrate().expect("second open");
        assert!(
            grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(
                &db.lock_conn().expect("lock")
            )
            .expect("checkpoint"),
            "a marked workspace must satisfy the checkpoint"
        );
    }

    /// An earlier revision marked a Contribution's target unresolvable but
    /// left the state the Apply had written, which asserts the field still
    /// matches what was applied to an object that cannot be found.
    #[test]
    fn a_partially_migrated_workspace_corrects_unresolved_contribution_states() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open");
        db.migrate().expect("reach the current schema");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Test');
                 INSERT INTO narrative_application_contributions
                    (id, project_id, application_id, commit_id, proposal_id, revision_id,
                     target_object_identity, field_path, target_state, created_at)
                 VALUES ('c1', 'proj-1', 'app-1', 'commit-1', 'proposal-1', 'revision-1',
                         'unresolved:codex-detail-value:value-gone', '/legacy-application',
                         'unchanged', '2026-08-15T00:00:00.000Z');",
            )?;
            conn.execute(
                "DELETE FROM schema_data_migrations WHERE migration_id = ?1",
                params![Database::C2_IDENTITY_MIGRATION_ID],
            )?;
            conn.pragma_update(None, "user_version", grimodex_core::SCHEMA_VERSION)?;
            Ok(())
        })
        .expect("seed an unresolved Contribution");

        db.migrate().expect("migrate");

        let state: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT target_state FROM narrative_application_contributions WHERE id = 'c1'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("read target state");
        assert_eq!(state, "missing");
    }

    fn edge_state_rows(db: &Database) -> i64 {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edge_states",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("count edge states")
    }

    fn consumer_freshness_rows(db: &Database) -> i64 {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("count consumer freshness")
    }

    /// SCHEMA 28 changes no physical object, so a complete SCHEMA 27 database
    /// satisfies every physical checkpoint. Without the repair being part of
    /// that checkpoint, `migrate()` takes the previous-schema fast path,
    /// stamps 28, and never runs the data migration -- and the workspace can
    /// never be repaired afterwards, because 28 then takes the
    /// current-schema fast path. This goes through the public entry point,
    /// not the migration helpers, because that is where the hole was.
    #[test]
    fn public_migrate_repairs_identities_from_the_previous_schema_marker() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open");
        db.migrate().expect("reach the current schema");
        seed_full_schema_with_unrepaired_rows(&db, 27);

        db.migrate().expect("migrate from the previous marker");

        db.with_conn(|conn| {
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            Ok(())
        })
        .expect("read version");
        assert_eq!(edge_identity(&db), "project:scene:scene-1");
        assert_eq!(
            consumer_freshness_rows(&db),
            0,
            "Freshness decided on the old identity must not survive"
        );
    }

    /// The same workspace, already stamped 28 by an earlier build that had
    /// the marker but not the repair. The current-schema fast path must also
    /// notice and fall through.
    #[test]
    fn public_migrate_repairs_identities_already_stamped_at_the_current_marker() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open");
        db.migrate().expect("reach the current schema");
        seed_full_schema_with_unrepaired_rows(&db, grimodex_core::SCHEMA_VERSION);

        db.migrate().expect("migrate at the current marker");

        assert_eq!(edge_identity(&db), "project:scene:scene-1");
        assert_eq!(consumer_freshness_rows(&db), 0);
    }

    /// And a healthy workspace must keep the cheap path: repeated opens must
    /// not keep finding work.
    #[test]
    fn public_migrate_is_a_no_op_once_identities_are_canonical() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open");
        db.migrate().expect("reach the current schema");
        seed_full_schema_with_unrepaired_rows(&db, grimodex_core::SCHEMA_VERSION);
        db.migrate().expect("first repair");

        let before = edge_identity(&db);
        db.migrate().expect("second open must find nothing to do");
        assert_eq!(edge_identity(&db), before);
        assert!(
            grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(
                &db.lock_conn().expect("lock")
            )
            .expect("checkpoint"),
            "a repaired workspace must satisfy the checkpoint, or every open replays the migration"
        );
    }

    /// The checkpoint decides whether to re-run the migration, so it must
    /// never claim work the migration then declines to do -- that combination
    /// replays the whole migration on every single open and never converges.
    /// Contested declarations are the case where the two could disagree: the
    /// migration refuses to guess, so the checkpoint must call the row clean.
    #[test]
    fn a_bare_identity_the_migration_refuses_to_repair_does_not_replay_forever() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open");
        db.migrate().expect("reach the current schema");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Test');
                 INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key,
                     source_object_identity, read_set_json, created_at)
                 VALUES ('edge-1', 'proj-1', 'narrative-extraction-run', 'run-9',
                         'contested-1', '[]', '2026-08-15T00:00:00.000Z');
                 INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, created_at, updated_at)
                 VALUES ('set-9', 'run-9', 'proj-1', 'extraction',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
                 INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, payload_json,
                     created_at, updated_at)
                 VALUES ('prop-9', 'set-9', 'key-9', 'codex-entry', '{}',
                         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
                 INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, created_at, created_by)
                 VALUES ('rev-a', 'prop-9', 1, '{}', '2026-08-15T00:00:00.000Z', 'test'),
                        ('rev-b', 'prop-9', 2, '{}', '2026-08-15T00:00:00.000Z', 'test');
                 INSERT INTO narrative_revision_source_basis
                    (revision_id, ordinal, source_kind, source_key, revision_token)
                 VALUES ('rev-a', 0, 'domain-projection', 'contested-1', 'tok-a'),
                        ('rev-b', 0, 'scene', 'contested-1', 'tok-b');",
            )?;
            conn.pragma_update(None, "user_version", 27)?;
            Ok(())
        })
        .expect("seed a contested bare identity");

        db.migrate().expect("migrate");

        assert_eq!(
            edge_identity(&db),
            "contested-1",
            "the migration must not guess a kind the declarations disagree on"
        );
        assert!(
            grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(
                &db.lock_conn().expect("lock")
            )
            .expect("checkpoint"),
            "the checkpoint must agree the row is unrepairable, or every open replays"
        );
    }

    #[test]
    fn migrate_dependency_edge_identity_v28_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_edges(
            &conn,
            &[("e1", "run-1", "project:scene:project:scene:scene-1")],
        );

        Database::migrate_narrative_dependency_edge_identity_v28(&conn).expect("first pass");
        let once = edge_identities(&conn);
        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("second pass must be a no-op");
        assert_eq!(once, edge_identities(&conn));
        assert_eq!(once, vec!["project:scene:scene-1"]);
    }

    #[test]
    fn migrate_dependency_edge_identity_v28_is_a_no_op_without_the_table() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        Database::migrate_narrative_dependency_edge_identity_v28(&conn)
            .expect("a workspace with no edges table must migrate cleanly");
    }

    /// The migration freezes its own copy of the prefix list so SCHEMA 28
    /// keeps meaning what it meant. Every historical prefix must remain
    /// understood by the live canonicalizer, while later Source kinds may be
    /// added without rewriting the old migration.
    #[test]
    fn the_frozen_v28_prefix_table_remains_a_subset_of_the_live_canonicalizer() {
        use crate::narrative_extraction::SOURCE_IDENTITY_PREFIXES;

        assert_eq!(
            Database::SOURCE_IDENTITY_PREFIXES_V28,
            &[
                "project:codex-catalog:",
                "project:scene:",
                "projection:",
                "snapshot:",
                "artifact:",
                "capture:",
                "evidence:",
            ],
            "SCHEMA 28's historical transition must remain frozen"
        );
        assert!(Database::SOURCE_IDENTITY_PREFIXES_V28
            .iter()
            .all(|prefix| SOURCE_IDENTITY_PREFIXES.contains(prefix)));
        assert!(SOURCE_IDENTITY_PREFIXES.contains(&"project:scope-authority:"));

        assert_eq!(
            Database::RUN_CONSUMER_KIND_V28,
            crate::narrative_extraction::RUN_CONSUMER_KIND,
            "SCHEMA 28 scopes its Source lookup by this Consumer kind"
        );
    }

    /// The checkpoint reads the marker the migration writes, from a different
    /// crate. If the two ever name different migrations, or drift on the
    /// contract version, the checkpoint silently stops gating the repair --
    /// which is the exact failure this marker was introduced to end.
    #[test]
    fn the_checkpoint_and_the_migration_name_the_same_marker() {
        assert_eq!(
            grimodex_core::workspace_schema::C2_IDENTITY_MIGRATION_ID,
            Database::C2_IDENTITY_MIGRATION_ID
        );
        assert_eq!(
            grimodex_core::workspace_schema::C2_IDENTITY_CONTRACT_VERSION,
            Database::C2_IDENTITY_CONTRACT_VERSION
        );
    }

    /// A workspace whose live Producer declared Edges under a Run, plus the
    /// per-Revision Source Basis the re-key reads the finer attribution out
    /// of.
    ///
    /// `scene-1` is read by *both* Revisions, which is the case the old
    /// Run-grained upsert collapsed into one row; `scene-2` by only the
    /// second. `capture:cap-1` has no Source Basis anywhere -- it stands in
    /// for a Legacy Backfill Edge, which has no Revision to attribute a read
    /// to and must stay under the Run.
    fn seed_run_grained_edges_with_revisions(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE narrative_dependency_edges (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                consumer_kind TEXT NOT NULL, consumer_key TEXT NOT NULL,
                source_object_identity TEXT NOT NULL, read_set_json TEXT NOT NULL,
                generated_by_transaction_id TEXT, created_at TEXT NOT NULL,
                owning_run_id TEXT,
                UNIQUE(project_id, consumer_kind, consumer_key, source_object_identity)
             );
             CREATE TABLE narrative_proposal_sets (
                id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL
             );
             CREATE TABLE narrative_proposals (
                id TEXT PRIMARY KEY, proposal_set_id TEXT NOT NULL
             );
             CREATE TABLE narrative_proposal_revisions (
                id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL
             );
             CREATE TABLE narrative_revision_source_basis (
                revision_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
                revision_token TEXT NOT NULL,
                PRIMARY KEY(revision_id, ordinal)
             );
             CREATE TABLE schema_data_migrations (
                migration_id TEXT PRIMARY KEY, contract_version INTEGER NOT NULL,
                applied_at TEXT NOT NULL
             );
             CREATE TABLE narrative_apply_commits (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT
             );
             CREATE TABLE narrative_proposal_applications (
                id TEXT PRIMARY KEY, commit_id TEXT NOT NULL
             );
             CREATE TABLE narrative_projection_dependencies (
                application_id TEXT NOT NULL, source_kind TEXT NOT NULL,
                source_key TEXT NOT NULL, observed_revision_token TEXT NOT NULL,
                PRIMARY KEY (application_id, source_kind, source_key)
             );
             CREATE TABLE narrative_consumer_freshness (
                project_id TEXT NOT NULL, consumer_kind TEXT NOT NULL,
                consumer_key TEXT NOT NULL, evidence_freshness TEXT NOT NULL
             );
             CREATE TABLE narrative_dependency_edge_states (
                edge_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                evidence_freshness TEXT NOT NULL
             );
             CREATE TABLE narrative_maintenance_finding_observations (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, finding_key TEXT NOT NULL
             );

             INSERT INTO narrative_proposal_sets VALUES ('set-1', 'run-1', 'proj-1');
             INSERT INTO narrative_proposals VALUES ('proposal-1', 'set-1');
             INSERT INTO narrative_proposals VALUES ('proposal-2', 'set-1');
             INSERT INTO narrative_proposal_revisions VALUES ('rev-1', 'proposal-1');
             INSERT INTO narrative_proposal_revisions VALUES ('rev-2', 'proposal-2');
             INSERT INTO narrative_revision_source_basis
                VALUES ('rev-1', 0, 'scene-body', 'project:scene:scene-1', 'v1@a');
             INSERT INTO narrative_revision_source_basis
                VALUES ('rev-2', 0, 'scene-body', 'project:scene:scene-1', 'v1@a');
             INSERT INTO narrative_revision_source_basis
                VALUES ('rev-2', 1, 'scene-body', 'project:scene:scene-2', 'v3@b');

             INSERT INTO narrative_apply_commits VALUES ('commit-1', 'proj-1', 'run-1');
             INSERT INTO narrative_proposal_applications VALUES ('app-1', 'commit-1');
             INSERT INTO narrative_projection_dependencies
                VALUES ('app-1', 'scene-body', 'project:scene:scene-2', 'v3@b');

             INSERT INTO narrative_dependency_edges VALUES
                ('edge-scene-1', 'proj-1', 'narrative-extraction-run', 'run-1',
                 'project:scene:scene-1', '[\"v1@a\"]', NULL, '2026-08-15T00:00:00.000Z',
                 'run-1');
             INSERT INTO narrative_dependency_edges VALUES
                ('edge-scene-2', 'proj-1', 'narrative-extraction-run', 'run-1',
                 'project:scene:scene-2', '[\"v3@b\"]', NULL, '2026-08-15T00:00:00.000Z',
                 'run-1');
             INSERT INTO narrative_dependency_edges VALUES
                ('edge-backfill', 'proj-1', 'narrative-extraction-run', 'run-1',
                 'capture:cap-1', '[\"v9@z\"]', NULL, '2026-08-15T00:00:00.000Z', 'run-1');
             INSERT INTO narrative_consumer_freshness
                VALUES ('proj-1', 'narrative-extraction-run', 'run-1', 'fresh');
             INSERT INTO narrative_dependency_edge_states
                VALUES ('edge-scene-1', 'proj-1', 'fresh');
             INSERT INTO narrative_maintenance_finding_observations
                VALUES ('obs-1', 'proj-1', 'narrative-extraction-run:run-1');",
        )
        .expect("seed run-grained edges with revisions");
    }

    fn edge_consumers(conn: &Connection) -> Vec<(String, String, String)> {
        conn.prepare(
            "SELECT consumer_kind, consumer_key, source_object_identity
               FROM narrative_dependency_edges
              ORDER BY consumer_kind, consumer_key, source_object_identity",
        )
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect")
    }

    #[test]
    fn consumer_grain_v30_rekeys_run_edges_onto_the_revisions_that_read_them() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_run_grained_edges_with_revisions(&conn);

        Database::migrate_narrative_consumer_grain_v30(&conn).expect("consumer grain re-key");

        assert_eq!(
            edge_consumers(&conn),
            vec![
                (
                    "narrative-extraction-run".to_string(),
                    "run-1".to_string(),
                    "capture:cap-1".to_string()
                ),
                // scene-2 is declared by an Application too, and one row
                // carried both declarations. Deleting it because a Revision
                // matched would drop the Application's dependency silently.
                (
                    "narrative-extraction-run".to_string(),
                    "run-1".to_string(),
                    "project:scene:scene-2".to_string()
                ),
                (
                    "proposal-revision".to_string(),
                    "rev-1".to_string(),
                    "project:scene:scene-1".to_string()
                ),
                (
                    "proposal-revision".to_string(),
                    "rev-2".to_string(),
                    "project:scene:scene-1".to_string()
                ),
                (
                    "proposal-revision".to_string(),
                    "rev-2".to_string(),
                    "project:scene:scene-2".to_string()
                ),
            ],
            "each Revision takes the reads its own Source Basis records; the Edge with no \
             Source Basis and the one an Application also declares both stay under the Run"
        );

        let owning: Vec<Option<String>> = conn
            .prepare(
                "SELECT owning_run_id FROM narrative_dependency_edges
                  WHERE consumer_kind = 'proposal-revision'",
            )
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert!(
            owning.iter().all(|run| run.as_deref() == Some("run-1")),
            "the declaring Run survives the re-key as provenance"
        );

        let freshness: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness",
                [],
                |row| row.get(0),
            )
            .expect("count freshness");
        assert_eq!(
            freshness, 0,
            "Freshness decided against the old Consumer identity must be discarded, not \
             re-pointed at a Consumer it was never evaluated for"
        );
    }

    #[test]
    fn consumer_grain_v30_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_run_grained_edges_with_revisions(&conn);

        Database::migrate_narrative_consumer_grain_v30(&conn).expect("first pass");
        let once = edge_consumers(&conn);
        Database::migrate_narrative_consumer_grain_v30(&conn).expect("second pass");
        assert_eq!(once, edge_consumers(&conn));
    }

    /// Same pact as `the_checkpoint_and_the_migration_name_the_same_marker`,
    /// for the Consumer grain re-key. Without it the checkpoint would report
    /// a workspace healthy while the re-key had never run on it.
    #[test]
    fn the_checkpoint_and_the_consumer_grain_migration_name_the_same_marker() {
        assert_eq!(
            grimodex_core::workspace_schema::C2_CONSUMER_GRAIN_MIGRATION_ID,
            Database::C2_CONSUMER_GRAIN_MIGRATION_ID
        );
        assert_eq!(
            grimodex_core::workspace_schema::C2_CONSUMER_GRAIN_CONTRACT_VERSION,
            Database::C2_CONSUMER_GRAIN_CONTRACT_VERSION
        );
    }

    /// The re-key writes this literal into `consumer_kind`, and the live
    /// Producer has to keep reading it back as the same Consumer.
    #[test]
    fn the_frozen_v30_revision_consumer_kind_matches_the_live_constant() {
        assert_eq!(
            Database::PROPOSAL_REVISION_CONSUMER_KIND_V30,
            crate::narrative_extraction::PROPOSAL_REVISION_CONSUMER_KIND,
        );
    }

    /// The migration's frozen copy of the unresolved marker has to keep
    /// matching the writer's, or the one-time correction misses the rows the
    /// writer produced.
    #[test]
    fn the_frozen_unresolved_prefix_still_matches_the_writer() {
        assert_eq!(
            Database::UNRESOLVED_TARGET_PREFIX_V28,
            crate::narrative_extraction::application_contributions::UNRESOLVED_TARGET_PREFIX
        );
    }

    /// Hyphenating `codex_detail_value:<valueId>` would keep the Backfill
    /// row pointing at the detail-value row while the live Apply path points
    /// at the owning Entry -- different objects, different ids. The migration
    /// has to resolve the Entry, exactly as the Backfill now does.
    #[test]
    fn migrate_contribution_target_identity_v28_projects_detail_values_onto_their_entry() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v28_contributions(
            &conn,
            &[
                (
                    "live-row",
                    "codex_detail_value:value-1",
                    "/legacy-application",
                ),
                (
                    "hyphenated-row",
                    "codex-detail-value:value-1",
                    "/details/def-1",
                ),
                (
                    "gone-row",
                    "codex_detail_value:value-gone",
                    "/legacy-application",
                ),
            ],
        );
        conn.execute_batch(
            "CREATE TABLE codex_detail_values (
                id            TEXT PRIMARY KEY,
                entry_id      TEXT NOT NULL,
                definition_id TEXT NOT NULL
             );
             INSERT INTO codex_detail_values VALUES ('value-1', 'entry-1', 'def-1');",
        )
        .expect("seed detail values");

        Database::migrate_narrative_contribution_target_identity_v28(&conn)
            .expect("SCHEMA 28 contribution identity migration");

        assert_eq!(migrated_identity(&conn, "live-row"), "codex-entry:entry-1");
        assert_eq!(
            migrated_identity(&conn, "hyphenated-row"),
            "codex-entry:entry-1",
            "an already-hyphenated detail value still points at the wrong object"
        );
        assert_eq!(
            migrated_identity(&conn, "gone-row"),
            "unresolved:codex-detail-value:value-gone",
            "a deleted detail value must be marked, never guessed"
        );
    }

    /// A pre-SCHEMA-29 shape, modelled closely enough that the rebuild's two
    /// reconstructions have something real to read.
    ///
    /// It previously created only the two narrative tables. That is why the
    /// rebuild could ship `baseline_sequence = NULL` and `'maintained'` for
    /// every row and still pass: the scratch database held no canonical apply
    /// event to reconstruct a baseline from and no Field Authority row to
    /// contradict the ownership, so both fabricated values looked correct.
    ///
    /// `row-1` is a field the author already holds; `row-2` is one nobody
    /// claimed, so a blanket re-projection would be caught as readily as no
    /// re-projection at all.
    fn seed_pre_v29_contributions_with_applications(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             INSERT INTO projects VALUES ('proj-1', 'Test Project');
             CREATE TABLE change_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                op_type    TEXT NOT NULL,
                entity_id  TEXT,
                sequence   INTEGER NOT NULL
             );
             INSERT INTO change_events (project_id, op_type, entity_id, sequence)
                VALUES ('proj-1', 'narrative.commit.apply', 'commit-1', 20);
             CREATE TABLE narrative_field_authority (
                project_id   TEXT NOT NULL,
                entity_kind  TEXT NOT NULL,
                entity_id    TEXT NOT NULL,
                field_path   TEXT NOT NULL,
                owner_kind   TEXT NOT NULL,
                explicit_lock INTEGER NOT NULL DEFAULT 0,
                version      INTEGER NOT NULL DEFAULT 0,
                updated_at   TEXT NOT NULL,
                PRIMARY KEY(project_id, entity_kind, entity_id, field_path)
             );
             INSERT INTO narrative_field_authority
                VALUES ('proj-1', 'codex-entry', 'entry-1', '/name', 'human', 0, 1,
                        '2026-08-15T00:00:00.000Z');
             CREATE TABLE narrative_application_contributions (
                id                     TEXT PRIMARY KEY,
                project_id             TEXT NOT NULL,
                application_id         TEXT NOT NULL,
                target_object_identity TEXT NOT NULL,
                field_path             TEXT NOT NULL,
                target_state           TEXT NOT NULL,
                created_at             TEXT NOT NULL,
                UNIQUE(project_id, application_id, target_object_identity, field_path)
             );
             CREATE TABLE narrative_proposal_applications (
                id          TEXT PRIMARY KEY,
                commit_id   TEXT NOT NULL,
                proposal_id TEXT NOT NULL,
                revision_id TEXT NOT NULL
             );
             INSERT INTO narrative_proposal_applications
                VALUES ('app-1', 'commit-1', 'proposal-1', 'revision-1');
             INSERT INTO narrative_application_contributions
                VALUES ('row-1', 'proj-1', 'app-1', 'codex-entry:entry-1', '/name',
                        'unchanged', '2026-08-15T00:00:00.000Z');
             INSERT INTO narrative_application_contributions
                VALUES ('row-2', 'proj-1', 'app-1', 'codex-entry:entry-1', '/summary',
                        'unchanged', '2026-08-15T00:00:00.000Z');",
        )
        .expect("seed a pre-v29 contributions table");
    }

    #[test]
    fn migrate_application_contributions_v29_takes_provenance_from_the_application() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);

        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("SCHEMA 29 contributions migration");

        let (commit_id, proposal_id, revision_id, operation_id, ownership): (
            String,
            String,
            String,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT commit_id, proposal_id, revision_id, operation_id, maintenance_ownership
                   FROM narrative_application_contributions WHERE id = 'row-1'",
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
            )
            .expect("read the migrated contribution");
        assert_eq!(commit_id, "commit-1");
        assert_eq!(proposal_id, "proposal-1");
        assert_eq!(revision_id, "revision-1");
        assert_eq!(
            operation_id, None,
            "an operation cannot be identified retroactively and must not be invented"
        );
        assert_eq!(
            ownership, "user-owned",
            "the Field Authority ledger already recorded this field as the author's"
        );
    }

    /// The baseline is the sequence of the Application's own canonical apply
    /// event, which is the same number `commit.rs` stores on the live path.
    ///
    /// Writing NULL instead is what made a *pre*-Application human edit read
    /// as a *post*-Application one: the projection admits an event when
    /// `COALESCE(baseline_sequence, -1) < sequence`, and a migrated workspace
    /// has no consumer cursor either, so the first pump replays the whole
    /// history against a lower bound of -1.
    #[test]
    fn migrate_application_contributions_v29_reconstructs_the_baseline_from_the_apply_event() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);

        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("SCHEMA 29 contributions migration");

        let baseline: Option<i64> = conn
            .query_row(
                "SELECT baseline_sequence FROM narrative_application_contributions
                  WHERE id = 'row-1'",
                [],
                |row| row.get(0),
            )
            .expect("read the migrated baseline");
        assert_eq!(baseline, Some(20));
    }

    /// A commit with no canonical apply event predates the Change Feed, so
    /// every Feed event genuinely is later than it. NULL is true there, and
    /// the reconstruction must not invent a sequence to avoid it.
    #[test]
    fn migrate_application_contributions_v29_leaves_the_baseline_null_for_a_pre_feed_commit() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);
        conn.execute("DELETE FROM change_events WHERE entity_id = 'commit-1'", [])
            .expect("remove the canonical apply event");

        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("SCHEMA 29 contributions migration");

        let baseline: Option<i64> = conn
            .query_row(
                "SELECT baseline_sequence FROM narrative_application_contributions
                  WHERE id = 'row-1'",
                [],
                |row| row.get(0),
            )
            .expect("read the migrated baseline");
        assert_eq!(baseline, None);
    }

    /// The re-projection is targeted, not a blanket stamp: `row-2` is a field
    /// nobody claimed and has to survive the migration as `maintained`.
    #[test]
    fn migrate_application_contributions_v29_reprojects_ownership_only_where_the_ledger_says_so() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);

        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("SCHEMA 29 contributions migration");

        let owners: Vec<(String, String)> = conn
            .prepare(
                "SELECT id, maintenance_ownership FROM narrative_application_contributions
                  ORDER BY id ASC",
            )
            .expect("prepare")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert_eq!(
            owners,
            vec![
                ("row-1".to_string(), "user-owned".to_string()),
                ("row-2".to_string(), "maintained".to_string()),
            ]
        );
    }

    /// A workspace whose Field Authority table does not exist yet must still
    /// migrate: the re-projection is a refinement of the rebuild, not a
    /// precondition for it.
    #[test]
    fn migrate_application_contributions_v29_runs_without_a_field_authority_table() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);
        conn.execute_batch("DROP TABLE narrative_field_authority;")
            .expect("drop the ledger");

        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("SCHEMA 29 contributions migration without a ledger");

        let ownership: String = conn
            .query_row(
                "SELECT maintenance_ownership FROM narrative_application_contributions
                  WHERE id = 'row-1'",
                [],
                |row| row.get(0),
            )
            .expect("read ownership");
        assert_eq!(ownership, "maintained");
    }

    /// `application_id` has no foreign key, so a Contribution can outlive its
    /// Application. Provenance cannot be invented for it and dropping the row
    /// would discard attribution history, so the migration stops.
    #[test]
    fn migrate_application_contributions_v29_fails_closed_on_an_orphan() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);
        conn.execute(
            "INSERT INTO narrative_application_contributions
             VALUES ('row-orphan', 'proj-1', 'app-gone', 'codex-entry:entry-2', '/name',
                     'unchanged', '2026-08-15T00:00:00.000Z')",
            [],
        )
        .expect("seed an orphan contribution");

        let error = Database::migrate_narrative_application_contributions_v29(&conn)
            .expect_err("an orphan must stop the migration");
        assert!(
            error.to_string().contains("NEX_CONTRIBUTION_ORPHAN"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn migrate_application_contributions_v29_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        seed_pre_v29_contributions_with_applications(&conn);

        Database::migrate_narrative_application_contributions_v29(&conn).expect("first pass");
        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("second pass must be a no-op");

        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM narrative_application_contributions",
                [],
                |row| row.get(0),
            )
            .expect("count rows");
        assert_eq!(rows, 2);
    }

    #[test]
    fn migrate_application_contributions_v29_is_a_no_op_without_the_table() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        Database::migrate_narrative_application_contributions_v29(&conn)
            .expect("a workspace with no contributions table must migrate cleanly");
    }

    #[test]
    fn migrate_contribution_target_identity_v28_is_a_no_op_without_the_table() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        Database::migrate_narrative_contribution_target_identity_v28(&conn)
            .expect("a workspace with no contributions table must migrate cleanly");
    }

    #[test]
    fn migrate_run_kind_v24_rejects_unrecognized_run_kind() {
        let conn = Connection::open_in_memory().expect("open scratch connection");
        // The realistic post-SCHEMA-23 shape already CHECKs run_kind against
        // the 5-value set, so a genuinely bogus value can never reach this
        // migration through normal SQL. Seed the one shape that legitimately
        // can carry one: an unconstrained column, as SQLite would have it
        // mid-migration (before the CHECK-bearing rebuild lands) or on a
        // hand-recovered database. This exercises the fail-closed guard
        // itself, not a state reachable in an untouched production upgrade.
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('proj-1');
             CREATE TABLE narrative_extraction_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                surface_path_id TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                spec_json TEXT NOT NULL,
                spec_digest TEXT NOT NULL,
                status TEXT NOT NULL,
                coverage_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                run_kind TEXT NOT NULL DEFAULT 'interpretation'
             );
             INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at, run_kind)
             VALUES ('run-1', 'proj-1', 'chronicle.extract', '{}', '{}', 'digest-1', 'completed', 'now', 'bogus-kind');",
        )
        .expect("seed unconstrained run_kind table with a bogus value");

        let error = Database::migrate_run_kind_v24(&conn)
            .expect_err("unrecognized run_kind must fail closed, not silently coerce");
        assert!(
            error.to_string().contains("unrecognized run_kind"),
            "unexpected error: {error:#}"
        );

        // Failing closed must not have left a partial rebuild behind.
        let run_kind: String = conn
            .query_row(
                "SELECT run_kind FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .expect("original row must remain readable");
        assert_eq!(run_kind, "bogus-kind");
    }
}
