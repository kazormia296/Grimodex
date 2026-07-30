//! Typed persistence commands for the project term dictionary.
//!
//! The renderer owns validation and presentation concerns, while this module
//! owns project scoping and SQL. Electron exposes these functions through
//! domain-specific N-API commands instead of accepting renderer-authored SQL.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::Database;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub preferred: String,
    pub variants: Vec<String>,
    pub severity: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertPayload {
    pub id: String,
    pub project_id: String,
    pub preferred: String,
    pub variants: Vec<String>,
    pub severity: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePayload {
    pub id: String,
    pub project_id: String,
    pub preferred: String,
    pub variants: Vec<String>,
    pub severity: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub updated_at: i64,
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("lint term dictionary {field} must not be empty");
    }
    Ok(())
}

fn validate_entry_fields(
    id: &str,
    project_id: &str,
    preferred: &str,
    variants: &[String],
    severity: &str,
) -> anyhow::Result<()> {
    require_non_empty(id, "id")?;
    require_non_empty(project_id, "projectId")?;
    require_non_empty(preferred, "preferred")?;
    if variants.is_empty() || variants.iter().any(String::is_empty) {
        anyhow::bail!("lint term dictionary variants must contain non-empty strings");
    }
    if severity != "warning" && severity != "info" {
        anyhow::bail!("lint term dictionary severity must be warning or info");
    }
    Ok(())
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let variants_json: String = row.get("variants")?;
    let variants = serde_json::from_str::<Vec<String>>(&variants_json)
        .unwrap_or_default()
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect();
    let severity: String = row.get("severity")?;
    let enabled: i64 = row.get("enabled")?;
    Ok(Entry {
        id: row.get("id")?,
        preferred: row.get("preferred")?,
        variants,
        severity: if severity == "info" {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        note: row.get("note")?,
        enabled: enabled == 1,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn select_entry(conn: &rusqlite::Connection, project_id: &str, id: &str) -> anyhow::Result<Entry> {
    let entry = conn
        .query_row(
            "SELECT id, preferred, variants, severity, note, enabled,
                    sort_order, created_at, updated_at
               FROM lint_term_dictionary
              WHERE project_id = ?1 AND id = ?2",
            params![project_id, id],
            row_to_entry,
        )
        .optional()?;
    entry.ok_or_else(|| anyhow::anyhow!("lint term dictionary entry not found"))
}

pub fn list(db: &Database, project_id: String) -> anyhow::Result<Vec<Entry>> {
    require_non_empty(&project_id, "projectId")?;
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, preferred, variants, severity, note, enabled,
                    sort_order, created_at, updated_at
               FROM lint_term_dictionary
              WHERE project_id = ?1
              ORDER BY sort_order ASC, preferred ASC",
        )?;
        let rows = statement
            .query_map(params![project_id], row_to_entry)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn insert(db: &Database, payload: InsertPayload) -> anyhow::Result<Entry> {
    validate_entry_fields(
        &payload.id,
        &payload.project_id,
        &payload.preferred,
        &payload.variants,
        &payload.severity,
    )?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO lint_term_dictionary
             (id, project_id, preferred, variants, severity, note, enabled,
              sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                payload.id,
                payload.project_id,
                payload.preferred,
                serde_json::to_string(&payload.variants)?,
                payload.severity,
                payload.note,
                i64::from(payload.enabled),
                payload.sort_order,
                payload.created_at,
                payload.updated_at,
            ],
        )?;
        select_entry(conn, &payload.project_id, &payload.id)
    })
}

pub fn update(db: &Database, payload: UpdatePayload) -> anyhow::Result<Entry> {
    validate_entry_fields(
        &payload.id,
        &payload.project_id,
        &payload.preferred,
        &payload.variants,
        &payload.severity,
    )?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE lint_term_dictionary
                SET preferred = ?1, variants = ?2, severity = ?3, note = ?4,
                    enabled = ?5, updated_at = ?6
              WHERE project_id = ?7 AND id = ?8",
            params![
                payload.preferred,
                serde_json::to_string(&payload.variants)?,
                payload.severity,
                payload.note,
                i64::from(payload.enabled),
                payload.updated_at,
                payload.project_id,
                payload.id,
            ],
        )?;
        select_entry(conn, &payload.project_id, &payload.id)
    })
}

