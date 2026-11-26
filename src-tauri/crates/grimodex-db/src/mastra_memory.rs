//! Typed persistence for Mastra memory. The five tables stay closed to generic
//! SQL; all access in this module is scoped and validated here.

use std::fmt;

use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::chat_typed_writes::{self, DeleteMessagesByIdsRequest, DeleteSessionRequest};
use crate::Database;

const NIR1_LOCAL_PREFIX: &str = "nir1-local-";
const MAX_ID_CHARS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryRefusal {
    InvalidRequest,
    ScopeMismatch,
    GenerationPending,
    NotFound,
    Unsupported,
}

impl MemoryRefusal {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::ScopeMismatch => "scope-mismatch",
            Self::GenerationPending => "generation-pending",
            Self::NotFound => "not-found",
            Self::Unsupported => "unsupported-operation",
        }
    }
}

impl fmt::Display for MemoryRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CHAT_WRITE_REFUSED:{}", self.code())
    }
}

impl std::error::Error for MemoryRefusal {}

fn refuse<T>(reason: MemoryRefusal) -> Result<T> {
    Err(anyhow::Error::new(reason))
}

fn require_id(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > MAX_ID_CHARS {
        return refuse(MemoryRefusal::InvalidRequest);
    }
    Ok(())
}

fn require_public_session(value: &str) -> Result<()> {
    require_id(value)?;
    if value.starts_with(NIR1_LOCAL_PREFIX) {
        return refuse(MemoryRefusal::ScopeMismatch);
    }
    Ok(())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalized_time(value: &str) -> Result<String> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.to_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
        .map_err(|_| anyhow::Error::new(MemoryRefusal::InvalidRequest))
}

fn parsed_time(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|date| date.and_utc().timestamp_millis())
        })
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

fn json_object(value: &Value) -> Result<String> {
    if !value.is_object() {
        return refuse(MemoryRefusal::InvalidRequest);
    }
    Ok(serde_json::to_string(value)?)
}

