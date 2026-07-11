//! GrimodexServer – rmcp ServerHandler implementation.

use std::path::PathBuf;
use std::sync::Mutex;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ErrorData};
use rusqlite::Connection;

use crate::tools;

/// Map an internal error to a generic MCP error, logging the full detail to the
/// server log (stderr + file) instead of returning it to the client.
///
/// rusqlite/anyhow `Display` can carry SQL fragments, column/table names, schema
/// details, and (for DB-open errors) absolute paths. Returning `e.to_string()`
/// over the JSON-RPC wire let a (semi-)trusted but possibly prompt-injected MCP
/// client map the internal schema / file layout for reconnaissance. The full
/// error stays available to the operator via the log; the client only learns
/// that an internal error occurred.
pub(crate) fn internal_err(e: impl std::fmt::Display) -> ErrorData {
    tracing::error!("grimodex-mcp internal error: {e}");
    ErrorData::internal_error("internal error".to_string(), None)
}

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
    /// Resolved once at startup by the trusted launcher. The file contents are
    /// re-read for every write so activation changes apply without restart.
    license_file_path: Option<PathBuf>,
    /// Startup snapshot only; mutating tools call `reload_policy()`.
    #[allow(dead_code)]
    pub policy: grimodex_core::policy::AiPolicyToggles,
}

impl GrimodexServer {
    #[cfg(test)]
    pub fn new(
        conn: Connection,
        project_id: String,
        all_projects: bool,
        readonly: bool,
        session_id: String,
        policy: grimodex_core::policy::AiPolicyToggles,
    ) -> Self {
        Self::new_with_license_file(
            conn,
            project_id,
            all_projects,
            readonly,
            session_id,
            policy,
            // The convenience constructor is used by isolated tool tests.
            // Production launchers always call `new_with_license_file` with
            // their resolved app-data path.
            None,
        )
    }

    pub fn new_with_license_file(
        conn: Connection,
        project_id: String,
        all_projects: bool,
        readonly: bool,
        session_id: String,
        policy: grimodex_core::policy::AiPolicyToggles,
        license_file_path: Option<PathBuf>,
    ) -> Self {
        Self {
            conn: Mutex::new(conn),
            current_project: Mutex::new(project_id),
            all_projects,
            readonly,
            session_id,
            policy,
            license_file_path,
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
        let conn = self.conn.lock().map_err(internal_err)?;
        grimodex_core::policy::load_policy(&conn, &self.project_id()).map_err(internal_err)
    }

    /// ライセンスゲート (ライセンス認証設計書 §6)。write 系ツールは制限状態
    /// (trial_expired / license_stale / revoked) で拒否する。read 系ツールは
    /// 常時許可 (Phase 2 決定)。呼び出しごとに license.json を読み直す —
    /// アプリ側での再アクティベートを MCP の再起動なしで反映するため
    /// (`reload_policy` と同じ思想。write 呼び出しは低頻度なので I/O は許容)。
    ///
    /// licensing feature 無効ビルド (ベータ) では常に許可。fail-soft:
    /// license.json の欠損・破損・パス解決不能は許可側に倒す (read 側が
    /// default = 試用初期状態を返すため)。
    pub fn ensure_license_allows_write(&self) -> Result<(), ErrorData> {
        if !cfg!(feature = "licensing") {
            return Ok(());
        }
        let now = chrono::Utc::now();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        if !crate::license_gate::license_allows_write(
            self.license_file_path.as_deref(),
            now,
            &today,
        ) {
            return Err(ErrorData::invalid_params(
                "License is not active (trial expired, validation stale, or revoked); \
                 write tools are disabled. Read tools remain available.",
                None,
            ));
        }
        Ok(())
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

    /// Create a new foreshadowing item. Disabled in readonly mode. knowledgeWrite gate.
    #[tool(
        description = "Create a new foreshadowing (plant/payoff) item: title, optional intent, notes, load_bearing ('critical'|'supporting'|'optional'), and secret flag (defaults true). Disabled in readonly mode."
    )]
    async fn create_foreshadow(
        &self,
        params: Parameters<tools::foreshadow::CreateForeshadowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::foreshadow::create_foreshadow(self, params.0).await
    }

