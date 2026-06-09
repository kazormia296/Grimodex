//! read_scene, read_scenes_batch tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use rusqlite::Connection;

use crate::convert::prosemirror_to_markdown;
use crate::db::{self, TreeFilter, TreeNode};
use crate::server::{internal_err, GrimodexServer};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadSceneParams {
    /// Scene ID (UUID). Takes priority over title.
    pub scene_id: Option<String>,
    /// Partial title match (LIKE search). Used when scene_id is not provided.
    pub title: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadScenesBatchParams {
    /// List of scene IDs to read (max 50).
    pub scene_ids: Option<Vec<String>>,
    /// Read all scenes under this parent folder ID.
    pub parent_id: Option<String>,
    /// Filter by status ("outline", "draft", "revised", "final").
    pub status: Option<String>,
}

#[derive(Debug, Serialize)]
struct SceneResult {
    id: String,
    title: String,
    synopsis: Option<String>,
    status: Option<String>,
    parent_id: Option<String>,
    sort_order: String,
    created_at: String,
    updated_at: String,
    content: String,
}

fn load_scene(conn: &Connection, node: &TreeNode) -> SceneResult {
    let content = match db::get_scene_content(conn, &node.project_id, &node.id) {
        Ok(raw) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                prosemirror_to_markdown(&v)
            } else {
                raw // plain text fallback
            }
        }
        Err(_) => String::new(),
    };
    SceneResult {
        id: node.id.clone(),
        title: node.title.clone(),
        synopsis: node.synopsis.clone(),
        status: node.status.clone(),
        parent_id: node.parent_id.clone(),
        sort_order: node.sort_order.clone(),
        created_at: node.created_at.clone(),
        updated_at: node.updated_at.clone(),
        content,
    }
}

