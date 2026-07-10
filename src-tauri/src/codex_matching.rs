//! Codex 名寄せマッチャの Tauri コマンド層。
//!
//! 本体（MatchEntry / CodexMatch / CachedMatcher / CJK 境界判定 + 全テスト）は
//! grimodex-core (`crates/grimodex-core/src/codex_matching.rs`) へ移動した
//! (Electron 移行 Phase 3 バッチ1c: napi バックエンドと共用するため —
//! trash_bin / grimodex-fonts と同じ構図)。ここは `CodexMatcherState`
//! (tauri::State 用) と 2 つの #[tauri::command] だけの薄シムで、署名・挙動・
//! SLOW ログは移動前と完全に同一。
//!
//! 既存の呼び出し経路 (`crate::codex_matching::{MatchEntry, CachedMatcher, …}`)
//! は下の re-export でそのまま解決する。

use std::sync::Mutex;

use crate::commands::AppResult;

// grimodex-core からの re-export。lib.rs / 他モジュールの
// `crate::codex_matching::MatchEntry` 等が 1 行も変わらず解決する。
pub use grimodex_core::codex_matching::{CachedMatcher, CodexMatch, MatchEntry};

// ---------------------------------------------------------------------------
// Tauri State
// ---------------------------------------------------------------------------

pub struct CodexMatcherState {
    pub inner: Mutex<Option<CachedMatcher>>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn codex_rebuild_matcher(
    state: tauri::State<'_, CodexMatcherState>,
    entries: Vec<MatchEntry>,
) -> AppResult<()> {
    let matcher = CachedMatcher::build(&entries).map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut inner = state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    *inner = Some(matcher);
    Ok(())
}

#[tauri::command]
pub fn codex_match_text(
    state: tauri::State<'_, CodexMatcherState>,
    text: String,
    exclude_entry_ids: Vec<String>,
) -> AppResult<Vec<CodexMatch>> {
    let started = std::time::Instant::now();
    let text_chars = text.chars().count();
    let lock_started = std::time::Instant::now();
    let inner = state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let lock_wait_ms = lock_started.elapsed().as_millis();
    let match_started = std::time::Instant::now();
    let result = match inner.as_ref() {
        None => Ok(vec![]),
        Some(matcher) => Ok(matcher.match_text(&text, &exclude_entry_ids)),
    };
    let match_ms = match_started.elapsed().as_millis();
    let total_ms = started.elapsed().as_millis();
    if total_ms >= 50 {
        tracing::warn!(
            "codex_match_text total={}ms lock_wait={}ms match={}ms text_chars={}",
            total_ms,
            lock_wait_ms,
            match_ms,
            text_chars
        );
    }
    result
}
