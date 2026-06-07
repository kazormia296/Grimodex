//! get_project, get_project_stats, list_projects, select_project tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use serde::Deserialize;

use crate::db;
use crate::server::GrimodexServer;

pub async fn get_project(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let pid = server.project_id();
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let project = db::get_project(&conn, &pid)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn get_project_stats(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let pid = server.project_id();
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let stats = db::get_project_stats(&conn, &pid)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&stats)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

/// List projects. In pinned mode (default) returns only the bound project so
/// it never leaks other projects' ids/titles across the pin boundary (XPROJ).
/// With --all-projects, enumerates the whole workspace.
pub async fn list_projects(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let summaries = if server.all_projects {
        db::list_all_projects(&conn).map_err(|e| ErrorData::internal_error(e.to_string(), None))?
    } else {
        let pid = server.project_id();
        match db::fetch_project_title(&conn, &pid)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
        {
            Some(title) => vec![db::ProjectSummary { id: pid, title }],
            None => vec![],
        }
    };
    let json = serde_json::to_string_pretty(&summaries)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SelectProjectParams {
    /// The project id to switch to. Must exist in this workspace.
    pub project_id: String,
}

/// Switch the active project. Rejected in pinned mode (the single enforcement
/// point for the per-connection scope guarantee). In --all-projects mode the
/// target id is validated against the `projects` table before switching.
pub async fn select_project(
    server: &GrimodexServer,
    params: SelectProjectParams,
) -> Result<CallToolResult, ErrorData> {
    if !server.all_projects {
        return Err(ErrorData::invalid_params(
            format!(
                "server is pinned to a single project ({}); start it with --all-projects to enable switching",
                server.project_id()
            ),
            None,
        ));
    }
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let title = db::fetch_project_title(&conn, &params.project_id)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
        .ok_or_else(|| {
            ErrorData::invalid_params(format!("no such project: {}", params.project_id), None)
        })?;
    drop(conn);
    server.set_current_project(params.project_id.clone());
    let body = serde_json::json!({ "selected": params.project_id, "title": title });
    let json = serde_json::to_string_pretty(&body)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::GrimodexServer;
    use rusqlite::Connection;

    /// Two-project in-memory DB + a server. `select_project`/`list_projects`
    /// only touch the `projects` table, so a minimal schema suffices.
    fn make_server(all_projects: bool) -> GrimodexServer {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                ai_policy TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO projects (id, title) VALUES ('p1', 'Novel A');
            INSERT INTO projects (id, title) VALUES ('p2', 'Novel B');",
        )
        .unwrap();
        let policy = grimodex_core::policy::load_policy(&conn, "p1").unwrap();
        GrimodexServer::new(
            conn,
            "p1".to_string(),
            all_projects,
            true,
            "sess".to_string(),
            policy,
        )
    }

    // The single security guarantee: pinned mode refuses to switch projects,
    // so the per-connection scope stays fixed (XPROJ defense not regressed).
    #[tokio::test]
    async fn select_project_rejected_when_pinned() {
        let server = make_server(false);
        let res = select_project(
            &server,
            SelectProjectParams {
                project_id: "p2".to_string(),
            },
        )
        .await;
        assert!(res.is_err());
        assert_eq!(server.project_id(), "p1"); // current unchanged
    }

    #[tokio::test]
    async fn select_project_switches_in_all_projects_mode() {
        let server = make_server(true);
        let res = select_project(
            &server,
            SelectProjectParams {
                project_id: "p2".to_string(),
            },
        )
        .await;
        assert!(res.is_ok());
        assert_eq!(server.project_id(), "p2");
    }

    #[tokio::test]
    async fn select_project_unknown_id_rejected() {
        let server = make_server(true);
        let res = select_project(
            &server,
            SelectProjectParams {
                project_id: "ghost".to_string(),
            },
        )
        .await;
        assert!(res.is_err());
        assert_eq!(server.project_id(), "p1"); // unchanged on invalid target
    }
}
