//! get_scene_timeline_neighbors tool.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::Deserialize;

use crate::db;
use crate::server::GrimodexServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetSceneTimelineNeighborsParams {
    /// Scene UUID whose story-time neighbors to fetch.
    #[serde(rename = "sceneId")]
    pub scene_id: String,
}

pub async fn get_scene_timeline_neighbors(
    server: &GrimodexServer,
    params: GetSceneTimelineNeighborsParams,
) -> Result<CallToolResult, ErrorData> {
    let scene_id = params.scene_id.trim();
    if scene_id.is_empty() {
        let empty = db::SceneTimelineNeighbors {
            current_scene_story_time_label: None,
            previous: Vec::new(),
            next: Vec::new(),
        };
        let json = serde_json::to_string_pretty(&empty)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        return Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json,
        )]));
    }

    let conn = server
        .conn
        .lock()
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let neighbors = db::get_scene_timeline_neighbors(&conn, scene_id)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let json = serde_json::to_string_pretty(&neighbors)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}