pub async fn read_scene(
    server: &GrimodexServer,
    params: ReadSceneParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;

    let nodes: Vec<TreeNode> = if let Some(id) = &params.scene_id {
        vec![db::get_scene_meta(&conn, &server.project_id(), id).map_err(internal_err)?]
    } else if let Some(title) = &params.title {
        db::find_scene_by_title(&conn, &server.project_id(), title).map_err(internal_err)?
    } else {
        return Err(ErrorData::invalid_params(
            "Provide either scene_id or title",
            None,
        ));
    };

    let results: Vec<SceneResult> = nodes.iter().map(|n| load_scene(&conn, n)).collect();
    drop(conn);

    let json = serde_json::to_string_pretty(&results).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn read_scenes_batch(
    server: &GrimodexServer,
    params: ReadScenesBatchParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;

    let nodes: Vec<TreeNode> = if let Some(ids) = &params.scene_ids {
        let ids: Vec<String> = ids.iter().take(50).cloned().collect();
        ids.iter()
            .filter_map(|id| db::get_scene_meta(&conn, &server.project_id(), id).ok())
            .collect()
    } else {
        let filter = TreeFilter {
            node_type: Some("scene".to_string()),
            status: params.status.clone(),
        };
        let mut all =
            db::list_tree_nodes(&conn, &server.project_id(), &filter).map_err(internal_err)?;
        if let Some(pid) = &params.parent_id {
            all.retain(|n| n.parent_id.as_deref() == Some(pid.as_str()));
        }
        all.truncate(50);
        all
    };

    let results: Vec<SceneResult> = nodes.iter().map(|n| load_scene(&conn, n)).collect();
    drop(conn);

    let json = serde_json::to_string_pretty(&results).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ProposeSceneBodyParams {
    /// Target scene UUID.
    pub scene_id: String,
    /// Plain-text prose to stage for user accept/reject in the app.
    pub text: String,
    /// "append" (default, end of scene) or "insert" (mid-scene; requires
    /// anchor_text to be applied headlessly).
    pub mode: Option<String>,
    /// For mode="insert": a UNIQUE substring of an existing block in the scene
    /// (read it via read_scene). The prose is inserted before/after the block
    /// containing it. If it matches zero or multiple blocks, the proposal is
    /// left for manual review instead of guessing. Without it, an "insert"
    /// proposal can only be placed by a human in the app (no headless cursor).
    pub anchor_text: Option<String>,
    /// "after" (default) or "before" the anchored block.
    pub anchor_position: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProposeSceneBodyResult {
    staging_id: String,
    scene_id: String,
    status: String,
}

fn is_file_backed_scene(source_uri: Option<&str>) -> bool {
    match source_uri {
        None => false,
        Some(uri) if uri.ends_with("/.mount") => false,
        Some(_) => true,
    }
}

/// Stage plain-text body prose for accept/reject in the app (bodyWrite gate).
pub async fn propose_scene_body(
    server: &GrimodexServer,
    params: ProposeSceneBodyParams,
) -> Result<CallToolResult, ErrorData> {
    if server.readonly {
        return Err(ErrorData::invalid_params(
            "Server is running in readonly mode; write tools are disabled",
            None,
        ));
    }
    let policy = server.reload_policy()?;
    if !policy.body_write {
        return Err(ErrorData::invalid_params(
            "bodyWrite policy is off for this project",
            None,
        ));
    }

    let text = params.text.trim();
    if text.is_empty() {
        return Err(ErrorData::invalid_params("text is required", None));
    }
    // Cap staged prose at the same 1 MB limit codex/snippet content uses. With
    // headless auto-apply on, this row is drained and written into the scene
    // body unattended, so an unbounded MCP-supplied string would otherwise
    // bloat the scene + change-event/timelapse chain with no guard.
    crate::sanitize::validate_content_size(text)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;

    let mode = match params.mode.as_deref() {
        Some("insert") => "insert",
        _ => "append",
    };

    let anchor_text = params
        .anchor_text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let anchor_position = match params.anchor_position.as_deref() {
        Some("before") => "before",
        _ => "after",
    };

    let staging_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    let conn = server.conn.lock().map_err(internal_err)?;

    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(internal_err)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(internal_err)?;

    let result = (|| -> Result<ProposeSceneBodyResult, ErrorData> {
        let (base_version, source_uri): (i64, Option<String>) = conn
            .query_row(
                "SELECT version, source_uri FROM tree_nodes
                 WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                rusqlite::params![params.scene_id, server.project_id()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| ErrorData::invalid_params("scene not found in project", None))?;

        if is_file_backed_scene(source_uri.as_deref()) {
            return Err(ErrorData::invalid_params(
                "file-backed scenes are excluded from headless prose staging (v1)",
                None,
            ));
        }

        let content_json = match anchor_text {
            Some(at) => serde_json::json!({
                "mode": mode,
                "text": text,
                "anchorText": at,
                "anchorPosition": anchor_position,
            }),
            None => serde_json::json!({
                "mode": mode,
                "text": text,
            }),
        };

        conn.execute(
            "INSERT INTO prose_staging
             (id, project_id, scene_id, proposed_content, base_version, status,
              source_surface, source_session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'proposed', 'mcp', ?6, ?7, ?7)",
            rusqlite::params![
                staging_id,
                server.project_id(),
                params.scene_id,
                content_json.to_string(),
                base_version,
                server.session_id,
                now,
            ],
        )
        .map_err(internal_err)?;

        let change_payload = serde_json::json!({
            "stagingId": staging_id,
            "sceneId": params.scene_id,
            "mode": mode,
            "preview": text.chars().take(200).collect::<String>(),
        });

        grimodex_core::change_events::append_change_events_in_tx(
            &conn,
            &server.project_id(),
            &server.session_id,
            &[grimodex_core::change_events::AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: Some(params.scene_id.clone()),
                domain: "prose".to_string(),
                op_type: "prose.propose".to_string(),
                entity_type: Some("prose_staging".to_string()),
                entity_id: Some(staging_id.clone()),
                payload: change_payload.to_string(),
                timestamp,
            }],
        )
        .map_err(internal_err)?;

        Ok(ProposeSceneBodyResult {
            staging_id: staging_id.clone(),
            scene_id: params.scene_id.clone(),
            status: "proposed".to_string(),
        })
    })();

    match result {
        Ok(res) => {
            conn.execute_batch("COMMIT").map_err(internal_err)?;
            let json = serde_json::to_string_pretty(&res).map_err(internal_err)?;
            Ok(CallToolResult::success(vec![rmcp::model::Content::text(
                json,
            )]))
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
