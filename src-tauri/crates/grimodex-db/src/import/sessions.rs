use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{require_generic_import_capture_allowed, Database};

const STATE_CREATED: &str = "created";
const STATE_SOURCE_SAVED: &str = "source-saved";
const STATE_CANCELLED: &str = "cancelled";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionCreatePayload {
    pub session_id: Option<String>,
    pub adapter_id: Option<String>,
    pub adapter_version: Option<String>,
    pub target_json: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImportSourcePackagePayload {
    pub session_id: String,
    pub package_id: Option<String>,
    pub digest: String,
    pub adapter_id: String,
    pub adapter_version: String,
    pub package_json: Value,
}

pub fn create_session(db: &Database, payload: ImportSessionCreatePayload) -> anyhow::Result<Value> {
    let session_id = payload.session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now();
    db.with_conn(|conn| {
        require_generic_import_capture_allowed(conn)?;
        conn.execute(
            "INSERT INTO import_sessions (
                id, state, adapter_id, adapter_version, target_json,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                session_id,
                STATE_CREATED,
                payload.adapter_id,
                payload.adapter_version,
                payload.target_json.to_string(),
                now,
            ],
        )?;
        get_session_value(conn, &session_id)?
            .ok_or_else(|| anyhow::anyhow!("created import session '{session_id}' was not found"))
    })
}

pub fn get_session(db: &Database, session_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        get_session_value(conn, &session_id)?
            .ok_or_else(|| anyhow::anyhow!("import session '{session_id}' not found"))
    })
}

pub fn list_sessions(db: &Database) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, state, adapter_id, adapter_version, target_json,
                    source_package_digest, source_package_ref, extraction_run_ids_json,
                    proposal_set_ids_json, error_message, version, created_at, updated_at
               FROM import_sessions
              ORDER BY created_at DESC",
        )?;
        let sessions = statement
            .query_map([], row_to_session_value)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({ "sessions": sessions }))
    })
}

pub fn cancel_session(db: &Database, session_id: String) -> anyhow::Result<Value> {
    let now = now();
    db.with_conn(|conn| {
        require_generic_import_capture_allowed(conn)?;
        let changed = conn.execute(
            "UPDATE import_sessions
                SET state = ?1, updated_at = ?2, version = version + 1
              WHERE id = ?3 AND state NOT IN ('committed', 'cancelled')",
            params![STATE_CANCELLED, now, session_id],
        )?;
        anyhow::ensure!(changed == 1, "import session '{session_id}' cannot be cancelled");
        get_session_value(conn, &session_id)?
            .ok_or_else(|| anyhow::anyhow!("cancelled import session '{session_id}' was not found"))
    })
}

pub fn save_source_package(
    db: &Database,
    payload: SaveImportSourcePackagePayload,
) -> anyhow::Result<Value> {
    let package_id = payload.package_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now();
    db.with_conn(|conn| {
        require_generic_import_capture_allowed(conn)?;
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM import_sessions WHERE id = ?1",
                [&payload.session_id],
                |row| row.get(0),
            )
            .optional()?;
        let state = state
            .ok_or_else(|| anyhow::anyhow!("import session '{}' not found", payload.session_id))?;
        anyhow::ensure!(
            state != "committed" && state != STATE_CANCELLED,
            "import session '{}' cannot accept a source package while {state}",
            payload.session_id
        );
        conn.execute(
            "INSERT INTO import_source_packages (
                id, session_id, digest, adapter_id, adapter_version, package_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                package_id,
                payload.session_id,
                payload.digest,
                payload.adapter_id,
                payload.adapter_version,
                payload.package_json.to_string(),
                now,
            ],
        )?;
        conn.execute(
            "UPDATE import_sessions
                SET state = ?1, adapter_id = ?2, adapter_version = ?3,
                    source_package_digest = ?4, source_package_ref = ?5,
                    error_message = NULL, updated_at = ?6, version = version + 1
              WHERE id = ?7",
            params![
                STATE_SOURCE_SAVED,
                payload.adapter_id,
                payload.adapter_version,
                payload.digest,
                package_id,
                now,
                payload.session_id,
            ],
        )?;
        Ok(json!({
            "packageId": package_id,
            "sessionId": payload.session_id,
            "digest": payload.digest,
            "state": STATE_SOURCE_SAVED,
        }))
    })
}

fn get_session_value(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> anyhow::Result<Option<Value>> {
    conn.query_row(
        "SELECT id, state, adapter_id, adapter_version, target_json,
                source_package_digest, source_package_ref, extraction_run_ids_json,
                proposal_set_ids_json, error_message, version, created_at, updated_at
           FROM import_sessions WHERE id = ?1",
        [session_id],
        row_to_session_value,
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_session_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let parse = |index| {
        row.get::<_, String>(index)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null)
    };
    Ok(json!({
        "sessionId": row.get::<_, String>(0)?,
        "state": row.get::<_, String>(1)?,
        "adapterId": row.get::<_, Option<String>>(2)?,
        "adapterVersion": row.get::<_, Option<String>>(3)?,
        "target": parse(4),
        "sourcePackageDigest": row.get::<_, Option<String>>(5)?,
        "sourcePackageRef": row.get::<_, Option<String>>(6)?,
        "extractionRunIds": parse(7),
        "proposalSetIds": parse(8),
        "errorMessage": row.get::<_, Option<String>>(9)?,
        "version": row.get::<_, i64>(10)?,
        "createdAt": row.get::<_, String>(11)?,
        "updatedAt": row.get::<_, String>(12)?,
    }))
}

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
