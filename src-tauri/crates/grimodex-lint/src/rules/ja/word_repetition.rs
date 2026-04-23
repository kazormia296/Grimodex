//! `ja/word-repetition` — 同語近接反復の検出（D群）。
//!
//! 近距離に同じ自立語（名詞・動詞・形容詞）が繰り返されると、
//! 文章がくどく感じられる。UniDic の **語彙素 (lemma)** で正規化して
//! 「走った」「走る」「走り」を同一視する。
//!
//! ## パラメータ
//!
//! | key            | 型    | 既定 | 役割 |
//! |----------------|-------|------|------|
//! | distance_chars | u32   | 50   | 窓（UTF-16）内に再登場したら警告 |
//! | min_length     | u32   | 2    | lemma 長がこの未満の語はスキップ |
//! | exclude        | [str] | 組込 | 追加で無視する lemma |
//!
//! 組み込みの除外 lemma:
//! - 機能語的なもの（「する」「なる」「ある」「いる」「言う」「思う」）
//! - 指示・抽象語（「こと」「もの」「これ」「それ」「あれ」）
//!
//! ## 出力
//!
//! 2 回目以降の出現ごとに Diagnostic を発行。range はその 1 語を指す。
//! 前回の出現位置は message に含める（文字オフセット）。

use std::collections::HashSet;

use crate::morph::MorphToken;
use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

pub struct WordRepetitionRule;

const DEFAULT_DISTANCE_CHARS: u32 = 50;
const DEFAULT_MIN_LEMMA_LEN: usize = 2;

/// Lemmas excluded by default. Kept short and conservative — users
/// extend via `options.exclude`. Picked from words whose repetition is
/// rarely objectionable in practice.
const BUILTIN_EXCLUDE: &[&str] = &[
    "する", "為る", "成る", "なる", "有る", "ある", "居る", "いる", "言う", "思う", "事", "こと",
    "物", "もの", "此れ", "これ", "其れ", "それ", "彼れ", "あれ",
];

struct Options {
    distance_chars: u32,
    min_length: usize,
    exclude: HashSet<String>,
}

impl Options {
    fn from_ctx(ctx: &LintContext, rule_id: &'static str) -> Self {
        let mut opts = Options {
            distance_chars: DEFAULT_DISTANCE_CHARS,
            min_length: DEFAULT_MIN_LEMMA_LEN,
            exclude: BUILTIN_EXCLUDE.iter().map(|s| (*s).to_string()).collect(),
        };
        let Some(rc) = ctx.config.rule(rule_id) else {
            return opts;
        };
        let Some(obj) = rc.options.as_object() else {
            return opts;
        };
        if let Some(v) = obj.get("distance_chars").and_then(|v| v.as_u64()) {
            opts.distance_chars = v.min(u32::MAX as u64) as u32;
        }
        if let Some(v) = obj.get("min_length").and_then(|v| v.as_u64()) {
            opts.min_length = v as usize;
        }
        if let Some(arr) = obj.get("exclude").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    opts.exclude.insert(s.to_string());
                }
            }
        }
        opts
    }
}

/// POS classes we consider meaningful content tokens. 代名詞 is excluded
/// because "彼" / "彼女" naturally repeat in narrative prose; flagging
/// those is noise.
fn is_content(t: &MorphToken) -> bool {
    // 名詞: include 普通名詞 / 固有名詞, exclude 数詞 and the sub-type
    // 非自立可能 which marks tokens like 「こと」 that work like particles.
    match t.pos_major.as_str() {
        "名詞" => !matches!(t.pos_sub1.as_str(), "数詞" | "助数詞可能" | "非自立可能"),
        "動詞" => t.pos_sub1 != "非自立可能",
        "形容詞" => t.pos_sub1 != "非自立可能",
        _ => false,
    }
}

impl LintRule for WordRepetitionRule {
    fn id(&self) -> &'static str {
        "ja/word-repetition"
    }

    fn default_severity(&self) -> Severity {
        Severity::Info
    }

    fn supported_languages(&self) -> &'static [Language] {
        &[Language::Japanese]
    }

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
        let Some(all_tokens) = ctx.block_tokens else {
            return Vec::new();
        };
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
            let Some(tokens) = all_tokens.get(block_idx) else {
                continue;
            };

            // last_seen[lemma] = (utf16 offset of end of last occurrence).
            // Using a small owned-string map keeps the implementation
            // straight forward and avoids lifetime puzzles with &str from
            // tokens we also iterate.
            let mut last_seen: std::collections::HashMap<String, u32> =
                std::collections::HashMap::new();

            for token in tokens {
                if !is_content(token) {
                    continue;
                }
                if token.lemma.is_empty() {
                    continue;
                }
                if token.lemma.chars().count() < opts.min_length {
                    continue;
                }
                if opts.exclude.contains(&token.lemma) {
                    continue;
                }

                let token_start_u16 =
                    block.str_offset_start + utf8_to_utf16(&block.text, token.byte_start);
                let token_end_u16 =
                    block.str_offset_start + utf8_to_utf16(&block.text, token.byte_end);

                if let Some(prev_end) = last_seen.get(&token.lemma).copied() {
                    // Distance measured from end-of-previous to start-of-current.
                    let distance = token_start_u16.saturating_sub(prev_end);
                    if distance <= opts.distance_chars {
                        out.push(Diagnostic {
                            rule_id: self.id().to_string(),
                            severity,
                            message: format!(
                                "「{}」が近距離で繰り返されています（直前出現から {} 文字）",
                                token.lemma, distance
                            ),
                            range: Utf16Range {
                                start: token_start_u16,
                                end: token_end_u16,
                            },
                            fix: None,
                        });
                    }
                }
                last_seen.insert(token.lemma.clone(), token_end_u16);
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
        };
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "x".into(),
            },
        };
        WordRepetitionRule.check(&input, &ctx)
    }

    #[test]
    fn flags_inflection_collapsed_repeat() {
        // 走った / 走る は lemma="走る" で一致。
        let ds = run("彼は走った。息を切らしてまだ走る。");
        assert_eq!(ds.len(), 1, "diagnostics: {ds:?}");
    }

    #[test]
    fn ignores_distant_repeat() {
        // 50 文字以上離れた繰り返しは検出しない（distance_chars 既定）。
        // テスト対象は「雪」のみ。同時に 50 文字以内で繰り返す別の語を
        // 入れないよう注意（入ると別の Diagnostic が混ざる）。
        let ds = run(
            "雪が無言で積もる。街は静まり返り、夜が深まる。誰も口をきかない時間だけが延々と続き、東の空がようやく白みはじめた。雪がまた舞う。",
        );
        let hits: Vec<_> = ds.iter().filter(|d| d.message.contains("雪")).collect();
        assert!(hits.is_empty(), "雪 flagged despite distance: {ds:?}");
    }

    #[test]
    fn excludes_high_frequency_verbs() {
        // 「する」は組み込み除外。
        let ds = run("返事をすることはできない。話をすることも。");
        let hits: Vec<_> = ds.iter().filter(|d| d.message.contains("する")).collect();
        assert!(hits.is_empty(), "する was flagged: {ds:?}");
    }
}
