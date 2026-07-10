//! Codex 名寄せマッチャのコア（Aho-Corasick + CJK 境界判定）。
//!
//! Electron 移行 Phase 3（バッチ1c）で src-tauri/src/codex_matching.rs から
//! 抽出。tauri 非依存の本体（MatchEntry / CodexMatch / CachedMatcher /
//! 境界判定）を Tauri コマンド層と napi バックエンドの両方から呼べるように
//! する（trash_bin / grimodex-fonts と同じ構図）。
//!
//! src-tauri 側 codex_matching.rs は `CodexMatcherState`（tauri::State 用）と
//! 2 つの #[tauri::command] だけの薄シムとして残り、本モジュールの型を
//! re-export する。挙動・ワイヤ契約（camelCase・UTF-16 offset・CJK 境界規則）は
//! 移動前と完全に同一。

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Public types (camelCase ↔ Rust via serde)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchEntry {
    pub id: String,
    pub name: String,
    pub entry_type: String,
    pub aliases: Vec<String>,
    pub excluded_aliases: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexMatch {
    pub entry_id: String,
    pub entry_name: String,
    pub entry_type: String,
    pub from: usize,
    pub to: usize,
}

// ---------------------------------------------------------------------------
// Character class for CJK boundary checking
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharClass {
    Hiragana,
    Katakana,
    Kanji,
    Latin,
    Digit,
    Other,
}

fn char_class(c: char) -> CharClass {
    let code = c as u32;
    if (0x3040..=0x309F).contains(&code) {
        CharClass::Hiragana
    } else if (0x30A0..=0x30FF).contains(&code) {
        CharClass::Katakana
    } else if (0x4E00..=0x9FFF).contains(&code) {
        CharClass::Kanji
    } else if (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code) {
        CharClass::Latin
    } else if (0x30..=0x39).contains(&code) {
        CharClass::Digit
    } else {
        CharClass::Other
    }
}

/// Returns true if the boundary at byte offsets [start, end) in `text` is valid.
/// Mirrors the TypeScript `isValidBoundary` in charClassBoundary.ts.
///
/// Standalone variant — builds the char/index tables on every call. Kept for
/// tests; production callers use `is_valid_boundary_cached` with tables
/// prebuilt once via `build_boundary_tables`.
#[cfg(test)]
fn is_valid_boundary(text: &str, start: usize, end: usize) -> bool {
    let (chars, byte_to_char_idx) = build_boundary_tables(text);
    is_valid_boundary_cached(&chars, &byte_to_char_idx, start, end)
}

/// Build per-text lookup tables used by the boundary check.
/// Returns `(chars, byte_to_char_idx)` where `byte_to_char_idx[b]` is the
/// char index that begins at byte offset `b` (or `usize::MAX` for non-boundary
/// bytes), and `byte_to_char_idx[text.len()]` is `chars.len()`.
fn build_boundary_tables(text: &str) -> (Vec<char>, Vec<usize>) {
    let mut chars: Vec<char> = Vec::with_capacity(text.len());
    let mut byte_to_char_idx: Vec<usize> = vec![usize::MAX; text.len() + 1];
    for (b, ch) in text.char_indices() {
        byte_to_char_idx[b] = chars.len();
        chars.push(ch);
    }
    byte_to_char_idx[text.len()] = chars.len();
    (chars, byte_to_char_idx)
}

/// O(1) variant of `is_valid_boundary` using prebuilt tables. The hot path
/// in `match_text` filters every raw AC match through this; the unwrapped
/// version was rebuilding a Vec<char> per call, which on a 156k-char scene
/// with thousands of raw matches was costing ~8s wall time.
fn is_valid_boundary_cached(
    chars: &[char],
    byte_to_char_idx: &[usize],
    start: usize,
    end: usize,
) -> bool {
    if start >= byte_to_char_idx.len() || end >= byte_to_char_idx.len() {
        return false;
    }
    let start_char = byte_to_char_idx[start];
    let end_char = byte_to_char_idx[end];
    if start_char == usize::MAX || end_char == usize::MAX {
        return false;
    }
    if start_char >= end_char || end_char > chars.len() {
        return false;
    }

    let first_char = chars[start_char];
    let last_char = chars[end_char - 1];

    let pattern_len = end_char - start_char;

    // Check left boundary
    if start_char > 0 {
        let class_before = char_class(chars[start_char - 1]);
        let class_first = char_class(first_char);
        if class_before == class_first && class_before != CharClass::Other {
            // Kanji 2+ char patterns: allow kanji-kanji left boundary.
            // Kanji compounds are naturally adjacent (e.g. 女|王様, 山田|太郎).
            if !(class_before == CharClass::Kanji && pattern_len >= 2) {
                return false;
            }
        }
    }

    // Check right boundary — skip for hiragana-ending patterns (particle attachment)
    if end_char < chars.len() {
        let class_last = char_class(last_char);
        if class_last != CharClass::Hiragana && class_last != CharClass::Other {
            let class_after = char_class(chars[end_char]);
            if class_last == class_after {
                // Kanji 2+ char patterns: allow kanji-kanji right boundary.
                // Reason: kanji are adjacent across word boundaries (佐藤|上等兵, 東京|都).
                if !(class_last == CharClass::Kanji && pattern_len >= 2) {
                    return false;
                }
            }
        }
    }

    true
}

// ---------------------------------------------------------------------------
// Internal pattern metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct PatternMeta {
    entry_id: String,
    entry_name: String,
    entry_type: String,
    /// byte length of the pattern in the original text (not lowercased)
    pattern_byte_len: usize,
}

