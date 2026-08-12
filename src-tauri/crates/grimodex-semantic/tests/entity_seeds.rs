use grimodex_semantic::entity_seeds::{
    extract_codex_entity_seeds, CanonicalRangeV1, EntitySeedCanonicalSourceV1,
    ExtractCodexEntitySeedsRequestV1,
};
use unicode_normalization::UnicodeNormalization;

const SCHEMA_VERSION: u32 = 1;
const NORMALIZER_VERSION: &str = "gdx-canonical-text/1";

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

fn source(
    source_ref: &str,
    document_ref: &str,
    document_start: u32,
    text: &str,
) -> EntitySeedCanonicalSourceV1 {
    EntitySeedCanonicalSourceV1 {
        source_ref: source_ref.to_string(),
        document_ref: document_ref.to_string(),
        document_range: CanonicalRangeV1 {
            start: document_start,
            end: document_start + utf16_len(text),
        },
        text: text.to_string(),
    }
}

fn request(
    language: &str,
    minimum_occurrence_count: u32,
    sources: Vec<EntitySeedCanonicalSourceV1>,
) -> ExtractCodexEntitySeedsRequestV1 {
    ExtractCodexEntitySeedsRequestV1 {
        schema_version: SCHEMA_VERSION,
        normalizer_version: NORMALIZER_VERSION.to_string(),
        language: language.to_string(),
        minimum_occurrence_count,
        sources,
    }
}

#[test]
fn aggregates_the_same_surface_across_opaque_source_refs_without_losing_occurrences() {
    let first_ref = "urn:gdx:source/%2Fchapter-a?window=1#根拠";
    let second_ref = "opaque:import-staging:7f3a/scene:beta";
    let response = extract_codex_entity_seeds(&request(
        "ja",
        1,
        vec![
            source(first_ref, "doc:alpha", 0, "京都へ向かった。"),
            source(second_ref, "doc:beta", 0, "翌朝、京都に着いた。"),
        ],
    ))
    .expect("canonical entity seed extraction should succeed");

    assert_eq!(response.schema_version, SCHEMA_VERSION);
    let kyoto = response
        .seeds
        .iter()
        .find(|seed| seed.surface == "京都")
        .expect("京都 should be emitted as one aggregated seed");
    assert_eq!(kyoto.normalized_surface, "京都");
    assert_eq!(kyoto.features.occurrence_count, 2);
    assert_eq!(kyoto.occurrences.len(), 2);
    assert_eq!(kyoto.occurrences[0].source_ref, first_ref);
    assert_eq!(kyoto.occurrences[1].source_ref, second_ref);
    assert!(kyoto
        .occurrences
        .iter()
        .all(|occurrence| occurrence.quote == "京都"));
}

#[test]
fn reports_document_global_utf16_ranges_when_an_emoji_precedes_the_mention() {
    let text = "🎉京都へ行った。";
    let response = extract_codex_entity_seeds(&request(
        "ja",
        1,
        vec![source("source:emoji", "doc:emoji", 40, text)],
    ))
    .expect("canonical entity seed extraction should succeed");

    let occurrence = &response
        .seeds
        .iter()
        .find(|seed| seed.surface == "京都")
        .expect("京都 should be extracted")
        .occurrences[0];
    assert_eq!(occurrence.quote, "京都");
    assert_eq!(
        occurrence.canonical_range.start, 42,
        "the emoji occupies two UTF-16 code units and documentRange.start must be added",
    );
    assert_eq!(occurrence.canonical_range.end, 44);
}

#[test]
fn keeps_the_original_nfd_surface_and_quote_while_normalizing_only_the_group_key() {
    let nfd_name = "カ\u{3099}ンタ\u{3099}ム";
    let normalized_name: String = nfd_name.nfc().collect();
    assert_ne!(nfd_name, normalized_name, "fixture must be decomposed");
    let text = format!("{nfd_name}が来た。");

    let response = extract_codex_entity_seeds(&request(
        "ja",
        1,
        vec![source("source:nfd", "doc:nfd", 0, &text)],
    ))
    .expect("canonical entity seed extraction should succeed");

    let seed = response
        .seeds
        .iter()
        .find(|seed| seed.normalized_surface == normalized_name)
        .expect("the decomposed proper name should be extracted");
    assert_eq!(seed.surface, nfd_name);
    assert_eq!(seed.occurrences[0].quote, nfd_name);
    assert_eq!(seed.occurrences[0].canonical_range.start, 0);
    assert_eq!(seed.occurrences[0].canonical_range.end, utf16_len(nfd_name),);
}

