use grimodex_core::narrative_ir::{
    canonical_narrative_scope_v2, classify_chronicle_scene_event_changes,
    derive_chronicle_scene_event_scope, validate_chronicle_scene_event_v2,
    validate_narrative_revision_envelope_v2, validate_narrative_scope_v2,
    ChronicleChangeDisposition, ChronicleScopeDerivation,
};
use serde_json::{json, Value};

const GOLDEN: &str = include_str!(
    "../../../../policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json"
);
const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn fixture() -> Value {
    serde_json::from_str(GOLDEN).expect("narrative IR golden fixture parses")
}

fn object<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or_else(|| panic!("missing {key}"))
}

fn case_by_id<'a>(corpus: &'a Value, id: &str) -> &'a Value {
    object(corpus, "cases")
        .as_array()
        .expect("fixture cases array")
        .iter()
        .find(|case| object(case, "id").as_str() == Some(id))
        .unwrap_or_else(|| panic!("missing case {id}"))
}

fn valid_scope() -> Value {
    json!({
        "schemaVersion": 2,
        "registryVersion": "narrative-scope/2",
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "scene": {"kind": "exact", "ref": "scene:1"},
        "viewpoint": {"kind": "any"},
        "knowledgeHolder": {"kind": "any"},
        "audience": {"kind": "any"},
        "narrativeLayer": {"kind": "any"},
        "storyTime": {"kind": "any"},
        "readingOrder": {"kind": "any"}
    })
}

fn valid_envelope() -> Value {
    let scope = valid_scope();
    json!({
        "schemaVersion": 2,
        "assertion": {
            "assertionId": null,
            "assertionKind": "scene-event@1",
            "payloadSchemaRef": {"id": "narrative.chronicle.scene-event", "version": "1"},
            "payload": {"eventId": "event:1"},
            "scope": scope,
            "modality": "modality-explicit-text",
            "polarity": "affirmative",
            "supportClass": "direct-source",
            "producer": {"kind": "reconciler-proposal", "id": "chronicle", "version": "1"}
        },
        "assertionDigests": {
            "assertionCoreDigest": DIGEST,
            "scopeDigest": DIGEST,
            "assertionDigest": DIGEST
        },
        "changeIntent": {"changeKind": "add"},
        "effectiveMaterialBasis": {
            "sourceBasis": [{"sourceKind": "scene", "sourceKey": "scene:1", "revisionToken": "rev:1"}],
            "evidenceSet": [{"evidenceRef": "anchor:1"}],
            "dependencySet": [],
            "dependencySetDigest": DIGEST,
            "materialBasisDigest": DIGEST
        },
        "revisionBasis": {
            "kind": "interpretation",
            "runId": "run:1",
            "taskId": "task:1",
            "producer": {"kind": "reconciler-proposal", "id": "chronicle", "version": "1"},
            "contextSet": [],
            "contextSetDigest": DIGEST,
            "componentContractDigest": DIGEST,
            "finalRequestDigest": DIGEST
        },
        "projectionBinding": {
            "proposalKind": "chronicle.create-event@1",
            "proposalSchemaRef": {"id": "narrative.chronicle-event.create", "version": "1"},
            "proposalPayloadDigest": DIGEST,
            "adapterContractId": "chronicle.scene-event",
            "adapterContractVersion": "1"
        }
    })
}

#[test]
fn validates_scope_and_reuses_k0_for_canonical_bytes_and_digest() {
    let scope = valid_scope();
    assert!(validate_narrative_scope_v2(&scope).is_ok());
    assert_eq!(
        canonical_narrative_scope_v2(&scope).expect("scope canonicalizes"),
        "{\"audience\":{\"kind\":\"any\"},\"knowledgeHolder\":{\"kind\":\"any\"},\"narrativeLayer\":{\"kind\":\"any\"},\"readingOrder\":{\"kind\":\"any\"},\"registryVersion\":\"narrative-scope/2\",\"scene\":{\"kind\":\"exact\",\"ref\":\"scene:1\"},\"schemaVersion\":2,\"storyTime\":{\"kind\":\"any\"},\"timeline\":{\"kind\":\"any\"},\"viewpoint\":{\"kind\":\"any\"},\"worldline\":{\"kind\":\"any\"}}"
    );
}

#[test]
fn rejects_unknown_scope_versions_axes_vocabularies_and_malformed_constraints() {
    let mut candidate = valid_scope();
    candidate["schemaVersion"] = json!(3);
    assert!(validate_narrative_scope_v2(&candidate).is_err());

    let mut candidate = valid_scope();
    candidate["registryVersion"] = json!("narrative-scope/3");
    assert!(validate_narrative_scope_v2(&candidate).is_err());

    let mut candidate = valid_scope();
    candidate["scene"] = json!({"kind": "future"});
    assert!(validate_narrative_scope_v2(&candidate).is_err());

    let mut candidate = valid_scope();
    candidate["storyTime"] = json!({"kind": "interval"});
    assert!(validate_narrative_scope_v2(&candidate).is_err());

    let mut candidate = valid_scope();
    candidate["audience"] = json!({"kind": "unresolved", "reason": "future"});
    assert!(validate_narrative_scope_v2(&candidate).is_err());

    let mut candidate = valid_scope();
    candidate["futureAxis"] = json!({"kind": "any"});
    assert!(validate_narrative_scope_v2(&candidate).is_err());
}

