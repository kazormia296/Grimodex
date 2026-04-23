//! `ja/redundant-expression` — 冗長表現の検出（C群）。
//!
//! 日本語で「より短く書けることが多い」定番の冗長パターンをチェックする。
//! Phase 2 MVP はサーフェス regex の**保守的な**小規模リストから始める
//! — 誤爆してもいい精度のパターンだけを含めて、ユーザー体験を崩さない
//! ことを優先する。
//!
//! ## パターン一覧（Phase 2 初版）
//!
//! | ID  | マッチ | メッセージ |
//! |-----|--------|------------|
//! | `koto-ga-dekiru` | `(こと|事)が(でき|出来)(る|ない|ます|ません|た|なかった)` | 「こと」は省略できることが多い |
//! | `to-iu-koto`     | `という(こと|事)` | 「ということ」は省ける場合が多い |
//! | `koto-ni-naru`   | `(こと|事)になる` | 「ことになる」は直接的な表現に |
//!
//! 将来、形態素情報を使ったパターン拡張（例：サ変動詞限定の
//! 「することができる」Fix）を追加する予定。そのため
//! `requires_morphology: true` を宣言しておく。

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

pub struct RedundantExpressionRule;

struct Pattern {
    id: &'static str,
    regex: &'static OnceLock<Regex>,
    raw: &'static str,
    message: &'static str,
}

static RE_KOTO_GA_DEKIRU: OnceLock<Regex> = OnceLock::new();
static RE_TO_IU_KOTO: OnceLock<Regex> = OnceLock::new();
static RE_KOTO_NI_NARU: OnceLock<Regex> = OnceLock::new();

const PATTERNS: &[Pattern] = &[
    Pattern {
        id: "koto-ga-dekiru",
        regex: &RE_KOTO_GA_DEKIRU,
        raw: r"(?:こと|事)が(?:でき|出来)(?:る|ない|ます|ません|た|なかった)",
        message: "冗長表現: 「〜ことができる」は「〜できる」と短く書けることが多いです",
    },
    Pattern {
        id: "to-iu-koto",
        regex: &RE_TO_IU_KOTO,
        raw: r"という(?:こと|事)",
        message: "冗長表現: 「〜ということ」は省略できる場合が多いです",
    },
    Pattern {
        id: "koto-ni-naru",
        regex: &RE_KOTO_NI_NARU,
        raw: r"(?:こと|事)になる",
        message: "冗長表現: 「〜ことになる」は直接的な表現を検討してください",
    },
];

fn compiled(p: &Pattern) -> &Regex {
    #[allow(clippy::expect_used)] // static patterns — compile failure is a build bug
    p.regex
        .get_or_init(|| Regex::new(p.raw).expect("static regex must compile"))
}

impl LintRule for RedundantExpressionRule {
    fn id(&self) -> &'static str {
        "ja/redundant-expression"
    }

    fn default_severity(&self) -> Severity {
        Severity::Info
    }

    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

    fn requires_morphology(&self) -> bool {
        // Phase 2 MVP は surface regex のみで解決。形態素キャッシュは
        // 使わないので false を返す（この rule だけ有効な場合に
        // lindera 初期化コストを発生させない）。形態素情報を使う
        // パターン（例: サ変動詞限定の fix）を追加するタイミングで
        // true に変える。
        false
    }

    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[
            BlockKind::Paragraph,
            BlockKind::Blockquote,
            BlockKind::ListItem,
            BlockKind::TableCell,
        ]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());

        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for p in PATTERNS {
                for m in compiled(p).find_iter(&block.text) {
                    let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                    let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                    out.push(Diagnostic {
                        rule_id: self.id().to_string(),
                        severity,
                        message: format!("[{}] {}", p.id, p.message),
                        range: Utf16Range {
                            start: start_u16,
                            end: end_u16,
                        },
                        fix: None,
                    });
                }
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
    use crate::rule::{BlockKind, Diagnostic, Language, LintBlock, LintConfig, LintScope};

    fn run(text: &str) -> Vec<Diagnostic> {
        let blocks = vec![LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: 0,
        }];
        let cfg = LintConfig::default();
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None, // this rule is surface-only for now
        };
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "x".into(),
            },
        };
        RedundantExpressionRule.check(&input, &ctx)
    }

    #[test]
    fn flags_koto_ga_dekiru() {
        let ds = run("彼は走ることができる。");
        assert_eq!(ds.len(), 1);
        assert!(ds[0].message.contains("koto-ga-dekiru"));
    }

    #[test]
    fn flags_to_iu_koto() {
        let ds = run("重要だということがわかった。");
        assert!(ds.iter().any(|d| d.message.contains("to-iu-koto")));
    }

    #[test]
    fn flags_multiple_patterns() {
        // 2 つのパターンが別々にマッチする。
        let ds = run("走ることができるということがわかる。");
        assert!(ds.iter().any(|d| d.message.contains("koto-ga-dekiru")));
        assert!(ds.iter().any(|d| d.message.contains("to-iu-koto")));
    }

    #[test]
    fn ignores_unrelated_text() {
        let ds = run("彼は笑った。静かな夜だった。");
        assert!(ds.is_empty(), "{ds:?}");
    }
}
