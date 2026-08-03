//! 共有 `grimodex-post-effect` runner の Electron/napi adapter。
//!
//! DB・event・abort は同一 `Arc<AppState>`、AI設定とsecretは Electron main が
//! 1 invokeにつき1回取得したsnapshotを使う。rendererへ平文キーを返さない。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use grimodex_db::events::EventSink;
use grimodex_db::state::active_workspace_snapshot;
use grimodex_db::{with_db_state, AppError, Database};
use grimodex_post_effect::{
    apply_model_override, PostEffectAiClient, PostEffectAiDispatch, PostEffectAiOutput,
    PostEffectAiRequest, PostEffectAiResolvedRoute, PostEffectRuntime,
};

use crate::state::AppState;

/// DB/event/abort state を同じ Backend instanceへ束縛する runtime。
#[derive(Clone)]
pub(crate) struct NodePostEffectRuntime {
    state: Arc<AppState>,
    db: Option<Arc<Database>>,
}

impl NodePostEffectRuntime {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        Self { state, db: None }
    }

    pub(crate) fn new_scoped(
        state: Arc<AppState>,
        expected_workspace_path: &str,
    ) -> Result<Self, AppError> {
        let workspace = active_workspace_snapshot(&state.ws)?;
        let active = workspace
            .path
            .canonicalize()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
        let expected = PathBuf::from(expected_workspace_path)
            .canonicalize()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
        if active != expected {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "POST_EFFECT_WORKSPACE_CHANGED: expected {}, active {}",
                expected.display(),
                active.display()
            )));
        }
        Ok(Self {
            state,
            db: Some(workspace.db),
        })
    }
}

impl PostEffectRuntime for NodePostEffectRuntime {
    fn pin_database(&self) -> Result<Self, AppError> {
        if self.db.is_some() {
            return Ok(self.clone());
        }
        let db = grimodex_db::state::active_database(&self.state.ws)?;
        Ok(Self {
            state: Arc::clone(&self.state),
            db: Some(db),
        })
    }

    fn pinned_database(&self) -> Option<Arc<Database>> {
        self.db.as_ref().map(Arc::clone)
    }

    fn with_db<T, F>(&self, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&Database) -> anyhow::Result<T>,
    {
        if let Some(db) = &self.db {
            return Ok(f(db)?);
        }
        with_db_state(&self.state.ws, f)
    }

    fn emit(&self, channel: &str, payload: serde_json::Value) {
        self.state.events.emit(channel, payload);
    }

    fn abort_registry(&self) -> &grimodex_post_effect::PostEffectAbortRegistry {
        &self.state.post_effect_abort
    }
}

/// Electron main が safeStorage から作ったsecret snapshotを使うAI client。
/// `None`（未登録）と `Some("")`（保存済み空文字）は区別する。
#[derive(Clone)]
pub(crate) struct NodePostEffectAiClient {
    settings: grimodex_ai::AiSettings,
    api_key: Option<String>,
    api_key_error: Option<String>,
}

impl NodePostEffectAiClient {
    pub(crate) fn new(
        settings: grimodex_ai::AiSettings,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Self {
        Self {
            settings,
            api_key,
            api_key_error,
        }
    }

    fn resolve_api_key(&self, settings: &grimodex_ai::AiSettings) -> anyhow::Result<String> {
        use grimodex_ai::AiProvider;

        // Tauri keyring resolverはこの2 providerでストアに触れない。main側の
        // snapshot取得が失敗していても、不要なsecret errorは観測しない。
        if matches!(settings.provider, AiProvider::Ollama | AiProvider::Cli) {
            return Ok(String::new());
        }
        if let Some(error) = &self.api_key_error {
            anyhow::bail!(error.clone());
        }
        if let Some(key) = &self.api_key {
            return Ok(key.clone());
        }
        // ローカルLLM等のkey無しendpointを許容する既存契約。
        if matches!(settings.provider, AiProvider::OpenaiCompatible) {
            return Ok(String::new());
        }
        anyhow::bail!("No API key configured for {}", settings.provider)
    }
}

impl PostEffectAiClient for NodePostEffectAiClient {
    fn resolve_audit_route(
        &self,
        request: &PostEffectAiRequest<'_>,
    ) -> grimodex_post_effect::PostEffectAiResolvedRoute {
        let settings = apply_model_override(
            self.settings.clone(),
            request.model_override,
            request.role_override,
        );
        grimodex_post_effect::PostEffectAiResolvedRoute::from_settings(&settings)
    }

    fn prepare_call<'a>(
        &'a self,
        request: PostEffectAiRequest<'a>,
    ) -> anyhow::Result<(PostEffectAiResolvedRoute, PostEffectAiDispatch<'a>)> {
        let settings = apply_model_override(
            self.settings.clone(),
            request.model_override,
            request.role_override,
        );
        let prepared = grimodex_ai::prepare_post_effect_request(
            &settings,
            request.system_prompt,
            request.codex_content,
            request.scene_content,
        )?;
        let route =
            PostEffectAiResolvedRoute::from_settings_and_prepared(&settings, prepared.clone());
        let dispatch: PostEffectAiDispatch<'a> = Box::new(move || {
            Box::pin(async move {
                let api_key = self.resolve_api_key(&settings)?;
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
                self.settings.clone(),
                request.model_override,
                request.role_override,
            );
            let api_key = self.resolve_api_key(&settings)?;
            let detected_model = settings.model.clone();
            let raw_response = grimodex_ai::call_post_effect_api(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn client(
        provider: grimodex_ai::AiProvider,
        key: Option<&str>,
        error: Option<&str>,
    ) -> NodePostEffectAiClient {
        NodePostEffectAiClient::new(
            grimodex_ai::AiSettings {
                provider,
                ..Default::default()
            },
            key.map(str::to_owned),
            error.map(str::to_owned),
        )
    }

    #[test]
    fn required_provider_distinguishes_missing_from_saved_empty_key() {
        let missing = client(grimodex_ai::AiProvider::Anthropic, None, None);
        assert!(missing.resolve_api_key(&missing.settings).is_err());

        let stored_empty = client(grimodex_ai::AiProvider::Anthropic, Some(""), None);
        assert_eq!(
            stored_empty
                .resolve_api_key(&stored_empty.settings)
                .expect("Some empty is still a configured key"),
            ""
        );
    }

    #[test]
    fn no_key_providers_ignore_lookup_error_but_openai_compatible_does_not() {
        for provider in [
            grimodex_ai::AiProvider::Ollama,
            grimodex_ai::AiProvider::Cli,
        ] {
            let c = client(provider, None, Some("broken key store"));
            assert_eq!(c.resolve_api_key(&c.settings).expect("key不要"), "");
        }

        let compatible = client(
            grimodex_ai::AiProvider::OpenaiCompatible,
            None,
            Some("broken key store"),
        );
        assert!(compatible
            .resolve_api_key(&compatible.settings)
            .expect_err("lookup errorはmissingとは異なる")
            .to_string()
            .contains("broken key store"));
    }
}
