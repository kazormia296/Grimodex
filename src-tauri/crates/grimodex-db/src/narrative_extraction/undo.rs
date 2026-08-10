//! Atomic undo / redo for narrative apply commits.

use chrono::Utc;
use rusqlite::params;
use serde_json::{json, Value};
use uuid::Uuid;

use super::commit::{load_commit_by_id, load_commit_by_request, CommitRow};
use super::models::UndoCommitPayload;
use super::task_leases::with_immediate_transaction;
use crate::agent_writes::{apply_event_snapshot, collect_event_snapshot, delete_event_cascade};
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::Database;

const STATUS_APPLIED: &str = "applied";
const STATUS_UNDONE: &str = "undone";
const STATUS_REDONE: &str = "redone";

pub fn narrative_extraction_undo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    mutate_commit(db, &payload, UndoDirection::Undo)
}

pub fn narrative_extraction_redo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    mutate_commit(db, &payload, UndoDirection::Redo)
}

#[derive(Clone, Copy)]
enum UndoDirection {
    Undo,
    Redo,
}

fn mutate_commit(
    db: &Database,
    payload: &UndoCommitPayload,
    direction: UndoDirection,
) -> anyhow::Result<Value> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let timestamp = Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            let commit = resolve_commit(conn, payload)?;
            let journal_after = load_journal_after(conn, &commit.commit_id)?;
            let entities = journal_entities(&journal_after)?;

            match direction {
                UndoDirection::Undo => {
                    anyhow::ensure!(
                        commit.status == STATUS_APPLIED || commit.status == STATUS_REDONE,
                        "NEX_COMMIT_NOT_UNDOABLE: status is '{}'",
                        commit.status
                    );
                    // Refuse if any event diverged from the commit-time snapshot.
                    for entity in &entities {
                        let entity_id = entity_id(entity)?;
                        let expected = entity
                            .get("snapshot")
                            .cloned()
                            .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
                        let current = collect_event_snapshot(conn, entity_id)?;
                        if normalize_snapshot_for_compare(&current)
                            != normalize_snapshot_for_compare(&expected)
                        {
                            anyhow::bail!(
                                "NEX_COMMIT_EVENT_EDITED: event '{entity_id}' was modified after commit"
                            );
                        }
                    }

                    for entity in entities.iter().rev() {
                        let entity_id = entity_id(entity)?;
                        let version = entity
                            .get("version")
                            .and_then(Value::as_i64)
                            .unwrap_or(1);
                        // Current version may have advanced only via redo; use live version.
                        let live_version: i64 = conn.query_row(
                            "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                            params![entity_id, payload.project_id],
                            |row| row.get(0),
                        )?;
                        delete_event_cascade(
                            conn,
                            &payload.project_id,
                            entity_id,
                            Some(live_version),
                        )?;
                        let _ = version;
                    }

                    let change_uid = Uuid::new_v4().to_string();
                    append_change_events_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.session_id,
                        &[AppendChangeEvent {
                            event_uid: change_uid.clone(),
                            scene_id: None,
                            domain: "narrative".to_string(),
                            op_type: "narrative.commit.undo".to_string(),
                            entity_type: Some("narrative_apply_commit".to_string()),
                            entity_id: Some(commit.commit_id.clone()),
                            payload: json!({
                                "commitId": commit.commit_id,
                                "requestId": commit.request_id,
                            })
                            .to_string(),
                            timestamp,
                        }],
                    )?;

                    let receipt = update_receipt_status(
                        conn,
                        &commit,
                        STATUS_UNDONE,
                        &now,
                        Some(&change_uid),
                    )?;
                    Ok(receipt)
                }
                UndoDirection::Redo => {
                    anyhow::ensure!(
                        commit.status == STATUS_UNDONE,
                        "NEX_COMMIT_NOT_REDOABLE: status is '{}'",
                        commit.status
                    );

                    let mut restored = Vec::new();
                    for entity in &entities {
                        let entity_id = entity_id(entity)?;
                        let snapshot = entity
                            .get("snapshot")
                            .cloned()
                            .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
                        let previous_version = entity
                            .get("version")
                            .and_then(Value::as_i64)
                            .unwrap_or(1);
                        // Do not reuse the original version generation.
                        let replay_version = previous_version
                            .checked_add(1)
                            .ok_or_else(|| anyhow::anyhow!("event version overflow during redo"))?;
                        apply_event_snapshot(
                            conn,
                            &payload.project_id,
                            &snapshot,
                            Some(replay_version),
                            true,
                        )?;
                        restored.push(json!({
                            "entityKind": "event",
                            "entityId": entity_id,
                            "version": replay_version,
                        }));
                    }

                    let change_uid = Uuid::new_v4().to_string();
                    append_change_events_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.session_id,
                        &[AppendChangeEvent {
                            event_uid: change_uid.clone(),
                            scene_id: None,
                            domain: "narrative".to_string(),
                            op_type: "narrative.commit.redo".to_string(),
                            entity_type: Some("narrative_apply_commit".to_string()),
                            entity_id: Some(commit.commit_id.clone()),
                            payload: json!({
                                "commitId": commit.commit_id,
                                "requestId": commit.request_id,
                                "restored": restored,
                            })
                            .to_string(),
                            timestamp,
                        }],
                    )?;

                    let receipt =
                        update_receipt_status(conn, &commit, STATUS_REDONE, &now, Some(&change_uid))?;
                    Ok(receipt)
                }
            }
        })
    })
}

