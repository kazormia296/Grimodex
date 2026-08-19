//! Grimodex Electron シェルの Rust バックエンド (Electron 移行 Phase 2 S2、
//! 設計書 §4.2 / §4.3)。
//!
//! `#[napi]` class `Backend` が grimodex-db の `WorkspaceState` を保持し、
//! 垂直スライスのコマンド群 + `onEvent` を Node (Electron main) へ公開する。
//!
//! - **全公開関数は async + `spawn_blocking`** (軽量 stat の
//!   `validate_workspace_path` と、終了を確実に待つ
//!   `ime_export_deactivate_on_exit` を除く)。同期 `#[napi]` は Node main thread =
//!   Electron main プロセス全体をブロックする (Phase 0 スパイク実証) —
//!   busy_timeout 5s を踏んだ db_execute が全窓の IPC を止める事故を構造的に防ぐ。
//! - 返り値は当面 **JSON 文字列** (rows の二重シリアライズは Phase 3 の最適化
//!   候補として記録済み。§4.2)。
//! - エラーは `AppError` の Display 文字列をそのまま reason に載せる (§5.2 の
//!   文字列ワイヤ契約。convert.rs 参照)。

mod convert;
#[cfg(feature = "legacy-keyring-migration")]
mod legacy_keyring;
mod post_effect_runtime;
mod state;
#[cfg(test)]
mod test_link_stubs;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadSafeCallContext;
use napi::JsFunction;
use napi_derive::napi;

use grimodex_core::codex_matching::{CachedMatcher, CodexMatch, MatchEntry};
use grimodex_db::agent_writes;
use grimodex_db::ai_audit::{sanitize_diagnostic_credentials, AppendAiAuditEvent};
use grimodex_db::backup_restore::{list_backups, restore_backup_core};
use grimodex_db::change_events::AppendChangeEvent;
use grimodex_db::chronicle::{self, SetParticipantsPayload, UpsertProjectCalendarPayload};
use grimodex_db::domain_writes::{
    self, ApplyAiTreePlanPayload, CodexRenameApplyPayload, CodexRenameUndoPayload,
    CreateScanStagingProjectPayload, ProjectCreatePayload, ProjectDeletePayload,
    ProjectPatchPayload, ReplaceAuthorshipLanePayload, SetEntityTagsPayload, TreeNodeCreatePayload,
    TreeNodeDeletePayload, TreeNodePatchPayload, UndoAiTreePlanPayload,
};
use grimodex_db::editor_stickies;
use grimodex_db::events::EventSink;
use grimodex_db::foreshadow::{
    self, ForeshadowCreatePayload, ForeshadowDeletePayload, ForeshadowPatch, ForeshadowSetupPatch,
};
use grimodex_db::ime_export::{
    clear_all_exports, get_status as get_ime_export_status, refresh_project_export,
    remove_project_export_if_absent, resolve_mode_from_preferences,
    resolve_options_from_preferences, set_active_project, ImeExportOptions, ImeExportRequestGate,
    ImeExportRequestToken, ImeIntegrationMode,
};
use grimodex_db::lint_ignores::{self, CopyPayload, CreatePayload, MovePayload};
use grimodex_db::lint_terms::{
    self, InsertPayload as LintTermInsertPayload, UpdatePayload as LintTermUpdatePayload,
};
use grimodex_db::map_writes::{self, MapWritePayload};
use grimodex_db::narrative_extraction::{
    self, AttentionDisposition, GetNarrativeBackfillStatusPayload, LegacyBackfillBootstrapOutcome,
    ListResumableRunsPayload, NarrativeMaintenanceAttentionClearPayload,
    NarrativeMaintenanceAttentionSetPayload, NarrativeMaintenanceInboxListPayload,
    RebuildDerivedStateOutcome, RebuildNarrativeDerivedStatePayload,
    RepairNarrativeDependencyDeclarationsPayload, RetryNarrativeLegacyBackfillPayload,
    RunRefPayload, TemporalScenePatchPayload, VerifyNarrativeDependencyGraphPayload,
};
use grimodex_db::open::{
    open_workspace_sync_traced, NativeWorkspaceOpenResult, NativeWorkspaceOpenSpanName,
    NativeWorkspaceOpenTrace,
};
use grimodex_db::plot_threads::{
    self, PlotDeletePayload, PlotThreadBranchCreatePayload, PlotThreadBranchPatch,
    PlotThreadCreatePayload, PlotThreadDeleteSnapshotPayload, PlotThreadLinkCreatePayload,
    PlotThreadLinkPatch, PlotThreadMoveMarkerBundlePayload, PlotThreadPatch,
    PlotThreadRestoreSnapshotPayload,
};
use grimodex_db::post_effect::{self, ReplyToAnnotationArgs};
use grimodex_db::project_snapshots::{
    self, ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
};
use grimodex_db::recovery::{
    export_safe_mode_diagnostics, list_safe_mode_candidates, quarantine_live_database,
    restore_safe_mode_candidate, verify_safe_mode_candidate,
};
use grimodex_db::revision_restore::{self, RestoreSceneRevisionPayload};
use grimodex_db::runtime_performance_seed::{self, RuntimePerformanceSeedPayload};
use grimodex_db::sample_seed;
use grimodex_db::scene_body::{self, SaveSceneBodyBundlePayload};
use grimodex_db::state::{
    active_database, active_workspace_path, active_workspace_snapshot, ActiveWorkspaceSnapshot,
};
use grimodex_db::trash_bin::{self, TrashBinCreatePayload, TrashBinRestorePayload};
use grimodex_db::web_editor_handoff;
use grimodex_db::workspace::{self, GlobalSettings};
use grimodex_db::{
    with_db_state, AppError, BatchStatement, Database, QueryResult, RepairIntegrityPayload,
};

use convert::{app_err_to_napi, from_wire, join_err_to_napi, lint_err_to_napi, params_array};
use post_effect_runtime::{NodePostEffectAiClient, NodePostEffectRuntime};
use state::{AppState, EventQueue, EventTsfn};

const RUNTIME_PERFORMANCE_OWNER_TOKEN_ENV: &str = "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN";

fn validate_runtime_performance_owner_token(owner_token: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        owner_token.len() <= 200,
        "runtime performance fixture owner token is too long"
    );
    let expected = std::env::var(RUNTIME_PERFORMANCE_OWNER_TOKEN_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("runtime performance fixture seed is disabled"))?;
    anyhow::ensure!(
        !owner_token.is_empty() && owner_token == expected,
        "runtime performance fixture owner token mismatch"
    );
    Ok(())
}

#[derive(Clone)]
struct CorrelatedStreamEmitter {
    events: EventQueue,
    stream_id: String,
}

impl CorrelatedStreamEmitter {
    fn new(events: EventQueue, stream_id: String) -> Self {
        Self { events, stream_id }
    }
}

impl grimodex_ai::emit::StreamEmitter for CorrelatedStreamEmitter {
    fn emit(&self, channel: &str, mut payload: serde_json::Value) {
        match &mut payload {
            serde_json::Value::Object(object) => {
                object.insert(
                    "streamId".to_string(),
                    serde_json::Value::String(self.stream_id.clone()),
                );
            }
            other => {
                payload = serde_json::json!({
                    "streamId": self.stream_id,
                    "payload": other,
                });
            }
        }
        EventSink::emit(&self.events, channel, payload);
    }
}

const SEMANTIC_RERANKER_BUSY_MARKER: &str = "RERANKER_BUSY:";

fn try_with_semantic_reranker_lane<T, R>(
    lane: &Mutex<T>,
    operation: impl FnOnce(&mut T) -> anyhow::Result<R>,
) -> anyhow::Result<R> {
    let mut runtime = match lane.try_lock() {
        Ok(runtime) => runtime,
        Err(TryLockError::WouldBlock) => {
            return Err(anyhow::anyhow!(
                "{SEMANTIC_RERANKER_BUSY_MARKER} semantic reranker lane is occupied"
            ));
        }
        Err(TryLockError::Poisoned(error)) => {
            return Err(anyhow::anyhow!("semantic reranker lock poisoned: {error}"));
        }
    };
    operation(&mut runtime)
}

/// spawn_blocking + `AppError` → `napi::Error` 写像の定形。Tauri 側 M3 方針
/// (「db コマンドは async、長時間系は spawn_blocking」) の写像 (§4.2)。
async fn run_blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, AppError> + Send + 'static,
{
    napi::tokio::task::spawn_blocking(f)
        .await
        .map_err(join_err_to_napi)?
        .map_err(app_err_to_napi)
}

const ENTITY_SEED_MAX_SOURCES: u32 = 900;
const ENTITY_SEED_MAX_REQUEST_UTF8_BYTES: usize = 8 * 1024 * 1024;
const ENTITY_SEED_MAX_REF_UTF8_BYTES: usize = 1024;
const ENTITY_SEED_MAX_LANGUAGE_UTF8_BYTES: usize = 64;
const ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES: usize = 64;

fn invalid_entity_seed_request(message: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("invalid request: {message}"))
}

#[derive(Default)]
struct EntitySeedJsStringBudget {
    raw_utf8_bytes: usize,
}

impl EntitySeedJsStringBudget {
    fn admit(
        &mut self,
        value: &napi::JsString,
        label: &str,
        field_max_utf8_bytes: Option<usize>,
    ) -> Result<()> {
        // V8 can expose the UTF-16 length without first allocating a Rust
        // copy. Every valid scalar requires at least one UTF-8 byte per
        // UTF-16 unit, so this rejects obviously oversized strings before the
        // potentially expensive UTF-8 length scan as well.
        let utf16_len = value
            .utf16_len()
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        if let Some(field_max) = field_max_utf8_bytes {
            if utf16_len > field_max {
                return Err(invalid_entity_seed_request(format!(
                    "{label} exceeds {field_max} UTF-8 bytes"
                )));
            }
        }
        let remaining = ENTITY_SEED_MAX_REQUEST_UTF8_BYTES
            .checked_sub(self.raw_utf8_bytes)
            .ok_or_else(|| {
                invalid_entity_seed_request("entity seed request exceeds the 8 MiB wire budget")
            })?;
        if utf16_len > remaining {
            return Err(invalid_entity_seed_request(
                "entity seed request exceeds the 8 MiB wire budget",
            ));
        }

        let utf8_len = value
            .utf8_len()
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        if let Some(field_max) = field_max_utf8_bytes {
            if utf8_len > field_max {
                return Err(invalid_entity_seed_request(format!(
                    "{label} exceeds {field_max} UTF-8 bytes"
                )));
            }
        }
        self.raw_utf8_bytes = self
            .raw_utf8_bytes
            .checked_add(utf8_len)
            .filter(|total| *total <= ENTITY_SEED_MAX_REQUEST_UTF8_BYTES)
            .ok_or_else(|| {
                invalid_entity_seed_request("entity seed request exceeds the 8 MiB wire budget")
            })?;
        Ok(())
    }
}

fn entity_seed_utf16_string(value: napi::JsString, label: &str) -> Result<String> {
    let utf16 = value
        .into_utf16()
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    utf16.as_str().map_err(|_| {
        invalid_entity_seed_request(format!("{label} contains a lone UTF-16 surrogate"))
    })
}

fn entity_seed_string_property(
    object: &napi::JsObject,
    name: &str,
    label: &str,
    budget: &mut EntitySeedJsStringBudget,
    field_max_utf8_bytes: Option<usize>,
) -> Result<String> {
    let value: napi::JsString = object
        .get_named_property(name)
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    budget.admit(&value, label, field_max_utf8_bytes)?;
    entity_seed_utf16_string(value, label)
}

fn validate_entity_seed_object_keys(
    object: &napi::JsObject,
    label: &str,
    expected: &[&str],
) -> Result<()> {
    let properties = object
        .get_property_names()
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    let length = properties
        .get_array_length()
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    let mut actual = Vec::with_capacity(length as usize);
    for index in 0..length {
        let key: napi::JsString = properties
            .get_element(index)
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        let key_label = format!("{label} property name");
        let key_utf16_len = key
            .utf16_len()
            .map_err(|error| invalid_entity_seed_request(format!("{key_label}: {error}")))?;
        if key_utf16_len > ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES {
            return Err(invalid_entity_seed_request(format!(
                "{key_label} exceeds {ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES} UTF-8 bytes"
            )));
        }
        let key_utf8_len = key
            .utf8_len()
            .map_err(|error| invalid_entity_seed_request(format!("{key_label}: {error}")))?;
        if key_utf8_len > ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES {
            return Err(invalid_entity_seed_request(format!(
                "{key_label} exceeds {ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES} UTF-8 bytes"
            )));
        }
        let key = entity_seed_utf16_string(key, &key_label)?;
        if !expected.contains(&key.as_str()) {
            return Err(invalid_entity_seed_request(format!(
                "unknown field `{key}` in {label}"
            )));
        }
        actual.push(key);
    }
    for required in expected {
        if !actual.iter().any(|key| key == required) {
            return Err(invalid_entity_seed_request(format!(
                "missing field `{required}` in {label}"
            )));
        }
    }
    Ok(())
}

fn entity_seed_u32_property(object: &napi::JsObject, name: &str, label: &str) -> Result<u32> {
    let value: f64 = object
        .get_named_property(name)
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(invalid_entity_seed_request(format!(
            "{label} must be an unsigned 32-bit integer"
        )));
    }
    Ok(value as u32)
}

fn entity_seed_object_property(
    object: &napi::JsObject,
    name: &str,
    label: &str,
) -> Result<napi::JsObject> {
    object
        .get_named_property(name)
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))
}

fn entity_seed_request_from_js(
    request: napi::JsObject,
) -> Result<grimodex_semantic::entity_seeds::ExtractCodexEntitySeedsRequestV1> {
    validate_entity_seed_object_keys(
        &request,
        "request",
        &[
            "schemaVersion",
            "normalizerVersion",
            "language",
            "minimumOccurrenceCount",
            "sources",
        ],
    )?;
    let mut string_budget = EntitySeedJsStringBudget::default();
    let schema_version =
        entity_seed_u32_property(&request, "schemaVersion", "request.schemaVersion")?;
    let normalizer_version = entity_seed_string_property(
        &request,
        "normalizerVersion",
        "request.normalizerVersion",
        &mut string_budget,
        None,
    )?;
    let language = entity_seed_string_property(
        &request,
        "language",
        "request.language",
        &mut string_budget,
        Some(ENTITY_SEED_MAX_LANGUAGE_UTF8_BYTES),
    )?;
    let minimum_occurrence_count = entity_seed_u32_property(
        &request,
        "minimumOccurrenceCount",
        "request.minimumOccurrenceCount",
    )?;
    let sources_object = entity_seed_object_property(&request, "sources", "request.sources")?;
    if !sources_object
        .is_array()
        .map_err(|error| invalid_entity_seed_request(format!("request.sources: {error}")))?
    {
        return Err(invalid_entity_seed_request(
            "request.sources must be an array",
        ));
    }
    let source_count = sources_object
        .get_array_length()
        .map_err(|error| invalid_entity_seed_request(format!("request.sources: {error}")))?;
    if source_count > ENTITY_SEED_MAX_SOURCES {
        return Err(invalid_entity_seed_request(format!(
            "request.sources must contain at most {ENTITY_SEED_MAX_SOURCES} items"
        )));
    }

    let mut sources = Vec::with_capacity(source_count as usize);
    for index in 0..source_count {
        let label = format!("request.sources[{index}]");
        let source: napi::JsObject = sources_object
            .get_element(index)
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        validate_entity_seed_object_keys(
            &source,
            &label,
            &["sourceRef", "documentRef", "documentRange", "text"],
        )?;
        let range_label = format!("{label}.documentRange");
        let range = entity_seed_object_property(&source, "documentRange", &range_label)?;
        validate_entity_seed_object_keys(&range, &range_label, &["start", "end"])?;
        sources.push(
            grimodex_semantic::entity_seeds::EntitySeedCanonicalSourceV1 {
                source_ref: entity_seed_string_property(
                    &source,
                    "sourceRef",
                    &format!("{label}.sourceRef"),
                    &mut string_budget,
                    Some(ENTITY_SEED_MAX_REF_UTF8_BYTES),
                )?,
                document_ref: entity_seed_string_property(
                    &source,
                    "documentRef",
                    &format!("{label}.documentRef"),
                    &mut string_budget,
                    Some(ENTITY_SEED_MAX_REF_UTF8_BYTES),
                )?,
                document_range: grimodex_semantic::entity_seeds::CanonicalRangeV1 {
                    start: entity_seed_u32_property(
                        &range,
                        "start",
                        &format!("{range_label}.start"),
                    )?,
                    end: entity_seed_u32_property(&range, "end", &format!("{range_label}.end"))?,
                },
                text: entity_seed_string_property(
                    &source,
                    "text",
                    &format!("{label}.text"),
                    &mut string_budget,
                    None,
                )?,
            },
        );
    }

    Ok(
        grimodex_semantic::entity_seeds::ExtractCodexEntitySeedsRequestV1 {
            schema_version,
            normalizer_version,
            language,
            minimum_occurrence_count,
            sources,
        },
    )
}

pub struct ExtractCodexEntitySeedsTask {
    request: std::result::Result<
        grimodex_semantic::entity_seeds::ExtractCodexEntitySeedsRequestV1,
        String,
    >,
}

impl napi::Task for ExtractCodexEntitySeedsTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let request = self
            .request
            .as_ref()
            .map_err(|reason| Error::from_reason(reason.clone()))?;
        let response = grimodex_semantic::entity_seeds::extract_codex_entity_seeds(request)
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&response).map_err(|error| {
            Error::from_reason(format!("failed to serialize entity seeds: {error}"))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn native_workspace_open_trace_enabled() -> bool {
    std::env::var("GRIMODEX_WORKSPACE_OPEN_TRACE")
        .as_deref()
        .is_ok_and(|value| value == "1")
}

/// Semantic commandの共通境界。blocking poolへ投入する**前**にruntimeの
/// optimistic pin（epoch snapshot → active DB Arc → generation再確認）を完了し、
/// closure中にworkspace/epochを再解決しない。これにより切替待ち行列中でも
/// 1 commandが別DB/別cache generationへ跨らない。
async fn run_semantic_wire<T, F>(state: Arc<AppState>, operation: F) -> Result<String>
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(
            &grimodex_semantic::runtime::SemanticRuntime,
            &grimodex_semantic::runtime::SemanticRequest,
        ) -> anyhow::Result<T>
        + Send
        + 'static,
{
    let request = state
        .semantic
        .pin_request(|| active_database(&state.ws))
        .map_err(app_err_to_napi)?;
    let runtime = Arc::clone(&state.semantic);
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let value = operation(&runtime, &request)?;
        Ok(serde_json::to_string(&value)?)
    })
    .await
    .map_err(join_err_to_napi)?
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}

async fn run_scoped_semantic_wire<T, F>(
    state: Arc<AppState>,
    expected_workspace_path: String,
    operation: F,
) -> Result<String>
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(
            &grimodex_semantic::runtime::SemanticRuntime,
            &grimodex_semantic::runtime::SemanticRequest,
        ) -> anyhow::Result<T>
        + Send
        + 'static,
{
    let request = pin_scoped_semantic_request(&state, &expected_workspace_path)?;
    let runtime = Arc::clone(&state.semantic);
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let value = operation(&runtime, &request)?;
        Ok(serde_json::to_string(&value)?)
    })
    .await
    .map_err(join_err_to_napi)?
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}

fn pin_scoped_semantic_request(
    state: &Arc<AppState>,
    expected_workspace_path: &str,
) -> Result<grimodex_semantic::runtime::SemanticRequest> {
    state
        .semantic
        .pin_request(|| {
            let workspace = active_workspace_snapshot(&state.ws)?;
            let active = workspace
                .path()
                .canonicalize()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
            let expected = PathBuf::from(expected_workspace_path)
                .canonicalize()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
            if active != expected {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "SEMANTIC_INDEX_WORKSPACE_CHANGED: expected {}, active {}",
                    expected.display(),
                    active.display()
                )));
            }
            Ok(Arc::clone(workspace.db()))
        })
        .map_err(app_err_to_napi)
}

fn authoritative_ime_options(
    state: &AppState,
    fallback: &ImeExportOptions,
) -> std::result::Result<ImeExportOptions, AppError> {
    let _guard = state
        .gs
        .write_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    let settings = workspace::read_global_settings(&state.gs.path);
    Ok(resolve_options_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

fn authoritative_ime_mode(
    state: &AppState,
    fallback: ImeIntegrationMode,
) -> std::result::Result<ImeIntegrationMode, AppError> {
    let _guard = state
        .gs
        .write_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    let settings = workspace::read_global_settings(&state.gs.path);
    Ok(resolve_mode_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

/// Linearization barrier for a native workspace replacement. The swap hook
/// waits for an old snapshot writer to finish, rotates the request generation,
/// and deactivates the shared pointer before any new writer can enter.
fn rotate_ime_workspace(state: &AppState) {
    rotate_ime_workspace_traced(state, None);
}

fn rotate_ime_workspace_traced(state: &AppState, mut trace: Option<&mut NativeWorkspaceOpenTrace>) {
    let lock_span = trace
        .as_deref_mut()
        .and_then(|trace| trace.begin_span(NativeWorkspaceOpenSpanName::ImeLockWait));
    let _writer = match state.ime_write_lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(trace) = trace {
        trace.finish_span(lock_span);
    }
    state.ime_request_gate.rotate_workspace();
    if let Err(error) = set_active_project(&state.ime_root, None, ImeIntegrationMode::On) {
        eprintln!("failed to deactivate IME pointer during workspace swap: {error}");
    }
}

fn validate_ime_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let expected = PathBuf::from(expected_workspace_path);
    if workspace.path() != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "IME_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            workspace.path().display()
        )));
    }
    Ok(())
}

fn validate_codex_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    // Canonicalize on the same side of the N-API boundary. Node and Rust can
    // use different lexical representations for the same Windows/UNC path
    // (for example Rust's verbatim `\\?\` prefix), so comparing a Rust
    // canonical path with a raw JS string rejects a legitimate workspace.
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "CODEX_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

fn validate_ai_audit_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "AI_AUDIT_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

