//! `en/straight-quotes` — suggest curly quotes for a pair of straight
//! ASCII double quotes. The heuristic matches `"..."` spanning a single
//! line and replaces with `“...”`.
//!
//! Apostrophes (`'`) are intentionally left alone — they'd need a
//! possessive/contraction heuristic that is out of Phase 1 scope.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r#""([^"\n]*)""#).expect("static regex must compile"))
}

pub struct StraightQuotesRule;

impl LintRule for StraightQuotesRule {
    fn id(&self) -> &'static str {
        "en/straight-quotes"
    }
    fn default_severity(&self) -> Severity {
        Severity::Warning
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::English]
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
            for caps in regex().captures_iter(&block.text) {
                let Some(full_m) = caps.get(0) else { continue };
                let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let start = block.str_offset_start + utf8_to_utf16(&block.text, full_m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, full_m.end());
                let range = Utf16Range { start, end };
                let replacement = format!("\u{201C}{}\u{201D}", inner);
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "Use curly quotes “…” in prose".to_string(),
                    range,
                    fix: Some(Fix {
                        label: "Replace with curly quotes".to_string(),
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
            language: Language::English,
            scope: LintScope::Scene {
                scene_id: "t".into(),
            },
        };
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None,
        };
        StraightQuotesRule.check(&input, &ctx)
    }

    #[test]
    fn flags_straight_pair() {
        let ds = run(r#"He said "hello" loudly."#);
        assert_eq!(ds.len(), 1);
        assert_eq!(
            ds[0].fix.as_ref().unwrap().replacement,
            "\u{201C}hello\u{201D}"
        );
    }

    #[test]
    fn lone_quote_ignored() {
        assert!(run(r#"He said "hello."#).is_empty());
    }
}
