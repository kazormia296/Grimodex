use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_scope_authority_basis::{
    canonical_narrative_source_snapshot_revision_input, canonical_reading_order_revision_input,
    canonical_scope_authority_digest_input, canonical_scope_registry_revision_input,
    canonical_story_time_order_revision_input, NarrativeScopeAuthorityBasisV2,
    NarrativeScopeAuthoritySourceDocumentV2, NarrativeScopeAuthorityTrustedContextV2,
};
use serde::Serialize;
use serde_json::json;

const GOLDEN: &str = include_str!(
    "../../../../policies/narrative/fixtures/narrative-ir/scope-authority-basis-v2.json"
);

fn golden() -> NarrativeScopeAuthorityBasisV2 {
    serde_json::from_str(GOLDEN).expect("scope authority basis v2 golden parses")
}

fn trusted_documents() -> Vec<NarrativeScopeAuthoritySourceDocumentV2> {
    vec![
        NarrativeScopeAuthoritySourceDocumentV2 {
            document_ref: "D000001".to_owned(),
            source_key: "project:scene:\u{e000}".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "\u{e000}".to_owned(),
        },
        NarrativeScopeAuthoritySourceDocumentV2 {
            document_ref: "D000002".to_owned(),
            source_key: "project:scene:\u{1f600}".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "\u{1f600}".to_owned(),
        },
        NarrativeScopeAuthoritySourceDocumentV2 {
            document_ref: "D000003".to_owned(),
            source_key: "project:scene:scene-three".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "scene-three".to_owned(),
        },
        NarrativeScopeAuthoritySourceDocumentV2 {
            document_ref: "D000004".to_owned(),
            source_key: "project:scene:scene-four".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "scene-four".to_owned(),
        },
        NarrativeScopeAuthoritySourceDocumentV2 {
            document_ref: "D000005".to_owned(),
            source_key: "project:scene:scene-five".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "scene-five".to_owned(),
        },
    ]
}

fn digest<T: Serialize>(value: &T) -> String {
    canonical_json_digest(&serde_json::to_value(value).expect("projection serializes"))
        .expect("projection canonicalizes")
}

fn reseal(mut fixture: NarrativeScopeAuthorityBasisV2) -> NarrativeScopeAuthorityBasisV2 {
    fixture.digests.scope_registry_revision =
        digest(&canonical_scope_registry_revision_input(&fixture));
    fixture.digests.reading_order_revision =
        digest(&canonical_reading_order_revision_input(&fixture));
    fixture.digests.story_time_order_revision =
        digest(&canonical_story_time_order_revision_input(&fixture));
    fixture.digests.authority_digest = digest(&canonical_scope_authority_digest_input(&fixture));
    fixture.digests.composite_digest = digest(&canonical_narrative_source_snapshot_revision_input(
        &fixture,
    ));
    fixture
}

fn assert_invalid_contains(fixture: &NarrativeScopeAuthorityBasisV2, expected: &str) {
    let error = fixture.validate().expect_err("fixture must fail closed");
    assert!(
        error.to_string().contains(expected),
        "expected {expected:?}, observed {error}"
    );
}

fn trusted_context() -> NarrativeScopeAuthorityTrustedContextV2 {
    let fixture = golden();
    NarrativeScopeAuthorityTrustedContextV2 {
        project_id: "project-a".to_owned(),
        source_key: "snapshot:run-a".to_owned(),
        expected_composite_digest: fixture.digests.composite_digest,
        documents: trusted_documents(),
    }
}

#[test]
fn accepts_the_shared_typed_golden_and_exact_document_coverage() {
    let fixture = golden();
    fixture.validate().expect("basis invariants");
    fixture
        .validate_trusted_context(&trusted_context())
        .expect("source coverage");
}

#[test]
fn typed_serde_rejects_unknown_and_missing_nested_wire_fields() {
    let fixture = golden();

    let mut unknown_root = serde_json::to_value(&fixture).expect("typed fixture serializes");
    unknown_root["unknown"] = json!(true);
    assert!(serde_json::from_value::<NarrativeScopeAuthorityBasisV2>(unknown_root).is_err());

    let mut unknown_story = serde_json::to_value(&fixture).expect("typed fixture serializes");
    unknown_story["mappings"][0]["storyTimeOrder"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<NarrativeScopeAuthorityBasisV2>(unknown_story).is_err());

    let mut missing_nullable = serde_json::to_value(&fixture).expect("typed fixture serializes");
    missing_nullable["mappings"][1]["storyTimeOrder"] = json!({
        "status": "unresolved",
        "reason": "not-provided"
    });
    assert!(serde_json::from_value::<NarrativeScopeAuthorityBasisV2>(missing_nullable).is_err());
}

