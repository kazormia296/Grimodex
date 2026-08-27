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
            "payload": {
                "eventId": "event:1",
                "summary": "A arrives.",
                "actuality": "actual",
                "significance": "major",
                "attribution": "narrator",
                "narrativeFrame": "story-world",
                "observationRefs": ["observation:1"],
                "originalObservationRefs": ["observation:1"],
                "mergedObservationRefs": ["observation:1"],
                "observationSummaries": [{
                    "observationRef": "observation:1",
                    "predicate": "arrival",
                    "semanticType": "arrival",
                    "participants": [{"surface": "A", "role": "subject"}],
                    "locationSurface": "station",
                    "temporalExpressions": ["morning"],
                    "durationKind": "instant"
                }]
            },
            "scope": scope,
            "modality": "modality-explicit-text",
            "polarity": "affirmative",
            "supportClass": "direct-source",
            "producer": {"kind": "reconciler-proposal", "id": "chronicle.reconciler", "version": "1"}
        },
        "assertionDigests": {
            "assertionCoreDigest": DIGEST,
            "scopeDigest": DIGEST,
            "assertionDigest": DIGEST
        },
        "changeIntent": {"changeKind": "add"},
        "effectiveMaterialBasis": {
            "sourceBasis": [{"sourceKind": "scene", "sourceKey": "scene:1", "revisionToken": "rev:1"}],
            "evidenceSet": [{"evidenceRef": "anchor:1", "documentRef": "document:1"}],
            "dependencySet": [{
                "dependencyId": "dependency:1",
                "inputRef": "anchor:1",
                "contextIds": ["context:1"],
                "role": "direct-evidence",
                "selector": {"kind": "whole-source"}
            }, {
                "dependencyId": "dependency:component",
                "inputRef": "component:chronicle.event-synthesis.prompt",
                "contextIds": [],
                "role": "component-contract",
                "selector": {
                    "kind": "component-contract",
                    "contractId": "chronicle.event-synthesis.prompt",
                    "contractDigest": DIGEST
                }
            }],
            "dependencySetDigest": DIGEST,
            "materialBasisDigest": DIGEST
        },
        "revisionBasis": {
            "kind": "interpretation",
            "runId": "run:1",
            "taskId": "task:1",
            "producer": {"kind": "reconciler-proposal", "id": "chronicle.reconciler", "version": "1"},
            "contextSet": [{
                "contextId": "context:1",
                "inputRef": "anchor:1",
                "stageId": "narrative_event_synthesize",
                "exposure": "model-visible",
                "selector": {"kind": "whole-source"}
            }],
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

fn human_derived_envelope() -> Value {
    let mut envelope = valid_envelope();
    let basis = envelope
        .get_mut("revisionBasis")
        .and_then(Value::as_object_mut)
        .expect("interpretation revision basis");
    for field in [
        "producer",
        "runId",
        "taskId",
        "contextSet",
        "contextSetDigest",
        "componentContractDigest",
        "finalRequestDigest",
    ] {
        basis.remove(field);
    }
    basis.insert("kind".to_owned(), json!("human-derived"));
    basis.insert("parentRevisionId".to_owned(), json!("revision:1"));
    basis.insert("expectedParentEnvelopeDigest".to_owned(), json!(DIGEST));
    basis.insert("parentAssertionDigest".to_owned(), json!(DIGEST));
    basis.insert(
        "rootInterpretationRevisionId".to_owned(),
        json!("revision:1"),
    );
    basis.insert(
        "derivation".to_owned(),
        json!({
            "adapterId": "chronicle.scene-event",
            "adapterVersion": "1",
            "kind": "projection-only",
            "proposalPayloadChangedPaths": ["/title"]
        }),
    );
    basis.insert(
        "revisionActor".to_owned(),
        json!({"kind": "human", "surfaceId": "chronicle-review"}),
    );
    basis.insert(
        "derivationContextSet".to_owned(),
        json!([{
            "contextId": "context:1",
            "inputRef": "anchor:1",
            "stageId": "narrative_event_synthesize",
            "exposure": "author-supplied",
            "selector": {"kind": "whole-source"}
        }]),
    );
    basis.insert("derivationContextSetDigest".to_owned(), json!(DIGEST));
    envelope
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
fn accepts_integer_valued_raw_json_schema_versions() {
    for spelling in ["2.0", "2e0"] {
        let mut scope = valid_scope();
        scope["schemaVersion"] = serde_json::from_str(spelling).expect("schema number");
        assert!(
            validate_narrative_scope_v2(&scope).is_ok(),
            "scope {spelling}"
        );
        assert_eq!(
            canonical_narrative_scope_v2(&scope).expect("scope canonicalizes"),
            canonical_narrative_scope_v2(&valid_scope()).expect("canonical scope")
        );

        let mut envelope = valid_envelope();
        envelope["schemaVersion"] = serde_json::from_str(spelling).expect("envelope number");
        envelope["assertion"]["scope"]["schemaVersion"] =
            serde_json::from_str(spelling).expect("nested schema number");
        assert!(
            validate_narrative_revision_envelope_v2(&envelope).is_ok(),
            "envelope {spelling}"
        );
    }

    for spelling in ["2.5", "-1.0", "18446744073709551616.0"] {
        let mut scope = valid_scope();
        scope["schemaVersion"] = serde_json::from_str(spelling).expect("schema number");
        assert!(
            validate_narrative_scope_v2(&scope).is_err(),
            "scope {spelling} must be rejected"
        );
    }
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

    let mut candidate = valid_envelope();
    candidate["assertion"]["payload"] = json!({});
    assert!(
        validate_chronicle_scene_event_v2(&candidate).is_err(),
        "an empty semantic payload must not become valid merely by recomputing digests"
    );

    let mut candidate = valid_envelope();
    candidate["assertion"]["producer"]["id"] = json!("reconciler-run-42");
    candidate["revisionBasis"]["producer"]["id"] = json!("reconciler-run-42");
    candidate["assertion"]["producer"]["version"] = json!("2026-08");
    candidate["revisionBasis"]["producer"]["version"] = json!("2026-08");
    assert!(
        validate_chronicle_scene_event_v2(&candidate).is_ok(),
        "producer identity/version are execution-bound, not hard-coded"
    );

    let mut candidate = valid_envelope();
    candidate["assertion"]["payload"]["attribution"] = json!("character:alice");
    candidate["assertion"]["payload"]["observationSummaries"][0]
        .as_object_mut()
        .expect("summary")
        .remove("semanticType");
    candidate["assertion"]["payload"]["observationSummaries"][0]
        .as_object_mut()
        .expect("summary")
        .remove("locationSurface");
    candidate["assertion"]["payload"]["observationSummaries"][0]["participants"] = json!([]);
    candidate["assertion"]["payload"]["observationSummaries"][0]["temporalExpressions"] = json!([]);
    assert!(validate_chronicle_scene_event_v2(&candidate).is_ok());

    let mut candidate = valid_envelope();
    candidate["assertion"]["payload"]["observationSummaries"][0]["durationKind"] =
        json!("unbounded");
    assert!(validate_chronicle_scene_event_v2(&candidate).is_err());
}

#[test]
fn applies_basis_specific_chronicle_producer_contracts() {
    let human = human_derived_envelope();
    assert!(
        validate_chronicle_scene_event_v2(&human).is_ok(),
        "Human-derived revisionBasis intentionally omits producer"
    );

    let mut human_with_producer = human_derived_envelope();
    human_with_producer["revisionBasis"]["producer"] = json!({
        "kind": "reconciler-proposal",
        "id": "reconciler-run-42",
        "version": "2026-08"
    });
    assert!(
        validate_chronicle_scene_event_v2(&human_with_producer).is_err(),
        "Human-derived revisionBasis must reject a producer claim"
    );

    let mut interpretation_mismatch = valid_envelope();
    interpretation_mismatch["revisionBasis"]["producer"]["id"] = json!("other-reconciler");
    assert!(
        validate_chronicle_scene_event_v2(&interpretation_mismatch).is_err(),
        "model-derived assertion and revision producers must remain equal"
    );

    let mut interpretation_without_producer = valid_envelope();
    interpretation_without_producer["revisionBasis"]
        .as_object_mut()
        .expect("interpretation revision basis")
        .remove("producer");
    assert!(
        validate_chronicle_scene_event_v2(&interpretation_without_producer).is_err(),
        "model-derived revisionBasis must retain its producer requirement"
    );
}

#[test]
fn enforces_dependency_role_selector_and_adr010_coverage() {
    let mut candidate = valid_envelope();
    candidate["effectiveMaterialBasis"]["dependencySet"][0]["role"] = json!("future-role");
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["effectiveMaterialBasis"]["dependencySet"][0]["selector"] =
        json!({"kind": "future-selector"});
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["effectiveMaterialBasis"]["dependencySet"] = json!([]);
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let mut candidate = valid_envelope();
    candidate["effectiveMaterialBasis"]["dependencySet"][0]["inputRef"] = json!("anchor:other");
    assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());

    let model_visible_context = json!({
        "contextId": "context:1",
        "inputRef": "source:context",
        "stageId": "stage:1",
        "exposure": "model-visible",
        "selector": {"kind": "whole-source"}
    });
    let mut without_coverage = valid_envelope();
    without_coverage["revisionBasis"]["contextSet"] = json!([model_visible_context]);
    assert!(validate_narrative_revision_envelope_v2(&without_coverage).is_err());

    let mut declared_purpose = without_coverage.clone();
    declared_purpose["effectiveMaterialBasis"]["dependencySet"] = json!([{
        "dependencyId": "dependency:1",
        "inputRef": "anchor:1",
        "contextIds": [],
        "role": "direct-evidence",
        "selector": {"kind": "whole-source"}
    }, {
        "dependencyId": "dependency:context",
        "inputRef": "source:context",
        "contextIds": ["context:1"],
        "role": "entity-resolution",
        "selector": {"kind": "whole-source"}
    }]);
    assert!(validate_narrative_revision_envelope_v2(&declared_purpose).is_ok());

    let mut selector_mismatch = without_coverage.clone();
    selector_mismatch["effectiveMaterialBasis"]["dependencySet"] = json!([{
        "dependencyId": "dependency:1",
        "inputRef": "anchor:1",
        "contextIds": [],
        "role": "direct-evidence",
        "selector": {"kind": "whole-source"}
    }, {
        "dependencyId": "dependency:context",
        "inputRef": "source:context",
        "contextIds": ["context:1"],
        "role": "opaque-model-context",
        "selector": {
            "kind": "field-path",
            "objectIdentity": "object:1",
            "fieldPath": "title"
        }
    }]);
    assert!(validate_narrative_revision_envelope_v2(&selector_mismatch).is_err());

    let mut direct_evidence_context = without_coverage.clone();
    direct_evidence_context["effectiveMaterialBasis"]["evidenceSet"] = json!([
        {"evidenceRef": "anchor:1"},
        {"evidenceRef": "anchor:context", "sourceKey": "source:context"}
    ]);
    direct_evidence_context["effectiveMaterialBasis"]["dependencySet"] = json!([{
        "dependencyId": "dependency:1",
        "inputRef": "anchor:1",
        "contextIds": [],
        "role": "direct-evidence",
        "selector": {"kind": "whole-source"}
    }, {
        "dependencyId": "dependency:context",
        "inputRef": "source:context",
        "contextIds": ["context:1"],
        "role": "direct-evidence",
        "selector": {"kind": "whole-source"}
    }]);
    assert!(validate_narrative_revision_envelope_v2(&direct_evidence_context).is_ok());

    let mut conservative_fallback = without_coverage;
    conservative_fallback["effectiveMaterialBasis"]["dependencySet"] = json!([{
        "dependencyId": "dependency:1",
        "inputRef": "anchor:1",
        "contextIds": [],
        "role": "direct-evidence",
        "selector": {"kind": "whole-source"}
    }, {
        "dependencyId": "dependency:context",
        "inputRef": "source:context",
        "contextIds": ["context:1"],
        "role": "opaque-model-context",
        "selector": {"kind": "whole-source"}
    }]);
    assert!(validate_narrative_revision_envelope_v2(&conservative_fallback).is_ok());

    let mut ranking_only = valid_envelope();
    ranking_only["effectiveMaterialBasis"]["dependencySet"] = json!([
        {
            "dependencyId": "dependency:1",
            "inputRef": "anchor:1",
            "contextIds": [],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        },
        {
            "dependencyId": "dependency:ranking",
            "inputRef": "ranking:context",
            "contextIds": [],
            "role": "ranking-only",
            "selector": {"kind": "whole-source"}
        }
    ]);
    assert!(validate_narrative_revision_envelope_v2(&ranking_only).is_err());

    let mut quality_context = valid_envelope();
    quality_context["revisionBasis"]["contextSet"][0]["inputRef"] = json!("quality:context");
    quality_context["effectiveMaterialBasis"]["dependencySet"] = json!([
        {
            "dependencyId": "dependency:1",
            "inputRef": "anchor:1",
            "contextIds": [],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        },
        {
            "dependencyId": "dependency:quality",
            "inputRef": "quality:context",
            "contextIds": ["context:1"],
            "role": "quality-context",
            "selector": {"kind": "whole-source"}
        }
    ]);
    assert!(validate_narrative_revision_envelope_v2(&quality_context).is_ok());
}

#[test]
fn rejects_malformed_optional_evidence_metadata_and_orphan_context_ids() {
    for (field, value) in [
        ("documentRef", json!(42)),
        ("quote", json!({"raw": "x"})),
        ("sourceKey", json!(false)),
        ("revisionToken", json!([])),
        ("documentRef", json!("")),
        ("quote", json!("")),
        ("sourceKey", json!("")),
        ("revisionToken", json!("")),
    ] {
        let mut candidate = valid_envelope();
        candidate["effectiveMaterialBasis"]["evidenceSet"][0][field] = value;
        assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());
    }

    let mut valid_metadata = valid_envelope();
    valid_metadata["effectiveMaterialBasis"]["evidenceSet"][0] = json!({
        "evidenceRef": "anchor:1",
        "documentRef": "document:1",
        "quote": "quoted text",
        "sourceKey": "anchor:1",
        "revisionToken": "rev:1"
    });
    assert!(validate_narrative_revision_envelope_v2(&valid_metadata).is_ok());

    let mut orphan_context = valid_envelope();
    orphan_context["effectiveMaterialBasis"]["dependencySet"][0]["contextIds"] =
        json!(["missing-context"]);
    assert!(validate_narrative_revision_envelope_v2(&orphan_context).is_err());

    let empty_context_ids = valid_envelope();
    assert!(validate_narrative_revision_envelope_v2(&empty_context_ids).is_ok());
}

