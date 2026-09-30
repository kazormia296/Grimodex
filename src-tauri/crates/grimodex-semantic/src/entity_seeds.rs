//! Deterministic proper-name seed extraction over canonical source views.
//!
//! The public entry point is deliberately independent from a workspace or a
//! database. Callers provide immutable canonical text plus opaque source and
//! document references; the extractor returns source-grounded UTF-16 evidence.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use anyhow::{bail, Context, Result};
use grimodex_lint::morph::{tokenize_block, MorphToken};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::{is_nfc, UnicodeNormalization};
use unicode_segmentation::UnicodeSegmentation;

pub const ENTITY_SEED_SCHEMA_VERSION_V1: u32 = 1;
pub const ENTITY_SEED_NORMALIZER_VERSION_V1: &str = "gdx-canonical-text/1";

const MAX_SOURCE_COUNT: usize = 900;
const MAX_REQUEST_WIRE_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_WIRE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REF_BYTES: usize = 1024;
const MAX_LANGUAGE_BYTES: usize = 64;
const MAX_DISTINCT_SEEDS: usize = 10_000;
const MAX_TOTAL_OCCURRENCES: usize = 100_000;
const MAX_ENTITY_TEXT_UTF16_UNITS: usize = 4096;
const MAX_CONTEXT_UTF16_UNITS: u32 = 64;
const LEGACY_CONTEXT_RADIUS_CHARS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalRangeV1 {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntitySeedCanonicalSourceV1 {
    pub source_ref: String,
    pub document_ref: String,
    pub document_range: CanonicalRangeV1,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractCodexEntitySeedsRequestV1 {
    pub schema_version: u32,
    pub normalizer_version: String,
    pub language: String,
    pub minimum_occurrence_count: u32,
    pub sources: Vec<EntitySeedCanonicalSourceV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySeedContextV1 {
    pub prefix: String,
    pub suffix: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySeedOccurrenceV1 {
    pub source_ref: String,
    pub quote: String,
    pub canonical_range: CanonicalRangeV1,
    pub context: EntitySeedContextV1,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySeedFeaturesV1 {
    pub occurrence_count: u32,
    pub appears_as_proper_name: bool,
    pub appears_in_dialogue: bool,
    pub appears_in_narration: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeterministicEntitySeedV1 {
    pub seed_id: String,
    pub surface: String,
    pub normalized_surface: String,
    pub occurrences: Vec<EntitySeedOccurrenceV1>,
    pub features: EntitySeedFeaturesV1,
    #[serde(skip)]
    legacy_surface: String,
    #[serde(skip)]
    legacy_lemma: String,
    #[serde(skip)]
    legacy_context: String,
    #[serde(skip)]
    legacy_count: usize,
    #[serde(skip)]
    legacy_first_source_ref: String,
}

impl DeterministicEntitySeedV1 {
    pub(crate) fn legacy_surface(&self) -> &str {
        &self.legacy_surface
    }

    pub(crate) fn legacy_lemma(&self) -> &str {
        &self.legacy_lemma
    }

    pub(crate) fn legacy_context(&self) -> &str {
        &self.legacy_context
    }

    pub(crate) fn legacy_count(&self) -> usize {
        self.legacy_count
    }

    pub(crate) fn legacy_first_source_ref(&self) -> &str {
        &self.legacy_first_source_ref
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractCodexEntitySeedsResponseV1 {
    pub schema_version: u32,
    pub seeds: Vec<DeterministicEntitySeedV1>,
}

#[derive(Clone, Copy)]
struct ExtractionPolicy {
    strict_wire_limits: bool,
    output_caps: bool,
    tokenization_fail_soft: bool,
}

const PUBLIC_POLICY: ExtractionPolicy = ExtractionPolicy {
    strict_wire_limits: true,
    output_caps: true,
    tokenization_fail_soft: false,
};

const LEGACY_POLICY: ExtractionPolicy = ExtractionPolicy {
    strict_wire_limits: false,
    output_caps: false,
    tokenization_fail_soft: true,
};

#[derive(Clone, Copy)]
struct OriginalBoundary {
    byte: u32,
    original_utf16: u32,
}

#[derive(Clone, Copy)]
struct DialogueInterval {
    start_char: usize,
    end_char: usize,
}

struct OriginalTextIndex {
    boundaries: Vec<OriginalBoundary>,
    sentence_breaks: Vec<usize>,
    dialogue_intervals: Vec<DialogueInterval>,
}

impl OriginalTextIndex {
    fn new(text: &str) -> Result<Self> {
        const TERMINATORS: [char; 6] = ['。', '！', '？', '!', '?', '\n'];
        let mut boundaries = Vec::new();
        let mut sentence_breaks = vec![0usize];
        let mut dialogue_intervals = Vec::new();
        let mut dialogue_start = None;
        let mut japanese_depth = 0usize;
        let mut curly_depth = 0usize;
        let mut ascii_quote_open = false;
        let mut original_utf16 = 0u32;
        boundaries.push(OriginalBoundary {
            byte: 0,
            original_utf16,
        });
        for (char_index, (byte_start, ch)) in text.char_indices().enumerate() {
            let next_byte = byte_start + ch.len_utf8();
            original_utf16 = original_utf16
                .checked_add(ch.len_utf16() as u32)
                .context("source UTF-16 length overflow")?;
            boundaries.push(OriginalBoundary {
                byte: u32::try_from(next_byte).context("source UTF-8 length exceeds u32")?,
                original_utf16,
            });
            if TERMINATORS.contains(&ch) {
                sentence_breaks.push(char_index + 1);
            }

            let was_in_dialogue = japanese_depth > 0 || curly_depth > 0 || ascii_quote_open;
            match ch {
                '「' | '『' => japanese_depth = japanese_depth.saturating_add(1),
                '」' | '』' => japanese_depth = japanese_depth.saturating_sub(1),
                '“' => curly_depth = curly_depth.saturating_add(1),
                '”' => curly_depth = curly_depth.saturating_sub(1),
                '"' => ascii_quote_open = !ascii_quote_open,
                _ => {}
            }
            let is_in_dialogue = japanese_depth > 0 || curly_depth > 0 || ascii_quote_open;
            if !was_in_dialogue && is_in_dialogue {
                dialogue_start = Some(char_index + 1);
            } else if was_in_dialogue && !is_in_dialogue {
                if let Some(start_char) = dialogue_start.take() {
                    dialogue_intervals.push(DialogueInterval {
                        start_char,
                        end_char: char_index,
                    });
                }
            }
        }
        if let Some(start_char) = dialogue_start {
            dialogue_intervals.push(DialogueInterval {
                start_char,
                end_char: boundaries.len().saturating_sub(1),
            });
        }

        Ok(Self {
            boundaries,
            sentence_breaks,
            dialogue_intervals,
        })
    }

    fn char_count(&self) -> usize {
        self.boundaries.len().saturating_sub(1)
    }

    fn at_char(&self, char_index: usize) -> Result<OriginalBoundary> {
        self.boundaries
            .get(char_index)
            .copied()
            .context("missing original character boundary")
    }

    fn at_byte(&self, byte: usize) -> Result<(usize, OriginalBoundary)> {
        let byte = u32::try_from(byte).context("normalized byte offset exceeds u32")?;
        let char_index = self
            .boundaries
            .binary_search_by_key(&byte, |boundary| boundary.byte)
            .map_err(|_| anyhow::anyhow!("token offset is not an original character boundary"))?;
        Ok((char_index, self.at_char(char_index)?))
    }

    fn context_offsets(
        &self,
        text: &str,
        start_char: usize,
        end_char: usize,
    ) -> Result<ContextOffsets> {
        let start = self.at_char(start_char)?;
        let end = self.at_char(end_char)?;
        let sentence_start = self
            .sentence_breaks
            .partition_point(|&boundary| boundary <= start_char)
            .checked_sub(1)
            .and_then(|index| self.sentence_breaks.get(index).copied())
            .unwrap_or(0);
        let sentence_end = self
            .sentence_breaks
            .partition_point(|&boundary| boundary < end_char);
        let sentence_end = self
            .sentence_breaks
            .get(sentence_end)
            .copied()
            .unwrap_or_else(|| self.char_count());

        let minimum_prefix_utf16 = start.original_utf16.saturating_sub(MAX_CONTEXT_UTF16_UNITS);
        let prefix_limit = self.boundaries[..=start_char]
            .partition_point(|boundary| boundary.original_utf16 < minimum_prefix_utf16)
            .min(start_char);
        let prefix_start = sentence_start.max(prefix_limit);

        let maximum_suffix_utf16 = end.original_utf16.saturating_add(MAX_CONTEXT_UTF16_UNITS);
        let suffix_limit = self
            .boundaries
            .partition_point(|boundary| boundary.original_utf16 <= maximum_suffix_utf16)
            .saturating_sub(1)
            .max(end_char);
        let suffix_end = sentence_end.min(suffix_limit);

        let prefix_start_byte = self.at_char(prefix_start)?.byte as usize;
        let suffix_end_byte = self.at_char(suffix_end)?.byte as usize;
        let prefix = text
            .get(prefix_start_byte..start.byte as usize)
            .context("invalid original prefix boundary")?;
        let trimmed_prefix = prefix.trim_start();
        let prefix_start_byte = prefix_start_byte
            .checked_add(prefix.len().saturating_sub(trimmed_prefix.len()))
            .context("entity seed prefix offset overflow")?;
        let suffix = text
            .get(end.byte as usize..suffix_end_byte)
            .context("invalid original suffix boundary")?;
        let suffix_end_byte = (end.byte as usize)
            .checked_add(suffix.trim_end().len())
            .context("entity seed suffix offset overflow")?;
        Ok(ContextOffsets {
            prefix_start: u32::try_from(prefix_start_byte)
                .context("entity seed prefix start exceeds u32")?,
            prefix_end: start.byte,
            suffix_start: end.byte,
            suffix_end: u32::try_from(suffix_end_byte)
                .context("entity seed suffix end exceeds u32")?,
        })
    }

    fn legacy_context_window(
        &self,
        text: &str,
        start_char: usize,
        end_char: usize,
    ) -> Result<String> {
        let sentence_start = self
            .sentence_breaks
            .partition_point(|&boundary| boundary <= start_char)
            .checked_sub(1)
            .and_then(|index| self.sentence_breaks.get(index).copied())
            .unwrap_or(0);
        let sentence_end = self
            .sentence_breaks
            .partition_point(|&boundary| boundary < end_char);
        let sentence_end = self
            .sentence_breaks
            .get(sentence_end)
            .copied()
            .unwrap_or_else(|| self.char_count());
        let context_start =
            sentence_start.max(start_char.saturating_sub(LEGACY_CONTEXT_RADIUS_CHARS));
        let context_end = sentence_end.min(
            end_char
                .saturating_add(LEGACY_CONTEXT_RADIUS_CHARS)
                .min(self.char_count()),
        );
        let start_byte = self.at_char(context_start)?.byte as usize;
        let end_byte = self.at_char(context_end)?.byte as usize;
        Ok(text
            .get(start_byte..end_byte)
            .context("invalid legacy context boundary")?
            .trim()
            .to_string())
    }

    fn is_dialogue_position(&self, char_index: usize) -> bool {
        self.dialogue_intervals
            .partition_point(|interval| interval.start_char <= char_index)
            .checked_sub(1)
            .and_then(|index| self.dialogue_intervals.get(index))
            .is_some_and(|interval| char_index < interval.end_char)
    }
}

#[derive(Clone, Copy)]
struct NormalizedBoundaryMapping {
    normalized_byte: u32,
    original_char_index: u32,
}

struct MappedOriginalBoundary {
    original_byte: u32,
    original_utf16: u32,
    original_char_index: usize,
}

struct NormalizedSource<'a> {
    normalized_text: Cow<'a, str>,
    normalized_boundaries: Option<Vec<NormalizedBoundaryMapping>>,
    original_index: OriginalTextIndex,
    normalized_index: Option<OriginalTextIndex>,
}

impl<'a> NormalizedSource<'a> {
    fn new(source: &'a EntitySeedCanonicalSourceV1) -> Result<Self> {
        let original_index = OriginalTextIndex::new(&source.text)?;
        if is_nfc(&source.text) {
            return Ok(Self {
                normalized_text: Cow::Borrowed(&source.text),
                normalized_boundaries: None,
                original_index,
                normalized_index: None,
            });
        }

        let mut normalized_text = String::with_capacity(source.text.len());
        let mut normalized_boundaries = Vec::new();
        let mut original_char_index = 0usize;
        normalized_boundaries.push(NormalizedBoundaryMapping {
            normalized_byte: 0,
            original_char_index: 0,
        });

        for grapheme in source.text.graphemes(true) {
            if is_nfc(grapheme) {
                for ch in grapheme.chars() {
                    normalized_text.push(ch);
                    original_char_index = original_char_index
                        .checked_add(1)
                        .context("NFC alignment index overflow")?;
                    normalized_boundaries.push(NormalizedBoundaryMapping {
                        normalized_byte: u32::try_from(normalized_text.len())
                            .context("normalized UTF-8 length exceeds u32")?,
                        original_char_index: u32::try_from(original_char_index)
                            .context("original character count exceeds u32")?,
                    });
                }
                continue;
            }

            // NFC may reorder non-starters before composing them, so an
            // intermediate normalized scalar does not always correspond to a
            // contiguous original prefix. Treat the complete extended
            // grapheme as the smallest evidence-safe span and expose only its
            // outer boundaries. Lindera is therefore allowed to anchor at a
            // grapheme boundary, but can never produce a silently wrong quote
            // from inside a reordered/composed span.
            normalized_text.extend(grapheme.nfc());
            original_char_index = original_char_index
                .checked_add(grapheme.chars().count())
                .context("NFC alignment index overflow")?;
            normalized_boundaries.push(NormalizedBoundaryMapping {
                normalized_byte: u32::try_from(normalized_text.len())
                    .context("normalized UTF-8 length exceeds u32")?,
                original_char_index: u32::try_from(original_char_index)
                    .context("original character count exceeds u32")?,
            });
        }

        if original_char_index != original_index.char_count() {
            bail!("NFC alignment did not consume the complete original text");
        }

        let normalized_index = OriginalTextIndex::new(&normalized_text)?;
        Ok(Self {
            normalized_text: Cow::Owned(normalized_text),
            normalized_boundaries: Some(normalized_boundaries),
            original_index,
            normalized_index: Some(normalized_index),
        })
    }

    fn boundary(&self, normalized_byte: usize) -> Result<MappedOriginalBoundary> {
        let (original_char_index, original) = match &self.normalized_boundaries {
            None => self.original_index.at_byte(normalized_byte)?,
            Some(boundaries) => {
                let normalized_byte =
                    u32::try_from(normalized_byte).context("normalized byte offset exceeds u32")?;
                let index = boundaries
                    .binary_search_by_key(&normalized_byte, |mapping| mapping.normalized_byte)
                    .map_err(|_| {
                        anyhow::anyhow!("token offset is not an NFC character boundary")
                    })?;
                let original_char_index = boundaries
                    .get(index)
                    .map(|mapping| mapping.original_char_index as usize)
                    .context("missing NFC boundary mapping")?;
                (
                    original_char_index,
                    self.original_index.at_char(original_char_index)?,
                )
            }
        };
        Ok(MappedOriginalBoundary {
            original_byte: original.byte,
            original_utf16: original.original_utf16,
            original_char_index,
        })
    }

    fn legacy_context_window(&self, byte_start: usize, byte_end: usize) -> Result<String> {
        let index = self
            .normalized_index
            .as_ref()
            .unwrap_or(&self.original_index);
        let (start_char, _) = index.at_byte(byte_start)?;
        let (end_char, _) = index.at_byte(byte_end)?;
        index.legacy_context_window(&self.normalized_text, start_char, end_char)
    }
}

struct SeedAggregate {
    surface: String,
    normalized_surface: String,
    legacy_surface: String,
    legacy_lemma: String,
    legacy_context: String,
    first_source_index: usize,
    first_token_index: usize,
    occurrence_count: usize,
    occurrences: Vec<CompactOccurrence>,
    appears_in_dialogue: bool,
    appears_in_narration: bool,
}

#[derive(Clone, Copy)]
struct ContextOffsets {
    prefix_start: u32,
    prefix_end: u32,
    suffix_start: u32,
    suffix_end: u32,
}

impl ContextOffsets {
    fn materialize(&self, text: &str) -> Result<EntitySeedContextV1> {
        let prefix = text
            .get(self.prefix_start as usize..self.prefix_end as usize)
            .context("invalid entity seed prefix slice")?
            .to_string();
        let suffix = text
            .get(self.suffix_start as usize..self.suffix_end as usize)
            .context("invalid entity seed suffix slice")?
            .to_string();
        Ok(EntitySeedContextV1 { prefix, suffix })
    }
}

#[derive(Clone, Copy)]
struct CompactOccurrence {
    source_index: u32,
    quote_start: u32,
    quote_end: u32,
    context: ContextOffsets,
    canonical_start: u32,
    canonical_end: u32,
}

/// Extract source-grounded deterministic entity seeds without consulting a
/// workspace. All untrusted DTO invariants are checked before tokenization.
pub fn extract_codex_entity_seeds(
    request: &ExtractCodexEntitySeedsRequestV1,
) -> Result<ExtractCodexEntitySeedsResponseV1> {
    validate_request(request, PUBLIC_POLICY)?;
    extract_validated(request, &HashSet::new(), PUBLIC_POLICY)
}

/// Compatibility entry point for the legacy project-DB adapter. Its input was
/// already bounded by the trusted database command, so the old command keeps
/// its historical fail-soft tokenization and unbounded project snapshot
/// behavior while sharing the same extraction and aggregation core.
pub(crate) fn extract_codex_entity_seeds_for_legacy(
    request: &ExtractCodexEntitySeedsRequestV1,
    known_names: &HashSet<String>,
) -> Result<ExtractCodexEntitySeedsResponseV1> {
    validate_request(request, LEGACY_POLICY)?;
    extract_validated(request, known_names, LEGACY_POLICY)
}

fn validate_request(
    request: &ExtractCodexEntitySeedsRequestV1,
    policy: ExtractionPolicy,
) -> Result<()> {
    if request.schema_version != ENTITY_SEED_SCHEMA_VERSION_V1 {
        bail!(
            "unsupported entity seed schemaVersion: {}",
            request.schema_version
        );
    }
    if request.normalizer_version != ENTITY_SEED_NORMALIZER_VERSION_V1 {
        bail!(
            "unsupported entity seed normalizerVersion: {}",
            request.normalizer_version
        );
    }
    if request.language.is_empty() || request.language.len() > MAX_LANGUAGE_BYTES {
        bail!("entity seed language must be between 1 and {MAX_LANGUAGE_BYTES} bytes");
    }
    if request.language.chars().any(char::is_control) {
        bail!("entity seed language must not contain control characters");
    }
    if request.minimum_occurrence_count == 0 {
        bail!("minimumOccurrenceCount must be at least 1");
    }
    if policy.strict_wire_limits && request.sources.len() > MAX_SOURCE_COUNT {
        bail!("entity seed sources must contain at most {MAX_SOURCE_COUNT} items");
    }
    if policy.strict_wire_limits {
        let serialized = serde_json::to_vec(request)
            .context("failed to serialize entity seed request for size validation")?;
        if serialized.len() > MAX_REQUEST_WIRE_BYTES {
            bail!("entity seed request exceeds the 8 MiB wire budget");
        }
    }

    let mut source_refs = HashSet::with_capacity(request.sources.len());

    for (index, source) in request.sources.iter().enumerate() {
        if policy.strict_wire_limits {
            validate_ref(&source.source_ref, &format!("sources[{index}].sourceRef"))?;
            validate_ref(
                &source.document_ref,
                &format!("sources[{index}].documentRef"),
            )?;
        }
        if !source_refs.insert(source.source_ref.as_str()) {
            bail!("duplicate entity seed sourceRef at sources[{index}]");
        }
        if source.document_range.end < source.document_range.start {
            bail!("sources[{index}].documentRange end precedes start");
        }
        let text_utf16 = u32::try_from(source.text.encode_utf16().count())
            .context("source text UTF-16 length exceeds u32")?;
        let expected_end = source
            .document_range
            .start
            .checked_add(text_utf16)
            .context("source documentRange overflows u32")?;
        if source.document_range.end != expected_end {
            bail!("sources[{index}].documentRange must exactly cover text in UTF-16 units");
        }
    }

    Ok(())
}

fn validate_ref(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() {
        bail!("{label} must not be blank");
    }
    if value.len() > MAX_REF_BYTES {
        bail!("{label} exceeds {MAX_REF_BYTES} bytes");
    }
    if value.chars().any(char::is_control) {
        bail!("{label} must not contain control characters");
    }
    Ok(())
}

fn json_string_wire_size(value: &str) -> usize {
    value.chars().fold(2usize, |size, ch| {
        let encoded = match ch {
            '"' | '\\' | '\u{0008}' | '\u{000c}' | '\n' | '\r' | '\t' => 2,
            '\u{0000}'..='\u{001f}' => 6,
            _ => ch.len_utf8(),
        };
        size.saturating_add(encoded)
    })
}

fn validate_public_entity_text(quote: &str, normalized_surface: &str) -> Result<()> {
    if quote.encode_utf16().count() > MAX_ENTITY_TEXT_UTF16_UNITS
        || normalized_surface.encode_utf16().count() > MAX_ENTITY_TEXT_UTF16_UNITS
    {
        bail!(
            "entity seed quote and normalizedSurface must each contain at most {MAX_ENTITY_TEXT_UTF16_UNITS} UTF-16 units"
        );
    }
    Ok(())
}

fn extract_validated(
    request: &ExtractCodexEntitySeedsRequestV1,
    known_names: &HashSet<String>,
    policy: ExtractionPolicy,
) -> Result<ExtractCodexEntitySeedsResponseV1> {
    if request.language != "ja"
        || (policy.output_caps && request.minimum_occurrence_count as usize > MAX_TOTAL_OCCURRENCES)
    {
        return Ok(ExtractCodexEntitySeedsResponseV1 {
            schema_version: ENTITY_SEED_SCHEMA_VERSION_V1,
            seeds: Vec::new(),
        });
    }

    let known_patterns: Vec<String> = known_names.iter().cloned().collect();
    let known_matcher = build_name_matcher(&known_patterns);
    let mut aggregates: HashMap<String, SeedAggregate> = HashMap::new();
    let mut total_occurrences = 0usize;

    for (source_index, source) in request.sources.iter().enumerate() {
        let normalized = NormalizedSource::new(source)
            .with_context(|| format!("failed to normalize sourceRef {}", source.source_ref))?;
        let tokens = if normalized.normalized_text.is_empty() {
            Vec::new()
        } else {
            match tokenize_block(&normalized.normalized_text) {
                Ok(tokens) => tokens,
                Err(error) if policy.tokenization_fail_soft => {
                    tracing::warn!(
                        source_ref = %source.source_ref,
                        error = %error,
                        "[entity_seeds] morph tokenize failed; treating source as empty"
                    );
                    Vec::new()
                }
                Err(error) => {
                    bail!(
                        "entity seed tokenization failed for sourceRef {}: {error}",
                        source.source_ref
                    );
                }
            }
        };
        let known_spans =
            name_occurrence_spans(&normalized.normalized_text, known_matcher.as_ref());

        for (token_index, token) in tokens.iter().enumerate() {
            if token.pos_major != "名詞" || token.pos_sub1 != "固有名詞" {
                continue;
            }
            if is_fragment_of_known_name(&known_spans, token.byte_start, token.byte_end) {
                continue;
            }

            let normalized_surface = normalize_entity_name(&token.surface);
            if normalized_surface.is_empty() || known_names.contains(&normalized_surface) {
                continue;
            }

            total_occurrences = total_occurrences
                .checked_add(1)
                .context("entity seed occurrence count overflow")?;
            if policy.output_caps && total_occurrences > MAX_TOTAL_OCCURRENCES {
                bail!(
                    "entity seed extraction work exceeds {MAX_TOTAL_OCCURRENCES} candidate occurrences"
                );
            }

            if !policy.output_caps {
                record_legacy_token(
                    &mut aggregates,
                    &normalized,
                    token,
                    normalized_surface,
                    source_index,
                    token_index,
                )?;
                continue;
            }

            let original_start = normalized.boundary(token.byte_start)?;
            let original_end = normalized.boundary(token.byte_end)?;
            if original_end.original_byte <= original_start.original_byte {
                continue;
            }
            let quote = source
                .text
                .get(original_start.original_byte as usize..original_end.original_byte as usize)
                .context("mapped entity seed quote is not an original UTF-8 boundary")?;
            let canonical_start = source
                .document_range
                .start
                .checked_add(original_start.original_utf16)
                .context("entity seed canonical start overflow")?;
            let canonical_end = source
                .document_range
                .start
                .checked_add(original_end.original_utf16)
                .context("entity seed canonical end overflow")?;
            let context = normalized.original_index.context_offsets(
                &source.text,
                original_start.original_char_index,
                original_end.original_char_index,
            )?;
            let in_dialogue = normalized
                .original_index
                .is_dialogue_position(original_start.original_char_index);

            let is_new_seed = !aggregates.contains_key(&normalized_surface);
            if is_new_seed {
                let legacy_context =
                    normalized.legacy_context_window(token.byte_start, token.byte_end)?;
                aggregates.insert(
                    normalized_surface.clone(),
                    SeedAggregate {
                        surface: quote.to_string(),
                        normalized_surface: normalized_surface.clone(),
                        legacy_surface: token.surface.clone(),
                        legacy_lemma: if token.lemma.is_empty() {
                            token.surface.clone()
                        } else {
                            token.lemma.clone()
                        },
                        legacy_context,
                        first_source_index: source_index,
                        first_token_index: token_index,
                        occurrence_count: 0,
                        occurrences: Vec::new(),
                        appears_in_dialogue: false,
                        appears_in_narration: false,
                    },
                );
            }

            if let Some(aggregate) = aggregates.get_mut(&normalized_surface) {
                aggregate.occurrence_count = aggregate
                    .occurrence_count
                    .checked_add(1)
                    .context("entity seed aggregate occurrence count overflow")?;
                aggregate.occurrences.push(CompactOccurrence {
                    source_index: u32::try_from(source_index)
                        .context("entity seed source index exceeds u32")?,
                    quote_start: original_start.original_byte,
                    quote_end: original_end.original_byte,
                    context,
                    canonical_start,
                    canonical_end,
                });
                aggregate.appears_in_dialogue |= in_dialogue;
                aggregate.appears_in_narration |= !in_dialogue;
            }
        }
    }

    let minimum_occurrence_count = request.minimum_occurrence_count as usize;
    let mut aggregates = filter_seed_aggregates(aggregates, minimum_occurrence_count);
    if policy.output_caps && aggregates.len() > MAX_DISTINCT_SEEDS {
        bail!("entity seed output exceeds {MAX_DISTINCT_SEEDS} distinct seeds");
    }
    aggregates.sort_by(|left, right| {
        right
            .occurrence_count
            .cmp(&left.occurrence_count)
            .then_with(|| left.first_source_index.cmp(&right.first_source_index))
            .then_with(|| left.first_token_index.cmp(&right.first_token_index))
            .then_with(|| left.legacy_surface.cmp(&right.legacy_surface))
            .then_with(|| left.normalized_surface.cmp(&right.normalized_surface))
    });

    if policy.output_caps {
        validate_public_output_text_limits(request, &aggregates)?;
        validate_projected_output_wire_size(request, &aggregates)?;
    }

    let mut seeds = Vec::with_capacity(aggregates.len());
    for aggregate in aggregates {
        let occurrence_count = if policy.output_caps {
            u32::try_from(aggregate.occurrence_count)
                .context("entity seed occurrence count exceeds u32")?
        } else {
            u32::try_from(aggregate.occurrence_count).unwrap_or(u32::MAX)
        };
        let legacy_first_source_ref = request
            .sources
            .get(aggregate.first_source_index)
            .map(|source| source.source_ref.clone())
            .context("entity seed aggregate references a missing first source")?;
        let mut occurrences = Vec::with_capacity(aggregate.occurrences.len());
        for compact in aggregate.occurrences {
            let source = request
                .sources
                .get(compact.source_index as usize)
                .context("entity seed occurrence references a missing source")?;
            let quote = source
                .text
                .get(compact.quote_start as usize..compact.quote_end as usize)
                .context("invalid entity seed quote slice")?
                .to_string();
            occurrences.push(EntitySeedOccurrenceV1 {
                source_ref: source.source_ref.clone(),
                quote,
                canonical_range: CanonicalRangeV1 {
                    start: compact.canonical_start,
                    end: compact.canonical_end,
                },
                context: compact.context.materialize(&source.text)?,
            });
        }
        seeds.push(DeterministicEntitySeedV1 {
            seed_id: deterministic_seed_id(&aggregate.normalized_surface),
            surface: aggregate.surface,
            normalized_surface: aggregate.normalized_surface,
            occurrences,
            features: EntitySeedFeaturesV1 {
                occurrence_count,
                appears_as_proper_name: true,
                appears_in_dialogue: aggregate.appears_in_dialogue,
                appears_in_narration: aggregate.appears_in_narration,
            },
            legacy_surface: aggregate.legacy_surface,
            legacy_lemma: aggregate.legacy_lemma,
            legacy_context: aggregate.legacy_context,
            legacy_count: aggregate.occurrence_count,
            legacy_first_source_ref,
        });
    }

    let response = ExtractCodexEntitySeedsResponseV1 {
        schema_version: ENTITY_SEED_SCHEMA_VERSION_V1,
        seeds,
    };
    if policy.output_caps {
        let serialized = serde_json::to_vec(&response)
            .context("failed to serialize entity seed response for size validation")?;
        if serialized.len() > MAX_OUTPUT_WIRE_BYTES {
            bail!("entity seed response exceeds the 8 MiB wire budget");
        }
    }
    Ok(response)
}

fn record_legacy_token(
    aggregates: &mut HashMap<String, SeedAggregate>,
    normalized: &NormalizedSource<'_>,
    token: &MorphToken,
    normalized_surface: String,
    source_index: usize,
    token_index: usize,
) -> Result<()> {
    if !aggregates.contains_key(&normalized_surface) {
        let legacy_context = normalized.legacy_context_window(token.byte_start, token.byte_end)?;
        aggregates.insert(
            normalized_surface.clone(),
            SeedAggregate {
                surface: token.surface.clone(),
                normalized_surface: normalized_surface.clone(),
                legacy_surface: token.surface.clone(),
                legacy_lemma: if token.lemma.is_empty() {
                    token.surface.clone()
                } else {
                    token.lemma.clone()
                },
                legacy_context,
                first_source_index: source_index,
                first_token_index: token_index,
                occurrence_count: 0,
                occurrences: Vec::new(),
                appears_in_dialogue: false,
                appears_in_narration: true,
            },
        );
    }

    if let Some(aggregate) = aggregates.get_mut(&normalized_surface) {
        aggregate.occurrence_count = aggregate
            .occurrence_count
            .checked_add(1)
            .context("legacy entity seed aggregate occurrence count overflow")?;
    }
    Ok(())
}

fn filter_seed_aggregates(
    aggregates: HashMap<String, SeedAggregate>,
    minimum_occurrence_count: usize,
) -> Vec<SeedAggregate> {
    aggregates
        .into_values()
        .filter(|aggregate| aggregate.occurrence_count >= minimum_occurrence_count)
        .collect()
}

fn validate_public_output_text_limits(
    request: &ExtractCodexEntitySeedsRequestV1,
    aggregates: &[SeedAggregate],
) -> Result<()> {
    for aggregate in aggregates {
        validate_public_entity_text(&aggregate.surface, &aggregate.normalized_surface)?;
        for occurrence in &aggregate.occurrences {
            let source = request
                .sources
                .get(occurrence.source_index as usize)
                .context("entity seed occurrence references a missing source")?;
            let quote = source
                .text
                .get(occurrence.quote_start as usize..occurrence.quote_end as usize)
                .context("invalid entity seed quote slice")?;
            validate_public_entity_text(quote, &aggregate.normalized_surface)?;
        }
    }
    Ok(())
}

fn validate_projected_output_wire_size(
    request: &ExtractCodexEntitySeedsRequestV1,
    aggregates: &[SeedAggregate],
) -> Result<()> {
    let mut projected_wire_bytes = 128usize;
    for aggregate in aggregates {
        projected_wire_bytes = projected_wire_bytes
            .checked_add(320)
            .and_then(|size| size.checked_add(json_string_wire_size(&aggregate.surface)))
            .and_then(|size| size.checked_add(json_string_wire_size(&aggregate.normalized_surface)))
            .context("entity seed output size overflow")?;
        if projected_wire_bytes > MAX_OUTPUT_WIRE_BYTES {
            bail!("entity seed response exceeds the 8 MiB wire budget");
        }

        for occurrence in &aggregate.occurrences {
            let source = request
                .sources
                .get(occurrence.source_index as usize)
                .context("entity seed occurrence references a missing source")?;
            let quote = source
                .text
                .get(occurrence.quote_start as usize..occurrence.quote_end as usize)
                .context("invalid entity seed quote slice")?;
            let prefix = source
                .text
                .get(
                    occurrence.context.prefix_start as usize
                        ..occurrence.context.prefix_end as usize,
                )
                .context("invalid entity seed prefix slice")?;
            let suffix = source
                .text
                .get(
                    occurrence.context.suffix_start as usize
                        ..occurrence.context.suffix_end as usize,
                )
                .context("invalid entity seed suffix slice")?;
            projected_wire_bytes = projected_wire_bytes
                .checked_add(192)
                .and_then(|size| size.checked_add(json_string_wire_size(&source.source_ref)))
                .and_then(|size| size.checked_add(json_string_wire_size(quote)))
                .and_then(|size| size.checked_add(json_string_wire_size(prefix)))
                .and_then(|size| size.checked_add(json_string_wire_size(suffix)))
                .context("entity seed output size overflow")?;
            if projected_wire_bytes > MAX_OUTPUT_WIRE_BYTES {
                bail!("entity seed response exceeds the 8 MiB wire budget");
            }
        }
    }
    Ok(())
}

pub(crate) fn normalize_entity_name(value: &str) -> String {
    value
        .trim()
        .nfc()
        .map(|ch| {
            if ch.is_ascii_uppercase() {
                ch.to_ascii_lowercase()
            } else {
                ch
            }
        })
        .collect()
}

fn deterministic_seed_id(normalized_surface: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"grimodex.entity-seed.v1\0");
    digest.update(normalized_surface.as_bytes());
    format!("entity-seed:v1:{}", hex::encode(digest.finalize()))
}

fn build_name_matcher(patterns: &[String]) -> Option<AhoCorasick> {
    if patterns.is_empty() {
        return None;
    }
    match AhoCorasickBuilder::new()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::Standard)
        .build(patterns)
    {
        Ok(matcher) => Some(matcher),
        Err(error) => {
            tracing::warn!(
                error = %error,
                pattern_count = patterns.len(),
                "[entity_seeds] failed to build known-name matcher; fragment mask disabled"
            );
            None
        }
    }
}

fn name_occurrence_spans(text: &str, matcher: Option<&AhoCorasick>) -> Vec<(usize, usize)> {
    match matcher {
        Some(matcher) if !text.is_empty() => matcher
            .find_overlapping_iter(text)
            .map(|matched| (matched.start(), matched.end()))
            .collect(),
        _ => Vec::new(),
    }
}

fn is_fragment_of_known_name(spans: &[(usize, usize)], byte_start: usize, byte_end: usize) -> bool {
    spans
        .iter()
        .any(|&(start, end)| start <= byte_start && byte_end <= end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_is_clamped_to_utf16_limits_on_scalar_boundaries() {
        let text = format!("{}京都{}", "🎉".repeat(40), "🚀".repeat(40));
        let index = OriginalTextIndex::new(&text).expect("text index should build");
        let start_byte = text.find("京都").expect("fixture contains 京都");
        let end_byte = start_byte + "京都".len();
        let (start_char, _) = index.at_byte(start_byte).expect("start is a boundary");
        let (end_char, _) = index.at_byte(end_byte).expect("end is a boundary");
        let context = index
            .context_offsets(&text, start_char, end_char)
            .and_then(|offsets| offsets.materialize(&text))
            .expect("context should resolve");

        assert!(context.prefix.encode_utf16().count() <= MAX_CONTEXT_UTF16_UNITS as usize);
        assert!(context.suffix.encode_utf16().count() <= MAX_CONTEXT_UTF16_UNITS as usize);
        assert_eq!(context.prefix, "🎉".repeat(32));
        assert_eq!(context.suffix, "🚀".repeat(32));
    }

    #[test]
    fn dialogue_intervals_cover_inline_and_nested_quote_styles() {
        let text = "地の京都。「会話の京都と『東京』」。“奈良”と\"大阪\"。";
        let index = OriginalTextIndex::new(text).expect("text index should build");
        let positions = [
            (text.find("京都").expect("narration 京都"), false),
            (text.rfind("京都").expect("dialogue 京都"), true),
            (text.find("東京").expect("nested 東京"), true),
            (text.find("奈良").expect("curly quote 奈良"), true),
            (text.find("大阪").expect("ASCII quote 大阪"), true),
        ];

        for (byte, expected) in positions {
            let (char_index, _) = index.at_byte(byte).expect("position is a boundary");
            assert_eq!(index.is_dialogue_position(char_index), expected);
        }
    }

    #[test]
    fn reordered_grapheme_exposes_only_evidence_safe_outer_boundaries() {
        let text = "A\u{0315}\u{0300}".to_string();
        let source = EntitySeedCanonicalSourceV1 {
            source_ref: "source:reordered-boundary".to_string(),
            document_ref: "doc:reordered-boundary".to_string(),
            document_range: CanonicalRangeV1 { start: 0, end: 3 },
            text,
        };
        let normalized = NormalizedSource::new(&source).expect("normalization should succeed");
        let interior_normalized_boundary = normalized
            .normalized_text
            .char_indices()
            .nth(1)
            .map(|(byte, _)| byte)
            .expect("fixture normalizes to multiple scalars");

        assert!(normalized.boundary(interior_normalized_boundary).is_err());
        let end = normalized
            .boundary(normalized.normalized_text.len())
            .expect("outer grapheme boundary should map");
        assert_eq!(end.original_byte as usize, source.text.len());
        assert_eq!(end.original_utf16, 3);
        assert_eq!(end.original_char_index, 3);
    }

    #[test]
    fn legacy_token_path_does_not_require_an_unsafe_original_boundary() {
        let text = "山田\u{0315}\u{0300}の旅".to_string();
        let source = EntitySeedCanonicalSourceV1 {
            source_ref: "scene:legacy-reordered".to_string(),
            document_ref: "doc:legacy-reordered".to_string(),
            document_range: CanonicalRangeV1 {
                start: 0,
                end: text.encode_utf16().count() as u32,
            },
            text,
        };
        let normalized = NormalizedSource::new(&source).expect("normalization should succeed");
        let unsafe_end = normalized
            .normalized_text
            .find('\u{0315}')
            .expect("higher-class mark follows the reordered lower-class mark");
        assert!(
            normalized.boundary(unsafe_end).is_err(),
            "the synthetic token ends inside a reordered grapheme"
        );
        let token = MorphToken {
            surface: normalized.normalized_text[..unsafe_end].to_string(),
            byte_start: 0,
            byte_end: unsafe_end,
            pos_major: "名詞".to_string(),
            pos_sub1: "固有名詞".to_string(),
            lemma: String::new(),
        };
        let normalized_surface = normalize_entity_name(&token.surface);
        let mut aggregates = HashMap::new();

        record_legacy_token(
            &mut aggregates,
            &normalized,
            &token,
            normalized_surface.clone(),
            0,
            0,
        )
        .expect("legacy aggregation must not ask for an original evidence boundary");

        let aggregate = aggregates
            .get(&normalized_surface)
            .expect("synthetic legacy token should be aggregated");
        assert_eq!(aggregate.occurrence_count, 1);
        assert_eq!(aggregate.legacy_surface, token.surface);
        assert!(aggregate.legacy_context.contains(&aggregate.legacy_surface));
        assert!(aggregate.occurrences.is_empty());
    }

    #[test]
    fn public_entity_text_limit_counts_utf16_units() {
        let at_limit = "😀".repeat(MAX_ENTITY_TEXT_UTF16_UNITS / 2);
        let over_limit = "😀".repeat((MAX_ENTITY_TEXT_UTF16_UNITS / 2) + 1);

        validate_public_entity_text(&at_limit, &at_limit).expect("4096 UTF-16 units remain valid");
        assert!(validate_public_entity_text(&over_limit, &at_limit).is_err());
        assert!(validate_public_entity_text(&at_limit, &over_limit).is_err());
    }

    #[test]
    fn minimum_filter_discards_overlong_singleton_before_output_validation() {
        let over_limit = "😀".repeat((MAX_ENTITY_TEXT_UTF16_UNITS / 2) + 1);
        let mut aggregates = HashMap::new();
        aggregates.insert(
            over_limit.clone(),
            SeedAggregate {
                surface: over_limit.clone(),
                normalized_surface: over_limit,
                legacy_surface: String::new(),
                legacy_lemma: String::new(),
                legacy_context: String::new(),
                first_source_index: 0,
                first_token_index: 0,
                occurrence_count: 1,
                occurrences: Vec::new(),
                appears_in_dialogue: false,
                appears_in_narration: true,
            },
        );

        let filtered = filter_seed_aggregates(aggregates, 2);
        assert!(filtered.is_empty());
        let request = ExtractCodexEntitySeedsRequestV1 {
            schema_version: ENTITY_SEED_SCHEMA_VERSION_V1,
            normalizer_version: ENTITY_SEED_NORMALIZER_VERSION_V1.to_string(),
            language: "ja".to_string(),
            minimum_occurrence_count: 2,
            sources: Vec::new(),
        };
        validate_public_output_text_limits(&request, &filtered)
            .expect("a minimum-filtered singleton must not reject the run");
    }

    #[test]
    fn legacy_projection_keeps_counts_without_materializing_occurrence_payloads() {
        let text = "京都から京都へ。".to_string();
        let request = ExtractCodexEntitySeedsRequestV1 {
            schema_version: ENTITY_SEED_SCHEMA_VERSION_V1,
            normalizer_version: ENTITY_SEED_NORMALIZER_VERSION_V1.to_string(),
            language: "ja".to_string(),
            minimum_occurrence_count: 2,
            sources: vec![EntitySeedCanonicalSourceV1 {
                source_ref: "scene:legacy".to_string(),
                document_ref: "doc:legacy".to_string(),
                document_range: CanonicalRangeV1 {
                    start: 0,
                    end: text.encode_utf16().count() as u32,
                },
                text,
            }],
        };

        let response = extract_codex_entity_seeds_for_legacy(&request, &HashSet::new())
            .expect("legacy extraction should succeed");
        let kyoto = response
            .seeds
            .iter()
            .find(|seed| seed.legacy_surface() == "京都")
            .expect("京都 should be retained");
        assert_eq!(kyoto.legacy_count(), 2);
        assert_eq!(kyoto.legacy_first_source_ref(), "scene:legacy");
        assert_eq!(kyoto.features.occurrence_count, 2);
        assert!(kyoto.occurrences.is_empty());
    }
}
