//! Foreshadow tools: list_open_foreshadows, get_foreshadow_detail (read);
//! create_foreshadow, update_foreshadow (write, knowledgeWrite-gated).

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::server::GrimodexServer;

/// Allowed `load_bearing` values, identical to the canonical Tauri command and
/// `deriveLabel.ts`. An unknown value would silently degrade in the app, so it
/// is rejected at the MCP boundary. `None` (omitted) is allowed.
fn validate_load_bearing(value: Option<&str>) -> Result<(), ErrorData> {
    match value {
        None | Some("critical") | Some("supporting") | Some("optional") => Ok(()),
        Some(other) => Err(ErrorData::invalid_params(
            format!(
                "invalid load_bearing value: {other:?} (expected one of: critical, supporting, optional)"
            ),
            None,
        )),
    }
}

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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateForeshadowParams {
    /// Title of the foreshadowing item (required).
    pub title: String,
    /// Author intent: what this foreshadow is meant to set up / pay off (optional).
    pub intent: Option<String>,
    /// Freeform notes (optional).
    pub notes: Option<String>,
    /// Load-bearing weight: "critical" | "supporting" | "optional" (optional).
    pub load_bearing: Option<String>,
    /// Whether the item is secret (hidden from the open/unresolved list, like a
    /// concealed plant). Defaults to true to match the app; pass false to make
    /// it immediately visible via list_open_foreshadows.
    pub secret: Option<bool>,
}

#[derive(Debug, Serialize)]
struct CreateForeshadowResult {
    id: String,
    secret: bool,
    message: String,
}

pub async fn create_foreshadow(
    server: &GrimodexServer,
    params: CreateForeshadowParams,
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

    let title = params.title.trim();
    if title.is_empty() {
        return Err(ErrorData::invalid_params("title must not be empty", None));
    }
    validate_load_bearing(params.load_bearing.as_deref())?;
    let secret = params.secret.unwrap_or(true);

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let id = db::create_foreshadow(
        &conn,
        &server.project_id(),
        title,
        params.intent.as_deref(),
        params.notes.as_deref(),
        params.load_bearing.as_deref(),
        secret,
    )
    .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let result = CreateForeshadowResult {
        id: id.clone(),
        secret,
        message: format!("Foreshadow '{title}' created with id {id}"),
    };
    let json = serde_json::to_string_pretty(&result)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateForeshadowParams {
    /// ID of the foreshadow to update (required).
    pub id: String,
    /// New title (optional).
    pub title: Option<String>,
    /// New intent (optional).
    pub intent: Option<String>,
    /// New notes (optional).
    pub notes: Option<String>,
    /// New load-bearing weight: "critical" | "supporting" | "optional" (optional).
    pub load_bearing: Option<String>,
    /// Mark the payoff as confirmed/landed (optional).
    pub payoff_confirmed: Option<bool>,
    /// Mark the item as abandoned (optional).
    pub abandoned: Option<bool>,
    /// Toggle the secret flag (optional).
    pub secret: Option<bool>,
}

#[derive(Debug, Serialize)]
struct UpdateForeshadowResult {
    id: String,
    updated: bool,
    message: String,
}

pub async fn update_foreshadow(
    server: &GrimodexServer,
    params: UpdateForeshadowParams,
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

    let id = params.id.trim();
    if id.is_empty() {
        return Err(ErrorData::invalid_params("id must not be empty", None));
    }
    if params.title.is_none()
        && params.intent.is_none()
        && params.notes.is_none()
        && params.load_bearing.is_none()
        && params.payoff_confirmed.is_none()
        && params.abandoned.is_none()
        && params.secret.is_none()
    {
        return Err(ErrorData::invalid_params(
            "no fields provided to update",
            None,
        ));
    }
    validate_load_bearing(params.load_bearing.as_deref())?;

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let affected = db::update_foreshadow(
        &conn,
        &server.project_id(),
        id,
        params.title.as_deref(),
        params.intent.as_deref(),
        params.notes.as_deref(),
        params.load_bearing.as_deref(),
        params.payoff_confirmed,
        params.abandoned,
        params.secret,
    )
    .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    if affected == 0 {
        return Err(ErrorData::invalid_params(
            "Foreshadow not found in this project",
            None,
        ));
    }

    let result = UpdateForeshadowResult {
        id: id.to_string(),
        updated: true,
        message: format!("Foreshadow {id} updated"),
    };
    let json = serde_json::to_string_pretty(&result)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[cfg(test)]
mod tests {
    use super::validate_load_bearing;

    #[test]
    fn validate_load_bearing_accepts_known_and_none() {
        assert!(validate_load_bearing(None).is_ok());
        assert!(validate_load_bearing(Some("critical")).is_ok());
        assert!(validate_load_bearing(Some("supporting")).is_ok());
        assert!(validate_load_bearing(Some("optional")).is_ok());
    }

    #[test]
    fn validate_load_bearing_rejects_unknown() {
        assert!(validate_load_bearing(Some("urgent")).is_err());
        assert!(validate_load_bearing(Some("")).is_err());
    }
}
