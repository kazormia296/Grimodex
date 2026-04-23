//! `ja/consecutive-punct` — detect runs of Japanese punctuation (、 or 。).
//!
//! Examples: `、、`, `。。。`, `、、、`. The Fix replaces the run with a
//! single instance of the same character.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    // Match 2+ occurrences of the same JP punctuation char in a row.
    // `、` and `。` each occupy 3 UTF-8 bytes, so grouping via backreference
    // keeps the rule free of ambiguity between 、 and 。 runs side-by-side.
    #[allow(clippy::expect_used)] // static regex literal, compile failure = build bug
    RE.get_or_init(|| Regex::new(r"、{2,}|。{2,}").expect("static regex must compile"))
}

pub struct ConsecutivePunctRule;

impl LintRule for ConsecutivePunctRule {
    fn id(&self) -> &'static str {
        "ja/consecutive-punct"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
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
            for m in regex().find_iter(&block.text) {
                let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range {
                    start: start_u16,
                    end: end_u16,
                };

                // Fix replacement: a single instance of the first char in
                // the match. regex guarantees the match is at least 2 chars
                // of one of 、/。.
                let first_char = m.as_str().chars().next().unwrap_or('、');
                let replacement: String = first_char.to_string();

                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!("連続する「{}」は1つにまとめてください", first_char),
                    range,
                    fix: Some(Fix {
                        label: format!("「{}」に置き換える", replacement),
                        replacement,
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
    use crate::rule::{BlockKind, LintConfig, LintScope};

    fn run(text: &str) -> Vec<Diagnostic> {
        let cfg = LintConfig::default();
        let blocks = [crate::rule::LintBlock {
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
        };
        ConsecutivePunctRule.check(&input, &ctx)
    }

    #[test]
    fn detects_double_touten() {
        let ds = run("ああ、、いい");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].range, Utf16Range { start: 2, end: 4 });
        let fix = ds[0].fix.as_ref().unwrap();
        assert_eq!(fix.replacement, "、");
    }

    #[test]
    fn detects_triple_kuten() {
        let ds = run("終わった。。。");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].range, Utf16Range { start: 4, end: 7 });
    }

    #[test]
    fn no_false_positive_on_single_punct() {
        let ds = run("ここで、休む。");
        assert!(ds.is_empty());
    }

    #[test]
    fn mixed_adjacent_runs_separate() {
        let ds = run("あ、、い。。");
        assert_eq!(ds.len(), 2);
    }

    #[test]
    fn str_offset_applied() {
        let cfg = LintConfig::default();
        let blocks = [crate::rule::LintBlock {
            id: 1,
            kind: BlockKind::Paragraph,
            text: "、、".into(),
            str_offset_start: 100,
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
        };
        let ds = ConsecutivePunctRule.check(&input, &ctx);
        assert_eq!(ds.len(), 1);
        assert_eq!(
            ds[0].range,
            Utf16Range {
                start: 100,
                end: 102
            }
        );
    }
}
