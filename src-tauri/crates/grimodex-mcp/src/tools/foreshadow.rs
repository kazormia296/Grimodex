//! Foreshadow tools: list_open_foreshadows, get_foreshadow_detail (read);
//! create_foreshadow, update_foreshadow (write, knowledgeWrite-gated).

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::server::{internal_err, GrimodexServer};

const SECRET_ERROR: &str =
    "secret is no longer supported: foreshadows cannot be hidden from the AI";

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListOpenForeshadowsParams {
    /// Include settled (payoff-confirmed) foreshadowing items, each marked `settled: true`. Abandoned items are never included. Omitted or false returns unresolved items only.
    pub include_settled: Option<bool>,
}

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

pub async fn list_open_foreshadows(
    server: &GrimodexServer,
    params: ListOpenForeshadowsParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let rows = db::list_open_foreshadows(
        &conn,
        &server.project_id(),
        params.include_settled.unwrap_or(false),
    )
    .map_err(internal_err)?;
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
    /// Stable logical request id. Reuse it only when retrying this create.
    pub request_id: String,
    /// Title of the foreshadowing item (required).
    pub title: String,
    /// Author intent: what this foreshadow is meant to set up / pay off (optional).
    pub intent: Option<String>,
    /// Freeform notes (optional).
    pub notes: Option<String>,
    /// Load-bearing weight: "critical" | "supporting" | "optional" (optional).
    pub load_bearing: Option<String>,
    /// Retired compatibility input. `true` is rejected; `false` and omission
    /// create a visible item. This field is not published in the JSON schema.
    #[serde(default)]
    #[schemars(skip)]
    pub secret: Option<bool>,
}

#[derive(Debug, Serialize)]
struct CreateForeshadowResult {
    id: String,
    version: i64,
    message: String,
}

