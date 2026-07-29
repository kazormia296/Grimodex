//! Atomic AI write primitives for in-app agent tools (Tauri commands).
//!
//! 実装本体は grimodex-db (`crates/grimodex-db/src/agent_writes.rs`) に移動した
//! (Electron 移行 Phase 3 バッチ1 — napi `Backend` と Tauri コマンドで共用するため。
//! grimodex-db は grimodex-core に依存済みなので tracked write / undo_journal を
//! そのまま呼べる)。ここは `with_db` への薄いラッパーのみで、署名・トランザクション
//! 境界・XPROJ ガード・undo/redo・エラー契約は移動前と完全に同一。
//!
//! Each write bundles entity mutation + authorship_spans + undo_journal +
//! change_events in a single BEGIN IMMEDIATE transaction.

use serde_json::Value;

use crate::database::agent_writes::{
    self, AgentCodexCreatePayload, AgentCodexUpdatePayload, AgentEventCreatePayload,
    AgentEventIdPayload, AgentEventParticipantsPayload, AgentEventRelationPayload,
    AgentEventUpdatePayload, AgentForeshadowCreatePayload, AgentForeshadowUpdatePayload,
    AgentProposeSceneBodyPayload, AgentProseStageIdPayload, AgentSceneEventPayload,
    AgentSnippetCreatePayload, AgentUndoJournalPayload, AgentWriteBundlePayload,
};
use crate::database::chronicle_bulk::{self, AgentChronicleBulkPayload};

use super::{with_db, AppError, WorkspaceState};

// ─────────────────────── codex / snippet / bundle ───────────────────────

#[tauri::command(async)]
pub(crate) fn agent_codex_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentCodexCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_codex_create_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_codex_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentCodexUpdatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_codex_update_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_write_bundle(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentWriteBundlePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_write_bundle_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_snippet_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentSnippetCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_snippet_create_impl(db, payload)
    })
}

// ─────────────────────── prose staging ───────────────────────

#[tauri::command(async)]
pub(crate) fn agent_propose_scene_body(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentProposeSceneBodyPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_propose_scene_body_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_accept_prose_stage(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentProseStageIdPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_accept_prose_stage_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_discard_prose_stage(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentProseStageIdPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_discard_prose_stage_impl(db, payload)
    })
}

// ─────────────────────── undo/redo journal ───────────────────────

#[tauri::command(async)]
pub(crate) fn agent_apply_undo_journal(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentUndoJournalPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_undo_journal_impl(db, payload)
    })
}

// ─────────────────────── foreshadow (tracked adapters) ───────────────────────

#[tauri::command(async)]
pub(crate) fn agent_foreshadow_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentForeshadowCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_foreshadow_create_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_foreshadow_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentForeshadowUpdatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_foreshadow_update_impl(db, payload)
    })
}

// ─────────────────────── chronicle events ───────────────────────

#[tauri::command(async)]
pub(crate) fn agent_event_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_event_create_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_event_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventUpdatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_event_update_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_event_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventIdPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_event_delete_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_chronicle_bulk_mutate(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentChronicleBulkPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        chronicle_bulk::agent_chronicle_bulk_mutate_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_event_set_participants(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventParticipantsPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_event_set_participants_impl(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_scene_event_link(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentSceneEventPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_scene_event_mutate_impl(db, payload, true)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_scene_event_unlink(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentSceneEventPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_scene_event_mutate_impl(db, payload, false)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_event_relation_add(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventRelationPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_event_relation_mutate_impl(db, payload, true)
    })
}

#[tauri::command(async)]
pub(crate) fn agent_event_relation_remove(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventRelationPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_writes::agent_event_relation_mutate_impl(db, payload, false)
    })
}