#[test]
fn maps_evidence_after_canonically_reordered_combining_marks_to_the_original_boundary() {
    // U+0315 (ccc=232) precedes U+0300 (ccc=230), so NFC reorders the marks
    // and composes A + grave. The following proper name must still anchor
    // after all three original UTF-16 units rather than an intermediate NFC
    // scalar boundary.
    let reordered_prefix = "A\u{0315}\u{0300}";
    let text = format!("{reordered_prefix}京都へ行った。");
    let response = extract_codex_entity_seeds(&request(
        "ja",
        1,
        vec![source("source:reordered", "doc:reordered", 20, &text)],
    ))
    .expect("canonical reordering must retain an evidence-safe original boundary");

    let occurrence = &response
        .seeds
        .iter()
        .find(|seed| seed.surface == "京都")
        .expect("京都 should be extracted after the reordered grapheme")
        .occurrences[0];
    assert_eq!(occurrence.quote, "京都");
    assert_eq!(occurrence.canonical_range.start, 23);
    assert_eq!(occurrence.canonical_range.end, 25);
}

#[test]
fn applies_the_requested_minimum_occurrence_count_without_truncating_matches() {
    let once = extract_codex_entity_seeds(&request(
        "ja",
        2,
        vec![source(
            "source:minimum-once",
            "doc:minimum-once",
            0,
            "京都へ行った。",
        )],
    ))
    .expect("canonical entity seed extraction should succeed");
    assert!(once.seeds.iter().all(|seed| seed.surface != "京都"));

    let twice = extract_codex_entity_seeds(&request(
        "ja",
        2,
        vec![source(
            "source:minimum-twice",
            "doc:minimum-twice",
            0,
            "京都から京都へ戻った。",
        )],
    ))
    .expect("canonical entity seed extraction should succeed");
    let kyoto = twice
        .seeds
        .iter()
        .find(|seed| seed.surface == "京都")
        .expect("two occurrences should satisfy the minimum");
    assert_eq!(kyoto.occurrences.len(), 2);
    assert_eq!(kyoto.features.occurrence_count, 2);
}

fn deterministic_request() -> ExtractCodexEntitySeedsRequestV1 {
    request(
        "ja",
        1,
        vec![source(
            "source:deterministic",
            "doc:deterministic",
            0,
            "東京から京都へ行った。京都で東京に会い、京都へ戻った。",
        )],
    )
}

#[test]
fn seed_ids_and_output_order_are_deterministic() {
    let first = extract_codex_entity_seeds(&deterministic_request())
        .expect("first extraction should succeed");
    let replay = extract_codex_entity_seeds(&deterministic_request())
        .expect("replayed extraction should succeed");

    let first_identity_order = first
        .seeds
        .iter()
        .map(|seed| (seed.seed_id.clone(), seed.surface.clone()))
        .collect::<Vec<_>>();
    let replay_identity_order = replay
        .seeds
        .iter()
        .map(|seed| (seed.seed_id.clone(), seed.surface.clone()))
        .collect::<Vec<_>>();
    assert_eq!(first_identity_order, replay_identity_order);
    assert!(first.seeds.iter().all(|seed| !seed.seed_id.is_empty()));
    assert_eq!(
        first.seeds.first().map(|seed| seed.surface.as_str()),
        Some("京都"),
        "higher occurrence count should remain the primary deterministic ordering key",
    );
}

#[test]
fn non_japanese_requests_return_an_explicit_empty_success_response() {
    let response = extract_codex_entity_seeds(&request(
        "en",
        1,
        vec![source(
            "source:unsupported-language",
            "doc:unsupported-language",
            0,
            "京都から京都へ。",
        )],
    ))
    .expect("unsupported language remains a successful, explicit empty result");

    assert_eq!(response.schema_version, SCHEMA_VERSION);
    assert!(response.seeds.is_empty());
}

