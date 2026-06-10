//! ライセンスゲートのパス解決 (ライセンス認証設計書 §6 / §14)。
//!
//! MCP サーバーは Tauri AppHandle なしで動くため、license.json の場所を
//! `dirs` クレートで解決する。Tauri v2 の `app_data_dir()` は
//! `dirs::data_dir()/{bundle identifier}` に解決されるので、同じ識別子
//! (`grimodex_core::license::APP_IDENTIFIER`) を使えば Tauri 側が読み書き
//! するのと同一ファイルを指す。識別子と tauri.conf.json の一致は
//! src-tauri 側の unit test が保証する。

use std::path::PathBuf;

/// Tauri 側が読み書きする license.json と同一のパス。
/// データディレクトリが解決できない環境では None (呼び出し側は fail-soft で
/// 許可に倒す)。
pub fn license_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| {
        d.join(grimodex_core::license::APP_IDENTIFIER)
            .join("license.json")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_ends_with_identifier_and_filename() {
        // CI 環境によっては data_dir が無いこともあるため Some の場合のみ検証。
        if let Some(p) = license_file_path() {
            let s = p.to_string_lossy();
            assert!(s.contains(grimodex_core::license::APP_IDENTIFIER));
            assert!(s.ends_with("license.json"));
        }
    }
}
