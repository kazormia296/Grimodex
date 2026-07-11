//! PostEffects の Tauri adapter。
//!
//! 実行本体は `grimodex-post-effect` にあり、このファイルは AppHandle / keyring /
//! Tauri command の注入境界と、既存 pure-db command だけを担当する。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use rusqlite::params;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use super::ai::resolve_api_key;
use super::{AiSettingsPath, AppError, PostEffectAbortRegistry, WorkspaceState};
use crate::ai::{call_post_effect_api, read_ai_settings};
use crate::database::post_effect::{
    self, row_to_annotation_value, row_to_lens_value, row_to_relation_value, row_to_run_value,
    ReplyToAnnotationArgs,
};
use grimodex_post_effect::{
    apply_model_override, PostEffectAiClient, PostEffectAiOutput, PostEffectAiRequest,
    PostEffectRuntime, StartPostEffectRunArgs, StartPostEffectRunMultiArgs,
    StartPostEffectRunResult,
};

#[derive(Clone)]
struct TauriPostEffectRuntime {
    app: AppHandle,
    aborts: PostEffectAbortRegistry,
    db: Option<Arc<grimodex_db::Database>>,
}

impl TauriPostEffectRuntime {
    fn new(app: AppHandle) -> Self {
        let state = app.state::<PostEffectAbortRegistry>();
        let aborts = PostEffectAbortRegistry::clone(&state);
        Self {
            app,
            aborts,
            db: None,
        }
    }
}

impl PostEffectRuntime for TauriPostEffectRuntime {
    fn pin_database(&self) -> Result<Self, AppError> {
        let state = self.app.state::<WorkspaceState>();
        let db = grimodex_db::state::active_database(&state)?;
        Ok(Self {
            app: self.app.clone(),
            aborts: self.aborts.clone(),
            db: Some(db),
        })
    }

    fn pinned_database(&self) -> Option<Arc<grimodex_db::Database>> {
        self.db.as_ref().map(Arc::clone)
    }

    fn with_db<T, F>(&self, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&grimodex_db::Database) -> anyhow::Result<T>,
    {
        if let Some(db) = &self.db {
            return Ok(f(db)?);
        }
        let state = self.app.state::<WorkspaceState>();
        super::with_db(&state, f)
    }

    fn emit(&self, channel: &str, payload: Value) {
        let _ = self.app.emit(channel, payload);
    }

    fn abort_registry(&self) -> &PostEffectAbortRegistry {
        &self.aborts
    }
}

#[derive(Clone)]
struct TauriPostEffectAiClient {
    settings_path: PathBuf,
}

impl PostEffectAiClient for TauriPostEffectAiClient {
    fn call<'a>(
        &'a self,
        request: PostEffectAiRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<PostEffectAiOutput>> + Send + 'a>> {
        Box::pin(async move {
            let settings = apply_model_override(
                read_ai_settings(&self.settings_path),
                request.model_override,
                request.role_override,
            );
            let api_key = resolve_api_key(
                &settings.provider,
                settings.active_openai_compatible_endpoint_id.as_deref(),
            )?;
            let detected_model = settings.model.clone();
            let raw_response = call_post_effect_api(
                &settings,
                &api_key,
                request.system_prompt,
                request.codex_content,
                request.scene_content,
            )
            .await?;
            Ok(PostEffectAiOutput {
                raw_response,
                detected_model,
            })
        })
    }
}

#[tauri::command]
pub(crate) async fn start_post_effect_run(
    ai_settings_path: State<'_, AiSettingsPath>,
    app_handle: AppHandle,
    args: StartPostEffectRunArgs,
) -> Result<StartPostEffectRunResult, AppError> {
    let runtime = TauriPostEffectRuntime::new(app_handle);
    let ai = TauriPostEffectAiClient {
        settings_path: ai_settings_path.path.clone(),
    };
    grimodex_post_effect::start_post_effect_run(runtime, ai, args).await
}

#[tauri::command]
pub(crate) async fn start_post_effect_run_multi(
    ai_settings_path: State<'_, AiSettingsPath>,
    app_handle: AppHandle,
    args: StartPostEffectRunMultiArgs,
) -> Result<StartPostEffectRunResult, AppError> {
    let runtime = TauriPostEffectRuntime::new(app_handle);
    let ai = TauriPostEffectAiClient {
        settings_path: ai_settings_path.path.clone(),
    };
    grimodex_post_effect::start_post_effect_run_multi(runtime, ai, args).await
}

#[tauri::command(async)]
pub(crate) fn abort_post_effect_run(
    app_handle: AppHandle,
    run_id: String,
    project_id: String,
) -> Result<(), AppError> {
    grimodex_post_effect::abort_post_effect_run(
        &TauriPostEffectRuntime::new(app_handle),
        &run_id,
        &project_id,
    )
}

