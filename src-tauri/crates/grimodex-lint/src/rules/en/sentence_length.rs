//! `en/sentence-length` — flag sentences that exceed a word-count threshold.
//! English measures length in words, not characters. Narration-only (dialogue
//! is often deliberately long or fragmentary) and default ON.

use crate::dialogue::DialogueScope;
use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};
use crate::textscan::en::sentence_ranges_en;

const DEFAULT_WARN_AT: u32 = 35;
const DEFAULT_ERROR_AT: u32 = 60;

pub struct SentenceLengthRule;

impl SentenceLengthRule {
    fn thresholds(&self, ctx: &LintContext) -> (u32, u32) {
        let Some(cfg) = ctx.config.rule(self.id()) else {
            return (DEFAULT_WARN_AT, DEFAULT_ERROR_AT);
        };
        let warn = cfg
            .options
            .get("warnAtWords")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(DEFAULT_WARN_AT);
        let error = cfg
            .options
            .get("errorAtWords")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(DEFAULT_ERROR_AT);
        (warn, error)
    }
}

/// Count words: whitespace-separated runs containing at least one alphanumeric.
fn word_count(text: &str) -> u32 {
    text.split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .count() as u32
}

impl LintRule for SentenceLengthRule {
    fn id(&self) -> &'static str {
        "en/sentence-length"
    }
    fn default_severity(&self) -> Severity {
        Severity::Warning
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::English]
    }
    fn dialogue_scope(&self) -> DialogueScope {
        DialogueScope::NarrationOnly
    }
    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[BlockKind::Paragraph, BlockKind::Blockquote]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let (warn_at, error_at) = self.thresholds(ctx);
        let mut out = Vec::new();

        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for range in sentence_ranges_en(&block.text) {
                let Some(slice) = block.text.get(range.clone()) else {
                    continue;
                };
                let words = word_count(slice);
                if words < warn_at {
                    continue;
                }
                let natural = if words >= error_at {
                    Severity::Error
                } else {
                    Severity::Warning
                };
                let severity = ctx
                    .config
                    .rule(self.id())
                    .and_then(|r| r.severity)
                    .unwrap_or(natural);
                let threshold = if natural == Severity::Error {
                    error_at
                } else {
                    warn_at
                };
                let start = block.str_offset_start + utf8_to_utf16(&block.text, range.start);
                let end = block.str_offset_start + utf8_to_utf16(&block.text, range.end);
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!("Sentence exceeds {} words ({} words)", threshold, words),
                    range: Utf16Range { start, end },
                    fix: None,
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

    fn run_with(cfg: LintConfig, text: &str) -> Vec<Diagnostic> {
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
        SentenceLengthRule.check(&input, &ctx)
    }

    fn run(text: &str) -> Vec<Diagnostic> {
        run_with(LintConfig::default(), text)
    }

    #[test]
    fn short_sentence_passes() {
        assert!(run("The cat sat on the mat.").is_empty());
    }

    #[test]
    fn long_sentence_warns() {
        let long = "word ".repeat(40) + "end.";
        let ds = run(&long);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Warning);
    }

    #[test]
    fn very_long_sentence_errors() {
        let long = "word ".repeat(65) + "end.";
        let ds = run(&long);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Error);
    }

    #[test]
    fn custom_thresholds() {
        let mut cfg = LintConfig::default();
        cfg.rules.insert(
            "en/sentence-length".into(),
            crate::rule::RuleConfig {
                enabled: true,
                severity: None,
                options: serde_json::json!({ "warnAtWords": 3, "errorAtWords": 6 }),
            },
        );
        let ds = run_with(cfg, "one two three four.");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Warning);
    }
}
