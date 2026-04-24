//! `en/ellipsis` — suggest replacing `...` (three ASCII dots) with `…`.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r"\.{3,}").expect("static regex must compile"))
}

pub struct EllipsisRule;

impl LintRule for EllipsisRule {
    fn id(&self) -> &'static str {
        "en/ellipsis"
    }
    fn default_severity(&self) -> Severity {
        Severity::Info
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
            for m in regex().find_iter(&block.text) {
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "Use the ellipsis character (…)".to_string(),
                    range,
                    fix: Some(Fix {
                        label: "Replace with …".to_string(),
                        replacement: "\u{2026}".to_string(),
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
            term_dictionary: &[],
        };
        EllipsisRule.check(&input, &ctx)
    }

    #[test]
    fn detects_three_dots() {
        let ds = run("He paused... then spoke.");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "\u{2026}");
    }

    #[test]
    fn two_dots_ignored() {
        assert!(run("Wait.. no.").is_empty());
    }
}
