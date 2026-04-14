//! list_snippets tool.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::convert::prosemirror_to_markdown;
use crate::db;
use crate::server::GrimodexServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListSnippetsParams {
    /// Filter by tag name (partial match). Omit to list all snippets.
    pub tag: Option<String>,
    /// Maximum snippets to return (1-100, default: 50).
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
struct SnippetResult {
    id: String,
    title: String,
    content: String,
    tags_cache: Option<String>,
    scene_id: Option<String>,
    usage_count: i64,
    created_at: String,
    updated_at: String,
}

pub async fn list_snippets(
    server: &GrimodexServer,
    params: ListSnippetsParams,
) -> Result<CallToolResult, ErrorData> {
    let limit = params.limit.unwrap_or(50).clamp(1, 100);

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let raw = db::list_snippets(&conn, &server.project_id, params.tag.as_deref(), limit)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    drop(conn);

    let results: Vec<SnippetResult> = raw
        .into_iter()
        .map(|s| {
            let content = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s.content) {
                prosemirror_to_markdown(&v)
            } else {
                s.content
            };
            SnippetResult {
                id: s.id,
                title: s.title,
                content,
                tags_cache: s.tags_cache,
                scene_id: s.scene_id,
                usage_count: s.usage_count,
                created_at: s.created_at,
                updated_at: s.updated_at,
            }
        })
        .collect();

    let json = serde_json::to_string_pretty(&results)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
