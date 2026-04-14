//! GrimodexServer – rmcp ServerHandler implementation.

use std::path::PathBuf;
use std::sync::Mutex;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ErrorData};
use rusqlite::Connection;

use crate::tools;

pub struct GrimodexServer {
    pub conn: Mutex<Connection>,
    pub content_dir: PathBuf,
    pub project_id: String,
    /// Used in Phase 3 to gate write tools.
    #[allow(dead_code)]
    pub readonly: bool,
}

impl GrimodexServer {
    pub fn new(conn: Connection, content_dir: PathBuf, project_id: String, readonly: bool) -> Self {
        Self {
            conn: Mutex::new(conn),
            content_dir,
            project_id,
            readonly,
        }
    }
}

#[tool_router]
impl GrimodexServer {
    /// Get basic project information (title, genre, language, etc.)
    #[tool(description = "Get basic project information (title, genre, language, etc.)")]
    async fn get_project(&self) -> Result<CallToolResult, ErrorData> {
        tools::project::get_project(self).await
    }

    /// Get project statistics: scene/folder counts, status distribution, Codex entry counts by type.
    #[tool(
        description = "Get project statistics: scene/folder counts, status distribution, Codex entry counts by type"
    )]
    async fn get_project_stats(&self) -> Result<CallToolResult, ErrorData> {
        tools::project::get_project_stats(self).await
    }

    /// List the project tree (scenes and folders). Optionally filter by node_type or status.
    #[tool(
        description = "List the project tree (scenes and folders). Optionally filter by node_type ('scene'|'folder') or status."
    )]
    async fn list_tree(
        &self,
        params: Parameters<tools::tree::ListTreeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::tree::list_tree(self, params.0).await
    }

    /// Read a scene by ID or title (partial match). Returns metadata and Markdown content.
    #[tool(
        description = "Read a scene by ID or title (partial match). Returns metadata and Markdown content."
    )]
    async fn read_scene(
        &self,
        params: Parameters<tools::scene::ReadSceneParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::scene::read_scene(self, params.0).await
    }

    /// Read multiple scenes. Specify scene_ids list, or filter by parent_id / status. Max 50 scenes.
    #[tool(
        description = "Read multiple scenes. Specify scene_ids list, or filter by parent_id / status. Max 50 scenes."
    )]
    async fn read_scenes_batch(
        &self,
        params: Parameters<tools::scene::ReadScenesBatchParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::scene::read_scenes_batch(self, params.0).await
    }

    /// List Codex entries. Filter by type slug (e.g. 'character', 'location') or tag name.
    #[tool(
        description = "List Codex entries. Filter by type slug (e.g. 'character', 'location') or tag name."
    )]
    async fn list_codex_entries(
        &self,
        params: Parameters<tools::codex::ListCodexParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::list_codex_entries(self, params.0).await
    }

    /// Get a full Codex entry by ID or name (partial match). Returns all details including phases, tags, and detail values.
    #[tool(
        description = "Get a full Codex entry by ID or name (partial match). Returns all details including phases, tags, and detail values."
    )]
    async fn get_codex_entry(
        &self,
        params: Parameters<tools::codex::GetCodexParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::get_codex_entry(self, params.0).await
    }

    /// Search across scenes, Codex entries, snippets, and chat messages using full-text search.
    #[tool(
        description = "Search across scenes, Codex entries, snippets, and chat messages using full-text search. Scope: 'all'|'scenes'|'codex'|'snippets'|'chat'."
    )]
    async fn search_project(
        &self,
        params: Parameters<tools::search::SearchProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::search::search_project(self, params.0).await
    }

    /// List all chat sessions in the project, optionally filtered by scene/node ID.
    #[tool(
        description = "List all chat sessions in the project, optionally filtered by scene/node ID."
    )]
    async fn list_chat_sessions(
        &self,
        params: Parameters<tools::chat::ListChatSessionsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chat::list_chat_sessions(self, params.0).await
    }

    /// Read the message history of a chat session. Filter by starred messages or limit count.
    #[tool(
        description = "Read the message history of a chat session. Filter by starred messages or limit count."
    )]
    async fn read_chat_history(
        &self,
        params: Parameters<tools::chat::ReadChatHistoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chat::read_chat_history(self, params.0).await
    }

    /// List snippets (saved text fragments). Optionally filter by tag name.
    #[tool(
        description = "List snippets (saved text fragments). Optionally filter by tag name. Content is returned as Markdown."
    )]
    async fn list_snippets(
        &self,
        params: Parameters<tools::snippets::ListSnippetsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::snippets::list_snippets(self, params.0).await
    }

    /// Get authorship attribution report: how much text was written by human vs AI.
    #[tool(
        description = "Get authorship attribution report showing human vs AI text contribution. Optionally filter to a single scene."
    )]
    async fn get_attribution_report(
        &self,
        params: Parameters<tools::stats::GetAttributionReportParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::stats::get_attribution_report(self, params.0).await
    }

    /// Create a new Codex entry. Disabled in readonly mode.
    #[tool(
        description = "Create a new Codex entry (character, location, item, lore, or custom type). Disabled in readonly mode."
    )]
    async fn create_codex_entry(
        &self,
        params: Parameters<tools::codex::CreateCodexEntryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::create_codex_entry(self, params.0).await
    }

    /// Update an existing Codex entry. Only provided fields are changed. Disabled in readonly mode.
    #[tool(
        description = "Update fields of an existing Codex entry. Only provided fields are changed. Disabled in readonly mode."
    )]
    async fn update_codex_entry(
        &self,
        params: Parameters<tools::codex::UpdateCodexEntryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::update_codex_entry(self, params.0).await
    }
}

#[tool_handler]
impl rmcp::ServerHandler for GrimodexServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }
}