/// Optimistically bind one request token to the exact DB/path snapshot seen at
/// IPC arrival. A concurrent swap either makes `active_workspace_snapshot`
/// fail closed or changes the gate generation so registration retries.
fn pin_ime_workspace_request(
    state: &AppState,
    expected_workspace_path: &str,
    mut register: impl FnMut(&ImeExportRequestGate, u64) -> Option<ImeExportRequestToken>,
) -> std::result::Result<(ActiveWorkspaceSnapshot, ImeExportRequestToken), AppError> {
    loop {
        let generation = state.ime_request_gate.workspace_generation();
        let workspace = active_workspace_snapshot(&state.ws)?;
        validate_ime_workspace(&workspace, expected_workspace_path)?;
        if let Some(request) = register(&state.ime_request_gate, generation) {
            return Ok((workspace, request));
        }
    }
}

/// agent_writes 19 コマンドの定形写像。FE の `{ payload }` を DTO へ
/// deserialize し、共有 impl を with_db_state 上で呼んで結果 Value を JSON 文字列
/// で返す (Tauri の `with_db(&ws, |db| agent_xxx_impl(db, payload))` の写像)。
/// 各 impl 内で BEGIN IMMEDIATE → tracked write → commit_or_rollback が閉じる。
async fn agent_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(&grimodex_db::Database, T) -> anyhow::Result<serde_json::Value> + Send + 'static,
{
    run_blocking(move || {
        let authority_context = if payload.get("authorityRoute").is_some() {
            let context: grimodex_db::agent_writes::RendererCanonicalWriteContext =
                from_wire(label, payload.clone())?;
            agent_writes::validate_renderer_authority_context(&context)?;
            Some(serde_json::to_value(context).map_err(|error| AppError::Anyhow(error.into()))?)
        } else {
            None
        };
        let dto: T = from_wire(label, payload)?;
        with_db_state(&state.ws, |db| {
            let result = match authority_context {
                Some(context) => {
                    grimodex_db::change_events::with_renderer_authority_context(context, || {
                        f(db, dto)
                    })?
                }
                None => f(db, dto)?,
            };
            Ok(serde_json::to_string(&result)?)
        })
    })
    .await
}

/// Strict renderer mutation variant. The same flat JSON object is decoded as
/// both the long-lived domain DTO and its Gate C1 canonical identity context.
/// Standalone MCP callers continue to use the shared domain functions directly.
async fn canonical_agent_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(
            &grimodex_db::Database,
            T,
            grimodex_db::agent_writes::RendererCanonicalWriteContext,
        ) -> anyhow::Result<serde_json::Value>
        + Send
        + 'static,
{
    run_blocking(move || {
        let dto: T = from_wire(label, payload.clone())?;
        let context = from_wire(label, payload)?;
        agent_writes::validate_renderer_authority_context(&context)?;
        let context_json =
            serde_json::to_value(&context).map_err(|error| AppError::Anyhow(error.into()))?;
        with_db_state(&state.ws, |db| {
            grimodex_db::change_events::with_renderer_authority_context(context_json, || {
                Ok(serde_json::to_string(&f(db, dto, context)?)?)
            })
        })
    })
    .await
}

/// チャット送信の 1 メッセージ (Tauri の `commands::ai::ChatMessagePayload` 相当)。
#[derive(serde::Deserialize)]
struct ChatMsgDto {
    role: String,
    content: String,
}

/// Renderer が request.prepared を durable append した実行との相関だけを渡す。
/// request content / transport header / credential はこの DTO に存在しない。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeAiAuditContext {
    expected_workspace_path: String,
    project_id: Option<String>,
    operation_id: String,
    execution_id: String,
    parent_execution_id: Option<String>,
    path_id: String,
}

impl NativeAiAuditContext {
    fn validate(&self) -> anyhow::Result<()> {
        for (name, value) in [
            (
                "expectedWorkspacePath",
                self.expected_workspace_path.as_str(),
            ),
            ("operationId", self.operation_id.as_str()),
            ("executionId", self.execution_id.as_str()),
            ("pathId", self.path_id.as_str()),
        ] {
            anyhow::ensure!(!value.trim().is_empty(), "auditContext.{name} is required");
            anyhow::ensure!(
                value == value.trim(),
                "auditContext.{name} must not contain surrounding whitespace"
            );
        }
        if let Some(project_id) = self.project_id.as_deref() {
            anyhow::ensure!(
                !project_id.trim().is_empty(),
                "auditContext.projectId must be non-empty or null"
            );
            anyhow::ensure!(
                project_id == project_id.trim(),
                "auditContext.projectId must not contain surrounding whitespace"
            );
        }
        if let Some(parent_execution_id) = self.parent_execution_id.as_deref() {
            anyhow::ensure!(
                !parent_execution_id.trim().is_empty(),
                "auditContext.parentExecutionId must be non-empty or null"
            );
            anyhow::ensure!(
                parent_execution_id == parent_execution_id.trim(),
                "auditContext.parentExecutionId must not contain surrounding whitespace"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeAiHttpAuditRoute {
    provider: String,
    model: String,
    api_variant: Option<String>,
    endpoint_id: Option<String>,
}

impl NativeAiHttpAuditRoute {
    /// Route fields are copied from the exact ChatParams/settings snapshot later used
    /// to build the provider request. No renderer route claim is trusted here.
    fn from_params(
        settings: &grimodex_ai::AiSettings,
        params: &grimodex_ai::ChatParams<'_>,
    ) -> Self {
        let endpoint_id = matches!(params.provider, grimodex_ai::AiProvider::OpenaiCompatible)
            .then(|| settings.active_openai_compatible_endpoint_id.clone())
            .flatten();
        Self {
            provider: params.provider.to_string(),
            model: params.model.to_string(),
            api_variant: params.api_variant.clone(),
            endpoint_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeAiFusionAuditConfiguration {
    enabled: bool,
    custom_configuration_applied: bool,
    configuration_complete: bool,
    analysis_models: Vec<String>,
    judge_model: Option<String>,
    provider_selected_fusion_panel_observed: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct NativeAiEffectiveRequestConfiguration {
    ai_novelist_mode: &'static str,
    request_max_output_tokens: u32,
    resolved_tool_protocol: &'static str,
    retry_429: bool,
    extra_body: Option<serde_json::Value>,
    openrouter_provider_pin: Option<String>,
    fusion: Option<NativeAiFusionAuditConfiguration>,
}

fn ai_novelist_extra_body_for_audit(
    params: &grimodex_ai::ChatParams<'_>,
) -> Option<serde_json::Value> {
    if !matches!(params.provider, grimodex_ai::AiProvider::AiNovelist) {
        return None;
    }
    let source = params.extra_body.as_ref()?.as_object()?;
    let mut projected = serde_json::Map::new();
    for key in grimodex_ai::ai_novelist::EXTRA_SAMPLING_KEYS
        .iter()
        .copied()
        .chain(["multilingualmode", "multilingual_mode"])
    {
        if let Some(value) = source.get(key) {
            projected.insert(key.to_string(), value.clone());
        }
    }
    (!projected.is_empty()).then_some(serde_json::Value::Object(projected))
}

impl NativeAiEffectiveRequestConfiguration {
    fn from_params(params: &grimodex_ai::ChatParams<'_>) -> Self {
        let ai_novelist_mode = match params.ai_novelist_mode {
            grimodex_ai::AiNovelistMode::Chat => "chat",
            grimodex_ai::AiNovelistMode::Completion => "completion",
        };
        let request_max_output_tokens = grimodex_ai::effective_request_max_output_tokens(params);
        let resolved_tool_protocol = match params.resolved_tool_protocol {
            grimodex_ai::ResolvedToolProtocol::Native => "native",
            grimodex_ai::ResolvedToolProtocol::Hermes => "hermes",
        };
        let openrouter_provider_pin =
            matches!(params.provider, grimodex_ai::AiProvider::OpenRouter)
                .then(|| params.openrouter_provider_pin.map(str::trim))
                .flatten()
                .filter(|pin| !pin.is_empty())
                .map(str::to_string);
        let fusion = if matches!(params.provider, grimodex_ai::AiProvider::OpenRouter)
            && params.model == "openrouter/fusion"
        {
            let enabled = params.fusion.is_some_and(|fusion| fusion.enabled);
            let analysis_models = if enabled {
                params
                    .fusion
                    .into_iter()
                    .flat_map(|fusion| fusion.analysis_models.iter())
                    .map(|model| model.trim().to_string())
                    .filter(|model| !model.is_empty())
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let judge_model = if enabled {
                params
                    .fusion
                    .and_then(|fusion| fusion.judge_model.as_deref())
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_string)
            } else {
                None
            };
            let custom_configuration_applied =
                enabled && (!analysis_models.is_empty() || judge_model.is_some());
            let configuration_complete = custom_configuration_applied
                && !analysis_models.is_empty()
                && judge_model.is_some();
            Some(NativeAiFusionAuditConfiguration {
                enabled,
                custom_configuration_applied,
                configuration_complete,
                analysis_models,
                judge_model,
                // The app records its own explicit config. It never claims to observe a
                // provider-selected default panel.
                provider_selected_fusion_panel_observed: false,
            })
        } else {
            None
        };
        Self {
            ai_novelist_mode,
            request_max_output_tokens,
            resolved_tool_protocol,
            retry_429: params.retry_429,
            extra_body: ai_novelist_extra_body_for_audit(params),
            openrouter_provider_pin,
            fusion,
        }
    }
}

trait NativeAiAuditAppender: Send + Sync + 'static {
    fn append(&self, project_id: Option<&str>, events: &[AppendAiAuditEvent])
        -> anyhow::Result<()>;
}

impl NativeAiAuditAppender for Database {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.append_ai_audit_events_for_scope(project_id, events)
            .map(|_| ())
    }
}

impl NativeAiAuditAppender for grimodex_db::WorkspaceAuthority {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.db()
            .append_ai_audit_events_for_scope(project_id, events)
            .map(|_| ())
    }
}

struct NativeAiHttpAuditObserver {
    appender: Arc<dyn NativeAiAuditAppender>,
    context: NativeAiAuditContext,
    route: NativeAiHttpAuditRoute,
    effective_request_configuration: NativeAiEffectiveRequestConfiguration,
}

fn native_ai_audit_timestamp_ms() -> anyhow::Result<i64> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| anyhow::anyhow!("system clock is before Unix epoch: {error}"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| anyhow::anyhow!("AI audit timestamp exceeds i64"))
}

fn native_ai_transport_event_id(
    context: &NativeAiAuditContext,
    attempt_number: u32,
    kind: &str,
) -> String {
    // Length-prefixing makes this deterministic ID injective even if a caller supplies
    // delimiter characters inside executionId. Exact IDs are reused after reply loss.
    format!(
        "native-http:{}:{}:{attempt_number}:{kind}",
        context.execution_id.len(),
        context.execution_id
    )
}

fn native_ai_effective_request_event_id(context: &NativeAiAuditContext) -> String {
    format!(
        "native-effective-request:{}:{}",
        context.execution_id.len(),
        context.execution_id
    )
}

fn native_ai_transport_event(
    context: &NativeAiAuditContext,
    attempt_number: u32,
    kind: &str,
    event_type: &str,
    timestamp: i64,
    payload: serde_json::Value,
) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: native_ai_transport_event_id(context, attempt_number, kind),
        execution_id: context.execution_id.clone(),
        operation_id: context.operation_id.clone(),
        parent_execution_id: context.parent_execution_id.clone(),
        path_id: context.path_id.clone(),
        event_type: event_type.to_string(),
        timestamp,
        payload,
    }
}

fn append_native_ai_audit_exact(
    appender: &dyn NativeAiAuditAppender,
    project_id: Option<&str>,
    events: &[AppendAiAuditEvent],
    description: &str,
) -> anyhow::Result<()> {
    match appender.append(project_id, events) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            appender
                .append(project_id, events)
                .map_err(|second_error| {
                    anyhow::anyhow!(
                        "{description} failed after bounded retry; first append: {first_error:#}; second append: {second_error:#}"
                    )
                })
        }
    }
}

fn native_retry_delay_source(
    source: Option<grimodex_ai::HttpRetryDelaySource>,
) -> Option<&'static str> {
    source.map(|source| match source {
        grimodex_ai::HttpRetryDelaySource::RetryAfter => "retry-after",
        grimodex_ai::HttpRetryDelaySource::ExponentialBackoff => "exponential-backoff",
    })
}

impl grimodex_ai::HttpRetryObserver for NativeAiHttpAuditObserver {
    fn request_prepared(&self, request: &grimodex_ai::HttpPreparedRequest) -> anyhow::Result<()> {
        let timestamp = native_ai_audit_timestamp_ms()?;
        let mut limitations = Vec::new();
        if request.body.is_none() {
            limitations.push("native-effective-request-body-unavailable");
        }
        if let Some(fusion) = self.effective_request_configuration.fusion.as_ref() {
            if fusion.analysis_models.is_empty() {
                limitations.push("openrouter-fusion-provider-selected-panel-unobservable");
            }
            if fusion.judge_model.is_none() {
                limitations.push("openrouter-fusion-provider-selected-judge-unobservable");
            }
        }
        let capture_state = if limitations.is_empty() {
            "complete"
        } else {
            "partial"
        };
        let fusion = self
            .effective_request_configuration
            .fusion
            .as_ref()
            .map(|fusion| {
                serde_json::json!({
                    "enabled": fusion.enabled,
                    "customConfigurationApplied": fusion.custom_configuration_applied,
                    "configurationComplete": fusion.configuration_complete,
                    "analysisModels": fusion.analysis_models,
                    "judgeModel": fusion.judge_model,
                    "providerSelectedFusionPanelObserved": fusion.provider_selected_fusion_panel_observed,
                })
            });
        let event = AppendAiAuditEvent {
            event_id: native_ai_effective_request_event_id(&self.context),
            execution_id: self.context.execution_id.clone(),
            operation_id: self.context.operation_id.clone(),
            parent_execution_id: self.context.parent_execution_id.clone(),
            path_id: self.context.path_id.clone(),
            event_type: "request.prepared".to_string(),
            timestamp,
            payload: serde_json::json!({
                "captureState": capture_state,
                "credentialsExcluded": true,
                "effectiveRequestReceipt": true,
                "request": {
                    "body": request.body,
                },
                "route": {
                    "provider": self.route.provider,
                    "model": self.route.model,
                    "apiVariant": self.route.api_variant,
                    "endpointId": self.route.endpoint_id,
                    "source": "native-effective-request",
                },
                "effectiveRequestConfiguration": {
                    "source": "finalized-reqwest-json-value",
                    "serializationFidelity": "json-value",
                    "serializationWhitespaceAndKeyOrderPreserved": false,
                    "credentialsExcluded": true,
                    "aiNovelistMode": self.effective_request_configuration.ai_novelist_mode,
                    "requestMaxOutputTokens": self.effective_request_configuration.request_max_output_tokens,
                    "resolvedToolProtocol": self.effective_request_configuration.resolved_tool_protocol,
                    "retry429": self.effective_request_configuration.retry_429,
                    "extraBody": self.effective_request_configuration.extra_body,
                    "openrouterProviderPin": self.effective_request_configuration.openrouter_provider_pin,
                    "fusion": fusion,
                },
                "workspacePinned": true,
                "limitations": limitations,
            }),
        };
        append_native_ai_audit_exact(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[event],
            "append native effective request.prepared",
        )
    }

    fn attempt_started(&self, attempt: &grimodex_ai::HttpAttemptStarted) -> anyhow::Result<()> {
        let timestamp = native_ai_audit_timestamp_ms()?;
        let mut limitations = Vec::new();
        let (endpoint_origin, endpoint_host) = match attempt.endpoint.as_ref() {
            Some(endpoint) => (Some(endpoint.origin.as_str()), Some(endpoint.host.as_str())),
            None => {
                limitations.push("native-request-endpoint-unavailable");
                (None, None)
            }
        };
        if let Some(fusion) = self.effective_request_configuration.fusion.as_ref() {
            if fusion.analysis_models.is_empty() {
                limitations.push("openrouter-fusion-provider-selected-panel-unobservable");
            }
            if fusion.judge_model.is_none() {
                limitations.push("openrouter-fusion-provider-selected-judge-unobservable");
            }
        }
        let capture_state = if limitations.is_empty() {
            "complete"
        } else {
            "partial"
        };
        let fusion = self
            .effective_request_configuration
            .fusion
            .as_ref()
            .map(|fusion| {
                serde_json::json!({
                    "enabled": fusion.enabled,
                    "customConfigurationApplied": fusion.custom_configuration_applied,
                    "configurationComplete": fusion.configuration_complete,
                    "analysisModels": fusion.analysis_models,
                    "judgeModel": fusion.judge_model,
                    "providerSelectedFusionPanelObserved": fusion.provider_selected_fusion_panel_observed,
                })
            });
        let event = native_ai_transport_event(
            &self.context,
            attempt.attempt_number,
            "started",
            "transport.attempt.started",
            timestamp,
            serde_json::json!({
                "captureState": capture_state,
                "credentialsExcluded": true,
                "attemptNumber": attempt.attempt_number,
                "sendOrdinal": attempt.send_ordinal,
                "sendPhase": "pre-send",
                "isRetry": attempt.is_retry,
                "reusesInitialPayload": attempt.reuses_initial_payload,
                "requestContentReference": {
                    "executionId": self.context.execution_id,
                    "eventType": "request.prepared",
                    "eventId": native_ai_effective_request_event_id(&self.context),
                },
                "route": {
                    "provider": self.route.provider,
                    "model": self.route.model,
                    "apiVariant": self.route.api_variant,
                    "endpointId": self.route.endpoint_id,
                    "endpointOrigin": endpoint_origin,
                    "endpointHost": endpoint_host,
                    "source": "native-effective-request",
                },
                "effectiveRequestConfiguration": {
                    "source": "native-chat-params",
                    "credentialsExcluded": true,
                    "providerBodyDuplicated": false,
                    "aiNovelistMode": self.effective_request_configuration.ai_novelist_mode,
                    "requestMaxOutputTokens": self.effective_request_configuration.request_max_output_tokens,
                    "resolvedToolProtocol": self.effective_request_configuration.resolved_tool_protocol,
                    "retry429": self.effective_request_configuration.retry_429,
                    "extraBody": self.effective_request_configuration.extra_body,
                    "openrouterProviderPin": self.effective_request_configuration.openrouter_provider_pin,
                    "fusion": fusion,
                },
                "workspacePinned": true,
                "limitations": limitations,
            }),
        );
        append_native_ai_audit_exact(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[event],
            "append transport.attempt.started",
        )
    }

    fn attempt_finished(&self, attempt: &grimodex_ai::HttpAttemptFinished) -> anyhow::Result<()> {
        let timestamp = native_ai_audit_timestamp_ms()?;
        let delay_source = native_retry_delay_source(attempt.retry_delay_source);
        let finished = native_ai_transport_event(
            &self.context,
            attempt.attempt_number,
            "finished",
            "transport.attempt.finished",
            timestamp,
            serde_json::json!({
                "captureState": "complete",
                "credentialsExcluded": true,
                "attemptNumber": attempt.attempt_number,
                "actualHttpSendCount": attempt.actual_send_count,
                "sendPhase": if attempt.local_abort_observed
                    && attempt.actual_send_count.is_some()
                {
                    "pre-send-cancelled"
                } else {
                    "send-invoked"
                },
                "status": attempt.status,
                "finalStatus": if attempt.is_final { attempt.status } else { None },
                "outcome": if attempt.local_abort_observed {
                    "local-abort"
                } else if attempt.status.is_some() {
                    "http-response"
                } else {
                    "transport-error"
                },
                "retryEnabled": attempt.retry_enabled,
                "retryAfterObservedMs": attempt.retry_after_observed_ms,
                "retryDelayMs": attempt.retry_delay_ms,
                "retryDelaySource": delay_source,
                "willRetry": attempt.will_retry,
                "retryExhausted": attempt.retry_exhausted,
                "retryPayloadCloneUnavailable": attempt.retry_payload_clone_unavailable,
                "localAbortObserved": attempt.local_abort_observed,
                "providerAbortReceiptObserved": attempt.provider_abort_receipt_observed,
                "isFinal": attempt.is_final,
                "responseBodyCaptured": false,
            }),
        );
        let mut events = vec![finished];
        if attempt.will_retry {
            events.push(native_ai_transport_event(
                &self.context,
                attempt.attempt_number,
                "retrying",
                "execution.retrying",
                timestamp,
                serde_json::json!({
                    "captureState": "complete",
                    "credentialsExcluded": true,
                    "reason": "http-429",
                    "completedAttemptNumber": attempt.attempt_number,
                    "nextAttemptNumber": attempt.attempt_number.saturating_add(1),
                    "actualHttpSendCount": attempt.actual_send_count,
                    "sendPhase": "send-invoked",
                    "status": attempt.status,
                    "retryDelayMs": attempt.retry_delay_ms,
                    "retryDelaySource": delay_source,
                }),
            ));
        }
        append_native_ai_audit_exact(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &events,
            "append transport.attempt.finished",
        )
    }
}

fn pin_native_ai_audit_workspace(
    state: &AppState,
    context: &NativeAiAuditContext,
) -> std::result::Result<ActiveWorkspaceSnapshot, AppError> {
    context.validate().map_err(AppError::Anyhow)?;
    let workspace = active_workspace_snapshot(&state.ws)?;
    validate_ai_audit_workspace(&workspace, &context.expected_workspace_path)?;
    workspace
        .db()
        .validate_ai_audit_dispatch_precondition(
            context.project_id.as_deref(),
            &context.execution_id,
            &context.operation_id,
            context.parent_execution_id.as_deref(),
            &context.path_id,
        )
        .map_err(AppError::Anyhow)?;
    Ok(workspace)
}

fn attach_native_ai_http_observer(
    params: &mut grimodex_ai::ChatParams<'_>,
    settings: &grimodex_ai::AiSettings,
    workspace: &ActiveWorkspaceSnapshot,
    context: NativeAiAuditContext,
) {
    let route = NativeAiHttpAuditRoute::from_params(settings, params);
    let effective_request_configuration =
        NativeAiEffectiveRequestConfiguration::from_params(params);
    let appender: Arc<dyn NativeAiAuditAppender> = workspace.db().clone();
    params.http_retry_observer = Some(Arc::new(NativeAiHttpAuditObserver {
        appender,
        context,
        route,
        effective_request_configuration,
    }));
}

