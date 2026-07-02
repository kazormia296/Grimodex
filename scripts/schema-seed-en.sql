-- Schema (kept in sync with src-tauri/src/database/migrate.rs migrate()).
-- Loaded and executescript-ed by scripts/seed-sample-en.py (single source).
-- The parity test in src-tauri/src/database/seed_schema_parity.rs machine-checks
-- "seed is a subset of migrate" and DEFAULT equality in CI.
-- INSERT OR IGNORE data-init rows are NOT included here (seed() owns those).
-- This schema is intentionally smaller than schema-seed-ja.sql: the EN sample
-- does not cover chronicle/plot/calendar tables. The Japanese-labelled
-- seed_builtin_codex_types trigger is language-independent in the real schema,
-- and seed() relabels the builtin types to English afterwards (mirroring
-- ensureBuiltinTypes / builtinLabelRelabel for an 'en' project).
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
    id                     TEXT PRIMARY KEY,
    title                  TEXT NOT NULL DEFAULT 'Untitled Project',
    genre                  TEXT,
    pov                    TEXT,
    tense                  TEXT,
    language               TEXT NOT NULL DEFAULT 'ja',
    style_guide            TEXT,
    ai_instructions        TEXT,
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
    sort_order        TEXT NOT NULL DEFAULT 'a0',
    story_time_order  TEXT,
    story_time_label  TEXT,
    pov_character_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
    location_id       TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
    status            TEXT DEFAULT 'outline'
                        CHECK(status IS NULL OR status IN ('outline','draft','complete','revision','final')),
    content              TEXT NOT NULL DEFAULT '{}',
    unplaced_beats_doc   TEXT NOT NULL DEFAULT '[]',
    char_count           INTEGER NOT NULL DEFAULT 0,
    unplaced_beat_preview TEXT,
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
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug          TEXT NOT NULL,
    label         TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '#888888',
    palette_index INTEGER,
    icon          TEXT,
    is_builtin    INTEGER NOT NULL DEFAULT 0,
    sort_order    REAL NOT NULL DEFAULT 0.0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_codex_types_project ON codex_types(project_id);

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
    FOREIGN KEY (project_id, type) REFERENCES codex_types(project_id, slug)
      ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_codex_project ON codex_entries(project_id, type);
CREATE INDEX IF NOT EXISTS idx_codex_name    ON codex_entries(project_id, name);
CREATE INDEX IF NOT EXISTS idx_codex_parent  ON codex_entries(parent_id);
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
CREATE INDEX IF NOT EXISTS idx_codex_tags_project ON codex_tags(project_id);

