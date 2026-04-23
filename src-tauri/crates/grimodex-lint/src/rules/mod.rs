//! All built-in lint rules, grouped by language.

pub mod ja;

use crate::rule::{Language, LintRule, RuleWarning};

/// Build the full set of built-in rules, filtered to those enabled for the
/// current input language. Phase 1 has no construction-time failure modes,
/// so the warnings vector is always empty; the signature keeps space for
/// future rules (user dictionaries etc.) that may fail to build.
pub fn build_ruleset(language: Language) -> (Vec<Box<dyn LintRule>>, Vec<RuleWarning>) {
    let mut rules: Vec<Box<dyn LintRule>> = Vec::new();
    let warnings: Vec<RuleWarning> = Vec::new();

    match language {
        Language::Japanese => {
            rules.push(Box::new(ja::consecutive_punct::ConsecutivePunctRule));
            rules.push(Box::new(ja::sentence_length::SentenceLengthRule));
        }
        Language::English => {
            // Phase 1 EN rules will plug in here in a later slice.
        }
    }

    (rules, warnings)
}
