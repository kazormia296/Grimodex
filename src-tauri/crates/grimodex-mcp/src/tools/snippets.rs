//! list_snippets, create_snippet tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::convert::prosemirror_to_markdown;
use crate::db;
use crate::sanitize;
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateSnippetParams {
    pub title: String,
    /// Optional plain Markdown body (converted to ProseMirror JSON).
    pub content: Option<String>,
    pub scene_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateSnippetResult {
    id: String,
    title: String,
}

pub async fn create_snippet(
    server: &GrimodexServer,
    params: CreateSnippetParams,
) -> Result<CallToolResult, ErrorData> {
    if server.readonly {
        return Err(ErrorData::invalid_params(
            "Server is running in readonly mode; write tools are disabled",
            None,
        ));
    }
    let policy = server.reload_policy()?;
    if !policy.knowledge_write {
        return Err(ErrorData::invalid_params(
            "knowledgeWrite policy is off for this project",
            None,
        ));
    }

    let title = sanitize::sanitize_name(&params.title)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let content_pm = if let Some(md) = &params.content {
        sanitize::validate_content_size(md)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        sanitize::markdown_to_prosemirror(md)
    } else {
        r#"{"type":"doc","content":[]}"#.to_string()
    };

    let snippet_id = uuid::Uuid::new_v4().to_string();
    let spans = if content_pm.len() > 2 {
        vec![grimodex_core::writes::codex::AuthorshipSpanInput {
            from_pos: 0,
            to_pos: content_pm.len() as i64,
            source: "ai".to_string(),
            model: Some(grimodex_core::writes::LANE_CONTENT_MODEL.to_string()),
            chat_msg_id: None,
            trace_id: None,
            lane: Some("content".to_string()),
        }]
    } else {
        vec![]
    };

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    grimodex_core::writes::snippet::tracked_snippet_create(
        &conn,
        grimodex_core::writes::snippet::TrackedSnippetCreateInput {
            project_id: &server.project_id,
            session_id: &server.session_id,
            surface: "mcp",
            snippet_id: &snippet_id,
            title: &title,
            content: &content_pm,
            scene_id: params.scene_id.as_deref(),
            source_chat_message_id: None,
            authorship_spans: &spans,
        },
    )
    .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let result = CreateSnippetResult {
        id: snippet_id,
        title,
    };
    let json = serde_json::to_string_pretty(&result)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
