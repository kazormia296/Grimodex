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


def ts_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


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
    return json.dumps({"type": "doc", "content": list(nodes)}, ensure_ascii=False)


# 伏線マーク付きの段落構築ヘルパー。
# segments は str（プレーンテキスト）または (key, text, mark_dict) の3要素タプル。
# 構築時に ProseMirror の絶対位置（fromPos/toPos）を spans 辞書に記録する。
class _DocBuilder:
    def __init__(self) -> None:
        self.pos = 0  # トップレベル位置カーソル
        self.content: list[dict] = []
        self.spans: dict[str, tuple[int, int]] = {}
        # 段落ごとのテキスト範囲（authorship_spans 用に段落単位で参照したいケース向け）
        self.paras: list[tuple[int, int]] = []

    def para(self, *segments) -> "_DocBuilder":
        if not segments:
            self.content.append({"type": "paragraph"})
            self.paras.append((self.pos + 1, self.pos + 1))
            self.pos += 2
            return self
        text_pos = self.pos + 1  # paragraph 開きノード分 +1
        text_start = text_pos
        children: list[dict] = []
        text_len = 0
        for seg in segments:
            if isinstance(seg, str):
                children.append({"type": "text", "text": seg})
                text_pos += len(seg)
                text_len += len(seg)
            else:
                key, body, mark = seg
                node = {"type": "text", "text": body, "marks": [mark]}
                self.spans[key] = (text_pos, text_pos + len(body))
                text_pos += len(body)
                text_len += len(body)
                children.append(node)
        self.content.append({"type": "paragraph", "content": children})
        self.paras.append((text_start, text_start + text_len))
        self.pos += 2 + text_len
        return self

    def to_json(self) -> str:
        return json.dumps({"type": "doc", "content": self.content}, ensure_ascii=False)


def setup_mark(setup_id: str, foreshadow_id: str) -> dict:
    return {
        "type": "foreshadowSetup",
        "attrs": {"setupId": setup_id, "foreshadowId": foreshadow_id},
    }


def payoff_mark(foreshadow_id: str) -> dict:
    return {
        "type": "foreshadowPayoff",
        "attrs": {"foreshadowId": foreshadow_id},
    }


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

-- 伏線レジスタ
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

-- Beat system Phase B：role-aware codex mention cache per scene
CREATE TABLE IF NOT EXISTS scene_codex_mentions (
    scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'mentioned',
    PRIMARY KEY (scene_id, codex_entry_id, source)
);
CREATE INDEX IF NOT EXISTS idx_scm_codex ON scene_codex_mentions(codex_entry_id);
CREATE INDEX IF NOT EXISTS idx_scm_scene  ON scene_codex_mentions(scene_id);

