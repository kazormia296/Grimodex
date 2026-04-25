#!/usr/bin/env python3
"""
日本語サンプルワークスペース「朱の記憶」を生成するスクリプト。

Usage:
    python3 scripts/seed-sample-ja.py [output_dir]

output_dir のデフォルトは ./samples/akane-no-kioku/
生成後、そのディレクトリを Grimodex でワークスペースとして開いてください。
"""

import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

def ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def uid() -> str:
    return str(uuid.uuid4())


def para(text: str) -> dict:
    if not text.strip():
        return {"type": "paragraph"}
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def heading(level: int, text: str) -> dict:
    return {
        "type": "heading",
        "attrs": {"level": level},
        "content": [{"type": "text", "text": text}],
    }


def doc_nodes(*nodes) -> str:
    return json.dumps({"type": "doc", "content": list(nodes)})


# ---------------------------------------------------------------------------
# スキーマ（src-tauri/src/database.rs の migrate() に同期）
# INSERT OR IGNORE のデータ初期化行は含めない（seed()で担う）
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
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
CREATE TABLE IF NOT EXISTS map_ai_nodes (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    prompt      TEXT NOT NULL,
    response    TEXT,
    session_id  TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
    model       TEXT,
    token_usage INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_map_ai_board ON map_ai_nodes(board_id);

CREATE TABLE IF NOT EXISTS map_boards (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'Main',
    sort_order  REAL NOT NULL DEFAULT 0.0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_map_boards_project ON map_boards(project_id);

CREATE TABLE IF NOT EXISTS map_node_positions (
    id              TEXT PRIMARY KEY,
    board_id        TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    node_ref_type   TEXT NOT NULL CHECK(node_ref_type IN ('scene', 'codex', 'note', 'ai')),
    tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
    codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
    ai_node_id      TEXT REFERENCES map_ai_nodes(id) ON DELETE CASCADE,
    x               REAL NOT NULL,
    y               REAL NOT NULL,
    pinned          INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    z_index         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
        (CASE WHEN tree_node_id    IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN codex_entry_id  IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN ai_node_id      IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),
    CHECK (
        (node_ref_type IN ('scene', 'note') AND tree_node_id   IS NOT NULL AND codex_entry_id IS NULL     AND ai_node_id IS NULL) OR
        (node_ref_type = 'codex'            AND codex_entry_id IS NOT NULL AND tree_node_id   IS NULL     AND ai_node_id IS NULL) OR
        (node_ref_type = 'ai'               AND ai_node_id     IS NOT NULL AND tree_node_id   IS NULL AND codex_entry_id IS NULL)
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_pos_uniq_ai
    ON map_node_positions(board_id, ai_node_id)
    WHERE ai_node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS map_edges (
    id                TEXT PRIMARY KEY,
    board_id          TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    from_position_id  TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
    to_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
    label             TEXT,
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

-- FTS5 全文検索インデックス
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

-- プロジェクト作成時にビルトインCodexタイプを自動生成
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

-- プロジェクト作成時にデフォルトMapボードを自動生成
CREATE TRIGGER IF NOT EXISTS seed_default_map_board
AFTER INSERT ON projects BEGIN
    INSERT OR IGNORE INTO map_boards (id, project_id, title, sort_order, created_at, updated_at)
      VALUES (new.id || '-main-board', new.id, 'Main', 0.0, datetime('now'), datetime('now'));
END;
"""


# ---------------------------------------------------------------------------
# シードデータ
# ---------------------------------------------------------------------------

def seed(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    now = ts()

    # ---- プロジェクト ----
    # INSERT後に seed_builtin_codex_types / seed_default_map_board トリガーが発火し、
    # codex_types と map_boards が自動生成される
    project_id = "default-project"
    conn.execute(
        """INSERT INTO projects
           (id,title,genre,pov,tense,language,style_guide,ai_instructions,phase_resolution_mode,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            project_id,
            "朱の記憶",
            "和風ダークファンタジー",
            "三人称限定視点",
            "過去形",
            "ja",
            "簡潔で鋭い文体を心がける。情景描写は短く、感情は行動と所作で示す。"
            "和語と漢語のバランスに注意し、過剰な修飾を避ける。会話は登場人物の性格を映す鏡にする。",
            "和風ダークファンタジーの執筆補助をしてください。設定の一貫性と登場人物の動機を重視し、"
            "シーンを展開するときは朱音の内面と周囲の空気感を両立させてください。",
            "reading",
            now, now,
        ),
    )

    # ---- Codexタイプ ID（seed_builtin_codex_types トリガーが自動生成済み） ----
    type_ids: dict[str, str] = {
        "character": f"{project_id}-character",
        "location":  f"{project_id}-location",
        "item":      f"{project_id}-item",
        "lore":      f"{project_id}-lore",
    }

    # ---- Codexディテール定義 ----
    def_ids: dict[str, str] = {}
    for type_slug, name, field_type, field_config, sort_order, include in [
        ("character", "役割",   "text",     None, 1.0, 1),
        ("character", "立場",   "dropdown",
         json.dumps({"options": ["主人公", "敵対者", "協力者", "中立"]}),
         2.0, 1),
        ("character", "動機",   "text",     None, 3.0, 0),
        ("location",  "地域",   "text",     None, 1.0, 1),
        ("item",      "状態",   "dropdown",
         json.dumps({"options": ["現存", "紛失", "封印中", "破壊済"]}),
         1.0, 1),
    ]:
        did = uid()
        def_ids[f"{type_slug}.{name}"] = did
        conn.execute(
            """INSERT INTO codex_detail_definitions
               (id,project_id,type_slug,name,field_type,field_config,sort_order,include_in_context,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (did, project_id, type_slug, name, field_type, field_config, sort_order, include, now),
        )

    # ---- Codexタグ ----
    tag_ids: dict[str, str] = {}
    for name, color in [
        ("主人公",   "#5B8CDD"),
        ("敵対者",   "#DD5B5B"),
        ("呪術",     "#9B59B6"),
        ("政治",     "#888888"),
        ("鬼",       "#CC3333"),
    ]:
        tid = uid()
        tag_ids[name] = tid
        conn.execute(
            "INSERT INTO codex_tags (id,project_id,name,color,created_at) VALUES (?,?,?,?,?)",
            (tid, project_id, name, color, now),
        )

    # ---- キャラクター ----
    akane_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            akane_id, project_id, "character", "朱音",
            json.dumps(["あかね", "朱音", "朱紐使い", "紅の娘"]),
            "朱紐を操る一族の最後の生き残り。十年間、都で記録師として生きてきた。"
            "故郷の廃社が燃えたという知らせを受け、十年ぶりに桐野へ帰る。",
            doc_nodes(
                para("朱音は二十代の後半で、十年前から都の記録所に勤めている。仕事は書物の写しと整理で、"
                     "目立たない、誰にでも礼儀正しい、余計なことを言わない——そういう人間として通っている。"),
                para("本当のことを言えば、記憶を封じる一族の末裔で、朱紐と呼ばれる赤い紐を操る力を持っている。"
                     "十年前に故郷を出たとき、その力ごと置いてきたつもりだった。"),
                para("感情を表に出さない。怒るときは静かに怒り、悲しむときは黙って座る。"
                     "笑うのは音羽といるときだけで、それも今は十年前の話だ。"),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (akane_id, now))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (akane_id, tag_ids["主人公"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (akane_id, tag_ids["呪術"]))
    for key, val in [("character.役割", "主人公"), ("character.立場", "主人公"),
                     ("character.動機", "廃社で何が起きたか確かめる。そして十年前の真相を知ること")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), akane_id, def_ids[key], val),
        )

    fuuya_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            fuuya_id, project_id, "character", "冬弥",
            json.dumps(["ふゆや", "冬弥", "冬の陰陽師", "陰陽寮の術師"]),
            "陰陽寮に属する術師。表向きは官僚だが、朱鬼の動向を独自に追っている。"
            "朱音の一族とは十年前から因縁がある。",
            doc_nodes(
                para("冬弥は三十代の前半で、陰陽寮の中堅として通っている。有能で礼儀正しく、"
                     "上司にも同僚にも信頼されている。嘘をつくのが得意だ。"),
                para("実際のところ、冬弥は陰陽寮の公式業務の半分しかやっていない。残りの時間は"
                     "朱鬼に関する調査に使っている。上司も朝廷も知らない。"),
                para("朱音に対しては複雑な感情を持っている。十年前の事件で自分が何をしたか、"
                     "朱音がどこまで知っているか。彼はまだ確かめていない。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (fuuya_id, tag_ids["呪術"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (fuuya_id, tag_ids["政治"]))
    for key, val in [("character.役割", "協力者（疑いあり）"), ("character.立場", "協力者"),
                     ("character.動機", "朱鬼を封じる。朱音が真相に気づく前に手を打つこと")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), fuuya_id, def_ids[key], val),
        )

    shuki_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            shuki_id, project_id, "character", "朱鬼",
            json.dumps(["しゅき", "朱鬼", "記憶喰い", "赤い影", "あの鬼"]),
            "人の記憶を喰らい、その人物に成り代わる鬼。十年前の廃社の火事に関わっている。"
            "現在の居場所は不明。",
            doc_nodes(
                para("朱鬼は名前ではなく、その鬼が何者かを表す言葉だ。記録には「人の記憶を喰らい、"
                     "その皮を被って生きる鬼」とある。何百年も前から各地に出没の記録がある。"),
                para("記憶を喰われた人間は死なない。ただ、自分が何者だったか分からなくなる。"
                     "名前も、家族も、なぜそこに立っているかも。空っぽになって、静かに生き続ける。"),
                para("十年前、朱音の一族が行った朱縄の儀が失敗した夜、廃社が燃えた。"
                     "その火の中に朱鬼がいたかどうか、誰も確かめていない。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (shuki_id, tag_ids["敵対者"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (shuki_id, tag_ids["鬼"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (shuki_id, tag_ids["呪術"]))
    for key, val in [("character.役割", "敵対者"), ("character.立場", "敵対者"),
                     ("character.動機", "不明。記憶を喰うことが目的か、それとも別の何かを求めているのか")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), shuki_id, def_ids[key], val),
        )
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (shuki_id, now))

    otowa_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            otowa_id, project_id, "character", "音羽",
            json.dumps(["おとわ", "音羽", "音羽の娘", "薬師の音羽"]),
            "朱音の幼なじみ。今は桐野で薬師をしている。"
            "十年間、朱音が帰ってくるのを待っていた。待っていたことを本人は認めない。",
            doc_nodes(
                para("音羽は朱音と同い年で、桐野の村で育った。朱音が都に出た後も村に残り、"
                     "今は薬師として一人で暮らしている。"),
                para("明るくて口が立ち、感情を隠さない。十年ぶりに戻ってきた朱音に対して、"
                     "「遅い」とだけ言って、それ以上何も言わなかった。"),
                para("廃社のことを一番よく知っているのは音羽かもしれない。ただ、聞かれなければ話さない。"
                     "聞かれても、全部は話さないかもしれない。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    for key, val in [("character.役割", "協力者"), ("character.立場", "協力者"),
                     ("character.動機", "朱音を守ること。廃社の秘密を守ること。この二つが両立しないとわかっている")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), otowa_id, def_ids[key], val),
        )

    # ---- 場所 ----
    miyako_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            miyako_id, project_id, "location", "都",
            json.dumps(["みやこ", "都", "帝都", "京"]),
            "陰陽寮と朝廷がある政治の中心。表向きは平穏だが、朱鬼の影が近づいている。"
            "朱音が十年間暮らした場所。",
            doc_nodes(
                para("都は大きく、人が多く、誰も互いの顔を覚えない。朱音にはそこが気に入っていた。"
                     "名前を聞かれれば答え、素性を聞かれれば笑ってごまかす。十年間、それで通ってきた。"),
                para("都の東区には記録所があり、朱音はそこで働いている。西区には陰陽寮がある。"
                     "北の大路には朝廷の建物が並んでいるが、朱音はそちらには近づかない。"),
                para("最近、都では「人が変わった」という噂が増えている。昨日まで知っていた顔が、"
                     "今日は別人のように見える。朱音はその噂を聞いても、特に何も言わなかった。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), miyako_id, def_ids["location.地域"], "中央"),
    )

    onmyoryo_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,parent_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            onmyoryo_id, project_id, miyako_id, "location", "陰陽寮",
            json.dumps(["おんみょうりょう", "陰陽寮", "寮", "術師の寮"]),
            "都にある官営の呪術機関。朱鬼に関する記録を秘密裏に保管している。"
            "冬弥の職場。",
            doc_nodes(
                para("陰陽寮は表向き、天文・暦・呪術に関わる官庁だ。朝廷に助言し、"
                     "祓いを行い、凶事を読む。実務は地味で、華やかさはない。"),
                para("ただし、地下の封書庫には一般に公開されていない記録がある。"
                     "鬼の目撃記録、封じ損ねた事案の報告書、失踪した術師の手記。"
                     "冬弥はその封書庫の鍵を持つ数少ない者の一人だ。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), onmyoryo_id, def_ids["location.地域"], "都・西区"),
    )

    kirino_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            kirino_id, project_id, "location", "桐野",
            json.dumps(["きりの", "桐野", "朱音の故郷", "山の村"]),
            "朱音の故郷の山村。廃社がある。十年前の火事以来、村の人口は減り続けている。",
            doc_nodes(
                para("桐野は都から三日の山道を行った先にある、小さな村だ。杉の木が多く、"
                     "夏でも涼しく、冬は雪が深い。記録所の台帳には百二十戸とあるが、"
                     "今は七十戸ほどしか残っていない。"),
                para("十年前の火事のあと、若い人間から順に村を離れた。残っているのは"
                     "老人と、離れる理由を持たない者と、音羽のように離れたくない者だけだ。"),
                para("村の奥、杉林を抜けた先に廃社がある。今でも村人はそちらには近づかない。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), kirino_id, def_ids["location.地域"], "山間部"),
    )

    haisha_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,parent_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            haisha_id, project_id, kirino_id, "location", "桐野の廃社",
            json.dumps(["廃社", "はいしゃ", "桐野の社", "朱音の廃社", "拝殿", "社"]),
            "朱音の一族が代々守ってきた山中の社。十年前の火事で本殿が焼け、今は誰も参拝しない。"
            "祭壇には朱音が置いていった朱紐が残っていた。",
            doc_nodes(
                para("廃社は桐野の外れ、杉林の奥にある。鳥居は残っているが、苔が生えて、"
                     "石段は半ば崩れている。本殿は十年前の火事で焼けたまま再建されていない。"),
                para("拝殿はかろうじて形を保っている。床板は鳴るが、雨漏りはしていない。"
                     "祭壇の前には、朱音が十年前に置いていった朱紐がある。誰も動かさなかった。"),
                para("廃社の周囲には、何かがいた形跡がある。足跡ではない。もっと曖昧な、"
                     "空気の歪みのようなもの。朱音はそれを感じたが、誰にも言っていない。"),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (haisha_id, now))

    # ---- アイテム ----
    akahimo_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            akahimo_id, project_id, "item", "朱紐",
            json.dumps(["あかひも", "朱紐", "朱の紐", "封じ紐", "赤い紐"]),
            "朱音の一族が代々受け継いできた赤い紐。鬼を縛り、記憶を封じる力がある。"
            "朱音が十年前に廃社の祭壇に置いていったもの。",
            doc_nodes(
                para("朱紐は生きている。そう表現する以外に言いようがない。触れると微かに温かく、"
                     "意思があるように動く。長さは一尺ほどだが、必要に応じて伸びる。"),
                para("鬼に触れさせると、その鬼が持つ記憶を封じることができる。完全に封じるには"
                     "朱縄の儀が必要で、それは一人ではできない。朱音の一族はそのために存在していた。"),
                para("朱音が十年間、朱紐なしで生きてきたことは、自分でも意外だった。"
                     "廃社に戻って手に取ったとき、紐は温かかった。まるで待っていたかのように。"),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (akahimo_id, tag_ids["呪術"]))
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (akahimo_id, now))
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), akahimo_id, def_ids["item.状態"], "現存"),
    )

    fuujibumi_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            fuujibumi_id, project_id, "item", "封じ文",
            json.dumps(["ふうじぶみ", "封じ文", "封書", "あの文"]),
            "廃社の祭壇で朱音が見つけた封書。朱音の名と、朱縄の儀に関わる指示が書かれている。"
            "差出人は不明。",
            doc_nodes(
                para("封じ文は朱紐の下に置かれていた。紙は十年経っても黄ばんでおらず、"
                     "墨も滲んでいない。普通の紙ではない。"),
                para("文面には朱音の名と「帰れ」の二文字、そして朱縄の儀の手順が書かれている。"
                     "手順は朱音が知っているものと少し違う。最後の一行は読めない——"
                     "墨で塗り潰されているのではなく、読もうとすると目が滑る。"),
                para("差出人の名はない。筆跡は見覚えがあるような気がするが、誰のものか思い出せない。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (fuujibumi_id, tag_ids["呪術"]))
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), fuujibumi_id, def_ids["item.状態"], "現存"),
    )

    # ---- 伝承 ----
    akanawa_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            akanawa_id, project_id, "lore", "朱縄の儀",
            json.dumps(["あかなわのぎ", "朱縄の儀", "封じの儀", "儀式"]),
            "朱音の一族が百年以上行ってきた鬼封じの儀式。朱紐を使い、鬼の記憶ごと封じ込める。"
            "最後の完全な儀は十年前に失敗した。",
            doc_nodes(
                para("朱縄の儀は二人で行う。一人が朱紐を持ち、もう一人が詠唱する。"
                     "どちらが欠けても完成しない。朱音の一族はそのため、必ず複数で動いていた。"),
                para("儀が成功すると、朱鬼の記憶は朱紐の中に封じられる。"
                     "封じられた記憶は鬼の力の源でもあるため、鬼はその後、力を失って消える。"),
                para("十年前の儀が失敗したとき、何が起きたか、正確に記録した者はいない。"
                     "生き残りは朱音一人で、彼女は当時まだ詠唱を覚えていなかった。"),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (akanawa_id, tag_ids["呪術"]))
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (akanawa_id, now))

    kioku_mon_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            kioku_mon_id, project_id, "lore", "記憶の門",
            json.dumps(["きおくのもん", "記憶の門", "門", "赤い門"]),
            "朱鬼が記憶を喰うとき開く、目に見えない入口。一度開くと朱縄がなければ閉じられない。"
            "開いたままの門は、周囲の人間の記憶を少しずつ侵食する。",
            doc_nodes(
                para("記憶の門は物理的なものではない。強いて言えば、空気の歪みのようなもので、"
                     "朱紐を持つ者にしか感知できない。朱音はかつて一度だけ、それを見たことがある。"),
                para("門が開いている場所では、人の記憶が「薄く」なる。昨日のことを思い出せない、"
                     "知っているはずの顔が思い出せない——そういう症状が周囲に広がる。"),
                para("桐野の廃社の周囲で、朱音はその薄さを感じた。どのくらい前から開いているか、"
                     "まだわかっていない。"),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (kioku_mon_id, tag_ids["呪術"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (kioku_mon_id, tag_ids["鬼"]))

    # ---- ツリー ----
    # sort_order は fractional-indexing 形式（TEXT）
    part1_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part1_id, project_id, "folder", "第一部：帰還", "a0",
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    scene1_id = uid()
    scene1_content = doc_nodes(
        para("雨の匂いがした。土と腐葉土と、かすかな煙の残滓。"),
        para("朱音は鳥居の手前で立ち止まった。十年ぶりだった。"),
        para("廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれた大きな建物だったが、"
             "今目の前にあるのは、半ば崩れかけた本殿の残骸と、かろうじて形を保った拝殿だけだ。"),
        para("「廃墟だな」"),
        para("誰かに言うつもりではなかった。ただ口をついて出た。"),
        para("拝殿の扉は施錠されていなかった。錠前はあったが、錠前ごと落ちていた。朱音は錠前を拾い上げ、"
             "しばらく眺めてから、元の場所に置いた。今更、役に立たない。"),
        para("中に入ると、床板が鳴った。一歩ごとに。"),
        para("祭壇の前に、何かが置いてあった。"),
        para("赤い紐だった。"),
        para("朱音は動けなかった。十年前にここを出るとき、朱紐を祭壇に置いてきた。"
             "誰かが持ち出さず、ずっとここに置いたままにしていたのだ。あるいは、戻ってきたのか。"),
        para("ゆっくりと手を伸ばした。朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。"),
        para("指が触れた瞬間、記憶が来た。"),
        para("それは朱音自身の記憶ではなかった。"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene1_id, project_id, part1_id, "scene", "一章：廃社",
            "雨の夜、朱音は十年ぶりに故郷の廃社へ帰る。"
            "祭壇には十年前に置いてきた朱紐がそのまま残っていた。触れた瞬間、見知らぬ記憶が流れ込んでくる。",
            "a0", "draft", scene1_content, now, now,
        ),
    )

    scene2_id = uid()
    scene2_content = doc_nodes(
        para("【アウトライン】"),
        para("廃社のシーンの翌朝。朱音は拝殿で目を覚ます。朱紐は手の中にある。"),
        para("ビート1：朱音が受け取った「他人の記憶」の断片を整理しようとする。"
             "映像ではなく、感覚と感情のかけら。誰かが恐怖していた。何かから逃げていた。"),
        para("ビート2：封じ文を見つける。朱紐の下に置かれていた。朱音の名が書かれている。"
             "「帰れ」の二文字と、朱縄の儀の手順。ただし、最後の一行だけ読めない。"),
        para("ビート3：音羽が来る。「やっぱり来たか」と言って、饅頭を差し出す。それだけ。"
             "なぜ朱音が来ると知っていたか、朱音は聞かない。音羽も説明しない。"),
        para("要検討：封じ文の差出人を誰にするか。冬弥？朱音の死んだ母？それとも朱鬼自身？"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene2_id, project_id, part1_id, "scene", "二章：封じ文",
            "廃社で朱紐とともに封じ文を見つける。「帰れ」と書かれた文には、朱縄の儀の手順と、読めない一行。",
            "a1", "outline", scene2_content, now, now,
        ),
    )

    part2_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part2_id, project_id, "folder", "第二部：朱の道", "a1",
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    scene3_id = uid()
    scene3_content = doc_nodes(
        para("【アウトライン — 未執筆】"),
        para("都に戻った朱音が、陰陽寮の術師・冬弥と接触する場面。"),
        para("目的：冬弥というキャラクターを初登場させる。外見は平凡で礼儀正しいが、"
             "どこかおかしい——何かを知っていて、言わないでいる人間の顔をしている。"),
        para("朱音が都に帰ってきた理由を冬弥は既に知っている。それが伏線になる。"),
        para("要決定：冬弥が朱音に接触してくるのか、朱音が冬弥を訪ねるのか。"
             "能動的なのがどちらかで、二人の力関係の最初の印象が変わる。"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene3_id, project_id, part2_id, "scene", "三章：都の夜",
            "都に戻った朱音のもとに陰陽師・冬弥が現れる。彼はなぜか朱音が桐野へ行ったことを知っていた。",
            "a0", "outline", scene3_content, now, now,
        ),
    )

    # 覚書フォルダ（'default-chapter' IDでRustマイグレーションとの重複を防ぐ）
    notes_folder_id = "default-chapter"
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (notes_folder_id, project_id, "folder", "覚書", "z0",
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    research_note_id = uid()
    research_content = doc_nodes(
        heading(2, "調査メモ"),
        para("朱縄の儀について：「縛る」と「封じる」の違いを整理する必要がある。"
             "縛るのは一時的な拘束、封じるのは記憶ごと固定する恒久的な処置。"
             "儀が失敗した場合、縛ったまま封じられない状態になるのか？"),
        para("朱鬼の記録：陰陽寮の封書庫に最古の記録があると仮定。冬弥が鍵を持っているという設定を活かす。"
             "朱鬼が同一個体なのか、同種の鬼が複数いるのかを決める必要がある。今のところ同一個体として書いている。"),
        para("十年前の火事の真相候補：\n"
             "①朱縄の儀が失敗し、朱鬼が逃げた\n"
             "②朱鬼が儀を妨害するために火を起こした\n"
             "③冬弥が関与している（第二部の核心）\n"
             "④朱音の母が意図的に儀を失敗させた（最後の驚き用）"),
        para("TODO：音羽が十年間、廃社の近くに住み続けた理由を確定させる。"
             "朱紐を守るため？朱音が帰ってくるのを待つため？それとも別の目的があるか？"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            research_note_id, project_id, notes_folder_id, "note", "調査メモ",
            "a0", "outline", research_content, now, now,
        ),
    )

    # ---- スニペット ----
    snippet1_id = uid()
    conn.execute(
        """INSERT INTO snippets
           (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            snippet1_id, project_id, "朱紐、再会",
            doc_nodes(
                para("朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。"),
                para("指が触れた瞬間、記憶が来た。朱音自身の記憶ではなかった。"
                     "誰かが走っていた。杉林の中を、夜に、何かから逃げながら。"
                     "恐怖の感触だけが、くっきりと残った。"),
            ),
            "human", scene1_id, 0, now, now,
        ),
    )
    conn.execute("INSERT INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                 (snippet1_id, tag_ids["呪術"]))

    snippet2_id = uid()
    conn.execute(
        """INSERT INTO snippets
           (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            snippet2_id, project_id, "廃社、扉の前",
            doc_nodes(
                para("拝殿の扉は施錠されていなかった。錠前はあったが、錠前ごと落ちていた。"),
                para("朱音は錠前を拾い上げ、しばらく眺めてから、元の場所に置いた。"
                     "誰かがここに入った。あるいは、何かがここから出た。どちらにしても、"
                     "鍵は最初から意味をなしていなかった。"),
            ),
            "human", scene1_id, 0, now, now,
        ),
    )
    conn.execute("INSERT INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                 (snippet2_id, tag_ids["主人公"]))

    # ---- チャットセッション ----
    session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            session_id, project_id, scene1_id,
            "朱音の語り口について",
            1,
            "openrouter/anthropic/claude-sonnet-4.6",
            now, now,
        ),
    )
    for role, content in [
        ("user",
         "一章の冒頭を書いたのですが、朱音の語り口がまだ定まっていません。"
         "彼女は感情を抑える人間なので、地の文でも感情が直接出てこないようにしたいです。"
         "「廃社に戻って怖かった」ではなく、行動や描写でそれを示す書き方の例を一段落書いてもらえますか？"),
        ("assistant",
         "こういう方向はいかがでしょう。\n\n"
         "鳥居をくぐるとき、朱音は一度だけ足を止めた。止まった理由を自分では説明できなかった。"
         "草の匂いがした。杉の木が揺れた。それだけのことで、先に進めなくなった。"
         "彼女は三つ数えてから、また歩き始めた。\n\n"
         "感情の名前（「怖い」「不安」）を出さずに、「三つ数えてから」という行動で"
         "内面の動揺を示す方法です。朱音が自分を律する人間だという性格も同時に出せます。"),
        ("user",
         "「三つ数えてから」いいですね。引き継ぎます。"
         "この段落をスニペットとして保存したいです。"),
        ("assistant",
         "了解しました。「朱音の律し方」あたりのタイトルで保存するのが使いやすいと思います。"
         "朱音が感情的に圧迫されたときに毎回この癖が出るようにすると、"
         "読者に彼女の状態のバロメーターとして機能するようになります。"),
    ]:
        conn.execute(
            "INSERT INTO chat_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)",
            (uid(), session_id, role, content, now),
        )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def main() -> None:
    output_dir = (
        Path(sys.argv[1]) if len(sys.argv) > 1 else Path("samples/akane-no-kioku")
    )

    if output_dir.exists() and (output_dir / "grimodex.db").exists():
        print(f"エラー: {output_dir / 'grimodex.db'} は既に存在します。"
              f"別のパスを指定するか、既存ファイルを削除してください。")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    meta_dir = output_dir / ".grimodex"
    meta_dir.mkdir(exist_ok=True)
    (meta_dir / "workspace.json").write_text(
        json.dumps({"id": str(uuid.uuid4()), "created_at": ts()}, indent=2)
    )

    db_path = output_dir / "grimodex.db"
    seed(db_path)

    print(f"サンプルワークスペースを生成しました: {output_dir.resolve()}")
    print("Grimodex でこのディレクトリをワークスペースとして開いてください。")


if __name__ == "__main__":
    main()
