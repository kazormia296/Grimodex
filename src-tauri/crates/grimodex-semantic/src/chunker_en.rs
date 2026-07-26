//! English semantic chunker.
//!
//! Mirrors `chunker.rs` but uses English sentence/quote scanning from
//! `grimodex_lint::textscan::en`. Unlike Japanese (where a paragraph is wholly
//! dialogue or wholly prose), English mixes narration and quoted speech inside
//! one paragraph, so `dialogue_chars` is counted from the quoted spans within
//! each unit rather than from a whole-paragraph classification. Dialogue tags
//! are inline (`"...," she said.`) so no cross-paragraph tag absorption is
//! needed. Packing (`pack_units`) and materialisation are shared with the
//! Japanese chunker; only unit-building differs.
//!
//! `chunk_scene_en` の唯一の呼び出し元 (`index::embed_scene_payloads`) は
//! `semantic-embedding` feature 内なので、`--no-default-features` ビルドでは
//! 本モジュールは「未使用」に見える (テストからは使われる)。pure-logic を
//! ort 無しで container テストできる利点を優先して非 gate のままにし、
//! 非 default ビルドの偽陽性 dead_code だけ allow する。
#![allow(dead_code)]

use anyhow::Result;
use serde_json::Value;

use grimodex_lint::textscan::en;

use crate::chunker::{extract_paragraph_texts, pack_units, ChunkerConfig, SceneChunk, Unit};

/// Scene doc → SceneChunk list (English).
pub fn chunk_scene_en(doc: &Value, config: &ChunkerConfig) -> Result<Vec<SceneChunk>> {
    let paragraphs = extract_paragraph_texts(doc);
    let units = build_units_en(&paragraphs, config);
    Ok(pack_units(&units, config))
}

/// Number of characters inside double-quoted spans of `text`.
fn quoted_char_count(text: &str) -> usize {
    let scan = en::scan_quoted_spans(text, false);
    scan.spans
        .iter()
        .filter_map(|r| text.get(r.clone()))
        .map(|s| s.chars().count())
        .sum()
}

fn build_units_en(paragraphs: &[String], config: &ChunkerConfig) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    let mut scalar_cursor: usize = 0;

    for (idx, p) in paragraphs.iter().enumerate() {
        let p_chars = p.chars().count();
        let p_start = scalar_cursor;
        let p_end = p_start + p_chars;
        // 次段落とは plain_text 上で "\n" 1 文字ぶん空く (paragraphs.join("\n") と等価)。
        scalar_cursor = p_end;
        if idx + 1 < paragraphs.len() {
            scalar_cursor += 1;
        }
        if p.is_empty() {
            continue;
        }

        if p_chars > config.target_max_chars {
            // 長い段落は文単位に割る (textscan の英語センテンス分割)。
            let mut scalar_within: usize = 0;
            for range in en::sentence_ranges_en(p) {
                let Some(sentence) = p.get(range) else {
                    continue;
                };
                let s_chars = sentence.chars().count();
                if s_chars == 0 {
                    continue;
                }
                let unit_start = p_start + scalar_within;
                scalar_within += s_chars;
                let unit_end = p_start + scalar_within;
                units.push(Unit {
                    text: sentence.to_string(),
                    plain_text_start: unit_start,
                    plain_text_end: unit_end,
                    total_chars: s_chars,
                    dialogue_chars: quoted_char_count(sentence),
                });
            }
        } else {
            units.push(Unit {
                text: p.clone(),
                plain_text_start: p_start,
                plain_text_end: p_end,
                total_chars: p_chars,
                dialogue_chars: quoted_char_count(p),
            });
        }
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc_from(paragraphs: &[&str]) -> Value {
        json!({
            "type": "doc",
            "content": paragraphs.iter().map(|p| json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": p }],
            })).collect::<Vec<_>>(),
        })
    }

    fn cfg() -> ChunkerConfig {
        ChunkerConfig {
            target_min_chars: 400,
            target_max_chars: 1000,
            overlap_sentences: 1,
            dialogue_tag_max_chars: 120,
        }
    }

    #[test]
    fn offsets_are_consistent() {
        let doc = doc_from(&[
            "The hall was empty.",
            "\u{201C}Is anyone there?\u{201D} she called.",
        ]);
        let chunks = chunk_scene_en(&doc, &cfg()).expect("chunk");
        assert!(!chunks.is_empty());
        for c in &chunks {
            // char_end - char_start must equal the text's scalar length.
            assert_eq!(
                c.text.chars().count(),
                c.char_end - c.char_start,
                "chunk text length must match its char span"
            );
        }
    }

    #[test]
    fn dialogue_ratio_reflects_quotes() {
        // A wholly-quoted paragraph → high dialogue_ratio.
        let doc = doc_from(&["\u{201C}Everything here is dialogue,\u{201D}"]);
        let chunks = chunk_scene_en(&doc, &cfg()).expect("chunk");
        assert_eq!(chunks.len(), 1);
        assert!(
            chunks[0].dialogue_ratio > 0.8,
            "ratio was {}",
            chunks[0].dialogue_ratio
        );

        // Pure narration → zero dialogue_ratio.
        let doc2 = doc_from(&["The rain fell steadily on the quiet town."]);
        let chunks2 = chunk_scene_en(&doc2, &cfg()).expect("chunk");
        assert_eq!(chunks2[0].dialogue_ratio, 0.0);
    }

    #[test]
    fn long_paragraph_splits_into_sentences() {
        let long = "This is a sentence. ".repeat(80); // > 1000 chars
        let doc = doc_from(&[&long]);
        let chunks = chunk_scene_en(&doc, &cfg()).expect("chunk");
        // Splitting + packing should yield more than one chunk.
        assert!(chunks.len() > 1, "got {} chunks", chunks.len());
    }
}
