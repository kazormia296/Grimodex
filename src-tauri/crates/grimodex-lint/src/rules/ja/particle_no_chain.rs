//! `ja/particle-no-chain` — warn on chained 「の」 particles.
//!
//! 「私の友人の家の鍵」 のような 「〜の〜の〜の〜」 構文を、
//! 格助詞「の」が **3 つ以上** 連続する場合に警告する。
//! 閾値は `options.threshold` で設定可能。
//!
//! Depends on UniDic morphology — detects particles via
//! `pos_major == "助詞"` && `pos_sub1 == "格助詞"` && `lemma == "の"`,
//! anchored to content tokens (名詞 / 代名詞 / 形状詞).

use crate::morph::MorphToken;
use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

pub struct ParticleNoChainRule;

const DEFAULT_THRESHOLD: usize = 3;

fn is_no_particle(t: &MorphToken) -> bool {
    t.pos_major == "助詞" && t.pos_sub1 == "格助詞" && t.lemma == "の"
}

fn is_content(t: &MorphToken) -> bool {
    matches!(
        t.pos_major.as_str(),
        "名詞" | "代名詞" | "形状詞" | "接頭辞"
    )
}

fn threshold_from_ctx(ctx: &LintContext, rule_id: &'static str) -> usize {
    let Some(rc) = ctx.config.rule(rule_id) else {
        return DEFAULT_THRESHOLD;
    };
    let Some(obj) = rc.options.as_object() else {
        return DEFAULT_THRESHOLD;
    };
    match obj.get("threshold").and_then(|v| v.as_u64()) {
        // Minimum sensible threshold is 2 (one chain = the single 「〜の」).
        Some(n) if n >= 2 => n as usize,
        _ => DEFAULT_THRESHOLD,
    }
}

impl LintRule for ParticleNoChainRule {
    fn id(&self) -> &'static str {
        "ja/particle-no-chain"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

    fn requires_morphology(&self) -> bool {
        true
    }

    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        // Heading は短文なので連鎖が発生しにくいが、ブロック種別で
        // 事前に除外する強い理由もない。将来調整可能。
        &[
            BlockKind::Paragraph,
            BlockKind::Blockquote,
            BlockKind::ListItem,
            BlockKind::TableCell,
        ]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let Some(all_tokens) = ctx.block_tokens else {
            return Vec::new();
        };

        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());
        let threshold = threshold_from_ctx(ctx, self.id());

        let mut out = Vec::new();
        for (block_idx, block) in input.blocks.iter().enumerate() {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            let Some(tokens) = all_tokens.get(block_idx) else {
                continue;
            };
            if tokens.len() < 3 {
                continue;
            }

            let mut i = 0;
            while i < tokens.len() {
                // Each chain starts at the first "の" that is preceded by
                // a content token. Walk alternating (content, の, content,
                // の, ...) from there.
                let Some(token_i) = tokens.get(i) else {
                    break;
                };
                if !is_no_particle(token_i) || i == 0 {
                    i += 1;
                    continue;
                }
                let Some(prev) = tokens.get(i - 1) else {
                    i += 1;
                    continue;
                };
                if !is_content(prev) {
                    i += 1;
                    continue;
                }

                // j walks forward to find the end of the alternation.
                // Invariant: tokens[j] is a counted "の" particle.
                let mut chain_count = 1usize;
                let mut j = i;
                while j + 2 < tokens.len() {
                    // Safe indexing below: bounds checked above.
                    let (Some(next_content), Some(next_no)) =
                        (tokens.get(j + 1), tokens.get(j + 2))
                    else {
                        break;
                    };
                    if is_content(next_content) && is_no_particle(next_no) {
                        chain_count += 1;
                        j += 2;
                    } else {
                        break;
                    }
                }

                if chain_count >= threshold {
                    // Range: from the content token preceding the first の
                    // through the trailing content token (if present) or
                    // the last の otherwise.
                    let start_byte = prev.byte_start;
                    let tail_idx = if let Some(tail) = tokens.get(j + 1).filter(|t| is_content(t)) {
                        Some(tail)
                    } else {
                        tokens.get(j)
                    };
                    let Some(tail) = tail_idx else {
                        i = j + 1;
                        continue;
                    };
                    let end_byte = tail.byte_end;
                    let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, start_byte);
                    let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, end_byte);

                    out.push(Diagnostic {
                        rule_id: self.id().to_string(),
                        severity,
                        message: format!(
                            "「の」が {} 回連続しています。言い換えを検討してください",
                            chain_count
                        ),
                        range: Utf16Range {
                            start: start_u16,
                            end: end_u16,
                        },
                        fix: None,
                    });

                    // Skip past the consumed chain so overlapping runs aren't double-reported.
                    i = j + 2;
                } else {
                    i += 1;
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
    use crate::morph::tokenize_blocks;
    use crate::rule::{BlockKind, Diagnostic, Language, LintBlock, LintConfig, LintScope};

    fn run_with_text(text: &str) -> Vec<Diagnostic> {
        let blocks = vec![LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: 0,
        }];
        let tokens = tokenize_blocks(&blocks).expect("tokenize");
        let cfg = LintConfig::default();
        let ctx = LintContext {
            config: &cfg,
            block_tokens: Some(&tokens),
        };
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "x".into(),
            },
        };
        ParticleNoChainRule.check(&input, &ctx)
    }

    #[test]
    fn flags_three_no_chain() {
        let ds = run_with_text("私の友人の家の鍵が見つからない。");
        assert_eq!(ds.len(), 1, "diagnostics: {ds:?}");
    }

    #[test]
    fn ignores_two_no() {
        let ds = run_with_text("私の友人の家を訪ねた。");
        assert!(ds.is_empty(), "unexpected diagnostics: {ds:?}");
    }

    #[test]
    fn flags_four_no_chain() {
        let ds = run_with_text("母の実家の庭の桜の枝が揺れている。");
        assert_eq!(ds.len(), 1);
    }
}
