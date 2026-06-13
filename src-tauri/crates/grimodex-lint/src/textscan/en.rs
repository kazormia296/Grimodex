//! English text scanning: reporting verbs, double-quote spans (with the
//! paragraph-spanning dialogue convention), and conservative sentence
//! segmentation.
//!
//! Shared by the English lint rules (dialogue punctuation, unclosed quotes,
//! sentence length) and the English semantic chunker. The Japanese chunker
//! has its own `split_sentences_ja`; this is the English-side counterpart.

use regex::Regex;
use std::ops::Range;
use std::sync::OnceLock;

/// Reporting verbs used to detect dialogue tags (`"...," she said.`).
///
/// Past-tense centred and deliberately conservative: like the Japanese
/// `SPEECH_VERBS`, we prefer missing a tag over mis-splitting prose. A couple
/// of common present-tense forms are included because they appear often in
/// fiction narration.
pub const EN_SAID_VERBS: &[&str] = &[
    "said",
    "says",
    "asked",
    "asks",
    "replied",
    "answered",
    "whispered",
    "shouted",
    "muttered",
    "murmured",
    "added",
    "called",
    "cried",
    "snapped",
    "agreed",
    "admitted",
    "breathed",
    "hissed",
    "growled",
    "repeated",
    "continued",
    "began",
    "offered",
    "insisted",
    "demanded",
    "wondered",
    "exclaimed",
    "remarked",
    "observed",
    "declared",
];

/// Abbreviations whose trailing period must not end a sentence. Internal-dot
/// abbreviations (`e.g.`, `a.m.`) are handled loosely by the ellipsis / dot-run
/// guard and are intentionally omitted here.
const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "inc", "ltd", "co", "capt",
    "lt", "sgt", "col", "gen", "rev", "hon", "gov", "sen", "rep", "messrs", "mt", "ave", "blvd",
    "no", "dept", "fig", "vol", "pp",
];

static SAID_VERB_RE: OnceLock<Regex> = OnceLock::new();

fn said_verb_regex() -> &'static Regex {
    SAID_VERB_RE.get_or_init(|| {
        let alternation = EN_SAID_VERBS.join("|");
        #[allow(clippy::expect_used)]
        Regex::new(&format!(r"(?i)\b(?:{alternation})\b"))
            .expect("static said-verb regex must compile")
    })
}

/// Does `text` contain a reporting verb (case-insensitive, word-boundary)?
pub fn contains_said_verb(text: &str) -> bool {
    said_verb_regex().is_match(text)
}

static SAID_VERB_SET: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();

/// Is `word` exactly a reporting verb (case-insensitive)?
pub fn is_said_verb(word: &str) -> bool {
    let set = SAID_VERB_SET.get_or_init(|| EN_SAID_VERBS.iter().copied().collect());
    set.contains(word.to_ascii_lowercase().as_str())
}

/// dialogue-tag heuristic: a short narration run that contains a reporting
/// verb. Mirrors the Japanese `is_dialogue_tag` shape.
pub fn is_dialogue_tag_en(text: &str, max_chars: usize) -> bool {
    if text.chars().count() > max_chars {
        return false;
    }
    contains_said_verb(text)
}

/// Result of scanning a single paragraph for double-quote spans.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QuoteScan {
    /// Byte ranges of quoted runs (including the quote marks themselves).
    pub spans: Vec<Range<usize>>,
    /// If the paragraph ends inside an unterminated quote, the byte offset of
    /// the opening quote mark. `None` if every quote was closed.
    pub unterminated_open: Option<usize>,
}

/// Scan `text` for double-quote spans, tracking both straight ASCII (`"`) and
/// curly (`“` / `”`) quotes.
///
/// `carry_open` lets a caller declare the paragraph begins already inside an
/// unclosed quotation (the English convention where a multi-paragraph speech
/// omits the closing quote). The current callers track continuation
/// themselves and pass `false`; the parameter is kept for completeness.
pub fn scan_quoted_spans(text: &str, carry_open: bool) -> QuoteScan {
    let mut spans: Vec<Range<usize>> = Vec::new();
    let mut open_at: Option<usize> = if carry_open { Some(0) } else { None };

    for (i, c) in text.char_indices() {
        match c {
            // Straight ASCII double quote toggles open/closed.
            '"' => match open_at.take() {
                Some(start) => spans.push(start..(i + c.len_utf8())),
                None => open_at = Some(i),
            },
            // Left curly double quote opens (ignored if already inside).
            '\u{201C}' if open_at.is_none() => open_at = Some(i),
            // Right curly double quote closes.
            '\u{201D}' => {
                if let Some(start) = open_at.take() {
                    spans.push(start..(i + c.len_utf8()));
                }
            }
            _ => {}
        }
    }

    let unterminated_open = open_at;
    if let Some(start) = open_at {
        // Unterminated quote: its span runs to the end of the paragraph.
        spans.push(start..text.len());
    }

    QuoteScan {
        spans,
        unterminated_open,
    }
}