fn sanitize_native_ai_diagnostic(error: &anyhow::Error) -> String {
    sanitize_diagnostic_credentials(&format!("{error:#}"))
}

fn native_ai_error_to_napi(error: anyhow::Error) -> Error {
    Error::from_reason(sanitize_native_ai_diagnostic(&error))
}

/// `send_chat_message` / `send_chat_message_stream` の FE 引数 (camelCase)。
/// Tauri コマンドの引数群と 1:1。**API キーは含まない** — キーは main プロセスの
/// safeStorage で解決した平文を別引数 `api_key` で注入する (Phase 3 バッチ3a)。
/// Option フィールドは serde が欠落を None として扱う (Tauri の Option 引数と同挙動)。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    stream_id: Option<String>,
    messages: Vec<ChatMsgDto>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
    expected_ollama_endpoint: Option<String>,
    request_max_output_tokens: Option<u32>,
    audit_context: NativeAiAuditContext,
}

/// `send_inline_ai_stream` の FE 引数 (camelCase)。チャットと同じ message / reasoning
/// 形だが、prompt cache / web search は受けず、AI のべりすとでは Completion mode を使う。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InlineAiRequest {
    stream_id: String,
    messages: Vec<ChatMsgDto>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    model: Option<String>,
    api_variant: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
    audit_context: NativeAiAuditContext,
}

/// `send_agent_message` の FE 引数 (camelCase)。AgentMessage / AgentToolDef の
/// serde 定義を直接使い、toolUses / thinkingBlocks / inputSchema のワイヤをTauriと共有する。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    messages: Vec<grimodex_ai::AgentMessage>,
    tools: Vec<grimodex_ai::AgentToolDef>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    web_search: Option<grimodex_ai::WebSearchConfig>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
    expected_ollama_endpoint: Option<String>,
    request_max_output_tokens: Option<u32>,
    resolved_tool_protocol: Option<grimodex_ai::ResolvedToolProtocol>,
    audit_context: NativeAiAuditContext,
}

/// `list_ai_models` の FE 引数。API キーは一覧取得では任意なので main が
/// safeStorage から取得できた値（未設定なら空文字）を別引数で注入する。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAiModelsRequest {
    provider: grimodex_ai::AiProvider,
    endpoint_id: Option<String>,
    selected_model_id: Option<String>,
    expected_ollama_endpoint: Option<String>,
}

/// `test_ai_connection` の FE 引数。接続先 provider/model は必須、variant / endpoint
/// は任意で、既知 endpoint だけを一時的に active へ切り替える。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestAiConnectionRequest {
    provider: grimodex_ai::AiProvider,
    model: String,
    api_variant: Option<String>,
    endpoint_id: Option<String>,
    audit_context: NativeAiAuditContext,
}

#[napi]
pub struct Backend {
    state: Arc<AppState>,
}

#[napi]
impl Backend {
    /// `app_data_dir` は Electron main の `app.getPath("userData")` を明示注入
    /// (§4.2 / §6.8 — Phase 2 は `GrimodexElectronDev` 名で動かし、Tauri の
    /// com.miyakey.grimodex には触らない)。
    #[napi(constructor)]
    pub fn new(
        app_data_dir: String,
        semantic_resource_root: Option<String>,
        reranker_resource_root: Option<String>,
    ) -> Result<Backend> {
        // 旧 .node E2E / 外部callerとのconstructor互換を維持する。省略時はcwdや
        // build-time manifestへfallbackせず、必ず存在しないappData配下sentinelを使い、
        // Backend全体ではなくsemantic invokeだけをmodel missingで失敗させる。
        let semantic_resource_root = semantic_resource_root.unwrap_or_else(|| {
            PathBuf::from(&app_data_dir)
                .join("__missing_semantic_resources__")
                .to_string_lossy()
                .into_owned()
        });
        let state = AppState::new_with_reranker_root(
            &app_data_dir,
            &semantic_resource_root,
            reranker_resource_root.as_deref(),
        )
        .map_err(|e| Error::from_reason(format!("{e:#}")))?;
        // §7.1 の end-to-end 実証チャネルその 1。onEvent 登録前なので
        // EventQueue にバッファされ、登録時に flush される。schemaVersion は
        // スモークテストが PRAGMA user_version との一致検証に使う。
        state.events.emit(
            "backend:ready",
            serde_json::json!({ "schemaVersion": grimodex_core::SCHEMA_VERSION }),
        );
        Ok(Backend {
            state: Arc::new(state),
        })
    }

    // ─────────────────────── license (Phase 3e) ──────────────────────────

