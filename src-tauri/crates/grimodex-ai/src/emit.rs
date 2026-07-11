//! ストリーミング emit の抽象（Electron 移行 Phase 3 バッチ3a）。
//!
//! AI ストリーミングのチャンク/完了イベントは、Tauri では `AppHandle::emit`、
//! Electron（napi）では `EventQueue`（ThreadsafeFunction 経由）へ流れる。この
//! クレートを両者で共用するため、emit 先を `StreamEmitter` trait で抽象化し、
//! `send_chat_stream` / `ai_responses::send_stream` は具体的な emit 実装を知らない。
//!
//! - Tauri 側: `AppHandle` をラップした薄いアダプタ（src-tauri）。
//! - napi 側: `grimodex-node` の `EventQueue`（grimodex-db の EventSink を実装済み）が
//!   この trait も実装する。
//!
//! payload は `serde_json::Value`。Tauri の `Emitter::emit<S: Serialize>` はワイヤに
//! JSON を載せるため、`Value` を渡しても既存のフロント契約（`{delta, block_type}` /
//! `{stop_reason, input_tokens, ...}`）と byte 等価になる。

/// ストリーミングイベント 1 件の配信先。**ベストエフォート契約**（Tauri の
/// `let _ = app_handle.emit(...)` と同じく、失敗しても呼び出し側は続行する）。
///
/// `Send + Sync` は必須: `send_chat_stream` は Tauri コマンド（Send な future を
/// 要求）としても spawn されるため、`&dyn StreamEmitter` を await を跨いで保持する
/// future が Send になる条件が `dyn StreamEmitter: Sync`。
pub trait StreamEmitter: Send + Sync {
    /// `channel` は `"chat:stream-chunk"` 等の完全なチャネル名、`payload` は
    /// フロントが受け取る JSON。
    fn emit(&self, channel: &str, payload: serde_json::Value);
}
