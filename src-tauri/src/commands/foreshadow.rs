//! Foreshadow Tauri commands.
//!
//! 実装本体は grimodex-db (`crates/grimodex-db/src/foreshadow.rs`) に移動した
//! (Electron 移行 Phase 3 バッチ1 — napi `Backend` と Tauri コマンドで共用するため。
//! trash_bin / plot_threads と同じ構図)。ここは `with_db` への薄いラッパーのみで、
//! 署名・SQL・検証・エラー契約・挙動は移動前と完全に同一。

use serde_json::Value;

use crate::database::foreshadow::{
    self, AnchorMarkOutput, ForeshadowChapterStatsBundle, ForeshadowCreatePayload,
    ForeshadowListWithLabelsResponse, ForeshadowPatch, ForeshadowSceneContextResponse,
    ForeshadowSceneInfoResponse, ForeshadowSetupPatch, OrphanResolvePayload, PayoffAnchorInput,
    SetupAnchorInput, SetupCreateAiInput,
};

use super::{with_db, AppError, WorkspaceState};

#[tauri::command(async)]
pub(crate) fn foreshadow_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: ForeshadowCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| foreshadow::create(db, payload))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: ForeshadowPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| foreshadow::update(db, id, patch))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| foreshadow::delete(db, id))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_list_with_labels(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<ForeshadowListWithLabelsResponse, AppError> {
    with_db(&ws_state, |db| foreshadow::list_with_labels(db, project_id))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_list_open_for_context(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<ForeshadowListWithLabelsResponse, AppError> {
    with_db(&ws_state, |db| {
        foreshadow::list_open_for_context(db, project_id)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_get_scene_info(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
) -> Result<ForeshadowSceneInfoResponse, AppError> {
    with_db(&ws_state, |db| foreshadow::get_scene_info(db, scene_id))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_get_scene_context(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
) -> Result<ForeshadowSceneContextResponse, AppError> {
    with_db(&ws_state, |db| foreshadow::get_scene_context(db, scene_id))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_list_by_codex_entry(
    ws_state: tauri::State<'_, WorkspaceState>,
    codex_entry_id: String,
) -> Result<ForeshadowListWithLabelsResponse, AppError> {
    with_db(&ws_state, |db| {
        foreshadow::list_by_codex_entry(db, codex_entry_id)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_get_chapter_stats(
    ws_state: tauri::State<'_, WorkspaceState>,
    chapter_id: String,
) -> Result<ForeshadowChapterStatsBundle, AppError> {
    with_db(&ws_state, |db| {
        foreshadow::get_chapter_stats(db, chapter_id)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_get_setup(
    ws_state: tauri::State<'_, WorkspaceState>,
    setup_id: String,
) -> Result<Option<Value>, AppError> {
    with_db(&ws_state, |db| foreshadow::get_setup(db, setup_id))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_update_setup(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: ForeshadowSetupPatch,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| foreshadow::update_setup(db, id, patch))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_get(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| foreshadow::get(db, id))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_link_codex(
    ws_state: tauri::State<'_, WorkspaceState>,
    foreshadow_id: String,
    codex_id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        foreshadow::link_codex(db, foreshadow_id, codex_id)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_unlink_codex(
    ws_state: tauri::State<'_, WorkspaceState>,
    foreshadow_id: String,
    codex_id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        foreshadow::unlink_codex(db, foreshadow_id, codex_id)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_list_linked_codex(
    ws_state: tauri::State<'_, WorkspaceState>,
    foreshadow_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        foreshadow::list_linked_codex(db, foreshadow_id)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_set_setup_strength(
    ws_state: tauri::State<'_, WorkspaceState>,
    setup_id: String,
    strength: Option<String>,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        foreshadow::set_setup_strength(db, setup_id, strength)
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub(crate) fn foreshadow_setup_create_ai(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
    kind: String,
    strength: Option<String>,
    ai_strength: Option<String>,
    attribution: String,
    ai_rationale: Option<String>,
    ai_reasoning: Option<String>,
    last_evaluated_at: Option<i64>,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        foreshadow::setup_create_ai(
            db,
            SetupCreateAiInput {
                id,
                foreshadow_id,
                scene_id,
                from_pos,
                to_pos,
                kind,
                strength,
                ai_strength,
                attribution,
                ai_rationale,
                ai_reasoning,
                last_evaluated_at,
            },
        )
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_resolve_orphan(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: OrphanResolvePayload,
) -> Result<Option<String>, AppError> {
    with_db(&ws_state, |db| foreshadow::resolve_orphan(db, payload))
}

#[tauri::command(async)]
pub(crate) fn foreshadow_save_anchors_for_scene(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
    setups: Vec<SetupAnchorInput>,
    payoffs: Vec<PayoffAnchorInput>,
    doc_content_size: i64,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        foreshadow::save_anchors_for_scene(db, scene_id, setups, payoffs, doc_content_size)
    })
}

#[tauri::command(async)]
pub(crate) fn foreshadow_load_anchors_for_scene(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
) -> Result<Vec<AnchorMarkOutput>, AppError> {
    let started = std::time::Instant::now();
    let result = with_db(&ws_state, |db| {
        foreshadow::load_anchors_for_scene(db, scene_id)
    });
    let total_ms = started.elapsed().as_millis();
    if total_ms >= 50 {
        tracing::warn!("foreshadow_load_anchors_for_scene total={}ms", total_ms);
    }
    result
}
