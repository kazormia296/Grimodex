//! `ja/halfwidth-kana` — detect runs of half-width katakana and propose
//! a full-width replacement. Dakuten / handakuten (ﾞ / ﾟ) are fused with
//! the preceding base character when possible.

use regex::Regex;
use std::sync::OnceLock;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, Utf16Range,
};

static RE: OnceLock<Regex> = OnceLock::new();

fn regex() -> &'static Regex {
    // U+FF61..U+FF9F covers half-width katakana incl. punctuation (｡｢｣､ etc.)
    // We limit to U+FF65..U+FF9F to avoid flagging half-width period /
    // bracket characters that may appear legitimately in data.
    #[allow(clippy::expect_used)]
    RE.get_or_init(|| Regex::new(r"[\u{FF65}-\u{FF9F}]+").expect("static regex must compile"))
}

/// Convert a base half-width katakana char to its full-width form
/// (without applying dakuten/handakuten).
fn base_fullwidth(c: char) -> Option<char> {
    Some(match c {
        '\u{FF65}' => '・',
        '\u{FF66}' => 'ヲ',
        '\u{FF67}' => 'ァ',
        '\u{FF68}' => 'ィ',
        '\u{FF69}' => 'ゥ',
        '\u{FF6A}' => 'ェ',
        '\u{FF6B}' => 'ォ',
        '\u{FF6C}' => 'ャ',
        '\u{FF6D}' => 'ュ',
        '\u{FF6E}' => 'ョ',
        '\u{FF6F}' => 'ッ',
        '\u{FF70}' => 'ー',
        '\u{FF71}' => 'ア',
        '\u{FF72}' => 'イ',
        '\u{FF73}' => 'ウ',
        '\u{FF74}' => 'エ',
        '\u{FF75}' => 'オ',
        '\u{FF76}' => 'カ',
        '\u{FF77}' => 'キ',
        '\u{FF78}' => 'ク',
        '\u{FF79}' => 'ケ',
        '\u{FF7A}' => 'コ',
        '\u{FF7B}' => 'サ',
        '\u{FF7C}' => 'シ',
        '\u{FF7D}' => 'ス',
        '\u{FF7E}' => 'セ',
        '\u{FF7F}' => 'ソ',
        '\u{FF80}' => 'タ',
        '\u{FF81}' => 'チ',
        '\u{FF82}' => 'ツ',
        '\u{FF83}' => 'テ',
        '\u{FF84}' => 'ト',
        '\u{FF85}' => 'ナ',
        '\u{FF86}' => 'ニ',
        '\u{FF87}' => 'ヌ',
        '\u{FF88}' => 'ネ',
        '\u{FF89}' => 'ノ',
        '\u{FF8A}' => 'ハ',
        '\u{FF8B}' => 'ヒ',
        '\u{FF8C}' => 'フ',
        '\u{FF8D}' => 'ヘ',
        '\u{FF8E}' => 'ホ',
        '\u{FF8F}' => 'マ',
        '\u{FF90}' => 'ミ',
        '\u{FF91}' => 'ム',
        '\u{FF92}' => 'メ',
        '\u{FF93}' => 'モ',
        '\u{FF94}' => 'ヤ',
        '\u{FF95}' => 'ユ',
        '\u{FF96}' => 'ヨ',
        '\u{FF97}' => 'ラ',
        '\u{FF98}' => 'リ',
        '\u{FF99}' => 'ル',
        '\u{FF9A}' => 'レ',
        '\u{FF9B}' => 'ロ',
        '\u{FF9C}' => 'ワ',
        '\u{FF9D}' => 'ン',
        _ => return None,
    })
}

/// Apply dakuten to a full-width katakana base char. Returns the
/// combined char, or `None` if the base can't take dakuten.
fn apply_dakuten(c: char) -> Option<char> {
    Some(match c {
        'カ' => 'ガ',
        'キ' => 'ギ',
        'ク' => 'グ',
        'ケ' => 'ゲ',
        'コ' => 'ゴ',
        'サ' => 'ザ',
        'シ' => 'ジ',
        'ス' => 'ズ',
        'セ' => 'ゼ',
        'ソ' => 'ゾ',
        'タ' => 'ダ',
        'チ' => 'ヂ',
        'ツ' => 'ヅ',
        'テ' => 'デ',
        'ト' => 'ド',
        'ハ' => 'バ',
        'ヒ' => 'ビ',
        'フ' => 'ブ',
        'ヘ' => 'ベ',
        'ホ' => 'ボ',
        'ウ' => 'ヴ',
        _ => return None,
    })
}

fn apply_handakuten(c: char) -> Option<char> {
    Some(match c {
        'ハ' => 'パ',
        'ヒ' => 'ピ',
        'フ' => 'プ',
        'ヘ' => 'ペ',
        'ホ' => 'ポ',
        _ => return None,
    })
}

/// Convert a half-width katakana run into its full-width equivalent,
/// fusing ﾞ/ﾟ with their preceding base where possible.
pub(crate) fn to_fullwidth(run: &str) -> String {
    let mut out: Vec<char> = Vec::new();
    for c in run.chars() {
        match c {
            // Dakuten / handakuten combining marks.
            '\u{FF9E}' => {
                if let Some(prev) = out.last().copied() {
                    if let Some(composed) = apply_dakuten(prev) {
                        let last = out.len() - 1;
                        #[allow(clippy::indexing_slicing)]
                        {
                            out[last] = composed;
                        }
                        continue;
                    }
                }
                out.push('゛');
            }
            '\u{FF9F}' => {
                if let Some(prev) = out.last().copied() {
                    if let Some(composed) = apply_handakuten(prev) {
                        let last = out.len() - 1;
                        #[allow(clippy::indexing_slicing)]
                        {
                            out[last] = composed;
                        }
                        continue;
                    }
                }
                out.push('゜');
            }
            other => {
                if let Some(full) = base_fullwidth(other) {
                    out.push(full);
                } else {
                    out.push(other);
                }
            }
        }
    }
    out.into_iter().collect()
}

pub struct HalfwidthKanaRule;

impl LintRule for HalfwidthKanaRule {
    fn id(&self) -> &'static str {
        "ja/halfwidth-kana"
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
                let start = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range { start, end };
                let replacement = to_fullwidth(m.as_str());
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity,
                    message: "半角カナは全角にしてください".to_string(),
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

    #[test]
    fn converts_basic_kana() {
        assert_eq!(to_fullwidth("ｱｲｳ"), "アイウ");
    }

    #[test]
    fn fuses_dakuten() {
        assert_eq!(to_fullwidth("ｶﾞｷﾞ"), "ガギ");
    }

    #[test]
    fn fuses_handakuten() {
        assert_eq!(to_fullwidth("ﾊﾟﾋﾟ"), "パピ");
    }

    #[test]
    fn long_vowel_mark() {
        assert_eq!(to_fullwidth("ｺｰﾋｰ"), "コーヒー");
    }
}
