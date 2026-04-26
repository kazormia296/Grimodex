//! `ja/halfwidth-fullwidth-mix` — enforce a consistent width policy for
//! ASCII alphanumerics in Japanese text.
//!
//! Policies:
//!
//! - `"all-halfwidth"` (default): flag full-width alphanumerics
//! - `"all-fullwidth"`: flag half-width alphanumerics
//! - `"ja-halfwidth-with-exceptions"` (Phase 2): half-width by default,
//!   but single-digit numbers in Japanese context should stay full-width
//!   (`１年`, not `1年`). Multi-digit full-width runs (`２０２４`) still
//!   get flagged as the standard all-halfwidth policy does.
//! - `"off"`: rule silent
//!
//! Unit symbol handling (`%`, `℃` …) is out of scope for this rule.
//! Adding a dedicated unit-width rule would be cleaner than overloading
//! this one, since the detection logic is substantially different.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintBlock, LintContext, LintInput, LintRule, Severity, Utf16Range,
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
    JaHalfwidthWithExceptions,
    Off,
}

fn policy_from_ctx(ctx: &LintContext, rule_id: &'static str) -> Policy {
    let Some(cfg) = ctx.config.rule(rule_id) else {
        return Policy::AllHalfwidth;
    };
    match cfg.options.get("policy").and_then(|v| v.as_str()) {
        Some("all-fullwidth") => Policy::AllFullwidth,
        Some("ja-halfwidth-with-exceptions") => Policy::JaHalfwidthWithExceptions,
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

/// True when the character belongs to a Japanese script block.
/// Used to decide whether an adjacent alphanumeric run is "in Japanese
/// text" for the purpose of the `with-exceptions` policy.
fn is_japanese_char(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x309F |  // Hiragana
        0x30A0..=0x30FF |  // Katakana
        0x3400..=0x4DBF |  // CJK Ext A
        0x4E00..=0x9FFF |  // CJK Unified Ideographs
        0xF900..=0xFAFF |  // CJK Compat
        0x3000..=0x303F |  // CJK Symbols and Punctuation
        0xFF00..=0xFFEF    // Halfwidth / Fullwidth forms (incl. 、。「」)
    )
}

/// True when a Japanese character sits immediately adjacent to the byte
/// range `[start, end)`. "Immediately adjacent" intentionally means the
/// single char on each side — morphological context checks are out of
/// scope for this rule.
fn has_japanese_context(text: &str, start: usize, end: usize) -> bool {
    if let Some(c) = text[..start].chars().next_back() {
        if is_japanese_char(c) {
            return true;
        }
    }
    if let Some(c) = text[end..].chars().next() {
        if is_japanese_char(c) {
            return true;
        }
    }
    false
}

/// Flag every full-width alphanumeric run, suggesting half-width.
fn check_all_halfwidth(
    block: &LintBlock,
    severity: Severity,
    rule_id: &'static str,
    out: &mut Vec<Diagnostic>,
) {
    for m in re_full().find_iter(&block.text) {
        push_diag(
            block,
            severity,
            rule_id,
            m.start(),
            m.end(),
            to_halfwidth(m.as_str()),
            "英数字は半角で統一してください",
            out,
        );
    }
}

/// Flag every half-width alphanumeric run, suggesting full-width.
fn check_all_fullwidth(
    block: &LintBlock,
    severity: Severity,
    rule_id: &'static str,
    out: &mut Vec<Diagnostic>,
) {
    for m in re_half().find_iter(&block.text) {
        push_diag(
            block,
            severity,
            rule_id,
            m.start(),
            m.end(),
            to_fullwidth(m.as_str()),
            "英数字は全角で統一してください",
            out,
        );
    }
}

/// Japanese-text-friendly policy:
///   - Full-width runs → half-width, *except* a lone full-width digit
///     sitting in Japanese context (`１年` is intentional typography).
///   - Half-width single-digit numbers in Japanese context → full-width
///     (reverse of the first rule; the design brief calls for `1年` →
///     `１年`).
///   - Everything else is left alone.
fn check_with_exceptions(
    block: &LintBlock,
    severity: Severity,
    rule_id: &'static str,
    out: &mut Vec<Diagnostic>,
) {
    let text = &block.text;
    for m in re_full().find_iter(text) {
        let run = m.as_str();
        let is_single_full_digit =
            run.chars().count() == 1 && run.chars().all(|c| matches!(c as u32, 0xFF10..=0xFF19));
        if is_single_full_digit && has_japanese_context(text, m.start(), m.end()) {
            continue;
        }
        push_diag(
            block,
            severity,
            rule_id,
            m.start(),
            m.end(),
            to_halfwidth(run),
            "英数字は半角で統一してください",
            out,
        );
    }
    for m in re_half().find_iter(text) {
        let run = m.as_str();
        let is_single_half_digit =
            run.chars().count() == 1 && run.chars().all(|c| c.is_ascii_digit());
        if !is_single_half_digit {
            continue;
        }
        if !has_japanese_context(text, m.start(), m.end()) {
            continue;
        }
        push_diag(
            block,
            severity,
            rule_id,
            m.start(),
            m.end(),
            to_fullwidth(run),
            "1 桁の数字は全角で統一してください",
            out,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn push_diag(
    block: &LintBlock,
    severity: Severity,
    rule_id: &'static str,
    byte_start: usize,
    byte_end: usize,
    replacement: String,
    message: &str,
    out: &mut Vec<Diagnostic>,
) {
    let start = block.str_offset_start + utf8_to_utf16(&block.text, byte_start);
    let end = block.str_offset_start + utf8_to_utf16(&block.text, byte_end);
    let range = Utf16Range { start, end };
    out.push(Diagnostic {
        rule_id: rule_id.to_string(),
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
            match policy {
                Policy::AllHalfwidth => check_all_halfwidth(block, severity, self.id(), &mut out),
                Policy::AllFullwidth => check_all_fullwidth(block, severity, self.id(), &mut out),
                Policy::JaHalfwidthWithExceptions => {
                    check_with_exceptions(block, severity, self.id(), &mut out);
                }
                Policy::Off => {}
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
            term_dictionary: &[],
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

    // ── with-exceptions policy ───────────────────────────────────────

    #[test]
    fn with_exceptions_exempts_single_fullwidth_digit_in_jp() {
        // Design: `１年` is the preferred form, don't flag it.
        let ds = run_with_policy("１年", Some("ja-halfwidth-with-exceptions"));
        assert!(ds.is_empty(), "{ds:?}");
    }

    #[test]
    fn with_exceptions_flags_halfwidth_single_digit_in_jp() {
        // Design: `1年` should be suggested as `１年`.
        let ds = run_with_policy("1年", Some("ja-halfwidth-with-exceptions"));
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "１");
    }

    #[test]
    fn with_exceptions_accepts_multidigit_halfwidth() {
        // `2024年` is the canonical half-width form — don't flag.
        let ds = run_with_policy("2024年", Some("ja-halfwidth-with-exceptions"));
        assert!(ds.is_empty(), "{ds:?}");
    }

    #[test]
    fn with_exceptions_flags_multidigit_fullwidth() {
        let ds = run_with_policy("２０２４年", Some("ja-halfwidth-with-exceptions"));
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "2024");
    }

    #[test]
    fn with_exceptions_does_not_touch_pure_english() {
        // No Japanese context → half-width single digit is fine.
        let ds = run_with_policy("item 1 and 2", Some("ja-halfwidth-with-exceptions"));
        assert!(ds.is_empty(), "{ds:?}");
    }

    #[test]
    fn with_exceptions_flags_lone_fullwidth_digit_without_jp_context() {
        // Without Japanese context, even a single full-width digit is
        // a convention violation.
        let ds = run_with_policy("１", Some("ja-halfwidth-with-exceptions"));
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(ds[0].fix.as_ref().unwrap().replacement, "1");
    }

    #[test]
    fn with_exceptions_accepts_mixed_ascii_word_in_jp() {
        // `HTML5` in Japanese text is a product name, leave alone.
        let ds = run_with_policy("HTML5を使う", Some("ja-halfwidth-with-exceptions"));
        assert!(ds.is_empty(), "{ds:?}");
    }
}
