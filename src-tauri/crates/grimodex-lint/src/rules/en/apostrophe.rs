//! `en/apostrophe` — flag a straight ASCII apostrophe (`'`) used inside a word
//! (contractions and possessives like `don't`, `it's`, `o'clock`) and suggest
//! the typographic apostrophe `’`.
//!
//! Only the unambiguous word-internal case (alphanumeric on both sides) is
//! handled. Word-initial elisions (`'em`, `'cause`, `'90s`) and plural
//! possessives at a word boundary (`the dogs'`) collide with single-quote
//! usage and are deferred; `en/straight-quotes` owns paired double quotes.

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

pub struct ApostropheRule;

impl LintRule for ApostropheRule {
    fn id(&self) -> &'static str {
        "en/apostrophe"
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
            let mut prev: Option<char> = None;
            let mut it = block.text.char_indices().peekable();
            while let Some((i, c)) = it.next() {
                if c == '\'' {
                    let next = it.peek().map(|&(_, nc)| nc);
                    let between_alnum = prev.map(|p| p.is_alphanumeric()).unwrap_or(false)
                        && next.map(|n| n.is_alphanumeric()).unwrap_or(false);
                    if between_alnum {
                        let start = block.str_offset_start + utf8_to_utf16(&block.text, i);
                        // The ASCII apostrophe is one UTF-16 code unit.
                        let range = Utf16Range {
                            start,
                            end: start + 1,
                        };
                        out.push(Diagnostic {
                            rule_id: self.id().to_string(),
                            severity,
                            message: "Use a typographic apostrophe (\u{2019}) in contractions and possessives".to_string(),
                            range,
                            fix: Some(Fix {
                                label: "Replace with \u{2019}".to_string(),
                                replacement: "\u{2019}".to_string(),
                                range,
                            }),
                        });
                    }
                }
                prev = Some(c);
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
        ApostropheRule.check(&input, &ctx)
    }

    #[test]
    fn flags_contraction() {
        let ds = run("I don't think it's fine.");
        assert_eq!(ds.len(), 2);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "\u{2019}");
    }

    #[test]
    fn flags_oclock_and_internal() {
        assert_eq!(run("at six o'clock").len(), 1);
    }

    #[test]
    fn ignores_single_quoted_word() {
        // Opening/closing single quotes around a word are not word-internal.
        assert!(run("she said 'maybe' softly").is_empty());
    }

    #[test]
    fn offset_is_correct() {
        // "a'b" → apostrophe at utf16 index 1.
        let ds = run("a'b");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].range.start, 1);
        assert_eq!(ds[0].range.end, 2);
    }
}