/// If `text`'s first non-whitespace character is an opening double quote
/// (`"` or `“`), return its byte offset. Used to detect the paragraph-spanning
/// dialogue convention (the next paragraph re-opens the quote).
pub fn leading_open_quote(text: &str) -> Option<usize> {
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            continue;
        }
        if matches!(c, '"' | '\u{201C}') {
            return Some(i);
        }
        return None;
    }
    None
}

/// Byte ranges of sentences within `text`. Ranges are contiguous and cover the
/// whole string (leading whitespace of a sentence belongs to that sentence).
///
/// Conservative segmentation: splits on `. ! ?` outside parentheses, but not
/// after a known abbreviation, a single capital initial, inside a decimal
/// number, on an ellipsis run, or when the next non-space character is not a
/// sentence opener (uppercase letter, opening quote, digit, or end-of-text).
pub fn sentence_ranges_en(text: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    if text.is_empty() {
        return out;
    }

    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut depth: i32 = 0;
    let mut start: usize = 0;
    // Current trailing alphanumeric token, lowercased, for abbreviation checks.
    let mut word = String::new();
    let mut word_all_upper = true;
    let mut word_len = 0usize;

    let mut i = 0usize;
    while let Some(&(byte, c)) = chars.get(i) {
        match c {
            '(' | '[' | '\u{FF08}' => depth += 1,
            ')' | ']' | '\u{FF09}' => depth = (depth - 1).max(0),
            _ => {}
        }

        let is_terminal = matches!(c, '.' | '!' | '?');
        if is_terminal && depth == 0 {
            let boundary = is_sentence_boundary(&chars, i, c, &word, word_all_upper, word_len);
            if boundary {
                // Swallow following closing quotes / brackets and consecutive
                // terminal punctuation into the same sentence.
                let mut end = byte + c.len_utf8();
                let mut j = i + 1;
                while let Some(&(nb, nc)) = chars.get(j) {
                    if matches!(
                        nc,
                        '"' | '\'' | '\u{201D}' | '\u{2019}' | ')' | ']' | '!' | '?' | '.'
                    ) {
                        end = nb + nc.len_utf8();
                        j += 1;
                    } else {
                        break;
                    }
                }
                out.push(start..end);
                start = end;
                i = j;
                word.clear();
                word_all_upper = true;
                word_len = 0;
                continue;
            }
        }

        // Maintain the trailing-word state for the next terminal check.
        if c.is_alphanumeric() {
            if c.is_ascii() {
                word.push(c.to_ascii_lowercase());
            } else {
                word.push(c);
            }
            if !c.is_uppercase() {
                word_all_upper = false;
            }
            word_len += 1;
        } else {
            word.clear();
            word_all_upper = true;
            word_len = 0;
        }

        i += 1;
    }

    if start < text.len() {
        out.push(start..text.len());
    }
    out
}

/// Sentence slices of `text` (see [`sentence_ranges_en`]).
pub fn split_sentences_en(text: &str) -> Vec<&str> {
    sentence_ranges_en(text)
        .into_iter()
        .filter_map(|r| text.get(r))
        .collect()
}

