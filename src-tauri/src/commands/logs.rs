//! ログ関連 command。
//!
//! tracing の詳細ログは `~/.grimodex/logs/lint-tauri.YYYY-MM-DD.log`
//! （日次ローテーション、`lint_logging` 参照）へ常時書かれているが、
//! ユーザーがその存在に辿り着けないと「デバッグログを見ないと原因が
//! 分からないバグ」の報告が成立しない。設定画面と post_effect の
//! エラートーストからフォルダを開く導線を提供する。

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use super::AppResult;

/// ログフォルダを OS のファイルマネージャで開く。
#[tauri::command]
pub(crate) fn open_log_dir(app: AppHandle) -> AppResult<()> {
    let dir = crate::lint_logging::log_dir();
    // file logging が無効だった環境（読み取り専用 home 等）でもフォルダ自体は
    // 開けるよう、存在しなければ作成を試みる。失敗しても open 側の失敗に任せる。
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| anyhow::anyhow!("ログフォルダを開けませんでした: {e}"))?;
    Ok(())
}