#[test]
fn typed_invariants_reject_mapping_gaps_duplicate_keys_and_story_rank_forgery() {
    let fixture = golden();

    let mut mapping = fixture.clone();
    mapping.mappings[0].reading_order_ref = "reading:other".to_owned();
    let mapping = reseal(mapping);
    assert!(mapping.validate().is_err());

    let mut gap = fixture.clone();
    gap.mappings[3].reading_rank = 4;
    let gap = reseal(gap);
    assert!(gap.validate().is_err());

    let mut duplicate_resolved = fixture.clone();
    duplicate_resolved.mappings[2].story_time_order =
        duplicate_resolved.mappings[0].story_time_order.clone();
    let duplicate_resolved = reseal(duplicate_resolved);
    assert!(duplicate_resolved.validate().is_err());

    let mut unique_ambiguous = serde_json::to_value(&fixture).expect("typed fixture serializes");
    unique_ambiguous["mappings"][3]["storyTimeOrder"]["rawStoryKey"] = json!("unique");
    let unique_ambiguous: NarrativeScopeAuthorityBasisV2 =
        serde_json::from_value(unique_ambiguous).expect("candidate remains structurally typed");
    let unique_ambiguous = reseal(unique_ambiguous);
    assert!(unique_ambiguous.validate().is_err());

    let mut non_sequential_document_ref = fixture.clone();
    non_sequential_document_ref.mappings[1].document_ref =
        non_sequential_document_ref.mappings[0].document_ref.clone();
    let non_sequential_document_ref = reseal(non_sequential_document_ref);
    assert_invalid_contains(
        &non_sequential_document_ref,
        "documentRef must equal D000002",
    );

    let mut duplicate_source_key = fixture.clone();
    duplicate_source_key.mappings[1].source_key =
        duplicate_source_key.mappings[0].source_key.clone();
    duplicate_source_key.mappings[1].scene_ref = duplicate_source_key.mappings[0].scene_ref.clone();
    duplicate_source_key.mappings[1].reading_order_ref =
        duplicate_source_key.mappings[0].reading_order_ref.clone();
    duplicate_source_key.mappings[1].story_time_ref =
        duplicate_source_key.mappings[0].story_time_ref.clone();
    let duplicate_source_key = reseal(duplicate_source_key);
    assert_invalid_contains(&duplicate_source_key, "sourceKey must be unique");

    let mut forged_story_rank = serde_json::to_value(&fixture).expect("typed fixture serializes");
    forged_story_rank["mappings"][1]["storyTimeOrder"] = json!({
        "status": "resolved",
        "rawStoryKey": "\u{1f600}",
        "storyRank": 7
    });
    let forged_story_rank: NarrativeScopeAuthorityBasisV2 =
        serde_json::from_value(forged_story_rank).expect("candidate remains structurally typed");
    let forged_story_rank = reseal(forged_story_rank);
    assert!(forged_story_rank.validate().is_err());
}

#[test]
fn trusted_context_rejects_project_source_and_document_coverage_drift() {
    let fixture = golden();

    let mut project = trusted_context();
    project.project_id = "project-b".to_owned();
    assert!(fixture.validate_trusted_context(&project).is_err());

    let mut source = trusted_context();
    source.source_key = "snapshot:run-b".to_owned();
    assert!(fixture.validate_trusted_context(&source).is_err());

    let mut composite = trusted_context();
    composite.expected_composite_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
    assert!(fixture.validate_trusted_context(&composite).is_err());

    let mut document = trusted_context();
    document.documents[3].document_ref = "D000999".to_owned();
    assert!(fixture.validate_trusted_context(&document).is_err());
    document.documents[3].document_ref = "D000004".to_owned();
    document.documents[3].source_key = "project:scene:forged".to_owned();
    assert!(fixture.validate_trusted_context(&document).is_err());
}

#[test]
fn every_forged_derived_digest_is_rejected_by_typed_digest_validation() {
    const FORGED: &str = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    for field in [
        "scopeRegistryRevision",
        "readingOrderRevision",
        "storyTimeOrderRevision",
        "authorityDigest",
        "compositeDigest",
    ] {
        let mut fixture = golden();
        match field {
            "scopeRegistryRevision" => fixture.digests.scope_registry_revision = FORGED.to_owned(),
            "readingOrderRevision" => fixture.digests.reading_order_revision = FORGED.to_owned(),
            "storyTimeOrderRevision" => {
                fixture.digests.story_time_order_revision = FORGED.to_owned()
            }
            "authorityDigest" => fixture.digests.authority_digest = FORGED.to_owned(),
            "compositeDigest" => fixture.digests.composite_digest = FORGED.to_owned(),
            _ => unreachable!("closed digest field list"),
        }
        match field {
            "scopeRegistryRevision" | "readingOrderRevision" | "storyTimeOrderRevision" => {
                fixture.digests.authority_digest =
                    digest(&canonical_scope_authority_digest_input(&fixture));
                fixture.digests.composite_digest = digest(
                    &canonical_narrative_source_snapshot_revision_input(&fixture),
                );
            }
            "authorityDigest" => {
                fixture.digests.composite_digest = digest(
                    &canonical_narrative_source_snapshot_revision_input(&fixture),
                );
            }
            "compositeDigest" => {}
            _ => unreachable!("closed digest field list"),
        }
        assert_invalid_contains(&fixture, field);
    }
}

#[test]
fn canonical_domains_preserve_axis_separation_and_carrier_digest_contract() {
    let fixture = golden();
    let registry = canonical_scope_registry_revision_input(&fixture);
    let reading = canonical_reading_order_revision_input(&fixture);
    let story = canonical_story_time_order_revision_input(&fixture);
    assert_eq!(registry.contract_id, "narrative-scope-registry-revision/1");
    assert_eq!(reading.contract_id, "narrative-reading-order-revision/1");
    assert_eq!(story.contract_id, "narrative-story-time-order-revision/1");
    assert_eq!(
        canonical_scope_authority_digest_input(&fixture).contract_id,
        "narrative-scope-authority/2"
    );
    assert_eq!(
        canonical_narrative_source_snapshot_revision_input(&fixture).contract_id,
        "narrative-source-snapshot-revision/2"
    );
}
