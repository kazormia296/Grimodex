//! `en/double-space` — flag `.  ` (period followed by two or more
//! spaces). Fix collapses to a single space.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r"\. {2,}").expect("static regex must compile"))
}

pub struct DoubleSpaceRule;

impl LintRule for DoubleSpaceRule {
    fn id(&self) -> &'static str {
        "en/double-space"
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
            for m in regex().find_iter(&block.text) {
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "Use a single space after a period".to_string(),
                    range,
                    fix: Some(Fix {
                        label: "Collapse to single space".to_string(),
                        replacement: ". ".to_string(),
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
        DoubleSpaceRule.check(&input, &ctx)
    }

    #[test]
    fn flags_double_space() {
        let ds = run("End of sentence.  Next sentence.");
        assert_eq!(ds.len(), 1);
    }

    #[test]
    fn single_space_ok() {
        assert!(run("End of sentence. Next.").is_empty());
    }
}
