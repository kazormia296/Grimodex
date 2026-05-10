#!/usr/bin/env python3
"""
日本語サンプルワークスペース「朱の記憶」を生成するスクリプト。

Usage:
    python3 scripts/seed-sample-ja.py [output_dir]

output_dir のデフォルトは ./samples/akane-no-kioku/
生成後、そのディレクトリを Grimodex でワークスペースとして開いてください。
"""

import argparse
import json
import os
import random
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


# Snippet 本文は ProseMirror JSON ではなく HTML を保存する
# （src/features/snippets/SnippetDetailContent.tsx は editor.getHTML() を使う）。
def html_paragraphs(*paragraphs: str) -> str:
    return "".join(f"<p>{p}</p>" for p in paragraphs)


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


# 本文文字数の集計（sceneBeat 内は除外、generatedProseBlock 内は含める）。
# charCountForBody.ts 準拠。
def _count_doc_chars(doc_json: str) -> int:
    try:
        doc = json.loads(doc_json)
    except json.JSONDecodeError:
        return 0
    total = 0

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
CREATE INDEX IF NOT EXISTS idx_map_ai_branches_board ON map_ai_branches(board_id);

-- map_stickies: Map-only ProseMirror memos. (palette_id, color_slot) は
-- src/lib/stickyPalettes.ts のパレット定義に対応する。
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

-- 文屑箱（削除物の物理ゴミ箱）
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
    INSERT OR IGNORE INTO map_boards
      (id, project_id, title, sort_order, mode, viewport_x, viewport_y, viewport_zoom, show_config, color_by, created_at, updated_at)
      VALUES (new.id || '-main-board', new.id, 'Main', 0.0, 'free', 0, 0, 1.0, '{}', 'none', datetime('now'), datetime('now'));
