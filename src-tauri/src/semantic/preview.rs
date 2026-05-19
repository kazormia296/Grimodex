//! Semantic hit のホバープレビュー用、chunk 前後の文脈切り出し。
//!
//! `commands/semantic.rs` の `semantic_chunk_context` から呼び出される。
//! ONNX に依存しない純粋ロジックなので `semantic-embedding` feature 無しでも
//! テスト可能。長文 + hover 連打を想定して `char_indices()` 1 パスで境界を取る。

// `semantic-embedding` feature 無効ビルドでも純粋ロジックとしてテスト可能にするため、
// 唯一の利用者である commands::semantic との cfg 差で dead_code 警告が出るのを抑制する。
#![cfg_attr(not(feature = "semantic-embedding"), allow(dead_code))]

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewContext {
    pub before: String,
    pub chunk: String,
    pub after: String,
    pub scene_title: String,
}

/// `plain_text` を Unicode scalar (char) index で切り出す。
/// 境界外 index は plain_text 長で clamp する。
/// `char_start > char_end` の防御として a = min(start, end), b = end を採用する。
pub fn slice_context(
    plain_text: &str,
    char_start: usize,
    char_end: usize,
    padding: usize,
    scene_title: String,
) -> PreviewContext {
    let total_bytes = plain_text.len();
    let total_chars = plain_text.chars().count();

    let mut a = char_start.min(char_end);
    let mut b = char_end;
    a = a.min(total_chars);
    b = b.min(total_chars);
    let before_c = a.saturating_sub(padding);
    let after_c = b.saturating_add(padding).min(total_chars);

    let mut before_b: Option<usize> = None;
    let mut a_b: Option<usize> = None;
    let mut b_b: Option<usize> = None;
    let mut after_b: Option<usize> = None;

    for (i, (byte_idx, _ch)) in plain_text.char_indices().enumerate() {
        if before_b.is_none() && i == before_c {
            before_b = Some(byte_idx);
        }
        if a_b.is_none() && i == a {
            a_b = Some(byte_idx);
        }
        if b_b.is_none() && i == b {
            b_b = Some(byte_idx);
        }
        if i == after_c {
            after_b = Some(byte_idx);
            break;
        }
    }
    // char index == total_chars は char_indices で yield されないため total_bytes に倒す
    let before_b = before_b.unwrap_or(total_bytes);
    let a_b = a_b.unwrap_or(total_bytes);
    let b_b = b_b.unwrap_or(total_bytes);
    let after_b = after_b.unwrap_or(total_bytes);

    PreviewContext {
        before: plain_text[before_b..a_b].to_string(),
        chunk: plain_text[a_b..b_b].to_string(),
        after: plain_text[b_b..after_b].to_string(),
        scene_title,
    }
}

#[cfg(test)]
mod tests {
    use super::slice_context;

    #[test]
    fn ascii_text_basic_slice() {
        let text = "the quick brown fox jumps over the lazy dog";
        let ctx = slice_context(text, 10, 15, 5, "T".into());
        assert_eq!(ctx.before, "uick ");
        assert_eq!(ctx.chunk, "brown");
        assert_eq!(ctx.after, " fox ");
    }

    #[test]
    fn padding_clamps_at_start() {
        let text = "abcdef";
        let ctx = slice_context(text, 0, 2, 100, "T".into());
        assert_eq!(ctx.before, "");
        assert_eq!(ctx.chunk, "ab");
        assert_eq!(ctx.after, "cdef");
    }

    #[test]
    fn padding_clamps_at_end() {
        let text = "abcdef";
        let ctx = slice_context(text, 4, 6, 100, "T".into());
        assert_eq!(ctx.before, "abcd");
        assert_eq!(ctx.chunk, "ef");
        assert_eq!(ctx.after, "");
    }

    #[test]
    fn multibyte_japanese_text() {
        // 各文字が 3 バイト。chars().nth() に頼らず正しい境界が取れることを確認。
        let text = "あいうえおかきくけこ"; // 10 chars
        let ctx = slice_context(text, 3, 6, 2, "T".into());
        assert_eq!(ctx.before, "いう");
        assert_eq!(ctx.chunk, "えおか");
        assert_eq!(ctx.after, "きく");
    }

    #[test]
    fn empty_plain_text_returns_all_empty_strings() {
        let ctx = slice_context("", 0, 0, 100, "T".into());
        assert_eq!(ctx.before, "");
        assert_eq!(ctx.chunk, "");
        assert_eq!(ctx.after, "");
        assert_eq!(ctx.scene_title, "T");
    }

    #[test]
    fn char_indices_beyond_total_clamp_to_end() {
        let text = "あいうえお"; // 5 chars
        let ctx = slice_context(text, 10, 20, 2, "T".into());
        assert_eq!(ctx.before, "えお");
        assert_eq!(ctx.chunk, "");
        assert_eq!(ctx.after, "");
    }

    #[test]
    fn swapped_start_end_does_not_panic_and_clamps() {
        // start > end の場合: a = min(4, 2) = 2, b = end = 2 (clamped)
        // → chunk は空、before は char[1..2]、after は char[2..3]
        let text = "abcdef";
        let ctx = slice_context(text, 4, 2, 1, "T".into());
        assert_eq!(ctx.before, "b");
        assert_eq!(ctx.chunk, "");
        assert_eq!(ctx.after, "c");
    }

    #[test]
    fn zero_padding_returns_only_chunk() {
        let text = "abcdef";
        let ctx = slice_context(text, 2, 4, 0, "T".into());
        assert_eq!(ctx.before, "");
        assert_eq!(ctx.chunk, "cd");
        assert_eq!(ctx.after, "");
    }
}
