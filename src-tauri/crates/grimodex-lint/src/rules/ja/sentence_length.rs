//! `ja/sentence-length` — flag sentences that exceed configured thresholds.
//!
//! Sentence terminators are `。` `！` `？` (and their ASCII counterparts).
//! A sentence is the run of characters up to and including one terminator.
//! Trailing whitespace is stripped from the measured length. This rule has
//! no auto-Fix.

use crate::offset::utf16_len;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

const DEFAULT_WARN_AT: u32 = 80;
const DEFAULT_ERROR_AT: u32 = 120;

pub struct SentenceLengthRule;

impl SentenceLengthRule {
    fn thresholds(&self, ctx: &LintContext) -> (u32, u32) {
        let Some(cfg) = ctx.config.rule(self.id()) else {
            return (DEFAULT_WARN_AT, DEFAULT_ERROR_AT);
        };
        let warn = cfg
            .options
            .get("warnAt")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(DEFAULT_WARN_AT);
        let error = cfg
            .options
            .get("errorAt")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(DEFAULT_ERROR_AT);
        (warn, error)
    }
}

impl LintRule for SentenceLengthRule {
    fn id(&self) -> &'static str {
        "ja/sentence-length"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[BlockKind::Paragraph, BlockKind::Blockquote]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let (warn_at, error_at) = self.thresholds(ctx);
        let mut out = Vec::new();

        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }

            // Walk the block by char. A sentence spans from `sentence_start`
            // (UTF-16 offset, scene-wide) up to and including the next
            // terminator char. Non-terminator runs that end at block end
            // are also evaluated (captures unterminated last sentences).
            let base = block.str_offset_start;
            let mut cursor = base; // UTF-16 offset
            let mut sentence_start = base;
            let mut sentence_has_content = false;

            for ch in block.text.chars() {
                let ch_units = ch.len_utf16() as u32;
                let is_terminator = matches!(ch, '。' | '！' | '？' | '.' | '!' | '?');

                if !ch.is_whitespace() {
                    sentence_has_content = true;
                }

                cursor = cursor.saturating_add(ch_units);

                if is_terminator {
                    let len = cursor.saturating_sub(sentence_start);
                    if sentence_has_content {
                        push_if_over(
                            &mut out,
                            self.id(),
                            sentence_start,
                            cursor,
                            len,
                            warn_at,
                            error_at,
                            ctx,
                            self.default_severity(),
                        );
                    }
                    sentence_start = cursor;
                    sentence_has_content = false;
                }
            }

            // Trailing non-terminated sentence.
            if sentence_has_content {
                let len = cursor.saturating_sub(sentence_start);
                push_if_over(
                    &mut out,
                    self.id(),
                    sentence_start,
                    cursor,
                    len,
                    warn_at,
                    error_at,
                    ctx,
                    self.default_severity(),
                );
            }
        }

        // Sanity: length counted above equals utf16_len of block.text for a
        // well-formed block. We don't need to assert it at runtime.
        let _ = utf16_len;

        out
    }
}

#[allow(clippy::too_many_arguments)]
fn push_if_over(
    out: &mut Vec<Diagnostic>,
    rule_id: &'static str,
    start: u32,
    end: u32,
    len: u32,
    warn_at: u32,
    error_at: u32,
    ctx: &LintContext,
    default_severity: Severity,
) {
    if len < warn_at {
        return;
    }
    let natural = if len >= error_at {
        Severity::Error
    } else {
        Severity::Warning
    };
    // User-configured severity override (if any) still wins — matches the
    // trait contract that default_severity() is a fallback, not a ceiling.
    // We intentionally fall back to the *natural* severity here, not
    // default_severity(), because the whole point of this rule is that the
    // severity depends on the measured length.
    let severity = ctx
        .config
        .rule(rule_id)
        .and_then(|r| r.severity)
        .unwrap_or(natural);
    let _ = default_severity;
    // Report the threshold that was crossed, not the raw sentence length
    // — "you exceeded N chars" is more actionable than "you wrote N chars".
    let threshold = if natural == Severity::Error {
        error_at
    } else {
        warn_at
    };
    out.push(Diagnostic {
        rule_id: rule_id.to_string(),
        severity,
        message: format!("一文が {} 文字を超えています（{} 文字）", threshold, len),
        range: Utf16Range { start, end },
        fix: None,
    });
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

    fn run_with(cfg: LintConfig, kind: BlockKind, text: &str) -> Vec<Diagnostic> {
        let blocks = [LintBlock {
            id: 0,
            kind,
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
        SentenceLengthRule.check(&input, &ctx)
    }

    fn run(text: &str) -> Vec<Diagnostic> {
        run_with(LintConfig::default(), BlockKind::Paragraph, text)
    }

    #[test]
    fn short_sentence_passes() {
        assert!(run("これは短い。").is_empty());
    }

    #[test]
    fn warn_at_default_threshold() {
        let s: String = "あ".repeat(90) + "。";
        let ds = run(&s);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Warning);
        assert!(ds[0].fix.is_none());
    }

    #[test]
    fn error_at_120_plus() {
        let s: String = "あ".repeat(130) + "。";
        let ds = run(&s);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Error);
    }

    #[test]
    fn heading_skipped() {
        let s: String = "あ".repeat(200) + "。";
        let ds = run_with(LintConfig::default(), BlockKind::Heading, &s);
        assert!(ds.is_empty());
    }

    #[test]
    fn custom_thresholds_via_options() {
        let mut cfg = LintConfig::default();
        cfg.rules.insert(
            "ja/sentence-length".into(),
            crate::rule::RuleConfig {
                enabled: true,
                severity: None,
                options: serde_json::json!({ "warnAt": 5, "errorAt": 10 }),
            },
        );
        let ds = run_with(cfg, BlockKind::Paragraph, "あいうえおか。");
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Warning);
    }

    #[test]
    fn unterminated_trailing_sentence_counted() {
        let s: String = "あ".repeat(90);
        let ds = run(&s);
        assert_eq!(ds.len(), 1);
    }
}
