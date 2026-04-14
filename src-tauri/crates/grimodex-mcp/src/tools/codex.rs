//! list_codex_entries, get_codex_entry tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::Deserialize;

use crate::convert::prosemirror_to_markdown;
use crate::db::{self, CodexEntryFull, CodexFilter};
use crate::server::GrimodexServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListCodexParams {
    /// Filter by type slug (e.g. "character", "location", "item", "lore").
    pub type_slug: Option<String>,
    /// Filter by tag name (partial match).
    pub tag: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetCodexParams {
    /// Codex entry ID. Takes priority over name.
    pub entry_id: Option<String>,
    /// Partial name match. Used when entry_id is not provided.
    pub name: Option<String>,
}

pub async fn list_codex_entries(
    server: &GrimodexServer,
    params: ListCodexParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let filter = CodexFilter {
        type_slug: params.type_slug,
        tag: params.tag,
    };
    let entries = db::list_codex_entries(&conn, &server.project_id, &filter)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn get_codex_entry(
    server: &GrimodexServer,
    params: GetCodexParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let entries: Vec<CodexEntryFull> = if let Some(id) = &params.entry_id {
        vec![db::get_codex_entry_full(&conn, id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?]
    } else if let Some(name) = &params.name {
        let summaries = db::find_codex_by_name(&conn, &server.project_id, name)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        summaries
            .iter()
            .filter_map(|s| db::get_codex_entry_full(&conn, &s.id).ok())
            .collect()
    } else {
        return Err(ErrorData::invalid_params(
            "Provide either entry_id or name",
            None,
        ));
    };

    // Convert ProseMirror JSON content/notes to Markdown
    let entries: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|mut e| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&e.content) {
                e.content = prosemirror_to_markdown(&v);
            }
            if let Some(notes) = &e.notes {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(notes) {
                    e.notes = Some(prosemirror_to_markdown(&v));
                }
            }
            serde_json::to_value(e).unwrap_or(serde_json::Value::Null)
        })
        .collect();

    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
