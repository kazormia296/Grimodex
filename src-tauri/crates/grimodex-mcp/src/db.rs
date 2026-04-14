//! Database connection and typed query functions.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ─── Schema types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub title: String,
    pub genre: Option<String>,
    pub pov: Option<String>,
    pub tense: Option<String>,
    pub language: String,
    pub style_guide: Option<String>,
    pub ai_instructions: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub title: String,
    pub synopsis: Option<String>,
    pub sort_order: f64,
    pub status: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct TreeFilter {
    pub node_type: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexEntrySummary {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub type_slug: String,
    pub name: String,
    pub aliases: Option<String>,
    pub summary: Option<String>,
    pub tags_cache: Option<String>,
    pub context_mode: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct CodexFilter {
    pub type_slug: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexDetailValue {
    pub definition_name: String,
    pub field_type: String,
    pub value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexPhase {
    pub id: String,
    pub label: String,
    pub summary_override: Option<String>,
    pub content_override: Option<String>,
    pub context_mode_override: Option<String>,
    pub anchor_node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexEntryFull {
    #[serde(flatten)]
    pub summary: CodexEntrySummary,
    pub content: String,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub children_budget: String,
    pub detail_values: Vec<CodexDetailValue>,
    pub phases: Vec<CodexPhase>,
    pub tags: Vec<String>,
    pub children: Vec<CodexEntrySummary>,
    pub source_chat_message_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectStats {
    pub scene_count: i64,
    pub folder_count: i64,
    pub status_distribution: Vec<(String, i64)>,
    pub codex_entry_count: i64,
    pub codex_by_type: Vec<(String, i64)>,
}

// ─── Connection ───────────────────────────────────────────────────────────────

pub fn open_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("Failed to open DB at {}", path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;",
    )?;
    Ok(conn)
}

/// Get the ID of the first project in the DB.
pub fn get_first_project_id(conn: &Connection) -> Result<String> {
    conn.query_row(
        "SELECT id FROM projects ORDER BY created_at LIMIT 1",
        [],
        |row| row.get(0),
    )
    .context("No projects found in database")
}

// ─── Queries ──────────────────────────────────────────────────────────────────

pub fn get_project(conn: &Connection, project_id: &str) -> Result<Project> {
    conn.query_row(
        "SELECT id, title, genre, pov, tense, language, style_guide, ai_instructions,
                created_at, updated_at
         FROM projects WHERE id = ?1",
        params![project_id],
        |row| {
            Ok(Project {
                id: row.get(0)?,
                title: row.get(1)?,
                genre: row.get(2)?,
                pov: row.get(3)?,
                tense: row.get(4)?,
                language: row.get(5)?,
                style_guide: row.get(6)?,
                ai_instructions: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .with_context(|| format!("Project '{project_id}' not found"))
}

pub fn list_tree_nodes(
    conn: &Connection,
    project_id: &str,
    filter: &TreeFilter,
) -> Result<Vec<TreeNode>> {
    let mut sql = String::from(
        "SELECT id, project_id, parent_id, node_type, title, synopsis,
                sort_order, status, created_at, updated_at
         FROM tree_nodes WHERE project_id = ?1",
    );
    if filter.node_type.is_some() {
        sql.push_str(" AND node_type = ?2");
    }
    if filter.status.is_some() {
        sql.push_str(if filter.node_type.is_some() {
            " AND status = ?3"
        } else {
            " AND status = ?2"
        });
    }
    sql.push_str(" ORDER BY sort_order");

    let mut stmt = conn.prepare(&sql)?;
    let rows = match (&filter.node_type, &filter.status) {
        (Some(nt), Some(st)) => stmt.query_map(params![project_id, nt, st], map_tree_node)?,
        (Some(nt), None) => stmt.query_map(params![project_id, nt], map_tree_node)?,
        (None, Some(st)) => stmt.query_map(params![project_id, st], map_tree_node)?,
        (None, None) => stmt.query_map(params![project_id], map_tree_node)?,
    };
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("list_tree_nodes query failed")
}

fn map_tree_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<TreeNode> {
    Ok(TreeNode {
        id: row.get(0)?,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        node_type: row.get(3)?,
        title: row.get(4)?,
        synopsis: row.get(5)?,
        sort_order: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub fn get_scene_meta(conn: &Connection, scene_id: &str) -> Result<TreeNode> {
    conn.query_row(
        "SELECT id, project_id, parent_id, node_type, title, synopsis,
                sort_order, status, created_at, updated_at
         FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        map_tree_node,
    )
    .with_context(|| format!("Scene '{scene_id}' not found"))
}

/// Fetch the raw `content` column (ProseMirror JSON) for a scene.
pub fn get_scene_content(conn: &Connection, scene_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT content FROM tree_nodes WHERE id = ?1",
        params![scene_id],
        |row| row.get(0),
    )
    .with_context(|| format!("Scene content for '{scene_id}' not found"))
}

pub fn find_scene_by_title(
    conn: &Connection,
    project_id: &str,
    title: &str,
) -> Result<Vec<TreeNode>> {
    let pattern = format!("%{title}%");
    let mut stmt = conn.prepare(
        "SELECT id, project_id, parent_id, node_type, title, synopsis,
                sort_order, status, created_at, updated_at
         FROM tree_nodes
         WHERE project_id = ?1 AND title LIKE ?2
         ORDER BY sort_order",
    )?;
    let rows = stmt.query_map(params![project_id, pattern], map_tree_node)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("find_scene_by_title query failed")
}

pub fn list_codex_entries(
    conn: &Connection,
    project_id: &str,
    filter: &CodexFilter,
) -> Result<Vec<CodexEntrySummary>> {
    let mut sql = String::from(
        "SELECT e.id, e.project_id, e.parent_id, COALESCE(ct.slug, e.type) as type_slug,
                e.name, e.aliases, e.summary, e.tags_cache, e.context_mode,
                e.created_at, e.updated_at
         FROM codex_entries e
         LEFT JOIN codex_types ct ON ct.project_id = e.project_id AND ct.slug = e.type
         WHERE e.project_id = ?1",
    );
    if filter.type_slug.is_some() {
        sql.push_str(" AND e.type = ?2");
    }
    if filter.tag.is_some() {
        let param_idx = if filter.type_slug.is_some() {
            "?3"
        } else {
            "?2"
        };
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM codex_entry_tags et
                          JOIN codex_tags t ON t.id = et.tag_id
                          WHERE et.entry_id = e.id AND t.name LIKE {param_idx})"
        ));
    }
    sql.push_str(" ORDER BY e.name");

    let mut stmt = conn.prepare(&sql)?;
    let rows = match (&filter.type_slug, &filter.tag) {
        (Some(ts), Some(tag)) => {
            let pattern = format!("%{tag}%");
            stmt.query_map(params![project_id, ts, pattern], map_codex_summary)?
        }
        (Some(ts), None) => stmt.query_map(params![project_id, ts], map_codex_summary)?,
        (None, Some(tag)) => {
            let pattern = format!("%{tag}%");
            stmt.query_map(params![project_id, pattern], map_codex_summary)?
        }
        (None, None) => stmt.query_map(params![project_id], map_codex_summary)?,
    };
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("list_codex_entries query failed")
}

fn map_codex_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodexEntrySummary> {
    Ok(CodexEntrySummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        type_slug: row.get(3)?,
        name: row.get(4)?,
        aliases: row.get(5)?,
        summary: row.get(6)?,
        tags_cache: row.get(7)?,
        context_mode: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn get_codex_entry_full(conn: &Connection, entry_id: &str) -> Result<CodexEntryFull> {
    // Main entry
    let summary = conn
        .query_row(
            "SELECT e.id, e.project_id, e.parent_id, COALESCE(ct.slug, e.type) as type_slug,
                    e.name, e.aliases, e.summary, e.tags_cache, e.context_mode,
                    e.created_at, e.updated_at, e.content, e.notes, e.icon,
                    e.children_budget, e.source_chat_message_id
             FROM codex_entries e
             LEFT JOIN codex_types ct ON ct.project_id = e.project_id AND ct.slug = e.type
             WHERE e.id = ?1",
            params![entry_id],
            |row| {
                Ok((
                    CodexEntrySummary {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        parent_id: row.get(2)?,
                        type_slug: row.get(3)?,
                        name: row.get(4)?,
                        aliases: row.get(5)?,
                        summary: row.get(6)?,
                        tags_cache: row.get(7)?,
                        context_mode: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                    },
                    row.get::<_, String>(11)?,         // content
                    row.get::<_, Option<String>>(12)?, // notes
                    row.get::<_, Option<String>>(13)?, // icon
                    row.get::<_, String>(14)?,         // children_budget
                    row.get::<_, Option<String>>(15)?, // source_chat_message_id
                ))
            },
        )
        .with_context(|| format!("Codex entry '{entry_id}' not found"))?;

    let (base_summary, content, notes, icon, children_budget, source_chat_message_id) = summary;

    // Detail values
    let mut stmt = conn.prepare(
        "SELECT d.name, d.field_type, v.value
         FROM codex_detail_values v
         JOIN codex_detail_definitions d ON d.id = v.definition_id
         WHERE v.entry_id = ?1
         ORDER BY d.sort_order",
    )?;
    let detail_values: Vec<CodexDetailValue> = stmt
        .query_map(params![entry_id], |row| {
            Ok(CodexDetailValue {
                definition_name: row.get(0)?,
                field_type: row.get(1)?,
                value: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("detail_values query failed")?;

    // Phases
    let mut stmt = conn.prepare(
        "SELECT id, label, summary_override, content_override, context_mode_override,
                anchor_node_id, created_at, updated_at
         FROM codex_entry_phases WHERE entry_id = ?1 ORDER BY created_at",
    )?;
    let phases: Vec<CodexPhase> = stmt
        .query_map(params![entry_id], |row| {
            Ok(CodexPhase {
                id: row.get(0)?,
                label: row.get(1)?,
                summary_override: row.get(2)?,
                content_override: row.get(3)?,
                context_mode_override: row.get(4)?,
                anchor_node_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("phases query failed")?;

    // Tags
    let mut stmt = conn.prepare(
        "SELECT t.name FROM codex_tags t
         JOIN codex_entry_tags et ON et.tag_id = t.id
         WHERE et.entry_id = ?1 ORDER BY t.name",
    )?;
    let tags: Vec<String> = stmt
        .query_map(params![entry_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("tags query failed")?;

    // Children
    let mut stmt = conn.prepare(
        "SELECT e.id, e.project_id, e.parent_id, COALESCE(ct.slug, e.type),
                e.name, e.aliases, e.summary, e.tags_cache, e.context_mode,
                e.created_at, e.updated_at
         FROM codex_entries e
         LEFT JOIN codex_types ct ON ct.project_id = e.project_id AND ct.slug = e.type
         WHERE e.parent_id = ?1 ORDER BY e.name",
    )?;
    let children: Vec<CodexEntrySummary> = stmt
        .query_map(params![entry_id], map_codex_summary)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("children query failed")?;

    Ok(CodexEntryFull {
        summary: base_summary,
        content,
        notes,
        icon,
        children_budget,
        detail_values,
        phases,
        tags,
        children,
        source_chat_message_id,
    })
}

pub fn find_codex_by_name(
    conn: &Connection,
    project_id: &str,
    name: &str,
) -> Result<Vec<CodexEntrySummary>> {
    let pattern = format!("%{name}%");
    let mut stmt = conn.prepare(
        "SELECT e.id, e.project_id, e.parent_id, COALESCE(ct.slug, e.type),
                e.name, e.aliases, e.summary, e.tags_cache, e.context_mode,
                e.created_at, e.updated_at
         FROM codex_entries e
         LEFT JOIN codex_types ct ON ct.project_id = e.project_id AND ct.slug = e.type
         WHERE e.project_id = ?1 AND e.name LIKE ?2 ORDER BY e.name",
    )?;
    let rows = stmt.query_map(params![project_id, pattern], map_codex_summary)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("find_codex_by_name query failed")
}

// ─── Phase 2 types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub source_type: String, // "scene" | "codex" | "snippet" | "chat"
    pub id: String,
    pub title: String,
    pub excerpt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub project_id: String,
    pub node_id: Option<String>,
    pub node_title: Option<String>,
    pub title: String,
    pub model: String,
    pub message_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub is_starred: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SnippetSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub content: String, // raw ProseMirror JSON; caller converts
    pub tags_cache: Option<String>,
    pub scene_id: Option<String>,
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AttributionSourceSummary {
    pub source: String, // "human" | "ai" | "unknown"
    pub char_count: i64,
    pub span_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SceneAttribution {
    pub scene_id: String,
    pub scene_title: String,
    pub sources: Vec<AttributionSourceSummary>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AttributionReport {
    pub total_char_count: i64,
    pub by_source: Vec<AttributionSourceSummary>,
    pub by_scene: Vec<SceneAttribution>,
}

// ─── Phase 2 queries ─────────────────────────────────────────────────────────

/// Validate a FTS5 query: reject empty, too-long, or wildcard-heavy input.
pub fn validate_fts_query(query: &str) -> Result<()> {
    if query.trim().is_empty() {
        anyhow::bail!("Search query must not be empty");
    }
    if query.len() > 500 {
        anyhow::bail!("Search query too long (max 500 characters)");
    }
    let wildcard_count = query.chars().filter(|&c| c == '*').count();
    if wildcard_count > 3 {
        anyhow::bail!("Too many wildcards in query (max 3)");
    }
    Ok(())
}

pub fn search_fts(
    conn: &Connection,
    project_id: &str,
    query: &str,
    scope: &str,
    limit: u32,
) -> Result<Vec<SearchResult>> {
    let mut results: Vec<SearchResult> = Vec::new();
    let lim = limit.min(50) as i64;

    if scope == "all" || scope == "scenes" {
        let mut stmt = conn.prepare(
            "SELECT tn.id, tn.title, COALESCE(tn.synopsis, '')
             FROM tree_nodes_fts f
             JOIN tree_nodes tn ON tn.rowid = f.rowid
             WHERE f MATCH ?1 AND tn.project_id = ?2 AND tn.node_type = 'scene'
             ORDER BY rank LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![query, project_id, lim], |row| {
            Ok(SearchResult {
                source_type: "scene".to_string(),
                id: row.get(0)?,
                title: row.get(1)?,
                excerpt: row.get(2)?,
            })
        })?;
        for r in rows {
            results.push(r.context("search scenes")?);
        }
    }

    if scope == "all" || scope == "codex" {
        let mut stmt = conn.prepare(
            "SELECT e.id, e.name, COALESCE(e.summary, '')
             FROM codex_fts f
             JOIN codex_entries e ON e.rowid = f.rowid
             WHERE f MATCH ?1 AND e.project_id = ?2
             ORDER BY rank LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![query, project_id, lim], |row| {
            Ok(SearchResult {
                source_type: "codex".to_string(),
                id: row.get(0)?,
                title: row.get(1)?,
                excerpt: row.get(2)?,
            })
        })?;
        for r in rows {
            results.push(r.context("search codex")?);
        }
    }

    if scope == "all" || scope == "snippets" {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, COALESCE(s.tags_cache, '')
             FROM snippets_fts f
             JOIN snippets s ON s.rowid = f.rowid
             WHERE f MATCH ?1 AND s.project_id = ?2
             ORDER BY rank LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![query, project_id, lim], |row| {
            Ok(SearchResult {
                source_type: "snippet".to_string(),
                id: row.get(0)?,
                title: row.get(1)?,
                excerpt: row.get(2)?,
            })
        })?;
        for r in rows {
            results.push(r.context("search snippets")?);
        }
    }

    if scope == "all" || scope == "chat" {
        let mut stmt = conn.prepare(
            "SELECT m.id, cs.title, substr(m.content, 1, 300)
             FROM chat_messages_fts f
             JOIN chat_messages m ON m.rowid = f.rowid
             JOIN chat_sessions cs ON cs.id = m.session_id
             WHERE f MATCH ?1 AND cs.project_id = ?2
             ORDER BY rank LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![query, project_id, lim], |row| {
            Ok(SearchResult {
                source_type: "chat".to_string(),
                id: row.get(0)?,
                title: row.get(1)?,
                excerpt: row.get(2)?,
            })
        })?;
        for r in rows {
            results.push(r.context("search chat")?);
        }
    }

    Ok(results)
}

pub fn list_chat_sessions(
    conn: &Connection,
    project_id: &str,
    node_id: Option<&str>,
) -> Result<Vec<ChatSession>> {
    let sql = if node_id.is_some() {
        "SELECT cs.id, cs.project_id, cs.node_id, tn.title, cs.title, cs.model,
                COUNT(cm.id) as message_count, cs.created_at, cs.updated_at
         FROM chat_sessions cs
         LEFT JOIN tree_nodes tn ON tn.id = cs.node_id
         LEFT JOIN chat_messages cm ON cm.session_id = cs.id
         WHERE cs.project_id = ?1 AND cs.node_id = ?2
         GROUP BY cs.id ORDER BY cs.updated_at DESC"
    } else {
        "SELECT cs.id, cs.project_id, cs.node_id, tn.title, cs.title, cs.model,
                COUNT(cm.id) as message_count, cs.created_at, cs.updated_at
         FROM chat_sessions cs
         LEFT JOIN tree_nodes tn ON tn.id = cs.node_id
         LEFT JOIN chat_messages cm ON cm.session_id = cs.id
         WHERE cs.project_id = ?1
         GROUP BY cs.id ORDER BY cs.updated_at DESC"
    };

    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(ChatSession {
            id: row.get(0)?,
            project_id: row.get(1)?,
            node_id: row.get(2)?,
            node_title: row.get(3)?,
            title: row.get(4)?,
            model: row.get(5)?,
            message_count: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    };

    let rows = if let Some(nid) = node_id {
        stmt.query_map(params![project_id, nid], map_row)?
    } else {
        stmt.query_map(params![project_id], map_row)?
    };

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("list_chat_sessions query failed")
}

pub fn get_chat_messages(
    conn: &Connection,
    session_id: &str,
    starred_only: bool,
    limit: u32,
) -> Result<Vec<ChatMessage>> {
    let sql = if starred_only {
        "SELECT id, session_id, role, content, model, is_starred, created_at
         FROM chat_messages WHERE session_id = ?1 AND is_starred = 1
         ORDER BY created_at LIMIT ?2"
    } else {
        "SELECT id, session_id, role, content, model, is_starred, created_at
         FROM chat_messages WHERE session_id = ?1
         ORDER BY created_at LIMIT ?2"
    };
    let mut stmt = conn.prepare(sql)?;
    let lim = limit.min(200) as i64;
    let rows = stmt.query_map(params![session_id, lim], |row| {
        Ok(ChatMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            is_starred: row.get::<_, i64>(5)? != 0,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("get_chat_messages query failed")
}

pub fn list_snippets(
    conn: &Connection,
    project_id: &str,
    tag: Option<&str>,
    limit: u32,
) -> Result<Vec<SnippetSummary>> {
    let sql = if tag.is_some() {
        "SELECT s.id, s.project_id, s.title, s.content, s.tags_cache,
                s.scene_id, s.usage_count, s.created_at, s.updated_at
         FROM snippets s
         WHERE s.project_id = ?1
           AND EXISTS (
               SELECT 1 FROM snippet_entry_tags st
               JOIN codex_tags t ON t.id = st.tag_id
               WHERE st.snippet_id = s.id AND t.name LIKE ?2
           )
         ORDER BY s.updated_at DESC LIMIT ?3"
    } else {
        "SELECT id, project_id, title, content, tags_cache,
                scene_id, usage_count, created_at, updated_at
         FROM snippets WHERE project_id = ?1
         ORDER BY updated_at DESC LIMIT ?2"
    };
    let lim = limit.min(100) as i64;
    let mut stmt = conn.prepare(sql)?;

    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(SnippetSummary {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            content: row.get(3)?,
            tags_cache: row.get(4)?,
            scene_id: row.get(5)?,
            usage_count: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    };

    let rows = if let Some(t) = tag {
        let pattern = format!("%{t}%");
        stmt.query_map(params![project_id, pattern, lim], map_row)?
    } else {
        stmt.query_map(params![project_id, lim], map_row)?
    };

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("list_snippets query failed")
}

pub fn get_attribution_report(
    conn: &Connection,
    project_id: &str,
    scene_id: Option<&str>,
) -> Result<AttributionReport> {
    // Total and by-source aggregation
    let sql_global = if scene_id.is_some() {
        "SELECT a.source,
                SUM(a.to_pos - a.from_pos) as char_count,
                COUNT(*) as span_count
         FROM authorship_spans a
         WHERE a.node_id = ?1
         GROUP BY a.source ORDER BY char_count DESC"
    } else {
        "SELECT a.source,
                SUM(a.to_pos - a.from_pos) as char_count,
                COUNT(*) as span_count
         FROM authorship_spans a
         JOIN tree_nodes tn ON tn.id = a.node_id
         WHERE tn.project_id = ?1 AND a.node_id IS NOT NULL
         GROUP BY a.source ORDER BY char_count DESC"
    };

    let mut stmt = conn.prepare(sql_global)?;
    let rows: Vec<AttributionSourceSummary> = if let Some(sid) = scene_id {
        stmt.query_map(params![sid], |row| {
            Ok(AttributionSourceSummary {
                source: row.get(0)?,
                char_count: row.get(1)?,
                span_count: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![project_id], |row| {
            Ok(AttributionSourceSummary {
                source: row.get(0)?,
                char_count: row.get(1)?,
                span_count: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let total_char_count: i64 = rows.iter().map(|r| r.char_count).sum();

    // Per-scene breakdown (only when querying the whole project)
    let by_scene = if scene_id.is_none() {
        let mut stmt2 = conn.prepare(
            "SELECT tn.id, tn.title, a.source,
                    SUM(a.to_pos - a.from_pos) as char_count,
                    COUNT(*) as span_count
             FROM authorship_spans a
             JOIN tree_nodes tn ON tn.id = a.node_id
             WHERE tn.project_id = ?1 AND a.node_id IS NOT NULL
             GROUP BY tn.id, a.source
             ORDER BY tn.sort_order, a.source",
        )?;
        let mut raw: Vec<(String, String, AttributionSourceSummary)> = stmt2
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    AttributionSourceSummary {
                        source: row.get(2)?,
                        char_count: row.get(3)?,
                        span_count: row.get(4)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // Group by scene
        let mut scenes: Vec<SceneAttribution> = Vec::new();
        for (sid, stitle, asum) in raw.drain(..) {
            if let Some(last) = scenes.last_mut() {
                if last.scene_id == sid {
                    last.sources.push(asum);
                    continue;
                }
            }
            scenes.push(SceneAttribution {
                scene_id: sid,
                scene_title: stitle,
                sources: vec![asum],
            });
        }
        scenes
    } else {
        Vec::new()
    };

    Ok(AttributionReport {
        total_char_count,
        by_source: rows,
        by_scene,
    })
}

// ─── Phase 3: write helpers ───────────────────────────────────────────────────

pub struct CreateCodexInput<'a> {
    pub project_id: &'a str,
    pub type_slug: &'a str,
    pub name: &'a str,
    pub aliases: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub content_pm: &'a str,
    pub tags: &'a [String],
}

pub struct UpdateCodexInput<'a> {
    pub entry_id: &'a str,
    pub project_id: &'a str,
    pub name: Option<&'a str>,
    pub aliases: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub content_pm: Option<&'a str>,
    pub tags: Option<&'a [String]>,
}

/// Create a new Codex entry. Returns the new entry's UUID.
pub fn create_codex_entry(conn: &Connection, input: CreateCodexInput<'_>) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, summary, content)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            input.project_id,
            input.type_slug,
            input.name,
            input.aliases,
            input.summary,
            input.content_pm
        ],
    )
    .context("create_codex_entry insert failed")?;

    link_codex_tags(conn, input.project_id, &id, input.tags)?;

    Ok(id)
}

/// Update fields of an existing Codex entry (only non-None fields are changed).
pub fn update_codex_entry(conn: &Connection, input: UpdateCodexInput<'_>) -> Result<()> {
    let entry_id = input.entry_id;
    // Verify entry exists
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM codex_entries WHERE id = ?1)",
        params![entry_id],
        |row| row.get(0),
    )?;
    if !exists {
        anyhow::bail!("Codex entry '{}' not found", entry_id);
    }

    // Build dynamic SET clause and parameter list together.
    // ?1 is always the entry_id (WHERE clause); additional ?N slots are SET values.
    let mut sets: Vec<String> = vec!["updated_at = datetime('now')".to_string()];
    let mut values: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(entry_id.to_string())];

    if let Some(n) = input.name {
        sets.push(format!("name = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Text(n.to_string()));
    }
    if let Some(a) = input.aliases {
        sets.push(format!("aliases = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Text(a.to_string()));
    }
    if let Some(s) = input.summary {
        sets.push(format!("summary = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Text(s.to_string()));
    }
    if let Some(c) = input.content_pm {
        sets.push(format!("content = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Text(c.to_string()));
    }

    let sql = format!("UPDATE codex_entries SET {} WHERE id = ?1", sets.join(", "));
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))
        .context("update_codex_entry failed")?;

    // Replace tags if provided
    if let Some(tag_list) = input.tags {
        conn.execute(
            "DELETE FROM codex_entry_tags WHERE entry_id = ?1",
            params![entry_id],
        )?;
        link_codex_tags(conn, input.project_id, entry_id, tag_list)?;
    }

    Ok(())
}

/// Upsert tags into codex_tags and link to a codex entry.
fn link_codex_tags(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    tags: &[String],
) -> Result<()> {
    for tag_name in tags {
        // Upsert tag
        let tag_id: String = conn
            .query_row(
                "INSERT INTO codex_tags (id, project_id, name)
             VALUES (lower(hex(randomblob(16))), ?1, ?2)
             ON CONFLICT(project_id, name) DO UPDATE SET name = excluded.name
             RETURNING id",
                params![project_id, tag_name],
                |row| row.get(0),
            )
            .context("upsert codex tag failed")?;

        conn.execute(
            "INSERT OR IGNORE INTO codex_entry_tags (entry_id, tag_id) VALUES (?1, ?2)",
            params![entry_id, tag_id],
        )?;
    }
    Ok(())
}

pub fn get_project_stats(conn: &Connection, project_id: &str) -> Result<ProjectStats> {
    let scene_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes WHERE project_id = ?1 AND node_type = 'scene'",
        params![project_id],
        |row| row.get(0),
    )?;
    let folder_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes WHERE project_id = ?1 AND node_type = 'folder'",
        params![project_id],
        |row| row.get(0),
    )?;
    let codex_entry_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;

    // Status distribution
    let mut stmt = conn.prepare(
        "SELECT COALESCE(status, 'none'), COUNT(*)
         FROM tree_nodes WHERE project_id = ?1 AND node_type = 'scene'
         GROUP BY status ORDER BY COUNT(*) DESC",
    )?;
    let status_distribution: Vec<(String, i64)> = stmt
        .query_map(params![project_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Codex by type
    let mut stmt = conn.prepare(
        "SELECT COALESCE(ct.label, e.type), COUNT(*)
         FROM codex_entries e
         LEFT JOIN codex_types ct ON ct.project_id = e.project_id AND ct.slug = e.type
         WHERE e.project_id = ?1
         GROUP BY e.type ORDER BY COUNT(*) DESC",
    )?;
    let codex_by_type: Vec<(String, i64)> = stmt
        .query_map(params![project_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(ProjectStats {
        scene_count,
        folder_count,
        status_distribution,
        codex_entry_count,
        codex_by_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Simpler in-memory DB with just enough tables for our tests.
    fn make_simple_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'Untitled',
                genre TEXT, pov TEXT, tense TEXT,
                language TEXT NOT NULL DEFAULT 'ja',
                style_guide TEXT, ai_instructions TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE tree_nodes (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                parent_id TEXT,
                node_type TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Untitled',
                synopsis TEXT,
                sort_order REAL NOT NULL DEFAULT 0.0,
                status TEXT DEFAULT 'outline',
                content TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE codex_types (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                slug TEXT NOT NULL,
                label TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#888888',
                palette_index INTEGER, icon TEXT,
                is_builtin INTEGER NOT NULL DEFAULT 0,
                sort_order REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE codex_entries (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                parent_id TEXT,
                type TEXT NOT NULL DEFAULT 'character',
                name TEXT NOT NULL DEFAULT 'Untitled',
                aliases TEXT, excluded_aliases TEXT,
                summary TEXT, content TEXT NOT NULL DEFAULT '{}',
                icon TEXT, tags_cache TEXT,
                context_mode TEXT NOT NULL DEFAULT 'mentioned',
                children_budget TEXT NOT NULL DEFAULT 'compact',
                source_chat_message_id TEXT, notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE codex_tags (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT, type_filter TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE codex_entry_tags (
                entry_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (entry_id, tag_id)
            );
            CREATE TABLE codex_detail_definitions (
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
            CREATE TABLE codex_entry_phases (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                anchor_node_id TEXT,
                label TEXT NOT NULL DEFAULT '',
                summary_override TEXT, content_override TEXT,
                context_mode_override TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE chat_sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT,
                title TEXT NOT NULL DEFAULT 'New session',
                title_manual INTEGER NOT NULL DEFAULT 0,
                model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
                pinned_codex TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                model TEXT,
                tokens_in INTEGER,
                tokens_out INTEGER,
                duration_ms INTEGER,
                metadata TEXT,
                is_starred INTEGER NOT NULL DEFAULT 0,
                is_summarized INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE snippets (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Untitled',
                content TEXT NOT NULL DEFAULT '{}',
                tags_cache TEXT,
                content_source TEXT,
                scene_id TEXT,
                source_chat_message_id TEXT,
                usage_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE snippet_entry_tags (
                snippet_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (snippet_id, tag_id)
            );
            CREATE TABLE authorship_spans (
                id TEXT PRIMARY KEY,
                node_id TEXT,
                codex_entry_id TEXT,
                snippet_id TEXT,
                detail_value_id TEXT,
                from_pos INTEGER NOT NULL,
                to_pos INTEGER NOT NULL,
                source TEXT NOT NULL,
                model TEXT,
                timestamp TEXT,
                chat_msg_id TEXT,
                phase_id TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn insert_project(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            params![id, title],
        )
        .unwrap();
    }

    fn insert_scene(conn: &Connection, id: &str, project_id: &str, title: &str, status: &str) {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, status) VALUES (?1, ?2, 'scene', ?3, ?4)",
            params![id, project_id, title, status],
        ).unwrap();
    }

    fn insert_codex_entry(
        conn: &Connection,
        id: &str,
        project_id: &str,
        name: &str,
        type_slug: &str,
    ) {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, name, type) VALUES (?1, ?2, ?3, ?4)",
            params![id, project_id, name, type_slug],
        )
        .unwrap();
    }

    #[test]
    fn test_get_project() {
        let conn = make_simple_db();
        insert_project(&conn, "proj1", "My Novel");
        let proj = get_project(&conn, "proj1").unwrap();
        assert_eq!(proj.title, "My Novel");
        assert_eq!(proj.id, "proj1");
    }

    #[test]
    fn test_get_project_not_found() {
        let conn = make_simple_db();
        let result = get_project(&conn, "nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn test_get_first_project_id() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "First");
        insert_project(&conn, "p2", "Second");
        let id = get_first_project_id(&conn).unwrap();
        assert_eq!(id, "p1");
    }

    #[test]
    fn test_get_first_project_id_empty() {
        let conn = make_simple_db();
        let result = get_first_project_id(&conn);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_tree_nodes_all() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "Scene 1", "draft");
        insert_scene(&conn, "s2", "p1", "Scene 2", "outline");
        let nodes = list_tree_nodes(&conn, "p1", &TreeFilter::default()).unwrap();
        assert_eq!(nodes.len(), 2);
    }

    #[test]
    fn test_list_tree_nodes_filter_status() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "Scene 1", "draft");
        insert_scene(&conn, "s2", "p1", "Scene 2", "outline");
        let nodes = list_tree_nodes(
            &conn,
            "p1",
            &TreeFilter {
                status: Some("draft".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].title, "Scene 1");
    }

    #[test]
    fn test_get_scene_meta() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "Prologue", "outline");
        let node = get_scene_meta(&conn, "s1").unwrap();
        assert_eq!(node.title, "Prologue");
    }

    #[test]
    fn test_find_scene_by_title() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "The Beginning", "outline");
        insert_scene(&conn, "s2", "p1", "The End", "outline");
        let results = find_scene_by_title(&conn, "p1", "Beginning").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "s1");
    }

    #[test]
    fn test_list_codex_entries() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        insert_codex_entry(&conn, "e2", "p1", "Forest", "location");
        let entries = list_codex_entries(&conn, "p1", &CodexFilter::default()).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_list_codex_entries_filter_type() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        insert_codex_entry(&conn, "e2", "p1", "Forest", "location");
        let entries = list_codex_entries(
            &conn,
            "p1",
            &CodexFilter {
                type_slug: Some("character".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Alice");
    }

    #[test]
    fn test_get_codex_entry_full() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        let entry = get_codex_entry_full(&conn, "e1").unwrap();
        assert_eq!(entry.summary.name, "Alice");
        assert!(entry.detail_values.is_empty());
        assert!(entry.phases.is_empty());
        assert!(entry.tags.is_empty());
    }

    #[test]
    fn test_get_scene_content() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, status)
             VALUES ('s1', 'p1', 'scene', 'Prologue', '{\"type\":\"doc\"}', 'draft')",
            [],
        )
        .unwrap();
        let content = get_scene_content(&conn, "s1").unwrap();
        assert_eq!(content, "{\"type\":\"doc\"}");
    }

    #[test]
    fn test_get_scene_content_not_found() {
        let conn = make_simple_db();
        let result = get_scene_content(&conn, "no-such-id");
        assert!(result.is_err());
    }

    // ── Phase 2 tests ────────────────────────────────────────────────────────

    #[test]
    fn test_validate_fts_query_ok() {
        assert!(validate_fts_query("Alice in Wonderland").is_ok());
        assert!(validate_fts_query("a* b* c*").is_ok()); // 3 wildcards – ok
    }

    #[test]
    fn test_validate_fts_query_empty() {
        assert!(validate_fts_query("   ").is_err());
    }

    #[test]
    fn test_validate_fts_query_too_long() {
        let q: String = "a".repeat(501);
        assert!(validate_fts_query(&q).is_err());
    }

    #[test]
    fn test_validate_fts_query_too_many_wildcards() {
        assert!(validate_fts_query("a* b* c* d*").is_err());
    }

    #[test]
    fn test_list_chat_sessions_all() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO chat_sessions (id, project_id, title) VALUES ('cs1', 'p1', 'Session 1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_sessions (id, project_id, title) VALUES ('cs2', 'p1', 'Session 2')",
            [],
        )
        .unwrap();
        let sessions = list_chat_sessions(&conn, "p1", None).unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn test_list_chat_sessions_filter_node() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "Prologue", "draft");
        conn.execute(
            "INSERT INTO chat_sessions (id, project_id, node_id, title) VALUES ('cs1', 'p1', 's1', 'S1 chat')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_sessions (id, project_id, title) VALUES ('cs2', 'p1', 'Other')",
            [],
        )
        .unwrap();
        let sessions = list_chat_sessions(&conn, "p1", Some("s1")).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "S1 chat");
    }

    #[test]
    fn test_get_chat_messages() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO chat_sessions (id, project_id, title) VALUES ('cs1', 'p1', 'Session')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content) VALUES ('m1', 'cs1', 'user', 'Hello')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, is_starred) VALUES ('m2', 'cs1', 'assistant', 'Hi', 1)",
            [],
        )
        .unwrap();
        let all = get_chat_messages(&conn, "cs1", false, 100).unwrap();
        assert_eq!(all.len(), 2);
        let starred = get_chat_messages(&conn, "cs1", true, 100).unwrap();
        assert_eq!(starred.len(), 1);
        assert!(starred[0].is_starred);
    }

    #[test]
    fn test_list_snippets() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO snippets (id, project_id, title, content) VALUES ('sn1', 'p1', 'Intro', '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO snippets (id, project_id, title, content) VALUES ('sn2', 'p1', 'Action', '{}')",
            [],
        )
        .unwrap();
        let snips = list_snippets(&conn, "p1", None, 50).unwrap();
        assert_eq!(snips.len(), 2);
    }

    #[test]
    fn test_get_attribution_report_empty() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        let report = get_attribution_report(&conn, "p1", None).unwrap();
        assert_eq!(report.total_char_count, 0);
        assert!(report.by_source.is_empty());
        assert!(report.by_scene.is_empty());
    }

    #[test]
    fn test_get_attribution_report_with_spans() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "Scene 1", "draft");
        conn.execute(
            "INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source)
             VALUES ('a1', 's1', 0, 100, 'human')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source)
             VALUES ('a2', 's1', 100, 160, 'ai')",
            [],
        )
        .unwrap();
        let report = get_attribution_report(&conn, "p1", None).unwrap();
        assert_eq!(report.total_char_count, 160);
        assert_eq!(report.by_source.len(), 2);
        // scene-level filter
        let scene_report = get_attribution_report(&conn, "p1", Some("s1")).unwrap();
        assert_eq!(scene_report.total_char_count, 160);
        assert!(scene_report.by_scene.is_empty()); // by_scene is empty when scene_id filter used
    }

    #[test]
    fn test_get_project_stats() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "S1", "draft");
        insert_scene(&conn, "s2", "p1", "S2", "outline");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES ('f1', 'p1', 'folder', 'Ch1', 0.0)",
            [],
        )
        .unwrap();
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        let stats = get_project_stats(&conn, "p1").unwrap();
        assert_eq!(stats.scene_count, 2);
        assert_eq!(stats.folder_count, 1);
        assert_eq!(stats.codex_entry_count, 1);
    }

    // ── Phase 3 tests ────────────────────────────────────────────────────────

    fn make_simple_db_with_unique_constraint() -> Connection {
        // codex_tags needs UNIQUE(project_id, name) for ON CONFLICT upsert
        let conn = make_simple_db();
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_tags_name
             ON codex_tags(project_id, name);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_create_codex_entry_basic() {
        let conn = make_simple_db_with_unique_constraint();
        insert_project(&conn, "p1", "Novel");
        let id = create_codex_entry(
            &conn,
            CreateCodexInput {
                project_id: "p1",
                type_slug: "character",
                name: "Bob",
                aliases: None,
                summary: Some("A mysterious figure"),
                content_pm: r#"{"type":"doc","content":[]}"#,
                tags: &[],
            },
        )
        .unwrap();
        assert!(!id.is_empty());
        let entry = get_codex_entry_full(&conn, &id).unwrap();
        assert_eq!(entry.summary.name, "Bob");
        assert_eq!(entry.summary.summary.as_deref(), Some("A mysterious figure"));
    }

    #[test]
    fn test_create_codex_entry_with_tags() {
        let conn = make_simple_db_with_unique_constraint();
        insert_project(&conn, "p1", "Novel");
        let tags = vec!["protagonist".to_string(), "magic".to_string()];
        let id = create_codex_entry(
            &conn,
            CreateCodexInput {
                project_id: "p1",
                type_slug: "character",
                name: "Alice",
                aliases: Some("Al,Alicia"),
                summary: None,
                content_pm: r#"{"type":"doc","content":[]}"#,
                tags: &tags,
            },
        )
        .unwrap();
        let entry = get_codex_entry_full(&conn, &id).unwrap();
        assert_eq!(entry.tags.len(), 2);
        assert!(entry.tags.contains(&"protagonist".to_string()));
    }

    #[test]
    fn test_update_codex_entry_name() {
        let conn = make_simple_db_with_unique_constraint();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        update_codex_entry(
            &conn,
            UpdateCodexInput {
                entry_id: "e1",
                project_id: "p1",
                name: Some("Alicia"),
                aliases: None,
                summary: None,
                content_pm: None,
                tags: None,
            },
        )
        .unwrap();
        let entry = get_codex_entry_full(&conn, "e1").unwrap();
        assert_eq!(entry.summary.name, "Alicia");
    }

    #[test]
    fn test_update_codex_entry_not_found() {
        let conn = make_simple_db_with_unique_constraint();
        let result = update_codex_entry(
            &conn,
            UpdateCodexInput {
                entry_id: "no-such-id",
                project_id: "p1",
                name: Some("X"),
                aliases: None,
                summary: None,
                content_pm: None,
                tags: None,
            },
        );
        assert!(result.is_err());
    }
}
