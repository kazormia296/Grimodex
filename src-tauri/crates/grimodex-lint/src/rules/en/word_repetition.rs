//! `en/word-repetition` — flag a content word repeated within a sliding window
//! of words (echoes that a reader notices). Stop words are ignored. The later
//! occurrence is flagged. Narration-only, `info`, default OFF.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::dialogue::DialogueScope;
use crate::offset::utf8_to_utf16;
use crate::rule::{Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range};

const DEFAULT_DISTANCE_WORDS: usize = 30;
const DEFAULT_MIN_LENGTH: usize = 4;

/// Common function words excluded from repetition checks regardless of length.
const STOP_WORDS: &[&str] = &[
    "the", "and", "that", "with", "this", "from", "they", "them", "then", "there", "their", "have",
    "has", "had", "was", "were", "been", "being", "are", "for", "but", "not", "you", "your", "his",
    "her", "she", "him", "out", "into", "over", "than", "what", "when", "which", "would", "could",
    "should", "about", "after", "before", "where",
];

static WORD_RE: OnceLock<Regex> = OnceLock::new();
static STOP_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn word_regex() -> &'static Regex {
    WORD_RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"(?i)\b[a-z][a-z'\u{2019}]*\b").expect("static word regex must compile")
    })
}

pub struct WordRepetitionRule;

impl WordRepetitionRule {
    fn params(&self, ctx: &LintContext) -> (usize, usize) {
        let Some(cfg) = ctx.config.rule(self.id()) else {
            return (DEFAULT_DISTANCE_WORDS, DEFAULT_MIN_LENGTH);
        };
        let dist = cfg
            .options
            .get("distance_words")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_DISTANCE_WORDS);
        let min = cfg
            .options
            .get("min_length")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_MIN_LENGTH);
        (dist, min)
    }
}

impl LintRule for WordRepetitionRule {
    fn id(&self) -> &'static str {
        "en/word-repetition"
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
        let (distance, min_len) = self.params(ctx);
        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());
        let stop = STOP_SET.get_or_init(|| STOP_WORDS.iter().copied().collect());

        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            // Map of content word → most recent word index seen.
            let mut last_seen: HashMap<String, usize> = HashMap::new();
            for (word_index, m) in word_regex().find_iter(&block.text).enumerate() {
                let lower = m.as_str().to_ascii_lowercase();
                let is_content = lower.chars().count() >= min_len && !stop.contains(lower.as_str());
                if is_content {
                    let key = crate::stem::stem_en(&lower);
                    if let Some(&prev) = last_seen.get(&key) {
                        if word_index - prev <= distance {
                            let start =
                                block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                            let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                            out.push(Diagnostic {
                                rule_id: self.id().to_string(),
                                severity,
                                message: format!(
                                    "\u{201C}{}\u{201D} repeats within {} words",
                                    m.as_str(),
                                    distance
                                ),
                                range: Utf16Range { start, end },
                                fix: None,
                            });
                        }
                    }
                    last_seen.insert(key, word_index);
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
        WordRepetitionRule.check(&input, &ctx)
    }

    #[test]
    fn flags_nearby_repeat() {
        let ds = run("The shadow moved across the shadow of the wall.");
        assert_eq!(ds.len(), 1);
    }

    #[test]
    fn flags_inflected_repeat_via_stem() {
        // "studies" and "study" share a stem; surface-form matching would miss it.
        let ds = run("She studies the map; a careful study of the realm.");
        assert_eq!(ds.len(), 1);
    }

    #[test]
    fn distinct_lemmas_do_not_collapse() {
        // Guards the stemmed key against over-folding: "shadow" and "shatter"
        // are different lemmas (distinct stems), so neither is a repeat.
        let ds = run("The shadow fell as the glass began to shatter.");
        assert!(ds.is_empty());
    }

    #[test]
    fn ignores_stop_words() {
        assert!(run("the cat and the dog and the bird").is_empty());
    }

    #[test]
    fn ignores_short_words() {
        // "ran" is below the default min length of 4.
        assert!(run("he ran and ran").is_empty());
    }

    #[test]
    fn distance_window_respected() {
        let mut cfg = LintConfig::default();
        cfg.rules.insert(
            "en/word-repetition".into(),
            crate::rule::RuleConfig {
                enabled: true,
                severity: None,
                options: serde_json::json!({ "distance_words": 2, "min_length": 4 }),
            },
        );
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "shadow alpha beta gamma delta shadow".to_string(),
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
        // 5 words apart, window of 2 → not flagged.
        assert!(WordRepetitionRule.check(&input, &ctx).is_empty());
    }
}
