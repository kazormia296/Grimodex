use grimodex_core::narrative_scope_authority_basis::{
    canonical_narrative_source_snapshot_revision_input, canonical_reading_order_revision_input,
    canonical_scope_registry_revision_input, canonical_story_time_order_revision_input,
    NarrativeScopeAuthorityBasisV2, NarrativeScopeAuthoritySourceDocumentV2,
    NarrativeScopeAuthorityTrustedContextV2,
};
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
            source_key: "project:scene:scene-one".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "scene-one".to_owned(),
        },
        NarrativeScopeAuthoritySourceDocumentV2 {
            document_ref: "D000002".to_owned(),
            source_key: "project:scene:scene-two".to_owned(),
            project_id: "project-a".to_owned(),
            node_id: "scene-two".to_owned(),
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
    ]
}

fn trusted_context() -> NarrativeScopeAuthorityTrustedContextV2 {
    NarrativeScopeAuthorityTrustedContextV2 {
        project_id: "project-a".to_owned(),
        source_key: "snapshot:run-a".to_owned(),
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
fn typed_invariants_reject_mapping_gaps_duplicate_keys_and_story_rank_forgery() {
    let fixture = golden();

    let mut mapping = fixture.clone();
    mapping.mappings[0].reading_order_ref = "reading:other".to_owned();
    assert!(mapping.validate().is_err());

    let mut gap = fixture.clone();
    gap.mappings[3].reading_rank = 4;
    assert!(gap.validate().is_err());

    let mut duplicate_resolved = fixture.clone();
    duplicate_resolved.mappings[2].story_time_order =
        duplicate_resolved.mappings[0].story_time_order.clone();
    assert!(duplicate_resolved.validate().is_err());

    let mut unique_ambiguous = serde_json::to_value(&fixture).expect("typed fixture serializes");
    unique_ambiguous["mappings"][3]["storyTimeOrder"]["rawStoryKey"] = json!("unique");
    let unique_ambiguous: NarrativeScopeAuthorityBasisV2 =
        serde_json::from_value(unique_ambiguous).expect("candidate remains structurally typed");
    assert!(unique_ambiguous.validate().is_err());

    let mut duplicate_ref = fixture.clone();
    duplicate_ref.mappings[1].document_ref = duplicate_ref.mappings[0].document_ref.clone();
    assert!(duplicate_ref.validate().is_err());

    let mut duplicate_source_key = fixture.clone();
    duplicate_source_key.mappings[1].source_key =
        duplicate_source_key.mappings[0].source_key.clone();
    assert!(duplicate_source_key.validate().is_err());

    let mut forged_story_rank = serde_json::to_value(&fixture).expect("typed fixture serializes");
    forged_story_rank["mappings"][1]["storyTimeOrder"] = json!({
        "status": "resolved",
        "rawStoryKey": "c0",
        "storyRank": 0
    });
    let forged_story_rank: NarrativeScopeAuthorityBasisV2 =
        serde_json::from_value(forged_story_rank).expect("candidate remains structurally typed");
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

    let mut document = trusted_context();
    document.documents[3].document_ref = "D000999".to_owned();
    assert!(fixture.validate_trusted_context(&document).is_err());
    document.documents[3].document_ref = "D000004".to_owned();
    document.documents[3].source_key = "project:scene:forged".to_owned();
    assert!(fixture.validate_trusted_context(&document).is_err());
}

#[test]
fn forged_digest_is_rejected_by_typed_digest_validation() {
    let mut fixture = golden();
    fixture.digests.authority_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
    assert!(fixture.validate().is_err());
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
        canonical_narrative_source_snapshot_revision_input(&fixture).contract_id,
        "narrative-source-snapshot-revision/2"
    );
}
