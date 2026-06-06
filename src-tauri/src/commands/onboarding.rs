use serde::{Deserialize, Serialize};

use crate::{
    commands::{AppError, GlobalSettingsPath},
    database::Database,
    workspace,
};

const SEED_V1: &str = include_str!("../../resources/sample_project/v1.json");

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

    // Seed from embedded JSON
    let seed: SeedData = serde_json::from_str(SEED_V1).map_err(anyhow::Error::from)?;
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
                language,
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