fn resolve_commit(
    conn: &rusqlite::Connection,
    payload: &UndoCommitPayload,
) -> anyhow::Result<CommitRow> {
    let row = if let Some(commit_id) = payload.commit_id.as_deref() {
        load_commit_by_id(conn, &payload.project_id, commit_id)?
    } else if let Some(request_id) = payload.request_id.as_deref() {
        load_commit_by_request(conn, &payload.project_id, request_id)?
    } else {
        anyhow::bail!("commitId or requestId is required");
    };
    row.ok_or_else(|| anyhow::anyhow!("narrative apply commit not found"))
}

fn load_journal_after(
    conn: &rusqlite::Connection,
    commit_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT after_json FROM narrative_commit_journals
          WHERE commit_id = ?1
          ORDER BY created_at DESC
          LIMIT 1",
        params![commit_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

fn journal_entities(after: &Value) -> anyhow::Result<Vec<Value>> {
    after
        .get("entities")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("commit journal missing entities"))
}

fn entity_id(entity: &Value) -> anyhow::Result<&str> {
    entity
        .get("entityId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("journal entity missing entityId"))
}

fn normalize_snapshot_for_compare(value: &Value) -> Value {
    // Ignore updatedAt / createdAt drift if any writer touched timestamps without semantic edits.
    // Human edits still change title/note/detail/participants/links/version.
    let mut cloned = value.clone();
    if let Some(event_data) = cloned.get_mut("eventData").and_then(Value::as_object_mut) {
        event_data.remove("updatedAt");
        event_data.remove("createdAt");
    }
    cloned
}

fn update_receipt_status(
    conn: &rusqlite::Connection,
    commit: &CommitRow,
    status: &str,
    now: &str,
    change_event_uid: Option<&str>,
) -> anyhow::Result<Value> {
    let mut receipt = if let Some(raw) = commit.receipt_json.as_deref() {
        serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert("commitId".to_string(), Value::String(commit.commit_id.clone()));
        obj.insert("requestId".to_string(), Value::String(commit.request_id.clone()));
        obj.insert("planDigest".to_string(), Value::String(commit.plan_digest.clone()));
        obj.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(uid) = change_event_uid {
            obj.insert("changeEventUid".to_string(), Value::String(uid.to_string()));
        }
    }

    conn.execute(
        "UPDATE narrative_apply_commits
            SET status = ?1,
                receipt_json = ?2,
                completed_at = ?3,
                version = version + 1
          WHERE id = ?4",
        params![status, receipt.to_string(), now, commit.commit_id],
    )?;
    Ok(receipt)
}
