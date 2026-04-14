//! get_project, get_project_stats tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;

use crate::db;
use crate::server::GrimodexServer;

pub async fn get_project(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let project = db::get_project(&conn, &server.project_id)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn get_project_stats(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let stats = db::get_project_stats(&conn, &server.project_id)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&stats)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
