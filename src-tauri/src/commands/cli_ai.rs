//! Tauri commands for CLI providers (Claude Code / Codex / OpenCode).
//!
//! 既存の HTTP ベース AI command (`commands/ai.rs`) と並行して動作する。
//! フロントエンドから送られる `cli_kind` に応じて `cli_provider::run` を
//! 起動し、stdout NDJSON を `chat:stream-chunk` / `chat:stream-done` イベントに
//! マッピングして emit する。Chat 側の既存ストリーム処理 (`api.ts`) はそのまま再利用できる。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Emitter;

use crate::cli_provider::{self, CliEvent, CliKind, CliRunOpts};

use super::{AppError, CliStreamAbortFlag};

/// CLI バイナリを PATH 上から探し、見つかったパスを返す。
/// macOS GUI 起動時の PATH 問題を回避するため `bash -lc 'which <bin>'` 経由。
/// 見つからなければ None。
#[tauri::command]
pub(crate) async fn detect_cli_binary(cli: CliKind) -> Result<Option<String>, AppError> {
    Ok(cli_provider::detect_binary(cli).await)
}

/// CLI バイナリの起動可否を確認 (`<bin> --version` を叩く)。
/// 認証状態までは確認しない (各 CLI で `<bin> login` 等を別途実行する想定)。
#[tauri::command]
pub(crate) async fn test_cli_connection(binary_path: String) -> Result<String, AppError> {
    let result = cli_provider::test_binary(&binary_path).await?;
    Ok(result)
}

/// 進行中の CLI ストリームを中断する。AtomicBool を立てるだけで、
/// `cli_provider::run` のループが次の iteration で kill する。
///
/// 注: 現状はアプリ全体で 1 つのフラグを共有しているため、Chat と inline AI が
/// 同時に CLI を叩いている場合は片方の abort で両方が止まる。Phase 以降で
/// 並行実行が必要になったら stream_id ベースに分割すること。
#[tauri::command]
pub(crate) fn abort_cli_chat_stream(
    abort_flag: tauri::State<'_, CliStreamAbortFlag>,
) -> Result<(), AppError> {
    abort_flag.flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliChatPayload {
    cli: CliKind,
    /// ユーザーが Settings で指定した実行可能ファイルのパス。
    /// 未指定なら CLI 名で PATH 解決 (`detect_cli_binary` 結果を使うことを推奨)
    binary_path: Option<String>,
    /// CLI に渡すモデル名。空なら CLI のデフォルトモデル
    model: Option<String>,
    /// プロンプト本体
    prompt: String,
}

/// CLI を起動して stdout を `chat:stream-chunk` / `chat:stream-done` イベントに
/// 変換しつつ流す。エラーは `chat:stream-error` で通知する。
#[tauri::command]
pub(crate) async fn send_cli_chat_stream(
    abort_flag: tauri::State<'_, CliStreamAbortFlag>,
    app_handle: tauri::AppHandle,
    payload: CliChatPayload,
) -> Result<(), AppError> {
    abort_flag.flag.store(false, Ordering::Relaxed);
    let flag_clone = Arc::clone(&abort_flag.flag);

    let opts = CliRunOpts {
        binary_path: payload.binary_path,
        model: payload.model,
        prompt: payload.prompt,
    };

    let app_for_events = app_handle.clone();
    let result = cli_provider::run(payload.cli, opts, flag_clone, move |evt| match evt {
        CliEvent::TextDelta(delta) => {
            let _ = app_for_events.emit(
                "cli:stream-chunk",
                serde_json::json!({
                    "delta": delta,
                    "block_type": "text",
                }),
            );
        }
        CliEvent::ThinkingDelta(delta) => {
            let _ = app_for_events.emit(
                "cli:stream-chunk",
                serde_json::json!({
                    "delta": delta,
                    "block_type": "thinking",
                }),
            );
        }
        CliEvent::Done {
            input_tokens,
            output_tokens,
            stop_reason,
        } => {
            let _ = app_for_events.emit(
                "cli:stream-done",
                serde_json::json!({
                    "stop_reason": stop_reason,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                }),
            );
        }
    })
    .await;

    if let Err(e) = result {
        let _ = app_handle.emit(
            "cli:stream-error",
            serde_json::json!({ "message": e.to_string() }),
        );
        return Err(AppError::Anyhow(e));
    }
    Ok(())
}
