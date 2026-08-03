//! Typed persistence commands for the lint diagnostic ignore list.
//!
//! The renderer used to own the SQL for this small domain in a Zustand store
//! and in the settings list component.  Keeping the queries here gives the
//! Electron and legacy Tauri callers one project-scoped implementation while
//! leaving the renderer with a domain-shaped API.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::Database;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePayload {
    pub id: String,
    pub project_id: String,
    pub scene_id: String,
    pub rule_id: String,
    pub text_snippet: String,
    pub context_before: String,
    pub context_after: String,
    pub note: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPayload {
    pub project_id: String,
    pub from_scene_id: String,
    pub to_scene_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePayload {
    pub project_id: String,
    pub from_scene_ids: Vec<String>,
    pub to_scene_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub rule_id: String,
    pub scene_id: String,
    pub text_snippet: String,
    pub context_before: String,
    pub context_after: String,
    pub note: Option<String>,
    pub created_at: i64,
    pub scene_title: Option<String>,
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("lint ignore {field} must not be empty");
    }
    Ok(())
}

fn ensure_scene_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        anyhow::bail!("lint ignore scene is not in the requested project");
    }
    Ok(())
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get("id")?,
        rule_id: row.get("rule_id")?,
        scene_id: row.get("scene_id")?,
        text_snippet: row.get("text_snippet")?,
        context_before: row.get("context_before")?,
        context_after: row.get("context_after")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        scene_title: row.get("scene_title")?,
    })
}

fn select_entry(conn: &rusqlite::Connection, id: &str) -> anyhow::Result<Entry> {
    Ok(conn.query_row(
        "SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                l.context_before, l.context_after, l.note, l.created_at,
                t.title AS scene_title
           FROM lint_ignored_diagnostics l
           LEFT JOIN tree_nodes t ON t.id = l.scene_id
          WHERE l.id = ?1",
        params![id],
        row_to_entry,
    )?)
}

fn select_entries_for_scene(
    conn: &rusqlite::Connection,
    scene_id: &str,
) -> anyhow::Result<Vec<Entry>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                l.context_before, l.context_after, l.note, l.created_at,
                t.title AS scene_title
           FROM lint_ignored_diagnostics l
           LEFT JOIN tree_nodes t ON t.id = l.scene_id
          WHERE l.scene_id = ?1
          ORDER BY l.created_at DESC",
    )?;
    let rows = stmt
        .query_map(params![scene_id], row_to_entry)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_for_project(db: &Database, project_id: String) -> anyhow::Result<Vec<Entry>> {
    require_non_empty(&project_id, "projectId")?;
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                    l.context_before, l.context_after, l.note, l.created_at,
                    t.title AS scene_title
               FROM lint_ignored_diagnostics l
               LEFT JOIN tree_nodes t ON t.id = l.scene_id
              WHERE t.project_id = ?1 OR t.project_id IS NULL
              ORDER BY t.title IS NULL, t.title, l.created_at DESC",
        )?;
        let rows = stmt
            .query_map(params![project_id], row_to_entry)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn list_for_scene(
    db: &Database,
    project_id: String,
    scene_id: String,
) -> anyhow::Result<Vec<Entry>> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&scene_id, "sceneId")?;
    db.with_conn(|conn| {
        ensure_scene_in_project(conn, &project_id, &scene_id)?;
        select_entries_for_scene(conn, &scene_id)
    })
}

pub fn create(db: &Database, payload: CreatePayload) -> anyhow::Result<Entry> {
    require_non_empty(&payload.id, "id")?;
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.scene_id, "sceneId")?;
    require_non_empty(&payload.rule_id, "ruleId")?;
    db.with_conn(|conn| {
        ensure_scene_in_project(conn, &payload.project_id, &payload.scene_id)?;
        conn.execute(
            "INSERT INTO lint_ignored_diagnostics
             (id, rule_id, scene_id, text_snippet, context_before, context_after, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                payload.id,
                payload.rule_id,
                payload.scene_id,
                payload.text_snippet,
                payload.context_before,
                payload.context_after,
                payload.note,
                payload.created_at,
            ],
        )?;
        select_entry(conn, &payload.id)
    })
}

pub fn delete(db: &Database, project_id: String, id: String) -> anyhow::Result<()> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&id, "id")?;
    db.with_conn(|conn| {
        // Orphan rows are retained by the list query for cleanup visibility.
        // They are safe to delete only when they cannot be associated with a
        // live scene in another project.
        conn.execute(
            "DELETE FROM lint_ignored_diagnostics
              WHERE id = ?1
                AND (EXISTS (
                       SELECT 1 FROM tree_nodes t
                        WHERE t.id = lint_ignored_diagnostics.scene_id
                          AND t.project_id = ?2
                     ) OR NOT EXISTS (
                       SELECT 1 FROM tree_nodes t
                        WHERE t.id = lint_ignored_diagnostics.scene_id
                     ))",
            params![id, project_id],
        )?;
        Ok(())
    })
}