fn deserialize_optional_patch<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn resource_project(conn: &Connection, resource_id: &str) -> Result<String> {
    require_id(resource_id)?;
    conn.query_row(
        "SELECT project_id FROM mastra_resources WHERE id = ?1",
        params![resource_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| anyhow::Error::new(MemoryRefusal::ScopeMismatch))
}

fn session_project(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    require_public_session(session_id)?;
    Ok(conn
        .query_row(
            "SELECT project_id FROM chat_sessions WHERE id = ?1 AND id NOT LIKE 'nir1-local-%'",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?)
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadSortField {
    CreatedAt,
    UpdatedAt,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageSortField {
    CreatedAt,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortOrder<F> {
    pub field: Option<F>,
    pub direction: Option<SortDirection>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(untagged)]
pub enum PageLimit {
    Count(usize),
    Unlimited(bool),
}

impl PageLimit {
    fn resolve(self, default: usize) -> Result<Option<usize>> {
        match self {
            Self::Count(value) => Ok(Some(value)),
            Self::Unlimited(false) => Ok(None),
            Self::Unlimited(true) => refuse(MemoryRefusal::InvalidRequest),
        }
        .or_else(|error| {
            if matches!(
                error.downcast_ref::<MemoryRefusal>(),
                Some(MemoryRefusal::NotFound)
            ) {
                Ok(Some(default))
            } else {
                Err(error)
            }
        })
    }
}

fn page_window(page: usize, limit: Option<usize>) -> Result<(usize, usize)> {
    let limit = limit.unwrap_or(usize::MAX);
    let offset = page
        .checked_mul(limit)
        .ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
    Ok((offset, limit))
}

fn pagination(page: usize, limit: Option<usize>, total: usize) -> Value {
    let end = limit.map_or(total, |limit| page.saturating_add(1).saturating_mul(limit));
    json!({
        "total": total,
        "page": page,
        "perPage": limit.map_or(Value::Bool(false), |value| json!(value)),
        "hasMore": end < total,
    })
}

fn db_bool(value: bool) -> i64 {
    i64::from(value)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadReadCommand {
    Get {
        thread_id: String,
        resource_id: Option<String>,
    },
    List {
        resource_id: String,
        page: Option<usize>,
        per_page: Option<PageLimit>,
        order_by: Option<SortOrder<ThreadSortField>>,
        metadata: Option<Map<String, Value>>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadWriteCommand {
    Save {
        thread: ThreadInput,
    },
    Update {
        id: String,
        title: Option<String>,
        metadata: Option<Value>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadInput {
    pub id: String,
    pub resource_id: String,
    pub title: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadDeleteRequest {
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum MessageReadCommand {
    List {
        thread_id: IdList,
        resource_id: Option<String>,
        page: Option<usize>,
        per_page: Option<PageLimit>,
        order_by: Option<SortOrder<MessageSortField>>,
        date_range: Option<DateRange>,
        metadata: Option<Map<String, Value>>,
    },
    ById {
        message_ids: Vec<String>,
    },
    ByResource {
        resource_id: String,
        page: Option<usize>,
        per_page: Option<PageLimit>,
        order_by: Option<SortOrder<MessageSortField>>,
        date_range: Option<DateRange>,
        metadata: Option<Map<String, Value>>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum IdList {
    One(String),
    Many(Vec<String>),
}

impl IdList {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DateRange {
    pub start: Option<String>,
    pub end: Option<String>,
    pub start_exclusive: Option<bool>,
    pub end_exclusive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum MessageWriteCommand {
    Save { messages: Vec<MemoryMessageInput> },
    Update { messages: Vec<MemoryMessagePatch> },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryMessageInput {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub created_at: String,
    pub content: Value,
    #[serde(default)]
    pub is_injected: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryMessagePatch {
    pub id: String,
    pub content: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDeleteRequest {
    pub message_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMessage {
    pub id: String,
    pub thread_id: String,
    pub resource_id: Option<String>,
    pub role: String,
    pub created_at: String,
    pub content: Value,
}

fn scalar_equal(left: &Value, right: &Value) -> bool {
    left == right
}

fn thread_row(conn: &Connection, thread_id: &str) -> Result<Option<Value>> {
    require_public_session(thread_id)?;
    let row = conn
        .query_row(
            "SELECT s.id, s.project_id, s.title, s.title_manual, s.created_at, s.updated_at,
                    r.id, tm.metadata_json
               FROM chat_sessions s
               LEFT JOIN mastra_resources r ON r.project_id = s.project_id
               LEFT JOIN mastra_thread_metadata tm ON tm.session_id = s.id
              WHERE s.id = ?1 AND s.id NOT LIKE 'nir1-local-%'",
            params![thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(
        |(id, project_id, title, title_manual, created_at, updated_at, resource_id, raw_meta)| {
            let mut metadata = raw_meta
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .unwrap_or_else(|| json!({}));
            if title_manual {
                if let Some(object) = metadata.as_object_mut() {
                    object.insert("titlePinned".into(), Value::Bool(true));
                }
            }
            json!({
                "id": id,
                "projectId": project_id,
                "resourceId": resource_id,
                "title": title,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "metadata": metadata,
            })
        },
    ))
}

pub fn thread_read(db: &Database, request: ThreadReadCommand) -> Result<Value> {
    db.with_conn(|conn| match request {
        ThreadReadCommand::Get {
            thread_id,
            resource_id,
        } => {
            let Some(mut thread) = thread_row(conn, &thread_id)? else {
                return Ok(Value::Null);
            };
            if let Some(expected) = resource_id {
                require_id(&expected)?;
                if thread["resourceId"] != expected {
                    return Ok(Value::Null);
                }
            }
            // StorageThreadType does not expose the project's database id.
            if let Some(object) = thread.as_object_mut() {
                object.remove("projectId");
            }
            Ok(thread)
        }
        ThreadReadCommand::List {
            resource_id,
            page,
            per_page,
            order_by,
            metadata,
        } => {
            let project_id = resource_project(conn, &resource_id)?;
            let mut statement = conn.prepare(
                "SELECT s.id FROM chat_sessions s
                  WHERE s.project_id = ?1 AND s.id NOT LIKE 'nir1-local-%'
                  ORDER BY s.created_at ASC, s.id ASC",
            )?;
            let ids = statement
                .query_map(params![project_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut threads = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(thread) = thread_row(conn, &id)? {
                    let matches = metadata.as_ref().is_none_or(|filter| {
                        filter.iter().all(|(key, expected)| {
                            thread["metadata"]
                                .get(key)
                                .is_some_and(|value| scalar_equal(value, expected))
                        })
                    });
                    if matches {
                        threads.push(thread);
                    }
                }
            }
            let order = order_by.unwrap_or(SortOrder {
                field: Some(ThreadSortField::CreatedAt),
                direction: Some(SortDirection::Asc),
            });
            let field = match order.field.unwrap_or(ThreadSortField::CreatedAt) {
                ThreadSortField::CreatedAt => "createdAt",
                ThreadSortField::UpdatedAt => "updatedAt",
            };
            let direction = order.direction.unwrap_or(SortDirection::Asc);
            threads.sort_by(|left, right| {
                let time_order = parsed_time(left[field].as_str().unwrap_or_default())
                    .cmp(&parsed_time(right[field].as_str().unwrap_or_default()));
                let id_order = left["id"].as_str().cmp(&right["id"].as_str());
                match direction {
                    SortDirection::Asc => time_order.then(id_order),
                    SortDirection::Desc => time_order.reverse().then(id_order.reverse()),
                }
            });
            let total = threads.len();
            let page = page.unwrap_or(0);
            let limit = per_page.unwrap_or(PageLimit::Count(100)).resolve(100)?;
            let (offset, count) = page_window(page, limit)?;
            let threads = threads
                .into_iter()
                .skip(offset)
                .take(count)
                .collect::<Vec<_>>();
            let mut output = pagination(page, limit, total);
            output["threads"] = json!(threads);
            Ok(output)
        }
    })
}

fn save_thread_row(conn: &Connection, thread: ThreadInput) -> Result<Value> {
    require_public_session(&thread.id)?;
    let project_id = resource_project(conn, &thread.resource_id)?;
    let created_at = normalized_time(thread.created_at.as_deref().unwrap_or(&now_iso()))?;
    let updated_at = normalized_time(thread.updated_at.as_deref().unwrap_or(&created_at))?;
    let title_manual = thread
        .metadata
        .as_ref()
        .and_then(|value| value.get("titlePinned"))
        .and_then(Value::as_bool);
    let title = thread.title.unwrap_or_default();
    let metadata = thread
        .metadata
        .map(|value| json_object(&value))
        .transpose()?;
    if let Some(existing_project) = conn
        .query_row(
            "SELECT project_id FROM chat_sessions WHERE id = ?1 AND id NOT LIKE 'nir1-local-%'",
            params![thread.id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        if existing_project != project_id {
            return refuse(MemoryRefusal::ScopeMismatch);
        }
    }
    conn.execute(
        "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             updated_at = excluded.updated_at,
             title_manual = COALESCE(?6, chat_sessions.title_manual)
         WHERE chat_sessions.project_id = excluded.project_id
           AND (chat_sessions.title IS NOT excluded.title
             OR chat_sessions.updated_at IS NOT excluded.updated_at
             OR (?6 IS NOT NULL AND chat_sessions.title_manual IS NOT ?6))",
        params![
            thread.id,
            project_id,
            title,
            created_at,
            updated_at,
            title_manual.map(db_bool)
        ],
    )
    .map_err(|error| match error {
        rusqlite::Error::SqliteFailure(_, _) => anyhow::Error::new(MemoryRefusal::ScopeMismatch),
        other => other.into(),
    })?;
    if let Some(metadata) = metadata {
        conn.execute(
            "INSERT INTO mastra_thread_metadata (session_id, metadata_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET metadata_json = excluded.metadata_json
             WHERE mastra_thread_metadata.metadata_json IS NOT excluded.metadata_json",
            params![thread.id, metadata],
        )?;
    }
    thread_row(conn, &thread.id)?.ok_or_else(|| anyhow::Error::new(MemoryRefusal::ScopeMismatch))
}

fn update_thread_row(
    conn: &Connection,
    id: String,
    title: Option<String>,
    metadata: Option<Value>,
) -> Result<Value> {
    require_public_session(&id)?;
    let Some(existing) = thread_row(conn, &id)? else {
        return refuse(MemoryRefusal::NotFound);
    };
    if let Some(title) = title {
        conn.execute(
            "UPDATE chat_sessions SET title = ?1, updated_at = ?2
              WHERE id = ?3 AND id NOT LIKE 'nir1-local-%' AND title IS NOT ?1",
            params![title, now_iso(), id],
        )?;
    }
    if let Some(metadata) = metadata {
        let encoded = json_object(&metadata)?;
        conn.execute(
            "INSERT INTO mastra_thread_metadata (session_id, metadata_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET metadata_json = excluded.metadata_json
             WHERE mastra_thread_metadata.metadata_json IS NOT excluded.metadata_json",
            params![id, encoded],
        )?;
        if let Some(pinned) = metadata.get("titlePinned").and_then(Value::as_bool) {
            conn.execute(
                "UPDATE chat_sessions SET title_manual = ?1, updated_at = ?2
                  WHERE id = ?3 AND id NOT LIKE 'nir1-local-%'
                    AND title_manual IS NOT ?1",
                params![db_bool(pinned), now_iso(), id],
            )?;
        }
    }
    Ok(thread_row(conn, &id)?.unwrap_or(existing))
}

pub fn thread_write(db: &Database, request: ThreadWriteCommand) -> Result<Value> {
    with_immediate_transaction(db, |conn| match request {
        ThreadWriteCommand::Save { thread } => save_thread_row(conn, thread),
        ThreadWriteCommand::Update {
            id,
            title,
            metadata,
        } => update_thread_row(conn, id, title, metadata),
    })
}

pub fn thread_delete(db: &Database, request: ThreadDeleteRequest) -> Result<Value> {
    require_public_session(&request.thread_id)?;
    let project_id = db.with_conn(|conn| session_project(conn, &request.thread_id))?;
    let Some(project_id) = project_id else {
        return Ok(json!({ "deleted": 0 }));
    };
    let deleted = chat_typed_writes::delete_session(
        db,
        DeleteSessionRequest {
            project_id,
            session_id: request.thread_id,
        },
    )?;
    Ok(serde_json::to_value(deleted)?)
}

fn text_content(content: &Value) -> String {
    content
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            content
                .get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
}

fn digest_value(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn redact_tool_result(value: &mut Value, in_tool_result: bool) {
    match value {
        Value::Array(items) => {
            for item in items {
                redact_tool_result(item, in_tool_result);
            }
        }
        Value::Object(object) => {
            if let Some(provider) = object
                .get_mut("providerMetadata")
                .and_then(Value::as_object_mut)
            {
                if let Some(mastra) = provider.get_mut("mastra").and_then(Value::as_object_mut) {
                    mastra.remove("modelOutput");
                }
            }
            let type_is_tool_result = matches!(
                object.get("type").and_then(Value::as_str),
                Some("tool-result" | "tool-invocation")
            );
            let tool_invocation = object.get("toolInvocation").is_some();
            for (key, child) in object.iter_mut() {
                let is_result = matches!(key.as_str(), "result" | "output")
                    && (in_tool_result || type_is_tool_result || tool_invocation);
                if is_result && !child.is_null() {
                    *child = Value::String(digest_value(child));
                } else {
                    redact_tool_result(
                        child,
                        in_tool_result || type_is_tool_result || tool_invocation,
                    );
                }
            }
        }
        _ => {}
    }
}

fn sanitized_content(mut content: Value) -> Result<Value> {
    let Some(object) = content.as_object_mut() else {
        return refuse(MemoryRefusal::InvalidRequest);
    };
    object.remove("experimental_attachments");
    if let Some(parts) = object.get_mut("parts").and_then(Value::as_array_mut) {
        parts.retain(|part| {
            !matches!(
                part.get("type").and_then(Value::as_str),
                Some("image" | "file")
            )
        });
    }
    redact_tool_result(&mut content, false);
    Ok(content)
}

fn captured_message(conn: &Connection, message_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM nir1_generation_message_versions WHERE message_id = ?1)
              OR EXISTS(SELECT 1 FROM nir1_chat_input_captures WHERE message_id = ?1)",
        params![message_id],
        |row| row.get(0),
    )?)
}

fn message_value(conn: &Connection, message_id: &str) -> Result<Option<Value>> {
    let row = conn
        .query_row(
            "SELECT m.id, m.session_id, m.role, m.content, m.created_at, mp.parts_json,
                    m.metadata, r.id
               FROM chat_messages m
               JOIN chat_sessions s ON s.id = m.session_id
               LEFT JOIN mastra_message_parts mp ON mp.message_id = m.id
               LEFT JOIN mastra_resources r ON r.project_id = s.project_id
              WHERE m.id = ?1 AND s.id NOT LIKE 'nir1-local-%'",
            params![message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(|(id, thread_id, role, body, created_at, parts, metadata, resource_id)| {
        let content = parts
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| {
                let mut content = json!({ "format": 2, "parts": [{"type":"text", "text": body}], "content": body });
                if let Some(raw) = metadata.and_then(|value| serde_json::from_str::<Value>(&value).ok()) {
                    content["metadata"] = raw;
                }
                content
            });
        json!({
            "id": id,
            "threadId": thread_id,
            "resourceId": resource_id,
            "role": role,
            "createdAt": created_at,
            "content": content,
        })
    }))
}

fn write_message(conn: &Connection, message: MemoryMessageInput) -> Result<Option<Value>> {
    require_id(&message.id)?;
    require_public_session(&message.thread_id)?;
    if !matches!(message.role.as_str(), "user" | "assistant" | "system")
        || (message.role == "user" && message.is_injected)
    {
        return Ok(None);
    }
    let created_at = normalized_time(&message.created_at)?;
    let content = sanitized_content(message.content)?;
    let content_json = serde_json::to_string(&content)?;
    let body = text_content(&content);
    let metadata = content.get("metadata").map(json_object).transpose()?;
    let project_id = session_project(conn, &message.thread_id)?
        .ok_or_else(|| anyhow::Error::new(MemoryRefusal::ScopeMismatch))?;
    let existing = conn
        .query_row(
            "SELECT session_id, role FROM chat_messages WHERE id = ?1",
            params![message.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((session_id, role)) = &existing {
        if session_id != &message.thread_id || role != &message.role {
            return refuse(MemoryRefusal::ScopeMismatch);
        }
    }
    let captured = captured_message(conn, &message.id)?;
    if !captured {
        // A user row cannot supersede a live NIR-1 human capture.
        if message.role == "user"
            && conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM nir1_chat_input_captures
                               WHERE chat_session_id = ?1 AND state = 'current')",
                params![message.thread_id],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Ok(None);
        }
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 content = excluded.content,
                 metadata = excluded.metadata
             WHERE chat_messages.content IS NOT excluded.content
                OR chat_messages.metadata IS NOT excluded.metadata",
            params![
                message.id,
                message.thread_id,
                message.role,
                body,
                metadata,
                created_at
            ],
        )?;
    }
    conn.execute(
        "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES (?1, ?2)
         ON CONFLICT(message_id) DO UPDATE SET parts_json = excluded.parts_json
         WHERE mastra_message_parts.parts_json IS NOT excluded.parts_json",
        params![message.id, content_json],
    )?;
    // Ensure the session project still matches the resource read by this operation.
    if session_project(conn, &message.thread_id)?.as_deref() != Some(project_id.as_str()) {
        return refuse(MemoryRefusal::ScopeMismatch);
    }
    message_value(conn, &message.id)
}

fn patch_message(conn: &Connection, message: MemoryMessagePatch) -> Result<Option<Value>> {
    require_id(&message.id)?;
    let Some(content) = message.content else {
        return message_value(conn, &message.id);
    };
    let Some(existing) = message_value(conn, &message.id)? else {
        return Ok(None);
    };
    let content = sanitized_content(content)?;
    let encoded = serde_json::to_string(&content)?;
    if captured_message(conn, &message.id)? {
        conn.execute(
            "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES (?1, ?2)
             ON CONFLICT(message_id) DO UPDATE SET parts_json = excluded.parts_json
             WHERE mastra_message_parts.parts_json IS NOT excluded.parts_json",
            params![message.id, encoded],
        )?;
    } else {
        let body = text_content(&content);
        let metadata = content.get("metadata").map(json_object).transpose()?;
        conn.execute(
            "UPDATE chat_messages SET content = ?1, metadata = ?2
              WHERE id = ?3 AND session_id NOT LIKE 'nir1-local-%'
                AND (content IS NOT ?1 OR metadata IS NOT ?2)",
            params![body, metadata, message.id],
        )?;
        conn.execute(
            "INSERT INTO mastra_message_parts (message_id, parts_json) VALUES (?1, ?2)
             ON CONFLICT(message_id) DO UPDATE SET parts_json = excluded.parts_json
             WHERE mastra_message_parts.parts_json IS NOT excluded.parts_json",
            params![message.id, encoded],
        )?;
    }
    message_value(conn, &message.id).map(|value| value.or(Some(existing)))
}

fn date_matches(value: &str, filter: Option<&DateRange>) -> Result<bool> {
    let Some(filter) = filter else {
        return Ok(true);
    };
    let created =
        parsed_time(value).ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
    if let Some(start) = filter.start.as_deref() {
        let start =
            parsed_time(start).ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
        if if filter.start_exclusive.unwrap_or(false) {
            created <= start
        } else {
            created < start
        } {
            return Ok(false);
        }
    }
    if let Some(end) = filter.end.as_deref() {
        let end =
            parsed_time(end).ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
        if if filter.end_exclusive.unwrap_or(false) {
            created >= end
        } else {
            created > end
        } {
            return Ok(false);
        }
    }
    Ok(true)
}

fn message_metadata(message: &Value) -> &Value {
    &message["content"]["metadata"]
}

fn message_matches_metadata(message: &Value, filter: Option<&Map<String, Value>>) -> bool {
    filter.is_none_or(|filter| {
        filter.iter().all(|(key, expected)| {
            message_metadata(message)
                .get(key)
                .is_some_and(|actual| scalar_equal(actual, expected))
        })
    })
}

fn list_messages_for_sessions(
    conn: &Connection,
    session_ids: &[String],
    date_range: Option<&DateRange>,
    metadata: Option<&Map<String, Value>>,
) -> Result<Vec<Value>> {
    for id in session_ids {
        require_public_session(id)?;
    }
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=session_ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT m.id FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.id NOT LIKE 'nir1-local-%' AND m.session_id IN ({placeholders})"
    );
    let mut statement = conn.prepare(&query)?;
    let ids = statement
        .query_map(params_from_iter(session_ids.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut messages = Vec::new();
    for id in ids {
        if let Some(message) = message_value(conn, &id)? {
            if date_matches(
                message["createdAt"].as_str().unwrap_or_default(),
                date_range,
            )? && message_matches_metadata(&message, metadata)
            {
                messages.push(message);
            }
        }
    }
    Ok(messages)
}

fn sort_messages(messages: &mut [Value], direction: SortDirection) {
    messages.sort_by(|left, right| {
        let time_order = parsed_time(left["createdAt"].as_str().unwrap_or_default()).cmp(
            &parsed_time(right["createdAt"].as_str().unwrap_or_default()),
        );
        let id_order = left["id"].as_str().cmp(&right["id"].as_str());
        match direction {
            SortDirection::Asc => time_order.then(id_order),
            SortDirection::Desc => time_order.reverse().then(id_order.reverse()),
        }
    });
}

pub fn message_read(db: &Database, request: MessageReadCommand) -> Result<Value> {
    db.with_conn(|conn| {
        let (mut messages, page, limit, direction) = match request {
            MessageReadCommand::List {
                thread_id,
                resource_id,
                page,
                per_page,
                order_by,
                date_range,
                metadata,
            } => {
                let ids = thread_id.into_vec();
                if ids.is_empty() {
                    return refuse(MemoryRefusal::InvalidRequest);
                }
                for id in &ids {
                    require_public_session(id)?;
                }
                if let Some(resource_id) = resource_id {
                    let project_id = resource_project(conn, &resource_id)?;
                    for id in &ids {
                        if session_project(conn, id)?.as_deref().is_some_and(|project| project != project_id) {
                            return refuse(MemoryRefusal::ScopeMismatch);
                        }
                    }
                }
                let mut messages = list_messages_for_sessions(conn, &ids, date_range.as_ref(), metadata.as_ref())?;
                let direction = order_by.and_then(|sort| sort.direction).unwrap_or(SortDirection::Asc);
                sort_messages(&mut messages, direction);
                (messages, page.unwrap_or(0), per_page.map(|v| v.resolve(40)).transpose()?.unwrap_or(Some(40)), direction)
            }
            MessageReadCommand::ById { message_ids } => {
                let mut messages = Vec::new();
                for id in message_ids {
                    require_id(&id)?;
                    if let Some(message) = message_value(conn, &id)? {
                        messages.push(message);
                    }
                }
                sort_messages(&mut messages, SortDirection::Asc);
                (messages, 0, None, SortDirection::Asc)
            }
            MessageReadCommand::ByResource {
                resource_id,
                page,
                per_page,
                order_by,
                date_range,
                metadata,
            } => {
                let project_id = resource_project(conn, &resource_id)?;
                let mut statement = conn.prepare(
                    "SELECT id FROM chat_sessions WHERE project_id = ?1 AND id NOT LIKE 'nir1-local-%' ORDER BY id",
                )?;
                let ids = statement
                    .query_map(params![project_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut messages = list_messages_for_sessions(conn, &ids, date_range.as_ref(), metadata.as_ref())?;
                let direction = order_by.and_then(|sort| sort.direction).unwrap_or(SortDirection::Asc);
                sort_messages(&mut messages, direction);
                (messages, page.unwrap_or(0), per_page.map(|v| v.resolve(40)).transpose()?.unwrap_or(Some(40)), direction)
            }
        };
        let _ = direction;
        let total = messages.len();
        let (offset, count) = page_window(page, limit)?;
        messages = messages.into_iter().skip(offset).take(count).collect();
        if limit.is_none() {
            Ok(json!({ "messages": messages, "total": total, "page": page, "perPage": false, "hasMore": false }))
        } else {
            let mut output = pagination(page, limit, total);
            output["messages"] = json!(messages);
            Ok(output)
        }
    })
}

pub fn message_write(db: &Database, request: MessageWriteCommand) -> Result<Value> {
    with_immediate_transaction(db, |conn| match request {
        MessageWriteCommand::Save { messages } => {
            let mut saved = Vec::new();
            for message in messages {
                if let Some(message) = write_message(conn, message)? {
                    saved.push(message);
                }
            }
            Ok(json!({ "messages": saved }))
        }
        MessageWriteCommand::Update { messages } => {
            let mut updated = Vec::new();
            for message in messages {
                if let Some(message) = patch_message(conn, message)? {
                    updated.push(message);
                }
            }
            Ok(json!(updated))
        }
    })
}

pub fn message_delete(db: &Database, request: MessageDeleteRequest) -> Result<Value> {
    let result = chat_typed_writes::delete_messages_by_ids(
        db,
        DeleteMessagesByIdsRequest {
            message_ids: request.message_ids,
        },
    )?;
    Ok(serde_json::to_value(result)?)
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceReadCommand {
    Get { project_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceWriteCommand {
    Save {
        id: String,
        project_id: String,
        working_memory: Option<String>,
        metadata: Option<Value>,
    },
    Update {
        id: String,
        #[serde(default, deserialize_with = "deserialize_optional_patch")]
        working_memory: Option<Option<String>>,
        metadata: Option<Value>,
    },
    MergeWorkingMemory {
        project_id: String,
        patch: Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ObservationalMemoryReadCommand {
    Get {
        thread_id: Option<String>,
        resource_id: String,
    },
    History {
        thread_id: Option<String>,
        resource_id: String,
        limit: Option<usize>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ObservationalMemoryWriteCommand {
    Save {
        record: Value,
    },
    Update {
        id: String,
        fields: Map<String, Value>,
    },
    Clear {
        thread_id: Option<String>,
        resource_id: String,
    },
}

pub fn resource_read(db: &Database, request: ResourceReadCommand) -> Result<Value> {
    let ResourceReadCommand::Get { project_id } = request;
    require_id(&project_id)?;
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT json_object('id',id,'projectId',project_id,'workingMemory',working_memory,'metadata',json(metadata_json)) FROM mastra_resources WHERE project_id=?1",
            params![project_id], |row| row.get::<_, String>(0),
        ).optional()?.map(|json| serde_json::from_str(&json)).transpose()?.unwrap_or(Value::Null))
    })
}

pub fn resource_write(db: &Database, request: ResourceWriteCommand) -> Result<Value> {
    match request {
        ResourceWriteCommand::Save {
            id,
            project_id,
            working_memory,
            metadata,
        } => {
            require_id(&id)?;
            require_id(&project_id)?;
            let metadata = json_object(&metadata.unwrap_or_else(|| json!({})))?;
            with_immediate_transaction(db, |conn| {
                conn.execute(
                    "INSERT INTO mastra_resources(id,project_id,working_memory,metadata_json) VALUES (?1,?2,?3,?4) ON CONFLICT(project_id) DO UPDATE SET id=excluded.id,working_memory=excluded.working_memory,metadata_json=excluded.metadata_json,updated_at=datetime('now') WHERE (id,working_memory,metadata_json) IS NOT (excluded.id,excluded.working_memory,excluded.metadata_json)",
                    params![id, project_id, working_memory, metadata],
                )?;
                Ok(
                    json!({"id":id,"projectId":project_id,"workingMemory":working_memory,"metadata":serde_json::from_str::<Value>(&metadata)?}),
                )
            })
        }
        ResourceWriteCommand::Update {
            id,
            working_memory,
            metadata,
        } => {
            require_id(&id)?;
            let metadata = metadata.map(|value| json_object(&value)).transpose()?;
            with_immediate_transaction(db, |conn| {
                let project_id: String = conn
                    .query_row(
                        "SELECT project_id FROM mastra_resources WHERE id=?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| anyhow::Error::new(MemoryRefusal::NotFound))?;
                let (set_working, next_working) = match working_memory {
                    Some(value) => (true, value),
                    None => (false, None),
                };
                let changed = conn.execute("UPDATE mastra_resources SET working_memory=CASE WHEN ?2 THEN ?3 ELSE working_memory END, metadata_json=COALESCE(?4,metadata_json), updated_at=datetime('now') WHERE id=?1 AND ( (?2 AND working_memory IS NOT ?3) OR (?4 IS NOT NULL AND metadata_json IS NOT ?4) )", params![id, set_working, next_working, metadata])?;
                let _ = changed;
                resource_json_by_id(conn, &id).map(|mut value| {
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("projectId".into(), json!(project_id));
                    }
                    value
                })
            })
        }
        ResourceWriteCommand::MergeWorkingMemory { project_id, patch } => {
            require_id(&project_id)?;
            if !patch.is_object() {
                return refuse(MemoryRefusal::InvalidRequest);
            }
            with_immediate_transaction(db, |conn| {
                let current: Option<String> = conn
                    .query_row(
                        "SELECT working_memory FROM mastra_resources WHERE project_id=?1",
                        params![project_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                let mut merged = match current {
                    Some(raw) => serde_json::from_str::<Value>(&raw)
                        .map_err(|_| anyhow::Error::new(MemoryRefusal::InvalidRequest))?,
                    None => Value::Object(Map::new()),
                };
                if !merged.is_object() {
                    return refuse(MemoryRefusal::InvalidRequest);
                }
                for (key, value) in patch.as_object().into_iter().flatten() {
                    merged[key] = value.clone();
                }
                let serialized = serde_json::to_string(&merged)?;
                conn.execute("UPDATE mastra_resources SET working_memory=?2,updated_at=datetime('now') WHERE project_id=?1 AND working_memory IS NOT ?2", params![project_id, serialized])?;
                resource_json_by_project(conn, &project_id)
            })
        }
    }
}

fn resource_json_by_id(conn: &Connection, id: &str) -> Result<Value> {
    let raw: String = conn.query_row("SELECT json_object('id',id,'workingMemory',working_memory,'metadata',json(metadata_json)) FROM mastra_resources WHERE id=?1", params![id], |row| row.get(0)).optional()?.ok_or_else(|| anyhow::Error::new(MemoryRefusal::NotFound))?;
    Ok(serde_json::from_str(&raw)?)
}

fn resource_json_by_project(conn: &Connection, project_id: &str) -> Result<Value> {
    let raw: String = conn.query_row("SELECT json_object('id',id,'projectId',project_id,'workingMemory',working_memory,'metadata',json(metadata_json)) FROM mastra_resources WHERE project_id=?1", params![project_id], |row| row.get(0)).optional()?.ok_or_else(|| anyhow::Error::new(MemoryRefusal::NotFound))?;
    Ok(serde_json::from_str(&raw)?)
}

fn observational_scope(
    conn: &Connection,
    thread_id: Option<&str>,
    resource_id: &str,
) -> Result<(String, Option<String>, Option<String>)> {
    let project_id = resource_project(conn, resource_id)?;
    if let Some(thread_id) = thread_id {
        let thread_project = session_project(conn, thread_id)?
            .ok_or_else(|| anyhow::Error::new(MemoryRefusal::ScopeMismatch))?;
        if thread_project != project_id {
            return refuse(MemoryRefusal::ScopeMismatch);
        }
        Ok(("thread".into(), Some(thread_id.into()), None))
    } else {
        Ok(("resource".into(), None, Some(project_id)))
    }
}

const OM_COLUMNS: &[(&str, &str)] = &[
    ("id", "id"),
    ("scope", "scope"),
    ("threadId", "thread_id"),
    ("projectId", "project_id"),
    ("resourceId", "resource_id"),
    ("createdAt", "created_at"),
    ("updatedAt", "updated_at"),
    ("lastObservedAt", "last_observed_at"),
    ("originType", "origin_type"),
    ("generationCount", "generation_count"),
    ("supersededBy", "superseded_by"),
    ("activeObservations", "active_observations"),
    (
        "bufferedObservationChunks",
        "buffered_observation_chunks_json",
    ),
    ("bufferedObservations", "buffered_observations"),
    ("bufferedObservationTokens", "buffered_observation_tokens"),
    ("bufferedMessageIds", "buffered_message_ids_json"),
    ("bufferedReflection", "buffered_reflection"),
    ("bufferedReflectionTokens", "buffered_reflection_tokens"),
    (
        "bufferedReflectionInputTokens",
        "buffered_reflection_input_tokens",
    ),
    (
        "reflectedObservationLineCount",
        "reflected_observation_line_count",
    ),
    ("observedMessageIds", "observed_message_ids_json"),
    ("observedTimezone", "observed_timezone"),
    ("totalTokensObserved", "total_tokens_observed"),
    ("observationTokenCount", "observation_token_count"),
    ("pendingMessageTokens", "pending_message_tokens"),
    ("isReflecting", "is_reflecting"),
    ("isObserving", "is_observing"),
    ("isBufferingObservation", "is_buffering_observation"),
    ("isBufferingReflection", "is_buffering_reflection"),
    ("lastBufferedAtTokens", "last_buffered_at_tokens"),
    ("lastBufferedAtTime", "last_buffered_at_time"),
    ("config", "config_json"),
    ("metadata", "metadata_json"),
];

pub fn observational_memory_read(
    db: &Database,
    request: ObservationalMemoryReadCommand,
) -> Result<Value> {
    db.with_conn(|conn| {
        let (thread_id, resource_id, limit, history) = match request {
            ObservationalMemoryReadCommand::Get { thread_id, resource_id } => (thread_id, resource_id, 1usize, false),
            ObservationalMemoryReadCommand::History { thread_id, resource_id, limit } => (thread_id, resource_id, limit.unwrap_or(100).min(1000), true),
        };
        let (scope, thread, project) = observational_scope(conn, thread_id.as_deref(), &resource_id)?;
        let where_sql = if scope == "thread" { "scope='thread' AND thread_id=?1 AND resource_id=?2" } else { "scope='resource' AND project_id=?1 AND resource_id=?2" };
        let limit = i64::try_from(limit).map_err(|_| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
        let sql = format!("SELECT {} FROM mastra_observational_memory WHERE {where_sql} ORDER BY updated_at DESC,id DESC LIMIT ?3", om_json_select());
        let rows = conn.prepare(&sql)?.query_map(params![thread.or(project), resource_id, limit], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let values = rows.into_iter().map(|raw| serde_json::from_str(&raw)).collect::<std::result::Result<Vec<Value>,_>>()?;
        Ok(if history { json!(values) } else { values.into_iter().next().unwrap_or(Value::Null) })
    })
}

fn om_json_select() -> String {
    let props = OM_COLUMNS
        .iter()
        .map(|(json, column)| {
            format!(
                "'{json}',{}",
                if json.ends_with("Chunks")
                    || json.ends_with("Ids")
                    || *json == "config"
                    || *json == "metadata"
                {
                    format!("json({column})")
                } else {
                    (*column).to_string()
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("json_object({props})")
}

pub fn observational_memory_write(
    db: &Database,
    request: ObservationalMemoryWriteCommand,
) -> Result<Value> {
    match request {
        ObservationalMemoryWriteCommand::Save { record } => {
            if !record.is_object() {
                return refuse(MemoryRefusal::InvalidRequest);
            }
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
            let resource_id = record
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
            require_id(id)?;
            require_id(resource_id)?;
            let thread_id = record.get("threadId").and_then(Value::as_str);
            for key in ["config", "metadata"] {
                if let Some(value) = record.get(key).filter(|v| !v.is_null()) {
                    json_object(value)?;
                }
            }
            let serialized = serde_json::to_string(&record)?;
            with_immediate_transaction(db, |conn| {
                let (scope, thread, project) = observational_scope(conn, thread_id, resource_id)?;
                let existing = conn
                    .query_row(
                        "SELECT scope,thread_id,project_id,resource_id FROM mastra_observational_memory WHERE id=?1",
                        params![id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?)),
                    )
                    .optional()?;
                if let Some((old_scope, old_thread, old_project, old_resource)) = existing {
                    if old_scope != scope
                        || old_thread != thread
                        || old_project != project
                        || old_resource != resource_id
                    {
                        return refuse(MemoryRefusal::ScopeMismatch);
                    }
                }
                let insert_cols = OM_COLUMNS
                    .iter()
                    .map(|(_, column)| *column)
                    .collect::<Vec<_>>()
                    .join(",");
                let select_values = OM_COLUMNS
                    .iter()
                    .map(|(key, column)| {
                        let json_path = format!("$.{key}");
                        let extracted = format!("json_extract(?1,'{json_path}')");
                        match *column {
                            "scope" => "?2".into(),
                            "thread_id" => "?3".into(),
                            "project_id" => "?4".into(),
                            "resource_id" => "?5".into(),
                            "config_json" => format!("COALESCE({extracted},'{{}}')"),
                            "generation_count"
                            | "total_tokens_observed"
                            | "observation_token_count"
                            | "pending_message_tokens"
                            | "is_reflecting"
                            | "is_observing"
                            | "is_buffering_observation"
                            | "is_buffering_reflection"
                            | "last_buffered_at_tokens" => format!("COALESCE({extracted},0)"),
                            "created_at" | "updated_at" => {
                                format!("COALESCE({extracted},datetime('now'))")
                            }
                            _ => extracted,
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                let mutable = OM_COLUMNS
                    .iter()
                    .filter(|(_, col)| {
                        !matches!(
                            *col,
                            "id" | "scope"
                                | "thread_id"
                                | "project_id"
                                | "resource_id"
                                | "created_at"
                        )
                    })
                    .map(|(_, col)| *col)
                    .collect::<Vec<_>>();
                let update = mutable
                    .iter()
                    .map(|col| format!("{col}=excluded.{col}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let changed = mutable
                    .iter()
                    .map(|col| format!("{col} IS NOT excluded.{col}"))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                let sql = format!("INSERT INTO mastra_observational_memory({insert_cols}) SELECT {select_values} WHERE true ON CONFLICT(id) DO UPDATE SET {update} WHERE {changed}");
                conn.execute(
                    &sql,
                    params![serialized, scope, thread, project, resource_id],
                )?;
                let raw: String = conn.query_row(
                    &format!(
                        "SELECT {} FROM mastra_observational_memory WHERE id=?1",
                        om_json_select(),
                    ),
                    params![id],
                    |row| row.get(0),
                )?;
                Ok(serde_json::from_str(&raw)?)
            })
        }
        ObservationalMemoryWriteCommand::Update { id, fields } => {
            require_id(&id)?;
            with_immediate_transaction(db, |conn| {
                let raw: String = conn
                    .query_row(
                        &format!(
                            "SELECT {} FROM mastra_observational_memory WHERE id=?1",
                            om_json_select()
                        ),
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| anyhow::Error::new(MemoryRefusal::NotFound))?;
                let current: Value = serde_json::from_str(&raw)?;
                observational_scope(
                    conn,
                    current.get("threadId").and_then(Value::as_str),
                    current["resourceId"].as_str().unwrap_or_default(),
                )?;
                let mut assignments = Vec::new();
                let mut values = Vec::new();
                for (key, value) in fields {
                    let (_, column) = OM_COLUMNS
                        .iter()
                        .find(|(name, _)| *name == key)
                        .ok_or_else(|| anyhow::Error::new(MemoryRefusal::InvalidRequest))?;
                    if matches!(
                        *column,
                        "id" | "scope" | "thread_id" | "project_id" | "resource_id" | "created_at"
                    ) {
                        return refuse(MemoryRefusal::InvalidRequest);
                    }
                    if matches!(*column, "metadata_json" | "config_json") && !value.is_null() {
                        json_object(&value)?;
                    }
                    assignments.push(format!("{column}=?"));
                    values.push(
                        if matches!(
                            *column,
                            "buffered_observation_chunks_json"
                                | "buffered_message_ids_json"
                                | "observed_message_ids_json"
                                | "config_json"
                                | "metadata_json"
                        ) && !value.is_null()
                        {
                            SqlValue::Text(serde_json::to_string(&value)?)
                        } else {
                            match value {
                                Value::Null => SqlValue::Null,
                                Value::Bool(v) => SqlValue::Integer(i64::from(v)),
                                Value::Number(v) => v
                                    .as_i64()
                                    .map(SqlValue::Integer)
                                    .or_else(|| v.as_f64().map(SqlValue::Real))
                                    .unwrap_or(SqlValue::Null),
                                Value::String(v) => SqlValue::Text(v),
                                other => SqlValue::Text(serde_json::to_string(&other)?),
                            }
                        },
                    );
                }
                if !assignments.is_empty() {
                    let where_id = values.len() + 1;
                    values.push(SqlValue::Text(id.clone()));
                    let sql = format!(
                        "UPDATE mastra_observational_memory SET {} WHERE id=?{where_id}",
                        assignments.join(",")
                    );
                    conn.execute(&sql, params_from_iter(values))?;
                }
                let raw: String = conn.query_row(
                    &format!(
                        "SELECT {} FROM mastra_observational_memory WHERE id=?1",
                        om_json_select()
                    ),
                    params![id],
                    |row| row.get(0),
                )?;
                Ok(serde_json::from_str(&raw)?)
            })
        }
        ObservationalMemoryWriteCommand::Clear {
            thread_id,
            resource_id,
        } => with_immediate_transaction(db, |conn| {
            let (scope, thread, project) =
                observational_scope(conn, thread_id.as_deref(), &resource_id)?;
            let where_sql = if scope == "thread" {
                "scope='thread' AND thread_id=?1 AND resource_id=?2"
            } else {
                "scope='resource' AND project_id=?1 AND resource_id=?2"
            };
            conn.execute(
                &format!("DELETE FROM mastra_observational_memory WHERE {where_sql}"),
                params![thread.or(project), resource_id],
            )?;
            Ok(Value::Null)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    const CREATED: &str = "2026-11-01T00:00:00.000Z";

    fn db() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE mastra_resources (
                 id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
                 working_memory TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE chat_sessions (
                 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                 title_manual INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE chat_messages (
                 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                 role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL,
                 metadata TEXT, created_at TEXT NOT NULL
             );
             CREATE TABLE mastra_thread_metadata (
                 session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
                 metadata_json TEXT NOT NULL
             );
             CREATE TABLE mastra_message_parts (
                 message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
                 parts_json TEXT NOT NULL
             );
             CREATE TABLE mastra_observational_memory (
                 id TEXT PRIMARY KEY, scope TEXT NOT NULL, thread_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
                 project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, resource_id TEXT NOT NULL,
                 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_observed_at TEXT,
                 origin_type TEXT NOT NULL, generation_count INTEGER NOT NULL, superseded_by TEXT,
                 active_observations TEXT NOT NULL, buffered_observation_chunks_json TEXT, buffered_observations TEXT,
                 buffered_observation_tokens INTEGER, buffered_message_ids_json TEXT, buffered_reflection TEXT,
                 buffered_reflection_tokens INTEGER, buffered_reflection_input_tokens INTEGER,
                 reflected_observation_line_count INTEGER, observed_message_ids_json TEXT, observed_timezone TEXT,
                 total_tokens_observed INTEGER NOT NULL DEFAULT 0, observation_token_count INTEGER NOT NULL DEFAULT 0,
                 pending_message_tokens INTEGER NOT NULL DEFAULT 0, is_reflecting INTEGER NOT NULL DEFAULT 0,
                 is_observing INTEGER NOT NULL DEFAULT 0, is_buffering_observation INTEGER NOT NULL DEFAULT 0,
                 is_buffering_reflection INTEGER NOT NULL DEFAULT 0, last_buffered_at_tokens INTEGER NOT NULL DEFAULT 0,
                 last_buffered_at_time TEXT, config_json TEXT NOT NULL DEFAULT '{}', metadata_json TEXT,
                 CHECK((scope='thread' AND thread_id IS NOT NULL AND project_id IS NULL) OR (scope='resource' AND thread_id IS NULL AND project_id IS NOT NULL))
             );
             CREATE TABLE nir1_generation_message_versions (message_id TEXT);
             CREATE TABLE nir1_chat_input_captures (
                 message_id TEXT, chat_session_id TEXT, state TEXT
             );
             CREATE TABLE nir1_generation_attempts (session_id TEXT, terminal_json TEXT);
             INSERT INTO projects VALUES ('p1'), ('p2');
             INSERT INTO mastra_resources(id,project_id) VALUES ('r1','p1'), ('r2','p2');
             INSERT INTO chat_sessions (id,project_id,created_at,updated_at) VALUES
                 ('s1','p1', '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'),
                 ('s2','p1', '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'),
                 ('s3','p2', '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'),
                 ('nir1-local-private','p1', '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');",
        )
        .unwrap();
        Database::from_connection(conn)
    }

    fn input(id: &str, thread_id: &str, role: &str, content: &str) -> MemoryMessageInput {
        MemoryMessageInput {
            id: id.into(),
            thread_id: thread_id.into(),
            role: role.into(),
            created_at: CREATED.into(),
            content: json!({"format": 2, "content": content, "parts": [{"type":"text", "text":content}]}),
            is_injected: false,
        }
    }

    fn om_record(id: &str, resource_id: &str, thread_id: Option<&str>) -> Value {
        json!({
            "id": id, "resourceId": resource_id, "threadId": thread_id,
            "createdAt": CREATED, "updatedAt": CREATED, "originType": "initial",
            "generationCount": 0, "activeObservations": "memory", "config": {}, "metadata": {}
        })
    }

    #[test]
    fn resource_upsert_metadata_validation_and_working_memory_merge() {
        let clear: ResourceWriteCommand =
            serde_json::from_value(json!({"operation":"update","id":"r1","workingMemory":null}))
                .unwrap();
        assert!(matches!(
            clear,
            ResourceWriteCommand::Update {
                working_memory: Some(None),
                ..
            }
        ));
        let db = db();
        resource_write(
            &db,
            ResourceWriteCommand::Save {
                id: "r1".into(),
                project_id: "p1".into(),
                working_memory: None,
                metadata: Some(json!({"a":1})),
            },
        )
        .unwrap();
        resource_write(
            &db,
            ResourceWriteCommand::MergeWorkingMemory {
                project_id: "p1".into(),
                patch: json!({"name":"Ada"}),
            },
        )
        .unwrap();
        resource_write(
            &db,
            ResourceWriteCommand::MergeWorkingMemory {
                project_id: "p1".into(),
                patch: json!({"role":"writer"}),
            },
        )
        .unwrap();
        let row = resource_read(
            &db,
            ResourceReadCommand::Get {
                project_id: "p1".into(),
            },
        )
        .unwrap();
        let working_memory: Value =
            serde_json::from_str(row["workingMemory"].as_str().unwrap()).unwrap();
        assert_eq!(working_memory["name"], "Ada");
        assert_eq!(working_memory["role"], "writer");
        assert_eq!(row["metadata"]["a"], 1);
        let error = resource_write(
            &db,
            ResourceWriteCommand::Save {
                id: "r1".into(),
                project_id: "p1".into(),
                working_memory: None,
                metadata: Some(json!("invalid")),
            },
        )
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::InvalidRequest)
        ));
    }

    #[test]
    fn observational_memory_upsert_is_scoped_and_rejects_local_sessions() {
        let db = db();
        let first = om_record("om1", "r1", Some("s1"));
        observational_memory_write(&db, ObservationalMemoryWriteCommand::Save { record: first })
            .unwrap();
        let mut replacement = om_record("om2", "r1", Some("s1"));
        replacement["activeObservations"] = json!("updated");
        let saved = observational_memory_write(
            &db,
            ObservationalMemoryWriteCommand::Save {
                record: replacement,
            },
        )
        .unwrap();
        assert_eq!(saved["id"], "om2");
        assert_eq!(saved["activeObservations"], "updated");
        assert_eq!(
            observational_memory_read(
                &db,
                ObservationalMemoryReadCommand::Get {
                    thread_id: Some("s1".into()),
                    resource_id: "r1".into()
                }
            )
            .unwrap()["id"],
            "om2"
        );
        assert_eq!(
            observational_memory_read(
                &db,
                ObservationalMemoryReadCommand::History {
                    thread_id: Some("s1".into()),
                    resource_id: "r1".into(),
                    limit: None
                }
            )
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
            2
        );
        let err = observational_memory_write(
            &db,
            ObservationalMemoryWriteCommand::Save {
                record: om_record("private", "r1", Some("nir1-local-private")),
            },
        )
        .unwrap_err();
        assert!(matches!(
            err.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::ScopeMismatch)
        ));
        let err = observational_memory_write(
            &db,
            ObservationalMemoryWriteCommand::Save {
                record: om_record("wrong", "r2", Some("s1")),
            },
        )
        .unwrap_err();
        assert!(matches!(
            err.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::ScopeMismatch)
        ));
    }

    #[test]
    fn observational_memory_project_and_session_deletes_cascade() {
        let db = db();
        for (id, thread) in [("thread-om", Some("s1")), ("resource-om", None)] {
            observational_memory_write(
                &db,
                ObservationalMemoryWriteCommand::Save {
                    record: om_record(id, "r1", thread),
                },
            )
            .unwrap();
        }
        db.with_conn(|conn| {
            conn.execute("DELETE FROM chat_sessions WHERE id='s1'", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            observational_memory_read(
                &db,
                ObservationalMemoryReadCommand::Get {
                    thread_id: None,
                    resource_id: "r1".into()
                }
            )
            .unwrap()["id"],
            "resource-om"
        );
        db.with_conn(|conn| {
            conn.execute("DELETE FROM projects WHERE id='p1'", [])?;
            Ok(())
        })
        .unwrap();
        let count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM mastra_observational_memory WHERE resource_id='r1'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn sql_has_no_replace_statement() {
        let forbidden = ["re", "place"].concat();
        let sql_is_clean = |source: &str| {
            !source
                .split("#[cfg(test)]")
                .next()
                .unwrap_or(source)
                .to_ascii_lowercase()
                .contains(&forbidden)
        };
        assert!(sql_is_clean(include_str!("mastra_memory.rs")));
        assert!(sql_is_clean(include_str!("chat_typed_writes.rs")));
    }

    #[test]
    fn thread_upsert_keeps_creation_time_and_rejects_cross_project_id() {
        let db = db();
        let save = |resource_id: &str, created_at: &str, title: &str| ThreadInput {
            id: "thread".into(),
            resource_id: resource_id.into(),
            title: Some(title.into()),
            created_at: Some(created_at.into()),
            updated_at: Some(CREATED.into()),
            metadata: None,
        };
        thread_write(
            &db,
            ThreadWriteCommand::Save {
                thread: save("r1", CREATED, "first"),
            },
        )
        .unwrap();
        thread_write(
            &db,
            ThreadWriteCommand::Save {
                thread: save("r1", "2026-11-02T00:00:00Z", "second"),
            },
        )
        .unwrap();
        let created_at: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT created_at FROM chat_sessions WHERE id='thread'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(created_at, CREATED);
        let error = thread_write(
            &db,
            ThreadWriteCommand::Save {
                thread: save("r2", CREATED, "wrong"),
            },
        )
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::ScopeMismatch)
        ));
    }

    #[test]
    fn thread_list_uses_id_to_break_created_at_ties_and_excludes_local_sessions() {
        let result = thread_read(
            &db(),
            ThreadReadCommand::List {
                resource_id: "r1".into(),
                page: None,
                per_page: None,
                order_by: None,
                metadata: None,
            },
        )
        .unwrap();
        let ids = result["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|thread| thread["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["s1", "s2"]);
    }

    #[test]
    fn message_save_skips_unsupported_and_injected_messages_and_preserves_identity() {
        let db = db();
        let mut signal = input("signal", "s1", "signal", "skip");
        let mut injected = input("injected", "s1", "user", "skip");
        injected.is_injected = true;
        let result = message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![signal.clone(), injected],
            },
        )
        .unwrap();
        assert_eq!(result["messages"].as_array().unwrap().len(), 0);
        signal = input("m1", "s1", "user", "first");
        message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![signal],
            },
        )
        .unwrap();
        message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![input("m1", "s1", "user", "changed")],
            },
        )
        .unwrap();
        let row: (String, String, String) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT session_id, role, created_at FROM chat_messages WHERE id='m1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .unwrap();
        assert_eq!(row, ("s1".into(), "user".into(), CREATED.into()));
        let error = message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![input("m1", "s2", "user", "collision")],
            },
        )
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::ScopeMismatch)
        ));
    }

    #[test]
    fn captured_message_save_updates_parts_without_changing_body() {
        let db = db();
        message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![input("captured", "s1", "user", "original")],
            },
        )
        .unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO nir1_generation_message_versions VALUES ('captured')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![input("captured", "s1", "user", "replacement")],
            },
        )
        .unwrap();
        let values: (String, String) = db.with_conn(|conn| Ok(conn.query_row(
            "SELECT m.content, p.parts_json FROM chat_messages m JOIN mastra_message_parts p ON p.message_id=m.id WHERE m.id='captured'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        )?)).unwrap();
        assert_eq!(values.0, "original");
        assert!(values.1.contains("replacement"));
    }

    #[test]
    fn message_reads_tie_break_by_id_and_never_expose_local_sessions() {
        let db = db();
        db.with_conn(|conn| { conn.execute("INSERT INTO chat_messages (id,session_id,role,content,created_at) VALUES ('private','nir1-local-private','user','secret',?1)", [CREATED])?; Ok(()) }).unwrap();
        message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![
                    input("z", "s1", "assistant", "z"),
                    input("a", "s1", "assistant", "a"),
                ],
            },
        )
        .unwrap();
        let result = message_read(
            &db,
            MessageReadCommand::List {
                thread_id: IdList::One("s1".into()),
                resource_id: None,
                page: None,
                per_page: None,
                order_by: None,
                date_range: None,
                metadata: None,
            },
        )
        .unwrap();
        let ids = result["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["a", "z"]);
        assert!(message_read(
            &db,
            MessageReadCommand::ById {
                message_ids: vec!["private".into()]
            }
        )
        .unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty());
        let collision = message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![input("private", "s1", "user", "overwrite")],
            },
        )
        .unwrap_err();
        assert!(matches!(
            collision.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::ScopeMismatch)
        ));
        let error = message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![input("private", "nir1-local-private", "user", "no")],
            },
        )
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<MemoryRefusal>(),
            Some(MemoryRefusal::ScopeMismatch)
        ));
    }

    #[test]
    fn delete_messages_groups_ids_and_refuses_pending_generation_atomically() {
        let db = db();
        message_write(
            &db,
            MessageWriteCommand::Save {
                messages: vec![
                    input("m1", "s1", "user", "one"),
                    input("m2", "s2", "user", "two"),
                ],
            },
        )
        .unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO nir1_generation_attempts VALUES ('s2', NULL)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let error = message_delete(
            &db,
            MessageDeleteRequest {
                message_ids: vec!["m1".into(), "m2".into()],
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .starts_with("CHAT_WRITE_REFUSED:generation-pending"));
        let remaining: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT count(*) FROM chat_messages", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(remaining, 2);
        db.with_conn(|conn| {
            conn.execute("UPDATE nir1_generation_attempts SET terminal_json='{}'", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            message_delete(
                &db,
                MessageDeleteRequest {
                    message_ids: vec!["m1".into(), "m2".into()]
                }
            )
            .unwrap()["deleted"],
            2
        );
    }
}
