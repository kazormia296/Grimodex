//! `en/filter-words` — flag "filter words" that distance the reader from the
//! viewpoint character (saw, heard, felt, noticed, realized…). A craft-level
//! style suggestion, so it is `info` severity, narration-only, and default OFF.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::dialogue::DialogueScope;
use crate::offset::utf8_to_utf16;
use crate::rule::{Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range};

/// Perception / cognition verbs commonly cited as filtering. Curated set with
/// the frequent inflections; deliberately not exhaustive.
const FILTER_WORDS: &[&str] = &[
    "see",
    "saw",
    "seen",
    "sees",
    "seeing",
    "hear",
    "heard",
    "hears",
    "hearing",
    "feel",
    "felt",
    "feels",
    "feeling",
    "notice",
    "noticed",
    "notices",
    "noticing",
    "realize",
    "realized",
    "realise",
    "realised",
    "realizes",
    "wonder",
    "wondered",
    "wonders",
    "wondering",
    "think",
    "thought",
    "thinks",
    "thinking",
    "know",
    "knew",
    "knows",
    "knowing",
    "watch",
    "watched",
    "watches",
    "watching",
    "seem",
    "seemed",
    "seems",
    "seeming",
    "decide",
    "decided",
    "decides",
    "remember",
    "remembered",
    "remembers",
    "remembering",
];

static WORD_RE: OnceLock<Regex> = OnceLock::new();
static WORD_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn word_regex() -> &'static Regex {
    WORD_RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"(?i)\b[a-z][a-z'\u{2019}]*\b").expect("static word regex must compile")
    })
}

pub struct FilterWordsRule;

impl LintRule for FilterWordsRule {
    fn id(&self) -> &'static str {
        "en/filter-words"
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
        let set = WORD_SET.get_or_init(|| FILTER_WORDS.iter().copied().collect());

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
                        "Filter word \u{201C}{}\u{201D} can distance the reader; consider showing the perception directly",
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
        FilterWordsRule.check(&input, &ctx)
    }

    #[test]
    fn flags_filter_words() {
        let ds = run("She saw the door and heard a sound.");
        assert_eq!(ds.len(), 2);
        assert_eq!(ds[0].severity, Severity::Info);
    }

    #[test]
    fn no_match_on_plain_prose() {
        assert!(run("The door stood open in the silent hall.").is_empty());
    }

    #[test]
    fn no_substring_match() {
        // "sawmill" must not match "saw".
        assert!(run("The sawmill closed.").is_empty());
    }
}
