//! read_scene, read_scenes_batch tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use rusqlite::Connection;

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

/// Strip `<span data-authorship="...">text</span>` tags from Markdown content,
/// keeping the inner text. AuthorshipMark serializes as inline HTML; MCP output
/// should expose clean prose without tracking metadata.
///
/// Other inline HTML (e.g. `<span class="emphasis-dots">`, `<ruby>`) is preserved.
fn strip_authorship_spans(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(rel) = rest.find("<span") {
        let before = &rest[..rel];
        let after_open = &rest[rel + 5..]; // skip "<span"

        // Find end of opening tag
        let Some(tag_end) = after_open.find('>') else {
            // Malformed tag — emit everything and stop
            result.push_str(rest);
            return result;
        };

        let attrs = &after_open[..tag_end];
        if attrs.contains("data-authorship") {
            // Authorship span — emit before, then only the inner text
            result.push_str(before);
            let inner_start = rel + 5 + tag_end + 1; // after '>'
            let remaining = &rest[inner_start..];
            if let Some(close) = remaining.find("</span>") {
                result.push_str(&remaining[..close]);
                rest = &remaining[close + 7..]; // skip "</span>"
            } else {
                result.push_str(remaining);
                return result;
            }
        } else {
            // Non-authorship span — keep it verbatim
            result.push_str(before);
            result.push_str("<span");
            result.push_str(&after_open[..tag_end + 1]); // attrs + '>'
            rest = &after_open[tag_end + 1..];
        }
    }

    result.push_str(rest);
    result
}

fn load_scene(conn: &Connection, server: &GrimodexServer, node: &TreeNode) -> SceneResult {
    // Priority 1: Markdown file in content dir
    let md = content::read_scene_markdown(&server.content_dir, &node.id).unwrap_or_default();
    let content = if !md.is_empty() {
        strip_authorship_spans(&md)
    } else {
        // Priority 2: ProseMirror JSON stored in DB content column
        match db::get_scene_content(conn, &node.id) {
            Ok(raw) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    prosemirror_to_markdown(&v)
                } else {
                    raw // plain text fallback
                }
            }
            Err(_) => String::new(),
        }
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

    let results: Vec<SceneResult> = nodes.iter().map(|n| load_scene(&conn, server, n)).collect();
    drop(conn);

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

    let results: Vec<SceneResult> = nodes.iter().map(|n| load_scene(&conn, server, n)).collect();
    drop(conn);

    let json = serde_json::to_string_pretty(&results)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_authorship_simple() {
        let input = r#"<span data-authorship="unknown" source="unknown" timestamp="2026-01-01T00:00:00Z" manualoverride="false">　メロスは</span>激怒した。"#;
        let result = strip_authorship_spans(input);
        assert_eq!(result, "　メロスは激怒した。");
    }

    #[test]
    fn test_strip_authorship_multiple() {
        let input = r#"<span data-authorship="human">Hello</span> world <span data-authorship="ai">foo</span>"#;
        let result = strip_authorship_spans(input);
        assert_eq!(result, "Hello world foo");
    }

    #[test]
    fn test_strip_authorship_preserves_other_spans() {
        let input =
            r#"<span class="emphasis-dots">注目</span><span data-authorship="human">通常</span>"#;
        let result = strip_authorship_spans(input);
        assert_eq!(result, r#"<span class="emphasis-dots">注目</span>通常"#);
    }

    #[test]
    fn test_strip_authorship_no_spans() {
        let input = "plain text without any spans";
        let result = strip_authorship_spans(input);
        assert_eq!(result, input);
    }

    #[test]
    fn test_strip_authorship_with_ruby() {
        let input = r#"<span data-authorship="unknown">　メロスは</span><ruby base="激怒" annotation="激おこ">激怒<rp>(</rp><rt>激おこ</rt><rp>)</rp></ruby><span data-authorship="unknown">した。</span>"#;
        let result = strip_authorship_spans(input);
        assert_eq!(
            result,
            r#"　メロスは<ruby base="激怒" annotation="激おこ">激怒<rp>(</rp><rt>激おこ</rt><rp>)</rp></ruby>した。"#
        );
    }
}
