//! `en/intensifiers-weasel` — flag weak intensifiers and hedges (very, really,
//! just, quite, somewhat…) that usually weaken prose. Craft-level → `info`,
//! narration-only, default OFF.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::dialogue::DialogueScope;
use crate::offset::utf8_to_utf16;
use crate::rule::{Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range};

const INTENSIFIERS: &[&str] = &[
    "very",
    "really",
    "quite",
    "rather",
    "just",
    "somewhat",
    "totally",
    "absolutely",
    "basically",
    "actually",
    "literally",
    "almost",
    "slightly",
    "simply",
    "fairly",
    "pretty",
    "truly",
    "definitely",
    "certainly",
    "essentially",
    "virtually",
    "extremely",
];

static WORD_RE: OnceLock<Regex> = OnceLock::new();
static WORD_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn word_regex() -> &'static Regex {
    WORD_RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"(?i)\b[a-z][a-z'\u{2019}]*\b").expect("static word regex must compile")
    })
}

pub struct IntensifiersWeaselRule;

impl LintRule for IntensifiersWeaselRule {
    fn id(&self) -> &'static str {
        "en/intensifiers-weasel"
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

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());
        let set = WORD_SET.get_or_init(|| INTENSIFIERS.iter().copied().collect());

        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for m in word_regex().find_iter(&block.text) {
                if !set.contains(m.as_str().to_ascii_lowercase().as_str()) {
                    continue;
                }
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!(
                        "Weak intensifier \u{201C}{}\u{201D}; consider a stronger word or cutting it",
                        m.as_str()
                    ),
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
        IntensifiersWeaselRule.check(&input, &ctx)
    }

    #[test]
    fn flags_intensifiers() {
        let ds = run("It was very cold and really dark.");
        assert_eq!(ds.len(), 2);
    }

    #[test]
    fn clean_prose_passes() {
        assert!(run("The wind cut through the empty square.").is_empty());
    }
}
