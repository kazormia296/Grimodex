use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

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
fn is_valid_boundary(text: &str, start: usize, end: usize) -> bool {
    // Build char-indexed view only for the neighbourhood we need
    let chars: Vec<char> = text.chars().collect();

    // Convert byte offsets → char indices
    let start_char = text[..start].chars().count();
    let end_char = text[..end].chars().count();

    if start_char >= end_char || end_char > chars.len() {
        return false;
    }

    let first_char = chars[start_char];
    let last_char = chars[end_char - 1];

    // Check left boundary
    if start_char > 0 {
        let class_before = char_class(chars[start_char - 1]);
        let class_first = char_class(first_char);
        if class_before == class_first && class_before != CharClass::Other {
            return false;
        }
    }

    // Check right boundary — skip for hiragana-ending patterns (particle attachment)
    if end_char < chars.len() {
        let class_last = char_class(last_char);
        if class_last != CharClass::Hiragana && class_last != CharClass::Other {
            let class_after = char_class(chars[end_char]);
            if class_last == class_after {
                return false;
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
                patterns.push(name.to_lowercase());
                metas.push(PatternMeta {
                    entry_id: entry.id.clone(),
                    entry_name: entry.name.clone(),
                    entry_type: entry.entry_type.clone(),
                    pattern_byte_len: name.len(),
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
        let raw: Vec<_> = raw
            .into_iter()
            .filter(|(from, to, _)| is_valid_boundary(text, *from, *to))
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

        result
    }
}

// ---------------------------------------------------------------------------
// Tauri State
// ---------------------------------------------------------------------------

pub struct CodexMatcherState {
    pub inner: Mutex<Option<CachedMatcher>>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn codex_rebuild_matcher(
    state: tauri::State<'_, CodexMatcherState>,
    entries: Vec<MatchEntry>,
) -> Result<(), String> {
    let matcher = CachedMatcher::build(&entries).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    *inner = Some(matcher);
    Ok(())
}

#[tauri::command]
pub fn codex_match_text(
    state: tauri::State<'_, CodexMatcherState>,
    text: String,
    exclude_entry_ids: Vec<String>,
) -> Result<Vec<CodexMatch>, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    match inner.as_ref() {
        None => Ok(vec![]),
        Some(matcher) => Ok(matcher.match_text(&text, &exclude_entry_ids)),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
        // "山田太郎" — 太郎 at pos [6,12] is preceded by kanji → invalid
        let text = "山田太郎";
        let start = "山田".len();
        let end = text.len();
        assert!(!is_valid_boundary(text, start, end));
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
        assert_eq!(matches[0].to, "太郎".len());
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
        assert_eq!(matches[0].to, "山田太郎".len());
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
    fn test_cjk_boundary_no_match_inside_kanji_word() {
        let m = matcher(vec![entry("c1", "太郎", "character")]);
        // 山田太郎 — 太郎 is inside a longer kanji word
        assert!(m.match_text("山田太郎", &[]).is_empty());
        // But standalone should match
        assert_eq!(m.match_text("太郎が来た", &[]).len(), 1);
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
}
