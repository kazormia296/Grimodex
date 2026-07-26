//! AI プロバイダ層は `crates/grimodex-ai` へ抽出済み（Electron 移行 Phase 3
//! バッチ3a — Tauri コマンド層と napi バックエンドで共用）。この shim は
//! src-tauri 側の従来パス `crate::ai::*` を維持するための薄い re-export。
//!
//! ストリーミングの emit は grimodex-ai の `StreamEmitter` trait 越し。Tauri 側は
//! `AppHandle` をラップした `TauriEmitter` でこれを満たす（napi 側は EventQueue）。

pub use grimodex_ai::*;

use grimodex_ai::emit::StreamEmitter;

/// Tauri の `AppHandle` を `StreamEmitter` として使うアダプタ。
/// `Emitter::emit` は全窓 broadcast — AI ストリーム（chat / inline-ai）の
/// 従来の配信契約（`app_handle.emit`）と byte 等価。
pub struct TauriEmitter(pub tauri::AppHandle);

impl StreamEmitter for TauriEmitter {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(channel, payload);
    }
}
