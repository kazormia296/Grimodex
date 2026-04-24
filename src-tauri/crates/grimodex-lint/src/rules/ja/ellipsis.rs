//! `ja/ellipsis-single` and `ja/ellipsis-odd`.
//!
//! Japanese novels conventionally use pairs of `…` (two or multiples of
//! two). Both rules inspect runs of `…+`:
//!
//! - `ja/ellipsis-single`: a run of length 1 (Error, Fix → `……`)
//! - `ja/ellipsis-odd`: a run of odd length ≥ 3 (Warning, Fix → nearest
//!   smaller even count, i.e. `length - 1`)

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    #[allow(clippy::expect_used)] // static regex literal
    RE.get_or_init(|| Regex::new(r"…+").expect("static regex must compile"))
}

fn severity_for(ctx: &LintContext, rule_id: &'static str, default: Severity) -> Severity {
    ctx.config
        .rule(rule_id)
        .and_then(|r| r.severity)
        .unwrap_or(default)
}

fn supported_blocks() -> &'static [BlockKind] {
    &[
        BlockKind::Paragraph,
        BlockKind::Heading,
        BlockKind::Blockquote,
        BlockKind::ListItem,
        BlockKind::TableCell,
    ]
}

pub struct EllipsisSingleRule;

impl LintRule for EllipsisSingleRule {
    fn id(&self) -> &'static str {
        "ja/ellipsis-single"
    }
    fn default_severity(&self) -> Severity {
        Severity::Error
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }
    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        supported_blocks()
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let severity = severity_for(ctx, self.id(), self.default_severity());
        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for m in regex().find_iter(&block.text) {
                // Count the number of `…` chars in the match. Each `…` is
                // 3 bytes in UTF-8, but let's use chars().count() for
                // readability.
                let count = m.as_str().chars().count();
                if count != 1 {
                    continue;
                }
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "三点リーダーは 2 つ組で使います".to_string(),
                    range,
                    fix: Some(Fix {
                        label: "「……」に置き換える".to_string(),
                        replacement: "……".to_string(),
                        range,
                    }),
                });
            }
        }
        out
    }
}

pub struct EllipsisOddRule;

impl LintRule for EllipsisOddRule {
    fn id(&self) -> &'static str {
        "ja/ellipsis-odd"
    }
    fn default_severity(&self) -> Severity {
        Severity::Warning
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }
    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        supported_blocks()
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let severity = severity_for(ctx, self.id(), self.default_severity());
        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for m in regex().find_iter(&block.text) {
                let count = m.as_str().chars().count();
                if count < 3 || count % 2 == 0 {
                    continue;
                }
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                // Fix: drop one `…` to make the count even.
                let replacement: String = "…".repeat(count - 1);
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!("三点リーダーが {} つです（偶数個にしてください）", count),
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
    use crate::rule::{BlockKind, LintBlock, LintConfig, LintScope};

    fn run_single(text: &str) -> Vec<Diagnostic> {
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
        EllipsisSingleRule.check(&input, &ctx)
    }

    fn run_odd(text: &str) -> Vec<Diagnostic> {
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
        EllipsisOddRule.check(&input, &ctx)
    }

    #[test]
    fn lone_ellipsis_flagged_as_single() {
        let ds = run_single("あれ…ね");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "……");
    }

    #[test]
    fn double_ellipsis_not_flagged_single() {
        assert!(run_single("あれ……ね").is_empty());
    }

    #[test]
    fn double_ellipsis_not_flagged_odd() {
        assert!(run_odd("あれ……ね").is_empty());
    }

    #[test]
    fn triple_ellipsis_flagged_odd_not_single() {
        assert_eq!(run_odd("あれ………ね").len(), 1);
        assert!(run_single("あれ………ね").is_empty());
    }

    #[test]
    fn quad_ellipsis_passes_both() {
        assert!(run_single("あれ…………ね").is_empty());
        assert!(run_odd("あれ…………ね").is_empty());
    }
}
