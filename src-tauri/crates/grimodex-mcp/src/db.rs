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
}
