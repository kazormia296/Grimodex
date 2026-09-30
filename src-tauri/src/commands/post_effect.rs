//! PostEffects の Tauri adapter。
//!
//! 実行本体は `grimodex-post-effect` にあり、このファイルは AppHandle / keyring /
//! Tauri command の注入境界と、既存 pure-db command だけを担当する。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use super::ai::resolve_api_key;
use super::{AiSettingsPath, AppError, PostEffectAbortRegistry, WorkspaceState};
use crate::ai::{call_post_effect_api, read_ai_settings};
use crate::database::post_effect::{self, ReplyToAnnotationArgs};
use grimodex_post_effect::{
    apply_model_override, PostEffectAiClient, PostEffectAiOutput, PostEffectAiRequest,
    PostEffectRuntime, StartPostEffectRunArgs, StartPostEffectRunMultiArgs,
    StartPostEffectRunResult,
};

#[derive(Clone)]
struct TauriPostEffectRuntime {
    app: AppHandle,
    aborts: PostEffectAbortRegistry,
    db: Option<grimodex_db::PinnedWorkspaceDb>,
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

    fn pinned_database(&self) -> Option<grimodex_db::PinnedWorkspaceDb> {
        self.db.as_ref().map(Arc::clone)
    }

    fn with_db<T, F>(&self, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&grimodex_db::Database) -> anyhow::Result<T>,
    {
        if let Some(db) = &self.db {
            return Ok(f(db.db())?);
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
    fn resolve_audit_route(
        &self,
        request: &PostEffectAiRequest<'_>,
    ) -> grimodex_post_effect::PostEffectAiResolvedRoute {
        let settings = apply_model_override(
            read_ai_settings(&self.settings_path),
            request.model_override,
            request.role_override,
        );
        grimodex_post_effect::PostEffectAiResolvedRoute::from_settings(&settings)
    }

    fn prepare_call<'a>(
        &'a self,
        request: PostEffectAiRequest<'a>,
    ) -> anyhow::Result<(
        grimodex_post_effect::PostEffectAiResolvedRoute,
        grimodex_post_effect::PostEffectAiDispatch<'a>,
    )> {
        let settings = apply_model_override(
            read_ai_settings(&self.settings_path),
            request.model_override,
            request.role_override,
        );
        let prepared = grimodex_ai::prepare_post_effect_request(
            &settings,
            request.system_prompt,
            request.codex_content,
            request.scene_content,
        )?;
        let route = grimodex_post_effect::PostEffectAiResolvedRoute::from_settings_and_prepared(
            &settings,
            prepared.clone(),
        );
        let dispatch: grimodex_post_effect::PostEffectAiDispatch<'a> = Box::new(move || {
            Box::pin(async move {
                let api_key = resolve_api_key(
                    &settings.provider,
                    settings.active_openai_compatible_endpoint_id.as_deref(),
                )?;
                let detected_model = settings.model.clone();
                let raw_response =
                    grimodex_ai::call_post_effect_api_prepared(&settings, &api_key, &prepared)
                        .await?;
                Ok(PostEffectAiOutput {
                    raw_response,
                    detected_model,
                })
            })
        });
        Ok((route, dispatch))
    }

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
