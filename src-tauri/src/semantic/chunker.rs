//! ProseMirror doc → SceneChunk 列。
//!
//! 設計: temp/semantic-prose-search-context.md §3.3。
//! 入力は ProseMirror / TipTap JSON で、`sceneBeat` (プロンプト) は除外し、
//! `paragraph` ノードのみを順に取り出す (生成 prose を含む `generatedProseBlock`
//! はネスト先の paragraph まで降りる)。
//!
//! 流れ:
//!   1. paragraph テキスト抽出 → plain_text (paragraphs.join("\n"))。
//!   2. 各段落を会話 / 地の文に分類 (先頭非空白が `「` `『` なら会話)。
//!   3. 直前段落が会話 & 現在段落が短い地の文 & 発話動詞含む → dialogue tag として
//!      直前ビートに結合。
//!   4. 長い地の文段落は括弧対応文分割で sentence-unit に割る。
//!   5. unit 列を target_min..=target_max chars でパッキング、文単位 overlap_sentences
//!      個を持ち越し。
//!
//! 戻り値の `char_start` / `char_end` は plain_text 上の Unicode scalar 単位。
//! ProseMirror position や Rust の byte offset とは別物 (§3.2)。

use anyhow::Result;
use serde_json::Value;

/// 現行チャンク化ルールのバージョン識別子。
/// 分類・スプリッタ・パッキングのいずれかを変更したらインクリメントする。
/// DB の `scene_chunks.chunker_version` と突き合わせて stale 判定する。
pub const CHUNKER_VERSION: &str = "semantic-prose-chunker-v1";

