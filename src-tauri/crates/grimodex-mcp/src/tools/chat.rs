//! list_chat_sessions, read_chat_history tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::Deserialize;

use crate::db;
use crate::server::GrimodexServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListChatSessionsParams {
    /// Filter by scene/node ID (optional). Omit to list all sessions.
    pub node_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadChatHistoryParams {
    /// Chat session ID (required).
    pub session_id: String,
    /// Return only anchor messages: all user messages + AI with Tier-2 signals.
    pub anchors_only: Option<bool>,
    /// Deprecated: use `anchors_only`. When true, maps to `anchors_only=true`.
    pub starred_only: Option<bool>,
    /// Maximum messages to return (1-200, default: 100).
    pub limit: Option<u32>,
}

pub async fn list_chat_sessions(
    server: &GrimodexServer,
    params: ListChatSessionsParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let sessions = db::list_chat_sessions(&conn, &server.project_id, params.node_id.as_deref())
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let json = serde_json::to_string_pretty(&sessions)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn read_chat_history(
    server: &GrimodexServer,
    params: ReadChatHistoryParams,
) -> Result<CallToolResult, ErrorData> {
    let mut anchors_only = params.anchors_only.unwrap_or(false);
    if params.starred_only.unwrap_or(false) {
        eprintln!(
            "read_chat_history: starred_only is deprecated; use anchors_only instead"
        );
        anchors_only = true;
    }
    let limit = params.limit.unwrap_or(100).clamp(1, 200);

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let messages = db::get_chat_messages(&conn, &params.session_id, anchors_only, limit)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let json = serde_json::to_string_pretty(&messages)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
