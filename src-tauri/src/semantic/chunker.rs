//! ProseMirror doc → SceneChunk 列。
//!
//! Step 6 で Tauri command `semantic_index_scene` に配線されるまでは外部から
//! 呼ばれないため、本ファイルは crate 内 dead_code を許容する。
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

#![allow(dead_code)]

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

/// 発話・反応動詞辞書。dialogue tag 検出に使う。控えめに留め、誤結合より誤分離を優先する。
const SPEECH_VERBS: &[&str] = &[
    "言った",
    "尋ねた",
    "答えた",
    "呟いた",
    "つぶやいた",
    "叫んだ",
    "笑った",
    "頷いた",
    "うなずいた",
    "首を振った",
];

/// ProseMirror doc を順に走査して `paragraph` 段落テキストだけ拾う。
/// `sceneBeat` サブツリーはスキップ (Beat はプロンプトであって本文ではない)。
/// `generatedProseBlock` 等は中に paragraph を持つので、その paragraph は取り込む。
pub fn extract_paragraph_texts(doc: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_paragraphs(doc, &mut out);
    out
}

fn collect_paragraphs(node: &Value, out: &mut Vec<String>) {
    let node_type = node.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if node_type == "sceneBeat" {
        // Beat はプロンプト。本文としてはカウントしない。
        return;
    }
    if node_type == "paragraph" {
        let mut buf = String::new();
        if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
            for child in content {
                extract_inline_text(child, &mut buf);
            }
        }
        out.push(buf);
        return;
    }
    // それ以外 (doc / generatedProseBlock / 未知 block) は中の paragraph を探しに降りる
    if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
        for child in content {
            collect_paragraphs(child, out);
        }
    }
}

fn extract_inline_text(node: &Value, buf: &mut String) {
    let node_type = node.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match node_type {
        "text" => {
            if let Some(t) = node.get("text").and_then(|v| v.as_str()) {
                buf.push_str(t);
            }
        }
        "hardBreak" => buf.push('\n'),
        _ => {
            // mark wrapper や未知 inline は中身を再帰
            if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
                for child in content {
                    extract_inline_text(child, buf);
                }
            }
        }
    }
}

/// 段落分類。先頭非空白が `「` または `『` なら Dialogue、それ以外 (空段落含む) は Prose。
pub fn classify_paragraph(text: &str) -> ParagraphKind {
    for ch in text.chars() {
        if ch.is_whitespace() {
            continue;
        }
        if matches!(ch, '「' | '『') {
            return ParagraphKind::Dialogue;
        }
        return ParagraphKind::Prose;
    }
    ParagraphKind::Prose
}

/// dialogue tag 判定。max_chars 以下かつ発話・反応動詞を含むなら true。
pub fn is_dialogue_tag(text: &str, max_chars: usize) -> bool {
    if text.chars().count() > max_chars {
        return false;
    }
    SPEECH_VERBS.iter().any(|v| text.contains(v))
}

/// 括弧深度を考慮した日本語文分割。深度 0 のときだけ 。！？!? で区切り、
/// 直後の閉じ括弧・連続終端記号は同じ文に飲み込む。
/// アルゴリズムは temp/semantic-prose-search-context.md §3.3 の pseudo-code に準拠。
pub fn split_sentences_ja(text: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    if text.is_empty() {
        return out;
    }
    let mut depth: i32 = 0;
    let mut start: usize = 0;
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        match c {
            '「' | '『' | '（' | '(' => depth += 1,
            '」' | '』' | '）' | ')' => depth = (depth - 1).max(0),
            '。' | '！' | '？' | '!' | '?' if depth == 0 => {
                let mut end = i + c.len_utf8();
                // 直後の閉じ括弧・連続終端記号を同じ文に飲み込む
                while let Some(&(j, nc)) = it.peek() {
                    if matches!(nc, '」' | '』' | '）' | ')' | '！' | '？' | '!' | '?') {
                        end = j + nc.len_utf8();
                        it.next();
                    } else {
                        break;
                    }
                }
                out.push(&text[start..end]);
                start = end;
            }
            _ => {}
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

#[derive(Debug, Clone)]
struct Unit {
    text: String,
    plain_text_start: usize,
    plain_text_end: usize,
    total_chars: usize,
    dialogue_chars: usize,
}

/// シーン doc → SceneChunk 列。
pub fn chunk_scene(doc: &Value, config: &ChunkerConfig) -> Result<Vec<SceneChunk>> {
    let paragraphs = extract_paragraph_texts(doc);
    let units = build_units(&paragraphs, config);
    Ok(pack_units(&units, config))
}

fn build_units(paragraphs: &[String], config: &ChunkerConfig) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    let mut scalar_cursor: usize = 0;

    for (idx, p) in paragraphs.iter().enumerate() {
        let p_chars = p.chars().count();
        let p_start = scalar_cursor;
        let p_end = p_start + p_chars;
        // 次段落とは plain_text 上で "\n" 1 文字ぶん空く (paragraphs.join("\n") と等価)
        scalar_cursor = p_end;
        if idx + 1 < paragraphs.len() {
            scalar_cursor += 1;
        }

        if p.is_empty() {
            continue;
        }

        let kind = classify_paragraph(p);
        match kind {
            ParagraphKind::Dialogue => {
                units.push(Unit {
                    text: p.clone(),
                    plain_text_start: p_start,
                    plain_text_end: p_end,
                    total_chars: p_chars,
                    dialogue_chars: p_chars,
                });
            }
            ParagraphKind::Prose => {
                let is_tag = units.last().is_some_and(|u| u.dialogue_chars > 0)
                    && is_dialogue_tag(p, config.dialogue_tag_max_chars);

                if is_tag {
                    // 直前の dialogue ビートに吸収。tag 部分は prose なので dialogue_chars は加算しない。
                    // gap は plain_text 上で「直前ユニットの end から本段落の start まで」の
                    // scalar 数。間に空段落があると gap > 1 になり、その分の \n を埋めないと
                    // text.chars().count() != char_end - char_start でずれる。
                    let last = units.last_mut().expect("is_tag guarantees a previous unit");
                    let gap = p_start.saturating_sub(last.plain_text_end);
                    for _ in 0..gap {
                        last.text.push('\n');
                    }
                    last.text.push_str(p);
                    last.plain_text_end = p_end;
                    last.total_chars += gap + p_chars;
                } else if p_chars > config.target_max_chars {
                    // 長い地の文段落は文単位に割る
                    let sentences = split_sentences_ja(p);
                    let mut scalar_within: usize = 0;
                    for sentence in sentences {
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
                            dialogue_chars: 0,
                        });
                    }
                } else {
                    units.push(Unit {
                        text: p.clone(),
                        plain_text_start: p_start,
                        plain_text_end: p_end,
                        total_chars: p_chars,
                        dialogue_chars: 0,
                    });
                }
            }
        }
    }
    units
}

