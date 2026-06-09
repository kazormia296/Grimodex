//! search_project tool – FTS5 横断検索.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::Deserialize;

use crate::db;
use crate::server::{internal_err, GrimodexServer};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchProjectParams {
    /// Search query string (max 500 characters, max 3 wildcards '*').
    pub query: String,
    /// Scope to search: "all" (default), "scenes", "codex", "snippets", "chat".
    pub scope: Option<String>,
    /// Maximum number of results per category (1-50, default 20).
    pub limit: Option<u32>,
}

pub async fn search_project(
    server: &GrimodexServer,
    params: SearchProjectParams,
) -> Result<CallToolResult, ErrorData> {
    let scope = params.scope.as_deref().unwrap_or("all");
    let valid_scopes = ["all", "scenes", "codex", "snippets", "chat"];
    if !valid_scopes.contains(&scope) {
        return Err(ErrorData::invalid_params(
            format!(
                "Invalid scope '{}'. Valid values: {}",
                scope,
                valid_scopes.join(", ")
            ),
            None,
        ));
    }

    db::validate_fts_query(&params.query)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;

    let limit = params.limit.unwrap_or(20).clamp(1, 50);

    let conn = server.conn.lock().map_err(internal_err)?;

    let results = db::search_fts(&conn, &server.project_id(), &params.query, scope, limit)
        .map_err(internal_err)?;

    let json = serde_json::to_string_pretty(&results).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
