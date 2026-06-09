//! list_tree tool.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::db::{self, TreeFilter, TreeNode};
use crate::server::{internal_err, GrimodexServer};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListTreeParams {
    /// Filter by node type: "scene" or "folder". Omit for all.
    pub node_type: Option<String>,
    /// Filter by status: "outline", "draft", "revised", "final". Omit for all.
    pub status: Option<String>,
}

/// Tree node with children for hierarchical output.
#[derive(Debug, Serialize)]
struct TreeNodeNested {
    id: String,
    node_type: String,
    title: String,
    synopsis: Option<String>,
    status: Option<String>,
    sort_order: String,
    children: Vec<TreeNodeNested>,
}

pub async fn list_tree(
    server: &GrimodexServer,
    params: ListTreeParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let filter = TreeFilter {
        node_type: params.node_type,
        status: params.status,
    };
    let nodes = db::list_tree_nodes(&conn, &server.project_id(), &filter).map_err(internal_err)?;

    // Build hierarchy (only makes sense when not filtering by type/status)
    let nested = build_tree(&nodes, None);
    let json = serde_json::to_string_pretty(&nested).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn get_chapter_summaries(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let summaries = db::get_chapter_summaries(&conn, &server.project_id()).map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&summaries).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

fn build_tree(nodes: &[TreeNode], parent_id: Option<&str>) -> Vec<TreeNodeNested> {
    nodes
        .iter()
        .filter(|n| n.parent_id.as_deref() == parent_id)
        .map(|n| TreeNodeNested {
            id: n.id.clone(),
            node_type: n.node_type.clone(),
            title: n.title.clone(),
            synopsis: n.synopsis.clone(),
            status: n.status.clone(),
            sort_order: n.sort_order.clone(),
            children: build_tree(nodes, Some(&n.id)),
        })
        .collect()
}
