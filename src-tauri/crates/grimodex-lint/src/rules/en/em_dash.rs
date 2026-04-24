//! `en/em-dash` — spot ` - ` (spaced hyphen) between words and suggest an
//! em dash `—`. Phase 1 does not auto-apply, but the Fix is offered so
//! the user can accept it explicitly.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    // Match `word - word` with a single ASCII hyphen surrounded by
    // spaces. The spaces are captured so the replacement collapses them.
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r"(\w) - (\w)").expect("static regex must compile"))
}

pub struct EmDashRule;

impl LintRule for EmDashRule {
    fn id(&self) -> &'static str {
        "en/em-dash"
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
            for caps in regex().captures_iter(&block.text) {
                let Some(full_m) = caps.get(0) else { continue };
                let left = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let right = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let start = block.str_offset_start + utf8_to_utf16(&block.text, full_m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, full_m.end());
                let range = Utf16Range { start, end };
                let replacement = format!("{}\u{2014}{}", left, right);
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "Consider an em dash (—) instead of a spaced hyphen".to_string(),
                    range,
                    fix: Some(Fix {
                        label: "Replace with em dash".to_string(),
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
            term_dictionary: &[],
        };
        EmDashRule.check(&input, &ctx)
    }

    #[test]
    fn flags_spaced_hyphen() {
        let ds = run("It was cold - and also silent.");
        assert_eq!(ds.len(), 1);
    }

    #[test]
    fn non_word_neighbors_ignored() {
        assert!(run("- bullet point").is_empty());
    }
}