/// Decide whether a terminal punctuation char at index `i` ends a sentence.
fn is_sentence_boundary(
    chars: &[(usize, char)],
    i: usize,
    c: char,
    word: &str,
    word_all_upper: bool,
    word_len: usize,
) -> bool {
    if c == '.' {
        // Decimal number: digit '.' digit.
        let prev_digit = i
            .checked_sub(1)
            .and_then(|p| chars.get(p))
            .map(|&(_, pc)| pc.is_ascii_digit())
            .unwrap_or(false);
        let next_digit = chars
            .get(i + 1)
            .map(|&(_, nc)| nc.is_ascii_digit())
            .unwrap_or(false);
        if prev_digit && next_digit {
            return false;
        }
        // Ellipsis / dot run: a '.' immediately followed by another '.'.
        if chars.get(i + 1).map(|&(_, nc)| nc == '.').unwrap_or(false) {
            return false;
        }
        // Abbreviation or single capital initial directly before the period.
        if !word.is_empty() {
            if ABBREVIATIONS.contains(&word) {
                return false;
            }
            if word_len == 1 && word_all_upper {
                return false;
            }
        }
    }

    // Require the next non-space character to look like a sentence opener.
    let mut j = i + 1;
    // Skip swallowed trailing terminals / closing punctuation first.
    while let Some(&(_, nc)) = chars.get(j) {
        if matches!(
            nc,
            '"' | '\'' | '\u{201D}' | '\u{2019}' | ')' | ']' | '!' | '?' | '.'
        ) {
            j += 1;
        } else {
            break;
        }
    }
    // Skip whitespace.
    while let Some(&(_, nc)) = chars.get(j) {
        if nc.is_whitespace() {
            j += 1;
        } else {
            break;
        }
    }
    match chars.get(j) {
        None => true, // end of text
        Some(&(_, nc)) => {
            nc.is_uppercase()
                || nc.is_ascii_digit()
                || matches!(nc, '"' | '\'' | '\u{201C}' | '\u{2018}')
                || !nc.is_ascii() // non-Latin opener (defensive)
        }
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
    fn said_verbs_word_boundary() {
        assert!(contains_said_verb("\"Hello,\" she said."));
        assert!(contains_said_verb("he ASKED again"));
        // No false match on a superstring.
        assert!(!contains_said_verb("the saidism doctrine"));
        assert!(!contains_said_verb("plain narration with no tag"));
    }

    #[test]
    fn dialogue_tag_respects_length() {
        assert!(is_dialogue_tag_en("she said", 40));
        assert!(!is_dialogue_tag_en("she said", 3));
    }

    #[test]
    fn quote_scan_straight_pair() {
        let scan = scan_quoted_spans(r#"He said "hello there" loudly."#, false);
        assert_eq!(scan.spans.len(), 1);
        assert!(scan.unterminated_open.is_none());
        let r = scan.spans[0].clone();
        assert_eq!(&r#"He said "hello there" loudly."#[r], "\"hello there\"");
    }

    #[test]
    fn quote_scan_curly_pair() {
        let text = "He said \u{201C}hi\u{201D} now.";
        let scan = scan_quoted_spans(text, false);
        assert_eq!(scan.spans.len(), 1);
        assert!(scan.unterminated_open.is_none());
    }

    #[test]
    fn quote_scan_unterminated() {
        let text = r#"She began, "It was a dark night"#;
        let scan = scan_quoted_spans(text, false);
        assert_eq!(scan.spans.len(), 1);
        assert!(scan.unterminated_open.is_some());
        // The trailing span runs to end of text.
        assert_eq!(scan.spans[0].end, text.len());
    }

    #[test]
    fn quote_scan_carry_open() {
        let text = "still talking here";
        let scan = scan_quoted_spans(text, true);
        // Whole paragraph is inside the carried-open quote.
        assert_eq!(scan.spans.len(), 1);
        assert_eq!(scan.spans[0], 0..text.len());
        assert!(scan.unterminated_open.is_some());
    }

    #[test]
    fn leading_open_quote_detection() {
        assert_eq!(leading_open_quote(r#"  "Yes," he said."#), Some(2));
        assert_eq!(leading_open_quote("Plain narration."), None);
        assert_eq!(leading_open_quote(""), None);
    }

    #[test]
    fn sentences_basic() {
        let text = "He ran. She walked! Did they stop?";
        let s = split_sentences_en(text);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], "He ran.");
        assert_eq!(s[1].trim(), "She walked!");
        assert_eq!(s[2].trim(), "Did they stop?");
    }

    #[test]
    fn sentences_keep_abbreviations() {
        let text = "Mr. Smith met Dr. Jones today.";
        let s = split_sentences_en(text);
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn sentences_keep_decimal_and_ellipsis() {
        let s = split_sentences_en("It cost 3.50 and then... nothing happened.");
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn sentences_single_initial() {
        let s = split_sentences_en("J. R. R. Tolkien wrote it.");
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn sentences_swallow_closing_quote() {
        let text = "\"Stop!\" she cried. He froze.";
        let s = split_sentences_en(text);
        // The '!' is inside the quote but a boundary; closing quote swallowed.
        assert!(s[0].contains("cried.") || s[0].ends_with("cried."));
        assert_eq!(s.last().unwrap().trim(), "He froze.");
    }

    #[test]
    fn sentence_ranges_cover_text() {
        let text = "One. Two. Three.";
        let ranges = sentence_ranges_en(text);
        // Contiguous, covering.
        assert_eq!(ranges.first().unwrap().start, 0);
        assert_eq!(ranges.last().unwrap().end, text.len());
        for w in ranges.windows(2) {
            assert_eq!(w[0].end, w[1].start);
        }
    }

    #[test]
    fn empty_text() {
        assert!(sentence_ranges_en("").is_empty());
        assert!(split_sentences_en("").is_empty());
    }
}
