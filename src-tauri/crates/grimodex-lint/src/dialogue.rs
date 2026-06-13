//! Dialogue-span analysis for English scenes.
//!
//! Walks the blocks of a lint request, marking which scene-wide UTF-16 ranges
//! fall inside double-quoted dialogue, and detecting genuinely unterminated
//! quotes. English rules use this two ways:
//!   - the engine filters a rule's diagnostics by its [`DialogueScope`]
//!     (narration-only style rules skip text inside dialogue, and vice versa);
//!   - `en/unclosed-quote` consumes [`DialogueAnalysis::unclosed_ranges`].
//!
//! Japanese never triggers this analysis — `analyze_dialogue` is only invoked
//! by the engine for English requests with an interested rule enabled.

use crate::offset::utf8_to_utf16;
use crate::rule::{LintBlock, Utf16Range};
use crate::textscan::en;

/// Where a rule's diagnostics are allowed to land relative to dialogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogueScope {
    /// No filtering (default for most rules).
    Anywhere,
    /// Keep only diagnostics that overlap a dialogue span.
    DialogueOnly,
    /// Drop diagnostics that overlap a dialogue span (style rules that would
    /// false-positive on intentionally informal speech).
    NarrationOnly,
}

/// Result of scanning a scene's blocks for dialogue.
#[derive(Debug, Clone, Default)]
pub struct DialogueAnalysis {
    /// Scene-wide UTF-16 ranges that lie inside double-quoted dialogue.
    dialogue_spans: Vec<Utf16Range>,
    /// Scene-wide UTF-16 ranges of genuinely unterminated quotes (the opening
    /// quote through the end of its paragraph), excluding the legitimate
    /// paragraph-spanning convention.
    unclosed: Vec<Utf16Range>,
}

impl DialogueAnalysis {
    /// Does any dialogue span overlap `range`? Half-open overlap test.
    pub fn overlaps(&self, range: &Utf16Range) -> bool {
        self.dialogue_spans
            .iter()
            .any(|s| range.start < s.end && s.start < range.end)
    }

    pub fn dialogue_spans(&self) -> &[Utf16Range] {
        &self.dialogue_spans
    }

    pub fn unclosed_ranges(&self) -> &[Utf16Range] {
        &self.unclosed
    }
}

/// Build a [`DialogueAnalysis`] for the request's blocks.
pub fn analyze_dialogue(blocks: &[LintBlock]) -> DialogueAnalysis {
    let mut dialogue_spans: Vec<Utf16Range> = Vec::new();
    let mut unclosed: Vec<Utf16Range> = Vec::new();

    for (idx, block) in blocks.iter().enumerate() {
        let scan = en::scan_quoted_spans(&block.text, false);
        for sp in &scan.spans {
            let start = block.str_offset_start + utf8_to_utf16(&block.text, sp.start);
            let end = block.str_offset_start + utf8_to_utf16(&block.text, sp.end);
            dialogue_spans.push(Utf16Range { start, end });
        }
        if let Some(open_byte) = scan.unterminated_open {
            // The English convention for multi-paragraph speech omits the
            // closing quote and re-opens the next paragraph with a quote. If
            // the next block starts with an opening quote, treat this as that
            // convention (not an error). Otherwise it is a dangling quote.
            let next_reopens = blocks
                .get(idx + 1)
                .map(|b| en::leading_open_quote(&b.text).is_some())
                .unwrap_or(false);
            if !next_reopens {
                let start = block.str_offset_start + utf8_to_utf16(&block.text, open_byte);
                let end = block.str_offset_start + utf8_to_utf16(&block.text, block.text.len());
                unclosed.push(Utf16Range { start, end });
            }
        }
    }

    DialogueAnalysis {
        dialogue_spans,
        unclosed,
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
    use crate::rule::BlockKind;

    fn block(id: u32, text: &str, off: u32) -> LintBlock {
        LintBlock {
            id,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: off,
        }
    }

    #[test]
    fn marks_dialogue_span() {
        let blocks = [block(0, r#"He said "hello" to her."#, 0)];
        let a = analyze_dialogue(&blocks);
        assert_eq!(a.dialogue_spans().len(), 1);
        assert!(a.unclosed_ranges().is_empty());
        // "hello" with quotes spans utf16 8..15.
        assert!(a.overlaps(&Utf16Range { start: 9, end: 10 }));
        assert!(!a.overlaps(&Utf16Range { start: 0, end: 2 }));
    }

    #[test]
    fn genuine_unclosed_flagged() {
        let blocks = [
            block(0, r#"She said, "It was dark"#, 0),
            block(1, "Then nothing happened.", 30),
        ];
        let a = analyze_dialogue(&blocks);
        // Next block does not re-open → unclosed.
        assert_eq!(a.unclosed_ranges().len(), 1);
    }

    #[test]
    fn paragraph_spanning_convention_not_flagged() {
        let blocks = [
            block(0, r#""This is a long speech that runs on"#, 0),
            block(1, r#""and continues here," he said."#, 40),
        ];
        let a = analyze_dialogue(&blocks);
        // Next block re-opens with a quote → convention, not an error.
        assert!(a.unclosed_ranges().is_empty());
    }
}