#[test]
fn accepts_a_literal_unicode_replacement_character_in_canonical_text() {
    let response = extract_codex_entity_seeds(&request(
        "en",
        1,
        vec![source(
            "source:literal-replacement-character",
            "doc:literal-replacement-character",
            0,
            "a literal \u{fffd} remains valid canonical text",
        )],
    ))
    .expect("a valid Unicode scalar U+FFFD must not be mistaken for a lone surrogate");

    assert_eq!(response.schema_version, SCHEMA_VERSION);
    assert!(response.seeds.is_empty());
}

#[test]
fn rejects_unknown_dto_fields_and_invalid_request_invariants() {
    let unknown_field = serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "normalizerVersion": NORMALIZER_VERSION,
        "language": "ja",
        "minimumOccurrenceCount": 1,
        "sources": [],
        "unexpected": true,
    });
    assert!(
        serde_json::from_value::<ExtractCodexEntitySeedsRequestV1>(unknown_field).is_err(),
        "the public DTO must deny unknown fields",
    );

    let mut invalid_schema = request("ja", 1, Vec::new());
    invalid_schema.schema_version = 2;
    assert!(extract_codex_entity_seeds(&invalid_schema).is_err());

    let mut invalid_normalizer = request("ja", 1, Vec::new());
    invalid_normalizer.normalizer_version = "other-normalizer/1".to_string();
    assert!(extract_codex_entity_seeds(&invalid_normalizer).is_err());

    assert!(extract_codex_entity_seeds(&request("ja", 0, Vec::new())).is_err());

    let blank_ref = request("ja", 1, vec![source("", "doc:blank-ref", 0, "京都")]);
    assert!(extract_codex_entity_seeds(&blank_ref).is_err());

    let mut mismatched_range = source("source:bad-range", "doc:bad-range", 0, "京都");
    mismatched_range.document_range.end += 1;
    assert!(
        extract_codex_entity_seeds(&request("ja", 1, vec![mismatched_range])).is_err(),
        "documentRange must exactly cover text in UTF-16 units",
    );

    let duplicate_source_ref = request(
        "ja",
        1,
        vec![
            source("source:duplicate", "doc:a", 0, "京都"),
            source("source:duplicate", "doc:b", 0, "東京"),
        ],
    );
    assert!(extract_codex_entity_seeds(&duplicate_source_ref).is_err());
}

#[test]
fn rejects_source_and_request_size_limit_overruns_before_tokenization() {
    let too_many_sources = (0..901)
        .map(|index| source(&format!("source:{index}"), &format!("doc:{index}"), 0, ""))
        .collect();
    assert!(
        extract_codex_entity_seeds(&request("ja", 1, too_many_sources)).is_err(),
        "at most 900 canonical sources are accepted",
    );

    let oversized_text = "あ".repeat((8 * 1024 * 1024 / "あ".len()) + 1);
    let oversized = request(
        "ja",
        1,
        vec![source(
            "source:oversized",
            "doc:oversized",
            0,
            &oversized_text,
        )],
    );
    assert!(
        extract_codex_entity_seeds(&oversized).is_err(),
        "the canonical request budget is at most 8 MiB",
    );

    let escape_expanded_text = "\n".repeat((4 * 1024 * 1024) + 1);
    let escape_expanded = request(
        "ja",
        1,
        vec![source(
            "source:escape-expanded",
            "doc:escape-expanded",
            0,
            &escape_expanded_text,
        )],
    );
    assert!(
        extract_codex_entity_seeds(&escape_expanded).is_err(),
        "the request budget is measured from exact serialized JSON bytes, including escapes",
    );

    let oversized_utf8_ref = "界".repeat(342);
    let oversized_ref_request = request(
        "ja",
        1,
        vec![source(&oversized_utf8_ref, "doc:oversized-ref", 0, "京都")],
    );
    assert!(
        extract_codex_entity_seeds(&oversized_ref_request).is_err(),
        "opaque ref limits are counted in UTF-8 bytes",
    );
}
