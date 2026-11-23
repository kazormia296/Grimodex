//! list_tree tool.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use rusqlite::Connection;
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
    let nested = nested_tree(&conn, &server.project_id(), &filter).map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&nested).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
}

pub async fn get_chapter_summaries(server: &GrimodexServer) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let summaries = db::get_chapter_summaries(&conn, &server.project_id()).map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&summaries).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![
        rmcp::model::ContentBlock::text(json),
    ]))
}

/// Build hierarchy (only makes sense when not filtering by type/status).
fn nested_tree(
    conn: &Connection,
    project_id: &str,
    filter: &TreeFilter,
) -> anyhow::Result<Vec<TreeNodeNested>> {
    let nodes = db::list_tree_nodes(conn, project_id, filter)?;
    Ok(build_tree(&nodes, None))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::archived_reads::seed_archive_tree;
    use crate::db::tests::make_simple_db;

    /// `list_tree` の入れ子を (id, 子の id の列) の平らな写しにする。
    fn shape(nodes: &[TreeNodeNested], out: &mut Vec<(String, Vec<String>)>) {
        for n in nodes {
            out.push((
                n.id.clone(),
                n.children.iter().map(|c| c.id.clone()).collect(),
            ));
            shape(&n.children, out);
        }
    }

    fn tree_shape(conn: &Connection) -> Vec<(String, Vec<String>)> {
        let nested = nested_tree(conn, "p1", &TreeFilter::default()).unwrap();
        let mut out = Vec::new();
        shape(&nested, &mut out);
        out
    }

    fn row(id: &str, children: &[&str]) -> (String, Vec<String>) {
        (
            id.to_string(),
            children.iter().map(|c| c.to_string()).collect(),
        )
    }

    #[test]
    fn list_tree_shows_archived_rows_today() {
        let conn = make_simple_db();
        seed_archive_tree(&conn);
        assert_eq!(
            tree_shape(&conn),
            vec![
                row("f-live", &["s1", "a-s2", "s3"]),
                row("s1", &[]),
                row("a-s2", &[]),
                row("s3", &[]),
                row("a-fold", &["s4"]),
                row("s4", &[]),
                row("s5", &[]),
            ]
        );
    }
}
