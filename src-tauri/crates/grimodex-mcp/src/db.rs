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
pub struct ProjectSummary {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub title: String,
    pub synopsis: Option<String>,
    pub sort_order: String,
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

/// All projects (id + title) in the workspace, oldest first. Backs
/// `list_projects` in --all-projects mode.
pub fn list_all_projects(conn: &Connection) -> Result<Vec<ProjectSummary>> {
    let mut stmt = conn.prepare("SELECT id, title FROM projects ORDER BY created_at")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                title: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Title of a project by id, or `None` if no such project exists. Used by
/// `select_project` to validate the target before switching the current project.
pub fn fetch_project_title(conn: &Connection, project_id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    let title = conn
        .query_row(
            "SELECT title FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(title)
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

pub fn get_scene_meta(conn: &Connection, project_id: &str, scene_id: &str) -> Result<TreeNode> {
    // `project_id` でスコープしないと、別プロジェクトの scene_id を渡すだけで
    // クロスプロジェクト読み取りができてしまう（単一 DB に全プロジェクトを持つため）。
    conn.query_row(
        "SELECT id, project_id, parent_id, node_type, title, synopsis,
                sort_order, status, created_at, updated_at
         FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        params![scene_id, project_id],
        map_tree_node,
    )
    .with_context(|| format!("Scene '{scene_id}' not found"))
}

/// Fetch the raw `content` column (ProseMirror JSON) for a scene.
pub fn get_scene_content(conn: &Connection, project_id: &str, scene_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT content FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        params![scene_id, project_id],
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

pub fn get_codex_entry_full(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
) -> Result<CodexEntryFull> {
    // Main entry。`e.project_id` でスコープしないと、別プロジェクトの entry_id を
    // 渡すだけでクロスプロジェクト読み取りができてしまう。ここで早期 return する
    // ため、後続の detail_values/phases/tags サブクエリもまとめてゲートされる。
    let summary = conn
        .query_row(
            "SELECT e.id, e.project_id, e.parent_id, COALESCE(ct.slug, e.type) as type_slug,
                    e.name, e.aliases, e.summary, e.tags_cache, e.context_mode,
                    e.created_at, e.updated_at, e.content, e.notes, e.icon,
                    e.children_budget, e.source_chat_message_id
             FROM codex_entries e
             LEFT JOIN codex_types ct ON ct.project_id = e.project_id AND ct.slug = e.type
             WHERE e.id = ?1 AND e.project_id = ?2",
            params![entry_id, project_id],
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

    // Detail values — チャット注入/アプリ内 Agent ツールと同じく
    // include_in_context=1 のみ公開する
    let mut stmt = conn.prepare(
        "SELECT d.name, d.field_type, v.value
         FROM codex_detail_values v
         JOIN codex_detail_definitions d ON d.id = v.definition_id
         WHERE v.entry_id = ?1 AND d.include_in_context = 1
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
    pub metadata: Option<String>,
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

    // FTS5 trigram requires ≥3 chars; fall back to LIKE for shorter queries.
    let use_like = query.chars().count() < 3;
    let like_pattern = format!("%{query}%");

    if scope == "all" || scope == "scenes" {
        if use_like {
            let mut stmt = conn.prepare(
                "SELECT id, title, COALESCE(synopsis, '')
                 FROM tree_nodes
                 WHERE project_id = ?1 AND node_type = 'scene'
                   AND (title LIKE ?2 OR content LIKE ?2)
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![project_id, like_pattern, lim], |row| {
                Ok(SearchResult {
                    source_type: "scene".to_string(),
                    id: row.get(0)?,
                    title: row.get(1)?,
                    excerpt: row.get(2)?,
                })
            })?;
            for r in rows {
                results.push(r.context("search scenes (like)")?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT tn.id, tn.title, COALESCE(tn.synopsis, '')
                 FROM tree_nodes_fts
                 JOIN tree_nodes tn ON tn.rowid = tree_nodes_fts.rowid
                 WHERE tree_nodes_fts MATCH ?1 AND tn.project_id = ?2 AND tn.node_type = 'scene'
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
    }

    if scope == "all" || scope == "codex" {
        if use_like {
            let mut stmt = conn.prepare(
                "SELECT id, name, COALESCE(summary, '')
                 FROM codex_entries
                 WHERE project_id = ?1
                   AND (name LIKE ?2 OR aliases LIKE ?2 OR summary LIKE ?2 OR content LIKE ?2)
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![project_id, like_pattern, lim], |row| {
                Ok(SearchResult {
                    source_type: "codex".to_string(),
                    id: row.get(0)?,
                    title: row.get(1)?,
                    excerpt: row.get(2)?,
                })
            })?;
            for r in rows {
                results.push(r.context("search codex (like)")?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT e.id, e.name, COALESCE(e.summary, '')
                 FROM codex_fts
                 JOIN codex_entries e ON e.rowid = codex_fts.rowid
                 WHERE codex_fts MATCH ?1 AND e.project_id = ?2
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
    }

    if scope == "all" || scope == "snippets" {
        if use_like {
            let mut stmt = conn.prepare(
                "SELECT id, title, COALESCE(tags_cache, '')
                 FROM snippets
                 WHERE project_id = ?1 AND (title LIKE ?2 OR content LIKE ?2)
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![project_id, like_pattern, lim], |row| {
                Ok(SearchResult {
                    source_type: "snippet".to_string(),
                    id: row.get(0)?,
                    title: row.get(1)?,
                    excerpt: row.get(2)?,
                })
            })?;
            for r in rows {
                results.push(r.context("search snippets (like)")?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.title, COALESCE(s.tags_cache, '')
                 FROM snippets_fts
                 JOIN snippets s ON s.rowid = snippets_fts.rowid
                 WHERE snippets_fts MATCH ?1 AND s.project_id = ?2
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
    }

    if scope == "all" || scope == "chat" {
        if use_like {
            let mut stmt = conn.prepare(
                "SELECT m.id, cs.title, substr(m.content, 1, 300)
                 FROM chat_messages m
                 JOIN chat_sessions cs ON cs.id = m.session_id
                 WHERE cs.project_id = ?1 AND m.content LIKE ?2
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![project_id, like_pattern, lim], |row| {
                Ok(SearchResult {
                    source_type: "chat".to_string(),
                    id: row.get(0)?,
                    title: row.get(1)?,
                    excerpt: row.get(2)?,
                })
            })?;
            for r in rows {
                results.push(r.context("search chat (like)")?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT m.id, cs.title, substr(m.content, 1, 300)
                 FROM chat_messages_fts
                 JOIN chat_messages m ON m.rowid = chat_messages_fts.rowid
                 JOIN chat_sessions cs ON cs.id = m.session_id
                 WHERE chat_messages_fts MATCH ?1 AND cs.project_id = ?2
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
    project_id: &str,
    session_id: &str,
    anchors_only: bool,
    limit: u32,
) -> Result<Vec<ChatMessage>> {
    // `project_id` でスコープしないと、別プロジェクトの session_id を渡すだけで
    // クロスプロジェクトでチャット全履歴を読めてしまう (XPROJ read-by-id 防御)。
    // chat_messages に project_id 列が無いため、所有プロジェクトを持つ
    // chat_sessions へ JOIN して `cs.project_id` でゲートする。
    //
    // limit は「直近 N 件」: 内側で新しい順に切ってから時系列順へ並べ直す。
    // 古い順に LIMIT すると長い会話で直近のやり取りが欠落する。
    let sql = if anchors_only {
        "SELECT * FROM (
           SELECT m.id, m.session_id, m.role, m.content, m.model, m.metadata, m.is_starred, m.created_at
           FROM chat_messages m
           JOIN chat_sessions cs ON cs.id = m.session_id
           WHERE cs.project_id = ?1 AND m.session_id = ?2 AND (
             m.role = 'user'
             OR json_extract(m.metadata, '$.insertedToEditor') = 1
             OR json_extract(m.metadata, '$.insertedToEditor') = 'true'
             OR (json_type(json_extract(m.metadata, '$.extractedCodex')) = 'array'
                 AND json_array_length(json_extract(m.metadata, '$.extractedCodex')) > 0)
             OR (json_type(json_extract(m.metadata, '$.extractedSnippets')) = 'array'
                 AND json_array_length(json_extract(m.metadata, '$.extractedSnippets')) > 0)
           )
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?3
         ) ORDER BY created_at, id"
    } else {
        "SELECT * FROM (
           SELECT m.id, m.session_id, m.role, m.content, m.model, m.metadata, m.is_starred, m.created_at
           FROM chat_messages m
           JOIN chat_sessions cs ON cs.id = m.session_id
           WHERE cs.project_id = ?1 AND m.session_id = ?2
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?3
         ) ORDER BY created_at, id"
    };
    let mut stmt = conn.prepare(sql)?;
    let lim = limit.min(200) as i64;
    let rows = stmt.query_map(params![project_id, session_id, lim], |row| {
        Ok(ChatMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            metadata: row.get(5)?,
            is_starred: row.get::<_, i64>(6)? != 0,
            created_at: row.get(7)?,
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
        // node_id 単独だと別プロジェクトの scene_id を渡すだけで他プロジェクトの
        // シーン帰属統計を読めてしまう。authorship_spans に project_id 列は無いため
        // tree_nodes へ JOIN して `tn.project_id` でゲートする (XPROJ read 防御)。
        "SELECT a.source,
                SUM(a.to_pos - a.from_pos) as char_count,
                COUNT(*) as span_count
         FROM authorship_spans a
         JOIN tree_nodes tn ON tn.id = a.node_id
         WHERE a.node_id = ?1 AND tn.project_id = ?2
         GROUP BY a.source ORDER BY char_count DESC"
    } else {
        "SELECT source, SUM(char_count) as char_count, COUNT(*) as span_count
         FROM (
           SELECT a.source, (a.to_pos - a.from_pos) as char_count
           FROM authorship_spans a
           JOIN tree_nodes tn ON tn.id = a.node_id
           WHERE tn.project_id = ?1 AND a.node_id IS NOT NULL
           UNION ALL
           SELECT a.source, (a.to_pos - a.from_pos) as char_count
           FROM authorship_spans a
           JOIN codex_entries ce ON ce.id = a.codex_entry_id
           WHERE ce.project_id = ?1
           UNION ALL
           SELECT a.source, (a.to_pos - a.from_pos) as char_count
           FROM authorship_spans a
           JOIN snippets s ON s.id = a.snippet_id
           WHERE s.project_id = ?1
         )
         GROUP BY source ORDER BY char_count DESC"
    };

    let mut stmt = conn.prepare(sql_global)?;
    let rows: Vec<AttributionSourceSummary> = if let Some(sid) = scene_id {
        stmt.query_map(params![sid, project_id], |row| {
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

// ─── Chat executor parity reads ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTagSummary {
    pub id: String,
    pub name: String,
    pub usage_count: i64,
}

/// Mirrors `toolExecutors.ts` `listCodexTags`.
pub fn list_codex_tags(
    conn: &Connection,
    project_id: &str,
    type_filter: Option<&str>,
) -> Result<Vec<CodexTagSummary>> {
    let (sql, filter_pattern) = if let Some(tf) = type_filter {
        (
            "SELECT ct.id, ct.name, COUNT(cet.entry_id) as usage_count
             FROM codex_tags ct
             LEFT JOIN codex_entry_tags cet ON ct.id = cet.tag_id
             WHERE ct.project_id = ?1 AND (ct.type_filter IS NULL OR ct.type_filter LIKE ?2)
             GROUP BY ct.id
             ORDER BY usage_count DESC",
            Some(format!("%{tf}%")),
        )
    } else {
        (
            "SELECT ct.id, ct.name, COUNT(cet.entry_id) as usage_count
             FROM codex_tags ct
             LEFT JOIN codex_entry_tags cet ON ct.id = cet.tag_id
             WHERE ct.project_id = ?1
             GROUP BY ct.id
             ORDER BY usage_count DESC",
            None,
        )
    };

    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<CodexTagSummary> {
        Ok(CodexTagSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            usage_count: row.get(2)?,
        })
    };
    let rows = if let Some(pattern) = filter_pattern {
        stmt.query_map(params![project_id, pattern], map_row)?
    } else {
        stmt.query_map(params![project_id], map_row)?
    };

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("list_codex_tags query failed")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTagSearchResult {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub summary: String,
}

/// Mirrors `toolExecutors.ts` `searchCodexByTags`.
pub fn search_codex_by_tags(
    conn: &Connection,
    project_id: &str,
    tags: &[String],
) -> Result<Vec<CodexTagSearchResult>> {
    if tags.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = tags.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT DISTINCT ce.id, ce.name, ce.type, ce.summary
         FROM codex_entries ce
         JOIN codex_entry_tags cet ON ce.id = cet.entry_id
         JOIN codex_tags ct ON cet.tag_id = ct.id
         WHERE ce.project_id = ? AND ct.name IN ({placeholders})"
    );

    let mut query_params: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(project_id.to_string())];
    for tag in tags {
        query_params.push(rusqlite::types::Value::Text(tag.clone()));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(query_params.iter()), |row| {
        Ok(CodexTagSearchResult {
            id: row.get(0)?,
            name: row.get(1)?,
            entry_type: row.get(2)?,
            summary: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("search_codex_by_tags query failed")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedCodexEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub summary: String,
}

fn parse_codex_aliases_json(raw: Option<String>) -> Vec<String> {
    let Some(json) = raw else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) else {
        return Vec::new();
    };
    parsed
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn build_like_or_clause(tokens: &[String], columns: &[&str]) -> (String, Vec<String>) {
    let per_token: Vec<String> = tokens
        .iter()
        .map(|_| {
            format!(
                "({})",
                columns
                    .iter()
                    .map(|c| format!("{c} LIKE ?"))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        })
        .collect();
    let clause = per_token.join(" OR ");
    let params = tokens
        .iter()
        .flat_map(|t| columns.iter().map(move |_| format!("%{t}%")))
        .collect();
    (clause, params)
}

/// Mirrors `toolExecutors.ts` `findRelatedEntries`. Searches name/summary/aliases/tags_cache only.
pub fn find_related_entries(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    type_filter: Option<&str>,
) -> Result<Vec<RelatedCodexEntry>> {
    let source = conn.query_row(
        "SELECT name, aliases FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![entry_id, project_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    );

    let (name, aliases_raw) = match source {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };

    let alias_arr = parse_codex_aliases_json(aliases_raw);
    let mut terms: Vec<String> = std::iter::once(name)
        .chain(alias_arr)
        .filter(|t| !t.trim().is_empty())
        .collect();
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let columns = ["name", "summary", "aliases", "tags_cache"];
    let (like_clause, like_params) = build_like_or_clause(&terms, &columns);

    let mut sql = format!(
        "SELECT id, name, type, summary FROM codex_entries
         WHERE project_id = ? AND id != ? AND ({like_clause})"
    );
    let mut query_params: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(project_id.to_string()),
        rusqlite::types::Value::Text(entry_id.to_string()),
    ];
    for p in like_params {
        query_params.push(rusqlite::types::Value::Text(p));
    }
    if let Some(tf) = type_filter {
        if !tf.trim().is_empty() {
            sql.push_str(" AND type = ?");
            query_params.push(rusqlite::types::Value::Text(tf.to_string()));
        }
    }
    sql.push_str(" LIMIT 20");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(query_params.iter()), |row| {
        Ok(RelatedCodexEntry {
            id: row.get(0)?,
            name: row.get(1)?,
            entry_type: row.get(2)?,
            summary: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("find_related_entries query failed")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummaryScene {
    pub id: String,
    pub title: String,
    pub synopsis: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummary {
    pub id: String,
    pub title: String,
    pub scenes: Vec<ChapterSummaryScene>,
}

/// (id, parent_id, title, synopsis, sort_order) for a scene tree node.
type SceneSummaryRow = (String, Option<String>, String, Option<String>, String);

/// Folder nodes are treated as chapters (current schema). Mirrors `getChapterSummaries` with folder.
pub fn get_chapter_summaries(conn: &Connection, project_id: &str) -> Result<Vec<ChapterSummary>> {
    let mut folder_stmt = conn.prepare(
        "SELECT id, title, sort_order FROM tree_nodes
         WHERE project_id = ?1 AND node_type = 'folder'
         ORDER BY sort_order",
    )?;
    let folders: Vec<(String, String, String)> = folder_stmt
        .query_map(params![project_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut scene_stmt = conn.prepare(
        "SELECT id, parent_id, title, synopsis, sort_order FROM tree_nodes
         WHERE project_id = ?1 AND node_type = 'scene'
         ORDER BY sort_order",
    )?;
    let scenes: Vec<SceneSummaryRow> = scene_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let summaries = folders
        .into_iter()
        .map(|(folder_id, folder_title, _sort)| {
            let chapter_scenes: Vec<ChapterSummaryScene> = scenes
                .iter()
                .filter(|(_, parent_id, _, synopsis, _)| {
                    parent_id.as_deref() == Some(folder_id.as_str())
                        && synopsis.as_ref().is_some_and(|s| !s.trim().is_empty())
                })
                .map(|(id, _, title, synopsis, _)| ChapterSummaryScene {
                    id: id.clone(),
                    title: title.clone(),
                    synopsis: synopsis.clone().unwrap_or_default(),
                })
                .collect();
            ChapterSummary {
                id: folder_id,
                title: folder_title,
                scenes: chapter_scenes,
            }
        })
        .collect();

    Ok(summaries)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineNeighbor {
    pub id: String,
    pub title: String,
    pub story_time_label: Option<String>,
    pub synopsis: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTimelineNeighbors {
    pub current_scene_story_time_label: Option<String>,
    pub previous: Vec<TimelineNeighbor>,
    pub next: Vec<TimelineNeighbor>,
}

/// Story-time neighbors via fractional key SQL ordering (BINARY COLLATE).
pub fn get_scene_timeline_neighbors(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<SceneTimelineNeighbors> {
    // project_id で必ず絞る。MCP は単一 grimodex.db に全プロジェクトを持つため、
    // 他プロジェクトの scene_id を渡してタイムラインを読まれないようにする (XPROJ 防御)。
    let target = conn.query_row(
        "SELECT story_time_order, story_time_label FROM tree_nodes
         WHERE id = ?1 AND node_type = 'scene' AND project_id = ?2",
        params![scene_id, project_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    );

    let (story_time_order, story_time_label) = match target {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Ok(SceneTimelineNeighbors {
                current_scene_story_time_label: None,
                previous: Vec::new(),
                next: Vec::new(),
            });
        }
        Err(e) => return Err(e.into()),
    };

    let Some(order_key) = story_time_order else {
        return Ok(SceneTimelineNeighbors {
            current_scene_story_time_label: story_time_label,
            previous: Vec::new(),
            next: Vec::new(),
        });
    };

    let map_neighbor = |row: &rusqlite::Row<'_>| -> rusqlite::Result<TimelineNeighbor> {
        Ok(TimelineNeighbor {
            id: row.get(0)?,
            title: row.get(1)?,
            story_time_label: row.get(2)?,
            synopsis: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        })
    };

    let mut prev_stmt = conn.prepare(
        "SELECT id, title, story_time_label, synopsis FROM tree_nodes
         WHERE project_id = ?1 AND node_type = 'scene' AND id != ?2
           AND story_time_order IS NOT NULL AND story_time_order < ?3
         ORDER BY story_time_order COLLATE BINARY DESC
         LIMIT 3",
    )?;
    let previous: Vec<TimelineNeighbor> = prev_stmt
        .query_map(params![project_id, scene_id, order_key], map_neighbor)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut next_stmt = conn.prepare(
        "SELECT id, title, story_time_label, synopsis FROM tree_nodes
         WHERE project_id = ?1 AND node_type = 'scene' AND id != ?2
           AND story_time_order IS NOT NULL AND story_time_order > ?3
         ORDER BY story_time_order COLLATE BINARY ASC
         LIMIT 3",
    )?;
    let next: Vec<TimelineNeighbor> = next_stmt
        .query_map(params![project_id, scene_id, order_key], map_neighbor)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(SceneTimelineNeighbors {
        current_scene_story_time_label: story_time_label,
        previous,
        next,
    })
}

#[derive(Debug, Clone)]
struct ForeshadowLabelInput {
    payoff_confirmed: bool,
    abandoned: bool,
    load_bearing: Option<String>,
}

#[derive(Debug, Clone)]
struct SetupLabelInput {
    foreshadow_id: String,
    is_orphan: bool,
    strength: Option<String>,
    ai_strength: Option<String>,
    ai_reasoning: Option<String>,
}

fn is_valid_strength(s: &str) -> bool {
    matches!(s, "subtle" | "moderate" | "overt")
}

fn is_persona_evaluation(v: &serde_json::Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.get("strength")
            .and_then(|s| s.as_str())
            .is_some_and(is_valid_strength)
            && o.get("reasoning").and_then(|r| r.as_str()).is_some()
    })
}

/// Mirrors `safeParseAiEvaluation` in `src/features/foreshadow/types.ts`.
pub fn safe_parse_ai_evaluation(json: Option<&str>) -> bool {
    let Some(json) = json else {
        return false;
    };
    if json.is_empty() {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    let Some(obj) = parsed.as_object() else {
        return false;
    };
    let (Some(careful), Some(casual), Some(skim)) =
        (obj.get("careful"), obj.get("casual"), obj.get("skim"))
    else {
        return false;
    };
    is_persona_evaluation(careful) && is_persona_evaluation(casual) && is_persona_evaluation(skim)
}

fn effective_setup_strength(setup: &SetupLabelInput) -> Option<String> {
    if let Some(s) = &setup.strength {
        return Some(s.clone());
    }
    if let Some(reasoning) = setup.ai_reasoning.as_deref() {
        if safe_parse_ai_evaluation(Some(reasoning)) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(reasoning) {
                if let Some(strength) = parsed
                    .get("careful")
                    .and_then(|c| c.get("strength"))
                    .and_then(|s| s.as_str())
                {
                    return Some(strength.to_string());
                }
            }
        }
    }
    setup.ai_strength.clone()
}

fn is_setup_weak(setup: &SetupLabelInput) -> bool {
    effective_setup_strength(setup).as_deref() == Some("subtle")
}

/// Mirrors `deriveLabel` in `src/features/foreshadow/deriveLabel.ts`.
fn derive_label(f: &ForeshadowLabelInput, setup_count: i64, any_weak: bool) -> &'static str {
    if f.abandoned {
        return "abandoned";
    }
    if setup_count == 0 && f.payoff_confirmed {
        return "orphan_payoff";
    }
    if setup_count == 0 {
        return "planned";
    }
    if f.payoff_confirmed {
        return "paid";
    }
    if any_weak {
        match f.load_bearing.as_deref() {
            Some("critical") => return "critical_weak",
            Some("optional") => return "seeded",
            _ => return "needs_strengthening",
        }
    }
    "seeded"
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenForeshadowSummary {
    pub id: String,
    pub title: String,
    pub intent: String,
    pub load_bearing: Option<String>,
    pub setup_count: i64,
    /// 派生ラベル (seeded / needs_strengthening / critical_weak / planned 等)。
    /// チャット executor は出力から落とすが、宣言済みツール契約 (toolDefinitions の説明) と
    /// 伏線整理ユースケースに合わせ MCP では返す (意図的な差分・docs に明記)。
    pub derived_label: String,
}

/// (id, title, intent, load_bearing, payoff_confirmed, abandoned, updated_at) for a foreshadow row.
type OpenForeshadowRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    bool,
    bool,
    i64,
);

/// Open foreshadows excluding secret/abandoned/payoff_confirmed.
/// derivedLabel はチャット出力では落ちるが、MCP では宣言契約どおり返す (意図的差分)。
pub fn list_open_foreshadows(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<OpenForeshadowSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, intent, load_bearing, payoff_confirmed, abandoned, updated_at
         FROM foreshadows
         WHERE project_id = ?1 AND payoff_confirmed = 0 AND abandoned = 0 AND secret = 0",
    )?;
    let rows: Vec<OpenForeshadowRow> = stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, i64>(4)? != 0,
                row.get::<_, i64>(5)? != 0,
                row.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let setup_sql = format!(
        "SELECT foreshadow_id, is_orphan, strength, ai_strength, ai_reasoning
         FROM foreshadow_setups WHERE foreshadow_id IN ({placeholders})"
    );
    let setup_params: Vec<rusqlite::types::Value> = ids
        .iter()
        .map(|id| rusqlite::types::Value::Text(id.clone()))
        .collect();
    let mut setup_stmt = conn.prepare(&setup_sql)?;
    let setups: Vec<SetupLabelInput> = setup_stmt
        .query_map(rusqlite::params_from_iter(setup_params.iter()), |row| {
            Ok(SetupLabelInput {
                foreshadow_id: row.get(0)?,
                is_orphan: row.get::<_, i64>(1)? != 0,
                strength: row.get(2)?,
                ai_strength: row.get(3)?,
                ai_reasoning: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut count_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut weak_map: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    for s in &setups {
        if s.is_orphan {
            continue;
        }
        *count_map.entry(s.foreshadow_id.clone()).or_insert(0) += 1;
        if is_setup_weak(s) {
            weak_map.insert(s.foreshadow_id.clone(), true);
        }
    }

    let load_bearing_priority = |lb: Option<&str>| -> i32 {
        match lb {
            Some("critical") => 0,
            Some("supporting") => 1,
            Some("optional") => 2,
            _ => 3,
        }
    };

    let mut summaries: Vec<(OpenForeshadowSummary, i32, i64)> = rows
        .into_iter()
        .map(
            |(id, title, intent, load_bearing, payoff_confirmed, abandoned, updated_at)| {
                let setup_count = count_map.get(&id).copied().unwrap_or(0);
                let label_input = ForeshadowLabelInput {
                    payoff_confirmed,
                    abandoned,
                    load_bearing: load_bearing.clone(),
                };
                let derived = derive_label(
                    &label_input,
                    setup_count,
                    weak_map.get(&id).copied().unwrap_or(false),
                );
                let priority = load_bearing_priority(load_bearing.as_deref());
                let summary = OpenForeshadowSummary {
                    id,
                    title,
                    intent: intent.unwrap_or_default(),
                    load_bearing,
                    setup_count,
                    derived_label: derived.to_string(),
                };
                (summary, priority, updated_at)
            },
        )
        .collect();

    summaries.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| b.2.cmp(&a.2)));

    Ok(summaries.into_iter().map(|(s, _, _)| s).collect())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowPayoffScene {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSetupDetail {
    pub scene_id: String,
    pub scene_title: String,
    pub kind: String,
    pub strength: Option<String>,
    pub attribution: String,
    pub ai_rationale: String,
    pub is_orphan: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowDetail {
    pub id: String,
    pub title: String,
    pub intent: String,
    pub notes: String,
    pub load_bearing: Option<String>,
    pub payoff_confirmed: bool,
    pub abandoned: bool,
    pub payoff_scene: Option<ForeshadowPayoffScene>,
    pub setups: Vec<ForeshadowSetupDetail>,
}

/// Single foreshadow detail scoped to project_id. Setup strength: strength ?? aiStrength ?? null.
pub fn get_foreshadow_detail(
    conn: &Connection,
    project_id: &str,
    foreshadow_id: &str,
) -> Result<Option<ForeshadowDetail>> {
    let row = conn.query_row(
        "SELECT id, title, intent, notes, load_bearing, payoff_confirmed, abandoned, payoff_scene_id
         FROM foreshadows WHERE id = ?1 AND project_id = ?2",
        params![foreshadow_id, project_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)? != 0,
                row.get::<_, i64>(6)? != 0,
                row.get::<_, Option<String>>(7)?,
            ))
        },
    );

    let (id, title, intent, notes, load_bearing, payoff_confirmed, abandoned, payoff_scene_id) =
        match row {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e.into()),
        };

    let payoff_scene = if let Some(psid) = payoff_scene_id {
        conn.query_row(
            "SELECT id, title FROM tree_nodes WHERE id = ?1",
            params![psid],
            |row| {
                Ok(ForeshadowPayoffScene {
                    id: row.get(0)?,
                    title: row.get(1)?,
                })
            },
        )
        .ok()
    } else {
        None
    };

    let mut setup_stmt = conn.prepare(
        "SELECT fs.scene_id, fs.kind, fs.strength, fs.ai_strength, fs.attribution,
                fs.ai_rationale, fs.is_orphan, tn.title
         FROM foreshadow_setups fs
         INNER JOIN tree_nodes tn ON fs.scene_id = tn.id
         WHERE fs.foreshadow_id = ?1",
    )?;
    let setups: Vec<ForeshadowSetupDetail> = setup_stmt
        .query_map(params![foreshadow_id], |row| {
            let strength: Option<String> = row.get(2)?;
            let ai_strength: Option<String> = row.get(3)?;
            Ok(ForeshadowSetupDetail {
                scene_id: row.get(0)?,
                scene_title: row.get(7)?,
                kind: row.get(1)?,
                strength: strength.or(ai_strength),
                attribution: row.get(4)?,
                ai_rationale: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                is_orphan: row.get::<_, i64>(6)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(ForeshadowDetail {
        id,
        title,
        intent: intent.unwrap_or_default(),
        notes: notes.unwrap_or_default(),
        load_bearing,
        payoff_confirmed,
        abandoned,
        payoff_scene,
        setups,
    }))
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
pub(crate) mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Simpler in-memory DB with just enough tables for our tests.
    /// pub(crate): tools/context.rs のテストも同じ fixture を使う（DDL 二重化を避ける）。
    pub(crate) fn make_simple_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'Untitled',
                genre TEXT, pov TEXT, tense TEXT,
                language TEXT NOT NULL DEFAULT 'ja',
                style_guide TEXT, ai_instructions TEXT,
                ai_policy TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE undo_journal (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                surface TEXT NOT NULL,
                entity_kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                op_kind TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                base_version INTEGER NOT NULL,
                result_version INTEGER NOT NULL,
                change_event_uid TEXT
            );
            CREATE TABLE change_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid TEXT,
                project_id TEXT NOT NULL,
                scene_id TEXT,
                domain TEXT NOT NULL,
                op_type TEXT NOT NULL,
                entity_type TEXT,
                entity_id TEXT,
                payload TEXT NOT NULL,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                prev_hash TEXT NOT NULL,
                hash TEXT NOT NULL
            );
            CREATE UNIQUE INDEX uq_change_events_project_seq
                ON change_events(project_id, sequence);
            CREATE UNIQUE INDEX uq_change_events_project_uid
                ON change_events(project_id, event_uid);
            CREATE TABLE tree_nodes (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                parent_id TEXT,
                node_type TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Untitled',
                synopsis TEXT,
                sort_order TEXT NOT NULL DEFAULT 'a0',
                story_time_order TEXT,
                story_time_label TEXT,
                intent TEXT,
                status TEXT DEFAULT 'outline',
                content TEXT NOT NULL DEFAULT '{}',
                version INTEGER NOT NULL DEFAULT 1,
                source_uri TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE prose_staging (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                scene_id TEXT NOT NULL,
                proposed_content TEXT NOT NULL,
                base_version INTEGER NOT NULL,
                status TEXT NOT NULL,
                source_surface TEXT NOT NULL,
                source_session_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
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
            );
            CREATE TABLE foreshadows (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                intent TEXT,
                notes TEXT,
                payoff_scene_id TEXT,
                payoff_from_pos INTEGER,
                payoff_to_pos INTEGER,
                payoff_confirmed INTEGER NOT NULL DEFAULT 0,
                abandoned INTEGER NOT NULL DEFAULT 0,
                secret INTEGER NOT NULL DEFAULT 1,
                load_bearing TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE foreshadow_setups (
                id TEXT PRIMARY KEY,
                foreshadow_id TEXT NOT NULL,
                scene_id TEXT NOT NULL,
                from_pos INTEGER NOT NULL DEFAULT 0,
                to_pos INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'designated_existing',
                strength TEXT,
                ai_strength TEXT,
                ai_reasoning TEXT,
                attribution TEXT NOT NULL DEFAULT 'human',
                ai_rationale TEXT,
                last_evaluated_at INTEGER,
                is_orphan INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
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
        let node = get_scene_meta(&conn, "p1", "s1").unwrap();
        assert_eq!(node.title, "Prologue");
    }

    #[test]
    fn test_get_scene_meta_cross_project_returns_error() {
        // projA にスコープした接続が projB の scene_id を渡しても読めないこと。
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel A");
        insert_project(&conn, "p2", "Novel B");
        insert_scene(&conn, "s1", "p1", "Prologue", "outline");
        // 正: 自プロジェクトでは読める
        assert!(get_scene_meta(&conn, "p1", "s1").is_ok());
        // 負: 別プロジェクトにスコープすると not found
        assert!(get_scene_meta(&conn, "p2", "s1").is_err());
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
        let entry = get_codex_entry_full(&conn, "p1", "e1").unwrap();
        assert_eq!(entry.summary.name, "Alice");
        assert!(entry.detail_values.is_empty());
        assert!(entry.phases.is_empty());
        assert!(entry.tags.is_empty());
    }

    #[test]
    fn test_get_codex_entry_full_filters_details_by_include_in_context() {
        // チャット注入・アプリ内 Agent ツール (toolExecutors) と同じく
        // include_in_context=1 の detail のみ返す（外部 MCP だけ全件返す非対称の解消）
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        conn.execute(
            "INSERT INTO codex_detail_definitions \
             (id, project_id, type_slug, name, field_type, include_in_context) \
             VALUES ('d1', 'p1', 'character', '年齢', 'text', 1), \
                    ('d2', 'p1', 'character', '秘密', 'text', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO codex_detail_values (id, entry_id, definition_id, value) \
             VALUES ('v1', 'e1', 'd1', '17'), ('v2', 'e1', 'd2', '実は吸血鬼')",
            [],
        )
        .unwrap();

        let entry = get_codex_entry_full(&conn, "p1", "e1").unwrap();
        assert_eq!(entry.detail_values.len(), 1);
        assert_eq!(entry.detail_values[0].definition_name, "年齢");
    }

    #[test]
    fn test_get_codex_entry_full_cross_project_returns_error() {
        // projA にスコープした接続が projB の entry_id を渡しても読めないこと。
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel A");
        insert_project(&conn, "p2", "Novel B");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        assert!(get_codex_entry_full(&conn, "p1", "e1").is_ok());
        assert!(get_codex_entry_full(&conn, "p2", "e1").is_err());
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
        let content = get_scene_content(&conn, "p1", "s1").unwrap();
        assert_eq!(content, "{\"type\":\"doc\"}");
    }

    #[test]
    fn test_get_scene_content_not_found() {
        let conn = make_simple_db();
        let result = get_scene_content(&conn, "p1", "no-such-id");
        assert!(result.is_err());
    }

    #[test]
    fn test_get_scene_content_cross_project_returns_error() {
        // projA にスコープした接続が projB の scene_id で本文を読めないこと。
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel A");
        insert_project(&conn, "p2", "Novel B");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, status)
             VALUES ('s1', 'p1', 'scene', 'Prologue', '{\"type\":\"doc\"}', 'draft')",
            [],
        )
        .unwrap();
        assert!(get_scene_content(&conn, "p1", "s1").is_ok());
        assert!(get_scene_content(&conn, "p2", "s1").is_err());
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
            "INSERT INTO chat_messages (id, session_id, role, content, metadata) VALUES ('m2', 'cs1', 'assistant', 'Hi', '{\"insertedToEditor\":true}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content) VALUES ('m3', 'cs1', 'assistant', 'plain')",
            [],
        )
        .unwrap();
        let all = get_chat_messages(&conn, "p1", "cs1", false, 100).unwrap();
        assert_eq!(all.len(), 3);
        let anchors = get_chat_messages(&conn, "p1", "cs1", true, 100).unwrap();
        assert_eq!(anchors.len(), 2);
        assert!(anchors.iter().any(|m| m.id == "m1"));
        assert!(anchors.iter().any(|m| m.id == "m2"));
        let anchored = anchors.iter().find(|m| m.id == "m2").unwrap();
        assert!(anchored.metadata.is_some());

        // XPROJ defense: querying cs1 (owned by p1) while scoped to another
        // project must return nothing — the session_id alone must not leak
        // another project's chat history.
        let cross = get_chat_messages(&conn, "p2", "cs1", false, 100).unwrap();
        assert!(cross.is_empty());
    }

    #[test]
    fn test_get_chat_messages_limit_keeps_most_recent() {
        // limit は「直近 N 件を時系列順」: 古い順 LIMIT だと長い会話で
        // 直近のやり取りが欠落する (外部 LLM が古い文脈しか見えなくなる)。
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO chat_sessions (id, project_id, title) VALUES ('cs1', 'p1', 'Session')",
            [],
        )
        .unwrap();
        for i in 1..=5 {
            conn.execute(
                "INSERT INTO chat_messages (id, session_id, role, content, created_at)
                 VALUES (?1, 'cs1', 'user', ?2, ?3)",
                params![
                    format!("m{i}"),
                    format!("msg {i}"),
                    format!("2026-01-0{i}T00:00:00Z")
                ],
            )
            .unwrap();
        }
        let recent = get_chat_messages(&conn, "p1", "cs1", false, 2).unwrap();
        assert_eq!(recent.len(), 2);
        // 直近 2 件 (m4, m5) が時系列順で返る
        assert_eq!(recent[0].id, "m4");
        assert_eq!(recent[1].id, "m5");
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

        // XPROJ defense: s1 belongs to p1; scoping to another project must
        // return nothing even though the scene_id is valid.
        let cross = get_attribution_report(&conn, "p2", Some("s1")).unwrap();
        assert_eq!(cross.total_char_count, 0);
    }

    #[test]
    fn test_get_project_stats() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "s1", "p1", "S1", "draft");
        insert_scene(&conn, "s2", "p1", "S2", "outline");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES ('f1', 'p1', 'folder', 'Ch1', 'a0')",
            [],
        )
        .unwrap();
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        let stats = get_project_stats(&conn, "p1").unwrap();
        assert_eq!(stats.scene_count, 2);
        assert_eq!(stats.folder_count, 1);
        assert_eq!(stats.codex_entry_count, 1);
    }

    // ── Chat executor parity reads ───────────────────────────────────────────

    #[test]
    fn test_list_tree_nodes_text_sort_order() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, status)
             VALUES ('s2', 'p1', 'scene', 'Second', 'b0', 'outline')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, status)
             VALUES ('s1', 'p1', 'scene', 'First', 'a0', 'outline')",
            [],
        )
        .unwrap();
        let nodes = list_tree_nodes(&conn, "p1", &TreeFilter::default()).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].sort_order, "a0");
        assert_eq!(nodes[0].title, "First");
    }

    fn link_tag(conn: &Connection, project_id: &str, entry_id: &str, tag_name: &str) {
        conn.execute(
            "INSERT INTO codex_tags (id, project_id, name) VALUES (?1, ?2, ?3)",
            params![format!("tag-{tag_name}"), project_id, tag_name],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES (?1, ?2)",
            params![entry_id, format!("tag-{tag_name}")],
        )
        .unwrap();
    }

    #[test]
    fn test_get_chapter_summaries_folder_scenes() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES ('f1', 'p1', 'folder', 'Chapter 1', 'a0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, synopsis, sort_order)
             VALUES ('s1', 'p1', 'f1', 'scene', 'Scene A', 'Synopsis A', 'a0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, synopsis, sort_order)
             VALUES ('s2', 'p1', 'f1', 'scene', 'Scene B', '', 'a1')",
            [],
        )
        .unwrap();
        let summaries = get_chapter_summaries(&conn, "p1").unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Chapter 1");
        assert_eq!(summaries[0].scenes.len(), 1);
        assert_eq!(summaries[0].scenes[0].synopsis, "Synopsis A");
    }

    #[test]
    fn test_list_codex_tags_with_type_filter() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Hero", "character");
        conn.execute(
            "INSERT INTO codex_tags (id, project_id, name, type_filter) VALUES ('t1', 'p1', 'main', 'character')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO codex_tags (id, project_id, name, type_filter) VALUES ('t2', 'p1', 'geo', 'location')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES ('e1', 't1')",
            [],
        )
        .unwrap();
        let all = list_codex_tags(&conn, "p1", None).unwrap();
        assert_eq!(all.len(), 2);
        let filtered = list_codex_tags(&conn, "p1", Some("char")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "main");
        assert_eq!(filtered[0].usage_count, 1);
    }

    #[test]
    fn test_search_codex_by_tags_or_distinct() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "e1", "p1", "Alice", "character");
        link_tag(&conn, "p1", "e1", "magic");
        link_tag(&conn, "p1", "e1", "hero");
        let empty = search_codex_by_tags(&conn, "p1", &[]).unwrap();
        assert!(empty.is_empty());
        let hits = search_codex_by_tags(&conn, "p1", &["magic".into(), "missing".into()]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Alice");
    }

    #[test]
    fn test_find_related_entries_skips_content_only_match() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_codex_entry(&conn, "src", "p1", "Dragon", "lore");
        conn.execute(
            "UPDATE codex_entries SET aliases = ? WHERE id = 'src'",
            params![r#"["Wyrm"]"#],
        )
        .unwrap();
        insert_codex_entry(&conn, "hit", "p1", "Wyrm Cult", "lore");
        conn.execute(
            "UPDATE codex_entries SET summary = 'About Wyrm' WHERE id = 'hit'",
            [],
        )
        .unwrap();
        insert_codex_entry(&conn, "miss", "p1", "Unrelated", "lore");
        conn.execute(
            "UPDATE codex_entries SET content = 'secret Wyrm text' WHERE id = 'miss'",
            [],
        )
        .unwrap();
        let related = find_related_entries(&conn, "p1", "src", None).unwrap();
        assert_eq!(related.len(), 1);
        assert_eq!(related[0].id, "hit");
    }

    #[test]
    fn test_get_scene_timeline_neighbors_binary_order() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, synopsis, story_time_order, story_time_label)
             VALUES ('s1', 'p1', 'scene', 'Early', 'E', 'a0', 'Day 1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, synopsis, story_time_order, story_time_label)
             VALUES ('s2', 'p1', 'scene', 'Mid', 'M', 'a1', 'Day 2')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, synopsis, story_time_order, story_time_label)
             VALUES ('s3', 'p1', 'scene', 'Late', 'L', 'b0', 'Day 3')",
            [],
        )
        .unwrap();
        let unset = get_scene_timeline_neighbors(&conn, "p1", "missing").unwrap();
        assert!(unset.previous.is_empty());
        let no_order = conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('s0', 'p1', 'scene', 'No time')",
            [],
        );
        assert!(no_order.is_ok());
        let empty_neighbors = get_scene_timeline_neighbors(&conn, "p1", "s0").unwrap();
        assert!(empty_neighbors.previous.is_empty());
        assert!(empty_neighbors.next.is_empty());
        let mid = get_scene_timeline_neighbors(&conn, "p1", "s2").unwrap();
        assert_eq!(mid.current_scene_story_time_label.as_deref(), Some("Day 2"));
        assert_eq!(mid.previous.len(), 1);
        assert_eq!(mid.previous[0].id, "s1");
        assert_eq!(mid.next.len(), 1);
        assert_eq!(mid.next[0].id, "s3");
    }

    #[test]
    fn test_get_scene_timeline_neighbors_project_scope() {
        // 他プロジェクトの scene_id を渡しても、サーバ project に属さないので空を返す (XPROJ 防御)。
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_project(&conn, "p2", "Other");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, story_time_order, story_time_label)
             VALUES ('b1', 'p2', 'scene', 'B1', 'a0', 'Day 1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, story_time_order, story_time_label)
             VALUES ('b2', 'p2', 'scene', 'B2', 'a1', 'Day 2')",
            [],
        )
        .unwrap();
        // p1 にスコープして p2 の scene を引いても target が見つからず空。
        let cross = get_scene_timeline_neighbors(&conn, "p1", "b1").unwrap();
        assert!(cross.previous.is_empty());
        assert!(cross.next.is_empty());
        assert_eq!(cross.current_scene_story_time_label, None);
        // p2 にスコープすれば p2 内の近傍だけ返る。
        let in_scope = get_scene_timeline_neighbors(&conn, "p2", "b1").unwrap();
        assert_eq!(in_scope.next.len(), 1);
        assert_eq!(in_scope.next[0].id, "b2");
        assert!(in_scope.previous.is_empty());
    }

    #[test]
    fn test_list_open_foreshadows_filters_and_setup_count() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_scene(&conn, "sc1", "p1", "Scene 1", "draft");
        let now = 1_700_000_000_000_i64;
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, intent, secret, load_bearing, created_at, updated_at)
             VALUES ('f-open', 'p1', 'Open', 'hint', 0, 'critical', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, secret, abandoned, created_at, updated_at)
             VALUES ('f-secret', 'p1', 'Secret', 1, 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, secret, abandoned, created_at, updated_at)
             VALUES ('f-done', 'p1', 'Done', 0, 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "UPDATE foreshadows SET payoff_confirmed = 1 WHERE id = 'f-done'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, kind, is_orphan, created_at, updated_at)
             VALUES ('su1', 'f-open', 'sc1', 'designated_existing', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, kind, is_orphan, created_at, updated_at)
             VALUES ('su2', 'f-open', 'sc1', 'designated_existing', 1, ?1, ?1)",
            params![now],
        )
        .unwrap();
        let open = list_open_foreshadows(&conn, "p1").unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, "f-open");
        assert_eq!(open[0].setup_count, 1);
        // derivedLabel を出力に載せる (critical / setup=1 / 非weak → "seeded")。
        assert_eq!(open[0].derived_label, "seeded");
    }

    #[test]
    fn test_safe_parse_ai_evaluation_port() {
        assert!(!safe_parse_ai_evaluation(None));
        assert!(!safe_parse_ai_evaluation(Some("not json")));
        assert!(!safe_parse_ai_evaluation(Some(r#"{"careful": {}}"#)));
        let valid = r#"{"careful":{"strength":"subtle","reasoning":"a"},"casual":{"strength":"moderate","reasoning":"b"},"skim":{"strength":"overt","reasoning":"c"}}"#;
        assert!(safe_parse_ai_evaluation(Some(valid)));
        let partial = r#"{"careful":{"strength":"subtle","reasoning":"a"},"casual":{"strength":"bad","reasoning":"b"},"skim":{"strength":"overt","reasoning":"c"}}"#;
        assert!(!safe_parse_ai_evaluation(Some(partial)));
    }

    #[test]
    fn test_get_foreshadow_detail_project_scope() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        insert_project(&conn, "p2", "Other");
        insert_scene(&conn, "sc1", "p1", "Payoff Scene", "draft");
        let now = 1_700_000_000_000_i64;
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, intent, notes, payoff_scene_id, secret, created_at, updated_at)
             VALUES ('f1', 'p1', 'Thread', 'goal', 'note', 'sc1', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, secret, created_at, updated_at)
             VALUES ('f2', 'p2', 'Other project', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, kind, strength, attribution, created_at, updated_at)
             VALUES ('su1', 'f1', 'sc1', 'inserted_new', 'moderate', 'human', ?1, ?1)",
            params![now],
        )
        .unwrap();
        assert!(get_foreshadow_detail(&conn, "p1", "f2").unwrap().is_none());
        let detail = get_foreshadow_detail(&conn, "p1", "f1").unwrap().unwrap();
        assert_eq!(detail.title, "Thread");
        assert_eq!(detail.setups.len(), 1);
        assert_eq!(detail.setups[0].scene_title, "Payoff Scene");
        assert_eq!(
            detail.payoff_scene.as_ref().map(|p| p.title.as_str()),
            Some("Payoff Scene")
        );
    }

    fn fs_row(conn: &Connection, id: &str) -> Option<(String, i64, i64, i64, Option<String>)> {
        conn.query_row(
            "SELECT title, secret, payoff_confirmed, abandoned, load_bearing
             FROM foreshadows WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .ok()
    }

    /// Create via the tracked writer (grimodex-core) and verify the MCP
    /// read side consumes the row — the raw db.rs writers were removed when
    /// foreshadow writes moved onto the tracked path.
    #[test]
    fn test_tracked_create_visible_when_not_secret() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        let res = grimodex_core::writes::foreshadow::tracked_foreshadow_create(
            &conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowCreateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "mcp",
                foreshadow_id: "f1",
                title: "Planted clue",
                intent: Some("sets up the reveal"),
                notes: None,
                load_bearing: Some("critical"),
                secret: false,
            },
        )
        .unwrap();
        let (title, secret, payoff, abandoned, lb) = fs_row(&conn, &res.entity_id).unwrap();
        assert_eq!(title, "Planted clue");
        assert_eq!(secret, 0);
        assert_eq!(payoff, 0);
        assert_eq!(abandoned, 0);
        assert_eq!(lb.as_deref(), Some("critical"));
        // Non-secret + unresolved → appears in the open list (coherent round-trip).
        let open = list_open_foreshadows(&conn, "p1").unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, res.entity_id);
    }

    #[test]
    fn test_tracked_create_secret_hidden_from_open_list() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel");
        grimodex_core::writes::foreshadow::tracked_foreshadow_create(
            &conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowCreateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "mcp",
                foreshadow_id: "f1",
                title: "Hidden plant",
                intent: None,
                notes: None,
                load_bearing: None,
                secret: true,
            },
        )
        .unwrap();
        assert_eq!(fs_row(&conn, "f1").unwrap().1, 1); // secret
                                                       // Secret items are excluded from the open list, but still readable by id.
        assert!(list_open_foreshadows(&conn, "p1").unwrap().is_empty());
        assert!(get_foreshadow_detail(&conn, "p1", "f1").unwrap().is_some());
    }

    #[test]
    fn test_list_all_projects_returns_all() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel A");
        insert_project(&conn, "p2", "Novel B");
        let projs = list_all_projects(&conn).unwrap();
        assert_eq!(projs.len(), 2);
        let titles: Vec<&str> = projs.iter().map(|p| p.title.as_str()).collect();
        assert!(titles.contains(&"Novel A"));
        assert!(titles.contains(&"Novel B"));
    }

    #[test]
    fn test_fetch_project_title_some_and_none() {
        let conn = make_simple_db();
        insert_project(&conn, "p1", "Novel A");
        assert_eq!(
            fetch_project_title(&conn, "p1").unwrap().as_deref(),
            Some("Novel A")
        );
        assert_eq!(fetch_project_title(&conn, "missing").unwrap(), None);
    }
}
