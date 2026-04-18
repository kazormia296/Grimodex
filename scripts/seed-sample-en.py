#!/usr/bin/env python3
"""
Creates the English sample workspace "The Iron Crown" for Grimodex.

Usage:
    python3 scripts/seed-sample-en.py [output_dir]

output_dir defaults to ./samples/iron-crown/
Open that directory as a workspace in Grimodex to explore the sample.
"""

import json
import os
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


def uid() -> str:
    return str(uuid.uuid4())


def doc(*paragraphs: str) -> str:
    """Build a minimal ProseMirror doc JSON from plain-text paragraphs."""
    content = []
    for p in paragraphs:
        if p.strip():
            content.append({
                "type": "paragraph",
                "content": [{"type": "text", "text": p}]
            })
        else:
            content.append({"type": "paragraph"})
    return json.dumps({"type": "doc", "content": content})


def heading(level: int, text: str) -> dict:
    return {
        "type": "heading",
        "attrs": {"level": level},
        "content": [{"type": "text", "text": text}]
    }


def para(text: str) -> dict:
    if not text.strip():
        return {"type": "paragraph"}
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def doc_nodes(*nodes) -> str:
    return json.dumps({"type": "doc", "content": list(nodes)})


# ---------------------------------------------------------------------------
# Schema (mirrors src-tauri/src/database.rs migrate())
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
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
                              CHECK(context_mode IN ('always','mentioned','suppress','hidden')),
    children_budget         TEXT NOT NULL DEFAULT 'compact'
                              CHECK(children_budget IN ('none','compact','standard','generous')),
    source_chat_message_id  TEXT REFERENCES chat_messages(id),
    notes                   TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_codex_project ON codex_entries(project_id, type);
CREATE INDEX IF NOT EXISTS idx_codex_name    ON codex_entries(project_id, name);
CREATE INDEX IF NOT EXISTS idx_codex_parent  ON codex_entries(parent_id);

CREATE TABLE IF NOT EXISTS codex_quick_pins (
    entry_id TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE
);

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
                         CHECK(field_type IN ('text','dropdown','codex_reference')),
    field_config       TEXT,
    sort_order         REAL NOT NULL DEFAULT 0.0,
    include_in_context INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
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
CREATE INDEX IF NOT EXISTS idx_codex_detail_values_entry ON codex_detail_values(entry_id);
CREATE INDEX IF NOT EXISTS idx_codex_detail_values_def   ON codex_detail_values(definition_id);

CREATE TABLE IF NOT EXISTS snippets (
    id                      TEXT PRIMARY KEY,
    project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title                   TEXT NOT NULL DEFAULT 'Untitled',
    content                 TEXT NOT NULL DEFAULT '{}',
    tags_cache              TEXT,
    content_source          TEXT,
    scene_id                TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
    source_chat_message_id  TEXT REFERENCES chat_messages(id),
    usage_count             INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snippets_project ON snippets(project_id, created_at DESC);

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
    pinned_codex TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_node ON chat_sessions(project_id, node_id);

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
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    summary            TEXT NOT NULL,
    source_message_ids TEXT NOT NULL,
    token_count        INTEGER,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_session ON chat_summaries(session_id, created_at);

CREATE TABLE IF NOT EXISTS codex_entry_phases (
    id                    TEXT PRIMARY KEY,
    entry_id              TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    anchor_node_id        TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
    label                 TEXT NOT NULL DEFAULT '',
    summary_override      TEXT,
    content_override      TEXT,
    context_mode_override TEXT,
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
    detail_value_id TEXT REFERENCES codex_detail_values(id),
    from_pos        INTEGER NOT NULL,
    to_pos          INTEGER NOT NULL,
    source          TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
    model           TEXT,
    timestamp       TEXT,
    chat_msg_id     TEXT,
    phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
    CHECK (
        (node_id IS NOT NULL AND codex_entry_id IS NULL AND snippet_id IS NULL) OR
        (node_id IS NULL AND codex_entry_id IS NOT NULL AND snippet_id IS NULL) OR
        (node_id IS NULL AND codex_entry_id IS NULL AND snippet_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_authorship_node    ON authorship_spans(node_id, source);
CREATE INDEX IF NOT EXISTS idx_authorship_codex   ON authorship_spans(codex_entry_id, source);
CREATE INDEX IF NOT EXISTS idx_authorship_snippet ON authorship_spans(snippet_id, source);
CREATE INDEX IF NOT EXISTS idx_authorship_detail  ON authorship_spans(detail_value_id);

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
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_snapshots ON project_snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_snapshot_entries (
    snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    version_id  TEXT NOT NULL REFERENCES content_versions(id),
    PRIMARY KEY (snapshot_id, version_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

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
    VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''), COALESCE(new.tags_cache,''));
END;
CREATE TRIGGER IF NOT EXISTS snippets_fts_ad AFTER DELETE ON snippets BEGIN
    INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, COALESCE(old.title,''), COALESCE(old.content,''), COALESCE(old.tags_cache,''));
END;
CREATE TRIGGER IF NOT EXISTS snippets_fts_au AFTER UPDATE ON snippets
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags_cache IS NOT new.tags_cache
BEGIN
    INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, COALESCE(old.title,''), COALESCE(old.content,''), COALESCE(old.tags_cache,''));
    INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''), COALESCE(new.tags_cache,''));
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, COALESCE(new.content,''));
END;
CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, COALESCE(old.content,''));
END;
CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE ON chat_messages
  WHEN old.content IS NOT new.content
BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, COALESCE(old.content,''));
    INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, COALESCE(new.content,''));
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
"""


# ---------------------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------------------

def seed(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    now = ts()

    # ---- Project ----
    project_id = "default-project"
    conn.execute(
        """INSERT INTO projects (id,title,genre,pov,tense,language,style_guide,ai_instructions,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            project_id,
            "The Iron Crown",
            "Fantasy",
            "Third person limited",
            "Past",
            "en",
            "Clear, vivid prose with attention to sensory detail. "
            "Avoid adverbs; show emotion through action and physical response. "
            "Dialogue should reveal character, not explain plot.",
            "You are assisting with a dark fantasy novel. Maintain consistency with established "
            "character voices and worldbuilding. When expanding scenes, prioritize atmosphere "
            "and internal conflict over action.",
            now, now,
        ),
    )

    # ---- Codex types (English labels, matching builtin slugs) ----
    type_ids: dict[str, str] = {}
    for slug, label, color, palette_idx, sort_order in [
        ("character", "Character", "#7F77DD", 0, 1.0),
        ("location",  "Location",  "#1D9E75", 1, 2.0),
        ("item",      "Item",      "#BA7517", 2, 3.0),
        ("lore",      "Lore",      "#D85A30", 3, 4.0),
    ]:
        tid = uid()
        type_ids[slug] = tid
        conn.execute(
            """INSERT INTO codex_types (id,project_id,slug,label,color,palette_index,is_builtin,sort_order,created_at)
               VALUES (?,?,?,?,?,?,1,?,?)""",
            (tid, project_id, slug, label, color, palette_idx, sort_order, now),
        )

    # ---- Codex detail definitions ----
    # character: Role (text), Alignment (dropdown), Motivation (text)
    def_ids: dict[str, str] = {}
    for type_slug, name, field_type, field_config, sort_order, include in [
        ("character", "Role",       "text",     None,
         1.0, 1),
        ("character", "Alignment",  "dropdown",
         json.dumps({"options": ["Protagonist", "Antagonist", "Ally", "Neutral", "Unknown"]}),
         2.0, 1),
        ("character", "Motivation", "text",     None, 3.0, 0),
        ("location",  "Region",     "text",     None, 1.0, 1),
        ("item",      "Status",     "dropdown",
         json.dumps({"options": ["Known", "Lost", "Secured", "Destroyed"]}),
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
        ("magic",       "#9B59B6"),
        ("political",   "#888888"),
        ("nobility",    "#C9A227"),
    ]:
        tid = uid()
        tag_ids[name] = tid
        conn.execute(
            "INSERT INTO codex_tags (id,project_id,name,color,created_at) VALUES (?,?,?,?,?)",
            (tid, project_id, name, color, now),
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
            "A former royal archivist who discovers her bloodline makes her the last legitimate heir "
            "to the throne. Reluctant, methodical, and deeply skeptical of her own fitness to rule.",
            doc_nodes(
                para("Eleanor Ashveil is a woman in her mid-twenties who has spent most of her adult "
                     "life making herself unremarkable. She is competent, methodical, and deeply "
                     "reluctant to draw attention to her own skills — a trait she developed as a "
                     "defence, though she does not acknowledge it as such."),
                para("She came to the Royal Archive on the recommendation of a tutor who described "
                     "her handwriting as 'unusually legible,' which was true, and her memory as "
                     "'disquieting,' which was also true. In three years she catalogued more than "
                     "four hundred linear feet of archival material and earned a reputation for "
                     "finding things other archivists had lost."),
                para("She does not think of herself as a hero. She is actively suspicious of people "
                     "who do."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_quick_pins (entry_id) VALUES (?)", (eleanor_id,))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (eleanor_id, tag_ids["protagonist"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (eleanor_id, tag_ids["nobility"]))
    for key, val in [("character.Role", "Protagonist"), ("character.Alignment", "Protagonist"),
                     ("character.Motivation", "Stay hidden; survive without choosing sides")]:
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
            json.dumps(["Aldric", "the Old Knight"]),
            "The last knight sworn to Eleanor's bloodline. Spent twenty years searching for her "
            "after failing to protect her parents. Haunted, plainspoken, and quietly terrifying "
            "in a fight.",
            doc_nodes(
                para("Lord Aldric Morvaine is a man in his mid-sixties who carries himself with the "
                     "exaggerated straightness of someone whose back is finally starting to betray "
                     "him. He was the youngest knight sworn to Eleanor's mother. He is now, as far "
                     "as he knows, the only one left."),
                para("He spent the first decade after the Ashveil purge searching overtly, which "
                     "nearly got him killed. He spent the second decade searching in a manner that "
                     "could be described, if pressed, as archival research."),
                para("He has a habit of stating things plainly that other people consider "
                     "unspeakable, and then looking surprised when they flinch."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (aldric_id, tag_ids["nobility"]))
    for key, val in [("character.Role", "Mentor"), ("character.Alignment", "Ally"),
                     ("character.Motivation", "Redeem himself by putting Eleanor on the throne")]:
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
            json.dumps(["the Iron Hand", "Commander Voss"]),
            "Commander of the Regent's Iron Guard. Self-made and ruthless, she serves power "
            "because power serves her. Has known about Eleanor for three years and has been "
            "waiting to see if she moves.",
            doc_nodes(
                para("Mira Voss was born in the lower city of Ironhaven to a cartwright and his "
                     "wife. She enlisted in the city guard at sixteen, made corporal at nineteen, "
                     "and had a military record clean enough to be selected for the Iron Guard — "
                     "the Regent's personal force — before she was twenty-five."),
                para("She is not motivated by loyalty, ideology, or cruelty, though she can deploy "
                     "all three when they serve a purpose. What she wants is straightforward: to "
                     "never again be the person with no choices."),
                para("She knows about Eleanor Ashveil. She has known for three years. She has been "
                     "waiting to see if the girl is stupid enough to move."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (mira_id, tag_ids["antagonist"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (mira_id, tag_ids["political"]))
    for key, val in [("character.Role", "Antagonist"), ("character.Alignment", "Antagonist"),
                     ("character.Motivation", "Consolidate personal power; prevent Eleanor from claiming the Crown")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), mira_id, def_ids[key], val),
        )

    sable_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sable_id, project_id, "character", "Sable",
            json.dumps(["the grey mare", "Eleanor's horse"]),
            "Eleanor's grey roan mare, found in the Ironhaven stables. Unusually perceptive. "
            "Does not spook at things that should not exist.",
            doc_nodes(
                para("A grey roan mare of no documented lineage, found tied at a public stable in "
                     "Ironhaven's market district. Eleanor acquired her when their previous "
                     "transport fell through. She has no name in the stable records."),
                para("She does not spook at things that should not exist. This is either a "
                     "remarkable temperament or a warning sign, and Eleanor has not yet decided "
                     "which."),
            ),
            "mentioned", "none", now, now,
        ),
    )
    for key, val in [("character.Role", "Companion"), ("character.Alignment", "Ally")]:
        conn.execute(
            "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
            (uid(), sable_id, def_ids[key], val),
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
            "The realm's capital, built around the Citadel. Known for its iron gates and "
            "perpetual grey skies. Population roughly two hundred thousand.",
            doc_nodes(
                para("Ironhaven grew up around the Citadel over three centuries, spreading outward "
                     "from the fortress in concentric rings of decreasing wealth. The outermost "
                     "ring — the lower city — is where most people actually live."),
                para("The skies are grey for most of the year. Locals attribute this to the "
                     "foundries in the eastern district; visitors attribute it to the Crown. "
                     "Both may be correct."),
                para("The iron gates are ceremonial at this point. They have not been closed in "
                     "forty years. Mira Voss has standing orders to keep them operational."),
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
            json.dumps(["the fortress", "the palace"]),
            "The fortress-palace at Ironhaven's heart. The Iron Crown is sealed here under nine "
            "locks and a blood ward that has not been tested since the Sundering.",
            doc_nodes(
                para("The Citadel is not beautiful. It was built to be defensible, and it is "
                     "defensible, which is a different quality. The walls are four metres thick "
                     "at the base. The towers are not decorative."),
                para("The Crown is held in the lowest vault, below the level of the river. Access "
                     "requires the agreement of three separate keyholders, none of whom are "
                     "permitted to know the identity of the others. The Regent is one of them."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), citadel_id, def_ids["location.Region"], "Ironhaven"),
    )

    undercroft_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,parent_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            undercroft_id, project_id, citadel_id, "location", "The Undercroft",
            json.dumps(["the lower archive", "the sealed stacks"]),
            "The secret archive beneath the Citadel. Contains records the Regent has ordered "
            "sealed. Eleanor worked in the annex above it for three years before she found it.",
            doc_nodes(
                para("The Undercroft predates the Citadel by at least a century — it was already "
                     "there when the first stones were laid. The original builders are not "
                     "documented."),
                para("Eleanor found it by following a draught she noticed during a late cataloguing "
                     "session. The entrance is behind a false panel in the restricted annex, "
                     "behind a shelf of Interregnum Succession papers that no one had touched "
                     "in decades."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), undercroft_id, def_ids["location.Region"], "Ironhaven"),
    )

    hollow_road_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            hollow_road_id, project_id, "location", "The Hollow Road",
            json.dumps(["the old trade road", "the east road"]),
            "A trade road east of Ironhaven, infamous for banditry and strange lights after dark. "
            "Eleanor and Aldric use it to flee the capital.",
            doc_nodes(
                para("The Hollow Road was the main artery between Ironhaven and the eastern "
                     "provinces before the canal was finished. Now it carries lighter traffic: "
                     "merchants who can't afford the canal tolls, travellers who prefer not to "
                     "be logged, and the occasional Iron Guard patrol."),
                para("The lights appear in the hills to the north. Locals call them ghost-lanterns "
                     "and attribute them to old battle-dead from the Sundering. Aldric says they "
                     "are a navigation technique used by trackers who work in silence. He does not "
                     "say this in a reassuring way."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), hollow_road_id, def_ids["location.Region"], "The Central Vale"),
    )

    royal_archive_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,parent_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            royal_archive_id, project_id, citadel_id, "location", "Royal Archive",
            json.dumps(["the archive", "the Royal Archive", "the state archive"]),
            "The state archive housed in the Citadel. Eleanor worked here for three years "
            "cataloguing restricted materials before discovering the Undercroft. The lower "
            "records are kept in a two-key annex that officially requires supervisor approval to access.",
            doc_nodes(
                para("The Royal Archive occupies the eastern wing of the Citadel's second floor. "
                     "It holds state records going back four centuries: census rolls, succession "
                     "charts, land grants, court proceedings, and the accumulated paperwork of "
                     "seventeen Regent administrations."),
                para("The lower annex — the restricted section — requires two keys to open. "
                     "One is held by the chief archivist on duty. The second is held by a "
                     "senior clerk of the Regent's office. Access is supposed to be logged. "
                     "Eleanor's unauthorised copy of the second key is technically still in her pocket."),
                para("The archive smells of iron filings and old wax. Eleanor has always "
                     "found it calming. She is revising this opinion."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), royal_archive_id, def_ids["location.Region"], "Ironhaven"),
    )

    bloodlines_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            bloodlines_id, project_id, "item", "BLOODLINES — RESTRICTED",
            json.dumps(["BLOODLINES", "the bloodlines folder", "the genealogical folder"]),
            "A restricted folder in the Royal Archive's lower annex. Contains a three-hundred-year "
            "genealogical chart of the Ashveil bloodline, with annotations in five different hands "
            "over three centuries — the most recent naming Eleanor Ashveil specifically.",
            doc_nodes(
                para("The folder is labeled BLOODLINES — RESTRICTED in plain block capitals. "
                     "It has no additional markings, no seal, no indication of who authorised "
                     "the restriction. Eleanor noticed it was always slightly out of alphabetical "
                     "order, as if it had been pulled recently and replaced carelessly."),
                para("Inside: one genealogical chart, folded three times, with annotations in "
                     "five distinct hands spanning three centuries. The earliest hand belongs to "
                     "the Sundering era. The most recent — no older than ten years — added "
                     "Eleanor's name, her employer, and the notation 'Status: unaware.'"),
                para("Someone has been tracking the Ashveil bloodline for three hundred years. "
                     "Someone more recent has been tracking Eleanor specifically. "
                     "The folder does not say who."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), bloodlines_id, def_ids["item.Status"], "Known"),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (bloodlines_id, tag_ids["political"]))

    # ---- Items ----
    crown_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            crown_id, project_id, "item", "The Iron Crown",
            json.dumps(["the Crown", "the cursed crown", "the black iron crown"]),
            "A crown of blackened iron. Whoever wears it commands the realm's dead, but the weight "
            "of their souls slowly consumes the wearer's own. Has not been worn since the Sundering.",
            doc_nodes(
                para("The Iron Crown is not large. It was made for a child — the heir apparent who "
                     "never became king — and it has never been resized. Whether this is "
                     "significant is a matter of interpretation."),
                para("It is made of blackened iron worked with no visible seams. The interior is "
                     "smooth. There are no markings, no inscriptions, no sigils that anyone has "
                     "found, though three generations of scholars have looked."),
                para("What it does is documented extensively in the Undercroft records. What it "
                     "costs the wearer is documented less extensively, and largely in the medical "
                     "notes of the royal physicians who attended the last three rulers who used it."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (crown_id, tag_ids["magic"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (crown_id, tag_ids["political"]))
    conn.execute("INSERT INTO codex_quick_pins (entry_id) VALUES (?)", (crown_id,))
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), crown_id, def_ids["item.Status"], "Secured"),
    )

    compass_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            compass_id, project_id, "item", "Aldric's Compass",
            json.dumps(["the compass", "the bloodfinder"]),
            "A brass compass that points not north, but toward the nearest living member of "
            "Eleanor's bloodline. Aldric used it to find her. She has not yet decided whether "
            "this is comforting.",
            doc_nodes(
                para("The compass was made during the Sundering, by a craftsman whose name is not "
                     "recorded. It was commissioned by the second-to-last Ashveil ruler as a "
                     "failsafe — a way to ensure the bloodline could always find its own if "
                     "scattered."),
                para("It looks ordinary. The casing is worn brass, the face is yellowed. The needle "
                     "points where it points. Aldric has carried it for twenty years and has become "
                     "accustomed to facing east in the morning."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute(
        "INSERT INTO codex_detail_values (id,entry_id,definition_id,value) VALUES (?,?,?,?)",
        (uid(), compass_id, def_ids["item.Status"], "Known"),
    )

    # ---- Lore ----
    sundering_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sundering_id, project_id, "lore", "The Sundering",
            json.dumps(["the Fracture", "the Breaking"]),
            "Three centuries ago, the last rightful ruler split the Iron Crown's power between "
            "four noble bloodlines to prevent tyranny. The ritual destroyed two bloodlines and "
            "left the remaining two — Ashveil and Morvaine — in intermittent conflict for a century.",
            doc_nodes(
                para("The Sundering was not an accident and was not a catastrophe, at least not "
                     "initially. The ruler who performed it — Regent-King Aldous the Elder — "
                     "intended it as a constitutional solution: distribute the Crown's power "
                     "broadly enough that no single person could use it to become a tyrant."),
                para("The distribution ritual required blood from four separate noble houses. Two "
                     "of the houses did not survive the binding. Whether this was expected is "
                     "one of the questions the Undercroft records were apparently sealed to "
                     "prevent anyone from answering."),
                para("Three centuries later, only the Ashveil and Morvaine bloodlines remain "
                     "capable of wearing the Crown without immediate death. The Crown itself "
                     "remains locked in the Citadel, a problem that has been deferred so long "
                     "it has become a tradition."),
            ),
            "always", "standard", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (sundering_id, tag_ids["magic"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (sundering_id, tag_ids["political"]))
    conn.execute("INSERT INTO codex_quick_pins (entry_id) VALUES (?)", (sundering_id,))

    old_compact_id = uid()
    conn.execute(
        """INSERT INTO codex_entries
           (id,project_id,type,name,aliases,summary,content,context_mode,children_budget,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            old_compact_id, project_id, "lore", "The Old Compact",
            json.dumps(["the Compact", "the Regent's charter"]),
            "The treaty that established the current Regent system. Contains a lost clause "
            "barring anyone without Ashveil or Morvaine blood from holding the Crown — a "
            "provision the current Regent does not wish to see enforced.",
            doc_nodes(
                para("The Old Compact was drafted in the aftermath of the Sundering, when the "
                     "surviving noble houses needed a governance framework that did not depend "
                     "on a functioning monarchy. It established the Regent position as a "
                     "temporary measure."),
                para("The Compact has been renewed seventeen times. Each renewal has subtly "
                     "expanded the Regent's powers. The original document is held in the "
                     "Undercroft; the working copy in the Citadel's main archive omits "
                     "three clauses, which is technically not illegal because no one has "
                     "checked."),
                para("Eleanor found a copy of the original in the lower stacks. She has not "
                     "yet finished reading it. She suspects she is not going to enjoy it."),
            ),
            "mentioned", "compact", now, now,
        ),
    )
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (old_compact_id, tag_ids["political"]))
    conn.execute("INSERT INTO codex_entry_tags (entry_id,tag_id) VALUES (?,?)",
                 (old_compact_id, tag_ids["nobility"]))

    # ---- Tree: folders and scenes ----
    part1_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part1_id, project_id, "folder", "Part One: The Theft", 1.0,
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    scene1_id = uid()
    scene1_content = doc_nodes(
        para("The archive smelled of iron filings and old wax. Eleanor had worked here for three "
             "years and still caught herself checking the air for the faint metallic tang before "
             "she remembered it came from the vents, not a threat."),
        para("She was not supposed to be here after the second bell. The duty log showed her gone "
             "at sunset, which was true; she had come back through the servants' entrance, which "
             "was not recorded."),
        para("The lower records were kept in an annex off the main hall, behind a door that "
             "required two keys. She had one. The second had taken her four months to copy from "
             "the wax impression she had pressed during a late filing session. She was not proud "
             "of this."),
        para("The folder she was looking for was labeled simply: BLOODLINES — RESTRICTED. She had "
             "seen it three times in the course of legitimate cataloguing work, always tucked "
             "behind the Interregnum Succession papers, always slightly out of alphabetical order, "
             "as if someone had pulled it recently."),
        para("Inside were two documents. The first was a genealogical chart she had to unfold "
             "three times to read in full. At the bottom, in the oldest hand, was a name: Ashveil. "
             "Branching from it, a line of annotations in newer ink — dates, locations, brief "
             "notations she could not make sense of. Until she reached the last line."),
        para("There, in precise, careful letters no older than a decade, was her name."),
        para("Eleanor Marin Ashveil. Presently employed: Royal Archive, cataloguing staff. "
             "Status: unaware."),
        para("She sat down on the cold floor, because the alternative was falling."),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene1_id, project_id, part1_id, "scene", "The Vault",
            "Eleanor breaks into the Citadel archive after hours and finds a genealogical record "
            "naming her as the last living heir to the Ashveil bloodline.",
            1.0, "draft", scene1_content, now, now,
        ),
    )

    scene2_id = uid()
    scene2_content = doc_nodes(
        para("[OUTLINE]"),
        para("Scene opens at dawn, two days after the vault discovery. Eleanor and Aldric have "
             "left Ironhaven by the east gate using borrowed horses — Sable among them."),
        para("Beat 1: Aldric explains the Sundering on horseback. Eleanor resists. She wants to "
             "return the documents; she wants none of this."),
        para("Beat 2: Strange lights visible in the hills to the north. Aldric recognises them: "
             "the Regent has sent trackers who use night-lanterns. They have been following since "
             "the gate."),
        para("Beat 3: Aldric gives Eleanor the compass. 'It will always find your blood.' She "
             "doesn't understand yet. He doesn't explain further because explaining further would "
             "require him to admit how long he has been looking for her."),
        para("NEEDS: More sensory detail on the road itself (fog, mud season). Clarify timeline "
             "re: when Mira is alerted — does she know Eleanor moved the documents, or only that "
             "Eleanor is gone?"),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene2_id, project_id, part1_id, "scene", "The Hollow Road",
            "Eleanor and Aldric flee Ironhaven along the old trade road. They discover they are "
            "being followed. Aldric gives Eleanor the compass.",
            2.0, "outline", scene2_content, now, now,
        ),
    )

    part2_id = uid()
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (part2_id, project_id, "folder", "Part Two: The Crown", 2.0,
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    scene3_id = uid()
    scene3_content = doc_nodes(
        para("[OUTLINE — to be written]"),
        para("Establishing shot of Ironhaven from the Hollow Road approach, seen for the first "
             "time in the narrative. The Citadel dominates the skyline. Grey light. Iron "
             "parapets."),
        para("Purpose: Introduce the city before Eleanor enters it. Anchor the reader in the "
             "geography before the plot complications of Part Two begin."),
        para("NOTE: Decide whether this scene precedes or follows Scene 2 chronologically. "
             "If it precedes: this becomes a prologue-style establishing beat. If it follows: "
             "Eleanor is returning, which changes the emotional register significantly."),
        para("DECISION NEEDED: Has Eleanor been to Ironhaven before the events of Part One, "
             "or does she arrive for the first time with Aldric? Her employment at the Royal "
             "Archive implies she lives there — but this may need revisiting."),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,synopsis,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scene3_id, project_id, part2_id, "scene", "Ironhaven",
            "First narrative glimpse of the capital from the approach road. Establishes the "
            "Citadel's dominance and the city's iron aesthetic.",
            1.0, "outline", scene3_content, now, now,
        ),
    )

    notes_folder_id = "default-chapter"  # reserve this ID so the Rust migration's INSERT OR IGNORE is a no-op
    conn.execute(
        """INSERT INTO tree_nodes (id,project_id,parent_id,node_type,title,sort_order,content,created_at,updated_at)
           VALUES (?,?,NULL,?,?,?,?,?,?)""",
        (notes_folder_id, project_id, "folder", "Notes", 99.0,
         json.dumps({"type": "doc", "content": []}), now, now),
    )

    research_note_id = uid()
    research_content = doc_nodes(
        heading(2, "Research Notes"),
        para("Iron metallurgy in pre-industrial fantasy: iron crowns were occasionally used as "
             "torture devices in medieval Europe (the 'iron crown of Lombardy' is the famous "
             "legitimate one; torture variants existed). This gives the object a doubled history "
             "worth exploiting."),
        para("The Regent system: roughly analogous to a lord protector or regent-governor. The "
             "Cromwellian precedent is useful — power held in trust that gradually becomes power "
             "held in fact. Research the legal mechanisms by which this transition was justified."),
        para("'Sundering' as a word: it specifically implies a violent separation of something "
             "that was joined. Useful for the magical/political split, but also for Eleanor's "
             "personal history — she was sundered from her bloodline before she knew it existed."),
        para("TODO: Decide whether the blood ward on the Crown is currently active or dormant. "
             "If dormant, the plot complication is getting it active; if active, the complication "
             "is surviving the attempt to claim it."),
        para("TODO: The fourth bloodline (destroyed in the Sundering) — does it have a name? "
             "Could be a late-story reveal that it survived in some form."),
    )
    conn.execute(
        """INSERT INTO tree_nodes
           (id,project_id,parent_id,node_type,title,sort_order,status,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            research_note_id, project_id, notes_folder_id, "note", "Research Notes",
            1.0, "outline", research_content, now, now,
        ),
    )

    # ---- Snippets ----
    snippet1_id = uid()
    conn.execute(
        """INSERT INTO snippets
           (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            snippet1_id, project_id, "The weight of iron",
            doc_nodes(
                para("The Iron Crown was not large. It was made for a child — the heir apparent "
                     "who never became king — and it had never been resized. Eleanor knew this "
                     "from the records. Knowing it did not prepare her for the reality of the "
                     "thing: small, dark, sitting in its sealed case like it was waiting."),
                para("She had catalogued objects more historically significant. She had handled "
                     "documents more legally consequential. She had never stood in front of "
                     "something and felt it notice her."),
            ),
            "human", scene1_id, 0, now, now,
        ),
    )
    conn.execute("INSERT INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                 (snippet1_id, tag_ids["magic"]))

    snippet2_id = uid()
    conn.execute(
        """INSERT INTO snippets
           (id,project_id,title,content,content_source,scene_id,usage_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            snippet2_id, project_id, "Eleanor at the threshold",
            doc_nodes(
                para("She could put the folder back. She knew exactly where it went — third shelf, "
                     "behind the Interregnum papers, slightly out of alphabetical order because "
                     "someone had been pulling it recently and she now knew why."),
                para("She could put it back. She could go home. She could spend the rest of her "
                     "career cataloguing other people's histories and retire without ever having "
                     "to know that her own was the most dangerous file in the archive."),
                para("She took the documents."),
            ),
            "human", scene1_id, 0, now, now,
        ),
    )
    conn.execute("INSERT INTO snippet_entry_tags (snippet_id,tag_id) VALUES (?,?)",
                 (snippet2_id, tag_ids["protagonist"]))

    # ---- Chat session (sample AI conversation) ----
    session_id = uid()
    conn.execute(
        """INSERT INTO chat_sessions (id,project_id,node_id,title,title_manual,model,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            session_id, project_id, scene1_id,
            "Developing Eleanor's voice",
            1,
            "openrouter/anthropic/claude-sonnet-4-6",
            now, now,
        ),
    )
    msg_ids = []
    for role, content in [
        ("user",
         "I've written the opening of scene 1 (Eleanor in the vault). I want her internal voice "
         "to feel dry and slightly detached — she's narrating her own catastrophe as if it's "
         "someone else's problem. Can you write a short paragraph where she processes what she's "
         "just found, in that register?"),
        ("assistant",
         "Here's a version in that register:\n\n"
         "The genealogical chart said she was the last surviving Ashveil heir. The chart was "
         "three hundred years old and annotated in five different hands, which meant five "
         "different people had known this at five different times and had not, apparently, "
         "found it useful to tell her. She appreciated the efficiency. It had saved her "
         "three hundred years of being anxious about it.\n\n"
         "She folded the chart back along its original creases. She was very careful about this. "
         "It seemed important to be careful about something."),
        ("user",
         "Perfect. That's exactly it — the careful folding detail especially. Can you extract "
         "this as a snippet I can reference later?"),
        ("assistant",
         "The paragraph works well as a standalone snippet — it captures Eleanor's coping "
         "mechanism (methodical attention to small tasks when faced with large problems) and "
         "her wry awareness of her own deflection. I'd title it something like "
         "'Eleanor processes the chart' or 'The folding.' Let me know if you want me to "
         "develop this further or work on another beat from the scene."),
    ]:
        mid = uid()
        msg_ids.append(mid)
        conn.execute(
            """INSERT INTO chat_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)""",
            (mid, session_id, role, content, now),
        )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    output_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("samples/iron-crown")

    if output_dir.exists() and (output_dir / "grimodex.db").exists():
        print(f"Error: {output_dir / 'grimodex.db'} already exists. Remove it or choose a different path.")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    # Workspace metadata
    meta_dir = output_dir / ".grimodex"
    meta_dir.mkdir(exist_ok=True)
    (meta_dir / "workspace.json").write_text(
        json.dumps({"id": str(uuid.uuid4()), "created_at": ts()}, indent=2)
    )

    db_path = output_dir / "grimodex.db"
    seed(db_path)

    print(f"Sample workspace created at: {output_dir.resolve()}")
    print("Open this directory in Grimodex to explore 'The Iron Crown' sample project.")


if __name__ == "__main__":
    main()
