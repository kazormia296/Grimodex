//! Typed Native writers for the chat writes that stay open under a
//! restricted D2a profile (NIR-1 DA-2b CW, K3/2 "chat の書込みの入口" rows
//! 4-8 and the CW conditions 1-5; DR-DA2-50).
//!
//! * Message deletion, session deletion, the project's history clear, the
//!   manual rename and the extraction / insertion record. Nothing here inserts
//!   a row (RW-1).
//! * The surviving rows keep their id, session_id, role, content, created_at
//!   and `metadata.thinking_blocks`; sessions keep node_id, anchors and model.
//! * A deletion that would remove a session with an unterminated generation
//!   attempt (`nir1_generation_attempts.terminal_json IS NULL`) removes
//!   nothing and is refused (`generation-pending`), checked in the same
//!   IMMEDIATE transaction as the delete.
//! * Child rows and the NIR rows follow the existing foreign keys and the
//!   canonical triggers; this module never writes the capture or version
//!   tables itself and never writes `change_events`.
//!
//! The renderer passes only ids, the title and the three record values, and
//! receives counts. The Electron Native entry checks the caller identity and
//! the workspace before calling in here.

use std::collections::BTreeSet;
use std::fmt;

use anyhow::Result;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Database;

/// Stable prefix of every typed CW refusal (`CHAT_WRITE_REFUSED:<reason>`).
pub const CHAT_WRITE_REFUSED: &str = "CHAT_WRITE_REFUSED";

/// Upper bounds of the typed requests (Main re-validates the same values).
pub const MAX_ID_CHARS: usize = 256;
pub const MAX_MESSAGE_IDS: usize = 256;
pub const MAX_TITLE_CHARS: usize = 4096;
pub const MAX_RECORD_IDS: usize = 64;

/// The only metadata keys the record writer may set (K3/2 CW condition 2).
pub const RECORD_METADATA_KEYS: [&str; 3] =
    ["extractedCodex", "extractedSnippets", "insertedToEditor"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatWriteRefusal {
    InvalidRequest,
    WorkspaceMismatch,
    ScopeMismatch,
    GenerationPending,
    MetadataKeyNotAllowed,
    MetadataUnreadable,
}

impl ChatWriteRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::WorkspaceMismatch => "workspace-mismatch",
            Self::ScopeMismatch => "scope-mismatch",
            Self::GenerationPending => "generation-pending",
            Self::MetadataKeyNotAllowed => "metadata-key-not-allowed",
            Self::MetadataUnreadable => "metadata-unreadable",
        }
    }
}

impl fmt::Display for ChatWriteRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{CHAT_WRITE_REFUSED}:{}", self.code())
    }
}

impl std::error::Error for ChatWriteRefusal {}

/// The typed refusal carried by `error`, if any.
pub fn refusal_of(error: &anyhow::Error) -> Option<ChatWriteRefusal> {
    error.downcast_ref::<ChatWriteRefusal>().copied()
}

fn refuse<T>(refusal: ChatWriteRefusal) -> Result<T> {
    Err(anyhow::Error::new(refusal))
}

