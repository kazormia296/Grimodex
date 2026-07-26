//! イベント発火の抽象 (Electron 移行 Phase 2 設計書 §4.1)。
//!
//! Rust サブシステムがフロントへ push するイベントの emit 差し替え点。
//! Phase 2 で使うのは napi 側の 1 箇所 (`backend:ready` / `workspace:opened`)
//! だが、Phase 3 で ai / post_effect をこのクレート群へ抽出する際に 19 チャネル
//! をこの trait 経由に載せ替える。
//! - Tauri 実装: `AppHandle::emit`
//! - napi 実装: `ThreadsafeFunction`（NonBlocking）

/// イベントの送出先。実装はチャネル名と JSON ペイロードを受け取り、
/// シェル固有の経路 (Tauri emit / webContents.send) へ流す。
/// 失敗はシェル側で握る (emit はベストエフォート契約)。
pub trait EventSink {
    fn emit(&self, channel: &str, payload: serde_json::Value);
}
