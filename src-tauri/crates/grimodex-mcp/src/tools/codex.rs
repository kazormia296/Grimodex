//! list_codex_entries, get_codex_entry, create_codex_entry, update_codex_entry tools.

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::convert::prosemirror_to_markdown;
use crate::db::{self, CodexEntryFull, CodexFilter};
use crate::sanitize;
use crate::server::{internal_err, GrimodexServer};

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
    let conn = server.conn.lock().map_err(internal_err)?;
    let filter = CodexFilter {
        type_slug: params.type_slug,
        tag: params.tag,
    };
    let entries =
        db::list_codex_entries(&conn, &server.project_id(), &filter).map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&entries).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

pub async fn get_codex_entry(
    server: &GrimodexServer,
    params: GetCodexParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;

    let entries: Vec<CodexEntryFull> = if let Some(id) = &params.entry_id {
        vec![db::get_codex_entry_full(&conn, &server.project_id(), id).map_err(internal_err)?]
    } else if let Some(name) = &params.name {
        let summaries =
            db::find_codex_by_name(&conn, &server.project_id(), name).map_err(internal_err)?;
        summaries
            .iter()
            .filter_map(|s| db::get_codex_entry_full(&conn, &server.project_id(), &s.id).ok())
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

    let json = serde_json::to_string_pretty(&entries).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

// ─── Chat executor parity read tools ─────────────────────────────────────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListCodexTagsParams {
    /// Filter tags compatible with this Codex entry type (partial match on type_filter).
    #[serde(rename = "type")]
    pub type_filter: Option<String>,
}

pub async fn list_codex_tags(
    server: &GrimodexServer,
    params: ListCodexTagsParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let tags = db::list_codex_tags(&conn, &server.project_id(), params.type_filter.as_deref())
        .map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&tags).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchCodexByTagsParams {
    /// Tag names to match (OR). Empty array returns no results.
    pub tags: Vec<String>,
}

pub async fn search_codex_by_tags(
    server: &GrimodexServer,
    params: SearchCodexByTagsParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let entries = db::search_codex_by_tags(&conn, &server.project_id(), &params.tags)
        .map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&entries).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct FindRelatedEntriesParams {
    /// Source Codex entry ID.
    pub id: String,
    /// Optional Codex type slug filter.
    #[serde(rename = "type")]
    pub type_filter: Option<String>,
}

pub async fn find_related_entries(
    server: &GrimodexServer,
    params: FindRelatedEntriesParams,
) -> Result<CallToolResult, ErrorData> {
    let id = params.id.trim();
    if id.is_empty() {
        let json = serde_json::to_string_pretty(&Vec::<db::RelatedCodexEntry>::new())
            .map_err(internal_err)?;
        return Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json,
        )]));
    }
    let conn = server.conn.lock().map_err(internal_err)?;
    let entries = db::find_related_entries(
        &conn,
        &server.project_id(),
        id,
        params.type_filter.as_deref(),
    )
    .map_err(internal_err)?;
    let json = serde_json::to_string_pretty(&entries).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

// ─── Phase 3: write tools ────────────────────────────────────────────────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateCodexEntryParams {
    /// Type slug: "character", "location", "item", "lore", or a custom slug.
    pub type_slug: String,
    /// Entry name (required, max 255 characters).
    pub name: String,
    /// Aliases list (optional, max 50, each max 100 chars).
    pub aliases: Option<Vec<String>>,
    /// Short summary (optional, max 2000 characters).
    pub summary: Option<String>,
    /// Main content as plain Markdown text (optional, max 1 MB).
    pub content: Option<String>,
    /// Tags to assign (will be created if they don't exist).
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct CreateCodexResult {
    id: String,
    message: String,
}