fn pack_units(units: &[Unit], config: &ChunkerConfig) -> Vec<SceneChunk> {
    if units.is_empty() {
        return Vec::new();
    }
    let mut chunks: Vec<SceneChunk> = Vec::new();
    let mut current: Vec<&Unit> = Vec::new();
    let mut current_chars: usize = 0;

    for unit in units {
        let u_chars = unit.total_chars;
        let would_exceed = current_chars + u_chars > config.target_max_chars;
        let above_min = current_chars >= config.target_min_chars;
        if current_chars > 0 && would_exceed && above_min {
            chunks.push(materialize_chunk(&current, chunks.len()));
            let overlap = config.overlap_sentences.min(current.len());
            let carry_start = current.len() - overlap;
            current = current[carry_start..].to_vec();
            current_chars = current.iter().map(|u| u.total_chars).sum();
            // overlap だけで構成されると次の iteration で重複し続ける。
            // overlap unit が target_max を超えていても上のガードで前進するので問題ない。
        }
        current.push(unit);
        current_chars += u_chars;
    }

    if !current.is_empty() {
        // 末尾チャンクが直前の overlap と完全一致するなら emit しない
        // (起こりにくいが防衛的に)
        let same_as_prev_overlap = chunks
            .last()
            .map(|prev| {
                prev.char_start == current.first().expect("non-empty").plain_text_start
                    && prev.char_end == current.last().expect("non-empty").plain_text_end
            })
            .unwrap_or(false);
        if !same_as_prev_overlap {
            chunks.push(materialize_chunk(&current, chunks.len()));
        }
    }
    chunks
}

fn materialize_chunk(units: &[&Unit], chunk_index: usize) -> SceneChunk {
    let first = units.first().expect("materialize_chunk on empty");
    let last = units.last().expect("materialize_chunk on empty");
    let mut text = String::new();
    let mut total_chars: usize = 0;
    let mut dialogue_chars: usize = 0;
    for (i, u) in units.iter().enumerate() {
        if i > 0 {
            let prev = units[i - 1];
            // unit 間の plain_text 上の隙間 (改行など) を補う。
            // 同段落内の sentence-split unit は連続するので gap = 0。
            // 別段落の unit は paragraphs.join("\n") の分 gap >= 1。
            if prev.plain_text_end < u.plain_text_start {
                let gap = u.plain_text_start - prev.plain_text_end;
                for _ in 0..gap {
                    text.push('\n');
                }
                total_chars += gap;
            }
        }
        text.push_str(&u.text);
        total_chars += u.total_chars;
        dialogue_chars += u.dialogue_chars;
    }
    let dialogue_ratio = if total_chars > 0 {
        dialogue_chars as f32 / total_chars as f32
    } else {
        0.0
    };
    SceneChunk {
        chunk_index,
        text,
        char_start: first.plain_text_start,
        char_end: last.plain_text_end,
        dialogue_ratio,
    }
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

    #[test]
    fn chunk_scene_dialogue_tag_with_empty_paragraph_between_keeps_offset_invariant() {
        // dialogue + 空段落 + dialogue tag。
        // plain_text は paragraphs.join("\n") なので、空段落も 1 文字ぶん消費し
        // dialogue と tag の間に \n が 2 つ入る。
        // 吸収側がそのギャップを正しく埋めないと、chunk.text の文字数と
        // (char_end - char_start) がずれる (TDD red 用回帰テスト)。
        let doc = make_doc(&["「行くぞ」", "", "と彼は言った。"]);
        let chunks = chunk_scene(&doc, &ChunkerConfig::default()).unwrap();
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        assert_eq!(
            c.text.chars().count(),
            c.char_end - c.char_start,
            "chunk text length must match char_end - char_start (got text={:?})",
            c.text
        );
        // 内容としては「「行くぞ」\n\nと彼は言った。」になる (空段落の \n を保持)
        assert!(c.text.contains("「行くぞ」"));
        assert!(c.text.contains("と彼は言った。"));
    }
}
