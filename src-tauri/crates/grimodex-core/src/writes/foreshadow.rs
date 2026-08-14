//! Tracked foreshadow create/update — closes the last untracked AI write.
//!
//! Mirrors `writes::codex` / `writes::snippet`: one BEGIN IMMEDIATE tx writes
//! the entity row + undo_journal + change_events (domain "foreshadow"). Two
//! deliberate differences from codex:
//!
//! - **No authorship_spans**: `authorship_spans` only has codex_entry_id /
//!   snippet_id FKs; foreshadow rows are metadata, not prose. Snapshots carry
//!   the plain row fields only.
//! - **Root OCC**: v12 foreshadows carry an integer `version`. Every successful
//!   root mutation advances it and tracked writes persist the actual before /
//!   after versions in the journal and receipt. Undo / redo keeps that token
//!   monotonic instead of restoring a historical version.

use anyhow::Context;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::writes::WriteResult;

pub struct TrackedForeshadowCreateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    /// Caller-supplied UUID (like snippet_id in tracked_snippet_create).
    pub foreshadow_id: &'a str,
    pub title: &'a str,
    pub intent: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub load_bearing: Option<&'a str>,
    pub secret: bool,
    /// Stable identity of the logical request. Unlike `foreshadow_id`, this
    /// survives a caller retry that generated a fresh entity UUID.
    pub request_id: Option<&'a str>,
    /// Hash of the normalized client create request. When present, the
    /// persisted create journal becomes a durable idempotency record.
    pub request_hash: Option<&'a str>,
}

/// Only `Some` fields are written (same contract as the raw dynamic-SET
/// updater this replaces).
#[derive(Default)]
pub struct ForeshadowPatch<'a> {
    pub title: Option<&'a str>,
    pub intent: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub load_bearing: Option<&'a str>,
    pub payoff_confirmed: Option<bool>,
    pub abandoned: Option<bool>,
    pub secret: Option<bool>,
}

pub struct TrackedForeshadowUpdateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    pub foreshadow_id: &'a str,
    pub patch: ForeshadowPatch<'a>,
}

/// Full-row snapshot for undo_journal (camelCase keys, like codex/snippet).
fn foreshadow_snapshot(
    conn: &Connection,
    project_id: &str,
    foreshadow_id: &str,
) -> anyhow::Result<Option<String>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'title', title,
            'intent', intent, 'notes', notes,
            'payoffSceneId', payoff_scene_id,
            'payoffFromPos', payoff_from_pos, 'payoffToPos', payoff_to_pos,
            'payoffConfirmed', payoff_confirmed, 'abandoned', abandoned,
            'secret', secret, 'loadBearing', load_bearing,
            'mechanism', mechanism, 'version', version,
            'codexLinkDirtyAt', codex_link_dirty_at,
            'createdAt', created_at, 'updatedAt', updated_at
         ) FROM foreshadows WHERE id = ?1 AND project_id = ?2",
        params![foreshadow_id, project_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(Into::into)
}

