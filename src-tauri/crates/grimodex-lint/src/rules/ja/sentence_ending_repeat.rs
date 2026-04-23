//! `ja/sentence-ending-repeat` — flag 3+ consecutive sentences that end
//! with the same terminator character pattern (e.g. `〜た。〜た。〜た。`).
//!
//! Phase 1 heuristic (no morphology): compare the single character
//! immediately before `。`. Sentences whose ending `。` sits inside a
//! 「…」 quote are excluded — dialogue consistency is expected.
//!
//! No auto-Fix: the user must rewrite the sentences manually.

use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

const CONSEC_THRESHOLD: usize = 3;

pub struct SentenceEndingRepeatRule;

impl LintRule for SentenceEndingRepeatRule {
    fn id(&self) -> &'static str {
        "ja/sentence-ending-repeat"
    }
    fn default_severity(&self) -> Severity {
        Severity::Info
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }
    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[BlockKind::Paragraph, BlockKind::Blockquote]
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

            // Collect (sentence_start_utf16, sentence_end_utf16, ending_char)
            // for sentences whose `。` is *not* inside 「…」.
            let base = block.str_offset_start;
            let mut in_quote = false;
            let mut sentence_start_u16 = base;
            let mut prev_visible_char: Option<char> = None;
            let mut cursor_u16 = base;

            // We'll buffer candidates then scan for 3-in-a-row.
            let mut endings: Vec<(u32, u32, char)> = Vec::new();

            for ch in block.text.chars() {
                let units = ch.len_utf16() as u32;
                // Bracket tracking. Simple: only single-level 「」.
                match ch {
                    '「' => in_quote = true,
                    '」' => in_quote = false,
                    _ => {}
                }

                if ch == '。' && !in_quote {
                    if let Some(prev) = prev_visible_char {
                        let end_u16 = cursor_u16 + units;
                        endings.push((sentence_start_u16, end_u16, prev));
                    }
                    sentence_start_u16 = cursor_u16 + units;
                    prev_visible_char = None;
                    cursor_u16 = cursor_u16.saturating_add(units);
                    continue;
                }

                if !ch.is_whitespace() {
                    prev_visible_char = Some(ch);
                }
                cursor_u16 = cursor_u16.saturating_add(units);
            }

            // Scan for runs of >= CONSEC_THRESHOLD with the same ending char.
            let mut i = 0;
            while i < endings.len() {
                let Some(&(run_start, _, ending)) = endings.get(i) else {
                    break;
                };
                let mut j = i + 1;
                while let Some(&(_, _, next)) = endings.get(j) {
                    if next != ending {
                        break;
                    }
                    j += 1;
                }
                if j - i >= CONSEC_THRESHOLD {
                    let Some(&(_, run_end, _)) = endings.get(j - 1) else {
                        break;
                    };
                    out.push(Diagnostic {
                        rule_id: self.id().to_string(),
                        severity,
                        message: format!(
                            "同じ文末（「{}。」）の文が {} つ続いています",
                            ending,
                            j - i
                        ),
                        range: Utf16Range {
                            start: run_start,
                            end: run_end,
                        },
                        fix: None,
                    });
                }
                i = j.max(i + 1);
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
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "t".into(),
            },
        };
        let ctx = LintContext { config: &cfg };
        SentenceEndingRepeatRule.check(&input, &ctx)
    }

    #[test]
    fn flags_three_in_a_row() {
        let ds = run("歩いた。走った。止まった。");
        assert_eq!(ds.len(), 1);
    }

    #[test]
    fn two_in_a_row_ok() {
        assert!(run("歩いた。走った。それから立ち止まる。").is_empty());
    }

    #[test]
    fn different_endings_break_run() {
        assert!(run("歩いた。走る。止まった。").is_empty());
    }

    #[test]
    fn inside_quote_excluded() {
        // Inside a 「」 dialogue the 。 runs are not counted.
        assert!(run("「歩いた。走った。止まった。」と言った。").is_empty());
    }
}