// ---------------------------------------------------------------------------
// CachedMatcher
// ---------------------------------------------------------------------------

pub struct CachedMatcher {
    ac: AhoCorasick,
    metas: Vec<PatternMeta>,
    /// entry_id → list of exclusion patterns (lowercased)
    exclusion_ac: Option<(AhoCorasick, Vec<(String, usize)>)>, // (entry_id, byte_len)
}

impl CachedMatcher {
    pub fn build(entries: &[MatchEntry]) -> anyhow::Result<Self> {
        if entries.is_empty() {
            let empty: Vec<String> = vec![];
            let ac = AhoCorasickBuilder::new()
                .ascii_case_insensitive(true)
                .match_kind(MatchKind::Standard)
                .build(&empty)
                .map_err(|e| anyhow::anyhow!("AC build error: {e}"))?;
            return Ok(Self {
                ac,
                metas: vec![],
                exclusion_ac: None,
            });
        }

        let mut patterns: Vec<String> = vec![];
        let mut metas: Vec<PatternMeta> = vec![];

        for entry in entries {
            let names: Vec<&str> = std::iter::once(entry.name.as_str())
                .chain(entry.aliases.iter().map(|s| s.as_str()))
                .filter(|s| !s.is_empty())
                .collect();

            for &name in &names {
                let lowered = name.to_lowercase();
                let byte_len = lowered.len();
                patterns.push(lowered);
                metas.push(PatternMeta {
                    entry_id: entry.id.clone(),
                    entry_name: entry.name.clone(),
                    entry_type: entry.entry_type.clone(),
                    pattern_byte_len: byte_len,
                });
            }
        }

        let ac = AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::Standard)
            .build(&patterns)
            .map_err(|e| anyhow::anyhow!("AC build error: {e}"))?;

        // Build exclusion AC
        let mut excl_patterns: Vec<String> = vec![];
        let mut excl_metas: Vec<(String, usize)> = vec![];
        for entry in entries {
            for excl in &entry.excluded_aliases {
                if !excl.is_empty() {
                    excl_patterns.push(excl.to_lowercase());
                    excl_metas.push((entry.id.clone(), excl.len()));
                }
            }
        }

        let exclusion_ac = if excl_patterns.is_empty() {
            None
        } else {
            let eac = AhoCorasickBuilder::new()
                .ascii_case_insensitive(true)
                .match_kind(MatchKind::Standard)
                .build(&excl_patterns)
                .map_err(|e| anyhow::anyhow!("Exclusion AC build error: {e}"))?;
            Some((eac, excl_metas))
        };