pub fn copy(db: &Database, payload: CopyPayload) -> anyhow::Result<Vec<Entry>> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.from_scene_id, "fromSceneId")?;
    require_non_empty(&payload.to_scene_id, "toSceneId")?;
    db.with_conn(|conn| {
        ensure_scene_in_project(conn, &payload.project_id, &payload.from_scene_id)?;
        ensure_scene_in_project(conn, &payload.project_id, &payload.to_scene_id)?;
        let source = select_entries_for_scene(conn, &payload.from_scene_id)?;
        let tx = conn.unchecked_transaction()?;
        for entry in &source {
            tx.execute(
                "INSERT INTO lint_ignored_diagnostics
                 (id, rule_id, scene_id, text_snippet, context_before, context_after, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    entry.rule_id,
                    payload.to_scene_id,
                    entry.text_snippet,
                    entry.context_before,
                    entry.context_after,
                    entry.note,
                    entry.created_at,
                ],
            )?;
        }
        tx.commit()?;
        select_entries_for_scene(conn, &payload.to_scene_id)
    })
}

pub fn move_to_scene(db: &Database, payload: MovePayload) -> anyhow::Result<Vec<Entry>> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.to_scene_id, "toSceneId")?;
    if payload.from_scene_ids.is_empty() {
        return Ok(Vec::new());
    }
    db.with_conn(|conn| {
        ensure_scene_in_project(conn, &payload.project_id, &payload.to_scene_id)?;
        for scene_id in &payload.from_scene_ids {
            require_non_empty(scene_id, "fromSceneIds[]")?;
            ensure_scene_in_project(conn, &payload.project_id, scene_id)?;
        }
        let tx = conn.unchecked_transaction()?;
        for scene_id in &payload.from_scene_ids {
            tx.execute(
                "UPDATE lint_ignored_diagnostics
                    SET scene_id = ?1
                  WHERE scene_id = ?2",
                params![payload.to_scene_id, scene_id],
            )?;
        }
        tx.commit()?;
        select_entries_for_scene(conn, &payload.to_scene_id)
    })
}

pub fn encode<T: Serialize>(value: T) -> anyhow::Result<String> {
    Ok(serde_json::to_string(&value)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Project 1'), ('p2', 'Project 2')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                 VALUES ('s1', 'p1', 'scene', 'Scene 1'),
                        ('s2', 'p1', 'scene', 'Scene 2'),
                        ('s3', 'p2', 'scene', 'Other project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed database");
        db
    }

    fn payload(id: &str, scene_id: &str) -> CreatePayload {
        CreatePayload {
            id: id.to_string(),
            project_id: "p1".to_string(),
            scene_id: scene_id.to_string(),
            rule_id: "ja/quote-period".to_string(),
            text_snippet: "本文".to_string(),
            context_before: "前".to_string(),
            context_after: "後".to_string(),
            note: None,
            created_at: 10,
        }
    }

    #[test]
    fn typed_commands_scope_reads_and_writes_to_project() {
        let db = fixture();
        let created = create(&db, payload("i1", "s1")).expect("create");
        assert_eq!(created.scene_title.as_deref(), Some("Scene 1"));
        let listed = list_for_project(&db, "p1".to_string()).expect("list");
        assert_eq!(listed, vec![created.clone()]);
        assert!(create(
            &db,
            CreatePayload {
                project_id: "p2".to_string(),
                ..payload("i2", "s1")
            }
        )
        .is_err());
        assert!(delete(&db, "p2".to_string(), "i1".to_string()).is_ok());
        assert_eq!(
            list_for_project(&db, "p1".to_string()).expect("list").len(),
            1
        );
    }

    #[test]
    fn copy_and_move_return_the_authoritative_rows() {
        let db = fixture();
        create(&db, payload("i1", "s1")).expect("create");
        let copies = copy(
            &db,
            CopyPayload {
                project_id: "p1".to_string(),
                from_scene_id: "s1".to_string(),
                to_scene_id: "s2".to_string(),
            },
        )
        .expect("copy");
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].scene_id, "s2");
        let moved = move_to_scene(
            &db,
            MovePayload {
                project_id: "p1".to_string(),
                from_scene_ids: vec!["s2".to_string()],
                to_scene_id: "s1".to_string(),
            },
        )
        .expect("move");
        assert_eq!(moved.len(), 2);
        assert!(moved.iter().all(|entry| entry.scene_id == "s1"));
    }
}