    /// Main-process-only bridge used during the Electron v2 first-run
    /// credential migration. This method is deliberately absent from
    /// `NAPI_COMMANDS`, so renderer IPC cannot request plaintext credentials.
    /// Feature-off development builds return a disabled envelope and never
    /// touch the OS keyring.
    #[napi]
    pub async fn read_legacy_api_keys_for_migration(&self) -> Result<String> {
        #[cfg(feature = "legacy-keyring-migration")]
        {
            let settings_path = self.state.ai_settings_path.clone();
            run_blocking(move || {
                let export = legacy_keyring::read_legacy_api_keys(&settings_path)?;
                Ok(serde_json::to_string(&export).map_err(anyhow::Error::from)?)
            })
            .await
        }

        #[cfg(not(feature = "legacy-keyring-migration"))]
        {
            Ok(r#"{"available":false,"entries":[]}"#.to_string())
        }
    }

    /// Main/CI-only build gate. Packaging verifies both release-only features
    /// before electron-builder runs; this method is not registered in renderer
    /// IPC and contains no user data.
    #[napi]
    pub async fn get_native_build_capabilities(&self) -> Result<String> {
        Ok(serde_json::json!({
            "licensing": cfg!(feature = "licensing"),
            "legacyKeyringMigration": cfg!(feature = "legacy-keyring-migration"),
        })
        .to_string())
    }

    /// 常時exportするライセンス状態IPC。feature無効buildでは共有crateが
    /// exact disabled DTOを返し、license.jsonには一切触れない。
    #[napi]
    pub async fn get_license_state(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        napi::tokio::task::spawn_blocking(move || {
            grimodex_license::get_license_state(&runtime)
                .and_then(|dto| serde_json::to_string(&dto).map_err(Into::into))
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    /// Polar activate → atomic license.json更新。HTTP await中にfile lockは保持しない。
    #[napi]
    pub async fn activate_license(&self, key: String) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::activate_license(&runtime, key)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 明示的な再検証。共有runtimeのsingle-flightとstale response guardを使う。
    #[napi]
    pub async fn revalidate_license(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::revalidate_license(&runtime)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Polar側を解除してから、同じactivationである場合だけlocal stateを破棄する。
    #[napi]
    pub async fn deactivate_license(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::deactivate_license(&runtime)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 起動5秒後/以後6時間周期のmain schedulerから呼ぶfail-soft cycle。
    /// disabled・not due・in-flightはJS null、実行後はJSON DTOを返す。
    #[napi]
    pub async fn run_license_validate_cycle(&self) -> Result<Option<String>> {
        let runtime = Arc::clone(&self.state.license);
        grimodex_license::run_validate_cycle(&runtime)
            .await
            .map(|dto| {
                serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
            })
            .transpose()
    }

    /// Electron main scheduler 専用の Change Feed freshness cycle。
    /// renderer IPC には登録せず、1 call で共有runtimeの有界batchを最大1件だけ
    /// 処理する。workspace未open・切替中・Safe Mode・feed空はJS nullを返す。
    #[napi]
    pub async fn run_narrative_freshness_cycle(&self) -> Result<Option<String>> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let authority = match active_database(&state.ws) {
                Ok(authority) => authority,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => return Ok(None),
                Err(error) => return Err(error),
            };
            match narrative_extraction::run_incremental_freshness_cycle(authority.db())? {
                narrative_extraction::IncrementalFreshnessCycleOutcome::Idle => Ok(None),
                narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(summary) => {
                    Ok(Some(
                        serde_json::json!({
                            "projectId": summary.project_id,
                            "fromSequenceExclusive": summary.from_sequence_exclusive,
                            "throughSequenceInclusive": summary.through_sequence_inclusive,
                            "affectedEdgeCount": summary.affected_edge_count,
                            "affectedConsumerCount": summary.affected_consumer_count,
                            "hasMore": summary.has_more,
                        })
                        .to_string(),
                    ))
                }
            }
        })
        .await
    }

    /// drizzle-proxy (src/db/client.ts) の唯一の通り道 (§4.3 — これだけで
    /// CRUD の 9 割が生きる)。`params` は位置パラメータの JSON 配列、`method`
    /// は "run" | "get" | "all" | "values"。
    /// 返り値: `QueryResult` の JSON 文字列 `{"rows":[…]}` (Tauri ワイヤと同形)。
    #[napi]
    pub async fn db_execute(
        &self,
        sql: String,
        params: serde_json::Value,
        method: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let params = params_array(params)?;
            with_db_state(&state.ws, |db| {
                let rows = db.execute_renderer(&sql, &params, &method)?;
                Ok(serde_json::to_string(&QueryResult { rows })?)
            })
        })
        .await
    }

    /// 複数文を単一トランザクションで実行 (BEGIN IMMEDIATE、途中失敗で全
    /// ROLLBACK — grimodex-db の `execute_batch_tx`)。オートセーブの通り道。
    /// `statements` は `[{ sql, params, method }, …]`。
    /// 返り値: 最終文の rows を載せた `QueryResult` の JSON 文字列。
    #[napi]
    pub async fn db_execute_batch(&self, statements: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let statements: Vec<BatchStatement> = from_wire("statements", statements)?;
            with_db_state(&state.ws, |db| {
                let rows = db.execute_batch_tx_renderer(&statements)?;
                Ok(serde_json::to_string(&QueryResult { rows })?)
            })
        })
        .await
    }

    /// Read Native-owned Narrative runtime policy (Release Gate B Foundation).
    #[napi]
    pub async fn narrative_runtime_policy_get(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let policy = grimodex_db::load_narrative_runtime_policy_from_db(db)?;
                Ok(serde_json::to_string(&serde_json::json!({
                    "runtimeMode": policy.runtime_mode.as_str(),
                    "maintenanceEnabled": policy.maintenance_enabled,
                    "genericImportEnabled": policy.generic_import_enabled,
                    "backgroundAiEnabled": policy.background_ai_enabled,
                    "version": policy.version,
                    "effectiveMode": policy.effective_mode().as_str(),
                    "maintenancePreviewAllowed": policy.maintenance_preview_allowed(),
                }))?)
            })
        })
        .await
    }

    /// CAS update for Native-owned Narrative runtime policy.
    #[napi]
    pub async fn narrative_runtime_policy_set(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let input: grimodex_db::SetNarrativeRuntimePolicyInput = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let policy = grimodex_db::set_narrative_runtime_policy(db, input)?;
                Ok(serde_json::to_string(&serde_json::json!({
                    "runtimeMode": policy.runtime_mode.as_str(),
                    "maintenanceEnabled": policy.maintenance_enabled,
                    "genericImportEnabled": policy.generic_import_enabled,
                    "backgroundAiEnabled": policy.background_ai_enabled,
                    "version": policy.version,
                    "effectiveMode": policy.effective_mode().as_str(),
                    "maintenancePreviewAllowed": policy.maintenance_preview_allowed(),
                }))?)
            })
        })
        .await
    }

    /// Typed persistence commands for Editor-only visual stickies. The
    /// renderer sends document-shaped DTOs; SQL and typed owner derivation
    /// stay inside grimodex-db.
    #[napi]
    pub async fn editor_sticky_list(
        &self,
        project_id: String,
        document_key: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&editor_stickies::list(
                    db,
                    project_id,
                    document_key,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn editor_sticky_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: editor_stickies::CreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&editor_stickies::create(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn editor_sticky_update(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: editor_stickies::UpdatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&editor_stickies::update(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn editor_sticky_delete(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: editor_stickies::DeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| editor_stickies::delete(db, payload))
        })
        .await
    }

    /// Project-scoped lint diagnostic ignore-list commands. The renderer
    /// receives a domain DTO instead of owning SQL strings or generic DB
    /// parameters; all scene ownership checks happen in grimodex-db.
    #[napi]
    pub async fn lint_ignore_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::list_for_project(db, project_id)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_list_scene(
        &self,
        project_id: String,
        scene_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::list_for_scene(db, project_id, scene_id)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::create(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_delete(&self, project_id: String, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| lint_ignores::delete(db, project_id, id))
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_copy(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CopyPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::copy(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_move(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: MovePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::move_to_scene(db, payload)?)
            })
        })
        .await
    }

    /// Project-scoped term-dictionary commands. SQL and project ownership stay
    /// in grimodex-db; the renderer only sends domain DTOs.
    #[napi]
    pub async fn lint_term_dictionary_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::list(db, project_id)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_insert(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: LintTermInsertPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::insert(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_update(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: LintTermUpdatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::update(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_set_enabled(
        &self,
        project_id: String,
        id: String,
        enabled: bool,
        updated_at: i64,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::set_enabled(
                    db, project_id, id, enabled, updated_at,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_delete(&self, project_id: String, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| lint_terms::delete(db, project_id, id)))
            .await
    }

    /// Chronicle aggregate OCC reads and participant replacement. The latter
    /// advances the event version and replaces participants in one DB tx.
    #[napi]
    pub async fn event_get_version(&self, project_id: String, event_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&chronicle::get_event_version(
                    db, project_id, event_id,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn event_set_participants(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: SetParticipantsPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&chronicle::set_event_participants(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Project Calendar create/update, single-row OCC (see `chronicle` module
    /// docs). Returns the persisted row as JSON, or JSON `null` on conflict.
    #[napi]
    pub async fn project_calendar_upsert(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: UpsertProjectCalendarPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&chronicle::upsert_project_calendar(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Renderer domain aggregates that previously crossed the preload
    /// boundary as renderer-authored SQL batches.
    #[napi]
    pub async fn authorship_replace_lane(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ReplaceAuthorshipLanePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                domain_writes::replace_authorship_lane(db, payload)
            })
        })
        .await
    }

    #[napi]
    pub async fn entity_tags_set(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: SetEntityTagsPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| domain_writes::set_entity_tags(db, payload))
        })
        .await
    }

    #[napi]
    pub async fn codex_rename_undo(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CodexRenameUndoPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::undo_codex_rename(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn codex_rename_apply(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CodexRenameApplyPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::apply_codex_rename(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn scan_staging_project_create(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CreateScanStagingProjectPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                domain_writes::create_scan_staging_project(db, payload)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ProjectCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::project_create(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_patch(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ProjectPatchPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::project_patch(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_delete(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ProjectDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| domain_writes::project_delete(db, payload))
        })
        .await
    }

    #[napi]
    pub async fn ai_tree_plan_apply(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ApplyAiTreePlanPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::apply_ai_tree_plan(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn ai_tree_plan_undo(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: UndoAiTreePlanPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::undo_ai_tree_plan(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn tree_node_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: TreeNodeCreatePayload, context| {
                domain_writes::tree_node_create_with_authority(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn tree_node_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: TreeNodeDeletePayload, context| {
                domain_writes::tree_node_delete_with_authority(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn tree_node_patch(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: TreeNodePatchPayload, context| {
                domain_writes::tree_node_patch_with_authority(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn temporal_scene_patch(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let temporal_payload: TemporalScenePatchPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::temporal_scene_patch(db, temporal_payload)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn map_write_bundle(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: MapWritePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&map_writes::apply_map_write(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Project snapshots are a typed aggregate: renderer computes the
    /// dependency-safe row plan while shared Rust owns all SQL, project
    /// ownership checks, and transaction boundaries.
    #[napi]
    pub async fn project_snapshot_create(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CreateProjectSnapshotPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                project_snapshots::create_project_snapshot(db, payload)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_snapshot_restore_context(
        &self,
        project_id: String,
        snapshot_id: String,
        scopes: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let scopes: Vec<RestoreScope> = from_wire("scopes", scopes)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &project_snapshots::project_snapshot_restore_context(
                        db,
                        project_id,
                        snapshot_id,
                        scopes,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_snapshot_apply_restore(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ApplyProjectSnapshotRestorePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &project_snapshots::apply_project_snapshot_restore(db, payload)?,
                )?)
            })
        })
        .await
    }

    /// Restore one persisted Scene revision. Safety revision, OCC body write,
    /// canonical audit event, Narrative Change Feed, and retry receipt share
    /// one Native transaction.
    #[napi]
    pub async fn revision_scene_restore(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: RestoreSceneRevisionPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = revision_restore::restore_scene_revision(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Scene content and every document-derived sidecar are committed in one
    /// SQLite transaction. The renderer performs one PM traversal and passes
    /// the typed snapshot as camelCase JSON.
    #[napi]
    pub async fn save_scene_body_bundle(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: SaveSceneBodyBundlePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = scene_body::save_scene_body_bundle(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// CI-only deterministic runtime fixture writer. The per-launch owner
    /// token makes the command fail closed outside the performance harness;
    /// the shared DB layer validates and commits the typed graph in one tx.
    #[napi]
    pub async fn runtime_performance_seed(
        &self,
        owner_token: String,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            validate_runtime_performance_owner_token(&owner_token)?;
            runtime_performance_seed::validate_runtime_performance_seed_wire_value(&payload)?;
            let payload: RuntimePerformanceSeedPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result =
                    runtime_performance_seed::seed_runtime_performance_fixture(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Compact the active workspace in place. Unlike raw renderer SQL, this
    /// command accepts no destination path and cannot become `VACUUM INTO`.
    #[napi]
    pub async fn vacuum_database(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.vacuum())).await
    }

    /// workspace を開く: migrate → swap → RAII SwitchingGuard →
    /// authority commit 後の低優先度 maintenance worker →
    /// recent-workspaces 更新 (`grimodex_db::open::open_workspace_sync` —
    /// Tauri コマンドと同一経路。A3 相互運用の根拠)。swap直後hookで
    /// Codex matcher破棄 + semantic 4cache epoch rotateを行う。
    /// 完了時に `workspace:opened` (FE 購読者なしのデバッグチャネル) を emit
    /// する (§7.1 の end-to-end 実証チャネルその 2)。
    /// 返り値: WorkspaceOpenOutcome JSON
    /// (`ready`/`migrated`/`recovery-required`/`safe-mode`)。
    #[napi]
    pub async fn open_workspace(&self, path: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        let trace_enabled = native_workspace_open_trace_enabled();
        let trace_started_at = Instant::now();
        let mut trace = NativeWorkspaceOpenTrace::with_start(trace_started_at, trace_enabled);
        let blocking_pool_span = trace.begin_span(NativeWorkspaceOpenSpanName::BlockingPoolWait);
        let task = napi::tokio::task::spawn_blocking(move || {
            trace.finish_span(blocking_pool_span);
            let state_for_hook = Arc::clone(&state);
            let mut on_swapped = move |trace: &mut NativeWorkspaceOpenTrace| {
                rotate_ime_workspace_traced(&state_for_hook, Some(trace));

                let matcher_span = trace.begin_span(NativeWorkspaceOpenSpanName::MatcherLockWait);
                let mut matcher = match state_for_hook.codex_matcher.lock() {
                    Ok(matcher) => matcher,
                    Err(poisoned) => poisoned.into_inner(),
                };
                trace.finish_span(matcher_span);
                *matcher = None;

                let semantic_span = trace.begin_span(NativeWorkspaceOpenSpanName::SemanticRotate);
                state_for_hook.semantic.rotate_workspace_epoch();
                trace.finish_span(semantic_span);
            };
            let result = match open_workspace_sync_traced(
                &state.ws,
                &state.gs,
                &path,
                &mut trace,
                &mut on_swapped,
            ) {
                Ok(opened) => {
                    let serialize_span =
                        trace.begin_span(NativeWorkspaceOpenSpanName::SerializeEvent);
                    state
                        .events
                        .emit("workspace:opened", serde_json::json!({ "path": path }));
                    match serde_json::to_string(&opened) {
                        Ok(json) => {
                            trace.finish_span(serialize_span);
                            Ok(json)
                        }
                        Err(error) => {
                            trace.fail_span(serialize_span);
                            Err(AppError::Anyhow(anyhow::Error::from(error)))
                        }
                    }
                }
                Err(error) => Err(error),
            };
            (trace, result)
        })
        .await;

        match task {
            Ok((mut trace, result)) => {
                let terminal = if result.is_ok() {
                    NativeWorkspaceOpenResult::Ready
                } else {
                    NativeWorkspaceOpenResult::Failed
                };
                trace.emit_terminal(terminal);
                result.map_err(app_err_to_napi)
            }
            Err(error) => {
                let mut trace =
                    NativeWorkspaceOpenTrace::with_start(trace_started_at, trace_enabled);
                trace.emit_terminal(NativeWorkspaceOpenResult::Failed);
                Err(join_err_to_napi(error))
            }
        }
    }

    /// 既存 workspace 判定 (commands/workspace.rs の同名コマンドと同一実装)。
    /// 軽量 stat のみなので設計どおり同期のまま (§4.2「純関数の validate 除く」)。
    #[napi]
    pub fn validate_workspace_path(&self, path: String) -> bool {
        let p = PathBuf::from(&path);
        p.exists() && p.is_dir() && p.join("grimodex.db").exists()
    }

    /// Electron main専用の内部境界。standalone MCP sidecarへ渡す現在の
    /// workspace directoryを返す。renderer commandとしては公開せず、mainの
    /// `get_mcp_config` handlerだけが利用する。
    #[napi]
    pub async fn get_active_workspace_path(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let path = active_workspace_path(&state.ws)?;
            path.into_os_string().into_string().map_err(|_| {
                AppError::Anyhow(anyhow::anyhow!("Active workspace path is not valid UTF-8"))
            })
        })
        .await
    }

    /// Main-only Codex App Server binding lookup. This method is intentionally
    /// not registered in `NAPI_COMMANDS`: renderer cannot select an external
    /// thread or bypass the project/session ownership check.
    #[napi]
    pub async fn get_chat_runtime_thread_binding(
        &self,
        project_id: String,
        session_id: String,
        runtime: String,
        expected_workspace_path: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            let binding = workspace.db().get_chat_runtime_thread_binding(
                &project_id,
                &session_id,
                &runtime,
            )?;
            Ok(serde_json::to_string(&binding).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Main-only Codex App Server binding upsert. The shared DB layer verifies
    /// that session_id belongs to project_id and that the external id is not
    /// already attached to another runtime session.
    #[napi]
    pub async fn upsert_chat_runtime_thread_binding(
        &self,
        binding: serde_json::Value,
        expected_workspace_path: String,
    ) -> Result<()> {
        let binding =
            from_wire::<grimodex_db::runtime_threads::RuntimeThreadBinding>("binding", binding)
                .map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            workspace
                .db()
                .upsert_chat_runtime_thread_binding(&binding)?;
            Ok(())
        })
        .await
    }

    /// Main-only compare-and-swap bridge for committing a completed Codex turn's
    /// pending history revision. A stale or competing completion returns `false`.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn advance_chat_runtime_thread_history_revision(
        &self,
        expected_workspace_path: String,
        project_id: String,
        session_id: String,
        runtime: String,
        external_thread_id: String,
        last_turn_id: String,
        pending_history_revision: String,
        next_history_revision: String,
        updated_at: String,
    ) -> Result<bool> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            Ok(workspace
                .db()
                .advance_chat_runtime_thread_history_revision(
                    &project_id,
                    &session_id,
                    &runtime,
                    &external_thread_id,
                    &last_turn_id,
                    &pending_history_revision,
                    &next_history_revision,
                    &updated_at,
                )?)
        })
        .await
    }

    /// Main-only Codex App Server binding deletion with project/session guard.
    #[napi]
    pub async fn delete_chat_runtime_thread_binding(
        &self,
        project_id: String,
        session_id: String,
        runtime: String,
        expected_workspace_path: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            workspace.db().delete_chat_runtime_thread_binding(
                &project_id,
                &session_id,
                &runtime,
            )?;
            Ok(())
        })
        .await
    }

    /// アクティブworkspaceの復元候補を新しい順で返す。
    /// 返り値は `BackupInfo[]` のcamelCase JSON文字列。
    #[napi]
    pub async fn list_backups(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let backups = list_backups(&state.ws)?;
            Ok(serde_json::to_string(&backups).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// バックアップを検証・安全退避・原子置換し、同じworkspaceを再openする。
    /// 再open時にDB由来のCodex matcherを破棄し、semantic 4-cache epochも
    /// rotateして復元前DBへのlate writeを不可視にする。
    #[napi]
    pub async fn restore_backup(&self, file_name: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let state_for_hook = Arc::clone(&state);
            restore_backup_core(&state.ws, &file_name, move || {
                rotate_ime_workspace(&state_for_hook);
                let mut matcher = match state_for_hook.codex_matcher.lock() {
                    Ok(matcher) => matcher,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *matcher = None;
                state_for_hook.semantic.rotate_workspace_epoch();
            })?;
            let path = active_workspace_path(&state.ws)?;
            state.events.emit(
                "workspace:opened",
                serde_json::json!({ "path": path, "reason": "restore" }),
            );
            Ok(())
        })
        .await
    }

    /// Safe Mode中の復元候補をopaque idだけで列挙する。
    #[napi]
    pub async fn list_recovery_candidates(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let candidates = list_safe_mode_candidates(&state.ws)?;
            Ok(serde_json::to_string(&candidates).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// candidate idを検証し、復元前の候補メタデータを返す。
    #[napi]
    pub async fn verify_recovery_candidate(&self, candidate_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let candidate = verify_safe_mode_candidate(&state.ws, &candidate_id)?;
            Ok(serde_json::to_string(&candidate).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Safe Mode候補を復元する。復元後はrendererがopen_workspaceを再実行する。
    #[napi]
    pub async fn restore_recovery_candidate(&self, candidate_id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || restore_safe_mode_candidate(&state.ws, &candidate_id)).await
    }

    /// 現在の破損live DBをworkspace内の隔離名へ移動し、そのfile nameを返す。
    #[napi]
    pub async fn quarantine_live_database(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let file_name = quarantine_live_database(&state.ws)?;
            Ok(serde_json::to_string(&file_name).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Safe Mode診断JSONを書き出し、そのpath文字列を返す。
    #[napi]
    pub async fn export_safe_mode_diagnostics(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let path = export_safe_mode_diagnostics(&state.ws)?;
            Ok(serde_json::to_string(&path).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 起動時に必ず呼ばれる (workspace/store.ts:152)。
    /// 返り値: `GlobalSettings` の JSON 文字列 (camelCase — Tauri ワイヤと同形)。
    #[napi]
    pub async fn get_global_settings(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _guard = state
                .gs
                .write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let settings = workspace::read_global_settings(&state.gs.path);
            Ok(serde_json::to_string(&settings).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `settings` は GlobalSettings 全体 (camelCase オブジェクト)。tmp+rename の
    /// 原子的書き込みと write_lock 直列化は Tauri コマンドと同一経路。
    #[napi]
    pub async fn save_global_settings(&self, settings: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let settings: GlobalSettings = from_wire("settings", settings)?;
            let _guard = state
                .gs
                .write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            workspace::write_global_settings(&state.gs.path, &settings)?;
            Ok(())
        })
        .await
    }

    /// AppData配下に一意なsample-workspace世代を共有coreで公開する。
    /// GlobalSettingsのwrite_lockをget/save/openと共有し、同時seedも同じ
    /// critical sectionへ入る。公開済み世代はアクティブDB/MCPが保持し得るため削除しない。
    #[napi]
    pub async fn seed_sample_workspace(
        &self,
        language: String,
        ai_policy: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let result = sample_seed::seed_sample_workspace(&state.gs, &language, &ai_policy)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Hosted Web Editorがローカル保存したversioned handoffを検証し、
    /// AppData配下の新しいworkspace世代として公開する。現在のactive workspaceは
    /// 触らず、rendererが通常のopen_workspace経路で明示的に切り替える。
    #[napi]
    pub async fn import_web_editor_workspace(&self, handoff_json: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let result = web_editor_handoff::import_web_editor_workspace(&state.gs, &handoff_json)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 監査チェーン append (commands/timelapse.rs の写像。編集ループ常連の
    /// 軽量 DB 書き込み。§4.3)。`events` は camelCase の AppendChangeEvent 配列
    /// (Tauri の camelCase→snake_case 自動変換は serde の rename_all が担う)。
    /// 返り値: `AppendResult` (`{"insertedCount":…,"tailSequence":…,"tailHash":…}`)
    /// の JSON 文字列。
    #[napi]
    pub async fn timelapse_append_batch(
        &self,
        project_id: String,
        session_id: String,
        events: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let events: Vec<AppendChangeEvent> = from_wire("events", events)?;
            with_db_state(&state.ws, |db| {
                let result = db.append_change_events(&project_id, &session_id, &events)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Append a durable batch to the complete AI-use audit ledger. The
    /// renderer snapshots `expected_workspace_path` before dispatch; every
    /// subsequent event must still target that exact workspace. A workspace
    /// switch therefore leaves a visible non-terminal execution instead of
    /// writing its terminal event into the newly active project database.
    #[napi]
    pub async fn ai_audit_append_batch(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        events: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let events: Vec<AppendAiAuditEvent> = from_wire("events", events)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let result = workspace
                .db()
                .append_ai_audit_events_for_scope(project_id.as_deref(), &events)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Validate the durable CLI lifecycle and atomically append the
    /// main-owned one-shot dispatch claim before the shell manager can spawn.
    #[allow(clippy::too_many_arguments)]
    #[napi]
    pub async fn ai_audit_claim_cli_dispatch(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        execution_id: String,
        operation_id: String,
        parent_execution_id: Option<String>,
        path_id: String,
        expected_request_sha256: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let result = workspace.db().claim_cli_ai_audit_dispatch(
                project_id.as_deref(),
                &execution_id,
                &operation_id,
                parent_execution_id.as_deref(),
                &path_id,
                &expected_request_sha256,
            )?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Read one immutable high-water snapshot. Rows appended after the
    /// selected high-water sequence are deliberately excluded from export.
    #[napi]
    pub async fn ai_audit_read_snapshot(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        after_sequence: Option<i64>,
        high_water_sequence: Option<i64>,
        limit: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let snapshot = workspace.db().read_ai_audit_snapshot_for_scope(
                project_id.as_deref(),
                after_sequence,
                high_water_sequence,
                limit,
            )?;
            Ok(serde_json::to_string(&snapshot).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Verify payload digests, event hashes, sequence continuity, and the
    /// project-global previous-hash chain through an optional high-water mark.
    #[napi]
    pub async fn ai_audit_verify(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        high_water_sequence: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let result = workspace
                .db()
                .verify_ai_audit_chain_for_scope(project_id.as_deref(), high_water_sequence)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 現在の Codex 読みを `<userData>/ime/projects/<projectId>.json` へ再出力する。
    /// options は typed IPC と同じ camelCase `ImeExportOptions`。DB 読み取りと
    /// ファイル I/O の双方を Node main thread の外で実行する。
    #[napi]
    pub async fn ime_export_refresh(
        &self,
        project_id: String,
        expected_workspace_path: String,
        options: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let options: ImeExportOptions = from_wire("options", options).map_err(app_err_to_napi)?;
        let (workspace, request) =
            pin_ime_workspace_request(&state, &expected_workspace_path, |gate, generation| {
                gate.register_refresh_for_generation(&project_id, &options, generation)
            })
            .map_err(app_err_to_napi)?;
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let options = authoritative_ime_options(&state, &options)?;
            if !state.ime_request_gate.is_current(&request) {
                let status = get_ime_export_status(&state.ime_root, options.mode)?;
                return Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?);
            }
            let status = refresh_project_export(
                workspace.db().as_ref(),
                &state.ime_root,
                &project_id,
                &options,
            )?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// IME consumer が参照する active project を切り替える。`None` は明示的な
    /// deactivation であり、renderer からの null をそのまま受ける。
    #[napi]
    pub async fn ime_export_set_active_project(
        &self,
        project_id: Option<String>,
        expected_workspace_path: Option<String>,
        mode: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let mode: ImeIntegrationMode =
            from_wire("mode", serde_json::Value::String(mode)).map_err(app_err_to_napi)?;
        let request = if project_id.is_some() {
            let expected_workspace_path = expected_workspace_path.ok_or_else(|| {
                Error::from_reason(
                    "expectedWorkspacePath is required when activating an IME project",
                )
            })?;
            let (_, request) = pin_ime_workspace_request(
                &state,
                &expected_workspace_path,
                ImeExportRequestGate::register_active_for_generation,
            )
            .map_err(app_err_to_napi)?;
            request
        } else {
            state.ime_request_gate.register_active()
        };
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let mode = authoritative_ime_mode(&state, mode)?;
            if !state.ime_request_gate.is_current(&request) {
                let status = get_ime_export_status(&state.ime_root, mode)?;
                return Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?);
            }
            let status = set_active_project(&state.ime_root, project_id.as_deref(), mode)?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Electron の will-quit 専用。blocking pool の処理をタイムアウトで
    /// 打ち切ると state.json が旧 project を指したまま終了し得るため、ここだけ
    /// 同期的に writer mutex を待ち、active pointer の解除完了を保証する。
    #[napi]
    pub fn ime_export_deactivate_on_exit(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        let request = state.ime_request_gate.register_active();
        let _guard = state
            .ime_write_lock
            .lock()
            .map_err(|e| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!("{e}"))))?;
        if !state.ime_request_gate.is_current(&request) {
            return Ok(());
        }
        set_active_project(&state.ime_root, None, ImeIntegrationMode::On)
            .map(|_| ())
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))
    }

    /// consumer handshake と現在の export 状態を返す。
    #[napi]
    pub async fn ime_export_get_status(&self, mode: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let fallback: ImeIntegrationMode = from_wire("mode", serde_json::Value::String(mode))?;
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let mode = authoritative_ime_mode(&state, fallback)?;
            let status = get_ime_export_status(&state.ime_root, mode)?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// consumer handshake は保持し、project snapshots と active state を消去する。
    #[napi]
    pub async fn ime_export_clear_all(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        let request = state.ime_request_gate.register_clear();
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            if !state.ime_request_gate.is_current(&request) {
                return Ok(());
            }
            let result = clear_all_exports(&state.ime_root).map_err(AppError::from);
            state.ime_request_gate.finish_clear(&request);
            result
        })
        .await
    }

    /// 単一 project の snapshot を削除し、必要なら active state も解除する。
    #[napi]
    pub async fn ime_export_remove_project(
        &self,
        project_id: String,
        expected_workspace_path: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        let (workspace, request) =
            pin_ime_workspace_request(&state, &expected_workspace_path, |gate, generation| {
                gate.register_remove_for_generation(&project_id, generation)
            })
            .map_err(app_err_to_napi)?;
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            if !state.ime_request_gate.is_current(&request) {
                if !state
                    .ime_request_gate
                    .is_workspace_generation_current(&request)
                {
                    return Err(AppError::Anyhow(anyhow::anyhow!(
                        "IME_WORKSPACE_CHANGED: snapshot cleanup must be retried"
                    )));
                }
                return Ok(());
            }
            remove_project_export_if_absent(workspace.db().as_ref(), &state.ime_root, &project_id)?;
            Ok(())
        })
        .await
    }

    /// 文字屑ゴミ箱: 作成 (commands/trash_bin.rs の写像 — 実装本体は
    /// `grimodex_db::trash_bin` を Tauri コマンドと共用)。trash_bin 5 コマンドは
    /// workspace 読み込み時に `trash_bin_list` が必ず呼ばれるため、垂直スライスに
    /// 含めないと Electron 起動のたびにゴミ箱エラートーストが出る (§4.3)。
    /// `payload` は camelCase の TrashBinCreatePayload。
    /// 返り値: 作成行 (`SELECT *`、列名は snake_case) の JSON 文字列。
    #[napi]
    pub async fn trash_bin_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: TrashBinCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = trash_bin::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// Structural Trash restore. Domain rows, canonical Change Event,
    /// Narrative Change Feed, Trash consumption, and retry receipt commit as
    /// one Native-owned transaction.
    #[napi]
    pub async fn trash_bin_restore(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: TrashBinRestorePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = trash_bin::restore(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 一覧 (deleted_at 降順、`limit` 省略時 50 件)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn trash_bin_list(&self, project_id: String, limit: Option<i64>) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = trash_bin::list(db, project_id, limit)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 1 件削除 (拾い上げ成功時にも呼ばれる)。
    #[napi]
    pub async fn trash_bin_delete(&self, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| trash_bin::delete(db, id))).await
    }

    /// 文字屑ゴミ箱: project 内全削除。
    #[napi]
    pub async fn trash_bin_clear_all(&self, project_id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| trash_bin::clear_all(db, project_id)))
            .await
    }

    /// 文字屑ゴミ箱: 期日切れ・件数超過の刈り取り (起動時に呼ばれる)。
    /// 返り値: 残件数 (i64) の JSON 文字列。
    #[napi]
    pub async fn trash_bin_prune(
        &self,
        project_id: String,
        retention_days: i64,
        max_count: i64,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let count = trash_bin::prune(db, project_id, retention_days, max_count)?;
                Ok(serde_json::to_string(&count)?)
            })
        })
        .await
    }

    /// FTS optimize (commands/integrity.rs の写像 — 実装は grimodex-db の
    /// `Database::fts_optimize` を Tauri と共用)。workspace open 後のアイドル
    /// タイミングで呼ばれる fail-soft コマンド。
    #[napi]
    pub async fn fts_optimize(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.fts_optimize())).await
    }

    /// FTS 全再構築 (設定画面のデータカテゴリから明示実行)。
    #[napi]
    pub async fn fts_rebuild(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.fts_rebuild())).await
    }

    /// 英語 FTS の再構築 (英語プロジェクト作成時に fail-soft で呼ばれる)。
    #[napi]
    pub async fn fts_rebuild_en(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.rebuild_en_fts())).await
    }

    /// FTS 検索 (チャット recall / コマンドセンター検索 — 編集ループ常連)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn fts_search(
        &self,
        project_id: String,
        query: String,
        scope: String,
        limit: u32,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = db.search_fts(&project_id, &query, &scope, limit)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// 整合性チェック (IntegrityCheckDialog)。
    /// 返り値: レポート object の JSON 文字列。
    #[napi]
    pub async fn integrity_check(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let report = db.integrity_check(&project_id)?;
                Ok(serde_json::to_string(&report)?)
            })
        })
        .await
    }

    /// 整合性修復 (IntegrityCheckDialog — 長時間になりうるが spawn_blocking
    /// なので Node main thread は塞がない)。
    /// 返り値: レポート object の JSON 文字列。
    #[napi]
    pub async fn repair_integrity(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: RepairIntegrityPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let report = db.repair_integrity(payload)?;
                Ok(serde_json::to_string(&report)?)
            })
        })
        .await
    }

    /// Linter 本体 (commands/lint.rs の写像 — grimodex-lint を Tauri と共用)。
    /// State 非依存だが、UniDic コールドロード (初回 >数秒) + CPU バウンドなので
    /// spawn_blocking。エラーは AppError ではなく **LintError の {type,data}
    /// JSON** を reason に載せる (convert::lint_err_to_napi — ipcContract の
    /// lint_text アダプタが object reject へ復元する)。
    /// 返り値: `LintResponse` の JSON 文字列。
    #[napi]
    pub async fn lint_text(
        &self,
        blocks: serde_json::Value,
        language: String,
        scope: serde_json::Value,
        config: serde_json::Value,
        disables: Option<serde_json::Value>,
    ) -> Result<String> {
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let blocks: Vec<grimodex_lint::LintBlock> =
                from_wire("blocks", blocks).map_err(app_err_to_napi)?;
            let scope: grimodex_lint::LintScope =
                from_wire("scope", scope).map_err(app_err_to_napi)?;
            let config: grimodex_lint::LintConfig =
                from_wire("config", config).map_err(app_err_to_napi)?;
            let disables: Vec<grimodex_lint::DisableDirective> = match disables {
                Some(v) => from_wire("disables", v).map_err(app_err_to_napi)?,
                None => Vec::new(),
            };
            // 言語分岐は commands/lint.rs と同一 (InvalidLanguage も LintError ワイヤ)
            let lang = match language.as_str() {
                "ja" => grimodex_lint::Language::Japanese,
                "en" => grimodex_lint::Language::English,
                other => {
                    return Err(lint_err_to_napi(
                        &grimodex_lint::LintError::InvalidLanguage(other.to_string()),
                    ))
                }
            };
            let response = grimodex_lint::lint(&blocks, lang, scope, &config, &disables)
                .map_err(|e| lint_err_to_napi(&e))?;
            serde_json::to_string(&response)
                .map_err(|e| Error::from_reason(format!("failed to serialize LintResponse: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// 段落プレーンテキストの文節分割 (commands/reorder.rs の写像)。
    /// UniDic コールドロードで初回 10s 超えうる (FE 側 SLOW_COMMANDS 登録済み)。
    /// 返り値: `[{start, end, surface}, …]` (UTF-16 offset) の JSON 文字列。
    #[napi]
    pub async fn segment_bunsetsu(&self, text: String) -> Result<String> {
        #[derive(serde::Serialize)]
        struct BunsetsuDto {
            start: u32,
            end: u32,
            surface: String,
        }
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            // サイズ上限とエラー文言は commands/reorder.rs と同一
            if text.len() > grimodex_lint::MAX_INPUT_BYTES {
                return Err(Error::from_reason(format!(
                    "text exceeds maximum length of {} bytes",
                    grimodex_lint::MAX_INPUT_BYTES
                )));
            }
            let chunks = grimodex_lint::bunsetsu::segment_bunsetsu(&text)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            let dtos: Vec<BunsetsuDto> = chunks
                .into_iter()
                .map(|c| BunsetsuDto {
                    start: c.start,
                    end: c.end,
                    surface: c.surface,
                })
                .collect();
            serde_json::to_string(&dtos)
                .map_err(|e| Error::from_reason(format!("failed to serialize bunsetsu: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// システムフォント列挙 (commands/fonts.rs の写像 — 実装本体は
    /// grimodex-fonts を Tauri と共用)。OS のフォントディレクトリスキャンは
    /// 数百 ms かかりうるため spawn_blocking。
    /// 返り値: family 名配列 (昇順・重複排除) の JSON 文字列。
    #[napi]
    pub async fn list_system_fonts(&self) -> Result<String> {
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let families = grimodex_fonts::list_system_fonts();
            serde_json::to_string(&families)
                .map_err(|e| Error::from_reason(format!("failed to serialize fonts: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// Codex 名寄せマッチャの再構築 (commands/codex_matching.rs の写像 —
    /// 本体は grimodex-core::codex_matching を Tauri と共用)。`entries` は
    /// camelCase の MatchEntry 配列 (rustMatcher.ts が entryType/excludedAliases
    /// で送る)。Aho-Corasick 構築は CPU バウンドなので spawn_blocking。
    /// rebuild と match_text は AppState.codex_matcher の**同一インスタンス**を
    /// 見る (Tauri の CodexMatcherState 相当)。
    #[napi]
    pub async fn codex_rebuild_matcher(&self, entries: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || -> Result<()> {
            let entries: Vec<MatchEntry> =
                from_wire("entries", entries).map_err(app_err_to_napi)?;
            let matcher =
                CachedMatcher::build(&entries).map_err(|e| Error::from_reason(format!("{e}")))?;
            let mut guard = state
                .codex_matcher
                .lock()
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            *guard = Some(matcher);
            Ok(())
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// `text` を現在のマッチャで名寄せする (commands/codex_matching.rs の写像)。
    /// マッチャ未構築時は空配列 (Tauri 実装と同一の fail-soft)。高頻度 IPC だが
    /// 作法統一のため async + spawn_blocking。
    /// 返り値: `CodexMatch` (UTF-16 offset、camelCase) 配列の JSON 文字列。
    #[napi]
    pub async fn codex_match_text(
        &self,
        text: String,
        exclude_entry_ids: Vec<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let guard = state
                .codex_matcher
                .lock()
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            let matches: Vec<CodexMatch> = match guard.as_ref() {
                None => vec![],
                Some(matcher) => matcher.match_text(&text, &exclude_entry_ids),
            };
            serde_json::to_string(&matches)
                .map_err(|e| Error::from_reason(format!("failed to serialize matches: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// Canonical Source View から決定的な Entity Seed を抽出する。
    /// workspace/DB 状態を一切参照せず、strict DTO validation 後に blocking pool で
    /// UniDic 解析を行う。返り値は camelCase Entity Seed response の JSON 文字列。
    #[napi(ts_return_type = "Promise<string>")]
    pub fn extract_codex_entity_seeds(
        &self,
        request: napi::JsObject,
    ) -> Result<AsyncTask<ExtractCodexEntitySeedsTask>> {
        let request = entity_seed_request_from_js(request).map_err(|error| error.reason);
        Ok(AsyncTask::new(ExtractCodexEntitySeedsTask { request }))
    }

    /// 本文から未知の固有名詞候補を抽出する
    /// (`grimodex_semantic::codex_candidates` を Tauri と共用)。
    ///
    /// workspace DB は blocking pool へ投入する**前**に一度だけ pin する。これにより
    /// 待ち行列中に workspace が切り替わってもコマンド途中で別 DB を解決せず、開始時
    /// snapshot の scenes/known names を読む。共有コアは DB phase を単一 connection
    /// lock に閉じ、UniDic + Aho-Corasick の CPU phase は lock 外で実行する。
    /// 返り値: camelCase `CodexCandidate[]` の JSON 文字列。
    #[napi]
    pub async fn extract_codex_candidates(
        &self,
        project_id: String,
        min_count: Option<u32>,
    ) -> Result<String> {
        let db = grimodex_db::state::active_database(&self.state.ws).map_err(app_err_to_napi)?;
        let min_count = min_count.map(|value| value as usize);
        run_blocking(move || {
            let candidates = grimodex_semantic::codex_candidates::extract_codex_candidates(
                &db,
                &project_id,
                min_count,
            )?;
            Ok(serde_json::to_string(&candidates).map_err(anyhow::Error::from)?)
        })
        .await
    }

    // ─────────────────────── semantic Phase 3 Batch 4 ───────────────────
    // 全DB commandはrun_semantic_wireがinvoke開始時のDB Arc + 4cache epochを
    // 一貫pinする。各closureは共有runtimeだけを呼び、workspaceを再解決しない。

    /// Rebuild可能なsemantic background indexingを協調停止する。
    /// 4-cache epochをrotateし、既にpin済みのscene/bulk jobはitem/chunk境界で
    /// `IPC_DERIVED_CANCELLED` を返す。途中生成したindex payloadはcommitしない。
    /// 返り値は新generationのJSON数値。
    #[napi]
    pub async fn semantic_cancel_background(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let generation = state.semantic.semantic_cancel_background();
            Ok(serde_json::to_string(&generation).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// モデルが無ければbackground downloadを開始し、状態文字列を即返す。
    /// resource欠落はBackend constructorを失敗させず、このsemantic surfaceでのみ
    /// installed/unavailable/downloading または明示エラーとして扱う。
    #[napi]
    pub async fn semantic_download_model(&self, language: String) -> Result<String> {
        let start = self
            .state
            .semantic
            .semantic_download_model(&language)
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let status = start.status().to_string();
        if let grimodex_semantic::runtime::ModelDownloadStart::Start(job) = start {
            napi::tokio::spawn(async move {
                // job自身が成功/失敗をdone eventへ載せ、Dropでinflightを必ず解除する。
                let _ = job.run().await;
            });
        }
        serde_json::to_string(&status).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn semantic_index_scene(
        &self,
        expected_workspace_path: String,
        project_id: String,
        scene_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.semantic_index_scene(request, &project_id, &scene_id),
        )
        .await
    }

    #[napi]
    pub async fn semantic_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
        scene_scope: Option<String>,
        description_mode: Option<bool>,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.semantic_search(
                    request,
                    &project_id,
                    &query,
                    limit as usize,
                    scene_scope.as_deref(),
                    description_mode,
                )
            },
        )
        .await
    }

    /// Score a frozen Semantic Recall candidate set for diagnostic shadow or
    /// opt-in apply. This command neither reads the active workspace nor owns
    /// admission; it only returns logits, hashes, and truncation counters.
    #[napi]
    pub async fn semantic_reranker_shadow_score(
        &self,
        request: serde_json::Value,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct CandidateDto {
            candidate_id: String,
            text: String,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct RequestDto {
            request_id: String,
            expected_workspace_path: String,
            project_id: String,
            audit_path_id: String,
            language: String,
            user_message: String,
            scene_tail: String,
            candidates: Vec<CandidateDto>,
        }

        let dto: RequestDto = serde_json::from_value(request)
            .map_err(|error| Error::from_reason(format!("invalid reranker request: {error}")))?;
        if dto.request_id.trim().is_empty() {
            return Err(Error::from_reason(
                "invalid reranker request: requestId must not be empty",
            ));
        }
        if dto.project_id.trim().is_empty() {
            return Err(Error::from_reason(
                "invalid reranker request: projectId must not be empty",
            ));
        }
        if !matches!(
            dto.audit_path_id.as_str(),
            "semantic_reranker" | "semantic_reranker_shadow"
        ) {
            return Err(Error::from_reason(
                "invalid reranker request: auditPathId must be semantic_reranker or semantic_reranker_shadow",
            ));
        }
        let state = Arc::clone(&self.state);
        let pinned_request = pin_scoped_semantic_request(&state, &dto.expected_workspace_path)?;
        let pinned_database = pinned_request.database();
        napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
            let request = grimodex_semantic::reranker::RerankerRequest {
                language: dto.language,
                user_message: dto.user_message,
                scene_tail: dto.scene_tail,
                candidates: dto
                    .candidates
                    .into_iter()
                    .map(|candidate| grimodex_semantic::reranker::RerankerCandidate {
                        candidate_id: candidate.candidate_id,
                        text: candidate.text,
                    })
                    .collect(),
            };
            let spec = *request.validate()?;
            let (normalized_query, _, _) = request.normalized_query();
            let appender: Arc<dyn grimodex_semantic::audit::SemanticAuditAppender> =
                pinned_database.clone();
            let mut audit = grimodex_semantic::audit::SemanticAuditSession::start(
                appender,
                grimodex_semantic::audit::SemanticAuditContext {
                    project_id: Some(dto.project_id.clone()),
                    operation_id: dto.request_id.clone(),
                    parent_execution_id: None,
                    path_id: dto.audit_path_id.clone(),
                    inference_kind: "reranker.cross-encoder".into(),
                    model: serde_json::json!({
                        "engine": "onnx-runtime",
                        "executionProvider": "cpu",
                        "identityCapture": "expected-before-local-artifact-load",
                        "tokenizerIdentityStatus": "pending-effective-receipt",
                        "modelId": spec.model_id,
                        "modelRevision": spec.revision,
                        "artifactSha256": spec.artifact_sha256,
                        "manifestSha256": spec.manifest_sha256,
                        "maxPairTokens": spec.max_pair_tokens,
                        "batchSize": spec.batch_size,
                        "threadCount": spec.thread_count,
                        "needsTokenTypeIds": spec.needs_token_type_ids,
                    }),
                    input: serde_json::json!({
                        "requestId": dto.request_id,
                        "language": request.language,
                        "userMessage": request.user_message,
                        "sceneTail": request.scene_tail,
                        "normalizedQuery": normalized_query,
                        "candidates": request.candidates.iter().map(|candidate| serde_json::json!({
                            "candidateId": candidate.candidate_id,
                            "text": candidate.text,
                        })).collect::<Vec<_>>(),
                    }),
                    metadata: serde_json::json!({
                        "projectId": dto.project_id,
                        "auditPathId": dto.audit_path_id,
                        "candidateCount": request.candidates.len(),
                    }),
                },
            )?;
            let mut lane_entered = false;
            let lane_result =
                try_with_semantic_reranker_lane(&state.semantic_reranker, |runtime| {
                    lane_entered = true;
                    let prepared = match runtime.prepare_score(&request) {
                        Ok(prepared) => prepared,
                        Err(error) => return audit.fail_preparation(error),
                    };
                    let model_identity = prepared.model_identity();
                    let effective_model = serde_json::json!({
                        "engine": "onnx-runtime",
                        "executionProvider": "cpu",
                        "identityCapture": "actual-loaded-artifacts",
                        "tokenizerIdentityStatus": "loaded-and-fingerprinted",
                        "modelId": model_identity.model_id,
                        "modelRevision": model_identity.model_revision,
                        "artifactSha256": model_identity.artifact_sha256,
                        "manifestSha256": model_identity.manifest_sha256,
                        "tokenizerIdentity": model_identity.tokenizer_identity,
                        "maxPairTokens": spec.max_pair_tokens,
                        "batchSize": spec.batch_size,
                        "threadCount": spec.thread_count,
                        "needsTokenTypeIds": spec.needs_token_type_ids,
                    });
                    if let Err(error) =
                        audit.record_effective_model_before_inference(effective_model)
                    {
                        return audit.fail_preparation(error);
                    }
                    audit.dispatch_and_run(
                        || runtime.score_prepared(request, prepared),
                        |result| {
                            serde_json::to_value(result).unwrap_or_else(|error| {
                                serde_json::json!({
                                    "captureState": "partial",
                                    "limitations": [format!("reranker-result-serialization: {error}")],
                                })
                            })
                        },
                    )
                });
            let result = match lane_result {
                Ok(result) => result,
                Err(error) if !lane_entered => return audit.fail_preparation(error),
                Err(error) => return Err(error),
            };
            Ok(serde_json::to_string(&result)?)
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    #[napi]
    pub async fn codex_index_entry(
        &self,
        expected_workspace_path: String,
        project_id: String,
        entry_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.codex_index_entry(request, &project_id, &entry_id),
        )
        .await
    }

    #[napi]
    pub async fn codex_semantic_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.codex_semantic_search(request, &project_id, &query, limit as usize)
            },
        )
        .await
    }

    #[napi]
    pub async fn codex_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.codex_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn codex_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.codex_reindex_all(request, &project_id),
        )
        .await
    }

    #[napi]
    pub async fn events_index_entry(
        &self,
        expected_workspace_path: String,
        project_id: String,
        event_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.events_index_entry(request, &project_id, &event_id),
        )
        .await
    }

    #[napi]
    pub async fn events_semantic_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.events_semantic_search(request, &project_id, &query, limit as usize)
            },
        )
        .await
    }

    #[napi]
    pub async fn events_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.events_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn events_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.events_reindex_all(request, &project_id),
        )
        .await
    }

    #[napi]
    pub async fn chat_index_message(
        &self,
        expected_workspace_path: String,
        project_id: String,
        message_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.chat_index_message(request, &project_id, &message_id),
        )
        .await
    }

    #[napi]
    pub async fn chat_message_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.chat_message_search(request, &project_id, &query, limit as usize)
            },
        )
        .await
    }

    #[napi]
    pub async fn chat_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.chat_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn chat_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.chat_reindex_all(request, &project_id),
        )
        .await
    }

    #[napi]
    pub async fn semantic_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn semantic_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
        run_id: Option<String>,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.semantic_reindex_all(request, &project_id, run_id.as_deref())
            },
        )
        .await
    }

    #[napi]
    pub async fn semantic_chunk_context(
        &self,
        scene_id: String,
        char_start: u32,
        char_end: u32,
        padding: u32,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_chunk_context(
                request,
                &scene_id,
                char_start as usize,
                char_end as usize,
                padding as usize,
            )
        })
        .await
    }

    #[napi]
    pub async fn semantic_debug_dump(
        &self,
        project_id: String,
        scene_id: Option<String>,
        limit: Option<u32>,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_debug_dump(
                request,
                &project_id,
                scene_id.as_deref(),
                limit.map(|value| value as usize),
            )
        })
        .await
    }

    // ─────────────────────── plot_threads (Phase 3 バッチ1 — grimodex-db の
    // plot_threads モジュールを Tauri と共用。commands/plot_threads.rs の写像) ──
    //
    // Value / Vec<Value> 返しは生の SQLite 行 (列名 snake_case)。patch 型の
    // Option<Option<String>> 3 値は from_wire (serde_json::from_value) が Tauri の
    // 引数 deserialize と同一挙動で受ける。link_create / link_update の XPROJ
    // ガードは shared impl 内でサーバサイド維持される (§4.3 — db_execute への
    // 分解禁止)。

    /// プロットスレッド作成 (commands/plot_threads.rs::plot_thread_create の写像)。
    /// `payload` は camelCase の PlotThreadCreatePayload。
    /// 返り値: 作成行 (`SELECT *`、列名 snake_case) の JSON 文字列。
    #[napi]
    pub async fn plot_thread_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド更新 (空 patch 時は現行行を返す)。`patch` は camelCase の
    /// PlotThreadPatch (color / description は Option<Option<String>>)。
    /// 返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_update(&self, id: String, patch: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド削除。
    #[napi]
    pub async fn plot_thread_delete(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&plot_threads::delete(db, payload)?)?)
            })
        })
        .await
    }

    /// プロジェクトのスレッド一覧 (sort_order 昇順)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn plot_thread_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = plot_threads::list(db, project_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// スレッド↔シーンのリンク作成 (XPROJ ガード + phase_type 検証を含む)。
    /// `payload` は camelCase の PlotThreadLinkCreatePayload。
    /// 返り値: 作成行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_link_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadLinkCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::link_create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド分岐/合流作成。request ledger・XPROJ 検証・entity
    /// insert を共有 Rust の単一 transaction で実行する。
    #[napi]
    pub async fn plot_thread_branch_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadBranchCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::branch_create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド分岐/合流更新 (OCC baseVersion 任意)。
    #[napi]
    pub async fn plot_thread_branch_update(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadBranchPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::branch_update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド分岐/合流削除 (OCC baseVersion 任意)。
    #[napi]
    pub async fn plot_thread_branch_delete(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&plot_threads::branch_delete(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Marker move + branch create/update/delete. Full before/after snapshots,
    /// durable replay identity, and all writes share one Rust transaction.
    #[napi]
    pub async fn plot_thread_move_marker_bundle(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadMoveMarkerBundlePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = plot_threads::move_marker_bundle(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// History snapshot restore. Parent/children and request ledger commit in
    /// one shared-Rust transaction.
    #[napi]
    pub async fn plot_thread_restore_snapshot(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadRestoreSnapshotPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = plot_threads::restore_snapshot(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Atomic marker + dependent-branch delete with durable replay identity.
    #[napi]
    pub async fn plot_thread_delete_snapshot(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadDeleteSnapshotPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = plot_threads::delete_snapshot(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// リンク更新 (別スレッドへの移動時は XPROJ ガード。空 patch 時は現行行)。
    /// `patch` は camelCase の PlotThreadLinkPatch (note / sortOrder は
    /// Option<Option<String>>)。
    /// 返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_link_update(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadLinkPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::link_update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// リンク削除。
    #[napi]
    pub async fn plot_thread_link_delete(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&plot_threads::link_delete(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// プロジェクトの全リンク (thread の project で JOIN 絞り込み)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn plot_thread_list_links(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = plot_threads::list_links(db, project_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    // ─────────────────────── foreshadow (Phase 3 バッチ1 — grimodex-db の
    // foreshadow モジュールを Tauri と共用。commands/foreshadow.rs の写像) ──
    //
    // Value / Vec<Value> / 応答 struct は raw snake_case 行 or camelCase struct。
    // patch 型の Option<Option<T>> 3 値 + i64（save_anchors の from/to_pos、
    // setup_create_ai の pos 群）は from_wire (normalize_integer_numbers 込み) が
    // Tauri の引数 deserialize と同一挙動で受ける。到達不能だった旧
    // foreshadow_list は両ランタイムから撤去済み。

    /// 伏線作成 (load_bearing 検証を含む)。`payload` は camelCase の
    /// ForeshadowCreatePayload。返り値: 作成行 (snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: ForeshadowCreatePayload, context| {
                foreshadow::create_with_renderer_authority(db, payload, Some(context))
            },
        )
        .await
    }

    /// 伏線更新 (空 patch 時は現行行)。`patch` は ForeshadowPatch (多数の
    /// Option<Option<T>>)。返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn foreshadow_update(&self, id: String, patch: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "patch",
            patch,
            move |db, patch: ForeshadowPatch, context| {
                foreshadow::update_with_renderer_authority(db, id, patch, Some(context))
            },
        )
        .await
    }

    /// 伏線削除。呼び出し元が観測した version と一致するときだけ削除し、
    /// 削除した aggregate の receipt を返す。
    #[napi]
    pub async fn foreshadow_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: ForeshadowDeletePayload, context| {
                foreshadow::delete_with_renderer_authority(db, payload, Some(context))
            },
        )
        .await
    }

    /// 伏線 + setup ラベル行を 1 ロックで取得。返り値: ForeshadowListWithLabels
    /// Response (camelCase struct、内部行は snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_with_labels(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_with_labels(db, project_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// 未解決 (open) 伏線 + setup ラベル行を 1 ロックで取得。
    #[napi]
    pub async fn foreshadow_list_open_for_context(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_open_for_context(db, project_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// シーンの setup/payoff 伏線 id。返り値: ForeshadowSceneInfoResponse
    /// (camelCase Vec<String>) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_scene_info(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_scene_info(db, scene_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// シーンの伏線コンテキスト (3 クエリ、JOIN)。返り値: ForeshadowSceneContext
    /// Response の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_scene_context(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_scene_context(db, scene_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// codex エントリに紐づく伏線一覧。返り値: ForeshadowListWithLabelsResponse
    /// の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_by_codex_entry(&self, codex_entry_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_by_codex_entry(db, codex_entry_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// チャプターの伏線統計 (最重 read、5 クエリ)。返り値: ForeshadowChapterStats
    /// Bundle の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_chapter_stats(&self, chapter_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_chapter_stats(db, chapter_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// setup 単体取得。返り値: 行 (snake_case) or null の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_setup(&self, setup_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let row = foreshadow::get_setup(db, setup_id)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// setup 更新 (空 patch は no-op)。`patch` は ForeshadowSetupPatch
    /// (Option<Option<T>>)。
    #[napi]
    pub async fn foreshadow_update_setup(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "patch",
            patch,
            move |db, patch: ForeshadowSetupPatch, context| {
                foreshadow::update_setup_with_renderer_authority(db, id, patch, context)
            },
        )
        .await
    }

    /// 伏線 + その setup 群を取得。返り値: `{"foreshadow":…,"setups":[…]}`
    /// (キーは literal、内部行は snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get(&self, id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let detail = foreshadow::get(db, id)?;
                Ok(serde_json::to_string(&detail)?)
            })
        })
        .await
    }

    /// 伏線↔codex リンク作成 (INSERT OR IGNORE)。
    #[napi]
    pub async fn foreshadow_link_codex(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::link_codex_with_renderer_authority,
        )
        .await
    }

    /// 伏線↔codex リンク削除。
    #[napi]
    pub async fn foreshadow_unlink_codex(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::unlink_codex_with_renderer_authority,
        )
        .await
    }

    /// 伏線に紐づく codex エントリ一覧。返り値: codex_entries.* 行 (snake_case)
    /// の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_linked_codex(&self, foreshadow_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = foreshadow::list_linked_codex(db, foreshadow_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// setup の強度を直接更新 (`strength` は null で列クリア)。
    #[napi]
    pub async fn foreshadow_set_setup_strength(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::set_setup_strength_with_renderer_authority,
        )
        .await
    }

    /// AI 由来 setup の upsert。`input` は camelCase の SetupCreateAiInput
    /// (fromPos/toPos は i64、lastEvaluatedAt は Option<i64> — from_wire が正規化)。
    #[napi]
    pub async fn foreshadow_setup_create_ai(&self, input: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "input",
            input,
            foreshadow::setup_create_ai_with_renderer_authority,
        )
        .await
    }

    /// orphan setup の解決 (reanchor / delete / reinsert)。`payload` は camelCase
    /// の OrphanResolvePayload (fromPos/toPos は Option<i64>)。
    /// 返り値: setup id と authoritative Foreshadow 行を含む receipt の JSON 文字列。
    #[napi]
    pub async fn foreshadow_resolve_orphan(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::resolve_orphan_with_renderer_authority,
        )
        .await
    }

    /// シーンのアンカーを一括保存 (batch tx)。`setups` / `payoffs` は camelCase
    /// の配列 (from/to_pos は i64)。`doc_content_size` は空 doc 判定の i64 ガード
    /// (<=2 で bulk-orphan)。
    #[napi]
    pub async fn foreshadow_save_anchors_for_scene(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                foreshadow::save_anchors_for_scene_with_renderer_authority(db, payload, context)
                    .map(serde_json::Value::Array)
            },
        )
        .await
    }

    /// シーンのアンカー mark を取得 (0 座標・orphan を除外)。返り値:
    /// AnchorMarkOutput 配列 (camelCase: from/to/markName/attrs) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_load_anchors_for_scene(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let marks = foreshadow::load_anchors_for_scene(db, scene_id)?;
                Ok(serde_json::to_string(&marks)?)
            })
        })
        .await
    }

    // ─────────────────────── agent_writes (Phase 3 バッチ1 — grimodex-db の
    // agent_writes モジュールを Tauri と共用。tracked write = BEGIN IMMEDIATE →
    // entity mutation + authorship_spans + undo_journal + change_events →
    // commit_or_rollback が各 impl 内で閉じる。XPROJ ガード / 楽観ロック /
    // undo-redo はサーバサイド維持) ──────────────────────────────────────────
    //
    // 19 コマンドはすべて FE が単一の `{ payload }` を送る。返り値は
    // AgentWriteResult / ProseStageResult (camelCase)。agent_write_cmd 定形で写像。

    #[napi]
    pub async fn agent_codex_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::agent_writes::renderer_codex_delete_impl,
        )
        .await
    }

    /// Human/import/history renderer Codex writer. Agent tool calls use the
    /// capability-bound `agent_codex_*` surface above; this alias keeps the
    /// non-Agent renderer writer contract separate at the IPC boundary while
    /// sharing the same tracked native implementation.
    #[napi]
    pub async fn codex_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn codex_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn codex_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::agent_writes::renderer_codex_delete_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::codex_writes::renderer_agent_codex_mutate_impl,
        )
        .await
    }

    /// Human/import/history/restore Codex aggregate writer. This is a distinct
    /// N-API method from the capability-bound Agent command and shares only
    /// the typed Native mutation core.
    #[napi]
    pub async fn codex_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::codex_writes::renderer_codex_mutate_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_write_bundle(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_write_bundle_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_snippet_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_agent_snippet_create_impl,
        )
        .await
    }

    /// Human/import/restore Snippet create. The shared writer commits the
    /// domain row, Undo Journal, canonical Change Event, Narrative Change
    /// Feed, and idempotency receipt in one SQLite transaction.
    #[napi]
    pub async fn snippet_create(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::snippet_writes::create,
        )
        .await
    }

    /// OCC-guarded canonical Snippet update.
    #[napi]
    pub async fn snippet_update(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::snippet_writes::update,
        )
        .await
    }

    /// OCC-guarded canonical Snippet delete.
    #[napi]
    pub async fn snippet_delete(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::snippet_writes::delete,
        )
        .await
    }

    #[napi]
    pub async fn agent_propose_scene_body(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_propose_scene_body_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_accept_prose_stage(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_accept_prose_stage_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_discard_prose_stage(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_discard_prose_stage_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_apply_undo_journal(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: agent_writes::AgentUndoJournalPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &agent_writes::agent_undo_journal_impl(db, payload)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn agent_foreshadow_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_agent_foreshadow_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_foreshadow_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::renderer_agent_foreshadow_update_impl(db, payload, context)
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_create_with_authority_impl(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_update_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_event_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_delete_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_chronicle_bulk_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                grimodex_db::chronicle_bulk::agent_chronicle_bulk_mutate_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_set_participants(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_set_participants_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_link(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    p,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_link_batch(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_link_batch_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_unlink(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    p,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_relation_add(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    p,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_relation_remove(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    p,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    // Human/import/history/restore Chronicle aliases. Each method enters the
    // same shared writer core as its Agent counterpart, but Main binds these
    // command names to non-Agent authority routes.
    #[napi]
    pub async fn event_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_create_with_authority_impl(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn event_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_update_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn event_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_delete_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn chronicle_bulk_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                grimodex_db::chronicle_bulk::agent_chronicle_bulk_mutate_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn event_participants_set(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_set_participants_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn scene_event_link(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    payload,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn scene_event_link_batch(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_link_batch_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn scene_event_unlink(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    payload,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn event_relation_add(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    payload,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn event_relation_remove(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    payload,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    // ─────────────────────── narrative_extraction (Chronicle Vertical Slice PR2 —
    // persistent run / task / proposal runtime; payload → JSON string) ─────────

    #[napi]
    pub async fn narrative_extraction_create_run(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_create_run,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_get_run(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RunRefPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_get_run(
                        db,
                        dto.run_id,
                        dto.project_id,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_list_resumable_runs(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: ListResumableRunsPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_list_resumable_runs(db, dto)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_cancel_run(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_cancel_run,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_claim_task(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_claim_task,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_finish_task(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_finish_task,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_fail_task(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_fail_task,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_save_proposal_set(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_save_proposal_set,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_get_run_review_bundle(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RunRefPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_get_run_review_bundle(db, dto)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_append_revision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_append_revision,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_append_decision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_append_decision,
        )
        .await
    }

    /// Human review has a separate Native endpoint so an AI/automation
    /// caller cannot turn `createdBy` into a human authority grant.
    #[napi]
    pub async fn narrative_extraction_append_human_decision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_append_human_decision,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_revise_and_decide(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_revise_and_decide,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_revise_and_decide_as_human(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_revise_and_decide_as_human,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_set_human_field_lock(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_set_human_field_lock,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_prepare_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_prepare_commit,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_apply_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_apply_commit,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_get_commit_status(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_get_commit_status,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_undo_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_undo_commit,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_redo_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_redo_commit,
        )
        .await
    }

    // ─────────────────────── Gate C2 Run Kind Policy: the five named
    // operations replacing the old two-value
    // rebuildNarrativeDependencyIndex(mode: verify|repair)
    // (policies/narrative/narrative-run-kind-policy.json's apiSplit). Same
    // toolchain caveat as the block above: not through `cargo check` or
    // `napi build`, index.d.ts not regenerated. ───────────────────────────

    /// `dependency-verify`: a read-only diagnostic across the Durable
    /// Dependency Graph and Rebuildable Derived State for one project,
    /// recorded under a real Run.
    ///
    /// The diagnostic itself writes nothing to the tables it reads; the
    /// Run and its stored result exist so a later `dependency-repair` can
    /// prove *which* Verify result its sealed plan came from (the policy's
    /// `verify-first` precondition -- see `seal_repair_plan`). The response
    /// therefore carries `runId`/`reportDigest` alongside the report, not
    /// the bare report.
    ///
    /// Owns its own transactions internally, so this goes through the live
    /// `Database` rather than `with_db_state`'s single-closure shape.
    #[napi]
    pub async fn verify_narrative_dependency_graph(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: VerifyNarrativeDependencyGraphPayload = from_wire("payload", payload)?;
            let authority = active_database(&state.ws)?;
            let outcome = narrative_extraction::run_dependency_verify_for_project(
                authority.db(),
                &dto.project_id,
            )?;
            Ok(serde_json::to_string(&outcome).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `dependency-rebuild-derived`: discards and recomputes every
    /// Rebuildable Derived State row from the Durable Graph and current
    /// Source state, for every Consumer in the project. Owns its own
    /// transaction(s) internally (see the shared crate's own doc
    /// comment), so this calls it directly against the live `Database`
    /// rather than through `with_db_state`'s single-closure shape.
    #[napi]
    pub async fn rebuild_narrative_derived_state(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RebuildNarrativeDerivedStatePayload = from_wire("payload", payload)?;
            let authority = active_database(&state.ws)?;
            let outcome = narrative_extraction::rebuild_narrative_derived_state_for_project(
                authority.db(),
                &dto.project_id,
            )?;
            let wire = match outcome {
                RebuildDerivedStateOutcome::AlreadyRunning { run_id } => serde_json::json!({
                    "outcome": "alreadyRunning",
                    "runId": run_id,
                }),
                RebuildDerivedStateOutcome::Ran { run_id, summary } => serde_json::json!({
                    "outcome": "ran",
                    "runId": run_id,
                    "consumersEvaluated": summary.consumers_evaluated,
                    "edgesEvaluated": summary.edges_evaluated,
                    // Nonzero only under version skew: a Consumer declared
                    // under a kind this build does not implement is skipped
                    // rather than failing the Run, so the count has to reach
                    // the surface or the pass would read as complete.
                    "consumersSkippedUnresolvableScope":
                        summary.consumers_skipped_unresolvable_scope,
                    "edgesSkippedUnresolvableScope":
                        summary.edges_skipped_unresolvable_scope,
                }),
            };
            Ok(serde_json::to_string(&wire).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Read-only: status of the most recent Legacy Dependency Backfill Run
    /// for one project, if any.
    #[napi]
    pub async fn get_narrative_backfill_status(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: GetNarrativeBackfillStatusPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let status = db.with_conn(|conn| {
                    narrative_extraction::get_backfill_status_for_project(conn, &dto.project_id)
                })?;
                Ok(serde_json::to_string(&status)?)
            })
        })
        .await
    }

    /// Manual retry for Legacy Dependency Backfill
    /// (`dependency-backfill`'s `manualRetryRole:
    /// failure-recovery-only`) -- the automatic post-open bootstrap
    /// trigger already retries on the next Workspace open when a prior
    /// attempt failed (a `failed` Run is not reused); this triggers that
    /// same retry immediately, without waiting for a reopen. A no-op
    /// (`outcome: "alreadyRun"`) when the project already has a
    /// `pending`/`running`/`completed` Backfill Run -- there is nothing
    /// to retry.
    #[napi]
    pub async fn retry_narrative_legacy_backfill(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RetryNarrativeLegacyBackfillPayload = from_wire("payload", payload)?;
            let authority = active_database(&state.ws)?;
            let outcome = narrative_extraction::bootstrap_legacy_dependency_backfill_for_project(
                authority.db(),
                &dto.project_id,
            )?;
            let wire = match outcome {
                LegacyBackfillBootstrapOutcome::AlreadyRun { run_id } => serde_json::json!({
                    "outcome": "alreadyRun",
                    "runId": run_id,
                }),
                LegacyBackfillBootstrapOutcome::Ran { run_id, summary } => serde_json::json!({
                    "outcome": "ran",
                    "runId": run_id,
                    "epochCreated": summary.epoch_created,
                    "contributionsCreated": summary.contributions_created,
                    "edgesCreated": summary.edges_created,
                    "applicationsWithoutRunId": summary.applications_without_run_id,
                }),
            };
            Ok(serde_json::to_string(&wire).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `dependency-repair`, manual-only. `apply: false` (the default)
    /// seals a repair plan against the project's *current* Semantic
    /// Epoch and returns it as a preview -- the policy's
    /// `change-count-preview` precondition -- without executing
    /// anything. `apply: true` executes: `planDigest` must match the
    /// digest a preview call just returned (binds the confirmation to
    /// the exact plan a human saw, not a blind re-seal that could differ
    /// if the Durable Graph changed in between) and `leaseOwner` claims
    /// the exclusive Repair lease. Every precondition failure
    /// (`NEX_REPAIR_*`) is a typed, `?`-propagated error from the shared
    /// crate or an explicit one constructed here -- never a silent
    /// fallback.
    #[napi]
    pub async fn repair_narrative_dependency_declarations(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RepairNarrativeDependencyDeclarationsPayload = from_wire("payload", payload)?;
            let authority = active_database(&state.ws)?;
            let db = authority.db();

            // Preview seals a plan to show the human what would change.
            // Apply must NOT start by sealing: a retry whose first attempt
            // succeeded but whose response was lost would re-seal against
            // an already-repaired graph and fail, never reaching the stored
            // outcome. `..._for_request` resolves the request first.
            if !dto.apply {
                let current_epoch_id = db
                    .with_conn(|conn| {
                        narrative_extraction::get_current_epoch(conn, &dto.project_id)
                    })?
                    .ok_or_else(|| {
                        AppError::Anyhow(anyhow::anyhow!(
                            "NEX_REPAIR_NO_EPOCH: project '{}' has no Semantic Epoch",
                            dto.project_id
                        ))
                    })?
                    .id;
                let plan = db.with_conn(|conn| {
                    narrative_extraction::seal_repair_plan(
                        conn,
                        &dto.project_id,
                        &dto.verify_run_id,
                        &current_epoch_id,
                    )
                })?;
                let preview = serde_json::json!({
                    "mode": "preview",
                    "plan": plan,
                });
                return Ok(serde_json::to_string(&preview).map_err(anyhow::Error::from)?);
            }

            let Some(plan_digest) = dto.plan_digest.as_deref() else {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_REPAIR_PLAN_DIGEST_REQUIRED: planDigest is required when apply is true"
                )));
            };
            let Some(lease_owner) = dto.lease_owner.as_deref() else {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_REPAIR_LEASE_OWNER_REQUIRED: leaseOwner is required when apply is true"
                )));
            };

            let workspace_path = active_workspace_path(&state.ws)?;
            let outcome =
                narrative_extraction::repair_narrative_dependency_declarations_for_request(
                    db,
                    &workspace_path,
                    &dto.project_id,
                    &dto.verify_run_id,
                    plan_digest,
                    lease_owner,
                    true,
                    &dto.request_id,
                    &dto.actor_id,
                )?;
            let applied = serde_json::json!({
                "mode": "applied",
                "outcome": outcome,
            });
            Ok(serde_json::to_string(&applied).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Set (upsert) a Maintenance Attention disposition. Never touches the
    /// Change Feed: `narrative_maintenance_attention` is durable,
    /// non-epoch-bound, `backflowPolicy: "forbid"` user state.
    #[napi]
    pub async fn narrative_maintenance_attention_set(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: NarrativeMaintenanceAttentionSetPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let disposition = AttentionDisposition::try_from(dto.disposition.as_str())?;
                let set_at = grimodex_core::now_rfc3339_millis();
                // Caller-owned transaction: the OCC read and the write must
                // not be separable, or a racing window could slip between
                // them and the version check would prove nothing.
                let outcome = narrative_extraction::set_attention(
                    db,
                    narrative_extraction::SetAttentionRequest {
                        project_id: &dto.project_id,
                        finding_key: &dto.finding_key,
                        disposition,
                        material_basis_digest: &dto.material_basis_digest,
                        snoozed_until: dto.snoozed_until.as_deref(),
                        set_at: &set_at,
                        actor_id: &dto.actor_id,
                        request_id: &dto.request_id,
                        reason: dto.reason.as_deref(),
                        expected_version: dto.expected_version,
                    },
                )?;
                Ok(serde_json::to_string(&outcome)?)
            })
        })
        .await
    }

    /// Clear a Maintenance Attention disposition under the caller's OCC
    /// token. Clearing an absent row is a no-op success only when the caller
    /// expected it to be absent (`expectedVersion: 0`); a row that has moved
    /// on since the caller read it fails with
    /// `NEX_ATTENTION_VERSION_CONFLICT` rather than being deleted silently.
    #[napi]
    pub async fn narrative_maintenance_attention_clear(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: NarrativeMaintenanceAttentionClearPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let outcome = narrative_extraction::clear_attention(
                    db,
                    &dto.project_id,
                    &dto.finding_key,
                    &dto.actor_id,
                    &dto.request_id,
                    dto.expected_version,
                )?;
                Ok(serde_json::to_string(&outcome)?)
            })
        })
        .await
    }

    /// Read-only: assemble the Maintenance Inbox for one project as of now.
    #[napi]
    pub async fn narrative_maintenance_inbox_list(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: NarrativeMaintenanceInboxListPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let now = grimodex_core::now_rfc3339_millis();
                let entries = db.with_conn(|conn| {
                    narrative_extraction::build_maintenance_inbox(conn, &dto.project_id, &now)
                })?;
                Ok(serde_json::to_string(&entries)?)
            })
        })
        .await
    }

    // ─────────────────────── post_effect (Phase 3 バッチ1 — pure-db 読み書き。
    // grimodex-db の post_effect モジュールを Tauri と共用。SCENE_LENS_FOR_PROJECT_SQL
    // 契約 / XPROJ ガード / snake_case ReplyToAnnotationArgs を維持。start_run 系と
    // abort・dead 2 件はバッチ3 以降) ──────────────────────────────────────────

    /// 校閲 run 一覧 (limit 省略時 20 / offset 省略時 0 はサーバサイド既定)。
    #[napi]
    pub async fn list_post_effect_runs(
        &self,
        project_id: String,
        effect_type: Option<String>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows =
                    post_effect::list_post_effect_runs(db, project_id, effect_type, limit, offset)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// Outline 用: scene ごとに最新 run の lens (`runCompletedAt` 付き) を返す。
    #[napi]
    pub async fn list_scene_lens_for_project(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_scene_lens_for_project(db, project_id)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// シーンの annotation + relation を返す (`{annotations,relations}`)。
    #[napi]
    pub async fn list_annotations_for_scene(
        &self,
        project_id: String,
        scene_id: String,
        status: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_annotations_for_scene(db, project_id, scene_id, status)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// プロジェクトの annotation を返す (`{annotations}`)。
    #[napi]
    pub async fn list_annotations_for_project(
        &self,
        project_id: String,
        status: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_annotations_for_project(db, project_id, status)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// annotation の status を更新 (XPROJ ガード付き、conn 直呼び)。
    #[napi]
    pub async fn update_annotation_status(
        &self,
        annotation_id: String,
        status: String,
        project_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = db.with_conn(|conn| {
                    post_effect::update_annotation_status_inner(
                        conn,
                        &annotation_id,
                        &status,
                        &project_id,
                    )
                })?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// 疑似コメントへの返信を追加 (`args` は snake_case の ReplyToAnnotationArgs)。
    #[napi]
    pub async fn reply_to_annotation(&self, args: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let args: ReplyToAnnotationArgs = from_wire("args", args)?;
            with_db_state(&state.ws, |db| {
                let v = db.with_conn(|conn| post_effect::reply_to_annotation_inner(conn, &args))?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// シーンの annotation を保存 (raw snake_case 配列、range_start/end は i64)。
    #[napi]
    pub async fn save_post_effect_annotations(
        &self,
        project_id: String,
        scene_id: String,
        annotations: serde_json::Value,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let annotations: Vec<serde_json::Value> = from_wire("annotations", annotations)?;
            with_db_state(&state.ws, |db| {
                post_effect::save_post_effect_annotations(db, project_id, scene_id, annotations)
            })
        })
        .await
    }

    // ─────────────────────── post_effect runner (Phase 3d — shared Rust
    // engine + EventQueue 4ch + run_id単位abort registry) ─────────────────

    /// 単一sceneの校閲runを開始し、AI完了を待たず `{run_id,from_cache}` を返す。
    /// `settings` とsecretはElectron mainが同じinvokeで取得したsnapshot。API key
    /// 未登録 (`None`) と保存済み空文字 (`Some("")`) を区別し、lookup errorも
    /// cache hitを壊さないよう背景taskまで遅延させる。
    #[napi]
    pub async fn start_post_effect_run(
        &self,
        mut args: serde_json::Value,
        settings: serde_json::Value,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Result<String> {
        let expected_workspace_path = args
            .as_object_mut()
            .and_then(|object| object.remove("expectedWorkspacePath"))
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Error::from_reason("invalid args: expectedWorkspacePath must be a non-empty string")
            })?;
        let args: grimodex_post_effect::StartPostEffectRunArgs =
            from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let runtime =
            NodePostEffectRuntime::new_scoped(Arc::clone(&self.state), &expected_workspace_path)
                .map_err(app_err_to_napi)?;
        let ai = NodePostEffectAiClient::new(settings, api_key, api_key_error);
        let result = grimodex_post_effect::start_post_effect_run(runtime, ai, args)
            .await
            .map_err(app_err_to_napi)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 複数sceneの校閲run。処理はscene境界でabort registryを確認し、イベントは
    /// `post_effect:{progress,partial,done,error}` をEventQueueへ配信する。
    #[napi]
    pub async fn start_post_effect_run_multi(
        &self,
        mut args: serde_json::Value,
        settings: serde_json::Value,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Result<String> {
        let expected_workspace_path = args
            .as_object_mut()
            .and_then(|object| object.remove("expectedWorkspacePath"))
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Error::from_reason("invalid args: expectedWorkspacePath must be a non-empty string")
            })?;
        let args: grimodex_post_effect::StartPostEffectRunMultiArgs =
            from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let runtime =
            NodePostEffectRuntime::new_scoped(Arc::clone(&self.state), &expected_workspace_path)
                .map_err(app_err_to_napi)?;
        let ai = NodePostEffectAiClient::new(settings, api_key, api_key_error);
        let result = grimodex_post_effect::start_post_effect_run_multi(runtime, ai, args)
            .await
            .map_err(app_err_to_napi)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 同一BackendのregistryとDB rowを一緒に更新する。DB上のproject ownershipを
    /// 確認できたrunning runだけにabort flagを立てるため、cross-project/late abort
    /// は別runや将来runへ波及しない。
    #[napi]
    pub async fn abort_post_effect_run(&self, run_id: String, project_id: String) -> Result<()> {
        let runtime = NodePostEffectRuntime::new(Arc::clone(&self.state));
        run_blocking(move || {
            grimodex_post_effect::abort_post_effect_run(&runtime, &run_id, &project_id)
        })
        .await
    }

    // ─────────────────────── AI チャット (Phase 3 バッチ3a — grimodex-ai を
    // Tauri と共用。HTTP/SSE/provider 分岐はクレート内で完結し、ストリーミングの
    // emit は EventQueue(=StreamEmitter) 経由で TSFn → 全窓 broadcast へ載る) ──
    //
    // **キーは注入**: Tauri の resolve_api_key(keyring) と異なり、napi は main の
    // safeStorage で解決した平文キーを `api_key` 引数で受ける。パラメータ準備
    // (apply_provider_override / build_chat_params 等) は Tauri と同一の pure helper。

    /// AI 設定を読む (Tauri の get_ai_settings と同一 — ai-settings.json、キー非含有)。
    /// 返り値: `AiSettings` の JSON 文字列 (camelCase)。
    #[napi]
    pub async fn get_ai_settings(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let settings = grimodex_ai::read_ai_settings(&state.ai_settings_path);
            Ok(serde_json::to_string(&settings).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// AI 設定を `<appData>/ai-settings.json` へ保存する (Tauri の
    /// `save_ai_settings` と同一)。API キーは別の safeStorage 経路なので含まない。
    #[napi]
    pub async fn save_ai_settings(&self, settings: serde_json::Value) -> Result<()> {
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            grimodex_ai::write_ai_settings(&state.ai_settings_path, &settings)?;
            Ok(())
        })
        .await
    }

    /// 非ストリーミングのチャット送信 (Tauri の send_chat_message と同一ロジック。
    /// キーは注入)。`args` は camelCase の ChatRequest、`api_key` は解決済み平文。
    /// `settings` は **呼び側 (dispatchInvoke) が getAiSettings で1回だけ読んだ AiSettings
    /// スナップショット** — キー解決と送信を同一スナップショットで行い、Tauri の
    /// 単一 read_ai_settings と同じ原子性を保つ (2 度読みの TOCTOU 回避)。
    /// 返り値: `ChatResponse` の JSON 文字列 (camelCase)。
    #[napi]
    pub async fn send_chat_message(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: ChatRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let audit_context = req.audit_context.clone();
        let audit_workspace =
            pin_native_ai_audit_workspace(&self.state, &audit_context).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        grimodex_ai::validate_expected_ollama_endpoint(
            &settings_for_call.provider,
            &settings_for_call.ollama_endpoint,
            req.expected_ollama_endpoint.as_deref(),
        )
        .map_err(native_ai_error_to_napi)?;
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let mut params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            None,
        );
        params.request_max_output_tokens = req.request_max_output_tokens;
        attach_native_ai_http_observer(
            &mut params,
            &settings_for_call,
            &audit_workspace,
            audit_context,
        );
        let msgs: Vec<(&str, &str)> = req
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect();
        let result = grimodex_ai::send_chat(&params, &msgs)
            .await
            .map_err(native_ai_error_to_napi)?;
        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("failed to serialize ChatResponse: {e}")))
    }

    /// ストリーミングのチャット送信 (Tauri の send_chat_message_stream と同一)。
    /// チャンクは `chat:stream-chunk` / 完了は `chat:stream-done` を EventQueue へ emit。
    /// 失敗時は `chat:stream-error` を emit してから reject する (Tauri と同一契約 —
    /// FE の fire-and-forget .catch と listen error の両経路を保つ)。
    /// `streamId` は audit execution ID と一致必須。ストリームごとの cancellation
    /// registry へ登録し、他の同時ストリームとは隔離する。全 emit に同じ ID を付ける。
    #[napi]
    pub async fn send_chat_message_stream(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<()> {
        let req: ChatRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let stream_id = req.stream_id.as_deref().unwrap_or_default();
        if stream_id.trim().is_empty()
            || stream_id != stream_id.trim()
            || stream_id != req.audit_context.execution_id
        {
            return Err(Error::from_reason(
                "streamId must be trimmed and equal auditContext.executionId".to_string(),
            ));
        }
        let stream_id = stream_id.to_string();
        let cancellation = self
            .state
            .chat_streams
            .register(&stream_id)
            .map_err(native_ai_error_to_napi)?;
        let outcome: Result<()> = async {
            let audit_context = req.audit_context.clone();
            let audit_workspace = pin_native_ai_audit_workspace(&self.state, &audit_context)
                .map_err(app_err_to_napi)?;
            let settings: grimodex_ai::AiSettings =
                from_wire("settings", settings).map_err(app_err_to_napi)?;
            let flag = cancellation.abort_flag();
            let emitter =
                CorrelatedStreamEmitter::new(self.state.events.clone(), stream_id.clone());
            let settings_for_call = grimodex_ai::apply_provider_override(
                settings,
                req.model.as_deref(),
                req.provider,
                req.endpoint_id.as_deref(),
            );
            grimodex_ai::validate_expected_ollama_endpoint(
                &settings_for_call.provider,
                &settings_for_call.ollama_endpoint,
                req.expected_ollama_endpoint.as_deref(),
            )
            .map_err(native_ai_error_to_napi)?;
            let variant = req.api_variant.as_deref();
            let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
            let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
            let resolved_variant = grimodex_ai::resolve_api_variant(
                variant,
                &settings_for_call,
                &settings_for_call.model,
            );
            let mut params = grimodex_ai::build_chat_params(
                &settings_for_call,
                &api_key,
                extra_body,
                retry_429,
                grimodex_ai::AiNovelistMode::Chat,
                resolved_variant,
                req.thinking,
                req.effort,
                req.reasoning_enabled,
                req.reasoning_effort,
                req.system_cache_segments,
                req.system_volatile_tail,
                None,
            );
            params.request_max_output_tokens = req.request_max_output_tokens;
            attach_native_ai_http_observer(
                &mut params,
                &settings_for_call,
                &audit_workspace,
                audit_context,
            );
            let msgs: Vec<(&str, &str)> = req
                .messages
                .iter()
                .map(|m| (m.role.as_str(), m.content.as_str()))
                .collect();
            let result =
                grimodex_ai::send_chat_stream(&params, &msgs, flag, &emitter, "chat").await;
            if let Err(e) = result {
                let napi_error = native_ai_error_to_napi(e);
                let sanitized_error = napi_error.reason.clone();
                grimodex_ai::emit::StreamEmitter::emit(
                    &emitter,
                    "chat:stream-error",
                    serde_json::json!({ "message": sanitized_error }),
                );
                return Err(napi_error);
            }
            Ok(())
        }
        .await;
        self.state.chat_streams.complete(&stream_id, &cancellation);
        outcome
    }

    /// 指定 `streamId` のチャットだけを中止し、そのローカル処理が quiesce するまで待つ。
    /// 未登録 ID は将来の同 ID 登録だけに効く bounded tombstone となり false を返す。
    #[napi]
    pub async fn abort_chat_stream(&self, stream_id: String) -> Result<bool> {
        self.state
            .chat_streams
            .abort(&stream_id)
            .await
            .map_err(native_ai_error_to_napi)
    }

    /// インライン AI のストリーミング送信。`inline-ai:stream-*` へ emit し、
    /// AI のべりすとでは Completion mode を使う。チャットとは別の per-stream
    /// cancellation registry を使い、全 emit に audit execution ID を付ける。
    #[napi]
    pub async fn send_inline_ai_stream(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<()> {
        let req: InlineAiRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        if req.stream_id.trim().is_empty()
            || req.stream_id != req.stream_id.trim()
            || req.stream_id != req.audit_context.execution_id
        {
            return Err(Error::from_reason(
                "streamId must be trimmed and equal auditContext.executionId".to_string(),
            ));
        }
        let stream_id = req.stream_id.clone();
        let cancellation = self
            .state
            .inline_ai_streams
            .register(&stream_id)
            .map_err(native_ai_error_to_napi)?;
        let outcome: Result<()> = async {
            let audit_context = req.audit_context.clone();
            let audit_workspace = pin_native_ai_audit_workspace(&self.state, &audit_context)
                .map_err(app_err_to_napi)?;
            let settings: grimodex_ai::AiSettings =
                from_wire("settings", settings).map_err(app_err_to_napi)?;

            let flag = cancellation.abort_flag();
            let emitter =
                CorrelatedStreamEmitter::new(self.state.events.clone(), stream_id.clone());
            let settings_for_call = grimodex_ai::apply_provider_override(
                settings,
                req.model.as_deref(),
                req.provider,
                req.endpoint_id.as_deref(),
            );
            let effective_variant = grimodex_ai::inline_effective_variant(
                &settings_for_call,
                req.api_variant.as_deref(),
            );
            let variant = effective_variant.as_deref();
            let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
            let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
            let resolved_variant = grimodex_ai::resolve_api_variant(
                variant,
                &settings_for_call,
                &settings_for_call.model,
            );
            let mut params = grimodex_ai::build_chat_params(
                &settings_for_call,
                &api_key,
                extra_body,
                retry_429,
                grimodex_ai::AiNovelistMode::Completion,
                resolved_variant,
                req.thinking,
                req.effort,
                req.reasoning_enabled,
                req.reasoning_effort,
                None,
                None,
                None,
            );
            attach_native_ai_http_observer(
                &mut params,
                &settings_for_call,
                &audit_workspace,
                audit_context,
            );
            let msgs: Vec<(&str, &str)> = req
                .messages
                .iter()
                .map(|m| (m.role.as_str(), m.content.as_str()))
                .collect();
            let result =
                grimodex_ai::send_chat_stream(&params, &msgs, flag, &emitter, "inline-ai").await;
            if let Err(e) = result {
                let napi_error = native_ai_error_to_napi(e);
                let sanitized_error = napi_error.reason.clone();
                grimodex_ai::emit::StreamEmitter::emit(
                    &emitter,
                    "inline-ai:stream-error",
                    serde_json::json!({ "message": sanitized_error }),
                );
                return Err(napi_error);
            }
            Ok(())
        }
        .await;
        self.state
            .inline_ai_streams
            .complete(&stream_id, &cancellation);
        outcome
    }

    /// 指定 `streamId` のインライン AI だけを中止し、ローカル quiescence まで待つ。
    /// 未登録 ID は将来の同 ID 登録だけに効く bounded tombstone となり false を返す。
    #[napi]
    pub async fn abort_inline_ai_stream(&self, stream_id: String) -> Result<bool> {
        self.state
            .inline_ai_streams
            .abort(&stream_id)
            .await
            .map_err(native_ai_error_to_napi)
    }

    /// Tool Use 対応の Agent 送信。tool protocol 解決・Hermes/native の安全ゲートを
    /// 含む `grimodex_ai::send_chat_with_tools` をTauriと共用する。
    #[napi]
    pub async fn send_agent_message(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: AgentRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let audit_context = req.audit_context.clone();
        let audit_workspace =
            pin_native_ai_audit_workspace(&self.state, &audit_context).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        grimodex_ai::validate_expected_ollama_endpoint(
            &settings_for_call.provider,
            &settings_for_call.ollama_endpoint,
            req.expected_ollama_endpoint.as_deref(),
        )
        .map_err(native_ai_error_to_napi)?;
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let mut params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            req.web_search,
        );
        params.request_max_output_tokens = req.request_max_output_tokens;
        if let Some(resolved_tool_protocol) = req.resolved_tool_protocol {
            params.resolved_tool_protocol = resolved_tool_protocol;
        }
        attach_native_ai_http_observer(
            &mut params,
            &settings_for_call,
            &audit_workspace,
            audit_context,
        );
        let result = grimodex_ai::send_chat_with_tools(&params, &req.messages, &req.tools)
            .await
            .map_err(native_ai_error_to_napi)?;
        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("failed to serialize ChatResponse: {e}")))
    }

    /// provider のモデル一覧を取得する。`settings` はmainが1回読んだsnapshot、
    /// `api_key` はsafeStorageにキーが無い場合も空文字で注入される。
    #[napi]
    pub async fn list_ai_models(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: ListAiModelsRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let mut settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        if let Some(endpoint_id) = req.endpoint_id.as_deref().filter(|id| !id.is_empty()) {
            if settings.has_openai_compatible_endpoint(endpoint_id) {
                settings.active_openai_compatible_endpoint_id = Some(endpoint_id.to_string());
            }
        }
        grimodex_ai::validate_expected_ollama_endpoint(
            &req.provider,
            &settings.ollama_endpoint,
            req.expected_ollama_endpoint.as_deref(),
        )
        .map_err(native_ai_error_to_napi)?;
        let models = grimodex_ai::fetch_models_for(
            &req.provider,
            &api_key,
            settings.endpoints(),
            req.selected_model_id
                .as_deref()
                .filter(|model| !model.trim().is_empty()),
        )
        .await
        .map_err(native_ai_error_to_napi)?;
        serde_json::to_string(&models)
            .map_err(|e| Error::from_reason(format!("failed to serialize AI models: {e}")))
    }

    /// 最小リクエストでAI接続を確認する。variant解決はテスト対象providerを設定へ
    /// 反映してから行い、OpenAI互換endpointの既定variantを正しく選ぶ。
    #[napi]
    pub async fn test_ai_connection(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: TestAiConnectionRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let audit_context = req.audit_context.clone();
        let audit_workspace =
            pin_native_ai_audit_workspace(&self.state, &audit_context).map_err(app_err_to_napi)?;
        let mut settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        settings.provider = req.provider.clone();
        settings.model = req.model.clone();
        if let Some(endpoint_id) = req.endpoint_id.as_deref().filter(|id| !id.is_empty()) {
            if settings.has_openai_compatible_endpoint(endpoint_id) {
                settings.active_openai_compatible_endpoint_id = Some(endpoint_id.to_string());
            }
        }
        let variant =
            grimodex_ai::resolve_api_variant(req.api_variant.as_deref(), &settings, &req.model);
        let route = NativeAiHttpAuditRoute {
            provider: req.provider.to_string(),
            model: req.model.clone(),
            api_variant: variant.clone(),
            endpoint_id: matches!(req.provider, grimodex_ai::AiProvider::OpenaiCompatible)
                .then(|| settings.active_openai_compatible_endpoint_id.clone())
                .flatten(),
        };
        let effective_request_configuration = NativeAiEffectiveRequestConfiguration {
            ai_novelist_mode: "chat",
            request_max_output_tokens: if matches!(
                req.provider,
                grimodex_ai::AiProvider::OpenAI | grimodex_ai::AiProvider::Sakana
            ) {
                1_024
            } else {
                32
            },
            resolved_tool_protocol: "native",
            retry_429: false,
            extra_body: None,
            openrouter_provider_pin: None,
            fusion: None,
        };
        let appender: Arc<dyn NativeAiAuditAppender> = audit_workspace.db().clone();
        let observer = NativeAiHttpAuditObserver {
            appender,
            context: audit_context,
            route,
            effective_request_configuration,
        };
        grimodex_ai::test_connection_with_observer(
            &req.provider,
            &req.model,
            &api_key,
            settings.endpoints(),
            variant.as_deref(),
            Some(&observer),
        )
        .await
        .map_err(native_ai_error_to_napi)
    }

    /// main 起動時に 1 回登録する (§7.1)。コールバックは
    /// `(channel: string, payloadJson: string)` の 2 引数。登録前に emit された
    /// イベント (`backend:ready`) は登録時に emit 順で flush される。
    /// TSFn は unref 済み — 登録が Node のイベントループを生かし続けることは
    /// ない (プロセス終了を妨げない)。
    #[napi]
    pub fn on_event(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: EventTsfn = callback.create_threadsafe_function(
            0,
            |ctx: ThreadSafeCallContext<(String, String)>| {
                let channel = ctx.env.create_string(&ctx.value.0)?;
                let payload = ctx.env.create_string(&ctx.value.1)?;
                Ok(vec![channel, payload])
            },
        )?;
        tsfn.unref(&env)?;
        self.state.events.register(tsfn);
        Ok(())
    }
}

#[cfg(test)]
mod native_ai_http_audit_tests {
    use super::*;
    use grimodex_ai::HttpRetryObserver;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_context(workspace_path: &std::path::Path) -> NativeAiAuditContext {
        NativeAiAuditContext {
            expected_workspace_path: workspace_path.to_string_lossy().into_owned(),
            project_id: Some("project-a".to_string()),
            operation_id: "operation-a".to_string(),
            execution_id: "execution-a".to_string(),
            parent_execution_id: Some("parent-a".to_string()),
            path_id: "chat_nonstream".to_string(),
        }
    }

    fn test_route() -> NativeAiHttpAuditRoute {
        NativeAiHttpAuditRoute {
            provider: "openai-compatible".to_string(),
            model: "model-a".to_string(),
            api_variant: Some("responses".to_string()),
            endpoint_id: Some("endpoint-a".to_string()),
        }
    }

    fn test_effective_request_configuration() -> NativeAiEffectiveRequestConfiguration {
        NativeAiEffectiveRequestConfiguration {
            ai_novelist_mode: "chat",
            request_max_output_tokens: 4_096,
            resolved_tool_protocol: "native",
            retry_429: true,
            extra_body: None,
            openrouter_provider_pin: None,
            fusion: None,
        }
    }

    #[test]
    fn native_http_observer_persists_correlated_transport_attempt_sequence() -> anyhow::Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-http-audit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir)?;
        let database = Arc::new(Database::new(&dir.join("grimodex.db"))?);
        database.migrate()?;
        database.with_conn(|connection| {
            connection.execute(
                "INSERT INTO projects (id, title, language) VALUES (?1, 'Audit', 'ja')",
                ["project-a"],
            )?;
            Ok(())
        })?;
        let context = test_context(&dir);
        database.append_ai_audit_events(
            "project-a",
            &[
                native_ai_transport_event(
                    &context,
                    0,
                    "renderer-start",
                    "execution.started",
                    1,
                    serde_json::json!({ "captureState": "complete" }),
                ),
                native_ai_transport_event(
                    &context,
                    0,
                    "renderer-prepared",
                    "request.prepared",
                    2,
                    serde_json::json!({
                        "captureState": "complete",
                        "credentialsExcluded": true,
                        "request": { "body": { "prompt": "renderer-observed" } },
                    }),
                ),
                native_ai_transport_event(
                    &context,
                    0,
                    "renderer-dispatched",
                    "request.dispatched",
                    3,
                    serde_json::json!({ "captureState": "complete" }),
                ),
            ],
        )?;
        let appender: Arc<dyn NativeAiAuditAppender> = database.clone();
        let observer = NativeAiHttpAuditObserver {
            appender,
            context: context.clone(),
            route: test_route(),
            effective_request_configuration: test_effective_request_configuration(),
        };

        let effective_body = serde_json::json!({
            "model": "model-a",
            "max_output_tokens": 4_096,
            "input": [{ "role": "user", "content": "exact prompt" }],
        });
        observer.request_prepared(&grimodex_ai::HttpPreparedRequest {
            body: Some(effective_body.clone()),
        })?;

        observer.attempt_started(&grimodex_ai::HttpAttemptStarted {
            attempt_number: 1,
            send_ordinal: 1,
            is_retry: false,
            reuses_initial_payload: false,
            endpoint: Some(grimodex_ai::HttpAttemptEndpoint {
                origin: "https://api.example.test".to_string(),
                host: "api.example.test".to_string(),
            }),
        })?;
        observer.attempt_finished(&grimodex_ai::HttpAttemptFinished {
            attempt_number: 1,
            actual_send_count: Some(1),
            status: Some(429),
            retry_enabled: true,
            retry_after_observed_ms: Some(2_000),
            retry_delay_ms: Some(2_000),
            retry_delay_source: Some(grimodex_ai::HttpRetryDelaySource::RetryAfter),
            will_retry: true,
            retry_exhausted: false,
            retry_payload_clone_unavailable: false,
            local_abort_observed: false,
            provider_abort_receipt_observed: false,
            is_final: false,
        })?;
        observer.attempt_started(&grimodex_ai::HttpAttemptStarted {
            attempt_number: 2,
            send_ordinal: 2,
            is_retry: true,
            reuses_initial_payload: true,
            endpoint: Some(grimodex_ai::HttpAttemptEndpoint {
                origin: "https://api.example.test".to_string(),
                host: "api.example.test".to_string(),
            }),
        })?;
        observer.attempt_finished(&grimodex_ai::HttpAttemptFinished {
            attempt_number: 2,
            actual_send_count: Some(2),
            status: Some(200),
            retry_enabled: true,
            retry_after_observed_ms: None,
            retry_delay_ms: None,
            retry_delay_source: None,
            will_retry: false,
            retry_exhausted: false,
            retry_payload_clone_unavailable: false,
            local_abort_observed: false,
            provider_abort_receipt_observed: false,
            is_final: true,
        })?;

        let snapshot = database.read_ai_audit_snapshot_for_scope(
            context.project_id.as_deref(),
            Some(3),
            None,
            None,
        )?;
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "request.prepared",
                "transport.attempt.started",
                "transport.attempt.finished",
                "execution.retrying",
                "transport.attempt.started",
                "transport.attempt.finished",
            ]
        );
        for event in &snapshot.events {
            assert_eq!(event.execution_id, context.execution_id);
            assert_eq!(event.operation_id, context.operation_id);
            assert_eq!(event.parent_execution_id, context.parent_execution_id);
            assert_eq!(event.path_id, context.path_id);
        }
        let effective_request = &snapshot.events[0];
        assert_eq!(
            effective_request.event_id,
            native_ai_effective_request_event_id(&context)
        );
        assert_eq!(effective_request.payload["captureState"], "complete");
        assert_eq!(effective_request.payload["effectiveRequestReceipt"], true);
        assert_eq!(effective_request.payload["request"]["body"], effective_body);
        assert_eq!(
            effective_request.payload["effectiveRequestConfiguration"]["source"],
            "finalized-reqwest-json-value"
        );
        assert_eq!(effective_request.payload["workspacePinned"], true);
        assert_eq!(
            effective_request.payload["limitations"],
            serde_json::json!([])
        );

        let started = &snapshot.events[1].payload;
        assert_eq!(started["attemptNumber"], 1);
        assert_eq!(started["sendOrdinal"], 1);
        assert_eq!(started["sendPhase"], "pre-send");
        assert!(started.get("actualHttpSendCount").is_none());
        assert_eq!(started["route"]["provider"], "openai-compatible");
        assert_eq!(started["route"]["model"], "model-a");
        assert_eq!(started["route"]["apiVariant"], "responses");
        assert_eq!(started["route"]["endpointId"], "endpoint-a");
        assert_eq!(
            started["route"]["endpointOrigin"],
            "https://api.example.test"
        );
        assert_eq!(
            started["requestContentReference"]["eventType"],
            "request.prepared"
        );
        assert_eq!(
            started["requestContentReference"]["eventId"],
            native_ai_effective_request_event_id(&context)
        );
        assert_eq!(started["captureState"], "complete");
        assert_eq!(
            started["effectiveRequestConfiguration"]["source"],
            "native-chat-params"
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["credentialsExcluded"],
            true
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["providerBodyDuplicated"],
            false
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["aiNovelistMode"],
            "chat"
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["resolvedToolProtocol"],
            "native"
        );
        assert_eq!(started["effectiveRequestConfiguration"]["retry429"], true);
        let first_finished = &snapshot.events[2].payload;
        assert_eq!(first_finished["sendPhase"], "send-invoked");
        assert_eq!(first_finished["status"], 429);
        assert_eq!(first_finished["willRetry"], true);
        assert_eq!(first_finished["retryAfterObservedMs"], 2_000);
        assert_eq!(first_finished["retryDelayMs"], 2_000);
        assert_eq!(first_finished["retryDelaySource"], "retry-after");
        assert_eq!(snapshot.events[3].payload["reason"], "http-429");
        assert_eq!(snapshot.events[3].payload["nextAttemptNumber"], 2);
        assert_eq!(snapshot.events[4].payload["reusesInitialPayload"], true);
        let final_finished = &snapshot.events[5].payload;
        assert_eq!(final_finished["status"], 200);
        assert_eq!(final_finished["finalStatus"], 200);
        assert_eq!(final_finished["willRetry"], false);
        assert_eq!(final_finished["retryExhausted"], false);
        assert_eq!(final_finished["isFinal"], true);

        let durable_json = serde_json::to_string(&snapshot)?;
        for forbidden in ["authorization", "api_key", "password", "secret-value"] {
            assert!(!durable_json.to_ascii_lowercase().contains(forbidden));
        }

        drop(observer);
        drop(database);
        let _ = std::fs::remove_dir_all(dir);
        Ok(())
    }

    #[derive(Default)]
    struct CommitThenLoseReplyAppender {
        calls: AtomicUsize,
        committed: Mutex<Vec<AppendAiAuditEvent>>,
    }

    fn assert_same_event(left: &AppendAiAuditEvent, right: &AppendAiAuditEvent) {
        assert_eq!(left.event_id, right.event_id);
        assert_eq!(left.execution_id, right.execution_id);
        assert_eq!(left.operation_id, right.operation_id);
        assert_eq!(left.parent_execution_id, right.parent_execution_id);
        assert_eq!(left.path_id, right.path_id);
        assert_eq!(left.event_type, right.event_type);
        assert_eq!(left.timestamp, right.timestamp);
        assert_eq!(left.payload, right.payload);
    }

    impl NativeAiAuditAppender for CommitThenLoseReplyAppender {
        fn append(
            &self,
            _project_id: Option<&str>,
            events: &[AppendAiAuditEvent],
        ) -> anyhow::Result<()> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let mut committed = self
                .committed
                .lock()
                .map_err(|_| anyhow::anyhow!("committed event mutex poisoned"))?;
            for event in events {
                if let Some(existing) = committed
                    .iter()
                    .find(|existing| existing.event_id == event.event_id)
                {
                    assert_same_event(existing, event);
                } else {
                    committed.push(event.clone());
                }
            }
            if call == 0 {
                anyhow::bail!("injected reply loss after commit");
            }
            Ok(())
        }
    }

    #[test]
    fn native_http_observer_retries_exact_event_after_commit_reply_loss() -> anyhow::Result<()> {
        let appender = Arc::new(CommitThenLoseReplyAppender::default());
        let context = test_context(std::path::Path::new("/workspace"));
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context,
            route: test_route(),
            effective_request_configuration: test_effective_request_configuration(),
        };

        observer.request_prepared(&grimodex_ai::HttpPreparedRequest {
            body: Some(serde_json::json!({
                "model": "model-a",
                "messages": [{ "role": "user", "content": "exact prompt" }],
            })),
        })?;

        assert_eq!(appender.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            appender
                .committed
                .lock()
                .map_err(|_| anyhow::anyhow!("committed event mutex poisoned"))?
                .len(),
            1
        );
        Ok(())
    }

    #[test]
    fn native_route_is_derived_from_the_same_effective_params_snapshot() {
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::OpenaiCompatible,
            model: "effective-model".to_string(),
            active_openai_compatible_endpoint_id: Some("effective-endpoint".to_string()),
            openai_compatible_endpoints: vec![grimodex_ai::OpenaiCompatibleEndpoint {
                id: "effective-endpoint".to_string(),
                base_url: "https://gateway.example.test/v1".to_string(),
                api_variant: Some("responses".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let resolved_variant = grimodex_ai::resolve_api_variant(None, &settings, &settings.model);
        let params = grimodex_ai::build_chat_params(
            &settings,
            "secret-not-copied-to-route",
            None,
            false,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let mut params = params;
        params.request_max_output_tokens = Some(2_048);
        params.resolved_tool_protocol = grimodex_ai::ResolvedToolProtocol::Hermes;

        let route = NativeAiHttpAuditRoute::from_params(&settings, &params);
        let effective = NativeAiEffectiveRequestConfiguration::from_params(&params);
        assert_eq!(route.provider, params.provider.to_string());
        assert_eq!(route.model, params.model);
        assert_eq!(route.api_variant.as_deref(), params.api_variant.as_deref());
        assert_eq!(route.endpoint_id.as_deref(), Some("effective-endpoint"));
        assert_eq!(
            params.endpoints.openai_compat_custom,
            "https://gateway.example.test/v1"
        );
        assert!(!format!("{route:?}").contains(params.api_key));
        assert_eq!(effective.ai_novelist_mode, "chat");
        assert_eq!(effective.request_max_output_tokens, 2_048);
        assert_eq!(effective.resolved_tool_protocol, "hermes");
        assert!(!effective.retry_429);
        assert_eq!(effective.extra_body, None);
        assert_eq!(effective.openrouter_provider_pin, None);
        assert_eq!(effective.fusion, None);
        assert!(!format!("{effective:?}").contains(params.api_key));
    }

    #[test]
    fn native_effective_configuration_projects_ai_novelist_wire_settings_without_credentials() {
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::AiNovelist,
            model: "derrida_03".to_string(),
            ai_novelist: grimodex_ai::AiNovelistSettings {
                sampling: Some(serde_json::json!({
                    "top_a": 0.42,
                    "tailfree": 0.91,
                    "api_key": "settings-secret-must-not-be-captured",
                })),
                multilingual_mode: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings, Some("legacy"));
        let mut params = grimodex_ai::build_chat_params(
            &settings,
            "transport-secret-must-not-be-captured",
            extra_body,
            true,
            grimodex_ai::AiNovelistMode::Completion,
            Some("legacy".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        params.request_max_output_tokens = Some(777);

        let effective = NativeAiEffectiveRequestConfiguration::from_params(&params);
        assert_eq!(effective.ai_novelist_mode, "completion");
        assert_eq!(effective.request_max_output_tokens, 777);
        assert_eq!(effective.resolved_tool_protocol, "native");
        assert!(effective.retry_429);
        assert_eq!(
            effective.extra_body,
            Some(serde_json::json!({
                "top_a": 0.42,
                "tailfree": 0.91,
                "multilingualmode": true,
            }))
        );
        let audit_debug = format!("{effective:?}");
        assert!(!audit_debug.contains("settings-secret"));
        assert!(!audit_debug.contains("transport-secret"));
        assert!(!audit_debug.contains("api_key"));

        let fallback_params = grimodex_ai::build_chat_params(
            &settings,
            "transport-secret-must-not-be-captured",
            None,
            true,
            grimodex_ai::AiNovelistMode::Chat,
            Some("legacy".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            NativeAiEffectiveRequestConfiguration::from_params(&fallback_params)
                .request_max_output_tokens,
            grimodex_ai::ai_novelist::length_for(&settings.model)
        );
    }

    #[derive(Default)]
    struct RecordingNativeAiAuditAppender {
        events: Mutex<Vec<AppendAiAuditEvent>>,
    }

    impl NativeAiAuditAppender for RecordingNativeAiAuditAppender {
        fn append(
            &self,
            _project_id: Option<&str>,
            events: &[AppendAiAuditEvent],
        ) -> anyhow::Result<()> {
            self.events
                .lock()
                .map_err(|_| anyhow::anyhow!("recorded event mutex poisoned"))?
                .extend_from_slice(events);
            Ok(())
        }
    }

    #[test]
    fn native_effective_receipt_persists_exact_anthropic_body() -> anyhow::Result<()> {
        let appender = Arc::new(RecordingNativeAiAuditAppender::default());
        let context = test_context(std::path::Path::new("/workspace"));
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context: context.clone(),
            route: NativeAiHttpAuditRoute {
                provider: "anthropic".to_string(),
                model: "claude-opus-4-5".to_string(),
                api_variant: None,
                endpoint_id: None,
            },
            effective_request_configuration: test_effective_request_configuration(),
        };
        let body = serde_json::json!({
            "model": "claude-opus-4-5",
            "max_tokens": 12_345,
            "system": [
                {
                    "type": "text",
                    "text": "stable system",
                    "cache_control": { "type": "ephemeral" },
                },
                { "type": "text", "text": "volatile scene" },
            ],
            "messages": [{ "role": "user", "content": "exact user prompt" }],
            "tools": [{
                "name": "search_codex",
                "description": "search",
                "input_schema": { "type": "object" },
            }],
            "thinking": { "type": "enabled", "budget_tokens": 4_096 },
            "output_config": { "effort": "high" },
            "stream": true,
        });

        observer.request_prepared(&grimodex_ai::HttpPreparedRequest {
            body: Some(body.clone()),
        })?;

        let events = appender
            .events
            .lock()
            .map_err(|_| anyhow::anyhow!("recorded event mutex poisoned"))?;
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.event_type, "request.prepared");
        assert_eq!(
            event.event_id,
            native_ai_effective_request_event_id(&context)
        );
        assert_eq!(event.payload["captureState"], "complete");
        assert_eq!(event.payload["request"]["body"], body);
        assert_eq!(
            event.payload["effectiveRequestConfiguration"]["serializationFidelity"],
            "json-value"
        );
        assert_eq!(
            event.payload["effectiveRequestConfiguration"]
                ["serializationWhitespaceAndKeyOrderPreserved"],
            false
        );
        assert_eq!(event.payload["route"]["provider"], "anthropic");
        assert_eq!(event.payload["credentialsExcluded"], true);
        assert_eq!(event.payload["limitations"], serde_json::json!([]));
        let durable = serde_json::to_string(&event.payload)?;
        for forbidden in ["x-api-key", "authorization", "transport-secret"] {
            assert!(!durable.to_ascii_lowercase().contains(forbidden));
        }
        Ok(())
    }

    #[derive(Default)]
    struct AlwaysFailNativeAiAuditAppender {
        calls: AtomicUsize,
    }

    impl NativeAiAuditAppender for AlwaysFailNativeAiAuditAppender {
        fn append(
            &self,
            _project_id: Option<&str>,
            _events: &[AppendAiAuditEvent],
        ) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("injected durable append failure")
        }
    }

    #[test]
    fn native_effective_receipt_failure_remains_fail_closed_after_bounded_retry() {
        let appender = Arc::new(AlwaysFailNativeAiAuditAppender::default());
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context: test_context(std::path::Path::new("/workspace")),
            route: test_route(),
            effective_request_configuration: test_effective_request_configuration(),
        };

        let error = observer
            .request_prepared(&grimodex_ai::HttpPreparedRequest {
                body: Some(serde_json::json!({ "model": "model-a" })),
            })
            .expect_err("two durable append failures must reject dispatch");
        assert!(error
            .to_string()
            .contains("append native effective request.prepared failed after bounded retry"));
        assert_eq!(appender.calls.load(Ordering::SeqCst), 2);
    }

    fn fusion_started_payload(
        fusion: grimodex_ai::FusionConfig,
    ) -> anyhow::Result<serde_json::Value> {
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::OpenRouter,
            model: "openrouter/fusion".to_string(),
            openrouter_provider_pin: Some(" anthropic ".to_string()),
            fusion,
            ..Default::default()
        };
        let params = grimodex_ai::build_chat_params(
            &settings,
            "transport-secret-must-not-be-captured",
            None,
            false,
            grimodex_ai::AiNovelistMode::Chat,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let appender = Arc::new(RecordingNativeAiAuditAppender::default());
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context: test_context(std::path::Path::new("/workspace")),
            route: NativeAiHttpAuditRoute::from_params(&settings, &params),
            effective_request_configuration: NativeAiEffectiveRequestConfiguration::from_params(
                &params,
            ),
        };
        observer.attempt_started(&grimodex_ai::HttpAttemptStarted {
            attempt_number: 1,
            send_ordinal: 1,
            is_retry: false,
            reuses_initial_payload: false,
            endpoint: Some(grimodex_ai::HttpAttemptEndpoint {
                origin: "https://openrouter.ai".to_string(),
                host: "openrouter.ai".to_string(),
            }),
        })?;
        let events = appender
            .events
            .lock()
            .map_err(|_| anyhow::anyhow!("recorded event mutex poisoned"))?;
        let payload = events
            .first()
            .ok_or_else(|| anyhow::anyhow!("missing recorded started event"))?
            .payload
            .clone();
        Ok(payload)
    }

    #[test]
    fn native_fusion_configuration_is_complete_only_for_explicit_panel_and_judge(
    ) -> anyhow::Result<()> {
        let explicit = fusion_started_payload(grimodex_ai::FusionConfig {
            enabled: true,
            analysis_models: vec![
                " openai/gpt-5.2 ".to_string(),
                "".to_string(),
                "anthropic/claude-opus-4.5".to_string(),
            ],
            judge_model: Some(" google/gemini-3-pro-preview ".to_string()),
        })?;
        assert_eq!(explicit["captureState"], "complete");
        assert_eq!(explicit["limitations"], serde_json::json!([]));
        assert_eq!(
            explicit["effectiveRequestConfiguration"]["openrouterProviderPin"],
            "anthropic"
        );
        assert_eq!(
            explicit["effectiveRequestConfiguration"]["fusion"],
            serde_json::json!({
                "enabled": true,
                "customConfigurationApplied": true,
                "configurationComplete": true,
                "analysisModels": [
                    "openai/gpt-5.2",
                    "anthropic/claude-opus-4.5",
                ],
                "judgeModel": "google/gemini-3-pro-preview",
                "providerSelectedFusionPanelObserved": false,
            })
        );

        let provider_default = fusion_started_payload(grimodex_ai::FusionConfig::default())?;
        assert_eq!(provider_default["captureState"], "partial");
        assert_eq!(
            provider_default["effectiveRequestConfiguration"]["fusion"],
            serde_json::json!({
                "enabled": false,
                "customConfigurationApplied": false,
                "configurationComplete": false,
                "analysisModels": [],
                "judgeModel": null,
                "providerSelectedFusionPanelObserved": false,
            })
        );
        assert_eq!(
            provider_default["limitations"],
            serde_json::json!([
                "openrouter-fusion-provider-selected-panel-unobservable",
                "openrouter-fusion-provider-selected-judge-unobservable",
            ])
        );
        Ok(())
    }

    #[test]
    fn native_ai_diagnostic_redacts_url_assignment_json_and_header_credentials() {
        let raw = concat!(
            "HTTP attempt audit failed at ",
            "https://url-user:url-pass@example.test/v1/chat?api_key=url-secret#fragment ",
            "token=assignment-secret ",
            "OPENAI_API_KEY = \"quoted-api-secret\" ",
            "AWS_ACCESS_KEY_ID = 'access-id-secret' ",
            "provider_private_key = \"private-key-secret\" ",
            "openaiAuth = 'auth-alias-secret' ",
            r#"{"api_key":"api-secret","cookie":"cookie-secret","AWS_SECRET_ACCESS_KEY":"access-key-secret","providerAuth":"json-auth-secret","message":"keep diagnostic"}"#,
            "\nAuthorization: Bearer header-secret",
            "\nX-Api-Key: provider-header-secret",
            "\nkeep final diagnostic"
        );
        let error = anyhow::anyhow!("{}", raw);
        let sanitized = native_ai_error_to_napi(error).reason;

        for secret in [
            "url-user",
            "url-pass",
            "url-secret",
            "fragment",
            "assignment-secret",
            "quoted-api-secret",
            "access-id-secret",
            "private-key-secret",
            "auth-alias-secret",
            "api-secret",
            "cookie-secret",
            "access-key-secret",
            "json-auth-secret",
            "header-secret",
            "provider-header-secret",
        ] {
            assert!(!sanitized.contains(secret), "leaked {secret}: {sanitized}");
        }
        assert!(sanitized.contains("https://example.test/v1/chat"));
        assert!(sanitized.contains("keep diagnostic"));
        assert!(sanitized.contains("keep final diagnostic"));
        assert!(sanitized.contains("[REDACTED:credential]"));
    }
}

#[cfg(test)]
mod ime_workspace_tests {
    use super::*;
    use grimodex_db::state::ActiveWorkspace;
    use grimodex_db::Database;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn workspace_rotation_waits_for_the_snapshot_writer_then_invalidates_it() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-ime-workspace-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state = Arc::new(
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state"),
        );
        let options = ImeExportOptions {
            mode: ImeIntegrationMode::On,
            exclude_hidden: false,
            include_profile: true,
        };
        let old_request = state
            .ime_request_gate
            .register_refresh("default-project", &options);
        let writer = state.ime_write_lock.lock().expect("writer lock");
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let state_for_thread = Arc::clone(&state);
        let thread = std::thread::spawn(move || {
            started_tx.send(()).expect("started");
            rotate_ime_workspace(&state_for_thread);
            done_tx.send(()).expect("done");
        });

        started_rx.recv().expect("rotation started");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(30)).is_err(),
            "rotation must not pass the writer barrier"
        );
        drop(writer);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("rotation completes after writer release");
        thread.join().expect("rotation thread");

        assert!(!state.ime_request_gate.is_current(&old_request));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mismatched_workspace_path_does_not_invalidate_a_legitimate_request() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-ime-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let workspace_path = dir.join("workspace-a");
        std::fs::create_dir_all(&workspace_path).expect("workspace dir");
        let db = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        let authority =
            grimodex_db::WorkspaceAuthority::from_database_for_test(db, workspace_path.clone())
                .expect("authority");
        *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace::new(authority));
        let options = ImeExportOptions {
            mode: ImeIntegrationMode::On,
            exclude_hidden: false,
            include_profile: true,
        };
        let legitimate = state
            .ime_request_gate
            .register_refresh("default-project", &options);

        let result = pin_ime_workspace_request(
            &state,
            &dir.join("workspace-b").to_string_lossy(),
            |gate, generation| {
                gate.register_refresh_for_generation("default-project", &options, generation)
            },
        );

        assert!(result.is_err());
        assert!(state.ime_request_gate.is_current(&legitimate));
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_workspace_validation_canonicalizes_both_path_representations() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-codex-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let workspace_path = dir.join("workspace");
        let nested = workspace_path.join("nested");
        std::fs::create_dir_all(&nested).expect("workspace dirs");
        let db = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        let authority =
            grimodex_db::WorkspaceAuthority::from_database_for_test(db, workspace_path.clone())
                .expect("authority");
        *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace::new(authority));
        let snapshot = active_workspace_snapshot(&state.ws).expect("workspace snapshot");
        let equivalent_but_noncanonical = nested.join("..");

        validate_codex_workspace(&snapshot, &equivalent_but_noncanonical.to_string_lossy())
            .expect("equivalent workspace path");

        drop(snapshot);
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod semantic_reranker_lane_tests {
    use super::*;
    use grimodex_db::state::ActiveWorkspace;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn occupied_lane_returns_busy_without_queuing_later_inference() {
        let lane = Arc::new(Mutex::new(()));
        let first_inference = lane.lock().expect("first inference owns lane");
        let inference_starts = Arc::new(AtomicUsize::new(0));
        let lane_for_second = Arc::clone(&lane);
        let starts_for_second = Arc::clone(&inference_starts);
        let (result_tx, result_rx) = mpsc::channel();

        let second = thread::spawn(move || {
            let result = try_with_semantic_reranker_lane(&lane_for_second, |_| {
                starts_for_second.fetch_add(1, Ordering::SeqCst);
                Ok::<_, anyhow::Error>(())
            })
            .map_err(|error| format!("{error:#}"));
            result_tx.send(result).expect("send second result");
        });

        let error = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("occupied lane must reject immediately")
            .expect_err("second inference must be rejected as busy");
        assert!(
            error.starts_with("RERANKER_BUSY:"),
            "stable marker must cross the N-API wire: {error}"
        );
        assert_eq!(
            inference_starts.load(Ordering::SeqCst),
            0,
            "busy request must not enter inference"
        );

        drop(first_inference);
        second.join().expect("second request thread");
        assert_eq!(
            inference_starts.load(Ordering::SeqCst),
            0,
            "releasing the first inference must not start rejected work later"
        );
    }

    #[tokio::test]
    async fn pinned_project_db_records_exact_reranker_input_before_model_load_failure() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-reranker-audit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let workspace_path = dir.join("workspace");
        std::fs::create_dir_all(&workspace_path).expect("workspace dir");
        let expected_workspace_path = workspace_path.to_string_lossy().into_owned();
        let database = Arc::new(
            grimodex_db::Database::new(&workspace_path.join("grimodex.db"))
                .expect("open audit database"),
        );
        database.migrate().expect("migrate audit database");
        database
            .with_conn(|connection| {
                connection.execute(
                    "INSERT INTO projects (id, title, language) VALUES (?1, 'Audit', 'ja')",
                    ["project-a"],
                )?;
                Ok(())
            })
            .expect("seed project");

        let resources = dir.join("missing-semantic-resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let database = Arc::into_inner(database).expect("database Arc must be unique");
        let authority =
            grimodex_db::WorkspaceAuthority::from_database_for_test(database, workspace_path)
                .expect("authority");
        *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace::new(authority));
        let backend = Backend {
            state: Arc::new(state),
        };

        let error = backend
            .semantic_reranker_shadow_score(serde_json::json!({
                "requestId": "request-a",
                "expectedWorkspacePath": expected_workspace_path,
                "projectId": "project-a",
                "auditPathId": "semantic_reranker_shadow",
                "language": "ja",
                "userMessage": "exact user message",
                "sceneTail": "exact scene tail",
                "candidates": [{
                    "candidateId": "scene-a:0:10",
                    "text": "exact candidate text",
                }],
            }))
            .await
            .expect_err("missing model resources fail after audit");
        assert!(
            error.to_string().contains("resources are not configured"),
            "unexpected reranker preparation error: {error}"
        );

        let snapshot = {
            let guard = backend.state.ws.inner.lock().expect("workspace lock");
            let active = guard.as_ref().expect("workspace still open");
            active
                .db()
                .read_ai_audit_snapshot("project-a", None, None, None)
                .expect("read native reranker audit")
        };
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "execution.started",
                "request.prepared",
                "request.dispatched",
                "execution.failed",
            ]
        );
        let prepared = &snapshot.events[1];
        assert_eq!(prepared.path_id, "semantic_reranker_shadow");
        assert_eq!(
            prepared.payload["input"]["userMessage"],
            "exact user message"
        );
        assert_eq!(prepared.payload["input"]["sceneTail"], "exact scene tail");
        assert_eq!(
            prepared.payload["input"]["normalizedQuery"],
            "exact user message\nexact scene tail"
        );
        assert_eq!(
            prepared.payload["input"]["candidates"][0]["text"],
            "exact candidate text"
        );
        assert_eq!(
            prepared.payload["model"]["modelId"],
            "hotchpotch/japanese-reranker-xsmall-v2"
        );
        assert_eq!(prepared.payload["captureState"], "partial");
        assert_eq!(
            prepared.payload["model"]["tokenizerIdentityStatus"],
            "pending-effective-receipt"
        );
        assert_eq!(
            prepared.payload["tokenizationCapture"]["realizedTokenIds"],
            "not-retained"
        );
        assert_eq!(
            prepared.payload["tokenizationCapture"]["specialTokenExpansion"],
            "not-retained"
        );
        assert_eq!(
            prepared.payload["tokenizationCapture"]["postTruncationTokenSequence"],
            "not-retained"
        );
        let failed = &snapshot.events[3];
        assert_eq!(failed.payload["captureState"], "complete");
        assert_eq!(
            failed.payload["phase"],
            "local-inference-artifact-preparation"
        );
        assert_eq!(failed.payload["modelDispatched"], false);
        assert_eq!(failed.payload["onnxSessionRunObserved"], false);

        drop(backend);
        let _ = std::fs::remove_dir_all(dir);
    }
}
