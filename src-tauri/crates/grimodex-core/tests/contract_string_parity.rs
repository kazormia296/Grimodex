use grimodex_core::contract_string::{
    is_contract_non_empty, is_contract_trimmed_non_empty, is_contract_whitespace_code_point,
    CONTRACT_WHITESPACE_CODE_POINTS,
};
use grimodex_core::narrative_dependency::{
    load_dependency_role_registry, validate_dependency_effect_registry,
    validate_dependency_selector_value,
};
use grimodex_core::narrative_ir::{
    validate_narrative_revision_envelope_v2, validate_narrative_scope_v2,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhitespaceValue {
    id: String,
    code_point: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct UnicodeContent {
    id: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParityOperation {
    id: String,
    kind: String,
    edge_whitespace_expected: bool,
    unicode_content_expected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    whitespace_values: Vec<WhitespaceValue>,
    unicode_contents: Vec<UnicodeContent>,
    ascii_normalizer_version: String,
    operations: Vec<ParityOperation>,
}

const FIXTURE: &str =
    include_str!("../../../../policies/narrative/fixtures/contract-string-parity.json");
const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("contract string parity fixture parses")
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
    json!({
        "schemaVersion": 2,
        "assertion": {
            "assertionId": null,
            "assertionKind": "scene-event@1",
            "payloadSchemaRef": {"id": "narrative.scene-event", "version": "1"},
            "payload": {"eventId": "event:1"},
            "scope": valid_scope(),
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
            "dependencySet": [{
                "dependencyId": "dependency:1",
                "inputRef": "anchor:1",
                "contextIds": [],
                "role": "direct-evidence",
                "selector": {"kind": "whole-source"}
            }],
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

fn is_valid_operation(kind: &str, value: &str) -> bool {
    match kind {
        "scope-exact-ref" => {
            let mut scope = valid_scope();
            scope["scene"]["ref"] = Value::String(value.to_owned());
            validate_narrative_scope_v2(&scope).is_ok()
        }
        "scope-unresolved-constraint-id" => {
            let mut scope = valid_scope();
            scope["audience"] = json!({
                "kind": "unresolved",
                "reason": "ambiguous",
                "constraintId": value
            });
            validate_narrative_scope_v2(&scope).is_ok()
        }
        "scope-interval-boundary" => {
            let mut scope = valid_scope();
            scope["storyTime"] = json!({
                "kind": "interval",
                "from": {"ref": value, "inclusive": true}
            });
            validate_narrative_scope_v2(&scope).is_ok()
        }
        "narrative-ir-assertion-id" => {
            let mut envelope = valid_envelope();
            envelope["assertion"]["assertionId"] = Value::String(value.to_owned());
            validate_narrative_revision_envelope_v2(&envelope).is_ok()
        }
        "narrative-ir-context-id" => {
            let mut envelope = valid_envelope();
            envelope["revisionBasis"]["contextSet"] = json!([{
                "contextId": value,
                "inputRef": "source:context",
                "stageId": "stage:1",
                "exposure": "deterministic-stage",
                "selector": {"kind": "whole-source"}
            }]);
            validate_narrative_revision_envelope_v2(&envelope).is_ok()
        }
        "narrative-ir-component-contract-id" => {
            let mut envelope = valid_envelope();
            envelope["projectionBinding"]["adapterContractId"] = Value::String(value.to_owned());
            validate_narrative_revision_envelope_v2(&envelope).is_ok()
        }
        "d0-field-path-object-identity" => validate_dependency_selector_value(
            &json!({
                "kind": "field-path",
                "objectIdentity": value,
                "fieldPath": "title"
            }),
            None,
        )
        .is_ok(),
        "d0-field-path" => validate_dependency_selector_value(
            &json!({
                "kind": "field-path",
                "objectIdentity": "object:1",
                "fieldPath": value
            }),
            None,
        )
        .is_ok(),
        "d0-exact-object-set" => validate_dependency_selector_value(
            &json!({
                "kind": "exact-object-set",
                "objectIdentities": [value],
                "setDigest": DIGEST
            }),
            None,
        )
        .is_ok(),
        "d0-component-contract-id" => validate_dependency_selector_value(
            &json!({
                "kind": "component-contract",
                "contractId": value,
                "contractDigest": DIGEST
            }),
            None,
        )
        .is_ok(),
        "d0-normalizer-version" => validate_dependency_selector_value(
            &json!({
                "kind": "text-range",
                "unit": "utf16",
                "from": 0,
                "to": 1,
                "normalizerVersion": value
            }),
            None,
        )
        .is_ok(),
        "dependency-effect-rule-id" => {
            let mut registry = load_dependency_role_registry().expect("dependency role registry");
            registry.effect_rules[0].id = value.to_owned();
            validate_dependency_effect_registry(&registry).is_ok()
        }
        other => panic!("unknown parity operation: {other}"),
    }
}

#[test]
fn explicit_whitespace_set_matches_fixture() {
    let fixture = fixture();
    let expected = fixture
        .whitespace_values
        .iter()
        .map(|entry| {
            u32::from_str_radix(entry.code_point.strip_prefix("U+").unwrap(), 16)
                .expect("code point")
        })
        .collect::<Vec<_>>();
    assert_eq!(CONTRACT_WHITESPACE_CODE_POINTS, expected.as_slice());

    for entry in &fixture.whitespace_values {
        let code_point = u32::from_str_radix(entry.code_point.strip_prefix("U+").unwrap(), 16)
            .expect("code point");
        assert!(
            is_contract_whitespace_code_point(code_point),
            "{}",
            entry.id
        );
        assert!(!is_contract_non_empty(&entry.value), "{}", entry.id);
        assert!(!is_contract_trimmed_non_empty(&entry.value), "{}", entry.id);
    }
}

#[test]
fn validators_share_scope_ir_d0_and_normalizer_acceptance() {
    let fixture = fixture();
    for operation in &fixture.operations {
        for whitespace in &fixture.whitespace_values {
            assert!(
                !is_valid_operation(&operation.kind, &whitespace.value),
                "{}/{}/only",
                operation.id,
                whitespace.id
            );
            assert_eq!(
                is_valid_operation(&operation.kind, &format!("{}x", whitespace.value)),
                operation.edge_whitespace_expected,
                "{}/{}/leading",
                operation.id,
                whitespace.id
            );
            assert_eq!(
                is_valid_operation(&operation.kind, &format!("x{}", whitespace.value)),
                operation.edge_whitespace_expected,
                "{}/{}/trailing",
                operation.id,
                whitespace.id
            );
        }

        for content in &fixture.unicode_contents {
            assert_eq!(
                is_valid_operation(&operation.kind, &content.value),
                operation.unicode_content_expected,
                "{}/{}",
                operation.id,
                content.id
            );
        }
    }

    let normalizer = fixture
        .operations
        .iter()
        .find(|operation| operation.kind == "d0-normalizer-version")
        .expect("normalizer operation");
    assert!(is_valid_operation(
        &normalizer.kind,
        &fixture.ascii_normalizer_version
    ));
}
