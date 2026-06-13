//! `en/adverb-ly` — flag `-ly` adverbs, whose overuse is a common prose smell.
//! A curated exclusion list removes the many non-adverbs that end in `-ly`
//! (only, family, ugly, friendly…). Craft-level → `info`, narration-only,
//! default OFF.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::dialogue::DialogueScope;
use crate::offset::utf8_to_utf16;
use crate::rule::{Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range};

/// Words ending in `-ly` that are not adverbs (adjectives, nouns, verbs).
const NOT_ADVERBS: &[&str] = &[
    "only",
    "family",
    "ally",
    "rally",
    "bully",
    "jelly",
    "belly",
    "holy",
    "italy",
    "july",
    "supply",
    "reply",
    "apply",
    "multiply",
    "imply",
    "comply",
    "rely",
    "lily",
    "ugly",
    "early",
    "likely",
    "lonely",
    "lovely",
    "friendly",
    "daily",
    "silly",
    "jolly",
    "folly",
    "lively",
    "lowly",
    "homely",
    "costly",
    "deadly",
    "cowardly",
    "elderly",
    "orderly",
    "motherly",
    "fatherly",
    "brotherly",
    "sisterly",
    "heavenly",
    "timely",
    "manly",
    "womanly",
    "worldly",
    "weekly",
    "monthly",
    "yearly",
    "hourly",
    "kingly",
    "godly",
    "burly",
    "curly",
    "surly",
    "melancholy",
    "anomaly",
    "assembly",
    "monopoly",
    "panoply",
    "wobbly",
    "bubbly",
    "crumbly",
];

static RE: OnceLock<Regex> = OnceLock::new();
static EXCLUDE: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn regex() -> &'static Regex {
    RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"(?i)\b[a-z]{3,}ly\b").expect("static adverb-ly regex must compile")
    })
}

pub struct AdverbLyRule;

impl LintRule for AdverbLyRule {
    fn id(&self) -> &'static str {
        "en/adverb-ly"
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
        let exclude = EXCLUDE.get_or_init(|| NOT_ADVERBS.iter().copied().collect());

        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for m in regex().find_iter(&block.text) {
                if exclude.contains(m.as_str().to_ascii_lowercase().as_str()) {
                    continue;
                }
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: format!(
                        "Adverb \u{201C}{}\u{201D}; a stronger verb is often better than verb + -ly",
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
        AdverbLyRule.check(&input, &ctx)
    }

    #[test]
    fn flags_adverbs() {
        let ds = run("She walked quietly and spoke softly.");
        assert_eq!(ds.len(), 2);
    }

    #[test]
    fn excludes_non_adverbs() {
        // only, family, ugly, early are excluded.
        assert!(run("The only early family looked ugly.").is_empty());
    }
}
