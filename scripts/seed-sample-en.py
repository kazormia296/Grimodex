#!/usr/bin/env python3
"""
Creates the English sample workspace "The Iron Crown" for Grimodex.

Usage:
    python3 scripts/seed-sample-en.py [output_dir] [--scale default|medium]

output_dir defaults to ./samples/iron-crown/
Open that directory as a workspace in Grimodex to explore the sample.

The schema and feature coverage mirror scripts/seed-sample-ja.py (the structural
authority, kept in sync with src-tauri/src/database/migrate.rs). The project is
created with language='en', so opening it and running "Rebuild semantic index"
(Settings -> Project) builds scene_chunks with the English embedding model
(SPEC_EN = bge-small-en-v1.5). The hand-written scenes plus --scale medium give
the semantic search a real, topically varied English corpus to debug against.
"""

import argparse
import json
import math
import os
import random
import re
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Helpers
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


# Snippet bodies are stored as HTML, not ProseMirror JSON
# (src/features/snippets/SnippetDetailContent.tsx uses editor.getHTML()).
def html_paragraphs(*paragraphs: str) -> str:
    return "".join(f"<p>{p}</p>" for p in paragraphs)


# Paragraph builder with foreshadow marks.
# segments is a str (plain text) or a 3-tuple (key, text, mark_dict).
# Records ProseMirror absolute positions (fromPos/toPos) into the spans dict.
class _DocBuilder:
    def __init__(self) -> None:
        self.pos = 0  # top-level position cursor
        self.content: list[dict] = []
        self.spans: dict[str, tuple[int, int]] = {}
        # per-paragraph text range (for paragraph-granular authorship_spans)
        self.paras: list[tuple[int, int]] = []

    def para(self, *segments) -> "_DocBuilder":
        if not segments:
            self.content.append({"type": "paragraph"})
            self.paras.append((self.pos + 1, self.pos + 1))
            self.pos += 2
            return self
        text_pos = self.pos + 1  # +1 for the paragraph open node
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