-- Grid panel：Scene×Codex の明示ピン
CREATE TABLE IF NOT EXISTS scene_codex_pins (
    scene_id   TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    entry_id   TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scene_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_codex_pins_scene ON scene_codex_pins(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_codex_pins_entry ON scene_codex_pins(entry_id);

-- Matrix の ★ 表示用：beat 単位 POV 上書きキャッシュ
CREATE TABLE IF NOT EXISTS scene_beat_pov_cache (
    scene_id          TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    pov_character_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, pov_character_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_beat_pov_scene ON scene_beat_pov_cache(scene_id);

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
         json.dumps({"options": ["主人公", "敵対者", "協力者", "中立"]}, ensure_ascii=False),
         2.0, 1),
        ("character", "動機",   "text",     None, 3.0, 0),
        ("location",  "地域",   "text",     None, 1.0, 1),
        ("item",      "状態",   "dropdown",
         json.dumps({"options": ["現存", "紛失", "封印中", "破壊済"]}, ensure_ascii=False),
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

    # ---- Label（Scene パネル / Grid 用のラベル） ----
    # color はパレットのスロット名（src/lib/labelPalette.ts）を保存し、
    # UI 側で resolveLabelColor() を通して hex に解決する。
    label_ids: dict[str, str] = {}
    for sort_idx, (name, color_slot) in enumerate([
        ("起",         "rose"),
        ("承",         "sky"),
        ("転",         "amber"),
        ("結",         "emerald"),
        ("重要",       "red"),
        ("検討中",     "slate"),
        ("朱鬼登場",   "violet"),
    ]):
        lid = uid()
        label_ids[name] = lid
        conn.execute(
            "INSERT INTO labels (id,project_id,name,color,sort_order,created_at) VALUES (?,?,?,?,?,?)",
            (lid, project_id, name, color_slot, float(sort_idx), now),
        )

    # ---- キャラクター ----
    akane_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            akane_id, project_id, "character", "朱音",
            json.dumps(["あかね", "朱音", "朱紐使い", "紅の娘"], ensure_ascii=False),
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
            json.dumps(["ふゆや", "冬弥", "冬の陰陽師", "陰陽寮の術師"], ensure_ascii=False),
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
            json.dumps(["しゅき", "朱鬼", "記憶喰い", "赤い影", "あの鬼"], ensure_ascii=False),
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
            json.dumps(["おとわ", "音羽", "音羽の娘", "薬師の音羽"], ensure_ascii=False),
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
            json.dumps(["みやこ", "都", "帝都", "京"], ensure_ascii=False),
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
            json.dumps(["おんみょうりょう", "陰陽寮", "寮", "術師の寮"], ensure_ascii=False),
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
            json.dumps(["きりの", "桐野", "朱音の故郷", "山の村"], ensure_ascii=False),
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
            json.dumps(["廃社", "はいしゃ", "桐野の社", "朱音の廃社", "拝殿", "社"], ensure_ascii=False),
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
            json.dumps(["あかひも", "朱紐", "朱の紐", "封じ紐", "赤い紐"], ensure_ascii=False),
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
            json.dumps(["ふうじぶみ", "封じ文", "封書", "あの文"], ensure_ascii=False),
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
            json.dumps(["あかなわのぎ", "朱縄の儀", "封じの儀", "儀式"], ensure_ascii=False),
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
            json.dumps(["きおくのもん", "記憶の門", "門", "赤い門"], ensure_ascii=False),
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
         json.dumps({"type": "doc", "content": []}, ensure_ascii=False), now, now),
    )

    # 伏線レジスタ用 ID をシーン本文構築前に確定
    fs_himo_id = uid()        # 朱紐の温もり
    fs_kioku_id = uid()       # 他人の記憶
    fs_jouro_id = uid()       # 廃社の侵入者
    fs_voice_id = uid()       # 忘れられた声
    fs_letter_id = uid()      # 封じ文の差出人（planned, setup未配置）
    fs_fuuya_id = uid()       # 冬弥の二重の顔（planned, setup未配置）
    fs_abandoned_id = uid()   # 杉林の足跡（abandoned）
    # デバッグ用追加サンプル（Phase 6 ラベル網羅 + AI評価 + orphan + multi-setup）
    fs_inkyou_id = uid()      # 印形の歪み（supporting × subtle → needs_strengthening）
    fs_kazaguruma_id = uid()  # 風車の音（optional × subtle → seeded、警告サイレンス）

    setup_himo_id = uid()
    setup_kioku_id = uid()
    setup_jouro_id = uid()
    setup_voice_id = uid()
    setup_inkyou_a_id = uid()       # subtle, human
    setup_inkyou_b_id = uid()       # moderate, AI 評価入り
    setup_inkyou_orphan_id = uid()  # is_orphan=1（再アンカー UI デバッグ）
    setup_kazaguruma_id = uid()     # subtle, human

    scene1_id = uid()
    scene1_builder = _DocBuilder()
    scene1_builder.para("雨の匂いがした。土と腐葉土と、かすかな煙の残滓。")
    scene1_builder.para("朱音は鳥居の手前で立ち止まった。十年ぶりだった。")
    scene1_builder.para(
        "廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれた大きな建物だったが、"
        "今目の前にあるのは、半ば崩れかけた本殿の残骸と、かろうじて形を保った拝殿だけだ。"
    )
    scene1_builder.para("「廃墟だな」")
    scene1_builder.para("誰かに言うつもりではなかった。ただ口をついて出た。")
    scene1_builder.para(
        "拝殿の扉は施錠されていなかった。錠前はあったが、",
        ("setup_jouro", "錠前ごと落ちていた",
         setup_mark(setup_jouro_id, fs_jouro_id)),
        "。朱音は錠前を拾い上げ、しばらく眺めてから、元の場所に置いた。今更、役に立たない。",
    )
    scene1_builder.para("中に入ると、床板が鳴った。一歩ごとに。")
    scene1_builder.para("祭壇の前に、何かが置いてあった。")
    scene1_builder.para("赤い紐だった。")
    scene1_builder.para(
        "朱音は動けなかった。十年前にここを出るとき、朱紐を祭壇に置いてきた。"
        "誰かが持ち出さず、ずっとここに置いたままにしていたのだ。あるいは、戻ってきたのか。"
    )
    scene1_builder.para(
        "ゆっくりと手を伸ばした。",
        ("setup_himo", "朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。",
         setup_mark(setup_himo_id, fs_himo_id)),
    )
    scene1_builder.para("指が触れた瞬間、記憶が来た。")
    scene1_builder.para(
        ("setup_kioku", "それは朱音自身の記憶ではなかった。",
         setup_mark(setup_kioku_id, fs_kioku_id)),
    )
    # 余韻の段落群（Phase 6 ラベル網羅 + AI 評価 / multi-setup デバッグ用の伏線埋め込み）
    scene1_builder.para(
        "息を吐いて手を引いた。朱紐を握り直すとき、",
        ("setup_inkyou_a", "結び目の印形が以前と少し違っている",
         setup_mark(setup_inkyou_a_id, fs_inkyou_id)),
        "ように感じた。",
    )
    scene1_builder.para(
        "目を凝らせば、",
        ("setup_inkyou_b", "印は二重に重なっていて、どちらが本物の朱縄式かは判別できなかった",
         setup_mark(setup_inkyou_b_id, fs_inkyou_id)),
        "。",
    )
    scene1_builder.para(
        "風が吹いて、軒先で",
        ("setup_kazaguruma", "十年前にはなかったはずの風車",
         setup_mark(setup_kazaguruma_id, fs_kazaguruma_id)),
        "が小さく鳴った。",
    )
    scene1_content = scene1_builder.to_json()
    scene1_spans = scene1_builder.spans
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene1_id, project_id, part1_id, "scene", "一章：廃社",
            "雨の夜、朱音は十年ぶりに故郷の廃社へ帰る。"
            "祭壇には十年前に置いてきた朱紐がそのまま残っていた。触れた瞬間、見知らぬ記憶が流れ込んでくる。",
            "a0", "a1", "十年後・秋",
            akane_id, haisha_id, "draft", scene1_content, now, now,
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
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene2_id, project_id, part1_id, "scene", "二章：封じ文",
            "廃社で朱紐とともに封じ文を見つける。「帰れ」と書かれた文には、朱縄の儀の手順と、読めない一行。",
            "a1", "a2", "十年後・翌朝",
            akane_id, haisha_id, "outline", scene2_content, now, now,
        ),
    )

    # 回想シーン：読み順は a2（第三話）だが物語時系列では a0（最古）
    # Timeline デバッグ用：読み順 ≠ 時系列順の逆転を確認できる
    scene_flashback_id = uid()
    flashback_builder = _DocBuilder()
    flashback_builder.para("【回想：十年前・夏】")
    flashback_builder.para("社が燃えていた。")
    flashback_builder.para(
        "朱音は拝殿の前に立っていた。何が起きたか、まだわかっていなかった。"
        "炎は本殿を包み、杉の木に燃え移り、夜の山を赤く染めていた。"
    )
    flashback_builder.para(
        "「離れろ」という声がした。誰の声か、朱音は今も思い出せない。"
    )
    flashback_builder.para("朱音は走った。朱紐を手に、ただ走った。")
    flashback_builder.para("振り返ったとき、本殿の屋根が落ちた。")
    flashback_builder.para(
        "あの夜、社の中に何がいたか。朱音は見た。見たはずだ。"
        "だが今は、炎の色と熱と、",
        ("setup_voice", "誰かの叫び声",
         setup_mark(setup_voice_id, fs_voice_id)),
        "しか残っていない。",
    )
    scene_flashback_content = flashback_builder.to_json()
    scene_flashback_spans = flashback_builder.spans
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene_flashback_id, project_id, part1_id, "scene", "回想：十年前の夜",
            "十年前の夏の夜、廃社が燃えた。朱音はその場にいた。"
            "炎の中に何かがいた——だが記憶は断片しか残っていない。",
            "a2", "a0", "十年前・夏の夜",
            akane_id, haisha_id, "outline", scene_flashback_content, now, now,
        ),
    )

    # 間章：fs_jouro_id（廃社の侵入者）を payoff 確定にするための短いシーン。
    # 一章で setup した「錠前ごと落ちていた」侵入の痕跡を、月夜の再訪で確定させる。
    scene_payoff_id = uid()
    payoff_builder = _DocBuilder()
    payoff_builder.para("月が出ていた。朱音はもう一度、拝殿に戻った。")
    payoff_builder.para(
        "祭壇の脇、最初に来たときには気づかなかった場所に、何かが落ちていた。"
        "身を屈めて拾い上げる。古い札の残骸だった。表に薄く朱が残っている。"
    )
    payoff_builder.para(
        "それは十年前、朱音の母が祭壇に下げていた札だった。"
        "火事の前から結ばれていたもので、誰も触れていないはずだった。"
    )
    payoff_builder.para(
        "朱音は札を握ったまま、扉の方を振り返った。",
        ("payoff_jouro",
         "錠前ごと落としたのも、この札を解いたのも、同じ手だった",
         payoff_mark(fs_jouro_id)),
        "。",
    )
    payoff_builder.para(
        "誰かが廃社に出入りしている。十年前の火事のあと、ずっと。"
    )
    scene_payoff_content = payoff_builder.to_json()
    scene_payoff_spans = payoff_builder.spans
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene_payoff_id, project_id, part1_id, "scene", "間章：祭壇の傷",
            "月夜の拝殿で、朱音は十年前から動かされていなかったはずの札の残骸を見つける。"
            "錠前と同じ手が、これも外していた。",
            "a3", "a3", "十年後・夜半",
            akane_id, haisha_id, "draft", scene_payoff_content, now, now,
        ),
    )
    payoff_jouro_from, payoff_jouro_to = scene_payoff_spans["payoff_jouro"]

    part2_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part2_id, project_id, "folder", "第二部：朱の道", "a1",
         json.dumps({"type": "doc", "content": []}, ensure_ascii=False), now, now),
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
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene3_id, project_id, part2_id, "scene", "三章：都の夜",
            "都に戻った朱音のもとに陰陽師・冬弥が現れる。彼はなぜか朱音が桐野へ行ったことを知っていた。",
            "a0", "a3", "十年後・帰京後",
            akane_id, miyako_id, "outline", scene3_content, now, now,
        ),
    )

    # 覚書フォルダ（'default-chapter' IDでRustマイグレーションとの重複を防ぐ）
    notes_folder_id = "default-chapter"
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (notes_folder_id, project_id, "folder", "覚書", "z0",
         json.dumps({"type": "doc", "content": []}, ensure_ascii=False), now, now),
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

    # ---- 伏線レジスタ ----
    fs_now_ms = ts_ms()

    # foreshadow 行
    # payoff_scene_id + payoff_confirmed=1 + setupCount>=1 → "paid"
    # payoff_scene_id + payoff_confirmed=1 + setupCount=0  → "orphan_payoff"
    # abandoned=1 → "abandoned"
    # それ以外は setup の strength で seeded / needs_strengthening / planned に分岐
    foreshadow_rows = [
        # (id, title, intent, notes,
        #  payoff_scene_id, payoff_from_pos, payoff_to_pos,
        #  payoff_confirmed, abandoned, load_bearing)
        # load_bearing: critical / supporting / optional / None
        #   critical × 弱setup → critical_weak（赤警告）
        #   optional × 弱setup → seeded（警告なし）
        #   None/supporting × 弱setup → needs_strengthening（既存挙動）
        (fs_himo_id, "朱紐の温もり",
         "十年経っても朱紐が乾いたままだった事実を、後の章で「朱紐が朱音を待っていた／意思を持つ」設定の伏線として回収する。",
         "scene1 で朱音が触れた瞬間に温かさを感じる描写を強める案あり。",
         None, None, None, 0, 0, "critical"),
        (fs_kioku_id, "他人の記憶",
         "朱紐に触れた瞬間に流れ込む「誰かの恐怖の記憶」が、十年前の儀式の生き残り（朱音の母？）の残留意識であることを後に明かす。",
         "現状はサブテキストとして弱め。setup を強化するか追加 setup を入れるか検討中。",
         None, None, None, 0, 0, "critical"),
        (fs_jouro_id, "廃社の侵入者",
         "拝殿の錠前が落ちていた事実は、十年前の事件以降に朱鬼（あるいは別の誰か）が廃社へ出入りしている証拠として機能させる。",
         "間章「祭壇の傷」で札の残骸とリンクさせて payoff 確定。",
         scene_payoff_id, payoff_jouro_from, payoff_jouro_to, 1, 0, "supporting"),
        (fs_voice_id, "忘れられた声",
         "回想の「叫び声」の主が冬弥であったことを、第二部のクライマックスで明かす。朱音が思い出せない理由は朱鬼の記憶喰いの副作用。",
         "声の正体は冬弥／朱音の母／朱鬼自身の三択で揺れている。",
         None, None, None, 0, 0, "critical"),
        (fs_letter_id, "封じ文の差出人",
         "祭壇の朱紐の下に置かれていた封じ文を書いたのが誰か。最有力候補は冬弥だが、朱音の母の遺書である可能性も残す。",
         "差出人が確定するまで setup を配置しない（先に決めてから書く方針）。",
         None, None, None, 0, 0, None),
        (fs_fuuya_id, "冬弥の二重の顔",
         "冬弥が陰陽寮の公式業務の裏で朱鬼を独自追跡していること、および十年前の火事への関与を、三章で示唆する。",
         "三章を payoff 想定シーンとして仮置き。setup は二章執筆中に逆算して埋める予定。",
         scene3_id, None, None, 1, 0, "supporting"),
        (fs_abandoned_id, "杉林の足跡",
         "廃社周辺の杉林に残された足跡から朱鬼の気配を辿る案。最終的に「朱鬼は足跡を残さない」設定と矛盾するため棄却。",
         "代替として「空気の歪み」描写に置換済み（codex 廃社の本文参照）。",
         None, None, None, 0, 1, "optional"),
        # ── デバッグ用サンプル ─────────────────────────────────────────
        (fs_inkyou_id, "印形の歪み",
         "朱紐の結び目の印形が二重になっている事実から、誰かが朱縄式を独自に書き換えていることを後段で明かす。冬弥または朱鬼のいずれかが介入した証拠として機能させる。",
         "[デバッグ用] supporting × subtle で needs_strengthening を再現する基準ケース。"
         "setup_inkyou_a (subtle/human), setup_inkyou_b (moderate/AI評価) の二段 setup と、"
         "is_orphan=1 の orphan setup を含む（再アンカー UI 確認用）。",
         None, None, None, 0, 0, "supporting"),
        (fs_kazaguruma_id, "風車の音",
         "廃社の軒先の風車が誰かの手で設置されたものだと示唆し、静かな見守り役（音羽の祖父？）の存在を遠回しに伝える。回収時期未定。",
         "[デバッグ用] optional × subtle のサイレンス確認用。anyWeak でも警告は出ず seeded ラベルが選ばれる。",
         None, None, None, 0, 0, "optional"),
    ]
    for (fid, title, intent, notes_text, payoff_scene,
         payoff_from, payoff_to, payoff_conf, abandoned,
         load_bearing) in foreshadow_rows:
        conn.execute(
            """INSERT INTO foreshadows
               (id,project_id,title,intent,notes,payoff_scene_id,
                payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
                load_bearing,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (fid, project_id, title, intent, notes_text, payoff_scene,
             payoff_from, payoff_to, payoff_conf, abandoned,
             load_bearing, fs_now_ms, fs_now_ms),
        )

    # foreshadow_setups（marks のあるシーン本文と位置を一致させる）
    # AI 評価入り setup 用の aiReasoning JSON（careful/casual/skim 三段の persona 評価）
    inkyou_b_ai_reasoning = json.dumps({
        "careful": {
            "strength": "moderate",
            "reasoning": "印形の二重重ねという具体的な描写があり、観察力のある読者なら「朱縄式が改変されている」可能性に気付く。後段の伏線として機能する手がかり。",
        },
        "casual": {
            "strength": "subtle",
            "reasoning": "結び目の印形という細部は、流し読みでは見落とされやすい。気付けるかは読者の集中度次第。",
        },
        "skim": {
            "strength": "subtle",
            "reasoning": "情景描写の一部として埋め込まれており、急いで読むと意識から抜ける。",
        },
    }, ensure_ascii=False)

    setup_rows = [
        # (id, foreshadow_id, scene_id, span_dict, span_key, kind,
        #  strength, ai_strength, ai_reasoning, attribution, ai_rationale,
        #  last_evaluated_at, is_orphan, from_pos_override, to_pos_override)
        # span_key が None のときは from_pos_override / to_pos_override を使う（orphan 用）
        (setup_himo_id, fs_himo_id, scene1_id, scene1_spans, "setup_himo",
         "designated_existing", "moderate", None, None, "human", None,
         None, 0, None, None),
        (setup_kioku_id, fs_kioku_id, scene1_id, scene1_spans, "setup_kioku",
         "designated_existing", "subtle", None, None, "human", None,
         None, 0, None, None),
        (setup_jouro_id, fs_jouro_id, scene1_id, scene1_spans, "setup_jouro",
         "designated_existing", "moderate", None, None, "human", None,
         None, 0, None, None),
        (setup_voice_id, fs_voice_id, scene_flashback_id, scene_flashback_spans,
         "setup_voice", "designated_existing", "overt", None, None, "human", None,
         None, 0, None, None),
        # 印形の歪み: subtle / human
        (setup_inkyou_a_id, fs_inkyou_id, scene1_id, scene1_spans, "setup_inkyou_a",
         "designated_existing", "subtle", None, None, "human", None,
         None, 0, None, None),
        # 印形の歪み: AI 評価入り（strength=null + aiStrength + aiReasoning JSON, attribution=ai）
        (setup_inkyou_b_id, fs_inkyou_id, scene1_id, scene1_spans, "setup_inkyou_b",
         "designated_existing", None, "moderate", inkyou_b_ai_reasoning, "ai",
         "印形の二重重ねは具体的な視覚情報。観察力のある読者には機能する。",
         fs_now_ms, 0, None, None),
        # 印形の歪み: orphan setup（スパンに mark は無く、DB 行のみ。再アンカー UI 用）
        (setup_inkyou_orphan_id, fs_inkyou_id, scene1_id, None, None,
         "designated_existing", "subtle", None, None, "human", None,
         None, 1, 1, 8),
        # 風車の音: subtle / human
        (setup_kazaguruma_id, fs_kazaguruma_id, scene1_id, scene1_spans, "setup_kazaguruma",
         "designated_existing", "subtle", None, None, "human", None,
         None, 0, None, None),
    ]
    for (sid, fid, scene_id, span_dict, span_key, kind,
         strength, ai_strength, ai_reasoning, attribution,
         ai_rationale, last_evaluated_at, is_orphan,
         from_pos_override, to_pos_override) in setup_rows:
        if span_key is not None:
            from_pos, to_pos = span_dict[span_key]
        else:
            from_pos, to_pos = from_pos_override, to_pos_override
        conn.execute(
            """INSERT INTO foreshadow_setups
               (id,foreshadow_id,scene_id,from_pos,to_pos,kind,
                strength,ai_strength,ai_reasoning,attribution,ai_rationale,
                last_evaluated_at,is_orphan,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, fid, scene_id, from_pos, to_pos, kind,
             strength, ai_strength, ai_reasoning, attribution, ai_rationale,
             last_evaluated_at, is_orphan, fs_now_ms, fs_now_ms),
        )

    # foreshadow_codex_links（伏線と関連 Codex を紐付け）
    for fid, codex_id in [
        (fs_himo_id, akahimo_id),
        (fs_himo_id, akane_id),
        (fs_kioku_id, akahimo_id),
        (fs_kioku_id, akane_id),
        (fs_jouro_id, haisha_id),
        (fs_jouro_id, shuki_id),
        (fs_voice_id, fuuya_id),
        (fs_voice_id, akane_id),
        (fs_letter_id, fuujibumi_id),
        (fs_letter_id, akanawa_id),
        (fs_fuuya_id, fuuya_id),
        (fs_fuuya_id, shuki_id),
        (fs_abandoned_id, haisha_id),
        # デバッグ用伏線の Codex リンク
        (fs_inkyou_id, akanawa_id),
        (fs_inkyou_id, akahimo_id),
        (fs_kazaguruma_id, haisha_id),
    ]:
        conn.execute(
            """INSERT INTO foreshadow_codex_links
               (foreshadow_id,codex_entry_id) VALUES (?,?)""",
            (fid, codex_id),
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
    chat_msg_ids: list[str] = []
    chat_messages_seed = [
        ("user",
         "一章の冒頭を書いたのですが、朱音の語り口がまだ定まっていません。"
         "彼女は感情を抑える人間なので、地の文でも感情が直接出てこないようにしたいです。"
         "「廃社に戻って怖かった」ではなく、行動や描写でそれを示す書き方の例を一段落書いてもらえますか？",
         False, True),
        ("assistant",
         "こういう方向はいかがでしょう。\n\n"
         "鳥居をくぐるとき、朱音は一度だけ足を止めた。止まった理由を自分では説明できなかった。"
         "草の匂いがした。杉の木が揺れた。それだけのことで、先に進めなくなった。"
         "彼女は三つ数えてから、また歩き始めた。\n\n"
         "感情の名前（「怖い」「不安」）を出さずに、「三つ数えてから」という行動で"
         "内面の動揺を示す方法です。朱音が自分を律する人間だという性格も同時に出せます。",
         True, True),
        ("user",
         "「三つ数えてから」いいですね。引き継ぎます。"
         "この段落をスニペットとして保存したいです。",
         False, True),
        ("assistant",
         "了解しました。「朱音の律し方」あたりのタイトルで保存するのが使いやすいと思います。"
         "朱音が感情的に圧迫されたときに毎回この癖が出るようにすると、"
         "読者に彼女の状態のバロメーターとして機能するようになります。",
         False, True),
        # 要約後に続いている最近のやり取り（is_summarized=0、最後の assistant は star 済み）
        ("user",
         "ところで、朱音が朱紐に触れる場面の温度感をもう少し具体化したいです。"
         "「乾いていた」だけだとさらりと流れてしまう気がして。",
         False, False),
        ("assistant",
         "案を二つ。\n\n"
         "①触感の比喩を一つ足す：「乾いていた。冬の竈の余熱のように、鈍い温度が指先に残った」。\n"
         "②朱音側の身体反応を一行入れる：「指が震えた。寒さからではなかった」。\n\n"
         "①は朱紐の側、②は朱音の側に焦点が寄ります。お話の重心がどちらにあるかで選び分けてください。",
         True, False),
    ]
    for role, content, is_starred, is_summarized in chat_messages_seed:
        mid = uid()
        chat_msg_ids.append(mid)
        conn.execute(
            "INSERT INTO chat_messages (id,session_id,role,content,is_starred,is_summarized,created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (mid, session_id, role, content,
             1 if is_starred else 0,
             1 if is_summarized else 0,
             now),
        )

    # ---- マップ ----
    # seed_default_map_board トリガーで自動生成済みのボードを使用
    board_id = f"{project_id}-main-board"

    def map_pos_scene(tree_node_id: str, x: float, y: float) -> str:
        pid = uid()
        conn.execute(
            """INSERT INTO map_node_positions
               (id,board_id,node_ref_type,tree_node_id,x,y,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (pid, board_id, "scene", tree_node_id, x, y, now, now),
        )
        return pid

    def map_pos_codex(codex_entry_id: str, x: float, y: float) -> str:
        pid = uid()
        conn.execute(
            """INSERT INTO map_node_positions
               (id,board_id,node_ref_type,codex_entry_id,x,y,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (pid, board_id, "codex", codex_entry_id, x, y, now, now),
        )
        return pid

    def map_edge(from_pos_id: str, to_pos_id: str, label=None,
                 style="solid", color="#888888", direction="none") -> None:
        conn.execute(
            """INSERT INTO map_edges
               (id,board_id,from_position_id,to_position_id,label,style,color,direction,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (uid(), board_id, from_pos_id, to_pos_id, label, style, color, direction, now, now),
        )

    # ノード配置：キャラ列（x≈120）/ 場所・アイテム列（x≈420）/ シーン列（x≈720）
    pos_akane       = map_pos_codex(akane_id,          120.0,  100.0)
    pos_otowa       = map_pos_codex(otowa_id,           120.0,  320.0)
    pos_fuuya       = map_pos_codex(fuuya_id,           120.0,  540.0)
    pos_shuki       = map_pos_codex(shuki_id,           120.0,  760.0)
    pos_haisha      = map_pos_codex(haisha_id,          420.0,  200.0)
    pos_akahimo     = map_pos_codex(akahimo_id,         420.0,  440.0)
    pos_kirino      = map_pos_codex(kirino_id,          420.0,  680.0)
    pos_s_flashback = map_pos_scene(scene_flashback_id, 720.0, -100.0)
    pos_s1          = map_pos_scene(scene1_id,          720.0,  140.0)
    pos_s2          = map_pos_scene(scene2_id,          720.0,  360.0)
    pos_s3          = map_pos_scene(scene3_id,          720.0,  580.0)

    # エッジ：関係性
    map_edge(pos_akane,       pos_haisha,        label="帰還",     style="solid",  color="#534AB7", direction="forward")
    map_edge(pos_akane,       pos_akahimo,       label="所持",     style="solid",  color="#534AB7", direction="forward")
    map_edge(pos_akane,       pos_otowa,         label="幼なじみ", style="dashed", color="#5B8CDD")
    map_edge(pos_akane,       pos_fuuya,         label="因縁",     style="dashed", color="#993C1D")
    map_edge(pos_shuki,       pos_haisha,        label="出現跡",   style="dotted", color="#CC3333")
    map_edge(pos_haisha,      pos_kirino,        label="所在",     style="solid",  color="#0F6E56", direction="forward")
    map_edge(pos_s_flashback, pos_haisha,        label="十年前",   style="dotted", color="#BA7517")
    map_edge(pos_s1,          pos_haisha,        label="舞台",     style="solid",  color="#888888")
    map_edge(pos_s2,          pos_haisha,        label="舞台",     style="solid",  color="#888888")

    # フレーム：第一部のシーン群をまとめる
    conn.execute(
        """INSERT INTO map_frames
           (id,board_id,title,x,y,width,height,background,border_color,z_index,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid(), board_id, "第一部：帰還",
         620.0, -210.0, 280.0, 690.0,
         "#f0f0ff", "#8080cc", -1, now, now),
    )

    # ---- Lint用語辞書 ----
    now_ms = ts_ms()
    for i, (preferred, variants, severity, note) in enumerate([
        ("朱紐",
         ["赤い紐", "朱の紐", "封じ紐"],
         "warning",
         "本作の固有名詞。意図して一般名詞として使う場合は無視してよい"),
        ("廃社",
         ["廃神社", "廃宮", "社跡"],
         "warning",
         "桐野の社の略称として統一する"),
        ("陰陽寮",
         ["陰陽院", "術師の寮", "呪術機関"],
         "warning",
         "機関の正式名称"),
        ("記録所",
         ["記録院", "書庫", "文書所"],
         "info",
         "朱音の職場の名称"),
        ("朱縄の儀",
         ["封じの儀", "封縛の儀"],
         "info",
         "儀式の正式名称。「儀」単体での略称は許容"),
    ]):
        conn.execute(
            """INSERT INTO lint_term_dictionary
               (id,preferred,variants,severity,note,enabled,sort_order,created_at,updated_at)
               VALUES (?,?,?,?,?,1,?,?,?)""",
            (uid(), preferred, json.dumps(variants, ensure_ascii=False),
             severity, note, i, now_ms, now_ms),
        )

    # ---- Lint永続無視サンプル（ja/sentence-length の意図的な長文） ----
    long_sentence = (
        "廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれた大きな建物だったが、"
        "今目の前にあるのは、半ば崩れかけた本殿の残骸と、かろうじて形を保った拝殿だけだ。"
    )
    conn.execute(
        """INSERT INTO lint_ignored_diagnostics
           (id,rule_id,scene_id,text_snippet,context_before,context_after,note,created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            uid(), "ja/sentence-length", scene1_id,
            long_sentence,
            "朱音は鳥居の手前で立ち止まった。十年ぶりだった。",
            "「廃墟だな」",
            "情景描写の長文は意図的",
            now_ms,
        ),
    )

    # ---- Lintアクションログ ----
    for rule_id, action, sid in [
        ("project/term-consistency", "detected",              scene1_id),
        ("project/term-consistency", "fixed",                 scene1_id),
        ("ja/quote-period",          "detected",              scene1_id),
        ("ja/quote-period",          "ignored_once",          scene1_id),
        ("ja/word-repetition",       "detected",              scene2_id),
        ("ja/sentence-length",       "ignored_persistent_set", scene1_id),
    ]:
        conn.execute(
            "INSERT INTO lint_action_log (rule_id,action,scene_id,occurred_at) VALUES (?,?,?,?)",
            (rule_id, action, sid, now_ms),
        )

    # ================================================================
    # デバッグ用追加データ（authorship / phase / version / chat / map 等）
    # ================================================================

    # ---- 既存 codex / snippet を補強（excluded_aliases / notes / source_chat_message_id） ----
    conn.execute(
        "UPDATE codex_entries SET excluded_aliases=?, notes=?, source_chat_message_id=? WHERE id=?",
        (
            json.dumps(["朱（あけ）", "音"], ensure_ascii=False),
            "「朱」を単独で固有名詞として使う場合は除外。\n"
            "「音」は他のキャラ（音羽）の短縮と衝突するため除外。",
            chat_msg_ids[1],
            akane_id,
        ),
    )
    conn.execute(
        "UPDATE snippets SET source_chat_message_id=? WHERE id=?",
        (chat_msg_ids[1], snippet1_id),
    )

    # ---- codex_dismissed_relations ----
    conn.execute(
        "INSERT INTO codex_dismissed_relations (entry_id, dismissed_id) VALUES (?, ?)",
        (akane_id, fuuya_id),
    )

    # ---- context_mode / children_budget の全バリアント網羅 ----
    suppress_lore_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            suppress_lore_id, project_id, "lore", "禁忌の名",
            json.dumps(["きんきのな", "禁忌の名"], ensure_ascii=False),
            "口にすると朱鬼の注意を引くとされる古い名。"
            "[デバッグ用] context_mode=suppress を付けて AI コンテキストへの混入を抑制する典型例。",
            doc_nodes(
                para("作中で読者にだけ匂わせる固有名詞群。"
                     "AI に提示するとプロットの先回り提案を誘発するため、context_mode=suppress で常時封印する。"),
            ),
            "suppress", "compact", now, now,
        ),
    )

    hidden_char_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            hidden_char_id, project_id, "character", "朱音の母（故人）",
            json.dumps(["朱音の母", "母", "亡き母"], ensure_ascii=False),
            "[ネタバレ・デバッグ用] 十年前の儀の真の主導者。"
            "context_mode=hidden で UI に出すが AI には絶対送らない設定の確認用。",
            doc_nodes(
                para("プロットの最終ピース。第三部以降で開示する想定。"
                     "context_mode=hidden で AI には決して見せない。"),
            ),
            "hidden", "compact", now, now,
        ),
    )

    none_budget_loc_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            none_budget_loc_id, project_id, "location", "都・北の大路",
            json.dumps(["北の大路", "大路"], ensure_ascii=False),
            "朝廷の建物が並ぶ通り。[デバッグ用] children_budget=none を確認するためのサンプル。",
            doc_nodes(
                para("舞台に名前は出るが、シーンの中心にはしない。"
                     "children_budget=none で子要素の AI 露出を完全に切る確認用。"),
            ),
            "mentioned", "none", now, now,
        ),
    )

    generous_budget_lore_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            generous_budget_lore_id, project_id, "lore", "朱音の一族",
            json.dumps(["朱音の一族", "朱紐使い", "紅の一族"], ensure_ascii=False),
            "作中で繰り返し参照する基幹設定。"
            "[デバッグ用] children_budget=generous で子要素を多めに渡す動作確認に使う。",
            doc_nodes(
                para("一族にまつわる伝承・系譜・儀式が複数あり、いずれも本筋に絡む。"
                     "context 配信時は子要素を寛容に許可する。"),
            ),
            "mentioned", "generous", now, now,
        ),
    )

    # ---- candidate payoff（payoff_confirmed=0 + payoff_scene_id 設定済み） ----
    fs_candidate_id = uid()
    conn.execute(
        """INSERT INTO foreshadows
           (id,project_id,title,intent,notes,payoff_scene_id,
            payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
            load_bearing,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            fs_candidate_id, project_id,
            "饅頭の包み紙",
            "音羽が差し出す饅頭の包み紙が朱音の母の家紋であることを後段で気付かせる。"
            "[デバッグ用] payoff_confirmed=0 で payoff_scene_id 設定済みの「候補状態」を再現。",
            "二章のビート3で初登場予定。setup を後付けする計画。",
            scene2_id, None, None, 0, 0, "supporting",
            fs_now_ms, fs_now_ms,
        ),
    )
    conn.execute(
        "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id) VALUES (?, ?)",
        (fs_candidate_id, otowa_id),
    )

    # ---- codex_entry_phases / codex_phase_detail_overrides ----
    akane_phase_pre = uid()
    conn.execute(
        """INSERT INTO codex_entry_phases
           (id,entry_id,anchor_node_id,label,summary_override,content_override,context_mode_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            akane_phase_pre, akane_id, None, "帰還前（都での十年）",
            "都の記録師として静かに暮らしていた頃の朱音。朱紐を封印し、自分の力に触れないように生きている。",
            None, "mentioned", now, now,
        ),
    )
    akane_phase_post = uid()
    akane_phase_post_content = doc_nodes(
        para("帰還後の朱音は、感情を抑える癖がより強くなる。動揺するときほど無表情になる。"),
        para("朱紐との接触をきっかけに、他人の記憶が時折流れ込んでくるようになっている。"),
    )
    conn.execute(
        """INSERT INTO codex_entry_phases
           (id,entry_id,anchor_node_id,label,summary_override,content_override,context_mode_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            akane_phase_post, akane_id, scene1_id, "帰還後（廃社で朱紐に再会）",
            "廃社で朱紐に触れて以降の朱音。封じていた力が再び動き始め、十年前の記憶と向き合う段階に入る。",
            akane_phase_post_content, "always", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value) VALUES (?, ?, ?)",
        (
            akane_phase_post, def_ids["character.動機"],
            "朱鬼を封じる。十年前に置き去りにした責任を取ること。",
        ),
    )

    fuuya_phase = uid()
    conn.execute(
        """INSERT INTO codex_entry_phases
           (id,entry_id,anchor_node_id,label,summary_override,content_override,context_mode_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            fuuya_phase, fuuya_id, scene3_id, "三章以降（朱音と再接触）",
            "朱音が都に戻ったことを察知し、独自に行動を始めた段階。",
            None, None, now, now,
        ),
    )

    # ---- authorship_spans ----
    # ProseMirror ドキュメント JSON から各段落のテキスト範囲を抽出
    def _doc_para_ranges(doc_json: str) -> list[tuple[int, int]]:
        doc = json.loads(doc_json)
        pos = 0
        ranges: list[tuple[int, int]] = []
        for node in doc.get("content", []):
            if node.get("type") == "paragraph":
                text_start = pos + 1
                text_len = sum(len(c.get("text", "")) for c in node.get("content", []))
                ranges.append((text_start, text_start + text_len))
                pos += 2 + text_len
            else:
                pos += 2
        return ranges

    # scene1: 段落単位で human / ai / unknown を混在
    scene1_attribution_plan = [
        # (paragraph_index, source, model, chat_msg_id)
        (0,  "human",   None, None),
        (1,  "human",   None, None),
        (2,  "human",   None, None),
        (3,  "ai",      "anthropic/claude-sonnet-4.6", chat_msg_ids[1]),
        (4,  "ai",      "anthropic/claude-sonnet-4.6", chat_msg_ids[1]),
        (5,  "human",   None, None),
        (10, "ai",      "anthropic/claude-sonnet-4.6", chat_msg_ids[5]),
        (11, "ai",      "anthropic/claude-sonnet-4.6", chat_msg_ids[5]),
        (12, "human",   None, None),
        (13, "unknown", None, None),
        (14, "unknown", None, None),
        (15, "human",   None, None),
    ]
    for idx, source, model, msg_id in scene1_attribution_plan:
        if idx >= len(scene1_builder.paras):
            continue
        fp, tp = scene1_builder.paras[idx]
        if fp >= tp:
            continue
        conn.execute(
            """INSERT INTO authorship_spans
               (id,node_id,from_pos,to_pos,source,model,timestamp,chat_msg_id)
               VALUES (?,?,?,?,?,?,?,?)""",
            (uid(), scene1_id, fp, tp, source, model, now, msg_id),
        )

    def _attribute_doc(owner_col: str, owner_id: str, content_text: str,
                       source: str, model: str | None, msg_id: str | None,
                       phase_col_id: str | None = None) -> None:
        for fp, tp in _doc_para_ranges(content_text):
            if fp >= tp:
                continue
            if phase_col_id is None:
                conn.execute(
                    f"INSERT INTO authorship_spans "
                    f"(id,{owner_col},from_pos,to_pos,source,model,timestamp,chat_msg_id) "
                    f"VALUES (?,?,?,?,?,?,?,?)",
                    (uid(), owner_id, fp, tp, source, model, now, msg_id),
                )
            else:
                conn.execute(
                    f"INSERT INTO authorship_spans "
                    f"(id,{owner_col},phase_id,from_pos,to_pos,source,model,timestamp,chat_msg_id) "
                    f"VALUES (?,?,?,?,?,?,?,?,?)",
                    (uid(), owner_id, phase_col_id, fp, tp, source, model, now, msg_id),
                )

    snip1_content_row = conn.execute(
        "SELECT content FROM snippets WHERE id=?", (snippet1_id,)
    ).fetchone()
    _attribute_doc("snippet_id", snippet1_id, snip1_content_row[0],
                   "human", None, chat_msg_ids[1])
    snip2_content_row = conn.execute(
        "SELECT content FROM snippets WHERE id=?", (snippet2_id,)
    ).fetchone()
    _attribute_doc("snippet_id", snippet2_id, snip2_content_row[0],
                   "ai", "anthropic/claude-sonnet-4.6", None)

    akane_doc_row = conn.execute(
        "SELECT content FROM codex_entries WHERE id=?", (akane_id,)
    ).fetchone()
    _attribute_doc("codex_entry_id", akane_id, akane_doc_row[0], "human", None, None)

    # 朱音 codex の「動機」detail_value を AI 由来としてマーク
    motive_row = conn.execute(
        "SELECT id, value FROM codex_detail_values WHERE entry_id=? AND definition_id=?",
        (akane_id, def_ids["character.動機"]),
    ).fetchone()
    if motive_row is not None:
        motive_id, motive_val = motive_row
        conn.execute(
            """INSERT INTO authorship_spans
               (id,detail_value_id,from_pos,to_pos,source,model,timestamp,chat_msg_id)
               VALUES (?,?,?,?,?,?,?,?)""",
            (uid(), motive_id, 0, len(motive_val or ""),
             "ai", "anthropic/claude-sonnet-4.6", now, chat_msg_ids[1]),
        )

    # phase の content_override 内の AI 編集スパン（phase_id + codex_entry_id 両方必要）
    _attribute_doc("codex_entry_id", akane_id, akane_phase_post_content,
                   "ai", "anthropic/claude-sonnet-4.6", chat_msg_ids[5],
                   phase_col_id=akane_phase_post)

    # ---- content_versions / project_snapshots ----
    scene1_v1_id = uid()
    conn.execute(
        """INSERT INTO content_versions
           (id,entity_type,entity_id,content,version_number,snapshot_type,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (scene1_v1_id, "scene", scene1_id,
         doc_nodes(
             para("【初稿】"),
             para("朱音は鳥居の前で立ち止まった。十年ぶりだった。"),
             para("廃社は思っていたより小さかった。"),
         ),
         1, "auto", now),
    )
    scene1_v2_id = uid()
    conn.execute(
        """INSERT INTO content_versions
           (id,entity_type,entity_id,content,version_number,snapshot_type,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (scene1_v2_id, "scene", scene1_id,
         doc_nodes(
             para("雨の匂いがした。"),
             para("朱音は鳥居の手前で立ち止まった。十年ぶりだった。"),
             para("廃社は思っていたより小さかった。記憶の中では大きな建物だったが、目の前には残骸だけがある。"),
             para("拝殿の扉は錠前ごと落ちていた。"),
         ),
         2, "auto", now),
    )
    scene1_v3_id = uid()
    conn.execute(
        """INSERT INTO content_versions
           (id,entity_type,entity_id,content,version_number,snapshot_type,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (scene1_v3_id, "scene", scene1_id,
         doc_nodes(
             para("雨の匂いがした。土と腐葉土と、かすかな煙の残滓。"),
             para("朱音は鳥居の手前で立ち止まった。十年ぶりだった。"),
             para("拝殿の扉は施錠されていなかった。錠前はあったが、錠前ごと落ちていた。"),
             para("祭壇の前に、赤い紐があった。"),
         ),
         3, "manual", now),
    )

    akane_v1_id = uid()
    conn.execute(
        """INSERT INTO content_versions
           (id,entity_type,entity_id,content,version_number,snapshot_type,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (akane_v1_id, "codex_entry", akane_id,
         doc_nodes(
             para("朱音は二十代後半。都の記録所に勤めて十年。"),
             para("朱紐使いの一族の末裔。だが今はそれを忘れたふりをして生きている。"),
         ),
         1, "auto", now),
    )

    snapshot_id = uid()
    conn.execute(
        """INSERT INTO project_snapshots (id, project_id, name, description, created_at)
           VALUES (?,?,?,?,?)""",
        (snapshot_id, project_id, "第一部・初稿チェックポイント",
         "第一部の初稿が一通り揃ったタイミングのスナップショット。", now),
    )
    for vid in (scene1_v3_id, akane_v1_id):
        conn.execute(
            "INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES (?, ?)",
            (snapshot_id, vid),
        )

    # ---- chat_summaries / chat_summary_messages ----
    summary_id = uid()
    conn.execute(
        """INSERT INTO chat_summaries (id, session_id, summary, token_count, created_at)
           VALUES (?,?,?,?,?)""",
        (summary_id, session_id,
         "朱音の語り口（感情を抑え、行動と所作で内面を示す）について議論。"
         "AI が「三つ数えてから」という所作モチーフを提案し、朱音の状態のバロメーターとして使う方針で合意。",
         220, now),
    )
    for mid in chat_msg_ids[:4]:
        conn.execute(
            "INSERT INTO chat_summary_messages (summary_id, message_id) VALUES (?, ?)",
            (summary_id, mid),
        )

    # ---- chat_session_pinned_codex ----
    conn.execute(
        """INSERT INTO chat_session_pinned_codex
           (id,session_id,codex_entry_id,snippet_id,with_children,pin_source,created_at)
           VALUES (?,?,?,NULL,?,?,?)""",
        (uid(), session_id, akane_id, 1, "manual", now),
    )
    conn.execute(
        """INSERT INTO chat_session_pinned_codex
           (id,session_id,codex_entry_id,snippet_id,with_children,pin_source,created_at)
           VALUES (?,?,NULL,?,?,?,?)""",
        (uid(), session_id, snippet1_id, 0, "chat_mention", now),
    )

    # ---- 追加チャットセッション（空セッション・別シーン紐付け） ----
    empty_session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (empty_session_id, project_id, scene2_id, "新しい会話", 0,
         "openrouter/anthropic/claude-sonnet-4.6", now, now),
    )

    flashback_session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (flashback_session_id, project_id, scene_flashback_id,
         "回想シーンの叫び声の主候補", 1,
         "openrouter/anthropic/claude-sonnet-4.6", now, now),
    )
    for role, text in [
        ("user", "回想で「離れろ」と叫ぶのは誰がいいでしょうか。冬弥/母/朱鬼の三択で揺れています。"),
        ("assistant",
         "三択それぞれに違うテーマが立ちます。\n"
         "・冬弥：『助けたが助けきれなかった』後悔。第二部の主軸になる。\n"
         "・母  ：『最後に守ろうとした』記憶。情緒に寄る。\n"
         "・朱鬼：『記憶を喰う前の警告』。設定のフックが太くなる。\n"
         "迷うなら、いったん冬弥で書いて、二章執筆中の手応えで判断するのが現実的です。"),
    ]:
        conn.execute(
            "INSERT INTO chat_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)",
            (uid(), flashback_session_id, role, text, now),
        )

    # ---- map_ai_nodes と 2 つ目の map board ----
    ai_node_id = uid()
    conn.execute(
        """INSERT INTO map_ai_nodes
           (id,board_id,prompt,response,session_id,model,token_usage,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (ai_node_id, board_id,
         "朱音と冬弥の最初の対峙シーンで、二人のどちらが先に口を開くべき？",
         "朱音から先に口を開かせると緊張の主導権が朱音に渡る。"
         "冬弥から先に口を開かせると朱音の沈黙が読者に重みを持つ。"
         "朱音を『言わない人』として描くなら後者が効く。",
         session_id, "anthropic/claude-sonnet-4.6", 412, now, now),
    )
    pos_ai_id = uid()
    conn.execute(
        """INSERT INTO map_node_positions
           (id,board_id,node_ref_type,ai_node_id,x,y,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (pos_ai_id, board_id, "ai", ai_node_id, 920.0, 580.0, now, now),
    )
    map_edge(pos_ai_id, pos_s3, label="検討", style="dashed", color="#999999")

    board2_id = uid()
    conn.execute(
        """INSERT INTO map_boards (id, project_id, title, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,?,?)""",
        (board2_id, project_id, "タイムライン視覚化", 1.0, now, now),
    )
    for sid_, y in [
        (scene_flashback_id, 0.0),
        (scene1_id, 200.0),
        (scene_payoff_id, 400.0),
        (scene2_id, 600.0),
        (scene3_id, 800.0),
    ]:
        conn.execute(
            """INSERT INTO map_node_positions
               (id,board_id,node_ref_type,tree_node_id,x,y,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (uid(), board2_id, "scene", sid_, 200.0, y, now, now),
        )
    conn.execute(
        """INSERT INTO map_frames
           (id,board_id,title,x,y,width,height,background,border_color,z_index,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid(), board2_id, "物語時系列（読み順とは独立）",
         100.0, -60.0, 280.0, 980.0,
         "#fff8f0", "#ccaa88", -1, now, now),
    )

    # ---- status バリアント網羅用の追加シーン ----
    status_variant_ids: dict[str, str] = {}
    for title, syn, status_, sort, story in [
        ("番外：朱紐の起源（complete）",
         "朱紐がどこから来たかを書いた短い章。完成済みフラグの確認用。",
         "complete", "z1", "前史"),
        ("番外：陰陽寮の地下（revision）",
         "陰陽寮の封書庫を初めて描く章。改稿待ち。",
         "revision", "z2", "十年後・初冬"),
        ("番外：燃えた夜の祝詞（final）",
         "回想で母が唱えていた祝詞の全文。校了済み。",
         "final", "z3", "十年前・夏の夜"),
    ]:
        sid = uid()
        status_variant_ids[status_] = sid
        conn.execute(
            """INSERT INTO tree_nodes
               (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
                pov_character_id,location_id,status,content,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, project_id, notes_folder_id, "scene", title, syn, sort, sort, story,
             akane_id, None, status_,
             doc_nodes(para(f"【{status_} ステータス確認用のサンプル本文】")),
             now, now),
        )

    # ================================================================
    # 新機能サンプル：Beat / Mention / Pin / POV キャッシュ / Label
    # ================================================================

    # ---- Beat ノード（scene2 の outline を実際の placed sceneBeat ブロックに差し替え） ----
    # SceneBeatNode 名は "sceneBeat"、generatedProseBlock は "generatedProseBlock"。
    # Beat は inline*、generated prose は paragraph を内包する block。
    def beat_node(beat_id: str, instr: str, beat_type: str = "free",
                  pov: str | None = None) -> dict:
        return {
            "type": "sceneBeat",
            "attrs": {"id": beat_id, "beatType": beat_type,
                      "pov": pov, "collapsed": False},
            "content": [{"type": "text", "text": instr}],
        }

    def generated_prose_node(beat_id: str, paragraphs: list[str]) -> dict:
        return {
            "type": "generatedProseBlock",
            "attrs": {"beatId": beat_id, "modified": False},
            "content": [
                {"type": "paragraph",
                 "content": [{"type": "text", "text": p}]}
                for p in paragraphs
            ],
        }

    beat_s2_intro_id = uid()
    beat_s2_letter_id = uid()
    beat_s2_otowa_id = uid()
    scene2_doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 2},
             "content": [{"type": "text", "text": "二章：封じ文"}]},
            beat_node(beat_s2_intro_id,
                     "朱音が拝殿で目を覚ます。朱紐は手の中。"
                     "他人の記憶——感覚と感情のかけらだけが残っている。",
                     beat_type="summary", pov=akane_id),
            generated_prose_node(beat_s2_intro_id, [
                "朱音が目を覚ますと、朱紐は手の中にあった。"
                "握りしめた指の隙間から、紐は乾いた温度を伝えていた。",
                "誰かが走っていた。誰かが恐怖していた。"
                "誰、とは特定できない。記憶の輪郭だけが残り、中身は薄い。",
            ]),
            beat_node(beat_s2_letter_id,
                     "封じ文を見つける。朱紐の下。「帰れ」の二文字、朱縄の儀の手順、"
                     "そして読めない最終行。",
                     beat_type="guided", pov=akane_id),
            beat_node(beat_s2_otowa_id,
                     "音羽が来る。「やっぱり来たか」とだけ言って饅頭を差し出す。"
                     "なぜ知っていたかは聞かない。聞けない。",
                     beat_type="dialogue", pov=otowa_id),
        ],
    }
    scene2_content_new = json.dumps(scene2_doc, ensure_ascii=False)
    conn.execute(
        "UPDATE tree_nodes SET content=?, status=? WHERE id=?",
        (scene2_content_new, "draft", scene2_id),
    )

    # ---- Unplaced beats（scene3：未執筆のシーンに beat 案を貯めておく） ----
    # フォーマットは UnplacedBeat[] を JSON 配列で保存（unplacedBeatsStore.ts 参照）
    unplaced_beats_scene3 = [
        {
            "id": uid(),
            "beatType": "summary",
            "pov": akane_id,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "都の宿に戻った朱音。封じ文を懐に抱えたまま夜を越す。"}],
        },
        {
            "id": uid(),
            "beatType": "dialogue",
            "pov": akane_id,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "翌朝、宿の前に冬弥が立っている。"
                                 "「桐野まで行ったそうですね」——彼はなぜか知っている。"}],
        },
        {
            "id": uid(),
            "beatType": "guided",
            "pov": fuuya_id,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "冬弥の内心：朱音が朱紐に再び触れたことを察知している。"
                                 "彼女が真相に気付く前に、彼は何を伝え、何を伏せるか決めねばならない。"}],
        },
        {
            "id": uid(),
            "beatType": "setting",
            "pov": None,
            "collapsed": True,
            "content": [{"type": "text",
                         "text": "舞台：都の朝。霧が低く垂れ、人通りはまだ少ない。"}],
        },
        {
            "id": uid(),
            "beatType": "micro",
            "pov": None,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "朱音の癖：『三つ数えてから』動き出す描写を冒頭に置く。"}],
        },
    ]
    unplaced_beats_doc_scene3 = json.dumps(unplaced_beats_scene3, ensure_ascii=False)
    # preview: 各 beat 先頭 60 文字 × 最大 8 件を JSON 配列で
    preview_scene3 = json.dumps(
        [b["content"][0]["text"][:60] for b in unplaced_beats_scene3],
        ensure_ascii=False,
    )
    conn.execute(
        "UPDATE tree_nodes SET unplaced_beats_doc=?, unplaced_beat_preview=? WHERE id=?",
        (unplaced_beats_doc_scene3, preview_scene3, scene3_id),
    )

    # 番外シーンにも 1 件だけ unplaced beat を入れて Grid プレビューの確認に使う
    bonus_beat = [{
        "id": uid(),
        "beatType": "free",
        "pov": akane_id,
        "collapsed": False,
        "content": [{"type": "text",
                     "text": "封書庫の扉を開く瞬間。冬弥は鍵を捻る前に一度だけ振り返る。"}],
    }]
    conn.execute(
        "UPDATE tree_nodes SET unplaced_beats_doc=?, unplaced_beat_preview=? WHERE id=?",
        (json.dumps(bonus_beat, ensure_ascii=False),
         json.dumps([bonus_beat[0]["content"][0]["text"][:60]], ensure_ascii=False),
         status_variant_ids["revision"]),
    )

    # ---- char_count（本文の text ノードを再帰的に拾って合算） ----
    def _count_doc_chars(doc_json: str) -> int:
        try:
            doc = json.loads(doc_json)
        except json.JSONDecodeError:
            return 0
        total = 0
        # sceneBeat 内のテキストは本文文字数から除外（charCountForBody.ts 準拠）。
        # generatedProseBlock 内は含める。
        def walk(node: dict, in_beat: bool) -> None:
            nonlocal total
            ntype = node.get("type")
            if ntype == "sceneBeat":
                for child in node.get("content", []) or []:
                    walk(child, True)
                return
            if ntype == "text" and not in_beat:
                total += len(node.get("text", ""))
                return
            for child in node.get("content", []) or []:
                walk(child, in_beat)
        walk(doc, False)
        return total

    for sid in (scene1_id, scene2_id, scene3_id,
                scene_flashback_id, scene_payoff_id):
        row = conn.execute("SELECT content FROM tree_nodes WHERE id=?", (sid,)).fetchone()
        if row is not None:
            conn.execute("UPDATE tree_nodes SET char_count=? WHERE id=?",
                         (_count_doc_chars(row[0]), sid))

    # ---- scene_codex_mentions（POV/場所/Beat の混在サンプル） ----
    # source ∈ ('body','beat','relation')、role ∈ ('mentioned','actor','target')
    # source='beat' 行は本文の placed beat に対応するメンションを再現したもの。
    #   現状は beat の text に @メンションマークが入っていないため、本文編集後の
    #   rescan で消える可能性がある（初回起動時の Grid 表示確認用と割り切る）。
    # source='relation' 行は scene_codex_pins とペアで挿入する（pins ループで実装）。
    mentions_rows = [
        # (scene_id, codex_id, source, role)
        # scene1：本文に登場する人物・モノ
        (scene1_id,          akane_id,     "body", "actor"),
        (scene1_id,          haisha_id,    "body", "mentioned"),
        (scene1_id,          akahimo_id,   "body", "target"),
        # scene2：placed beat 由来の mention（source='beat'）
        (scene2_id,          akane_id,     "beat", "actor"),
        (scene2_id,          akahimo_id,   "beat", "target"),
        (scene2_id,          fuujibumi_id, "beat", "target"),
        (scene2_id,          otowa_id,     "beat", "actor"),
        # scene_flashback：朱鬼は target
        (scene_flashback_id, akane_id,     "body", "actor"),
        (scene_flashback_id, shuki_id,     "body", "target"),
        # scene_payoff：札と朱鬼の手がかり
        (scene_payoff_id,    akane_id,     "body", "actor"),
        (scene_payoff_id,    shuki_id,     "body", "target"),
        (scene_payoff_id,    haisha_id,    "body", "mentioned"),
        # scene3：unplaced beat 段階なので beat 由来は意図的に少なめ
        (scene3_id,          akane_id,     "beat", "actor"),
        (scene3_id,          fuuya_id,     "beat", "target"),
    ]
    for sid, cid, src, role in mentions_rows:
        conn.execute(
            "INSERT INTO scene_codex_mentions (scene_id, codex_entry_id, source, role)"
            " VALUES (?,?,?,?)",
            (sid, cid, src, role),
        )

    # ---- scene_codex_pins（Grid パネルで scene に明示ピンしたエントリ） ----
    # ここに入れたものは Grid カードの Codex chip として常時可視になる。
    # 本番の upsertScenePin と同じく、source='relation', role='mentioned' の
    # mention 行も同時に作る（pins と relation-mentions の対応を保つ）。
    pins_rows = [
        (scene2_id, akahimo_id),
        (scene2_id, fuujibumi_id),
        (scene3_id, fuuya_id),
        (scene_payoff_id, akahimo_id),
    ]
    for sid, cid in pins_rows:
        conn.execute(
            "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at) VALUES (?,?,?)",
            (sid, cid, now),
        )
        conn.execute(
            "INSERT OR IGNORE INTO scene_codex_mentions"
            " (scene_id, codex_entry_id, source, role) VALUES (?,?,?,?)",
            (sid, cid, "relation", "mentioned"),
        )

    # ---- scene_beat_pov_cache（Matrix の ★ 表示確認用：beat 単位 POV 上書き） ----
    # scene2 は POV=朱音 だが、音羽 beat があるため音羽もキャッシュに含める。
    # scene3 は POV=朱音 だが、冬弥視点の beat 案があるため冬弥を入れる。
    beat_pov_rows = [
        (scene2_id, otowa_id),
        (scene3_id, fuuya_id),
    ]
    for sid, cid in beat_pov_rows:
        conn.execute(
            "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES (?,?)",
            (sid, cid),
        )

    # ---- tree_node_labels（起承転結 + 状態タグの割り当て） ----
    label_assignments = [
        (scene_flashback_id, ["起"]),
        (scene1_id,          ["起", "重要"]),
        (scene_payoff_id,    ["承", "朱鬼登場"]),
        (scene2_id,          ["承", "検討中"]),
        (scene3_id,          ["転", "検討中"]),
        (status_variant_ids["complete"], ["結"]),
        (status_variant_ids["revision"], ["転", "検討中"]),
        (status_variant_ids["final"],    ["起", "重要"]),
    ]
    for node_id, names in label_assignments:
        for name in names:
            conn.execute(
                "INSERT INTO tree_node_labels (node_id, label_id) VALUES (?,?)",
                (node_id, label_ids[name]),
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
        json.dumps({"id": str(uuid.uuid4()), "created_at": ts()}, indent=2, ensure_ascii=False)
    )

    db_path = output_dir / "grimodex.db"
    seed(db_path)

    print(f"サンプルワークスペースを生成しました: {output_dir.resolve()}")
    print("Grimodex でこのディレクトリをワークスペースとして開いてください。")


if __name__ == "__main__":
    main()
