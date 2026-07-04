//! Export ファイル保存コマンド。
//!
//! **設計 (security audit PIO-2 徹底案)**: 保存ダイアログを **Rust 側で開いて
//! その場で書き込む**。renderer はデータ＋推奨ファイル名のみ渡し、書き込み先
//! パスを一切渡さない。これにより:
//!   - renderer に `fs:write` capability を与えなくてよい（撤廃済）。
//!   - 侵害された renderer は（ユーザーに見える）保存ダイアログを出せるだけで、
//!     任意パスへの silent な書き込みはできない（パスはダイアログ由来の
//!     user-chosen path に限られる）。
//!   - ダイアログで任意の場所を選べる＝ save-anywhere が維持される。
//!
//! renderer がパス文字列を渡す write コマンドにしてはならない。それ自体が
//! 無制限の任意書き込みプリミティブになり、scope 縮小より退行する。

use base64::Engine as _;
use tauri_plugin_dialog::DialogExt;

use super::AppError;

/// ネイティブ保存ダイアログを Rust 側で開き、ユーザーが選んだパスを返す。
/// キャンセル時は `None`。vivliostyle.rs (成果物保存) からも同じ流儀で使う。
pub(crate) fn prompt_save_path(
    app: &tauri::AppHandle,
    suggested_name: &str,
    filter_name: &str,
    extensions: &[String],
) -> Option<std::path::PathBuf> {
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    app.dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter(filter_name, &ext_refs)
        .blocking_save_file()
        .and_then(|fp| fp.into_path().ok())
}

/// テキストを保存。保存できたら絶対パス文字列、キャンセル時は `None` を返す。
#[tauri::command]
pub(crate) fn export_save_text(
    app: tauri::AppHandle,
    suggested_name: String,
    filter_name: String,
    extensions: Vec<String>,
    contents: String,
) -> Result<Option<String>, AppError> {
    let Some(path) = prompt_save_path(&app, &suggested_name, &filter_name, &extensions) else {
        return Ok(None);
    };
    std::fs::write(&path, contents.as_bytes())
        .map_err(|e| anyhow::anyhow!("failed to write {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// base64 エンコードされたバイナリを保存。保存できたら絶対パス文字列、
/// キャンセル時は `None` を返す。
#[tauri::command]
pub(crate) fn export_save_bytes(
    app: tauri::AppHandle,
    suggested_name: String,
    filter_name: String,
    extensions: Vec<String>,
    contents_base64: String,
) -> Result<Option<String>, AppError> {
    let Some(path) = prompt_save_path(&app, &suggested_name, &filter_name, &extensions) else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|e| anyhow::anyhow!("invalid base64 export payload: {e}"))?;
    std::fs::write(&path, &bytes)
        .map_err(|e| anyhow::anyhow!("failed to write {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