    /// Update fields of an existing foreshadowing item. Only provided fields change. Disabled in readonly mode. knowledgeWrite gate.
    #[tool(
        description = "Update an existing foreshadowing item (title, intent, notes, load_bearing, payoff_confirmed, abandoned, secret). Only provided fields change. Scoped to the active project. Disabled in readonly mode."
    )]
    async fn update_foreshadow(
        &self,
        params: Parameters<tools::foreshadow::UpdateForeshadowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::foreshadow::update_foreshadow(self, params.0).await
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
        description = "Read the message history of a chat session. Returns the most recent `limit` messages in chronological order. Use anchors_only=true to return user messages and Tier-2 anchor AI messages (inserted to editor, Codex/Snippet extracted). starred_only is deprecated (maps to anchors_only). Response includes metadata."
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

    /// One-shot curated writing context for a scene (read-only aggregate).
    #[tool(
        description = "Get a one-shot curated writing context for a scene: project info, chapter outlines, story-so-far synopses (reading order), the scene itself as Markdown (with synopsis/status/intent), story-time neighbors, foreshadows planted or resolved in the scene, project-wide open foreshadows, and Codex entries mentioned in the scene plus always-include entries. Call this FIRST before drafting or analyzing prose for a scene — it replaces a dozen individual read calls. Read-only; secret foreshadows are excluded; hard caps report dropped counts."
    )]
    async fn get_writing_context(
        &self,
        params: Parameters<tools::context::GetWritingContextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::context::get_writing_context(self, params.0).await
    }

    /// Propose plain-text scene body prose (staged accept/reject in app). bodyWrite gate.
    #[tool(
        description = "Propose plain-text body prose for a scene. mode='append' (default) adds to the end; mode='insert' with anchor_text (a unique substring of an existing block, from read_scene) inserts before/after that block. Staged for user accept/reject in the app unless headless auto-apply is enabled. Disabled in readonly mode. File-backed scenes are excluded."
    )]
    async fn propose_scene_body(
        &self,
        params: Parameters<tools::scene::ProposeSceneBodyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::scene::propose_scene_body(self, params.0).await
    }

    // ─── Chronicle (作中年表) ─────────────────────────────────────────────────

    /// List chronicle events in story (ordinal) order. Optional kind filter.
    #[tool(
        description = "List chronicle (作中年表) events in story order (ordinal). Each item: id, title, kind, ordinal, startTime, startDate (calendar-formatted date string; null when there is no calendar or the granularity is unset), primaryCharacter (resolved codex name). Optional kind filter: 'birth'|'death'|'generic'."
    )]
    async fn list_events(
        &self,
        params: Parameters<tools::chronicle::ListEventsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::list_events(self, params.0).await
    }

    /// Get one event's full detail: participants, scene links, causal relations.
    #[tool(
        description = "Get a chronicle event's full detail by event_id: title, note, kind, ordinal, start/end time, startDate/endDate (calendar-formatted date strings; null when there is no calendar or the granularity is unset), precision, primaryCharacter and location (resolved names), participants (codexId/name/role), stamped scenes (sceneId/title), and causal relations (cause/effect titles). Returns null if the event is not in this project."
    )]
    async fn get_event_detail(
        &self,
        params: Parameters<tools::chronicle::GetEventDetailParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::get_event_detail(self, params.0).await
    }

    /// Get a character's in-story career: involved events in order, with ages.
    #[tool(
        description = "Get a character's chronicle timeline by codex_id: the events they are primary in or participate in, in story order, each with ageAtEvent (computed from their birth event and the project calendar when both are known)."
    )]
    async fn get_character_timeline(
        &self,
        params: Parameters<tools::chronicle::GetCharacterTimelineParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::get_character_timeline(self, params.0).await
    }

    /// Derive the world-state snapshot at a scene's story time (structured JSON).
    #[tool(
        description = "Get the chronicle world-state snapshot anchored at a scene (scene_id required): time (source/startTime/season), character statuses (alive/dead/unborn/unknown, age, last-known location), recent events, unresolved causal pairs, and off-page background. Identical structured JSON to the in-app get_chronicle_state tool. Returns null if there are no events or no scene_id."
    )]
    async fn get_chronicle_state(
        &self,
        params: Parameters<tools::chronicle::GetChronicleStateParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::get_chronicle_state(self, params.0).await
    }

    /// Create a chronicle event (tracked; undo-able). knowledgeWrite gate.
    #[tool(
        description = "Create a chronicle event: title (required), note, kind ('generic'|'birth'|'death', default generic), primary_codex_id, location_codex_id, start_time/end_time (days from epoch), start_minute/end_minute (time of day, 0-1439, 24h clock), start_granularity/end_granularity ('none'|'season'|'year'|'month'|'day'|'time', default 'none'), participant_codex_ids, scene_ids. Tracked (undo_journal + change_event). Disabled in readonly mode."
    )]
    async fn create_event(
        &self,
        params: Parameters<tools::chronicle::CreateEventParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::create_event(self, params.0).await
    }

    /// Update a chronicle event (only provided fields). knowledgeWrite gate.
    #[tool(
        description = "Update a chronicle event by event_id. Only provided fields change (title, note, kind, primary_codex_id, location_codex_id, start_time, end_time, start_minute/end_minute (0-1439, 24h clock), start_granularity/end_granularity ('none'|'season'|'year'|'month'|'day'|'time')). Scoped to the active project. Tracked. Disabled in readonly mode."
    )]
    async fn update_event(
        &self,
        params: Parameters<tools::chronicle::UpdateEventParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::update_event(self, params.0).await
    }

    /// Delete a chronicle event (cascade snapshot; undo restores). knowledgeWrite gate.
    #[tool(
        description = "Delete a chronicle event by event_id. Its participants, scene links, and causal relations cascade; a full snapshot is captured first so undo restores everything. Scoped to the active project. Tracked. Disabled in readonly mode."
    )]
    async fn delete_event(
        &self,
        params: Parameters<tools::chronicle::EventIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::delete_event(self, params.0).await
    }

    /// Stamp an event onto a scene (scene↔event link). knowledgeWrite gate.
    #[tool(
        description = "Stamp a chronicle event onto a scene (scene_id + event_id; both must belong to the active project). Tracked. Disabled in readonly mode."
    )]
    async fn stamp_scene_event(
        &self,
        params: Parameters<tools::chronicle::SceneEventParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::stamp_scene_event(self, params.0).await
    }

    /// Remove a scene↔event stamp. knowledgeWrite gate.
    #[tool(
        description = "Remove a chronicle scene↔event stamp (scene_id + event_id). Tracked. Disabled in readonly mode."
    )]
    async fn unstamp_scene_event(
        &self,
        params: Parameters<tools::chronicle::SceneEventParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::unstamp_scene_event(self, params.0).await
    }

    /// Replace an event's participant set. knowledgeWrite gate.
    #[tool(
        description = "Replace a chronicle event's participant set with codex_entry_ids (full replacement). Tracked. Disabled in readonly mode."
    )]
    async fn set_event_participants(
        &self,
        params: Parameters<tools::chronicle::SetParticipantsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::set_event_participants(self, params.0).await
    }

    /// Add a causal edge between two events. knowledgeWrite gate.
    #[tool(
        description = "Add a causal edge between two chronicle events (cause_event_id → effect_event_id; both must be in the active project; self-loops rejected). Tracked. Disabled in readonly mode."
    )]
    async fn add_event_relation(
        &self,
        params: Parameters<tools::chronicle::EventRelationParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::add_event_relation(self, params.0).await
    }

    /// Remove a causal edge between two events. knowledgeWrite gate.
    #[tool(
        description = "Remove a causal edge between two chronicle events (cause_event_id → effect_event_id). Tracked. Disabled in readonly mode."
    )]
    async fn remove_event_relation(
        &self,
        params: Parameters<tools::chronicle::EventRelationParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::chronicle::remove_event_relation(self, params.0).await
    }
}

