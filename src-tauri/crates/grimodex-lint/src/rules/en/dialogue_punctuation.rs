//! `en/dialogue-punctuation` — a line of dialogue that ends in a period
//! directly before its closing quote, when a dialogue tag follows, should end
//! in a comma: `"Hello." she said` → `"Hello," she said`.
//!
//! v1 handles only this highest-value case and gates on an actual reporting
//! verb in the tag (so `"Done." He left.` — a new sentence — is left alone).
//! Capitalised-tag (`"What!" Said the man`) and tag-first
//! (`he said "hi"`) variants are deferred.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};
use crate::textscan::en::is_said_verb;

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    RE.get_or_init(|| {
        // period, a closing double quote (straight or curly), whitespace, then
        // the first one or two words of the following clause.
        #[allow(clippy::expect_used)]
        Regex::new(
            r#"\.(["\u{201D}])\s+([A-Za-z][A-Za-z'\u{2019}]*)(?:\s+([A-Za-z][A-Za-z'\u{2019}]*))?"#,
        )
        .expect("static dialogue-punctuation regex must compile")
    })
}

pub struct DialoguePunctuationRule;

impl LintRule for DialoguePunctuationRule {
    fn id(&self) -> &'static str {
        "en/dialogue-punctuation"
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
                let Some(quote) = caps.get(1) else { continue };
                let word1 = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let word2 = caps.get(3).map(|m| m.as_str()).unwrap_or("");
                // Require a reporting verb in the tag to stay high-precision.
                if !is_said_verb(word1) && !is_said_verb(word2) {
                    continue;
                }
                // Range / fix cover the period + closing quote → comma + quote.
                let Some(full) = caps.get(0) else { continue };
                let period_start = full.start();
                let quote_end = quote.end();
                let start = block.str_offset_start + utf8_to_utf16(&block.text, period_start);
                let end = block.str_offset_start + utf8_to_utf16(&block.text, quote_end);
                let range = Utf16Range { start, end };
                let replacement = format!(",{}", quote.as_str());
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "Dialogue before a tag should end with a comma, not a period"
                        .to_string(),
                    range,
                    fix: Some(Fix {
                        label: "Replace with a comma".to_string(),
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
        DialoguePunctuationRule.check(&input, &ctx)
    }

    #[test]
    fn flags_period_before_tag() {
        let ds = run(r#""Hello." she said quietly."#);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, ",\"");
    }

    #[test]
    fn flags_with_named_subject() {
        // "Tom whispered" — capitalised proper-noun subject, verb in word2.
        assert_eq!(run(r#""Go." Tom whispered."#).len(), 1);
    }

    #[test]
    fn ignores_new_sentence() {
        // No reporting verb → a genuine new sentence, leave the period.
        assert!(run(r#""Done." He walked away."#).is_empty());
    }

    #[test]
    fn ignores_question_mark() {
        // '?' before the quote is already correct with a tag.
        assert!(run(r#""What?" she asked."#).is_empty());
    }
}
