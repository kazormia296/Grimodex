//! All built-in lint rules, grouped by language / theme.

pub mod codex;
pub mod en;
pub mod ja;
pub mod project;

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
            rules.push(Box::new(ja::dash::DashSingleRule));
            rules.push(Box::new(ja::ellipsis::EllipsisSingleRule));
            rules.push(Box::new(ja::ellipsis::EllipsisOddRule));
            rules.push(Box::new(
                ja::halfwidth_fullwidth_mix::HalfwidthFullwidthMixRule,
            ));
            rules.push(Box::new(ja::halfwidth_kana::HalfwidthKanaRule));
            rules.push(Box::new(ja::kanji_hiragana_chain::KanjiHiraganaChainRule));
            rules.push(Box::new(ja::particle_no_chain::ParticleNoChainRule));
            rules.push(Box::new(ja::quote_period::QuotePeriodRule));
            rules.push(Box::new(ja::redundant_expression::RedundantExpressionRule));
            rules.push(Box::new(
                ja::sentence_ending_repeat::SentenceEndingRepeatRule,
            ));
            rules.push(Box::new(ja::sentence_length::SentenceLengthRule));
            rules.push(Box::new(ja::typo_confusable::TypoConfusableRule));
            rules.push(Box::new(ja::word_repetition::WordRepetitionRule));
            // Codex-linked rules are language-agnostic but registered
            // here so they run on Japanese scenes by default.
            rules.push(Box::new(codex::name_inconsistency::NameInconsistencyRule));
            rules.push(Box::new(project::term_consistency::TermConsistencyRule));
        }
        Language::English => {
            rules.push(Box::new(en::double_space::DoubleSpaceRule));
            rules.push(Box::new(en::ellipsis::EllipsisRule));
            rules.push(Box::new(en::em_dash::EmDashRule));
            rules.push(Box::new(en::straight_quotes::StraightQuotesRule));
            rules.push(Box::new(codex::name_inconsistency::NameInconsistencyRule));
            rules.push(Box::new(project::term_consistency::TermConsistencyRule));
        }
    }

    (rules, warnings)
}