        Ok(Self {
            ac,
            metas,
            exclusion_ac,
        })
    }

    pub fn match_text(&self, text: &str, exclude_entry_ids: &[String]) -> Vec<CodexMatch> {
        if text.is_empty() || self.metas.is_empty() {
            return vec![];
        }

        let text_lower = text.to_lowercase();

        // Step 1: raw matches
        let mut raw: Vec<(usize, usize, usize)> = vec![]; // (from_byte, to_byte, meta_idx)
        for m in self.ac.find_overlapping_iter(&text_lower) {
            let meta = &self.metas[m.pattern().as_usize()];
            // Reconstruct actual byte span from original text using meta.pattern_byte_len
            // AC matched on lowercased text, but we want spans in original text (same byte offsets)
            let from = m.start();
            let to = m.start() + meta.pattern_byte_len;
            if to <= text.len() {
                raw.push((from, to, m.pattern().as_usize()));
            }
        }

        if raw.is_empty() {
            return vec![];
        }

        // Step 2: build exclusion ranges per entry_id (one pass over text)
        // excl_ranges: entry_id → Vec<(from, to)>
        let mut excl_ranges: HashMap<&str, Vec<(usize, usize)>> = HashMap::new();
        if let Some((eac, emetas)) = &self.exclusion_ac {
            for m in eac.find_overlapping_iter(&text_lower) {
                let (entry_id, byte_len) = &emetas[m.pattern().as_usize()];
                let efrom = m.start();
                let eto = m.start() + byte_len;
                excl_ranges
                    .entry(entry_id.as_str())
                    .or_default()
                    .push((efrom, eto));
            }
        }

        // Step 3: filter by exclusion
        let raw: Vec<_> = raw
            .into_iter()
            .filter(|(from, to, idx)| {
                let meta = &self.metas[*idx];
                if exclude_entry_ids.contains(&meta.entry_id) {
                    return false;
                }
                if let Some(ranges) = excl_ranges.get(meta.entry_id.as_str()) {
                    for &(efrom, eto) in ranges {
                        if efrom <= *from && eto >= *to {
                            return false;
                        }
                    }
                }
                true
            })
            .collect();

        // Step 4: CJK boundary check
        // Build the chars+byte_to_char_idx tables ONCE for the whole text,
        // then run the boundary check in O(1) per raw match. Reused later
        // in Step 6 for the UTF-16 offset conversion.
        let (chars, byte_to_char_idx) = build_boundary_tables(text);
        let raw: Vec<_> = raw
            .into_iter()
            .filter(|(from, to, _)| is_valid_boundary_cached(&chars, &byte_to_char_idx, *from, *to))
            .collect();

        // Step 5: overlap resolution — longest match wins
        // Sort by start, then by length desc
        let mut sorted = raw;
        sorted.sort_by(|(a_from, a_to, _), (b_from, b_to, _)| {
            if a_from != b_from {
                a_from.cmp(b_from)
            } else {
                // longer first
                (b_to - b_from).cmp(&(a_to - a_from))
            }
        });

        let mut result: Vec<CodexMatch> = vec![];
        let mut last_end: usize = 0;

        for (from, to, idx) in &sorted {
            if *from < last_end {
                continue; // overlaps with previous
            }
            let meta = &self.metas[*idx];
            result.push(CodexMatch {
                entry_id: meta.entry_id.clone(),
                entry_name: meta.entry_name.clone(),
                entry_type: meta.entry_type.clone(),
                from: *from,
                to: *to,
            });
            last_end = *to;
        }

        // Convert byte offsets → UTF-16 code unit offsets so that JavaScript
        // (which uses UTF-16 strings) can use the positions directly.
        // For BMP characters (all CJK/Japanese), 1 char = 1 UTF-16 unit.
        // For supplementary chars (emoji), 1 char = 2 UTF-16 units.
        if result.is_empty() {
            return result;
        }
        let mut byte_to_utf16: Vec<usize> = vec![0; text.len() + 1];
        {
            let mut utf16_offset = 0usize;
            for (bi, ch) in text.char_indices() {
                byte_to_utf16[bi] = utf16_offset;
                utf16_offset += ch.len_utf16();
            }
            byte_to_utf16[text.len()] = utf16_offset;
        }
        for m in &mut result {
            debug_assert!(
                m.from == 0 || byte_to_utf16[m.from] > 0,
                "byte_to_utf16 lookup at non-character-boundary: from={}",
                m.from
            );
            debug_assert!(
                m.to == 0 || byte_to_utf16[m.to] > 0,
                "byte_to_utf16 lookup at non-character-boundary: to={}",
                m.to
            );
            m.from = byte_to_utf16[m.from];
            m.to = byte_to_utf16[m.to];
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, name: &str, entry_type: &str) -> MatchEntry {
        MatchEntry {
            id: id.to_string(),
            name: name.to_string(),
            entry_type: entry_type.to_string(),
            aliases: vec![],
            excluded_aliases: vec![],
        }
    }

    fn entry_with_aliases(
        id: &str,
        name: &str,
        entry_type: &str,
        aliases: Vec<&str>,
        excluded_aliases: Vec<&str>,
    ) -> MatchEntry {
        MatchEntry {
            id: id.to_string(),
            name: name.to_string(),
            entry_type: entry_type.to_string(),
            aliases: aliases.into_iter().map(|s| s.to_string()).collect(),
            excluded_aliases: excluded_aliases
                .into_iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }

    fn matcher(entries: Vec<MatchEntry>) -> CachedMatcher {
        CachedMatcher::build(&entries).unwrap()
    }

    // --- char_class tests ---

    #[test]
    fn test_char_class_hiragana() {
        assert_eq!(char_class('あ'), CharClass::Hiragana);
        assert_eq!(char_class('は'), CharClass::Hiragana);
    }

    #[test]
    fn test_char_class_katakana() {
        assert_eq!(char_class('ア'), CharClass::Katakana);
        assert_eq!(char_class('ラ'), CharClass::Katakana);
    }

    #[test]
    fn test_char_class_kanji() {
        assert_eq!(char_class('太'), CharClass::Kanji);
        assert_eq!(char_class('郎'), CharClass::Kanji);
    }

    #[test]
    fn test_char_class_latin() {
        assert_eq!(char_class('A'), CharClass::Latin);
        assert_eq!(char_class('z'), CharClass::Latin);
    }

    #[test]
    fn test_char_class_digit() {
        assert_eq!(char_class('0'), CharClass::Digit);
        assert_eq!(char_class('9'), CharClass::Digit);
    }

    #[test]
    fn test_char_class_other() {
        assert_eq!(char_class('。'), CharClass::Other);
        assert_eq!(char_class(' '), CharClass::Other);
    }

    // --- is_valid_boundary tests ---

    #[test]
    fn test_boundary_start_of_text() {
        assert!(is_valid_boundary("太郎は走った", 0, "太郎".len()));
    }

    #[test]
    fn test_boundary_end_of_text() {
        let text = "彼は太郎";
        let start = "彼は".len();
        assert!(is_valid_boundary(text, start, text.len()));
    }

    #[test]
    fn test_boundary_katakana_followed_by_hiragana() {
        // "エララが" — valid
        let text = "エララが";
        assert!(is_valid_boundary(text, 0, "エララ".len()));
    }

    #[test]
    fn test_boundary_katakana_followed_by_katakana() {
        // "エララン" — invalid (ン is katakana after ラ)
        let text = "エララン";
        assert!(!is_valid_boundary(text, 0, "エラ".len())); // "エラ" + "ー" or "ン"
    }

    #[test]
    fn test_boundary_kanji_followed_by_hiragana() {
        // "太郎は" — valid
        let text = "太郎は";
        assert!(is_valid_boundary(text, 0, "太郎".len()));
    }

    #[test]
    fn test_boundary_kanji_inside_longer_kanji() {
        // "太郎" (2 chars) in "山田太郎" — preceded by kanji, but 2+ char exception → valid
        let text = "山田太郎";
        let start = "山田".len();
        let end = text.len();
        assert!(is_valid_boundary(text, start, end));

        // Single-kanji "太" (1 char) preceded by kanji → still invalid
        let end_single = start + "太".len();
        assert!(!is_valid_boundary(text, start, end_single));
    }

    #[test]
    fn test_boundary_latin_standalone() {
        let text = "Alice went";
        assert!(is_valid_boundary(text, 0, "Alice".len()));
    }

    #[test]
    fn test_boundary_latin_inside_word() {
        // "Malice" — "Alice" at pos 1 preceded by latin 'M'
        let text = "Malice";
        assert!(!is_valid_boundary(text, 1, text.len()));
    }

    #[test]
    fn test_boundary_cjk_surrounded_by_punctuation() {
        // "「太郎」は"
        let text = "「太郎」は";
        let start = "「".len();
        let end = start + "太郎".len();
        assert!(is_valid_boundary(text, start, end));
    }

    #[test]
    fn test_boundary_hiragana_followed_by_particle() {
        // "見習いが走った"
        let text = "見習いが走った";
        assert!(is_valid_boundary(text, 0, "見習い".len()));
    }

    // --- match_text tests ---

    #[test]
    fn test_empty_text() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        assert!(m.match_text("", &[]).is_empty());
    }

    #[test]
    fn test_empty_entries() {
        let m = CachedMatcher::build(&[]).unwrap();
        assert!(m.match_text("太郎は走った", &[]).is_empty());
    }

    #[test]
    fn test_single_cjk_match() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        let matches = m.match_text("太郎は走った", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
        assert_eq!(matches[0].from, 0);
        assert_eq!(matches[0].to, "太郎".chars().count()); // UTF-16 code units (= code points for BMP)
    }

    #[test]
    fn test_multiple_occurrences() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        let matches = m.match_text("太郎と花子が会い、太郎は笑った", &[]);
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn test_multiple_entries() {
        let m = matcher(vec![
            entry("c1", "太郎", "character"),
            entry("c2", "花子", "character"),
        ]);
        let matches = m.match_text("太郎と花子が会った", &[]);
        assert_eq!(matches.len(), 2);
        let ids: Vec<&str> = matches.iter().map(|m| m.entry_id.as_str()).collect();
        assert!(ids.contains(&"c1"));
        assert!(ids.contains(&"c2"));
    }

    #[test]
    fn test_longer_wins_overlap() {
        let m = matcher(vec![
            entry("c1", "太郎", "character"),
            entry("c2", "山田太郎", "character"),
        ]);
        let matches = m.match_text("山田太郎が来た", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c2");
        assert_eq!(matches[0].from, 0);
        assert_eq!(matches[0].to, "山田太郎".chars().count()); // UTF-16 code units
    }

    #[test]
    fn test_shorter_matches_when_longer_absent() {
        let m = matcher(vec![
            entry("c1", "太郎", "character"),
            entry("c2", "山田太郎", "character"),
        ]);
        let matches = m.match_text("太郎が来た", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
    }

    #[test]
    fn test_cjk_boundary_2char_kanji_matches_inside_compound() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        // 太郎 (2 chars) — 2+ char kanji exception allows match even when
        // preceded by another kanji (田). Single-kanji patterns would still be blocked.
        let matches = m.match_text("山田太郎", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
        // Standalone should also match
        assert_eq!(m.match_text("太郎が来た", &[]).len(), 1);
    }

    #[test]
    fn test_cjk_boundary_2char_right_side() {
        let m = matcher(vec![entry("c1", "佐藤", "character")]);
        // 佐藤 (2 chars) followed by 上 (kanji): 2+ char exception → should match
        let matches = m.match_text("佐藤上等兵", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
    }

    #[test]
    fn test_cjk_boundary_1char_strict() {
        // Single-kanji patterns should still fail kanji-kanji boundaries
        let m = matcher(vec![entry("c1", "藤", "character")]);
        // "藤" (1 char) surrounded by kanji on both sides
        assert!(m.match_text("佐藤上等兵", &[]).is_empty());
    }

    #[test]
    fn test_latin_case_insensitive() {
        let m = matcher(vec![entry("c1", "Alice", "character")]);
        let matches = m.match_text("alice went home", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
    }

    #[test]
    fn test_latin_no_match_inside_word() {
        // CJK boundary check: "Malice" — "Alice" inside it
        // Because our boundary check uses char_class (Latin), this should be caught
        let m = matcher(vec![entry("c1", "Alice", "character")]);
        assert!(m.match_text("Malice is evil", &[]).is_empty());
    }

    #[test]
    fn test_aliases() {
        let m = matcher(vec![entry_with_aliases(
            "c1",
            "エララ",
            "character",
            vec!["見習い", "the apprentice"],
            vec![],
        )]);
        assert_eq!(m.match_text("エララが来た", &[]).len(), 1);
        let matches = m.match_text("見習いが来た", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
    }

    #[test]
    fn test_excluded_aliases() {
        let m = matcher(vec![entry_with_aliases(
            "c1",
            "青",
            "character",
            vec![],
            vec!["青い", "青の", "青く"],
        )]);
        // "青い空" — 青 covered by excluded alias 青い → no match
        assert!(m.match_text("青い空を見上げた", &[]).is_empty());
        // "青は振り返った" — not covered → match
        let matches = m.match_text("青は振り返った", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
    }

    #[test]
    fn test_exclusion_only_applies_to_same_entry() {
        let m = matcher(vec![
            entry_with_aliases("c1", "青", "character", vec![], vec!["青い"]),
            entry("c2", "空", "location"),
        ]);
        // "青い空" — 青 excluded, but 空 not
        let matches = m.match_text("青い空", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c2");
    }

    #[test]
    fn test_exclude_entry_ids() {
        let m = matcher(vec![
            entry("c1", "太郎", "character"),
            entry("c2", "花子", "character"),
        ]);
        let matches = m.match_text("太郎と花子", &["c1".to_string()]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c2");
    }

    #[test]
    fn test_matches_sorted_by_position() {
        let m = matcher(vec![
            entry("c2", "花子", "character"),
            entry("c1", "太郎", "character"),
        ]);
        let matches = m.match_text("太郎と花子", &[]);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].entry_id, "c1");
        assert_eq!(matches[1].entry_id, "c2");
    }

    #[test]
    fn test_katakana_boundary_valid() {
        let m = matcher(vec![entry("c1", "エララ", "character")]);
        assert_eq!(m.match_text("エララが走った", &[]).len(), 1);
    }

    #[test]
    fn test_katakana_boundary_invalid() {
        let m = matcher(vec![entry("c1", "エラ", "character")]);
        // "エラーが出た" — エラ + ー(katakana) → invalid boundary
        assert!(m.match_text("エラーが出た", &[]).is_empty());
        // standalone should match
        assert_eq!(m.match_text("エラが来た", &[]).len(), 1);
    }

    #[test]
    fn test_mixed_cjk_latin() {
        let m = matcher(vec![
            entry("c1", "太郎", "character"),
            entry("c2", "Alice", "character"),
        ]);
        let matches = m.match_text("太郎とAliceが会った", &[]);
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn test_special_chars_in_name() {
        // "C.C." — dot is not a regex special char issue in AC, but byte len matters
        let m = matcher(vec![entry("c1", "C.C.", "character")]);
        let matches = m.match_text("C.C.は微笑んだ", &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].from, 0);
        assert_eq!(matches[0].to, "C.C.".len());
    }

    // --- surrogate pair (supplementary character) tests ---

    #[test]
    fn test_surrogate_pair_in_text_before_match() {
        // 🎭 is U+1F3AD: 4 bytes in UTF-8, 2 code units in UTF-16
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        let text = "🎭太郎は走った";
        let matches = m.match_text(text, &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].entry_id, "c1");
        // 🎭 = 2 UTF-16 units, 太郎 = 2 UTF-16 units
        assert_eq!(matches[0].from, 2);
        assert_eq!(matches[0].to, 4);
    }

    #[test]
    fn test_surrogate_pair_in_text_between_matches() {
        // Emoji between two matches — offsets must account for surrogate pairs
        let m = matcher(vec![
            entry("c1", "太郎", "character"),
            entry("c2", "花子", "character"),
        ]);
        let text = "太郎🎭花子";
        let matches = m.match_text(text, &[]);
        assert_eq!(matches.len(), 2);
        // 太郎: UTF-16 [0, 2)
        assert_eq!(matches[0].from, 0);
        assert_eq!(matches[0].to, 2);
        // 花子: 🎭 = 2 UTF-16 units, so offset starts at 2+2=4
        assert_eq!(matches[1].from, 4);
        assert_eq!(matches[1].to, 6);
    }

    #[test]
    fn test_surrogate_pair_in_entry_name() {
        // Codex entry name contains emoji
        let m = matcher(vec![entry("c1", "🎭劇団", "organization")]);
        let text = "🎭劇団が公演を行った";
        let matches = m.match_text(text, &[]);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].from, 0);
        // 🎭 = 2, 劇団 = 2 → total 4 UTF-16 units
        assert_eq!(matches[0].to, 4);
    }

    #[test]
    fn test_multiple_surrogate_pairs_in_text() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        let text = "🎭🎪太郎が来た";
        let matches = m.match_text(text, &[]);
        assert_eq!(matches.len(), 1);
        // 🎭 = 2, 🎪 = 2, 太郎 starts at UTF-16 offset 4
        assert_eq!(matches[0].from, 4);
        assert_eq!(matches[0].to, 6);
    }

    /// Regression gate (Phase 5): a 150k-char scene with the canonical entry
    /// "太郎" appearing thousands of times must complete in well under a
    /// second. Before the boundary-table fix, this took ~8 seconds because
    /// `is_valid_boundary` rebuilt a Vec<char> per raw match (= O(N*M)).
    #[test]
    fn test_match_text_large_scene_perf() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        // 150k chars worth of "太郎が走った。" (7 chars repeated)
        let chunk = "太郎が走った。";
        let text: String = chunk.repeat(150_000 / chunk.chars().count());
        let started = std::time::Instant::now();
        let matches = m.match_text(&text, &[]);
        let elapsed = started.elapsed();
        assert!(matches.len() > 10_000, "expected many matches");
        // Generous bound; the actual fix runs this in low double-digit ms.
        // Anything over 1s indicates the O(N*M) regression is back.
        assert!(
            elapsed.as_millis() < 1_000,
            "match_text on 150k chars took {}ms (regression: boundary-table fix lost?)",
            elapsed.as_millis()
        );
    }
}
