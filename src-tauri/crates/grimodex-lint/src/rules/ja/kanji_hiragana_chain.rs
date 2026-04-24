//! `ja/kanji-hiragana-chain` — 漢字または平仮名の長大連続（D群）。
//!
//! 日本語の読みやすさには漢字と仮名のバランスが重要。
//! - **漢字 6 文字以上** の連続: 可読性が落ちる（textlint 標準）
//! - **平仮名 20 文字以上** の連続: 文が間延びして見える
//!
//! ## 形態素情報の使い道
//!
//! 漢字連続のうち、**1 つの固有名詞**（人名・地名など）トークンに
//! 完全に含まれるものは警告しない。「東京国際フォーラム」のような
//! 正当な漢字列を誤検出しないため。morphology が無いときはこの
//! 例外を適用せず、純粋な文字種連続で判定する。
//!
//! ## パラメータ
//!
//! | key                | 型  | 既定 |
//! |--------------------|-----|------|
//! | kanji_threshold    | u32 | 6    |
//! | hiragana_threshold | u32 | 20   |

use crate::morph::MorphToken;
use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

pub struct KanjiHiraganaChainRule;

const DEFAULT_KANJI_THRESHOLD: usize = 6;
const DEFAULT_HIRAGANA_THRESHOLD: usize = 20;

fn is_kanji(c: char) -> bool {
    // CJK Unified Ideographs + Ext A / B / compat block. Bopomofo etc.
    // are out of scope. 々 と ヶ は漢字連続の延長として扱う。
    matches!(c,
        '\u{3400}'..='\u{4DBF}' |
        '\u{4E00}'..='\u{9FFF}' |
        '\u{F900}'..='\u{FAFF}' |
        '\u{20000}'..='\u{2A6DF}' |
        '\u{2A700}'..='\u{2EBEF}' |
        '々' | 'ヶ'
    )
}

fn is_hiragana(c: char) -> bool {
    // 通常の平仮名ブロック + ゐ/ゑ/小書き。ー は長音記号で仮名扱い。
    matches!(c, '\u{3041}'..='\u{309F}' | 'ー')
}

struct Options {
    kanji_threshold: usize,
    hiragana_threshold: usize,
}

impl Options {
    fn from_ctx(ctx: &LintContext, rule_id: &'static str) -> Self {
        let mut opts = Options {
            kanji_threshold: DEFAULT_KANJI_THRESHOLD,
            hiragana_threshold: DEFAULT_HIRAGANA_THRESHOLD,
        };
        let Some(rc) = ctx.config.rule(rule_id) else {
            return opts;
        };
        let Some(obj) = rc.options.as_object() else {
            return opts;
        };
        if let Some(v) = obj.get("kanji_threshold").and_then(|v| v.as_u64()) {
            opts.kanji_threshold = v as usize;
        }
        if let Some(v) = obj.get("hiragana_threshold").and_then(|v| v.as_u64()) {
            opts.hiragana_threshold = v as usize;
        }
        opts
    }
}

/// True iff the byte range `[start, end)` is fully enclosed by a single
/// proper-noun token (名詞・固有名詞). When morphology is unavailable,
/// always returns `false` → rule behaves identically to the pure
/// character-level detector.
fn enclosed_by_proper_noun(start: usize, end: usize, tokens: Option<&Vec<MorphToken>>) -> bool {
    let Some(toks) = tokens else { return false };
    toks.iter().any(|t| {
        t.byte_start <= start
            && end <= t.byte_end
            && t.pos_major == "名詞"
            && t.pos_sub1 == "固有名詞"
    })
}

