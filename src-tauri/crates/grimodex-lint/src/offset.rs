//! UTF-8 ↔ UTF-16 offset utilities.
//!
//! Rust `&str` indexes into UTF-8 bytes; ProseMirror / JS `String.length`
//! indexes into UTF-16 code units. The engine returns ranges in the latter.

/// Convert a UTF-8 byte offset within `s` into a UTF-16 code-unit offset.
///
/// Panics-free: if the byte offset does not align with a character boundary,
/// it is rounded down to the nearest prior boundary (matches the semantic
/// that regex matches always report char-aligned byte offsets, so this
/// branch is defensive).
pub fn utf8_to_utf16(s: &str, byte: usize) -> u32 {
    if byte == 0 {
        return 0;
    }
    let mut utf16 = 0u32;
    let mut last = 0usize;
    for (idx, ch) in s.char_indices() {
        if idx >= byte {
            last = idx;
            break;
        }
        utf16 = utf16.saturating_add(ch.len_utf16() as u32);
        last = idx + ch.len_utf8();
    }
    if last < byte {
        // consumed the whole string, `byte` was past the end
        utf16 = s.chars().map(|c| c.len_utf16() as u32).sum();
    }
    utf16
}

/// Total UTF-16 code-unit length of `s`.
pub fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
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
    fn ascii_offsets() {
        let s = "hello";
        assert_eq!(utf8_to_utf16(s, 0), 0);
        assert_eq!(utf8_to_utf16(s, 5), 5);
        assert_eq!(utf16_len(s), 5);
    }

    #[test]
    fn empty_string() {
        assert_eq!(utf8_to_utf16("", 0), 0);
        assert_eq!(utf16_len(""), 0);
    }

    #[test]
    fn cjk_characters() {
        // 日 本 語 = 3 chars, each 3 bytes in UTF-8 and 1 unit in UTF-16.
        let s = "日本語";
        assert_eq!(utf8_to_utf16(s, 0), 0);
        assert_eq!(utf8_to_utf16(s, 3), 1);
        assert_eq!(utf8_to_utf16(s, 6), 2);
        assert_eq!(utf8_to_utf16(s, 9), 3);
        assert_eq!(utf16_len(s), 3);
    }

    #[test]
    fn surrogate_pair_emoji() {
        // 🎉 = 1 char, 4 bytes UTF-8, 2 code units UTF-16 (surrogate pair).
        let s = "a🎉b";
        assert_eq!(utf8_to_utf16(s, 0), 0);
        assert_eq!(utf8_to_utf16(s, 1), 1); // before 🎉
        assert_eq!(utf8_to_utf16(s, 5), 3); // after 🎉
        assert_eq!(utf8_to_utf16(s, 6), 4); // after b
        assert_eq!(utf16_len(s), 4);
    }

    #[test]
    fn newlines_are_single_units() {
        let s = "a\nb\n";
        assert_eq!(utf16_len(s), 4);
        assert_eq!(utf8_to_utf16(s, 4), 4);
    }

    #[test]
    fn mixed_ascii_cjk_emoji() {
        let s = "ab日🎉c";
        // byte positions: a=0, b=1, 日=2..5, 🎉=5..9, c=9..10
        // utf16 positions: a=0, b=1, 日=2, 🎉=3..5 (surrogate), c=5
        assert_eq!(utf8_to_utf16(s, 0), 0);
        assert_eq!(utf8_to_utf16(s, 2), 2);
        assert_eq!(utf8_to_utf16(s, 5), 3);
        assert_eq!(utf8_to_utf16(s, 9), 5);
        assert_eq!(utf8_to_utf16(s, 10), 6);
        assert_eq!(utf16_len(s), 6);
    }

    #[test]
    fn offset_past_end_clamps() {
        let s = "ab";
        assert_eq!(utf8_to_utf16(s, 999), 2);
    }

    #[test]
    fn offset_at_char_boundary_between_multibyte() {
        // 、、 — two 3-byte chars, each 1 UTF-16 unit
        let s = "、、";
        assert_eq!(utf8_to_utf16(s, 0), 0);
        assert_eq!(utf8_to_utf16(s, 3), 1);
        assert_eq!(utf8_to_utf16(s, 6), 2);
    }
}