#[tauri::command(async)]
pub(crate) fn list_post_effect_runs(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    effect_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Value>, AppError> {
    super::with_db(&ws_state, |db| {
        post_effect::list_post_effect_runs(db, project_id, effect_type, limit, offset)
    })
}

#[tauri::command(async)]
pub(crate) fn get_post_effect_run(
    ws_state: State<'_, WorkspaceState>,
    run_id: String,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let run = conn.query_row(
                "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                        model, prompt_version, input_hash, status, summary,
                        error_message, started_at, completed_at
                   FROM post_effect_runs WHERE id = ? AND project_id = ?",
                params![run_id, project_id],
                row_to_run_value,
            )?;
            let annotations = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations WHERE run_id = ? ORDER BY created_at",
                )?;
                let rows: Result<Vec<_>, _> = stmt
                    .query_map(params![run_id], row_to_annotation_value)?
                    .collect();
                rows?
            };
            let relations = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotation_relations WHERE run_id = ? ORDER BY created_at",
                )?;
                let rows: Result<Vec<_>, _> = stmt
                    .query_map(params![run_id], row_to_relation_value)?
                    .collect();
                rows?
            };
            let lens_data = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM scene_lens_data WHERE run_id = ? ORDER BY created_at",
                )?;
                let rows: Result<Vec<_>, _> =
                    stmt.query_map(params![run_id], row_to_lens_value)?.collect();
                rows?
            };
            let mut result = run;
            result["annotations"] = Value::Array(annotations);
            result["relations"] = Value::Array(relations);
            result["lens_data"] = Value::Array(lens_data);
            Ok(result)
        })
    })
}

#[tauri::command(async)]
pub(crate) fn list_scene_lens_for_project(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        post_effect::list_scene_lens_for_project(db, project_id)
    })
}

#[tauri::command(async)]
pub(crate) fn list_annotations_for_scene(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    scene_id: String,
    status: Option<String>,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        post_effect::list_annotations_for_scene(db, project_id, scene_id, status)
    })
}

#[tauri::command(async)]
pub(crate) fn list_annotations_for_project(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    status: Option<String>,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        post_effect::list_annotations_for_project(db, project_id, status)
    })
}

#[tauri::command(async)]
pub(crate) fn update_annotation_status(
    ws_state: State<'_, WorkspaceState>,
    annotation_id: String,
    status: String,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            post_effect::update_annotation_status_inner(conn, &annotation_id, &status, &project_id)
        })
    })
}

#[tauri::command(async)]
pub(crate) fn reply_to_annotation(
    ws_state: State<'_, WorkspaceState>,
    args: ReplyToAnnotationArgs,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| post_effect::reply_to_annotation_inner(conn, &args))
    })
}

fn update_relation_status_inner(
    conn: &rusqlite::Connection,
    relation_id: &str,
    status: &str,
    project_id: &str,
) -> anyhow::Result<Value> {
    let tx = conn.unchecked_transaction()?;
    let affected = tx.execute(
        "UPDATE post_effect_annotation_relations
            SET status = ?, metadata = json_set(metadata, '$.updated_at', datetime('now'))
          WHERE id = ? AND project_id = ?",
        params![status, relation_id, project_id],
    )?;
    if affected == 0 {
        anyhow::bail!("relation not found in project (id={relation_id})");
    }
    tx.execute(
        "UPDATE post_effect_annotations
            SET status = ?,
                metadata = json_set(metadata, '$.dismiss_source', 'cascade'),
                updated_at = datetime('now')
          WHERE project_id = ?
            AND id IN (
                SELECT annotation_a_id FROM post_effect_annotation_relations
                  WHERE id = ? AND project_id = ?
                UNION
                SELECT annotation_b_id FROM post_effect_annotation_relations
                  WHERE id = ? AND project_id = ?
            )",
        params![
            status,
            project_id,
            relation_id,
            project_id,
            relation_id,
            project_id
        ],
    )?;
    tx.commit()?;
    Ok(conn.query_row(
        "SELECT * FROM post_effect_annotation_relations WHERE id = ? AND project_id = ?",
        params![relation_id, project_id],
        row_to_relation_value,
    )?)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod update_relation_status_tests {
    use super::update_relation_status_inner;
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_annotations (
                id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT, anchor_type TEXT,
                scene_id TEXT, range_start INTEGER, range_end INTEGER, text_snapshot TEXT,
                category TEXT NOT NULL, persona TEXT, severity TEXT, content TEXT,
                author_role TEXT, parent_id TEXT, status TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT
            );
            CREATE TABLE post_effect_annotation_relations (
                id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT,
                annotation_a_id TEXT NOT NULL, annotation_b_id TEXT NOT NULL,
                relation_type TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'bidirectional',
                description TEXT, status TEXT NOT NULL DEFAULT 'open',
                metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn insert_ann(conn: &Connection, id: &str, project_id: &str) {
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, project_id, anchor_type, category, content, author_role,
                 status, metadata, created_at, updated_at)
             VALUES (?, ?, 'scene_range', 'consistency_anchor', 'c', 'ai',
                     'open', '{}', '2024-01-01', '2024-01-01')",
            params![id, project_id],
        )
        .unwrap();
    }

    fn status_of(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT status FROM post_effect_annotations WHERE id = ?",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn rejects_other_project_and_scopes_cascade() {
        let conn = open_db();
        insert_ann(&conn, "a1", "proj-A");
        insert_ann(&conn, "a2", "proj-A");
        conn.execute(
            "INSERT INTO post_effect_annotation_relations
                (id, project_id, annotation_a_id, annotation_b_id, relation_type,
                 status, metadata, created_at)
             VALUES ('rel1', 'proj-A', 'a1', 'a2', 'contradiction',
                     'open', '{}', '2024-01-01')",
            [],
        )
        .unwrap();
        assert!(update_relation_status_inner(&conn, "rel1", "dismissed", "proj-B").is_err());
        assert_eq!(status_of(&conn, "a1"), "open");
        assert!(update_relation_status_inner(&conn, "rel1", "dismissed", "proj-A").is_ok());
        assert_eq!(status_of(&conn, "a1"), "dismissed");
        assert_eq!(status_of(&conn, "a2"), "dismissed");
    }
}

