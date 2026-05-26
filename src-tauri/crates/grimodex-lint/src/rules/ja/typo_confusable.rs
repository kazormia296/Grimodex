//! `ja/typo-confusable` — カタカナ語の典型的な打ち間違い (タイポ) を検出。
//!
//! 「シュミレーション」のように、台詞での意図的な誤用がほぼ存在せず、
//! 単純な打ち間違い・覚え間違いとして発生する **カタカナ語に限定** した
//! 決定論的辞書ルール。形態素解析は使わない。
//!
//! 同音異義語の誤変換 (例: 「以外/意外」) や送り仮名のゆれ・助詞欠落は
//! 形態素解析だけでは Precision が出ない領域なので、AI Post-Effect
//! (`typo_detection`) 側に振り分ける。本ルールは住み分けの「決定論」側を
//! 担う。
//!
//! Fix は必ず添付し、Quick Fix で 1 操作置換できるようにする。

use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

/// (wrong, correct) のペア。
///
/// **採用基準**: 小説の台詞・地の文で意図的に書かれることがまず無い、
/// 純然たる打ち間違いだけを入れる。流行り言葉・若者言葉・方言として
/// 使われうるもの (「すいません」「ふいんき」など) は除外する。
const CONFUSABLES: &[(&str, &str)] = &[
    ("シュミレーション", "シミュレーション"),
    ("コミニュケーション", "コミュニケーション"),
    ("シュチエーション", "シチュエーション"),
    ("アボガド", "アボカド"),
    ("バトミントン", "バドミントン"),
    ("スマートホン", "スマートフォン"),
    ("ナルシスト", "ナルシシスト"),
    ("ハイエラルキー", "ヒエラルキー"),
    ("エキシビジョン", "エキシビション"),
    ("ジャグジー", "ジャクジー"),
];

struct Compiled {
    regex: Regex,
    by_wrong: HashMap<String, String>,
}

static COMPILED: OnceLock<Option<Compiled>> = OnceLock::new();

fn compiled() -> Option<&'static Compiled> {
    COMPILED
        .get_or_init(|| {
            if CONFUSABLES.is_empty() {
                return None;
            }
            let mut by_wrong: HashMap<String, String> = HashMap::new();
            let mut parts: Vec<String> = Vec::with_capacity(CONFUSABLES.len());
            for (wrong, correct) in CONFUSABLES {
                if by_wrong.contains_key(*wrong) {
                    continue;
                }
                by_wrong.insert((*wrong).to_string(), (*correct).to_string());
                parts.push(regex::escape(wrong));
            }
            let pattern = parts.join("|");
            Regex::new(&pattern)
                .ok()
                .map(|regex| Compiled { regex, by_wrong })
        })
        .as_ref()
}

pub struct TypoConfusableRule;

pub const RULE_ID: &str = "ja/typo-confusable";

impl LintRule for TypoConfusableRule {
    fn id(&self) -> &'static str {
        RULE_ID
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
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
        let Some(compiled) = compiled() else {
            return Vec::new();
        };
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
            for m in compiled.regex.find_iter(&block.text) {
                let matched = m.as_str();
                let Some(correct) = compiled.by_wrong.get(matched) else {
                    continue;
                };
                let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range {
                    start: start_u16,
                    end: end_u16,
                };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!("「{matched}」は「{correct}」の打ち間違いの可能性があります"),
                    range,
                    fix: Some(Fix {
                        label: format!("「{correct}」に置き換える"),
                        replacement: correct.clone(),
                        range,
                    }),
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
    use crate::rule::{LintBlock, LintConfig, LintScope};

    fn run(text: &str) -> Vec<Diagnostic> {
        let cfg = LintConfig::default();
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: 0,
        }];
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "t".into(),
            },
        };
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None,
            term_dictionary: &[],
        };
        TypoConfusableRule.check(&input, &ctx)
    }

    #[test]
    fn detects_simulation_typo() {
        let ds = run("シュミレーションを実行する");
        assert_eq!(ds.len(), 1);
        let fix = ds[0].fix.as_ref().unwrap();
        assert_eq!(fix.replacement, "シミュレーション");
    }

    #[test]
    fn detects_multiple_typos_in_one_block() {
        let ds = run("アボガドとバトミントンが好き");
        assert_eq!(ds.len(), 2, "{ds:?}");
    }

    #[test]
    fn no_false_positive_on_correct_spelling() {
        let ds = run("シミュレーションを実行する");
        assert!(ds.is_empty());
    }

    #[test]
    fn no_false_positive_on_intentional_speech() {
        // 台詞での意図的な誤用が想定される語は辞書に入っていないこと
        let ds = run("すいません、ふいんきが悪いです");
        assert!(ds.is_empty());
    }

    #[test]
    fn fix_range_matches_diagnostic_range() {
        let ds = run("コミニュケーション");
        assert_eq!(ds.len(), 1);
        let fix = ds[0].fix.as_ref().unwrap();
        assert_eq!(fix.range, ds[0].range);
    }

    #[test]
    fn str_offset_applied() {
        let cfg = LintConfig::default();
        let blocks = [LintBlock {
            id: 1,
            kind: BlockKind::Paragraph,
            text: "シュミレーション".into(),
            str_offset_start: 50,
        }];
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "t".into(),
            },
        };
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None,
            term_dictionary: &[],
        };
        let ds = TypoConfusableRule.check(&input, &ctx);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].range.start, 50);
        assert_eq!(ds[0].range.end, 50 + 8);
    }

    #[test]
    fn severity_can_be_overridden_by_config() {
        let mut cfg = LintConfig::default();
        cfg.rules.insert(
            RULE_ID.to_string(),
            crate::rule::RuleConfig {
                enabled: true,
                severity: Some(Severity::Info),
                options: serde_json::Value::Null,
            },
        );
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "シュミレーション".into(),
            str_offset_start: 0,
        }];
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "t".into(),
            },
        };
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None,
            term_dictionary: &[],
        };
        let ds = TypoConfusableRule.check(&input, &ctx);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Info);
    }
}