#[derive(Debug, Clone, Copy)]
pub struct ChunkerConfig {
    /// チャンク 1 件あたりの最小目安文字数 (これ未満なら次の unit を強制的に取り込む)。
    pub target_min_chars: usize,
    /// チャンク 1 件あたりの上限目安。これを超え、かつ min を満たしていれば emit する。
    pub target_max_chars: usize,
    /// 隣接チャンク間で重ねる sentence-unit 数。
    pub overlap_sentences: usize,
    /// dialogue tag とみなす短い地の文段落の最大文字数。
    pub dialogue_tag_max_chars: usize,
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        Self {
            target_min_chars: 200,
            target_max_chars: 500,
            overlap_sentences: 1,
            dialogue_tag_max_chars: 80,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphKind {
    Dialogue,
    Prose,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneChunk {
    pub chunk_index: usize,
    pub text: String,
    /// plain_text 上の Unicode scalar 開始位置 (含む)。
    pub char_start: usize,
    /// plain_text 上の Unicode scalar 終了位置 (含まない)。
    pub char_end: usize,
    /// チャンク内の会話文字数 / 全体文字数 (0.0〜1.0)。
    pub dialogue_ratio: f32,
}

/// ProseMirror doc を順に走査して `paragraph` 段落テキストだけ拾う。
/// `sceneBeat` サブツリーはスキップ (Beat はプロンプトであって本文ではない)。
/// `generatedProseBlock` 等は中に paragraph を持つので、その paragraph は取り込む。
pub fn extract_paragraph_texts(doc: &Value) -> Vec<String> {
    let _ = doc;
    todo!("implement in next commit")
}

/// 段落分類。先頭非空白が `「` または `『` なら Dialogue、それ以外 (空段落含む) は Prose。
pub fn classify_paragraph(text: &str) -> ParagraphKind {
    let _ = text;
    todo!("implement in next commit")
}

/// dialogue tag 判定。max_chars 以下かつ発話・反応動詞を含むなら true。
pub fn is_dialogue_tag(text: &str, max_chars: usize) -> bool {
    let _ = (text, max_chars);
    todo!("implement in next commit")
}

/// 括弧深度を考慮した日本語文分割。深度 0 のときだけ 。！？!? で区切り、
/// 直後の閉じ括弧・連続終端記号は同じ文に飲み込む。
pub fn split_sentences_ja(text: &str) -> Vec<&str> {
    let _ = text;
    todo!("implement in next commit")
}

/// シーン doc → SceneChunk 列。
pub fn chunk_scene(doc: &Value, config: &ChunkerConfig) -> Result<Vec<SceneChunk>> {
    let _ = (doc, config);
    todo!("implement in next commit")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ──────────────────────────────────────────────────────────
    // classify_paragraph
    // ──────────────────────────────────────────────────────────

    #[test]
    fn classify_paragraph_dialogue_with_kagi() {
        assert_eq!(
            classify_paragraph("「こんにちは」"),
            ParagraphKind::Dialogue
        );
    }

    #[test]
    fn classify_paragraph_dialogue_with_double_kagi() {
        assert_eq!(classify_paragraph("『心の声』"), ParagraphKind::Dialogue);
    }

    #[test]
    fn classify_paragraph_prose() {
        assert_eq!(classify_paragraph("雨が降っていた。"), ParagraphKind::Prose);
    }

    #[test]
    fn classify_paragraph_ignores_leading_whitespace() {
        assert_eq!(classify_paragraph("  「やあ」"), ParagraphKind::Dialogue);
        // full-width space (U+3000) も whitespace 扱いになる
        assert_eq!(
            classify_paragraph("\u{3000}「やあ」"),
            ParagraphKind::Dialogue
        );
    }

    #[test]
    fn classify_paragraph_empty_is_prose() {
        assert_eq!(classify_paragraph(""), ParagraphKind::Prose);
        assert_eq!(classify_paragraph("   "), ParagraphKind::Prose);
    }

    // ──────────────────────────────────────────────────────────
    // is_dialogue_tag
    // ──────────────────────────────────────────────────────────

    #[test]
    fn is_dialogue_tag_short_with_speech_verb() {
        assert!(is_dialogue_tag("と彼は言った。", 80));
        assert!(is_dialogue_tag("彼女は笑った。", 80));
        assert!(is_dialogue_tag("彼は首を振った。", 80));
        assert!(is_dialogue_tag("少女はうなずいた。", 80));
    }

    #[test]
    fn is_dialogue_tag_too_long_is_false() {
        // 80 字を確実に超える長さ
        let long = "彼は言った。".repeat(20);
        assert!(!is_dialogue_tag(&long, 80));
    }

    #[test]
    fn is_dialogue_tag_short_without_speech_verb_is_false() {
        assert!(!is_dialogue_tag("雨が降っていた。", 80));
        assert!(!is_dialogue_tag("空は灰色だった。", 80));
    }

    // ──────────────────────────────────────────────────────────
    // split_sentences_ja
    // ──────────────────────────────────────────────────────────

    #[test]
    fn split_sentences_basic() {
        let result = split_sentences_ja("雨が降っていた。風も強かった。");
        assert_eq!(result, vec!["雨が降っていた。", "風も強かった。"]);
    }

    #[test]
    fn split_sentences_keeps_kuten_inside_brackets() {
        let result = split_sentences_ja("彼は「今日は雨だ。本当に。」と呟いた。");
        assert_eq!(result, vec!["彼は「今日は雨だ。本当に。」と呟いた。"]);
    }

    #[test]
    fn split_sentences_nested_brackets() {
        let result = split_sentences_ja("彼は『「待て。」と叫んだ。』を読んだ。");
        // depth カウンタが 2 になり、内側の 。 では切れない
        assert_eq!(result, vec!["彼は『「待て。」と叫んだ。』を読んだ。"]);
    }

    #[test]
    fn split_sentences_consecutive_terminators() {
        let result = split_sentences_ja("本当に？！そんな。");
        assert_eq!(result, vec!["本当に？！", "そんな。"]);
    }

    #[test]
    fn split_sentences_unbalanced_brackets_do_not_underflow() {
        // 閉じ括弧だけが先にきても深度は 0 のまま (.max(0))
        let result = split_sentences_ja("やあ」と言った。次の文。");
        assert_eq!(result, vec!["やあ」と言った。", "次の文。"]);
    }

    #[test]
    fn split_sentences_no_terminator() {
        let result = split_sentences_ja("文末なし");
        assert_eq!(result, vec!["文末なし"]);
    }

    #[test]
    fn split_sentences_empty() {
        let result = split_sentences_ja("");
        let empty: Vec<&str> = Vec::new();
        assert_eq!(result, empty);
    }

    #[test]
    fn split_sentences_san_ten_reader_does_not_split() {
        // 三点リーダ U+2026 単体では区切らない
        let result = split_sentences_ja("そうか……それでも続けるか。");
        assert_eq!(result, vec!["そうか……それでも続けるか。"]);
    }

    // ──────────────────────────────────────────────────────────
    // extract_paragraph_texts
    // ──────────────────────────────────────────────────────────

    fn make_doc(paragraphs: &[&str]) -> Value {
        let content: Vec<Value> = paragraphs
            .iter()
            .map(|p| {
                json!({
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": p }]
                })
            })
            .collect();
        json!({ "type": "doc", "content": content })
    }

    #[test]
    fn extract_skips_scene_beat_subtree() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "本文1" }] },
                {
                    "type": "sceneBeat",
                    "attrs": { "id": "b1", "beatType": "free" },
                    "content": [{ "type": "text", "text": "ビート指示" }]
                },
                { "type": "paragraph", "content": [{ "type": "text", "text": "本文2" }] }
            ]
        });
        let paragraphs = extract_paragraph_texts(&doc);
        assert_eq!(paragraphs, vec!["本文1".to_string(), "本文2".to_string()]);
    }

    #[test]
    fn extract_descends_into_generated_prose_block() {
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "generatedProseBlock",
                    "attrs": { "beatId": "b1" },
                    "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "生成 prose" }] }
                    ]
                }
            ]
        });
        let paragraphs = extract_paragraph_texts(&doc);
        assert_eq!(paragraphs, vec!["生成 prose".to_string()]);
    }

    #[test]
    fn extract_concatenates_multiple_text_runs() {
        // text node が mark 等で分割されていても 1 段落としてつなぐ
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        { "type": "text", "text": "前半" },
                        { "type": "text", "text": "後半", "marks": [{ "type": "em" }] }
                    ]
                }
            ]
        });
        let paragraphs = extract_paragraph_texts(&doc);
        assert_eq!(paragraphs, vec!["前半後半".to_string()]);
    }

    #[test]
    fn extract_empty_doc_yields_no_paragraphs() {
        let doc = json!({ "type": "doc", "content": [] });
        assert!(extract_paragraph_texts(&doc).is_empty());

        let doc_no_content = json!({ "type": "doc" });
        assert!(extract_paragraph_texts(&doc_no_content).is_empty());
    }

    #[test]
    fn extract_skips_non_paragraph_block_nodes() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "content": [{ "type": "text", "text": "見出し" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "本文" }] }
            ]
        });
        let paragraphs = extract_paragraph_texts(&doc);
        assert_eq!(paragraphs, vec!["本文".to_string()]);
    }

    // ──────────────────────────────────────────────────────────
    // chunk_scene
    // ──────────────────────────────────────────────────────────

    #[test]
    fn chunk_scene_empty_doc() {
        let doc = json!({ "type": "doc", "content": [] });
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn chunk_scene_skips_non_paragraph_nodes() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "content": [{ "type": "text", "text": "見出し" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "本文。" }] }
            ]
        });
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].text.contains("本文。"));
        assert!(!chunks[0].text.contains("見出し"));
    }

    #[test]
    fn chunk_scene_packs_short_paragraphs_together() {
        // 各段落 ~35 chars × 5 = 175 chars (< target_min=200) → 1 チャンクに収まる
        let short = "雨が窓を激しく叩いていた。彼は窓の外を眺めていた。心の中は荒れていた。";
        let doc = make_doc(&[short, short, short, short, short]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert!(
            chunks.len() <= 3,
            "expected short paragraphs to be packed, got {} chunks",
            chunks.len()
        );
        let combined: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert!(combined.contains(short));
    }

    #[test]
    fn chunk_scene_does_not_emit_lone_dialogue_chunk() {
        let doc = make_doc(&[
            "彼は窓を見つめていた。雨が降り続けていた。彼の心も同じように冷たかった。",
            "「ここから出たい」",
            "雨はやむ気配がなかった。",
        ]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        let lone_dialogue = chunks.iter().any(|c| c.text.trim() == "「ここから出たい」");
        assert!(
            !lone_dialogue,
            "a single short dialogue paragraph should not become its own chunk"
        );
    }

    #[test]
    fn chunk_scene_splits_long_prose_paragraph() {
        // 約 1000 chars の段落を 1 つ。target_max=500 を超えるので分割される。
        let sentence = "雨が窓を叩いていた。"; // 10 chars
        let long_paragraph = sentence.repeat(100);
        let doc = make_doc(&[&long_paragraph]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert!(
            chunks.len() >= 2,
            "long paragraph should split into multiple chunks, got {}",
            chunks.len()
        );
        for chunk in &chunks {
            let len = chunk.text.chars().count();
            assert!(
                len <= 700,
                "chunk exceeded reasonable max (got {} chars)",
                len
            );
        }
    }

    #[test]
    fn chunk_scene_applies_overlap_between_consecutive_chunks() {
        let sentence = "短い文。"; // 4 chars
        let long = sentence.repeat(150); // 600 chars → 2 チャンク
        let doc = make_doc(&[&long]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert!(chunks.len() >= 2);
        // 隣接チャンクの範囲は overlap_sentences=1 ぶん重なる
        assert!(
            chunks[0].char_end > chunks[1].char_start,
            "expected overlap between chunk 0 (end {}) and chunk 1 (start {})",
            chunks[0].char_end,
            chunks[1].char_start
        );
    }

    #[test]
    fn chunk_scene_char_offsets_match_chunk_text_length() {
        let para = "雨が降っていた。彼は窓を見つめていた。";
        let doc = make_doc(&[para]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert_eq!(chunks.len(), 1);
        let scalar_len = chunks[0].text.chars().count();
        assert_eq!(chunks[0].char_end - chunks[0].char_start, scalar_len);
    }

    #[test]
    fn chunk_scene_char_offsets_slice_back_to_plain_text() {
        // 複数段落で plain_text を再構築し、char_start..char_end でスライスしたものが
        // 各チャンクの text と一致することを確認する。
        let paragraphs = ["第一文。", "第二文。", "第三文。"];
        let doc = make_doc(&paragraphs);
        let plain_text = paragraphs.join("\n");
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        let scalars: Vec<char> = plain_text.chars().collect();
        for chunk in &chunks {
            let extracted: String = scalars[chunk.char_start..chunk.char_end].iter().collect();
            assert_eq!(
                chunk.text, extracted,
                "chunk text must equal plain_text[char_start..char_end]"
            );
        }
    }

    #[test]
    fn chunk_scene_dialogue_ratio_zero_for_pure_prose() {
        let doc = make_doc(&["雨が降っていた。彼は窓を見つめていた。空は灰色だった。"]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert!(!chunks.is_empty());
        for c in &chunks {
            assert!(
                (c.dialogue_ratio - 0.0).abs() < f32::EPSILON,
                "pure prose ratio should be 0.0 (got {})",
                c.dialogue_ratio
            );
        }
    }

    #[test]
    fn chunk_scene_dialogue_ratio_high_for_pure_dialogue() {
        let doc = make_doc(&[
            "「行くぞ」",
            "「ああ」",
            "「準備はいいか」",
            "「もちろんだ」",
        ]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert!(!chunks.is_empty());
        // 内訳: 会話文字 24 + 段落間改行 3 = 27 → ratio ≈ 0.89
        assert!(
            chunks[0].dialogue_ratio > 0.5,
            "pure dialogue ratio should be >0.5 (got {})",
            chunks[0].dialogue_ratio
        );
    }

    #[test]
    fn chunk_scene_assigns_sequential_chunk_index() {
        let sentence = "雨が窓を叩いていた。";
        let long = sentence.repeat(200); // 2000 chars → 複数チャンクへ
        let doc = make_doc(&[&long]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.chunk_index, i);
        }
    }

    #[test]
    fn chunk_scene_dialogue_tag_attached_to_preceding_dialogue() {
        // 「行くぞ」 + 「と彼は言った。」 (短い + 発話動詞) → 同一ビート扱い、独立 chunk にならない
        let doc = make_doc(&["「行くぞ」", "と彼は言った。"]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert_eq!(chunks.len(), 1);
        // tag を吸収しているので、chunk text には両方が連続して含まれる
        assert!(chunks[0].text.contains("「行くぞ」"));
        assert!(chunks[0].text.contains("と彼は言った。"));
    }
}
