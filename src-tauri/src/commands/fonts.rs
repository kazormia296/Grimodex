//! システムにインストール済みフォントの列挙。
//!
//! `fontdb` で OS のフォントディレクトリをスキャンし、CSS の `font-family` に
//! そのまま使える family 名のリストを返す。ネットワーク・C ライブラリ依存なし。
//! フロント側 (`useSystemFonts`) は起動後 1 回だけ呼んでキャッシュする想定。

/// インストール済みフォントの family 名を昇順・重複排除して返す。
#[tauri::command]
pub(crate) fn list_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    collect_families(&db)
}

/// fontdb の各 face から代表 family 名を 1 つ取り出し、正規化して返す。
fn collect_families(db: &fontdb::Database) -> Vec<String> {
    let names = db
        .faces()
        .filter_map(|face| representative_family(&face.families))
        .collect();
    dedup_sort_families(names)
}

/// 1 つの face が持つ複数の (family 名, 言語) から、表示・CSS 参照に使う 1 名を選ぶ。
///
/// 日本語名があれば最優先する。fontdb は英語名を先頭に並べるため
/// (例: `[("IPAGothic", En), ("IPAゴシック", Ja)]`) `.first()` だと英語名になるが、
/// 日本語ユーザーには日本語名のほうが認識しやすく、WebKit / WebView2 とも
/// ローカライズ名を CSS で解決できる。日本語名が無ければ英語(US)名、
/// どちらも無ければ先頭名にフォールバックする。
fn representative_family(families: &[(String, fontdb::Language)]) -> Option<String> {
    use fontdb::Language;
    families
        .iter()
        .find(|(_, lang)| matches!(lang, Language::Japanese_Japan))
        .or_else(|| {
            families
                .iter()
                .find(|(_, lang)| matches!(lang, Language::English_UnitedStates))
        })
        .or_else(|| families.first())
        .map(|(name, _)| name.clone())
}

/// family 名リストを正規化する純関数:
/// trim → 空文字除去 → 大小無視で重複排除（初出を保持）→ 大小無視で昇順ソート。
fn dedup_sort_families(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = names
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .filter(|n| seen.insert(n.to_lowercase()))
        .collect();
    out.sort_by_key(|n| n.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_sort_basic() {
        let input = vec![
            "  Yu Mincho ".to_string(),
            "Arial".to_string(),
            "yu mincho".to_string(),
            String::new(),
            "   ".to_string(),
            "Noto Sans JP".to_string(),
        ];
        let out = dedup_sort_families(input);
        assert_eq!(out, vec!["Arial", "Noto Sans JP", "Yu Mincho"]);
    }

    #[test]
    fn dedup_keeps_first_casing() {
        let out = dedup_sort_families(vec!["Meiryo".to_string(), "meiryo".to_string()]);
        assert_eq!(out, vec!["Meiryo"]);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(dedup_sort_families(vec![]).is_empty());
        assert!(dedup_sort_families(vec![String::new(), "  ".to_string()]).is_empty());
    }

    #[test]
    fn representative_prefers_japanese_then_english() {
        use fontdb::Language;
        // 英語名が先頭でも日本語名を優先する（fontdb の実際の並び順を再現）。
        let both = vec![
            ("IPAGothic".to_string(), Language::English_UnitedStates),
            ("IPAゴシック".to_string(), Language::Japanese_Japan),
        ];
        assert_eq!(representative_family(&both).as_deref(), Some("IPAゴシック"));

        // 日本語名が無ければ英語名。
        let en_only = vec![("Arial".to_string(), Language::English_UnitedStates)];
        assert_eq!(representative_family(&en_only).as_deref(), Some("Arial"));

        assert_eq!(representative_family(&[]), None);
    }
}