END;
"""


# ---------------------------------------------------------------------------
# パフォーマンス検証用の追加生成（--scale medium）
# ---------------------------------------------------------------------------

# 新規シーン本文を組み立てる段落テンプレート群。
# {char}/{loc}/{item}/{ally}/{enemy} のプレースホルダを置換して使う。
_BULK_PARA_TEMPLATES = [
    "{char}は{loc}の入り口で立ち止まった。冷たい風が頬を撫で、鼻先には湿った土の匂いが届いた。十年前と同じ匂いだった。",
    "あれから多くのことが変わったが、ここの景色はほとんど変わっていない。{loc}の杉が高く伸び、空を細く切り取っている。",
    "「{ally}に会わなければ」と{char}は思った。けれども、その前に確かめたいことがあった。",
    "懐から{item}を取り出した。表面の朱はわずかに剥げていたが、まだ確かに{char}の手の中で温度を持っていた。",
    "「来たね」と背後から声がした。振り返ると、{ally}がそこにいた。なぜここにいるかは聞かなかった。聞いてはいけない気がした。",
    "{enemy}の名前を口にすることは、まだ怖かった。それは呼べば応える名前だったからだ。",
    "{char}は深く息を吸った。三つ数えてから、ゆっくりと吐いた。動悸が落ち着くまで、それを四度繰り返した。",
    "拝殿の床は腐っていなかった。誰かが手を入れている。十年放置されたにしては、不自然なほど整っていた。",
    "「{enemy}は本当にいる」と{ally}は静かに言った。「君が信じるかどうかは別として」。",
    "祭壇の脇に、見覚えのない札が一枚下がっていた。墨の色がまだ新しい。書いたのは昨日か、せいぜい一昨日だ。",
    "{char}は札に手を伸ばしかけて、やめた。触れてしまえば確かめてしまう。確かめてしまえば、引き返せなくなる。",
    "都に帰る道は、来たときと同じはずなのに、なぜか遠く感じた。山の輪郭が記憶よりも険しく、川の音が大きかった。",
    "「{item}を持っていたのか」と{ally}は驚いたように呟いた。「なら、話は早い。十年前の続きをしよう」。",
    "{char}は黙って頷いた。返事はそれだけだった。それで十分だった。",
    "{loc}には人影がなかった。本来なら朝市が立つはずの時間だったが、店も客もいない。空気だけが冷えて漂っていた。",
    "雨が降り始めた。最初は気づかないほどの細い雨だった。やがて{char}の髪を濡らし、{item}の朱を一段濃くした。",
    "「{ally}を信じてもいいのか」と{char}は自問した。答えはまだ出なかった。出ない方がいい気もした。",
    "古い書架の前で{char}は立ち止まった。背表紙の文字は擦れ、半分は読めなかった。それでも一冊だけ、{char}の目を引くものがあった。",
    "「{enemy}の記録は、ここには残っていない」と{ally}は言った。「誰かが消した。それも、ごく最近に」。",
    "{char}は{item}を握り直した。指先が冷たかった。冷たさの中に、わずかな温もりが残っているのを感じた。",
    "{loc}の空は鈍色だった。雲が低く垂れ、遠くで雷の音がした。雨が来るまで、あと半刻もない。",
    "「思い出したか」と{ally}が問うた。{char}は答えなかった。思い出したくないこと、というのが世の中にはある。",
    "夜が更けた。{loc}の灯はすべて消え、聞こえるのは風の音と、自分の鼓動だけだった。",
    "{char}は{item}を懐に戻した。これを使うときが来るかもしれない。来ないことを願いながら、それでも備えておくしかなかった。",
    "「行こう」と{ally}が促した。{char}は最後に一度、{loc}を振り返った。十年ぶりの帰郷は、ここで終わる。終わらせなければならない。",
    "古い火傷の跡が、{char}の手首に残っていた。十年前の夜にできたものだった。痛みはとうに消えているはずなのに、雨の日には今も疼いた。",
    "「{enemy}が来る」と誰かが言った。{char}には、それが誰の声か分からなかった。{ally}でも自分でもない、どこか遠くからの声だった。",
    "扉が軋んだ。{char}は反射的に{item}に手をかけた。けれども、入ってきたのは{ally}だった。「驚かせたか」と{ally}は短く言った。",
    "茶碗が並んでいた。湯気はまだ立っていた。誰かがついさっきまでここで茶を飲んでいた。{char}は息を殺して耳を澄ませた。",
    "「{loc}には触れるな」と{ally}は厳しく言った。「あそこは、まだ封じが効いている。下手に動けば全部崩れる」。",
    "{char}は手を止めた。{ally}の声には、十年前にはなかった種類の重さが含まれていた。",
    "風が止んだ。それまで葉が騒いでいたのに、急にすべてが静まった。{char}は{item}を強く握り直した。何かが来る、と本能が告げていた。",
]

_BULK_BEAT_DESCRIPTIONS = [
    "{char}が{loc}に到達。違和感を覚える。",
    "{ally}との再会。短い会話で十年の空白を埋めようとする。",
    "{item}を取り出して{ally}に見せる。{ally}は驚きを隠せない。",
    "{enemy}に関する手がかりを発見。記録は意図的に消されている。",
    "{char}の内面：思い出したくない記憶が表層に浮かびそうになる。",
    "{loc}の異変を発見。誰かが定期的に手を入れている形跡。",
    "夜半の見張り。風の音と心拍だけが聞こえる。",
]

_BULK_FORESHADOW_TEMPLATES = [
    ("陰陽寮の二重帳簿",
     "陰陽寮が朱鬼に関する記録を二系統で保管している事実を後段で明かす。",
     "[bulk] supporting × moderate"),
    ("{ally}の沈黙の理由",
     "{ally}が十年前の真相を一部知りながら口を閉ざしている動機を、終盤で明かす。",
     "[bulk] critical × overt"),
    ("封書庫の鍵",
     "封書庫の鍵を持つ者が複数いるという事実を後で明かす。",
     "[bulk] supporting × subtle"),
    ("茶碗の湯気",
     "誰もいないはずの場所に湯気の立つ茶碗があった理由を後段で回収。",
     "[bulk] optional × subtle"),
    ("{enemy}の名を呼ぶ声",
     "夢の中で{char}を呼ぶ声の正体を終盤で確定させる。",
     "[bulk] critical × moderate"),
    ("古い火傷",
     "{char}の手首の火傷が十年前の夜と直結する痕跡だと後で示す。",
     "[bulk] supporting × moderate"),
    ("消えた記録",
     "陰陽寮の記録から削除された頁の犯人を中盤で示唆。",
     "[bulk] supporting × subtle"),
    ("封じが弱まる徴", "封じが時間とともに弱まる兆候を散りばめておき、終盤の崩壊で回収。",
     "[bulk] critical × moderate"),
]


def _seed_bulk_content(conn, project_id, now, ctx) -> None:
    """--scale medium 用：章フォルダ4つ・シーン32本ほかを procedural 投入する。"""
    rng = random.Random(0xAEAEBEEF)  # 再現可能性のための固定 seed
    fs_now_ms = ts_ms()

    # 既存の覚書フォルダを末尾に押し出す（新しい部の sort_order が a3..a6）。
    conn.execute(
        "UPDATE tree_nodes SET sort_order=? WHERE id=?",
        ("z0", ctx["notes_folder_id"]),
    )

    # ---- 追加 Codex（character / location / item / lore） ----
    char_type = f"{project_id}-character"
    loc_type = f"{project_id}-location"
    item_type = f"{project_id}-item"
    lore_type = f"{project_id}-lore"

    bulk_chars: list[tuple[str, str, str, str]] = []  # (id, name, summary, content_para)
    bulk_locs: list[tuple[str, str, str]] = []
    bulk_items: list[tuple[str, str, str]] = []
    bulk_lore: list[tuple[str, str, str]] = []

    # tag は ctx["tag_ids"] のキー（"主人公","敵対者","呪術","政治","鬼"）から選ぶ。
    # spec の 3 番目要素は付与する tag 名のリスト（aliases も別名のみ・canonical 名は含めない）。
    tag_ids = ctx["tag_ids"]

    def _attach_tags(entry_id: str, tag_names: list[str]) -> None:
        for tn in tag_names:
            if tn in tag_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO codex_entry_tags (entry_id, tag_id) VALUES (?,?)",
                    (entry_id, tag_ids[tn]),
                )

    char_specs = [
        ("葛原 良衛", ["葛原"], ["政治"],
         "陰陽寮の長老。朱音が都に来た当初から記録所を取り仕切っている。"
         "古い時代の儀礼に通じ、若い世代には冷たく見える。"),
        ("海原 朔",   ["海原", "朔"], ["政治"],
         "朱音の同僚記録師。気のいい男で、書庫の整理は誰よりも早い。"
         "酒癖が悪いのと、口が軽いのが玉に瑕。"),
        ("紫苑",      [], ["呪術"],
         "冬弥の弟子。十六歳。素直で勘がいいが、師の影響を強く受けている。"),
        ("千代",      ["千代婆"], [],
         "音羽の祖母。廃社の近くで一人暮らしをしている老婆。"
         "十年前の火事の夜、何かを見たらしいが、孫にも話していない。"),
        ("玄馬",      ["玄馬の旦那"], [],
         "桐野の山師。山の地理を知り尽くしている。"
         "金次第で誰の依頼でも引き受けるが、廃社の一帯だけは入りたがらない。"),
        ("朱音の母",  ["朱の母", "母"], ["呪術"],
         "故人。十年前の火事の夜に死んだ。朱縄の儀の使い手だったが、"
         "なぜ儀が失敗したのかは誰も知らない。"),
        ("比佐",      ["藤屋の女将"], [],
         "都の宿『藤屋』の女将。朱音が都に来てから世話になっている。"
         "情報通で、誰がどこに泊まっているかをすべて把握している。"),
        ("円明",      ["円明上人"], ["呪術"],
         "古の僧。文献にしか登場しない伝説的人物。"
         "朱鬼を最初に封じた者として記録されている。"),
        ("香",        ["香ちゃん"], [],
         "朱音の幼馴染。廃社の子守唄を覚えている数少ない一人。"
         "今は桐野の隣村に嫁いでいる。"),
        ("久遠",      [], ["敵対者", "呪術"],
         "陰陽寮に最近現れた青年。所属は不明。"
         "葛原の許可を得て封書庫に出入りしているらしい。"),
        ("月足",      ["月足の翁"], ["呪術"],
         "桐野の山に住む元修験者。十年前の火事の現場に最初に駆けつけた一人。"
         "以来、廃社の半里手前から先には立ち入らない。"),
        ("銀次",      ["薬の銀次"], [],
         "都の薬問屋。朱音に時折、夜に薬を届けに来る。"
         "薬以外の物を運ぶこともあるという噂がある。"),
    ]
    for name, aliases, tags, summary in char_specs:
        cid = uid()
        bulk_chars.append((cid, name, summary, ""))
        content = doc_nodes(
            para(summary),
            para(f"{name}についての追加メモ。本文中の登場頻度はまだ低いが、"
                 f"後段の展開で重要な役割を担う想定。"),
            para("[bulk seed: パフォーマンス検証用に追加された Codex エントリ]"),
        )
        conn.execute(
            """INSERT INTO codex_entries
               (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,
                created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (cid, project_id, "character", name,
             json.dumps(aliases, ensure_ascii=False) if aliases else None,
             summary, content, "mentioned", "compact", now, now),
        )
        _attach_tags(cid, tags)

    loc_specs = [
        ("陰陽寮・封書庫", ["政治", "呪術"],
         "陰陽寮の地下にある書庫。封じ関係の文献が収められている。"
         "鍵を持つ者は数えるほどしかいないとされる。"),
        ("陰陽寮・式神房", ["政治"],
         "陰陽寮の式神運用室。若手の術師が当番で詰めている。"),
        ("桐野山道",       [],
         "桐野へ向かう山道。途中で道が二つに分かれ、片方は廃社へ続く。"),
        ("廃社の杉林",     ["呪術"],
         "廃社を取り囲む杉林。樹齢数百年の木が並ぶ。"
         "風通しが悪く、昼でも薄暗い。"),
        ("都の薬問屋",     [],
         "銀次が営む薬問屋。表向きは普通の商い。"
         "夜になると別の客が訪れる。"),
        ("朱音の自宅",     [],
         "都の片隅にある質素な町家。記録所の徒歩圏内。"
         "家具は最低限しか置かれていない。"),
        ("神泉苑",         ["呪術"],
         "都の中心にある古い庭園。水源があり、儀礼に使われることが多い。"),
        ("桐野の墓地",     [],
         "桐野の集落の外れにある古い墓地。朱音の母もここに眠る。"),
    ]
    for name, tags, summary in loc_specs:
        cid = uid()
        bulk_locs.append((cid, name, summary))
        conn.execute(
            """INSERT INTO codex_entries
               (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,
                created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (cid, project_id, "location", name, None, summary,
             doc_nodes(para(summary), para("[bulk seed]")),
             "mentioned", "compact", now, now),
        )
        _attach_tags(cid, tags)

    item_specs = [
        ("朱縄式の写本", ["呪術"],
         "朱縄の儀の手順を記した写本。原本は失われており、写本は数冊しか残っていない。"),
        ("紫光石",       ["呪術"],
         "暗闇でわずかに光る石。封じの触媒に使われる。"),
        ("朱の墨壺",     ["呪術"],
         "朱音の母が遺した墨壺。中身はもう乾いているが、稀に湿る日がある。"),
        ("浄めの塩",     ["呪術"],
         "陰陽寮で常備されている特殊な塩。普通の塩より粒が粗い。"),
        ("朱鬼の爪",     ["呪術", "鬼"],
         "朱鬼が落としたとされる爪の断片。陰陽寮の封書庫に厳重に保管されている。"),
    ]
    for name, tags, summary in item_specs:
        cid = uid()
        bulk_items.append((cid, name, summary))
        conn.execute(
            """INSERT INTO codex_entries
               (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,
                created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (cid, project_id, "item", name, None, summary,
             doc_nodes(para(summary), para("[bulk seed]")),
             "mentioned", "compact", now, now),
        )
        _attach_tags(cid, tags)

    lore_specs = [
        ("陰陽寮の階級",   ["政治"],
         "陰陽寮には五つの階級がある。長老・上座・中座・下座・見習い。"
         "朱音は記録師であり、術師の階級には属さない。"),
        ("鬼門八卦",       ["呪術"],
         "封じの方位を定める古い体系。八方位に対応する印を組み合わせる。"),
        ("封じ詞",         ["呪術"],
         "鬼を封じる際に唱える言葉。流派により伝えられる詞が異なる。"),
        ("朱の一族",       ["呪術"],
         "朱音の家系。代々、朱縄の儀を伝えてきた。"
         "現存する血筋は朱音のみと考えられている。"),
        ("十年前の桐野火災", ["鬼"],
         "朱音の母が死んだ夜に起きた火事。公式には失火扱い。"
         "陰陽寮の内部記録では別の見解がある。"),
    ]
    for name, tags, summary in lore_specs:
        cid = uid()
        bulk_lore.append((cid, name, summary))
        conn.execute(
            """INSERT INTO codex_entries
               (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,
                created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (cid, project_id, "lore", name, None, summary,
             doc_nodes(para(summary), para("[bulk seed]")),
             "mentioned", "compact", now, now),
        )
        _attach_tags(cid, tags)

    # ---- 追加フォルダ（4 部） ----
    parts = [
        ("第三部：陰陽寮の影",   "a3"),
        ("第四部：朱鬼の足跡",   "a4"),
        ("第五部：封書庫の秘",   "a5"),
        ("第六部：朱縄、再び",   "a6"),
    ]
    part_ids: list[str] = []
    for title, sort in parts:
        pid = uid()
        part_ids.append(pid)
        conn.execute(
            """INSERT INTO tree_nodes
               (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
               VALUES (?,?,NULL,?,?,?,?,?,?)""",
            (pid, project_id, "folder", title, sort,
             json.dumps({"type": "doc", "content": []}, ensure_ascii=False),
             now, now),
        )

    # mention 解決用：本文中に登場した名前を追跡するため、
    # (codex_id, name) のペアを集めておく。既存 codex も含める。
    name_to_codex: list[tuple[str, str]] = []
    for cid, name, *_ in bulk_chars:
        name_to_codex.append((name, cid))
    for cid, name, *_ in bulk_locs:
        name_to_codex.append((name, cid))
    for cid, name, *_ in bulk_items:
        name_to_codex.append((name, cid))
    # 既存の主要 codex も検出対象（本文に頻出するため）
    for name, cid in [
        ("朱音", ctx["akane_id"]),
        ("冬弥", ctx["fuuya_id"]),
        ("音羽", ctx["otowa_id"]),
        ("朱鬼", ctx["shuki_id"]),
        ("朱紐", ctx["akahimo_id"]),
        ("廃社", ctx["haisha_id"]),
        ("都",   ctx["miyako_id"]),
    ]:
        name_to_codex.append((name, cid))

    # POV / location 候補
    pov_pool = [ctx["akane_id"], ctx["fuuya_id"], ctx["otowa_id"]] + [
        c[0] for c in bulk_chars[:6]
    ]
    location_pool = [ctx["haisha_id"], ctx["miyako_id"]] + [
        l[0] for l in bulk_locs
    ]
    status_cycle = ["outline", "draft", "draft", "complete", "revision", "final"]
    statuses_distribution = [status_cycle[i % len(status_cycle)] for i in range(32)]

    char_names_for_text = [c[1] for c in bulk_chars] + ["音羽", "冬弥"]
    enemy_names = ["朱鬼"]
    item_names = [it[1] for it in bulk_items] + ["朱紐"]
    loc_names = [l[1] for l in bulk_locs] + ["廃社", "都"]

    bulk_scene_ids: list[str] = []
    bulk_scene_setup_specs: list[dict] = []  # 後段の伏線レジスタで利用

    scene_counter = 0
    for part_idx, part_id in enumerate(part_ids):
        for s_idx in range(8):
            scene_counter += 1
            sid = uid()
            bulk_scene_ids.append(sid)

            char_name = rng.choice(char_names_for_text)
            ally_name = rng.choice([n for n in char_names_for_text if n != char_name])
            enemy_name = rng.choice(enemy_names)
            item_name = rng.choice(item_names)
            loc_name = rng.choice(loc_names)

            builder = _DocBuilder()
            # 1 シーンあたり 55-70 段落 → 約 3,000 字前後（パフォーマンス検証用ボリューム）
            num_paragraphs = rng.randint(55, 70)
            picked: list[str] = []
            while len(picked) < num_paragraphs:
                # 同一テンプレが極端に偏らないよう、テンプレ集をシャッフルした上で順に取り出す
                shuffled = _BULK_PARA_TEMPLATES[:]
                rng.shuffle(shuffled)
                picked.extend(shuffled)
            picked = picked[:num_paragraphs]

            # 1 シーンに最大 1 個 setup マークを差し込む（fs index は後で割当て）
            place_setup = (scene_counter % 3 == 0)  # 約 1/3 のシーンに setup
            place_payoff = (scene_counter % 5 == 0)  # 約 1/5 のシーンに payoff
            setup_para_idx = rng.randint(2, num_paragraphs - 3) if place_setup else -1
            payoff_para_idx = rng.randint(2, num_paragraphs - 3) if place_payoff else -1
            setup_key = f"bulk_setup_{scene_counter}"
            payoff_key = f"bulk_payoff_{scene_counter}"
            # 仮 ID（後で実際の foreshadow_id と setup_id を結びつける）
            tmp_setup_id = uid()
            tmp_foreshadow_for_setup_id = uid()
            tmp_foreshadow_for_payoff_id = uid()

            for p_idx, tpl in enumerate(picked):
                text = tpl.format(
                    char=char_name, ally=ally_name, enemy=enemy_name,
                    item=item_name, loc=loc_name,
                )
                if p_idx == setup_para_idx:
                    # 段落内の任意の位置にマーク付き断片を挟む
                    cut = max(8, len(text) // 2)
                    head, mark_body, tail = text[:cut], text[cut:cut + 12], text[cut + 12:]
                    if not mark_body:
                        mark_body = text[-8:]
                        head, tail = text[: -8], ""
                    builder.para(
                        head,
                        (setup_key, mark_body,
                         setup_mark(tmp_setup_id, tmp_foreshadow_for_setup_id)),
                        tail,
                    )
                elif p_idx == payoff_para_idx:
                    cut = max(8, len(text) // 2)
                    head, mark_body, tail = text[:cut], text[cut:cut + 14], text[cut + 14:]
                    if not mark_body:
                        mark_body = text[-10:]
                        head, tail = text[: -10], ""
                    builder.para(
                        head,
                        (payoff_key, mark_body,
                         payoff_mark(tmp_foreshadow_for_payoff_id)),
                        tail,
                    )
                else:
                    builder.para(text)

            content_json = builder.to_json()
            char_count = _count_doc_chars(content_json)
            status = statuses_distribution[scene_counter - 1]
            pov_id = pov_pool[scene_counter % len(pov_pool)]
            loc_id = location_pool[scene_counter % len(location_pool)]
            scene_title = f"{['三','四','五','六'][part_idx]}章{s_idx + 1}：{loc_name}にて"
            synopsis = (f"{char_name}が{loc_name}を訪れる。"
                        f"{ally_name}との接触と、{item_name}を巡る逡巡。bulk seed。")
            story_time = f"十年後・{['初冬','晩冬','早春','春'][part_idx]}・{s_idx + 1}日目"
            sort_order = f"a{s_idx}"

            conn.execute(
                """INSERT INTO tree_nodes
                   (id,project_id,parent_id,node_type,title,synopsis,sort_order,
                    story_time_order,story_time_label,pov_character_id,location_id,
                    status,content,char_count,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (sid, project_id, part_id, "scene", scene_title, synopsis,
                 sort_order, sort_order, story_time,
                 pov_id, loc_id, status, content_json, char_count, now, now),
            )

            bulk_scene_setup_specs.append({
                "scene_id": sid,
                # テンプレ format() 用の短いキー
                "char": char_name,
                "ally": ally_name,
                "enemy": enemy_name,
                "item": item_name,
                "loc": loc_name,
                # 元ロジック用の長いキーも残す（既存の参照箇所のため）
                "char_name": char_name,
                "ally_name": ally_name,
                "enemy_name": enemy_name,
                "item_name": item_name,
                "loc_name": loc_name,
                "setup_present": place_setup,
                "payoff_present": place_payoff,
                "setup_id": tmp_setup_id,
                "fs_for_setup": tmp_foreshadow_for_setup_id,
                "fs_for_payoff": tmp_foreshadow_for_payoff_id,
                "spans": builder.spans,
                "content_json": content_json,
                "pov_id": pov_id,
            })

            # ---- mentions（本文文字列に名前が出るもの全て） ----
            body_text = "".join(
                seg.get("text", "") for n in json.loads(content_json).get("content", [])
                for seg in (n.get("content") or []) if seg.get("type") == "text"
            )
            seen = set()
            for nm, cid in name_to_codex:
                if cid in seen:
                    continue
                if nm and nm in body_text:
                    role = "actor" if cid == pov_id else "mentioned"
                    conn.execute(
                        "INSERT OR IGNORE INTO scene_codex_mentions"
                        " (scene_id, codex_entry_id, source, role) VALUES (?,?,?,?)",
                        (sid, cid, "body", role),
                    )
                    seen.add(cid)

    # ---- 伏線レジスタ（15 件） ----
    # 構成: 7 confirmed (setup+payoff), 5 planted (setup only), 2 planned, 1 abandoned
    setup_scenes = [s for s in bulk_scene_setup_specs if s["setup_present"]]
    payoff_scenes = [s for s in bulk_scene_setup_specs if s["payoff_present"]]
    rng.shuffle(setup_scenes)
    rng.shuffle(payoff_scenes)

    load_bearing_cycle = ["critical", "supporting", "supporting", "optional"]
    foreshadow_count = 0

    # 7 件: setup + payoff 揃い（confirmed=1）
    n_confirmed = min(7, len(setup_scenes), len(payoff_scenes))
    for i in range(n_confirmed):
        spec_setup = setup_scenes[i]
        spec_payoff = payoff_scenes[i % len(payoff_scenes)]
        title_tpl, intent_tpl, notes_tpl = _BULK_FORESHADOW_TEMPLATES[
            i % len(_BULK_FORESHADOW_TEMPLATES)]
        title = title_tpl.format(**spec_setup)
        intent = intent_tpl.format(**spec_setup)

        # foreshadow 行（実 ID は spec の fs_for_setup を使い、scene 本文のマークと一致させる）
        fs_id = spec_setup["fs_for_setup"]
        # payoff 位置を別シーンの spans から拾う
        spans = spec_payoff["spans"]
        payoff_key = next(
            (k for k in spans if k.startswith("bulk_payoff_")), None
        )
        if payoff_key is None:
            # payoff スパンが見つからない場合は confirmed=0 に降格
            payoff_from = payoff_to = None
            payoff_scene = None
            confirmed = 0
        else:
            payoff_from, payoff_to = spans[payoff_key]
            payoff_scene = spec_payoff["scene_id"]
            # payoff 本文のマーク id を fs_id に書き換える必要がある。
            # 既に挿入済みのため、content_json を再生成して UPDATE する。
            new_content = spec_payoff["content_json"].replace(
                spec_payoff["fs_for_payoff"], fs_id
            )
            conn.execute(
                "UPDATE tree_nodes SET content=? WHERE id=?",
                (new_content, spec_payoff["scene_id"]),
            )
            spec_payoff["content_json"] = new_content
            confirmed = 1
        load_bearing = load_bearing_cycle[foreshadow_count % len(load_bearing_cycle)]
        conn.execute(
            """INSERT INTO foreshadows
               (id,project_id,title,intent,notes,payoff_scene_id,
                payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
                load_bearing,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (fs_id, project_id, title, intent, notes_tpl,
             payoff_scene, payoff_from, payoff_to, confirmed, 0,
             load_bearing, fs_now_ms, fs_now_ms),
        )
        # setup 行
        setup_spans = spec_setup["spans"]
        setup_key = next(
            (k for k in setup_spans if k.startswith("bulk_setup_")), None
        )
        if setup_key is not None:
            from_pos, to_pos = setup_spans[setup_key]
            conn.execute(
                """INSERT INTO foreshadow_setups
                   (id,foreshadow_id,scene_id,from_pos,to_pos,kind,
                    strength,ai_strength,ai_reasoning,attribution,ai_rationale,
                    last_evaluated_at,is_orphan,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (spec_setup["setup_id"], fs_id, spec_setup["scene_id"],
                 from_pos, to_pos, "designated_existing",
                 rng.choice(["subtle", "moderate", "overt"]),
                 None, None, "human", None, None, 0,
                 fs_now_ms, fs_now_ms),
            )
        foreshadow_count += 1

    # 5 件: setup のみ（confirmed=0）
    remaining_setup = setup_scenes[n_confirmed:n_confirmed + 5]
    for i, spec_setup in enumerate(remaining_setup):
        title_tpl, intent_tpl, notes_tpl = _BULK_FORESHADOW_TEMPLATES[
            (i + n_confirmed) % len(_BULK_FORESHADOW_TEMPLATES)]
        title = title_tpl.format(**spec_setup) + "（未回収）"
        intent = intent_tpl.format(**spec_setup)
        fs_id = spec_setup["fs_for_setup"]
        load_bearing = load_bearing_cycle[foreshadow_count % len(load_bearing_cycle)]
        conn.execute(
            """INSERT INTO foreshadows
               (id,project_id,title,intent,notes,payoff_scene_id,
                payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
                load_bearing,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (fs_id, project_id, title, intent, notes_tpl,
             None, None, None, 0, 0,
             load_bearing, fs_now_ms, fs_now_ms),
        )
        setup_spans = spec_setup["spans"]
        setup_key = next(
            (k for k in setup_spans if k.startswith("bulk_setup_")), None
        )
        if setup_key is not None:
            from_pos, to_pos = setup_spans[setup_key]
            conn.execute(
                """INSERT INTO foreshadow_setups
                   (id,foreshadow_id,scene_id,from_pos,to_pos,kind,
                    strength,ai_strength,ai_reasoning,attribution,ai_rationale,
                    last_evaluated_at,is_orphan,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (spec_setup["setup_id"], fs_id, spec_setup["scene_id"],
                 from_pos, to_pos, "designated_existing",
                 rng.choice(["subtle", "moderate"]),
                 None, None, "human", None, None, 0,
                 fs_now_ms, fs_now_ms),
            )
        foreshadow_count += 1

    # 2 件: planned のみ（setup なし、title+intent のみ）
    for i in range(2):
        fs_id = uid()
        title_tpl, intent_tpl, notes_tpl = _BULK_FORESHADOW_TEMPLATES[
            (i + 6) % len(_BULK_FORESHADOW_TEMPLATES)]
        sample_spec = bulk_scene_setup_specs[i]
        title = "[計画] " + title_tpl.format(**sample_spec)
        intent = intent_tpl.format(**sample_spec)
        load_bearing = load_bearing_cycle[foreshadow_count % len(load_bearing_cycle)]
        conn.execute(
            """INSERT INTO foreshadows
               (id,project_id,title,intent,notes,payoff_scene_id,
                payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
                load_bearing,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (fs_id, project_id, title, intent,
             "[bulk seed: planned, setup 未配置]",
             None, None, None, 0, 0,
             load_bearing, fs_now_ms, fs_now_ms),
        )
        foreshadow_count += 1

    # 1 件: abandoned
    fs_id = uid()
    sample_spec = bulk_scene_setup_specs[0]
    conn.execute(
        """INSERT INTO foreshadows
           (id,project_id,title,intent,notes,payoff_scene_id,
            payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
            load_bearing,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (fs_id, project_id, "[撤回] 神泉苑の儀式案",
         "中盤で神泉苑にて儀礼を行う案。整合が取れず撤回。",
         "[bulk seed: abandoned]",
         None, None, None, 0, 1,
         "optional", fs_now_ms, fs_now_ms),
    )

    # ---- 追加チャットセッション ----
    chat_models = [
        "openrouter/anthropic/claude-sonnet-4.6",
        "openrouter/anthropic/claude-sonnet-4.6",
        "openrouter/anthropic/claude-opus-4.6",
        "openrouter/openai/gpt-4o",
    ]
    chat_user_prompts = [
        "このシーンの{char}の語り口を、もう少し抑えた感じに直してもらえますか。",
        "{ally}が{char}を疑い始める瞬間を、台詞ではなく所作で書きたいです。案を二つください。",
        "{loc}の描写を、五感のうち嗅覚と聴覚に寄せて書き直したいです。",
        "{item}を持ち出す動機を、{char}の内面で一段階深掘りしたいです。",
        "ここで{enemy}の名前を出すべきか迷っています。出すなら何章まで温存できますか。",
        "前章との繋がりが弱い気がします。冒頭の三段落で接続を補強したいです。",
    ]
    chat_assistant_replies = [
        "二案を書いてみます。\n\n案A：所作中心。{char}は{item}を握り直したまま、しばらく動かなかった。"
        "「行こう」と声をかけたのは{ally}の方だった。\n\n"
        "案B：内面の濁点を残す。{char}は{item}を握り直した。"
        "握り返してくる感触はなかった。それでよかった、と{char}は思った。",
        "{ally}の疑念は、視線の長さで示すのが自然だと思います。"
        "「{char}を見た時間がいつもより半秒長い」程度の描写を、二度繰り返してください。"
        "三度目に{ally}が口を開く時、読者は既に予感しています。",
        "嗅覚と聴覚に寄せるなら、「{loc}の苔の匂い」「軒の風鈴の鳴らない音」あたりが効きます。"
        "視覚情報を意図的に三段落抜くと、読者は登場人物と同じ感覚で空間を再構成し始めます。",
        "動機の深掘りは、過去の所有経験を一つ挟むのが最短です。"
        "「以前、これと似たものを{char}は誰かに渡した。あれは結局戻ってこなかった」——一行で十分です。",
        "{enemy}の名前は、章末の最後の一語まで温存できます。"
        "そこまでは「あの存在」「呼んではいけない名」の代名詞で通しましょう。",
        "前章との接続は、小道具の再登場が一番安全です。"
        "前章で{char}が触れた{item}の感触を、冒頭で「指がまだ覚えていた」程度に呼び戻してください。",
    ]

    for i in range(8):
        sess_id = uid()
        node_id = bulk_scene_ids[i * 4 % len(bulk_scene_ids)]
        spec = bulk_scene_setup_specs[i * 4 % len(bulk_scene_setup_specs)]
        title = f"{spec['char_name']}視点の調整 #{i + 1}"
        model = chat_models[i % len(chat_models)]
        # 1 セッションだけ長尺に
        n_pairs = 15 if i == 0 else rng.randint(3, 6)
        conn.execute(
            """INSERT INTO chat_sessions
               (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (sess_id, project_id, node_id, title,
             1 if i % 2 == 0 else 0, model, now, now),
        )
        for j in range(n_pairs):
            user_text = chat_user_prompts[j % len(chat_user_prompts)].format(**spec)
            asst_text = chat_assistant_replies[j % len(chat_assistant_replies)].format(**spec)
            uid_msg = uid()
            conn.execute(
                "INSERT INTO chat_messages (id,session_id,role,content,is_starred,is_summarized,created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (uid_msg, sess_id, "user", user_text, 0,
                 1 if (i == 0 and j < n_pairs - 3) else 0, now),
            )
            aid_msg = uid()
            conn.execute(
                "INSERT INTO chat_messages (id,session_id,role,content,is_starred,is_summarized,created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (aid_msg, sess_id, "assistant", asst_text,
                 1 if j == 0 else 0,
                 1 if (i == 0 and j < n_pairs - 3) else 0, now),
            )

    # ---- 追加スニペット（15 件） ----
    snippet_titles = [
        "{char}の所作集",
        "{loc}の描写候補",
        "{ally}との会話パターン",
        "{enemy}を匂わせる比喩",
        "{item}を取り出す瞬間",
        "夜半の{loc}",
        "風の音、雨の匂い",
        "{char}の手首の火傷",
        "茶碗の湯気",
        "封じ詞の断片",
        "{char}の独白",
        "{ally}の沈黙",
        "{loc}の朝",
        "{char}と{ally}の距離",
        "終章のための余韻",
    ]
    tag_choices = list(ctx["tag_ids"].values())
    for i, title_tpl in enumerate(snippet_titles):
        spec = bulk_scene_setup_specs[i % len(bulk_scene_setup_specs)]
        title = title_tpl.format(**spec)
        body_paras = [
            rng.choice(_BULK_PARA_TEMPLATES).format(**spec)
            for _ in range(rng.randint(2, 4))
        ]
        snippet_id = uid()
        scene_link = bulk_scene_ids[i % len(bulk_scene_ids)] if i % 2 == 0 else None
        conn.execute(
            """INSERT INTO snippets
               (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (snippet_id, project_id, title,
             html_paragraphs(*body_paras),
             "human", scene_link, rng.randint(0, 3), now, now),
        )
        if tag_choices:
            conn.execute(
                "INSERT OR IGNORE INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                (snippet_id, rng.choice(tag_choices)),
            )

    print(f"  [bulk seed] {len(bulk_scene_ids)} scenes / "
          f"{len(bulk_chars) + len(bulk_locs) + len(bulk_items) + len(bulk_lore)} codex / "
          f"{foreshadow_count + 1} foreshadows / 8 chat sessions / "
          f"{len(snippet_titles)} snippets を追加しました。")


# ---------------------------------------------------------------------------
# シードデータ
# ---------------------------------------------------------------------------

def seed(db_path: Path, scale: str = "default") -> None:
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
        (notes_folder_id, project_id, "folder", "覚書", "a2",
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
            html_paragraphs(
                "朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。",
                "指が触れた瞬間、記憶が来た。朱音自身の記憶ではなかった。"
                "誰かが走っていた。杉林の中を、夜に、何かから逃げながら。"
                "恐怖の感触だけが、くっきりと残った。",
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
            html_paragraphs(
                "拝殿の扉は施錠されていなかった。錠前はあったが、錠前ごと落ちていた。",
                "朱音は錠前を拾い上げ、しばらく眺めてから、元の場所に置いた。"
                "誰かがここに入った。あるいは、何かがここから出た。どちらにしても、"
                "鍵は最初から意味をなしていなかった。",
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

    def _map_pos(node_ref_type: str, *,
                 tree_node_id: str | None = None,
                 codex_entry_id: str | None = None,
                 snippet_id: str | None = None,
                 sticky_id: str | None = None,
                 ai_branch_id: str | None = None,
                 x: float, y: float, z_index: int = 0) -> str:
        pid = uid()
        conn.execute(
            """INSERT INTO map_node_positions
               (id,board_id,node_ref_type,tree_node_id,codex_entry_id,snippet_id,
                sticky_id,ai_branch_id,x,y,z_index,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, board_id, node_ref_type,
             tree_node_id, codex_entry_id, snippet_id, sticky_id, ai_branch_id,
             x, y, z_index, now, now),
        )
        return pid

    def map_pos_scene(tree_node_id: str, x: float, y: float) -> str:
        return _map_pos("scene", tree_node_id=tree_node_id, x=x, y=y)

    def map_pos_codex(codex_entry_id: str, x: float, y: float) -> str:
        return _map_pos("codex", codex_entry_id=codex_entry_id, x=x, y=y)

    def map_pos_snippet(snippet_id: str, x: float, y: float) -> str:
        return _map_pos("snippet", snippet_id=snippet_id, x=x, y=y)

    def map_pos_sticky(sticky_id: str, x: float, y: float) -> str:
        return _map_pos("sticky", sticky_id=sticky_id, x=x, y=y)

    def map_pos_ai_branch(ai_branch_id: str, x: float, y: float) -> str:
        return _map_pos("ai_branch", ai_branch_id=ai_branch_id, x=x, y=y)

    def map_edge(from_pos_id: str, to_pos_id: str, *,
                 forward_label: str | None = None,
                 backward_label: str | None = None,
                 labels: list[str] | None = None,
                 style: str = "solid",
                 color: str = "#888888",
                 direction: str = "none",
                 board: str | None = None) -> None:
        conn.execute(
            """INSERT INTO map_edges
               (id,board_id,from_position_id,to_position_id,
                forward_label,backward_label,labels,style,color,direction,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uid(), board or board_id, from_pos_id, to_pos_id,
             forward_label, backward_label,
             json.dumps(labels or [], ensure_ascii=False),
             style, color, direction, now, now),
        )

    def make_sticky(*, board: str, title: str | None, paragraphs: list[str],
                    palette_id: str = "post-it-playful", color_slot: int = 0,
                    ai_branch_id: str | None = None,
                    source_chat_message_id: str | None = None) -> str:
        sid = uid()
        body = json.dumps(
            {"type": "doc",
             "content": [{"type": "paragraph",
                          "content": [{"type": "text", "text": p}]}
                         for p in paragraphs]},
            ensure_ascii=False,
        )
        preview = " ".join(paragraphs)[:120] if paragraphs else None
        conn.execute(
            """INSERT INTO map_stickies
               (id,board_id,title,body,preview_text,palette_id,color_slot,
                ai_branch_id,source_chat_message_id,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, board, title, body, preview,
             palette_id, color_slot, ai_branch_id, source_chat_message_id, now, now),
        )
        return sid

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

    # Snippet を Map に置く（x≈1020）：本文断片へ視線を誘導するピン
    pos_snip_reunion = map_pos_snippet(snippet1_id, 1020.0, 200.0)
    pos_snip_haisha  = map_pos_snippet(snippet2_id, 1020.0, 420.0)

    # 自由メモ（Sticky）2 枚：構想メモと未確定の問いをカラフルに散らす
    sticky_motive_id = make_sticky(
        board=board_id,
        title="朱音の動機メモ",
        paragraphs=[
            "「真相を知りたい」よりも「あの夜を成仏させたい」を上に置く。",
            "知識欲は動機の表層、根っこは喪の作業。",
        ],
        color_slot=0,  # Sunnyside
    )
    sticky_question_id = make_sticky(
        board=board_id,
        title="未確定：朱鬼は誰の記憶を喰っているか",
        paragraphs=[
            "候補A：母（情緒寄り）／候補B：冬弥（プロット寄り）",
            "二章の手応えで決める。確定までは触れない。",
        ],
        color_slot=2,  # Tropical Pink
    )
    pos_sticky_motive   = map_pos_sticky(sticky_motive_id,   320.0, -120.0)
    pos_sticky_question = map_pos_sticky(sticky_question_id, 820.0, 800.0)

    # エッジ：関係性（forward/backward 双方向ラベルや labels 配列も活用）
    map_edge(pos_akane,       pos_haisha,        forward_label="帰還",     style="solid",  color="#534AB7", direction="forward")
    map_edge(pos_akane,       pos_akahimo,       forward_label="所持",     style="solid",  color="#534AB7", direction="forward")
    map_edge(pos_akane,       pos_otowa,         forward_label="幼なじみ", style="dashed", color="#5B8CDD")
    map_edge(pos_akane,       pos_fuuya,
             forward_label="因縁", backward_label="観察",
             style="dashed", color="#993C1D", direction="bidirectional")
    map_edge(pos_shuki,       pos_haisha,        forward_label="出現跡",   style="dotted", color="#CC3333")
    map_edge(pos_haisha,      pos_kirino,        forward_label="所在",     style="solid",  color="#0F6E56", direction="forward")
    map_edge(pos_s_flashback, pos_haisha,        forward_label="十年前",   style="dotted", color="#BA7517")
    map_edge(pos_s1,          pos_haisha,
             forward_label="舞台",
             labels=["導入", "視線誘導"],
             style="solid", color="#888888")
    map_edge(pos_s2,          pos_haisha,        forward_label="舞台",     style="solid",  color="#888888")
    # スニペット → シーン：執筆参照リンク
    map_edge(pos_snip_reunion, pos_s1,           forward_label="本文の元", style="dashed", color="#888888", direction="forward")
    map_edge(pos_snip_haisha,  pos_s1,           forward_label="本文の元", style="dashed", color="#888888", direction="forward")
    # 付箋 → 関連ノード
    map_edge(pos_sticky_motive,   pos_akane,     forward_label="動機",     style="dashed", color="#999999")
    map_edge(pos_sticky_question, pos_s3,        forward_label="決定保留", style="dotted", color="#999999")

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

    # Snippet 本文は HTML 形式（"<p>...</p><p>...</p>"）。
    # TipTap が読み込んだ後の ProseMirror 位置は paragraph 並びの場合と同等になるため、
    # 段落テキストを抽出してから _doc_para_ranges と同じ規則で from/to を計算する。
    import re as _re
    def _html_para_ranges(html: str) -> list[tuple[int, int]]:
        paragraphs = _re.findall(r"<p>(.*?)</p>", html, flags=_re.S)
        pos = 0
        ranges: list[tuple[int, int]] = []
        for text in paragraphs:
            text_start = pos + 1
            text_len = len(text)
            ranges.append((text_start, text_start + text_len))
            pos += 2 + text_len
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
                       phase_col_id: str | None = None,
                       *, is_html: bool = False) -> None:
        ranges = (_html_para_ranges(content_text) if is_html
                  else _doc_para_ranges(content_text))
        for fp, tp in ranges:
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
                   "human", None, chat_msg_ids[1], is_html=True)
    snip2_content_row = conn.execute(
        "SELECT content FROM snippets WHERE id=?", (snippet2_id,)
    ).fetchone()
    _attribute_doc("snippet_id", snippet2_id, snip2_content_row[0],
                   "ai", "anthropic/claude-sonnet-4.6", None, is_html=True)

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

    # ---- AI branch（種ノードからの放射） ----
    # map_ai_branches は「AI に問いを投げた起点」を保存し、応答カードは派生 Sticky として
    # ai_branch_id でひも付ける（mapApi.ts createAiBranch 参照）。
    ai_branch_id = uid()
    conn.execute(
        """INSERT INTO map_ai_branches
           (id,board_id,prompt,seed_node_ids,session_id,model,token_usage,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (ai_branch_id, board_id,
         "朱音と冬弥の最初の対峙シーンで、二人のどちらが先に口を開くべき？",
         json.dumps([pos_akane, pos_fuuya, pos_s3], ensure_ascii=False),
         session_id, "anthropic/claude-sonnet-4.6", 412, now, now),
    )
    pos_ai_branch = map_pos_ai_branch(ai_branch_id, 920.0, 580.0)

    # branch から派生する応答カード Sticky（3 枚を放射状に配置）
    branch_sticky_specs = [
        ("朱音から", [
            "緊張の主導権が朱音に渡る。読者は朱音の意志を受け取りやすい。",
            "ただし「言わない人」設定との整合に注意。",
        ], 4),  # Blue Paradise
        ("冬弥から", [
            "朱音の沈黙が読者に重みを持つ。冬弥の善意（または偽善）が前面化。",
            "二章の重心を朱音の内面に置きたいならこちら。",
        ], 5),  # Iris Infusion
        ("第三者の声", [
            "音羽が割って入る案。緊張は溶けるがテーマは弱まる。",
            "対立軸を保ちたい場合は不採用。",
        ], 1),  # Vital Orange
    ]
    branch_sticky_positions: list[str] = []
    for i, (title, paragraphs, slot) in enumerate(branch_sticky_specs):
        sid_st = make_sticky(
            board=board_id, title=title, paragraphs=paragraphs,
            color_slot=slot, ai_branch_id=ai_branch_id,
            source_chat_message_id=chat_msg_ids[1] if i == 0 else None,
        )
        # branch を中心に半径 220 で 120° ごとに配置
        import math
        angle = (2 * math.pi / 3) * i - math.pi / 2
        sx = 920.0 + 220 * math.cos(angle)
        sy = 580.0 + 220 * math.sin(angle)
        bp = map_pos_sticky(sid_st, sx, sy)
        branch_sticky_positions.append(bp)
        # branch → sticky の点線エッジ
        map_edge(pos_ai_branch, bp, style="dashed", color="#999999", direction="forward")

    # branch ノード → 検討対象シーン
    map_edge(pos_ai_branch, pos_s3, forward_label="検討", style="dashed", color="#999999")

    # フレーム：AI ブランチ群を一目で識別
    conn.execute(
        """INSERT INTO map_frames
           (id,board_id,title,x,y,width,height,background,border_color,z_index,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid(), board_id, "AI 検討：対峙の口火",
         640.0, 320.0, 580.0, 540.0,
         "#fff5f5", "#cc9999", -1, now, now),
    )

    # ---- 2 つ目の map board（タイムライン視覚化） ----
    board2_id = uid()
    conn.execute(
        """INSERT INTO map_boards
           (id, project_id, title, sort_order, mode, viewport_x, viewport_y, viewport_zoom, show_config, color_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (board2_id, project_id, "タイムライン視覚化", 1.0,
         "free", 0, 0, 1.0, "{}", "status", now, now),
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
         "complete", "a1", "前史"),
        ("番外：陰陽寮の地下（revision）",
         "陰陽寮の封書庫を初めて描く章。改稿待ち。",
         "revision", "a2", "十年後・初冬"),
        ("番外：燃えた夜の祝詞（final）",
         "回想で母が唱えていた祝詞の全文。校了済み。",
         "final", "a3", "十年前・夏の夜"),
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

    # ================================================================
    # 文屑箱（trash_items）：削除した本文断片・構造アイテムをサンプル投入
    # ================================================================
    # types.ts に合わせて payload は camelCase キーで JSON.stringify したものを保存。
    # is_interesting は trashBinStore の判定（長さ・構造種別）を踏襲した手動付与。

    def trash_text_fragment(*, scene_id: str | None, codex_id: str | None,
                            text: str, spans: list[dict],
                            interesting: bool = False,
                            deleted_offset_seconds: int = 0) -> None:
        deleted = datetime.now(timezone.utc).timestamp() - deleted_offset_seconds
        deleted_iso = datetime.fromtimestamp(deleted, tz=timezone.utc) \
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        payload = {"text": text, "spans": spans}
        conn.execute(
            """INSERT INTO trash_items
               (id,project_id,kind,sub_kind,origin_scene_id,origin_codex_id,
                preview_text,preview_meta,payload,char_count,is_interesting,deleted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uid(), project_id, "text-fragment", "text-fragment",
             scene_id, codex_id,
             text[:80], None,
             json.dumps(payload, ensure_ascii=False),
             len(text), 1 if interesting else 0, deleted_iso),
        )

    def trash_structure(*, sub_kind: str, scene_id: str | None,
                        codex_id: str | None, preview_text: str,
                        preview_meta: dict | None, payload_obj: dict,
                        char_count: int,
                        deleted_offset_seconds: int = 0) -> None:
        # 構造アイテムは原則 interesting=true（trashBinStore の判定に倣う）。
        deleted = datetime.now(timezone.utc).timestamp() - deleted_offset_seconds
        deleted_iso = datetime.fromtimestamp(deleted, tz=timezone.utc) \
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        conn.execute(
            """INSERT INTO trash_items
               (id,project_id,kind,sub_kind,origin_scene_id,origin_codex_id,
                preview_text,preview_meta,payload,char_count,is_interesting,deleted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uid(), project_id, "structure-item", sub_kind,
             scene_id, codex_id,
             preview_text[:80],
             json.dumps(preview_meta, ensure_ascii=False) if preview_meta else None,
             json.dumps(payload_obj, ensure_ascii=False),
             char_count, 1, deleted_iso),
        )

    # 1) 短い文字屑（誤字直しで消えた程度のもの）
    trash_text_fragment(
        scene_id=scene1_id, codex_id=None,
        text="——いや、思い出すまでもない。",
        spans=[{
            "text": "——いや、思い出すまでもない。",
            "source": "human",
            "model": None, "chatMessageId": None, "timestamp": now,
        }],
        deleted_offset_seconds=120,
    )

    # 2) interesting な長文（推敲で削った段落、AI 由来の混在）
    long_drop = (
        "鳥居の朱は色褪せていた。十年前に見たときは、もっと血の色に近かった気がする。"
        "あれは記憶の補正だろうか、それとも本当に色が抜けたのか。"
        "朱音は手を伸ばしかけて、やめた。触れてしまえば確かめてしまう。それは怖かった。"
    )
    trash_text_fragment(
        scene_id=scene1_id, codex_id=None,
        text=long_drop,
        spans=[
            {"text": "鳥居の朱は色褪せていた。十年前に見たときは、もっと血の色に近かった気がする。",
             "source": "human", "model": None,
             "chatMessageId": None, "timestamp": now},
            {"text": "あれは記憶の補正だろうか、それとも本当に色が抜けたのか。",
             "source": "ai", "model": "anthropic/claude-sonnet-4.6",
             "chatMessageId": chat_msg_ids[1] if chat_msg_ids else None,
             "timestamp": now},
            {"text": "朱音は手を伸ばしかけて、やめた。触れてしまえば確かめてしまう。それは怖かった。",
             "source": "human", "model": None,
             "chatMessageId": None, "timestamp": now},
        ],
        interesting=True,
        deleted_offset_seconds=3600,
    )

    # 3) Codex 編集中に削った断片（excludedAliases の整理途中で消した行）
    trash_text_fragment(
        scene_id=None, codex_id=akane_id,
        text="（旧設定）幼少期の朱音は朱紐を「お姉さん」と呼んでいた。",
        spans=[{
            "text": "（旧設定）幼少期の朱音は朱紐を「お姉さん」と呼んでいた。",
            "source": "human",
            "model": None, "chatMessageId": None, "timestamp": now,
        }],
        deleted_offset_seconds=7200,
    )

    # 4) 構造アイテム：削除された Map Sticky（payload に座標と色情報を保持）
    deleted_sticky_body = json.dumps(
        {"type": "doc",
         "content": [{"type": "paragraph",
                      "content": [{"type": "text",
                                   "text": "ボツ案：朱鬼が冬弥の母を喰っていた説。"
                                            "整合が取れず一旦撤回。"}]}]},
        ensure_ascii=False,
    )
    trash_structure(
        sub_kind="map-sticky",
        scene_id=None, codex_id=None,
        preview_text="ボツ案：朱鬼が冬弥の母を喰っていた説。",
        preview_meta={"paletteId": "post-it-playful", "colorSlot": 6},
        payload_obj={
            "originalId": uid(),
            "boardId": board_id,
            "title": "撤回した仮説",
            "body": deleted_sticky_body,
            "previewText": "ボツ案：朱鬼が冬弥の母を喰っていた説。整合が取れず一旦撤回。",
            "paletteId": "post-it-playful",
            "colorSlot": 6,
            "x": 1180.0, "y": -40.0,
            "pinned": False, "zIndex": 0,
        },
        char_count=32,
        deleted_offset_seconds=10800,
    )

    # 5) 構造アイテム：削除された Snippet（執筆候補から外したワンシーン）
    # snippets.content は HTML 形式なので payload.body も HTML で保存する。
    deleted_snippet_body_html = html_paragraphs(
        "「来るな」と冬弥は言った。雪の朝、官庁の門前。"
        "その声は、朱音が知っている誰の声にも似ていなかった。",
        "——結局このシーンは三章ではなく、五章で書く。",
    )
    trash_structure(
        sub_kind="snippet",
        scene_id=scene2_id, codex_id=None,
        preview_text="「来るな」と冬弥は言った。雪の朝、官庁の門前。",
        preview_meta=None,
        payload_obj={
            "originalId": uid(),
            "title": "雪の門前（保留）",
            "body": deleted_snippet_body_html,
            "tags": json.dumps([], ensure_ascii=False),
            "contentSource": "human",
            "sceneId": scene2_id,
        },
        char_count=72,
        deleted_offset_seconds=43200,
    )

    # 6) 構造アイテム：削除された Scene（番外章を一度作って消したログ）
    deleted_scene_body = doc_nodes(
        para("【未採用章】朱音が記録所で十年前の事件記録を盗み見るシーン。"),
        para("動機の暴露が早すぎて伏線回収に支障が出るため取り下げ。"),
    )
    trash_structure(
        sub_kind="scene",
        scene_id=None, codex_id=None,
        preview_text="【未採用章】朱音が記録所で十年前の事件記録を盗み見るシーン。",
        preview_meta={"status": "outline", "wordCount": 86},
        payload_obj={
            "originalId": uid(),
            "title": "未採用：記録所の盗み見",
            "body": deleted_scene_body,
            "beats": json.dumps([], ensure_ascii=False),
            "povCharacterId": akane_id,
            "folderHintId": notes_folder_id,
            "folderHintName": "覚書",
            "metadata": {
                "synopsis": "盗み見シーン草案。テンポ崩れのため未採用。",
                "status": "outline",
                "nodeType": "scene",
                "locationId": None,
                "sortOrder": "z9",
                "storyTimeOrder": None,
                "storyTimeLabel": None,
            },
            "charCount": 86,
        },
        char_count=86,
        deleted_offset_seconds=86400,
    )

    # ---- --scale medium：パフォーマンス検証用の追加生成 ----
    if scale == "medium":
        _seed_bulk_content(
            conn, project_id, now,
            ctx={
                "akane_id": akane_id,
                "fuuya_id": fuuya_id,
                "otowa_id": otowa_id,
                "shuki_id": shuki_id,
                "haisha_id": haisha_id,
                "miyako_id": miyako_id,
                "akahimo_id": akahimo_id,
                "notes_folder_id": notes_folder_id,
                "tag_ids": tag_ids,
                "label_ids": label_ids,
                "board_id": board_id,
            },
        )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="日本語サンプルワークスペース「朱の記憶」を生成する。",
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="samples/akane-no-kioku",
        help="生成先ディレクトリ（既定: samples/akane-no-kioku）",
    )
    parser.add_argument(
        "--scale",
        choices=("default", "medium"),
        default="default",
        help="default=既存サンプルのみ / medium=シーン+30本・約10万字を追加投入（パフォーマンス検証用）",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir)

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
    seed(db_path, scale=args.scale)

    print(f"サンプルワークスペースを生成しました: {output_dir.resolve()}")
    if args.scale != "default":
        print(f"  scale = {args.scale}")
    print("Grimodex でこのディレクトリをワークスペースとして開いてください。")


if __name__ == "__main__":
    main()