pub fn set_enabled(
    db: &Database,
    project_id: String,
    id: String,
    enabled: bool,
    updated_at: i64,
) -> anyhow::Result<Entry> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&id, "id")?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE lint_term_dictionary
                SET enabled = ?1, updated_at = ?2
              WHERE project_id = ?3 AND id = ?4",
            params![i64::from(enabled), updated_at, project_id, id],
        )?;
        select_entry(conn, &project_id, &id)
    })
}

pub fn delete(db: &Database, project_id: String, id: String) -> anyhow::Result<()> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&id, "id")?;
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM lint_term_dictionary WHERE project_id = ?1 AND id = ?2",
            params![project_id, id],
        )?;
        Ok(())
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
            Ok(())
        })
        .expect("seed database");
        db
    }

    fn payload(id: &str, project_id: &str) -> InsertPayload {
        InsertPayload {
            id: id.to_string(),
            project_id: project_id.to_string(),
            preferred: "子ども".to_string(),
            variants: vec!["子供".to_string()],
            severity: "warning".to_string(),
            note: None,
            enabled: true,
            sort_order: 0,
            created_at: 10,
            updated_at: 10,
        }
    }

    #[test]
    fn typed_commands_scope_every_operation_to_project() {
        let db = fixture();
        let created = insert(&db, payload("term-1", "p1")).expect("insert");
        assert_eq!(created.variants, vec!["子供"]);
        assert_eq!(list(&db, "p1".to_string()).expect("list"), vec![created]);
        assert!(list(&db, "p2".to_string()).expect("list").is_empty());

        assert!(update(
            &db,
            UpdatePayload {
                id: "term-1".to_string(),
                project_id: "p2".to_string(),
                preferred: "こども".to_string(),
                variants: vec!["子供".to_string()],
                severity: "info".to_string(),
                note: None,
                enabled: true,
                updated_at: 20,
            },
        )
        .is_err());
        assert!(set_enabled(&db, "p2".to_string(), "term-1".to_string(), false, 20,).is_err());
        delete(&db, "p2".to_string(), "term-1".to_string()).expect("delete other project");
        assert_eq!(list(&db, "p1".to_string()).expect("list").len(), 1);
    }

    #[test]
    fn update_and_enabled_return_authoritative_rows() {
        let db = fixture();
        insert(&db, payload("term-1", "p1")).expect("insert");
        let updated = update(
            &db,
            UpdatePayload {
                id: "term-1".to_string(),
                project_id: "p1".to_string(),
                preferred: "こども".to_string(),
                variants: vec!["子供".to_string(), "児童".to_string()],
                severity: "info".to_string(),
                note: Some("統一".to_string()),
                enabled: true,
                updated_at: 20,
            },
        )
        .expect("update");
        assert_eq!(updated.preferred, "こども");
        assert_eq!(updated.severity, "info");

        let disabled =
            set_enabled(&db, "p1".to_string(), "term-1".to_string(), false, 30).expect("disable");
        assert!(!disabled.enabled);
        assert_eq!(disabled.updated_at, 30);
    }

    #[test]
    fn corrupt_wire_columns_keep_legacy_read_fallbacks() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO lint_term_dictionary
                 (id, project_id, preferred, variants, severity, note, enabled,
                  sort_order, created_at, updated_at)
                 VALUES ('term-1', 'p1', '表記', 'broken', 'other', NULL, 2, 0, 1, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed corrupt row");
        let rows = list(&db, "p1".to_string()).expect("list");
        assert!(rows[0].variants.is_empty());
        assert_eq!(rows[0].severity, "warning");
        assert!(!rows[0].enabled);
    }
}