fn existing_create_result(
    conn: &Connection,
    input: &TrackedForeshadowCreateInput<'_>,
    request_hash: &str,
) -> anyhow::Result<Option<WriteResult>> {
    let row = conn
        .query_row(
            "SELECT uj.id, uj.result_version, uj.change_event_uid, ce.payload
             FROM undo_journal uj
             LEFT JOIN change_events ce
               ON ce.project_id = uj.project_id
              AND ce.event_uid = uj.change_event_uid
             WHERE uj.project_id = ?1
               AND uj.entity_kind = 'foreshadow'
               AND uj.entity_id = ?2
               AND uj.op_kind = 'create'
             ORDER BY uj.rowid ASC
             LIMIT 1",
            params![input.project_id, input.foreshadow_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let entity_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM foreshadows WHERE id = ?1)",
        params![input.foreshadow_id],
        |row| row.get(0),
    )?;
    let Some((undo_journal_id, version, change_event_uid, payload)) = row else {
        if entity_exists {
            anyhow::bail!(
                "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: entity id already exists without matching request"
            );
        }
        return Ok(None);
    };
    let stored_hash = payload
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()?
        .and_then(|value| {
            value
                .get("requestHash")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    if !entity_exists || stored_hash.as_deref() != Some(request_hash) {
        anyhow::bail!(
            "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: request id reused with different payload or state"
        );
    }
    Ok(Some(WriteResult {
        entity_id: input.foreshadow_id.to_string(),
        version,
        change_event_uid: change_event_uid.ok_or_else(|| {
            anyhow::anyhow!(
                "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: missing original change event"
            )
        })?,
        undo_journal_id,
    }))
}

fn existing_request_result(
    conn: &Connection,
    request_id: &str,
    request_hash: &str,
) -> anyhow::Result<Option<WriteResult>> {
    let row = conn
        .query_row(
            "SELECT uj.entity_id, uj.result_version, uj.change_event_uid, ce.payload
             FROM undo_journal uj
             LEFT JOIN change_events ce
               ON ce.project_id = uj.project_id
              AND ce.event_uid = uj.change_event_uid
             WHERE uj.id = ?1",
            params![request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((entity_id, version, change_event_uid, payload)) = row else {
        return Ok(None);
    };
    let stored_hash = payload
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()?
        .and_then(|value| {
            value
                .get("requestHash")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    if stored_hash.as_deref() != Some(request_hash) {
        anyhow::bail!(
            "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: request id reused with different payload"
        );
    }
    Ok(Some(WriteResult {
        entity_id,
        version,
        change_event_uid: change_event_uid.ok_or_else(|| {
            anyhow::anyhow!(
                "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: missing original change event"
            )
        })?,
        undo_journal_id: request_id.to_string(),
    }))
}

fn existing_update_request_result(
    conn: &Connection,
    input: &TrackedForeshadowUpdateInput<'_>,
    request_id: &str,
    request_hash: &str,
) -> anyhow::Result<Option<WriteResult>> {
    let row = conn
        .query_row(
            "SELECT uj.project_id, uj.entity_id, uj.result_version,
                    uj.change_event_uid, ce.payload
               FROM undo_journal uj
               LEFT JOIN change_events ce
                 ON ce.project_id = uj.project_id
                AND ce.event_uid = uj.change_event_uid
              WHERE uj.id = ?1 AND uj.op_kind = 'update'",
            params![request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((project_id, entity_id, version, change_event_uid, payload)) = row else {
        return Ok(None);
    };
    let stored_hash = payload
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()?
        .and_then(|value| {
            value
                .get("requestHash")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    if project_id != input.project_id
        || entity_id != input.foreshadow_id
        || stored_hash.as_deref() != Some(request_hash)
    {
        anyhow::bail!(
            "AGENT_FORESHADOW_UPDATE_IDEMPOTENCY_CONFLICT: request id reused with different payload"
        );
    }
    Ok(Some(WriteResult {
        entity_id,
        version,
        change_event_uid: change_event_uid.ok_or_else(|| {
            anyhow::anyhow!(
                "AGENT_FORESHADOW_UPDATE_IDEMPOTENCY_CONFLICT: missing original change event"
            )
        })?,
        undo_journal_id: request_id.to_string(),
    }))
}

pub fn tracked_foreshadow_create(
    conn: &Connection,
    input: TrackedForeshadowCreateInput<'_>,
) -> anyhow::Result<WriteResult> {
    let project_id = input.project_id;
    let session_id = input.session_id;
    tracked_foreshadow_create_with_in_tx_hook(conn, input, move |conn, event, _undo_id| {
        append_change_events_in_tx(conn, project_id, session_id, std::slice::from_ref(event))?;
        Ok(())
    })
}

/// Variant for an authority layer that must append additional ledgers before
/// the tracked Foreshadow transaction commits. The hook receives the canonical
/// Change Event and Undo Journal identity after the domain row and journal have
/// been written, but before commit. Returning an error rolls the entire write
/// back. The compatibility wrapper above keeps the established core-only path.
pub fn tracked_foreshadow_create_with_in_tx_hook<F>(
    conn: &Connection,
    input: TrackedForeshadowCreateInput<'_>,
    append_change_in_tx: F,
) -> anyhow::Result<WriteResult>
where
    F: FnOnce(&Connection, &AppendChangeEvent, &str) -> anyhow::Result<()>,
{
    let undo_id = input
        .request_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    let mut change_payload = json!({
        "title": input.title,
        "loadBearing": input.load_bearing,
        "secret": input.secret,
    });
    if let Some(request_hash) = input.request_hash {
        change_payload["requestHash"] = serde_json::Value::String(request_hash.to_string());
    }
    let change_payload = change_payload.to_string();

    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> anyhow::Result<WriteResult> {
        if let Some(request_hash) = input.request_hash {
            if let Some(request_id) = input.request_id {
                if let Some(existing) = existing_request_result(conn, request_id, request_hash)? {
                    return Ok(existing);
                }
            } else if let Some(existing) = existing_create_result(conn, &input, request_hash)? {
                return Ok(existing);
            }
        }
        conn.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos,
              payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, 0, 0, ?6, ?7, ?8, ?8)",
            params![
                input.foreshadow_id,
                input.project_id,
                input.title,
                input.intent,
                input.notes,
                input.secret as i64,
                input.load_bearing,
                now,
            ],
        )?;

        let after_snapshot = foreshadow_snapshot(conn, input.project_id, input.foreshadow_id)?
            .ok_or_else(|| anyhow::anyhow!("foreshadow row missing right after insert"))?;
        let after: serde_json::Value = serde_json::from_str(&after_snapshot)?;
        let result_version = after["version"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("foreshadow snapshot missing version after insert"))?;

        insert_undo_journal_in_tx(
            conn,
            UndoJournalInsert {
                id: &undo_id,
                project_id: input.project_id,
                surface: input.surface,
                entity_kind: "foreshadow",
                entity_id: input.foreshadow_id,
                op_kind: "create",
                before_json: None,
                after_json: Some(&after_snapshot),
                base_version: 0,
                result_version,
                change_event_uid: Some(&event_uid),
            },
        )?;

        let canonical_event = AppendChangeEvent {
            event_uid: event_uid.clone(),
            scene_id: None,
            domain: "foreshadow".to_string(),
            op_type: "foreshadow.create".to_string(),
            entity_type: Some("foreshadow".to_string()),
            entity_id: Some(input.foreshadow_id.to_string()),
            payload: change_payload,
            timestamp: now,
        };
        append_change_in_tx(conn, &canonical_event, &undo_id)?;

        Ok(WriteResult {
            entity_id: input.foreshadow_id.to_string(),
            version: result_version,
            change_event_uid: event_uid,
            undo_journal_id: undo_id,
        })
    })();

    match result {
        Ok(res) => {
            crate::commit_or_rollback(conn)?;
            Ok(res)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
    .context("tracked_foreshadow_create")
}

/// Returns `Ok(None)` when the foreshadow does not exist **in this project**
/// (cross-project ids are indistinguishable from missing — XPROJ defense).
/// Nothing is written in that case.
#[cfg(test)]
fn tracked_foreshadow_update(
    conn: &Connection,
    input: TrackedForeshadowUpdateInput<'_>,
) -> anyhow::Result<Option<WriteResult>> {
    let project_id = input.project_id;
    let session_id = input.session_id;
    tracked_foreshadow_update_impl(
        conn,
        input,
        None,
        None,
        None,
        move |conn, event, _undo_id| {
            append_change_events_in_tx(conn, project_id, session_id, std::slice::from_ref(event))?;
            Ok(())
        },
    )
}

/// External callers must supply the Foreshadow aggregate version they observed.
pub fn tracked_foreshadow_update_at_version(
    conn: &Connection,
    input: TrackedForeshadowUpdateInput<'_>,
    base_version: i64,
) -> anyhow::Result<Option<WriteResult>> {
    anyhow::ensure!(
        base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    let project_id = input.project_id;
    let session_id = input.session_id;
    tracked_foreshadow_update_at_version_with_in_tx_hook(
        conn,
        input,
        base_version,
        move |conn, event, _undo_id| {
            append_change_events_in_tx(conn, project_id, session_id, std::slice::from_ref(event))?;
            Ok(())
        },
    )
}

/// Hooked OCC variant used by the database authority layer to atomically
/// extend the tracked write before its transaction commits.
pub fn tracked_foreshadow_update_at_version_with_in_tx_hook<F>(
    conn: &Connection,
    input: TrackedForeshadowUpdateInput<'_>,
    base_version: i64,
    append_change_in_tx: F,
) -> anyhow::Result<Option<WriteResult>>
where
    F: FnOnce(&Connection, &AppendChangeEvent, &str) -> anyhow::Result<()>,
{
    anyhow::ensure!(
        base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    tracked_foreshadow_update_impl(
        conn,
        input,
        Some(base_version),
        None,
        None,
        append_change_in_tx,
    )
}

pub fn tracked_foreshadow_update_at_version_with_request_in_tx_hook<F>(
    conn: &Connection,
    input: TrackedForeshadowUpdateInput<'_>,
    base_version: i64,
    request_id: &str,
    request_hash: &str,
    append_change_in_tx: F,
) -> anyhow::Result<Option<WriteResult>>
where
    F: FnOnce(&Connection, &AppendChangeEvent, &str) -> anyhow::Result<()>,
{
    anyhow::ensure!(
        base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    tracked_foreshadow_update_impl(
        conn,
        input,
        Some(base_version),
        Some(request_id),
        Some(request_hash),
        append_change_in_tx,
    )
}

fn tracked_foreshadow_update_impl<F>(
    conn: &Connection,
    input: TrackedForeshadowUpdateInput<'_>,
    caller_base_version: Option<i64>,
    request_id: Option<&str>,
    request_hash: Option<&str>,
    append_change_in_tx: F,
) -> anyhow::Result<Option<WriteResult>>
where
    F: FnOnce(&Connection, &AppendChangeEvent, &str) -> anyhow::Result<()>,
{
    let undo_id = request_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> anyhow::Result<Option<WriteResult>> {
        if let (Some(request_id), Some(request_hash)) = (request_id, request_hash) {
            if let Some(existing) =
                existing_update_request_result(conn, &input, request_id, request_hash)?
            {
                return Ok(Some(existing));
            }
        }
        // Snapshot doubles as the existence + project-scope check, taken
        // before mutation (codex update_before_snapshot discipline).
        let Some(before_snapshot) =
            foreshadow_snapshot(conn, input.project_id, input.foreshadow_id)?
        else {
            return Ok(None);
        };
        let before: serde_json::Value = serde_json::from_str(&before_snapshot)?;
        let base_version = before["version"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("foreshadow snapshot missing version before update"))?;
        if let Some(caller_base_version) = caller_base_version {
            anyhow::ensure!(
                caller_base_version == base_version,
                "FORESHADOW_VERSION_MISMATCH: expected version {caller_base_version}, found {base_version}"
            );
        }
        let expected_result_version = base_version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("foreshadow version overflow during tracked update"))?;

        let p = &input.patch;
        let mut fields: Vec<&str> = Vec::new();
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        use rusqlite::types::Value as V;
        if let Some(v) = p.title {
            fields.push("title");
            sets.push("title = ?");
            vals.push(V::Text(v.to_string()));
        }
        if let Some(v) = p.intent {
            fields.push("intent");
            sets.push("intent = ?");
            vals.push(V::Text(v.to_string()));
        }
        if let Some(v) = p.notes {
            fields.push("notes");
            sets.push("notes = ?");
            vals.push(V::Text(v.to_string()));
        }
        if let Some(v) = p.load_bearing {
            fields.push("loadBearing");
            sets.push("load_bearing = ?");
            vals.push(V::Text(v.to_string()));
        }
        if let Some(v) = p.payoff_confirmed {
            fields.push("payoffConfirmed");
            sets.push("payoff_confirmed = ?");
            vals.push(V::Integer(v as i64));
        }
        if let Some(v) = p.abandoned {
            fields.push("abandoned");
            sets.push("abandoned = ?");
            vals.push(V::Integer(v as i64));
        }
        if let Some(v) = p.secret {
            fields.push("secret");
            sets.push("secret = ?");
            vals.push(V::Integer(v as i64));
        }
        anyhow::ensure!(!sets.is_empty(), "empty patch (tool layer must guard)");

        sets.push("version = ?");
        vals.push(V::Integer(expected_result_version));
        sets.push("updated_at = ?");
        vals.push(V::Integer(now));
        vals.push(V::Text(input.foreshadow_id.to_string()));
        vals.push(V::Text(input.project_id.to_string()));
        vals.push(V::Integer(base_version));
        let sql = format!(
            "UPDATE foreshadows SET {} WHERE id = ? AND project_id = ? AND version = ?",
            sets.join(", ")
        );
        let affected = conn.execute(&sql, rusqlite::params_from_iter(vals.iter()))?;
        anyhow::ensure!(
            affected == 1,
            "foreshadow version conflict during tracked update"
        );

        let after_snapshot = foreshadow_snapshot(conn, input.project_id, input.foreshadow_id)?
            .ok_or_else(|| anyhow::anyhow!("foreshadow row missing right after update"))?;
        let after: serde_json::Value = serde_json::from_str(&after_snapshot)?;
        let result_version = after["version"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("foreshadow snapshot missing version after update"))?;
        anyhow::ensure!(
            result_version == expected_result_version,
            "foreshadow version did not advance exactly once"
        );

        insert_undo_journal_in_tx(
            conn,
            UndoJournalInsert {
                id: &undo_id,
                project_id: input.project_id,
                surface: input.surface,
                entity_kind: "foreshadow",
                entity_id: input.foreshadow_id,
                op_kind: "update",
                before_json: Some(&before_snapshot),
                after_json: Some(&after_snapshot),
                base_version,
                result_version,
                change_event_uid: Some(&event_uid),
            },
        )?;

        let mut change_payload = json!({ "fields": fields });
        if let Some(request_hash) = request_hash {
            change_payload["requestHash"] = serde_json::Value::String(request_hash.to_string());
        }
        let canonical_event = AppendChangeEvent {
            event_uid: event_uid.clone(),
            scene_id: None,
            domain: "foreshadow".to_string(),
            op_type: "foreshadow.update".to_string(),
            entity_type: Some("foreshadow".to_string()),
            entity_id: Some(input.foreshadow_id.to_string()),
            payload: change_payload.to_string(),
            timestamp: now,
        };
        append_change_in_tx(conn, &canonical_event, &undo_id)?;

        Ok(Some(WriteResult {
            entity_id: input.foreshadow_id.to_string(),
            version: result_version,
            change_event_uid: event_uid,
            undo_journal_id: undo_id,
        }))
    })();

    match result {
        Ok(res) => {
            crate::commit_or_rollback(conn)?;
            Ok(res)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
    .context("tracked_foreshadow_update")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::undo_journal::{apply_undo_journal_in_tx, revert_undo_journal_in_tx};

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE foreshadows (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
                mechanism TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                codex_link_dirty_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
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
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
                ON change_events(project_id, event_uid);",
        )
        .unwrap();
        conn.execute("INSERT INTO projects (id, title) VALUES ('p1', 'Test')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other')",
            [],
        )
        .unwrap();
        conn
    }

    fn create_input<'a>(id: &'a str, title: &'a str) -> TrackedForeshadowCreateInput<'a> {
        TrackedForeshadowCreateInput {
            project_id: "p1",
            session_id: "sess",
            surface: "test",
            foreshadow_id: id,
            title,
            intent: Some("the intent"),
            notes: None,
            load_bearing: Some("critical"),
            secret: false,
            request_id: None,
            request_hash: None,
        }
    }

    /// Insert a raw v12 row with a fixed past updated_at and version zero.
    fn seed_raw_row(conn: &Connection, id: &str, project_id: &str, title: &str, millis: i64) {
        conn.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, intent, secret, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'orig intent', 1, ?4, ?4)",
            params![id, project_id, title, millis],
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn row_updated_at(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT updated_at FROM foreshadows WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn row_version(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT version FROM foreshadows WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    // ---------------- create ----------------

    #[test]
    fn create_writes_row_undo_journal_and_change_event() {
        let conn = setup_conn();
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Planted clue")).unwrap();
        assert_eq!(res.entity_id, "f1");
        assert_eq!(res.version, 0);

        // Entity row with the exact raw-writer column behavior.
        let (title, intent, secret, payoff_confirmed, lb): (String, String, i64, i64, String) =
            conn.query_row(
                "SELECT title, intent, secret, payoff_confirmed, load_bearing
                 FROM foreshadows WHERE id = 'f1' AND project_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, "Planted clue");
        assert_eq!(intent, "the intent");
        assert_eq!(secret, 0);
        assert_eq!(payoff_confirmed, 0);
        assert_eq!(lb, "critical");

        // Change event: domain/op_type/entity/session.
        let (domain, op_type, entity_type, entity_id, session_id, payload): (
            String,
            String,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT domain, op_type, entity_type, entity_id, session_id, payload
                 FROM change_events",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(domain, "foreshadow");
        assert_eq!(op_type, "foreshadow.create");
        assert_eq!(entity_type, "foreshadow");
        assert_eq!(entity_id, "f1");
        assert_eq!(session_id, "sess");
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["title"], "Planted clue");

        // Undo journal: create op, before=None, after snapshot with the full
        // v12 root state, and actual root version tokens.
        let (entity_kind, op_kind, surface, before, after, base_v, result_v): (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT entity_kind, op_kind, surface, before_json, after_json,
                        base_version, result_version
                 FROM undo_journal",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(entity_kind, "foreshadow");
        assert_eq!(op_kind, "create");
        assert_eq!(surface, "test");
        assert!(before.is_none());
        let after: serde_json::Value = serde_json::from_str(&after.unwrap()).unwrap();
        assert_eq!(after["title"], "Planted clue");
        assert_eq!(after["secret"], 0);
        assert_eq!(after["version"], 0);
        assert!(after.get("mechanism").is_some());
        assert!(after.get("codexLinkDirtyAt").is_some());
        assert_eq!(base_v, 0);
        assert_eq!(result_v, 0);
        assert!(!res.undo_journal_id.is_empty());
        assert!(!res.change_event_uid.is_empty());
    }

    #[test]
    fn create_rolls_back_atomically_on_failure() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Existing", 1000);
        // Duplicate primary key → the whole tx must roll back: no journal row,
        // no change event, no half-written state.
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Dup"));
        assert!(res.is_err());
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Existing"
        );
    }

    #[test]
    fn create_hook_failure_rolls_back_domain_journal_and_canonical_event() {
        let conn = setup_conn();
        let error = tracked_foreshadow_create_with_in_tx_hook(
            &conn,
            create_input("f1", "Hooked"),
            |_conn, _event, _undo_id| anyhow::bail!("forced post-write hook failure"),
        )
        .expect_err("hook failure must abort the tracked transaction");
        assert!(format!("{error:#}").contains("forced post-write hook failure"));
        assert_eq!(count(&conn, "foreshadows"), 0);
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
    }

    // ---------------- update ----------------

    #[test]
    fn update_patches_only_provided_fields() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);

        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Renamed"),
                    load_bearing: Some("supporting"),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .expect("row exists in p1");
        assert_eq!(res.entity_id, "f1");
        assert_eq!(res.version, 1);

        let (title, intent, secret, lb): (String, String, i64, String) = conn
            .query_row(
                "SELECT title, intent, secret, load_bearing FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "Renamed");
        assert_eq!(intent, "orig intent", "untouched field must survive");
        assert_eq!(secret, 1, "untouched field must survive");
        assert_eq!(lb, "supporting");
        assert_eq!(row_version(&conn, "f1"), 1);

        // Change event payload lists the patched fields.
        let payload: String = conn
            .query_row(
                "SELECT payload FROM change_events WHERE op_type = 'foreshadow.update'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let fields: Vec<&str> = payload["fields"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(fields.contains(&"title"), "fields: {fields:?}");
        assert!(fields.contains(&"loadBearing"), "fields: {fields:?}");
        assert!(!fields.contains(&"secret"), "fields: {fields:?}");

        // Journal: before/after snapshots + actual root versions.
        let (op_kind, before, after, base_v, result_v): (
            String,
            Option<String>,
            Option<String>,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT op_kind, before_json, after_json, base_version, result_version
                 FROM undo_journal",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(op_kind, "update");
        let before: serde_json::Value = serde_json::from_str(&before.unwrap()).unwrap();
        let after: serde_json::Value = serde_json::from_str(&after.unwrap()).unwrap();
        assert_eq!(before["title"], "Original");
        assert_eq!(after["title"], "Renamed");
        assert_eq!(before["version"], 0);
        assert_eq!(after["version"], 1);
        assert_eq!(base_v, 0);
        assert_eq!(result_v, 1);
    }

    #[test]
    fn update_not_found_returns_none_and_writes_nothing() {
        let conn = setup_conn();
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "ghost",
                patch: ForeshadowPatch {
                    title: Some("X"),
                    ..Default::default()
                },
            },
        )
        .unwrap();
        assert!(res.is_none());
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
    }

    #[test]
    fn update_cross_project_returns_none_and_leaves_row() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p2", "Owned by p2", 1000);
        // XPROJ: scoped to p1, a p2 row must look missing and stay untouched.
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("hijacked"),
                    ..Default::default()
                },
            },
        )
        .unwrap();
        assert!(res.is_none());
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Owned by p2"
        );
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
    }

    #[test]
    fn empty_update_rolls_back_without_advancing_version() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);

        let result = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch::default(),
            },
        );

        assert!(result.is_err());
        assert_eq!(row_version(&conn, "f1"), 0);
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
    }

    // ---------------- undo / redo ----------------

    #[test]
    fn undo_redo_roundtrip_for_create() {
        let conn = setup_conn();
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Plant")).unwrap();
        assert_eq!(row_version(&conn, "f1"), 0);

        revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        assert_eq!(count(&conn, "foreshadows"), 0, "undo create = delete");

        apply_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        let (title, secret, lb, version): (String, i64, String, i64) = conn
            .query_row(
                "SELECT title, secret, load_bearing, version FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "Plant");
        assert_eq!(secret, 0);
        assert_eq!(lb, "critical");
        assert_eq!(version, 1, "redo create must allocate a fresh version");

        let journal_result: i64 = conn
            .query_row(
                "SELECT result_version FROM undo_journal WHERE id = ?1",
                params![res.undo_journal_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(journal_result, 1);
        revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        assert_eq!(count(&conn, "foreshadows"), 0);
    }

    #[test]
    fn undo_create_conflicts_when_row_modified_after() {
        let conn = setup_conn();
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Plant")).unwrap();
        // External root edit advances version; undo must refuse to delete
        // instead of silently destroying the edit.
        conn.execute(
            "UPDATE foreshadows
             SET title = 'edited later', version = version + 1, updated_at = updated_at + 5000
             WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let result = revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id);
        assert!(result.is_err(), "conflict must bail, not clobber");
        assert_eq!(count(&conn, "foreshadows"), 1, "row must survive");
    }

    #[test]
    fn undo_redo_roundtrip_for_update() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Renamed"),
                    abandoned: Some(true),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(row_version(&conn, "f1"), 1);

        revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        let (title, abandoned): (String, i64) = conn
            .query_row(
                "SELECT title, abandoned FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Original");
        assert_eq!(abandoned, 0);
        assert_eq!(row_version(&conn, "f1"), 2);
        let stale_changed = conn
            .execute(
                "UPDATE foreshadows SET title = 'stale' WHERE id = 'f1' AND version = 1",
                [],
            )
            .unwrap();
        assert_eq!(stale_changed, 0, "pre-undo editor token must stay stale");

        apply_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        let (title, abandoned): (String, i64) = conn
            .query_row(
                "SELECT title, abandoned FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Renamed");
        assert_eq!(abandoned, 1);
        assert_eq!(row_version(&conn, "f1"), 3);

        let (base_version, result_version): (i64, i64) = conn
            .query_row(
                "SELECT base_version, result_version FROM undo_journal WHERE id = ?1",
                params![res.undo_journal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((base_version, result_version), (2, 3));
    }

    #[test]
    fn undo_update_conflicts_when_row_modified_after() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Renamed"),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .unwrap();
        conn.execute(
            "UPDATE foreshadows
             SET title = 'edited later', version = version + 1, updated_at = updated_at + 5000
             WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let result = revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id);
        assert!(result.is_err(), "conflict must bail, not clobber");
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "edited later"
        );
    }

    #[test]
    fn stacked_update_undo_redo_keeps_versions_monotonic_and_chain_connected() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);
        let first = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("First"),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .unwrap();
        let second = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Second"),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(row_version(&conn, "f1"), 2);

        revert_undo_journal_in_tx(&conn, "p1", &second.undo_journal_id).unwrap();
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "First"
        );
        assert_eq!(row_version(&conn, "f1"), 3);

        revert_undo_journal_in_tx(&conn, "p1", &first.undo_journal_id).unwrap();
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Original"
        );
        assert_eq!(row_version(&conn, "f1"), 4);

        apply_undo_journal_in_tx(&conn, "p1", &first.undo_journal_id).unwrap();
        assert_eq!(row_version(&conn, "f1"), 5);
        apply_undo_journal_in_tx(&conn, "p1", &second.undo_journal_id).unwrap();
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Second"
        );
        assert_eq!(row_version(&conn, "f1"), 6);

        let first_tokens: (i64, i64) = conn
            .query_row(
                "SELECT base_version, result_version FROM undo_journal WHERE id = ?1",
                params![first.undo_journal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let second_tokens: (i64, i64) = conn
            .query_row(
                "SELECT base_version, result_version FROM undo_journal WHERE id = ?1",
                params![second.undo_journal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(first_tokens, (4, 5));
        assert_eq!(second_tokens, (5, 6));
    }

    #[test]
    fn versioned_replay_restores_mechanism_and_codex_dirty_exactly() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Before", 1000);
        conn.execute(
            "UPDATE foreshadows
             SET mechanism = 'misdirection', codex_link_dirty_at = 11,
                 title = 'After', version = 1, updated_at = 2000
             WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let before = serde_json::json!({
            "id": "f1", "projectId": "p1", "title": "Before",
            "intent": "orig intent", "notes": null,
            "payoffSceneId": null, "payoffFromPos": null, "payoffToPos": null,
            "payoffConfirmed": 0, "abandoned": 0, "secret": 1,
            "loadBearing": null, "mechanism": "setup-payoff", "version": 0,
            "codexLinkDirtyAt": 7, "createdAt": 1000, "updatedAt": 1000
        })
        .to_string();
        let after = serde_json::json!({
            "id": "f1", "projectId": "p1", "title": "After",
            "intent": "orig intent", "notes": null,
            "payoffSceneId": null, "payoffFromPos": null, "payoffToPos": null,
            "payoffConfirmed": 0, "abandoned": 0, "secret": 1,
            "loadBearing": null, "mechanism": "misdirection", "version": 1,
            "codexLinkDirtyAt": 11, "createdAt": 1000, "updatedAt": 2000
        })
        .to_string();
        insert_undo_journal_in_tx(
            &conn,
            UndoJournalInsert {
                id: "full-root-journal",
                project_id: "p1",
                surface: "test",
                entity_kind: "foreshadow",
                entity_id: "f1",
                op_kind: "update",
                before_json: Some(&before),
                after_json: Some(&after),
                base_version: 0,
                result_version: 1,
                change_event_uid: None,
            },
        )
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", "full-root-journal").unwrap();
        let undone: (String, String, i64, i64) = conn
            .query_row(
                "SELECT title, mechanism, codex_link_dirty_at, version
                 FROM foreshadows WHERE id = 'f1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(undone, ("Before".into(), "setup-payoff".into(), 7, 2));

        apply_undo_journal_in_tx(&conn, "p1", "full-root-journal").unwrap();
        let redone: (String, String, i64, i64) = conn
            .query_row(
                "SELECT title, mechanism, codex_link_dirty_at, version
                 FROM foreshadows WHERE id = 'f1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(redone, ("After".into(), "misdirection".into(), 11, 3));
    }

    #[test]
    fn pre_v12_journal_replays_with_legacy_updated_at_guard() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Before", 1000);
        conn.execute(
            "UPDATE foreshadows SET title = 'After', updated_at = 2000 WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let before = serde_json::json!({
            "id": "f1", "projectId": "p1", "title": "Before",
            "intent": "orig intent", "notes": null,
            "payoffSceneId": null, "payoffFromPos": null, "payoffToPos": null,
            "payoffConfirmed": 0, "abandoned": 0, "secret": 1,
            "loadBearing": null, "createdAt": 1000, "updatedAt": 1000
        })
        .to_string();
        let after = serde_json::json!({
            "id": "f1", "projectId": "p1", "title": "After",
            "intent": "orig intent", "notes": null,
            "payoffSceneId": null, "payoffFromPos": null, "payoffToPos": null,
            "payoffConfirmed": 0, "abandoned": 0, "secret": 1,
            "loadBearing": null, "createdAt": 1000, "updatedAt": 2000
        })
        .to_string();
        insert_undo_journal_in_tx(
            &conn,
            UndoJournalInsert {
                id: "legacy-journal",
                project_id: "p1",
                surface: "test",
                entity_kind: "foreshadow",
                entity_id: "f1",
                op_kind: "update",
                before_json: Some(&before),
                after_json: Some(&after),
                base_version: 1000,
                result_version: 2000,
                change_event_uid: None,
            },
        )
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", "legacy-journal").unwrap();
        assert_eq!(row_updated_at(&conn, "f1"), 1000);
        assert_eq!(row_version(&conn, "f1"), 0);
        apply_undo_journal_in_tx(&conn, "p1", "legacy-journal").unwrap();
        assert_eq!(row_updated_at(&conn, "f1"), 2000);
        assert_eq!(row_version(&conn, "f1"), 0);
    }
}
