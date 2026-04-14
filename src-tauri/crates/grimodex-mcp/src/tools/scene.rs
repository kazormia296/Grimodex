//! read_scene, read_scenes_batch tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::content;
use crate::convert::prosemirror_to_markdown;
use crate::db::{self, TreeFilter, TreeNode};
use crate::server::GrimodexServer;

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
    sort_order: f64,
    created_at: String,
    updated_at: String,
    content: String,
}

fn load_scene(server: &GrimodexServer, node: &TreeNode) -> SceneResult {
    // Read from content dir; fall back to ProseMirror JSON in DB
    let md = content::read_scene_markdown(&server.content_dir, &node.id).unwrap_or_default();
    let content = if md.is_empty() {
        // Try converting DB content field (ProseMirror JSON)
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&node.id) {
            prosemirror_to_markdown(&v)
        } else {
            String::new()
        }
    } else {
        md
    };
    SceneResult {
        id: node.id.clone(),
        title: node.title.clone(),
        synopsis: node.synopsis.clone(),
        status: node.status.clone(),
        parent_id: node.parent_id.clone(),
        sort_order: node.sort_order,
        created_at: node.created_at.clone(),
        updated_at: node.updated_at.clone(),
        content,
    }
}

pub async fn read_scene(
    server: &GrimodexServer,
    params: ReadSceneParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let nodes: Vec<TreeNode> = if let Some(id) = &params.scene_id {
        vec![db::get_scene_meta(&conn, id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?]
    } else if let Some(title) = &params.title {
        db::find_scene_by_title(&conn, &server.project_id, title)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
    } else {
        return Err(ErrorData::invalid_params(
            "Provide either scene_id or title",
            None,
        ));
    };

    drop(conn); // release lock before file I/O

    let results: Vec<SceneResult> = nodes.iter().map(|n| load_scene(server, n)).collect();
    let json = serde_json::to_string_pretty(&results)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn read_scenes_batch(
    server: &GrimodexServer,
    params: ReadScenesBatchParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

    let nodes: Vec<TreeNode> = if let Some(ids) = &params.scene_ids {
        let ids: Vec<String> = ids.iter().take(50).cloned().collect();
        ids.iter()
            .filter_map(|id| db::get_scene_meta(&conn, id).ok())
            .collect()
    } else {
        let filter = TreeFilter {
            node_type: Some("scene".to_string()),
            status: params.status.clone(),
        };
        let mut all = db::list_tree_nodes(&conn, &server.project_id, &filter)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        if let Some(pid) = &params.parent_id {
            all.retain(|n| n.parent_id.as_deref() == Some(pid.as_str()));
        }
        all.truncate(50);
        all
    };

    drop(conn);

    let results: Vec<SceneResult> = nodes.iter().map(|n| load_scene(server, n)).collect();
    let json = serde_json::to_string_pretty(&results)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
