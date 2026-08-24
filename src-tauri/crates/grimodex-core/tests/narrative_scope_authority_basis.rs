use grimodex_core::scope_authority_basis::{
    canonical_narrative_snapshot_v2_digest_input, canonical_reading_order_revision_input,
    canonical_story_time_order_revision_input, validate_scope_authority_basis,
    validate_scope_authority_basis_against_snapshot,
};
use serde_json::{json, Value};

const GOLDEN: &str = include_str!(
    "../../../../policies/narrative/fixtures/scope-authority-basis-v1.json"
);

fn fixture() -> Value {
    serde_json::from_str(GOLDEN).expect("scope authority basis golden parses")
}

fn snapshot() -> Value {
    json!({
        "documents": [
            {"ref": "D000001", "sourceKey": "project:scene:scene-one", "origin": {"kind": "project-node", "nodeId": "scene-one"}},
            {"ref": "D000002", "sourceKey": "project:scene:scene-two", "origin": {"kind": "project-node", "nodeId": "scene-two"}},
            {"ref": "D000003", "sourceKey": "project:scene:scene-three", "origin": {"kind": "project-node", "nodeId": "scene-three"}}
        ]
    })
}

#[test]
fn accepts_the_shared_golden_and_exact_coverage() {
    let basis = fixture();
    assert!(validate_scope_authority_basis(&basis).is_ok());
    assert!(validate_scope_authority_basis_against_snapshot(&basis, &snapshot()).is_ok());
}

#[test]
fn rejects_v1_unknown_fields_mapping_order_registry_and_story_fallbacks() {
    let mut v1 = json!({"contractId": "source.snapshot@1", "schemaVersion": 1});
    assert!(validate_scope_authority_basis(&v1).is_err());

    let mut unknown = fixture();
    unknown["unknown"] = json!(true);
    assert!(validate_scope_authority_basis(&unknown).is_err());

    let mut mapping = fixture();
    mapping["entries"][0]["sceneRef"] = json!("scene:other");
    assert!(validate_scope_authority_basis_against_snapshot(&mapping, &snapshot()).is_err());

    let mut gap = fixture();
    gap["entries"][2]["readingOrderIndex"] = json!(3);
    assert!(validate_scope_authority_basis(&gap).is_err());

    let mut registry = fixture();
    registry["scopeRegistryVersion"] = json!("narrative-scope/3");
    assert!(validate_scope_authority_basis(&registry).is_err());

    let mut fallback = fixture();
    fallback["entries"][1]["storyTime"] = json!({"kind": "resolved", "orderIndex": 1});
    assert!(validate_scope_authority_basis(&fallback).is_err());

    drop(v1);
}

#[test]
fn digest_domains_are_explicit_and_v2_snapshot_digest_has_two_inputs() {
    let basis = fixture();
    let reading = canonical_reading_order_revision_input(&basis).expect("reading domain");
    assert_eq!(reading["axis"], json!("reading-order"));
    let story = canonical_story_time_order_revision_input(&basis).expect("story domain");
    assert_eq!(story["axis"], json!("story-time"));
    assert_eq!(story["readingOrderRevision"], basis["readingOrderRevision"]);

    assert_eq!(
        canonical_narrative_snapshot_v2_digest_input(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        )
        .expect("snapshot digest domain"),
        json!({
            "contractId": "source.snapshot/2",
            "corpusDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "scopeAuthorityDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
        })
    );
}