pub async fn create_foreshadow(
    server: &GrimodexServer,
    params: CreateForeshadowParams,
) -> Result<CallToolResult, ErrorData> {
    if params.secret == Some(true) {
        return Err(ErrorData::invalid_params(SECRET_ERROR, None));
    }
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

    // Tracked write: one tx = entity row + undo_journal(surface='mcp') +
    // change_event(domain 'foreshadow'), closing the last untracked AI write.
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let write = grimodex_db::agent_writes::agent_foreshadow_create_with_surface_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentForeshadowCreatePayload {
            request_id: request_id.to_string(),
            foreshadow_id: None,
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            title: title.clone(),
            intent,
            notes,
            load_bearing: params.load_bearing,
            secret: false,
        },
        "mcp",
    )
    .map_err(internal_err)?;
    let id = write["entityId"]
        .as_str()
        .ok_or_else(|| internal_err("Foreshadow writer returned no entityId"))?
        .to_string();

    let result = CreateForeshadowResult {
        id: id.clone(),
        version: write["version"]
            .as_i64()
            .ok_or_else(|| internal_err("Foreshadow writer returned no version"))?,
        message: format!("Foreshadow '{title}' created with id {id}"),
    };
    let json = serde_json::to_string_pretty(&result).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateForeshadowParams {
    /// Stable logical request id. Reuse it only when retrying this update.
    pub request_id: String,
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
    /// Retired compatibility input. Any provided boolean (`true` or `false`)
    /// is rejected; JSON `null` is read as omission. This field is not
    /// published in the JSON schema.
    #[serde(default)]
    #[schemars(skip)]
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
    if params.secret.is_some() {
        return Err(ErrorData::invalid_params(SECRET_ERROR, None));
    }
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

    let id = params.id.trim().to_string();
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

    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let write = grimodex_db::agent_writes::agent_foreshadow_update_with_request_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentForeshadowUpdatePayload {
            request_id: request_id.to_string(),
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            foreshadow_id: id.clone(),
            base_version: params.base_version,
            title,
            intent,
            notes,
            load_bearing: params.load_bearing,
            payoff_confirmed: params.payoff_confirmed,
            abandoned: params.abandoned,
            secret: None,
        },
        request_id,
        "mcp",
    )
    .map_err(internal_err)?;

    let result = UpdateForeshadowResult {
        id: id.to_string(),
        version: write["version"]
            .as_i64()
            .ok_or_else(|| internal_err("Foreshadow writer returned no version"))?,
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
    use rusqlite::params;

    fn result_json(res: &CallToolResult) -> serde_json::Value {
        let value = serde_json::to_value(res).unwrap();
        let text = value["content"][0]["text"].as_str().expect("text content");
        serde_json::from_str(text).expect("valid JSON payload")
    }

    #[test]
    fn list_open_foreshadows_params_schema_publishes_include_settled() {
        let schema =
            serde_json::to_value(schemars::schema_for!(ListOpenForeshadowsParams)).unwrap();
        assert!(schema["properties"]
            .as_object()
            .unwrap()
            .contains_key("include_settled"));
    }

    #[tokio::test]
    async fn list_open_foreshadows_accepts_omitted_false_and_true_arguments() {
        let server = make_writable_server();
        {
            let conn = server.conn.lock().unwrap();
            for (id, title, payoff_confirmed, abandoned) in [
                ("f-open", "Open", 0, 0),
                ("f-settled", "Settled", 1, 0),
                ("f-abandoned", "Abandoned", 0, 1),
            ] {
                conn.execute(
                    "INSERT INTO foreshadows
                     (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
                     VALUES (?1, 'p1', ?2, ?3, ?4, 1, 1000, 1000)",
                    params![id, title, payoff_confirmed, abandoned],
                )
                .unwrap();
            }
        }

        let omitted: ListOpenForeshadowsParams =
            serde_json::from_value(serde_json::json!({})).expect("empty arguments are valid");
        let omitted = list_open_foreshadows(&server, omitted).await.unwrap();
        let omitted = result_json(&omitted);
        assert_eq!(omitted.as_array().unwrap().len(), 1);
        assert_eq!(omitted[0]["id"], "f-open");
        assert!(omitted[0].get("settled").is_none());

        let unresolved = list_open_foreshadows(
            &server,
            ListOpenForeshadowsParams {
                include_settled: Some(false),
            },
        )
        .await
        .unwrap();
        let unresolved = result_json(&unresolved);
        assert_eq!(unresolved.as_array().unwrap().len(), 1);
        assert_eq!(unresolved[0]["id"], "f-open");

        let included = list_open_foreshadows(
            &server,
            ListOpenForeshadowsParams {
                include_settled: Some(true),
            },
        )
        .await
        .unwrap();
        let included = result_json(&included);
        assert_eq!(included.as_array().unwrap().len(), 2);
        let settled = included
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "f-settled")
            .expect("settled row is included");
        assert_eq!(settled["settled"], true);
        assert!(!included
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "f-abandoned"));
    }

    #[test]
    fn secret_compatibility_inputs_are_hidden_from_param_schemas() {
        for schema in [
            serde_json::to_value(schemars::schema_for!(CreateForeshadowParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(UpdateForeshadowParams)).unwrap(),
        ] {
            let properties = schema
                .get("properties")
                .and_then(serde_json::Value::as_object)
                .expect("parameter schema properties");
            assert!(!properties.contains_key("secret"));
        }
    }

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

    fn seed_foreshadow(server: &GrimodexServer, id: &str, title: &str) {
        let conn = server.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, secret, created_at, updated_at)
             VALUES (?1, 'p1', ?2, 1, 1000, 1000)",
            params![id, title],
        )
        .unwrap();
        for field_path in [
            "/title",
            "/intent",
            "/notes",
            "/loadBearing",
            "/payoffConfirmed",
            "/abandoned",
            "/secret",
        ] {
            conn.execute(
                "INSERT INTO narrative_field_authority
                    (project_id, entity_kind, entity_id, field_path, owner_kind, updated_at)
                 VALUES ('p1', 'foreshadow', ?1, ?2, 'ai', datetime('now'))",
                params![id, field_path],
            )
            .unwrap();
        }
    }

    #[tokio::test]
    async fn create_foreshadow_tool_is_tracked() {
        let server = make_writable_server();
        create_foreshadow(
            &server,
            CreateForeshadowParams {
                request_id: uuid::Uuid::new_v4().to_string(),
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
        let secret: i64 = conn
            .query_row("SELECT secret FROM foreshadows", [], |r| r.get(0))
            .unwrap();
        assert_eq!(secret, 0);
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
    async fn create_foreshadow_defaults_secret_to_false() {
        let server = make_writable_server();
        create_foreshadow(
            &server,
            CreateForeshadowParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Visible by default".to_string(),
                intent: None,
                notes: None,
                load_bearing: None,
                secret: None,
            },
        )
        .await
        .expect("secret-free create succeeds");

        let conn = server.conn.lock().unwrap();
        let secret: i64 = conn
            .query_row("SELECT secret FROM foreshadows", [], |r| r.get(0))
            .unwrap();
        assert_eq!(secret, 0);
    }

    #[tokio::test]
    async fn create_foreshadow_rejects_secret_true_without_writes() {
        let server = make_writable_server();
        let error = create_foreshadow(
            &server,
            CreateForeshadowParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Rejected secret".to_string(),
                intent: None,
                notes: None,
                load_bearing: None,
                secret: Some(true),
            },
        )
        .await
        .expect_err("MCP cannot create a secret foreshadow");
        assert_eq!(error.message, SECRET_ERROR);

        let conn = server.conn.lock().unwrap();
        for table in ["foreshadows", "change_events", "undo_journal"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} must not be written");
        }
    }

    #[tokio::test]
    async fn update_foreshadow_tool_is_tracked() {
        let server = make_writable_server();
        seed_foreshadow(&server, "f1", "Original");

        update_foreshadow(
            &server,
            UpdateForeshadowParams {
                request_id: uuid::Uuid::new_v4().to_string(),
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
        seed_foreshadow(&server, "f-stale", "Original");

        let params = |title: &str| UpdateForeshadowParams {
            request_id: uuid::Uuid::new_v4().to_string(),
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
                request_id: uuid::Uuid::new_v4().to_string(),
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

    #[tokio::test]
    async fn update_foreshadow_rejects_secret_only_before_empty_patch_validation() {
        for secret in [Some(true), Some(false)] {
            let server = make_writable_server();
            seed_foreshadow(&server, "f-secret", "Original");

            let error = update_foreshadow(
                &server,
                UpdateForeshadowParams {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    id: "f-secret".to_string(),
                    base_version: 0,
                    title: None,
                    intent: None,
                    notes: None,
                    load_bearing: None,
                    payoff_confirmed: None,
                    abandoned: None,
                    secret,
                },
            )
            .await
            .expect_err("MCP cannot update the retired secret field");
            assert_eq!(error.message, SECRET_ERROR);

            let conn = server.conn.lock().unwrap();
            let (version, secret): (i64, i64) = conn
                .query_row(
                    "SELECT version, secret FROM foreshadows WHERE id = 'f-secret'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(version, 0);
            assert_eq!(secret, 1);
            let changes: i64 = conn
                .query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))
                .unwrap();
            let journals: i64 = conn
                .query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))
                .unwrap();
            assert_eq!(changes, 0);
            assert_eq!(journals, 0);
        }
    }
}
