//! `en/sentence-starters` — flag runs of consecutive sentences that open with
//! the same word (a monotony smell, e.g. several sentences in a row starting
//! with "She"). Narration-only, `info`, default OFF.

use std::sync::OnceLock;

use regex::Regex;

use crate::dialogue::DialogueScope;
use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};
use crate::textscan::en::sentence_ranges_en;

const DEFAULT_THRESHOLD: usize = 3;

static WORD_RE: OnceLock<Regex> = OnceLock::new();

fn word_regex() -> &'static Regex {
    WORD_RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"[A-Za-z][A-Za-z'\u{2019}]*").expect("static word regex must compile")
    })
}

pub struct SentenceStartersRule;

impl SentenceStartersRule {
    fn threshold(&self, ctx: &LintContext) -> usize {
        ctx.config
            .rule(self.id())
            .and_then(|c| c.options.get("threshold"))
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_THRESHOLD)
            .max(2)
    }
}

impl LintRule for SentenceStartersRule {
    fn id(&self) -> &'static str {
        "en/sentence-starters"
    }
    fn default_severity(&self) -> Severity {
        Severity::Info
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
        let threshold = self.threshold(ctx);
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
            let mut prev: Option<String> = None;
            let mut run_len: usize = 0;
            for range in sentence_ranges_en(&block.text) {
                let Some(slice) = block.text.get(range.clone()) else {
                    continue;
                };
                let Some(m) = word_regex().find(slice) else {
                    prev = None;
                    run_len = 0;
                    continue;
                };
                let lower = m.as_str().to_ascii_lowercase();
                if prev.as_deref() == Some(lower.as_str()) {
                    run_len += 1;
                } else {
                    run_len = 1;
                    prev = Some(lower.clone());
                }
                if run_len >= threshold {
                    let word_start_byte = range.start + m.start();
                    let word_end_byte = range.start + m.end();
                    let start =
                        block.str_offset_start + utf8_to_utf16(&block.text, word_start_byte);
                    let end = block.str_offset_start + utf8_to_utf16(&block.text, word_end_byte);
                    out.push(Diagnostic {
                        rule_id: self.id().to_string(),
                        severity,
                        message: format!(
                            "{} sentences in a row begin with \u{201C}{}\u{201D}",
                            run_len,
                            m.as_str()
                        ),
                        range: Utf16Range { start, end },
                        fix: None,
                    });
                }
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
        SentenceStartersRule.check(&input, &ctx)
    }

    #[test]
    fn flags_third_in_a_row() {
        // Three sentences starting with "She" → flag the third.
        let ds = run("She ran. She stopped. She turned.");
        assert_eq!(ds.len(), 1);
    }

    #[test]
    fn varied_starts_pass() {
        assert!(run("She ran. He stopped. They turned.").is_empty());
    }

    #[test]
    fn run_of_four_flags_two() {
        let ds = run("She ran. She stopped. She turned. She fell.");
        assert_eq!(ds.len(), 2);
    }
}
