//! Tauri adapter for Codex proper-noun candidate extraction.

use grimodex_semantic::codex_candidates::{self, CodexCandidate};
use tauri::Manager;

use grimodex_db::state::active_database;

use super::{AppError, WorkspaceState};

/// 本文中の未知 (Codex 未登録) 固有名詞候補を抽出する。
///
/// DB 読み出しと形態素解析は共有 crate が担い、Tauri 側は workspace 解決と
/// blocking-pool 境界だけを所有する。
#[tauri::command]
pub(crate) async fn extract_codex_candidates(
    app: tauri::AppHandle,
    project_id: String,
    min_count: Option<usize>,
) -> Result<Vec<CodexCandidate>, AppError> {
    // Electron adapter と同じく、blocking pool へ投入する前に開始時 DB を pin する。
    let db = active_database(&app.state::<WorkspaceState>())?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<CodexCandidate>, AppError> {
        Ok(codex_candidates::extract_codex_candidates(
            &db,
            &project_id,
            min_count,
        )?)
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?
}