#[tauri::command(async)]
pub(crate) fn update_relation_status(
    ws_state: State<'_, WorkspaceState>,
    relation_id: String,
    status: String,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| update_relation_status_inner(conn, &relation_id, &status, &project_id))
    })
}

#[tauri::command(async)]
pub(crate) fn save_post_effect_annotations(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    scene_id: String,
    annotations: Vec<Value>,
) -> Result<(), AppError> {
    super::with_db(&ws_state, |db| {
        post_effect::save_post_effect_annotations(db, project_id, scene_id, annotations)
    })
}

#[cfg(test)]
mod post_effect_live_tests {
    use crate::ai::{call_post_effect_api, AiProvider, AiSettings};
    use serde_json::Value;

    fn live_key() -> Option<String> {
        std::env::var("OPENROUTER_API_KEY")
            .ok()
            .filter(|key| !key.is_empty())
    }

    fn live_settings() -> AiSettings {
        AiSettings {
            provider: AiProvider::OpenRouter,
            model: std::env::var("OPENROUTER_MODEL")
                .unwrap_or_else(|_| "openai/gpt-4o-mini".to_string()),
            ..Default::default()
        }
    }

    fn run_one(label: &str, system_prompt: &str, codex: Option<&str>, scene: &str) {
        let Some(key) = live_key() else {
            eprintln!("[skip] {label}: OPENROUTER_API_KEY 未設定");
            return;
        };
        let settings = live_settings();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let raw = runtime
            .block_on(call_post_effect_api(
                &settings,
                &key,
                system_prompt,
                codex,
                scene,
            ))
            .unwrap_or_else(|error| panic!("{label}: API 呼び出し失敗: {error:#}"));
        let json = grimodex_post_effect::extract_json(&raw);
        let parsed: Value = serde_json::from_str(json)
            .unwrap_or_else(|error| panic!("{label}: JSON parse 失敗: {error}"));
        assert!(parsed.is_object(), "{label}: 応答が JSON object でない");
    }

    const SCENE: &str = "朱音は棚の奥で古い真鍮の鍵を見つけた。なぜか胸騒ぎがして、誰にも言わずポケットにしまった。";

    #[test]
    fn intent_drift_live() {
        run_one(
            "intent",
            "JSON objectでfindingsを返してください",
            None,
            SCENE,
        );
    }

    #[test]
    fn review_live() {
        run_one(
            "review",
            "JSON objectでcommentsを返してください",
            None,
            SCENE,
        );
    }

    #[test]
    fn consistency_with_codex_live() {
        run_one(
            "consistency",
            "JSON objectでviolationsを返してください",
            Some("{\"name\":\"朱音\",\"note\":\"鍵が苦手\"}"),
            SCENE,
        );
    }

    #[test]
    fn impact_review_with_diff_live() {
        run_one(
            "impact",
            "JSON objectでjudgmentsを返してください",
            Some("{\"change_id\":\"chg-1\",\"entry_id\":\"e1\"}"),
            SCENE,
        );
    }
}