# Body character count (excludes sceneBeat content, includes generatedProseBlock).
# Mirrors charCountForBody.ts.
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
# Schema (kept in sync with src-tauri/src/database/migrate.rs migrate()).
# INSERT OR IGNORE data-init rows are NOT included here (seed() owns those).
# This block is identical to seed-sample-ja.py, including the Japanese-labelled
# seed_builtin_codex_types trigger: that trigger is language-independent in the
# real schema, and seed() relabels the builtin types to English afterwards
# (mirroring ensureBuiltinTypes / builtinLabelRelabel for an 'en' project).
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
"""


# ---------------------------------------------------------------------------
# Extra content for performance testing (--scale medium)
# ---------------------------------------------------------------------------

# Paragraph templates for procedurally built scenes.
# {char}/{loc}/{item}/{ally}/{enemy} placeholders are substituted in.
_BULK_PARA_TEMPLATES = [
    "{char} stopped at the edge of {loc}. A cold wind moved across the stones, and the smell of wet earth reached them. It was the same smell as ten years ago.",
    "Much had changed since then, but the look of this place had barely moved. The elms of {loc} had grown tall, cutting the sky into narrow strips.",
    "'I have to find {ally},' {char} thought. But there was something to be sure of first.",
    "{char} drew out {item} from inside their coat. The vermilion on its face had worn thin, but it still held a faint warmth in {char}'s hand.",
    "'You came,' said a voice from behind. {char} turned. {ally} was standing there. Why, {char} did not ask. It seemed better not to.",
    "Saying the name of {enemy} aloud was still hard. It was a name that answered when it was called.",
    "{char} took a long breath. Counting to three, they let it out slowly. They did it four times, until the pulse went quiet.",
    "The floor of the keeping-room had not rotted. Someone had been tending it. For ten years untouched, it was unnaturally whole.",
    "'{enemy} is real,' {ally} said quietly. 'Whether you believe it or not.'",
    "Beside the hearth hung a paper token {char} did not remember. The ink was still fresh. It had been written yesterday, or the day before at most.",
    "{char} reached toward the token, then stopped. To touch it was to be certain. To be certain was to be unable to turn back.",
    "The road back to Ironhaven was the same one they had come by, yet it felt longer. The hills stood sharper than memory, and the river ran loud.",
    "'You had {item} all this time,' {ally} murmured, surprised. 'Then this is simple. Let us finish what we started ten years ago.'",
    "{char} nodded without a word. That was the whole of the answer. It was enough.",
    "There was no one at {loc}. By this hour the morning market should have been open, but there were no stalls and no buyers. Only the cold air drifted.",
    "Rain began to fall. At first it was too thin to notice. Then it wet {char}'s hair and darkened the vermilion of {item} by a shade.",
    "'Can I trust {ally}?' {char} asked themselves. No answer came yet. Perhaps it was better that none did.",
    "{char} stopped before the old shelves. The spines were rubbed smooth, half of them unreadable. Even so, one book caught {char}'s eye.",
    "'There is no record of {enemy} here,' {ally} said. 'Someone removed it. Recently, too.'",
    "{char} took a firmer hold of {item}. Their fingertips were cold. Within the cold, a small warmth remained.",
    "The sky over {loc} was the colour of slate. Clouds hung low, and far off there was thunder. Less than an hour before the rain.",
    "'Do you remember now?' {ally} asked. {char} did not answer. There are things in the world one would rather not remember.",
    "Night deepened. Every light in {loc} was out, and there was nothing to hear but the wind and {char}'s own heartbeat.",
    "{char} returned {item} to their coat. The time to use it might come. Hoping it would not, they kept it ready all the same.",
    "'Let us go,' {ally} pressed. {char} looked back once more at {loc}. A homecoming ten years late would end here. It had to be ended.",
    "An old burn scar still marked {char}'s wrist. It had been made on the night ten years past. The pain should have gone long ago, yet on wet days it ached.",
    "'{enemy} is coming,' someone said. {char} could not tell whose voice it was — not {ally}'s, not their own, but a voice from somewhere far.",
    "The door groaned. {char}'s hand went to {item} on reflex. But it was {ally} who stepped in. 'Did I startle you,' {ally} said shortly.",
    "Cups stood in a row. Steam still rose from them. Someone had been drinking here only moments ago. {char} held their breath and listened.",
    "'Do not touch {loc},' {ally} said sharply. 'The ward still holds there. Move it carelessly and the whole thing comes down.'",
    "{char} stilled their hand. There was a weight in {ally}'s voice that had not been there ten years ago.",
    "The wind dropped. The leaves had been restless, and all at once everything went quiet. {char} gripped {item} hard. Something is coming, instinct said.",
]

_BULK_BEAT_DESCRIPTIONS = [
    "{char} reaches {loc}. Something feels wrong.",
    "Reunion with {ally}. A short exchange tries to fill ten years of silence.",
    "{char} draws out {item} and shows it to {ally}. {ally} cannot hide their surprise.",
    "A clue about {enemy} is found. The record has been deliberately erased.",
    "{char}'s interior: a memory they would rather forget rises to the surface.",
    "A change at {loc} is noticed. Signs that someone tends the place regularly.",
    "A watch kept past midnight. Only the wind and a heartbeat.",
]

_BULK_FORESHADOW_TEMPLATES = [
    ("The Citadel's Double Ledger",
     "Reveal later that the Citadel keeps records of the Hollow in two separate ledgers.",
     "[bulk] supporting x moderate"),
    ("Why {ally} Stays Silent",
     "Disclose near the end why {ally} keeps silent while knowing part of the truth of ten years ago.",
     "[bulk] critical x overt"),
    ("The Keys to the Sealed Vault",
     "Reveal later that more than one person holds a key to the sealed vault.",
     "[bulk] supporting x subtle"),
    ("The Steaming Cups",
     "Pay off later why steaming cups stood in a place that should have been empty.",
     "[bulk] optional x subtle"),
    ("The Voice that Calls {enemy}'s Name",
     "Confirm near the end the source of the voice that calls {char} in dreams.",
     "[bulk] critical x moderate"),
    ("The Old Burn",
     "Show later that the burn on {char}'s wrist ties directly to the night ten years ago.",
     "[bulk] supporting x moderate"),
    ("The Erased Record",
     "Hint mid-book at who tore the missing pages from the Citadel's records.",
     "[bulk] supporting x subtle"),
    ("Signs the Ward Weakens",
     "Scatter signs that the ward weakens over time, paid off by the collapse at the end.",
     "[bulk] critical x moderate"),
]


def _seed_bulk_content(conn, project_id, now, ctx) -> None:
    """--scale medium: procedurally inserts 4 part folders, ~32 scenes, etc."""
    rng = random.Random(0xAEAEBEEF)  # fixed seed for reproducibility
    fs_now_ms = ts_ms()

    # Push the existing notes folder to the end (new parts get sort_order a3..a6).
    conn.execute(
        "UPDATE tree_nodes SET sort_order=? WHERE id=?",
        ("z0", ctx["notes_folder_id"]),
    )

    # ---- Extra Codex (character / location / item / lore) ----
    char_type = f"{project_id}-character"
    loc_type = f"{project_id}-location"
    item_type = f"{project_id}-item"
    lore_type = f"{project_id}-lore"

    bulk_chars: list[tuple[str, str, str, str]] = []  # (id, name, summary, content_para)
    bulk_locs: list[tuple[str, str, str]] = []
    bulk_items: list[tuple[str, str, str]] = []
    bulk_lore: list[tuple[str, str, str]] = []

    tag_ids = ctx["tag_ids"]

    def _attach_tags(entry_id: str, tag_names: list[str]) -> None:
        for tn in tag_names:
            if tn in tag_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO codex_entry_tags (entry_id, tag_id) VALUES (?,?)",
                    (entry_id, tag_ids[tn]),
                )

    char_specs = [
        ("Gerard Thorne", ["Thorne"], ["political"],
         "Chamberlain of the Citadel and senior archivist. He has run the records office "
         "since before Eleanor arrived in Ironhaven. Versed in the old rites, cold to the "
         "younger staff."),
        ("Cassian Vale", ["Cassian"], ["political"],
         "Wrenna's brother and a clerk of the Citadel. An easy man, quickest of anyone at "
         "putting a vault in order. His weakness is drink, and a loose tongue."),
        ("Pell", [], ["arcane"],
         "A ward-keeper's apprentice, sixteen. Honest and quick, but heavily shaped by his "
         "master's hand."),
        ("Old Maeve", ["Maeve"], [],
         "Wrenna's grandmother, an old woman who lives alone near the ruined hall. She is "
         "said to have seen something the night of the fire ten years ago, but has never "
         "told even her granddaughter."),
        ("Bram", ["Bram the guide"], [],
         "A guide of the Central Vale who knows its roads to the last turning. He will take "
         "any commission for the right coin, save the stretch around the ruined hall."),
        ("Rosalind Ashveil", ["Eleanor's mother", "Rosalind"], ["arcane"],
         "Deceased. She died the night of the fire ten years ago. She was a keeper of the "
         "Sundering Rite, yet no one knows why the binding failed."),
        ("Mistress Hester", ["Hester", "the innkeeper"], [],
         "Keeper of the Grey Gull, an Ironhaven inn that has put Eleanor up since she came "
         "to the city. She knows the gossip, and exactly who lodges where."),
        ("Brother Anselm", ["Anselm"], ["arcane"],
         "A monk of the old age, a figure who appears only in the texts. He is recorded as "
         "the first to bind a Hollow."),
        ("Tamsin", ["Tam"], [],
         "Eleanor's childhood friend, one of the few who still remembers the old keeping-songs "
         "of the hall. She is married now in the next village over."),
        ("Corwin", [], ["antagonist", "arcane"],
         "A young man lately come to the Citadel. His affiliation is unclear. He is said to "
         "enter the sealed vault with Thorne's leave."),
        ("Old Edran", ["Edran"], ["arcane"],
         "A former ward-walker of the Vale hills, among the first to reach the fire ten years "
         "ago. Since then he will not go within half a mile of the ruined hall."),
        ("Silas", ["Silas the apothecary"], [],
         "An Ironhaven apothecary who calls on Eleanor by night with medicines. Rumour says "
         "he carries more than medicine."),
    ]
    for name, aliases, tags, summary in char_specs:
        cid = uid()
        bulk_chars.append((cid, name, summary, ""))
        content = doc_nodes(
            para(summary),
            para(f"Additional note on {name}. Their on-page presence is still light, but "
                 f"they are intended for a larger role later."),
            para("[bulk seed: Codex entry added for performance testing]"),
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
        ("The Sealed Vault", ["political", "arcane"],
         "A vault beneath the Citadel holding the ward documents. Only a handful are said to "
         "carry a key."),
        ("The Guard Hall", ["political"],
         "The Iron Guard's duty room. Junior officers keep the watch in rotation."),
        ("The Vale Road", [],
         "The road toward Greymoor. Partway it forks, and one branch runs to the ruined hall."),
        ("The Elm Wood", ["arcane"],
         "The wood that rings the ruined hall, hundreds of years of elms standing close. The "
         "air is still, and it is dim even at noon."),
        ("Silas's Apothecary", [],
         "Silas's shop. Ordinary trade by day; by night, other clients come."),
        ("Eleanor's Lodging", [],
         "A plain room near the Royal Archive, within walking distance of the records office. "
         "It holds the barest of furniture."),
        ("The King's Fountain", ["arcane"],
         "An old garden at the heart of Ironhaven with a spring at its centre, often used for "
         "the rites."),
        ("The Greymoor Cemetery", [],
         "An old burial ground at the edge of the Greymoor settlement. Eleanor's mother lies "
         "here."),
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
        ("The Rite Copybook", ["arcane"],
         "A copy of the steps of the Sundering Rite. The original is lost, and only a few "
         "copies remain."),
        ("Witchlight Stone", ["arcane"],
         "A stone that gives a faint light in the dark, used as a catalyst for a binding."),
        ("The Ashveil Inkpot", ["arcane"],
         "An inkpot Eleanor's mother left behind. The ink is long dried, yet on rare days it "
         "is damp again."),
        ("Hallow Salt", ["arcane"],
         "A coarse salt kept at the Citadel, its grains larger than common salt."),
        ("A Hollow's Nail", ["arcane", "hollow"],
         "A shard said to have fallen from a Hollow, kept under heavy lock in the sealed vault."),
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
        ("The Citadel Ranks", ["political"],
         "The Citadel keeps five ranks: Elder, High Seat, Middle Seat, Lower Seat, and "
         "apprentice. Eleanor is archive staff and holds no ward-walker's rank."),
        ("The Eight Wards", ["arcane"],
         "An old system that fixes the bearings of a binding, combining the marks of eight "
         "compass points."),
        ("The Binding Words", ["arcane"],
         "The words spoken to bind a Hollow. The phrasing handed down differs from line to line."),
        ("The Ashveil Line", ["arcane"],
         "Eleanor's family. They have kept the Sundering Rite for generations. The line is "
         "thought to survive in Eleanor alone."),
        ("The Greymoor Fire", ["hollow"],
         "The fire on the night Eleanor's mother died. Officially ruled an accident. The "
         "Citadel's inner records hold a different view."),
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

    # ---- Extra folders (4 parts) ----
    parts = [
        ("Part Three: The Iron Guard",        "a3"),
        ("Part Four: Tracks of the Hollow",   "a4"),
        ("Part Five: The Sealed Vault",       "a5"),
        ("Part Six: The Ward, Remade",        "a6"),
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

    # name -> codex id, to resolve mentions by scanning body text.
    name_to_codex: list[tuple[str, str]] = []
    for cid, name, *_ in bulk_chars:
        name_to_codex.append((name, cid))
    for cid, name, *_ in bulk_locs:
        name_to_codex.append((name, cid))
    for cid, name, *_ in bulk_items:
        name_to_codex.append((name, cid))
    # Existing primary codex are also detection targets (they recur in body text).
    for name, cid in [
        ("Eleanor", ctx["eleanor_id"]),
        ("Aldric", ctx["aldric_id"]),
        ("Wrenna", ctx["wren_id"]),
        ("Mira", ctx["mira_id"]),
        ("the compass", ctx["compass_id"]),
        ("Ashveil Hall", ctx["ashveil_hall_id"]),
        ("Ironhaven", ctx["ironhaven_id"]),
    ]:
        name_to_codex.append((name, cid))

    # POV / location pools
    pov_pool = [ctx["eleanor_id"], ctx["aldric_id"], ctx["wren_id"]] + [
        c[0] for c in bulk_chars[:6]
    ]
    location_pool = [ctx["ashveil_hall_id"], ctx["ironhaven_id"]] + [
        l[0] for l in bulk_locs
    ]
    status_cycle = ["outline", "draft", "draft", "complete", "revision", "final"]
    statuses_distribution = [status_cycle[i % len(status_cycle)] for i in range(32)]

    char_names_for_text = [c[1] for c in bulk_chars] + ["Wrenna", "Aldric"]
    enemy_names = ["Mira"]
    item_names = [it[1] for it in bulk_items] + ["the compass"]
    loc_names = [l[1] for l in bulk_locs] + ["Ashveil Hall", "Ironhaven"]

    bulk_scene_ids: list[str] = []
    bulk_scene_setup_specs: list[dict] = []

    part_season = ["early winter", "late winter", "early spring", "spring"]
    part_ord = ["Three", "Four", "Five", "Six"]

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
            # 55-70 paragraphs per scene -> ~3,000 chars (volume for perf testing)
            num_paragraphs = rng.randint(55, 70)
            picked: list[str] = []
            while len(picked) < num_paragraphs:
                shuffled = _BULK_PARA_TEMPLATES[:]
                rng.shuffle(shuffled)
                picked.extend(shuffled)
            picked = picked[:num_paragraphs]

            place_setup = (scene_counter % 3 == 0)   # ~1/3 of scenes get a setup
            place_payoff = (scene_counter % 5 == 0)  # ~1/5 of scenes get a payoff
            setup_para_idx = rng.randint(2, num_paragraphs - 3) if place_setup else -1
            payoff_para_idx = rng.randint(2, num_paragraphs - 3) if place_payoff else -1
            setup_key = f"bulk_setup_{scene_counter}"
            payoff_key = f"bulk_payoff_{scene_counter}"
            tmp_setup_id = uid()
            tmp_foreshadow_for_setup_id = uid()
            tmp_foreshadow_for_payoff_id = uid()

            for p_idx, tpl in enumerate(picked):
                text = tpl.format(
                    char=char_name, ally=ally_name, enemy=enemy_name,
                    item=item_name, loc=loc_name,
                )
                if p_idx == setup_para_idx:
                    cut = max(8, len(text) // 2)
                    head, mark_body, tail = text[:cut], text[cut:cut + 12], text[cut + 12:]
                    if not mark_body:
                        mark_body = text[-8:]
                        head, tail = text[:-8], ""
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
                        head, tail = text[:-10], ""
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
            scene_title = f"Part {part_ord[part_idx]}, Scene {s_idx + 1}: at {loc_name}"
            synopsis = (f"{char_name} visits {loc_name}. A meeting with {ally_name}, "
                        f"and second thoughts over {item_name}. [bulk seed]")
            story_time = f"Ten years on, {part_season[part_idx]}, day {s_idx + 1}"
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
                "char": char_name,
                "ally": ally_name,
                "enemy": enemy_name,
                "item": item_name,
                "loc": loc_name,
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

            # ---- mentions (every codex name that appears in the body text) ----
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

    # ---- Foreshadow register (15 entries) ----
    # 7 confirmed (setup+payoff), 5 planted (setup only), 2 planned, 1 abandoned
    setup_scenes = [s for s in bulk_scene_setup_specs if s["setup_present"]]
    payoff_scenes = [s for s in bulk_scene_setup_specs if s["payoff_present"]]
    rng.shuffle(setup_scenes)
    rng.shuffle(payoff_scenes)

    load_bearing_cycle = ["critical", "supporting", "supporting", "optional"]
    foreshadow_count = 0

    n_confirmed = min(7, len(setup_scenes), len(payoff_scenes))
    for i in range(n_confirmed):
        spec_setup = setup_scenes[i]
        spec_payoff = payoff_scenes[i % len(payoff_scenes)]
        title_tpl, intent_tpl, notes_tpl = _BULK_FORESHADOW_TEMPLATES[
            i % len(_BULK_FORESHADOW_TEMPLATES)]
        title = title_tpl.format(**spec_setup)
        intent = intent_tpl.format(**spec_setup)

        fs_id = spec_setup["fs_for_setup"]
        spans = spec_payoff["spans"]
        payoff_key = next(
            (k for k in spans if k.startswith("bulk_payoff_")), None
        )
        if payoff_key is None:
            payoff_from = payoff_to = None
            payoff_scene = None
            confirmed = 0
        else:
            payoff_from, payoff_to = spans[payoff_key]
            payoff_scene = spec_payoff["scene_id"]
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

    remaining_setup = setup_scenes[n_confirmed:n_confirmed + 5]
    for i, spec_setup in enumerate(remaining_setup):
        title_tpl, intent_tpl, notes_tpl = _BULK_FORESHADOW_TEMPLATES[
            (i + n_confirmed) % len(_BULK_FORESHADOW_TEMPLATES)]
        title = title_tpl.format(**spec_setup) + " (unpaid)"
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

    for i in range(2):
        fs_id = uid()
        title_tpl, intent_tpl, notes_tpl = _BULK_FORESHADOW_TEMPLATES[
            (i + 6) % len(_BULK_FORESHADOW_TEMPLATES)]
        sample_spec = bulk_scene_setup_specs[i]
        title = "[planned] " + title_tpl.format(**sample_spec)
        intent = intent_tpl.format(**sample_spec)
        load_bearing = load_bearing_cycle[foreshadow_count % len(load_bearing_cycle)]
        conn.execute(
            """INSERT INTO foreshadows
               (id,project_id,title,intent,notes,payoff_scene_id,
                payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
                load_bearing,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (fs_id, project_id, title, intent,
             "[bulk seed: planned, no setup placed]",
             None, None, None, 0, 0,
             load_bearing, fs_now_ms, fs_now_ms),
        )
        foreshadow_count += 1

    fs_id = uid()
    conn.execute(
        """INSERT INTO foreshadows
           (id,project_id,title,intent,notes,payoff_scene_id,
            payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
            load_bearing,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (fs_id, project_id, "[withdrawn] The King's Fountain rite",
         "A plan to hold a rite at the King's Fountain mid-book. Dropped for consistency.",
         "[bulk seed: abandoned]",
         None, None, None, 0, 1,
         "optional", fs_now_ms, fs_now_ms),
    )

    # ---- Extra chat sessions ----
    chat_models = [
        "openrouter/anthropic/claude-sonnet-4.6",
        "openrouter/anthropic/claude-sonnet-4.6",
        "openrouter/anthropic/claude-opus-4.6",
        "openrouter/openai/gpt-4o",
    ]
    chat_user_prompts = [
        "Could you make {char}'s narration in this scene a touch more restrained?",
        "I want the moment {ally} starts to doubt {char} shown through gesture, not dialogue. Two options, please.",
        "I'd like to rewrite the description of {loc} leaning on smell and sound.",
        "I want to deepen {char}'s reason for taking out {item} by one more layer, internally.",
        "I'm unsure whether to name {enemy} here. If I do, how long can I hold it back?",
        "The link to the previous chapter feels weak. I want to shore it up in the first three paragraphs.",
    ]
    chat_assistant_replies = [
        "Here are two passes.\n\nA: gesture-led. {char} kept their grip on {item} and did not move "
        "for a while. It was {ally} who finally said, 'Let's go.'\n\n"
        "B: keep the inner smudge. {char} took a firmer hold of {item}. Nothing took hold in return. "
        "And that, {char} thought, was as it should be.",
        "{ally}'s doubt reads most naturally through the length of a look. 'Held {char}'s gaze half a "
        "beat longer than usual' is enough — repeat it twice. By the third time {ally} speaks, the "
        "reader is already braced for it.",
        "Leaning on smell and sound, 'the moss-smell of {loc}' and 'the wind-chime that does not ring' "
        "carry well. Cut the visual for three paragraphs and the reader rebuilds the room by feel.",
        "Deepening the motive is quickest with one past experience: 'Once, {char} handed something like "
        "this to someone. It never came back.' A single line will do.",
        "You can hold {enemy}'s name back to the last word of the chapter. Until then carry it on 'that "
        "presence' and 'the name not to be spoken.'",
        "The safest bridge to the prior chapter is a returning object. Recall the feel of {item} from "
        "the last chapter in the opening — 'her fingers still remembered it' is enough.",
    ]

    for i in range(8):
        sess_id = uid()
        node_id = bulk_scene_ids[i * 4 % len(bulk_scene_ids)]
        spec = bulk_scene_setup_specs[i * 4 % len(bulk_scene_setup_specs)]
        title = f"Tuning {spec['char_name']}'s POV #{i + 1}"
        model = chat_models[i % len(chat_models)]
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

    # ---- Extra snippets (15) ----
    snippet_titles = [
        "{char}'s gestures",
        "Descriptions of {loc}",
        "Dialogue patterns with {ally}",
        "Metaphors that hint at {enemy}",
        "The moment {item} is drawn",
        "{loc} past midnight",
        "Wind, the smell of rain",
        "The burn on {char}'s wrist",
        "The steaming cups",
        "Fragments of the binding words",
        "{char}'s monologue",
        "{ally}'s silence",
        "{loc} at morning",
        "The distance between {char} and {ally}",
        "A held note for the final chapter",
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

    print(f"  [bulk seed] added {len(bulk_scene_ids)} scenes / "
          f"{len(bulk_chars) + len(bulk_locs) + len(bulk_items) + len(bulk_lore)} codex / "
          f"{foreshadow_count + 1} foreshadows / 8 chat sessions / "
          f"{len(snippet_titles)} snippets.")


# ---------------------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------------------

def seed(db_path: Path, scale: str = "default") -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    now = ts()

    # ---- Project ----
    # After INSERT the seed_builtin_codex_types / seed_default_map_board triggers
    # fire, auto-creating codex_types and a Main map board.
    project_id = "default-project"
    conn.execute(
        """INSERT INTO projects
           (id,title,genre,pov,tense,language,style_guide,ai_instructions,phase_resolution_mode,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            project_id,
            "The Iron Crown",
            "Dark Fantasy",
            "Third person limited",
            "Past",
            "en",
            "Clear, vivid prose with attention to sensory detail. Avoid adverbs; show emotion "
            "through action and physical response. Dialogue should reveal character, not "
            "explain plot.",
            "You are assisting with a dark fantasy novel. Maintain consistency with established "
            "character voices and worldbuilding. When expanding scenes, prioritize atmosphere "
            "and internal conflict over action.",
            "reading",
            now, now,
        ),
    )

    # ---- Codex type IDs (auto-created by the seed_builtin_codex_types trigger) ----
    # The trigger writes Japanese labels (language-independent in the real schema);
    # relabel them to English, mirroring ensureBuiltinTypes / builtinLabelRelabel.
    type_ids: dict[str, str] = {
        "character": f"{project_id}-character",
        "location":  f"{project_id}-location",
        "item":      f"{project_id}-item",
        "lore":      f"{project_id}-lore",
    }
    for slug, label in [("character", "Character"), ("location", "Location"),
                        ("item", "Item"), ("lore", "Lore")]:
        conn.execute("UPDATE codex_types SET label=? WHERE id=?",
                     (label, type_ids[slug]))

    # ---- Codex detail definitions ----
    def_ids: dict[str, str] = {}
    for type_slug, name, field_type, field_config, sort_order, include in [
        ("character", "Role",       "text",     None, 1.0, 1),
        ("character", "Alignment",  "dropdown",
         json.dumps({"options": ["Protagonist", "Antagonist", "Ally", "Neutral", "Unknown"]}),
         2.0, 1),
        ("character", "Motivation", "text",     None, 3.0, 0),
        ("location",  "Region",     "text",     None, 1.0, 1),
        ("item",      "Status",     "dropdown",
         json.dumps({"options": ["Present", "Lost", "Sealed", "Destroyed"]}),
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

    # ---- Codex tags ----
    tag_ids: dict[str, str] = {}
    for name, color in [
        ("protagonist", "#5B8CDD"),
        ("antagonist",  "#DD5B5B"),
        ("arcane",      "#9B59B6"),
        ("political",   "#888888"),
        ("hollow",      "#CC3333"),
    ]:
        tid = uid()
        tag_ids[name] = tid
        conn.execute(
            "INSERT INTO codex_tags (id,project_id,name,color,created_at) VALUES (?,?,?,?,?)",
            (tid, project_id, name, color, now),
        )

    # ---- Labels (Scene panel / Grid) ----
    # color stores a palette slot name (src/lib/labelPalette.ts); resolved to hex
    # in the UI via resolveLabelColor().
    label_ids: dict[str, str] = {}
    for sort_idx, (name, color_slot) in enumerate([
        ("Setup",        "rose"),
        ("Rising",       "sky"),
        ("Turn",         "amber"),
        ("Resolution",   "emerald"),
        ("Key",          "red"),
        ("Open",         "slate"),
        ("Hollow stirs", "violet"),
    ]):
        lid = uid()
        label_ids[name] = lid
        conn.execute(
            "INSERT INTO labels (id,project_id,name,color,sort_order,created_at) VALUES (?,?,?,?,?,?)",
            (lid, project_id, name, color_slot, float(sort_idx), now),
        )

    # ---- Characters ----
    eleanor_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            eleanor_id, project_id, "character", "Eleanor Ashveil",
            json.dumps(["Eleanor", "Eleanor Marin Ashveil", "Nell", "the Archivist"]),
            "The last of a line that kept the Sundering Rite. For ten years she has lived in "
            "Ironhaven as a quiet archivist. Word that her family hall has burned sends her "
            "back to Greymoor for the first time in a decade.",
            doc_nodes(
                para("Eleanor is in her late twenties and has spent most of her adult life making "
                     "herself unremarkable. Competent, methodical, never the one to say the extra "
                     "thing — that is how she is known."),
                para("The truth is that she is the last of a line that bound memory, and she can "
                     "work the vermilion that holds a Hollow. When she left Greymoor ten years ago, "
                     "she meant to leave that power behind with everything else."),
                para("She does not show what she feels. When she is angry she goes quiet; when she "
                     "grieves she sits and says nothing. She used to laugh only around Wrenna, and "
                     "that, too, is ten years gone."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (eleanor_id, now))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (eleanor_id, tag_ids["protagonist"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (eleanor_id, tag_ids["arcane"]))
    for key, val in [("character.Role", "Protagonist"), ("character.Alignment", "Protagonist"),
                     ("character.Motivation", "Find out what happened at the hall, and learn the truth of ten years ago")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), eleanor_id, def_ids[key], val),
        )

    aldric_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            aldric_id, project_id, "character", "Lord Aldric Morvaine",
            json.dumps(["Aldric", "the Old Knight", "the ward-walker"]),
            "A knight of the Citadel. A functionary on the surface, but he has tracked the "
            "Hollow's movements on his own for years. He has had dealings with Eleanor's line "
            "since the night of the fire.",
            doc_nodes(
                para("Aldric is in his early sixties and known as a steady hand at the Citadel. "
                     "Able, courteous, trusted by superiors and peers alike. He is very good at "
                     "lying."),
                para("In truth Aldric does only half of his official work. The rest of his hours "
                     "go to the Hollow — a search neither his superiors nor the court know of."),
                para("Toward Eleanor he carries something complicated. What he did the night of "
                     "the fire, and how much she knows of it, he has not yet let himself find out."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (aldric_id, tag_ids["arcane"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (aldric_id, tag_ids["political"]))
    for key, val in [("character.Role", "Ally (suspect)"), ("character.Alignment", "Ally"),
                     ("character.Motivation", "Bind the Hollow; act before Eleanor reaches the truth")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), aldric_id, def_ids[key], val),
        )

    mira_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            mira_id, project_id, "character", "Mira Voss",
            json.dumps(["the Iron Hand", "Commander Voss", "the Commander"]),
            "Commander of the Iron Guard. Self-made and relentless. She has known about Eleanor "
            "for years, and is bound up with the Greymoor fire and the Hollow that came after "
            "it more deeply than anyone guesses.",
            doc_nodes(
                para("Mira is not a name so much as a force people learned to fear. The records "
                     "call her the Iron Hand, and the records, for once, are restrained."),
                para("She has known of Eleanor Ashveil for three years and has been waiting to see "
                     "whether the girl is foolish enough to move. What she serves is power, and "
                     "power has been waiting too."),
                para("Whether the thing that walked out of the Greymoor fire serves Mira, or Mira "
                     "serves it, no one has dared to ask. Eleanor felt its edge at the hall and "
                     "told no one."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (mira_id, tag_ids["antagonist"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (mira_id, tag_ids["hollow"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (mira_id, tag_ids["political"]))
    for key, val in [("character.Role", "Antagonist"), ("character.Alignment", "Antagonist"),
                     ("character.Motivation", "Unclear. To hold her power, or to find what the Greymoor fire left behind")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), mira_id, def_ids[key], val),
        )
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (mira_id, now))

    wren_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            wren_id, project_id, "character", "Wrenna Cole",
            json.dumps(["Wrenna", "Wren", "the keeper"]),
            "Eleanor's old friend, now a healer and the keeper of the records at Greymoor. She "
            "waited ten years for Eleanor to come back. She will not admit that she waited.",
            doc_nodes(
                para("Wrenna is the same age as Eleanor and grew up in the Greymoor settlement. "
                     "When Eleanor left for the city, Wrenna stayed, and now lives alone as a "
                     "healer and keeper of the old hall's records."),
                para("She is bright, sharp-tongued, and hides nothing she feels. To Eleanor, ten "
                     "years returned, she said only 'You're late,' and nothing more."),
                para("Wrenna may know the hall better than anyone. But she will not speak unless "
                     "asked — and even asked, she may not tell all of it."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    for key, val in [("character.Role", "Ally"), ("character.Alignment", "Ally"),
                     ("character.Motivation", "Protect Eleanor. Keep the hall's secret. She knows the two cannot both hold")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), wren_id, def_ids[key], val),
        )

    # ---- Locations ----
    ironhaven_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            ironhaven_id, project_id, "location", "Ironhaven",
            json.dumps(["the capital", "the grey city"]),
            "The realm's capital and seat of the Citadel and the court. Calm on the surface, but "
            "the Hollow's shadow draws nearer. Where Eleanor has lived for ten years.",
            doc_nodes(
                para("Ironhaven is large and crowded, and no one remembers another's face. Eleanor "
                     "found that she liked it. Asked her name she gave it; asked her history she "
                     "smiled and turned it aside. Ten years it served her."),
                para("The records office where Eleanor works is in the east district. The Citadel "
                     "is in the west. The court buildings line the north causeway, and Eleanor does "
                     "not go near them."),
                para("Lately there is more talk in Ironhaven of people who have 'changed' — a face "
                     "known yesterday that today seems to belong to someone else. Eleanor hears the "
                     "talk and says nothing in particular."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), ironhaven_id, def_ids["location.Region"], "The Central Vale"),
    )

    citadel_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,parent_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            citadel_id, project_id, ironhaven_id, "location", "The Citadel",
            json.dumps(["the fortress", "the ward office"]),
            "The fortress at Ironhaven's heart, home to the realm's arcane office. It keeps "
            "records of the Hollow in secret. Aldric's posting.",
            doc_nodes(
                para("On the surface the Citadel is an office of the realm — astronomy, the "
                     "calendar, the rites. It advises the court, performs the wardings, reads the "
                     "omens. The work is plain and unglamorous."),
                para("But the sealed vault below holds records that are kept from the public: "
                     "sightings of Hollows, reports of bindings that failed, the notebooks of "
                     "ward-walkers who vanished. Aldric is one of the few who carry a key to it."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), citadel_id, def_ids["location.Region"], "Ironhaven, west district"),
    )

    greymoor_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            greymoor_id, project_id, "location", "Greymoor",
            json.dumps(["Eleanor's home", "the moor village"]),
            "Eleanor's home settlement in the Vale hills. The ruined Ashveil Hall stands above "
            "it. Since the fire ten years ago its people have dwindled year on year.",
            doc_nodes(
                para("Greymoor lies three days' road from Ironhaven, a small settlement in the "
                     "hills. There are many elms; it is cool even in summer and the winters lie "
                     "deep. The rolls list a hundred and twenty households; barely seventy remain."),
                para("After the fire ten years ago the young left first, in order. What stays is "
                     "the old, those with no reason to go, and those — like Wrenna — who do not "
                     "want to."),
                para("Beyond the village, past the elm wood, stands the ruined hall. The people "
                     "still do not go that way."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), greymoor_id, def_ids["location.Region"], "The Vale hills"),
    )

    ashveil_hall_id = uid()
    ashveil_hall_builder_summary = (
        "The Ashveil seat in the hills, kept by Eleanor's line for generations. The east wing "
        "burned ten years ago and was never rebuilt; no one comes to it now. On the old "
        "hearthstone, the compass Eleanor left behind still lay."
    )
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,parent_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            ashveil_hall_id, project_id, greymoor_id, "location", "Ashveil Hall",
            json.dumps(["the hall", "the ruined hall", "the keeping-room", "the Ashveil seat"]),
            ashveil_hall_builder_summary,
            doc_nodes(
                para("Ashveil Hall stands beyond Greymoor, deep in the elm wood. The gateposts "
                     "remain, mossed over, and the front steps are half fallen. The east wing, "
                     "burned ten years ago, has never been raised again."),
                para("The keeping-room barely holds its shape. The boards sound underfoot, but the "
                     "roof does not leak. On the hearthstone lies the compass Eleanor left behind "
                     "ten years ago. No one moved it."),
                para("Around the hall there is the mark of something that was here. Not footprints. "
                     "Something vaguer — a warp in the air. Eleanor felt it, and told no one."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (ashveil_hall_id, now))

    # ---- Items ----
    compass_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            compass_id, project_id, "item", "Aldric's Compass",
            json.dumps(["the compass", "the blood-compass", "the Ashveil compass"]),
            "A compass handed down in Eleanor's line. It binds a Hollow and holds memory. Eleanor "
            "left it on the hall's hearthstone ten years ago. 'It will always find your blood.'",
            doc_nodes(
                para("The compass is alive. There is no other way to put it. It is faintly warm to "
                     "the touch and turns as if it means to. The case is no wider than a palm, but "
                     "the needle answers more than north."),
                para("Set against a Hollow, it can seal the memory that thing carries. To seal it "
                     "fully takes the Sundering Rite, and the Rite cannot be worked alone. "
                     "Eleanor's line existed for exactly that."),
                para("That Eleanor lived ten years without the compass surprised even her. When she "
                     "went back to the hall and took it up, it was warm — as if it had been waiting."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (compass_id, tag_ids["arcane"]))
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (compass_id, now))
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), compass_id, def_ids["item.Status"], "Present"),
    )

    writ_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            writ_id, project_id, "item", "The Sealed Writ",
            json.dumps(["the writ", "the sealed letter", "that letter"]),
            "A sealed writ Eleanor finds on the hall's hearthstone. It names her, and sets out "
            "instructions tied to the Sundering Rite. The sender is unknown.",
            doc_nodes(
                para("The writ lay under the compass. The paper has not yellowed in ten years, and "
                     "the ink has not run. It is not ordinary paper."),
                para("On it is Eleanor's name, the two words 'Come back,' and the steps of the "
                     "Sundering Rite. The steps differ a little from the ones she knows. The last "
                     "line cannot be read — not blacked out, but the eye slides off it."),
                para("There is no sender's name. The hand seems half familiar, but she cannot place "
                     "whose it is."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (writ_id, tag_ids["arcane"]))
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), writ_id, def_ids["item.Status"], "Present"),
    )

    # ---- Lore ----
    rite_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            rite_id, project_id, "lore", "The Sundering Rite",
            json.dumps(["the Rite", "the binding rite", "the Ashveil rite"]),
            "The Hollow-binding rite Eleanor's line has worked for over a century. Using the "
            "compass, it seals a Hollow together with its memory. The last full working failed "
            "ten years ago.",
            doc_nodes(
                para("The Sundering Rite takes two. One holds the compass, the other speaks. With "
                     "either one missing it cannot be completed. For that reason Eleanor's line "
                     "always moved in numbers."),
                para("When the Rite succeeds, the Hollow's memory is sealed inside the compass. "
                     "That memory is also the source of its power, so the thing loses its strength "
                     "and fades."),
                para("What happened the night the Rite failed ten years ago, no one recorded "
                     "exactly. The only survivor was Eleanor, and she had not yet learned the "
                     "speaking."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (rite_id, tag_ids["arcane"]))
    conn.execute("INSERT INTO codex_quick_pins (entry_id,created_at) VALUES (?,?)", (rite_id, now))

    hollowing_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            hollowing_id, project_id, "lore", "The Hollowing",
            json.dumps(["the hollowing", "the thinning", "the open gate"]),
            "The unseen way that opens when a Hollow feeds. Once opened it cannot be closed "
            "without the compass. An open hollowing thins the memory of everyone near it.",
            doc_nodes(
                para("The hollowing is not a physical thing. If it must be named, it is a warp in "
                     "the air, sensed only by one who holds the compass. Eleanor saw it once, long "
                     "ago."),
                para("Where the hollowing is open, people's memory goes 'thin.' Yesterday cannot "
                     "be recalled; a face that should be known cannot be placed. The symptom "
                     "spreads outward."),
                para("Around Ashveil Hall, Eleanor felt that thinness. How long it has been open "
                     "she does not yet know."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (hollowing_id, tag_ids["arcane"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (hollowing_id, tag_ids["hollow"]))

    # ---- Tree ----
    # sort_order uses fractional-indexing form (TEXT).
    part1_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part1_id, project_id, "folder", "Part One: The Return", "a0",
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    # Foreshadow register IDs, fixed before building scene bodies.
    fs_compass_id = uid()       # the compass stayed dry / has will
    fs_memory_id = uid()        # another's memory
    fs_intruder_id = uid()      # the intruder at the hall
    fs_voice_id = uid()         # the forgotten voice
    fs_writ_author_id = uid()   # who wrote the writ (planned, no setup placed)
    fs_aldric_id = uid()        # Aldric's second face (planned payoff, no setup pos)
    fs_abandoned_id = uid()     # tracks in the wood (abandoned)
    # Extra debug samples (label coverage + AI eval + orphan + multi-setup)
    fs_seal_id = uid()          # the doubled seal (supporting x subtle -> needs_strengthening)
    fs_vane_id = uid()          # the new weathervane (optional x subtle -> seeded, warning silenced)

    setup_compass_id = uid()
    setup_memory_id = uid()
    setup_intruder_id = uid()
    setup_voice_id = uid()
    setup_seal_a_id = uid()        # subtle, human
    setup_seal_b_id = uid()        # moderate, AI-evaluated
    setup_seal_orphan_id = uid()   # is_orphan=1 (re-anchor UI debug)
    setup_vane_id = uid()          # subtle, human

    scene1_long_sentence = (
        "The hall was smaller than she remembered; in her memory it had been a great dark house "
        "ringed by old elms, but what stood in front of her now was a half-collapsed shell of "
        "the east wing and one wing that had somehow kept its roof."
    )
    scene1_id = uid()
    scene1_builder = _DocBuilder()
    scene1_builder.para("It smelled of rain — wet stone, leaf rot, and the faint ghost of old smoke.")
    scene1_builder.para("Eleanor stopped a few paces short of the gate. It had been ten years.")
    scene1_builder.para(scene1_long_sentence)
    scene1_builder.para("\"A ruin,\" she said.")
    scene1_builder.para("She had not meant to say it to anyone. It simply came out.")
    scene1_builder.para(
        "The door to the keeping-room was not locked. There had been a lock, but ",
        ("setup_intruder", "it had fallen, hasp and all",
         setup_mark(setup_intruder_id, fs_intruder_id)),
        ". Eleanor picked it up, turned it over for a while, and set it back where it had lain. "
        "It was no use now.",
    )
    scene1_builder.para("Inside, the floorboards spoke. One at every step.")
    scene1_builder.para("Something had been left on the old hearthstone.")
    scene1_builder.para("A compass.")
    scene1_builder.para(
        "Eleanor could not move. When she had left this place ten years ago, she had set the "
        "compass on the hearth and walked away. Someone had not taken it — they had left it "
        "here, all this time. Or it had come back."
    )
    scene1_builder.para(
        "She reached out slowly. ",
        ("setup_compass",
         "The compass was dry. It had been left to ten years of rain, and it was not wet.",
         setup_mark(setup_compass_id, fs_compass_id)),
    )
    scene1_builder.para("The moment her finger touched it, the memory came.")
    scene1_builder.para(
        ("setup_memory", "It was not her own memory.",
         setup_mark(setup_memory_id, fs_memory_id)),
    )
    # Aftermath paragraphs (label coverage + AI eval / multi-setup debug foreshadows)
    scene1_builder.para(
        "She let out a breath and drew back her hand. As she took the compass up again, ",
        ("setup_seal_a", "the seal pressed into its case sat differently than before",
         setup_mark(setup_seal_a_id, fs_seal_id)),
        ", or so it seemed.",
    )
    scene1_builder.para(
        "When she looked closely, ",
        ("setup_seal_b", "the mark was doubled, and she could not tell which was the true Ashveil seal",
         setup_mark(setup_seal_b_id, fs_seal_id)),
        ".",
    )
    scene1_builder.para(
        "Wind moved, and under the eaves ",
        ("setup_vane", "an iron weathervane that had not been there ten years ago",
         setup_mark(setup_vane_id, fs_vane_id)),
        " turned and gave a small, thin cry.",
    )
    scene1_content = scene1_builder.to_json()
    scene1_spans = scene1_builder.spans
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene1_id, project_id, part1_id, "scene", "Chapter One: The Hall",
            "On a night of rain, Eleanor returns to the ruined Ashveil Hall for the first time "
            "in ten years. The compass she left on the hearth still lies there. The moment she "
            "touches it, a memory that is not hers floods in.",
            "a0", "a1", "Ten years on, autumn",
            eleanor_id, ashveil_hall_id, "draft", scene1_content, now, now,
        ),
    )

    scene2_id = uid()
    scene2_content = doc_nodes(
        para("[OUTLINE]"),
        para("The morning after the hall. Eleanor wakes in the keeping-room. The compass is in "
             "her hand."),
        para("Beat 1: Eleanor tries to sort the fragments of the borrowed memory she received. "
             "Not images — shards of sensation and feeling. Someone was afraid. Someone was "
             "fleeing."),
        para("Beat 2: She finds the sealed writ. It had lain under the compass. Her name is on "
             "it. The two words 'Come back,' and the steps of the Sundering Rite. Only the last "
             "line cannot be read."),
        para("Beat 3: Wrenna arrives. 'So you came after all,' she says, and holds out a wrapped "
             "parcel. That is all. How she knew Eleanor would come, Eleanor does not ask. Wrenna "
             "does not explain."),
        para("To decide: who wrote the writ? Aldric? Eleanor's dead mother? Or the thing from the "
             "fire itself?"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene2_id, project_id, part1_id, "scene", "Chapter Two: The Writ",
            "At the hall, with the compass, Eleanor finds the sealed writ. It says 'Come back,' "
            "sets out the steps of the Sundering Rite, and ends on a line that cannot be read.",
            "a1", "a2", "Ten years on, the next morning",
            eleanor_id, ashveil_hall_id, "outline", scene2_content, now, now,
        ),
    )

    # Flashback scene: read order a2 (third), but earliest in story time (a0).
    # Timeline debug: lets you see read-order != story-time.
    scene_flashback_id = uid()
    flashback_builder = _DocBuilder()
    flashback_builder.para("[Memory: ten years ago, summer]")
    flashback_builder.para("The house was burning.")
    flashback_builder.para(
        "Eleanor had stood before the keeping-room. She still did not understand what had "
        "happened. The fire wrapped the east wing, caught the elms, and stained the night hills "
        "red."
    )
    flashback_builder.para(
        "\"Get back,\" a voice said. Whose voice it was, Eleanor still cannot say."
    )
    flashback_builder.para("She ran. The compass in her hand, she simply ran.")
    flashback_builder.para("When she looked back, the roof of the east wing came down.")
    flashback_builder.para(
        "What had been inside the house that night — she saw it. She must have seen it. But now "
        "only the colour of the fire, the heat, and ",
        ("setup_voice", "someone's shout",
         setup_mark(setup_voice_id, fs_voice_id)),
        " remain.",
    )
    scene_flashback_content = flashback_builder.to_json()
    scene_flashback_spans = flashback_builder.spans
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene_flashback_id, project_id, part1_id, "scene", "Memory: The Night of the Fire",
            "Ten years ago, on a summer night, Ashveil Hall burned. Eleanor was there. Something "
            "was inside the fire — but only fragments of the memory remain.",
            "a2", "a0", "Ten years ago, a summer night",
            eleanor_id, ashveil_hall_id, "outline", scene_flashback_content, now, now,
        ),
    )

    # Interlude: turns fs_intruder_id (the intruder at the hall) into a confirmed payoff.
    # The lock that "had fallen, hasp and all" in chapter one is confirmed on a moonlit return.
    scene_payoff_id = uid()
    payoff_builder = _DocBuilder()
    payoff_builder.para("The moon was up. Eleanor went back to the keeping-room once more.")
    payoff_builder.para(
        "Beside the hearth, in a place she had not noticed the first time, something lay. She "
        "crouched and picked it up — the remains of an old token, a thread of faded Ashveil "
        "vermilion still on its face."
    )
    payoff_builder.para(
        "It was the token her mother had tied to the hearth ten years ago, knotted before the "
        "fire, and no one should have touched it since."
    )
    payoff_builder.para(
        "Holding the token, she turned toward the door. ",
        ("payoff_intruder",
         "The hand that knocked the lock from its hasp had untied this, too",
         payoff_mark(fs_intruder_id)),
        ".",
    )
    payoff_builder.para(
        "Someone has been coming to the hall. Ever since the fire, all this time."
    )
    scene_payoff_content = payoff_builder.to_json()
    scene_payoff_spans = payoff_builder.spans
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene_payoff_id, project_id, part1_id, "scene", "Interlude: The Hearthstone",
            "On a moonlit return to the keeping-room, Eleanor finds the remains of a token that "
            "should not have been touched in ten years. The same hand that took down the lock "
            "had untied this, too.",
            "a3", "a3", "Ten years on, deep night",
            eleanor_id, ashveil_hall_id, "draft", scene_payoff_content, now, now,
        ),
    )
    payoff_intruder_from, payoff_intruder_to = scene_payoff_spans["payoff_intruder"]

    part2_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part2_id, project_id, "folder", "Part Two: The Crown", "a1",
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    scene3_id = uid()
    scene3_content = doc_nodes(
        para("[OUTLINE - to be written]"),
        para("Back in Ironhaven, Eleanor meets the Citadel knight Aldric."),
        para("Purpose: introduce Aldric. Plain-looking and courteous on the surface, but "
             "something is off — the face of a man who knows a thing and is not saying it."),
        para("Aldric already knows why Eleanor went home. That becomes a planted hook."),
        para("To decide: does Aldric approach Eleanor, or does Eleanor seek out Aldric? Which one "
             "moves first changes the first read on the balance of power between them."),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
            pov_character_id,location_id,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene3_id, project_id, part2_id, "scene", "Chapter Three: Ironhaven by Night",
            "Back in Ironhaven, the Citadel knight Aldric appears. He somehow already knew that "
            "Eleanor had gone to Greymoor.",
            "a0", "a3", "Ten years on, after the return",
            eleanor_id, ironhaven_id, "outline", scene3_content, now, now,
        ),
    )

    # Notes folder ('default-chapter' id avoids colliding with the Rust migration's INSERT).
    notes_folder_id = "default-chapter"
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (notes_folder_id, project_id, "folder", "Notes", "a2",
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    research_note_id = uid()
    research_content = doc_nodes(
        heading(2, "Research Notes"),
        para("On the Sundering Rite: I need to pin down the difference between 'binding' and "
             "'sealing.' Binding is a temporary hold; sealing fixes the memory permanently. If "
             "the Rite fails, does the thing stay bound but unsealed?"),
        para("Records of the Hollow: assume the oldest record sits in the Citadel's sealed vault. "
             "Use the setup that Aldric holds a key. I have to decide whether the Hollow is one "
             "individual or several of a kind. For now I'm writing it as one."),
        para("Candidate truths of the fire ten years ago:\n"
             "1) The Sundering Rite failed and the Hollow escaped\n"
             "2) The Hollow set the fire to break the Rite\n"
             "3) Aldric was involved (the core of Part Two)\n"
             "4) Eleanor's mother failed the Rite on purpose (saved for the last surprise)"),
        para("TODO: settle why Wrenna stayed near the hall for ten years. To guard the compass? "
             "To wait for Eleanor? Or some other purpose?"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            research_note_id, project_id, notes_folder_id, "note", "Research Notes",
            "a0", "outline", research_content, now, now,
        ),
    )

    # ---- Foreshadow register ----
    fs_now_ms = ts_ms()

    # payoff_scene_id + payoff_confirmed=1 + setupCount>=1 -> "paid"
    # payoff_scene_id + payoff_confirmed=1 + setupCount=0  -> "orphan_payoff"
    # abandoned=1 -> "abandoned"
    # otherwise the setup strength splits into seeded / needs_strengthening / planned
    foreshadow_rows = [
        # (id, title, intent, notes,
        #  payoff_scene_id, payoff_from_pos, payoff_to_pos,
        #  payoff_confirmed, abandoned, load_bearing)
        (fs_compass_id, "The Compass Stays True",
         "Pay off the fact that the compass stayed dry for ten years as the setup for "
         "'the compass was waiting for Eleanor / has a will of its own.'",
         "Option: strengthen the warmth Eleanor feels when she touches it in scene 1.",
         None, None, None, 0, 0, "critical"),
        (fs_memory_id, "Another's Memory",
         "Reveal later that the flood of 'someone's fear' on touching the compass is the "
         "residual mind of a survivor of the failed rite (Eleanor's mother?).",
         "Currently weak as subtext. Deciding whether to strengthen the setup or add one.",
         None, None, None, 0, 0, "critical"),
        (fs_intruder_id, "The Intruder at the Hall",
         "Make the fallen lock function as proof that the Hollow (or someone else) has been "
         "coming to the hall since the events of ten years ago.",
         "Confirmed in the interlude 'The Hearthstone,' linked to the token's remains.",
         scene_payoff_id, payoff_intruder_from, payoff_intruder_to, 1, 0, "supporting"),
        (fs_voice_id, "The Forgotten Voice",
         "Reveal at the Part Two climax that the shouting voice in the memory was Aldric's. The "
         "reason Eleanor cannot recall it is a side effect of the Hollow's feeding.",
         "The voice's owner is still wavering among Aldric / Eleanor's mother / the Hollow.",
         None, None, None, 0, 0, "critical"),
        (fs_writ_author_id, "Who Wrote the Writ",
         "Who wrote the sealed writ left under the compass. Aldric is the leading candidate, but "
         "leave room for it to be the dead mother's last letter.",
         "No setup placed until the sender is fixed (decide first, then write).",
         None, None, None, 0, 0, None),
        (fs_aldric_id, "Aldric's Second Face",
         "Hint in chapter three that Aldric tracks the Hollow privately behind his official work, "
         "and at his involvement in the fire ten years ago.",
         "Chapter three is the tentative payoff scene. Setup to be back-filled while writing "
         "chapter two.",
         scene3_id, None, None, 1, 0, "supporting"),
        (fs_abandoned_id, "Tracks in the Wood",
         "An idea to trace the Hollow's presence from footprints in the elm wood. Dropped, "
         "because it clashes with the 'a Hollow leaves no tracks' rule.",
         "Replaced with the 'warp in the air' description (see the Ashveil Hall codex body).",
         None, None, None, 0, 1, "optional"),
        # -- Debug samples --
        (fs_seal_id, "The Doubled Seal",
         "From the fact that the seal pressed into the compass case is doubled, reveal later that "
         "someone has been rewriting the rite. Make it evidence that Aldric or the Hollow "
         "intervened.",
         "[debug] baseline case for supporting x subtle -> needs_strengthening. Includes a "
         "two-stage setup (setup_seal_a subtle/human, setup_seal_b moderate/AI eval) and an "
         "is_orphan=1 orphan setup (for the re-anchor UI).",
         None, None, None, 0, 0, "supporting"),
        (fs_vane_id, "The New Weathervane",
         "Hint that the iron weathervane under the eaves was set by someone, telling of a quiet "
         "watcher (Wrenna's grandfather?). Payoff timing undecided.",
         "[debug] for the optional x subtle silence case. Even when anyWeak, no warning fires and "
         "the seeded label is chosen.",
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

    # foreshadow_setups (positions match the marks in the scene bodies)
    # aiReasoning JSON for the AI-evaluated setup (careful/casual/skim persona evals)
    seal_b_ai_reasoning = json.dumps({
        "careful": {
            "strength": "moderate",
            "reasoning": "The concrete image of a doubled seal lets an observant reader suspect "
                         "the rite has been altered. A clue that works as later foreshadowing.",
        },
        "casual": {
            "strength": "subtle",
            "reasoning": "A detail like a doubled seal-mark is easy to miss on a casual read. "
                         "Catching it depends on the reader's attention.",
        },
        "skim": {
            "strength": "subtle",
            "reasoning": "Embedded in the scene description, it slips past a hurried read.",
        },
    })

    setup_rows = [
        # (id, foreshadow_id, scene_id, span_dict, span_key, kind,
        #  strength, ai_strength, ai_reasoning, attribution, ai_rationale,
        #  last_evaluated_at, is_orphan, from_pos_override, to_pos_override)
        (setup_compass_id, fs_compass_id, scene1_id, scene1_spans, "setup_compass",
         "designated_existing", "moderate", None, None, "human", None,
         None, 0, None, None),
        (setup_memory_id, fs_memory_id, scene1_id, scene1_spans, "setup_memory",
         "designated_existing", "subtle", None, None, "human", None,
         None, 0, None, None),
        (setup_intruder_id, fs_intruder_id, scene1_id, scene1_spans, "setup_intruder",
         "designated_existing", "moderate", None, None, "human", None,
         None, 0, None, None),
        (setup_voice_id, fs_voice_id, scene_flashback_id, scene_flashback_spans,
         "setup_voice", "designated_existing", "overt", None, None, "human", None,
         None, 0, None, None),
        # The Doubled Seal: subtle / human
        (setup_seal_a_id, fs_seal_id, scene1_id, scene1_spans, "setup_seal_a",
         "designated_existing", "subtle", None, None, "human", None,
         None, 0, None, None),
        # The Doubled Seal: AI-evaluated (strength=null + aiStrength + aiReasoning JSON, attribution=ai)
        (setup_seal_b_id, fs_seal_id, scene1_id, scene1_spans, "setup_seal_b",
         "designated_existing", None, "moderate", seal_b_ai_reasoning, "ai",
         "The doubled seal is a concrete visual. For an observant reader it does its work.",
         fs_now_ms, 0, None, None),
        # The Doubled Seal: orphan setup (no mark in the span, DB row only; re-anchor UI)
        (setup_seal_orphan_id, fs_seal_id, scene1_id, None, None,
         "designated_existing", "subtle", None, None, "human", None,
         None, 1, 1, 8),
        # The New Weathervane: subtle / human
        (setup_vane_id, fs_vane_id, scene1_id, scene1_spans, "setup_vane",
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

    # foreshadow_codex_links
    for fid, codex_id in [
        (fs_compass_id, compass_id),
        (fs_compass_id, eleanor_id),
        (fs_memory_id, compass_id),
        (fs_memory_id, eleanor_id),
        (fs_intruder_id, ashveil_hall_id),
        (fs_intruder_id, mira_id),
        (fs_voice_id, aldric_id),
        (fs_voice_id, eleanor_id),
        (fs_writ_author_id, writ_id),
        (fs_writ_author_id, rite_id),
        (fs_aldric_id, aldric_id),
        (fs_aldric_id, mira_id),
        (fs_abandoned_id, ashveil_hall_id),
        # debug foreshadow codex links
        (fs_seal_id, rite_id),
        (fs_seal_id, compass_id),
        (fs_vane_id, ashveil_hall_id),
    ]:
        conn.execute(
            """INSERT INTO foreshadow_codex_links
               (foreshadow_id,codex_entry_id) VALUES (?,?)""",
            (fid, codex_id),
        )

    # ---- Snippets ----
    snippet1_id = uid()
    conn.execute(
        """INSERT INTO snippets
           (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            snippet1_id, project_id, "The Compass, Again",
            html_paragraphs(
                "The compass was dry. It had been left to ten years of rain, and it was not wet.",
                "The moment her finger touched it, the memory came — and it was not her own. "
                "Someone was running through the elm wood, at night, fleeing something. Only the "
                "feel of the fear stayed, sharp and entire.",
            ),
            "human", scene1_id, 0, now, now,
        ),
    )
    conn.execute("INSERT INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                 (snippet1_id, tag_ids["arcane"]))

    snippet2_id = uid()
    conn.execute(
        """INSERT INTO snippets
           (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            snippet2_id, project_id, "The Hall, at the Door",
            html_paragraphs(
                "The door to the keeping-room was not locked. There had been a lock, but it had "
                "fallen, hasp and all.",
                "Eleanor picked it up, turned it over for a while, and set it back where it had "
                "lain. Someone had gone in here. Or something had come out. Either way, the lock "
                "had never meant a thing.",
            ),
            "human", scene1_id, 0, now, now,
        ),
    )
    conn.execute("INSERT INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                 (snippet2_id, tag_ids["protagonist"]))

    # ---- Chat session ----
    session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            session_id, project_id, scene1_id,
            "Developing Eleanor's voice",
            1,
            "openrouter/anthropic/claude-sonnet-4.6",
            now, now,
        ),
    )
    chat_msg_ids: list[str] = []
    chat_messages_seed = [
        ("user",
         "I've written the opening of chapter one, but Eleanor's voice still isn't set. She's "
         "someone who holds her feelings in, so I want even the narration to keep emotion from "
         "surfacing directly. Instead of 'going back to the hall frightened her,' could you write "
         "a paragraph that shows it through action and description?",
         False, True),
        ("assistant",
         "Here's one direction:\n\n"
         "At the gate, Eleanor stopped once. She could not have said why she stopped. There was "
         "the smell of grass. An elm moved. For nothing more than that, she could not go on. She "
         "counted to three, and then began to walk again.\n\n"
         "It shows the inner shake through the action 'counted to three' without naming the "
         "feeling ('afraid,' 'uneasy'), and at the same time it reads her as someone who governs "
         "herself.",
         True, True),
        ("user",
         "'Counted to three' is good — I'll keep it. I'd like to save this paragraph as a snippet "
         "to reference later.",
         False, True),
        ("assistant",
         "Done. Something like 'How Eleanor steadies herself' makes a usable title. If you let "
         "this tic surface every time she's under emotional pressure, it becomes a barometer of "
         "her state for the reader.",
         False, True),
        # Recent exchange after the summary (is_summarized=0, last assistant starred)
        ("user",
         "By the way, I want the temperature of the moment she touches the compass to be more "
         "concrete. Just 'it was dry' slides past too easily.",
         False, False),
        ("assistant",
         "Two options.\n\n"
         "1) Add one tactile simile: 'It was dry. A dull warmth, like the banked heat of a winter "
         "hearth, stayed on her fingertips.'\n"
         "2) Add a line of Eleanor's body: 'Her fingers shook. Not from the cold.'\n\n"
         "Option 1 leans on the compass; option 2 leans on Eleanor. Choose by where the weight of "
         "the moment sits.",
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

    # ---- Map ----
    # Uses the board auto-created by the seed_default_map_board trigger.
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
             json.dumps(labels or []),
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

    # Node layout: character column (x~120) / place+item column (x~420) / scene column (x~720)
    pos_eleanor    = map_pos_codex(eleanor_id,         120.0,  100.0)
    pos_wren       = map_pos_codex(wren_id,            120.0,  320.0)
    pos_aldric     = map_pos_codex(aldric_id,          120.0,  540.0)
    pos_mira       = map_pos_codex(mira_id,            120.0,  760.0)
    pos_hall       = map_pos_codex(ashveil_hall_id,    420.0,  200.0)
    pos_compass    = map_pos_codex(compass_id,         420.0,  440.0)
    pos_greymoor   = map_pos_codex(greymoor_id,        420.0,  680.0)
    pos_s_flashbk  = map_pos_scene(scene_flashback_id, 720.0, -100.0)
    pos_s1         = map_pos_scene(scene1_id,          720.0,  140.0)
    pos_s2         = map_pos_scene(scene2_id,          720.0,  360.0)
    pos_s3         = map_pos_scene(scene3_id,          720.0,  580.0)

    # Snippets on the map (x~1020): pins that draw the eye to body fragments.
    pos_snip_again = map_pos_snippet(snippet1_id, 1020.0, 200.0)
    pos_snip_door  = map_pos_snippet(snippet2_id, 1020.0, 420.0)

    # Free notes (stickies): a concept note and an open question, scattered in colour.
    sticky_motive_id = make_sticky(
        board=board_id,
        title="Eleanor's motive (note)",
        paragraphs=[
            "Put 'lay the night to rest' above 'learn the truth.'",
            "The curiosity is the surface; the root is the work of grief.",
        ],
        color_slot=0,  # Sunnyside
    )
    sticky_question_id = make_sticky(
        board=board_id,
        title="Open: whose memory does the Hollow feed on?",
        paragraphs=[
            "Candidate A: the mother (emotional) / Candidate B: Aldric (plot-led)",
            "Decide by the feel of chapter two. Don't touch it until then.",
        ],
        color_slot=2,  # Tropical Pink
    )
    pos_sticky_motive   = map_pos_sticky(sticky_motive_id,   320.0, -120.0)
    pos_sticky_question = map_pos_sticky(sticky_question_id, 820.0, 800.0)

    # Edges: relationships (with forward/backward labels and labels arrays)
    map_edge(pos_eleanor,   pos_hall,      forward_label="returns to",  style="solid",  color="#534AB7", direction="forward")
    map_edge(pos_eleanor,   pos_compass,   forward_label="carries",     style="solid",  color="#534AB7", direction="forward")
    map_edge(pos_eleanor,   pos_wren,      forward_label="old friend",  style="dashed", color="#5B8CDD")
    map_edge(pos_eleanor,   pos_aldric,
             forward_label="entangled", backward_label="watches",
             style="dashed", color="#993C1D", direction="bidirectional")
    map_edge(pos_mira,      pos_hall,      forward_label="trace of",    style="dotted", color="#CC3333")
    map_edge(pos_hall,      pos_greymoor,  forward_label="stands above", style="solid", color="#0F6E56", direction="forward")
    map_edge(pos_s_flashbk, pos_hall,      forward_label="ten years ago", style="dotted", color="#BA7517")
    map_edge(pos_s1,        pos_hall,
             forward_label="setting",
             labels=["opening", "draws the eye"],
             style="solid", color="#888888")
    map_edge(pos_s2,        pos_hall,      forward_label="setting",     style="solid",  color="#888888")
    # Snippet -> scene: writing-reference links
    map_edge(pos_snip_again, pos_s1,       forward_label="from body",   style="dashed", color="#888888", direction="forward")
    map_edge(pos_snip_door,  pos_s1,       forward_label="from body",   style="dashed", color="#888888", direction="forward")
    # Stickies -> related nodes
    map_edge(pos_sticky_motive,   pos_eleanor, forward_label="motive",   style="dashed", color="#999999")
    map_edge(pos_sticky_question, pos_s3,      forward_label="held",     style="dotted", color="#999999")

    # Frame: gather the Part One scenes
    conn.execute(
        """INSERT INTO map_frames
           (id,board_id,title,x,y,width,height,background,border_color,z_index,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid(), board_id, "Part One: The Return",
         620.0, -210.0, 280.0, 690.0,
         "#f0f0ff", "#8080cc", -1, now, now),
    )

    # ---- Lint term dictionary ----
    now_ms = ts_ms()
    for i, (preferred, variants, severity, note) in enumerate([
        ("Ashveil Hall",
         ["the Ashveil house", "the manor", "the old hall"],
         "warning",
         "Proper noun for this work. Ignore where the common-noun use is deliberate."),
        ("Ashveil Hall (ruined)",
         ["the ruin", "the burnt hall", "the broken house"],
         "warning",
         "Keep the ruined Greymoor seat under one name."),
        ("the Citadel",
         ["the fortress", "the ward office", "the arcane bureau"],
         "warning",
         "Official name of the institution."),
        ("the records office",
         ["the archive house", "the record hall", "the document office"],
         "info",
         "Name of Eleanor's workplace."),
        ("the Sundering Rite",
         ["the binding rite", "the sealing rite"],
         "info",
         "Official name of the rite. 'the Rite' alone is acceptable as a short form."),
    ]):
        conn.execute(
            """INSERT INTO lint_term_dictionary
               (id,preferred,variants,severity,note,enabled,sort_order,created_at,updated_at)
               VALUES (?,?,?,?,?,1,?,?,?)""",
            (uid(), preferred, json.dumps(variants),
             severity, note, i, now_ms, now_ms),
        )

    # ---- Persisted lint-ignore sample (intentional long sentence for en/sentence-length) ----
    conn.execute(
        """INSERT INTO lint_ignored_diagnostics
           (id,rule_id,scene_id,text_snippet,context_before,context_after,note,created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            uid(), "en/sentence-length", scene1_id,
            scene1_long_sentence,
            "Eleanor stopped a few paces short of the gate. It had been ten years.",
            "\"A ruin,\" she said.",
            "The long descriptive sentence is intentional.",
            now_ms,
        ),
    )

    # ---- Lint action log ----
    for rule_id, action, sid in [
        ("project/term-consistency", "detected",               scene1_id),
        ("project/term-consistency", "fixed",                  scene1_id),
        ("en/dialogue-punctuation",  "detected",               scene1_id),
        ("en/dialogue-punctuation",  "ignored_once",           scene1_id),
        ("en/word-repetition",       "detected",               scene2_id),
        ("en/sentence-length",       "ignored_persistent_set", scene1_id),
    ]:
        conn.execute(
            "INSERT INTO lint_action_log (rule_id,action,scene_id,occurred_at) VALUES (?,?,?,?)",
            (rule_id, action, sid, now_ms),
        )

    # ================================================================
    # Debug-oriented extra data (authorship / phase / version / chat / map)
    # ================================================================

    # ---- Reinforce existing codex / snippet (excluded_aliases / notes / source_chat_message_id) ----
    conn.execute(
        "UPDATE codex_entries SET excluded_aliases=?, notes=?, source_chat_message_id=? WHERE id=?",
        (
            json.dumps(["Ash", "the heir"]),
            "Exclude 'Ash' when it stands alone as a proper noun.\n"
            "Exclude 'the heir' to avoid collisions with generic usage.",
            chat_msg_ids[1],
            eleanor_id,
        ),
    )
    conn.execute(
        "UPDATE snippets SET source_chat_message_id=? WHERE id=?",
        (chat_msg_ids[1], snippet1_id),
    )

    # ---- codex_dismissed_relations ----
    conn.execute(
        "INSERT INTO codex_dismissed_relations (entry_id, dismissed_id) VALUES (?, ?)",
        (eleanor_id, aldric_id),
    )

    # ---- Full coverage of context_mode / children_budget variants ----
    suppress_lore_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            suppress_lore_id, project_id, "lore", "The Forbidden Name",
            json.dumps(["the forbidden name", "the name not spoken"]),
            "An old name said to draw the Hollow's notice when spoken aloud. "
            "[debug] a typical case for context_mode=suppress, kept out of the AI context.",
            doc_nodes(
                para("A set of proper nouns hinted at to the reader only. Showing them to the AI "
                     "invites it to leap ahead of the plot, so context_mode=suppress keeps them "
                     "sealed at all times."),
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
            hidden_char_id, project_id, "character", "Lady Ashveil (deceased)",
            json.dumps(["Eleanor's mother", "the Lady", "the late Lady Ashveil"]),
            "[spoiler / debug] The true architect of the rite ten years ago. "
            "For checking context_mode=hidden: shown in the UI but never sent to the AI.",
            doc_nodes(
                para("The final piece of the plot. Intended to be disclosed from Part Three on. "
                     "With context_mode=hidden the AI never sees it."),
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
            none_budget_loc_id, project_id, "location", "Ironhaven, the North Causeway",
            json.dumps(["the North Causeway", "the causeway"]),
            "The avenue lined with the court's buildings. [debug] a sample for confirming "
            "children_budget=none.",
            doc_nodes(
                para("Named on stage but never made the centre of a scene. For checking "
                     "children_budget=none, which cuts child exposure to the AI entirely."),
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
            generous_budget_lore_id, project_id, "lore", "The Ashveil Inheritance",
            json.dumps(["the Ashveil inheritance", "the line's keeping", "the vermilion craft"]),
            "Core setting referenced again and again. "
            "[debug] used to confirm children_budget=generous passes more child elements.",
            doc_nodes(
                para("The line carries several lore, lineage, and rite elements, all of which bear "
                     "on the main thread. When delivering context, allow children generously."),
            ),
            "mentioned", "generous", now, now,
        ),
    )

    # ---- Candidate payoff (payoff_confirmed=0 + payoff_scene_id set) ----
    fs_candidate_id = uid()
    conn.execute(
        """INSERT INTO foreshadows
           (id,project_id,title,intent,notes,payoff_scene_id,
            payoff_from_pos,payoff_to_pos,payoff_confirmed,abandoned,
            load_bearing,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            fs_candidate_id, project_id,
            "The Wax Seal",
            "Make the reader realize later that the wax seal on the parcel Wrenna holds out bears "
            "the Ashveil crest. [debug] reproduces the 'candidate' state: payoff_confirmed=0 with "
            "payoff_scene_id already set.",
            "First appears in chapter two, beat 3. Plan to back-fill the setup later.",
            scene2_id, None, None, 0, 0, "supporting",
            fs_now_ms, fs_now_ms,
        ),
    )
    conn.execute(
        "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id) VALUES (?, ?)",
        (fs_candidate_id, wren_id),
    )

    # ---- codex_entry_phases / codex_phase_detail_overrides ----
    eleanor_phase_pre = uid()
    conn.execute(
        """INSERT INTO codex_entry_phases
           (id,entry_id,anchor_node_id,label,summary_override,content_override,context_mode_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            eleanor_phase_pre, eleanor_id, None, "Before the return (ten years in Ironhaven)",
            "Eleanor living quietly as a records clerk in the city. She has sealed the compass "
            "away and lives without touching her power.",
            None, "mentioned", now, now,
        ),
    )
    eleanor_phase_post = uid()
    eleanor_phase_post_content = doc_nodes(
        para("After the return, Eleanor's habit of holding her feelings in grows stronger. The "
             "more she is shaken, the blanker her face becomes."),
        para("Since touching the compass, another's memory floods in from time to time."),
    )
    conn.execute(
        """INSERT INTO codex_entry_phases
           (id,entry_id,anchor_node_id,label,summary_override,content_override,context_mode_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            eleanor_phase_post, eleanor_id, scene1_id, "After the return (the compass at the hall)",
            "Eleanor from the moment she touches the compass at the hall. The power she had "
            "sealed begins to move again, and she enters the stage of facing the memory of ten "
            "years ago.",
            eleanor_phase_post_content, "always", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value) VALUES (?, ?, ?)",
        (
            eleanor_phase_post, def_ids["character.Motivation"],
            "Bind the Hollow. Answer for the thing she left behind ten years ago.",
        ),
    )

    aldric_phase = uid()
    conn.execute(
        """INSERT INTO codex_entry_phases
           (id,entry_id,anchor_node_id,label,summary_override,content_override,context_mode_override,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            aldric_phase, aldric_id, scene3_id, "From chapter three (re-contact with Eleanor)",
            "The stage where, sensing Eleanor's return to Ironhaven, he begins to act on his own.",
            None, None, now, now,
        ),
    )

    # ---- authorship_spans ----
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

    # Snippet bodies are HTML ("<p>...</p><p>...</p>"). After TipTap loads them the
    # ProseMirror positions match a plain paragraph sequence, so extract paragraph
    # text and compute from/to with the same rule as _doc_para_ranges.
    def _html_para_ranges(html: str) -> list[tuple[int, int]]:
        paragraphs = re.findall(r"<p>(.*?)</p>", html, flags=re.S)
        pos = 0
        ranges: list[tuple[int, int]] = []
        for text in paragraphs:
            text_start = pos + 1
            text_len = len(text)
            ranges.append((text_start, text_start + text_len))
            pos += 2 + text_len
        return ranges

    # scene1: mix human / ai / unknown by paragraph
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

    eleanor_doc_row = conn.execute(
        "SELECT content FROM codex_entries WHERE id=?", (eleanor_id,)
    ).fetchone()
    _attribute_doc("codex_entry_id", eleanor_id, eleanor_doc_row[0], "human", None, None)

    # Mark Eleanor codex's Motivation detail_value as AI-derived
    motive_row = conn.execute(
        "SELECT id, value FROM codex_detail_values WHERE entry_id=? AND definition_id=?",
        (eleanor_id, def_ids["character.Motivation"]),
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

    # AI-edited span inside the phase content_override (needs phase_id + codex_entry_id)
    _attribute_doc("codex_entry_id", eleanor_id, eleanor_phase_post_content,
                   "ai", "anthropic/claude-sonnet-4.6", chat_msg_ids[5],
                   phase_col_id=eleanor_phase_post)

    # ---- content_versions / project_snapshots ----
    scene1_v1_id = uid()
    conn.execute(
        """INSERT INTO content_versions
           (id,entity_type,entity_id,content,version_number,snapshot_type,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (scene1_v1_id, "scene", scene1_id,
         doc_nodes(
             para("[First draft]"),
             para("Eleanor stopped in front of the gate. It had been ten years."),
             para("The hall was smaller than she remembered."),
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
             para("It smelled of rain."),
             para("Eleanor stopped a few paces short of the gate. It had been ten years."),
             para("The hall was smaller than she remembered; in her memory it had been a great "
                  "house, but only a shell stood in front of her now."),
             para("The door to the keeping-room had fallen, hasp and all."),
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
             para("It smelled of rain — wet stone, leaf rot, and the faint ghost of old smoke."),
             para("Eleanor stopped a few paces short of the gate. It had been ten years."),
             para("The door to the keeping-room was not locked. There had been a lock, but it had "
                  "fallen, hasp and all."),
             para("Something had been left on the hearthstone. A compass."),
         ),
         3, "manual", now),
    )

    eleanor_v1_id = uid()
    conn.execute(
        """INSERT INTO content_versions
           (id,entity_type,entity_id,content,version_number,snapshot_type,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (eleanor_v1_id, "codex_entry", eleanor_id,
         doc_nodes(
             para("Eleanor is in her late twenties. Ten years in the city's records office."),
             para("Last of the line that worked the compass. But she lives now as if she had "
                  "forgotten it."),
         ),
         1, "auto", now),
    )

    snapshot_id = uid()
    conn.execute(
        """INSERT INTO project_snapshots (id, project_id, name, description, created_at)
           VALUES (?,?,?,?,?)""",
        (snapshot_id, project_id, "Part One draft checkpoint",
         "A snapshot taken when the Part One first draft was roughly complete.", now),
    )
    for vid in (scene1_v3_id, eleanor_v1_id):
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
         "Discussed Eleanor's voice (holding feeling in, showing the interior through action and "
         "gesture). The AI proposed the 'counted to three' gesture motif, agreed to use it as a "
         "barometer of her state.",
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
        (uid(), session_id, eleanor_id, 1, "manual", now),
    )
    conn.execute(
        """INSERT INTO chat_session_pinned_codex
           (id,session_id,codex_entry_id,snippet_id,with_children,pin_source,created_at)
           VALUES (?,?,NULL,?,?,?,?)""",
        (uid(), session_id, snippet1_id, 0, "chat_mention", now),
    )

    # ---- Extra chat sessions (empty session; another scene link) ----
    empty_session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (empty_session_id, project_id, scene2_id, "New conversation", 0,
         "openrouter/anthropic/claude-sonnet-4.6", now, now),
    )

    flashback_session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (flashback_session_id, project_id, scene_flashback_id,
         "Candidates for the shouting voice", 1,
         "openrouter/anthropic/claude-sonnet-4.6", now, now),
    )
    for role, text in [
        ("user", "Who should shout 'Get back' in the memory? I'm torn between Aldric / the mother "
                 "/ the Hollow."),
        ("assistant",
         "Each of the three raises a different theme.\n"
         "- Aldric: 'tried to save her and couldn't' regret. Becomes the spine of Part Two.\n"
         "- the mother: a 'last act of protection' memory. Leans emotional.\n"
         "- the Hollow: a 'warning before it fed.' Thickens the setting hook.\n"
         "If unsure, write it as Aldric for now and decide by the feel of chapter two."),
    ]:
        conn.execute(
            "INSERT INTO chat_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)",
            (uid(), flashback_session_id, role, text, now),
        )

    # ---- AI branch (radial from seed nodes) ----
    ai_branch_id = uid()
    conn.execute(
        """INSERT INTO map_ai_branches
           (id,board_id,prompt,seed_node_ids,session_id,model,token_usage,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (ai_branch_id, board_id,
         "In the first confrontation between Eleanor and Aldric, which of them should speak first?",
         json.dumps([pos_eleanor, pos_aldric, pos_s3]),
         session_id, "anthropic/claude-sonnet-4.6", 412, now, now),
    )
    pos_ai_branch = map_pos_ai_branch(ai_branch_id, 920.0, 580.0)

    # Response-card stickies derived from the branch (3 placed radially)
    branch_sticky_specs = [
        ("From Eleanor", [
            "The initiative of the tension passes to Eleanor; the reader takes her will easily.",
            "But mind the 'she doesn't say things' characterization.",
        ], 4),  # Blue Paradise
        ("From Aldric", [
            "Eleanor's silence carries weight; Aldric's goodwill (or false goodwill) comes "
            "forward.",
            "Choose this if chapter two should sit in Eleanor's interior.",
        ], 5),  # Iris Infusion
        ("A third voice", [
            "Wrenna cuts in. The tension dissolves but the theme weakens.",
            "Reject if you want to keep the axis of conflict.",
        ], 1),  # Vital Orange
    ]
    branch_sticky_positions: list[str] = []
    for i, (title, paragraphs, slot) in enumerate(branch_sticky_specs):
        sid_st = make_sticky(
            board=board_id, title=title, paragraphs=paragraphs,
            color_slot=slot, ai_branch_id=ai_branch_id,
            source_chat_message_id=chat_msg_ids[1] if i == 0 else None,
        )
        # place radially around the branch at radius 220, every 120 degrees
        angle = (2 * math.pi / 3) * i - math.pi / 2
        sx = 920.0 + 220 * math.cos(angle)
        sy = 580.0 + 220 * math.sin(angle)
        bp = map_pos_sticky(sid_st, sx, sy)
        branch_sticky_positions.append(bp)
        map_edge(pos_ai_branch, bp, style="dashed", color="#999999", direction="forward")

    map_edge(pos_ai_branch, pos_s3, forward_label="weighing", style="dashed", color="#999999")

    conn.execute(
        """INSERT INTO map_frames
           (id,board_id,title,x,y,width,height,background,border_color,z_index,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid(), board_id, "AI: who opens the confrontation",
         640.0, 320.0, 580.0, 540.0,
         "#fff5f5", "#cc9999", -1, now, now),
    )

    # ---- Second map board (timeline view) ----
    board2_id = uid()
    conn.execute(
        """INSERT INTO map_boards
           (id, project_id, title, sort_order, mode, viewport_x, viewport_y, viewport_zoom, show_config, color_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (board2_id, project_id, "Timeline view", 1.0,
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
        (uid(), board2_id, "Story time (independent of read order)",
         100.0, -60.0, 280.0, 980.0,
         "#fff8f0", "#ccaa88", -1, now, now),
    )

    # ---- Extra scenes for status-variant coverage ----
    status_variant_ids: dict[str, str] = {}
    for title, syn, status_, sort, story in [
        ("Bonus: The Origin of the Compass (complete)",
         "A short chapter on where the compass came from. For checking the complete flag.",
         "complete", "a1", "Prehistory"),
        ("Bonus: Beneath the Citadel (revision)",
         "A chapter first depicting the sealed vault. Awaiting revision.",
         "revision", "a2", "Ten years on, early winter"),
        ("Bonus: The Litany of the Burning Night (final)",
         "The full text of the litany her mother spoke in the memory. Finalized.",
         "final", "a3", "Ten years ago, a summer night"),
    ]:
        sid = uid()
        status_variant_ids[status_] = sid
        conn.execute(
            """INSERT INTO tree_nodes
               (id,project_id,parent_id,node_type,title,synopsis,sort_order,story_time_order,story_time_label,
                pov_character_id,location_id,status,content,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, project_id, notes_folder_id, "scene", title, syn, sort, sort, story,
             eleanor_id, None, status_,
             doc_nodes(para(f"[sample body for confirming the {status_} status]")),
             now, now),
        )

    # ================================================================
    # New-feature samples: Beat / Mention / Pin / POV cache / Label
    # ================================================================

    # ---- Beat nodes (replace scene2's outline with actual placed sceneBeat blocks) ----
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
    beat_s2_writ_id = uid()
    beat_s2_wren_id = uid()
    scene2_doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 2},
             "content": [{"type": "text", "text": "Chapter Two: The Writ"}]},
            beat_node(beat_s2_intro_id,
                     "Eleanor wakes in the keeping-room. The compass is in her hand. Another's "
                     "memory — only shards of sensation and feeling remain.",
                     beat_type="summary", pov=eleanor_id),
            generated_prose_node(beat_s2_intro_id, [
                "When Eleanor woke, the compass was in her hand. Through the gaps of her clenched "
                "fingers it gave off a dry warmth.",
                "Someone was running. Someone was afraid. Who, she could not fix. Only the outline "
                "of the memory stayed; the inside was thin.",
            ]),
            beat_node(beat_s2_writ_id,
                     "She finds the sealed writ. Under the compass. The words 'Come back,' the "
                     "steps of the Sundering Rite, and a final line that cannot be read.",
                     beat_type="guided", pov=eleanor_id),
            beat_node(beat_s2_wren_id,
                     "Wrenna arrives. 'So you came after all,' and holds out a parcel. Eleanor "
                     "does not ask how she knew. She cannot.",
                     beat_type="dialogue", pov=wren_id),
        ],
    }
    scene2_content_new = json.dumps(scene2_doc)
    conn.execute(
        "UPDATE tree_nodes SET content=?, status=? WHERE id=?",
        (scene2_content_new, "draft", scene2_id),
    )

    # ---- Unplaced beats (scene3: stockpiled beat ideas for an unwritten scene) ----
    unplaced_beats_scene3 = [
        {
            "id": uid(),
            "beatType": "summary",
            "pov": eleanor_id,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "Back at her Ironhaven lodging, Eleanor passes the night with the "
                                 "writ held against her."}],
        },
        {
            "id": uid(),
            "beatType": "dialogue",
            "pov": eleanor_id,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "By morning Aldric stands before the inn. 'I hear you went to "
                                 "Greymoor' — he somehow knows."}],
        },
        {
            "id": uid(),
            "beatType": "guided",
            "pov": aldric_id,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "Aldric's interior: he has sensed that Eleanor touched the compass "
                                 "again. Before she reaches the truth, he must decide what to tell "
                                 "and what to withhold."}],
        },
        {
            "id": uid(),
            "beatType": "setting",
            "pov": None,
            "collapsed": True,
            "content": [{"type": "text",
                         "text": "Setting: an Ironhaven morning. Low fog, the streets still thin "
                                 "of people."}],
        },
        {
            "id": uid(),
            "beatType": "micro",
            "pov": None,
            "collapsed": False,
            "content": [{"type": "text",
                         "text": "Eleanor's tic: open the scene with the 'counts to three before "
                                 "moving' beat."}],
        },
    ]
    unplaced_beats_doc_scene3 = json.dumps(unplaced_beats_scene3)
    preview_scene3 = json.dumps(
        [b["content"][0]["text"][:60] for b in unplaced_beats_scene3],
    )
    conn.execute(
        "UPDATE tree_nodes SET unplaced_beats_doc=?, unplaced_beat_preview=? WHERE id=?",
        (unplaced_beats_doc_scene3, preview_scene3, scene3_id),
    )

    # One unplaced beat on a bonus scene too, for Grid preview checking
    bonus_beat = [{
        "id": uid(),
        "beatType": "free",
        "pov": eleanor_id,
        "collapsed": False,
        "content": [{"type": "text",
                     "text": "The moment the vault door opens. Aldric looks back once before he "
                             "turns the key."}],
    }]
    conn.execute(
        "UPDATE tree_nodes SET unplaced_beats_doc=?, unplaced_beat_preview=? WHERE id=?",
        (json.dumps(bonus_beat),
         json.dumps([bonus_beat[0]["content"][0]["text"][:60]]),
         status_variant_ids["revision"]),
    )

    # ---- char_count (recursively sum text nodes in the body) ----
    for sid in (scene1_id, scene2_id, scene3_id,
                scene_flashback_id, scene_payoff_id):
        row = conn.execute("SELECT content FROM tree_nodes WHERE id=?", (sid,)).fetchone()
        if row is not None:
            conn.execute("UPDATE tree_nodes SET char_count=? WHERE id=?",
                         (_count_doc_chars(row[0]), sid))

    # ---- scene_codex_mentions (mixed POV / location / beat samples) ----
    # source in ('body','beat','relation'); role in ('mentioned','actor','target')
    mentions_rows = [
        # (scene_id, codex_id, source, role)
        (scene1_id,          eleanor_id,      "body", "actor"),
        (scene1_id,          ashveil_hall_id, "body", "mentioned"),
        (scene1_id,          compass_id,      "body", "target"),
        (scene2_id,          eleanor_id,      "beat", "actor"),
        (scene2_id,          compass_id,      "beat", "target"),
        (scene2_id,          writ_id,         "beat", "target"),
        (scene2_id,          wren_id,         "beat", "actor"),
        (scene_flashback_id, eleanor_id,      "body", "actor"),
        (scene_flashback_id, mira_id,         "body", "target"),
        (scene_payoff_id,    eleanor_id,      "body", "actor"),
        (scene_payoff_id,    mira_id,         "body", "target"),
        (scene_payoff_id,    ashveil_hall_id, "body", "mentioned"),
        (scene3_id,          eleanor_id,      "beat", "actor"),
        (scene3_id,          aldric_id,       "beat", "target"),
    ]
    for sid, cid, src, role in mentions_rows:
        conn.execute(
            "INSERT INTO scene_codex_mentions (scene_id, codex_entry_id, source, role)"
            " VALUES (?,?,?,?)",
            (sid, cid, src, role),
        )

    # ---- scene_codex_pins (entries explicitly pinned to a scene in the Grid panel) ----
    # Mirrors upsertScenePin: also create a source='relation', role='mentioned' mention row.
    pins_rows = [
        (scene2_id, compass_id),
        (scene2_id, writ_id),
        (scene3_id, aldric_id),
        (scene_payoff_id, compass_id),
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

    # ---- scene_beat_pov_cache (Matrix star display: beat-level POV override) ----
    beat_pov_rows = [
        (scene2_id, wren_id),
        (scene3_id, aldric_id),
    ]
    for sid, cid in beat_pov_rows:
        conn.execute(
            "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES (?,?)",
            (sid, cid),
        )

    # ---- tree_node_labels (act labels + status tags) ----
    label_assignments = [
        (scene_flashback_id, ["Setup"]),
        (scene1_id,          ["Setup", "Key"]),
        (scene_payoff_id,    ["Rising", "Hollow stirs"]),
        (scene2_id,          ["Rising", "Open"]),
        (scene3_id,          ["Turn", "Open"]),
        (status_variant_ids["complete"], ["Resolution"]),
        (status_variant_ids["revision"], ["Turn", "Open"]),
        (status_variant_ids["final"],    ["Setup", "Key"]),
    ]
    for node_id, names in label_assignments:
        for name in names:
            conn.execute(
                "INSERT INTO tree_node_labels (node_id, label_id) VALUES (?,?)",
                (node_id, label_ids[name]),
            )

    # ================================================================
    # Trash bin (trash_items): sample deleted body fragments / structures
    # ================================================================
    # payload is JSON with camelCase keys (matching types.ts).
    # is_interesting is set by hand following the trashBinStore rule (length / structure kind).

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
             json.dumps(payload),
             len(text), 1 if interesting else 0, deleted_iso),
        )

    def trash_structure(*, sub_kind: str, scene_id: str | None,
                        codex_id: str | None, preview_text: str,
                        preview_meta: dict | None, payload_obj: dict,
                        char_count: int,
                        deleted_offset_seconds: int = 0) -> None:
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
             json.dumps(preview_meta) if preview_meta else None,
             json.dumps(payload_obj),
             char_count, 1, deleted_iso),
        )

    # 1) short fragment (gone in a typo fix)
    trash_text_fragment(
        scene_id=scene1_id, codex_id=None,
        text="— no, there was no need to remember.",
        spans=[{
            "text": "— no, there was no need to remember.",
            "source": "human",
            "model": None, "chatMessageId": None, "timestamp": now,
        }],
        deleted_offset_seconds=120,
    )

    # 2) interesting long drop (a paragraph cut in revision, mixed AI authorship)
    long_drop = (
        "The vermilion on the gateposts had faded. When she saw it ten years ago it had been "
        "closer to the colour of blood, she thought. Was that a trick of memory, or had the "
        "colour truly gone? Eleanor reached out, then stopped. To touch it was to be certain. "
        "That frightened her."
    )
    trash_text_fragment(
        scene_id=scene1_id, codex_id=None,
        text=long_drop,
        spans=[
            {"text": "The vermilion on the gateposts had faded. When she saw it ten years ago it "
                     "had been closer to the colour of blood, she thought.",
             "source": "human", "model": None,
             "chatMessageId": None, "timestamp": now},
            {"text": "Was that a trick of memory, or had the colour truly gone?",
             "source": "ai", "model": "anthropic/claude-sonnet-4.6",
             "chatMessageId": chat_msg_ids[1] if chat_msg_ids else None,
             "timestamp": now},
            {"text": "Eleanor reached out, then stopped. To touch it was to be certain. That "
                     "frightened her.",
             "source": "human", "model": None,
             "chatMessageId": None, "timestamp": now},
        ],
        interesting=True,
        deleted_offset_seconds=3600,
    )

    # 3) fragment cut while editing a Codex entry (line dropped while tidying excludedAliases)
    trash_text_fragment(
        scene_id=None, codex_id=eleanor_id,
        text="(old note) As a child Eleanor called the compass 'the little sister.'",
        spans=[{
            "text": "(old note) As a child Eleanor called the compass 'the little sister.'",
            "source": "human",
            "model": None, "chatMessageId": None, "timestamp": now,
        }],
        deleted_offset_seconds=7200,
    )

    # 4) structure item: a deleted Map sticky (payload keeps coordinates and colour)
    deleted_sticky_body = json.dumps(
        {"type": "doc",
         "content": [{"type": "paragraph",
                      "content": [{"type": "text",
                                   "text": "Cut idea: the Hollow had fed on Aldric's mother. "
                                           "Withdrawn for now; doesn't fit."}]}]},
    )
    trash_structure(
        sub_kind="map-sticky",
        scene_id=None, codex_id=None,
        preview_text="Cut idea: the Hollow had fed on Aldric's mother.",
        preview_meta={"paletteId": "post-it-playful", "colorSlot": 6},
        payload_obj={
            "originalId": uid(),
            "boardId": board_id,
            "title": "Withdrawn hypothesis",
            "body": deleted_sticky_body,
            "previewText": "Cut idea: the Hollow had fed on Aldric's mother. Withdrawn for now.",
            "paletteId": "post-it-playful",
            "colorSlot": 6,
            "x": 1180.0, "y": -40.0,
            "pinned": False, "zIndex": 0,
        },
        char_count=46,
        deleted_offset_seconds=10800,
    )

    # 5) structure item: a deleted Snippet (a one-scene candidate dropped from the draft)
    deleted_snippet_body_html = html_paragraphs(
        "\"Don't come,\" Aldric said. A snowy morning, before the gate of the office. His voice "
        "was like no voice Eleanor knew.",
        "— in the end this scene goes not in chapter three but in chapter five.",
    )
    trash_structure(
        sub_kind="snippet",
        scene_id=scene2_id, codex_id=None,
        preview_text="\"Don't come,\" Aldric said. A snowy morning, before the gate of the office.",
        preview_meta=None,
        payload_obj={
            "originalId": uid(),
            "title": "Before the snowy gate (held)",
            "body": deleted_snippet_body_html,
            "tags": json.dumps([]),
            "contentSource": "human",
            "sceneId": scene2_id,
        },
        char_count=120,
        deleted_offset_seconds=43200,
    )

    # 6) structure item: a deleted Scene (a bonus chapter once made and removed)
    deleted_scene_body = doc_nodes(
        para("[unused chapter] Eleanor steals a look at the ten-year-old case file in the records "
             "office."),
        para("Withdrawn: the motive is exposed too early and hurts the foreshadow payoffs."),
    )
    trash_structure(
        sub_kind="scene",
        scene_id=None, codex_id=None,
        preview_text="[unused chapter] Eleanor steals a look at the ten-year-old case file.",
        preview_meta={"status": "outline", "wordCount": 86},
        payload_obj={
            "originalId": uid(),
            "title": "Unused: the stolen file",
            "body": deleted_scene_body,
            "beats": json.dumps([]),
            "povCharacterId": eleanor_id,
            "folderHintId": notes_folder_id,
            "folderHintName": "Notes",
            "metadata": {
                "synopsis": "Draft of the file-theft scene. Withdrawn for pacing.",
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

    # ---- --scale medium: extra content for performance testing ----
    if scale == "medium":
        _seed_bulk_content(
            conn, project_id, now,
            ctx={
                "eleanor_id": eleanor_id,
                "aldric_id": aldric_id,
                "wren_id": wren_id,
                "mira_id": mira_id,
                "ashveil_hall_id": ashveil_hall_id,
                "ironhaven_id": ironhaven_id,
                "compass_id": compass_id,
                "notes_folder_id": notes_folder_id,
                "tag_ids": tag_ids,
                "label_ids": label_ids,
                "board_id": board_id,
            },
        )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create the English sample workspace 'The Iron Crown'.",
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="samples/iron-crown",
        help="output directory (default: samples/iron-crown)",
    )
    parser.add_argument(
        "--scale",
        choices=("default", "medium"),
        default="default",
        help="default = base sample only / medium = add ~30 scenes and ~90k chars "
             "(for performance and semantic-search testing)",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir)

    if output_dir.exists() and (output_dir / "grimodex.db").exists():
        print(f"Error: {output_dir / 'grimodex.db'} already exists. "
              f"Remove it or choose a different path.")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    meta_dir = output_dir / ".grimodex"
    meta_dir.mkdir(exist_ok=True)
    (meta_dir / "workspace.json").write_text(
        json.dumps({"id": str(uuid.uuid4()), "created_at": ts()}, indent=2)
    )

    db_path = output_dir / "grimodex.db"
    seed(db_path, scale=args.scale)

    print(f"Sample workspace created at: {output_dir.resolve()}")
    if args.scale != "default":
        print(f"  scale = {args.scale}")
    print("Open this directory in Grimodex to explore 'The Iron Crown' sample project.")
    print("To debug semantic search: open it, run Settings -> Project -> Rebuild semantic")
    print("index, then use semantic search (the project's language='en' selects the English")
    print("embedding model).")


if __name__ == "__main__":
    main()
