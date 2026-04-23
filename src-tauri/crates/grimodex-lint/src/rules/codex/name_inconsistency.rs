//! `codex/name-inconsistency` — Codex エントリの表記ゆれを検出。
//!
//! 人物・地名・組織など Codex に登録した固有名詞について、
//! エントリで **canonical 以外** の alias がテキストに出現したら警告する。
//! 判定は設計書の方針通り **完全一致のみ**（編集距離は使わない）。
//!
//! ## マッチング
//!
//! - alias が全角または漢字仮名を含む場合: そのままリテラル一致
//! - alias が全文字 ASCII `[A-Za-z0-9_]` の場合のみ word boundary `\b`
//!   を付与（英字の部分一致を避ける）
//! - 大文字小文字は区別する（"Makoto" と "makoto" は別物）
//!
//! ## 出力
//!
//! Diagnostic.message に canonical 表記を含める。Fix は付けない
//! （同名別人の誤爆時の一括 revert を避けるため、手動編集推奨）。

use regex::Regex;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, CodexEntry, Diagnostic, Language, LintContext, LintInput, LintRule, Severity,
    Utf16Range,
};

pub struct NameInconsistencyRule;

/// Build a single alternation regex from all non-canonical aliases.
///
/// Returns `None` when no eligible alias is present (e.g. the config
/// passes Codex entries but none of them have aliases worth flagging).
fn build_matcher(entries: &[CodexEntry]) -> Option<(Regex, Vec<(String, String)>)> {
    // (alias, canonical) pairs keyed by the position of the group in
    // the alternation. Using `find_iter` + a second pass lookup by the
    // matched slice keeps things simple — no capture-group juggling.
    let mut alt_parts: Vec<String> = Vec::new();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for entry in entries {
        for alias in &entry.aliases {
            if alias.is_empty() || alias == &entry.canonical {
                continue;
            }
            // Design: only enforce word boundaries when the alias is
            // entirely ASCII word chars. Japanese aliases must not
            // get \b (which only understands ASCII word breaks and
            // produces surprising misses).
            let is_ascii_word =
                !alias.is_empty() && alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let escaped = regex::escape(alias);
            // `(?-u:\b)` uses ASCII-word-char semantics for the
            // boundary. Plain `\b` in Rust regex respects Unicode word
            // definition, which classifies 日本語 as word chars and
            // would prevent "Makoto" from matching when followed
            // directly by kana like "Makotoと".
            let part = if is_ascii_word {
                format!(r"(?-u:\b){}(?-u:\b)", escaped)
            } else {
                escaped
            };
            alt_parts.push(part);
            pairs.push((alias.clone(), entry.canonical.clone()));
        }
    }
    if alt_parts.is_empty() {
        return None;
    }
    let pattern = alt_parts.join("|");
    match Regex::new(&pattern) {
        Ok(re) => Some((re, pairs)),
        Err(_) => None,
    }
}

impl LintRule for NameInconsistencyRule {
    fn id(&self) -> &'static str {
        "codex/name-inconsistency"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn supported_languages(&self) -> &'static [Language] {
        // Codex entries are language-neutral — the rule fires for both.
        &[Language::Japanese, Language::English]
    }

    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[
            BlockKind::Paragraph,
            BlockKind::Heading,
            BlockKind::Blockquote,
            BlockKind::ListItem,
            BlockKind::TableCell,
        ]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let entries = &ctx.config.codex_entries;
        if entries.is_empty() {
            return Vec::new();
        }
        let Some((regex, _pairs)) = build_matcher(entries) else {
            return Vec::new();
        };
        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());

        // Index aliases by surface for fast canonical lookup. Multiple
        // entries could share the same alias — we report the first
        // canonical to keep the message deterministic. Future work:
        // surface a "multiple entries match this alias" warning.
        let mut alias_to_canonical: std::collections::HashMap<&str, &str> =
            std::collections::HashMap::new();
        for entry in entries {
            for alias in &entry.aliases {
                if alias == &entry.canonical || alias.is_empty() {
                    continue;
                }
                alias_to_canonical
                    .entry(alias.as_str())
                    .or_insert(entry.canonical.as_str());
            }
        }

        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for m in regex.find_iter(&block.text) {
                let matched = m.as_str();
                let Some(canonical) = alias_to_canonical.get(matched) else {
                    continue;
                };
                let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!(
                        "Codex 表記ゆれ: 「{}」→ 「{}」（別名が使われています）",
                        matched, canonical
                    ),
                    range: Utf16Range {
                        start: start_u16,
                        end: end_u16,
                    },
                    fix: None,
                });
            }
        }
        out
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use crate::rule::{
        BlockKind, CodexEntry, Diagnostic, Language, LintBlock, LintConfig, LintScope,
    };

    fn cfg_with(entries: Vec<CodexEntry>) -> LintConfig {
        LintConfig {
            rules: Default::default(),
            codex_entries: entries,
        }
    }

    fn run(text: &str, cfg: &LintConfig) -> Vec<Diagnostic> {
        let blocks = vec![LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: 0,
        }];
        let ctx = LintContext {
            config: cfg,
            block_tokens: None,
        };
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "x".into(),
            },
        };
        NameInconsistencyRule.check(&input, &ctx)
    }

    #[test]
    fn flags_alias_but_not_canonical() {
        let cfg = cfg_with(vec![CodexEntry {
            entry_id: "c1".into(),
            canonical: "真琴".into(),
            aliases: vec!["真琴".into(), "マコト".into(), "Makoto".into()],
        }]);
        let ds = run(
            "真琴は黙っていた。マコトの隣にMakotoと書かれた札があった。",
            &cfg,
        );
        assert_eq!(ds.len(), 2, "{ds:?}");
        assert!(ds.iter().any(|d| d.message.contains("マコト")));
        assert!(ds.iter().any(|d| d.message.contains("Makoto")));
    }

    #[test]
    fn no_codex_no_diagnostics() {
        let cfg = cfg_with(vec![]);
        let ds = run("真琴は黙っていた。", &cfg);
        assert!(ds.is_empty());
    }

    #[test]
    fn ascii_alias_has_word_boundary() {
        // "Mak" を alias に設定しても、"Makarov" 等の単語内部にはヒット
        // しない。これは \b が ASCII のみ対応だから可能。
        let cfg = cfg_with(vec![CodexEntry {
            entry_id: "c1".into(),
            canonical: "真琴".into(),
            aliases: vec!["Mak".into()],
        }]);
        let ds = run("Makarov walked in. Mak was already there.", &cfg);
        // 「Mak」だけが独立して出現している位置のみヒット。
        assert_eq!(ds.len(), 1, "{ds:?}");
    }

    #[test]
    fn case_sensitive_match() {
        let cfg = cfg_with(vec![CodexEntry {
            entry_id: "c1".into(),
            canonical: "Makoto".into(),
            aliases: vec!["makoto".into()],
        }]);
        let ds = run("Makoto と MAKOTO と makoto が並んだ。", &cfg);
        // 小文字 makoto のみヒット（MAKOTO と Makoto は別物扱い）。
        assert_eq!(ds.len(), 1);
    }
}
