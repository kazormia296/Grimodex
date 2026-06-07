//! GrimodexServer – rmcp ServerHandler implementation.

use std::sync::Mutex;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ErrorData};
use rusqlite::Connection;

use crate::tools;

pub struct GrimodexServer {
    pub conn: Mutex<Connection>,
    /// The project all tools currently scope to. Mutable so `--all-projects`
    /// mode can switch it via `select_project`. In pinned mode (the default)
    /// it never changes — `select_project` is rejected — so the per-connection
    /// least-privilege scope (XPROJ defense) is preserved.
    current_project: Mutex<String>,
    /// When true, `select_project` is allowed and `list_projects` enumerates
    /// the whole DB. Opt-in via `--all-projects` for local/trusted clients;
    /// widens the connection to every project in the workspace.
    pub all_projects: bool,
    pub readonly: bool,
    pub session_id: String,
    /// Startup snapshot only; mutating tools call `reload_policy()`.
    #[allow(dead_code)]
    pub policy: grimodex_core::policy::AiPolicyToggles,
}

impl GrimodexServer {
    pub fn new(
        conn: Connection,
        project_id: String,
        all_projects: bool,
        readonly: bool,
        session_id: String,
        policy: grimodex_core::policy::AiPolicyToggles,
    ) -> Self {
        Self {
            conn: Mutex::new(conn),
            current_project: Mutex::new(project_id),
            all_projects,
            readonly,
            session_id,
            policy,
        }
    }

    /// The project id all tools currently scope to. Single source of truth —
    /// every tool reads this instead of a fixed field, so a `select_project`
    /// switch (all-projects mode) is picked up everywhere, and the scoping in
    /// `db.rs` stays exactly as hardened. Recovers a poisoned lock rather than
    /// panicking (`unwrap()` is banned).
    pub fn project_id(&self) -> String {
        self.current_project
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|poison| poison.into_inner().clone())
    }

    /// Switch the current project (all-projects mode only — callers must gate).
    pub fn set_current_project(&self, project_id: String) {
        match self.current_project.lock() {
            Ok(mut g) => *g = project_id,
            Err(poison) => *poison.into_inner() = project_id,
        }
    }

    /// Reload policy from DB on each mutating tool call (in-app toggles take
    /// effect). Reads the *current* project so write-gating follows
    /// `select_project` in all-projects mode (not the startup project).
    pub fn reload_policy(&self) -> Result<grimodex_core::policy::AiPolicyToggles, ErrorData> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        grimodex_core::policy::load_policy(&conn, &self.project_id())
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }
}

#[tool_router]
impl GrimodexServer {
    /// List projects in the workspace. In pinned mode returns only the bound project.
    #[tool(
        description = "List projects in this workspace (id, title). In the default pinned mode only the single bound project is returned; with --all-projects every project is listed. Use select_project to switch the active project."
    )]
    async fn list_projects(&self) -> Result<CallToolResult, ErrorData> {
        tools::project::list_projects(self).await
    }

    /// Switch the active project (requires --all-projects). Rejected in pinned mode.
    #[tool(
        description = "Switch the active project that subsequent tools scope to. Requires the server to be started with --all-projects; otherwise rejected (the connection is pinned to one project). The project_id must exist in this workspace."
    )]
    async fn select_project(
        &self,
        params: Parameters<tools::project::SelectProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::project::select_project(self, params.0).await
    }

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

    /// List Codex tags with usage counts. Optionally filter by compatible entry type.
    #[tool(
        description = "List Codex tags with usage counts. Optionally filter by compatible entry type (type_filter partial match)."
    )]
    async fn list_codex_tags(
        &self,
        params: Parameters<tools::codex::ListCodexTagsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::list_codex_tags(self, params.0).await
    }

    /// Find Codex entries whose name/summary/aliases/tags match a source entry's name or aliases.
    #[tool(
        description = "Find Codex entries related to a source entry (name + aliases matched against other entries' name, summary, aliases, tags_cache). Optional type filter."
    )]
    async fn find_related_entries(
        &self,
        params: Parameters<tools::codex::FindRelatedEntriesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::find_related_entries(self, params.0).await
    }

    /// Search Codex entries that have any of the given tags (OR match).
    #[tool(
        description = "Search Codex entries tagged with any of the given tag names (OR). Returns id, name, type, summary."
    )]
    async fn search_codex_by_tags(
        &self,
        params: Parameters<tools::codex::SearchCodexByTagsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::codex::search_codex_by_tags(self, params.0).await
    }

    /// Get folder-grouped scene synopses (folders treated as chapters).
    #[tool(
        description = "Get all folder (chapter) groupings with child scene synopses. Scenes without synopsis are omitted."
    )]
    async fn get_chapter_summaries(&self) -> Result<CallToolResult, ErrorData> {
        tools::tree::get_chapter_summaries(self).await
    }

    /// List unresolved foreshadowing items (excludes secret, abandoned, payoff-confirmed).
    #[tool(
        description = "List open (unresolved) foreshadowing items: id, title, intent, loadBearing, setupCount. Sorted by loadBearing priority then updatedAt."
    )]
    async fn list_open_foreshadows(&self) -> Result<CallToolResult, ErrorData> {
        tools::foreshadow::list_open_foreshadows(self).await
    }

    /// Get full detail for a single foreshadowing item including setups and payoff scene.
    #[tool(
        description = "Get foreshadow detail: title, intent, notes, loadBearing, payoff state, payoff scene, and setup list with scene titles."
    )]
    async fn get_foreshadow_detail(
        &self,
        params: Parameters<tools::foreshadow::GetForeshadowDetailParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::foreshadow::get_foreshadow_detail(self, params.0).await
    }

    /// Get previous/next scenes in story-time order for a scene.
    #[tool(
        description = "Get up to 3 previous and 3 next scenes by story_time_order fractional key for the given sceneId."
    )]
    async fn get_scene_timeline_neighbors(
        &self,
        params: Parameters<tools::timeline::GetSceneTimelineNeighborsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::timeline::get_scene_timeline_neighbors(self, params.0).await
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

    /// Read the message history of a chat session. Filter by anchor messages or limit count.
    #[tool(
        description = "Read the message history of a chat session. Use anchors_only=true to return user messages and Tier-2 anchor AI messages (inserted to editor, Codex/Snippet extracted). starred_only is deprecated (maps to anchors_only). Response includes metadata."
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

    /// Create a new Snippet. Disabled in readonly mode. knowledgeWrite gate.
    #[tool(description = "Create a new Snippet (saved text fragment). Disabled in readonly mode.")]
    async fn create_snippet(
        &self,
        params: Parameters<tools::snippets::CreateSnippetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::snippets::create_snippet(self, params.0).await
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

    /// Propose plain-text scene body prose (staged accept/reject in app). bodyWrite gate.
    #[tool(
        description = "Propose plain-text body prose for a scene. Content is staged for user accept/reject in the app — not applied immediately. Disabled in readonly mode. File-backed scenes are excluded."
    )]
    async fn propose_scene_body(
        &self,
        params: Parameters<tools::scene::ProposeSceneBodyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::scene::propose_scene_body(self, params.0).await
    }
}

#[tool_handler]
impl rmcp::ServerHandler for GrimodexServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }
}
