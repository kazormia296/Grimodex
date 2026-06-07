//! get_attribution_report tool.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::Deserialize;

use crate::db;
use crate::server::GrimodexServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetAttributionReportParams {
    /// Limit report to a single scene by ID. Omit for project-wide report.
    pub scene_id: Option<String>,
}

pub async fn get_attribution_report(
    server: &GrimodexServer,
    params: GetAttributionReportParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let report = db::get_attribution_report(&conn, &server.project_id(), params.scene_id.as_deref())
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let json = serde_json::to_string_pretty(&report)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
