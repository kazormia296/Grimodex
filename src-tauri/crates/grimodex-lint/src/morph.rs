//! Morphological analyser wrapper.
//!
//! Phase 2 introduces UniDic (via lindera) for rules that need to reason
//! about parts of speech or lemmas (`ja/particle-no-chain`, 冗長表現, 同
//! 語近接反復, etc.). The dictionary is compiled into the binary through
//! the `embed-unidic` feature, so initialisation cannot fail for a
//! reason other than a lindera-internal bug.
//!
//! The engine calls [`tokenize_blocks`] **once per lint request**, and
//! shares the token arrays with every rule that declares
//! `requires_morphology()`. This is the kernel of the 1-pass optimisation
//! mentioned in the design doc (§Phase 2 で検討すべきパフォーマンス課題).

use std::sync::OnceLock;

use lindera::dictionary::{load_dictionary_from_kind, DictionaryKind};
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera::tokenizer::Tokenizer;

use crate::rule::{BlockKind, LintBlock};

/// Part of speech fields relevant to the current Phase 2 rule set.
///
/// UniDic details is a 21-entry Vec. We only keep what rules need today
/// — everything else can be added to this struct without breaking the
/// wire format, since tokens never leave the Rust side.
#[derive(Debug, Clone)]
pub struct MorphToken {
    /// Surface form as it appears in the source text.
    pub surface: String,
    /// UTF-8 byte offset of `surface` inside the containing block's
    /// `LintBlock.text`.
    pub byte_start: usize,
    /// UTF-8 byte offset (exclusive).
    pub byte_end: usize,
    /// UniDic 品詞大分類 (details[0]). "名詞" / "助詞" / "動詞" / ...
    pub pos_major: String,
    /// UniDic 品詞中分類 (details[1]). "格助詞" / "普通名詞" / ...
    pub pos_sub1: String,
    /// UniDic 語彙素 (details[7]). Base form for deduplication across
    /// inflections. Empty for unknown tokens.
    pub lemma: String,
}

static TOKENIZER: OnceLock<Result<Tokenizer, String>> = OnceLock::new();

/// Get (or lazily initialise) the global UniDic tokenizer.
///
/// Returns `Err(message)` if the embedded dictionary cannot be loaded —
/// which should be impossible for `embed-unidic`, but we surface the
/// error rather than `unwrap`.
fn tokenizer() -> Result<&'static Tokenizer, &'static str> {
    let slot = TOKENIZER.get_or_init(|| {
        let dict = load_dictionary_from_kind(DictionaryKind::UniDic)
            .map_err(|e| format!("load UniDic dictionary: {e}"))?;
        let segmenter = Segmenter::new(Mode::Normal, dict, None);
        Ok(Tokenizer::new(segmenter))
    });
    slot.as_ref().map_err(|s| s.as_str())
}

/// UniDic details field index for 語彙素 (lemma).
///
/// UniDic's details are ordered: [pos1, pos2, pos3, pos4, cType, cForm,
/// lForm, lemma, orth, pron, orthBase, pronBase, goshu, ...]. Lemma is
/// at index 7.
const UNIDIC_LEMMA_INDEX: usize = 7;

fn detail_at(details: &[&str], idx: usize) -> String {
    details
        .get(idx)
        .map(|s| (*s).to_string())
        .unwrap_or_default()
}

/// Tokenize a single block's text with UniDic.
///
/// Errors from lindera are propagated as owned strings; the engine
/// converts them into a single `RuleWarning` for the morphology rule
/// family rather than failing the whole lint run.
pub fn tokenize_block(text: &str) -> Result<Vec<MorphToken>, String> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let tok = tokenizer().map_err(|s| s.to_string())?;
    let mut lindera_tokens = tok
        .tokenize(text)
        .map_err(|e| format!("lindera tokenize: {e}"))?;
    let mut out = Vec::with_capacity(lindera_tokens.len());
    for t in lindera_tokens.iter_mut() {
        let details = t.details();
        let pos_major = detail_at(&details, 0);
        let pos_sub1 = detail_at(&details, 1);
        let lemma = detail_at(&details, UNIDIC_LEMMA_INDEX);
        out.push(MorphToken {
            surface: t.text.to_string(),
            byte_start: t.byte_start,
            byte_end: t.byte_end,
            pos_major,
            pos_sub1,
            lemma,
        });
    }
    Ok(out)
}

/// Tokenize every block in a lint request. Blocks whose kind is
/// excluded from morphology-aware rules (e.g. headings, future code-
/// like kinds) still get tokenised for consistency — skipping is a
/// per-rule concern driven by `supported_block_kinds`.
///
/// Returns a vector of the same length and order as `blocks`.
pub fn tokenize_blocks(blocks: &[LintBlock]) -> Result<Vec<Vec<MorphToken>>, String> {
    let mut out = Vec::with_capacity(blocks.len());
    for b in blocks {
        let tokens = match b.kind {
            // Headings rarely have grammatical chains we care about, but
            // tokenising them is cheap and lets future rules (e.g.
            // heading-specific style checks) re-use the same cache.
            BlockKind::Paragraph
            | BlockKind::Heading
            | BlockKind::Blockquote
            | BlockKind::ListItem
            | BlockKind::TableCell => tokenize_block(&b.text)?,
        };
        out.push(tokens);
    }
    Ok(out)
}
