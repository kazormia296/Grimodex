//! Bunsetsu (文節) segmentation from UniDic morph tokens.
//!
//! Returns UTF-16 code-unit ranges aligned with the frontend flat text contract.

use crate::morph::{tokenize_block, MorphToken};
use crate::offset::{utf16_len, utf8_to_utf16};

/// One bunsetsu chunk for IPC / tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BunsetsuChunk {
    pub start: u32,
    pub end: u32,
    pub surface: String,
}

/// Independent word POS majors that start a new bunsetsu (unless previous is 接頭辞).
const INDEPENDENT_MAJORS: &[&str] = &[
    "名詞",
    "代名詞",
    "動詞",
    "形容詞",
    "形状詞",
    "副詞",
    "連体詞",
    "接続詞",
    "感動詞",
];

/// POS that attach to the previous bunsetsu.
const DEPENDENT_MAJORS: &[&str] = &["助詞", "助動詞", "接尾辞", "補助記号", "記号", "空白"];

fn is_independent_major(pos_major: &str) -> bool {
    INDEPENDENT_MAJORS.contains(&pos_major) || pos_major == "接頭辞"
}

fn is_dependent_major(pos_major: &str) -> bool {
    DEPENDENT_MAJORS.contains(&pos_major)
}

fn starts_new_bunsetsu(token: &MorphToken, prev: Option<&MorphToken>) -> bool {
    if token.pos_major == "接頭辞" {
        return prev.is_none();
    }
    if is_dependent_major(&token.pos_major) {
        return prev.is_none();
    }
    if is_independent_major(&token.pos_major) {
        if let Some(p) = prev {
            if p.pos_major == "接頭辞" {
                return false;
            }
        }
        return true;
    }
    // Unknown POS: start new chunk defensively.
    prev.is_none()
}

/// Segment `text` into bunsetsu chunks with UTF-16 `[start, end)` offsets.
pub fn segment_bunsetsu(text: &str) -> Result<Vec<BunsetsuChunk>, String> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let tokens = tokenize_block(text)?;
    if tokens.is_empty() {
        return Ok(vec![BunsetsuChunk {
            start: 0,
            end: utf16_len(text),
            surface: text.to_string(),
        }]);
    }

    let mut out: Vec<BunsetsuChunk> = Vec::new();
    let first = tokens
        .first()
        .ok_or_else(|| "tokenize returned non-empty vec without first token".to_string())?;
    let mut chunk_start_byte = first.byte_start;
    let mut chunk_end_byte = first.byte_end;
    let mut prev: Option<&MorphToken> = None;

    for token in &tokens {
        if starts_new_bunsetsu(token, prev) && prev.is_some() {
            push_chunk(text, chunk_start_byte, chunk_end_byte, &mut out);
            chunk_start_byte = token.byte_start;
            chunk_end_byte = token.byte_end;
        } else {
            chunk_end_byte = token.byte_end;
        }
        prev = Some(token);
    }
    push_chunk(text, chunk_start_byte, chunk_end_byte, &mut out);
    Ok(out)
}

fn push_chunk(text: &str, byte_start: usize, byte_end: usize, out: &mut Vec<BunsetsuChunk>) {
    if byte_start >= byte_end {
        return;
    }
    let start = utf8_to_utf16(text, byte_start);
    let end = utf8_to_utf16(text, byte_end);
    let surface = text.get(byte_start..byte_end).unwrap_or("").to_string();
    if start < end {
        out.push(BunsetsuChunk {
            start,
            end,
            surface,
        });
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
    fn empty_text_returns_empty() {
        assert!(segment_bunsetsu("").unwrap().is_empty());
    }

    #[test]
    fn japanese_sentence_splits_into_multiple_bunsetsu() {
        let text = "彼女は立った。";
        let chunks = segment_bunsetsu(text).expect("segment");
        assert!(chunks.len() >= 2, "expected multiple bunsetsu: {chunks:?}");
        let rebuilt: String = chunks.iter().map(|c| c.surface.as_str()).collect();
        assert_eq!(rebuilt, text);
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, utf16_len(text));
    }

    #[test]
    fn comma_separated_description_splits_into_multiple_bunsetsu() {
        let text = "段落切替、段落内文、形態素解析による分節の入れ替えテストしています";
        let chunks = segment_bunsetsu(text).expect("segment");
        assert!(
            chunks.len() >= 2,
            "expected multiple bunsetsu for comma-separated prose: {chunks:?}"
        );
        let rebuilt: String = chunks.iter().map(|c| c.surface.as_str()).collect();
        assert_eq!(rebuilt, text);
    }

    #[test]
    fn utf16_offsets_match_js_slice_for_emoji() {
        let text = "A🎉は";
        let chunks = segment_bunsetsu(text).expect("segment");
        assert!(!chunks.is_empty());
        for c in &chunks {
            let slice = slice_utf16(text, c.start, c.end);
            assert_eq!(slice, c.surface);
        }
    }

    fn slice_utf16(text: &str, start: u32, end: u32) -> String {
        let mut utf16 = 0u32;
        let mut out = String::new();
        for ch in text.chars() {
            let len = ch.len_utf16() as u32;
            if utf16 >= end {
                break;
            }
            if utf16 + len > start {
                out.push(ch);
            }
            utf16 += len;
        }
        out
    }
}