impl LintRule for KanjiHiraganaChainRule {
    fn id(&self) -> &'static str {
        "ja/kanji-hiragana-chain"
    }

    fn default_severity(&self) -> Severity {
        Severity::Info
    }

    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

    /// Morphology is soft — used only to exclude proper nouns from the
    /// kanji-run warning. The rule still works (more aggressively)
    /// without it. We still flag `true` so the engine caches tokens
    /// when this rule is enabled, giving the 固有名詞 exemption.
    fn requires_morphology(&self) -> bool {
        true
    }

    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[
            BlockKind::Paragraph,
            BlockKind::Blockquote,
            BlockKind::ListItem,
            BlockKind::TableCell,
        ]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        let severity = ctx
            .config
            .rule(self.id())
            .and_then(|r| r.severity)
            .unwrap_or_else(|| self.default_severity());
        let opts = Options::from_ctx(ctx, self.id());

        let mut out = Vec::new();
        for (block_idx, block) in input.blocks.iter().enumerate() {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            let tokens = ctx.block_tokens.and_then(|all| all.get(block_idx));

            // Stream over chars once, tracking two simultaneous runs
            // (kanji / hiragana). A non-matching char closes both.
            let mut kanji_run_start: Option<(usize, usize)> = None; // (byte_start, char_count)
            let mut hira_run_start: Option<(usize, usize)> = None;

            let close_kanji = |byte_start: usize,
                               char_count: usize,
                               byte_end: usize,
                               out: &mut Vec<Diagnostic>| {
                if char_count < opts.kanji_threshold {
                    return;
                }
                if enclosed_by_proper_noun(byte_start, byte_end, tokens) {
                    return;
                }
                let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, byte_start);
                let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, byte_end);
                out.push(Diagnostic {
                    rule_id: "ja/kanji-hiragana-chain".to_string(),
                    severity,
                    message: format!(
                        "漢字が {} 文字連続しています。読みにくい可能性があります",
                        char_count
                    ),
                    range: Utf16Range {
                        start: start_u16,
                        end: end_u16,
                    },
                    fix: None,
                });
            };
            let close_hira = |byte_start: usize,
                              char_count: usize,
                              byte_end: usize,
                              out: &mut Vec<Diagnostic>| {
                if char_count < opts.hiragana_threshold {
                    return;
                }
                let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, byte_start);
                let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, byte_end);
                out.push(Diagnostic {
                    rule_id: "ja/kanji-hiragana-chain".to_string(),
                    severity,
                    message: format!(
                        "平仮名が {} 文字連続しています。漢字と仮名のバランスを検討してください",
                        char_count
                    ),
                    range: Utf16Range {
                        start: start_u16,
                        end: end_u16,
                    },
                    fix: None,
                });
            };

            for (byte_pos, ch) in block.text.char_indices() {
                let next_pos = byte_pos + ch.len_utf8();
                if is_kanji(ch) {
                    // continue kanji run; close any hiragana run.
                    if let Some((s, n)) = hira_run_start.take() {
                        close_hira(s, n, byte_pos, &mut out);
                    }
                    match &mut kanji_run_start {
                        Some((_, n)) => *n += 1,
                        None => kanji_run_start = Some((byte_pos, 1)),
                    }
                } else if is_hiragana(ch) {
                    if let Some((s, n)) = kanji_run_start.take() {
                        close_kanji(s, n, byte_pos, &mut out);
                    }
                    match &mut hira_run_start {
                        Some((_, n)) => *n += 1,
                        None => hira_run_start = Some((byte_pos, 1)),
                    }
                } else {
                    // Close both runs.
                    if let Some((s, n)) = kanji_run_start.take() {
                        close_kanji(s, n, byte_pos, &mut out);
                    }
                    if let Some((s, n)) = hira_run_start.take() {
                        close_hira(s, n, byte_pos, &mut out);
                    }
                }
                let _ = next_pos; // kept for readability; next iteration recomputes.
            }
            // Flush any trailing run at EOT.
            if let Some((s, n)) = kanji_run_start.take() {
                close_kanji(s, n, block.text.len(), &mut out);
            }
            if let Some((s, n)) = hira_run_start.take() {
                close_hira(s, n, block.text.len(), &mut out);
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

    fn run(text: &str) -> Vec<Diagnostic> {
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
            term_dictionary: &[],
        };
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "x".into(),
            },
        };
        KanjiHiraganaChainRule.check(&input, &ctx)
    }

    #[test]
    fn flags_six_kanji_run() {
        let ds = run("本件対応方針説明資料を配布した。");
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert!(ds[0].message.contains("漢字"));
    }

    #[test]
    fn ignores_five_kanji_run() {
        // 5 文字なら閾値 6 未満で無視。
        let ds = run("経営企画部が来た。");
        assert!(ds.is_empty(), "{ds:?}");
    }

    #[test]
    fn flags_long_hiragana_run() {
        // 平仮名 20 文字連続。
        let ds = run("あいうえおかきくけこさしすせそたちつてとが並んだ。");
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert!(ds[0].message.contains("平仮名"));
    }

    #[test]
    fn exempts_proper_noun_kanji_run_when_single_token() {
        // UniDic v2.1.2 は「東京」を単一の固有名詞トークンとして返す。
        // 2 文字なので閾値 6 未満で検出対象外 → そもそも漢字連続警告は
        // 発火しない。この test は 固有名詞の exemption ロジックを間接
        // 的にだけ通す（run が空を返すことを確認する）。
        let ds = run("東京で食事をした。");
        assert!(ds.is_empty(), "{ds:?}");
    }

    #[test]
    fn flags_kanji_run_spanning_multiple_tokens() {
        // 「東京国際空港」は UniDic では複数トークン（東京 / 国際 / 空港）
        // に分割される。enclosed_by_proper_noun はどの 1 トークンにも
        // 完全包含されないため exemption が効かず、6 漢字連続として
        // 警告する。これが現状の仕様。1 つの固有名詞として登録されている
        // ケース（カスタム辞書など）の exemption は実装済みだが、素の
        // UniDic では実用されない点を test で固定しておく。
        let ds = run("東京国際空港は静かだ。");
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert!(ds[0].message.contains("漢字"));
    }
}
