//! `ja/quote-period` — normalise punctuation inside Japanese `「…」`
//! quotes. Behaviour is controlled by the `policy` option:
//!
//! - `"strip"` (default): `「～。」` → `「～」` — remove the final `。`
//! - `"require"`: add a trailing `。` when missing (novels with that
//!   house style, or stage-play variants)
//! - `"preserve"`: rule is silent
//!
//! Only the final `」` of a quoted span is inspected. Nested quotes (`『』`)
//! are out of scope for Phase 1.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r"「([^「」]*)」").expect("static regex must compile"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    Strip,
    Require,
    Preserve,
}

fn policy_from_ctx(ctx: &LintContext, rule_id: &'static str) -> Policy {
    let Some(cfg) = ctx.config.rule(rule_id) else {
        return Policy::Strip;
    };
    match cfg.options.get("policy").and_then(|v| v.as_str()) {
        Some("require") => Policy::Require,
        Some("preserve") => Policy::Preserve,
        _ => Policy::Strip,
    }
}

pub struct QuotePeriodRule;

impl LintRule for QuotePeriodRule {
    fn id(&self) -> &'static str {
        "ja/quote-period"
    }
    fn default_severity(&self) -> Severity {
        Severity::Info
    }
    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let policy = policy_from_ctx(ctx, self.id());
        if policy == Policy::Preserve {
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
            for caps in regex().captures_iter(&block.text) {
                let Some(full_m) = caps.get(0) else { continue };
                let Some(inner_m) = caps.get(1) else { continue };

                // Close-quote byte offset is full_m.end() - len("」") = -3.
                let close_byte = full_m.end().saturating_sub('」'.len_utf8());

                match policy {
                    Policy::Strip => {
                        // Inner text must end with 。
                        if !inner_m.as_str().ends_with('。') {
                            continue;
                        }
                        // Range: the lone trailing 。 right before 」.
                        let period_start_byte =
                            close_byte.saturating_sub('。'.len_utf8());
                        let start = block.str_offset_start
                            + utf8_to_utf16(&block.text, period_start_byte);
                        let end = block.str_offset_start
                            + utf8_to_utf16(&block.text, close_byte);
                        let range = Utf16Range { start, end };
                        out.push(Diagnostic {
                            rule_id: self.id().to_string(),
                            severity,
                            message: "カギ括弧内末尾の句点を削除してください".to_string(),
                            range,
                            fix: Some(Fix {
                                label: "句点を削除".to_string(),
                                replacement: String::new(),
                                range,
                            }),
                        });
                    }
                    Policy::Require => {
                        let inner = inner_m.as_str();
                        if inner.is_empty() {
                            continue;
                        }
                        // Last char already a sentence terminator → pass.
                        let last = inner.chars().next_back();
                        if matches!(last, Some('。') | Some('！') | Some('？')) {
                            continue;
                        }
                        // Avoid fighting commas — allow 、 as a non-target
                        // (user likely put a comma intentionally). Still
                        // flag plain trailing chars without terminator.
                        if matches!(last, Some('、')) {
                            continue;
                        }
                        let start = block.str_offset_start
                            + utf8_to_utf16(&block.text, close_byte);
                        let end = start; // zero-width insertion point
                        let range = Utf16Range { start, end };
                        // Fix range is the same zero-width point —
                        // replacement inserts `。` before `」`.
                        out.push(Diagnostic {
                            rule_id: self.id().to_string(),
                            severity,
                            message: "カギ括弧内末尾に句点を付与してください".to_string(),
                            range,
                            fix: Some(Fix {
                                label: "句点を挿入".to_string(),
                                replacement: "。".to_string(),
                                range,
                            }),
                        });
                    }
                    Policy::Preserve => {}
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
    use crate::rule::{BlockKind, LintBlock, LintConfig, LintScope, RuleConfig};

    fn run_with_policy(text: &str, policy: Option<&str>) -> Vec<Diagnostic> {
        let mut cfg = LintConfig::default();
        if let Some(p) = policy {
            cfg.rules.insert(
                "ja/quote-period".into(),
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
        let ctx = LintContext { config: &cfg };
        QuotePeriodRule.check(&input, &ctx)
    }

    #[test]
    fn strip_detects_trailing_period() {
        let ds = run_with_policy("「こんにちは。」", None);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "");
    }

    #[test]
    fn strip_silent_when_no_period() {
        assert!(run_with_policy("「こんにちは」", None).is_empty());
    }

    #[test]
    fn preserve_is_silent() {
        assert!(run_with_policy("「こんにちは。」", Some("preserve")).is_empty());
    }

    #[test]
    fn require_adds_when_missing() {
        let ds = run_with_policy("「こんにちは」", Some("require"));
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "。");
    }

    #[test]
    fn require_silent_when_terminator_present() {
        assert!(run_with_policy("「本当？」", Some("require")).is_empty());
        assert!(run_with_policy("「来い！」", Some("require")).is_empty());
    }
}
