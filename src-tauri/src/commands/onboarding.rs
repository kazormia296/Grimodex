use serde::{Deserialize, Serialize};

use crate::{
    commands::{AppError, GlobalSettingsPath},
    database::Database,
    workspace,
};

const SEED_V1: &str = include_str!("../../resources/sample_project/v1.json");
const SEED_V1_EN: &str = include_str!("../../resources/sample_project/v1_en.json");

/// Select the embedded sample seed and its project language for the chosen UI
/// language.
///
/// Each bundled sample is authored end-to-end in a single language (entry
/// names / body / chapter titles), so the project's `language` column must
/// match the content. If they diverge, only the Codex builtin type-labels
/// relabel and the result is an "English labels + Japanese body" half-state.
/// Only `en` has a dedicated English sample today; every other value
/// (including `ja`) falls back to the Japanese sample so labels and body stay
/// internally consistent.
fn select_seed(language: &str) -> (&'static str, &'static str) {
    match language {
        "en" => (SEED_V1_EN, "en"),
        _ => (SEED_V1, "ja"),
    }
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
}

// ---------------------------------------------------------------------------
// Command result
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeedResult {
    pub path: String,
    pub project_id: String,
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

/// Create (or re-create) the sample workspace under AppData, seed it with
/// sample project data, and record its path in GlobalSettings.
///
/// Caller must invoke `open_workspace(path)` afterwards to set the active workspace.
#[tauri::command]
pub(crate) fn seed_sample_workspace(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    language: String,
    ai_policy: String,
) -> Result<SeedResult, AppError> {
    let app_dir = gs_path
        .path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine AppData directory"))?;

    let ws_path = app_dir.join("sample-workspace");
    std::fs::create_dir_all(&ws_path).map_err(anyhow::Error::from)?;

    // Always (re-)create the database from scratch so the schema is fresh.
    let db_path = ws_path.join("grimodex.db");
    if db_path.exists() {
        std::fs::remove_file(&db_path).map_err(anyhow::Error::from)?;
    }

    // Open and migrate
    let db = Database::new(&db_path)?;
    db.migrate()?;

    // Pick the embedded sample whose authored language matches the user's UI
    // language (ja / en). `sample_language` is written to the project's
    // `language` column so labels and body stay consistent; unknown languages
    // fall back to the Japanese sample. See `select_seed` for the rationale.
    let (seed_src, sample_language) = select_seed(&language);

    // Seed from embedded JSON
    let seed: SeedData = serde_json::from_str(seed_src).map_err(anyhow::Error::from)?;
    let project_id = seed.project.id.clone();
    let now_dt = chrono::Utc::now().to_rfc3339();
    let now_ms = chrono::Utc::now().timestamp_millis();
    db.with_conn(|conn| {
        // Project
        // Migration pre-inserts "default-project"; replace it with sample data.
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

        // Tree nodes (insert in order — parents before children)
        for node in &seed.tree_nodes {
            let content = node
                .content
                .clone()
                .unwrap_or_else(|| r#"{"type":"doc","content":[]}"#.to_string());
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, parent_id, node_type, title, synopsis, sort_order, status, content, story_time_order, story_time_label, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
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
                    node.story_time_order,
                    node.story_time_label,
                    now_dt,
                ],
            )?;
        }

        // Codex entries
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
                    (id, project_id, type, name, aliases, summary, content, notes, context_mode, created_at, updated_at)
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

        // Chat sessions
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

        // Chat messages
        for msg in &seed.chat_messages {
            conn.execute(
                "INSERT INTO chat_messages
                    (id, session_id, role, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![msg.id, msg.session_id, msg.role, msg.content, now_dt],
            )?;
        }

        // Foreshadows
        for fs in &seed.foreshadows {
            conn.execute(
                "INSERT INTO foreshadows
                    (id, project_id, title, intent, notes, payoff_scene_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                rusqlite::params![
                    fs.id,
                    project_id,
                    fs.title,
                    fs.intent,
                    fs.notes,
                    fs.payoff_scene_id,
                    now_ms,
                ],
            )?;
        }

        // Snippets
        for sn in &seed.snippets {
            conn.execute(
                "INSERT INTO snippets
                    (id, project_id, title, content, content_source, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![
                    sn.id,
                    project_id,
                    sn.title,
                    sn.content,
                    sn.content_source,
                    now_dt,
                ],
            )?;
        }

        // Foreshadow setups
        for setup in &seed.foreshadow_setups {
            conn.execute(
                "INSERT INTO foreshadow_setups
                    (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
                     attribution, is_orphan, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
                rusqlite::params![
                    setup.id,
                    setup.foreshadow_id,
                    setup.scene_id,
                    setup.from_pos,
                    setup.to_pos,
                    setup.kind,
                    setup.strength,
                    setup.attribution,
                    now_ms,
                ],
            )?;
        }

        Ok(())
    })?;

    // Ensure workspace metadata file exists
    let ws_path_str = ws_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Non-UTF-8 workspace path"))?
        .to_string();
    let ws_id = uuid::Uuid::new_v4().to_string();
    workspace::ensure_workspace_meta(&ws_path, &ws_id, &now_dt)?;

    // Persist sample workspace path in GlobalSettings
    let mut settings = workspace::read_global_settings(&gs_path.path);
    settings.sample_workspace_path = Some(ws_path_str.clone());
    workspace::write_global_settings(&gs_path.path, &settings)?;

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
    use std::path::Path;

    fn make_test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    #[test]
    fn seed_v1_json_is_valid() {
        let result: Result<SeedData, _> = serde_json::from_str(SEED_V1);
        assert!(
            result.is_ok(),
            "v1.json failed to parse: {:?}",
            result.err()
        );
        let seed = result.unwrap();
        assert!(!seed.project.id.is_empty());
        assert!(!seed.tree_nodes.is_empty());
        assert!(!seed.codex_entries.is_empty());
        assert!(!seed.chat_sessions.is_empty());
        assert!(!seed.chat_messages.is_empty());
        assert!(!seed.foreshadows.is_empty());
    }

    #[test]
    fn seed_v1_en_json_is_valid() {
        let result: Result<SeedData, _> = serde_json::from_str(SEED_V1_EN);
        assert!(
            result.is_ok(),
            "v1_en.json failed to parse: {:?}",
            result.err()
        );
        let seed = result.unwrap();
        // Must replace the migration's pre-inserted "default-project" row, same
        // as the Japanese seed — otherwise the sample workspace gets two projects.
        assert_eq!(seed.project.id, "default-project");
        assert!(!seed.tree_nodes.is_empty());
        assert!(!seed.codex_entries.is_empty());
        assert!(!seed.chat_sessions.is_empty());
        assert!(!seed.chat_messages.is_empty());
        assert!(!seed.foreshadows.is_empty());
    }

    #[test]
    fn select_seed_picks_language() {
        let (en_src, en_lang) = select_seed("en");
        assert_eq!(en_lang, "en");
        assert_eq!(en_src, SEED_V1_EN);

        let (ja_src, ja_lang) = select_seed("ja");
        assert_eq!(ja_lang, "ja");
        assert_eq!(ja_src, SEED_V1);

        // Unknown / unsupported languages fall back to the Japanese sample so we
        // never ship an inconsistent labels-vs-body half-state.
        let (fallback_src, fallback_lang) = select_seed("zh");
        assert_eq!(fallback_lang, "ja");
        assert_eq!(fallback_src, SEED_V1);
    }

    #[test]
    fn seed_en_matches_ja_structure() {
        // The tour gates (tourGates.ts) and SampleTour are content-agnostic: they
        // gate on store mutations (scene opened, chars written, chat sent, codex
        // added, snippet used), not on specific entity names. So the English
        // sample only has to ship the SAME KINDS and COUNTS of content as the
        // Japanese one to satisfy every gate. Lock that parity in here.
        let ja: SeedData = serde_json::from_str(SEED_V1).unwrap();
        let en: SeedData = serde_json::from_str(SEED_V1_EN).unwrap();

        let scenes = |s: &SeedData| {
            s.tree_nodes
                .iter()
                .filter(|n| n.node_type == "scene")
                .count()
        };
        let folders = |s: &SeedData| {
            s.tree_nodes
                .iter()
                .filter(|n| n.node_type == "folder")
                .count()
        };

        assert_eq!(en.tree_nodes.len(), ja.tree_nodes.len(), "tree_nodes");
        assert_eq!(scenes(&en), scenes(&ja), "scene count");
        assert_eq!(folders(&en), folders(&ja), "folder count");
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
    }

    /// Extract the text covered by a ProseMirror position range from a scene's
    /// stringified doc. Mirrors PM position math: block open/close each consume
    /// one position, a text node consumes one per char, any other inline node
    /// (atom) consumes one. English seed content is BMP-only so `chars()` count
    /// matches PM's UTF-16 sizing.
    fn pm_text_between(content: &str, from: i64, to: i64) -> String {
        let doc: serde_json::Value = serde_json::from_str(content).unwrap();
        let mut pos: i64 = 0;
        let mut out = String::new();
        for block in doc["content"].as_array().unwrap() {
            pos += 1; // open
            if let Some(inline) = block["content"].as_array() {
                for n in inline {
                    if n["type"] == "text" {
                        for ch in n["text"].as_str().unwrap().chars() {
                            if pos >= from && pos < to {
                                out.push(ch);
                            }
                            pos += 1;
                        }
                    } else {
                        if pos >= from && pos < to {
                            out.push('\u{fffc}');
                        }
                        pos += 1;
                    }
                }
            }
            pos += 1; // close
        }
        out
    }

    #[test]
    fn seed_en_foreshadow_setups_anchor_expected_text() {
        // Guards against prose edits that shift text without re-tuning the baked
        // from_pos/to_pos: each setup must still cover the line it was planted on.
        let en: SeedData = serde_json::from_str(SEED_V1_EN).unwrap();
        let scene_content = |id: &str| -> String {
            en.tree_nodes
                .iter()
                .find(|n| n.id == id)
                .and_then(|n| n.content.clone())
                .unwrap_or_else(|| panic!("scene {id} missing"))
        };

        let expected: &[(&str, &str)] = &[
            ("sample-setup-1", "The compass was dry"),
            ("sample-setup-2", "it had fallen, hasp and all"),
        ];
        for (setup_id, text) in expected {
            let setup = en
                .foreshadow_setups
                .iter()
                .find(|s| &s.id == setup_id)
                .unwrap_or_else(|| panic!("setup {setup_id} missing"));
            assert!(
                setup.from_pos < setup.to_pos,
                "{setup_id}: from_pos must precede to_pos"
            );
            let got = pm_text_between(
                &scene_content(&setup.scene_id),
                setup.from_pos,
                setup.to_pos,
            );
            assert_eq!(&got, text, "{setup_id} anchor text drifted");
        }
    }

    #[test]
    fn seed_inserts_all_rows() {
        let db = make_test_db();
        let seed: SeedData = serde_json::from_str(SEED_V1).unwrap();
        let project_id = seed.project.id.clone();
        let now_dt = chrono::Utc::now().to_rfc3339();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let ai_policy = r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}"#;

        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO projects (id, title, language, ai_policy, is_sample, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                rusqlite::params![project_id, seed.project.title, "ja", ai_policy, now_dt],
            )?;

            for node in &seed.tree_nodes {
                let content = node.content.clone().unwrap_or_else(|| r#"{"type":"doc","content":[]}"#.to_string());
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, synopsis, sort_order, status, content, story_time_order, story_time_label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                    rusqlite::params![node.id, project_id, node.parent_id, node.node_type, node.title, node.synopsis, node.sort_order, node.status, content, node.story_time_order, node.story_time_label, now_dt],
                )?;
            }

            for entry in &seed.codex_entries {
                let content = entry.content.clone().unwrap_or_else(|| r#"{"type":"doc","content":[]}"#.to_string());
                let context_mode = entry.context_mode.clone().unwrap_or_else(|| "mentioned".to_string());
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, notes, context_mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    rusqlite::params![entry.id, project_id, entry.entry_type, entry.name, entry.aliases, entry.summary, content, entry.notes, context_mode, now_dt],
                )?;
            }

            for session in &seed.chat_sessions {
                conn.execute(
                    "INSERT INTO chat_sessions (id, project_id, node_id, title, model, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    rusqlite::params![session.id, project_id, session.node_id, session.title, session.model, now_dt],
                )?;
            }

            for msg in &seed.chat_messages {
                conn.execute(
                    "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![msg.id, msg.session_id, msg.role, msg.content, now_dt],
                )?;
            }

            for fs in &seed.foreshadows {
                conn.execute(
                    "INSERT INTO foreshadows (id, project_id, title, intent, notes, payoff_scene_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    rusqlite::params![fs.id, project_id, fs.title, fs.intent, fs.notes, fs.payoff_scene_id, now_ms],
                )?;
            }

            for sn in &seed.snippets {
                conn.execute(
                    "INSERT INTO snippets (id, project_id, title, content, content_source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    rusqlite::params![sn.id, project_id, sn.title, sn.content, sn.content_source, now_dt],
                )?;
            }

            for setup in &seed.foreshadow_setups {
                conn.execute(
                    "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, attribution, is_orphan, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
                    rusqlite::params![setup.id, setup.foreshadow_id, setup.scene_id, setup.from_pos, setup.to_pos, setup.kind, setup.strength, setup.attribution, now_ms],
                )?;
            }

            Ok(())
        }).expect("seed inserts");

        // Verify row counts
        db.with_conn(|conn| {
            let project_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM projects WHERE is_sample = 1",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(project_count, 1, "projects");

            let node_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )?;
            assert_eq!(node_count, seed.tree_nodes.len() as i64, "tree_nodes");

            let codex_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_entries WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )?;
            assert_eq!(
                codex_count,
                seed.codex_entries.len() as i64,
                "codex_entries"
            );

            let session_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chat_sessions WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )?;
            assert_eq!(
                session_count,
                seed.chat_sessions.len() as i64,
                "chat_sessions"
            );

            let msg_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE session_id = ?1",
                [&seed.chat_sessions[0].id],
                |r| r.get(0),
            )?;
            assert_eq!(msg_count, seed.chat_messages.len() as i64, "chat_messages");

            let fs_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM foreshadows WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )?;
            assert_eq!(fs_count, seed.foreshadows.len() as i64, "foreshadows");

            let setup_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM foreshadow_setups", [], |r| r.get(0))?;
            assert_eq!(
                setup_count,
                seed.foreshadow_setups.len() as i64,
                "foreshadow_setups"
            );

            Ok(())
        })
        .expect("verify counts");
    }
}
