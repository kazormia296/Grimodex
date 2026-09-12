//! Shell-independent sample-workspace seeding shared by desktop shells.

use serde::{Deserialize, Serialize};

use crate::{workspace, AppResult, Database, GlobalSettingsPath};

const SEED_V2: &str = include_str!("../../../resources/sample_project/v2.json");
const SEED_V2_EN: &str = include_str!("../../../resources/sample_project/v2_en.json");
const SEED_V2_EXTRA: &str = include_str!("../../../resources/sample_project/v2.sql");
const SEED_V2_EXTRA_EN: &str = include_str!("../../../resources/sample_project/v2_en.sql");

#[derive(Clone, Copy)]
struct SeedBundle {
    json: &'static str,
    extra_sql: &'static str,
    language: &'static str,
}

/// Select the embedded sample whose authored language matches the UI language.
/// Unknown languages fall back to the Japanese sample so Codex labels and prose
/// never end up in a mixed-language half-state.
fn select_seed(language: &str) -> SeedBundle {
    match language {
        "en" => SeedBundle {
            json: SEED_V2_EN,
            extra_sql: SEED_V2_EXTRA_EN,
            language: "en",
        },
        _ => SeedBundle {
            json: SEED_V2,
            extra_sql: SEED_V2_EXTRA,
            language: "ja",
        },
    }
}

/// Count body characters in a scene's ProseMirror JSON, excluding `sceneBeat`
/// subtrees. This mirrors the frontend body counter and uses UTF-16 length to
/// match JavaScript `String.length`.
fn count_scene_body_chars(content: &str) -> i64 {
    fn walk(node: &serde_json::Value, count: &mut i64) {
        let node_type = node.get("type").and_then(|value| value.as_str());
        if node_type == Some("sceneBeat") {
            return;
        }
        if node_type == Some("text") {
            if let Some(text) = node.get("text").and_then(|value| value.as_str()) {
                *count += text.encode_utf16().count() as i64;
            }
        }
        if let Some(children) = node.get("content").and_then(|value| value.as_array()) {
            for child in children {
                walk(child, count);
            }
        }
    }

    let doc: serde_json::Value = match serde_json::from_str(content) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    let mut count = 0;
    walk(&doc, &mut count);
    count
}

// ---------------------------------------------------------------------------
// JSON seed data shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SeedProject {
    id: String,
    title: String,
    #[serde(default)]
    genre: Option<String>,
    #[serde(default)]
    ai_instructions: Option<String>,
}

#[derive(Deserialize)]
struct SeedTreeNode {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    title: String,
    #[serde(default)]
    synopsis: Option<String>,
    sort_order: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    story_time_order: Option<String>,
    #[serde(default)]
    story_time_label: Option<String>,
}

#[derive(Deserialize)]
struct SeedCodexEntry {
    id: String,
    #[serde(rename = "type")]
    entry_type: String,
    name: String,
    #[serde(default)]
    aliases: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    context_mode: Option<String>,
}

#[derive(Deserialize)]
struct SeedChatSession {
    id: String,
    #[serde(default)]
    node_id: Option<String>,
    title: String,
    model: String,
}

