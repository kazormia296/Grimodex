use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{require_generic_import_capture_allowed, Database};

use super::inventory::{reject_symlink_kind, validate_relative_path};

const STATE_CAPTURING: &str = "capturing";
const STATE_SEALED: &str = "sealed";
const STATUS_SELECTED: &str = "selected";
const STATUS_EXCLUDED: &str = "excluded";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEntryInput {
    pub entry_id: String,
    pub resource_key: String,
    pub parent_resource_key: Option<String>,
    pub relative_path: String,
    pub kind: String,
    pub byte_length: i64,
    pub extension: Option<String>,
    pub capture_status: String,
    pub raw_digest: Option<String>,
    pub blob_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCaptureInput {
    pub capture_id: Option<String>,
    pub source_kind: String,
    pub budget_json: Value,
    pub entries: Vec<CaptureEntryInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCaptureSelectionInput {
    pub capture_id: String,
    pub selected_entry_ids: Vec<String>,
}

pub fn create_capture(db: &Database, input: CreateCaptureInput) -> anyhow::Result<Value> {
    let capture_id = input
        .capture_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            require_generic_import_capture_allowed(conn)?;
            conn.execute(
                "INSERT INTO import_captures (
                    id, state, source_kind, budget_json, version, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                params![
                    capture_id,
                    STATE_CAPTURING,
                    input.source_kind,
                    input.budget_json.to_string(),
                    now
                ],
            )?;
            for entry in &input.entries {
                validate_relative_path(&entry.relative_path)?;
                reject_symlink_kind(&entry.kind)?;
                anyhow::ensure!(entry.byte_length >= 0, "capture entry byte_length must be non-negative");
                if let Some(digest) = &entry.raw_digest {
                    conn.execute(
                        "INSERT OR IGNORE INTO import_capture_blobs (digest, byte_length, created_at)
                         VALUES (?1, ?2, ?3)",
                        params![digest, entry.byte_length, now],
                    )?;
                }
                conn.execute(
                    "INSERT INTO import_capture_entries (
                        id, capture_id, resource_key, parent_resource_key, relative_path, kind,
                        byte_length, extension, capture_status, raw_digest, blob_ref, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        entry.entry_id,
                        capture_id,
                        entry.resource_key,
                        entry.parent_resource_key,
                        entry.relative_path,
                        entry.kind,
                        entry.byte_length,
                        entry.extension,
                        initial_capture_status(&entry.capture_status),
                        entry.raw_digest,
                        entry.blob_ref,
                        now,
                    ],
                )?;
            }
            get_capture_value(conn, &capture_id)?
                .ok_or_else(|| anyhow::anyhow!("created import capture '{capture_id}' was not found"))
        })();
        complete_transaction(conn, result)
    })
}

