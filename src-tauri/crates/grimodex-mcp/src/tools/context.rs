//! get_writing_context tool — one-shot curated writing context for a scene.
//!
//! Mirrors the in-app chat context layers (L1 project / L2 story-so-far +
//! chapter outlines / L3 current scene / L4 codex) as structured JSON so an
//! external MCP client gets in one call what would otherwise take a dozen
//! orchestrated read tools. Read-only; every query is scoped to the active
//! project (XPROJ defense). Secret foreshadows are excluded everywhere.
//!
//! Deliberate v1 cuts (documented, not oversights): no token budgeting/trim
//! (the caller sees char counts and can trim), no codex relation BFS /
//! children / phase resolution, and mention detection is a plain substring
//! scan — not the app's boundary-aware Aho-Corasick matcher — over the scene
//! title + synopsis + intent + body so empty drafts still resolve codex via
//! their outline.

use anyhow::Result;
use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use rusqlite::Connection;
use schemars;
use serde::{Deserialize, Serialize};

use crate::convert::prosemirror_to_markdown;
use crate::db::{self, OpenForeshadowSummary, SceneTimelineNeighbors, TreeFilter, TreeNode};
use crate::server::{internal_err, GrimodexServer};

/// Hard caps so a large project cannot balloon the payload (same philosophy
/// as read_scenes_batch's 50-scene cap). Drops are reported, never silent.
pub(crate) const MAX_STORY_SO_FAR: usize = 50;
pub(crate) const MAX_MENTIONED_CODEX: usize = 30;
pub(crate) const MAX_ALWAYS_CODEX: usize = 20;
/// Codex summary fallback (from content) length in chars.
const CONTENT_FALLBACK_CHARS: usize = 200;
/// Mention candidates shorter than this (in chars) are ignored — single-char
/// names match practically every Japanese sentence.
const MIN_CANDIDATE_CHARS: usize = 2;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetWritingContextParams {
    /// Scene UUID to build the writing context for.
    pub scene_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextInfo {
    pub title: String,
    pub genre: Option<String>,
    pub pov: Option<String>,
    pub tense: Option<String>,
    pub language: String,
    pub style_guide: Option<String>,
    pub ai_instructions: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterOutline {
    pub title: String,
    pub outline: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorySynopsis {
    pub scene_id: String,
    pub title: String,
    pub synopsis: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneContext {
    pub id: String,
    pub title: String,
    pub synopsis: Option<String>,
    pub status: Option<String>,
    /// Author's stated goal for the scene (per-scene intent column).
    pub intent: Option<String>,
    /// Scene body as Markdown.
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneForeshadowRef {
    pub foreshadow_id: String,
    pub title: String,
    pub intent: Option<String>,
    pub load_bearing: Option<String>,
    /// "setup" (planted in this scene) or "payoff" (resolved in this scene).
    pub role: String,
    /// Setup kind (designated_existing 等)。payoff rows have none.
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexContextEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_slug: String,
    /// Summary; falls back to a content prefix when the summary is empty.
    pub summary: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexContextLayer {
    /// Entries whose name/alias appears in the scene title/synopsis/intent/body.
    pub mentioned: Vec<CodexContextEntry>,
    /// context_mode='always' entries not already in `mentioned`.
    pub always: Vec<CodexContextEntry>,
    pub mentioned_dropped: usize,
    pub always_dropped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingContext {
    pub project: ProjectContextInfo,
    /// Ancestor folder outlines (= synopsis), outermost first.
    pub chapter_outlines: Vec<ChapterOutline>,
    /// Preceding scenes (reading order, oldest first) that have a synopsis.
    pub story_so_far: Vec<StorySynopsis>,
    /// How many oldest preceding synopses were dropped by the cap.
    pub story_so_far_dropped: usize,
    pub scene: SceneContext,
    pub timeline_neighbors: SceneTimelineNeighbors,
    /// Foreshadows planted or resolved in this scene (secret excluded).
    pub scene_foreshadows: Vec<SceneForeshadowRef>,
    /// Project-wide unresolved foreshadows (secret excluded).
    pub open_foreshadows: Vec<OpenForeshadowSummary>,
    pub codex: CodexContextLayer,
}

/// Build the curated context. Returns `Ok(None)` when `scene_id` does not
/// resolve to a scene **in this project** (cross-project ids and folder ids
/// are indistinguishable from missing — XPROJ defense).
pub(crate) fn build_writing_context(
    _conn: &Connection,
    _project_id: &str,
    _scene_id: &str,
) -> Result<Option<WritingContext>> {
    anyhow::bail!("unimplemented")
}

pub async fn get_writing_context(
    server: &GrimodexServer,
    params: GetWritingContextParams,
) -> Result<CallToolResult, ErrorData> {
    let scene_id = params.scene_id.trim();
    if scene_id.is_empty() {
        return Err(ErrorData::invalid_params("scene_id is required", None));
    }
    let conn = server.conn.lock().map_err(internal_err)?;
    let ctx = build_writing_context(&conn, &server.project_id(), scene_id)
        .map_err(internal_err)?
        .ok_or_else(|| ErrorData::invalid_params("scene not found in project", None))?;
    drop(conn);
    let json = serde_json::to_string_pretty(&ctx).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![rmcp::model::Content::text(
        json,
    )]))
}

// Keep imports referenced by the (not yet written) implementation so the red
// skeleton compiles warning-clean enough to run tests.
#[allow(unused_imports)]
use prosemirror_to_markdown as _pm2md;
#[allow(unused_imports)]
use TreeFilter as _tf;
#[allow(unused_imports)]
use TreeNode as _tn;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::make_simple_db;
    use rusqlite::{params, Connection};

    // ---------------- fixture helpers ----------------

    fn seed_project(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO projects (id, title, genre, language) VALUES (?1, ?2, 'fantasy', 'ja')",
            params![id, title],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_node(
        conn: &Connection,
        id: &str,
        project_id: &str,
        parent_id: Option<&str>,
        node_type: &str,
        title: &str,
        synopsis: Option<&str>,
        sort_order: &str,
        content: &str,
    ) {
        conn.execute(
            "INSERT INTO tree_nodes
             (id, project_id, parent_id, node_type, title, synopsis, sort_order, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, project_id, parent_id, node_type, title, synopsis, sort_order, content],
        )
        .unwrap();
    }

    fn pm_doc(text: &str) -> String {
        serde_json::json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": text}]}
            ]
        })
        .to_string()
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_codex(
        conn: &Connection,
        id: &str,
        project_id: &str,
        name: &str,
        aliases: Option<&str>,
        excluded_aliases: Option<&str>,
        summary: Option<&str>,
        content: &str,
        context_mode: &str,
    ) {
        conn.execute(
            "INSERT INTO codex_entries
             (id, project_id, type, name, aliases, excluded_aliases, summary, content, context_mode)
             VALUES (?1, ?2, 'character', ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                project_id,
                name,
                aliases,
                excluded_aliases,
                summary,
                content,
                context_mode
            ],
        )
        .unwrap();
    }

    fn seed_foreshadow(conn: &Connection, id: &str, project_id: &str, title: &str, secret: bool) {
        conn.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, intent, secret, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'intent', ?4, 1, 1)",
            params![id, project_id, title, secret as i64],
        )
        .unwrap();
    }

    fn seed_setup(conn: &Connection, id: &str, foreshadow_id: &str, scene_id: &str) {
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, 1)",
            params![id, foreshadow_id, scene_id],
        )
        .unwrap();
    }

    /// Minimal happy-path world: one project, one scene with body text.
    fn basic_world() -> Connection {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "My Novel");
        seed_node(
            &conn,
            "s1",
            "p1",
            None,
            "scene",
            "第一話",
            Some("アリスが旅立つ"),
            "a0",
            &pm_doc("アリスは森を歩いた。"),
        );
        conn
    }

    // ---------------- not-found / scoping ----------------

    #[test]
    fn unknown_scene_returns_none() {
        let conn = basic_world();
        let res = build_writing_context(&conn, "p1", "ghost").unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn cross_project_scene_returns_none() {
        let conn = basic_world();
        seed_project(&conn, "p2", "Other Novel");
        seed_node(
            &conn,
            "x1",
            "p2",
            None,
            "scene",
            "他作シーン",
            None,
            "a0",
            "{}",
        );
        // XPROJ: a scene id from another project must be indistinguishable
        // from a missing scene.
        let res = build_writing_context(&conn, "p1", "x1").unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn folder_id_returns_none() {
        let conn = basic_world();
        seed_node(&conn, "f1", "p1", None, "folder", "章", None, "a1", "{}");
        let res = build_writing_context(&conn, "p1", "f1").unwrap();
        assert!(res.is_none());
    }

    // ---------------- minimal layers ----------------

    #[test]
    fn minimal_world_builds_all_layers() {
        let conn = basic_world();
        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        assert_eq!(ctx.project.title, "My Novel");
        assert_eq!(ctx.project.genre.as_deref(), Some("fantasy"));
        assert!(ctx.chapter_outlines.is_empty());
        assert!(ctx.story_so_far.is_empty());
        assert_eq!(ctx.story_so_far_dropped, 0);
        assert_eq!(ctx.scene.id, "s1");
        assert_eq!(ctx.scene.title, "第一話");
        assert_eq!(ctx.scene.synopsis.as_deref(), Some("アリスが旅立つ"));
        assert!(ctx.scene.content.contains("アリスは森を歩いた。"));
        assert!(ctx.scene_foreshadows.is_empty());
        assert!(ctx.open_foreshadows.is_empty());
        assert!(ctx.codex.mentioned.is_empty());
        assert!(ctx.codex.always.is_empty());
    }

    // ---------------- story so far ----------------

    #[test]
    fn story_so_far_is_reading_order_with_synopsis_filter() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        // folder A (a0): s1 (synopsis), s2 (no synopsis)
        seed_node(&conn, "fa", "p1", None, "folder", "A章", None, "a0", "{}");
        seed_node(
            &conn,
            "s1",
            "p1",
            Some("fa"),
            "scene",
            "S1",
            Some("syn1"),
            "a0",
            "{}",
        );
        seed_node(
            &conn,
            "s2",
            "p1",
            Some("fa"),
            "scene",
            "S2",
            None,
            "a1",
            "{}",
        );
        // folder B (a1): s3 (synopsis), current s4, s5 after current (synopsis)
        seed_node(&conn, "fb", "p1", None, "folder", "B章", None, "a1", "{}");
        seed_node(
            &conn,
            "s3",
            "p1",
            Some("fb"),
            "scene",
            "S3",
            Some("syn3"),
            "a0",
            "{}",
        );
        seed_node(
            &conn,
            "s4",
            "p1",
            Some("fb"),
            "scene",
            "S4",
            None,
            "a1",
            "{}",
        );
        seed_node(
            &conn,
            "s5",
            "p1",
            Some("fb"),
            "scene",
            "S5",
            Some("syn5"),
            "a2",
            "{}",
        );

        let ctx = build_writing_context(&conn, "p1", "s4").unwrap().unwrap();
        let ids: Vec<&str> = ctx
            .story_so_far
            .iter()
            .map(|s| s.scene_id.as_str())
            .collect();
        // s1 (earlier folder) precedes s3; s2 dropped (no synopsis); s5 is after.
        assert_eq!(ids, vec!["s1", "s3"]);
        assert_eq!(ctx.story_so_far[0].synopsis, "syn1");
        assert_eq!(ctx.story_so_far_dropped, 0);
    }

    #[test]
    fn story_so_far_cap_drops_oldest_and_reports() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        for i in 0..52 {
            seed_node(
                &conn,
                &format!("s{i:03}"),
                "p1",
                None,
                "scene",
                &format!("S{i}"),
                Some(&format!("syn{i}")),
                &format!("a{i:03}"),
                "{}",
            );
        }
        seed_node(&conn, "cur", "p1", None, "scene", "Cur", None, "a999", "{}");

        let ctx = build_writing_context(&conn, "p1", "cur").unwrap().unwrap();
        assert_eq!(ctx.story_so_far.len(), MAX_STORY_SO_FAR);
        assert_eq!(ctx.story_so_far_dropped, 2);
        // The two OLDEST are dropped; the kept list still ends at the most recent.
        assert_eq!(ctx.story_so_far.first().unwrap().scene_id, "s002");
        assert_eq!(ctx.story_so_far.last().unwrap().scene_id, "s051");
    }

    // ---------------- chapter outlines ----------------

    #[test]
    fn chapter_outlines_outermost_first_skipping_empty() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(
            &conn,
            "vol",
            "p1",
            None,
            "folder",
            "第一部",
            Some("部のあらすじ"),
            "a0",
            "{}",
        );
        seed_node(
            &conn,
            "mid",
            "p1",
            Some("vol"),
            "folder",
            "中間",
            None,
            "a0",
            "{}",
        );
        seed_node(
            &conn,
            "ch",
            "p1",
            Some("mid"),
            "folder",
            "第一章",
            Some("章のあらすじ"),
            "a0",
            "{}",
        );
        seed_node(
            &conn,
            "s1",
            "p1",
            Some("ch"),
            "scene",
            "S1",
            None,
            "a0",
            "{}",
        );

        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        let titles: Vec<&str> = ctx
            .chapter_outlines
            .iter()
            .map(|c| c.title.as_str())
            .collect();
        assert_eq!(titles, vec!["第一部", "第一章"]); // outermost first, "中間" skipped
        assert_eq!(ctx.chapter_outlines[0].outline, "部のあらすじ");
    }

    // ---------------- codex ----------------

    #[test]
    fn codex_mention_alias_always_hidden_and_exclusion() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(
            &conn,
            "s1",
            "p1",
            None,
            "scene",
            "S1",
            None,
            "a0",
            &pm_doc("アリスはB男とすれ違い、フーの噂を聞いた。イヴの影もあった。"),
        );
        // name mention
        seed_codex(
            &conn,
            "c1",
            "p1",
            "アリス",
            None,
            None,
            Some("主人公"),
            "{}",
            "mentioned",
        );
        // alias mention
        seed_codex(
            &conn,
            "c2",
            "p1",
            "ボブ",
            Some(r#"["B男"]"#),
            None,
            Some("相棒"),
            "{}",
            "mentioned",
        );
        // always, not mentioned
        seed_codex(
            &conn,
            "c3",
            "p1",
            "クララ",
            None,
            None,
            Some("黒幕"),
            "{}",
            "always",
        );
        // not mentioned, mentioned mode → absent
        seed_codex(
            &conn,
            "c4",
            "p1",
            "ダン",
            None,
            None,
            Some("脇役"),
            "{}",
            "mentioned",
        );
        // mentioned in text but hidden → absent
        seed_codex(
            &conn,
            "c5",
            "p1",
            "イヴ",
            None,
            None,
            Some("秘匿"),
            "{}",
            "hidden",
        );
        // alias would match but is excluded → absent
        seed_codex(
            &conn,
            "c6",
            "p1",
            "フランク",
            Some(r#"["フー"]"#),
            Some(r#"["フー"]"#),
            Some("除外"),
            "{}",
            "mentioned",
        );
        // always AND mentioned by name → appears once, in mentioned
        seed_codex(
            &conn,
            "c7",
            "p1",
            "イヴリン",
            None,
            None,
            Some("常駐"),
            "{}",
            "always",
        );
        conn.execute(
            "UPDATE tree_nodes SET content = ?1 WHERE id = 's1'",
            params![pm_doc(
                "アリスはB男とすれ違い、フーの噂を聞いた。イヴの影とイヴリンの声。"
            )],
        )
        .unwrap();

        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        let mentioned: Vec<&str> = ctx.codex.mentioned.iter().map(|e| e.id.as_str()).collect();
        let always: Vec<&str> = ctx.codex.always.iter().map(|e| e.id.as_str()).collect();
        assert!(mentioned.contains(&"c1"), "name mention: {mentioned:?}");
        assert!(mentioned.contains(&"c2"), "alias mention: {mentioned:?}");
        assert!(
            mentioned.contains(&"c7"),
            "always+mentioned lands in mentioned: {mentioned:?}"
        );
        assert!(!mentioned.contains(&"c4"), "unmentioned must be absent");
        assert!(!mentioned.contains(&"c5"), "hidden must never match");
        assert!(!mentioned.contains(&"c6"), "excluded alias must not match");
        assert_eq!(
            always,
            vec!["c3"],
            "always layer = always-mode minus mentioned"
        );
        assert_eq!(ctx.codex.mentioned_dropped, 0);
        assert_eq!(ctx.codex.always_dropped, 0);
    }

    #[test]
    fn codex_summary_falls_back_to_content_prefix() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(
            &conn,
            "s1",
            "p1",
            None,
            "scene",
            "S1",
            None,
            "a0",
            &pm_doc("アリス登場"),
        );
        seed_codex(
            &conn,
            "c1",
            "p1",
            "アリス",
            None,
            None,
            None,
            &pm_doc("没落した家の長女。剣を学んだ。"),
            "mentioned",
        );
        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        assert_eq!(ctx.codex.mentioned.len(), 1);
        assert!(
            ctx.codex.mentioned[0].summary.contains("没落した家の長女"),
            "summary fallback should use content text, got: {}",
            ctx.codex.mentioned[0].summary
        );
    }

    #[test]
    fn mention_scan_covers_synopsis_when_body_is_empty() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        // Drafting flow: body empty, but the synopsis names a character.
        seed_node(
            &conn,
            "s1",
            "p1",
            None,
            "scene",
            "S1",
            Some("アリスが帰還する"),
            "a0",
            "{}",
        );
        seed_codex(
            &conn,
            "c1",
            "p1",
            "アリス",
            None,
            None,
            Some("主人公"),
            "{}",
            "mentioned",
        );
        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        assert_eq!(ctx.codex.mentioned.len(), 1);
        assert_eq!(ctx.codex.mentioned[0].id, "c1");
    }

    #[test]
    fn single_char_candidates_are_ignored() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(
            &conn,
            "s1",
            "p1",
            None,
            "scene",
            "S1",
            None,
            "a0",
            &pm_doc("光が差した。"),
        );
        seed_codex(
            &conn,
            "c1",
            "p1",
            "光",
            None,
            None,
            Some("一文字名"),
            "{}",
            "mentioned",
        );
        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        assert!(
            ctx.codex.mentioned.is_empty(),
            "1-char names must not match"
        );
    }

    // ---------------- foreshadows ----------------

    #[test]
    fn scene_foreshadows_setup_payoff_and_secret_exclusion() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(&conn, "s1", "p1", None, "scene", "S1", None, "a0", "{}");
        // non-secret with a setup in this scene
        seed_foreshadow(&conn, "f1", "p1", "刻印の謎", false);
        seed_setup(&conn, "su1", "f1", "s1");
        // secret with a setup in this scene → must be invisible
        seed_foreshadow(&conn, "f2", "p1", "黒幕の正体", true);
        seed_setup(&conn, "su2", "f2", "s1");
        // non-secret paid off in this scene
        seed_foreshadow(&conn, "f3", "p1", "古い約束", false);
        conn.execute(
            "UPDATE foreshadows SET payoff_scene_id = 's1' WHERE id = 'f3'",
            [],
        )
        .unwrap();

        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        let roles: Vec<(&str, &str)> = ctx
            .scene_foreshadows
            .iter()
            .map(|f| (f.foreshadow_id.as_str(), f.role.as_str()))
            .collect();
        assert!(roles.contains(&("f1", "setup")), "got: {roles:?}");
        assert!(roles.contains(&("f3", "payoff")), "got: {roles:?}");
        assert!(
            !roles.iter().any(|(id, _)| *id == "f2"),
            "secret foreshadow leaked: {roles:?}"
        );
        // open_foreshadows integration: f1/f3 open & non-secret; f2 excluded.
        let open_ids: Vec<&str> = ctx.open_foreshadows.iter().map(|f| f.id.as_str()).collect();
        assert!(open_ids.contains(&"f1"));
        assert!(!open_ids.contains(&"f2"), "secret leaked into open list");
    }

    // ---------------- timeline neighbors ----------------

    #[test]
    fn timeline_neighbors_are_included() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(
            &conn,
            "s1",
            "p1",
            None,
            "scene",
            "過去",
            Some("過去の話"),
            "a0",
            "{}",
        );
        seed_node(&conn, "s2", "p1", None, "scene", "現在", None, "a1", "{}");
        seed_node(
            &conn,
            "s3",
            "p1",
            None,
            "scene",
            "未来",
            Some("未来の話"),
            "a2",
            "{}",
        );
        conn.execute(
            "UPDATE tree_nodes SET story_time_order = 'a0', story_time_label = '一日目'
             WHERE id = 's1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE tree_nodes SET story_time_order = 'a1', story_time_label = '二日目'
             WHERE id = 's2'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE tree_nodes SET story_time_order = 'a2', story_time_label = '三日目'
             WHERE id = 's3'",
            [],
        )
        .unwrap();

        let ctx = build_writing_context(&conn, "p1", "s2").unwrap().unwrap();
        assert_eq!(
            ctx.timeline_neighbors
                .current_scene_story_time_label
                .as_deref(),
            Some("二日目")
        );
        assert_eq!(ctx.timeline_neighbors.previous.len(), 1);
        assert_eq!(ctx.timeline_neighbors.next.len(), 1);
        assert_eq!(ctx.timeline_neighbors.previous[0].id, "s1");
        assert_eq!(ctx.timeline_neighbors.next[0].id, "s3");
    }

    // ---------------- scene intent ----------------

    #[test]
    fn scene_intent_is_exposed_and_scanned_for_mentions() {
        let conn = make_simple_db();
        seed_project(&conn, "p1", "N");
        seed_node(&conn, "s1", "p1", None, "scene", "S1", None, "a0", "{}");
        conn.execute(
            "UPDATE tree_nodes SET intent = 'アリスの覚悟を描く' WHERE id = 's1'",
            [],
        )
        .unwrap();
        seed_codex(
            &conn,
            "c1",
            "p1",
            "アリス",
            None,
            None,
            Some("主人公"),
            "{}",
            "mentioned",
        );

        let ctx = build_writing_context(&conn, "p1", "s1").unwrap().unwrap();
        assert_eq!(ctx.scene.intent.as_deref(), Some("アリスの覚悟を描く"));
        assert_eq!(
            ctx.codex.mentioned.len(),
            1,
            "intent text participates in mention scan"
        );
    }
}