#[test]
fn rejects_present_empty_or_non_string_revision_observed_at_values() {
    for observed_at in [json!(""), json!(42)] {
        let mut candidate = valid_envelope();
        candidate["effectiveMaterialBasis"]["sourceBasis"][0]["revisionObservedAt"] = observed_at;
        assert!(validate_narrative_revision_envelope_v2(&candidate).is_err());
    }
}

#[test]
fn executes_all_shared_scope_and_human_classification_goldens() {
    let corpus = fixture();
    let cases = object(&corpus, "cases")
        .as_array()
        .expect("fixture cases array");
    assert_eq!(cases.len(), 11);

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
fn accepts_empty_chronicle_proposal_note_as_a_string() {
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
    .is_ok());
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

#[test]
fn enforces_human_context_lineage_rules() {
    // An inherited parent Context keeps its true model-visible exposure under
    // the explicit lineage marker, and stays subject to Dependency coverage.
    let mut inherited = human_derived_envelope();
    inherited["effectiveMaterialBasis"]["dependencySet"][0]["contextIds"] = json!(["context:1"]);
    inherited["revisionBasis"]["derivationContextSet"] = json!([{
        "contextId": "context:1",
        "inputRef": "anchor:1",
        "stageId": "narrative_event_synthesize",
        "exposure": "model-visible",
        "selector": {"kind": "whole-source"},
        "inheritedFromRevisionId": "revision:1"
    }]);
    assert!(
        validate_chronicle_scene_event_v2(&inherited).is_ok(),
        "inherited model-visible context with lineage marker must be valid"
    );

    // The same exposure WITHOUT the lineage marker is this derivation's own
    // context and stays forbidden.
    let mut own_model_visible = inherited.clone();
    own_model_visible["revisionBasis"]["derivationContextSet"][0]
        .as_object_mut()
        .expect("entry")
        .remove("inheritedFromRevisionId");
    assert!(
        validate_chronicle_scene_event_v2(&own_model_visible).is_err(),
        "own model-visible context must remain forbidden"
    );

    // Lineage must name the immediate parent revision.
    let mut wrong_parent = inherited.clone();
    wrong_parent["revisionBasis"]["derivationContextSet"][0]["inheritedFromRevisionId"] =
        json!("revision:other");
    assert!(
        validate_chronicle_scene_event_v2(&wrong_parent).is_err(),
        "lineage marker naming a non-parent revision must be rejected"
    );

    // Interpretation Context Sets record the run's own execution inputs and
    // never carry the lineage marker.
    let mut interpretation = valid_envelope();
    interpretation["revisionBasis"]["contextSet"][0]["inheritedFromRevisionId"] =
        json!("revision:1");
    assert!(
        validate_chronicle_scene_event_v2(&interpretation).is_err(),
        "interpretation context entries must not carry a lineage marker"
    );
}
