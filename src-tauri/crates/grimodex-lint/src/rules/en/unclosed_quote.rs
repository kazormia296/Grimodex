//! `en/unclosed-quote` — flag an opening double quote that has no matching
//! close within its paragraph and is not part of the legitimate
//! paragraph-spanning dialogue convention (where the next paragraph re-opens
//! with a quote).
//!
//! The detection lives in [`crate::dialogue::analyze_dialogue`], which the
//! engine also uses for narration/dialogue scope filtering. This rule simply
//! surfaces its `unclosed_ranges()` as diagnostics.

use crate::dialogue::analyze_dialogue;
use crate::rule::{
    Diagnostic, IncrementalScope, Language, LintContext, LintInput, LintRule, Severity,
};

pub struct UnclosedQuoteRule;

impl LintRule for UnclosedQuoteRule {
    fn id(&self) -> &'static str {
        "en/unclosed-quote"
    }
    fn default_severity(&self) -> Severity {
        Severity::Warning
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::English]
    }
    fn incremental_scope(&self) -> IncrementalScope {
        // English multi-paragraph dialogue is valid when the next paragraph
        // re-opens with a quote, so this paragraph cannot be cached without
        // its immediate successor as context.
        IncrementalScope::NextBlock
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());

        let analysis = analyze_dialogue(input.blocks);
        analysis
            .unclosed_ranges()
            .iter()
            .map(|range| Diagnostic {
                rule_id: self.id().to_string(),
                severity,
                message: "Opening quote has no matching closing quote".to_string(),
                range: *range,
                fix: None,
            })
            .collect()
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

    fn run(blocks: &[LintBlock]) -> Vec<Diagnostic> {
        let cfg = LintConfig::default();
        let input = LintInput {
            blocks,
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
        UnclosedQuoteRule.check(&input, &ctx)
    }

    fn block(id: u32, text: &str, off: u32) -> LintBlock {
        LintBlock {
            id,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: off,
        }
    }

    #[test]
    fn flags_dangling_quote() {
        let blocks = [
            block(0, r#"She said, "It was dark"#, 0),
            block(1, "Then silence.", 30),
        ];
        assert_eq!(run(&blocks).len(), 1);
    }

    #[test]
    fn closed_quote_ok() {
        let blocks = [block(0, r#"She said, "It was dark.""#, 0)];
        assert!(run(&blocks).is_empty());
    }

    #[test]
    fn paragraph_spanning_ok() {
        let blocks = [
            block(0, r#""A long speech that continues"#, 0),
            block(1, r#""across paragraphs," he said."#, 40),
        ];
        assert!(run(&blocks).is_empty());
    }
}
