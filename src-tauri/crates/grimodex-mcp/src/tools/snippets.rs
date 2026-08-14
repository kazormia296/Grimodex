//! list_snippets, create_snippet tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::convert::prosemirror_to_markdown;
use crate::db;
use crate::sanitize;
use crate::server::{internal_err, GrimodexServer};

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

    let conn = server.conn.lock().map_err(internal_err)?;

    let raw = db::list_snippets(&conn, &server.project_id(), params.tag.as_deref(), limit)
        .map_err(internal_err)?;

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

    let json = serde_json::to_string_pretty(&results).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateSnippetParams {
    /// Stable logical request id. Reuse it only when retrying the same write.
    pub request_id: String,
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
    server.ensure_license_allows_write()?;
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
    let content_text_len = grimodex_core::pm_text::pm_doc_text_len(&content_pm);
    let spans = if content_text_len > 0 {
        vec![grimodex_db::agent_writes::AuthorshipSpanInput {
            from_pos: 0,
            to_pos: content_text_len,
            source: "ai".to_string(),
            model: Some(grimodex_core::writes::LANE_CONTENT_MODEL.to_string()),
            chat_msg_id: None,
            trace_id: None,
        }]
    } else {
        vec![]
    };

    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let write = grimodex_db::agent_writes::agent_snippet_create_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentSnippetCreatePayload {
            request_id: Some(request_id.to_string()),
            snippet_id: Some(snippet_id),
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            title: title.clone(),
            content: Some(content_pm),
            scene_id: params.scene_id,
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: spans,
        },
    )
    .map_err(internal_err)?;
    let snippet_id = write["entityId"]
        .as_str()
        .ok_or_else(|| internal_err("Snippet writer returned no entityId"))?
        .to_string();

    let result = CreateSnippetResult {
        id: snippet_id,
        title,
    };
    let json = serde_json::to_string_pretty(&result).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::make_simple_db;
    use crate::server::GrimodexServer;

    fn make_writable_server() -> GrimodexServer {
        let conn = make_simple_db();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p1', 'Novel')",
            [],
        )
        .expect("seed MCP project");
        let policy = grimodex_core::policy::load_policy(&conn, "p1").expect("load writable policy");
        GrimodexServer::new(
            conn,
            "p1".to_string(),
            false,
            false,
            "snippet-mcp-session".to_string(),
            policy,
        )
    }

    #[tokio::test]
    async fn create_snippet_is_idempotent_and_appends_the_feed_on_mcp_surface() {
        let server = make_writable_server();
        let request_id = "mcp-snippet-create-1";
        for _ in 0..2 {
            create_snippet(
                &server,
                CreateSnippetParams {
                    request_id: request_id.to_string(),
                    title: "Clue".to_string(),
                    content: Some("The brass key.".to_string()),
                    scene_id: None,
                },
            )
            .await
            .expect("create/retry Snippet");
        }

        let conn = server.conn.lock().expect("lock MCP database");
        let counts: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM snippets WHERE project_id = 'p1'),
                    (SELECT COUNT(*) FROM undo_journal
                      WHERE project_id = 'p1' AND id = ?1),
                    (SELECT COUNT(*) FROM narrative_change_transactions
                      WHERE project_id = 'p1' AND request_id = ?1
                        AND origin = 'ai-apply'),
                    (SELECT COUNT(*) FROM narrative_change_events event
                      JOIN narrative_change_transactions tx
                        ON tx.project_id = event.project_id
                       AND tx.id = event.transaction_id
                      WHERE tx.request_id = ?1)",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("query canonical Snippet ledgers");
        assert_eq!(counts, (1, 1, 1, 1));
    }
}