CREATE TABLE IF NOT EXISTS codex_entry_tags (
    entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_codex_entry_tags_tag ON codex_entry_tags(tag_id);

CREATE TABLE IF NOT EXISTS labels (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    sort_order  REAL NOT NULL DEFAULT 0.0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_labels_project ON labels(project_id);

CREATE TABLE IF NOT EXISTS tree_node_labels (
    node_id  TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_tree_node_labels_label
    ON tree_node_labels(label_id);

CREATE TABLE IF NOT EXISTS codex_detail_definitions (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type_slug          TEXT NOT NULL,
    name               TEXT NOT NULL,
    field_type         TEXT NOT NULL DEFAULT 'text'
                         CHECK(field_type IN ('text', 'dropdown', 'codex_reference')),
    field_config       TEXT,
    sort_order         REAL NOT NULL DEFAULT 0.0,
    include_in_context INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, type_slug, name),
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
CREATE INDEX IF NOT EXISTS idx_codex_detail_values_entry ON codex_detail_values(entry_id);
CREATE INDEX IF NOT EXISTS idx_codex_detail_values_def   ON codex_detail_values(definition_id);

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
CREATE INDEX IF NOT EXISTS idx_snippets_project ON snippets(project_id, created_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_snippet_entry_tags_tag_id ON snippet_entry_tags(tag_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id      TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
    title        TEXT NOT NULL DEFAULT 'New session',
    title_manual INTEGER NOT NULL DEFAULT 0,
    model        TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_node ON chat_sessions(project_id, node_id);

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
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content       TEXT NOT NULL,
    model         TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    duration_ms   INTEGER,
    metadata      TEXT,
    is_starred    INTEGER NOT NULL DEFAULT 0,
    is_summarized INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS chat_summaries (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    summary     TEXT NOT NULL,
    token_count INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_session ON chat_summaries(session_id, created_at);

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
CREATE INDEX IF NOT EXISTS idx_codex_phases_entry  ON codex_entry_phases(entry_id);
CREATE INDEX IF NOT EXISTS idx_codex_phases_anchor ON codex_entry_phases(anchor_node_id);

CREATE TABLE IF NOT EXISTS codex_phase_detail_overrides (
    phase_id      TEXT NOT NULL REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
    value         TEXT,
    PRIMARY KEY (phase_id, definition_id)
);
CREATE INDEX IF NOT EXISTS idx_phase_detail_overrides_phase ON codex_phase_detail_overrides(phase_id);

CREATE TABLE IF NOT EXISTS authorship_spans (
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
    phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
    CHECK (
        (CASE WHEN node_id         IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN codex_entry_id  IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN snippet_id      IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),
    CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_authorship_node    ON authorship_spans(node_id, source);
CREATE INDEX IF NOT EXISTS idx_authorship_codex   ON authorship_spans(codex_entry_id, source);
CREATE INDEX IF NOT EXISTS idx_authorship_snippet ON authorship_spans(snippet_id, source);
CREATE INDEX IF NOT EXISTS idx_authorship_detail  ON authorship_spans(detail_value_id);
CREATE INDEX IF NOT EXISTS idx_authorship_phase
    ON authorship_spans(phase_id)
    WHERE phase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_versions (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    entity_type    TEXT NOT NULL CHECK(entity_type IN ('scene','note','codex_entry','snippet')),
    entity_id      TEXT NOT NULL,
    content        TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    snapshot_type  TEXT NOT NULL DEFAULT 'auto' CHECK(snapshot_type IN ('auto','manual')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_cv_entity ON content_versions(entity_type, entity_id, version_number DESC);

CREATE TABLE IF NOT EXISTS project_snapshots (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_snapshots ON project_snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_snapshot_entries (
    snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    version_id  TEXT NOT NULL REFERENCES content_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (snapshot_id, version_id)
);

-- Structural snapshot tables: see src-tauri/src/database/migrate.rs for the
-- canonical definition. The legacy seed below writes only project_snapshots
-- + project_snapshot_entries (content-only snapshot) so these tables stay
-- empty until the user creates a new snapshot from the app.
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
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (snapshot_id, node_id)
);

CREATE TABLE IF NOT EXISTS project_snapshot_codex_entries (
    snapshot_id      TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    entry_id         TEXT NOT NULL,
    type             TEXT NOT NULL,
    name             TEXT NOT NULL,
    parent_id        TEXT,
    aliases          TEXT,
    excluded_aliases TEXT,
    summary          TEXT,
    icon             TEXT,
    context_mode     TEXT NOT NULL,
    children_budget  TEXT NOT NULL,
    notes            TEXT,
    body_version_id  TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
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

CREATE TABLE IF NOT EXISTS project_snapshot_aux (
    snapshot_id  TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, scope)
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_settings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
);

-- Map panel tables
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
CREATE INDEX IF NOT EXISTS idx_map_boards_project ON map_boards(project_id);

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
CREATE INDEX IF NOT EXISTS idx_map_ai_branches_board ON map_ai_branches(board_id);

CREATE TABLE IF NOT EXISTS map_stickies (
    id                     TEXT PRIMARY KEY,
    board_id               TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    title                  TEXT,
    body                   TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
    preview_text           TEXT,
    palette_id             TEXT NOT NULL DEFAULT 'post-it-playful',
    color_slot             INTEGER NOT NULL DEFAULT 0 CHECK(color_slot >= 0),
    ai_branch_id           TEXT REFERENCES map_ai_branches(id) ON DELETE SET NULL,
    source_chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_map_stickies_board     ON map_stickies(board_id);
CREATE INDEX IF NOT EXISTS idx_map_stickies_ai_branch ON map_stickies(ai_branch_id);
CREATE INDEX IF NOT EXISTS idx_map_stickies_chat_msg
    ON map_stickies(source_chat_message_id)
    WHERE source_chat_message_id IS NOT NULL;

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
        (CASE WHEN tree_node_id    IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN codex_entry_id  IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN snippet_id      IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN sticky_id       IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN ai_branch_id    IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),
    CHECK (
        (node_ref_type IN ('scene','note') AND tree_node_id   IS NOT NULL) OR
        (node_ref_type = 'codex'           AND codex_entry_id IS NOT NULL) OR
        (node_ref_type = 'snippet'         AND snippet_id     IS NOT NULL) OR
        (node_ref_type = 'sticky'          AND sticky_id      IS NOT NULL) OR
        (node_ref_type = 'ai_branch'       AND ai_branch_id   IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_map_pos_board  ON map_node_positions(board_id);
CREATE INDEX IF NOT EXISTS idx_map_pos_tree   ON map_node_positions(tree_node_id);
CREATE INDEX IF NOT EXISTS idx_map_pos_codex  ON map_node_positions(codex_entry_id);
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

CREATE TABLE IF NOT EXISTS map_edges (
    id                TEXT PRIMARY KEY,
    board_id          TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    from_position_id  TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
    to_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
    forward_label     TEXT,
    backward_label    TEXT,
    labels            TEXT NOT NULL DEFAULT '[]',
    style             TEXT NOT NULL DEFAULT 'solid' CHECK(style IN ('solid', 'dashed', 'dotted')),
    color             TEXT NOT NULL DEFAULT '#000000',
    direction         TEXT NOT NULL DEFAULT 'none' CHECK(direction IN ('none', 'forward', 'bidirectional')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_map_edges_board ON map_edges(board_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_from  ON map_edges(from_position_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_to    ON map_edges(to_position_id);

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
CREATE INDEX IF NOT EXISTS idx_map_frames_board ON map_frames(board_id);

-- Lint tables
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
CREATE INDEX IF NOT EXISTS idx_lint_ignored_scene ON lint_ignored_diagnostics(scene_id);
CREATE INDEX IF NOT EXISTS idx_lint_ignored_rule  ON lint_ignored_diagnostics(rule_id);

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
CREATE INDEX IF NOT EXISTS idx_lint_term_dict_preferred ON lint_term_dictionary(preferred);
CREATE INDEX IF NOT EXISTS idx_lint_term_dict_sort      ON lint_term_dictionary(sort_order);

CREATE TABLE IF NOT EXISTS lint_action_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id     TEXT NOT NULL,
    action      TEXT NOT NULL,
    scene_id    TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
    occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lint_action_log_rule     ON lint_action_log(rule_id);
CREATE INDEX IF NOT EXISTS idx_lint_action_log_occurred ON lint_action_log(occurred_at);

-- Foreshadow register
CREATE TABLE IF NOT EXISTS foreshadows (
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
    ON foreshadow_codex_links(codex_entry_id);

-- Beat system Phase B: role-aware codex mention cache per scene
CREATE TABLE IF NOT EXISTS scene_codex_mentions (
    scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'mentioned',
    PRIMARY KEY (scene_id, codex_entry_id, source)
);
CREATE INDEX IF NOT EXISTS idx_scm_codex ON scene_codex_mentions(codex_entry_id);
CREATE INDEX IF NOT EXISTS idx_scm_scene  ON scene_codex_mentions(scene_id);

-- Grid panel: explicit Scene x Codex pins
CREATE TABLE IF NOT EXISTS scene_codex_pins (
    scene_id   TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    entry_id   TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scene_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_codex_pins_scene ON scene_codex_pins(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_codex_pins_entry ON scene_codex_pins(entry_id);

-- Matrix star display: beat-level POV override cache
CREATE TABLE IF NOT EXISTS scene_beat_pov_cache (
    scene_id          TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    pov_character_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, pov_character_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_beat_pov_scene ON scene_beat_pov_cache(scene_id);

-- Trash bin (physical recycle bin for deleted fragments / structures)
CREATE TABLE IF NOT EXISTS trash_items (
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

-- FTS5 full-text search indexes
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

CREATE TRIGGER IF NOT EXISTS codex_fts_ai AFTER INSERT ON codex_entries BEGIN
    INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
    VALUES (new.rowid, COALESCE(new.name,''), COALESCE(new.aliases,''), COALESCE(new.summary,''), COALESCE(new.tags_cache,''));
END;
CREATE TRIGGER IF NOT EXISTS codex_fts_ad AFTER DELETE ON codex_entries BEGIN
    INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
    VALUES ('delete', old.rowid, COALESCE(old.name,''), COALESCE(old.aliases,''), COALESCE(old.summary,''), COALESCE(old.tags_cache,''));
END;
CREATE TRIGGER IF NOT EXISTS codex_fts_au AFTER UPDATE ON codex_entries
  WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases
    OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache
BEGIN
    INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
    VALUES ('delete', old.rowid, COALESCE(old.name,''), COALESCE(old.aliases,''), COALESCE(old.summary,''), COALESCE(old.tags_cache,''));
    INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
    VALUES (new.rowid, COALESCE(new.name,''), COALESCE(new.aliases,''), COALESCE(new.summary,''), COALESCE(new.tags_cache,''));
END;

CREATE TRIGGER IF NOT EXISTS snippets_fts_ai AFTER INSERT ON snippets BEGIN
    INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache,''));
END;
CREATE TRIGGER IF NOT EXISTS snippets_fts_ad AFTER DELETE ON snippets BEGIN
    INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache,''));
END;
CREATE TRIGGER IF NOT EXISTS snippets_fts_au AFTER UPDATE ON snippets
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags_cache IS NOT new.tags_cache
BEGIN
    INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache,''));
    INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache,''));
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
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
    INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_ai AFTER INSERT ON tree_nodes BEGIN
    INSERT INTO tree_nodes_fts(rowid, title, content)
    VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''));
END;
CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_ad AFTER DELETE ON tree_nodes BEGIN
    INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, COALESCE(old.title,''), COALESCE(old.content,''));
END;
CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_au AFTER UPDATE ON tree_nodes
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content
BEGIN
    INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, COALESCE(old.title,''), COALESCE(old.content,''));
    INSERT INTO tree_nodes_fts(rowid, title, content)
    VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''));
END;

-- Snapshot-aware cascade triggers (kept in sync with
-- migrate_cv_triggers_protect_snapshot_versions in src-tauri/src/database/migrate.rs).
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

-- Auto-create builtin Codex types on project creation. Labels are Japanese in
-- the real schema (language-independent); seed() relabels them to English.
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

-- Auto-create a default Map board on project creation
CREATE TRIGGER IF NOT EXISTS seed_default_map_board
AFTER INSERT ON projects BEGIN
    INSERT OR IGNORE INTO map_boards
      (id, project_id, title, sort_order, mode, viewport_x, viewport_y, viewport_zoom, show_config, color_by, created_at, updated_at)
      VALUES (new.id || '-main-board', new.id, 'Main', 0.0, 'free', 0, 0, 1.0, '{}', 'none', datetime('now'), datetime('now'));
END;
