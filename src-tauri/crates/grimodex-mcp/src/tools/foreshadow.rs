//! list_open_foreshadows, get_foreshadow_detail tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::Deserialize;

use crate::db;
use crate::server::GrimodexServer;

pub async fn list_open_foreshadows(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let rows = db::list_open_foreshadows(&conn, &server.project_id())
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&rows)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetForeshadowDetailParams {
    /// Foreshadow register item ID.
    pub id: String,
}

pub async fn get_foreshadow_detail(
    server: &GrimodexServer,
    params: GetForeshadowDetailParams,
) -> Result<CallToolResult, ErrorData> {
    let id = params.id.trim();
    if id.is_empty() {
        let json = "null".to_string();
        return Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json,
        )]));
    }

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let detail = db::get_foreshadow_detail(&conn, &server.project_id(), id)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&detail)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