pub async fn create_codex_entry(
    server: &GrimodexServer,
    params: CreateCodexEntryParams,
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

    let name = sanitize::sanitize_name(&params.name)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let type_slug = sanitize::sanitize_name(&params.type_slug)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;

    let aliases_vec = if let Some(a) = &params.aliases {
        sanitize::sanitize_aliases(a).map_err(|e| ErrorData::invalid_params(e.to_string(), None))?
    } else {
        Vec::new()
    };
    let aliases_str = if aliases_vec.is_empty() {
        None
    } else {
        Some(aliases_vec.join(","))
    };

    let summary = if let Some(s) = &params.summary {
        let cleaned = sanitize::sanitize_summary(s)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    } else {
        None
    };

    let content_pm = if let Some(md) = &params.content {
        sanitize::validate_content_size(md)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        sanitize::markdown_to_prosemirror(md)
    } else {
        r#"{"type":"doc","content":[]}"#.to_string()
    };

    let tags = params.tags.unwrap_or_default();
    let new_id = uuid::Uuid::new_v4().to_string();
    let summary_text = summary.as_deref().unwrap_or("");
    let mut spans = Vec::new();
    if !summary_text.is_empty() {
        spans.push(grimodex_core::writes::codex::AuthorshipSpanInput {
            from_pos: 0,
            to_pos: grimodex_core::pm_text::utf16_text_len(summary_text),
            source: "ai".to_string(),
            model: Some(grimodex_core::writes::LANE_SUMMARY_MODEL.to_string()),
            chat_msg_id: None,
            trace_id: None,
            lane: Some("summary".to_string()),
        });
    }
    let content_text_len = grimodex_core::pm_text::pm_doc_text_len(&content_pm);
    if content_text_len > 0 {
        spans.push(grimodex_core::writes::codex::AuthorshipSpanInput {
            from_pos: 0,
            to_pos: content_text_len,
            source: "ai".to_string(),
            model: Some(grimodex_core::writes::LANE_CONTENT_MODEL.to_string()),
            chat_msg_id: None,
            trace_id: None,
            lane: Some("content".to_string()),
        });
    }

    let conn = server.conn.lock().map_err(internal_err)?;

    grimodex_core::writes::codex::tracked_codex_create(
        &conn,
        grimodex_core::writes::codex::TrackedCodexCreateInput {
            project_id: &server.project_id(),
            session_id: &server.session_id,
            surface: "mcp",
            entry_id: &new_id,
            type_slug: &type_slug,
            name: &name,
            summary: summary_text,
            content: &content_pm,
            aliases: aliases_str.as_deref(),
            parent_id: None,
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: &spans,
            tags: &tags,
        },
    )
    .map_err(internal_err)?;

    let result = CreateCodexResult {
        id: new_id.clone(),
        message: format!("Codex entry '{}' created with id {}", name, new_id),
    };
    let json = serde_json::to_string_pretty(&result).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateCodexEntryParams {
    /// ID of the Codex entry to update (required).
    pub entry_id: String,
    /// New name (optional).
    pub name: Option<String>,
    /// New aliases list (optional; replaces existing aliases).
    pub aliases: Option<Vec<String>>,
    /// New summary (optional).
    pub summary: Option<String>,
    /// New content as plain Markdown (optional; replaces existing content).
    pub content: Option<String>,
    /// New tags list (optional; replaces existing tags).
    pub tags: Option<Vec<String>>,
}

pub async fn update_codex_entry(
    server: &GrimodexServer,
    params: UpdateCodexEntryParams,
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

    let name = if let Some(n) = &params.name {
        Some(
            sanitize::sanitize_name(n)
                .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?,
        )
    } else {
        None
    };

    let aliases_str = if let Some(a) = &params.aliases {
        let cleaned = sanitize::sanitize_aliases(a)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        Some(if cleaned.is_empty() {
            String::new()
        } else {
            cleaned.join(",")
        })
    } else {
        None
    };

    let summary = if let Some(s) = &params.summary {
        Some(
            sanitize::sanitize_summary(s)
                .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?,
        )
    } else {
        None
    };

    let content_pm = if let Some(md) = &params.content {
        sanitize::validate_content_size(md)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        Some(sanitize::markdown_to_prosemirror(md))
    } else {
        None
    };

    let conn = server.conn.lock().map_err(internal_err)?;

    let base_version: i64 = conn
        .query_row(
            "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![params.entry_id, server.project_id()],
            |row| row.get(0),
        )
        .map_err(|_| ErrorData::invalid_params("Codex entry not found in project", None))?;

    let mut spans = Vec::new();
    let mut lanes: Vec<Option<String>> = Vec::new();
    if let Some(ref s) = summary {
        if !s.is_empty() {
            spans.push(grimodex_core::writes::codex::AuthorshipSpanInput {
                from_pos: 0,
                to_pos: grimodex_core::pm_text::utf16_text_len(s),
                source: "ai".to_string(),
                model: Some(grimodex_core::writes::LANE_SUMMARY_MODEL.to_string()),
                chat_msg_id: None,
                trace_id: None,
                lane: Some("summary".to_string()),
            });
            lanes.push(Some("summary".to_string()));
        }
    }
    if let Some(ref c) = content_pm {
        let content_text_len = grimodex_core::pm_text::pm_doc_text_len(c);
        if content_text_len > 0 {
            spans.push(grimodex_core::writes::codex::AuthorshipSpanInput {
                from_pos: 0,
                to_pos: content_text_len,
                source: "ai".to_string(),
                model: Some(grimodex_core::writes::LANE_CONTENT_MODEL.to_string()),
                chat_msg_id: None,
                trace_id: None,
                lane: Some("content".to_string()),
            });
            lanes.push(Some("content".to_string()));
        }
    }
    let span_ref = if spans.is_empty() {
        None
    } else {
        Some(spans.as_slice())
    };

    grimodex_core::writes::codex::tracked_codex_update(
        &conn,
        grimodex_core::writes::codex::TrackedCodexUpdateInput {
            project_id: &server.project_id(),
            session_id: &server.session_id,
            surface: "mcp",
            entry_id: &params.entry_id,
            expected_base_version: base_version,
            name: name.as_deref(),
            summary: summary.as_deref(),
            content: content_pm.as_deref(),
            aliases: aliases_str.as_deref(),
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: span_ref,
            tags: params.tags.as_deref(),
        },
    )
    .map_err(internal_err)?;

    let json = serde_json::json!({
        "id": params.entry_id,
        "message": "Codex entry updated successfully"
    })
    .to_string();
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::make_simple_db;
    use crate::server::GrimodexServer;

    /// The shape contract is asserted on the grimodex-core path (which this
    /// tool calls directly); here we gate the tool-layer policy key against
    /// the same parity fixture.
    const CODEX_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../src/features/agent-writes/parity/codexCreate.fixture.json"
    ));

    #[tokio::test]
    async fn create_codex_entry_respects_fixture_policy_gate() {
        let fixture: serde_json::Value = serde_json::from_str(CODEX_FIXTURE).unwrap();
        let gate = fixture["policyGate"].as_str().unwrap();
        let mut toggles = serde_json::json!({
            "chat": true, "bodyWrite": true, "analysis": true,
            "structureWrite": true, "knowledgeWrite": true,
        });
        toggles[gate] = serde_json::Value::Bool(false);
        let policy_json =
            serde_json::json!({ "preset": "custom", "toggles": toggles }).to_string();

        let conn = make_simple_db();
        conn.execute(
            "INSERT INTO projects (id, title, ai_policy) VALUES ('p1', 'Novel', ?1)",
            rusqlite::params![policy_json],
        )
        .unwrap();
        let policy = grimodex_core::policy::load_policy(&conn, "p1").unwrap();
        let server = GrimodexServer::new(
            conn,
            "p1".to_string(),
            false,
            false,
            "sess-mcp".to_string(),
            policy,
        );

        let res = create_codex_entry(
            &server,
            CreateCodexEntryParams {
                type_slug: "character".to_string(),
                name: "Alice".to_string(),
                aliases: None,
                summary: None,
                content: None,
                tags: None,
            },
        )
        .await;
        assert!(res.is_err(), "fixture gate '{gate}'=off must block the write");
        let conn = server.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