#[test]
fn validates_envelope_and_rejects_unknown_vocabularies_and_add_targets() {
    let envelope = valid_envelope();
    assert!(validate_narrative_revision_envelope_v2(&envelope).is_ok());
    assert!(validate_chronicle_scene_event_v2(&envelope).is_ok());

    let mut candidate = valid_envelope();
    candidate["schemaVersion"] = json!(1);
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["assertion"]["producer"]["kind"] = json!("future-producer");
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["assertion"]["supportClass"] = json!("future-support");
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["changeIntent"] = json!({"changeKind": "add", "targetProjectionRef": "event:1"});
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["projectionBinding"]["adapterContractVersion"] = json!("2");
    assert!(validate_chronicle_scene_event_v2(&candidate).is_err());

    for payload in [json!("scalar"), json!(["array"]), Value::Null] {
        let mut candidate = valid_envelope();
        candidate["assertion"]["payload"] = payload;
        assert!(validate_chronicle_scene_event_v2(&candidate).is_err());
    }
}

#[test]
fn executes_all_shared_scope_and_human_classification_goldens() {
    let corpus = fixture();
    let cases = object(&corpus, "cases")
        .as_array()
        .expect("fixture cases array");
    assert_eq!(cases.len(), 10);

    for case in cases {
        let id = object(case, "id").as_str().expect("case id");
        let input = object(case, "input");
        let expected = object(case, "expected");
        let kind = object(case, "kind").as_str().expect("case kind");
        if kind == "human-derivation" {
            let classification = classify_chronicle_scene_event_changes(
                object(input, "parentPayload"),
                object(input, "editedPayload"),
            )
            .unwrap_or_else(|error| panic!("{id} classification: {error}"));
            assert_eq!(
                Some(classification.disposition.as_str()),
                object(expected, "disposition").as_str(),
                "{id}"
            );
            let expected_paths = object(expected, "changedPaths")
                .as_array()
                .expect("changed paths")
                .iter()
                .map(|path| path.as_str().expect("changed path").to_owned())
                .collect::<Vec<_>>();
            assert_eq!(classification.changed_paths, expected_paths, "{id}");
            if object(expected, "disposition").as_str() == Some("reject") {
                assert_eq!(
                    classification.reason.as_deref(),
                    object(expected, "reason").as_str(),
                    "{id}"
                );
                continue;
            }
            assert_eq!(
                classification.derivation_kind.as_deref(),
                object(expected, "derivationKind").as_str(),
                "{id}"
            );
            let expected_classes = object(expected, "changedPathClasses")
                .as_array()
                .expect("changed path classes")
                .iter()
                .map(|class| class.as_str().expect("changed path class").to_owned())
                .collect::<Vec<_>>();
            assert_eq!(
                classification.changed_path_classes, expected_classes,
                "{id}"
            );
        }

        if kind == "cross-runtime-parity"
            || kind == "scope-derivation"
            || kind == "human-derivation"
        {
            let proposal = object(
                input,
                if kind == "human-derivation" {
                    "editedPayload"
                } else {
                    "proposalPayload"
                },
            );
            let derived = derive_chronicle_scene_event_scope(
                object(input, "sceneRef").as_str().expect("scene ref"),
                proposal,
                object(input, "revealBasis"),
            )
            .unwrap_or_else(|error| panic!("{id} scope: {error}"));
            assert_eq!(
                derived.canonical_json,
                object(expected, "canonicalScopeJson")
                    .as_str()
                    .expect("canonical scope JSON"),
                "{id}"
            );
            assert_eq!(
                derived.digest,
                object(expected, "scopeDigest")
                    .as_str()
                    .expect("scope digest"),
                "{id}"
            );
        }
    }
}

#[test]
fn refuses_unsupported_human_path_without_deriving_a_scope() {
    let corpus = fixture();
    let case = case_by_id(&corpus, "unsupported-path-refused");
    let input = object(case, "input");
    let result = classify_chronicle_scene_event_changes(
        object(input, "parentPayload"),
        object(input, "editedPayload"),
    )
    .expect("classification result");
    assert_eq!(result.disposition, ChronicleChangeDisposition::Reject);
    assert_eq!(result.reason.as_deref(), Some("unsupported-path"));
    assert_eq!(result.changed_paths, vec!["/actuality".to_owned()]);
}

#[test]
fn refuses_empty_chronicle_proposal_note() {
    let corpus = fixture();
    let case = case_by_id(&corpus, "non-secret-event");
    let input = object(case, "input");
    let mut proposal = object(input, "proposalPayload").clone();
    proposal["note"] = json!("");
    assert!(derive_chronicle_scene_event_scope(
        object(input, "sceneRef").as_str().expect("scene ref"),
        &proposal,
        object(input, "revealBasis"),
    )
    .is_err());
}

#[test]
fn scope_derivation_exposes_typed_result_without_runtime_side_effects() {
    let corpus = fixture();
    let case = case_by_id(&corpus, "non-secret-event");
    let input = object(case, "input");
    let result = derive_chronicle_scene_event_scope(
        object(input, "sceneRef").as_str().expect("scene ref"),
        object(input, "proposalPayload"),
        object(input, "revealBasis"),
    )
    .expect("scope derivation");
    let _: ChronicleScopeDerivation = result;
}