#[tool_handler]
impl rmcp::ServerHandler for GrimodexServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }
}

#[cfg(all(test, feature = "licensing"))]
mod license_tests {
    use super::*;
    use grimodex_core::license::{ActivatedLicense, LicenseFile};

    fn server_with_license_path(path: PathBuf) -> GrimodexServer {
        GrimodexServer::new_with_license_file(
            Connection::open_in_memory().expect("open in-memory DB"),
            "project-test".to_string(),
            false,
            false,
            "session-test".to_string(),
            grimodex_core::policy::AiPolicyToggles {
                chat: true,
                body_write: true,
                analysis: true,
                structure_write: true,
                knowledge_write: true,
            },
            Some(path),
        )
    }

    #[test]
    fn injected_revoked_file_reaches_the_server_write_gate() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-mcp-server-license-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("license.json");
        let file = LicenseFile {
            license: Some(ActivatedLicense {
                key: "GRIM-TEST".to_string(),
                activation_id: "activation-test".to_string(),
                benefit_id: None,
                activated_at: None,
                last_validated_at: None,
                revoked_at: Some("2026-07-11T00:00:00Z".to_string()),
            }),
            ..LicenseFile::default()
        };
        grimodex_core::license::write_license_file(&path, &file).expect("write revoked fixture");

        let server = server_with_license_path(path);
        assert!(server.ensure_license_allows_write().is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_injected_file_reaches_fail_soft_trial_access() {
        let path = std::env::temp_dir()
            .join(format!(
                "grimodex-mcp-server-missing-{}",
                uuid::Uuid::new_v4()
            ))
            .join("license.json");
        let server = server_with_license_path(path);
        assert!(server.ensure_license_allows_write().is_ok());
    }
}
