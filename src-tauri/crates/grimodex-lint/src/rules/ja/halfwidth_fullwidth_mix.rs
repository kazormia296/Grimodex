//! `ja/halfwidth-fullwidth-mix` — enforce a consistent width policy for
//! ASCII alphanumerics in Japanese text.
//!
//! Phase 1 policies:
//!
//! - `"all-halfwidth"` (default): flag full-width alphanumerics
//! - `"all-fullwidth"`: flag half-width alphanumerics
//! - `"off"`: rule silent
//!
//! The `"ja-halfwidth-with-exceptions"` policy described in the design
//! document is reserved for Phase 2 — it depends on morphological
//! tokenisation to tell digits from units reliably.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE_HALF: OnceLock<Regex> = OnceLock::new();
static RE_FULL: OnceLock<Regex> = OnceLock::new();

fn re_half() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE_HALF.get_or_init(|| Regex::new(r"[A-Za-z0-9]+").expect("static regex must compile"))
}

fn re_full() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE_FULL.get_or_init(|| {
        Regex::new(r"[\u{FF10}-\u{FF19}\u{FF21}-\u{FF3A}\u{FF41}-\u{FF5A}]+")
            .expect("static regex must compile")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    AllHalfwidth,
    AllFullwidth,
    Off,
}

fn policy_from_ctx(ctx: &LintContext, rule_id: &'static str) -> Policy {
    let Some(cfg) = ctx.config.rule(rule_id) else {
        return Policy::AllHalfwidth;
    };
    match cfg.options.get("policy").and_then(|v| v.as_str()) {
        Some("all-fullwidth") => Policy::AllFullwidth,
        Some("off") => Policy::Off,
        _ => Policy::AllHalfwidth,
    }
}

fn to_halfwidth(run: &str) -> String {
    run.chars()
        .map(|c| match c as u32 {
            0xFF10..=0xFF19 => char::from_u32(c as u32 - 0xFF10 + '0' as u32).unwrap_or(c),
            0xFF21..=0xFF3A => char::from_u32(c as u32 - 0xFF21 + 'A' as u32).unwrap_or(c),
            0xFF41..=0xFF5A => char::from_u32(c as u32 - 0xFF41 + 'a' as u32).unwrap_or(c),
            _ => c,
        })
        .collect()
}

fn to_fullwidth(run: &str) -> String {
    run.chars()
        .map(|c| match c {
            '0'..='9' => char::from_u32(c as u32 - '0' as u32 + 0xFF10).unwrap_or(c),
            'A'..='Z' => char::from_u32(c as u32 - 'A' as u32 + 0xFF21).unwrap_or(c),
            'a'..='z' => char::from_u32(c as u32 - 'a' as u32 + 0xFF41).unwrap_or(c),
            _ => c,
        })
        .collect()
}

pub struct HalfwidthFullwidthMixRule;

impl LintRule for HalfwidthFullwidthMixRule {
    fn id(&self) -> &'static str {
        "ja/halfwidth-fullwidth-mix"
    }
    fn default_severity(&self) -> Severity {
        Severity::Warning
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let policy = policy_from_ctx(ctx, self.id());
        if policy == Policy::Off {
            return Vec::new();
        }
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

            let (regex, to_target): (&Regex, fn(&str) -> String) = match policy {
                Policy::AllHalfwidth => (re_full(), to_halfwidth),
                Policy::AllFullwidth => (re_half(), to_fullwidth),
                Policy::Off => continue,
            };

            for m in regex.find_iter(&block.text) {
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                let replacement = to_target(m.as_str());
                let message = match policy {
                    Policy::AllHalfwidth => "英数字は半角で統一してください",
                    Policy::AllFullwidth => "英数字は全角で統一してください",
                    Policy::Off => "",
                };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: message.to_string(),
                    range,
                    fix: Some(Fix {
                        label: format!("「{}」に置き換える", replacement),
                        replacement,
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
    use crate::rule::{BlockKind, LintBlock, LintConfig, LintScope, RuleConfig};

    fn run_with_policy(text: &str, policy: Option<&str>) -> Vec<Diagnostic> {
        let mut cfg = LintConfig::default();
        if let Some(p) = policy {
            cfg.rules.insert(
                "ja/halfwidth-fullwidth-mix".into(),
                RuleConfig {
                    enabled: true,
                    severity: None,
                    options: serde_json::json!({ "policy": p }),
                },
            );
        }
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
        };
        HalfwidthFullwidthMixRule.check(&input, &ctx)
    }

    #[test]
    fn default_policy_flags_fullwidth() {
        let ds = run_with_policy("２０２４年", None);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "2024");
    }

    #[test]
    fn all_fullwidth_flags_halfwidth() {
        let ds = run_with_policy("2024年", Some("all-fullwidth"));
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "２０２４");
    }

    #[test]
    fn off_policy_silent() {
        assert!(run_with_policy("2024年／２０２４年", Some("off")).is_empty());
    }
}