pub fn get_capture(db: &Database, capture_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let mut capture = get_capture_value(conn, &capture_id)?
            .ok_or_else(|| anyhow::anyhow!("import capture '{capture_id}' not found"))?;
        let mut statement = conn.prepare(
            "SELECT id, resource_key, parent_resource_key, relative_path, kind, byte_length,
                    extension, capture_status, raw_digest, blob_ref, created_at
               FROM import_capture_entries
              WHERE capture_id = ?1
              ORDER BY relative_path, id",
        )?;
        let entries = statement
            .query_map([&capture_id], |row| {
                Ok(json!({
                    "entryId": row.get::<_, String>(0)?,
                    "resourceKey": row.get::<_, String>(1)?,
                    "parentResourceKey": row.get::<_, Option<String>>(2)?,
                    "relativePath": row.get::<_, String>(3)?,
                    "kind": row.get::<_, String>(4)?,
                    "byteLength": row.get::<_, i64>(5)?,
                    "extension": row.get::<_, Option<String>>(6)?,
                    "captureStatus": row.get::<_, String>(7)?,
                    "rawDigest": row.get::<_, Option<String>>(8)?,
                    "blobRef": row.get::<_, Option<String>>(9)?,
                    "createdAt": row.get::<_, String>(10)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        capture["entries"] = Value::Array(entries);
        Ok(capture)
    })
}

pub fn update_selection(
    db: &Database,
    input: UpdateCaptureSelectionInput,
) -> anyhow::Result<Value> {
    let now = now();
    db.with_conn(|conn| {
        require_generic_import_capture_allowed(conn)?;
        let state: String = conn.query_row(
            "SELECT state FROM import_captures WHERE id = ?1",
            [&input.capture_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            state != STATE_SEALED,
            "sealed import captures cannot change selection"
        );
        for entry_id in &input.selected_entry_ids {
            let changed = conn.execute(
                "UPDATE import_capture_entries
                    SET capture_status = ?1
                  WHERE id = ?2 AND capture_id = ?3",
                params![STATUS_SELECTED, entry_id, input.capture_id],
            )?;
            anyhow::ensure!(
                changed == 1,
                "capture entry '{entry_id}' does not belong to '{}'",
                input.capture_id
            );
        }
        if input.selected_entry_ids.is_empty() {
            conn.execute(
                "UPDATE import_capture_entries SET capture_status = ?1 WHERE capture_id = ?2",
                params![STATUS_EXCLUDED, input.capture_id],
            )?;
        } else {
            let placeholders = (1..=input.selected_entry_ids.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "UPDATE import_capture_entries
                    SET capture_status = '{STATUS_EXCLUDED}'
                  WHERE capture_id = ?{} AND id NOT IN ({placeholders})",
                input.selected_entry_ids.len() + 1
            );
            let mut selection_params = input.selected_entry_ids.clone();
            selection_params.push(input.capture_id.clone());
            conn.execute(&sql, rusqlite::params_from_iter(selection_params))?;
        }
        conn.execute(
            "UPDATE import_captures
                SET updated_at = ?1, version = version + 1
              WHERE id = ?2",
            params![now, input.capture_id],
        )?;
        get_capture_value(conn, &input.capture_id)?
            .ok_or_else(|| anyhow::anyhow!("import capture '{}' not found", input.capture_id))
    })
}

pub fn seal_capture(db: &Database, capture_id: String) -> anyhow::Result<Value> {
    let now = now();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            require_generic_import_capture_allowed(conn)?;
            let state: String = conn.query_row(
                "SELECT state FROM import_captures WHERE id = ?1",
                [&capture_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                state != STATE_SEALED,
                "import capture '{capture_id}' is already sealed"
            );
            let mut statement = conn.prepare(
                "SELECT raw_digest
                   FROM import_capture_entries
                  WHERE capture_id = ?1 AND capture_status = ?2
                  ORDER BY raw_digest",
            )?;
            let digests = statement
                .query_map(params![capture_id, STATUS_SELECTED], |row| {
                    row.get::<_, Option<String>>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            anyhow::ensure!(
                digests.iter().all(Option::is_some),
                "all selected import capture entries require raw_digest before sealing"
            );
            let mut hasher = Sha256::new();
            for digest in digests.into_iter().flatten() {
                hasher.update(digest.as_bytes());
                hasher.update(b"\n");
            }
            let sealed_digest = hex::encode(hasher.finalize());
            conn.execute(
                "UPDATE import_captures
                    SET state = ?1, sealed_digest = ?2, updated_at = ?3, version = version + 1
                  WHERE id = ?4",
                params![STATE_SEALED, sealed_digest, now, capture_id],
            )?;
            get_capture_value(conn, &capture_id)?.ok_or_else(|| {
                anyhow::anyhow!("sealed import capture '{capture_id}' was not found")
            })
        })();
        complete_transaction(conn, result)
    })
}

fn get_capture_value(
    conn: &rusqlite::Connection,
    capture_id: &str,
) -> anyhow::Result<Option<Value>> {
    conn.query_row(
        "SELECT id, state, source_kind, sealed_digest, budget_json, version, created_at, updated_at
           FROM import_captures WHERE id = ?1",
        [capture_id],
        |row| {
            let budget_json: String = row.get(4)?;
            let budget = serde_json::from_str::<Value>(&budget_json).unwrap_or(Value::Null);
            Ok(json!({
                "captureId": row.get::<_, String>(0)?,
                "state": row.get::<_, String>(1)?,
                "sourceKind": row.get::<_, String>(2)?,
                "sealedDigest": row.get::<_, Option<String>>(3)?,
                "budget": budget,
                "version": row.get::<_, i64>(5)?,
                "createdAt": row.get::<_, String>(6)?,
                "updatedAt": row.get::<_, String>(7)?,
            }))
        },
    )
    .optional()
    .map_err(Into::into)
}

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn initial_capture_status(status: &str) -> &str {
    match status {
        "excluded" => STATUS_EXCLUDED,
        // Inventory adapters report candidates as `included`; the persisted
        // selection state calls the same initial choice `selected`.
        _ => STATUS_SELECTED,
    }
}

fn complete_transaction<T>(
    conn: &rusqlite::Connection,
    result: anyhow::Result<T>,
) -> anyhow::Result<T> {
    match result {
        Ok(value) => {
            if let Err(error) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error.into())
            } else {
                Ok(value)
            }
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