fn require_id(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > MAX_ID_CHARS {
        return refuse(ChatWriteRefusal::InvalidRequest);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteMessagesRequest {
    pub project_id: String,
    pub session_id: String,
    pub message_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSessionRequest {
    pub project_id: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearProjectHistoryRequest {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameSessionRequest {
    pub project_id: String,
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordMessageMetadataRequest {
    pub project_id: String,
    pub message_id: String,
    /// Checked key by key so an unknown key is a typed refusal, not a
    /// generic decode failure.
    pub patch: Map<String, Value>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct DeletedCount {
    pub deleted: usize,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedSessions {
    pub deleted_sessions: usize,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct UpdatedCount {
    pub updated: usize,
}

fn with_immediate_transaction<T>(
    db: &Database,
    operation: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        match operation(conn) {
            Ok(value) => match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(value),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error.into())
                }
            },
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

/// The project of a session, or `None` when the session does not exist.
fn session_project(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT project_id FROM chat_sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn session_has_pending_attempt(conn: &Connection, session_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM nir1_generation_attempts
             WHERE session_id = ?1 AND terminal_json IS NULL
         )",
        params![session_id],
        |row| row.get::<_, bool>(0),
    )?)
}

fn project_has_pending_attempt(conn: &Connection, project_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM nir1_generation_attempts
             WHERE terminal_json IS NULL
               AND session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?1)
         )",
        params![project_id],
        |row| row.get::<_, bool>(0),
    )?)
}

/// Delete the named messages of one session (K3/2 row 4). Ids absent from
/// the database are not counted, as with the current generic DELETE; an id
/// of another session, or a session of another project, deletes nothing.
pub fn delete_messages(db: &Database, request: DeleteMessagesRequest) -> Result<DeletedCount> {
    require_id(&request.project_id)?;
    require_id(&request.session_id)?;
    if request.message_ids.is_empty() || request.message_ids.len() > MAX_MESSAGE_IDS {
        return refuse(ChatWriteRefusal::InvalidRequest);
    }
    for id in &request.message_ids {
        require_id(id)?;
    }
    let ids: BTreeSet<&str> = request.message_ids.iter().map(String::as_str).collect();
    with_immediate_transaction(db, |conn| {
        let session_project = session_project(conn, &request.session_id)?;
        if session_project
            .as_deref()
            .is_some_and(|project| project != request.project_id)
        {
            return refuse(ChatWriteRefusal::ScopeMismatch);
        }
        let mut present = Vec::with_capacity(ids.len());
        for id in &ids {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT session_id FROM chat_messages WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            match owner {
                None => {}
                Some(owner) if owner == request.session_id && session_project.is_some() => {
                    present.push(*id);
                }
                Some(_) => return refuse(ChatWriteRefusal::ScopeMismatch),
            }
        }
        if session_project.is_some() && session_has_pending_attempt(conn, &request.session_id)? {
            return refuse(ChatWriteRefusal::GenerationPending);
        }
        let mut deleted = 0;
        for id in present {
            deleted += conn.execute(
                "DELETE FROM chat_messages WHERE id = ?1 AND session_id = ?2",
                params![id, request.session_id],
            )?;
        }
        Ok(DeletedCount { deleted })
    })
}

/// Delete one session; its child rows follow the foreign keys (K3/2 row 5).
pub fn delete_session(db: &Database, request: DeleteSessionRequest) -> Result<DeletedCount> {
    require_id(&request.project_id)?;
    require_id(&request.session_id)?;
    with_immediate_transaction(db, |conn| {
        match session_project(conn, &request.session_id)? {
            None => return Ok(DeletedCount { deleted: 0 }),
            Some(project) if project != request.project_id => {
                return refuse(ChatWriteRefusal::ScopeMismatch)
            }
            Some(_) => {}
        }
        if session_has_pending_attempt(conn, &request.session_id)? {
            return refuse(ChatWriteRefusal::GenerationPending);
        }
        let deleted = conn.execute(
            "DELETE FROM chat_sessions WHERE id = ?1 AND project_id = ?2",
            params![request.session_id, request.project_id],
        )?;
        Ok(DeletedCount { deleted })
    })
}

/// Delete every session of a project in one statement (K3/2 row 6).
pub fn clear_project_history(
    db: &Database,
    request: ClearProjectHistoryRequest,
) -> Result<ClearedSessions> {
    require_id(&request.project_id)?;
    with_immediate_transaction(db, |conn| {
        if project_has_pending_attempt(conn, &request.project_id)? {
            return refuse(ChatWriteRefusal::GenerationPending);
        }
        let deleted_sessions = conn.execute(
            "DELETE FROM chat_sessions WHERE project_id = ?1",
            params![request.project_id],
        )?;
        Ok(ClearedSessions { deleted_sessions })
    })
}

/// The `Date.prototype.toISOString()` shape the renderer wrote before.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The manual rename: title, title_manual = 1 and updated_at only (row 7).
pub fn rename_session(db: &Database, request: RenameSessionRequest) -> Result<UpdatedCount> {
    require_id(&request.project_id)?;
    require_id(&request.session_id)?;
    if request.title.chars().count() > MAX_TITLE_CHARS {
        return refuse(ChatWriteRefusal::InvalidRequest);
    }
    with_immediate_transaction(db, |conn| {
        match session_project(conn, &request.session_id)? {
            None => return Ok(UpdatedCount { updated: 0 }),
            Some(project) if project != request.project_id => {
                return refuse(ChatWriteRefusal::ScopeMismatch)
            }
            Some(_) => {}
        }
        let updated = conn.execute(
            "UPDATE chat_sessions
                SET title = ?1, title_manual = 1, updated_at = ?2
              WHERE id = ?3 AND project_id = ?4",
            params![
                request.title,
                now_iso(),
                request.session_id,
                request.project_id
            ],
        )?;
        Ok(UpdatedCount { updated })
    })
}

fn record_value_json(key: &str, value: &Value) -> Result<String> {
    match key {
        "extractedCodex" | "extractedSnippets" => {
            let Some(items) = value.as_array() else {
                return refuse(ChatWriteRefusal::InvalidRequest);
            };
            if items.len() > MAX_RECORD_IDS {
                return refuse(ChatWriteRefusal::InvalidRequest);
            }
            for item in items {
                match item.as_str() {
                    Some(id) => require_id(id)?,
                    None => return refuse(ChatWriteRefusal::InvalidRequest),
                }
            }
            Ok(serde_json::to_string(value)?)
        }
        "insertedToEditor" => match value {
            Value::Bool(flag) => Ok(flag.to_string()),
            _ => refuse(ChatWriteRefusal::InvalidRequest),
        },
        _ => refuse(ChatWriteRefusal::MetadataKeyNotAllowed),
    }
}

/// Merge the extraction / insertion record into a message's metadata (row 8).
/// Only the three record keys are written; every other key keeps its value
/// and position (SQLite `json_set`, the same result as the renderer's
/// `{ ...existing, ...update }`). A missing message updates nothing.
pub fn record_message_metadata(
    db: &Database,
    request: RecordMessageMetadataRequest,
) -> Result<UpdatedCount> {
    require_id(&request.project_id)?;
    require_id(&request.message_id)?;
    if request.patch.is_empty() {
        return refuse(ChatWriteRefusal::InvalidRequest);
    }
    if request
        .patch
        .keys()
        .any(|key| !RECORD_METADATA_KEYS.contains(&key.as_str()))
    {
        return refuse(ChatWriteRefusal::MetadataKeyNotAllowed);
    }
    let mut assignments = Vec::with_capacity(request.patch.len());
    for (key, value) in &request.patch {
        assignments.push((format!("$.{key}"), record_value_json(key, value)?));
    }
    with_immediate_transaction(db, |conn| {
        let row: Option<(Option<String>, String)> = conn
            .query_row(
                "SELECT message.metadata, session.project_id
                   FROM chat_messages message
                   JOIN chat_sessions session ON session.id = message.session_id
                  WHERE message.id = ?1",
                params![request.message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((metadata, project)) = row else {
            return Ok(UpdatedCount { updated: 0 });
        };
        if project != request.project_id {
            return refuse(ChatWriteRefusal::ScopeMismatch);
        }
        let base = match metadata.as_deref() {
            None | Some("") => "{}".to_string(),
            Some(text) => {
                let is_object: bool = conn.query_row(
                    "SELECT json_valid(?1) AND json_type(?1) = 'object'",
                    params![text],
                    |row| row.get(0),
                )?;
                if !is_object {
                    return refuse(ChatWriteRefusal::MetadataUnreadable);
                }
                text.to_string()
            }
        };
        let mut sql = String::from("UPDATE chat_messages SET metadata = json_set(?1");
        let mut values: Vec<String> = vec![base];
        for (path, value) in assignments {
            values.push(path);
            sql.push_str(&format!(", ?{}", values.len()));
            values.push(value);
            sql.push_str(&format!(", json(?{})", values.len()));
        }
        values.push(request.message_id.clone());
        sql.push_str(&format!(") WHERE id = ?{}", values.len()));
        let updated = conn.execute(&sql, params_from_iter(values.iter()))?;
        Ok(UpdatedCount { updated })
    })
}
