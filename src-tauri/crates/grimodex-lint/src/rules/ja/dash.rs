//! `ja/dash-single` — a single `—` (EM dash) is flagged; fix inserts a
//! paired `——`.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r"—+").expect("static regex must compile"))
}

pub struct DashSingleRule;

impl LintRule for DashSingleRule {
    fn id(&self) -> &'static str {
        "ja/dash-single"
    }
    fn default_severity(&self) -> Severity {
        Severity::Error
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
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
            for m in regex().find_iter(&block.text) {
                if m.as_str().chars().count() != 1 {
                    continue;
                }
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "ダッシュは 2 つ組で使います".to_string(),
                    range,
                    fix: Some(Fix {
                        label: "「——」に置き換える".to_string(),
                        replacement: "——".to_string(),
                        range,
                    }),
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
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "t".into(),
            },
        };
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None,
            term_dictionary: &[],
        };
        DashSingleRule.check(&input, &ctx)
    }

    #[test]
    fn single_dash_flagged() {
        assert_eq!(run("突然—途切れた").len(), 1);
    }

    #[test]
    fn double_dash_ok() {
        assert!(run("突然——途切れた").is_empty());
    }
}
