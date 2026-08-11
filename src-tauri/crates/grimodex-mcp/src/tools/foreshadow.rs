//! Foreshadow tools: list_open_foreshadows, get_foreshadow_detail (read);
//! create_foreshadow, update_foreshadow (write, knowledgeWrite-gated).

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::server::{internal_err, GrimodexServer};

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
    let conn = server.conn.lock().map_err(internal_err)?;
    let rows = db::list_open_foreshadows(&conn, &server.project_id()).map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&rows).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
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
        return Ok(CallToolResult::success(vec![
            rmcp::model::ContentBlock::text(json),
        ]));
    }

    let conn = server.conn.lock().map_err(internal_err)?;
    let detail =
        db::get_foreshadow_detail(&conn, &server.project_id(), id).map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&detail).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
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
    version: i64,
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
    server.ensure_license_allows_write()?;
    let policy = server.reload_policy()?;
    if !policy.knowledge_write {
        return Err(ErrorData::invalid_params(
            "knowledgeWrite policy is off for this project",
            None,
        ));
    }

    // Sanitize the same way codex/snippet writes do (strip control chars, cap
    // length). foreshadow writes previously passed these straight through, so a
    // prompt-injected client could store a 50 MB blob or embedded NUL/C0 chars.
    let title = crate::sanitize::sanitize_name(&params.title)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let intent = params
        .intent
        .as_deref()
        .map(crate::sanitize::sanitize_freetext)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let notes = params
        .notes
        .as_deref()
        .map(crate::sanitize::sanitize_freetext)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    validate_load_bearing(params.load_bearing.as_deref())?;
    let secret = params.secret.unwrap_or(true);

    // Tracked write: one tx = entity row + undo_journal(surface='mcp') +
    // change_event(domain 'foreshadow'), closing the last untracked AI write.
    let id = uuid::Uuid::new_v4().to_string();
    let conn = server.conn.lock().map_err(internal_err)?;
    let write = grimodex_core::writes::foreshadow::tracked_foreshadow_create(
        &conn,
        grimodex_core::writes::foreshadow::TrackedForeshadowCreateInput {
            project_id: &server.project_id(),
            session_id: &server.session_id,
            surface: "mcp",
            foreshadow_id: &id,
            title: &title,
            intent: intent.as_deref(),
            notes: notes.as_deref(),
            load_bearing: params.load_bearing.as_deref(),
            secret,
            request_id: None,
            request_hash: None,
        },
    )
    .map_err(internal_err)?;

    let result = CreateForeshadowResult {
        id: id.clone(),
        version: write.version,
        secret,
        message: format!("Foreshadow '{title}' created with id {id}"),
    };
    let json = serde_json::to_string_pretty(&result).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateForeshadowParams {
    /// ID of the foreshadow to update (required).
    pub id: String,
    /// Version returned by create/list/detail/the previous update.
    pub base_version: i64,
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
    version: i64,
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
    server.ensure_license_allows_write()?;
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
    if params.base_version < 0 {
        return Err(ErrorData::invalid_params(
            "base_version must be non-negative",
            None,
        ));
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

    // Same sanitization as create_foreshadow for any provided text field.
    let title = params
        .title
        .as_deref()
        .map(crate::sanitize::sanitize_name)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let intent = params
        .intent
        .as_deref()
        .map(crate::sanitize::sanitize_freetext)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let notes = params
        .notes
        .as_deref()
        .map(crate::sanitize::sanitize_freetext)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;

    let conn = server.conn.lock().map_err(internal_err)?;
    let result = grimodex_core::writes::foreshadow::tracked_foreshadow_update_at_version(
        &conn,
        grimodex_core::writes::foreshadow::TrackedForeshadowUpdateInput {
            project_id: &server.project_id(),
            session_id: &server.session_id,
            surface: "mcp",
            foreshadow_id: id,
            patch: grimodex_core::writes::foreshadow::ForeshadowPatch {
                title: title.as_deref(),
                intent: intent.as_deref(),
                notes: notes.as_deref(),
                load_bearing: params.load_bearing.as_deref(),
                payoff_confirmed: params.payoff_confirmed,
                abandoned: params.abandoned,
                secret: params.secret,
            },
        },
        params.base_version,
    )
    .map_err(internal_err)?;

    let write = result
        .ok_or_else(|| ErrorData::invalid_params("Foreshadow not found in this project", None))?;

    let result = UpdateForeshadowResult {
        id: id.to_string(),
        version: write.version,
        updated: true,
        message: format!("Foreshadow {id} updated"),
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

    /// Writable server over the shared fixture. NULL ai_policy → fail-open
    /// full toggles (knowledge_write on), licensing feature off in tests.
    fn make_writable_server() -> GrimodexServer {
        let conn = make_simple_db();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p1', 'Novel')",
            [],
        )
        .unwrap();
        let policy = grimodex_core::policy::load_policy(&conn, "p1").unwrap();
        GrimodexServer::new(
            conn,
            "p1".to_string(),
            false,
            false,
            "sess-mcp".to_string(),
            policy,
        )
    }

    #[tokio::test]
    async fn create_foreshadow_tool_is_tracked() {
        let server = make_writable_server();
        create_foreshadow(
            &server,
            CreateForeshadowParams {
                title: "Planted clue".to_string(),
                intent: Some("sets up the reveal".to_string()),
                notes: None,
                load_bearing: Some("critical".to_string()),
                secret: Some(false),
            },
        )
        .await
        .unwrap();

        let conn = server.conn.lock().unwrap();
        // Entity row landed.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM foreshadows", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        // Tracked: change_event with the MCP session, journal with surface=mcp.
        let (domain, op_type, session_id): (String, String, String) = conn
            .query_row(
                "SELECT domain, op_type, session_id FROM change_events",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(domain, "foreshadow");
        assert_eq!(op_type, "foreshadow.create");
        assert_eq!(session_id, "sess-mcp");
        let surface: String = conn
            .query_row("SELECT surface FROM undo_journal", [], |r| r.get(0))
            .unwrap();
        assert_eq!(surface, "mcp");
    }

    #[tokio::test]
    async fn update_foreshadow_tool_is_tracked() {
        let server = make_writable_server();
        {
            let conn = server.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO foreshadows
                 (id, project_id, title, secret, created_at, updated_at)
                 VALUES ('f1', 'p1', 'Original', 1, 1000, 1000)",
                [],
            )
            .unwrap();
        }

        update_foreshadow(
            &server,
            UpdateForeshadowParams {
                id: "f1".to_string(),
                base_version: 0,
                title: Some("Renamed".to_string()),
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
        )
        .await
        .unwrap();

        let conn = server.conn.lock().unwrap();
        let title: String = conn
            .query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Renamed");
        let op_type: String = conn
            .query_row("SELECT op_type FROM change_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(op_type, "foreshadow.update");
    }

    #[tokio::test]
    async fn update_foreshadow_tool_rejects_stale_base_without_mutation() {
        let server = make_writable_server();
        {
            let conn = server.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO foreshadows
                 (id, project_id, title, secret, created_at, updated_at)
                 VALUES ('f-stale', 'p1', 'Original', 1, 1000, 1000)",
                [],
            )
            .unwrap();
        }

        let params = |title: &str| UpdateForeshadowParams {
            id: "f-stale".to_string(),
            base_version: 0,
            title: Some(title.to_string()),
            intent: None,
            notes: None,
            load_bearing: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
        };
        update_foreshadow(&server, params("Fresh"))
            .await
            .expect("first writer succeeds");
        let stale = update_foreshadow(&server, params("Stale")).await;
        assert!(stale.is_err(), "stale writer must be rejected");

        let conn = server.conn.lock().unwrap();
        let (title, version): (String, i64) = conn
            .query_row(
                "SELECT title, version FROM foreshadows WHERE id = 'f-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Fresh");
        assert_eq!(version, 1);
        let change_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))
            .unwrap();
        let journal_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))
            .unwrap();
        assert_eq!(change_count, 1);
        assert_eq!(journal_count, 1);
    }

    #[tokio::test]
    async fn update_foreshadow_tool_unknown_id_writes_nothing() {
        let server = make_writable_server();
        let res = update_foreshadow(
            &server,
            UpdateForeshadowParams {
                id: "ghost".to_string(),
                base_version: 0,
                title: Some("X".to_string()),
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
        )
        .await;
        assert!(res.is_err());
        let conn = server.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
