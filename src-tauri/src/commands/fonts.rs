//! システムにインストール済みフォントの列挙。
//!
//! 実装本体は grimodex-fonts (`crates/grimodex-fonts`) に移動した
//! (Electron 移行 Phase 3: napi バックエンドと共用するため — trash_bin と
//! 同じ構図)。ここは薄いラッパーのみで、署名・挙動は移動前と完全に同一。

/// インストール済みフォントの family 名を昇順・重複排除して返す。
#[tauri::command]
pub(crate) fn list_system_fonts() -> Vec<String> {
    grimodex_fonts::list_system_fonts()
}