#[derive(Deserialize)]
struct SeedChatMessage {
    id: String,
    session_id: String,
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct SeedForeshadow {
    id: String,
    title: String,
    #[serde(default)]
    intent: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    payoff_scene_id: Option<String>,
}

#[derive(Deserialize)]
struct SeedSnippet {
    id: String,
    title: String,
    content: String,
    #[serde(default)]
    content_source: Option<String>,
}

#[derive(Deserialize)]
struct SeedForeshadowSetup {
    id: String,
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
    kind: String,
    #[serde(default)]
    strength: Option<String>,
    attribution: String,
}

#[derive(Deserialize)]
struct SeedAuthorshipSpan {
    id: String,
    node_id: String,
    from_pos: i64,
    to_pos: i64,
    source: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

#[derive(Deserialize)]
struct SeedData {
    project: SeedProject,
    tree_nodes: Vec<SeedTreeNode>,
    codex_entries: Vec<SeedCodexEntry>,
    chat_sessions: Vec<SeedChatSession>,
    chat_messages: Vec<SeedChatMessage>,
    foreshadows: Vec<SeedForeshadow>,
    #[serde(default)]
    snippets: Vec<SeedSnippet>,
    #[serde(default)]
    foreshadow_setups: Vec<SeedForeshadowSetup>,
    #[serde(default)]
    authorship_spans: Vec<SeedAuthorshipSpan>,
}

// ---------------------------------------------------------------------------
// Shared insertion
// ---------------------------------------------------------------------------

fn insert_seed_rows(
    conn: &rusqlite::Connection,
    seed: &SeedData,
    sample_language: &str,
    ai_policy: &str,
    now_dt: &str,
    now_ms: i64,
    extra_seed_src: &str,
) -> rusqlite::Result<()> {
    let project_id = &seed.project.id;

    // Migration creates `default-project`; replacing it also recreates the
    // project-scoped builtin Codex types and default Map board through triggers.
    conn.execute(
        "INSERT OR REPLACE INTO projects
            (id, title, genre, language, ai_instructions, ai_policy, is_sample, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
        rusqlite::params![
            project_id,
            seed.project.title,
            seed.project.genre,
            sample_language,
            seed.project.ai_instructions,
            ai_policy,
            now_dt,
        ],
    )?;

    // Keep the portable, prose-heavy records in language-specific JSON.
    for node in &seed.tree_nodes {
        let content = node
            .content
            .clone()
            .unwrap_or_else(|| r#"{"type":"doc","content":[]}"#.to_string());
        let char_count = count_scene_body_chars(&content);
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, synopsis, sort_order,
                 status, content, char_count, story_time_order, story_time_label,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            rusqlite::params![
                node.id,
                project_id,
                node.parent_id,
                node.node_type,
                node.title,
                node.synopsis,
                node.sort_order,
                node.status,
                content,
                char_count,
                node.story_time_order,
                node.story_time_label,
                now_dt,
            ],
        )?;
    }

    for entry in &seed.codex_entries {
        let content = entry
            .content
            .clone()
            .unwrap_or_else(|| r#"{"type":"doc","content":[]}"#.to_string());
        let context_mode = entry
            .context_mode
            .clone()
            .unwrap_or_else(|| "mentioned".to_string());
        conn.execute(
            "INSERT INTO codex_entries
                (id, project_id, type, name, aliases, summary, content, notes,
                 context_mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            rusqlite::params![
                entry.id,
                project_id,
                entry.entry_type,
                entry.name,
                entry.aliases,
                entry.summary,
                content,
                entry.notes,
                context_mode,
                now_dt,
            ],
        )?;
    }

    for session in &seed.chat_sessions {
        conn.execute(
            "INSERT INTO chat_sessions
                (id, project_id, node_id, title, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![
                session.id,
                project_id,
                session.node_id,
                session.title,
                session.model,
                now_dt,
            ],
        )?;
    }

    for message in &seed.chat_messages {
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                message.id,
                message.session_id,
                message.role,
                message.content,
                now_dt,
            ],
        )?;
    }

    for foreshadow in &seed.foreshadows {
        conn.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, intent, notes, payoff_scene_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            rusqlite::params![
                foreshadow.id,
                project_id,
                foreshadow.title,
                foreshadow.intent,
                foreshadow.notes,
                foreshadow.payoff_scene_id,
                now_ms,
            ],
        )?;
    }

    for snippet in &seed.snippets {
        conn.execute(
            "INSERT INTO snippets
                (id, project_id, title, content, content_source, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![
                snippet.id,
                project_id,
                snippet.title,
                snippet.content,
                snippet.content_source,
                now_dt,
            ],
        )?;
    }

    for setup in &seed.foreshadow_setups {
        conn.execute(
            "INSERT INTO foreshadow_setups
                (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
                 attribution, is_orphan, semantic_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?10)",
            rusqlite::params![
                setup.id,
                setup.foreshadow_id,
                setup.scene_id,
                setup.from_pos,
                setup.to_pos,
                setup.kind,
                setup.strength,
                setup.attribution,
                format!(
                    "{}|{}|{}|{}",
                    setup.foreshadow_id, setup.scene_id, setup.from_pos, setup.to_pos
                ),
                now_ms,
            ],
        )?;
    }

    for span in &seed.authorship_spans {
        conn.execute(
            "INSERT INTO authorship_spans
                (id, node_id, from_pos, to_pos, source, model, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                span.id,
                span.node_id,
                span.from_pos,
                span.to_pos,
                span.source,
                span.model,
                span.timestamp,
            ],
        )?;
    }

    // Relational feature demonstrations are easier to audit as SQL: Codex
    // details/phases, Grid/Matrix links, Timeline, Chronicle, Map, lint history,
    // versions, Editor stickies, and Trash all live here. The SQL runs only
    // after every referenced base entity exists.
    conn.execute_batch(extra_seed_src)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared result and synchronous implementation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeedResult {
    pub path: String,
    pub project_id: String,
}

/// Removes a generation that failed before its path was committed to global
/// settings. Published generations are retained because a desktop backend or
/// external MCP process may still hold their database open.
struct UnpublishedGeneration {
    path: std::path::PathBuf,
    published: bool,
}

impl UnpublishedGeneration {
    fn new(path: std::path::PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }

    fn mark_published(&mut self) {
        self.published = true;
    }
}

impl Drop for UnpublishedGeneration {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// Create a fresh sample workspace under AppData, seed it, and publish its path
/// to global settings. The caller opens the returned workspace afterwards.
pub fn seed_sample_workspace(
    gs_path: &GlobalSettingsPath,
    language: &str,
    ai_policy: &str,
) -> AppResult<SeedResult> {
    let _gs_guard = gs_path
        .write_lock
        .lock()
        .map_err(|error| anyhow::anyhow!("{error}"))?;

    let app_dir = gs_path
        .path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine AppData directory"))?;

    let generation_id = uuid::Uuid::new_v4().to_string();
    let ws_path = app_dir.join(format!("sample-workspace-{generation_id}"));
    std::fs::create_dir_all(&ws_path).map_err(anyhow::Error::from)?;
    let mut unpublished_generation = UnpublishedGeneration::new(ws_path.clone());

    let db = Database::new(&ws_path.join("grimodex.db"))?;
    db.migrate()?;

    let bundle = select_seed(language);
    let seed: SeedData = serde_json::from_str(bundle.json).map_err(anyhow::Error::from)?;
    let project_id = seed.project.id.clone();
    let now_dt = chrono::Utc::now().to_rfc3339();
    let now_ms = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        insert_seed_rows(
            conn,
            &seed,
            bundle.language,
            ai_policy,
            &now_dt,
            now_ms,
            bundle.extra_sql,
        )?;
        Ok(())
    })?;

    let ws_path_str = ws_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Non-UTF-8 workspace path"))?
        .to_string();
    workspace::ensure_workspace_meta(&ws_path, &generation_id, &now_dt)?;

    let mut settings = workspace::read_global_settings(&gs_path.path);
    settings.sample_workspace_path = Some(ws_path_str.clone());
    workspace::write_global_settings(&gs_path.path, &settings)?;
    unpublished_generation.mark_published();

    Ok(SeedResult {
        path: ws_path_str,
        project_id,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_AI_POLICY: &str = r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}"#;

    fn make_test_db() -> Database {
        crate::test_support::current_schema_memory().expect("current-schema fixture")
    }

    fn parse_seed(src: &str) -> SeedData {
        serde_json::from_str(src).expect("sample JSON must parse")
    }

    #[test]
    fn seed_v2_assets_are_valid() {
        for (name, json, sql) in [
            ("v2", SEED_V2, SEED_V2_EXTRA),
            ("v2_en", SEED_V2_EN, SEED_V2_EXTRA_EN),
        ] {
            let seed: SeedData = serde_json::from_str(json)
                .unwrap_or_else(|error| panic!("{name}.json failed to parse: {error}"));
            assert_eq!(seed.project.id, "default-project", "{name} project id");
            assert!(seed.tree_nodes.len() >= 10, "{name} tree_nodes");
            assert!(seed.codex_entries.len() >= 10, "{name} codex_entries");
            assert!(seed.chat_sessions.len() >= 2, "{name} chat_sessions");
            assert!(seed.foreshadows.len() >= 4, "{name} foreshadows");
            assert!(!sql.trim().is_empty(), "{name}.sql must not be empty");
        }
    }

    #[test]
    fn select_seed_picks_language() {
        let en = select_seed("en");
        assert_eq!(en.language, "en");
        assert_eq!(en.json, SEED_V2_EN);
        assert_eq!(en.extra_sql, SEED_V2_EXTRA_EN);

        let ja = select_seed("ja");
        assert_eq!(ja.language, "ja");
        assert_eq!(ja.json, SEED_V2);
        assert_eq!(ja.extra_sql, SEED_V2_EXTRA);

        let fallback = select_seed("zh");
        assert_eq!(fallback.language, "ja");
        assert_eq!(fallback.json, SEED_V2);
        assert_eq!(fallback.extra_sql, SEED_V2_EXTRA);
    }

    #[test]
    fn seed_en_matches_ja_structure() {
        let ja = parse_seed(SEED_V2);
        let en = parse_seed(SEED_V2_EN);

        let count_kind = |seed: &SeedData, kind: &str| {
            seed.tree_nodes
                .iter()
                .filter(|node| node.node_type == kind)
                .count()
        };

        assert_eq!(en.tree_nodes.len(), ja.tree_nodes.len(), "tree_nodes");
        assert_eq!(count_kind(&en, "scene"), count_kind(&ja, "scene"));
        assert_eq!(count_kind(&en, "folder"), count_kind(&ja, "folder"));
        assert_eq!(count_kind(&en, "note"), count_kind(&ja, "note"));
        assert_eq!(en.codex_entries.len(), ja.codex_entries.len(), "codex");
        assert_eq!(en.chat_sessions.len(), ja.chat_sessions.len(), "sessions");
        assert_eq!(en.chat_messages.len(), ja.chat_messages.len(), "messages");
        assert_eq!(en.foreshadows.len(), ja.foreshadows.len(), "foreshadows");
        assert_eq!(en.snippets.len(), ja.snippets.len(), "snippets");
        assert_eq!(
            en.foreshadow_setups.len(),
            ja.foreshadow_setups.len(),
            "foreshadow_setups"
        );
        assert_eq!(
            en.authorship_spans.len(),
            ja.authorship_spans.len(),
            "authorship_spans"
        );
    }

    /// Extract text covered by a ProseMirror range. The document itself does not
    /// consume positions; every non-text descendant contributes open/close
    /// tokens, and each text character contributes one position.
    fn pm_text_between(content: &str, from: i64, to: i64) -> String {
        fn walk(
            node: &serde_json::Value,
            is_doc: bool,
            pos: &mut i64,
            from: i64,
            to: i64,
            out: &mut String,
        ) {
            if node.get("type").and_then(|value| value.as_str()) == Some("text") {
                if let Some(text) = node.get("text").and_then(|value| value.as_str()) {
                    for ch in text.chars() {
                        if *pos >= from && *pos < to {
                            out.push(ch);
                        }
                        *pos += 1;
                    }
                }
                return;
            }

            if !is_doc {
                *pos += 1;
            }
            if let Some(children) = node.get("content").and_then(|value| value.as_array()) {
                for child in children {
                    walk(child, false, pos, from, to, out);
                }
            }
            if !is_doc {
                *pos += 1;
            }
        }

        let doc: serde_json::Value = serde_json::from_str(content).unwrap();
        let mut pos = 0;
        let mut out = String::new();
        walk(&doc, true, &mut pos, from, to, &mut out);
        out
    }

    fn scene_content(seed: &SeedData, id: &str) -> String {
        seed.tree_nodes
            .iter()
            .find(|node| node.id == id)
            .and_then(|node| node.content.clone())
            .unwrap_or_else(|| panic!("scene {id} missing"))
    }

    #[test]
    fn foreshadow_setups_anchor_expected_text() {
        let check = |src: &str, expected: &[(&str, &str)]| {
            let seed = parse_seed(src);
            for (setup_id, expected_text) in expected {
                let setup = seed
                    .foreshadow_setups
                    .iter()
                    .find(|setup| &setup.id == setup_id)
                    .unwrap_or_else(|| panic!("setup {setup_id} missing"));
                let got = pm_text_between(
                    &scene_content(&seed, &setup.scene_id),
                    setup.from_pos,
                    setup.to_pos,
                );
                assert_eq!(&got, expected_text, "{setup_id} anchor text drifted");
            }
        };

        check(
            SEED_V2,
            &[
                ("sample-setup-rope", "今夜、鐘は鳴りません"),
                ("sample-setup-cup", "縁の欠けた青磁のカップ"),
                ("sample-setup-watch", "針は十一時四十七分で止まっていた"),
                ("sample-setup-key", "真鍮の予備鍵"),
                ("sample-setup-bell", "零時の鐘を聞いた"),
            ],
        );
        check(
            SEED_V2_EN,
            &[
                ("sample-setup-rope", "The bell will not ring tonight"),
                ("sample-setup-cup", "a chipped celadon cup"),
                ("sample-setup-watch", "Its hands had stopped at 11:47"),
                ("sample-setup-key", "a brass spare key"),
                ("sample-setup-bell", "heard the midnight bell"),
            ],
        );
    }

    #[test]
    fn guide_note_covers_major_feature_surfaces() {
        let check = |src: &str, expected_terms: &[&str]| {
            let seed = parse_seed(src);
            let guide = scene_content(&seed, "sample-note-guide");
            for term in expected_terms {
                assert!(guide.contains(term), "guide must explain {term}");
            }
        };

        let common = [
            "Scenes",
            "Editor",
            "Beat",
            "Grid",
            "Matrix",
            "Timeline",
            "Chronicle",
            "Codex",
            "Codex Quick",
            "Map",
            "Chat",
            "Snippet",
            "Foreshadow",
            "Writing Stats",
            "Export",
        ];
        check(SEED_V2, &common);
        check(SEED_V2_EN, &common);
        check(SEED_V2, &["校閲", "帰属", "文屑箱"]);
        check(SEED_V2_EN, &["Review", "Attribution", "Trash"]);
    }

    fn seed_test_database(src: &str, extra_sql: &str, language: &str) -> (Database, SeedData) {
        let db = make_test_db();
        let seed = parse_seed(src);
        let now_dt = chrono::Utc::now().to_rfc3339();
        let now_ms = chrono::Utc::now().timestamp_millis();
        db.with_conn(|conn| {
            insert_seed_rows(
                conn,
                &seed,
                language,
                FULL_AI_POLICY,
                &now_dt,
                now_ms,
                extra_sql,
            )?;
            Ok(())
        })
        .expect("seed inserts");
        (db, seed)
    }

    #[test]
    fn seed_inserts_rich_feature_data() {
        for (src, extra_sql, language) in [
            (SEED_V2, SEED_V2_EXTRA, "ja"),
            (SEED_V2_EN, SEED_V2_EXTRA_EN, "en"),
        ] {
            let (db, seed) = seed_test_database(src, extra_sql, language);
            let project_id = &seed.project.id;

            db.with_conn(|conn| {
                let scalar = |sql: &str| -> rusqlite::Result<i64> {
                    conn.query_row(sql, [], |row| row.get(0))
                };

                let node_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE project_id = ?1",
                    [project_id],
                    |row| row.get(0),
                )?;
                assert_eq!(
                    node_count,
                    seed.tree_nodes.len() as i64 + 1,
                    "base nodes plus archived example"
                );

                let codex_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM codex_entries WHERE project_id = ?1",
                    [project_id],
                    |row| row.get(0),
                )?;
                assert_eq!(codex_count, seed.codex_entries.len() as i64);

                let message_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.project_id=?1",
                    [project_id],
                    |row| row.get(0),
                )?;
                assert_eq!(message_count, seed.chat_messages.len() as i64);

                assert!(scalar("SELECT COUNT(*) FROM labels")? >= 7, "labels");
                assert!(scalar("SELECT COUNT(*) FROM plot_threads")? >= 4, "timeline threads");
                assert!(scalar("SELECT COUNT(*) FROM events")? >= 8, "chronicle events");
                assert!(scalar("SELECT COUNT(*) FROM map_node_positions")? >= 15, "map nodes");
                assert!(scalar("SELECT COUNT(*) FROM map_edges")? >= 8, "map edges");
                assert_eq!(scalar("SELECT COUNT(*) FROM editor_stickies")?, 1);
                assert!(scalar("SELECT COUNT(*) FROM lint_term_dictionary")? >= 5);
                assert!(scalar("SELECT COUNT(*) FROM content_versions")? >= 3);
                assert!(scalar("SELECT COUNT(*) FROM project_snapshots")? >= 1);
                assert!(scalar("SELECT COUNT(*) FROM trash_items")? >= 2);
                assert!(scalar("SELECT COUNT(*) FROM codex_entry_phases")? >= 2);
                assert!(scalar("SELECT COUNT(*) FROM scene_beat_pov_cache")? >= 4);

                let ai_len: i64 = conn.query_row(
                    "SELECT COALESCE(SUM(to_pos-from_pos),0) FROM authorship_spans WHERE source='ai'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(ai_len > 0, "sample must demonstrate AI attribution");
                Ok(())
            })
            .expect("verify rich sample");
        }
    }

    fn ai_span_count(seed: &SeedData) -> usize {
        seed.authorship_spans
            .iter()
            .filter(|span| span.source == "ai")
            .count()
    }

    #[test]
    fn samples_have_valid_mixed_authorship() {
        for src in [SEED_V2, SEED_V2_EN] {
            let seed = parse_seed(src);
            assert!(!seed.authorship_spans.is_empty());
            assert!(ai_span_count(&seed) > 0);
            assert!(
                seed.authorship_spans
                    .iter()
                    .any(|span| span.source == "unknown"),
                "sample should demonstrate unknown provenance"
            );
            for span in &seed.authorship_spans {
                assert!(span.from_pos < span.to_pos, "{} range", span.id);
                assert!(
                    matches!(span.source.as_str(), "human" | "ai" | "unknown"),
                    "{} source",
                    span.id
                );
                assert!(
                    seed.tree_nodes
                        .iter()
                        .any(|node| node.id == span.node_id && node.node_type == "scene"),
                    "{} owner",
                    span.id
                );
            }
        }
    }

    #[test]
    fn authorship_spans_anchor_expected_text() {
        let check = |src: &str, expected: &[(&str, &str, &str)]| {
            let seed = parse_seed(src);
            for (span_id, source, expected_text) in expected {
                let span = seed
                    .authorship_spans
                    .iter()
                    .find(|span| &span.id == span_id)
                    .unwrap_or_else(|| panic!("span {span_id} missing"));
                assert_eq!(&span.source, source, "{span_id} source");
                let got = pm_text_between(
                    &scene_content(&seed, &span.node_id),
                    span.from_pos,
                    span.to_pos,
                );
                assert_eq!(&got, expected_text, "{span_id} anchor text drifted");
            }
        };

        check(
            SEED_V2,
            &[
                (
                    "sample-auth-ja-2",
                    "ai",
                    "崖の上に建つ館は、中央の鐘楼だけが海霧から突き出していた。黒い文字盤の針は動いているのに、館全体は息を止めているように静かだった。",
                ),
                (
                    "sample-auth-ja-4",
                    "unknown",
                    "律はその言葉を手帳に書いた。仕事は館主・黒瀬宗一郎の回想録を整理することだったが、事実は最初に記録しておくのが彼女の癖だった。",
                ),
                (
                    "sample-auth-ja-16",
                    "ai",
                    "三枝は宗一郎専用のカップに薬を入れ、温室の蓄音機を時限装置で鳴らした。彼だけが音の方向を『塔の上』と説明したのは、全員の記憶を同じ形に整えようとしたからだ。",
                ),
            ],
        );
        check(
            SEED_V2_EN,
            &[
                (
                    "sample-auth-en-2",
                    "ai",
                    "The manor stood on the cliff, its central bell tower rising alone above the sea fog. The hands on the black clock face moved, yet the whole house seemed to be holding its breath.",
                ),
                (
                    "sample-auth-en-4",
                    "unknown",
                    "Ritsu wrote the sentence in her notebook. She had come to organize Soichiro Kurose's memoir, but recording facts first was an old habit.",
                ),
                (
                    "sample-auth-en-16",
                    "ai",
                    "Toma dosed Soichiro's private cup and arranged for the conservatory phonograph to play on a timer. Only he described the sound as coming from the tower because he was trying to give everyone the same memory.",
                ),
            ],
        );
    }

    #[test]
    fn attribution_project_scope_keeps_human_nonzero() {
        for src in [SEED_V2, SEED_V2_EN] {
            let seed = parse_seed(src);
            let scene_id = "sample-scene-1";
            let node = seed
                .tree_nodes
                .iter()
                .find(|node| node.id == scene_id)
                .expect("scene 1");
            let total = count_scene_body_chars(node.content.as_deref().unwrap_or(""));
            assert!(total > 0);

            let mut ai = 0;
            let mut unknown = 0;
            for span in seed
                .authorship_spans
                .iter()
                .filter(|span| span.node_id == scene_id)
            {
                match span.source.as_str() {
                    "ai" => ai += span.to_pos - span.from_pos,
                    "unknown" => unknown += span.to_pos - span.from_pos,
                    _ => {}
                }
            }
            let total = total.max(ai + unknown);
            let human = (total - ai - unknown).max(0);
            assert!(ai > 0, "expected AI text");
            assert!(human > 0, "human attribution must remain non-zero");
        }
    }
}
